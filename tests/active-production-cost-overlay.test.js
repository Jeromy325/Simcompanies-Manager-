const fs=require('fs');const path=require('path');const vm=require('vm');const assert=require('assert/strict');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'dashboard.html'),'utf8');
const dash=fs.readFileSync(path.join(root,'dashboard.js'),'utf8');
const content=fs.readFileSync(path.join(root,'content.js'),'utf8');
assert.doesNotMatch(html,/Building Profitability\s*[—-]\s*Test Run|profitabilityTestPanel|toggleProfitabilityTest|profitability-core\.js/,'retired profitability test UI and core script are absent');
assert.doesNotMatch(dash,/profitabilityTestState|renderProfitabilityTestRun|estimateBuildingContributions/,'retired profitability mappings/calculations are removed from dashboard');
assert.doesNotMatch(content,/__SCM_HELPER_MENU__|const items = \[|scm-helper-card|GET_HELPER_OVERLAY_DATA/,'floating helper launcher implementation and page-side helper mappings are removed');
assert.match(dash,/function activeProductionCostEntries\(s\)/,'warehouse table maps active busy.resource unit cost');
assert.match(dash,/function activeProductionCostCells\(s,r\)/,'warehouse table maps active cost and difference');
assert.match(dash,/data-cell="active-production-cost"/,'incremental warehouse patch updates active production cost');
assert.match(dash,/data-cell="production-stock-diff"/,'incremental warehouse patch updates production-vs-stock difference');
assert.doesNotMatch(content,/scm-active-production-cost/,'game page Active Production Unit Cost overlay is removed');
assert.doesNotMatch(content,/__SCM_ACTIVE_PRODUCTION_COST_OVERLAY__/,'removed overlay no longer injects UI or polling into game page');
console.log('active-production-cost-overlay: passed');

function extractFunction(source,name){const marker=`function ${name}(`,start=source.indexOf(marker);assert.notEqual(start,-1,`found ${name}`);const open=source.indexOf('{',start);let depth=0,quote=null,escape=false;for(let i=open;i<source.length;i++){const c=source[i];if(quote){if(escape){escape=false;continue;}if(c==='\\'){escape=true;continue;}if(c===quote)quote=null;continue;}if(c==='"'||c==="'"||c==='`'){quote=c;continue;}if(c==='{')depth++;else if(c==='}'&&--depth===0)return source.slice(start,i+1);}throw Error(`unterminated ${name}`);}
const ctx={Number,String,Math,Array,Object,Set,Map,JSON,escapeHtml:x=>String(x),money:x=>`$${Number(x).toFixed(2)}`,resourceName:(x)=>`Resource ${x.kind}`,buildingName:b=>b.name,buildingArrayFromState:()=>[
 {id:1,name:'Factory A',busy:{resource:{kind:42,name:'Steel',quality:2,unitCost:8}}},
 {id:2,name:'Factory B',busy:{resource:{kind:42,name:'Steel',quality:2,unitCost:12}}},
 {id:3,name:'Factory C',busy:{resource:{kind:42,name:'Steel',quality:1,unitCost:4}}}
]};
vm.createContext(ctx);vm.runInContext([extractFunction(dash,'activeProductionCostEntries'),extractFunction(dash,'activeProductionCostCells')].join('\n'),ctx);
const compared=ctx.activeProductionCostCells({}, {_id:42,_quality:2,_unitCost:10});
assert.match(compared.costHtml,/\$8\.00/);assert.match(compared.costHtml,/\$12\.00/,'multiple active buildings remain distinct, not averaged');
assert.match(compared.diffHtml,/class="active-cost-line positive"><strong>−\$2\.00/,'production cheaper than warehouse is green');
assert.match(compared.diffHtml,/class="active-cost-line negative"><strong>\+\$2\.00/,'production more expensive than warehouse is red');
assert.doesNotMatch(compared.costHtml,/\$4\.00/,'different quality is never compared as equivalent stock');
const noWarehouse=ctx.activeProductionCostCells({}, {_id:42,_quality:2,_unitCost:null});assert.match(noWarehouse.diffHtml,/—/,'missing warehouse unit cost does not invent a difference');

console.log('active-production-cost-overlay removal and warehouse-cost table regression: passed');
