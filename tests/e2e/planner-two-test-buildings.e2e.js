// 2.5.367: two buildings switched to the same test kind both count in the network totals, whichever is selected.
const H = require('./harness');
(async () => {
  const now = new Date().toISOString();
  const pp = (id) => ({ id, kind: 'E', name: 'Power Plant', size: 3, category: 'production', busy: { resource: { kind: 1, name: 'Power', quality: 2, amount: 3000 }, started: now, duration: 3600 } });
  const store = { authData: { authCompany: { realmId: 1, companyId: 5294950 } }, endpointData: { '/api/v2/companies/me/buildings/': { status: 200, receivedAt: now, data: [pp(111), pp(333)] } }, warehouseResources: [] };
  const ctx = await H.launch();
  const sw = await H.worker(ctx); await sw.evaluate(() => new Promise(r => setTimeout(r, 2500)));
  await H.seed(ctx, { store });
  const page = await ctx.newPage(); global.__p = page;
  await page.goto(`chrome-extension://${new URL(sw.url()).host}/dashboard.html`);
  await page.click('button.tab[data-tab="production"]'); await page.waitForSelector('#buildingKind', { timeout: 30000 });
  const toMine = async id => { await page.click(`.owned-building-card[data-building-id="${id}"]`); await page.waitForTimeout(900); await page.selectOption('#buildingKind', 'M'); await page.waitForTimeout(900); await page.selectOption('#buildingOutput', 'Bauxite'); await page.waitForTimeout(1200); };
  const baux = async () => { const t = await page.$$eval('.planner-summary-row', r => r.map(x => x.textContent.replace(/\s+/g, ' '))); const row = t.find(x => /^Bauxite/.test(x.trim())) || ''; const m = row.match(/[+-]([\d,]+\.?\d*)/); return m ? Number(m[1].replace(/,/g, '')) : null; };
  await toMine(111); const one = await baux();
  await toMine(333); const twoSel333 = await baux();
  await page.click('.owned-building-card[data-building-id="111"]'); await page.waitForTimeout(1500); const twoSel111 = await baux();
  H.check('one mine gives Bauxite surplus', one > 0, '>0', one);
  H.check('second mine doubles it', Math.abs(twoSel333 - 2 * one) < 0.01, 2 * one, twoSel333);
  H.check('same total with the other mine selected', Math.abs(twoSel111 - twoSel333) < 0.01, twoSel333, twoSel111);
  const saved = await sw.evaluate(async () => { const s = (await chrome.storage.local.get('scmRealmStore:1'))['scmRealmStore:1']; const p = s?.frozenNetworkPlan?.buildingPlans || {}; return [p['111']?.product, p['333']?.product].join(','); });
  H.check('realm plan saved with both test outputs', saved === 'Bauxite,Bauxite', 'Bauxite,Bauxite', saved);
  await ctx.close(); H.done();
})().catch(e => { console.log('FAIL exception', e.message); process.exit(1); });
