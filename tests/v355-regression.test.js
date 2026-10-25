// 2.5.355: a card dragged while collapsed opens at its normal width and stays on screen (user screenshot 2026-10-24).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.368');
const cs = read('content.js');
const src = cs.slice(cs.indexOf('  const placeCard=(el,x,y)=>'), cs.indexOf('  const unpinCard=el=>'));
const ctx = { window: { innerWidth: 360, innerHeight: 780 } }; vm.createContext(ctx);
vm.runInContext(src + ';this.pinCard=pinCard;', ctx);
const mk = (collapsed, w, h) => { const cl = new Set(collapsed ? ['scm-go-collapsed'] : []); return { classList: { contains: c => cl.has(c) }, style: {}, dataset: {}, get offsetWidth() { return this.style.width ? parseFloat(this.style.width) : w; }, offsetHeight: h }; };
// collapsed: CSS size kept (no inline width)
const c1 = mk(true, 28, 28); ctx.pinCard(c1, { x: 38, y: 360 });
assert.equal(c1.style.width, ''); assert.equal(c1.style.left, '38px'); assert.equal(c1.style.top, '360px');
// same card open: full width (360 − 10), moved left to fit, shifted up so its 374 px height fits under 780
const c2 = mk(false, 28, 374); ctx.pinCard(c2, { x: 38, y: 600 });
assert.equal(c2.style.width, '350px', 'not the 28 px collapsed width');
assert.equal(c2.style.left, '10px'); assert.equal(c2.style.top, '406px', 'opens upwards to stay on screen');
assert.ok(cs.includes('if(el?.dataset.scmMoved)pinCard(el,{x:el.offsetLeft,y:el.offsetTop});'), 'rotation/resize recomputes width');
console.log('v355-regression: passed');
