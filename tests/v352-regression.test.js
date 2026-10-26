// 2.5.352: abundance mines found even without downloaded game constants; monitor shows every activity, logs the
// Manager's own work, and also runs on the game page (draggable, collapsible, warehouse toast).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
assert.equal(manifest.version, '2.5.391');
const bg = read('background.js');

(async () => {
  // run the real helpers with game constants MISSING (the phone case)
  const src = bg.slice(bg.indexOf('let bundledAbundanceKindsMemo'), bg.indexOf('async function abundanceBuildingIds('));
  const ctx = {
    SCM_TOOLS_CORE: require('../tools-core.js'),
    chrome: { storage: { local: { get: async () => ({ scmGameConstants: null }) } }, runtime: { getURL: f => f } },
    fetch: async f => ({ json: async () => JSON.parse(read(f)) })
  };
  ctx.globalThis = ctx; vm.createContext(ctx);
  vm.runInContext(src + ';this.info=abundanceBuildingInfo;', ctx);
  const buildings = [{ id: 58251161, kind: 'M', name: 'Mine #1' }, { id: 2, kind: 'Q' }, { id: 3, kind: 'O' }, { id: 4, kind: 'E' }, { id: 5, kind: 'X', busy: { resource: { kind: 14 } } }];
  const r = await ctx.info({ buildings, endpointData: {} });
  assert.deepEqual([...r.ids].sort(), ['2', '3', '5', '58251161'], 'mine, quarry, oil rig, and a building producing Minerals; not the power plant');
  assert.ok(r.sources.includes('game constants missing'), 'reason recorded for the monitor');
  // with constants present the result is the same
  ctx.chrome.storage.local.get = async () => ({ scmGameConstants: { resources: { 14: { producedAt: 'M' } } } });
  assert.deepEqual([...(await ctx.info({ buildings: [{ id: 1, kind: 'M' }], endpointData: {} })).ids], ['1']);

  // every abundance run is logged, with errors
  const fn = bg.slice(bg.indexOf('async function refreshAbundanceIfStale('), bg.indexOf('async function refreshExtraGameData('));
  assert.ok(fn.includes("'No mine, oil rig or quarry found in your buildings'") && fn.includes("logActivity(r,'abundance-refresh'"), 'monitor says why');
  assert.ok(!/withStorageLock|storageLock/.test(fn + bg.slice(bg.indexOf('function logActivity('), bg.indexOf('async function activeRealmNumber('))), 'no storage lock');
  for (const j of ['extra-game-data', 'game-constants', 'market-orders', 'accounting-refresh', 'alert-sent', 'game-data-saved']) assert.ok(bg.includes(`'${j}'`), j);
  assert.ok(bg.includes("logGameCapture(capturedRealm,url)") && bg.includes('<60000'), 'game captures logged, at most once a minute per kind');

  // monitor: every stored activity, not the last 10
  const lu = read('live-updates.js');
  assert.ok(!lu.includes('jobs.slice(-10)') && lu.includes('jobs.slice().reverse()'));
  for (const k of ['abundance-refresh', 'alert-sent', 'game-data-saved']) assert.ok(lu.includes(`'${k}'`), 'label ' + k);
  // game page: content script with its own CSS, draggable grip, remembered position/open state
  const cs = manifest.content_scripts.find(c => (c.js || []).includes('live-updates.js'));
  assert.ok(cs && cs.css.includes('monitor-overlay.css') && cs.world === 'ISOLATED' && cs.matches.includes('https://www.simcompanies.com/*'));
  assert.ok(lu.includes("'pointerdown'") && lu.includes("'scmMonitorPos'") && lu.includes("'scmMonitorOpen'") && lu.includes('window.__SCM_GAME_REALM__'));
  assert.ok(read('monitor-overlay.css').includes('#scmToast.scm-game-toast.show'));
  assert.ok(!/\son(click|error|load|pointerdown)\s*=\s*["']/i.test(lu), 'no inline handlers');
  console.log('v352-regression: passed');
})().catch(e => { console.error(e); process.exit(1); });
