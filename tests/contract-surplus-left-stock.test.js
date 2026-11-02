'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const dashboard = fs.readFileSync(path.join(root, 'dashboard.js'), 'utf8');
function extractFunction(src, name) {
  const at = src.indexOf(`function ${name}(`); assert.notEqual(at, -1, name);
  let depth = 0, quote = null, esc = false;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    const ch = src[i];
    if (quote) { if (esc) esc = false; else if (ch.charCodeAt(0) === 92) esc = true; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++; else if (ch === '}' && --depth === 0) return src.slice(at, i + 1);
  }
}
const ctx = { Math, Number, String, Array, Map, Set, Object, JSON, Date };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'planner-core.js'), 'utf8'), ctx);
ctx.SCMPlannerCore = ctx.SCMPlannerCore || ctx.globalThis.SCMPlannerCore;
const contract = { direction: 'Outgoing', productId: 17, quality: 3, quantityMode: 'left', quantity: 0 };
Object.assign(ctx, {
  plannerProductionNetwork: () => ({ activeBuildings: [
    { product: 'Chemicals', quality: 3, outputRun: 32784.451, inputs: [{ id: 17, required: 18035, minQuality: 0 }] }] }),
  warehouseRows: () => [{ _id: 17, _quality: 3 }],
  warehouseQuantity: () => 19271,
  plannerNormalizeName: x => String(x || '').toLowerCase(),
  savedContracts: () => [contract],
  savedContractQuantityMode: c => c.quantityMode,
  savedContractProductionSurplusQuantity: () => 0,
  savedContractEffectiveQuantity: () => 0,
  resourceInfo: () => ({ name: 'Chemicals' }),
  plannerResourceNameById: () => 'Chemicals'
});
vm.runInContext(extractFunction(dashboard, 'contractSurplusAfterOutgoing') + '\nglobalThis.fn = contractSurplusAfterOutgoing;', ctx);
const res = ctx.fn({}, [], [{ id: 17, name: 'Chemicals' }], {});
const row = res.rows.find(r => r.id === 17);
assert.ok(row, 'row present');
assert.ok(Math.abs(row.contracted - 1236) < 1e-6, `contracted ${row.contracted}`);
assert.ok(Math.abs(row.leftover) < 1e-6, `leftover ${row.leftover}`);
console.log('contract-surplus-left-stock ok');
