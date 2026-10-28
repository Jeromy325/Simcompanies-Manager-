// First Sync on a brand-new device (empty storage): the Sync page walk captures the Executives roster
// (/api/v3/companies/<id>/executives/) and each executive's own record (/api/v4/executives/<id>/: workHistory,
// trainings) through the game tab, so the Executives tab is filled without opening the game's Executives page.
// EXEC_ROSTER_404=1: the game answers 404 for the roster; Sync must still complete (optional step).
const H = require('./harness');
(async () => {
  const companyId = 5294950, rosterMissing = process.env.EXEC_ROSTER_404 === '1';
  const old = '2026-09-01T00:00:00Z';
  const w = (id, pos, skills, extra) => ({ id, skills, currentWorkHistory: { position: pos, start: old, accelerated: false }, strikeUntil: null, ...extra });
  const executives = [
    w(1, 'o', { coo: 34, cfo: 12, cmo: 14, cto: 10 }, { name: 'Barbara Davis', age: 64 }),
    w(2, 'f', { coo: 14, cfo: 26, cmo: 14, cto: 10 }, { name: 'Mohit Tuli', age: 66 }),
    w(9, 'o', { coo: 1, cfo: 1, cmo: 1, cto: 1 }, { name: 'Candidate Person', isCandidate: true })];
  const detail = id => ({ ...executives.find(e => e.id === id), workHistory: [{ employerId: companyId, position: 'o', start: old, end: null, daysActive: 57 }], trainings: [{ id: 100 + id, datetime: old, reflected: true, covered: true }], achievements: [] });
  const api = {
    [`/api/v3/resources/${companyId}/`]: [],
    '/api/v3/contracts-incoming/1/me/': [], '/api/v3/contracts-outgoing/me/': [],
    '/api/v2/companies/me/balance-sheet/': {}, '/api/v2/companies/me/cashflow/recent/': {}, '/api/v2/companies/me/cashflow-statement/': {},
    '/api/v2/companies/me/income-statement/': {}, '/api/v2/companies/me/past-finances-overview/': {}, '/api/v2/companies/me/administration-overhead/': 1.6235,
    '/api/v3/companies/me/past-finances/': [],
  };
  const extra = { [`/api/v3/companies/${companyId}/executives/`]: rosterMissing ? undefined : { executives, achievements: [] },
    '/api/v4/executives/1/': detail(1), '/api/v4/executives/2/': detail(2), '/api/v4/executives/9/': detail(9) };
  const requested = [];
  const ctx = await H.launch(); const sw = await H.worker(ctx);
  await sw.evaluate(() => new Promise(r => setTimeout(r, 2500)));
  // fakeGame pre-fetches its api map on page load; executives are served only on request (the page walk must ask).
  await H.fakeGame(ctx, { api, realm: 1, companyId });
  await ctx.route(/\/api\/v(3\/companies\/\d+\/executives|4\/executives\/\d+)\/$/, route => {
    const p = new URL(route.request().url()).pathname; requested.push(p); const body = extra[p];
    return route.fulfill({ status: body === undefined ? 404 : 200, contentType: 'application/json', body: JSON.stringify(body ?? {}) });
  });
  const game = await ctx.newPage(); await game.goto('https://www.simcompanies.com/'); await game.waitForTimeout(3000);
  const id = new URL(sw.url()).host; const dash = await ctx.newPage();
  dash.on('pageerror', e => console.log('pageerror', e.message));
  await dash.goto(`chrome-extension://${id}/dashboard.html`); await dash.waitForTimeout(1500);
  await game.bringToFront();
  const r = await dash.evaluate(() => chrome.runtime.sendMessage({ type: 'SYNC_NOW', realm: 1 }));
  H.check('Sync ok', r?.ok === true, true, `${r?.ok} ${r?.error || ''}`);
  const walk = (r?.results || []).map(x => `${x.name}:${x.ok ? 'ok' : 'no'}`).join(',');
  H.check('walk has Executives before Accounting', /Executives:[a-z]+,Accounting/.test(walk), 'Executives,Accounting', walk);
  const ep = await sw.evaluate(async () => (await chrome.storage.local.get('scmRealmStore:1'))['scmRealmStore:1']?.endpointData || {});
  if (rosterMissing) {
    H.check('roster not stored', !ep[`/api/v3/companies/${companyId}/executives/`], 'absent', Object.keys(ep).filter(k => /executives/.test(k)).join(','));
    H.check('Executives reported optional', r?.results?.find(x => x.name === 'Executives')?.optional === true, true, JSON.stringify(r?.results?.find(x => x.name === 'Executives')?.status));
  } else {
    const roster = ep[`/api/v3/companies/${companyId}/executives/`];
    H.check('roster stored under R2 key the tab reads', roster?.captureRealm === 1 && roster?.data?.executives?.length === 3, '3 execs realm 1', `${roster?.data?.executives?.length} realm ${roster?.captureRealm}`);
    const d1 = ep['/api/v4/executives/1/'], d2 = ep['/api/v4/executives/2/'];
    H.check('exec 1 work history + trainings', d1?.data?.workHistory?.length === 1 && d1?.data?.trainings?.length === 1 && d1?.captureRealm === 1, '1/1', `${d1?.data?.workHistory?.length}/${d1?.data?.trainings?.length}`);
    H.check('exec 2 work history + trainings', d2?.data?.workHistory?.length === 1 && d2?.data?.trainings?.length === 1, '1/1', `${d2?.data?.workHistory?.length}/${d2?.data?.trainings?.length}`);
    H.check('candidate not fetched', !requested.includes('/api/v4/executives/9/') && !ep['/api/v4/executives/9/'], 'not fetched', requested.join(','));
    await dash.reload(); await dash.waitForTimeout(2000);
    await dash.click('button.tab[data-tab="executives"]');
    const shown = await dash.waitForSelector('.exec-card', { timeout: 15000 }).then(() => true).catch(() => false);
    const body = await dash.textContent('#execBody').catch(() => '');
    H.check('Executives tab filled without opening the game page', shown && !/No executives captured/.test(body), 'cards', shown ? 'cards' : body.slice(0, 80));
    const over = await dash.evaluate(() => document.documentElement.scrollWidth); H.check('no horizontal overflow at 360', over <= 360, '<=360', over);
    await H.shot(dash, 'sync-executives-walk');
  }
  await ctx.close(); H.done();
})();
