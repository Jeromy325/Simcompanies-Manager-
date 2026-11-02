'use strict';
// 2.5.330: accounting previous-day comparison, warehouse cost grouping, SimcoTools trend,
// price movers, budget plan, realm-switch exclusion, tab memory, sleeping-tab diagnostics.
const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');
const root = path.join(__dirname, '..'); const rd = f => fs.readFileSync(path.join(root, f), 'utf8');
const dash = rd('dashboard.js'), bg = rd('background.js'), hook = rd('page-hook.js'), html = rd('dashboard.html'), ui = rd('tools-ui.js'), popup = rd('popup.js');
function fnSource(src, name) {
  const i = src.indexOf(`function ${name}(`); assert.ok(i >= 0, `missing function ${name}`);
  let depth = 0, j = src.indexOf('){', i) + 1;
  for (let k = j; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); } }
  throw new Error('unbalanced ' + name);
}
const ctx = vm.createContext({ console });
vm.runInContext([fnSource(dash, 'accountingDailyHistory'), fnSource(dash, 'accountingPreviousPeriod'), fnSource(dash, 'accountingComparisonBase'), fnSource(bg, 'simcoTrendFromSummary'),
  'function money(v){if(v==null||v==="")return "—";const n=Number(v);return Number.isFinite(n)?"$"+n.toFixed(2):"—"}', 'function escapeHtml(v){return String(v)}', fnSource(dash, 'activeProductionCostCells'),
  'var activeProductionCostEntries=()=>globalThis.__entries;'].join('\n'), ctx);

// --- accounting: previous completed day from the game's history, sales/expenses from a verified ledger
const H = 3600e3, d0 = Date.parse('2026-10-21T01:10:00Z'), d1 = Date.parse('2026-10-22T01:16:22Z'), d2 = Date.parse('2026-10-23T01:11:23Z');
const overview = [{ date: '2026-10-21 01:10:00+00:00', evaProfit: 100, total: 900, liabilities: 0, currentAssets: 500 }, { date: '2026-10-22 01:16:22+00:00', evaProfit: 414048, total: 25053663, liabilities: 0, currentAssets: 11902603 }, { date: '2026-10-23 01:11:23+00:00', evaProfit: -29473, total: 25150403, liabilities: 0, currentAssets: 11975193 }];
const detail = [{ date: '2026-10-22 01:16:22+00:00', cashAndReceivables: 2774327, inventory: 9128276, total: 25053663, liabilities: 0 }, { date: '2026-10-23 01:11:23+00:00', cashAndReceivables: 1792834, inventory: 10182359, total: 25150403, liabilities: 0 }];
const ledger = [[d0 - H, 5, 'm'], [d0 + H, 1000, 'm'], [d0 + 2 * H, 200, 't'], [d0 + 3 * H, 15, 'e'], [d0 + 4 * H, -700, 'p'], [d1 + H, 50, 'm'], [d1 + 2 * H, -30, 'f']];
const hist = vm.runInContext(`accountingDailyHistory(${JSON.stringify(overview)},${JSON.stringify(detail)},${JSON.stringify(ledger)})`, ctx);
assert.equal(hist.length, 3);
assert.deepEqual([hist[1].sales, hist[1].cashIn, hist[1].expenses], [1200, 1215, 700], 'day 2 sales exclude royalties (e); expenses are cash out');
assert.equal(hist[0].sales, undefined, 'first day has no start boundary, so no sales total');
const prev = vm.runInContext(`accountingPreviousPeriod(${JSON.stringify(hist)},'2026-10-23T01:11:23.420962+00:00')`, ctx);
assert.equal(prev.profit, 414048); assert.equal(prev.cash, 2774327); assert.equal(prev.inventory, 9128276); assert.equal(prev.assets, 25053663); assert.equal(prev.revenue, 1200); assert.equal(prev.expenses, 700);
const unverified = vm.runInContext(`accountingDailyHistory(${JSON.stringify(overview)},${JSON.stringify(detail)},${JSON.stringify(ledger)},{sales:true,expenses:false})`, ctx);
assert.equal(unverified[1].expenses, undefined, 'an incomplete ledger never produces an expenses figure');
assert.equal(vm.runInContext(`accountingComparisonBase({previousPeriod:null})`, ctx), null, 'no fake baseline when the game has no earlier day');
// v2.5.382 overview rows: acctNum keeps a missing figure as null (never $0); no earlier figure = no change shown.
assert.match(dash, /function acctNum\(v\)\{if\(v==null\|\|v===''\)return null;/, 'null previous values are not treated as $0');
assert.match(dash, /if\(p==null\)return '<span class="acct-row-chg acct-flat">No earlier figure captured<\/span>';/);
assert.match(dash, /function money\(v\)\{if\(v==null\|\|v===''\)return '—';/, 'money(null) shows a dash, not $0.00');
assert.match(html, /id="accountingHistory"/, 'Last 8 days table on the Accounting tab');

// --- warehouse: buildings at the same cost collapse into one line
ctx.__entries = [1, 2, 3, 4, 5, 6, 7].map(i => ({ id: 119, quality: 4, unitCost: 30.4613, building: `Mill #${i}` }));
const cells = vm.runInContext(`activeProductionCostCells({}, {_id:119,_quality:4,_unitCost:29.83})`, ctx);
assert.equal((cells.costHtml.match(/active-cost-line/g) || []).length, 1, 'seven mills at the same cost = one line');
assert.match(cells.costHtml, /7 Mills/); assert.match(cells.diffHtml, /\+\$0\.63/);
ctx.__entries = [{ id: 118, quality: 4, unitCost: 0.74, building: 'Farm #4 (Coffee Bean)' }, { id: 118, quality: 4, unitCost: 0.74, building: 'Farm #1 (Coffee Bean)' }, { id: 118, quality: 4, unitCost: 0.80, building: 'Farm #2 (Coffee Bean)' }];
const c2 = vm.runInContext(`activeProductionCostCells({}, {_id:118,_quality:4,_unitCost:0.74})`, ctx);
assert.match(c2.costHtml, /2 Farms/); assert.match(c2.costHtml, /Farm #2 \(Coffee Bean\)/);

// --- SimcoTools summary (real response shape from the user's network capture) -> compact trend
const real = { summary: { realmId: 1, resourceId: 112, quality: 3, timestamp: '2026-10-23T02:56:56.68729Z', price: 2300, lastDayCandlestick: { date: '2026-10-22T00:00:00Z', close: 2260, vwap: 2219.274, previousVWAPPercentageChange: 0.008492283419052926, previousClosePercentageChange: 0.06103286384976526 }, latestClosePrices: [{ datetime: '2026-10-20T03:45:00Z', closePrice: 2180 }, { datetime: '2026-10-22T03:30:00Z', closePrice: 2200 }, { datetime: '2026-10-22T18:45:00Z', closePrice: 2300 }] } };
const tr = vm.runInContext(`simcoTrendFromSummary(${JSON.stringify(real.summary)})`, ctx);
assert.equal(tr.closes.length, 3); assert.equal(tr.closes[2][1], 2300); assert.ok(Math.abs(tr.day.vwapChangePct - 0.8492) < 1e-3);
assert.match(bg, /trend:snap\.trend\|\|null,fetchedAt/, 'current-price rows keep the trend');
assert.match(bg, /m\?\.type==='PRICE_HISTORY'/, 'Price history message handler');
assert.doesNotMatch(fnSource(bg, 'getPriceHistory'), /withRealmWriteLock|enqueueApiStorage/, 'price history never holds a realm storage lane');

// --- tools core: movers from trend, budget plan
const C = require(path.join(root, 'tools-core.js'));
const now = Date.parse('2026-10-23T03:51:58Z');
const mv = C.moversFromTrend([{ resourceId: 112, quality: 3, price: 2300, fetchedAt: new Date(now).toISOString(), trend: { closes: tr.closes, day: tr.day } }, { resourceId: 1, quality: 0, price: 1, fetchedAt: new Date(now).toISOString() }]);
assert.equal(mv.ranked.length, 1, 'rows without trend are skipped');
assert.ok(Math.abs(mv.ranked[0].change['24h'] - (2300 / 2200 - 1) * 100) < 1e-9, '24h = now vs the close in effect 24 h earlier');
assert.equal(C.priceAt([[1, 5], [3, 7]], 2), 5); assert.equal(C.priceAt([[5, 5]], 2), null);
const al = C.allocate([{ name: 'A', cost: 100000, profitPerHour: 50 }, { name: 'B', cost: 20000, profitPerHour: 14 }, { name: 'C', cost: 50000, profitPerHour: 30 }], { budget: 75000 });
assert.deepEqual(al.plan.picked, ['B', 'C']); assert.equal(al.plan.spent, 70000); assert.equal(al.plan.profitPerHour, 44);
assert.match(ui, /class="tl-help"/); assert.ok((ui.match(/class="tl-help"/g) || []).length >= 3, 'ROI, loan and allocation explain themselves');
assert.match(ui, /type: 'PRICE_HISTORY'/);

// --- page hook: switching realm is not a stock change (caused HTTP 400 refreshes)
assert.match(hook, /\\\/realm\\\/\\d\+\\\/\(\?:switch\|sync\)/);
const isStock = new Function('location', 'URL', `${hook.slice(hook.indexOf('const isStockMutationUrl'), hook.indexOf('};', hook.indexOf('const isStockMutationUrl')) + 2)} return isStockMutationUrl;`)({ href: 'https://www.simcompanies.com/landscape/', origin: 'https://www.simcompanies.com' }, URL);
assert.equal(isStock('/api/v1/realm/0/switch/', 'POST'), false); assert.equal(isStock('/api/v1/realm/1/sync/', 'POST'), false);
assert.equal(isStock('/api/v2/order/take/54312828/', 'POST'), true, 'collect from building (captured on the phone) refreshes the warehouse');

// --- tab memory, popup reuse, background-update strip, sleeping game tab
assert.match(dash, /SCM_LAST_TAB_KEY='scmDashboardLastTabV1'/); assert.match(popup, /chrome\.tabs\.query\(\{url:base\+'\*'\}\)/);
assert.doesNotMatch(bg.slice(bg.indexOf("m?.type==='OPEN_MANAGER_TAB'"), bg.indexOf("m?.type==='SAVE_REALM_FIELD'")), /update\(existing\.id,\{url/, 'reopening the Manager no longer reloads it');
assert.match(html, /id="liveUpdates"/); assert.ok(html.indexOf('live-updates.js') > html.indexOf('dashboard.js"'));
assert.match(dash, /async function pickAwakeGameTab\(stage,button\)/); assert.match(dash, /chrome\.tabs\.reload\(tab\.id\)/);
assert.equal((dash.match(/tab=await pickAwakeGameTab\(stage,button\);/g) || []).length, 2, 'Redux and DOM diagnostics wake a sleeping game tab');
assert.equal((dash.match(/scmDownloadToast\(a\.download,blob\.size\)/g) || []).length, 3, 'every download shows a confirmation');
for (const f of ['live-updates.js', 'tools-ui.js', 'dashboard.js']) assert.doesNotMatch(rd(f).split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n'), /\son(?:click|error|load|change|input)=["'`]/i, `${f}: no inline handlers (extension CSP)`);
console.log('v330-regression: all assertions passed');
