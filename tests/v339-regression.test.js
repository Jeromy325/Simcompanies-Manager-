// 2.5.339: Sync's own auth-data GET (realm check) bypasses saveData, so after 2.5.338 a Sync never logged the
// economy phase; the card stayed on the recession rate ($3,430.31 vs game $3,100.83) until the game page reloaded.
// Sync now records the phase right after auth is verified. E2E: Sync against a fake game tab (economyState 1) →
// log [0, 1] → card $3,072.90 with the economy note.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.358');
const bg = read('background.js');
const i = bg.indexOf("trace('auth-verified'");
assert.ok(i > 0);
const after = bg.slice(i, i + 700);
assert.ok(/recordEconomyState\(selected,[^)]*endpointData\?\.\['\/api\/v3\/companies\/auth-data\/'\][^)]*,authBoundary\.data\)/.test(after), 'sync records economy phase from its auth-data GET');
assert.ok(!/fetch\(|pageGet\(/.test(after.slice(0, after.indexOf('economy-state-recorded'))), 'no extra network work');
console.log('v339-regression ok');
