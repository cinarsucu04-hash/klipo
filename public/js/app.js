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
    $('#view').innerHTML = `<div class="maint"><div class="col" style="align-items:center">${icon('refresh', 'lg')}<h2>Kısa bir ara verdik</h2><p class="muted">${esc(msg || 'Platform bakımda. Lütfen daha sonra tekrar dene.')}</p><button class="btn primary" id="m-retry">Tekrar dene</button></div></div>`;
    $('#m-retry').onclick = () => location.reload();
  };

  /* ---------------- giriş / kayıt ---------------- */
  K.route(
    '/login',
    async (ctx) => {
      const v = ctx.view;
      let mode = 'login';
      const banned = K.bannedMsg || '';
      const inApp = /KlipoApp/.test(navigator.userAgent) || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);

      function paint() {
        const reg = mode === 'register';
        v.innerHTML = `<div class="auth">
          <img class="logo" src="/icons/icon-192.png" alt="" width="84" height="84">
          <h1>${esc(K.config.appName)}</h1><p class="tagline">Kısa videolar. Büyük anlar.</p>
          ${banned ? `<div class="card" style="margin:0;border-color:var(--danger)"><b>Hesap erişimi engellendi</b><p class="hint">${esc(banned)}</p></div>` : ''}
          <div class="seg"><button data-m="login" class="${reg ? '' : 'active'}">Giriş yap</button><button data-m="register" class="${reg ? 'active' : ''}">Kayıt ol</button></div>
          <form id="af" class="col" autocomplete="on" novalidate>
            <label class="field"><span>Kullanıcı adı</span><input class="input" name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="24" required></label>
            ${reg ? '<label class="field"><span>Görünen ad</span><input class="input" name="nickname" maxlength="30" autocomplete="nickname" placeholder="İsteğe bağlı"></label>' : ''}
            <label class="field"><span>Şifre</span><input class="input" name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" maxlength="72" required></label>
            <div class="error-text" id="aerr" role="alert"></div>
            <button class="btn primary block" type="submit" style="height:46px">${reg ? 'Hesap oluştur' : 'Giriş yap'}</button>
          </form>
          <p class="hint center">Devam ederek topluluk kurallarını kabul etmiş olursun.</p>
          ${inApp ? '' : '<p class="hint center"><a href="/indir.html" style="color:inherit;text-decoration:underline">Uygulamayı indir</a></p>'}</div>`;
        $('#af input', v).focus();
      }
      paint();
      K.on(v, 'click', '[data-m]', (b) => {
        mode = b.dataset.m;
        K.bannedMsg = '';
        paint();
      });
      v.addEventListener('submit', async (e) => {
        if (e.target.id !== 'af') return;
        e.preventDefault();
        const f = e.target;
        const err = $('#aerr', v);
        const btn = $('button[type=submit]', f);
        const body = { username: f.username.value, password: f.password.value };
        if (mode === 'register') {
          body.nickname = f.nickname.value;
        }
        if (!body.username.trim() || !body.password) {
          err.textContent = 'Kullanıcı adı ve şifre gerekli.';
          return;
        }
        btn.disabled = true;
        err.textContent = '';
        try {
          const r = await K.api(`/auth/${mode}`, { method: 'POST', body });
          K.csrf = r.csrf;
          K.me = r.user;
          K.bannedMsg = '';
          K.applyTheme(K.me.settings.theme || 'dark');
          K.updateNav();
          K.refreshCounters && K.refreshCounters();
          K.go('/', true);
          setTimeout(K.announce, 600);
        } catch (ex) {
          err.textContent = ex.message;
          btn.disabled = false;
        }
      });
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
