/* Klipo yönetim paneli (yalnızca admin) */
(function () {
  'use strict';
  const K = window.K;
  const { esc, icon, $, $$ } = K;

  const TABS = [['stats', 'Genel'], ['reports', 'Şikayetler'], ['users', 'Kullanıcılar'], ['videos', 'Videolar'], ['safety', 'Güvenlik'], ['storage', 'Depolama'], ['system', 'Sistem']];

  K.route(
    '/admin',
    async (ctx) => {
      const v = ctx.view;
      if (K.me.role !== 'admin') return K.go('/', true);
      let tab = ctx.query.tab || 'stats';
      v.innerHTML = `<div class="topbar"><button class="icon-btn" data-back>${icon('back')}</button><h1>Yönetim paneli</h1><span class="spacer"></span></div>
        <div class="chips" id="atabs">${TABS.map((t) => `<button class="chip ${t[0] === tab ? 'active' : ''}" data-t="${t[0]}">${t[1]}</button>`).join('')}</div><div id="ab"></div>`;
      K.on(v, 'click', '[data-back]', () => K.back('/settings'));
      const body = $('#ab', v);

      K.on(v, 'click', '#atabs [data-t]', (b) => {
        tab = b.dataset.t;
        $$('#atabs .chip', v).forEach((x) => x.classList.toggle('active', x === b));
        show();
      });

      const views = { stats, reports, users, videos, safety, storage, system };
      function show() {
        body.innerHTML = K.spinner();
        views[tab]().catch((e) => (body.innerHTML = K.empty('refresh', 'Yüklenemedi', e.message)));
      }

      /* ---- genel ---- */
      async function stats() {
        const d = await K.api('/admin/stats');
        if (!ctx.alive()) return;
        const t = d.totals;
        const chart = (title, rows) => {
          const max = Math.max(1, ...rows.map((r) => r.n));
          return `<div class="section-title">${title}</div><div class="mini-chart">${rows.map((r) => `<div title="${esc(r.day)}: ${r.n}"><span>${r.n}</span><i style="height:${Math.max(3, (r.n / max) * 100)}%"></i><span>${esc(r.day.slice(8))}</span></div>`).join('')}</div>`;
        };
        const st = d.storage && d.storage.pct >= 70
          ? `<div class="card warnbox"><b>${d.storage.full ? 'Depolama dolu' : 'Depolama doluyor'} · %${d.storage.pct}</b><p class="hint" style="margin:4px 0 10px">${d.storage.full && d.storage.backend === 'gridfs' ? 'Yeni video yüklemeleri durduruldu; mevcut içerik güvende.' : 'Dolmadan önce dış depoya geçmeni öneririm.'}</p><button class="btn sm primary" data-gost>Depolama ayarlarına git</button></div>`
          : '';
        body.innerHTML = `${st}<div class="stat-grid">
            ${[['Kullanıcı', t.users], ['Video', t.videos], ['Yorum', t.comments], ['Açık şikayet', t.openReports], ['Aktif hikaye', t.activeStories], ['Askıda', t.banned]].map((s) => `<div class="stat"><b>${K.count(s[1])}</b><span>${s[0]}</span></div>`).join('')}</div>
          <div class="section-title">Son 24 saat</div>
          <div class="stat-grid">${[['Yeni üye', d.last24h.newUsers], ['Yeni video', d.last24h.newVideos], ['Aktif kullanıcı', d.last24h.activeUsers]].map((s) => `<div class="stat"><b>${s[1]}</b><span>${s[0]}</span></div>`).join('')}</div>
          ${chart('Yeni üyeler (7 gün)', d.daily.users)}${chart('Yeni videolar (7 gün)', d.daily.videos)}
          <div class="card hint" style="margin-top:18px">Sunucu: Node ${esc(d.server.node)} · bellek ${d.server.memoryMB} MB · çalışma süresi ${d.server.uptimeMin} dk · veritabanı ${d.server.db ? 'bağlı' : 'yok'}</div>`;
      }

      K.on(body, 'click', '[data-gost]', () => $('#atabs [data-t="storage"]', v).click());

      /* ---- depolama ---- */
      let stTimer = null;
      async function storage() {
        clearTimeout(stTimer);
        const d = await K.api('/admin/storage');
        if (!ctx.alive() || tab !== 'storage') return;
        const mb = (b) => {
          const m = (b || 0) / 1048576;
          return (m >= 100 ? Math.round(m) : Math.round(m * 10) / 10).toString().replace('.', ',') + ' MB';
        };
        const u = d.db;
        const level = !u ? 'ok' : u.full ? 'bad' : u.pct >= 70 ? 'warn' : 'ok';
        const where = { s3: 'Dış depo', gridfs: 'MongoDB', disk: 'Disk' }[d.backend] || d.backend;
        const ex = d.external;
        const kinds = { video: 'Video', image: 'Görsel', audio: 'Ses' };
        const jobHTML = (j) => {
          if (!j || !j.mode) return '';
          const pct = j.total ? Math.round((j.done / j.total) * 100) : j.running ? 0 : 100;
          const name = { copy: 'Kopyalama', free: 'MongoDB’de yer açma', orphans: 'Sahipsiz dosya temizliği' }[j.mode];
          const line = j.mode === 'copy'
            ? `${j.copied} kopyalandı · ${j.already} zaten vardı · ${j.failed} hata · ${mb(j.bytes)}`
            : `${j.copied} dosya işlendi (${mb(j.freed)} yer açıldı) · ${j.skipped} atlandı · ${j.failed} hata`;
          return `<div class="card" id="jobbox"><b>${name} ${j.running ? 'sürüyor…' : j.error ? 'durdu' : 'bitti'}</b>
            <div class="progress" style="margin:10px 0"><i style="width:${pct}%"></i></div>
            <p class="hint">${j.done}/${j.total} dosya · ${line}</p>
            ${j.error ? `<p class="error-text">${esc(j.error)}</p>` : ''}
            ${j.log && j.log.length ? `<details style="margin-top:8px"><summary class="hint">Kayıt</summary><pre class="logpre">${esc(j.log.join('\n'))}</pre></details>` : ''}
            ${j.running ? '<button class="btn sm" id="st-stop" style="margin-top:8px">Durdur</button>' : ''}</div>`;
        };
        body.innerHTML = `<div class="card gauge ${level}">
            <div class="row"><b class="grow">MongoDB doluluğu</b><span class="tag-pill ${level === 'bad' ? 'red' : level === 'ok' ? 'green' : ''}">${u ? '%' + u.pct : '—'}</span></div>
            <div class="progress" style="margin:10px 0"><i style="width:${u ? u.pct : 0}%"></i></div>
            <p class="hint">${u ? `${mb(u.usedBytes)} / ${mb(u.quotaBytes)} (tahmini)` : 'Ölçülemedi'}</p>
            <p class="hint" style="margin-top:6px">Yeni yüklemeler: <b>${where}</b>${d.backend === 'gridfs' && u ? (u.full ? ' · <span class="error-text">eşik (%' + u.guardPct + ') aşıldı, yükleme durduruldu</span>' : ' · eşik %' + u.guardPct) : ''}</p>
            <p class="hint" style="margin-top:6px">Bu ekranda hiçbir hesap, video veya yorum silinmez; videolar yalnızca kopyalanır.</p></div>
          <div class="stat-grid">
            <div class="stat"><b>${d.grid.count}</b><span>MongoDB’de dosya · ${mb(d.grid.bytes)}</span></div>
            <div class="stat"><b>${d.externalCount}</b><span>Dış depoda · ${mb(d.externalBytes)}</span></div>
            <div class="stat"><b>${d.orphans.count}</b><span>Sahipsiz · ${mb(d.orphans.bytes)}</span></div></div>
          ${Object.keys(d.media.byKind).length ? `<p class="hint" style="padding:6px 16px 0">${Object.entries(d.media.byKind).map(([k, x]) => `${kinds[k] || k}: ${x.count} (${mb(x.bytes)})`).join(' · ')}</p>` : ''}
          <div class="card"><b>Dış depo</b>
            ${ex.configured
              ? `<p class="hint" style="margin:4px 0 10px">Bağlı: ${esc(ex.info.host)} · kova ${esc(ex.info.bucket)}</p><button class="btn sm" id="st-test">Bağlantıyı dene</button>`
              : `<p class="hint" style="margin:4px 0 10px">Ayarlı değil. Videolar şu an MongoDB’de duruyor; ücretsiz kota (${u ? mb(u.quotaBytes) : '512 MB'}) dolunca yeni yükleme yapılamaz. Ücretsiz bir S3 uyumlu depo bağlayınca yeni videolar oraya gider, eskiler yerinde kalır.</p>
                <details><summary class="btn sm">Nasıl bağlanır?</summary><ol class="howto">
                  <li><b>Filebase</b> (5 GB ücretsiz, kart istemez), Cloudflare <b>R2</b> veya Backblaze <b>B2</b> (10 GB ücretsiz; kayıtta kart istenebilir) hesabı aç.</li>
                  <li>Bir <b>kova (bucket)</b> oluştur, herkese açık yapma.</li>
                  <li>Okuma+yazma yetkili bir <b>S3 API anahtarı</b> oluştur; uç nokta adresini, Access Key ID ve Secret’ı kopyala.</li>
                  <li>Render → servisin <b>Environment</b> bölümüne ekle: <code>S3_ENDPOINT</code>, <code>S3_BUCKET</code>, <code>S3_KEY_ID</code>, <code>S3_SECRET</code> (R2 ve Filebase için ayrıca <code>S3_REGION</code> = <code>auto</code>; Filebase uç noktası <code>https://s3.filebase.io</code>). Kaydedince Render yeniden başlar.</li>
                  <li>Buraya dön: <b>Bağlantıyı dene</b> → <b>Kopyala</b> → <b>MongoDB’de yer aç</b>.</li></ol></details>`}</div>
          ${ex.configured ? `<div class="card"><b>Mevcut videoları taşı</b>
            <p class="hint" style="margin:4px 0 10px"><b>1 · Kopyala</b>: MongoDB’deki dosyaları dış depoya kopyalar. Hiçbir şey silinmez, uygulama aynen çalışır.</p>
            <button class="btn sm primary" id="st-copy" ${d.job.running ? 'disabled' : ''}>Kopyala</button>
            <p class="hint" style="margin:14px 0 10px"><b>2 · Yer aç</b>: kopyası bayt bayt doğrulanan dosyaların MongoDB’deki nüshasını kaldırır. Videolar dış depodan oynamaya devam eder; doğrulanamayan dosyaya dokunulmaz.</p>
            <button class="btn sm" id="st-free" ${d.job.running ? 'disabled' : ''}>MongoDB’de yer aç</button></div>` : ''}
          ${d.orphans.count ? `<div class="card"><b>Sahipsiz dosyalar</b><p class="hint" style="margin:4px 0 10px">${d.orphans.count} dosya (${mb(d.orphans.bytes)}) hiçbir videoya/profile bağlı değil (yarım kalan yüklemelerin artığı); 1 saatten eskilerdir.</p><button class="btn sm" id="st-orph" ${d.job.running ? 'disabled' : ''}>Sahipsiz dosyaları temizle</button></div>` : ''}
          <div id="jobwrap">${jobHTML(d.job)}</div>
          ${d.collections.length ? `<div class="section-title">En büyük koleksiyonlar</div>${d.collections.map((c) => `<div class="list-item"><span class="grow"><span class="title" style="font-size:14px">${esc(c.name)}</span></span><span class="sub">${c.count} kayıt · ${mb(c.bytes)}</span></div>`).join('')}` : ''}`;

        const startJob = async (mode, extra) => {
          try {
            await K.api('/admin/storage/job', { method: 'POST', body: { mode, ...extra } });
            K.toast('İş başladı', 'ok');
            storage();
          } catch (e) {
            K.fail(e);
          }
        };
        const test = $('#st-test', body);
        if (test) {
          test.onclick = async () => {
            test.disabled = true;
            try {
              const r = await K.api('/admin/storage/test', { method: 'POST' });
              if (r.ok) K.toast(`Bağlantı tamam (${r.ms} ms)`, 'ok');
              else K.toast(r.error || 'Bağlanılamadı');
            } catch (e) {
              K.fail(e);
            }
            test.disabled = false;
          };
        }
        const copy = $('#st-copy', body);
        if (copy) copy.onclick = () => startJob('copy');
        const free = $('#st-free', body);
        if (free) {
          free.onclick = async () => {
            const a = await K.ask({ title: 'MongoDB’de yer açılsın mı?', text: 'Yalnızca dış depoda bayt bayt doğrulanan videoların MongoDB’deki nüshası kaldırılır; videolar dış depodan oynar. Önce “Kopyala”yı çalıştırmış olmalısın. Onaylamak için EVET yaz.', ok: 'Yer aç', max: 10 });
            if (a === null) return;
            if (String(a).trim().toUpperCase() !== 'EVET') return K.toast('Onaylanmadı');
            startJob('free', { confirm: 'EVET' });
          };
        }
        const orph = $('#st-orph', body);
        if (orph) {
          orph.onclick = async () => {
            if (await K.confirm({ title: 'Sahipsiz dosyalar temizlensin mi?', text: 'Hiçbir videoya/profile bağlı olmayan, 1 saatten eski dosyalar silinir. Hesaplar ve videolar etkilenmez.', ok: 'Temizle', danger: true })) startJob('orphans');
          };
        }
        const poll = async () => {
          if (!ctx.alive() || tab !== 'storage' || !$('#jobwrap', body)) return;
          try {
            const j = await K.api('/admin/storage/job');
            const w = $('#jobwrap', body);
            if (!w) return;
            w.innerHTML = jobHTML(j);
            const stop = $('#st-stop', body);
            if (stop) stop.onclick = () => K.api('/admin/storage/job/stop', { method: 'POST' }).catch(K.fail);
            if (j.running) stTimer = setTimeout(poll, 1500);
            else storage();
          } catch (e) { /* ağ kısa süre kesilebilir */ stTimer = setTimeout(poll, 3000); }
        };
        const stopBtn = $('#st-stop', body);
        if (stopBtn) stopBtn.onclick = () => K.api('/admin/storage/job/stop', { method: 'POST' }).catch(K.fail);
        if (d.job.running) stTimer = setTimeout(poll, 1500);
      }

      /* ---- şikayetler ---- */
      async function reports() {
        let status = 'open';
        const box = document.createElement('div');
        body.innerHTML = '';
        body.appendChild(box);
        async function load() {
          box.innerHTML = `<div class="seg" style="margin:0 16px"><button data-s="open" class="${status === 'open' ? 'active' : ''}">Açık</button><button data-s="closed" class="${status === 'closed' ? 'active' : ''}">Sonuçlanan</button></div><div id="rl">${K.spinner()}</div>`;
          const d = await K.api(`/admin/reports?status=${status}`);
          if (!ctx.alive()) return;
          $('#rl', box).innerHTML = d.reports.length
            ? d.reports.map((r) => `<div class="card" data-id="${esc(r.id)}">
                <div class="row"><span class="tag-pill red">${r.type === 'video' ? 'Video' : r.type === 'comment' ? 'Yorum' : 'Kullanıcı'}</span><b class="grow">${esc(r.reason)}</b><span class="hint">${K.timeAgo(r.createdAt)}</span></div>
                <p class="hint" style="margin:6px 0">Bildiren: ${r.reporter ? '@' + esc(r.reporter.username) : '—'} · Hedef: ${r.targetUser ? `<a href="#/u/${esc(r.targetUser.username)}" style="color:var(--brand)">@${esc(r.targetUser.username)}</a>` : '—'}</p>
                ${r.description ? `<p style="margin:6px 0">${esc(r.description)}</p>` : ''}
                ${r.comment ? `<p class="card" style="margin:6px 0">“${esc(r.comment.text)}”</p>` : ''}
                ${r.video ? `<a href="#/v/${esc(r.video.id)}" class="row" style="margin:6px 0">${r.video.posterUrl ? `<img src="${esc(r.video.posterUrl)}" alt="" style="width:46px;height:62px;object-fit:cover;border-radius:6px">` : icon('video')}<span class="ellipsis">${esc(r.video.caption || 'Videoyu aç')}</span></a>` : ''}
                ${r.contentGone ? '<p class="hint">İçerik zaten silinmiş.</p>' : ''}
                ${r.evidenceUrl ? `<a href="${esc(r.evidenceUrl)}" target="_blank" rel="noopener" style="color:var(--brand);font-size:13px">Kanıt görselini aç</a>` : ''}
                ${r.status === 'open'
                  ? `<div class="row" style="margin-top:10px;flex-wrap:wrap"><button class="btn sm" data-a="dismiss">Reddet</button>${r.type !== 'user' && !r.contentGone ? '<button class="btn sm danger" data-a="remove_content">İçeriği sil</button>' : ''}<button class="btn sm danger" data-a="ban_user">Hesabı askıya al</button></div>`
                  : `<p class="hint" style="margin-top:8px">Sonuç: <b>${{ dismiss: 'Reddedildi', remove_content: 'İçerik silindi', ban_user: 'Hesap askıya alındı' }[r.action] || r.action}</b>${r.note ? ' · ' + esc(r.note) : ''}</p>`}
              </div>`).join('')
            : K.empty('check', status === 'open' ? 'Açık şikayet yok' : 'Sonuçlanan şikayet yok');
        }
        K.on(box, 'click', '[data-s]', (b) => {
          status = b.dataset.s;
          load();
        });
        K.on(box, 'click', '[data-a]', async (b) => {
          const id = b.closest('[data-id]').dataset.id;
          const action = b.dataset.a;
          let note = '';
          if (action !== 'dismiss') {
            const ok = await K.confirm({ title: action === 'ban_user' ? 'Hesap askıya alınsın mı?' : 'İçerik silinsin mi?', text: 'Aynı içeriğe ait tüm açık şikayetler sonuçlanır.', ok: 'Onayla', danger: true });
            if (!ok) return;
            if (action === 'ban_user') {
              const n = await K.ask({ title: 'Askıya alma nedeni', placeholder: 'Topluluk kurallarını ihlal', max: 200, ok: 'Askıya al', danger: true });
              if (n === null) return;
              note = n;
            }
          }
          try {
            await K.api(`/admin/reports/${id}/resolve`, { method: 'POST', body: { action, note } });
            K.toast('Şikayet sonuçlandı', 'ok');
            load();
          } catch (e) {
            K.fail(e);
          }
        });
        await load();
      }

      /* ---- kullanıcılar ---- */
      async function users() {
        body.innerHTML = `<div style="padding:0 16px 8px" class="row"><input class="input" id="uq" placeholder="Kullanıcı ara…" maxlength="40"><label class="chip"><input type="checkbox" id="ub"> Askıdakiler</label></div><div id="ul"></div>`;
        const list = $('#ul', body);
        async function load() {
          list.innerHTML = K.spinner();
          const d = await K.api(`/admin/users?q=${encodeURIComponent($('#uq', body).value)}${$('#ub', body).checked ? '&banned=1' : ''}`);
          if (!ctx.alive()) return;
          list.innerHTML = d.users.length
            ? d.users.map((u) => `<div class="list-item" data-id="${esc(u.id)}"><a class="row grow" href="#/u/${esc(u.username)}" style="min-width:0">${K.avatar(u)}<span class="grow" style="min-width:0"><span class="title ellipsis" style="display:block">${K.nameHTML(u)} ${u.role === 'admin' ? '<span class="tag-pill">Yönetici</span>' : ''}${u.banned ? ` <span class="tag-pill red">${u.bannedUntil ? 'Geçici askıda' : 'Askıda'}</span>` : ''}${u.accountType === 'rp' ? ' <span class="tag-pill">RP</span>' : ''}${u.google ? ' <span class="tag-pill">Google</span>' : ''}</span><span class="sub ellipsis" style="display:block">@${esc(u.username)} · ${K.timeAgo(u.createdAt)}${u.banned && u.banReason ? ' · ' + esc(u.banReason) : ''}${u.bannedUntil ? ' · ' + new Date(u.bannedUntil).toLocaleString('tr-TR') + ' tarihine kadar' : ''}${u.ip ? ' · IP ' + esc(u.ip) : ''}</span></span></a>
                ${u.role === 'admin' ? '' : `<button class="btn sm" data-verify>${u.verified ? 'Rozeti al' : 'Rozet'}</button>${u.banned ? '<button class="btn sm primary" data-unban>Aç</button>' : '<button class="btn sm danger" data-ban>Askıya al</button>'}`}</div>`).join('')
            : K.empty('users', 'Kullanıcı bulunamadı');
        }
        $('#uq', body).addEventListener('input', K.debounce(load, 300));
        $('#ub', body).addEventListener('change', load);
        K.on(list, 'click', '[data-verify]', async (b) => {
          await K.api(`/admin/users/${b.closest('[data-id]').dataset.id}/verify`, { method: 'POST' }).then(load).catch(K.fail);
        });
        K.on(list, 'click', '[data-unban]', async (b) => {
          await K.api(`/admin/users/${b.closest('[data-id]').dataset.id}/unban`, { method: 'POST' }).then(() => (K.toast('Askı kaldırıldı', 'ok'), load())).catch(K.fail);
        });
        K.on(list, 'click', '[data-ban]', (b) => {
          const id = b.closest('[data-id]').dataset.id;
          let days = 0;
          K.sheet({
            title: 'Hesabı askıya al',
            html: `<div class="page col">
              <label class="field"><span>Neden?</span><input class="input" id="bn-r" maxlength="200" placeholder="Topluluk kurallarını ihlal"></label>
              <div class="field"><span>Süre</span><div class="seg" id="bn-d" style="margin:0">
                <button data-d="1">1 gün</button><button data-d="7">7 gün</button><button data-d="30">30 gün</button><button data-d="0" class="active">Süresiz</button></div>
                <small class="hint">Süreli askıda videolar yerinde kalır, süre dolunca hesap kendiliğinden açılır. Süresiz askıda videolar gizlenir.</small></div>
              <label class="row" style="gap:10px"><input type="checkbox" id="bn-ip"> <span>Bu kişinin IP adresini de yasakla<br><small class="hint">Aynı ağdan yeni hesap açamaz, siteye giremez. Ortak Wi-Fi / mobil ağda masum kişileri de etkileyebilir.</small></span></label>
              <button class="btn danger block" id="bn-go">Askıya al</button></div>`,
            onMount: (api) => {
              K.on(api.el, 'click', '#bn-d [data-d]', (x) => {
                days = Number(x.dataset.d);
                $$('#bn-d [data-d]', api.el).forEach((y) => y.classList.toggle('active', y === x));
              });
              $('#bn-go', api.el).onclick = async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true;
                try {
                  await K.api(`/admin/users/${id}/ban`, { method: 'POST', body: { reason: $('#bn-r', api.el).value, days, ip: $('#bn-ip', api.el).checked } });
                  api.close();
                  K.toast('Hesap askıya alındı', 'ok');
                  load();
                } catch (err) {
                  K.fail(err);
                  btn.disabled = false;
                }
              };
            },
          });
        });
        await load();
      }

      /* ---- videolar ---- */
      async function videos() {
        body.innerHTML = `<div style="padding:0 16px 8px"><input class="input" id="vq" placeholder="Açıklamada ara…" maxlength="60"></div><div id="vl"></div>`;
        const list = $('#vl', body);
        async function load() {
          list.innerHTML = K.spinner();
          const d = await K.api(`/admin/videos?q=${encodeURIComponent($('#vq', body).value)}`);
          if (!ctx.alive()) return;
          list.innerHTML = d.videos.length
            ? d.videos.map((x) => `<div class="list-item" data-id="${esc(x.id)}"><a class="row grow" href="#/v/${esc(x.id)}" style="min-width:0">${x.posterUrl ? `<img src="${esc(x.posterUrl)}" alt="" style="width:46px;height:62px;object-fit:cover;border-radius:6px">` : `<span class="avatar">${icon('video')}</span>`}
              <span class="grow" style="min-width:0"><span class="title ellipsis" style="display:block">${esc(x.caption || '(açıklama yok)')}</span><span class="sub" style="display:block">${x.user ? '@' + esc(x.user.username) : '—'} · ${K.count(x.views)} izlenme · ${K.count(x.likes)} beğeni</span>
              ${x.featured ? '<span class="tag-pill green">Öne çıkan</span> ' : ''}${x.sensitive ? '<span class="tag-pill red">Hassas</span> ' : ''}${x.removed ? '<span class="tag-pill red">Gizli</span>' : ''}</span></a>
              <button class="btn sm" data-feat>${x.featured ? 'Kaldır' : 'Öne çıkar'}</button><button class="btn sm" data-sens>${x.sensitive ? 'Hassas değil' : 'Hassas'}</button><button class="btn sm danger" data-del>Sil</button></div>`).join('')
            : K.empty('video', 'Video bulunamadı');
        }
        $('#vq', body).addEventListener('input', K.debounce(load, 300));
        const idOf = (b) => b.closest('[data-id]').dataset.id;
        K.on(list, 'click', '[data-feat]', (b) => K.api(`/admin/videos/${idOf(b)}/feature`, { method: 'POST' }).then(load).catch(K.fail));
        K.on(list, 'click', '[data-sens]', (b) => K.api(`/admin/videos/${idOf(b)}/sensitive`, { method: 'POST' }).then(load).catch(K.fail));
        K.on(list, 'click', '[data-del]', async (b) => {
          if (!(await K.confirm({ title: 'Video silinsin mi?', text: 'Bu işlem geri alınamaz.', ok: 'Sil', danger: true }))) return;
          await K.api(`/videos/${idOf(b)}`, { method: 'DELETE' }).then(() => (K.toast('Video silindi', 'ok'), load())).catch(K.fail);
        });
        await load();
      }

      /* ---- güvenlik ---- */
      async function safety() {
        const [ib, ml, sc] = await Promise.all([K.api('/admin/ip-bans'), K.api('/admin/modlog'), K.api('/admin/security')]);
        if (!ctx.alive()) return;
        const KIND = { kufur: 'Küfür', tehdit: 'Tehdit', bilgi: 'Kişisel bilgi', baglanti: 'Bağlantı' };
        body.innerHTML = `
          <div class="card"><b>Ağ başına hesap sınırı</b><p class="hint" style="margin:4px 0 10px">Aynı IP / ağdan en fazla bu kadar hesap açılabilir (varsayılan ${sc.defaultMaxPerIp}). Ortak Wi-Fi veya mobil operatör ağlarında birçok kişi aynı IP'yi paylaşabilir; çok kişiyi engellerse artır.</p>
            <div class="row"><input class="input" id="sc-max" type="number" min="0" max="50" value="${sc.maxPerIp || ''}" placeholder="${sc.defaultMaxPerIp}"><button class="btn primary sm" id="sc-save">Kaydet</button></div></div>
          <div class="card"><b>Özel yasaklı kelimeler</b><p class="hint" style="margin:4px 0 10px">Yerleşik küfür/tehdit listesine ek olarak; virgülle ya da satır satır yaz.</p>
            <textarea class="input" id="sc-words" rows="3" maxlength="3000" placeholder="kelime1, kelime2">${esc((sc.badWords || []).join(', '))}</textarea>
            <button class="btn primary sm" id="sc-words-save" style="margin-top:8px">Listeyi kaydet</button></div>
          <div class="section-title">IP yasakları (${ib.bans.length})</div>
          <div class="card"><div class="row" style="flex-wrap:wrap;gap:8px"><input class="input grow" id="ip-u" placeholder="Kullanıcı adı (son IP'si yasaklanır)" maxlength="30"><input class="input" id="ip-d" type="number" min="0" max="3650" placeholder="Gün (boş = süresiz)" style="max-width:150px"></div>
            <input class="input" id="ip-r" placeholder="Neden (isteğe bağlı)" maxlength="120" style="margin-top:8px">
            <button class="btn danger sm" id="ip-add" style="margin-top:8px">IP yasağı ekle</button></div>
          ${ib.bans.length ? ib.bans.map((x) => `<div class="list-item" data-id="${esc(x.id)}"><span class="grow"><span class="title" style="font-size:14px">IP ${esc(x.ip)}${x.username ? ' · @' + esc(x.username) : ''}</span><span class="sub" style="display:block">${esc(x.reason || '—')} · ${x.until ? new Date(x.until).toLocaleString('tr-TR') + ' tarihine kadar' : 'süresiz'}</span></span><button class="btn sm" data-ipdel>Kaldır</button></div>`).join('') : '<p class="hint center" style="padding:10px">Yasaklı IP yok.</p>'}
          <div class="section-title">Filtreye takılanlar (son 100)</div>
          ${ml.items.length ? ml.items.map((x) => `<div class="list-item"><span class="grow"><span class="title" style="font-size:14px">${x.user ? '@' + esc(x.user.username) : 'silinmiş hesap'} · ${esc(KIND[x.kind] || x.kind)} · ${esc(x.where)}</span><span class="sub" style="display:block">${esc(x.snippet)} · ${K.timeAgo(x.createdAt)}</span></span></div>`).join('') : '<p class="hint center" style="padding:10px">Henüz engellenen içerik yok.</p>'}`;
        $('#sc-save', body).onclick = () => K.api('/admin/security', { method: 'POST', body: { maxPerIp: $('#sc-max', body).value } }).then(() => K.toast('Kaydedildi', 'ok')).catch(K.fail);
        $('#sc-words-save', body).onclick = () => K.api('/admin/security', { method: 'POST', body: { badWords: $('#sc-words', body).value } }).then(() => K.toast('Liste kaydedildi', 'ok')).catch(K.fail);
        $('#ip-add', body).onclick = () =>
          K.api('/admin/ip-bans', { method: 'POST', body: { username: $('#ip-u', body).value, days: $('#ip-d', body).value, reason: $('#ip-r', body).value } })
            .then(() => (K.toast('IP yasağı eklendi', 'ok'), safety()))
            .catch(K.fail);
        if (!body._ipdel) {
          body._ipdel = true; // yetki devri tek kez bağlanır (safety() yeniden çağrılabilir)
          K.on(body, 'click', '[data-ipdel]', (b) =>
            K.api(`/admin/ip-bans/${b.closest('[data-id]').dataset.id}`, { method: 'DELETE' }).then(() => (K.toast('Yasak kaldırıldı', 'ok'), safety())).catch(K.fail)
          );
        }
      }

      /* ---- sistem ---- */
      async function system() {
        const [s, l] = await Promise.all([K.api('/admin/stats'), K.api('/admin/logs')]);
        if (!ctx.alive()) return;
        body.innerHTML = `<div class="card"><b>Duyuru</b><p class="hint" style="margin:4px 0 10px">Tüm kullanıcılara üstte gösterilir.</p>
            <div class="row"><input class="input" id="an" maxlength="200" placeholder="Duyuru metni" value="${esc(s.announcement)}"><button class="btn primary sm" id="an-set">Yayınla</button></div>
            ${s.announcement ? '<button class="btn sm ghost" id="an-del" style="margin-top:8px">Duyuruyu kaldır</button>' : ''}</div>
          <div class="card"><div class="row"><div class="grow"><b>Bakım modu</b><p class="hint">Açıkken yöneticiler dışındaki herkes için site kapanır.</p></div><button class="switch ${s.maintenance ? 'on' : ''}" id="mm" role="switch" aria-label="Bakım modu"></button></div></div>
          <div class="card"><b>Yedek</b><p class="hint" style="margin:4px 0 10px">Kullanıcılar, videolar, yorumlar ve şikayetler JSON olarak indirilir (şifreler dahil değildir).</p><a class="btn sm" href="/api/admin/backup" download>${icon('download', 'sm')} Yedeği indir</a></div>
          <div class="section-title">Yönetici işlem kayıtları</div>
          ${l.logs.length ? l.logs.map((x) => `<div class="list-item"><span class="grow"><span class="title" style="font-size:14px">${esc(x.action)}</span><span class="sub" style="display:block">@${esc(x.admin)} · ${K.timeAgo(x.createdAt)}${x.details ? ' · ' + esc(x.details) : ''}</span></span></div>`).join('') : K.empty('clock', 'Kayıt yok')}`;
        $('#an-set', body).onclick = async () => {
          try {
            await K.api('/admin/announcement', { method: 'POST', body: { text: $('#an', body).value } });
            K.toast('Duyuru yayınlandı', 'ok');
            system();
          } catch (e) {
            K.fail(e);
          }
        };
        const del = $('#an-del', body);
        if (del) del.onclick = () => K.api('/admin/announcement', { method: 'DELETE' }).then(system).catch(K.fail);
        $('#mm', body).onclick = async (e) => {
          const btn = e.currentTarget;
          const on = !btn.classList.contains('on');
          if (on && !(await K.confirm({ title: 'Bakım modu açılsın mı?', text: 'Yöneticiler dışındaki herkes siteye erişemez.', ok: 'Aç', danger: true }))) return;
          try {
            await K.api('/admin/maintenance', { method: 'POST', body: { on } });
            btn.classList.toggle('on', on);
          } catch (err) {
            K.fail(err);
          }
        };
      }

      show();
    },
    { nav: 'me' }
  );
})();
