'use strict';

// Saf (bağımlılıksız) metin yardımcıları

const HASHTAG_RE = /#([\p{L}\p{N}_]{1,40})/gu;
const MENTION_RE = /(?:^|[^\w@])@([a-z0-9_.]{3,24})/gi;
const USERNAME_RE = /^(?![._])(?!.*[._]{2})[a-z0-9._]{3,24}(?<![._])$/;

const RESERVED_USERNAMES = new Set([
  'klipo', 'support', 'help', 'official', 'moderator', 'mod', 'root', 'system', 'api', 'null',
  'undefined', 'tiktok', 'staff', 'team', 'security', 'info', 'contact', 'destek', 'yonetici',
  'admin', 'administrator',
]);

const REPORT_REASONS = [
  'Spam veya aldatıcı içerik',
  'Taciz veya zorbalık',
  'Şiddet veya tehlikeli içerik',
  'Müstehcen içerik',
  'Nefret söylemi',
  'Sahte hesap / kimliğe bürünme',
  'Telif hakkı ihlali',
  'Diğer',
];

function extractHashtags(text) {
  const set = new Set();
  for (const m of String(text || '').matchAll(HASHTAG_RE)) set.add(m[1].toLowerCase());
  return [...set].slice(0, 15);
}

function extractMentions(text) {
  const set = new Set();
  for (const m of String(text || '').matchAll(MENTION_RE)) set.add(m[1].toLowerCase());
  return [...set].slice(0, 10);
}

function isValidUsername(u) {
  return USERNAME_RE.test(u);
}

function isHttpUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'http:' || x.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

module.exports = { extractHashtags, extractMentions, isValidUsername, isHttpUrl, RESERVED_USERNAMES, REPORT_REASONS };
