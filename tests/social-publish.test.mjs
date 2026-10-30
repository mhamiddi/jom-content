import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/social-publish.js';

function kvStore(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    async get(key, options = {}) {
      const raw = values.get(key);
      if (raw == null) return null;
      if (options && options.type === 'json') {
        try { return JSON.parse(raw); } catch { return null; }
      }
      return raw;
    },
    async put(key, value) { values.set(key, typeof value === 'string' ? value : JSON.stringify(value)); },
    async delete(key) { values.delete(key); },
  };
}

const ACCOUNTS = {
  accounts: [
    { _id: 'acc-tt', platform: 'tiktok', username: 'm.hamiddi' },
    { _id: 'acc-yt', platform: 'youtube', username: 'hamiddi_jomdigital' },
    { _id: 'acc-x', platform: 'twitter', username: 'nope' },
  ],
};

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const entry = { path: parsed.pathname.replace('/api/v1', ''), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null, headers: options.headers || {} };
    calls.push(entry);
    const result = handler(entry) || {};
    return { ok: result.ok !== false, status: result.status || 200, json: async () => result.body || {} };
  };
  return calls;
}

function postRecord() {
  return { id: 'p1', title: 'Tajuk video', caption: 'Caption TikTok.', status: 'draft', platform: 'tiktok' };
}

test('social publish reports itself unconfigured without a Zernio key', async () => {
  const kv = kvStore();
  const res = await onRequest({ request: new Request('https://x.com/api/social-publish'), env: { JOM_API_TOKEN: 't', JOM_CONTENT: kv } });
  const data = await res.json();
  assert.equal(data.configured, false);
  assert.deepEqual(data.accounts, []);
});

test('social publish lists only TikTok and YouTube accounts', async () => {
  stubFetch((call) => (call.path === '/accounts' ? { body: ACCOUNTS } : {}));
  const res = await onRequest({ request: new Request('https://x.com/api/social-publish'), env: { JOM_API_TOKEN: 't', JOM_CONTENT: kvStore(), ZERNIO_API_KEY: 'z' } });
  const data = await res.json();
  assert.equal(data.configured, true);
  assert.deepEqual(data.accounts.map((a) => a.platform), ['tiktok', 'youtube']);
});

test('social publish rejects a post without a media url', async () => {
  stubFetch(() => ({ body: ACCOUNTS }));
  const kv = kvStore({ posts: JSON.stringify([postRecord()]) });
  const res = await onRequest({
    request: new Request('https://x.com/api/social-publish?id=p1', {
      method: 'POST', body: JSON.stringify({ targets: ['tiktok'], caption: 'hi', mediaUrl: '' }),
    }),
    env: { JOM_API_TOKEN: 't', JOM_CONTENT: kv, ZERNIO_API_KEY: 'z' },
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'media_required');
});

test('social publish sends a live post to Zernio with publishNow and records it', async () => {
  const calls = stubFetch((call) => {
    if (call.path === '/accounts') return { body: ACCOUNTS };
    if (call.path === '/posts' && call.method === 'POST') return { status: 201, body: { post: { _id: 'zp1', status: 'published', platforms: [{ platform: 'tiktok', status: 'published', platformPostUrl: 'https://tiktok.com/@m.hamiddi/video/1' }] } } };
    if (call.path === '/posts/zp1') return { body: { post: { _id: 'zp1', status: 'published', platforms: [{ platform: 'tiktok', status: 'published', platformPostUrl: 'https://tiktok.com/@m.hamiddi/video/1' }] } } };
    return {};
  });
  const kv = kvStore({ posts: JSON.stringify([postRecord()]) });
  const res = await onRequest({
    request: new Request('https://x.com/api/social-publish?id=p1', {
      method: 'POST', body: JSON.stringify({ targets: ['tiktok'], caption: 'Caption TikTok.', mediaUrl: 'https://media.jom-content.com/a.mp4', mode: 'publish' }),
    }),
    env: { JOM_API_TOKEN: 't', JOM_CONTENT: kv, ZERNIO_API_KEY: 'z' },
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.success, true);
  assert.equal(data.results[0].url, 'https://tiktok.com/@m.hamiddi/video/1');

  const create = calls.find((c) => c.path === '/posts' && c.method === 'POST');
  assert.equal(create.body.publishNow, true);
  assert.deepEqual(create.body.platforms, [{ platform: 'tiktok', accountId: 'acc-tt' }]);
  assert.deepEqual(create.body.mediaItems, [{ type: 'video', url: 'https://media.jom-content.com/a.mp4' }]);
  assert.equal(create.headers['Idempotency-Key'], 'p1:tiktok');
  assert.match(create.headers.Authorization, /^Bearer /);

  const stored = JSON.parse(kv.values.get('posts'))[0];
  assert.equal(stored.socialPublications[0].target, 'tiktok');
  assert.match(stored.notes, /PUBLISHED to tiktok/);
});

test('social publish in draft mode never sets publishNow', async () => {
  const calls = stubFetch((call) => {
    if (call.path === '/accounts') return { body: ACCOUNTS };
    if (call.path === '/posts' && call.method === 'POST') return { status: 201, body: { post: { _id: 'zp2', status: 'draft', platforms: [{ platform: 'youtube', status: 'pending' }] } } };
    return { body: { post: { _id: 'zp2', status: 'draft', platforms: [{ platform: 'youtube', status: 'pending' }] } } };
  });
  const kv = kvStore({ posts: JSON.stringify([postRecord()]) });
  const res = await onRequest({
    request: new Request('https://x.com/api/social-publish?id=p1', {
      method: 'POST', body: JSON.stringify({ targets: ['youtube'], caption: 'Caption.', mediaUrl: 'https://media.jom-content.com/a.mp4', title: 'Tajuk', mode: 'draft' }),
    }),
    env: { JOM_API_TOKEN: 't', JOM_CONTENT: kv, ZERNIO_API_KEY: 'z' },
  });
  const data = await res.json();
  assert.equal(data.mode, 'draft');
  const create = calls.find((c) => c.path === '/posts' && c.method === 'POST');
  assert.equal(create.body.isDraft, true);
  assert.equal(create.body.publishNow, undefined);
  assert.equal(create.body.title, 'Tajuk');
  assert.equal(JSON.parse(kv.values.get('posts'))[0].socialPublications, undefined);
});

test('social publish refuses YouTube without a title', async () => {
  stubFetch(() => ({ body: ACCOUNTS }));
  const kv = kvStore({ posts: JSON.stringify([{ ...postRecord(), title: '' }]) });
  const res = await onRequest({
    request: new Request('https://x.com/api/social-publish?id=p1', {
      method: 'POST', body: JSON.stringify({ targets: ['youtube'], caption: 'Caption.', mediaUrl: 'https://media.jom-content.com/a.mp4', mode: 'publish' }),
    }),
    env: { JOM_API_TOKEN: 't', JOM_CONTENT: kv, ZERNIO_API_KEY: 'z' },
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'title_required');
});
