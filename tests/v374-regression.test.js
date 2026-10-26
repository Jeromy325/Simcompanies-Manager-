// 2.5.374: Executives tab. Board room from the user's Board Room screen (2026-10-25): COO 34, COO apprentice 18, CFO coo 14,
// CMO coo 6, CTO coo 12 → effective COO 34 + 9 + 3.5 + 1.5 + 3 = 51; game shows 62.35% −31.80% (= 62.35 × 51%).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const C = require('../tools-core.js');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.387');
const now = Date.parse('2026-10-25T12:50:00Z'), cfg = { trainS: 60 * 60 * 27, settleS: 60 * 60 * 3 };
const w = (id, pos, skills, extra = {}) => ({ id, skills, currentWorkHistory: { position: pos, start: '2026-09-01T00:00:00Z', accelerated: false }, strikeUntil: null, ...extra });
const execs = [
  w(5, 't', { coo: 12, cfo: 6, cmo: 4, cto: 16 }, { name: 'Brian Gonzales', age: 34, trainings: 18, salary: 9000 }),
  w(1, 'o', { coo: 34, cfo: 12, cmo: 14, cto: 10 }, { name: 'Barbara Davis', age: 64, trainings: 20, salary: 12000 }),
  w(2, 'v', { coo: 18, cfo: 11, cmo: 4, cto: 11 }, { name: 'Eric Lopez', age: 52, trainings: 20, salary: 8000 }),
  w(3, 'f', { coo: 14, cfo: 26, cmo: 14, cto: 10 }, { name: 'Mohit Tuli', age: 66, trainings: 20, salary: 11000 }),
  w(4, 'm', { coo: 6, cfo: 3, cmo: 5, cto: 1 }, { name: 'Kennedy Cooper', age: 25, trainings: 6, salary: 7458 })
];
const academy = [{ kind: 'y', size: 8, position: '5', busy: null, purchasedRecently: false }];
const base = 1.6235, args = { base, executives: execs, buildings: academy, now, ...cfg };
const ga = C.effectiveAdminOverhead(args);
assert.equal(ga.coo, 51); assert.equal(ga.basePct.toFixed(2), '62.35'); assert.equal(ga.reductionPct.toFixed(2), '31.80'); assert.equal(ga.pct.toFixed(2), '30.55');

const roster = C.executiveRoster(execs, { now, ...cfg });
assert.deepEqual(roster.map(r => r.role), ['COO', 'COO Apprentice', 'CFO', 'CMO', 'CTO'], 'board-room order');
assert.equal(roster[0].name, 'Barbara Davis'); assert.equal(roster[0].age, 64); assert.equal(roster[0].trainings, 20); assert.equal(roster[0].status, 'active');
assert.equal(roster.reduce((a, r) => a + r.salary, 0), 47458, 'salaries total as the game panel');
assert.equal(C.executiveRoster([w(9, 'o', {})], { now, ...cfg })[0].salary, null, 'missing salary → null, not 0');
assert.equal(C.executiveRoster([w(9, 'm', {}, { currentTraining: { datetime: '2026-10-25T10:00:00Z', accelerated: false } })], { now, ...cfg })[0].status, 'training');

// Apprentice promoted: COO 18 + others ¼ (3.5 + 1.5 + 3) = 26 → 62.35 × 0.74
const promote = C.executiveAdminWhatIf({ ...args, edit: e => { const p = e.currentWorkHistory.position; if (p === 'o') return null; if (p === 'v') e.currentWorkHistory.position = 'o'; return e; } });
assert.equal(promote.coo, 26); assert.equal(promote.pct.toFixed(3), (62.35 * 0.74).toFixed(3));
const leave = C.executiveAdminWhatIf({ ...args, edit: e => e.currentWorkHistory.position === 'o' ? null : e });
assert.equal(leave.coo, 17, 'COO leaves: 9 + 3.5 + 1.5 + 3');
// CMO 14 more trainings × 1.5 added to its COO skill → +21/4 → 56
const trained = C.executiveAdminWhatIf({ ...args, edit: e => (e.id === 4 && (e.skills.coo += 21), e) });
assert.equal(trained.coo, 56);
assert.equal(execs[4].skills.coo, 6, 'what-if never mutates captured data');

const gc = { core: { AVERAGE_SALARY: 100, SALARY_MID: { 1: 1 } }, buildings: { P: { salaryModifier: 2 } }, resources: {} };
assert.equal(C.dailyBaseLabour(gc, [{ kind: 'P', level: 3, busy: { resource: {} } }, { kind: 'P', level: 9, busy: null }]), 100 * 2 * 3 * 24, 'only producing buildings');
const roi = C.executiveRoi({ dailyLabour: 100000, reductionPct: 31.8, salariesPerDay: 47458 });
assert.equal(roi.savedPerDay.toFixed(0), '31800'); assert.equal(roi.netPerDay.toFixed(0), '-15658'); assert.equal(roi.paysForItself, false);

const html = read('dashboard.html'), dash = read('dashboard.js');
assert.ok(html.includes('data-tab="executives"') && html.includes('id="execBody"'), 'tab wired');
assert.ok(dash.includes("if(activeTab==='executives'){try{renderBoardRoom(s);}"), 'render wired');
assert.ok(!/\son[a-z]+="/i.test(dash.slice(dash.indexOf('function renderBoardRoom'), dash.indexOf('function renderPlannerProfit'))), 'no inline handlers');
console.log('v374-regression ok');
