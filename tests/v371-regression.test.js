// 2.5.371: daily scheduled Accounting walk (on/off, minutes after the game's statement time).
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.380');
const bg = read('background.js'), dash = read('dashboard.js'), html = read('dashboard.html');
const src = name => { const i = bg.indexOf(`function ${name}(`); let d = 0, j = bg.indexOf('{', bg.indexOf(')', i)); for (let k = j; k < bg.length; k++) { if (bg[k] === '{') d++; else if (bg[k] === '}' && --d === 0) return bg.slice(i, k + 1); } };
const env = new Function(`${src('accountingWalkOffset')}\n${src('nextAccountingWalkAt')}\nconst ACCOUNTING_WALK_DEFAULT_OFFSET_MIN=30;return {accountingWalkOffset,nextAccountingWalkAt};`)();
// user's statements finished 2026-10-25 01:21:31Z (8:21 PM CDT): +30 min, next future day
const ready = Date.parse('2026-10-25T01:21:31.864Z');
assert.equal(new Date(env.nextAccountingWalkAt(ready, 30, Date.parse('2026-10-25T14:00:00Z'))).toISOString(), '2026-10-26T01:51:31.864Z');
assert.equal(new Date(env.nextAccountingWalkAt(ready, 30, Date.parse('2026-10-25T01:30:00Z'))).toISOString(), '2026-10-25T01:51:31.864Z');
assert.equal(env.nextAccountingWalkAt(null, 30), null); // no captured statement time → no guess
assert.deepStrictEqual([env.accountingWalkOffset(1), env.accountingWalkOffset(999), env.accountingWalkOffset('x'), env.accountingWalkOffset(45)], [5, 240, 30, 45]);
// time comes from the captured statement date, for the walk's realm only
const r = src('accountingStatementsReadyAt'); assert.ok(/validRealmNumber\(it\.captureRealm\)!==n/.test(r) && /data\?\.date/.test(r));
// alarm re-created on install + startup, kept through update, re-aligned after each Sync
assert.ok(/ensureAccountingWalkSchedule\('installed'\)/.test(bg) && /ensureAccountingWalkSchedule\('browser-startup'\)/.test(bg) && /ensureAccountingWalkSchedule\('after-sync'\)/.test(bg));
assert.ok(/INSTALL_KEEP_ALARM_PREFIXES=\[[^\]]*ACCOUNTING_WALK_DAILY_ALARM\]/.test(bg));
// waits for a running Sync / walk; retries 15 min × 4 when the statements are not updated yet
const run = src('runScheduledAccountingWalk');
assert.ok(/syncSessionForRealm\(realm\)\|\|accountingDayWalkRunning\.has\(realm\)/.test(run) && /attempt<ACCOUNTING_WALK_MAX_ATTEMPTS/.test(run));
assert.ok(/const ACCOUNTING_WALK_RETRY_MS=15\*60\*1000;/.test(bg) && /const ACCOUNTING_WALK_MAX_ATTEMPTS=4;/.test(bg));
assert.ok(!/withRealmWriteLock/.test(run)); // network work never inside a storage lock
// UI: toggle, minutes, Run now; no inline handlers
assert.ok(/id="accountingWalkSchedule"/.test(html));
assert.ok(/id="acctWalkEnabled"/.test(dash) && /id="acctWalkOffset"/.test(dash) && /id="acctWalkRunNow"/.test(dash));
assert.ok(!/\son(click|change|input)=/.test(dash.slice(dash.indexOf('function accountingWalkScheduleHtml'), dash.indexOf('function accountingDayWalkNote'))));
console.log('v371-regression: ok');
