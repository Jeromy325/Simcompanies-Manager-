/* Diagnostic-only helpers shared by the dashboard and service worker. */
(function (root) {
  'use strict';
  function createSerialQueue() {
    let tail = Promise.resolve();
    return function enqueue(task) {
      const result = tail.catch(() => {}).then(() => task());
      tail = result.catch(() => {});
      return result;
    };
  }
  function summarizeNetworkCapture(capture) {
    const events = Array.isArray(capture?.events) ? capture.events : [];
    const count = kind => events.filter(e => e?.kind === kind).length;
    const requests=events.filter(e=>e?.kind==='request-start'||e?.kind==='request');
    const responses=events.filter(e=>e?.kind==='fetch'||e?.kind==='xhr');
    const requestKey=e=>`${String(e?.transport||'').toLowerCase()}|${String(e?.method||'GET').toUpperCase()}|${String(e?.url||'').split('?')[0]}`;
    const responseCounts=new Map();
    for(const response of responses){const key=requestKey(response);responseCounts.set(key,(responseCounts.get(key)||0)+1);}
    const unmatchedRequests=[];
    for(const request of requests){const key=requestKey(request),remaining=responseCounts.get(key)||0;if(remaining>0)responseCounts.set(key,remaining-1);else unmatchedRequests.push({transport:String(request?.transport||''),method:String(request?.method||'GET'),url:String(request?.url||'').split('?')[0]});}
    const stopCount=count('capture-stop');
    return {
      eventCount: events.length,
      declaredEventCount: Number.isFinite(Number(capture?.eventCount)) ? Number(capture.eventCount) : null,
      responseCount: responses.length,
      requestCount: requests.length,
      requestErrorCount: count('request-error'),
      recorderErrorCount: count('recorder-error'),
      startCount: count('capture-start'),
      stopCount,
      duplicateStopMarkers: Math.max(0,stopCount-1),
      unmatchedRequestCount: unmatchedRequests.length,
      unmatchedRequests: unmatchedRequests.slice(0,100),
      resourceSnapshotCount: count('resource-timing-snapshot'),
      status: String(capture?.status || 'missing'),
      captureId: String(capture?.captureId || ''),
      countsMatch: capture?.eventCount != null && events.length === Number(capture.eventCount)
    };
  }
  function verifyNetworkCaptureExport(capture) {
    const summary = summarizeNetworkCapture(capture);
    const reasons = [];
    if (!summary.eventCount) reasons.push('zero-events');
    if (!summary.countsMatch) reasons.push('event-count-mismatch');
    if (summary.status !== 'stopped') reasons.push('capture-not-stopped');
    if (summary.stopCount === 0) reasons.push('missing-stop-marker');
    if (summary.duplicateStopMarkers > 0) reasons.push('duplicate-stop-markers');
    if (summary.unmatchedRequestCount > 0) reasons.push('request-without-response-event');
    if (capture?.truncated || Number(capture?.droppedEventCount) > 0) reasons.push('capture-truncated');
    return { ok: reasons.length === 0, reasons, droppedEventCount: Number(capture?.droppedEventCount) || 0, truncated: Boolean(capture?.truncated || Number(capture?.droppedEventCount) > 0), ...summary };
  }

  function endpointCoverageReport(capture) {
    const events=Array.isArray(capture?.events)?capture.events:[];
    const key=e=>`${String(e?.method||'GET').toUpperCase()} ${String(e?.url||'').split('?')[0]}`;
    const endpoints=new Map();
    const rowFor=e=>{const k=key(e);if(!endpoints.has(k))endpoints.set(k,{endpoint:String(e?.url||'').split('?')[0],method:String(e?.method||'GET').toUpperCase(),requestCount:0,successfulResponseCount:0,responseCount:0,bodyCapturedCount:0,parseStatuses:{parsed:0,'parse-failed':0,'not-json':0,'body-missing':0},truncatedBodyCount:0,timingOnlyCount:0,statusCodes:{}});return endpoints.get(k);};
    const requestEvents=events.filter(e=>e?.kind==='request-start');
    const responseEvents=events.filter(e=>e?.kind==='fetch'||e?.kind==='xhr');
    for(const e of requestEvents)rowFor(e).requestCount++;
    for(const e of responseEvents){const r=rowFor(e);r.responseCount++;const status=Number(e?.status)||0;r.statusCodes[status]=(r.statusCodes[status]||0)+1;if(e?.ok===true||(status>=200&&status<300))r.successfulResponseCount++;const body=e?.body;const hasBody=body!==null&&body!==undefined;r.bodyCapturedCount+=hasBody?1:0;if(!hasBody){r.parseStatuses['body-missing']++;r.timingOnlyCount++;}else if(body&&typeof body==='object'&&body.truncated===true){r.truncatedBodyCount++;r.parseStatuses['parse-failed']++;}else if(typeof body==='string'){r.parseStatuses['not-json']++;}else r.parseStatuses.parsed++;}
    // Resource Timing proves a request-like resource occurred, not that a response body was saved. Keep it as a separate count.
    for(const e of events.filter(e=>e?.kind==='resource-timing-snapshot'))for(const resource of Array.isArray(e?.resources)?e.resources:[]){if(!String(resource?.url||'').startsWith('/api/'))continue;const r=rowFor({url:resource.url,method:'GET'});r.resourceTimingCount=(r.resourceTimingCount||0)+1;}
    return [...endpoints.values()].map(r=>({...r,unmatchedRequestCount:Math.max(0,r.requestCount-r.responseCount),responseBodyMissingCount:r.responseCount-r.bodyCapturedCount,coverageStatus:r.requestCount===0?'response/timing-only':r.requestCount>r.responseCount?'missing-response-events':r.responseCount>r.bodyCapturedCount?'response-without-saved-body':'body-captured'})).sort((a,b)=>a.endpoint.localeCompare(b.endpoint)||a.method.localeCompare(b.method));
  }
  // Reconcile each response against a saved body and terminal outcome. A response
  // without a body must never be counted as fully covered merely because the
  // recorder did not emit a body-unavailable event.
  function summarizeNetworkCaptureV3(events) {
    const rows = Array.isArray(events) ? events : [];
    const of = kind => rows.filter(e => e?.kind === kind);
    const responses = of('response');
    const bodies = of('response-body');
    const unavailable = of('body-unavailable');
    const finished = of('loading-finished');
    const failed = of('loading-failed');
    const byId = kind => new Set(of(kind).map(e => String(e?.requestId ?? '')));
    const bodyIds = new Set(bodies.filter(e => e?.body !== null && e?.body !== undefined).map(e => String(e?.requestId ?? '')));
    const unavailableIds = byId('body-unavailable');
    const finishedIds = byId('loading-finished');
    const failedIds = byId('loading-failed');
    const counts = {
      responseCount: responses.length,
      responseBodiesCaptured: bodies.filter(e => e?.body !== null && e?.body !== undefined).length,
      responseBodyRecords: bodies.length,
      responseBodiesUnavailable: 0,
      explicitBodyUnavailableCount: unavailable.length,
      responseFailedBeforeBodyCount: 0,
      responseFinishedWithoutBodyRecordCount: 0,
      responseWithoutTerminalEventCount: 0,
      responseWithoutOutcomeCount: 0,
      emptyBodyCount: bodies.filter(e => e?.body === null || e?.body === undefined || e?.bodyLength === 0).length,
      loadingFinishedCount: finished.length,
      loadingFailedCount: failed.length,
      recorderErrorCount: of('capture-error').length,
      bodyCoveragePercent: 0,
      responseBodyOutcomes: []
    };
    for (const response of responses) {
      const id = String(response?.requestId ?? '');
      if (bodyIds.has(id)) continue;
      counts.responseBodiesUnavailable++;
      let outcome;
      if (unavailableIds.has(id)) outcome = 'explicit-body-unavailable';
      else if (failedIds.has(id)) { outcome = 'request-failed-before-body'; counts.responseFailedBeforeBodyCount++; }
      else if (finishedIds.has(id)) { outcome = 'finished-without-body-record'; counts.responseFinishedWithoutBodyRecordCount++; }
      else { outcome = 'response-without-terminal-event'; counts.responseWithoutTerminalEventCount++; }
      counts.responseBodyOutcomes.push({requestId:id,url:String(response?.url||''),status:Number(response?.status)||null,mimeType:String(response?.mimeType||''),outcome});
    }
    counts.responseWithoutOutcomeCount = counts.responseBodiesUnavailable;
    counts.bodyCoveragePercent = counts.responseCount ? Number((counts.responseBodiesCaptured / counts.responseCount * 100).toFixed(1)) : 0;
    return counts;
  }

  function classifyStateDiscovery(diagnostic) {
    const discovery = diagnostic?.discovery || {};
    const candidates = Number(discovery.reduxStoreCandidateCount || 0);
    const fibers = Number(discovery.reactFiberRootCount || 0);
    const visited = Number(diagnostic?.limits?.visitedNodes || 0);
    const matches = Array.isArray(diagnostic?.stateMatches) ? diagnostic.stateMatches.length : 0;
    const componentSnapshots = Array.isArray(diagnostic?.componentSnapshots) ? diagnostic.componentSnapshots.length : 0;
    if (!candidates && !fibers && !visited && !matches) return {
      status: 'no-state-found', reason: 'No candidate object was found to traverse; visitedNodes is zero, so this was not a deep scan of application state.',
      candidates, fibers, visitedNodes: visited, stateMatchCount: matches
    };
    if (!candidates && !fibers) return {
      status: 'runtime-paths-found-no-store', reason: 'The scan visited objects but did not identify a Redux store or React Fiber root.',
      candidates, fibers, visitedNodes: visited, stateMatchCount: matches
    };
    if (!matches && !componentSnapshots) return {
      status: 'candidate-found-no-matches', reason: 'A candidate was discovered, but no relevant state paths or React component snapshots matched the bounded scan.',
      candidates, fibers, visitedNodes: visited, stateMatchCount: matches, componentSnapshotCount: componentSnapshots
    };
    return { status: componentSnapshots ? 'partial-component-state-captured' : 'partial-state-paths-found', reason: componentSnapshots ? 'Bounded React component props/state snapshots were captured. This may reveal live application data but is not guaranteed to be a complete raw Redux export.' : 'Relevant paths were discovered; this remains a bounded metadata/path diagnostic, not a full raw-state export.', candidates, fibers, visitedNodes: visited, stateMatchCount: matches, componentSnapshotCount: componentSnapshots };
  }
  root.SCM_DIAGNOSTIC_CORE = { createSerialQueue, summarizeNetworkCapture, verifyNetworkCaptureExport, endpointCoverageReport, summarizeNetworkCaptureV3, classifyStateDiscovery };
})(globalThis);
