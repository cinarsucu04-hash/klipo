/* Klipo ayarlar, geçmiş, ziyaretçiler, engellenenler */
(function () {
  'use strict';
  const K = window.K;
  const { esc, icon, $, $$ } = K;

  const THEME_LABEL = { dark: 'Koyu', light: 'Açık', system: 'Sistem' };
  const MSG_LABEL = { everyone: 'Herkes', following: 'Takip ettiklerim', none: 'Hiç kimse' };

  const header = (title, back) => `<div class="topbar"><button class="icon-btn" data-back aria-label="Geri">${icon('back')}</button><h1>${esc(title)}</h1><span class="spacer"></span></div>`;
  const bindBack = (v, fallback) => K.on(v, 'click', '[data-back]', () => K.back(fallback || '/'));

  async function saveSettings(patch) {
    const r = await K.api('/me/settings', { method: 'PATCH', body: patch });
    K.me = Object.assign(K.me, r.user);
    return r.user;
  }

  K.route(
    '/settings',
    async (ctx) => {
      const v = ctx.view;
      const row = (key, ic, label, sub) => `<div class="menu-item" data-sw="${key}">${icon(ic)}<span class="grow">${label}${sub ? `<span class="hint" style="display:block">${sub}</span>` : ''}</span><button class="switch ${K.me.settings[key] || (key === 'isPrivate' && K.me.isPrivate) ? 'on' : ''}" aria-label="${label}" role="switch"></button></div>`;
      const link = (href, ic, label, end) => `<a class="menu-item" href="${href}">${icon(ic)}<span>${label}</span><span class="end">${end || ''}</span></a>`;

      function paint() {
        const m = K.me;
        v.innerHTML = `${header('Ayarlar')}
          <div class="section-title">Hesap</div>
          ${m.noPassword ? '' : `<button class="menu-item" data-pw>${icon('lock')}<span>Şifreyi değiştir</span></button>`}
          <button class="menu-item" data-acct>${icon('user')}<span>Hesap türü</span><span class="end">${m.acct === 'rp' ? 'RP hesabı' : 'Gerçek hesap'}</span></button>
          ${K.google.enabled() && !K.google.native() && !m.google ? `<div class="menu-item" id="glink-row">${icon('link')}<span class="grow">Google hesabını bağla<span class="hint" style="display:block">Sonra Google ile de girebilirsin</span></span></div><div class="gslot" id="glink"></div>` : ''}
          <button class="menu-item" data-logout-all>${icon('logout')}<span>Tüm cihazlardan çıkış yap</span></button>
          ${row('isPrivate', 'lock', 'Gizli hesap', 'Yalnızca onayladığın kişiler videolarını görür')}
          <div class="section-title">Gizlilik</div>
          ${row('hideVisitors', 'eye-off', 'Profil ziyaretlerimi gizle', 'Açıkken ziyaretçi listen de görünmez')}
          ${row('showLikes', 'heart', 'Beğendiklerim herkese açık')}
          ${row('restrictedMode', 'shield', 'Kısıtlı mod', 'Hassas olarak işaretlenen videoları gizler')}
          <button class="menu-item" data-msgs>${icon('inbox')}<span>Bana kimler mesaj atabilir?</span><span class="end">${MSG_LABEL[m.settings.allowMessages]}</span></button>
          <div class="section-title">Bildirimler</div>
          <div class="menu-item" data-push>${icon('bell')}<span class="grow">Anlık bildirimler<span class="hint" style="display:block" id="push-sub">Kontrol ediliyor…</span></span><button class="switch" id="push-sw" aria-label="Anlık bildirimler" role="switch"></button></div>
          <div class="section-title">Görünüm</div>
          <button class="menu-item" data-theme>${icon('sun')}<span>Tema</span><span class="end">${THEME_LABEL[m.settings.theme] || 'Koyu'}</span></button>
          <div class="section-title">Etkinlik</div>
          ${link('#/requests', 'user-plus', 'Takip istekleri', K.counters.requests ? K.counters.requests : '')}
          ${link('#/visitors', 'eye', 'Profilime bakanlar')}
          ${link('#/history', 'clock', 'İzleme geçmişi')}
          ${link('#/blocked', 'ban', 'Engellenen hesaplar')}
          ${m.role === 'admin' ? `<div class="section-title">Yönetim</div>${link('#/admin', 'shield', 'Yönetim paneli')}` : ''}
          <div class="section-title">Oturum</div>
          <button class="menu-item" data-logout>${icon('logout')}<span>Çıkış yap</span></button>
          <button class="menu-item danger" data-delete>${icon('trash')}<span>Hesabı kalıcı olarak sil</span></button>
          <p class="hint center" style="padding:22px 0 30px">${esc(K.config.appName)} · sürüm 1.0</p>`;
        linkGoogle();
      }
      function linkGoogle() {
        const gl = $('#glink', v);
        if (!gl) return;
        K.google.button(gl, async (credential) => {
          try {
            const r = await K.api('/auth/google-link', { method: 'POST', body: { credential } });
            K.me = r.user;
            K.toast('Google hesabın bağlandı', 'ok');
            paint();
          } catch (e) {
            K.fail(e);
          }
        });
      }
      paint();
      bindBack(v, '/me');
      K.push.status().then((s) => {
        const sw = $('#push-sw', v);
        if (!sw) return;
        sw.classList.toggle('on', s.on);
        $('#push-sub', v).textContent = s.text;
      });
      K.on(v, 'click', '[data-push]', async () => {
        const sw = $('#push-sw', v);
        const turnOn = !sw.classList.contains('on');
        try {
          if (turnOn) await K.push.enable(true);
          else await K.push.disable();
        } catch (e) {
          K.toast(e.message || 'Bildirim ayarı değiştirilemedi', 'error');
        }
        const s = await K.push.status();
        sw.classList.toggle('on', s.on);
        $('#push-sub', v).textContent = s.text;
      });

      K.on(v, 'click', '[data-sw]', async (row) => {
        const key = row.dataset.sw;
        const sw = $('.switch', row);
        const on = !sw.classList.contains('on');
        sw.classList.toggle('on', on);
        try {
          await saveSettings({ [key]: on });
        } catch (e) {
          sw.classList.toggle('on', !on);
          K.fail(e);
        }
      });
      K.on(v, 'click', '[data-theme]', () => {
        K.menu('Tema', ['dark', 'light', 'system'].map((t) => ({
          icon: t === 'dark' ? 'eye-off' : 'sun',
          label: THEME_LABEL[t],
          end: (K.me.settings.theme || 'dark') === t ? '✓' : '',
          run: async () => {
            K.applyTheme(t);
            try {
              await saveSettings({ theme: t });
            } catch (e) {}
            paint();
          },
        })));
      });
      K.on(v, 'click', '[data-msgs]', () => {
        K.menu('Mesaj izni', ['everyone', 'following', 'none'].map((t) => ({
          icon: 'inbox',
          label: MSG_LABEL[t],
          end: K.me.settings.allowMessages === t ? '✓' : '',
          run: async () => {
            try {
              await saveSettings({ allowMessages: t });
              paint();
            } catch (e) {
              K.fail(e);
            }
          },
        })));
      });
      K.on(v, 'click', '[data-pw]', () => {
        K.sheet({
          title: 'Şifreyi değiştir',
          html: `<div class="page col"><label class="field"><span>Mevcut şifre</span><input class="input" type="password" id="pw0" autocomplete="current-password"></label>
            <label class="field"><span>Yeni şifre (en az 8 karakter, harf + rakam)</span><input class="input" type="password" id="pw1" autocomplete="new-password"></label>
            <button class="btn primary block" id="pw-go">Güncelle</button></div>`,
          onMount: (api) => {
            $('#pw-go', api.el).onclick = async (e) => {
              const btn = e.currentTarget;
              btn.disabled = true;
              try {
                const r = await K.api('/auth/password', { method: 'POST', body: { current: $('#pw0', api.el).value, next: $('#pw1', api.el).value } });
                if (r.csrf) K.csrf = r.csrf;
                api.close();
                K.toast('Şifren güncellendi; diğer cihazlardaki oturumlar kapandı', 'ok');
              } catch (err) {
                K.fail(err);
                btn.disabled = false;
              }
            };
          },
        });
      });
      K.on(v, 'click', '[data-acct]', () => {
        K.menu('Hesap türü', [
          { icon: 'user', label: 'Gerçek hesap', run: () => setAcct('real') },
          { icon: 'star', label: 'RP hesabı (karakter / rol yapma)', run: () => setAcct('rp') },
        ]);
      });
      async function setAcct(a) {
        try {
          const r = await K.api('/me', { method: 'PATCH', body: { accountType: a } });
          K.me = r.user;
          K.toast(a === 'rp' ? 'Hesabın RP olarak işaretlendi' : 'Hesabın gerçek hesap olarak işaretlendi', 'ok');
          paint();
        } catch (e) {
          K.fail(e);
        }
      }
      K.on(v, 'click', '[data-logout-all]', async () => {
        if (!(await K.confirm({ title: 'Tüm cihazlardan çıkış yapılsın mı?', text: 'Bu cihaz dahil her yerde oturumun kapanır. Yeniden giriş yapman gerekir.', ok: 'Çıkış yap', danger: true }))) return;
        try {
          await K.api('/auth/logout-all', { method: 'POST' });
        } catch (e) {}
        await K.refreshSession().catch(() => {});
        K.updateNav();
        K.go('/login');
      });
      K.on(v, 'click', '[data-logout]', async () => {
        try {
          await K.api('/auth/logout', { method: 'POST' });
        } catch (e) {}
        await K.refreshSession().catch(() => {});
        K.updateNav();
        K.go('/login');
      });
      K.on(v, 'click', '[data-delete]', async () => {
        if (!(await K.confirm({ title: 'Hesabın silinsin mi?', text: 'Tüm videoların, yorumların ve mesajların kalıcı olarak silinir. Bu işlem geri alınamaz.', ok: 'Devam et', danger: true }))) return;
        const pw = K.me.noPassword
          ? await K.ask({ title: 'Kullanıcı adını yaz', text: `Silme işlemini onaylamak için @${K.me.username} yaz.`, ok: 'Hesabı sil', danger: true })
          : await K.ask({ title: 'Şifreni gir', text: 'Silme işlemini onaylamak için şifren gerekli.', password: true, ok: 'Hesabı sil', danger: true });
        if (!pw) return;
        try {
          await K.api('/auth/delete-account', { method: 'POST', body: { password: pw } });
          await K.refreshSession().catch(() => {});
          K.updateNav();
          K.toast('Hesabın silindi');
          K.go('/login');
        } catch (e) {
          K.fail(e);
        }
      });
    },
    { nav: 'me' }
  );

  /* ---------------- izleme geçmişi ---------------- */
  K.route(
    '/history',
    async (ctx) => {
      const v = ctx.view;
      v.innerHTML = `<div class="topbar"><button class="icon-btn" data-back>${icon('back')}</button><h1>İzleme geçmişi</h1><button class="icon-btn" data-clear aria-label="Temizle">${icon('trash')}</button></div><div class="grid" id="hg"></div><div id="hm"></div>`;
      bindBack(v, '/settings');
      const grid = $('#hg', v);
      let page = 0;
      const inf = K.infinite(v, $('#hm', v), async () => {
        const r = await K.api(`/me/history?page=${page}`);
        if (!ctx.alive()) return false;
        page++;
        grid.insertAdjacentHTML('beforeend', r.videos.map((x) => K.tile(x)).join(''));
        if (!grid.children.length) {
          grid.style.display = 'block';
          grid.innerHTML = K.empty('clock', 'İzleme geçmişin boş', 'İzlediğin videolar burada listelenir.');
        }
        return r.hasMore;
      });
      K.on(v, 'click', '[data-clear]', async () => {
        if (!(await K.confirm({ title: 'Geçmiş temizlensin mi?', ok: 'Temizle', danger: true }))) return;
        await K.api('/me/history', { method: 'DELETE' }).catch(K.fail);
        grid.style.display = 'block';
        grid.innerHTML = K.empty('clock', 'İzleme geçmişin boş');
      });
      return () => inf.stop();
    },
    { nav: 'me' }
  );

  /* ---------------- ziyaretçiler ---------------- */
  K.route(
    '/visitors',
    async (ctx) => {
      const v = ctx.view;
      v.innerHTML = `${header('Profilime bakanlar')}<div id="vb">${K.spinner()}</div>`;
      bindBack(v, '/settings');
      const d = await K.api('/me/visitors');
      if (!ctx.alive()) return;
      $('#vb', v).innerHTML =
        (d.hidden ? '<p class="hint" style="padding:12px 16px">Ziyaretlerini gizlediğin için ziyaretçi kaydı tutulmuyor ve başkalarının ziyaretini de görmüyorsun.</p>' : '') +
        (d.visitors.length
          ? d.visitors.map((x) => `<a class="list-item" href="#/u/${esc(x.user.username)}">${K.avatar(x.user)}<span class="grow"><span class="title">${K.nameHTML(x.user)}</span><span class="sub" style="display:block">@${esc(x.user.username)}</span></span><span class="hint">${K.timeAgo(x.at)}</span></a>`).join('')
          : K.empty('eye', 'Henüz kimse bakmadı', 'Profilini ziyaret edenler burada listelenir.'));
    },
    { nav: 'me' }
  );

  /* ---------------- engellenenler ---------------- */
  K.route(
    '/blocked',
    async (ctx) => {
      const v = ctx.view;
      v.innerHTML = `${header('Engellenen hesaplar')}<div id="bb">${K.spinner()}</div>`;
      bindBack(v, '/settings');
      const d = await K.api('/me/blocks');
      if (!ctx.alive()) return;
      const box = $('#bb', v);
      const paint = (users) => {
        box.innerHTML = users.length
          ? users.map((u) => `<div class="list-item" data-uid="${esc(u.id)}"><a class="row grow" href="#/u/${esc(u.username)}">${K.avatar(u)}<span class="grow"><span class="title">${K.nameHTML(u)}</span><span class="sub" style="display:block">@${esc(u.username)}</span></span></a><button class="btn sm" data-unblock>Engeli kaldır</button></div>`).join('')
          : K.empty('ban', 'Engellediğin kimse yok');
      };
      paint(d.users);
      K.on(box, 'click', '[data-unblock]', async (b) => {
        const row = b.closest('[data-uid]');
        try {
          await K.api(`/users/${row.dataset.uid}/block`, { method: 'POST' });
          row.remove();
          if (!$('[data-uid]', box)) paint([]);
        } catch (e) {
          K.fail(e);
        }
      });
    },
    { nav: 'me' }
  );
})();
