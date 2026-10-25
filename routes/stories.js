'use strict';
const express = require('express');
const { cols } = require('../lib/db');
const { HttpError, wrap, oid, clean } = require('../lib/helpers');
const { sid, userCard, usersById, blockedIds, isBlockedEitherWay } = require('../lib/services');
const storage = require('../lib/storage');
const moderation = require('../lib/moderation');
const { uploadLimiter } = require('../lib/middleware');
const { purgeStory } = require('../lib/purge');
const { findOrCreateDm, postMessage } = require('../lib/chats');

const router = express.Router();
const DAY = 24 * 3600 * 1000;

async function presentStories(list, me) {
  if (!list.length) return [];
  const views = await cols.storyViews
    .find({ userId: me._id, storyId: { $in: list.map((s) => s._id) } }, { projection: { storyId: 1 } })
    .toArray();
  const seen = new Set(views.map((v) => sid(v.storyId)));
  return list.map((s) => ({
    id: sid(s._id),
    userId: sid(s.userId),
    mediaUrl: s.mediaUrl,
    mediaType: s.mediaType,
    caption: s.caption || '',
    createdAt: s.createdAt,
    seen: seen.has(sid(s._id)),
    views: sid(s.userId) === sid(me._id) ? s.views || 0 : undefined,
  }));
}

async function loadActiveStory(req) {
  const s = await cols.stories.findOne({ _id: oid(req.params.id, 'Geçersiz hikaye') });
  if (!s || new Date(s.createdAt).getTime() < Date.now() - DAY) throw new HttpError(404, 'Hikaye bulunamadı.');
  return s;
}

// Hikayeyi görme yetkisi: engel yok + (hesap herkese açık ya da takip ediliyor)
async function assertCanSee(story, me) {
  if (sid(story.userId) === sid(me._id) || me.role === 'admin') return;
  if (await isBlockedEitherWay(me._id, story.userId)) throw new HttpError(404, 'Hikaye bulunamadı.');
  const owner = await cols.users.findOne({ _id: story.userId }, { projection: { isPrivate: 1 } });
  if (!owner) throw new HttpError(404, 'Hikaye bulunamadı.');
  if (owner.isPrivate) {
    const f = await cols.follows.findOne({ followerId: me._id, followingId: story.userId });
    if (!f) throw new HttpError(403, 'Bu hikayeyi göremezsin.');
  }
}

// Kendi + takip edilenlerin aktif hikayeleri
router.get(
  '/',
  wrap(async (req, res) => {
    const me = req.user;
    const blocked = new Set((await blockedIds(me._id)).map(sid));
    const follows = await cols.follows.find({ followerId: me._id }, { projection: { followingId: 1 } }).toArray();
    const ids = [me._id, ...follows.map((f) => f.followingId).filter((id) => !blocked.has(sid(id)))];
    const since = new Date(Date.now() - DAY);
    const stories = await cols.stories.find({ userId: { $in: ids }, createdAt: { $gte: since } }).sort({ createdAt: 1 }).toArray();

    const byUser = new Map();
    for (const s of stories) {
      const k = sid(s.userId);
      if (!byUser.has(k)) byUser.set(k, []);
      byUser.get(k).push(s);
    }
    const users = await usersById([...byUser.keys()]);
    let mine = null;
    const groups = [];
    for (const [uid, list] of byUser) {
      const u = users.get(uid);
      if (!u) continue;
      const presented = await presentStories(list, me);
      const group = {
        user: userCard(u),
        stories: presented,
        allSeen: presented.every((s) => s.seen),
        latest: list[list.length - 1].createdAt,
      };
      if (uid === sid(me._id)) mine = group;
      else groups.push(group);
    }
    groups.sort((a, b) => Number(a.allSeen) - Number(b.allSeen) || new Date(b.latest) - new Date(a.latest));
    res.json({ mine, groups });
  })
);

router.post(
  '/',
  uploadLimiter,
  storage.uploadStory,
  wrap(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Bir fotoğraf veya video seç.');
    const caption = clean((req.body || {}).caption, 120);
    await moderation.enforce(req, caption, 'hikaye');
    const saved = await storage.save(req.file, 'media');
    const doc = {
      userId: req.user._id,
      mediaUrl: saved.url,
      mediaType: saved.isVideo ? 'video' : 'image',
      caption: caption,
      views: 0,
      createdAt: new Date(),
    };
    const r = await cols.stories.insertOne(doc);
    doc._id = r.insertedId;
    const [story] = await presentStories([doc], req.user);
    res.json({ story });
  })
);

router.post(
  '/:id/view',
  wrap(async (req, res) => {
    const s = await loadActiveStory(req);
    await assertCanSee(s, req.user);
    const r = await cols.storyViews.updateOne(
      { storyId: s._id, userId: req.user._id },
      { $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    if (r.upsertedCount && sid(s.userId) !== sid(req.user._id)) {
      await cols.stories.updateOne({ _id: s._id }, { $inc: { views: 1 } });
    }
    res.json({ ok: true });
  })
);

router.get(
  '/:id/viewers',
  wrap(async (req, res) => {
    const s = await loadActiveStory(req);
    if (sid(s.userId) !== sid(req.user._id) && req.user.role !== 'admin') throw new HttpError(403, 'Yetkin yok.');
    const rows = await cols.storyViews.find({ storyId: s._id }).sort({ _id: -1 }).limit(100).toArray();
    const users = await usersById(rows.map((r) => r.userId));
    res.json({
      viewers: rows.filter((r) => users.has(sid(r.userId))).map((r) => ({ user: userCard(users.get(sid(r.userId))), at: r.createdAt })),
    });
  })
);

router.delete(
  '/:id',
  wrap(async (req, res) => {
    const s = await cols.stories.findOne({ _id: oid(req.params.id) });
    if (!s) throw new HttpError(404, 'Hikaye bulunamadı.');
    if (sid(s.userId) !== sid(req.user._id) && req.user.role !== 'admin') throw new HttpError(403, 'Bu hikayeyi silemezsin.');
    await purgeStory(s);
    res.json({ ok: true });
  })
);

// Hikayeye yanıt → sahibine özel mesaj olarak gider
router.post(
  '/:id/reply',
  wrap(async (req, res) => {
    const s = await loadActiveStory(req);
    if (sid(s.userId) === sid(req.user._id)) throw new HttpError(400, 'Kendi hikayene yanıt veremezsin.');
    await assertCanSee(s, req.user);
    const text = clean((req.body || {}).text, 500);
    if (!text) throw new HttpError(400, 'Mesaj boş olamaz.');
    await moderation.enforce(req, text, 'mesaj');
    const owner = await cols.users.findOne({ _id: s.userId, banned: { $ne: true } });
    if (!owner) throw new HttpError(404, 'Kullanıcı bulunamadı.');
    const chat = await findOrCreateDm(req.user, owner);
    await postMessage(chat, req.user, {
      text,
      storyRef: { id: sid(s._id), mediaUrl: s.mediaUrl, mediaType: s.mediaType },
    });
    res.json({ ok: true, chatId: sid(chat._id) });
  })
);

module.exports = router;
module.exports.presentStories = presentStories;
