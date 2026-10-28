'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const content=fs.readFileSync(path.join(root,'content.js'),'utf8');
const background=fs.readFileSync(path.join(root,'background.js'),'utf8');

// Exchange overlay: use the game's own market response; do not wait for storage round trip.
assert.match(content,/const liveMarket=new Map\(\)/,'exchange overlay keeps live market rows in memory');
assert.match(content,/type!=='API_DATA'/,'exchange overlay listens for page-hook API_DATA');
assert.match(content,/if\(vrows\.length\)vwapCache=\{rows:vrows/,'VWAP rows cached separately from market rows');
assert.match(content,/if\(processing\)\{rerun=true;return;\}/,'a call arriving mid-process is re-run, not dropped');
const handler=background.slice(background.indexOf("m?.type==='GET_VWAP_OVERLAY_DATA'"),background.indexOf("m?.type==='CLEAR_EXTENSION_DATA'"));
assert.equal((handler.match(/await state\(\)/g)||[]).length,1,'GET_VWAP_OVERLAY_DATA reads full state once');

// Incoming contracts overlay: transient failures must not wipe badges.
assert.match(content,/getDataOnce/,'incoming-contract data fetch retries once');
assert.doesNotMatch(content,/if\(!data\?\.ok\|\|!Array\.isArray\(data\.contracts\)\)\{clearStale\(\);return;\}/,'failed data fetch does not clear badges');
assert.match(content,/\/accept\/i\.test\(body\)/,'incoming page check has no trailing word boundary after Accept');
assert.doesNotMatch(content,/\\baccept\\b/,'no \\baccept\\b page check (badge text can abut the label)');
assert.match(content,/collectPriceNodes/,'DOM is scanned once per pass, not once per record');
assert.match(content,/if\(inflight\)\{again=true;return;\}|if\(inflight\)\{again=true/,'collision with in-flight pass reschedules');
console.log('overlay-reliability-regression: all assertions passed');
// v2.5.327: rows with no matching API record (the fast-moving first rows) still get a badge from the row's own quality.
assert.match(content,/candidate=\{\.\.\.parsed,record:\{quality:rq\}\}/,'exchange rows fall back to the quality shown in the row');
assert.match(content,/if\(!data\?\.rows\?\.length\)\{if\(startup\)scheduleStartupRetry\(\);return;\}/,'exchange overlay no longer requires API market rows to proceed');
for(const f of ['SYNC_BASELINE_LOCK.json','SYNC_BASELINE_LOCK_README.txt','verify-sync-lock.js','api-sniffer.js'])assert.equal(fs.existsSync(path.join(root,f)),false,`${f} removed`);
const size=fs.statSync(path.join(root,'company-logo.png')).size;assert.ok(size<200000,`company-logo.png is ${size} bytes; it is displayed at <=82px`);
console.log('overlay-reliability-regression: 2.5.327 assertions passed');
