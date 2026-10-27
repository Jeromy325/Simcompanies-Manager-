// 2.5.356: monitor header row + full-width list; status not cut off (user screenshots 2026-10-24 10:28).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.394');
const css = read('monitor-overlay.css'), tail = css.slice(css.indexOf('v2.5.356'));
assert.ok(tail.includes('#scmMonitor .lu-panel{grid-column:1/-1;grid-row:2'), 'list spans the whole card, under the buttons');
assert.ok(tail.includes('#scmMonitor .scm-monitor-ctrl{grid-column:3;grid-row:1'), '− × stay in the header row');
assert.ok(tail.includes('#scmMonitor .lu-text{white-space:normal'), 'status wraps, not cut');
assert.ok(tail.includes('#scmMonitor .scm-monitor-body{display:contents}'));
console.log('v356-regression: passed');
