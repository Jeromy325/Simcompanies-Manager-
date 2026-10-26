// 2.5.367: every test building counts in the network totals; the page's frozen-plan save carries outputRun.
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const dash = read('dashboard.js');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.381');
assert.ok(/activeSpecs:Array\.isArray\(core\.activeSpecs\)&&core\.activeSpecs\.length\?core\.activeSpecs\.map\(\(\{recipe,\.\.\.x\}\)=>x\):specs/.test(dash), 'network returns ledger specs (with outputRun) so SAVE_FROZEN_NETWORK_PLAN is accepted');
assert.ok(/const testPlan=b\.testKind&&!selected\?\{product:/.test(dash), 'non-selected test buildings use planner output/level/quality');
assert.ok(/\(b\.testKind\?null:plannerStoredProductionPlan\(s,b\)\)/.test(dash), 'test building never falls back to the real building plan');
// the background validator rejects specs without outputRun — the reason every page save failed before
const bg = read('background.js');
assert.ok(/x\.ratePerHour>0&&x\.outputRun>0/.test(bg));
console.log('v367-regression: ok');
