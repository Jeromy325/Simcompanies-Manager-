'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dashboard = fs.readFileSync(path.join(root, 'dashboard.js'), 'utf8');
function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `source defines ${name}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0, quote = null, escape = false, lineComment = false, blockComment = false;
  for (let i = braceStart; i < source.length; i++) {
    const c = source[i], n = source[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && n === '/') { lineComment = true; i++; continue; }
    if (c === '/' && n === '*') { blockComment = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

const context = { Number, Math };
vm.createContext(context);
vm.runInContext([
  extractFunction(dashboard, 'roundCurrencyUp'),
  extractFunction(dashboard, 'roundResourceDown'),
].join('\n'), context);
const currency = context.roundCurrencyUp;
const resource = context.roundResourceDown;

// Currency uses mathematical ceiling to cents, including for negative values.
assert.equal(currency(55.771), 55.78);
assert.equal(currency(55.775), 55.78);
assert.equal(currency(55.770), 55.77);
assert.equal(currency(12.341), 12.35);
assert.equal(currency(12.345), 12.35);
assert.equal(currency(12.34), 12.34);
assert.equal(currency(0.001), 0.01);
assert.equal(currency(0), 0);
assert.equal(currency(-1.231), -1.23);
assert.equal(currency(-1.23), -1.23);
assert.ok(Number.isNaN(currency(Infinity)));

// Resources floor to configured precision without nearest-rounding.
assert.equal(resource(12.7899, 3), 12.789);
assert.equal(resource(12.789, 3), 12.789);
assert.equal(resource(12.7899, 2), 12.78);
assert.equal(resource(0.0009, 3), 0);
assert.equal(resource(1.2, 3), 1.2);
assert.equal(resource(-1.231, 2), -1.24);
assert.ok(Number.isNaN(resource(1, 9)));
assert.ok(Number.isNaN(resource(NaN, 3)));

assert.match(dashboard, /roundCurrencyUp\(calculated\)\.toFixed\(2\)/,
  'saved-contract suggested unit price uses currency ceiling');
assert.match(dashboard, /const price=roundCurrencyUp\(Number\(fd\.get\('price'\)\)\)/,
  'manual saved-contract unit price is normalized to cents with currency ceiling');
assert.match(dashboard, /total:quantityMode==='custom'\?roundCurrencyUp\(price\*quantity\):0/,
  'saved-contract total uses currency ceiling');
assert.doesNotMatch(dashboard, /Math\.round\([^\n]*1000\)/,
  'resource thousandth calculations no longer use nearest rounding in dashboard');

// Planner core uses the same policy for discounted unit prices and totals.
const coreContext = { Number, Math, Map, Set, Object, String, Array, JSON };
vm.createContext(coreContext);
vm.runInContext(fs.readFileSync(path.join(root, 'planner-core.js'), 'utf8'), coreContext);
const core = coreContext.SCMPlannerCore;
assert.equal(core.roundCurrencyUp(-1.231), -1.23);
assert.equal(core.roundResourceDown(2.3459, 3), 2.345);
assert.equal(core.discountedUnitPrice(57.5, 3), 55.78);
assert.equal(core.discountedTotal(57.5, 1, 3), 55.78);
assert.equal(core.discountedTotal(57.5, 2, 3), 111.56);
console.log('pricing-rounding-regression: 28 assertions passed');
