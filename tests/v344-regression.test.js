// 2.5.344: background warehouse refresh on a slow phone connection (user's exports 2026-10-23 19:46–20:07Z).
// The game's own API answers took 14–70 s; the Manager's refresh gave up after 8 s × 2 attempts and the overlay
// poll re-fired it, logging 18 failures in an hour. Now: one attempt with a 25 s page timeout (page hook aborts at
// the same value, background waits a 2 s grace), and overlay-triggered refreshes pause 60 s after a failure.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.364');
const bg = read('background.js'), content = read('content.js'), hook = read('page-hook.js');

const slice = (src, start, end) => { const a = src.indexOf(start); const b = src.indexOf(end, a + 1); assert.ok(a >= 0 && b > a, start); return src.slice(a, b); };
const pageGetSrc = slice(bg, 'const PAGE_GET_BACKGROUND_GRACE_MS', 'const BUILDING_HISTORY_REFETCH_COOLDOWN_MS');
const backoffSrc = slice(bg, 'const WAREHOUSE_REFRESH_PAGE_TIMEOUT_MS', 'async function refreshRealmWarehouseForOverlayUnlocked');

function sandbox(answerAfterMs) {
  const sent = [];
  const ctx = {
    SYNC_PAGE_API_TIMEOUT_MS: 150, SYNC_PAGE_API_ATTEMPTS: 2, setTimeout, Promise, Date, Number, Error, String, Map,
    simTab: async () => ({ id: 7 }), waitForBridge: async () => true,
    validRealmNumber: v => (v === null || v === undefined || v === '' ? null : ([0, 1].includes(Number(v)) ? Number(v) : null)), realmDisplayNumber: r => `R${Number(r) + 1}`,
    chrome: { tabs: { sendMessage: (id, msg) => { sent.push(msg); return new Promise(r => setTimeout(() => r({ ok: true, status: 200, data: [1] }), answerAfterMs)); } } }
  };
  vm.createContext(ctx);
  vm.runInContext(pageGetSrc + '\n' + backoffSrc + '\nthis.pageGet=pageGet;this.inBackoff=warehouseOverlayRefreshInBackoff;this.note=noteWarehouseOverlayRefreshResult;this.T=WAREHOUSE_REFRESH_PAGE_TIMEOUT_MS;this.B=WAREHOUSE_OVERLAY_FAILURE_BACKOFF_MS;', ctx);
  return { ctx, sent };
}

(async () => {
  // v2.5.345 default (Sync) path: the page is told the timeout; attempts come from SYNC_PAGE_API_ATTEMPTS.
  {
    const { ctx, sent } = sandbox(4000);
    await assert.rejects(ctx.pageGet('/api/v3/resources/1/'), /bridge timed out/);
    assert.equal(sent.length, 2, 'sandbox attempts honoured');
    assert.equal(sent[0].timeoutMs, 150, 'default message carries the Sync timeout');
  }
  // Slow answer within the longer timeout: one attempt, succeeds, page told the timeout.
  {
    const { ctx, sent } = sandbox(400);
    const r = await ctx.pageGet('/api/v3/resources/1/', null, null, null, { timeoutMs: 500, attempts: 1 });
    assert.ok(r.ok, 'slow page answer accepted');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].timeoutMs, 500);
  }
  // Answer arriving after the page timeout but inside the grace still counts (page reports its own abort first).
  {
    const { ctx, sent } = sandbox(600);
    const r = await ctx.pageGet('/api/x/', null, null, null, { timeoutMs: 500, attempts: 1 });
    assert.ok(r.ok); assert.equal(sent.length, 1);
  }
  // Backoff helpers.
  {
    const { ctx } = sandbox(1);
    assert.equal(ctx.T, 25000); assert.equal(ctx.B, 60000);
    const t0 = 1000000;
    ctx.note(1, 12000, { ok: false, error: 'Sim Companies page API request timed out.' }, t0);
    assert.equal(ctx.inBackoff(1, 12000, t0 + 30000), true, 'overlay refresh paused after a failure');
    assert.equal(ctx.inBackoff(1, 0, t0 + 30000), false, 'refresh after a game action always runs');
    assert.equal(ctx.inBackoff(0, 12000, t0 + 30000), false, 'other realm unaffected');
    assert.equal(ctx.inBackoff(1, 12000, t0 + 60001), false, 'pause ends after 60 s');
    ctx.note(1, 0, { ok: true }, t0 + 31000);
    assert.equal(ctx.inBackoff(1, 12000, t0 + 31001), false, 'a success clears the pause');
    ctx.note(1, 12000, { ok: false, stale: true }, t0);
    assert.equal(ctx.inBackoff(1, 12000, t0 + 1), false, 'realm-switch discards do not pause');
  }
  // Wiring.
  const unlocked = slice(bg, 'async function refreshRealmWarehouseForOverlayUnlocked', 'normalizeWarehouse(r.data)');
  assert.ok(unlocked.includes('pageGet(path,null,null,null,{timeoutMs:WAREHOUSE_REFRESH_PAGE_TIMEOUT_MS,attempts:1})'));
  const outer = slice(bg, 'async function refreshRealmWarehouseForOverlay(realm', 'function notifyDashboardAccountingLedgerReady');
  assert.ok(outer.indexOf('warehouseOverlayRefreshInBackoff(n,maxAgeMs)') < outer.indexOf('refreshRealmWarehouseForOverlayUnlocked(n,maxAgeMs)'));
  assert.ok(outer.includes('noteWarehouseOverlayRefreshResult(n,maxAgeMs,result)'));
  assert.ok(!/withRealmWriteLock/.test(unlocked.slice(0, unlocked.indexOf('pageGet('))), 'no lock held around pageGet');
  assert.ok(content.includes("type: 'API_GET', id, path: message.path, timeoutMs: message.timeoutMs"));
  assert.ok(hook.includes('Math.min(requestedTimeout, 60000) : 8000'));
  console.log('v344-regression ok');
})().catch(e => { console.error(e); process.exit(1); });
