import { enforced, json } from '../_lib/auth.js';
import { SOCIAL_PLATFORMS, configured, createPost, getPost, listAccounts, platformResult } from '../_lib/zernio.js';

/**
 * Publish an existing calendar post to TikTok and/or YouTube through Zernio.
 *
 * GET  /api/social-publish            -> which platforms are connected
 * POST /api/social-publish?id=<post>  -> body { caption, mediaUrl, mediaType, targets, mode, title }
 *
 * mode 'draft' creates the post inside Zernio without going live; 'publish'
 * pushes it to the platform immediately. Nothing here is reversible from the
 * dashboard, so the UI asks for confirmation before calling it.
 */

function mytNow() {
  const iso = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

function httpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : '';
  } catch { return ''; }
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (request.method === 'GET') {
    if (!configured(env)) {
      return json({ success: true, configured: false, accounts: [], platforms: SOCIAL_PLATFORMS });
    }
    try {
      const accounts = await listAccounts(env);
      return json({
        success: true,
        configured: true,
        platforms: SOCIAL_PLATFORMS,
        accounts: accounts.filter((a) => SOCIAL_PLATFORMS.includes(a.platform)),
      });
    } catch (error) {
      return json({ success: false, configured: true, error: 'accounts_failed', message: String(error.message || error).slice(0, 300) }, 502);
    }
  }

  if (request.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405);
  if (!enforced(env)) return json({ success: false, error: 'lock_off', message: 'API lock belum aktif.' }, 403);
  if (!configured(env)) return json({ success: false, error: 'not_configured', message: 'Zernio API key belum dipasang.' }, 503);
  if (!env.JOM_CONTENT) return json({ success: false, error: 'KV binding not available' }, 500);

  const postId = String(url.searchParams.get('id') || '').trim();
  if (!postId) return json({ success: false, error: 'id required' }, 400);

  let body = {};
  try { body = await request.json(); } catch { /* rejected below */ }

  const targets = Array.isArray(body.targets) ? body.targets.filter((t) => SOCIAL_PLATFORMS.includes(t)) : [];
  if (!targets.length) return json({ success: false, error: 'targets required', message: 'Pilih TikTok atau YouTube.' }, 400);

  const mode = body.mode === 'draft' ? 'draft' : 'publish';
  const mediaUrl = httpUrl(body.mediaUrl);
  if (!mediaUrl) return json({ success: false, error: 'media_required', message: 'TikTok dan YouTube perlukan URL media https.' }, 400);

  const posts = (await env.JOM_CONTENT.get('posts', { type: 'json' })) || [];
  const post = posts.find((item) => item.id === postId);
  if (!post) return json({ success: false, error: 'post_not_found' }, 404);

  const caption = String(body.caption || post.caption || '').trim();
  if (!caption) return json({ success: false, error: 'caption_required', message: 'Caption kosong.' }, 400);

  let accounts = [];
  try {
    accounts = await listAccounts(env);
  } catch (error) {
    return json({ success: false, error: 'accounts_failed', message: String(error.message || error).slice(0, 300) }, 502);
  }

  const platforms = [];
  for (const platform of targets) {
    const account = accounts.find((a) => a.platform === platform);
    if (!account) {
      return json({ success: false, error: 'account_missing', message: 'Tiada akaun ' + platform + ' disambung di Zernio.' }, 400);
    }
    platforms.push({ platform, accountId: account.id });
  }

  const title = String(body.title || post.title || '').trim();
  if (targets.includes('youtube') && !title && mode === 'publish') {
    return json({ success: false, error: 'title_required', message: 'YouTube perlukan tajuk.' }, 400);
  }

  const payload = {
    content: caption,
    platforms,
    mediaItems: [{ type: body.mediaType === 'image' ? 'image' : 'video', url: mediaUrl }],
    isDraft: mode === 'draft',
  };
  if (mode === 'publish') payload.publishNow = true;
  if (title) payload.title = title;

  // One stable key per post + platform set: a retry within 24h returns the same
  // Zernio post instead of a duplicate upload.
  const idempotencyKey = postId + ':' + targets.slice().sort().join('+');

  let created;
  try {
    created = await createPost(env, payload, idempotencyKey);
  } catch (error) {
    return json({ success: false, error: 'publish_failed', message: 'Zernio tolak: ' + String(error.message || error).slice(0, 300) }, 502);
  }

  const id = created._id || created.id || '';
  let final = created;
  if (id) {
    try { final = await getPost(env, id); } catch { /* keep the create response */ }
  }

  const results = targets.map((platform) => platformResult(final, platform));
  const now = mytNow();

  if (mode === 'publish' && id) {
    const fresh = (await env.JOM_CONTENT.get('posts', { type: 'json' })) || [];
    const index = fresh.findIndex((item) => item.id === postId);
    if (index !== -1) {
      const existing = Array.isArray(fresh[index].socialPublications) ? fresh[index].socialPublications : [];
      const stamped = results.map((r) => ({ ...r, publishedAt: new Date().toISOString() }));
      Object.assign(fresh[index], {
        socialPublications: [...existing.filter((item) => !targets.includes(item.target)), ...stamped],
        updatedAt: new Date().toISOString(),
        notes: (fresh[index].notes ? fresh[index].notes + '\n' : '') + 'PUBLISHED to ' + targets.join(' + ') + ' ' + now.date + ' ' + now.time + ' MYT.',
      });
      await env.JOM_CONTENT.put('posts', JSON.stringify(fresh));
    }
  }

  return json({
    success: true,
    mode,
    id,
    status: final.status || created.status || '',
    results,
    accounts: platforms.map((p) => ({ platform: p.platform, username: (accounts.find((a) => a.id === p.accountId) || {}).username || '' })),
  });
}
