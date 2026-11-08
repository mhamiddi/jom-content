import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const require = createRequire('/home/hamiddi/.hermes/cache/scratch/threads-approval-tools/package.json');
const { Miniflare } = require('miniflare');
const scriptPath = resolve('workers/threads-publish-guard/index.js');
const scratch = process.env.TMPDIR || '/home/hamiddi/.hermes/cache/scratch';
const digest = 'sha256:123';
const manifest = { text: 'approved', media: [{ hash: 'immutable' }] };

function start(persist) {
  return new Miniflare({ modules: true, scriptPath, compatibilityDate: '2025-04-01',
    durableObjects: { THREADS_GUARD: { className: 'ThreadsPublishGuard', useSQLite: true } },
    durableObjectsPersist: persist });
}
async function call(mf, name, path, body = {}) {
  const ns = await mf.getDurableObjectNamespace('THREADS_GUARD');
  const res = await ns.get(ns.idFromName(name)).fetch('https://internal' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

test('atomic persistent guard with concurrent claims and isolated identities', async () => {
  const dir = await mkdtemp(join(scratch, 'threads-guard-'));
  let mf = start(dir);
  const key = JSON.stringify(['account', 'post']);
  try {
    assert.equal((await mf.dispatchFetch('https://public/approve', { method: 'POST' })).status, 404);
    let r = await call(mf, key, '/claim', { digest, attemptId: 'first' });
    assert.deepEqual([r.status, r.body.error], [409, 'approval_required']);
    assert.equal((await call(mf, key, '/approve', { digest, manifest, approvedAt: '2026-01-01T00:00:00Z' })).status, 200);
    assert.equal((await call(mf, key, '/approve', { digest: 'new', manifest, approvedAt: '2026-01-01T00:00:00Z' })).status, 200);
    r = await call(mf, key, '/claim', { digest, attemptId: 'wrong' });
    assert.deepEqual([r.status, r.body.error], [409, 'approval_required']);
    const claims = await Promise.all(Array.from({ length: 32 }, (_, i) => call(mf, key, '/claim', { digest: 'new', attemptId: `attempt-${i}` })));
    assert.equal(claims.filter(x => x.status === 200).length, 1);
    const winner = claims.find(x => x.status === 200).body;
    assert.equal(winner.digest, 'new');
    assert.deepEqual(winner.manifest, manifest);
    assert.ok(claims.filter(x => x.status === 409).every(x => x.body.error === 'in_progress'));
    r = await call(mf, key, '/approve', { digest: 'replacement', manifest, approvedAt: '2099-01-01T00:00:00Z' });
    assert.deepEqual([r.status, r.body.error], [409, 'in_progress']);
    const other = JSON.stringify(['account', 'other']);
    assert.equal((await call(mf, other, '/approve', { digest, manifest, approvedAt: '2026-01-01T00:00:00Z' })).status, 200);
    assert.equal((await call(mf, other, '/claim', { digest, attemptId: 'other' })).status, 200);
    r = await call(mf, key, '/finish', { attemptId: 'wrong-owner', state: 'published', ids: ['1'], urls: ['https://example.com/1'] });
    assert.equal(r.status, 409);
    await mf.dispose();
    mf = start(dir);
    r = await call(mf, key, '/status');
    assert.equal(r.body.state, 'in_progress');
    assert.equal(r.body.attemptId, winner.attemptId);
    r = await call(mf, key, '/finish', { attemptId: winner.attemptId, state: 'uncertain', ids: [], urls: [] });
    assert.equal(r.status, 200);
    await mf.dispose();
    mf = start(dir);
    r = await call(mf, key, '/approve', { digest: 'replacement', manifest, approvedAt: '2999-01-01T00:00:00Z' });
    assert.deepEqual([r.status, r.body.error], [409, 'reconciliation_required']);
    assert.equal((await call(mf, key, '/claim', { digest: 'new', attemptId: 'retry' })).body.error, 'reconciliation_required');
    assert.equal((await call(mf, other, '/finish', { attemptId: 'other', state: 'published', ids: ['1'], urls: ['https://example.com/1'] })).status, 200);
    r = await call(mf, other, '/status');
    assert.deepEqual(r.body.ids, ['1']);
    assert.deepEqual(r.body.urls, ['https://example.com/1']);
    assert.equal((await call(mf, other, '/approve', { digest, manifest, approvedAt: '2999-01-01T00:00:00Z' })).body.error, 'already_posted');
    const account2 = JSON.stringify(['another-account', 'post']);
    assert.equal((await call(mf, account2, '/approve', { digest, manifest, approvedAt: '2026-01-01T00:00:00Z' })).status, 200);
    assert.equal((await call(mf, account2, '/claim', { digest, attemptId: 'failure' })).status, 200);
    assert.equal((await call(mf, account2, '/finish', { attemptId: 'failure', state: 'failed', ids: ['partial'], urls: [] })).body.state, 'uncertain');
    assert.equal((await call(mf, account2, '/approve', { digest, manifest, approvedAt: '2999-01-01T00:00:00Z' })).body.error, 'reconciliation_required');
    assert.equal((await call(mf, account2, '/status')).body.ids[0], 'partial');
  } finally { await mf.dispose(); await rm(dir, { recursive: true, force: true }); }
});
