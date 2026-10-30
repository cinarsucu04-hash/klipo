'use strict';
// E-posta adresi normalleştirme ve 6 haneli doğrulama kodları (kayıt ve şifre sıfırlama)
const crypto = require('crypto');
const cfg = require('./config');
const { cols } = require('./db');
const { HttpError, tryOid } = require('./helpers');
const mail = require('./mail');

const TTL = 10 * 60 * 1000;
const COOLDOWN = 60 * 1000;
const MAX_SENDS = 5;
const MAX_TRIES = 5;
const GMAIL = new Set(['gmail.com', 'googlemail.com']);

const enabled = () => cfg.EMAIL_VERIFY && mail.ready();

// Adresi doğrular; { email, key } döner. key: aynı kutuyu farklı yazımlarla (a.b, a+x) tekrar kullanmayı engeller.
function parseEmail(raw, opts) {
  const email = String(raw || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[^\s@,;<>()"']+$/.test(email)) {
    throw new HttpError(400, 'Geçerli bir e-posta adresi yaz.');
  }
  const [local, domain] = email.split('@');
  if (!(opts && opts.anyDomain) && !cfg.ALLOWED_EMAIL_DOMAINS.includes(domain)) {
    throw new HttpError(400, `Şimdilik yalnızca ${cfg.ALLOWED_EMAIL_DOMAINS.join(' / ')} adresleri kabul ediliyor.`);
  }
  let key = email;
  if (GMAIL.has(domain)) key = local.split('+')[0].replace(/\./g, '') + '@gmail.com';
  if (!key.split('@')[0]) throw new HttpError(400, 'Geçerli bir e-posta adresi yaz.');
  return { email, key };
}
function tryKey(raw) {
  try { return parseEmail(raw, { anyDomain: true }).key; } catch (e) { return ''; }
}
function mask(email) {
  const [l, d] = String(email || '').split('@');
  if (!d) return '';
  return (l.length <= 2 ? l[0] : l.slice(0, 2)) + '•••@' + d;
}

const hashCode = (code, salt) => crypto.createHmac('sha256', cfg.SESSION_SECRET).update(salt + ':' + code).digest('hex');
const sameHash = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Her istekte yeni, rastgele ve kişiye özel 6 haneli kod
function newCode() {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const salt = crypto.randomBytes(12).toString('hex');
  return { code, salt, hash: hashCode(code, salt) };
}

async function deliver(kind, email, code) {
  try {
    await mail.send({ to: email, ...mail.codeMail(kind, code) });
  } catch (e) {
    console.error('[e-posta]', e.message);
    throw new HttpError(502, 'E-posta gönderilemedi. Adresi kontrol et ya da biraz sonra tekrar dene.', 'MAIL');
  }
}

// Kod üretir, kaydeder, gönderir; bekleyen kaydın kimliğini döner
async function start({ purpose, email, key, data, userId, ipHash }) {
  const recent = await cols.emailCodes.countDocuments({ ipHash, createdAt: { $gte: new Date(Date.now() - 3600e3) } });
  if (recent >= 10) throw new HttpError(429, 'Bu ağdan çok fazla kod istendi. Bir süre sonra tekrar dene.', 'RATE');
  const old = await cols.emailCodes.findOne({ emailKey: key, purpose });
  if (old && Date.now() - new Date(old.lastSentAt).getTime() < COOLDOWN) {
    const wait = Math.ceil((COOLDOWN - (Date.now() - new Date(old.lastSentAt).getTime())) / 1000);
    throw new HttpError(429, `Yeni kod için ${wait} saniye bekle.`, 'COOLDOWN');
  }
  if (old) await cols.emailCodes.deleteOne({ _id: old._id });
  const c = newCode();
  const now = new Date();
  const r = await cols.emailCodes.insertOne({
    purpose, email, emailKey: key, data: data || null, userId: userId || null, ipHash,
    codeHash: c.hash, salt: c.salt, attempts: 0, sends: 1, lastSentAt: now, createdAt: now, exp: new Date(Date.now() + TTL),
  });
  try {
    await deliver(purpose, email, c.code);
  } catch (e) {
    await cols.emailCodes.deleteOne({ _id: r.insertedId });
    throw e;
  }
  return String(r.insertedId);
}

async function resend(id, purpose) {
  const _id = tryOid(id);
  const doc = _id ? await cols.emailCodes.findOne({ _id, purpose }) : null;
  if (!doc || doc.exp < new Date()) throw new HttpError(400, 'Kodun süresi doldu. Baştan başla.', 'EXPIRED');
  const since = Date.now() - new Date(doc.lastSentAt).getTime();
  if (since < COOLDOWN) throw new HttpError(429, `Yeni kod için ${Math.ceil((COOLDOWN - since) / 1000)} saniye bekle.`, 'COOLDOWN');
  if (doc.sends >= MAX_SENDS) throw new HttpError(429, 'Bu işlem için en fazla 5 kod gönderilebilir. Baştan başla.', 'RATE');
  const c = newCode();
  await cols.emailCodes.updateOne(
    { _id },
    { $set: { codeHash: c.hash, salt: c.salt, attempts: 0, lastSentAt: new Date(), exp: new Date(Date.now() + TTL) }, $inc: { sends: 1 } }
  );
  await deliver(purpose, doc.email, c.code);
  return doc.email;
}

// Kodu doğrular (tek kullanımlık). Başarılıysa bekleyen kaydı döner ve siler.
async function consume(id, purpose, code) {
  const _id = tryOid(id);
  const doc = _id ? await cols.emailCodes.findOne({ _id, purpose }) : null;
  if (!doc || doc.exp < new Date()) throw new HttpError(400, 'Kod hatalı ya da süresi dolmuş. Yeni kod iste.', 'EXPIRED');
  if (doc.attempts >= MAX_TRIES) {
    await cols.emailCodes.deleteOne({ _id });
    throw new HttpError(429, 'Çok fazla yanlış deneme. Baştan başla.', 'RATE');
  }
  const given = String(code || '').replace(/\D/g, '');
  if (given.length !== 6 || !sameHash(hashCode(given, doc.salt), doc.codeHash)) {
    await cols.emailCodes.updateOne({ _id }, { $inc: { attempts: 1 } });
    throw new HttpError(400, `Kod hatalı. Kalan deneme: ${Math.max(0, MAX_TRIES - doc.attempts - 1)}`, 'BADCODE');
  }
  await cols.emailCodes.deleteOne({ _id });
  return doc;
}

module.exports = { enabled, parseEmail, tryKey, mask, start, resend, consume, TTL, COOLDOWN };
