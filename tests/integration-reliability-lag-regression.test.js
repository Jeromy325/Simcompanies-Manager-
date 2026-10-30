// Integration fixes R1-R6 (reliability) and P1-P6 (lag). Behavior tests run the real storage-layer source in a
// vm with a fake chrome.storage; the rest are source checks in the style of the other regression tests.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');
const bg = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const hook = fs.readFileSync(path.join(root, 'page-hook.js'), 'utf8');
const slice = (src, start, end) => { const i = src.indexOf(start); assert.ok(i >= 0, 'missing ' + start); const j = src.indexOf(end, i + start.length); assert.ok(j > i, 'missing end ' + end); return src.slice(i, j); };
const J = v => JSON.parse(JSON.stringify(v));

function storageContext() {
  const data = {}; const writes = [];
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const local = {
    get: async q => { const out = {}; if (q && typeof q === 'object') for (const [k, d] of Object.entries(q)) out[k] = k in data ? clone(data[k]) : d; return out; },
    set: async items => { writes.push(Object.keys(items)); for (const [k, v] of Object.entries(items)) data[k] = clone(v); },
  };
  const ctx = {
    console, Promise, Date, Object, Array, Number, String, JSON, Map, Set, Error, TypeError, Math, setTimeout, clearTimeout,
    chrome: { storage: { local } },
    validRealmNumber: v => { const n = Number(v); return (v === null || v === undefined || v === '' || !Number.isInteger(n) || n < 0 || n > 1) ? null : n; },
    realmStorageKey: n => `scmRealmStore:${n}`,
    realmKeyFromRealm: n => `realm:${n}`,
    realmNumberFromKey: k => { const m = String(k || '').match(/^realm:(\d+)$/); return m ? Number(m[1]) : null; },
    sanitizeRealmStore: s => { const n = { ...(s || {}) }; delete n.realmStores; return n; },
    REALM_SCOPED_KEYS: ['endpointData', 'realmQuarantine', 'syncStatus', 'fullSyncDiagnostics', 'gameOverlaySnapshot', 'productionPlannerState', 'buildings'],
    defaultRealmValue: () => null,
    DEFAULTS: { authData: null }, GLOBAL_DEFAULTS: { activeRealmKey: null, scmRealmStoreSchema: 0 },
    routeResourceImagesOut: async o => o,
    identityFromAuth: () => null,
  };
  ctx.rawStorageSet = local.set;
  vm.createContext(ctx);
  const src = slice(bg, 'const PHYSICAL_REALM_FORBIDDEN_KEYS=', 'let gameOverlayAssetsPromise=null;');
  vm.runInContext(src + '\nthis.api={storageSet,storageSetRealmPatch,flushRealmPatches,discardAllRealmPatches,state,stateAllRealms,appendRealmQuarantine,pendingRealmPatches,REALM_PATCH_COALESCE_MS};', ctx);
  return { api: ctx.api, data, writes };
}
const storeWrites = (writes, n) => writes.filter(k => k.includes(`scmRealmStore:${n}`)).length;

(async () => {
  // P1: patches are buffered, visible to state(realm) at once, merged in order and written once.
  {
    const { api, data, writes } = storageContext();
    data['scmRealmStore:1'] = { buildings: [1], endpointData: { a: 1 } };
    data.scmRealmStoreSchema = 1;
    assert.ok(api.REALM_PATCH_COALESCE_MS > 0 && api.REALM_PATCH_COALESCE_MS <= 1000, 'short coalescing window');
    await api.storageSetRealmPatch(1, { endpointData: { a: 1, b: 2 } });
    await api.storageSetRealmPatch(1, { endpointData: { a: 1, b: 3 }, syncStatus: 'x' });
    assert.equal(storeWrites(writes, 1), 0, 'no whole-store write per patch');
    const seen = await api.state(1);
    assert.deepEqual(J(seen.endpointData), { a: 1, b: 3 }, 'state(realm) overlays the pending patch, later patch wins');
    assert.deepEqual(J(seen.buildings), [1], 'unpatched fields kept');
    const all = await api.stateAllRealms();
    assert.equal(all.realmStores['realm:1'].syncStatus, 'x', 'stateAllRealms overlays too');
    await api.flushRealmPatches(1);
    assert.equal(storeWrites(writes, 1), 1, 'one physical write for two patches');
    assert.deepEqual(data['scmRealmStore:1'].endpointData, { a: 1, b: 3 });
    assert.equal(data['scmRealmStore:1'].syncStatus, 'x');
    assert.equal(api.pendingRealmPatches.size, 0);
  }
  // P1: the timer flushes by itself.
  {
    const { api, data } = storageContext();
    data.scmRealmStoreSchema = 1;
    await api.storageSetRealmPatch(0, { buildings: [9] });
    await new Promise(r => setTimeout(r, api.REALM_PATCH_COALESCE_MS + 150));
    assert.deepEqual(data['scmRealmStore:0'].buildings, [9], 'timer wrote the buffered patch');
  }
  // P1: a whole-store write built from state() absorbs the buffer; a later flush cannot write stale fields back.
  {
    const { api, data, writes } = storageContext();
    data['scmRealmStore:1'] = { buildings: [1] }; data.scmRealmStoreSchema = 1;
    await api.storageSetRealmPatch(1, { endpointData: { p: 1 } });
    const s = await api.state(1);
    await api.storageSet({ realmStores: { 'realm:1': { ...s.realmStores['realm:1'], buildings: [2], endpointData: { p: 1, q: 2 } } } });
    assert.equal(api.pendingRealmPatches.size, 0, 'buffer absorbed by the whole-store write');
    await api.storageSetRealmPatch(1, { syncStatus: 'later' });
    await api.flushRealmPatches(1);
    assert.deepEqual(data['scmRealmStore:1'].endpointData, { p: 1, q: 2 }, 'newer whole-store endpointData not reverted');
    assert.deepEqual(data['scmRealmStore:1'].buildings, [2]);
    assert.equal(data['scmRealmStore:1'].syncStatus, 'later');
    assert.equal(storeWrites(writes, 1), 2);
  }
  // P1: the active-realm scoped write path (storageSet without realmStores) merges the buffer atomically.
  {
    const { api, data } = storageContext();
    data['scmRealmStore:1'] = { buildings: [1] }; data.scmRealmStoreSchema = 1; data.activeRealmKey = 'realm:1';
    await api.storageSetRealmPatch(1, { endpointData: { z: 1 } });
    await api.storageSet({ syncStatus: 'root' });
    assert.deepEqual(data['scmRealmStore:1'].endpointData, { z: 1 }, 'buffered patch written with the scoped write');
    assert.equal(data['scmRealmStore:1'].syncStatus, 'root');
    assert.equal(api.pendingRealmPatches.size, 0);
  }
  // R5/P1: discarding the buffer (Clear extension data) means nothing is written afterwards.
  {
    const { api, data } = storageContext();
    data.scmRealmStoreSchema = 1;
    await api.storageSetRealmPatch(1, { buildings: [5] });
    api.discardAllRealmPatches();
    await api.flushRealmPatches();
    assert.equal(data['scmRealmStore:1'], undefined, 'discarded patch never written');
  }
  // R2: quarantine is one transaction on the target realm and keeps that realm's data (incl. a buffered patch).
  {
    const { api, data } = storageContext();
    data['scmRealmStore:0'] = { buildings: [7], realmQuarantine: { apiData: [{ n: 1 }] } }; data.scmRealmStoreSchema = 1; data.activeRealmKey = 'realm:1';
    await api.storageSetRealmPatch(0, { endpointData: { fresh: 1 } });
    await Promise.all([api.appendRealmQuarantine(0, 'apiData', { n: 2 }), api.appendRealmQuarantine(0, 'apiData', { n: 3 })]);
    const s0 = data['scmRealmStore:0'];
    assert.deepEqual(s0.buildings, [7], 'target realm data kept');
    assert.deepEqual(s0.endpointData, { fresh: 1 }, 'buffered patch of the target realm not reverted');
    assert.deepEqual(s0.realmQuarantine.apiData.map(x => x.n), [1, 2, 3], 'concurrent quarantine appends both kept, in order');
  }
  // R2: no explicit realm, active realm unknown → a realm proven only by authData is read before writing.
  assert.ok(/const ts=!key\|\|n!=null\|\|[^;]*\?s:await state\(target\);/.test(bg), 'quarantine reads the target realm store before writing it');
  assert.ok(/async function appendRealmQuarantine[\s\S]*?return withRealmStorageCommit\(async\(\)=>\{[\s\S]*?storageSetUnlocked\(patch\)/.test(bg), 'quarantine read+write in the commit lane');

  // P1: durability check and the overlay refresh notice flush first; Sync end flushes.
  assert.ok(/async function verifyDurableEndpointWrite[\s\S]{0,800}await flushRealmPatches\(n\);[\s\S]{0,80}const physicalKey=realmStorageKey\(n\);/.test(bg), 'verifier flushes before reading the physical key');
  assert.ok(/flushRealmPatches\(n\)\.catch\(\(\)=>\{\}\)\.then\(\(\)=>notifyGameOverlayRefresh\(n\)\)/.test(bg), 'overlay notice after flush');
  assert.ok(/\}finally\{\s*\/\/ P1:[^\n]*\n\s*if\(ownsSyncSession && selected!=null\) await withSyncTimeout\(flushRealmPatches\(selected\)/.test(bg), 'Sync end flush');

  // P2: ledger archive pages are batched and written once.
  {
    const store = {}; const writes = [];
    const ctx = { Promise, Object, Array, Map, setTimeout, clearTimeout,
      validRealmNumber: v => (v === 0 || v === 1 ? v : null),
      chrome: { storage: { local: { get: async q => { const k = Object.keys(q)[0]; return { [k]: store[k] ?? q[k] }; } } } },
      rawStorageSet: async items => { writes.push(items); Object.assign(store, JSON.parse(JSON.stringify(items))); },
      globalThis: { SCM_ANALYZE_CORE: { archiveMerge: (a, url, rows) => ({ rows: { ...(a?.rows || {}), ...Object.fromEntries(rows.map(r => [r.id, url])) }, spans: [...(a?.spans || []), url], added: rows.length }) } } };
    vm.createContext(ctx);
    vm.runInContext("function ledgerArchiveKey(realm){return `scmLedgerArchive:${Number(realm)}`;}\n" + slice(bg, 'const ledgerArchiveQueues=new Map();', '// 2.5.388 Daily-walk') + '\nthis.q=queueLedgerArchive;this.f=flushLedgerArchive;this.ms=LEDGER_ARCHIVE_BATCH_MS;', ctx);
    assert.ok(ctx.ms >= 1000, 'batch window');
    const p1 = ctx.q(1, [{ url: '/recent/', rows: [{ id: 1 }] }]);
    const p2 = ctx.q(1, [{ url: '/9/', rows: [{ id: 2 }] }]);
    assert.equal(writes.length, 0, 'nothing written per response');
    ctx.f(1);
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(writes.length, 1, 'one archive write for the batch');
    assert.ok(r1.ok && r2.ok && r1.rows === 2, 'both callers get the batch result');
    assert.deepEqual(store['scmLedgerArchive:1'].spans, ['/recent/', '/9/'], 'pages merged in arrival order');
    assert.ok(/await flushLedgerArchive\(n\); \/\/ the refreshed recent page/.test(bg), 'catch-up writes the pending batch first');
    assert.ok(/const queued=queueLedgerArchive\(n,pages\);flushLedgerArchive\(n\);const a=await queued;/.test(bg), 'compaction does not wait for the batch timer');
  }

  // R1: a failed Sync marks the realm it was syncing.
  assert.ok(/const sel=ownsSyncSession&&validRealmNumber\(selected\)!=null\?validRealmNumber\(selected\):/.test(bg), 'R1 synced realm used');
  // R3: untagged captures commit in the target realm's API queue.
  assert.ok(/const redispatch=laneRealm==null&&targetRealm!=null;/.test(bg) && /if\(redispatch\)return enqueueApiStorage\(commitTail,targetRealm,/.test(bg), 'R3 target-lane commit');
  assert.ok(/const s2=redispatch\?await state\(\):before;/.test(bg), 'R3 re-reads the active view inside the target lane');
  // R4: recovery on install/update, retry alarms survive updates.
  const inst = slice(bg, 'chrome.runtime.onInstalled.addListener(async()=>{', '\n});\nchrome.runtime.onStartup');
  assert.ok(inst.includes("recoverInterruptedSyncJobs('installed')"), 'R4 recovery in onInstalled');
  assert.ok(/const INSTALL_KEEP_ALARM_PREFIXES=\[[^\]]*SYNC_AUTO_RETRY_ALARM_PREFIX\]/.test(bg), 'R4 retry alarm kept on update');
  // R5: clear resets memos, buffers and the live market alarm.
  const clr = slice(bg, "if(m?.type==='CLEAR_EXTENSION_DATA'){", "if(m?.type==='WAIT_FOR_ENDPOINT_CAPTURE')");
  for (const s of ['discardAllRealmPatches()', 'discardPendingLedgerArchive()', 'resourceImagesMemo=null', 'notifyRecipesMemo=null', 'gameOverlayAssetsPromise=null', 'gameOverlaySnapshotMemo.clear()', "ensureLiveMarketRefreshAlarm('clear-extension-data')"]) assert.ok(clr.includes(s), 'R5 ' + s);
  assert.ok(clr.indexOf('discardAllRealmPatches()') < clr.indexOf('storage.local.clear()'), 'R5 buffer dropped before clear');
  // R6: handlers always answer.
  for (const t of ['RESOURCE_CATALOG', 'MARKET_CACHE', 'SCM_TEST_NOTIFICATION']) {
    const h = slice(bg, `if(m?.type==='${t}')`, 'return true');
    assert.ok(/\.catch\(e=>send\(\{ok:false,error:/.test(h), 'R6 ' + t);
  }
  assert.ok(/queueEndpointSeen\(url,method,m\.captureRealm\)\.then\([^\n]*\.catch\(e=>send\(\{ok:false/.test(bg), 'R6 API_SEEN');
  // P3: one state read for an explicit realm.
  const vw = slice(bg, "if(m?.type==='GET_INCOMING_CONTRACT_VWAP_DATA'){", 'helperLatestEndpoint(store');
  assert.ok(/const realmState=\(requestedRealm!=null\|\|[^;]*\)\?s:await state\(realm\);/.test(vw), 'P3 single read');
  // P4: background reads the realm store once; page-hook emits on signature change, observer >= 30 s.
  const rc = slice(bg, 'async function saveResourceCatalog(', 'function diagnosticCostFields');
  assert.equal((rc.match(/await state\(/g) || []).length, 1, 'P4 saveResourceCatalog reads state once');
  assert.ok(/if \(force !== true && catalogSignature === lastResourceCatalogSignature\) return false;/.test(hook), 'P4 signature gate');
  assert.ok(hook.indexOf('catalogSignature === lastResourceCatalogSignature') < hook.indexOf('await imageCapture(resourceImages[id])'), 'P4 gate before image capture');
  assert.ok(/RESOURCE_CATALOG_OBSERVER_MIN_MS=30000/.test(hook), 'P4 observer throttle');
  assert.ok(/'RESOURCE_CATALOG_GET'\) emitResourceCatalog\(true\)/.test(hook), 'P4 explicit request forces emit');
  // P5: closed badges are rebuilt only when what they show changed.
  assert.ok(/if\(!host\|\|host\.__scmRow!==row\|\|\(host\.dataset\.open!=='1'&&host\.__scmSig!==badgeSignature\(candidate,mapped\)\)\)\{/.test(content), 'P5 rebuild condition');
  assert.ok(/host\.__scmSig=badgeSignature\(candidate,mapped\);/.test(content), 'P5 signature stored');
  // P6: page checks no longer read innerText; positive answers cached 5 s.
  for (const fn of ['const isIncomingPageNow=()=>{', 'const likelyContractPage=()=>{']) {
    const body = slice(content, fn, '\n  };');
    assert.ok(!/body\?\.innerText/.test(body) && /scmPageTextNoLayout\(\)/.test(body), 'P6 no innerText in ' + fn);
  }
  assert.ok(/\?5000:1500\)\)return incomingCheck\.value;/.test(content) && /\?5000:1500\)\)return contractTextCheck\.value;/.test(content), 'P6 cache');
  assert.ok(/requestIdleCallback\(runHelperChecks,\{timeout:400\}\)/.test(content), 'P6 idle-batched helper checks');
  // P6: the no-layout text walker skips script/style.
  {
    const fn = slice(content, 'function scmPageTextNoLayout(){', '\n// Exchange VWAP overlay');
    const nodes = [{ nodeValue: 'Incoming contracts', parentNode: { nodeName: 'H1' } }, { nodeValue: 'var accept=1', parentNode: { nodeName: 'SCRIPT' } }, { nodeValue: '$4.80', parentNode: { nodeName: 'TD' } }];
    const ctx = { NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 }, document: { body: {}, createTreeWalker: (b, w, f) => { const list = nodes.filter(n => f.acceptNode(n) === 1); let i = 0; return { nextNode: () => list[i++] || null }; } } };
    vm.createContext(ctx); vm.runInContext(fn + '\nthis.t=scmPageTextNoLayout;', ctx);
    assert.equal(ctx.t(), 'Incoming contracts $4.80');
  }
  console.log('integration-reliability-lag-regression ok');
})().catch(e => { console.error(e); process.exit(1); });
