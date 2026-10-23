'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const coreSource = fs.readFileSync(path.join(root, 'diagnostic-core.js'), 'utf8');
const sandbox = { globalThis: null, Promise, Number, String, Array };
sandbox.globalThis = sandbox;
vm.runInNewContext(coreSource, sandbox, { filename: 'diagnostic-core.js' });
const core = sandbox.SCM_DIAGNOSTIC_CORE;
assert.ok(core, 'diagnostic helpers load into runtime');

(async () => {
  // Realistic lifecycle sequence: start -> request -> response -> failed request -> XHR response -> stop.
  const capture = { captureId: 'test-session', status: 'stopped', eventCount: 6, events: [
    { kind: 'capture-start' },
    { kind: 'request-start', transport: 'fetch', url: '/api/v3/companies/me/' },
    { kind: 'fetch', transport: 'fetch', status: 200, ok: true },
    { kind: 'request-start', transport: 'fetch', url: '/api/v3/fail/' },
    { kind: 'request-error', transport: 'fetch', errorName: 'TypeError' },
    { kind: 'xhr', transport: 'xhr', status: 200, ok: true },
    { kind: 'capture-stop' }
  ] };
  // eventCount must describe the actual retained events, including lifecycle markers.
  capture.eventCount = capture.events.length;
  const summary = core.summarizeNetworkCapture(capture);
  assert.equal(summary.eventCount, 7);
  assert.equal(summary.requestCount, 2);
  assert.equal(summary.responseCount, 2);
  assert.equal(summary.requestErrorCount, 1);
  assert.equal(summary.startCount, 1);
  assert.equal(summary.stopCount, 1);
  assert.ok(summary.unmatchedRequestCount >= 1, 'requests without matching response events are explicitly counted');
  assert.equal(summary.countsMatch, true);
  assert.equal(core.verifyNetworkCaptureExport(capture).ok, false, 'a capture with a request that has no response event is marked incomplete');
  assert.ok(core.verifyNetworkCaptureExport(capture).reasons.includes('request-without-response-event'));
  const completeCapture={...capture,events:[{kind:'capture-start'},{kind:'request-start',transport:'fetch',url:'/api/v3/companies/me/',method:'GET'},{kind:'fetch',transport:'fetch',url:'/api/v3/companies/me/',method:'GET',status:200,ok:true},{kind:'capture-stop'}]};
  completeCapture.eventCount=completeCapture.events.length;
  assert.equal(core.verifyNetworkCaptureExport(completeCapture).ok,true);

  const mismatch = { ...capture, eventCount: 999 };
  const badExport = core.verifyNetworkCaptureExport(mismatch);
  assert.equal(badExport.ok, false);
  assert.ok(badExport.reasons.includes('event-count-mismatch'));
  const truncated = core.verifyNetworkCaptureExport({ ...capture, truncated: true, droppedEventCount: 4 });
  assert.equal(truncated.ok, false);
  assert.ok(truncated.reasons.includes('capture-truncated'));
  assert.equal(truncated.droppedEventCount, 4);

  const zero = core.verifyNetworkCaptureExport({ status: 'stopped', eventCount: 0, events: [] });
  assert.equal(zero.ok, false);
  assert.ok(zero.reasons.includes('zero-events'));
  assert.ok(zero.reasons.includes('missing-stop-marker'));

  // Verify concurrent diagnostic writes are serialized and a final barrier waits for pending writes.
  const enqueue = core.createSerialQueue();
  const writes = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const first = enqueue(async () => { writes.push('first-start'); await firstGate; writes.push('first-finish'); });
  const second = enqueue(async () => { writes.push('second'); });
  const third = enqueue(async () => { writes.push('third'); });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, ['first-start']);
  releaseFirst();
  await Promise.all([first, second, third]);
  await enqueue(async () => { writes.push('flush-barrier'); });
  assert.deepEqual(writes, ['first-start', 'first-finish', 'second', 'third', 'flush-barrier']);

  const noState = core.classifyStateDiscovery({ discovery: { reduxStoreCandidateCount: 0, reactFiberRootCount: 0 }, limits: { visitedNodes: 0 }, stateMatches: [] });
  assert.equal(noState.status, 'no-state-found');
  assert.match(noState.reason, /visitedNodes is zero/);
  const noStore = core.classifyStateDiscovery({ discovery: { reduxStoreCandidateCount: 0, reactFiberRootCount: 0 }, limits: { visitedNodes: 12 }, stateMatches: [] });
  assert.equal(noStore.status, 'runtime-paths-found-no-store');
  const partial = core.classifyStateDiscovery({ discovery: { reduxStoreCandidateCount: 1, reactFiberRootCount: 0 }, limits: { visitedNodes: 3 }, stateMatches: [{ path: 'x.state' }] });
  assert.equal(partial.status, 'partial-state-paths-found');

  const pageHook = fs.readFileSync(path.join(root, 'page-hook.js'), 'utf8');
  const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  const dashboard = fs.readFileSync(path.join(root, 'dashboard.js'), 'utf8');
  assert.match(pageHook, /kind:'request-start',transport:'fetch'/, 'fetch requests emit request-start events');
  assert.match(pageHook, /kind:'request-start',transport:'xhr'/, 'XHR sends emit request-start events');
  assert.match(background, /enqueueNetworkCaptureWrite\(async\(\)=>/, 'storage read-modify-write event handler is serialized');
  assert.match(background, /droppedEventCount,truncated:droppedEventCount>0/, 'storage truncation is recorded rather than hidden');
  assert.match(dashboard, /type:'SCM_NET3_EXPORT'/, 'download path exports browser-protocol events from durable storage');
  assert.match(pageHook, /runtimeAccess/, 'state diagnostic exports runtime-access evidence');
  assert.match(pageHook, /scanCoveragePercent/, 'DOM diagnostic reports scan coverage');
  assert.match(pageHook, /coverageWarning/, 'DOM diagnostic warns when scan coverage is low');
  assert.match(pageHook, /DOM script tags and Resource Timing script resources are separate evidence sources/, 'DOM diagnostic distinguishes script tags from resource timing');
  assert.match(dashboard, /RUN_REDUX_STATE_DIAGNOSTIC/, 'Redux export uses the existing page-hook bridge');
  assert.match(dashboard, /sendGameTabMessage\(tab\.id,\{type:'RUN_REDUX_STATE_DIAGNOSTIC'/, 'Redux export uses content-script recovery before reporting failure');
  console.log('Diagnostic behavioral regression tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
