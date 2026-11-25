import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as review } from '../functions/api/threads-analysis.js';
import { makeSession } from '../functions/_lib/auth.js';
import { analysisDigest, isApproved, reviewView } from '../functions/_lib/analysis-review.js';

const ORIGIN = 'https://app.invalid';
const ID = 'ana-fixture-1';

function record(overrides = {}) {
  return {
    id: ID,
    createdAt: '2026-11-13T01:00:00.000Z',
    generatedBy: 'threads-learning-agent',
    classification: 'performing',
    generatedPost: 'Post dijana untuk ujian.',
    source: {
      type: 'threads', label: '@fixture', url: 'https://threads.invalid/post/1',
      postId: 'post-1', publishedAt: '2026-11-01T10:00:00+08:00', excerpt: 'Petikan rujukan',
    },
    metrics: { views: 41000, likes: 1800, replies: 200, reposts: 300, quotes: 60, shares: 90 },
    comparison: { metric: 'views', baselineMedian: 9000, deltaPct: 355.6, sampleDays: 30, note: 'median 30 hari' },
    evidence: [{ claim: 'Views 4.5x median', source: 'Threads insights', url: 'https://threads.invalid', value: 41000 }],
    observation: 'Pemerhatian berasaskan data.',
    hypotheses: ['Hipotesis pertama.', 'Hipotesis kedua.'],
    confidence: { level: 'high', score: 0.72, rationale: 'Data API penuh, tiada A/B.' },
    suggestion: 'Uji struktur sama pada topik baru.',
    // Deliberately hostile field: must never leak through the API allowlist.
    token: 'secret-agent-token',
    ...overrides,
  };
}

function setup(records = [record()]) {
  const values = new Map([[ 'threads_analysis_reviews', JSON.stringify(records) ]]);
  const kv = {
    async get(key, options) {
      if (!values.has(key)) return null;
      const value = values.get(key);
      return options?.type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value) { values.set(key, String(value)); },
    async delete(key) { values.delete(key); },
  };
  const env = {
    JOM_CONTENT: kv,
    JOM_API_TOKEN: 'secret-api-token',
    JOM_SESSION_SECRET: 'separate-owner-secret',
  };
  return { env, values };
}

async function call(env, { method = 'GET', id = ID, body, headers = {}, path } = {}) {
  const url = ORIGIN + '/api/threads-analysis' + (path ?? (id ? '?id=' + encodeURIComponent(id) : ''));
  const response = await review({
    request: new Request(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  });
  return { status: response.status, body: await response.json() };
}

async function ownerHeaders(env, extra = {}) {
  return { Cookie: 'jc_session=' + await makeSession(env), Origin: ORIGIN, ...extra };
}

const validHash = async (item = record(), edit = null) => {
  const digest = await analysisDigest(item, edit);
  return digest;
};

test('review reads and decisions require a distinct owner session', async () => {
  const { env } = setup();
  assert.equal((await call(env)).status, 403);
  assert.equal((await call(env, { headers: { Authorization: 'Bearer secret-api-token' } })).body.error, 'owner_session_required');

  const forged = await makeSession({ JOM_API_TOKEN: env.JOM_API_TOKEN });
  assert.equal((await call(env, { headers: { Cookie: 'jc_session=' + forged } })).status, 403);

  const headers = await ownerHeaders(env);
  const listed = await call(env, { headers });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.reviews.length, 1);
  assert.equal(listed.body.reviews[0].hash.length, 64);

  delete env.JOM_SESSION_SECRET;
  assert.equal((await call(env, { headers })).body.error, 'owner_session_not_configured');
  env.JOM_SESSION_SECRET = env.JOM_API_TOKEN;
  assert.equal((await call(env, { headers })).body.error, 'owner_session_not_configured');
});

test('an agent bearer token can never record a decision, even with a valid hash', async () => {
  const { env } = setup();
  const hash = await validHash();
  let posts = 0;
  globalThis.fetch = async () => { posts += 1; throw new Error('publishing must not be reachable from review'); };
  const result = await call(env, {
    method: 'POST',
    headers: { Authorization: 'Bearer secret-api-token' },
    body: { decision: 'approved', hash },
  });
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'agent_approval_forbidden');
  assert.equal(posts, 0);
});

test('mutations reject missing or foreign Origin and untouched storage', async () => {
  const { env, values } = setup();
  const hash = await validHash();
  const cookie = 'jc_session=' + await makeSession(env);
  const cross = await call(env, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.invalid' }, body: { decision: 'approved', hash } });
  assert.equal(cross.status, 403);
  assert.equal(cross.body.error, 'cross_origin');
  const missing = await call(env, { method: 'POST', headers: { Cookie: cookie }, body: { decision: 'approved', hash } });
  assert.equal(missing.body.error, 'cross_origin');
  assert.equal(values.size, 1);
});

test('approval is bound to the exact server hash and editing invalidates it', async () => {
  const { env, values } = setup();
  const headers = await ownerHeaders(env);
  const initial = (await call(env, { headers })).body.reviews[0];

  const wrong = await call(env, { method: 'POST', headers, body: { decision: 'approved', hash: 'a'.repeat(64) } });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.error, 'stale_hash');

  const approved = await call(env, { method: 'POST', headers, body: { decision: 'approved', hash: initial.hash } });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.review.status, 'approved');
  assert.equal(approved.body.review.stale, false);
  assert.equal(isApproved(approved.body.review), true);
  assert.equal(JSON.parse(values.get('threads_analysis_decision:' + ID)).hash, initial.hash);

  const edited = await call(env, { method: 'PATCH', headers, body: { generatedPost: 'Post dijana yang diedit pemilik.' } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.review.hash === initial.hash, false);
  assert.equal(edited.body.review.status, 'pending');
  assert.equal(edited.body.review.stale, true);
  assert.equal(edited.body.review.ownerEdited, true);
  assert.equal(isApproved(edited.body.review), false);

  // The old approval still exists for audit, but it cannot approve the new text.
  const replay = await call(env, { method: 'POST', headers, body: { decision: 'approved', hash: initial.hash } });
  assert.equal(replay.status, 409);
  assert.equal(replay.body.error, 'stale_hash');
  assert.equal(replay.body.hash, edited.body.review.hash);

  const reapproved = await call(env, { method: 'POST', headers, body: { decision: 'approved', hash: edited.body.review.hash } });
  assert.equal(reapproved.body.review.status, 'approved');
  assert.equal(reapproved.body.review.history.length, 2);
  assert.equal(reapproved.body.review.history[1].hash, edited.body.review.hash);

  const reset = await call(env, { method: 'PATCH', headers, body: { reset: true } });
  assert.equal(reset.body.review.effectivePost, 'Post dijana untuk ujian.');
  assert.equal(reset.body.review.hash, initial.hash);
  assert.equal(reset.body.review.status, 'pending');
  assert.equal(reset.body.review.stale, true, 'the last decision was revoked by the edit');
  assert.ok(reset.body.review.decision.revokedAt, 'editing must revoke the decision permanently');
  assert.equal(isApproved(reset.body.review), false, 'reverting to the old bytes must not revive approval');

  // Only an explicit new owner decision reactivates the original bytes.
  const explicit = await call(env, { method: 'POST', headers, body: { decision: 'approved', hash: reset.body.review.hash } });
  assert.equal(explicit.body.review.status, 'approved');
  assert.equal(explicit.body.review.decision.revokedAt, '');
});

test('every reviewable field is inside the digest', async () => {
  const base = record();
  const digest = await analysisDigest(base);
  const mutations = [
    (r) => { r.generatedPost += ' x'; },
    (r) => { r.classification = 'underperforming'; },
    (r) => { r.source.url += '?changed=1'; },
    (r) => { r.source.publishedAt = '2026-11-02T10:00:00+08:00'; },
    (r) => { r.metrics.views = 1; },
    (r) => { r.comparison.deltaPct = -20; },
    (r) => { r.evidence[0].claim = 'Berubah'; },
    (r) => { r.evidence.push({ claim: 'Bukti baru' }); },
    (r) => { r.observation += ' Berubah.'; },
    (r) => { r.hypotheses[0] = 'Hipotesis berubah.'; },
    (r) => { r.confidence.score = 0.3; },
    (r) => { r.suggestion += ' Berubah.'; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(base);
    mutate(changed);
    assert.notEqual(await analysisDigest(changed), digest, mutate.toString());
  }
  const reordered = structuredClone(base);
  reordered.metrics = { shares: 90, quotes: 60, reposts: 300, replies: 200, likes: 1800, views: 41000 };
  assert.equal(await analysisDigest(reordered), digest, 'object key order must not change the digest');
  const reorderedEvidence = structuredClone(base);
  reorderedEvidence.source = Object.fromEntries(Object.entries(base.source).reverse());
  assert.equal(await analysisDigest(reorderedEvidence), digest, 'source key order must not change the digest');
});

test('revise and reject require a written reason; decisions keep their own hash', async () => {
  const { env } = setup();
  const headers = await ownerHeaders(env);
  const hash = (await call(env, { headers })).body.reviews[0].hash;

  const noNote = await call(env, { method: 'POST', headers, body: { decision: 'revise', hash } });
  assert.equal(noNote.status, 400);
  assert.equal(noNote.body.error, 'note_required');

  const revise = await call(env, { method: 'POST', headers, body: { decision: 'revise', hash, note: 'Tukar hook.' } });
  assert.equal(revise.body.review.status, 'revise');
  assert.equal(revise.body.review.decision.note, 'Tukar hook.');
  assert.equal(revise.body.review.decision.decidedBy, 'owner');

  const reject = await call(env, { method: 'POST', headers, body: { decision: 'rejected', hash, note: 'Topik terlalu umum.' } });
  assert.equal(reject.body.review.status, 'rejected');
  assert.equal(reject.body.review.decision.sequence, 2);
  assert.equal(reject.body.review.history.length, 2);
});

test('invalid requests fail closed and responses never leak extra record fields', async () => {
  const { env } = setup();
  const headers = await ownerHeaders(env);
  const hash = (await call(env, { headers })).body.reviews[0].hash;

  assert.equal((await call(env, { method: 'PUT', headers, body: {} })).status, 405);
  assert.equal((await call(env, { method: 'POST', headers, body: { decision: 'maybe', hash } })).body.error, 'invalid_decision');
  assert.equal((await call(env, { method: 'POST', headers, body: { decision: 'approved', hash: 'short' } })).body.error, 'invalid_hash');
  assert.equal((await call(env, { method: 'POST', headers, body: { decision: 'approved', hash, note: 'x'.repeat(2000) } })).body.error, 'note_too_long');
  assert.equal((await call(env, { method: 'PATCH', headers, body: { generatedPost: '   ' } })).body.error, 'invalid_post');
  assert.equal((await call(env, { method: 'PATCH', headers, body: { generatedPost: 'x'.repeat(12001) } })).body.error, 'post_too_long');
  assert.equal((await call(env, { headers, id: 'missing-id' })).body.error, 'not_found');

  const listed = await call(env, { headers });
  const serialised = JSON.stringify(listed.body);
  assert.ok(!serialised.includes('secret-agent-token'));
  assert.ok(!serialised.includes('secret-api-token'));
  assert.ok(!serialised.includes('separate-owner-secret'));
  assert.equal(listed.body.reviews[0].token, undefined);
});

test('reviewView never reports a stale approval as approved', async () => {
  const base = record();
  const hash = await analysisDigest(base);
  const decision = { decision: 'approved', hash: 'f'.repeat(64), note: '', decidedAt: '2026-11-13T02:00:00.000Z', decidedBy: 'owner', sequence: 1 };
  const view = reviewView(base, null, decision, hash);
  assert.equal(view.status, 'pending');
  assert.equal(view.stale, true);
  assert.equal(isApproved(view), false);

  const fresh = reviewView(base, null, { ...decision, hash }, hash);
  assert.equal(fresh.status, 'approved');
  assert.equal(isApproved(fresh), true);
});
