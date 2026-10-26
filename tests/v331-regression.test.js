// 2.5.331: production cost history, background-strip in-place updates, profit rounding as the game,
// hidden-tab listener pause, Market changes, compact contracts, capital allocation shorthand, diagnostics.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
assert.equal(manifest.version, '2.5.390');
const C = require('../tools-core.js');

// --- production cost history (pure core) ---
const buildings = [{ id: 7, name: 'Power plant #1', busy: { started: '2026-10-23T10:00:00Z', resource: { kind: 1, quality: 0, unitCost: 0.18, amount: 5000 } } }, { id: 8, name: 'Idle' }];
const hist = [{ kind: 1, quality: 0, price: 0.17, datetime: '2026-10-22T10:00:00Z', amount: 4900 }, { kind: 1, quality: 0, price: 0.181, datetime: '2026-10-23T10:00:03Z', amount: 5000 }, { kind: 1, quality: 0, price: 0, datetime: '2026-10-21T10:00:00Z' }];
const e1 = C.productionCostEntriesFromHistory(7, hist, 'Power plant #1');
assert.equal(e1.length, 2, 'zero-cost history rows are ignored');
let m = C.mergeProductionCostHistory([], e1);
assert.equal(m.added, 2);
m = C.mergeProductionCostHistory(m.list, C.productionCostEntriesFromBuildings(buildings));
assert.equal(m.added, 0, 'the running batch and its history row (3 s apart) are the same run');
assert.equal(m.list.length, 2);
const sum = C.productionCostSummary(m.list, 1, 0);
assert.equal(sum.last.c, 0.17); assert.equal(sum.current.c, 0.18);
assert.ok(Math.abs(sum.diff - 0.01) < 1e-9, 'Power last $0.17 → now $0.18 = +$0.01');
assert.equal(C.productionCostSummary(m.list, 1, 1), null, 'other quality has no runs');
const again = C.mergeProductionCostHistory(m.list, C.productionCostEntriesFromBuildings(buildings));
assert.equal(again.added + again.changed, 0, 'idempotent');
const cap = C.mergeProductionCostHistory([], Array.from({ length: 30 }, (_, i) => C.productionCostEntriesFromHistory(1, [{ kind: 1, quality: 0, price: 1 + i, datetime: new Date(Date.UTC(2026, 0, 1) + i * 3600e3).toISOString() }])[0]), 10);
assert.equal(cap.list.length, 10); assert.equal(cap.list[9].c, 30, 'cap keeps the newest runs');

// background wiring: history stored in its own key via a serial queue, from buildings + history endpoint, seeded once
const bg = read('background.js');
assert.ok(/function queueProductionCostHistory\(realm,entries(?:,opts=\{\})?\)/.test(bg));
assert.ok(bg.includes('scmProductionCostHistory:${Number(realm)}'));
assert.ok(/patch\.buildings=rows;queueProductionCostHistory\(targetRealm/.test(bg), 'buildings capture feeds the history');
assert.ok(/buildings\\\/\(\\d\+\)\\\/history/.test(bg), 'history endpoint feeds the history');
assert.ok(bg.includes("scmProductionCostHistorySeededV1"), 'one-time seed from already captured data');
assert.ok(!/queueProductionCostHistory[^\n]*await fetch|await pageGet[^\n]*queueProductionCostHistory/.test(bg), 'no network work in the history writer');

// --- dashboard ---
const dash = read('dashboard.js'), html = read('dashboard.html'), css = read('styles.css');
assert.ok(dash.includes('function productionCostHistoryCell(s,r)') && dash.includes('data-pch='), 'history cell with link');
assert.ok(dash.includes('function openProductionCostHistory') && dash.includes('class="pch-chart"'), 'popup with line chart');
assert.ok(html.includes('<th>Production cost</th>'), 'warehouse column added');
assert.ok(dash.includes('function warehouseHeadCost(r)') && css.includes('.wh-head-cost'), 'cost at top right of warehouse cards');
// profit: warehouse unit costs and labour parts rounded to cents (game: 4×9.54 + 627.39 + 2×482.32 + 67.82 + 23.46 = 1721.47)
assert.ok(dash.includes('price:Math.round(Number(c)*100)/100'), 'warehouse input cost rounded to cents');
// 2.5.348: the game's Profit Calculator uses labour unrounded (game code B = wage ÷ rate × admin factor); cents only in the display.
assert.ok(dash.includes('const labourPerUnit=lab?lab.workersPerUnit*(1+overhead/100):null;'), 'labour unrounded, as the game');
const r2 = v => Math.round(v * 100) / 100;
const game = 4 * r2(9.5354) + r2(627.391) + 2 * r2(482.3204) + r2(67.82) + r2(67.82 * 0.3459);
assert.ok(Math.abs(game - 1721.47) < 1e-9, `rounded sum matches the game's sourcing cost (${game})`);
const res = C.buildingProfit({ unitsPerHour: 26.452, level: 4, salePrice: 2200, inputs: [{ name: 'Steel', qtyPerUnit: 4, unitPrice: 9.54 }, { name: 'Car body', qtyPerUnit: 1, unitPrice: 627.39 }, { name: 'Combustion engine', qtyPerUnit: 2, unitPrice: 482.32 }], labourPerUnit: 91.28, exchangeFeePct: 4, transportUnits: 0, transportUnitCost: 0 });
const gameUnit = res.profitPerUnit + res.feePerUnit + res.contractDiscountPerUnit + res.transportPerUnit;
assert.ok(Math.abs(gameUnit - 478.53) < 0.005, `profit/unit with the game's inputs = 478.53 (${gameUnit})`);
assert.ok(Math.abs(gameUnit * 26.452 / 4 - 3164.49) < 0.5, 'profit/h/level ≈ game 3164.49');
assert.ok(dash.includes('Cost per unit · running batch (game)') && dash.includes('maximumFractionDigits:3'), 'running batch cost shown like the game (3 decimals)');
assert.ok(dash.includes('SimcoTools current price'), 'sale price names its source and age');
// lag: listeners detached while hidden, one refresh on return
assert.ok(dash.includes('function scmOnStorageChanged(fn)') && dash.includes('chrome.storage.onChanged.removeListener(fn)'));
assert.equal((dash.match(/chrome\.storage\.onChanged\.addListener\(/g) || []).length, 2, 'all dashboard listeners go through scmOnStorageChanged');
assert.ok(read('live-updates.js').includes('globalThis.scmOnStorageChanged'));
// market
assert.ok(!html.includes('id="marketAlerts"') && !html.includes('<h3>Market Alerts</h3>'), 'Market Alerts removed');
assert.ok(/<details id="marketMonitor"[^>]*>\s*<summary>/.test(html), 'Market data monitor collapsible (closed by default)');
assert.ok(!/<details id="marketMonitor"[^>]*\bopen\b/.test(html));
// diagnostics
assert.ok(dash.includes('profitCalculatorInputs') && dash.includes('storageBytesByKey') && dash.includes('endpointIndex') && dash.includes('productionCostHistory:realm!=null'));
assert.ok(html.includes('What to capture for a problem'));

// --- background strip: built once, text updated in place (no 15 s full rebuild) ---
const lu = read('live-updates.js');
assert.ok(lu.includes('function build()') && lu.includes('node.__h !== html'));
assert.ok(!/el\.innerHTML = `<button/.test(lu), 'paint() no longer rewrites the whole strip');
{
  // run paint twice against a tiny DOM stub: the button element must survive
  const made = [];
  const mk = cls => ({ cls, classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, textContent: '', innerHTML: '', hidden: false });
  const nodes = { '.lu-bar': mk('bar'), '.lu-dot': mk('dot'), '.lu-text': mk('text'), '.lu-more': mk('more'), '.lu-panel': mk('panel'), '.lu-list': mk('list'), '.lu-legend': mk('legend') };
  let builds = 0;
  const el = { set innerHTML(v) { builds++; made.push(v); }, get innerHTML() { return made[made.length - 1] || ''; }, querySelector: q => nodes[q], contains: () => true, classList: { add() {}, remove() {} }, addEventListener(t, fn) { if (t === 'click') clickBar = () => fn({ target: { closest: () => true } }); } };
  let clickBar = null;
  const jobs = [{ id: 'a', job: 'warehouse-refresh', trigger: 'stock-mutation-or-forced', outcome: 'success', finishedAt: new Date().toISOString() }];
  let intervalFn = null;
  const sandbox = {
    document: { getElementById: id => id === 'liveUpdates' ? el : null, hidden: false, createElement: () => mk('t'), body: { appendChild() {} } },
    chrome: { storage: { local: { get: async () => ({ selectedRealm: 1, activeRealmKey: 'realm:1', 'scmBackgroundJobs:1': jobs }) }, onChanged: { addListener() {} } } },
    setInterval: fn => { intervalFn = fn; }, setTimeout, clearTimeout, Date, Number, String, Array, Math, JSON, Object, Promise
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(lu, sandbox);
  setTimeout(() => {
    assert.equal(builds, 1, 'structure built once');
    intervalFn(); intervalFn();
    assert.equal(builds, 1, '15 s ticks do not rebuild the strip');
    assert.ok(/Warehouse <b>/.test(nodes['.lu-text'].innerHTML));
    clickBar();
    assert.ok(/Warehouse refreshed after a game action/.test(nodes['.lu-list'].innerHTML), 'expanded list renders readable labels');
    assert.equal(builds, 1, 'opening the list does not rebuild the strip');
    // tools-ui allocation shorthand
    const ui = read('tools-ui.js');
    assert.ok(ui.includes('function parseAmt(v)') && ui.includes('inputmode="decimal"'));
    const parseAmt = new Function(ui.slice(ui.indexOf('function parseAmt(v)'), ui.indexOf('function allocInput')) + 'return parseAmt;')();
    assert.equal(parseAmt('250k'), 250000); assert.equal(parseAmt('1.2m'), 1200000); assert.equal(parseAmt('$3,500'), 3500); assert.ok(Number.isNaN(parseAmt('abc'))); assert.ok(Number.isNaN(parseAmt('')));
    // no inline handlers anywhere in extension pages
    for (const f of ['dashboard.html', 'dashboard.js', 'tools-ui.js', 'live-updates.js', 'popup.html', 'options.html']) assert.ok(!/\son(click|error|load|change|input|submit)\s*=\s*["']/i.test(read(f).split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')), `no inline handlers in ${f}`);
    console.log('v331-regression: all assertions passed');
  }, 50);
}
