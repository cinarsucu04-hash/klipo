'use strict';
const express = require('express');
const { cols } = require('../lib/db');
const { HttpError, wrap, oid, clean, escapeRegex, pageParams } = require('../lib/helpers');
const { sid, usersById } = require('../lib/services');
const storage = require('../lib/storage');
const moderation = require('../lib/moderation');
const { uploadLimiter } = require('../lib/middleware');
const { BUILTIN } = require('../lib/sounds');

const router = express.Router();

function present(s, owner) {
  return {
    id: sid(s._id),
    name: s.name,
    url: s.url,
    duration: s.duration || 0,
    uses: s.uses || 0,
    builtin: false,
    user: owner ? { id: sid(owner._id), username: owner.username, nickname: owner.nickname } : null,
  };
}

// Ses listesi: ilk sayfada hazır sesler + en çok kullanılanlar
router.get(
  '/',
  wrap(async (req, res) => {
    const { page, limit, skip } = pageParams(req, 20, 40);
    const q = clean(req.query.q, 40);
    const filter = q ? { name: { $regex: escapeRegex(q), $options: 'i' } } : {};
    const rows = await cols.sounds.find(filter).sort({ uses: -1, createdAt: -1 }).skip(skip).limit(limit).toArray();
    const owners = await usersById(rows.map((r) => r.userId));
    const items = rows.map((r) => present(r, owners.get(sid(r.userId))));
    const builtin = page === 0 ? BUILTIN.filter((b) => !q || b.name.toLowerCase().includes(q.toLowerCase())) : [];
    res.json({ items: [...builtin, ...items], more: rows.length === limit });
  })
);

// Kendi sesini yükle (MP3, M4A, OGG, WAV)
router.post(
  '/',
  uploadLimiter,
  storage.uploadAudio,
  wrap(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Lütfen bir ses dosyası seç.');
    const body = req.body || {};
    const base = String(req.file.originalname || '').replace(/\.[^.]+$/, '');
    const name = clean(body.name, 60) || clean(base, 60) || 'Ses';
    await moderation.enforce(req, name, 'ses adı');
    const saved = await storage.save(req.file, 'audio', 'public');
    const doc = {
      userId: req.user._id,
      name,
      url: saved.url,
      duration: Math.min(600, Math.max(0, Number(body.duration) || 0)),
      uses: 0,
      createdAt: new Date(),
    };
    const r = await cols.sounds.insertOne(doc);
    doc._id = r.insertedId;
    res.json({ sound: present(doc, req.user) });
  })
);

// Sesi sil (sahibi veya yönetici); bu sesi kullanan videolar sessiz kalır
router.delete(
  '/:id',
  wrap(async (req, res) => {
    const s = await cols.sounds.findOne({ _id: oid(req.params.id, 'Geçersiz ses') });
    if (!s) throw new HttpError(404, 'Ses bulunamadı.');
    if (sid(s.userId) !== sid(req.user._id) && req.user.role !== 'admin') throw new HttpError(403, 'Bu sesi silemezsin.');
    await storage.removeByUrl(s.url);
    await cols.sounds.deleteOne({ _id: s._id });
    res.json({ ok: true });
  })
);

module.exports = router;
