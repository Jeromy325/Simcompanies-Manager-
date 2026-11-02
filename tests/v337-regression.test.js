// 2.5.337: compact Alerts page — one row per alert with its setting on the same row; the generic 16px label margin
// is removed inside the panel (measured: panel 1,565 px → 799 px at 360 px). Labels unchanged.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
{const _v=(JSON.parse(read('manifest.json')).version).split('.').map(Number),_m=[2,5,396];assert.ok(_v[0]>_m[0]||(_v[0]===_m[0]&&(_v[1]>_m[1]||(_v[1]===_m[1]&&_v[2]>=_m[2]))),'manifest version is 2.5.396 or newer');}
const html = read('dashboard.html'), css = read('styles.css');
assert.ok(html.includes('class="panel notify-panel nf-compact" id="notifyPanel"'));
assert.equal((html.match(/class="nf-row"/g) || []).length, 11, '11 alert rows (2.5.350: −2 removed, +1 sales; 2.5.359: +1 economy phase)');
assert.ok(html.includes('Batch finished — what it cost and what it is worth now') && html.includes('Alert when the price drops to or below'), 'labels kept');
assert.ok(/<div class="nf-row"><label><input data-nf="bigMove"[^]*?<span class="nf-val"><input data-nfv="bigMovePct"/.test(html), 'threshold on the same row');
assert.ok(css.includes('#notifyPanel label,#notifyPanel input,#notifyPanel select,#notifyPanel h3,#notifyPanel p{margin-top:0;margin-bottom:0}'));
console.log('v337-regression: all assertions passed');
