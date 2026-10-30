import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/media-upload.js';

function bucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, body, options = {}) {
      const size = body && typeof body === 'object' && 'size' in body ? body.size : 0;
      objects.set(key, { size, options });
      return { key, size };
    },
    async head(key) {
      const hit = objects.get(key);
      return hit ? { key, size: hit.size, httpMetadata: hit.options.httpMetadata } : null;
    },
  };
}

function upload(query, { type = 'video/mp4', length = 1024, body = { size: 1024 } } = {}) {
  return new Request('https://jom-content.com/api/media-upload' + query, {
    method: 'POST',
    headers: { 'content-type': type, 'content-length': String(length) },
    body: new Uint8Array(0),
  });
}

test('media upload refuses an unsupported mime type', async () => {
  const store = bucket();
  const env = { JOM_API_TOKEN: 't', JOM_MEDIA: store };
  const res = await onRequest({ request: upload('', { type: 'application/pdf' }), env });
  assert.equal(res.status, 415);
  assert.equal((await res.json()).error, 'unsupported_type');
  assert.equal(store.objects.size, 0);
});

test('media upload refuses files above the cap', async () => {
  const store = bucket();
  const env = { JOM_API_TOKEN: 't', JOM_MEDIA: store };
  const res = await onRequest({ request: upload('', { length: 95 * 1024 * 1024 }), env });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, 'too_large');
});

test('media upload stores the object and returns a public url', async () => {
  const store = bucket();
  const env = { JOM_API_TOKEN: 't', JOM_MEDIA: store };
  const res = await onRequest({ request: upload('?filename=clip.mp4&type=video/mp4'), env });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.success, true);
  assert.match(data.key, /^media\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.mp4$/);
  assert.equal(data.url, 'https://pub-c48bb3de52da4fe6bbf5f89e7b07271a.r2.dev/' + data.key);
  assert.equal(store.objects.size, 1);
  assert.equal(store.objects.get(data.key).options.httpMetadata.contentType, 'video/mp4');
});

test('media upload is closed when the API lock is off', async () => {
  const store = bucket();
  const res = await onRequest({ request: upload(''), env: { JOM_MEDIA: store } });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'lock_off');
});
