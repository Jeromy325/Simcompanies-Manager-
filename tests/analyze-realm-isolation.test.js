// 2.5.385 Analyze reads one realm only: captures stamped with that realm, purchases never count as sales,
// production runs only from that realm's buildings, and a cached result is never reused for the other realm.
const assert = require('assert');
const A = require('../analyze-core.js');
const fx = require('./fixtures/r2-accounting-day-walk-2026-10-25.json');

// The fixture is an R2 (realm 1) capture. Add an R1 (realm 0) ledger page holding a Water sale and an unstamped page.
const R2 = 1, R1 = 0;
const ep = {};
for (const [k, v] of Object.entries(fx)) ep[k] = { data: v, captureRealm: R2 };
const waterRow = { id: 9001, datetime: '2026-10-25T09:00:00Z', category: 'm', descriptionKey: 'marketfilled-2', money: 500, details: { resource: 2, quality: 0, amount: 1000, price: 0.5 } };
ep['/api/v2/companies/me/cashflow/999/'] = { data: { data: [waterRow] }, captureRealm: R1 };
ep['/api/v2/companies/me/cashflow/998/'] = { data: { data: [{ ...waterRow, id: 9002 }] } };

// 1. realmEndpoints keeps only the requested realm's stamped captures.
const r2 = A.realmEndpoints(ep, R2), r1 = A.realmEndpoints(ep, R1);
assert.equal(Object.keys(r2).length, Object.keys(fx).length, 'R2 keeps every R2 capture');
assert.deepEqual(Object.keys(r1), ['/api/v2/companies/me/cashflow/999/'], 'R1 keeps only the R1 capture');
assert.deepEqual(A.realmEndpoints(ep, null), {}, 'no realm, no data');
const water = realm => A.salesFromLedger(A.ledgerRows(A.realmEndpoints(ep, realm))).filter(s => s.rid === 2).length;
assert.equal(water(R2), 0, 'R1 Water sale never reaches R2');
assert.equal(water(R1), 1, 'R1 sees its own Water sale');
assert.equal(A.salesFromLedger(A.ledgerRows(ep)).filter(s => s.rid === 2).length, 2, 'unfiltered data would have mixed realms');
// Day statements / past finances read through the same filter.
assert.ok(A.company(r2) && A.company(r1) === null, 'R1 has no R2 past finances');

// 2. Money out is a purchase, never a sale (exchange or contract).
const buys = [{ ...waterRow, id: 1, money: -500 }, { id: 2, datetime: '2026-10-25T09:00:00Z', category: 't', descriptionKey: 'cs-2-Seller', money: -400, details: { resource: 2, quality: 0, amount: 800, price: 0.5 } }];
assert.equal(A.salesFromLedger(buys).length, 0, 'purchases are not sales');
assert.equal(A.salesFromLedger(A.ledgerRows(r2)).filter(s => s.channel !== 'retail').length, 10, 'all 10 R2 exchange + contract sales still counted'); // + 5 retail since 2.5.390

// 3. Production runs only from this realm's buildings; no building list = no runs.
const pch = [{ b: 11, id: 52, q: 2, c: 57.5, t: '2026-10-20T00:00:00Z' }, { b: 22, id: 2, q: 0, c: 0.4, t: '2026-10-21T00:00:00Z' }];
assert.deepEqual(A.realmCostHistory(pch, [11]).map(e => e.b), [11]);
assert.deepEqual(A.realmCostHistory(pch, []), []);

// 4. UI: the cached model is never reused for another realm, even with "keep 10 minutes" on and a revisit.
const store = new Map(), root = { dataset: {}, innerHTML: '', addEventListener() {} };
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
globalThis.document = { querySelector: s => (s === '#analyzeBody' ? root : s === '#analyze' ? { classList: { contains: () => true } } : null), querySelectorAll: () => [] };
globalThis.chrome = { storage: { local: { get: async () => ({}) } } };
require('../analyze-ui.js');
const UI = globalThis.SCM_ANALYZE_UI, S = UI._state;
const s = { endpointData: ep, productionCostHistory: pch, warehouseResources: [] };
const ctx = realm => ({ realm, lots: [], buildingIds: realm === R2 ? [11] : [22], nameOf: id => (id === 2 ? 'Water' : `R${id}`), priceOf: () => null, calcOf: () => null });
UI.render(s, ctx(R2));
assert.equal(S.model.realm, R2);
assert.equal(S.model.allSales.filter(x => x.rid === 2).length, 0, 'R2 model has no Water sale');
assert.deepEqual(S.model.pch.map(e => e.b), [11]);
S.left = true; // left the tab and came back within 10 minutes, now on R1
UI.render(s, ctx(R1));
assert.equal(S.model.realm, R1, 'model recomputed for R1');
assert.equal(S.model.allSales.length, 1, 'R1 model holds only the R1 sale');
assert.deepEqual(S.model.pch.map(e => e.b), [22]);
UI.render(s, ctx(R2));
assert.equal(S.model.realm, R2, 'back to R2 recomputes again');
console.log('analyze-realm-isolation: all assertions passed');
