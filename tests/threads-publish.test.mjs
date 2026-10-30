import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/threads-publish.js';

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

function account() {
  return {
    id: 'threads-1',
    userId: '999',
    username: 'hamiddi_',
    token: 'th-token',
    refreshedAt: new Date().toISOString(),
  };
}

function stubThreads({ containerStatus = 'FINISHED' } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace('/v1.0', '');
    const params = init.method === 'GET'
      ? Object.fromEntries(parsed.searchParams.entries())
      : Object.fromEntries(new URLSearchParams(init.body || '').entries());
    calls.push({ path, method: init.method || 'GET', params });
    let body = {};
    if (path.endsWith('/threads') && init.method === 'POST') body = { id: 'container-1' };
    else if (path.endsWith('/threads_publish')) body = { id: 'media-1' };
    else if (path.endsWith('/media-1')) body = { permalink: 'https://www.threads.com/@hamiddi_/post/media-1' };
    else body = { status: containerStatus };
    return { ok: true, status: 200, json: async () => body };
  };
  return calls;
}

function post(overrides = {}) {
  return { id: 'p1', platform: 'tiktok', title: 'Tajuk', caption: 'Caption video.', status: 'draft', ...overrides };
}

function run(body, postRecord) {
  const record = postRecord || { ...post(), caption: body.caption };
  const kv = kvStore({ posts: JSON.stringify([record]), threads_accounts: JSON.stringify([account()]) });
  return onRequest({
    request: new Request('https://x.com/api/threads-publish?id=p1', { method: 'POST', body: JSON.stringify(body) }),
    env: { JOM_API_TOKEN: 't', JOM_CONTENT: kv, THREADS_API_BASE: 'https://graph.threads.net/v1.0' },
  }).then(async (res) => ({ res, data: await res.json(), kv }));
}

test('threads media publish builds a VIDEO container with the media url', async () => {
  const calls = stubThreads();
  const { res, data } = await run({
    caption: 'Caption video.',
    mediaUrl: 'https://media.jom-content.com/media/2026/10/c1131_style3_fb.mp4',
    mediaType: 'video',
  });
  assert.equal(res.status, 200);
  assert.equal(data.success, true);
  const create = calls.find((c) => c.path.endsWith('/threads') && c.method === 'POST');
  assert.equal(create.params.media_type, 'VIDEO');
  assert.equal(create.params.video_url, 'https://media.jom-content.com/media/2026/10/c1131_style3_fb.mp4');
  assert.equal(create.params.text, 'Caption video.');
});

test('threads image publish builds an IMAGE container', async () => {
  const calls = stubThreads();
  await run({ caption: 'Gambar.', mediaUrl: 'https://media.jom-content.com/a.jpg', mediaType: 'image' });
  const create = calls.find((c) => c.path.endsWith('/threads') && c.method === 'POST');
  assert.equal(create.params.media_type, 'IMAGE');
  assert.equal(create.params.image_url, 'https://media.jom-content.com/a.jpg');
});

test('a media publish ignores chain separators and posts a single container', async () => {
  const calls = stubThreads();
  const { data } = await run(
    { caption: 'Satu.\n---\nDua.', mediaUrl: 'https://media.jom-content.com/a.mp4', mediaType: 'video' },
    { ...post(), platform: 'threads', caption: 'Satu.\n---\nDua.' },
  );
  assert.equal(data.parts, 1);
  assert.equal(calls.filter((c) => c.path.endsWith('/threads') && c.method === 'POST').length, 1);
});

test('a non-threads post still cannot publish as text-only Threads', async () => {
  stubThreads();
  const { res, data } = await run({ caption: 'Caption video.' });
  assert.equal(res.status, 422);
  assert.equal(data.error, 'not_threads');
});
