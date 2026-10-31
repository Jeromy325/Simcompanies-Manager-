#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','dashboard.js'),'utf8');
const start=source.indexOf("const plannerInputsChanged=flags.buildingsChanged||(flags.productionChanged&&!hoursEchoOnly);");
assert.ok(start>=0,'targeted production refresh branch exists');
const handler=source.slice(start,start+1000);
assert.match(handler,/if\(plannerInputsChanged\)renderBuildingPlanner\(scmReactiveViewState\(fresh\),\{background:true\}\)/,
  'building/production changes should refresh the planner feature');
assert.doesNotMatch(handler,/profitabilityTestState|renderProfitabilityTestRun/,'retired profitability widget is not referenced by targeted refresh');
assert.doesNotMatch(handler,/if\(activeTab==='production'\|\|activeTab==='diagnostic'\)scheduleDashboardRender\(\)/,
  'production storage updates must not schedule a full dashboard rebuild');
console.log('production-targeted-refresh-regression: passed');
