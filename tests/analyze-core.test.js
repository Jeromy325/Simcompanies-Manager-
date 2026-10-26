// 2.5.383 Analyze tab maths (analyze-core.js). Check figures from the spec and the user's real R2 ledger (2026-10-25).
const assert = require('assert'), path = require('path');
const A = require('../analyze-core.js');
const fx = require('./fixtures/r2-accounting-day-walk-2026-10-25.json');
const ep = {}; for (const [k, v] of Object.entries(fx)) ep[k] = { data: v };
const close = (a, b, eps = 0.005, m = '') => assert.ok(Math.abs(a - b) <= eps, `${m} expected ${b} got ${a}`);

// Calculator check figure (Bulldozer Q3): 2260 − (4 × 9.45 + 1 × 655.27 + 2 × 483.75) − 91.06 = 508.36 (±1 cent rounding of the lines).
const c = A.calculatorProfit({ salePrice: 2260, inputs: [{ qty: 4, unitCost: 9.45 }, { qty: 1, unitCost: 655.27 }, { qty: 2, unitCost: 483.75 }], labourPerUnit: 91.06, ratePerLevel: 6.613 });
close(c.profit, 508.36, 0.011, 'profit/unit'); close(c.cost, 1751.64, 0.011, 'cost/unit'); close(c.profitPerHourPerLevel, 3361.76, 0.1, 'profit/h/level');
assert.equal(A.calculatorProfit({ salePrice: 0 }), null, 'no price → no calculator figure');

// Ledger: exchange fills paired with fees-<resource> rows written the same second; contract sales kept apart.
const rows = A.ledgerRows(ep), sales = A.salesFromLedger(rows);
assert.equal(rows.length, 30);
assert.equal(sales.filter(s => s.channel === 'exchange').length, 9);
assert.equal(sales.filter(s => s.channel === 'contract').length, 1);
assert.ok(sales.filter(s => s.channel === 'exchange').every(s => s.fee != null), 'every captured fill has its fee row');
const glass = sales.find(s => s.id === '3101660695');
assert.deepEqual([glass.rid, glass.q, glass.amount, glass.gross, glass.fee], [45, 2, 1088, 14905, 597]);
close(glass.ledgerCost, (14905 - 3009) / 1088, 1e-9, 'game cost at sale');
const ct = sales.find(s => s.channel === 'contract'); assert.equal(ct.buyer, 'Chemi Kitties'); assert.equal(ct.fee, null);

// Fee rate from data (never hardcoded): Σ fees ÷ Σ sales on pairs of $1,000 or more = 2697 / 67394 = 4.00 %.
const fr = A.feeRate(sales); close(fr.rate, 2697 / 67394, 1e-12, 'fee rate'); assert.equal(fr.pairs, 7);
assert.equal((fr.rate * 100).toFixed(2), '4.00');
assert.equal(A.feeRate([]), null);
// A ledger page captured twice (recent + cursor page) is not double counted.
assert.equal(A.ledgerRows({ ...ep, '/api/v2/companies/me/cashflow/3101501167/': ep['/api/v2/companies/me/cashflow/recent/'] }).length, 30);

// Stock formulas: cost ÷ (1 − fee), headroom, lot difference, match by resource id AND quality.
close(A.breakEven(1751.64, 0.04), 1824.63, 0.005, 'break-even at 4%');
close(A.headroom(2260, 1824.625), 0.19264, 1e-4, 'price fall headroom');
const lots = [{ kind: 112, quality: 3, amount: 12, cost: { material1: 453.6, material2: 7863.24, material3: 11610, workers: 819.54, admin: 273.3 }, materials: ['Steel', 'Car body', 'Combustion engine'] },
  { kind: 112, quality: 2, amount: 5, cost: { workers: 5000 } }, { kind: 43, quality: 2, amount: 640, cost: { market: 21120 } }];
const st = A.stock(lots, { priceOf: (id, q) => ({ '112:3': { price: 2260 }, '43:2': { price: 30 } })[`${id}:${q}`] || null, rate: 0.04 });
const bd = st.rows.find(r => r.key === '112:3'); close(bd.unitCost, 1751.64, 1e-9); close(bd.diff, 12 * 2260 - 21019.68, 1e-6, 'lot difference');
const steel = st.rows.find(r => r.key === '43:2'); close(steel.diff, -1920, 1e-9, 'Steel Q2 640 × (30 − 33)'); close(steel.breakEven, 34.375, 1e-9);
assert.equal(st.rows.find(r => r.key === '112:2').value, null, 'Q2 does not borrow the Q3 price');
assert.equal(st.below.length, 1); assert.equal(st.unpriced.length, 1);
assert.equal(A.stock(lots, { minUnits: 10 }).rows.some(r => r.key === '112:2'), false, 'ignore lots under N units');
const sp = A.costSplit(lots, 112, 3); close(sp.labourPerUnit, 91.07, 1e-9); close(sp.inputsPerUnit, 1660.57, 1e-9); assert.deepEqual(sp.inputs.map(x => x.name), ['Steel', 'Car body', 'Combustion engine']);

// Margins: earned = avg sold − cost − avg × fee; gap = calculator − earned = price gap + fee + cost gap.
const ms = [{ channel: 'exchange', rid: 112, q: 3, amount: 38, gross: 38 * 2184, fee: null, ledgerCost: null }];
const [mg] = A.margins(ms, { costOf: () => 1751.64, priceOf: () => ({ price: 2260 }), calcOf: () => ({ ok: true, complete: true, profitPerUnit: 508.36, sourcingCostPerUnit: 1751.64 }), rate: 0.04 });
close(mg.earned, 2184 - 1751.64 - 87.36, 1e-9, 'earned/unit'); close(mg.feePU, 87.36, 1e-9); close(mg.gap, 163.36, 1e-6, 'gap');
close(mg.priceDiff + mg.feePU + mg.costDiff, mg.gap, 1e-9, 'gap explained'); close(mg.pctOfCalc, 345 / 508.36, 1e-6);

// Routes: exchange net = price × (1 − fee); contract = your own paid contracts.
const [rt] = A.routes([{ channel: 'contract', rid: 51, q: 2, amount: 20, gross: 2990, price: 149.5, t: 2 }, { channel: 'exchange', rid: 51, q: 2, amount: 5, gross: 760, t: 1 }], { priceOf: () => ({ price: 151 }), rate: 0.04 });
close(rt.exNet, 144.96, 1e-9); close(rt.contractAvg, 149.5, 1e-9); close(rt.diff, 4.54, 1e-9);

// Company, EVA by week and cash from the real past finances.
const co = A.company(ep); assert.equal(co.value, 25742475); assert.equal(co.weeks.length, 1); assert.equal(co.weeks[0].v, 550433);
assert.equal(co.parts.reduce((a, p) => a + p.value, 0), 25742475, 'asset parts add up to the game total');
const ca = A.cash(ep); assert.equal(ca.value, 3201330); assert.equal(ca.payoutDays, 7);
assert.deepEqual(A.dayStatements(ep, 'income-statement').map(d => -d.data.marketFees), [24780, 87438, 72302, 60371, 107116, 89326, 152214]);

// Cost history (production runs, by id + quality) and coverage.
const now = Date.parse('2026-10-26T00:00:00Z');
const cs = A.costSeries([{ id: 52, q: 2, c: 57.5, t: '2026-10-20T00:00:00Z' }, { id: 52, q: 2, c: 61, t: '2026-10-25T00:00:00Z' }, { id: 52, q: 1, c: 99, t: '2026-10-25T00:00:00Z' }], 52, 2, 7, now);
close(cs.change, 61 / 57.5 - 1, 1e-12); assert.equal(cs.pts.length, 2);
const cov = A.ledgerCoverage(rows, 7, now); assert.ok(cov.coverage > 0 && cov.coverage < 1, 'partial ledger reported as partial');

// Chart in the 2.5.382 Accounting style.
const svg = A.sparkline([[0, 1], [864e5, 2], [2 * 864e5, 3]], { label: 'x' });
assert.match(svg, /viewBox="0 0 160 64" preserveAspectRatio="none"/); assert.match(svg, /class="acct-area"/); assert.match(svg, /class="acct-avg"/); assert.match(svg, /class="acct-trend"/); assert.match(svg, /r="2\.4"/); assert.match(svg, /acct-good/);
assert.match(A.sparkline([[0, 3], [864e5, 2]], { tone: 'up-bad' }), /acct-good/, 'a falling cost reads good');
assert.match(A.sparkline([]), /acct-chart-empty/);
console.log('analyze-core: all assertions passed');
