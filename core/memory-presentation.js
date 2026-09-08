import { estimateTextTokens } from './runtime-controls.js';

// Keep UTF-16 offsets unchanged: stored chunks point into the original message. Cleaning a
// fragment after slicing cannot remove the tail of a Think block whose opening is in another chunk.
export function maskNarrativeSource(value, selectWrappers = true) {
  const source = String(value || '');
  return source.split(/(?=【(?:用户输入|AI回复)｜)/).map(part => {
    const blank = text => text.replace(/[^\r\n]/g, ' ');
    let text = part;
    const tags = 'think|analysis|reasoning|reflection|scratchpad|planning|choices|script|style';
    text = text.replace(new RegExp(`<(${tags})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi'), blank);
    text = text.replace(new RegExp(`<(?:${tags})\\b[^>]*>[\\s\\S]*$`, 'gi'), blank);
    // A persisted source may itself start with the tail of a reasoning block.
    text = text.replace(new RegExp(`^[\\s\\S]*?<\\/(?:${tags})\\s*>`, 'i'), blank);
    const spans = [...text.matchAll(/<(context|content|letter)\b[^>]*>[\s\S]*?<\/\1\s*>/gi)];
    if (selectWrappers && spans.length) {
      const chars = [...text.split('')].map(char => /[\r\n]/.test(char) ? char : ' ');
      const header = text.match(/^【(?:用户输入|AI回复)｜[^\n]*\n/);
      if (header) for (let i = 0; i < header[0].length; i++) chars[i] = text[i];
      for (const span of spans) {
        const open = span[0].indexOf('>') + 1;
        const close = span[0].lastIndexOf('</');
        for (let i = span.index + open; i < span.index + close; i++) chars[i] = text[i];
      }
      text = chars.join('');
    }
    return text.replace(/^\s*\[[xX✓✔ ]\].*$/gm, blank)
      .replace(/^.*Checklist passed\.\s*Write now\..*$/gim, blank)
      .replace(/^\s*#{1,6}\s*(?:Phase\b[^\n]*|写作手法|写作要求|自检清单|检查清单|思考过程)[\s\S]*?(?=^\s*#{1,6}\s|(?![\s\S]))/gim, blank)
      .replace(/<\/?[a-z][^>]*>/gi, blank);
  }).join('');
}

export function narrativeText(value) {
  return maskNarrativeSource(value).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}

export function isConcreteRecallName(value) {
  const name = String(value || '').trim();
  // Quotes, long sentences and instruction fragments may remain in the user's reference index,
  // but must never become noun aliases that trigger an entire unrelated event timeline.
  return name.length >= 2 && name.length <= 48
    && !/[“”「」『』"\n!?！？。]/.test(name)
    && !/(?:Checklist|Phase|写作手法|思考过程|不要|不许|你别)/i.test(name);
}

export function memoryUnits(value) {
  const clean = narrativeText(value)
    .replace(/^\s*(?:\.{3}|…).*?(?:trimmed|裁剪|省略).*?$/gim, '')
    .replace(/^\s*\|\s*:?-+.*\|\s*$/gm, '');
  const seen = new Set();
  return clean.split(/\n+|(?<=[。！？!?；;])(?=[^”’」』])/u)
    .map(line => line.trim()).filter(line => {
      if (!line) return false;
      const key = line.replace(/[\s*#]/g, '');
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
}

export function fitMemoryText(value, maxTokens) {
  const budget = Math.max(0, Math.floor(Number(maxTokens) || 0));
  const units = memoryUnits(value);
  const picked = [];
  for (const unit of units) {
    if (estimateTextTokens([...picked, unit].join('\n')) > budget) continue;
    picked.push(unit);
  }
  // Never splice sentence interiors or append model-facing engineering diagnostics.
  while (picked.length && /^(?:#{1,6}\s|【[^】]+】$)/.test(picked.at(-1))) picked.pop();
  return picked.join('\n');
}

export function conciseMemory(value, maxChars = 300) {
  const units = memoryUnits(value);
  let used = 0;
  const selected = units.filter(unit => {
    if (used + unit.length + 1 > maxChars) return false;
    used += unit.length + 1; return true;
  }).join('\n');
  return selected || units[0] || '';
}

export function dedupeMemorySections(sections) {
  const seen = new Set();
  return sections.map(section => ({ ...section, text: memoryUnits(section.text).filter(unit => {
    // Shared short headings/names are not events; keep them available to each section.
    if (unit.length < 18) return true;
    const key = unit.replace(/[\s*#]/g, '');
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).join('\n') }));
}

// Select only complete configured XML bodies; mask everything else before chunking.
export function extractNarrativeSource(value, tags = ['context', 'content']) {
  const source = String(value || '');
  if (tags === null) return maskNarrativeSource(source);
  const allowed = tags.filter(tag => /^[a-zA-Z][a-zA-Z0-9_.:-]*$/.test(tag));
  const blank = text => text.replace(/[^\r\n]/g, ' ');
  if (!allowed.length) return blank(source);
  return source.split(/(?=【(?:用户输入|AI回复)｜)/).map(part => {
    // Player messages are direct input, not model reasoning.
    if (/^【用户输入｜/.test(part)) return maskNarrativeSource(part);
    const chars = blank(part).split('');
    const tagsToDrop = 'think|analysis|reasoning|reflection|scratchpad|planning|choices|script|style';
    const safe = part.replace(new RegExp('<(' + tagsToDrop + ')\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>', 'gi'), blank).replace(new RegExp('<(?:' + tagsToDrop + ')\\b[^>]*>[\\s\\S]*$', 'gi'), blank);
    const re = new RegExp('<(' + allowed.map(tag => tag.replace(/\./g, '\\.')).join('|') + ')\\b[^>]*>([\\s\\S]*?)<\\/\\1\\s*>', 'gi');
    for (const match of safe.matchAll(re)) {
      const start = match.index + match[0].indexOf('>') + 1;
      const clean = maskNarrativeSource(match[2], false);
      for (let i = 0; i < clean.length; i++) chars[start + i] = clean[i];
      const header = part.match(/^【AI回复｜[^\n]*\n/);
      if (header) for (let i = 0; i < header[0].length; i++) chars[i] = part[i];
    }
    return chars.join('');
  }).join('');
}
