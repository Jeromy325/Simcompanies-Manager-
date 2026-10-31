// Game-page "My listings" card: background GET_OWN_LISTINGS_DATA (run in a vm over the real handler source with a
// fake chrome.storage) and the content.js card wiring (source checks: no own MutationObserver, minimise reuse,
// storage.onChanged on scmMarketOrders:<realm>, pointer-event drag, remembered state).
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');
const bg = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const fx = require('./fixtures/game-constants-2026-10-23.json');
const slice = (src, start, end) => { const i = src.indexOf(start); assert.ok(i >= 0, 'missing ' + start); const j = src.indexOf(end, i + start.length); assert.ok(j > i, 'missing end ' + end); return src.slice(i, j); };
const fnSrc = (src, name) => { const i = src.indexOf(`function ${name}(`); assert.ok(i >= 0, name); let d = 0, j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1); } throw new Error(name); };

function handlerContext(storage, store, clock = { t: Date.now() }) {
  const refreshed = [], contractRefreshed = [], storeReads = { n: 0 };
  class FakeDate extends Date { static now() { return clock.t; } }
  const ctx = {
    console, Promise, Date: FakeDate, Object, Array, Number, String, JSON, Map, Set, Math, Error,
    chrome: { storage: { local: { get: async q => { const o = {}; for (const [k, d] of Object.entries(q)) o[k] = k in storage ? JSON.parse(JSON.stringify(storage[k])) : d; return o; } } } },
    validRealmNumber: v => { const n = Number(v); return (v == null || v === '' || !Number.isInteger(n) || n < 0 || n > 1) ? null : n; },
    refreshMarketOrders: async r => { refreshed.push(r); return { ok: true }; },
    refreshOutgoingContracts: async r => { contractRefreshed.push(r); return { ok: true }; },
    OWN_LISTINGS_REFRESH_GAP_MS: 12000,
    gameOverlayAssets: async () => ({ names: new Map([['18', 'Aluminium'], ['51', 'Car body']]), images: { 18: 'aluminium.png' }, imageBase: 'https://img/' }),
    notifyRealmStore: async () => { storeReads.n++; return store; },
    OUTGOING_CONTRACTS_FRESH_MS: 60000,
    ownListingsRefreshAt: new Map(),
  };
  vm.createContext(ctx);
  const block = slice(bg, "if(m?.type==='GET_OWN_LISTINGS_DATA'){", "if(m?.type==='GET_SELL_PRICE_INFO'){");
  vm.runInContext(fnSrc(bg, 'overlayVwap') + '\n' + fnSrc(bg, 'helperArray') + `\nthis.handle=(m)=>new Promise(res=>{const send=res;(()=>{${block}})();});`, ctx);
  return { handle: ctx.handle, refreshed, contractRefreshed, clock, storeReads };
}

(async () => {
  // 1. rows: names/images from the bundled assets, total = quantity × price, VWAP comparison from this realm's vwapData
  const at = new Date().toISOString();
  const storage = { 'scmMarketOrders:1': { companyId: 5294950, orders: fx.marketOrders, at } };
  const store = { vwapData: { sourceRealm: 1, rows: [{ resourceId: 18, quality: 2, value: 19.5 }] } };
  const h = handlerContext(storage, store);
  const r = await h.handle({ type: 'GET_OWN_LISTINGS_DATA', realm: 1, refresh: true });
  assert.ok(r.ok && r.realm === 1 && r.at === at, 'ok response for realm 1');
  assert.equal(r.rows.length, fx.marketOrders.filter(o => o.quantity > 0).length, 'one row per listing');
  const al = r.rows.find(x => x.kind === 18);
  assert.equal(al.name, 'Aluminium'); assert.equal(al.image, 'https://img/aluminium.png');
  assert.equal(al.total, 6486 * 20, 'total value = quantity × price');
  assert.equal(al.vwap, 19.5); assert.ok(Math.abs(al.vsVwapPct - (20 - 19.5) / 19.5 * 100) < 1e-9, 'price vs VWAP %');
  const car = r.rows.find(x => x.kind === 51);
  assert.equal(car.name, 'Car body'); assert.equal(car.vwap, null, 'no VWAP for that quality → no comparison'); assert.equal(car.vsVwapPct, null);
  assert.equal(car.image, '', 'no image file → empty image');
  // 2. refresh is fire-and-forget and throttled to once per 12 s per realm
  assert.ok(/const OWN_LISTINGS_REFRESH_GAP_MS=12000\b/.test(bg), 'listings refresh gap is 12 s');
  await h.handle({ type: 'GET_OWN_LISTINGS_DATA', realm: 1, refresh: true });
  await h.handle({ type: 'GET_OWN_LISTINGS_DATA', realm: 1, refresh: false });
  h.clock.t += 11000;
  await h.handle({ type: 'GET_OWN_LISTINGS_DATA', realm: 1, refresh: true });
  assert.deepEqual(h.refreshed, [1], 'one refresh request within 12 s');
  h.clock.t += 1500;
  await h.handle({ type: 'GET_OWN_LISTINGS_DATA', realm: 1, refresh: true });
  assert.deepEqual(h.refreshed, [1, 1], 'a new refresh after 12 s');
  await h.handle({ type: 'GET_OWN_LISTINGS_DATA', realm: 0, refresh: true });
  assert.deepEqual(h.refreshed, [1, 1, 0], 'throttle is per realm');
  // 3. other realm's VWAP is never used; missing orders → missing:true; bad realm → not ok
  const h2 = handlerContext({ 'scmMarketOrders:0': { orders: fx.marketOrders, at } }, { vwapData: { sourceRealm: 1, rows: [{ resourceId: 18, quality: 2, value: 19.5 }] } });
  const r0 = await h2.handle({ type: 'GET_OWN_LISTINGS_DATA', realm: 0 });
  assert.ok(r0.rows.every(x => x.vwap === null), 'no cross-realm VWAP');
  assert.deepEqual(h2.refreshed, [], 'no refresh unless asked');
  const r1 = await h2.handle({ type: 'GET_OWN_LISTINGS_DATA', realm: 1 });
  assert.ok(r1.ok && r1.missing === true && r1.rows.length === 0, 'not read yet → missing');
  assert.equal((await h2.handle({ type: 'GET_OWN_LISTINGS_DATA', realm: 5 })).ok, false, 'invalid realm rejected');

  // 4. content.js card wiring
  const mod = slice(content, 'const Listings=(()=>{', "if(document.readyState!=='loading')Listings.start();");
  assert.ok(!/MutationObserver/.test(mod), 'the card adds no MutationObserver of its own');
  assert.ok(/'scm-listings-card':'\.scm-ls-head'/.test(content), 'minimise (scm-card-min-v1) covers the listings card');
  assert.ok(content.includes('#scm-listings-card.scm-card-min>:not(.scm-ls-head),#scm-contracts-card.scm-card-min>:not(.scm-ls-head){display:none!important}'), 'minimised card shows the header only');
  assert.ok(content.includes("b.closest(Object.keys(MIN_CARDS).map(id=>'#'+id).join(','))"), 'min click handler follows MIN_CARDS');
  assert.ok(mod.includes("changes[`scmMarketOrders:${realm}`]") && mod.includes('chrome.storage?.onChanged?.addListener'), 'live update from the storage key');
  assert.ok(mod.includes("type:'GET_OWN_LISTINGS_DATA',realm,refresh"), 'asks background with this tab realm');
  assert.ok(/pointerdown/.test(mod) && /pointermove/.test(mod) && /pointercancel/.test(mod) && /touch-action:none/.test(mod), 'pointer-event drag, touch friendly');
  assert.ok(mod.includes("'scm-listings-card-v1'") && mod.includes("'scmCardPos:'+"), 'open state and position remembered in page localStorage');
  assert.ok(mod.includes('placeCard(el,pos.x,pos.y)'), 'positions clamped to the viewport');
  assert.ok(mod.includes("el.dataset.scmOwned='1'"), 'card/pill marked as SCM-owned (ignored by other observers)');
  assert.ok(mod.includes('if(s===L.sig&&have)return;'), 'renders only when the data changes');
  assert.ok(mod.includes('if(r===L.realm)return;'), 'realm re-announcements do not reset the card');
  assert.ok(mod.includes('L.refreshTimer=setInterval(()=>{if(!document.hidden&&L.open)request(true);},15000)'), 'listing asks for a fresh read every 15 s while open and visible');
  assert.ok(bg.includes('let cid=Number(cur?.companyId)||0;'), 'refresh takes the company id from the small orders key');
  // the background handler holds no lock and writes nothing itself
  const block = slice(bg, "if(m?.type==='GET_OWN_LISTINGS_DATA'){", "if(m?.type==='GET_OUTGOING_CONTRACTS_DATA'){");
  assert.ok(!/withStorageLock|storageSet\(|rawStorageSet\(|fetch\(/.test(block), 'handler: no lock, no write, no direct fetch');
  // 5. outgoing contracts: own card and pill, read-only handler, separate from listings
  const cmod = slice(content, 'const Contracts=(()=>{', "if(document.readyState!=='loading')Contracts.start();");
  assert.ok(cmod.includes("'scm-contracts-card'") && cmod.includes("'scm-contracts-pill'") && cmod.includes("'scmCardPos:'+"), 'own card, pill and saved position');
  assert.ok(cmod.includes("type:'GET_OUTGOING_CONTRACTS_DATA',realm,refresh"), 'asks background with this tab realm and the refresh flag');
  assert.ok(cmod.includes('C.refreshTimer=setInterval(()=>{if(!document.hidden&&C.open)request(true);},15000)'), 'contracts card asks for a fresh read every 15 s while open and visible');
  assert.ok(cmod.includes('chrome.storage?.onChanged?.addListener') && cmod.includes("changes[`scmOutgoingContracts:${realm}`]") && cmod.includes("area!=='local'"), 'contracts card follows scmOutgoingContracts:<realm>');
  assert.ok(cmod.includes("const setOpen=open=>{C.open=open;saveOpen();C.sig='';paint();if(open)request(true);}"), 'opening the card asks for a fresh read');
  assert.ok(!/MutationObserver|GET_OWN_LISTINGS_DATA|scmMarketOrders/.test(cmod), 'separate from listings, no observer');
  const cblock = slice(bg, "if(m?.type==='GET_OUTGOING_CONTRACTS_DATA'){", "if(m?.type==='GET_SELL_PRICE_INFO'){");
  assert.ok(!/withStorageLock|storageSet\(|rawStorageSet\(|fetch\(|pageGet\(/.test(cblock), 'contracts handler: read only, no lock, no write, no direct fetch');

  // 6. GET_OUTGOING_CONTRACTS_DATA picks the newer of the captured endpointData and scmOutgoingContracts:<realm>
  const older = new Date(Date.now() - 600000).toISOString(), newer = new Date(Date.now() - 5000).toISOString();
  const capStore = (at, data) => ({ endpointData: { '/api/v3/contracts-outgoing/me/': { status: 200, receivedAt: at, data } } });
  const capData = [{ id: 1, kind: 18, quality: 2, quantity: 10, price: 5 }];
  const readData = [{ id: 2, kind: 51, quality: 0, quantity: 3, price: 100 }, { id: 3, kind: 18, quality: 1, quantity: 4, price: 6 }];
  let hc = handlerContext({ 'scmOutgoingContracts:1': { data: readData, at: newer } }, capStore(older, capData));
  let rc = await hc.handle({ type: 'GET_OUTGOING_CONTRACTS_DATA', realm: 1 });
  assert.ok(rc.ok && rc.at === newer, 'newer small key wins (at)');
  assert.deepEqual(rc.rows.map(x => x.id), [2, 3], 'rows from the newer small key');
  assert.equal(rc.rows[0].name, 'Car body'); assert.equal(rc.rows[0].total, 300);
  assert.deepEqual(hc.contractRefreshed, [], 'no read unless refresh:true');
  assert.equal(hc.storeReads.n, 0, 'fresh small key (< 60 s): the large realm store is not read');
  // a fresh small key answers even if a capture is a little newer (no realm store read at all)
  const fresh30 = new Date(Date.now() - 30000).toISOString(), cap1 = new Date(Date.now() - 1000).toISOString();
  hc = handlerContext({ 'scmOutgoingContracts:1': { data: readData, at: fresh30 } }, capStore(cap1, capData));
  rc = await hc.handle({ type: 'GET_OUTGOING_CONTRACTS_DATA', realm: 1 });
  assert.ok(rc.at === fresh30 && rc.rows.length === 2 && hc.storeReads.n === 0, 'fresh key answered without the realm store');
  // stale small key (> 60 s): compared with the capture, newer wins
  hc = handlerContext({ 'scmOutgoingContracts:1': { data: readData, at: older } }, capStore(newer, capData));
  rc = await hc.handle({ type: 'GET_OUTGOING_CONTRACTS_DATA', realm: 1, refresh: true });
  assert.ok(rc.ok && rc.at === newer, 'stale key: newer capture wins (at)');
  assert.deepEqual(rc.rows.map(x => x.id), [1], 'rows from the newer capture');
  assert.equal(hc.storeReads.n, 1, 'stale key falls back to the realm store');
  assert.deepEqual(hc.contractRefreshed, [1], 'refresh:true starts refreshOutgoingContracts for this realm');
  const stale90 = new Date(Date.now() - 90000).toISOString();
  hc = handlerContext({ 'scmOutgoingContracts:1': { data: readData, at: stale90 } }, capStore(older, capData));
  rc = await hc.handle({ type: 'GET_OUTGOING_CONTRACTS_DATA', realm: 1 });
  assert.ok(rc.at === stale90 && rc.rows.length === 2 && hc.storeReads.n === 1, 'stale key still wins over an older capture');
  hc = handlerContext({ 'scmOutgoingContracts:1': { data: readData, at: newer } }, {});
  rc = await hc.handle({ type: 'GET_OUTGOING_CONTRACTS_DATA', realm: 1 });
  assert.ok(rc.at === newer && rc.rows.length === 2, 'small key alone is used');
  rc = await hc.handle({ type: 'GET_OUTGOING_CONTRACTS_DATA', realm: 0 });
  assert.ok(rc.ok && rc.missing === true && rc.rows.length === 0, 'other realm key not used → missing');
  assert.equal(hc.storeReads.n, 1, 'missing key falls back to the realm store');
  // card: `at` alone does not re-render; the ago text is updated in place
  assert.ok(!/const signature=d=>JSON\.stringify\(\[[^\]]*d\?\.at/.test(cmod), 'contracts signature leaves out at');
  assert.ok(cmod.includes("if(s===C.sig&&have){const el=C.open&&C.data&&have.querySelector('.scm-ls-ago');if(el)el.textContent=ago(C.data.at);return;}"), 'unchanged contracts only update the ago text');

  // 7. refreshOutgoingContracts reads through pageGet and writes only scmOutgoingContracts:<realm>, throttled per realm
  {
    const writes = [], gets = []; let now = 1e9;
    class D2 extends Date { static now() { return now; } }
    const c2 = {
      Date: D2, Map, Number, String, Promise,
      validRealmNumber: v => { const n = Number(v); return (v == null || v === '' || !Number.isInteger(n) || n < 0 || n > 1) ? null : n; },
      pageGet: async (p, r) => { gets.push([p, r]); return { ok: true, status: 200, data: [{ id: 9 }] }; },
      rawStorageSet: async o => { writes.push(o); },
      outgoingContractsRefreshAt: new Map(), OUTGOING_CONTRACTS_REFRESH_GAP_MS: 12000,
    };
    vm.createContext(c2);
    const fsrc = fnSrc(bg, 'refreshOutgoingContracts');
    assert.ok(!/withStorageLock|saveData\(|\bstorageSet\(|fetch\(/.test(fsrc), 'refreshOutgoingContracts: no lock, no realm-store write, no direct fetch');
    vm.runInContext('async ' + fsrc + '\nthis.run=refreshOutgoingContracts;', c2);
    assert.equal((await c2.run(1)).ok, true);
    assert.deepEqual(gets, [['/api/v3/contracts-outgoing/me/', 1]], 'reads the outgoing contracts through the game tab');
    assert.equal(writes.length, 1); assert.deepEqual(Object.keys(writes[0]), ['scmOutgoingContracts:1'], 'writes only the small key');
    assert.deepEqual(writes[0]['scmOutgoingContracts:1'].data, [{ id: 9 }]);
    assert.ok(!isNaN(Date.parse(writes[0]['scmOutgoingContracts:1'].at)), 'with an ISO time');
    assert.equal((await c2.run(1)).throttled, true, 'second read within 12 s is throttled');
    now += 1000; await c2.run(1, 0); assert.equal(gets.length, 2, 'minGap 0 reads at once');
    c2.pageGet = async () => ({ ok: false, status: 500 }); now += 20000;
    assert.equal((await c2.run(1)).ok, false); assert.equal(writes.length, 2, 'a failed read writes nothing');
    assert.equal((await c2.run(7)).ok, false, 'invalid realm rejected');
  }

  // 8. STOCK_MUTATION_COMPLETE schedules scheduleOwnOrdersRefresh, which reads both sources once after a burst
  const smBlock = slice(bg, 'if(realm!=null){scheduleWarehouseRefreshAfterStockMutation(realm,150);', 'send({ok:true});return true}');
  assert.ok(smBlock.includes('scheduleOwnOrdersRefresh(realm)'), 'STOCK_MUTATION_COMPLETE schedules the own-orders refresh');
  {
    const timers = new Map(); let tid = 0; const calls = [];
    const c3 = {
      Map, Number, Date,
      validRealmNumber: v => { const n = Number(v); return (v == null || v === '' || !Number.isInteger(n) || n < 0 || n > 1) ? null : n; },
      setTimeout: (f, ms) => { const id = ++tid; timers.set(id, { f, ms }); return id; },
      clearTimeout: id => { timers.delete(id); },
      ownOrdersRefreshTimers: new Map(), ownListingsRefreshAt: new Map(),
      refreshMarketOrders: async (r, a) => { calls.push(['orders', r, a]); },
      refreshOutgoingContracts: async (r, a) => { calls.push(['contracts', r, a]); },
    };
    vm.createContext(c3);
    vm.runInContext(fnSrc(bg, 'scheduleOwnOrdersRefresh') + '\nthis.run=scheduleOwnOrdersRefresh;', c3);
    c3.run(1); c3.run(1); c3.run(1); c3.run(9);
    assert.equal(timers.size, 1, 'a burst collapses into one pending read; invalid realm ignored');
    const [t] = timers.values(); assert.ok(t.ms > 0 && t.ms <= 2000, 'short debounce');
    t.f();
    assert.deepEqual(calls, [['orders', 1, 0], ['contracts', 1, 0]], 'reads listings and contracts uncached');
    assert.ok(c3.ownListingsRefreshAt.has(1), 'card refresh throttle restarts after the action read');
  }
  console.log('own-listings-overlay: ok');
})().catch(e => { console.error(e); process.exit(1); });
