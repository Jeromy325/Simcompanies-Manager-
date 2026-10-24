// 2.5.363/364: Production planner "Building Type" test override (Power Plant → Car Factory → Truck) + Reset, 360 px.
const H = require('./harness');
(async () => {
  const now = new Date().toISOString();
  const buildings = [
    { id: 111, kind: 'E', name: 'Power Plant', size: 3, category: 'production', busy: { resource: { kind: 1, name: 'Power', quality: 2, amount: 3000 }, started: now, duration: 3600 } },
    { id: 222, kind: 'W', name: 'Water Reservoir', size: 2, category: 'production' }];
  const store = { authData: { authCompany: { realmId: 1, companyId: 5294950 } },
    endpointData: { '/api/v2/companies/me/buildings/': { status: 200, receivedAt: now, data: buildings } }, warehouseResources: [] };
  const ctx = await H.launch();
  await (await H.worker(ctx)).evaluate(() => new Promise(r => setTimeout(r, 2500))); // let onInstalled finish first
  await H.seed(ctx, { store });
  const sw = await H.worker(ctx); const id = new URL(sw.url()).host;
  const page = await ctx.newPage(); global.__p = page;
  page.on('pageerror', e => console.log('pageerror', e.message));
  await page.goto(`chrome-extension://${id}/dashboard.html`);
  await page.click('button.tab[data-tab="production"]');
  await page.waitForSelector('#buildingKind', { timeout: 20000 });
  await page.click('.owned-building-card[data-building-id="111"]'); await page.waitForTimeout(800);
  const opt0 = await page.$eval('#buildingKind', s => s.selectedOptions[0].textContent);
  H.check('default = game kind', opt0 === 'Game: Power Plant', 'Game: Power Plant', opt0);
  H.check('no reset before change', !(await page.$('#plannerResetBuilding')), 'none', (await page.$('#plannerResetBuilding')) ? 'shown' : 'none');
  await page.selectOption('#buildingKind', '1'); await page.waitForTimeout(1200);
  const h3 = await page.textContent('.planner-main-card h3');
  H.check('hero now Car Factory', h3 === 'Car Factory', 'Car Factory', h3);
  const prods = await page.$$eval('#buildingProduct option', o => o.map(x => x.value));
  H.check('product list = Car Factory produces', prods.includes('Truck') && !prods.includes('Power'), 'has Truck, no Power', prods.join(','));
  const badge = await page.textContent('.owned-building-card[data-building-id="111"] .owned-building-test').catch(() => '');
  const cardOut = () => page.textContent('.owned-building-card[data-building-id="111"] .owned-building-output');
  H.check('card TEST badge', badge === 'TEST · was Power Plant', 'TEST · was Power Plant', badge);
  const vis = await page.$eval('#buildingOutput', e => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 100 && r.height > 25 && cs.opacity === '1' && r.right <= 360; });
  H.check('Output dropdown visible at 360', vis, true, vis);
  const groups = await page.$$eval('#buildingKind optgroup', g => g.map(x => x.label));
  H.check('building types grouped by category', groups.length >= 8 && groups.includes('Automotive'), '≥8 incl Automotive', groups.join(','));
  const optColor = await page.$eval('#buildingKind option:nth-child(1)', o => getComputedStyle(o).color);
  H.check('option text colour set', optColor === 'rgb(231, 237, 245)', 'rgb(231, 237, 245)', optColor);
  await page.selectOption('#buildingOutput', 'Truck'); await page.waitForTimeout(1200);
  await page.selectOption('#buildingLevel', '5'); await page.waitForTimeout(1200);
  const out = await page.textContent('.planner-output-product strong');
  H.check('output = Truck', out === 'Truck', 'Truck', out);
  const co = await cardOut(); H.check('card output Truck', /Truck/.test(co), 'Truck', co);
  const inputs = await page.$$eval('.planner-main-card table tbody tr', r => r.length).catch(() => 0);
  H.check('Truck inputs listed (5 materials)', inputs === 5, 5, inputs);
  const lvl = await page.textContent('.planner-selected-line');
  H.check('planning level 5 kept', /Planning Level: 5/.test(lvl), 'Planning Level: 5', lvl);
  const saved = await sw.evaluate(async () => (await chrome.storage.local.get(null)));
  const pst = JSON.stringify(saved).match(/"kindOverrides":\{[^}]*\}/g) || [];
  H.check('kindOverride persisted (realm 1)', pst.some(x => x.includes('"111":"1"')), '"111":"1"', pst.join(' '));
  // survives a reload
  await page.reload(); await page.click('button.tab[data-tab="production"]'); await page.waitForSelector('#buildingKind', { timeout: 20000 }); await page.waitForTimeout(800);
  const after = await page.$eval('#buildingKind', s => s.value), outAfter = await page.textContent('.planner-output-product strong');
  H.check('after reload still Car Factory/Truck', after === '1' && outAfter === 'Truck', '1/Truck', `${after}/${outAfter}`);
  await H.shot(page, 'planner-test-kind'); await page.$eval('.planner-main-card', e => e.scrollIntoView()); await H.shot(page, 'planner-test-controls');
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= 360);
  H.check('no horizontal page scroll at 360', fits, true, fits);
  // Reset
  await page.click('#plannerResetBuilding'); await page.waitForTimeout(1500);
  const r1 = await page.$eval('#buildingKind', s => s.value), h3r = await page.textContent('.planner-main-card h3'), outR = await page.textContent('.planner-output-product strong');
  H.check('reset → game kind', r1 === '__game__' && h3r === 'Power Plant', '__game__/Power Plant', `${r1}/${h3r}`);
  H.check('reset → live product Power', outR === 'Power', 'Power', outR);
  const cr = await cardOut(); H.check('reset → card output Power', /Power/.test(cr), 'Power', cr);
  const lvlR = await page.textContent('.planner-selected-line');
  H.check('reset → planning level = game level 3', /Planning Level: 3/.test(lvlR), 'Planning Level: 3', lvlR);
  H.check('reset → badge gone', !(await page.$('.owned-building-test')), 'none', (await page.$('.owned-building-test')) ? 'shown' : 'none');
  const q = await page.$eval('#buildingQuality', s => s.value);
  H.check('reset → game quality Q2', q === '2', '2', q);
  await H.shot(page, 'planner-reset');
  await ctx.close(); H.done();
})().catch(async e => { console.log('FAIL exception', e.message); try { const p = global.__p; if (p) { await H.shot(p, 'planner-fail'); console.log((await p.textContent('#buildingPlanner').catch(() => 'no host')).slice(0, 400)); } } catch {} process.exit(1); });
