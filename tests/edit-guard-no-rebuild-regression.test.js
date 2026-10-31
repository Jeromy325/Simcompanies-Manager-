#!/usr/bin/env node
'use strict';
// Typing in a Production run-hours (or any) field must never be wiped by a background repaint.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const src=fs.readFileSync(path.join(__dirname,'..','dashboard.js'),'utf8');
const cut=(a,b)=>{const i=src.indexOf(a),j=src.indexOf(b,i);assert.ok(i>=0&&j>i,'missing '+a);return src.slice(i,j);};

// 1. Behavioural: the guard + planner repaint gate, run against a fake DOM.
const guard=cut('const SCM_EDIT_QUIET_MS','let __flushRenderTimer')+'let __flushRenderTimer=0;';
const gate=cut('function plannerRepaintBlocked','function renderBuildingPlanner');
let now=1e6,active=null;const listeners={};
const ctx={Date:{now:()=>now},setTimeout:()=>0,clearTimeout(){},console,
  document:{get activeElement(){return active;},addEventListener:(t,fn)=>{listeners[t]=fn;}},
  window:{},scmReactiveViewState:x=>x,renderBuildingPlanner(){}};
vm.createContext(ctx);
vm.runInContext(guard+gate+';this.api={dashboardEditorActive,plannerRepaintBlocked};',ctx);
const {dashboardEditorActive,plannerRepaintBlocked}=ctx.api;
const input={matches:s=>/input/.test(s)};
assert.equal(dashboardEditorActive(),false,'idle dashboard is not editing');
active=input;assert.equal(dashboardEditorActive(),true,'focused input blocks renders');
active=null;listeners.input({target:input});
assert.equal(dashboardEditorActive(),true,'input edited <2s ago still blocks renders');
now+=2100;assert.equal(dashboardEditorActive(),false,'quiet window expires');
const host={};
active=input;
assert.equal(plannerRepaintBlocked(host,{background:true}),true,'background repaint deferred while editing');
assert.equal(host.__plannerPendingRepaint,true,'repaint is queued, not dropped');
assert.equal(plannerRepaintBlocked(host,{}),false,'user-initiated repaint is never blocked');
active=null;now+=2100;
assert.equal(plannerRepaintBlocked({},{background:true}),false,'repaint runs once editing ends');

// 2. Wiring.
assert.match(src,/focusout',\(\)=>setTimeout\(flushPendingDashboardRender/,'queued render flushes after blur');
assert.match(src,/renderBuildingPlanner\(scmReactiveViewState\(fresh\),\{background:true\}\)/,'storage-driven planner repaint is background');
const oninput=cut("$('#buildingRunHours').oninput","$('#buildingRunHours').onchange");
assert.ok(!/renderBuildingPlanner|applyRunHours|setTimeout/.test(oninput),'typing in run hours must not repaint/save mid-edit');
assert.match(src,/\$\('#buildingRunHours'\)\.onchange=\(\)=>\{clearTimeout\(runHoursSaveTimer\);applyRunHours/,'run hours commit on change/blur');
assert.match(src,/hoursEchoOnly/,'run-hours save echo does not repaint the planner');
// 3. hoursEchoOnly: evaluate the real expression from dashboard.js against real scmProductionSignature.
const sigSrc=cut('function scmProductionSignature','function scmDiagnosticSignature');
const exprStart=src.indexOf('try{hoursEchoOnly=');const exprEnd=src.indexOf('}catch{}',exprStart);
const expr=src.slice(exprStart+4,exprEnd);
const echo=(flags,oldStore,newStore,uiHours)=>{
  const c={flags,oldStore,newStore,hoursEchoOnly:false,plannerUiState:()=>({runHours:uiHours}),scmReactiveViewState:x=>x,fresh:{}};
  vm.createContext(c);vm.runInContext(sigSrc+';'+expr,c);return c.hoursEchoOnly;
};
const base={productionEvents:[],productionRateSnapshots:{},productionPlans:{},productionRunHours:24};
const flagsP={productionChanged:true,buildingsChanged:false};
assert.equal(echo(flagsP,base,{...base,productionRunHours:30},30),true,'hours-only echo matching the UI is skipped');
assert.equal(echo(flagsP,base,{...base,productionRunHours:30},31),false,'hours differing from the UI still repaints');
assert.equal(echo(flagsP,base,{...base,productionRunHours:30,productionPlans:{a:{buildingId:1,plannedLevel:3}}},30),false,'other production data changed -> repaint');
assert.equal(echo({productionChanged:true,buildingsChanged:true},base,{...base,productionRunHours:30},30),false,'buildings changed -> repaint');
console.log('edit-guard-no-rebuild-regression: passed');
