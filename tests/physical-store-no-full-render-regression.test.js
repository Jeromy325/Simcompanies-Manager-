#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','dashboard.js'),'utf8');
const start=source.indexOf('const relevant=dashboardChangeAffectsTab(changes,activeTab);');
assert.ok(start>=0,'storage listener should classify relevant changes');
const handler=source.slice(start,start+1500);
assert.match(handler,/Physical realm-store writes are already reconciled by queuePhysicalRealmStateRefresh/,
  'documents targeted refresh ownership');
assert.match(handler,/const physicalTabHandled=activeTab==='production' && physicalRealmKeys\.length>0/,
  'treat Production physical-store writes as handled by the targeted refresh path');
assert.match(handler,/if\(relevant&&!physicalTabHandled\)scheduleDashboardRender\(\)/,
  'do not schedule a full dashboard render after a physical-store update was handled in place');
console.log('physical-store-no-full-render-regression: passed');
