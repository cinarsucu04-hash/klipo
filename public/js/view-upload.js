/* Klipo video yükleme ve düzenleme: yazı ekleme, ses/şarkı seçme, kapak üretimi, ilerleme çubuğu */
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
      let overlays = []; // {t, x, y, c, s, bg} — x/y kutunun yüzdesi (0-1)
      let sound = null; // {id, name, url, vol, orig}
      if (ctx.query && ctx.query.sound) {
        // "Bu sesi kullan" ile gelindi: sesi önceden seç
        try {
          const r = await K.api(`/videos/by-sound/${encodeURIComponent(ctx.query.sound)}?page=0`);
          if (r.sound) sound = { id: r.sound.id, name: r.sound.name, url: r.sound.url, vol: 0.8, orig: 0.3 };
        } catch (e) { /* ses yoksa boş geç */ }
      }
      let filter = ''; // video filtresi kimliği (K.fx.FILTERS)
      let duetOrig = null; // düet yapılan özgün video
      let dsync = null;
      if (ctx.query && ctx.query.duet) {
        try {
          const r = await K.api(`/videos/${encodeURIComponent(ctx.query.duet)}`);
          const o = r.video;
          if (o.visibility !== 'public' || o.allowDuet === false || o.duet || o.mine) throw new Error('Bu videoyla düet yapılamıyor.');
          duetOrig = o;
        } catch (e) {
          K.toast(e.message || 'Düet için video açılamadı', 'error');
          return K.go('/', true);
        }
      }
      let sfx = null;
      const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
      const fmt = (sec) => (sec ? `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}` : '');

      v.innerHTML = `<div class="topbar"><button class="icon-btn" data-back aria-label="Geri">${icon('back')}</button><h1>${duetOrig ? 'Düet yap' : 'Video yükle'}</h1><span class="spacer"></span></div>
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
        if (sfx) {
          sfx.destroy();
          sfx = null;
        }
        if (dsync) {
          dsync.destroy();
          dsync = null;
        }
        box.innerHTML = `<div class="editor${duetOrig ? ' duet' : ''}" id="ed"><video src="${previewUrl}" playsinline muted loop autoplay></video>${duetOrig ? `<video class="duet-orig" src="${esc(duetOrig.mediaUrl)}" playsinline muted loop></video>` : ''}${K.fx.layerHTML([])}
            <button class="mute-btn" id="mutebtn" aria-label="Sesi aç/kapat"></button></div>
          <div class="tools">
            <button class="chip" id="addtext"><b>Aa</b> Yazı ekle</button>
            <button class="chip" id="addsound">${icon('music', 'sm')} <span id="sndlbl">Ses ekle</span></button>
          </div>
          ${duetOrig ? `<div class="hint center" style="margin-top:-4px">Düet · @${esc(duetOrig.user.username)} videosunun yanında oynar</div>` : ''}
          <div class="chips" id="flt" aria-label="Filtreler">${K.fx.FILTERS.map((f) => `<button class="chip ${f[0] === filter ? 'active' : ''}" data-f="${f[0]}">${f[1]}</button>`).join('')}</div>
          <div class="hint center" style="margin-top:-4px">Yazıyı parmağınla sürükle, düzenlemek için dokun.</div>
          <div class="card sound-card hidden" id="sndcard" style="margin:0"></div>
          <div class="muted center" style="font-size:13px">${esc(file.name)} · ${(file.size / 1048576).toFixed(1)} MB${duration ? ' · ' + Math.round(duration) + ' sn' : ''} <button data-change style="color:var(--brand);font-weight:600;margin-left:6px">Değiştir</button></div>
          <label class="field"><span>Açıklama</span><textarea class="input" id="cap" maxlength="300" placeholder="Videoyu anlat… #etiket ve @bahset ekleyebilirsin"></textarea><span class="hint" id="capn">0 / 300</span></label>
          <label class="field" id="songrow"><span>Ses adı (isteğe bağlı)</span><input class="input" id="song" maxlength="60" placeholder="Orijinal ses"></label>
          <div class="field"><span>Kimler izleyebilir?</span><div class="seg" id="vis">
            <button data-v="public" class="${visibility === 'public' ? 'active' : ''}">Herkes</button>
            <button data-v="followers" class="${visibility === 'followers' ? 'active' : ''}">Takipçiler</button>
            <button data-v="private" class="${visibility === 'private' ? 'active' : ''}">Yalnızca ben</button></div></div>
          <div class="row"><span class="grow">Yorumlara izin ver</span><button class="switch on" id="allow" aria-label="Yorumlar"></button></div>
          ${duetOrig ? '' : '<div class="row"><span class="grow">Düete izin ver</span><button class="switch on" id="allowduet" aria-label="Düet"></button></div>'}
          <div class="row"><span class="grow">Başkaları indirebilsin</span><button class="switch on" id="allowdl" aria-label="İndirme"></button></div>
          <div id="prog" class="hidden"><div class="progress"><i></i></div><div class="hint center" id="progt" style="margin-top:6px"></div></div>
          <button class="btn primary block" id="send">Paylaş</button>`;
        const vid = $('video', box);
        const ed = $('#ed', box);
        const layer = $('.ov-layer', ed);
        vid.play().catch(() => {});
        vid.style.filter = K.fx.filterCss(filter);
        if (duetOrig) dsync = K.fx.duetSync(vid, $('.duet-orig', ed));
        K.on($('#flt', box), 'click', '[data-f]', (b) => {
          filter = b.dataset.f;
          vid.style.filter = K.fx.filterCss(filter);
          $$('#flt .chip', box).forEach((x) => x.classList.toggle('active', x === b));
        });
        $('#cap', box).addEventListener('input', (e) => ($('#capn', box).textContent = e.target.value.length + ' / 300'));
        $('#allow', box).onclick = (e) => e.currentTarget.classList.toggle('on');
        $('#allowdl', box).onclick = (e) => e.currentTarget.classList.toggle('on');
        const adSw = $('#allowduet', box);
        if (adSw) adSw.onclick = (e) => e.currentTarget.classList.toggle('on');
        $('#send', box).onclick = send;

        const muteBtn = $('#mutebtn', box);
        const paintMute = () => (muteBtn.innerHTML = icon(vid.muted ? 'mute' : 'volume'));
        paintMute();
        muteBtn.onclick = () => {
          vid.muted = !vid.muted;
          paintMute();
        };

        function renderOv() {
          layer.innerHTML = overlays.map((o, i) => K.fx.overlayEl(o, i)).join('');
        }
        renderOv();

        // yazıyı sürükle (kaydırma) ya da dokunarak düzenle
        ed.addEventListener('pointerdown', (e) => {
          const el = e.target.closest('.ov');
          if (!el) return;
          const i = Number(el.dataset.oi);
          const o = overlays[i];
          if (!o) return;
          e.preventDefault();
          const rect = ed.getBoundingClientRect();
          const start = { x: e.clientX, y: e.clientY, ox: o.x, oy: o.y };
          let moved = false;
          try { el.setPointerCapture(e.pointerId); } catch (err) { /* yoksay */ }
          const move = (ev) => {
            if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 6) moved = true;
            if (!moved) return;
            o.x = clamp(start.ox + (ev.clientX - start.x) / rect.width, 0.05, 0.95);
            o.y = clamp(start.oy + (ev.clientY - start.y) / rect.height, 0.05, 0.95);
            el.style.left = (o.x * 100).toFixed(2) + '%';
            el.style.top = (o.y * 100).toFixed(2) + '%';
          };
          const end = (ev) => {
            el.removeEventListener('pointermove', move);
            el.removeEventListener('pointerup', end);
            el.removeEventListener('pointercancel', end);
            if (!moved && ev.type === 'pointerup') editText(i);
          };
          el.addEventListener('pointermove', move);
          el.addEventListener('pointerup', end);
          el.addEventListener('pointercancel', end);
        });
        // boş alana dokununca oynat/durdur
        ed.addEventListener('click', (e) => {
          if (e.target.closest('.ov, .mute-btn')) return;
          if (vid.paused) vid.play().catch(() => {});
          else vid.pause();
        });

        /* ---- yazı ekle / düzenle ---- */
        function editText(i) {
          const isNew = i < 0;
          if (isNew && overlays.length >= 8) return K.toast('En fazla 8 yazı ekleyebilirsin', 'error');
          const o = isNew ? { t: '', x: 0.5, y: 0.42, c: '#ffffff', s: 'md', bg: false } : overlays[i];
          let added = !isNew;
          const swatches = K.fx.COLORS.map((c) => `<button class="swatch" data-c="${c}" style="background:${c}" aria-label="Renk ${c}"></button>`).join('');
          K.sheet({
            title: isNew ? 'Yazı ekle' : 'Yazıyı düzenle',
            html: `<div class="col" style="padding:2px 2px 8px;gap:12px">
              <textarea class="input" id="ovt" maxlength="60" rows="2" placeholder="Bir şeyler yaz…">${esc(o.t)}</textarea>
              <div class="swatches" id="ovc">${swatches}</div>
              <div class="seg" id="ovs"><button data-s="sm">Küçük</button><button data-s="md">Orta</button><button data-s="lg">Büyük</button></div>
              <div class="row"><span class="grow">Arka plan</span><button class="switch" id="ovb" aria-label="Arka plan"></button></div></div>`,
            foot: `<div class="row" style="gap:8px">${isNew ? '' : '<button class="btn danger" id="ovdel">Sil</button>'}<button class="btn primary grow" id="ovok">Tamam</button></div>`,
            onClose: () => {
              o.t = o.t.trim();
              if (!o.t) overlays = overlays.filter((x) => x !== o);
              renderOv();
            },
            onMount: (api) => {
              const ta = $('#ovt', api.el);
              const paintCtl = () => {
                $$('#ovc .swatch', api.el).forEach((b) => b.classList.toggle('active', b.dataset.c === o.c));
                $$('#ovs button', api.el).forEach((b) => b.classList.toggle('active', b.dataset.s === o.s));
                $('#ovb', api.el).classList.toggle('on', !!o.bg);
              };
              const commit = () => {
                if (!added && o.t.trim()) {
                  overlays.push(o);
                  added = true;
                }
                renderOv();
              };
              paintCtl();
              ta.addEventListener('input', () => {
                o.t = ta.value;
                commit();
              });
              K.on(api.el, 'click', '#ovc .swatch', (b) => {
                o.c = b.dataset.c;
                paintCtl();
                commit();
              });
              K.on(api.el, 'click', '#ovs button', (b) => {
                o.s = b.dataset.s;
                paintCtl();
                commit();
              });
              $('#ovb', api.el).onclick = () => {
                o.bg = !o.bg;
                paintCtl();
                commit();
              };
              $('#ovok', api.el).onclick = api.close;
              const del = $('#ovdel', api.el);
              if (del) del.onclick = () => {
                o.t = '';
                api.close();
              };
              setTimeout(() => ta.focus(), 80);
            },
          });
        }
        $('#addtext', box).onclick = () => editText(-1);

        /* ---- ses / şarkı ---- */
        function paintSound() {
          if (sfx) {
            sfx.destroy();
            sfx = null;
          }
          const card = $('#sndcard', box);
          if (!sound) {
            card.classList.add('hidden');
            $('#sndlbl', box).textContent = 'Ses ekle';
            $('#songrow', box).classList.remove('hidden');
            return;
          }
          $('#sndlbl', box).textContent = 'Sesi değiştir';
          $('#songrow', box).classList.add('hidden');
          card.classList.remove('hidden');
          card.innerHTML = `<div class="row" style="gap:10px">${icon('music')}<b class="grow ellipsis">${esc(sound.name)}</b><button class="btn sm ghost" id="sndrm">Kaldır</button></div>
            <label class="slide"><span>Müzik</span><input type="range" min="0" max="100" value="${Math.round(sound.vol * 100)}" id="svol"></label>
            <label class="slide"><span>Videonun sesi</span><input type="range" min="0" max="100" value="${Math.round(sound.orig * 100)}" id="sorig"></label>`;
          $('#sndrm', box).onclick = () => {
            sound = null;
            paintSound();
          };
          $('#svol', box).oninput = (e) => {
            sound.vol = e.target.value / 100;
            if (sfx) sfx.apply();
          };
          $('#sorig', box).oninput = (e) => {
            sound.orig = e.target.value / 100;
            if (sfx) sfx.apply();
          };
          vid.muted = false;
          paintMute();
          sfx = K.fx.sound(vid, sound);
          vid.play().catch(() => {
            vid.muted = true;
            paintMute();
          });
        }
        paintSound();
        $('#addsound', box).onclick = () => openSounds((picked) => {
          sound = { id: picked.id, name: picked.name, url: picked.url, vol: 0.8, orig: 0.3 };
          paintSound();
        });
      }

      // Ses seçici: hazır sesler, en çok kullanılanlar ve kendi dosyanı yükleme
      function openSounds(onPick) {
        const pv = new Audio();
        let playing = '';
        let q = '';
        let page = 0;
        let more = false;
        let items = [];
        let timer = null;
        let sh = null;
        const stop = () => {
          pv.pause();
          playing = '';
        };
        pv.onended = () => {
          playing = '';
          draw();
        };
        function draw(append) {
          const list = $('#slist', sh.el);
          if (!list) return;
          if (!items.length && !append) {
            list.innerHTML = `<div class="muted center" style="padding:24px 0">${q ? 'Bu aramayla ses bulunamadı' : 'Henüz ses yok'}</div>`;
            return;
          }
          list.innerHTML =
            items
              .map((it) => {
                const mine = it.user && (it.user.id === K.me.id || K.me.role === 'admin');
                return `<div class="snd ${sound && sound.id === it.id ? 'sel' : ''}">
                  <button class="play" data-play="${esc(it.id)}" aria-label="Dinle">${playing === it.id ? '<i class="pause"></i>' : icon('play', 'sm')}</button>
                  <button class="meta" data-pick="${esc(it.id)}"><b class="ellipsis">${esc(it.name)}</b><span class="hint ellipsis">${it.builtin ? 'Hazır ses' : '@' + esc(it.user ? it.user.username : '')} · ${it.builtin ? fmt(it.duration) : it.uses + ' video'}</span></button>
                  ${mine ? `<button class="icon-btn" data-del="${esc(it.id)}" aria-label="Sil">${icon('trash', 'sm')}</button>` : ''}</div>`;
              })
              .join('') + (more ? '<button class="btn block" data-more style="margin-top:10px">Daha fazla</button>' : '');
        }
        async function load(reset) {
          if (reset) {
            page = 0;
            items = [];
            $('#slist', sh.el).innerHTML = K.spinner();
          }
          try {
            const d = await K.api(`/sounds?page=${page}&q=${encodeURIComponent(q)}`);
            items = items.concat(d.items);
            more = d.more;
            page++;
            draw();
          } catch (e) {
            $('#slist', sh.el).innerHTML = `<div class="muted center" style="padding:24px 0">Sesler yüklenemedi</div>`;
          }
        }
        sh = K.sheet({
          title: 'Ses seç',
          tall: true,
          html: `<div class="col" style="gap:10px">
            <label class="btn block" style="cursor:pointer">${icon('plus', 'sm')} Kendi sesini yükle<input type="file" id="sfile" accept="audio/*,.mp3,.m4a,.ogg,.wav" hidden></label>
            <div class="hint center" style="margin-top:-4px">Yalnızca kullanım hakkına sahip olduğun sesleri yükle.</div>
            <input class="input" id="sq" placeholder="Ses ara…" maxlength="40">
            <div id="slist">${K.spinner()}</div></div>`,
          onClose: () => {
            clearTimeout(timer);
            stop();
            pv.removeAttribute('src');
          },
          onMount: (api) => {
            sh = api; // K.sheet henüz dönmeden yükleme başlar
            K.on(api.el, 'click', '[data-play]', (b) => {
              const it = items.find((x) => x.id === b.dataset.play);
              if (!it) return;
              if (playing === it.id) {
                stop();
              } else {
                pv.src = it.url;
                pv.play().catch(() => {});
                playing = it.id;
              }
              draw();
            });
            K.on(api.el, 'click', '[data-pick]', (b) => {
              const it = items.find((x) => x.id === b.dataset.pick);
              if (!it) return;
              api.close();
              onPick(it);
            });
            K.on(api.el, 'click', '[data-more]', () => load(false));
            K.on(api.el, 'click', '[data-del]', async (b) => {
              if (!(await K.confirm({ title: 'Ses silinsin mi?', text: 'Bu sesi kullanan videolar sessiz kalır.', ok: 'Sil', danger: true }))) return;
              try {
                await K.api('/sounds/' + b.dataset.del, { method: 'DELETE' });
                items = items.filter((x) => x.id !== b.dataset.del);
                if (sound && sound.id === b.dataset.del) {
                  sound = null;
                  paintSoundOutside();
                }
                draw();
              } catch (e) {
                K.fail(e);
              }
            });
            $('#sq', api.el).addEventListener('input', (e) => {
              clearTimeout(timer);
              timer = setTimeout(() => {
                q = e.target.value.trim();
                load(true);
              }, 300);
            });
            $('#sfile', api.el).onchange = async (e) => {
              const f = e.target.files[0];
              if (!f) return;
              if (f.size > (K.config.maxAudioMB || 8) * 1048576) return K.toast(`Ses dosyası en fazla ${K.config.maxAudioMB || 8} MB olabilir`, 'error');
              $('#slist', api.el).innerHTML = K.spinner();
              try {
                const dur = await new Promise((resolve) => {
                  const a = new Audio();
                  const u = URL.createObjectURL(f);
                  a.preload = 'metadata';
                  a.onloadedmetadata = () => { URL.revokeObjectURL(u); resolve(a.duration || 0); };
                  a.onerror = () => { URL.revokeObjectURL(u); resolve(0); };
                  setTimeout(() => resolve(0), 2500); // bazı biçimlerde olay hiç gelmez; süresiz bekleme
                  a.src = u;
                });
                const fd = new FormData();
                fd.append('audio', f, f.name);
                fd.append('name', f.name.replace(/\.[^.]+$/, '').slice(0, 60));
                fd.append('duration', String(Math.round(dur || 0)));
                const r = await K.api('/sounds', { method: 'POST', form: fd });
                api.close();
                onPick(r.sound);
              } catch (err) {
                K.fail(err);
                load(true);
              }
            };
            load(true);
          },
        });
      }
      // ses silindiğinde düzenleyiciyi güncelle (openSounds içinden çağrılır)
      function paintSoundOutside() {
        const rm = $('#sndrm', box);
        if (rm) rm.click();
      }

      async function send() {
        if (xhrBusy) return;
        const btn = $('#send', box);
        const fd = new FormData();
        fd.append('video', file, file.name);
        if (poster) fd.append('poster', poster, 'poster.jpg');
        fd.append('caption', $('#cap', box).value);
        fd.append('song', sound ? sound.name : $('#song', box).value);
        if (sound) {
          fd.append('soundId', sound.id);
          fd.append('musicVol', String(sound.vol));
          fd.append('origVol', String(sound.orig));
        }
        if (overlays.length) fd.append('overlays', JSON.stringify(overlays));
        fd.append('visibility', visibility);
        fd.append('allowComments', $('#allow', box).classList.contains('on') ? '1' : '0');
        fd.append('allowDownload', $('#allowdl', box).classList.contains('on') ? '1' : '0');
        const adSw = $('#allowduet', box);
        if (adSw) fd.append('allowDuet', adSw.classList.contains('on') ? '1' : '0');
        if (filter) fd.append('filter', filter);
        if (duetOrig) fd.append('duetOf', duetOrig.id);
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
        if (sfx) sfx.destroy();
        if (dsync) dsync.destroy();
        if (previewUrl) URL.revokeObjectURL(previewUrl);
      };
    },
    { nav: 'upload', hideNav: false }
  );
})();
