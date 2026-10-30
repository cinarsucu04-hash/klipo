'use strict';
const { ObjectId } = require('mongodb');
const { cols } = require('./db');
const { clean } = require('./helpers');
const push = require('./push');

const sid = (v) => String(v);

// ---------------- Kullanıcı sunumu ----------------
const USER_CARD_FIELDS = { username: 1, nickname: 1, avatar: 1, verified: 1, role: 1, accountType: 1 };

function userCard(u) {
  if (!u) return null;
  return {
    id: sid(u._id),
    username: u.username,
    nickname: u.nickname || u.username,
    avatar: u.avatar || '',
    verified: !!(u.verified || u.role === 'admin'),
    acct: u.accountType === 'rp' ? 'rp' : 'real',
  };
}

const maskEmail = (e) => {
  const [l, d] = String(e || '').split('@');
  return d ? (l.length <= 2 ? l[0] : l.slice(0, 2)) + '•••@' + d : '';
};

// Oturum açmış kullanıcının kendi bilgisi
function presentMe(u) {
  return {
    ...userCard(u),
    banner: u.banner || '',
    bio: u.bio || '',
    link: u.link || '',
    role: u.role || 'user',
    isPrivate: !!u.isPrivate,
    pickUsername: !!u.usernameAuto,
    email: maskEmail(u.email),
    emailVerified: !!u.emailVerified,
    google: !!u.googleId,
    noPassword: !!u.noPassword,
    settings: {
      hideVisitors: !!u.hideVisitors,
      restrictedMode: !!u.restrictedMode,
      theme: u.theme || 'dark',
      allowMessages: u.allowMessages || 'everyone',
      showLikes: !!u.showLikes,
    },
    createdAt: u.createdAt,
  };
}

async function usersById(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(sid))].map((x) => new ObjectId(x));
  if (!unique.length) return new Map();
  const list = await cols.users.find({ _id: { $in: unique } }, { projection: USER_CARD_FIELDS }).toArray();
  return new Map(list.map((u) => [sid(u._id), u]));
}

// ---------------- Engelleme ----------------
async function blockedIds(meId) {
  const [mine, theirs] = await Promise.all([
    cols.blocks.find({ userId: meId }, { projection: { targetId: 1 } }).toArray(),
    cols.blocks.find({ targetId: meId }, { projection: { userId: 1 } }).toArray(),
  ]);
  return [...mine.map((x) => x.targetId), ...theirs.map((x) => x.userId)];
}

async function isBlockedEitherWay(a, b) {
  const hit = await cols.blocks.findOne({
    $or: [
      { userId: a, targetId: b },
      { userId: b, targetId: a },
    ],
  });
  return !!hit;
}

// ---------------- Video sunumu ----------------
function presentVideo(v, owner, flags) {
  return {
    id: sid(v._id),
    user: userCard(owner),
    caption: v.caption || '',
    hashtags: v.hashtags || [],
    mediaUrl: v.mediaUrl,
    posterUrl: v.posterUrl || '',
    song: v.song || '',
    sound: v.sound || null,
    overlays: v.overlays || [],
    filter: v.filter || '',
    duet: flags.duet || null,
    allowDuet: v.allowDuet !== false,
    allowDownload: v.allowDownload !== false,
    visibility: v.visibility || 'public',
    allowComments: v.allowComments !== false,
    views: v.views || 0,
    likes: v.likes || 0,
    comments: v.comments || 0,
    shares: v.shares || 0,
    saves: v.saves || 0,
    liked: !!flags.liked,
    saved: !!flags.saved,
    following: !!flags.following,
    mine: !!flags.mine,
    featured: !!v.featured,
    sensitive: !!v.sensitive,
    profilePinned: !!v.profilePinned,
    createdAt: v.createdAt,
  };
}

async function hydrateVideos(videos, me) {
  if (!videos.length) return [];
  const ownerIds = [...new Set(videos.map((v) => sid(v.userId)))].map((x) => new ObjectId(x));
  const videoIds = videos.map((v) => v._id);
  const [owners, likes, saves, follows] = await Promise.all([
    cols.users.find({ _id: { $in: ownerIds } }, { projection: USER_CARD_FIELDS }).toArray(),
    cols.likes.find({ userId: me._id, videoId: { $in: videoIds } }, { projection: { videoId: 1 } }).toArray(),
    cols.saves.find({ userId: me._id, videoId: { $in: videoIds } }, { projection: { videoId: 1 } }).toArray(),
    cols.follows.find({ followerId: me._id, followingId: { $in: ownerIds } }, { projection: { followingId: 1 } }).toArray(),
  ]);
  const ownerMap = new Map(owners.map((u) => [sid(u._id), u]));
  const likedSet = new Set(likes.map((x) => sid(x.videoId)));
  const savedSet = new Set(saves.map((x) => sid(x.videoId)));
  const followSet = new Set(follows.map((x) => sid(x.followingId)));

  // düet: yan yana gösterilecek orijinal videolar (yalnızca herkese açık ve silinmemiş olanlar)
  const duetIds = [...new Set(videos.filter((v) => v.duetOf).map((v) => sid(v.duetOf)))].map((x) => new ObjectId(x));
  const duetMap = new Map();
  if (duetIds.length) {
    const origs = await cols.videos
      .find({ _id: { $in: duetIds }, removed: { $ne: true }, visibility: 'public', ownerPrivate: { $ne: true } }, { projection: { mediaUrl: 1, posterUrl: 1, userId: 1, caption: 1 } })
      .toArray();
    const origOwners = await usersById(origs.map((o) => o.userId));
    for (const o of origs) {
      const ow = origOwners.get(sid(o.userId));
      if (ow) duetMap.set(sid(o._id), { id: sid(o._id), mediaUrl: o.mediaUrl, posterUrl: o.posterUrl || '', user: userCard(ow) });
    }
  }

  const out = [];
  for (const v of videos) {
    const owner = ownerMap.get(sid(v.userId));
    if (!owner) continue; // sahibi silinmiş
    out.push(
      presentVideo(v, owner, {
        liked: likedSet.has(sid(v._id)),
        saved: savedSet.has(sid(v._id)),
        following: followSet.has(sid(v.userId)),
        mine: sid(v.userId) === sid(me._id),
        duet: v.duetOf ? duetMap.get(sid(v.duetOf)) || null : null,
      })
    );
  }
  return out;
}

// Bir kullanıcı bu videoyu görebilir mi?
async function canSeeVideo(v, me) {
  if (!v || v.removed) return false;
  if (me.role === 'admin') return true;
  if (sid(v.userId) === sid(me._id)) return true;
  if (await isBlockedEitherWay(me._id, v.userId)) return false;
  if (v.visibility === 'private') return false;
  if (v.visibility === 'followers' || v.ownerPrivate) {
    return !!(await cols.follows.findOne({ followerId: me._id, followingId: v.userId }));
  }
  return true;
}

// Herkese açık akış sorguları için temel filtre
function publicVideoFilter(me, blocked) {
  const f = {
    visibility: 'public',
    ownerPrivate: { $ne: true },
    removed: { $ne: true },
  };
  if (blocked && blocked.length) f.userId = { $nin: blocked };
  if (me && me.restrictedMode) f.sensitive = { $ne: true };
  return f;
}

// ---------------- Bildirimler ----------------
const DEDUPE_TYPES = new Set(['like', 'follow', 'comment_like']);

// Telefona/tarayıcıya anlık bildirim gönderir; ana işlemi asla bekletmez veya bozmaz
function firePush(userId, actorId, type, text) {
  (async () => {
    const actor = await cols.users.findOne({ _id: actorId }, { projection: { nickname: 1, username: 1 } });
    await push.sendToUser(userId, push.forNotification(type, actor, text));
  })().catch(() => {});
}

async function notify({ userId, actorId, type, videoId, commentId, text }) {
  try {
    if (sid(userId) === sid(actorId)) return;
    if (await isBlockedEitherWay(userId, actorId)) return;
    const now = new Date();
    const vid = videoId || null;
    const cid = commentId || null;
    if (DEDUPE_TYPES.has(type)) {
      await cols.notifications.updateOne(
        { userId, actorId, type, videoId: vid, commentId: cid },
        { $set: { read: false, createdAt: now } },
        { upsert: true }
      );
      firePush(userId, actorId, type, text);
      return;
    }
    firePush(userId, actorId, type, text);
    await cols.notifications.insertOne({
      userId,
      actorId,
      type,
      videoId: vid,
      commentId: cid,
      text: text ? clean(text, 120) : '',
      read: false,
      createdAt: now,
    });
  } catch (e) {
    console.error('[bildirim]', e.message);
  }
}

async function logAdmin(admin, action, details) {
  try {
    await cols.logs.insertOne({
      adminId: admin._id,
      adminName: admin.username,
      action,
      details: details || '',
      createdAt: new Date(),
    });
  } catch (e) {
    console.error('[log]', e.message);
  }
}

// ---------------- Ayarlar (bakım modu, duyuru) ----------------
const settingsCache = { at: 0, value: { maintenance: false, announcement: null } };

async function getSettings(force) {
  if (!force && Date.now() - settingsCache.at < 15000) return settingsCache.value;
  const doc = await cols.settings.findOne({ _id: 'global' });
  settingsCache.value = {
    maintenance: !!(doc && doc.maintenance),
    announcement: (doc && doc.announcement) || null,
    badWords: (doc && Array.isArray(doc.badWords) ? doc.badWords : []).slice(0, 200),
    maxPerIp: doc && doc.maxPerIp ? Number(doc.maxPerIp) : 0,
  };
  settingsCache.at = Date.now();
  return settingsCache.value;
}

async function updateSettings(patch) {
  await cols.settings.updateOne({ _id: 'global' }, { $set: patch }, { upsert: true });
  return getSettings(true);
}

module.exports = {
  sid,
  USER_CARD_FIELDS,
  userCard,
  presentMe,
  usersById,
  blockedIds,
  isBlockedEitherWay,
  presentVideo,
  hydrateVideos,
  canSeeVideo,
  publicVideoFilter,
  notify,
  logAdmin,
  getSettings,
  updateSettings,
};
