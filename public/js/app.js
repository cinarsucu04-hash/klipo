/* Klipo uygulama kabuğu: açılış, giriş/kayıt, alt gezinme, bakım, duyuru, PWA */
(function () {
  'use strict';
  const K = window.K;
  const { esc, icon, $, $$ } = K;

  K.feedType = K.store.get('feed', 'foryou');

  /* ---------------- alt gezinme ---------------- */
  const NAV = [
    ['home', '/', 'home', 'Ana sayfa'],
    ['discover', '/discover', 'compass', 'Keşfet'],
    ['upload', '/upload', 'plus', ''],
    ['inbox', '/inbox', 'inbox', 'Gelen kutusu'],
    ['me', '/me', 'user', 'Profil'],
  ];
  let activeNav = '';

  K.updateNav = () => {
    const nav = $('#nav');
    if (!K.me) {
      nav.innerHTML = '';
      $('#app').classList.add('no-nav');
      return;
    }
    nav.innerHTML = NAV.map((n) =>
      n[0] === 'upload'
        ? `<a class="nav-btn" href="#${n[1]}" aria-label="Video yükle"><span class="nav-plus">${icon('plus')}</span></a>`
        : `<a class="nav-btn ${n[0] === activeNav ? 'active' : ''}" href="#${n[1]}" data-nav="${n[0]}">${icon(n[2])}<span>${n[3]}</span>${n[0] === 'inbox' ? '<span class="badge hidden" id="inbox-badge"></span>' : ''}</a>`
    ).join('');
    K.paintBadges();
  };

  K.setNavActive = (name) => {
    activeNav = name;
    $$('#nav [data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
  };

  K.paintBadges = () => {
    const b = $('#inbox-badge');
    if (!b) return;
    const n = (K.counters.notifications || 0) + (K.counters.messages || 0) + (K.counters.requests || 0);
    b.textContent = n > 99 ? '99+' : String(n);
    b.classList.toggle('hidden', !n);
  };

  /* ---------------- bakım ekranı ---------------- */
  K.showMaintenance = (msg) => {
    $('#app').classList.add('no-nav');
    $('#view').innerHTML = `<div class="maint"><div class="col" style="align-items:center;width:100%;max-width:320px">${icon('refresh', 'lg')}<h2>Kısa bir ara verdik</h2><p class="muted">${esc(msg || 'Platform bakımda. Lütfen daha sonra tekrar dene.')}</p><button class="btn primary" id="m-retry">Tekrar dene</button>
      <button class="btn ghost sm" id="m-admin" style="margin-top:14px">Yönetici girişi</button>
      <form id="m-form" class="col hidden" style="width:100%;margin-top:10px" novalidate>
        <input class="input" name="username" placeholder="Kullanıcı adı" autocomplete="username" autocapitalize="none">
        <input class="input" name="password" type="password" placeholder="Şifre" autocomplete="current-password">
        <div class="error-text" id="m-err" role="alert"></div>
        <button class="btn primary block" type="submit">Giriş yap</button></form></div></div>`;
    $('#m-retry').onclick = () => location.reload();
    $('#m-admin').onclick = () => $('#m-form').classList.toggle('hidden');
    $('#m-form').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        const r = await K.api('/auth/login', { method: 'POST', body: { username: f.username.value, password: f.password.value } });
        if (r.user && r.user.role === 'admin') return location.reload();
        await K.api('/auth/logout', { method: 'POST' }).catch(() => {});
        $('#m-err').textContent = 'Bakım sürerken yalnızca yöneticiler girebilir.';
      } catch (err) {
        $('#m-err').textContent = err.message;
      }
    };
  };

  /* ---------------- giriş / kayıt / e-posta doğrulama / şifre sıfırlama ---------------- */
  K.route(
    '/login',
    async (ctx) => {
      const v = ctx.view;
      let mode = 'login'; // login | register | verify | forgot | reset
      let acct = 'real';
      let needCaptcha = false;
      let pending = '';
      let pendingEmail = '';
      let resendAt = 0;
      let timer = null;
      const verifyOn = !!K.config.emailVerify;
      const banned = K.bannedMsg || '';
      const inApp = /KlipoApp/.test(navigator.userAgent) || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);

      const captchaHTML = () => `<div class="field" id="capbox"><span>Güvenlik kodu</span>
        <div class="captcha"><img id="cimg" alt="Güvenlik kodu resmi" width="190" height="64"><button type="button" class="icon-btn" id="cref" aria-label="Resmi yenile">${icon('refresh')}</button></div>
        <input class="input" name="captcha" maxlength="8" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="Resimdeki harfleri yaz"></div>`;
      const loadCaptcha = () => {
        const img = $('#cimg', v);
        if (img) img.src = '/api/auth/captcha?t=' + Date.now();
        const inp = $('input[name=captcha]', v);
        if (inp) inp.value = '';
      };
      const shell = (inner) => `<div class="auth">
          <img class="logo" src="/icons/icon-192.png" alt="" width="84" height="84">
          <h1>${esc(K.config.appName)}</h1><p class="tagline">Kısa videolar. Büyük anlar.</p>${inner}</div>`;
      const back = '<p class="hint center"><button type="button" class="linkbtn" data-m="login">← Girişe dön</button></p>';

      function paint() {
        clearInterval(timer);
        if (mode === 'verify') return paintVerify();
        if (mode === 'forgot') return paintForgot();
        if (mode === 'reset') return paintReset();
        const reg = mode === 'register';
        v.innerHTML = shell(`
          ${banned ? `<div class="card" style="margin:0;border-color:var(--danger)"><b>Hesap erişimi engellendi</b><p class="hint">${esc(banned)}</p></div>` : ''}
          <div class="seg"><button data-m="login" class="${reg ? '' : 'active'}">Giriş yap</button><button data-m="register" class="${reg ? 'active' : ''}">Kayıt ol</button></div>
          <form id="af" class="col" autocomplete="on" novalidate>
            <label class="field"><span>${reg ? 'Kullanıcı adı' : verifyOn ? 'Kullanıcı adı veya e-posta' : 'Kullanıcı adı'}</span><input class="input" name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="${reg ? 24 : 254}" required></label>
            ${reg ? '<label class="field"><span>Görünen ad</span><input class="input" name="nickname" maxlength="30" autocomplete="nickname" placeholder="İsteğe bağlı"></label>' : ''}
            ${reg && verifyOn ? `<label class="field"><span>Gmail adresin</span><input class="input" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="254" placeholder="ornek@gmail.com" required><small class="hint">Bu adrese 6 haneli doğrulama kodu göndereceğiz.</small></label>` : ''}
            ${reg ? `<div class="field"><span>Hesap türü</span><div class="seg" id="acct" style="margin:0"><button type="button" data-a="real" class="${acct === 'real' ? 'active' : ''}">Gerçek hesap</button><button type="button" data-a="rp" class="${acct === 'rp' ? 'active' : ''}">RP hesabı</button></div><small class="hint">RP: karakter / rol yapma hesabı. Profilinde etiket olarak görünür.</small></div>` : ''}
            <label class="field"><span>Şifre</span><input class="input" name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" maxlength="72" required>${reg ? '<small class="hint">En az 8 karakter; harf ve rakam içersin.</small>' : ''}</label>
            ${reg || needCaptcha ? captchaHTML() : ''}
            <div class="error-text" id="aerr" role="alert"></div>
            <button class="btn primary block" type="submit" style="height:46px">${reg ? (verifyOn ? 'Devam et' : 'Hesap oluştur') : 'Giriş yap'}</button>
            ${!reg && verifyOn ? '<p class="hint center"><button type="button" class="linkbtn" data-m="forgot">Şifreni mi unuttun?</button></p>' : ''}
          </form>
          ${K.google.enabled() ? '<div class="or-line"><span>veya</span></div><div class="gslot" id="gslot"></div>' : ''}
          <p class="hint center">Devam ederek topluluk kurallarını kabul etmiş olursun.</p>
          ${inApp ? '' : '<p class="hint center"><a href="/indir.html" style="color:inherit;text-decoration:underline">Uygulamayı indir</a></p>'}`);
        $('#af input', v).focus();
        if ($('#cimg', v)) loadCaptcha();
        const slot = $('#gslot', v);
        if (slot) {
          if (K.google.native()) {
            slot.innerHTML = '<button type="button" class="btn block" id="g-app" style="height:46px">Google ile devam et</button>';
            $('#g-app', v).onclick = () => K.google.openBrowser(acct);
          } else {
            K.google.button(slot, (credential) => googleLogin(credential));
          }
        }
      }

      function paintVerify() {
        v.innerHTML = shell(`
          <h2 style="margin:6px 0 0;font-size:18px">E-postanı doğrula</h2>
          <p class="hint center"><b>${esc(pendingEmail)}</b> adresine 6 haneli bir kod gönderdik. Kod 10 dakika geçerli. Gelmediyse Spam klasörüne bak.</p>
          <form id="vf" class="col" novalidate>
            <input class="input code" name="code" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" maxlength="6" placeholder="• • • • • •" aria-label="6 haneli kod" required>
            <div class="error-text" id="aerr" role="alert"></div>
            <button class="btn primary block" type="submit" style="height:46px">Doğrula ve hesabı aç</button>
            <button class="btn block" type="button" id="rs" disabled>Kodu tekrar gönder</button>
          </form>${back}`);
        $('input[name=code]', v).focus();
        tickResend();
      }
      function tickResend() {
        const b = $('#rs', v);
        if (!b) return;
        clearInterval(timer);
        const upd = () => {
          const left = Math.ceil((resendAt - Date.now()) / 1000);
          b.disabled = left > 0;
          b.textContent = left > 0 ? `Kodu tekrar gönder (${left})` : 'Kodu tekrar gönder';
          if (left <= 0) clearInterval(timer);
        };
        upd();
        timer = setInterval(upd, 1000);
      }

      function paintForgot() {
        v.innerHTML = shell(`
          <h2 style="margin:6px 0 0;font-size:18px">Şifreni sıfırla</h2>
          <p class="hint center">Hesabına bağlı e-posta adresini yaz; sana 6 haneli kod göndereceğiz.</p>
          <form id="ff" class="col" novalidate>
            <label class="field"><span>E-posta</span><input class="input" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" maxlength="254" placeholder="ornek@gmail.com" required></label>
            ${captchaHTML()}
            <div class="error-text" id="aerr" role="alert"></div>
            <button class="btn primary block" type="submit" style="height:46px">Kod gönder</button>
          </form>${back}`);
        $('input[name=email]', v).focus();
        loadCaptcha();
      }

      function paintReset() {
        v.innerHTML = shell(`
          <h2 style="margin:6px 0 0;font-size:18px">Yeni şifre belirle</h2>
          <p class="hint center">${esc(pendingEmail)} adresine kayıtlıysa 6 haneli kod gönderdik.</p>
          <form id="rf" class="col" novalidate>
            <input class="input code" name="code" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" maxlength="6" placeholder="• • • • • •" aria-label="6 haneli kod" required>
            <label class="field"><span>Yeni şifre</span><input class="input" name="password" type="password" autocomplete="new-password" maxlength="72" required><small class="hint">En az 8 karakter; harf ve rakam içersin.</small></label>
            <div class="error-text" id="aerr" role="alert"></div>
            <button class="btn primary block" type="submit" style="height:46px">Şifreyi değiştir ve giriş yap</button>
          </form>${back}`);
        $('input[name=code]', v).focus();
      }

      function loggedIn(r) {
        K.csrf = r.csrf;
        K.me = r.user;
        K.bannedMsg = '';
        K.applyTheme(K.me.settings.theme || 'dark');
        K.updateNav();
        K.refreshCounters && K.refreshCounters();
        K.go('/', true);
        setTimeout(K.announce, 600);
        K.push.sync();
        setTimeout(K.push.prompt, 6000);
        setTimeout(K.pickUsername, 500);
      }
      async function googleLogin(credential) {
        const err = $('#aerr', v);
        try {
          loggedIn(await K.api('/auth/google', { method: 'POST', body: { credential, accountType: acct } }));
        } catch (ex) {
          if (err) err.textContent = ex.message;
        }
      }

      paint();
      K.on(v, 'click', '#acct [data-a]', (b) => {
        acct = b.dataset.a;
        $$('#acct [data-a]', v).forEach((x) => x.classList.toggle('active', x === b));
      });
      K.on(v, 'click', '[data-m]', (b) => {
        mode = b.dataset.m;
        K.bannedMsg = '';
        if (mode === 'login') needCaptcha = false;
        paint();
      });
      K.on(v, 'click', '#cref', () => loadCaptcha());
      K.on(v, 'click', '#rs', async (b) => {
        b.disabled = true;
        try {
          await K.api('/auth/register/resend', { method: 'POST', body: { pending } });
          resendAt = Date.now() + 60000;
          K.toast('Yeni kod gönderildi', 'ok');
        } catch (ex) {
          const err = $('#aerr', v);
          if (err) err.textContent = ex.message;
          if (ex.code === 'EXPIRED' || ex.code === 'RATE') {
            mode = 'register';
            paint();
            return;
          }
          resendAt = Date.now() + 10000;
        }
        tickResend();
      });

      // gönderme: formun kimliğine göre
      v.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        const err = $('#aerr', v);
        const btn = $('button[type=submit]', f);
        const usedCaptcha = !!$('input[name=captcha]', f);
        const field = (n) => (f[n] ? f[n].value : '');
        const fail = (ex) => {
          err.textContent = ex.message;
          btn.disabled = false;
          if (usedCaptcha) loadCaptcha(); // kod tek kullanımlıktır: her denemeden sonra yenilenir
        };
        err.textContent = '';
        try {
          if (f.id === 'af') {
            const body = { username: field('username'), password: field('password') };
            if (usedCaptcha) body.captcha = field('captcha');
            if (!body.username.trim() || !body.password) {
              err.textContent = 'Tüm alanları doldur.';
              return;
            }
            if (mode === 'register') {
              body.nickname = field('nickname');
              body.accountType = acct;
              if (!body.captcha) {
                err.textContent = 'Resimdeki güvenlik kodunu yaz.';
                return;
              }
              if (verifyOn) body.email = field('email');
            }
            btn.disabled = true;
            if (mode === 'register' && verifyOn) {
              const r = await K.api('/auth/register/start', { method: 'POST', body });
              pending = r.pending;
              pendingEmail = r.email;
              resendAt = Date.now() + 60000;
              mode = 'verify';
              paint();
            } else {
              loggedIn(await K.api(`/auth/${mode}`, { method: 'POST', body }));
            }
          } else if (f.id === 'vf') {
            btn.disabled = true;
            loggedIn(await K.api('/auth/register/verify', { method: 'POST', body: { pending, code: field('code') } }));
          } else if (f.id === 'ff') {
            if (!field('captcha')) {
              err.textContent = 'Resimdeki güvenlik kodunu yaz.';
              return;
            }
            btn.disabled = true;
            const r = await K.api('/auth/forgot', { method: 'POST', body: { email: field('email'), captcha: field('captcha') } });
            pending = r.pending;
            pendingEmail = r.email;
            mode = 'reset';
            paint();
          } else if (f.id === 'rf') {
            btn.disabled = true;
            loggedIn(await K.api('/auth/reset', { method: 'POST', body: { pending, code: field('code'), password: field('password') } }));
          }
        } catch (ex) {
          if (f.id === 'af' && mode === 'login' && (ex.code === 'NEEDCAPTCHA' || ex.code === 'CAPTCHA') && !needCaptcha) {
            needCaptcha = true;
            if (!$('#capbox', v)) $('#aerr', v).insertAdjacentHTML('beforebegin', captchaHTML());
            loadCaptcha();
            err.textContent = ex.code === 'NEEDCAPTCHA' ? ex.message + ' Güvenlik için resimdeki kodu da yaz.' : ex.message;
            btn.disabled = false;
          } else {
            fail(ex);
          }
        }
      });
      return () => clearInterval(timer);
    },
    { auth: false, guest: true, hideNav: true }
  );

  /* ---------------- açılış ---------------- */
  function setBootMsg(text) {
    let m = $('#boot-msg');
    if (!m) {
      m = document.createElement('p');
      m.id = 'boot-msg';
      m.style.cssText = 'position:absolute;bottom:18%;left:0;right:0;text-align:center;color:#9a9aae;padding:0 30px;font-size:14px';
      $('#boot').appendChild(m);
    }
    m.textContent = text;
  }

  // Sunucu ayakta ama veritabanı yoksa kullanıcıya gerçek nedeni söyle ("internet yok" demek yanıltıcı)
  const DB_HINTS = {
    MONGO_URL_YOK: 'Sunucu çalışıyor ama MONGO_URL tanımlı değil. Render > Environment bölümüne ekle.',
    SIFRE: 'Sunucu çalışıyor ama veritabanı kullanıcı adı/şifresi hatalı. Render > Environment > MONGO_URL değerini kontrol et.',
    AG: 'Sunucu çalışıyor ama veritabanına ulaşamıyor. Atlas > Network Access bölümüne 0.0.0.0/0 ekle ve kümenin duraklatılmadığına bak.',
    ADRES: 'Sunucu çalışıyor ama veritabanı adresi (MONGO_URL) hatalı görünüyor. Atlas\'tan yeniden kopyala.',
    DIGER: 'Sunucu çalışıyor ama veritabanına bağlanamıyor. Render > Logs bölümüne bak.',
  };
  async function dbHint() {
    try {
      const r = await fetch('/healthz', { cache: 'no-store' });
      const h = await r.json();
      if (h && h.ok && !h.db && h.dbError) return DB_HINTS[h.dbError] || DB_HINTS.DIGER;
    } catch (e) { /* sunucuya hiç ulaşılamıyor: aşağıdaki genel mesaj kalır */ }
    return '';
  }

  async function start() {
    const t0 = Date.now();
    let session = null;
    let hint = '';
    let lastHintAt = 0;
    // Render ücretsiz plan: sunucu uykudan uyanırken 30-60 sn sürebilir; nazikçe bekle
    for (;;) {
      try {
        session = await K.refreshSession();
        break;
      } catch (e) {
        const waited = Date.now() - t0;
        if (e.status && e.status !== 503 && e.status !== 502 && e.status !== 504) {
          setBootMsg(e.message);
          return;
        }
        if (waited > 3500 && Date.now() - lastHintAt > 6000) {
          lastHintAt = Date.now();
          hint = await dbHint();
        }
        if (waited > 120000) {
          setBootMsg(hint || 'Sunucuya ulaşılamadı. İnternetini kontrol edip uygulamayı yeniden aç.');
          const b = document.createElement('button');
          b.className = 'btn primary';
          b.textContent = 'Tekrar dene';
          b.style.cssText = 'position:absolute;bottom:10%;left:50%;transform:translateX(-50%)';
          b.onclick = () => location.reload();
          $('#boot').appendChild(b);
          return;
        }
        if (hint) setBootMsg(hint);
        else if (waited > 3500) setBootMsg('Sunucu uyanıyor, birkaç saniye sürebilir…');
        await K.sleep(2500);
      }
    }

    K.bannedMsg = session.banned || '';
    K.applyTheme(K.me ? K.me.settings.theme || 'dark' : K.store.get('theme', 'dark'));
    K.updateNav();

    if (K.config.maintenance && (!K.me || K.me.role !== 'admin')) {
      K.showMaintenance();
    } else {
      if (!location.hash || location.hash === '#') {
        K.go(K.me ? '/' : '/login', true);
      }
      await K.render();
      if (K.me) {
        K.refreshCounters && K.refreshCounters();
        announce();
        K.push.sync();
        setTimeout(K.push.prompt, 6000);
        setTimeout(K.pickUsername, 1500);
      }
    }

    const boot = $('#boot');
    boot.classList.add('done');
    setTimeout(() => boot.remove(), 450);

    // bildirim / mesaj rozetlerini periyodik yenile
    setInterval(() => {
      if (K.me && !document.hidden) K.refreshCounters && K.refreshCounters();
    }, 25000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && K.me) K.refreshCounters && K.refreshCounters();
    });
    window.addEventListener('offline', () => K.toast('İnternet bağlantısı kesildi', 'error'));
    window.addEventListener('online', () => K.toast('Tekrar çevrimiçisin', 'ok'));
  }

  // Yönetici duyurusu: aynı duyuru kullanıcıya bir kez gösterilir
  K.announce = announce;
  function announce() {
    const text = K.config.announcement;
    if (!text || K.store.get('ann', '') === text) return;
    K.store.set('ann', text);
    K.sheet({ title: 'Duyuru', html: `<div class="page col" style="align-items:center;text-align:center">${icon('megaphone', 'lg')}<p>${K.linkify(text)}</p><button class="btn primary" data-close>Tamam</button></div>` });
  }

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  // Yalnızca doğrudan tıklanan sosyal bağlantı hedefleri için yeni sekme güvenliği
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[target=_blank]');
    if (a) a.rel = 'noopener noreferrer';
  });

  start();
})();
