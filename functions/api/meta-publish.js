import { enforced, json } from '../_lib/auth.js';
import { graph, loadMeta, waitContainer } from '../_lib/meta.js';

/**
 * Publish an existing calendar post to the connected Facebook Page and/or the
 * Instagram business account linked to that Page.
 *
 * The media file itself is not stored here: the caller passes a public https URL
 * (mediaUrl) that Meta fetches. Text-only posts go to the Page feed.
 */
const STALE_LOCK_MS = 15 * 60 * 1000;

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

async function publishFacebook(record, pageToken, { caption, mediaUrl, mediaType, title }) {
  if (mediaType === 'video') {
    const created = await graph('POST', record.pageId + '/videos', {
      file_url: mediaUrl,
      description: caption,
      title: title || '',
    }, pageToken);
    let url = 'https://www.facebook.com/' + created.id;
    try {
      const video = await graph('GET', created.id, { fields: 'permalink_url' }, pageToken);
      if (video.permalink_url) url = 'https://www.facebook.com' + video.permalink_url;
    } catch { /* fall back to the numeric permalink */ }
    return { target: 'facebook', id: created.id, url, kind: 'video' };
  }
  if (mediaType === 'image') {
    const created = await graph('POST', record.pageId + '/photos', { url: mediaUrl, caption }, pageToken);
    return {
      target: 'facebook',
      id: created.id || created.post_id || '',
      url: created.post_id ? 'https://www.facebook.com/' + created.post_id : 'https://www.facebook.com/' + record.pageId,
      kind: 'photo',
    };
  }
  const created = await graph('POST', record.pageId + '/feed', { message: caption }, pageToken);
  return {
    target: 'facebook',
    id: created.id,
    url: 'https://www.facebook.com/' + created.id,
    kind: 'text',
  };
}

async function publishInstagram(record, { caption, mediaUrl, mediaType }) {
  if (!record.igId) throw new Error('Instagram business account belum disambung ke Page ni.');
  if (!mediaUrl) throw new Error('Instagram perlukan mediaUrl. Teks sahaja tak boleh dipos ke Instagram.');

  const params = mediaType === 'video'
    ? { media_type: 'REELS', video_url: mediaUrl, caption, share_to_feed: 'true' }
    : { image_url: mediaUrl, caption };
  const container = await graph('POST', record.igId + '/media', params, record.token);

  const state = await waitContainer(record.igId, container.id, record.token);
  if (state.status === 'ERROR' || state.status === 'EXPIRED') {
    throw new Error('Instagram reject media tu (' + state.status + '). Semak format video, saiz dan tempoh.');
  }
  if (state.status !== 'FINISHED') {
    return {
      target: 'instagram',
      pending: true,
      containerId: container.id,
      status: state.status,
      url: '',
      kind: mediaType,
    };
  }
  const published = await graph('POST', record.igId + '/media_publish', { creation_id: container.id }, record.token);
  let url = '';
  try {
    const media = await graph('GET', published.id, { fields: 'permalink' }, record.token);
    url = media.permalink || '';
  } catch { /* permalink is nice-to-have */ }
  return { target: 'instagram', id: published.id, url, kind: mediaType };
}

async function finishInstagram(record, containerId) {
  const state = await waitContainer(record.igId, containerId, record.token, { attempts: 15, gapMs: 2000 });
  if (state.status !== 'FINISHED') {
    return { target: 'instagram', pending: true, containerId, status: state.status, url: '' };
  }
  const published = await graph('POST', record.igId + '/media_publish', { creation_id: containerId }, record.token);
  let url = '';
  try {
    const media = await graph('GET', published.id, { fields: 'permalink' }, record.token);
    url = media.permalink || '';
  } catch { /* ignore */ }
  return { target: 'instagram', id: published.id, url };
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.JOM_CONTENT) return json({ success: false, error: 'KV binding not available' }, 500);
  const url = new URL(request.url);
  const locked = enforced(env);

  if (request.method === 'GET') {
    const record = await loadMeta(env);
    return json({
      success: true,
      locked,
      configured: Boolean(record && record.token),
      pageId: record?.pageId || '',
      pageName: record?.pageName || '',
      igId: record?.igId || '',
      igUsername: record?.igUsername || '',
    });
  }
  if (!locked) return json({ success: false, error: 'lock_off', message: 'API lock belum aktif, butang Post dimatikan.' }, 403);
  if (request.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405);

  const record = await loadMeta(env);
  if (!record || !record.token) return json({ success: false, error: 'not_configured', message: 'Tiada Page/Instagram yang disambung.' }, 409);

  let body = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const action = String(url.searchParams.get('action') || '').trim();

  if (action === 'finish') {
    const containerId = String(body.containerId || url.searchParams.get('containerId') || '').trim();
    if (!containerId) return json({ success: false, error: 'containerId required' }, 400);
    try {
      const result = await finishInstagram(record, containerId);
      return json({ success: !result.pending, ...result });
    } catch (error) {
      return json({ success: false, error: 'publish_failed', message: String(error.message || error).slice(0, 300) }, 502);
    }
  }

  const postId = String(url.searchParams.get('id') || body.id || '').trim();
  if (!postId) return json({ success: false, error: 'id required' }, 400);
  if (typeof body.caption !== 'string' || !body.caption.trim()) {
    return json({ success: false, error: 'caption required', message: 'Caption yang dipaparkan mesti dihantar.' }, 400);
  }

  const posts = (await env.JOM_CONTENT.get('posts', { type: 'json' })) || [];
  const post = posts.find((item) => item.id === postId);
  if (!post) return json({ success: false, error: 'Post not found', message: 'Post belum disimpan ke server. Simpan dulu.' }, 404);
  if (body.caption.trim() !== String(post.caption || '').trim()) {
    return json({ success: false, error: 'stale', message: 'Caption di server lain dari yang kau nampak. Refresh dashboard dulu.' }, 409);
  }
  if (post.status === 'rejected') return json({ success: false, error: 'rejected', message: 'Post ni berstatus rejected.' }, 422);

  const targets = Array.isArray(body.targets) && body.targets.length
    ? body.targets.map((t) => String(t).toLowerCase()).filter((t) => t === 'facebook' || t === 'instagram')
    : ['facebook', 'instagram'];
  if (!targets.length) return json({ success: false, error: 'no_targets' }, 400);

  const mediaUrl = httpUrl(body.mediaUrl || post.mediaUrl);
  const mediaType = ['video', 'image', 'text'].includes(body.mediaType)
    ? body.mediaType
    : (post.mediaType || (mediaUrl ? 'video' : 'text'));
  if (targets.includes('instagram') && !mediaUrl) {
    return json({ success: false, error: 'media_required', message: 'Instagram perlukan URL media (video/gambar).' }, 422);
  }

  const lockKey = 'meta_publish:' + postId;
  const prior = await env.JOM_CONTENT.get(lockKey, { type: 'json' });
  if (prior) {
    const fresh = Date.now() - Date.parse(prior.startedAt || 0) < STALE_LOCK_MS;
    if (prior.state === 'published') {
      return json({ success: false, error: 'already_posted', message: 'Post ni dah diposkan ke Meta.', results: prior.results || [] }, 409);
    }
    if (prior.state === 'publishing' && fresh) {
      return json({ success: false, error: 'in_progress', message: 'Post ni sedang diterbitkan ke Meta.' }, 409);
    }
    if ((prior.results || []).some((r) => r.id)) {
      return json({ success: false, error: 'partial', message: 'Sebahagian dah keluar. Semak Page/Instagram dan jangan ulang.', results: prior.results }, 409);
    }
  }

  const recordLock = { state: 'publishing', startedAt: new Date().toISOString(), targets, results: [] };
  await env.JOM_CONTENT.put(lockKey, JSON.stringify(recordLock));

  const results = [];
  let pageToken = '';
  try {
    if (targets.includes('facebook')) {
      const page = await graph('GET', record.pageId, { fields: 'access_token' }, record.token);
      pageToken = page.access_token || '';
      if (!pageToken) throw new Error('Tak dapat page access token. Semak semula sambungan Page.');
      results.push(await publishFacebook(record, pageToken, { caption: post.caption, mediaUrl, mediaType, title: post.title }));
      recordLock.results = results;
      await env.JOM_CONTENT.put(lockKey, JSON.stringify(recordLock));
    }
    if (targets.includes('instagram')) {
      results.push(await publishInstagram(record, { caption: post.caption, mediaUrl, mediaType }));
      recordLock.results = results;
      await env.JOM_CONTENT.put(lockKey, JSON.stringify(recordLock));
    }
  } catch (error) {
    recordLock.state = 'failed';
    recordLock.error = String(error.message || error).slice(0, 300);
    recordLock.results = results;
    await env.JOM_CONTENT.put(lockKey, JSON.stringify(recordLock));
    const done = results.filter((r) => r.id);
    return json({
      success: false,
      error: done.length ? 'partial' : 'publish_failed',
      results,
      message: done.length
        ? 'Sebahagian dah keluar: ' + done.map((r) => r.target).join(', ') + '. Yang gagal: ' + recordLock.error + '. Semak Page/Instagram, jangan ulang.'
        : 'Gagal post: ' + recordLock.error,
    }, 502);
  }

  const pending = results.some((r) => r.pending);
  recordLock.state = pending ? 'publishing' : 'published';
  recordLock.publishedAt = new Date().toISOString();
  recordLock.results = results;
  await env.JOM_CONTENT.put(lockKey, JSON.stringify(recordLock));

  if (!pending) {
    const fresh = (await env.JOM_CONTENT.get('posts', { type: 'json' })) || [];
    const index = fresh.findIndex((item) => item.id === postId);
    if (index !== -1) {
      const now = mytNow();
      const existing = Array.isArray(fresh[index].metaPublications) ? fresh[index].metaPublications : [];
      const stamped = results.map((r) => ({ ...r, publishedAt: recordLock.publishedAt }));
      Object.assign(fresh[index], {
        metaPublications: [...existing.filter((item) => !results.some((r) => r.target === item.target)), ...stamped],
        metaPublishedAt: recordLock.publishedAt,
        updatedAt: recordLock.publishedAt,
        notes: (fresh[index].notes ? fresh[index].notes + '\n' : '') + 'PUBLISHED to ' + results.map((r) => r.target).join(' + ') + ' ' + now.date + ' ' + now.time + ' MYT.',
      });
      await env.JOM_CONTENT.put('posts', JSON.stringify(fresh));
    }
  }

  return json({
    success: !pending,
    pending,
    results,
    page: { id: record.pageId, name: record.pageName },
    instagram: { id: record.igId, username: record.igUsername },
  });
}
