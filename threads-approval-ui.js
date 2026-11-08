// Owner-visible frozen-media review. Approval is a separate request made only
// after this dialog (exact caption, account, checksum-addressed media) is shown.
(function(){
 function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
 function isFrozen(url){try{const u=new URL(url);return u.pathname==='/api/threads-media'&&/^[a-f0-9]{64}\.(png|jpg|webp|mp4|mov|webm)$/.test(u.searchParams.get('asset')||'');}catch{return false;}}
 function media(item){return item.kind==='video'
  ? `<video src="${esc(item.url)}" muted playsinline preload="metadata" controls style="width:100%;max-height:52vh;border-radius:10px;background:#000"></video>`
  : `<img src="${esc(item.url)}" alt="Media yang akan dipost" style="width:100%;max-height:52vh;object-fit:contain;border-radius:10px;background:#111">`;}
 window.reviewThreadsMedia=function(id,body,prepare){
  return new Promise(async(mainResolve)=>{
   const dlg=document.createElement('dialog');let settled=false,approved=null,username='';
   const close=value=>{if(settled)return;settled=true;if(dlg.open)dlg.close();dlg.remove();mainResolve(value);};
   dlg.setAttribute('aria-labelledby','threadsReviewTitle');
   dlg.innerHTML=`<form method="dialog" style="margin:0;max-width:min(92vw,560px)">
    <h2 id="threadsReviewTitle" style="margin:0 0 10px;font-size:18px">Semak sebelum post ke Threads</h2>
    <div data-media aria-live="polite" style="margin-bottom:10px;min-height:120px;display:grid;gap:8px"></div>
    <p style="margin:0 0 6px;font-size:13px;color:#555">Caption yang akan dipost</p>
    <pre data-caption style="white-space:pre-wrap;word-break:break-word;max-height:30vh;overflow:auto;font:inherit;font-size:14px;background:#f6f6f6;padding:10px;border-radius:8px;margin:0 0 10px"></pre>
    <p data-account style="margin:0 0 10px;font-size:13px"></p>
    <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
     <button type="button" data-threads-cancel>Batal</button>
     <button type="submit" data-threads-approve disabled>Approve &amp; teruskan</button>
    </div></form>`;
   document.body.appendChild(dlg);dlg.showModal();
   const mediaBox=dlg.querySelector('[data-media]'),caption=dlg.querySelector('[data-caption]'),approveBtn=dlg.querySelector('[data-threads-approve]');
   dlg.querySelector('[data-threads-cancel]').onclick=()=>close(null);
   dlg.oncancel=event=>{event.preventDefault();close(null);};
   dlg.onsubmit=event=>{event.preventDefault();if(approveBtn.disabled||!approved)return;approveBtn.disabled=true;approveBtn.textContent='Menghantar…';settled=true;if(dlg.open)dlg.close();dlg.remove();mainResolve({...approved,username});};
   let preview;
   try{preview=await prepare();}catch(error){mediaBox.textContent='Sediakan media gagal. Batal dan cuba lagi.';return;}
   if(!preview||!preview.success||!preview.body){mediaBox.textContent='Sediakan media gagal. Batal dan cuba lagi.';return;}
   const b=preview.body,items=b.carouselImages?.length?b.carouselImages.map(url=>({url,kind:'image'})):(b.mediaUrl?[{url:b.mediaUrl,kind:b.mediaType}]:[]);
   username=preview.username||'';
   if(items.length && !items.every(x=>isFrozen(x.url))){mediaBox.textContent='Media bukan snapshot yang disahkan. Batal dan sediakan semula.';return;}
   caption.textContent=b.caption||'';dlg.querySelector('[data-account]').textContent='Account: @'+(preview.username||b.accountId||'');
   mediaBox.innerHTML=items.map(media).join('')||'<span>Teks sahaja</span>';
   const nodes=[...mediaBox.querySelectorAll('img,video')];
   let failed=false;const fail=()=>{failed=true;mediaBox.innerHTML+='<p role="alert" data-media-error>Media gagal dimuatkan. Batal dan sediakan semula.</p>';approveBtn.disabled=true;};
   await Promise.all(nodes.map(node=>new Promise(done=>{
    if(node.tagName==='IMG'&&node.complete)return done(node.naturalWidth?null:fail());
    node.addEventListener(node.tagName==='IMG'?'load':'loadeddata',()=>done(),{once:true});node.addEventListener('error',()=>{fail();done();},{once:true});
    setTimeout(()=>{if(node.tagName==='IMG'&&!node.complete)fail();done();},8000);
   })));
   if(!failed)approveBtn.disabled=false;
   approved=b;
  });
 };
})();
