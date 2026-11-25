import { enforced, json, sessionValid } from '../_lib/auth.js';
import {
  DECISIONS, MAX_NOTE_LENGTH, MAX_POST_LENGTH,
  analysisDigest, decisionKey, editKey, loadDecision, loadEdit, loadRecords, reviewView,
} from '../_lib/analysis-review.js';

/**
 * Owner review of Threads analysis records. Local only; not deployed.
 *
 * GET   /api/threads-analysis[?id=]  -> records with server-computed hash + status
 * POST  /api/threads-analysis?id=    -> {decision, hash, note} owner decision
 * PATCH /api/threads-analysis?id=    -> {generatedPost} owner edit (or {reset:true})
 *
 * Every response is computed here: the hash is never accepted from the client as
 * proof of content, and a decision is written only when the submitted hash equals
 * the hash of the content as the server reads it now.
 */
const DIGEST = /^[a-f0-9]{64}$/;
const note = (value) => (typeof value === 'string' ? value.trim() : '');

// Editing revokes the decision permanently; a hash match alone never revives an
// approval after the owner changed the text (even if they later revert it).
async function revokeOnEdit(env, id, decision) {
  if (!decision || decision.revokedAt) return decision;
  const revoked = { ...decision, revokedAt: new Date().toISOString(), revokedReason: 'content_edited' };
  await env.JOM_CONTENT.put(decisionKey(id), JSON.stringify(revoked));
  return revoked;
}

export async function onRequest({ request, env }) {
  if (!env.JOM_CONTENT) return json({ success: false, error: 'storage_unavailable' }, 503);
  // Approval is only meaningful behind the API lock: no identity check, no review.
  if (!enforced(env)) return json({ success: false, error: 'lock_off', message: 'Set JOM_API_TOKEN untuk mengaktifkan semakan pemilik.' }, 403);
  if (!env.JOM_SESSION_SECRET || env.JOM_SESSION_SECRET === env.JOM_API_TOKEN) {
    return json({ success: false, error: 'owner_session_not_configured', message: 'Server perlu JOM_SESSION_SECRET yang berbeza daripada API token.' }, 503);
  }

  const url = new URL(request.url);
  const method = request.method;
  if (!['GET', 'POST', 'PATCH'].includes(method)) return json({ success: false, error: 'method not allowed' }, 405, { Allow: 'GET, POST, PATCH' });

  const agentCaller = (request.headers.get('Authorization') || '').startsWith('Bearer ');
  const ownerSession = await sessionValid(request, env);

  if (method === 'GET') {
    if (!ownerSession) return json({ success: false, error: 'owner_session_required' }, 403);
    const id = url.searchParams.get('id');
    const records = await loadRecords(env);
    const selected = id ? records.filter((record) => record.id === id) : records;
    if (id && !selected.length) return json({ success: false, error: 'not_found' }, 404);
    const reviews = await Promise.all(selected.map(async (record) => {
      const [decision, edit] = await Promise.all([loadDecision(env, record.id), loadEdit(env, record.id)]);
      return reviewView(record, edit, decision, await analysisDigest(record, edit));
    }));
    reviews.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || a.id.localeCompare(b.id));
    return json({ success: true, preview: env.ANALYSIS_PREVIEW === '1', generatedAt: new Date().toISOString(), reviews });
  }

  // Mutations: a bearer-token agent is never an owner, even with a valid token.
  if (agentCaller) return json({ success: false, error: 'agent_approval_forbidden', message: 'Kelulusan hanya melalui sesi pemilik dalam browser.' }, 403);
  if (!ownerSession) return json({ success: false, error: 'owner_session_required' }, 403);
  if (request.headers.get('Origin') !== url.origin) return json({ success: false, error: 'cross_origin' }, 403);

  const id = url.searchParams.get('id');
  if (!id) return json({ success: false, error: 'invalid_body', message: 'id diperlukan' }, 400);
  const records = await loadRecords(env);
  const record = records.find((item) => item.id === id);
  if (!record) return json({ success: false, error: 'not_found' }, 404);

  let body;
  try { body = await request.json(); } catch { return json({ success: false, error: 'invalid_body' }, 400); }
  if (!body || typeof body !== 'object') return json({ success: false, error: 'invalid_body' }, 400);

  const edit = await loadEdit(env, id);

  if (method === 'PATCH') {
    if (body.reset === true) {
      await env.JOM_CONTENT.delete(editKey(id));
      const decision = await revokeOnEdit(env, id, await loadDecision(env, id));
      return json({ success: true, review: reviewView(record, null, decision, await analysisDigest(record, null)) });
    }
    if (typeof body.generatedPost !== 'string' || !body.generatedPost.trim()) {
      return json({ success: false, error: 'invalid_post', message: 'Post tidak boleh kosong.' }, 400);
    }
    if (body.generatedPost.length > MAX_POST_LENGTH) {
      return json({ success: false, error: 'post_too_long', message: `Had ${MAX_POST_LENGTH} aksara.` }, 400);
    }
    const ownerEdit = { generatedPost: body.generatedPost, editedAt: new Date().toISOString() };
    await env.JOM_CONTENT.put(editKey(id), JSON.stringify(ownerEdit));
    // The edit changes the digest, so any existing approval is now stale by
    // construction. The decision record is kept for audit and shown as revoked.
    const decision = await revokeOnEdit(env, id, await loadDecision(env, id));
    return json({ success: true, review: reviewView(record, ownerEdit, decision, await analysisDigest(record, ownerEdit)) });
  }

  const decision = String(body.decision || '');
  if (!DECISIONS.has(decision)) return json({ success: false, error: 'invalid_decision' }, 400);
  if (typeof body.hash !== 'string' || !DIGEST.test(body.hash)) return json({ success: false, error: 'invalid_hash' }, 400);
  const reason = note(body.note);
  if (reason.length > MAX_NOTE_LENGTH) return json({ success: false, error: 'note_too_long' }, 400);
  if (decision !== 'approved' && reason.length < 4) {
    return json({ success: false, error: 'note_required', message: 'Nota diperlukan untuk revisi atau tolakan.' }, 400);
  }

  const currentHash = await analysisDigest(record, edit);
  if (body.hash !== currentHash) {
    return json({ success: false, error: 'stale_hash', message: 'Kandungan berubah. Muat semula dan semak semula.', hash: currentHash }, 409);
  }

  const previous = await loadDecision(env, id);
  const decidedAt = new Date().toISOString();
  const history = Array.isArray(previous?.history) ? previous.history.slice(-19) : [];
  history.push({ decision, note: reason, hash: currentHash, decidedAt });
  const stored = {
    decision,
    hash: currentHash,
    note: reason,
    decidedBy: 'owner',
    decidedAt,
    sequence: (Number(previous?.sequence) || 0) + 1,
    history,
  };
  await env.JOM_CONTENT.put(decisionKey(id), JSON.stringify(stored));
  return json({ success: true, review: reviewView(record, edit, stored, currentHash) });
}
