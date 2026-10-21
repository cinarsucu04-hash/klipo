/* Klipo keşfet, arama ve etiket sayfaları */
(function () {
  'use strict';
  const K = window.K;
  const { esc, icon, $, $$ } = K;

  const tagChip = (t) => `<a class="chip" href="#/tag/${encodeURIComponent(t.tag)}">${icon('hash', 'sm')}${esc(t.tag)}<span class="muted" style="font-weight:500">${K.count(t.count)}</span></a>`;

  /* ---------------- Keşfet ---------------- */
  K.route(
    '/discover',
    async (ctx) => {
      const v = ctx.view;
      v.innerHTML = `<div class="topbar"><a class="input row" href="#/search" style="margin:0 8px;color:var(--muted);height:40px;border-radius:20px">${icon('search', 'sm')}<span>Hesap, video veya #etiket ara</span></a></div>
        <div id="tray"></div><div id="disc-body">${K.spinner()}</div>`;
      K.storiesTray($('#tray', v));
      let d;
      try {
        d = await K.api('/discover');
      } catch (e) {
        $('#disc-body', v).innerHTML = K.empty('refresh', 'Yüklenemedi', e.message);
        return;
      }
      if (!ctx.alive()) return;
      $('#disc-body', v).innerHTML = `
        ${d.tags.length ? `<div class="section-title">Gündemdeki etiketler</div><div class="chips" style="flex-wrap:wrap">${d.tags.map(tagChip).join('')}</div>` : ''}
        ${d.users.length ? `<div class="section-title">Önerilen hesaplar</div><div id="sug">${d.users.slice(0, 5).map((u) => K.userRow(u, { follow: true })).join('')}</div>` : ''}
        <div class="section-title">Popüler videolar</div>
        ${d.videos.length ? `<div class="grid">${d.videos.map((x) => K.tile(x)).join('')}</div>` : K.empty('video', 'Henüz video yok', 'İlk videoyu sen paylaş!', '<a class="btn primary" href="#/upload">Video yükle</a>')}`;
      K.bindFollow($('#disc-body', v));
    },
    { nav: 'discover' }
  );

  /* ---------------- Arama ---------------- */
  K.route(
    '/search',
    async (ctx) => {
      const v = ctx.view;
      let q = ctx.query.q || '';
      let type = ctx.query.t || 'all';
      v.innerHTML = `<div class="topbar"><button class="icon-btn" data-back aria-label="Geri">${icon('back')}</button>
          <form id="sform" class="grow"><input class="input" id="sq" type="search" placeholder="Ara…" maxlength="60" autocomplete="off" value="${esc(q)}" style="border-radius:20px;height:40px;padding:0 14px"></form></div>
        <div class="tabs" id="stabs">${[['all', 'Tümü'], ['users', 'Hesaplar'], ['videos', 'Videolar'], ['tags', 'Etiketler']].map((t) => `<button data-t="${t[0]}" class="${t[0] === type ? 'active' : ''}">${t[1]}</button>`).join('')}</div>
        <div id="sbody"></div>`;
      const body = $('#sbody', v);
      const input = $('#sq', v);
      K.on(v, 'click', '[data-back]', () => K.back('/discover'));
      let seq = 0;

      async function showIdle() {
        body.innerHTML = K.spinner();
        const [recent, disc] = await Promise.all([K.api('/search/recent').catch(() => ({ queries: [] })), K.api('/discover').catch(() => ({ tags: [] }))]);
        if (!ctx.alive() || input.value.trim()) return;
        body.innerHTML = `${recent.queries.length ? `<div class="section-title">Son aramalar<button class="muted" data-clear style="font-size:13px">Temizle</button></div>${recent.queries.map((r) => `<div class="list-item"><button class="row grow" data-q="${esc(r)}" style="text-align:left">${icon('clock', 'sm')}<span>${esc(r)}</span></button><button class="icon-btn" data-del="${esc(r)}" aria-label="Sil">${icon('x', 'sm')}</button></div>`).join('')}` : ''}
          ${disc.tags.length ? `<div class="section-title">Gündemdeki etiketler</div><div class="chips" style="flex-wrap:wrap">${disc.tags.map(tagChip).join('')}</div>` : ''}`;
      }

      async function run(save) {
        const text = input.value.trim();
        history.replaceState(history.state, '', `#/search${text ? '?q=' + encodeURIComponent(text) + '&t=' + type : ''}`);
        if (!text) return showIdle();
        const my = ++seq;
        body.innerHTML = K.spinner();
        let d;
        try {
          d = await K.api(`/search?q=${encodeURIComponent(text)}&type=${type}${save ? '&save=1' : ''}`);
        } catch (e) {
          if (my === seq) body.innerHTML = K.empty('refresh', 'Arama başarısız', e.message);
          return;
        }
        if (my !== seq || !ctx.alive()) return;
        const all = type === 'all';
        const section = (title, html, t) => (html ? `<div class="section-title">${title}${all && t ? `<button class="muted" data-switch="${t}" style="font-size:13px">Tümünü gör</button>` : ''}</div>${html}` : '');
        const users = d.users.map((u) => K.userRow(u, { follow: false })).join('');
        const tags = d.tags.map((t) => `<a class="list-item" href="#/tag/${encodeURIComponent(t.tag)}"><span class="avatar" style="background:var(--bg3);color:var(--brand)">${icon('hash')}</span><span class="grow"><span class="title">#${esc(t.tag)}</span><span class="sub" style="display:block">${t.count} video</span></span></a>`).join('');
        const vids = d.videos.length ? `<div class="grid">${d.videos.map((x) => K.tile(x)).join('')}</div>` : '';
        const out = (all || type === 'users' ? section('Hesaplar', users, 'users') : '') + (all || type === 'tags' ? section('Etiketler', tags, 'tags') : '') + (all || type === 'videos' ? section('Videolar', vids, 'videos') : '');
        body.innerHTML = out || K.empty('search', 'Sonuç bulunamadı', `"${text}" için eşleşme yok.`);
      }

      K.on(v, 'click', '#stabs button', (b) => {
        type = b.dataset.t;
        $$('#stabs button', v).forEach((x) => x.classList.toggle('active', x === b));
        run(false);
      });
      K.on(v, 'click', '[data-switch]', (b) => $(`#stabs button[data-t="${b.dataset.switch}"]`, v).click());
      K.on(v, 'click', '[data-q]', (b) => {
        input.value = b.dataset.q;
        run(true);
      });
      K.on(v, 'click', '[data-del]', async (b) => {
        await K.api(`/search/recent?q=${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' }).catch(K.fail);
        showIdle();
      });
      K.on(v, 'click', '[data-clear]', async () => {
        await K.api('/search/recent', { method: 'DELETE' }).catch(K.fail);
        showIdle();
      });
      $('#sform', v).addEventListener('submit', (e) => {
        e.preventDefault();
        input.blur();
        run(true);
      });
      input.addEventListener('input', K.debounce(() => run(false), 320));
      if (q) run(false);
      else {
        showIdle();
        setTimeout(() => input.focus(), 120);
      }
    },
    { nav: 'discover' }
  );

  /* ---------------- Etiket ---------------- */
  K.route(
    '/tag/:tag',
    async (ctx) => {
      const tag = ctx.params.tag.toLowerCase();
      const v = ctx.view;
      v.innerHTML = `<div class="topbar"><button class="icon-btn" data-back aria-label="Geri">${icon('back')}</button><h1>#${esc(tag)}</h1><span class="spacer"></span></div>
        <div id="tag-head" class="page center"></div><div class="grid" id="tag-grid"></div><div id="tag-more"></div>`;
      K.on(v, 'click', '[data-back]', () => K.back('/discover'));
      const grid = $('#tag-grid', v);
      let page = 0;
      let first = true;
      const inf = K.infinite(v, $('#tag-more', v), async () => {
        const d = await K.api(`/tags/${encodeURIComponent(tag)}?page=${page}`);
        if (!ctx.alive()) return false;
        page++;
        if (first) {
          first = false;
          $('#tag-head', v).innerHTML = `<div class="avatar xl" style="margin:0 auto 10px;background:var(--bg3);color:var(--brand)">${icon('hash', 'lg')}</div><b style="font-size:18px">#${esc(tag)}</b><div class="muted">${d.count} video</div>`;
          if (!d.videos.length) $('#tag-head', v).innerHTML += K.empty('video', 'Bu etikette henüz video yok');
        }
        grid.insertAdjacentHTML('beforeend', d.videos.map((x) => K.tile(x)).join(''));
        return d.hasMore;
      });
      return () => inf.stop();
    },
    { nav: 'discover' }
  );
})();
