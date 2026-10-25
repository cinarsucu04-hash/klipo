'use strict';
// Metin güvenliği: küfür, tehdit, kişisel bilgi ve bağlantı denetimi.
// Saf (veritabanından bağımsız) kısım `scan`, kayıt/ceza kısmı `enforce`.
const { cols } = require('./db');
const { HttpError } = require('./helpers');

// Türkçe harfleri sadeleştirir (ı korunur: "sıkışık" ile "sikiş" karışmasın), rakamla yazılmış harfleri çevirir
function fold(input) {
  return String(input || '')
    .toLocaleLowerCase('tr-TR')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
}
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };

function tokenize(text) {
  const raw = fold(text)
    .split(/[^a-z0-9@$ı]+/)
    .filter(Boolean)
    .map((t) => (/[a-zı]/.test(t) ? t.replace(/[0-9@$]/g, (c) => LEET[c] || c) : t))
    .map((t) => t.replace(/[^a-zı]/g, ''))
    .filter(Boolean);
  const collapsed = raw.map((t) => t.replace(/(.)\1+/g, '$1'));
  return { raw, collapsed };
}

// Başı sabitlenmiş kelime kalıpları (tekrarlı harfler tek harfe indirilmiş biçimde)
const PROFANITY = new RegExp(
  '^(' +
    [
      'amk\\w*', 'aq', 'amq', 'amina\\w*', 'amcik\\w*', 'amcuk\\w*', 'orospu\\w*', 'orosbu\\w*', 'oruspu\\w*',
      'siktir\\w*', 'sikim\\w*', 'sikis\\w*', 'sikik\\w*', 'sikey\\w*', 'sikerim\\w*', 'sikecem\\w*', 'sikecek\\w*', 'sikti\\w*',
      'yarak\\w*', 'gotu', 'gotun\\w*', 'gotlek\\w*', 'gotveren\\w*', 'gotos\\w*', 'ibne\\w*', 'ibina\\w*',
      'pezevenk\\w*', 'kahpe\\w*', 'kaltak\\w*', 'gavat\\w*', 'serefsiz\\w*', 'pust',
      'fuck\\w*', 'fuk', 'shit', 'bitch\\w*', 'motherfuck\\w*', 'cunt', 'asshole', 'dick',
    ].join('|') +
    ')$'
);
const PROFANITY_RAW = /^nigg(a|er)\w*$/;
// Harfleri boşlukla ayrılmış ("s i k t i r") ya da bitişik yazımlarda aranan uzun kökler
const STEMS = ['siktir', 'orospu', 'pezevenk', 'amcik', 'aminakoy', 'aminakod', 'sikeyim', 'gotveren'];

const THREAT_PATTERNS = [
  /\b(oldurecegim|oldurur(um|cem|ucem)|oldureyim|oldurecem|gebertecegim|gebertirim|gebertecem|gebertirm)\b/,
  /\b(seni|sizi|ailen\w*|anan\w*|baban\w*|kardesin\w*)\b(?:\s+\w+){0,3}\s+(oldur\w*|gebert\w*|bicakla\w*|vuracag\w*|vururum|vurucam|yakacag\w*|yakarim|kesecek\w*|keserim|dogra\w*|ezecek\w*|ezerim|dovecek\w*|doverim|bulacag\w*|bulurum|bulucam|tecavuz\w*)/,
  /\b(bomba|silah|bicak)\w*\s+(koyacag|getirecegim|ile geleceg|cekecegim)\w*/,
  /\b(intihar\s+(et|ed)\w*|kendini\s+(as|oldur)\w*|gebersin\w*|gebermen\w*|olmeni\s+istiyorum|kill\s+yourself|kys)\b/,
];

const PHONE_RE = /(?:\+?\s*90|0)?[\s.\-]*5\d{2}[\s.\-]*\d{3}[\s.\-]*\d{2}[\s.\-]*\d{2}/;
const IBAN_RE = /\btr\s?\d{2}(?:\s?\d{4}){4,6}/i;
const LINK_RE = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]{2,}\.(com|net|org|xyz|ru|top|tk|me|io|co|link|click|site|online)\b/i;

/**
 * Metni denetler. Sorun yoksa null, varsa { kind: 'kufur'|'tehdit'|'bilgi'|'baglanti' } döner.
 * opts.custom: yönetici özel yasaklı kelimeler, opts.contact: telefon/IBAN engelle, opts.links: bağlantı engelle
 */
function scan(text, opts) {
  opts = opts || {};
  const s = String(text || '');
  if (!s.trim()) return null;
  const { raw, collapsed } = tokenize(s);

  const words = collapsed.join(' ');
  for (const re of THREAT_PATTERNS) if (re.test(fold(s).replace(/(.)\1+/g, '$1')) || re.test(words)) return { kind: 'tehdit' };

  const custom = (opts.custom || []).map((w) => fold(w).replace(/[^a-zı]/g, '').replace(/(.)\1+/g, '$1')).filter((w) => w.length >= 3);
  const check = (t) => PROFANITY.test(t) || custom.includes(t);
  if (collapsed.some(check) || raw.some((t) => PROFANITY_RAW.test(t))) return { kind: 'kufur' };
  // iki kelimeye bölünmüş yazım: "sik tir"
  for (let i = 0; i + 1 < collapsed.length; i++) if (check(collapsed[i] + collapsed[i + 1])) return { kind: 'kufur' };
  // "s i k t i r" gibi tek harflerle yazılmış diziler
  let run = '';
  for (const t of collapsed.concat([''])) {
    if (t.length === 1) run += t;
    else {
      if (run.length >= 4) {
        const r = run.replace(/(.)\1+/g, '$1');
        if (check(r) || STEMS.some((k) => r.includes(k))) return { kind: 'kufur' };
      }
      run = '';
    }
  }
  // kelime içinde ayraçla bölünmüş: "s.iktir" (tek kelimeye birleştirilmiş ayraçsız biçim)
  const glued = fold(s).replace(/[^a-z0-9ı]+/g, '').replace(/(.)\1+/g, '$1');
  if (STEMS.some((k) => glued.length < 40 && glued.includes(k))) return { kind: 'kufur' };

  if (opts.contact && (PHONE_RE.test(s) || IBAN_RE.test(s))) return { kind: 'bilgi' };
  if (opts.links && LINK_RE.test(s)) return { kind: 'baglanti' };
  return null;
}

const MESSAGES = {
  kufur: 'Küfür veya hakaret içeren içerik paylaşılamaz. Lütfen ifadeni değiştir.',
  tehdit: 'Tehdit veya zarar vermeye teşvik eden içerik paylaşılamaz.',
  bilgi: 'Telefon numarası veya IBAN gibi kişisel/finansal bilgiler herkese açık yerlerde paylaşılamaz.',
  baglanti: 'Yeni hesaplar yorumlara bağlantı ekleyemez. Hesabın bir günü doldurunca deneyebilirsin.',
};
const AUTO_BAN_STEPS = [3600e3, 24 * 3600e3, 7 * 24 * 3600e3, 30 * 24 * 3600e3];
const STRIKE_LIMIT = 10; // 24 saatte: tehdit = 3 puan, küfür = 1 puan

/**
 * Denetler; ihlalde kaydeder, puan toplar, çok tekrarlarsa hesabı geçici askıya alır ve hata fırlatır.
 * where: 'yorum' | 'açıklama' | 'mesaj' | 'biyografi' ...
 */
async function enforce(req, text, where, opts) {
  opts = opts || {};
  if (!text || !req.user) return;
  if (req.user.role === 'admin') return;
  let custom = [];
  try {
    const { getSettings } = require('./services');
    custom = (await getSettings()).badWords || [];
  } catch (e) { /* özel liste okunamazsa yerleşik liste yeter */ }
  const age = Date.now() - new Date(req.user.createdAt || 0).getTime();
  const r = scan(text, { custom, contact: opts.contact, links: opts.links && age < 24 * 3600e3 });
  if (!r) return;

  const doc = { userId: req.user._id, kind: r.kind, where, snippet: String(text).slice(0, 140), createdAt: new Date() };
  cols.modLog.insertOne(doc).catch(() => {});

  if (r.kind === 'kufur' || r.kind === 'tehdit') {
    try {
      const since = new Date(Date.now() - 24 * 3600e3);
      const rows = await cols.modLog.find({ userId: req.user._id, kind: { $in: ['kufur', 'tehdit'] }, createdAt: { $gte: since } }, { projection: { kind: 1 } }).toArray();
      const points = rows.reduce((n, x) => n + (x.kind === 'tehdit' ? 3 : 1), 0);
      if (points >= STRIKE_LIMIT) {
        const step = Math.min(req.user.autoBanCount || 0, AUTO_BAN_STEPS.length - 1);
        const until = new Date(Date.now() + AUTO_BAN_STEPS[step]);
        await cols.users.updateOne(
          { _id: req.user._id },
          { $set: { banned: true, bannedUntil: until, banReason: 'Otomatik: tekrarlayan küfür veya tehdit', bannedAt: new Date() }, $inc: { autoBanCount: 1 } }
        );
        cols.modLog.deleteMany({ userId: req.user._id, kind: { $in: ['kufur', 'tehdit'] }, createdAt: { $gte: since } }).catch(() => {});
        throw new HttpError(403, 'Tekrarlayan küfür/tehdit nedeniyle hesabın geçici olarak askıya alındı.', 'BANNED');
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
    }
  }
  throw new HttpError(400, MESSAGES[r.kind], 'MODERATION');
}

// Giriş yapmamış kişiler için (kayıt, Google ile hesap açma): yalnızca denetler, hata fırlatır
async function assertClean(text, what) {
  if (!text) return;
  let custom = [];
  try { custom = (await require('./services').getSettings()).badWords || []; } catch (e) { /* yoksay */ }
  const r = scan(text, { custom });
  if (r) throw new HttpError(400, (what ? what + ': ' : '') + MESSAGES[r.kind], 'MODERATION');
}

module.exports = { scan, enforce, assertClean, MESSAGES };
