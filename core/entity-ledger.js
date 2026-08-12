function clean(value) {
  return String(value ?? '').replace(/\|/g, '／').replace(/\s+/g, ' ').trim();
}

export function entityKey(value) {
  return clean(value).toLocaleLowerCase().replace(/[\s·•_—–\-\/\\，,。.!！?？:：;；“”"'‘’（）()【】\[\]{}]/g, '');
}

function stableId(prefix, value) {
  const source = entityKey(value) || 'unknown';
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}_${(hash >>> 0).toString(36)}`;
}

export function buildItemLedger(rows = [], previous = {}, tombstones = {}) {
  const byKey = { ...(previous?.byKey || {}) };
  const order = [];
  for (const row of rows || []) {
    const name = clean(row.name || row['物品/细节/内部梗'] || row['物品'] || row['名称']);
    const key = entityKey(name);
    if (!key || tombstones?.[key]) continue;
    const old = byKey[key] || {};
    byKey[key] = {
      id: old.id || stableId('item', key),
      key,
      name,
      boundTo: clean(row.boundTo || row['绑定人物'] || row['相关人物'] || row['持有者']) || old.boundTo || '未明',
      meaning: clean(row.meaning || row['核心象征意义与影响'] || row['象征意义与影响'] || row['影响']) || old.meaning || '未明',
      updatedAt: Date.now(),
    };
    order.push(key);
  }
  return { byKey, order: [...new Set(order)], updatedAt: Date.now() };
}

export function buildSceneLedger(rows = [], previous = {}, tombstones = {}) {
  const byKey = { ...(previous?.byKey || {}) };
  const order = [];
  for (const row of rows || []) {
    const name = clean(row.name || row['场景/地点'] || row['场景'] || row['地点']);
    const key = entityKey(name);
    if (!key || tombstones?.[key]) continue;
    const old = byKey[key] || {};
    byKey[key] = {
      id: old.id || stableId('scene', key),
      key,
      name,
      time: clean(row.time || row['时间']) || old.time || '未明',
      people: clean(row.people || row['人物']) || old.people || '未明',
      facts: clean(row.facts || row['已发生事实'] || row['事实']) || old.facts || '未明',
      updatedAt: Date.now(),
    };
    order.push(key);
  }
  return { byKey, order: [...new Set(order)], updatedAt: Date.now() };
}

export function diffRemovedEntityKeys(previousRows = [], nextRows = [], nameSelector = row => row?.name || '') {
  const previous = new Set((previousRows || []).map(row => entityKey(nameSelector(row))).filter(Boolean));
  const next = new Set((nextRows || []).map(row => entityKey(nameSelector(row))).filter(Boolean));
  return [...previous].filter(key => !next.has(key));
}

export function renderItemLedgerRows(ledger = {}) {
  return (ledger.order || []).map(key => ledger.byKey?.[key]).filter(Boolean);
}

export function renderSceneLedgerRows(ledger = {}) {
  return (ledger.order || []).map(key => ledger.byKey?.[key]).filter(Boolean);
}
