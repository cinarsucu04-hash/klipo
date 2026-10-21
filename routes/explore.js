'use strict';
// Arama, keşfet, etiket sayfaları, öneriler, bildirimler ve sayaçlar
const express = require('express');
const { cols } = require('../lib/db');
const { wrap, clean, escapeRegex, pageParams } = require('../lib/helpers');
const {
  sid, userCard, usersById, blockedIds, hydrateVideos, publicVideoFilter,
} = require('../lib/services');

const router = express.Router();

async function suggestUsers(me, size) {
  const [follows, blocked] = await Promise.all([
    cols.follows.find({ followerId: me._id }, { projection: { followingId: 1 } }).toArray(),
    blockedIds(me._id),
  ]);
  const exclude = [me._id, ...follows.map((f) => f.followingId), ...blocked];
  const list = await cols.users
    .aggregate([{ $match: { _id: { $nin: exclude }, banned: { $ne: true } } }, { $sample: { size } }, { $project: { password: 0 } }])
    .toArray();
  return list.map((u) => ({ ...userCard(u), bio: u.bio || '', isPrivate: !!u.isPrivate }));
}

router.get(
  '/suggestions',
  wrap(async (req, res) => {
    res.json({ users: await suggestUsers(req.user, 12) });
  })
);

// ---------------------------------------------------------------- ARAMA
router.get(
  '/search',
  wrap(async (req, res) => {
    const me = req.user;
    const raw = clean(req.query.q, 60);
    const type = ['all', 'users', 'videos', 'tags'].includes(req.query.type) ? req.query.type : 'all';
    const out = { users: [], videos: [], tags: [] };
    const isTag = raw.startsWith('#');
    const term = raw.replace(/^#+/, '').trim().toLowerCase();
    if (!term) return res.json(out);

    if (req.query.save === '1' && raw.length >= 2) {
      await cols.searches.updateOne(
        { userId: me._id, query: raw.toLowerCase() },
        { $set: { updatedAt: new Date() } },
        { upsert: true }
      );
    }

    const blocked = await blockedIds(me._id);
    const re = new RegExp(escapeRegex(term), 'i');
    const wantAll = type === 'all';

    if ((wantAll || type === 'users') && !isTag) {
      const filter = { banned: { $ne: true }, $or: [{ username: re }, { nickname: re }] };
      if (blocked.length) filter._id = { $nin: blocked };
      const found = await cols.users.find(filter, { projection: { password: 0 } }).limit(40).toArray();
      found.sort((a, b) => Number(b.username.startsWith(term)) - Number(a.username.startsWith(term)) || a.username.length - b.username.length);
      out.users = found.slice(0, wantAll ? 6 : 30).map((u) => ({ ...userCard(u), bio: u.bio || '' }));
    }

    if (wantAll || type === 'tags') {
      const prefix = new RegExp('^' + escapeRegex(term), 'i');
      out.tags = (
        await cols.videos
          .aggregate([
            { $match: { hashtags: prefix, visibility: 'public', ownerPrivate: { $ne: true }, removed: { $ne: true } } },
            { $unwind: '$hashtags' },
            { $match: { hashtags: prefix } },
            { $group: { _id: '$hashtags', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: wantAll ? 5 : 20 },
          ])
          .toArray()
      ).map((t) => ({ tag: t._id, count: t.count }));
    }

    if (wantAll || type === 'videos') {
      const filter = publicVideoFilter(me, blocked);
      if (isTag) filter.hashtags = term;
      else filter.caption = re;
      const list = await cols.videos.find(filter).sort({ likes: -1, _id: -1 }).limit(wantAll ? 6 : 30).toArray();
      out.videos = await hydrateVideos(list, me);
    }
    res.json(out);
  })
);

router.get(
  '/search/recent',
  wrap(async (req, res) => {
    const rows = await cols.searches.find({ userId: req.user._id }).sort({ updatedAt: -1 }).limit(10).toArray();
    res.json({ queries: rows.map((r) => r.query) });
  })
);

router.delete(
  '/search/recent',
  wrap(async (req, res) => {
    const q = clean(req.query.q, 60).toLowerCase();
    await cols.searches.deleteMany(q ? { userId: req.user._id, query: q } : { userId: req.user._id });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------- KEŞFET
router.get(
  '/discover',
  wrap(async (req, res) => {
    const me = req.user;
    const blocked = await blockedIds(me._id);
    const since7 = new Date(Date.now() - 7 * 86400000);
    const since30 = new Date(Date.now() - 30 * 86400000);

    const [tags, topVideos, users] = await Promise.all([
      cols.videos
        .aggregate([
          { $match: { createdAt: { $gte: since7 }, visibility: 'public', ownerPrivate: { $ne: true }, removed: { $ne: true } } },
          { $unwind: '$hashtags' },
          { $group: { _id: '$hashtags', count: { $sum: 1 }, likes: { $sum: '$likes' } } },
          { $addFields: { score: { $add: [{ $multiply: ['$count', 3] }, '$likes'] } } },
          { $sort: { score: -1, _id: 1 } },
          { $limit: 15 },
        ])
        .toArray(),
      cols.videos
        .find({ ...publicVideoFilter(me, blocked), createdAt: { $gte: since30 } })
        .sort({ likes: -1, views: -1, _id: -1 })
        .limit(12)
        .toArray(),
      suggestUsers(me, 8),
    ]);

    res.json({
      tags: tags.map((t) => ({ tag: t._id, count: t.count })),
      videos: await hydrateVideos(topVideos, me),
      users,
    });
  })
);

router.get(
  '/tags/:tag',
  wrap(async (req, res) => {
    const tag = clean(req.params.tag, 40).replace(/^#+/, '').toLowerCase();
    const { skip, limit } = pageParams(req, 18, 40);
    const blocked = await blockedIds(req.user._id);
    const filter = { ...publicVideoFilter(req.user, blocked), hashtags: tag };
    const [count, list] = await Promise.all([
      cols.videos.countDocuments(filter),
      cols.videos
        .find(filter)
        .sort({ likes: -1, _id: -1 })
        .skip(skip)
        .limit(limit + 1)
        .toArray(),
    ]);
    const hasMore = list.length > limit;
    res.json({ tag, count, videos: await hydrateVideos(list.slice(0, limit), req.user), hasMore });
  })
);

// ---------------------------------------------------------------- BİLDİRİMLER
const NOTIF_FILTERS = {
  likes: ['like', 'comment_like'],
  comments: ['comment', 'reply'],
  follows: ['follow', 'follow_request', 'follow_accepted'],
  mentions: ['mention'],
};

router.get(
  '/notifications',
  wrap(async (req, res) => {
    const { skip, limit } = pageParams(req, 25, 50);
    const filter = { userId: req.user._id };
    if (NOTIF_FILTERS[req.query.filter]) filter.type = { $in: NOTIF_FILTERS[req.query.filter] };
    const rows = await cols.notifications.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit + 1).toArray();
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);

    const actors = await usersById(page.map((n) => n.actorId));
    const videoIdMap = new Map();
    page.forEach((n) => {
      if (n.videoId) videoIdMap.set(sid(n.videoId), n.videoId);
    });
    const videoIds = [...videoIdMap.values()];
    const videos = videoIds.length
      ? await cols.videos.find({ _id: { $in: videoIds } }, { projection: { posterUrl: 1, mediaUrl: 1 } }).toArray()
      : [];
    const videoMap = new Map(videos.map((v) => [sid(v._id), v]));

    res.json({
      hasMore,
      notifications: page
        .filter((n) => actors.has(sid(n.actorId)))
        .map((n) => {
          const v = n.videoId ? videoMap.get(sid(n.videoId)) : null;
          return {
            id: sid(n._id),
            type: n.type,
            actor: userCard(actors.get(sid(n.actorId))),
            video: v ? { id: sid(v._id), posterUrl: v.posterUrl || '', mediaUrl: v.mediaUrl } : null,
            commentId: n.commentId ? sid(n.commentId) : null,
            text: n.text || '',
            read: !!n.read,
            createdAt: n.createdAt,
          };
        }),
    });
  })
);

router.post(
  '/notifications/read',
  wrap(async (req, res) => {
    await cols.notifications.updateMany({ userId: req.user._id, read: false }, { $set: { read: true } });
    res.json({ ok: true });
  })
);

// Alt gezinme çubuğundaki rozetler için
router.get(
  '/counters',
  wrap(async (req, res) => {
    const me = req.user;
    const chats = await cols.chats.find({ members: me._id }, { projection: { _id: 1 } }).toArray();
    const [notifications, messages, requests] = await Promise.all([
      cols.notifications.countDocuments({ userId: me._id, read: false }),
      chats.length
        ? cols.messages.countDocuments({ chatId: { $in: chats.map((c) => c._id) }, senderId: { $ne: me._id }, readBy: { $ne: me._id } })
        : 0,
      cols.followRequests.countDocuments({ toId: me._id }),
    ]);
    res.json({ notifications, messages, requests });
  })
);

module.exports = router;
