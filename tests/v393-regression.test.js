// 2.5.393 CSV import. Fixtures = the head of the user's real R2 downloads (2026-10-26): account history, income
// statement, cash-flow statement, balance sheet. On the full files every imported value equals what the manager
// captured (sales 484/484 identical, 266 + 252 + 210 statement values, 0 mismatches).
const assert = require('assert'), fs = require('fs'), path = require('path');
const A = require('../analyze-core.js');
const F = f => fs.readFileSync(path.join(__dirname, 'fixtures', 'csv', f), 'utf8');
const names = { 'car body': 51, "jack o'lantern": 147, 'steel': 43, 'glass': 45, 'chemicals': 17 };
// Statements: real day 10-26 (from the CSVs) → stored field names.
const is = A.csvImport(F('r2-income-statement.csv'));
assert.equal(is.type, 'statement'); assert.equal(is.field, 'income-statement'); assert.equal(is.items.length, 7);
const d0 = is.items[0];
assert.deepEqual([d0.date, d0.sales, d0.cogs, d0.marketFees, d0.netIncome, d0.isComputed], ['2026-10-26T01:20:11.775137+00:00', 2199116, -1900420, -87876, -40596, true]);
const cf = A.csvImport(F('r2-cashflow-statement.csv')).items[0];
assert.deepEqual([cf.cashAllIncome, cf.fromExchange, cf.forFees, cf.fromRetail], [2215936, 1994882, -87876, 57491]);
const bs = A.csvImport(F('r2-balance-sheet.csv')).items[0];
assert.deepEqual([bs.cash, bs.buildings, bs.retainedEarnings, bs.valuationAllowance], [3090961, 6113400, 23633317, -1063595], 'last column read despite CRLF');
// Imported days feed the same day-statement reader.
const hist = { 'income-statement': Object.fromEntries(is.items.map(d => [d.date, d])) };
assert.equal(A.dayStatements({}, 'income-statement', hist).length, 7);
// Ledger: quoted JSON details, category → code, description → resource for fees and retail rows.
const led = A.csvImport(F('r2-account-history.csv'), { nameToId: n => names[n.toLowerCase()] });
assert.equal(led.type, 'ledger');
const car = led.rows.find(r => r.id === 3104264345); assert.deepEqual([car.category, car.descriptionKey, car.money, car.details.quality], ['m', 'marketfilled-51', 74740, 2]);
const fee = led.rows.find(r => r.id === 3104264346); assert.deepEqual([fee.category, fee.descriptionKey, fee.money], ['f', 'fees-51', -2990]);
const jack = led.rows.find(r => r.id === 3104294243); assert.deepEqual([jack.category, jack.descriptionKey], ['s', 'retail-147']);
const sales = A.salesFromLedger(led.rows), cs = sales.find(s => s.id === '3104264345');
assert.deepEqual([cs.channel, cs.rid, cs.q, cs.amount, cs.fee], ['exchange', 51, 2, 101, 2990], 'fill paired with its fee row');
assert.ok(sales.some(s => s.channel === 'retail' && s.rid === 147));
assert.ok(led.rows.every(r => /^(marketfilled|fees|retail)-\d+$|^cs-\d+/.test(r.descriptionKey)), 'only sale-related rows');
// Archive: captured rows win, repeat import adds nothing, covered span added.
const now = Date.parse('2026-10-27T00:00:00Z');
const a1 = A.archiveImport({ rows: { 3104264345: { id: 3104264345, keep: 'captured', datetime: car.datetime, descriptionKey: 'marketfilled-51' } }, spans: [] }, led.rows, now);
assert.equal(a1.rows['3104264345'].keep, 'captured', 'captured row not replaced');
assert.equal(a1.added, led.rows.length - 1); assert.equal(a1.spans.length, 1);
assert.equal(A.archiveImport(a1, led.rows, now).added, 0, 'second import adds nothing');
assert.equal(A.csvImport('a,b\n1,2').type, null, 'unknown CSV rejected');
// Background: statements kept by date without replacing captures; realm required.
const bg = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
assert.ok(bg.includes("if(h[kind][d]&&keep)continue;") && bg.includes('{keep:true}'));
assert.ok(/IMPORT_CSV_LEDGER[\s\S]{0,200}validRealmNumber\(m\.realm\)/.test(bg));
console.log('v393-regression: all assertions passed');
