const DEFAULT_BASE = 'https://graph.threads.net/v1.0';
export const ACCOUNTS_KEY = 'threads_accounts';
export const LEGACY_KEY = 'threads_auth';
const REFRESH_AFTER_MS = 7 * 24 * 3600 * 1000;
const MIN_REFRESH_AGE_MS = 24 * 3600 * 1000;

export const base = (env) => String(env.THREADS_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
export const root = (env) => base(env).replace(/\/v\d+(\.\d+)?$/, '');

export async function threads(env, method, path, params = {}) {
  const url = new URL(base(env) + path);
  const init = { method, headers: { Accept: 'application/json' } };
  if (method === 'GET') {
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  } else {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(params).toString();
  }
  const res = await fetch(url.toString(), init);
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok || data.error) {
    const error = data.error || {};
    throw new Error(`Threads API ${res.status}${error.code ? ' (' + error.code + ')' : ''}: ${error.message || 'request failed'}`);
  }
  return data;
}

function normalise(account) {
  if (!account || !account.token || !account.userId) return null;
  return {
    ...account,
    id: String(account.id || account.userId),
    userId: String(account.userId),
    username: String(account.username || ''),
    isDefault: Boolean(account.isDefault),
  };
}

export async function loadAccounts(env) {
  const stored = await env.JOM_CONTENT.get(ACCOUNTS_KEY, { type: 'json' });
  const accounts = Array.isArray(stored) ? stored.map(normalise).filter(Boolean) : [];
  const legacy = normalise(await env.JOM_CONTENT.get(LEGACY_KEY, { type: 'json' }));
  if (legacy && !accounts.some((account) => account.userId === legacy.userId)) {
    accounts.push({ ...legacy, id: legacy.userId, legacy: true, isDefault: accounts.length === 0 });
  }
  if (accounts.length && !accounts.some((account) => account.isDefault)) accounts[0].isDefault = true;
  return accounts;
}

export async function saveAccounts(env, accounts) {
  const clean = accounts.map(normalise).filter(Boolean);
  if (clean.length && !clean.some((account) => account.isDefault)) clean[0].isDefault = true;
  await env.JOM_CONTENT.put(ACCOUNTS_KEY, JSON.stringify(clean));
  return clean;
}

export function publicAccount(account) {
  return {
    id: account.id,
    userId: account.userId,
    username: account.username,
    connectedAt: account.connectedAt || account.refreshedAt || '',
    refreshedAt: account.refreshedAt || '',
    expiresAt: account.expiresAt || '',
    refreshError: account.refreshError || '',
    isDefault: Boolean(account.isDefault),
  };
}

export function resolveAccount(accounts, requestedId = '') {
  if (requestedId) return accounts.find((account) => account.id === requestedId || account.userId === requestedId) || null;
  return accounts.find((account) => account.isDefault) || accounts[0] || null;
}

export async function maybeRefresh(env, account) {
  const age = Date.now() - Date.parse(account.refreshedAt || 0);
  if (age < REFRESH_AFTER_MS || age < MIN_REFRESH_AGE_MS) return { account, changed: false };
  try {
    const url = new URL(root(env) + '/refresh_access_token');
    url.searchParams.set('grant_type', 'th_refresh_token');
    url.searchParams.set('access_token', account.token);
    const res = await fetch(url.toString());
    const data = await res.json();
    if (!res.ok || !data.access_token) throw new Error((data.error && data.error.message) || 'refresh failed');
    const next = {
      ...account,
      token: data.access_token,
      refreshedAt: new Date().toISOString(),
      refreshError: '',
    };
    if (data.expires_in) next.expiresAt = new Date(Date.now() + Number(data.expires_in) * 1000).toISOString();
    return { account: next, changed: true };
  } catch (error) {
    return { account: { ...account, refreshError: String(error.message || error).slice(0, 200) }, changed: true };
  }
}
