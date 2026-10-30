/* Klipo akış: dikey video oynatıcı, ana sayfa ve tek video sayfası */
(function () {
  'use strict';
  const K = window.K;
  const { esc, icon, $, $$ } = K;

  K.muted = K.store.get('muted', '0') === '1';
  K.speed = Number(K.store.get('speed', '1')) || 1;
  K.auto = K.store.get('auto', '0') === '1';

  const VIS_LABEL = { followers: ['users', 'Yalnızca takipçiler'], private: ['lock', 'Yalnızca ben'] };

  function reelHTML(v, i) {
    const vis = VIS_LABEL[v.visibility];
    const fcss = v.filter ? K.fx.filterCss(v.filter) : '';
    return `<section class="reel${v.duet ? ' duet' : ''}" data-id="${esc(v.id)}" data-i="${i}">
      <video playsinline loop webkit-playsinline preload="none" ${v.posterUrl ? `poster="${esc(v.posterUrl)}"` : ''} ${K.muted ? 'muted' : ''}${fcss ? ` style="filter:${fcss}"` : ''}></video>
      ${v.duet ? `<video class="duet-orig" playsinline loop webkit-playsinline preload="none" ${v.duet.posterUrl ? `poster="${esc(v.duet.posterUrl)}"` : ''} ${K.muted ? 'muted' : ''}></video>` : ''}
      ${K.fx.layerHTML(v.overlays)}
      <div class="shade"></div><div class="tap" data-tap></div>
      <div class="pause-ind">${icon('play')}</div>
      <button class="sound-hint" data-act="sound">${icon('mute', 'sm')} Sesi açmak için dokun</button>
      <div class="info">
        ${vis && v.mine ? `<span class="vis-tag">${icon(vis[0], 'sm')} ${vis[1]}</span>` : ''}
        <a class="who" href="#/u/${esc(v.user.username)}">@${esc(v.user.username)}${v.user.verified ? K.verifiedBadge() : ''}<span style="font-weight:400;opacity:.8;font-size:13px">· ${K.timeAgo(v.createdAt)}</span></a>
        ${v.duet ? `<a class="duet-tag" href="#/u/${esc(v.duet.user.username)}">${icon('video', 'sm')} Düet · @${esc(v.duet.user.username)}</a>` : ''}
        ${v.caption ? `<div class="cap" data-act="cap">${K.linkify(v.caption)}</div>` : ''}
        ${v.sound && v.sound.id ? `<a class="song" href="#/sound/${esc(v.sound.id)}">${icon('music', 'sm')}<span>${esc(v.song)}</span></a>` : `<div class="song">${icon('music', 'sm')}<span>${esc(v.song)}</span></div>`}
      </div>
      <div class="rail">
        <div class="face ${v.mine || v.following || v.requested ? 'following' : ''}" data-face>
          <a href="#/u/${esc(v.user.username)}">${K.avatar(v.user)}</a>
          <button class="plus" data-act="follow" aria-label="Takip et">${icon('plus')}</button></div>
        <button class="act ${v.liked ? 'liked' : ''}" data-act="like" aria-label="Beğen">${icon('heart')}<span data-c="likes">${K.count(v.likes)}</span></button>
        <button class="act" data-act="comment" aria-label="Yorumlar">${icon('comment')}<span data-c="comments">${v.allowComments ? K.count(v.comments) : '—'}</span></button>
        <button class="act ${v.saved ? 'saved' : ''}" data-act="save" aria-label="Kaydet">${icon('bookmark')}<span data-c="saves">${K.count(v.saves)}</span></button>
        <button class="act" data-act="share" aria-label="Paylaş">${icon('share')}<span data-c="shares">${K.count(v.shares)}</span></button>
        <button class="act" data-act="more" aria-label="Daha fazla">${icon('more')}</button>
        <div class="disc"><i></i></div>
      </div>
      <div class="bar"><i></i></div>
    </section>`;
  }

  /**
   * opts.load(page) → Promise<{videos, hasMore}>
   * opts.initial   → önceden yüklenmiş ilk videolar (isteğe bağlı)
   * opts.empty     → boş durum HTML'i
   */
  K.createFeed = function (root, opts) {
    const st = { items: [], page: 0, hasMore: true, loading: false, active: -1, viewed: new Set(), dead: false, userPaused: false, sfx: null };
    root.innerHTML = '<div class="feed" tabindex="-1"></div>';
    const feed = root.firstElementChild;
    let io;
    let viewTimer = null;

    const reelEl = (id) => $(`.reel[data-id="${id}"]`, feed);
    const itemOf = (id) => st.items.find((x) => x.id === id);

    function paint(v) {
      const r = reelEl(v.id);
      if (!r) return;
      $('[data-act=like]', r).classList.toggle('liked', !!v.liked);
      $('[data-act=save]', r).classList.toggle('saved', !!v.saved);
      $('[data-c=likes]', r).textContent = K.count(v.likes);
      $('[data-c=comments]', r).textContent = v.allowComments ? K.count(v.comments) : '—';
      $('[data-c=saves]', r).textContent = K.count(v.saves);
      $('[data-c=shares]', r).textContent = K.count(v.shares);
      $('[data-face]', r).classList.toggle('following', !!(v.mine || v.following || v.requested));
    }

    function applyMute() {
      $$('video', feed).forEach((v) => (v.muted = K.muted));
    }

    function setSrc(reel, on) {
      const vid = $('video', reel);
      const v = itemOf(reel.dataset.id);
      if (!v) return;
      const orig = $('.duet-orig', reel);
      if (on && !vid.getAttribute('src')) {
        vid.src = v.mediaUrl;
        vid.preload = 'auto';
        if (orig && v.duet) {
          orig.src = v.duet.mediaUrl;
          orig.preload = 'auto';
        }
      } else if (!on && vid.getAttribute('src')) {
        vid.pause();
        vid.removeAttribute('src');
        vid.load();
        if (orig) {
          orig.pause();
          orig.removeAttribute('src');
          orig.load();
        }
      }
    }

    function activate(index) {
      const reels = $$('.reel', feed);
      reels.forEach((r, i) => {
        const near = Math.abs(i - index) <= 2;
        setSrc(r, near);
        const vid = $('video', r);
        if (i !== index) {
          vid.pause();
          const o = $('.duet-orig', r);
          if (o) o.pause();
          r.classList.remove('playing', 'paused', 'muted-hint');
        }
      });
      const reel = reels[index];
      if (!reel) return;
      st.active = index;
      st.userPaused = false;
      const vid = $('video', reel);
      // önceki videonun müziğini kapat, bu videonunkini aç
      if (st.sfx) {
        st.sfx.destroy();
        st.sfx = null;
      }
      if (st.dsync) {
        st.dsync.destroy();
        st.dsync = null;
      }
      vid.muted = K.muted;
      vid.currentTime = 0;
      vid.playbackRate = K.speed || 1;
      const item = itemOf(reel.dataset.id);
      if (item && item.sound && item.sound.url) st.sfx = K.fx.sound(vid, item.sound);
      const orig = $('.duet-orig', reel);
      if (orig && item && item.duet) st.dsync = K.fx.duetSync(vid, orig);
      // otomatik kaydır: açıkken video tekrar etmez, bitince sıradakine geçilir
      vid.loop = !K.auto;
      vid.onended = () => {
        if (K.auto && st.active === index && !st.dead) goNext();
      };
      const p = vid.play();
      reel.classList.add('playing');
      reel.classList.remove('paused');
      if (p && p.catch) {
        p.catch(() => {
          // tarayıcı sesli otomatik oynatmayı engelledi → sessiz başlat
          vid.muted = true;
          K.muted = true;
          reel.classList.add('muted-hint');
          vid.play().catch(() => {});
        });
      }
      // izlenme: 1.5 sn oynayınca bir kez say
      clearTimeout(viewTimer);
      const id = reel.dataset.id;
      if (!st.viewed.has(id)) {
        viewTimer = setTimeout(() => {
          st.viewed.add(id);
          K.api(`/videos/${id}/view`, { method: 'POST' }).catch(() => {});
        }, 1500);
      }
      if (index >= st.items.length - 3) loadMore();
    }

    function observe() {
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting && e.intersectionRatio >= 0.7) {
              const i = Number(e.target.dataset.i);
              if (i !== st.active) activate(i);
            }
          }
        },
        { root: feed, threshold: [0.7] }
      );
      $$('.reel', feed).forEach((r) => io.observe(r));
    }

    function append(videos) {
      const known = new Set(st.items.map((x) => x.id));
      const fresh = videos.filter((v) => !known.has(v.id));
      if (!fresh.length) return;
      const start = st.items.length;
      st.items.push(...fresh);
      const endEl = $('.feed-end', feed);
      if (endEl) endEl.remove();
      const placeholder = $('.feed-empty', feed);
      if (placeholder) placeholder.remove();
      feed.insertAdjacentHTML('beforeend', fresh.map((v, i) => reelHTML(v, start + i)).join(''));
      $$('.reel', feed)
        .slice(start)
        .forEach((r) => io && io.observe(r));
    }

    function showEnd() {
      if (!st.items.length || $('.feed-end', feed)) return;
      feed.insertAdjacentHTML(
        'beforeend',
        `<div class="feed-end"><div class="col" style="align-items:center">${icon('check', 'lg')}<b style="font-size:18px">Hepsi bu kadar!</b><span>Yeni videolar için Keşfet'e göz at.</span><a class="btn primary" href="#/discover">Keşfet</a></div></div>`
      );
    }

    async function loadMore() {
      if (st.loading || !st.hasMore || st.dead) return;
      st.loading = true;
      try {
        const d = await opts.load(st.page);
        if (st.dead) return;
        st.page++;
        st.hasMore = d.hasMore;
        append(d.videos);
        if (!st.hasMore) showEnd();
        if (!st.items.length) feed.innerHTML = `<div class="feed-empty">${opts.empty || K.empty('video', 'Henüz video yok')}</div>`;
      } catch (e) {
        if (!st.dead) K.fail(e);
      }
      st.loading = false;
      if (!st.dead && st.items.length && st.active < 0) {
        const first = $('.reel', feed);
        if (first) activate(0);
      }
    }

    /* ---- etkileşimler ---- */
    async function toggleLike(v, onlyAdd) {
      if (onlyAdd && v.liked) return;
      const prev = { liked: v.liked, likes: v.likes };
      v.liked = !v.liked;
      v.likes = Math.max(0, v.likes + (v.liked ? 1 : -1));
      paint(v);
      try {
        const r = await K.api(`/videos/${v.id}/like`, { method: 'POST' });
        v.liked = r.liked;
        v.likes = r.likes;
      } catch (e) {
        Object.assign(v, prev);
        K.fail(e);
      }
      paint(v);
    }

    function burst(reel, x, y) {
      const b = document.createElement('div');
      b.className = 'heart-burst';
      b.style.left = x + 'px';
      b.style.top = y + 'px';
      b.innerHTML = icon('heart');
      reel.appendChild(b);
      setTimeout(() => b.remove(), 850);
    }

    function togglePause(reel) {
      const vid = $('video', reel);
      if (vid.paused) {
        vid.play().catch(() => {});
        reel.classList.remove('paused');
        reel.classList.add('playing');
        st.userPaused = false;
      } else {
        vid.pause();
        reel.classList.add('paused');
        reel.classList.remove('playing');
        st.userPaused = true;
      }
    }

    let lastTap = 0;
    let tapTimer = null;
    K.on(feed, 'click', '[data-tap]', (el, ev) => {
      if (Date.now() - suppressTap < 700) return; // basılı tutma sonrası gelen tıklamayı yoksay
      if (document.body.classList.contains('clean-ui')) {
        document.body.classList.remove('clean-ui');
        return;
      }
      const reel = el.closest('.reel');
      const v = itemOf(reel.dataset.id);
      const now = Date.now();
      if (now - lastTap < 300) {
        clearTimeout(tapTimer);
        lastTap = 0;
        const rect = reel.getBoundingClientRect();
        burst(reel, ev.clientX - rect.left, ev.clientY - rect.top);
        if (v) toggleLike(v, true);
      } else {
        lastTap = now;
        tapTimer = setTimeout(() => {
          lastTap = 0;
          togglePause(reel);
        }, 260);
      }
    });

    function goNext() {
      const reels = $$('.reel', feed);
      const n = reels[st.active + 1];
      if (n) n.scrollIntoView({ behavior: 'smooth' });
    }

    // Temiz ekran: videoya basılı tut → arayüz kaybolur; dokununca geri gelir
    let pressTimer = null;
    let suppressTap = 0;
    feed.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('[data-tap]')) return;
      clearTimeout(pressTimer);
      const sx = e.clientX;
      const sy = e.clientY;
      const cancel = () => {
        clearTimeout(pressTimer);
        feed.removeEventListener('pointermove', mv);
        feed.removeEventListener('pointerup', cancel);
        feed.removeEventListener('pointercancel', cancel);
      };
      const mv = (ev) => {
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 12) cancel();
      };
      pressTimer = setTimeout(() => {
        suppressTap = Date.now();
        document.body.classList.add('clean-ui');
        if (navigator.vibrate) navigator.vibrate(15);
        K.toast('Temiz ekran · çıkmak için dokun');
      }, 550);
      feed.addEventListener('pointermove', mv);
      feed.addEventListener('pointerup', cancel);
      feed.addEventListener('pointercancel', cancel);
    });

    function hideReel(v) {
      const r = reelEl(v.id);
      if (!r) return;
      const next = r.nextElementSibling;
      r.remove();
      st.items = st.items.filter((x) => x.id !== v.id);
      $$('.reel', feed).forEach((x, i) => (x.dataset.i = i));
      st.active = -1;
      if (!st.items.length) feed.innerHTML = `<div class="feed-empty">${opts.empty || K.empty('video', 'Başka video yok')}</div>`;
      else {
        const target = next && next.classList.contains('reel') ? next : $$('.reel', feed).pop();
        target.scrollIntoView();
      }
    }

    K.on(feed, 'click', '[data-act]', async (b, ev) => {
      const act = b.dataset.act;
      const reel = b.closest('.reel');
      const v = itemOf(reel.dataset.id);
      if (!v) return;
      ev.stopPropagation();
      if (act === 'like') return toggleLike(v);
      if (act === 'comment') {
        if (!v.allowComments && !v.mine) return K.toast('Bu videoda yorumlar kapalı');
        return K.openComments(v, (n) => {
          v.comments = n;
          paint(v);
        });
      }
      if (act === 'share') return K.shareVideo(v, (n) => ((v.shares = n), paint(v)));
      if (act === 'more')
        return K.videoMenu(v, {
          onSpeed: (s) => {
            K.speed = s;
            K.store.set('speed', String(s));
            const act = $$('.reel video', feed)[st.active];
            if (act) act.playbackRate = s;
          },
          onHide: () => hideReel(v),
          onAuto: () => {
            K.auto = !K.auto;
            K.store.set('auto', K.auto ? '1' : '0');
            const cur = $$('.reel video:not(.duet-orig)', feed)[st.active];
            if (cur) cur.loop = !K.auto;
            K.toast(K.auto ? 'Otomatik kaydırma açık' : 'Otomatik kaydırma kapalı');
          },
          onUpdate: (nv) => {
            Object.assign(v, nv);
            const r = reelEl(v.id);
            if (r) {
              const html = document.createElement('div');
              html.innerHTML = reelHTML(v, Number(r.dataset.i));
              const wasActive = st.active === Number(r.dataset.i);
              r.replaceWith(html.firstElementChild);
              const nr = reelEl(v.id);
              io.observe(nr);
              if (wasActive) {
                st.active = -1;
                activate(Number(nr.dataset.i));
              }
            }
          },
          onRemove: () => {
            const r = reelEl(v.id);
            if (!r) return;
            const next = r.nextElementSibling;
            r.remove();
            st.items = st.items.filter((x) => x.id !== v.id);
            $$('.reel', feed).forEach((x, i) => (x.dataset.i = i));
            st.active = -1;
            if (!st.items.length) feed.innerHTML = `<div class="feed-empty">${opts.empty || K.empty('video', 'Başka video yok')}</div>`;
            else {
              const target = next && next.classList.contains('reel') ? next : $$('.reel', feed).pop();
              target.scrollIntoView();
            }
          },
        });
      if (act === 'save') {
        const prev = { saved: v.saved, saves: v.saves };
        v.saved = !v.saved;
        v.saves = Math.max(0, v.saves + (v.saved ? 1 : -1));
        paint(v);
        try {
          const r = await K.api(`/videos/${v.id}/save`, { method: 'POST' });
          v.saved = r.saved;
          v.saves = r.saves;
          K.toast(r.saved ? 'Kaydedilenlere eklendi' : 'Kaydedilenlerden çıkarıldı');
        } catch (e) {
          Object.assign(v, prev);
          K.fail(e);
        }
        return paint(v);
      }
      if (act === 'follow') {
        try {
          const r = await K.api(`/users/${v.user.id}/follow`, { method: 'POST' });
          st.items.filter((x) => x.user.id === v.user.id).forEach((x) => {
            x.following = r.following;
            x.requested = r.requested;
            paint(x);
          });
          if (r.requested) K.toast('Takip isteği gönderildi');
        } catch (e) {
          K.fail(e);
        }
        return;
      }
      if (act === 'sound') {
        K.muted = false;
        K.store.set('muted', '0');
        applyMute();
        reel.classList.remove('muted-hint');
        return;
      }
      if (act === 'cap') return b.classList.toggle('open');
    });
    // bağlantılara (etiket/kullanıcı) tıklanınca açıklama tıklaması çalışmasın
    feed.addEventListener('click', (e) => e.target.closest('.cap a') && e.stopPropagation(), true);

    // ilerleme çubuğu
    feed.addEventListener(
      'timeupdate',
      (e) => {
        const vid = e.target;
        if (!vid.duration) return;
        const bar = $('.bar i', vid.closest('.reel'));
        if (bar) bar.style.width = (vid.currentTime / vid.duration) * 100 + '%';
      },
      true
    );

    // sekme görünmezken durdur
    const onVis = () => {
      const reel = $$('.reel', feed)[st.active];
      if (!reel) return;
      const vid = $('video', reel);
      if (document.hidden) vid.pause();
      else if (!st.userPaused) vid.play().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVis);

    // klavye: ↑ ↓ gezin, boşluk durdur, M ses, L beğen
    const onKey = (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test((e.target.tagName || '')) || K.hasOverlay()) return;
      const reels = $$('.reel', feed);
      if (e.key === 'ArrowDown' && reels[st.active + 1]) {
        e.preventDefault();
        reels[st.active + 1].scrollIntoView({ behavior: 'smooth' });
      } else if (e.key === 'ArrowUp' && st.active > 0) {
        e.preventDefault();
        reels[st.active - 1].scrollIntoView({ behavior: 'smooth' });
      } else if (e.key === ' ' && reels[st.active]) {
        e.preventDefault();
        togglePause(reels[st.active]);
      } else if (e.key.toLowerCase() === 'm') {
        K.setMuted(!K.muted);
        applyMute();
      } else if (e.key.toLowerCase() === 'l' && reels[st.active]) {
        const v = itemOf(reels[st.active].dataset.id);
        if (v) toggleLike(v);
      }
    };
    document.addEventListener('keydown', onKey);

    observe();
    if (opts.initial && opts.initial.length) {
      append(opts.initial);
      activate(0);
    } else {
      feed.innerHTML = `<div class="feed-empty">${K.spinner()}</div>`;
      loadMore();
    }

    return {
      el: feed,
      destroy() {
        st.dead = true;
        clearTimeout(viewTimer);
        if (st.sfx) st.sfx.destroy();
        if (st.dsync) st.dsync.destroy();
        document.body.classList.remove('clean-ui');
        io && io.disconnect();
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('visibilitychange', onVis);
        $$('video', feed).forEach((v) => {
          v.pause();
          v.removeAttribute('src');
          v.load();
        });
      },
      applyMute,
      items: st.items,
    };
  };

  K.setMuted = (m) => {
    K.muted = m;
    K.store.set('muted', m ? '1' : '0');
  };

  /* ---------------- ana sayfa ---------------- */
  const TABS = [
    ['following', 'Takip'],
    ['friends', 'Arkadaşlar'],
    ['foryou', 'Sizin için'],
    ['new', 'Yeni'],
  ];
  const EMPTY = {
    friends: `<div class="col" style="align-items:center">${icon('users', 'lg')}<b style="font-size:18px">Arkadaşların burada</b><span style="opacity:.75">Karşılıklı takipleştiğin kişilerin videoları görünür</span><a class="btn primary" href="#/search" style="margin-top:10px">Kişi bul</a></div>`,
    following: `<div class="col" style="align-items:center">${icon('users', 'lg')}<b style="font-size:18px">Takip ettiklerinin videoları burada</b><span style="opacity:.75">Henüz kimseyi takip etmiyorsun ya da yeni video yok.</span><a class="btn primary" href="#/discover">Kişileri keşfet</a></div>`,
    foryou: `<div class="col" style="align-items:center">${icon('video', 'lg')}<b style="font-size:18px">Henüz video yok</b><span style="opacity:.75">İlk videoyu sen yükle!</span><a class="btn primary" href="#/upload">Video yükle</a></div>`,
    new: `<div class="col" style="align-items:center">${icon('video', 'lg')}<b style="font-size:18px">Henüz yeni video yok</b></div>`,
  };

  K.route(
    '/',
    async (ctx) => {
      const v = ctx.view;
      if (!TABS.some((t) => t[0] === K.feedType)) K.feedType = 'foryou';
      v.innerHTML = `<div id="feed-root" style="position:absolute;inset:0"></div>
        <div class="feed-top"><button class="ico left icon-btn" data-mute aria-label="Ses">${icon(K.muted ? 'mute' : 'volume')}</button>
          ${TABS.map((t) => `<button class="ftab ${t[0] === K.feedType ? 'active' : ''}" data-type="${t[0]}">${t[1]}</button>`).join('')}
          <a class="ico icon-btn" href="#/search" aria-label="Ara">${icon('search')}</a></div>`;
      let feed = null;
      const mount = () => {
        if (feed) feed.destroy();
        feed = K.createFeed($('#feed-root', v), {
          load: (page) => K.api(`/videos/feed?type=${K.feedType}&page=${page}`),
          empty: EMPTY[K.feedType],
        });
      };
      K.on(v, 'click', '.ftab', (b) => {
        if (b.dataset.type === K.feedType) return;
        K.feedType = b.dataset.type;
        K.store.set('feed', K.feedType);
        $$('.ftab', v).forEach((x) => x.classList.toggle('active', x === b));
        mount();
      });
      K.on(v, 'click', '[data-mute]', (b) => {
        K.setMuted(!K.muted);
        b.innerHTML = icon(K.muted ? 'mute' : 'volume');
        feed && feed.applyMute();
      });
      mount();
      return () => feed && feed.destroy();
    },
    { feed: true, nav: 'home' }
  );

  /* ---------------- ses sayfası ---------------- */
  K.route(
    '/sound/:id',
    async (ctx) => {
      const v = ctx.view;
      const id = ctx.params.id;
      v.innerHTML = `<div id="feed-root" style="position:absolute;inset:0"></div>
        <div class="feed-top"><button class="ico left icon-btn" data-back aria-label="Geri">${icon('back')}</button>
          <b id="sndname" class="ellipsis" style="max-width:55%">Ses</b>
          <a class="btn sm primary" style="margin-left:auto;margin-right:8px" href="#/upload?sound=${encodeURIComponent(id)}">${icon('plus', 'sm')} Bu sesi kullan</a></div>`;
      K.on(v, 'click', '[data-back]', () => K.back('/'));
      const feed = K.createFeed($('#feed-root', v), {
        load: async (page) => {
          const r = await K.api(`/videos/by-sound/${encodeURIComponent(id)}?page=${page}`);
          if (r.sound) $('#sndname', v).textContent = r.sound.name + (r.total ? ` · ${r.total} video` : '');
          return r;
        },
        empty: K.empty('music', 'Bu sesle video yok', 'İlk videoyu sen paylaş!'),
      });
      return () => feed.destroy();
    },
    { feed: true, hideNav: false, nav: '' }
  );

  /* ---------------- tek video ---------------- */
  K.route(
    '/v/:id',
    async (ctx) => {
      const v = ctx.view;
      v.innerHTML = '<div id="feed-root" style="position:absolute;inset:0"></div>';
      v.insertAdjacentHTML('beforeend', `<div class="feed-top"><button class="ico left icon-btn" data-back aria-label="Geri">${icon('back')}</button></div>`);
      K.on(v, 'click', '[data-back]', () => K.back('/'));
      let first;
      try {
        first = (await K.api(`/videos/${ctx.params.id}`)).video;
      } catch (e) {
        v.innerHTML = `<div class="feed-empty" style="color:#fff">${K.empty('video', 'Video bulunamadı', e.message, '<a class="btn primary" href="#/">Ana sayfa</a>')}</div>`;
        return null;
      }
      if (!ctx.alive()) return null;
      const feed = K.createFeed($('#feed-root', v), {
        initial: [first],
        load: (page) => K.api(`/videos/feed?type=foryou&page=${page}`),
      });
      return () => feed.destroy();
    },
    { feed: true, hideNav: false, nav: '' }
  );
})();
