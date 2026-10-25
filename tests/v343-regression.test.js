// 2.5.343: abundance, research and government orders from the user's real network capture (2026-10-23 19:13Z).
// Mine #1 (L9, Minerals, abundance 99.57%): game formula 129.0446/h/level = measured 129.045. Government order
// amounts = ceil(amountBase × tier.resourceMultiplicator) as the game. Sync fetches research, orders, tier and abundance.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const C = require('../tools-core.js');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.368');
const fx = JSON.parse(read('tests/fixtures/game-constants-2026-10-23.json'));
const c = { core: fx.core, buildings: fx.buildings, resources: fx.resources };
const ab = fx.abundance.abundance['14'];
assert.ok(Math.abs(ab - 99.57069211725734) < 1e-9);
const rate = C.gameRatePerLevel(c, 14, 1, { bonusPct: 8, abundancePct: ab });
assert.ok(Math.abs(rate - 129.045) < 0.001, `mine rate ${rate}`);
assert.equal(C.phaseFromMeasuredRate(c, 14, 129.045, { bonusPct: 8, abundancePct: ab }).state, 1);
assert.ok(C.gameRatePerLevel(c, 14, 1, { bonusPct: 8 }) > rate, 'abundance lowers the rate');
const m = fx.govTier.tier.resourceMultiplicator, o = fx.govOrders.governmentOrders[0];
assert.equal(Math.max(1, Math.ceil(o.governmentorderrequiredresourceSet[0].amountBase * m)), 468733, 'Flour Q3 at tier ×3.484');
const bg = read('background.js'), dash = read('dashboard.js');
assert.ok(bg.includes("'/api/v3/players/research/',`/api/v3/government-orders/${r}/`,'/api/v3/government-orders/tier/'") && bg.includes('refreshExtraGameData(selected)'));
const fn = bg.slice(bg.indexOf('async function refreshExtraGameData'), bg.indexOf('async function refreshExtraGameData') + 1500);
assert.ok(!/withRealmWriteLock|updateNotifyState/.test(fn), 'no lock held around pageGet');
assert.ok(dash.includes('function plannerAbundancePct(') && dash.includes('abundancePct:plannerAbundancePct(s,'));
assert.ok(dash.includes('function renderGovernmentOrders(s)') && dash.includes('Research level Q'));
assert.ok(!/\son[a-z]+="/i.test(dash.slice(dash.indexOf('function renderGovernmentOrders'), dash.indexOf('function renderGovernmentOrders') + 2500)), 'no inline handlers');
console.log('v343-regression ok');
