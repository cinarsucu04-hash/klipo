'use strict';
// IP özetleri, IP yasakları, hesap sınırı, askı süresi, şifre kuralları, oturum sonlandırma, Google doğrulama
const crypto = require('crypto');
const cfg = require('./config');
const { cols, state } = require('./db');
const { HttpError } = require('./helpers');

// ---------------------------------------------------------------- IP
function normIp(ip) {
  ip = String(ip || '').replace(/^::ffff:/, '');
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':'); // IPv6: /64 ağı tek kişi sayılır
  return ip;
}
function hashIp(ip) {
  return crypto.createHmac('sha256', cfg.IP_SALT || cfg.SESSION_SECRET).update(normIp(ip)).digest('hex').slice(0, 32);
}
function ipHashOf(req) {
  if (!req._ipHash) req._ipHash = hashIp(req.ip || (req.socket && req.socket.remoteAddress) || '');
  return req._ipHash;
}
const maskIp = (h) => (h ? '…' + String(h).slice(-5) : '');

const banCache = new Map(); // ipHash → { at, ban }
async function ipBanOf(h) {
  const c = banCache.get(h);
  if (c && Date.now() - c.at < 20000) return c.ban;
  const ban = await cols.ipBans.findOne({ ipHash: h, $or: [{ until: null }, { until: { $gt: new Date() } }] });
  banCache.set(h, { at: Date.now(), ban });
  if (banCache.size > 5000) banCache.clear();
  return ban;
}
function forgetIp(h) { if (h) banCache.delete(h); else banCache.clear(); }

// API zincirinde oturumdan sonra çalışır
async function ipGate(req, res, next) {
  const h = ipHashOf(req);
  if (req.user && req.user.lastIpHash !== h) {
    cols.users.updateOne({ _id: req.user._id }, { $set: { lastIpHash: h } }).catch(() => {});
  }
  if (req.user && req.user.role === 'admin') return next();
  const ban = await ipBanOf(h);
  if (!ban) return next();
  req.ipBanInfo = 'Bu ağdan erişim engellendi' + (ban.reason ? ': ' + ban.reason : '.') + (ban.until ? ' (' + fmtDate(ban.until) + ' tarihine kadar)' : '');
  if (req.path === '/auth/me' || req.path === '/auth/logout') return next();
  return next(new HttpError(403, req.ipBanInfo, 'IPBAN'));
}

async function assertIpAllowed(req) {
  const ban = await ipBanOf(ipHashOf(req));
  if (ban) throw new HttpError(403, 'Bu ağdan erişim engellendi' + (ban.reason ? ': ' + ban.reason : '.'), 'IPBAN');
}

// Aynı ağdan açılabilecek hesap sayısı (yönetici panelinden değiştirilebilir)
async function assertAccountQuota(req) {
  const { getSettings } = require('./services');
  const s = await getSettings();
  const max = s.maxPerIp > 0 ? s.maxPerIp : cfg.MAX_ACCOUNTS_PER_IP;
  const n = await cols.users.countDocuments({ regIpHash: ipHashOf(req) });
  if (n >= max) {
    throw new HttpError(429, `Bu ağdan en fazla ${max} hesap açılabilir. Mevcut hesabınla giriş yap.`, 'IPLIMIT');
  }
}

// ---------------------------------------------------------------- Askı
const pad = (n) => String(n).padStart(2, '0');
function fmtDate(d) {
  d = new Date(d);
  const t = new Date(d.getTime() + 3 * 3600e3); // Türkiye saati
  return `${pad(t.getUTCDate())}.${pad(t.getUTCMonth() + 1)}.${t.getUTCFullYear()} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
}

// Süresi dolmuş geçici askıyı kaldırır; hâlâ askıdaysa true döner
async function refreshBan(u) {
  if (!u || !u.banned) return false;
  if (u.bannedUntil && new Date(u.bannedUntil).getTime() <= Date.now()) {
    await cols.users.updateOne({ _id: u._id }, { $set: { banned: false, banReason: '' }, $unset: { bannedUntil: '' } });
    u.banned = false;
    return false;
  }
  return true;
}
function banMessage(u) {
  const until = u.bannedUntil ? ` (${fmtDate(u.bannedUntil)} tarihine kadar)` : ' (süresiz)';
  return (u.banReason ? 'Hesabın askıya alındı: ' + u.banReason : 'Hesabın askıya alındı.') + until;
}

// ---------------------------------------------------------------- Şifre
const WEAK = new Set(['12345678', '123456789', '1234567890', 'password', 'password1', 'qwerty123', 'qwertyui', '11111111', '00000000', 'sifre123', 'sifre1234', 'iloveyou', 'abcd1234', 'asdfghjk', '87654321', 'klipo123', 'turkiye1']);
function checkPassword(pw, username) {
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 72) throw new HttpError(400, 'Şifre 8-72 karakter olmalı.');
  if (WEAK.has(pw.toLowerCase())) throw new HttpError(400, 'Bu şifre çok yaygın. Daha zor tahmin edilir bir şifre seç.');
  if (username && pw.toLowerCase().includes(String(username).toLowerCase()) && String(username).length >= 3) {
    throw new HttpError(400, 'Şifre kullanıcı adını içermemeli.');
  }
  if (!/[a-zA-ZçğıöşüÇĞİÖŞÜ]/.test(pw) || !/[0-9]/.test(pw)) {
    if (pw.length < 12) throw new HttpError(400, 'Şifrede hem harf hem rakam olmalı (ya da en az 12 karakter kullan).');
  }
}

// ---------------------------------------------------------------- Oturumlar
// Bir kullanıcının tüm oturumlarını kapatır (şifre değişince, "tüm cihazlardan çıkış"ta)
async function killSessions(userId) {
  try {
    const id = String(userId);
    await state.db.collection('sessions').deleteMany({ $or: [{ session: { $regex: '"uid":"' + id + '"' } }, { 'session.uid': id }] });
  } catch (e) { /* oturum deposu yoksa geç */ }
}

// ---------------------------------------------------------------- Google
async function verifyGoogle(credential) {
  if (!cfg.GOOGLE_CLIENT_ID) throw new HttpError(400, 'Google ile giriş bu sunucuda açık değil.');
  if (typeof credential !== 'string' || credential.length < 100 || credential.length > 4000) throw new HttpError(400, 'Google doğrulaması geçersiz.');
  let d;
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential), { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('bad');
    d = await r.json();
  } catch (e) {
    throw new HttpError(401, 'Google doğrulaması başarısız. Tekrar dene.');
  }
  const okIss = d.iss === 'accounts.google.com' || d.iss === 'https://accounts.google.com';
  const verified = d.email_verified === true || d.email_verified === 'true';
  if (d.aud !== cfg.GOOGLE_CLIENT_ID || !okIss || !verified || !d.sub || Number(d.exp) * 1000 < Date.now()) {
    throw new HttpError(401, 'Google doğrulaması geçersiz.');
  }
  return { sub: String(d.sub), email: String(d.email || '').toLowerCase(), name: String(d.name || '') };
}

module.exports = {
  ipHashOf, hashIp, maskIp, ipBanOf, forgetIp, ipGate, assertIpAllowed, assertAccountQuota,
  fmtDate, refreshBan, banMessage, checkPassword, killSessions, verifyGoogle,
};
