// 2.5.368: Accounting shows the game's own statements (subtotals, EVA, totals) and Financial Ratios.
// Fixture = user's R2 capture 2026-10-24/25; expected values = the game's Accounting screen.
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.374');
const T = require('../tools-core.js');
const fx = JSON.parse(read('tests/fixtures/r2-accounting-2026-10-24.json'));
const g = T.gameFinancialStatements(fx['income-statement'], fx['balance-sheet'], fx['cashflow-statement']);
const sub = list => list.filter(l => l.kind === 'subtotal' || l.kind === 'total').map(l => [l.label, l.value]);
assert.deepStrictEqual(sub(g.income), [['', 637059], ['', -236958], ['', 16460], ['Net income', 416561], ['Total comprehensive income', 162835], ['', 388318]]);
const line = (list, l) => list.find(x => x.label === l).value;
assert.equal(line(g.income, 'Operating profit'), 416561); assert.equal(line(g.income, 'Capital charge'), -28243);
assert.deepStrictEqual(sub(g.balance), [['Total assets', 25742475], ['Total debt and equity', 25742475], ['Company value', 25742475]]);
assert.deepStrictEqual(sub(g.cashflow), [['', 680865], ['Total change in cash', 680865]]);
assert.equal(line(g.cashflow, 'For PA quests'), 0);
const fmt = r => !Number.isFinite(r.value) ? (r.value < 0 ? '-∞' : '∞') : r.percent ? (r.value * 100).toFixed(2) + '%' : r.value.toFixed(3);
const got = Object.fromEntries(g.ratios.filter(r => !r.kind).map(r => [r.label, fmt(r)]));
assert.deepStrictEqual(got, { 'Gross Margin': '13.94%', 'Operating Margin': '8.75%', 'Net Profit Margin': '9.11%', 'Return on Quick Assets': '13.01%',
  'Return on Equity': '1.62%', 'Sales per Employee': '297.028', 'Income per Employee': '27.065', 'Inventory Turnover': '0.415', 'Assets Turnover': '0.178',
  'Operating Assets Turnover': '0.364', 'Defensive Interval': '0.819', 'Interest Coverage': '-∞', 'Debt to Building Ratio': '0.00%' });
assert.equal(g.adjustedEmployees, 15391); // floor(98×100×(1+97/170))
assert.ok(g.ratiosAvailable);
assert.equal(T.gameFinancialStatements({ isComputed: false, sales: 0 }, fx['balance-sheet'], {}).ratiosAvailable, false);
const dash = read('dashboard.js'), html = read('dashboard.html');
assert.ok(/id="accountingRatios"/.test(html));
assert.ok(/accountingFinancialRatios\(a\.source\?\.income,a\.source\?\.bs\)/.test(dash));
console.log('v368-regression: ok');
