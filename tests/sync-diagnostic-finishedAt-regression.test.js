"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `background.js contains ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0, quote = null, escape = false, lineComment = false, blockComment = false;
  for (let i = open; i < source.length; i++) {
    const c = source[i], n = source[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i++; } continue; }
    if (quote) { if (escape) { escape = false; continue; } if (c === '\\') { escape = true; continue; } if (c === quote) quote = null; continue; }
    if (c === '/' && n === '/') { lineComment = true; i++; continue; }
    if (c === '/' && n === '*') { blockComment = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

const context = vm.createContext({});
vm.runInContext(extractFunction('buildSyncDiagnosticCheckpoint'), context);
const build = context.buildSyncDiagnosticCheckpoint;
const completedAt = '2026-10-15T20:52:13.380Z';
const inProgress = build({
  realm: 1,
  status: 'R2 Syncing',
  lastSync: '2026-10-14T10:00:00.000Z',
  finishedAt: null,
  existingDiagnostic: { finishedAt: '2026-10-14T10:00:00.000Z', walkResults: ['stale run'] },
  startedAt: 1792097519144,
  endpointCount: 4,
  warehouseRows: 2,
  syncTrace: [{ type: 'sync-start' }]
});
assert.equal(inProgress.finishedAt, null, 'in-progress checkpoints must not carry a stale completion timestamp');
assert.equal(inProgress.lastSync, '2026-10-14T10:00:00.000Z', 'in-progress checkpoint may retain the previous completed lastSync');
assert.equal(Object.hasOwn(inProgress, 'walkResults'), false, 'in-progress checkpoint must not carry prior-run final results');

const completed = build({
  realm: 1,
  status: 'R2 Sync complete · 4/4 targets captured · Accounting 7/7 APIs',
  lastSync: '2026-10-14T10:00:00.000Z',
  finishedAt: completedAt,
  existingDiagnostic: { finishedAt: completedAt, walkResults: [{ name: 'Warehouse', ok: true }], syncPolicy: { apiFirst: true } },
  startedAt: 1792097519144,
  endpointCount: 29,
  warehouseRows: 22,
  syncTrace: Array.from({ length: 125 }, (_, i) => ({ i }))
});
assert.equal(completed.finishedAt, completedAt, 'final trace checkpoint preserves the terminal finishedAt');
assert.equal(completed.lastSync, completedAt, 'final checkpoint aligns lastSync with finishedAt instead of a stale timestamp');
assert.equal(completed.walkResults[0].name, 'Warehouse', 'final checkpoint preserves the completed diagnostic result details');
assert.equal(completed.syncPolicy.apiFirst, true, 'final checkpoint preserves the completed sync policy');
assert.equal(completed.syncTrace.length, 120, 'checkpoint retains the bounded final trace window');
assert.equal(completed.syncTrace[0].i, 5, 'checkpoint keeps the most recent trace events');

const syncStart = source.indexOf('async function syncNow(');
const syncEnd = source.indexOf('\nasync function postSyncBuildingUiRefresh', syncStart);
assert.notEqual(syncStart, -1, 'syncNow exists');
const syncSource = source.slice(syncStart, syncEnd);
assert.match(syncSource, /let finishedAt=null;/, 'completion time starts empty and is assigned only at finalization');
assert.match(syncSource, /finishedAt=new Date\(\)\.toISOString\(\)/, 'successful finalization assigns the completion timestamp');
assert.match(syncSource, /buildSyncDiagnosticCheckpoint\(\{[\s\S]*?finishedAt,[\s\S]*?existingDiagnostic:dst\.fullSyncDiagnostics/, 'trace checkpoints receive both terminal time and existing final diagnostics');
assert.match(syncSource, /trace\('final-status-reconciled',[\s\S]*?await persistTrace\(true\)/, 'the final reconciliation checkpoint remains covered by the completion-time fix');
console.log('sync-diagnostic-finishedAt-regression: 12 assertions passed');
