import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/threads-analytics.js';

function env() {
  const values = new Map([['threads_auth', JSON.stringify({ token:'test-secret', userId:'owner1', username:'hamiddi_', refreshedAt:new Date().toISOString() })]]);
  return { JOM_API_TOKEN:'test-api', JOM_CONTENT:{ async get(k,o) { const v=values.get(k); return v == null ? null : o?.type==='json' ? JSON.parse(v) : v; }, async put(k,v) { values.set(k,v); } } };
}
function context(e, query='') { return {env:e,request:new Request('https://jom-content.com/api/threads-analytics?action=collect&limit=1'+query)}; }

test('collects current account followers from total_value, without leaking provider paging URLs', async () => {
  const original=globalThis.fetch; const paths=[];
  globalThis.fetch=async input=>{
    const url=new URL(input); paths.push(url.pathname);
    let body;
    if(url.pathname.endsWith('/threads_insights')) body={data:[{name:'followers_count',total_value:{value:6141}}],paging:{next:'https://graph.threads.net/?access_token=test-secret'}};
    else if(url.pathname.endsWith('/me/threads')) body={data:[{id:'p1',text:'test',timestamp:'2026-11-11T00:00:00Z'}]};
    else body={data:[{name:'views',values:[{value:21}]}]};
    return new Response(JSON.stringify(body));
  };
  try {
    const response=await onRequest(context(env())); const data=await response.json();
    assert.equal(response.status,200);
    assert.equal(data.account_metrics?.followers,6141);
    assert.equal(data.account_metrics?.source,'threads_api');
    assert.ok(data.account_metrics?.collected_at);
    assert.equal(data.account_metrics_error,'');
    assert.equal(JSON.stringify(data).includes('test-secret'),false);
    assert.ok(paths.includes('/v1.0/me/threads_insights'));
  } finally { globalThis.fetch=original; }
});

test('missing follower insight stays unavailable, not zero or silently successful', async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async input=>new Response(JSON.stringify(new URL(input).pathname.endsWith('/me/threads')?{data:[{id:'p1'}]}:{data:[]}));
  try {
    const data=await (await onRequest(context(env()))).json();
    assert.equal(data.account_metrics?.followers,null);
    assert.ok(data.account_metrics_error);
  } finally { globalThis.fetch=original; }
});

test('continuation pages do not repeat the account insights request',async()=>{
  const original=globalThis.fetch;const paths=[];
  globalThis.fetch=async input=>{const url=new URL(input);paths.push(url.pathname);return new Response(JSON.stringify({data:[]}));};
  try {
    await onRequest(context(env(),'&after=cursor'));
    assert.equal(paths.some(p=>p.endsWith('/threads_insights')),false);
  } finally {globalThis.fetch=original;}
});
