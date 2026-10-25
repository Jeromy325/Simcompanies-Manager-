// 2.5.364: visible Output picker beside Building Type; grouped building types; readable option lists.
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const dash = read('dashboard.js'), css = read('styles.css');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.372');
assert.ok(/<select id="buildingOutput"[^>]*>\$\{productOptions\}<\/select>/.test(dash), 'visible Output select uses the same product options');
assert.ok(/\$\('#buildingOutput'\)\.onchange=\(\)=>onProductPick\(/.test(dash) && /\$\('#buildingProduct'\)\.onchange=\(\)=>onProductPick\(/.test(dash), 'both pickers share one handler');
assert.ok(/select option,select optgroup\{color:#e7edf5;background-color:#0d151e\}/.test(css), 'option colours explicit');
console.log('v364-regression: ok');
