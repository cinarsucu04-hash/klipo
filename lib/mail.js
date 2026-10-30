'use strict';
// E-posta gönderimi (yalnızca HTTPS API'leri; Render ücretsiz planda SMTP portları kapalıdır).
// Sağlayıcı sırası: Gmail API → Brevo → Resend. Hiçbiri ayarlı değilse ready() false döner.
const cfg = require('./config');

function provider() {
  if (cfg.GMAIL_CLIENT_ID && cfg.GMAIL_CLIENT_SECRET && cfg.GMAIL_REFRESH_TOKEN && cfg.MAIL_FROM) return 'gmail';
  if (cfg.BREVO_API_KEY && cfg.MAIL_FROM) return 'brevo';
  if (cfg.RESEND_API_KEY && cfg.MAIL_FROM) return 'resend';
  return '';
}
const ready = () => !!provider();

const enc = (s) => Buffer.from(s, 'utf8').toString('base64');
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const strip = (s) => String(s).replace(/[\r\n]+/g, ' '); // başlık enjeksiyonunu önler

let gmailToken = { v: '', exp: 0 };
async function gmailAccessToken() {
  if (gmailToken.v && gmailToken.exp > Date.now() + 30000) return gmailToken.v;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.GMAIL_CLIENT_ID,
      client_secret: cfg.GMAIL_CLIENT_SECRET,
      refresh_token: cfg.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(10000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error('Gmail yetkisi alınamadı: ' + (d.error_description || d.error || r.status));
  gmailToken = { v: d.access_token, exp: Date.now() + (Number(d.expires_in) || 3000) * 1000 };
  return gmailToken.v;
}

async function viaGmail({ to, subject, text, html }) {
  const boundary = 'klipo' + Date.now().toString(36);
  const raw = [
    `From: ${strip(cfg.APP_NAME)} <${strip(cfg.MAIL_FROM)}>`,
    `To: ${strip(to)}`,
    `Subject: =?UTF-8?B?${enc(strip(subject))}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    enc(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    enc(html),
    `--${boundary}--`,
  ].join('\r\n');
  const token = await gmailAccessToken();
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: b64url(raw) }),
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error('Gmail gönderimi başarısız: ' + r.status + ' ' + (await r.text()).slice(0, 200));
}

async function viaBrevo({ to, subject, text, html }) {
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': cfg.BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { name: cfg.APP_NAME, email: cfg.MAIL_FROM }, to: [{ email: to }], subject, textContent: text, htmlContent: html }),
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error('Brevo gönderimi başarısız: ' + r.status + ' ' + (await r.text()).slice(0, 200));
}

async function viaResend({ to, subject, text, html }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `${cfg.APP_NAME} <${cfg.MAIL_FROM}>`, to: [to], subject, text, html }),
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error('Resend gönderimi başarısız: ' + r.status + ' ' + (await r.text()).slice(0, 200));
}

async function send(msg) {
  const p = provider();
  if (!p) throw new Error('E-posta sağlayıcısı ayarlı değil');
  if (p === 'gmail') return viaGmail(msg);
  if (p === 'brevo') return viaBrevo(msg);
  return viaResend(msg);
}

// 6 haneli kod e-postası
function codeMail(kind, code) {
  const app = cfg.APP_NAME;
  const what = kind === 'reset' ? 'şifreni sıfırlamak' : 'hesabını doğrulamak';
  const subject = `${app} doğrulama kodun: ${code}`;
  const text = `${app} ile ${what} için kodun: ${code}\n\nKod 10 dakika geçerlidir. Bu işlemi sen başlatmadıysan bu e-postayı yok say; kodu kimseyle paylaşma.`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:14px">
    <h2 style="margin:0 0 8px">${app}</h2>
    <p style="color:#444">${app} ile ${what} için kodun:</p>
    <p style="font-size:34px;letter-spacing:8px;font-weight:700;margin:12px 0">${code}</p>
    <p style="color:#666;font-size:13px">Kod 10 dakika geçerlidir. Bu işlemi sen başlatmadıysan bu e-postayı yok say; kodu kimseyle paylaşma.</p></div>`;
  return { subject, text, html };
}

module.exports = { ready, provider, send, codeMail };
