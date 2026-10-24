// 2.5.354: monitor modes (bar / small dot / hidden) + draggable game overlay cards.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.365');
const lu = read('live-updates.js'), css = read('monitor-overlay.css'), cs = read('content.js');
// 2.5.361: × collapses to the dot (the − button is gone); the game page reads the mode with its 3 s poll (no storage listener)
assert.ok(lu.includes('scm-monitor-hide') && lu.includes('scm-monitor-mini') && !lu.includes('scm-monitor-min"'), '× / dot');
assert.ok(lu.includes("chrome.storage.local.set({ scmMonitorGameMode: m })") && lu.includes("__applyMode?.(got.scmMonitorGameMode)"), 'mode shared with the Manager, applied on the next poll');
assert.ok(lu.includes('<option value="hidden">Hidden</option>') && lu.includes("(GAME ? '' : '<label class=\"lu-game-mode\">"), 'Manager panel can bring it back');
assert.ok(lu.includes("!e.target.closest?.('#scmMonitor')"), 'tap outside closes the list');
assert.ok(css.includes('#scmMonitor[hidden]{display:none!important}') && css.includes('#scmMonitor.is-mini .scm-monitor-mini{display:flex'));
for (const id of ['scm-game-balance-card', 'scm-left-copy-card', 'scm-contract-helper-card']) assert.ok(cs.includes(`'${id}'`) && cs.includes("DRAG_CARDS=['scm-game-balance-card','scm-left-copy-card','scm-contract-helper-card']"), id);
assert.ok(cs.includes("localStorage.setItem('scmCardPos:'+x.id") && cs.includes("localStorage.removeItem('scmCardPos:'+x.id)"), 'position kept, double-tap resets');
assert.ok(cs.includes('Math.hypot(e.clientX-d.sx,e.clientY-d.sy)<6'), 'taps on header buttons still work (drag starts after 6 px)');
assert.ok(cs.includes(".scm-go-head,.scm-left-copy-head,.scm-ch-head,.scm-go-collapsed .scm-go-toggle{touch-action:none"), 'touch drag does not scroll the page');
assert.ok(!/\son(click|pointerdown)\s*=\s*["']/i.test(lu), 'no inline handlers');
console.log('v354-regression: passed');
