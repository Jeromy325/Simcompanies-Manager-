// 2.5.349: abundance fetched for every mine/oil rig/quarry after Sync; Loan & bond verdict counts build time;
// Profit / h / level is per level (planning level changes only the level total).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.360');
const C = require('../tools-core.js');
const fx = require('./fixtures/profit-calc-2026-10-24.json');
// abundance kinds from constants: Minerals is made at 'M' (the user's Mine #1, never captured in the 2026-10-24 export)
const kinds = new Set(Object.entries(fx.constants.resources).filter(([id]) => C.isAbundanceResource(id)).map(([, x]) => String(x.producedAt)));
assert.deepEqual([...kinds], ['M']);
const bg = read('background.js'), fn = bg.slice(bg.indexOf('let bundledAbundanceKindsMemo') /* 2.5.352 shared helpers */, bg.indexOf("chrome.alarms.onAlarm.addListener(a=>{if(a?.name===GAME_CONSTANTS_ALARM)"));
assert.ok(fn.includes('T?.isAbundanceResource?.(id)') && fn.includes('if(k.has(String(b?.kind)))ids.add(String(b.id))') /* 2.5.352 */, 'every abundance building is fetched');
assert.ok(!/await\s+(withStorageLock|storageLock)/.test(fn), 'no storage lock around the fetches');
// loan: build time lowers the earnings over the term and can flip the verdict
const base = { principal: 100000, ratePct: 1, ratePeriod: 'day', termDays: 14, fundedProfitPerHour: 45 };
const a = C.loan(base), b = C.loan({ ...base, leadTimeHours: 48 });
assert.equal(a.totalInterest, b.totalInterest);
assert.ok(a.netOverTerm > 0 && b.netOverTerm < 0, `48 h build flips it: ${a.netOverTerm} → ${b.netOverTerm}`);
assert.equal(b.leadTimeHours, 48);
assert.ok(read('tools-ui.js').includes('r.netOverTerm >= 0 ? `you keep'), 'verdict uses the term total incl. build time');
// planning level: per-level figure constant, level total scales (run the real card code)
const { runCard } = require('./v348-regression.test.js');
const dash = read('dashboard.js');
const p11 = runCard(dash, C, fx.cards.Power), p12 = runCard(dash, C, { ...fx.cards.Power, level: 12 });
assert.equal(p11.headline, p12.headline, 'Profit / h / level is per level, like the game');
assert.ok(/Profit \/ h · Level 12/.test(p12.html) && p12.rec.result.profitPerHourPerLevelGameBasis * 12 > p11.rec.result.profitPerHourPerLevelGameBasis * 11, 'level total follows the planning level');
console.log('v349-regression: passed');
