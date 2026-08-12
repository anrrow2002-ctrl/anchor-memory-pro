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

export function clampTextByTokens(text, maxTokens, headRatio = 0.34, markerText = '…（因本次上下文预算已裁剪）…') {
  const value = String(text || '').trim();
  const budget = Math.max(0, Math.floor(Number(maxTokens) || 0));
  if (!value || budget <= 0) return '';
  if (estimateTextTokens(value) <= budget) return value;

  const lines = value.split(/\r?\n/);
  const marker = `\n${String(markerText || '…（因本次上下文预算已裁剪）…').trim()}\n`;
  const markerCost = estimateTextTokens(marker);
  const usable = Math.max(1, budget - markerCost);
  const headBudget = Math.max(1, Math.floor(usable * Math.max(0.1, Math.min(0.9, headRatio))));
  const tailBudget = Math.max(1, usable - headBudget);

  const head = [];
  let headCost = 0;
  for (const line of lines) {
    const cost = estimateTextTokens(`${line}\n`);
    if (headCost + cost > headBudget) break;
    head.push(line);
    headCost += cost;
  }

  const tail = [];
  let tailCost = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    const cost = estimateTextTokens(`${line}\n`);
    if (tailCost + cost > tailBudget) break;
    tail.unshift(line);
    tailCost += cost;
  }

  if (head.length === 0 && tail.length === 0) {
    // A very long single line cannot contribute a whole line to either side. Preserve the
    // truncation marker anyway, otherwise callers cannot tell that the middle is missing.
    if (markerCost < budget) {
      const fitChars = (source, tokenBudget, fromEnd = false) => {
        let low = 0;
        let high = source.length;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          const sample = fromEnd ? source.slice(-mid) : source.slice(0, mid);
          if (estimateTextTokens(sample) <= tokenBudget) low = mid;
          else high = mid - 1;
        }
        return fromEnd ? source.slice(-low) : source.slice(0, low);
      };
      const charUsable = Math.max(2, budget - markerCost);
      const charHeadBudget = Math.max(1, Math.floor(charUsable * Math.max(0.1, Math.min(0.9, headRatio))));
      const charTailBudget = Math.max(1, charUsable - charHeadBudget);
      const headText = fitChars(value, charHeadBudget, false);
      const tailText = fitChars(value, charTailBudget, true);
      const result = `${headText}${marker}${tailText}`;
      if (estimateTextTokens(result) <= budget) return result;
    }

    let low = 0;
    let high = value.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (estimateTextTokens(value.slice(0, mid)) <= budget) low = mid;
      else high = mid - 1;
    }
    return `${value.slice(0, Math.max(1, low - 1))}…`;
  }

  const overlap = head.length + tail.length >= lines.length;
  const result = overlap ? value : `${head.join('\n')}${marker}${tail.join('\n')}`;
  if (estimateTextTokens(result) <= budget) return result;
  return clampTextByTokens(result.replace(marker, '\n…\n'), budget, headRatio, '…');
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
