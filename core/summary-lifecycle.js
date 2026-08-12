function stableHash(input) {
  let hash = 2166136261;
  const text = String(input || '');
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function makeStableMessageKey({
  storedKey = '',
  persistentIdentity = '',
  role = 'assistant',
  index = 0,
  uuid = '',
  now = Date.now(),
  randomSuffix = '',
} = {}) {
  const existing = String(storedKey || '').trim();
  if (existing) return existing;
  const persistent = String(persistentIdentity || '').trim();
  if (persistent) return `ammsg:p:${stableHash(`${role}|${persistent}`)}`;
  if (uuid) return `ammsg:${uuid}`;
  const suffix = String(randomSuffix || Math.random().toString(36).slice(2, 10));
  return `ammsg:${Number(now).toString(36)}:${suffix}:${Number(index) || 0}`;
}

export function isCompletedSummary(item) {
  return !!(item && item.status === 'ready' && !item.stale && String(item.body || '').trim());
}

export function summaryRevisionHash(item, row = null) {
  return String(item?.rawHash || row?.rawHash || '');
}

export function lockCompletedSummaryToSavedSnapshot(item, row, reason = '', now = Date.now()) {
  if (!isCompletedSummary(item) || !row) return false;
  const mismatch = !!(item.rawHash && row.rawHash && item.rawHash !== row.rawHash);
  const nextCurrentRawHash = mismatch ? row.rawHash : '';
  const nextReason = mismatch ? String(reason || '楼层在摘要完成后发生了变化') : '';
  const changed = item.floor !== row.index
    || item.name !== row.name
    || item.sendDate !== row.sendDate
    || String(item.currentRawHash || '') !== nextCurrentRawHash
    || String(item.sourceMismatchReason || '') !== nextReason
    || !!item.sourceMismatch !== mismatch
    || item.status !== 'ready'
    || !!item.stale;
  if (!changed) return false;

  Object.assign(item, {
    floor: row.index,
    role: row.role,
    name: row.name,
    sendDate: row.sendDate,
    status: 'ready',
    stale: false,
    staleSince: 0,
    error: '',
    sourceMismatch: mismatch,
    currentRawHash: nextCurrentRawHash,
    sourceMismatchReason: nextReason,
    sourceMismatchAt: mismatch ? (item.sourceMismatchAt || now) : 0,
    updatedAt: item.updatedAt || now,
  });
  return true;
}
