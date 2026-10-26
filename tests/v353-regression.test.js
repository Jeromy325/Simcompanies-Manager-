// 2.5.353: abundance check also runs when the game loads auth-data (every page load + every 3 min). User's API
// capture 2026-10-24: the phone game does not load /companies/me/buildings/ at start; Sync made no abundance call.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.388');
const bg = read('background.js');
const i = bg.indexOf('const isB=/\\/api\\/v2\\/companies\\/me\\/buildings'), hook = bg.slice(i, bg.indexOf('}', bg.indexOf('refreshAbundanceIfStale(r,', i)) + 30);
assert.ok(i > 0 && hook.includes('isA=/\\/api\\/v3\\/companies\\/auth-data\\//i'), 'auth-data triggers the check');
assert.ok(hook.includes("capturedRealm??(isA?responseRealm:null)"), 'realm from the capture, or from auth-data itself');
assert.ok(hook.includes("isA?'game-auth-data':'game-buildings'"));
const fn = bg.slice(bg.indexOf('async function refreshAbundanceIfStale('), bg.indexOf('async function refreshExtraGameData('));
assert.ok(fn.includes("async function refreshAbundanceIfStale(realm,trigger='game-buildings')") && !fn.includes(",t0,'game-buildings')"), 'logged with its trigger');
assert.ok(fn.includes('ABUNDANCE_AUTO_MIN_GAP_MS') && fn.includes('currentCaptureSyncSession()'), 'still throttled (auth-data every 3 min) and skipped during Sync');
assert.ok(read('live-updates.js').includes("'abundance-refresh|game-auth-data'"));
console.log('v353-regression: passed');
