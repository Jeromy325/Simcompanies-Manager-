// 2.5.334: notifications wiring (texts reworded in 2.5.335; logic tests live in v335-regression).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const bg = read('background.js');
assert.ok(bg.includes("import './notify-core.js';"));
assert.ok(bg.includes("if(outcome!=='failure')notifyAfterPriceUpdate(realm)"), 'price alerts after each current-price update');
assert.ok(bg.includes('notifyIncomingContracts(validRealmNumber(incomingContractRealm[1]),data)'), 'contract alerts after the realm check');
assert.ok(bg.includes("'scm-daily-summary'"));
const glue = bg.slice(bg.indexOf('const NOTIFY_DEFAULTS='), bg.indexOf('function productionFinishAlarms('));
assert.ok(!/pageGet\(|simcoFetch|api\.simcotools/.test(glue), 'notification glue does no game/SimcoTools network work');
const html = read('dashboard.html');
for (const k of ['productionFinished', 'inputsShort', 'bigMove', 'incomingContracts', 'dailySummary']) assert.ok(html.includes(`data-nf="${k}"`), k);
assert.ok(html.includes('id="nfTAdd"') && html.includes('id="notifyDailyNow"'));
console.log('v334-regression: all assertions passed');
