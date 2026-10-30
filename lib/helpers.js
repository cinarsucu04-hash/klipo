'use strict';
const crypto = require('crypto');
const { ObjectId } = require('mongodb');

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// async route'larda hataları error middleware'e iletir
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const OID_RE = /^[a-f0-9]{24}$/i;

function oid(v, message = 'Geçersiz kimlik') {
  if (v instanceof ObjectId) return v;
  if (typeof v === 'string' && OID_RE.test(v)) return new ObjectId(v);
  throw new HttpError(400, message);
}

function tryOid(v) {
  try {
    return oid(v);
  } catch (e) {
    return null;
  }
}

// Kontrol karakterlerini temizler, kırpar ve uzunluğu sınırlar
function clean(v, max) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, max);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function pageParams(req, size = 20, maxSize = 50) {
  const page = Math.min(200, Math.max(0, parseInt(req.query.page, 10) || 0));
  const limit = Math.min(maxSize, Math.max(1, parseInt(req.query.limit, 10) || size));
  return { page, limit, skip: page * limit };
}

function bool(v, fallback = false) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  return ['1', 'true', 'yes', 'on', 'evet'].includes(String(v).toLowerCase());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// MongoDB Atlas ücretsiz küme dolduğunda yazma işlemleri 8000 koduyla "over your space quota" hatası verir
function isQuotaError(e) {
  if (!e) return false;
  const code = e.code || (e.errorResponse && e.errorResponse.code) || (e.writeErrors && e.writeErrors[0] && e.writeErrors[0].code);
  return code === 8000 || /over your space quota|no space left|exceeded.*quota/i.test(String(e.message || ''));
}
// Depolama dolu hatası dışındaki hataları olduğu gibi yükseltir; dolu ise sessizce null döner (en iyi çaba yazmaları için)
async function tolerateFull(promise) {
  try {
    return await promise;
  } catch (e) {
    if (isQuotaError(e)) return null;
    throw e;
  }
}
const FULL_MESSAGE = 'Sunucunun depolaması dolu; yönetici yer açana kadar yeni içerik eklenemiyor. Mevcut videolar ve hesaplar güvende.';

module.exports = { tolerateFull, isQuotaError, FULL_MESSAGE, HttpError, wrap, oid, tryOid, clean, escapeRegex, safeEqual, pageParams, bool, sleep, OID_RE };
