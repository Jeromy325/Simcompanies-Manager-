// 2.5.368: Accounting tab shows the game's income statement / balance sheet / cash flow / ratios. Seeded with the
// user's real storage export (path in SCM_STORAGE_EXPORT), 360 px.
const H = require('./harness'); const fs = require('fs');
(async () => {
  const exp = JSON.parse(fs.readFileSync(process.env.SCM_STORAGE_EXPORT, 'utf8')).storage;
  const ctx = await H.launch(); const sw = await H.worker(ctx);
  await sw.evaluate(async s => { await chrome.storage.local.clear(); await chrome.storage.local.set(s); }, exp);
  const id = new URL(sw.url()).host; const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(`chrome-extension://${id}/dashboard.html`); await page.waitForTimeout(2500);
  await page.click('button.tab[data-tab="accounting"]'); await page.waitForTimeout(1500);
  const txt = async sel => (await page.textContent(sel).catch(() => '')) || '';
  const row = async (sel, label) => page.$$eval(`${sel} tr`, (rs, l) => { const r = rs.find(r => r.cells[0] && r.cells[0].childNodes[0] && r.cells[0].childNodes[0].textContent.trim() === l); return r ? r.cells[1].textContent.trim() : null; }, label);
  const inc = '#accountingIncomeStatement', bs = '#balanceDetails', cf = '#accountingCashflowSummary', ra = '#accountingRatios';
  const want = [[inc, 'Net income', '$416,561.00'], [inc, 'Total comprehensive income', '$162,835.00'], [inc, 'Capital charge', '-$28,243.00'], [inc, 'Operating profit', '$416,561.00'],
    [bs, 'Total assets', '$25,742,475.00'], [bs, 'Company value', '$25,742,475.00'], [cf, 'Total change in cash', '$680,865.00'], [cf, 'From exchange', '$3,140,805.00'],
    [ra, 'Gross Margin', '13.94%'], [ra, 'Operating Margin', '8.75%'], [ra, 'Net Profit Margin', '9.11%'], [ra, 'Return on Quick Assets', '13.01%'], [ra, 'Return on Equity', '1.62%'],
    [ra, 'Sales per Employee', '297.028'], [ra, 'Income per Employee', '27.065'], [ra, 'Inventory Turnover', '0.415'], [ra, 'Assets Turnover', '0.178'],
    [ra, 'Operating Assets Turnover', '0.364'], [ra, 'Defensive Interval', '0.819'], [ra, 'Interest Coverage', '-∞'], [ra, 'Debt to Building Ratio', '0.00%']];
  for (const [s, l, v] of want) { const got = await row(s, l); H.check(`${l}`, got === v, v, got); }
  const t = await txt(inc); H.check('income subtotals 637,059 / -236,958 / 16,460', /\$637,059\.00/.test(t) && /-\$236,958\.00/.test(t) && /\$16,460\.00/.test(t), true, '');
  const sw2 = await page.evaluate(() => document.documentElement.scrollWidth); H.check('no horizontal scroll at 360px', sw2 <= 360, '≤360', sw2);
  const inline = await page.evaluate(() => [...document.querySelectorAll('*')].some(e => [...e.attributes].some(a => /^on[a-z]+$/.test(a.name) && a.name in e)));
  H.check('no inline handlers', !inline, false, inline); H.check('no page errors', !errs.length, 0, errs.join('|'));
  await page.evaluate(() => document.querySelector('#accountingIncomeStatement').scrollIntoView()); await H.shot(page, 'acct-income');
  await page.evaluate(() => document.querySelector('#accountingRatios').scrollIntoView()); await H.shot(page, 'acct-ratios');
  await ctx.close(); H.done();
})();
