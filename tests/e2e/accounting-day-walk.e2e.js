// 2.5.370: after Sync the Manager walks the game's Accounting page (Day → days 0–6) and captures each day's
// statements; Last 7 days shows them. Fake game page reproduces the game's period-bar structure (label + 4 mode
// buttons + 14 day buttons, GamePages Bfr) with the user's real day/0–6 responses. Seeded with the storage export
// in SCM_STORAGE_EXPORT. FAIL_DAY=<n> makes that day's tap do nothing (partial walk).
const H = require('./harness'); const fs = require('fs'); const path = require('path');
(async () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'r2-accounting-day-walk-2026-10-25.json'), 'utf8'));
  const failDay = process.env.FAIL_DAY != null ? Number(process.env.FAIL_DAY) : -1;
  const exp = JSON.parse(fs.readFileSync(process.env.SCM_STORAGE_EXPORT, 'utf8')).storage;
  const ctx = await H.launch(); const sw = await H.worker(ctx);
  await sw.evaluate(async s => { await chrome.storage.local.clear(); await chrome.storage.local.set(s); }, exp);
  const api = {}; for (const [k, v] of Object.entries(fx)) if (/\/day\/\d+\/$/.test(k)) api[k] = v;
  const html = `<div id="acc"><div class="bar"><label>Period</label><div><button>Current</button><button id="dayMode">Day</button><button>Week</button><button>Month</button></div></div><p id="shown">current</p></div>
<script>(function(){const bar=document.querySelector('.bar');const load=n=>{['income-statement','cashflow-statement','balance-sheet'].forEach(k=>fetch('/api/v2/companies/me/'+k+'/day/'+n+'/'));document.getElementById('shown').textContent='day '+n;};
document.getElementById('dayMode').addEventListener('click',()=>{if(bar.children[2])return;const g=document.createElement('div');for(let c=0;c<14;c++){const b=document.createElement('button');b.textContent=(10)+'/'+(25-c);b.addEventListener('click',()=>{if(c!==${failDay})load(c);});g.appendChild(b);}bar.appendChild(g);load(0);});
bar.children[1].children[0].addEventListener('click',()=>{document.getElementById('shown').textContent='current';});})();</script>`;
  await H.fakeGame(ctx, { html, api: {}, delays: {} });
  // serve the day statements (fakeGame only pre-fetches its api map; add these routes on top, with a slow-phone delay)
  await ctx.route(/\/api\/v2\/companies\/me\/(income-statement|cashflow-statement|balance-sheet)\/day\/\d+\/$/, async route => {
    const p = new URL(route.request().url()).pathname; await new Promise(r => setTimeout(r, 1200));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(api[p] ?? {}) });
  });
  const game = await ctx.newPage(); await game.goto('https://www.simcompanies.com/headquarters/accounting/'); await game.waitForTimeout(4000);
  const id = new URL(sw.url()).host; const dash = await ctx.newPage(); await dash.goto(`chrome-extension://${id}/dashboard.html`); await dash.waitForTimeout(1500);
  await game.bringToFront();
  await dash.evaluate(() => chrome.alarms.create('scm-accounting-day-walk-r1', { when: Date.now() + 300 }));
  let st = null; for (let i = 0; i < 120; i++) { await new Promise(r => setTimeout(r, 1000)); st = await sw.evaluate(async () => (await chrome.storage.local.get('scmRealmStore:1'))['scmRealmStore:1']?.accountingDayWalkStatus || null); if (st && !['scheduled', 'running'].includes(st.status)) break; }
  const expectOk = failDay < 0 ? 7 : 6;
  H.check('walk status', st?.status === (failDay < 0 ? 'complete' : 'partial'), failDay < 0 ? 'complete' : 'partial', `${st?.status} ${st?.error || ''}`);
  H.check('days captured', st?.captured === expectOk, expectOk, st?.captured);
  if (failDay >= 0) H.check('failed day named', st?.days?.find(d => d.day === failDay)?.ok === false, `day ${failDay} not ok`, JSON.stringify(st?.days?.find(d => d.day === failDay)));
  const ep = await sw.evaluate(async () => (await chrome.storage.local.get('scmRealmStore:1'))['scmRealmStore:1']?.endpointData || {});
  const got = [0, 1, 2, 3, 4, 5, 6].filter(n => ep[`/api/v2/companies/me/income-statement/day/${n}/`]?.captureRealm === 1 && ep[`/api/v2/companies/me/income-statement/day/${n}/`]?.data?.isComputed);
  H.check('day statements filed under R2', got.length >= expectOk, `${expectOk}+`, got.join(','));
  H.check('game tab back on Current', (await game.textContent('#shown')) === 'current', 'current', await game.textContent('#shown'));
  await dash.bringToFront(); await dash.reload(); await dash.waitForTimeout(2500);
  await dash.click('button.tab[data-tab="accounting"]'); await dash.waitForTimeout(1500);
  const head = await dash.textContent('[data-collapse="acct:history"] h3');
  H.check('heading Last 7 days', /Last 7 days/.test(head), 'Last 7 days', head);
  const rows = await dash.$$eval('#accountingHistory .acct-day', ds => ds.map(d => d.textContent.replace(/\s+/g, ' ').trim()));
  H.check('7 day rows', rows.length === 7, 7, rows.length);
  const withStmt = rows.filter(r => /Operating expenses/.test(r)).length;
  H.check('rows with game Day statement', withStmt >= expectOk, `${expectOk}+`, withStmt);
  // game screen values, day/2 (10/22): from the user's captured statement
  const d2 = fx['/api/v2/companies/me/income-statement/day/2/'];
  const fmt = v => (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const opex2 = d2.constructionCosts + d2.salariesCosts + d2.trainingCosts + d2.poachingCosts + d2.marketFees;
  const want2 = `Sales${fmt(d2.sales)}Operating expenses${fmt(opex2)}Net income${fmt(d2.netIncome)}`;
  H.check('Oct 22 row = game day/2 statement', failDay === 2 || (rows[2] || '').replace(/\s/g, '').includes(want2.replace(/\s/g, '')), want2, rows[2]);
  // wait for the final note (not the "Reading…" running state) instead of relying on the fixed pauses above
  await dash.waitForFunction(() => { const n = document.querySelector('.acct-walk-note'); return n && !/^Reading/.test(n.textContent.trim()); }, null, { timeout: 15000 }).catch(() => {});
  const note = await dash.textContent('.acct-walk-note').catch(() => '');
  H.check('walk note', failDay < 0 ? /Day statements 0–6 read/.test(note) : /6\/7.*missing day/.test(note), failDay < 0 ? 'Day statements 0–6 read' : '6/7 … missing day', note);
  const sw2 = await dash.evaluate(() => document.documentElement.scrollWidth); H.check('no horizontal scroll at 360px', sw2 <= 360, '≤360', sw2);
  await dash.evaluate(() => document.querySelector('#accountingHistory').scrollIntoView()); await H.shot(dash, `acct-7days${failDay >= 0 ? '-fail' : ''}`);
  await ctx.close(); H.done();
})();
