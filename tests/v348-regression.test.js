// 2.5.348: building-card Profit / h / level matches the game's Profit Calculator.
// The game (GamePages bundle, encyclopedia resource page): units/h/level at a fixed 90 % abundance for mine/oil/quarry
// resources, labour = wage ÷ rate × admin factor (not rounded), warehouse input = cheapest lot of any quality
// (Σ cost ÷ amount, not rounded), profit/h/level = (cheapest listing − sourcing) × rate.
// Real data: the user's R2 diagnostic bundle 2026-10-24T02:09Z and the game screenshots at 02:04–02:07Z.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
assert.equal(manifest.version, '2.5.351');
const C = require('../tools-core.js');
const fx = require('./fixtures/profit-calc-2026-10-24.json');
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// --- pure core ---
assert.equal(C.GAME_PROFIT_CALC_ABUNDANCE_PCT, 90);
for (const id of [10, 14, 15, 42, 44, 68, 74, 104, 105]) assert.ok(C.isAbundanceResource(id), `abundance resource ${id}`);
for (const id of [1, 2, 16, 17, 21, 112]) assert.ok(!C.isAbundanceResource(id), `not an abundance resource ${id}`);
const lots = fx.warehouseLots;
const water = C.warehouseUnitCostAsGame(lots, 2);
near(water.unitCost, 0.3472429699537105, 1e-12, 'Water: cheapest lot (Q0), like the game ($0.35), not the Q1 lot ($0.37)');
assert.equal(water.quality, 0);
near(C.warehouseUnitCostAsGame(lots, 1).unitCost, 0.18394510478377615, 1e-12, 'Power lot Σcost ÷ amount');
near(C.warehouseUnitCostAsGame(lots, 16).unitCost, 6.059838373970286, 1e-12, 'Silicon $6.06');
near(C.warehouseUnitCostAsGame(lots, 17).unitCost, 13.49272216904235, 1e-12, 'Chemicals $13.49');
assert.equal(C.warehouseUnitCostAsGame(lots, 999), null, 'not in the warehouse');
assert.equal(C.warehouseUnitCostAsGame([{ kind: 5, amount: 10, quality: 0, cost: { market: 0, workers: 0 } }], 5), null, '$0 lot falls back to the market (game)');
const gc = fx.constants;
near(C.gameProfitCalcRatePerLevel(gc, 14, 1, { bonusPct: 8 }), 116.64088895516817, 1e-9, 'Minerals at the game calculator 90 % abundance');
near(C.gameRatePerLevel(gc, 14, 1, { bonusPct: 8, abundancePct: 88 }), 114.05, 0.005, 'game Production Calculator at its 88 % default shows 114.05');
near(C.gameProfitCalcRatePerLevel(gc, 1, 1, { bonusPct: 8 }), 2790.16, 0.005, 'Power 2,790.16');
near(C.gameProfitCalcRatePerLevel(gc, 21, 1, { bonusPct: 8 }), 44.92, 0.005, 'Electronic components 44.92');

// --- the real building-card code (dashboard.js renderPlannerProfit) run against the user's data ---
function runCard(dash, core, card, { abundancePct = null } = {}) {
  const start = dash.indexOf("const PLANNER_PROFIT_KEY='scmPlannerProfitSettingsV1';");
  const end = dash.indexOf('function renderBuildingPlanner(s,options={}){');
  assert.ok(start > 0 && end > start, 'profit card code found');
  const ls = new Map([['scmPlannerProfitSettingsV1', JSON.stringify({ adminOverheadPct: String(fx.adminOverheadPctGameScreen) })]]);
  const localStorage = { getItem: k => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)) };
  const money = v => (v == null || v === '' || !Number.isFinite(Number(v))) ? '—' : Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  const num = v => Number(v).toLocaleString('en-US', { maximumFractionDigits: 3 });
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const chrome = { runtime: { sendMessage: () => Promise.resolve({ ok: false }) } };
  const g = { SCM_TOOLS_CORE: core };
  const fn = new Function('globalThis', 'localStorage', 'chrome', 'money', 'num', 'escapeHtml', 'validRealmNumber', 'warehouseRows', 'warehouseAlertUnitCost', 'get', 'commitDashboardState', 'plannerMoney',
    dash.slice(start, end) + '\nreturn {renderPlannerProfit, last: __plannerProfitLast};');
  const api = fn(g, localStorage, chrome, money, num, esc, v => (v === 0 || v === 1 ? Number(v) : null), () => lots.map(l => ({ _id: l.kind, _quality: l.quality, _qty: l.amount, _unitCost: Object.values(l.cost).reduce((a, x) => a + x, 0) / l.amount })), (s, r) => r._unitCost, async () => ({}), () => true, money);
  const now = new Date().toISOString();
  const endpointData = { [`/api/v3/market/1/${card.productId}/`]: { receivedAt: now, data: [{ price: card.sale.price, quality: card.sale.quality }] } };
  const s = { viewRealm: 1, warehouseResources: lots, gameConstants: gc, economyStateLog: [{ s: fx.economyState }], endpointData, liveMarketPriceData: { rows: [] } };
  const ctx = { s, building: { id: card.buildingId, name: card.building, raw: { id: card.buildingId, kind: card.kind } }, product: card.productId === 21 ? 'Electronic components' : card.productId === 14 ? 'Minerals' : 'Power', productId: card.productId, quality: card.quality, level: card.level, outputPerHour: card.managerShown.unitsPerHour, eventPct: 0, abundancePct, bonusPct: fx.productionModifierPct, buildingKind: card.kind, robots: false, rateFromBatch: false, batchStarted: null, referenceRate: null, plannedInputs: card.inputs.map(i => ({ id: i.id, name: i.name, minQuality: i.quality, perOutput: i.qtyPerUnit })), transportUnits: 0, priceMap: new Map() };
  const mk = () => ({ innerHTML: '', value: '', onchange: null, addEventListener() {}, querySelector: () => mk() });
  const out = mk(), el = mk();
  el.querySelector = sel => (sel === '#plannerProfitResults' ? out : mk());
  const host = { __plannerProfitCtx: ctx, querySelector: sel => (sel === '#plannerProfit' ? el : sel === '#plannerProfitResults' ? out : null) };
  api.renderPlannerProfit(host);
  const m = out.innerHTML.match(/<strong>([^<]+)<\/strong><span>Profit \/ h \/ level<\/span>/);
  assert.ok(m, `headline rendered for ${ctx.product}: ${out.innerHTML.slice(0, 200)}`);
  return { headline: m[1], html: out.innerHTML, rec: api.last[String(card.buildingId)] };
}
const dash = read('dashboard.js');
const want = { Power: '$151.04', Minerals: '$422.05', 'Electronic Components': '$474.45' };
for (const [name, card] of Object.entries(fx.cards)) {
  const r = runCard(dash, C, card);
  assert.equal(r.headline, want[name], `${name} Profit / h / level = game ${want[name]} (was ${name === 'Power' ? '$145.09' : name === 'Minerals' ? '$522.29' : '$474.36'})`);
  near(r.rec.result.profitPerHourPerLevelGameBasis, fx.gameScreens[name].profitPerHourPerLevel, 0.005, `${name} recorded game-basis profit/h/level`);
  near(r.rec.result.profitPerUnitGameBasis, fx.gameScreens[name].profitPerUnit, 0.005, `${name} profit/unit`);
  near(r.rec.result.sourcingCostPerUnit, fx.gameScreens[name].sourcingCostPerUnit, 0.005, `${name} sourcing cost / unit`);
}
// Minerals: the card states the game's 90 % assumption; with the mine's own abundance captured it shows that figure too.
{
  const card = fx.cards.Minerals;
  const a = runCard(dash, C, card);
  assert.ok(/assumes 90% abundance \(116\.641\/h\/level\)/.test(a.html) && /abundance isn't captured yet/.test(a.html), 'note when the mine abundance is not captured');
  assert.ok(/Water Q1 × 1[\s\S]*?\$0\.35 each · warehouse, cheapest lot \(as game\)[^<]*· Q0 lot/.test(a.html), 'Water row shows the Q0 lot like the game');
  const b = runCard(dash, C, card, { abundancePct: 99.57069211725734 });
  assert.equal(b.headline, '$422.05', 'headline stays on the game basis');
  assert.equal(b.rec.gameCalc.assumedAbundancePct, 90);
  near(b.rec.gameCalc.ownRatePerLevel, 129.04460047153614, 1e-6, 'own rate at 99.57 %');
  // own: (10.80 − 4.0261 − 276 ÷ 129.0446 × 1.33353) × 129.0446
  const ownExpected = (10.8 - (20 * 0.18394510478377615 + 0.3472429699537105) - 276 / 129.04460047153614 * (1 + fx.adminOverheadPctGameScreen / 100)) * 129.04460047153614;
  near(b.rec.gameCalc.own.perLevel, ownExpected, 1e-6, 'own-abundance profit/h/level');
  assert.ok(b.html.includes(`Your building at 99.57% (129.045/h/level): $${ownExpected.toFixed(2)} / h / level`), 'own-abundance figure in the note');
}
// non-abundance products keep the building's own rate (no 90 % note)
assert.ok(!/assumes 90% abundance/.test(runCard(dash, C, fx.cards.Power).html));

// --- wiring ---
assert.ok(dash.includes('const labourPerUnit=lab?lab.workersPerUnit*(1+overhead/100):null;'), 'labour not rounded before use');
assert.ok(!dash.includes('const labourPerUnit=lab?wPU+aPU:null;'), 'old cents-rounded labour gone');
assert.ok(dash.includes("C.warehouseUnitCostAsGame(lotsAll,x.id)") && dash.includes("c.inputSource==='market'?'buy':'buy-any'"), 'warehouse inputs as the game, cheapest listing fallback');
const tc = read('tools-core.js');
assert.ok(!/fetch\(|chrome\./.test(tc.slice(tc.indexOf('const GAME_PROFIT_CALC_ABUNDANCE_PCT'), tc.indexOf('function phaseFromMeasuredRate'))), 'pure maths, no network');
assert.ok(!/\son[a-z]+="/i.test(dash.slice(dash.indexOf("const PLANNER_PROFIT_KEY"), dash.indexOf('function renderBuildingPlanner('))), 'no inline handlers');
module.exports = { runCard };
console.log('v348-regression: Power $151.04, Minerals $422.05, Electronic components $474.45 match the game');
