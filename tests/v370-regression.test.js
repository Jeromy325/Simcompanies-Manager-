// 2.5.370: Sync walks the game's Accounting page (Day 0–6) after completing; Last 7 days.
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.396');
const bg = read('background.js'), dash = read('dashboard.js'), html = read('dashboard.html');
assert.ok(/const ACCOUNTING_DAY_WALK_DAYS=7;/.test(bg));
// scheduled only after the core Sync succeeded, next to the week ledger, never inside the Sync transaction
assert.ok(/accounting-week-ledger-scheduled[\s\S]{0,200}scheduleAccountingDayWalk\(selected,4000\)/.test(bg));
// the alarm waits while a Sync of that realm runs
assert.ok(/dayWalkMatch[\s\S]{0,200}if\(syncSessionForRealm\(realm\)\)\{await chrome\.alarms\.create/.test(bg));
// alarm survives update (kept on install) and is re-created from storage on install/startup
assert.ok(/INSTALL_KEEP_ALARM_PREFIXES=\[[^\]]*ACCOUNTING_DAY_WALK_ALARM_PREFIX[,\]]/.test(bg));
assert.ok(/walk\.status==='scheduled'\|\|walk\.status==='running'/.test(bg));
// realm-scoped status key
assert.ok(/'accountingDayWalkStatus'/.test(bg.slice(bg.indexOf('REALM_SCOPED_KEYS'), bg.indexOf('REALM_SCOPED_KEYS') + 3000)));
// a tap only counts when the game's own day/<n> response is captured for this realm after the tap
const w = bg.slice(bg.indexOf('async function waitForAccountingDayCapture'), bg.indexOf('async function runAccountingDayWalk'));
assert.ok(/income-statement\/day\/\$\{dayIndex\}\//.test(w) && /validRealmNumber\(item\.captureRealm\)===realm/.test(w) && /t>=sinceMs/.test(w));
// buttons found by structure, not text
const step = bg.slice(bg.indexOf('async function accountingPeriodStep'), bg.indexOf('async function waitForAccountingDayCapture'));
assert.ok(/modes\.length!==4/.test(step) && !/textContent|innerText/.test(step));
// no network while holding a lock: the walk never runs inside withRealmWriteLock
const run = bg.slice(bg.indexOf('async function runAccountingDayWalk'), bg.indexOf('async function yieldSyncStep'));
assert.ok(!/withRealmWriteLock/.test(run));
assert.ok(/\.slice\(-7\)\.reverse\(\)/.test(dash) && /Last 7 days/.test(html) && !/Last 8 days/.test(html));
console.log('v370-regression: ok');
