'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'dashboard.js'), 'utf8');
const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
assert.equal(manifest.version, '2.5.346');
// R2 trace regression: terminal sync state must be reconciled after the async
// post-sync tail so late progress writes cannot leave the durable realm stale.
assert.match(background, /Final realm status reconciliation/);
assert.match(background, /commitLatestRealmPatch\(selected,\{\s*syncStatus:finalStatus,\s*syncError:finalSyncError,\s*lastSync:finishedAt,\s*fullSyncJob:null\s*\},\['syncStatus','syncError','lastSync','fullSyncJob'\]\)/);
assert.match(background, /trace\('final-status-reconciled'/);

// Contract-independent overlay: test the actual core demand allocation using the captured Silicon recipe demand.
const coreContext = { console, Map, Set, Object, Number, Math, Array, String };
vm.runInNewContext(fs.readFileSync(path.join(root, 'planner-core.js'), 'utf8'), coreContext);
const core = coreContext.SCMPlannerCore;
const silicon = core.balanceSupplyDemandContracts({
  warehouseRows: [{id:16, quality:2, amount:7712}],
  productionRows: [{id:16, quality:2, amount:39161.91987936268}],
  demandRows: [
    {id:16, minQuality:1, amount:10878.323759635703},
    {id:16, minQuality:1, amount:24357.05470346634}
  ], contractRows: [], incomingContractRows: [], includeQualityRows: true
}).qualityRows.filter(r => r.id === 16 && r.quality === 2);
assert.equal(silicon.length, 1);
assert.ok(Math.abs(silicon[0].demand - 35235.37846310204) < 0.01);
assert.ok(Math.abs((7712 - silicon[0].demand) - (-27523.37846310204)) < 0.01);
const overlaySource = background.slice(background.indexOf('async function buildGameOverlayData'), background.indexOf('// VWAP status belongs'));
assert.match(overlaySource, /const savedContracts=Array\.isArray\(store\?\.savedContracts\)/, 'overlay reads Manager-saved contracts');
assert.match(overlaySource, /contractRows,includeQualityRows:true/, 'saved outgoing commitments are passed to the shared balance calculation');
assert.match(overlaySource, /const netContracts=outgoing-incoming;/, 'Contracts column displays Manager-saved outgoing less incoming quantities');
assert.doesNotMatch(overlaySource, /overlayLiveOutgoingContractQuantities|contracts-outgoing/, 'overlay never reads live outgoing game-contract endpoints');
assert.doesNotMatch(background, /function overlayLiveOutgoingContractQuantities/, 'live outgoing overlay reader is removed from the source');
assert.match(overlaySource, /const left=\(Number\(r\.warehouseOnlyLeft\)\|\|0\)\+incoming;/, 'Left is warehouse minus demand, with incoming added once and no live outgoing deduction');
assert.match(overlaySource, /const producedResourceQualities=new Set\(\(productionRows\|\|\[\]\)\.map/);
assert.match(dashboard, /function savedContractSurplusMap\(s\)[\s\S]*?productionSurplusByKey/);
assert.match(dashboard, /resolveSavedContractQuantities\(\{savedContracts:contracts,baseBalanceByKey:savedContractBaseBalanceMap\(s\),surplusByKey:savedContractSurplusMap\(s\)\}\)/);
assert.doesNotMatch(overlaySource, /priorOverlayRows|exact\?\.difference|byId\?\.difference/, 'Left quantity no longer reads the previous overlay Difference');
assert.match(overlaySource, /contractSource:'manager-saved-contracts-only'/, 'new snapshots mark their saved-contract-only source');
assert.match(background, /currentSavedContractSchema=String\(snap\.contractSource\|\|''\)==='manager-saved-contracts-only'/, 'last-good snapshot path preserves new saved incoming/outgoing effects');
assert.match(dashboard, /function savedContracts\(s\)[\s\S]*?return Array\.isArray\(store\?\.savedContracts\)\?store\.savedContracts:\[\];/, 'live API contracts are never a fallback for saved contracts');
const allocated = core.balanceSupplyDemandContracts({
  warehouseRows: [{id:99, quality:1, amount:10000}], productionRows: [],
  demandRows: [{id:99, minQuality:1, amount:6000}],
  contractRows: [{id:99, quality:1, amount:4000}], includeQualityRows: true
}).qualityRows.find(r => r.id === 99 && r.quality === 1);
assert.equal(allocated.warehouse, 10000);
assert.equal(allocated.demand, 6000);
assert.equal(allocated.contracted, 4000);
assert.equal(allocated.warehouseOnlyLeft, 0, '10,000 warehouse - 6,000 demand - 4,000 contracts = 0 Left');

// Execute the actual incoming-row matcher against a synthetic DOM shaped like the mobile contract card.
const start = content.indexOf('  const collectPriceNodes=');
const end = content.indexOf('  const badgeFor=record=>{', start);
assert.ok(start >= 0 && end > start, 'incoming target matcher exists');
class El {
  constructor(text='', children=[]) { this.innerText=text; this.textContent=text; this.children=children; this.parentElement=null; this.nodeType=1; this.isConnected=true; this.dataset={}; for(const c of children)c.parentElement=this; }
  getBoundingClientRect(){ return {width:100,height:20}; }
  get parentNode(){return this.parentElement;}
  querySelectorAll(){const out=[];const walk=e=>{for(const c of e.children){out.push(c);walk(c);}};walk(this);return out;}
}
const priceNode=new El('$4.800');
const qtyNode=new El('20,100 @');
const sellerNode=new El('ZENGO MOTORS');
const totalNode=new El('$96,480');
const row=new El('',[sellerNode,qtyNode,priceNode,totalNode,new El('ACCEPT')]);
row.innerText='ZENGO MOTORS 20,100 @ $4.800 $96,480 ACCEPT'; row.textContent=row.innerText;
const body=new El('',[row]); body.innerText=row.innerText; body.textContent=body.innerText;
const all=()=>[body,...body.querySelectorAll('*')];
const context={
  Number, Math, String, RegExp, Array, document:{body,querySelectorAll(sel){return sel==='body *'?all():[];}},
  getComputedStyle(){return {display:'block',visibility:'visible'};},
};
vm.createContext(context);
vm.runInContext(`const norm=v=>String(v??'').toLowerCase().replace(/[’']/g,'').replace(/[^a-z0-9]+/g,'').replace(/s$/,''); const visible=el=>{if(!el)return false;const cs=getComputedStyle(el),r=el.getBoundingClientRect?.();return cs.display!=='none'&&cs.visibility!=='hidden'&&(!r||r.width>0&&r.height>0);}; const text=el=>String(el?.innerText||el?.textContent||'').replace(/\\u00a0/g,' ').replace(/\\s+/g,' ').trim(); const parsePrice=t=>{const m=String(t||'').match(/\\$\\s*([0-9][0-9,]*(?:\\.\\d+)?)/);return m?Number(m[1].replace(/,/g,'')):null;}; ${content.slice(start,end)}; globalThis.matcher=findContractTarget;`, context);
const target=context.matcher({company:'Zengo Motors',quantity:20100,price:4.8});
assert.ok(target, 'matcher locates grouped contract card');
assert.equal(target.row, row, 'matcher returns the displayed grouped row');
assert.equal(target.anchor, priceNode, 'matcher anchors badge to the exact unit price, not total value');
const fourRecords=[1,2,3,4].map(()=>context.matcher({company:'Zengo Motors',quantity:20100,price:4.8}));
assert.ok(fourRecords.every(x=>x&&x.row===row&&x.anchor===priceNode), 'four identical API contracts map to the same displayed row and unit-price anchor');
assert.match(content, /!wanted\.has\(String\(badge\.dataset\.contractKey\|\|''\)\)/, 'stale badges are removed when the target contract row disappears');
assert.match(content, /\.scm-contract-vwap-badge\{position:static!important;display:inline-flex!important/, 'badge stays in normal layout flow and cannot cover the contract details');
assert.match(content, /const placement=anchor\?\.parentElement&&row\.contains\(anchor\.parentElement\)\?anchor\.parentElement:row/, 'badge is placed beside the exact unit-price element inside the matched row');
assert.match(content, /if\(badge\.parentElement!==placement\)placement\.appendChild\(badge\)/, 'badge is attached inline at its price anchor rather than absolutely over the row');
assert.doesNotMatch(content, /position:absolute!important;top:4px!important;right:8px!important/, 'regression: no absolute badge overlay can cover seller or price');

// Confirm market comparison for the captured Zengo contract uses exact quality and current realm market price.
function extractFunction(source, name) {
  const marker = `function ${name}(`, at = source.indexOf(marker); assert.notEqual(at,-1);
  const brace=source.indexOf('{',at); let depth=0, quote=null, esc=false;
  for(let i=brace;i<source.length;i++){const c=source[i];if(quote){if(esc){esc=false;continue;}if(c==='\\'){esc=true;continue;}if(c===quote)quote=null;continue;}if(c==='"'||c==="'"||c==='`'){quote=c;continue;}if(c==='{')depth++;else if(c==='}'&&--depth===0)return source.slice(at,i+1);} throw Error(name);
}
const bg={Number,Math,Map,Set,Object,String,Array}; vm.createContext(bg);
vm.runInContext([extractFunction(background,'overlayCurrentMarketPrice'),extractFunction(background,'overlayVwap'),extractFunction(background,'overlayIncomingContractMarketComparison')].join('\n'),bg);
const capturedStore={liveMarketPriceData:{realm:1,rows:[{resourceId:42,quality:1,price:5}]},vwapData:{sourceRealm:1,rows:[{resourceId:42,quality:1,value:5.202325}]}};
const cmp=bg.overlayIncomingContractMarketComparison(capturedStore,{kind:42,quality:1,price:4.8},1);
assert.equal(cmp.marketPrice,5);
assert.ok(Math.abs(cmp.savingsPct-4)<1e-9, 'captured $4.80 contract is 4% below its $5.00 current-market price');
console.log('contract-overlay-regression: passed');
