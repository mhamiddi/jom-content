import { enforced, json, safeEqual, sessionValid } from '../../_lib/auth.js';
import { EnvelopeError, buildEnvelope } from '../../_lib/approval-envelope.js';

/**
 * GET /api/learning/approvals            -> signed approval envelope (host-consumable)
 * GET /api/learning/approvals?format=key -> public key file + pin for the host
 *
 * Read-only. It can never create, change or revoke a decision: the only writer
 * of `threads_analysis_decision:*` is `POST /api/threads-analysis`, which
 * requires an interactive owner session and a matching Origin. This route only
 * re-serialises decisions the owner already stored, so a bearer-token agent may
 * read it (the host needs that for the HTTPS envelope mode) but still cannot
 * approve anything.
 *
 * Fails closed: no signing key, no public key, no owner session secret, or a
 * failed self-verification returns an error and no envelope at all.
 */
export async function onRequest({ request, env }) {
  if (!env.JOM_CONTENT) return json({ success: false, error: 'storage_unavailable' }, 503);
  if (!enforced(env)) {
    return json({ success: false, error: 'lock_off', message: 'Set JOM_API_TOKEN untuk mengaktifkan kelulusan pemilik.' }, 403);
  }
  if (!env.JOM_SESSION_SECRET || env.JOM_SESSION_SECRET === env.JOM_API_TOKEN) {
    return json({ success: false, error: 'owner_session_not_configured' }, 503);
  }
  if (request.method !== 'GET') {
    return json({ success: false, error: 'method not allowed' }, 405, { Allow: 'GET' });
  }

  const caller = request.headers.get('Authorization') || '';
  const bearer = caller.startsWith('Bearer ') && await safeEqual(caller.slice(7), env.JOM_API_TOKEN, env.JOM_API_TOKEN);
  if (!bearer && !(await sessionValid(request, env))) {
    return json({ success: false, error: 'owner_session_required' }, 403);
  }

  const url = new URL(request.url);
  const format = url.searchParams.get('format') || 'envelope';
  if (!['envelope', 'key'].includes(format)) {
    return json({ success: false, error: 'invalid_format' }, 400);
  }

  let built;
  try {
    built = await buildEnvelope(env, { preview: env.ANALYSIS_PREVIEW === '1' });
  } catch (error) {
    // A signing failure is never papered over with an empty or unsigned body.
    const code = error instanceof EnvelopeError ? error.code : 'approval_envelope_failed';
    return json({ success: false, error: code, message: 'Envelope kelulusan tidak dapat dijana.' }, 503);
  }

  if (format === 'key') {
    return json({
      success: true,
      key: built.publicBlock,
      pin: { key_id: built.publicBlock.key_id, fingerprint_sha256: built.publicBlock.fingerprint_sha256 },
    });
  }

  // The body is the envelope itself so the host can fetch it verbatim.
  return new Response(JSON.stringify(built.envelope), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
