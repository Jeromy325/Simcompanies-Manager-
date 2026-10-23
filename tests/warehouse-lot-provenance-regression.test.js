const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dashboard = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');
assert.match(dashboard,/const lotProvenance = \{/,'each source inventory row gets a provenance record');
for (const field of ['id:x.id??x.lotId??null','datetime:x.datetime??x.timestamp??null','kind:id, quality:q, amount:qty, blocked:Boolean(x.blocked)','rawCost:x.cost!=null?JSON.parse(JSON.stringify(x.cost)):null','costSource:lotCostSource']) assert.ok(dashboard.includes(field),`missing lot provenance field ${field}`);
assert.match(dashboard,/g\._lots\.push\(lotProvenance\)/,'grouped rows retain separate source lots');
assert.match(dashboard,/same-product-quality-snapshot-fallback/,'fallback cost provenance is labelled rather than silently presented as lot-native');
console.log('warehouse-lot-provenance-regression: passed');
