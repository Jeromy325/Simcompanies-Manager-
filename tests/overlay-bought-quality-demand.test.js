const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const bg=fs.readFileSync(path.join(__dirname,'..','background.js'),'utf8');
const src=bg.slice(bg.indexOf('function foldHigherQualityStock('),bg.indexOf('globalThis.SCMFoldHigherQualityStock'));
const fold=new Function(src+'return foldHigherQualityStock;')();
assert.match(bg,/detailRows=foldHigherQualityStock\(detailRows,producedResourceQualities,savedContractKeys\)/);
require(path.join(__dirname,'..','planner-core.js'));const core=globalThis.SCMPlannerCore;
// R2: make Q2 engines, bought Q4 382; bulldozer plan needs 1368 Q2+.
const r=core.balanceSupplyDemandContracts({warehouseRows:[{id:52,quality:2,amount:820},{id:52,quality:4,amount:382}],demandRows:[{id:52,minQuality:2,amount:1368}],includeQualityRows:true});
const rows=fold(r.qualityRows,new Set(['52:2']),new Set());
assert.equal(rows.length,1,'Q4 folded into the Q2 row');
assert.equal(rows[0].warehouse,1202);assert.equal(rows[0].demand,1368);assert.equal(Math.round(rows[0].warehouseOnlyLeft),-166);
// Lower bought quality is not folded upward.
const low=fold([{id:5,quality:1,warehouse:10,demand:0},{id:5,quality:2,warehouse:5,demand:0}],new Set(['5:2']),new Set());
assert.equal(low.length,2);
console.log('overlay-bought-quality-demand: passed');
{const r2=core.balanceSupplyDemandContracts({warehouseRows:[{id:52,quality:2,amount:820},{id:52,quality:4,amount:382}],demandRows:[{id:52,minQuality:2,amount:1368}],includeQualityRows:true});
const f=fold(r2.qualityRows,new Set(['52:2']),new Set());assert.deepEqual(f[0].substituteQualities,[4],'substitute quality flagged');
const c=fs.readFileSync(path.join(__dirname,'..','content.js'),'utf8');
assert.match(c,/scm-go-sub-neg':'scm-go-sub-pos'/,'row outlined red when short, green otherwise');
assert.match(c,/\.scm-go-sub\{border:2px solid #5dcaa5\}.*\.scm-go-sub-neg\{border-color:#ff7b7b\}/);
console.log('substitute outline: passed');}
{const r3=core.balanceSupplyDemandContracts({warehouseRows:[{id:52,quality:2,amount:820},{id:52,quality:4,amount:382}],demandRows:[{id:52,minQuality:2,amount:1368}],includeQualityRows:true});
const f=fold(r3.qualityRows,new Set(['52:2']),new Set());assert.deepEqual(f[0].warehouseByQuality,[{quality:2,amount:820},{quality:4,amount:382}]);
assert.match(fs.readFileSync(path.join(__dirname,'..','content.js'),'utf8'),/scm-go-split/);console.log('warehouse split line: passed');}
