// 2.5.387 Analyze ledger archive. cashflow/recent keeps only the newest 30 rows and each capture replaces it, so sales
// that rolled off between full syncs (user report: Chemicals "Recent sales: None") were lost. The archive keeps every
// captured page's sale rows and the time each page proves complete; coverage now reports holes inside the ledger;
// the product page lists recent sales at every quality.
const assert = require('assert'), fs = require('fs'), path = require('path');
const A = require('../analyze-core.js');
const manifest = require('../manifest.json');
assert.equal(manifest.version, '2.5.387');

const now = Date.now(), MIN = 60000, R2 = 1;
// 120 rows, one every 10 minutes over 20 h: Chemicals (17) fills alternating Q1 / Q2, each with its fee row.
const all = [];
for (let i = 0; i < 60; i++) {
  const t = now - (60 - i) * 20 * MIN, q = i % 2 ? 2 : 1, id = 1000 + i * 2;
  all.push({ id, datetime: new Date(t).toISOString(), category: 'm', descriptionKey: 'marketfilled-17', money: 1000, details: { resource: 17, quality: q, amount: 100, price: 10, profit: 300, buyer: 'B', version: 1 } });
  all.push({ id: id + 1, datetime: new Date(t + 10 * MIN).toISOString(), category: 'e', descriptionKey: '1-salaries', money: -5, details: {} });
}
const newestFirst = list => [...list].sort((a, b) => Date.parse(b.datetime) - Date.parse(a.datetime));
const recentAt = t => newestFirst(all.filter(r => Date.parse(r.datetime) <= t)).slice(0, 30);
const RECENT = '/api/v2/companies/me/cashflow/recent/';

// 1. Capture at −12 h, then at now: the rows between them rolled off recent and never reached a page.
const t1 = now - 12 * 60 * MIN, page1 = recentAt(t1), page2 = recentAt(now);
let arc = A.archiveMerge(null, RECENT, page1, new Date(t1).toISOString(), now);
assert.equal(arc.added, 15, 'only sale rows are kept (15 fills, no salary rows)');
assert.deepEqual(Object.keys(arc.rows[String(page1.find(r => r.category === 'm').id)].details).sort(), ['amount', 'buyer', 'price', 'profit', 'quality', 'resource'], 'details slimmed, quality kept');
arc = A.archiveMerge(arc, RECENT, page2, new Date(now).toISOString(), now);
assert.equal(arc.spans.length, 2, 'two separate spans');

const ep = { [RECENT]: { data: { data: page2 }, receivedAt: new Date(now).toISOString(), captureRealm: R2 } };
const before = A.salesFromLedger(A.ledgerRows(ep)), after = A.salesFromLedger(A.ledgerRows(ep, arc));
assert.equal(before.length, 15, 'endpointData alone: only the latest recent page');
assert.equal(after.length, 30, 'archive keeps the rows of the earlier capture too');

// 2. Coverage sees the hole in the middle (old rule saw none: oldest row → now).
const spans = A.mergeSpans([...arc.spans, ...A.pageSpans(ep)]);
const cov = A.ledgerCoverage(A.ledgerRows(ep, arc), 1, now, spans);
assert.equal(cov.gaps.length, 1, 'one hole');
const gapH = cov.gapMs / 36e5; assert.ok(gapH > 6 && gapH < 7.5, `hole ≈ 6.8 h, got ${gapH}`);
assert.ok(cov.coverage < 0.75, 'coverage counts the hole');
assert.equal(A.ledgerCoverage(A.ledgerRows(ep, arc), 1, now).gaps.length, 0, 'no spans: old behaviour, no gap list');

// 3. A cursor page from the oldest recent row is anchored to that row: page chains close with no false gap.
const cursor = page2[page2.length - 1], older = newestFirst(all.filter(r => Date.parse(r.datetime) < Date.parse(cursor.datetime))).slice(0, 30);
const arc2 = A.archiveMerge(arc, `/api/v2/companies/me/cashflow/${cursor.id}/`, older, new Date(now).toISOString(), now);
const cov2 = A.ledgerCoverage(A.ledgerRows(ep, arc2), 1, now, arc2.spans);
assert.equal(cov2.gaps.length, 1, 'still one hole, shorter');
assert.ok(cov2.gapMs < cov.gapMs - 4 * 36e5, 'cursor page filled 5 h of it');
assert.ok(arc2.spans.some(([a, b]) => a <= Date.parse(older[older.length - 1].datetime) && b >= now - MIN), 'cursor span joins the recent span');
// pageSpans gives the same chain from endpointData alone.
const ep2 = { ...ep, [`/api/v2/companies/me/cashflow/${cursor.id}/`]: { data: { data: older }, receivedAt: new Date(now).toISOString(), captureRealm: R2 } };
assert.equal(A.pageSpans(ep2).length, 1, 'recent + anchored cursor page = one span');

// 4. Pruned after ARCHIVE_DAYS.
const later = now + (A.ARCHIVE_DAYS + 1) * 864e5, pruned = A.archiveMerge(arc2, RECENT, [], null, later);
assert.equal(Object.keys(pruned.rows).length, 0); assert.equal(pruned.spans.length, 0);

// 5. UI: archive rows reach Analyze, the Data page shows the hole, and Chemicals Q1 shows its Q2 sales too.
const store = new Map(), root = { dataset: {}, innerHTML: '', addEventListener() {} };
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
globalThis.document = { querySelector: s => (s === '#analyzeBody' ? root : s === '#analyze' ? { classList: { contains: () => true } } : null), querySelectorAll: () => [] };
globalThis.chrome = { storage: { local: { get: async () => ({}) } } };
require('../analyze-ui.js');
const UI = globalThis.SCM_ANALYZE_UI, S = UI._state;
const ctx = { realm: R2, lots: [{ kind: 17, quality: 1, amount: 50, cost: { workers: 350 } }], buildingIds: [1], nameOf: id => (id === 17 ? 'Chemicals' : `R${id}`), priceOf: () => null, calcOf: () => null };
UI.render({ endpointData: ep, ledgerArchive: arc, productionCostHistory: [], warehouseResources: [] }, ctx);
assert.equal(S.model.allSales.length, 30, 'model uses archive rows');
assert.equal(S.model.coverage.gaps.length, 1);
UI._go('data'); UI.render({ endpointData: ep, ledgerArchive: arc, productionCostHistory: [], warehouseResources: [] }, ctx);
assert.ok(/1 gap \(/.test(root.innerHTML), 'Data page: gap count'); assert.ok(/1 hole in the ledger/.test(root.innerHTML), 'Known gaps: hole listed');
assert.ok(!/14 of 7/.test(root.innerHTML));
S.prod = '17:1'; S.page = 'product'; UI.render({ endpointData: ep, ledgerArchive: { ...arc }, productionCostHistory: [], warehouseResources: [] }, ctx);
assert.ok(/Recent sales · all qualities/.test(root.innerHTML), 'product page title');
assert.ok(/Q2 · /.test(root.innerHTML) && /Q1 · /.test(root.innerHTML), 'both qualities listed');
// Realm without a number never uses an archive.
UI.render({ endpointData: ep, ledgerArchive: arc, productionCostHistory: [], warehouseResources: [] }, { ...ctx, realm: null });
assert.equal(S.model.allSales.length, 0);

// 6. Background writes the archive on every cash-flow capture and seeds it once; dashboard loads it per realm.
const bg = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), dash = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');
assert.ok(bg.includes("import './analyze-core.js';"));
assert.ok(/queueLedgerArchive\(targetRealm,\[\{url:/.test(bg), 'capture hook');
assert.ok(bg.includes('scmLedgerArchiveSeededV1') && /validRealmNumber\(v\?\.captureRealm\)===n/.test(bg), 'seed only from this realm\'s stamped pages');
assert.ok(dash.includes('`scmLedgerArchive:${r}`'), 'dashboard loads the viewed realm\'s archive');
console.log('v387-regression: all assertions passed');
