'use strict';
// Bağımlılık gerektirmeyen statik denetim:
//  1) tüm .js dosyalarının sözdizimi
//  2) sunucu modülleri yüklenir (harici paketler yoksa sahte nesneyle) ve
//     `const { a, b } = require('./yerel')` ifadelerindeki adların gerçekten dışa aktarıldığı doğrulanır
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const root = path.join(__dirname, '..');
let errors = 0;
const fail = (msg) => {
  errors++;
  console.error('✗ ' + msg);
};

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (['node_modules', 'android', '.git', 'uploads'].includes(name)) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(root);
for (const f of files) {
  try {
    new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f });
  } catch (e) {
    fail(`Sözdizimi hatası ${path.relative(root, f)}: ${e.message}`);
  }
}
console.log(`✓ ${files.length} dosyanın sözdizimi denetlendi`);

// ---- harici paketler kurulu değilse sahte nesne
function makeStub() {
  const fn = function () {};
  return new Proxy(fn, {
    get: (t, k) => (k === 'then' || typeof k === 'symbol' ? undefined : makeStub()),
    apply: () => makeStub(),
    construct: () => makeStub(),
  });
}
const origLoad = Module._load;
let stubbed = new Set();
Module._load = function (request, parent, isMain) {
  if (!request.startsWith('.') && !Module.builtinModules.includes(request.replace(/^node:/, ''))) {
    try {
      return origLoad.apply(this, arguments);
    } catch (e) {
      if (e.code === 'MODULE_NOT_FOUND') {
        stubbed.add(request);
        return makeStub();
      }
      throw e;
    }
  }
  return origLoad.apply(this, arguments);
};

const serverFiles = files.filter((f) => !f.includes(path.sep + 'public' + path.sep) && !f.includes(path.sep + 'scripts' + path.sep) && !f.includes(path.sep + 'test' + path.sep) && path.basename(f) !== 'server.js');
const origWarn = console.warn;
console.warn = () => {};
for (const f of serverFiles) {
  try {
    require(f);
  } catch (e) {
    fail(`Yükleme hatası ${path.relative(root, f)}: ${e.message}`);
  }
}
console.warn = origWarn;

const RE = /const\s*\{([^}]+)\}\s*=\s*require\('(\.[^']+)'\)/g;
for (const f of serverFiles.concat(path.join(root, 'server.js'))) {
  const src = fs.readFileSync(f, 'utf8');
  let m;
  while ((m = RE.exec(src))) {
    let target;
    try {
      target = require.resolve(path.resolve(path.dirname(f), m[2]));
    } catch (e) {
      fail(`${path.relative(root, f)}: '${m[2]}' bulunamadı`);
      continue;
    }
    const exp = require(target);
    for (const part of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      const name = part.split(':')[0].trim();
      if (!(name in exp) || exp[name] === undefined) fail(`${path.relative(root, f)}: '${name}' ${m[2]} içinde dışa aktarılmıyor`);
    }
  }
}
if (stubbed.size) console.log(`ℹ kurulu olmayan paketler sahte nesneyle yüklendi: ${[...stubbed].join(', ')}`);
console.log(errors ? `\n${errors} sorun bulundu` : '✓ modül içe/dışa aktarımları tutarlı');
process.exit(errors ? 1 : 0);
