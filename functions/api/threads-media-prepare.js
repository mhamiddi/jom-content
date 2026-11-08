import { enforced, json, sessionValid } from '../_lib/auth.js';
import { publishCaption } from '../_lib/caption.js';
import { loadAccounts, resolveAccount } from '../_lib/threads.js';
import { prepareMedia } from '../_lib/threads-media.js';
// Preparation freezes bytes, not approval. Owner must see/review the returned URLs.
export async function onRequest({request,env}) {
 if(!env.JOM_CONTENT || !enforced(env)) return json({success:false,error:'lock_off'},403);
 if(!env.JOM_SESSION_SECRET || env.JOM_SESSION_SECRET===env.JOM_API_TOKEN) return json({success:false,error:'owner_session_not_configured'},503);
 if(request.method!=='POST')return json({success:false,error:'method not allowed'},405);
 const url=new URL(request.url);
 if(request.headers.get('Origin')!==url.origin || !await sessionValid(request,env))return json({success:false,error:'owner_session_required'},403);
 let body;try{body=await request.json();}catch{return json({success:false,error:'invalid_body'},400);}
 const id=url.searchParams.get('id');
 if(!id || !body || typeof body.caption!=='string') return json({success:false,error:'invalid_body'},400);
 const post=((await env.JOM_CONTENT.get('posts',{type:'json'}))||[]).find(p=>p.id===id);
 if(!post)return json({success:false,error:'Post not found'},404);
 if(post.status==='rejected')return json({success:false,error:'rejected'},422);
 if(body.caption.trim()!==publishCaption(post))return json({success:false,error:'stale'},409);
 const account=resolveAccount(await loadAccounts(env),String(body.accountId||'').trim());
 if(!account)return json({success:false,error:'not_configured'},409);
 try {
  const frozen=await prepareMedia(env,body,url.origin);
  return json({success:true,body:{...frozen,accountId:account.id},username:account.username||'',approved:false});
 }catch(error){
  return json({success:false,error:'media_prepare_failed',message:'Media belum dibekukan. Upload media ke Jom Content dahulu dan cuba lagi.'},422);
 }
}
