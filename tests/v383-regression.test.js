// 2.5.383: Analyze tab (own top-level tab right after Tools). Wiring, CSP and project rules.
const assert = require('assert'), fs = require('fs'), path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const html = read('dashboard.html'), dash = read('dashboard.js'), ui = read('analyze-ui.js'), core = read('analyze-core.js'), css = read('styles.css');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.384');
assert.match(html, /data-tab="tools">Tools<\/button><button class="tab" data-tab="analyze">Analyze<\/button><button class="tab" data-tab="alerts">/, 'Analyze tab right after Tools');
assert.match(html, /<section id="analyze" class="tabpage analyze-page"><div id="analyzeBody"/);
const at = s => html.indexOf(`<script src="${s}">`);
assert.ok(at('analyze-core.js') > 0 && at('analyze-core.js') < at('analyze-ui.js') && at('analyze-ui.js') < at('dashboard.js'), 'scripts load before dashboard.js');
assert.match(dash, /activeTab==='analyze'\)\{try\{globalThis\.SCM_ANALYZE_UI\?\.render\(s,analyzeContext\(s\)\)/, 'dashboard renders the Analyze tab');
assert.match(dash, /analyze:\['warehouseResources','vwapData','liveMarketPriceData','history','endpointData','buildings'\]/, 'storage changes re-render Analyze');
assert.doesNotMatch(read('tools-ui.js') + read('tools-core.js'), /analyze/i, 'nothing added to Tools files');
for (const [n, src] of [['analyze-ui.js', ui], ['analyze-core.js', core]]) {
  assert.doesNotMatch(src, /\son[a-z]+=|javascript:/i, `${n}: no inline handlers (CSP)`);
  assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|sendMessage|new Image|<img/, `${n}: no network calls`);
  assert.doesNotMatch(src, /0\.96\b|\b0\.04\b|4\.00%|\bwage\s*=\s*\d/, `${n}: no hardcoded fee or wage`);
}
assert.match(core, /fees-\\d\+/, 'fee rate from ledger fees-<id> rows');
assert.match(ui, /scmPriceLog:/, 'price log read from storage only');
assert.match(css, /\.an-sec>summary/, 'collapsible sections'); assert.match(css, /\.an-pc>summary/, 'collapsible product cards'); assert.match(css, /\.an-root{[^}]*background:#12161c/, 'mockup palette'); assert.match(css, /\.an-spark\{cursor:default;touch-action:pan-y\}/, 'charts do not block page scroll');
console.log('v383-regression: all assertions passed');
