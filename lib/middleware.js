'use strict';
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { ObjectId } = require('mongodb');
const { cols } = require('./db');
const { HttpError, OID_RE } = require('./helpers');
const { getSettings } = require('./services');
const security = require('./security');

const limitMessage = { error: 'Çok fazla istek gönderdin. Lütfen biraz bekleyip tekrar dene.' };

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: limitMessage,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Çok fazla giriş denemesi. 15 dakika sonra tekrar dene.' },
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Saatlik yükleme sınırına ulaştın. Daha sonra tekrar dene.' },
  keyGenerator: (req) => (req.session && req.session.uid) || req.ip,
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: limitMessage,
  skip: (req) => req.method === 'GET' || req.method === 'HEAD',
  keyGenerator: (req) => (req.session && req.session.uid) || req.ip,
});

// Oturumdaki kullanıcıyı yükler (şifre hash'i asla bellekte tutulmaz)
async function loadUser(req, res, next) {
  req.user = null;
  const uid = req.session && req.session.uid;
  if (uid && OID_RE.test(uid)) {
    const u = await cols.users.findOne({ _id: new ObjectId(uid) }, { projection: { password: 0 } });
    if (u && (await security.refreshBan(u))) {
      req.bannedInfo = security.banMessage(u);
      await new Promise((resolve) => req.session.regenerate(() => resolve()));
    } else if (u) {
      req.user = u;
      // son görülme: dakikada en fazla bir kez yaz
      if (!u.lastActive || Date.now() - new Date(u.lastActive).getTime() > 60000) {
        cols.users.updateOne({ _id: u._id }, { $set: { lastActive: new Date() } }).catch(() => {});
      }
    } else {
      // hesap silinmiş: eski oturumu yenisiyle değiştir (CSRF belirteci için oturum nesnesi lazım)
      await new Promise((resolve) => req.session.regenerate(() => resolve()));
    }
  }
  next();
}

// CSRF: oturumda tutulan belirteç X-CSRF-Token başlığıyla gönderilmeli
function ensureCsrf(req) {
  if (!req.session) return '';
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  return req.session.csrf;
}

function csrf(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const sent = req.get('x-csrf-token');
  if (!req.session || !req.session.csrf || !sent) {
    return next(new HttpError(403, 'Güvenlik doğrulaması başarısız. Sayfayı yenile.', 'CSRF'));
  }
  const a = Buffer.from(String(sent));
  const b = Buffer.from(req.session.csrf);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return next(new HttpError(403, 'Güvenlik doğrulaması başarısız. Sayfayı yenile.', 'CSRF'));
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Giriş yapmalısın.', 'AUTH'));
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return next(new HttpError(403, 'Bu işlem için yönetici olmalısın.'));
  next();
}

async function maintenance(req, res, next) {
  const s = await getSettings();
  if (s.maintenance && (!req.user || req.user.role !== 'admin')) {
    return next(new HttpError(503, 'Platform şu anda bakımda. Lütfen daha sonra tekrar dene.', 'MAINTENANCE'));
  }
  next();
}

function noStore(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  next();
}

module.exports = {
  apiLimiter,
  authLimiter,
  uploadLimiter,
  writeLimiter,
  loadUser,
  ensureCsrf,
  csrf,
  requireAuth,
  requireAdmin,
  maintenance,
  noStore,
};
