'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'page-hook.js'), 'utf8');
const start = source.indexOf('  const collectStateAccessDiagnostic = (requestId) => {');
const end = source.indexOf('  // Request a GET using the game\'s page context', start);
assert.ok(start >= 0 && end > start, 'collector function exists as a bounded page-hook routine');
const collectorSource = source.slice(start, end).trim();
const makeSandbox = (windowObj, elements=[]) => {
  let clock = 0;
  const sandbox = {
    window: windowObj,
    document: { querySelector: (selector) => selector==='#root' ? (elements[0]||null) : null, getElementsByTagName: () => elements, readyState: 'complete' },
    location: { href: 'https://www.simcompanies.com/landscape/', pathname: '/landscape/' },
    performance: { now: () => ++clock, getEntriesByType: () => [] },
    WeakSet, Object, Array, String, Number, Boolean, Math, Date,
    pageRealm: () => 1
  };
  vm.createContext(sandbox);
  vm.runInContext(`${collectorSource}\nthis.__collector = collectStateAccessDiagnostic;`, sandbox);
  return sandbox;
};
const state = { production: { buildings: [{ id: 7, level: 4, output: 'Steel' }] } };
const withStore = makeSandbox({ appStore: { state }, React: {} });
const report = withStore.__collector('req-1');
assert.equal(report.diagnostic, 'simcompanies-runtime-state-access-diagnostic');
assert.equal(report.requestId, 'req-1');
assert.ok(report.discovery.reduxStoreCandidateCount >= 1, 'store-like global is detected');
assert.ok(report.limits.visitedNodes > 0, 'candidate object graph is actually traversed');
assert.ok(report.stateMatches.some(x => /production/.test(x.path)), 'relevant production path is returned');
assert.equal(report.limits.note.includes('not guaranteed to be a complete raw Redux export'), true);
assert.ok(Array.isArray(report.componentSnapshots), 'bounded component snapshot collection is always present');
const fiber = {type:{name:'BuildingProductionPanel'},memoizedProps:{building:{id:7,level:4,production:{output:'Steel'}}},memoizedState:{production:{rate:12}},child:null,sibling:null};
const rootElement = {id:'root',tagName:'DIV',_reactRootContainer:{_internalRoot:{current:fiber}}};
const fiberReport = makeSandbox({},[rootElement]).__collector('req-fiber');
assert.ok(fiberReport.limits.visitedNodes>0, 'React root candidate is traversed');
assert.ok(fiberReport.componentSnapshotCount>0, 'React component props/state are captured when a fiber root is available');
assert.ok(JSON.stringify(fiberReport.componentSnapshots).includes('Steel'), 'component snapshot preserves useful production data');
const noStore = makeSandbox({ React: {} }).__collector('req-2');
assert.equal(noStore.discovery.reduxStoreCandidateCount, 0);
assert.equal(noStore.limits.visitedNodes, 0);
assert.ok(noStore.runtimeAccess);
console.log('redux-diagnostic-bridge-regression: collector behavior passed');
