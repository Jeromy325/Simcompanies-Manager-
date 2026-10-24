// 2.5.350: abundance colour on mine cards; output difference vs current level; collapsible Accounting/Contracts
// cards; alerts: two removed, sales / accepted contracts added (from the cash-flow ledger).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.365');
const C = require('../tools-core.js');
const N = require('../notify-core.js');

// abundance bands: 100–90 green, 90–85 orange, ≤ 85 red
const tone = [100, 99.57, 90, 89.99, 85.01, 85, 70].map(C.abundanceTone);
assert.deepEqual(tone, ['good', 'good', 'good', 'warn', 'warn', 'bad', 'bad']);
assert.equal(C.abundanceTone(null), null);
assert.equal(C.abundanceTone(''), null);
const dash = read('dashboard.js'), html = read('dashboard.html'), css = read('styles.css'), bg = read('background.js');
assert.ok(dash.includes('plannerAbundancePct(s,b.raw?.id??b.id,cardResId)') && dash.includes('TC?.isAbundanceResource?.(cardResId)'), 'abundance read from the game capture, only for abundance resources');
assert.ok(/ab-good em\{color:#4ee68b\}/.test(css) && /ab-warn em\{color:#ffa94d\}/.test(css) && /ab-bad em\{color:#ff6b78\}/.test(css));

// difference cards: same rate function at the building's own level
assert.ok(dash.includes('plannerRateForProduct(product,building,Number(building.level)||1,recipes,rates,s)'));
assert.ok(dash.includes("diffStat(diffPerHour,`vs Level ${num(building.level)} / hr`)") && dash.includes('diffStat(diffPerHour*runHours,'), 'per hour and per run');

// Last 8 days: collapsible day cards with the profit in the head
const fnSrc = dash.slice(dash.indexOf('function accountingHistoryTable(history){'), dash.indexOf('function accountingOverview(a,previous){'));
const ctx = { escapeHtml: x => String(x), money: v => '$' + Number(v).toFixed(2) };
vm.createContext(ctx); vm.runInContext(fnSrc + ';this.f=accountingHistoryTable;', ctx);
const out = ctx.f([{ t: '2026-10-22T00:00:00Z', profit: -12.5, sales: 10, assets: 5 }, { t: '2026-10-23T00:00:00Z', profit: 1234.5, sales: 2000, expenses: 765.5, cash: 1, inventory: 2, assets: 3, rank: 4567 }]);
assert.equal((out.match(/data-collapse="acctday:/g) || []).length, 2);
assert.ok(/data-collapse="acctday:2026-10-23" data-collapse-default="closed"><div class="acct-day-head" data-collapse-head><span>[^<]+<\/span><strong class="positive">\$1234\.50<\/strong>/.test(out), 'collapsed head shows day + profit on the right');
assert.ok(out.indexOf('acctday:2026-10-23') < out.indexOf('acctday:2026-10-22'), 'newest first');
assert.ok(out.includes('<strong class="negative">$-12.50</strong>'));
for (const k of ['acct:history', 'acct:balance', 'acct:cashflow', 'acct:income', 'acct:balance-detail', 'contracts:incoming', 'contracts:outgoing', 'contracts:surplus', 'contracts:saved'])
  assert.ok(html.includes(`data-collapse="${k}"`), k);
assert.ok(dash.includes("box.dataset.collapse='contracts:gov'") && dash.includes('data-collapse="gov:'), 'government orders + each order');
assert.ok(css.includes('[data-collapse].is-collapsed>:not([data-collapse-head]){display:none!important}'));
assert.ok(!/on(click|toggle|keydown)="/.test(html + dash), 'no inline handlers');

// alerts removed
assert.ok(!html.includes('data-nf="inputsShort"') && !html.includes('data-nf="lowStock"'));
assert.ok(!bg.includes('N.inputShortage(') && !bg.includes('notifyLowStock('), 'not fired any more');
assert.ok(!bg.includes('cfg.inputsShort'), 'batch-finished alarms no longer depend on the removed switch');
assert.ok(html.includes('data-nf="sales"') && /NOTIFY_DEFAULTS=\{[^}]*sales:true/.test(bg));

// sales / accepted contracts from cashflow/recent rows (fields the Accounting tab already reads)
const names = new Map([[43, 'Steel'], [112, 'Bulldozer']]);
const now = Date.parse('2026-10-24T12:00:00Z');
const old = [{ id: 1, datetime: '2026-10-24T10:00:00Z', category: 'm', descriptionKey: 'marketfilled-9', money: 100, details: { resource: 43, amount: 10, price: 10, profit: 5 } }];
let r = N.newSales(old, undefined, names, 1, now);
assert.equal(r.fresh.length, 0, 'first capture only records');
const rows = [...old,
  { id: 2, datetime: '2026-10-24T11:58:00Z', category: 'm', descriptionKey: 'marketfilled-77', money: 1008, details: { resource: 43, amount: 120, price: 8.4, profit: 123 } },
  { id: 3, datetime: '2026-10-24T11:59:00Z', category: 'f', descriptionKey: 'fees-77', money: -40.32 },
  { id: 4, datetime: '2026-10-24T11:59:30Z', category: 'm', descriptionKey: 'cs-55', money: 4520, details: { resource: 112, amount: 2, price: 2260, profit: 1016.72 } },
  { id: 5, datetime: '2026-10-24T11:59:40Z', category: 'p', descriptionKey: 'production-1', money: -300 },
  { id: 6, datetime: '2026-10-22T11:00:00Z', category: 'm', descriptionKey: 'marketfilled-1', money: 5, details: { resource: 43, amount: 1, price: 5 } }];
r = N.newSales(rows, r.seen, names, 1, now);
assert.equal(r.fresh.length, 2, 'exchange sale + accepted contract; fees, production and >24 h rows ignored');
assert.equal(r.fresh[0].title, 'Sold on the exchange: 120 Steel');
assert.ok(r.fresh[0].message.startsWith('$8.40 each, $1,008 · profit +$123.') && r.fresh[0].message.includes('R2'), r.fresh[0].message);
assert.equal(r.fresh[1].title, 'Contract accepted: 2 Bulldozer');
assert.ok(r.fresh[1].message.includes('$2,260.00 each, $4,520 · profit +$1,017'), r.fresh[1].message);
assert.equal(N.newSales(rows, r.seen, names, 1, now).fresh.length, 0, 'not repeated');
assert.ok(bg.includes('notifySales(r,data)') && /cashflow\\\/recent/.test(bg.slice(bg.indexOf('notifySales(r,data)') - 300, bg.indexOf('notifySales(r,data)'))), 'hooked on cashflow/recent captures');
const fnSales = bg.slice(bg.indexOf('async function notifySales('), bg.indexOf('async function notifyJobTrouble('));
assert.ok(!/withStorageLock|fetch\(|pageGet\(/.test(fnSales), 'no network, no storage lock');
console.log('v350-regression: passed');
