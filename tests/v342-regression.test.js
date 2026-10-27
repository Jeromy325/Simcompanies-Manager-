// 2.5.342: the game's public constants (/api/v2/constants/core|buildings|resources/, fixture = real 2026-10-23
// responses, trimmed) give exact rates and wages in every economy phase; your listings (/market-orders/) feed the
// undercut alert and the fee fallback. E2E with the real storage export: $3,100.82/h/level (game $3,100.83),
// workers $73.94 + admin $24.66 (game 73.94 + 24.66), note "started in recession".
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const C = require('../tools-core.js');
const N = require('../notify-core.js');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.395');
const fx = JSON.parse(read('tests/fixtures/game-constants-2026-10-23.json'));
const c = { core: fx.core, buildings: fx.buildings, resources: fx.resources };
assert.ok(C.gameConstantsOk(c));
const near = (a, b, t, m) => assert.ok(Math.abs(a - b) <= t, `${m}: ${a} vs ${b}`);
near(C.gameBaseRate(c, 112, 1), 5.58040099212704, 1e-9, 'normal base = encyclopedia producedAnHour');
near(C.gameRatePerLevel(c, 112, 1, { bonusPct: 8 }), 3100.83 / 511.21, 2e-4, 'normal rate = game calculator');
near(C.gameRatePerLevel(c, 112, 0, { bonusPct: 8 }), 26.451568041165427 / 4, 1e-5, 'recession rate = measured batch');
assert.equal(C.gameWagePerLevel(c, '1'), 448.5); assert.equal(C.gameWagePerLevel(c, '1', true), 448.5 * 0.97);
assert.equal(C.phaseFromMeasuredRate(c, 112, 26.451568041165427 / 4, { bonusPct: 8 }).state, 0, 'batch identified as recession');
assert.equal(C.phaseFromMeasuredRate(c, 112, 7.5, { bonusPct: 8 }), null, 'no phase within 2% → unknown');
near(C.listingFeePct(fx.marketOrders), 4, 0.01, 'listing fees = 4%');
// game: workers = 448.5 / 6.0657 = 73.94; admin 33.35% = 24.66
const r2 = v => Math.round(v * 100) / 100, w = r2(448.5 / C.gameRatePerLevel(c, 112, 1, { bonusPct: 8 }));
assert.equal(w, 73.94); assert.equal(r2(w * 0.33352941), 24.66);
// undercut with own listings from /market-orders/ even when the order book page doesn't contain them
const book = [{ price: 600, quality: 2, seller: { id: 1, company: 'X' } }, { price: 640, quality: 2, seller: { id: 2 } }];
const own = fx.marketOrders.filter(o => o.kind === 51);
const u = N.undercut({ rows: book, companyId: 5294950, own, id: 51, names: { 51: 'Car body' }, realm: 1, state: {} });
assert.ok(u.fire.length >= 1 && /Car body Q2/.test(u.fire[0].title), 'undercut fires from own listings');
assert.equal(N.undercut({ rows: book, companyId: 5294950, id: 51, names: {}, realm: 1, state: {} }).fire.length, 0, 'without own listings and none in the book → nothing');
const bg = read('background.js'), dash = read('dashboard.js');
assert.ok(bg.includes("fetch(`https://www.simcompanies.com${p}`,{credentials:'omit'})") && bg.includes("GAME_CONSTANTS_ALARM='scm-game-constants'"));
const nb = bg.slice(bg.indexOf('async function notifyOrderBook'), bg.indexOf('async function notifyOrderBook') + 900);
assert.ok(nb.indexOf('refreshMarketOrders(n)') < nb.indexOf('updateNotifyState('), 'listings fetched before the notify lock');
assert.ok(dash.includes("source:'game-constants'") && dash.includes('C.gameWagePerLevel(ctx.s?.gameConstants,ctx.buildingKind,ctx.robots)'));
console.log('v342-regression ok');
