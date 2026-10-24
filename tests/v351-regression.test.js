// 2.5.351: abundance is fetched automatically when the game's buildings list is captured (no Sync, no opening the mine).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.355');
const bg = read('background.js');
// stale filter: missing, no abundance object, older than 1 h → fetch; fresh → skip
const src = bg.slice(bg.indexOf('const ABUNDANCE_AUTO_MAX_AGE_MS'), bg.indexOf('async function refreshAbundanceIfStale('));
const ctx = {}; vm.createContext(ctx); vm.runInContext(src.replace(/^const /, 'var ') + ';this.f=staleAbundanceIds;', ctx);
const now = Date.parse('2026-10-24T12:00:00Z'), at = m => new Date(now - m * 60e3).toISOString();
const ep = {
  '/api/v2/companies/buildings/1/abundance/': { receivedAt: at(10), data: { abundance: { 14: 99 } } },
  '/api/v2/companies/buildings/2/abundance/': { receivedAt: at(61), data: { abundance: { 14: 88 } } },
  '/api/v2/companies/buildings/3/abundance/': { receivedAt: at(1), data: {} }
};
assert.deepEqual(ctx.f(['1', '2', '3', '4'], ep, now), ['2', '3', '4']);
// hooked on the buildings capture, with the capture's own realm
const hook = bg.slice(bg.indexOf('const isB=/\\/api\\/v2\\/companies\\/me\\/buildings') /* 2.5.353 combined buildings + auth-data trigger */, bg.indexOf('refreshAbundanceIfStale(r,') + 60);
assert.ok(hook.includes('capturedRealm??') && hook.includes('r!=null') && hook.includes('setTimeout('), 'triggered by the game buildings capture (2.5.353: realm from the capture or auth-data)');
const fn = bg.slice(bg.indexOf('async function refreshAbundanceIfStale('), bg.indexOf('async function refreshExtraGameData('));
assert.ok(fn.includes('currentCaptureSyncSession()') && fn.includes('ABUNDANCE_AUTO_MIN_GAP_MS') && fn.includes('cur.running'), 'throttled, one at a time, not during Sync');
assert.ok(!/withStorageLock|storageLock/.test(fn), 'no storage lock around the game fetches');
assert.ok(bg.includes('for(const id of await abundanceBuildingIds(st))ab.add(id);'), 'Sync path uses the same building list');
const dash = read('dashboard.js'), sig = dash.slice(dash.indexOf('function scmBuildingsSignature('), dash.indexOf('function scmHistorySignature('));
const sctx = {}; vm.createContext(sctx); vm.runInContext(sig + ';this.f=scmBuildingsSignature;', sctx);
const s1 = { buildings: [{ id: 9001, kind: 'M', size: 3 }], endpointData: {} };
const s2 = { ...s1, endpointData: { '/api/v2/companies/buildings/9001/abundance/': { data: { abundance: { 14: 87.4 } } } } };
assert.notEqual(sctx.f(s1), sctx.f(s2), 'open Production tab repaints when abundance arrives');
console.log('v351-regression: passed');
