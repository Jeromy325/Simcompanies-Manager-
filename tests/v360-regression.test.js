// 2.5.360: upgrade payback counts the extra admin overhead and the upgrade time (game code; user-confirmed 2026-10-24:
// R2 total building levels ≈ 106, buildings don't produce while upgrading).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.392');
const C = require('../tools-core.js');
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
// base = 1 + (levels − 1) / 170: the user's captured bases are whole level counts
for (const [base, levels] of [[1.6176, 106], [1.6118, 105]]) near((base - 1) * 170 + 1, levels, 0.01, `base ${base} = ${levels} levels`);
near(C.adminIncreasePerLevel(0), 1 / 170, 1e-15, 'no COO');
near(C.adminIncreasePerLevel(46), (1 / 170) * 0.54, 1e-15, 'COO 46 %');
const r = C.upgradePaybackFull({ cost: 1000, gainPerHour: 60, currentProfitPerHour: 100, upgradeHours: 5, extraAdminPerHour: 10 });
assert.deepEqual(r, { hours: 35, netGainPerHour: 50, lostProfit: 500, upgradeHours: 5 }, '5 h + (1000 + 500) / 50');
assert.equal(C.upgradePaybackFull({ cost: 1000, gainPerHour: 10, extraAdminPerHour: 12 }).reason, 'not-profitable', 'admin eats the gain');
const dash = read('dashboard.js');
assert.ok(/const bd=Number\(gc\.buildings\?\.\[String\(b\.kind\|\|''\)\]\?\.buildDuration\),upHours=bd>0\?lvl\*bd\/3600:0;/.test(dash), 'upgrade time = level × buildDuration');
assert.ok(/C\.upgradePaybackFull\(\{cost,gainPerHour:gain,currentProfitPerHour:gain!=null\?gain\*lvl:0,upgradeHours:upHours,extraAdminPerHour:extraAdmin\}\)/.test(dash), 'full payback used');
console.log('v360 payback admin + upgrade time: ok');
