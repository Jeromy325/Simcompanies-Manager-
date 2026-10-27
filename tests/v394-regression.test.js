// 2.5.394 Analyze Known gaps fixes. (1) Cost per unit = the game's cost at the time of each sale (sale money − the
// ledger row's profit); today's lot cost only when a row has none. (2) The seller pays transport in Transport units: an
// exchange sale the product's units, a contract half as many (Sim Companies FAQ; Times #76); checked against the day's
// Freight Out, cost against COGS.
// (3) Known gaps dots show the real state; "Cost split over time" is info (grey), not a warning.
const assert = require('assert'), fs = require('fs'), path = require('path');
const A = require('../analyze-core.js');
assert.ok(require('../manifest.json').version >= '2.5.394');
const close = (a, b, e = 1e-9, m = '') => assert.ok(Math.abs(a - b) <= e, `${m} expected ${b} got ${a}`);

// Real R2 contract row (2026-10-25): Electronic components Q2, 551 × $52.87, money 29,132, profit 5,481.
const fx = require('./fixtures/r2-accounting-day-walk-2026-10-25.json');
const sales = A.salesFromLedger(A.ledgerRows(fx, null));
const ec = sales.find(s => s.channel === 'contract' && s.rid === 21);
close(ec.ledgerCost, (29132 - 5481) / 551, 1e-9, 'game cost at sale from the row');
const transportOf = rid => ({ 21: 1, 45: 1, 112: 5 })[rid] ?? null, transportCost = 0.3;
assert.equal(A.CONTRACT_TRANSPORT_SHARE, 0.5);
close(A.contractTransport(21, transportOf, transportCost), 0.15, 1e-12, 'half of 1 unit × $0.30');
assert.equal(A.contractTransport(21, transportOf, null), null, 'no Transport price → unknown');
assert.equal(A.contractTransport(999, transportOf, 0.3), null, 'no transport units → unknown');

// Exchange: the seller uses the full transport units; contract half; retail none (Sim Companies FAQ).
assert.deepEqual(A.TRANSPORT_SHARE, { exchange: 1, contract: 0.5, retail: 0 });
close(A.saleTransport('exchange', 21, transportOf, transportCost), 0.3); assert.equal(A.saleTransport('retail', 21, transportOf, transportCost), 0);
// (1) Ledger cost first, lot cost a check only; a sale without profit uses the lot (mixed).
const rows = A.margins([
  { channel: 'contract', rid: 21, q: 2, amount: 551, gross: 29132, fee: null, ledgerCost: ec.ledgerCost },
  { channel: 'exchange', rid: 45, q: 2, amount: 100, gross: 1400, fee: 56, ledgerCost: 11 },
  { channel: 'exchange', rid: 45, q: 2, amount: 100, gross: 1400, fee: 56, ledgerCost: null },
  { channel: 'exchange', rid: 46, q: 0, amount: 10, gross: 100, fee: 4, ledgerCost: null }
], { costOf: (rid) => ({ 21: 40, 45: 13 })[rid] ?? null, rate: 0.04, transportOf, transportCost });
const c = rows.find(r => r.rid === 21), g = rows.find(r => r.rid === 45), w = rows.find(r => r.rid === 46);
assert.equal(c.costSource, 'ledger'); close(c.cost, ec.ledgerCost); assert.equal(c.lotCost, 40, 'lot cost kept as the check');
close(c.transportPU, 0.15); close(c.earned, 29132 / 551 - ec.ledgerCost - 0.15, 1e-9, 'contract earned less transport');
assert.equal(g.costSource, 'mixed'); close(g.cost, (11 * 100 + 13 * 100) / 200, 1e-9, 'per-sale: ledger where present, lot where missing');
close(g.transportPU, 0.3, 1e-12, 'exchange: full units'); close(g.earned, 14 - 12 - 14 * 0.04 - 0.3);
assert.equal(w.costSource, null, 'no ledger cost and no lot → no cost'); assert.equal(w.earned, null);

// Routes: contract net = average paid − your half of the transport.
const rt = A.routes([{ channel: 'contract', rid: 21, q: 2, amount: 551, gross: 29132, t: 1 }], { priceOf: () => ({ price: 55 }), rate: 0.04, transportOf, transportCost });
close(rt[0].contractNet, 29132 / 551 - 0.15); close(rt[0].exNet, 55 * 0.96 - 0.3); close(rt[0].diff, 29132 / 551 - 0.15 - (55 * 0.96 - 0.3));

// (2) Statement check: modelled transport (exchange + contract) vs Freight Out, game cost × units vs COGS, per finished day in the ledger.
const T0 = Date.parse('2026-10-24T01:20:00Z'), T1 = T0 + A.DAY;
const day = { t: T1, data: { dateFrom: new Date(T0).toISOString(), date: new Date(T1).toISOString(), freightOut: -112.65, cogs: -(23651 + 1100) } };
const inDay = [{ ...ec, t: T0 + 3600e3 }, { channel: 'exchange', rid: 45, q: 2, amount: 100, gross: 1400, ledgerCost: 11, t: T0 + 7200e3 }, { ...ec, t: T1 + 10 }];
const ck = A.statementCheck(inDay, [day], { transportOf, transportCost, since: T0 });
assert.equal(ck.days, 1); close(ck.freight.model, 551 * 0.15 + 100 * 0.3, 1e-9, 'only sales inside the day'); close(ck.freight.game, 112.65);
close(ck.cogs.model, 23651 + 1100, 1e-6); assert.ok(Math.abs(ck.freight.diffPct) < 1e-9 && Math.abs(ck.cogs.diffPct) < 1e-6);
assert.equal(A.statementCheck(inDay, [day], { transportOf, transportCost, since: T0 + 1 }), null, 'day not fully inside the ledger → no check');
// CSV-imported day (no dateFrom): the previous day's close starts it.
const csv = [{ t: T0, data: { date: new Date(T0).toISOString(), freightOut: 0, cogs: 0 } }, { t: T1, data: { date: new Date(T1).toISOString(), freightOut: -112.65, cogs: 0 } }];
close(A.statementCheck(inDay, csv, { transportOf, transportCost, since: T0 - A.DAY }).freight.model, 551 * 0.15 + 100 * 0.3);

// (3) UI wiring.
const ui = fs.readFileSync(path.join(__dirname, '..', 'analyze-ui.js'), 'utf8');
assert.ok(!ui.includes("not the cost when each unit was made"), 'old cost caveat gone');
assert.ok(!ui.includes("Transport and any contract fee are not confirmed"), 'old contract caveat gone');
assert.ok(ui.includes("an-dot an-dot-${st}") && ui.includes("Nothing to do.', 'info']"), 'dots show state; cost split is info');
assert.ok(!/<span class="an-warn">(not included|to verify)<\/span>/.test(ui), 'no "not included / to verify" transport rows');
assert.ok(fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8').includes('.an-dot-info{'));
assert.ok(fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8').includes('transportOf:id=>{const gv=s?.gameConstants?.resources?.[String(id)]?.transportation'));
console.log('v394-regression: all assertions passed');
