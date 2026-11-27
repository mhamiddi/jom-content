import { authorised, enforced, json, safeEqual } from './_lib/auth.js';

// Open routes: the login flow itself, and CORS preflight.
const OPEN = new Set(['/api/login', '/api/logout', '/api/session', '/api/password-reset', '/api/health']);
const HERA_READ_ROUTES = new Set(['/api/threads-search']);

// Jom Digital OS shell: the owner's dashboards share one theme, top bar and right-side menu.
// Logged-in page loads get the shared assets from the OS host (~/projects/jd-shell on hermes-pc);
// anonymous visitors, the login screen and the API never do. JD_SHELL=off switches it off.
const JD_ORIGIN = 'https://os.jomdigitalos.my';
const JD_PAGES = {
  '/': 'jom-content', '/index.html': 'jom-content',
  '/topics': 'topic-bank', '/topics.html': 'topic-bank',
  '/analytics': 'content-analytics', '/analytics.html': 'content-analytics',
  '/analysis-review': 'jom-content', '/analysis-review.html': 'jom-content',
};

export function jdShellTags(slug, origin = JD_ORIGIN, now = Date.now()) {
  const base = String(origin).replace(/\/+$/, '') + '/_jd/';
  const v = 'v=h' + Math.floor(now / 3600000); // hourly, so theme edits reach the page within an hour
  return `<link rel="stylesheet" href="${base}theme.css?${v}" data-jd-shell>` +
    `<link rel="stylesheet" href="${base}apps/jom-content.css?${v}" data-jd-shell>` +
    `<script defer src="${base}apps/jom-content.js?${v}"></script>` +
    `<script defer src="${base}shell.js?${v}" data-jd-app="${slug}"></script>`;
}

async function withShell(context, slug) {
  const { request, env } = context;
  // Ask for the full page: a 304 would hand back a copy cached before the shell was added.
  const headers = new Headers(request.headers);
  headers.delete('If-None-Match');
  headers.delete('If-Modified-Since');
  const res = await context.next(new Request(request, { headers }));
  if (res.status !== 200 || !(res.headers.get('Content-Type') || '').includes('text/html')) return res;
  const tags = jdShellTags(slug, env.JD_SHELL_ORIGIN || JD_ORIGIN);
  const out = new HTMLRewriter().on('head', { element(el) { el.append(tags, { html: true }); } }).transform(res);
  const h = new Headers(out.headers);
  h.set('Cache-Control', 'private, no-cache');
  h.delete('ETag');
  h.append('Vary', 'Cookie');
  return new Response(out.body, { status: out.status, headers: h });
}

export async function onRequest(context) {
  const { request, env } = context;
  const { pathname } = new URL(request.url);
  const jdSlug = JD_PAGES[pathname];
  if (jdSlug && request.method === 'GET' && env.JD_SHELL !== 'off' && enforced(env) && await authorised(request, env)) {
    return withShell(context, jdSlug);
  }
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
