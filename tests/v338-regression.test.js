// 2.5.338: Profit / h / level after an economy change (R2, 2026-10-23, recession → normal).
// Real data: Bulldozer Q3 batch started 2026-10-23T02:49:05Z in recession at 26.452/h (L4); game calculator in
// normal shows Units an hour 6.07 (8% bonus), Unit worker cost $73.94, profit $3,100.83/h/level. The lot the
// labour came from (427 units) also held bought units (cost.market), which diluted workers/unit to $57.12.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const C = require('../tools-core.js');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.369');
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// --- economy log + phase at a time
let log = C.economyLogAppend([], 0, '2026-10-23T14:24:46.044Z');
log = C.economyLogAppend(log, 0, '2026-10-23T15:00:00Z');
log = C.economyLogAppend(log, 1, '2026-10-23T16:45:00Z');
log = C.economyLogAppend(log, 1, '2026-10-23T16:00:00Z'); // older observation ignored
assert.equal(log.length, 2);
assert.deepEqual(log.map(e => e.s), [0, 1]);
assert.equal(C.economyStateAt(log, '2026-10-23T02:49:05.777233+00:00'), null, 'batch before first observation → unknown (2.5.340)');
assert.deepEqual(C.economyStateAt(log, '2026-10-23T14:50:00Z'), { state: 0, assumed: false });
assert.equal(C.economyStateAt(log, '2026-10-23T16:10:00Z'), null, 'gap between phases → unknown');
assert.deepEqual(C.economyStateAt(log, '2026-10-24T02:49:00Z'), { state: 1, assumed: false });
assert.equal(C.economyName(0), 'recession'); assert.equal(C.economyName(1), 'normal');

// --- produced-share labour from the real mixed lot
const lot = { kind: 112, quality: 3, amount: 427, datetime: '2026-10-23T16:26:14.512723+00:00', cost: { admin: 8355.371674074699, market: 120356.69558118783, material1: 13610.937719953721, material2: 235895.6893349362, material3: 358630.727110427, material4: 0, material5: 0, workers: 24388.729272297536 } };
const ps = C.lotWorkersPerProducedUnit(lot);
near(24388.729272297536 / 427, 57.1165, 0.001, 'old (diluted) value');
near(ps.workersPerUnit, 67.84, 0.01, 'workers per produced unit (game recession calculator: 67.82)');
assert.ok(ps.mixed && Math.round(ps.boughtUnits) === 68);
assert.equal(C.lotWorkersPerProducedUnit({ amount: 10, cost: { workers: 50, admin: 10, material1: 40, market: 0 } }).workersPerUnit, 5, 'pure produced lot unchanged');

// --- projection rate
const measured = 26.451568041165427; // L4, recession batch
const ref = 5.58040099212704 * 4 * 1.08; // normal reference × company modifier
assert.deepEqual(C.projectionRate({ measuredRate: measured, batchPhase: 0, currentPhase: 0, referenceRate: ref }), { rate: measured, source: 'measured', changed: false });
assert.equal(C.projectionRate({ measuredRate: measured, batchPhase: 0, currentPhase: 1, referenceRate: ref }).source, 'reference');
assert.equal(C.projectionRate({ measuredRate: measured, batchPhase: 0, currentPhase: 1, phaseRate: 6.0657 * 4, referenceRate: ref }).source, 'phase-measured');
assert.equal(C.projectionRate({ measuredRate: measured, batchPhase: 0, currentPhase: 2 }).source, 'measured-stale');
assert.equal(C.projectionRate({ measuredRate: measured, batchPhase: null, currentPhase: 1, referenceRate: ref }).changed, false, 'unknown batch phase → no change assumed');

// --- reconcile with the game screen (normal economy, admin 33.35% as the game shows)
const inputs = [{ qtyPerUnit: 4, unitPrice: 9.54 }, { qtyPerUnit: 1, unitPrice: 627.39 }, { qtyPerUnit: 2, unitPrice: 482.32 }];
const wage = ps.workersPerUnit * measured / 4; // $/h/level, phase-independent
near(wage, 448.6, 0.2, 'wage per hour per level (game: 67.82 × 6.613 = 448.5)');
const game = (uph) => { const r2 = v => Math.round(v * 100) / 100; const w = r2(wage / (uph / 4)), a = r2(w * 0.3335); const r = C.buildingProfit({ unitsPerHour: uph, level: 4, salePrice: 2240, inputs, labourPerUnit: w + a, sellMode: 'exchange', exchangeFeePct: 4, contractDiscountPct: 0, adminOverheadPct: 0 }); return { w, a, unit: r.profitPerUnit + r.feePerUnit + r.contractDiscountPerUnit + r.transportPerUnit, uph: r.unitsPerHour }; };
const exact = game(6.0657 * 4); // once a normal batch has been measured
near(exact.w, 73.94, 0.03, 'unit worker cost (game 73.94)');
near(exact.unit * exact.uph / 4, 3100.83, 3, 'profit/h/level with the normal rate (game 3,100.83)');
const est = game(ref); // reference estimate today
near(est.unit * est.uph / 4, 3100.83, 40, 'reference estimate within ~1% of game');
const before = 533.12 * measured / 4; // what 2.5.337 showed
assert.ok(before - 3100.83 > 400, 'old value was >$400/h/level off');

// --- wiring
const bg = read('background.js'), dash = read('dashboard.js');
assert.ok(bg.includes('recordEconomyState(targetRealm,old,data)') && bg.includes('scmEconomyStateLog:${r}'), 'background logs economyState from auth-data');
assert.ok(!/recordEconomyState[^]{0,900}fetch\(/.test(bg.slice(bg.indexOf('function recordEconomyState'), bg.indexOf('function recordEconomyState') + 900)), 'no network work in the log writer');
assert.ok(dash.includes('result.economyStateLog=') && dash.includes('function plannerEconomy(ctx)') && dash.includes('function plannerWage(ctx,lab)'));
assert.ok(dash.includes('const r=C.buildingProfit({...profitArgs,unitsPerHour,labourPerUnit});'), 'profit uses the projected rate (2.5.348: game-calculator rate for abundance resources)');
assert.ok(dash.includes('lotWorkersPerProducedUnit'), 'labour uses produced share');
for (const fn of ['function plannerEconomy(ctx)', 'function plannerWage(ctx,lab)']) assert.ok(!/\son[a-z]+="/i.test(dash.slice(dash.indexOf(fn), dash.indexOf(fn) + 2500)), 'no inline handlers in new code');
assert.ok(!/\son[a-z]+="/i.test(dash.slice(dash.indexOf('const ecoSrc='), dash.indexOf('const ecoSrc=') + 900)), 'no inline handlers in the economy note');
console.log('v338-regression ok');
