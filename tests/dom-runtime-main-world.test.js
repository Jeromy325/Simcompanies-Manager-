'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'page-hook.js'), 'utf8');
const start = source.indexOf('  const collectDomRuntimeDiagnostic = (requestId) => {');
const end = source.indexOf('  // Request a GET using the game\'s page context', start);
assert.ok(start >= 0 && end > start, 'MAIN-world DOM collector is present');
const collector = source.slice(start, end).trim();
const reactNode = {tagName:'DIV',id:'building-panel',innerText:'Building Steel production profit per hour',textContent:'Building Steel production profit per hour',attributes:[{name:'data-testid',value:'building-panel'}],__reactFiber$abc:{memoizedProps:{building:{id:7}}}};
const button = {tagName:'BUTTON',id:'profit-button',innerText:'Profit per hour $902.48',textContent:'Profit per hour $902.48',attributes:[{name:'aria-label',value:'Profit per hour'}]};
const document = {
  title:'Sim Companies', readyState:'complete', body:{innerText:'Profit per hour $902.48'},
  getElementsByTagName:()=>[reactNode,button],
  querySelectorAll:(selector)=> selector==='*' ? [reactNode,button] : []
};
let tick=0;
const sandbox={document,window:{React:{},ReactDOM:{}},location:{href:'https://www.simcompanies.com/landscape/',pathname:'/landscape/'},performance:{now:()=>++tick,getEntriesByType:()=>[]},Date,String,Object,Array,Number,Math,Set,JSON,RegExp};
vm.createContext(sandbox);
vm.runInContext(`${collector}\nthis.__collect=collectDomRuntimeDiagnostic;`,sandbox);
const report=sandbox.__collect('dom-main-test');
assert.equal(report.diagnostic,'simcompanies-dom-runtime-inspection');
assert.equal(report.runtime.mainWorld,true);
assert.ok(report.dom.reactMarkerCount>0,'page-owned React expando markers are visible in MAIN world');
assert.ok(report.dom.relevantBodyTextSnippets.some(x=>/profit per hour/i.test(x)),'relevant visible page text is captured');
assert.ok(report.dom.relevantNodes.some(x=>/Steel production/i.test(x.text||'')),'relevant DOM nodes are captured');
assert.equal(report.dom.scanCompleteness,'complete','full element scan reports completion accurately');
assert.ok(JSON.stringify(report).includes('private@example.com')===false,'fixture contains no personal data');
assert.equal(report.dom.relevantNodes.length,2,'all DOM elements are exported, not only keyword-matched nodes');
console.log('DOM MAIN-world collector behavioral tests passed.');
