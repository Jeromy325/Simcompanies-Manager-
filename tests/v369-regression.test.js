// 2.5.369: Accounting audit fixes. Fixture = user's R2 capture 2026-10-25 (day/0, day/1 statements, past finances).
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.376');
const dash = read('dashboard.js'), bg = read('background.js');
const fnSrc = name => { const i = dash.indexOf(`function ${name}(`); assert.ok(i >= 0, name); let d = 0, j = dash.indexOf('){', i) + 1; for (let k = j; k < dash.length; k++) { if (dash[k] === '{') d++; else if (dash[k] === '}' && --d === 0) return dash.slice(i, k + 1); } };
const fx = JSON.parse(read('tests/fixtures/r2-accounting-days-2026-10-25.json'));
const env = new Function(`${fnSrc('gameOperatingExpenses')}\n${fnSrc('accountingDayStatements')}\n${fnSrc('accountingDailyHistory')}\n${fnSrc('accountingPreviousPeriod')}\nreturn {gameOperatingExpenses,accountingDayStatements,accountingDailyHistory,accountingPreviousPeriod};`)();
// Game "Operating expenses" subtotal (screen 10/24: (-) $236,958), not cash paid out (3,907,158).
assert.equal(env.gameOperatingExpenses(fx['income-statement/day/0'].data), -236958);
assert.equal(env.gameOperatingExpenses(fx['income-statement/day/1'].data), -301165);
const ep = { '/api/v2/companies/me/income-statement/day/0/': fx['income-statement/day/0'], '/api/v2/companies/me/income-statement/day/1/': fx['income-statement/day/1'] };
const days = env.accountingDayStatements(ep);
assert.equal(days.size, 2);
const hist = env.accountingDailyHistory(fx['past-finances-overview'], fx['past-finances'], [], { sales: false, expenses: false });
for (const r of hist) { const st = days.get(Math.round(r.t / 60000)); if (st) Object.assign(r, { sales: st.sales, operatingExpenses: st.operatingExpenses, netIncome: st.netIncome, statement: true }); }
const last = hist[hist.length - 1], prev = hist[hist.length - 2];
assert.deepStrictEqual([last.sales, last.operatingExpenses, last.netIncome], [4571563, -236958, 416561]);
assert.deepStrictEqual([prev.sales, prev.operatingExpenses, prev.netIncome], [4086939, -301165, 436896]);
const p = env.accountingPreviousPeriod(hist, fx['income-statement/day/0'].data.date);
assert.deepStrictEqual([p.revenue, p.operatingExpenses, p.profit, p.cash, p.assets], [4086939, -301165, 436896, 2520465, 25579640]);
// Uncomputed or other-realm day statements are ignored.
assert.equal(env.accountingDayStatements({ '/api/v2/companies/me/income-statement/day/1/': { ...fx['income-statement/day/1'], data: { ...fx['income-statement/day/1'].data, isComputed: false } } }).size, 0);
assert.equal(env.accountingDayStatements(ep, x => x.captureRealm === 0).size, 0);
// Current balance sheet / income statement must not pick up a /day/<n>/ capture.
assert.ok(dash.includes("const bs=latest(/\\/api\\/v2\\/companies\\/(?:me|\\d+)\\/balance-sheet\\/?$/i)"));
const bsRx = /\/api\/v2\/companies\/(?:me|\d+)\/balance-sheet\/?$/i;
assert.ok(bsRx.test('/api/v2/companies/me/balance-sheet/') && !bsRx.test('/api/v2/companies/me/balance-sheet/day/1/'));
// Inventory includes Research (game Inventory group); Total assets from the game balance-sheet formula.
assert.ok(/inventory=materials\+research\+wip\+finished\+valuationAllowance/.test(dash));
assert.ok(/gameTotal\(gameBs,'Total assets'\)/.test(dash));
assert.ok(/\['Operating expenses','operatingExpenses',a\.operatingExpenses\]/.test(dash));
assert.ok(/pct=p!==0\?\(delta\/Math\.abs\(p\)\)\*100:null/.test(dash));
// Day/week/month accounting captures are realm-sensitive (quarantined without a capture realm).
const m = bg.match(/function isRealmSensitiveAccountingUrl\(url\)\{return (\/.*?\/i)\.test/);
const rx = eval(m[1]);
for (const u of ['/api/v2/companies/me/income-statement/day/1/', '/api/v2/companies/me/balance-sheet/day/0/', '/api/v2/companies/me/cashflow-statement/week/0/', '/api/v2/companies/me/income-statement/month/0/', '/api/v2/companies/me/income-statement/', '/api/v3/companies/me/past-finances/'])
  assert.ok(rx.test(u), u);
console.log('v369-regression: ok');
