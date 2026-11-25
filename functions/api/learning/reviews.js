import { enforced, json, safeEqual } from '../../_lib/auth.js';
import { MAX_POST_LENGTH, RECORDS_KEY, analysisDigest, loadRecords } from '../../_lib/analysis-review.js';

/**
 * Machine ingest of Threads analysis review records (host -> dashboard).
 *
 * GET /api/learning/reviews -> {count, records:[{id, hash}]} readback of what is stored
 * PUT /api/learning/reviews -> body {records:[...]} replaces the record array
 *
 * Bearer token (JOM_API_TOKEN) only: this is the agent's write path, so an owner
 * browser session is refused here. It writes `threads_analysis_reviews` and nothing
 * else. It can never create, change or revoke an owner decision or edit
 * (`threads_analysis_decision:*`, `threads_analysis_edit:*`); a changed record simply
 * reads back as stale/pending until the owner reviews it again.
 */
const MAX_RECORDS = 200;
const MAX_BYTES = 1024 * 1024;
const ID = /^[A-Za-z0-9._:-]{1,160}$/;

export async function onRequest({ request, env }) {
  if (!env.JOM_CONTENT) return json({ success: false, error: 'storage_unavailable' }, 503);
  if (!enforced(env)) return json({ success: false, error: 'lock_off' }, 403);
  if (!['GET', 'PUT'].includes(request.method)) {
    return json({ success: false, error: 'method not allowed' }, 405, { Allow: 'GET, PUT' });
  }
  const header = request.headers.get('Authorization') || '';
  const bearer = header.startsWith('Bearer ') && await safeEqual(header.slice(7), env.JOM_API_TOKEN, env.JOM_API_TOKEN);
  if (!bearer) return json({ success: false, error: 'agent_token_required' }, 403);

  if (request.method === 'GET') {
    const records = await loadRecords(env);
    const out = await Promise.all(records.map(async (record) => ({ id: record.id, hash: await analysisDigest(record, null) })));
    return json({ success: true, count: out.length, records: out });
  }

  const raw = await request.text();
  if (raw.length > MAX_BYTES) return json({ success: false, error: 'payload_too_large' }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ success: false, error: 'invalid_body' }, 400); }
  const records = Array.isArray(body) ? body : body?.records;
  if (!Array.isArray(records)) return json({ success: false, error: 'invalid_body', message: 'records array diperlukan' }, 400);
  if (records.length > MAX_RECORDS) return json({ success: false, error: 'too_many_records', max: MAX_RECORDS }, 400);

  const seen = new Set();
  for (const [index, record] of records.entries()) {
    const problem = !record || typeof record !== 'object' || Array.isArray(record) ? 'not_an_object'
      : typeof record.id !== 'string' || !ID.test(record.id) ? 'invalid_id'
        : seen.has(record.id) ? 'duplicate_id'
          : typeof record.generatedPost !== 'string' || !record.generatedPost.trim() ? 'generated_post_missing'
            : record.generatedPost.length > MAX_POST_LENGTH ? 'generated_post_too_long'
              : '';
    if (problem) return json({ success: false, error: 'invalid_record', index, reason: problem }, 400);
    seen.add(record.id);
  }

  await env.JOM_CONTENT.put(RECORDS_KEY, JSON.stringify(records));
  const stored = await Promise.all(records.map(async (record) => ({ id: record.id, hash: await analysisDigest(record, null) })));
  return json({ success: true, count: stored.length, records: stored });
}
