const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const bg=fs.readFileSync(path.join(__dirname,'..','background.js'),'utf8');
assert.match(bg,/const producedResourceIds=new Set\(/,'produced resource ids collected');
assert.match(bg,/absorbsDemand=producedResourceIds\.has\(Number\(r\.id\)\)/,'bought quality of produced resource that absorbs demand is shown');
require(path.join(__dirname,'..','planner-core.js'));const core=globalThis.SCMPlannerCore;
// R2 engines: Q2 820 + Q4 382 in warehouse, bulldozer plan needs 1368 (Q2+).
const r=core.balanceSupplyDemandContracts({warehouseRows:[{id:52,quality:2,amount:820},{id:52,quality:4,amount:382}],demandRows:[{id:52,minQuality:2,amount:1368}],includeQualityRows:true});
const q=Object.fromEntries(r.qualityRows.map(x=>[x.quality,x]));
assert.equal(q[4].demand,382);assert.equal(Math.round(q[2].demand),986);assert.equal(q[2].demand+q[4].demand,1368);
console.log('overlay-bought-quality-demand: passed');
