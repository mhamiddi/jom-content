/**
 * Meta (Facebook Page + Instagram Business) publishing helpers.
 *
 * Credentials are never stored in source. The page/IG ids and the system-user
 * access token live in the private KV namespace under META_KEYS.accounts and
 * are only ever returned to the client as metadata (never the token).
 */
export const GRAPH_VERSION = 'v22.0';
export const GRAPH = 'https://graph.facebook.com/' + GRAPH_VERSION;
export const META_KEYS = { accounts: 'meta:accounts' };

export function publicMeta(record) {
  if (!record || !record.token) return { configured: false };
  return {
    configured: true,
    pageId: record.pageId || '',
    pageName: record.pageName || '',
    igId: record.igId || '',
    igUsername: record.igUsername || '',
    updatedAt: record.updatedAt || '',
  };
}

export async function loadMeta(env) {
  if (!env || !env.JOM_CONTENT) return null;
  return (await env.JOM_CONTENT.get(META_KEYS.accounts, { type: 'json' })) || null;
}

export async function saveMeta(env, record) {
  await env.JOM_CONTENT.put(META_KEYS.accounts, JSON.stringify(record));
}

export async function clearMeta(env) {
  await env.JOM_CONTENT.delete(META_KEYS.accounts);
}

function scrub(text, token) {
  const raw = String(text == null ? '' : text);
  return token ? raw.split(token).join('[token]') : raw;
}

/** Call the Graph API and turn Meta errors into readable messages. */
export async function graph(method, path, params = {}, token) {
  const url = new URL(GRAPH + '/' + String(path).replace(/^\/+/, ''));
  const init = { method, headers: {} };
  const payload = { ...params };
  if (token) payload.access_token = token;
  if (method === 'GET') {
    for (const [key, value] of Object.entries(payload)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    init.method = 'GET';
  } else {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) {
      if (value !== undefined && value !== null && value !== '') body.set(key, String(value));
    }
    init.body = body.toString();
  }
  const response = await fetch(url.toString(), init);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 400) }; }
  if (!response.ok || (data && data.error)) {
    const detail = data && data.error
      ? [data.error.message, data.error.code ? 'code ' + data.error.code : '', data.error.error_subcode ? 'subcode ' + data.error.error_subcode : ''].filter(Boolean).join(' | ')
      : 'HTTP ' + response.status;
    const error = new Error(scrub(detail, token));
    error.status = response.status;
    error.graph = data && data.error ? data.error : null;
    throw error;
  }
  return data;
}

/**
 * Wait for an Instagram media container to leave IN_PROGRESS.
 * Returns { status, error } where status is FINISHED / IN_PROGRESS / ERROR / EXPIRED.
 */
export async function waitContainer(igId, containerId, token, { attempts = 12, gapMs = 2000 } = {}) {
  let last = 'IN_PROGRESS';
  for (let i = 0; i < attempts; i++) {
    const status = await graph('GET', containerId, { fields: 'status_code,status' }, token);
    last = status.status_code || status.status || 'IN_PROGRESS';
    if (last === 'FINISHED') return { status: last };
    if (last === 'ERROR' || last === 'EXPIRED') return { status: last, error: 'container ' + last };
    await new Promise((resolve) => setTimeout(resolve, gapMs));
  }
  return { status: last };
}
