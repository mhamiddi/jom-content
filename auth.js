/* Jom Content shared login gate (Dashboard + Topic Bank share one session).
   This only hides the UI: the credentials below are readable by anyone who opens this file and the API
   is not authenticated. Use Cloudflare Access (or a token on the Functions) for real protection. */
(function () {
  var USER = 'jomdigital', PASS = 'Hakimi.1995';
  var KEYS = ['jomContentSession', 'topicBankSession'];
  var wired = false;
  function $(id) { return document.getElementById(id); }

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

  window.JomAuth = {
    isAuthed: function () { return KEYS.some(function (k) { return localStorage.getItem(k) === '1'; }); },
    check: function (u, p) { return u === USER && p === PASS; },
    setAuthed: function () { KEYS.forEach(function (k) { localStorage.setItem(k, '1'); }); },
    clear: function () { KEYS.forEach(function (k) { localStorage.removeItem(k); }); },
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
  window.toggleLoginPassword = function () { window.JomAuth.toggle(); };
})();
