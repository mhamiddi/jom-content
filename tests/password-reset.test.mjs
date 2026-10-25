import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as reset } from '../functions/api/password-reset.js';
import { onRequest as login } from '../functions/api/login.js';

function kvStore() {
  const values = new Map();
  return {
    values,
    async get(key) { return values.get(key) ?? null; },
    async put(key, value) { values.set(key, String(value)); },
    async delete(key) { values.delete(key); },
  };
}

function env(kv) {
  return {
    JOM_API_TOKEN: 'api-token-for-test',
    JOM_LOGIN_USER: 'jomdigital',
    JOM_LOGIN_PASSWORD: 'old-password-for-test',
    JOM_PASSWORD_RESET_CODE: 'recovery-code-for-test',
    JOM_CONTENT: kv,
  };
}

async function responseJson(response) {
  return { status: response.status, body: await response.json() };
}

test('rejects weak passwords before attempting reset', async () => {
  const kv = kvStore();
  const response = await reset({
    request: new Request('https://example.test/api/password-reset', {
      method: 'POST', body: JSON.stringify({ username: 'jomdigital', resetCode: 'recovery-code-for-test', newPassword: 'short' }),
      headers: { 'Content-Type': 'application/json' },
    }),
    env: env(kv),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).success, false);
  assert.equal(kv.values.has('auth:login-password'), false);
});

test('resets the password, stores only the KV override, and returns a session', async () => {
  const kv = kvStore();
  const e = env(kv);
  const response = await reset({
    request: new Request('https://example.test/api/password-reset', {
      method: 'POST', body: JSON.stringify({ username: 'jomdigital', resetCode: 'recovery-code-for-test', newPassword: 'new-password-for-test' }),
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.10' },
    }),
    env: e,
  });
  const result = await responseJson(response);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { success: true });
  assert.equal(kv.values.get('auth:login-password'), 'new-password-for-test');
  assert.match(response.headers.get('Set-Cookie'), /jc_session=/);

  const loginResponse = await login({
    request: new Request('https://example.test/api/login', {
      method: 'POST', body: JSON.stringify({ username: 'jomdigital', password: 'new-password-for-test' }),
      headers: { 'Content-Type': 'application/json' },
    }),
    env: e,
  });
  assert.equal(loginResponse.status, 200);
});

test('does not reveal whether the username or recovery code was wrong', async () => {
  const kv = kvStore();
  const response = await reset({
    request: new Request('https://example.test/api/password-reset', {
      method: 'POST', body: JSON.stringify({ username: 'wrong', resetCode: 'wrong', newPassword: 'new-password-for-test' }),
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.11' },
    }),
    env: env(kv),
  });
  const result = await responseJson(response);
  assert.equal(result.status, 401);
  assert.deepEqual(result.body, { success: false, error: 'invalid reset details' });
});
