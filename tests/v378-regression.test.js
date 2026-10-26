// 2.5.378: Sync failed on R2 with "API storage queue drain timed out after 20 seconds". The drain waited for the
// realm queue to be fully idle, so continuous passive game captures (each rewriting a 5.9 MB store) starved it.
// The drain is now a barrier for jobs queued before the call, and a drain timeout no longer fails Sync.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
assert.equal(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8')).version, '2.5.389');
function fn(name) {
  const start = src.indexOf(`function ${name}(`); assert.notEqual(start, -1, name);
  const s = src.lastIndexOf('async ', start) === start - 6 ? start - 6 : start;
  let depth = 0, q = null;
  for (let i = src.indexOf('){', start) + 1; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '{') depth++; else if (c === '}' && --depth === 0) return src.slice(s, i + 1);
  }
}
const ctx = { Promise, Boolean, String, Map, setTimeout,
  validRealmNumber: v => v === 0 || v === 1 ? v : null,
  apiStorageQueues: new Map(), apiStorageCommitQueues: new Map(), apiStorageSchedulers: new Map() };
vm.createContext(ctx);
for (const n of ['enqueueApiStorageCommit', 'enqueueApiStorage', 'runApiStorageScheduler', 'apiStorageQueueForRealm']) vm.runInContext(fn(n), ctx);
const tick = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  // Idle queue resolves immediately.
  let done = false; await ctx.apiStorageQueueForRealm(1).then(() => { done = true; }); assert.ok(done, 'idle drain resolves');
  // Barrier resolves after jobs queued before it, even while new passive jobs keep arriving.
  const order = []; let stop = false;
  ctx.enqueueApiStorage(async () => { await tick(5); order.push('a'); }, 1, { url: '/a' });
  ctx.enqueueApiStorage(async () => { await tick(5); order.push('b'); }, 1, { url: '/b' });
  const feeder = (async () => { let i = 0; while (!stop) { ctx.enqueueApiStorage(async () => { await tick(5); order.push('p' + i); }, 1, { url: '/p' + i }); i++; await tick(2); } })();
  const barrier = ctx.apiStorageQueueForRealm(1).then(() => order.slice());
  const raced = await Promise.race([barrier, tick(400).then(() => 'timeout')]);
  stop = true; await feeder;
  assert.notEqual(raced, 'timeout', 'drain is not starved by continuous passive captures');
  assert.deepEqual(raced.slice(0, 2), ['a', 'b'], 'jobs queued before the drain are committed first');
  // Other realm unaffected.
  assert.equal(await Promise.race([ctx.apiStorageQueueForRealm(0).then(() => 'ok'), tick(50).then(() => 'timeout')]), 'ok');
  // Drain timeouts are traced, not thrown.
  assert.match(src, /catch\(e\)\{trace\('api-queue-drain-timeout'/);
  assert.match(src, /catch\(e\)\{trace\('final-api-queue-drain-timeout'/);
  assert.doesNotMatch(src, /\n    await withSyncTimeout\(apiStorageQueueForRealm\(selected\),20000,'(?:Final )?API storage queue drain'\);/);
  console.log('v378-regression: passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
