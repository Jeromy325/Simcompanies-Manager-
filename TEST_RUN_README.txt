Sim Companies Manager 2.5.287 — Network Capture Handshake Regression

Purpose
- Require a positive page-hook acknowledgement and persisted capture-start event before reporting capture active.
- Fix possible lost network diagnostic events caused by concurrent storage read/modify/write operations.
- Record explicit request-start events for fetch and XMLHttpRequest, in addition to response and request-error events.
- Make event-count mismatches, missing stop markers, zero-event captures, and capture truncation explicit failures.
- Improve runtime state-access diagnostics when no Redux store or React Fiber root is exposed.

Behavioral regression coverage
- start/request/response/error/stop event sequence and summary counts
- serial queue ordering and pending-write barrier behavior
- export event-count mismatch and zero-event failure
- missing stop marker and truncated capture failures
- Redux no-candidate/zero-visited-node classification
- integration assertions that request-start hooks and serialized persistence are wired into the extension
- baseline data hashes for recipes, buildings, production-rate data, planner core, and realm core

Validation run
- JavaScript syntax checks passed for background.js, page-hook.js, content.js, dashboard.js, diagnostic-core.js.
- All 20 Node regression test files passed.

Scope
- Diagnostic-only changes in background.js, page-hook.js, dashboard.js, dashboard.html, and diagnostic-core.js.
- No changes to recipes.json, buildings.json, production_rates_normal.json, planner-core.js, realm-core.js, realm-r1.js, or realm-r2.js.
- Background changes are confined to serializing NETWORK_CAPTURE_EVENT storage writes; existing API/sync/realm handlers are unchanged in the source diff.

Limitations
- This build has not been exercised inside the user's live mobile browser in this environment.
- The state scan remains bounded and read-only. It reports runtime/framework evidence and path metadata; it is not a full raw application-state export.
- The network recorder is still limited to same-origin fetch/XHR traffic visible to the injected page hook; it is not a browser-wide packet capture.

Additional 2.5.287 regression coverage
- Content bridge waits for page-hook readiness and NETWORK_CAPTURE_CONTROL_ACK.
- Dashboard requires persisted captureId/status/capture-start event before toggling to Stop Network Capture.
- Redux DOM traversal is lazily bounded to 500 elements and a 1-second budget; regression test rejects eager full-DOM spread-before-slice.


2.5.289 Redux/App State recovery validation
- Replaced the dashboard chrome.scripting.executeScript call (which repeatedly timed out in the user's game tab) with the existing page-hook/content-script bridge.
- Added request-ID correlation and an explicit page-hook response timeout; dashboard records the bridge stage and exports a failure JSON if unavailable.
- Added a bounded runtime/state-path collector with candidate, framework, root and loaded-script metadata. This is a diagnostic path report, not a promise of full private Redux state.
- Added behavioral tests that execute the collector against mocked runtime objects, verify discovered paths, verify zero-candidate behavior, and assert bridge request/response wiring.
- No changes to background.js, realm sync code, recipes, buildings, production-rate data, or planner core.


Sim Companies Manager 2.5.290 - DOM & Runtime Inspection
- Added a separate Download DOM & Runtime Inspection JSON control using the isolated content-script context; it does not depend on the Redux/page-hook diagnostic response.
- Collects bounded element counts, root markers, React Fiber/props/container markers, relevant building/production/profit/calculator text snippets, embedded JSON script key summaries, script elements, and script resource timing metadata.
- Filters sensitive-looking content, avoids input values, caps the DOM scan at 1,200 selector results and 900ms, and marks truncated reports.
- Adds behavioral tests for calculator text, React marker detection, embedded JSON key summaries, sensitive text exclusion, and dashboard/content-script wiring.
- No changes to recipes, buildings, production rates, planner calculations, production-history handling, background sync algorithms, or network-capture behavior.
