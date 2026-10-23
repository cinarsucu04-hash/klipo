'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const cfg = require('../lib/config');
const { cols } = require('../lib/db');
const { HttpError, wrap, clean } = require('../lib/helpers');
const { isValidUsername, RESERVED_USERNAMES, REPORT_REASONS } = require('../lib/text');
const { presentMe, getSettings } = require('../lib/services');
const { ensureCsrf, authLimiter, requireAuth } = require('../lib/middleware');
const social = require('../lib/purge');

const router = express.Router();

// Kullanıcı bulunamasa bile aynı sürede cevap vermek için sahte hash
const DUMMY_HASH = bcrypt.hashSync('klipo-dummy-password', 10);

function regenerate(req) {
  return new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
}

async function startSession(req, user) {
  await regenerate(req);
  req.session.uid = String(user._id);
  return ensureCsrf(req);
}

// Uygulama açılışında çağrılır: kullanıcı + CSRF belirteci + genel yapılandırma
router.get(
  '/me',
  wrap(async (req, res) => {
    const csrfToken = ensureCsrf(req);
    const settings = await getSettings();
    res.json({
      user: req.user ? presentMe(req.user) : null,
      csrf: csrfToken,
      banned: req.bannedInfo || '',
      config: {
        appName: cfg.APP_NAME,
        maxVideoMB: cfg.MAX_VIDEO_MB,
        maxImageMB: cfg.MAX_IMAGE_MB,
        reportReasons: REPORT_REASONS,
        announcement: settings.announcement ? settings.announcement.text : '',
        maintenance: settings.maintenance,
      },
    });
  })
);

router.post(
  '/register',
  authLimiter,
  wrap(async (req, res) => {
    const body = req.body || {};
    const username = clean(body.username, 30).toLowerCase();
    let nickname = clean(body.nickname, 30);
    const password = typeof body.password === 'string' ? body.password : '';

    if (!isValidUsername(username)) {
      throw new HttpError(400, 'Kullanıcı adı 3-24 karakter olmalı; yalnızca harf, rakam, nokta ve alt çizgi kullanabilirsin.');
    }
    if (!nickname) nickname = username;
    if (password.length < 6 || password.length > 72) throw new HttpError(400, 'Şifre 6-72 karakter olmalı.');

    let role = 'user';
    if (cfg.ADMIN_USERNAMES.includes(username)) {
      // ADMIN_USERNAMES listesindeki ad, ilk kaydolan kişiye yönetici yetkisiyle verilir (başka kod istenmez).
      // Ad alındıktan sonra kimse aynı adla kayıt olamaz; bu yüzden yönetici hesabını ilk iş sen aç.
      role = 'admin';
    } else if (RESERVED_USERNAMES.has(username)) {
      throw new HttpError(400, 'Bu kullanıcı adı kullanılamaz.');
    }

    const user = {
      username,
      nickname,
      password: await bcrypt.hash(password, 10),
      bio: '',
      link: '',
      avatar: '',
      banner: '',
      verified: false,
      role,
      banned: false,
      isPrivate: false,
      hideVisitors: false,
      restrictedMode: false,
      showLikes: false,
      theme: 'dark',
      allowMessages: 'everyone',
      createdAt: new Date(),
      lastActive: new Date(),
    };
    try {
      const r = await cols.users.insertOne(user);
      user._id = r.insertedId;
    } catch (e) {
      if (e.code === 11000) throw new HttpError(409, 'Bu kullanıcı adı zaten alınmış.');
      throw e;
    }
    const csrfToken = await startSession(req, user);
    res.json({ user: presentMe(user), csrf: csrfToken });
  })
);

router.post(
  '/login',
  authLimiter,
  wrap(async (req, res) => {
    const body = req.body || {};
    const username = clean(body.username, 30).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    const user = username ? await cols.users.findOne({ username }) : null;
    const ok = await bcrypt.compare(password, user ? user.password : DUMMY_HASH);
    if (!user || !ok) throw new HttpError(401, 'Kullanıcı adı veya şifre hatalı.');
    if (user.banned) {
      throw new HttpError(403, user.banReason ? 'Hesabın askıya alındı: ' + user.banReason : 'Hesabın askıya alındı.');
    }
    await cols.users.updateOne({ _id: user._id }, { $set: { lastActive: new Date() } });
    const csrfToken = await startSession(req, user);
    delete user.password;
    res.json({ user: presentMe(user), csrf: csrfToken });
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

router.post(
  '/password',
  requireAuth,
  authLimiter,
  wrap(async (req, res) => {
    const { current, next } = req.body || {};
    if (typeof next !== 'string' || next.length < 6 || next.length > 72) {
      throw new HttpError(400, 'Yeni şifre 6-72 karakter olmalı.');
    }
    const full = await cols.users.findOne({ _id: req.user._id });
    if (!(await bcrypt.compare(String(current || ''), full.password))) {
      throw new HttpError(403, 'Mevcut şifre hatalı.');
    }
    await cols.users.updateOne({ _id: req.user._id }, { $set: { password: await bcrypt.hash(next, 10) } });
    res.json({ ok: true });
  })
);

router.post(
  '/delete-account',
  requireAuth,
  authLimiter,
  wrap(async (req, res) => {
    const full = await cols.users.findOne({ _id: req.user._id });
    if (!(await bcrypt.compare(String((req.body || {}).password || ''), full.password))) {
      throw new HttpError(403, 'Şifre hatalı.');
    }
    if (full.role === 'admin') {
      const admins = await cols.users.countDocuments({ role: 'admin', banned: { $ne: true } });
      if (admins <= 1) throw new HttpError(400, 'Son yönetici hesabı silinemez.');
    }
    await social.purgeUser(full._id);
    await new Promise((resolve) => req.session.destroy(() => resolve()));
    res.clearCookie('klipo.sid');
    res.json({ ok: true });
  })
);

module.exports = router;
