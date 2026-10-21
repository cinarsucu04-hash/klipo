'use strict';
// Silme işlemlerinde ilişkili tüm verileri (ve medya dosyalarını) temizler.
const { cols } = require('./db');
const storage = require('./storage');
const { sid } = require('./services');

function tally(map, id) {
  const k = sid(id);
  const cur = map.get(k);
  if (cur) cur.n += 1;
  else map.set(k, { id, n: 1 });
}

async function bulkInc(col, field, map) {
  const ops = [...map.values()].map(({ id, n }) => ({
    updateOne: { filter: { _id: id }, update: { $inc: { [field]: -n } } },
  }));
  if (ops.length) await col.bulkWrite(ops, { ordered: false });
}

async function purgeVideo(video) {
  const commentIds = (await cols.comments.find({ videoId: video._id }, { projection: { _id: 1 } }).toArray()).map((c) => c._id);
  if (commentIds.length) await cols.commentLikes.deleteMany({ commentId: { $in: commentIds } });
  await Promise.all([
    cols.videos.deleteOne({ _id: video._id }),
    cols.comments.deleteMany({ videoId: video._id }),
    cols.likes.deleteMany({ videoId: video._id }),
    cols.saves.deleteMany({ videoId: video._id }),
    cols.history.deleteMany({ videoId: video._id }),
    cols.notifications.deleteMany({ videoId: video._id }),
  ]);
  await storage.removeMany([video.mediaUrl, video.posterUrl]);
}

// Bir yorumu (üst düzeyse yanıtlarıyla birlikte) siler; video sayaçlarını düzeltir
async function purgeComment(comment) {
  const ids = [comment._id];
  if (!comment.parentId) {
    const replies = await cols.comments.find({ parentId: comment._id }, { projection: { _id: 1 } }).toArray();
    ids.push(...replies.map((r) => r._id));
  }
  await cols.commentLikes.deleteMany({ commentId: { $in: ids } });
  await cols.notifications.deleteMany({ commentId: { $in: ids } });
  const r = await cols.comments.deleteMany({ _id: { $in: ids } });
  if (r.deletedCount) await cols.videos.updateOne({ _id: comment.videoId }, { $inc: { comments: -r.deletedCount } });
  if (comment.parentId) await cols.comments.updateOne({ _id: comment.parentId }, { $inc: { replyCount: -1 } });
  return r.deletedCount;
}

async function purgeStory(story) {
  await Promise.all([cols.stories.deleteOne({ _id: story._id }), cols.storyViews.deleteMany({ storyId: story._id })]);
  await storage.removeByUrl(story.mediaUrl);
}

async function purgeUser(userId) {
  // 1) videolar
  const videos = await cols.videos.find({ userId }).toArray();
  for (const v of videos) await purgeVideo(v);

  // 2) yorumlar (+ üst düzey yorumlarının yanıtları)
  const mine = await cols.comments.find({ userId }).toArray();
  if (mine.length) {
    const topIds = mine.filter((c) => !c.parentId).map((c) => c._id);
    const replies = topIds.length ? await cols.comments.find({ parentId: { $in: topIds } }).toArray() : [];
    const all = new Map();
    [...mine, ...replies].forEach((c) => all.set(sid(c._id), c));
    const perVideo = new Map();
    const perParent = new Map();
    for (const c of all.values()) {
      tally(perVideo, c.videoId);
      if (c.parentId && !all.has(sid(c.parentId))) tally(perParent, c.parentId);
    }
    const ids = [...all.values()].map((c) => c._id);
    await cols.commentLikes.deleteMany({ commentId: { $in: ids } });
    await cols.comments.deleteMany({ _id: { $in: ids } });
    await bulkInc(cols.videos, 'comments', perVideo);
    await bulkInc(cols.comments, 'replyCount', perParent);
  }

  // 3) beğeni / kaydetme / yorum beğenisi sayaçları
  for (const [col, field, target] of [
    [cols.likes, 'likes', cols.videos],
    [cols.saves, 'saves', cols.videos],
  ]) {
    const rows = await col.find({ userId }, { projection: { videoId: 1 } }).toArray();
    const map = new Map();
    rows.forEach((r) => tally(map, r.videoId));
    await bulkInc(target, field, map);
    await col.deleteMany({ userId });
  }
  const cl = await cols.commentLikes.find({ userId }, { projection: { commentId: 1 } }).toArray();
  const clMap = new Map();
  cl.forEach((r) => tally(clMap, r.commentId));
  await bulkInc(cols.comments, 'likes', clMap);
  await cols.commentLikes.deleteMany({ userId });

  // 4) sosyal graf
  await Promise.all([
    cols.follows.deleteMany({ $or: [{ followerId: userId }, { followingId: userId }] }),
    cols.followRequests.deleteMany({ $or: [{ fromId: userId }, { toId: userId }] }),
    cols.blocks.deleteMany({ $or: [{ userId }, { targetId: userId }] }),
    cols.notifications.deleteMany({ $or: [{ userId }, { actorId: userId }] }),
    cols.history.deleteMany({ userId }),
    cols.searches.deleteMany({ userId }),
    cols.visitors.deleteMany({ $or: [{ profileId: userId }, { visitorId: userId }] }),
    cols.storyViews.deleteMany({ userId }),
  ]);

  // 5) hikayeler
  const stories = await cols.stories.find({ userId }).toArray();
  for (const s of stories) await purgeStory(s);

  // 6) sohbetler
  const chats = await cols.chats.find({ members: userId }).toArray();
  for (const c of chats) {
    const remaining = c.members.filter((m) => sid(m) !== sid(userId));
    if (c.type === 'dm' || remaining.length === 0) {
      const msgs = await cols.messages.find({ chatId: c._id, mediaUrl: { $ne: '' } }, { projection: { mediaUrl: 1 } }).toArray();
      await storage.removeMany(msgs.map((m) => m.mediaUrl));
      await cols.messages.deleteMany({ chatId: c._id });
      await cols.chats.deleteOne({ _id: c._id });
    } else {
      const set = {};
      if (sid(c.createdBy) === sid(userId)) set.createdBy = remaining[0];
      const admins = (c.admins || []).filter((a) => sid(a) !== sid(userId));
      if (!admins.length) admins.push(remaining[0]);
      await cols.chats.updateOne({ _id: c._id }, { $pull: { members: userId }, $set: { ...set, admins } });
    }
  }
  await cols.messages.updateMany({ senderId: userId }, { $set: { text: '[silinmiş hesap]', mediaUrl: '' } });

  // 7) profil görselleri ve hesap
  const user = await cols.users.findOne({ _id: userId });
  if (user) await storage.removeMany([user.avatar, user.banner]);
  await cols.users.deleteOne({ _id: userId });
}

module.exports = { purgeVideo, purgeComment, purgeStory, purgeUser };
