'use strict';
const express = require('express');
const { cols } = require('../lib/db');
const { HttpError, wrap, oid, clean, pageParams, bool } = require('../lib/helpers');
const { extractHashtags, extractMentions } = require('../lib/text');
const {
  sid, userCard, usersById, blockedIds, isBlockedEitherWay, hydrateVideos, canSeeVideo, publicVideoFilter, notify, logAdmin,
} = require('../lib/services');
const storage = require('../lib/storage');
const { uploadLimiter } = require('../lib/middleware');
const moderation = require('../lib/moderation');
const { purgeVideo, purgeComment } = require('../lib/purge');
const { parseOverlays, resolveSound, findBuiltin, cleanFilter } = require('../lib/sounds');

const router = express.Router();
const commentsRouter = express.Router();

const VISIBILITIES = ['public', 'followers', 'private'];

async function loadVisibleVideo(req) {
  const v = await cols.videos.findOne({ _id: oid(req.params.id, 'Geçersiz video') });
  if (!v || !(await canSeeVideo(v, req.user))) throw new HttpError(404, 'Video bulunamadı.');
  return v;
}

async function notifyMentions(text, actor, videoId, commentId, skipIds) {
  const names = extractMentions(text).filter((n) => n !== actor.username);
  if (!names.length) return;
  const users = await cols.users.find({ username: { $in: names }, banned: { $ne: true } }, { projection: { _id: 1 } }).toArray();
  for (const u of users) {
    if (skipIds && skipIds.has(sid(u._id))) continue;
    await notify({ userId: u._id, actorId: actor._id, type: 'mention', videoId, commentId, text });
  }
}

// ---------------------------------------------------------------- AKIŞ
router.get(
  '/feed',
  wrap(async (req, res) => {
    const type = ['foryou', 'following', 'friends', 'new'].includes(req.query.type) ? req.query.type : 'foryou';
    const { skip, limit } = pageParams(req, 8, 20);
    const blocked = await blockedIds(req.user._id);
    const blockedSet = new Set(blocked.map(sid));
    const hidden = (req.user.hiddenVideos || []).slice(-500);
    let list;

    if (type === 'following') {
      const follows = await cols.follows.find({ followerId: req.user._id }, { projection: { followingId: 1 } }).toArray();
      const ids = follows.map((f) => f.followingId).filter((id) => !blockedSet.has(sid(id)));
      if (!ids.length) return res.json({ videos: [], hasMore: false });
      const filter = { userId: { $in: ids }, visibility: { $in: ['public', 'followers'] }, removed: { $ne: true } };
      if (req.user.restrictedMode) filter.sensitive = { $ne: true };
      list = await cols.videos.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit + 1).toArray();
    } else if (type === 'friends') {
      // arkadaşlar: karşılıklı takipleştiklerin
      const mine = await cols.follows.find({ followerId: req.user._id }, { projection: { followingId: 1 } }).toArray();
      const myIds = mine.map((f) => f.followingId).filter((id) => !blockedSet.has(sid(id)));
      const back = myIds.length
        ? await cols.follows.find({ followerId: { $in: myIds }, followingId: req.user._id }, { projection: { followerId: 1 } }).toArray()
        : [];
      const ids = back.map((f) => f.followerId);
      if (!ids.length) return res.json({ videos: [], hasMore: false });
      const filter = { userId: { $in: ids }, visibility: { $in: ['public', 'followers'] }, removed: { $ne: true } };
      if (req.user.restrictedMode) filter.sensitive = { $ne: true };
      list = await cols.videos.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit + 1).toArray();
    } else if (type === 'new') {
      list = await cols.videos
        .find({ ...publicVideoFilter(req.user, blocked), ...(hidden.length ? { _id: { $nin: hidden } } : {}) })
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit + 1)
        .toArray();
    } else {
      // "Sizin için": etkileşim puanı / zaman aşımı (yeni ve popüler videolar üstte)
      const now = Date.now();
      const match = { ...publicVideoFilter(req.user, blocked), createdAt: { $gte: new Date(now - 60 * 86400000) } };
      if (hidden.length) match._id = { $nin: hidden };
      list = await cols.videos
        .aggregate([
          { $match: match },
          {
            $addFields: {
              score: {
                $add: [
                  { $cond: [{ $eq: ['$featured', true] }, 1000, 0] },
                  {
                    $divide: [
                      {
                        $add: [
                          { $multiply: ['$likes', 3] },
                          { $multiply: ['$comments', 4] },
                          { $multiply: ['$shares', 5] },
                          { $multiply: ['$saves', 4] },
                          { $multiply: ['$views', 0.3] },
                          4,
                        ],
                      },
                      {
                        $pow: [
                          { $add: [{ $max: [{ $divide: [{ $subtract: [new Date(now), '$createdAt'] }, 3600000] }, 0] }, 2] },
                          1.25,
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          },
          { $sort: { score: -1, _id: -1 } },
          { $skip: skip },
          { $limit: limit + 1 },
        ])
        .toArray();
    }

    const hasMore = list.length > limit;
    list = list.slice(0, limit);
    res.json({ videos: await hydrateVideos(list, req.user), hasMore });
  })
);

// ---------------------------------------------------------------- YÜKLEME
router.post(
  '/',
  uploadLimiter,
  storage.uploadVideo,
  wrap(async (req, res) => {
    const vf = req.files && req.files.video && req.files.video[0];
    if (!vf) throw new HttpError(400, 'Lütfen bir video dosyası seç.');
    const body = req.body || {};
    const caption = clean(body.caption, 300);
    let visibility = VISIBILITIES.includes(body.visibility) ? body.visibility : 'public';
    if (req.user.isPrivate && visibility === 'public') visibility = 'followers';

    const overlays = parseOverlays(body.overlays);
    await moderation.enforce(req, [caption, clean(body.song, 60)].concat(overlays.map((o) => o.t)).join(' \n '), 'video');
    const sound = await resolveSound(body.soundId, body.musicVol, body.origVol);

    // düet: orijinal video herkese açık, silinmemiş, düete açık ve kendisi düet olmamalı
    let duetOf = null;
    if (body.duetOf) {
      const orig = await cols.videos.findOne({ _id: oid(body.duetOf, 'Geçersiz düet videosu') });
      if (!orig || orig.removed || orig.visibility !== 'public' || orig.ownerPrivate) throw new HttpError(404, 'Düet yapılacak video bulunamadı.');
      if (await isBlockedEitherWay(req.user._id, orig.userId)) throw new HttpError(403, 'Bu videoyla düet yapamazsın.');
      if (orig.allowDuet === false) throw new HttpError(403, 'Video sahibi düete izin vermiyor.');
      if (orig.duetOf) throw new HttpError(400, 'Düet videosuyla düet yapılamaz.');
      duetOf = orig;
    }

    const savedVideo = await storage.save(vf, 'video', 'video');
    let posterUrl = '';
    const pf = req.files.poster && req.files.poster[0];
    if (pf && pf.size <= 2 * 1024 * 1024) {
      try {
        posterUrl = (await storage.save(pf, 'image', 'video')).url;
      } catch (e) {
        posterUrl = '';
      }
    }

    const doc = {
      userId: req.user._id,
      caption,
      hashtags: extractHashtags(caption),
      mediaUrl: savedVideo.url,
      posterUrl,
      duration: Math.min(3600, Math.max(0, Number(body.duration) || 0)),
      song: clean(body.song, 60) || (sound && sound.name) || 'Orijinal ses - ' + (req.user.nickname || req.user.username),
      sound,
      overlays,
      visibility,
      ownerPrivate: !!req.user.isPrivate,
      allowComments: bool(body.allowComments, true),
      allowDuet: bool(body.allowDuet, true),
      allowDownload: bool(body.allowDownload, true),
      filter: cleanFilter(body.filter),
      duetOf: duetOf ? duetOf._id : null,
      sensitive: false,
      featured: false,
      removed: false,
      profilePinned: false,
      views: 0,
      likes: 0,
      comments: 0,
      shares: 0,
      saves: 0,
      createdAt: new Date(),
    };
    const r = await cols.videos.insertOne(doc);
    doc._id = r.insertedId;
    if (visibility !== 'private') await notifyMentions(caption, req.user, doc._id, null);
    if (duetOf && visibility !== 'private') await notify({ userId: duetOf.userId, actorId: req.user._id, type: 'duet', videoId: doc._id });
    const [video] = await hydrateVideos([doc], req.user);
    res.json({ video });
  })
);

// ---------------------------------------------------------------- SES SAYFASI
router.get(
  '/by-sound/:sid',
  wrap(async (req, res) => {
    const soundId = clean(req.params.sid, 40);
    const { skip, limit } = pageParams(req, 12, 30);
    const blocked = await blockedIds(req.user._id);
    const list = await cols.videos
      .find({ ...publicVideoFilter(req.user, blocked), 'sound.id': soundId })
      .sort({ likes: -1, createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit + 1)
      .toArray();
    let sound = findBuiltin(soundId);
    if (!sound) {
      const id = /^[a-f0-9]{24}$/i.test(soundId) ? oid(soundId) : null;
      const d = id ? await cols.sounds.findOne({ _id: id }) : null;
      if (d) sound = { id: soundId, name: d.name, url: d.url };
    }
    if (!sound && !list.length) throw new HttpError(404, 'Ses bulunamadı.');
    const total = await cols.videos.countDocuments({ ...publicVideoFilter(req.user, blocked), 'sound.id': soundId });
    const hasMore = list.length > limit;
    res.json({
      sound: sound ? { id: sound.id, name: sound.name, url: sound.url } : null,
      total,
      videos: await hydrateVideos(list.slice(0, limit), req.user),
      hasMore,
    });
  })
);

// "İlgilenmiyorum": video bu kişinin akışında bir daha çıkmaz
router.post(
  '/:id/hide',
  wrap(async (req, res) => {
    const v = await loadVisibleVideo(req);
    await cols.users.updateOne({ _id: req.user._id }, { $push: { hiddenVideos: { $each: [v._id], $slice: -500 } } });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------- TEK VİDEO
router.get(
  '/:id',
  wrap(async (req, res) => {
    const v = await loadVisibleVideo(req);
    const [video] = await hydrateVideos([v], req.user);
    if (!video) throw new HttpError(404, 'Video bulunamadı.');
    res.json({ video });
  })
);

router.patch(
  '/:id',
  wrap(async (req, res) => {
    const v = await cols.videos.findOne({ _id: oid(req.params.id) });
    if (!v || sid(v.userId) !== sid(req.user._id)) throw new HttpError(404, 'Video bulunamadı.');
    const body = req.body || {};
    const set = {};
    if (body.caption !== undefined) {
      set.caption = clean(body.caption, 300);
      await moderation.enforce(req, set.caption, 'video');
      set.hashtags = extractHashtags(set.caption);
    }
    if (VISIBILITIES.includes(body.visibility)) {
      set.visibility = req.user.isPrivate && body.visibility === 'public' ? 'followers' : body.visibility;
    }
    if (body.allowComments !== undefined) set.allowComments = bool(body.allowComments, true);
    if (body.allowDuet !== undefined) set.allowDuet = bool(body.allowDuet, true);
    if (body.allowDownload !== undefined) set.allowDownload = bool(body.allowDownload, true);
    if (Object.keys(set).length) await cols.videos.updateOne({ _id: v._id }, { $set: set });
    const fresh = await cols.videos.findOne({ _id: v._id });
    const [video] = await hydrateVideos([fresh], req.user);
    res.json({ video });
  })
);

router.delete(
  '/:id',
  wrap(async (req, res) => {
    const v = await cols.videos.findOne({ _id: oid(req.params.id) });
    if (!v) throw new HttpError(404, 'Video bulunamadı.');
    const mine = sid(v.userId) === sid(req.user._id);
    if (!mine && req.user.role !== 'admin') throw new HttpError(403, 'Bu videoyu silemezsin.');
    await purgeVideo(v);
    if (!mine) await logAdmin(req.user, 'Video silindi', `video:${sid(v._id)} sahibi:${sid(v.userId)}`);
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------- ETKİLEŞİM
router.post(
  '/:id/like',
  wrap(async (req, res) => {
    const v = await loadVisibleVideo(req);
    const filter = { userId: req.user._id, videoId: v._id };
    const del = await cols.likes.deleteOne(filter);
    let liked;
    if (del.deletedCount) {
      liked = false;
      await cols.videos.updateOne({ _id: v._id }, { $inc: { likes: -1 } });
    } else {
      liked = true;
      try {
        await cols.likes.insertOne({ ...filter, createdAt: new Date() });
        await cols.videos.updateOne({ _id: v._id }, { $inc: { likes: 1 } });
        await notify({ userId: v.userId, actorId: req.user._id, type: 'like', videoId: v._id });
      } catch (e) {
        if (e.code !== 11000) throw e; // çift tıklama: zaten beğenilmiş
      }
    }
    const cur = await cols.videos.findOne({ _id: v._id }, { projection: { likes: 1 } });
    res.json({ liked, likes: Math.max(0, (cur && cur.likes) || 0) });
  })
);

router.post(
  '/:id/save',
  wrap(async (req, res) => {
    const v = await loadVisibleVideo(req);
    const filter = { userId: req.user._id, videoId: v._id };
    const del = await cols.saves.deleteOne(filter);
    let saved;
    if (del.deletedCount) {
      saved = false;
      await cols.videos.updateOne({ _id: v._id }, { $inc: { saves: -1 } });
    } else {
      saved = true;
      try {
        await cols.saves.insertOne({ ...filter, createdAt: new Date() });
        await cols.videos.updateOne({ _id: v._id }, { $inc: { saves: 1 } });
      } catch (e) {
        if (e.code !== 11000) throw e;
      }
    }
    const cur = await cols.videos.findOne({ _id: v._id }, { projection: { saves: 1 } });
    res.json({ saved, saves: Math.max(0, (cur && cur.saves) || 0) });
  })
);

router.post(
  '/:id/share',
  wrap(async (req, res) => {
    const v = await loadVisibleVideo(req);
    const cur = await cols.videos.findOneAndUpdate({ _id: v._id }, { $inc: { shares: 1 } }, { returnDocument: 'after' });
    res.json({ shares: (cur && cur.shares) || 0 });
  })
);

// Benzersiz izleyici başına bir kez sayılır; izleme geçmişini de besler
router.post(
  '/:id/view',
  wrap(async (req, res) => {
    const v = await loadVisibleVideo(req);
    if (sid(v.userId) !== sid(req.user._id)) {
      const r = await cols.history.updateOne(
        { userId: req.user._id, videoId: v._id },
        { $set: { viewedAt: new Date() } },
        { upsert: true }
      );
      if (r.upsertedCount) await cols.videos.updateOne({ _id: v._id }, { $inc: { views: 1 } });
    }
    res.json({ ok: true });
  })
);

// Profilde en üste sabitle (en fazla 3)
router.post(
  '/:id/pin',
  wrap(async (req, res) => {
    const v = await cols.videos.findOne({ _id: oid(req.params.id) });
    if (!v || sid(v.userId) !== sid(req.user._id)) throw new HttpError(404, 'Video bulunamadı.');
    if (v.profilePinned) {
      await cols.videos.updateOne({ _id: v._id }, { $set: { profilePinned: false } });
      return res.json({ pinned: false });
    }
    const count = await cols.videos.countDocuments({ userId: req.user._id, profilePinned: true });
    if (count >= 3) throw new HttpError(400, 'Profilinde en fazla 3 video sabitleyebilirsin.');
    await cols.videos.updateOne({ _id: v._id }, { $set: { profilePinned: true } });
    res.json({ pinned: true });
  })
);

// ---------------------------------------------------------------- YORUMLAR
async function presentComments(list, me, video) {
  if (!list.length) return [];
  const users = await usersById(list.map((c) => c.userId));
  const likes = await cols.commentLikes
    .find({ userId: me._id, commentId: { $in: list.map((c) => c._id) } }, { projection: { commentId: 1 } })
    .toArray();
  const likedSet = new Set(likes.map((l) => sid(l.commentId)));
  const isVideoOwner = sid(video.userId) === sid(me._id);
  return list
    .filter((c) => users.has(sid(c.userId)))
    .map((c) => {
      const mine = sid(c.userId) === sid(me._id);
      return {
        id: sid(c._id),
        user: userCard(users.get(sid(c.userId))),
        text: c.text,
        likes: c.likes || 0,
        liked: likedSet.has(sid(c._id)),
        pinned: !!c.pinned,
        replyCount: c.replyCount || 0,
        parentId: c.parentId ? sid(c.parentId) : null,
        createdAt: c.createdAt,
        mine,
        canDelete: mine || isVideoOwner || me.role === 'admin',
        canPin: isVideoOwner && !c.parentId,
      };
    });
}

router.get(
  '/:id/comments',
  wrap(async (req, res) => {
    const v = await loadVisibleVideo(req);
    const { skip, limit } = pageParams(req, 20, 40);
    const blocked = await blockedIds(req.user._id);
    const filter = { videoId: v._id, parentId: null };
    if (blocked.length) filter.userId = { $nin: blocked };
    let list = await cols.comments.find(filter).sort({ pinned: -1, _id: -1 }).skip(skip).limit(limit + 1).toArray();
    const hasMore = list.length > limit;
    list = list.slice(0, limit);
    res.json({ comments: await presentComments(list, req.user, v), hasMore, allowComments: v.allowComments !== false });
  })
);

router.post(
  '/:id/comments',
  wrap(async (req, res) => {
    const v = await loadVisibleVideo(req);
    if (v.allowComments === false && sid(v.userId) !== sid(req.user._id)) {
      throw new HttpError(403, 'Bu videoda yorumlar kapalı.');
    }
    const body = req.body || {};
    const text = clean(body.text, 500);
    if (!text) throw new HttpError(400, 'Yorum boş olamaz.');
    await moderation.enforce(req, text, 'yorum', { contact: true, links: true });

    let parent = null;
    if (body.parentId) {
      parent = await cols.comments.findOne({ _id: oid(body.parentId), videoId: v._id });
      if (!parent) throw new HttpError(404, 'Yanıtlanan yorum bulunamadı.');
    }
    const rootId = parent ? parent.parentId || parent._id : null;

    const doc = {
      videoId: v._id,
      userId: req.user._id,
      parentId: rootId,
      text,
      likes: 0,
      replyCount: 0,
      pinned: false,
      createdAt: new Date(),
    };
    const r = await cols.comments.insertOne(doc);
    doc._id = r.insertedId;
    await cols.videos.updateOne({ _id: v._id }, { $inc: { comments: 1 } });
    if (rootId) await cols.comments.updateOne({ _id: rootId }, { $inc: { replyCount: 1 } });

    const notified = new Set();
    if (parent) {
      await notify({ userId: parent.userId, actorId: req.user._id, type: 'reply', videoId: v._id, commentId: doc._id, text });
      notified.add(sid(parent.userId));
    }
    if (!notified.has(sid(v.userId))) {
      await notify({ userId: v.userId, actorId: req.user._id, type: 'comment', videoId: v._id, commentId: doc._id, text });
      notified.add(sid(v.userId));
    }
    await notifyMentions(text, req.user, v._id, doc._id, notified);

    const [comment] = await presentComments([doc], req.user, v);
    res.json({ comment });
  })
);

// ---- yorum işlemleri (/api/comments/...)
async function loadComment(req) {
  const c = await cols.comments.findOne({ _id: oid(req.params.id, 'Geçersiz yorum') });
  if (!c) throw new HttpError(404, 'Yorum bulunamadı.');
  const v = await cols.videos.findOne({ _id: c.videoId });
  if (!v || !(await canSeeVideo(v, req.user))) throw new HttpError(404, 'Yorum bulunamadı.');
  return { c, v };
}

commentsRouter.get(
  '/:id/replies',
  wrap(async (req, res) => {
    const { c, v } = await loadComment(req);
    const { skip, limit } = pageParams(req, 20, 40);
    const blocked = await blockedIds(req.user._id);
    const filter = { parentId: c._id };
    if (blocked.length) filter.userId = { $nin: blocked };
    let list = await cols.comments.find(filter).sort({ _id: 1 }).skip(skip).limit(limit + 1).toArray();
    const hasMore = list.length > limit;
    list = list.slice(0, limit);
    res.json({ comments: await presentComments(list, req.user, v), hasMore });
  })
);

commentsRouter.delete(
  '/:id',
  wrap(async (req, res) => {
    const { c, v } = await loadComment(req);
    const mine = sid(c.userId) === sid(req.user._id);
    const owner = sid(v.userId) === sid(req.user._id);
    if (!mine && !owner && req.user.role !== 'admin') throw new HttpError(403, 'Bu yorumu silemezsin.');
    const removed = await purgeComment(c);
    if (!mine && !owner) await logAdmin(req.user, 'Yorum silindi', `yorum:${sid(c._id)} kullanıcı:${sid(c.userId)}`);
    res.json({ ok: true, removed });
  })
);

commentsRouter.post(
  '/:id/like',
  wrap(async (req, res) => {
    const { c, v } = await loadComment(req);
    const filter = { userId: req.user._id, commentId: c._id };
    const del = await cols.commentLikes.deleteOne(filter);
    let liked;
    if (del.deletedCount) {
      liked = false;
      await cols.comments.updateOne({ _id: c._id }, { $inc: { likes: -1 } });
    } else {
      liked = true;
      try {
        await cols.commentLikes.insertOne({ ...filter, createdAt: new Date() });
        await cols.comments.updateOne({ _id: c._id }, { $inc: { likes: 1 } });
        await notify({ userId: c.userId, actorId: req.user._id, type: 'comment_like', videoId: v._id, commentId: c._id });
      } catch (e) {
        if (e.code !== 11000) throw e;
      }
    }
    const cur = await cols.comments.findOne({ _id: c._id }, { projection: { likes: 1 } });
    res.json({ liked, likes: Math.max(0, (cur && cur.likes) || 0) });
  })
);

commentsRouter.post(
  '/:id/pin',
  wrap(async (req, res) => {
    const { c, v } = await loadComment(req);
    if (sid(v.userId) !== sid(req.user._id)) throw new HttpError(403, 'Yalnızca video sahibi yorum sabitleyebilir.');
    if (c.parentId) throw new HttpError(400, 'Yanıtlar sabitlenemez.');
    if (c.pinned) {
      await cols.comments.updateOne({ _id: c._id }, { $set: { pinned: false } });
      return res.json({ pinned: false });
    }
    await cols.comments.updateMany({ videoId: v._id, pinned: true }, { $set: { pinned: false } });
    await cols.comments.updateOne({ _id: c._id }, { $set: { pinned: true } });
    res.json({ pinned: true });
  })
);

module.exports = { videos: router, comments: commentsRouter };
