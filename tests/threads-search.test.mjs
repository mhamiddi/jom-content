import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/threads-search.js';

function kvStore(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    async get(key, options = {}) {
      const raw = values.get(key);
      if (raw == null) return null;
      if (options.type === 'json') return JSON.parse(raw);
      return raw;
    },
    async put(key, value) { values.set(key, typeof value === 'string' ? value : JSON.stringify(value)); },
  };
}

function env() {
  return {
    HERA_THREADS_SEARCH_TOKEN: 'hera-token',
    THREADS_API_BASE: 'https://graph.threads.net/v1.0',
    JOM_CONTENT: kvStore({ threads_accounts: JSON.stringify([{ id: 't1', userId: '999', username: 'hamiddi_', token: 'thread-token', refreshedAt: new Date().toISOString(), isDefault: true }]) }),
  };
}

test('threads search requires Hera token and returns redacted public results', async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    calls.push(parsed);
    return new Response(JSON.stringify({ data: [{ id: 'p1', text: 'agentic AI', username: 'someone', permalink: 'https://threads.com/p/p1' }], paging: { next: 'cursor' } }), { status: 200 });
  };
  const response = await onRequest({ request: new Request('https://x.com/api/threads-search?q=agentic%20AI&search_type=RECENT&limit=10', { headers: { Authorization: 'Bearer hera-token' } }), env: env() });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.success, true);
  assert.equal(data.posts[0].id, 'p1');
  assert.equal(JSON.stringify(data).includes('thread-token'), false);
  assert.equal(calls[0].pathname, '/v1.0/keyword_search');
  assert.equal(calls[0].searchParams.get('q'), 'agentic AI');
  assert.equal(calls[0].searchParams.get('search_type'), 'RECENT');
  assert.equal(calls[0].searchParams.get('access_token'), 'thread-token');
});

test('threads search rejects missing Hera token and invalid search type', async () => {
  const denied = await onRequest({ request: new Request('https://x.com/api/threads-search?q=x'), env: env() });
  assert.equal(denied.status, 401);
  const invalid = await onRequest({ request: new Request('https://x.com/api/threads-search?q=x&search_type=ALL', { headers: { Authorization: 'Bearer hera-token' } }), env: env() });
  assert.equal(invalid.status, 400);
});
