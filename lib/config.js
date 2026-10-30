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

  // Dış depo (S3 uyumlu: Cloudflare R2, Backblaze B2, Wasabi, MinIO...). Hepsi tanımlıysa yeni yüklemeler MongoDB yerine buraya gider.
  // Mevcut videolar yerinde kalır; istersen yönetim panelinden Depolama > Kopyala ile taşırsın (hiçbir şey otomatik silinmez).
  S3_ENDPOINT: String(env.S3_ENDPOINT || '').trim().replace(/\/+$/, ''), // örn. https://<hesap>.r2.cloudflarestorage.com
  S3_BUCKET: String(env.S3_BUCKET || '').trim(),
  S3_KEY_ID: String(env.S3_KEY_ID || '').trim(),
  S3_SECRET: String(env.S3_SECRET || '').trim(),
  S3_REGION: String(env.S3_REGION || '').trim(), // boşsa uç noktadan çıkarılır; R2 için "auto"

  // Acil taşıma: panele girilemiyorsa (depolama %100 dolu) sunucu açılışta bu adımları çalıştırır.
  // "copy" (yalnızca kopyalar), "copy+free" (kopyalar, doğrular, MongoDB'de yer açar). İş bitince değişkeni sil.
  STORAGE_MIGRATE: String(env.STORAGE_MIGRATE || '').trim().toLowerCase(),

  // MongoDB Atlas ücretsiz (M0) kotası ve yükleme koruması: doluluk bu yüzdeyi geçince yeni yüklemeler durur (okuma/oynatma sürer)
  DB_QUOTA_MB: Number(env.DB_QUOTA_MB) || 512,
  DB_GUARD_PCT: Math.min(99, Math.max(50, Number(env.DB_GUARD_PCT) || 92)),

  // Medya depolama: "gridfs" (MongoDB), "disk" veya "s3" (dış depo). Boşsa: S3 bilgileri tam ise "s3", değilse "gridfs"
  STORAGE: String(env.STORAGE || ((env.S3_ENDPOINT && env.S3_BUCKET && env.S3_KEY_ID && env.S3_SECRET) ? 's3' : 'gridfs')).toLowerCase(),
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

  // E-posta doğrulaması: aşağıdaki sağlayıcılardan biri ayarlıysa kayıtta 6 haneli kod istenir (Render ücretsiz plan SMTP'yi engeller; hepsi HTTPS API'dir)
  MAIL_FROM: String(env.MAIL_FROM || '').trim(), // gönderen adres, örn. klipo.destek@gmail.com
  BREVO_API_KEY: String(env.BREVO_API_KEY || '').trim(),
  RESEND_API_KEY: String(env.RESEND_API_KEY || '').trim(),
  GMAIL_CLIENT_ID: String(env.GMAIL_CLIENT_ID || '').trim(),
  GMAIL_CLIENT_SECRET: String(env.GMAIL_CLIENT_SECRET || '').trim(),
  GMAIL_REFRESH_TOKEN: String(env.GMAIL_REFRESH_TOKEN || '').trim(),
  EMAIL_VERIFY: env.EMAIL_VERIFY !== '0', // '0' yaparsan e-posta doğrulaması kapanır
  ALLOWED_EMAIL_DOMAINS: list(env.ALLOWED_EMAIL_DOMAINS, 'gmail.com,googlemail.com'),

  // Render'ın verdiği adres (uyku modunu engellemek için kendine ping atar)
  SITE_URL: env.RENDER_EXTERNAL_URL || env.SITE_URL || '',
  KEEP_ALIVE: env.KEEP_ALIVE !== '0',
};
