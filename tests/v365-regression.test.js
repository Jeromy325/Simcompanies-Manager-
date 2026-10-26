// 2.5.365: building types without a game name (research labs etc. from game constants) are left out of the picker.
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const dash = read('dashboard.js');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.392');
global.window = global; require('../tools-core.js'); const C = globalThis.SCM_TOOLS_CORE;
const gc = require('./fixtures/game-constants-full-2026-10-24.json');
const defs = C.buildingsFromGameConstants(JSON.parse(read('buildings.json')), C.recipesFromGameConstants(JSON.parse(read('recipes.json')), gc), gc);
const unnamed = defs.filter(d => !String(d?.name || '').trim()).length;
assert.ok(unnamed > 0, 'fixture reproduces the unnamed kinds seen on the phone');
assert.ok(/kindList=\[\.\.\.definitions\]\.filter\(d=>String\(d\.id\)!==String\(building\.gameKind\)&&String\(d\?\.name\|\|''\)\.trim\(\)&&\(d\.produces\|\|\[\]\)\.length\)/.test(dash), 'picker skips unnamed / non-producing kinds');
console.log('v365-regression: ok');
