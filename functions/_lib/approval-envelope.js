/**
 * Signed approval envelope — the only bridge between the owner's dashboard
 * review and the host-side learning gate.
 *
 * Why asymmetric signatures: the host runs agents with shell access, so any
 * symmetric secret on the host could forge an "owner approval". The private key
 * lives only in the dashboard's server-side environment; the host holds the
 * public key and can verify but never mint.
 *
 * Envelope format (``threads-learning-approval-envelope/v1``), byte-compatible
 * with ``~/.hermes/scripts/threads_owner_approval.py``:
 *
 *   {
 *     "schema": "threads-learning-approval-envelope/v1",
 *     "key_id": "owner-2026-11",
 *     "issuer": "jom-content-dashboard",
 *     "issued_at": "2026-11-13T02:00:00.000Z",
 *     "approvals": [{ approval_id, candidate_id, candidate_sha256,
 *                     analysis_sha256, post_ids, decision, approved_at,
 *                     expires_at, note, review_id, review_sha256,
 *                     decision_sequence }],
 *     "revocations": [{ approval_id, revoked_at, review_id }],
 *     "excluded": [{ review_id, reason }],
 *     "counts": { records, approvals, rejected, revocations, excluded, pending },
 *     "provenance": { source, review_schema, digest, decisions, generated_by },
 *     "signature_b64": "..."
 *   }
 *
 * The signature covers the canonical UTF-8 JSON of the envelope with
 * ``signature_b64`` removed (sorted keys, compact separators, no ASCII
 * escaping). ``canonical`` is shared with the review digest and is deliberately
 * the same serializer Python's ``json.dumps(sort_keys=True,
 * separators=(',', ':'), ensure_ascii=False)`` produces for the same values.
 *
 * Signed values are strings, integers, booleans, null and arrays/objects of
 * those. No floats are placed in the signed payload, so cross-language number
 * formatting cannot diverge.
 */

import {
  analysisDigest, bindingProblem, canonical, loadDecision, loadEdit, loadRecords, reviewContent,
} from './analysis-review.js';

export const ENVELOPE_SCHEMA = 'threads-learning-approval-envelope/v1';
export const KEY_SCHEMA = 'threads-learning-owner-key/v1';
export const ALGORITHM = 'Ed25519';
export const ISSUER = 'jom-content-dashboard';
const HEX64 = /^[a-f0-9]{64}$/;
// PKCS#8 wrapper for a bare 32-byte Ed25519 seed.
const PKCS8_ED25519_PREFIX = '302e020100300506032b657004220420';

export class EnvelopeError extends Error {
  constructor(code) {
    super(code);
    this.name = 'EnvelopeError';
    this.code = code;
  }
}

const enc = new TextEncoder();

function toHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(value) {
  const bytes = typeof value === 'string' ? enc.encode(value) : value;
  return toHex(await crypto.subtle.digest('SHA-256', bytes));
}

export function canonicalBytes(value) {
  return enc.encode(canonical(value));
}

function b64ToBytes(value) {
  if (typeof value !== 'string' || !value.trim()) throw new EnvelopeError('key_material_missing');
  const cleaned = value.replace(/-----(BEGIN|END)[^-]+-----/g, '').replace(/\s+/g, '');
  let binary;
  try {
    binary = atob(cleaned);
  } catch {
    throw new EnvelopeError('key_material_base64_invalid');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 32 raw bytes out of a raw key, a PKCS#8 seed, or a base64 PEM body. */
function rawKeyBytes(value, kind) {
  const bytes = b64ToBytes(value);
  if (bytes.length === 32) return bytes;
  if (kind === 'private' && bytes.length === 48) return bytes.slice(16);
  if (kind === 'public' && bytes.length === 44) return bytes.slice(12);
  throw new EnvelopeError(kind === 'private' ? 'private_key_not_ed25519_32_bytes' : 'public_key_not_ed25519_32_bytes');
}

/** Import the signing key from base64 PKCS#8 (or a bare seed) held in env. */
export async function importSigningKey(value) {
  const bytes = b64ToBytes(value);
  const pkcs8 = bytes.length === 32 ? hexToBytes(PKCS8_ED25519_PREFIX + toHex(bytes)) : bytes;
  if (pkcs8.length !== 48) throw new EnvelopeError('private_key_not_ed25519_pkcs8');
  try {
    return await crypto.subtle.importKey('pkcs8', pkcs8, { name: ALGORITHM }, false, ['sign']);
  } catch {
    throw new EnvelopeError('private_key_import_failed');
  }
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The public half, as the file the host pins (``owner-public-key.json``). */
export async function publicKeyBlock(value, keyId, issuedAt) {
  const raw = rawKeyBytes(value, 'public');
  const fingerprint = await sha256Hex(raw);
  return {
    schema: KEY_SCHEMA,
    key_id: keyId,
    algorithm: ALGORITHM,
    public_key_b64: btoa(String.fromCharCode(...raw)),
    fingerprint_sha256: fingerprint,
    issued_at: issuedAt,
    note: 'jom-content dashboard learning-approval key',
  };
}

/** Read + validate the signing configuration. Missing material fails closed. */
export async function approvalConfig(env) {
  const privateKey = typeof env?.JOM_APPROVAL_PRIVATE_KEY === 'string' ? env.JOM_APPROVAL_PRIVATE_KEY.trim() : '';
  if (!privateKey) throw new EnvelopeError('approval_signing_key_unavailable');
  const publicKey = typeof env?.JOM_APPROVAL_PUBLIC_KEY === 'string' ? env.JOM_APPROVAL_PUBLIC_KEY.trim() : '';
  if (!publicKey) throw new EnvelopeError('approval_public_key_unavailable');
  const keyId = typeof env?.JOM_APPROVAL_KEY_ID === 'string' && env.JOM_APPROVAL_KEY_ID.trim()
    ? env.JOM_APPROVAL_KEY_ID.trim()
    : 'owner-2026-11';
  const key = await importSigningKey(privateKey);
  const publicBlock = await publicKeyBlock(publicKey, keyId, '');
  return { key, keyId, publicBlock, privateKey };
}

/**
 * Stable approval id: a function of (review id, approved digest, sequence).
 * Re-approving after a revoke yields a new id; the old one is revoked, so a
 * replay of the old approval cannot re-enter N0.
 */
export async function approvalId(reviewId, hash, sequence) {
  const digest = await sha256Hex(String(reviewId) + '\n' + String(hash) + '\n' + String(sequence));
  return 'ap-' + digest.slice(0, 32);
}

/**
 * Build the unsigned payload from stored decisions. Pure read: nothing here
 * writes to KV, and an entry is emitted only when the owner's stored decision
 * matches the digest of the content exactly as it is read now.
 */
export async function buildApprovalPayload({
  records, getDecision, getEdit, now = new Date(), keyId, issuer = ISSUER, preview = false,
}) {
  const approvals = [];
  const revocations = [];
  const excluded = [];
  let pending = 0;
  let rejected = 0;

  for (const record of records) {
    const reviewId = String(record.id);
    const [edit, decision] = await Promise.all([getEdit(reviewId), getDecision(reviewId)]);
    const hash = await analysisDigest(record, edit);
    const binding = reviewContent(record, edit).binding;

    if (!decision) {
      pending += 1;
      continue;
    }

    const sequence = Number.isInteger(decision.sequence) && decision.sequence > 0 ? decision.sequence : 1;

    // Superseded decisions are revoked explicitly, so a consumer that cached an
    // older envelope can never keep a stale approval alive. History is stored
    // oldest→newest with the current decision last, so sequence numbers count
    // backwards from the stored (current) sequence.
    if (Array.isArray(decision.history)) {
      const history = decision.history;
      for (let index = 0; index < history.length; index += 1) {
        const entry = history[index];
        const entrySequence = sequence - (history.length - 1 - index);
        if (!entry || typeof entry.hash !== 'string' || entrySequence < 1 || entrySequence >= sequence) continue;
        revocations.push({
          approval_id: await approvalId(reviewId, entry.hash, entrySequence),
          review_id: reviewId,
          review_sha256: entry.hash,
          decision_sequence: entrySequence,
          revoked_at: typeof entry.decidedAt === 'string' ? entry.decidedAt : '',
        });
      }
    }

    if (decision.revokedAt) {
      revocations.push({
        approval_id: await approvalId(reviewId, decision.hash, sequence),
        review_id: reviewId,
        revoked_at: String(decision.revokedAt),
      });
      excluded.push({ review_id: reviewId, reason: 'approval_revoked_by_edit' });
      continue;
    }

    if (decision.hash !== hash) {
      excluded.push({ review_id: reviewId, reason: 'content_changed_since_decision' });
      continue;
    }

    if (decision.decision === 'revise') {
      excluded.push({ review_id: reviewId, reason: 'owner_requested_revision' });
      continue;
    }

    const problem = bindingProblem(binding);
    if (problem) {
      excluded.push({ review_id: reviewId, reason: 'binding_' + problem });
      continue;
    }

    if (decision.decision === 'rejected') rejected += 1;
    approvals.push({
      approval_id: await approvalId(reviewId, hash, sequence),
      candidate_id: binding.candidateId,
      candidate_sha256: binding.candidateSha256,
      analysis_sha256: binding.analysisSha256,
      post_ids: binding.postIds,
      decision: decision.decision,
      approved_at: String(decision.decidedAt || ''),
      expires_at: null,
      note: typeof decision.note === 'string' ? decision.note : '',
      review_id: reviewId,
      review_sha256: hash,
      decision_sequence: sequence,
    });
  }

  const issuedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  return {
    schema: ENVELOPE_SCHEMA,
    key_id: keyId,
    issuer,
    issued_at: issuedAt,
    approvals,
    revocations,
    excluded,
    counts: {
      records: records.length,
      approvals: approvals.filter((row) => row.decision === 'approved').length,
      rejected,
      revocations: revocations.length,
      excluded: excluded.length,
      pending,
    },
    provenance: {
      source: preview ? 'jom-content-preview' : 'jom-content-dashboard',
      review_schema: 2,
      digest: 'sha256',
      decisions: 'owner_session_only',
      generated_by: 'functions/_lib/approval-envelope.js',
    },
  };
}

/** Sign the payload; the signature covers everything except signature_b64. */
export async function signPayload(payload, privateKey) {
  const body = { ...payload };
  delete body.signature_b64;
  let signature;
  try {
    signature = await crypto.subtle.sign({ name: ALGORITHM }, privateKey, canonicalBytes(body));
  } catch {
    throw new EnvelopeError('approval_signing_failed');
  }
  return { ...body, signature_b64: btoa(String.fromCharCode(...new Uint8Array(signature))) };
}

/** Verify locally (used by tests and the `/api/learning/approvals` self-check). */
export async function verifyEnvelope(envelope, publicKeyValue) {
  const raw = rawKeyBytes(publicKeyValue, 'public');
  const key = await crypto.subtle.importKey('raw', raw, { name: ALGORITHM }, false, ['verify']);
  const body = { ...envelope };
  const signature = String(body.signature_b64 || '');
  delete body.signature_b64;
  if (!signature) return false;
  let sig;
  try {
    sig = b64ToBytes(signature);
  } catch {
    return false;
  }
  return crypto.subtle.verify({ name: ALGORITHM }, key, sig, canonicalBytes(body));
}

/** Full read-side convenience used by the API route and tests. */
export async function buildEnvelope(env, { now = new Date(), preview = false } = {}) {
  const config = await approvalConfig(env);
  const [records] = await Promise.all([loadRecords(env)]);
  const payload = await buildApprovalPayload({
    records,
    getDecision: (id) => loadDecision(env, id),
    getEdit: (id) => loadEdit(env, id),
    now,
    keyId: config.keyId,
    preview,
  });
  const envelope = await signPayload(payload, config.key);
  const verified = await verifyEnvelope(envelope, config.publicBlock.public_key_b64);
  if (!verified) throw new EnvelopeError('approval_envelope_self_check_failed');
  return { envelope, publicBlock: config.publicBlock, keyId: config.keyId };
}

export { HEX64 };
