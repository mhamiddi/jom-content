/* Jom Content shared login gate (Dashboard + Topic Bank share one session).

   Two modes, chosen by GET /api/session:
   - server: the API is locked (Pages env JOM_API_TOKEN is set). Login is checked by POST /api/login and kept in an
             HttpOnly cookie. Nothing secret lives in this file.
   - legacy: the API is still open. Login is checked here in the browser against the credentials below. This only
             hides the UI; anyone can read them. They are deleted from this file once the server mode is on. */
(function () {
  var USER = 'jomdigital', PASS = 'Hakimi.1995';
  var KEYS = ['jomContentSession', 'topicBankSession'];
  var wired = false, mode = 'legacy', serverAuthed = false;
  var rawFetch = window.fetch.bind(window);
  function $(id) { return document.getElementById(id); }

  // Learn the mode once. Never block the page for more than ~3.5s.
  var session = rawFetch('/api/session', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { if (j && j.success && j.enforced) { mode = 'server'; serverAuthed = !!j.authed; } })
    .catch(function () {});
  var ready = Promise.race([session, new Promise(function (res) { setTimeout(res, 3500); })]);

  function resetForm() {
    var err = $('loginError'); if (err) err.textContent = '';
    var form = $('loginForm'); if (form) form.classList.remove('has-error');
    var pw = $('loginPassword');
    if (pw) { pw.value = ''; pw.type = 'password'; pw.removeAttribute('aria-invalid'); }
    var tg = $('loginToggle');
    if (tg) { tg.setAttribute('aria-pressed', 'false'); tg.setAttribute('aria-label', 'Tunjuk password'); }
  }

  function wire() {
    var form = $('loginForm');
    if (wired || !form) return;
    wired = true;
    form.addEventListener('input', function () {
      form.classList.remove('has-error');
      var e = $('loginError'); if (e) e.textContent = '';
      var pw = $('loginPassword'); if (pw) pw.removeAttribute('aria-invalid');
    });
  }

  var api = {
    ready: ready,
    mode: function () { return mode; },
    onExpired: null,   // pages set this: called when the API answers 401 in server mode
    isAuthed: function () {
      return mode === 'server' ? serverAuthed : KEYS.some(function (k) { return localStorage.getItem(k) === '1'; });
    },
    check: function (u, p) { return u === USER && p === PASS; },
    login: function (u, p) {
      if (mode !== 'server') return Promise.resolve({ ok: api.check(u, p) });
      return rawFetch('/api/login', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p })
      }).then(function (r) {
        if (r.ok) { serverAuthed = true; return { ok: true }; }
        return { ok: false, error: r.status === 429 ? 'Terlalu banyak cubaan. Cuba lagi dalam 15 minit.' : null };
      }).catch(function () { return { ok: false, error: 'Tak dapat hubungi server. Cuba lagi.' }; });
    },
    setAuthed: function () { if (mode !== 'server') KEYS.forEach(function (k) { localStorage.setItem(k, '1'); }); },
    clear: function () {
      KEYS.forEach(function (k) { localStorage.removeItem(k); });
      if (mode === 'server') {
        serverAuthed = false;
        rawFetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(function () {});
      }
    },
    openLogin: function () {
      var m = $('loginModal'); if (!m) return;
      m.classList.add('open'); resetForm(); wire();
      setTimeout(function () { var u = $('loginUsername'); if (u) u.focus(); }, 40);
    },
    closeLogin: function () { var m = $('loginModal'); if (m) m.classList.remove('open'); },
    fail: function (msg) {
      var err = $('loginError'); if (err) err.textContent = msg || 'Username atau password salah. Cuba lagi.';
      var form = $('loginForm'); if (form) form.classList.add('has-error');
      var pw = $('loginPassword'); if (pw) { pw.setAttribute('aria-invalid', 'true'); pw.focus(); pw.select(); }
    },
    toggle: function () {
      var pw = $('loginPassword'), tg = $('loginToggle'); if (!pw || !tg) return;
      var show = pw.type === 'password';
      pw.type = show ? 'text' : 'password';
      tg.setAttribute('aria-pressed', String(show));
      tg.setAttribute('aria-label', show ? 'Sembunyi password' : 'Tunjuk password');
      pw.focus();
    }
  };
  window.JomAuth = api;
  window.toggleLoginPassword = function () { api.toggle(); };

  // Any 401 from our own API in server mode means the session ended: send the user back to the login screen.
  window.fetch = function (input, init) {
    return rawFetch(input, init).then(function (res) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (res.status === 401 && mode === 'server' && /^(\/|https?:\/\/[^/]+\/)api\//.test(url) && !/\/api\/(login|session|logout)/.test(url)) {
        serverAuthed = false;
        if (typeof api.onExpired === 'function') api.onExpired();
      }
      return res;
    });
  };
})();
