'use strict';
const express = require('express');
const { cols } = require('../lib/db');
const { HttpError, wrap } = require('../lib/helpers');
const push = require('../lib/push');

const router = express.Router();

router.get('/key', (req, res, next) => {
  if (!push.state.ready) return next(new HttpError(503, 'Bildirim servisi hazır değil.'));
  res.json({ publicKey: push.state.publicKey });
});

// Bu cihazı bildirimlere abone et
router.post(
  '/subscribe',
  wrap(async (req, res) => {
    const sub = req.body && req.body.subscription;
    const endpoint = sub && typeof sub.endpoint === 'string' ? sub.endpoint : '';
    const keys = sub && sub.keys;
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 600 || !keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' || keys.p256dh.length > 200 || keys.auth.length > 100) {
      throw new HttpError(400, 'Geçersiz bildirim aboneliği.');
    }
    await cols.pushSubs.updateOne(
      { endpoint },
      { $set: { userId: req.user._id, keys: { p256dh: keys.p256dh, auth: keys.auth }, ua: String(req.get('user-agent') || '').slice(0, 160), updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    // kullanıcı başına en fazla 10 cihaz: en eskileri sil
    const all = await cols.pushSubs.find({ userId: req.user._id }, { projection: { _id: 1 } }).sort({ updatedAt: -1 }).toArray();
    if (all.length > 10) await cols.pushSubs.deleteMany({ _id: { $in: all.slice(10).map((s) => s._id) } });
    res.json({ ok: true });
  })
);

router.post(
  '/unsubscribe',
  wrap(async (req, res) => {
    const endpoint = req.body && typeof req.body.endpoint === 'string' ? req.body.endpoint : '';
    if (endpoint) await cols.pushSubs.deleteOne({ endpoint, userId: req.user._id });
    res.json({ ok: true });
  })
);

// Ayarlardaki "Test bildirimi gönder"
router.post(
  '/test',
  wrap(async (req, res) => {
    const sent = await push.sendToUser(req.user._id, { title: 'Klipo', body: 'Bildirimler çalışıyor 🎉', url: '/#/inbox', tag: 'test' });
    res.json({ sent });
  })
);

module.exports = router;
