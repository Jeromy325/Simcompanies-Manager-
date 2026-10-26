// 2.5.361: monitor × collapses (never hides); performance fixes measured with a CPU-throttled fake game page:
// extension main-thread time on the game page 4.1 s → 0.6 s per 30 s (no storage listener on the game page, page-text
// checks throttled); image cache 151 per-image writes → 1; API_SEEN writes batched; no storage listener in the worker.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.391');
const lu = read('live-updates.js'), cs = read('content.js'), bg = read('background.js'), dash = read('dashboard.js');

// 1. monitor: × = small dot; a monitor hidden by the old × comes back once as the dot; no − button
assert.ok(lu.includes("host.querySelector('.scm-monitor-hide').addEventListener('click', e => { e.stopPropagation(); setMode('mini'); });"), '× collapses to the dot');
assert.ok(!lu.includes('scm-monitor-min"'), 'single button');
assert.ok(/r\.scmMonitorGameMode === 'hidden' && !r\.scmMonitorHideMigrated\) \{ chrome\.storage\.local\.set\(\{ scmMonitorGameMode: 'mini', scmMonitorHideMigrated: true \}\)/.test(lu), 'hidden → dot once');
// 2. game page: no chrome.storage.onChanged listener at all (live-updates on the game page polls a small key)
assert.ok(!/chrome\.storage\.onChanged/.test(cs), 'content.js has no storage listener');
const luCode = lu.replace(/\/\/[^\n]*/g, '');
assert.equal((luCode.match(/chrome\.storage\.onChanged\.addListener/g) || []).length, 1, 'one listener, Manager only');
assert.ok(lu.includes('  if (!GAME) (globalThis.scmOnStorageChanged || (fn => chrome.storage.onChanged.addListener(fn)))'), 'guarded by !GAME');
assert.ok(lu.includes("load('poll'); return;") && lu.includes("const got = await chrome.storage.local.get(GAME ? { [key]: [], scmMonitorGameMode: 'bar' } : { [key]: [] });"), 'game page polls jobs + mode');
// 3. content: the per-mutation page-text check reads innerText at most once per 1.5 s per URL; URL decides first
assert.ok(/if\(\/contract\/i\.test\(path\)\)return true;[\s\S]{0,200}now-contractTextCheck\.at<1500\)return contractTextCheck\.value;/.test(cs), 'contract page check throttled');
assert.ok(/incomingCheck\.path===path&&now-incomingCheck\.at<1500/.test(cs), 'incoming page check throttled');
// 4. worker: no storage listeners; memos cleared by its own writes
assert.ok(!/chrome\.storage\.onChanged\.addListener/.test(bg.replace(/\/\/[^\n]*/g, '')), 'no storage listener in the service worker');
assert.equal((bg.match(/globalThis\.__scmOwnWriteHooks\?\.push\(/g) || []).length, 3, 'three memo hooks');
assert.ok(bg.indexOf('chrome.storage.local.set=(items,...rest)=>') < bg.indexOf('const rawStorageSet=chrome.storage.local.set.bind('), 'wrapper installed before rawStorageSet binds');
// 5. images: one write per run, own key only; weekly validation guard
const f = bg.slice(bg.indexOf('async function fetchAndCacheResourceImage('), bg.indexOf('async function syncAllResourceImages('));
assert.ok(!/storageSet\(|withRealmWriteLock/.test(f), 'single image never rewrites the realm store');
assert.ok(/if\(batch\)\{if\(!sameImage\)batch\.cache\[sid\]=dataUrl;batch\.meta\[sid\]=metaNext;\}/.test(f), 'batched; unchanged image data not rewritten');
assert.ok(/await Promise\.all\(workers\);\n  await saveResourceImages\(batch\.cache,batch\.meta\);/.test(bg), 'one write after the run');
assert.ok(/scmResourceImagesValidatedAt[\s\S]{0,80}<6\.5\*24\*3600e3\)return;/.test(bg), 'validation at most weekly (not 1 min after every update)');
// 6. API_SEEN batched
assert.ok(bg.includes("queueEndpointSeen(url,method,m.captureRealm).then(()=>send({ok:true,queued:true}));") && /Date\.now\(\)-Date\.parse\(e\.seenAt\|\|0\)>10\*60e3/.test(bg) && /setTimeout\(function flush\(\)\{if\(coreSyncActive\(\)\)\{pendingEndpointSeenTimer=setTimeout\(flush,20000\);return;\}pendingEndpointSeenTimer=0;flushEndpointSeen\(\)\.catch\(\(\)=>\{\}\);\},20000\)/.test(bg), 'seen endpoints flushed every 20 s, repeats skipped');
// 7. Manager: catalog / captured-image lookups memoized
assert.ok(dash.includes('const __scmCatalogMemo=new WeakMap(),__scmImageIndexMemo=new WeakMap(),__scmFlatMemo=new WeakMap();') && /image=scmCapturedImageIndex\(s,\[s\.buildings,s\.gameState,s\.endpointData\]\)\.get\(Number\(id\)\)\|\|null;/.test(dash));
// functional: the image index returns the same first match the old flatten().find() did
{
  const s1 = dash.indexOf('function pick(o,keys)'), s2 = dash.indexOf('const FALLBACK_RESOURCE_NAMES');
  const m1 = dash.indexOf('const __scmCatalogMemo='), m2 = dash.indexOf('function catalogEntriesBuild(s){');
  const api = new Function(dash.slice(s1, s2) + dash.slice(m1, m2) + '\nreturn {scmCapturedImageIndex,flattenObjects,pick};')();
  const s = { buildings: [{ kind: 21, image: 'images/resources/ecomps.png' }], gameState: null, endpointData: { a: { data: [{ resourceId: 21, img: 'images/resources/other.png' }, { kind: 16, icon: 'images/resources/silicon.png' }, { kind: 5, image: 'x/notres.png' }] } } };
  const idx = api.scmCapturedImageIndex(s, [s.buildings, s.gameState, s.endpointData]);
  for (const id of [21, 16, 5, 99]) {
    const old = api.flattenObjects([s.buildings, s.gameState, s.endpointData]).find(o => { const img = api.pick(o, ['image', 'icon', 'iconUrl', 'imageUrl', 'picture', 'img']); if (!img || !/(?:^|\/)images\/resources\//i.test(String(img))) return false; const oid = api.pick(o, ['kind', 'resourceId', 'productId', 'resource', 'product']); return oid != null && Number(oid) === id; });
    assert.equal(idx.get(id) || null, old ? api.pick(old, ['image', 'icon', 'iconUrl', 'imageUrl', 'picture', 'img']) : null, `same image for ${id}`);
  }
  assert.equal(api.scmCapturedImageIndex(s, [s.buildings, s.gameState, s.endpointData]), idx, 'memoized per captured object');
}
console.log('v361 monitor × + performance: ok');
