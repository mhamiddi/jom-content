import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
const require=createRequire(process.env.THREADS_TEST_TOOLS || '/home/hamiddi/.hermes/cache/scratch/threads-approval-tools/package.json');
const {Miniflare}=require('miniflare');
const root=resolve('.');
const entry=`
import {onRequest as publish} from '../functions/api/threads-publish.js';
import {onRequest as approve} from '../functions/api/threads-approval.js';
import {onRequest as prepare} from '../functions/api/threads-media-prepare.js';
import {onRequest as media} from '../functions/api/threads-media.js';
import {onRequest as middleware} from '../functions/_middleware.js';
import {makeSession} from '../functions/_lib/auth.js';
export {ThreadsPublishGuard} from '../workers/threads-publish-guard/index.js';
export default {async fetch(request,env){
 const path=new URL(request.url).pathname;
 if(path==='/fixture/seed'){
  const p=await request.json();
  await env.JOM_CONTENT.put('posts',JSON.stringify([{id:'p1',platform:'threads',caption:'Hello',status:'draft',...p}]));
  await env.JOM_CONTENT.put('threads_accounts',JSON.stringify([{id:'a1',userId:'u1',username:'fixture',token:'fixture-token',refreshedAt:new Date().toISOString()}]));
  await env.JOM_MEDIA.put('media/a.png','approved original',{httpMetadata:{contentType:'image/png'}});
  return Response.json({cookie:'jc_session='+await makeSession(env)});
 }
 if(path==='/fixture/overwrite'){const b=await request.json();await env.JOM_MEDIA.put(b.key,b.bytes,{httpMetadata:{contentType:'image/png'}});return Response.json({ok:true});}
 if(path==='/fixture/guard'){const stub=env.THREADS_GUARD.get(env.THREADS_GUARD.idFromName(JSON.stringify(['u1','p1'])));return stub.fetch('https://internal/status',{method:'POST',body:'{}'});}
 if(path==='/fixture/lock'){const b=await request.json();await env.JOM_CONTENT.put('threads_publish:a1:p1',JSON.stringify(b));return Response.json({ok:true});}
 const fn={'/api/threads-publish':publish,'/api/threads-approval':approve,'/api/threads-media-prepare':prepare,'/api/threads-media':media}[path];
 if(!fn)return new Response('Not found',{status:404});
 return middleware({request,env,next:()=>fn({request,env})});
}};`;
function modules(){
 const list=[{type:'ESModule',path:resolve('tests/runtime-worker.mjs'),contents:entry}];
 for(const dir of ['functions/_lib','functions/api'])for(const file of readdirSync(dir).filter(x=>x.endsWith('.js'))){const path=resolve(dir,file);list.push({type:'ESModule',path,contents:readFileSync(path,'utf8')});}
 for(const f of ['functions/_middleware.js','workers/threads-publish-guard/index.js']){const path=resolve(f);list.push({type:'ESModule',path,contents:readFileSync(path,'utf8')});}
 return list;
}
async function setup({guard=true,failPublish=false}={}){
 let publications=0,creates=0;
 const mf=new Miniflare({modules:modules(),modulesRoot:root,compatibilityDate:'2025-04-01',kvNamespaces:['JOM_CONTENT'],r2Buckets:['JOM_MEDIA'],durableObjects:guard?{THREADS_GUARD:{className:'ThreadsPublishGuard',useSQLite:true}}:{},bindings:{JOM_API_TOKEN:'fixture-api',JOM_SESSION_SECRET:'independent-secret',THREADS_API_BASE:'https://graph.invalid/v1.0'},outboundService:async request=>{
  const p=new URL(request.url).pathname;
  if(p.endsWith('/threads_publish')){publications++;await new Promise(r=>setTimeout(r,30));if(failPublish)throw Error('simulated unknown outcome');return Response.json({id:'published-'+publications});}
  if(p.endsWith('/threads')){creates++;return Response.json({id:'container-'+creates});}
  return Response.json({status:'FINISHED',permalink:'https://threads.invalid/published'});
 }});
 const seed=await mf.dispatchFetch('https://app.invalid/fixture/seed',{method:'POST',body:'{}'});const {cookie}=await seed.json();
 const post=async(path,body={},owner=false)=>{
  const r=await mf.dispatchFetch('https://app.invalid'+path,{method:'POST',headers:owner?{Cookie:cookie,Origin:'https://app.invalid'}:{Authorization:'Bearer fixture-api'},body:JSON.stringify(body)});
  return {status:r.status,body:await r.json()};
 };
 return {mf,post,count:()=>({publications,creates})};
}
const text={caption:'Hello',accountId:'a1'};
test('real routes: atomic publish allows one of 24 racing requests and blocks reapproval',async()=>{
 const {mf,post,count}=await setup();try{
  assert.equal((await post('/api/threads-approval?id=p1',text,true)).status,200);
  const races=await Promise.all(Array.from({length:24},()=>post('/api/threads-publish?id=p1',text)));
  assert.equal(races.filter(r=>r.status===200).length,1);assert.equal(count().publications,1);
  assert.equal((await post('/api/threads-approval?id=p1',text,true)).status,409);
 }finally{await mf.dispose();}
});
test('real R2: original can change, published frozen bytes cannot; tampering fails closed',async()=>{
 const {mf,post,count}=await setup();try{
  const input={...text,mediaType:'image',mediaUrl:'https://media.jom-content.com/media/a.png'};
  assert.equal((await post('/api/threads-approval?id=p1',input,true)).status,422);
  const prepared=await post('/api/threads-media-prepare?id=p1',input,true);assert.equal(prepared.status,200,JSON.stringify(prepared));
  const frozen=prepared.body.body;
  await post('/fixture/overwrite',{key:'media/a.png',bytes:'replacement'});
  const response=await mf.dispatchFetch(frozen.mediaUrl);assert.equal(response.status,200);assert.equal(await response.text(),'approved original');
  const ranged=await mf.dispatchFetch(frozen.mediaUrl,{headers:{Range:'bytes=0-7'}});assert.equal(ranged.status,206);assert.equal(await ranged.text(),'approved');
  assert.equal((await post('/api/threads-approval?id=p1',frozen,true)).status,200);
  const asset=new URL(frozen.mediaUrl).searchParams.get('asset');
  await post('/fixture/overwrite',{key:'threads-approved/'+asset,bytes:'tampered'});
  assert.equal((await mf.dispatchFetch(frozen.mediaUrl)).status,409);
  const result=await post('/api/threads-publish?id=p1',frozen);assert.equal(result.status,422);assert.equal(count().creates,0);
 }finally{await mf.dispose();}
});
test('missing durable binding refuses approval and publishing without Graph calls',async()=>{
 const {mf,post,count}=await setup({guard:false});try{
  assert.equal((await post('/api/threads-approval?id=p1',text,true)).status,503);
  assert.equal((await post('/api/threads-publish?id=p1',text)).status,503);
  assert.equal(count().creates,0);
 }finally{await mf.dispose();}
});
test('unknown remote outcome remains blocked even with a new owner approval',async()=>{
 const {mf,post,count}=await setup({failPublish:true});try{
  assert.equal((await post('/api/threads-approval?id=p1',text,true)).status,200);
  assert.equal((await post('/api/threads-publish?id=p1',text)).status,502);
  assert.equal((await post('/api/threads-approval?id=p1',text,true)).body.error,'reconciliation_required');
  assert.equal((await post('/api/threads-publish?id=p1',text)).status,409);
  assert.equal(count().publications,1);
 }finally{await mf.dispose();}
});
test('legacy ambiguous KV attempts never publish again, even after fresh owner approval',async()=>{
 const {mf,post,count}=await setup();try{
  const cases=[
   {state:'publishing',startedAt:'2020-01-01T00:00:00Z'},
   {state:'failed',startedAt:'2020-01-01T00:00:00Z'},
   {state:'publishing',startedAt:'2020-01-01T00:00:00Z',ids:[],urls:[]},
  ];
  for(const prior of cases){
   await mf.dispatchFetch('https://app.invalid/fixture/lock',{method:'POST',body:JSON.stringify(prior)});
   assert.equal((await post('/api/threads-approval?id=p1',text,true)).status,200);
   const r=await post('/api/threads-publish?id=p1',text);
   assert.equal(r.status,409,JSON.stringify(prior));assert.equal(r.body.error,'reconciliation_required');assert.equal(count().publications,0);
  }
 }finally{await mf.dispose();}
});
