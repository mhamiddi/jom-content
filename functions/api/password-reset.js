import { enforced, json, makeSession, safeEqual, sessionCookie, setLoginPassword } from '../_lib/auth.js';

const MAX_FAILS = 5;
const WINDOW_SECONDS = 900;
const MIN_PASSWORD_LENGTH = 12;

function validPassword(value) {
  return typeof value === 'string' && value.length >= MIN_PASSWORD_LENGTH && value.length <= 256;
}

// POST /api/password-reset
// Body: { username, resetCode, newPassword }
// JOM_PASSWORD_RESET_CODE must be configured as a Pages secret before use.
export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405);
  if (!enforced(env) || !env.JOM_API_TOKEN) return json({ success: false, error: 'server login not enabled' }, 400);
  if (!env.JOM_PASSWORD_RESET_CODE) return json({ success: false, error: 'password reset not configured' }, 503);
  if (!env.JOM_CONTENT) return json({ success: false, error: 'KV binding not available' }, 500);

  let body = {};
  try { body = await request.json(); } catch { /* reject below */ }
  const username = String(body.username || '').trim();
  const resetCode = String(body.resetCode || '');
  const newPassword = String(body.newPassword || '');
  if (!validPassword(newPassword)) return json({ success: false, error: 'password must be 12-256 characters' }, 400);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const failKey = `passwordresetfail:${ip}`;
  const fails = Number(await env.JOM_CONTENT.get(failKey)) || 0;
  if (fails >= MAX_FAILS) return json({ success: false, error: 'too many attempts' }, 429, { 'Retry-After': String(WINDOW_SECONDS) });

  const okUser = await safeEqual(username, env.JOM_LOGIN_USER || 'jomdigital', env.JOM_API_TOKEN);
  const okCode = await safeEqual(resetCode, env.JOM_PASSWORD_RESET_CODE, env.JOM_API_TOKEN);
  if (!(okUser && okCode)) {
    await env.JOM_CONTENT.put(failKey, String(fails + 1), { expirationTtl: WINDOW_SECONDS });
    return json({ success: false, error: 'invalid reset details' }, 401);
  }

  await setLoginPassword(env, newPassword);
  await env.JOM_CONTENT.delete(failKey);
  return json({ success: true }, 200, { 'Set-Cookie': sessionCookie(await makeSession(env), request) });
}