// 2.5.368: Accounting tab shows the game's income statement / balance sheet / cash flow / ratios. Seeded with the
// user's real storage export (path in SCM_STORAGE_EXPORT) or, without one, the mock built from tests/fixtures. 360 px.
const H = require('./harness'); const fs = require('fs');
(async () => {
  const { storage: exp, mock } = require('./mock-export').loadExport({ days: true }); // real export via SCM_STORAGE_EXPORT, else mock
  const ctx = await H.launch(); const sw = await H.worker(ctx);
  await require('./mock-export').seedExport(sw, exp);
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
  // 2.5.382: overview rows (expenses shown as positive costs; change in compact $ and 1-decimal %).
  const tiles = await page.$$eval('#accountingOverview .acct-row-txt', cs => cs.map(c => c.innerText.replace(/\s+/g, ' ').trim()));
  const tile = l => tiles.find(x => x.startsWith(l + ' ')) || '';
  H.check('Operating expenses tile = game (236,958 cost), was cash paid out 3,907,158', /^Operating expenses \$236,958\.00/.test(tile('Operating expenses')), '$236,958.00', tile('Operating expenses'));
  if (process.env.SCM_HAS_DAY1 || mock) {
    H.check('Sales vs day/1 statement', /↑ \+\$484\.62K · \+11\.9%/.test(tile('Sales')), '↑ +$484.62K · +11.9%', tile('Sales'));
    H.check('Opex vs day/1 statement (cost down = ↓), % on |base|', /↓ -\$64\.21K · -21\.3%/.test(tile('Operating expenses')), '↓ -$64.21K · -21.3%', tile('Operating expenses'));
    const h = await page.$$eval('#accountingHistory .acct-day', ds => ds.map(d => d.textContent.replace(/\s+/g, ' ').trim()));
    H.check('Oct 23 row from day statement', /Sales\$4,086,939\.00Operating expenses-\$301,165\.00Net income\$436,896\.00/.test(h[1] || ''), 'Sales 4,086,939 / Opex -301,165 / NI 436,896', h[1]);
  }
  H.check('Net income tile', /^Net income \$416,561\.00 ↓ -\$20\.34K · -4\.7%/.test(tile('Net income')), '$416,561.00 ↓ -$20.34K · -4.7%', tile('Net income'));
  H.check('Total change in cash tile', /^Total change in cash \$680,865\.00/.test(tile('Total change in cash')), '$680,865.00', tile('Total change in cash'));
  const t = await txt(inc); H.check('income subtotals 637,059 / -236,958 / 16,460', /\$637,059\.00/.test(t) && /-\$236,958\.00/.test(t) && /\$16,460\.00/.test(t), true, '');
  const sw2 = await page.evaluate(() => document.documentElement.scrollWidth); H.check('no horizontal scroll at 360px', sw2 <= 360, '≤360', sw2);
  const inline = await page.evaluate(() => [...document.querySelectorAll('*')].some(e => [...e.attributes].some(a => /^on[a-z]+$/.test(a.name) && a.name in e)));
  H.check('no inline handlers', !inline, false, inline); H.check('no page errors', !errs.length, 0, errs.join('|'));
  await page.evaluate(() => document.querySelector('#accountingIncomeStatement').scrollIntoView()); await H.shot(page, 'acct-income');
  await page.evaluate(() => document.querySelector('#accountingRatios').scrollIntoView()); await H.shot(page, 'acct-ratios');
  await ctx.close(); H.done();
})();
