// 2.5.390 Retail sales reach Analyze. 'retail-<resource>' rows (category s) were skipped, so Jack o'lantern and Witch
// costume showed no sales (user's R2 ledger: 67 rows, $127,692 in 7 days). Shape from the user's real ledger + CSV:
// details {building, building_name, price, quality (average, e.g. 0.5856), unit_cogs, remaining}; no resource/amount.
const assert = require('assert'), fs = require('fs'), path = require('path');
const A = require('../analyze-core.js');
assert.equal(require('../manifest.json').version, '2.5.390');
const fx = require('./fixtures/r2-accounting-day-walk-2026-10-25.json'), ep = {};
for (const [k, v] of Object.entries(fx)) ep[k] = { data: v };
const sales = A.salesFromLedger(A.ledgerRows(ep)), retail = sales.filter(s => s.channel === 'retail');
assert.equal(retail.length, 5, '5 Witch costume retail rows in the fixture');
const w = retail.find(s => s.id === '3102074859');
assert.deepEqual([w.rid, w.q, w.amount, w.gross, w.fee], [148, 1, Math.round(2035 / 62.7), 2035, null], 'rid from key, q rounded, amount = money ÷ price');
assert.ok(Math.abs(w.qAvg - 0.5855949895615866) < 1e-12, 'average quality kept');
assert.ok(Math.abs(w.ledgerCost - 34.53757828810021) < 1e-12, 'cost = unit_cogs');
assert.ok(Math.abs(w.ledgerProfit - (2035 - 34.53757828810021 * 32)) < 1e-9);
assert.equal(retail.reduce((a, s) => a + s.gross, 0), 14241, 'all $14,241 of fixture retail counted');
// Exchange and contract figures unchanged; retail never enters margins, fees, fee rate or routes.
assert.equal(sales.filter(s => s.channel === 'exchange').length, 9); assert.equal(sales.filter(s => s.channel === 'contract').length, 1);
assert.equal(A.feeRate(sales).pairs, 7);
assert.ok(!A.margins(sales, {}).some(r => r.rid === 148), 'margins exchange only');
assert.ok(!A.feesSummary(sales, 0.04).products.some(r => r.rid === 148));
assert.ok(!A.routes(sales, {}).some(r => r.rid === 148), 'routes contract vs exchange only');
// A retail row with no price is skipped, and money out is never a sale.
assert.equal(A.salesFromLedger([{ id: 1, datetime: '2026-10-25T00:00:00Z', category: 's', descriptionKey: 'retail-147', money: 100, details: { quality: 0 } }]).length, 0);
assert.equal(A.salesFromLedger([{ id: 2, datetime: '2026-10-25T00:00:00Z', category: 's', descriptionKey: 'retail-147', money: -100, details: { quality: 0, price: 47.7 } }]).length, 0);
// Archive keeps retail rows with the fields Analyze needs; background re-seeds once (V2) to pick them up.
const a = A.archiveMerge(null, '/api/v2/companies/me/cashflow/recent/', fx['/api/v2/companies/me/cashflow/recent/'].data, '2026-10-25T13:10:00Z', Date.parse('2026-10-25T14:00:00Z'));
const ar = a.rows['3102074859']; assert.ok(ar, 'retail row archived');
assert.deepEqual(Object.keys(ar.details).sort(), ['building_name', 'price', 'quality', 'unit_cogs']);
assert.equal(A.salesFromLedger(Object.values(a.rows)).filter(s => s.channel === 'retail').length, 5, 'archived retail rows map the same');
assert.ok(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8').includes("const FLAG='scmLedgerArchiveSeededV2';"));
// UI: retail sale card has no fee row and uses the game cost.
const ui = fs.readFileSync(path.join(__dirname, '..', 'analyze-ui.js'), 'utf8');
assert.ok(/s\.channel === 'retail' \? s\.ledgerCost/.test(ui) && /· retail/.test(ui));
console.log('v390-regression: all assertions passed');
