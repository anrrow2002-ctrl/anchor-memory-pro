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

export function isCompletedSummary(item, row = null) {
  return !!(item && item.status === 'ready' && !item.stale && !item.sourceMismatch
    && String(item.body || '').trim()
    && (!row || (!!item.rawHash && item.rawHash === row.rawHash && item.key === row.key)));
}

export function summaryRevisionHash(item, row = null) {
  return String(item?.rawHash || row?.rawHash || '');
}

export function lockCompletedSummaryToSavedSnapshot(item, row, reason = '', now = Date.now()) {
  if (!item || !row) return false;
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
    status: mismatch ? 'stale' : item.status,
    stale: mismatch || !!item.stale,
    staleSince: mismatch ? now : (item.staleSince || 0),
    error: mismatch ? '当前回复已换版；旧摘要仅供核对，不参与记忆。' : (item.error || ''),
    sourceMismatch: mismatch,
    currentRawHash: nextCurrentRawHash,
    sourceMismatchReason: nextReason,
    sourceMismatchAt: mismatch ? (item.sourceMismatchAt || now) : 0,
    updatedAt: item.updatedAt || now,
  });
  return true;
}

// Cache only completed, attributable text. In-flight flags and derived state never travel
// between swipes. The active revision still has to pass the live-source check before use.
export function rememberSummaryRevision(item, limit = 8) {
  if (!isCompletedSummary(item) || !item.rawHash) return false;
  const revisions = (item.revisions || []).filter(entry => entry.rawHash !== item.rawHash);
  revisions.push({ rawHash: item.rawHash, body: item.body, savedAt: Date.now() });
  item.revisions = revisions.slice(-limit);
  return true;
}

export function restoreSummaryRevision(item, row) {
  if (!item || !row || item.key !== row.key) return false;
  const saved = (item.revisions || []).find(entry => entry.rawHash === row.rawHash && entry.body);
  if (!saved) return false;
  Object.assign(item, {
    body: saved.body, rawHash: row.rawHash, status: 'ready', stale: false,
    sourceMismatch: false, currentRawHash: '', sourceMismatchReason: '',
    sourceMismatchAt: 0, staleSince: 0, error: '', retryCount: 0,
    retryScheduledAt: 0, rerunPending: false, rerunQueued: false,
    pendingGeneratedBody: '', pendingGeneratedRawHash: '', updatedAt: Date.now(),
  });
  return true;
}
