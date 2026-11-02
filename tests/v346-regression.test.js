// 2.5.346: compact saved-contract cards on phones (user screenshot 2026-10-23: price/buttons scattered).
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
{const _v=(JSON.parse(read('manifest.json')).version).split('.').map(Number),_m=[2,5,396];assert.ok(_v[0]>_m[0]||(_v[0]===_m[0]&&(_v[1]>_m[1]||(_v[1]===_m[1]&&_v[2]>=_m[2]))),'manifest version is 2.5.396 or newer');}
const css = read('styles.css'), P = 'html.scm-mobile .contract-table.saved-contract-table.mobile-cards:not(.contract-surplus-table) tr:not(.mc-full)';
// specificity must beat the generic contract-card rule (it put Price on top of Total)
for (const [n, place] of [[3, 'grid-row:1'], [9, 'grid-column:3;grid-row:1'], [1, 'grid-column:3;grid-row:2'], [8, 'grid-column:3;grid-row:3'], [10, 'grid-column:3;grid-row:4']])
  assert.ok(css.includes(`${P} td:nth-child(${n}){`) && css.slice(css.indexOf(`${P} td:nth-child(${n}){`)).split('}')[0].includes(place), `cell ${n} ${place}`);
const html = read('dashboard.html'); assert.ok(/saved-contract-table mobile-cards/.test(html));
assert.equal((html.match(/<table class="contract-table saved-contract-table[\s\S]*?<\/thead>/)[0].match(/<th>/g) || []).length, 10, '10 columns');
console.log('v346-regression ok');
