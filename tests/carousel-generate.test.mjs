import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/carousel-generate.js';

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

function r2() {
  const store = new Map();
  return {
    store,
    async put(key, value, options) {
      store.set(key, { size: value.byteLength || value.length || 0, options });
      return { key };
    },
    async head(key) {
      const item = store.get(key);
      return item ? { size: item.size } : null;
    },
  };
}

const PNG = btoa(String.fromCharCode(...new Array(64).fill(7)));

function stubOpenAI({ plan = { slides: [] } } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(init.body || '{}');
    calls.push({ path, body });
    if (path.endsWith('/chat/completions')) {
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(plan) } }] }) };
    }
    if (path.endsWith('/images/generations')) {
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: PNG }], usage: {} }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: { message: 'no route' } }) };
  };
  return calls;
}

const POST = { id: 'p1', platform: 'tiktok', title: 'Tajuk', pillar: 'Agentic AI', caption: 'Caption asal yang tak boleh berubah.' };

function env(extra = {}) {
  return {
    JOM_API_TOKEN: 't',
    OPENAI_API_KEY: 'sk-test',
    JOM_CONTENT: kvStore({ posts: JSON.stringify([POST]) }),
    JOM_MEDIA: r2(),
    MEDIA_PUBLIC_BASE: 'https://media.jom-content.com',
    ...extra,
  };
}

function call(path, body, environment) {
  return onRequest({
    request: new Request('https://x.com/api/carousel-generate' + path, {
      method: body ? 'POST' : 'GET',
      body: body ? JSON.stringify(body) : undefined,
    }),
    env: environment,
  }).then(async (res) => ({ res, data: await res.json() }));
}

test('plan stores slide copy without touching the caption', async () => {
  stubOpenAI({ plan: { slides: [
    { kicker: 'Agentic ai', headline: 'AI bukan magic', sub: 'Dia kerja ikut arahan' },
    { kicker: 'Realiti', headline: 'Data dulu', sub: '' },
  ] } });
  const e = env();
  const { res, data } = await call('?id=p1&action=plan', { count: 2 }, e);
  assert.equal(res.status, 200);
  assert.equal(data.slides.length, 2);
  assert.equal(data.slides[0].headline, 'AI BUKAN MAGIC');
  assert.equal(data.slides[0].kicker, 'AGENTIC AI');
  const posts = JSON.parse(e.JOM_CONTENT.values.get('posts'));
  assert.equal(posts[0].caption, POST.caption);
});

test('slide renders one image, uploads it to R2 and records the url', async () => {
  const calls = stubOpenAI({ plan: { slides: [
    { kicker: 'Hook', headline: 'Satu', sub: '' },
    { kicker: 'Isi', headline: 'Dua', sub: '' },
  ] } });
  const e = env();
  await call('?id=p1&action=plan', { count: 2 }, e);
  const { res, data } = await call('?id=p1&action=slide', { index: 1 }, e);
  assert.equal(res.status, 200);
  assert.equal(data.success, true);
  assert.match(data.url, /^https:\/\/media\.jom-content\.com\/media\/\d{4}\/\d{2}\/carousel-p1-1-/);
  assert.equal(e.JOM_MEDIA.store.size, 1);
  const generation = calls.find((c) => c.path.endsWith('/images/generations'));
  assert.equal(generation.body.model, 'gpt-image-2.5-flare');
  assert.equal(generation.body.size, '1024x1536');
  assert.match(generation.body.prompt, /DUA/);
  const state = JSON.parse(e.JOM_CONTENT.values.get('carousel:p1'));
  assert.equal(state.images.length, 1);
  assert.equal(state.images[0].index, 1);
});

test('slide without a plan is rejected', async () => {
  stubOpenAI();
  const { res, data } = await call('?id=p1&action=slide', { index: 0 }, env());
  assert.equal(res.status, 409);
  assert.equal(data.error, 'no_plan');
});

test('generation refuses to run without an OpenAI key', async () => {
  stubOpenAI();
  const { res, data } = await call('?id=p1&action=plan', { count: 3 }, env({ OPENAI_API_KEY: '' }));
  assert.equal(res.status, 502);
  assert.match(data.message, /OPENAI_API_KEY/);
});

test('clear wipes the stored carousel and keeps the post caption', async () => {
  stubOpenAI();
  const e = env();
  e.JOM_CONTENT.values.set('carousel:p1', JSON.stringify({ slides: [{ headline: 'X' }], images: [{ index: 0, url: 'u' }] }));
  const { data } = await call('?id=p1&action=clear', {}, e);
  assert.equal(data.success, true);
  assert.deepEqual(data.state.images, []);
  assert.equal(JSON.parse(e.JOM_CONTENT.values.get('posts'))[0].caption, POST.caption);
});
