/* Klipo ortak bileşenler: ızgara, kullanıcı satırı, takip, hikaye, yorum, paylaşım, şikayet, video menüsü */
(function () {
  'use strict';
  const K = window.K;
  const { esc, icon, $, $$ } = K;

  /* ---------------- ızgara karosu ---------------- */
  K.tile = (v, opts) => {
    opts = opts || {};
    const media = v.posterUrl
      ? `<img src="${esc(v.posterUrl)}" alt="" loading="lazy">`
      : `<video src="${esc(v.mediaUrl)}#t=0.1" preload="metadata" muted playsinline></video>`;
    const lock = v.visibility === 'private' ? `<span class="lock">${icon('lock')}</span>` : v.visibility === 'followers' ? `<span class="lock">${icon('users')}</span>` : '';
    return `<a class="tile" href="#/v/${esc(v.id)}" data-id="${esc(v.id)}">${media}
      ${v.profilePinned ? '<span class="pin">Sabit</span>' : ''}${lock}
      <span class="meta">${icon('play')}${K.count(v.views)}</span></a>`;
  };

  /* ---------------- takip ---------------- */
  K.followLabel = (s) => (s.following ? 'Takip ediliyor' : s.requested ? 'İstek gönderildi' : s.followsMe ? 'Sen de takip et' : 'Takip et');
  K.followClass = (s) => (s.following || s.requested ? 'btn' : 'btn primary');

  K.userRow = (u, o) => {
    o = o || {};
    const btn = o.follow && !u.isMe && (!K.me || u.id !== K.me.id)
      ? `<button class="${K.followClass(u)} sm" data-follow="${esc(u.id)}">${K.followLabel(u)}</button>`
      : '';
    return `<div class="list-item" data-uid="${esc(u.id)}">
      <a class="row grow" href="#/u/${esc(u.username)}" style="min-width:0">${K.avatar(u)}
        <span class="grow"><span class="title ellipsis" style="display:block">${K.nameHTML(u)}</span>
        <span class="sub ellipsis" style="display:block">@${esc(u.username)}${u.bio ? ' · ' + esc(u.bio) : ''}</span></span></a>${btn}</div>`;
  };

  // Liste içindeki [data-follow] düğmelerini bağlar
  K.bindFollow = (root, onChange) =>
    K.on(root, 'click', '[data-follow]', async (b) => {
      b.disabled = true;
      try {
        const r = await K.api(`/users/${b.dataset.follow}/follow`, { method: 'POST' });
        b.className = K.followClass(r) + ' sm';
        b.textContent = K.followLabel(r);
        if (r.requested) K.toast('Takip isteği gönderildi');
        if (onChange) onChange(r, b);
      } catch (e) {
        K.fail(e);
      }
      b.disabled = false;
    });

  /* ---------------- hikayeler ---------------- */
  K.storiesTray = async function (box) {
    let data;
    try {
      data = await K.api('/stories');
    } catch (e) {
      box.innerHTML = '';
      return;
    }
    const mine = data.mine;
    const all = (mine ? [mine] : []).concat(data.groups);
    box._st = { mine, all }; // olaylar her zaman en güncel veriyi kullanır
    const chip = (g, i) =>
      `<button class="story-chip" data-i="${i}"><span class="story-ring ${g.allSeen ? 'seen' : ''}">${K.avatar(g.user)}</span><span class="nm ellipsis">${esc(g.user.nickname)}</span></button>`;
    box.innerHTML = `<div class="stories">
      <button class="story-chip" data-add>${mine ? `<span class="story-ring ${mine.allSeen ? 'seen' : ''}">${K.avatar(K.me)}</span>` : `<span style="position:relative">${K.avatar(K.me)}<i class="add">${icon('plus')}</i></span>`}
        <span class="nm ellipsis">Hikayen</span></button>
      ${data.groups.map((g, i) => chip(g, (mine ? 1 : 0) + i)).join('')}</div>
      <input type="file" accept="image/*,video/*" class="hidden" data-file>`;
    if (box._bound) return;
    box._bound = true;
    const refresh = () => K.storiesTray(box);
    box.addEventListener('change', (e) => {
      if (!e.target.matches('[data-file]')) return;
      const f = e.target.files[0];
      e.target.value = '';
      if (f) K.uploadStory(f, refresh);
    });
    K.on(box, 'click', '[data-add]', () => {
      const pick = () => $('[data-file]', box).click();
      if (box._st.mine) {
        K.menu('Hikayen', [
          { icon: 'play', label: 'Hikayeni izle', run: () => K.openStories(box._st.all, 0, refresh) },
          { icon: 'camera', label: 'Yeni hikaye ekle', run: pick },
        ]);
      } else pick();
    });
    K.on(box, 'click', '.story-chip[data-i]', (c) => K.openStories(box._st.all, Number(c.dataset.i), refresh));
  };

  K.uploadStory = async (file, done) => {
    const isVideo = file.type.startsWith('video/');
    if (isVideo && file.size > K.config.maxVideoMB * 1048576) return K.toast(`Dosya en fazla ${K.config.maxVideoMB} MB olabilir`, 'error');
    if (!isVideo && file.size > K.config.maxVideoMB * 1048576) return K.toast('Dosya çok büyük', 'error');
    const fd = new FormData();
    fd.append('media', file);
    const caption = await K.ask({ title: 'Hikaye yazısı', text: 'İstersen kısa bir yazı ekle (boş bırakabilirsin).', max: 120, ok: 'Paylaş' });
    if (caption === null) return;
    fd.append('caption', caption);
    K.toast('Hikaye yükleniyor…');
    try {
      await K.api('/stories', { method: 'POST', form: fd, onProgress: () => {} });
      K.toast('Hikayen paylaşıldı 24 saat görünür', 'ok');
      if (done) done();
    } catch (e) {
      K.fail(e);
    }
  };

  K.openStories = function (groups, start, onClose) {
    let gi = start;
    let si = 0;
    let timer = null;
    let paused = false;
    let elapsed = 0;
    let last = 0;
    let duration = 5000;
    let vid = null;
    let busy = false;

    const el = document.createElement('div');
    el.className = 'story-viewer';
    const handle = K.overlay(el, () => {
      cancelAnimationFrame(timer);
      if (vid) vid.pause();
      if (onClose) onClose();
    });

    const group = () => groups[gi];
    const story = () => group().stories[si];

    function firstUnseen(g) {
      const i = g.stories.findIndex((s) => !s.seen);
      return i < 0 ? 0 : i;
    }

    function show() {
      cancelAnimationFrame(timer);
      const g = group();
      const s = story();
      vid = null;
      elapsed = 0;
      last = performance.now();
      const isMine = g.user.id === K.me.id;
      el.innerHTML = `<div class="media"></div><div class="shade"></div>
        <div class="bars">${g.stories.map((_, i) => `<i class="${i < si ? 'done' : ''}"><b></b></i>`).join('')}</div>
        <div class="head"><a class="row" href="#/u/${esc(g.user.username)}" style="gap:8px">${K.avatar(g.user, 'sm')}<b>${esc(g.user.nickname)}</b><span style="opacity:.75;font-size:13px">${K.timeAgo(s.createdAt)}</span></a>
          <span class="grow"></span>${isMine ? `<button class="icon-btn" data-del aria-label="Sil">${icon('trash')}</button>` : ''}<button class="icon-btn" data-x aria-label="Kapat">${icon('x')}</button></div>
        <div class="zones"><div data-prev></div><div data-next></div></div>
        ${s.caption ? `<div class="caption">${esc(s.caption)}</div>` : ''}
        <div class="foot">${
          isMine
            ? `<button class="btn" data-viewers style="background:rgba(255,255,255,.18);color:#fff">${icon('eye', 'sm')} ${s.views || 0} görüntüleme</button>`
            : `<input class="input" data-reply placeholder="${esc(g.user.nickname)} kişisine yanıt yaz…" maxlength="500"><button class="send-btn" data-send aria-label="Gönder">${icon('send')}</button>`
        }</div>`;
      const media = $('.media', el);
      if (s.mediaType === 'video') {
        vid = document.createElement('video');
        vid.src = s.mediaUrl;
        vid.playsInline = true;
        vid.autoplay = true;
        vid.muted = K.muted;
        vid.onloadedmetadata = () => (duration = Math.max(2000, Math.min(60000, (vid.duration || 5) * 1000)));
        vid.onended = () => next();
        media.appendChild(vid);
        vid.play().catch(() => {
          vid.muted = true;
          vid.play().catch(() => {});
        });
        duration = 15000;
      } else {
        duration = 5000;
        const img = new Image();
        img.src = s.mediaUrl;
        img.alt = '';
        media.appendChild(img);
      }
      if (!isMine) K.api(`/stories/${s.id}/view`, { method: 'POST' }).catch(() => {});
      s.seen = true;
      tick();
    }

    function tick() {
      const now = performance.now();
      if (!paused) elapsed += now - last;
      last = now;
      const bar = $$('.bars i b', el)[si];
      if (bar) bar.style.width = Math.min(100, (elapsed / duration) * 100) + '%';
      if (vid && !paused && vid.duration) {
        // video süresine göre ilerle
        elapsed = vid.currentTime * 1000;
        duration = vid.duration * 1000;
      }
      if (elapsed >= duration && !vid) return next();
      timer = requestAnimationFrame(tick);
    }

    function setPaused(p) {
      paused = p;
      if (vid) (p ? vid.pause() : vid.play().catch(() => {}));
    }

    function next() {
      if (si < group().stories.length - 1) {
        si++;
        show();
      } else if (gi < groups.length - 1) {
        gi++;
        si = firstUnseen(group());
        show();
      } else handle.close();
    }
    function prev() {
      if (si > 0) {
        si--;
        show();
      } else if (gi > 0) {
        gi--;
        si = 0;
        show();
      } else show();
    }

    // dokunma: kısa = ileri/geri, basılı tutma = duraklat
    let downAt = 0;
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.foot, .head button, .head a')) return;
      downAt = Date.now();
      setTimeout(() => {
        if (downAt && Date.now() - downAt >= 200) setPaused(true);
      }, 210);
    });
    const release = (e) => {
      if (!downAt) return;
      const long = Date.now() - downAt >= 200;
      downAt = 0;
      setPaused(false);
      if (long || e.target.closest('.foot, .head button, .head a')) return;
      if (e.target.closest('[data-prev]')) prev();
      else if (e.target.closest('[data-next]')) next();
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', () => {
      downAt = 0;
      setPaused(false);
    });

    K.on(el, 'click', '[data-x]', () => handle.close());
    K.on(el, 'click', '[data-del]', async () => {
      setPaused(true);
      if (!(await K.confirm({ title: 'Hikaye silinsin mi?', ok: 'Sil', danger: true }))) return setPaused(false);
      try {
        await K.api(`/stories/${story().id}`, { method: 'DELETE' });
        group().stories.splice(si, 1);
        K.toast('Hikaye silindi');
        if (!group().stories.length) {
          groups.splice(gi, 1);
          if (!groups.length) return handle.close();
          gi = Math.min(gi, groups.length - 1);
          si = 0;
        } else si = Math.min(si, group().stories.length - 1);
        show();
      } catch (e) {
        K.fail(e);
        setPaused(false);
      }
    });
    K.on(el, 'click', '[data-viewers]', async () => {
      setPaused(true);
      try {
        const d = await K.api(`/stories/${story().id}/viewers`);
        const html = d.viewers.length
          ? d.viewers.map((v) => `<a class="list-item" href="#/u/${esc(v.user.username)}">${K.avatar(v.user)}<span class="grow"><span class="title">${K.nameHTML(v.user)}</span><span class="sub" style="display:block">${K.timeAgo(v.at)}</span></span></a>`).join('')
          : K.empty('eye', 'Henüz görüntüleyen yok');
        K.sheet({ title: 'Görüntüleyenler', html, onClose: () => setPaused(false) });
      } catch (e) {
        K.fail(e);
        setPaused(false);
      }
    });
    const input = () => $('[data-reply]', el);
    el.addEventListener('focusin', (e) => e.target.matches('[data-reply]') && setPaused(true));
    el.addEventListener('focusout', (e) => e.target.matches('[data-reply]') && setPaused(false));
    async function sendReply() {
      const inp = input();
      if (!inp || busy) return;
      const text = inp.value.trim();
      if (!text) return;
      busy = true;
      try {
        await K.api(`/stories/${story().id}/reply`, { method: 'POST', body: { text } });
        inp.value = '';
        inp.blur();
        K.toast('Yanıtın gönderildi', 'ok');
      } catch (e) {
        K.fail(e);
      }
      busy = false;
    }
    K.on(el, 'click', '[data-send]', sendReply);
    el.addEventListener('keydown', (e) => e.key === 'Enter' && e.target.matches('[data-reply]') && sendReply());

    si = firstUnseen(group());
    show();
  };

  /* ---------------- paylaşım ---------------- */
  K.videoLink = (id) => `${location.origin}/#/v/${id}`;

  K.shareVideo = function (video, onShared) {
    const url = K.videoLink(video.id);
    const count = () =>
      K.api(`/videos/${video.id}/share`, { method: 'POST' })
        .then((r) => onShared && onShared(r.shares))
        .catch(() => {});
    K.menu('Paylaş', [
      { icon: 'link', label: 'Bağlantıyı kopyala', run: async () => ((await K.copy(url)) ? K.toast('Bağlantı kopyalandı', 'ok') : K.toast('Kopyalanamadı', 'error'), count()) },
      navigator.share && {
        icon: 'share',
        label: 'Diğer uygulamalarla paylaş…',
        run: () =>
          navigator
            .share({ title: 'Klipo', text: video.caption || `@${video.user.username} videosu`, url })
            .then(count)
            .catch(() => {}),
      },
      { icon: 'send', label: 'Klipo’da mesaj olarak gönder', run: () => K.sendVideoInChat(video) },
    ]);
  };

  K.sendVideoInChat = async (video) => {
    let list = [];
    try {
      list = (await K.api('/chats')).chats;
    } catch (e) {
      return K.fail(e);
    }
    if (!list.length) return K.toast('Önce bir sohbet başlat', 'error');
    const s = K.sheet({
      title: 'Kime gönderilsin?',
      html: list.map((c) => `<button class="list-item" data-chat="${esc(c.id)}">${c.user ? K.avatar(c.user) : `<span class="avatar">${esc(c.name.charAt(0))}</span>`}<span class="grow"><span class="title">${esc(c.name)}</span></span></button>`).join(''),
      onMount: (api) =>
        K.on(api.el, 'click', '[data-chat]', async (b) => {
          try {
            await K.api(`/chats/${b.dataset.chat}/messages`, { method: 'POST', body: { text: K.videoLink(video.id) } });
            api.close();
            K.toast('Gönderildi', 'ok');
            K.api(`/videos/${video.id}/share`, { method: 'POST' }).catch(() => {});
          } catch (e) {
            K.fail(e);
          }
        }),
    });
    return s;
  };

  /* ---------------- şikayet ---------------- */
  K.report = function (type, targetId, label) {
    const reasons = K.config.reportReasons || [];
    K.sheet({
      title: 'Şikayet et',
      html: `<div class="page col">
        <p class="muted">${esc(label || '')}</p>
        <div class="col" style="gap:4px">${reasons.map((r, i) => `<label class="menu-item" style="padding:10px 0"><input type="radio" name="reason" value="${esc(r)}" ${i === 0 ? 'checked' : ''}><span>${esc(r)}</span></label>`).join('')}</div>
        <label class="field"><span>Açıklama (isteğe bağlı)</span><textarea class="input" id="rp-desc" maxlength="500" placeholder="Ne olduğunu kısaca anlat"></textarea></label>
        <label class="field"><span>Kanıt görseli (isteğe bağlı)</span><input type="file" id="rp-file" accept="image/*"></label>
        <button class="btn danger block" id="rp-send">Şikayeti gönder</button></div>`,
      onMount: (api) => {
        $('#rp-send', api.el).onclick = async (ev) => {
          const b = ev.currentTarget;
          const reason = ($('input[name=reason]:checked', api.el) || {}).value;
          const fd = new FormData();
          fd.append('type', type);
          fd.append('targetId', targetId);
          fd.append('reason', reason);
          fd.append('description', $('#rp-desc', api.el).value);
          const f = $('#rp-file', api.el).files[0];
          if (f) fd.append('evidence', f);
          b.disabled = true;
          try {
            await K.api('/reports', { method: 'POST', form: fd });
            api.close();
            K.toast('Şikayetin alındı. Teşekkürler!', 'ok');
          } catch (e) {
            K.fail(e);
            b.disabled = false;
          }
        };
      },
    });
  };

  /* ---------------- yorumlar ---------------- */
  K.openComments = function (video, onCount) {
    let total = video.comments || 0;
    let page = 0;
    let hasMore = true;
    let loading = false;
    let replyTo = null;

    const commentHTML = (c, rootId) => `
      <div class="comment" data-id="${esc(c.id)}" data-root="${esc(rootId || '')}" data-user="${esc(c.user.username)}">
        <a href="#/u/${esc(c.user.username)}">${K.avatar(c.user, 'sm')}</a>
        <div class="body">
          <div class="name"><a href="#/u/${esc(c.user.username)}">${K.nameHTML(c.user)}</a>${c.user.id === video.user.id ? '<span class="tag-pill">Yazar</span>' : ''}${c.pinned ? `<span class="pinned-tag">${icon('pin', 'sm')} Sabitlendi</span>` : ''}</div>
          <div class="text">${K.linkify(c.text)}</div>
          <div class="meta"><span>${K.timeAgo(c.createdAt)}</span>
            ${video.allowComments || video.mine ? '<button data-act="reply">Yanıtla</button>' : ''}
            ${c.canPin ? `<button data-act="pin">${c.pinned ? 'Sabiti kaldır' : 'Sabitle'}</button>` : ''}
            ${c.canDelete ? '<button data-act="del">Sil</button>' : ''}
            ${!c.mine ? '<button data-act="report">Bildir</button>' : ''}</div>
          ${!c.parentId && c.replyCount ? `<button class="meta" data-act="replies" data-n="${c.replyCount}" style="margin-top:6px">— ${c.replyCount} yanıtı gör</button>` : ''}
          ${!c.parentId ? '<div class="replies hidden"></div>' : ''}
        </div>
        <button class="like ${c.liked ? 'liked' : ''}" data-act="like" aria-label="Beğen">${icon('heart')}<span>${c.likes || ''}</span></button>
      </div>`;

    const canWrite = video.allowComments || video.mine;
    const s = K.sheet({
      title: '',
      tall: true,
      html: '<div class="clist"></div><div class="more"></div>',
      foot: canWrite
        ? `<div class="reply-banner hidden"><span></span><button data-cancel-reply>İptal</button></div>
           <form class="comment-form">${K.avatar(K.me, 'xs')}<input class="input" maxlength="500" placeholder="Yorum ekle…" autocomplete="off"><button class="send-btn" aria-label="Gönder">${icon('send')}</button></form>`
        : '<p class="muted center" style="padding:6px">Bu videoda yorumlar kapalı.</p>',
    });
    const body = s.body;
    const list = $('.clist', body);
    const more = $('.more', body);
    const head = $('.sheet-head span', s.el);
    const setTitle = () => (head.textContent = `${total} yorum`);
    setTitle();

    async function load() {
      if (loading || !hasMore) return;
      loading = true;
      more.innerHTML = K.spinner();
      try {
        const d = await K.api(`/videos/${video.id}/comments?page=${page}`);
        page++;
        hasMore = d.hasMore;
        list.insertAdjacentHTML('beforeend', d.comments.map((c) => commentHTML(c)).join(''));
        if (!list.children.length) list.innerHTML = K.empty('comment', 'Henüz yorum yok', 'İlk yorumu sen yaz!');
        more.innerHTML = hasMore ? '<button class="btn block" data-more style="margin:8px 0">Daha fazla yükle</button>' : '';
      } catch (e) {
        more.innerHTML = '';
        K.fail(e);
      }
      loading = false;
    }
    load();
    K.on(body, 'click', '[data-more]', load);

    const form = $('.comment-form', s.el);
    const input = form && $('input', form);
    const banner = $('.reply-banner', s.el);
    function setReply(r) {
      replyTo = r;
      if (!banner) return;
      banner.classList.toggle('hidden', !r);
      if (r) {
        $('span', banner).textContent = `@${r.username} kişisine yanıt veriyorsun`;
        input.value = `@${r.username} `;
        input.focus();
      }
    }
    if (banner) $('[data-cancel-reply]', banner).onclick = () => setReply(null);

    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        const btn = $('button', form);
        btn.disabled = true;
        try {
          const d = await K.api(`/videos/${video.id}/comments`, { method: 'POST', body: { text, parentId: replyTo ? replyTo.id : undefined } });
          total++;
          setTitle();
          onCount && onCount(total);
          const empty = $('.empty', list);
          if (empty) list.innerHTML = '';
          if (replyTo) {
            const root = $(`.comment[data-id="${replyTo.rootId || replyTo.id}"]`, list);
            const box = $('.replies', root);
            box.classList.remove('hidden');
            box.insertAdjacentHTML('beforeend', commentHTML(d.comment, root.dataset.id));
          } else {
            list.insertAdjacentHTML('afterbegin', commentHTML(d.comment));
            body.scrollTop = 0;
          }
          input.value = '';
          setReply(null);
        } catch (err) {
          K.fail(err);
        }
        btn.disabled = false;
      });
    }

    K.on(body, 'click', '[data-act]', async (b) => {
      const c = b.closest('.comment');
      const id = c.dataset.id;
      const act = b.dataset.act;
      try {
        if (act === 'like') {
          const r = await K.api(`/comments/${id}/like`, { method: 'POST' });
          b.classList.toggle('liked', r.liked);
          $('span', b).textContent = r.likes || '';
        } else if (act === 'reply') {
          if (!input) return;
          setReply({ id, rootId: c.dataset.root || id, username: c.dataset.user });
        } else if (act === 'del') {
          if (!(await K.confirm({ title: 'Yorum silinsin mi?', ok: 'Sil', danger: true }))) return;
          const r = await K.api(`/comments/${id}`, { method: 'DELETE' });
          c.remove();
          total = Math.max(0, total - (r.removed || 1));
          setTitle();
          onCount && onCount(total);
        } else if (act === 'pin') {
          const r = await K.api(`/comments/${id}/pin`, { method: 'POST' });
          K.toast(r.pinned ? 'Yorum sabitlendi' : 'Sabit kaldırıldı');
          page = 0;
          hasMore = true;
          list.innerHTML = '';
          load();
        } else if (act === 'report') {
          K.report('comment', id, 'Bu yorumu neden bildiriyorsun?');
        } else if (act === 'replies') {
          const box = $('.replies', c);
          if (!box.classList.contains('hidden') && box.children.length) {
            box.classList.add('hidden');
            b.textContent = `— ${b.dataset.n} yanıtı gör`;
            return;
          }
          box.classList.remove('hidden');
          box.innerHTML = K.spinner();
          const d = await K.api(`/comments/${id}/replies`);
          box.innerHTML = d.comments.map((r) => commentHTML(r, id)).join('');
          b.textContent = '— Yanıtları gizle';
        }
      } catch (e) {
        K.fail(e);
      }
    });
    return s;
  };

  /* ---------------- video menüsü / düzenleme ---------------- */
  K.editVideo = function (video, onUpdate) {
    const vis = video.visibility;
    K.sheet({
      title: 'Videoyu düzenle',
      html: `<div class="page col">
        <label class="field"><span>Açıklama</span><textarea class="input" id="ev-cap" maxlength="300">${esc(video.caption)}</textarea></label>
        <div class="field"><span>Kimler izleyebilir?</span><div class="seg" id="ev-vis">
          <button data-v="public" class="${vis === 'public' ? 'active' : ''}">Herkes</button>
          <button data-v="followers" class="${vis === 'followers' ? 'active' : ''}">Takipçiler</button>
          <button data-v="private" class="${vis === 'private' ? 'active' : ''}">Yalnızca ben</button></div></div>
        <div class="row"><span class="grow">Yorumlara izin ver</span><button class="switch ${video.allowComments ? 'on' : ''}" id="ev-com" aria-label="Yorumlar"></button></div>
        ${video.duet ? '' : `<div class="row"><span class="grow">Düete izin ver</span><button class="switch ${video.allowDuet !== false ? 'on' : ''}" id="ev-duet" aria-label="Düet"></button></div>`}
        <div class="row"><span class="grow">Başkaları indirebilsin</span><button class="switch ${video.allowDownload !== false ? 'on' : ''}" id="ev-dl" aria-label="İndirme"></button></div>
        <button class="btn primary block" id="ev-save">Kaydet</button></div>`,
      onMount: (api) => {
        let v = vis;
        K.on(api.el, 'click', '#ev-vis button', (b) => {
          v = b.dataset.v;
          $$('#ev-vis button', api.el).forEach((x) => x.classList.toggle('active', x === b));
        });
        $('#ev-com', api.el).onclick = (e) => e.currentTarget.classList.toggle('on');
        const duetSw = $('#ev-duet', api.el);
        if (duetSw) duetSw.onclick = (e) => e.currentTarget.classList.toggle('on');
        $('#ev-dl', api.el).onclick = (e) => e.currentTarget.classList.toggle('on');
        $('#ev-save', api.el).onclick = async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            const r = await K.api(`/videos/${video.id}`, {
              method: 'PATCH',
              body: {
                caption: $('#ev-cap', api.el).value,
                visibility: v,
                allowComments: $('#ev-com', api.el).classList.contains('on'),
                allowDownload: $('#ev-dl', api.el).classList.contains('on'),
                ...(duetSw ? { allowDuet: duetSw.classList.contains('on') } : {}),
              },
            });
            api.close();
            K.toast('Kaydedildi', 'ok');
            onUpdate && onUpdate(r.video);
          } catch (err) {
            K.fail(err);
            btn.disabled = false;
          }
        };
      },
    });
  };

  // ctx: { onUpdate(video), onRemove() }
  K.videoMenu = function (video, ctx) {
    ctx = ctx || {};
    const admin = K.me && K.me.role === 'admin';
    const items = [
      { icon: 'link', label: 'Bağlantıyı kopyala', run: async () => ((await K.copy(K.videoLink(video.id))) ? K.toast('Bağlantı kopyalandı', 'ok') : 0) },
    ];
    if (ctx.onSpeed) {
      items.push({
        icon: 'play',
        label: `Oynatma hızı (${K.speed || 1}x)`,
        run: () => K.menu('Oynatma hızı', [0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => ({
          icon: 'play',
          label: s === 1 ? 'Normal (1x)' : `${s}x`,
          run: () => { ctx.onSpeed(s); K.toast(`Hız ${s}x`); },
        }))),
      });
    }
    if (ctx.onAuto) {
      items.push({ icon: 'refresh', label: `Otomatik kaydır: ${K.auto ? 'açık' : 'kapalı'}`, run: () => ctx.onAuto() });
    }
    // düet: herkese açık, kendi videosu olmayan, düete izin veren ve kendisi düet olmayan videolar
    if (!video.mine && video.visibility === 'public' && video.allowDuet !== false && !video.duet) {
      items.push({ icon: 'users', label: 'Düet yap', run: () => K.go('/upload?duet=' + video.id) });
    }
    if (video.mine || video.allowDownload !== false) {
      items.push({
        icon: 'download',
        label: 'Videoyu indir',
        run: () => {
          const a = document.createElement('a');
          a.href = video.mediaUrl;
          a.download = 'klipo-' + video.id + '.mp4';
          document.body.appendChild(a);
          a.click();
          a.remove();
          K.toast('İndiriliyor · yazı, müzik ve filtre dosyaya işlenmez', 'ok');
        },
      });
    }
    if (video.mine) {
      items.push(
        { icon: 'edit', label: 'Düzenle', run: () => K.editVideo(video, ctx.onUpdate) },
        {
          icon: 'pin',
          label: video.profilePinned ? 'Profildeki sabiti kaldır' : 'Profilimde sabitle',
          run: async () => {
            try {
              const r = await K.api(`/videos/${video.id}/pin`, { method: 'POST' });
              video.profilePinned = r.pinned;
              K.toast(r.pinned ? 'Profilinde sabitlendi' : 'Sabit kaldırıldı', 'ok');
              ctx.onUpdate && ctx.onUpdate(video);
            } catch (e) {
              K.fail(e);
            }
          },
        }
      );
    } else {
      if (ctx.onHide) {
        items.push({
          icon: 'eye-off',
          label: 'İlgilenmiyorum',
          run: async () => {
            try {
              await K.api(`/videos/${video.id}/hide`, { method: 'POST' });
              K.toast('Bunun gibi videoları daha az göstereceğiz', 'ok');
              ctx.onHide();
            } catch (e) {
              K.fail(e);
            }
          },
        });
      }
      items.push({ icon: 'flag', label: 'Şikayet et', run: () => K.report('video', video.id, 'Bu videoyu neden şikayet ediyorsun?') });
      items.push({ icon: 'ban', label: `@${video.user.username} kişisini engelle`, danger: true, run: () => K.blockUser(video.user, ctx.onRemove) });
    }
    if (admin && !video.mine) {
      items.push(
        {
          icon: 'star',
          label: video.featured ? 'Öne çıkarmayı kaldır' : 'Öne çıkar (yönetici)',
          run: async () => {
            try {
              const r = await K.api(`/admin/videos/${video.id}/feature`, { method: 'POST' });
              video.featured = r.featured;
              K.toast(r.featured ? 'Öne çıkarıldı' : 'Kaldırıldı', 'ok');
            } catch (e) {
              K.fail(e);
            }
          },
        },
        {
          icon: 'eye-off',
          label: video.sensitive ? 'Hassas işaretini kaldır' : 'Hassas içerik işaretle (yönetici)',
          run: async () => {
            try {
              const r = await K.api(`/admin/videos/${video.id}/sensitive`, { method: 'POST' });
              video.sensitive = r.sensitive;
              K.toast(r.sensitive ? 'Hassas olarak işaretlendi' : 'İşaret kaldırıldı', 'ok');
            } catch (e) {
              K.fail(e);
            }
          },
        }
      );
    }
    if (video.mine || admin) {
      items.push({
        icon: 'trash',
        label: video.mine ? 'Sil' : 'Sil (yönetici)',
        danger: true,
        run: async () => {
          if (!(await K.confirm({ title: 'Video silinsin mi?', text: 'Bu işlem geri alınamaz.', ok: 'Sil', danger: true }))) return;
          try {
            await K.api(`/videos/${video.id}`, { method: 'DELETE' });
            K.toast('Video silindi', 'ok');
            ctx.onRemove && ctx.onRemove();
          } catch (e) {
            K.fail(e);
          }
        },
      });
    }
    K.menu('Video', items);
  };

  K.blockUser = async (user, done) => {
    if (!(await K.confirm({ title: `@${user.username} engellensin mi?`, text: 'Birbirinizin içeriklerini göremez, mesajlaşamazsınız. Takip ilişkisi kaldırılır.', ok: 'Engelle', danger: true }))) return;
    try {
      const r = await K.api(`/users/${user.id}/block`, { method: 'POST' });
      K.toast(r.blocked ? 'Kullanıcı engellendi' : 'Engel kaldırıldı', 'ok');
      done && done(r);
    } catch (e) {
      K.fail(e);
    }
  };
})();
