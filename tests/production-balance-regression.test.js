'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const context = { console, Map, Set, Object, Number, String, Math, Array, JSON };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'planner-core.js'), 'utf8'), context);
const core = context.SCMPlannerCore;
assert.ok(core, 'planner core should expose SCMPlannerCore');

// Production rates must come from the exact live cycle, not a nearest older
// history row. The current-cycle rate already contains the game's modifiers.
const liveBuilding = { id: 123, size: 4, busy: {
  duration: 3600, started: '2026-10-20T10:00:00.000Z',
  resource: { kind: 45, name: 'Glass' }
}};
const liveHistory = [
  { kind: 45, amount: 600, datetime: '2026-10-20T10:00:01.000Z' },
  { kind: 45, amount: 300, datetime: '2026-10-20T09:00:00.000Z' },
  { kind: 17, amount: 9999, datetime: '2026-10-20T10:00:00.000Z' }
];
const observed = core.observedProductionRatePerHour(liveBuilding, liveHistory, 8);
assert.equal(observed.rate, 1200, 'current cycle output scales from level 4 to planned level 8');
assert.equal(observed.amount, 600, 'the matching current-cycle row supplies the actual output amount');
assert.equal(core.observedProductionRatePerHour(liveBuilding, [liveHistory[1]], 4), null,
  'an older cycle cannot be paired with the current cycle duration');

const modifierRows = [
  { kind: 45, speedModifier: -18, since: '2026-10-19T00:00:00Z', until: '2026-11-01T00:00:00Z' },
  { kind: 45, speedModifier: 20, since: '2026-10-21T00:00:00Z', until: '2026-11-01T00:00:00Z' },
  { kind: 17, speedModifier: 30, since: '2026-10-19T00:00:00Z', until: '2026-11-01T00:00:00Z' },
  { kind: 45, speedModifier: 50, since: '2026-10-01T00:00:00Z', until: '2026-10-10T00:00:00Z' }
];
assert.equal(core.activeResourceProductionModifier(modifierRows, 45, Date.parse('2026-10-20T12:00:00Z')), -18,
  'only matching resource modifiers active at the supplied time are included');

// Two different recipes prove that production outputs and material demand come
// from recipe data rather than a product-specific balance adjustment.
const recipes = new Map([
  ['combustionengine', { id: 52, name: 'Combustion Engine', materials: [
    { id: 17, quantity: 5 }, { id: 21, quantity: 5 }, { id: 43, quantity: 6 }
  ] }],
  ['exampleproduct', { id: 900, name: 'Example Product', materials: [
    { id: 17, quantity: 2 }
  ] }]
]);
const ledger = core.productionBalance([
  { product: 'Combustion Engine', productId: 52, quality: 2, ratePerHour: 10 },
  { product: 'Example Product', productId: 900, quality: 1, ratePerHour: 4 }
], recipes, 10, new Map());

const output = ledger.productionRows.find(r => r.id === 52);
assert.equal(output.amount, 100, 'engine output is rate × horizon from its recipe-backed building spec');
const chemicalDemand = ledger.demandRows.filter(r => r.id === 17).reduce((n, r) => n + r.amount, 0);
assert.equal(chemicalDemand, 580, 'material demand sums the quantities from both recipe definitions');

const rows = core.balanceSupplyDemandContracts({
  warehouseRows: [{ id: 52, quality: 2, amount: 10 }],
  productionRows: ledger.productionRows.filter(r => r.id === 52),
  demandRows: [{ id: 52, minQuality: 0, amount: 50 }],
  contractRows: [{ id: 52, quality: 2, amount: 20 }],
  incomingContractRows: [{ id: 52, quality: 2, amount: 5 }]
});
const engine = rows.find(r => r.id === 52);
assert.equal(engine.warehouse, 10);
assert.equal(engine.produced, 100);
assert.equal(engine.incoming, 5);
assert.equal(engine.demand, 50);
assert.equal(engine.contracted, 20);
assert.equal(engine.leftover, 45, 'planner balance includes warehouse, planned output, and incoming stock minus demand and contracts');
assert.equal(engine.warehouse + engine.produced + engine.incoming, 115, 'production is not folded into warehouse or counted twice');

const overlayRows = core.balanceSupplyDemandContracts({
  warehouseRows: [{ id: 52, quality: 2, amount: 10 }],
  productionRows: [{ id: 52, quality: 2, amount: 100 }],
  demandRows: [{ id: 52, minQuality: 0, amount: 50 }],
  contractRows: [{ id: 52, quality: 2, amount: 20 }],
  includeQualityRows: true
});
const overlayEngine = overlayRows.qualityRows.find(r => r.id === 52 && r.quality === 2);
assert.equal(overlayEngine.leftover, 40, 'planner leftover includes planned production and must not be used as warehouse stock');
assert.equal(overlayEngine.warehouseOnlyLeft, -60, 'warehouse-only overlay balance excludes the 100 units of planned production');
assert.equal(overlayEngine.warehouseOnlyLeft + 5, -55, 'incoming commitments are added once to the warehouse-only overlay balance');

console.log('production-balance-regression: 15 assertions passed');
