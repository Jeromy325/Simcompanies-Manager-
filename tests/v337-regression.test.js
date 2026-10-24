// 2.5.337: compact Alerts page — one row per alert with its setting on the same row; the generic 16px label margin
// is removed inside the panel (measured: panel 1,565 px → 799 px at 360 px). Labels unchanged.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.346');
const html = read('dashboard.html'), css = read('styles.css');
assert.ok(html.includes('class="panel notify-panel nf-compact" id="notifyPanel"'));
assert.equal((html.match(/class="nf-row"/g) || []).length, 11, '11 alert rows');
assert.ok(html.includes('Batch finished — what it cost and what it is worth now') && html.includes('Alert when the price drops to or below'), 'labels kept');
assert.ok(/<div class="nf-row"><label><input data-nf="bigMove"[^]*?<span class="nf-val"><input data-nfv="bigMovePct"/.test(html), 'threshold on the same row');
assert.ok(css.includes('#notifyPanel label,#notifyPanel input,#notifyPanel select,#notifyPanel h3,#notifyPanel p{margin-top:0;margin-bottom:0}'));
console.log('v337-regression: all assertions passed');
