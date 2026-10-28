// 2.5.379: "Product images checked · partial: 31 resource image(s) failed to validate". The bundled manifest guessed
// 31 wrong file names (smartphones.png vs the game's smart-phones.png). The game's own path from the captured market
// ticker ({kind,image}) is now used first, and the 26 names verified in that ticker are corrected in the manifest.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const src = read('background.js');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.396');
function fn(name) {
  const start = src.indexOf(`function ${name}(`); assert.notEqual(start, -1, name);
  let depth = 0, q = null;
  for (let i = src.indexOf('){', start) + 1; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '/' && src[i + 1] === '^') { const e = src.indexOf('/.test', i); if (e > i) { i = e; continue; } }
    if (c === '{') depth++; else if (c === '}' && --depth === 0) return src.slice(start, i + 1);
  }
}
const ctx = { Object, Array, Number, String };
vm.createContext(ctx);
vm.runInContext(fn('capturedResourceImages'), ctx);
const store = { endpointData: {
  '/api/v3/market-ticker/1/': { data: [{ kind: 24, image: 'images/resources/smart-phones.png' }, { kind: 115, image: 'images/resources/cow.png' }, { kind: 'x', image: 'images/resources/a.png' }, { kind: 3, image: 'https://evil/x.png' }] },
  '/api/v3/market/1/24/': { data: [{ kind: 24, image: 'images/resources/wrong.png' }] }
} };
const out = ctx.capturedResourceImages(store);
assert.deepEqual(JSON.parse(JSON.stringify(out)), { 24: 'images/resources/smart-phones.png', 115: 'images/resources/cow.png' }, 'only market-ticker kind/image pairs, only game resource paths');
assert.deepEqual(JSON.parse(JSON.stringify(ctx.capturedResourceImages(null))), {});
assert.match(src, /catalogImage \|\| captured\?\.\[sid\] \|\| previous\.url/, 'game path is tried before the cached URL and the bundled guess');
assert.match(src, /captured:capturedResourceImages\(/, 'batch validation builds the map once');
const m = JSON.parse(read('resource-image-manifest.json')).resources;
for (const [id, f] of Object.entries({ 24: 'smart-phones.png', 50: 'car-interior.png', 63: 'simmi-shoes.png', 107: 'steel-beams.png', 115: 'cow.png', 138: 'gravy-boat.png', 154: 'icecream-apple.png' })) assert.equal(m[id], f, `manifest ${id}`);
assert.equal(Object.keys(m).length, 151, 'no resources added or removed');
console.log('v379-regression: passed');
