import { enforced, json } from '../_lib/auth.js';
import { loadAccounts, maybeRefresh, publicAccount, resolveAccount, saveAccounts, threads } from '../_lib/threads.js';

const MAX_PART = 500;
const MAX_PARTS = 10;
const STALE_LOCK_MS = 15 * 60 * 1000;

function splitParts(caption) {
  return String(caption || '').split(/\n\s*---\s*\n/).map((part) => part.trim()).filter(Boolean);
}

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

async function waitReady(env, token, creationId, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    try {
      const status = await threads(env, 'GET', '/' + creationId, { fields: 'status,error_message', access_token: token });
      if (!status.status || status.status === 'FINISHED') return;
      if (status.status === 'ERROR' || status.status === 'EXPIRED') {
        throw new Error('container ' + status.status + (status.error_message ? ': ' + status.error_message : ''));
      }
    } catch (error) {
      if (/container (ERROR|EXPIRED)/.test(error.message)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function accountIdFrom(url, body = {}) {
  return String(url.searchParams.get('accountId') || body.accountId || '').trim();
}

function publicationFor(post, accountId) {
  return Array.isArray(post.publishedAccounts)
    ? post.publishedAccounts.find((item) => item && item.accountId === accountId)
    : null;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.JOM_CONTENT) return json({ success: false, error: 'KV binding not available' }, 500);
  const url = new URL(request.url);
  const locked = enforced(env);

  if (request.method === 'GET') {
    const accounts = locked ? await loadAccounts(env) : [];
    const selected = resolveAccount(accounts, String(url.searchParams.get('accountId') || '').trim());
    return json({
      success: true,
      locked,
      configured: Boolean(selected),
      accountId: selected?.id || '',
      userId: selected?.userId || '',
      username: selected?.username || '',
      refreshedAt: selected?.refreshedAt || '',
      refreshError: selected?.refreshError || '',
      accounts: accounts.map(publicAccount),
    });
  }
  if (!locked) return json({ success: false, error: 'lock_off', message: 'API lock belum aktif, butang Post dimatikan.' }, 403);
  if (request.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405);

  const postId = url.searchParams.get('id');
  if (!postId) return json({ success: false, error: 'id required' }, 400);
  let body = {};
  try { body = await request.json(); } catch { /* handled below */ }
  if (typeof body.caption !== 'string' || !body.caption.trim()) return json({ success: false, error: 'caption required', message: 'Caption yang dipaparkan mesti dihantar.' }, 400);

  let accounts = await loadAccounts(env);
  let auth = resolveAccount(accounts, accountIdFrom(url, body));
  if (!auth) return json({ success: false, error: 'not_configured', message: 'Tiada account Threads yang disambung.' }, 409);
  const refreshed = await maybeRefresh(env, auth);
  auth = refreshed.account;
  if (refreshed.changed) {
    accounts = accounts.map((account) => account.id === auth.id ? auth : account);
    await saveAccounts(env, accounts);
  }

  const posts = (await env.JOM_CONTENT.get('posts', { type: 'json' })) || [];
  const post = posts.find((item) => item.id === postId);
  if (!post) return json({ success: false, error: 'Post not found', message: 'Post belum disimpan ke server. Simpan dulu.' }, 404);
  if (body.caption.trim() !== String(post.caption || '').trim()) return json({ success: false, error: 'stale', message: 'Caption di server lain dari yang kau nampak. Refresh dashboard dulu.' }, 409);
  const mediaUrl = httpUrl(body.mediaUrl);
  const mediaKind = String(body.mediaType || '').toLowerCase();
  const withMedia = Boolean(mediaUrl) && (mediaKind === 'video' || mediaKind === 'image');
  if (post.platform !== 'threads' && !withMedia) return json({ success: false, error: 'not_threads', message: 'Post ni bukan untuk Threads.' }, 422);
  if (post.status === 'rejected') return json({ success: false, error: 'rejected', message: 'Post ni berstatus rejected.' }, 422);

  const previousPublication = publicationFor(post, auth.id);
  if (previousPublication) return json({ success: false, error: 'already_posted', message: `Post ni dah diposkan ke @${auth.username || 'Threads'}.`, urls: previousPublication.urls || [] }, 409);
  if (post.platform === 'threads' && !Array.isArray(post.publishedAccounts) && (post.status === 'posted' || post.postedUrl)) {
    return json({ success: false, error: 'already_posted', message: 'Post ni dah diposkan. Rekod account lama belum boleh diulang.' }, 409);
  }

  const parts = withMedia ? [String(post.caption || '').trim()] : splitParts(post.caption);
  if (!parts.length) return json({ success: false, error: 'empty', message: 'Caption kosong.' }, 422);
  if (parts.length > MAX_PARTS) return json({ success: false, error: 'too_many_parts', message: `Maksimum ${MAX_PARTS} bahagian.` }, 422);
  const tooLong = parts.findIndex((part) => [...part].length > MAX_PART);
  if (tooLong !== -1) return json({ success: false, error: 'too_long', message: `Bahagian ${tooLong + 1} melebihi ${MAX_PART} aksara.` }, 422);

  const lockKey = `threads_publish:${auth.id}:${postId}`;
  const prior = await env.JOM_CONTENT.get(lockKey, { type: 'json' });
  if (prior) {
    const fresh = Date.now() - Date.parse(prior.startedAt || 0) < STALE_LOCK_MS;
    if (prior.state === 'published') return json({ success: false, error: 'already_posted', message: 'Post ni dah diposkan.', urls: prior.urls || [] }, 409);
    if (prior.state === 'publishing' && fresh) return json({ success: false, error: 'in_progress', message: 'Post ni sedang diterbitkan.' }, 409);
    if ((prior.urls || []).length) return json({ success: false, error: 'partial', message: 'Sebahagian chain dah keluar. Semak Threads dan jangan ulang.', urls: prior.urls }, 409);
  }

  const record = { state: 'publishing', accountId: auth.id, username: auth.username, startedAt: new Date().toISOString(), total: parts.length, urls: [], ids: [] };
  await env.JOM_CONTENT.put(lockKey, JSON.stringify(record));

  try {
    for (let i = 0; i < parts.length; i++) {
      const create = withMedia
        ? {
            media_type: mediaKind === 'video' ? 'VIDEO' : 'IMAGE',
            text: parts[i],
            access_token: auth.token,
            ...(mediaKind === 'video' ? { video_url: mediaUrl } : { image_url: mediaUrl }),
          }
        : { media_type: 'TEXT', text: parts[i], access_token: auth.token };
      if (i > 0) create.reply_to_id = record.ids[i - 1];
      const container = await threads(env, 'POST', `/${auth.userId}/threads`, create);
      await waitReady(env, auth.token, container.id, withMedia ? 20 : 8);
      const published = await threads(env, 'POST', `/${auth.userId}/threads_publish`, { creation_id: container.id, access_token: auth.token });
      record.ids.push(published.id);
      let link = '';
      try { link = (await threads(env, 'GET', '/' + published.id, { fields: 'permalink', access_token: auth.token })).permalink || ''; } catch { /* permalink is nice-to-have */ }
      record.urls.push(link);
      await env.JOM_CONTENT.put(lockKey, JSON.stringify(record));
    }
  } catch (error) {
    record.state = 'failed';
    record.error = String(error.message || error).replace(auth.token, '[token]').slice(0, 300);
    await env.JOM_CONTENT.put(lockKey, JSON.stringify(record));
    const partial = record.ids.length > 0;
    if (partial) {
      const current = (await env.JOM_CONTENT.get('posts', { type: 'json' })) || [];
      const index = current.findIndex((item) => item.id === postId);
      if (index !== -1) {
        current[index].notes = (current[index].notes ? current[index].notes + '\n' : '') + `PARTIAL PUBLISH @${auth.username || auth.id} ${new Date().toISOString()}: bahagian ${record.ids.length === 1 ? '1' : '1-' + record.ids.length} dari ${parts.length} dah keluar (${record.urls.filter(Boolean).join(' ')}). Semak Threads, jangan ulang.`;
        await env.JOM_CONTENT.put('posts', JSON.stringify(current));
      }
    }
    return json({
      success: false,
      error: partial ? 'partial' : 'publish_failed',
      published: record.ids.length,
      total: parts.length,
      urls: record.urls,
      accountId: auth.id,
      username: auth.username,
      message: partial
        ? `Bahagian ${record.ids.length === 1 ? '1' : '1-' + record.ids.length} dah keluar, bahagian ${record.ids.length + 1} gagal: ${record.error}. Semak Threads, jangan ulang.`
        : `Gagal post: ${record.error}`,
    }, 502);
  }

  record.state = 'published';
  record.publishedAt = new Date().toISOString();
  await env.JOM_CONTENT.put(lockKey, JSON.stringify(record));

  const fresh = (await env.JOM_CONTENT.get('posts', { type: 'json' })) || [];
  const index = fresh.findIndex((item) => item.id === postId);
  const now = mytNow();
  if (index !== -1) {
    const existing = Array.isArray(fresh[index].publishedAccounts) ? fresh[index].publishedAccounts : [];
    const publishedAccounts = [...existing.filter((item) => item.accountId !== auth.id), {
      accountId: auth.id,
      userId: auth.userId,
      username: auth.username,
      ids: record.ids,
      urls: record.urls,
      publishedAt: record.publishedAt,
    }];
    Object.assign(fresh[index], {
      status: 'posted',
      approved: true,
      date: now.date,
      time: now.time,
      actualContent: post.caption,
      actualUpdatedAt: record.publishedAt,
      updatedAt: record.publishedAt,
      publishedAccounts,
      postedUrl: fresh[index].postedUrl || record.urls[0] || '',
      notes: (fresh[index].notes ? fresh[index].notes + '\n' : '') + `PUBLISHED via dashboard to @${auth.username || auth.id} ${now.date} ${now.time} MYT (${parts.length} bahagian).`,
    });
    await env.JOM_CONTENT.put('posts', JSON.stringify(fresh));
  }
  return json({ success: true, parts: parts.length, accountId: auth.id, username: auth.username, urls: record.urls, postedUrl: record.urls[0] || '', date: now.date, time: now.time });
}
