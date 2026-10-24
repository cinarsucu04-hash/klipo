'use strict';
const { MongoClient, GridFSBucket } = require('mongodb');
const cfg = require('./config');

// `cols` nesnesi bağlantı kurulunca doldurulur (aynı nesne referansı korunur)
const cols = {};
const state = { ready: false, client: null, db: null, bucket: null, error: '' };

const COLLECTIONS = [
  'users', 'videos', 'comments', 'commentLikes', 'follows', 'followRequests', 'likes', 'saves',
  'stories', 'storyViews', 'chats', 'messages', 'notifications', 'reports', 'blocks', 'logs',
  'history', 'searches', 'settings', 'visitors', 'media', 'sounds', 'pushSubs',
];

async function connect() {
  if (!cfg.MONGO_URL) throw new Error('MONGO_URL ortam değişkeni tanımlı değil');
  const client = new MongoClient(cfg.MONGO_URL, { serverSelectionTimeoutMS: 8000, maxPoolSize: 10 });
  await client.connect();
  const db = client.db(cfg.DB_NAME);
  for (const name of COLLECTIONS) cols[name] = db.collection(name);
  state.client = client;
  state.db = db;
  state.bucket = new GridFSBucket(db, { bucketName: 'uploads' });
  await ensureIndexes();
  state.ready = true;
  state.error = '';
  return state;
}

async function ensureIndexes() {
  const c = cols;
  await Promise.all([
    c.users.createIndex({ username: 1 }, { unique: true }),
    c.users.createIndex({ createdAt: -1 }),
    c.videos.createIndex({ createdAt: -1 }),
    c.videos.createIndex({ userId: 1, createdAt: -1 }),
    c.videos.createIndex({ hashtags: 1, createdAt: -1 }),
    c.comments.createIndex({ videoId: 1, parentId: 1, createdAt: -1 }),
    c.comments.createIndex({ parentId: 1, createdAt: 1 }),
    c.follows.createIndex({ followerId: 1, followingId: 1 }, { unique: true }),
    c.follows.createIndex({ followingId: 1, _id: -1 }),
    c.followRequests.createIndex({ fromId: 1, toId: 1 }, { unique: true }),
    c.followRequests.createIndex({ toId: 1, _id: -1 }),
    c.likes.createIndex({ userId: 1, videoId: 1 }, { unique: true }),
    c.likes.createIndex({ videoId: 1 }),
    c.saves.createIndex({ userId: 1, videoId: 1 }, { unique: true }),
    c.commentLikes.createIndex({ userId: 1, commentId: 1 }, { unique: true }),
    c.stories.createIndex({ createdAt: 1 }),
    c.stories.createIndex({ userId: 1, createdAt: -1 }),
    c.storyViews.createIndex({ storyId: 1, userId: 1 }, { unique: true }),
    c.chats.createIndex({ members: 1, lastAt: -1 }),
    c.chats.createIndex({ dmKey: 1 }, { unique: true, sparse: true }),
    c.messages.createIndex({ chatId: 1, _id: -1 }),
    c.notifications.createIndex({ userId: 1, createdAt: -1 }),
    c.blocks.createIndex({ userId: 1, targetId: 1 }, { unique: true }),
    c.blocks.createIndex({ targetId: 1 }),
    c.history.createIndex({ userId: 1, videoId: 1 }, { unique: true }),
    c.history.createIndex({ userId: 1, viewedAt: -1 }),
    c.visitors.createIndex({ profileId: 1, visitorId: 1 }, { unique: true }),
    c.visitors.createIndex({ profileId: 1, visitedAt: -1 }),
    c.searches.createIndex({ userId: 1, query: 1 }, { unique: true }),
    c.searches.createIndex({ userId: 1, updatedAt: -1 }),
    c.sounds.createIndex({ uses: -1, createdAt: -1 }),
    c.sounds.createIndex({ userId: 1 }),
    c.pushSubs.createIndex({ endpoint: 1 }, { unique: true }),
    c.pushSubs.createIndex({ userId: 1 }),
    c.logs.createIndex({ createdAt: -1 }),
    c.reports.createIndex({ status: 1, createdAt: -1 }),
  ]);
}

async function close() {
  if (state.client) await state.client.close().catch(() => {});
  state.ready = false;
}

module.exports = { cols, state, connect, close };
