'use strict';
// The Executives tab takes each executive's trainings done from the walk-captured trainings-count endpoint
// (same company, matched by executive id). No manual entry. Behaviour checks, no version pins.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const dashboard = fs.readFileSync(path.join(root, 'dashboard.js'), 'utf8');
const C = require('../tools-core.js');

// Run the real roster-mapping statements from renderBoardRoom against a captured endpointData.
const start = dashboard.indexOf('  const companyId=exKey.match(');
const end = dashboard.indexOf('suite=roster.filter(r=>!r.staff);', start);
assert.ok(start > 0 && end > start, 'renderBoardRoom builds the roster from the trainings-count endpoint');
const mapping = dashboard.slice(start, end + 'suite=roster.filter(r=>!r.staff);'.length);

function rosterFor(ep, exKey) {
  const ctx = { ep, exKey, ex: ep[exKey]?.data?.executives, C, now: Date.parse('2026-10-25T12:50:00Z'), trainS: 97200, settleS: 10800 };
  vm.createContext(ctx);
  vm.runInContext(mapping + ';this.out={roster,suite};', ctx);
  return ctx.out.roster;
}

const exKey = '/api/v3/companies/4242/executives/';
const countKey = '/api/v3/companies/4242/executives/trainings-count/';
const execs = [
  { id: 1, skills: { coo: 34 }, currentWorkHistory: { position: 'o', start: '2026-01-01T00:00:00Z' }, name: 'Barbara Davis', age: 64, salary: 12000 },
  { id: 2, skills: { coo: 18 }, currentWorkHistory: { position: 'v', start: '2026-01-01T00:00:00Z' }, name: 'Eric Lopez', age: 52, salary: 8000 },
  { id: 3, skills: { coo: 14 }, currentWorkHistory: { position: 'f', start: '2026-01-01T00:00:00Z' }, name: 'Mohit Tuli', age: 66, salary: 11000 },
];
const ep = {
  [exKey]: { data: { executives: execs } },
  [countKey]: { data: { trainingsCount: { 1: 20, 2: 18, 3: 0 } }, receivedAt: '2026-10-25T12:00:00Z', status: 200 },
};

// Each roster row's trainings equals trainingsCount for its id.
const withCount = rosterFor(ep, exKey);
assert.equal(withCount.find(r => r.id === 1).trainings, 20);
assert.equal(withCount.find(r => r.id === 2).trainings, 18);
assert.equal(withCount.find(r => r.id === 3).trainings, 0, 'a zero count is kept, not treated as missing');

// An id absent from trainingsCount stays null.
const partial = rosterFor({ ...ep, [countKey]: { data: { trainingsCount: { 1: 20 } } } }, exKey);
assert.equal(partial.find(r => r.id === 1).trainings, 20);
assert.equal(partial.find(r => r.id === 2).trainings, null, 'absent id is null');

// No trainings-count endpoint captured: every row is null, even if the roster item carries a count.
const noEndpoint = rosterFor({ [exKey]: { data: { executives: execs.map(e => ({ ...e, trainings: 7 })) } } }, exKey);
assert.ok(noEndpoint.every(r => r.trainings === null), 'missing endpoint leaves trainings null');

// A count for another company is not used.
const otherCo = rosterFor({ ...ep, [countKey]: undefined, '/api/v3/companies/9999/executives/trainings-count/': { data: { trainingsCount: { 1: 5, 2: 5, 3: 5 } } } }, exKey);
assert.ok(otherCo.every(r => r.trainings === null), 'only the same company id is read');

// The manual Done entry path is gone.
assert.doesNotMatch(dashboard, /data-exec-done|exec-done|typed:true|r\.typed/, 'no manual Done input');
assert.doesNotMatch(dashboard, /st\.done/, 'no stored manual trainings');

console.log('exec-trainings-walk: all assertions passed');
