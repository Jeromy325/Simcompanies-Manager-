// 2.5.383 Analyze tab at 360 px. Seeded with the user's real R2 responses from tests/fixtures (ledger, day statements,
// past finances, balance sheet), the real warehouse lots of the profit-calc fixture, real game constants, plus a
// Bulldozer Q3 lot and input lots at the spec's check-figure costs (Steel 9.45, Car body 655.27, Engine 483.75).
// Checks every page renders, figures follow the formulas, the fee comes from the ledger, 0 network calls, no h-scroll.
const H = require('./harness'); const fs = require('fs'), path = require('path');
const FX = f => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', f), 'utf8'));
(async () => {
  const { storage } = require('./mock-export').loadExport({ days: true });
  const pc = FX('profit-calc-2026-10-24.json'), gc = FX('game-constants-full-2026-10-24.json');
  const lot = (id, kind, quality, amount, cost, materials = []) => ({ id, kind, quality, amount, blocked: false, datetime: '2026-10-24T10:00:00+00:00', materials, cost: { admin: 0, market: 0, material1: 0, material2: 0, material3: 0, material4: 0, material5: 0, workers: 0, ...cost } });
  const store = storage['scmRealmStore:1'];
  store.authData.temporals = { economyState: 1 };
  store.warehouseResources = [...pc.warehouseLots,
    lot(9001, 43, 2, 1000, { market: 9450 }), lot(9002, 51, 2, 10, { market: 6552.7 }), lot(9003, 52, 2, 20, { market: 9675 }),
    lot(9004, 112, 3, 12, { material1: 453.6, material2: 7863.24, material3: 11610, workers: 819.54, admin: 273.3 }, ['Steel', 'Car body', 'Combustion engine']),
    lot(9005, 45, 2, 3000, { workers: 21000, admin: 6000, material1: 3000 }, ['Sand']),
    lot(9006, 13, 0, 500, { market: 150 })]; // 2.5.394 Transport at $0.30 a unit (your lot)
  const at = new Date().toISOString();
  store.vwapData = { updatedAt: at, rows: [{ resourceId: 112, quality: 3, value: 2260 }, { resourceId: 45, quality: 2, value: 13.9 }, { resourceId: 43, quality: 2, value: 11.5 }, { resourceId: 21, quality: 2, value: 52 }, { resourceId: 16, quality: 2, value: 8.6 }, { resourceId: 17, quality: 3, value: 14.2 }] };
  const d = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  store.history = { '112:3': [9, 8, 7, 6, 5, 4, 3, 2, 1].map((n, i) => ({ date: d(n), vwap: 2190 + i * 8 })) };
  const runs = [6, 4, 2, 0.5].map((n, i) => ({ k: `77|${n}`, b: 77, bn: 'Factory', id: 45, q: 2, c: 10 + i * 0.25, t: new Date(Date.now() - n * 864e5).toISOString(), n: 1000 }));
  storage.scmGameConstants = { core: gc.core, buildings: gc.buildings, resources: gc.resources };
  storage['scmProductionCostHistory:1'] = runs;
  // 2.5.385 Analyze counts only runs from this realm's own buildings, so the runs' Factory (#77) must be in the store.
  store.buildings = [...(Array.isArray(store.buildings) ? store.buildings : []), { id: 77, kind: 'N', name: 'Factory' }];

  const ctx = await H.launch(); const sw = await H.worker(ctx);
  await require('./mock-export').seedExport(sw, storage);
  const id = new URL(sw.url()).host; const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(`chrome-extension://${id}/dashboard.html`); await page.waitForTimeout(2500);
  const tabs = await page.$$eval('nav .tab', b => b.map(x => x.dataset.tab));
  H.check('Analyze tab sits right after Tools', tabs.indexOf('analyze') === tabs.indexOf('tools') + 1, 'after tools', tabs.join(','));
  // Count network-capable calls made by Analyze code itself (its render and its click handlers). The dashboard's own
  // background refreshes (SimcoTools prices, resource images) run on every tab and are not Analyze's.
  await page.evaluate(() => {
    window.__anNet = []; const wrap = (o, k) => { const f = o[k]; o[k] = function (...a) { if (window.__anIn) window.__anNet.push(`${k} ${String(a[0]?.type || a[0]).slice(0, 80)}`); return f.apply(this, a); }; };
    wrap(window, 'fetch'); wrap(XMLHttpRequest.prototype, 'open'); wrap(chrome.runtime, 'sendMessage');
    const U = globalThis.SCM_ANALYZE_UI, r = U.render; U.render = function (...a) { window.__anIn = true; try { return r.apply(this, a); } finally { window.__anIn = false; } };
    document.getElementById('analyzeBody').addEventListener('click', () => { window.__anIn = true; setTimeout(() => { window.__anIn = false; }, 0); }, true);
  });
  await page.click('button.tab[data-tab="analyze"]'); await page.waitForTimeout(1200);
  const body = async () => (await page.textContent('#analyzeBody').catch(() => '')) || '';
  // Main pages carry the Overview · Margins · Stock · Costs switch; detail pages only "‹ Back" (as the mockups), so
  // go back to Overview first when the target is not linked from the current page.
  const go = async p => { if (!(await page.$(`#analyzeBody [data-an-go="${p}"]`))) { if (await page.$('#analyzeBody [data-an-back]')) { await page.click('#analyzeBody [data-an-back]'); await page.waitForTimeout(200); } if (!(await page.$(`#analyzeBody [data-an-go="${p}"]`))) { await page.click('#analyzeBody [data-an-go="overview"]'); await page.waitForTimeout(200); } } await page.click(`#analyzeBody [data-an-go="${p}"]`); await page.waitForTimeout(300); };
  const noScroll = async p => { const w = await page.evaluate(() => document.documentElement.scrollWidth); H.check(`${p}: no horizontal scroll at 360px`, w <= 360, '≤360', w); };

  let t = await body();
  H.check('Overview: 6 KPI tiles', (await page.$$('#analyzeBody .an-tile')).length === 6, 6, (await page.$$('#analyzeBody .an-tile')).length);
  H.check('Overview: company value from past finances', /\$25\.74M/.test(t), '$25.74M', t.match(/Company value ›\s*([^\s]+)/)?.[1]);
  H.check('Overview: fee rate from ledger 4.00%', /4\.00% of \$67\.8k sold/.test(t), '4.00% of $67.8k sold', t.match(/[\d.]+% of \$[\d.k]+ sold/)?.[0]);
  H.check('Overview: worth-a-look list', (await page.$$('#analyzeBody .an-find')).length > 0, '>0', (await page.$$('#analyzeBody .an-find')).length);
  await noScroll('overview'); await H.shot(page, 'analyze-overview');

  await go('fees'); t = await body();
  H.check('Fees: paid = Σ paired fees ($2,717)', /\$2,717\.00/.test(t), '$2,717.00', t.match(/Fees paid · 7 days\s*\$[\d,.]+/)?.[0]);
  H.check('Fees: day statements (Sun $152k)', /\$152k/.test(t), '$152k', '');
  await noScroll('fees');

  await go('stock'); t = await body();
  const bd = await page.$eval('#analyzeBody [data-an-card="st-112:3"]', e => e.innerText).catch(() => '');
  H.check('Stock: Bulldozer Q3 cost per unit $1,751.64', /\$1,751\.64/.test(bd), '$1,751.64', bd.match(/Cost per unit\s*(\S+)/)?.[1]);
  H.check('Stock: Bulldozer Q3 cost → value $21,020 → $27,120, diff +$6,100', /\+\$6,100/.test(bd) && /\$21,020 → \$27,120/.test(bd), '+$6,100 / $21,020 → $27,120', bd.match(/\$[\d,]+ → \$[\d,]+/)?.[0]);
  const rate = 2697 / 67394; // ledger pairs of $1,000 or more
  const be = 1751.64 / (1 - rate); H.check('Stock: break-even = cost ÷ (1 − ledger fee)', bd.includes('$' + be.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')), be.toFixed(2), bd.match(/Break-even[^\n]*\n?\s*(\S+)/)?.[1]);
  await noScroll('stock'); await H.shot(page, 'analyze-stock');

  await page.click('#analyzeBody [data-an-prod="112:3"]'); await page.waitForTimeout(300); t = await body();
  H.check('Product: input names from recipe (Steel × 4, Car body × 1, Combustion engine × 2)', /Steel × 4 @ \$9\.45/.test(t) && /Car body × 1 @ \$655\.27/.test(t) && /Combustion engine × 2 @ \$483\.75/.test(t), 'Steel/Car body/Engine', (t.match(/[A-Za-z ]+ × \d+ @ \$[\d.,]+/g) || []).join(' | '));
  H.check('Product: price now $2,260 with week-ago change', /\$2,260\.00/.test(t) && /vs \$2,\d{3}\.00 a week ago/.test(t), '$2,260 + week ago', '');
  await noScroll('product'); await H.shot(page, 'analyze-product');
  await page.click('#analyzeBody [data-an-back]'); await page.waitForTimeout(300);

  await go('margins'); t = await body();
  const gl = await page.$eval('#analyzeBody [data-an-card="mg-45:2"]', e => e.innerText).catch(() => '');
  // Glass Q2: 2562 units, $34,897 gross → avg 13.6210; 2.5.394 cost = the game's cost at each sale (money − row profit),
  // weighted by units; fee = avg × rate; transport = Glass transport units (game constants) × the Transport cost shown.
  const AC = require('../../analyze-core.js'), gs = AC.salesFromLedger(AC.ledgerRows(AC.realmEndpoints(store.endpointData, 1), null)).filter(x => x.rid === 45 && x.q === 2 && x.channel === 'exchange');
  const gU = gs.reduce((a, x) => a + x.amount, 0), gCost = gs.reduce((a, x) => a + x.ledgerCost * x.amount, 0) / gU;
  const tU = Number(gc.resources['45'].transportation), tP = Number((gl.match(/− Transport \([\d.]+ units? × \$([\d.]+) your lot/) || [])[1]);
  const avg = 34897 / 2562, earned = avg - gCost - avg * rate - tU * tP;
  H.check('Margins: Glass = game cost at sale (2562 units)', gU === 2562 && gl.includes(`$${gCost.toFixed(2)}`) && /game cost at sale/.test(gl), gCost.toFixed(2), `${gU} · ${gl.match(/Cost per unit[^\n]*\n?\s*(\S+)/)?.[1]}`);
  H.check('Margins: Glass earned per unit = avg − cost − fee − transport', tP === 0.3 && gl.includes(`$${earned.toFixed(2)}`), earned.toFixed(2), gl.match(/Earned per unit\s*(\S+)/)?.[1]);
  H.check('Margins: lot cost today shown as a check', /Lot cost today \(check\)\s*\$10\.00/.test(gl), '$10.00', '');
  await noScroll('margins');

  for (const p of ['costs', 'company', 'cash', 'sales', 'routes', 'data']) { await go(p); t = await body(); H.check(`${p}: renders without error`, t.length > 200 && !/could not be built/.test(t), 'content', t.slice(0, 60)); await noScroll(p); }
  await go('costs'); t = await body(); H.check('Costs: Glass cost trend from production runs $10.00 → $10.75', /\$10\.00 → \$10\.75/.test(t), '$10.00 → $10.75', t.match(/\$[\d.]+ → \$[\d.]+/)?.[0]);
  await go('routes'); t = await body(); H.check('Routes: contract net after transport, nothing "to verify"', /Contract net/.test(t) && /− Transport \(/.test(t) && !/to verify/.test(t), true, '');
  await go('data'); t = await body(); H.check('Data: Known gaps — cost split is info, no "not confirmed"', !/not confirmed/.test(t) && /Nothing to do/.test(t) && (await page.$$('#analyzeBody .an-gapitem .an-dot-info')).length >= 1, true, '');
  await go('company'); t = await body(); H.check('Company: assets composition + EVA by week', /What the company owns/.test(t) && /EVA by week/.test(t) && /\+\$550\.4k/.test(t), '+$550.4k week', t.match(/\+\$[\d.]+k/)?.[0]);
  await go('data'); await H.shot(page, 'analyze-data');
  const open1 = await page.$eval('#analyzeBody [data-an-card="dt-src"]', e => e.open);
  await page.click('#analyzeBody [data-an-card="dt-src"] > summary'); await page.waitForTimeout(150);
  H.check('Cards collapse', open1 && !(await page.$eval('#analyzeBody [data-an-card="dt-src"]', e => e.open)), 'closed', '');
  await page.click('#analyzeBody [data-an-days="30"]'); await page.waitForTimeout(200);
  H.check('Look-back setting persists', await page.evaluate(() => localStorage.getItem('scmAnalyze:days')) === '30', '30', await page.evaluate(() => localStorage.getItem('scmAnalyze:days')));
  await go('empty'); t = await body(); H.check('First-run preview', /Not enough data yet/.test(t) && /Ready\s*3 of 4/.test(t) && /Cash-flow ledger: 0\.\d days so far/.test(t), 'Ready · 3 of 4 (ledger < 3 days)', t.match(/Ready\s*\d of \d/)?.[0]);

  const net = await page.evaluate(() => window.__anNet); H.check('0 network calls from Analyze code', net.length === 0, 0, net.join(' | '));
  H.check('no images in Analyze', (await page.$$('#analyzeBody img')).length === 0, 0, (await page.$$('#analyzeBody img')).length);
  const inline = await page.evaluate(() => [...document.querySelectorAll('#analyzeBody *')].some(e => [...e.attributes].some(a => /^on[a-z]+$/.test(a.name))));
  H.check('no inline handlers', !inline, false, inline); H.check('no page errors', !errs.length, 0, errs.join('|'));

  // Empty company: first-run state shows on its own.
  await sw.evaluate(async () => { await chrome.storage.local.clear(); await chrome.storage.local.set({ activeRealmKey: 'realm:1', selectedRealm: '1', viewRealm: 1, realmIsolationSchemaVersion: 13, scmRealmStoreSchema: 1, 'scmRealmStore:1': { endpointData: {}, authData: { authCompany: { realmId: 1, companyId: 5294950 } } } }); });
  await page.evaluate(() => localStorage.setItem('scmAnalyze:page', '"overview"')); await page.reload(); await page.waitForTimeout(2500);
  await page.click('button.tab[data-tab="analyze"]'); await page.waitForTimeout(800); t = await body();
  H.check('Empty store → first-run state', /Not enough data yet/.test(t) && /Ready\s*0 of 4/.test(t), 'Ready · 0 of 4', t.match(/Ready\s*\d of \d/)?.[0]);
  await H.shot(page, 'analyze-empty'); await noScroll('empty');
  await ctx.close(); H.done();
})();
