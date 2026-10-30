/**
 * Zernio (Late) API client for TikTok / YouTube distribution.
 * Base: https://zernio.com/api/v1 — auth: Authorization: Bearer <ZERNIO_API_KEY>
 */
const BASE = 'https://zernio.com/api/v1';

export const SOCIAL_PLATFORMS = ['tiktok', 'youtube'];

export function configured(env) {
  return Boolean(env && env.ZERNIO_API_KEY);
}

async function call(env, path, { method = 'GET', body = null, idempotencyKey = '' } = {}) {
  if (!configured(env)) throw new Error('Zernio belum dikonfigurasi');
  const headers = { Authorization: 'Bearer ' + env.ZERNIO_API_KEY };
  if (body) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const response = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error || 'Zernio HTTP ' + response.status);
  }
  return data;
}

export async function listAccounts(env) {
  const data = await call(env, '/accounts');
  return (data.accounts || []).map((account) => ({
    id: account._id || account.id,
    platform: account.platform,
    username: account.username || account.displayName || '',
    displayName: account.displayName || '',
  }));
}

export async function createPost(env, payload, idempotencyKey = '') {
  const data = await call(env, '/posts', { method: 'POST', body: payload, idempotencyKey });
  return data.post || data;
}

export async function getPost(env, id) {
  const data = await call(env, '/posts/' + encodeURIComponent(id));
  return data.post || data;
}

export function platformResult(post, platform) {
  const entry = (post.platforms || []).find((item) => item.platform === platform) || {};
  return {
    target: platform,
    id: post._id || post.id || '',
    status: entry.status || post.status || '',
    url: entry.platformPostUrl || entry.url || '',
    error: entry.error || entry.errorMessage || '',
  };
}
