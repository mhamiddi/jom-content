/**
 * Versioned owner-approval records: canonical content → server-computed digest,
 * bounded decision history, and the N0 binding.
 *
 * An analysis record is produced by the learning agent (generated post +
 * reference post metrics + evidence + observation/hypotheses + confidence +
 * suggestion). The owner reviews it in analysis-review.html and records one of
 * three decisions. The decision is bound to a SHA-256 digest that this module
 * computes from the reviewable content. The client only ever echoes that digest
 * back; it can never assert approval or invent a hash.
 *
 * ``binding`` is the link to the host-side learning gate. The record may carry
 * the host's own candidate/analysis identity:
 *
 *   binding: {
 *     candidateId:      "tl-<calendar-id>-72h",     // host candidate record
 *     candidateSha256:  "<64 hex>",                 // host candidate_sha256
 *     analysisSha256:   "<64 hex>",                 // host analysis file hash
 *     postIds:          ["<threads post id>", ...], // exact published chain
 *   }
 *
 * The binding is inside the digest, so an agent cannot repoint an approved
 * review at a different analysis version without invalidating the approval.
 * A record without a complete binding can still be reviewed (approve/revise/
 * reject are useful owner records) but it is never emitted into a signed
 * approval envelope, so it can never reach the host's N0 document.
 *
 * Any content change — the agent regenerating the record, or the owner editing
 * the generated post — changes the digest, so a previous decision becomes
 * stale. A stale approval is never reported as approved.
 *
 * Schema 2: adds ``binding`` to the digested content. Decisions recorded under
 * schema 1 read back as stale (fail closed) and must be re-approved by the
 * owner; that is the intended direction of the change.
 *
 * Storage (JOM_CONTENT KV, same namespace as posts/topics):
 *   threads_analysis_reviews              -> analysis record array (agent-owned)
 *   threads_analysis_decision:<id>        -> latest decision + bounded history
 *   threads_analysis_edit:<id>            -> owner edit overlay for generatedPost
 *
 * Nothing here publishes, schedules, or mutates posts.
 */

export const RECORDS_KEY = 'threads_analysis_reviews';
export const DECISION_PREFIX = 'threads_analysis_decision:';
export const EDIT_PREFIX = 'threads_analysis_edit:';
export const DECISIONS = new Set(['approved', 'revise', 'rejected']);
export const DECISION_LABELS = { approved: 'approved', revise: 'revise', rejected: 'rejected' };
export const MAX_POST_LENGTH = 4000;
export const MAX_NOTE_LENGTH = 1200;
export const HISTORY_LIMIT = 20;
export const CONTENT_SCHEMA = 2;

const text = (value) => (typeof value === 'string' ? value : '');
const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const HEX64 = /^[a-f0-9]{64}$/;

/** Deterministic JSON: object keys sorted, array order preserved. */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}

export function normaliseHypothesis(item) {
  if (typeof item === 'string') return item;
  const value = object(item);
  return text(value.text || value.statement || value.hypothesis);
}

export function normaliseEvidence(item) {
  if (typeof item === 'string') return { claim: item, source: '', url: '', value: '' };
  const value = object(item);
  return {
    claim: text(value.claim || value.text),
    source: text(value.source || value.sourceLabel),
    url: text(value.url),
    value: typeof value.value === 'number' ? value.value : text(value.value),
  };
}

export function normaliseConfidence(value) {
  if (typeof value === 'string') return { level: value.toLowerCase(), score: null, rationale: '' };
  const raw = object(value);
  const status = text(raw.level || raw.status || raw.label).toLowerCase();
  const score = num(raw.score);
  return {
    level: status || (score == null ? '' : score >= 0.7 ? 'high' : score >= 0.45 ? 'medium' : 'low'),
    score,
    rationale: text(raw.rationale || raw.why || raw.note),
  };
}

export function normaliseSource(value) {
  const raw = object(value);
  return {
    type: text(raw.type || raw.platform || 'threads'),
    label: text(raw.label || raw.handle || raw.author),
    url: text(raw.url || raw.permalink),
    postId: text(raw.postId || raw.id),
    publishedAt: text(raw.publishedAt || raw.published_at),
    excerpt: text(raw.excerpt || raw.quote || raw.text),
  };
}

export function normaliseMetrics(value) {
  const raw = object(value);
  const keys = ['views', 'likes', 'replies', 'reposts', 'quotes', 'shares', 'saves', 'comments'];
  const out = {};
  for (const key of keys) if (num(raw[key]) != null) out[key] = raw[key];
  // Preserve any additional numeric metric the collector adds, so the digest
  // still covers it and the UI never silently drops evidence.
  for (const key of Object.keys(raw).sort()) {
    if (!(key in out) && num(raw[key]) != null) out[key] = raw[key];
  }
  return out;
}

export function normaliseComparison(value) {
  const raw = object(value);
  return {
    metric: text(raw.metric || 'views'),
    baselineMedian: num(raw.baselineMedian ?? raw.baseline ?? raw.median),
    deltaPct: num(raw.deltaPct ?? raw.delta),
    sampleDays: num(raw.sampleDays ?? raw.sample),
    note: text(raw.note || raw.basis),
  };
}

/**
 * Host-side learning identity. Always normalised (never undefined) so the
 * digest is stable whether the agent omits or empties the block.
 */
export function normaliseBinding(value) {
  const raw = object(value);
  const ids = Array.isArray(raw.postIds) ? raw.postIds : Array.isArray(raw.post_ids) ? raw.post_ids : [];
  return {
    candidateId: text(raw.candidateId || raw.candidate_id),
    candidateSha256: text(raw.candidateSha256 || raw.candidate_sha256).trim().toLowerCase(),
    analysisSha256: text(raw.analysisSha256 || raw.analysis_sha256).trim().toLowerCase(),
    postIds: ids.map((item) => text(item).trim()).filter(Boolean),
  };
}

/**
 * '' when the binding can reach the host gate, otherwise a stable reason code.
 * Mirrors the host's own checks (64-hex hashes, non-empty post id list) so an
 * envelope never contains an entry the host would have to drop.
 */
export function bindingProblem(binding) {
  const value = normaliseBinding(binding);
  if (!value.candidateId) return 'candidate_id_missing';
  if (!HEX64.test(value.candidateSha256)) return 'candidate_sha256_invalid';
  if (!HEX64.test(value.analysisSha256)) return 'analysis_sha256_invalid';
  if (!value.postIds.length) return 'post_ids_missing';
  return '';
}

/** The exact content a decision is bound to. ownerEdit replaces generatedPost only. */
export function reviewContent(record, ownerEdit) {
  const edit = ownerEdit && typeof ownerEdit.generatedPost === 'string' ? ownerEdit : null;
  return {
    schema: CONTENT_SCHEMA,
    id: text(record.id),
    classification: text(record.classification),
    generatedPost: edit ? edit.generatedPost : text(record.generatedPost),
    source: normaliseSource(record.source),
    metrics: normaliseMetrics(record.metrics),
    comparison: normaliseComparison(record.comparison),
    evidence: (Array.isArray(record.evidence) ? record.evidence : []).map(normaliseEvidence),
    observation: text(record.observation),
    hypotheses: (Array.isArray(record.hypotheses) ? record.hypotheses : []).map(normaliseHypothesis),
    confidence: normaliseConfidence(record.confidence),
    suggestion: text(record.suggestion),
    binding: normaliseBinding(record.binding),
  };
}

async function sha256HexOf(textValue) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(textValue));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function analysisDigest(record, ownerEdit) {
  return sha256HexOf(canonical(reviewContent(record, ownerEdit)));
}

export function decisionKey(id) {
  return DECISION_PREFIX + encodeURIComponent(String(id));
}

export function editKey(id) {
  return EDIT_PREFIX + encodeURIComponent(String(id));
}

/** Explicit allowlist: no KV record field is spread into an API response. */
export function reviewView(record, ownerEdit, decision, hash) {
  const content = reviewContent(record, ownerEdit);
  const currentHash = hash || '';
  const hasDecision = Boolean(decision && decision.hash);
  const revoked = Boolean(decision && decision.revokedAt);
  // An edit revokes the decision even if the owner later reverts the text to the
  // exact approved bytes: approval never resurrects from a hash match alone.
  const stale = hasDecision && (decision.hash !== currentHash || revoked);
  const status = hasDecision && !stale ? decision.decision : 'pending';
  const bindingIssue = bindingProblem(content.binding);
  return {
    id: content.id,
    createdAt: text(record.createdAt || record.generatedAt),
    generatedBy: text(record.generatedBy),
    classification: content.classification,
    generatedPost: text(record.generatedPost),
    effectivePost: content.generatedPost,
    ownerEdited: Boolean(ownerEdit && typeof ownerEdit.generatedPost === 'string' && ownerEdit.generatedPost !== text(record.generatedPost)),
    edit: ownerEdit && typeof ownerEdit.generatedPost === 'string'
      ? { generatedPost: ownerEdit.generatedPost, editedAt: text(ownerEdit.editedAt) }
      : null,
    source: content.source,
    metrics: content.metrics,
    comparison: content.comparison,
    evidence: content.evidence,
    observation: content.observation,
    hypotheses: content.hypotheses,
    confidence: content.confidence,
    suggestion: content.suggestion,
    binding: content.binding,
    bindingIssue,
    hash: currentHash,
    shortHash: currentHash.slice(0, 12),
    status,
    stale,
    decision: hasDecision
      ? {
          decision: decision.decision,
          note: text(decision.note),
          decidedAt: text(decision.decidedAt),
          decidedBy: text(decision.decidedBy),
          hash: text(decision.hash),
          sequence: num(decision.sequence),
          revokedAt: text(decision.revokedAt),
          revokedReason: text(decision.revokedReason),
        }
      : null,
    history: Array.isArray(decision?.history)
      ? decision.history.slice(-HISTORY_LIMIT).map((entry) => ({
          decision: text(entry.decision),
          note: text(entry.note),
          decidedAt: text(entry.decidedAt),
          hash: text(entry.hash),
        }))
      : [],
  };
}

/**
 * The only condition an integration may treat as owner approval.
 * ``bindingIssue`` is deliberately not part of it: a binding-less approval is
 * a real owner review, it just cannot become an N0 lesson.
 */
export function isApproved(view) {
  return Boolean(view && view.status === 'approved' && view.stale === false && view.decision && view.decision.hash === view.hash);
}

export async function loadRecords(env) {
  const raw = await env.JOM_CONTENT.get(RECORDS_KEY, { type: 'json' });
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.reviews) ? raw.reviews : [];
  return list.filter((item) => item && typeof item === 'object' && text(item.id) && text(item.generatedPost));
}

export async function loadDecision(env, id) {
  const value = await env.JOM_CONTENT.get(decisionKey(id), { type: 'json' });
  return value && typeof value === 'object' && DECISIONS.has(value.decision) ? value : null;
}

export async function loadEdit(env, id) {
  const value = await env.JOM_CONTENT.get(editKey(id), { type: 'json' });
  return value && typeof value === 'object' && typeof value.generatedPost === 'string' ? value : null;
}
