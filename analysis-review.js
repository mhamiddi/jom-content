// Owner review for Threads analysis records.
// All hashes and decisions come from /api/threads-analysis. This file only
// renders the server view and echoes back the server-computed hash; it never
// computes approval locally and never publishes anything.
const $ = (selector) => document.querySelector(selector);
const reviewsEl = $('#reviews');
const gate = $('#gate');
const app = $('#app');
const loadState = $('#loadState');
const toastEl = $('#toast');
const confirmDialog = $('#confirmDialog');

const STATUS = {
  pending: ['status-pending', 'Menunggu semakan'],
  approved: ['status-approved', 'Diluluskan'],
  revise: ['status-revise', 'Perlu revisi'],
  rejected: ['status-rejected', 'Ditolak'],
};
const DECISION_LABEL = { approved: 'Diluluskan', revise: 'Revisi diminta', rejected: 'Ditolak' };
const CLASSIFICATION = {
  performing: ['performing', 'Performing'],
  underperforming: ['underperforming', 'Underperforming'],
  borderline: ['borderline', 'Borderline'],
};
const METRICS = [
  ['views', 'Views'], ['likes', 'Likes'], ['replies', 'Replies'],
  ['reposts', 'Reposts'], ['quotes', 'Quotes'], ['shares', 'Shares'],
  ['saves', 'Saves'], ['comments', 'Comments'],
];
const CONFIDENCE = {
  high: ['conf-high', 'Keyakinan tinggi'],
  medium: ['conf-medium', 'Keyakinan sederhana'],
  low: ['conf-low', 'Keyakinan rendah'],
};

const state = { reviews: [], filter: 'all', preview: false };
let pendingApprove = null;
// Unsaved owner input (decision note, post edit, open editor) is kept here so a
// re-render caused by a decision on another card never discards it.
const drafts = { notes: new Map(), edits: new Map(), open: new Map() };
// Where keyboard focus should land after the next re-render; a busy button is
// disabled mid-request, so the live focus is already lost by then.
let focusIntent = null;

const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const fmt = (value) => (typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : '—');
const pct = (value) => (typeof value === 'number' && Number.isFinite(value) ? (value > 0 ? '+' : '') + Math.round(value) + '%' : null);

function safeUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value, location.href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch { return ''; }
}

function when(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.classList.toggle('error', isError);
  toastEl.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toastEl.classList.remove('show'), 4200);
}

// Server codes stay machine-readable; owners only ever see a sentence that
// says what happened and what to do next.
const FRIENDLY = {
  network: 'Tak dapat hubungi server preview. Pastikan server masih berjalan, kemudian cuba lagi.',
  cross_origin: 'Permintaan ditolak kerana asal halaman tidak sepadan dengan server. Buka semula halaman ini pada URL yang sama (localhost atau 127.0.0.1) dan cuba lagi.',
  stale_hash: 'Kandungan telah berubah. Muat semula halaman dan semak semula.',
  owner_session_required: 'Sesi pemilik tamat. Log masuk semula untuk meneruskan.',
  unauthorized: 'Sesi tamat. Log masuk semula untuk meneruskan.',
  agent_approval_forbidden: 'Kelulusan hanya boleh dibuat melalui sesi pemilik dalam browser.',
  lock_off: 'Kunci API belum diaktifkan pada server ini (JOM_API_TOKEN tiada).',
  owner_session_not_configured: 'Server perlu JOM_SESSION_SECRET yang berbeza daripada API token.',
  not_found: 'Analisis ini tidak lagi wujud. Muat semula halaman.',
  storage_unavailable: 'Storan server tidak tersedia. Cuba lagi sebentar.',
  invalid_post: 'Post tidak boleh kosong.',
  post_too_long: 'Post melebihi had 4,000 aksara. Pendekkan dan cuba lagi.',
  note_required: 'Nota sekurang-kurangnya 4 aksara diperlukan untuk revisi atau tolak.',
  note_too_long: 'Nota melebihi had 1,200 aksara. Pendekkan dan cuba lagi.',
  invalid_decision: 'Keputusan tidak sah. Muat semula halaman dan cuba lagi.',
  invalid_body: 'Permintaan tidak lengkap. Muat semula halaman dan cuba lagi.',
  invalid_hash: 'Hash kandungan tidak sah. Muat semula halaman dan cuba lagi.',
};

function friendly(error, fallback = 'Ralat tidak dijangka. Cuba lagi.') {
  const code = error?.code || (error?.status === 401 ? 'owner_session_required' : '');
  if (FRIENDLY[code]) return FRIENDLY[code];
  const message = String(error?.message || '').trim();
  if (message && message !== code && !/^HTTP \d+$/.test(message)) return message;
  return fallback;
}

function setLoad(message, type = 'loading') {
  loadState.hidden = !message;
  loadState.classList.toggle('error', type === 'error');
  $('#loadText').textContent = message || '';
}

function showGate(message = '') {
  app.hidden = true;
  gate.hidden = false;
  $('#gateError').textContent = message;
  setLoad('');
  focusIntent = null;
  setTimeout(() => { if (!$('#gateUser').value) $('#gateUser').focus(); }, 30);
}

function showApp() {
  gate.hidden = true;
  app.hidden = false;
}

async function request(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options });
  } catch {
    const offline = new Error('network');
    offline.code = 'network';
    throw offline;
  }
  let data = null;
  try { data = await response.json(); } catch { /* non-JSON error page */ }
  if (!response.ok) {
    const error = new Error(data?.message || data?.error || ('HTTP ' + response.status));
    error.status = response.status;
    error.code = data?.error;
    error.data = data;
    throw error;
  }
  return data || {};
}

function replaceReview(review) {
  const index = state.reviews.findIndex((item) => item.id === review.id);
  if (index >= 0) state.reviews[index] = review; else state.reviews.unshift(review);
}

async function load() {
  setLoad('Memuatkan analisis Threads…');
  try {
    const data = await request('/api/threads-analysis');
    state.reviews = Array.isArray(data.reviews) ? data.reviews : [];
    state.preview = Boolean(data.preview);
    $('#previewBanner').classList.toggle('show', state.preview);
    showApp();
    render();
    setLoad('');
  } catch (error) {
    if (error.status === 401 || error.code === 'owner_session_required') {
      showGate('');
      return;
    }
    if (error.code === 'lock_off') {
      showGate('API lock belum diaktifkan pada server ini (JOM_API_TOKEN tiada).');
      return;
    }
    if (error.code === 'owner_session_not_configured') {
      showGate('Server belum tetapkan JOM_SESSION_SECRET yang berasingan daripada API token.');
      return;
    }
    showApp();
    setLoad('Analisis tak dapat dimuatkan. ' + friendly(error), 'error');
  }
}

function statusChip(review) {
  const [cls, label] = STATUS[review.status] || STATUS.pending;
  const stale = review.stale ? '<span class="chip status-revise">Kandungan berubah</span>' : '';
  return '<span class="chip ' + cls + '">' + esc(label) + '</span>' + stale;
}

function confidenceChip(confidence) {
  const level = String(confidence?.level || '').toLowerCase();
  const map = CONFIDENCE[level] || ['conf', level ? level : 'Keyakinan tidak dinyatakan'];
  const score = typeof confidence?.score === 'number' ? ' ' + Math.round(confidence.score * 100) + '%' : '';
  return '<span class="chip ' + map[0] + '">' + esc(map[1]) + score + '</span>';
}

function metricTiles(metrics) {
  const rows = METRICS.filter(([key]) => typeof metrics?.[key] === 'number');
  return rows.length
    ? '<div class="metrics">' + rows.map(([key, label]) =>
        '<div class="metric"><div class="m-label">' + esc(label) + '</div><div class="m-value">' + fmt(metrics[key]) + '</div></div>').join('') + '</div>'
    : '<p class="hint">Tiada metrik rujukan direkod.</p>';
}

function deltaLine(comparison) {
  if (!comparison) return '';
  const value = pct(comparison.deltaPct);
  const baseline = typeof comparison.baselineMedian === 'number'
    ? 'median ' + fmt(comparison.baselineMedian) + ' ' + esc(comparison.metric || 'views') + (comparison.sampleDays ? ' · ' + comparison.sampleDays + ' hari' : '')
    : '';
  const note = comparison.note ? '<span>' + esc(comparison.note) + '</span>' : '';
  if (!value && !baseline) return '';
  const chip = value ? '<b class="' + (comparison.deltaPct >= 0 ? 'up' : 'down') + '">' + esc(value) + '</b>' : '';
  return '<div class="delta">' + chip + (baseline ? '<span>vs ' + baseline + '</span>' : '') + note + '</div>';
}

function sourceBlock(source) {
  if (!source) return '<p class="hint">Tiada rujukan sumber.</p>';
  const url = safeUrl(source.url);
  const link = url
    ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">Buka rujukan</a>'
    : '<span class="date">URL rujukan tiada</span>';
  const meta = [source.postId ? 'ID ' + source.postId : '', source.publishedAt ? when(source.publishedAt) : '']
    .filter(Boolean).map((item) => '<span class="date">' + esc(item) + '</span>').join('');
  return '<div class="ref"><div class="ref-top"><b>' + esc(source.label || source.type || 'Rujukan') + '</b>' + meta + link + '</div>'
    + (source.excerpt ? '<div class="excerpt">' + esc(source.excerpt) + '</div>' : '') + '</div>';
}

function evidenceList(evidence) {
  if (!evidence?.length) return '<p class="hint">Tiada bukti direkod.</p>';
  return '<ul class="evidence">' + evidence.map((item) => {
    const url = safeUrl(item.url);
    const src = [item.source ? esc(item.source) : '', url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">sumber</a>' : '']
      .filter(Boolean).join(' · ');
    const value = typeof item.value === 'number' ? fmt(item.value) : esc(item.value || '');
    return '<li><span>' + esc(item.claim || '') + '</span>' + (value ? '<span class="ev-val">' + value + '</span>' : '')
      + (src ? '<span class="ev-src">' + src + '</span>' : '') + '</li>';
  }).join('') + '</ul>';
}

function decisionMeta(review) {
  const decision = review.decision;
  if (!decision) return '<div class="decision-meta">Belum ada keputusan direkod.</div>';
  const label = DECISION_LABEL[decision.decision] || decision.decision;
  const prefix = decision.revokedAt
    ? 'Keputusan dibatalkan oleh edit: '
    : review.stale
      ? 'Keputusan lama (tidak sah): '
      : 'Keputusan terakhir: ';
  return '<div class="decision-meta">' + prefix + '<b>' + esc(label) + '</b> · ' + esc(when(decision.decidedAt)) + ' · oleh ' + esc(decision.decidedBy || 'owner')
    + (decision.note ? '<br>Nota: ' + esc(decision.note) : '') + '</div>';
}

// The N0 binding is what lets a host-side gate trust this review. It is shown
// exactly as the server normalised it, and a missing binding is stated plainly:
// such an approval never reaches the N0 document, so the owner must not assume
// it did.
function bindingBlock(review) {
  const binding = review.binding || {};
  if (!binding.candidateId) {
    return '<section class="block binding" data-binding="missing"><h3>Binding N0</h3>'
      + '<p class="b-warn">Tiada binding N0. Kelulusan ini hanya rekod semakan pemilik dan tidak akan masuk dokumen N0 host.</p>'
      + (review.bindingIssue ? '<p class="hint">Sebab: ' + esc(review.bindingIssue) + '</p>' : '')
      + '</section>';
  }
  const row = (key, value) => '<div class="b-row"><span class="b-key">' + esc(key) + '</span><code>' + esc(value) + '</code></div>';
  return '<section class="block binding" data-binding="ok"><h3>Binding N0</h3>'
    + row('Candidate', binding.candidateId)
    + row('Candidate hash', String(binding.candidateSha256 || '').slice(0, 16) + '…')
    + row('Analysis hash', String(binding.analysisSha256 || '').slice(0, 16) + '…')
    + row('Post ids', (binding.postIds || []).join(', ') || '—')
    + (review.bindingIssue
      ? '<div class="b-row b-warn">Binding tidak lengkap (' + esc(review.bindingIssue) + '); kelulusan tidak akan masuk N0.</div>'
      : '<div class="hint">Binding ini termasuk dalam hash kandungan. Menukar mana-mana nilai membatalkan kelulusan.</div>')
    + '</section>';
}

function card(review) {
  const classification = CLASSIFICATION[String(review.classification || '').toLowerCase()];
  const caseChip = classification
    ? '<span class="chip ' + classification[0] + '">' + classification[1] + '</span>'
    : (review.classification ? '<span class="chip">' + esc(review.classification) + '</span>' : '');
  const edited = review.ownerEdited ? '<span class="owner-edit">Diedit oleh pemilik</span>' : '';
  return '<article class="review" data-id="' + esc(review.id) + '">'
    + '<div class="rev-head">' + caseChip + confidenceChip(review.confidence) + statusChip(review)
    + '<span class="id">' + esc(review.id) + '</span></div>'

    + '<section class="block"><h3>Post dijana' + edited + '</h3>'
    + '<div class="post">' + esc(review.effectivePost) + '</div>'
    + '<details class="edit"><summary>Edit post dijana</summary>'
    + '<textarea data-edit rows="5" spellcheck="false">' + esc(review.effectivePost) + '</textarea>'
    + '<div class="edit-actions"><button type="button" class="btn primary" data-act="save-edit">Simpan edit</button>'
    + '<button type="button" class="btn ghost" data-act="reset-edit">Reset ke asal</button>'
    + '<span class="edit-warn">Edit menukar hash dan membatalkan kelulusan sedia ada.</span></div></details></section>'

    + '<section class="block"><h3>Sumber rujukan</h3>' + sourceBlock(review.source)
    + metricTiles(review.metrics) + deltaLine(review.comparison) + '</section>'

    + '<section class="block"><h3>Bukti</h3>' + evidenceList(review.evidence) + '</section>'

    + '<section class="block observation"><h3>Pemerhatian (apa data tunjuk)</h3><p>' + esc(review.observation || 'Tiada pemerhatian direkod.') + '</p></section>'

    + '<section class="block hypo"><h3>Hipotesis (belum terbukti) <span class="unproven">· bukan fakta</span></h3>'
    + (review.hypotheses?.length ? '<ol>' + review.hypotheses.map((item) => '<li>' + esc(item) + '</li>').join('') + '</ol>' : '<p class="hint">Tiada hipotesis direkod.</p>')
    + (review.confidence?.rationale ? '<p class="hint">Asas keyakinan: ' + esc(review.confidence.rationale) + '</p>' : '')
    + '</section>'

    + '<section class="block suggestion"><h3>Cadangan</h3><p>' + esc(review.suggestion || 'Tiada cadangan direkod.') + '</p></section>'

    + bindingBlock(review)
    + '<div class="hashline"><span class="h-label">Hash kandungan (dikira server)</span><code>' + esc(review.hash) + '</code>'
    + '<div class="h-note">Setiap keputusan di bawah terikat pada hash ini. Jika kandungan diedit atau dijana semula, hash berubah dan keputusan lama tidak sah.</div></div>'
    + '<div class="stale' + (review.stale ? ' show' : '') + '">Kandungan berubah atau diedit selepas keputusan terakhir. Semak semula dan buat keputusan baru.</div>'

    + '<div class="decide"><label for="note-' + esc(review.id) + '">Nota keputusan (wajib untuk Revisi atau Tolak)</label>'
    + '<textarea id="note-' + esc(review.id) + '" data-note rows="2" maxlength="1200" placeholder="Contoh: tukar hook baris pertama, kekalkan angka kos."></textarea>'
    + '<div class="acts"><button type="button" class="btn approve" data-act="approve">Luluskan</button>'
    + '<button type="button" class="btn revise" data-act="revise">Minta revisi</button>'
    + '<button type="button" class="btn reject" data-act="reject">Tolak</button></div>'
    + decisionMeta(review)
    + '<p class="hint">Kelulusan di sini hanya merekod review. Tiada post diterbitkan.</p></div>'
    + '</article>';
}

function filtered() {
  if (state.filter === 'all') return state.reviews;
  return state.reviews.filter((review) => review.status === state.filter);
}

function renderFilters() {
  document.querySelectorAll('#filters button').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter));
  });
  const counts = { all: state.reviews.length, pending: 0, approved: 0, revise: 0, rejected: 0 };
  state.reviews.forEach((review) => { if (counts[review.status] != null) counts[review.status] += 1; });
  document.querySelectorAll('#filters button').forEach((button) => {
    const base = button.dataset.filter === 'all' ? 'Semua' : STATUS[button.dataset.filter][1];
    button.textContent = base + ' (' + counts[button.dataset.filter] + ')';
  });
  $('#count').textContent = filtered().length + ' daripada ' + state.reviews.length + ' analisis';
}

function captureDrafts() {
  reviewsEl.querySelectorAll('.review[data-id]').forEach((node) => {
    const id = node.dataset.id;
    const note = node.querySelector('[data-note]');
    const edit = node.querySelector('[data-edit]');
    const details = node.querySelector('details.edit');
    if (note) drafts.notes.set(id, note.value);
    if (edit) drafts.edits.set(id, edit.value);
    if (details) drafts.open.set(id, details.open);
  });
}

function restoreDrafts() {
  reviewsEl.querySelectorAll('.review[data-id]').forEach((node) => {
    const id = node.dataset.id;
    const note = node.querySelector('[data-note]');
    const edit = node.querySelector('[data-edit]');
    const details = node.querySelector('details.edit');
    if (note && drafts.notes.has(id)) note.value = drafts.notes.get(id);
    if (edit && drafts.edits.has(id)) edit.value = drafts.edits.get(id);
    if (details && drafts.open.has(id)) details.open = drafts.open.get(id);
  });
}

function render() {
  const active = document.activeElement;
  const activeCard = active && active.closest ? active.closest('.review[data-id]') : null;
  const activeId = focusIntent?.id || activeCard?.dataset.id || '';
  const activeAction = focusIntent?.action || (activeCard && active.dataset.act ? active.dataset.act : '');
  captureDrafts();
  renderFilters();
  const rows = filtered();
  reviewsEl.innerHTML = rows.length
    ? rows.map(card).join('')
    : '<div class="empty">Tiada analisis untuk tapisan ini.</div>';
  restoreDrafts();
  focusIntent = null;
  if (activeId && activeAction) {
    const node = reviewsEl.querySelector('.review[data-id="' + (window.CSS?.escape ? CSS.escape(activeId) : activeId) + '"] [data-act="' + activeAction + '"]');
    node?.focus({ preventScroll: true });
  }
}

async function submitDecision(id, decision, note) {
  const review = state.reviews.find((item) => item.id === id);
  if (!review) return;
  setBusy(id, true);
  try {
    const data = await request('/api/threads-analysis?id=' + encodeURIComponent(id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, hash: review.hash, note }),
    });
    replaceReview(data.review);
    drafts.notes.delete(id);
    render();
    toast(DECISION_LABEL[decision] + ' direkod untuk ' + id + '.');
  } catch (error) {
    if (error.status === 409 && error.code === 'stale_hash') {
      toast('Kandungan berubah. Memuat semula untuk semakan baru…', true);
      await load();
    } else if (error.status === 401 || error.code === 'owner_session_required') {
      showGate('Sesi tamat. Log masuk semula.');
    } else {
      focusIntent = null;
      toast(friendly(error), true);
    }
  } finally {
    setBusy(id, false);
  }
}

async function saveEdit(id, value) {
  setBusy(id, true);
  try {
    const data = await request('/api/threads-analysis?id=' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ generatedPost: value }),
    });
    replaceReview(data.review);
    drafts.edits.delete(id);
    render();
    toast(data.review.stale ? 'Edit disimpan. Kelulusan lama tidak lagi sah.' : 'Edit disimpan.');
  } catch (error) {
    if (error.status === 401 || error.code === 'owner_session_required') showGate('Sesi tamat. Log masuk semula.');
    else { focusIntent = null; toast(friendly(error), true); }
  } finally {
    setBusy(id, false);
  }
}

async function resetEdit(id) {
  setBusy(id, true);
  try {
    const data = await request('/api/threads-analysis?id=' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset: true }),
    });
    replaceReview(data.review);
    drafts.edits.delete(id);
    render();
    toast('Edit dibuang. Post asal dipulihkan.');
  } catch (error) {
    if (error.status === 401 || error.code === 'owner_session_required') showGate('Sesi tamat. Log masuk semula.');
    else { focusIntent = null; toast(friendly(error), true); }
  } finally {
    setBusy(id, false);
  }
}

function setBusy(id, busy) {
  const node = reviewsEl.querySelector('[data-id="' + (window.CSS?.escape ? CSS.escape(id) : id.replace(/"/g, '\\"')) + '"]');
  if (!node) return;
  node.setAttribute('aria-busy', String(busy));
  node.querySelectorAll('button,textarea').forEach((element) => { element.disabled = busy; });
}

function noteFor(id) {
  const node = reviewsEl.querySelector('[data-id="' + (window.CSS?.escape ? CSS.escape(id) : id) + '"] [data-note]');
  return node ? node.value.trim() : '';
}

reviewsEl.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const cardNode = button.closest('[data-id]');
  if (!cardNode) return;
  const id = cardNode.dataset.id;
  const action = button.dataset.act;
  if (action === 'approve') {
    const review = state.reviews.find((item) => item.id === id);
    if (!review) return;
    pendingApprove = { id, note: noteFor(id) };
    $('#confirmPost').textContent = review.effectivePost;
    $('#confirmHash').textContent = review.hash;
    confirmDialog.returnValue = '';
    confirmDialog.showModal();
    return;
  }
  if (action === 'revise' || action === 'reject') {
    const note = noteFor(id);
    if (note.length < 4) {
      toast('Tulis nota sekurang-kurangnya 4 aksara untuk revisi atau tolak.', true);
      cardNode.querySelector('[data-note]')?.focus();
      return;
    }
    focusIntent = { id, action };
    submitDecision(id, action === 'revise' ? 'revise' : 'rejected', note);
    return;
  }
  if (action === 'save-edit') {
    const area = cardNode.querySelector('[data-edit]');
    if (!area || !area.value.trim()) { toast('Post tidak boleh kosong.', true); return; }
    focusIntent = { id, action };
    saveEdit(id, area.value);
    return;
  }
  if (action === 'reset-edit') {
    focusIntent = { id, action };
    resetEdit(id);
  }
});

confirmDialog.addEventListener('close', () => {
  const pending = pendingApprove;
  pendingApprove = null;
  if (pending && confirmDialog.returnValue === 'confirm') {
    focusIntent = { id: pending.id, action: 'approve' };
    submitDecision(pending.id, 'approved', pending.note);
  }
});

$('#filters').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-filter]');
  if (!button) return;
  state.filter = button.dataset.filter;
  render();
});

$('#refreshBtn').addEventListener('click', () => load());

// Owner-side mirror of the signed envelope. The page never signs anything: it
// asks the server for the envelope built from the decisions the owner already
// stored, so this is the same file the host gate fetches or caches.
async function downloadEnvelope() {
  try {
    const response = await fetch('/api/learning/approvals', { credentials: 'same-origin', cache: 'no-store' });
    const envelope = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(friendly({ code: envelope.error, message: envelope.message }, 'Envelope kelulusan tidak tersedia.'), true);
      return;
    }
    const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'envelope.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    let pin = '';
    try {
      const keyResponse = await fetch('/api/learning/approvals?format=key', { credentials: 'same-origin', cache: 'no-store' });
      const keyData = await keyResponse.json();
      if (keyResponse.ok && keyData.pin) pin = ' · pin ' + keyData.pin.fingerprint_sha256.slice(0, 16) + '…';
    } catch { /* pin stays hidden; the envelope itself is unaffected */ }
    const counts = envelope.counts || {};
    toast('Envelope: ' + (counts.approvals || 0) + ' kelulusan, ' + (counts.pending || 0) + ' menunggu' + pin + '.');
  } catch {
    toast('Envelope tak dapat diambil.', true);
  }
}

$('#envelopeBtn').addEventListener('click', downloadEnvelope);

$('#logoutBtn').addEventListener('click', async () => {
  try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* local preview */ }
  state.reviews = [];
  $('#gateError').textContent = '';
  showGate('');
});

gate.addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = $('#gateUser').value.trim();
  const password = $('#gatePass').value;
  $('#gateError').textContent = '';
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (response.ok) { $('#gatePass').value = ''; await load(); return; }
    const data = await response.json().catch(() => ({}));
    $('#gateError').textContent = response.status === 429
      ? 'Terlalu banyak cubaan. Cuba lagi dalam 15 minit.'
      : data.error === 'server login not enabled'
        ? 'Login server belum diaktifkan (JOM_API_TOKEN/JOM_LOGIN_PASSWORD).'
        : 'Username atau password salah.';
  } catch {
    $('#gateError').textContent = 'Tak dapat hubungi server.';
  }
});

window.AnalysisReview = { state, load, render, submitDecision, saveEdit, resetEdit, downloadEnvelope };

load();
