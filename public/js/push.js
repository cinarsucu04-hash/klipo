/* Klipo anlık bildirimler: tarayıcı/ana ekran uygulaması için Web Push, Android uygulaması için yerel köprü */
(function () {
  'use strict';
  const K = window.K;
  const { esc, icon } = K;

  const native = () => !!(window.KlipoNative && typeof window.KlipoNative.enableNotifications === 'function');
  const webSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent);

  function keyBytes(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // serviceWorker.ready, kayıt yoksa sonsuza dek bekler; zaman aşımıyla sınırla
  const swReady = () => Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, rej) => setTimeout(() => rej(new Error('Servis çalışanı hazır değil')), 4000)),
  ]);

  async function currentSub() {
    const reg = await swReady();
    return reg.pushManager.getSubscription();
  }

  const push = {
    supported: () => native() || webSupported(),

    async status() {
      if (native()) {
        const on = !!window.KlipoNative.notificationsEnabled();
        return { on, text: on ? 'Açık: beğeni, yorum ve mesajlar telefonuna gelir' : 'Kapalı' };
      }
      if (!webSupported()) {
        return { on: false, text: isIOS() ? "iPhone'da önce siteyi Ana Ekrana ekle, sonra açabilirsin" : 'Bu tarayıcı anlık bildirimi desteklemiyor' };
      }
      if (Notification.permission === 'denied') return { on: false, text: 'Engellenmiş: tarayıcı ayarlarından bu site için izin ver' };
      let sub = null;
      try { sub = await currentSub(); } catch (e) { /* yoksay */ }
      const on = Notification.permission === 'granted' && !!sub;
      return { on, text: on ? 'Açık: beğeni, yorum ve mesajlar telefonuna gelir' : 'Kapalı' };
    },

    // İzin ister ve bu cihazı abone eder. Kullanıcı dokunuşundan çağrılmalı.
    async enable() {
      if (native()) {
        window.KlipoNative.enableNotifications();
        for (let i = 0; i < 25; i++) {
          await sleep(400);
          if (window.KlipoNative.notificationsEnabled()) return true;
        }
        throw new Error('Bildirim izni verilmedi');
      }
      if (!webSupported()) throw new Error('Bu cihaz anlık bildirimi desteklemiyor');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Bildirim izni verilmedi');
      const reg = await swReady();
      const { publicKey } = await K.api('/push/key');
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
      await K.api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
      return true;
    },

    async disable() {
      if (native()) return window.KlipoNative.disableNotifications();
      if (!webSupported()) return;
      const sub = await currentSub();
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe().catch(() => {});
        await K.api('/push/unsubscribe', { method: 'POST', body: { endpoint } }).catch(() => {});
      }
    },

    // Giriş yapınca: izin zaten verilmişse bu hesabı bu cihaza bağla (hesap değişmiş olabilir)
    async sync() {
      try {
        if (native() || !webSupported() || Notification.permission !== 'granted') return;
        const sub = await currentSub();
        if (sub) await K.api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
      } catch (e) { /* sessizce geç */ }
    },

    // İzin penceresi: en fazla 7 günde bir sorulur
    async prompt() {
      try {
        if (!K.me || !push.supported() || K.hasOverlay()) return;
        const s = await push.status();
        if (s.on) return;
        if (!native() && Notification.permission !== 'default') return;
        const last = Number(K.store.get('pushAsked', '0')) || 0;
        if (Date.now() - last < 7 * 24 * 3600 * 1000) return;
        K.store.set('pushAsked', String(Date.now()));
        K.sheet({
          title: null,
          html: `<div class="col" style="align-items:center;text-align:center;padding:18px 12px 6px;gap:10px">
              <span class="avatar" style="background:var(--grad);color:#fff;width:64px;height:64px;display:grid;place-items:center">${icon('bell', 'lg')}</span>
              <h3 style="margin:0">Bildirimleri aç</h3>
              <p class="muted" style="margin:0">Beğeni, yorum, yeni takipçi ve mesajlardan anında haberdar ol.</p>
              <button class="btn primary block" id="pp-yes">Bildirimleri aç</button>
              <button class="btn ghost block" id="pp-no">Şimdi değil</button></div>`,
          onMount: (api) => {
            api.el.querySelector('#pp-no').onclick = api.close;
            api.el.querySelector('#pp-yes').onclick = async () => {
              api.close();
              try {
                await push.enable();
                K.toast('Bildirimler açıldı', 'ok');
              } catch (e) {
                K.toast(e.message || 'Bildirimler açılamadı', 'error');
              }
            };
          },
        });
      } catch (e) { /* yoksay */ }
    },
  };

  K.push = push;
})();
