import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as publish } from '../functions/api/threads-publish.js';
import { makeSession } from '../functions/_lib/auth.js';
import { fixture, testBindings } from './helpers/threads-test-env.mjs';
const [a, one, two, other] = ['a', 'one', 'two', 'other'].map(name => fixture(name));

function setup() {
  const values = new Map(Object.entries({posts: JSON.stringify([{id:'p1', platform:'threads', caption:'Hello', status:'draft', updatedAt:'v1'}]), threads_accounts: JSON.stringify([{id:'a1',userId:'u1',token:'secret-social-token',refreshedAt:new Date().toISOString()},{id:'a2',userId:'u2',token:'other',refreshedAt:new Date().toISOString()}])}));
  const kv = { async get(k,o) { const v=values.get(k); return v == null ? null : o?.type==='json' ? JSON.parse(v) : v; }, async put(k,v) { values.set(k,v); } };
  return {values, env:{...testBindings([a, one, two, other]), JOM_CONTENT:kv,JOM_API_TOKEN:'secret-api-token',JOM_SESSION_SECRET:'separate-owner-secret',THREADS_API_BASE:'https://graph.invalid/v1.0'}};
}
async function req(fn,env,body,headers={}) {
  const response=await fn({request:new Request('https://app.invalid/api/test?id=p1',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)}),env});
  return {status:response.status, body:await response.json()};
}
const payload={caption:'Hello',accountId:'a1',mediaUrl:a.url,mediaType:'image'};
test('publish rejects even a client claimed approval when no server approval exists', async () => {
  const {env}=setup(); let calls=0; globalThis.fetch=async()=>{calls++;throw Error('unexpected transport');};
  const result=await req(publish,env,{...payload,approved:true});
  assert.equal(result.body.error,'approval_required'); assert.equal(calls,0);
});
test('owner approval is session-only and bound to caption, ordered media, account and revision', async () => {
  const {onRequest:approve}=await import('../functions/api/threads-approval.js');
  const {env,values}=setup(); const cookie=`jc_session=${await makeSession(env)}`; const headers={Cookie:cookie,Origin:'https://app.invalid'};
  const original={caption:'Hello',accountId:'a1',carouselImages:[one.url,two.url]};
  assert.equal((await req(approve,env,original,{Authorization:'Bearer secret-api-token'})).status,403);
  const forged = await makeSession({JOM_API_TOKEN:env.JOM_API_TOKEN});
  assert.equal((await req(approve,env,original,{Cookie:`jc_session=${forged}`,Origin:'https://app.invalid'})).status,403);
  assert.equal((await req(approve,env,original,{Cookie:cookie,Origin:'https://evil.invalid'})).status,403);
  assert.equal((await req(approve,env,original,headers)).status,200);
  let calls=0; globalThis.fetch=async (url,init)=>{calls++; const path=new URL(url).pathname; return {ok:true,status:200,json:async()=>path.endsWith('/threads_publish')?{id:'published'}:path.endsWith('/threads')?{id:'container'}:{status:'FINISHED',permalink:'https://threads.invalid/post'}};};
  for (const changed of [{...original,carouselImages:[...original.carouselImages].reverse()},{...original,carouselImages:[one.url,other.url]},{...original,mediaUrl:other.url,mediaType:'image'},{...original,accountId:'a2'},{...original,caption:'Changed'}]) {
    const r=await req(publish,env,changed); assert.ok(['approval_required','stale'].includes(r.body.error));
  }
  const posts=JSON.parse(values.get('posts')); posts[0].caption='Changed'; posts[0].updatedAt='v2'; values.set('posts',JSON.stringify(posts));
  assert.equal((await req(publish,env,{...original,caption:'Changed'})).body.error,'approval_required');
  posts[0].caption='Hello'; posts[0].updatedAt='v3'; values.set('posts',JSON.stringify(posts));
  const approved=await req(approve,env,original,headers); assert.equal(approved.status,200);
  const result=await req(publish,env,original); assert.equal(result.status,200); assert.ok(calls>0);
  const replay=await req(publish,env,original); assert.equal(replay.body.error,'already_posted');
  assert.ok(!JSON.stringify(result).includes('secret-api-token')); assert.ok(!JSON.stringify(result).includes('secret-social-token'));
});
test('partial and duplicate locks remain authoritative without a new approval', async () => {
  const {env,values}=setup();
  values.set('threads_publish:a1:p1', JSON.stringify({state:'failed',urls:['https://threads.invalid/existing']}));
  assert.equal((await req(publish,env,payload)).body.error,'partial');
  values.set('threads_publish:a1:p1', JSON.stringify({state:'failed',ids:['container-1']}));
  assert.equal((await req(publish,env,payload)).body.error,'partial');
  values.set('threads_publish:a1:p1', JSON.stringify({state:'published',urls:['https://threads.invalid/existing']}));
  assert.equal((await req(publish,env,payload)).body.error,'already_posted');
});
test('transport failures redact all server secrets from response and lock', async () => {
  const {onRequest:approve}=await import('../functions/api/threads-approval.js');
  const {env,values}=setup(); const cookie=`jc_session=${await makeSession(env)}`;
  assert.equal((await req(approve,env,payload,{Cookie:cookie,Origin:'https://app.invalid'})).status,200);
  globalThis.fetch=async()=>({ok:false,status:500,json:async()=>({error:{message:'secret-social-token secret-api-token separate-owner-secret secret-social-token'}})});
  const result=await req(publish,env,payload);
  assert.equal(result.body.error,'publish_failed');
  for (const secret of ['secret-social-token','secret-api-token','separate-owner-secret']) {
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(!values.get('threads_publish:a1:p1').includes(secret));
  }
});
test('approval fails closed when the independent session secret is missing or reused', async () => {
  const {onRequest:approve}=await import('../functions/api/threads-approval.js');
  const {env}=setup(); delete env.JOM_SESSION_SECRET;
  assert.equal((await req(approve,env,payload)).body.error,'owner_session_not_configured');
  env.JOM_SESSION_SECRET=env.JOM_API_TOKEN;
  assert.equal((await req(approve,env,payload)).body.error,'owner_session_not_configured');
});
test('failed attempt requires reconciliation even after fresh owner approval', async () => {
  const {onRequest:approve}=await import('../functions/api/threads-approval.js');
  const {env}=setup(); const cookie=`jc_session=${await makeSession(env)}`;
  assert.equal((await req(approve,env,payload,{Cookie:cookie,Origin:'https://app.invalid'})).status,200);
  globalThis.fetch=async()=>({ok:false,status:500,json:async()=>({error:{message:'down'}})});
  assert.equal((await req(publish,env,payload)).body.error,'publish_failed');
  globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({id:'container'})});
  assert.equal((await req(publish,env,payload)).body.error,'reconciliation_required');
  assert.equal((await req(approve,env,payload,{Cookie:cookie,Origin:'https://app.invalid'})).body.error,'reconciliation_required');
  assert.equal((await req(publish,env,payload)).body.error,'reconciliation_required');
});

test('unknown, external and tampered media cannot be approved', async () => {
  const {onRequest:approve}=await import('../functions/api/threads-approval.js');
  const {env}=setup();
  const headers={Cookie:`jc_session=${await makeSession(env)}`,Origin:'https://app.invalid'};
  const unknown=fixture('unknown');
  for (const mediaUrl of [unknown.url, 'https://media.invalid/a.jpg']) {
    const result=await req(approve,env,{...payload,mediaUrl},headers);
    assert.equal(result.status,422); assert.equal(result.body.error,'media_integrity');
  }
  const object=env.JOM_MEDIA;
  const original=object.head.bind(object);
  object.head=async key => { const result=await original(key); return result && {...result,checksums:{sha256:new Uint8Array(32)}}; };
  const result=await req(approve,env,payload,headers);
  assert.equal(result.status,422); assert.equal(result.body.error,'media_integrity');
  let calls=0; globalThis.fetch=async()=>{calls++;throw Error('unexpected transport');};
  assert.equal((await req(publish,env,payload)).body.error,'media_integrity');
  assert.equal(calls,0);
});
