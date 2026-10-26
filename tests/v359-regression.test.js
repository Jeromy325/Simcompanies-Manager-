// 2.5.359: #5 economy-phase planner + alert, #7 upgrade payback, #4 smart sell price, #6 contract verdict badge.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.378');
const C = require('../tools-core.js');
const N = require('../notify-core.js');
const fx = require('./fixtures/profit-calc-2026-10-24.json');
const full = require('./fixtures/game-constants-full-2026-10-24.json');
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const lots = fx.warehouseLots;
const inputCostOf = id => { const w = C.warehouseUnitCostAsGame(lots, id); return w ? w.unitCost : null; };
const dash = read('dashboard.js'), bg = read('background.js'), content = read('content.js'), html = read('dashboard.html');

// ---- #5 economy phases ----
{
  const args = { c: full, resourceId: 21, bonusPct: 8, adminPct: fx.adminOverheadPctGameScreen, salePrice: 53.5, inputCostOf };
  const ph = C.phaseProfits(args);
  near(ph[1], 474.45, 0.005, 'normal = the game screen');
  for (const st of [0, 2]) near(ph[st], C.gameCalcProduct({ ...args, economyState: st }).profitPerHourPerLevel, 1e-9, `phase ${st}`);
  // rate ∝ (345 / SALARY_MID)^sm → recession fastest, boom slowest (game formula)
  assert.ok(C.gameRatePerLevel(full, 21, 0, { bonusPct: 8 }) > C.gameRatePerLevel(full, 21, 1, { bonusPct: 8 }) && C.gameRatePerLevel(full, 21, 1, { bonusPct: 8 }) > C.gameRatePerLevel(full, 21, 2, { bonusPct: 8 }));
  near(C.phaseRateRatio(full, 'L', 1, 2), Math.pow(700 / 745, 1.1), 1e-12, 'L normal→boom factor');
  near(C.phaseRateRatio(full, 'L', 1, 2) * C.gameRatePerLevel(full, 21, 1, { bonusPct: 8 }), C.gameRatePerLevel(full, 21, 2, { bonusPct: 8 }), 1e-9, 'factor matches the rate formula');
  assert.equal(C.phaseProfits({ c: null }), null);
  const m = N.economyChanged({ from: 1, to: 2, realm: 1, constants: full, buildings: [{ kind: 'L', name: 'Electronics factory #1' }, { kind: 'L', name: 'Electronics factory #2' }, { kind: 'M', name: 'Mine #1' }] });
  assert.equal(m.title, 'Economy: Normal → Boom');
  assert.ok(m.message.includes(`Electronics factory −${((1 - Math.pow(700 / 745, 1.1)) * 100).toFixed(1)}%`) && m.message.endsWith('R2'), m.message);
  assert.equal((m.message.match(/Electronics factory/g) || []).length, 1, 'one line per building kind');
  // background fires it only on a real change, behind the setting (default on); Alerts tab row
  assert.ok(/economyChange:true\};/.test(bg), 'default on');
  assert.ok(/if\(last&&Number\.isFinite\(Number\(last\.s\)\)&&Number\(last\.s\)!==st&&next\.length&&Number\(next\[next\.length-1\]\.s\)===st\)\{[\s\S]{0,120}if\(cfg\.economyChange\)/.test(bg), 'fires on change only');
  assert.ok(html.includes('<input data-nf="economyChange" type="checkbox">'), 'Alerts row');
}

// ---- #7 upgrade payback ----
assert.deepEqual(C.upgradePayback({ cost: 1000, gainPerHour: 50 }), { hours: 20 });
assert.equal(C.upgradePayback({ cost: 1000, gainPerHour: -5 }).reason, 'not-profitable');
assert.equal(C.upgradePayback({ cost: null, gainPerHour: 5 }).reason, 'no-cost');

// ---- #4 sell price advice ----
{
  const now = Date.parse('2026-10-24T12:00:00Z');
  const listings = [
    { id: 1, price: 0.24, quality: 0, seller: { id: 9 } },          // lower quality: not competing for a Q1 lot
    { id: 2, price: 0.25, quality: 1, seller: { id: 5294950 } },    // yours (seller id)
    { id: 3, price: 0.251, quality: 2, seller: { id: 8 } },          // yours (own order id)
    { id: 4, price: 0.252, quality: 1, seller: { id: 7 } },
    { id: 5, price: 0.26, quality: 3, seller: { id: 6 } }
  ];
  const history = [{ date: '2026-10-10', vwap: 0.1 }, { date: '2026-10-18', vwap: 0.255 }, { date: '2026-10-20', vwap: 0.27 }, { date: '2026-10-24', vwap: 0.26 }];
  const a = C.sellPriceAdvice({ listings, quality: 1, history, unitCost: 0.2, feePct: 4, companyId: 5294950, ownIds: [3], now });
  assert.equal(a.suggested, 0.252, 'cheapest Q1+ listing that is not yours');
  assert.equal(a.cheapestQuality, 1); assert.equal(a.competing, 2);
  near(a.range.low, 0.255, 1e-12, '7-day low (the 10-10 point is too old)'); near(a.range.high, 0.27, 1e-12, 'high'); assert.equal(a.range.days, 3);
  near(a.net, 0.252 * 0.96, 1e-12, 'after fee');
  assert.deepEqual(a.warnings, ['below-7d-low'], 'below the 7-day low, above cost');
  const b = C.sellPriceAdvice({ listings, quality: 1, history, unitCost: 0.25, feePct: 4, companyId: 5294950, ownIds: [3], now });
  assert.deepEqual(b.warnings, ['below-7d-low', 'below-cost'], '0.242 net < 0.25 cost');
  const e = C.sellPriceAdvice({ listings: [], quality: 1, history: [], now });
  assert.equal(e.suggested, null); assert.equal(e.range, null); assert.deepEqual(e.warnings, []);
  // background handler: refreshes a stale book through the game tab (no lock), excludes your listings, daily history of id:q
  const h = bg.slice(bg.indexOf("if(m?.type==='GET_SELL_PRICE_INFO')"), bg.indexOf("if(m?.type==='GET_INCOMING_CONTRACT_VWAP_DATA')"));
  assert.ok(/fetchExchangeOrderBookForRealm\(realm,id\)\.catch/.test(h) && /history:store\.history\?\.\[simcoVwapHistoryKey\(id,q\)\]/.test(h) && /ownIds:own\.map/.test(h) && /feePct:C\.listingFeePct\(own\)/.test(h), 'handler wiring');
  // content: the card's price block (real code) and the Fill → input[name="price"]
  const s1 = content.indexOf('  const sellMoney=v=>'), s2 = content.indexOf('  const removeSellCard=()=>{');
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const api = new Function('esc', 'num', content.slice(s1, s2) + '\nreturn {sellPriceHtml};')(esc, num);
  const out = api.sellPriceHtml({ ...a, refreshing: false }, 1);
  assert.ok(/data-sq-price="0\.252"/.test(out) && /\$0\.252<\/b>/.test(out), out);
  assert.ok(/Cheapest Q1\+ listing · 2 competing/.test(out) && /7-day VWAP \$0\.255–\$0\.270/.test(out) && /your cost \$0\.200 · you get \$0\.242 after 4\.0% fee/.test(out), out);
  assert.ok(/class="scm-sq-warn">Below the 7-day low</.test(out));
  assert.equal(api.sellPriceHtml(null, 1), '');
  assert.ok(/Loading the exchange listings/.test(api.sellPriceHtml({ suggested: null, refreshing: true, warnings: [] }, 1)));
  assert.ok(/amount\?\.closest\('form'\)\?\.querySelector\('input\[name="price"\]'\)/.test(content), 'fills the form price input');
}

// ---- #6 contract verdict ----
{
  const v = C.contractVerdict({ price: 40, quantity: 100, exchangePrice: 42, stockCost: 41.64 });
  assert.equal(v.verdict, 'cheaper'); near(v.savesPerUnit, 2, 1e-12, 'per unit'); near(v.savesTotal, 200, 1e-9, 'total'); near(v.vsStockPerUnit, 1.64, 1e-9, 'vs stock');
  assert.equal(C.contractVerdict({ price: 45, quantity: 10, exchangePrice: 42 }).verdict, 'dearer');
  assert.equal(C.contractVerdict({ price: 0 }), null);
  // the real badge code
  // the real badge code (2.5.362: compact badge + details popup lines)
  const b1 = content.indexOf('  const marketLabel=record=>'), b2 = content.indexOf('  const closePopup=()=>', b1);
  const pre = content.slice(content.indexOf('  const priceText=v=>'), content.indexOf('\n', content.indexOf('  const priceText=v=>')));
  const money = v => Number.isFinite(Number(v)) ? '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
  const document = { createElement: () => ({ dataset: {}, className: '', textContent: '', title: '', setAttribute() {} }) };
  const api = new Function('document', 'money', pre + '\n' + content.slice(b1, b2) + '\nreturn {badgeFor,detailLines};')(document, money);
  const r1 = { price: 40, quantity: 100, quality: 2, marketPrice: 41, verdict: v };
  const x = api.badgeFor(r1);
  assert.ok(x.className.endsWith(' cheap'), x.className);
  assert.equal(x.textContent, '▼ 2.44% below market price ⓘ');
  const d1 = api.detailLines(r1).map(l => l.v).join(' · ');
  assert.ok(/2\.44% cheaper than market price · saves \$2\.000\/u vs exchange \$42\.000 \(\$200\.00\) · \$41\.640\/u/.test(d1), d1);
  const r2 = { price: 40, quantity: 100, quality: 2, marketPrice: 39, verdict: C.contractVerdict({ price: 40, quantity: 100, exchangePrice: 38 }) };
  assert.ok(api.badgeFor(r2).className.endsWith(' expensive') && /exchange \$38\.000 is \$2\.000\/u cheaper \(\$200\.00\)/.test(api.detailLines(r2).map(l => l.v).join(' · ')));
  const zz = api.badgeFor({ price: 40, quantity: 1, marketPrice: 41, marketPriceSource: 'realm-vwap' });
  assert.equal(zz.textContent, '▼ 2.44% below VWAP ⓘ', 'VWAP fallback is labelled');
  assert.ok(/\.scm-contract-vwap-badge\{text-align:left!important/.test(content) && !/\.scm-contract-vwap-badge\{position:static[^}]*white-space:nowrap/.test(content), 'badge wraps on phones');
  const h = bg.slice(bg.indexOf("if(m?.type==='GET_INCOMING_CONTRACT_VWAP_DATA')"), bg.indexOf("if(m?.type==='GET_CONTRACT_HELPER_DATA')"));
  assert.ok(/asked<3/.test(h) && /Number\(r\?\.quality\)>=c\.quality/.test(h) && /contractVerdict\(\{price:c\.price,quantity:c\.quantity,exchangePrice:c\.exchangePrice,stockCost:c\.stockCost\}\)/.test(h), 'handler wiring');
}

// ---- dashboard: phases in Best product, Upgrade payback (real code) ----
{
  const start = dash.indexOf("const PLANNER_PROFIT_KEY='scmPlannerProfitSettingsV1';");
  const end = dash.indexOf('function renderBuildingPlanner(s,options={}){');
  const ls = new Map([['scmPlannerProfitSettingsV1', JSON.stringify({ adminOverheadPct: String(fx.adminOverheadPctGameScreen) })]]);
  const localStorage = { getItem: k => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)) };
  const money = v => (v == null || v === '' || !Number.isFinite(Number(v))) ? '—' : Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  const num = v => Number(v).toLocaleString('en-US', { maximumFractionDigits: 3 });
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const names = { 1: 'Power', 2: 'Water', 14: 'Minerals', 16: 'Silicon', 17: 'Chemicals', 20: 'Processors', 21: 'Electronic components', 44: 'Sand', 101: 'Reinforced concrete', 102: 'Bricks', 108: 'Planks', 111: 'Construction units' };
  const plan = (s, b, from, to) => ({ items: [{ id: 101, name: 'Reinforced concrete', required: 4 * 24 * from }, { id: 102, name: 'Bricks', required: 55 * 24 * from }, { id: 108, name: 'Planks', required: 16 * 24 * from }, { id: 111, name: 'Construction units', required: 24 * from }] });
  const fn = new Function('globalThis', 'localStorage', 'chrome', 'money', 'num', 'escapeHtml', 'validRealmNumber', 'warehouseRows', 'warehouseAlertUnitCost', 'get', 'commitDashboardState', 'plannerMoney', 'plannerResourceNameById', 'plannerActiveProductionEvent', 'plannerAbundancePct', 'constructionMaterialPlan',
    dash.slice(start, end) + '\nreturn {renderPlannerInsights};');
  const api = fn({ SCM_TOOLS_CORE: C }, localStorage, { runtime: { sendMessage: () => Promise.resolve({ ok: false }) } }, money, num, esc, v => (v === 0 || v === 1 ? Number(v) : null), () => [], () => null, async () => ({}), () => true, money, (r, id) => names[id] || `#${id}`, () => 0, () => null, plan);
  const now = new Date().toISOString();
  const book = rows => ({ receivedAt: now, data: rows });
  const endpointData = { '/api/v3/market/1/21/': book([{ price: 53.5, quality: 0 }]), '/api/v3/market/1/20/': book([{ price: 900, quality: 0 }]), '/api/v3/market/1/1/': book([{ price: 0.252, quality: 0 }]),
    '/api/v3/market/1/101/': book([{ price: 160, quality: 0 }]), '/api/v3/market/1/102/': book([{ price: 2.1, quality: 0 }]), '/api/v3/market/1/108/': book([{ price: 9, quality: 0 }]), '/api/v3/market/1/111/': book([{ price: 2400, quality: 0 }]) };
  const s = { viewRealm: 1, warehouseResources: lots, gameConstants: full, economyStateLog: [{ s: 1 }], endpointData, liveMarketPriceData: { rows: [] }, vwapData: { rows: [] } };
  const owned = [
    { id: 55685482, name: 'Electronics factory #1', kind: 'L', level: 7, currentResourceId: 21, currentQuality: 2, raw: { id: 55685482 } },
    { id: 52641362, name: 'Power plant #1', kind: 'E', level: 11, currentResourceId: 1, currentQuality: 3, raw: { id: 52641362 } },
    { id: 9, name: 'Max one', kind: 'E', level: 20, currentResourceId: 1, currentQuality: 0, raw: { id: 9 } }
  ];
  const ctx = { s, building: { id: 55685482, name: 'Electronics factory #1' }, buildingKind: 'L', productId: 21, level: 7, bonusPct: 8, robots: false, priceMap: new Map(), owned, recipes: [], runHours: 24 };
  const els = { '#plannerInsights': { innerHTML: '' }, '#plannerPayback': { innerHTML: '' } };
  const host = { __plannerProfitCtx: ctx, querySelector: sel => els[sel] || null };
  api.renderPlannerInsights(host);
  const ins = els['#plannerInsights'].innerHTML, pay = els['#plannerPayback'].innerHTML;
  const ecPh = C.phaseProfits({ c: full, resourceId: 21, bonusPct: 8, adminPct: fx.adminOverheadPctGameScreen, salePrice: 53.5, inputCostOf });
  assert.ok(ins.includes(`<span class="si-phase">Recession ${money(ecPh[0])} · <b>Normal $474.45</b> · Boom ${money(ecPh[2])}</span>`), `phase line: ${ins}`);
  // payback: E-comps level 7 → 8: materials = 24 costUnits × 7 × (4×160 + 55×2.1 + 16×9 + 1×2400) / profit 474.45 per h
  const cost = 24 * 7 * (4 * 160 + 55 * 2.1 + 16 * 9 + 2400);
  // 2.5.360: + upgrade time (level × buildDuration, no production) and the extra admin (1/170 on every producing level's wages)
  const wage = k => 345 * full.buildings[k].salaryModifier;
  const wageAll = wage('L') * 7 + wage('E') * 11 + wage('E') * 20;
  const upE = 7 * full.buildings.L.buildDuration / 3600, extraE = (wageAll + wage('L')) / 170;
  const hours = upE + (cost + 474.45 * 7 * upE) / (474.45 - extraE);
  const rowE = pay.match(/Electronics factory #1 <em class="si-tag">L7→8<\/em><small>([^<]*)<\/small><\/div><div class="pp-value"><span class="(si-\w+)">([^<]+)<\/span>/);
  assert.ok(rowE, pay);
  assert.ok(rowE[1].includes(`materials ${money(cost)}`) && rowE[1].includes('+$474.45/h from Electronic components'), rowE[1]);
  assert.equal(rowE[3], hours < 48 ? `${num(+hours.toFixed(1))} h` : `${num(+(hours / 24).toFixed(1))} d`, 'payback hours');
  assert.ok(/Max one <em class="si-tag">L20<\/em><small>already level 20/.test(pay), 'max level row');
  const gP = C.gameCalcProduct({ c: full, resourceId: 1, economyState: 1, bonusPct: 8, adminPct: fx.adminOverheadPctGameScreen, salePrice: 0.252, inputCostOf }).profitPerHourPerLevel;
  const upP = 11 * full.buildings.E.buildDuration / 3600, extraP = (wageAll + wage('E')) / 170;
  const powerHours = gP - extraP > 0 ? upP + (24 * 11 * (4 * 160 + 55 * 2.1 + 16 * 9 + 2400) + gP * 11 * upP) / (gP - extraP) : Infinity;
  assert.equal(pay.indexOf('Power plant #1') < pay.indexOf('Electronics factory #1'), powerHours < hours, 'sorted by payback (shortest first)');
  assert.ok(pay.indexOf('Max one') > pay.indexOf('Electronics factory #1') && pay.indexOf('Max one') > pay.indexOf('Power plant #1'), 'max level last');
  assert.ok(/one more level adds 1\/170 to the base overhead/.test(pay) && /\− \$[\d,.]+\/h more admin/.test(pay) && /upgrade [\d.]+ (h|d), \$[\d,.]+ profit lost/.test(pay), 'admin and upgrade time counted');
  assert.ok(dash.includes('<div class="planner-section-label">Upgrade payback <span>(all buildings · next level)</span></div><div id="plannerPayback"'), 'own collapsible section');
}
console.log('v359 four upgrades: ok');
