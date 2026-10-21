'use strict';
const express = require('express');
const { cols } = require('../lib/db');
const { HttpError, wrap, oid, clean, pageParams } = require('../lib/helpers');
const { sid, userCard, usersById, blockedIds, hydrateVideos, notify } = require('../lib/services');
const { presentStories } = require('./stories');

const router = express.Router();
const DAY = 24 * 3600 * 1000;

// Hedef kullanıcıyı ve izleyiciyle ilişkisini yükler
async function loadTarget(req, usernameParam) {
  const username = clean(usernameParam, 30).toLowerCase();
  const t = await cols.users.findOne({ username, banned: { $ne: true } }, { projection: { password: 0 } });
  if (!t) throw new HttpError(404, 'Kullanıcı bulunamadı.');
  const me = req.user;
  const isMe = sid(t._id) === sid(me._id);
  const privileged = isMe || me.role === 'admin';

  const [iBlocked, blockedMe, followDoc, followsMe, requestDoc] = isMe
    ? [null, null, null, null, null]
    : await Promise.all([
        cols.blocks.findOne({ userId: me._id, targetId: t._id }),
        cols.blocks.findOne({ userId: t._id, targetId: me._id }),
        cols.follows.findOne({ followerId: me._id, followingId: t._id }),
        cols.follows.findOne({ followerId: t._id, followingId: me._id }),
        cols.followRequests.findOne({ fromId: me._id, toId: t._id }),
      ]);
  if (blockedMe && me.role !== 'admin') throw new HttpError(404, 'Kullanıcı bulunamadı.');

  const following = !!followDoc;
  const blocked = !!iBlocked;
  const canView = !blocked && (privileged || !t.isPrivate || following);
  return {
    t,
    isMe,
    privileged,
    following,
    blocked,
    canView,
    relation: {
      isMe,
      following,
      requested: !!requestDoc,
      followsMe: !!followsMe,
      blocked,
    },
  };
}

function visibilityFilter(ctx) {
  if (ctx.privileged) return {};
  if (ctx.following) return { visibility: { $in: ['public', 'followers'] } };
  return { visibility: 'public' };
}

router.get(
  '/:username',
  wrap(async (req, res) => {
    const ctx = await loadTarget(req, req.params.username);
    const { t, isMe } = ctx;
    const me = req.user;

    if (!isMe && ctx.canView && !t.hideVisitors && !me.hideVisitors) {
      cols.visitors
        .updateOne({ profileId: t._id, visitorId: me._id }, { $set: { visitedAt: new Date() } }, { upsert: true })
        .catch(() => {});
    }

    const vf = { userId: t._id, removed: { $ne: true }, ...visibilityFilter(ctx) };
    const [followers, following, videos, likeAgg] = await Promise.all([
      cols.follows.countDocuments({ followingId: t._id }),
      cols.follows.countDocuments({ followerId: t._id }),
      ctx.canView ? cols.videos.countDocuments(vf) : 0,
      cols.videos.aggregate([{ $match: { userId: t._id, removed: { $ne: true } } }, { $group: { _id: null, total: { $sum: '$likes' } } }]).toArray(),
    ]);

    let stories = [];
    if (ctx.canView) {
      const list = await cols.stories.find({ userId: t._id, createdAt: { $gte: new Date(Date.now() - DAY) } }).sort({ createdAt: 1 }).toArray();
      stories = await presentStories(list, me);
    }

    res.json({
      user: {
        ...userCard(t),
        banner: t.banner || '',
        bio: t.bio || '',
        link: t.link || '',
        isPrivate: !!t.isPrivate,
        likesPublic: !!t.showLikes,
      },
      stats: { followers, following, videos, likes: likeAgg.length ? likeAgg[0].total : 0 },
      relation: ctx.relation,
      canView: ctx.canView,
      stories,
    });
  })
);

router.get(
  '/:username/videos',
  wrap(async (req, res) => {
    const ctx = await loadTarget(req, req.params.username);
    const { t, isMe } = ctx;
    const me = req.user;
    const tab = ['videos', 'liked', 'saved'].includes(req.query.tab) ? req.query.tab : 'videos';
    const { skip, limit } = pageParams(req, 18, 40);

    if (!ctx.canView) return res.json({ videos: [], hasMore: false, locked: true });

    if (tab === 'videos') {
      const filter = { userId: t._id, removed: { $ne: true }, ...visibilityFilter(ctx) };
      if (!isMe && me.restrictedMode) filter.sensitive = { $ne: true };
      let list = await cols.videos
        .find(filter)
        .sort({ profilePinned: -1, createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit + 1)
        .toArray();
      const hasMore = list.length > limit;
      list = list.slice(0, limit);
      return res.json({ videos: await hydrateVideos(list, me), hasMore });
    }

    if (tab === 'liked' && !isMe && !t.showLikes) return res.json({ videos: [], hasMore: false, hidden: true });
    if (tab === 'saved' && !isMe) return res.json({ videos: [], hasMore: false, hidden: true });

    const source = tab === 'liked' ? cols.likes : cols.saves;
    const rows = await source.find({ userId: t._id }).sort({ _id: -1 }).skip(skip).limit(limit + 1).toArray();
    const hasMore = rows.length > limit;
    const ids = rows.slice(0, limit).map((r) => r.videoId);
    const blocked = await blockedIds(me._id);
    const filter = {
      _id: { $in: ids },
      removed: { $ne: true },
      $or: [{ visibility: 'public', ownerPrivate: { $ne: true } }, { userId: me._id }],
    };
    if (blocked.length) filter.userId = { $nin: blocked };
    if (me.restrictedMode) filter.sensitive = { $ne: true };
    const found = await cols.videos.find(filter).toArray();
    const order = new Map(ids.map((id, i) => [sid(id), i]));
    found.sort((a, b) => order.get(sid(a._id)) - order.get(sid(b._id)));
    res.json({ videos: await hydrateVideos(found, me), hasMore });
  })
);

async function listRelations(req, res, kind) {
  const ctx = await loadTarget(req, req.params.username);
  if (!ctx.canView) return res.json({ users: [], hasMore: false, locked: true });
  const { skip, limit } = pageParams(req, 30, 60);
  const field = kind === 'followers' ? 'followingId' : 'followerId';
  const other = kind === 'followers' ? 'followerId' : 'followingId';
  const rows = await cols.follows.find({ [field]: ctx.t._id }).sort({ _id: -1 }).skip(skip).limit(limit + 1).toArray();
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const ids = page.map((r) => r[other]);
  const [users, mine, blocked] = await Promise.all([
    usersById(ids),
    cols.follows.find({ followerId: req.user._id, followingId: { $in: ids } }, { projection: { followingId: 1 } }).toArray(),
    blockedIds(req.user._id),
  ]);
  const mySet = new Set(mine.map((m) => sid(m.followingId)));
  const blockedSet = new Set(blocked.map(sid));
  res.json({
    users: ids
      .filter((id) => users.has(sid(id)) && !blockedSet.has(sid(id)))
      .map((id) => ({ ...userCard(users.get(sid(id))), following: mySet.has(sid(id)), isMe: sid(id) === sid(req.user._id) })),
    hasMore,
  });
}

router.get('/:username/followers', wrap((req, res) => listRelations(req, res, 'followers')));
router.get('/:username/following', wrap((req, res) => listRelations(req, res, 'following')));

// ---------------------------------------------------------------- TAKİP
router.post(
  '/:id/follow',
  wrap(async (req, res) => {
    const me = req.user;
    const target = await cols.users.findOne({ _id: oid(req.params.id), banned: { $ne: true } }, { projection: { password: 0 } });
    if (!target) throw new HttpError(404, 'Kullanıcı bulunamadı.');
    if (sid(target._id) === sid(me._id)) throw new HttpError(400, 'Kendini takip edemezsin.');
    const blk = await cols.blocks.findOne({
      $or: [
        { userId: me._id, targetId: target._id },
        { userId: target._id, targetId: me._id },
      ],
    });
    if (blk) throw new HttpError(403, 'Bu kullanıcıyı takip edemezsin.');

    const countFollowers = () => cols.follows.countDocuments({ followingId: target._id });
    const pair = { followerId: me._id, followingId: target._id };

    // zaten takip ediliyor → takipten çık
    const del = await cols.follows.deleteOne(pair);
    if (del.deletedCount) return res.json({ following: false, requested: false, followers: await countFollowers() });

    if (target.isPrivate) {
      const cancelled = await cols.followRequests.deleteOne({ fromId: me._id, toId: target._id });
      if (cancelled.deletedCount) return res.json({ following: false, requested: false, followers: await countFollowers() });
      try {
        await cols.followRequests.insertOne({ fromId: me._id, toId: target._id, createdAt: new Date() });
        await notify({ userId: target._id, actorId: me._id, type: 'follow_request' });
      } catch (e) {
        if (e.code !== 11000) throw e;
      }
      return res.json({ following: false, requested: true, followers: await countFollowers() });
    }

    try {
      await cols.follows.insertOne({ ...pair, createdAt: new Date() });
      await notify({ userId: target._id, actorId: me._id, type: 'follow' });
    } catch (e) {
      if (e.code !== 11000) throw e;
    }
    res.json({ following: true, requested: false, followers: await countFollowers() });
  })
);

router.post(
  '/:id/remove-follower',
  wrap(async (req, res) => {
    await cols.follows.deleteOne({ followerId: oid(req.params.id), followingId: req.user._id });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------- ENGEL
router.post(
  '/:id/block',
  wrap(async (req, res) => {
    const me = req.user;
    const target = await cols.users.findOne({ _id: oid(req.params.id) }, { projection: { _id: 1, role: 1 } });
    if (!target) throw new HttpError(404, 'Kullanıcı bulunamadı.');
    if (sid(target._id) === sid(me._id)) throw new HttpError(400, 'Kendini engelleyemezsin.');

    const del = await cols.blocks.deleteOne({ userId: me._id, targetId: target._id });
    if (del.deletedCount) return res.json({ blocked: false });

    if (target.role === 'admin') throw new HttpError(400, 'Yönetici hesapları engellenemez.');
    try {
      await cols.blocks.insertOne({ userId: me._id, targetId: target._id, createdAt: new Date() });
    } catch (e) {
      if (e.code !== 11000) throw e;
    }
    await Promise.all([
      cols.follows.deleteMany({
        $or: [
          { followerId: me._id, followingId: target._id },
          { followerId: target._id, followingId: me._id },
        ],
      }),
      cols.followRequests.deleteMany({
        $or: [
          { fromId: me._id, toId: target._id },
          { fromId: target._id, toId: me._id },
        ],
      }),
    ]);
    res.json({ blocked: true });
  })
);

module.exports = router;
