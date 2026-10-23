'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const start = source.indexOf('  const collectDomRuntimeDiagnostic = (requestId) => {');
const end = source.indexOf('\n  // Yandex/mobile builds', start);
assert.ok(start >= 0 && end > start, 'DOM collector function is present and bounded');
const collectorSource = source.slice(start, end).trim();
const makeEl = ({tagName='DIV', id='', text='', attrs={}, keys=[], type='', src=''}={}) => ({
  tagName, id, innerText:text, textContent:text, attributes:Object.entries(attrs).map(([name,value])=>({name,value})),
  type, src, ...Object.fromEntries(keys.map(k=>[k,{}]))
});
const profit = makeEl({tagName:'DIV',id:'profit-calculator',text:'Profit per hour $902.48 · Profit per cycle $160.52',attrs:{'data-testid':'profit-calculator','role':'region'}});
const react = makeEl({tagName:'MAIN',id:'app-root',text:'Building level 11 Production',keys:['__reactFiber$abc'],attrs:{role:'main'}});
const embedded = makeEl({tagName:'SCRIPT',id:'__NEXT_DATA__',text:JSON.stringify({props:{pageProps:{}},accessToken:'should-not-be-captured'}),type:'application/json'});
const input = makeEl({tagName:'INPUT',id:'account-email',text:'',attrs:{name:'email',type:'text',value:'private@example.com'}});
const all = [profit, react, embedded, input];
let tick=0;
const document = {
  readyState:'complete', title:'Sim Companies', body:{innerText:'Profit Calculator Building level 11'},
  getElementsByTagName:()=>all,
  querySelectorAll:(selector)=> {
    if (selector==='script[type="application/json"]'||selector==='script#__NEXT_DATA__') return [embedded];
    if (selector==='#root'||selector==='#app'||selector==='#__next'||selector==='#game'||selector==='main'||selector==='[role="main"]') return [react];
    if (selector==='[data-testid]'||selector==='[data-test]'||selector==='[class*="profit"]'||selector==='[class*="calculator"]'||selector==='button'||selector==='input'||selector==='label') return [profit,input];
    return [];
  }
};
const sandbox = {document, window:{React:undefined,ReactDOM:undefined}, location:{href:'https://www.simcompanies.com/landscape/',pathname:'/landscape/'}, performance:{now:()=>++tick,getEntriesByType:()=>[]}, Date, String, Object, Array, Number, Math, Set, JSON, RegExp};
vm.createContext(sandbox);
vm.runInContext(`${collectorSource}\nthis.__collect = collectDomRuntimeDiagnostic;`, sandbox);
const report=sandbox.__collect('dom-test-1');
assert.equal(report.diagnostic,'simcompanies-dom-runtime-inspection');
assert.equal(report.requestId,'dom-test-1');
assert.ok(report.dom.scannedElementCount>0,'DOM elements are inspected');
assert.ok(report.dom.relevantNodes.some(n=>/profit per hour/i.test(n.text||'')),'profit calculator text is captured');
assert.ok(report.dom.reactMarkerCount>0,'React DOM markers are inspected');
assert.ok(report.dom.embeddedJsonScripts.some(s=>s.id==='__NEXT_DATA__'&&s.topLevelKeys.includes('props')),'embedded JSON keys are summarized');
assert.ok(!JSON.stringify(report).includes('private@example.com'),'sensitive-looking DOM content is excluded');
assert.match(source,/RUN_DOM_RUNTIME_DIAGNOSTIC/,'content script exposes the independent DOM diagnostic message');
const dashboard=fs.readFileSync(path.join(root,'dashboard.js'),'utf8');
assert.match(dashboard,/downloadDomRuntimeDiagnostic/,'dashboard has a dedicated DOM diagnostic control');
assert.match(dashboard,/RUN_DOM_RUNTIME_DIAGNOSTIC/,'dashboard requests DOM evidence through the isolated content script');
const html=fs.readFileSync(path.join(root,'dashboard.html'),'utf8');
assert.match(html,/Advanced diagnostics &amp; full exports/,'specialist diagnostic exports are grouped under Advanced');
assert.match(html,/id="downloadDomRuntimeDiagnostic"[^>]*>DOM &amp; Runtime Inspection/,'DOM diagnostic remains available under Advanced');
console.log('DOM/runtime diagnostic behavioral tests passed.');
