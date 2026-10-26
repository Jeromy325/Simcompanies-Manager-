// 2.5.377: Accounting overview charts (trend + 7-day average, 7/30/90D range, tap readout); a background refresh patches
// only changed rows instead of rebuilding the tab. 2.5.382: Accounting overview card with Cash / Income / Expenses rows,
// expenses as positive costs, chart popout, "Current statements date" header, realm-checked newest statement.
// Seeded with the user's real R2 day-walk responses (days 0–6) plus game history padded to 90 days. 360 px.
const H = require('./harness'); const fs = require('fs'); const path = require('path');
(async () => {
  const fx = n => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', n), 'utf8'));
  const walk = fx('r2-accounting-day-walk-2026-10-25.json'), days = fx('r2-accounting-days-2026-10-25.json');
  const pad = (rows, n) => { const out = rows.slice(); let k = 1; while (out.length < n) { const r = rows[0]; const d = new Date(Date.parse(r.date.replace(' ', 'T')) - k * 864e5).toISOString().replace('T', ' ').replace('Z', '+00:00'); const f = 1 - k * 0.002 + (k % 5) * 0.004; const x = {}; for (const [a, v] of Object.entries(r)) x[a] = typeof v === 'number' && a !== 'rank' ? Math.round(v * f) : v; x.date = d; out.unshift(x); k++; } return out; };
  const at = '2026-10-25T02:00:00.000Z', wrap = data => ({ status: 200, data, receivedAt: at, captureRealm: 1 });
  const ep = {};
  for (const [k, v] of Object.entries(walk)) ep['https://www.simcompanies.com' + k] = wrap(v);
  // Stale current statement read later than the walk (older day, newer receipt) and a newer R1 statement: neither may win.
  const later = '2026-10-25T03:00:00.000Z';
  ep['https://www.simcompanies.com/api/v2/companies/me/income-statement/'] = { ...wrap(walk['/api/v2/companies/me/income-statement/day/1/']), receivedAt: later };
  ep['https://www.simcompanies.com/api/v2/companies/me/cashflow-statement/'] = { ...wrap(walk['/api/v2/companies/me/cashflow-statement/day/1/']), receivedAt: later };
  ep['https://www.simcompanies.com/api/v2/companies/123/income-statement/'] = { status: 200, receivedAt: later, captureRealm: 0, data: { ...walk['/api/v2/companies/me/income-statement/day/0/'], sales: 1, date: '2026-10-26T01:00:00+00:00', dateFrom: '2026-10-25T01:21:31+00:00' } };
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
  const I0 = walk['/api/v2/companies/me/income-statement/day/0/'];
  // parent card, groups, order
  const head = await page.textContent('.acct-overview-panel > h3').catch(() => ''); H.check('parent card "Accounting overview"', /^Accounting overview/.test(head.trim()), 'Accounting overview', head.trim());
  const groups = await page.$$eval('#accountingOverview .acct-group', gs => gs.map(g => g.querySelector('.acct-group-head').textContent + ':' + [...g.querySelectorAll('[data-acct-card]')].map(r => r.dataset.acctCard).join(',')));
  H.check('Cash / Income / Expenses order', groups.join('|') === 'Cash:cash,cashChange|Income:sales,netIncome|Expenses:cogs,freightOut,marketFees,executives,operatingExpenses', 'Cash/Income/Expenses', groups.join('|'));
  const rowText = k => page.$eval(`[data-acct-card="${k}"] .acct-row-txt`, e => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => '');
  const want = [['sales', /^Sales \$4,571,563\.00 ↑ \+\$484\.62K · \+11\.9%$/], ['netIncome', /^Net income \$416,561\.00 ↓ -\$20\.34K · -4\.7%$/], ['cashChange', /^Total change in cash \$680,865\.00 ↓ -\$46\.77K · -6\.4%$/],
    ['cogs', /^Cost of goods sold \$3,907,406\.00 ↑ \+\$556\.29K · \+16\.6%$/], ['freightOut', /^Freight out \$27,098\.00 ↑ \+\$12\.88K · \+90\.5%$/], ['marketFees', /^Exchange fees \$152,214\.00 ↑ \+\$62\.89K · \+70\.4%$/],
    ['executives', /^Executives cost \$84,744\.00 ↑ \+\$34\.02K · \+67\.1%$/], ['operatingExpenses', /^Operating expenses \$236,958\.00 ↓ -\$64\.21K · -21\.3%$/]];
  for (const [k, rx] of want) { const t = await rowText(k); H.check(`${k} row = latest finished day vs day before`, rx.test(t), String(rx), t); }
  const cls = k => page.$eval(`[data-acct-card="${k}"] .acct-row-chg`, e => e.className).catch(() => '');
  H.check('cost up = red', /change-down/.test(await cls('cogs')), 'change-down', await cls('cogs'));
  H.check('cost down = green', /change-up/.test(await cls('operatingExpenses')), 'change-up', await cls('operatingExpenses'));
  H.check('sales up = green', /change-up/.test(await cls('sales')), 'change-up', await cls('sales'));
  // header date (latest finished day of this realm, game format); no date line in the card
  const hdr = await page.evaluate(() => document.querySelector('#accountingPeriodDate').textContent + ' | ' + document.querySelector('#accountingPeriodMeta').textContent);
  const fmt = v => { const d = new Date(v); return `${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} ${d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}`; };
  const wantHdr = await page.evaluate(([a, b]) => { const f = v => { const d = new Date(v); return `${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} ${d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}`; }; return `Current statements date | ${f(a)} to ${f(b)}`; }, [I0.dateFrom, I0.date]);
  H.check('header = Current statements date + day/0 period (not stale day/1, not R1)', hdr === wantHdr, wantHdr, hdr);
  const basis = await page.$('#accountingOverview .finance-basis'); H.check('no date line on the cards', !basis, 'none', !!basis);
  // charts
  const pts = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#accountingOverview [data-acct-chart]')].map(b => [b.dataset.acctChart, (b.__acctPts || []).length])));
  let p = await pts();
  H.check('9 row charts', Object.keys(p).length === 9, 9, Object.keys(p).length);
  H.check('Cash 90 days from game history', p.cash === 90, 90, p.cash);
  for (const k of ['sales', 'netIncome', 'cogs', 'freightOut', 'marketFees', 'executives', 'operatingExpenses', 'cashChange']) H.check(`${k} 7 days from Day statements`, p[k] === 7, 7, p[k]);
  const last = k => page.evaluate(k => { const a = document.querySelector(`[data-acct-chart="${k}"]`).__acctPts; return a[a.length - 1][1]; }, k);
  H.check('COGS chart as positive cost', (await last('cogs')) === 3907406, 3907406, await last('cogs'));
  H.check('Total change in cash last point 680,865', (await last('cashChange')) === 680865, 680865, await last('cashChange'));
  const tone = k => page.$eval(`[data-acct-chart="${k}"] svg`, e => e.getAttribute('class')).catch(() => '');
  H.check('rising cost chart is red', /acct-bad/.test(await tone('cogs')), 'acct-bad', await tone('cogs'));
  await page.click('#accountingOverview [data-acct-range="7"]'); p = await pts();
  H.check('7D range: Cash 7 points', p.cash === 7, 7, p.cash);
  await page.click('#accountingOverview [data-acct-range="90"]');
  // tooltip
  const box = await page.$('[data-acct-chart="cash"] svg'); const bb = await box.boundingBox();
  await page.mouse.move(bb.x + bb.width - 1, bb.y + bb.height / 2);
  const tip = await page.textContent('[data-acct-chart="cash"] .acct-tip').catch(() => '');
  H.check('readout shows date, value and change', /^[A-Z][a-z]{2} \d+\$[\d,]+\.\d\d[+-]\$[\d,]+\.\d\d \([+-][\d.]+%\)$/.test(tip), 'date $value ±$change (±%)', tip);
  H.check('right edge snaps to latest day (Oct 25)', /^Oct 25/.test(tip), 'Oct 25', tip.slice(0, 6));
  const tipBox = await page.$eval('[data-acct-chart="cash"] .acct-tip', e => { const r = e.getBoundingClientRect(); return [r.left, r.right]; }).catch(() => [0, 0]);
  H.check('readout stays on screen', tipBox[0] >= 0 && tipBox[1] <= 360, '0..360', tipBox.join('..'));
  await page.mouse.move(5, 5);
  const saved = await sw.evaluate(async () => Object.values((await chrome.storage.local.get('scmRealmStore:1'))['scmRealmStore:1']?.accountingDailySeries?.days || {}).filter(d => d.cogs != null && d.cashChange != null).length);
  H.check('new figures saved per day for the realm', saved >= 7, '≥7', saved);
  // background refresh: tag DOM nodes, change only the balance-sheet cash
  await page.evaluate(() => { for (const el of document.querySelectorAll('#accountingOverview [data-acct-card], #accountingOverview [data-acct-part], #accountingIncomeStatement > *')) el.__tag = 1; });
  const bump = mode => sw.evaluate(async mode => { const s = (await chrome.storage.local.get('scmRealmStore:1'))['scmRealmStore:1']; const ep = { ...s.endpointData }; const now = new Date().toISOString();
    if (mode === 'cash') { const k = 'https://www.simcompanies.com/api/v2/companies/me/balance-sheet/'; ep[k] = { ...ep[k], receivedAt: now, data: { ...ep[k].data, cash: ep[k].data.cash + 1000 } }; }
    else { const k = 'https://www.simcompanies.com/api/v3/companies/me/past-finances/'; const rows = ep[k].data.slice(); const l = rows.length - 1; rows[l] = { ...rows[l], cashAndReceivables: rows[l].cashAndReceivables + 50000 }; ep[k] = { ...ep[k], receivedAt: now, data: rows }; }
    await chrome.storage.local.set({ 'scmRealmStore:1': { ...s, endpointData: ep } }); }, mode);
  await bump('cash'); await page.waitForTimeout(2500);
  const r = await page.evaluate(() => ({ cards: [...document.querySelectorAll('#accountingOverview [data-acct-card]')].every(e => e.__tag), rev: document.querySelector('[data-acct-part="sales"]').__tag === 1, inc: [...document.querySelectorAll('#accountingIncomeStatement > *')].every(e => e.__tag), cash: document.querySelector('[data-acct-part="cash"] .acct-row-val').textContent }));
  H.check('no row rebuilt by background refresh', r.cards, true, r.cards);
  H.check('unchanged Sales block untouched', r.rev, true, r.rev);
  H.check('unchanged income statement untouched', r.inc, true, r.inc);
  const cash0 = walk['/api/v2/companies/me/balance-sheet/'].cash + 1000;
  H.check('Cash value patched in place', r.cash === '$' + cash0.toLocaleString('en-US') + '.00', '$' + cash0.toLocaleString('en-US') + '.00', r.cash);
  // popout
  await page.evaluate(() => document.querySelector('[data-acct-card="cogs"]').scrollIntoView({ block: 'center' }));
  const rowTop = () => page.evaluate(() => Math.round(document.querySelector('[data-acct-card="cogs"]').getBoundingClientRect().top));
  const scrollBefore = await page.evaluate(() => scrollY), topBefore = await rowTop();
  await page.click('[data-acct-open="cogs"]');
  const popVisible = await page.isVisible('#acctChartPop'); H.check('chart icon opens popout', popVisible, true, popVisible);
  const popOnBody = await page.evaluate(() => document.getElementById('acctChartPop').parentElement === document.body && getComputedStyle(document.getElementById('acctChartPop')).position === 'fixed');
  H.check('popout covers the page (fixed, on body)', popOnBody, true, popOnBody);
  const popTxt = async () => (await page.innerText('#acctChartPop .acct-pop-head').catch(() => '') || '').replace(/\s+/g, ' ').trim();
  H.check('90D subtitle "7 of 90 days collected"', /^Cost of goods sold 7 of 90 days collected ✕$/.test(await popTxt()), '7 of 90 days collected', await popTxt());
  const popVal = (await page.innerText('#acctChartPop .acct-pop-val')).replace(/\s+/g, ' ').trim();
  H.check('popout value + change', /^\$3,907,406\.00 ↑ \+\$556\.29K · \+16\.6%$/.test(popVal), '$3,907,406.00 ↑ +$556.29K · +16.6%', popVal);
  const focusX = await page.evaluate(() => document.activeElement?.matches?.('#acctChartPop [data-acct-close]')); H.check('focus moves to ✕', focusX, true, focusX);
  const locked = await page.evaluate(() => document.body.classList.contains('acct-pop-open')); H.check('page behind does not scroll', locked, true, locked);
  await page.click('#acctChartPop [data-acct-range="30"]'); await page.waitForTimeout(200);
  H.check('30D in popout: "7 of 30 days collected"', /7 of 30 days collected/.test(await popTxt()), '7 of 30 days collected', await popTxt());
  const synced = await page.$eval('#accountingOverview [data-acct-range="30"]', b => b.getAttribute('aria-pressed')); H.check('range in step with the rows', synced === 'true', 'true', synced);
  await page.click('#acctChartPop [data-acct-range="7"]'); await page.waitForTimeout(200);
  H.check('7D full: no subtitle', !/collected/.test(await popTxt()), 'no subtitle', await popTxt());
  await page.click('#acctChartPop [data-acct-range="30"]'); await page.waitForTimeout(200);
  await H.shot(page, 'acct-popout');
  // hold while the popout is open
  await bump('history'); await page.waitForTimeout(2500);
  H.check('popout still open during background refresh', await page.isVisible('#acctChartPop'), true, await page.isVisible('#acctChartPop'));
  const pending = await page.evaluate(() => typeof acctChartPending !== 'undefined' && !!acctChartPending); H.check('chart update waits while popout open', pending, true, pending);
  // close: Esc, ✕, tap outside
  await page.keyboard.press('Escape'); await page.waitForTimeout(150);
  H.check('Esc closes', !(await page.isVisible('#acctChartPop')), false, await page.isVisible('#acctChartPop'));
  const pend2 = await page.evaluate(() => !!acctChartPending); H.check('held update applied on close', !pend2, false, pend2);
  const scrollAfter = await page.evaluate(() => scrollY), topAfter = await rowTop(); H.check('back where you were', Math.abs(scrollAfter - scrollBefore) < 2 && Math.abs(topAfter - topBefore) < 2, `${scrollBefore}/${topBefore}`, `${scrollAfter}/${topAfter}`);
  const back = await page.evaluate(() => document.activeElement?.dataset?.acctOpen); H.check('focus returns to the chart icon', back === 'cogs', 'cogs', back);
  await page.click('[data-acct-open="sales"]'); await page.click('#acctChartPop [data-acct-close]'); await page.waitForTimeout(150);
  H.check('✕ closes', !(await page.isVisible('#acctChartPop')), false, await page.isVisible('#acctChartPop'));
  await page.click('[data-acct-open="cash"]'); await page.mouse.click(180, 8); await page.waitForTimeout(150);
  H.check('tap outside closes', !(await page.isVisible('#acctChartPop')), false, await page.isVisible('#acctChartPop'));
  const unlocked = await page.evaluate(() => document.body.classList.contains('acct-pop-open')); H.check('scroll unlocked after close', !unlocked, false, unlocked);
  // collapse the parent card
  await page.click('.acct-overview-panel > h3'); const col = await page.$eval('.acct-overview-panel', e => e.classList.contains('is-collapsed') && getComputedStyle(document.getElementById('accountingOverview')).display === 'none');
  H.check('Accounting overview collapses', col, true, col); await page.click('.acct-overview-panel > h3');
  await page.evaluate(() => document.querySelector('.acct-overview-panel').scrollIntoView()); await H.shot(page, 'acct-overview');
  const sw2 = await page.evaluate(() => document.documentElement.scrollWidth); H.check('no horizontal scroll at 360px', sw2 <= 360, '≤360', sw2);
  H.check('no page errors', !errs.length, 0, errs.join('|'));
  await ctx.close(); H.done();
})();
