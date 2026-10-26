// 2.5.380: Sync has priority. R2 2.5.378 Sync took 239 s: passive game captures were saved during Sync setup (57 s
// before the realm was activated), the VWAP stage rescheduled itself every second with a storage write (162 times),
// warehouse/overlay refreshes ran mid-Sync, and 6/7 Accounting writes hit an 8 s timeout while waiting in line.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const src = read('background.js');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.381');
function fn(name) {
  const start = src.indexOf(`function ${name}(`); assert.notEqual(start, -1, name);
  let depth = 0, q = null;
  for (let i = src.indexOf('){', start) + 1; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '{') depth++; else if (c === '}' && --depth === 0) return src.slice(start, i + 1);
  }
}
const ctx = { Map, Promise, String, Array, Boolean, realmSyncSessions: new Map(), syncDeferredWork: new Map() };
vm.createContext(ctx);
for (const n of ['coreSyncActive', 'deferUntilSyncEnds', 'resumeSyncDeferredWork', 'shouldPersistPassiveApiCaptureDuringSync']) vm.runInContext(fn(n), ctx);
(async () => {
  // Passive captures are skipped in every Sync phase, not only 'running'.
  for (const phase of ['preflight', 'auth-boundary', 'running', 'finalizing'])
    assert.equal(ctx.shouldPersistPassiveApiCaptureDuringSync({ phase, capturePaths: [] }, '/api/v2/companies/me/income-statement/', 'GET'), false, phase);
  assert.equal(ctx.shouldPersistPassiveApiCaptureDuringSync({ phase: 'running', capturePaths: ['/api/x/'] }, '/api/x/', 'GET'), true, 'Sync target paths still persist');
  assert.equal(ctx.shouldPersistPassiveApiCaptureDuringSync(null, '/api/x/', 'GET'), true, 'no Sync: normal capture');
  // Deferred work waits while Sync runs, runs once (deduplicated by key) after it ends.
  const ran = [];
  ctx.realmSyncSessions.set(1, {});
  assert.equal(ctx.coreSyncActive(), true);
  ctx.deferUntilSyncEnds('market:1:vwap', () => ran.push('vwap'));
  ctx.deferUntilSyncEnds('market:1:vwap', () => ran.push('vwap'));
  ctx.deferUntilSyncEnds('warehouse:1', () => ran.push('warehouse'));
  assert.equal(ctx.resumeSyncDeferredWork(), 0, 'nothing resumes while Sync is active');
  ctx.realmSyncSessions.delete(1);
  assert.equal(ctx.resumeSyncDeferredWork(), 2);
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(ran, ['vwap', 'warehouse']);
  assert.equal(ctx.resumeSyncDeferredWork(), 0, 'each deferred job runs once');
  // Wiring.
  assert.match(src, /if\(coreSyncActive\(\)\)\{deferUntilSyncEnds\(`market:\$\{n\}:\$\{stage\}`/, 'VWAP/prices stage defers, no 1 s reschedule loop');
  assert.doesNotMatch(src, /scheduleMarketStage\(n,stage,POST_SYNC_MARKET_COOLDOWN_MS,'core-sync-active'\)/);
  assert.match(src, /if\(coreSyncActive\(\)\)\{if\(maxAgeMs===0\)deferUntilSyncEnds\(`warehouse:\$\{n\}`/, 'warehouse refresh defers');
  assert.match(src, /if\(coreSyncActive\(\)\)\{deferUntilSyncEnds\(`overlay:\$\{n\}`/, 'overlay notification defers');
  assert.match(src, /if\(coreSyncActive\(\)\)\{pendingEndpointSeenTimer=setTimeout\(flush,20000\);return;\}/, 'endpoint-seen flush waits');
  assert.match(src, /if\(method==='GET'&&session\)\{/, 'API_SEEN skipped in every Sync phase');
  assert.match(src, /const SYNC_PERSIST_VERIFY_TIMEOUT_MS=30000;/);
  assert.match(src, /SYNC_PERSIST_VERIFY_TIMEOUT_MS,`Persist and verify \$\{path\}`/, 'Sync writes wait in line instead of timing out at 8 s');
  const fin = src.indexOf('if(ownsSyncSession)resumeSyncDeferredWork();');
  assert.ok(fin > src.indexOf('realmSyncSessions.delete(selected)'), 'work resumes only after the Sync session is released');
  console.log('v380-regression: passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
