// 2.5.387 Analyze ledger archive at 360 px. Base: the user's real R2 export fixture; the cash-flow ledger is replaced
// by Chemicals (17) Q1/Q2 fills over 20 h in two recent captures 12 h apart (rows between them rolled off), one kept
// in scmLedgerArchive:1. Checks archive rows count, the hole on Data, and Chemicals Q1 showing Q2 sales too.
const H = require('./harness'); const A = require('../../analyze-core.js');
(async () => {
  const { storage } = require('./mock-export').loadExport({ days: true });
  const store = storage['scmRealmStore:1'], now = Date.now(), MIN = 6e4, RECENT = '/api/v2/companies/me/cashflow/recent/';
  const all = []; for (let i = 0; i < 60; i++) { const t = now - (60 - i) * 20 * MIN; all.push({ id: 5000 + i, datetime: new Date(t).toISOString(), category: 'm', descriptionKey: 'marketfilled-17', money: 1000, details: { resource: 17, quality: i % 2 ? 2 : 1, amount: 100, price: 10, profit: 300, buyer: 'B' } }); }
  const recentAt = t => all.filter(r => Date.parse(r.datetime) <= t).sort((a, b) => Date.parse(b.datetime) - Date.parse(a.datetime)).slice(0, 15);
  const t1 = now - 12 * 60 * MIN;
  for (const k of Object.keys(store.endpointData)) if (/\/cashflow\/(recent|\d+)\/$/.test(k)) delete store.endpointData[k];
  store.endpointData[RECENT] = { status: 200, data: { data: recentAt(now) }, receivedAt: new Date(now).toISOString(), captureRealm: 1 };
  const { added, ...arc } = A.archiveMerge(null, RECENT, recentAt(t1), new Date(t1).toISOString(), now);
  storage['scmLedgerArchive:1'] = arc; storage.scmLedgerArchiveSeededV1 = true;
  store.warehouseResources = [{ id: 1, kind: 17, quality: 1, amount: 50, blocked: false, datetime: new Date(now).toISOString(), materials: [], cost: { workers: 350 } }];

  const ctx = await H.launch(); const sw = await H.worker(ctx);
  await require('./mock-export').seedExport(sw, storage);
  const id = new URL(sw.url()).host, page = await ctx.newPage(), errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(`chrome-extension://${id}/dashboard.html`); await page.waitForTimeout(2500);
  await page.click('button.tab[data-tab="analyze"]'); await page.waitForTimeout(1200);
  const n = await page.evaluate(() => globalThis.SCM_ANALYZE_UI._state.model?.allSales?.length);
  H.check('archive + recent sales reach Analyze', n === 30, 30, n);
  await page.evaluate(() => globalThis.SCM_ANALYZE_UI._go('data')); await page.waitForTimeout(300);
  let t = await page.textContent('#analyzeBody');
  const gap = t.match(/(\d+) gaps? \(([^)]+)\)/);
  H.check('Data: one ledger gap shown', gap?.[1] === '1', 1, gap?.[0]);
  H.check('Data: day statements read Complete, not "14 of 7"', !/\d+ of 7\b/.test(t) || /of 7 days/.test(t), 'no "14 of 7"', t.match(/\d+ of 7[^\n]{0,6}/)?.[0]);
  let w = await page.evaluate(() => document.documentElement.scrollWidth); H.check('data: no h-scroll at 360px', w <= 360, '≤360', w);
  await H.shot(page, 'analyze-data-gap');
  await page.evaluate(() => { const S = globalThis.SCM_ANALYZE_UI._state; S.back = 'margins'; S.prod = '17:1'; globalThis.SCM_ANALYZE_UI._go('product'); }); await page.waitForTimeout(300);
  t = await page.textContent('#analyzeBody');
  H.check('Chemicals Q1: Recent sales · all qualities', /Recent sales · all qualities/.test(t), 'title', /Recent sales[^\n]{0,20}/.exec(t)?.[0]);
  const q2 = (t.match(/Q2 · /g) || []).length, q1 = (t.match(/Q1 · /g) || []).length;
  H.check('Chemicals Q1: 5 rows across Q1 + Q2', q1 + q2 === 5 && q2 > 0 && q1 > 0, '5 (both)', `Q1 ${q1}, Q2 ${q2}`);
  w = await page.evaluate(() => document.documentElement.scrollWidth); H.check('product: no h-scroll at 360px', w <= 360, '≤360', w);
  await page.evaluate(() => document.querySelector('[data-an-card="pd-sales"]')?.scrollIntoView()); await H.shot(page, 'analyze-product-allq');
  H.check('no page errors', !errs.length, 0, errs.join(' | '));
  await ctx.close(); H.done();
})().catch(e => { console.error(e); process.exit(1); });
