const UI_ICONS={doc:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:inline-block;vertical-align:-3px"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',edit:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:inline-block;vertical-align:-3px"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/></svg>',clock:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:inline-block;vertical-align:-3px"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',check:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:inline-block;vertical-align:-3px"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',note:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:inline-block;vertical-align:-3px"><path d="M14 4v10.5a3.5 3.5 0 1 1-3.5-3.5"/><path d="M14 4c.4 2.4 2 4 4.5 4.2"/></svg>'};
/* UI improvements use the existing workspace, editor and Pages API contracts. */
let plannerView = localStorage.getItem('jomContentPlannerView') === 'board' ? 'board' : 'list';
let plannerPage = 1, plannerFilterKey = '', selectedPlannerDate = '';
let editorSaving = false, editorBaseline = '', editorDraftKey = '', editorReturnFocus = null;
let editorCreateId = '', editorCreateAttempted = false;
const editorFields = ['mPostId','mPlatform','mTitle','mCaption','mDate','mTime','mPillar','mStatus','mNotes'];
const statusLabels = {draft:'Draft',scheduled:'Scheduled',posted:'Posted',failed:'Failed'};
const statusOf = post => post.status === 'published' ? 'posted' : (post.status || 'draft');
const isDone = post => statusOf(post) === 'posted';
const attentionNeeded = post => !isDone(post) && (statusOf(post) === 'failed' || (post.date && post.date < todayStr()));
const ui = id => document.getElementById(id);
function nextWeekEnd() { const d = new Date(); d.setDate(d.getDate()+6); return localDateStr(d); }
function inSelectedMonth(post) { return Boolean(post.date && post.date.startsWith(state.dashMonth.year+'-'+String(state.dashMonth.month+1).padStart(2,'0')+'-')); }
function switchPage(page) { document.querySelector('.nav-tab[data-tab="'+page+'"]')?.click(); }
function newPost(platform = 'threads') { openModal(platform); }
function goToday() { const n = new Date(); state.dashMonth = {year:n.getFullYear(),month:n.getMonth()}; saveState(); renderDashboard(); }
function setSyncStatus(value) {
  const el = ui('syncControl'); if (!el) return;
  el.dataset.state = value;
  const label = value==='loading' ? 'Menyegerak…' : value==='error' ? 'Gagal sync · cuba lagi' : 'Disegerak';
  el.querySelector('.sync-label').textContent = label;
  el.setAttribute('aria-label',label+'. Klik untuk refresh.');
}

renderWorkspaceIntro = function() {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Selamat pagi' : hour < 18 ? 'Selamat petang' : 'Selamat malam';
  const date = new Date().toLocaleDateString('ms-MY',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  ui('workspaceIntro').innerHTML = `<div class="workspace-intro"><div class="welcome"><div class="eyebrow">${esc(currentWorkspace().name)} / Content workspace</div><h1>${greeting}. Jom cipta content.</h1><p>Susun idea, siapkan draft, dan nampak apa yang perlu dibuat seterusnya.</p></div><div class="date-stamp">${esc(date)}</div></div>`;
};

function renderFocus() {
  const posts = scopedPosts(), today = todayStr();
  const due = posts.filter(p=>p.date===today && !isDone(p));
  const pending = posts.filter(attentionNeeded);
  const next = posts.filter(p=>!isDone(p) && p.date>=today).sort((a,b)=>(a.date+(a.time||'')).localeCompare(b.date+(b.time||'')))[0];
  const days = Array.from({length:7},(_,i)=>{
    const d = new Date(); d.setDate(d.getDate()+i); const key=localDateStr(d);
    const count = posts.filter(p=>p.date===key).length;
    return `<button class="week-day ${i===0?'today':''}" data-day="${key}" aria-label="${esc(formatDate(key))}, ${count} post"><small>${i===0?'Hari ini':esc(d.toLocaleDateString('ms-MY',{weekday:'short'}))}</small><strong>${d.getDate()}</strong><span class="day-dots">${Array.from({length:Math.min(count,3)},()=>'<i></i>').join('')}</span></button>`;
  }).join('');
  ui('focusPanel').innerHTML=`<div class="focus-grid"><div class="focus-card"><div class="section-hdr"><h2>Fokus hari ini</h2><span class="live-label">${due.length} belum siap</span></div><div class="week-strip">${days}</div><div class="focus-note"><span class="focus-arrow">↗</span><span>${pending.length?`<strong>${pending.length} post perlukan perhatian.</strong><br>Semak tarikh lepas atau status failed.`:'<strong>Ruang untuk idea seterusnya.</strong><br>Rancang content untuk tujuh hari akan datang.'}</span><button class="text-button" id="focusAction">${pending.length?'Semak post →':'Lihat minggu →'}</button></div></div><div class="focus-card queue-card"><div><div class="eyebrow">Seterusnya dalam perancangan</div><h3>${next?esc(next.title):'Idea yang bagus bermula dengan satu draft.'}</h3><div class="queue-meta">${next?`<span>${esc(PLATFORM_NAMES[next.platform]||next.platform)}</span><span>${esc(statusLabels[statusOf(next)]||statusOf(next))}</span>`:'<span>TikTok + Threads</span>'}</div></div><div class="queue-bottom"><button id="openNextPost">${next?'Sambung edit ↗':'Cipta draft pertama ↗'}</button><span class="queue-date">${next?esc(formatDate(next.date))+' · '+esc(next.time||'Masa belum ditetapkan'):'Simpan idea, bina momentum.'}</span></div></div></div>`;
  ui('focusPanel').querySelectorAll('[data-day]').forEach(button=>button.onclick=()=>{resetPlannerFilters(false);selectedPlannerDate=button.dataset.day;ui('plannerRange').value='all';showPlanner();});
  ui('focusAction').onclick=()=>filterPlanner(pending.length?'attention':'week');
  ui('openNextPost').onclick=()=>next?openModal(next.platform,next.id):newPost();
}

renderDashboard = function() {
  ui('dashPeriod').textContent=new Date(state.dashMonth.year,state.dashMonth.month,1).toLocaleDateString('ms-MY',{month:'long',year:'numeric'});
  renderWorkspaceIntro(); renderFocus();
  const posts=scopedPosts().filter(inSelectedMonth),done=posts.filter(isDone).length;
  const stats=[
    {label:'Jumlah content',num:posts.length,sub:'Dalam bulan dipilih',icon:UI_ICONS.doc,status:'all'},
    {label:'Draft untuk disiapkan',num:posts.filter(p=>statusOf(p)==='draft').length,sub:'Sambung idea yang belum siap',icon:UI_ICONS.edit,status:'draft'},
    {label:'Dalam perancangan',num:posts.filter(p=>statusOf(p)==='scheduled').length,sub:'Status scheduled dalam planner',icon:UI_ICONS.clock,status:'scheduled',class:'stat-warning'},
    {label:'Sudah posted',num:done,sub:(posts.length?Math.round(done/posts.length*100):0)+'% daripada content bulan ini',icon:UI_ICONS.check,status:'posted',class:'stat-success'}
  ];
  ui('dashStats').innerHTML=stats.map(s=>`<button class="card card-stat ${s.class||''}" data-stat="${s.status}"><div class="stat-top"><span class="label">${s.label}</span><span class="stat-icon">${s.icon}</span></div><div class="num">${s.num}</div><div class="sub">${s.sub}</div><div class="stat-track"><span style="width:${posts.length?s.num/posts.length*100:0}%"></span></div></button>`).join('');
  ui('dashStats').querySelectorAll('[data-stat]').forEach(b=>b.onclick=()=>{resetPlannerFilters(false);ui('plannerStatus').value=b.dataset.stat;showPlanner();});
  ui('hdrMonthPosts').textContent=posts.length;ui('hdrPosted').textContent=done;
  updateNavBadges();
  if(document.querySelector('.insights-section').open){drawChart('chartPlatform',posts,'platform');drawChart('chartPillar',posts,'pillar');}
  renderDashTimeline();
};

function showPlanner() { switchPage('dashboard'); renderDashTimeline(); ui('contentLibrary').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'}); }
function filterPlanner(range) { resetPlannerFilters(false);ui('plannerRange').value=range;showPlanner(); }
function resetPlannerFilters(render=true) {
  selectedPlannerDate='';ui('dashSearch').value='';ui('plannerPlatform').value='all';ui('plannerStatus').value='all';ui('plannerRange').value='month';ui('plannerSort').value='asc';plannerPage=1;
  if(render) renderDashTimeline();
}
function setPlannerView(view){plannerView=view;plannerPage=1;localStorage.setItem('jomContentPlannerView',view);renderDashTimeline();}
function getPlannerPosts() {
  const q=ui('dashSearch').value.trim().toLocaleLowerCase(),platform=ui('plannerPlatform').value,status=ui('plannerStatus').value,range=ui('plannerRange').value;
  let posts=scopedPosts().filter(p=>(platform==='all'||p.platform===platform)&&(status==='all'||statusOf(p)===status));
  if(selectedPlannerDate) posts=posts.filter(p=>p.date===selectedPlannerDate);
  else if(range==='month')posts=posts.filter(inSelectedMonth);
  else if(range==='week')posts=posts.filter(p=>p.date>=todayStr()&&p.date<=nextWeekEnd());
  else if(range==='today')posts=posts.filter(p=>p.date===todayStr());
  else if(range==='attention')posts=posts.filter(attentionNeeded);
  if(q)posts=posts.filter(p=>[p.title,p.caption,p.pillar,p.notes,PLATFORM_NAMES[p.platform]].some(v=>String(v||'').toLocaleLowerCase().includes(q)));
  const sort=ui('plannerSort').value;
  return posts.sort((a,b)=>sort==='title'?String(a.title||'').localeCompare(String(b.title||'')):((a.date||'9999')+(a.time||'')).localeCompare((b.date||'9999')+(b.time||''))*(sort==='desc'?-1:1));
}
function plannerCard(post,index,board=false) {
  const status=statusOf(post), label=statusLabels[status]||status;
  return `<button class="${board?'board-card':'planner-row'}" data-post-id="${esc(post.id)}" style="--i:${index}" aria-label="Edit ${esc(post.title||'Tanpa tajuk')}"><span class="post-platform-icon ${esc(post.platform)}" title="${esc(PLATFORM_NAMES[post.platform]||post.platform)}">${post.platform==='threads'?'@':UI_ICONS.note}</span><span class="planner-copy"><strong>${esc(post.title||'Tanpa tajuk')}</strong><small><span class="pillar-mini" style="--pillar-color:${getPillarColor(post.pillar)}">${esc(post.pillar||'Tiada pillar')}</span>${post.approved?' · Approved':''}</small></span><span class="planner-date">${post.date?esc(formatDate(post.date))+' '+esc(post.date.slice(0,4)):'Belum bertarikh'}<small>${esc(post.time||'Masa belum ditetapkan')}</small></span>${board?'':`<span class="p-status status-${Object.hasOwn(statusLabels,status)?status:'draft'}">${esc(label)}</span><span class="row-chevron">↗</span>`}</button>`;
}
renderDashTimeline = function() {
  if(!ui('plannerPlatform')) return;
  const key=[state.workspace,JSON.stringify(state.dashMonth),selectedPlannerDate,...['dashSearch','plannerPlatform','plannerStatus','plannerRange','plannerSort'].map(id=>ui(id).value)].join('|');
  if(key!==plannerFilterKey){plannerPage=1;plannerFilterKey=key;}
  const posts=getPlannerPosts(),container=ui('dashTimeline'),size=20,pages=Math.max(1,Math.ceil(posts.length/size));
  plannerPage=Math.min(plannerPage,pages);
  ui('dashTotalPosts').textContent=posts.length;
  const range=selectedPlannerDate?formatDate(selectedPlannerDate)+' '+selectedPlannerDate.slice(0,4):ui('plannerRange').selectedOptions[0].textContent+(ui('plannerRange').value==='month'?' · '+ui('dashPeriod').textContent:'');
  ui('filterSummary').textContent=posts.length+' content · '+range;
  ['list','board'].forEach(v=>ui('view-'+v).setAttribute('aria-pressed',String(v===plannerView)));
  if(!posts.length){container.className='';container.innerHTML='<div class="empty-planner"><strong>Belum ada content di sini.</strong><p>Cuba ubah filter, atau mulakan dengan satu idea baru.</p><button class="btn btn-outline btn-sm" onclick="resetPlannerFilters()">Reset filter</button> <button class="btn btn-primary btn-sm" onclick="newPost()">+ Cipta post</button></div>';ui('plannerPagination').innerHTML='';return;}
  if(plannerView==='board'){
    container.className='planner-board';
    const statuses=[...new Set([...Object.keys(statusLabels),...posts.map(statusOf)])];
    container.innerHTML=statuses.map(status=>{const group=posts.filter(p=>statusOf(p)===status);return `<section class="board-column"><div class="board-heading">${esc(statusLabels[status]||status)}<span>${group.length}</span></div>${group.length?group.slice(0,plannerPage*size).map((p,i)=>plannerCard(p,i,true)).join(''):'<div class="board-empty">Tiada content</div>'}</section>`;}).join('');
    ui('plannerPagination').innerHTML=statuses.some(status=>posts.filter(p=>statusOf(p)===status).length>plannerPage*size)?'<button class="btn btn-outline btn-sm" id="loadBoard">Papar lebih banyak</button>':'';
    if(ui('loadBoard'))ui('loadBoard').onclick=()=>{plannerPage++;renderDashTimeline();};
  }else{
    container.className='planner-list';
    container.innerHTML=posts.slice((plannerPage-1)*size,plannerPage*size).map((p,i)=>plannerCard(p,i)).join('');
    ui('plannerPagination').innerHTML=pages>1?`<button class="btn btn-sm btn-outline" id="plannerPrev" ${plannerPage===1?'disabled':''}>← Sebelum</button><span>${plannerPage} / ${pages}</span><button class="btn btn-sm btn-outline" id="plannerNext" ${plannerPage===pages?'disabled':''}>Seterusnya →</button>`:'';
    if(ui('plannerPrev'))ui('plannerPrev').onclick=()=>{plannerPage--;renderDashTimeline();};
    if(ui('plannerNext'))ui('plannerNext').onclick=()=>{plannerPage++;renderDashTimeline();};
  }
  container.querySelectorAll('[data-post-id]').forEach(b=>b.onclick=()=>{const p=scopedPosts().find(p=>p.id===b.dataset.postId);if(p)openModal(p.platform,p.id);});
};

function editorSnapshot() {return JSON.stringify({values:Object.fromEntries(editorFields.map(id=>[id,ui(id).value])),approved:ui('mApproved').checked,images:_modalImages,createId:editorCreateId,createAttempted:editorCreateAttempted});}
function initEditorSession(){
  editorReturnFocus=document.activeElement;
  editorCreateId=crypto.randomUUID();editorCreateAttempted=false;
  // Legacy imported posts may use published or an older pillar; never erase them on edit.
  const existing=scopedPosts().find(p=>p.id===ui('mPostId').value);
  if(existing){
    if(![...ui('mPillar').options].some(o=>o.value===existing.pillar)&&existing.pillar)ui('mPillar').add(new Option(existing.pillar,existing.pillar));
    ui('mPillar').value=existing.pillar||ui('mPillar').value;
    const status=statusOf(existing);if(![...ui('mStatus').options].some(o=>o.value===status))ui('mStatus').add(new Option(status,status));
    ui('mStatus').value=status;
  }
  editorBaseline=editorSnapshot();editorDraftKey='jomContentEditor:'+state.workspace+':'+(ui('mPostId').value||'new');
  updateCaptionCount();setEditorBusy(false);
  let recovered;try{recovered=JSON.parse(sessionStorage.getItem(editorDraftKey));}catch{}
  ui('draftRecovery').hidden=!recovered;
  if(recovered){ui('draftRecovery').innerHTML='Ada draft belum disimpan dalam tab ini. <button class="text-button" id="restoreDraft">Pulihkan</button> <button class="text-button" id="discardDraft">Abaikan</button>';ui('restoreDraft').onclick=()=>{editorFields.forEach(id=>{if(id!=='mPostId')ui(id).value=recovered.values[id]||'';});ui('mApproved').checked=!!recovered.approved;_modalImages=recovered.images||[];editorCreateId=recovered.createId||editorCreateId;editorCreateAttempted=!!recovered.createAttempted;renderMediaPreview(_modalImages);ui('draftRecovery').hidden=true;updateCaptionCount();};ui('discardDraft').onclick=()=>{clearEditorDraft();ui('draftRecovery').hidden=true;};}
}
function rememberEditorDraft(){if(editorDraftKey && editorSnapshot()!==editorBaseline)try{sessionStorage.setItem(editorDraftKey,editorSnapshot());}catch{}}
function clearEditorDraft(){try{sessionStorage.removeItem(editorDraftKey);}catch{}}
function restoreEditorFocus(){if(editorReturnFocus?.isConnected)editorReturnFocus.focus();}
function closeEditorSafely(){
  if(!ui('postModal').classList.contains('open'))return true;
  if(editorSaving)return false;
  if(editorSnapshot()!==editorBaseline){rememberEditorDraft();if(!confirm('Perubahan belum disimpan ke dashboard. Tutup editor? Draft kekal dalam tab ini untuk dipulihkan.'))return false;}
  ui('postModal').classList.remove('open');restoreEditorFocus();return true;
}
function setEditorBusy(busy){editorSaving=busy;ui('postModal').setAttribute('aria-busy',String(busy));ui('postModal').querySelectorAll('input,textarea,select,button').forEach(el=>el.disabled=busy);ui('savePostButton').textContent=busy?'Menyimpan…':'Simpan post';}
function updateCaptionCount(){const count=Array.from(ui('mCaption').value).length;ui('captionCount').textContent=count+' aksara';}
function changeEditorPlatform(){const value=ui('mPillar').value;ui('mPillar').replaceChildren(...workspacePillars(ui('mPlatform').value).map(p=>new Option(p,p)));if([...ui('mPillar').options].some(o=>o.value===value))ui('mPillar').value=value;rememberEditorDraft();}
async function copyCaption(){try{await navigator.clipboard.writeText(ui('mCaption').value);showToast('Caption disalin.','success');}catch{ui('mCaption').select();showToast('Pilih Copy untuk salin caption.','info');}}

duplicatePost=function(){
  if(editorSaving)return;
  ui('mPostId').value='';ui('mTitle').value+=' (Salinan)';ui('mStatus').value='draft';ui('mApproved').checked=false;
  ui('modalTitle').textContent='Duplikat post';ui('mDeleteBtn').style.display='none';ui('mDupeBtn').style.display='none';
  editorCreateId=crypto.randomUUID();editorCreateAttempted=false;editorDraftKey='jomContentEditor:'+state.workspace+':new';rememberEditorDraft();
  showToast('Salinan sedia untuk diedit. Tekan Simpan post bila siap.');
};

deletePost=async function(){
  if(editorSaving)return;
  const id=ui('mPostId').value;if(!id||!confirm('Padam post ini daripada dashboard?'))return;
  setEditorBusy(true);
  const result=await apiFetch('DELETE',null,id);
  setEditorBusy(false);
  if(!result.success){showToast('Belum dapat sahkan pemadaman. Refresh untuk semak status.','error');return;}
  state.posts=state.posts.filter(p=>p.id!==id);clearEditorDraft();editorBaseline=editorSnapshot();saveState();renderAll();closeModal();showToast('Post dipadam.','success');
};

function openCommand(){if(document.body.classList.contains('auth-locked'))return;ui('commandDialog').showModal();ui('commandInput').value='';renderCommand();ui('commandInput').focus();}
function closeCommand(){ui('commandDialog').close();}
function renderCommand(){
  const q=ui('commandInput').value.trim().toLocaleLowerCase();
  const posts=scopedPosts().filter(p=>!q||[p.title,p.caption,p.pillar].some(v=>String(v||'').toLocaleLowerCase().includes(q))).slice(0,15);
  ui('commandResults').innerHTML=(!q?'<button class="command-result" data-new="threads"><span class="focus-arrow">+</span><span><strong>Cipta post Threads</strong><small>Mulakan draft baru</small></span></button><button class="command-result" data-new="tiktok"><span class="focus-arrow">+</span><span><strong>Cipta post TikTok</strong><small>Rancang skrip video</small></span></button>':'')+posts.map(p=>`<button class="command-result" data-open="${esc(p.id)}"><span class="post-platform-icon">${p.platform==='threads'?'@':UI_ICONS.note}</span><span><strong>${esc(p.title)}</strong><small>${esc(PLATFORM_NAMES[p.platform]||p.platform)} · ${esc(p.date||'Belum bertarikh')} · ${esc(statusLabels[statusOf(p)]||statusOf(p))}</small></span></button>`).join('')+(q&&!posts.length?'<div class="empty-planner"><strong>Tiada padanan.</strong><p>Cuba kata kunci lain.</p></div>':'');
  ui('commandResults').querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>{const p=scopedPosts().find(p=>p.id===b.dataset.open);closeCommand();if(p)openModal(p.platform,p.id);});
  ui('commandResults').querySelectorAll('[data-new]').forEach(b=>b.onclick=()=>{closeCommand();newPost(b.dataset.new);});
}
function initWorkspaceKeyboard(){
  document.addEventListener('keydown',e=>{
    if(document.body.classList.contains('auth-locked'))return;
    const editorOpen=ui('postModal').classList.contains('open'),previewOpen=ui('previewOverlay').classList.contains('open');
    if(e.key==='Escape'){if(ui('commandDialog').open)return;if(previewOpen){closePostPreview();return;}if(editorOpen){closeModal();return;}ui('sidebar').classList.remove('open');ui('sidebarOverlay').classList.remove('open');return;}
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'&&!editorOpen&&!previewOpen){e.preventDefault();openCommand();return;}
    if(ui('commandDialog').open){const buttons=[...ui('commandResults').querySelectorAll('button')];let i=buttons.indexOf(document.activeElement);if(e.key==='ArrowDown'){e.preventDefault();buttons[(i+1)%buttons.length]?.focus();}if(e.key==='ArrowUp'){e.preventDefault();if(i<=0)ui('commandInput').focus();else buttons[i-1]?.focus();}if(e.key==='Enter'&&document.activeElement===ui('commandInput')){e.preventDefault();buttons[0]?.click();}return;}
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s'&&editorOpen){e.preventDefault();savePost();return;}
    if(e.key==='Tab'&&(editorOpen||previewOpen)){const modal=previewOpen?ui('previewOverlay'):ui('postModal');const fields=[...modal.querySelectorAll('button,input,textarea,select,a[href]')].filter(el=>!el.disabled&&el.offsetParent!==null);const first=fields[0],last=fields.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}return;}
    const field=document.activeElement.matches('input,textarea,select,[contenteditable=true]');
    if(!field&&!editorOpen&&!previewOpen&&e.key.toLowerCase()==='n'&&!e.metaKey&&!e.ctrlKey&&!e.altKey){e.preventDefault();newPost(PLATFORMS.includes(state.currentTab)?state.currentTab:'threads');}
    if(!field&&!editorOpen&&!previewOpen&&e.key==='/'){e.preventDefault();openCommand();}
  });
}

document.addEventListener('DOMContentLoaded',()=>{
  const sidebarFooter=document.createElement('div');sidebarFooter.className='sidebar-footer';sidebarFooter.innerHTML='<span class="avatar">JD</span><div><strong>Jom Digital</strong><small>Content workspace</small></div><button class="text-button" onclick="logoutDashboard()" aria-label="Log keluar">↗</button>';ui('sidebar').append(sidebarFooter);
  const controls=document.createElement('div');controls.className='top-bar-right workspace-actions';controls.innerHTML='<button class="sync-control" id="syncControl" data-state="loading" onclick="apiFetchAll()" aria-label="Refresh data"><span class="sync-dot"></span><span class="sync-label">Menyegerak…</span></button><button class="global-create" onclick="newPost()">+ Cipta post</button>';
  document.querySelector('.top-bar-inner').append(controls);
  const dialog=document.createElement('dialog');dialog.id='commandDialog';dialog.className='command-dialog';dialog.setAttribute('aria-label','Cari content dan tindakan');dialog.innerHTML='<div class="command-search"><input id="commandInput" aria-label="Cari semua content" placeholder="Cari semua content atau cipta draft…" autocomplete="off"><button onclick="closeCommand()">Esc</button></div><div id="commandResults" class="command-results"></div><div class="command-footer">↑ ↓ navigasi · Enter buka · Semua tarikh, workspace semasa</div>';document.body.append(dialog);ui('commandInput').oninput=renderCommand;
  dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeCommand();}});
  ui('postModal').addEventListener('input',()=>{updateCaptionCount();rememberEditorDraft();});
  ui('postModal').addEventListener('change',rememberEditorDraft);
  document.querySelectorAll('.form-group').forEach(group=>{const label=group.querySelector('label'),field=group.querySelector('input:not([type=hidden]),textarea,select');if(label&&field&&!label.htmlFor)label.htmlFor=field.id;});
  ui('plannerRange').addEventListener('change',()=>{selectedPlannerDate='';renderDashTimeline();});
  document.querySelector('.insights-section').addEventListener('toggle',()=>{if(document.querySelector('.insights-section').open){const posts=scopedPosts().filter(inSelectedMonth);drawChart('chartPlatform',posts,'platform');drawChart('chartPillar',posts,'pillar');}});
  window.addEventListener('beforeunload',e=>{if(editorSaving||(ui('postModal').classList.contains('open')&&editorSnapshot()!==editorBaseline)){rememberEditorDraft();e.preventDefault();e.returnValue='';}});
  // Prototype preview is only activated by the local preview server.
  if(window.JOM_PREVIEW){const banner=document.createElement('div');banner.className='preview-banner';banner.textContent='PREVIEW · Data contoh. Perubahan dalam preview ini tidak dihantar ke dashboard live.';document.querySelector('.app-body').prepend(banner);}
});
