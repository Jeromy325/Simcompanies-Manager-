// 2.5.346: compact saved-contract cards on phones (user screenshot 2026-10-23: price/buttons scattered).
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.350');
const css = read('styles.css'), P = 'html.scm-mobile .contract-table.saved-contract-table.mobile-cards:not(.contract-surplus-table) tr:not(.mc-full)';
// specificity must beat the generic contract-card rule (it put Price on top of Total)
for (const [n, place] of [[3, 'grid-row:1'], [9, 'grid-column:3;grid-row:1'], [1, 'grid-column:3;grid-row:2'], [8, 'grid-column:3;grid-row:3'], [10, 'grid-column:3;grid-row:4']])
  assert.ok(css.includes(`${P} td:nth-child(${n}){`) && css.slice(css.indexOf(`${P} td:nth-child(${n}){`)).split('}')[0].includes(place), `cell ${n} ${place}`);
const html = read('dashboard.html'); assert.ok(/saved-contract-table mobile-cards/.test(html));
assert.equal((html.match(/<table class="contract-table saved-contract-table[\s\S]*?<\/thead>/)[0].match(/<th>/g) || []).length, 10, '10 columns');
console.log('v346-regression ok');
