/* Klipo video yükleme: önizleme, kapak üretimi, ilerleme çubuğu */
(function () {
  'use strict';
  const K = window.K;
  const { esc, icon, $, $$ } = K;

  // Videonun belirli bir karesinden JPEG kapak üretir (tarayıcıda; sunucuya ek yük binmez)
  function makePoster(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const vid = document.createElement('video');
      vid.muted = true;
      vid.playsInline = true;
      vid.preload = 'metadata';
      let done = false;
      const finish = (blob, duration) => {
        if (done) return;
        done = true;
        URL.revokeObjectURL(url);
        resolve({ blob, duration: duration || 0 });
      };
      const timeout = setTimeout(() => finish(null, 0), 8000);
      vid.onerror = () => {
        clearTimeout(timeout);
        finish(null, 0);
      };
      vid.onloadedmetadata = () => {
        vid.currentTime = Math.min(0.5, (vid.duration || 1) / 4);
      };
      vid.onseeked = () => {
        clearTimeout(timeout);
        try {
          const w = 360;
          const h = Math.round((w * (vid.videoHeight || 640)) / (vid.videoWidth || 360));
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          c.getContext('2d').drawImage(vid, 0, 0, w, h);
          c.toBlob((b) => finish(b, vid.duration), 'image/jpeg', 0.78);
        } catch (e) {
          finish(null, vid.duration);
        }
      };
      vid.src = url;
    });
  }

  K.route(
    '/upload',
    async (ctx) => {
      const v = ctx.view;
      let file = null;
      let poster = null;
      let duration = 0;
      let visibility = K.me.isPrivate ? 'followers' : 'public';
      let previewUrl = '';
      let xhrBusy = false;

      v.innerHTML = `<div class="topbar"><button class="icon-btn" data-back aria-label="Geri">${icon('back')}</button><h1>Video yükle</h1><span class="spacer"></span></div>
        <div class="page col" id="up"></div>`;
      K.on(v, 'click', '[data-back]', () => K.back('/'));
      const box = $('#up', v);
      K.on(box, 'click', '[data-change]', () => {
        if (!xhrBusy) picker();
      });
      K.on(box, 'click', '#vis button', (b) => {
        visibility = b.dataset.v;
        $$('#vis button', box).forEach((x) => x.classList.toggle('active', x === b));
      });

      function picker() {
        box.innerHTML = `<label class="drop" style="cursor:pointer"><div class="col" style="align-items:center">${icon('video')}<b style="font-size:17px">Videonu seç</b>
          <span class="muted">MP4, MOV veya WebM · en fazla ${K.config.maxVideoMB} MB</span><span class="btn primary" style="margin-top:6px">Dosya seç</span></div>
          <input type="file" id="vf" accept="video/*" hidden></label>
          <label class="btn block" style="cursor:pointer">${icon('camera', 'sm')} Kamerayla çek<input type="file" id="vc" accept="video/*" capture="environment" hidden></label>`;
        const onFile = (e) => {
          const f = e.target.files[0];
          if (f) choose(f);
        };
        $('#vf', box).onchange = onFile;
        $('#vc', box).onchange = onFile;
      }

      async function choose(f) {
        if (!f.type.startsWith('video/') && !/\.(mp4|mov|m4v|webm|3gp)$/i.test(f.name)) return K.toast('Lütfen bir video dosyası seç', 'error');
        if (f.size > K.config.maxVideoMB * 1048576) return K.toast(`Video en fazla ${K.config.maxVideoMB} MB olabilir (seçtiğin: ${(f.size / 1048576).toFixed(1)} MB)`, 'error');
        file = f;
        box.innerHTML = K.spinner();
        const p = await makePoster(f);
        if (!ctx.alive()) return;
        poster = p.blob;
        duration = p.duration;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = URL.createObjectURL(f);
        form();
      }

      function form() {
        box.innerHTML = `<div class="preview"><video src="${previewUrl}" controls playsinline muted loop></video></div>
          <div class="muted center" style="font-size:13px">${esc(file.name)} · ${(file.size / 1048576).toFixed(1)} MB${duration ? ' · ' + Math.round(duration) + ' sn' : ''} <button data-change style="color:var(--brand);font-weight:600;margin-left:6px">Değiştir</button></div>
          <label class="field"><span>Açıklama</span><textarea class="input" id="cap" maxlength="300" placeholder="Videoyu anlat… #etiket ve @bahset ekleyebilirsin"></textarea><span class="hint" id="capn">0 / 300</span></label>
          <label class="field"><span>Müzik / ses adı (isteğe bağlı)</span><input class="input" id="song" maxlength="60" placeholder="Orijinal ses"></label>
          <div class="field"><span>Kimler izleyebilir?</span><div class="seg" id="vis">
            <button data-v="public" class="${visibility === 'public' ? 'active' : ''}">Herkes</button>
            <button data-v="followers" class="${visibility === 'followers' ? 'active' : ''}">Takipçiler</button>
            <button data-v="private" class="${visibility === 'private' ? 'active' : ''}">Yalnızca ben</button></div></div>
          <div class="row"><span class="grow">Yorumlara izin ver</span><button class="switch on" id="allow" aria-label="Yorumlar"></button></div>
          <div id="prog" class="hidden"><div class="progress"><i></i></div><div class="hint center" id="progt" style="margin-top:6px"></div></div>
          <button class="btn primary block" id="send">Paylaş</button>`;
        const vid = $('video', box);
        vid.play().catch(() => {});
        $('#cap', box).addEventListener('input', (e) => ($('#capn', box).textContent = e.target.value.length + ' / 300'));
        $('#allow', box).onclick = (e) => e.currentTarget.classList.toggle('on');
        $('#send', box).onclick = send;
      }

      async function send() {
        if (xhrBusy) return;
        const btn = $('#send', box);
        const fd = new FormData();
        fd.append('video', file, file.name);
        if (poster) fd.append('poster', poster, 'poster.jpg');
        fd.append('caption', $('#cap', box).value);
        fd.append('song', $('#song', box).value);
        fd.append('visibility', visibility);
        fd.append('allowComments', $('#allow', box).classList.contains('on') ? '1' : '0');
        fd.append('duration', String(Math.round(duration || 0)));
        btn.disabled = true;
        xhrBusy = true;
        $('#prog', box).classList.remove('hidden');
        const bar = $('#prog i', box);
        const label = $('#progt', box);
        try {
          const r = await K.api('/videos', {
            method: 'POST',
            form: fd,
            onProgress: (p) => {
              bar.style.width = Math.round(p * 100) + '%';
              label.textContent = p < 1 ? `Yükleniyor… %${Math.round(p * 100)}` : 'İşleniyor…';
            },
          });
          K.toast('Videon paylaşıldı!', 'ok');
          xhrBusy = false;
          K.go('/v/' + r.video.id);
        } catch (e) {
          xhrBusy = false;
          btn.disabled = false;
          $('#prog', box).classList.add('hidden');
          K.fail(e);
        }
      }

      picker();
      return () => {
        if (previewUrl) URL.revokeObjectURL(previewUrl);
      };
    },
    { nav: 'upload', hideNav: false }
  );
})();
