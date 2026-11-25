import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as ingest } from '../functions/api/learning/reviews.js';
import { onRequest as review } from '../functions/api/threads-analysis.js';
import { makeSession } from '../functions/_lib/auth.js';
import { analysisDigest } from '../functions/_lib/analysis-review.js';

const ORIGIN = 'https://app.invalid';
const TOKEN = 'secret-api-token';
const rec = (id, post = 'Post sebenar ' + id) => ({ id, createdAt: '2026-11-20T01:00:00.000Z', classification: 'performing', generatedPost: post });

function setup(initial = {}) {
  const values = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  const kv = {
    async get(key, options) { if (!values.has(key)) return null; const v = values.get(key); return options?.type === 'json' ? JSON.parse(v) : v; },
    async put(key, value) { values.set(key, String(value)); },
    async delete(key) { values.delete(key); },
  };
  return { env: { JOM_CONTENT: kv, JOM_API_TOKEN: TOKEN, JOM_SESSION_SECRET: 'separate-owner-secret' }, values };
}

async function call(env, { method = 'GET', body, headers = {}, raw } = {}) {
  const response = await ingest({ request: new Request(ORIGIN + '/api/learning/reviews', {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  }), env });
  return { status: response.status, body: await response.json() };
}
const bearer = { Authorization: 'Bearer ' + TOKEN };

test('only the bearer token can ingest; owner sessions and wrong tokens are refused', async () => {
  const { env, values } = setup();
  assert.equal((await call(env, { method: 'PUT', body: { records: [rec('ana-1')] } })).status, 403);
  assert.equal((await call(env, { method: 'PUT', body: { records: [rec('ana-1')] }, headers: { Authorization: 'Bearer wrong' } })).status, 403);
  const owner = { Cookie: 'jc_session=' + await makeSession(env), Origin: ORIGIN };
  assert.equal((await call(env, { method: 'PUT', body: { records: [rec('ana-1')] }, headers: owner })).status, 403);
  assert.equal(values.has('threads_analysis_reviews'), false);
  const { env: open } = setup(); delete open.JOM_API_TOKEN;
  assert.equal((await call(open, { method: 'PUT', body: { records: [] } })).body.error, 'lock_off');
});

test('ingest writes records only, returns server digests, and never touches decisions or edits', async () => {
  const decision = { decision: 'approved', hash: 'a'.repeat(64), decidedBy: 'owner' };
  const { env, values } = setup({ 'threads_analysis_decision:ana-1': decision, 'threads_analysis_edit:ana-1': { generatedPost: 'edit' } });
  const records = [rec('ana-1'), rec('ana-2')];
  const res = await call(env, { method: 'PUT', body: { records }, headers: bearer });
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 2);
  assert.deepEqual(res.body.records[1], { id: 'ana-2', hash: await analysisDigest(records[1], null) });
  assert.deepEqual(JSON.parse(values.get('threads_analysis_reviews')), records);
  assert.deepEqual(JSON.parse(values.get('threads_analysis_decision:ana-1')), decision);
  assert.deepEqual(JSON.parse(values.get('threads_analysis_edit:ana-1')), { generatedPost: 'edit' });
  const back = await call(env, { headers: bearer });
  assert.deepEqual(back.body, res.body);
});

test('an ingested change makes an earlier owner approval read back as stale', async () => {
  const { env } = setup();
  await call(env, { method: 'PUT', body: { records: [rec('ana-1', 'Asal')] }, headers: bearer });
  const owner = { Cookie: 'jc_session=' + await makeSession(env), Origin: ORIGIN, 'Content-Type': 'application/json' };
  const hash = await analysisDigest(rec('ana-1', 'Asal'), null);
  const ok = await review({ request: new Request(ORIGIN + '/api/threads-analysis?id=ana-1', { method: 'POST', headers: owner, body: JSON.stringify({ decision: 'approved', hash }) }), env });
  assert.equal(ok.status, 200);
  await call(env, { method: 'PUT', body: { records: [rec('ana-1', 'Diubah agen')] }, headers: bearer });
  const view = await (await review({ request: new Request(ORIGIN + '/api/threads-analysis?id=ana-1', { headers: owner }), env })).json();
  assert.equal(view.reviews[0].status, 'pending');
  assert.equal(view.reviews[0].stale, true);
});

test('invalid payloads are rejected without writing', async () => {
  const { env, values } = setup();
  const cases = [
    [{ raw: 'not json' }, 'invalid_body'],
    [{ body: { nope: 1 } }, 'invalid_body'],
    [{ body: { records: [rec('ana 1')] } }, 'invalid_record'],
    [{ body: { records: [rec('ana-1'), rec('ana-1')] } }, 'invalid_record'],
    [{ body: { records: [{ id: 'ana-1', generatedPost: '  ' }] } }, 'invalid_record'],
    [{ body: { records: [rec('ana-1', 'x'.repeat(4001))] } }, 'invalid_record'],
    [{ body: { records: Array.from({ length: 201 }, (_, i) => rec('ana-' + i)) } }, 'too_many_records'],
  ];
  for (const [opts, error] of cases) {
    const res = await call(env, { method: 'PUT', headers: bearer, ...opts });
    assert.equal(res.body.error, error, JSON.stringify(opts).slice(0, 80));
  }
  assert.equal(values.has('threads_analysis_reviews'), false);
  assert.equal((await call(env, { method: 'DELETE', headers: bearer })).status, 405);
});
