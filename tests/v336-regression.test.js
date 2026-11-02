// 2.5.336: price-target product list filled on tap (not only at load) + plain-word conditions instead of ≤ / ≥.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
{const _v=(JSON.parse(read('manifest.json')).version).split('.').map(Number),_m=[2,5,396];assert.ok(_v[0]>_m[0]||(_v[0]===_m[0]&&(_v[1]>_m[1]||(_v[1]===_m[1]&&_v[2]>=_m[2]))),'manifest version is 2.5.396 or newer');}
const html = read('dashboard.html'), dash = read('dashboard.js');
assert.ok(html.includes('Alert when the price drops to or below') && html.includes('Alert when the price rises to or above'));
assert.ok(!/<option value="&lt;=">≤<\/option>/.test(html), 'no bare ≤ option');
assert.ok(dash.includes("['pointerdown','focus'].forEach(ev=>$('#nfTProduct')?.addEventListener(ev,fillProducts))"), 'refilled when tapped');
assert.ok(dash.includes('· producing'), 'products being made are listed too');
assert.ok(dash.includes("Alert when the price ${t.op==='>='?'rises to':'drops to'}"));
console.log('v336-regression: all assertions passed');
