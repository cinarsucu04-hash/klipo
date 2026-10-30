'use strict';
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const cfg = require('../lib/config');
const { cols } = require('../lib/db');
const { HttpError, wrap, clean } = require('../lib/helpers');
const { isValidUsername, RESERVED_USERNAMES, REPORT_REASONS } = require('../lib/text');
const { presentMe, getSettings } = require('../lib/services');
const { ensureCsrf, authLimiter, requireAuth } = require('../lib/middleware');
const social = require('../lib/purge');
const security = require('../lib/security');
const moderation = require('../lib/moderation');
const captcha = require('../lib/captcha');
const emailcode = require('../lib/emailcode');

const router = express.Router();

// Kullanıcı bulunamasa bile aynı sürede cevap vermek için sahte hash
const DUMMY_HASH = bcrypt.hashSync('klipo-dummy-password', 10);
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

function regenerate(req) {
  return new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
}

async function startSession(req, user) {
  await regenerate(req);
  req.session.uid = String(user._id);
  return ensureCsrf(req);
}

const accountTypeOf = (v) => (v === 'rp' ? 'rp' : 'real');

// Uygulama açılışında çağrılır: kullanıcı + CSRF belirteci + genel yapılandırma
router.get(
  '/me',
  wrap(async (req, res) => {
    const csrfToken = ensureCsrf(req);
    const settings = await getSettings();
    res.json({
      user: req.user && !req.ipBanInfo ? presentMe(req.user) : null,
      csrf: csrfToken,
      banned: req.bannedInfo || req.ipBanInfo || '',
      config: {
        appName: cfg.APP_NAME,
        maxVideoMB: cfg.MAX_VIDEO_MB,
        maxAudioMB: cfg.MAX_AUDIO_MB,
        maxImageMB: cfg.MAX_IMAGE_MB,
        reportReasons: REPORT_REASONS,
        announcement: settings.announcement ? settings.announcement.text : '',
        maintenance: settings.maintenance,
        googleClientId: cfg.GOOGLE_CLIENT_ID || '',
        emailVerify: emailcode.enabled(),
        emailDomains: cfg.ALLOWED_EMAIL_DOMAINS,
      },
    });
  })
);

// Captcha resmi (SVG). Her istekte yeni kod üretilir; cevap oturumda özet olarak tutulur.
router.get(
  '/captcha',
  wrap(async (req, res) => {
    const svg = captcha.generate(req);
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(svg);
  })
);

function requireCaptcha(req) {
  if (!captcha.check(req, (req.body || {}).captcha)) {
    throw new HttpError(400, 'Güvenlik kodu yanlış ya da süresi dolmuş. Resmi yenileyip tekrar yaz.', 'CAPTCHA');
  }
}

// Kayıt bilgilerini doğrular (kullanıcı adı, görünen ad, şifre, yönetici adı, IP yasağı/sınırı)
async function validateSignup(req, body) {
  const username = clean(body.username, 30).toLowerCase();
  let nickname = clean(body.nickname, 30);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!isValidUsername(username)) {
    throw new HttpError(400, 'Kullanıcı adı 3-24 karakter olmalı; yalnızca harf, rakam, nokta ve alt çizgi kullanabilirsin.');
  }
  if (!nickname) nickname = username;
  security.checkPassword(password, username);
  await moderation.assertClean(username, 'Kullanıcı adı');
  await moderation.assertClean(nickname, 'Görünen ad');

  let role = 'user';
  if (cfg.ADMIN_USERNAMES.includes(username)) {
    // ADMIN_USERNAMES listesindeki ad, ilk kaydolan kişiye yönetici yetkisiyle verilir (başka kod istenmez).
    // Ad alındıktan sonra kimse aynı adla kayıt olamaz; bu yüzden yönetici hesabını ilk iş sen aç.
    role = 'admin';
  } else if (RESERVED_USERNAMES.has(username)) {
    throw new HttpError(400, 'Bu kullanıcı adı kullanılamaz.');
  }
  if (await cols.users.findOne({ username }, { projection: { _id: 1 } })) throw new HttpError(409, 'Bu kullanıcı adı zaten alınmış.');
  // IP yasağı ve ağ başına hesap sınırı (ilk yönetici hesabı için uygulanmaz)
  if (role !== 'admin') {
    await security.assertIpAllowed(req);
    await security.assertAccountQuota(req);
  }
  return { username, nickname, password, role, accountType: accountTypeOf(body.accountType) };
}

async function createUser(req, s, extra) {
  const ipHash = security.ipHashOf(req);
  const user = {
    username: s.username,
    nickname: s.nickname,
    password: s.passwordHash,
    bio: '',
    link: '',
    avatar: '',
    banner: '',
    verified: false,
    role: s.role,
    banned: false,
    accountType: s.accountType,
    regIpHash: ipHash,
    lastIpHash: ipHash,
    isPrivate: false,
    hideVisitors: false,
    restrictedMode: false,
    showLikes: false,
    theme: 'dark',
    allowMessages: 'everyone',
    createdAt: new Date(),
    lastActive: new Date(),
    ...(extra || {}),
  };
  try {
    const r = await cols.users.insertOne(user);
    user._id = r.insertedId;
  } catch (e) {
    if (e.code === 11000) {
      const f = JSON.stringify(e.keyPattern || e.keyValue || {});
      throw new HttpError(409, /email/i.test(f) ? 'Bu e-posta ile zaten bir hesap var.' : 'Bu kullanıcı adı zaten alınmış.');
    }
    throw e;
  }
  return user;
}

// E-posta doğrulaması kapalıyken (sağlayıcı ayarlı değil) kullanılan doğrudan kayıt; captcha yine gerekir
router.post(
  '/register',
  authLimiter,
  wrap(async (req, res) => {
    if (emailcode.enabled()) throw new HttpError(400, 'Kayıt için e-posta doğrulaması gerekli.', 'EMAIL_REQUIRED');
    const body = req.body || {};
    requireCaptcha(req);
    const s = await validateSignup(req, body);
    s.passwordHash = await bcrypt.hash(s.password, 10);
    const user = await createUser(req, s);
    const csrfToken = await startSession(req, user);
    res.json({ user: presentMe(user), csrf: csrfToken });
  })
);

// 1. adım: bilgileri doğrula, e-postaya 6 haneli kod gönder
router.post(
  '/register/start',
  authLimiter,
  wrap(async (req, res) => {
    if (!emailcode.enabled()) throw new HttpError(400, 'E-posta doğrulaması bu sunucuda kapalı.');
    const body = req.body || {};
    requireCaptcha(req);
    const s = await validateSignup(req, body);
    const { email, key } = emailcode.parseEmail(body.email);
    if (await cols.users.findOne({ emailKey: key }, { projection: { _id: 1 } })) {
      throw new HttpError(409, 'Bu e-posta ile zaten bir hesap var. Giriş yap ya da şifreni sıfırla.');
    }
    const pending = await emailcode.start({
      purpose: 'signup',
      email,
      key,
      ipHash: security.ipHashOf(req),
      data: { username: s.username, nickname: s.nickname, passwordHash: await bcrypt.hash(s.password, 10), accountType: s.accountType, role: s.role },
    });
    res.json({ pending, email: emailcode.mask(email) });
  })
);

router.post(
  '/register/resend',
  authLimiter,
  wrap(async (req, res) => {
    const email = await emailcode.resend((req.body || {}).pending, 'signup');
    res.json({ ok: true, email: emailcode.mask(email) });
  })
);

// 2. adım: kodu doğrula, hesabı oluştur ve giriş yap
router.post(
  '/register/verify',
  authLimiter,
  wrap(async (req, res) => {
    const doc = await emailcode.consume((req.body || {}).pending, 'signup', (req.body || {}).code);
    const d = doc.data || {};
    if (d.role !== 'admin') {
      await security.assertIpAllowed(req);
      await security.assertAccountQuota(req);
    }
    const user = await createUser(req, { ...d }, { email: doc.email, emailKey: doc.emailKey, emailVerified: true });
    const csrfToken = await startSession(req, user);
    delete user.password;
    res.json({ user: presentMe(user), csrf: csrfToken });
  })
);

// Şifremi unuttum: kayıtlı e-postaya kod gönderir. Adres kayıtlı olmasa da aynı cevap verilir (hesap var mı yok mu sızdırılmaz).
router.post(
  '/forgot',
  authLimiter,
  wrap(async (req, res) => {
    if (!emailcode.enabled()) throw new HttpError(400, 'E-posta doğrulaması bu sunucuda kapalı; şifre sıfırlama yapılamıyor.');
    requireCaptcha(req);
    const { email, key } = emailcode.parseEmail((req.body || {}).email);
    const user = await cols.users.findOne({ emailKey: key }, { projection: { _id: 1, banned: 1 } });
    let pending;
    if (user && !user.banned) {
      pending = await emailcode.start({ purpose: 'reset', email, key, userId: user._id, ipHash: security.ipHashOf(req) });
    } else {
      pending = crypto.randomBytes(12).toString('hex'); // sahte kimlik: adres kayıtlı değilmiş gibi görünmesin
    }
    res.json({ pending, email: emailcode.mask(email) });
  })
);

router.post(
  '/reset',
  authLimiter,
  wrap(async (req, res) => {
    const body = req.body || {};
    const doc = await emailcode.consume(body.pending, 'reset', body.code);
    const user = await cols.users.findOne({ _id: doc.userId });
    if (!user) throw new HttpError(400, 'Hesap bulunamadı.');
    security.checkPassword(body.password, user.username);
    await cols.users.updateOne(
      { _id: user._id },
      { $set: { password: await bcrypt.hash(body.password, 10), noPassword: false, failCount: 0 }, $unset: { lockUntil: '' } }
    );
    await security.killSessions(user._id);
    if (await security.refreshBan(user)) throw new HttpError(403, security.banMessage(user), 'BANNED');
    const csrfToken = await startSession(req, user);
    delete user.password;
    res.json({ user: presentMe(user), csrf: csrfToken });
  })
);

router.post(
  '/login',
  authLimiter,
  wrap(async (req, res) => {
    const body = req.body || {};
    const ident = clean(body.username, 254).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    // 3 hatalı denemeden sonra captcha istenir (bu oturumda)
    if ((req.session.loginFails || 0) >= 3) requireCaptcha(req);
    let user = null;
    if (ident.includes('@')) {
      const key = emailcode.tryKey(ident);
      user = key ? await cols.users.findOne({ emailKey: key }) : null;
    } else if (ident) {
      user = await cols.users.findOne({ username: ident.slice(0, 30) });
    }

    if (user && user.lockUntil && new Date(user.lockUntil).getTime() > Date.now()) {
      const mins = Math.ceil((new Date(user.lockUntil).getTime() - Date.now()) / 60000);
      throw new HttpError(429, `Çok fazla hatalı deneme. Güvenlik için hesap ${mins} dakika kilitlendi.`, 'LOCKED');
    }
    const ok = await bcrypt.compare(password, user && !user.noPassword ? user.password : DUMMY_HASH);
    if (!user || !ok) {
      req.session.loginFails = (req.session.loginFails || 0) + 1;
      if (user) {
        const fails = (user.failCount || 0) + 1;
        const set = fails >= MAX_FAILS ? { failCount: 0, lockUntil: new Date(Date.now() + LOCK_MS) } : { failCount: fails };
        await cols.users.updateOne({ _id: user._id }, { $set: set });
      }
      if (user && user.noPassword) throw new HttpError(401, 'Bu hesap Google ile açılmış. "Google ile devam et" düğmesini kullan.');
      throw new HttpError(401, 'Kullanıcı adı / e-posta veya şifre hatalı.', req.session.loginFails >= 3 ? 'NEEDCAPTCHA' : undefined);
    }
    if (await security.refreshBan(user)) throw new HttpError(403, security.banMessage(user), 'BANNED');
    const ipHash = security.ipHashOf(req);
    await cols.users.updateOne(
      { _id: user._id },
      { $set: { lastActive: new Date(), lastIpHash: ipHash, failCount: 0 }, $unset: { lockUntil: '' } }
    );
    const csrfToken = await startSession(req, user);
    delete user.password;
    res.json({ user: presentMe(user), csrf: csrfToken });
  })
);

// ---------------------------------------------------------------- GOOGLE
function usernameFromEmail(email) {
  let base = String(email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9._]/g, '').replace(/[._]{2,}/g, '_').replace(/^[._]+|[._]+$/g, '').slice(0, 14);
  if (base.length < 3) base = 'klipo';
  return base;
}

// Google kimliğiyle kullanıcıyı bulur; yoksa oluşturur (rol her zaman "user")
async function googleUser(req, g, accountType) {
  let user = await cols.users.findOne({ googleId: g.sub }, { projection: { password: 0 } });
  if (user) {
    if (await security.refreshBan(user)) throw new HttpError(403, security.banMessage(user), 'BANNED');
    return user;
  }
  // Aynı (Google tarafından doğrulanmış) e-postayla açılmış hesap varsa ona bağla
  const emailKey = emailcode.tryKey(g.email);
  if (emailKey) {
    const byMail = await cols.users.findOne({ emailKey }, { projection: { password: 0 } });
    if (byMail) {
      if (await security.refreshBan(byMail)) throw new HttpError(403, security.banMessage(byMail), 'BANNED');
      await cols.users.updateOne({ _id: byMail._id }, { $set: { googleId: g.sub, googleEmail: g.email, emailVerified: true } });
      byMail.googleId = g.sub;
      return byMail;
    }
  }
  await security.assertIpAllowed(req);
  await security.assertAccountQuota(req);
  const ipHash = security.ipHashOf(req);
  const nickname = clean(g.name, 30) || 'Yeni kullanıcı';
  await moderation.assertClean(nickname, 'Görünen ad');
  const base = usernameFromEmail(g.email);
  for (let i = 0; i < 8; i++) {
    const username = `${base}_${crypto.randomInt(1000, 99999)}`.slice(0, 24);
    if (!isValidUsername(username) || RESERVED_USERNAMES.has(username) || cfg.ADMIN_USERNAMES.includes(username)) continue;
    const doc = {
      username,
      nickname,
      password: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 8),
      noPassword: true,
      usernameAuto: true,
      googleId: g.sub,
      googleEmail: g.email,
      email: g.email,
      emailVerified: true,
      ...(emailKey ? { emailKey } : {}),
      bio: '', link: '', avatar: '', banner: '',
      verified: false, role: 'user', banned: false,
      accountType: accountTypeOf(accountType),
      regIpHash: ipHash, lastIpHash: ipHash,
      isPrivate: false, hideVisitors: false, restrictedMode: false, showLikes: false,
      theme: 'dark', allowMessages: 'everyone',
      createdAt: new Date(), lastActive: new Date(),
    };
    try {
      const r = await cols.users.insertOne(doc);
      doc._id = r.insertedId;
      delete doc.password;
      return doc;
    } catch (e) {
      if (e.code !== 11000) throw e;
      // aynı Google hesabı eşzamanlı geldiyse mevcut kaydı kullan
      const again = await cols.users.findOne({ googleId: g.sub }, { projection: { password: 0 } });
      if (again) return again;
    }
  }
  throw new HttpError(500, 'Hesap oluşturulamadı. Tekrar dene.');
}

// Tarayıcı / ana ekran uygulaması: Google'dan gelen kimlik belirteciyle giriş
router.post(
  '/google',
  authLimiter,
  wrap(async (req, res) => {
    const body = req.body || {};
    const g = await security.verifyGoogle(body.credential);
    const user = await googleUser(req, g, body.accountType);
    await cols.users.updateOne({ _id: user._id }, { $set: { lastActive: new Date(), lastIpHash: security.ipHashOf(req) } });
    const csrfToken = await startSession(req, user);
    res.json({ user: presentMe(user), csrf: csrfToken });
  })
);

// Mevcut hesaba Google'ı bağla
router.post(
  '/google-link',
  requireAuth,
  authLimiter,
  wrap(async (req, res) => {
    const g = await security.verifyGoogle((req.body || {}).credential);
    const other = await cols.users.findOne({ googleId: g.sub }, { projection: { _id: 1 } });
    if (other && String(other._id) !== String(req.user._id)) throw new HttpError(409, 'Bu Google hesabı başka bir Klipo hesabına bağlı.');
    await cols.users.updateOne({ _id: req.user._id }, { $set: { googleId: g.sub, googleEmail: g.email } });
    const fresh = await cols.users.findOne({ _id: req.user._id }, { projection: { password: 0 } });
    res.json({ user: presentMe(fresh) });
  })
);

// Android uygulaması: Google girişi sistem tarayıcısında yapılır, tek kullanımlık kodla uygulamaya aktarılır
router.post(
  '/google-app',
  authLimiter,
  wrap(async (req, res) => {
    const body = req.body || {};
    const g = await security.verifyGoogle(body.credential);
    const user = await googleUser(req, g, body.accountType);
    const code = crypto.randomBytes(24).toString('hex');
    await cols.authCodes.insertOne({
      codeHash: crypto.createHash('sha256').update(code).digest('hex'),
      userId: user._id,
      exp: new Date(Date.now() + 2 * 60 * 1000),
    });
    res.json({ code });
  })
);

router.get(
  '/handoff',
  authLimiter,
  wrap(async (req, res) => {
    const code = String(req.query.code || '');
    const hash = crypto.createHash('sha256').update(code).digest('hex');
    const doc = /^[a-f0-9]{48}$/.test(code) ? await cols.authCodes.findOneAndDelete({ codeHash: hash }) : null;
    const row = doc && (doc.value !== undefined ? doc.value : doc); // sürücü sürümüne göre
    if (!row || !row.userId || new Date(row.exp).getTime() < Date.now()) return res.redirect('/#/login');
    const user = await cols.users.findOne({ _id: row.userId }, { projection: { password: 0 } });
    if (!user || (await security.refreshBan(user))) return res.redirect('/#/login');
    await startSession(req, user);
    res.redirect('/');
  })
);

// Google ile açılan hesap için kullanıcı adı seçimi (bir kez)
router.post(
  '/pick-username',
  requireAuth,
  authLimiter,
  wrap(async (req, res) => {
    if (!req.user.usernameAuto) throw new HttpError(400, 'Kullanıcı adı zaten seçilmiş.');
    const username = clean((req.body || {}).username, 30).toLowerCase();
    if (!isValidUsername(username)) {
      throw new HttpError(400, 'Kullanıcı adı 3-24 karakter olmalı; yalnızca harf, rakam, nokta ve alt çizgi kullanabilirsin.');
    }
    if (RESERVED_USERNAMES.has(username) || cfg.ADMIN_USERNAMES.includes(username)) throw new HttpError(400, 'Bu kullanıcı adı kullanılamaz.');
    await moderation.assertClean(username, 'Kullanıcı adı');
    try {
      await cols.users.updateOne({ _id: req.user._id }, { $set: { username }, $unset: { usernameAuto: '' } });
    } catch (e) {
      if (e.code === 11000) throw new HttpError(409, 'Bu kullanıcı adı zaten alınmış.');
      throw e;
    }
    const fresh = await cols.users.findOne({ _id: req.user._id }, { projection: { password: 0 } });
    res.json({ user: presentMe(fresh) });
  })
);

router.post(
  '/logout',
  wrap(async (req, res) => {
    await new Promise((resolve) => req.session.destroy(() => resolve()));
    res.clearCookie('klipo.sid');
    res.json({ ok: true });
  })
);

// Tüm cihazlardan çıkış (çalınan/unutulan oturumları kapatır)
router.post(
  '/logout-all',
  requireAuth,
  wrap(async (req, res) => {
    await security.killSessions(req.user._id);
    await new Promise((resolve) => req.session.destroy(() => resolve()));
    res.clearCookie('klipo.sid');
    res.json({ ok: true });
  })
);

router.post(
  '/password',
  requireAuth,
  authLimiter,
  wrap(async (req, res) => {
    const { current, next } = req.body || {};
    const full = await cols.users.findOne({ _id: req.user._id });
    if (full.noPassword) throw new HttpError(400, 'Google ile açılan hesapta şifre yok.');
    security.checkPassword(next, full.username);
    if (!(await bcrypt.compare(String(current || ''), full.password))) {
      throw new HttpError(403, 'Mevcut şifre hatalı.');
    }
    await cols.users.updateOne({ _id: req.user._id }, { $set: { password: await bcrypt.hash(next, 10) } });
    // şifre değişince diğer tüm cihazların oturumu kapanır; bu cihaz açık kalır
    await security.killSessions(req.user._id);
    const csrfToken = await startSession(req, full);
    res.json({ ok: true, csrf: csrfToken });
  })
);

router.post(
  '/delete-account',
  requireAuth,
  authLimiter,
  wrap(async (req, res) => {
    const full = await cols.users.findOne({ _id: req.user._id });
    const given = String((req.body || {}).password || '');
    // Google hesabında şifre yok: onay olarak kullanıcı adı yazılır
    const ok = full.noPassword ? given.toLowerCase() === full.username : await bcrypt.compare(given, full.password);
    if (!ok) throw new HttpError(403, full.noPassword ? 'Kullanıcı adını doğru yazmadın.' : 'Şifre hatalı.');
    if (full.role === 'admin') {
      const admins = await cols.users.countDocuments({ role: 'admin', banned: { $ne: true } });
      if (admins <= 1) throw new HttpError(400, 'Son yönetici hesabı silinemez.');
    }
    await social.purgeUser(full._id);
    await security.killSessions(full._id);
    await new Promise((resolve) => req.session.destroy(() => resolve()));
    res.clearCookie('klipo.sid');
    res.json({ ok: true });
  })
);

module.exports = router;
