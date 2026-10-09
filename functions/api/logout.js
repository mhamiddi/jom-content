import { json, sessionCookie } from '../_lib/auth.js';

// POST /api/logout -> expires the session cookie
export async function onRequest(context) {
  return json({ success: true }, 200, { 'Set-Cookie': sessionCookie('', context.request, 0) });
}
