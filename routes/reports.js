'use strict';
const express = require('express');
const { cols } = require('../lib/db');
const { HttpError, wrap, oid, clean } = require('../lib/helpers');
const { REPORT_REASONS } = require('../lib/text');
const { sid } = require('../lib/services');
const storage = require('../lib/storage');

const router = express.Router();

// Kullanıcı / video / yorum şikayeti (kanıt görseli isteğe bağlı)
router.post(
  '/',
  storage.uploadImage('evidence'),
  wrap(async (req, res) => {
    const me = req.user;
    const body = req.body || {};
    const type = ['user', 'video', 'comment'].includes(body.type) ? body.type : null;
    if (!type) throw new HttpError(400, 'Geçersiz şikayet türü.');
    const reason = REPORT_REASONS.includes(body.reason) ? body.reason : null;
    if (!reason) throw new HttpError(400, 'Lütfen bir şikayet nedeni seç.');
    const targetId = oid(body.targetId);

    let targetUserId;
    if (type === 'user') {
      const u = await cols.users.findOne({ _id: targetId }, { projection: { _id: 1 } });
      if (!u) throw new HttpError(404, 'Kullanıcı bulunamadı.');
      targetUserId = u._id;
    } else if (type === 'video') {
      const v = await cols.videos.findOne({ _id: targetId }, { projection: { userId: 1 } });
      if (!v) throw new HttpError(404, 'Video bulunamadı.');
      targetUserId = v.userId;
    } else {
      const c = await cols.comments.findOne({ _id: targetId }, { projection: { userId: 1 } });
      if (!c) throw new HttpError(404, 'Yorum bulunamadı.');
      targetUserId = c.userId;
    }
    if (sid(targetUserId) === sid(me._id)) throw new HttpError(400, 'Kendi içeriğini şikayet edemezsin.');

    // Aynı kişinin aynı içerik için açık şikayeti varsa tekrar kaydetme
    const dup = await cols.reports.findOne({ reporterId: me._id, type, targetId, status: 'open' });
    if (dup) return res.json({ ok: true, duplicate: true });

    let evidenceUrl = '';
    if (req.file) evidenceUrl = (await storage.save(req.file, 'image')).url;

    await cols.reports.insertOne({
      reporterId: me._id,
      type,
      targetId,
      targetUserId,
      reason,
      description: clean(body.description, 500),
      evidenceUrl,
      status: 'open',
      createdAt: new Date(),
    });
    res.json({ ok: true });
  })
);

module.exports = router;
