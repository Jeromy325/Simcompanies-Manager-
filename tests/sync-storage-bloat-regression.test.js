// 2.5.389 R2 Sync stalled 88 s on storage (user export 2026-10-26): the R2 store was 7.6 MB, 5.1 MB of it 307 ledger
// cursor pages stored twice (endpointData + accountingCapture), and Sync's own writes queued behind passive captures.
const assert = require('assert'), fs = require('fs'), path = require('path');
const A = require('../analyze-core.js');
const bg = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const DAY = 864e5, now = Date.parse('2026-10-26T18:40:00Z');
const page = (id, daysAgo) => [`/api/v2/companies/me/cashflow/${id}/`, { status: 200, captureRealm: 1, receivedAt: new Date(now).toISOString(), data: { data: [{ id, datetime: new Date(now - daysAgo * DAY).toISOString(), money: 1 }] } }];

// Pages older than 8 days go, recent ones stay, /recent/ and other endpoints are never touched.
const ep = Object.fromEntries([page(1, 20), page(2, 9), page(3, 7.9), page(4, 1),
  ['/api/v2/companies/me/cashflow/recent/', { data: { data: [] } }], ['/api/v3/resources/5294950/', { data: [] }]]);
const r = A.pruneLedgerPages(ep, now);
assert.deepStrictEqual(Object.keys(r.map).sort(), ['/api/v2/companies/me/cashflow/3/', '/api/v2/companies/me/cashflow/4/', '/api/v2/companies/me/cashflow/recent/', '/api/v3/resources/5294950/']);
assert.strictEqual(r.dropped, 2);
assert.strictEqual(A.pruneLedgerPages(r.map, now).map, r.map, 'nothing to drop returns the same object (no write)');

// At most 60 pages even when all are recent (newest kept).
const many = Object.fromEntries(Array.from({ length: 307 }, (_, i) => page(1000 + i, i / 100)));
const kept = Object.keys(A.pruneLedgerPages(many, now).map);
assert.strictEqual(kept.length, 60);
assert.ok(kept.includes('/api/v2/companies/me/cashflow/1000/') && !kept.includes('/api/v2/companies/me/cashflow/1306/'));

// Saves prune cursor pages and keep them out of accountingCapture; old stores are compacted once, archive first.
assert.match(bg, /patch=\{endpointData:ledgerCursorPage\?pruneStoredLedgerPages\(endpointData\):endpointData\}/);
assert.match(bg, /isRealmSensitiveAccountingUrl\(url\) && !ledgerCursorPage &&/);
assert.match(bg, /async function compactLedgerPagesOnce\(\)[\s\S]*?queueLedgerArchive\(n,pages\)[\s\S]*?storageSetRealmPatch\(n,\{endpointData:nextEp,accountingCapture:nextAc\}\)/);
assert.match(bg, /seedLedgerArchiveOnce\(\)\.catch\(\(\)=>\{\}\)\.then\(\(\)=>compactLedgerPagesOnce\(\)\)/);

// Sync's auth save and realm activation jump the queue and cannot hang; the final commit too.
assert.match(bg, /saveData\('\/api\/v3\/companies\/auth-data\/',authBoundary\.data,authBoundary\.status,'GET',selected,null,\{priorityOnly:true\}\),SYNC_PERSIST_VERIFY_TIMEOUT_MS/);
assert.match(bg, /activateRealmByRealm\(selected,[^;]*\{priority:true\}\),SYNC_PERSIST_VERIFY_TIMEOUT_MS/);
assert.match(bg, /\},selected,\{priority:true\}\),8000,'Final Sync commit'\)/);
assert.match(bg, /durableOptions&&typeof durableOptions==='object'&&!durableOptions\.priorityOnly/);

// The Accounting day walk stops when a Sync starts and is re-run after it.
assert.match(bg, /if\(coreSyncActive\(\)\)throw new AccountingWalkYield\(\);\s*\/\/ Tapping Day/);
assert.match(bg, /e instanceof AccountingWalkYield[\s\S]{0,200}deferUntilSyncEnds\(`accounting-day-walk:\$\{n\}`/);

// A failed Sync retries itself once.
assert.match(bg, /!syncCoreSucceeded && !wasAutoRetry[\s\S]{0,120}SYNC_AUTO_RETRY_ALARM_PREFIX/);
assert.match(bg, /syncRetryMatch[\s\S]{0,300}syncAutoRetryRuns\.add\(realm\);\s*await syncNow\(realm\)/);
console.log('sync storage bloat regression checks passed.');
