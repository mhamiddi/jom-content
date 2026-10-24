/**
 * Jom Content API: official Threads analytics collector.
 *
 * GET /api/threads-analytics?action=collect&limit=100
 *   Calls the official Threads API using the server-side token in KV, collects
 *   owned posts and post-level insights, stores a redacted latest snapshot,
 *   and returns the snapshot to the caller.
 *
 * GET /api/threads-analytics?action=latest
 *   Returns the last stored redacted snapshot without calling Threads.
 *
 * The access token is never returned, logged, or included in the stored snapshot.
 */
import { enforced, json } from '../_lib/auth.js';
import { threadItemFromApi } from '../_lib/threads-analytics.mjs';

const DEFAULT_BASE = 'https://graph.threads.net/v1.0';
const MAX_LIMIT = 100;
const MAX_PAGES = 20;
const MAX_INSIGHT_CONCURRENCY = 4;

const base = (env) => String(env.THREADS_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
const root = (env) => base(env).replace(/\/v\d+(\.\d+)?$/, '');

async function threads(env, method, path, params) {
  const url = new URL(base(env) + path);
  const init = { method, headers: { Accept: 'application/json' } };
  if (method === 'GET') {
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }
  } else {
    init.method = method;
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(params || {}).toString();
  }
  const response = await fetch(url.toString(), init);
  let data = {};
  try { data = await response.json(); } catch { /* handled below */ }
  if (!response.ok || data.error) {
    const error = data.error || {};
    const err = new Error(error.message || `Threads API request failed (${response.status})`);
    err.status = response.status;
    err.code = error.code;
    throw err;
  }
  return data;
}

async function loadAuth(env) {
  return (await env.JOM_CONTENT.get('threads_auth', { type: 'json' })) || null;
}

async function maybeRefresh(env, auth) {
  const refreshedAt = Date.parse(auth?.refreshedAt || 0);
  const age = Date.now() - (Number.isFinite(refreshedAt) ? refreshedAt : 0);
  if (age < 7 * 24 * 3600 * 1000 || age < 24 * 3600 * 1000) return auth;
  try {
    const url = new URL(root(env) + '/refresh_access_token');
    url.searchParams.set('grant_type', 'th_refresh_token');
    url.searchParams.set('access_token', auth.token);
    const response = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
    const data = await response.json();
    if (!response.ok || data.error || !data.access_token) throw new Error(data?.error?.message || 'refresh failed');
    const next = { ...auth, token: data.access_token, refreshedAt: new Date().toISOString(), refreshError: '' };
    if (data.expires_in) next.expiresAt = new Date(Date.now() + Number(data.expires_in) * 1000).toISOString();
    await env.JOM_CONTENT.put('threads_auth', JSON.stringify(next));
    return next;
  } catch (error) {
    const next = { ...auth, refreshError: String(error.message || error).slice(0, 200) };
    await env.JOM_CONTENT.put('threads_auth', JSON.stringify(next));
    return next;
  }
}

async function listPosts(env, auth, limit) {
  const posts = [];
  let after = '';
  for (let page = 0; page < MAX_PAGES && posts.length < limit; page += 1) {
    const data = await threads(env, 'GET', '/me/threads', {
      fields: 'id,text,timestamp,permalink,username',
      limit: Math.min(100, limit - posts.length),
      after,
      access_token: auth.token,
    });
    if (Array.isArray(data.data)) posts.push(...data.data);
    const next = data?.paging?.cursors?.after;
    if (!next || !data?.paging?.next || !data.data?.length) break;
    after = next;
  }
  return posts.slice(0, limit);
}

async function mapWithConcurrency(items, worker, concurrency) {
  const output = new Array(items.length);
  let cursor = 0;
  async function consume() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, consume));
  return output;
}

async function collect(env, auth, limit) {
  const collectedAt = new Date().toISOString();
  const posts = await listPosts(env, auth, limit);
  const items = await mapWithConcurrency(posts, async (post) => {
    try {
      const insights = await threads(env, 'GET', `/${post.id}/insights`, {
        metric: 'views,likes,replies,reposts,quotes,shares',
        access_token: auth.token,
      });
      return { ...threadItemFromApi(post, insights), insight_error: '' };
    } catch (error) {
      return {
        ...threadItemFromApi(post, { data: [] }),
        insight_error: String(error.message || error).slice(0, 200),
      };
    }
  }, MAX_INSIGHT_CONCURRENCY);
  return {
    success: true,
    source: 'threads_api',
    collected_at: collectedAt,
    account: { id: auth.userId || '', username: auth.username || '' },
    posts: items.filter((item) => item.platform_content_id),
    errors: items.filter((item) => item.insight_error).length,
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.JOM_CONTENT) return json({ success: false, error: 'KV binding not available' }, 500);
  if (!enforced(env)) return json({ success: false, error: 'api_lock_off' }, 403);

  const url = new URL(request.url);
  const action = url.searchParams.get('action') || 'latest';
  if (request.method !== 'GET') return json({ success: false, error: 'method not allowed' }, 405);

  if (action === 'latest') {
    const latest = await env.JOM_CONTENT.get('threads_analytics_latest', { type: 'json' });
    return json(latest || { success: true, source: 'threads_api', posts: [], collected_at: null, errors: 0 });
  }
  if (action !== 'collect') return json({ success: false, error: 'invalid action' }, 400);

  const authBefore = await loadAuth(env);
  if (!authBefore?.token) return json({ success: false, error: 'not_configured' }, 409);
  const auth = await maybeRefresh(env, authBefore);
  const requested = Number(url.searchParams.get('limit') || 100);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(requested))) : MAX_LIMIT;

  try {
    const snapshot = await collect(env, auth, limit);
    await env.JOM_CONTENT.put('threads_analytics_latest', JSON.stringify(snapshot));
    return json(snapshot);
  } catch (error) {
    return json({ success: false, source: 'threads_api', error: String(error.message || error).slice(0, 300) }, 502);
  }
}
