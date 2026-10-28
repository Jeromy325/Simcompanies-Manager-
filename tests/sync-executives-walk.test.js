'use strict';
// The Sync page walk captures the Executives roster and each executive's own record (work history,
// trainings), so a new device fills the Executives tab on its first Sync. Behaviour checks, no version pins.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const background=fs.readFileSync(path.join(root,'background.js'),'utf8');
const dashboard=fs.readFileSync(path.join(root,'dashboard.js'),'utf8');

// Load the pure helpers from background.js.
const helperStart=background.indexOf('const EXECUTIVES_SYNC_DETAIL_MAX=');
const helperEnd=background.indexOf('async function syncNow(',helperStart);
assert.ok(helperStart>=0&&helperEnd>helperStart,'executives walk helpers are present before syncNow');
const ctx={};
vm.createContext(ctx);
vm.runInContext(background.slice(helperStart,helperEnd)+';this.H={EXECUTIVES_SYNC_DETAIL_MAX,executivesRosterPath,executiveDetailPaths,syncRequiredTargetsOk};',ctx);
const H=ctx.H;

// Roster path: the game's api_v3_companies_executives route, and the key the Executives tab looks up.
assert.equal(H.executivesRosterPath(4242),'/api/v3/companies/4242/executives/');
assert.equal(H.executivesRosterPath(0),null);
assert.equal(H.executivesRosterPath(undefined),null);
assert.equal(H.executivesRosterPath('abc'),null);
const tabKeyRe=dashboard.match(/function renderBoardRoom[\s\S]*?Object\.keys\(ep\)\.find\(k=>(\/[^\n]*?\/)\.test\(k\)\)/);
assert.ok(tabKeyRe,'Executives tab finds the roster by a path regex');
const tabRe=new RegExp(tabKeyRe[1].slice(1,-1));
assert.ok(tabRe.test(H.executivesRosterPath(4242)),'the synced roster key is the one the Executives tab reads');
assert.match(dashboard,/const ex=exKey\?ep\[exKey\]\?\.data\?\.executives:null;/,'the tab reads data.executives (the stored roster response as-is)');

// Detail paths: one /api/v4/executives/<id>/ per real executive, candidates and bad ids skipped, deduplicated, capped.
const roster=[
  {id:11,currentWorkHistory:{position:'o'}},
  {id:12,currentWorkHistory:{position:'v'}},
  {id:12,currentWorkHistory:{position:'v'}},
  {id:13,isCandidate:true},
  {id:'x'},{id:-1},null,{},
  {id:'14',currentWorkHistory:{position:'f'}},
];
assert.deepEqual([...H.executiveDetailPaths(roster)],['/api/v4/executives/11/','/api/v4/executives/12/','/api/v4/executives/14/']);
assert.deepEqual([...H.executiveDetailPaths(null)],[]);
assert.deepEqual([...H.executiveDetailPaths({executives:roster})],[],'a non-array roster yields nothing');
const big=Array.from({length:100},(_,i)=>({id:i+1}));
assert.equal(H.executiveDetailPaths(big).length,H.EXECUTIVES_SYNC_DETAIL_MAX,'detail fetches are capped');
assert.equal(H.executiveDetailPaths(big,3).length,3);

// Required-target rule: an optional target (Executives) never fails Sync; a required one does.
const targets=[{name:'Warehouse'},{name:'Contracts'},{name:'Executives',optional:true},{name:'Accounting'}];
const ok={ok:true,finalDurableVerification:{ok:true}};
const bad={ok:false,finalDurableVerification:{ok:false}};
assert.equal(H.syncRequiredTargetsOk(targets,[ok,ok,{...ok,optional:true},ok]),true);
assert.equal(H.syncRequiredTargetsOk(targets,[ok,ok,{...bad,optional:true},ok]),true,'Executives missing still completes Sync');
assert.equal(H.syncRequiredTargetsOk(targets,[ok,bad,{...ok,optional:true},ok]),false,'a required target failing fails Sync');
assert.equal(H.syncRequiredTargetsOk(targets,[ok,ok,ok]),false,'a missing result fails Sync');
assert.equal(H.syncRequiredTargetsOk(null,[]),false);

// The step is inside the Sync page walk (the targets list), before Accounting, and wired up.
const syncStart=background.indexOf('async function syncNow(');
const syncEnd=background.indexOf('\nasync function postSyncBuildingUiRefresh',syncStart);
const syncBody=background.slice(syncStart,syncEnd);
const targetsSrc=syncBody.slice(syncBody.indexOf('const targets=['),syncBody.indexOf('];',syncBody.indexOf('const targets=[')));
const names=[...targetsSrc.matchAll(/\{name:'([^']+)'/g)].map(m=>m[1]);
assert.ok(names.includes('Executives'),'Executives is a Sync walk target');
assert.ok(names.indexOf('Executives')<names.indexOf('Accounting'),'Accounting stays last');
assert.match(targetsSrc,/\{name:'Executives'[^}]*optional:true\}/,'Executives target is optional');
assert.match(syncBody,/target\.name==='Executives'\s*\?\s*\[executivesRosterPath\(companyId\)\]/,'roster path comes from the synced company id');
assert.match(syncBody,/executiveDetailPaths\(rosterItem\?\.data\?\.executives\)/,'details are derived from the stored roster');
assert.match(syncBody,/for\(const path of detailPaths\)\{[\s\S]*?await pageGet\(path,selected[\s\S]*?await recordAuthoritative\(path,response,row\)/,'details are fetched and saved one at a time through the game tab');
assert.match(syncBody,/const requiredOk=syncRequiredTargetsOk\(targets,results\);/,'Sync completion uses the optional-aware rule');

console.log('sync-executives-walk: all assertions passed');
