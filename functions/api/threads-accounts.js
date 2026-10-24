import { enforced, json } from '../_lib/auth.js';
import { loadAccounts, maybeRefresh, publicAccount, resolveAccount, saveAccounts, threads } from '../_lib/threads.js';

function accountIdFrom(url, body = {}) {
  return String(url.searchParams.get('accountId') || body.accountId || '').trim();
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.JOM_CONTENT) return json({ success: false, error: 'KV binding not available' }, 500);
  const url = new URL(request.url);
  const locked = enforced(env);

  if (request.method === 'GET') {
    const accounts = locked ? await loadAccounts(env) : [];
    return json({ success: true, locked, accounts: accounts.map(publicAccount) });
  }
  if (!locked) return json({ success: false, error: 'lock_off', message: 'API lock belum aktif.' }, 403);

  if (request.method === 'PUT') {
    let body = {};
    try { body = await request.json(); } catch { /* handled below */ }
    const action = url.searchParams.get('action') || 'token';
    const accounts = await loadAccounts(env);

    if (action === 'default') {
      const id = accountIdFrom(url, body);
      if (!id) return json({ success: false, error: 'accountId required' }, 400);
      if (!accounts.some((account) => account.id === id || account.userId === id)) return json({ success: false, error: 'account_not_found' }, 404);
      const next = accounts.map((account) => ({ ...account, isDefault: account.id === id || account.userId === id }));
      await saveAccounts(env, next);
      return json({ success: true, accountId: id, accounts: next.map(publicAccount) });
    }

    const token = String(body.token || '').trim();
    if (!token) return json({ success: false, error: 'token required' }, 400);
    try {
      const me = await threads(env, 'GET', '/me', { fields: 'id,username', access_token: token });
      const existing = accounts.find((account) => account.userId === String(me.id));
      const nextAccount = {
        ...(existing || {}),
        id: String(me.id),
        userId: String(me.id),
        username: me.username || existing?.username || '',
        token,
        connectedAt: existing?.connectedAt || new Date().toISOString(),
        refreshedAt: new Date().toISOString(),
        refreshError: '',
        isDefault: existing ? Boolean(existing.isDefault) : accounts.length === 0 || body.default === true,
        legacy: false,
      };
      const next = accounts.filter((account) => account.userId !== nextAccount.userId);
      next.push(nextAccount);
      await saveAccounts(env, next);
      return json({ success: true, account: publicAccount(nextAccount), accounts: next.map(publicAccount) });
    } catch (error) {
      return json({ success: false, error: 'token_rejected', message: String(error.message || error).replace(token, '[token]').slice(0, 300) }, 400);
    }
  }

  if (request.method === 'DELETE') {
    const id = accountIdFrom(url);
    if (!id) return json({ success: false, error: 'accountId required' }, 400);
    const accounts = await loadAccounts(env);
    const target = accounts.find((account) => account.id === id || account.userId === id);
    if (!target) return json({ success: false, error: 'account_not_found' }, 404);
    const next = accounts.filter((account) => account.id !== target.id && account.userId !== target.userId);
    await saveAccounts(env, next);
    if (target.legacy) await env.JOM_CONTENT.delete('threads_auth');
    if (next.length && !next.some((account) => account.isDefault)) {
      next[0].isDefault = true;
      await saveAccounts(env, next);
    }
    return json({ success: true, removed: publicAccount(target), accounts: next.map(publicAccount) });
  }

  return json({ success: false, error: 'method not allowed' }, 405);
}
