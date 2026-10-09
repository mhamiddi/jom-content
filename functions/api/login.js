import { enforced, json, makeSession, safeEqual, sessionCookie } from '../_lib/auth.js';

const MAX_FAILS = 8;          // per client IP
const WINDOW_SECONDS = 900;   // 15 minutes

// POST /api/login { username, password } -> sets the signed session cookie
export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405);
  if (!enforced(env) || !env.JOM_LOGIN_PASSWORD) return json({ success: false, error: 'server login not enabled' }, 400);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const kv = env.JOM_CONTENT;
  const failKey = `loginfail:${ip}`;
  const fails = kv ? Number(await kv.get(failKey)) || 0 : 0;
  if (fails >= MAX_FAILS) return json({ success: false, error: 'too many attempts' }, 429, { 'Retry-After': String(WINDOW_SECONDS) });

  let body = {};
  try { body = await request.json(); } catch { /* fall through to rejection */ }
  const user = String(body.username || '').trim();
  const pass = String(body.password || '');
  const okUser = await safeEqual(user, env.JOM_LOGIN_USER || 'jomdigital', env.JOM_API_TOKEN);
  const okPass = await safeEqual(pass, env.JOM_LOGIN_PASSWORD, env.JOM_API_TOKEN);

  if (!(okUser && okPass)) {
    if (kv) await kv.put(failKey, String(fails + 1), { expirationTtl: WINDOW_SECONDS });
    return json({ success: false, error: 'invalid credentials' }, 401);
  }
  if (kv && fails) await kv.delete(failKey);
  return json({ success: true }, 200, { 'Set-Cookie': sessionCookie(await makeSession(env), request) });
}
