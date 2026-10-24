// 2.5.362: compact incoming-contract badge (vs market price, VWAP fallback) + details popup, 360 px.
const H = require('./harness');
(async () => {
  const now = new Date().toISOString();
  const incoming = [
    { id: 1, kind: 51, quality: 1, quantity: 20100, price: 4.7, seller: { company: 'ZENGO MOTORS' } },
    { id: 2, kind: 52, quality: 4, quantity: 191, price: 590, seller: { company: 'RIX ROAD REFURBISHES' } }];
  const book = [{ id: 9, price: 5.0, quality: 1, quantity: 1000 }];
  const store = {
    authData: { authCompany: { realmId: 1, companyId: 5294950 } },
    endpointData: {
      '/api/v3/contracts-incoming/1/me/': { status: 200, receivedAt: now, data: incoming },
      '/api/v3/market/1/51/': { status: 200, receivedAt: now, data: book } },
    liveMarketPriceData: { realm: 1, rows: [{ resourceId: 51, quality: 1, price: 5.0 }] },
    vwapData: { sourceRealm: 1, rows: [{ resourceId: 52, quality: 4, vwap: 690 }] },
    warehouseResources: [] };
  const card = (img, co, qty, price, total) => `<div class="c" style="padding:8px;border-bottom:1px solid #444"><div>${img}</div><h3>${co}</h3><div>${qty} @ <b>${price}</b></div><div style="display:flex;justify-content:space-between"><span>3 days ago <b>${total}</b></span><button>ACCEPT</button></div></div>`;
  const html = `<h2>Incoming contracts</h2>${card('[img]', 'ZENGO MOTORS', '20,100', '$4.700', '$94,470')}${card('[img]', 'RIX ROAD REFURBISHES', '191', '$590.000', '$112,690')}`;
  const ctx = await H.launch();
  await H.seed(ctx, { store });
  await H.fakeGame(ctx, { html, api: { '/api/v3/contracts-incoming/1/me/': incoming, '/api/v3/market/1/51/': book } });
  const page = await ctx.newPage();
  let accepted = 0; await page.exposeFunction('scmAccepted', () => { accepted++; });
  await page.goto('https://www.simcompanies.com/headquarters/warehouse/incoming-contracts/');
  await page.evaluate(() => document.querySelectorAll('.c').forEach(c => c.addEventListener('click', () => window.scmAccepted())));
  await page.waitForSelector('.scm-contract-vwap-badge', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const badges = await page.$$eval('.scm-contract-vwap-badge', bs => bs.map(b => { const r = b.getBoundingClientRect(), c = b.closest('.c').getBoundingClientRect(); return { t: b.textContent, cls: b.className, h: Math.round(r.height), inCard: r.left >= c.left && r.right <= c.right }; }));
  const z = badges.find(b => /market/.test(b.t)), r = badges.find(b => /VWAP/.test(b.t));
  H.check('badge count', badges.length === 2, 2, badges.length);
  H.check('Zengo compact text', z?.t === '▼ 6.00% below market price ⓘ', '▼ 6.00% below market price ⓘ', z?.t);
  H.check('Zengo green', /cheap/.test(z?.cls || ''), 'cheap', z?.cls);
  H.check('Rix VWAP fallback text', r?.t === '▼ 14.49% below VWAP ⓘ', '▼ 14.49% below VWAP ⓘ', r?.t);
  H.check('badges one line (h≤20px)', badges.every(b => b.h <= 20), '≤20', badges.map(b => b.h).join(','));
  H.check('badges inside card width', badges.every(b => b.inCard), true, badges.map(b => b.inCard).join(','));
  await H.shot(page, 'incoming-compact');
  await page.tap('.scm-contract-vwap-badge >> nth=0');
  await page.waitForSelector('#scm-contract-detail-pop', { timeout: 3000 }).catch(() => {});
  const rows = await page.$$eval('#scm-contract-detail-pop .scm-cdp-row', rs => rs.map(r => r.textContent));
  const all = rows.join(' | ');
  H.check('popup title', (await page.textContent('#scm-contract-detail-pop .scm-cdp-title').catch(() => '')) === 'ZENGO MOTORS', 'ZENGO MOTORS', '');
  H.check('popup contract line', /20,100 @ \$4\.700 \(\$94,470\.00\)/.test(all), '20,100 @ $4.700 ($94,470.00)', rows[0]);
  H.check('popup market', /Market price\$5\.000/.test(all), '$5.000', rows[1]);
  H.check('popup exchange saving', /saves \$0\.300\/u vs exchange \$5\.000 \(\$6,030\.00\)/.test(all), 'saves $0.300/u … ($6,030.00)', rows[3]);
  H.check('tap did not reach game card', accepted === 0, 0, accepted);
  const popBox = await page.$eval('#scm-contract-detail-pop .scm-cdp-card', e => { const b = e.getBoundingClientRect(); return b.left >= 0 && b.right <= 360; });
  H.check('popup fits 360px', popBox, true, popBox);
  await H.shot(page, 'incoming-popup');
  await page.tap('#scm-contract-detail-pop .scm-cdp-close');
  H.check('× closes popup', !(await page.$('#scm-contract-detail-pop')), 'closed', (await page.$('#scm-contract-detail-pop')) ? 'open' : 'closed');
  await page.tap('.scm-contract-vwap-badge >> nth=1');
  const vr = await page.$$eval('#scm-contract-detail-pop .scm-cdp-row', rs => rs.map(r => r.textContent).join(' | ')).catch(() => '');
  H.check('Rix popup VWAP + no book', /VWAP \(no market price\)\$690\.000/.test(vr) && /order book not captured yet/.test(vr), 'VWAP $690 / no book', vr);
  await page.mouse.click(10, 10);
  H.check('tap outside closes', !(await page.$('#scm-contract-detail-pop')), 'closed', (await page.$('#scm-contract-detail-pop')) ? 'open' : 'closed');
  await ctx.close(); H.done();
})().catch(e => { console.log('FAIL exception', e.message); process.exitCode = 1; });
