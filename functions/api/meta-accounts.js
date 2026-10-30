import { enforced, json } from '../_lib/auth.js';
import { clearMeta, graph, loadMeta, publicMeta, saveMeta } from '../_lib/meta.js';

/**
 * Connected Facebook Page / Instagram business account.
 * The access token is stored in KV and never returned to the browser.
 */
export async function onRequest(context) {
  const { request, env } = context;
  if (!env.JOM_CONTENT) return json({ success: false, error: 'KV binding not available' }, 500);
  const locked = enforced(env);

  if (request.method === 'GET') {
    const record = locked ? await loadMeta(env) : null;
    return json({ success: true, locked, ...publicMeta(record) });
  }
  if (!locked) return json({ success: false, error: 'lock_off', message: 'API lock belum aktif.' }, 403);

  if (request.method === 'PUT') {
    let body = {};
    try { body = await request.json(); } catch { /* handled below */ }
    const token = String(body.token || '').trim();
    const pageId = String(body.pageId || '').trim();
    if (!token) return json({ success: false, error: 'token required' }, 400);
    if (!pageId) return json({ success: false, error: 'pageId required' }, 400);

    let page;
    try {
      page = await graph('GET', pageId, { fields: 'id,name,instagram_business_account{id,username}' }, token);
    } catch (error) {
      return json({ success: false, error: 'token_rejected', message: String(error.message || error).slice(0, 300) }, 400);
    }

    const ig = page.instagram_business_account || {};
    const igId = String(body.igId || ig.id || '').trim();
    const record = {
      pageId: String(page.id || pageId),
      pageName: page.name || '',
      igId,
      igUsername: ig.username || String(body.igUsername || ''),
      token,
      updatedAt: new Date().toISOString(),
    };
    await saveMeta(env, record);
    return json({ success: true, ...publicMeta(record) });
  }

  if (request.method === 'DELETE') {
    const record = await loadMeta(env);
    if (!record) return json({ success: false, error: 'not_configured' }, 404);
    await clearMeta(env);
    return json({ success: true, removed: publicMeta(record).pageName || '' });
  }

  return json({ success: false, error: 'method not allowed' }, 405);
}
