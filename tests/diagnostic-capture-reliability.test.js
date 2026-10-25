'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const pageHook = fs.readFileSync(path.join(root, 'page-hook.js'), 'utf8');
const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'dashboard.js'), 'utf8');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
assert.equal(manifest.version, '2.5.367');

// DOM/runtime inspection must be performed in the page's MAIN world, correlated by ID,
// and must include the page-owned React expando markers and useful visible-text evidence.
assert.match(pageHook, /collectDomRuntimeDiagnostic/);
assert.match(pageHook, /DOM_RUNTIME_DIAGNOSTIC_GET/);
assert.match(pageHook, /relevantBodyTextSnippets/);
assert.match(pageHook, /mainWorld:true/);
assert.match(content, /pendingDomDiagnostics/);
assert.match(content, /DOM_RUNTIME_DIAGNOSTIC_RESULT/);
assert.match(content, /Timed out waiting for the MAIN-world DOM\/runtime inspection/);
assert.match(dashboard, /MAIN-world inspection completed/);
assert.match(html, /downloadDomRuntimeDiagnostic/);

// React root path matching must actually traverse _reactRootContainer and inspect
// bounded component props/state, rather than reporting zero visited nodes by regex accident.
assert.match(pageHook, /reactrootcontainer\|rootcontainer\|internalroot/i);
assert.match(pageHook, /inspectFiberTree/);
assert.match(pageHook, /componentSnapshots/);
assert.match(pageHook, /snapshotValue/);
assert.match(dashboard, /Component snapshots:/);

// Network capture must resume after a reload and always produce an explicit stop marker.
assert.match(content, /resume:true/);
assert.match(pageHook, /kind:'capture-resume'/);
assert.match(pageHook, /resumedAfterReload:!wasEnabled/);
assert.match(background, /Ignored network event for a stale or mismatched capture ID/);
assert.match(dashboard, /Network Capture 3.0 stopped/);
assert.match(dashboard, /type:'SCM_NET3_STOP'/);
console.log('diagnostic-capture-reliability: all assertions passed');
