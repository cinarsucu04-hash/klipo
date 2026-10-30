/* Klipo video efektleri: yazı katmanları ve arka plan müziği (video dosyasına işlenmez; oynatılırken birleştirilir) */
(function () {
  'use strict';
  const K = window.K;
  const { esc } = K;

  const SIZES = { sm: 4.4, md: 6.4, lg: 9 }; // kutu genişliğinin yüzdesi
  K.fx = {
    COLORS: ['#ffffff', '#000000', '#ff3d81', '#8b5cf6', '#c8ff3d', '#ffd84a', '#3dd6ff', '#ff7a45'],
    SIZES,
  };

  // Video filtreleri: kimlik → CSS (sunucu yalnızca bu kimlikleri kabul eder). Dosyaya işlenmez, oynatırken uygulanır.
  K.fx.FILTERS = [
    ['', 'Normal', ''],
    ['canli', 'Canlı', 'saturate(1.45) contrast(1.1)'],
    ['sicak', 'Sıcak', 'sepia(.28) saturate(1.3) hue-rotate(-8deg)'],
    ['soguk', 'Soğuk', 'hue-rotate(18deg) saturate(1.1) brightness(1.04)'],
    ['siyahbeyaz', 'Siyah-beyaz', 'grayscale(1) contrast(1.1)'],
    ['nostalji', 'Nostalji', 'sepia(.55) contrast(.92) brightness(1.05)'],
    ['dramatik', 'Dramatik', 'contrast(1.3) saturate(.9) brightness(.92)'],
    ['parlak', 'Parlak', 'brightness(1.15) contrast(1.05) saturate(1.1)'],
  ];
  K.fx.filterCss = (id) => {
    const f = K.fx.FILTERS.find((x) => x[0] === id);
    return f ? f[2] : '';
  };

  // Düet: ikinci (orijinal) videoyu ana videoyla eşzamanlı oynatır
  K.fx.duetSync = function (vid, o) {
    let alive = true;
    o.loop = true;
    const sync = (force) => {
      if (!alive) return;
      if (vid.paused || vid.seeking || vid.readyState < 3) {
        if (!o.paused) o.pause();
        return;
      }
      if (o.paused) o.play().catch(() => {});
      let target = vid.currentTime;
      if (o.duration && isFinite(o.duration)) target = target % o.duration;
      if (force === true || Math.abs(o.currentTime - target) > 0.45) {
        try { o.currentTime = target; } catch (e) { /* henüz hazır değil */ }
      }
    };
    const mute = () => {
      o.muted = vid.muted;
      try { o.volume = 0.6; } catch (e) { /* iOS'ta ses düzeyi salt okunur */ }
      o.playbackRate = vid.playbackRate || 1;
    };
    const onTime = () => sync();
    const onPlay = () => sync(true);
    const onPause = () => { if (!o.paused) o.pause(); };
    vid.addEventListener('timeupdate', onTime);
    vid.addEventListener('playing', onPlay);
    vid.addEventListener('seeked', onPlay);
    vid.addEventListener('pause', onPause);
    vid.addEventListener('waiting', onPause);
    vid.addEventListener('volumechange', mute);
    vid.addEventListener('ratechange', mute);
    mute();
    sync(true);
    return {
      destroy() {
        alive = false;
        vid.removeEventListener('timeupdate', onTime);
        vid.removeEventListener('playing', onPlay);
        vid.removeEventListener('seeked', onPlay);
        vid.removeEventListener('pause', onPause);
        vid.removeEventListener('waiting', onPause);
        vid.removeEventListener('volumechange', mute);
        vid.removeEventListener('ratechange', mute);
        o.pause();
      },
    };
  };

  // Rengin açık/koyu olduğuna göre okunur yazı rengi
  function ink(hex) {
    const n = parseInt(String(hex).slice(1), 16);
    const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return lum > 0.6 ? '#000000' : '#ffffff';
  }

  // Tek bir yazı katmanının HTML'i (konum yüzde olarak)
  K.fx.overlayEl = function (o, i) {
    const size = SIZES[o.s] || SIZES.md;
    const color = /^#[0-9a-f]{6}$/i.test(o.c || '') ? o.c : '#ffffff';
    const css = `left:${(o.x * 100).toFixed(2)}%;top:${(o.y * 100).toFixed(2)}%;font-size:${size}cqw;` +
      (o.bg ? `background:${color};color:${ink(color)};` : `color:${color};`);
    return `<span class="ov${o.bg ? ' has-bg' : ''}" data-oi="${i}" style="${css}">${esc(o.t)}</span>`;
  };

  K.fx.layerHTML = function (overlays) {
    if (!overlays || !overlays.length) return '<div class="ov-layer"></div>';
    return `<div class="ov-layer">${overlays.map((o, i) => K.fx.overlayEl(o, i)).join('')}</div>`;
  };

  /**
   * Videoyla eşzamanlı ses çalar.
   * snd: { url, vol (müzik 0-1), orig (videonun kendi sesi 0-1) }; döndürdüğü nesne: { apply(), destroy() }
   */
  K.fx.sound = function (vid, snd) {
    const a = new Audio();
    a.preload = 'auto';
    a.loop = true;
    a.src = snd.url;
    let alive = true;

    const clamp = (n) => Math.min(1, Math.max(0, Number(n) || 0));
    function apply() {
      if (!alive) return;
      try { vid.volume = clamp(snd.orig === undefined ? 1 : snd.orig); } catch (e) { /* iOS'ta ses düzeyi salt okunur */ }
      a.volume = clamp(snd.vol === undefined ? 0.8 : snd.vol);
      a.muted = vid.muted;
      a.playbackRate = vid.playbackRate || 1;
    }
    function sync(force) {
      if (!alive) return;
      if (vid.paused || vid.seeking || vid.readyState < 3) {
        if (!a.paused) a.pause();
        return;
      }
      if (a.paused) a.play().catch(() => {});
      let target = vid.currentTime;
      if (a.duration && isFinite(a.duration)) target = target % a.duration;
      if (force === true || Math.abs(a.currentTime - target) > 0.35) {
        try { a.currentTime = target; } catch (e) { /* henüz hazır değil */ }
      }
    }
    const onVol = () => apply();
    const onTime = () => sync();
    const onPlay = () => sync(true);
    const onPause = () => { if (!a.paused) a.pause(); };
    vid.addEventListener('volumechange', onVol);
    vid.addEventListener('ratechange', onVol);
    vid.addEventListener('timeupdate', onTime);
    vid.addEventListener('playing', onPlay);
    vid.addEventListener('seeked', onPlay);
    vid.addEventListener('pause', onPause);
    vid.addEventListener('waiting', onPause);
    apply();
    sync(true);

    return {
      apply,
      destroy() {
        if (!alive) return;
        alive = false;
        vid.removeEventListener('volumechange', onVol);
        vid.removeEventListener('timeupdate', onTime);
        vid.removeEventListener('playing', onPlay);
        vid.removeEventListener('seeked', onPlay);
        vid.removeEventListener('pause', onPause);
        vid.removeEventListener('waiting', onPause);
        a.pause();
        a.removeAttribute('src');
        a.load();
        try { vid.volume = 1; } catch (e) { /* yoksay */ }
      },
    };
  };
})();
