/* Android uygulaması için Google girişi: sistem tarayıcısında çalışır, sonucu klipo:// bağlantısıyla uygulamaya iletir */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  let acct = new URLSearchParams(location.search).get('t') === 'rp' ? 'rp' : 'real';
  let csrf = '';

  function mark() {
    document.querySelectorAll('#acct button').forEach((b) => b.classList.toggle('active', b.dataset.a === acct));
  }
  mark();
  $('#acct').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-a]');
    if (b) {
      acct = b.dataset.a;
      mark();
    }
  });

  async function api(path, opts) {
    const r = await fetch('/api' + path, {
      method: (opts && opts.method) || 'GET',
      credentials: 'same-origin',
      headers: Object.assign({ 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, (opts && opts.headers) || {}),
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'İstek başarısız');
    return d;
  }

  async function start() {
    try {
      const me = await api('/auth/me');
      csrf = me.csrf;
      if (me.banned && !me.user) {
        $('#err').textContent = me.banned;
        return;
      }
      const id = me.config.googleClientId;
      if (!id) {
        $('#err').textContent = 'Google ile giriş bu sunucuda açık değil.';
        return;
      }
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.onload = resolve;
        s.onerror = () => reject(new Error('Google yüklenemedi'));
        document.head.appendChild(s);
      });
      window.google.accounts.id.initialize({
        client_id: id,
        ux_mode: 'popup',
        callback: async (r) => {
          try {
            $('#err').textContent = '';
            const d = await api('/auth/google-app', { method: 'POST', body: { credential: r.credential, accountType: acct } });
            const url = 'klipo://auth?code=' + encodeURIComponent(d.code);
            $('#msg').textContent = 'Giriş tamam! Uygulamaya dönülüyor…';
            $('#gbtn').classList.add('hidden');
            $('#acct').classList.add('hidden');
            const back = $('#back');
            back.href = url;
            back.classList.remove('hidden');
            location.href = url;
          } catch (e) {
            $('#err').textContent = e.message;
          }
        },
      });
      window.google.accounts.id.renderButton($('#gbtn'), { theme: 'filled_black', size: 'large', text: 'continue_with', shape: 'pill', width: 300, locale: 'tr' });
    } catch (e) {
      $('#err').textContent = e.message;
    }
  }
  start();
})();
