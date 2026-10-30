import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/meta-publish.js';

const META = {
  pageId: '111',
  pageName: 'Test Page',
  igId: '222',
  igUsername: 'testig',
  token: 'EAAtest-token',
  updatedAt: '2026-10-30T00:00:00.000Z',
};

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

function env(kv) {
  return { JOM_API_TOKEN: 'api-token-for-test', JOM_CONTENT: kv };
}

function post(overrides = {}) {
  return {
    id: 'p1',
    platform: 'threads',
    title: 'Test post',
    caption: 'Caption panjang untuk ujian.',
    status: 'draft',
    ...overrides,
  };
}

function request(body, query = '') {
  return new Request('https://jom-content.com/api/meta-publish' + query, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Minimal Graph API stub: routes by path and records the calls. */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace('/v22.0/', '');
    calls.push({ path, method: init.method || 'GET', body: init.body || '', params: Object.fromEntries(parsed.searchParams) });
    const handler = routes[path] || routes['*'];
    if (!handler) return new Response(JSON.stringify({ error: { message: 'unexpected path ' + path } }), { status: 400 });
    const payload = typeof handler === 'function' ? handler(parsed) : handler;
    if (payload && payload.__status) {
      return new Response(JSON.stringify(payload.body || {}), { status: payload.__status });
    }
    return new Response(JSON.stringify(payload || {}), { status: 200 });
  };
  return calls;
}

test('rejects when no Page is connected', async () => {
  const kv = kvStore();
  const res = await onRequest({ request: request({ caption: 'x' }, '?id=p1'), env: env(kv) });
  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.error, 'not_configured');
});

test('publishes a text post to the Facebook Page and records it', async () => {
  const kv = kvStore({ posts: JSON.stringify([post()]), 'meta:accounts': JSON.stringify(META) });
  const calls = stubFetch({ '111/feed': { id: '111_999' } });
  const res = await onRequest({
    request: request({ caption: 'Caption panjang untuk ujian.', mediaType: 'text', targets: ['facebook'] }, '?id=p1'),
    env: env(kv),
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.success, true);
  assert.equal(data.results[0].target, 'facebook');
  assert.equal(data.results[0].id, '111_999');
  assert.ok(calls.some((c) => c.path === '111/feed' && c.method === 'POST'));
  const saved = JSON.parse(kv.values.get('posts'));
  assert.equal(saved[0].metaPublications[0].target, 'facebook');
  assert.match(saved[0].notes, /PUBLISHED to facebook/);
});

test('rejects a stale caption before touching Meta', async () => {
  const kv = kvStore({ posts: JSON.stringify([post()]), 'meta:accounts': JSON.stringify(META) });
  const calls = stubFetch({ '111/feed': { id: '111_999' } });
  const res = await onRequest({
    request: request({ caption: 'Caption lain sama sekali.' }, '?id=p1'),
    env: env(kv),
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'stale');
  assert.equal(calls.length, 0);
});

test('Instagram requires a media URL', async () => {
  const kv = kvStore({ posts: JSON.stringify([post()]), 'meta:accounts': JSON.stringify(META) });
  stubFetch({});
  const res = await onRequest({
    request: request({ caption: 'Caption panjang untuk ujian.', targets: ['instagram'] }, '?id=p1'),
    env: env(kv),
  });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error, 'media_required');
});

test('publishes a reel: container, status poll, media_publish, permalink', async () => {
  const kv = kvStore({ posts: JSON.stringify([post()]), 'meta:accounts': JSON.stringify(META) });
  const calls = stubFetch({
    '222/media': { id: 'container-1' },
    'container-1': { status_code: 'FINISHED' },
    '222/media_publish': { id: 'media-9' },
    'media-9': { permalink: 'https://www.instagram.com/reel/abc/' },
  });
  const res = await onRequest({
    request: request({
      caption: 'Caption panjang untuk ujian.',
      mediaUrl: 'https://example.com/video.mp4',
      mediaType: 'video',
      targets: ['instagram'],
    }, '?id=p1'),
    env: env(kv),
  });
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.results[0].url, 'https://www.instagram.com/reel/abc/');
  assert.ok(calls.some((c) => c.path === '222/media' && /media_type=REELS/.test(c.body)));
  assert.ok(calls.some((c) => c.path === '222/media_publish' && /creation_id=container-1/.test(c.body)));
});

test('reports a failed Instagram container instead of pretending success', async () => {
  const kv = kvStore({ posts: JSON.stringify([post()]), 'meta:accounts': JSON.stringify(META) });
  stubFetch({
    '222/media': { id: 'container-2' },
    'container-2': { status_code: 'ERROR' },
  });
  const res = await onRequest({
    request: request({
      caption: 'Caption panjang untuk ujian.',
      mediaUrl: 'https://example.com/video.mp4',
      mediaType: 'video',
      targets: ['instagram'],
    }, '?id=p1'),
    env: env(kv),
  });
  assert.equal(res.status, 502);
  const data = await res.json();
  assert.equal(data.success, false);
  assert.equal(data.error, 'publish_failed');
});

test('a second identical publish is refused by the lock', async () => {
  const kv = kvStore({
    posts: JSON.stringify([post()]),
    'meta:accounts': JSON.stringify(META),
    'meta_publish:p1': JSON.stringify({ state: 'published', startedAt: new Date().toISOString(), results: [{ target: 'facebook', id: '111_999' }] }),
  });
  stubFetch({ '111/feed': { id: '111_1000' } });
  const res = await onRequest({
    request: request({ caption: 'Caption panjang untuk ujian.', mediaType: 'text', targets: ['facebook'] }, '?id=p1'),
    env: env(kv),
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'already_posted');
});
