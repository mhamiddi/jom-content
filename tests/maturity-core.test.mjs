import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalPostStatus, transitionPost } from '../functions/_lib/post-state.js';
import { mergePublications } from '../functions/_lib/publications.js';
import { listProviderCapabilities } from '../functions/_lib/provider-registry.js';
import { onRequest as health } from '../functions/api/health.js';

test('post state machine records a valid publishing lifecycle', () => {
  const publishing = transitionPost({ id: 'p1', status: 'draft' }, 'publishing', { platform: 'threads' });
  const posted = transitionPost(publishing, 'posted', { platform: 'threads' });
  assert.equal(posted.status, 'posted');
  assert.equal(posted.statusHistory.length, 2);
  assert.equal(posted.statusHistory[0].to, 'publishing');
  assert.equal(posted.statusHistory[1].to, 'posted');
});

test('invalid post status and transition fail closed', () => {
  assert.equal(canonicalPostStatus('published'), 'posted');
  assert.equal(canonicalPostStatus('Done'), 'posted');
  assert.throws(() => canonicalPostStatus('unknown'), /invalid_post_status/);
  assert.throws(() => transitionPost({ status: 'rejected' }, 'posted'), /invalid_post_transition/);
  assert.throws(() => transitionPost({ status: 'posted' }, 'draft'), /invalid_post_transition/);
});

test('publication records are normalized and deduplicated by target account', () => {
  const merged = mergePublications(
    [{ platform: 'threads', accountId: 'a1', externalId: 'old', url: 'https://old' }],
    [
      { target: 'threads', accountId: 'a1', id: 'part-1', url: 'https://new/1' },
      { target: 'threads', accountId: 'a1', id: 'part-2', url: 'https://new/2' },
    ],
  );
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.slice(1).map((item) => item.externalId), ['part-1', 'part-2']);
  assert.equal(merged[0].platform, 'threads');
});

test('provider registry exposes only public capabilities', () => {
  const providers = listProviderCapabilities();
  assert.deepEqual(providers.map((item) => item.id), ['threads', 'meta', 'zernio']);
  assert.equal(providers.some((item) => Object.keys(item).some((key) => /token|secret|key/i.test(key))), false);
});

test('health endpoint is public and does not expose secrets', async () => {
  const response = await health({ env: { JOM_CONTENT: {}, THREADS_GUARD: {}, SECRET_TOKEN: 'must-not-appear' } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.bindings.kv, true);
  assert.equal(JSON.stringify(body).includes('must-not-appear'), false);
});

test('health endpoint reports missing KV as degraded', async () => {
  const response = await health({ env: {} });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.status, 'degraded');
  assert.equal(body.bindings.kv, false);
});
