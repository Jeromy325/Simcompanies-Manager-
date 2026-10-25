// 2.5.374: Executives tab at 360 px, seeded with the user's board-room screen (no storage export attached).
const H = require('./harness');
(async () => {
  const now = new Date().toISOString(), old = '2026-09-01T00:00:00Z';
  const w = (id, pos, skills, extra) => ({ id, skills, currentWorkHistory: { position: pos, start: old, accelerated: false }, strikeUntil: null, ...extra });
  const executives = [
    w(1, 'o', { coo: 34, cfo: 12, cmo: 14, cto: 10 }, { name: 'Barbara Davis', age: 64, trainings: 20, salary: 12000 }),
    w(2, 'v', { coo: 18, cfo: 11, cmo: 4, cto: 11 }, { name: 'Eric Lopez', age: 52, trainings: 20, salary: 8000 }),
    w(3, 'f', { coo: 14, cfo: 26, cmo: 14, cto: 10 }, { name: 'Mohit Tuli', age: 66, trainings: 20, salary: 11000 }),
    w(4, 'm', { coo: 6, cfo: 3, cmo: 5, cto: 1 }, { name: 'Kennedy Cooper', age: 25, salary: 7458 }),
    w(5, 't', { coo: 12, cfo: 6, cmo: 4, cto: 16 }, { name: 'Brian Gonzales', age: 34, trainings: 18, salary: 9000 })];
  const buildings = [{ id: 7, kind: 'y', size: 8, position: '5', busy: null, category: 'other' },
    { id: 111, kind: 'E', name: 'Power Plant', size: 3, category: 'production', busy: { resource: { kind: 1, name: 'Power', quality: 2, amount: 3000 }, started: now, duration: 3600 } }];
  const ep = (data) => ({ status: 200, receivedAt: now, data });
  const store = { authData: { authCompany: { realmId: 1, companyId: 5294950 } }, warehouseResources: [], endpointData: {
    '/api/v2/companies/me/buildings/': ep(buildings), '/api/v2/companies/me/administration-overhead/': ep(1.6235),
    '/api/v3/companies/5294950/executives/': ep({ executives }) } };
  const ctx = await H.launch();
  await (await H.worker(ctx)).evaluate(() => new Promise(r => setTimeout(r, 2500)));
  const gc = require('../fixtures/game-constants-full-2026-10-24.json');
  await H.seed(ctx, { store, extra: { scmGameConstants: { ...gc, at: now }, scmGameConfig: { executivesTimeToTrainS: 97200, executivesTimeToSettleInS: 10800 } } });
  const id = new URL((await H.worker(ctx)).url()).host, page = await ctx.newPage();
  page.on('pageerror', e => console.log('pageerror', e.message));
  await page.goto(`chrome-extension://${id}/dashboard.html`);
  await page.click('button.tab[data-tab="executives"]');
  await page.waitForSelector('.exec-card', { timeout: 20000 });
  const cards = await page.$$eval('.exec-card strong', e => e.map(x => x.textContent));
  H.check('cards in board-room order', cards.join(',') === 'COO,COO Apprentice,CFO,CMO,CTO', 'COO,COO Apprentice,CFO,CMO,CTO', cards.join(','));
  const body = await page.textContent('#execBody');
  H.check('admin 62.35% −31.80% = 30.55%', /62\.35%\s*−31\.80%\s*=\s*30\.55%/.test(body), '62.35% −31.80% = 30.55%', (body.match(/\d+\.\d+%\s*−[\d.]+%\s*=\s*[\d.]+%/) || ['none'])[0]);
  H.check('salaries $47,458', body.includes('$47,458'), '$47,458', (body.match(/Salaries\$[\d,.]+/) || ['none'])[0]);
  H.check('succession: Eric takes over COO 26 pts', /Eric Lopez takes over.*effective COO 26 pts/.test(body), 'COO 26 pts', /effective COO 26 pts/.test(body));
  H.check('succession card title', body.includes('If your COO leaves'), 'If your COO leaves', body.includes('If your COO leaves'));
  H.check('COO ROI has saved/day', /Admin saved \/ day/.test(body) && !/Game constants or producing/.test(body), 'shown', /Admin saved/.test(body));
  const inner = await page.innerHTML('#execBody');
  H.check('no stray commas between rows', !inner.includes('</div>,<div'), 'none', inner.includes('</div>,<div') ? 'found' : 'none');
  const over = await page.evaluate(() => document.documentElement.scrollWidth);
  H.check('no horizontal overflow at 360', over <= 360, '<=360', over);
  await page.fill('#execGain', '3'); await page.dispatchEvent('#execGain', 'change'); await page.waitForTimeout(300);
  const g = await page.$eval('#execGain', e => e.value);
  H.check('gain input persists after re-render', g === '3', '3', g);
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(300); console.log(await H.shot(page, 'executives-360'));
  await page.evaluate(() => window.scrollTo(0, 1400)); console.log(await H.shot(page, 'executives-360-b'));
  await page.fill('[data-exec-done="4"]', '6'); await page.dispatchEvent('[data-exec-done="4"]', 'change'); await page.waitForTimeout(300);
  const cmo = await page.$$eval('table.exec-plan tbody tr', rs => { const r = rs.find(x => x.textContent.includes('Kennedy')); return [...r.cells].map(c => c.querySelector('input')?.value ?? c.textContent.trim()); });
  H.check('typed Done 6 → Left 14, cost $140,000', cmo[1] === '6' && cmo[2] === '14' && cmo[3] === '$140,000.00', '6,14,$140,000.00', cmo.slice(1, 4).join(','));
  const card = await page.$$eval('.exec-card', cs => cs.find(c => c.textContent.includes('Kennedy')).textContent);
  H.check('card shows 6/20 trainings', card.includes('6/20 trainings'), '6/20', card.includes('6/20 trainings'));
  const baraLeft = await page.$$eval('table.exec-plan tbody tr', rs => rs.find(x => x.textContent.includes('Barbara')).cells[2].textContent);
  H.check('captured 20 → Left 0', baraLeft === '0', '0', baraLeft);
  await page.$eval('table.exec-plan', t => t.scrollIntoView()); console.log(await H.shot(page, 'executives-plan'));
  await ctx.close(); H.done();
})();
