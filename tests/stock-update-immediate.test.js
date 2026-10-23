'use strict';
// v2.5.328: collecting resources (or any stock-changing game action) updates the warehouse and overlay at once.
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const root=path.join(__dirname,'..');const hook=fs.readFileSync(path.join(root,'page-hook.js'),'utf8'),bg=fs.readFileSync(path.join(root,'background.js'),'utf8');
// 1) page-hook: which requests count as stock-changing (run the real function)
const a=hook.indexOf('  const isStockMutationUrl = '),b=hook.indexOf('\n  };',a)+4;
const ctx={URL,location:{href:'https://www.simcompanies.com/r2/landscape/',origin:'https://www.simcompanies.com'}};vm.createContext(ctx);
vm.runInContext(hook.slice(a,b)+';this.f=isStockMutationUrl;',ctx);const f=ctx.f;
for(const [url,m] of [['/api/v2/companies/buildings/54312828/collect/','POST'],['/api/v2/order/take/123/','POST'],['/api/v2/market-order/','POST'],['/api/v3/contracts-incoming/1/accept/','PUT'],['/api/v2/companies/buildings/1/production/','POST'],['/api/v2/companies/buildings/1/','PATCH']])
  assert.equal(f(url,m),true,`${m} ${url} refreshes the warehouse`);
for(const [url,m] of [['/api/v3/resources/1/','GET'],['/api/v2/chat/messages/','POST'],['/api/v2/notifications/read/','POST'],['/api/v2/settings/','PUT'],['https://www.google-analytics.com/g/collect','POST'],['/g/collect','POST']])
  assert.equal(f(url,m),false,`${m} ${url} does not`);
// 2) background: an untagged action goes to the active realm, not R1 (validRealmNumber(null) === 0)
assert.match(bg,/let realm=\(m\.captureRealm===null\|\|m\.captureRealm===undefined\|\|m\.captureRealm===''\)\?null:validRealmNumber\(m\.captureRealm\);/);
assert.match(bg,/if\(realm==null\)\{try\{const meta=await chrome\.storage\.local\.get\(\{activeRealmKey:null\}\)/);
// 3) background: VWAP downloads no longer hold the realm storage queue
const vs=bg.slice(bg.indexOf('async function runVwapSync(options={}){'),bg.indexOf('async function runVwapSync(options={}){')+600);
assert.doesNotMatch(vs,/enqueueApiStorage\(\(\)=>runVwapSyncUnlocked/,'VWAP sync is not wrapped in the storage queue');
const body=bg.slice(bg.indexOf('async function runVwapSyncUnlocked('),bg.indexOf('async function runLiveMarketRefreshUnlocked('));
assert.doesNotMatch(body,/await setVwapStatusUnlocked\(|await commitLatestRealmPatch\(/,'VWAP writes go through short queued transactions');
assert.match(bg,/function vwapLockedStatus\(patch=\{\},realmArg=null\)\{[^}]*enqueueApiStorage\(/);
// 4) batching: an action during a running fetch triggers one more fetch
assert.match(bg,/if\(\(warehouseMutationLastAt\.get\(n\)\|\|0\)>startedAt&&!warehouseMutationRefreshTimers\.has\(n\)\)scheduleWarehouseRefreshAfterStockMutation\(n,150\);/);
assert.match(bg,/if\(inFlight\)inFlight\.finally\(start\); else start\(\);/);
console.log('stock-update-immediate: all assertions passed');
assert.match(fs.readFileSync(path.join(root,'background.js'),'utf8'),/if\(existing\)return gameOverlayDirty\.has\(n\)\?existing\.catch\(\(\)=>\{\}\)\.then\(\(\)=>refreshGameOverlayDataHeavy\(n\)\):existing;/,'a change during an in-flight overlay rebuild triggers one more rebuild');
console.log('stock-update-immediate: in-flight rebuild assertion passed');
// v2.5.329: all-fresh price runs are logged as skipped, not failure; dashboard has no inline handlers (CSP).
{
  const bg3=fs.readFileSync(path.join(root,'background.js'),'utf8'),dash3=fs.readFileSync(path.join(root,'dashboard.js'),'utf8');
  assert.match(bg3,/const outcome=out\.length\?\(failures\.length\?'partial':'success'\):\(\(freshCacheHits>0&&!failures\.length\)\?'skipped':'failure'\);/);
  const outcome=(out,failures,fresh)=>out?(failures?'partial':'success'):((fresh>0&&!failures)?'skipped':'failure');
  assert.equal(outcome(0,0,37),'skipped');assert.equal(outcome(0,2,0),'failure');assert.equal(outcome(5,0,0),'success');assert.equal(outcome(5,1,0),'partial');
  assert.doesNotMatch(dash3.replace(/\/\/[^\n]*/g,''),/\son(?:error|load|click|change|input)="/,'no inline event-handler attributes (blocked by extension CSP)');
  assert.match(dash3,/document\.addEventListener\('error',e=>\{const t=e\.target;if\(!t\|\|t\.tagName!=='IMG'/,'image fallback runs from one capture-phase listener');
  console.log('stock-update-immediate: price-outcome + CSP assertions passed');
}
