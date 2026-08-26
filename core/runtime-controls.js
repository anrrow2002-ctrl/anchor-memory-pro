export function createAbortRegistry() {
  const scopes = new Map();

  function create(scope = 'default') {
    const controller = new AbortController();
    if (!scopes.has(scope)) scopes.set(scope, new Set());
    const bucket = scopes.get(scope);
    bucket.add(controller);
    const cleanup = () => {
      bucket.delete(controller);
      if (bucket.size === 0) scopes.delete(scope);
    };
    controller.signal.addEventListener('abort', cleanup, { once: true });
    return { controller, cleanup };
  }

  function abortScope(scope, reason = 'Anchor Memory request cancelled') {
    const bucket = scopes.get(scope);
    if (!bucket) return 0;
    let count = 0;
    for (const controller of [...bucket]) {
      if (!controller.signal.aborted) {
        count += 1;
        try { controller.abort(reason); } catch { controller.abort(); }
      }
    }
    scopes.delete(scope);
    return count;
  }

  function abortAll(reason = 'Anchor Memory context changed') {
    let count = 0;
    for (const scope of [...scopes.keys()]) count += abortScope(scope, reason);
    return count;
  }

  function count(scope = '') {
    if (scope) return scopes.get(scope)?.size || 0;
    let total = 0;
    for (const bucket of scopes.values()) total += bucket.size;
    return total;
  }

  return { create, abortScope, abortAll, count };
}

export function estimateTextTokens(text) {
  const value = String(text || '');
  const cjk = (value.match(/[\u3400-\u9fff]/g) || []).length;
  const other = Math.max(0, value.length - cjk);
  return Math.max(0, Math.ceil(cjk * 0.82 + other / 3.8));
}

function fitPrefixByTokens(source, tokenBudget) {
  let low = 0;
  let high = source.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTextTokens(source.slice(0, mid)) <= tokenBudget) low = mid;
    else high = mid - 1;
  }
  return source.slice(0, low);
}

function fitSuffixByTokens(source, tokenBudget) {
  let low = 0;
  let high = source.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTextTokens(source.slice(-mid)) <= tokenBudget) low = mid;
    else high = mid - 1;
  }
  return source.slice(-low);
}

function fitWindowByTokens(source, centerRatio, tokenBudget) {
  if (!source || tokenBudget <= 0) return { start: 0, end: 0, text: '' };
  const center = Math.max(0, Math.min(source.length, Math.floor(source.length * centerRatio)));
  // Grow symmetrically around the requested center, then snap outward to nearby line/sentence boundaries.
  let low = 1;
  let high = source.length;
  let bestStart = center;
  let bestEnd = Math.min(source.length, center + 1);
  while (low <= high) {
    const span = Math.floor((low + high) / 2);
    const start = Math.max(0, center - Math.floor(span / 2));
    const end = Math.min(source.length, start + span);
    if (estimateTextTokens(source.slice(start, end)) <= tokenBudget) {
      bestStart = start;
      bestEnd = end;
      low = span + 1;
    } else {
      high = span - 1;
    }
  }
  const boundary = /[\n。！？!?；;]/;
  let start = bestStart;
  let end = bestEnd;
  for (let i = bestStart; i > Math.max(0, bestStart - 100); i--) {
    if (boundary.test(source[i - 1] || '')) { start = i; break; }
  }
  for (let i = bestEnd; i < Math.min(source.length, bestEnd + 100); i++) {
    if (boundary.test(source[i] || '')) { end = i + 1; break; }
  }
  let text = source.slice(start, end).trim();
  if (estimateTextTokens(text) > tokenBudget) text = fitPrefixByTokens(text, tokenBudget).trim();
  return { start, end, text };
}

export function clampTextByTokens(text, maxTokens, headRatio = 0.34, markerText = '…（因本次上下文预算已裁剪）…') {
  const value = String(text || '').trim();
  const budget = Math.max(0, Math.floor(Number(maxTokens) || 0));
  if (!value || budget <= 0) return '';
  if (estimateTextTokens(value) <= budget) return value;

  const markerCore = String(markerText || '…（因本次上下文预算已裁剪）…').trim();
  const marker = `\n${markerCore}\n`;
  const markerCost = estimateTextTokens(marker);
  // Preserve four chronological windows rather than deleting one enormous middle block. This is
  // especially important for long RP memory where an item/event may live anywhere in the history.
  const markerCount = 3;
  const usable = Math.max(1, budget - markerCost * markerCount);
  const requestedHead = Math.max(0.18, Math.min(0.42, Number(headRatio) || 0.34));
  const headBudget = Math.max(1, Math.floor(usable * requestedHead));
  const tailBudget = Math.max(1, Math.floor(usable * 0.34));
  const middleBudget = Math.max(1, usable - headBudget - tailBudget);
  const middleOneBudget = Math.max(1, Math.floor(middleBudget / 2));
  const middleTwoBudget = Math.max(1, middleBudget - middleOneBudget);

  const head = fitPrefixByTokens(value, headBudget).trim();
  const middleOne = fitWindowByTokens(value, 0.40, middleOneBudget);
  const middleTwo = fitWindowByTokens(value, 0.68, middleTwoBudget);
  const tail = fitSuffixByTokens(value, tailBudget).trim();

  const windows = [
    { start: 0, end: head.length, text: head },
    middleOne,
    middleTwo,
    { start: Math.max(0, value.length - tail.length), end: value.length, text: tail },
  ].filter(window => window.text);
  windows.sort((a, b) => a.start - b.start);

  const merged = [];
  for (const window of windows) {
    const previous = merged[merged.length - 1];
    if (previous && window.start <= previous.end + 8) {
      const combinedStart = previous.start;
      const combinedEnd = Math.max(previous.end, window.end);
      previous.start = combinedStart;
      previous.end = combinedEnd;
      previous.text = value.slice(combinedStart, combinedEnd).trim();
    } else {
      merged.push({ ...window });
    }
  }
  if (merged.length === 1 && estimateTextTokens(merged[0].text) <= budget) return merged[0].text;

  let result = merged.map(window => window.text).join(marker);
  // Boundary snapping may have added a few tokens. Trim the final window first instead of erasing
  // another middle section.
  if (estimateTextTokens(result) > budget && merged.length > 1) {
    const fixed = merged.slice(0, -1).map(window => window.text).join(marker);
    const remaining = Math.max(1, budget - estimateTextTokens(fixed) - markerCost);
    const clippedTail = fitSuffixByTokens(merged.at(-1).text, remaining).trim();
    result = [fixed, clippedTail].filter(Boolean).join(marker);
  }
  if (estimateTextTokens(result) <= budget) return result;
  const ellipsis = '…';
  const ellipsisCost = estimateTextTokens(ellipsis);
  return `${fitPrefixByTokens(result, Math.max(1, budget - ellipsisCost)).trimEnd()}${ellipsis}`;
}

export function resolveAdaptiveMemoryBudget({
  contextSize = 0,
  promptTokens = 0,
  maxMemoryTokens = 8000,
  reserveTokens = 1400,
  minimumMemoryTokens = 1200,
} = {}) {
  const maxBudget = Math.max(1200, Math.floor(Number(maxMemoryTokens) || 8000));
  const reserve = Math.max(600, Math.floor(Number(reserveTokens) || 1400));
  const minimum = Math.max(600, Math.min(maxBudget, Math.floor(Number(minimumMemoryTokens) || 1200)));
  const limit = Math.max(0, Math.floor(Number(contextSize) || 0));
  const used = Math.max(0, Math.floor(Number(promptTokens) || 0));
  if (!limit) return maxBudget;
  const available = limit - used - reserve;
  if (available < 160) return 0;
  return Math.min(maxBudget, available < minimum ? available : Math.max(minimum, available));
}

export function fitMemorySections(sections, totalTokens) {
  const valid = (sections || []).filter(section => String(section?.text || '').trim());
  const total = Math.max(0, Math.floor(Number(totalTokens) || 0));
  if (!valid.length || total < 160) return { text: '', allocations: [], usedTokens: 0, totalTokens: total };

  const requested = valid.map(section => ({
    ...section,
    originalTokens: estimateTextTokens(section.text),
    minTokens: Math.max(40, Number(section.minTokens) || 80),
    maxTokens: Math.max(80, Number(section.maxTokens) || Number.MAX_SAFE_INTEGER),
    weight: Math.max(0.1, Number(section.weight) || 1),
  }));
  const dividerCost = estimateTextTokens('\n\n') * Math.max(0, requested.length - 1);
  let available = Math.max(200, total - dividerCost);
  const allocations = requested.map(section => Math.min(section.originalTokens, section.minTokens, section.maxTokens));
  let used = allocations.reduce((sum, value) => sum + value, 0);

  if (used > available) {
    const scale = available / used;
    for (let i = 0; i < allocations.length; i++) allocations[i] = Math.max(30, Math.floor(allocations[i] * scale));
    used = allocations.reduce((sum, value) => sum + value, 0);
  }

  let remaining = Math.max(0, available - used);
  for (let pass = 0; pass < 4 && remaining > 0; pass++) {
    const eligible = requested
      .map((section, index) => ({ section, index }))
      .filter(({ section, index }) => allocations[index] < Math.min(section.originalTokens, section.maxTokens));
    if (!eligible.length) break;
    const totalWeight = eligible.reduce((sum, entry) => sum + entry.section.weight, 0) || 1;
    let granted = 0;
    for (const { section, index } of eligible) {
      const capacity = Math.min(section.originalTokens, section.maxTokens) - allocations[index];
      const share = Math.max(1, Math.floor(remaining * (section.weight / totalWeight)));
      const add = Math.min(capacity, share);
      allocations[index] += add;
      granted += add;
    }
    if (!granted) break;
    remaining -= granted;
  }

  const rendered = requested.map((section, index) => {
    const text = clampTextByTokens(
      section.text,
      allocations[index],
      section.headRatio ?? 0.34,
      section.truncationMarker || '…（因本次上下文预算已裁剪）…',
    );
    return {
      id: section.id || String(index),
      allocatedTokens: allocations[index],
      originalTokens: section.originalTokens,
      renderedTokens: estimateTextTokens(text),
      truncated: estimateTextTokens(text) < section.originalTokens,
      text,
    };
  });

  const text = rendered.map(section => section.text).filter(Boolean).join('\n\n');
  return { text, allocations: rendered, usedTokens: estimateTextTokens(text), totalTokens: total };
}
