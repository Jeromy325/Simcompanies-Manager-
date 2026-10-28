// 2.5.340: real R2 storage (2.5.339 export 17:52Z) had scmEconomyStateLog:1 = [{s:1, f:17:43Z}] only — the stored
// auth-data was already "normal" when the log started, so recession was never logged. The Bulldozer batch started
// 02:49Z (before the first entry); 2.5.339 assumed it was "normal" too → no change → $3,430.31 (game $3,100.83).
// Now: before the first entry = unknown; if the economy is normal and the batch rate is >5% off the normal
// reference rate, the batch is from another phase. E2E with the real storage: $3,430.31 → $3,072.96 + note.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const C = require('../tools-core.js');
const realLog = [{ f: '2026-10-23T17:43:48.671Z', l: '2026-10-23T17:45:44.994Z', s: 1 }];
assert.equal(C.economyStateAt(realLog, '2026-10-23T02:49:05.777233+00:00'), null, 'batch before log → unknown, not "normal"');
const measured = 26.451568041165427, ref = 5.58040099212704 * 4 * 1.08;
const v = C.batchPhaseFromRate(measured, ref);
assert.ok(v.differs && Math.abs(v.diffPct - 9.73) < 0.1, `recession batch is ${v.diffPct}% off the normal rate`);
assert.equal(C.batchPhaseFromRate(6.0657 * 4, ref).differs, false, 'a real normal batch (game 6.0657/level) is within 5%');
assert.equal(C.projectionRate({ measuredRate: measured, batchPhase: 'other', currentPhase: 1, referenceRate: ref }).source, 'reference');
const dash = read('dashboard.js');
assert.ok(/if\(!batch&&ctx\.rateFromBatch&&current===1&&C\?\.batchPhaseFromRate\)/.test(dash), 'card infers the batch phase from its rate');
assert.ok(dash.includes('if(batch&&!batch.inferred&&realm!=null&&measured>0)'), 'an inferred phase is not stored as a measured phase rate');
console.log('v340-regression ok');
