// 2.5.364: visible Output picker beside Building Type; grouped building types; readable option lists.
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const dash = read('dashboard.js'), css = read('styles.css');
{const _v=(JSON.parse(read('manifest.json')).version).split('.').map(Number),_m=[2,5,396];assert.ok(_v[0]>_m[0]||(_v[0]===_m[0]&&(_v[1]>_m[1]||(_v[1]===_m[1]&&_v[2]>=_m[2]))),'manifest version is 2.5.396 or newer');}
assert.ok(/<select id="buildingOutput"[^>]*>\$\{productOptions\}<\/select>/.test(dash), 'visible Output select uses the same product options');
assert.ok(/\$\('#buildingOutput'\)\.onchange=\(\)=>onProductPick\(/.test(dash) && /\$\('#buildingProduct'\)\.onchange=\(\)=>onProductPick\(/.test(dash), 'both pickers share one handler');
assert.ok(/select option,select optgroup\{color:#e7edf5;background-color:#0d151e\}/.test(css), 'option colours explicit');
console.log('v364-regression: ok');
