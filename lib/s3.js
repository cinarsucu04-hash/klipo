'use strict';
// Küçük S3 uyumlu istemci (Cloudflare R2, Backblaze B2, Wasabi, MinIO...). Ek bağımlılık yok: AWS Signature V4 elle imzalanır.
// Yol tipi adresleme kullanır: https://uc-nokta/kova/anahtar
const https = require('https');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const cfg = require('./config');

class S3Error extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const sha256hex = (d) => crypto.createHash('sha256').update(d).digest('hex');
// RFC 3986 kodlaması (S3 için)
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encPath = (p) => p.split('/').map(enc).join('/');
const stamp = (d) => d.toISOString().replace(/[:-]|\.\d{3}/g, '');

// İmzalı başlıkları üretir (test edilebilsin diye saf fonksiyon)
function signHeaders({ method, host, path, query, headers, payloadHash, region, keyId, secret, now }) {
  const t = stamp(now || new Date());
  const day = t.slice(0, 8);
  const h = {};
  for (const [k, v] of Object.entries(headers || {})) h[k.toLowerCase()] = String(v);
  h.host = host;
  h['x-amz-date'] = t;
  h['x-amz-content-sha256'] = payloadHash;
  const names = Object.keys(h).sort();
  const canonHeaders = names.map((n) => `${n}:${h[n].trim().replace(/\s+/g, ' ')}\n`).join('');
  const signed = names.join(';');
  const q = query || {};
  const canonQuery = Object.keys(q)
    .sort()
    .map((k) => `${enc(k)}=${enc(String(q[k]))}`)
    .join('&');
  const canonical = [method, path, canonQuery, canonHeaders, signed, payloadHash].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', t, scope, sha256hex(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secret, day), region), 's3'), 'aws4_request');
  const signature = hmac(kSigning, toSign).toString('hex');
  h.authorization = `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
  return h;
}

// Sorgu dizgesiyle imzalı (presigned) GET adresi için imzalı sorguyu üretir (test edilebilsin diye saf fonksiyon)
function signQuery({ method, host, path, query, region, keyId, secret, now, expires }) {
  const t = stamp(now || new Date());
  const day = t.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const params = {
    ...(query || {}),
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${keyId}/${scope}`,
    'X-Amz-Date': t,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonQuery = Object.keys(params)
    .sort()
    .map((k) => `${enc(k)}=${enc(String(params[k]))}`)
    .join('&');
  const canonical = [method, path, canonQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', t, scope, sha256hex(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secret, day), region), 's3'), 'aws4_request');
  return canonQuery + '&X-Amz-Signature=' + hmac(kSigning, toSign).toString('hex');
}

function conf() {
  if (!(cfg.S3_ENDPOINT && cfg.S3_BUCKET && cfg.S3_KEY_ID && cfg.S3_SECRET)) return null;
  let u;
  try {
    u = new URL(cfg.S3_ENDPOINT);
  } catch (e) {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  let region = cfg.S3_REGION;
  if (!region) {
    const m = /s3[.-]([a-z0-9-]+)\.(?:backblazeb2|amazonaws|wasabisys)\.com$/i.exec(u.hostname);
    region = m ? m[1] : 'auto';
  }
  return { url: u, bucket: cfg.S3_BUCKET, keyId: cfg.S3_KEY_ID, secret: cfg.S3_SECRET, region };
}

const enabled = () => !!conf();
const keyFor = (id) => 'm/' + String(id);

function info() {
  const c = conf();
  return c ? { host: c.url.host, bucket: c.bucket, region: c.region } : null;
}

async function readBody(res, max = 4096) {
  const chunks = [];
  let n = 0;
  for await (const c of res) {
    if (n < max) chunks.push(c);
    n += c.length;
  }
  return Buffer.concat(chunks).toString('utf8').slice(0, max);
}

function explain(status, body) {
  const code = (/<Code>([^<]+)<\/Code>/.exec(body) || [])[1] || '';
  const msg = (/<Message>([^<]+)<\/Message>/.exec(body) || [])[1] || '';
  return new S3Error(status, `Dış depo hatası (${status}${code ? ' ' + code : ''})${msg ? ': ' + msg : ''}`, code);
}

// Düşük seviye istek. body: null | Buffer | { file, size }
function request(method, key, { headers = {}, query, payloadHash, body, timeout = 30000 } = {}) {
  const c = conf();
  if (!c) return Promise.reject(new S3Error(503, 'Dış depo ayarlanmamış.', 'NOT_CONFIGURED'));
  const basePath = (c.url.pathname.replace(/\/+$/, '') || '') + '/' + enc(c.bucket) + '/' + encPath(key);
  const hash = payloadHash || sha256hex('');
  const h = signHeaders({ method, host: c.url.host, path: basePath, query, headers, payloadHash: hash, region: c.region, keyId: c.keyId, secret: c.secret });
  const lib = c.url.protocol === 'https:' ? https : http;
  const qs = query && Object.keys(query).length ? '?' + Object.keys(query).sort().map((k) => `${enc(k)}=${enc(String(query[k]))}`).join('&') : '';
  return new Promise((resolve, reject) => {
    const req = lib.request(
      { method, hostname: c.url.hostname, port: c.url.port || undefined, path: basePath + qs, headers: h, timeout },
      (res) => resolve(res)
    );
    req.on('timeout', () => req.destroy(new S3Error(504, 'Dış depo zaman aşımı.', 'TIMEOUT')));
    req.on('error', (e) => reject(e instanceof S3Error ? e : new S3Error(502, 'Dış depoya ulaşılamadı: ' + e.message, e.code)));
    if (body && body.file) fs.createReadStream(body.file).on('error', (e) => req.destroy(e)).pipe(req);
    else req.end(body || undefined);
  });
}

// Dosyaya doğrudan erişim için kısa ömürsüz değil, saat başına sabitlenen imzalı adres üretir.
// İmza saati yuvarlandığı için aynı dosya saat içinde hep aynı adresi alır (tarayıcı önbelleği işe yarar); en az 5 saat geçerlidir.
function presign(key, { expires = 6 * 3600, now } = {}) {
  const c = conf();
  if (!c) throw new S3Error(503, 'Dış depo ayarlanmamış.', 'NOT_CONFIGURED');
  const path = (c.url.pathname.replace(/\/+$/, '') || '') + '/' + enc(c.bucket) + '/' + encPath(key);
  const at = now || new Date(Math.floor(Date.now() / 3600000) * 3600000);
  const q = signQuery({ method: 'GET', host: c.url.host, path, region: c.region, keyId: c.keyId, secret: c.secret, now: at, expires });
  return `${c.url.protocol}//${c.url.host}${path}?${q}`;
}

// Dosyayı yükler. Dönüş: { etag, md5, size }
async function putFile(key, filePath, size, contentType) {
  // Önce SHA-256 (imza için) ve MD5 (doğrulama için) hesapla
  const sha = crypto.createHash('sha256');
  const md5 = crypto.createHash('md5');
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath).on('data', (d) => { sha.update(d); md5.update(d); }).on('end', resolve).on('error', reject);
  });
  const payloadHash = sha.digest('hex');
  const md5hex = md5.digest('hex');
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await request('PUT', key, {
        headers: { 'content-type': contentType || 'application/octet-stream', 'content-length': size },
        payloadHash,
        body: { file: filePath },
        timeout: 120000,
      });
      if (res.statusCode >= 200 && res.statusCode < 300) {
        res.resume();
        const etag = String(res.headers.etag || '').replace(/"/g, '');
        return { etag, md5: md5hex, size };
      }
      const err = explain(res.statusCode, await readBody(res));
      if (res.statusCode < 500) throw err;
      last = err;
    } catch (e) {
      if (e instanceof S3Error && e.status < 500 && e.status !== 0) throw e;
      last = e;
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  throw last;
}

// Var mı? { size, etag, contentType } ya da null
async function head(key) {
  const res = await request('HEAD', key);
  res.resume();
  if (res.statusCode === 404) return null;
  if (res.statusCode >= 300) throw explain(res.statusCode, '');
  return {
    size: Number(res.headers['content-length'] || 0),
    etag: String(res.headers.etag || '').replace(/"/g, ''),
    contentType: String(res.headers['content-type'] || ''),
  };
}

// Aralık destekli okuma; akış (IncomingMessage) döndürür. range: { start, end } (end dahil)
async function get(key, range) {
  const headers = range ? { range: `bytes=${range.start}-${range.end}` } : {};
  const res = await request('GET', key, { headers });
  if (res.statusCode === 404) {
    res.resume();
    throw new S3Error(404, 'Dosya dış depoda bulunamadı.', 'NoSuchKey');
  }
  if (res.statusCode >= 300) throw explain(res.statusCode, await readBody(res));
  return res;
}

async function del(key) {
  const res = await request('DELETE', key);
  res.resume();
  if (res.statusCode >= 300 && res.statusCode !== 404) throw explain(res.statusCode, '');
}

// Bağlantı + yetki denemesi: küçük bir dosya yaz, oku, doğrula, sil
async function selfTest() {
  const c = conf();
  if (!c) throw new S3Error(503, 'Dış depo ayarlı değil (S3_ENDPOINT, S3_BUCKET, S3_KEY_ID, S3_SECRET).', 'NOT_CONFIGURED');
  const key = 't/test-' + crypto.randomBytes(6).toString('hex');
  const payload = Buffer.from('klipo-test-' + Date.now());
  const t0 = Date.now();
  const res = await request('PUT', key, {
    headers: { 'content-type': 'text/plain', 'content-length': payload.length },
    payloadHash: sha256hex(payload),
    body: payload,
  });
  if (res.statusCode >= 300) throw explain(res.statusCode, await readBody(res));
  res.resume();
  const h = await head(key);
  if (!h || h.size !== payload.length) throw new S3Error(502, 'Yazılan dosya doğrulanamadı.', 'VERIFY');
  const g = await get(key, { start: 0, end: payload.length - 1 });
  const back = Buffer.concat(await (async () => { const a = []; for await (const d of g) a.push(d); return a; })());
  if (!back.equals(payload)) throw new S3Error(502, 'Okunan içerik yazılanla aynı değil.', 'VERIFY');
  await del(key);
  return { ms: Date.now() - t0, host: c.url.host, bucket: c.bucket, region: c.region };
}

module.exports = { S3Error, enabled, info, keyFor, presign, signQuery, putFile, head, get, del, selfTest, signHeaders };
