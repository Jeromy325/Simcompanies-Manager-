// 2.5.377: Accounting card charts. Each overview card gets a 90-day sparkline (trend + 7-day average, 7/30/90D range)
// built from game history plus the per-day figures Manager already read (Day statements / Day balance sheets), saved per
// realm in accountingDailySeries. Background refreshes patch changed blocks only (no full rebuild of the Accounting tab).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const dash = read('dashboard.js'), bg = read('background.js');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.391');
function fn(src, name) {
  const start = src.indexOf(`function ${name}(`); assert.notEqual(start, -1, name);
  let depth = 0, q = null;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '{') depth++; else if (c === '}' && --depth === 0) return src.slice(start, i + 1);
  }
}
const ctx = { Number, Math, Date, JSON, Object, Map, Array, String, RegExp };
vm.createContext(ctx);
vm.runInContext(['const ACCT_CHART_DAY=86400000;const ACCT_SERIES_KEEP_DAYS=120;',
  "const ACCT_CHART_FIELDS={cash:'cash',revenue:'sales',operatingExpenses:'operatingExpenses',profit:'netIncome',assets:'assets',liabilities:'liabilities',inventory:'inventory',currentAssets:'currentAssets',currentLiabilities:'currentLiabilities'};",
  "const ACCT_COST_KEYS=new Set();",
  ...['acctNum', 'acctSigned', 'acctDayKey', 'accountingDailySeriesMerge', 'accountingChartPoints', 'accountingChartTrend', 'accountingChartAverage', 'accountingDayBalanceSheets'].map(n => fn(dash, n))].join('\n'), ctx);
// constants used above match the source
assert.match(dash, /const ACCT_CHART_DAY=86400000;/);
assert.match(dash, /const ACCT_SERIES_KEEP_DAYS=120;/);
assert.match(dash, /netIncome:'netIncome'/, 'Net income chart = Net income (v2.5.382 key)');

const day = n => Date.parse('2026-10-25T01:21:31Z') - n * 864e5;
// 90 game-history rows; only the last 7 carry Day statements
const history = Array.from({ length: 90 }, (_, i) => ({ t: day(89 - i), cash: 1000 + i, liabilities: 500 }));
for (let i = 83; i < 90; i++) Object.assign(history[i], { statement: true, sales: 4000 + i, operatingExpenses: -200 - i, netIncome: 300 + i });
history[89].currentLiabilities = 450;

// series merge keeps only finite values, keyed by the day's end date; newest 120 days
const merged = ctx.accountingDailySeriesMerge(null, history);
assert.equal(Object.keys(merged.days).length, 7);
assert.deepEqual(merged.days['2026-10-25'], { sales: 4089, operatingExpenses: -289, netIncome: 389, currentLiabilities: 450 });
const many = { v: 1, days: Object.fromEntries(Array.from({ length: 130 }, (_, i) => [new Date(day(200 - i)).toISOString().slice(0, 10), { sales: i }])) };
assert.equal(Object.keys(ctx.accountingDailySeriesMerge(many, []).days).length, 120, 'trimmed to 120 days');
// merge is stable: merging again changes nothing (no repeated storage writes)
assert.equal(JSON.stringify(ctx.accountingDailySeriesMerge(merged, history)), JSON.stringify(merged));

// saved days fill fields history lacks once the Day statements roll out of the game's 7-day window
const older = { v: 1, days: { ...merged.days, [new Date(day(20)).toISOString().slice(0, 10)]: { sales: 3900, netIncome: 250 } } };
const rolled = history.map(r => ({ t: r.t, cash: r.cash, liabilities: r.liabilities }));
assert.equal(ctx.accountingChartPoints(rolled, older, 'revenue', 90).length, 8);
assert.equal(ctx.accountingChartPoints(rolled, older, 'profit', 90)[0][1], 250);
assert.equal(ctx.accountingChartPoints(history, merged, 'cash', 90).length, 90);
assert.equal(ctx.accountingChartPoints(history, merged, 'cash', 30).length, 30);
assert.equal(ctx.accountingChartPoints(history, merged, 'cash', 7).length, 7);
assert.equal(ctx.accountingChartPoints(history, merged, 'revenue', 90).length, 7, 'Revenue starts at 7 days');
assert.equal(ctx.accountingChartPoints(history, merged, 'currentLiabilities', 90).length, 1);
// a missing day is skipped (the line joins across it), never filled with a made-up value
const gap = history.map((r, i) => i === 50 ? { ...r, cash: null } : r);
assert.equal(ctx.accountingChartPoints(gap, null, 'cash', 90).length, 89);

// straight-line trend slope per day and trailing 7-day average
const tr = ctx.accountingChartTrend([[day(2), 10], [day(1), 20], [day(0), 30]]);
assert.ok(Math.abs(tr.m - 10) < 1e-9);
assert.equal(ctx.accountingChartTrend([[day(0), 5]]), null);
const avg = ctx.accountingChartAverage(Array.from({ length: 10 }, (_, i) => [day(9 - i), i]));
assert.equal(avg[9][1], (3 + 4 + 5 + 6 + 7 + 8 + 9) / 7);

// Current Liabilities per day from the Day balance sheets: matched by date, realm-checked
const sheets = ctx.accountingDayBalanceSheets({
  'https://www.simcompanies.com/api/v2/companies/me/balance-sheet/day/1/': { status: 200, captureRealm: 1, data: { date: '2026-10-24T01:08:47.234535+00:00', bondsPayable: 100 } },
  'https://www.simcompanies.com/api/v2/companies/me/balance-sheet/': { status: 200, captureRealm: 1, data: { date: '2026-10-25T01:21:31+00:00', bondsPayable: 1 } },
}, it => it.captureRealm === 1);
assert.equal(sheets.size, 1, 'only /balance-sheet/day/<n>/ responses');
assert.deepEqual([...sheets.values()][0], { accountsPayable: null, bondsPayable: 100 });
assert.match(dash, /Math\.max\(0,Math\.abs\(r\.liabilities\)-Math\.abs\(bsd\.bondsPayable\)\)/, 'CL = liabilities − bonds payable, as the card');

// Accounting tab no longer rebuilds on every refresh
assert.match(dash, /renderAccountingOverview\(\$\('#accountingOverview'\)/);
assert.ok(!/\$\('#accountingOverview'\)\.innerHTML=/.test(dash), 'overview not rebuilt with innerHTML');
for (const id of ['accountingBalanceSummary', 'accountingCashflowSummary', 'accountingIncomeStatement', 'balanceDetails', 'accountingRatios'])
  assert.ok(new RegExp(`scmSetHTML\\(\\$\\('#${id}'\\)`).test(dash), `${id} writes only when changed`);
// test assertion from 2.5.369 still holds: the card list is unchanged
assert.match(dash, /\['Operating expenses','operatingExpenses',a\.operatingExpenses\]/);
// realm-scoped storage of the series, validated in the background
assert.match(bg, /'accountingDayWalkStatus','accountingDailySeries'/);
assert.match(bg, /allowed=new Set\(\['accountingSnapshots','accountingDailySeries'/);
assert.match(bg, /slice\(-120\)/);
console.log('v377 accounting card charts: ok');
