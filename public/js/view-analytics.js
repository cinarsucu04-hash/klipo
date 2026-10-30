/* Klipo yaratıcı analizi: toplam sayılar, son 7 gün, en çok izlenen videolar */
(function () {
  'use strict';
  const K = window.K;
  const { esc, icon, $ } = K;

  const DAYS = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];

  K.route(
    '/analytics',
    async (ctx) => {
      const v = ctx.view;
      v.innerHTML = `<div class="topbar"><button class="icon-btn" data-back aria-label="Geri">${icon('back')}</button><h1>Yaratıcı analizi</h1><span class="spacer"></span></div><div id="an">${K.spinner()}</div>`;
      K.on(v, 'click', '[data-back]', () => K.back('/settings'));
      const box = $('#an', v);
      let d;
      try {
        d = await K.api('/me/analytics');
      } catch (e) {
        if (ctx.alive()) box.innerHTML = K.empty('refresh', 'Yüklenemedi', e.message);
        return;
      }
      if (!ctx.alive()) return;
      const t = d.totals;
      const dayName = (s) => DAYS[new Date(s + 'T12:00:00').getDay()];
      const chart = (title, key, cls) => {
        const max = Math.max(1, ...d.daily.map((x) => x[key]));
        const total = d.daily.reduce((n, x) => n + x[key], 0);
        return `<div class="section-title">${title} <span class="hint">· son 7 gün: ${K.count(total)}</span></div>
          <div class="mini-chart ${cls || ''}">${d.daily
            .map((x) => `<div title="${esc(x.d)}: ${x[key]}"><span>${x[key]}</span><i style="height:${Math.max(3, (x[key] / max) * 100)}%"></i><span>${dayName(x.d)}</span></div>`)
            .join('')}</div>`;
      };
      box.innerHTML = `<div class="stat-grid">
          ${[['İzlenme', t.views], ['Beğeni', t.likes], ['Yorum', t.comments], ['Paylaşım', t.shares], ['Kaydetme', t.saves], ['Takipçi', t.followers]]
            .map((s) => `<div class="stat"><b>${K.count(s[1])}</b><span>${s[0]}</span></div>`)
            .join('')}</div>
        <p class="hint" style="padding:6px 16px 0">${t.videos} videodan toplam. Kendi etkileşimlerin sayılmaz.</p>
        ${chart('Beğeniler', 'likes')}${chart('Yorumlar', 'comments')}${chart('Yeni takipçiler', 'followers')}${chart('Profil ziyaretleri', 'visitors')}
        <div class="section-title">En çok izlenen videolar</div>
        ${d.top.length
          ? d.top
              .map(
                (x, i) => `<a class="list-item" href="#/v/${esc(x.id)}">
                  <span class="rank">${i + 1}</span>
                  ${x.posterUrl ? `<img class="thumb-sm" src="${esc(x.posterUrl)}" alt="" loading="lazy">` : `<span class="thumb-sm">${icon('video', 'sm')}</span>`}
                  <span class="grow"><span class="title ellipsis" style="font-size:14px">${esc(x.caption || 'Açıklamasız video')}</span>
                  <span class="sub" style="display:block">${icon('eye', 'sm')} ${K.count(x.views)} · ${icon('heart', 'sm')} ${K.count(x.likes)} · ${icon('comment', 'sm')} ${K.count(x.comments)}</span></span></a>`
              )
              .join('')
          : K.empty('video', 'Henüz video yok', 'İlk videonu paylaşınca istatistikler burada görünür.')}`;
    },
    { nav: 'me' }
  );
})();
