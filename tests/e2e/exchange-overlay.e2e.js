// Exchange overlay badge (.scx-vwap-badge) at 360px.
// FAKE DOM INFERRED FROM SCREENSHOTS, NOT THE LIVE SITE. The rows are div.row (a selector content.js
// scans: 'tbody tr, tr, div.row'); the real game's row markup is unverified, see the second page below.
// Layout: logo, company (truncated), "2 ★", quantity, price + badge slot; Buy panel under the list.
const H = require('./harness');
const fs = require('fs');
(async () => {
  const now = new Date().toISOString(), RID = 3;
  // Listing 2 star, 2000 units at $20.50; cheapest other Q2+ listing is $20.00 -> +2.5%, VWAP Q2 19.77.
  const book = [
    { id: 11, price: 20.5, quality: 2, quantity: 2000, seller: { company: 'Long Company Name Holdings International' } },
    { id: 12, price: 20.0, quality: 2, quantity: 500, seller: { company: 'Base Metals Inc' } },
    { id: 13, price: 21.0, quality: 3, quantity: 138369, seller: { company: 'Third Seller' } }];
  const store = {
    authData: { authCompany: { realmId: 1, companyId: 5294950 } },
    endpointData: { [`/api/v3/market/1/${RID}/`]: { status: 200, receivedAt: now, data: book } },
    vwapData: { sourceRealm: 1, fetchedAt: now, updatedAt: now, rows: [{ resourceId: RID, quality: 2, value: 19.77 }, { resourceId: RID, quality: 3, value: 20.5 }] },
    warehouseResources: [] };
  const row = (cls, co, q, qty, price) => `<div class="${cls}" style="display:flex;align-items:center;gap:6px;padding:8px;border-bottom:1px solid #444;box-sizing:border-box;width:100%"><span style="width:24px;height:24px;background:#555;flex:none"></span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${co}</span><span style="flex:none">${q} ★</span><span style="flex:none">${qty}</span><span style="flex:none;text-align:right">$${price}</span></div>`;
  const page = rowCls => `<div style="padding:8px"><a href="#">Resources</a> <b>Aluminium</b> ? &lt;&lt; &gt;&gt;</div>`
    + row(rowCls, 'Long Company Name Holdings International', 2, '2,000', '20.500')
    + row(rowCls, 'Base Metals Inc', 2, '500', '20.000')
    + `<div style="padding:8px"><input value="0" style="width:60px"> <button>BUY</button> <button style="background:#c33">swap</button></div>`;
  const ctx = await H.launch();
  await H.seed(ctx, { store });
  await H.fakeGame(ctx, { html: page('row'), api: { [`/api/v3/market/1/${RID}/`]: book } });
  const p = await ctx.newPage();
  await p.goto(`https://www.simcompanies.com/market/resource/${RID}/`);
  await p.waitForSelector('.scx-vwap-badge', { timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(1000);
  const badges = await p.$$eval('.scx-vwap-badge', bs => bs.map(b => { const r = b.getBoundingClientRect(), row = b.closest('.row').getBoundingClientRect(); return { t: b.textContent, inRow: r.left >= row.left && r.right <= row.right + 0.5 }; }));
  H.check('one badge per listing (div.row)', badges.length === 2, 2, badges.length);
  const first = badges.find(b => /Expensive/.test(b.t));
  H.check('badge text Expensive +2.5% and Q2', /Expensive \+2\.5%/.test(first?.t || '') && /Q2/.test(first?.t || ''), 'Expensive +2.5% · Q2', first?.t);
  H.check('badge inside row', badges.every(b => b.inRow), true, badges.map(b => b.inRow).join(','));
  const sw = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  H.check('no horizontal overflow at 360px', sw.sw <= sw.cw, `<=${sw.cw}`, sw.sw);
  await p.tap('.scx-vwap-badge >> nth=0');
  await p.waitForSelector('.scx-vwap-popover', { state: 'visible', timeout: 3000 }).catch(() => {});
  const pop = await p.$$eval('.scx-vwap-popover', ps => ps.filter(x => x.style.display === 'block').map(x => x.textContent));
  H.check('popover shown', pop.length === 1, 1, pop.length);
  H.check('popover rows', /Listing price/.test(pop[0] || '') && /Net after 4% fee/.test(pop[0] || ''), 'Listing price + Net after 4% fee', pop[0]);
  const f = await H.shot(p, 'exchange-overlay-360');
  const scratch = '/tmp/claude-0/-home-user-Simcompanies-Manager-/f6ee1197-65aa-59bc-88e0-d7b58d5a81f0/scratchpad/exchange-overlay-360.png';
  try { fs.copyFileSync(f, scratch); console.log('screenshot ' + scratch); } catch { console.log('screenshot ' + f); }
  // Informational only: same listings in plain <div> rows (no class "row", no td) are not scanned.
  await p.evaluate(h => { document.body.innerHTML = h; }, page('card'));
  await p.waitForTimeout(1500);
  console.log('INFO plain div.card rows -> badges:', await p.$$eval('.scx-vwap-badge', b => b.length));
  await ctx.close(); H.done();
})().catch(e => { console.log('FAIL exception', e.message); process.exitCode = 1; });
