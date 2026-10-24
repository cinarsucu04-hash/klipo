'use strict';
// Hazır (telifsiz, uygulama içinde üretilmiş) sesler ve video yazı/ses alanlarının doğrulanması
const { cols } = require('./db');
const { HttpError, clean, tryOid, bool } = require('./helpers');

const BUILTIN = [
  { id: 'b-neon', name: 'Neon Gece', url: '/sounds/neon-gece.mp3', duration: 24 },
  { id: 'b-lofi', name: 'Lo-Fi Kahve', url: '/sounds/lofi-kahve.mp3', duration: 24 },
  { id: 'b-dans', name: 'Hızlı Akış', url: '/sounds/hizli-akis.mp3', duration: 23 },
  { id: 'b-trap', name: 'Trap Gölge', url: '/sounds/trap-golge.mp3', duration: 19 },
  { id: 'b-nese', name: 'Gülümse', url: '/sounds/gulumse.mp3', duration: 22 },
].map((s) => ({ ...s, builtin: true, uses: 0, user: null }));

const SIZES = ['sm', 'md', 'lg'];
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d);

// İstemciden gelen yazı katmanlarını temizler (en fazla 8 adet)
function parseOverlays(raw) {
  if (!raw) return [];
  let arr;
  try {
    arr = typeof raw === 'string' ? (raw.length > 6000 ? null : JSON.parse(raw)) : raw;
  } catch (e) {
    arr = null;
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const o of arr.slice(0, 8)) {
    if (!o || typeof o !== 'object') continue;
    const t = clean(o.t, 60);
    if (!t) continue;
    out.push({
      t,
      x: clamp(num(o.x, 0.5), 0.05, 0.95),
      y: clamp(num(o.y, 0.5), 0.05, 0.95),
      c: /^#[0-9a-f]{6}$/i.test(String(o.c || '')) ? String(o.c).toLowerCase() : '#ffffff',
      s: SIZES.includes(o.s) ? o.s : 'md',
      bg: bool(o.bg),
    });
  }
  return out;
}

function findBuiltin(id) {
  return BUILTIN.find((s) => s.id === id) || null;
}

// Videoya eklenecek ses bilgisi: { id, name, url, vol, orig }
async function resolveSound(soundId, musicVol, origVol) {
  if (!soundId) return null;
  let src = findBuiltin(String(soundId));
  let doc = null;
  if (!src) {
    const id = tryOid(soundId);
    doc = id ? await cols.sounds.findOne({ _id: id }) : null;
    if (!doc) throw new HttpError(400, 'Seçtiğin ses artık yok. Başka bir ses seç.');
    src = { id: doc._id.toString(), name: doc.name, url: doc.url };
  }
  if (doc) cols.sounds.updateOne({ _id: doc._id }, { $inc: { uses: 1 } }).catch(() => {});
  return {
    id: src.id,
    name: src.name,
    url: src.url,
    vol: clamp(num(musicVol, 0.8), 0, 1),
    orig: clamp(num(origVol, 1), 0, 1),
  };
}

module.exports = { BUILTIN, findBuiltin, parseOverlays, resolveSound };
