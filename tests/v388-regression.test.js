// 2.5.388 The daily Accounting walk catches up the ledger archive: on days without a Sync only the newest 30 rows
// (cashflow/recent) were captured. Plan: start at the oldest row of the newest archived stretch, stop at the stretch
// before it. One stretch = no hole = 0 pages. Sync itself is unchanged.
const assert = require('assert'), fs = require('fs'), path = require('path');
const A = require('../analyze-core.js');
assert.equal(require('../manifest.json').version, '2.5.389');
const now = Date.now(), H = 36e5, R = '/api/v2/companies/me/cashflow/recent/';
const fill = (id, t) => ({ id, datetime: new Date(t).toISOString(), category: 'm', descriptionKey: 'marketfilled-17', money: 1, details: { resource: 17, quality: 3, amount: 1, price: 1 } });
const pageAt = (t0, ids) => ids.map((id, i) => fill(id, t0 - i * 6e5));
let a = A.archiveMerge(null, R, pageAt(now - 30 * H, [200, 199, 198]), new Date(now - 30 * H).toISOString(), now);
assert.equal(A.catchUpPlan(a), null, 'one stretch: nothing to fetch');
assert.equal(A.catchUpPlan(null), null);
a = A.archiveMerge(a, R, pageAt(now, [900, 899, 898]), new Date(now).toISOString(), now);
const p = A.catchUpPlan(a);
assert.equal(p.startId, '898', 'starts at the oldest row of the newest page');
assert.equal(p.startAt, now - 2 * 6e5);
assert.equal(p.stopAt, now - 30 * H, 'stops at the end of the stretch before');
// After the hole is walked, the stretches join and the plan is empty again.
const mid = []; for (let i = 0; i < 300; i++) mid.push(fill(897 - i, now - 2 * 6e5 - (i + 1) * (30 * H / 300)));
a = A.archiveMerge(a, '/api/v2/companies/me/cashflow/898/', mid, null, now);
assert.equal(a.spans.length, 1); assert.equal(A.catchUpPlan(a), null);

const bg = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const walk = bg.slice(bg.indexOf('async function runScheduledAccountingWalk'), bg.indexOf('const ACCOUNTING_WEEK_REFRESH_RETRY_MS'));
assert.ok(/catchUpLedgerArchive\(realm,`scheduled:\$\{trigger\}`\)/.test(walk), 'daily walk runs the catch-up');
assert.ok(/ledgerPages:ledger\?\.pages/.test(walk), 'result reports pages');
const sync = bg.slice(bg.indexOf('async function syncCurrentWeekAccountingSales'), bg.indexOf('async function syncCurrentWeekAccountingSales') + 8000);
assert.ok(!/catchUpLedgerArchive/.test(sync), 'Sync does not run it');
assert.equal((bg.match(/catchUpLedgerArchive\(/g) || []).length, 2, 'defined once, called once (daily walk only)');
assert.ok(/LEDGER_CATCHUP_MAX_PAGES=40/.test(bg), 'capped per run');
console.log('v388-regression: all assertions passed');
