'use strict';
const express = require('express');
const { cols } = require('../lib/db');
const state = require('../lib/db').state;
const { HttpError, wrap, oid, clean, escapeRegex, pageParams, bool } = require('../lib/helpers');
const {
  sid, userCard, usersById, logAdmin, getSettings, updateSettings,
} = require('../lib/services');
const { purgeVideo, purgeComment } = require('../lib/purge');
const security = require('../lib/security');
const storage = require('../lib/storage');
const storagetools = require('../lib/storagetools');
const s3 = require('../lib/s3');

const router = express.Router();

// days: 0/boş = süresiz. opts.ip → kullanıcının IP özetleri de yasaklanır. opts.selfHash → yöneticinin kendi IP'si korunur
async function banUser(admin, userId, reason, opts) {
  opts = opts || {};
  const u = await cols.users.findOne({ _id: userId }, { projection: { role: 1, username: 1, lastIpHash: 1, regIpHash: 1 } });
  if (!u) throw new HttpError(404, 'Kullanıcı bulunamadı.');
  if (u.role === 'admin') throw new HttpError(400, 'Yönetici hesapları askıya alınamaz.');
  const until = opts.days > 0 ? new Date(Date.now() + opts.days * 86400000) : null;
  const upd = { $set: { banned: true, banReason: clean(reason, 200), bannedAt: new Date() } };
  if (until) upd.$set.bannedUntil = until;
  else upd.$unset = { bannedUntil: '' };
  await cols.users.updateOne({ _id: userId }, upd);
  // süresiz askıda içerikler akışlardan gizlenir (geri alınabilir); geçici askıda içerik kalır
  if (!until) await cols.videos.updateMany({ userId }, { $set: { removed: true } });
  let ipCount = 0;
  if (opts.ip) {
    const hashes = [...new Set([u.lastIpHash, u.regIpHash].filter(Boolean))].filter((h) => h !== opts.selfHash);
    for (const h of hashes) {
      await cols.ipBans.updateOne(
        { ipHash: h },
        { $set: { reason: clean(reason, 120), until, userId, username: u.username, by: admin._id, createdAt: new Date() } },
        { upsert: true }
      );
      ipCount++;
    }
    security.forgetIp();
  }
  await security.killSessions(userId);
  await logAdmin(
    admin,
    'Kullanıcı askıya alındı',
    `@${u.username}: ${clean(reason, 200)} · ${until ? opts.days + ' gün' : 'süresiz'}${opts.ip ? ' · IP yasağı (' + ipCount + ')' : ''}`
  );
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

    let store = null;
    try {
      const u = await storage.dbUsage();
      store = { pct: u.pct, full: u.full, backend: storage.activeBackend() };
    } catch (e) {
      store = null;
    }
    res.json({
      storage: store,
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
      await banUser(req.user, report.targetUserId, note || report.reason, { selfHash: security.ipHashOf(req) });
    }

    if (action === 'dismiss' && report.type === 'video') {
      // otomatik gizlenmişse (çok şikayet) şikayet reddedilince geri aç
      await cols.videos.updateOne({ _id: report.targetId, autoRemoved: true }, { $set: { removed: false }, $unset: { autoRemoved: '' } });
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
        bannedUntil: u.bannedUntil || null,
        accountType: u.accountType === 'rp' ? 'rp' : 'real',
        google: !!u.googleId,
        autoBans: u.autoBanCount || 0,
        ip: security.maskIp(u.lastIpHash || u.regIpHash),
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
    const b = req.body || {};
    const days = Math.min(3650, Math.max(0, Math.floor(Number(b.days) || 0)));
    await banUser(req.user, id, b.reason || 'Topluluk kurallarını ihlal', { days, ip: bool(b.ip, false), selfHash: security.ipHashOf(req) });
    res.json({ ok: true });
  })
);

router.post(
  '/users/:id/unban',
  wrap(async (req, res) => {
    const id = oid(req.params.id);
    const u = await cols.users.findOne({ _id: id }, { projection: { username: 1 } });
    if (!u) throw new HttpError(404, 'Kullanıcı bulunamadı.');
    await cols.users.updateOne({ _id: id }, { $set: { banned: false, banReason: '' }, $unset: { bannedUntil: '', lockUntil: '' } });
    await cols.videos.updateMany({ userId: id }, { $set: { removed: false } });
    await cols.ipBans.deleteMany({ userId: id });
    security.forgetIp();
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


// ---------------------------------------------------------------- IP YASAKLARI
router.get(
  '/ip-bans',
  wrap(async (req, res) => {
    const rows = await cols.ipBans.find({}).sort({ createdAt: -1 }).limit(200).toArray();
    res.json({
      bans: rows.map((b) => ({
        id: sid(b._id),
        ip: security.maskIp(b.ipHash),
        username: b.username || '',
        reason: b.reason || '',
        until: b.until || null,
        createdAt: b.createdAt,
      })),
    });
  })
);

// Kullanıcı adıyla (son IP'si) ya da elle yazılan IP ile
router.post(
  '/ip-bans',
  wrap(async (req, res) => {
    const b = req.body || {};
    const days = Math.min(3650, Math.max(0, Math.floor(Number(b.days) || 0)));
    const until = days > 0 ? new Date(Date.now() + days * 86400000) : null;
    const reason = clean(b.reason, 120) || 'Topluluk kurallarını ihlal';
    let hashes = [];
    let username = '';
    if (b.ip) {
      const ip = clean(b.ip, 60);
      if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) throw new HttpError(400, 'Geçerli bir IP adresi yaz.');
      hashes = [security.hashIp(ip)];
    } else if (b.username) {
      const u = await cols.users.findOne({ username: clean(b.username, 30).toLowerCase().replace(/^@/, '') }, { projection: { lastIpHash: 1, regIpHash: 1, username: 1, role: 1 } });
      if (!u) throw new HttpError(404, 'Kullanıcı bulunamadı.');
      if (u.role === 'admin') throw new HttpError(400, 'Yöneticinin IP adresi yasaklanamaz.');
      username = u.username;
      hashes = [...new Set([u.lastIpHash, u.regIpHash].filter(Boolean))];
      if (!hashes.length) throw new HttpError(400, 'Bu kullanıcının kayıtlı bir IP adresi yok (eski hesap).');
    } else {
      throw new HttpError(400, 'Kullanıcı adı veya IP adresi yaz.');
    }
    const self = security.ipHashOf(req);
    hashes = hashes.filter((h) => h !== self);
    if (!hashes.length) throw new HttpError(400, 'Kendi IP adresini yasaklayamazsın.');
    for (const h of hashes) {
      await cols.ipBans.updateOne({ ipHash: h }, { $set: { reason, until, username, by: req.user._id, createdAt: new Date() } }, { upsert: true });
    }
    security.forgetIp();
    await logAdmin(req.user, 'IP yasağı', `${username ? '@' + username : 'elle girilen IP'} · ${until ? days + ' gün' : 'süresiz'} · ${reason}`);
    res.json({ ok: true, count: hashes.length });
  })
);

router.delete(
  '/ip-bans/:id',
  wrap(async (req, res) => {
    const r = await cols.ipBans.deleteOne({ _id: oid(req.params.id) });
    security.forgetIp();
    if (r.deletedCount) await logAdmin(req.user, 'IP yasağı kaldırıldı', req.params.id);
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------- İÇERİK GÜVENLİĞİ
router.get(
  '/modlog',
  wrap(async (req, res) => {
    const rows = await cols.modLog.find({}).sort({ createdAt: -1 }).limit(100).toArray();
    const users = await usersById(rows.map((r) => r.userId));
    res.json({
      items: rows.map((r) => ({
        id: sid(r._id),
        kind: r.kind,
        where: r.where,
        snippet: r.snippet,
        createdAt: r.createdAt,
        user: userCard(users.get(sid(r.userId))),
      })),
    });
  })
);

router.get(
  '/security',
  wrap(async (req, res) => {
    const s = await getSettings(true);
    res.json({ maxPerIp: s.maxPerIp || 0, defaultMaxPerIp: require('../lib/config').MAX_ACCOUNTS_PER_IP, badWords: s.badWords || [] });
  })
);

router.post(
  '/security',
  wrap(async (req, res) => {
    const b = req.body || {};
    const patch = {};
    if (b.maxPerIp !== undefined) patch.maxPerIp = Math.min(50, Math.max(0, Math.floor(Number(b.maxPerIp) || 0)));
    if (b.badWords !== undefined) {
      const list = Array.isArray(b.badWords) ? b.badWords : String(b.badWords).split(/[\n,]+/);
      patch.badWords = [...new Set(list.map((w) => clean(w, 30).toLowerCase()).filter((w) => w.length >= 3))].slice(0, 200);
    }
    const s = await updateSettings(patch);
    await logAdmin(req.user, 'Güvenlik ayarları', `ağ başına hesap: ${s.maxPerIp || 'varsayılan'} · özel kelime: ${(s.badWords || []).length}`);
    res.json({ maxPerIp: s.maxPerIp || 0, badWords: s.badWords || [] });
  })
);

// ---------------------------------------------------------------- DEPOLAMA
// Hiçbir uç nokta hesap/video silmez. Günlük kaydı en iyi çabayla yazılır (depo doluyken yazma başarısız olabilir).
const softLog = (user, action, detail) => logAdmin(user, action, detail).catch(() => {});

router.get(
  '/storage',
  wrap(async (req, res) => {
    res.json(await storagetools.getStats());
  })
);

router.post(
  '/storage/test',
  wrap(async (req, res) => {
    try {
      const r = await s3.selfTest();
      res.json({ ok: true, ...r });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  })
);

router.post(
  '/storage/job',
  wrap(async (req, res) => {
    const mode = String((req.body || {}).mode || '');
    if (mode === 'free' && String((req.body || {}).confirm || '').trim().toUpperCase() !== 'EVET') {
      throw new HttpError(400, 'Onay için EVET yaz.');
    }
    let st;
    try {
      st = storagetools.start(mode);
    } catch (e) {
      throw new HttpError(e.status || 400, e.message);
    }
    await softLog(req.user, 'Depolama işi başladı', mode);
    res.json(st);
  })
);

router.get('/storage/job', wrap(async (req, res) => res.json(storagetools.jobStatus())));

router.post('/storage/job/stop', wrap(async (req, res) => res.json(storagetools.stop())));

module.exports = router;
