// Freeze owner-reviewed media; never give Meta a mutable source URL.
// R2 verifies SHA-256 on put and exposes that checksum on get/head. Reads pin ETag.
// See Cloudflare R2 Workers API and Web Crypto DigestStream documentation.
const MIME = {'image/png':'png','image/jpeg':'jpg','image/webp':'webp','video/mp4':'mp4','video/quicktime':'mov','video/webm':'webm'};
const EXT = Object.fromEntries(Object.entries(MIME).map(([k,v])=>[v,k]));
const ASSET=/^([a-f0-9]{64})\.(png|jpg|webp|mp4|mov|webm)$/;
const MAX=90*1024*1024;
const PREFIX='threads-approved/';
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
function fail(code){throw new Error(code);}
function assets(body){
 if(body.carouselImages !== undefined && (!Array.isArray(body.carouselImages) || body.carouselImages.length<2 || body.carouselImages.length>20)) fail('invalid_carousel');
 if(body.carouselImages?.length) return body.carouselImages.map(url=>({url,kind:'image'}));
 if(body.mediaUrl) {if(!['image','video'].includes(body.mediaType)) fail('media_type');return [{url:body.mediaUrl,kind:body.mediaType}];}
 if(body.mediaType && body.mediaType!=='text') fail('media_required');
 return [];
}
function snapshotAsset(url,origin){
 let u;try{u=new URL(url);}catch{fail('media_snapshot_required');}
 if(u.origin!==origin || u.pathname!=='/api/threads-media' || u.username || u.password || u.hash || [...u.searchParams.keys()].join(',')!=='asset') fail('media_snapshot_required');
 const asset=u.searchParams.get('asset');if(!ASSET.test(asset||''))fail('media_snapshot_required');return asset;
}
async function verified(env,asset,kind){
 if(!env.JOM_MEDIA)fail('media_storage_unavailable');
 const [,sha256,ext]=ASSET.exec(asset)||[];if(!sha256)fail('media_integrity');
 const key=PREFIX+asset;const obj=await env.JOM_MEDIA.head(key);
 if(!obj || !obj.checksums?.sha256 || hex(obj.checksums.sha256)!==sha256 || obj.httpMetadata?.contentType!==EXT[ext]) fail('media_integrity');
 if(kind && !EXT[ext].startsWith(kind+'/'))fail('media_type');
 return {key,sha256,type:EXT[ext],size:obj.size,etag:obj.etag};
}
export async function validateMedia(env,body,origin){
 const manifest=[];
 for(const a of assets(body)) {const asset=snapshotAsset(a.url,origin);manifest.push({...await verified(env,asset,a.kind),url:a.url});}
 return manifest;
}
async function freeze(env,url,kind,origin){
 const u=new URL(url);
 if(u.origin===origin && u.pathname==='/api/threads-media'){await verified(env,snapshotAsset(url,origin),kind);return url;}
 const allowed=new Set(['https://media.jom-content.com','https://pub-c48bb3de52da4fe6bbf5f89e7b07271a.r2.dev']);
 if(env.MEDIA_PUBLIC_BASE)allowed.add(new URL(env.MEDIA_PUBLIC_BASE).origin);
 // Do not fetch arbitrary URLs: resolve known media URLs to the bucket binding.
 if(!allowed.has(u.origin)||u.username||u.password||u.search||u.hash)fail('upload_media_first');
 const key=decodeURIComponent(u.pathname.slice(1));
 if(!key.startsWith('media/')||key.split('/').some(s=>s==='..'||s==='.')||key.includes('\\'))fail('upload_media_first');
 if(!env.JOM_MEDIA)fail('media_storage_unavailable');
 const source=await env.JOM_MEDIA.get(key);
 if(!source?.body)fail('media_not_found');
 const type=source.httpMetadata?.contentType;
 if(!MIME[type]||!type.startsWith(kind+'/')){await source.body.cancel();fail('media_type');}
 if(!source.size||source.size>MAX){await source.body.cancel();fail('media_size');}
 if(!crypto.DigestStream){await source.body.cancel();fail('streaming_hash_unavailable');}
 const digest=new crypto.DigestStream('SHA-256');
 await source.body.pipeTo(digest);const hash=await digest.digest;
 const asset=hex(hash)+'.'+MIME[type];const dest=PREFIX+asset;
 // Second read is conditional on the version actually hashed. R2 additionally
 // checks the streamed SHA-256 while writing, closing both replacement windows.
 const copy=await env.JOM_MEDIA.get(key,{onlyIf:{etagMatches:source.etag}});
 if(!copy?.body)fail('media_changed');
 await env.JOM_MEDIA.put(dest,copy.body,{sha256:hash,onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:type,cacheControl:'no-store'}});
 await verified(env,asset,kind);
 return origin+'/api/threads-media?asset='+asset;
}
export async function prepareMedia(env,body,origin){
 const input=assets(body);if(!input.length)return {...body};
 const frozen=[];for(const a of input)frozen.push(await freeze(env,a.url,a.kind,origin));
 if(body.carouselImages?.length){const out={...body,carouselImages:frozen};delete out.mediaUrl;delete out.mediaType;return out;}
 return {...body,mediaUrl:frozen[0]};
}
export async function serveMedia(request,env){
 const bad=(error,status)=>Response.json({success:false,error},{status,headers:{'Cache-Control':'no-store'}});
 if(!['GET','HEAD'].includes(request.method))return bad('method not allowed',405);
 const asset=new URL(request.url).searchParams.get('asset');if(!ASSET.test(asset||''))return bad('invalid_asset',400);
 try{
  const m=await verified(env,asset);
  const headers={'Content-Type':m.type,'Content-Length':String(m.size),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','ETag':'"'+m.sha256+'"','Accept-Ranges':'bytes'};
  if(request.method==='HEAD')return new Response(null,{headers});
  const range=request.headers.get('Range');let spec;
  if(range){
   const match=/^bytes=(\d+)-(\d*)$/.exec(range);
   if(!match)return bad('invalid_range',416);
   const start=Number(match[1]),end=match[2]?Number(match[2]):m.size-1;
   if(start>end||end>=m.size)return bad('invalid_range',416);
   spec={offset:start,length:end-start+1};headers['Content-Range']=`bytes ${start}-${end}/${m.size}`;headers['Content-Length']=String(spec.length);
  }
  const obj=await env.JOM_MEDIA.get(m.key,{onlyIf:{etagMatches:m.etag},...(spec?{range:spec}:{})});
  if(!obj?.body || !obj.checksums?.sha256 || hex(obj.checksums.sha256)!==m.sha256) return bad('media_integrity',409);
  return new Response(obj.body,{status:spec?206:200,headers});
 }catch{return bad('media_integrity',409);}
}
