'use strict';
// v2.5.327: page-hook.js holds intercepted events until content.js sends 'INITIALIZED'.
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const root=path.join(__dirname,'..');
const hook=fs.readFileSync(path.join(root,'page-hook.js'),'utf8'),content=fs.readFileSync(path.join(root,'content.js'),'utf8');
const start=hook.indexOf('  // v2.5.326 bridge event queue'),end=hook.indexOf('  const replay = ');
assert.ok(start>0&&end>start,'queue block present before replay()');
const posted=[],timers=[];
const ctx={window:{postMessage:(m)=>posted.push(m)},setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},Set,Math};
vm.createContext(ctx);
vm.runInContext(hook.slice(start,end)+';this.api={emit,flushBridgeQueue,get queue(){return bridgeQueue},get dropped(){return bridgeDropped},MAX:BRIDGE_QUEUE_MAX,FALLBACK:BRIDGE_FALLBACK_FLUSH_MS};',ctx);
const api=ctx.api;
// network events are held; replies and HOOK_READY are not
api.emit('API_DATA',{url:'/api/1/'});api.emit('API_SEEN',{url:'/api/1/'});api.emit('API_DATA',{url:'/api/2/'});
assert.equal(posted.length,0,'intercepted events are queued until INITIALIZED');
api.emit('HOOK_READY',{});api.emit('API_RESULT',{id:1});
assert.deepEqual(posted.map(m=>m.type),['HOOK_READY','API_RESULT'],'handshake and request replies are posted immediately');
// flush preserves order, then events go direct
posted.length=0;assert.equal(api.flushBridgeQueue(),3);
assert.deepEqual(posted.map(m=>m.type+(m.url||'')),['API_DATA/api/1/','API_SEEN/api/1/','API_DATA/api/2/'],'queued events are flushed in original order');
assert.ok(posted.every(m=>m.source==='SIMCO_MANAGER'),'flushed messages keep the bridge envelope');
posted.length=0;api.emit('API_DATA',{url:'/api/3/'});assert.equal(posted.length,1,'after INITIALIZED events are posted directly');
assert.equal(api.flushBridgeQueue(),0,'a repeated INITIALIZED is harmless');
// fallback timer exists so nothing is held forever
assert.ok(timers.some(t=>t.ms===api.FALLBACK&&t.ms>=5000&&t.ms<=30000),'fallback flush timer is scheduled');
// overflow drops the oldest and counts it (fresh context)
const p2=[];const c2={window:{postMessage:m=>p2.push(m)},setTimeout:()=>0,Set,Math};vm.createContext(c2);
vm.runInContext(hook.slice(start,end)+';this.api={emit,flushBridgeQueue,get dropped(){return bridgeDropped},MAX:BRIDGE_QUEUE_MAX};',c2);
for(let i=0;i<c2.api.MAX+5;i++)c2.api.emit('API_DATA',{url:'/api/'+i+'/'});
assert.equal(c2.api.dropped,5,'overflow is counted');c2.api.flushBridgeQueue();
assert.equal(p2.length,c2.api.MAX);assert.equal(p2[0].url,'/api/5/','oldest events are the ones dropped');
// handshake wiring
assert.match(hook,/event\.data\.type === 'INITIALIZED'\) \{[\s\S]{0,200}flushBridgeQueue\(\)[\s\S]{0,120}post\('INITIALIZED_ACK'/,'page-hook flushes and acknowledges on INITIALIZED');
assert.match(content,/type:'INITIALIZED' \}, '\*'\); \} catch \{\}\s*$/,'content.js announces INITIALIZED after all listeners are attached (end of file)');
assert.match(content,/if \(!bridgeInitializedAck\) sendBridgeInitialized\(\);/,'content.js re-announces when HOOK_READY arrives (page hook started later)');
console.log('bridge-queue-handshake: all assertions passed');
