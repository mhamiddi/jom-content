import { authorised, enforced, json } from './_lib/auth.js';

// Open routes: the login flow itself, and CORS preflight.
const OPEN = new Set(['/api/login', '/api/logout', '/api/session']);

export async function onRequest(context) {
  const { request, env } = context;
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith('/api/') || !enforced(env) || request.method === 'OPTIONS' || OPEN.has(pathname)) {
    return context.next();
  }
  if (await authorised(request, env)) return context.next();
  return json({ success: false, error: 'unauthorized' }, 401);
}
