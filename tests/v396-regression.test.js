'use strict';
// 2.5.396: always-4% exchange fee, incoming-contract price rank, exchange market-price pop-out.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const dash = fs.readFileSync(path.join(root, 'dashboard.js'), 'utf8');
const bg = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const C = require(path.join(root, 'tools-core.js'));
const slice = (a, b) => content.slice(content.indexOf(a) + a.length, content.indexOf(b));

// Fee
assert.equal(C.EXCHANGE_FEE_PCT, 4);
const r = C.profitPerHour({ level: 1, baseRatePerLevel: 10, salePrice: 100, sellMode: 'exchange' });
if (r.ok) assert.ok(Math.abs(r.feePerUnit - 4) < 1e-9, 'default exchange fee is 4%');
assert.doesNotMatch(dash, /listFee|\(from your sales\)/, 'planner no longer uses listing/sales fees');
assert.match(bg, /feePct:C\.EXCHANGE_FEE_PCT/, 'sell advice uses 4%');

// Rank: cheapest = 1, ties share, per product + quality
const ranks = new Function(slice('/*SCM-RANK-START*/', '/*SCM-RANK-END*/') + 'return contractPriceRanks;')();
const out = ranks([
  { key: 'a', kind: 1, quality: 0, price: 5 }, { key: 'b', kind: 1, quality: 0, price: 3 },
  { key: 'c', kind: 1, quality: 0, price: 3 }, { key: 'd', kind: 1, quality: 0, price: 9 },
  { key: 'e', kind: 1, quality: 2, price: 1 }, { key: 'f', kind: 7, quality: 0, price: 2 }
]);
assert.deepEqual(['b', 'c', 'a', 'd'].map(k => out.get(k).rank), [1, 1, 3, 4]);
assert.equal(out.get('a').of, 4);
assert.deepEqual(out.get('e'), { rank: 1, of: 1 }, 'other quality ranked separately');
assert.deepEqual(out.get('f'), { rank: 1, of: 1 }, 'other product ranked separately');

// Exchange compare: cheapest other listing Q>=q, VWAP fallback labelled
const cmp = new Function(slice('/*SCM-XCMP-START*/', '/*SCM-XCMP-END*/') + 'return exchangeCompare;')();
const book = [{ id: 1, price: 10, quality: 1 }, { id: 2, price: 9, quality: 0 }, { id: 3, price: 12, quality: 2 }];
let x = cmp({ id: 1, price: 10, quality: 1 }, book, 11);
assert.equal(x.source, 'market'); assert.equal(x.ref, 12); assert.equal(x.verdict, 'Cheap');
x = cmp({ id: 9, price: 9.9, quality: 1 }, book, 11);
assert.equal(x.ref, 10); assert.equal(x.verdict, 'Fair');
x = cmp({ id: 3, price: 12, quality: 2 }, book, 11);
assert.equal(x.source, 'vwap'); assert.equal(x.verdict, 'Expensive');
assert.equal(cmp({ id: 3, price: 12, quality: 2 }, book, null), null);
assert.match(content, /'VWAP \(fallback\)'/);
assert.match(content, /b\.textContent='ⓘ'/, 'badge is a compact tap target; comparison only in the pop-out');
console.log('v396 ok');
