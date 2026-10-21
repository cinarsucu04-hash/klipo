/* Klipo profil: video ızgarası, takip, hikaye halkası, profil düzenleme */
(function () {
  'use strict';
  const K = window.K;
  const { esc, icon, $, $$ } = K;

  K.route('/me', (ctx) => K.go('/u/' + K.me.username, true), { nav: 'me' });

  const profileLink = (u) => `${location.origin}/#/u/${u.username}`;

  K.route(
    '/u/:username',
    async (ctx) => {
      const v = ctx.view;
      const username = ctx.params.username.toLowerCase();
      v.innerHTML = K.spinner();
      let d;
      try {
        d = await K.api(`/users/${encodeURIComponent(username)}`);
      } catch (e) {
        v.innerHTML = `<div class="topbar"><button class="icon-btn" data-back>${icon('back')}</button><h1>Profil</h1><span class="spacer"></span></div>${K.empty('user', 'Kullanıcı bulunamadı', e.message)}`;
        K.on(v, 'click', '[data-back]', () => K.back('/'));
        return;
      }
      if (!ctx.alive()) return;
      const isMe = d.relation.isMe;
      K.setNavActive(isMe ? 'me' : '');
      let u = d.user;
      let rel = d.relation;
      let stats = d.stats;
      let tab = 'videos';
      let stop = null;

      function headerHTML() {
        const hasStory = d.stories.length > 0;
        const allSeen = hasStory && d.stories.every((s) => s.seen);
        const av = K.avatar(u, 'xl');
        const avatar = hasStory ? `<button data-story class="story-ring ${allSeen ? 'seen' : ''}" aria-label="Hikayeyi izle">${av}</button>` : av;
        const actions = isMe
          ? `<button class="btn" data-edit>Profili düzenle</button><button class="btn fixed" data-share aria-label="Profili paylaş">${icon('share', 'sm')}</button>`
          : `<button class="${K.followClass(rel)}" data-follow-main>${K.followLabel(rel)}</button>${rel.blocked ? '' : '<button class="btn" data-msg>Mesaj</button>'}`;
        return `<div class="banner" ${u.banner ? `style="background-image:url('${esc(u.banner)}')"` : ''}>
            <div class="profile-top-actions"><button class="icon-btn" data-back aria-label="Geri">${icon('back')}</button>
            ${isMe ? `<a class="icon-btn" href="#/settings" aria-label="Ayarlar">${icon('sliders')}</a>` : `<button class="icon-btn" data-more aria-label="Daha fazla">${icon('more')}</button>`}</div></div>
          <div class="profile-head">${avatar}
            <div class="profile-name">${K.nameHTML(u)}${u.isPrivate ? `<span style="margin-left:6px;color:var(--muted)">${icon('lock', 'sm')}</span>` : ''}</div>
            <div class="profile-user">@${esc(u.username)}${rel.followsMe && !isMe ? ' · <span class="tag-pill">Seni takip ediyor</span>' : ''}</div>
            <div class="stats">
              <button data-list="following"><b data-s="following">${K.count(stats.following)}</b><span>Takip</span></button>
              <button data-list="followers"><b data-s="followers">${K.count(stats.followers)}</b><span>Takipçi</span></button>
              <button data-nolist><b>${K.count(stats.likes)}</b><span>Beğeni</span></button></div>
            ${u.bio ? `<div class="bio">${K.linkify(u.bio)}</div>` : ''}
            ${u.link ? `<a class="bio-link" href="${esc(u.link)}" target="_blank" rel="noopener noreferrer nofollow">${icon('link', 'sm')}${esc(u.link.replace(/^https?:\/\//, ''))}</a>` : ''}
            <div class="profile-actions">${rel.blocked ? '<button class="btn" data-unblock>Engeli kaldır</button>' : actions}</div></div>`;
      }

      function render() {
        const tabs = [['videos', 'grid', 'Videolar'], ['liked', 'heart', 'Beğenilenler']];
        if (isMe) tabs.push(['saved', 'bookmark', 'Kaydedilenler']);
        v.innerHTML = `${headerHTML()}
          ${d.canView ? `<div class="tabs" id="ptabs">${tabs.map((t) => `<button data-t="${t[0]}" class="${t[0] === tab ? 'active' : ''}" aria-label="${t[2]}">${icon(t[1], 'sm')}</button>`).join('')}</div><div id="pgrid" class="grid"></div><div id="pmore"></div>` : `<div class="private-box">${icon('lock')}<b>${rel.blocked ? 'Bu hesabı engelledin' : 'Bu hesap gizli'}</b><span class="muted">${rel.blocked ? 'Engeli kaldırarak içeriklerini tekrar görebilirsin.' : 'Videolarını görmek için takip isteği gönder.'}</span></div>`}`;
        if (d.canView) loadTab();
      }

      function loadTab() {
        if (stop) stop();
        const grid = $('#pgrid', v);
        grid.innerHTML = '';
        grid.style.display = '';
        let page = 0;
        const more = $('#pmore', v);
        more.innerHTML = '';
        const inf = K.infinite(v, more, async () => {
          const r = await K.api(`/users/${encodeURIComponent(username)}/videos?tab=${tab}&page=${page}`);
          if (!ctx.alive()) return false;
          page++;
          if (r.hidden) {
            grid.style.display = 'block';
            grid.innerHTML = K.empty('lock', tab === 'liked' ? 'Beğeniler gizli' : 'Bu bölüm gizli', 'Bu kullanıcı bu bölümü herkese açık yapmamış.');
            return false;
          }
          grid.insertAdjacentHTML('beforeend', r.videos.map((x) => K.tile(x)).join(''));
          if (!grid.children.length) {
            grid.style.display = 'block';
            const msg = { videos: ['video', isMe ? 'Henüz video paylaşmadın' : 'Henüz video yok'], liked: ['heart', 'Beğenilen video yok'], saved: ['bookmark', 'Kaydedilen video yok'] }[tab];
            grid.innerHTML = K.empty(msg[0], msg[1], isMe && tab === 'videos' ? 'İlk videonu yükle ve topluluğa katıl.' : '', isMe && tab === 'videos' ? '<a class="btn primary" href="#/upload">Video yükle</a>' : '');
          }
          return r.hasMore;
        });
        stop = () => inf.stop();
      }

      K.on(v, 'click', '[data-back]', () => K.back('/'));
      K.on(v, 'click', '#ptabs button', (b) => {
        tab = b.dataset.t;
        $$('#ptabs button', v).forEach((x) => x.classList.toggle('active', x === b));
        loadTab();
      });
      K.on(v, 'click', '[data-story]', () => K.openStories([{ user: d.user, stories: d.stories, allSeen: false }], 0, async () => {
        const fresh = await K.api(`/users/${encodeURIComponent(username)}`).catch(() => null);
        if (fresh && ctx.alive()) {
          d = fresh;
          render();
        }
      }));
      K.on(v, 'click', '[data-share]', async () => ((await K.copy(profileLink(u))) ? K.toast('Profil bağlantısı kopyalandı', 'ok') : 0));
      K.on(v, 'click', '[data-edit]', () => editProfile(u, (nu) => {
        u = Object.assign(u, nu);
        K.me = Object.assign(K.me, nu);
        K.updateNav && K.updateNav();
        render();
      }));
      K.on(v, 'click', '[data-follow-main]', async (b) => {
        b.disabled = true;
        try {
          const r = await K.api(`/users/${u.id}/follow`, { method: 'POST' });
          rel.following = r.following;
          rel.requested = r.requested;
          stats.followers = r.followers;
          if (r.requested) K.toast('Takip isteği gönderildi');
          // özel hesapta takipten çıkınca içerik tekrar kilitlenir
          if (u.isPrivate && !r.following) {
            d.canView = false;
            return render();
          }
          if (u.isPrivate && r.following && !d.canView) {
            d = await K.api(`/users/${encodeURIComponent(username)}`);
            u = d.user;
            rel = d.relation;
            stats = d.stats;
            return render();
          }
          b.className = K.followClass(rel);
          b.textContent = K.followLabel(rel);
          $('[data-s=followers]', v).textContent = K.count(stats.followers);
        } catch (e) {
          K.fail(e);
        }
        b.disabled = false;
      });
      K.on(v, 'click', '[data-msg]', async () => {
        try {
          const r = await K.api('/chats/dm', { method: 'POST', body: { userId: u.id } });
          K.go('/chat/' + r.chatId);
        } catch (e) {
          K.fail(e);
        }
      });
      K.on(v, 'click', '[data-unblock]', () => K.blockUser(u, () => K.render()));
      K.on(v, 'click', '[data-list]', (b) => {
        if (!d.canView) return K.toast('Bu hesap gizli');
        userList(u, b.dataset.list);
      });
      K.on(v, 'click', '[data-more]', () => {
        const admin = K.me.role === 'admin';
        K.menu(`@${u.username}`, [
          { icon: 'link', label: 'Profil bağlantısını kopyala', run: async () => ((await K.copy(profileLink(u))) ? K.toast('Kopyalandı', 'ok') : 0) },
          { icon: 'flag', label: 'Şikayet et', run: () => K.report('user', u.id, `@${u.username} kullanıcısını neden şikayet ediyorsun?`) },
          { icon: 'ban', label: rel.blocked ? 'Engeli kaldır' : 'Engelle', danger: true, run: () => K.blockUser(u, () => K.render()) },
          admin && { icon: 'check', label: u.verified ? 'Doğrulama rozetini kaldır (yönetici)' : 'Doğrulama rozeti ver (yönetici)', run: async () => {
            try {
              const r = await K.api(`/admin/users/${u.id}/verify`, { method: 'POST' });
              u.verified = r.verified;
              K.toast(r.verified ? 'Rozet verildi' : 'Rozet kaldırıldı', 'ok');
              render();
            } catch (e) {
              K.fail(e);
            }
          } },
          admin && { icon: 'shield', label: 'Hesabı askıya al (yönetici)', danger: true, run: async () => {
            const reason = await K.ask({ title: 'Askıya alma nedeni', placeholder: 'Topluluk kurallarını ihlal', ok: 'Askıya al', danger: true, max: 200 });
            if (reason === null) return;
            try {
              await K.api(`/admin/users/${u.id}/ban`, { method: 'POST', body: { reason } });
              K.toast('Hesap askıya alındı', 'ok');
            } catch (e) {
              K.fail(e);
            }
          } },
        ]);
      });

      render();
      return () => stop && stop();
    },
    { nav: 'me' }
  );

  /* ---------------- takipçi / takip listesi ---------------- */
  function userList(u, kind) {
    let page = 0;
    let busy = false;
    const s = K.sheet({
      title: kind === 'followers' ? 'Takipçiler' : 'Takip edilenler',
      tall: true,
      html: '<div class="ul"></div><div class="more"></div>',
    });
    const ul = $('.ul', s.body);
    const more = $('.more', s.body);
    K.bindFollow(s.body);
    async function load() {
      if (busy) return;
      busy = true;
      more.innerHTML = K.spinner();
      try {
        const r = await K.api(`/users/${encodeURIComponent(u.username)}/${kind}?page=${page}`);
        page++;
        ul.insertAdjacentHTML('beforeend', r.users.map((x) => K.userRow(x, { follow: true })).join(''));
        if (!ul.children.length) ul.innerHTML = K.empty('users', kind === 'followers' ? 'Henüz takipçi yok' : 'Kimse takip edilmiyor');
        more.innerHTML = r.hasMore ? '<button class="btn block" data-more style="margin:8px 0">Daha fazla</button>' : '';
      } catch (e) {
        more.innerHTML = '';
        K.fail(e);
      }
      busy = false;
    }
    K.on(s.body, 'click', '[data-more]', load);
    load();
  }

  /* ---------------- profil düzenleme ---------------- */
  function editProfile(u, onSaved) {
    let avatarFile = null;
    let bannerFile = null;
    let removeAvatar = false;
    let removeBanner = false;
    K.sheet({
      title: 'Profili düzenle',
      tall: true,
      html: `<div class="page col">
        <div class="banner" id="ep-banner" style="border-radius:12px;height:110px;${u.banner ? `background-image:url('${esc(u.banner)}')` : ''}">
          <label class="btn sm" style="position:absolute;right:8px;bottom:8px;cursor:pointer;background:rgba(0,0,0,.55);color:#fff">${icon('camera', 'sm')} Kapak<input type="file" id="ep-bfile" accept="image/*" hidden></label></div>
        <div class="row"><span id="ep-av">${K.avatar(u, 'xl')}</span>
          <div class="col" style="gap:8px"><label class="btn sm" style="cursor:pointer">${icon('camera', 'sm')} Fotoğraf değiştir<input type="file" id="ep-afile" accept="image/*" hidden></label>
          <button class="btn sm ghost" id="ep-arm">Fotoğrafı kaldır</button></div></div>
        <label class="field"><span>Görünen ad</span><input class="input" id="ep-nick" maxlength="30" value="${esc(u.nickname)}"></label>
        <label class="field"><span>Kullanıcı adı</span><input class="input" value="@${esc(u.username)}" disabled></label>
        <label class="field"><span>Biyografi</span><textarea class="input" id="ep-bio" maxlength="200">${esc(u.bio)}</textarea></label>
        <label class="field"><span>Bağlantı</span><input class="input" id="ep-link" maxlength="200" placeholder="https://" value="${esc(u.link)}" inputmode="url"></label>
        <button class="btn primary block" id="ep-save">Kaydet</button></div>`,
      onMount: (api) => {
        const el = api.el;
        const size = K.config.maxImageMB * 1048576;
        $('#ep-afile', el).onchange = (e) => {
          const f = e.target.files[0];
          if (!f) return;
          if (f.size > size) return K.toast(`Görsel en fazla ${K.config.maxImageMB} MB olabilir`, 'error');
          avatarFile = f;
          removeAvatar = false;
          $('#ep-av', el).innerHTML = `<span class="avatar xl"><img src="${URL.createObjectURL(f)}" alt=""></span>`;
        };
        $('#ep-bfile', el).onchange = (e) => {
          const f = e.target.files[0];
          if (!f) return;
          if (f.size > size) return K.toast(`Görsel en fazla ${K.config.maxImageMB} MB olabilir`, 'error');
          bannerFile = f;
          removeBanner = false;
          $('#ep-banner', el).style.backgroundImage = `url('${URL.createObjectURL(f)}')`;
        };
        $('#ep-arm', el).onclick = () => {
          avatarFile = null;
          removeAvatar = true;
          $('#ep-av', el).innerHTML = K.avatar(Object.assign({}, u, { avatar: '' }), 'xl');
        };
        $('#ep-save', el).onclick = async (e) => {
          const b = e.currentTarget;
          const fd = new FormData();
          fd.append('nickname', $('#ep-nick', el).value);
          fd.append('bio', $('#ep-bio', el).value);
          fd.append('link', $('#ep-link', el).value);
          if (avatarFile) fd.append('avatar', avatarFile);
          if (bannerFile) fd.append('banner', bannerFile);
          if (removeAvatar) fd.append('removeAvatar', '1');
          if (removeBanner) fd.append('removeBanner', '1');
          b.disabled = true;
          try {
            const r = await K.api('/me', { method: 'PATCH', form: fd });
            api.close();
            K.toast('Profil güncellendi', 'ok');
            onSaved(r.user);
          } catch (err) {
            K.fail(err);
            b.disabled = false;
          }
        };
      },
    });
  }
})();
