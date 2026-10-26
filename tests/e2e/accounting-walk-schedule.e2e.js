// 2.5.371: daily scheduled Accounting walk — on/off + minutes on the Accounting tab (360 px), alarm follows the
// game's statement time, retries when the game has not finished the statements, walks Day 0–6 once it has.
const H = require('./harness'); const fs = require('fs'); const path = require('path');
(async () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'r2-accounting-day-walk-2026-10-25.json'), 'utf8'));
  const { storage: exp, mock } = require('./mock-export').loadExport({ days: false }); // real export via SCM_STORAGE_EXPORT, else mock
  const ctx = await H.launch(); const sw = await H.worker(ctx);
  await require('./mock-export').seedExport(sw, exp);
  const api = {}; for (const [k, v] of Object.entries(fx)) if (!/\/day\/\d+\/$/.test(k)) api[k] = v;
  const html = `<div class="bar"><label>Period</label><div><button>Current</button><button id="dayMode">Day</button><button>Week</button><button>Month</button></div></div><p id="shown">current</p>
<script>(function(){const bar=document.querySelector('.bar');const load=n=>{['income-statement','cashflow-statement','balance-sheet'].forEach(k=>fetch('/api/v2/companies/me/'+k+'/day/'+n+'/'));document.getElementById('shown').textContent='day '+n;};
document.getElementById('dayMode').addEventListener('click',()=>{if(bar.children[2]){load(0);return;}const g=document.createElement('div');for(let c=0;c<14;c++){const b=document.createElement('button');b.textContent='d'+c;b.addEventListener('click',()=>load(c));g.appendChild(b);}bar.appendChild(g);load(0);});
bar.children[1].children[0].addEventListener('click',()=>{document.getElementById('shown').textContent='current';});})();</script>`;
  await H.fakeGame(ctx, { html, api });
  await ctx.route(/\/api\/v2\/companies\/me\/(income-statement|cashflow-statement|balance-sheet)\/day\/\d+\/$/, async route => {
    const p = new URL(route.request().url()).pathname; await new Promise(r => setTimeout(r, 800));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fx[p] ?? {}) });
  });
  const game = await ctx.newPage(); await game.goto('https://www.simcompanies.com/headquarters/accounting/'); await game.waitForTimeout(4000);
  const id = new URL(sw.url()).host; const dash = await ctx.newPage(); await dash.goto(`chrome-extension://${id}/dashboard.html`); await dash.waitForTimeout(2000);
  await dash.click('button.tab[data-tab="accounting"]'); await dash.waitForTimeout(1500);
  const sch = () => sw.evaluate(async () => (await chrome.storage.local.get('scmAccountingWalkSchedule')).scmAccountingWalkSchedule);
  const alarm = () => sw.evaluate(async () => (await chrome.alarms.get('scm-accounting-walk-daily'))?.scheduledTime ?? null);
  const ready = Date.parse(fx['/api/v2/companies/me/income-statement/'].date);
  const nextFrom = (r, m) => { let t = r + m * 60000; while (t <= Date.now()) t += 86400000; return t; };
  // layout: last card on the tab, collapsed by default, no card nested inside the Accounting cards
  const layout = await dash.evaluate(() => { const ps = [...document.querySelectorAll('#accounting [data-collapse^="acct:"]')].filter(e => /^acct:[a-z-]+$/.test(e.dataset.collapse)); const w = document.querySelector('[data-collapse="acct:walk"]'); return { last: ps[ps.length - 1]?.dataset.collapse, collapsed: w.querySelector('#accountingWalkSchedule').offsetHeight === 0, head: document.querySelector('#acctWalkHead')?.textContent, nested: [...document.querySelectorAll('#accountingCashflowSummary .statement-card, #accountingIncomeStatement .statement-card, #balanceDetails .statement-card, #accountingRatios .statement-card')].length }; });
  H.check('walk card is the last card', layout.last === 'acct:walk', 'acct:walk', layout.last);
  H.check('walk card collapsed by default', layout.collapsed, true, layout.collapsed);
  H.check('header shows Off', layout.head === 'Off', 'Off', layout.head);
  H.check('no inner cards in statement sections', layout.nested === 0, 0, layout.nested);
  await dash.evaluate(() => document.querySelector('[data-collapse="acct:walk"]').scrollIntoView());
  await dash.tap('[data-collapse="acct:walk"] > [data-collapse-head]'); await dash.waitForTimeout(500);
  await H.shot(dash, 'acct-walk-open-off');
  // 1. turn on (default 30 min)
  await dash.tap('#acctWalkEnabled'); await dash.waitForTimeout(1500);
  let s = await sch(); let a = await alarm();
  H.check('enabled for R2', s?.enabled === true && s?.realm === 1, 'enabled realm 1', JSON.stringify({ e: s?.enabled, r: s?.realm }));
  H.check('next walk = statements ready + 30 min', Date.parse(s?.nextAt) === nextFrom(ready, 30) && a === nextFrom(ready, 30), new Date(nextFrom(ready, 30)).toISOString(), `${s?.nextAt} alarm ${a && new Date(a).toISOString()}`);
  // 2. adjust to 45
  await dash.fill('#acctWalkOffset', '45'); await dash.press('#acctWalkOffset', 'Tab'); await dash.waitForTimeout(1500);
  s = await sch(); a = await alarm();
  H.check('minutes 45 moves the walk', s?.offsetMin === 45 && a === nextFrom(ready, 45), new Date(nextFrom(ready, 45)).toISOString(), `${s?.offsetMin} ${a && new Date(a).toISOString()}`);
  const ui = await dash.textContent('#accountingWalkSchedule');
  H.check('UI shows next walk', /Next \w{3} \d/.test(ui.replace(/\s+/g, ' ')), 'Next <day> <time>', ui.replace(/\s+/g, ' ').slice(0, 160));
  const head = await dash.textContent('#acctWalkHead'); H.check('header shows On · time', /^On · \d/.test(head), 'On · 9:06 PM', head);
  // 3. alarm fires before the game finished the next statements → retry in 15 min, no walk
  await game.bringToFront();
  await dash.evaluate(() => chrome.alarms.create('scm-accounting-walk-daily', { when: Date.now() + 300 }));
  for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 1000)); s = await sch(); if (s?.lastResult) break; }
  H.check('not rolled over → retry', s?.attempt === 1 && s?.retryAt && Math.abs(Date.parse(s.retryAt) - Date.now() - 15 * 60000) < 60000 && s?.lastResult?.walk === null, 'attempt 1, retry +15 min, no walk', JSON.stringify({ a: s?.attempt, r: s?.retryAt, w: s?.lastResult?.walk, e: s?.lastResult?.error }));
  // 4. the game finishes the next day's statements → the retry walks Day 0–6
  const newDay = new Date(nextFrom(ready, 45) - 45 * 60000 + 60000).toISOString(); // next statement time
  api['/api/v2/companies/me/income-statement/'] = { ...fx['/api/v2/companies/me/income-statement/'], date: newDay };
  await dash.evaluate(() => chrome.alarms.create('scm-accounting-walk-daily', { when: Date.now() + 300 }));
  for (let i = 0; i < 90; i++) { await new Promise(r => setTimeout(r, 1000)); s = await sch(); if (s?.lastResult?.walk) break; }
  H.check('rolled over → walk complete 7/7', s?.lastResult?.walk === 'complete' && s?.lastResult?.captured === 7 && s?.attempt === 0, 'complete 7/7', JSON.stringify(s?.lastResult));
  for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 500)); s = await sch(); if (!s?.retryAt) break; }
  a = await alarm();
  H.check('next day scheduled from the new statement time', Date.parse(s?.nextAt) === nextFrom(Date.parse(newDay), 45) && a === Date.parse(s?.nextAt), new Date(nextFrom(Date.parse(newDay), 45)).toISOString(), s?.nextAt);
  H.check('game tab back on Current', (await game.textContent('#shown')) === 'current', 'current', await game.textContent('#shown'));
  // 5. Run now
  await dash.bringToFront(); await dash.evaluate(() => document.querySelector('#accountingWalkSchedule').scrollIntoView());
  await game.bringToFront(); await dash.evaluate(() => document.querySelector('#acctWalkRunNow').click());
  let msg = ''; for (let i = 0; i < 90; i++) { await new Promise(r => setTimeout(r, 1000)); msg = await dash.textContent('#acctWalkMsg').catch(() => ''); if (/days read|not |found|Open/.test(msg)) break; }
  H.check('Run now', /7\/7 days read/.test(msg), '7/7 days read', msg);
  // 6. turn off
  await dash.bringToFront(); await dash.tap('#acctWalkEnabled'); await dash.waitForTimeout(1500);
  s = await sch(); a = await alarm();
  H.check('off clears the alarm', s?.enabled === false && a === null && s?.nextAt === null, 'off, no alarm', JSON.stringify({ e: s?.enabled, a, n: s?.nextAt }));
  const sw2 = await dash.evaluate(() => document.documentElement.scrollWidth); H.check('no horizontal scroll at 360px', sw2 <= 360, '≤360', sw2);
  const inline = await dash.evaluate(() => [...document.querySelectorAll('*')].some(e => [...e.attributes].some(x => /^on[a-z]+$/.test(x.name) && x.name in e)));
  H.check('no inline handlers', !inline, false, inline);
  await dash.evaluate(() => document.querySelector('#accountingWalkSchedule').scrollIntoView()); await H.shot(dash, 'acct-walk-schedule');
  const fits = await dash.evaluate(() => [...document.querySelectorAll('.acct-walk-row')].every(r => r.scrollWidth <= r.clientWidth + 1)); H.check('walk rows fit (no clipped text)', fits, true, fits);
  await ctx.close(); H.done();
})();
