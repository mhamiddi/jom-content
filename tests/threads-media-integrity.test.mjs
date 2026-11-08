import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {prepareMedia, validateMedia, serveMedia} from '../functions/_lib/threads-media.js';

// Node-only test adapter. Production uses workerd's streaming DigestStream.
crypto.DigestStream ??= class extends WritableStream {
 constructor() { const h=createHash('sha256'); let done; const digest=new Promise(r=>done=r); super({write:c=>h.update(c),close:()=>done(Uint8Array.from(h.digest()).buffer)}); this.digest=digest; }
};
const hex=b=>Buffer.from(b).toString('hex');
class Bucket {
 data=new Map();
 async put(key,body,opt={}) {
  const bytes=new Uint8Array(await new Response(body).arrayBuffer());
  const sum=await crypto.subtle.digest('SHA-256',bytes);
  if(opt.sha256 && hex(sum)!==hex(opt.sha256)) throw Error('checksum mismatch');
  if(opt.onlyIf?.etagDoesNotMatch==='*' && this.data.has(key)) return null;
  this.data.set(key,{bytes,etag:hex(sum),size:bytes.length,checksums:opt.sha256?{sha256:sum}:{},httpMetadata:opt.httpMetadata||{}});
  return this.head(key);
 }
 async head(key) {const o=this.data.get(key);return o?{...o,key}:null;}
 async get(key,opt={}) {const o=await this.head(key); if(!o)return null; if(opt.onlyIf?.etagMatches && opt.onlyIf.etagMatches!==o.etag)return o; return {...o,body:new Response(o.bytes).body};}
}
const origin='https://app.invalid';
const original={caption:'Hello',mediaType:'image',mediaUrl:'https://media.jom-content.com/media/a.png'};
async function setup(){const bucket=new Bucket();await bucket.put('media/a.png','original',{httpMetadata:{contentType:'image/png'}});return {JOM_MEDIA:bucket};}

test('prepare snapshots exact bytes and validate rejects a mutable original URL',async()=>{
 const env=await setup(); const frozen=await prepareMedia(env,original,origin);
 assert.notEqual(frozen.mediaUrl,original.mediaUrl);assert.match(frozen.mediaUrl,/\/api\/threads-media\?asset=[a-f0-9]{64}\.png$/);
 await assert.rejects(validateMedia(env,original,origin),/media_snapshot_required/);
 const manifest=await validateMedia(env,frozen,origin);assert.equal(manifest.length,1);
 assert.equal(manifest[0].sha256,createHash('sha256').update('original').digest('hex'));
 await env.JOM_MEDIA.put('media/a.png','changed',{httpMetadata:{contentType:'image/png'}});
 const response=await serveMedia(new Request(frozen.mediaUrl),env);
 assert.equal(response.status,200);assert.equal(await response.text(),'original');
});
test('overwritten snapshot cannot be served or approved, even under same URL',async()=>{
 const env=await setup();const frozen=await prepareMedia(env,original,origin);
 const [m]=await validateMedia(env,frozen,origin);
 await env.JOM_MEDIA.put(m.key,'tampered',{httpMetadata:{contentType:'image/png'}});
 await assert.rejects(validateMedia(env,frozen,origin),/media_integrity/);
 assert.equal((await serveMedia(new Request(frozen.mediaUrl),env)).status,409);
});
test('source replacement between hashing and copy aborts snapshot',async()=>{
 const env=await setup();const real=env.JOM_MEDIA.get.bind(env.JOM_MEDIA);let n=0;
 env.JOM_MEDIA.get=async(k,opt)=>{if(k==='media/a.png' && ++n===2) await env.JOM_MEDIA.put(k,'raced',{httpMetadata:{contentType:'image/png'}});return real(k,opt);};
 await assert.rejects(prepareMedia(env,original,origin),/media_changed/);
});
test('external URLs, non-media types, invalid carousel and traversal fail closed',async()=>{
 const env=await setup();
 for(const mediaUrl of ['http://127.0.0.1/a','https://evil.invalid/media/a.png','https://media.jom-content.com/private','https://media.jom-content.com/media/%2e%2e/private']) await assert.rejects(prepareMedia(env,{...original,mediaUrl},origin));
 await assert.rejects(prepareMedia(env,{...original,mediaType:'video'},origin),/media_type/);
 await assert.rejects(prepareMedia(env,{caption:'x',carouselImages:[original.mediaUrl]},origin),/carousel/);
 assert.equal((await serveMedia(new Request(origin+'/api/threads-media?asset=../private'),env)).status,400);
});
test('text needs no bucket, ordered carousel is preserved and retries reuse bytes',async()=>{
 assert.deepEqual(await prepareMedia({}, {caption:'text'},origin),{caption:'text'});
 assert.deepEqual(await validateMedia({}, {caption:'text'},origin),[]);
 const env=await setup();await env.JOM_MEDIA.put('media/b.png','second',{httpMetadata:{contentType:'image/png'}});
 const b={caption:'x',carouselImages:[original.mediaUrl,'https://media.jom-content.com/media/b.png']};
 const frozen=await prepareMedia(env,b,origin);const m=await validateMedia(env,frozen,origin);
 assert.equal(m.length,2);assert.notEqual(m[0].sha256,m[1].sha256);
 assert.deepEqual(await prepareMedia(env,b,origin),frozen);
});
