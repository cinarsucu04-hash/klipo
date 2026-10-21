'use strict';
const { cols } = require('./db');
const { HttpError } = require('./helpers');
const { sid, isBlockedEitherWay } = require('./services');

function dmKeyFor(a, b) {
  return [sid(a), sid(b)].sort().join(':');
}

// Alıcı ayarları ve engeller doğrultusunda mesaj gönderilebilir mi?
async function assertCanMessage(sender, recipient) {
  if (recipient.banned) throw new HttpError(404, 'Kullanıcı bulunamadı.');
  if (await isBlockedEitherWay(sender._id, recipient._id)) {
    throw new HttpError(403, 'Bu kullanıcıya mesaj gönderemezsin.');
  }
  const pref = recipient.allowMessages || 'everyone';
  if (pref === 'none') throw new HttpError(403, 'Bu kullanıcı mesaj almıyor.');
  if (pref === 'following') {
    const f = await cols.follows.findOne({ followerId: recipient._id, followingId: sender._id });
    if (!f) throw new HttpError(403, 'Bu kullanıcı yalnızca takip ettiklerinden mesaj kabul ediyor.');
  }
}

async function findOrCreateDm(me, other) {
  if (sid(me._id) === sid(other._id)) throw new HttpError(400, 'Kendine mesaj gönderemezsin.');
  const dmKey = dmKeyFor(me._id, other._id);
  let chat = await cols.chats.findOne({ dmKey });
  if (chat) return chat;
  await assertCanMessage(me, other);
  const doc = {
    type: 'dm',
    dmKey,
    members: [me._id, other._id],
    lastAt: null,
    lastMessage: null,
    clearedAt: {},
    createdAt: new Date(),
  };
  try {
    const r = await cols.chats.insertOne(doc);
    doc._id = r.insertedId;
    return doc;
  } catch (e) {
    if (e.code === 11000) return cols.chats.findOne({ dmKey });
    throw e;
  }
}

function previewText(msg) {
  if (msg.type === 'system') return msg.text;
  if (msg.mediaUrl && !msg.text) return '📷 Fotoğraf';
  if (msg.storyRef) return '↩️ Hikayene yanıt: ' + msg.text;
  return msg.text || '';
}

async function postMessage(chat, sender, { text = '', mediaUrl = '', type = 'text', storyRef = null }) {
  const now = new Date();
  const msg = {
    chatId: chat._id,
    senderId: sender ? sender._id : null,
    type,
    text,
    mediaUrl,
    storyRef,
    readBy: sender ? [sender._id] : [],
    createdAt: now,
  };
  const r = await cols.messages.insertOne(msg);
  msg._id = r.insertedId;
  await cols.chats.updateOne(
    { _id: chat._id },
    { $set: { lastAt: now, lastMessage: { text: previewText(msg).slice(0, 120), senderId: msg.senderId, type } } }
  );
  return msg;
}

function presentMessage(m, chat, meId) {
  const mine = m.senderId && sid(m.senderId) === sid(meId);
  const others = (m.readBy || []).filter((x) => sid(x) !== sid(m.senderId));
  return {
    id: sid(m._id),
    senderId: m.senderId ? sid(m.senderId) : null,
    type: m.type || 'text',
    text: m.text || '',
    mediaUrl: m.mediaUrl || '',
    storyRef: m.storyRef || null,
    createdAt: m.createdAt,
    // yalnızca kendi mesajlarım için: başkası gördü mü
    seen: mine ? others.length > 0 : undefined,
    readCount: mine && chat.type === 'group' ? others.length : undefined,
  };
}

module.exports = { dmKeyFor, assertCanMessage, findOrCreateDm, postMessage, presentMessage };
