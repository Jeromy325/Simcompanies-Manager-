// 2.5.381: VWAP is published once a day (SimcoTools / Sim Companies). The 15-minute cache re-downloaded the full
// dataset after every Sync and hourly cycle (R2: 3 downloads in 20 min). Now: 20 h after a download that changed
// the data, 3 h re-checks while it is unchanged; a cache hit with nothing new writes nothing.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const src = read('background.js');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.392');
function fn(name) {
  const start = src.indexOf(`function ${name}(`); assert.notEqual(start, -1, name);
  let depth = 0;
  for (let i = src.indexOf('){', start) + 1; i < src.length; i++) {
    if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
}
const ctx = { Date, Number, String };
vm.createContext(ctx);
vm.runInContext('const VWAP_AFTER_CHANGE_MS=20*3600e3;const VWAP_RECHECK_MS=3*3600e3;' + fn('vwapCacheFresh'), ctx);
assert.match(src, /const VWAP_AFTER_CHANGE_MS=20\*3600e3;/); assert.match(src, /const VWAP_RECHECK_MS=3\*3600e3;/);
const H = 3600e3, now = Date.parse('2026-10-26T12:00:00Z'), iso = ms => new Date(ms).toISOString();
const fresh = c => ctx.vwapCacheFresh(c, now);
assert.equal(fresh({ fetchedAt: iso(now - 19 * H), dataChangedAt: iso(now - 19 * H) }), true, 'changed 19 h ago: no download');
assert.equal(fresh({ fetchedAt: iso(now - 21 * H), dataChangedAt: iso(now - 21 * H) }), false, 'changed 21 h ago: check for the next daily update');
assert.equal(fresh({ fetchedAt: iso(now - 2 * H), dataChangedAt: iso(now - 22 * H) }), true, 'unchanged, checked 2 h ago: wait');
assert.equal(fresh({ fetchedAt: iso(now - 4 * H), dataChangedAt: iso(now - 26 * H) }), false, 'unchanged, checked 4 h ago: re-check');
assert.equal(fresh({ fetchedAt: iso(now - 20 * 60e3) }), true, 'old cache without dataChangedAt: 3 h re-check rule');
assert.equal(fresh({ fetchedAt: iso(now - 4 * H) }), false);
assert.equal(fresh(null), false); assert.equal(fresh({ fetchedAt: 'x' }), false);
assert.equal(fresh({ fetchedAt: iso(now + H) }), false, 'clock skew never freezes VWAP');
// Wiring.
assert.match(src, /const cacheFresh=!options\.force&&vwapCacheFresh\(cached,Date\.now\(\)\)/, 'VWAP stage uses the daily rule');
assert.doesNotMatch(src, /Date\.now\(\)-cachedAt<\(15\*60\*1000\)/, '15-minute cache removed');
assert.match(src, /const fresh=Number\.isFinite\(cachedAt\)&&vwapCacheFresh\(store\.vwapData\)/, 'Exchange overlay no longer requests a refresh after 10 min');
assert.match(src, /dataChangedAt=stale\?\(cached\?\.dataChangedAt\|\|null\):\(prevSignature&&prevSignature===signature\?\(cached\?\.dataChangedAt\|\|null\):now\)/, 'dataChangedAt moves only when the dataset signature changes');
assert.match(src, /if\(JSON\.stringify\(mergedHistory\)===JSON\.stringify\(targetStore\.history\|\|\{\}\)\)return \{ok:true,cached:true,unchanged:true/, 'cache hit with nothing new writes nothing');
console.log('v381-regression: passed');
