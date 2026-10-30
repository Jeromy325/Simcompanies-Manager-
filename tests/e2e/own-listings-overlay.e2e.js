// Game-page "My listings" card at 360px: rows from scmMarketOrders:<realm>, drag + remembered position, minimise,
// close to the "Listings" pill and reopen (remembered across reloads), live update from chrome.storage.onChanged.
// FAKE GAME PAGE (blank SPA root); the listings come from seeded storage, the same shape the background writes.
const H = require('./harness');
const fs = require('fs'), path = require('path'), os = require('os');
(async () => {
  const at = new Date().toISOString();
  const orders = [
    { id: 1, kind: 18, quantity: 6486, quality: 2, price: 20, fees: 5189, seller: { id: 5294950 } },
    { id: 2, kind: 51, quantity: 263, quality: 2, price: 725, fees: 7627, seller: { id: 5294950 } },
    { id: 3, kind: 3, quantity: 1000, quality: 0, price: 1.5, fees: 60, seller: { id: 5294950 } }];
  const store = { authData: { authCompany: { realmId: 1, companyId: 5294950 } },
    vwapData: { sourceRealm: 1, fetchedAt: at, updatedAt: at, rows: [{ resourceId: 18, quality: 2, value: 19.5 }] } };
  const ctx = await H.launch();
  await H.seed(ctx, { store, extra: { 'scmMarketOrders:1': { companyId: 5294950, orders, at } } });
  await H.fakeGame(ctx, { html: '<div id="root" style="height:1600px">game</div>', api: { '/api/v2/companies/5294950/market-orders/': orders } });
  const p = await ctx.newPage();
  await p.goto('https://www.simcompanies.com/');
  await p.waitForSelector('#scm-listings-card .scm-ls-row', { timeout: 30000 }).catch(() => {});
  const rows = await p.$$eval('#scm-listings-card .scm-ls-row', rs => rs.map(r => r.querySelector('.scm-ls-name').textContent));
  H.check('one row per listing', rows.length === 3, 3, rows.length);
  H.check('sorted by total value (Car body first)', /Car body/i.test(rows[0] || ''), 'Car body …', rows[0]);
  const sum = await p.$eval('#scm-listings-card .scm-ls-sum', e => e.textContent).catch(() => '');
  H.check('summary: count and total', /3 listings/.test(sum) && /\$321,895\.00/.test(sum) && /updated/.test(sum), '3 listings · $321,895.00 · updated', sum);
  const vs = await p.$$eval('#scm-listings-card .scm-ls-vs', v => v.map(x => x.textContent).filter(Boolean));
  H.check('VWAP comparison where VWAP is cached', vs.length === 1 && /\+2\.6% vs VWAP/.test(vs[0]), '+2.6% vs VWAP', vs.join('|'));
  const box = async () => p.$eval('#scm-listings-card', e => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: innerWidth, h: innerHeight }; });
  let b = await box();
  H.check('card inside the 360px viewport', b.l >= 0 && b.r <= b.w && b.t >= 0, 'inside', JSON.stringify(b));
  const sw = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  H.check('no horizontal overflow', sw.sw <= sw.cw, `<=${sw.cw}`, sw.sw);
  fs.mkdirSync(path.join(os.tmpdir(), 'claude', 'scratch-listings'), { recursive: true });
  const out = n => path.join(os.tmpdir(), 'claude', 'scratch-listings', n);
  await p.screenshot({ path: out('listings-open-360.png') });
  // drag the header with a touch-like pointer sequence (mouse pointer; touch-action:none on the header)
  const head = await p.$eval('#scm-listings-card .scm-ls-title', e => { const r = e.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; });
  await p.mouse.move(head.x, head.y); await p.mouse.down(); await p.mouse.move(head.x - 40, head.y + 120, { steps: 6 }); await p.mouse.move(head.x - 2000, head.y + 5000, { steps: 4 }); await p.mouse.up();
  b = await box();
  H.check('drag clamps to the viewport', b.l >= 0 && b.b <= b.h + 0.5 && b.r <= b.w + 0.5, 'inside', JSON.stringify(b));
  const saved = await p.evaluate(() => localStorage.getItem('scmCardPos:scm-listings-card'));
  H.check('position remembered', !!saved, 'scmCardPos saved', saved);
  // minimise → header only, remembered
  await p.click('#scm-listings-card [data-scm-min]');
  let hidden = await p.$$eval('#scm-listings-card .scm-ls-row', rs => rs.every(r => getComputedStyle(r).display === 'none'));
  H.check('minimise hides the rows', hidden, true, hidden);
  await p.reload(); await p.waitForSelector('#scm-listings-card', { timeout: 20000 }).catch(() => {});
  await p.waitForTimeout(800);
  const min = await p.$eval('#scm-listings-card', e => e.classList.contains('scm-card-min')).catch(() => null);
  H.check('minimised state kept after reload', min === true, true, min);
  const b2 = await box().catch(() => null);
  H.check('moved position kept after reload', b2 && saved && Math.abs(b2.l - JSON.parse(saved).x) < 2, JSON.parse(saved || '{}').x, b2 && b2.l);
  await p.click('#scm-listings-card [data-scm-min]');
  // close → pill; remembered; tap pill reopens
  await p.click('#scm-listings-card .scm-ls-close');
  const pill = await p.$eval('#scm-listings-pill', e => { const r = e.getBoundingClientRect(); return { t: e.textContent, w: r.width, h: r.height, r: r.right, vw: innerWidth }; }).catch(() => null);
  H.check('× closes to a small pill', pill && !(await p.$('#scm-listings-card')) && pill.w < 120 && pill.h < 40 && pill.r <= pill.vw, 'pill < 120x40', JSON.stringify(pill));
  await p.screenshot({ path: out('listings-pill-360.png') });
  await p.reload(); await p.waitForSelector('#scm-listings-pill', { timeout: 20000 }).catch(() => {});
  await p.waitForTimeout(800);
  H.check('closed state kept after reload', !!(await p.$('#scm-listings-pill')) && !(await p.$('#scm-listings-card')), 'pill only', !!(await p.$('#scm-listings-card')));
  await p.tap('#scm-listings-pill');
  await p.waitForSelector('#scm-listings-card .scm-ls-row', { timeout: 10000 }).catch(() => {});
  H.check('tap on the pill reopens the card', !!(await p.$('#scm-listings-card')) && !(await p.$('#scm-listings-pill')), 'card', !!(await p.$('#scm-listings-card')));
  // live update: a new listing written to storage shows without a reload
  const sw2 = await H.worker(ctx);
  await sw2.evaluate(async o => { await chrome.storage.local.set({ 'scmMarketOrders:1': { companyId: 5294950, orders: o, at: new Date().toISOString() } }); },
    [...orders, { id: 4, kind: 18, quantity: 10, quality: 3, price: 25, fees: 10 }]);
  await p.waitForFunction(() => document.querySelectorAll('#scm-listings-card .scm-ls-row').length === 4, null, { timeout: 8000 }).catch(() => {});
  const n4 = await p.$$eval('#scm-listings-card .scm-ls-row', rs => rs.length);
  H.check('live update from storage', n4 === 4, 4, n4);
  await p.screenshot({ path: out('listings-reopened-360.png') });
  console.log('screenshots ' + out('listings-*-360.png'));
  await ctx.close(); H.done();
})().catch(e => { console.error(e); process.exitCode = 1; });
