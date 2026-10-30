'use strict';
// Dahili görsel captcha: dış servis/anahtar gerektirmez, Android WebView'de de çalışır.
// Kod oturumda yalnızca özet olarak tutulur; resim, harfleri metin değil çarpıtılmış çizgi parçaları olarak içerir
// (SVG kaynağı okunarak çözülemesin diye).
const crypto = require('crypto');
const cfg = require('./config');

const ALPHABET = '2345679ABCDEFGHJKLMNPRSTUVWXYZ';
const GLYPHS = {
  A: '01110,10001,10001,11111,10001,10001,10001', B: '11110,10001,10001,11110,10001,10001,11110',
  C: '01110,10001,10000,10000,10000,10001,01110', D: '11110,10001,10001,10001,10001,10001,11110',
  E: '11111,10000,10000,11110,10000,10000,11111', F: '11111,10000,10000,11110,10000,10000,10000',
  G: '01110,10001,10000,10111,10001,10001,01111', H: '10001,10001,10001,11111,10001,10001,10001',
  J: '00111,00010,00010,00010,00010,10010,01100', K: '10001,10010,10100,11000,10100,10010,10001',
  L: '10000,10000,10000,10000,10000,10000,11111', M: '10001,11011,10101,10101,10001,10001,10001',
  N: '10001,11001,10101,10011,10001,10001,10001', P: '11110,10001,10001,11110,10000,10000,10000',
  R: '11110,10001,10001,11110,10100,10010,10001', S: '01111,10000,10000,01110,00001,00001,11110',
  T: '11111,00100,00100,00100,00100,00100,00100', U: '10001,10001,10001,10001,10001,10001,01110',
  V: '10001,10001,10001,10001,10001,01010,00100', W: '10001,10001,10001,10101,10101,11011,10001',
  X: '10001,10001,01010,00100,01010,10001,10001', Y: '10001,10001,01010,00100,00100,00100,00100',
  Z: '11111,00001,00010,00100,01000,10000,11111', 2: '01110,10001,00001,00010,00100,01000,11111',
  3: '11110,00001,00001,01110,00001,00001,11110', 4: '00010,00110,01010,10010,11111,00010,00010',
  5: '11111,10000,11110,00001,00001,10001,01110', 6: '00110,01000,10000,11110,10001,10001,01110',
  7: '11111,00001,00010,00100,01000,01000,01000', 9: '01110,10001,10001,01111,00001,00010,01100',
};
const COLORS = ['#1f2a44', '#8a1c3a', '#0f6b4f', '#5b2a86', '#a35200', '#0b5d8f'];
const LEN = 5;
const TTL = 5 * 60 * 1000;

const rnd = (a, b) => a + (crypto.randomInt(0, 10000) / 10000) * (b - a);
const pick = (arr) => arr[crypto.randomInt(0, arr.length)];
const f = (n) => n.toFixed(1);
const hash = (code) => crypto.createHmac('sha256', cfg.SESSION_SECRET).update(String(code).toUpperCase()).digest('hex');

function makeCode() {
  let s = '';
  for (let i = 0; i < LEN; i++) s += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  return s;
}

function glyphPath(ch, cell) {
  const rows = GLYPHS[ch].split(',');
  let d = '';
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < 5; x++) {
      if (rows[y][x] !== '1') continue;
      const j = () => rnd(-0.45, 0.45);
      const x0 = x * cell, y0 = y * cell, x1 = x0 + cell + 0.5, y1 = y0 + cell + 0.5;
      d += `M${f(x0 + j())} ${f(y0 + j())}L${f(x1 + j())} ${f(y0 + j())}L${f(x1 + j())} ${f(y1 + j())}L${f(x0 + j())} ${f(y1 + j())}Z`;
    }
  }
  return d;
}

// Yeni kod üretir, oturuma özet olarak yazar, SVG döndürür
function generate(req) {
  const code = makeCode();
  req.session.captcha = { h: hash(code), exp: Date.now() + TTL };

  const W = 190, H = 64;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  svg += `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#eef1f8"/><stop offset="1" stop-color="#f7ecf1"/></linearGradient></defs>`;
  svg += `<rect width="${W}" height="${H}" rx="10" fill="url(#g)"/>`;
  for (let i = 0; i < 40; i++) svg += `<circle cx="${f(rnd(0, W))}" cy="${f(rnd(0, H))}" r="${f(rnd(0.6, 1.8))}" fill="${pick(COLORS)}" opacity="0.35"/>`;
  const cell = 5;
  const gw = 5 * cell;
  const gap = (W - 20 - LEN * gw) / (LEN - 1);
  for (let i = 0; i < LEN; i++) {
    const s = rnd(0.9, 1.15);
    const x = 10 + i * (gw + gap) + rnd(-2, 2);
    const y = 14 + rnd(-3, 4);
    const rot = rnd(-16, 16);
    svg += `<g transform="translate(${f(x)} ${f(y)}) rotate(${f(rot)} ${f(gw / 2)} ${f(17)}) skewX(${f(rnd(-10, 10))}) scale(${f(s)})">`;
    svg += `<path d="${glyphPath(code[i], cell)}" fill="${pick(COLORS)}"/></g>`;
  }
  for (let i = 0; i < 5; i++) {
    const c = `M${f(rnd(0, 20))} ${f(rnd(6, H - 6))}C${f(rnd(40, 80))} ${f(rnd(0, H))} ${f(rnd(100, 140))} ${f(rnd(0, H))} ${f(rnd(170, W))} ${f(rnd(6, H - 6))}`;
    svg += `<path d="${c}" stroke="${pick(COLORS)}" stroke-width="${f(rnd(1.1, 2))}" fill="none" opacity="0.8"/>`;
  }
  return svg + '</svg>';
}

// Cevabı denetler. Her denemede kod silinir (tek kullanımlık); yanlışsa yeni resim istenmeli.
function check(req, answer) {
  const c = req.session && req.session.captcha;
  if (req.session) delete req.session.captcha;
  if (!c || c.exp < Date.now()) return false;
  const a = String(answer || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (a.length !== LEN) return false;
  const x = Buffer.from(hash(a));
  const y = Buffer.from(c.h);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { generate, check, LEN };
