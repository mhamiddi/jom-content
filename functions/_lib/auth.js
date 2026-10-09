/**
 * Jom Content API gate (shared by _middleware.js and the login/session/logout routes).
 *
 * Enforcement is switched on by the Pages environment variable JOM_API_TOKEN.
 *   unset  -> API stays open (legacy behaviour, the client-side login still applies)
 *   set    -> every /api/* call needs EITHER
 *               Authorization: Bearer <JOM_API_TOKEN>      (scripts, Hermes agents)
 *             OR a signed session cookie from POST /api/login (the dashboard)
 *
 * Login credentials live only in Pages env vars: JOM_LOGIN_PASSWORD (required) and JOM_LOGIN_USER (default jomdigital).
 * Session cookie = "<expiry>.<HMAC-SHA256(JOM_API_TOKEN, 'v1.' + expiry)>", HttpOnly, SameSite=Strict.
 */
export const COOKIE = 'jc_session';
export const SESSION_SECONDS = 60 * 60 * 24 * 30;
const enc = new TextEncoder();

export const enforced = (env) => Boolean(env && env.JOM_API_TOKEN);

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time comparison of two strings by comparing HMACs of equal length.
export async function safeEqual(a, b, secret) {
  const [x, y] = await Promise.all([hmacHex(secret, String(a)), hmacHex(secret, String(b))]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return '';
}

export async function makeSession(env) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  return `${exp}.${await hmacHex(env.JOM_API_TOKEN, 'v1.' + exp)}`;
}

export async function sessionValid(request, env) {
  const raw = cookieValue(request.headers.get('Cookie'), COOKIE);
  const [exp, sig] = raw.split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(sig, await hmacHex(env.JOM_API_TOKEN, 'v1.' + exp), env.JOM_API_TOKEN);
}

export async function authorised(request, env) {
  if (!enforced(env)) return true;
  const header = request.headers.get('Authorization') || '';
  if (header.startsWith('Bearer ') && (await safeEqual(header.slice(7), env.JOM_API_TOKEN, env.JOM_API_TOKEN))) return true;
  return sessionValid(request, env);
}

export function sessionCookie(value, request, maxAge = SESSION_SECONDS) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure}`;
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders },
  });
}
