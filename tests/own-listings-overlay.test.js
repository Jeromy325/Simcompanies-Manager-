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

function handlerContext(storage, store) {
  const refreshed = [];
  const ctx = {
    console, Promise, Date, Object, Array, Number, String, JSON, Map, Set, Math, Error,
    chrome: { storage: { local: { get: async q => { const o = {}; for (const [k, d] of Object.entries(q)) o[k] = k in storage ? JSON.parse(JSON.stringify(storage[k])) : d; return o; } } } },
    validRealmNumber: v => { const n = Number(v); return (v == null || v === '' || !Number.isInteger(n) || n < 0 || n > 1) ? null : n; },
    refreshMarketOrders: async r => { refreshed.push(r); return { ok: true }; },
    gameOverlayAssets: async () => ({ names: new Map([['18', 'Aluminium'], ['51', 'Car body']]), images: { 18: 'aluminium.png' }, imageBase: 'https://img/' }),
    notifyRealmStore: async () => store,
    ownListingsRefreshAt: new Map(),
  };
  vm.createContext(ctx);
  const block = slice(bg, "if(m?.type==='GET_OWN_LISTINGS_DATA'){", "if(m?.type==='GET_SELL_PRICE_INFO'){");
  vm.runInContext(fnSrc(bg, 'overlayVwap') + `\nthis.handle=(m)=>new Promise(res=>{const send=res;(()=>{${block}})();});`, ctx);
  return { handle: ctx.handle, refreshed };
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
  // 2. refresh is fire-and-forget and throttled to once a minute per realm (refreshMarketOrders keeps its 5-min cache)
  await h.handle({ type: 'GET_OWN_LISTINGS_DATA', realm: 1, refresh: true });
  await h.handle({ type: 'GET_OWN_LISTINGS_DATA', realm: 1, refresh: false });
  assert.deepEqual(h.refreshed, [1], 'one refresh request within a minute');
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
  assert.ok(mod.includes('L.refreshTimer=setInterval(()=>{if(!document.hidden&&L.open)request(true);},60000)'), 'listing asks for a fresh read once a minute while open and visible');
  const cmodTimers = slice(content, 'const Contracts=(()=>{', "if(document.readyState!=='loading')Contracts.start();");
  assert.ok(!/refreshTimer|setInterval\(\(\)=>\{if\(!document\.hidden&&C\.open\)/.test(cmodTimers), 'contracts card has no refresh timer (captured data, read on open)');
  assert.ok(bg.includes('let cid=Number(cur?.companyId)||0;'), 'refresh takes the company id from the small orders key');
  // the background handler holds no lock and writes nothing itself
  const block = slice(bg, "if(m?.type==='GET_OWN_LISTINGS_DATA'){", "if(m?.type==='GET_OUTGOING_CONTRACTS_DATA'){");
  assert.ok(!/withStorageLock|storageSet\(|rawStorageSet\(|fetch\(/.test(block), 'handler: no lock, no write, no direct fetch');
  // 5. outgoing contracts: own card and pill, read-only handler, separate from listings
  const cmod = slice(content, 'const Contracts=(()=>{', "if(document.readyState!=='loading')Contracts.start();");
  assert.ok(cmod.includes("'scm-contracts-card'") && cmod.includes("'scm-contracts-pill'") && cmod.includes("'scmCardPos:'+"), 'own card, pill and saved position');
  assert.ok(cmod.includes("type:'GET_OUTGOING_CONTRACTS_DATA',realm"), 'asks background with this tab realm');
  assert.ok(!/MutationObserver|GET_OWN_LISTINGS_DATA|scmMarketOrders/.test(cmod), 'separate from listings, no observer');
  const cblock = slice(bg, "if(m?.type==='GET_OUTGOING_CONTRACTS_DATA'){", "if(m?.type==='GET_SELL_PRICE_INFO'){");
  assert.ok(!/withStorageLock|storageSet\(|rawStorageSet\(|fetch\(/.test(cblock), 'contracts handler: read only, no lock, no write, no fetch');
  console.log('own-listings-overlay: ok');
})().catch(e => { console.error(e); process.exit(1); });
