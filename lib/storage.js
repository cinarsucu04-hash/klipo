'use strict';
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { ObjectId } = require('mongodb');
const cfg = require('./config');
const db = require('./db');
const { HttpError, tryOid } = require('./helpers');
const { canSeeVideo } = require('./services');

const VIDEO_TYPES = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-m4v': '.m4v',
  'video/3gpp': '.3gp',
};
const IMAGE_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};
const AUDIO_TYPES = {
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/mp4': '.m4a',
  'audio/webm': '.weba',
};
const EXT_TO_MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.mov': 'video/quicktime', '.webm': 'video/webm', '.3gp': 'video/3gpp',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
};

// Dosyanın ilk baytlarına bakarak türünü doğrular (istemcinin bildirdiği türe güvenmez)
async function sniff(filePath) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(16);
    await fh.read(buf, 0, 16, 0);
    const ascii = (a, b) => buf.toString('latin1', a, b);
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
    if (ascii(0, 3) === 'GIF') return 'image/gif';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
    if (ascii(0, 4) === 'OggS') return 'audio/ogg';
    if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
    if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg'; // MP3/AAC çerçeve başlığı
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video/webm';
    const box = ascii(4, 8);
    if (box === 'ftyp') return ['M4A ', 'M4B ', 'F4A '].includes(ascii(8, 12)) ? 'audio/mp4' : 'video/mp4';
    if (['moov', 'mdat', 'wide', 'free', 'skip'].includes(box)) return 'video/quicktime';
    return null;
  } finally {
    await fh.close();
  }
}

// kind: 'video' | 'image' | 'audio'
async function resolveType(file, kind) {
  const sniffed = await sniff(file.path);
  if (!sniffed) throw new HttpError(400, 'Dosya türü desteklenmiyor.');
  if (kind === 'audio') {
    const mime = sniffed === 'video/webm' ? 'audio/webm' : sniffed;
    if (!AUDIO_TYPES[mime]) throw new HttpError(400, 'Lütfen bir ses dosyası seç (MP3, M4A, OGG veya WAV).');
    return { mime, ext: AUDIO_TYPES[mime], isVideo: false, isAudio: true };
  }
  if (sniffed.startsWith('audio/')) throw new HttpError(400, 'Dosya türü desteklenmiyor.');
  const isVideo = sniffed.startsWith('video/');
  if (kind === 'video' && !isVideo) throw new HttpError(400, 'Lütfen bir video dosyası seç.');
  if (kind === 'image' && isVideo) throw new HttpError(400, 'Lütfen bir görsel dosyası seç.');
  // Dosya uzantısı/MIME ne derse desin, sunum türü içerikten gelir
  let mime = sniffed;
  if (isVideo) {
    const declared = String(file.mimetype || '').toLowerCase();
    const byExt = EXT_TO_MIME[path.extname(file.originalname || '').toLowerCase()];
    // mp4/mov/m4v/3gp aynı kapsayıcı ailesidir; bildirilen türü yalnızca bu aileden kabul et
    if (sniffed === 'video/mp4' || sniffed === 'video/quicktime') {
      const pick = [declared, byExt].find((t) => t && ['video/mp4', 'video/quicktime', 'video/x-m4v', 'video/3gpp'].includes(t));
      if (pick) mime = pick;
    }
  }
  const ext = (isVideo ? VIDEO_TYPES : IMAGE_TYPES)[mime];
  if (!ext) throw new HttpError(400, 'Dosya türü desteklenmiyor.');
  return { mime, ext, isVideo, isAudio: false };
}

// scope: 'public' (avatar/banner) | 'video' (videoya bağlı, görünürlük kurallarına uyar) | 'auth' (giriş şart)
async function save(file, kind, scope = 'auth') {
  const type = await resolveType(file, kind);
  const id = new ObjectId();
  const meta = { _id: id, kind: type.isAudio ? 'audio' : type.isVideo ? 'video' : 'image', scope, contentType: type.mime, size: file.size, createdAt: new Date() };

  if (cfg.STORAGE === 'disk') {
    await fsp.mkdir(cfg.UPLOAD_DIR, { recursive: true });
    const name = id.toString() + type.ext;
    await fsp.copyFile(file.path, path.join(cfg.UPLOAD_DIR, name));
    meta.file = name;
  } else {
    await new Promise((resolve, reject) => {
      const up = db.state.bucket.openUploadStreamWithId(id, id.toString() + type.ext, { metadata: { contentType: type.mime } });
      fs.createReadStream(file.path).on('error', reject).pipe(up).on('error', reject).on('finish', resolve);
    });
  }
  await db.cols.media.insertOne(meta);
  return { id: id.toString(), url: '/media/' + id.toString(), mime: type.mime, isVideo: type.isVideo };
}

async function removeByUrl(url) {
  const m = /^\/media\/([a-f0-9]{24})$/i.exec(String(url || ''));
  if (!m) return;
  const id = tryOid(m[1]);
  if (!id) return;
  try {
    const meta = await db.cols.media.findOne({ _id: id });
    if (!meta) return;
    if (meta.file) await fsp.unlink(path.join(cfg.UPLOAD_DIR, meta.file)).catch(() => {});
    else await db.state.bucket.delete(id).catch(() => {});
    await db.cols.media.deleteOne({ _id: id });
  } catch (e) {
    console.error('[medya silme]', e.message);
  }
}

async function removeMany(urls) {
  for (const u of urls) if (u) await removeByUrl(u);
}

// Videoya bağlı dosyanın durumu (30 sn önbellek): { exists, pub }
const visCache = new Map();
async function videoAccess(id) {
  const hit = visCache.get(id);
  if (hit && hit.exp > Date.now()) return hit.value;
  const url = '/media/' + id;
  const video = await db.cols.videos.findOne({ $or: [{ mediaUrl: url }, { posterUrl: url }] });
  const value = {
    exists: !!video,
    pub: !!video && video.visibility === 'public' && !video.ownerPrivate && !video.removed,
  };
  if (visCache.size > 2000) visCache.clear();
  visCache.set(id, { value, exp: Date.now() + 30000 });
  return value;
}

// GET /media/:id  — HTTP Range destekli akış (video ileri/geri sarma için şart)
// authenticate(): gerektiğinde oturumu çözüp kullanıcıyı döndüren async fonksiyon
async function serve(req, res, authenticate) {
  const id = tryOid(req.params.id);
  if (!id) return res.sendStatus(404);
  const meta = await db.cols.media.findOne({ _id: id });
  if (!meta) return res.sendStatus(404);

  let cache = 'public, max-age=31536000, immutable';
  if (meta.scope === 'video') {
    const acc = await videoAccess(req.params.id);
    if (!acc.exists) return res.sendStatus(404);
    if (!acc.pub) {
      const user = await authenticate();
      if (!user) return res.sendStatus(401);
      const url = '/media/' + req.params.id;
      const video = await db.cols.videos.findOne({ $or: [{ mediaUrl: url }, { posterUrl: url }] });
      if (!video || !(await canSeeVideo(video, user))) return res.sendStatus(404);
      cache = 'private, max-age=3600';
    }
  } else if (meta.scope !== 'public') {
    const user = await authenticate();
    if (!user) return res.sendStatus(401);
    cache = 'private, max-age=86400';
  }

  const size = meta.size;
  let start = 0;
  let end = size - 1;
  let status = 200;

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] !== '' || m[2] !== '')) {
      if (m[1] === '') {
        start = Math.max(0, size - Number(m[2]));
      } else {
        start = Number(m[1]);
        if (m[2] !== '') end = Math.min(end, Number(m[2]));
      }
      if (start >= size || start > end) {
        res.status(416).setHeader('Content-Range', `bytes */${size}`);
        return res.end();
      }
      status = 206;
    }
  }

  res.status(status);
  res.setHeader('Content-Type', meta.contentType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', end - start + 1);
  res.setHeader('Cache-Control', cache);
  if (status === 206) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  if (req.method === 'HEAD') return res.end();

  const stream = meta.file
    ? fs.createReadStream(path.join(cfg.UPLOAD_DIR, meta.file), { start, end })
    : db.state.bucket.openDownloadStream(id, { start, end: end + 1 });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy && stream.destroy());
  stream.pipe(res);
}

// ---- multer: geçici dosyaya yazar, sonra save() ile kalıcı depoya taşınır ----
const tmpStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, os.tmpdir()),
  filename: (req, file, cb) => cb(null, 'klipo-' + crypto.randomUUID() + '.upload'),
});

function makeUploader(maxMb) {
  return multer({ storage: tmpStorage, limits: { fileSize: maxMb * 1024 * 1024, files: 3, fields: 20 } });
}

const uploadVideoFields = makeUploader(cfg.MAX_VIDEO_MB).fields([
  { name: 'video', maxCount: 1 },
  { name: 'poster', maxCount: 1 },
]);
const uploadStoryFile = makeUploader(cfg.MAX_VIDEO_MB).single('media');
const uploadProfileFields = makeUploader(cfg.MAX_IMAGE_MB).fields([
  { name: 'avatar', maxCount: 1 },
  { name: 'banner', maxCount: 1 },
]);
const uploadImageOptional = (field) => makeUploader(cfg.MAX_IMAGE_MB).single(field);
const uploadAudioFile = makeUploader(cfg.MAX_AUDIO_MB).single('audio');

// İstek bitince artakalan geçici dosyaları siler
function tmpCleanup(req, res, next) {
  res.on('close', () => {
    const files = [];
    if (req.file) files.push(req.file);
    if (req.files) {
      if (Array.isArray(req.files)) files.push(...req.files);
      else Object.values(req.files).forEach((arr) => files.push(...arr));
    }
    for (const f of files) fsp.unlink(f.path).catch(() => {});
  });
  next();
}

// multer'ı tmpCleanup ile birlikte çalıştıran sarmalayıcı
const withCleanup = (mw) => [tmpCleanup, mw];

module.exports = {
  save,
  serve,
  removeByUrl,
  removeMany,
  uploadVideo: withCleanup(uploadVideoFields),
  uploadStory: withCleanup(uploadStoryFile),
  uploadProfile: withCleanup(uploadProfileFields),
  uploadAudio: withCleanup(uploadAudioFile),
  uploadImage: (field) => withCleanup(uploadImageOptional(field)),
};
