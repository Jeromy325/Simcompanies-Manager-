// 2.5.362: incoming-contract badge is compact; full details open in a popup on tap.
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const content = read('content.js'), bg = read('background.js');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.396');
const sec = content.slice(content.indexOf('  const marketLabel=record=>'), content.indexOf('  const style=()=>{', content.indexOf('  const marketLabel=record=>')));
assert.ok(/window\.addEventListener\('click',onBadgeTap,true\)/.test(sec), 'tap handled in capture phase');
assert.ok(!/innerHTML/.test(sec), 'popup built with textContent (seller names are not HTML)');
assert.ok(/pointer-events:auto!important;cursor:pointer/.test(content), 'badge is tappable');
assert.ok(/c\.marketPriceSource=comparison\.marketPriceSource/.test(bg), 'VWAP-fallback source reaches the page');
assert.ok(/badge\._scmRecord=record;\}/.test(content), 'refreshed badge keeps current record for the popup');
console.log('v362-regression: ok');
