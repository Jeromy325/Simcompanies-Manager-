// 2.5.358: every card can be expanded / collapsed; run-out & make or buy moved to the Warehouse tab.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.389');
const html = read('dashboard.html'), dash = read('dashboard.js'), content = read('content.js'), css = read('styles.css');

// Warehouse tab: Stock and the run-out card are collapsible cards.
const wh = html.slice(html.indexOf('<section id="warehouse"'), html.indexOf('</section>', html.indexOf('<section id="warehouse"')));
assert.ok(/<div class="panel" data-collapse="wh:stock"><h3 data-collapse-head>Stock<\/h3>/.test(wh), 'Stock card collapsible');
assert.ok(/data-collapse="wh:runout"><h3 data-collapse-head>Inputs: run-out &amp; make or buy<\/h3><div id="warehouseRunOut"/.test(wh), 'run-out card on the Warehouse tab');
assert.ok(/renderWarehouseMarketTimestamp\(s\); try\{renderWarehouseRunOut\(s\);\}/.test(dash), 'rendered with the warehouse');
assert.ok(/function renderWarehouseRunOut\(s\)\{[\s\S]*?plannerRunOutHtml\(\{s,priceMap:buildMarketPriceMap\(s\),recipes:data\.recipes,owned,runHours,bonusPct:plannerCompanyProductionModifier\(s\)\}\)/.test(dash), 'same data as the Production planner');
// Production keeps only the best product.
assert.ok(/<div class="planner-section-label">Best product <span>/.test(dash) && !/Smart insights <span>/.test(dash), 'Production label');
const ins = dash.slice(dash.indexOf('function renderPlannerInsights(host)'), dash.indexOf('function plannerRunOutHtml(ctx)'));
assert.ok(!/inputRunOut|makeOrBuy/.test(ins), 'no run-out on the Production card');

// Auto-collapse engine.
assert.ok(/function scmAutoCollapse\(root\)/.test(dash), 'engine');
assert.ok(/new MutationObserver\(\(\)=>scmAutoCollapse\(document\.body\)\)\.observe\(document\.body,\{childList:true,subtree:true\}\)/.test(dash), 're-applied after every render');
for (const sel of ["'.panel'", "'.statement-card'", "'.overview-section'", "'.planner-summary-card,.planner-text-card'"]) assert.ok(dash.includes(`[${sel},`), `card rule ${sel}`);
for (const sec of ["label:'.owned-buildings-heading'", "label:'.planner-section-label'", "label:'h3.nf-group'"]) assert.ok(dash.includes(sec), `section rule ${sec}`);
assert.ok(/\.scm-auto-head\.collapse-head\{display:flex/.test(css), 'arrow on the right');

// Game-page cards: − / + minimise, delegated listener (no inline handlers), drag ignores the button.
assert.ok(/const MIN_CARDS=\{'scm-left-copy-card':'\.scm-left-copy-head','scm-contract-helper-card':'\.scm-ch-head','scm-sell-qty-card':'\.scm-sq-head'\}/.test(content));
assert.equal((content.match(/applyMin\(card\);/g) || []).length, 4, 'applied after each of the 3 card renders + on tap');
assert.ok(/e\.target\.closest\('\[data-sq-close\],\[data-scm-min\]'\)/.test(content), 'sell card drag ignores the − button');
for (const f of ['content.js', 'dashboard.js', 'dashboard.html']) assert.ok(!/<[^>]+\son(click|error|load|change|input)="/i.test(read(f).replace(/\/\/[^\n]*/g, '')), `no inline handlers in ${f}`);
console.log('v358 collapsible cards: ok');
