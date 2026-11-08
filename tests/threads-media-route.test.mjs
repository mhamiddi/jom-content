import test from 'node:test';
import assert from 'node:assert/strict';
import {onRequest as prepare} from '../functions/api/threads-media-prepare.js';
import {onRequest as middleware} from '../functions/_middleware.js';
import {makeSession} from '../functions/_lib/auth.js';
const env={JOM_API_TOKEN:'fixture-api',JOM_SESSION_SECRET:'fixture-independent',JOM_CONTENT:{async get(k){return k==='posts'?[{id:'p',platform:'threads',caption:'Hello',status:'draft'}]:k==='threads_accounts'?[{id:'a',userId:'u',username:'fixture',token:'fixture-social'}]:null;}}};
function req(body,headers={}){return new Request('https://app.invalid/api/threads-media-prepare?id=p',{method:'POST',headers,body:JSON.stringify(body)});}
test('media preparation rejects bearer-only callers and needs an explicit owner session',async()=>{
 assert.equal((await prepare({request:req({caption:'Hello',accountId:'a'},{Authorization:'Bearer fixture-api'}),env})).status,403);
 const cookie='jc_session='+await makeSession(env);
 const r=await prepare({request:req({caption:'Hello',accountId:'a'},{Cookie:cookie,Origin:'https://app.invalid'}),env});
 assert.equal(r.status,200);const d=await r.json();assert.equal(d.approved,false);assert.equal(d.body.caption,'Hello');
});
test('only exact GET/HEAD snapshot route bypasses session middleware',async()=>{
 for(const method of ['GET','HEAD']) {
  let passed=false;const r=await middleware({request:new Request('https://app.invalid/api/threads-media?asset=bad',{method}),env,next:()=>{passed=true;return new Response('fixture');}});
  assert.equal(passed,true);assert.equal(r.status,200);
 }
 for(const [method,path] of [['POST','/api/threads-media'],['GET','/api/threads-media-prepare'],['GET','/api/threads-media/other']]) {
  const r=await middleware({request:new Request('https://app.invalid'+path,{method}),env,next:()=>new Response('unexpected')});assert.equal(r.status,401);
 }
});
