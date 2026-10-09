import { authorised, enforced, json } from '../_lib/auth.js';

// GET /api/session -> { enforced, authed } so the pages know which login mode to use.
export async function onRequest(context) {
  const { request, env } = context;
  const on = enforced(env);
  return json({ success: true, enforced: on, authed: on ? await authorised(request, env) : false });
}
