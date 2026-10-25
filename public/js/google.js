/* Klipo: "Google ile devam et" (tarayıcıda Google düğmesi, Android uygulamasında sistem tarayıcısı) ve kullanıcı adı seçimi */
(function () {
  'use strict';
  const K = window.K;
  const { esc, icon, $ } = K;

  const native = () => !!(window.KlipoNative && typeof window.KlipoNative.openBrowser === 'function');
  const enabled = () => !!(K.config && K.config.googleClientId);
  let loading = null;
  let handler = null;
  let inited = false;

  function load() {
    if (window.google && window.google.accounts && window.google.accounts.id) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        loading = null;
        reject(new Error('Google yüklenemedi'));
      };
      document.head.appendChild(s);
    });
    return loading;
  }

  // el içine Google düğmesini çizer; kimlik belirteci gelince onCredential(credential) çağrılır
  async function button(el, onCredential) {
    handler = onCredential;
    try {
      await load();
      if (!inited) {
        window.google.accounts.id.initialize({
          client_id: K.config.googleClientId,
          callback: (r) => handler && r && r.credential && handler(r.credential),
          ux_mode: 'popup',
          auto_select: false,
        });
        inited = true;
      }
      el.innerHTML = '';
      window.google.accounts.id.renderButton(el, { theme: 'filled_black', size: 'large', text: 'continue_with', shape: 'pill', width: 300, locale: 'tr' });
    } catch (e) {
      el.innerHTML = '<p class="hint center">Google şu anda yüklenemedi.</p>';
    }
  }

  function openBrowser(acct) {
    window.KlipoNative.openBrowser(`${location.origin}/google-app.html?t=${acct === 'rp' ? 'rp' : 'real'}`);
  }

  // Google ile açılan hesap otomatik bir kullanıcı adı alır; ilk girişte kişi kendi adını seçer
  function pickUsername() {
    if (!K.me || !K.me.pickUsername) return;
    K.sheet({
      title: 'Kullanıcı adını seç',
      html: `<div class="page col"><p class="hint">Şimdilik <b>@${esc(K.me.username)}</b> adını aldın. Beğenmediysen şimdi değiştir; sonra değiştirilemez.</p>
        <label class="field"><span>Kullanıcı adı</span><input class="input" id="pu-name" maxlength="24" autocapitalize="none" autocorrect="off" spellcheck="false" value="${esc(K.me.username)}"></label>
        <div class="error-text" id="pu-err" role="alert"></div>
        <button class="btn primary block" id="pu-go">Kaydet</button>
        <button class="btn ghost block" id="pu-skip">Böyle kalsın</button></div>`,
      onMount: (api) => {
        const done = async (name) => {
          try {
            const r = await K.api('/auth/pick-username', { method: 'POST', body: { username: name } });
            K.me = r.user;
            api.close();
            K.toast('Hazır!', 'ok');
          } catch (e) {
            $('#pu-err', api.el).textContent = e.message;
          }
        };
        $('#pu-go', api.el).onclick = () => done($('#pu-name', api.el).value);
        $('#pu-skip', api.el).onclick = () => done(K.me.username);
      },
    });
  }

  K.google = { enabled, native, button, openBrowser };
  K.pickUsername = pickUsername;
})();
