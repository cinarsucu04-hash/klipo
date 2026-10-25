/* Klipo gelen kutusu: bildirimler, sohbet listesi, sohbet ekranı, grup yönetimi */
(function () {
  'use strict';
  const K = window.K;
  const { esc, icon, $, $$ } = K;

  const NOTIF_TEXT = {
    like: () => 'videonu beğendi',
    comment_like: () => 'yorumunu beğendi',
    comment: (n) => `videona yorum yaptı: “${n.text}”`,
    reply: (n) => `yorumuna yanıt verdi: “${n.text}”`,
    mention: (n) => `senden bahsetti: “${n.text}”`,
    follow: () => 'seni takip etmeye başladı',
    follow_request: () => 'seni takip etmek istiyor',
    follow_accepted: () => 'takip isteğini kabul etti',
  };
  const NOTIF_BADGE = {
    like: ['heart', '#ff3d5a'], comment_like: ['heart', '#ff3d5a'], comment: ['comment', '#8b5cf6'], reply: ['comment', '#8b5cf6'],
    mention: ['hash', '#f59e0b'], follow: ['user-plus', '#3b9bff'], follow_request: ['user-plus', '#3b9bff'], follow_accepted: ['check', '#16a34a'],
  };
  const FILTERS = [['', 'Tümü'], ['likes', 'Beğeniler'], ['comments', 'Yorumlar'], ['follows', 'Takip'], ['mentions', 'Bahsetmeler']];

  async function refreshCounters() {
    try {
      K.counters = await K.api('/counters');
      K.paintBadges && K.paintBadges();
    } catch (e) {}
  }
  K.refreshCounters = refreshCounters;

  /* ---------------- Gelen kutusu ---------------- */
  K.route(
    '/inbox',
    async (ctx) => {
      const v = ctx.view;
      let tab = ctx.query.tab === 'messages' ? 'messages' : 'notifications';
      let filter = '';
      v.innerHTML = `<div class="topbar"><span class="spacer"></span><h1>Gelen kutusu</h1>
          <button class="icon-btn" data-new aria-label="Yeni mesaj">${icon('edit')}</button></div>
        <div class="tabs" id="itabs"><button data-tab="notifications">Bildirimler</button><button data-tab="messages">Mesajlar</button></div>
        <div id="ibody"></div>`;
      const body = $('#ibody', v);
      let stop = null;

      function tabBadges() {
        const t = $$('#itabs button', v);
        t[0].innerHTML = 'Bildirimler' + (K.counters.notifications ? ` <span class="unread-dot" style="display:inline-grid;margin-left:4px">${K.counters.notifications}</span>` : '');
        t[1].innerHTML = 'Mesajlar' + (K.counters.messages ? ` <span class="unread-dot" style="display:inline-grid;margin-left:4px">${K.counters.messages}</span>` : '');
        t.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
      }

      async function showNotifications() {
        body.innerHTML = `${K.counters.requests ? `<a class="list-item" href="#/requests" style="background:var(--bg2)"><span class="avatar" style="background:var(--grad)">${icon('user-plus')}</span><span class="grow"><span class="title">Takip istekleri</span><span class="sub" style="display:block">${K.counters.requests} bekleyen istek</span></span>${icon('next')}</a>` : ''}
          <div class="chips">${FILTERS.map((f) => `<button class="chip ${f[0] === filter ? 'active' : ''}" data-f="${f[0]}">${f[1]}</button>`).join('')}</div><div id="nlist"></div><div id="nmore"></div>`;
        const list = $('#nlist', body);
        let page = 0;
        let unreadMarked = false;
        const inf = K.infinite(v, $('#nmore', body), async () => {
          const d = await K.api(`/notifications?page=${page}${filter ? '&filter=' + filter : ''}`);
          if (!ctx.alive()) return false;
          page++;
          list.insertAdjacentHTML('beforeend', d.notifications.map(notifHTML).join(''));
          if (!list.children.length) list.innerHTML = K.empty('bell', 'Henüz bildirim yok', 'Videolarına gelen beğeni, yorum ve takipler burada görünür.');
          if (!unreadMarked && page === 1 && K.counters.notifications) {
            unreadMarked = true;
            K.api('/notifications/read', { method: 'POST' }).then(() => {
              K.counters.notifications = 0;
              K.paintBadges && K.paintBadges();
              tabBadges();
            }).catch(() => {});
          }
          return d.hasMore;
        });
        stop = () => inf.stop();
      }

      function notifHTML(n) {
        const b = NOTIF_BADGE[n.type] || ['bell', '#888'];
        const href = n.video ? `#/v/${n.video.id}` : `#/u/${n.actor.username}`;
        const thumb = n.video ? `<span class="thumb" ${n.video.posterUrl ? `style="background-image:url('${esc(n.video.posterUrl)}')"` : ''}></span>` : '';
        const text = (NOTIF_TEXT[n.type] || (() => ''))(n);
        return `<a class="notif ${n.read ? '' : 'unread'}" href="${n.type === 'follow_request' ? '#/requests' : href}">
          <span style="position:relative">${K.avatar(n.actor)}<span class="type-icon" style="background:${b[1]}">${icon(b[0])}</span></span>
          <span class="txt"><b>${K.nameHTML(n.actor)}</b> ${esc(text)} <span class="when">${K.timeAgo(n.createdAt)}</span></span>${thumb}</a>`;
      }

      async function showMessages() {
        body.innerHTML = `<div id="tray"></div><div id="clist">${K.spinner()}</div>`;
        K.storiesTray($('#tray', body));
        let d;
        try {
          d = await K.api('/chats');
        } catch (e) {
          $('#clist', body).innerHTML = K.empty('refresh', 'Yüklenemedi', e.message);
          return;
        }
        if (!ctx.alive()) return;
        $('#clist', body).innerHTML = d.chats.length
          ? d.chats.map(chatRow).join('')
          : K.empty('inbox', 'Henüz mesajın yok', 'Bir arkadaşına yaz ya da grup kur.', '<button class="btn primary" data-new>Yeni mesaj</button>');
      }

      function chatRow(c) {
        const who = c.user ? K.avatar(c.user, 'lg') : `<span class="avatar lg" style="background:var(--grad)">${icon('users')}</span>`;
        const last = c.lastMessage ? (c.lastMessage.mine ? 'Sen: ' : '') + c.lastMessage.text : 'Sohbeti başlat';
        return `<a class="list-item" href="#/chat/${esc(c.id)}">${who}<span class="grow"><span class="title ellipsis" style="display:block">${esc(c.name)}${c.type === 'group' ? ` <span class="muted" style="font-weight:400">· ${c.memberCount} kişi</span>` : ''}</span>
          <span class="sub ellipsis" style="display:block;${c.unread ? 'color:var(--text);font-weight:600' : ''}">${esc(last)}</span></span>
          <span class="col" style="align-items:flex-end;gap:4px;flex:none"><span class="hint">${c.lastAt ? K.timeAgo(c.lastAt) : ''}</span>${c.unread ? `<span class="unread-dot">${c.unread}</span>` : ''}</span></a>`;
      }

      function show() {
        if (stop) stop();
        stop = null;
        tabBadges();
        (tab === 'messages' ? showMessages : showNotifications)();
      }

      K.on(v, 'click', '#itabs button', (b) => {
        if (b.dataset.tab === tab) return;
        tab = b.dataset.tab;
        history.replaceState(history.state, '', `#/inbox?tab=${tab}`);
        show();
      });
      K.on(v, 'click', '[data-f]', (b) => {
        filter = b.dataset.f;
        show();
      });
      K.on(v, 'click', '[data-new]', () => K.newChat());

      await refreshCounters();
      if (!ctx.alive()) return;
      show();
      return () => stop && stop();
    },
    { nav: 'inbox' }
  );

  /* ---------------- Yeni sohbet / grup ---------------- */
  K.newChat = function () {
    K.menu('Yeni', [
      { icon: 'user', label: 'Kişiye mesaj gönder', run: pickUser },
      { icon: 'users', label: 'Grup oluştur', run: createGroup },
    ]);
  };

  function pickUser() {
    K.sheet({
      title: 'Kime yazacaksın?',
      tall: true,
      html: '<div class="page" style="padding-bottom:0"><input class="input" id="pu-q" placeholder="Kullanıcı adı ara…" autocomplete="off" maxlength="40"></div><div id="pu-list"></div>',
      onMount: (api) => {
        const list = $('#pu-list', api.el);
        const input = $('#pu-q', api.el);
        const search = K.debounce(async () => {
          const q = input.value.trim();
          if (q.length < 2) return (list.innerHTML = '<p class="muted center" style="padding:20px">En az 2 harf yaz.</p>');
          try {
            const d = await K.api(`/search?q=${encodeURIComponent(q)}&type=users`);
            list.innerHTML = d.users.length ? d.users.map((u) => `<button class="list-item" data-u="${esc(u.id)}">${K.avatar(u)}<span class="grow"><span class="title">${K.nameHTML(u)}</span><span class="sub" style="display:block">@${esc(u.username)}</span></span></button>`).join('') : K.empty('search', 'Kullanıcı bulunamadı');
          } catch (e) {
            K.fail(e);
          }
        }, 300);
        input.addEventListener('input', search);
        setTimeout(() => input.focus(), 150);
        K.on(api.el, 'click', '[data-u]', async (b) => {
          try {
            const r = await K.api('/chats/dm', { method: 'POST', body: { userId: b.dataset.u } });
            api.close();
            K.go('/chat/' + r.chatId);
          } catch (e) {
            K.fail(e);
          }
        });
      },
    });
  }

  function createGroup() {
    K.sheet({
      title: 'Yeni grup',
      html: `<div class="page col">
        <label class="field"><span>Grup adı</span><input class="input" id="g-name" maxlength="40" placeholder="Örn. Hafta sonu planı"></label>
        <label class="field"><span>Üyeler (kullanıcı adları, virgülle)</span><input class="input" id="g-mem" placeholder="ali, ayse, mehmet" autocomplete="off"></label>
        <p class="hint">En fazla 50 kişi. Mesaj almayı kapatmış kişiler eklenemez.</p>
        <button class="btn primary block" id="g-go">Grubu oluştur</button></div>`,
      onMount: (api) => {
        $('#g-go', api.el).onclick = async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            const r = await K.api('/chats/group', { method: 'POST', body: { name: $('#g-name', api.el).value, members: $('#g-mem', api.el).value } });
            api.close();
            if (r.skipped && r.skipped.length) K.toast('Eklenemeyenler: ' + r.skipped.join(', '));
            K.go('/chat/' + r.chatId);
          } catch (err) {
            K.fail(err);
            btn.disabled = false;
          }
        };
      },
    });
  }

  /* ---------------- Sohbet ekranı ---------------- */
  const LINK_RE = () => new RegExp(location.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/#/v/([a-f0-9]{24})', 'g');

  K.route(
    '/chat/:id',
    async (ctx) => {
      const v = ctx.view;
      const id = ctx.params.id;
      let chat;
      try {
        chat = (await K.api(`/chats/${id}`)).chat;
      } catch (e) {
        v.innerHTML = `<div class="topbar"><button class="icon-btn" data-back>${icon('back')}</button><h1>Sohbet</h1><span class="spacer"></span></div>${K.empty('inbox', 'Sohbet açılamadı', e.message)}`;
        K.on(v, 'click', '[data-back]', () => K.back('/inbox'));
        return;
      }
      if (!ctx.alive()) return;

      const msgs = new Map();
      let senders = {};
      let hasMore = false;
      let seenUpTo = null;
      let busy = false;
      let timer = null;

      const head = chat.type === 'dm' && chat.user ? K.avatar(chat.user, 'sm') : `<span class="avatar sm" style="background:var(--grad)">${icon('users', 'sm')}</span>`;
      v.innerHTML = `<div class="chat-wrap">
        <div class="topbar" style="position:static"><button class="icon-btn" data-back aria-label="Geri">${icon('back')}</button>
          <a class="row grow" ${chat.type === 'dm' && chat.user ? `href="#/u/${esc(chat.user.username)}"` : `data-info href="#/chat/${esc(id)}"`} style="gap:10px;min-width:0">${head}
            <span class="grow" style="min-width:0"><b class="ellipsis" style="display:block">${esc(chat.name)}${chat.user && chat.user.verified ? K.verifiedBadge() : ''}</b>
            <span class="hint ellipsis" style="display:block">${chat.type === 'group' ? chat.members.length + ' üye' : '@' + esc(chat.user ? chat.user.username : '')}</span></span></a>
          <button class="icon-btn" data-menu aria-label="Seçenekler">${icon('more')}</button></div>
        <div class="chat-list" id="cl"></div>
        <form class="chat-form" id="cf"><label class="icon-btn" style="cursor:pointer" aria-label="Fotoğraf">${icon('image')}<input type="file" id="cimg" accept="image/*" hidden></label>
          <textarea class="input" id="ctext" rows="1" maxlength="1000" placeholder="Mesaj yaz…"></textarea>
          <button class="send-btn" aria-label="Gönder">${icon('send')}</button></form></div>`;
      const list = $('#cl', v);
      const input = $('#ctext', v);
      const fileIn = $('#cimg', v);
      K.on(v, 'click', '[data-back]', () => K.back('/inbox'));

      const sorted = () => [...msgs.values()].sort((a, b) => (a.id < b.id ? -1 : 1));

      function linkCard(text) {
        const re = LINK_RE();
        const ids = [];
        let m;
        while ((m = re.exec(text))) ids.push(m[1]);
        const cleaned = text.replace(LINK_RE(), '').trim();
        return (
          (cleaned ? K.linkify(cleaned) : '') +
          ids.map((x) => `<a class="btn sm" href="#/v/${x}" style="margin-top:6px;background:rgba(255,255,255,.2);color:inherit">${icon('play', 'sm')} Videoyu izle</a>`).join('')
        );
      }

      function bubble(m, i, arr) {
        if (m.type === 'system') return `<div class="msg system">${esc(m.text)}</div>`;
        const mine = m.senderId === K.me.id;
        const s = senders[m.senderId];
        let h = '';
        const prev = arr[i - 1];
        if (!prev || K.dayLabel(prev.createdAt) !== K.dayLabel(m.createdAt)) h += `<div class="day-sep">${K.dayLabel(m.createdAt)}</div>`;
        const showName = chat.type === 'group' && !mine && s && (!prev || prev.senderId !== m.senderId);
        const ref = m.storyRef
          ? `<div class="story-ref">${m.storyRef.mediaType === 'image' ? `<img src="${esc(m.storyRef.mediaUrl)}" alt="">` : icon('video', 'sm')}<span>Hikayene yanıt</span></div>`
          : '';
        const isLastMine = mine && !arr.slice(i + 1).some((x) => x.senderId === K.me.id);
        h += `<div class="msg ${mine ? 'mine' : ''}">${showName ? `<div class="who">${esc(s.nickname)}</div>` : ''}${ref}${m.mediaUrl ? `<img class="pic" src="${esc(m.mediaUrl)}" alt="Fotoğraf" loading="lazy">` : ''}${m.text ? `<div>${linkCard(m.text)}</div>` : ''}
          <div class="time">${K.clock(m.createdAt)}${isLastMine && chat.type === 'dm' && seenUpTo && m.id <= seenUpTo ? ' · Görüldü' : ''}${isLastMine && chat.type === 'group' && m.readCount ? ` · ${m.readCount} kişi gördü` : ''}</div></div>`;
        return h;
      }

      function render(stick) {
        const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 140;
        const arr = sorted();
        list.innerHTML =
          (hasMore ? '<button class="btn sm" data-older style="align-self:center;margin:6px">Eski mesajları yükle</button>' : '') +
          (arr.length ? arr.map(bubble).join('') : '<div class="empty"><b>Merhaba de 👋</b><span>İlk mesajı sen gönder.</span></div>');
        if (stick || nearBottom) list.scrollTop = list.scrollHeight;
      }

      function absorb(d, replaceSeen) {
        Object.assign(senders, d.senders || {});
        d.messages.forEach((m) => msgs.set(m.id, m));
        if (replaceSeen) seenUpTo = d.seenUpTo;
      }

      async function poll(first) {
        if (busy || document.hidden) return;
        busy = true;
        try {
          const d = await K.api(`/chats/${id}/messages`);
          if (!ctx.alive()) return;
          const before = msgs.size + '|' + seenUpTo + '|' + [...msgs.values()].map((m) => m.readCount || 0).join('');
          if (first) hasMore = d.hasMore;
          absorb(d, true);
          const after = msgs.size + '|' + seenUpTo + '|' + [...msgs.values()].map((m) => m.readCount || 0).join('');
          if (first || before !== after) render(first);
          if (first) K.refreshCounters();
        } catch (e) {
          if (first) K.fail(e);
        }
        busy = false;
      }

      K.on(list, 'click', '[data-older]', async () => {
        const oldest = sorted()[0];
        if (!oldest) return;
        const keep = list.scrollHeight - list.scrollTop;
        try {
          const d = await K.api(`/chats/${id}/messages?before=${oldest.id}`);
          hasMore = d.hasMore;
          absorb(d, false);
          render(false);
          list.scrollTop = list.scrollHeight - keep;
        } catch (e) {
          K.fail(e);
        }
      });
      K.on(list, 'click', 'img.pic', (img) => {
        K.sheet({ title: null, html: `<img src="${esc(img.src)}" alt="" style="width:100%;max-height:80vh;object-fit:contain">` });
      });

      async function send(text, file) {
        const fd = new FormData();
        fd.append('text', text);
        if (file) fd.append('image', file);
        const btn = $('.send-btn', v);
        btn.disabled = true;
        try {
          const r = await K.api(`/chats/${id}/messages`, { method: 'POST', form: fd });
          msgs.set(r.message.id, r.message);
          render(true);
          input.value = '';
          input.style.height = '';
        } catch (e) {
          K.fail(e);
        }
        btn.disabled = false;
      }

      $('#cf', v).addEventListener('submit', (e) => {
        e.preventDefault();
        const t = input.value.trim();
        if (t) send(t, null);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(hover: hover)').matches) {
          e.preventDefault();
          $('#cf', v).requestSubmit();
        }
      });
      input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(120, input.scrollHeight) + 'px';
      });
      fileIn.addEventListener('change', () => {
        const f = fileIn.files[0];
        fileIn.value = '';
        if (!f) return;
        if (f.size > K.config.maxImageMB * 1048576) return K.toast(`Görsel en fazla ${K.config.maxImageMB} MB olabilir`, 'error');
        send(input.value.trim(), f);
      });

      // ---- seçenekler
      function groupInfo() {
        const members = chat.members;
        const html = `<div class="page col" style="padding-bottom:0">
            ${chat.iAmAdmin ? `<div class="row"><input class="input" id="gi-name" value="${esc(chat.name)}" maxlength="40"><button class="btn sm" id="gi-rename">Kaydet</button></div>
            <div class="row"><input class="input" id="gi-add" placeholder="Kullanıcı adı ekle" maxlength="30"><button class="btn sm" id="gi-addbtn">Ekle</button></div>` : ''}</div>
          <div class="section-title">${members.length} üye</div>
          ${members.map((m) => `<div class="list-item"><a class="row grow" href="#/u/${esc(m.username)}" style="min-width:0">${K.avatar(m)}<span class="grow"><span class="title ellipsis" style="display:block">${K.nameHTML(m)}</span><span class="sub">@${esc(m.username)}${m.role === 'owner' ? ' · Kurucu' : m.role === 'admin' ? ' · Yönetici' : ''}</span></span></a>
            ${chat.iAmOwner && m.role === 'member' ? `<button class="btn sm" data-mk="${esc(m.id)}">Yönetici yap</button>` : ''}
            ${chat.iAmOwner && m.role === 'admin' ? `<button class="btn sm" data-rm="${esc(m.id)}">Yetkiyi al</button>` : ''}
            ${chat.iAmAdmin && m.id !== K.me.id && m.role !== 'owner' && !(m.role === 'admin' && !chat.iAmOwner) ? `<button class="btn sm danger" data-kick="${esc(m.id)}">At</button>` : ''}</div>`).join('')}
          <div class="page"><button class="btn danger block" id="gi-leave">Gruptan ayrıl</button></div>`;
        K.sheet({
          title: chat.name,
          tall: true,
          html,
          onMount: (api) => {
            const done = async (fn, msg) => {
              try {
                await fn();
                api.close();
                if (msg) K.toast(msg, 'ok');
                const fresh = await K.api(`/chats/${id}`);
                chat = fresh.chat;
                $('.topbar b', v).textContent = chat.name;
                poll(true);
              } catch (e) {
                K.fail(e);
              }
            };
            const rn = $('#gi-rename', api.el);
            if (rn) rn.onclick = () => done(() => K.api(`/chats/${id}`, { method: 'PATCH', body: { name: $('#gi-name', api.el).value } }), 'Ad güncellendi');
            const ad = $('#gi-addbtn', api.el);
            if (ad) ad.onclick = () => done(() => K.api(`/chats/${id}/members`, { method: 'POST', body: { username: $('#gi-add', api.el).value } }), 'Üye eklendi');
            K.on(api.el, 'click', '[data-kick]', (b) => done(() => K.api(`/chats/${id}/kick`, { method: 'POST', body: { userId: b.dataset.kick } }), 'Üye çıkarıldı'));
            K.on(api.el, 'click', '[data-mk]', (b) => done(() => K.api(`/chats/${id}/admin`, { method: 'POST', body: { userId: b.dataset.mk, make: true } }), 'Yönetici yapıldı'));
            K.on(api.el, 'click', '[data-rm]', (b) => done(() => K.api(`/chats/${id}/admin`, { method: 'POST', body: { userId: b.dataset.rm, make: false } }), 'Yetki alındı'));
            $('#gi-leave', api.el).onclick = async () => {
              if (!(await K.confirm({ title: 'Gruptan ayrılınsın mı?', ok: 'Ayrıl', danger: true }))) return;
              try {
                await K.api(`/chats/${id}/leave`, { method: 'POST' });
                api.close();
                K.go('/inbox?tab=messages');
              } catch (e) {
                K.fail(e);
              }
            };
          },
        });
      }
      K.on(v, 'click', '[data-info]', groupInfo);
      K.on(v, 'click', '[data-menu]', () => {
        const items = [];
        if (chat.type === 'group') items.push({ icon: 'users', label: 'Grup bilgisi', run: groupInfo });
        items.push({
          icon: 'trash',
          label: 'Sohbeti temizle (yalnızca benim için)',
          run: async () => {
            if (!(await K.confirm({ title: 'Sohbet temizlensin mi?', text: 'Mesajlar yalnızca senin ekranından silinir.', ok: 'Temizle', danger: true }))) return;
            try {
              await K.api(`/chats/${id}/clear`, { method: 'POST' });
              msgs.clear();
              hasMore = false;
              render(true);
            } catch (e) {
              K.fail(e);
            }
          },
        });
        if (chat.type === 'dm' && chat.user) {
          items.push({ icon: 'ban', label: 'Engelle', danger: true, run: () => K.blockUser(chat.user, () => K.go('/inbox?tab=messages')) });
          items.push({ icon: 'flag', label: 'Şikayet et', danger: true, run: () => K.report('user', chat.user.id, `@${chat.user.username} kullanıcısını neden şikayet ediyorsun?`) });
        }
        K.menu('Sohbet', items);
      });

      await poll(true);
      timer = setInterval(() => poll(false), 3500);
      return () => clearInterval(timer);
    },
    { hideNav: true, nav: 'inbox' }
  );

  /* ---------------- Takip istekleri ---------------- */
  K.route(
    '/requests',
    async (ctx) => {
      const v = ctx.view;
      v.innerHTML = `<div class="topbar"><button class="icon-btn" data-back>${icon('back')}</button><h1>Takip istekleri</h1><span class="spacer"></span></div><div id="rq">${K.spinner()}</div>`;
      K.on(v, 'click', '[data-back]', () => K.back('/inbox'));
      const box = $('#rq', v);
      async function load() {
        const d = await K.api('/me/follow-requests');
        if (!ctx.alive()) return;
        box.innerHTML = d.requests.length
          ? d.requests.map((r) => `<div class="list-item" data-uid="${esc(r.user.id)}"><a class="row grow" href="#/u/${esc(r.user.username)}">${K.avatar(r.user)}<span class="grow"><span class="title">${K.nameHTML(r.user)}</span><span class="sub" style="display:block">@${esc(r.user.username)} · ${K.timeAgo(r.createdAt)}</span></span></a>
              <button class="btn primary sm" data-accept>Kabul</button><button class="btn sm" data-decline>Sil</button></div>`).join('')
          : K.empty('user-plus', 'Bekleyen istek yok');
      }
      const act = (kind) => async (b) => {
        const row = b.closest('[data-uid]');
        try {
          await K.api(`/me/follow-requests/${row.dataset.uid}/${kind}`, { method: 'POST' });
          row.remove();
          if (!$('[data-uid]', box)) load();
          K.refreshCounters();
        } catch (e) {
          K.fail(e);
        }
      };
      K.on(v, 'click', '[data-accept]', act('accept'));
      K.on(v, 'click', '[data-decline]', act('decline'));
      await load();
    },
    { nav: 'inbox' }
  );
})();
