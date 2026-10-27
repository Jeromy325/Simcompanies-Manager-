// 2.5.395 Transport: a contract uses the same Transport units as an exchange sale (the game page: Bulldozer 5 for
// either; no contract discount), paid from the seller's own Transport, valued at the seller's Transport lot cost only.
const assert = require('assert'), fs = require('fs'), path = require('path');
const A = require('../analyze-core.js'), T = require('../tools-core.js');
assert.equal(require('../manifest.json').version, '2.5.395');
const close = (a, b, e = 1e-9, m = '') => assert.ok(Math.abs(a - b) <= e, `${m} expected ${b} got ${a}`);
const gc = require('./fixtures/game-constants-full-2026-10-24.json');
assert.equal(Number(gc.resources['112'].transportation), 5, 'Bulldozer: 5 transport units (game constants)');
const transportOf = rid => Number(gc.resources[String(rid)].transportation);
close(A.saleTransport('contract', 112, transportOf, 0.3), 1.5); close(A.saleTransport('exchange', 112, transportOf, 0.3), 1.5);
// Bulldozer Q3 contract: 20 × $2,150, game cost at sale $1,790, Transport lot $0.30 → earned 2150 − 1790 − 5 × 0.30.
const [r] = A.margins([{ channel: 'contract', rid: 112, q: 3, amount: 20, gross: 43000, fee: null, ledgerCost: 1790 }], { transportOf, transportCost: 0.3 });
close(r.earned, 2150 - 1790 - 1.5);
// No Transport lot → transport unknown, never a market price.
const [n] = A.margins([{ channel: 'contract', rid: 112, q: 3, amount: 20, gross: 43000, fee: null, ledgerCost: 1790 }], { transportOf, transportCost: null });
assert.equal(n.transportPU, null);
const ui = fs.readFileSync(path.join(__dirname, '..', 'analyze-ui.js'), 'utf8');
assert.ok(ui.includes("const transportCost = costOf(13, 0), transportSrc = transportCost != null ? 'your lot' : null"), 'lot cost only');
assert.ok(!/priceOf\(13, 0\)/.test(ui), 'no market fallback for Transport');
// Production planner: contracts use the full transport units too.
close(T.profitPerHour({ baseRatePerLevel: 10, salePrice: 10, sellMode: 'contract', transportUnits: 5, transportUnitCost: 0.3, inputs: [] }).transportPerUnit, 1.5);
assert.ok(!fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8').includes('50% paid by buyer'));
console.log('v395-regression: all assertions passed');
