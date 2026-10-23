const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
assert.match(content, /scm-mobile-network-capture-indicator/, 'creates a small on-page capture indicator');
assert.match(content, /Captured: \$\{events\.toLocaleString\(\)\} events/, 'shows the persisted captured-event count');
assert.match(content, /requests\.toLocaleString\(\).*errors\.toLocaleString\(\)/, 'shows request and error counts');
assert.match(content, /setInterval\(pollCaptureOverlayStatus,2000\)/, 'reconciles status with the background capture count');
assert.match(content, /const stopCaptureOverlay = \(\) =>[\s\S]*?scmCaptureOverlay\?\.remove\(\)/, 'removes the card when capture is stopped');
assert.match(content, /if \(message\.enabled\) startCaptureOverlay/, 'shows the card when capture starts');
assert.match(content, /else stopCaptureOverlay\(\)/, 'hides the card when capture is stopped');
console.log('Mobile network capture overlay regression checks passed.');

assert.match(content,/status\.mode === 'mobile-page' && status\.captureId && \['recording','limit-reached'\]\.includes\(status\.status\)/,'restores active mobile capture after page refresh');
