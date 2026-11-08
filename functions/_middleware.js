import { authorised, enforced, json, safeEqual } from './_lib/auth.js';

// Open routes: the login flow itself, and CORS preflight.
const OPEN = new Set(['/api/login', '/api/logout', '/api/session', '/api/password-reset', '/api/health']);
const HERA_READ_ROUTES = new Set(['/api/threads-search']);

export async function onRequest(context) {
  const { request, env } = context;
  const { pathname } = new URL(request.url);
  // Meta can only read checksum-addressed frozen media; no mutation endpoint is open.
  const frozenMediaRead = pathname === '/api/threads-media' && ['GET', 'HEAD'].includes(request.method);
  if (frozenMediaRead || !pathname.startsWith('/api/') || request.method === 'OPTIONS' || OPEN.has(pathname)) {
    return context.next();
  }
  if (HERA_READ_ROUTES.has(pathname) && env.HERA_THREADS_SEARCH_TOKEN) {
    const header = request.headers.get('Authorization') || '';
    if (header.startsWith('Bearer ') && await safeEqual(header.slice(7), env.HERA_THREADS_SEARCH_TOKEN, env.HERA_THREADS_SEARCH_TOKEN)) return context.next();
  }
  if (!enforced(env) || await authorised(request, env)) return context.next();
  return json({ success: false, error: 'unauthorized' }, 401);
}
