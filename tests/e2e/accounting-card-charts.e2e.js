// 2.5.377: Accounting overview cards get 90-day sparklines (trend + 7-day average, 7/30/90D range, tap readout) and a
// background refresh patches only changed cards instead of rebuilding the tab. Seeded with the user's real R2 day-walk
// responses (days 0–6) plus game history padded to 90 days with synthetic earlier rows. 360 px.
const H = require('./harness'); const fs = require('fs'); const path = require('path');
(async () => {
  const fx = n => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', n), 'utf8'));
  const walk = fx('r2-accounting-day-walk-2026-10-25.json'), days = fx('r2-accounting-days-2026-10-25.json');
  const pad = (rows, n) => { const out = rows.slice(); let k = 1; while (out.length < n) { const r = rows[0]; const d = new Date(Date.parse(r.date.replace(' ', 'T')) - k * 864e5).toISOString().replace('T', ' ').replace('Z', '+00:00'); const f = 1 - k * 0.002 + (k % 5) * 0.004; const x = {}; for (const [a, v] of Object.entries(r)) x[a] = typeof v === 'number' && a !== 'rank' ? Math.round(v * f) : v; x.date = d; out.unshift(x); k++; } return out; };
  const at = '2026-10-25T02:00:00.000Z', wrap = data => ({ status: 200, data, receivedAt: at, captureRealm: 1 });
  const ep = {};
  for (const [k, v] of Object.entries(walk)) ep['https://www.simcompanies.com' + k] = wrap(v);
  ep['https://www.simcompanies.com/api/v3/companies/me/past-finances/'] = wrap(pad(days['past-finances'], 90));
  ep['https://www.simcompanies.com/api/v2/companies/me/past-finances-overview/'] = wrap(pad(days['past-finances-overview'], 90));
  const auth = { authCompany: { realmId: 1, companyId: 5294950, company: 'Hewitt Corporation' } };
  // Seed after the service worker's startup settles: seeding during startup can lose activeRealmKey (harness timing).
  const ctx = await H.launch(); await H.worker(ctx); await new Promise(r => setTimeout(r, 2000));
  const seedNow = () => H.seed(ctx, { realm: 1, store: { endpointData: ep, authData: auth, captureRealm: 1 }, extra: { viewRealm: 1 } });
  await seedNow(); await new Promise(r => setTimeout(r, 500));
  if (!(await (await H.worker(ctx)).evaluate(async () => (await chrome.storage.local.get('activeRealmKey')).activeRealmKey))) await seedNow();
  const sw = await H.worker(ctx); const id = new URL(sw.url()).host; const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(`chrome-extension://${id}/dashboard.html`); await page.waitForTimeout(2500);
  // The seeded store is sometimes not read on the very first dashboard load (harness timing): reload once if so.
  const ready = () => page.waitForFunction(() => (document.querySelector('[data-acct-chart="cash"]')?.__acctPts || []).length > 0, null, { timeout: 10000 }).then(() => true, () => false);
  await page.click('button.tab[data-tab="accounting"]');
  if (!(await ready())) { await page.reload(); await page.waitForTimeout(2500); await page.click('button.tab[data-tab="accounting"]'); await ready(); }
  const pts = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#accountingOverview [data-acct-chart]')].map(b => [b.dataset.acctChart, (b.__acctPts || []).length])));
  let p = await pts();
  H.check('9 card charts', Object.keys(p).length === 9, 9, Object.keys(p).length);
  H.check('Cash 90 days from game history', p.cash === 90, 90, p.cash);
  H.check('Revenue 7 days from Day statements', p.revenue === 7, 7, p.revenue);
  H.check('Opex 7 days', p.operatingExpenses === 7, 7, p.operatingExpenses);
  H.check('Profit (net income) 7 days', p.profit === 7, 7, p.profit);
  H.check('Current Liabilities 7 days from Day balance sheets', p.currentLiabilities === 7, 7, p.currentLiabilities);
  const last = k => page.evaluate(k => { const a = document.querySelector(`[data-acct-chart="${k}"]`).__acctPts; return a[a.length - 1][1]; }, k);
  H.check('Revenue last point = day/0 sales', (await last('revenue')) === walk['/api/v2/companies/me/income-statement/day/0/'].sales, walk['/api/v2/companies/me/income-statement/day/0/'].sales, await last('revenue'));
  H.check('Profit last point = day/0 net income 416,561', (await last('profit')) === 416561, 416561, await last('profit'));
  H.check('Opex last point = game subtotal -236,958', (await last('operatingExpenses')) === -236958, -236958, await last('operatingExpenses'));
  const collect = await page.textContent('[data-acct-chart="revenue"] .acct-collect').catch(() => '');
  H.check('Revenue shows collecting note', /7 of 90 days/.test(collect), '7 of 90 days', collect);
  const tile = await page.$eval('[data-acct-card="operatingExpenses"]', c => c.innerText.replace(/\s+/g, ' ').trim());
  H.check('Opex tile text still starts with label + value', /^Operating expenses -\$236,958\.00/.test(tile), '-$236,958.00', tile.slice(0, 40));
  // range
  await page.click('[data-acct-range="7"]'); p = await pts();
  H.check('7D range: Cash 7 points', p.cash === 7, 7, p.cash);
  await page.click('[data-acct-range="90"]');
  // tooltip
  const box = await page.$('[data-acct-chart="cash"] svg'); const bb = await box.boundingBox();
  await page.mouse.move(bb.x + bb.width - 1, bb.y + bb.height / 2);
  const tip = await page.textContent('[data-acct-chart="cash"] .acct-tip').catch(() => '');
  H.check('readout shows date, value and change', /^[A-Z][a-z]{2} \d+\$[\d,]+\.\d\d[+-]\$[\d,]+\.\d\d \([+-][\d.]+%\)$/.test(tip), 'date $value ±$change (±%)', tip);
  H.check('right edge snaps to latest day (Oct 25)', /^Oct 25/.test(tip), 'Oct 25', tip.slice(0, 6));
  await page.mouse.move(5, 5);
  // persisted series
  const saved = await sw.evaluate(async () => Object.keys((await chrome.storage.local.get('scmRealmStore:1'))['scmRealmStore:1']?.accountingDailySeries?.days || {}).length);
  H.check('daily series saved for realm', saved >= 7, '≥7', saved);
  // background refresh: tag DOM nodes, change only the balance-sheet cash
  await page.evaluate(() => { for (const el of document.querySelectorAll('#accountingOverview [data-acct-card], #accountingOverview [data-acct-part], #accountingIncomeStatement > *')) el.__tag = 1; });
  // mode 'cash': balance-sheet cash +1000 (card value only); mode 'history': latest game-history row +50,000 (chart data)
  const bump = mode => sw.evaluate(async mode => { const s = (await chrome.storage.local.get('scmRealmStore:1'))['scmRealmStore:1']; const ep = { ...s.endpointData }; const now = new Date().toISOString();
    if (mode === 'cash') { const k = 'https://www.simcompanies.com/api/v2/companies/me/balance-sheet/'; ep[k] = { ...ep[k], receivedAt: now, data: { ...ep[k].data, cash: ep[k].data.cash + 1000 } }; }
    else { const k = 'https://www.simcompanies.com/api/v3/companies/me/past-finances/'; const rows = ep[k].data.slice(); const l = rows.length - 1; rows[l] = { ...rows[l], cashAndReceivables: rows[l].cashAndReceivables + 50000 }; ep[k] = { ...ep[k], receivedAt: now, data: rows }; }
    await chrome.storage.local.set({ 'scmRealmStore:1': { ...s, endpointData: ep } }); }, mode);
  await bump('cash');
  await page.waitForTimeout(2500);
  const r = await page.evaluate(() => ({ cards: [...document.querySelectorAll('#accountingOverview [data-acct-card]')].every(e => e.__tag), rev: document.querySelector('[data-acct-part="revenue"]').__tag === 1, inc: [...document.querySelectorAll('#accountingIncomeStatement > *')].every(e => e.__tag), cash: document.querySelector('[data-acct-part="cash"] .finance-value').textContent }));
  H.check('no card rebuilt by background refresh', r.cards, true, r.cards);
  H.check('unchanged Revenue block untouched', r.rev, true, r.rev);
  H.check('unchanged income statement untouched', r.inc, true, r.inc);
  const cash0 = walk['/api/v2/companies/me/balance-sheet/'].cash + 1000;
  H.check('Cash value patched in place', r.cash === '$' + cash0.toLocaleString('en-US') + '.00', '$' + cash0.toLocaleString('en-US') + '.00', r.cash);
  // hold while the full chart is open
  await page.click('[data-acct-open="revenue"]');
  const sheetOpen = await page.isVisible('[data-acct-sheet]'); H.check('chart icon opens full chart', sheetOpen, true, sheetOpen);
  await bump('history');
  await page.waitForTimeout(2500);
  const pend = await page.isVisible('[data-acct-pending]'); H.check('chart update waits while full chart open', pend, true, pend);
  H.check('full chart still open', await page.isVisible('[data-acct-sheet]'), true, await page.isVisible('[data-acct-sheet]'));
  await page.click('[data-acct-apply]'); await page.waitForTimeout(300);
  const pend2 = await page.isVisible('[data-acct-pending]'); H.check('Update charts applies and hides bar', !pend2, false, pend2);
  await page.evaluate(() => document.querySelector('#accountingOverview').scrollIntoView()); await H.shot(page, 'acct-charts-top');
  await page.evaluate(() => document.querySelector('[data-acct-sheet]').scrollIntoView({ block: 'end' })); await H.shot(page, 'acct-charts-sheet');
  const sw2 = await page.evaluate(() => document.documentElement.scrollWidth); H.check('no horizontal scroll at 360px', sw2 <= 360, '≤360', sw2);
  H.check('no page errors', !errs.length, 0, errs.join('|'));
  await ctx.close(); H.done();
})();
