// 2.5.335: plain-language alert texts, 7 more alerts, Alerts tab. Checked with the user's 2026-10-23 numbers.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.390');
const N = require('../notify-core.js');
const now = Date.parse('2026-10-23T13:00:00Z');
const names = new Map([[112, 'Bulldozer'], [43, 'Steel'], [51, 'Car body'], [52, 'Combustion engine'], [1, 'Power'], [3, 'Water']]);
const iso = ms => new Date(ms).toISOString();
const store = {
  endpointData: { '/api/v3/market/1/112/': { receivedAt: iso(now - 5 * 60e3), data: [{ price: 2270, quality: 0 }, { price: 2240, quality: 1 }, { price: 2230, quality: 0 }, { price: 2300, quality: 3 }] } },
  liveMarketPriceData: { updatedAt: iso(now - 60e3), rows: [{ resourceId: 52, quality: 2, price: 650, fetchedAt: iso(now - 60e3) }, { resourceId: 52, quality: 1, price: 600 }] }
};
const building = { id: 9001, name: 'Car factory #1', busy: { started: '2026-10-23T10:34:00Z', duration: 58380, resource: { kind: 112, name: 'Bulldozer', quality: 3, amount: 429, unitCost: 1780.226 } } };

// 1. batch finished (plain sentences)
const b = N.batchFinishedMessage({ building, store, realm: 1, names, now });
assert.equal(b.title, 'Car factory #1 finished 429 Bulldozer Q3');
assert.equal(b.message, 'Ready to collect.\nThey cost you $1,780.23 each.\nCheapest on the market now: $2,230.00 (Q0 listing, exchange, 5 min ago).\nSelling now: about +$449.77 each, +$192,953 for the batch, before fees.\nR2');

// 3. inputs short
const recipe = { id: 112, materials: [{ id: 43, quantity: 4 }, { id: 51, quantity: 1 }, { id: 52, quantity: 2 }] };
const lots = [{ kind: 43, quality: 2, amount: 10531 }, { kind: 51, quality: 2, amount: 659 }, { kind: 52, quality: 2, amount: 347 }, { kind: 52, quality: 1, amount: 9999 }];
const sh = N.inputShortage({ building, recipe, lots, store, realm: 1, names, now });
assert.equal(sh.title, "Car factory #1 can't repeat its batch of 429 Bulldozer Q3");
assert.equal(sh.message, 'Missing Combustion engine (Q2 or better): need 858, you have 347. Buying the 511 missing costs about $332,150 (from $650.00 each).\nR2');

// 6. the user's real Water alert, reworded
const water = N.bigMoves({ movers: [{ id: 3, quality: 2, price: 0.397, change: { '1h': 8.2 } }], lots: [{ kind: 3, quality: 2, amount: 4190376, cost: { market: 0.365 * 4190376 } }], threshold: 5, now, names, realm: 1 });
assert.equal(water.fire[0].title, 'Water Q2 price up 8.2% in the last hour');
assert.equal(water.fire[0].message, '$0.367 → $0.397 now. You have 4,190,376 in stock (your cost $0.365 each).\nSelling now: +$0.032 each (+8.8%) ≈ +$134,092 total, before fees.\nR2');

// 5. price target
const t = N.priceTargetHits([{ id: 112, q: 0, op: '<=', price: 2200 }], [{ resourceId: 112, quality: 0, price: 2195, vwap: 2201.77 }], {}, names, 1);
assert.equal(t.fire[0].title, 'Price alert: Bulldozer Q0 is now $2,195.00');
assert.equal(t.fire[0].message, "That's at or below your target of $2,200.00. Average trade price (VWAP): $2,201.77.\nR2");

// 9. contract
let c = N.newIncomingContracts([{ id: 7 }], undefined, names, 1);
c = N.newIncomingContracts([{ id: 7 }, { id: 8, seller: { company: 'Hewitt Supply' }, kind: 52, quantity: 2400, quality: 2, price: 641.9 }], c.seen, names, 1);
assert.equal(c.fresh[0].title, 'New incoming contract from Hewitt Supply');
assert.equal(c.fresh[0].message, 'They offer 2,400 Combustion engine Q2 at $641.90 each, $1,540,560 in total.\nR2');

// 12. daily summary
const d = N.dailySummary({ overview: [{ date: '2026-10-21 00:00:00', evaProfit: 90000, total: 5000000, rank: 300 }, { date: '2026-10-22 00:00:00', evaProfit: 114000, total: 5114000, rank: 290 }], runs: [{ id: 112, q: 3, n: 429, t: iso(now - 3 * 3600e3) }], realm: 1, names, now });
assert.equal(d.title, 'R2 daily summary for Oct 22');
assert.equal(d.message, 'Profit $114,000. Company value (assets) $5,114,000, up $114,000 from the day before. Rank 290 (was 300).\n1 batch started in the last 24 h: 429 Bulldozer Q3.');

// 2. cost changed (Power example from the warehouse card)
const hist = [{ k: 'a', b: 9002, bn: 'Power plant #1', id: 1, q: 0, c: 0.17, t: iso(now - 7 * 3600e3), n: 60000 }];
const e = { k: 'b', b: 9002, bn: 'Power plant #1', id: 1, q: 0, c: 0.18, t: iso(now - 60e3), n: 60000 };
const cc = N.costChanged({ history: hist.concat([e]), entry: e, thresholdPct: 3, names, realm: 1 });
assert.equal(cc.title, 'Power plant #1: new batch costs more');
assert.equal(cc.message, 'Power Q0 now costs $0.180 each, up $0.010 (+5.9%) from the last batch ($0.170). On 60,000 units that\'s +$600.\nR2');
assert.equal(N.costChanged({ history: hist.concat([{ ...e, c: 0.172 }]), entry: { ...e, c: 0.172 }, thresholdPct: 3, names }), null, 'below threshold');

// 4 + 11. follow-up
const fin = Date.parse(building.busy.started) + 58380e3, st = Date.parse(building.busy.started);
assert.equal(N.followUp({ building, startedMs: st, finishMs: fin, seenAt: fin - 1000, now: fin + 3600e3 }).kind, 'unknown', 'no data after the finish → no claim');
const unc = N.followUp({ building, startedMs: st, finishMs: fin, seenAt: fin + 600e3, now: fin + 3600e3, names, realm: 1 });
assert.equal(unc.kind, 'uncollected'); assert.equal(unc.title, "Car factory #1 hasn't been collected");
const idle = N.followUp({ building: { name: 'Car factory #1' }, startedMs: st, finishMs: fin, seenAt: fin + 600e3, now: fin + 3600e3, names, realm: 1 });
assert.equal(idle.kind, 'idle'); assert.equal(idle.title, 'Car factory #1 is idle');
assert.equal(N.followUp({ building: { name: 'x', busy: { started: iso(fin + 60e3) } }, startedMs: st, finishMs: fin, seenAt: fin + 600e3, now: fin + 3600e3 }).kind, 'busy', 'restarted → nothing');

// 7. undercut (own listing found by company id)
const book = [{ price: 2260, quality: 3, seller: { id: 5294950, company: 'Hewitt Corporation' } }, { price: 2240, quality: 3, seller: { id: 1, company: 'dartib' } }, { price: 2200, quality: 2, seller: { id: 2 } }];
let u = N.undercut({ rows: book, companyId: 5294950, id: 112, names, realm: 1 });
assert.equal(u.fire.length, 1); assert.equal(u.fire[0].title, "You've been undercut on Bulldozer Q3");
assert.equal(u.fire[0].message, 'Your listing: $2,260.00. Cheapest other seller now: $2,240.00 (dartib), $20.00 less.\n1 listing is cheaper than yours.\nR2');
assert.equal(N.undercut({ rows: book, companyId: 5294950, id: 112, names, state: u.state }).fire.length, 0, 'same situation → once');
assert.equal(N.undercut({ rows: book, companyId: 999, id: 112, names }).fire.length, 0, 'no own listing → nothing');

// 8. unprofitable
const cheap = { endpointData: { '/api/v3/market/1/112/': { receivedAt: iso(now - 60e3), data: [{ price: 1750, quality: 0 }] } } };
let up = N.unprofitable({ buildings: [building], store: cheap, realm: 1, names, now });
assert.equal(up.fire[0].title, 'Bulldozer Q3 is no longer profitable');
assert.ok(up.fire[0].message.includes('Selling now: −$30.23 each, −$12,967 on 429, before fees.'), up.fire[0].message);
assert.equal(N.unprofitable({ buildings: [building], store: cheap, realm: 1, names, state: up.state, now }).fire.length, 0, 'once until profitable again');
assert.equal(N.unprofitable({ buildings: [building], store, realm: 1, names, state: up.state, now }).fire.length, 0);

// 10. low stock across running buildings
const recipes = new Map([[112, recipe]]);
let lo = N.lowStock({ buildings: [building], recipes, lots, store, realm: 1, names, now });
assert.equal(lo.fire.length, 1); assert.equal(lo.fire[0].title, 'Running low: Combustion engine (Q2 or better)');
assert.equal(lo.fire[0].message, 'You have 347; your next batches need 858 (Car factory #1: 858).\nShort 511, about $332,150 at $650.00 each.\nR2');
assert.equal(N.lowStock({ buildings: [building], recipes, lots, store, realm: 1, names, state: lo.state, now }).fire.length, 0, 'not repeated unless >10% worse');

// 13. background trouble: fires on the 3rd failure in a row, resets on success
let j = { counts: {} }; const ev = { job: 'market-current-price-stage', outcome: 'failure', error: 'SimcoTools rate limit' };
for (let i = 0; i < 2; i++) { j = N.jobTrouble({ counts: j.counts, event: ev, realm: 1, now }); assert.equal(j.fire, null); }
j = N.jobTrouble({ counts: j.counts, event: ev, realm: 1, now, pricesUpdatedAt: iso(now - 42 * 60e3) });
assert.equal(j.fire.title, 'Manager: current price downloads keep failing');
assert.ok(j.fire.message.startsWith('3 failures in a row. Last error: SimcoTools rate limit. Last price update: 42 min ago.'), j.fire.message);
assert.equal(N.jobTrouble({ counts: j.counts, event: ev, realm: 1, now }).fire, null, 'not every failure after that');
assert.deepEqual(N.jobTrouble({ counts: j.counts, event: { ...ev, outcome: 'success' } }).counts, {}, 'reset on success');

// wiring
const bg = read('background.js');
assert.ok(bg.includes('notifyJobTrouble(n,normalized)'), 'job trouble hooked into the job history');
assert.ok(bg.includes('notifyCostChanges(n,merged.list') && bg.includes('{silent:true}'), 'cost change from new runs; one-time seed is silent');
assert.ok(bg.includes("startsWith('scm-followup:')"));
assert.ok(bg.includes('notifyOrderBook(r,id,data)') && !bg.includes('notifyLowStock(r)') /* removed in 2.5.350 */);
const html = read('dashboard.html');
assert.ok(html.includes('data-tab="alerts"') && html.includes('<section id="alerts"'), 'own Alerts tab');
const diag = html.slice(html.indexOf('<section id="diagnostic"'));
assert.ok(!diag.includes('notifyPanel'), 'no longer in Diagnostic');
for (const k of ['costChange', 'idle', 'undercut', 'unprofitable', 'jobTrouble']) assert.ok(html.includes(`data-nf="${k}"`), k);
console.log('v335-regression: all assertions passed');
