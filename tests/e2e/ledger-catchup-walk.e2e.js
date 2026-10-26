// 2.5.388 Daily Accounting walk also catches up the ledger: from the fresh cashflow/recent page it walks
// /cashflow/<oldest id>/ back only until a page reaches time the archive already holds. 150 rows over the last 24 h
// (30 per page), archive holding everything before that → expect 5 cursor pages (the 5th overlaps the archive:
// that overlap proves there is no hole), all 150 rows archived, one span.
const H = require('./harness'); const fs = require('fs'); const path = require('path');
const A = require('../../analyze-core.js');
(async () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'r2-accounting-day-walk-2026-10-25.json'), 'utf8'));
  const { storage: exp } = require('./mock-export').loadExport({ days: false });
  const now = Date.now(), MIN = 6e4, rows = [];
  // 200 fills, one every ~9.6 min: the oldest 50 are already archived (span up to 24 h ago), the newest 150 are not.
  for (let i = 0; i < 200; i++) { const t = now - 5 * MIN - (199 - i) * 9.6 * MIN; rows.push({ id: 7000 + i, datetime: new Date(t).toISOString(), category: 'm', descriptionKey: 'marketfilled-17', money: 1000, details: { resource: 17, quality: 3, amount: 100, price: 10, profit: 300, buyer: 'B' } }); }
  const desc = [...rows].reverse(), page = list => ({ data: list.slice(0, 30) });
  const old = desc.slice(150), oldPage = { data: old }; // pretend one earlier capture proved this stretch
  const { added, ...arc } = A.archiveMerge(null, '/api/v2/companies/me/cashflow/recent/', old, new Date(Date.parse(old[0].datetime) + 1000).toISOString(), now);
  exp['scmLedgerArchive:1'] = arc; exp.scmLedgerArchiveSeededV2 = true;
  const ctx = await H.launch(); const sw = await H.worker(ctx);
  await require('./mock-export').seedExport(sw, exp);
  const api = {}; for (const [k, v] of Object.entries(fx)) if (!/\/day\/\d+\/$/.test(k) && !/cashflow\/(recent|\d+)\/$/.test(k)) api[k] = v;
  const html = `<div class="bar"><label>Period</label><div><button>Current</button><button id="dayMode">Day</button><button>Week</button><button>Month</button></div></div><p id="shown">current</p>
<script>(function(){const bar=document.querySelector('.bar');const load=n=>{['income-statement','cashflow-statement','balance-sheet'].forEach(k=>fetch('/api/v2/companies/me/'+k+'/day/'+n+'/'));document.getElementById('shown').textContent='day '+n;};
document.getElementById('dayMode').addEventListener('click',()=>{if(bar.children[2]){load(0);return;}const g=document.createElement('div');for(let c=0;c<14;c++){const b=document.createElement('button');b.textContent='d'+c;b.addEventListener('click',()=>load(c));g.appendChild(b);}bar.appendChild(g);load(0);});
bar.children[1].children[0].addEventListener('click',()=>{document.getElementById('shown').textContent='current';});})();</script>`;
  await H.fakeGame(ctx, { html, api });
  await ctx.route(/\/api\/v2\/companies\/me\/(income-statement|cashflow-statement|balance-sheet)\/day\/\d+\/$/, async route => { const p = new URL(route.request().url()).pathname; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fx[p] ?? {}) }); });
  const cursorHits = [];
  await ctx.route(/\/api\/v2\/companies\/me\/cashflow\/(recent|\d+)\/$/, async route => {
    const m = new URL(route.request().url()).pathname.match(/cashflow\/(recent|\d+)\/$/);
    let body;
    if (m[1] === 'recent') body = page(desc);
    else { cursorHits.push(m[1]); const i = desc.findIndex(r => String(r.id) === m[1]); body = page(desc.slice(i + 1)); }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const game = await ctx.newPage(); await game.goto('https://www.simcompanies.com/headquarters/accounting/'); await game.waitForTimeout(4000);
  const id = new URL(sw.url()).host; const dash = await ctx.newPage(); await dash.goto(`chrome-extension://${id}/dashboard.html`); await dash.waitForTimeout(2000);
  await game.bringToFront();
  const r = await dash.evaluate(() => chrome.runtime.sendMessage({ type: 'RUN_ACCOUNTING_WALK_NOW', realm: 1 }));
  H.check('walk ran and read 7 days', r?.captured === 7, 7, r?.captured);
  H.check('ledger caught up', r?.ledger === 'caught-up', 'caught-up', r?.ledger);
  H.check('cursor pages fetched = 5 (4 new + 1 overlap)', cursorHits.length === 5 && r?.ledgerPages === 5, 5, `${cursorHits.length} hits, ${r?.ledgerPages} reported`);
  await new Promise(x => setTimeout(x, 1500));
  const a = await sw.evaluate(async () => (await chrome.storage.local.get('scmLedgerArchive:1'))['scmLedgerArchive:1']);
  H.check('archive holds all 200 rows', Object.keys(a?.rows || {}).length === 200, 200, Object.keys(a?.rows || {}).length);
  H.check('archive = one continuous span', a?.spans?.length === 1, 1, JSON.stringify(a?.spans?.length));
  // Second run the same day: the recent page is now inside the archive → no cursor pages.
  const before = cursorHits.length;
  const r2 = await dash.evaluate(() => chrome.runtime.sendMessage({ type: 'RUN_ACCOUNTING_WALK_NOW', realm: 1 }));
  H.check('second run: 0 ledger pages', r2?.ledgerPages === 0 && cursorHits.length === before, 0, `${r2?.ledgerPages} reported, ${cursorHits.length - before} hits`);
  await dash.bringToFront(); await dash.click('button.tab[data-tab="accounting"]'); await dash.waitForTimeout(1200);
  await dash.evaluate(() => { const c = document.querySelector('[data-collapse="acct:walk"]'); c?.scrollIntoView(); c?.querySelector('[data-collapse-head]')?.click(); }); await dash.waitForTimeout(400);
  await game.bringToFront(); await dash.evaluate(() => document.querySelector('#acctWalkRunNow').click());
  let msg = ''; for (let i = 0; i < 90; i++) { await new Promise(x => setTimeout(x, 1000)); msg = await dash.textContent('#acctWalkMsg').catch(() => ''); if (/days read|not |found|Open/.test(msg)) break; }
  H.check('Run now message shows ledger pages', /7\/7 days read · ledger 0 pages\./.test(msg), '7/7 days read · ledger 0 pages.', msg);
  await dash.bringToFront(); await H.shot(dash, 'ledger-catchup-walk');
  const w = await dash.evaluate(() => document.documentElement.scrollWidth); H.check('no h-scroll at 360px', w <= 360, '≤360', w);
  await ctx.close(); H.done();
})().catch(e => { console.error(e); process.exit(1); });
