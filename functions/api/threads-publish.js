/**
 * Jom Content API: publish a planner post to Threads (@hamiddi_) through the official Threads API.
 *
 * GET  /api/threads-publish                -> { configured, username, refreshedAt, locked }
 * PUT  /api/threads-publish?action=token   -> body { token }  validates a long-lived token and stores it (never echoed back)
 * POST /api/threads-publish?id=<postId>    -> publishes the post caption; "---" lines split a chain (each part replies to the previous)
 *
 * Safety rules:
 *  - Refuses everything unless the API lock is on (JOM_API_TOKEN set). Without the lock anyone could post to the account.
 *  - Every post is published at most once. A KV record is written BEFORE the first Threads call, and a post with
 *    published parts is never retried automatically (a half-posted chain needs a human look).
 *  - The access token lives in KV key `threads_auth`, never in a response, log line or error message.
 *
 * KV namespace: JOM_CONTENT. Keys: posts, threads_auth, threads_publish:<postId>
 */
import { enforced, json } from '../_lib/auth.js';

const DEFAULT_BASE = 'https://graph.threads.net/v1.0';
const MAX_PART = 500;          // Threads text limit per post
const MAX_PARTS = 10;
const STALE_LOCK_MS = 15 * 60 * 1000;
const REFRESH_AFTER_MS = 7 * 24 * 3600 * 1000;
const MIN_REFRESH_AGE_MS = 24 * 3600 * 1000;   // Threads refuses to refresh a token younger than 24h

const base = (env) => String(env.THREADS_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
const root = (env) => base(env).replace(/\/v\d+(\.\d+)?$/, '');

async function threads(env, method, path, params) {
  const url = new URL(base(env) + path);
  const init = { method, headers: {} };
  if (method === 'GET') {
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  } else {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(params || {}).toString();
  }
  const res = await fetch(url.toString(), init);
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok || data.error) {
    const e = data.error || {};
    throw new Error(`Threads API ${res.status}${e.code ? ' (' + e.code + ')' : ''}: ${e.message || 'request failed'}`);
  }
  return data;
}

async function loadAuth(env) {
  return (await env.JOM_CONTENT.get('threads_auth', { type: 'json' })) || null;
}

// Keep the long-lived token alive: refresh it at most weekly, only when it is old enough for Threads to accept.
async function maybeRefresh(env, auth) {
  const age = Date.now() - Date.parse(auth.refreshedAt || 0);
  if (age < REFRESH_AFTER_MS || age < MIN_REFRESH_AGE_MS) return auth;
  try {
    const url = new URL(root(env) + '/refresh_access_token');
    url.searchParams.set('grant_type', 'th_refresh_token');
    url.searchParams.set('access_token', auth.token);
    const res = await fetch(url.toString());
    const data = await res.json();
    if (res.ok && data.access_token) {
      const next = { ...auth, token: data.access_token, refreshedAt: new Date().toISOString(), refreshError: '' };
      if (data.expires_in) next.expiresAt = new Date(Date.now() + Number(data.expires_in) * 1000).toISOString();
      await env.JOM_CONTENT.put('threads_auth', JSON.stringify(next));
      return next;
    }
    throw new Error((data.error && data.error.message) || 'refresh failed');
  } catch (e) {
    const next = { ...auth, refreshError: String(e.message || e).slice(0, 200) };
    await env.JOM_CONTENT.put('threads_auth', JSON.stringify(next));
    return next;
  }
}

function splitParts(caption) {
  return String(caption || '').split(/\n\s*---\s*\n/).map((s) => s.trim()).filter(Boolean);
}

function mytNow() {
  const iso = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

async function waitReady(env, token, creationId) {
  for (let i = 0; i < 8; i++) {
    try {
      const s = await threads(env, 'GET', '/' + creationId, { fields: 'status,error_message', access_token: token });
      if (!s.status || s.status === 'FINISHED') return;
      if (s.status === 'ERROR' || s.status === 'EXPIRED') throw new Error('container ' + s.status + (s.error_message ? ': ' + s.error_message : ''));
    } catch (e) {
      if (/container (ERROR|EXPIRED)/.test(e.message)) throw e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.JOM_CONTENT) return json({ success: false, error: 'KV binding not available' }, 500);
  const url = new URL(request.url);
  const locked = enforced(env);

  if (request.method === 'GET') {
    let auth = await loadAuth(env);
    if (auth && locked) auth = await maybeRefresh(env, auth);
    return json({
      success: true, locked, configured: Boolean(auth && auth.token),
      username: auth ? auth.username || '' : '', refreshedAt: auth ? auth.refreshedAt || '' : '',
      refreshError: auth ? auth.refreshError || '' : '',
    });
  }

  // Everything below can post to or reconfigure the account: the API lock must be on.
  if (!locked) return json({ success: false, error: 'lock_off', message: 'API lock belum aktif, butang Post dimatikan.' }, 403);

  if (request.method === 'PUT' && url.searchParams.get('action') === 'token') {
    let body = {};
    try { body = await request.json(); } catch { /* handled below */ }
    const token = String(body.token || '').trim();
    if (!token) return json({ success: false, error: 'token required' }, 400);
    try {
      const me = await threads(env, 'GET', '/me', { fields: 'id,username', access_token: token });
      await env.JOM_CONTENT.put('threads_auth', JSON.stringify({
        token, userId: me.id, username: me.username || '', refreshedAt: new Date().toISOString(), refreshError: '',
      }));
      return json({ success: true, username: me.username || '', userId: me.id });
    } catch (e) {
      return json({ success: false, error: 'token_rejected', message: String(e.message).replace(token, '[token]') }, 400);
    }
  }

  if (request.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405);

  const postId = url.searchParams.get('id');
  if (!postId) return json({ success: false, error: 'id required' }, 400);

  let auth = await loadAuth(env);
  if (!auth || !auth.token) return json({ success: false, error: 'not_configured', message: 'Token Threads belum disambung.' }, 409);
  auth = await maybeRefresh(env, auth);

  // The caller must send the exact caption it showed the user, so what is published is what was confirmed.
  let body = {};
  try { body = await request.json(); } catch { /* handled below */ }
  if (typeof body.caption !== 'string' || !body.caption.trim()) return json({ success: false, error: 'caption required', message: 'Caption yang dipaparkan mesti dihantar.' }, 400);

  const posts = (await env.JOM_CONTENT.get('posts', { type: 'json' })) || [];
  const post = posts.find((p) => p.id === postId);
  if (!post) return json({ success: false, error: 'Post not found', message: 'Post belum disimpan ke server. Simpan dulu.' }, 404);
  if (body.caption.trim() !== String(post.caption || '').trim()) {
    return json({ success: false, error: 'stale', message: 'Caption di server lain dari yang kau nampak. Refresh dashboard dulu.' }, 409);
  }
  if (post.platform !== 'threads') return json({ success: false, error: 'not_threads', message: 'Post ni bukan untuk Threads.' }, 422);
  if (post.status === 'posted' || post.postedUrl) return json({ success: false, error: 'already_posted', message: 'Post ni dah diposkan.' }, 409);
  if (post.status === 'rejected') return json({ success: false, error: 'rejected', message: 'Post ni berstatus rejected.' }, 422);

  const parts = splitParts(post.caption);
  if (!parts.length) return json({ success: false, error: 'empty', message: 'Caption kosong.' }, 422);
  if (parts.length > MAX_PARTS) return json({ success: false, error: 'too_many_parts', message: `Maksimum ${MAX_PARTS} bahagian.` }, 422);
  const tooLong = parts.findIndex((p) => [...p].length > MAX_PART);
  if (tooLong !== -1) return json({ success: false, error: 'too_long', message: `Bahagian ${tooLong + 1} melebihi ${MAX_PART} aksara.` }, 422);

  // Idempotency record, written before anything is sent to Threads.
  const lockKey = 'threads_publish:' + postId;
  const prior = await env.JOM_CONTENT.get(lockKey, { type: 'json' });
  if (prior) {
    const fresh = Date.now() - Date.parse(prior.startedAt || 0) < STALE_LOCK_MS;
    if (prior.state === 'published') return json({ success: false, error: 'already_posted', message: 'Post ni dah diposkan.', urls: prior.urls || [] }, 409);
    if (prior.state === 'publishing' && fresh) return json({ success: false, error: 'in_progress', message: 'Post ni sedang diterbitkan.' }, 409);
    if ((prior.urls || []).length) return json({ success: false, error: 'partial', message: 'Sebahagian chain dah keluar. Semak Threads dan jangan ulang.', urls: prior.urls }, 409);
  }
  const record = { state: 'publishing', startedAt: new Date().toISOString(), total: parts.length, urls: [], ids: [] };
  await env.JOM_CONTENT.put(lockKey, JSON.stringify(record));

  try {
    for (let i = 0; i < parts.length; i++) {
      const create = { media_type: 'TEXT', text: parts[i], access_token: auth.token };
      if (i > 0) create.reply_to_id = record.ids[i - 1];
      const container = await threads(env, 'POST', `/${auth.userId}/threads`, create);
      await waitReady(env, auth.token, container.id);
      const published = await threads(env, 'POST', `/${auth.userId}/threads_publish`, { creation_id: container.id, access_token: auth.token });
      record.ids.push(published.id);
      let link = '';
      try { link = (await threads(env, 'GET', '/' + published.id, { fields: 'permalink', access_token: auth.token })).permalink || ''; } catch { /* permalink is nice-to-have */ }
      record.urls.push(link);
      await env.JOM_CONTENT.put(lockKey, JSON.stringify(record));   // survive a crash between parts
    }
  } catch (e) {
    record.state = 'failed';
    record.error = String(e.message || e).replace(auth.token, '[token]').slice(0, 300);
    await env.JOM_CONTENT.put(lockKey, JSON.stringify(record));
    const partial = record.ids.length > 0;
    if (partial) {
      // Leave a visible trace on the post itself: part of the chain is already live on Threads.
      const cur = (await env.JOM_CONTENT.get('posts', { type: 'json' })) || [];
      const k = cur.findIndex((p) => p.id === postId);
      if (k !== -1) {
        cur[k].notes = (cur[k].notes ? cur[k].notes + '\n' : '') + `PARTIAL PUBLISH ${new Date().toISOString()}: bahagian ${record.ids.length === 1 ? "1" : "1-" + record.ids.length} dari ${parts.length} dah keluar (${record.urls.filter(Boolean).join(' ')}). Semak Threads, jangan ulang.`;
        await env.JOM_CONTENT.put('posts', JSON.stringify(cur));
      }
    }
    return json({
      success: false, error: partial ? 'partial' : 'publish_failed', published: record.ids.length, total: parts.length, urls: record.urls,
      message: partial
        ? `${record.ids.length === 1 ? 'Bahagian 1' : 'Bahagian 1-' + record.ids.length} dah keluar, bahagian ${record.ids.length + 1} gagal: ${record.error}. Semak Threads, jangan ulang.`
        : `Gagal post: ${record.error}`,
    }, 502);
  }

  record.state = 'published';
  record.publishedAt = new Date().toISOString();
  await env.JOM_CONTENT.put(lockKey, JSON.stringify(record));

  // Re-read right before writing so a concurrent edit to another post is not overwritten.
  const fresh = (await env.JOM_CONTENT.get('posts', { type: 'json' })) || [];
  const i = fresh.findIndex((p) => p.id === postId);
  const now = mytNow();
  if (i !== -1) {
    Object.assign(fresh[i], {
      status: 'posted', approved: true, date: now.date, time: now.time,
      actualContent: post.caption, postedUrl: record.urls[0] || '', actualUpdatedAt: record.publishedAt, updatedAt: record.publishedAt,
      notes: (fresh[i].notes ? fresh[i].notes + '\n' : '') + `PUBLISHED via dashboard ${now.date} ${now.time} MYT (${parts.length} bahagian).`,
    });
    await env.JOM_CONTENT.put('posts', JSON.stringify(fresh));
  }
  return json({ success: true, parts: parts.length, urls: record.urls, postedUrl: record.urls[0] || '', date: now.date, time: now.time });
}
