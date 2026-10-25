'use strict';
const crypto = require('crypto');
const path = require('path');

const env = process.env;

function list(value, fallback) {
  return String(value === undefined ? fallback : value)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

let sessionSecret = env.SESSION_SECRET;
if (!sessionSecret) {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn(
    '[uyarı] SESSION_SECRET tanımlı değil. Rastgele bir anahtar üretildi; sunucu her yeniden başladığında ' +
      'oturumlar geçersiz olur. Render panelinden SESSION_SECRET ekleyin.'
  );
}

module.exports = {
  APP_NAME: env.APP_NAME || 'Klipo',
  PORT: Number(env.PORT) || 3000,
  isProd: env.NODE_ENV === 'production',

  // Veritabanı (şifreyi ASLA koda yazmayın; yalnızca ortam değişkeni)
  MONGO_URL: env.MONGO_URL || '',
  DB_NAME: env.DB_NAME || 'klipo',
  SESSION_SECRET: sessionSecret,

  // Medya depolama: "gridfs" (varsayılan, Render ücretsiz planda kalıcı) veya "disk"
  STORAGE: String(env.STORAGE || 'gridfs').toLowerCase(),
  UPLOAD_DIR: env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'),
  MAX_VIDEO_MB: Number(env.MAX_VIDEO_MB) || 60,
  MAX_IMAGE_MB: Number(env.MAX_IMAGE_MB) || 8,
  MAX_AUDIO_MB: Number(env.MAX_AUDIO_MB) || 8,

  // Yönetici hesapları: bu adlarla kaydolan kişi yönetici olur (virgülle ayrılmış liste)
  ADMIN_USERNAMES: list(env.ADMIN_USERNAMES, 'admin'),

  // Güvenlik
  MAX_ACCOUNTS_PER_IP: Math.max(1, Number(env.MAX_ACCOUNTS_PER_IP) || 3), // aynı ağdan açılabilecek hesap sayısı
  IP_SALT: env.IP_SALT || '', // IP özetleri için tuz (boşsa SESSION_SECRET kullanılır)
  GOOGLE_CLIENT_ID: String(env.GOOGLE_CLIENT_ID || '').trim(), // "Google ile giriş" için (isteğe bağlı)

  // Render'ın verdiği adres (uyku modunu engellemek için kendine ping atar)
  SITE_URL: env.RENDER_EXTERNAL_URL || env.SITE_URL || '',
  KEEP_ALIVE: env.KEEP_ALIVE !== '0',
};
