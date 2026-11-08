import { authorised, enforced, json } from './_lib/auth.js';

// Open routes: the login flow itself, and CORS preflight.
const OPEN = new Set(['/api/login', '/api/logout', '/api/session', '/api/password-reset', '/api/health']);

export async function onRequest(context) {
  const { request, env } = context;
  const { pathname } = new URL(request.url);
  // Meta can only read checksum-addressed frozen media; no mutation endpoint is open.
  const frozenMediaRead = pathname === '/api/threads-media' && ['GET', 'HEAD'].includes(request.method);
  if (frozenMediaRead || !pathname.startsWith('/api/') || !enforced(env) || request.method === 'OPTIONS' || OPEN.has(pathname)) {
    return context.next();
  }
  if (await authorised(request, env)) return context.next();
  return json({ success: false, error: 'unauthorized' }, 401);
}
