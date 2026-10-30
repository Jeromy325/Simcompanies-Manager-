'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const r=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
const dash=r('dashboard.js'),an=r('analyze-ui.js'),tools=r('tools-ui.js'),html=r('dashboard.html');
// Dashboard cards: collapsed unless a card opts in with data-collapse-default="open"; both init sites.
assert.equal((dash.match(/collapseDefault!=='open'/g)||[]).length,2,'both collapse init sites default to closed');
assert.doesNotMatch(dash,/collapseDefault==='closed'/,'old default-open logic is gone');
assert.match(dash,/SCM_COLLAPSE_KEY='scmCollapseV2'/,'collapse key bumped so old open states are ignored');
assert.doesNotMatch(html+dash.replace(/^\/\/.*$/gm,''),/data-collapse-default="open"/,'no card opts in to starting open');
// Analyze: persistence stores the opened set; unknown cards are closed.
assert.match(an,/opened: new Set\(store\.get\('opened'/,'analyze persists an opened set');
assert.match(an,/const isOpen = id => S\.opened\.has\(id\)/,'analyze cards closed unless user opened them');
assert.doesNotMatch(an,/store\.get\('closed'/,'old analyze closed key unused');
// Tools help panels and plain <details> start closed.
assert.doesNotMatch(tools,/<details[^>]*\bopen\b/,'tools help starts closed');
assert.doesNotMatch(html,/<details[^>]*\bopen\b/,'dashboard.html details start closed');
// New Contract still opens its card via the head-button path.
assert.match(dash,/e\.target\.closest\('button,input,select,textarea,a,label'\)\)\{if\(el\.classList\.contains\('is-collapsed'\)\)\{scmSetCollapsed\(el,false\)/,'head buttons open a collapsed card');
console.log('collapse-default-closed: 9 assertions passed');
