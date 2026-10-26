// 2.5.382: Accounting overview = Cash / Income / Expenses rows (Cash, Total change in cash, Sales, Net income, Cost of
// goods sold, Freight out, Exchange fees, Executives cost, Operating expenses) for the latest finished game day vs the
// day before. Expenses show as positive costs (cost up = red). Full chart opens as a popout. The current statement is
// the newest computed one of this realm (was: newest received, any realm). Fixtures: the user's R2 day walk, 10/25.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const dash = read('dashboard.js'), html = read('dashboard.html'), css = read('styles.css');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.382');
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
const konst = name => { const m = dash.match(new RegExp(`const ${name}=[^;]+;`)); assert.ok(m, name); return m[0]; };
const ctx = { Number, Math, Date, JSON, Object, Map, Set, Array, String, RegExp, escapeHtml: x => String(x), roundCurrencyUp: x => Math.round(x * 100) / 100 };
vm.createContext(ctx);
vm.runInContext([konst('ACCT_CHART_DAY'), konst('ACCT_SERIES_KEEP_DAYS'), konst('ACCT_CHART_FIELDS'), konst('ACCT_COST_KEYS'),
  ...['gameOperatingExpenses', 'accountingStatementDay', 'accountingDayStatements', 'accountingDayCashflows', 'accountingCashChange', 'accountingPreviousPeriod',
    'acctNum', 'acctSigned', 'acctChangeClass', 'acctCompact', 'acctChangeHtml', 'acctDayKey', 'accountingDailySeriesMerge', 'accountingChartPoints',
    'accountingChartTrend', 'acctTone', 'accountingStatementPeriodText'].map(n => fn(dash, n))].join('\n'), ctx);
const walk = JSON.parse(read('tests/fixtures/r2-accounting-day-walk-2026-10-25.json'));
const W = p => walk[`/api/v2/companies/me/${p}/`];
const wrap = (data, realm = 1) => ({ status: 200, data, captureRealm: realm });

// the nine cards, grouped, in the approved order
assert.deepEqual(Object.keys(vm.runInContext('ACCT_CHART_FIELDS', ctx)), ['cash', 'cashChange', 'sales', 'netIncome', 'cogs', 'freightOut', 'marketFees', 'executives', 'operatingExpenses']);
assert.match(dash, /\['Cash',\[\['Cash','cash',a\.cash\],\['Total change in cash','cashChange',a\.cashChange\]\]\],\['Income',\[\['Sales','sales',a\.revenue\],\['Net income','netIncome',a\.profit\]\]\],/);
assert.match(dash, /\['Expenses',\[\['Cost of goods sold','cogs',a\.cogs\],\['Freight out','freightOut',a\.freightOut\],\['Exchange fees','marketFees',a\.marketFees\],\['Executives cost','executives',a\.executives\],\['Operating expenses','operatingExpenses',a\.operatingExpenses\]\]\]\]/);

// one game day of figures (screen 10/24: COGS 3,907,406; freight 27,098; fees 152,214; execs 64,744 + 20,000 + 0)
const d0 = ctx.accountingStatementDay(W('income-statement/day/0'));
assert.deepEqual([d0.sales, d0.cogs, d0.freightOut, d0.marketFees, d0.executives, d0.operatingExpenses, d0.netIncome], [4571563, -3907406, -27098, -152214, -84744, -236958, 416561]);
// Total change in cash = the cash-flow statement total (cash in + cash out): +680,865 on 10/24
assert.equal(ctx.accountingCashChange(W('cashflow-statement/day/0')), 680865);
assert.equal(ctx.accountingCashChange(W('cashflow-statement/day/1')), 727631);
assert.equal(ctx.accountingCashChange({ cashAllIncome: 5 }), null, 'no total without both sides');
const ep = {}; for (let n = 0; n < 7; n++) ep[`/api/v2/companies/me/cashflow-statement/day/${n}/`] = wrap(W(`cashflow-statement/day/${n}`));
assert.equal(ctx.accountingDayCashflows(ep, x => x.captureRealm === 1).size, 7);
assert.equal(ctx.accountingDayCashflows(ep, x => x.captureRealm === 0).size, 0, 'other realm ignored');
assert.equal(ctx.accountingDayCashflows({ a: wrap({ ...W('cashflow-statement/day/0'), isComputed: false }) }).size, 0, 'uncomputed ignored');
assert.equal(ctx.accountingDayCashflows({ '/api/v2/companies/me/cashflow-statement/': wrap(W('cashflow-statement/day/0')) }).size, 0, 'only /day/<n>/');

// expenses: shown positive; a cost going up is red (change-down), going down is green (change-up)
assert.equal(ctx.acctSigned('cogs', -3907406), 3907406);
assert.equal(ctx.acctSigned('sales', 4571563), 4571563);
assert.ok(Object.is(ctx.acctSigned('freightOut', 0), 0), 'no -0');
assert.equal(ctx.acctSigned('cogs', null), null);
assert.equal(ctx.acctSigned('cogs', ''), null, 'missing is not $0');
assert.equal(ctx.acctChangeClass('cogs', 556291), 'change-down');
assert.equal(ctx.acctChangeClass('operatingExpenses', -64207), 'change-up');
assert.equal(ctx.acctChangeClass('sales', 484624), 'change-up');
assert.equal(ctx.acctChangeClass('netIncome', -20335), 'change-down');
assert.equal(ctx.acctTone('marketFees', 15000), 'bad');
assert.equal(ctx.acctTone('cash', -1), 'bad');
const cogsRow = ctx.acctChangeHtml('cogs', 3907406, 3351115);
assert.match(cogsRow, /change-down">↑ \+\$556\.29K · \+16\.6%/);
assert.match(ctx.acctChangeHtml('operatingExpenses', 236958, 301165), /change-up">↓ -\$64\.21K · -21\.3%/);
assert.match(ctx.acctChangeHtml('cash', 5, null), /No earlier figure captured/);

// history rows carry the new fields; previous = the day before the latest finished day
const t0 = Date.parse(W('income-statement/day/0').date), t1 = Date.parse(W('income-statement/day/1').date);
const r1 = { t: t1, cash: 2520465, ...ctx.accountingStatementDay(W('income-statement/day/1')), statement: true, cashChange: 727631 };
const r0 = { t: t0, cash: 3201330, ...d0, statement: true, cashChange: 680865 };
const prev = ctx.accountingPreviousPeriod([r1, r0], W('income-statement/day/0').date);
assert.deepEqual([prev.cash, prev.cashChange, prev.sales, prev.netIncome, prev.cogs, prev.freightOut, prev.marketFees, prev.executives, prev.operatingExpenses],
  [2520465, 727631, 4086939, 436896, -3351115, -14223, -89326, -50724, -301165]);
assert.equal(prev.date, new Date(t1).toISOString());

// saved per day (builds history over time) and charted as positive costs
const merged = ctx.accountingDailySeriesMerge(null, [r1, r0]);
assert.deepEqual(merged.days[new Date(t0).toISOString().slice(0, 10)], { sales: 4571563, operatingExpenses: -236958, netIncome: 416561, cogs: -3907406, freightOut: -27098, marketFees: -152214, executives: -84744, cashChange: 680865 });
const pts = ctx.accountingChartPoints([{ t: t1 }, { t: t0 }], merged, 'cogs', 30);
assert.deepEqual(pts.map(p => p[1]), [3351115, 3907406]);
assert.deepEqual(ctx.accountingChartPoints([], merged, 'cashChange', 30).map(p => p[1]), [727631, 680865]);

// current statement: newest computed by end date, this realm only; current statement also fills its own history day
assert.match(dash, /\.filter\(x=>x\?\.data\?\.isComputed===true&&realmMatches\(x\)\)\s*\.sort\(\(a,b\)=>statementEnd\(b\)-statementEnd\(a\)/);
assert.match(dash, /cashflow-statement\(\?:\\\/day\\\/0\|\\\/\\d\+\)\?\\\/\?\$/);
assert.match(dash, /income-statement\(\?:\\\/day\\\/0\|\\\/\\d\+\)\?\\\/\?\$/);
assert.match(dash, /if\(obj\(income\)\?\.isComputed===true&&dayMinute\(income\)!=null&&!dayIncome\.has\(dayMinute\(income\)\)\)/);

// header: "Current statements date" + the statement period in the game's format; no date line on the cards
assert.match(dash, /current:'Current statements date'/);
const per = ctx.accountingStatementPeriodText({ dateFrom: '2026-10-25T01:21:00Z', date: '2026-10-26T01:20:00Z' });
assert.match(per, /^\d{1,2}:\d\d\s?[AP]M \d{1,2}\/\d{1,2} to \d{1,2}:\d\d\s?[AP]M \d{1,2}\/\d{1,2}$/);
assert.equal(ctx.accountingStatementPeriodText({}), '');
assert.ok(!/Changes compare with the day ending/.test(dash), 'date line removed from the overview');

// parent card + popout
assert.match(html, /data-collapse="acct:overview"><h3 data-collapse-head>Accounting overview<\/h3><div id="accountingOverview"><\/div><\/div>/);
assert.match(dash, /\$\{have<range\?`<small>\$\{have\} of \$\{range\} days collected<\/small>`:''\}/);
assert.match(dash, /el\.id='acctChartPop';el\.className='acct-pop-backdrop';el\.hidden=true;document\.body\.appendChild\(el\);/);
assert.match(dash, /e\.key==='Escape'&&acctChartOpenKey/);
assert.match(dash, /else if\(close\|\|e\.target===pop\)\{accountingChartClose\(\);\}/);
assert.match(css, /\.acct-pop-backdrop\{position:fixed;inset:0;/);
assert.match(css, /body\.acct-pop-open\{overflow:hidden\}/);
console.log('v382 accounting overview rows + popout: ok');
