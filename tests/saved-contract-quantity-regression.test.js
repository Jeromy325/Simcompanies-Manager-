'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'planner-core.js'), 'utf8');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'dashboard.js'), 'utf8');

function extractFunction(sourceText, name) {
  const marker = `function ${name}(`, at = sourceText.indexOf(marker);
  assert.notEqual(at, -1, `${name} exists`);
  const brace = sourceText.indexOf('{', at);
  let depth = 0, quote = null, esc = false;
  for (let i = brace; i < sourceText.length; i++) {
    const ch = sourceText[i];
    if (quote) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return sourceText.slice(at, i + 1);
  }
  throw new Error(`Unable to extract ${name}`);
}
const lastGoodContext = { Number, String, Array, Math };
vm.createContext(lastGoodContext);
vm.runInContext(extractFunction(background, 'lastGoodGameOverlaySnapshot') + '\nglobalThis.lastGoodGameOverlaySnapshot = lastGoodGameOverlaySnapshot;', lastGoodContext);
const trusted = lastGoodContext.lastGoodGameOverlaySnapshot({
  realm: 1, contractSource: 'manager-saved-contracts-only', savedAt: new Date().toISOString(),
  rows: [{id:17,quality:3,warehouse:16407,demand:15855.059200314643,contracted:551.940799685357,outgoing:551.940799685357,incoming:0,difference:0,leftover:0,produced:24173}]
}, 1);
assert.equal(trusted.rows[0].outgoing, 551.940799685357, 'fast-path current snapshot preserves saved outgoing quantity');
assert.equal(trusted.rows[0].difference, 0, 'fast-path current snapshot preserves the saved-contract-adjusted Left');
const legacy = lastGoodContext.lastGoodGameOverlaySnapshot({
  realm: 1, savedAt: new Date().toISOString(),
  rows: [{id:17,quality:3,warehouse:16407,demand:15855.059200314643,contracted:551.940799685357,outgoing:551.940799685357,incoming:0,difference:0,leftover:0,produced:24173}]
}, 1);
assert.equal(legacy.rows[0].outgoing, 0, 'unmarked legacy snapshot still strips ambiguous live outgoing API values');
assert.ok(Math.abs(legacy.rows[0].difference - 551.940799685357) < 1e-9, 'legacy sanitizer recalculates from warehouse/demand inputs rather than trusting old outgoing data');

const context = { console, Map, Set, Object, Number, Math, Array, String, JSON, Date };
vm.createContext(context);
vm.runInContext(source, context);
const core = context.SCMPlannerCore;
assert.equal(typeof core.resolveSavedContractQuantities, 'function');
const key = '17:3';
const resolve = (contracts, base = 551.940799685357, surplus = 0) => core.resolveSavedContractQuantities({
  savedContracts: contracts,
  baseBalanceByKey: new Map([[key, base]]),
  surplusByKey: new Map([[key, surplus]])
});

// The reported live-test row: Chemicals Q3 has 551.9408 units Left after demand.
// Repeated recalculation must not alternate between zero and the positive balance.
{
  const outgoingLeft = { id: 'out-left', direction: 'Outgoing', product: '17:3', quality: 3, quantityMode: 'left', savedAt: '2026-10-15T18:30:33.687Z' };
  for (let i = 0; i < 25; i++) assert.equal(resolve([outgoingLeft]).get(outgoingLeft), 551.940799685357);
}

// Saved Incoming contracts increase the balance available to a saved Outgoing Left contract.
{
  const incomingCustom = { id: 'in-custom', direction: 'Incoming', product: '17:3', quality: 3, quantityMode: 'custom', quantity: 250 };
  const outgoingLeft = { id: 'out-left', direction: 'Outgoing', product: '17:3', quality: 3, quantityMode: 'left' };
  const quantities = resolve([incomingCustom, outgoingLeft], 100, 0);
  assert.equal(quantities.get(incomingCustom), 250);
  assert.equal(quantities.get(outgoingLeft), 350);
}

// Two saved Outgoing Left contracts cannot claim the same inventory.
{
  const first = { id: 'first', direction: 'Outgoing', product: '17:3', quality: 3, quantityMode: 'left', savedAt: '2026-01-01T00:00:00Z' };
  const second = { id: 'second', direction: 'Outgoing', product: '17:3', quality: 3, quantityMode: 'left', savedAt: '2026-01-02T00:00:00Z' };
  const quantities = resolve([second, first], 100, 0);
  assert.equal(quantities.get(first), 100);
  assert.equal(quantities.get(second), 0);
}

// Incoming Left is resolved from the clean pre-Left balance, and the resulting delivery is included once for Outgoing Left.
{
  const incomingLeft = { id: 'in-left', direction: 'Incoming', product: '17:3', quality: 3, quantityMode: 'left' };
  const outgoingLeft = { id: 'out-left', direction: 'Outgoing', product: '17:3', quality: 3, quantityMode: 'left' };
  const quantities = resolve([incomingLeft, outgoingLeft], 100, 0);
  assert.equal(quantities.get(incomingLeft), 100);
  assert.equal(quantities.get(outgoingLeft), 200);
}

// Other saved fixed/surplus quantities are included before Left allocation.
{
  const incomingCustom = { id: 'in', direction: 'Incoming', product: '17:3', quality: 3, quantityMode: 'custom', quantity: 20 };
  const outgoingCustom = { id: 'out', direction: 'Outgoing', product: '17:3', quality: 3, quantityMode: 'custom', quantity: 10 };
  const outgoingLeft = { id: 'left', direction: 'Outgoing', product: '17:3', quality: 3, quantityMode: 'left' };
  const quantities = resolve([incomingCustom, outgoingCustom, outgoingLeft], 100, 0);
  assert.equal(quantities.get(outgoingLeft), 110);
}

// Surplus values are driven by current production inputs, including a transition to zero.
{
  const outgoingSurplus = { id: 'out-surplus', direction: 'Outgoing', product: '17:3', quality: 3, quantityMode: 'surplus' };
  assert.equal(resolve([outgoingSurplus], 100, 300).get(outgoingSurplus), 300);
  assert.equal(resolve([outgoingSurplus], 100, 0).get(outgoingSurplus), 0);
}

// Integration guardrails: only `savedContracts` feeds the game overlay and no previous Difference is read for Left quantities.
const overlayStart = background.indexOf('async function buildGameOverlayData');
const overlayEnd = background.indexOf('// VWAP status belongs', overlayStart);
const overlay = background.slice(overlayStart, overlayEnd);
assert.match(overlay, /const savedContracts=Array\.isArray\(store\?\.savedContracts\)\?store\.savedContracts:\[\]/);
assert.doesNotMatch(overlay, /store\?\.contracts|priorOverlayRows|\.difference/);
assert.match(overlay, /contractSource:'manager-saved-contracts-only'/);
assert.match(overlay, /detailRows\.push\(\{id,quality,warehouse:0,produced:0,demand:0,contracted:0,leftover:0,warehouseOnlyLeft:0\}\)/, 'incoming-only saved rows start at zero so incoming quantity is applied only once');
assert.match(background, /currentSavedContractSchema=String\(snap\.contractSource\|\|''\)==='manager-saved-contracts-only'/);
assert.match(background, /oldSig=old\?JSON\.stringify\(\{realm:old\.realm,rows:old\.rows,contractSource:old\.contractSource\|\|''/, 'snapshot persistence compares contract source metadata, even when row values are unchanged');
assert.doesNotMatch(dashboard.slice(dashboard.indexOf('function savedContracts(s)'), dashboard.indexOf('async function saveRealmField')), /s\.contracts\s*\)?\s*:/);

console.log('saved-contract-quantity-regression: passed');
