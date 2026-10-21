'use strict';
const express = require('express');
const { cols } = require('../lib/db');
const state = require('../lib/db').state;
const { HttpError, wrap, oid, clean, escapeRegex, pageParams, bool } = require('../lib/helpers');
const {
  sid, userCard, usersById, logAdmin, getSettings, updateSettings,
} = require('../lib/services');
const { purgeVideo, purgeComment } = require('../lib/purge');

const router = express.Router();

async function banUser(admin, userId, reason) {
  const u = await cols.users.findOne({ _id: userId }, { projection: { role: 1, username: 1 } });
  if (!u) throw new HttpError(404, 'Kullanıcı bulunamadı.');
  if (u.role === 'admin') throw new HttpError(400, 'Yönetici hesapları askıya alınamaz.');
  await cols.users.updateOne({ _id: userId }, { $set: { banned: true, banReason: clean(reason, 200), bannedAt: new Date() } });
  // içerikleri akışlardan gizle (geri alınabilir)
  await cols.videos.updateMany({ userId }, { $set: { removed: true } });
  await logAdmin(admin, 'Kullanıcı askıya alındı', `@${u.username}: ${clean(reason, 200)}`);
  return u;
}

// ---------------------------------------------------------------- İSTATİSTİK
router.get(
  '/stats',
  wrap(async (req, res) => {
    const now = Date.now();
    const day = new Date(now - 86400000);
    const week = new Date(now - 7 * 86400000);
    const [users, videos, comments, openReports, activeStories, newUsers, newVideos, active24h, banned, settings] = await Promise.all([
      cols.users.estimatedDocumentCount(),
      cols.videos.estimatedDocumentCount(),
      cols.comments.estimatedDocumentCount(),
      cols.reports.countDocuments({ status: 'open' }),
      cols.stories.countDocuments({ createdAt: { $gte: day } }),
      cols.users.countDocuments({ createdAt: { $gte: day } }),
      cols.videos.countDocuments({ createdAt: { $gte: day } }),
      cols.users.countDocuments({ lastActive: { $gte: day } }),
      cols.users.countDocuments({ banned: true }),
      getSettings(true),
    ]);

    const series = async (col) => {
      const rows = await col
        .aggregate([
          { $match: { createdAt: { $gte: week } } },
          { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Europe/Istanbul' } }, n: { $sum: 1 } } },
        ])
        .toArray();
      const map = new Map(rows.map((r) => [r._id, r.n]));
      const out = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(now - i * 86400000);
        const key = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Istanbul' }).format(d); // YYYY-MM-DD
        out.push({ day: key, n: map.get(key) || 0 });
      }
      return out;
    };

    res.json({
      totals: { users, videos, comments, openReports, activeStories, banned },
      last24h: { newUsers, newVideos, activeUsers: active24h },
      daily: { users: await series(cols.users), videos: await series(cols.videos) },
      server: {
        memoryMB: Math.round(process.memoryUsage().heapUsed / 1048576),
        uptimeMin: Math.round(process.uptime() / 60),
        node: process.version,
        db: state.ready,
      },
      maintenance: settings.maintenance,
      announcement: settings.announcement ? settings.announcement.text : '',
    });
  })
);

// ---------------------------------------------------------------- ŞİKAYETLER
router.get(
  '/reports',
  wrap(async (req, res) => {
    const open = req.query.status !== 'closed';
    const { skip, limit } = pageParams(req, 15, 40);
    const rows = await cols.reports
      .find({ status: open ? 'open' : { $ne: 'open' } })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit + 1)
      .toArray();
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);

    const users = await usersById([...page.map((r) => r.reporterId), ...page.map((r) => r.targetUserId)]);
    const videoIds = page.filter((r) => r.type === 'video').map((r) => r.targetId);
    const commentIds = page.filter((r) => r.type === 'comment').map((r) => r.targetId);
    const [videos, comments] = await Promise.all([
      videoIds.length ? cols.videos.find({ _id: { $in: videoIds } }, { projection: { caption: 1, posterUrl: 1, mediaUrl: 1 } }).toArray() : [],
      commentIds.length ? cols.comments.find({ _id: { $in: commentIds } }, { projection: { text: 1 } }).toArray() : [],
    ]);
    const vMap = new Map(videos.map((v) => [sid(v._id), v]));
    const cMap = new Map(comments.map((c) => [sid(c._id), c]));

    res.json({
      hasMore,
      reports: page.map((r) => {
        const v = vMap.get(sid(r.targetId));
        const c = cMap.get(sid(r.targetId));
        return {
          id: sid(r._id),
          type: r.type,
          reason: r.reason,
          description: r.description || '',
          evidenceUrl: r.evidenceUrl || '',
          status: r.status,
          action: r.action || '',
          note: r.note || '',
          createdAt: r.createdAt,
          reporter: users.has(sid(r.reporterId)) ? userCard(users.get(sid(r.reporterId))) : null,
          targetUser: users.has(sid(r.targetUserId)) ? userCard(users.get(sid(r.targetUserId))) : null,
          targetId: sid(r.targetId),
          video: v ? { id: sid(v._id), caption: v.caption || '', posterUrl: v.posterUrl || '', mediaUrl: v.mediaUrl } : null,
          comment: c ? { id: sid(c._id), text: c.text } : null,
          contentGone: (r.type === 'video' && !v) || (r.type === 'comment' && !c),
        };
      }),
    });
  })
);

router.post(
  '/reports/:id/resolve',
  wrap(async (req, res) => {
    const report = await cols.reports.findOne({ _id: oid(req.params.id) });
    if (!report) throw new HttpError(404, 'Şikayet bulunamadı.');
    const action = ['dismiss', 'remove_content', 'ban_user'].includes((req.body || {}).action) ? req.body.action : 'dismiss';
    const note = clean((req.body || {}).note, 300);

    if (action === 'remove_content') {
      if (report.type === 'video') {
        const v = await cols.videos.findOne({ _id: report.targetId });
        if (v) await purgeVideo(v);
      } else if (report.type === 'comment') {
        const c = await cols.comments.findOne({ _id: report.targetId });
        if (c) await purgeComment(c);
      } else {
        throw new HttpError(400, 'Kullanıcı şikayetlerinde içerik silinemez; hesabı askıya alabilirsin.');
      }
    } else if (action === 'ban_user') {
      await banUser(req.user, report.targetUserId, note || report.reason);
    }

    await cols.reports.updateMany(
      { type: report.type, targetId: report.targetId, status: 'open' },
      { $set: { status: 'resolved', action, note, resolvedBy: req.user._id, resolvedAt: new Date() } }
    );
    await logAdmin(req.user, 'Şikayet sonuçlandı', `${report.type}:${sid(report.targetId)} → ${action}`);
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------- KULLANICILAR
router.get(
  '/users',
  wrap(async (req, res) => {
    const q = clean(req.query.q, 40);
    const { skip, limit } = pageParams(req, 20, 50);
    const filter = {};
    if (q) {
      const re = new RegExp(escapeRegex(q), 'i');
      filter.$or = [{ username: re }, { nickname: re }];
    }
    if (req.query.banned === '1') filter.banned = true;
    const rows = await cols.users
      .find(filter, { projection: { password: 0 } })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit + 1)
      .toArray();
    res.json({
      hasMore: rows.length > limit,
      users: rows.slice(0, limit).map((u) => ({
        ...userCard(u),
        role: u.role || 'user',
        banned: !!u.banned,
        banReason: u.banReason || '',
        createdAt: u.createdAt,
        lastActive: u.lastActive,
      })),
    });
  })
);

router.post(
  '/users/:id/ban',
  wrap(async (req, res) => {
    const id = oid(req.params.id);
    if (sid(id) === sid(req.user._id)) throw new HttpError(400, 'Kendini askıya alamazsın.');
    await banUser(req.user, id, (req.body || {}).reason || 'Topluluk kurallarını ihlal');
    res.json({ ok: true });
  })
);

router.post(
  '/users/:id/unban',
  wrap(async (req, res) => {
    const id = oid(req.params.id);
    const u = await cols.users.findOne({ _id: id }, { projection: { username: 1 } });
    if (!u) throw new HttpError(404, 'Kullanıcı bulunamadı.');
    await cols.users.updateOne({ _id: id }, { $set: { banned: false, banReason: '' } });
    await cols.videos.updateMany({ userId: id }, { $set: { removed: false } });
    await logAdmin(req.user, 'Askı kaldırıldı', `@${u.username}`);
    res.json({ ok: true });
  })
);

router.post(
  '/users/:id/verify',
  wrap(async (req, res) => {
    const id = oid(req.params.id);
    const u = await cols.users.findOne({ _id: id }, { projection: { verified: 1, username: 1 } });
    if (!u) throw new HttpError(404, 'Kullanıcı bulunamadı.');
    const verified = !u.verified;
    await cols.users.updateOne({ _id: id }, { $set: { verified } });
    await logAdmin(req.user, verified ? 'Doğrulama rozeti verildi' : 'Doğrulama rozeti kaldırıldı', `@${u.username}`);
    res.json({ verified });
  })
);

// ---------------------------------------------------------------- VİDEOLAR
router.get(
  '/videos',
  wrap(async (req, res) => {
    const q = clean(req.query.q, 60);
    const { skip, limit } = pageParams(req, 20, 50);
    const filter = {};
    if (q) filter.caption = new RegExp(escapeRegex(q), 'i');
    const rows = await cols.videos.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit + 1).toArray();
    const page = rows.slice(0, limit);
    const owners = await usersById(page.map((v) => v.userId));
    res.json({
      hasMore: rows.length > limit,
      videos: page.map((v) => ({
        id: sid(v._id),
        user: owners.has(sid(v.userId)) ? userCard(owners.get(sid(v.userId))) : null,
        caption: v.caption || '',
        posterUrl: v.posterUrl || '',
        mediaUrl: v.mediaUrl,
        visibility: v.visibility,
        featured: !!v.featured,
        sensitive: !!v.sensitive,
        removed: !!v.removed,
        views: v.views || 0,
        likes: v.likes || 0,
        createdAt: v.createdAt,
      })),
    });
  })
);

// Öne çıkan: "Sizin için" akışında en üstte gösterilir
router.post(
  '/videos/:id/feature',
  wrap(async (req, res) => {
    const v = await cols.videos.findOne({ _id: oid(req.params.id) }, { projection: { featured: 1 } });
    if (!v) throw new HttpError(404, 'Video bulunamadı.');
    const featured = !v.featured;
    await cols.videos.updateOne({ _id: v._id }, { $set: { featured } });
    await logAdmin(req.user, featured ? 'Video öne çıkarıldı' : 'Video öne çıkarmadan kaldırıldı', `video:${sid(v._id)}`);
    res.json({ featured });
  })
);

// Hassas içerik: "Kısıtlı mod" açık kullanıcılara gösterilmez
router.post(
  '/videos/:id/sensitive',
  wrap(async (req, res) => {
    const v = await cols.videos.findOne({ _id: oid(req.params.id) }, { projection: { sensitive: 1 } });
    if (!v) throw new HttpError(404, 'Video bulunamadı.');
    const sensitive = !v.sensitive;
    await cols.videos.updateOne({ _id: v._id }, { $set: { sensitive } });
    await logAdmin(req.user, sensitive ? 'Video hassas işaretlendi' : 'Hassas işareti kaldırıldı', `video:${sid(v._id)}`);
    res.json({ sensitive });
  })
);

// ---------------------------------------------------------------- DUYURU / BAKIM / YEDEK / KAYITLAR
router.post(
  '/announcement',
  wrap(async (req, res) => {
    const text = clean((req.body || {}).text, 200);
    if (!text) throw new HttpError(400, 'Duyuru metni boş olamaz.');
    await updateSettings({ announcement: { text, createdAt: new Date(), by: req.user.username } });
    await logAdmin(req.user, 'Duyuru yayınlandı', text);
    res.json({ ok: true });
  })
);

router.delete(
  '/announcement',
  wrap(async (req, res) => {
    await updateSettings({ announcement: null });
    await logAdmin(req.user, 'Duyuru kaldırıldı');
    res.json({ ok: true });
  })
);

router.post(
  '/maintenance',
  wrap(async (req, res) => {
    const on = bool((req.body || {}).on);
    await updateSettings({ maintenance: on });
    await logAdmin(req.user, 'Bakım modu', on ? 'açıldı' : 'kapatıldı');
    res.json({ maintenance: on });
  })
);

router.get(
  '/backup',
  wrap(async (req, res) => {
    const cap = 50000;
    const [users, videos, comments, reports] = await Promise.all([
      cols.users.find({}, { projection: { password: 0 } }).limit(cap).toArray(),
      cols.videos.find({}).limit(cap).toArray(),
      cols.comments.find({}).limit(cap).toArray(),
      cols.reports.find({}).limit(cap).toArray(),
    ]);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="klipo-yedek-${stamp}.json"`);
    res.send(JSON.stringify({ createdAt: new Date(), users, videos, comments, reports }, null, 2));
    await logAdmin(req.user, 'Yedek indirildi');
  })
);

router.get(
  '/logs',
  wrap(async (req, res) => {
    const rows = await cols.logs.find({}).sort({ createdAt: -1 }).limit(100).toArray();
    res.json({ logs: rows.map((l) => ({ id: sid(l._id), admin: l.adminName, action: l.action, details: l.details, createdAt: l.createdAt })) });
  })
);

module.exports = router;
