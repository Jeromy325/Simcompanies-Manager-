'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `source contains ${name}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0, quote = null, escape = false, lineComment = false, blockComment = false, template = false;
  for (let i = braceStart; i < source.length; i++) {
    const c = source[i], n = source[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if ((quote === '`' && c === '`') || (quote !== '`' && c === quote)) quote = null;
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
function extractConstArray(source, name) {
  const marker = `const ${name}=`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `source contains ${name}`);
  const open = source.indexOf('[', start);
  let depth = 0, quote = null, escape = false;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '[') depth++;
    if (c === ']' && --depth === 0) return source.slice(start, i + 1) + ';';
  }
  throw new Error(`Could not extract ${name}`);
}

// Test the actual production-price helpers and constructionMaterialPlan from dashboard.js.
const dashboard = read('dashboard.js');
const dashContext = {
  console, Map, Set, Object, Number, String, Math, Array, JSON,
  globalThis: { SCMPlannerCore: { clampDiscount: v => Math.min(10, Math.max(0, Number(v) || 0)) } },
  warehouseRows: s => (s.warehouseRows || []).map(r => ({ _id: Number(r.id), _qty: Number(r.amount) })),
};
vm.createContext(dashContext);
vm.runInContext([
  extractFunction(dashboard, 'roundCurrencyUp'),
  extractFunction(dashboard, 'roundResourceDown'),
  extractFunction(dashboard, 'marketNumeric'),
  extractFunction(dashboard, 'buildMarketPriceMap'),
  extractFunction(dashboard, 'exactMarketPrice'),
  extractConstArray(dashboard, 'CONSTRUCTION_MATERIALS'),
  extractFunction(dashboard, 'constructionWarehouseStock'),
  extractFunction(dashboard, 'constructionCostUnits'),
  extractFunction(dashboard, 'constructionMaterialPlan'),
].join('\n'), dashContext);
const sampleState = {
  liveMarketPriceData: { realm: 0, rows: [
    { resourceId: 101, quality: 0, price: 175 },
    { resourceId: 102, quality: 0, price: 2.35 },
    { resourceId: 108, quality: 0, price: 8.8 },
    { resourceId: 111, quality: 0, price: 2450 },
  ] },
  // Intentionally different VWAPs prove that the projection ignores them.
  vwapData: { rows: [
    { resourceId: 101, quality: 0, value: 172.71953 },
    { resourceId: 102, quality: 0, value: 2.3635385 },
    { resourceId: 108, quality: 0, value: 8.610879 },
    { resourceId: 111, quality: 0, value: 2454.1643 },
  ] },
  warehouseRows: [
    { id: 102, amount: 12540 }, { id: 108, amount: 3648 }, { id: 111, amount: 228 },
  ],
};
const marketMap = dashContext.buildMarketPriceMap(sampleState);
const plan = dashContext.constructionMaterialPlan(sampleState, { raw: { cost: 65550 } }, 12, 13, 3, marketMap);
const concrete = plan.items.find(x => x.id === 101);
assert.equal(concrete.required, 912, 'Level 12→13 material quantities stay unchanged');
assert.equal(concrete.marketPrice, 175, 'construction projection takes the live market quote');
assert.equal(concrete.price, 169.75, 'discount is applied to market price, not VWAP');
assert.equal(concrete.lineTotal, 154812, 'projected cost follows the market-price quote');
assert.equal(plan.totalCost, 154812, 'total construction cost sums the market-priced shortages');
assert.equal(plan.items.find(x => x.id === 102).amount, 0, 'warehouse-covered materials are not charged');
assert.match(dashboard, /Buying \$\{Math\.min\(10,Math\.max\(0,Number\(discount\)\|\|0\)\)\}% below Market Price/,
  'upgrade modal labels the source as Market Price');

// Test the actual current-market and incoming-comparison helpers from background.js.
const background = read('background.js');
const bgContext = { Number, Math, Map, Set, Object, String, Array, JSON };
vm.createContext(bgContext);
vm.runInContext([
  extractFunction(background, 'overlayCurrentMarketPrice'),
  extractFunction(background, 'overlayVwap'),
  extractFunction(background, 'overlayIncomingContractMarketComparison'),
].join('\n'), bgContext);
const contractState = {
  liveMarketPriceData: { realm: 0, rows: [{ resourceId: 102, quality: 1, price: 2.05 }] },
  vwapData: { sourceRealm: 0, rows: [{ resourceId: 102, quality: 1, value: 2.20 }, { resourceId: 102, quality: 3, value: 2.10 }] },
  liveMarketProductCache: { '102:2': { resourceId: 102, quality: 2, selected: { price: 3.5 } } },
};
const comparison = bgContext.overlayIncomingContractMarketComparison(contractState, { kind: 102, quality: 1, price: 2 }, 0);
assert.equal(comparison.marketPrice, 2.05, 'incoming contract comparison uses exact-quality current market price');
assert.ok(Math.abs(comparison.savingsPct - (2.05 - 2) / 2.05 * 100) < 1e-10,
  'incoming contract savings percent uses market price');
const cachedComparison = bgContext.overlayIncomingContractMarketComparison(contractState, { kind: 102, quality: 2, price: 3 }, 0);
assert.equal(cachedComparison.marketPrice, 3.5, 'incoming comparison can use the exact-key current market product cache');
const missingComparison = bgContext.overlayIncomingContractMarketComparison(contractState, { kind: 102, quality: 3, price: 2 }, 0);
assert.equal(missingComparison.marketPrice, 2.10, 'missing current quote falls back only to exact-quality VWAP');
assert.ok(Math.abs(missingComparison.savingsPct - (2.10 - 2) / 2.10 * 100) < 1e-10, 'VWAP fallback computes the comparison percent');
assert.match(background, /c\.marketPrice=comparison\.marketPrice/,
  'incoming helper endpoint passes current market price to the overlay');
assert.match(background, /const comparison=overlayIncomingContractMarketComparison\(store,c,realm\)/,
  'incoming inline-overlay endpoint uses the same market-price comparison');
assert.doesNotMatch(read('content.js'), /__SCM_HELPER_MENU__|const items = \[|scm-helper-card|GET_HELPER_OVERLAY_DATA/,
  'retired floating helper panel and its page-side data mapping are removed');
assert.doesNotMatch(read('content.js').slice(read('content.js').indexOf('// Incoming Contracts inline market-price comparison'), read('content.js').indexOf('\n\n// ', read('content.js').indexOf('// Incoming Contracts inline market-price comparison') + 10)), /record\?\.vwap|vs VWAP|cheaper than VWAP/,
  'incoming inline overlay does not calculate or label comparisons using VWAP');

console.log('market-pricing-regression: 14 assertions passed');
