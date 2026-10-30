'use strict';
// MongoDB oturum deposunun etrafında koruyucu katman.
// Atlas ücretsiz küme dolduğunda yazma reddedilir ("over your space quota"). Oturum yazılamazsa uygulama hiç açılmaz
// (CSRF belirteci oturuma yazılır). Bu katman yalnızca "depolama dolu" hatasında oturumu geçici olarak bellekte tutar;
// böylece uygulama açılır ve yönetici girip yer açabilir. Bellekteki oturumlar sunucu yeniden başlayınca kaybolur.
// Başka hatalarda davranış değişmez.
const session = require('express-session');
const { isQuotaError } = require('./helpers');

const MAX_MEM = 3000;
const DEFAULT_TTL = 30 * 24 * 3600 * 1000;

class FallbackStore extends session.Store {
  constructor(inner) {
    super();
    this.inner = inner;
    this.mem = new Map(); // sid -> { sess, exp }
    this.warnedAt = 0;
  }

  _warn() {
    if (Date.now() - this.warnedAt < 60000) return;
    this.warnedAt = Date.now();
    console.warn('[oturum] MongoDB yazmayı reddediyor (depolama dolu): oturumlar geçici olarak bellekte tutuluyor. Yönetim panelinden yer aç.');
  }

  _expOf(sess) {
    const e = sess && sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : 0;
    return e > Date.now() ? e : Date.now() + DEFAULT_TTL;
  }

  get(sid, cb) {
    const m = this.mem.get(sid);
    if (m) {
      if (m.exp > Date.now()) return cb(null, JSON.parse(JSON.stringify(m.sess)));
      this.mem.delete(sid);
    }
    this.inner.get(sid, cb);
  }

  set(sid, sess, cb) {
    this.inner.set(sid, sess, (err) => {
      if (!err) {
        this.mem.delete(sid); // MongoDB yazdı: bellekteki eski nüsha gereksiz
        return cb && cb(null);
      }
      if (!isQuotaError(err)) return cb && cb(err);
      this._warn();
      if (this.mem.size >= MAX_MEM) this.mem.delete(this.mem.keys().next().value);
      this.mem.set(sid, { sess: JSON.parse(JSON.stringify(sess)), exp: this._expOf(sess) });
      cb && cb(null);
    });
  }

  touch(sid, sess, cb) {
    const m = this.mem.get(sid);
    if (m) {
      m.exp = this._expOf(sess);
      return cb && cb(null);
    }
    this.inner.touch(sid, sess, (err) => cb && cb(err && !isQuotaError(err) ? err : null));
  }

  destroy(sid, cb) {
    this.mem.delete(sid);
    this.inner.destroy(sid, (err) => cb && cb(err && !isQuotaError(err) ? err : null));
  }
}

module.exports = { FallbackStore };
