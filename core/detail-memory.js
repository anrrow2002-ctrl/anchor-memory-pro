import { estimateTextTokens } from './runtime-controls.js';

function normalizedText(value) {
  return String(value || '')
    .toLocaleLowerCase()
    .replace(/[`*_~<>\[\]{}()（）【】「」『』“”‘’'"，。！？、；：:;,.!?/\\|\s—–-]+/g, '');
}

function fnv1a(value) {
  const text = String(value || '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function maxEndForTokens(text, start, maxTokens) {
  let low = Math.min(text.length, start + 1);
  let high = text.length;
  let best = low;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const cost = estimateTextTokens(text.slice(start, mid));
    if (cost <= maxTokens) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return Math.max(start + 1, best);
}

function startForTailTokens(text, end, tokenBudget) {
  let low = 0;
  let high = Math.max(0, end - 1);
  let best = high;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const cost = estimateTextTokens(text.slice(mid, end));
    if (cost <= tokenBudget) {
      best = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return Math.max(0, Math.min(end - 1, best));
}

function nearestBoundary(text, preferredEnd, hardEnd, start) {
  if (preferredEnd >= hardEnd) return hardEnd;
  const minEnd = Math.max(start + 1, preferredEnd - 180);
  const scan = text.slice(minEnd, hardEnd);
  const boundaryRe = /[。！？!?；;\n](?=\s|$|[^\s])/g;
  let match;
  let chosen = -1;
  while ((match = boundaryRe.exec(scan))) {
    const absolute = minEnd + match.index + 1;
    if (absolute >= preferredEnd - 80) chosen = absolute;
  }
  return chosen > start ? chosen : preferredEnd;
}

/**
 * Split exact source text into overlapping chunks without storing a second copy of the source.
 * Returned start/end offsets always point into the supplied text.
 */
export function chunkNarrativeText(text, options = {}) {
  const source = String(text || '');
  if (!source.trim()) return [];
  const targetTokens = Math.max(240, Number(options.targetTokens) || 560);
  const maxTokens = Math.max(targetTokens, Number(options.maxTokens) || 720);
  const overlapTokens = Math.max(0, Math.min(Math.floor(targetTokens * 0.35), Number(options.overlapTokens) || 90));
  const minTokens = Math.max(80, Math.min(targetTokens, Number(options.minTokens) || 150));

  if (estimateTextTokens(source) <= maxTokens) {
    return [{ index: 0, start: 0, end: source.length, text: source, tokens: estimateTextTokens(source) }];
  }

  const chunks = [];
  let start = 0;
  let guard = 0;
  while (start < source.length && guard++ < 10000) {
    while (start < source.length && /\s/.test(source[start])) start++;
    if (start >= source.length) break;

    const preferred = maxEndForTokens(source, start, targetTokens);
    const hardEnd = maxEndForTokens(source, start, maxTokens);
    let end = nearestBoundary(source, preferred, hardEnd, start);
    if (end <= start) end = hardEnd;
    if (source.length - end > 0 && estimateTextTokens(source.slice(start, end)) < minTokens) end = hardEnd;
    if (end >= source.length) end = source.length;
    else if (estimateTextTokens(source.slice(end)) <= minTokens
        && estimateTextTokens(source.slice(start)) <= maxTokens) end = source.length;

    const chunkText = source.slice(start, end);
    chunks.push({ index: chunks.length, start, end, text: chunkText, tokens: estimateTextTokens(chunkText) });
    if (end >= source.length) break;

    const nextStart = overlapTokens > 0 ? startForTailTokens(source, end, overlapTokens) : end;
    start = Math.max(start + 1, Math.min(end, nextStart));
  }
  return chunks;
}

export function rawChunkId(row, chunk) {
  const seed = `${row?.key || row?.index || ''}|${row?.rawHash || ''}|${chunk?.index ?? 0}|${chunk?.start ?? 0}|${chunk?.end ?? 0}`;
  return `am_raw_chunk_${fnv1a(seed)}`;
}

export function rawFloorVectorId(row) {
  const seed = `${row?.key || row?.index || ''}|${row?.rawHash || ''}`;
  return `am_raw_floor_${fnv1a(seed)}`;
}

const COMMON_ITEM_SUFFIXES = [
  '领带夹', '项链', '吊坠', '手链', '手镯', '戒指', '耳环', '耳坠', '发圈', '发夹', '钥匙', '房卡',
  '手机', '手表', '照片', '相片', '信件', '书信', '围巾', '外套', '杯子', '酒杯', '礼物', '首饰', '钱包', '胸针',
];

export function itemAliasTokens(name) {
  const raw = String(name || '').trim();
  const full = normalizedText(raw);
  const aliases = new Set(full ? [full] : []);
  for (const part of raw.split(/[／/、,，;；|()（）【】\[\]：:·•]+/)) {
    const normalized = normalizedText(part);
    if (normalized.length >= 2) aliases.add(normalized);
  }
  for (const suffix of COMMON_ITEM_SUFFIXES) {
    const normalizedSuffix = normalizedText(suffix);
    if (full.endsWith(normalizedSuffix)) aliases.add(normalizedSuffix);
  }
  return [...aliases].filter(token => token.length >= 2);
}

export function queryMatchesItemName(query, name) {
  const q = normalizedText(query);
  if (!q) return false;
  return itemAliasTokens(name).some(alias => q.includes(alias));
}


/**
 * Keep the beginning, several middle checkpoints and the recent tail of a long entity timeline.
 * This avoids the same "head + latest only" failure mode that can erase an item's lifecycle middle.
 */
export function sampleTimelineEvents(events, limit = 12) {
  const source = Array.isArray(events) ? events.filter(Boolean) : [];
  const cap = Math.max(3, Math.floor(Number(limit) || 12));
  if (source.length <= cap) return [...source];

  const headCount = Math.min(3, Math.max(1, Math.floor(cap * 0.25)));
  const tailCount = Math.min(5, Math.max(2, Math.floor(cap * 0.42)));
  const middleSlots = Math.max(0, cap - headCount - tailCount);
  const picked = new Set();
  for (let i = 0; i < headCount; i++) picked.add(i);
  for (let i = Math.max(headCount, source.length - tailCount); i < source.length; i++) picked.add(i);

  const middleStart = headCount;
  const middleEnd = Math.max(middleStart, source.length - tailCount - 1);
  for (let slot = 1; slot <= middleSlots && middleEnd >= middleStart; slot++) {
    const ratio = slot / (middleSlots + 1);
    picked.add(Math.round(middleStart + (middleEnd - middleStart) * ratio));
  }
  return [...picked].sort((a, b) => a - b).slice(0, cap).map(index => source[index]);
}
