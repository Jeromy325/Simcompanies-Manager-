const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const context = { console, Map, Set, Object, Number, Math, Array, String, Date };
vm.runInNewContext(fs.readFileSync(path.join(root, 'diagnostic-core.js'), 'utf8'), context);
const summarize = context.SCM_DIAGNOSTIC_CORE.summarizeNetworkCaptureV3;
const events = [
 {kind:'response',requestId:'body',url:'/api/a',status:200,mimeType:'application/json'},
 {kind:'response-body',requestId:'body',body:'{}',bodyLength:2},
 {kind:'response',requestId:'failed',url:'https://analytics.invalid/pixel',status:204,mimeType:'text/plain'},
 {kind:'loading-failed',requestId:'failed',errorText:'net::ERR_ABORTED'},
 {kind:'response',requestId:'no-terminal',url:'https://pixel.invalid/tr/',status:200,mimeType:'text/plain'},
 {kind:'response',requestId:'explicit',url:'/api/b',status:200,mimeType:'application/json'},
 {kind:'body-unavailable',requestId:'explicit',reason:'No resource with given identifier found'},
 {kind:'response',requestId:'finished-no-body',url:'/api/c',status:200,mimeType:'application/json'},
 {kind:'loading-finished',requestId:'finished-no-body'}
];
const result = summarize(events);
assert.equal(result.responseCount, 5);
assert.equal(result.responseBodiesCaptured, 1);
assert.equal(result.responseBodiesUnavailable, 4);
assert.equal(result.bodyCoveragePercent, 20);
assert.equal(result.responseFailedBeforeBodyCount, 1);
assert.equal(result.responseWithoutTerminalEventCount, 1);
assert.equal(result.explicitBodyUnavailableCount, 1);
assert.equal(result.responseFinishedWithoutBodyRecordCount, 1);
assert.equal(result.responseBodyOutcomes.length, 4);
console.log('network-capture-body-accounting-regression: passed');
