// 2.5.341: formulas read from the game's own code (bundle index-*.js / GamePages-*.js, 2026-10-23).
// Admin: effective = base − (base − 1) × COO/100; COO from active executives (COO full, COO apprentice ½ if academy
// ≥ 5, other C-suite ¼; training/settling/strike excluded; times from window.reactjs.props). Real R2 data:
// base 1.6176, COO 46 → 33.35% (game 61.76% −28.41%). Rate: base ÷ (1 − bonus/100) (was × (1 + bonus/100)).
// E2E with the real storage export: card $3,100.64/h/level (game $3,100.83), admin 33.35%.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const C = require('../tools-core.js');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.389');
const now = Date.parse('2026-10-23T18:00:00Z');
const w = (pos, start, skills, train) => ({ skills, currentWorkHistory: { position: pos, start, accelerated: false }, currentTraining: train ? { datetime: train, accelerated: false } : undefined, strikeUntil: null });
const execs = [
  w('1', '2026-10-22T15:49:54Z', { coo: 1, cfo: 2, cmo: 1, cto: 2 }, '2026-10-22T15:50:00Z'),
  w('2', '2026-10-22T15:50:17Z', { coo: 2, cfo: 3, cmo: 2, cto: 1 }, '2026-10-22T15:50:21Z'),
  w('t', '2026-10-09T15:51:13Z', { coo: 11, cfo: 6, cmo: 4, cto: 15 }, '2026-10-22T21:24:15Z'),
  w('m', '2026-10-18T23:06:13Z', { coo: 4, cfo: 3, cmo: 4, cto: 1 }, '2026-10-22T21:24:06Z'),
  w('f', '2026-10-18T23:06:13Z', { coo: 14, cfo: 26, cmo: 14, cto: 10 }),
  w('o', '2026-10-18T09:36:54Z', { coo: 34, cfo: 12, cmo: 14, cto: 10 }),
  w('v', '2026-10-18T09:37:05Z', { coo: 18, cfo: 11, cmo: 4, cto: 11 })
];
const academy = [{ kind: 'y', size: 8, position: '5', busy: null, purchasedRecently: false }];
const base = 1.6176470588235294, cfg = { trainS: 60 * 60 * 27, settleS: 60 * 60 * 3 };
const r = C.effectiveAdminOverhead({ base, executives: execs, buildings: academy, now, ...cfg });
assert.equal(r.coo, 46); assert.equal(r.pct.toFixed(2), '33.35'); assert.equal(r.reductionPct.toFixed(2), '28.41');
assert.equal(C.effectiveAdminOverhead({ base, executives: execs, buildings: academy, now: Date.parse('2026-10-24T00:30:00Z'), ...cfg }).coo, 50, 'training done → CMO/CTO count');
assert.equal(C.effectiveAdminOverhead({ base, executives: execs, buildings: [], now, ...cfg }).coo, 37, 'no academy → apprentice ignored');
assert.equal(C.effectiveAdminOverhead({ base, executives: execs, buildings: academy, now }), null, 'no game config → null (no hardcoded times)');
assert.equal(C.executiveSkill([w('o', '2020-01-01T00:00:00Z', { coo: 100 })], 'coo', { now, ...cfg, academyActive: 0 }), 75, 'diminishing returns >80 and >60');
// rate: game tSe → base ÷ (1 − 8/100); bundled normal 5.5804 → 6.0657 (game 3,100.83 ÷ 511.21)
assert.ok(Math.abs(5.58040099212704 / (1 - 0.08) - 3100.83 / 511.21) < 0.0002);
const dash = read('dashboard.js'), bg = read('background.js'), hook = read('page-hook.js'), content = read('content.js');
assert.ok(dash.includes('return m<100?1/(1-m/100):0;'), 'dashboard speed bonus divides');
assert.ok(bg.includes('companyModifier<100?1/(1-companyModifier/100):0'), 'background speed bonus divides');
assert.ok(hook.includes("emit('GAME_CONFIG', { config })") && content.includes("type: 'GAME_CONFIG', config: d.config") && bg.includes("rawStorageSet({scmGameConfig:"), 'game config wired');
assert.ok(dash.includes('const overhead=setNum(c.adminOverheadPct)?Number(c.adminOverheadPct):(autoAdmin??0);'));
for (const f of [hook, content]) assert.ok(!/\son[a-z]+="/i.test(f.slice(f.indexOf('GAME_CONFIG') - 400, f.indexOf('GAME_CONFIG') + 600)));
console.log('v341-regression ok');
