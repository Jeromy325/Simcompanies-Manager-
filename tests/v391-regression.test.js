// 2.5.391 Contract and retail sales count in Earned and Margins (each product + channel its own row). User's R2 ledger:
// $11.0M of contract revenue (mostly Bulldozer) and retail sales were outside "Earned from sales".
const assert = require('assert'), fs = require('fs'), path = require('path');
const A = require('../analyze-core.js');
assert.ok(require('../manifest.json').version >= '2.5.391');
const close = (a, b, e = 1e-9, m = '') => assert.ok(Math.abs(a - b) <= e, `${m} expected ${b} got ${a}`);
const sales = [
  { channel: 'exchange', rid: 112, q: 3, amount: 10, gross: 22000, fee: 880, ledgerCost: 1800 },
  { channel: 'contract', rid: 112, q: 3, amount: 20, gross: 43000, fee: null, ledgerCost: 1790 },
  { channel: 'contract', rid: 17, q: 1, amount: 100, gross: 1400, fee: null, ledgerCost: 12.95 },
  { channel: 'retail', rid: 147, q: 0, amount: 50, gross: 2385, fee: null, ledgerCost: 35.75 },
  { channel: 'purchase?', rid: 1, q: 0, amount: 1, gross: 1, fee: null, ledgerCost: 0 }
];
const rows = A.margins(sales, { costOf: (rid, q) => (rid === 112 && q === 3 ? 1834.25 : null), priceOf: () => ({ price: 2260 }), calcOf: () => ({ ok: true, complete: true, profitPerUnit: 500, sourcingCostPerUnit: 1834.25 }), rate: 0.04 });
assert.deepEqual(rows.map(r => r.id), ['112:3|exchange', '112:3|contract', '17:1|contract', '147:0|retail'], 'exchange first, then contract, retail; unknown channel ignored');
const [ex, bc, cc, rt] = rows;
// 2.5.394: the game's cost at the time of sale (ledgerCost) comes first; today's lot cost is only a fallback/check.
close(ex.earned, 2200 - 1800 - 88, 1e-9, 'exchange: game cost at sale'); assert.equal(ex.calc, 500); assert.equal(ex.lotCost, 1834.25);
close(bc.earned, 2150 - 1790, 1e-9, 'contract: avg − game cost at sale, no fee'); assert.equal(bc.feePU, 0); assert.equal(bc.calc, null); assert.equal(bc.gap, null);
close(cc.earned, 14 - 12.95, 1e-9, 'contract: game cost at sale when no lot'); assert.equal(cc.costSource, 'ledger');
close(rt.earned, 47.7 - 35.75, 1e-9, 'retail: avg − game COGS (never the lot)'); assert.equal(rt.costSource, 'ledger');
const by = A.earnedBy(rows);
close(by.exchange, ex.total); close(by.contract, bc.total + cc.total); close(by.retail, rt.total); close(by.total, ex.total + bc.total + cc.total + rt.total);
// Findings: a contract row never yields a calculator-margin finding; a losing contract is a loss finding.
const lossy = A.margins([{ channel: 'contract', rid: 5, q: 0, amount: 10, gross: 50, fee: null, ledgerCost: 9 }], {});
assert.equal(A.findings({ marginRows: lossy })[0].kind, 'loss');
assert.ok(!A.findings({ marginRows: rows }).some(f => f.kind === 'margin' && f.r.channel !== 'exchange'));
// UI wiring.
const ui = fs.readFileSync(path.join(__dirname, '..', 'analyze-ui.js'), 'utf8');
assert.ok(ui.includes('A.earnedBy(margins)'), 'Earned = all channels');
assert.ok(ui.includes("r.channel === 'exchange'), other = m.margins.filter("), 'product page: exchange block + contract/retail lines');
assert.ok(ui.includes('f.paid / m.earnedBy.exchange'), 'fee share against exchange earnings only');
console.log('v391-regression: all assertions passed');
