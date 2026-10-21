/* Klipo çekirdek: yardımcılar, ikonlar, API, arayüz parçaları, yönlendirici */
(function () {
  'use strict';
  const K = (window.K = {
    me: null,
    csrf: '',
    config: { appName: 'Klipo', maxVideoMB: 60, maxImageMB: 8, reportReasons: [] },
    counters: { notifications: 0, messages: 0, requests: 0 },
    muted: false,
    feedType: 'foryou',
  });

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  K.$ = $;
  K.$$ = $$;

  /* ---------------- metin / biçim ---------------- */
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  K.esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);

  K.count = (n) => {
    n = Number(n) || 0;
    if (n < 1000) return String(n);
    const f = (v) => String(Math.round(v * 10) / 10).replace('.', ',');
    if (n < 1e6) return f(n / 1000) + ' B';
    return f(n / 1e6) + ' Mn';
  };

  const MONTHS = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
  K.timeAgo = (d) => {
    const t = new Date(d).getTime();
    if (!t) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 45) return 'az önce';
    if (s < 3600) return Math.round(s / 60) + ' dk';
    if (s < 86400) return Math.round(s / 3600) + ' sa';
    if (s < 7 * 86400) return Math.round(s / 86400) + ' gün';
    if (s < 30 * 86400) return Math.round(s / (7 * 86400)) + ' hf';
    const x = new Date(t);
    return `${x.getDate()} ${MONTHS[x.getMonth()]}${x.getFullYear() !== new Date().getFullYear() ? ' ' + x.getFullYear() : ''}`;
  };
  K.clock = (d) => {
    const x = new Date(d);
    return String(x.getHours()).padStart(2, '0') + ':' + String(x.getMinutes()).padStart(2, '0');
  };
  K.dayLabel = (d) => {
    const x = new Date(d);
    const today = new Date();
    const key = (v) => v.getFullYear() * 400 + v.getMonth() * 32 + v.getDate();
    const y = new Date(today.getTime() - 86400000);
    if (key(x) === key(today)) return 'Bugün';
    if (key(x) === key(y)) return 'Dün';
    return `${x.getDate()} ${MONTHS[x.getMonth()]} ${x.getFullYear()}`;
  };

  // Metni güvenli biçimde kaçırıp #etiket ve @kullanıcı bağlantılarına dönüştürür
  K.linkify = (text) => {
    const s = String(text || '');
    const re = /(#[\p{L}\p{N}_]{1,40})|(?<![\w@])(@[a-z0-9_.]{3,24})/giu;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(s))) {
      let tok = m[0];
      if (tok[0] === '@') tok = tok.replace(/[._]+$/, '');
      if (tok.length < 2 || (tok[0] === '@' && tok.length < 4)) continue;
      out += K.esc(s.slice(last, m.index));
      const name = tok.slice(1).toLowerCase();
      out += tok[0] === '#' ? `<a href="#/tag/${encodeURIComponent(name)}">${K.esc(tok)}</a>` : `<a href="#/u/${K.esc(name)}">${K.esc(tok)}</a>`;
      last = m.index + tok.length;
      re.lastIndex = last;
    }
    return out + K.esc(s.slice(last));
  };

  /* ---------------- ikonlar ---------------- */
  const P = {
    home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
    compass: '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    inbox: '<path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path d="M22 6l-10 7L2 6"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    'user-plus': '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M20 8v6M23 11h-6"/>',
    heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
    comment: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    share: '<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4M12 2v13"/>',
    more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    back: '<path d="M15 18l-6-6 6-6"/>',
    next: '<path d="M9 18l6-6-6-6"/>',
    send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
    camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
    video: '<rect x="2" y="5" width="14" height="14" rx="2"/><path d="M22 8l-6 4 6 4z"/>',
    bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    trash: '<path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    'eye-off': '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22"/>',
    volume: '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>',
    mute: '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M23 9l-6 6M17 9l6 6"/>',
    play: '<polygon points="6 3 20 12 6 21 6 3"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    pin: '<path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
    grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    ban: '<circle cx="12" cy="12" r="10"/><path d="M4.93 4.93l14.14 14.14"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    hash: '<path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18"/>',
    sun: '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    megaphone: '<path d="M3 11v2a1 1 0 0 0 1 1h3l8 5V5L7 10H4a1 1 0 0 0-1 1z"/><path d="M19 8a5 5 0 0 1 0 8"/>',
    refresh: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  };
  K.icon = (name, cls) => `<svg class="icon ${cls || ''}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>`;
  K.verifiedBadge = () => '<svg class="verified" viewBox="0 0 24 24" aria-label="Doğrulanmış hesap"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const hue = (s) => {
    let h = 0;
    for (const c of String(s || '?')) h = (h * 31 + c.charCodeAt(0)) % 360;
    return h;
  };
  K.avatar = (u, size) => {
    u = u || {};
    if (u.avatar) return `<span class="avatar ${size || ''}"><img src="${K.esc(u.avatar)}" alt="" loading="lazy"></span>`;
    const ch = (u.nickname || u.username || '?').trim().charAt(0).toUpperCase();
    return `<span class="avatar ${size || ''}" style="background:hsl(${hue(u.username)} 52% 42%)">${K.esc(ch)}</span>`;
  };
  K.nameHTML = (u) => K.esc(u.nickname || u.username) + (u.verified ? K.verifiedBadge() : '');

  /* ---------------- DOM yardımcıları ---------------- */
  K.on = (root, type, selector, fn) =>
    root.addEventListener(type, (ev) => {
      const t = ev.target.closest(selector);
      if (t && root.contains(t)) fn(t, ev);
    });
  K.html = (el, html) => {
    el.innerHTML = html;
    return el;
  };
  K.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  K.debounce = (fn, ms) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };
  K.safe = (fn) => {
    try {
      return fn();
    } catch (e) {
      return null;
    }
  };
  K.store = {
    get: (k, d) => K.safe(() => localStorage.getItem('klipo.' + k)) || d,
    set: (k, v) => K.safe(() => localStorage.setItem('klipo.' + k, v)),
  };

  K.toast = (msg, type) => {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 3100);
  };

  K.copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (_) {}
      ta.remove();
      return ok;
    }
  };

  K.applyTheme = (theme) => {
    K.store.set('theme', theme);
    const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    const m = $('#meta-theme');
    if (m) m.setAttribute('content', dark ? '#0a0a0f' : '#ffffff');
  };

  /* ---------------- API ---------------- */
  class ApiError extends Error {
    constructor(status, message, code) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  K.ApiError = ApiError;

  function xhrSend(url, method, headers, body, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open(method, url);
      x.withCredentials = true;
      Object.keys(headers).forEach((h) => x.setRequestHeader(h, headers[h]));
      if (x.upload) x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      x.onload = () => resolve({ status: x.status, text: x.responseText });
      x.onerror = () => reject(new ApiError(0, 'Bağlantı hatası. İnternetini kontrol et.'));
      x.ontimeout = () => reject(new ApiError(0, 'İstek zaman aşımına uğradı.'));
      x.send(body);
    });
  }

  K.api = async function api(path, opts) {
    opts = opts || {};
    const method = (opts.method || 'GET').toUpperCase();
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') headers['X-CSRF-Token'] = K.csrf;
    let body;
    if (opts.form) body = opts.form;
    else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const url = '/api' + path;
    let res;
    try {
      if (opts.onProgress) res = await xhrSend(url, method, headers, body, opts.onProgress);
      else {
        const r = await fetch(url, { method, headers, body, credentials: 'same-origin', signal: opts.signal });
        res = { status: r.status, text: await r.text() };
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw e instanceof ApiError ? e : new ApiError(0, 'Bağlantı hatası. İnternetini kontrol et.');
    }
    let data = null;
    try {
      data = res.text ? JSON.parse(res.text) : {};
    } catch (e) {
      data = {};
    }
    if (res.status >= 200 && res.status < 300) return data;

    const err = new ApiError(res.status, data.error || 'Bir hata oluştu.', data.code);
    if (err.code === 'CSRF' && !opts._retried) {
      await K.refreshSession();
      // FormData tekrar gönderilebilir; JSON gövde de aynı kalır
      return api(path, Object.assign({}, opts, { _retried: true }));
    }
    if (err.code === 'AUTH' && K.me) {
      K.me = null;
      K.updateNav && K.updateNav();
      K.go('/login');
    }
    if (err.code === 'MAINTENANCE' && K.showMaintenance) K.showMaintenance(err.message);
    throw err;
  };

  K.refreshSession = async () => {
    const d = await K.api('/auth/me');
    K.csrf = d.csrf;
    K.me = d.user;
    K.config = Object.assign(K.config, d.config || {});
    return d;
  };

  K.fail = (e) => {
    if (e && e.name === 'AbortError') return;
    K.toast((e && e.message) || 'Bir hata oluştu.', 'error');
  };

  /* ---------------- overlay (sheet / modal) ---------------- */
  const stack = [];
  let ignorePop = 0;

  function overlays() {
    return $('#overlays');
  }
  function register(nodes) {
    const entry = { nodes, onClose: null };
    stack.push(entry);
    history.pushState({ klipoOverlay: stack.length }, '');
    return entry;
  }
  function destroyEntry(entry) {
    entry.nodes.forEach((n) => n.remove());
    if (entry.onClose) K.safe(entry.onClose);
  }
  function closeEntry(entry, viaPop) {
    const i = stack.indexOf(entry);
    if (i < 0) return;
    stack.splice(i, 1);
    destroyEntry(entry);
    if (!viaPop) {
      ignorePop++;
      history.back();
    }
  }
  K.closeAllOverlays = () => {
    while (stack.length) destroyEntry(stack.pop());
  };
  K.hasOverlay = () => stack.length > 0;
  window.addEventListener('popstate', () => {
    if (ignorePop > 0) {
      ignorePop--;
      return;
    }
    if (stack.length) closeEntry(stack[stack.length - 1], true);
  });

  // Tam ekran katman (ör. hikaye görüntüleyici); geri tuşu ile kapanır
  K.overlay = function (el, onClose) {
    overlays().appendChild(el);
    const entry = register([el]);
    entry.onClose = onClose;
    return { close: () => closeEntry(entry) };
  };

  // Sheet: alttan açılan panel
  K.sheet = function (o) {
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    const el = document.createElement('div');
    el.className = 'sheet' + (o.tall ? ' tall' : '');
    el.setAttribute('role', 'dialog');
    el.innerHTML =
      (o.title !== null ? `<div class="sheet-head"><span>${K.esc(o.title || '')}</span><button class="icon-btn x" data-close aria-label="Kapat">${K.icon('x')}</button></div>` : '') +
      `<div class="sheet-body">${o.html || ''}</div>` +
      (o.foot ? `<div class="sheet-foot">${o.foot}</div>` : '');
    overlays().append(scrim, el);
    const entry = register([scrim, el]);
    entry.onClose = o.onClose;
    const api = { el, body: $('.sheet-body', el), close: () => closeEntry(entry) };
    scrim.addEventListener('click', api.close);
    K.on(el, 'click', '[data-close]', api.close);
    if (o.onMount) o.onMount(api);
    return api;
  };

  // Seçenek menüsü: [{icon,label,danger,run}]
  K.menu = function (title, items) {
    const html = items
      .filter(Boolean)
      .map((it, i) => `<button class="menu-item ${it.danger ? 'danger' : ''}" data-i="${i}">${it.icon ? K.icon(it.icon) : ''}<span>${K.esc(it.label)}</span>${it.end ? `<span class="end">${K.esc(it.end)}</span>` : ''}</button>`)
      .join('');
    const list = items.filter(Boolean);
    const s = K.sheet({
      title,
      html,
      onMount: (api) =>
        K.on(api.el, 'click', '.menu-item', (b) => {
          const it = list[Number(b.dataset.i)];
          api.close();
          if (it && it.run) setTimeout(() => it.run(), 30);
        }),
    });
    return s;
  };

  K.confirm = (o) =>
    new Promise((resolve) => {
      const scrim = document.createElement('div');
      scrim.className = 'scrim';
      const el = document.createElement('div');
      el.className = 'modal';
      el.setAttribute('role', 'alertdialog');
      el.innerHTML = `<h3>${K.esc(o.title || 'Emin misin?')}</h3><p class="muted">${K.esc(o.text || '')}</p>
        <div class="actions"><button class="btn" data-no>${K.esc(o.cancel || 'Vazgeç')}</button><button class="btn ${o.danger ? 'danger' : 'primary'}" data-yes>${K.esc(o.ok || 'Tamam')}</button></div>`;
      overlays().append(scrim, el);
      const entry = register([scrim, el]);
      let answered = false;
      const done = (v) => {
        if (answered) return;
        answered = true;
        closeEntry(entry);
        resolve(v);
      };
      entry.onClose = () => {
        if (!answered) {
          answered = true;
          resolve(false);
        }
      };
      $('[data-no]', el).onclick = () => done(false);
      $('[data-yes]', el).onclick = () => done(true);
      scrim.onclick = () => done(false);
    });

  // Metin girişli küçük pencere
  K.ask = (o) =>
    new Promise((resolve) => {
      const scrim = document.createElement('div');
      scrim.className = 'scrim';
      const el = document.createElement('div');
      el.className = 'modal';
      el.innerHTML = `<h3>${K.esc(o.title || '')}</h3>${o.text ? `<p class="muted" style="margin-bottom:10px">${K.esc(o.text)}</p>` : ''}
        <input class="input" ${o.password ? 'type="password"' : 'type="text"'} maxlength="${o.max || 100}" placeholder="${K.esc(o.placeholder || '')}" value="${K.esc(o.value || '')}">
        <div class="actions"><button class="btn" data-no>Vazgeç</button><button class="btn ${o.danger ? 'danger' : 'primary'}" data-yes>${K.esc(o.ok || 'Tamam')}</button></div>`;
      overlays().append(scrim, el);
      const entry = register([scrim, el]);
      let answered = false;
      const input = $('input', el);
      const done = (v) => {
        if (answered) return;
        answered = true;
        closeEntry(entry);
        resolve(v);
      };
      entry.onClose = () => {
        if (!answered) {
          answered = true;
          resolve(null);
        }
      };
      $('[data-no]', el).onclick = () => done(null);
      $('[data-yes]', el).onclick = () => done(input.value);
      input.addEventListener('keydown', (e) => e.key === 'Enter' && done(input.value));
      scrim.onclick = () => done(null);
      setTimeout(() => input.focus(), 60);
    });

  /* ---------------- sonsuz kaydırma ---------------- */
  // loadMore(): Promise<boolean>  (true → daha fazla var)
  K.infinite = function (scrollRoot, container, loadMore) {
    const sentinel = document.createElement('div');
    sentinel.style.cssText = 'height:1px;width:1px';
    container.appendChild(sentinel);
    let busy = false;
    let done = false;
    const io = new IntersectionObserver(
      async (entries) => {
        if (busy || done || !entries.some((e) => e.isIntersecting)) return;
        busy = true;
        try {
          const more = await loadMore();
          if (!more) {
            done = true;
            io.disconnect();
          }
        } catch (e) {
          K.fail(e);
        }
        busy = false;
        // sentinel hâlâ görünüyorsa tekrar tetikle
        if (!done) {
          io.unobserve(sentinel);
          io.observe(sentinel);
        }
      },
      { root: scrollRoot, rootMargin: '400px 0px' }
    );
    io.observe(sentinel);
    return { stop: () => io.disconnect(), sentinel };
  };

  /* ---------------- yönlendirici ---------------- */
  const routes = [];
  let cleanup = null;
  let renderToken = 0;

  K.route = (pattern, handler, opts) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-z]+)/gi, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
    routes.push({ re, keys, handler, opts: opts || {} });
  };

  K.go = (path, replace) => {
    const target = '#' + path;
    if (replace) location.replace(target);
    else location.hash = target;
  };
  K.back = (fallback) => {
    if (history.length > 1) history.back();
    else K.go(fallback || '/');
  };

  K.currentPath = () => {
    const h = location.hash.replace(/^#/, '') || '/';
    const [path, qs] = h.split('?');
    return { path: path || '/', query: Object.fromEntries(new URLSearchParams(qs || '')) };
  };

  K.render = async function () {
    const token = ++renderToken;
    if (cleanup) {
      K.safe(cleanup);
      cleanup = null;
    }
    K.closeAllOverlays();
    const { path, query } = K.currentPath();
    // #view her gezinmede temiz bir kopyayla değiştirilir: önceki sayfanın olay dinleyicileri birikmesin
    const prevView = $('#view');
    const view = prevView.cloneNode(false);
    prevView.replaceWith(view);
    const app = $('#app');

    let match = null;
    for (const r of routes) {
      const m = r.re.exec(path);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        match = { r, params };
        break;
      }
    }
    if (!match) return K.go('/', true);
    const o = match.r.opts;
    if (o.auth !== false && !K.me) return K.go('/login', true);
    if (o.guest && K.me) return K.go('/', true);

    app.classList.toggle('feed-mode', !!o.feed);
    app.classList.toggle('dark-nav', !!o.feed);
    app.classList.toggle('no-nav', !!o.hideNav || !K.me);
    K.setNavActive && K.setNavActive(o.nav || '');
    view.innerHTML = '';
    view.scrollTop = 0;

    const ctx = { params: match.params, query, view, alive: () => token === renderToken };
    try {
      const c = await match.r.handler(ctx);
      if (token === renderToken) cleanup = c;
      else if (c) K.safe(c);
    } catch (e) {
      if (token !== renderToken) return;
      view.innerHTML = `<div class="empty">${K.icon('refresh')}<b>Sayfa yüklenemedi</b><span>${K.esc(e.message || '')}</span><button class="btn primary" id="retry">Tekrar dene</button></div>`;
      const b = $('#retry', view);
      if (b) b.onclick = () => K.render();
    }
  };

  K.handleBack = () => {
    if (stack.length) {
      closeEntry(stack[stack.length - 1]);
      return true;
    }
    const { path } = K.currentPath();
    if (path !== '/' && path !== '/login' && history.length > 1) {
      history.back();
      return true;
    }
    return false;
  };

  window.addEventListener('hashchange', () => K.render());

  K.spinner = () => '<div class="spinner" role="progressbar" aria-label="Yükleniyor"></div>';
  K.empty = (icon, title, text, extra) => `<div class="empty">${K.icon(icon)}<b>${K.esc(title)}</b>${text ? `<span>${K.esc(text)}</span>` : ''}${extra || ''}</div>`;
})();
