'use strict';
const express = require('express');
const { cols } = require('../lib/db');
const { HttpError, wrap, oid, clean, bool, pageParams } = require('../lib/helpers');
const { isHttpUrl } = require('../lib/text');
const { sid, userCard, usersById, presentMe, hydrateVideos, notify } = require('../lib/services');
const storage = require('../lib/storage');
const moderation = require('../lib/moderation');

const router = express.Router();

// Profil bilgileri + avatar/banner (multipart)
router.patch(
  '/',
  storage.uploadProfile,
  wrap(async (req, res) => {
    const body = req.body || {};
    const set = {};
    const old = [];

    if (body.nickname !== undefined) {
      const nick = clean(body.nickname, 30);
      if (!nick) throw new HttpError(400, 'Görünen ad boş olamaz.');
      await moderation.enforce(req, nick, 'görünen ad');
      set.nickname = nick;
    }
    if (body.bio !== undefined) {
      set.bio = clean(body.bio, 200);
      await moderation.enforce(req, set.bio, 'biyografi');
    }
    if (body.accountType !== undefined) set.accountType = body.accountType === 'rp' ? 'rp' : 'real';
    if (body.link !== undefined) {
      const link = clean(body.link, 200);
      if (link && !isHttpUrl(link)) throw new HttpError(400, 'Bağlantı http:// veya https:// ile başlamalı.');
      set.link = link;
    }

    const files = req.files || {};
    for (const field of ['avatar', 'banner']) {
      const f = files[field] && files[field][0];
      if (f) {
        const saved = await storage.save(f, 'image', 'public');
        if (req.user[field]) old.push(req.user[field]);
        set[field] = saved.url;
      } else if (bool(body['remove' + field[0].toUpperCase() + field.slice(1)])) {
        if (req.user[field]) old.push(req.user[field]);
        set[field] = '';
      }
    }

    if (Object.keys(set).length) await cols.users.updateOne({ _id: req.user._id }, { $set: set });
    await storage.removeMany(old);
    const fresh = await cols.users.findOne({ _id: req.user._id }, { projection: { password: 0 } });
    res.json({ user: presentMe(fresh) });
  })
);

// Gizlilik ve tercih ayarları
router.patch(
  '/settings',
  wrap(async (req, res) => {
    const b = req.body || {};
    const set = {};
    for (const key of ['hideVisitors', 'restrictedMode', 'showLikes']) {
      if (b[key] !== undefined) set[key] = bool(b[key]);
    }
    if (b.theme !== undefined) {
      if (!['dark', 'light', 'system'].includes(b.theme)) throw new HttpError(400, 'Geçersiz tema.');
      set.theme = b.theme;
    }
    if (b.allowMessages !== undefined) {
      if (!['everyone', 'following', 'none'].includes(b.allowMessages)) throw new HttpError(400, 'Geçersiz seçenek.');
      set.allowMessages = b.allowMessages;
    }

    if (b.isPrivate !== undefined) {
      const priv = bool(b.isPrivate);
      set.isPrivate = priv;
      if (priv !== !!req.user.isPrivate) {
        await cols.videos.updateMany({ userId: req.user._id }, { $set: { ownerPrivate: priv } });
        if (!priv) {
          // hesap herkese açıldı: bekleyen takip isteklerini otomatik kabul et
          const pending = await cols.followRequests.find({ toId: req.user._id }).toArray();
          if (pending.length) {
            await cols.follows.bulkWrite(
              pending.map((r) => ({
                updateOne: {
                  filter: { followerId: r.fromId, followingId: req.user._id },
                  update: { $setOnInsert: { createdAt: new Date() } },
                  upsert: true,
                },
              })),
              { ordered: false }
            );
            await cols.followRequests.deleteMany({ toId: req.user._id });
          }
        }
      }
    }

    if (Object.keys(set).length) await cols.users.updateOne({ _id: req.user._id }, { $set: set });
    const fresh = await cols.users.findOne({ _id: req.user._id }, { projection: { password: 0 } });
    res.json({ user: presentMe(fresh) });
  })
);

// ---- takip istekleri (özel hesaplar için)
router.get(
  '/follow-requests',
  wrap(async (req, res) => {
    const rows = await cols.followRequests.find({ toId: req.user._id }).sort({ _id: -1 }).limit(100).toArray();
    const users = await usersById(rows.map((r) => r.fromId));
    res.json({
      requests: rows.filter((r) => users.has(sid(r.fromId))).map((r) => ({ user: userCard(users.get(sid(r.fromId))), createdAt: r.createdAt })),
    });
  })
);

router.post(
  '/follow-requests/:userId/accept',
  wrap(async (req, res) => {
    const fromId = oid(req.params.userId);
    const del = await cols.followRequests.deleteOne({ fromId, toId: req.user._id });
    if (!del.deletedCount) throw new HttpError(404, 'İstek bulunamadı.');
    await cols.follows.updateOne(
      { followerId: fromId, followingId: req.user._id },
      { $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    await notify({ userId: fromId, actorId: req.user._id, type: 'follow_accepted' });
    res.json({ ok: true });
  })
);

router.post(
  '/follow-requests/:userId/decline',
  wrap(async (req, res) => {
    await cols.followRequests.deleteOne({ fromId: oid(req.params.userId), toId: req.user._id });
    res.json({ ok: true });
  })
);

// ---- profilime bakanlar
router.get(
  '/visitors',
  wrap(async (req, res) => {
    const rows = await cols.visitors.find({ profileId: req.user._id }).sort({ visitedAt: -1 }).limit(60).toArray();
    const users = await usersById(rows.map((r) => r.visitorId));
    res.json({
      visitors: rows.filter((r) => users.has(sid(r.visitorId))).map((r) => ({ user: userCard(users.get(sid(r.visitorId))), at: r.visitedAt })),
      hidden: !!req.user.hideVisitors,
    });
  })
);

// ---- izleme geçmişi
router.get(
  '/history',
  wrap(async (req, res) => {
    const { skip, limit } = pageParams(req, 18, 40);
    const rows = await cols.history.find({ userId: req.user._id }).sort({ viewedAt: -1 }).skip(skip).limit(limit + 1).toArray();
    const hasMore = rows.length > limit;
    const ids = rows.slice(0, limit).map((r) => r.videoId);
    const found = await cols.videos
      .find({ _id: { $in: ids }, removed: { $ne: true }, $or: [{ visibility: 'public', ownerPrivate: { $ne: true } }, { userId: req.user._id }] })
      .toArray();
    const order = new Map(ids.map((id, i) => [sid(id), i]));
    found.sort((a, b) => order.get(sid(a._id)) - order.get(sid(b._id)));
    res.json({ videos: await hydrateVideos(found, req.user), hasMore });
  })
);

router.delete(
  '/history',
  wrap(async (req, res) => {
    await cols.history.deleteMany({ userId: req.user._id });
    res.json({ ok: true });
  })
);

// ---- engellenenler
router.get(
  '/blocks',
  wrap(async (req, res) => {
    const rows = await cols.blocks.find({ userId: req.user._id }).sort({ _id: -1 }).limit(200).toArray();
    const users = await usersById(rows.map((r) => r.targetId));
    res.json({ users: rows.filter((r) => users.has(sid(r.targetId))).map((r) => userCard(users.get(sid(r.targetId)))) });
  })
);

// Yaratıcı analitiği: toplamlar, son 7 gün ve en çok izlenen videolar
router.get(
  '/analytics',
  wrap(async (req, res) => {
    const me = req.user;
    const DAY = 86400000;
    const since = new Date(Date.now() - 7 * DAY);
    const vids = await cols.videos
      .find({ userId: me._id, removed: { $ne: true } }, { projection: { posterUrl: 1, caption: 1, views: 1, likes: 1, comments: 1, shares: 1, saves: 1, createdAt: 1 } })
      .toArray();
    const ids = vids.map((v) => v._id);
    const sum = (k) => vids.reduce((n, v) => n + (v[k] || 0), 0);

    const byDay = (col, match, field) =>
      col
        .aggregate([
          { $match: match },
          { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$' + field, timezone: '+03:00' } }, n: { $sum: 1 } } },
        ])
        .toArray();
    const [likeDays, commentDays, followDays, visitDays, followers] = await Promise.all([
      ids.length ? byDay(cols.likes, { videoId: { $in: ids }, userId: { $ne: me._id }, createdAt: { $gte: since } }, 'createdAt') : [],
      ids.length ? byDay(cols.comments, { videoId: { $in: ids }, userId: { $ne: me._id }, createdAt: { $gte: since } }, 'createdAt') : [],
      byDay(cols.follows, { followingId: me._id, createdAt: { $gte: since } }, 'createdAt'),
      byDay(cols.visitors, { profileId: me._id, visitedAt: { $gte: since } }, 'visitedAt'),
      cols.follows.countDocuments({ followingId: me._id }),
    ]);
    const pick = (rows) => new Map(rows.map((r) => [r._id, r.n]));
    const L = pick(likeDays), C = pick(commentDays), F = pick(followDays), V = pick(visitDays);
    const daily = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * DAY + 3 * 3600e3).toISOString().slice(0, 10);
      daily.push({ d, likes: L.get(d) || 0, comments: C.get(d) || 0, followers: F.get(d) || 0, visitors: V.get(d) || 0 });
    }
    const top = vids
      .slice()
      .sort((a, b) => (b.views || 0) - (a.views || 0))
      .slice(0, 5)
      .map((v) => ({ id: sid(v._id), posterUrl: v.posterUrl || '', caption: v.caption || '', views: v.views || 0, likes: v.likes || 0, comments: v.comments || 0 }));
    res.json({
      totals: { videos: vids.length, views: sum('views'), likes: sum('likes'), comments: sum('comments'), shares: sum('shares'), saves: sum('saves'), followers },
      last7: {
        likes: daily.reduce((n, x) => n + x.likes, 0),
        comments: daily.reduce((n, x) => n + x.comments, 0),
        followers: daily.reduce((n, x) => n + x.followers, 0),
        visitors: daily.reduce((n, x) => n + x.visitors, 0),
      },
      daily,
      top,
    });
  })
);

module.exports = router;
