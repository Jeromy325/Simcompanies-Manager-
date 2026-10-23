'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
const context={Map,Set,Object,Number,String,Math,Array,JSON};vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'..','diagnostic-core.js'),'utf8'),context);
const core=context.SCM_DIAGNOSTIC_CORE;
const report=core.endpointCoverageReport({events:[
 {kind:'request-start',method:'GET',url:'/api/v2/a/'},
 {kind:'fetch',method:'GET',url:'/api/v2/a/',status:200,ok:true,body:{x:1}},
 {kind:'request-start',method:'GET',url:'/api/v2/b/'},
 {kind:'fetch',method:'GET',url:'/api/v2/b/',status:200,ok:true,body:null},
 {kind:'resource-timing-snapshot',resources:[{url:'/api/v2/c/',initiatorType:'fetch'}]}
]});
const a=report.find(x=>x.endpoint==='/api/v2/a/'),b=report.find(x=>x.endpoint==='/api/v2/b/'),c=report.find(x=>x.endpoint==='/api/v2/c/');
assert.equal(a.requestCount,1);assert.equal(a.successfulResponseCount,1);assert.equal(a.bodyCapturedCount,1);assert.equal(a.parseStatuses.parsed,1);
assert.equal(b.responseBodyMissingCount,1);assert.equal(b.timingOnlyCount,1);assert.equal(b.coverageStatus,'response-without-saved-body');
assert.equal(c.requestCount,0);assert.equal(c.resourceTimingCount,1);assert.equal(c.coverageStatus,'response/timing-only');
console.log('endpoint-coverage-report: 10 assertions passed');
