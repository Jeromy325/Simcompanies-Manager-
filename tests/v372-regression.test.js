// 2.5.372: walk card moved to the bottom, collapsed, compact; no card nested inside the Accounting statement cards.
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.386');
const html = read('dashboard.html'), dash = read('dashboard.js');
const keys = [...html.matchAll(/data-collapse="(acct:[a-z-]+)"/g)].map(m => m[1]);
assert.equal(keys[keys.length - 1], 'acct:walk', keys.join(','));
assert.ok(/data-collapse="acct:walk" data-collapse-default="closed"/.test(html));
assert.ok(/id="acctWalkHead"/.test(html));
const card = dash.slice(dash.indexOf('function gameStatementCard('), dash.indexOf('function gameRatioValue('));
const ratios = dash.slice(dash.indexOf('function accountingFinancialRatios('), dash.indexOf('function buildBalanceSections('));
for (const src of [card, ratios]) assert.ok(!/statement-card|statement-grid|<h3>/.test(src), 'no nested card / duplicate title');
const ui = dash.slice(dash.indexOf('function accountingWalkScheduleHtml('), dash.indexOf('async function renderAccountingWalkSchedule('));
assert.equal((ui.match(/class="acct-walk-row/g) || []).length, 3, 'layout A: 3 rows');
assert.ok(!/Keep the Sim Companies tab open/.test(ui), 'help text dropped');
console.log('v372-regression: ok');
