import { enforced, json, sessionValid } from '../_lib/auth.js';
import { publishCaption } from '../_lib/caption.js';
import { loadAccounts, resolveAccount } from '../_lib/threads.js';
import { approvalDigest } from '../_lib/threads-approval.js';
import { validateMedia } from '../_lib/threads-media.js';
import { guardCall } from '../_lib/threads-guard.js';

// Only an interactive owner session can approve; a bearer-token agent cannot.
export async function onRequest({request, env}) {
  if (!env.JOM_CONTENT || !enforced(env)) return json({success:false,error:'lock_off'},403);
  if (!env.JOM_SESSION_SECRET || env.JOM_SESSION_SECRET === env.JOM_API_TOKEN) return json({success:false,error:'owner_session_not_configured',message:'Server perlu JOM_SESSION_SECRET yang berbeza daripada API token.'},503);
  if (request.method !== 'POST') return json({success:false,error:'method not allowed'},405);
  if (request.headers.get('Origin') !== new URL(request.url).origin || !(await sessionValid(request, env))) return json({success:false,error:'owner_session_required'},403);
  const id = new URL(request.url).searchParams.get('id');
  let body; try { body = await request.json(); } catch { return json({success:false,error:'invalid_body'},400); }
  if (!id || !body || typeof body.caption !== 'string' || !body.caption.trim()) return json({success:false,error:'invalid_body'},400);
  const post = ((await env.JOM_CONTENT.get('posts',{type:'json'})) || []).find(p=>p.id===id);
  if (!post) return json({success:false,error:'Post not found'},404);
  if (post.status === 'rejected') return json({success:false,error:'rejected'},422);
  if (body.caption.trim() !== publishCaption(post)) return json({success:false,error:'stale',message:'Caption berubah. Refresh dashboard dulu.'},409);
  const account = resolveAccount(await loadAccounts(env), String(body.accountId || '').trim());
  if (!account) return json({success:false,error:'not_configured'},409);
  if (!env.THREADS_GUARD) return json({success:false,error:'publish_guard_unavailable'},503);
  let media;
  try { media = await validateMedia(env, body, new URL(request.url).origin); }
  catch { return json({success:false,error:'media_integrity',message:'Media perlu snapshot yang sudah disemak. Sediakan preview media semula.'},422); }
  const digest = await approvalDigest(post, account, body);
  const approved = await guardCall(env, account.userId, id, 'approve', {digest, manifest:{media}, approvedAt:new Date().toISOString()});
  if (!approved.data.success) return json(approved.data, approved.status);
  return json({success:true,accountId:account.id});
}
