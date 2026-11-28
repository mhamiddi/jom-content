import test from 'node:test';
import assert from 'node:assert/strict';
import {toolsRequire} from './helpers/tools.mjs';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
const {Miniflare}=toolsRequire('miniflare');
const root=resolve('.');
// The OS theme shell (jd-shell) is added to dashboard pages for the logged-in owner only.
const entry=`
import {onRequest as middleware} from '../functions/_middleware.js';
import {makeSession} from '../functions/_lib/auth.js';
export default {async fetch(request,env){
 const path=new URL(request.url).pathname;
 if(path==='/fixture/session')return Response.json({cookie:'jc_session='+await makeSession(env)});
 const next=(req)=>{const r=req||request;return new Response('<!doctype html><html><head><title>x</title></head><body>'+(r.headers.get('If-None-Match')?'conditional':'full')+'</body></html>',{headers:{'Content-Type':'text/html; charset=utf-8','ETag':'"abc"','Cache-Control':'public, max-age=0, must-revalidate'}});};
 return middleware({request,env,next});
}};`;
function modules(){
 const list=[{type:'ESModule',path:resolve('tests/jd-worker.mjs'),contents:entry}];
 for(const file of readdirSync('functions/_lib').filter(x=>x.endsWith('.js'))){const path=resolve('functions/_lib',file);list.push({type:'ESModule',path,contents:readFileSync(path,'utf8')});}
 list.push({type:'ESModule',path:resolve('functions/_middleware.js'),contents:readFileSync('functions/_middleware.js','utf8')});
 return list;
}
async function setup(extra={}){
 const mf=new Miniflare({modules:modules(),modulesRoot:root,compatibilityDate:'2025-04-01',kvNamespaces:['JOM_CONTENT'],bindings:{JOM_API_TOKEN:'fixture-api',JOM_SESSION_SECRET:'fixture-secret',...extra}});
 const {cookie}=await (await mf.dispatchFetch('https://app.invalid/fixture/session')).json();
 const get=async(path,headers={})=>{const r=await mf.dispatchFetch('https://app.invalid'+path,{headers});return {r,html:await r.text()};};
 return {mf,cookie,get};
}
test('owner pages get the OS shell with the right app slug',async()=>{
 const {mf,cookie,get}=await setup();try{
  for(const [p,slug] of [['/','jom-content'],['/topics','topic-bank'],['/analytics.html','content-analytics'],['/analysis-review','jom-content']]){
   const {r,html}=await get(p,{Cookie:cookie,'If-None-Match':'"abc"'});
   assert.equal(r.status,200,p);
   assert.ok(html.includes('src="https://os.jomdigitalos.my/_jd/shell.js?v=h'),p);
   assert.ok(html.includes('data-jd-app="'+slug+'"'),p);
   assert.match(html,/_jd\/theme\.css/);
   assert.ok(html.includes('full'),'conditional headers are dropped so a cached unthemed copy is not reused');
   assert.equal(r.headers.get('Cache-Control'),'private, no-cache');
   assert.equal(r.headers.get('ETag'),null);
  }
 }finally{await mf.dispose();}
});
test('anonymous visitors, other paths and the kill switch get the page untouched',async()=>{
 const {mf,cookie,get}=await setup();try{
  assert.ok(!(await get('/')).html.includes('data-jd'));
  assert.ok(!(await get('/carousel-template.js',{Cookie:cookie})).html.includes('data-jd'));
  assert.ok(!(await get('/',{Cookie:'jc_session=999.bad'})).html.includes('data-jd'));
 }finally{await mf.dispose();}
 const off=await setup({JD_SHELL:'off'});try{
  assert.ok(!(await off.get('/',{Cookie:off.cookie})).html.includes('data-jd'));
 }finally{await off.mf.dispose();}
});

test('legacy direct analytics navigation redirects to OS, planner iframe remains available', async()=>{
 const {mf,cookie}=await setup();try{
  const direct=await mf.dispatchFetch('https://jom-content.com/analytics',{headers:{'Sec-Fetch-Dest':'document'},redirect:'manual'});
  assert.equal(direct.status,302);assert.equal(direct.headers.get('Location'),'https://os.jomdigitalos.my/hub/content-analytics/');
  const embed=await mf.dispatchFetch('https://jom-content.com/analytics.html',{headers:{Cookie:cookie,'Sec-Fetch-Dest':'iframe'}});
  assert.equal(embed.status,200);
 }finally{await mf.dispose();}
});
