import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { onRequest as approvals } from '../functions/api/learning/approvals.js';
import { onRequest as review } from '../functions/api/threads-analysis.js';
import { makeSession } from '../functions/_lib/auth.js';
import {
  ENVELOPE_SCHEMA, approvalId, buildApprovalPayload, canonicalBytes, verifyEnvelope,
} from '../functions/_lib/approval-envelope.js';
import { analysisDigest, canonical } from '../functions/_lib/analysis-review.js';

const ORIGIN = 'https://app.invalid';
const BINDING = {
  candidateId: 'tl-fixture-72h',
  candidateSha256: 'a'.repeat(64),
  analysisSha256: 'b'.repeat(64),
  postIds: ['17911365021551542'],
};

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKey,
    privateB64: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicB64: publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64'),
    raw: publicKey.export({ type: 'spki', format: 'der' }).subarray(12),
  };
}

function record(overrides = {}) {
  return {
    id: 'ana-1',
    createdAt: '2026-11-13T01:00:00.000Z',
    generatedBy: 'threads-learning-agent',
    classification: 'performing',
    generatedPost: 'Post dijana untuk ujian.',
    source: { type: 'threads', label: '@fixture', url: 'https://threads.invalid/p/1', postId: 'p1', publishedAt: '2026-11-01T10:00:00+08:00', excerpt: 'Petikan' },
    metrics: { views: 41000, likes: 1800 },
    comparison: { metric: 'views', baselineMedian: 9000, deltaPct: 355.6, sampleDays: 30, note: 'median 30 hari' },
    evidence: [{ claim: 'Views 4.5x median', source: 'Threads insights', url: 'https://threads.invalid', value: 41000 }],
    observation: 'Pemerhatian berasaskan data.',
    hypotheses: ['Hipotesis pertama.'],
    confidence: { level: 'high', score: 0.72, rationale: 'Data API penuh.' },
    suggestion: 'Uji struktur sama.',
    binding: { ...BINDING },
    token: 'secret-agent-token',
    ...overrides,
  };
}

function setup({ records = [record()], env: extra = {} } = {}) {
  const keys = keypair();
  const values = new Map([['threads_analysis_reviews', JSON.stringify(records)]]);
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
    JOM_APPROVAL_PRIVATE_KEY: keys.privateB64,
    JOM_APPROVAL_PUBLIC_KEY: keys.publicB64,
    JOM_APPROVAL_KEY_ID: 'owner-fixture',
    ...extra,
  };
  return { env, values, keys };
}

async function get(env, { path = '/api/learning/approvals', headers = {}, method = 'GET' } = {}) {
  const response = await approvals({ request: new Request(ORIGIN + path, { method, headers }), env });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body, headers: response.headers };
}

const ownerHeaders = async (env) => ({ Cookie: 'jc_session=' + await makeSession(env) });

async function decide(env, id, body) {
  return review({
    request: new Request(ORIGIN + '/api/threads-analysis?id=' + encodeURIComponent(id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...(await ownerHeaders(env)) },
      body: JSON.stringify(body),
    }),
    env,
  });
}

test('the envelope route fails closed without lock, owner secret or signing key', async () => {
  const { env } = setup();
  assert.equal((await get({ ...env, JOM_API_TOKEN: '' })).body.error, 'lock_off');
  assert.equal((await get({ ...env, JOM_SESSION_SECRET: env.JOM_API_TOKEN })).body.error, 'owner_session_not_configured');
  assert.equal((await get({ ...env, JOM_SESSION_SECRET: '' })).body.error, 'owner_session_not_configured');

  const headers = await ownerHeaders(env);
  const noKey = await get({ ...env, JOM_APPROVAL_PRIVATE_KEY: '' }, { headers });
  assert.equal(noKey.status, 503);
  assert.equal(noKey.body.error, 'approval_signing_key_unavailable');
  assert.equal(noKey.body.signature_b64, undefined, 'no partial envelope is returned');

  const noPublic = await get({ ...env, JOM_APPROVAL_PUBLIC_KEY: '' }, { headers });
  assert.equal(noPublic.body.error, 'approval_public_key_unavailable');

  const badKey = await get({ ...env, JOM_APPROVAL_PRIVATE_KEY: 'not-base64!!' }, { headers });
  assert.equal(badKey.status, 503);
  assert.equal(badKey.body.error, 'key_material_base64_invalid');

  assert.equal((await get(env, { method: 'POST', headers })).body.error, 'method not allowed');
});

test('only an owner session or the API token may read the envelope', async () => {
  const { env } = setup();
  assert.equal((await get(env)).status, 403);
  assert.equal((await get(env, { headers: { Cookie: 'jc_session=1.2' } })).status, 403);
  const forged = await makeSession({ JOM_API_TOKEN: env.JOM_API_TOKEN });
  assert.equal((await get(env, { headers: { Cookie: 'jc_session=' + forged } })).status, 403, 'token-signed cookie is not an owner session');

  const owner = await get(env, { headers: await ownerHeaders(env) });
  assert.equal(owner.status, 200);
  assert.equal(owner.body.schema, ENVELOPE_SCHEMA);
  assert.equal(owner.body.key_id, 'owner-fixture');

  const bearer = await get(env, { headers: { Authorization: 'Bearer secret-api-token' } });
  assert.equal(bearer.status, 200);
  assert.deepEqual(bearer.body.approvals, [], 'a bearer read emits no approval that was not stored');
  assert.deepEqual(bearer.body.counts, owner.body.counts);
});

test('pending reviews never become approvals', async () => {
  const { env } = setup({ records: [record(), record({ id: 'ana-2' })] });
  const result = await get(env, { headers: await ownerHeaders(env) });
  assert.equal(result.body.approvals.length, 0);
  assert.equal(result.body.counts.pending, 2);
  assert.equal(result.body.counts.records, 2);
  assert.equal(result.body.provenance.decisions, 'owner_session_only');
});

test('an owner approval produces a signed entry bound to the exact digests', async () => {
  const { env, keys } = setup();
  const item = record();
  const hash = await analysisDigest(item);
  const stored = await decide(env, item.id, { decision: 'approved', hash, note: 'Lulus.' });
  assert.equal(stored.status, 200);

  const { body: envelope } = await get(env, { headers: await ownerHeaders(env) });
  assert.equal(envelope.approvals.length, 1);
  const [entry] = envelope.approvals;
  assert.equal(entry.decision, 'approved');
  assert.equal(entry.review_id, 'ana-1');
  assert.equal(entry.review_sha256, hash);
  assert.equal(entry.candidate_id, BINDING.candidateId);
  assert.equal(entry.candidate_sha256, BINDING.candidateSha256);
  assert.equal(entry.analysis_sha256, BINDING.analysisSha256);
  assert.deepEqual(entry.post_ids, BINDING.postIds);
  assert.equal(entry.expires_at, null);
  assert.equal(entry.note, 'Lulus.');
  assert.equal(entry.approval_id, await approvalId('ana-1', hash, 1));

  // Independent verification with node:crypto over the same canonical bytes.
  const payload = { ...envelope };
  delete payload.signature_b64;
  const ok = verify(null, canonicalBytes(payload), keys.publicKey, Buffer.from(envelope.signature_b64, 'base64'));
  assert.equal(ok, true);
  assert.equal(await verifyEnvelope(envelope, keys.publicB64), true);

  const tampered = structuredClone(envelope);
  tampered.approvals[0].analysis_sha256 = 'c'.repeat(64);
  assert.equal(await verifyEnvelope(tampered, keys.publicB64), false);
  assert.equal(JSON.stringify(envelope).includes('secret-agent-token'), false, 'record extras never leak');
});

test('the published key block matches the pinned fingerprint', async () => {
  const { env, keys } = setup();
  const result = await get(env, { path: '/api/learning/approvals?format=key', headers: await ownerHeaders(env) });
  assert.equal(result.status, 200);
  assert.equal(result.body.key.schema, 'threads-learning-owner-key/v1');
  assert.equal(result.body.key.algorithm, 'Ed25519');
  assert.equal(result.body.key.public_key_b64, keys.publicB64);
  assert.equal(result.body.key.fingerprint_sha256, createHash('sha256').update(keys.raw).digest('hex'));
  assert.deepEqual(result.body.pin, { key_id: 'owner-fixture', fingerprint_sha256: result.body.key.fingerprint_sha256 });
  assert.equal((await get(env, { path: '/api/learning/approvals?format=nope', headers: await ownerHeaders(env) })).body.error, 'invalid_format');
});

test('a revise, a rejection and a missing binding are separated in the envelope', async () => {
  const { env } = setup({
    records: [
      record({ id: 'ana-approved' }),
      record({ id: 'ana-revise' }),
      record({ id: 'ana-rejected' }),
      record({ id: 'ana-unbound', binding: undefined }),
    ],
  });
  const headers = await ownerHeaders(env);
  for (const [id, decision, note] of [['ana-approved', 'approved', ''], ['ana-revise', 'revise', 'Tukar hook.'], ['ana-rejected', 'rejected', 'Topik umum.'], ['ana-unbound', 'approved', '']]) {
    const hash = await analysisDigest(id === 'ana-unbound' ? record({ id, binding: undefined }) : record({ id }));
    const response = await decide(env, id, { decision, hash, note });
    assert.equal(response.status, 200, id);
  }

  const { body: envelope } = await get(env, { headers });
  const approved = envelope.approvals.filter((row) => row.decision === 'approved').map((row) => row.review_id);
  const rejected = envelope.approvals.filter((row) => row.decision === 'rejected').map((row) => row.review_id);
  assert.deepEqual(approved, ['ana-approved']);
  assert.deepEqual(rejected, ['ana-rejected']);
  const reasons = Object.fromEntries(envelope.excluded.map((row) => [row.review_id, row.reason]));
  assert.equal(reasons['ana-revise'], 'owner_requested_revision');
  assert.equal(reasons['ana-unbound'], 'binding_candidate_id_missing');
  assert.equal(reasons['ana-approved'], undefined);
});

test('an edit revokes the approval and a revert never revives it', async () => {
  const { env } = setup();
  const headers = await ownerHeaders(env);
  const hash = await analysisDigest(record());
  await decide(env, 'ana-1', { decision: 'approved', hash });

  const { body: before } = await get(env, { headers });
  const first = before.approvals[0].approval_id;

  const edited = await review({
    request: new Request(ORIGIN + '/api/threads-analysis?id=ana-1', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
      body: JSON.stringify({ generatedPost: 'Post diedit selepas kelulusan.' }),
    }),
    env,
  });
  assert.equal(edited.status, 200);

  const { body: after } = await get(env, { headers });
  assert.equal(after.approvals.length, 0, 'a mutated review is not approved');
  assert.equal(after.revocations.some((row) => row.approval_id === first), true, 'the old approval is revoked');
  assert.equal(after.excluded.find((row) => row.review_id === 'ana-1').reason, 'approval_revoked_by_edit');

  await review({
    request: new Request(ORIGIN + '/api/threads-analysis?id=ana-1', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
      body: JSON.stringify({ reset: true }),
    }),
    env,
  });
  const { body: reverted } = await get(env, { headers });
  assert.equal(reverted.approvals.length, 0, 'reverting the bytes does not revive the approval');

  // Re-approving the restored bytes uses a new sequence -> a new approval id.
  const again = await decide(env, 'ana-1', { decision: 'approved', hash });
  assert.equal(again.status, 200);
  const { body: reapproved } = await get(env, { headers });
  assert.equal(reapproved.approvals.length, 1);
  assert.notEqual(reapproved.approvals[0].approval_id, first);
  assert.equal(reapproved.revocations.some((row) => row.approval_id === first), true);
});

test('approval ids are deterministic and the payload is stable for the same state', async () => {
  const first = await approvalId('ana-1', 'a'.repeat(64), 1);
  assert.equal(first, await approvalId('ana-1', 'a'.repeat(64), 1));
  assert.notEqual(first, await approvalId('ana-1', 'a'.repeat(64), 2));
  assert.match(first, /^ap-[a-f0-9]{32}$/);

  const records = [record()];
  const payload = await buildApprovalPayload({
    records,
    getDecision: async () => ({ decision: 'approved', hash: await analysisDigest(records[0]), note: '', decidedAt: '2026-11-13T02:00:00.000Z', sequence: 1 }),
    getEdit: async () => null,
    now: new Date('2026-11-13T02:05:00.000Z'),
    keyId: 'owner-fixture',
  });
  assert.equal(payload.issued_at, '2026-11-13T02:05:00.000Z');
  assert.equal(payload.approvals.length, 1);
  assert.equal(payload.signature_b64, undefined);
  // The signed payload uses only strings, integers, booleans, null and arrays
  // of those: no floats, so Python and JS format every number identically.
  const walk = (value) => {
    if (typeof value === 'number') assert.equal(Number.isInteger(value), true, 'no floats in the signed payload');
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(payload);
  assert.equal(canonical(payload).includes('"approvals":[{"analysis_sha256"'), true, 'canonical JSON is valid JSON');
});
