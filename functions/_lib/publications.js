const PUBLICATION_STATUSES = new Set([
  'draft',
  'pending',
  'publishing',
  'published',
  'failed',
  'partial',
  'reconciliation_required',
]);

const STATUS_ALIASES = Object.freeze({ success: 'published', ok: 'published' });

function publicationKey(item, fallbackIndex = 0) {
  const platform = item.platform || item.target || 'unknown';
  const account = item.accountId || item.account || 'default';
  const external = item.externalId || item.url || item.kind || `legacy-${fallbackIndex}`;
  return [platform, account, external].join(':');
}

export function normalizePublication(raw = {}, defaults = {}) {
  const platform = String(raw.platform || raw.target || defaults.platform || '').trim();
  if (!platform) throw new Error('publication_platform_required');
  const externalId = String(raw.externalId || raw.id || raw.postId || '').trim();
  const rawStatus = String(raw.status || (raw.error ? 'failed' : 'published')).trim().toLowerCase();
  const status = STATUS_ALIASES[rawStatus] || rawStatus;
  if (!PUBLICATION_STATUSES.has(status)) throw new Error('invalid_publication_status');
  return {
    platform,
    accountId: String(raw.accountId || defaults.accountId || '').trim(),
    accountUsername: String(raw.accountUsername || raw.username || defaults.accountUsername || '').trim(),
    externalId,
    url: String(raw.url || raw.permalink || '').trim(),
    status,
    kind: String(raw.kind || defaults.kind || '').trim(),
    error: String(raw.error || raw.errorMessage || '').trim().slice(0, 300),
    publishedAt: raw.publishedAt || defaults.publishedAt || null,
    updatedAt: raw.updatedAt || defaults.updatedAt || new Date().toISOString(),
  };
}

export function mergePublications(existing, incoming) {
  const merged = new Map();
  (Array.isArray(existing) ? existing : []).forEach((item, index) => {
    try {
      const normalized = normalizePublication(item);
      merged.set(publicationKey(normalized, index), normalized);
    } catch {
      // Keep legacy data visible rather than deleting an unrecognised record.
      merged.set(`legacy:${index}`, item);
    }
  });
  for (const item of Array.isArray(incoming) ? incoming : [incoming]) {
    const normalized = normalizePublication(item);
    merged.set(publicationKey(normalized), normalized);
  }
  return [...merged.values()];
}

export function publicationSummary(publications) {
  const records = Array.isArray(publications) ? publications : [];
  return {
    total: records.length,
    published: records.filter((item) => item.status === 'published').length,
    pending: records.filter((item) => ['pending', 'publishing'].includes(item.status)).length,
    failed: records.filter((item) => ['failed', 'partial', 'reconciliation_required'].includes(item.status)).length,
  };
}
