// 2.5.392 Statement history by date. The game numbers day statements by age (/day/0/ = last finished day, up to /day/13/),
// so each rollover overwrote the stored copies and the store never held more than 14 days. Real dates from the user's
// R2 CSVs: day statements end ~01:20 UTC (10-26T01:20:11, 10-25T01:21:31 …).
const assert = require('assert'), fs = require('fs'), path = require('path');
const A = require('../analyze-core.js');
assert.ok(require('../manifest.json').version >= '2.5.392');
const day = (date, fees) => ({ date, isComputed: true, marketFees: -fees, sales: 1 });
// 20 days kept by date; the live store holds only /day/0/../day/13/ (the newest 14).
const hist = { 'income-statement': {} }, ep = {};
for (let i = 0; i < 20; i++) { const d = new Date(Date.parse('2026-10-26T01:20:11Z') - i * 864e5).toISOString(); hist['income-statement'][d] = day(d, 100 + i); if (i < 14) ep[`/api/v2/companies/me/income-statement/day/${i}/`] = { data: day(d, 100 + i) }; }
assert.equal(A.dayStatements(ep, 'income-statement').length, 14, 'store alone: 14 days');
const all = A.dayStatements(ep, 'income-statement', hist);
assert.equal(all.length, 20, 'with history: all 20, no duplicates');
assert.ok(all.every((x, i) => !i || x.t > all[i - 1].t), 'oldest first');
assert.equal(all[all.length - 1].day, 0, 'live /day/0/ wins for the same date');
assert.equal(A.dayStatements({}, 'income-statement', hist).length, 20);
const bg = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
assert.ok(/income-statement\|cashflow-statement\|balance-sheet\)\\\/day\\\/\\d\+/.test(bg), 'all three statements');
assert.ok(bg.includes("x.data.isComputed===true"), 'only computed (finished) days are kept');
assert.ok(/queueStatementHistory\(targetRealm,\[\{kind:sm\[1\],data\}\]\)/.test(bg), 'every capture, realm-stamped');
assert.ok(bg.includes('scmStatementHistorySeededV1') && /validRealmNumber\(v\?\.captureRealm\)===n\)\.map/.test(bg), 'seed from this realm only');
assert.ok(fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8').includes('`scmStatementHistory:${r}`'));
console.log('v392-regression: all assertions passed');
