import { safeEqual } from '../_lib/auth.js';
import { json } from '../_lib/auth.js';
import { loadAccounts, maybeRefresh, resolveAccount, saveAccounts, threads } from '../_lib/threads.js';

const DEFAULT_FIELDS = ['id', 'text', 'username', 'timestamp', 'permalink'];
const ALLOWED_FIELDS = new Set(['id', 'text', 'username', 'timestamp', 'permalink', 'media_type', 'media_url', 'shortcode']);
const SEARCH_TYPES = new Set(['TOP', 'RECENT']);

async function authorisedHera(request, env) {
  const configured = String(env.HERA_THREADS_SEARCH_TOKEN || '');
  const header = request.headers.get('Authorization') || '';
  if (!configured || !header.startsWith('Bearer ')) return false;
  return safeEqual(header.slice(7), configured, configured);
}

function cleanFields(raw) {
  const fields = String(raw || '').split(',').map((field) => field.trim()).filter((field) => ALLOWED_FIELDS.has(field));
  return fields.length ? [...new Set(fields)] : DEFAULT_FIELDS;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'GET') return json({ success: false, error: 'method not allowed' }, 405);
  if (!(await authorisedHera(request, env))) return json({ success: false, error: 'unauthorized' }, 401);
  if (!env.JOM_CONTENT) return json({ success: false, error: 'KV binding not available' }, 500);

  const url = new URL(request.url);
  const query = String(url.searchParams.get('q') || '').trim();
  if (!query || query.length > 200) return json({ success: false, error: 'q required (1-200 characters)' }, 400);
  const searchType = String(url.searchParams.get('search_type') || 'RECENT').toUpperCase();
  if (!SEARCH_TYPES.has(searchType)) return json({ success: false, error: 'search_type must be TOP or RECENT' }, 400);
  const requestedLimit = Number(url.searchParams.get('limit') || 25);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(50, Math.floor(requestedLimit))) : 25;
  const accountId = String(url.searchParams.get('accountId') || '').trim();

  const accounts = await loadAccounts(env);
  const selected = resolveAccount(accounts, accountId);
  if (!selected?.token) return json({ success: false, error: 'threads_not_configured' }, 409);
  const refreshed = await maybeRefresh(env, selected);
  if (refreshed.changed) await saveAccounts(env, accounts.map((account) => account.id === selected.id ? refreshed.account : account));

  try {
    const data = await threads(env, 'GET', '/keyword_search', {
      q: query,
      search_type: searchType,
      fields: cleanFields(url.searchParams.get('fields')) .join(','),
      limit: String(limit),
      access_token: refreshed.account.token,
    });
    return json({
      success: true,
      source: 'threads_api',
      retrieved_at: new Date().toISOString(),
      query,
      search_type: searchType,
      account: { id: refreshed.account.id, username: refreshed.account.username },
      posts: Array.isArray(data.data) ? data.data : [],
      paging: {
        cursors: data.paging?.cursors || {},
        has_next: Boolean(data.paging?.next),
        has_previous: Boolean(data.paging?.previous),
      },
    });
  } catch (error) {
    return json({ success: false, source: 'threads_api', error: String(error.message || error).slice(0, 300) }, 502);
  }
}
