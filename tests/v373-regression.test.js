// 2.5.373: get() keeps accountingDayWalkStatus (its field whitelist dropped it, so every render from get() — e.g.
// requestAccountingRefresh — wiped the Last 7 days walk note), and the Accounting tab re-renders when the day-walk status changes (the walk note was missing when the walk
// finished after the tab had rendered, because scmAccountingSignature ignored accountingDayWalkStatus).
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.394');
const dash = read('dashboard.js');
const start = dash.indexOf('function scmAccountingSignature('); const end = dash.indexOf('\n}\n', start) + 3;
const sig = new Function(`${dash.slice(start, end)}; return scmAccountingSignature;`)();
const base = { endpointData: {}, accountingWeekRevision: 1 };
const running = { ...base, accountingDayWalkStatus: { status: 'running', updatedAt: '2026-10-25T14:00:00Z' } };
const complete = { ...base, accountingDayWalkStatus: { status: 'complete', updatedAt: '2026-10-25T14:01:00Z', finishedAt: '2026-10-25T14:01:00Z', captured: 7 } };
assert.notEqual(sig(base), sig(running), 'walk scheduled/running triggers a render');
assert.notEqual(sig(running), sig(complete), 'walk complete triggers a render');
assert.equal(sig(complete), sig({ ...complete }), 'unchanged status: no extra render');
assert.equal(sig(base), sig({ ...base }));
const emptyLine = dash.split('\n').find(l => l.includes('const empty={authData:null'));
assert.ok(/\baccountingDayWalkStatus:null\b/.test(emptyLine || ''), 'get() whitelist keeps accountingDayWalkStatus');
console.log('v373-regression: ok');
