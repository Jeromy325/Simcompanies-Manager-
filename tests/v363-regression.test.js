// 2.5.363: Production planner "Building Type" test override + Reset to game data.
const assert = require('assert'); const fs = require('fs'); const path = require('path'); const vm = require('vm');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const dash = read('dashboard.js'), bg = read('background.js');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.371');
// background keeps only digit ids → short kind letters, per realm
const san = bg.slice(bg.indexOf('function sanitizeProductionPlannerState'), bg.indexOf('\n}\n', bg.indexOf('function sanitizeProductionPlannerState')) + 3);
const ctx = { validRealmNumber: r => Number.isFinite(Number(r)) ? Number(r) : null }; vm.createContext(ctx); vm.runInContext(san + '\nthis.san=sanitizeProductionPlannerState;', ctx);
const out = ctx.san({ kindOverrides: { 111: '1', 'x': 'E', 222: '<b>', 333: '' } }, 1);
assert.deepEqual(JSON.parse(JSON.stringify(out.kindOverrides)), { 111: '1' });
// ownedPlannerBuildings: the test building drops the real building's busy/plan/image/cost data
const own = dash.slice(dash.indexOf('function ownedPlannerBuildings'), dash.indexOf('function plannerCurrentProduct'));
const c2 = { pick: (o, ks) => { for (const k of ks) if (o && o[k] != null) return o[k]; }, buildingName: r => r.name || 'B' + r.kind };
c2.buildingArrayFromState = s => s.b; vm.createContext(c2); vm.runInContext(own + '\nthis.own=ownedPlannerBuildings;', c2);
const defs = [{ id: 'E', name: 'Power Plant', category: 'Energy', produces: ['Power'] }, { id: '1', name: 'Car Factory', category: 'Automotive', produces: ['Truck'] }];
const s = { b: [{ id: 111, kind: 'E', name: 'Power Plant', size: 3, image: 'x.png', cost: 9, busy: { resource: { name: 'Power', quality: 2, kind: 1 } } }],
  frozenNetworkPlan: { buildingPlans: { 111: { product: 'Truck', quality: 4, kind: '1' } } } };
const real = c2.own(s, defs)[0];
assert.equal(real.currentResource, 'Power'); assert.equal(real.currentQuality, 2, 'a test-kind frozen plan is ignored for the real building');
assert.equal(real.productionPlan, null);
const t = c2.own(s, defs, { 111: '1' })[0];
assert.equal(t.name, 'Car Factory'); assert.equal(t.testKind, true); assert.equal(t.gameName, 'Power Plant');
assert.deepEqual([...t.produces], ['Truck']); assert.equal(t.level, 3); assert.equal(t.raw.busy, undefined); assert.equal(t.raw.image, undefined); assert.equal(t.raw.cost, undefined);
assert.equal(t.productionPlan.product, 'Truck', 'frozen plan saved for the test kind is reused');
assert.equal(c2.own(s, defs, { 111: 'ZZ' })[0].testKind, false, 'unknown kind is ignored');
assert.ok(/kindOverrides:\{\.\.\.\(ui\.kindOverrides\|\|\{\}\)\}/.test(dash), 'kindOverrides persisted with planner state');
assert.ok(!/on[a-z]+="/.test(dash.slice(dash.indexOf("id=\"buildingKind\"") - 200, dash.indexOf("id=\"buildingKind\"") + 200)), 'no inline handlers');
console.log('v363-regression: ok');
