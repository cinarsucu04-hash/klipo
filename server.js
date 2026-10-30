'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const { FallbackStore } = require('./lib/sessionstore');

const cfg = require('./lib/config');
const db = require('./lib/db');
const storage = require('./lib/storage');
const { HttpError, wrap, sleep, isQuotaError, FULL_MESSAGE } = require('./lib/helpers');
const mw = require('./lib/middleware');
const security = require('./lib/security');
const push = require('./lib/push');

let sessionMw = null; // oturum ara katmanı DB bağlanınca kurulur
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render, ters proxy arkasında çalışır (gerçek IP ve https için)

// ------------------------------------------------------------ güvenlik başlıkları
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"].concat(cfg.GOOGLE_CLIENT_ID ? ['https://accounts.google.com/gsi/client'] : []),
        'style-src': ["'self'", "'unsafe-inline'"].concat(cfg.GOOGLE_CLIENT_ID ? ['https://accounts.google.com/gsi/style'] : []),
        'frame-src': cfg.GOOGLE_CLIENT_ID ? ['https://accounts.google.com/gsi/'] : ["'none'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'media-src': ["'self'", 'blob:'],
        'connect-src': ["'self'"].concat(cfg.GOOGLE_CLIENT_ID ? ['https://accounts.google.com/gsi/'] : []),
        'worker-src': ["'self'"],
        'manifest-src': ["'self'"],
        'frame-ancestors': ["'none'"],
        'upgrade-insecure-requests': cfg.isProd ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }, // Google giriş penceresi için
    crossOriginResourcePolicy: { policy: 'same-origin' },
  })
);
app.use(compression());

// ------------------------------------------------------------ sağlık kontrolü (DB'den bağımsız)
// Veritabanı hatasını (ham mesajı sızdırmadan) kısa bir koda çevirir; arayüz buna göre yol gösterir
function dbErrorCode() {
  if (db.state.ready) return '';
  if (!cfg.MONGO_URL) return 'MONGO_URL_YOK';
  const m = String(db.state.error || '');
  if (!m) return '';
  if (/bad auth|authentication failed/i.test(m)) return 'SIFRE';
  if (/ENOTFOUND|querySrv|ECONNREFUSED|Invalid (scheme|connection string)|MongoParseError/i.test(m)) return 'ADRES';
  if (/timed out|ReplicaSetNoPrimary|ssl|tls|selection/i.test(m)) return 'AG';
  return 'DIGER';
}

app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true, db: db.state.ready && !!sessionMw, dbError: dbErrorCode(), uptime: Math.round(process.uptime()) });
});

// ------------------------------------------------------------ statik dosyalar
const pub = path.join(__dirname, 'public');
app.use(
  express.static(pub, {
    index: false,
    etag: true,
    lastModified: true,
    maxAge: 0, // her zaman doğrula (ETag ile 304); yeni sürüm anında görünür
    setHeaders: (res, file) => {
      if (file.endsWith('sw.js')) res.setHeader('Service-Worker-Allowed', '/');
      if (/\.(png|jpg|svg|ico|woff2?)$/.test(file)) res.setHeader('Cache-Control', 'public, max-age=604800');
    },
  })
);

// ------------------------------------------------------------ oturum (DB bağlanınca kurulur)
function buildSession() {
  sessionMw = session({
    name: 'klipo.sid',
    secret: cfg.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: true,
    // TTL dizini db.js içinde (yazma kapalıyken başlangıcı engellemesin diye) oluşturulur; depo dolunca oturumlar bellekte tutulur
    store: new FallbackStore(MongoStore.create({ clientPromise: Promise.resolve(db.state.client), dbName: cfg.DB_NAME, collectionName: 'sessions', ttl: 30 * 24 * 3600, touchAfter: 3600, autoRemove: 'disabled' })),
    cookie: { httpOnly: true, sameSite: 'lax', secure: cfg.isProd ? 'auto' : false, maxAge: 30 * 24 * 3600 * 1000 },
  });
}

function sessionGate(req, res, next) {
  if (!db.state.ready || !sessionMw) {
    return next(new HttpError(503, 'Sunucu başlatılıyor, birkaç saniye sonra tekrar dene.', 'STARTING'));
  }
  sessionMw(req, res, next);
}

// Medya için isteğe bağlı kimlik doğrulama (yalnızca korumalı dosyalarda çağrılır)
function authenticateOnDemand(req, res) {
  return new Promise((resolve) => {
    sessionGate(req, res, (err) => {
      if (err) return resolve(null);
      mw.loadUser(req, res, () => resolve(req.user || null)).catch(() => resolve(null));
    });
  });
}

app.get(
  '/media/:id',
  wrap(async (req, res) => {
    if (!db.state.ready) throw new HttpError(503, 'Sunucu başlatılıyor.', 'STARTING');
    await storage.serve(req, res, () => authenticateOnDemand(req, res));
  })
);

// ------------------------------------------------------------ API
const api = express.Router();
api.use(express.json({ limit: '200kb' }));
api.use(express.urlencoded({ extended: false, limit: '200kb' }));
api.use(mw.noStore, mw.apiLimiter, sessionGate, wrap(mw.loadUser), wrap(security.ipGate), mw.csrf, mw.writeLimiter);

api.use('/auth', require('./routes/auth'));
api.use(wrap(mw.maintenance));
api.use(mw.requireAuth);

const videoRoutes = require('./routes/videos');
api.use('/videos', videoRoutes.videos);
api.use('/comments', videoRoutes.comments);
api.use('/stories', require('./routes/stories'));
api.use('/sounds', require('./routes/sounds'));
api.use('/push', require('./routes/push'));
api.use('/users', require('./routes/users'));
api.use('/me', require('./routes/me'));
api.use('/chats', require('./routes/chats'));
api.use('/reports', require('./routes/reports'));
api.use('/admin', mw.requireAdmin, require('./routes/admin'));
api.use('/', require('./routes/explore'));

api.use((req, res, next) => next(new HttpError(404, 'Bulunamadı.')));
app.use('/api', api);

// ------------------------------------------------------------ SPA
const indexFile = path.join(pub, 'index.html');
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/media/')) return next();
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(indexFile);
});

// ------------------------------------------------------------ hata yönetimi
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  let status = err.status || 500;
  let message = err.message;
  if (err.type === 'entity.too.large') {
    status = 413;
    message = 'İstek çok büyük.';
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Geçersiz istek gövdesi.';
  } else if (err.name === 'MulterError') {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    message = err.code === 'LIMIT_FILE_SIZE' ? 'Dosya çok büyük. İzin verilen boyutu aştın.' : 'Dosya yüklenemedi.';
  }
  if (isQuotaError(err)) {
    status = 507;
    message = FULL_MESSAGE;
    err.code = 'STORAGE_FULL';
    console.error('[depolama dolu]', req.method, req.originalUrl);
  } else if (status >= 500 && !(err instanceof HttpError)) {
    console.error('[hata]', req.method, req.originalUrl, err);
    message = 'Sunucuda bir hata oluştu. Lütfen tekrar dene.';
  }
  if (res.headersSent) return res.destroy();
  if (req.originalUrl.startsWith('/api/')) return res.status(status).json({ error: message, code: err.code || undefined });
  res.status(status).type('text/plain; charset=utf-8').send(message);
});

// ------------------------------------------------------------ başlatma
const server = app.listen(cfg.PORT, '0.0.0.0', () => {
  console.log(`${cfg.APP_NAME} ${cfg.PORT} portunda dinleniyor`);
});
// uzun video yüklemeleri için zaman aşımlarını gevşet
server.requestTimeout = 0;
server.headersTimeout = 65000;
server.keepAliveTimeout = 65000;

async function connectWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.connect();
      buildSession();
      await push.init().catch((e) => console.error('[push] başlatılamadı (bildirimler kapalı):', e.message));
      console.log('MongoDB bağlantısı hazır.');
      if (cfg.STORAGE_MIGRATE) require('./lib/storagetools').bootMigrate(cfg.STORAGE_MIGRATE).catch((e) => console.error('[depolama] acil taşıma hatası:', e.message));
      return;
    } catch (e) {
      db.state.error = e.message;
      console.error(`[db] bağlantı denemesi ${attempt} başarısız: ${e.message}`);
      await db.close(); // yarım kalan bağlantıyı bırak; sonraki denemede yenisi kurulur
      if (!cfg.MONGO_URL) {
        console.error('[db] MONGO_URL tanımlı değil. Render > Environment bölümünden ekleyin.');
      }
      await sleep(Math.min(30000, 2000 * attempt));
    }
  }
}

// Süresi dolan hikayeleri (ve medyalarını) temizle
async function sweepStories() {
  if (!db.state.ready) return;
  try {
    const { purgeStory } = require('./lib/purge');
    const old = await db.cols.stories.find({ createdAt: { $lt: new Date(Date.now() - 24 * 3600 * 1000 - 3600 * 1000) } }).limit(200).toArray();
    for (const s of old) await purgeStory(s);
  } catch (e) {
    console.error('[hikaye temizliği]', e.message);
  }
}

// Render ücretsiz plan uyku modunu azaltmak için kendi adresine ping
function keepAlive() {
  if (!cfg.KEEP_ALIVE || !cfg.SITE_URL || typeof fetch !== 'function') return;
  setInterval(() => {
    fetch(cfg.SITE_URL.replace(/\/$/, '') + '/healthz').catch(() => {});
  }, 10 * 60 * 1000).unref();
}

connectWithRetry();
setInterval(sweepStories, 30 * 60 * 1000).unref();
keepAlive();

async function shutdown(signal) {
  console.log(`${signal} alındı, kapatılıyor...`);
  server.close();
  await db.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
