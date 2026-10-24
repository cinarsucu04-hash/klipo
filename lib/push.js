'use strict';
// Web Push (tarayıcı / ana ekrana eklenmiş uygulama bildirimleri). Anahtarlar ilk açılışta üretilip veritabanında saklanır.
const webpush = require('web-push');
const cfg = require('./config');
const { cols } = require('./db');

const state = { ready: false, publicKey: '' };

async function init() {
  let pub = process.env.VAPID_PUBLIC_KEY || '';
  let priv = process.env.VAPID_PRIVATE_KEY || '';
  if (!pub || !priv) {
    let doc = await cols.settings.findOne({ _id: 'vapid' });
    if (!doc) {
      const k = webpush.generateVAPIDKeys();
      // iki örnek aynı anda açılırsa ilk yazılan kazanır
      await cols.settings.updateOne({ _id: 'vapid' }, { $setOnInsert: { publicKey: k.publicKey, privateKey: k.privateKey } }, { upsert: true });
      doc = await cols.settings.findOne({ _id: 'vapid' });
    }
    pub = doc.publicKey;
    priv = doc.privateKey;
  }
  const site = cfg.SITE_URL && /^https:\/\//.test(cfg.SITE_URL) ? cfg.SITE_URL : 'mailto:bildirim@klipo.app';
  webpush.setVapidDetails(site, pub, priv);
  state.publicKey = pub;
  state.ready = true;
}

// Kullanıcının tüm cihazlarına gönderir; süresi dolmuş abonelikleri temizler. Hata fırlatmaz.
async function sendToUser(userId, payload) {
  if (!state.ready) return 0;
  try {
    const subs = await cols.pushSubs.find({ userId }).limit(10).toArray();
    let sent = 0;
    const body = JSON.stringify(payload);
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, { TTL: 3600, timeout: 8000 });
          sent++;
        } catch (e) {
          if (e && (e.statusCode === 404 || e.statusCode === 410)) await cols.pushSubs.deleteOne({ _id: s._id }).catch(() => {});
        }
      })
    );
    return sent;
  } catch (e) {
    console.error('[push]', e.message);
    return 0;
  }
}

const TEXTS = {
  like: (n) => `${n} videonu beğendi`,
  follow: (n) => `${n} seni takip etmeye başladı`,
  follow_request: (n) => `${n} sana takip isteği gönderdi`,
  follow_accepted: (n) => `${n} takip isteğini kabul etti`,
  comment: (n, t) => `${n} yorum yaptı${t ? ': ' + t : ''}`,
  reply: (n, t) => `${n} yorumuna yanıt verdi${t ? ': ' + t : ''}`,
  comment_like: (n) => `${n} yorumunu beğendi`,
  mention: (n) => `${n} senden bahsetti`,
};

function forNotification(type, actor, text) {
  const name = (actor && (actor.nickname || actor.username)) || 'Birisi';
  const make = TEXTS[type];
  return {
    title: 'Klipo',
    body: make ? make(name, text ? String(text).slice(0, 80) : '') : `${name} seninle etkileşime girdi`,
    url: type === 'follow_request' ? '/#/requests' : '/#/inbox',
    tag: 'n-' + type,
  };
}

module.exports = { state, init, sendToUser, forNotification };
