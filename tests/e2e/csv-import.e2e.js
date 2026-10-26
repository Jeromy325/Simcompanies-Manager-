// 2.5.393 CSV import on Analyze → Data (360 px). Profile with no ledger and no day statements; upload the user's real
// R2 CSV downloads (full files via SCM_CSV_DIR, else the trimmed fixtures) and check what lands in storage.
const H = require('./harness'); const fs = require('fs'), path = require('path');
(async () => {
  const dir = process.env.SCM_CSV_DIR || path.join(__dirname, '..', 'fixtures', 'csv');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.csv')).map(f => path.join(dir, f));
  const { storage } = require('./mock-export').loadExport({ days: false });
  const st = storage['scmRealmStore:1']; for (const k of Object.keys(st.endpointData)) if (/cashflow\/(recent|\d+)\/$|\/day\/\d+\/$/.test(k)) delete st.endpointData[k];
  storage.scmLedgerArchiveSeededV2 = true; storage.scmStatementHistorySeededV1 = true;
  const ctx = await H.launch(); const sw = await H.worker(ctx);
  await require('./mock-export').seedExport(sw, storage);
  const id = new URL(sw.url()).host, page = await ctx.newPage(), errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(`chrome-extension://${id}/dashboard.html`); await page.waitForTimeout(2500);
  await page.click('button.tab[data-tab="analyze"]'); await page.waitForTimeout(1000);
  await page.evaluate(() => globalThis.SCM_ANALYZE_UI._go('data')); await page.waitForTimeout(400);
  await page.setInputFiles('#analyzeBody [data-an-import]', files);
  let msg = ''; for (let i = 0; i < 40; i++) { await page.waitForTimeout(500); msg = await page.textContent('#anImportMsg').catch(() => ''); if ((msg.match(/·/g) || []).length >= files.length - 1 && msg) break; }
  const want = Object.fromEntries(files.map(f => [path.basename(f), fs.readFileSync(f, 'utf8').trim().split('\n').length - 1]));
  const s = await sw.evaluate(async () => { const g = await chrome.storage.local.get(['scmStatementHistory:1', 'scmLedgerArchive:1']); const h = g['scmStatementHistory:1'] || {}; return { is: Object.keys(h['income-statement'] || {}).length, cf: Object.keys(h['cashflow-statement'] || {}).length, bs: Object.keys(h['balance-sheet'] || {}).length, rows: Object.keys(g['scmLedgerArchive:1']?.rows || {}).length }; });
  const n = k => want[Object.keys(want).find(f => f.includes(k))];
  H.check('income statement days stored', s.is === n('income'), n('income'), s.is);
  H.check('cash-flow days stored', s.cf === n('cashflow'), n('cashflow'), s.cf);
  H.check('balance-sheet days stored', s.bs === n('balance'), n('balance'), s.bs);
  H.check('ledger rows archived', s.rows > 0, '>0', s.rows);
  H.check('message per file', files.every(f => msg.includes(path.basename(f))), files.length, msg.slice(0, 300));
  await page.waitForTimeout(800);
  const t = await page.textContent('#analyzeBody');
  H.check('Data shows imported days', new RegExp(`${s.is} days stored`).test(t), `${s.is} days stored`, (t.match(/\d+ days stored[^\n]{0,20}/) || [])[0]);
  // Import again: nothing new, nothing replaced.
  await page.setInputFiles('#analyzeBody [data-an-import]', files); await page.waitForTimeout(3000);
  msg = await page.textContent('#anImportMsg');
  H.check('second import adds 0', /: 0 new day/.test(msg) && /: 0 new ledger rows/.test(msg), '0 new', msg.slice(0, 200));
  const w = await page.evaluate(() => document.documentElement.scrollWidth); H.check('no h-scroll at 360px', w <= 360, '≤360', w);
  await page.evaluate(() => document.querySelector('[data-an-card="dt-imp"]')?.scrollIntoView()); await H.shot(page, 'csv-import');
  H.check('no page errors', !errs.length, 0, errs.join(' | '));
  await ctx.close(); H.done();
})().catch(e => { console.error(e); process.exit(1); });
