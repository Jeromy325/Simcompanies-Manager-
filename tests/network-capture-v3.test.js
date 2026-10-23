const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
test('Network Capture 3.0 uses browser Network protocol and persistent IndexedDB', () => {
  const bg = read('background.js');
  const manifest = JSON.parse(read('manifest.json'));
  assert.ok(manifest.permissions.includes('debugger'));
  assert.ok(manifest.permissions.includes('unlimitedStorage'));
  for (const token of ['chrome.debugger.attach', "'Network.enable'", "'Network.getResponseBody'", 'indexedDB.open', 'SCM_NET3_START', 'SCM_NET3_EXPORT']) assert.ok(bg.includes(token), `missing ${token}`);
});
test('Network Capture 3.0 records explicit body-unavailable and transport failure evidence', () => {
  const bg = read('background.js');
  for (const token of ["kind:'body-unavailable'", "kind:'loading-failed'", "kind:'capture-error'", 'Network.webSocket', 'Network.eventSource', 'Network.requestServedFromCache']) assert.ok(bg.includes(token), `missing ${token}`);
});
test('Network Capture 3.0 export is chunked and declares limitations rather than claiming literal 100 percent', () => {
  const dash = read('dashboard.js');
  assert.ok(dash.includes("type:'SCM_NET3_EXPORT'"));
  assert.ok(dash.includes('events.length<total'));
  assert.ok(dash.includes('No browser extension can promise literally every byte'));
});
