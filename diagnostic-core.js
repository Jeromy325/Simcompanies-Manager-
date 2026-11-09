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
    return {
      eventCount: events.length,
      responseCount: responses.length,
      requestCount: requests.length,
      requestErrorCount: count('request-error'),
      recorderErrorCount: count('recorder-error'),
      stopCount: count('capture-stop'),
      status: String(capture?.status || 'missing'),
      countsMatch: capture?.eventCount != null && events.length === Number(capture.eventCount)
    };
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
  // Strip secrets from anything exported/copied (storage dumps, diagnostic bundles).
  const SECRET_KEY_RE = /^(token|authData|cookies?|set-cookie|authorization|scmLiveBridgeToken|x-csrftoken|csrftoken|sessionid)$/i;
  const SECRET_BACKUP_RE = /token.*backup/i;
  function isSecretKey(k) { k = String(k); return SECRET_KEY_RE.test(k) || SECRET_BACKUP_RE.test(k); }
  function redactSecrets(value, seen) {
    if (value === null || typeof value !== 'object') return value;
    seen = seen || new WeakMap();
    if (seen.has(value)) return seen.get(value);
    if (Array.isArray(value)) { const out = []; seen.set(value, out); for (const v of value) out.push(redactSecrets(v, seen)); return out; }
    const out = {}; seen.set(value, out);
    for (const [k, v] of Object.entries(value)) {
      if (isSecretKey(k)) { if (v !== '' && v != null && v !== false) out[k] = '[REDACTED]'; else out[k] = v; continue; }
      out[k] = redactSecrets(v, seen);
    }
    return out;
  }
  root.SCM_DIAGNOSTIC_CORE = { redactSecrets, createSerialQueue, summarizeNetworkCapture, summarizeNetworkCaptureV3, classifyStateDiscovery };
})(globalThis);
