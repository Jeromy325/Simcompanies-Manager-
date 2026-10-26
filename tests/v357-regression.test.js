// 2.5.357: Smart insights under the Production profit card.
//  (1) best product per building, (2) input run-out with buy quantity, (3) make or buy.
// Same basis as the game's Profit Calculator: tools-core gameCalcProduct must reproduce the game screens
// ($151.04 / $422.05 / $474.45, user's R2 data 2026-10-24) and the real dashboard code is run against that data.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
assert.equal(manifest.version, '2.5.380');
const C = require('../tools-core.js');
const fx = require('./fixtures/profit-calc-2026-10-24.json');
const full = require('./fixtures/game-constants-full-2026-10-24.json');
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const lots = fx.warehouseLots;
const inputCostOf = id => { const w = C.warehouseUnitCostAsGame(lots, id); return w ? w.unitCost : null; };
const base = { economyState: fx.economyState, bonusPct: fx.productionModifierPct, adminPct: fx.adminOverheadPctGameScreen, inputCostOf };

// --- gameCalcProduct = the game's Profit Calculator (both constants sets give the same numbers) ---
for (const c of [fx.constants, full]) {
  for (const [name, card] of Object.entries(fx.cards)) {
    const r = C.gameCalcProduct({ ...base, c, resourceId: card.productId, salePrice: card.sale.price });
    assert.ok(r.ok && r.complete, `${name} computed`);
    near(r.profitPerHourPerLevel, fx.gameScreens[name].profitPerHourPerLevel, 0.005, `${name} profit/h/level = game`);
    near(r.sourcingCostPerUnit, fx.gameScreens[name].sourcingCostPerUnit, 0.005, `${name} sourcing = game`);
  }
}
{
  const r = C.gameCalcProduct({ ...base, c: full, resourceId: 21, salePrice: null });
  assert.ok(r.ok && r.profitPerHourPerLevel == null && r.salePrice == null, 'no sale price → no profit, cost still known');
  const m = C.gameCalcProduct({ ...base, c: full, resourceId: 21, salePrice: 53.5, inputCostOf: id => (id === 16 ? 6 : null) });
  assert.deepEqual(m.missing, [17], 'missing input price reported');
  assert.equal(m.complete, false);
  assert.equal(C.gameCalcProduct({ ...base, c: null, resourceId: 21 }).ok, false, 'no constants');
  // own abundance changes the rate only for abundance resources
  const a = C.gameCalcProduct({ ...base, c: full, resourceId: 14, salePrice: 10.8, abundancePct: 99.57 });
  near(a.ratePerLevel, C.gameRatePerLevel(full, 14, 1, { bonusPct: 8, abundancePct: 99.57 }), 1e-9, 'Minerals at own abundance');
  near(C.gameCalcProduct({ ...base, c: full, resourceId: 21, salePrice: 53.5, abundancePct: 50 }).ratePerLevel, 44.921, 0.001, 'abundance ignored for E-comps');
}

// --- (1) rankBuildingProducts: Electronics factory (L), every tradable product it makes ---
{
  const prices = { 21: 53.5, 20: 1000, 22: 1 };
  const ranked = C.rankBuildingProducts({ ...base, c: full, buildingKind: 'L', priceOf: id => (prices[id] != null ? { price: prices[id], quality: 0, source: 'test' } : null) });
  const ids = Object.entries(full.resources).filter(([, r]) => r.producedAt === 'L' && r.isExchangeTradable !== false).map(([k]) => Number(k));
  assert.equal(ranked.length, ids.length, 'every tradable L product listed');
  const ec = ranked.find(x => x.resourceId === 21);
  near(ec.profitPerHourPerLevel, 474.45, 0.005, 'E-comps in the ranking = card headline');
  assert.equal(ec.sale.source, 'test');
  // order: complete & priced first (desc), then incomplete priced, then unpriced
  const tier = x => (x.profitPerHourPerLevel == null ? 2 : x.complete ? 0 : 1);
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(tier(ranked[i - 1]) <= tier(ranked[i]), 'tiers ordered');
    if (tier(ranked[i - 1]) === tier(ranked[i]) && tier(ranked[i]) < 2) assert.ok(ranked[i - 1].profitPerHourPerLevel >= ranked[i].profitPerHourPerLevel, 'profit descending');
  }
  assert.ok(ranked.slice(-1)[0].profitPerHourPerLevel == null, 'unpriced last');
  assert.deepEqual(C.rankBuildingProducts({ ...base, c: full, buildingKind: '' }), []);
}

// --- (2) inputRunOut ---
{
  const ecRate = C.gameRatePerLevel(full, 21, 1, { bonusPct: 8 }) * 7;
  const powerRate = C.gameRatePerLevel(full, 1, 1, { bonusPct: 8 }) * 11;
  const mineRate = C.gameRatePerLevel(full, 14, 1, { bonusPct: 8, abundancePct: 99.57 }) * 9;
  const buildings = [
    { id: 1, name: 'Electronics factory #1', kind: 'L', level: 7, productId: 21, quality: 2 },
    { id: 2, name: 'Power plant #1', kind: 'E', level: 11, productId: 1, quality: 3 },
    { id: 3, name: 'Mine #1', kind: 'M', level: 9, productId: 14, quality: 2 },
    { id: 4, name: 'Idle', kind: 'L', level: 3, productId: null }
  ];
  const rows = C.inputRunOut({ c: full, buildings, economyState: 1, bonusPct: 8, lots, hours: 24, abundanceOf: b => (b.id === 3 ? 99.57 : null) });
  const by = id => rows.find(r => r.id === id);
  const si = by(16), ch = by(17), pw = by(1), wa = by(2);
  near(si.usePerHour, 3 * ecRate, 1e-9, 'Silicon use = 3 × E-comps rate');
  assert.equal(si.minQuality, 1, 'E-comps Q2 needs Q1+ inputs');
  const siStock = lots.filter(l => l.kind === 16 && l.quality >= 1).reduce((a, l) => a + l.amount, 0);
  assert.equal(si.stock, siStock);
  near(si.hoursLeft, siStock / (3 * ecRate), 1e-9, 'Silicon hours left');
  assert.equal(si.buyQty, Math.max(0, Math.ceil(3 * ecRate * 24 - siStock)), 'buy covers 24 h');
  near(ch.usePerHour, ecRate, 1e-9, 'Chemicals');
  // Power: the mine uses 20 per Mineral, the power plant makes it → net use, here covered
  near(pw.usePerHour, 20 * mineRate, 1e-6, 'Power use by the mine (own abundance)');
  near(pw.madePerHour, powerRate, 1e-6, 'Power made by the power plant');
  assert.equal(pw.hoursLeft, null, 'own production covers Power');
  assert.equal(pw.buyQty, 0);
  assert.ok(wa.usePerHour > 0, 'Water used by the mine');
  // unknown abundance → the game calculator's 90 %
  const r90 = C.inputRunOut({ c: full, buildings: [buildings[2]], economyState: 1, bonusPct: 8, lots });
  near(r90.find(r => r.id === 1).usePerHour, 20 * 9 * C.gameRatePerLevel(full, 14, 1, { bonusPct: 8, abundancePct: 90 }), 1e-6, '90 % when abundance unknown');
  // sorted: shortest first, covered last
  const h = rows.map(r => r.hoursLeft);
  for (let i = 1; i < h.length; i++) assert.ok(h[i - 1] == null ? h[i] == null : h[i] == null || h[i - 1] <= h[i], 'sorted by hours left');
  assert.deepEqual(C.inputRunOut({ c: null, buildings }), []);
}

// --- (3) makeOrBuy ---
{
  const m = C.makeOrBuy(6, 8);
  assert.equal(m.verdict, 'make'); near(m.savesPerUnit, 2, 1e-12, 'saves'); near(m.savesPct, 25, 1e-9, 'pct of market');
  const b = C.makeOrBuy(9, 8);
  assert.equal(b.verdict, 'buy'); near(b.savesPerUnit, 1, 1e-12, 'buy cheaper by');
  assert.equal(C.makeOrBuy(null, 8).verdict, 'cannot-make');
  assert.equal(C.makeOrBuy(6, null).verdict, 'no-price');
}

// --- the real dashboard code (renderPlannerInsights) run against the user's data ---
{
  const dash = read('dashboard.js');
  const start = dash.indexOf("const PLANNER_PROFIT_KEY='scmPlannerProfitSettingsV1';");
  const end = dash.indexOf('function renderBuildingPlanner(s,options={}){');
  assert.ok(start > 0 && end > start && dash.slice(start, end).includes('function renderPlannerInsights(host)'), 'insights code inside the profit block');
  const ls = new Map([['scmPlannerProfitSettingsV1', JSON.stringify({ adminOverheadPct: String(fx.adminOverheadPctGameScreen) })]]);
  const localStorage = { getItem: k => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)) };
  const money = v => (v == null || v === '' || !Number.isFinite(Number(v))) ? '—' : Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  const num = v => Number(v).toLocaleString('en-US', { maximumFractionDigits: 3 });
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const names = { 1: 'Power', 2: 'Water', 14: 'Minerals', 16: 'Silicon', 17: 'Chemicals', 20: 'Processors', 21: 'Electronic components', 22: 'Batteries', 44: 'Sand' };
  const fn = new Function('globalThis', 'localStorage', 'chrome', 'money', 'num', 'escapeHtml', 'validRealmNumber', 'warehouseRows', 'warehouseAlertUnitCost', 'get', 'commitDashboardState', 'plannerMoney', 'plannerResourceNameById', 'plannerActiveProductionEvent', 'plannerAbundancePct',
    dash.slice(start, end) + '\nreturn {renderPlannerInsights, plannerRunOutHtml};');
  const api = fn({ SCM_TOOLS_CORE: C }, localStorage, { runtime: { sendMessage: () => Promise.resolve({ ok: false }) } }, money, num, esc, v => (v === 0 || v === 1 ? Number(v) : null), () => [], () => null, async () => ({}), () => true, money,
    (r, id) => names[id] || `#${id}`, () => 0, () => null);
  const now = new Date().toISOString();
  const book = (id, rows) => ({ receivedAt: now, data: rows });
  const endpointData = {
    '/api/v3/market/1/21/': book(21, [{ price: 53.5, quality: 0 }, { price: 60, quality: 2 }]),
    '/api/v3/market/1/20/': book(20, [{ price: 1, quality: 0 }]),
    '/api/v3/market/1/16/': book(16, [{ price: 5.5, quality: 0 }, { price: 7, quality: 1 }]),
    '/api/v3/market/1/17/': book(17, [{ price: 14, quality: 1 }])
  };
  const s = { viewRealm: 1, warehouseResources: lots, gameConstants: full, economyStateLog: [{ s: 1 }], endpointData, liveMarketPriceData: { rows: [] }, vwapData: { rows: [] } };
  const owned = [
    { id: 55685482, name: 'Electronics factory #1', kind: 'L', level: 7, currentResourceId: 21, currentQuality: 2, raw: { id: 55685482 } },
    { id: 52641362, name: 'Power plant #1', kind: 'E', level: 11, currentResourceId: 1, currentQuality: 3, raw: { id: 52641362 } }
  ];
  const ctx = { s, building: { id: 55685482, name: 'Electronics factory #1' }, buildingKind: 'L', productId: 21, level: 7, bonusPct: 8, robots: false, priceMap: new Map(), owned, recipes: [], runHours: 24 };
  const el = { innerHTML: '' };
  const host = { __plannerProfitCtx: ctx, querySelector: sel => (sel === '#plannerInsights' ? el : null) };
  api.renderPlannerInsights(host);
  const html = el.innerHTML + api.plannerRunOutHtml(ctx);
  assert.ok(!/Inputs: run-out/.test(el.innerHTML) && !/Silicon<small>/.test(el.innerHTML), '2.5.358: run-out is not on the Production card');
  assert.ok(/Electronic components <em class="si-tag">current<\/em>[\s\S]*?\$474\.45/.test(html), 'current product row shows the card value $474.45');
  assert.ok(/already the best product/.test(html) || /Switching to <b>/.test(html), 'verdict line');
  const si = html.match(/Silicon<small>([^]*?)<\/small><\/div><div class="pp-value"><span class="(si-\w+)">([^<]+)<\/span>/);
  assert.ok(si, 'Silicon run-out row');
  assert.ok(/Stock [\d,]+ \(Q1\+\) · uses [\d,.]+\/h/.test(si[1]), 'stock and use shown');
  assert.ok(/\$7\.00 Q1/.test(si[1]) || !/buy /.test(si[1]), 'buy price = cheapest listing at Q1+ ($7.00), not the Q0 $5.50');
  assert.ok(!/<span class="si-good">Make<\/span>|<span class="si-bad">Buy<\/span>/.test(si[1]), 'no make/buy line: no Silicon factory owned');
  // own a Silicon producer → make-or-buy appears
  const siKind = full.resources['16'].producedAt;
  ctx.owned = [...owned, { id: 9, name: 'Silicon maker', kind: siKind, level: 1, currentResourceId: null, raw: { id: 9 } }];
  const si2 = api.plannerRunOutHtml(ctx).match(/Silicon<small>([^]*?)<\/small>/);
  assert.ok(/(Make|Buy)<\/span>: /.test(si2[1]) || /no market price captured|your cost unknown — no price for/.test(si2[1]), `make-or-buy line for Silicon: ${si2[1]}`);
  assert.ok(/your cost unknown — no price for Sand/.test(si2[1]), 'names the missing input (Sand)');
  // Sand priced → full verdict; own cost = Power (warehouse) × 3 + Sand × 2 + labour, as gameCalcProduct
  s.endpointData['/api/v3/market/1/44/'] = book(44, [{ price: 0.5, quality: 0 }]);
  const si3 = api.plannerRunOutHtml(ctx).match(/Silicon<small>([^]*?)<\/small>/)[1];
  const own = C.gameCalcProduct({ c: full, resourceId: 16, economyState: 1, bonusPct: 8, adminPct: fx.adminOverheadPctGameScreen, inputCostOf: id => (id === 44 ? 0.5 : inputCostOf(id)) }).sourcingCostPerUnit;
  const verdict = own <= 7 ? 'Make' : 'Buy';
  assert.ok(new RegExp(`${verdict}</span>: `).test(si3) && si3.includes(money(own)) && si3.includes('$7.00'), `make-or-buy ${verdict}: own ${own} vs market $7.00 → ${si3}`);
  // Production Time 48 h > Silicon's ~41 h of stock → buy quantity priced at the Q1+ listing
  ctx.runHours = 48; const ro48 = api.plannerRunOutHtml(ctx);
  const si4 = ro48.match(/Silicon<small>([^]*?)<\/small>/)[1];
  assert.ok(/ · buy [\d,]+ for 48 h ≈ \$[\d,.]+ \(\$7\.00 Q1\)/.test(si4), `buy line: ${si4}`);
  assert.ok(/class="si-warn">41\.2 h</.test(ro48), 'under the Production Time → orange');
  // no constants → message, no crash
  ctx.s = { ...s, gameConstants: null };
  api.renderPlannerInsights(host);
  assert.ok(/Game constants not loaded yet/.test(el.innerHTML));
  // CSP: no inline handlers in the new code
  assert.ok(!/\son[a-z]+="/i.test(dash.slice(dash.indexOf('function plannerInsightsData'), end)), 'no inline event handlers');
}
console.log('v357 smart insights: ok');
