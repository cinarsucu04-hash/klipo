'use strict';
// Yönetici depolama araçları: doluluk istatistiği, dış depoya kopyalama, doğrulanmış nüshaları boşaltma, sahipsiz dosya temizliği.
// İLKE: hiçbir hesap/video/yorum silinmez. Kopyalama salt-okunurdur (MongoDB'den okur, dış depoya yazar).
// Boşaltma yalnızca dış depodaki nüshası bayt bayt (MD5) doğrulanmış dosyaların MongoDB'deki kopyasını kaldırır;
// video dış depodan oynamaya devam eder.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const db = require('./db');
const s3 = require('./s3');
const storage = require('./storage');

const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000; // 1 saatten yeni dosyalar yüklenmekte olabilir; dokunma

const files = () => db.state.db.collection('uploads.files');

async function getStats() {
  const out = {
    backend: storage.activeBackend(),
    external: { configured: s3.enabled(), info: s3.info() },
    db: null,
    grid: { count: 0, bytes: 0 },
    orphans: { count: 0, bytes: 0 },
    media: { count: 0, bytes: 0, disk: { count: 0, bytes: 0 }, byKind: {} },
    externalCount: 0,
    externalBytes: 0,
    collections: [],
    job: jobStatus(),
  };
  try {
    out.db = await storage.dbUsage(true);
  } catch (e) {
    out.db = null;
  }

  const [g] = await files().aggregate([{ $group: { _id: null, count: { $sum: 1 }, bytes: { $sum: '$length' } } }]).toArray();
  if (g) out.grid = { count: g.count, bytes: g.bytes };

  // sahipsiz: GridFS'te var ama media kaydı yok (yarım kalmış yükleme artığı)
  const cutoff = new Date(Date.now() - ORPHAN_MIN_AGE_MS);
  const [o] = await files()
    .aggregate([
      { $match: { uploadDate: { $lt: cutoff } } },
      { $lookup: { from: 'media', localField: '_id', foreignField: '_id', as: 'm' } },
      { $match: { m: { $size: 0 } } },
      { $group: { _id: null, count: { $sum: 1 }, bytes: { $sum: '$length' } } },
    ])
    .toArray();
  if (o) out.orphans = { count: o.count, bytes: o.bytes };

  const rows = await db.cols.media
    .aggregate([{ $group: { _id: { kind: '$kind', disk: { $cond: [{ $ifNull: ['$file', false] }, 1, 0] } }, count: { $sum: 1 }, bytes: { $sum: '$size' } } }])
    .toArray();
  for (const r of rows) {
    out.media.count += r.count;
    out.media.bytes += r.bytes;
    const k = r._id.kind || 'diğer';
    out.media.byKind[k] = out.media.byKind[k] || { count: 0, bytes: 0 };
    out.media.byKind[k].count += r.count;
    out.media.byKind[k].bytes += r.bytes;
    if (r._id.disk) {
      out.media.disk.count += r.count;
      out.media.disk.bytes += r.bytes;
    }
  }
  const gridMatchedCount = Math.max(0, out.grid.count - out.orphans.count);
  const gridMatchedBytes = Math.max(0, out.grid.bytes - out.orphans.bytes);
  out.externalCount = Math.max(0, out.media.count - out.media.disk.count - gridMatchedCount);
  out.externalBytes = Math.max(0, out.media.bytes - out.media.disk.bytes - gridMatchedBytes);

  // koleksiyon boyutları (en büyük 8)
  try {
    const names = (await db.state.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    const sizes = await Promise.all(
      names.map((n) =>
        db.state.db
          .command({ collStats: n })
          .then((s) => ({ name: n, count: s.count || 0, bytes: (s.storageSize || 0) + (s.totalIndexSize || 0) }))
          .catch(() => null)
      )
    );
    out.collections = sizes.filter(Boolean).sort((a, b) => b.bytes - a.bytes).slice(0, 8);
  } catch (e) {
    out.collections = [];
  }
  return out;
}

// ------------------------------------------------------------------ iş (kopyala / boşalt / sahipsiz)
const job = { running: false, mode: '', total: 0, done: 0, copied: 0, already: 0, skipped: 0, failed: 0, bytes: 0, freed: 0, current: '', error: '', startedAt: 0, finishedAt: 0, stop: false, log: [] };

function jobStatus() {
  return { ...job, log: job.log.slice(-12) };
}

function note(msg) {
  job.log.push(new Date().toISOString().slice(11, 19) + ' ' + msg);
  if (job.log.length > 60) job.log.shift();
}

// GridFS dosyasını geçici dosyaya indirir; { md5, size }
async function downloadToTemp(id, tmp) {
  const md5 = crypto.createHash('md5');
  let size = 0;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    const src = db.state.bucket.openDownloadStream(id);
    src.on('data', (d) => { md5.update(d); size += d.length; });
    src.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    src.pipe(out);
  });
  return { md5: md5.digest('hex'), size };
}

async function gridMd5(id) {
  const md5 = crypto.createHash('md5');
  await new Promise((resolve, reject) => {
    const src = db.state.bucket.openDownloadStream(id);
    src.on('data', (d) => md5.update(d));
    src.on('error', reject);
    src.on('end', resolve);
  });
  return md5.digest('hex');
}

async function s3Md5(key) {
  const md5 = crypto.createHash('md5');
  const res = await s3.get(key);
  for await (const d of res) md5.update(d);
  return md5.digest('hex');
}

// Dış depodaki nüshanın MongoDB'dekiyle birebir aynı olduğunu doğrular
async function verifyCopy(id, length) {
  const key = s3.keyFor(id);
  const h = await s3.head(key);
  if (!h) return { ok: false, why: 'dış depoda yok' };
  if (h.size !== length) return { ok: false, why: `boyut farklı (${h.size} ≠ ${length})` };
  const want = await gridMd5(id);
  // tek parça yüklemelerde ETag = MD5; değilse dosyayı okuyup karşılaştır
  const got = /^[a-f0-9]{32}$/i.test(h.etag) ? h.etag.toLowerCase() : await s3Md5(key);
  if (got !== want) return { ok: false, why: 'içerik farklı' };
  return { ok: true };
}

async function copyOne(f) {
  const id = f._id;
  const key = s3.keyFor(id);
  const existing = await s3.head(key);
  if (existing && existing.size === f.length) {
    job.already++;
    return;
  }
  const meta = await db.cols.media.findOne({ _id: id }, { projection: { contentType: 1 } });
  const tmp = path.join(os.tmpdir(), 'klipo-mig-' + crypto.randomUUID());
  try {
    const dl = await downloadToTemp(id, tmp);
    if (dl.size !== f.length) throw new Error('indirilen boyut uyuşmuyor');
    const up = await s3.putFile(key, tmp, dl.size, (meta && meta.contentType) || (f.metadata && f.metadata.contentType) || 'application/octet-stream');
    // tek parça yükleme: ETag MD5'tir; farklıysa dosya bozuk gitmiş demektir
    if (/^[a-f0-9]{32}$/i.test(up.etag) && up.etag.toLowerCase() !== dl.md5) throw new Error('yüklenen dosya doğrulanamadı');
    job.copied++;
    job.bytes += dl.size;
  } finally {
    await fsp.unlink(tmp).catch(() => {});
  }
}

async function freeOne(f) {
  const v = await verifyCopy(f._id, f.length);
  if (!v.ok) {
    job.skipped++;
    note(`atlandı ${f._id}: ${v.why}`);
    return;
  }
  await db.state.bucket.delete(f._id); // yalnızca MongoDB nüshası; dış depodaki kopya yerinde
  storage.gridCache.delete(f._id.toString());
  job.freed += f.length;
  job.copied++;
}

async function orphanOne(f) {
  const m = await db.cols.media.findOne({ _id: f._id }, { projection: { _id: 1 } });
  if (m) return; // bu arada sahiplenmiş
  await db.state.bucket.delete(f._id);
  job.freed += f.length;
  job.copied++;
}

function pickQuery(mode) {
  if (mode === 'orphans') return { uploadDate: { $lt: new Date(Date.now() - ORPHAN_MIN_AGE_MS) } };
  return {};
}

async function run(mode) {
  try {
    let list = await files().find(pickQuery(mode), { projection: { length: 1, metadata: 1 } }).sort({ length: -1 }).toArray();
    if (mode === 'orphans') {
      const have = new Set((await db.cols.media.find({ _id: { $in: list.map((x) => x._id) } }, { projection: { _id: 1 } }).toArray()).map((x) => x._id.toString()));
      list = list.filter((x) => !have.has(x._id.toString()));
    }
    job.total = list.length;
    note(`${list.length} dosya işlenecek (${mode})`);
    for (const f of list) {
      if (job.stop) {
        note('Durduruldu.');
        break;
      }
      job.current = String(f._id);
      try {
        if (mode === 'copy') await copyOne(f);
        else if (mode === 'free') await freeOne(f);
        else await orphanOne(f);
      } catch (e) {
        job.failed++;
        note(`hata ${f._id}: ${String(e.message).slice(0, 120)}`);
        // dış depo yapılandırması/yetkisi bozuksa tek tek denemenin anlamı yok
        if (e instanceof s3.S3Error && [401, 403].includes(e.status)) {
          job.error = e.message;
          break;
        }
        if (job.failed >= 10 && job.failed > job.done / 2) {
          job.error = 'Çok fazla hata; iş durduruldu. Ayrıntı için kaydı oku.';
          break;
        }
      }
      job.done++;
    }
  } catch (e) {
    job.error = String(e.message || e).slice(0, 200);
  } finally {
    job.running = false;
    job.current = '';
    job.finishedAt = Date.now();
    try { await storage.dbUsage(true); } catch (e) { /* önemsiz */ }
  }
}

// mode: 'copy' | 'free' | 'orphans'
function start(mode) {
  if (job.running) throw Object.assign(new Error('Başka bir iş sürüyor.'), { status: 409 });
  if (!['copy', 'free', 'orphans'].includes(mode)) throw Object.assign(new Error('Geçersiz işlem.'), { status: 400 });
  if (mode !== 'orphans' && !s3.enabled()) throw Object.assign(new Error('Önce dış depoyu ayarla (S3_* ortam değişkenleri).'), { status: 400 });
  Object.assign(job, { running: true, mode, total: 0, done: 0, copied: 0, already: 0, skipped: 0, failed: 0, bytes: 0, freed: 0, current: '', error: '', startedAt: Date.now(), finishedAt: 0, stop: false, log: [] });
  run(mode);
  return jobStatus();
}

function stop() {
  if (job.running) job.stop = true;
  return jobStatus();
}

// Açılışta çalışan acil taşıma (STORAGE_MIGRATE=copy | copy+free). Panele girilemese bile çalışır.
async function bootMigrate(spec) {
  const steps = String(spec || '').split('+').map((s) => s.trim()).filter((s) => ['copy', 'free', 'orphans'].includes(s));
  for (const m of steps) {
    try {
      start(m);
    } catch (e) {
      console.error('[depolama] acil taşıma başlatılamadı:', e.message);
      return;
    }
    while (job.running) await new Promise((r) => setTimeout(r, 1000));
    console.log(`[depolama] ${m}: ${job.copied} işlendi, ${job.already} zaten vardı, ${job.skipped} atlandı, ${job.failed} hata, ${Math.round(job.freed / 1048576)} MB yer açıldı${job.error ? ' · DURDU: ' + job.error : ''}`);
    if (job.error || job.stop) return;
  }
  console.log('[depolama] acil taşıma bitti. Render > Environment bölümünden STORAGE_MIGRATE değişkenini silebilirsin.');
}

module.exports = { bootMigrate, getStats, start, stop, jobStatus, ORPHAN_MIN_AGE_MS };
