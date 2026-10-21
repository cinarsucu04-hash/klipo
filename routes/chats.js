'use strict';
const express = require('express');
const { cols } = require('../lib/db');
const { HttpError, wrap, oid, clean } = require('../lib/helpers');
const { sid, userCard, usersById, blockedIds, isBlockedEitherWay } = require('../lib/services');
const storage = require('../lib/storage');
const { findOrCreateDm, assertCanMessage, postMessage, presentMessage } = require('../lib/chats');

const router = express.Router();
const MAX_GROUP_MEMBERS = 50;

async function loadChat(req) {
  const chat = await cols.chats.findOne({ _id: oid(req.params.id, 'Geçersiz sohbet'), members: req.user._id });
  if (!chat) throw new HttpError(404, 'Sohbet bulunamadı.');
  return chat;
}

const isOwner = (chat, userId) => sid(chat.createdBy) === sid(userId);
const isAdmin = (chat, userId) => isOwner(chat, userId) || (chat.admins || []).some((a) => sid(a) === sid(userId));

function requireGroup(chat) {
  if (chat.type !== 'group') throw new HttpError(400, 'Bu işlem yalnızca gruplar için geçerli.');
}

async function system(chat, text) {
  await postMessage(chat, null, { type: 'system', text });
}

// ---------------------------------------------------------------- LİSTE
router.get(
  '/',
  wrap(async (req, res) => {
    const me = req.user;
    const chats = await cols.chats.find({ members: me._id, lastAt: { $ne: null } }).sort({ lastAt: -1 }).limit(100).toArray();
    if (!chats.length) return res.json({ chats: [] });

    const otherIds = chats.filter((c) => c.type === 'dm').map((c) => c.members.find((m) => sid(m) !== sid(me._id)));
    const [users, unreadRows] = await Promise.all([
      usersById(otherIds),
      cols.messages
        .aggregate([
          { $match: { chatId: { $in: chats.map((c) => c._id) }, senderId: { $ne: me._id }, readBy: { $ne: me._id } } },
          { $group: { _id: '$chatId', n: { $sum: 1 } } },
        ])
        .toArray(),
    ]);
    const unread = new Map(unreadRows.map((r) => [sid(r._id), r.n]));

    const out = [];
    for (const c of chats) {
      const cleared = c.clearedAt && c.clearedAt[sid(me._id)];
      const visible = !cleared || new Date(c.lastAt) > new Date(cleared);
      const base = {
        id: sid(c._id),
        type: c.type,
        lastAt: c.lastAt,
        unread: unread.get(sid(c._id)) || 0,
        lastMessage:
          visible && c.lastMessage
            ? { text: c.lastMessage.text, mine: c.lastMessage.senderId ? sid(c.lastMessage.senderId) === sid(me._id) : false, type: c.lastMessage.type }
            : null,
      };
      if (c.type === 'dm') {
        const other = users.get(sid(c.members.find((m) => sid(m) !== sid(me._id))));
        if (!other) continue; // karşı taraf hesabını silmiş
        out.push({ ...base, name: other.nickname || other.username, user: userCard(other) });
      } else {
        out.push({ ...base, name: c.name, memberCount: c.members.length });
      }
    }
    res.json({ chats: out });
  })
);

// ---------------------------------------------------------------- OLUŞTUR
router.post(
  '/dm',
  wrap(async (req, res) => {
    const body = req.body || {};
    const filter = body.userId ? { _id: oid(body.userId) } : { username: clean(body.username, 30).toLowerCase() };
    const other = await cols.users.findOne({ ...filter, banned: { $ne: true } }, { projection: { password: 0 } });
    if (!other) throw new HttpError(404, 'Kullanıcı bulunamadı.');
    const chat = await findOrCreateDm(req.user, other);
    res.json({ chatId: sid(chat._id) });
  })
);

router.post(
  '/group',
  wrap(async (req, res) => {
    const me = req.user;
    const body = req.body || {};
    const name = clean(body.name, 40) || 'Yeni grup';
    const rawList = Array.isArray(body.members) ? body.members : String(body.members || '').split(',');
    const names = [...new Set(rawList.map((m) => clean(m, 30).toLowerCase().replace(/^@/, '')).filter(Boolean))]
      .filter((n) => n !== me.username)
      .slice(0, MAX_GROUP_MEMBERS - 1);
    const found = names.length ? await cols.users.find({ username: { $in: names }, banned: { $ne: true } }, { projection: { password: 0 } }).toArray() : [];
    const members = [me._id];
    const skipped = names.filter((n) => !found.some((u) => u.username === n));
    for (const u of found) {
      try {
        await assertCanMessage(me, u);
        members.push(u._id);
      } catch (e) {
        skipped.push(u.username);
      }
    }
    if (members.length < 2) throw new HttpError(400, 'Gruba en az bir geçerli üye eklemelisin.');

    const doc = {
      type: 'group',
      name,
      members,
      admins: [me._id],
      createdBy: me._id,
      lastAt: null,
      lastMessage: null,
      clearedAt: {},
      createdAt: new Date(),
    };
    const r = await cols.chats.insertOne(doc);
    doc._id = r.insertedId;
    await system(doc, `${me.nickname || me.username} grubu oluşturdu.`);
    res.json({ chatId: sid(doc._id), skipped });
  })
);

// ---------------------------------------------------------------- BİLGİ / MESAJLAR
router.get(
  '/:id',
  wrap(async (req, res) => {
    const me = req.user;
    const chat = await loadChat(req);
    const users = await usersById(chat.members);
    const members = chat.members
      .filter((m) => users.has(sid(m)))
      .map((m) => ({
        ...userCard(users.get(sid(m))),
        role: isOwner(chat, m) ? 'owner' : isAdmin(chat, m) ? 'admin' : 'member',
      }));
    const info = { id: sid(chat._id), type: chat.type, members, iAmAdmin: isAdmin(chat, me._id), iAmOwner: isOwner(chat, me._id) };
    if (chat.type === 'dm') {
      const other = members.find((m) => m.id !== sid(me._id));
      info.name = other ? other.nickname : 'Sohbet';
      info.user = other || null;
    } else {
      info.name = chat.name;
    }
    res.json({ chat: info });
  })
);

router.get(
  '/:id/messages',
  wrap(async (req, res) => {
    const me = req.user;
    const chat = await loadChat(req);
    const cleared = chat.clearedAt && chat.clearedAt[sid(me._id)];
    const filter = { chatId: chat._id };
    if (cleared) filter.createdAt = { $gt: new Date(cleared) };

    let list;
    let hasMore = false;
    if (req.query.after) {
      filter._id = { $gt: oid(req.query.after) };
      list = await cols.messages.find(filter).sort({ _id: 1 }).limit(100).toArray();
    } else {
      if (req.query.before) filter._id = { $lt: oid(req.query.before) };
      const rows = await cols.messages.find(filter).sort({ _id: -1 }).limit(41).toArray();
      hasMore = rows.length > 40;
      list = rows.slice(0, 40).reverse();
    }

    // okundu bilgisi
    await cols.messages.updateMany(
      { chatId: chat._id, senderId: { $ne: me._id }, readBy: { $ne: me._id } },
      { $addToSet: { readBy: me._id } }
    );

    let seenUpTo = null;
    if (chat.type === 'dm') {
      const otherId = chat.members.find((m) => sid(m) !== sid(me._id));
      const lastSeen = await cols.messages.findOne({ chatId: chat._id, senderId: me._id, readBy: otherId }, { sort: { _id: -1 }, projection: { _id: 1 } });
      seenUpTo = lastSeen ? sid(lastSeen._id) : null;
    }

    const senders = await usersById(list.map((m) => m.senderId));
    const senderMap = {};
    for (const [id, u] of senders) senderMap[id] = userCard(u);

    res.json({
      messages: list.map((m) => presentMessage(m, chat, me._id)),
      senders: senderMap,
      hasMore,
      seenUpTo,
    });
  })
);

router.post(
  '/:id/messages',
  storage.uploadImage('image'),
  wrap(async (req, res) => {
    const me = req.user;
    const chat = await loadChat(req);
    const text = clean((req.body || {}).text, 1000);
    if (!text && !req.file) throw new HttpError(400, 'Mesaj boş olamaz.');

    if (chat.type === 'dm') {
      const otherId = chat.members.find((m) => sid(m) !== sid(me._id));
      const other = otherId ? await cols.users.findOne({ _id: otherId, banned: { $ne: true } }, { projection: { password: 0 } }) : null;
      if (!other) throw new HttpError(404, 'Bu kullanıcı artık mevcut değil.');
      await assertCanMessage(me, other);
    }

    let mediaUrl = '';
    if (req.file) mediaUrl = (await storage.save(req.file, 'image')).url;
    const msg = await postMessage(chat, me, { text, mediaUrl });
    res.json({ message: presentMessage(msg, chat, me._id) });
  })
);

router.post(
  '/:id/clear',
  wrap(async (req, res) => {
    const chat = await loadChat(req);
    await cols.chats.updateOne({ _id: chat._id }, { $set: { [`clearedAt.${sid(req.user._id)}`]: new Date() } });
    await cols.messages.updateMany({ chatId: chat._id, readBy: { $ne: req.user._id } }, { $addToSet: { readBy: req.user._id } });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------- GRUP YÖNETİMİ
router.patch(
  '/:id',
  wrap(async (req, res) => {
    const chat = await loadChat(req);
    requireGroup(chat);
    if (!isAdmin(chat, req.user._id)) throw new HttpError(403, 'Yalnızca yöneticiler grubu düzenleyebilir.');
    const name = clean((req.body || {}).name, 40);
    if (!name) throw new HttpError(400, 'Grup adı boş olamaz.');
    await cols.chats.updateOne({ _id: chat._id }, { $set: { name } });
    await system(chat, `${req.user.nickname || req.user.username} grup adını "${name}" yaptı.`);
    res.json({ ok: true, name });
  })
);

router.post(
  '/:id/members',
  wrap(async (req, res) => {
    const me = req.user;
    const chat = await loadChat(req);
    requireGroup(chat);
    if (!isAdmin(chat, me._id)) throw new HttpError(403, 'Yalnızca yöneticiler üye ekleyebilir.');
    if (chat.members.length >= MAX_GROUP_MEMBERS) throw new HttpError(400, `Bir grupta en fazla ${MAX_GROUP_MEMBERS} üye olabilir.`);
    const username = clean((req.body || {}).username, 30).toLowerCase().replace(/^@/, '');
    const user = await cols.users.findOne({ username, banned: { $ne: true } }, { projection: { password: 0 } });
    if (!user) throw new HttpError(404, 'Kullanıcı bulunamadı.');
    if (chat.members.some((m) => sid(m) === sid(user._id))) throw new HttpError(409, 'Kullanıcı zaten grupta.');
    await assertCanMessage(me, user);
    await cols.chats.updateOne({ _id: chat._id }, { $addToSet: { members: user._id } });
    await system(chat, `${me.nickname || me.username}, @${user.username} kullanıcısını ekledi.`);
    res.json({ ok: true });
  })
);

router.post(
  '/:id/kick',
  wrap(async (req, res) => {
    const me = req.user;
    const chat = await loadChat(req);
    requireGroup(chat);
    const targetId = oid((req.body || {}).userId);
    if (sid(targetId) === sid(me._id)) throw new HttpError(400, 'Kendini atamazsın; gruptan ayrıl.');
    if (!chat.members.some((m) => sid(m) === sid(targetId))) throw new HttpError(404, 'Kullanıcı grupta değil.');
    const allowed = isOwner(chat, me._id) || (isAdmin(chat, me._id) && !isAdmin(chat, targetId));
    if (!allowed) throw new HttpError(403, 'Bu kullanıcıyı gruptan atamazsın.');
    const target = await cols.users.findOne({ _id: targetId }, { projection: { username: 1 } });
    await cols.chats.updateOne({ _id: chat._id }, { $pull: { members: targetId, admins: targetId } });
    await system(chat, `@${target ? target.username : 'kullanıcı'} gruptan çıkarıldı.`);
    res.json({ ok: true });
  })
);

router.post(
  '/:id/admin',
  wrap(async (req, res) => {
    const chat = await loadChat(req);
    requireGroup(chat);
    if (!isOwner(chat, req.user._id)) throw new HttpError(403, 'Yalnızca grubu kuran kişi yönetici atayabilir.');
    const targetId = oid((req.body || {}).userId);
    if (!chat.members.some((m) => sid(m) === sid(targetId))) throw new HttpError(404, 'Kullanıcı grupta değil.');
    if (sid(targetId) === sid(chat.createdBy)) throw new HttpError(400, 'Grubu kuran kişi zaten yönetici.');
    const make = (req.body || {}).make !== false;
    await cols.chats.updateOne({ _id: chat._id }, make ? { $addToSet: { admins: targetId } } : { $pull: { admins: targetId } });
    res.json({ ok: true, admin: make });
  })
);

router.post(
  '/:id/leave',
  wrap(async (req, res) => {
    const me = req.user;
    const chat = await loadChat(req);
    requireGroup(chat);
    const remaining = chat.members.filter((m) => sid(m) !== sid(me._id));
    if (!remaining.length) {
      const msgs = await cols.messages.find({ chatId: chat._id, mediaUrl: { $ne: '' } }, { projection: { mediaUrl: 1 } }).toArray();
      await storage.removeMany(msgs.map((m) => m.mediaUrl));
      await cols.messages.deleteMany({ chatId: chat._id });
      await cols.chats.deleteOne({ _id: chat._id });
      return res.json({ ok: true });
    }
    let owner = chat.createdBy;
    let admins = (chat.admins || []).filter((a) => sid(a) !== sid(me._id));
    if (isOwner(chat, me._id)) {
      owner = admins[0] || remaining[0];
    }
    if (!admins.some((a) => sid(a) === sid(owner))) admins.push(owner);
    await cols.chats.updateOne({ _id: chat._id }, { $pull: { members: me._id }, $set: { createdBy: owner, admins } });
    await system(chat, `${me.nickname || me.username} gruptan ayrıldı.`);
    res.json({ ok: true });
  })
);

module.exports = router;
