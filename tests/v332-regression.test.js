// 2.5.332: building-card sale price = cheapest exchange listing of ANY quality, as the game's Profit Calculator
// ("Assumed wholesale price (based on the market)"; user-verified: $2,230 = cheapest Bulldozer listing, a Q0).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.356');
const dash = read('dashboard.js'), bg = read('background.js');

// run the real plannerMarketPrice against the user's exchange listing
const start = dash.indexOf('function plannerAge(ms)'), end = dash.indexOf('function plannerWarehouseCost(');
const plannerMarketPrice = new Function('validRealmNumber', dash.slice(start, end) + 'return plannerMarketPrice;')(v => (v === 0 || v === 1 ? v : null));
const now = new Date().toISOString();
const book = [{ price: 2270, quality: 0 }, { price: 2260, quality: 2 }, { price: 2250, quality: 2 }, { price: 2240, quality: 1 }, { price: 2240, quality: 2 }, { price: 2230, quality: 0 }, { price: 2300, quality: 3 }];
const s = { viewRealm: 1, endpointData: { '/api/v3/market/1/112/': { receivedAt: now, data: book } }, liveMarketPriceData: { rows: [] } };
const any = plannerMarketPrice(s, new Map([['112:3', 2300]]), 112, 3, 'sell-any');
assert.equal(any.price, 2230, 'cheapest listing of any quality, as the game');
assert.equal(any.quality, 0);
assert.ok(/any quality/.test(any.source));
assert.equal(plannerMarketPrice(s, new Map(), 112, 3, 'sell').price, 2300, 'exact-quality mode unchanged');
// no order book: cheapest SimcoTools price across captured qualities, labelled
const noBook = { viewRealm: 1, endpointData: {}, liveMarketPriceData: { rows: [] } };
const fb = plannerMarketPrice(noBook, new Map([['112:3', 2300], ['112:1', 2260]]), 112, 3, 'sell-any');
assert.equal(fb.price, 2260); assert.ok(/cheapest captured quality/.test(fb.source));
// game-basis check with the user's screenshot numbers: 2230 − 1721.47 = 508.53
assert.ok(Math.abs(2230 - (4 * 9.54 + 627.39 + 2 * 482.32 + 67.82 + 23.46) - 508.53) < 1e-9);

// the card uses sell-any and asks for a fresh order book when the stored one is > 15 min old
assert.ok(dash.includes("plannerMarketPrice(ctx.s,ctx.priceMap,productId,ctx.quality,'sell-any')"));
assert.ok(dash.includes("type:'FETCH_EXCHANGE_ORDER_BOOK'") && dash.includes('15*60000'));
// background: game's own endpoint through the page, saved via saveData, throttled, no lock held during fetch
const fn = bg.slice(bg.indexOf('async function fetchExchangeOrderBookForRealm('), bg.indexOf('function hasUsableMarketRows('));
assert.ok(fn.includes('await pageGet(path,target)') && fn.includes('await saveData(path,response.data'));
assert.ok(fn.indexOf('pageGet') < fn.indexOf('saveData'), 'network first, then the locked save');
assert.ok(!/withRealmLock|storageLock|enqueueRealm/.test(fn), 'no storage lock around the fetch');
assert.ok(bg.includes('ORDER_BOOK_REFETCH_MS=5*60*1000'));
assert.ok(bg.includes("m?.type==='FETCH_EXCHANGE_ORDER_BOOK'"));
console.log('v332-regression: all assertions passed');
