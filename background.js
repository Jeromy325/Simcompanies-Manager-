import './diagnostic-core.js';
import './planner-core.js';
import './tools-core.js';
import './notify-core.js';
import {
  REALM_DEFINITIONS, validRealmNumber, realmDefinition, realmKeyFromRealm, realmStorageKey,
  realmDisplayNumber, realmDisplayName, realmContractPaths
} from './realm-core.js';
// v2.5.361 performance: the service worker no longer listens to chrome.storage.onChanged. Every listener receives a
// full copy of each changed value, so the ~1 MB realm store was deserialized here on every write. The three memos that
// listened (images, game constants, overlay snapshots) are only written by this worker, so its own writes clear them.
const __scmOwnWriteHooks=globalThis.__scmOwnWriteHooks=[];
{const __orig=chrome.storage.local.set.bind(chrome.storage.local);chrome.storage.local.set=(items,...rest)=>{if(items&&typeof items==='object')for(const h of __scmOwnWriteHooks){try{h(items);}catch{}}return __orig(items,...rest);};}
const realmSyncSessions=new Map();
let syncCaptureRealm=null;
const realmWriteQueues=new Map();
const frozenRateEnsurePromises=new Map();
function withRealmWriteLock(realm,task){
  const n=Number(realm);
  const previous=realmWriteQueues.get(n)||Promise.resolve();
  // Realm-local work stays independent, but every realm-store read/modify/write
  // transaction must also pass through the single physical storage commit lane.
  // Otherwise a production/overlay writer can read an older realmStores snapshot
  // while API sync is committing and then write that stale snapshot back over the
  // authoritative sync data.
  const next=previous.catch(()=>{}).then(()=>enqueueApiStorageCommit(task,n));
  realmWriteQueues.set(n,next);
  // Do not create an ignored rejected promise via `.finally()`. A failed write
  // must clear the queue entry without producing a second unhandled rejection.
  next.then(()=>{if(realmWriteQueues.get(n)===next)realmWriteQueues.delete(n)},()=>{if(realmWriteQueues.get(n)===next)realmWriteQueues.delete(n)});
  return next;
}



// Network Capture 3.0: Chrome DevTools Protocol recorder. This observes browser-level
// Network events for the selected tab (including cross-origin resources) and stores
// records in IndexedDB so chrome.storage.local quotas/event caps do not silently drop data.
const scmNetCapture = { tabId:null, captureId:null, active:false, requestMap:new Map(), counters:{events:0,requests:0,responses:0,bodies:0,errors:0}, startedAt:null };
const SCM_NET_DB='scm-network-capture-v3';
function scmNetDb(){return new Promise((resolve,reject)=>{const req=indexedDB.open(SCM_NET_DB,1);req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains('events')){const st=db.createObjectStore('events',{keyPath:'id',autoIncrement:true});st.createIndex('captureId','captureId',{unique:false});}};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error||new Error('IndexedDB open failed'));});}
async function scmNetSave(event){const db=await scmNetDb();await new Promise((resolve,reject)=>{const tx=db.transaction('events','readwrite');tx.objectStore('events').add({captureId:scmNetCapture.captureId,at:new Date().toISOString(),...event});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error||new Error('IndexedDB write failed'));});scmNetCapture.counters.events++;if(event.kind==='request')scmNetCapture.counters.requests++;if(event.kind==='response')scmNetCapture.counters.responses++;if(event.kind==='response-body')scmNetCapture.counters.bodies++;if(event.kind==='loading-failed'||event.kind==='capture-error')scmNetCapture.counters.errors++;await chrome.storage.local.set({scmNetworkCaptureV3Status:{captureId:scmNetCapture.captureId,status:scmNetCapture.active?'recording':'stopped',tabId:scmNetCapture.tabId,startedAt:scmNetCapture.startedAt,updatedAt:new Date().toISOString(),...scmNetCapture.counters}}).catch(()=>{});}
async function scmNetGetEvents(captureId){const db=await scmNetDb();return await new Promise((resolve,reject)=>{const tx=db.transaction('events','readonly');const req=tx.objectStore('events').index('captureId').getAll(captureId);req.onsuccess=()=>resolve(req.result||[]);req.onerror=()=>reject(req.error||new Error('IndexedDB read failed'));});}
async function scmNetClearEvents(captureId){const db=await scmNetDb();await new Promise((resolve,reject)=>{const tx=db.transaction('events','readwrite'),idx=tx.objectStore('events').index('captureId'),req=idx.openCursor(IDBKeyRange.only(captureId));req.onsuccess=()=>{const c=req.result;if(c){c.delete();c.continue();}};tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error||new Error('IndexedDB clear failed'));});}
async function scmMobileNetSave(captureId,event){
 const db=await scmNetDb();
 await new Promise((resolve,reject)=>{const tx=db.transaction('events','readwrite');tx.objectStore('events').add({captureId,at:new Date().toISOString(),...event});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error||new Error('Mobile network capture write failed'));});
 const stored=await chrome.storage.local.get('scmNetworkCaptureV3Status');const st=stored.scmNetworkCaptureV3Status||{};
 if(st.captureId!==captureId||st.mode!=='mobile-page')return;
 const kind=String(event.kind||'');
 st.events=(Number(st.events)||0)+1;
 if(kind==='request-start')st.requests=(Number(st.requests)||0)+1;
 if(kind==='fetch'||kind==='xhr')st.responses=(Number(st.responses)||0)+1;
 if(kind==='request-error')st.errors=(Number(st.errors)||0)+1;
 st.updatedAt=new Date().toISOString();if(kind==='capture-limit'){st.status='limit-reached';st.limitReachedAt=st.updatedAt;}
 await chrome.storage.local.set({scmNetworkCaptureV3Status:st});
}
async function scmMobileNetLogBackground(event){
 try{const saved=(await chrome.storage.local.get('scmNetworkCaptureV3Status')).scmNetworkCaptureV3Status||{};if(saved.mode!=='mobile-page'||saved.status!=='recording'||!saved.captureId)return;await scmMobileNetSave(saved.captureId,{capturedAt:new Date().toISOString(),realm:null,transport:'extension-background',...event});}catch{}
}
function scmMobileNetSafeUrl(raw){try{const u=new URL(String(raw));for(const k of [...u.searchParams.keys()])if(/token|auth|cookie|csrf|session|password|secret|jwt|access|key/i.test(k))u.searchParams.set(k,'[redacted]');return u.origin+u.pathname+u.search;}catch{return String(raw||'').split('?')[0].slice(0,2000);}}
async function scmMobileNetStart(tabId){
 const tab=await chrome.tabs.get(tabId);if(!tab?.url||!/^https:\/\/(?:www\.)?simcompanies\.com\//i.test(tab.url))throw new Error('Open the Sim Companies game tab before starting mobile network capture.');
 const old=(await chrome.storage.local.get('scmNetworkCaptureV3Status')).scmNetworkCaptureV3Status||{};if(old.status==='recording')throw new Error('A network capture is already recording. Stop it before starting another.');
 const captureId=`mobile-net-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;await scmNetClearEvents(captureId);
 const status={captureId,mode:'mobile-page',status:'recording',tabId,startedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),events:0,requests:0,responses:0,bodies:0,errors:0,limitEvents:100000,coverage:'Game-page fetch/XHR instrumentation; same-origin HTTP requests only; bounded response previews; not browser-level traffic.'};
 await chrome.storage.local.set({scmNetworkCaptureV3Status:status});
 try{const ack=await chrome.tabs.sendMessage(tabId,{type:'SET_NETWORK_CAPTURE',enabled:true,captureId});if(!ack?.ok)throw new Error(ack?.error||'Game page did not acknowledge mobile capture.');}
 catch(error){await chrome.storage.local.set({scmNetworkCaptureV3Status:{...status,status:'failed',error:String(error?.message||error),stoppedAt:new Date().toISOString()}});throw new Error(`Could not start page-level capture. Reload the game tab with the extension enabled, then retry. ${error?.message||error}`);}
 return {ok:true,...status,note:'Mobile page capture records fetch/XHR activity while the game tab is alive. Keep the game tab open overnight; Android may suspend background tabs.'};
}
async function scmMobileNetStop(){
 const status=(await chrome.storage.local.get('scmNetworkCaptureV3Status')).scmNetworkCaptureV3Status||{};if(status.mode!=='mobile-page'||!status.captureId)return {ok:false,error:'No mobile page capture session exists.'};
 try{if(status.tabId!=null)await chrome.tabs.sendMessage(status.tabId,{type:'SET_NETWORK_CAPTURE',enabled:false,captureId:status.captureId});}catch{}
 await new Promise(r=>setTimeout(r,350));const latest=(await chrome.storage.local.get('scmNetworkCaptureV3Status')).scmNetworkCaptureV3Status||status;
 const stopped={...latest,status:'stopped',stoppedAt:new Date().toISOString(),updatedAt:new Date().toISOString()};await chrome.storage.local.set({scmNetworkCaptureV3Status:stopped});return {ok:true,...stopped};
}
function scmNetSafeHeaders(headers){const out={};for(const h of headers||[]){const name=String(h.name||'');if(/authorization|cookie|set-cookie|token|csrf|session/i.test(name))out[name]='[REDACTED]';else out[name]=String(h.value||'');}return out;}
async function scmNetDebuggerEvent(source,method,params){if(!scmNetCapture.active||source.tabId!==scmNetCapture.tabId)return;try{
 const id=params.requestId;
 if(method==='Network.requestWillBeSent'){const req=params.request||{};const row={requestId:id,url:req.url||'',method:req.method||'GET',headers:scmNetSafeHeaders(Object.entries(req.headers||{}).map(([name,value])=>({name,value:String(value)}))),postData:req.postData??null,resourceType:params.type||null,initiator:params.initiator||null,wallTime:params.wallTime||null,timestamp:params.timestamp||null,redirectResponse:params.redirectResponse?{status:params.redirectResponse.status,url:params.redirectResponse.url,headers:scmNetSafeHeaders(Object.entries(params.redirectResponse.headers||{}).map(([name,value])=>({name,value:String(value)})))}:null};scmNetCapture.requestMap.set(id,{request:row,response:null});await scmNetSave({kind:'request',...row});if(params.redirectResponse)await scmNetSave({kind:'redirect-response',requestId:id,url:params.redirectResponse.url,status:params.redirectResponse.status,headers:scmNetSafeHeaders(Object.entries(params.redirectResponse.headers||{}).map(([name,value])=>({name,value:String(value)})))});return;}
 if(method==='Network.responseReceived'){const resp=params.response||{};const entry=scmNetCapture.requestMap.get(id)||{request:{requestId:id,url:resp.url||'',method:'GET'},response:null};entry.response={url:resp.url||entry.request.url,status:resp.status,statusText:resp.statusText,mimeType:resp.mimeType,protocol:resp.protocol,fromDiskCache:resp.fromDiskCache,fromServiceWorker:resp.fromServiceWorker,headers:scmNetSafeHeaders(Object.entries(resp.headers||{}).map(([name,value])=>({name,value:String(value)}))),remoteIPAddress:resp.remoteIPAddress||null,encodedDataLength:resp.encodedDataLength??null,resourceType:params.type||null};scmNetCapture.requestMap.set(id,entry);await scmNetSave({kind:'response',requestId:id,...entry.response});return;}
 if(method==='Network.loadingFinished'){const entry=scmNetCapture.requestMap.get(id);await scmNetSave({kind:'loading-finished',requestId:id,encodedDataLength:params.encodedDataLength??null});if(entry){try{const result=await chrome.debugger.sendCommand(source,'Network.getResponseBody',{requestId:id});const body=result?.body;await scmNetSave({kind:'response-body',requestId:id,url:entry.response?.url||entry.request?.url||'',base64Encoded:Boolean(result?.base64Encoded),body:body??null,bodyLength:typeof body==='string'?body.length:0,bodyCaptureStatus:body==null?'empty':'captured'});}catch(err){await scmNetSave({kind:'body-unavailable',requestId:id,url:entry.response?.url||entry.request?.url||'',reason:String(err?.message||err).slice(0,500)});}}scmNetCapture.requestMap.delete(id);return;}
 if(method==='Network.loadingFailed'){await scmNetSave({kind:'loading-failed',requestId:id,url:scmNetCapture.requestMap.get(id)?.request?.url||'',errorText:params.errorText||'',canceled:Boolean(params.canceled),blockedReason:params.blockedReason||null});scmNetCapture.requestMap.delete(id);return;}
 if(method.startsWith('Network.webSocket')||method.startsWith('Network.eventSource')){const clean={...params};if(clean.request)clean.request={url:clean.request.url,method:clean.request.method,headers:scmNetSafeHeaders(Object.entries(clean.request.headers||{}).map(([name,value])=>({name,value:String(value)})))};await scmNetSave({kind:'protocol-event',protocolMethod:method,params:clean});return;}
 if(method==='Network.dataReceived'){await scmNetSave({kind:'data-received',requestId:id,dataLength:params.dataLength??null,encodedDataLength:params.encodedDataLength??null});return;}
 if(method==='Network.requestServedFromCache'){await scmNetSave({kind:'served-from-cache',requestId:id});return;}
 }catch(err){try{await scmNetSave({kind:'capture-error',protocolMethod:method,error:String(err?.message||err).slice(0,500)});}catch{}}
}
chrome.debugger.onEvent.addListener(scmNetDebuggerEvent);
chrome.debugger.onDetach.addListener((source,reason)=>{if(source.tabId===scmNetCapture.tabId){scmNetCapture.active=false;scmNetSave({kind:'capture-detached',reason:String(reason||'unknown')}).catch(()=>{});}});
async function scmNetStart(tabId){if(scmNetCapture.active)throw new Error('A network capture is already active. Stop it first.');const tab=await chrome.tabs.get(tabId);if(!tab?.url||!/^https?:/i.test(tab.url))throw new Error('Selected tab is not a normal HTTP/HTTPS page.');scmNetCapture.tabId=tabId;scmNetCapture.captureId=`net3-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;scmNetCapture.requestMap.clear();scmNetCapture.counters={events:0,requests:0,responses:0,bodies:0,errors:0};scmNetCapture.startedAt=new Date().toISOString();await scmNetClearEvents(scmNetCapture.captureId);await chrome.debugger.attach({tabId},'1.3');try{await chrome.debugger.sendCommand({tabId},'Network.enable',{maxTotalBufferSize:100000000,maxResourceBufferSize:50000000,maxPostDataSize:10000000});scmNetCapture.active=true;await scmNetSave({kind:'capture-start',tabId,pageUrl:tab.url,coverage:'Chrome DevTools Protocol Network domain; browser-observed requests for this tab'});return {ok:true,captureId:scmNetCapture.captureId,tabId,status:'recording',note:'Chrome may display a debugging notification while capture is active.'};}catch(err){try{await chrome.debugger.detach({tabId});}catch{}scmNetCapture.active=false;throw err;}}
async function scmNetStop(){if(!scmNetCapture.captureId)return {ok:false,error:'No capture session exists.'};const tabId=scmNetCapture.tabId;scmNetCapture.active=false;await scmNetSave({kind:'capture-stop',tabId,stopReason:'user-request'}).catch(()=>{});try{if(tabId!=null)await chrome.debugger.detach({tabId});}catch(err){await scmNetSave({kind:'capture-detach-error',error:String(err?.message||err)}).catch(()=>{});}const status={ok:true,captureId:scmNetCapture.captureId,tabId,status:'stopped',...scmNetCapture.counters};await chrome.storage.local.set({scmNetworkCaptureV3Status:{...status,startedAt:scmNetCapture.startedAt,stoppedAt:new Date().toISOString()}});return status;}

const BUILD_VERSION=chrome.runtime.getManifest().version;
const enqueueNetworkCaptureWrite=SCM_DIAGNOSTIC_CORE.createSerialQueue();
const REALM_ISOLATION_SCHEMA=13;

// Session replay / forensic journal. This is deliberately separate from the
// realm stores so the journal can describe cross-realm events without becoming
// another realm writer. It contains metadata and hashes/counts only; payloads
// remain in the existing realm endpoint/game-store captures.
const REPLAY_META_KEY='scmReplayMeta';
const REPLAY_SCHEMA_VERSION=1;
const REPLAY_MAX_EVENTS=4000;
const REPLAY_CHUNK_SIZE=50;
const REPLAY_CHUNK_PREFIX='scmReplayChunk:';
let replaySessionId=null;
let replayBuffer=[];
let replayFlushScheduled=false;
let replayFlushInFlight=false;
function replayId(){try{return crypto.randomUUID();}catch{return `scm-${Date.now()}-${Math.random().toString(36).slice(2)}`;}}
replaySessionId=replayId();
function replayHash(value){
  const text=typeof value==='string'?value:JSON.stringify(value); let h=2166136261;
  for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}
  return (h>>>0).toString(16).padStart(8,'0');
}
function replayChunkKey(index){return `${REPLAY_CHUNK_PREFIX}${String(index).padStart(6,'0')}`;}
function scheduleReplayFlush(){
  if(replayFlushScheduled||replayFlushInFlight)return;
  if(replayBuffer.length<REPLAY_CHUNK_SIZE)return;
  replayFlushScheduled=true;
  Promise.resolve().then(async()=>{
    replayFlushScheduled=false;
    replayFlushInFlight=true;
    try{await flushReplayJournal();}finally{
      replayFlushInFlight=false;
      if(replayBuffer.length>=REPLAY_CHUNK_SIZE)scheduleReplayFlush();
    }
  }).catch(()=>{replayFlushInFlight=false;});
}
function replayQueueEvent(event){
  replayBuffer.push({id:replayId(),sessionId:replaySessionId,at:new Date().toISOString(),...event});
  if(replayBuffer.length>REPLAY_MAX_EVENTS)replayBuffer=replayBuffer.slice(-REPLAY_MAX_EVENTS);
  scheduleReplayFlush();
}
async function flushReplayJournal(force=false){
  if(!replayBuffer.length)return {ok:true,empty:true};
  if(!force&&replayBuffer.length<REPLAY_CHUNK_SIZE)return {ok:true,buffered:true,count:replayBuffer.length};
  const batch=replayBuffer.splice(0,Math.min(REPLAY_CHUNK_SIZE,replayBuffer.length));
  try{
    const existing=await chrome.storage.local.get({[REPLAY_META_KEY]:null});
    const oldMeta=existing?.[REPLAY_META_KEY]&&typeof existing[REPLAY_META_KEY]==='object'?existing[REPLAY_META_KEY]:{};
    const nextIndex=Number.isFinite(Number(oldMeta.nextChunkIndex))?Number(oldMeta.nextChunkIndex):0;
    const key=replayChunkKey(nextIndex);
    const eventCount=Number(oldMeta.eventCount)||0;
    const meta={schemaVersion:REPLAY_SCHEMA_VERSION,sessionId:replaySessionId,buildVersion:BUILD_VERSION,updatedAt:new Date().toISOString(),eventCount:eventCount+batch.length,retainedEvents:REPLAY_MAX_EVENTS,chunkSize:REPLAY_CHUNK_SIZE,nextChunkIndex:nextIndex+1};
    await rawStorageSet({[key]:batch,[REPLAY_META_KEY]:meta});
    const staleIndex=nextIndex-Math.ceil(REPLAY_MAX_EVENTS/REPLAY_CHUNK_SIZE);
    if(staleIndex>=0&&chrome.storage.local.remove)await chrome.storage.local.remove([replayChunkKey(staleIndex)]);
    return {ok:true,count:batch.length,chunk:key};
  }catch(e){
    replayBuffer=batch.concat(replayBuffer).slice(-500);
    return {ok:false,error:e?.message||String(e)};
  }
}
function replayEvent(type,payload={}){
  replayQueueEvent({type,...payload});
}



const SIMCOTOOLS_TIMEOUT_MS=30000;
// Retry only transient non-rate-limit failures. A 429 activates a shared cooldown.
const SIMCOTOOLS_RETRY_DELAYS_MS=[0,2500,8000];
const SIMCOTOOLS_DEFAULT_RATE_LIMIT_COOLDOWN_MS=5*60*1000;
const SIMCOTOOLS_MAX_RATE_LIMIT_COOLDOWN_MS=30*60*1000;
const SIMCOTOOLS_MAX_CONCURRENT_REQUESTS=1;
const SIMCOTOOLS_PAIR_RATE_LIMIT_COOLDOWN_MS=5*60*1000;
const SIMCOTOOLS_MIN_REQUEST_SPACING_MS=1200;
let simcoLastRequestAt=0;
let simcoRateLimitUntil=0;
let simcoActiveRequests=0;
const simcoRequestWaiters=[];
const simcoRefreshRuns=new Map();
const simcoRateLimitUntilByUrl=new Map();
function simcoRetryAfterMs(response){
  const raw=response?.headers?.get?.('Retry-After');
  if(!raw)return null;
  const seconds=Number(raw);
  let ms=Number.isFinite(seconds)&&seconds>=0?seconds*1000:Date.parse(raw)-Date.now();
  if(!Number.isFinite(ms)||ms<0)return null;
  return Math.min(ms,SIMCOTOOLS_MAX_RATE_LIMIT_COOLDOWN_MS);
}
function simcoActivateRateLimitCooldown(response){
  const retryAfter=simcoRetryAfterMs(response);
  const cooldown=Math.max(SIMCOTOOLS_DEFAULT_RATE_LIMIT_COOLDOWN_MS,retryAfter??SIMCOTOOLS_DEFAULT_RATE_LIMIT_COOLDOWN_MS);
  simcoRateLimitUntil=Math.max(simcoRateLimitUntil,Date.now()+cooldown);
  return simcoRateLimitUntil;
}
async function simcoWaitForRateLimitCooldown(){
  while(Date.now()<simcoRateLimitUntil){
    await new Promise(resolve=>setTimeout(resolve,Math.min(simcoRateLimitUntil-Date.now(),1000)));
  }
}
async function simcoAcquireRequestSlot(){
  await simcoWaitForRateLimitCooldown();
  if(simcoActiveRequests<SIMCOTOOLS_MAX_CONCURRENT_REQUESTS){simcoActiveRequests++;return;}
  await new Promise(resolve=>simcoRequestWaiters.push(resolve));
  simcoActiveRequests++;
  await simcoWaitForRateLimitCooldown();
}
function simcoReleaseRequestSlot(){
  simcoActiveRequests=Math.max(0,simcoActiveRequests-1);
  const next=simcoRequestWaiters.shift();
  if(next)next();
}
// v2.5.345 the phone's game API answers took 14–70 s; 8 s × 2 made every Sync fail on that link. One attempt,
// up to 45 s (the page hook aborts at the same limit, max 60 s); retrying a slow request only doubles the load.
const SYNC_PAGE_API_TIMEOUT_MS=45000;
const SYNC_PAGE_API_ATTEMPTS=1;
const SYNC_CLICK_TIMEOUT_MS=2000;
const SYNC_CAPTURE_FALLBACK_MS=8000;
const VWAP_FALLBACK_FILE='vwap-fallback.json';
let vwapFallbackPromise=null;

// Every field in a physical realm store belongs to exactly one realm.
// Global preferences/runtime controls intentionally stay outside this list.
const REALM_SCOPED_KEYS = Object.freeze([
  'authData','companyData','buildings','warehouseResources','gameState',
  'endpointData','apiEndpoints','history','contracts','savedContracts','contractEvents',
  'marketCache','marketDebug','marketTicker','marketQueue','marketQueueCursor','marketQueueStatus','liveMarketData','liveMarketProduct','liveMarketProductCache','liveMarketPriceData',
  'resourceImageData','resourceImageCache','resourceImageMeta','resourceImageCacheStatus','backgroundJobHistory',
  'resourceCatalog','warehouseCapture','lastSync','syncStatus','syncError','fullSyncDiagnostics','fullSyncJob','warehouseCostDetails','accountingLastComputed',
  'accountingLastComputedIncome','accountingCapture','accountingSnapshots','tickerSnapshots','sellingHistory',
  'accountingWeekSales','accountingWeekSalesSummary','accountingWeekRevision','vwapData','vwapWatch','vwapStatus',
  'realmQuarantine','productionEvents','productionRateSnapshots','productionPlans','frozenNetworkPlan',
  'productionRunHours','gameOverlaySnapshot','javascriptDiagnostic','javascriptDiagnosticHistory',
  'buildingAlarms','productionEventMonitor','accountingWeekLedgerStatus','accountingDayWalkStatus','accountingDailySeries','activeRealmIdentity','realmIsolationNote','vwapLegacyDiscarded',
  'gameLocalStorageSnapshot','criticalDataBaseline'
]);

const DEFAULTS = {
  apiBase: 'https://www.simcompanies.com', syncMinutes: 5, lastSync: null,
  syncStatus: 'Never synced', syncError: null, authData: null, companyData: null,
  warehouseResources: [], gameState: null, resourceCatalog: null, endpointData: {}, apiEndpoints: [],
  history: {}, contracts: [], contractEvents: [], marketCache: {}, marketDebug: {}, marketTicker: null, vwapData: null, liveMarketData: null, liveMarketProduct: null, liveMarketProductCache: {}, liveMarketPriceData: null, marketQueue: [], marketQueueCursor: 0, marketLastRequestAt: null,
  apiLastRequestAt: null,
  marketQueueStatus: {message:'Waiting for the logged-in Sim Companies tab.'}, resourceImageData: {}, resourceImageCache: {}, resourceImageMeta: {}, backgroundJobHistory: [],
  selectedRealm: null,
  realmIsolationSchemaVersion: REALM_ISOLATION_SCHEMA,
  realmSwitchHint: null,
  vwapStatus: {message:'Waiting for VWAP sync.'},
  accountingWeekLedgerStatus: null,
  accountingWeekRevision: 0,
  vwapWatch: {lastCheckedAt:null,lastChangedAt:null,initializedAt:null,changeCount:0,checkCount:0,status:'waiting',currentSignature:null,previousSignature:null,lastRowCount:0,lastSourceRealm:null,lastError:null},
  gameLocalStorageSnapshot: null,
  criticalDataBaseline: {version:1,realm:null,capturedAt:null,contracts:0,vwap:0},
  fullSyncDiagnostics: null,
  fullSyncJob: null,
  warehouseCostDetails: {},
  accountingLastComputed: null,
  accountingCapture: {},
  sellingHistory: {},
  productionEvents: [],
  productionRateSnapshots: {},
  productionPlans: {},
  frozenNetworkPlan: null,
  gameOverlaySnapshot: null,
  productionPlannerState: null,
  productionRunHours: 24,
  liveBridge: { enabled:false, url:'', token:'', pushOnSync:false, lastPushAt:null, lastPushStatus:null },
};

// State reads intentionally request only global metadata from the root storage
// area. Realm-owned data is loaded from one physical realm key below. This is
// critical for performance because the old root mirror can contain megabytes
// of endpoint/image cache data.
const GLOBAL_DEFAULTS = Object.freeze({
  apiBase: DEFAULTS.apiBase,
  syncMinutes: DEFAULTS.syncMinutes,
  apiLastRequestAt: DEFAULTS.apiLastRequestAt,
  selectedRealm: DEFAULTS.selectedRealm,
  realmIsolationSchemaVersion: DEFAULTS.realmIsolationSchemaVersion,
  realmSwitchHint: DEFAULTS.realmSwitchHint,
  liveBridge: DEFAULTS.liveBridge,
  activeRealmKey: null,
  scmRealmStoreSchema: 0
});

const USEFUL_PATTERNS = [
  /\/api\/v3\/companies\/auth-data\//,
  /\/api\/v3\/resources\/\d+\//, /\/api\/v3\/market(?:\/all)?\/\d+\/\d+\//,
  /\/api\/v4\/\d+\/resources-retail-info\//, /\/api\/v2\/companies\/me\/(?:balance-sheet|cashflow|cashflow\/recent|cashflow-statement|income-statement|past-finances-overview|administration-overhead)\//,
  /\/api\/v3\/companies\/me\/past-finances\//, /\/api\/v3\/contracts-(?:incoming|outgoing)/,
  /\/api\/v2\/companies\/me\/buildings\/?$/, /\/api\/v2\/companies\/buildings\/\d+\/history\/?$/
];

const rawStorageSet=chrome.storage.local.set.bind(chrome.storage.local);
// v2.5.342 the game's public constants (/api/v2/constants/core|buildings|resources/) → scmGameConstants, refreshed
// every 6 h; and your own exchange listings (/api/v2/companies/<id>/market-orders/, public) → scmMarketOrders:<realm>.
// Plain fetches, no storage lock held while fetching.
const GAME_CONSTANTS_ALARM='scm-game-constants';
async function refreshGameConstants(force=false){
  try{
    const cur=(await chrome.storage.local.get({scmGameConstants:null})).scmGameConstants;
    if(!force&&cur&&Date.now()-Date.parse(cur.at||0)<6*3600000)return {ok:true,cached:true};
    const get=async p=>{const r=await fetch(`https://www.simcompanies.com${p}`,{credentials:'omit'});if(!r.ok)throw new Error(`${p} HTTP ${r.status}`);return r.json();};
    const [core,buildings,resources]=await Promise.all([get('/api/v2/constants/core/'),get('/api/v2/constants/buildings/'),get('/api/v2/constants/resources/')]);
    const next={core,buildings,resources,at:new Date().toISOString()};
    if(!globalThis.SCM_TOOLS_CORE.gameConstantsOk(next))throw new Error('constants missing fields');
    await rawStorageSet({scmGameConstants:next});
    logActivity(await activeRealmNumber(),'game-constants','success',{});
    return {ok:true};
  }catch(e){logActivity(await activeRealmNumber(),'game-constants','failure',{},String(e?.message||e));return {ok:false,error:String(e?.message||e)};}
}
async function refreshMarketOrders(realm,maxAgeMs=5*60000){
  try{
    const r=validRealmNumber(realm);if(r==null)return {ok:false};
    const k=`scmMarketOrders:${r}`;const cur=(await chrome.storage.local.get({[k]:null}))[k];
    if(cur&&Date.now()-Date.parse(cur.at||0)<maxAgeMs)return {ok:true,cached:true};
    const st=await notifyRealmStore(r);const cid=Number(st?.authData?.authCompany?.companyId??st?.authData?.authCompany?.id);
    if(!(cid>0))return {ok:false,error:'company id not captured'};
    const res=await fetch(`https://www.simcompanies.com/api/v2/companies/${cid}/market-orders/`,{credentials:'omit'});
    if(!res.ok)return {ok:false,error:`HTTP ${res.status}`};
    const orders=await res.json();if(!Array.isArray(orders))return {ok:false,error:'not a list'};
    await rawStorageSet({[k]:{companyId:cid,orders,at:new Date().toISOString()}});
    logActivity(r,'market-orders','success',{rows:orders.length});
    return {ok:true};
  }catch(e){logActivity(validRealmNumber(realm),'market-orders','failure',{},String(e?.message||e));return {ok:false,error:String(e?.message||e)};}
}
// v2.5.343 logged-in extras through the game tab after Sync: research, government orders + your tier, and the
// abundance of every building whose abundance the game has shown (mines etc.). Each pageGet runs without a lock;
// saveData takes its own lock per response.
// Buildings that make an abundance resource. v2.5.352: the game constants (scmGameConstants, downloaded in the
// background) are one source; if they are missing on the phone, the bundled buildings.json/recipes.json (same game
// data: Mine, Oil Rig, Quarry) are used, plus any building producing an abundance resource now or of a kind whose
// abundance was captured before. Returns {ids, sources}.
let bundledAbundanceKindsMemo=null;
async function bundledAbundanceKinds(){
  if(bundledAbundanceKindsMemo)return bundledAbundanceKindsMemo;
  try{const T=globalThis.SCM_TOOLS_CORE;const [b,r]=await Promise.all(['buildings.json','recipes.json'].map(async f=>(await fetch(chrome.runtime.getURL(f))).json()));
    const byName=new Map((Array.isArray(r)?r:Object.values(r||{})).map(x=>[String(x?.name||'').toLowerCase(),Number(x?.id)]));
    bundledAbundanceKindsMemo=new Set((Array.isArray(b)?b:[]).filter(x=>(x?.produces||[]).some(n=>T?.isAbundanceResource?.(byName.get(String(n).toLowerCase())))).map(x=>String(x.id)));}
  catch{bundledAbundanceKindsMemo=new Set();}
  return bundledAbundanceKindsMemo;
}
async function abundanceBuildingInfo(st){
  const T=globalThis.SCM_TOOLS_CORE,list=Array.isArray(st?.buildings)?st.buildings:[],ids=new Set(),sources=[];
  try{const gc=(await chrome.storage.local.get({scmGameConstants:null})).scmGameConstants;
    const k=new Set(Object.entries(gc?.resources||{}).filter(([id])=>T?.isAbundanceResource?.(id)).map(([,x])=>String(x?.producedAt)));
    sources.push(k.size?'game constants':'game constants missing');for(const b of list)if(k.has(String(b?.kind)))ids.add(String(b.id));}catch{sources.push('game constants unreadable');}
  const bk=await bundledAbundanceKinds();for(const b of list)if(bk.has(String(b?.kind)))ids.add(String(b.id));
  const ep=st?.endpointData||{},capturedKinds=new Set(list.filter(b=>ep[`/api/v2/companies/buildings/${b?.id}/abundance/`]).map(b=>String(b?.kind)));
  for(const b of list)if(T?.isAbundanceResource?.(b?.busy?.resource?.kind)||capturedKinds.has(String(b?.kind)))ids.add(String(b.id));
  return {ids:[...ids],sources,buildings:list.length};
}
async function abundanceBuildingIds(st){return (await abundanceBuildingInfo(st)).ids;}
// v2.5.352 one line in the Background updates monitor for work the Manager does (job history scmBackgroundJobs:<n>).
function logActivity(realm,job,outcome,details={},error=null,startedMs=Date.now(),trigger='manager'){
  const n=validRealmNumber(realm);if(n==null)return Promise.resolve();
  return recordBackgroundJobEvent(n,{job,trigger,outcome,startedAt:new Date(startedMs).toISOString(),finishedAt:new Date().toISOString(),durationMs:Date.now()-startedMs,details,error}).catch(()=>{});
}
async function activeRealmNumber(){try{const r=await chrome.storage.local.get({activeRealmKey:null});return validRealmNumber(realmNumberFromKey(r.activeRealmKey));}catch{return null;}}
// v2.5.352 "Game data saved" lines in the monitor: one per kind of data, at most once a minute each.
const GAME_CAPTURE_FAMILIES=[[/\/companies\/me\/buildings\/?$/,'Buildings'],[/\/resources\/\d+\/?$/,'Warehouse'],[/\/contracts-(?:incoming|outgoing)/,'Contracts'],[/\/abundance\/?$/,'Abundance'],[/\/cashflow\/recent/,'Cash flow (sales)'],[/\/market\/\d+\/\d+\/?$/,'Exchange order book'],[/\/buildings\/\d+\/history/,'Building history'],[/\/government-orders/,'Government orders'],[/\/(?:balance-sheet|income-statement|cashflow-statement|past-finances)/,'Accounting'],[/\/executives\/?$/,'Executives']];
const gameCaptureLogAt=new Map();
function logGameCapture(realm,url){
  const path=String(url||'').split('?')[0];const f=GAME_CAPTURE_FAMILIES.find(([rx])=>rx.test(path));if(!f)return;
  const k=`${realm}|${f[1]}`;if(Date.now()-(gameCaptureLogAt.get(k)||0)<60000)return;gameCaptureLogAt.set(k,Date.now());
  logActivity(realm,'game-data-saved','success',{what:f[1]},null,Date.now(),'game');
}
// v2.5.351 abundance without a Sync or opening the mine: whenever the game's buildings list is captured, fetch
// /abundance/ through the game tab for each mine/oil rig/quarry whose capture is missing or older than 1 h.
// One run per realm at a time, at most every 5 min; skipped during a Sync (Sync fetches them itself afterwards).
// No storage lock is held while fetching (pageGet, then saveData per building).
const ABUNDANCE_AUTO_MAX_AGE_MS=60*60*1000,ABUNDANCE_AUTO_MIN_GAP_MS=5*60*1000;
const abundanceAutoState=new Map();
function staleAbundanceIds(ids,endpointData,now=Date.now(),maxAgeMs=ABUNDANCE_AUTO_MAX_AGE_MS){
  return ids.filter(id=>{const e=endpointData?.[`/api/v2/companies/buildings/${id}/abundance/`];const t=Date.parse(String(e?.receivedAt||''));return !e?.data?.abundance||!Number.isFinite(t)||now-t>maxAgeMs;});
}
async function refreshAbundanceIfStale(realm,trigger='game-buildings'){
  const r=validRealmNumber(realm);if(r==null)return {ok:false};
  const cur=abundanceAutoState.get(r)||{};if(cur.running||Date.now()-(cur.at||0)<ABUNDANCE_AUTO_MIN_GAP_MS)return {ok:true,skipped:true};
  if(currentCaptureSyncSession())return {ok:true,skipped:'sync'};
  abundanceAutoState.set(r,{running:true,at:Date.now()});
  const saved=[],errors=[],t0=Date.now();
  try{
    const st=await notifyRealmStore(r);const info=await abundanceBuildingInfo(st);
    const ids=staleAbundanceIds(info.ids,st?.endpointData||{});
    if(!info.ids.length){logActivity(r,'abundance-refresh','skipped',{buildings:info.buildings,sources:info.sources.join(', ')},'No mine, oil rig or quarry found in your buildings',t0,trigger);return {ok:true,saved,wanted:0};}
    if(!ids.length){logActivity(r,'abundance-refresh','skipped',{mines:info.ids.length},'all fresh (under 1 h)',t0,trigger);return {ok:true,saved,wanted:0};}
    for(const id of ids){const p=`/api/v2/companies/buildings/${id}/abundance/`;try{const x=await pageGet(p,r);if(x?.ok){await saveData(p,x.data,x.status,'GET',r);saved.push(id);}else errors.push(`#${id}: ${x?.error||'HTTP '+(x?.status||0)}`);}catch(e){errors.push(`#${id}: ${e?.message||e}`);}}
    logActivity(r,'abundance-refresh',saved.length===ids.length?'success':saved.length?'partial':'failure',{rows:saved.length,wanted:ids.length,sources:info.sources.join(', ')},errors.join(' · ')||null,t0,trigger);
    return {ok:true,saved,wanted:ids.length};
  }finally{abundanceAutoState.set(r,{running:false,at:Date.now()});}
}
async function refreshExtraGameData(realm){
  const r=validRealmNumber(realm);if(r==null)return {ok:false};
  const st=await notifyRealmStore(r);const ep=st?.endpointData||{};
  const ab=new Set(Object.keys(ep).map(k=>(k.match(/^\/api\/v2\/companies\/buildings\/(\d+)\/abundance\/$/)||[])[1]).filter(Boolean));
  const kinds=new Set((Array.isArray(st?.buildings)?st.buildings:[]).filter(b=>ab.has(String(b?.id))).map(b=>String(b?.kind)));
  for(const b of (Array.isArray(st?.buildings)?st.buildings:[]))if(kinds.has(String(b?.kind)))ab.add(String(b.id));
  // v2.5.349 also every building that makes an abundance resource (mines, oil rigs, quarries: constants producedAt),
  // even when its abundance was never captured or the record was lost.
  for(const id of await abundanceBuildingIds(st))ab.add(id);
  const paths=['/api/v3/players/research/',`/api/v3/government-orders/${r}/`,'/api/v3/government-orders/tier/',...[...ab].map(id=>`/api/v2/companies/buildings/${id}/abundance/`)];
  const out=[],errs=[],t0=Date.now();
  for(const p of paths){try{const x=await pageGet(p,r);if(x?.ok){await saveData(p,x.data,x.status,'GET',r);out.push(p);}else errs.push(`${p.replace('/api/','')}: ${x?.error||'HTTP '+(x?.status||0)}`);}catch(e){errs.push(`${p.replace('/api/','')}: ${e?.message||e}`);}}
  const abN=paths.filter(p=>/abundance/.test(p)).length,abOk=out.filter(p=>/abundance/.test(p)).length;
  logActivity(r,'extra-game-data',errs.length?(out.length?'partial':'failure'):'success',{rows:out.length,wanted:paths.length,abundance:`${abOk}/${abN}`},errs.slice(0,4).join(' · ')||null,t0,'after-sync');
  return {ok:true,saved:out};
}
chrome.alarms.onAlarm.addListener(a=>{if(a?.name===GAME_CONSTANTS_ALARM)refreshGameConstants().catch(()=>{});});
async function ensureGameConstantsAlarm(){try{await chrome.alarms.create(GAME_CONSTANTS_ALARM,{delayInMinutes:1,periodInMinutes:360});}catch{}refreshGameConstants().catch(()=>{});}
ensureGameConstantsAlarm();
// v2.5.338 economy phase log per realm (scmEconomyStateLog:<realm>) from auth-data temporals.economyState.
// Seeds from the previously stored auth-data so the phase before a change is kept. Storage only, no network.
let economyLogChain=Promise.resolve();
function recordEconomyState(realm,prevEntry,data){
  const r=validRealmNumber(realm);const st=Number(data?.temporals?.economyState);
  if(r==null||!Number.isFinite(st))return Promise.resolve();
  const now=new Date().toISOString();
  economyLogChain=economyLogChain.then(async()=>{
    const k=`scmEconomyStateLog:${r}`;const C=globalThis.SCM_TOOLS_CORE;
    let log=(await chrome.storage.local.get({[k]:[]}))[k];
    const prevSt=Number(prevEntry?.data?.temporals?.economyState);
    if((!Array.isArray(log)||!log.length)&&Number.isFinite(prevSt)&&prevEntry?.receivedAt)log=C.economyLogAppend([],prevSt,prevEntry.receivedAt);
    const last=Array.isArray(log)&&log.length?log[log.length-1]:null;
    const next=C.economyLogAppend(log,st,now);
    await rawStorageSet({[k]:next});
    // v2.5.359 phase changed since the last observation → notification (setting "economyChange").
    if(last&&Number.isFinite(Number(last.s))&&Number(last.s)!==st&&next.length&&Number(next[next.length-1].s)===st){
      try{const cfg=await notifySettings();if(cfg.economyChange){const gc=(await chrome.storage.local.get({scmGameConstants:null})).scmGameConstants;const store=await notifyRealmStore(r);const msg=globalThis.SCM_NOTIFY_CORE.economyChanged({from:Number(last.s),to:st,realm:r,constants:gc,buildings:store?.buildings});await scmNotify(`economy-${r}-${Date.now()}`,msg.title,msg.message);}}catch(e){console.debug('economy notification failed',e);}
    }
  }).catch(()=>{});
  return economyLogChain;
}
// v2.5.327 mobile: resource images (base64 data URLs, ~2.3 MB) used to live inside the realm store, so
// every state() read and every realm write serialized them. They now live in their own key and are
// only read by the code that draws images. Any realm write that still carries image fields is routed
// here and merged (image writes are additive), so legacy callers keep working unchanged.
const RESOURCE_IMAGES_KEY='scmResourceImages';
const RESOURCE_IMAGE_FIELDS=['resourceImageCache','resourceImageData','resourceImageMeta'];
let resourceImagesMemo=null;
async function resourceImagesStore(){
  if(resourceImagesMemo)return resourceImagesMemo;
  const raw=(await chrome.storage.local.get({[RESOURCE_IMAGES_KEY]:null}))[RESOURCE_IMAGES_KEY];
  resourceImagesMemo={cache:{...(raw?.cache||{})},meta:{...(raw?.meta||{})}};
  return resourceImagesMemo;
}
globalThis.__scmOwnWriteHooks?.push(items=>{if(Object.prototype.hasOwnProperty.call(items,RESOURCE_IMAGES_KEY)){const v=items[RESOURCE_IMAGES_KEY];resourceImagesMemo=v&&typeof v==='object'?{cache:{...(v.cache||{})},meta:{...(v.meta||{})}}:null;}});
async function routeResourceImagesOut(out){
  if(!out||typeof out!=='object')return out;
  let cache=null,meta=null;
  const take=(f,v)=>{if(!v||typeof v!=='object')return;if(f==='resourceImageMeta')meta={...(meta||{}),...v};else cache={...(cache||{}),...v};};
  for(const k of Object.keys(out)){
    if(!/^scmRealmStore:\d+$/.test(k))continue;
    const v=out[k];if(!v||typeof v!=='object')continue;
    if(!RESOURCE_IMAGE_FIELDS.some(f=>Object.prototype.hasOwnProperty.call(v,f)))continue;
    const clean={...v};for(const f of RESOURCE_IMAGE_FIELDS){take(f,clean[f]);delete clean[f];}out[k]=clean;
  }
  for(const f of RESOURCE_IMAGE_FIELDS){if(Object.prototype.hasOwnProperty.call(out,f)){take(f,out[f]);delete out[f];}}
  const hasCache=cache&&Object.keys(cache).length,hasMeta=meta&&Object.keys(meta).length;
  if(!hasCache&&!hasMeta)return out;
  const cur=await resourceImagesStore();
  const changed=(hasCache&&Object.entries(cache).some(([k,v])=>cur.cache[k]!==v))||(hasMeta&&Object.entries(meta).some(([k,v])=>JSON.stringify(cur.meta[k])!==JSON.stringify(v)));
  if(!changed)return out;
  const next={cache:{...cur.cache,...(cache||{})},meta:{...cur.meta,...(meta||{})},updatedAt:new Date().toISOString()};
  out[RESOURCE_IMAGES_KEY]=next;resourceImagesMemo={cache:next.cache,meta:next.meta};
  return out;
}
async function moveResourceImagesOutOfRealmStores(){
  return withRealmStorageCommit(async()=>{
    const keys=[realmStorageKey(0),realmStorageKey(1)].filter(Boolean);
    const raw=await chrome.storage.local.get(Object.fromEntries(keys.map(k=>[k,null])));
    const out={};
    for(const k of keys){const v=raw[k];if(v&&typeof v==='object'&&RESOURCE_IMAGE_FIELDS.some(f=>Object.prototype.hasOwnProperty.call(v,f)))out[k]=v;}
    if(!Object.keys(out).length)return {moved:false};
    await rawStorageSet(await routeResourceImagesOut(out));
    return {moved:true,stores:Object.keys(out)};
  });
}
const PHYSICAL_REALM_FORBIDDEN_KEYS=new Set([
  'realmStores','activeRealmKey','selectedRealm','apiBase','apiLastRequestAt',
  'liveBridge','realmIsolationSchemaVersion','realmSwitchHint','scmRealmStoreSchema','fullSyncDiagnostics','productionPlannerState','gameOverlaySnapshot'
]);
function realmDiagnosticStorageKey(realm){const n=validRealmNumber(realm);return n==null?null:`scmRealmDiagnostic:${n}`;}
function gameOverlaySnapshotStorageKey(realm){const n=validRealmNumber(realm);return n==null?null:`scmGameOverlaySnapshot:${n}`;}
function productionPlannerStateStorageKey(realm){const n=validRealmNumber(realm);return n==null?null:`scmProductionPlannerState:${n}`;}
function sanitizeProductionPlannerState(value,realm){
  const n=validRealmNumber(realm);if(n==null||!value||typeof value!=='object')return null;
  const planningLevels={};for(const [k,v] of Object.entries(value.planningLevels&&typeof value.planningLevels==='object'?value.planningLevels:{})){const id=String(k).trim(),level=Math.min(20,Math.max(1,Number(v)||1));if(/^\d+$/.test(id))planningLevels[id]=level;}
  const productOverrides={};for(const [k,v] of Object.entries(value.productOverrides&&typeof value.productOverrides==='object'?value.productOverrides:{})){const id=String(k).trim(),product=String(v||'').trim();if(/^\d+$/.test(id)&&product)productOverrides[id]=product;}
  const qualityByBuilding={};for(const [k,v] of Object.entries(value.qualityByBuilding&&typeof value.qualityByBuilding==='object'?value.qualityByBuilding:{})){const id=String(k).trim(),q=Math.max(0,Number(v)||0);if(/^\d+$/.test(id))qualityByBuilding[id]=q;}
  const planModes={};for(const [k,v] of Object.entries(value.planModes&&typeof value.planModes==='object'?value.planModes:{})){const id=String(k).trim(),mode=String(v||'').trim();if(/^\d+$/.test(id)&&mode)planModes[id]=mode;}
  const kindOverrides={};for(const [k,v] of Object.entries(value.kindOverrides&&typeof value.kindOverrides==='object'?value.kindOverrides:{})){const id=String(k).trim(),kind=String(v||'').trim();if(/^\d+$/.test(id)&&/^[0-9A-Za-z]{1,3}$/.test(kind))kindOverrides[id]=kind;}
  const selected=value.selectedBuildingId!=null?String(value.selectedBuildingId).trim():'';
  const runHours=Math.min(48,Math.max(1,Number(value.runHours)||24));
  const discount=Math.min(10,Math.max(0,Number(value.discount)||0));
  return {version:1,realm:n,selectedBuildingId:/^\d+$/.test(selected)?selected:null,planningLevels,productOverrides,qualityByBuilding,runHours,discount,planModes,kindOverrides,updatedAt:String(value.updatedAt||new Date().toISOString())};
}
function sanitizePhysicalRealmPayload(value,realm){
  const clean=sanitizeRealmStore(value&&typeof value==='object'?value:{},realm);
  if(!clean||typeof clean!=='object')return {};
  for(const key of PHYSICAL_REALM_FORBIDDEN_KEYS) delete clean[key];
  return clean;
}
let realmStorageCommitTail=Promise.resolve();
function withRealmStorageCommit(task){
  const run=realmStorageCommitTail.catch(()=>{}).then(task);
  realmStorageCommitTail=run.catch(()=>{});
  return run;
}
function storageSet(patch={}){
  return withRealmStorageCommit(()=>storageSetUnlocked(patch));
}
async function storageSetRealmPatch(realm, patch={}, onTiming=null){
  const n=validRealmNumber(realm);
  if(n==null) throw new Error('Realm-scoped write requires an explicit realm.');
  if(!patch || typeof patch!=='object') throw new TypeError('Realm-scoped patch must be an object.');
  const queuedAt=Date.now();
  return withRealmStorageCommit(async()=>{
    const laneWaitMs=Date.now()-queuedAt;
    const commitStartedAt=Date.now();
    let stateReadMs=0,physicalWriteMs=0;
    try{
      const stateReadStartedAt=Date.now();
      const current=await state(n);
      stateReadMs=Date.now()-stateReadStartedAt;
      const key=`realm:${n}`;
      const next={...current,...patch};
      const physicalWriteStartedAt=Date.now();
      const result=await storageSetUnlocked({realmStores:{[key]:next}});
      physicalWriteMs=Date.now()-physicalWriteStartedAt;
      try{onTiming?.({realmCommitQueueWaitMs:laneWaitMs,realmStateReadMs:stateReadMs,physicalWriteMs,realmCommitDurationMs:Date.now()-commitStartedAt});}catch{}
      return result;
    }catch(error){
      try{onTiming?.({realmCommitQueueWaitMs:laneWaitMs,realmStateReadMs:stateReadMs,physicalWriteMs,realmCommitDurationMs:Date.now()-commitStartedAt,realmCommitError:error?.message||String(error)});}catch{}
      throw error;
    }
  });
}
// Commit a realm-local patch against the latest physical stores, not a snapshot
// captured before an asynchronous fetch. This prevents a slow VWAP job from
// restoring stale endpointData or market fields over newer writes.
async function commitLatestRealmPatch(realm, realmPatch={}, mirrorKeys=[]){
  const n=validRealmNumber(realm);
  if(n==null) throw new Error('Latest realm patch requires an explicit realm.');
  if(!realmPatch || typeof realmPatch!=='object') throw new TypeError('Realm patch must be an object.');
  return withRealmStorageCommit(async()=>{
    const latest=await stateAllRealms();
    const key=realmKeyFromRealm(n);
    const latestStores={...(latest.realmStores||{})};
    const latestStore={...(latestStores[key]||{})};
    const nextStore=sanitizeRealmStore({...latestStore,...realmPatch},n);
    latestStores[key]=nextStore;
    const rootPatch={};
    if(latest.activeRealmKey===key){
      for(const field of mirrorKeys){
        if(Object.prototype.hasOwnProperty.call(nextStore,field)) rootPatch[field]=nextStore[field];
      }
    }
    await storageSetUnlocked({realmStores:latestStores,...rootPatch});
    return nextStore;
  });
}
async function storageSetUnlocked(patch={}){
  if(!patch || typeof patch!=='object') return rawStorageSet(patch);
  const hasRealmStores=Object.prototype.hasOwnProperty.call(patch,'realmStores');
  if(!hasRealmStores){
    const scoped=REALM_SCOPED_KEYS.filter(key=>Object.prototype.hasOwnProperty.call(patch,key));
    const hasDiagnostic=Object.prototype.hasOwnProperty.call(patch,'fullSyncDiagnostics');
    if(!scoped.length) return rawStorageSet(patch);
    // A scoped patch without an explicit realm target belongs to the active
    // realm. Route it directly into that physical store instead of recreating
    // a shared root mirror. Diagnostics are deliberately kept in a separate
    // realm-specific key so hot Sync writes never rewrite the large realm store.
    const meta=await chrome.storage.local.get({activeRealmKey:null});
    const active=validRealmNumber(realmNumberFromKey(meta.activeRealmKey)??meta.activeRealmKey);
    if(active==null) return rawStorageSet(await routeResourceImagesOut({...patch}));
    const physicalKey=realmStorageKey(active);
    const diagKey=realmDiagnosticStorageKey(active);
    const overlayKey=gameOverlaySnapshotStorageKey(active);
    const plannerKey=productionPlannerStateStorageKey(active);
    const existingRaw=await chrome.storage.local.get({[physicalKey]:{},[overlayKey]:null,[plannerKey]:null});
    const existing=sanitizePhysicalRealmPayload(existingRaw?.[physicalKey],active);
    const next={...existing};
    const out={...patch};
    for(const field of scoped){
      if(field==='fullSyncDiagnostics') continue;
      if(field==='gameOverlaySnapshot'){ if(overlayKey)out[overlayKey]=patch[field]; delete out[field]; continue; }
      if(field==='productionPlannerState'){ if(plannerKey)out[plannerKey]=sanitizeProductionPlannerState(patch[field],active); delete out[field]; continue; }
      next[field]=patch[field];
      delete out[field];
    }
    if(hasDiagnostic && diagKey) { out[diagKey]=patch.fullSyncDiagnostics; delete out.fullSyncDiagnostics; }
    out[physicalKey]=sanitizePhysicalRealmPayload(next,active);
    out.scmRealmStoreSchema=1;
    return rawStorageSet(await routeResourceImagesOut(out));
  }
  const stores=patch.realmStores&&typeof patch.realmStores==='object'?patch.realmStores:{};
  const out={...patch}; delete out.realmStores;
  // A physical realm payload is authoritative. Never persist the synthetic
  // state.realmStores wrapper, global Manager metadata, or another realm's
  // root mirror inside a physical realm store. This boundary is deliberately
  // defensive because many legacy callers construct their payload from state().
  for(const key of REALM_SCOPED_KEYS) delete out[key];
  const targetRealms=[];
  for(const [key,value] of Object.entries(stores)){
    const realm=realmNumberFromKey(key);
    if(realm==null) continue;
    out[realmStorageKey(realm)]=sanitizePhysicalRealmPayload(value,realm);
    targetRealms.push(realm);
    const diagnostic=value?.fullSyncDiagnostics;
    const diagnosticKey=realmDiagnosticStorageKey(realm);
    const overlayKey=gameOverlaySnapshotStorageKey(realm);
    const plannerKey=productionPlannerStateStorageKey(realm);
    if(diagnosticKey && diagnostic!=null) out[diagnosticKey]=diagnostic;
    if(overlayKey && value?.gameOverlaySnapshot) out[overlayKey]=value.gameOverlaySnapshot;
    if(plannerKey && value?.productionPlannerState) out[plannerKey]=sanitizeProductionPlannerState(value.productionPlannerState,realm);
  }
  out.scmRealmStoreSchema=1;
  return rawStorageSet(await routeResourceImagesOut(out));
}
function resolvedSyncCompletion(store, realm){
  const n=validRealmNumber(realm);
  const diag=store?.fullSyncDiagnostics;
  const diagRealm=validRealmNumber(diag?.realm);
  const completedAt=String(diag?.lastSync||diag?.finishedAt||'').trim();
  const status=String(diag?.status||'');
  if(n==null||diagRealm==null||diagRealm!==n)return null;
  if(!/Sync complete/i.test(status)||diag?.syncError)return null;
  if(!completedAt||!Number.isFinite(Date.parse(completedAt)))return null;
  return completedAt;
}
async function readPhysicalRealmStore(realm){
  const n=validRealmNumber(realm);
  if(n==null)return {};
  const key=realmStorageKey(n);
  const diagnosticKey=realmDiagnosticStorageKey(n);
  const overlayKey=gameOverlaySnapshotStorageKey(n);
  const plannerKey=productionPlannerStateStorageKey(n);
  const data=await chrome.storage.local.get({[key]:null,[diagnosticKey]:null,[overlayKey]:null,[plannerKey]:null});
  const store=data?.[key];
  const clean=store&&typeof store==='object'?sanitizeRealmStore(store,n):{};
  if(data?.[diagnosticKey]&&typeof data[diagnosticKey]==='object') clean.fullSyncDiagnostics=data[diagnosticKey];
  if(data?.[overlayKey]&&typeof data[overlayKey]==='object') clean.gameOverlaySnapshot=data[overlayKey];
  clean.__productionPlannerState=plannerKey?sanitizeProductionPlannerState(data?.[plannerKey],n):null;
  // A completed full-sync diagnostic is a durable proof of completion. Older
  // 2.5.168 storage can lose the denormalized lastSync field during a later
  // Accounting/overlay write, so expose the authoritative completion time and
  // let the next normal realm-store write persist it again.
  if(!clean.lastSync){
    const completion=resolvedSyncCompletion(clean,n);
    if(completion)clean.lastSync=completion;
  }
  return clean;
}

function overlayRealmStoreIntoState(base,store,realm){
  const out={...base};
  const scopedKeys=Array.isArray(REALM_SCOPED_KEYS)?REALM_SCOPED_KEYS:[];
  for(const key of scopedKeys){
    if(Object.prototype.hasOwnProperty.call(store,key)) out[key]=store[key];
    else if(!Object.prototype.hasOwnProperty.call(out,key)) out[key]=defaultRealmValue(key);
  }
  out.realmStores=realm!=null&&realmKeyFromRealm(realm)?{[realmKeyFromRealm(realm)]:store}:{};
  return out;
}

// Manager state is deliberately active-realm-only. Passing a realm is an
// explicit background operation boundary (sync, alarm, migration, etc.); it
// never causes the active Manager view to read the other realm implicitly.
async function state(realmArg=null){
  const base=await chrome.storage.local.get(GLOBAL_DEFAULTS);
  const requested=validRealmNumber(realmArg);
  const active=validRealmNumber(realmNumberFromKey(base.activeRealmKey)??base.activeRealmKey);
  const realm=requested!=null?requested:active;
  if(realm==null)return {...DEFAULTS,...base,realmStores:{}};
  let store=await readPhysicalRealmStore(realm);
  const productionPlannerState=store.__productionPlannerState||null;
  delete store.__productionPlannerState;
  // Legacy fallback is deliberately lazy: only touch the old monolithic blob
  // when the requested physical realm has not been migrated yet.
  if(!Object.keys(store).length && Number(base.scmRealmStoreSchema||0)!==1){
    const legacy=await chrome.storage.local.get({realmStores:{}});
    const legacyStore=legacy.realmStores?.[realmKeyFromRealm(realm)];
    if(legacyStore&&typeof legacyStore==='object')store=sanitizeRealmStore(legacyStore,realm);
  }
  const out=overlayRealmStoreIntoState({...DEFAULTS,...base},store,realm);
  out.productionPlannerState=productionPlannerState;
  return out;
}

async function stateAllRealms(){
  const base=await chrome.storage.local.get(GLOBAL_DEFAULTS);
  const physical=await chrome.storage.local.get({
    'scmRealmStore:0':null,'scmRealmStore:1':null,
    'scmRealmDiagnostic:0':null,'scmRealmDiagnostic:1':null
  });
  const stores={};
  let legacy=null;
  const needLegacy=Number(base.scmRealmStoreSchema||0)!==1 && [0,1].some(r=>!physical[realmStorageKey(r)]);
  if(needLegacy) legacy=(await chrome.storage.local.get({realmStores:{}})).realmStores||{};
  for(const r of [0,1]){
    const key=realmKeyFromRealm(r);
    const raw=physical[realmStorageKey(r)];
    if(raw&&typeof raw==='object')stores[key]=sanitizeRealmStore(raw,r);
    else if(legacy?.[key]&&typeof legacy[key]==='object')stores[key]=sanitizeRealmStore(legacy[key],r);
    const diagnostic=physical[realmDiagnosticStorageKey(r)];
    if(diagnostic&&typeof diagnostic==='object') stores[key]={...(stores[key]||{}),fullSyncDiagnostics:diagnostic};
  }
  return {...DEFAULTS,...base,realmStores:stores};
}

async function appendRealmQuarantine(realm,kind,payload){
  const n=validRealmNumber(realm);
  const s=n!=null?await state(n):await state();
  const target=n!=null?n:realmNumberFromKey(s.activeRealmKey||identityFromAuth(s.authData));
  const key=target!=null?realmKeyFromRealm(target):null;
  const existing=s.realmQuarantine&&typeof s.realmQuarantine==='object'?s.realmQuarantine:{};
  const list=Array.isArray(existing?.[kind])?existing[kind].slice(-199):[];
  list.push({...payload,receivedAt:payload?.receivedAt||new Date().toISOString()});
  const next={...existing,[kind]:list};
  if(!key)return storageSet({realmQuarantine:next});
  const store={...(s.realmStores?.[key]||{}),realmQuarantine:next};
  const patch={realmStores:{[key]:store}};
  if(s.activeRealmKey===key)patch.realmQuarantine=next;
  return storageSet(patch);
}

let gameOverlayAssetsPromise=null;
async function gameOverlayAssets(){
  if(gameOverlayAssetsPromise)return gameOverlayAssetsPromise;
  gameOverlayAssetsPromise=(async()=>{
    const load=async file=>{
      const r=await fetch(chrome.runtime.getURL(file));
      if(!r.ok)throw new Error(`Unable to load ${file}`);
      return r.json();
    };
    const [bundledRecipes,rates,images]=await Promise.all([load('recipes.json'),load('production_rates_normal.json'),load('resource-image-manifest.json')]);
    const recipes=await gameRecipesFromBundle(bundledRecipes);
    const byName=new Map((Array.isArray(recipes)?recipes:[]).map(r=>[String(r.name||'').trim().toLowerCase(),r]));
    const names=new Map((Array.isArray(recipes)?recipes:[]).map(r=>[String(r.id),r.name]));
    const normalizeName=v=>String(v??'').toLowerCase().replace(/[’']/g,'').replace(/[^a-z0-9]+/g,'').replace(/s$/,'');
    const ratesByName=new Map();
    for(const [k,v] of Object.entries(rates&&typeof rates==='object'?rates:{})){
      const compact=String(k??'').toLowerCase().replace(/[’']/g,'').replace(/[^a-z0-9]+/g,'');
      const variants=new Set([normalizeName(k)]);
      if(normalizeName(k)==='cracker')variants.add('xmascracker');
      if(compact.endsWith('ies')&&compact.length>3)variants.add(normalizeName(compact.slice(0,-3)+'y'));
      if(compact.endsWith('es')&&compact.length>3)variants.add(normalizeName(compact.slice(0,-2)));
      if(compact.endsWith('s')&&compact.length>2)variants.add(normalizeName(compact.slice(0,-1)));
      for(const variant of variants)if(!ratesByName.has(variant))ratesByName.set(variant,Number(v));
    }
    return {recipes:Array.isArray(recipes)?recipes:[],rates:rates&&typeof rates==='object'?rates:{},ratesByName,normalizeName,images:images?.resources&&typeof images.resources==='object'?images.resources:{},imageBase:String(images?.baseUrl||'https://www.simcompanies.com/static/images/resources/'),byName,names};
  })().catch(e=>{gameOverlayAssetsPromise=null;throw e});
  return gameOverlayAssetsPromise;
}
function overlayBuildingLevel(b){const direct=Number(b?.level??b?.lvl??b?.buildingLevel);if(Number.isFinite(direct)&&direct>0)return Math.min(20,direct);const size=Number(b?.size);if(Number.isFinite(size)&&size>0)return Math.min(20,size);return 1;}
function productionSnapshotKey(buildingId,started,resourceId,product){
  return `${Number(buildingId)}|${Number(resourceId)||0}|${String(product||'').toLowerCase().replace(/\s+/g,' ').trim()}`;
}
function storedProductionRateSnapshot(store,building,product){
  const b=building?.raw||building||{};
  const busy=b?.busy||{};
  const rid=Number(busy?.resource?.kind??busy?.resource?.resourceId);
  const key=productionSnapshotKey(b?.id,busy?.started,rid,product);
  const direct=store?.productionRateSnapshots?.[key];
  const directStarted=String(direct?.started||'');
  const directCycleMatches=!String(busy?.started||'') || directStarted===String(busy?.started||'');
  if(direct&&directCycleMatches&&Number.isFinite(Number(direct.baseRatePerLevel))&&Number(direct.baseRatePerLevel)>0)return direct;
  // A snapshot is only valid for the current production cycle.
  // Do not fall back to an older building/product snapshot when `busy.started`
  // has changed (most importantly after an upgrade). An older snapshot can
  // have a perfectly valid rate for the previous cycle but must never be
  // reused with the current cycle's duration/history.
  const targetId=Number(b?.id);
  const targetName=String(product||'').trim().toLowerCase();
  const currentStarted=String(busy?.started||'');
  if(Number.isFinite(targetId)&&targetId>0&&currentStarted){
    const matches=Object.values(store?.productionRateSnapshots||{}).filter(s=>
      Number(s?.buildingId)===targetId&&
      String(s?.product||'').trim().toLowerCase()===targetName&&
      String(s?.started||'')===currentStarted&&
      Number(s?.baseRatePerLevel)>0
    );
    matches.sort((a,b)=>Date.parse(String(b?.capturedAt||''))-Date.parse(String(a?.capturedAt||'')));
    if(matches[0])return matches[0];
  }
  return null;
}
async function saveProductionRateSnapshot(m){
  const realm=validRealmNumber(m?.realm);
  if(realm==null)return {ok:false,error:'Valid realm required.'};
  return withRealmWriteLock(realm,async()=>{
    const key=realmKeyFromRealm(realm);
    const buildingId=Number(m?.buildingId),resourceId=Number(m?.resourceId),baseRatePerLevel=Number(m?.baseRatePerLevel);
    const started=String(m?.started||'');
    const product=String(m?.product||'').trim();
    if(!key||!Number.isFinite(buildingId)||buildingId<=0||!Number.isFinite(resourceId)||resourceId<=0||!product||!Number.isFinite(baseRatePerLevel)||baseRatePerLevel<=0)return {ok:false,error:'Incomplete production rate snapshot.'};
    const s=await state(realm);
    const stores={...(s.realmStores||{})}; const store={...(stores[key]||{})};
    const snapshots={...(store.productionRateSnapshots||{})}; const snapKey=productionSnapshotKey(buildingId,started,resourceId,product); const existing=snapshots[snapKey];
    const incoming={buildingId,resourceId,product,started,baseRatePerLevel,observedRatePerHour:Number(m?.observedRatePerHour)||null,eventModifier:Number(m?.eventModifier)||0,companyProductionModifier:Number(m?.companyProductionModifier)||0,companyModifierNormalized:Boolean(m?.companyModifierNormalized),source:String(m?.source||'captured'),capturedAt:new Date().toISOString(),captureRealm:realm};
    // Production protection keeps the validated base rate stable, but observed
    // rate is cycle-specific. The snapshot key is intentionally backward-
    // compatible and does not include `started`, so a new production cycle can
    // reuse the same entry without accidentally carrying the previous cycle's
    // observed rate forward under the new cycle timestamp.
    const protectedBase=Number(existing?.productionProtection?.baseRatePerLevel??existing?.baseRatePerLevel);
    const protectedObserved=Number(existing?.productionProtection?.observedRatePerHour??existing?.observedRatePerHour);
    const existingStarted=String(existing?.started||'');
    const sameCycle=!started || !existingStarted || existingStarted===started;
    const committedBase=protectedBase>0?protectedBase:baseRatePerLevel;
    const committedObserved=sameCycle&&Number.isFinite(protectedObserved)&&protectedObserved>0?protectedObserved:incoming.observedRatePerHour;
    const protectedSnapshot=existing&&committedBase>0?{
      ...existing,
      ...incoming,
      baseRatePerLevel:committedBase,
      observedRatePerHour:committedObserved,
      productionProtection:{
        version:1,
        baseRatePerLevel:committedBase,
        observedRatePerHour:committedObserved,
        capturedAt:sameCycle?String(existing?.productionProtection?.capturedAt||existing?.capturedAt||incoming.capturedAt):incoming.capturedAt,
        source:sameCycle?String(existing?.productionProtection?.source||existing?.source||incoming.source):incoming.source
      }
    }:null;
    snapshots[snapKey]=protectedSnapshot||{...incoming,productionProtection:{version:1,baseRatePerLevel:baseRatePerLevel,observedRatePerHour:incoming.observedRatePerHour,capturedAt:incoming.capturedAt,source:incoming.source}};
    const plans={...(store.productionPlans||{})}; const plan=plans[String(buildingId)];
    let planRateChanged=false;
    if(plan&&normalizeOverlayName(plan.product)===normalizeOverlayName(product)&&Number(plan.resourceId??0)===resourceId){
      const committedRate=Number(snapshots[snapKey]?.baseRatePerLevel)||null;
      const committedObserved=Number(snapshots[snapKey]?.observedRatePerHour)||null;
      planRateChanged=Math.abs(Number(plan.baseRatePerLevel||0)-Number(committedRate||0))>1e-9;
      plans[String(buildingId)]={...plan,baseRatePerLevel:committedRate,rateCapturedAt:snapshots[snapKey].capturedAt,rateSource:snapshots[snapKey].source,observedRatePerHour:committedObserved};
      store.productionPlans=plans;
    }
    if(planRateChanged)store.frozenNetworkPlan=null;
    store.productionRateSnapshots=snapshots; stores[key]=store;
    const patch={realmStores:stores}; if(s.activeRealmKey===key){patch.productionRateSnapshots=snapshots;if(store.productionPlans)patch.productionPlans=store.productionPlans;if(planRateChanged)patch.frozenNetworkPlan=null;}
    await storageSet(patch); return {ok:true,created:!existing,key:snapKey};
  });
}function productionPlanKey(buildingId){return String(Number(buildingId));}
async function saveProductionPlanSnapshot(m){
  const realm=validRealmNumber(m?.realm); if(realm==null)return {ok:false,error:'Valid realm required.'};
  return withRealmWriteLock(realm,async()=>{
    const buildingId=Number(m?.buildingId),resourceId=Number(m?.resourceId),quality=Math.max(0,Number(m?.quality)||0),plannedLevel=Math.min(20,Math.max(1,Number(m?.plannedLevel)||Number(m?.level)||1));
    const product=String(m?.product||'').trim(); if(!Number.isFinite(buildingId)||buildingId<=0||!product)return {ok:false,error:'Incomplete production plan snapshot.'};
    const key=realmKeyFromRealm(realm); const s=await state(realm); const stores={...(s.realmStores||{})}; const store={...(stores[key]||{})}; const plans={...(store.productionPlans||{})};
    const existing=plans[productionPlanKey(buildingId)]; const normalizedResourceId=Number.isFinite(resourceId)&&resourceId>0?resourceId:null; const source=String(m?.source||'building capture');
    const explicitBase=Number(m?.baseRatePerLevel); const explicitObserved=Number(m?.observedRatePerHour); const explicitCapturedAt=String(m?.rateCapturedAt||''); const explicitSource=String(m?.rateSource||'');
    const matchingSnapshot=Object.values(store.productionRateSnapshots||{}).find(x=>Number(x?.buildingId)===buildingId&&Number(x?.resourceId)===Number(normalizedResourceId)&&normalizeOverlayName(x?.product)===normalizeOverlayName(product)&&Number(x?.baseRatePerLevel)>0);
    // Use the protected production snapshot once established. This prevents a
    // background/event refresh from silently turning a frozen game-captured rate
    // into a different base rate. The calculation layer itself is unchanged.
    const protectedExistingBase=Number(existing?.productionProtection?.baseRatePerLevel??existing?.baseRatePerLevel);
    const protectedExistingObserved=Number(existing?.productionProtection?.observedRatePerHour??existing?.observedRatePerHour);
    const resolvedBase=protectedExistingBase>0?protectedExistingBase:(explicitBase>0?explicitBase:(matchingSnapshot?Number(matchingSnapshot?.productionProtection?.baseRatePerLevel??matchingSnapshot.baseRatePerLevel):Number(existing?.baseRatePerLevel)));
    const resolvedObserved=Number.isFinite(protectedExistingObserved)&&protectedExistingObserved>0?protectedExistingObserved:(explicitObserved>0?explicitObserved:(matchingSnapshot?Number(matchingSnapshot?.productionProtection?.observedRatePerHour??matchingSnapshot.observedRatePerHour)||null:Number(existing?.observedRatePerHour)||null));
    const resolvedCapturedAt=explicitCapturedAt||matchingSnapshot?.capturedAt||existing?.rateCapturedAt||null;
    const resolvedSource=explicitSource||matchingSnapshot?.source||existing?.rateSource||null;
    const sameBase=existing&&String(existing.product||'')===product&&Number(existing.resourceId??null)===Number(normalizedResourceId??null)&&(Number(existing.quality)||0)===quality;
    if(sameBase){
      const nextLevel=existing.mode==='live'?plannedLevel:Math.min(20,Math.max(1,Number(existing.plannedLevel)||plannedLevel));
      const changedLevel=Number(existing.plannedLevel||0)!==Number(nextLevel||0);
      const changedRate=Math.abs(Number(existing.baseRatePerLevel||0)-Number(resolvedBase||0))>1e-9;
      const updated={...existing,plannedLevel:nextLevel,mode:existing.mode||'live',baseRatePerLevel:resolvedBase>0?resolvedBase:null,observedRatePerHour:resolvedObserved,rateCapturedAt:resolvedCapturedAt,rateSource:resolvedSource,productionProtection:existing.productionProtection||((resolvedBase>0)?{version:1,baseRatePerLevel:resolvedBase,observedRatePerHour:resolvedObserved,capturedAt:resolvedCapturedAt||new Date().toISOString(),source:resolvedSource||'captured'}:null)};
      plans[productionPlanKey(buildingId)]=updated;store.productionPlans=plans;if((changedLevel||changedRate)&&store.frozenNetworkPlan)store.frozenNetworkPlan=null;stores[key]=store;
      const patch={realmStores:stores};if(s.activeRealmKey===key){patch.productionPlans=plans;if(changedLevel||changedRate)patch.frozenNetworkPlan=null;}await storageSet(patch);return {ok:true,changed:changedLevel||changedRate,plan:updated};
    }
    const plan={buildingId,product,resourceId:normalizedResourceId,quality,plannedLevel,mode:String(m?.mode||'live'),baseRatePerLevel:resolvedBase>0?resolvedBase:null,observedRatePerHour:resolvedObserved,rateCapturedAt:resolvedCapturedAt,rateSource:resolvedSource,capturedAt:new Date().toISOString(),captureRealm:realm,source,productionProtection:resolvedBase>0?{version:1,baseRatePerLevel:resolvedBase,observedRatePerHour:resolvedObserved,capturedAt:resolvedCapturedAt||new Date().toISOString(),source:resolvedSource||source}:null};
    plans[productionPlanKey(buildingId)]=plan;store.productionPlans=plans;if(store.frozenNetworkPlan)store.frozenNetworkPlan=null;stores[key]=store;
    const patch={realmStores:stores};if(s.activeRealmKey===key){patch.productionPlans=plans;patch.frozenNetworkPlan=null;}await storageSet(patch);return {ok:true,changed:true,plan};
  });
}
async function saveFrozenNetworkPlanSnapshot(m){
  const realm=validRealmNumber(m?.realm); if(realm==null)return {ok:false,error:'Valid realm required.'};
  return withRealmWriteLock(realm,async()=>{
    const key=realmKeyFromRealm(realm); if(!key)return {ok:false,error:'Invalid realm.'};
    const plan=m?.plan&&typeof m.plan==='object'?m.plan:null;if(!plan)return {ok:false,error:'Frozen network plan required.'};
    const productionRows=Array.isArray(plan.productionRows)?plan.productionRows.map(x=>({id:Number(x.id),quality:Number(x.quality)||0,amount:Number(x.amount)||0})).filter(x=>x.id>0&&x.amount>0):[];
    const demandRows=Array.isArray(plan.demandRows)?plan.demandRows.map(x=>({id:Number(x.id),minQuality:Number(x.minQuality)||0,amount:Number(x.amount)||0})).filter(x=>x.id>0&&x.amount>0):[];
    const activeSpecs=Array.isArray(plan.activeSpecs)?plan.activeSpecs.map(x=>({buildingId:Number(x.buildingId),product:String(x.product||''),productId:Number(x.productId),quality:Number(x.quality)||0,level:Number(x.level)||1,ratePerHour:Number(x.ratePerHour)||0,outputRun:Number(x.outputRun)||0})).filter(x=>x.buildingId>0&&x.product&&x.productId>0&&x.ratePerHour>0&&x.outputRun>0):[];
    const hours=Math.max(1,Number(plan.hours)||24); const signature=String(m?.signature||''); if(!signature)return {ok:false,error:'Frozen plan signature required.'};
    const normalizedPlans={};for(const [rawId,v] of Object.entries(plan.buildingPlans||{})){const id=Number(rawId);if(!Number.isFinite(id)||id<=0)continue;const entry={...v,buildingId:id,product:String(v?.product||''),productId:Number(v?.productId),resourceId:Number(v?.resourceId),quality:Math.max(0,Number(v?.quality)||0),plannedLevel:Math.min(20,Math.max(1,Number(v?.plannedLevel)||1)),baseRatePerLevel:Number(v?.baseRatePerLevel)>0?Number(v.baseRatePerLevel):null,mode:String(v?.mode||'live')};if(entry.product&&entry.productId>0)normalizedPlans[String(id)]=entry;}
    const s=await state(realm);const stores={...(s.realmStores||{})};const store={...(stores[key]||{})};
    const liveProductionBuildings=Array.isArray(store.buildings)?store.buildings.filter(b=>b&&String(b?.category||'').toLowerCase()==='production'):[];
    const liveConfiguredIds=new Set(liveProductionBuildings.filter(b=>String(b?.busy?.resource?.name||'').trim()).map(b=>Number(b.id)).filter(n=>Number.isFinite(n)&&n>0));
    const expectedPlans=Object.values(store.productionPlans||{}).filter(p=>p&&String(p.product||'').trim()&&p.mode!=='disabled');
    const expectedIds=new Set([...liveConfiguredIds,...expectedPlans.map(p=>Number(p.buildingId))].filter(n=>Number.isFinite(n)&&n>0));
    const actualIds=new Set(activeSpecs.map(x=>Number(x.buildingId)).filter(n=>Number.isFinite(n)&&n>0));
    const missing=[...expectedIds].filter(id=>!actualIds.has(id));
    const missingPlanEntries=[...expectedIds].filter(id=>!normalizedPlans[String(id)]);
    const unratedPlanEntries=[...expectedIds].filter(id=>{const p=normalizedPlans[String(id)];return !p||!(Number(p.baseRatePerLevel)>0);});
    if(!activeSpecs.length||!productionRows.length)return {ok:false,error:'Frozen plan has no planned production output.'};
    if(missing.length)return {ok:false,error:`Frozen plan incomplete; missing building specs: ${missing.join(',')}`};
    if(missingPlanEntries.length)return {ok:false,error:`Frozen plan incomplete; missing building plans: ${missingPlanEntries.join(',')}`};
    if(unratedPlanEntries.length)return {ok:false,error:`Frozen plan incomplete; unrated building plans: ${unratedPlanEntries.join(',')}`};
    const existing=store.frozenNetworkPlan;if(existing&&String(existing.signature||'')===signature)return {ok:true,changed:false,plan:existing};
    const frozen={realm,signature,hours,productionRows,demandRows,activeSpecs,buildingPlans:normalizedPlans,plannerState:plan.plannerState&&typeof plan.plannerState==='object'?plan.plannerState:null,modifiers:plan.modifiers&&typeof plan.modifiers==='object'?plan.modifiers:{companyProductionModifier:0,events:{}},resources:Array.isArray(plan.resources)?plan.resources:[],deficits:Array.isArray(plan.deficits)?plan.deficits:[],surpluses:Array.isArray(plan.surpluses)?plan.surpluses:[],capturedAt:new Date().toISOString(),source:'frozen realm network plan'};
    store.frozenNetworkPlan=frozen;stores[key]=store;const patch={realmStores:stores};if(s.activeRealmKey===key)patch.frozenNetworkPlan=frozen;await storageSet(patch);return {ok:true,changed:true,plan:frozen};
  });
}
function overlayActiveProductionEventModifier(store,product){
  const target=String(product||'').toLowerCase().replace(/[’']/g,'').replace(/[^a-z0-9]+/g,'').replace(/s$/,'');
  const now=Date.now();
  let modifier=0;
  for(const e of Array.isArray(store?.productionEvents)?store.productionEvents:[]){
    const exp=Number(e?.expiresAt);
    if(Number.isFinite(exp)&&exp<=now)continue;
    const name=String(e?.resourceName||e?.name||'').toLowerCase().replace(/[’']/g,'').replace(/[^a-z0-9]+/g,'').replace(/s$/,'');
    if(name===target)modifier+=Number(e?.modifier)||0;
  }
  return Math.max(-99,Math.min(99,modifier));
}
// v2.5.345 base rate/level from the game's constants for the phase in the stored auth-data (temporals.economyState),
// × abundance % for the building when the game has shown it. null when anything is missing.
function overlayGameBaseRate(store,constants,resourceId,buildingId){
  try{
    const C=globalThis.SCM_TOOLS_CORE;const phase=Number(store?.authData?.temporals?.economyState);
    if(!C?.gameBaseRate||!Number.isFinite(phase))return null;
    const base=C.gameBaseRate(constants,resourceId,phase);if(!(base>0))return null;
    const ab=Number(store?.endpointData?.[`/api/v2/companies/buildings/${Number(buildingId)}/abundance/`]?.data?.abundance?.[String(resourceId)]);
    return Number.isFinite(ab)&&ab>0?base*ab/100:base;
  }catch{return null;}
}
// v2.5.345 the game's speed formula: rate = base × event × 1/(1 − bonus/100). Frozen plans record it.
const OVERLAY_SPEED_FORMULA='game-divide';
function overlayCompanyProductionModifier(store){
  const n=Number(store?.authData?.authCompany?.productionModifier);
  return Number.isFinite(n)?Math.max(-99,Math.min(99,n)):0;
}
function overlayWarehouseCostValue(v,depth=0){
  if(depth>5||v==null)return null;
  if(typeof v==='number'&&Number.isFinite(v))return v;
  if(typeof v==='string'){const n=Number(v.replace(/[$,%\s,]/g,''));return Number.isFinite(n)?n:null;}
  if(Array.isArray(v)){let sum=0,found=false;for(const x of v){const n=overlayWarehouseCostValue(x,depth+1);if(n!=null){sum+=n;found=true;}}return found?sum:null;}
  if(typeof v==='object'){let sum=0,found=false;for(const [k,val] of Object.entries(v)){if(/^(id|kind|quality|percentage|percent|share)$/i.test(k))continue;const n=overlayWarehouseCostValue(val,depth+1);if(n!=null){sum+=n;found=true;}}return found?sum:null;}
  return null;
}
function overlayWarehouseRows(warehouse){
  const groups=new Map();
  for(const row of Array.isArray(warehouse)?warehouse:[]){
    const id=Number(row?.kind??row?.resourceId??row?.id);
    const q=Number(row?.quality??row?.q??row?.resourceQuality);
    const qty=Number(row?.amount??row?.quantity??row?.qty??row?.units);
    if(!Number.isFinite(id)||id<=0||!Number.isFinite(q)||!Number.isFinite(qty)||qty<=0)continue;
    const key=`${id}:${q}`;
    const totalCost=overlayWarehouseCostValue(row?.cost);
    const g=groups.get(key)||{...row,id,quality:q,qty:0,totalCost:0,hasCost:false};
    g.qty+=qty;
    if(totalCost!=null){g.totalCost+=totalCost;g.hasCost=true;}
    groups.set(key,g);
  }
  return [...groups.values()].map(g=>({...g,cost:g.hasCost&&g.qty>0?g.totalCost/g.qty:null}));
}
function overlayVwap(store,id,quality,realm){
  // VWAP belongs to the physical realm store that produced it. Never borrow a
  // root mirror or a neighboring quality when building a realm-specific overlay.
  if(!Number.isInteger(Number(realm)) || ![0,1].includes(Number(realm))) return null;
  const data=store?.vwapData;
  if(!data || Number(data.sourceRealm)!==Number(realm)) return null;
  const rows=Array.isArray(data.rows)?data.rows:[];
  const hit=rows.find(x=>
    Number(x?.resourceId??x?.id??x?.kind)===Number(id) &&
    Number(x?.quality)===Number(quality)
  );
  const n=Number(hit?.value??hit?.vwap??hit?.price);
  return Number.isFinite(n)&&n>0?n:null;
}
function overlayCurrentMarketPrice(store,id,quality,realm){
  if(!Number.isInteger(Number(realm)) || ![0,1].includes(Number(realm))) return null;
  const data=store?.liveMarketPriceData;
  const rows=data && Number(data.realm)===Number(realm)&&Array.isArray(data.rows)?data.rows:[];
  const hit=rows.find(x=>Number(x?.resourceId)===Number(id)&&Number(x?.quality)===Number(quality));
  const direct=Number(hit?.price);
  if(Number.isFinite(direct)&&direct>0) return direct;
  const key=`${Number(id)}:${Number(quality)}`;
  const product=store?.liveMarketProductCache?.[key];
  if(Number(product?.resourceId)===Number(id)&&Number(product?.quality)===Number(quality)){
    const selected=Number(product?.selected?.price);
    if(Number.isFinite(selected)&&selected>0)return selected;
  }
  return null;
}
function overlayIncomingContractMarketComparison(store,contract,realm){
  // Prefer exact-quality live current-market price. If that resource/quality has
  // not been fetched into the smaller live-price cache, use the same realm's
  // exact-quality VWAP dataset as a deterministic fallback; never borrow a
  // neighboring quality or another realm's data.
  const current=overlayCurrentMarketPrice(store,contract?.kind,contract?.quality,realm);
  const marketPrice=current!=null?current:overlayVwap(store,contract?.kind,contract?.quality,realm);
  const price=Number(contract?.price);
  const savingsPct=marketPrice!=null&&marketPrice>0&&Number.isFinite(price)&&price>0
    ? (marketPrice-price)/marketPrice*100 : null;
  return {marketPrice,savingsPct,marketPriceSource:current!=null?'current-market':'realm-vwap'};
}
function mergeSellingHistory(store){
  const current={...(store?.sellingHistory||{})};
  const recent=store?.accountingCapture?.['/api/v2/companies/me/cashflow/recent/']?.data?.data;
  for(const row of Array.isArray(recent)?recent:[]){
    const d=row?.details||{};
    const rid=Number(d.resource??d.resourceId??row.resource??row.resourceId);
    const profit=Number(d.profit??row.profit);
    const amount=Number(d.amount??row.amount);
    if(!Number.isFinite(rid)||rid<=0||!Number.isFinite(profit)||profit<=0||!Number.isFinite(amount)||amount<=0)continue;
    const id=String(row.id??`${row.datetime||''}|${rid}|${amount}|${profit}`);
    current[id]={id:row.id??id,resourceId:rid,amount,profit,datetime:row.datetime||null,category:String(row.category||'')};
  }
  const entries=Object.values(current).sort((a,b)=>Date.parse(String(a.datetime||''))-Date.parse(String(b.datetime||''))).slice(-5000);
  return Object.fromEntries(entries.map(x=>[String(x.id),x]));
}

function accountingWeekStart(store){
  const week=store?.endpointData?.['/api/v2/companies/me/cashflow-statement/week/0/']?.data;
  const cf=store?.endpointData?.['/api/v2/companies/me/cashflow-statement/']?.data;
  const raw=week?.dateFrom??cf?.dateFrom;
  const ms=Date.parse(String(raw||''));
  return Number.isFinite(ms)?ms:null;
}
function normalizeAccountingSaleRow(row){
  const raw=row&&typeof row==='object'?row:{}; const d=raw.details&&typeof raw.details==='object'?raw.details:{};
  const category=String(raw.category||'').toLowerCase();
  const descriptionKey=String(raw.descriptionKey||'').toLowerCase();
  const isSale=category==='m' || descriptionKey.startsWith('cs-');
  if(!isSale)return null;
  const resourceId=Number(d.resource??d.resourceId??raw.resource??raw.resourceId);
  const amount=Number(d.amount??raw.amount);
  const price=Number(d.price??raw.price);
  const profit=Number(d.profit??raw.profit);
  const money=Number(raw.money??d.money);
  const datetime=raw.datetime||null;
  const dateMs=Date.parse(String(datetime||''));
  if(!Number.isFinite(resourceId)||resourceId<=0||!Number.isFinite(amount)||amount<=0||!Number.isFinite(profit)||!Number.isFinite(dateMs))return null;
  const id=String(raw.id??`${datetime}|${resourceId}|${amount}|${profit}`);
  const gross=Number.isFinite(price)&&price>0?amount*price:(Number.isFinite(money)&&money>0?money:null);
  if(!Number.isFinite(gross)||gross<=0)return null;
  return {id,resourceId,amount,price:Number.isFinite(price)&&price>0?price:null,gross,profit,money:Number.isFinite(money)?money:null,datetime,category:String(raw.category||''),descriptionKey:String(raw.descriptionKey||'')};
}
function mergeAccountingWeekSales(store, rows, weekStartMs){
  const current={...(store?.accountingWeekSales||{})};
  const boundary=Number(weekStartMs);
  for(const raw of Array.isArray(rows)?rows:[]){
    const item=normalizeAccountingSaleRow(raw); if(!item)continue;
    const ms=Date.parse(String(item.datetime||''));
    if(Number.isFinite(boundary)&&ms<boundary)continue;
    current[item.id]=item;
  }
  const entries=Object.values(current).filter(x=>{const ms=Date.parse(String(x?.datetime||''));return Number.isFinite(ms)&&(!Number.isFinite(boundary)||ms>=boundary);}).sort((a,b)=>Date.parse(String(a.datetime||''))-Date.parse(String(b.datetime||'')));
  return Object.fromEntries(entries.map(x=>[String(x.id),x]));
}
function computeAccountingWeekSalesSummary(store){
  const rows=Object.values(store?.accountingWeekSales||{}).filter(x=>x&&typeof x==='object');
  const netGroups=new Map();
  const grossGroups=new Map();
  const dated=[];
  for(const x of rows){
    const rid=Number(x?.resourceId);
    const amount=Number(x?.amount);
    const profit=Number(x?.profit);
    const gross=Number(x?.gross);
    const ms=Date.parse(String(x?.datetime||''));
    if(Number.isFinite(ms))dated.push(ms);
    if(!Number.isFinite(rid)||rid<=0||!Number.isFinite(amount)||amount<=0)continue;
    if(Number.isFinite(profit)&&profit>0){
      const g=netGroups.get(String(rid))||{resourceId:rid,amount:0,profit:0};
      g.amount+=amount; g.profit+=profit; netGroups.set(String(rid),g);
    }
    if(Number.isFinite(gross)&&gross>0){
      const g=grossGroups.get(String(rid))||{resourceId:rid,amount:0,gross:0};
      g.amount+=amount; g.gross+=gross; grossGroups.set(String(rid),g);
    }
  }
  const top=(map,key)=>[...map.values()].sort((a,b)=>b[key]-a[key]||b.amount-a.amount).slice(0,10).map((x,i)=>({...x,rank:i+1}));
  return {
    rangeStart:dated.length?Math.min(...dated):null,
    rangeEnd:dated.length?Math.max(...dated):null,
    netProfit:top(netGroups,'profit'),
    gross:top(grossGroups,'gross'),
    transactionCount:rows.length,
    updatedAt:new Date().toISOString()
  };
}
function accountingWeekLedgerCacheComplete(store,boundaryMs,recentRows=null){
  const status=store?.accountingWeekLedgerStatus&&typeof store.accountingWeekLedgerStatus==='object'?store.accountingWeekLedgerStatus:null;
  if(String(status?.status||'')!=='complete')return false;
  const ledger=store?.accountingWeekSales&&typeof store.accountingWeekSales==='object'?store.accountingWeekSales:{};
  if(!Object.keys(ledger).length)return false;
  const boundary=Number(boundaryMs);
  if(!Number.isFinite(boundary))return false;
  const parseDateMs=v=>{
    const n=Number(v);
    if(Number.isFinite(n)&&n>0)return n;
    const ms=Date.parse(String(v||''));
    return Number.isFinite(ms)?ms:null;
  };
  const statusBoundary=parseDateMs(status?.boundary);
  const summary=store?.accountingWeekSalesSummary&&typeof store.accountingWeekSalesSummary==='object'?store.accountingWeekSalesSummary:null;
  const summaryEnd=parseDateMs(summary?.rangeEnd);
  const boundaryMatches=Number.isFinite(statusBoundary)
    ? Math.abs(statusBoundary-boundary)<=5000
    : Number.isFinite(summaryEnd)&&summaryEnd>=boundary;
  if(!boundaryMatches)return false;
  // A populated ledger plus a 'complete' status is not enough to prove that
  // the full week was crawled. Older builds could mark a short recent feed
  // complete even though the cursor crawl never reached the week boundary.
  // Only reuse the durable cache when coverage was explicitly proven by the
  // crawl, or when the recent feed itself already crosses the week boundary.
  const coverageProven=Boolean(status?.coverageComplete)||
    (Array.isArray(recentRows)&&recentRows.length>0&&recentRows.some(x=>{
      const ms=Date.parse(String(x?.datetime||''));
      return Number.isFinite(ms)&&ms<boundary;
    }));
  if(!coverageProven)return false;
  // cashflow/recent is the incremental freshness feed. If its oldest captured
  // transaction is newer than the completed ledger's latest transaction, more
  // than the recent window may have arrived since the full crawl and the
  // durable cache is no longer provably gap-free. Force one authoritative
  // cursor crawl instead of silently losing sales.
  // A completed ledger is not ready unless the summary itself is complete.
  // The old check could treat a populated raw ledger as ready even when the
  // Net/Gross summary had not been committed yet, which allowed Overview to
  // render a partial result during the sync handoff.
  if(!summary || !Array.isArray(summary.netProfit) || !Array.isArray(summary.gross))return false;
  if(Array.isArray(recentRows)&&recentRows.length&&Number.isFinite(summaryEnd)){
    const recentDates=recentRows.map(x=>Date.parse(String(x?.datetime||''))).filter(Number.isFinite);
    if(recentDates.length){
      const oldestRecent=Math.min(...recentDates);
      if(summaryEnd+5000<oldestRecent)return false;
    }
  }
  return true;
}
function rebuildAccountingWeekSales(store, weekStartMs){
  const boundary=Number(weekStartMs);
  const sources=[];
  const recent=store?.endpointData?.['/api/v2/companies/me/cashflow/recent/']?.data?.data;
  if(Array.isArray(recent))sources.push(...recent);
  for(const [url,item] of Object.entries(store?.endpointData||{})){
    if(!/\/api\/v2\/companies\/me\/cashflow\/\d+\/$/i.test(url))continue;
    const rows=item?.data?.data; if(Array.isArray(rows))sources.push(...rows);
  }
  return mergeAccountingWeekSales({...store,accountingWeekSales:{}},sources,boundary);
}
async function syncCurrentWeekAccountingSales(realm, trace){
  const target=validRealmNumber(realm); if(target==null)return {ok:false,error:'Invalid sync realm.'};
  const weekPath='/api/v2/companies/me/cashflow-statement/week/0/';
  const recentPath='/api/v2/companies/me/cashflow/recent/';
  let s=await state(target); let store=s.realmStores?.[realmKeyFromRealm(target)]||{};
  const weekPathItem=store.endpointData?.[weekPath];
  const cachedBoundary=accountingWeekStart(store);
  let boundary=cachedBoundary;
  let ledger=rebuildAccountingWeekSales(store,boundary);
  let recentRows=store.endpointData?.[recentPath]?.data?.data;

  // A completed current-week ledger is durable cache, not a five-minute cache.
  // New sales are merged from the authoritative cashflow/recent capture during
  // normal Sync/API capture. Re-crawling every historical cursor page merely
  // because the summary is older than five minutes turned a growing ledger into
  // an 80-second tax on an otherwise healthy dashboard.
  if(Number.isFinite(boundary) && Array.isArray(recentRows) && accountingWeekLedgerCacheComplete(store,boundary,recentRows) && weekPathItem?.data){
    ledger=mergeAccountingWeekSales(store,recentRows,boundary);
    const key=realmKeyFromRealm(target);
    let finalLedger={}, finalSummary=null;
    await withRealmWriteLock(target,async()=>{
      const latest=await state(target);
      const latestStore=latest.realmStores?.[key]||{};
      finalLedger=rebuildAccountingWeekSales({...latestStore,accountingWeekSales:ledger},boundary);
      finalSummary=computeAccountingWeekSalesSummary({...latestStore,accountingWeekSales:finalLedger});
      const stores={...(latest.realmStores||{})};
      const nextAccountingWeekRevision=Number(latestStore?.accountingWeekRevision)||0;
      stores[key]={...(latestStore||{}),accountingWeekSales:finalLedger,accountingWeekSalesSummary:finalSummary,accountingWeekRevision:nextAccountingWeekRevision+1};
      const patch={realmStores:stores};
      if(latest.activeRealmKey===key){patch.accountingWeekSales=finalLedger;patch.accountingWeekSalesSummary=finalSummary;patch.accountingWeekRevision=nextAccountingWeekRevision+1;}
      await storageSet(patch);
    });
    trace?.('accounting-week-ledger-fast-refresh',{realm:target,boundary:new Date(boundary).toISOString(),pages:0,rows:Object.keys(finalLedger).length,crossedBoundary:false});
    return {ok:true,boundary,pages:0,rows:Object.keys(finalLedger).length,crossedBoundary:false,fastRefresh:true};
  }

  const week=await pageGet(weekPath,target);
  if(!week?.ok)throw new Error(`Current accounting week boundary request failed (HTTP ${week?.status||0}).`);
  await saveData(weekPath,week.data,week.status,'GET',target);
  s=await state(target); store=s.realmStores?.[realmKeyFromRealm(target)]||{};
  boundary=accountingWeekStart(store);
  if(!Number.isFinite(boundary))throw new Error('Current accounting week boundary was not present in the captured response.');
  ledger=rebuildAccountingWeekSales(store,boundary);
  recentRows=store.endpointData?.[recentPath]?.data?.data;
  if(!Array.isArray(recentRows)){
    const recent=await pageGet(recentPath,target);
    if(!recent?.ok)throw new Error(`Current accounting ledger request failed (HTTP ${recent?.status||0}).`);
    await saveData(recentPath,recent.data,recent.status,'GET',target);
    s=await state(target); store=s.realmStores?.[realmKeyFromRealm(target)]||{}; recentRows=store.endpointData?.[recentPath]?.data?.data;
    ledger=rebuildAccountingWeekSales(store,boundary);
  }
  let cursor=null; const recentArray=Array.isArray(recentRows)?recentRows:[];
  let coverageComplete=false;
  const oldestRowByDate=(rows)=>{
    const candidates=(Array.isArray(rows)?rows:[]).map((row,index)=>({row,index,ms:Date.parse(String(row?.datetime||''))})).filter(x=>Number.isFinite(x.ms));
    if(!candidates.length)return null;
    candidates.sort((a,b)=>a.ms-b.ms||a.index-b.index);
    return candidates[0].row;
  };
  const recentDates=recentArray.map(r=>Date.parse(String(r?.datetime||''))).filter(Number.isFinite);
  if(recentDates.length && Math.min(...recentDates)<boundary){
    // The recent feed itself reaches before the current accounting week, so
    // it already proves that every current-week transaction is represented.
    coverageComplete=true;
  } else if(recentDates.length){
    const oldestRecentRow=oldestRowByDate(recentArray);
    cursor=oldestRecentRow?.id!=null?String(oldestRecentRow.id):'';
  }
  const seenCursors=new Set(); let pages=0; let crossed=false; let endReached=false;
  while(cursor && !seenCursors.has(cursor) && pages<100){
    seenCursors.add(cursor); pages++;
    const path=`/api/v2/companies/me/cashflow/${cursor}/`;
    trace?.('ledger-page-request',{realm:target,cursor,path,page:pages});
    const response=await pageGet(path,target,trace,'accounting-ledger-page');
    trace?.('ledger-page-response',{realm:target,cursor,path,page:pages,ok:!!response?.ok,status:response?.status||0,error:response?.error||null});
    if(!response?.ok)throw new Error(`Accounting ledger page ${cursor} failed (HTTP ${response?.status||0}).`);
    await saveData(path,response.data,response.status,'GET',target);
    const rows=Array.isArray(response.data?.data)?response.data.data:[];
    ledger=mergeAccountingWeekSales({...store,accountingWeekSales:ledger},rows,boundary);
    if(!rows.length){endReached=true;coverageComplete=true;break;}
    const dates=rows.map(r=>Date.parse(String(r?.datetime||''))).filter(Number.isFinite);
    const oldest=dates.length?Math.min(...dates):null;
    if(oldest!=null && oldest<boundary){crossed=true;coverageComplete=true;break;}
    // Cursor order is not part of the API contract. Advance using the
    // oldest dated row actually returned instead of assuming the server
    // returned newest->oldest. This prevents an out-of-order page from
    // skipping transactions and producing a short Top 10.
    const oldestRow=oldestRowByDate(rows);
    const next=oldestRow?.id!=null?String(oldestRow.id):'';
    if(!next||next===cursor)break;
    cursor=next;
    s=await state(target); store=s.realmStores?.[realmKeyFromRealm(target)]||{};
  }
  const key=realmKeyFromRealm(target);
  let finalLedger={};
  let finalSummary=null;
  await withRealmWriteLock(target,async()=>{
    const latest=await state(target);
    const latestStore=latest.realmStores?.[key]||{};
    // Rebuild from the latest committed endpoint cache while retaining any
    // ledger rows collected by this sync that have not yet been observed in
    // the latest state read. The whole realm-store RMW is serialized so a
    // concurrent API capture cannot overwrite accounting rows.
    finalLedger=rebuildAccountingWeekSales({...latestStore,accountingWeekSales:ledger},boundary);
    finalSummary=computeAccountingWeekSalesSummary({...latestStore,accountingWeekSales:finalLedger});
    const stores={...(latest.realmStores||{})};
    const nextAccountingWeekRevision=Number(latestStore?.accountingWeekRevision)||0;
    stores[key]={...(latestStore||{}),accountingWeekSales:finalLedger,accountingWeekSalesSummary:finalSummary,accountingWeekRevision:nextAccountingWeekRevision+1};
    const active=latest.activeRealmKey===key;
    const patch={realmStores:stores};
    if(active){patch.accountingWeekSales=finalLedger;patch.accountingWeekSalesSummary=finalSummary;patch.accountingWeekRevision=nextAccountingWeekRevision+1;}
    await storageSet(patch);
  });
  trace?.('accounting-week-ledger-complete',{realm:target,boundary:new Date(boundary).toISOString(),pages,rows:Object.keys(finalLedger).length,crossedBoundary:crossed,endReached,coverageComplete});
  return {ok:true,boundary,pages,rows:Object.keys(finalLedger).length,crossedBoundary:crossed,endReached,coverageComplete};
}

const BACKGROUND_JOB_HISTORY_LIMIT=300;
async function recordBackgroundJobEvent(realm,event={}){
  const n=validRealmNumber(realm);if(n==null)return {ok:false,error:'Invalid realm for background job history.'};
  const key=realmKeyFromRealm(n);if(!key)return {ok:false,error:'Invalid realm for background job history.'};
  const normalized={id:`${Date.now()}-${Math.random().toString(36).slice(2,8)}`,realm:n,job:String(event.job||'unknown'),trigger:String(event.trigger||'unknown'),startedAt:event.startedAt||new Date().toISOString(),finishedAt:event.finishedAt||new Date().toISOString(),durationMs:Math.max(0,Number(event.durationMs)||0),outcome:['success','partial','failure','skipped','running','rate-limited','deferred-core-sync'].includes(event.outcome)?event.outcome:'failure',requested:Number.isFinite(Number(event.requested))?Number(event.requested):null,fetched:Number.isFinite(Number(event.fetched))?Number(event.fetched):null,refreshed:Number.isFinite(Number(event.refreshed))?Number(event.refreshed):null,checked:Number.isFinite(Number(event.checked))?Number(event.checked):null,failed:Number.isFinite(Number(event.failed))?Number(event.failed):null,cached:Number.isFinite(Number(event.cached))?Number(event.cached):null,stale:Number.isFinite(Number(event.stale))?Number(event.stale):null,error:event.error?String(event.error).slice(0,400):null,details:event.details&&typeof event.details==='object'?event.details:{}};
  // v2.5.327 mobile: job history lives in its own small key. Appending an entry used to read and rewrite
  // the whole realm store (several MB) under the realm write lock, several times a minute while the game
  // was open. Entries for one realm are appended through a serial queue so none are lost.
  const histKey=backgroundJobHistoryKey(n);
  const run=(backgroundJobQueues.get(n)||Promise.resolve()).then(async()=>{
    const raw=(await chrome.storage.local.get({[histKey]:null}))[histKey];
    let history=Array.isArray(raw)?raw.slice():null;
    if(!history){const legacy=(await chrome.storage.local.get({[realmStorageKey(n)]:null}))[realmStorageKey(n)];history=Array.isArray(legacy?.backgroundJobHistory)?legacy.backgroundJobHistory.slice():[];}
    history.push(normalized);
    notifyJobTrouble(n,normalized).catch(()=>{});
    await rawStorageSet({[histKey]:history.slice(-BACKGROUND_JOB_HISTORY_LIMIT)});
    return {ok:true,event:normalized};
  });
  backgroundJobQueues.set(n,run.catch(()=>{}));
  return run;
}
// v2.5.331 production cost history lives in its own key (scmProductionCostHistory:<realm>), written through a
// serial queue and never awaited by callers, so it can be called from inside a realm-store transaction
// without touching the realm lock. No network work here.
const productionCostQueues=new Map();
function productionCostHistoryKey(realm){return `scmProductionCostHistory:${Number(realm)}`;}
function queueProductionCostHistory(realm,entries,opts={}){
  const n=validRealmNumber(realm);if(n==null||!Array.isArray(entries)||!entries.length)return Promise.resolve({ok:false});
  const key=productionCostHistoryKey(n);
  const run=(productionCostQueues.get(n)||Promise.resolve()).then(async()=>{
    const raw=(await chrome.storage.local.get({[key]:[]}))[key];
    const merged=globalThis.SCM_TOOLS_CORE.mergeProductionCostHistory(raw,entries);
    if(merged.added||merged.changed)await rawStorageSet({[key]:merged.list});
    if(merged.added&&!opts.silent){const before=new Set((Array.isArray(raw)?raw:[]).map(e=>e.k));notifyCostChanges(n,merged.list,merged.list.filter(e=>!before.has(e.k))).catch(()=>{});}
    return {ok:true,added:merged.added,changed:merged.changed,total:merged.list.length};
  });
  productionCostQueues.set(n,run.catch(()=>{}));
  return run.catch(()=>({ok:false}));
}
// One-time seed from data already captured before 2.5.331 (current buildings + stored building histories).
async function seedProductionCostHistoryOnce(){
  const FLAG='scmProductionCostHistorySeededV1';
  const got=await chrome.storage.local.get({[FLAG]:false,'scmRealmStore:0':null,'scmRealmStore:1':null});
  if(got[FLAG])return {ok:true,skipped:true};
  const C=globalThis.SCM_TOOLS_CORE;const out={};
  for(const n of [0,1]){
    const st=got[`scmRealmStore:${n}`];if(!st||typeof st!=='object')continue;
    const blds=Array.isArray(st.buildings)?st.buildings:[];
    const entries=C.productionCostEntriesFromBuildings(blds);
    for(const [k,v] of Object.entries(st.endpointData||{})){
      const m=k.match(/^\/api\/v2\/companies\/buildings\/(\d+)\/history\/$/);if(!m||!Array.isArray(v?.data))continue;
      if(v.captureRealm!=null&&validRealmNumber(v.captureRealm)!==n)continue;
      const bid=Number(m[1]);entries.push(...C.productionCostEntriesFromHistory(bid,v.data,blds.find(x=>Number(x?.id)===bid)?.name||''));
    }
    out[n]=await queueProductionCostHistory(n,entries,{silent:true});
  }
  await rawStorageSet({[FLAG]:new Date().toISOString()});
  return {ok:true,seeded:out};
}
setTimeout(()=>{seedProductionCostHistoryOnce().catch(()=>{});},4000);
// v2.5.333 notifications. Settings in scmNotifySettings {productionFinished:bool}. Production-finished alerts use the
// game's own busy.started + busy.duration; one alarm per running batch, named scm-prodfin:<realm>:<buildingId>:<finishMs>.
// No network work. Whether the phone shows them depends on the browser's support for extension notifications.
const NOTIFY_SETTINGS_KEY='scmNotifySettings';
const NOTIFY_DEFAULTS={productionFinished:true,sales:true,priceTargets:[],bigMove:true,bigMovePct:5,incomingContracts:true,dailySummary:true,dailySummaryTime:'08:00',costChange:true,costChangePct:3,idle:true,idleHours:1,undercut:true,unprofitable:true,jobTrouble:true,economyChange:true};
async function notifySettings(){const v=(await chrome.storage.local.get({[NOTIFY_SETTINGS_KEY]:null}))[NOTIFY_SETTINGS_KEY];return {...NOTIFY_DEFAULTS,...(v&&typeof v==='object'?v:{})};}
// v2.5.334 notification state (dedupe/re-arm) in its own key, written through one serial queue.
const NOTIFY_STATE_KEY='scmNotifyState';let notifyStateQueue=Promise.resolve();
function updateNotifyState(mut){const run=notifyStateQueue.then(async()=>{const cur=(await chrome.storage.local.get({[NOTIFY_STATE_KEY]:{}}))[NOTIFY_STATE_KEY]||{};const next=await mut({...cur});if(next)await rawStorageSet({[NOTIFY_STATE_KEY]:next});return next;});notifyStateQueue=run.catch(()=>{});return run;}
let notifyRecipesMemo=null;
// v2.5.345 recipe inputs/transport come from the game's constants (scmGameConstants) when present.
async function gameRecipesFromBundle(list){try{const c=(await chrome.storage.local.get({scmGameConstants:null})).scmGameConstants;return globalThis.SCM_TOOLS_CORE.recipesFromGameConstants(list,c);}catch{return Array.isArray(list)?list:[];}}
globalThis.__scmOwnWriteHooks?.push(items=>{if(Object.prototype.hasOwnProperty.call(items,'scmGameConstants')){notifyRecipesMemo=null;gameOverlayAssetsPromise=null;}});
async function notifyRecipes(){if(notifyRecipesMemo)return notifyRecipesMemo;try{const list=await gameRecipesFromBundle(await (await fetch(chrome.runtime.getURL('recipes.json'))).json());const byId=new Map(),names=new Map();for(const r of Array.isArray(list)?list:[]){byId.set(Number(r.id),r);names.set(Number(r.id),String(r.name||''));}notifyRecipesMemo={byId,names};}catch{notifyRecipesMemo={byId:new Map(),names:new Map()};}return notifyRecipesMemo;}
async function notifyRealmStore(realm){return (await chrome.storage.local.get({[`scmRealmStore:${realm}`]:null}))[`scmRealmStore:${realm}`]||{};}
// 5 + 6: after each SimcoTools current-price update.
async function notifyAfterPriceUpdate(realm){
  const n=validRealmNumber(realm);if(n==null)return;const cfg=await notifySettings();
  const wantTargets=Array.isArray(cfg.priceTargets)&&cfg.priceTargets.some(t=>Number(t?.realm??n)===n);
  if(!wantTargets&&!cfg.bigMove&&!cfg.unprofitable)return;
  const st=await notifyRealmStore(n);const rows=Array.isArray(st.liveMarketPriceData?.rows)?st.liveMarketPriceData.rows:[];if(!rows.length)return;
  const {names}=await notifyRecipes();const N=globalThis.SCM_NOTIFY_CORE,C=globalThis.SCM_TOOLS_CORE;
  await updateNotifyState(async state=>{
    if(wantTargets){const key=`targets:${n}`;const r=N.priceTargetHits(cfg.priceTargets.filter(t=>Number(t?.realm??n)===n),rows,state[key]||{},names,n);state[key]=r.state;for(const f of r.fire)await scmNotify(`target-${n}-${f.id}-${f.q}-${Date.now()}`,f.title,f.message);}
    if(cfg.bigMove){const key=`moves:${n}`;const mv=C.moversFromTrend(rows);const r=N.bigMoves({movers:[...mv.ranked,...mv.unranked],lots:st.warehouseResources,threshold:Number(cfg.bigMovePct)||5,lastFired:state[key]||{},names,realm:n});state[key]=r.lastFired;for(const f of r.fire)await scmNotify(`move-${n}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,f.title,f.message);}
    if(cfg.unprofitable){const key=`unprof:${n}`;const r=N.unprofitable({buildings:st.buildings,store:st,realm:n,names,state:state[key]||{}});state[key]=r.state;for(const f of r.fire)await scmNotify(`unprof-${n}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,f.title,f.message);}
    return state;
  });
}
// 9: whenever the incoming-contracts list is captured. First capture only records what exists.
async function notifyIncomingContracts(realm,data){
  const n=validRealmNumber(realm);if(n==null)return;const cfg=await notifySettings();if(!cfg.incomingContracts)return;
  const {names}=await notifyRecipes();const N=globalThis.SCM_NOTIFY_CORE;
  await updateNotifyState(async state=>{const key=`contracts:${n}`;const r=N.newIncomingContracts(data,state[key],names,n);state[key]=r.seen;for(const f of r.fresh)await scmNotify(`contract-${n}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,f.title,f.message);return state;});
}
// 12: daily summary alarm at the chosen local time.
async function scheduleDailySummary(){const cfg=await notifySettings();await chrome.alarms.clear('scm-daily-summary');if(cfg.dailySummary)await chrome.alarms.create('scm-daily-summary',{when:globalThis.SCM_NOTIFY_CORE.nextDailyTime(cfg.dailySummaryTime),periodInMinutes:1440});}
async function fireDailySummary(){
  const cfg=await notifySettings();if(!cfg.dailySummary)return;const {names}=await notifyRecipes();const N=globalThis.SCM_NOTIFY_CORE;
  for(const n of [0,1]){
    const st=await notifyRealmStore(n);const ov=st?.endpointData?.['/api/v2/companies/me/past-finances-overview/'];
    const runs=(await chrome.storage.local.get({[`scmProductionCostHistory:${n}`]:[]}))[`scmProductionCostHistory:${n}`];
    if(!ov&&!(Array.isArray(runs)&&runs.length))continue;
    if(ov&&ov.captureRealm!=null&&validRealmNumber(ov.captureRealm)!==n)continue;
    const r=N.dailySummary({overview:ov?.data,runs,realm:n,names});await scmNotify(`daily-${n}-${Date.now()}`,r.title,r.message);
  }
}
chrome.alarms.onAlarm.addListener(a=>{if(a?.name==='scm-daily-summary')fireDailySummary().catch(()=>{});});
// v2.5.335 follow-up after a finished batch: idle or not collected. Decided only from building data captured
// after the finish time; if none yet, look again in an hour (up to 3 times).
async function fireFollowUp(name){
  const m=String(name).match(/^scm-followup:(\d+):(\d+):(\d+):(\d+):(\d+)$/);if(!m)return;
  const realm=Number(m[1]),bid=Number(m[2]),startedMs=Number(m[3]),finishMs=Number(m[4]),attempt=Number(m[5]);
  const cfg=await notifySettings();if(!cfg.idle)return;
  const st=await notifyRealmStore(realm);const {names}=await notifyRecipes();
  const b=(Array.isArray(st.buildings)?st.buildings:[]).find(x=>Number(x?.id)===bid);if(!b)return;
  const seenAt=Date.parse(String(st.endpointData?.['/api/v2/companies/me/buildings/']?.receivedAt||''));
  const r=globalThis.SCM_NOTIFY_CORE.followUp({building:b,startedMs,finishMs,seenAt,names,realm});
  if(r.kind==='unknown'){if(attempt<3)await chrome.alarms.create(`scm-followup:${realm}:${bid}:${startedMs}:${finishMs}:${attempt+1}`,{when:Date.now()+3600e3});return;}
  if(r.title)await scmNotify(`followup-${realm}-${bid}-${finishMs}`,r.title,r.message);
}
chrome.alarms.onAlarm.addListener(a=>{if(String(a?.name||'').startsWith('scm-followup:'))fireFollowUp(a.name).catch(()=>{});});
// 7 + 8 when an exchange order book is captured (by the game or the Manager); 10 after a warehouse update.
async function notifyOrderBook(realm,resourceId,rows){
  const n=validRealmNumber(realm);if(n==null)return;const cfg=await notifySettings();if(!cfg.undercut&&!cfg.unprofitable)return;
  if(cfg.undercut)await refreshMarketOrders(n);
  const st=await notifyRealmStore(n);const {names}=await notifyRecipes();const N=globalThis.SCM_NOTIFY_CORE;
  const companyId=st?.authData?.authCompany?.id??st?.authData?.authCompany?.companyId;
  const mo=(await chrome.storage.local.get({[`scmMarketOrders:${n}`]:null}))[`scmMarketOrders:${n}`];
  const own=Array.isArray(mo?.orders)?mo.orders.filter(o=>Number(o?.kind)===Number(resourceId)):null;
  await updateNotifyState(async state=>{
    if(cfg.undercut){const key=`undercut:${n}`;const r=N.undercut({rows,companyId,own,id:Number(resourceId),names,realm:n,state:state[key]||{}});state[key]=r.state;for(const f of r.fire)await scmNotify(`undercut-${n}-${resourceId}-${Date.now()}`,f.title,f.message);}
    if(cfg.unprofitable){const key=`unprof:${n}`;const r=N.unprofitable({buildings:st.buildings,store:st,realm:n,names,state:state[key]||{}});state[key]=r.state;for(const f of r.fire)await scmNotify(`unprof-${n}-${Date.now()}`,f.title,f.message);}
    return state;
  });
}
// v2.5.350 sales and accepted contracts from the cash-flow ledger the game/Manager just captured. No network.
async function notifySales(realm,data){
  const n=validRealmNumber(realm);if(n==null)return;const cfg=await notifySettings();if(!cfg.sales)return;
  const rows=Array.isArray(data?.data)?data.data:(Array.isArray(data)?data:[]);if(!rows.length)return;
  const {names}=await notifyRecipes();const N=globalThis.SCM_NOTIFY_CORE;
  await updateNotifyState(async state=>{const key=`sales:${n}`;const r=N.newSales(rows,state[key],names,n);state[key]=r.seen;for(const f of r.fresh)await scmNotify(`sale-${n}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,f.title,f.message);return state;});
}
async function notifyJobTrouble(realm,event){
  const n=validRealmNumber(realm);if(n==null)return;const cfg=await notifySettings();if(!cfg.jobTrouble)return;
  await updateNotifyState(async state=>{const key=`jobs:${n}`;let pricesAt=null;if(/price|vwap/i.test(String(event?.job||''))){const st=await notifyRealmStore(n);pricesAt=st?.liveMarketPriceData?.updatedAt||null;}const r=globalThis.SCM_NOTIFY_CORE.jobTrouble({counts:state[key]||{},event,realm:n,pricesUpdatedAt:pricesAt});state[key]=r.counts;if(r.fire)await scmNotify(`jobs-${n}-${Date.now()}`,r.fire.title,r.fire.message);return state;});
}
// 2: a new production run costs noticeably more/less than the last one (only runs started in the last 24 h).
async function notifyCostChanges(realm,history,newEntries){
  const n=validRealmNumber(realm);if(n==null||!newEntries.length)return;const cfg=await notifySettings();if(!cfg.costChange)return;
  const {names}=await notifyRecipes();
  for(const e of newEntries){if(Date.now()-Date.parse(e.t)>24*3600e3)continue;const r=globalThis.SCM_NOTIFY_CORE.costChanged({history,entry:e,thresholdPct:Number(cfg.costChangePct)||3,names,realm:n});if(r)await scmNotify(`cost-${n}-${e.k}`,r.title,r.message);}
}
chrome.alarms.get('scm-daily-summary').then(a=>{if(!a)scheduleDailySummary().catch(()=>{});}).catch(()=>{});
function scmNotify(id,title,message){
  {const m=String(id).match(/^[a-z]+-([01])-/);if(m&&!String(id).startsWith('jobs-'))logActivity(Number(m[1]),'alert-sent','success',{title:String(title).slice(0,80)});}
  return new Promise(resolve=>{
    try{
      if(!chrome.notifications?.create)return resolve({ok:false,error:'This browser does not provide extension notifications (chrome.notifications is missing).'});
      chrome.notifications.create(id,{type:'basic',iconUrl:chrome.runtime.getURL('icons/icon128.png'),title:String(title).slice(0,120),message:String(message).slice(0,300),priority:2},nid=>{const e=chrome.runtime.lastError;resolve(e?{ok:false,error:e.message||String(e)}:{ok:true,id:nid});});
    }catch(e){resolve({ok:false,error:e?.message||String(e)});}
  });
}
function productionFinishAlarms(realm,buildings){
  const out=[];
  for(const b of Array.isArray(buildings)?buildings:[]){
    const st=Date.parse(String(b?.busy?.started||'')),dur=Number(b?.busy?.duration);
    if(!(Number(b?.id)>0)||!Number.isFinite(st)||!(dur>0))continue;
    const finish=st+dur*1000;
    out.push({name:`scm-prodfin:${realm}:${Number(b.id)}:${finish}`,when:finish,buildingId:Number(b.id)});
  }
  return out;
}
async function scheduleProductionFinishAlarms(realm,buildings){
  const n=validRealmNumber(realm);if(n==null)return {ok:false};
  const cfg=await notifySettings();const all=await chrome.alarms.getAll();
  const mine=all.filter(a=>String(a.name).startsWith(`scm-prodfin:${n}:`));
  if(!cfg.productionFinished){for(const a of mine)await chrome.alarms.clear(a.name);return {ok:true,disabled:true};}
  const wanted=productionFinishAlarms(n,buildings).filter(x=>x.when>Date.now());
  const wantedNames=new Set(wanted.map(x=>x.name));
  const seenBuildings=new Set(wanted.map(x=>x.buildingId));
  // a building whose batch changed or ended gets its old alarm removed; buildings missing from this snapshot keep theirs
  for(const a of mine){const bid=Number(String(a.name).split(':')[2]);if(!wantedNames.has(a.name)&&seenBuildings.has(bid))await chrome.alarms.clear(a.name);}
  const have=new Set(mine.map(a=>a.name));let created=0;
  for(const x of wanted)if(!have.has(x.name)){await chrome.alarms.create(x.name,{when:x.when});created++;}
  return {ok:true,created,total:wanted.length};
}
async function fireProductionFinished(name){
  const m=String(name).match(/^scm-prodfin:(\d+):(\d+):(\d+)$/);if(!m)return;
  const realm=Number(m[1]),bid=Number(m[2]);
  const cfg=await notifySettings();if(!cfg.productionFinished)return;
  const st=await notifyRealmStore(realm);
  const b=(Array.isArray(st.buildings)?st.buildings:[]).find(x=>Number(x?.id)===bid)||{id:bid,name:`Building ${bid}`};
  const {names}=await notifyRecipes();const N=globalThis.SCM_NOTIFY_CORE;
  if(cfg.productionFinished){const r=N.batchFinishedMessage({building:b,store:st,realm,names});await scmNotify(`prodfin-${realm}-${bid}-${m[3]}`,r.title,r.message);}
  // v2.5.350 'Not enough inputs to repeat a finished batch' removed at the user's request.
  // 4 + 11: look again idleHours after the finish (idle, or still not collected).
  const st0=Date.parse(String(b?.busy?.started||''));
  if(cfg.idle&&Number.isFinite(st0)){const h=Math.max(0.25,Number(cfg.idleHours)||1);await chrome.alarms.create(`scm-followup:${realm}:${bid}:${st0}:${m[3]}:0`,{when:Number(m[3])+h*3600e3>Date.now()?Number(m[3])+h*3600e3:Date.now()+60000});}
}
chrome.alarms.onAlarm.addListener(a=>{if(String(a?.name||'').startsWith('scm-prodfin:'))fireProductionFinished(a.name).catch(()=>{});});
try{chrome.notifications?.onClicked?.addListener(id=>{if(String(id).startsWith('prodfin-'))chrome.tabs.create({url:'https://www.simcompanies.com/'}).catch(()=>{});try{chrome.notifications.clear(id);}catch{}});}catch{}
function backgroundJobHistoryKey(realm){return `scmBackgroundJobs:${Number(realm)}`;}
const backgroundJobQueues=new Map();

// v2.5.344 (user's exports 2026-10-23): on a slow phone connection the game's own API answers took 14–70 s,
// so the background warehouse refresh (8 s × 2 attempts) failed 18 times in an hour and the 10 s overlay poll
// kept re-firing it. One attempt with a longer page timeout; overlay-triggered refreshes pause after a failure.
const WAREHOUSE_REFRESH_PAGE_TIMEOUT_MS=25000;
const WAREHOUSE_OVERLAY_FAILURE_BACKOFF_MS=60000;
const warehouseOverlayBackoffUntil=new Map();
function warehouseOverlayRefreshInBackoff(realm,maxAgeMs,now=Date.now()){
  if(Number(maxAgeMs)===0)return false; // refreshes after game actions always run
  return now<(warehouseOverlayBackoffUntil.get(realm)||0);
}
function noteWarehouseOverlayRefreshResult(realm,maxAgeMs,result,now=Date.now()){
  if(result?.ok){warehouseOverlayBackoffUntil.delete(realm);return;}
  if(Number(maxAgeMs)===0||result?.stale||result?.notReady)return;
  warehouseOverlayBackoffUntil.set(realm,now+WAREHOUSE_OVERLAY_FAILURE_BACKOFF_MS);
}
async function refreshRealmWarehouseForOverlayUnlocked(realm, maxAgeMs=15000){
  const totalStartedAt=Date.now();
  const n=validRealmNumber(realm); if(n==null)return {ok:false,error:'Invalid realm.'};
  await ensureRealmStorageMigration();
  let s=await state(n);
  const key=realmKeyFromRealm(n); if(!key)return {ok:false,error:'Invalid realm.'};
  const store={...(s.realmStores?.[key]||{})};
  const capturedAt=Date.parse(String(store.warehouseCapture?.receivedAt||''));
  if(Number.isFinite(capturedAt) && Date.now()-capturedAt<maxAgeMs && Array.isArray(store.warehouseResources)&&store.warehouseResources.length){
    return {ok:true,cached:true,rows:store.warehouseResources.length};
  }
  const companyId=Number(store.authData?.authCompany?.companyId||store.authData?.authCompany?.id);
  // v2.5.345 nothing to refresh yet (auth-data not captured): a skip, not a failure in the background-jobs count.
  if(!Number.isFinite(companyId)||companyId<=0)return {ok:false,notReady:true,error:'Realm company ID unavailable.'};
  const activeKey=s.activeRealmKey;
  if(activeKey!==key)return {ok:false,stale:true,error:'Realm is not the active game session.'};
  const path=`/api/v3/resources/${companyId}/`;
  try{
    const requestStartedAt=Date.now();
    const r=await pageGet(path,null,null,null,{timeoutMs:WAREHOUSE_REFRESH_PAGE_TIMEOUT_MS,attempts:1});
    const requestDurationMs=Date.now()-requestStartedAt;
    if(!r?.ok)return {ok:false,error:r?.error||`HTTP ${r?.status||0}`,status:r?.status||0,requestDurationMs};
    const rows=normalizeWarehouse(r.data);
    if(!looksLikeWarehouseRows(rows))return {ok:false,error:'Current game warehouse response was not recognizable.',status:r.status,requestDurationMs};
    return withRealmWriteLock(n,async()=>{
      const storageCommitStartedAt=Date.now();
      const fresh=await state(n);
      // The page may switch realms while pageGet() is pending. Never commit
      // a response unless both the active realm and company identity still match.
      if(fresh.activeRealmKey!==key)return {ok:false,stale:true,error:'Discarded warehouse response after realm switch.'};
      const existing={...(fresh.realmStores?.[key]||{})};
      const currentCompany=Number(existing.authData?.authCompany?.companyId||existing.authData?.authCompany?.id);
      if(!Number.isFinite(currentCompany)||currentCompany!==companyId)
        return {ok:false,stale:true,error:'Discarded warehouse response because realm company identity changed.'};
      const previousRows=Array.isArray(existing.warehouseResources)?existing.warehouseResources:[];
      const incomingKeys=new Set(rows.map(warehouseKey).filter(Boolean));
      const previousKeys=new Set(previousRows.map(warehouseKey).filter(Boolean));
      const previousCaptureAt=Date.parse(String(existing.warehouseCapture?.receivedAt||''));
      const previousCaptureFresh=Number.isFinite(previousCaptureAt)&&Date.now()-previousCaptureAt<24*60*60*1000;
      // A successful HTTP response is not proof that an inventory payload is
      // complete. If a recent, larger snapshot exists and this response has
      // fewer than half its distinct resource/quality keys, preserve the known
      // snapshot and report a suspiciously truncated response for diagnostics.
      if(previousCaptureFresh && previousKeys.size>=6 && incomingKeys.size<Math.ceil(previousKeys.size/2))
        return {ok:false,incomplete:true,error:'Warehouse response was suspiciously smaller than the recent snapshot; preserved previous inventory.',previousRows:previousRows.length,incomingRows:rows.length,previousKeys:previousKeys.size,incomingKeys:incomingKeys.size};
      const merged=mergeWarehouseSnapshot(rows,previousRows);
      const next={...existing,warehouseResources:merged,warehouseCapture:{source:'overlay-live-resources',url:path,status:r.status,rows:merged.length,incomingRows:rows.length,receivedAt:new Date().toISOString()}};
      const stores={...(fresh.realmStores||{}),[key]:next};
      const patch={realmStores:stores};
      if(fresh.activeRealmKey===key)patch.warehouseResources=merged,patch.warehouseCapture=next.warehouseCapture;
      await storageSet(patch);
      const storageCommitDurationMs=Date.now()-storageCommitStartedAt;
      return {ok:true,rows:merged.length,refreshed:true,status:r.status,requestDurationMs,storageCommitDurationMs,totalDurationMs:Date.now()-totalStartedAt,receivedAt:next.warehouseCapture.receivedAt};
    });
  }catch(e){return {ok:false,error:e?.message||String(e),totalDurationMs:Date.now()-totalStartedAt};}
}


function normalizeOverlayName(v){return String(v??'').toLowerCase().replace(/[’']/g,'').replace(/[^a-z0-9]+/g,'').replace(/s$/,'');}
async function getRealmBuildingVwapData(realm,resourceName,quality){
  const n=validRealmNumber(realm); if(n==null)return {ok:false,error:'Invalid realm.'};
  const s=await state(n); const key=realmKeyFromRealm(n); const store={...(s.realmStores?.[key]||{})};
  const assets=await gameOverlayAssets();
  const targetName=String(resourceName||'').trim();
  const norm=normalizeOverlayName(targetName);
  let id=null;
  for(const [sid,name] of assets.names instanceof Map?assets.names.entries():[])if(normalizeOverlayName(name)===norm){id=Number(sid);break;}
  if(id==null){
    const hit=(Array.isArray(store.vwapData?.rows)?store.vwapData.rows:[]).find(r=>normalizeOverlayName(assets.names.get(String(r.resourceId))||'')===norm);
    if(hit)id=Number(hit.resourceId);
  }
  if(id==null){
    for(const b of Array.isArray(store.buildings)?store.buildings:[]){const rid=Number(b?.busy?.resource?.kind??b?.busy?.resource?.resourceId);const name=String(b?.busy?.resource?.name||'');if(Number.isFinite(rid)&&normalizeOverlayName(name)===norm){id=rid;break;}}
  }
  const rows=(Array.isArray(store.vwapData?.rows)&&Number(store.vwapData?.sourceRealm)===n?store.vwapData.rows:[]).filter(r=>Number(r.resourceId)===Number(id)&&Number(r.value)>0).sort((a,b)=>Number(a.quality)-Number(b.quality));
  if(id==null||!rows.length)return {ok:false,realm:n,resourceId:id,resourceName:targetName,quality:Number(quality),rows:[]};
  const q=Number(quality);
  const file=assets.images[String(id)];
  return {ok:true,realm:n,resourceId:id,resourceName:assets.names.get(String(id))||targetName,quality:Number.isFinite(q)?q:null,rows:rows.slice(0,12),selected:rows.find(r=>Number(r.quality)===q)||null,image:file?`${assets.imageBase}${file}`:''};
}

function overlayProductionRunHours(store){
  const n=Number(store?.productionRunHours);
  return Number.isFinite(n)?Math.min(48,Math.max(1,n)):24;
}

async function ensureRealmAuthData(realmArg){
  const realm=validRealmNumber(realmArg);
  if(realm==null) return {ok:false,error:'No valid realm.'};
  const key=realmKeyFromRealm(realm);
  let s=await state(realm);
  let store={...(s.realmStores?.[key]||{})};
  const existing=store.authData?.authCompany;
  if(existing && Number(existing.realmId)===realm && (Number.isFinite(Number(existing.productionModifier))||Number.isFinite(Number(existing.salesModifier)))){
    return {ok:true,realm,authData:store.authData};
  }
  const cachedAuth=Object.entries(store.endpointData||{})
    .filter(([url,v])=>/\/api\/v3\/companies\/auth-data\//.test(String(url||'')) && Number(v?.status)===200 && v?.data)
    .sort((a,b)=>Date.parse(b[1]?.receivedAt||'')-Date.parse(a[1]?.receivedAt||''))[0]?.[1]?.data;
  if(cachedAuth?.authCompany && Number(cachedAuth.authCompany.realmId)===realm){
    await saveData('/api/v3/companies/auth-data/',cachedAuth,200,'GET',realm);
    return {ok:true,realm,authData:cachedAuth};
  }
  try{
    const r=await pageGet('/api/v3/companies/auth-data/',realm);
    if(!r?.ok) return {ok:false,realm,error:r?.error||`HTTP ${r?.status||0}`};
    await saveData('/api/v3/companies/auth-data/',r.data,r.status||200,'GET',realm);
    s=await state(realm);
    store={...(s.realmStores?.[key]||{})};
    return {ok:true,realm,authData:store.authData||r.data};
  }catch(e){
    return {ok:false,realm,error:e?.message||String(e)};
  }
}
async function ensureFrozenProductionRatesForRealmUnlocked(realm){
  const target=validRealmNumber(realm);
  if(target==null)return {ok:false,error:'Invalid realm.'};
  await ensureRealmStorageMigration();
  await ensureRealmAuthData(target);
  let latest=await state(target);
  const key=realmKeyFromRealm(target);
  if(!key)return {ok:false,error:'Invalid realm.'};
  let store={...(latest.realmStores?.[key]||{})};
  const rootRealm=validRealmNumber(latest?.activeRealmKey!=null?String(latest.activeRealmKey).replace('realm:',''):latest?.selectedRealm);
  const buildings=realmStoredBuildings(store,latest,target);
  if(!buildings.length)return {ok:true,captured:0,requested:0,plans:0};
  const assets=await gameOverlayAssets();
  const companyModifier=Number(store?.authData?.authCompany?.productionModifier);
  // v2.5.341 game formula: speed bonus divides by (1 − bonus/100).
  const companyFactor=Number.isFinite(companyModifier)?(companyModifier<100?1/(1-companyModifier/100):0):1;
  const productionBuildings=buildings.filter(b=>b&&String(b?.category||'').toLowerCase()==='production');
  const liveProductionIds=new Set(productionBuildings.map(b=>Number(b?.id)).filter(n=>Number.isFinite(n)&&n>0));
  const stalePlans=Object.keys(store.productionPlans||{}).filter(id=>Number.isFinite(Number(id))&&!liveProductionIds.has(Number(id)));
  if(stalePlans.length){
    await withRealmWriteLock(target,async()=>{
      const fresh=await state(target);
      const freshStores={...(fresh.realmStores||{})};
      const freshStore={...(freshStores[key]||{})};
      const cleaned={...(freshStore.productionPlans||{})};
      for(const id of stalePlans)delete cleaned[id];
      freshStore.productionPlans=cleaned;
      freshStore.frozenNetworkPlan=null;
      freshStores[key]=freshStore;
      const patch={realmStores:freshStores};
      if(fresh.activeRealmKey===key){patch.productionPlans=cleaned;patch.frozenNetworkPlan=null;}
      await storageSet(patch);
    });
    latest=await state(target);
    store={...(latest.realmStores?.[key]||store)};
  }
  const missing=[];
  let plans=0;

  // Capture the current configured product/quality as a frozen plan. Once a
  // building has a plan, the plan remains valid even when the live cycle ends
  // or the busy payload temporarily disappears. A later product/quality change
  // simply overwrites the plan the next time the game exposes the new cycle.
  let gameConstantsForRates;
  for(const b of productionBuildings){
    const busy=b?.busy;
    const product=String(busy?.resource?.name||'').trim();
    if(!product)continue;
    const rid=Number(busy?.resource?.kind??busy?.resource?.resourceId);
    const quality=Math.max(0,Number(busy?.resource?.quality)||0);
    try{await saveProductionPlanSnapshot({realm:target,buildingId:Number(b.id),resourceId:rid,product,quality,plannedLevel:overlayBuildingLevel(b),mode:'live',source:'live building capture'});plans++; latest=await state(target); store={...(latest.realmStores?.[key]||store)};}catch{}
    let snap=storedProductionRateSnapshot(store,b,product);
    let snapshotValid=Boolean(snap);
    if(snap&&String(snap?.source||'').toLowerCase()==='production history'){
      const endpoint=store?.endpointData?.[`/api/v2/companies/buildings/${Number(b.id)}/history/`];
      const rows=Array.isArray(endpoint?.data)?endpoint.data:[];
      const startedMs=Date.parse(String(b?.busy?.started||''));
      const resourceId=Number(b?.busy?.resource?.kind??b?.busy?.resource?.resourceId);
      const currentRows=rows.filter(row=>{
        const amount=Number(row?.outputAmount??row?.amount);
        const rowKind=Number(row?.kind);
        const rowMs=Date.parse(String(row?.datetime||''));
        const idMatch=Number.isFinite(resourceId)&&resourceId>0&&Number.isFinite(rowKind)&&rowKind===resourceId;
        const cycleMatch=Number.isFinite(startedMs)&&Number.isFinite(rowMs)&&Math.abs(rowMs-startedMs)<=5000;
        return Number.isFinite(amount)&&amount>0&&idMatch&&cycleMatch;
      });
      const duration=Number(b?.busy?.duration);
      if(currentRows.length&&Number.isFinite(duration)&&duration>0){
        const amount=Number(currentRows[0]?.outputAmount??currentRows[0]?.amount);
        const actualRate=amount/(duration/3600);
        const storedRate=Number(snap?.observedRatePerHour);
        if(Number.isFinite(actualRate)&&actualRate>0&&Number.isFinite(storedRate)&&storedRate>0){
          const relativeError=Math.abs(storedRate-actualRate)/actualRate;
          if(relativeError>0.005)snapshotValid=false;
        }
      }
    }
    if(!snapshotValid)missing.push({b,product,rid,quality});
  }
  if(missing.length){
    await Promise.all(missing.map(async x=>{try{await fetchBuildingHistoryForRealm(target,Number(x.b.id));}catch{}}));
    latest=await state(target);
    store={...(latest.realmStores?.[key]||{})};
  }
  let captured=0;
  for(const {b,product,rid,quality} of missing){
    const existing=storedProductionRateSnapshot(store,b,product);
    const duration=Number(b?.busy?.duration);
    const level=overlayBuildingLevel(b);
    const endpoint=store?.endpointData?.[`/api/v2/companies/buildings/${Number(b.id)}/history/`];
    const rows=Array.isArray(endpoint?.data)?endpoint.data:[];
    const targetName=String(product||'').trim().toLowerCase();
    const startedMs=Date.parse(String(b?.busy?.started||''));
    const resourceId=Number(b?.busy?.resource?.kind??b?.busy?.resource?.resourceId);
    const currentCycleRows=rows.filter(row=>{
      const amount=Number(row?.outputAmount??row?.amount);
      const rowKind=Number(row?.kind);
      const rowName=String(row?.resourceName||row?.name||'').trim().toLowerCase();
      const rowMs=Date.parse(String(row?.datetime||''));
      const idMatch=Number.isFinite(resourceId)&&resourceId>0&&Number.isFinite(rowKind)&&rowKind===resourceId;
      const nameMatch=rowName&&rowName===targetName;
      const cycleMatch=Number.isFinite(startedMs)&&Number.isFinite(rowMs)&&Math.abs(rowMs-startedMs)<=5000;
      return Number.isFinite(amount)&&amount>0&&(idMatch||nameMatch)&&cycleMatch;
    });
    // A stored snapshot for the current cycle is normally authoritative, but
    // legacy snapshots may have been created by the old nearest-history logic.
    // If the exact current-cycle history row is available, validate the stored
    // observed rate against it and repair a mismatch instead of preserving a
    // mathematically plausible rate made from an older history row.
    if(existing&&currentCycleRows.length&&Number.isFinite(duration)&&duration>0){
      const amount=Number(currentCycleRows[0]?.outputAmount??currentCycleRows[0]?.amount);
      const actualRate=amount/(duration/3600);
      if(Number.isFinite(actualRate)&&actualRate>0){
        const storedRate=Number(existing?.observedRatePerHour);
        const relativeError=Math.abs(storedRate-actualRate)/actualRate;
        if(Number.isFinite(storedRate)&&relativeError<=0.005)continue;
      }
    }else if(existing){
      continue;
    }
    if(!Number.isFinite(duration)||duration<=0||!Number.isFinite(level)||level<=0||!Number.isFinite(rid)||rid<=0)continue;
    // History is authoritative only when the row can be proven to belong to
    // this exact production cycle. The API's history datetime is the cycle
    // start; using an older matching row with the current cycle duration
    // creates a mathematically plausible but completely wrong rate (the
    // Propulsion Factory failure: 1192 old units / 16126 current seconds).
    const matches=rows.filter(row=>{
      const amount=Number(row?.outputAmount??row?.amount);
      const rowKind=Number(row?.kind);
      const rowName=String(row?.resourceName||row?.name||'').trim().toLowerCase();
      const rowMs=Date.parse(String(row?.datetime||''));
      const idMatch=Number.isFinite(resourceId)&&resourceId>0&&Number.isFinite(rowKind)&&rowKind===resourceId;
      const nameMatch=rowName&&rowName===targetName;
      const cycleMatch=Number.isFinite(startedMs)&&Number.isFinite(rowMs)&&Math.abs(rowMs-startedMs)<=5000;
      return Number.isFinite(amount)&&amount>0&&(idMatch||nameMatch)&&cycleMatch;
    });
    matches.sort((a,b)=>Date.parse(String(b?.datetime||''))-Date.parse(String(a?.datetime||'')));
    let baseRatePerLevel=null, observedRatePerHour=null, source='reference rate';
    const row=matches[0];
    if(row){
      const amount=Number(row?.outputAmount??row?.amount);
      const rate=amount/(duration/3600);
      if(Number.isFinite(rate)&&rate>0&&companyFactor>0){
        const eventModifier=overlayActiveProductionEventModifier(store,product);
        const eventFactor=1+eventModifier/100;
        if(eventFactor>0){
          observedRatePerHour=rate;
          baseRatePerLevel=rate/level/eventFactor/companyFactor;
          source='production history';
        }
      }
    }
    if(!(baseRatePerLevel>0)){
      // v2.5.345 the game's own base rate for the current economy phase (constants), × the building's abundance
      // where the game shows one. The bundled normal-economy file is only the last resort (it was stale, e.g. Steak +76%).
      if(gameConstantsForRates===undefined){try{gameConstantsForRates=(await chrome.storage.local.get({scmGameConstants:null})).scmGameConstants||null;}catch{gameConstantsForRates=null;}}
      const gameBase=overlayGameBaseRate(store,gameConstantsForRates,rid,b?.id);
      const ref=gameBase>0?gameBase:Number(assets.ratesByName?.get(assets.normalizeName(product)));
      if(Number.isFinite(ref)&&ref>0){
        baseRatePerLevel=ref;
        observedRatePerHour=ref*level*companyFactor;
        if(gameBase>0)source='reference rate (game constants)';
      }
    }
    if(!(baseRatePerLevel>0))continue;
    try{
      // Commit the recovered rate and its matching production plan together.
      // This is the authoritative realm-local repair transaction. It prevents
      // a valid history-derived rate from being lost between two separate
      // storage writes and guarantees the plan cannot remain unrated after the
      // snapshot is successfully recovered.
      const rateCapturedAt=new Date().toISOString();
      const snapshotKey=productionSnapshotKey(Number(b.id),b?.busy?.started,rid,product);
      // `missing` means the current-cycle snapshot is absent or failed
      // validation. Replace that cycle's snapshot rather than re-protecting a
      // legacy bad value. Protection is for a validated snapshot, not for a
      // value that merely happens to exist in storage.
      const committedSnapshot={buildingId:Number(b.id),resourceId:rid,product,started:String(b?.busy?.started||''),baseRatePerLevel,observedRatePerHour,eventModifier:overlayActiveProductionEventModifier(store,product),companyProductionModifier:Number.isFinite(companyModifier)?companyModifier:0,companyModifierNormalized:true,source,capturedAt:rateCapturedAt,captureRealm:target};
      await withRealmWriteLock(target,async()=>{
        const latestCommit=await state(target);
        const latestStores={...(latestCommit.realmStores||{})};
        const latestStore={...(latestStores[key]||{})};
        const latestSnapshots={...(latestStore.productionRateSnapshots||{})};
        const latestPlans={...(latestStore.productionPlans||{})};
        latestSnapshots[snapshotKey]=committedSnapshot;
        const latestPlan=latestPlans[String(Number(b.id))]||{};
        latestPlans[String(Number(b.id))]={...latestPlan,buildingId:Number(b.id),product,resourceId:rid,quality,plannedLevel:level,mode:latestPlan.mode||'live',baseRatePerLevel:Number(committedSnapshot.baseRatePerLevel),observedRatePerHour:Number(committedSnapshot.observedRatePerHour)||observedRatePerHour,rateCapturedAt:committedSnapshot.capturedAt||rateCapturedAt,rateSource:committedSnapshot.source||source,captureRealm:target,source:'frozen production snapshot'};
        latestStore.productionRateSnapshots=latestSnapshots;
        latestStore.productionPlans=latestPlans;
        latestStore.frozenNetworkPlan=null;
        latestStores[key]=latestStore;
        const latestPatch={realmStores:latestStores};
        if(latestCommit.activeRealmKey===key){latestPatch.productionRateSnapshots=latestSnapshots;latestPatch.productionPlans=latestPlans;latestPatch.frozenNetworkPlan=null;}
        await storageSet(latestPatch);
      });
      const verified=await state(target);
      const verifiedStore=verified.realmStores?.[key]||{};
      const verifiedSnapshot=storedProductionRateSnapshot(verifiedStore,b,product);
      const verifiedPlan=verifiedStore.productionPlans?.[String(Number(b.id))];
      if(!(Number(verifiedSnapshot?.baseRatePerLevel)>0)||!(Number(verifiedPlan?.baseRatePerLevel)>0)){
        throw new Error(`Failed to persist frozen production rate for building ${Number(b.id)}.`);
      }
      captured++;
      plans++;
      latest=verified;
      store={...(verifiedStore||store)};
    }catch(e){
      // Keep the building unresolved rather than manufacturing a fallback rate.
      continue;
    }
  }
  return {ok:true,requested:missing.length,captured,plans};
}


async function ensureFrozenProductionRatesForRealm(realm){
  const target=validRealmNumber(realm);
  if(target==null)return {ok:false,error:'Invalid realm.'};
  const existing=frozenRateEnsurePromises.get(target);
  if(existing)return existing;
  const promise=ensureFrozenProductionRatesForRealmUnlocked(target)
    .catch(error=>({ok:false,error:error?.message||String(error)}))
    .finally(()=>{if(frozenRateEnsurePromises.get(target)===promise)frozenRateEnsurePromises.delete(target);});
  frozenRateEnsurePromises.set(target,promise);
  return promise;
}

async function buildGameOverlayData(store,realm,globalState){
  // The production page can have a valid building payload while the realm
  // mirror has not yet materialized `buildings`. Bootstrap the realm-local
  // frozen production plans from that authoritative captured endpoint before
  // calculating the overlay. This never uses remaining cycle amount as output.
  let workingStore=store||{};
  let frozenPlan=workingStore?.frozenNetworkPlan&&Number(workingStore.frozenNetworkPlan.realm)===Number(realm)?workingStore.frozenNetworkPlan:null;
  if(!frozenPlan){
    // When the sync already captured complete, rated production plans, do not
    // make the first Stock overlay wait for another round of building-history
    // requests. buildGameOverlayData can reconstruct the network directly from
    // those authoritative plans and save a frozen plan after the first paint.
    const authoritativePlans=Object.values(workingStore?.productionPlans||{}).filter(p=>p&&String(p.product||'').trim()&&p.mode!=='disabled');
    const canBootstrapFromStoredPlans=authoritativePlans.length>0 && authoritativePlans.every(p=>Number(p.baseRatePerLevel)>0);
    if(!canBootstrapFromStoredPlans){
      try{await ensureFrozenProductionRatesForRealm(Number(realm));}catch{}
    }
    const latest=await state();
    const key=realmKeyFromRealm(Number(realm));
    workingStore={...(latest.realmStores?.[key]||workingStore)};
    if(Number(realm)===validRealmNumber(latest.activeRealmKey!=null?String(latest.activeRealmKey).replace('realm:',''):latest.selectedRealm)){
      workingStore={...latest,...workingStore};
    }
    frozenPlan=workingStore?.frozenNetworkPlan&&Number(workingStore.frozenNetworkPlan.realm)===Number(realm)?workingStore.frozenNetworkPlan:null;
  }
  store=workingStore;
  const assets=await gameOverlayAssets();const warehouse=Array.isArray(store?.warehouseResources)?store.warehouseResources:[];const grouped=overlayWarehouseRows(warehouse);
  
  const frozenHours=Math.max(1,Number(frozenPlan?.hours)||overlayProductionRunHours(store));const companyModifier=overlayCompanyProductionModifier(store);const core=globalThis.SCMPlannerCore;
  const planEntries=frozenPlan?.buildingPlans&&typeof frozenPlan.buildingPlans==='object'?Object.values(frozenPlan.buildingPlans):[];const eventMap={};for(const entry of planEntries){const name=String(entry?.product||'').trim();if(name)eventMap[assets.normalizeName(name)]=overlayActiveProductionEventModifier(store,name);}
  const currentSignature=core?.frozenPlanSignature&&planEntries.length?core.frozenPlanSignature(planEntries,frozenHours,{companyProductionModifier:companyModifier,events:eventMap,speedFormula:OVERLAY_SPEED_FORMULA}):'';
  const authoritativePlans=Object.values(store?.productionPlans||{}).filter(p=>p&&String(p.product||'').trim()&&p.mode!=='disabled');
  const authoritativeIds=new Set(authoritativePlans.map(p=>Number(p.buildingId)).filter(n=>Number.isFinite(n)&&n>0));
  const frozenIds=new Set(planEntries.map(p=>Number(p?.buildingId)).filter(n=>Number.isFinite(n)&&n>0));
  const liveConfiguredIds=new Set((Array.isArray(store?.buildings)?store.buildings:[]).filter(b=>b&&String(b?.category||'').toLowerCase()==='production'&&String(b?.busy?.resource?.name||'').trim()).map(b=>Number(b.id)).filter(n=>Number.isFinite(n)&&n>0));
  const planIdMismatch=[...new Set([...authoritativeIds,...liveConfiguredIds])].some(id=>!frozenIds.has(id));
  const unratedAuthoritative=authoritativePlans.some(p=>!(Number(p.baseRatePerLevel)>0));
  const hasUsableFrozenPlan=Boolean(frozenPlan&&Array.isArray(frozenPlan.productionRows)&&frozenPlan.productionRows.length&&Array.isArray(frozenPlan.demandRows)&&Array.isArray(frozenPlan.activeSpecs)&&frozenPlan.activeSpecs.length&&!planIdMismatch&&!unratedAuthoritative&&String(frozenPlan.signature||'')===currentSignature);
  const recipeByProduct=new Map((Array.isArray(assets.recipes)?assets.recipes:[]).map(r=>[assets.normalizeName(r.name),r]));
  const buildings=realmStoredBuildings(store,globalState,realm);
  let productionRows=[],demandRows=[],activeSpecs=[],networkWasBootstrapped=false;
  if(hasUsableFrozenPlan){productionRows=frozenPlan.productionRows.map(x=>({...x}));demandRows=frozenPlan.demandRows.map(x=>({...x}));activeSpecs=frozenPlan.activeSpecs.map(x=>({...x}));}
  else{
    const specs=[];const sourcePlans=planEntries.length?planEntries:(store?.productionPlans?Object.values(store.productionPlans):[]);const speedFactor=companyModifier<100?1/(1-companyModifier/100):0;const oldFormulaPlan=planEntries.length&&frozenPlan?.modifiers?.speedFormula!==OVERLAY_SPEED_FORMULA;const authoritativeBase=new Map(Object.values(store?.productionPlans||{}).filter(p=>Number(p?.baseRatePerLevel)>0).map(p=>[`${Number(p.buildingId)}|${assets.normalizeName(p.product)}`,Number(p.baseRatePerLevel)]));
    for(const rawEntry of sourcePlans){const entry=rawEntry||{};const b=buildings.find(x=>Number(x?.id)===Number(entry?.buildingId));const product=String(entry?.product||'').trim();if(!product)continue;const recipe=recipeByProduct.get(assets.normalizeName(product));if(!recipe)continue;const productId=Number(entry?.productId||recipe.id);if(!(productId>0))continue;const level=Math.min(20,Math.max(1,Number(entry?.plannedLevel)||overlayBuildingLevel(b)));const quality=Math.max(0,Number(entry?.quality)||0);const eventModifier=overlayActiveProductionEventModifier(store,product);const rateBase=(oldFormulaPlan&&authoritativeBase.get(`${Number(entry?.buildingId)}|${assets.normalizeName(product)}`))||Number(entry?.baseRatePerLevel);const perHour=rateBase>0?rateBase*level*(1+eventModifier/100)*speedFactor:null;if(!(perHour>0))continue;specs.push({buildingId:Number(entry.buildingId),product,productId,quality,level,ratePerHour:perHour,recipe,source:'realm frozen plan'});}
    const network=core?.productionBalance?core.productionBalance(specs,recipeByProduct,frozenHours,assets.names):{hours:frozenHours,productionRows:[],demandRows:[],activeSpecs:[]};productionRows=Array.isArray(network.productionRows)?network.productionRows:[];demandRows=Array.isArray(network.demandRows)?network.demandRows:[];activeSpecs=Array.isArray(network.activeSpecs)?network.activeSpecs:[];networkWasBootstrapped=activeSpecs.length>0&&productionRows.length>0;
    if(networkWasBootstrapped){const rebuiltEvents={};for(const x of specs)rebuiltEvents[assets.normalizeName(x.product)]=overlayActiveProductionEventModifier(store,x.product);const rebuiltPlans=Object.fromEntries(specs.map(x=>[String(x.buildingId),{buildingId:x.buildingId,product:x.product,productId:x.productId,resourceId:x.productId,quality:x.quality,plannedLevel:x.level,baseRatePerLevel:Number(x.ratePerHour)/(Math.max(1,Number(x.level)||1)*(1+overlayActiveProductionEventModifier(store,x.product)/100)*speedFactor),mode:'live'}]));const signature=core?.frozenPlanSignature?core.frozenPlanSignature(Object.values(rebuiltPlans),frozenHours,{companyProductionModifier:companyModifier,events:rebuiltEvents,speedFormula:OVERLAY_SPEED_FORMULA}):JSON.stringify({hours:frozenHours,plans:rebuiltPlans});try{await saveFrozenNetworkPlanSnapshot({realm:Number(realm),signature,plan:{hours:frozenHours,productionRows,demandRows,activeSpecs,buildingPlans:rebuiltPlans,plannerState:frozenPlan?.plannerState||null,modifiers:{companyProductionModifier:companyModifier,events:rebuiltEvents,speedFormula:OVERLAY_SPEED_FORMULA},resources:Array.isArray(network.resources)?network.resources:[],deficits:Array.isArray(network.deficits)?network.deficits:[],surpluses:Array.isArray(network.surpluses)?network.surpluses:[]}});}catch{}}
  }
  // The overlay is driven only by Manager-saved contracts. Never fall back to
  // `store.contracts`: that field contains captured live API contracts and must
  // not silently become an overlay input when savedContracts is absent.
  const savedContracts=Array.isArray(store?.savedContracts)?store.savedContracts:[];
  const warehouseRowsForCore=grouped.map(r=>({id:r.id,quality:r.quality,amount:r.qty}));
  const productionSurplusByKey=core?.productionSurplusByKey?core.productionSurplusByKey(productionRows,demandRows):new Map();

  // Establish the stock-after-demand baseline without any saved contracts. Left
  // quantities must be derived from this current input balance, never from the
  // previous snapshot's `difference` (which already includes the same contract).
  const baseCoreRows=core?.balanceSupplyDemandContracts
    ?core.balanceSupplyDemandContracts({warehouseRows:warehouseRowsForCore,productionRows,demandRows,includeQualityRows:true})
    :[];
  const baseDetailRows=Array.isArray(baseCoreRows?.qualityRows)&&baseCoreRows.qualityRows.length?baseCoreRows.qualityRows:baseCoreRows;
  const baseBalanceByKey=new Map();
  for(const row of baseDetailRows){
    const id=Number(row?.id),quality=Number(row?.quality)||0;
    if(!Number.isFinite(id)||id<=0)continue;
    const fallback=(Number(row?.warehouse)||0)-(Number(row?.demand)||0);
    const balance=Number.isFinite(Number(row?.warehouseOnlyLeft))?Number(row.warehouseOnlyLeft):fallback;
    baseBalanceByKey.set(`${id}:${quality}`,balance);
  }
  // Warehouse-only keys can be absent from the demand allocation rows. Preserve
  // their current quantity as the baseline rather than reading any old overlay.
  for(const row of grouped){
    const key=`${Number(row.id)}:${Number(row.quality)||0}`;
    if(!baseBalanceByKey.has(key))baseBalanceByKey.set(key,Math.max(0,Number(row.qty)||0));
  }
  const effectiveSavedQuantities=core?.resolveSavedContractQuantities
    ?core.resolveSavedContractQuantities({savedContracts,baseBalanceByKey,surplusByKey:productionSurplusByKey})
    :new Map();
  const effectiveSavedQty=(c,id,quality)=>{
    if(effectiveSavedQuantities.has(c))return Math.max(0,Number(effectiveSavedQuantities.get(c))||0);
    const mode=String(c?.quantityMode||'custom').trim().toLowerCase();
    if(mode==='surplus')return Math.max(0,Number(productionSurplusByKey.get(`${id}:${quality}`))||0);
    if(mode==='left')return Math.max(0,Number(baseBalanceByKey.get(`${id}:${quality}`))||0);
    const q=Number(c?.quantity);return Number.isFinite(q)&&q>0?q:0;
  };
  const contractRows=[];
  const incomingByKey=new Map();
  const outgoingByKey=new Map();
  const savedContractKeys=new Set();
  for(const c of savedContracts){
    const direction=String(c?.direction||'').trim().toLowerCase();
    if(direction!=='incoming'&&direction!=='outgoing')continue;
    const raw=String(c?.product??'').trim();
    const parsed=raw.match(/^(\d+)(?::(\d+))?$/);
    const id=Number(c?.productId!=null?c.productId:(parsed?parsed[1]:null));
    const quality=Math.max(0,Number(c?.quality!=null?c.quality:(parsed?parsed[2]:0))||0);
    if(!(Number.isFinite(id)&&id>0))continue;
    const key=`${id}:${quality}`;
    savedContractKeys.add(key);
    const amount=effectiveSavedQty(c,id,quality);
    if(!(Number.isFinite(amount)&&amount>0))continue;
    if(direction==='outgoing'){
      contractRows.push({id,quality,amount});
      outgoingByKey.set(key,(outgoingByKey.get(key)||0)+amount);
    }else{
      incomingByKey.set(key,(incomingByKey.get(key)||0)+amount);
    }
  }
  // Deliberately do not read live SimCompanies outgoing-contract endpoints here.
  // Once sent, those resources are already absent from warehouse stock; including
  // those contracts would double-count them and corrupt the stock-after-demand overlay.
  const coreRows=core?.balanceSupplyDemandContracts?core.balanceSupplyDemandContracts({warehouseRows:warehouseRowsForCore,productionRows,demandRows,contractRows,includeQualityRows:true}):[];
  let detailRows=Array.isArray(coreRows?.qualityRows)&&coreRows.qualityRows.length?coreRows.qualityRows:coreRows;
  // Incoming contracts add stock; outgoing contracts consume stock. The core
  // planner models contract consumption, so apply the incoming side as a
  // signed adjustment after the common demand/outgoing allocation.
  const detailByKey=new Map(detailRows.map(r=>[`${Number(r.id)}:${Number(r.quality)||0}`,r]));
  for(const [key,amount] of incomingByKey){
    if(detailByKey.has(key))continue;
    const [idText,qText]=key.split(':');
    const id=Number(idText),quality=Number(qText)||0;
    // Incoming is added exactly once later when the signed Left value is built.
    detailRows.push({id,quality,warehouse:0,produced:0,demand:0,contracted:0,leftover:0,warehouseOnlyLeft:0});
  }
  const networkResourceIds=new Set([...productionRows,...demandRows,...contractRows,...[...incomingByKey.keys()].map(k=>Number(k.split(':')[0]))].map(r=>Number(r?.id??r)).filter(Number.isFinite));
  // Production ownership is a resource+quality mapping. Resource ID alone is
  // not enough because a company may produce Q3 while consuming the same
  // resource at Q1/Q2. The overlay must never surface those input qualities as
  // if they were company-produced outputs.
  const producedResourceQualities=new Set((productionRows||[]).map(r=>{const id=Number(r?.id),quality=Math.max(0,Number(r?.quality??r?.minQuality)||0);return Number.isFinite(id)&&id>0?`${id}:${quality}`:null;}).filter(Boolean));
  // Copy prices read the active realm's existing Market-page caches only.
  // Prefer the consolidated current-price rows, then fill missing keys from
  // the keyed per-product cache. Never issue a request or use VWAP as price.
  const overlayMarketRows=Array.isArray(store?.liveMarketPriceData?.rows) &&
    Number(store?.liveMarketPriceData?.realm)===Number(realm)
    ? store.liveMarketPriceData.rows : [];
  const overlayMarketByKey=new Map();
  for(const v of overlayMarketRows){
    const id=Number(v?.resourceId), quality=Number(v?.quality), value=Number(v?.price);
    if(!Number.isFinite(id)||id<=0||!Number.isFinite(quality)||!(value>0))continue;
    overlayMarketByKey.set(`${id}:${quality}`,value);
  }
  // A product detail can be present in liveMarketProductCache before its row
  // appears in liveMarketPriceData.rows. Use only its selected current price,
  // with exact resource+quality validation; deliberately ignore vwap fields.
  const overlayProductCache=store?.liveMarketProductCache&&typeof store.liveMarketProductCache==='object'
    ? store.liveMarketProductCache : {};
  for(const [cacheKey,product] of Object.entries(overlayProductCache)){
    const id=Number(product?.resourceId), quality=Number(product?.quality);
    const expectedKey=`${id}:${quality}`;
    if(!Number.isFinite(id)||id<=0||!Number.isFinite(quality)||String(cacheKey)!==expectedKey)continue;
    if(overlayMarketByKey.has(expectedKey))continue;
    const value=Number(product?.selected?.price);
    if(Number.isFinite(value)&&value>0)overlayMarketByKey.set(expectedKey,value);
  }
  const overlayImageStore=await resourceImagesStore();
  const rows=detailRows.map(r=>{
    const file=assets.images[String(r.id)];
    // v2.5.327: never embed base64 images in the overlay payload when the game URL is known.
    const local=file?'':(overlayImageStore.cache?.[String(r.id)]||store?.resourceImageCache?.[String(r.id)]||store?.resourceImageData?.[String(r.id)]||'');
    const name=String(assets.names.get(String(r.id))||grouped.find(x=>Number(x.id)===Number(r.id))?.name||`Resource #${r.id}`);
    const quality=Number(r.quality)||0;
    const key=`${Number(r.id)}:${quality}`;
    const outgoing=Number(outgoingByKey.get(key)||0);
    const incoming=Number(incomingByKey.get(key)||0);
    const netContracts=outgoing-incoming;
    // Left is actual warehouse stock after full planned demand, with Manager-saved
    // incoming commitments added once. Live outgoing game contracts never affect it.
    const left=(Number(r.warehouseOnlyLeft)||0)+incoming;
    let marketPrice=overlayMarketByKey.get(key)??null,marketPriceQuality=marketPrice!=null?quality:null;
    if(marketPrice==null){
      const alternatives=[...overlayMarketByKey.entries()].map(([k,price])=>{const match=k.match(/^(\d+):(\d+)$/);return match&&Number(match[1])===Number(r.id)?{quality:Number(match[2]),price:Number(price)}:null;}).filter(x=>x&&Number.isFinite(x.quality)&&x.price>0).sort((a,b)=>Math.abs(a.quality-quality)-Math.abs(b.quality-quality)||a.quality-b.quality);
      if(alternatives.length){marketPrice=alternatives[0].price;marketPriceQuality=alternatives[0].quality;}
    }
    const vwap=overlayVwap(store,r.id,quality,realm);
    // 2.5.347 production surplus for this resource+quality (game-page Sell helper "Surplus").
    const surplus=Math.max(0,Number(productionSurplusByKey.get(key))||0);
    return {...r,contracted:netContracts,incoming,outgoing,leftover:left,difference:left,warehouseOnlyLeft:left,surplus,name,quality,vwap,marketPrice,marketPriceQuality,marketPriceExact:marketPriceQuality===quality,image:local||(file?`${assets.imageBase}${file}`:'')};
  }).filter(r=>{
    const key=`${Number(r.id)}:${Number(r.quality)||0}`;
    // Show every produced resource quality plus every resource/quality explicitly
    // referenced by a Manager-saved contract. Captured live API contracts are not
    // read for quantity, visibility, or inventory-impact calculations.
    const visibleByOwnership=producedResourceQualities.has(key)||savedContractKeys.has(key);
    const hasMaterialChange=Math.abs(Number(r.produced)||0)>1e-9||Math.abs(Number(r.demand)||0)>1e-9||Math.abs(Number(r.contracted)||0)>1e-9||Math.abs(Number(r.leftover)||0)>1e-9;
    return visibleByOwnership && hasMaterialChange;
  });
  const ticker=rows.map(r=>({...r,qty:r.warehouse,cost:null}));const sellingHistory=mergeSellingHistory(store);
  const savedContractsSignature=JSON.stringify(savedContracts.map(c=>[c?.id,c?.direction,c?.product,c?.quality,c?.quantity,c?.quantityMode,c?.price,c?.savedAt]));
  return {realm:Number(realm),ticker,rows,tickerSource:hasUsableFrozenPlan?'frozen-realm-network':'frozen-realm-network-rebuilt',contractSource:'manager-saved-contracts-only',savedContractsSignature,sellingHistory:Object.values(sellingHistory),updatedAt:new Date().toISOString(),demandHorizonHours:frozenHours,networkWasBootstrapped,plannedOutputRows:productionRows.length,plannedDemandRows:demandRows.length};
}

// VWAP status belongs to the realm that generated it. Never store VWAP status
// in a shared root slot where an R1 refresh can overwrite R2 (or vice versa).
// The unlocked variant is used by functions already inside the API storage
// commit lane; the public wrapper serializes standalone VWAP status writes.
async function setVwapStatusUnlocked(patch={}, realmArg=null){
  const hinted=realmArg!=null?realmArg:(patch?.vwapRealm??null);
  const hintedRealm=validRealmNumber(hinted);
  const s=await state(hintedRealm);
  const realm=validRealmNumber(hintedRealm ?? realmNumberFromKey(s.activeRealmKey||identityFromAuth(s.authData)));
  if(realm==null)return;
  const currentStore=await state(realm);
  const current=currentStore.vwapStatus||DEFAULTS.vwapStatus;
  const next={...current,...patch,vwapRealm:realm,updatedAt:new Date().toISOString()};
  await commitLatestRealmPatch(realm,{vwapStatus:next},['vwapStatus']);
}

async function setVwapStatus(patch={}, realmArg=null){
  const hinted=realmArg!=null?realmArg:(patch?.vwapRealm??null);
  const s=await state();
  const realm=validRealmNumber(hinted ?? realmNumberFromKey(s.activeRealmKey||identityFromAuth(s.authData)));
  if(realm==null)return;
  return withRealmWriteLock(realm,()=>setVwapStatusUnlocked(patch,realm));
}

function identityFromAuth(auth){const c=auth?.authCompany||{}; return realmKeyFromRealm(c.realmId);}
function defaultRealmValue(key){
  if(key==='buildings'||key==='warehouseResources'||key==='backgroundJobHistory') return [];
  if(key==='apiEndpoints') return [];
  if(['endpointData','marketCache','marketDebug','liveMarketData','liveMarketProduct','liveMarketProductCache','resourceImageData','resourceImageCache','resourceImageMeta','resourceImageCacheStatus','history','contracts','savedContracts','contractEvents','accountingCapture','accountingSnapshots','tickerSnapshots','sellingHistory','accountingWeekSales','accountingWeekSalesSummary','warehouseCostDetails','realmQuarantine','productionRateSnapshots'].includes(key)) return {};
  if(key==='productionEvents') return [];
  if(key==='gameOverlaySnapshot') return null;
  if(key==='gameLocalStorageSnapshot') return null;
  if(key==='criticalDataBaseline') return {...DEFAULTS.criticalDataBaseline};
  if(key==='marketQueueStatus') return {...DEFAULTS.marketQueueStatus};
  if(key==='buildingAlarms'||key==='productionEventMonitor'||key==='resourceImageCacheStatus') return {};
  if(key==='accountingWeekLedgerStatus') return null;
  if(key==='accountingDayWalkStatus') return null;
  if(key==='accountingDailySeries') return null;
  if(key==='accountingWeekRevision') return 0;
  if(key==='vwapLegacyDiscarded') return false;
  if(key==='productionRunHours') return 24;
  if(key==='marketQueue') return [];
  if(['marketQueueCursor'].includes(key)) return 0;
  if(['syncStatus'].includes(key)) return 'No sync data stored for this realm';
  if(key==='vwapStatus') return {...DEFAULTS.vwapStatus};
  if(key==='vwapWatch') return {...DEFAULTS.vwapWatch};
  return null;
}
async function activateRealmByRealmUnlocked(realm, authData=null){
  const nextKey=realmKeyFromRealm(realm); if(!nextKey)return false;
  const meta=await chrome.storage.local.get({activeRealmKey:null});
  const currentKey=typeof meta.activeRealmKey==='string'?meta.activeRealmKey:null;
  const targetState=await state(realm);
  const target={...(targetState.realmStores?.[nextKey]||{})};
  if(authData) target.authData=authData;
  target.activeRealmIdentity={realm:Number(realm)};
  // Realm stores are already authoritative. Switching realms must not read,
  // merge, or rewrite the other physical container. Commit only the target
  // realm plus the tiny global activation metadata.
  await storageSet({realmStores:{[nextKey]:sanitizeRealmStore(target,Number(realm))},activeRealmKey:nextKey,selectedRealm:Number(realm)});
  return currentKey!==nextKey;
}

async function activateRealmByRealm(realm, authData=null){
  return enqueueApiStorage(()=>activateRealmByRealmUnlocked(realm,authData),validRealmNumber(realm));
}

// Game-initiated realm detection must never wait on the shared API/storage
// commit lane. The target realm already has its own authoritative physical
// container, so auto-follow only needs to flip the tiny global activation
// metadata. Verified/manual realm activation continues to use the full
// serialized path above.
let autoRealmActivationQueue=Promise.resolve();
function activateRealmByRealmFast(realm, authData=null){
  const n=validRealmNumber(realm);
  if(n==null)return Promise.resolve(false);
  // IMPORTANT: this path may run from an auth-data response while another
  // realm-local API writer is committing contracts/VWAP. The old
  // implementation read the entire physical realm store and wrote that stale
  // snapshot back with rawStorageSet, which could silently erase fields that
  // had just been captured. Auto-activation is metadata-only; auth-data itself
  // is persisted by saveData() through the normal realm write lane.
  const job=autoRealmActivationQueue.catch(()=>{}).then(async()=>{
    const nextKey=realmKeyFromRealm(n);
    if(!nextKey)return false;
    return withRealmWriteLock(n,async()=>{
      const meta=await chrome.storage.local.get({activeRealmKey:null});
      const currentKey=typeof meta.activeRealmKey==='string'?meta.activeRealmKey:null;
      await rawStorageSet({activeRealmKey:nextKey,selectedRealm:n});
      return currentKey!==nextKey;
    });
  });
  autoRealmActivationQueue=job.catch(()=>{});
  return job;
}

function filterEndpointDataForRealm(value, realm){
  const n=validRealmNumber(realm);
  if(!value||typeof value!=='object'||Array.isArray(value)||n==null)return value&&typeof value==='object'&&!Array.isArray(value)?{...value}:value;
  const out={};
  for(const [url,entry] of Object.entries(value)){
    if(!entry||typeof entry!=='object'){out[url]=entry;continue;}
    const cr=validRealmNumber(entry.captureRealm);
    if(cr!=null&&cr!==n)continue;
    out[url]=entry;
  }
  return out;
}
function filterApiEndpointsForRealm(value, realm){
  const n=validRealmNumber(realm);
  const arr=Array.isArray(value)?value:[];
  if(n==null)return arr.slice();
  return arr.filter(entry=>{
    const cr=validRealmNumber(entry?.captureRealm);
    return cr==null||cr===n;
  });
}
function realmStoredBuildings(store, globalState, realm){
  if(Array.isArray(store?.buildings)&&store.buildings.length)return store.buildings;
  const endpointData=store?.endpointData&&typeof store.endpointData==='object'?store.endpointData:{};
  for(const [url,entry] of Object.entries(endpointData)){
    if(!/\/api\/v2\/companies\/(?:me|\d+)\/buildings\/?$/i.test(String(url||'')))continue;
    const status=Number(entry?.status)||0;
    if(status<200||status>=300)continue;
    const data=entry?.data;
    const rows=Array.isArray(data)?data:(['buildings','data','items','results'].map(k=>Array.isArray(data?.[k])?data[k]:null).find(Boolean)||[]);
    if(rows.length)return rows;
  }
  const rootRealm=validRealmNumber(globalState?.activeRealmKey!=null?String(globalState.activeRealmKey).replace('realm:',''):globalState?.selectedRealm);
  if(rootRealm===Number(realm)&&Array.isArray(globalState?.buildings)&&globalState.buildings.length)return globalState.buildings;
  return [];
}

function sanitizeRealmStore(store, realm){
  const n=validRealmNumber(realm);
  if(n==null||!store||typeof store!=='object')return store&&typeof store==='object'?{...store}:{};
  const next={...store};
  // state() exposes a synthetic realmStores wrapper for compatibility with the
  // rest of the Manager. That wrapper is NEVER data belonging inside one
  // physical realm store. Strip it at every read/write boundary so it cannot
  // recursively serialize the Manager state into itself.
  delete next.realmStores;
  if(Object.prototype.hasOwnProperty.call(next,'endpointData'))next.endpointData=filterEndpointDataForRealm(next.endpointData,n);
  if(Object.prototype.hasOwnProperty.call(next,'apiEndpoints'))next.apiEndpoints=filterApiEndpointsForRealm(next.apiEndpoints,n);
  const authRealm=validRealmNumber(next.authData?.authCompany?.realmId??next.authData?.authCompany?.realm??next.authData?.realmId??next.authData?.realm);
  if(authRealm!=null&&authRealm!==n)next.authData=null;
  const gameRealm=validRealmNumber(next.gameState?.realm);
  if(gameRealm!=null&&gameRealm!==n)next.gameState=null;
  return next;
}

let realmMigrationPromise=null;
let realmStorageMigrationChecked=false;
async function ensureRealmStorageMigration(){
  if(realmStorageMigrationChecked) return true;
  if(realmMigrationPromise) return realmMigrationPromise;
  realmMigrationPromise=(async()=>{
    const s=await stateAllRealms();
    const physicalProbe=await chrome.storage.local.get({'scmRealmStore:0':null,'scmRealmStore:1':null});
    const physicalReady=Boolean((physicalProbe['scmRealmStore:0']&&typeof physicalProbe['scmRealmStore:0']==='object')||(physicalProbe['scmRealmStore:1']&&typeof physicalProbe['scmRealmStore:1']==='object'));
    if(Number(s.realmIsolationSchemaVersion||0)>=REALM_ISOLATION_SCHEMA && physicalReady){
      const cleanStores={...(s.realmStores||{})};
      const extractedPlannerStates={};
      const extractedOverlaySnapshots={};
      let storesChanged=false;
      for(const [key,raw] of Object.entries(cleanStores)){
        const r=realmNumberFromKey(key);
        if(r==null){ delete cleanStores[key]; storesChanged=true; continue; }
        const clean=sanitizeRealmStore(raw,r);
        if(raw?.productionPlannerState&&typeof raw.productionPlannerState==='object'){const p=sanitizeProductionPlannerState(raw.productionPlannerState,r);if(p)extractedPlannerStates[productionPlannerStateStorageKey(r)]=p;}
        if(raw?.gameOverlaySnapshot&&typeof raw.gameOverlaySnapshot==='object'){extractedOverlaySnapshots[gameOverlaySnapshotStorageKey(r)]=raw.gameOverlaySnapshot;}
        if(JSON.stringify(clean)!==JSON.stringify(raw)){cleanStores[key]=clean;storesChanged=true;}
      }
      if(storesChanged) await storageSet({realmStores:cleanStores});
      if(Object.keys(extractedPlannerStates).length||Object.keys(extractedOverlaySnapshots).length){try{await rawStorageSet({...extractedPlannerStates,...extractedOverlaySnapshots});}catch{}}
      // Physical realm stores are authoritative in schema v12+. A leftover
      // root realmStores blob is stale legacy data and must not remain available
      // to any future fallback path or storage export.
      try{
        const legacyRoot=await chrome.storage.local.get({realmStores:null});
        if(legacyRoot?.realmStores&&typeof legacyRoot.realmStores==='object') await chrome.storage.local.remove('realmStores');
      }catch{}
      const activeRealm=validRealmNumber(s.activeRealmKey?.replace(/^realm:/,'')??s.selectedRealm??s.authData?.authCompany?.realmId);
      if(activeRealm!=null){
        const key=realmKeyFromRealm(activeRealm);
        const target={...(s.realmStores?.[key]||{})};
        // Enforce realm identity on persisted VWAP snapshots even after the
        // migration has already run. No unmarked VWAP dataset is accepted.
        if(target.vwapData){
          const vr=validRealmNumber(target.vwapData.sourceRealm??target.vwapData.warehouseRealm);
          if(vr!==activeRealm){
            const stores={...(s.realmStores||{})};
            stores[key]={...target}; delete stores[key].vwapData;
            await storageSet({realmStores:stores});
          }
        }
      }
      return;
    }
    const oldStores=s.realmStores&&typeof s.realmStores==='object'?s.realmStores:{};
    const migrated={};
    for(const [rawKey,value] of Object.entries(oldStores)){
      const m=String(rawKey).match(/^(?:realm:)?(\d+)(?::\d+)?$/);
      const next=m?realmKeyFromRealm(Number(m[1])):rawKey;
      if(!next) continue;
      migrated[next]={...(migrated[next]||{}),...(value&&typeof value==='object'?value:{})};
    }
    // Root auth/game-state mirrors are no longer part of normal Manager state.
    // Read only these two legacy metadata fields when an old installation needs
    // them to identify the initial realm; never load the legacy cache blob here.
    const legacyRootMeta=(s.activeRealmKey||s.selectedRealm!=null)?{}:await chrome.storage.local.get({authData:null,gameState:null});
    const rootRealm=validRealmNumber(legacyRootMeta.authData?.authCompany?.realmId??legacyRootMeta.authData?.authCompany?.realm??legacyRootMeta.gameState?.realm??s.activeRealmKey?.replace(/^realm:/,'' )??s.selectedRealm);
    // Preserve only user-authored saved contracts from legacy realm stores and
    // discard untrusted runtime mirrors that may have been produced before the
    // strict isolation boundary. A fresh Sync repopulates the runtime data for
    // each realm without risking an old R1/R2 collision.
    const strictKeysToKeep=['savedContracts'];
    const migratedPlannerStates={};
    const migratedOverlaySnapshots={};
    for(const [key,storeRaw] of Object.entries(migrated)){
      const store={};
      for(const k of strictKeysToKeep){
        if(Object.prototype.hasOwnProperty.call(storeRaw,k)) store[k]=storeRaw[k];
      }
      const storeRealm=realmNumberFromKey(key);
      const oldPlanner=storeRaw?.productionPlannerState||storeRaw?.frozenNetworkPlan?.plannerState;
      const legacyPlannerSource={...(oldPlanner&&typeof oldPlanner==='object'?oldPlanner:{}),runHours:storeRaw?.productionRunHours??oldPlanner?.runHours};
      if(storeRaw?.productionRunHours!=null || (oldPlanner&&typeof oldPlanner==='object')){const planner=sanitizeProductionPlannerState(legacyPlannerSource,storeRealm);if(planner)migratedPlannerStates[productionPlannerStateStorageKey(storeRealm)]=planner;}
      if(storeRaw?.gameOverlaySnapshot&&typeof storeRaw.gameOverlaySnapshot==='object'&&validRealmNumber(storeRaw.gameOverlaySnapshot.realm)===storeRealm){migratedOverlaySnapshots[gameOverlaySnapshotStorageKey(storeRealm)]=storeRaw.gameOverlaySnapshot;}
      const oldVwap=storeRaw?.vwapData;
      const oldVwapRealm=validRealmNumber(oldVwap?.sourceRealm??oldVwap?.warehouseRealm);
      if(oldVwap && oldVwapRealm!=null && oldVwapRealm===storeRealm){
        // Do not carry the old snapshot forward automatically; it remains
        // available only after a fresh realm-local VWAP sync establishes it.
        store.vwapLegacyDiscarded=true;
      }
      store.realmIsolationNote='Strict realm isolation reset; Sync required for runtime data.';
      migrated[key]=store;
    }
    if(rootRealm!=null){
      const key=realmKeyFromRealm(rootRealm);
      if(key){
        const target={...(migrated[key]||{})};
        // Legacy root data is ambiguous unless the root identity itself proves
        // the realm. Even then, runtime state is intentionally not copied into
        // the clean store; this prevents any historical shared cache from being
        // silently reintroduced.
        migrated[key]=target;
      }
    }
    const selected=validRealmNumber(s.selectedRealm??rootRealm);
    const active=validRealmNumber(s.activeRealmKey?.replace(/^realm:/,'')??rootRealm??selected);
    const patch={realmStores:migrated,realmIsolationSchemaVersion:REALM_ISOLATION_SCHEMA,activeRealmKey:active!=null?realmKeyFromRealm(active):null,selectedRealm:selected!=null?selected:null};
    // Clear every realm-scoped root mirror. It will be rehydrated from the
    // selected realm store by activateRealmByRealm below.
    for(const k of REALM_SCOPED_KEYS) patch[k]=defaultRealmValue(k);
    await storageSet(patch);
    // Physical realm stores are now authoritative. Remove the old monolithic
    // realmStores blob so future writes cannot keep serializing it.
    try{ await chrome.storage.local.remove('realmStores'); }catch{}
    // Migration can be reached from an API-storage transaction (for example
    // the first API_DATA after service-worker startup). Calling the queued
    // activateRealmByRealm() here would make that transaction wait on itself.
    // The migration already owns the one-time storage rewrite, so use the
    // unlocked activation primitive directly.
    if(active!=null) await activateRealmByRealmUnlocked(active);
    if(Object.keys(migratedPlannerStates).length||Object.keys(migratedOverlaySnapshots).length){try{await rawStorageSet({...migratedPlannerStates,...migratedOverlaySnapshots});}catch{}}
  })().then(result=>{realmStorageMigrationChecked=true;return result;}).finally(()=>{realmMigrationPromise=null;});
  return realmMigrationPromise;
}
async function simTab(){const tabs=await chrome.tabs.query({url:['https://www.simcompanies.com/*','https://simcompanies.com/*']});return tabs.find(t=>t.active)||tabs[0]||null}
async function activeSimCompaniesTab(){
  const tabs=await chrome.tabs.query({active:true,lastFocusedWindow:true,url:['https://www.simcompanies.com/*','https://simcompanies.com/*']});
  return tabs?.[0]||null;
}
async function requestActiveGameRealm(reason='tab-activated'){
  try{
    const tab=await activeSimCompaniesTab();
    if(!tab?.id)return {ok:false,skipped:true,reason:'no-active-game-tab'};
    try{await chrome.tabs.sendMessage(tab.id,{type:'PAGE_GAME_STATE'});}catch{}
    return {ok:true,tabId:tab.id,reason};
  }catch(e){return {ok:false,error:e?.message||String(e),reason};}
}
function useful(url){return USEFUL_PATTERNS.some(r=>r.test(url))}
function isRealmSensitiveAccountingUrl(url){return /\/api\/(?:v2\/companies\/(?:me|\d+)\/(?:balance-sheet|cashflow(?:\/(?:recent|\d+))?|cashflow-statement|income-statement|past-finances-overview|administration-overhead)|v3\/companies\/(?:me|\d+)\/past-finances)(?:\/(?:day|week|month)\/\d+)?(?:\/\d+)?\/?(?:\?.*)?$/i.test(String(url||''));}

// API_SEEN and API_DATA can arrive almost simultaneously from the game page.
// Serialize their storage transactions so one response cannot overwrite the
// warehouse/endpoint data written by another response that was captured a
// moment earlier. This is especially important during the 5-page UI Sync.
const apiStorageQueues=new Map();
const apiStorageCommitQueues=new Map();
const apiStorageSchedulers=new Map();
function shouldPersistPassiveApiCaptureDuringSync(session,url,method='GET'){
  if(!session||session.phase!=='running'||String(method||'GET').toUpperCase()!=='GET')return true;
  const allowed=Array.isArray(session.capturePaths)?session.capturePaths:[];
  return allowed.includes(String(url||''));
}
function enqueueApiStorageCommit(task,realm=null){
  const key=validRealmNumber(realm)!=null?`realm:${validRealmNumber(realm)}`:'unscoped';
  const previous=apiStorageCommitQueues.get(key)||Promise.resolve();
  const run=previous.then(task,task);
  const queueTail=run.catch(()=>{});
  apiStorageCommitQueues.set(key,queueTail);
  queueTail.then(()=>{if(apiStorageCommitQueues.get(key)===queueTail)apiStorageCommitQueues.delete(key)});
  return run;
}
// Prioritize durable Sync writes over queued unrelated passive captures. Keep
// durable jobs FIFO and never overtake a queued job for the same URL, so an
// older response cannot overwrite a newly verified endpoint record.
function enqueueApiStorage(task,realm=null,options={}){
  const key=validRealmNumber(realm)!=null?`realm:${validRealmNumber(realm)}`:'unscoped';
  let scheduler=apiStorageSchedulers.get(key);
  if(!scheduler){
    scheduler={queue:[],running:false,idlePromise:Promise.resolve(),resolveIdle:null};
    apiStorageSchedulers.set(key,scheduler);
  }
  if(!scheduler.running&&!scheduler.queue.length){
    scheduler.idlePromise=new Promise(resolve=>{scheduler.resolveIdle=resolve;});
  }
  const job={task,realm,priority:Boolean(options?.priority),url:String(options?.url||''),resolve:null,reject:null};
  const result=new Promise((resolve,reject)=>{job.resolve=resolve;job.reject=reject;});
  if(job.priority){
    let insertAt=scheduler.queue.findIndex(item=>!item.priority);
    if(insertAt<0)insertAt=scheduler.queue.length;
    let lastSameUrl=-1;
    if(job.url)for(let i=0;i<scheduler.queue.length;i++)if(scheduler.queue[i].url===job.url)lastSameUrl=i;
    if(lastSameUrl>=0)insertAt=Math.max(insertAt,lastSameUrl+1);
    scheduler.queue.splice(insertAt,0,job);
  }else scheduler.queue.push(job);
  apiStorageQueues.set(key,scheduler.idlePromise);
  if(!scheduler.running)runApiStorageScheduler(key,scheduler);
  return result;
}
async function runApiStorageScheduler(key,scheduler){
  if(scheduler.running)return;
  scheduler.running=true;
  try{
    while(scheduler.queue.length){
      const job=scheduler.queue.shift();
      try{job.resolve(await enqueueApiStorageCommit(job.task,job.realm));}
      catch(error){job.reject(error);}
    }
  }finally{
    scheduler.running=false;
    if(!scheduler.queue.length){
      scheduler.resolveIdle?.();
      if(apiStorageQueues.get(key)===scheduler.idlePromise)apiStorageQueues.delete(key);
    }else runApiStorageScheduler(key,scheduler);
  }
}
// Barrier, not "wait until idle": resolve once every job queued before this
// call has committed. Passive game captures keep arriving while the player
// browses, so waiting for a fully idle queue could starve Sync (R2 2.5.377:
// "API storage queue drain timed out after 20 seconds" on a 5.9 MB store).
function apiStorageQueueForRealm(realm){
  const n=validRealmNumber(realm);
  const scheduler=apiStorageSchedulers.get(`realm:${n}`);
  if(!scheduler||(!scheduler.running&&!scheduler.queue.length))return Promise.resolve();
  return enqueueApiStorage(async()=>{},n,{url:'scm:queue-barrier'}).catch(()=>{});
}
function accountingWeekRefreshAlarmName(realm){
  const n=validRealmNumber(realm);
  return n==null?null:`${ACCOUNTING_WEEK_REFRESH_ALARM_PREFIX}${n}`;
}
async function scheduleAccountingWeekRefresh(realm,delayMs=1500){
  const n=validRealmNumber(realm);
  const name=accountingWeekRefreshAlarmName(n);
  if(n==null||!name)return {ok:false,error:'Invalid accounting realm.'};
  try{
    const current=await state(n);
    const store=current?.realmStores?.[realmKeyFromRealm(n)]||{};
    const boundary=accountingWeekStart(store);
    const recentRows=store?.endpointData?.['/api/v2/companies/me/cashflow/recent/']?.data?.data;
    if(accountingWeekLedgerCacheComplete(store,boundary,recentRows))return {ok:true,scheduled:false,skipped:true,realm:n,reason:'current-week-ledger-cache-complete'};
    const existing=await chrome.alarms.get(name);
    if(existing?.when && Number(existing.when)>Date.now()) return {ok:true,scheduled:true,existing:true,realm:n};
    await chrome.alarms.create(name,{when:Date.now()+Math.max(500,Number(delayMs)||1500)});
    return {ok:true,scheduled:true,existing:false,realm:n};
  }catch(e){return {ok:false,error:e?.message||String(e),realm:n};}
}
function syncSessionForRealm(realm){
  const n=validRealmNumber(realm);
  return n==null?null:(realmSyncSessions.get(n)||null);
}
function currentCaptureSyncSession(){
  return validRealmNumber(syncCaptureRealm)!=null?syncSessionForRealm(syncCaptureRealm):null;
}

async function saveEndpointUnlocked(url,method='GET',captureRealm=null,commit=true,baseState=null){
  if(!url?.startsWith('/api/'))return;
  const n=validRealmNumber(captureRealm);
  if(n==null){
    await appendRealmQuarantine(null,'apiSeen',{url,method:String(method||'GET').toUpperCase(),reason:'No capture realm'});
    return;
  }
  const key=realmKeyFromRealm(n);
  // API_SEEN is explicitly tagged with the realm that produced the network
  // request. Never read the active-realm-only state snapshot here: a late R2
  // API_SEEN while R1 is active must update only R2. Reading state() here can
  // create a partial R2 store and write it back, silently erasing contracts,
  // VWAP, buildings, and warehouse data. A supplied baseState is
  // accepted only when it actually contains the target physical realm.
  const s=(baseState&&baseState.realmStores?.[key])?baseState:await state(n);
  const stores={...(s.realmStores||{})};
  const store={...(stores[key]||{})};
  const list=Array.isArray(store.apiEndpoints)?store.apiEndpoints.slice():[];
  const normalizedMethod=String(method||'GET').toUpperCase();
  const i=list.findIndex(x=>x.url===url&&String(x.method||'GET').toUpperCase()===normalizedMethod);
  const item={url,method:normalizedMethod,useful:useful(url),seenAt:new Date().toISOString(),captureRealm:n};
  if(i>=0)list[i]={...list[i],...item}; else list.push(item);
  list.sort((a,b)=>new Date(b.seenAt)-new Date(a.seenAt));
  store.apiEndpoints=list.slice(0,1000);
  stores[key]=store;
  const activeKey=s.activeRealmKey||identityFromAuth(s.authData);
  if(!commit)return {ok:true,realm:n,key,store};
  const patch={realmStores:stores};
  if(!currentCaptureSyncSession() && activeKey===key) patch.apiEndpoints=store.apiEndpoints;
  await storageSet(patch);
  return {ok:true,realm:n,key,store};
}
async function saveEndpoint(url,method='GET',captureRealm=null){
  return enqueueApiStorage(()=>saveEndpointUnlocked(url,method,captureRealm),captureRealm);
}
// v2.5.361 performance: every request the game makes (dozens per page) sent API_SEEN, and each one rewrote the whole
// realm store (~1 MB) just to stamp "seen at" in the endpoint list, which also pushed that store to every open page.
// Now seen endpoints are collected for 20 s and written once; an endpoint already listed and seen in the last 10 min is
// not written again.
const pendingEndpointSeen=new Map();let pendingEndpointSeenTimer=0;
function queueEndpointSeen(url,method='GET',captureRealm=null){
  const n=validRealmNumber(captureRealm);
  if(n==null||!String(url||'').startsWith('/api/'))return saveEndpoint(url,method,captureRealm); // quarantine path unchanged
  const m=String(method||'GET').toUpperCase();pendingEndpointSeen.set(`${n}|${m}|${url}`,{url,method:m,realm:n});
  if(!pendingEndpointSeenTimer)pendingEndpointSeenTimer=setTimeout(()=>{pendingEndpointSeenTimer=0;flushEndpointSeen().catch(()=>{});},20000);
  return Promise.resolve();
}
async function flushEndpointSeen(){
  const byRealm=new Map();for(const v of pendingEndpointSeen.values()){if(!byRealm.has(v.realm))byRealm.set(v.realm,[]);byRealm.get(v.realm).push(v);}
  pendingEndpointSeen.clear();
  for(const [n,items] of byRealm){
    await enqueueApiStorage(async()=>{
      const s0=await state(n);const key=realmKeyFromRealm(n);
      const list=Array.isArray(s0.realmStores?.[key]?.apiEndpoints)?s0.realmStores[key].apiEndpoints:[];
      const fresh=items.filter(i=>{const e=list.find(x=>x.url===i.url&&String(x.method||'GET').toUpperCase()===i.method);return !e||Date.now()-Date.parse(e.seenAt||0)>10*60e3;});
      if(!fresh.length)return {ok:true,skipped:true};
      let base=s0,last=null;
      for(const i of fresh){last=await saveEndpointUnlocked(i.url,i.method,n,false,base);if(last?.store)base={...base,realmStores:{...(base.realmStores||{}),[last.key]:last.store}};}
      if(!last?.store)return {ok:false};
      const patch={realmStores:{...(s0.realmStores||{}),[key]:last.store}};
      const activeKey=s0.activeRealmKey||identityFromAuth(s0.authData);
      if(!currentCaptureSyncSession()&&activeKey===key)patch.apiEndpoints=last.store.apiEndpoints;
      await storageSet(patch);
      return {ok:true,written:fresh.length};
    },n);
  }
}
function isResourceUrl(url){return /\/api\/v3\/resources\/(\d+)(?:\/|\?|$)/.test(String(url||''))}
function resourceIdFromUrl(url){const m=String(url||'').match(/\/api\/v3\/resources\/(\d+)(?:\/|\?|$)/);return m?Number(m[1]):null}
function marketIdFromUrl(url){const m=String(url||'').match(/^\/api\/v3\/market(?:\/all)?\/(\d+)\/(\d+)\/?(?:\?.*)?$/);return m?{realm:Number(m[1]),resource:Number(m[2])}:null}
function normalizeWarehouse(data){
  const clean=a=>Array.isArray(a)?a.filter(x=>x&&typeof x==='object'):[];
  if(Array.isArray(data)) return clean(data);
  for(const k of ['warehouseResources','resources','inventory','stocks','items','data','warehouse','materials','finishedGoods','wip']){
    if(Array.isArray(data?.[k])) return clean(data[k]);
  }
  const seen=new Set();
  const walk=v=>{
    if(!v||typeof v!=='object'||seen.has(v))return [];
    seen.add(v);
    if(Array.isArray(v)){
      const rows=clean(v);
      if(rows.length && rows.some(x=>x && (x.kind!=null||x.resourceId!=null||x.productId!=null) && (x.quality!=null||x.q!=null) && (x.amount!=null||x.quantity!=null||x.qty!=null||x.units!=null))) return rows;
      for(const x of rows){const r=walk(x);if(r.length)return r;}
      return [];
    }
    for(const x of Object.values(v)){const r=walk(x);if(r.length)return r;}
    return [];
  };
  return walk(data);
}
function warehouseId(x){
  const v=x?.kind ?? x?.resource ?? x?.resourceId ?? x?.productId ?? x?.resourceKind ?? x?.dbLetter;
  if(v&&typeof v==='object') return Number(v.kind ?? v.resourceId ?? v.productId ?? v.id);
  return Number(v);
}
function warehouseQuality(x){
  const v=x?.quality ?? x?.q ?? x?.resourceQuality ?? x?.itemQuality;
  if(v&&typeof v==='object') return Number(v.quality ?? v.q ?? v.value);
  return Number(v);
}
function warehouseQuantity(x){
  const v=x?.amount ?? x?.quantity ?? x?.qty ?? x?.units ?? x?.count ?? x?.resourceQuantity ?? x?.productQuantity ?? x?.stock ?? x?.inventory ?? x?.quantityInWarehouse ?? x?.amountInWarehouse ?? x?.available;
  if(v&&typeof v==='object') return Number(v.amount ?? v.quantity ?? v.qty ?? v.units ?? v.count ?? v.value);
  return Number(v);
}
function warehouseKey(x){
  const id=warehouseId(x);
  const q=warehouseQuality(x);
  return Number.isFinite(id)&&Number.isFinite(q)?`${id}:${q}`:null;
}
function mergeWarehouseSnapshot(incomingRows, previousRows){
  // A fresh game/API warehouse snapshot defines which resource/quality rows
  // currently exist. Preserve richer cost objects from the previous snapshot
  // for matching rows, but never carry stale rows forward.
  const incoming=Array.isArray(incomingRows)?incomingRows:[];
  const previous=Array.isArray(previousRows)?previousRows:[];
  const prevByKey=new Map();
  for(const row of previous){ const key=warehouseKey(row); if(key) prevByKey.set(key,row); }
  return incoming.map(row=>{
    const old=prevByKey.get(warehouseKey(row));
    if(!old) return {...row};
    const merged={...row};
    const hasValue=v=>v!==undefined&&v!==null&&!(typeof v==='string'&&!v.trim());
    if(old.cost!=null && !hasValue(row.cost)) merged.cost=old.cost;
    else if(old.cost&&typeof old.cost==='object'&&!Array.isArray(old.cost)&&row.cost&&typeof row.cost==='object'&&!Array.isArray(row.cost))
      merged.cost={...old.cost,...Object.fromEntries(Object.entries(row.cost).filter(([k,v])=>hasValue(v)))};
    for(const k of ['sourcingCost','totalCost','unitCost','averageCost']) if(!hasValue(merged[k])&&hasValue(old[k])) merged[k]=old[k];
    return merged;
  });
}
function looksLikeWarehouseRows(rows){
  if(!Array.isArray(rows)||!rows.length) return false;
  const sample=rows.filter(x=>x&&typeof x==='object').slice(0,80);
  if(!sample.length) return false;
  const matches=sample.filter(x=>{
    const kind=warehouseId(x);
    const qty=warehouseQuantity(x);
    const q=warehouseQuality(x);
    return Number.isFinite(kind)&&kind>0&&Number.isFinite(qty)&&qty>=0&&Number.isFinite(q);
  }).length;
  return matches>=Math.max(1,Math.ceil(sample.length*0.35));
}
function resourceImageHint(data){
  const seen=new Set();
  const walk=v=>{
    if(!v||typeof v!=='object'||seen.has(v))return null; seen.add(v);
    if(Array.isArray(v)){for(const x of v){const r=walk(x);if(r)return r;}return null;}
    for(const [k,x] of Object.entries(v)){
      if(/^(image|icon|iconUrl|imageUrl|picture|img)$/i.test(k) && typeof x==='string' && x.trim()) return x.trim();
    }
    for(const x of Object.values(v)){const r=walk(x);if(r)return r;}
    return null;
  };
  return walk(data);
}
async function saveMarketCache(resource, value, receivedAt, capturedRealm=null){
  if(!resource || !value) return;
  const initial=await state();
  const realm=validRealmNumber(capturedRealm) ?? validRealmNumber(realmNumberFromKey(initial.activeRealmKey||identityFromAuth(initial.authData)));
  if(realm==null){
    const q={...(initial.realmQuarantine||{}),marketCache:Array.isArray(initial.realmQuarantine?.marketCache)?initial.realmQuarantine.marketCache.slice(-199):[]};
    q.marketCache.push({resource:Number(resource),receivedAt:receivedAt||new Date().toISOString(),reason:'No capture realm'});
    await storageSet({realmQuarantine:q});
    return;
  }
  return withRealmWriteLock(realm,async()=>{
    const s=await state(realm);
    const key=realmKeyFromRealm(realm);
    const stores={...(s.realmStores||{})};
    const store={...(stores[key]||{})};
    // Never replace a known-good page cache with an empty/non-market payload.
    if(!hasUsableMarketRows(value) && hasUsableMarketRows(store.marketCache?.[String(resource)]?.data)) return;
    const marketCache={...(store.marketCache||{}),[String(resource)]:{data:value,receivedAt:receivedAt||new Date().toISOString(),source:'page-localStorage',captureRealm:realm}};
    stores[key]={...store,marketCache};
    const activeKey=s.activeRealmKey||identityFromAuth(s.authData);
    if(activeKey===key) await storageSet({marketCache,realmStores:stores});
    else await storageSet({realmStores:stores});
  });
}
async function saveResourceCatalog(catalog, receivedAt){
  if(!catalog||typeof catalog!=='object')return;
  const s=await state();
  const realm=realmNumberFromKey(s.activeRealmKey||identityFromAuth(s.authData)); if(realm==null)return;
  return withRealmWriteLock(realm,async()=>{
    const latest=await state(realm); const key=realmKeyFromRealm(realm);
    const stores={...(latest.realmStores||{})}; const store={...(stores[key]||{})};
    const old=store.resourceCatalog&&typeof store.resourceCatalog==='object'?store.resourceCatalog:{};
    const merged={...old,...catalog,receivedAt:receivedAt||new Date().toISOString()};
    merged.constantsResources=catalog.constantsResources||old.constantsResources||{};
    merged.resourceNames={...(old.resourceNames||{}),...(catalog.resourceNames||{})};
    merged.resourceImages={...(old.resourceImages||{}),...(catalog.resourceImages||{})};
    store.resourceCatalog=merged; stores[key]=store;
    const patch={realmStores:stores}; if(key===latest.activeRealmKey) patch.resourceCatalog=merged;
    await storageSet(patch);
  });
}
function diagnosticCostFields(row){
  if(!row || typeof row!=='object') return null;
  const fields=['quantity','quality','cost','sourcingCost','totalCost','unitCost','averageCost'];
  const out={};
  for(const k of fields) out[k]=Object.prototype.hasOwnProperty.call(row,k)?row[k]:null;
  return out;
}
function warehouseCostFieldStates(row){
  const fields=['quantity','quality','cost','sourcingCost','totalCost','unitCost','averageCost'];
  const states={};
  for(const key of fields){
    if(!Object.prototype.hasOwnProperty.call(row||{},key)){states[key]='not-captured';continue;}
    const value=row[key];
    if(value===null||value===undefined){states[key]='null';continue;}
    const numeric=typeof value==='number'?value:(typeof value==='string'?Number(value.replace(/[$,%\\s,]/g,'')):NaN);
    states[key]=Number.isFinite(numeric)?(numeric===0?'zero':'value'):'unparseable';
  }
  return states;
}
function collectWarehouseCostDiagnostics(s){
  const out=[];
  const add=(rows,source)=>{
    if(!Array.isArray(rows)) return;
    for(const row of rows){
      if(!row || typeof row!=='object') continue;
      const id=Number(row.kind??row.resourceId??row.productId??row.resource);
      const q=Number(row.quality??row.q);
      if(!Number.isFinite(id)||!Number.isFinite(q)) continue;
      out.push({source,resourceId:id,quality:q,fields:diagnosticCostFields(row),fieldStates:warehouseCostFieldStates(row)});
    }
  };
  add(s.warehouseResources,'stored warehouseResources');
  add(s.gameState?.region?.warehouseResources,'gameState.region.warehouseResources');
  for(const [url,item] of Object.entries(s.endpointData||{})){
    if(!/\/api\/v3\/resources\/\d+(?:\/|\?|$)/i.test(url)) continue;
    add(normalizeWarehouse(item?.data),`API ${url}`);
  }
  return out;
}
async function saveWarehouseCostDetail(message){
  const s=await state();
  const realm=validRealmNumber(message?.realm ?? realmNumberFromKey(s.activeRealmKey||identityFromAuth(s.authData)));
  const key=realm!=null?realmKeyFromRealm(realm):(s.activeRealmKey||identityFromAuth(s.authData));
  if(!key) return {ok:false,error:'No active realm for warehouse cost detail.'};
  const resourceId=Number(message?.resourceId), quality=Number(message?.quality), quantity=Number(message?.quantity), unitCost=Number(message?.unitCost);
  if(!Number.isFinite(resourceId)||resourceId<=0||!Number.isFinite(unitCost)||unitCost<0) return {ok:false,error:'Invalid warehouse cost detail.'};
  return withRealmWriteLock(realm,async()=>{
    const latest=await state(realm); const stores={...(latest.realmStores||{})}; const store={...(stores[key]||{})};
    const details={...(store.warehouseCostDetails||{})};
    const idKey=String(resourceId);
    const list=Array.isArray(details[idKey])?details[idKey].slice():[];
    const item={resourceId,quality:Number.isFinite(quality)?quality:null,quantity:Number.isFinite(quantity)?quantity:null,unitCost,url:String(message?.url||''),capturedAt:message?.capturedAt||new Date().toISOString()};
    const match=i=>i.quality===item.quality && (item.quantity==null || i.quantity==null || i.quantity===item.quantity);
    const idx=list.findIndex(match);
    if(idx>=0) list[idx]=item; else list.push(item);
    details[idKey]=list.slice(-10);
    store.warehouseCostDetails=details; stores[key]=store;
    const patch={realmStores:stores}; if(key===latest.activeRealmKey) patch.warehouseCostDetails=details;
    await storageSet(patch);
    return {ok:true,item};
  });
}


async function saveProductionEvents(message){
  await ensureRealmStorageMigration();
  const preview=await state();
  const realm=validRealmNumber(message?.realm ?? realmNumberFromKey(preview.activeRealmKey||identityFromAuth(preview.authData)));
  if(realm==null)return {ok:false,error:'No realm for production events.'};
  return withRealmWriteLock(realm,async()=>{
    const s=await state(realm);
    const key=realmKeyFromRealm(realm);
    const incoming=Array.isArray(message?.events)?message.events:[];
    const now=Date.now();
    const normalized=incoming.map(e=>({
      resourceId:Number.isFinite(Number(e?.resourceId))?Number(e.resourceId):null,
      resourceName:String(e?.resourceName||'').trim(),
      modifier:Number(e?.modifier)||0,
      untilText:String(e?.untilText||'').trim(),
      expiresAt:Number.isFinite(Number(e?.expiresAt))?Number(e.expiresAt):null,
      capturedAt:e?.capturedAt||new Date().toISOString()
    })).filter(e=>e.resourceName || e.resourceId!=null);
    const active=normalized.filter(e=>e.expiresAt==null || e.expiresAt>now);
    const stores={...(s.realmStores||{})};
    const store={...(stores[key]||{})};
    store.productionEvents=active;
    stores[key]=store;
    const patch={realmStores:stores};
    if(key===s.activeRealmKey)patch.productionEvents=active;
    await storageSet(patch);
    scheduleGameOverlayRefreshNotification(realm);
    return {ok:true,realm,events:active};
  });
}

function buildSyncDiagnosticCheckpoint(fields){
  const completedAt=typeof fields?.finishedAt==='string'&&fields.finishedAt.trim()?fields.finishedAt:null;
  const existingDiagnostic=completedAt&&fields?.existingDiagnostic&&typeof fields.existingDiagnostic==='object'?fields.existingDiagnostic:{};
  return {
    ...existingDiagnostic,
    realm:fields?.realm??null,
    mode:'api-first-sync-with-ui-fallback',
    status:fields?.status??null,
    syncError:fields?.syncError??null,
    // Once finalization has assigned a completion timestamp, the checkpoint
    // must not overwrite it with the stale in-progress null value. Use the
    // exact same timestamp for lastSync and finishedAt.
    lastSync:completedAt||fields?.lastSync||null,
    startedAt:fields?.startedAt??null,
    finishedAt:completedAt,
    endpointCount:Number(fields?.endpointCount)||0,
    warehouseRows:Number(fields?.warehouseRows)||0,
    syncPolicy:fields?.syncPolicy??existingDiagnostic.syncPolicy??null,
    syncTrace:Array.isArray(fields?.syncTrace)?fields.syncTrace.slice(-120):[]
  };
}

async function saveFullSyncDiagnosticUnlocked(diagnostic, realm){
  const n=validRealmNumber(realm);
  const s=n!=null?await state(n):await state();
  const key=n!=null?realmKeyFromRealm(n):(s.activeRealmKey||identityFromAuth(s.authData));
  const diagnosticRealm=n??realmNumberFromKey(key);
  const storeForDiagnostic=key?(s.realmStores?.[key]||{}):s;
  const diagnosticState={...s,...storeForDiagnostic};
  const d={...(diagnostic||{}),realm:diagnosticRealm,realmDisplay:realmDisplayNumber(diagnosticRealm),realmName:realmDisplayName(diagnosticRealm),capturedAt:new Date().toISOString(),warehouseCosts:collectWarehouseCostDiagnostics(diagnosticState)};
  if(diagnosticRealm==null) return d;
  const diagnosticKey=realmDiagnosticStorageKey(diagnosticRealm);
  if(!diagnosticKey) return d;
  await rawStorageSet({[diagnosticKey]:d,scmRealmDiagnosticSchema:1});
  return d;
}


async function saveFullSyncDiagnostic(diagnostic, realm){
  // Diagnostics are observability data, not part of the hot API/realm storage
  // transaction. Persist directly to the realm-specific diagnostic key so a
  // diagnostic checkpoint can never block Sync completion behind API storage.
  return saveFullSyncDiagnosticUnlocked(diagnostic,validRealmNumber(realm));
}

async function saveGameStateUnlocked(message) {
  const messageRealm=Number(message?.realm);
  const targetKey=Number.isFinite(messageRealm)?realmKeyFromRealm(messageRealm):null;
  const s=targetKey?await state(messageRealm):await state();
  const activeKey=s.activeRealmKey||identityFromAuth(s.authData);
  // GAME_STATE already carries an explicit realm. Never let a late response
  // from the other realm overwrite the active company's warehouse.
  if(targetKey && activeKey && targetKey!==activeKey){
    const target={...(s.realmStores?.[targetKey]||{})};
    if(Array.isArray(message?.warehouseResources)){
      target.warehouseResources=mergeWarehouseSnapshot(message.warehouseResources,target.warehouseResources);
      target.warehouseCapture={source:'game-localStorage-merged',rows:target.warehouseResources.length,incomingRows:message.warehouseResources.length,receivedAt:new Date().toISOString()};
    }
    if(Array.isArray(message?.buildings)&&message.buildings.length) target.buildings=message.buildings;
    if(message?.region&&typeof message.region==='object') target.gameState={realm:messageRealm,region:message.region,receivedAt:new Date().toISOString()};
    const stores={...(s.realmStores||{}),[targetKey]:target};
    await storageSet({realmStores:stores});
    return {ok:true,warehouse:message?.warehouseResources?.length||0,storedRealm:messageRealm,activeRealm:activeKey?Number(String(activeKey).replace('realm:','')):null};
  }
  if(targetKey && (!activeKey || activeKey===targetKey)) await activateRealmByRealmUnlocked(messageRealm);
  const fresh=await state();
  const warehouse = Array.isArray(message?.warehouseResources) ? message.warehouseResources : null;
  const buildings = Array.isArray(message?.buildings) ? message.buildings : null;
  const region = message?.region && typeof message.region === 'object' ? message.region : null;
  const patch = {};
  if (warehouse) {
    // Once the game has supplied a current /api/v3/resources/<companyId>/
    // response, use that response as the authoritative set of inventory
    // resource/quality keys. The game's localStorage snapshot can retain stale
    // rows after a quality is removed; merging that snapshot as authoritative
    // would re-introduce those rows (for example an old EC quality).
    // Preserve any richer cost fields from the local snapshot for matching
    // rows, but never let localStorage add keys absent from the API snapshot.
    // A fresh game-localStorage snapshot is the fastest live stock signal.
    // Do not wait for, or overwrite it with, an older API snapshot: doing that
    // made newly gathered resources appear late in the Manager. The API capture
    // remains authoritative for later reconciliation/enrichment in saveData().
    patch.warehouseResources=mergeWarehouseSnapshot(warehouse,fresh.warehouseResources);
    const warehouseCapturedAt=new Date().toISOString();
    const priorCapture=fresh.warehouseCapture||{};
    const priorSource=String(priorCapture.source||'');
    const priorWasApiAuthoritative=/api-authoritative|api-enriched|overlay-live-resources/i.test(priorSource)||priorCapture.apiCostProtected===true;
    if(priorWasApiAuthoritative && Array.isArray(fresh.warehouseResources)){
      // Once an authoritative resource-API snapshot exists, keep the complete
      // matching API row together: quantity + cost + quality. A GAME_STATE row
      // can be newer as a message, yet still be an older/stale stock snapshot.
      // Mixing its quantity with API cost produces false unit costs (for example
      // 3x-stale quantities turn a correct ~$0.20/unit cost into ~$0.60).
      const apiByKey=new Map(fresh.warehouseResources.map(row=>[warehouseKey(row),row]));
      patch.warehouseResources=patch.warehouseResources.map(row=>apiByKey.get(warehouseKey(row))||row);
      patch.warehouseResources=mergeWarehouseSnapshot(fresh.warehouseResources,patch.warehouseResources);
    }
    patch.warehouseCapture={source:priorWasApiAuthoritative?'api-authoritative-merged':'game-localStorage-live',rows:patch.warehouseResources.length,incomingRows:warehouse.length,gameStateCapturedAt:warehouseCapturedAt,receivedAt:warehouseCapturedAt,apiCostProtected:priorWasApiAuthoritative,apiQuantityProtected:priorWasApiAuthoritative};
  }
  if (buildings && buildings.length) patch.buildings = buildings;
  if (region) patch.gameState = {realm:messageRealm??null, region, receivedAt:new Date().toISOString()};
  if (Object.keys(patch).length) {
    // The realm container is authoritative after split-sync. Update it first
    // and mirror the same patch to the active root; never copy the root back
    // into the realm store from this path. This also prevents a late game-page
    // snapshot from resurrecting stale data after an API-first sync.
    const latest=targetKey?await state(messageRealm):await state();
    const latestActiveKey=latest.activeRealmKey||identityFromAuth(latest.authData);
    const key=targetKey||latestActiveKey;
    if(key){
      const stores={...(latest.realmStores||{})};
      stores[key]={...(stores[key]||{}),...patch};
      const rootPatch=key===latestActiveKey?{...patch}:{ };
      await storageSet({realmStores:stores,...rootPatch});
      if (key===latestActiveKey && (warehouse || buildings)) scheduleGameOverlayRefreshNotification(realmNumberFromKey(key),150);
    } else {
      await storageSet(patch);
      if (warehouse || buildings) scheduleGameOverlayRefreshNotification(realmNumberFromKey(key),150);
    }
  }
  return {ok:true, warehouse:Array.isArray(warehouse)?warehouse.length:0};
}

async function saveGameState(message){
  await ensureRealmStorageMigration();
  const preview=await state();
  const realm=validRealmNumber(message?.realm ?? realmNumberFromKey(preview.activeRealmKey||identityFromAuth(preview.authData)));
  if(realm==null)return saveGameStateUnlocked(message);
  return withRealmWriteLock(realm,()=>saveGameStateUnlocked(message));
}

function realmNumberFromKey(key){const m=String(key||'').match(/^realm:(\d+)$/);return m?Number(m[1]):null;}
function companyIdFromUrl(url){
  const m=String(url||'').match(/\/api\/v(?:1|2|3|4)\/(?:companies|resources|warehouse-contracts-summary)\/(\d+)(?:\/|$)/i);
  return m?Number(m[1]):null;
}
function knownRealmForCompanyId(s,companyId){
  const id=Number(companyId); if(!Number.isFinite(id))return null;
  const stores=s.realmStores||{};
  for(const [key,store] of Object.entries(stores)){
    const cid=Number(store?.authData?.authCompany?.companyId||store?.authData?.authCompany?.id);
    if(Number.isFinite(cid)&&cid===id)return realmNumberFromKey(key);
  }
  const activeCid=Number(s.authData?.authCompany?.companyId||s.authData?.authCompany?.id);
  const activeRealm=realmNumberFromKey(s.activeRealmKey||identityFromAuth(s.authData));
  if(Number.isFinite(activeCid)&&activeCid===id)return activeRealm;
  return null;
}
function knownRealmForBuildingId(s,buildingId){
  const id=Number(buildingId); if(!Number.isFinite(id)||id<=0)return null;
  const stores=s.realmStores||{};
  for(const [key,store] of Object.entries(stores)){
    const realm=realmNumberFromKey(key);
    if(realm==null)continue;
    const rows=realmStoredBuildings(store,s,realm);
    if(rows.some(b=>Number(b?.id)===id))return realm;
    const plans=store?.productionPlans&&typeof store.productionPlans==='object'?Object.values(store.productionPlans):[];
    if(plans.some(b=>Number(b?.buildingId)===id))return realm;
    const snaps=store?.productionRateSnapshots&&typeof store.productionRateSnapshots==='object'?Object.values(store.productionRateSnapshots):[];
    if(snaps.some(b=>Number(b?.buildingId)===id))return realm;
  }
  return null;
}
function endpointRealmFromUrl(url){
  const text=String(url||'');
  const patterns=[
    /\/api\/v3\/contracts-incoming\/(\d+)\/me(?:\/|\?|$)/i,
    /\/api\/v3\/market\/(\d+)\//i,
    /\/api\/v4\/(\d+)\/resources-retail-info\//i,
    /\/api\/v2\/production-modifiers\/(\d+)\//i,
    /\/api\/v1\/realm\/(\d+)(?:\/|$)/i
  ];
  for(const rx of patterns){const m=text.match(rx);if(m)return validRealmNumber(m[1]);}
  return null;
}
async function setRealmLoadStatus(realm,status,error=null,globalIfActive=true){
  const n=validRealmNumber(realm);
  if(n==null)return;
  return enqueueApiStorage(async()=>{
    const s=await state(n);
    const activeKey=s.activeRealmKey||identityFromAuth(s.authData);
    const targetKey=realmKeyFromRealm(n);
    const stores={...(s.realmStores||{})};
    const current={...(stores[targetKey]||{})};
    const isLiveSyncStatus=/^R[12]\s+Sync(?:\b|:)/i.test(String(status||''))||/Sync interrupted|Sync failed/i.test(String(status||''));
    const completion=!isLiveSyncStatus?(current.lastSync||resolvedSyncCompletion(current,n)):null;
    stores[targetKey]={...current,syncStatus:status,syncError:error,...(completion?{lastSync:completion}:{})};
    const patch={syncStatus:status,syncError:error};
    if(globalIfActive && activeKey===targetKey){
      if(completion)patch.lastSync=completion;
      await storageSet({...patch,realmStores:stores});
    } else {
      await storageSet({realmStores:stores});
    }
  },n);
}

async function setFullSyncJob(realm, patch={}){
  const n=validRealmNumber(realm); if(n==null)return;
  return enqueueApiStorage(async()=>{
    const key=realmKeyFromRealm(n);
    const s=await state(n);
    const current=(s.realmStores?.[key]?.fullSyncJob&&typeof s.realmStores[key].fullSyncJob==='object')?s.realmStores[key].fullSyncJob:{};
    const job={...current,...patch,realm:n,updatedAt:new Date().toISOString()};
    const stores={...(s.realmStores||{}),[key]:{...(s.realmStores?.[key]||{}),fullSyncJob:job}};
    const rootPatch=key===s.activeRealmKey?{fullSyncJob:job}:{};
    await storageSet({realmStores:stores,...rootPatch});
    return job;
  },n);
}

async function clearFullSyncJob(realm, finalPatch={}){
  const n=validRealmNumber(realm); if(n==null)return;
  return enqueueApiStorage(async()=>{
    const key=realmKeyFromRealm(n);
    const s=await state(n);
    const stores={...(s.realmStores||{}),[key]:{...(s.realmStores?.[key]||{}),fullSyncJob:null,...finalPatch}};
    const rootPatch=key===s.activeRealmKey?{fullSyncJob:null,...finalPatch}:{};
    await storageSet({realmStores:stores,...rootPatch});
  },n);
}

async function recoverInterruptedSyncJobs(reason='service-worker-restart'){
  try{
    return await enqueueApiStorage(async()=>{
      // Discover candidates, but never commit this snapshot. Each realm is
      // re-read and patched inside the serialized realm-storage commit so a
      // delayed recovery pass cannot overwrite newer sync/API data.
      const snapshot=await stateAllRealms();
      const candidates=[];
      for(const [key,raw] of Object.entries(snapshot.realmStores||{})){
        const realm=realmNumberFromKey(key);
        if(realm==null||raw?.fullSyncJob?.status!=='running') continue;
        const started=Date.parse(String(raw.fullSyncJob.startedAt||''));
        if(Number.isFinite(started)&&Date.now()-started<5*60*1000) continue;
        candidates.push(realm);
      }
      for(const realm of candidates){
        const latest=await state(realm);
        const job=latest.fullSyncJob;
        if(!job||job.status!=='running') continue;
        const started=Date.parse(String(job.startedAt||''));
        if(Number.isFinite(started)&&Date.now()-started<5*60*1000) continue;
        const status=`${realmDisplayNumber(realm)||'Realm'} Sync interrupted · retry required`;
        const patch={fullSyncJob:null,syncStatus:status,syncError:'The previous sync transaction was interrupted before completion.'};
        await storageSetRealmPatch(realm,patch);
        if(latest.activeRealmKey===realmKeyFromRealm(realm)){
          await storageSet({syncStatus:status,syncError:patch.syncError,fullSyncJob:null});
        }
      }
      return {ok:true};
    });
  }catch(e){ return {ok:false,error:e?.message||String(e),reason}; }
}
const ACCOUNTING_SYNC_PATHS=[
  '/api/v2/companies/me/balance-sheet/',
  '/api/v2/companies/me/cashflow/recent/',
  '/api/v2/companies/me/cashflow-statement/',
  '/api/v2/companies/me/income-statement/',
  '/api/v2/companies/me/past-finances-overview/',
  '/api/v2/companies/me/administration-overhead/',
  '/api/v3/companies/me/past-finances/'
];
const ACCOUNTING_REFRESH_MAX_AGE_MS=5*60*1000;
const ACCOUNTING_REFRESH_CONCURRENCY=4;
const ACCOUNTING_WEEK_REFRESH_ALARM_PREFIX='scm-accounting-week-refresh-r';
// v2.5.370 After Sync, walk the game's Accounting page: Day → day buttons 0–6 (the game offers 0–13). Each tap counts
// only when the game's own /income-statement/day/<n>/ response is captured for this realm. Buttons are found by the
// page structure (period bar = <label> + 4 mode buttons + 14 day buttons), never by their text (dates are locale text).
const ACCOUNTING_DAY_WALK_ALARM_PREFIX='scm-accounting-day-walk-r';
const ACCOUNTING_DAY_WALK_DAYS=7;
const ACCOUNTING_DAY_WALK_WAIT_MS=45000;
const accountingDayWalkRunning=new Set();
// v2.5.371 Daily scheduled Accounting walk (user setting scmAccountingWalkSchedule {enabled, offsetMin, realm}).
// Runs offsetMin after the time the game last finished the daily statements (the captured current income
// statement's `date`), so it follows the game's rollover (and daylight-saving changes) instead of a fixed clock.
const ACCOUNTING_WALK_DAILY_ALARM='scm-accounting-walk-daily';
const ACCOUNTING_WALK_RETRY_MS=15*60*1000;
const ACCOUNTING_WALK_MAX_ATTEMPTS=4;
const ACCOUNTING_WALK_DEFAULT_OFFSET_MIN=30;
function accountingWalkOffset(v){const n=Math.round(Number(v));return Number.isFinite(n)?Math.min(240,Math.max(5,n)):ACCOUNTING_WALK_DEFAULT_OFFSET_MIN;}
async function readAccountingWalkSchedule(){
  const v=(await chrome.storage.local.get({scmAccountingWalkSchedule:null})).scmAccountingWalkSchedule;
  return {enabled:false,offsetMin:ACCOUNTING_WALK_DEFAULT_OFFSET_MIN,realm:null,...(v&&typeof v==='object'?v:{})};
}
async function writeAccountingWalkSchedule(patch){
  const cur=await readAccountingWalkSchedule();
  const next={...cur,...patch,updatedAt:new Date().toISOString()};
  await chrome.storage.local.set({scmAccountingWalkSchedule:next});
  return next;
}
// End time of the last completed game day for this realm (current income statement `date`), or null.
async function accountingStatementsReadyAt(realm){
  const n=validRealmNumber(realm); if(n==null)return null;
  const st=(await chrome.storage.local.get({[`scmRealmStore:${n}`]:null}))[`scmRealmStore:${n}`]||{};
  let best=null;
  for(const p of ['/api/v2/companies/me/income-statement/','/api/v2/companies/me/income-statement/day/0/']){
    const it=st.endpointData?.[p]; if(!it||validRealmNumber(it.captureRealm)!==n)continue;
    const t=Date.parse(String(it.data?.date||'').replace(' ','T')); if(Number.isFinite(t)&&(best==null||t>best))best=t;
  }
  return best;
}
function nextAccountingWalkAt(readyAtMs,offsetMin,now=Date.now()){
  if(!Number.isFinite(readyAtMs))return null;
  let t=readyAtMs+accountingWalkOffset(offsetMin)*60000;
  while(t<=now)t+=86400000;
  return t;
}
async function ensureAccountingWalkSchedule(reason='ensure'){
  const sch=await readAccountingWalkSchedule();
  if(!sch.enabled||validRealmNumber(sch.realm)==null){await chrome.alarms.clear(ACCOUNTING_WALK_DAILY_ALARM).catch(()=>{});if(sch.nextAt)await writeAccountingWalkSchedule({nextAt:null});return {ok:true,enabled:false,reason};}
  // a pending retry keeps its own time
  if(sch.retryAt&&Date.parse(sch.retryAt)>Date.now()){await chrome.alarms.create(ACCOUNTING_WALK_DAILY_ALARM,{when:Date.parse(sch.retryAt)});return {ok:true,enabled:true,nextAt:sch.retryAt,retry:true,reason};}
  const ready=await accountingStatementsReadyAt(sch.realm);
  const at=nextAccountingWalkAt(ready,sch.offsetMin);
  if(at==null){await chrome.alarms.clear(ACCOUNTING_WALK_DAILY_ALARM).catch(()=>{});await writeAccountingWalkSchedule({nextAt:null,waitingFor:'statement-time'});return {ok:false,enabled:true,error:'Sync once so the Manager knows when the game finishes your statements.',reason};}
  await chrome.alarms.create(ACCOUNTING_WALK_DAILY_ALARM,{when:at});
  await writeAccountingWalkSchedule({nextAt:new Date(at).toISOString(),readyAt:new Date(ready).toISOString(),waitingFor:null});
  return {ok:true,enabled:true,nextAt:new Date(at).toISOString(),reason};
}
async function runScheduledAccountingWalk(trigger='alarm'){
  const sch=await readAccountingWalkSchedule();
  const realm=validRealmNumber(sch.realm);
  if((!sch.enabled&&trigger==='alarm')||realm==null)return {ok:false,skipped:true};
  if(syncSessionForRealm(realm)||accountingDayWalkRunning.has(realm)){await chrome.alarms.create(ACCOUNTING_WALK_DAILY_ALARM,{when:Date.now()+60000});return {ok:false,busy:true};}
  const before=await accountingStatementsReadyAt(realm);
  const attempt=(Number(sch.attempt)||0)+1;
  // Current statements + past finances through the game tab (same 7 Accounting requests as Sync), then the page walk.
  const refresh=await refreshAccountingForRealm(realm,{force:true,reason:`scheduled-walk:${trigger}`}).catch(e=>({ok:false,error:e?.message||String(e)}));
  const after=await accountingStatementsReadyAt(realm);
  const expected=Number.isFinite(Date.parse(sch.nextAt||''))?Date.parse(sch.nextAt)-accountingWalkOffset(sch.offsetMin)*60000:null;
  // The game has not finished today's statements yet (or no game tab): try again later, a few times.
  const rolled=after!=null&&(before==null||after>before||(expected!=null&&after>=expected-2*3600000));
  let walk=null;
  if(refresh?.ok&&rolled||trigger==='manual')walk=await runAccountingDayWalk(realm,`scheduled:${trigger}`).catch(e=>({ok:false,error:e?.message||String(e)}));
  const okRun=walk&&walk.ok&&walk.status!=='failed';
  const result={at:new Date().toISOString(),trigger,attempt,refresh:refresh?.ok?'ok':(refresh?.error||'failed'),rolledOver:rolled,walk:walk?walk.status:null,captured:walk?.captured??null,error:okRun?null:(walk?.error||refresh?.error||(rolled?null:'Statements not updated yet'))};
  if(!okRun&&trigger==='alarm'&&attempt<ACCOUNTING_WALK_MAX_ATTEMPTS){
    const retryAt=new Date(Date.now()+ACCOUNTING_WALK_RETRY_MS).toISOString();
    await writeAccountingWalkSchedule({attempt,retryAt,nextAt:retryAt,lastResult:result});
    await chrome.alarms.create(ACCOUNTING_WALK_DAILY_ALARM,{when:Date.parse(retryAt)});
    return {ok:false,retryAt,...result};
  }
  await writeAccountingWalkSchedule({attempt:0,retryAt:null,lastResult:result});
  await ensureAccountingWalkSchedule('after-run');
  return {ok:okRun,...result};
}
const ACCOUNTING_WEEK_REFRESH_RETRY_MS=30000;
const accountingWeekRefreshPromises=new Map();
const SYNC_STEP_YIELD_MS=350;
function accountingEndpointFreshForRealm(s,path,realm,maxAge=ACCOUNTING_REFRESH_MAX_AGE_MS){
  const item=s?.realmStores?.[realmKeyFromRealm(realm)]?.endpointData?.[path];
  if(!item||Number(item.status)<200||Number(item.status)>=300||item.data==null)return false;
  const cr=validRealmNumber(item.captureRealm);
  if(cr!=null&&cr!==Number(realm))return false;
  const received=Date.parse(item.receivedAt||'');
  return Number.isFinite(received)&&Date.now()-received<maxAge;
}
async function refreshAccountingForRealm(realmArg=null,{force=false,reason='manual'}={}){
  const realm=validRealmNumber(realmArg);
  if(realm==null)return {ok:false,error:'A valid realm is required for Accounting refresh.'};
  if(realmSyncSessions.has(realm))return {ok:false,busy:true,realm,error:`${realmDisplayNumber(realm)||'Realm'} Sync is already running.`};
  const tab=await simTab();
  if(!tab?.id)return {ok:false,realm,error:'Open Sim Companies in a browser tab before refreshing Accounting.'};
  const current=await state(realm);
  const key=realmKeyFromRealm(realm);
  const store=current.realmStores?.[key]||{};
  const companyId=Number(store.authData?.authCompany?.companyId||store.authData?.authCompany?.id||current.authData?.authCompany?.companyId||current.authData?.authCompany?.id)||0;
  const paths=ACCOUNTING_SYNC_PATHS.slice();
  const pending=force?paths:paths.filter(path=>!accountingEndpointFreshForRealm(current,path,realm));
  if(!pending.length)return {ok:true,realm,reason,requested:0,successful:paths.length,total:paths.length,skippedFresh:true};
  const results=[];
  let cursor=0;
  const worker=async()=>{
    while(true){
      const i=cursor++; if(i>=pending.length)return;
      const path=pending[i];
      try{
        const response=await pageGet(path,realm,null,`accounting-refresh:${reason}`);
        const ok=Boolean(response?.ok)&&validRealmNumber(response?.captureRealm)===realm;
        if(ok) await saveData(path,response.data,response.status,'GET',realm);
        results.push({path,ok,status:Number(response?.status)||0,captureRealm:validRealmNumber(response?.captureRealm),error:ok?null:(response?.error||'Accounting response realm mismatch.')});
      }catch(e){
        results.push({path,ok:false,status:0,captureRealm:null,error:e?.message||String(e)});
      }
    }
  };
  await Promise.all(Array.from({length:Math.min(ACCOUNTING_REFRESH_CONCURRENCY,pending.length)},()=>worker()));
  const freshState=await state(realm);
  const successful=paths.filter(path=>accountingEndpointFreshForRealm(freshState,path,realm,Number.MAX_SAFE_INTEGER)).length;
  const failed=results.filter(r=>!r.ok);
  const status=successful===paths.length?`${realmDisplayNumber(realm)||'Realm'} Accounting captured · ${successful}/${paths.length} APIs`:`${realmDisplayNumber(realm)||'Realm'} Accounting partial · ${successful}/${paths.length} APIs`;
  await setRealmLoadStatus(realm,status,successful===paths.length?null:`${failed.length} Accounting API request(s) failed.`);
  logActivity(realm,'accounting-refresh',failed.length?(successful?'partial':'failure'):'success',{rows:successful,wanted:pending.length},failed.length?`${failed.length} of ${pending.length} statements failed`:null,Date.now(),reason);
  return {ok:successful>0,realm,reason,requested:pending.length,successful,total:paths.length,failed,results,status};
}

const ACCOUNTING_CORE_PATH_RE=/(?:balance-sheet|cashflow-statement|income-statement|past-finances-overview|past-finances)(?:\/|\?|$)/i;


async function noteRealmSwitch(realm){
  const n=validRealmNumber(realm); if(n==null)return false;
  const now=Date.now();
  // Realm changes in the game are observed for diagnostics only. The Manager
  // never changes the selected realm or starts a sync automatically. The user
  // explicitly chooses the two game realms (R1/R2), then presses Sync. Internal API IDs remain 0/1.
  await storageSet({realmSwitchHint:{realm:n,at:now}});
  replayEvent('realm-switch-intent',{realm:n});
  return true;
}

async function saveDataUnlocked(url,data,status=200,method='GET',captureRealm=null,onTiming=null){
  if(!url?.startsWith('/api/'))return;
  await ensureRealmStorageMigration();
  const before=await state();
  const responseRealm=/\/api\/v3\/companies\/auth-data\//.test(url)
    ? validRealmNumber(data?.authCompany?.realmId??data?.authCompany?.realm??data?.realmId??data?.realm)
    : null;
  const capturedRealm=validRealmNumber(captureRealm);
  const companyRealm=knownRealmForCompanyId(before,companyIdFromUrl(url));
  const buildingMatch=String(url||'').match(/\/api\/v2\/companies\/buildings\/(\d+)\/history\/?(?:\?.*)?$/i);
  const buildingRealm=buildingMatch?knownRealmForBuildingId(before,Number(buildingMatch[1])):null;
  const explicitUrlRealm=endpointRealmFromUrl(url);
  const quarantineRealmConflict=(expectedRealm,reason)=>appendRealmQuarantine(expectedRealm,'apiData',{url,method:String(method||'GET').toUpperCase(),status:Number(status)||0,captureRealm:capturedRealm,expectedRealm,reason});
  // If the URL/company/building identity proves the response belongs to a
  // different realm than the capture tag, reject it before it can enter the
  // realm store. This catches the exact failure where R1 Seeds history was
  // stamped as captureRealm 1 and then appeared in the R2 overlay.
  if(capturedRealm!=null && companyRealm!=null && capturedRealm!==companyRealm){
    await quarantineRealmConflict(companyRealm,'Known company identity belongs to a different realm than the capture tag.');
    return;
  }
  if(capturedRealm!=null && buildingRealm!=null && capturedRealm!==buildingRealm){
    await quarantineRealmConflict(buildingRealm,'Known building identity belongs to a different realm than the capture tag.');
    return;
  }
  if(capturedRealm!=null && explicitUrlRealm!=null && capturedRealm!==explicitUrlRealm){
    await quarantineRealmConflict(explicitUrlRealm,'Explicit realm in API URL does not match the capture tag.');
    return;
  }
  // During an explicit UI-driven sync, the selected realm is the transaction
  // boundary. Never fall back to active/stale realm state. Missing or mismatched
  // captures are quarantined instead of being assigned to another realm.
  const captureSession=syncSessionForRealm(capturedRealm)||currentCaptureSyncSession();
  if(captureSession){
    const sessionRealm=validRealmNumber(captureSession.realm);
    if(sessionRealm==null || capturedRealm==null || capturedRealm!==sessionRealm){
      await appendRealmQuarantine(sessionRealm,'apiData',{url,method:String(method||'GET').toUpperCase(),status:Number(status)||0,captureRealm:capturedRealm,expectedRealm:sessionRealm,reason:capturedRealm==null?'No capture realm during explicit sync':'Capture realm did not match selected sync realm'});
      return;
    }
  }
  const switchHint=before.realmSwitchHint&&Number.isFinite(Number(before.realmSwitchHint.at))&&Date.now()-Number(before.realmSwitchHint.at)<15000
    ? validRealmNumber(before.realmSwitchHint.realm) : null;
  // Incoming-contract endpoints are realm-specific. Sim Companies may request
  // both /contracts-incoming/0/me and /contracts-incoming/1/me from the same SPA
  // page, but only the endpoint whose numeric realm matches the capture realm
  // belongs in that realm's contract store. Do not persist the other realm's
  // contract payload into the selected realm.
  const incomingContractRealm=url.match(/\/api\/v3\/contracts-incoming\/(\d+)\/me(?:\/\d+)?\/?(?:\?.*)?$/i);
  if(incomingContractRealm){
    const endpointRealm=validRealmNumber(incomingContractRealm[1]);
    if(endpointRealm!=null && capturedRealm!=null && endpointRealm!==capturedRealm){
      await appendRealmQuarantine(endpointRealm,'apiData',{url,method:String(method||'GET').toUpperCase(),status:Number(status)||0,captureRealm:capturedRealm,expectedRealm:endpointRealm,reason:'Foreign incoming-contract realm response ignored to prevent cross-realm contract contamination'});
      return;
    }
  }
  // v2.5.334 new incoming contract notification (own state key, not awaited, no network).
  if(incomingContractRealm&&Number(status)>=200&&Number(status)<300)notifyIncomingContracts(validRealmNumber(incomingContractRealm[1]),data).catch(()=>{});
  if(Number(status)>=200&&Number(status)<300&&capturedRealm!=null)logGameCapture(capturedRealm,url);
  // v2.5.353 also on auth-data: on the phone the game does not load the buildings list at start (user's API
  // capture 2026-10-24), but it loads auth-data on every page load and every 3 min. Uses the stored buildings.
  {const isB=/\/api\/v2\/companies\/me\/buildings\/?(?:\?.*)?$/i.test(String(url||'')),isA=/\/api\/v3\/companies\/auth-data\//i.test(String(url||''));const r=capturedRealm??(isA?responseRealm:null);
   if((isB||isA)&&Number(status)>=200&&Number(status)<300&&r!=null)setTimeout(()=>{refreshAbundanceIfStale(r,isA?'game-auth-data':'game-buildings').catch(()=>{});},3000);}
  {const ob=String(url||'').match(/\/api\/v3\/market\/(\d+)\/(\d+)\/?(?:\?.*)?$/);if(ob&&Number(status)>=200&&Number(status)<300&&Array.isArray(data)){const r=Number(ob[1]),id=Number(ob[2]);setTimeout(()=>{notifyOrderBook(r,id,data).catch(()=>{});},1500);}}
  if(/\/api\/v2\/companies\/me\/cashflow\/recent\/?(?:\?.*)?$/i.test(String(url||''))&&Number(status)>=200&&Number(status)<300){const r=validRealmNumber(capturedRealm);if(r!=null)setTimeout(()=>{notifySales(r,data).catch(()=>{});},1500);}
  // Accounting responses are realm-sensitive even when the API path uses /me/.
  // A missing capture realm must never be assigned to the current active realm:
  // an old R2 response racing an R1 switch would otherwise become R1 data.
  if(isRealmSensitiveAccountingUrl(url) && capturedRealm==null && !currentCaptureSyncSession()){
    await appendRealmQuarantine(validRealmNumber(before.selectedRealm??before.activeRealmKey?.replace(/^realm:/,'')),'apiData',{url,method:String(method||'GET').toUpperCase(),status:Number(status)||0,captureRealm:null,expectedRealm:validRealmNumber(before.selectedRealm),reason:'Accounting response missing capture realm; quarantined to prevent cross-realm contamination'});
    return;
  }
  // v2.5.345 a game response with no realm tag and nothing in it that proves its realm is never filed under the
  // active (last-synced) realm: that put R1 buildings/warehouse into the R2 store. page-hook now holds such
  // responses until the game's auth-data names the realm, so this only catches stragglers.
  if(!captureSession&&capturedRealm==null&&responseRealm==null&&companyRealm==null&&buildingRealm==null&&explicitUrlRealm==null&&switchHint==null){
    await appendRealmQuarantine(null,'apiData',{url,method:String(method||'GET').toUpperCase(),status:Number(status)||0,captureRealm:null,expectedRealm:null,reason:'No capture realm and nothing in the response proves its realm; not filed under the active realm'});
    return;
  }
  const targetRealm=captureSession?.realm??responseRealm??capturedRealm??companyRealm??buildingRealm??explicitUrlRealm??switchHint??realmNumberFromKey(before.activeRealmKey||identityFromAuth(before.authData));
  const targetKey=targetRealm!=null?realmKeyFromRealm(targetRealm):null;
  const endpointResult=await saveEndpointUnlocked(url,method,targetRealm,false,targetRealm!=null?await state(targetRealm):before);

  // Auth responses are stored strictly under the realm proven by the response.
  // They never switch the user's selected/active realm automatically.
  const s2=before;
  const activeKey=s2.activeRealmKey||identityFromAuth(s2.authData);
  const isActiveTarget=!captureSession && (!targetKey || !activeKey || targetKey===activeKey);
  // If a background capture targets the non-active realm, read ONLY that
  // realm's physical store. The active Manager view must never become a cache
  // source for another realm.
  const targetState=targetRealm!=null?await state(targetRealm):s2;
  const workingBase=(isActiveTarget?{...s2}:{...DEFAULTS,...targetState});
  if(endpointResult?.store?.apiEndpoints)workingBase.apiEndpoints=endpointResult.store.apiEndpoints;
  const working=sanitizeRealmStore(workingBase,targetRealm);

  if(method!=='GET'){
    if(/\/api\/(?:v2|v3)\/.*contracts/i.test(url)){
      const events=Array.isArray(working.contractEvents)?working.contractEvents.slice():[];
      events.push({url,status:Number(status)||0,data,receivedAt:new Date().toISOString(),method});
      const patch={contractEvents:events.slice(-100)};
      const commitRealm=validRealmNumber(targetRealm);
      if(commitRealm==null){
        await quarantineRealmConflict(capturedRealm,'Contract response has no resolvable target realm.');
        return;
      }
      await storageSetRealmPatch(commitRealm,patch);
    }
    return;
  }

  const midForPreserve=marketIdFromUrl(url);
  const incomingStatus=Number(status)||0;
  const old=working.endpointData?.[url];
  const keepOldMarket=midForPreserve && hasUsableMarketRows(old?.data) && !hasUsableMarketRows(data);
  const preserveSuccessful=Number(incomingStatus)>=400 && old && Number(old.status)>=200 && Number(old.status)<300 && old.data!=null;
  // Sim Companies rolls the aggregate cash-flow statement at the daily
  // accounting boundary. The new period can be returned as isComputed:false
  // with all zero totals. Never let that placeholder overwrite the last
  // completed statement.
  const isCashflowStatement=/\/api\/v2\/companies\/(?:me|\d+)\/cashflow-statement(?:\/\d+)?\/?$/i.test(url);
  const incomingComputed=isCashflowStatement && data && typeof data==='object' && data.isComputed===true;
  const oldComputed=isCashflowStatement && old?.data && typeof old.data==='object' && old.data.isComputed===true;
  const savedComputed=working.accountingLastComputed?.data && working.accountingLastComputed.data.isComputed===true;
  const preserveCompletedStatement=isCashflowStatement && !incomingComputed && (oldComputed || savedComputed);
  const savedEntry=working.accountingLastComputed||null;
  const preservedEntry=oldComputed?old:(savedEntry?{status:200,data:savedEntry.data,receivedAt:savedEntry.receivedAt,captureRealm:savedEntry.captureRealm}:null);
  const endpointData={...(working.endpointData||{}),[url]:
    keepOldMarket?old:
    (preserveSuccessful||preserveCompletedStatement
      ?{...preservedEntry,lastAttempt:{status:incomingStatus,receivedAt:new Date().toISOString(),captureRealm:targetRealm}}
      :{status,data,receivedAt:new Date().toISOString(),captureRealm:targetRealm})};
  const patch={endpointData};
  if(isRealmSensitiveAccountingUrl(url) && incomingStatus>=200 && incomingStatus<300 && data!=null){
    patch.accountingCapture={
      ...(working.accountingCapture||{}),
      [url]:endpointData[url]
    };
  }
  if(/\/api\/v2\/companies\/me\/cashflow\/recent\//i.test(url)){
    const selling={...(working.sellingHistory||{})};
    const list=Array.isArray(data?.data)?data.data:[];
    for(const row of list){
      const d=row?.details||{};
      const rid=Number(d.resource??d.resourceId??row.resource??row.resourceId);
      const profit=Number(d.profit??row.profit);
      const amount=Number(d.amount??row.amount);
      if(!Number.isFinite(rid)||rid<=0||!Number.isFinite(profit)||profit<=0||!Number.isFinite(amount)||amount<=0)continue;
      const id=String(row.id??`${row.datetime||''}|${rid}|${amount}|${profit}`);
      selling[id]={id:row.id??id,resourceId:rid,amount,profit,price:Number.isFinite(Number(d.price??row.price))?Number(d.price??row.price):null,money:Number.isFinite(Number(row.money??d.money))?Number(row.money??d.money):null,datetime:row.datetime||null,category:String(row.category||''),descriptionKey:String(row.descriptionKey||'')};
    }
    const ordered=Object.values(selling).sort((a,b)=>Date.parse(String(a.datetime||''))-Date.parse(String(b.datetime||''))).slice(-5000);
    patch.sellingHistory=Object.fromEntries(ordered.map(x=>[String(x.id),x]));
    const weekStart=accountingWeekStart(working);
    if(Number.isFinite(weekStart)){
      const weekSales=mergeAccountingWeekSales({...working,accountingWeekSales:working.accountingWeekSales||{}},list,weekStart);
      patch.accountingWeekSales=weekSales;
      patch.accountingWeekSalesSummary=computeAccountingWeekSalesSummary({...working,accountingWeekSales:weekSales});
      patch.accountingWeekRevision=(Number(working.accountingWeekRevision)||0)+1;
    }
  }
  if(incomingComputed) patch.accountingLastComputed={data,receivedAt:new Date().toISOString(),captureRealm:targetRealm};
  const isIncomeStatement=/\/api\/v2\/companies\/(?:me|\d+)\/income-statement(?:\/\d+)?\/?$/i.test(url);
  const incomingIncomeComputed=isIncomeStatement && data && typeof data==='object' && data.isComputed===true;
  const oldIncomeComputed=isIncomeStatement && old?.data && typeof old.data==='object' && old.data.isComputed===true;
  const savedIncomeComputed=working.accountingLastComputedIncome?.data && working.accountingLastComputedIncome.data.isComputed===true;
  const preserveCompletedIncome=isIncomeStatement && !incomingIncomeComputed && (oldIncomeComputed || savedIncomeComputed);
  if(incomingIncomeComputed) patch.accountingLastComputedIncome={data,receivedAt:new Date().toISOString(),captureRealm:targetRealm};
  if(preserveCompletedStatement && oldComputed) patch.accountingLastComputed=preservedEntry;
  if(preserveCompletedIncome && oldIncomeComputed) patch.accountingLastComputedIncome=preservedEntry;
  if(/\/api\/v3\/companies\/auth-data\//.test(url)){patch.authData=data;recordEconomyState(targetRealm,old,data).catch(()=>{});}
  if(/\/api\/v2\/companies\/(?:me|\d+)\/buildings\//.test(url)){
    // Building data is captured only from the game's real API/local state.
    // Never replace a good snapshot with a Cloudflare/HTML challenge.
    const buildingDataUsable=(incomingStatus>=200&&incomingStatus<300)&&(Array.isArray(data)||(data&&typeof data==='object'&&['buildings','data','items','results'].some(k=>Array.isArray(data[k]))));
    if(buildingDataUsable){
      const rows=Array.isArray(data)?data:(['buildings','data','items','results'].map(k=>Array.isArray(data?.[k])?data[k]:null).find(Boolean)||[]);
      if(rows.length){patch.buildings=rows;queueProductionCostHistory(targetRealm,globalThis.SCM_TOOLS_CORE.productionCostEntriesFromBuildings(rows));scheduleProductionFinishAlarms(targetRealm,rows).catch(()=>{});}
    }
  }
  {
    // v2.5.331 production cost history: every past batch from the building history endpoint.
    const hm=String(url||'').match(/\/api\/v2\/companies\/buildings\/(\d+)\/history\/?(?:\?.*)?$/i);
    if(hm&&incomingStatus>=200&&incomingStatus<300&&Array.isArray(data)){
      const bid=Number(hm[1]);const bn=(Array.isArray(working?.buildings)?working.buildings:[]).find(x=>Number(x?.id)===bid)?.name||'';
      queueProductionCostHistory(targetRealm,globalThis.SCM_TOOLS_CORE.productionCostEntriesFromHistory(bid,data,bn));
    }
  }
  if(isResourceUrl(url)){
    const rows=normalizeWarehouse(data);
    if(looksLikeWarehouseRows(rows)){
      // Keep quantity/quality from the game's local snapshot while preserving
      // richer cost fields from the resource API. Never discard a field merely
      // because the later response omits it.
      const latestGameCapturedAt=Date.parse(String(working?.warehouseCapture?.gameStateCapturedAt||working?.warehouseCapture?.receivedAt||''));
      const nowIso=new Date().toISOString();
      const gameSnapshotIsFresh=working?.warehouseCapture?.source==='game-localStorage-live' && Number.isFinite(latestGameCapturedAt) && Date.now()-latestGameCapturedAt<5000;
      if(gameSnapshotIsFresh && Array.isArray(working.warehouseResources)){
        // The API row is the authoritative inventory record. Keep quantity and
        // sourcing-cost fields from the same row so we never divide a batch
        // cost by a stale localStorage quantity.
        patch.warehouseResources=mergeWarehouseSnapshot(rows,working.warehouseResources);
        patch.warehouseCapture={source:'api-authoritative-merged',url,status:incomingStatus,rows:patch.warehouseResources.length,incomingRows:rows.length,gameStateCapturedAt:working.warehouseCapture.gameStateCapturedAt,receivedAt:nowIso,apiQuantityProtected:true,apiCostProtected:true};
      } else {
        const mergedWarehouse=mergeWarehouseSnapshot(rows,working.warehouseResources);
        patch.warehouseResources=mergedWarehouse;
        patch.warehouseCapture={source:'api-authoritative-merged',url,status:incomingStatus,rows:mergedWarehouse.length,incomingRows:rows.length,receivedAt:nowIso};
      }
      patch.marketQueue=[];
      patch.marketQueueCursor=0;
    }
    const rid=resourceIdFromUrl(url);
    const image=resourceImageHint(data);
    if(rid&&image){
      const rc=working.resourceCatalog&&typeof working.resourceCatalog==='object'?working.resourceCatalog:{};
      patch.resourceCatalog={...rc,resourceImages:{...(rc.resourceImages||{}),[String(rid)]:image},receivedAt:new Date().toISOString()};
    }
  }
  // Do not infer warehouse inventory from arbitrary API payloads. Production
  // history endpoints also contain kind/quality/amount/cost-shaped rows, but
  // those amounts are batch output amounts rather than current inventory.
  // Treating them as warehouse rows can overwrite a correct resources-API
  // quantity and make unit cost appear multiplied (for example 3x too high).
  const mid=midForPreserve;
  if(mid){
    const arr=Array.isArray(data)?data:null;
    patch.marketDebug={...(working.marketDebug||{}),[String(mid.resource)]:{source:'api',status:incomingStatus,type:Array.isArray(data)?'array':typeof data,records:arr?arr.length:0,keys:data&&typeof data==='object'&&!Array.isArray(data)?Object.keys(data).slice(0,30):[],sample:arr?arr.slice(0,5):data,receivedAt:new Date().toISOString()}};
  }

  const overlayRelevant=Boolean(
    Object.prototype.hasOwnProperty.call(patch,'warehouseResources') ||
    Object.prototype.hasOwnProperty.call(patch,'contracts') ||
    Object.prototype.hasOwnProperty.call(patch,'savedContracts') ||
    Object.prototype.hasOwnProperty.call(patch,'productionEvents') ||
    Object.prototype.hasOwnProperty.call(patch,'productionRateSnapshots') ||
    Object.prototype.hasOwnProperty.call(patch,'productionPlans') ||
    Object.prototype.hasOwnProperty.call(patch,'buildings') ||
    /\/api\/v3\/contracts-(?:incoming|outgoing)/i.test(String(url||'')) ||
    /\/api\/v2\/companies\/buildings\/\d+\/history\/?$/i.test(String(url||''))
  );
  const replayUrl=String(url||'');
  const replayFamily=/\/api\/v3\/companies\/auth-data\//i.test(replayUrl)?'auth':/\/api\/v3\/resources\/\d+/i.test(replayUrl)?'warehouse':/\/api\/v3\/contracts-(?:incoming|outgoing)/i.test(replayUrl)?'contracts':/\/api\/v2\/companies\/buildings/i.test(replayUrl)?'buildings':/\/api\/v3\/market(?:\/all)?\/\d+\/\d+/i.test(replayUrl)?'market':/\/api\/v2\/companies\/(?:me|\d+)\/(?:cashflow|balance-sheet|income-statement|cashflow-statement)/i.test(replayUrl)?'accounting':null;
  if(replayFamily){
    let incomingCount=null;
    if(replayFamily==='warehouse'){const rows=normalizeWarehouse(data);incomingCount=rows.length;}
    else if(replayFamily==='buildings'){const rows=Array.isArray(data)?data:(['buildings','data','items','results'].map(k=>Array.isArray(data?.[k])?data[k]:null).find(Boolean)||[]);incomingCount=rows.length;}
    else if(replayFamily==='contracts'){const rows=Array.isArray(data)?data:(Array.isArray(data?.data)?data.data:[]);incomingCount=rows.length;}
    else if(replayFamily==='market'){incomingCount=Array.isArray(data)?data.length:(Array.isArray(data?.data)?data.data.length:null);}
    replayEvent('storage-mutation',{realm:targetRealm,operation:'saveData',family:replayFamily,url:replayUrl,method:String(method||'GET').toUpperCase(),status:incomingStatus,incomingCount,baseline:working?.criticalDataBaseline||null,activeRealmKey:s2?.activeRealmKey||null,targetKey,criticalWrite:true});
  }
  if(targetRealm!=null){
    const realmPatch={...patch};
    if(endpointResult?.store?.apiEndpoints)realmPatch.apiEndpoints=endpointResult.store.apiEndpoints;
    await storageSetRealmPatch(targetRealm,realmPatch,onTiming);
    if(overlayRelevant) scheduleGameOverlayRefreshNotification(targetRealm);
  }
}
async function saveData(url,data,status=200,method='GET',captureRealm=null,onTiming=null,durableOptions=null){
  const enqueuedAt=Date.now();
  const queueRealm=validRealmNumber(captureRealm);
  const queueKey=queueRealm!=null?`realm:${queueRealm}`:'unscoped';
  const schedulerAtEnqueue=apiStorageSchedulers.get(queueKey);
  const queuedJobsAheadAtEnqueue=schedulerAtEnqueue?(schedulerAtEnqueue.queue.length+(schedulerAtEnqueue.running?1:0)):0;
  return enqueueApiStorage(async()=>{
    const queueWaitMs=Date.now()-enqueuedAt;
    const schedulerAtStart=apiStorageSchedulers.get(queueKey);
    const queuedJobsBehindAtStart=schedulerAtStart?.queue?.length||0;
    const saveStartedAt=Date.now();
    const commitTiming={};
    const reportCommitTiming=detail=>Object.assign(commitTiming,detail||{});
    try{
      const result=await saveDataUnlocked(url,data,status,method,captureRealm,reportCommitTiming);
      let durableVerification=null;
      // Keep the per-endpoint read-back inside the same serialized API queue
      // slot as the write. Otherwise a later same-URL capture can race the
      // verifier and make a correct write look wrong (or validate stale data).
      if(durableOptions&&typeof durableOptions==='object'){
        const verifyRealm=validRealmNumber(durableOptions.realm??captureRealm);
        const verifyStartedAt=Number(durableOptions.startedAtMs)||enqueuedAt;
        durableVerification=await verifyDurableEndpointWrite(
          verifyRealm,
          url,
          verifyStartedAt,
          Object.prototype.hasOwnProperty.call(durableOptions,'expectedData')?durableOptions.expectedData:data,
          Object.prototype.hasOwnProperty.call(durableOptions,'expectedStatus')?durableOptions.expectedStatus:status,
          Boolean(durableOptions.allowPreserved)
        );
        commitTiming.durableVerificationOk=Boolean(durableVerification?.ok);
        commitTiming.durableVerificationReason=durableVerification?.reason||null;
        if(!durableVerification?.ok)throw new Error(`Durable endpoint verification failed (${durableVerification?.reason||'unverified'}).`);
      }
      try{onTiming?.({queueWaitMs,queuedJobsAheadAtEnqueue,queuedJobsBehindAtStart,saveDurationMs:Date.now()-saveStartedAt,totalDurationMs:Date.now()-enqueuedAt,...commitTiming,ok:true});}catch{}
      return durableVerification?{...(result&&typeof result==='object'?result:{}),durableVerification}:result;
    }catch(error){
      try{onTiming?.({queueWaitMs,queuedJobsAheadAtEnqueue,queuedJobsBehindAtStart,saveDurationMs:Date.now()-saveStartedAt,totalDurationMs:Date.now()-enqueuedAt,...commitTiming,ok:false,error:error?.message||String(error)});}catch{}
      throw error;
    }
  },captureRealm,{priority:Boolean(durableOptions),url:String(url||'')});
}

// Compare JSON endpoint payloads independent of object property insertion
// order. Arrays remain ordered because order can be meaningful in API data.
function canonicalEndpointPayload(value){
  if(Array.isArray(value))return value.map(canonicalEndpointPayload);
  if(value&&typeof value==='object'){
    const result={};
    for(const key of Object.keys(value).sort()){
      const item=value[key];
      if(typeof item==='undefined'||typeof item==='function'||typeof item==='symbol')continue;
      result[key]=canonicalEndpointPayload(item);
    }
    return result;
  }
  return value;
}
function endpointPayloadsEqual(left,right){
  try{return JSON.stringify(canonicalEndpointPayload(left))===JSON.stringify(canonicalEndpointPayload(right));}
  catch{return false;}
}

// Verify the physical realm record, not a synthetic state snapshot or a UI
// capture signal. A successful API response is not durable until its endpoint
// entry is present, realm-stamped, successful, non-empty, and written during
// this capture (or explicitly records a fresh attempt while preserving a good
// computed accounting statement).
async function verifyDurableEndpointWrite(realm,path,startedAtMs,expectedData=null,expectedStatus=null,allowPreserved=false){
  const n=validRealmNumber(realm);
  if(n==null||!String(path||'').startsWith('/api/'))return {ok:false,reason:'invalid-realm-or-endpoint'};
  const physicalKey=realmStorageKey(n);
  const snapshot=await chrome.storage.local.get({[physicalKey]:null});
  const store=snapshot?.[physicalKey];
  const entry=store?.endpointData?.[path];
  if(!entry||typeof entry!=='object')return {ok:false,reason:'endpoint-record-missing'};
  if(validRealmNumber(entry.captureRealm)!==n)return {ok:false,reason:'endpoint-realm-mismatch',captureRealm:entry.captureRealm};
  const status=Number(entry.status)||0;
  if(status<200||status>=300)return {ok:false,reason:'stored-endpoint-not-successful',status};
  if(expectedStatus!=null&&status!==Number(expectedStatus))return {ok:false,reason:'stored-status-mismatch',status,expectedStatus:Number(expectedStatus)};
  if(entry.data==null)return {ok:false,reason:'stored-endpoint-data-empty'};
  const receivedAt=Date.parse(String(entry.receivedAt||''));
  const attemptedAt=Date.parse(String(entry.lastAttempt?.receivedAt||''));
  const freshRecord=Number.isFinite(receivedAt)&&receivedAt>=Number(startedAtMs||0);
  const freshAttempt=Number.isFinite(attemptedAt)&&attemptedAt>=Number(startedAtMs||0);
  if(!freshRecord&&!(allowPreserved&&freshAttempt))return {ok:false,reason:'stored-endpoint-is-stale',receivedAt:entry.receivedAt||null,lastAttemptAt:entry.lastAttempt?.receivedAt||null};
  if(expectedData!=null&&freshRecord&&!endpointPayloadsEqual(entry.data,expectedData))return {ok:false,reason:'stored-payload-mismatch'};
  return {ok:true,realm:n,path,status,receivedAt:entry.receivedAt||null,lastAttemptAt:entry.lastAttempt?.receivedAt||null,preservedPriorData:!freshRecord&&freshAttempt};
}
// v2.5.344: callers may pass {timeoutMs, attempts}. The page hook aborts its fetch at timeoutMs and the
// background waits a short grace beyond it, so a slow game response is reported by the page, not cut off here.
const PAGE_GET_BACKGROUND_GRACE_MS=2000;
async function pageGet(path, targetRealm=null, diagnosticTrace=null, diagnosticLabel=null, options=null){
  const customTimeout=Number(options?.timeoutMs);
  const hasCustomTimeout=Number.isFinite(customTimeout)&&customTimeout>0;
  const timeoutMs=hasCustomTimeout?customTimeout:SYNC_PAGE_API_TIMEOUT_MS;
  // v2.5.345 the page is always told the timeout (it used to fall back to its own 8 s for default callers).
  const raceMs=timeoutMs+PAGE_GET_BACKGROUND_GRACE_MS;
  const customAttempts=Number(options?.attempts);
  const attempts=Number.isInteger(customAttempts)&&customAttempts>0?customAttempts:SYNC_PAGE_API_ATTEMPTS;
  const traceDiag=(type,extra={})=>{
    try{ diagnosticTrace?.(type,{realm:targetRealm,path,label:diagnosticLabel,attempt:extra.attempt,...extra}); }catch{}
  };
  let lastError=null;
  for(let attempt=1;attempt<=attempts;attempt++){
    const tab=await simTab();
    if(!tab?.id){ lastError=new Error('Open Sim Companies and log in before syncing.'); break; }
    try{
      traceDiag('pageget-start',{attempt,tabId:tab.id});
      const bridgeReady=await waitForBridge(tab.id,3000);
      traceDiag('pageget-bridge-ready',{attempt,tabId:tab.id,ready:bridgeReady});
      if(!bridgeReady){
        traceDiag('pageget-bridge-not-ready',{attempt,tabId:tab.id});
        lastError=new Error('Sim Companies page bridge is not ready.');
        if(attempt<attempts) await new Promise(r=>setTimeout(r,1000));
        continue;
      }
      traceDiag('pageget-send',{attempt,tabId:tab.id});
      const r=await Promise.race([
        chrome.tabs.sendMessage(tab.id,{type:'PAGE_API_GET',path,realm:targetRealm,timeoutMs}),
        new Promise((_,reject)=>setTimeout(()=>reject(new Error('Sim Companies page bridge timed out.')),raceMs))
      ]);
      traceDiag('pageget-response',{attempt,tabId:tab.id,ok:!!r?.ok,status:r?.status||0,error:r?.error||null});
      // v2.5.345 a /me/ answer from a tab that is in the other realm belongs to that realm: never hand it to a
      // caller that will file it under targetRealm. (auth-data is exempt: Sync checks it and explains the mismatch.)
      const tr=validRealmNumber(targetRealm),rr=validRealmNumber(r?.captureRealm);
      if(r?.ok&&tr!=null&&rr==null&&/\/me\//.test(String(path))&&!/\/api\/v3\/companies\/auth-data\//.test(String(path))){traceDiag('pageget-realm-unknown',{attempt,tabId:tab.id,targetRealm:tr});return {ok:false,status:0,error:'The game tab has not shown which realm it is in yet.',realmUnknown:true};}
      if(r?.ok&&tr!=null&&rr!=null&&rr!==tr&&!/\/api\/v3\/companies\/auth-data\//.test(String(path))){traceDiag('pageget-realm-mismatch',{attempt,tabId:tab.id,targetRealm:tr,tabRealm:rr});return {ok:false,status:0,error:`The game tab is in ${realmDisplayNumber(rr)||'the other realm'}, not ${realmDisplayNumber(tr)||'the requested realm'}.`,captureRealm:rr,realmMismatch:true};}
      return r||{ok:false,status:0,error:'No response from Sim Companies page.'};
    }catch(e){
      traceDiag('pageget-error',{attempt,tabId:tab.id,error:e?.message||String(e)});
      lastError=e;
      if(attempt<attempts) await new Promise(r=>setTimeout(r,1000));
    }
  }
  throw new Error(lastError?.message||'Sim Companies page bridge is not connected.');
}
const BUILDING_HISTORY_REFETCH_COOLDOWN_MS=15000;
function buildingHistoryHasCurrentCycle(store,buildingId,rows){
  const buildings=Array.isArray(store?.buildings)?store.buildings:[];
  const building=buildings.find(b=>Number(b?.id)===Number(buildingId));
  const busy=building?.busy;
  const startedMs=Date.parse(String(busy?.started||''));
  const resourceId=Number(busy?.resource?.kind??busy?.resource?.resourceId);
  if(!Number.isFinite(startedMs)||!Number.isFinite(resourceId)||resourceId<=0)return true;
  return (Array.isArray(rows)?rows:[]).some(row=>{
    const amount=Number(row?.outputAmount??row?.amount);
    const rowKind=Number(row?.kind);
    const rowMs=Date.parse(String(row?.datetime||''));
    return Number.isFinite(amount)&&amount>0&&Number.isFinite(rowKind)&&rowKind===resourceId&&Number.isFinite(rowMs)&&Math.abs(rowMs-startedMs)<=5000;
  });
}
async function fetchBuildingHistoryForRealm(realm, buildingId){
  const target=validRealmNumber(realm);
  const id=Number(buildingId);
  if(target==null||!Number.isFinite(id)||id<=0)return {ok:false,error:'Invalid realm or building.'};
  const path=`/api/v2/companies/buildings/${id}/history/`;
  const current=await state(realm);
  const store=current.realmStores?.[realmKeyFromRealm(target)]||{};
  const existing=store.endpointData?.[path];
  if(existing&&Number(existing.status)>=200&&Number(existing.status)<300&&validRealmNumber(existing.captureRealm)===target&&Array.isArray(existing.data)){
    const hasCurrentCycle=buildingHistoryHasCurrentCycle(store,id,existing.data);
    const age=Date.now()-Date.parse(String(existing.receivedAt||''));
    if(hasCurrentCycle)return {ok:true,cached:true,rows:existing.data.length,hasCurrentCycle:true};
    if(Number.isFinite(age)&&age>=0&&age<BUILDING_HISTORY_REFETCH_COOLDOWN_MS)return {ok:true,cached:true,rows:existing.data.length,hasCurrentCycle:false,refreshDeferred:true};
  }
  const cachedAuth=store?.authData||null;
  const cachedAuthRealm=validRealmNumber(cachedAuth?.authCompany?.realmId??cachedAuth?.authCompany?.realm??cachedAuth?.realmId??cachedAuth?.realm);
  if(cachedAuthRealm!==target){
    const auth=await pageGet('/api/v3/companies/auth-data/',target);
    const authRealm=validRealmNumber(auth?.data?.authCompany?.realmId??auth?.data?.authCompany?.realm??auth?.data?.realmId??auth?.data?.realm??auth?.captureRealm);
    if(!auth?.ok||authRealm!==target)return {ok:false,error:`Game tab is not authenticated to R${target}.`};
    await saveData('/api/v3/companies/auth-data/',auth.data,auth.status,'GET',target);
  }
  const response=await pageGet(path,target);
  const responseRealm=validRealmNumber(response?.captureRealm);
  if(responseRealm!=null&&responseRealm!==target)return {ok:false,error:'Building history response came from the wrong realm.'};
  if(!response?.ok)return {ok:false,status:response?.status||0,error:response?.error||`Building history request failed (${response?.status||0}).`};
  await saveData(path,response.data,response.status,'GET',target);
  return {ok:true,cached:false,rows:Array.isArray(response.data)?response.data.length:0};
}

// v2.5.332 the game's Profit Calculator "Assumed wholesale price (based on the market)" is the cheapest exchange
// listing of ANY quality (user-verified 2026-10-23: $2,230 = cheapest Bulldozer listing, a Q0). The building card
// asks for a fresh order book through the game tab: same request the Exchange page makes. Network first, then saveData
// (which takes the realm lock) — no lock is held while fetching. One fetch per product per 5 min.
const ORDER_BOOK_REFETCH_MS=5*60*1000;const orderBookFetchAt=new Map();
async function fetchExchangeOrderBookForRealm(realm,resourceId){
  const target=validRealmNumber(realm),id=Number(resourceId);
  if(target==null||!Number.isFinite(id)||id<=0)return {ok:false,error:'Invalid realm or resource.'};
  const path=`/api/v3/market/${target}/${id}/`,k=`${target}:${id}`;
  const last=orderBookFetchAt.get(k)||0;
  if(Date.now()-last<ORDER_BOOK_REFETCH_MS)return {ok:true,throttled:true};
  orderBookFetchAt.set(k,Date.now());
  const response=await pageGet(path,target);
  const responseRealm=validRealmNumber(response?.captureRealm);
  if(responseRealm!=null&&responseRealm!==target)return {ok:false,error:'Order book came from the wrong realm.'};
  if(!response?.ok||!hasUsableMarketRows(response.data)){orderBookFetchAt.set(k,last);return {ok:false,status:response?.status||0,error:response?.error||'No usable order book returned (is the game tab open?).'};}
  await saveData(path,response.data,response.status,'GET',target);
  return {ok:true,rows:Array.isArray(response.data)?response.data.length:null};
}
function hasUsableMarketRows(data){
  if(Array.isArray(data)) return data.some(o=>o&&typeof o==='object' && Number.isFinite(Number(o.price ?? o.unitPrice ?? o.amountPrice)) && Number(o.price ?? o.unitPrice ?? o.amountPrice)>0 && Number.isFinite(Number(o.quality ?? o.q)));
  if(!data||typeof data!=='object') return false;
  const direct=['data','orders','market','results','items','entries','sellOrders','buyOrders','offers','list'];
  for(const k of direct) if(Array.isArray(data[k]) && hasUsableMarketRows(data[k])) return true;
  const walk=v=>{
    if(Array.isArray(v)) return hasUsableMarketRows(v);
    if(v&&typeof v==='object') return Object.values(v).some(walk);
    return false;
  };
  return walk(data);
}


function simcoVwapNumber(v){
  if(v==null) return null;
  if(typeof v==='number' && Number.isFinite(v) && v>0) return v;
  if(typeof v==='string'){
    const n=Number(v);
    return Number.isFinite(n)&&n>0?n:null;
  }
  if(typeof v==='object'){
    for(const k of ['vwap','VWAP','value','price','averagePrice','avgPrice']){
      const n=simcoVwapNumber(v[k]);
      if(n!=null) return n;
    }
  }
  return null;
}
function normalizeSimcoVwapRows(data){
  const out=[]; const seen=new Set();
  const add=(resourceId,quality,value)=>{
    const id=Number(resourceId), q=Number(quality), v=simcoVwapNumber(value);
    if(!Number.isFinite(id)||id<=0||!Number.isFinite(q)||q<0||v==null) return;
    const key=`${id}:${q}`;
    if(seen.has(key)) return;
    seen.add(key); out.push({resourceId:id,quality:q,value:v});
  };
  const isNumericKey=k=>/^\d+(?:\.\d+)?$/.test(String(k));
  const visit=(v,hintId=null,hintQ=null)=>{
    if(v==null) return;
    if(Array.isArray(v)){ for(const x of v) visit(x,hintId,hintQ); return; }
    if(typeof v!=='object'){
      if(hintId!=null && hintQ!=null) add(hintId,hintQ,v);
      return;
    }

    // Normal row shape, e.g. {resourceId, quality, vwap}.
    const directId=v.resourceId ?? v.resource ?? v.productId ?? v.kind ?? v.dbLetter ?? null;
    const directQ=v.quality ?? v.q ?? v.resourceQuality ?? null;
    const directValue=v.vwap ?? v.VWAP ?? v.value ?? v.price ?? v.averagePrice ?? v.avgPrice;
    if(directId!=null && directQ!=null && directValue!=null) add(directId,directQ,directValue);

    // SimcoTools also returns wrapper shapes such as {vwaps:[...]}, and some
    // datasets are maps keyed by resource then quality. Handle both without
    // confusing the resource key with the quality key.
    for(const [k,x] of Object.entries(v)){
      if(x===v) continue;
      if(k==='vwaps'||k==='data'||k==='items'||k==='results'||k==='market'||k==='resources'){
        visit(x,hintId,hintQ); continue;
      }
      if(isNumericKey(k)){
        if(hintId==null) visit(x,Number(k),hintQ);
        else if(hintQ==null) visit(x,hintId,Number(k));
        else visit(x,hintId,hintQ);
      } else {
        visit(x,directId!=null?directId:hintId,directQ!=null?directQ:hintQ);
      }
    }
  };
  visit(data);
  return out;
}
function simcoVwapHistoryKey(resourceId,quality){return `${Number(resourceId)}:${Number(quality)}`;}
function warehouseVwapKeys(rows){
  const keys=new Set();
  for(const r of (rows||[])){
    const id=warehouseId(r), q=warehouseQuality(r), qty=warehouseQuantity(r);
    if(Number.isFinite(id)&&id>0&&Number.isFinite(q)&&Number.isFinite(qty)&&qty>0) keys.add(simcoVwapHistoryKey(id,q));
  }
  return keys;
}
function filterVwapRowsToWarehouse(vwapRows, warehouseRows){
  const keys=warehouseVwapKeys(warehouseRows);
  return (vwapRows||[]).filter(r=>keys.has(simcoVwapHistoryKey(r.resourceId,r.quality)));
}
// v2.5.320: price observation log for the Tools tab (movers / price history). Kept under its own
// storage key per realm so it never touches the realm store or sync write paths. Failures are swallowed.
let priceLogQueue=Promise.resolve();
function recordPriceObservations(realm,rows,atIso){
  const r=validRealmNumber(realm);
  if(r==null||!Array.isArray(rows)||!rows.length||!globalThis.SCM_TOOLS_CORE)return priceLogQueue;
  priceLogQueue=priceLogQueue.then(async()=>{
    const key=`scmPriceLog:${r}`;
    const got=await chrome.storage.local.get({[key]:null});
    const prev=got[key]&&got[key].v===1?got[key]:{v:1,realm:r,series:{}};
    const next=globalThis.SCM_TOOLS_CORE.appendObservations(prev,rows,Date.parse(atIso)||Date.now());
    next.realm=r;
    if(next.added>0)await chrome.storage.local.set({[key]:next});
  }).catch(e=>console.debug('price log write failed',e));
  return priceLogQueue;
}
function mergeDailyVwapHistory(existing, rows, day){
  const history={...(existing||{})};
  for(const r of rows){
    const key=simcoVwapHistoryKey(r.resourceId,r.quality);
    const arr=Array.isArray(history[key])?history[key].slice():[];
    const item={date:day,vwap:Number(r.value)};
    const idx=arr.findIndex(x=>x?.date===day);
    if(idx>=0) arr[idx]=item; else arr.push(item);
    arr.sort((a,b)=>String(a.date).localeCompare(String(b.date)));
    history[key]=arr;
  }
  return history;
}
async function hydrateSimcoCooldowns(){
  try{
    const saved=await chrome.storage.local.get({simcoToolsRateLimitUntil:0,simcoToolsRateLimitUntilByUrl:{}});
    simcoRateLimitUntil=Math.max(simcoRateLimitUntil,Number(saved.simcoToolsRateLimitUntil)||0);
    for(const [url,untilRaw] of Object.entries(saved.simcoToolsRateLimitUntilByUrl||{})){
      const until=Number(untilRaw); if(Number.isFinite(until)&&until>Date.now())simcoRateLimitUntilByUrl.set(url,Math.max(Number(simcoRateLimitUntilByUrl.get(url))||0,until));
    }
  }catch{}
}
async function persistSimcoCooldowns(){
  try{const byUrl={};for(const [url,until] of simcoRateLimitUntilByUrl.entries())if(Number(until)>Date.now())byUrl[url]=Number(until);await chrome.storage.local.set({simcoToolsRateLimitUntil:simcoRateLimitUntil,simcoToolsRateLimitUntilByUrl:byUrl});}catch{}
}
async function simcoFetch(url, timeoutMs=SIMCOTOOLS_TIMEOUT_MS){
  const normalizedUrl=String(url);
  await hydrateSimcoCooldowns();
  const knownCooldown=Number(simcoRateLimitUntilByUrl.get(normalizedUrl))||0;
  if(Math.max(knownCooldown,simcoRateLimitUntil)>Date.now()){const retryAt=new Date(Math.max(knownCooldown,simcoRateLimitUntil)).toISOString();if(typeof scmMobileNetLogBackground==='function')await scmMobileNetLogBackground({kind:'request-skipped',url:scmMobileNetSafeUrl(normalizedUrl),method:'GET',status:429,reason:'rate-limit-cooldown-active',retryAt});return {ok:false,status:429,text:'rate limit cooldown active',retryAt,rateLimited:true,skipped:true};}
  let lastError=null;
  for(let attempt=0;attempt<SIMCOTOOLS_RETRY_DELAYS_MS.length;attempt++){
    const waitMs=SIMCOTOOLS_RETRY_DELAYS_MS[attempt];
    if(waitMs) await new Promise(resolve=>setTimeout(resolve,waitMs+Math.floor(Math.random()*500)));
    await simcoAcquireRequestSlot();
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    let rateLimited=false;
    try{
      // A different request may have received 429 while this call was queued.
      await hydrateSimcoCooldowns();
      await simcoWaitForRateLimitCooldown();
      const spacing=Math.max(0,SIMCOTOOLS_MIN_REQUEST_SPACING_MS-(Date.now()-simcoLastRequestAt));
      if(spacing)await new Promise(resolve=>setTimeout(resolve,spacing));
      await simcoWaitForRateLimitCooldown();
      simcoLastRequestAt=Date.now();
      const requestStartedAt=Date.now();
      if(typeof scmMobileNetLogBackground==='function')await scmMobileNetLogBackground({kind:'request-start',url:scmMobileNetSafeUrl(normalizedUrl),method:'GET',startedAt:new Date(requestStartedAt).toISOString()});
      const response=await fetch(url,{method:'GET',cache:'no-store',headers:{accept:'application/json'},signal:controller.signal});
      const text=await response.text();
      if(typeof scmMobileNetLogBackground==='function')await scmMobileNetLogBackground({kind:'fetch',url:scmMobileNetSafeUrl(normalizedUrl),method:'GET',status:Number(response.status)||0,ok:Boolean(response.ok),durationMs:Date.now()-requestStartedAt,transport:'extension-background',contentType:String(response.headers?.get('content-type')||''),body:text?{truncated:text.length>4000,originalLength:text.length,preview:text.slice(0,4000)}:null});
      if(response.status===429){
        const until=simcoActivateRateLimitCooldown(response);
        simcoRateLimitUntilByUrl.set(normalizedUrl,until);
        await persistSimcoCooldowns();
        // Never retry a 429 per-request. Persisted global and per-URL cooldowns stop later jobs and survive worker restarts.
        return {ok:false,status:429,text,retryAt:new Date(until).toISOString(),rateLimited:true};
      }
      if(response.ok || (response.status>=400 && response.status<500)) return {ok:response.ok,status:response.status,text};
      lastError=new Error(`SimcoTools HTTP ${response.status}`);
      if(attempt===SIMCOTOOLS_RETRY_DELAYS_MS.length-1) return {ok:false,status:response.status,text};
    }catch(e){
      lastError=e?.name==='AbortError'
        ? new Error(`SimcoTools request timed out after ${Math.round(timeoutMs/1000)}s (attempt ${attempt+1}/${SIMCOTOOLS_RETRY_DELAYS_MS.length})`)
        : new Error(`SimcoTools network error: ${e?.message||String(e)} (attempt ${attempt+1}/${SIMCOTOOLS_RETRY_DELAYS_MS.length})`);
    }finally{clearTimeout(timer);simcoReleaseRequestSlot()}
  }
  throw lastError||new Error('SimcoTools request failed.');
}

async function loadBundledVwapFallback(){
  if(vwapFallbackPromise) return vwapFallbackPromise;
  vwapFallbackPromise=(async()=>{
    try{
      const response=await fetch(chrome.runtime.getURL(VWAP_FALLBACK_FILE),{cache:'no-store'});
      if(!response.ok) throw new Error(`Bundled VWAP fallback HTTP ${response.status}`);
      const payload=await response.json();
      const rows=normalizeSimcoVwapRows(payload?.rows??payload);
      if(!rows.length) throw new Error('Bundled VWAP fallback is empty.');
      return {ok:true,rows,fetchedAt:String(payload?.fetchedAt||''),source:String(payload?.source||'SimcoTools'),sourceVersion:String(payload?.sourceVersion||'')};
    }catch(e){
      return {ok:false,rows:[],error:e?.message||String(e)};
    }
  })();
  return vwapFallbackPromise;
}

async function seedBundledVwapFallback(reason='startup'){
  await ensureRealmStorageMigration();
  const s=await state();
  const activeKey=s.activeRealmKey||identityFromAuth(s.authData);
  const activeRealm=realmNumberFromKey(activeKey);
  if(activeRealm!==0) return {ok:false,error:'No bundled VWAP fallback is available for this realm.'};
  const fallback=await loadBundledVwapFallback();
  if(!fallback.ok||!fallback.rows.length) return {ok:false,error:fallback.error||'Bundled VWAP fallback unavailable.'};
  return withRealmWriteLock(0,async()=>{
    const latest=await state(0); const key=realmKeyFromRealm(0);
    const stores={...(latest.realmStores||{})}; const store={...(stores[key]||{})};
    const existing=store.vwapData;
    if(Array.isArray(existing?.rows)&&existing.rows.length&&Number(existing?.sourceRealm)===0) return {ok:true,existing:true,rows:existing.rows.length};
    const warehouseRows=Array.isArray(store.warehouseResources)?store.warehouseResources:(Array.isArray(latest?.warehouseResources)?latest.warehouseResources:[]);
    const warehouseVwaps=filterVwapRowsToWarehouse(fallback.rows,warehouseRows);
    const day=String(fallback.fetchedAt||'').slice(0,10)||new Date().toISOString().slice(0,10);
    const mergedHistory=mergeDailyVwapHistory(store.history||{},warehouseVwaps,day);
    const now=new Date().toISOString();
    const vwapData={rows:fallback.rows,fetchedAt:fallback.fetchedAt||now,updatedAt:now,source:'SimcoTools',sourceMode:'bundled-last-known-fallback',stale:true,fallback:true,fallbackReason:reason,fallbackSourceVersion:fallback.sourceVersion||null,endpoint:'/v1/realms/0/market/vwaps',count:fallback.rows.length,warehouseOnly:false,warehouseCombinations:warehouseVwaps.length,requestedCombinations:null,failedCombinations:0,datasetRows:fallback.rows.length,sourceRealm:0,warehouseRealm:0,failures:[],signature:vwapDatasetSignature(fallback.rows)};
    stores[key]={...store,vwapData,history:mergedHistory};
    const rootPatch=key===latest.activeRealmKey?{vwapData,history:mergedHistory}:{ };
    await storageSet({realmStores:stores,...rootPatch});
    return {ok:true,seeded:true,rows:fallback.rows.length,warehouseRows:warehouseVwaps.length};
  }).then(async(result)=>{
    if(result?.seeded){
      const statusState=await state();
      const key=realmKeyFromRealm(0);
      const store=statusState.realmStores?.[key]||{};
      const vd=store.vwapData||{};
      await setVwapStatus({message:`R1 VWAP fallback loaded: ${result.rows} values; live R1 refresh will retry.`,vwapRecords:result.rows,vwapWarehouseRecords:result.warehouseRows,vwapRequested:result.rows,vwapFailed:0,vwapFetchedAt:vd.fetchedAt,vwapUpdatedAt:vd.updatedAt,vwapSourceRealm:0,vwapWarehouseRealm:0,vwapWarehouseRows:Array.isArray(store.warehouseResources)?store.warehouseResources.length:0,vwapSyncing:false,vwapError:null,vwapFallback:true,vwapFallbackSourceVersion:vd.fallbackSourceVersion||null,vwapRealm:0});
    }
    return result;
  });
}
function parseSimcoResponse(text){
  try{return JSON.parse(text)}catch{return text}
}
function extractSimcoExactVwap(data){
  if(data==null) return null;
  if(typeof data==='number') return Number.isFinite(data)&&data>0?data:null;
  if(typeof data==='string'){
    const n=Number(data);
    return Number.isFinite(n)&&n>0?n:null;
  }
  if(Array.isArray(data)){
    for(const item of data){const v=extractSimcoExactVwap(item); if(v!=null) return v;}
    return null;
  }
  if(typeof data==='object'){
    for(const k of ['vwap','VWAP','value','price','averagePrice','avgPrice']){
      if(Object.prototype.hasOwnProperty.call(data,k)){
        const v=extractSimcoExactVwap(data[k]);
        if(v!=null) return v;
      }
    }
    for(const k of ['vwaps','data','items','results']){
      if(Object.prototype.hasOwnProperty.call(data,k)){
        const v=extractSimcoExactVwap(data[k]);
        if(v!=null) return v;
      }
    }
  }
  return null;
}
function vwapPairKey(resourceId,quality){return `${Number(resourceId)}:${Number(quality)}`;}
async function vwapPairsForRealm(store){
  const pairs=new Map();
  const add=(id,q)=>{const rid=Number(id),qual=Number(q);if(!Number.isFinite(rid)||rid<=0||!Number.isFinite(qual)||qual<0)return;pairs.set(vwapPairKey(rid,qual),{resourceId:rid,quality:qual});};
  const warehouse=Array.isArray(store?.warehouseResources)?store.warehouseResources:[];
  for(const r of warehouse)add(warehouseId(r),warehouseQuality(r));
  const buildings=Array.isArray(store?.buildings)?store.buildings:[];
  const recipes=await gameOverlayAssets();
  for(const b of buildings){
    const br=b?.busy?.resource||{};
    const outId=Number(br.kind??br.resourceId);
    const outQ=Number(br.quality);
    if(Number.isFinite(outId)&&outId>0&&Number.isFinite(outQ)&&outQ>=0){
      add(outId,outQ);
      const recipe=recipes.byName.get(String(br.name||'').trim().toLowerCase())||recipes.recipes.find(r=>Number(r.id)===outId);
      if(recipe){
        const minQ=Math.max(0,outQ-1);
        for(const mat of (recipe.materials||[])) add(Number(mat.id),minQ);
      }
    }
  }
  // Construction planner always prices these materials at Q0.
  for(const id of [101,102,108,111])add(id,0);
  return [...pairs.values()];
}
async function fetchSimcoVwapPairs(realm,pairs){
  const requested=Number.isFinite(Number(realm))?Number(realm):null;
  if(requested==null||!realmDefinition(requested))return {ok:false,rows:[],realm:requested,requested:0,failed:0,failures:[{error:'A valid realm is required for VWAP pair fetch.'}]};
  const list=Array.isArray(pairs)?pairs:[];
  const rows=[];const failures=[];const seen=new Set();
  const concurrency=1;
  let index=0;
  const worker=async()=>{
    while(true){
      const i=index++; if(i>=list.length) return;
      const pair=list[i];
      const rid=Number(pair?.resourceId),q=Number(pair?.quality);
      const url=`https://api.simcotools.com/v1/realms/${requested}/market/vwaps/${rid}/${q}`;
      try{
        const resp=await simcoFetch(url,15000);
        if(!resp.ok){const error=new Error(`HTTP ${resp.status}`);error.status=resp.status;error.retryAt=resp.retryAt||null;error.rateLimited=Boolean(resp.rateLimited);throw error;}
        const data=parseSimcoResponse(resp.text);
        const value=extractSimcoExactVwap(data);
        if(value==null) throw new Error('No exact VWAP value returned');
        const key=vwapPairKey(rid,q);
        if(!seen.has(key)){seen.add(key);rows.push({resourceId:rid,quality:q,value});}
      }catch(e){const failure={resourceId:rid,quality:q,error:e?.message||String(e)};if(Number(e?.status)===429||e?.rateLimited){failure.status=429;failure.rateLimited=true;failure.retryAt=e?.retryAt||null;}failures.push(failure);}
    }
  };
  await Promise.all(Array.from({length:Math.min(concurrency,list.length)},()=>worker()));
  return {ok:rows.length>0,rows,realm:requested,requested:list.length,failed:failures.length,failures};
}

async function fetchSimcoVwapDataset(realm){
  const requestedRealm=Number.isFinite(Number(realm))?Number(realm):null;
  if(requestedRealm==null || !realmDefinition(requestedRealm)){
    return {ok:false,rows:[],source:'SimcoTools',realm:requestedRealm,failed:0,total:0,failures:[{error:'A valid game realm is required for VWAP data.'}]};
  }
  // VWAP is strictly realm-specific. Never fall back to another realm.
  try{
    const url=`https://api.simcotools.com/v1/realms/${requestedRealm}/market/vwaps`;
    const resp=await simcoFetch(url);
    const data=parseSimcoResponse(resp.text);
    if(!resp.ok) return {ok:false,rows:[],source:'SimcoTools',realm:requestedRealm,failed:0,total:0,failures:[{error:`HTTP ${resp.status} from SimcoTools realm ${requestedRealm}`}]};
    const allRows=normalizeSimcoVwapRows(data);
    if(!allRows.length) return {ok:false,rows:[],source:'SimcoTools',realm:requestedRealm,failed:0,total:0,failures:[{error:`SimcoTools realm ${requestedRealm} returned no usable VWAP rows.`}]};
    return {ok:true,rows:allRows,allRows,source:'SimcoTools bulk',realm:requestedRealm,requestedRealm,failed:0,total:allRows.length,datasetRows:allRows.length,failures:[]};
  }catch(e){
    return {ok:false,rows:[],source:'SimcoTools',realm:requestedRealm,failed:0,total:0,failures:[{error:e?.message||String(e)}]};
  }
}

function vwapDatasetSignature(rows){
  return (Array.isArray(rows)?rows:[])
    .map(r=>`${Number(r?.resourceId)}:${Number(r?.quality)}:${Number(r?.value)}`)
    .sort()
    .join('|');
}

async function runVwapSyncUnlocked(options={}){
  const activeView=await state();
  const authRealm=Number(activeView.authData?.authCompany?.realmId), gameRealm=Number(activeView.gameState?.realm), storedRealm=activeView.activeRealmKey?Number(String(activeView.activeRealmKey).replace('realm:','')):null;
  const realm=Number.isFinite(Number(options.realm))?Number(options.realm):(Number.isFinite(authRealm)?authRealm:(Number.isFinite(gameRealm)?gameRealm:storedRealm));
  const targetKey=realmKeyFromRealm(realm);
  if(targetKey==null){await vwapLockedStatus({message:'VWAP sync requires a valid active realm.',vwapSyncing:false,vwapError:'No valid realm.'},realm);return {ok:false,error:'No valid realm.'};}
  // Explicit realm jobs (alarms, guards, overlays) may target an inactive realm.
  // state(realm) is mandatory here because state() intentionally exposes only
  // the active realm. Using state() caused inactive R1/R2 VWAP jobs to build a
  // target store from an empty snapshot and overwrite the target realm's
  // contracts, buildings, warehouse and endpoint data.
  const targetState=await state(realm);
  const targetStore={...(targetState.realmStores?.[targetKey]||{})};
  await vwapLockedStatus({message:`Syncing R${realm===0?'1':'2'} VWAP data from SimcoTools…`,vwapSyncing:true,vwapError:null,vwapRealm:realm},realm);
  const warehouseRows=Array.isArray(options.warehouseRows)&&options.warehouseRows.length?options.warehouseRows:(Array.isArray(targetStore.warehouseResources)?targetStore.warehouseResources:[]);
  const cached=targetStore.vwapData||null;
  const cachedRows=Array.isArray(cached?.rows)&&Number(cached?.sourceRealm)===realm?cached.rows:[];
  const cachedAt=Date.parse(String(cached?.fetchedAt||''));
  const cacheFresh=Number.isFinite(cachedAt)&&Date.now()-cachedAt<(15*60*1000)&&!cached?.stale&&!cached?.fallback&&Number(cached?.sourceRealm)===realm;
  const cachedDay=String(cached?.fetchedAt||'').slice(0,10),today=new Date().toISOString().slice(0,10);
  if(cachedRows.length&&cacheFresh&&cachedDay===today){
    const warehouseVwaps=filterVwapRowsToWarehouse(cachedRows,warehouseRows);
    const mergedHistory=mergeDailyVwapHistory(targetStore.history||{},warehouseVwaps,today);
    await vwapLockedCommit(realm,{history:mergedHistory},['history','vwapData']);
    await vwapLockedStatus({message:`R${realm===0?'1':'2'} VWAP data already current for ${today}: ${cachedRows.length} values; ${warehouseVwaps.length} warehouse matches.`,vwapRecords:cachedRows.length,vwapWarehouseRecords:warehouseVwaps.length,vwapRequested:cachedRows.length,vwapFailed:0,vwapFetchedAt:targetStore.vwapData.fetchedAt,vwapSourceRealm:realm,vwapWarehouseRealm:realm,vwapWarehouseRows:warehouseRows.length,vwapSyncing:false,vwapError:null,vwapRealm:realm},realm);
    return {ok:true,cached:true,records:warehouseVwaps.length,requested:cachedRows.length,failed:0,source:targetStore.vwapData.source||'SimcoTools',realm};
  }

  let result=await fetchSimcoVwapDataset(realm);
  let allVwaps=Array.isArray(result.allRows)?result.allRows:(Array.isArray(result.rows)?result.rows:[]);
  let sourceMode='live-bulk';
  let failures=(result.failures||[]).slice(0,50);

  // If the bulk dataset is unavailable, use the realm-specific per-resource/per-quality
  // endpoint. This never crosses realms and does not reuse another realm's data.
  if(!allVwaps.length){
    const pairs=await vwapPairsForRealm(targetStore);
    const pairResult=await fetchSimcoVwapPairs(realm,pairs);
    if(pairResult.rows.length){
      allVwaps=pairResult.rows;
      sourceMode='live-pairs';
      failures=pairResult.failures.slice(0,50);
    } else {
      failures=failures.concat(pairResult.failures.slice(0,20));
    }
  }

  // Last-known fallback exists only for R1 because the bundled file itself is R1 data.
  // It is explicitly stale and will never satisfy cacheFresh; R2 receives no fallback.
  if(!allVwaps.length && realm===0){
    const fallback=await loadBundledVwapFallback();
    if(fallback.ok&&fallback.rows.length){
      allVwaps=fallback.rows;
      sourceMode='bundled-last-known-fallback';
      failures=failures.slice(0,50);
    }
  }

  if(!allVwaps.length){
    const error=failures[0]?.error||`No VWAP values returned for R${realm===0?'1':'2'}.`;
    await vwapLockedStatus({message:`R${realm===0?'1':'2'} VWAP sync failed: ${error}`,vwapError:error,vwapSyncing:false,vwapRealm:realm},realm);
    return {ok:false,error,realm,failed:failures.length,requested:0};
  }

  const warehouseVwaps=filterVwapRowsToWarehouse(allVwaps,warehouseRows);
  const now=new Date().toISOString(),day=now.slice(0,10),mergedHistory=mergeDailyVwapHistory(targetStore.history||{},warehouseVwaps,day);
  const stale=sourceMode==='bundled-last-known-fallback';
  const vwapData={rows:allVwaps,fetchedAt:stale?(cached?.fetchedAt||now):now,updatedAt:now,source:'SimcoTools',sourceMode,stale,fallback:stale,endpoint:`/v1/realms/${realm}/market/vwaps`,count:allVwaps.length,warehouseOnly:false,warehouseCombinations:warehouseVwaps.length,requestedCombinations:sourceMode==='live-pairs'?allVwaps.length:null,failedCombinations:failures.length,datasetRows:result.datasetRows||allVwaps.length,sourceRealm:realm,warehouseRealm:realm,failures:failures.slice(0,50),signature:vwapDatasetSignature(allVwaps)};
  const nextWatch={...(targetStore.vwapWatch||DEFAULTS.vwapWatch),lastSourceRealm:realm};
  await vwapLockedCommit(realm,{vwapData,history:mergedHistory,vwapWatch:nextWatch},['vwapData','history','vwapWatch']);
  if(!stale)void recordPriceObservations(realm,allVwaps,now);
  await vwapLockedStatus({message:`R${realm===0?'1':'2'} VWAP sync ${stale?'loaded the R1 last-known fallback':'complete'}: ${allVwaps.length} values; ${warehouseVwaps.length} match the current warehouse.`,vwapRecords:allVwaps.length,vwapWarehouseRecords:warehouseVwaps.length,vwapRequested:sourceMode==='live-pairs'?allVwaps.length:allVwaps.length,vwapFailed:failures.length,vwapFetchedAt:vwapData.fetchedAt,vwapUpdatedAt:now,vwapSourceRealm:realm,vwapWarehouseRealm:realm,vwapWarehouseRows:warehouseRows.length,vwapSyncing:false,vwapError:stale?'Live VWAP fetch failed; using stale R1 fallback.':null,vwapFallback:stale,vwapRealm:realm},realm);
  return {ok:true,records:warehouseVwaps.length,requested:allVwaps.length,failed:failures.length,source:sourceMode,realm,stale};
}

function extractSimcoMarketObject(data){
  if(data==null)return {};
  if(Array.isArray(data)){
    for(const item of data){const out=extractSimcoMarketObject(item);if(out&&Object.keys(out).length)return out;}
    return {};
  }
  if(typeof data!=='object')return {};
  for(const k of ['data','result','market','resource','item']){
    if(data[k]&&typeof data[k]==='object'){
      const nested=extractSimcoMarketObject(data[k]);
      if(Object.keys(nested).length)return {...data,...nested};
    }
  }
  return data;
}
function extractSimcoNumber(data,keys){
  const root=extractSimcoMarketObject(data);
  for(const key of keys){
    const v=root?.[key];
    if(typeof v==='number'&&Number.isFinite(v))return v;
    if(typeof v==='string'&&v.trim()!==''&&Number.isFinite(Number(v)))return Number(v);
  }
  return null;
}
function extractSimcoText(data,keys){
  const root=extractSimcoMarketObject(data);
  for(const key of keys){
    const v=root?.[key];
    if(v==null)continue;
    if(typeof v==='object'){for(const nested of ['timestamp','time','date','at','value']){if(v[nested]!=null)return String(v[nested]);}}
    if(String(v).trim()!=='')return String(v);
  }
  return null;
}
function normalizeSimcoMarketSnapshot(data,resourceId,quality){
  const raw=extractSimcoMarketObject(data);
  // SimcoTools /market/resources responses are wrapped in `summary`. The
  // summary contains the actual current close/trade stream plus the 5-minute
  // candle. Keep support for an already-unwrapped response as well.
  const root=(raw?.summary&&typeof raw.summary==='object')?raw.summary:raw;
  const candle=root?.fiveMinutesCandlestick||root?.candlestick||root?.candle||root?.fiveMinute||root?.['5m']||root?.five_minute||{};
  const latest=Array.isArray(root?.latestClosePrices)?root.latestClosePrices.filter(x=>x?.closePrice!=null&&Number.isFinite(Number(x.closePrice))).at(-1)||null:null;
  const latestPrice=latest?extractSimcoNumber(latest,['closePrice','price','close']):null;
  const price=extractSimcoNumber(root,['price','currentPrice','last','lastPrice'])??latestPrice??extractSimcoNumber(candle,['close']);
  const lastDay=root?.lastDayCandlestick||raw?.lastDayCandlestick||{};
  const latestVolume=latest?extractSimcoNumber(latest,['volume','tradeVolume','quantity','count']):null;
  // Some SimcoTools products omit the five-minute volume but include a daily
  // candle or volume on the latest close record. Preserve that real source data
  // rather than rendering an empty statistic for those products.
  const directVolume=extractSimcoNumber(root,['volume','tradeVolume','lastVolume','marketVolume','quantity']);
  const candleReportedVolume=extractSimcoNumber(candle,['volume','tradeVolume','quantity','count']);
  const dailyVolume=extractSimcoNumber(lastDay,['volume','tradeVolume','quantity','count']);
  const volume=directVolume??candleReportedVolume??latestVolume??dailyVolume;
  const volumePeriod=(directVolume!=null||candleReportedVolume!=null||latestVolume!=null)?'Current market':'Latest daily candle';
  const explicitLastTrade=extractSimcoText(root,['lastTrade','lastTradeAt','lastTradeTime','tradeTime','lastTradeTimestamp']);
  const lastTrade=latest?.datetime??explicitLastTrade??extractSimcoText(root,['timestamp','updatedAt']);
  const open=extractSimcoNumber(candle,['open'])??extractSimcoNumber(root,['open']);
  const close=extractSimcoNumber(candle,['close'])??price;
  const high=extractSimcoNumber(candle,['high'])??extractSimcoNumber(root,['high']);
  const low=extractSimcoNumber(candle,['low'])??extractSimcoNumber(root,['low']);
  const candleVolume=extractSimcoNumber(candle,['volume','tradeVolume'])??volume;
  const fallbackVwap=extractSimcoNumber(lastDay,['vwap']);
  const dailyCandleVolume=extractSimcoNumber(lastDay,['volume','tradeVolume','quantity','count']);
  return {resourceId:Number(resourceId),quality:Number(quality),price,volume,volumePeriod,lastTrade,open,close,high,low,candleVolume:candleVolume??dailyCandleVolume,vwap:fallbackVwap,trend:simcoTrendFromSummary(root),raw};
}
// v2.5.330: SimcoTools' summary already carries the recent trade closes and the
// day-over-day VWAP change. Keep a compact copy so Price movers / Price history have
// real 24 h data immediately instead of waiting days for the Manager's own snapshots.
function simcoTrendFromSummary(root){
  if(!root||typeof root!=='object')return null;
  const closes=(Array.isArray(root.latestClosePrices)?root.latestClosePrices:[])
    .map(x=>[Date.parse(String(x?.datetime||x?.date||'')),Number(x?.closePrice??x?.close)])
    .filter(([t,p])=>Number.isFinite(t)&&Number.isFinite(p)&&p>0)
    .sort((a,b)=>a[0]-b[0]).slice(-80);
  const day=root.lastDayCandlestick&&typeof root.lastDayCandlestick==='object'?root.lastDayCandlestick:null;
  const n=v=>{if(v==null||v==='')return null;const x=Number(v);return Number.isFinite(x)?x:null;};
  const pct=v=>{const x=n(v);return x==null?null:x*100;};
  const t=Date.parse(String(root.timestamp||''));
  if(!closes.length&&!day)return null;
  return {at:Number.isFinite(t)?t:null,closes,day:day?{date:day.date||null,vwap:n(day.vwap),close:n(day.close),volume:n(day.volume),vwapChangePct:pct(day.previousVWAPPercentageChange),closeChangePct:pct(day.previousClosePercentageChange)}:null};
}
async function fetchSimcoMarketSnapshot(realm,resourceId,quality){
  const url=`https://api.simcotools.com/v1/realms/${realm}/market/resources/${resourceId}/${quality}`;
  const resp=await simcoFetch(url,12000);
  if(!resp.ok){const error=new Error(`HTTP ${resp.status}`);error.status=resp.status;error.retryAt=resp.retryAt||null;error.rateLimited=Boolean(resp.rateLimited);throw error;}
  return normalizeSimcoMarketSnapshot(parseSimcoResponse(resp.text),resourceId,quality);
}
function simcoCandleRows(data){
  const candidates=[
    data,
    data?.data,
    data?.candlesticks,
    data?.items,
    data?.results,
    data?.candles,
    data?.history,
    data?.data?.candlesticks,
    data?.data?.items,
    data?.data?.results,
    data?.result?.candlesticks,
    data?.result?.data
  ];
  return candidates.find(Array.isArray)||[];
}
function normalizeSimcoCandle(row){
  const pick=(...keys)=>{
    for(const key of keys){
      const value=row?.[key];
      if(value!==undefined&&value!==null&&value!==''){
        const number=Number(value);
        if(Number.isFinite(number))return number;
      }
    }
    return null;
  };
  const open=pick('open','openPrice','open_price','o');
  const high=pick('high','highPrice','high_price','h');
  const low=pick('low','lowPrice','low_price','l');
  const close=pick('close','closePrice','close_price','c','price');
  if(open===null||high===null||low===null||close===null)return null;
  return {
    time:row?.time??row?.timestamp??row?.date??row?.at??row?.datetime??row?.createdAt??null,
    open,high,low,close,
    volume:pick('volume','tradeVolume','quantity','count','v')
  };
}
async function fetchSimcoMarketCandles(realm,resourceId,quality){
  const url=`https://api.simcotools.com/v1/realms/${realm}/market/resources/${resourceId}/${quality}/candlesticks`;
  const resp=await simcoFetch(url,12000);
  if(!resp.ok)throw new Error(`HTTP ${resp.status}`);
  const data=parseSimcoResponse(resp.text);
  return simcoCandleRows(data).map(normalizeSimcoCandle).filter(Boolean);
}
function cachedSimcoVwapForProduct(store,resourceId,quality){
  const rows=Array.isArray(store?.vwapData?.rows)?store.vwapData.rows:[];
  const row=rows.find(x=>Number(x?.resourceId)===Number(resourceId)&&Number(x?.quality)===Number(quality));
  const value=row?.value??row?.vwap??row?.price;
  const v=value==null||value===''?null:Number(value);
  return Number.isFinite(v)&&v>0?v:null;
}
function validPositiveMarketNumber(value){
  if(value==null||value==='')return null;
  const n=Number(value);
  return Number.isFinite(n)&&n>0?n:null;
}
// v2.5.330: Price history for one product/quality from SimcoTools (daily candles +
// recent trade closes). Cached per realm in its own storage key; no storage lock is
// held while fetching.
const PRICE_HISTORY_TTL_MS=3*60*60*1000;
let priceHistoryWriteTail=Promise.resolve();
async function getPriceHistory(realm,resourceIdArg,qualityArg,force=false){
  const resourceId=Number(resourceIdArg),quality=Number(qualityArg);
  if(realm==null||!(resourceId>0)||!(quality>=0))return {ok:false,error:'Invalid product selection.'};
  const storeKey=`scmPriceHistory:${realm}`,pairKey=`${resourceId}:${quality}`;
  const cached=(await chrome.storage.local.get({[storeKey]:null}))[storeKey]?.pairs?.[pairKey]||null;
  if(!force&&cached&&Date.now()-Date.parse(cached.fetchedAt||0)<PRICE_HISTORY_TTL_MS)return {ok:true,cached:true,...cached};
  let daily=[],closes=[],errors=[];
  try{daily=(await fetchSimcoMarketCandles(realm,resourceId,quality)).map(c=>[Date.parse(String(c.time||'')),Number(c.close),Number(c.volume)||0]).filter(([t,p])=>Number.isFinite(t)&&p>0).sort((a,b)=>a[0]-b[0]);}catch(e){errors.push('candles: '+(e?.message||e));}
  try{const snap=await fetchSimcoMarketSnapshot(realm,resourceId,quality);closes=snap?.trend?.closes||[];}catch(e){errors.push('recent: '+(e?.message||e));}
  if(!daily.length&&!closes.length){if(cached)return {ok:true,cached:true,stale:true,error:errors.join('; '),...cached};return {ok:false,error:errors.join('; ')||'SimcoTools returned no history for this product.'};}
  const entry={resourceId,quality,daily,closes,fetchedAt:new Date().toISOString(),source:'SimcoTools'};
  priceHistoryWriteTail=priceHistoryWriteTail.catch(()=>{}).then(async()=>{
    const cur=(await chrome.storage.local.get({[storeKey]:null}))[storeKey]||{pairs:{}};
    const pairs={...(cur.pairs||{}),[pairKey]:entry};
    const keys=Object.keys(pairs).sort((a,b)=>Date.parse(pairs[b].fetchedAt||0)-Date.parse(pairs[a].fetchedAt||0));
    for(const k of keys.slice(40))delete pairs[k];
    await chrome.storage.local.set({[storeKey]:{v:1,realm,pairs}});
  });
  await priceHistoryWriteTail;
  return {ok:true,cached:false,...entry};
}
async function runLiveMarketProduct(realmArg,resourceIdArg,qualityArg){
  const realm=validRealmNumber(realmArg),resourceId=Number(resourceIdArg),quality=Number(qualityArg);
  if(realm==null||!Number.isFinite(resourceId)||resourceId<=0||!Number.isFinite(quality)||quality<0)return {ok:false,error:'Invalid market resource selection.'};

  // Fetch one selected SimcoTools product only. Preserve each completed product
  // by resource+quality so out-of-order responses cannot erase the user's selection.
  const selectedRaw=await fetchSimcoMarketSnapshot(realm,resourceId,quality);
  try{selectedRaw.candles=await fetchSimcoMarketCandles(realm,resourceId,quality);}catch{selectedRaw.candles=[];}
  // The candlestick endpoint can return no rows for thinly traded products.
  // In that case, use the real last-day candle if the snapshot supplies one;
  // do not invent intermediate candles or synthetic prices.
  if(!Array.isArray(selectedRaw.candles)||selectedRaw.candles.length===0){
    const raw=selectedRaw.raw||{};
    const summary=raw.summary&&typeof raw.summary==='object'?raw.summary:raw;
    const daily=summary.lastDayCandlestick||raw.lastDayCandlestick||summary.lastDayCandle||raw.lastDayCandle||null;
    const normalizedDaily=daily?normalizeSimcoCandle(daily):null;
    if(normalizedDaily)selectedRaw.candles=[normalizedDaily];
  }
  const checkedAt=new Date().toISOString();
  const key=realmKeyFromRealm(realm);
  let data=null;
  await withRealmWriteLock(realm,async()=>{
    const latest=await state(realm),stores={...(latest.realmStores||{})},store={...(stores[key]||{})};
    const currentPairKeys=new Set((Array.isArray(store.warehouseResources)?store.warehouseResources:[])
      .filter(row=>Number.isFinite(warehouseId(row))&&warehouseId(row)>0&&Number.isFinite(warehouseQuality(row))&&warehouseQuality(row)>=0&&warehouseQuantity(row)>0)
      .map(row=>vwapPairKey(warehouseId(row),warehouseQuality(row))));
    const bulkVwap=cachedSimcoVwapForProduct(store,resourceId,quality);
    const selected={...selectedRaw,vwap:validPositiveMarketNumber(selectedRaw?.vwap)??bulkVwap};
    const productKey=`${resourceId}:${quality}`;
    const productCache=Object.fromEntries(Object.entries(store.liveMarketProductCache||{}).filter(([cachedProductKey])=>currentPairKeys.has(cachedProductKey)));
    const existingProduct=productCache[productKey]&&typeof productCache[productKey]==='object'?productCache[productKey]:{};
    const existingPriceRows=Array.isArray(store?.liveMarketPriceData?.rows)?store.liveMarketPriceData.rows:[];
    const currentPriceData=new Map();
    for(const row of existingPriceRows){
      const id=Number(row?.resourceId),q=Number(row?.quality),price=validPositiveMarketNumber(row?.price);
      if(Number.isFinite(id)&&id>0&&Number.isFinite(q)&&q>=0&&price!=null)currentPriceData.set(`${id}:${q}`,{...row,resourceId:id,quality:q,price});
    }
    const selectedPrice=validPositiveMarketNumber(selected?.price);
    const selectedPriceRow={resourceId,quality,price:selectedPrice,lastTrade:selected.lastTrade||null,vwap:selected.vwap??bulkVwap,fetchedAt:checkedAt};
    // Do not overwrite a good cached exchange value with an empty/invalid payload.
    if(selectedPrice!=null)currentPriceData.set(productKey,selectedPriceRow);
    const qualityRows=Array.from(currentPriceData.values())
      .filter(row=>Number(row?.resourceId)===resourceId)
      .map(row=>({
        resourceId:Number(row.resourceId),quality:Number(row.quality),price:validPositiveMarketNumber(row.price),
        lastTrade:row.lastTrade||null,
        vwap:validPositiveMarketNumber(row.vwap)??cachedSimcoVwapForProduct(store,row.resourceId,row.quality)
      }))
      .sort((a,b)=>a.quality-b.quality);
    data={...existingProduct,resourceId,quality,selected,qualities:qualityRows,vwap:selected.vwap??bulkVwap,failures:[],fetchedAt:checkedAt,updatedAt:checkedAt,source:'SimcoTools'};
    productCache[productKey]=data;
    // Selected-product lookups must never replace the warehouse-wide current-price
    // dataset. That dataset is owned exclusively by runLiveMarketRefresh; a product
    // lookup updates only its own product cache and selected-product state.
    stores[key]={...store,liveMarketProduct:data,liveMarketProductCache:productCache};
    const rootPatch=key===latest.activeRealmKey?{liveMarketProduct:data,liveMarketProductCache:productCache}:{};
    await storageSet({realmStores:stores,...rootPatch});
  });
  scheduleGameOverlayRefreshNotification(realm,150);
  return {ok:true,realm,resourceId,quality,fetchedAt:checkedAt,failed:0,product:data};
}
async function runLiveMarketRefreshUnlocked(realmArg=null){
  const jobStartedMs=Date.now(),jobStartedAt=new Date(jobStartedMs).toISOString();
  await ensureRealmStorageMigration();
  const realm=validRealmNumber(realmArg);
  if(realm==null)return {ok:false,error:'No valid realm for live market refresh.'};
  const targetState=await state(realm),key=realmKeyFromRealm(realm),targetStore={...(targetState.realmStores?.[key]||{})};
  const pairs=[],seen=new Set();
  const addPair=(id,q)=>{const rid=Number(id),qual=Number(q),k=vwapPairKey(rid,qual);if(Number.isFinite(rid)&&rid>0&&Number.isFinite(qual)&&qual>=0&&!seen.has(k)){seen.add(k);pairs.push({resourceId:rid,quality:qual});}};
  const warehouseRows=Array.isArray(targetStore.warehouseResources)?targetStore.warehouseResources:[];
  for(const row of warehouseRows){const id=warehouseId(row),q=warehouseQuality(row),qty=warehouseQuantity(row);if(Number(qty)>0)addPair(id,q);}
  const cyclePairs=await vwapPairsForRealm(targetStore);for(const pair of cyclePairs)addPair(pair.resourceId,pair.quality);
  const assets=await gameOverlayAssets();
  for(const plan of Object.values(targetStore.productionPlans||{})){
    if(!plan||!String(plan.product||'').trim()||plan.mode==='disabled')continue;
    const outputId=Number(plan.productId??plan.resourceId),outputQ=Math.max(0,Number(plan.quality)||0);
    if(Number.isFinite(outputId)&&outputId>0){addPair(outputId,outputQ);const recipe=assets.byName.get(String(plan.product).trim().toLowerCase())||assets.recipes.find(r=>Number(r.id)===outputId);if(recipe)for(const material of (recipe.materials||[]))addPair(Number(material.id),Math.max(0,outputQ-1));}
  }
  const checkedAt=new Date().toISOString();
  const previousPriceData=targetStore.liveMarketPriceData&&typeof targetStore.liveMarketPriceData==='object'?targetStore.liveMarketPriceData:{};
  if(!pairs.length){
    const rows=Array.isArray(previousPriceData.rows)?previousPriceData.rows:[];
    const finishedAt=new Date().toISOString();
    await recordBackgroundJobEvent(realm,{job:'market-current-price-stage',trigger:'scheduled-or-message',startedAt:jobStartedAt,finishedAt,durationMs:Date.now()-jobStartedMs,outcome:'skipped',requested:0,fetched:0,refreshed:0,checked:0,cached:rows.length,stale:rows.length,error:'No stocked warehouse or production pairs were available; previous market data preserved.'}).catch(()=>{});
    return {ok:false,realm,skipped:true,requested:0,fetched:0,cached:rows.length,stale:rows.length,error:'No stocked warehouse or production pairs were available; previous market data was preserved.'};
  }
  const pairCooldowns={...(previousPriceData.rateLimitedUntilByPair||{})};
  const endpointCooldowns={...(previousPriceData.rateLimitedUntilByEndpoint||{})};
  const nowMs=Date.now();
  for(const [pairKey,until] of Object.entries(pairCooldowns))if(!Number.isFinite(Number(until))||Number(until)<=nowMs)delete pairCooldowns[pairKey];
  for(const [url,until] of Object.entries(endpointCooldowns)){if(!Number.isFinite(Number(until))||Number(until)<=nowMs)delete endpointCooldowns[url];else simcoRateLimitUntilByUrl.set(url,Number(until));}
  const out=[],failures=[];let index=0;let freshCacheHits=0;
  const existingPriceByKey=new Map((Array.isArray(previousPriceData.rows)?previousPriceData.rows:[]).map(row=>[vwapPairKey(row.resourceId,row.quality),row]));
  const worker=async()=>{while(true){const i=index++;if(i>=pairs.length)return;const pair=pairs[i],pairKey=vwapPairKey(pair.resourceId,pair.quality);
    if(realmSyncSessions.size>0){failures.push({resourceId:Number(pair.resourceId),quality:Number(pair.quality),error:'Deferred because core Sync started',deferredByCoreSync:true});continue;}
    const cachedRow=existingPriceByKey.get(pairKey);const cachedAt=Date.parse(String(cachedRow?.fetchedAt||''));
    if(cachedRow&&!cachedRow.stale&&validPositiveMarketNumber(cachedRow.price)!=null&&Number.isFinite(cachedAt)&&Date.now()-cachedAt<15*60*1000){freshCacheHits++;continue;}
    const cooldownUntil=Number(pairCooldowns[pairKey])||0;
    const endpoint=`https://api.simcotools.com/v1/realms/${realm}/market/resources/${pair.resourceId}/${pair.quality}`;
    const endpointCooldown=Number(endpointCooldowns[endpoint])||Number(simcoRateLimitUntilByUrl.get(endpoint))||0;
    if(Math.max(cooldownUntil,endpointCooldown,simcoRateLimitUntil)>Date.now()){
      const until=Math.max(cooldownUntil,endpointCooldown,simcoRateLimitUntil);
      failures.push({resourceId:Number(pair.resourceId),quality:Number(pair.quality),status:429,rateLimited:true,retryAt:new Date(until).toISOString(),error:'Skipped during shared rate-limit cooldown'});continue;
    }
    try{const snap=await fetchSimcoMarketSnapshot(realm,pair.resourceId,pair.quality);const price=validPositiveMarketNumber(snap?.price);if(price==null)throw new Error('No valid current price returned');delete pairCooldowns[pairKey];delete endpointCooldowns[endpoint];out.push({resourceId:Number(pair.resourceId),quality:Number(pair.quality),price,lastTrade:snap.lastTrade||null,trend:snap.trend||null,fetchedAt:new Date().toISOString(),stale:false});}
    catch(e){const failure={resourceId:Number(pair.resourceId),quality:Number(pair.quality),error:e?.message||String(e)};if(Number(e?.status)===429||e?.rateLimited){const parsed=Date.parse(String(e?.retryAt||''));const until=Number.isFinite(parsed)&&parsed>Date.now()?parsed:Date.now()+SIMCOTOOLS_PAIR_RATE_LIMIT_COOLDOWN_MS;pairCooldowns[pairKey]=until;endpointCooldowns[endpoint]=until;simcoRateLimitUntilByUrl.set(endpoint,until);failure.status=429;failure.rateLimited=true;failure.retryAt=new Date(until).toISOString();await persistSimcoCooldowns();}failures.push(failure);}
  }};
  await worker();
  const merged=new Map();
  for(const row of (Array.isArray(previousPriceData.rows)?previousPriceData.rows:[])){
    const id=Number(row?.resourceId),q=Number(row?.quality),price=validPositiveMarketNumber(row?.price),pairKey=vwapPairKey(id,q),cachedAt=Date.parse(String(row?.fetchedAt||''));
    const stillFresh=!row?.stale&&Number.isFinite(cachedAt)&&Date.now()-cachedAt<15*60*1000;
    if(id>0&&Number.isFinite(id)&&q>=0&&Number.isFinite(q)&&price!=null)merged.set(pairKey,{...row,resourceId:id,quality:q,price,fetchedAt:row.fetchedAt||previousPriceData.fetchedAt||null,stale:!stillFresh});
  }
  for(const row of out)merged.set(vwapPairKey(row.resourceId,row.quality),{...row,stale:false});
  const priceRows=[...merged.values()];
  const lastSuccessfulUpdate=out.map(row=>Date.parse(String(row.fetchedAt||''))).filter(Number.isFinite).reduce((max,value)=>Math.max(max,value),0);
  const lastSuccessfulUpdateAt=lastSuccessfulUpdate?new Date(lastSuccessfulUpdate).toISOString():(previousPriceData.updatedAt||previousPriceData.fetchedAt||null);
  const priceData={...previousPriceData,rows:priceRows,fetchedAt:lastSuccessfulUpdateAt,updatedAt:lastSuccessfulUpdateAt,lastAttemptAt:checkedAt,source:'SimcoTools',sourceMode:'live-warehouse-and-production-current-prices',realm,warehouseCount:warehouseRows.filter(row=>warehouseQuantity(row)>0).length,productionAndWarehousePairCount:pairs.length,requested:pairs.length,checked:pairs.length-failures.filter(f=>/cooldown/i.test(String(f.error||''))).length,fetched:out.length,updated:out.length,refreshed:out.length,cacheHits:freshCacheHits,cached:priceRows.filter(row=>row.stale).length,freshRows:out.length+freshCacheHits,staleRows:priceRows.filter(row=>row.stale).length,failed:failures.length,failures:failures.slice(0,50),rateLimitedUntilByPair:{...pairCooldowns},rateLimitedUntilByEndpoint:{...endpointCooldowns}};
  const productCache={...(targetStore.liveMarketProductCache||{})};
  for(const row of out){const productKey=`${row.resourceId}:${row.quality}`,existing=productCache[productKey]&&typeof productCache[productKey]==='object'?productCache[productKey]:{};const selected={...(existing.selected||{}),resourceId:row.resourceId,quality:row.quality,price:row.price,lastTrade:row.lastTrade,fetchedAt:row.fetchedAt};productCache[productKey]={...existing,resourceId:row.resourceId,quality:row.quality,selected,fetchedAt:row.fetchedAt,updatedAt:row.fetchedAt,source:'SimcoTools'};}
  await withRealmWriteLock(realm,async()=>{const latest=await state(realm),stores={...(latest.realmStores||{})},store={...(stores[key]||{})};stores[key]={...store,liveMarketPriceData:priceData,liveMarketProductCache:productCache};const rootPatch=key===latest.activeRealmKey?{liveMarketPriceData:priceData,liveMarketProductCache:productCache}:{};await storageSet({realmStores:stores,...rootPatch});});
  scheduleGameOverlayRefreshNotification(realm,150);
  const finishedAt=new Date().toISOString(),durationMs=Date.now()-jobStartedMs;
  // v2.5.328: nothing downloaded because every price was still fresh (<15 min) is a skip, not a failure.
  const outcome=out.length?(failures.length?'partial':'success'):((freshCacheHits>0&&!failures.length)?'skipped':'failure');
  await recordBackgroundJobEvent(realm,{job:'market-current-price-stage',trigger:'scheduled-or-message',startedAt:jobStartedAt,finishedAt,durationMs,outcome,requested:pairs.length,fetched:out.length,refreshed:out.length,checked:pairs.length-failures.filter(f=>/cooldown/i.test(String(f.error||''))).length,cacheHits:freshCacheHits,cached:priceRows.filter(row=>row.stale).length,stale:priceRows.filter(row=>row.stale).length,error:outcome==='failure'?'No fresh current-price data returned.':null,details:{failed:failures.length,rateLimited:failures.filter(f=>f.rateLimited).length}}).catch(()=>{});
  if(outcome!=='failure')notifyAfterPriceUpdate(realm).catch(()=>{});
  return {ok:out.length>0||freshCacheHits>0,realm,stage:'prices',requested:pairs.length,checked:pairs.length-failures.filter(f=>/cooldown/i.test(String(f.error||''))).length,fetched:out.length,refreshed:out.length,cacheHits:freshCacheHits,cached:priceRows.filter(row=>row.stale).length,stale:priceRows.filter(row=>row.stale).length,failed:failures.length,currentPricesUpdated:out.length,currentPricesFailed:failures.length,errors:failures.slice(0,10),startedAt:jobStartedAt,finishedAt,durationMs};
}

// All callers (scheduled, popup/message, and future triggers) share one refresh per realm.
async function runLiveMarketRefresh(realmArg=null){
  const realm=validRealmNumber(realmArg);
  if(realm==null)return {ok:false,error:'No valid realm for live market refresh.'};
  if(realmSyncSessions.has(realm))return {ok:false,realm,skipped:true,error:'Market refresh deferred until core Sync completes.'};
  const existing=simcoRefreshRuns.get(realm);
  if(existing)return existing;
  const run=runLiveMarketRefreshUnlocked(realm).finally(()=>{
    if(simcoRefreshRuns.get(realm)===run)simcoRefreshRuns.delete(realm);
  });
  simcoRefreshRuns.set(realm,run);
  return run;
}

// v2.5.328: the VWAP sync used to run entirely inside the realm storage queue, including its SimcoTools
// downloads (hundreds of spaced requests, rate-limit cooldowns of minutes). While it ran, every other write
// for that realm waited — so collecting resources in the game did not update the warehouse or the overlay
// until the market download finished. The network work now runs outside the queue; each storage write is
// its own short queued transaction. VWAP runs are still serialized with each other.
let vwapSyncTail=Promise.resolve();
function vwapLockedStatus(patch={},realmArg=null){const r=validRealmNumber(realmArg??patch?.vwapRealm);return enqueueApiStorage(()=>setVwapStatusUnlocked(patch,realmArg),r);}
function vwapLockedCommit(realm,realmPatch,mirrorKeys){return enqueueApiStorage(()=>commitLatestRealmPatch(realm,realmPatch,mirrorKeys),validRealmNumber(realm));}
async function runVwapSync(options={}){
  const hinted=validRealmNumber(options?.realm);
  if(hinted!=null&&realmSyncSessions.has(hinted))return {ok:false,realm:hinted,skipped:true,error:'VWAP sync deferred until core Sync completes.'};
  const run=vwapSyncTail.catch(()=>{}).then(()=>runVwapSyncUnlocked(options));
  vwapSyncTail=run.catch(()=>{});
  return run;
}

async function refreshRealmVwapDaily(reason='scheduled',realmArg=null){
  await ensureRealmStorageMigration();
  const s=await state();
  const realm=validRealmNumber(realmArg??s.activeRealmKey?.replace(/^realm:/,'')??s.authData?.authCompany?.realmId);
  if(realm==null)return {ok:false,error:'No active realm available for VWAP refresh.'};
  // Legacy callers are redirected to the shared staged scheduler; this helper
  // must never start an independent SimcoTools request burst.
  return scheduleMarketCycle(realm,`legacy-vwap-${reason}`);
}


const LIVE_MARKET_REFRESH_ALARM_NAME='scm-live-market-refresh';
const LIVE_MARKET_REFRESH_PERIOD_MINUTES=60;
const MARKET_STAGE_ALARM_PREFIX='scm-market-stage-r';
// Start optional market work as soon as core Sync releases its capture lock.
// Resource-image downloads continue independently and provide natural API quiet time.
const POST_SYNC_MARKET_COOLDOWN_MS=1000;
const MARKET_STAGE_COOLDOWN_MS=120000;
const MARKET_STAGE_REALM_COOLDOWN_MS=120000;
let liveMarketRefreshAlarmRun=null;
let marketStageRun=null;
function marketStageAlarmName(realm,stage){const n=validRealmNumber(realm);return n==null?null:`${MARKET_STAGE_ALARM_PREFIX}${n}-${stage}`;}
async function hasPendingMarketStageAlarm(){
  if(marketStageRun)return true;
  try{const all=await chrome.alarms.getAll();return all.some(a=>/^scm-market-stage-r[01]-(?:vwap|prices)$/.test(String(a?.name||'')));}catch{return Boolean(marketStageRun);}
}
async function scheduleMarketStage(realm,stage,delayMs=MARKET_STAGE_COOLDOWN_MS,reason='scheduled'){
  const n=validRealmNumber(realm),name=marketStageAlarmName(realm,stage);
  if(n==null||!name||!['vwap','prices'].includes(stage))return {ok:false,error:'Invalid market stage or realm.'};
  try{await chrome.alarms.create(name,{when:Date.now()+Math.max(1000,Number(delayMs)||0)});await recordBackgroundJobEvent(n,{job:`market-${stage}-stage-scheduled`,trigger:reason,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),durationMs:0,outcome:'success',details:{alarm:name,delayMs:Math.max(1000,Number(delayMs)||0)}}).catch(()=>{});return {ok:true,realm:n,stage,alarm:name,delayMs:Math.max(1000,Number(delayMs)||0),reason};}
  catch(e){return {ok:false,realm:n,stage,error:e?.message||String(e),reason};}
}
async function schedulePostSyncMarketRefresh(realm,reason='sync-complete'){
  return scheduleMarketCycle(realm,reason);
}
async function scheduleMarketCycle(realmArg,reason='scheduled-market-cycle'){
  const n=validRealmNumber(realmArg);if(n==null)return {ok:false,error:'Invalid realm for market cycle.'};
  if(await hasPendingMarketStageAlarm())return {ok:true,queued:false,skipped:true,reason:'market-cycle-already-pending'};
  const other=n===0?1:0;
  try{await chrome.storage.local.set({marketSyncCycleQueue:[n,other],marketSyncCycleStartedAt:new Date().toISOString(),marketSyncCycleReason:reason});}catch{}
  return scheduleMarketStage(n,'vwap',POST_SYNC_MARKET_COOLDOWN_MS,reason);
}
async function runMarketStage(realm,stage,reason='alarm'){
  const n=validRealmNumber(realm);if(n==null)return {ok:false,error:'Invalid realm for market stage.'};
  if(realmSyncSessions.size>0){await scheduleMarketStage(n,stage,POST_SYNC_MARKET_COOLDOWN_MS,'core-sync-active');return {ok:false,skipped:true,reason:'core-sync-active',realm:n,stage};}
  if(marketStageRun)return marketStageRun;
  marketStageRun=(async()=>{
    const startedAt=new Date().toISOString(),started=Date.now();let result;
    try{
      if(stage==='vwap') result=await runVwapSync({realm:n,reason:'staged-market-vwap'});
      else result=await runLiveMarketRefresh(n);
      await hydrateSimcoCooldowns();
      const cooldownRemaining=Math.max(0,simcoRateLimitUntil-Date.now());
      const stageFailures=result?.failures||result?.errors||result?.currentPriceErrors||[];
      const hasRateLimit=Boolean(cooldownRemaining>0 || stageFailures.some(f=>f?.rateLimited||Number(f?.status)===429));
      const deferredByCoreSync=stageFailures.some(f=>f?.deferredByCoreSync);
      const outcome=hasRateLimit?'rate-limited':(deferredByCoreSync?'deferred-core-sync':(result?.ok?(result?.failed?'partial':'success'):(result?.skipped?'skipped':'failure')));
      await recordBackgroundJobEvent(n,{job:`market-${stage}-stage`,trigger:reason,startedAt,finishedAt:new Date().toISOString(),durationMs:Date.now()-started,outcome,requested:Number(result?.requested||0),fetched:Number(result?.fetched||result?.records||result?.rows||0),refreshed:Number(result?.refreshed||0),failed:Number(result?.failed||0),cached:Number(result?.cached||0),stale:Number(result?.stale||0),error:result?.error||null,details:{result,cooldownUntil:simcoRateLimitUntil||null}}).catch(()=>{});
      if(hasRateLimit||deferredByCoreSync){
        const delay=deferredByCoreSync?POST_SYNC_MARKET_COOLDOWN_MS:Math.max(POST_SYNC_MARKET_COOLDOWN_MS,cooldownRemaining,MARKET_STAGE_COOLDOWN_MS);
        await scheduleMarketStage(n,stage,delay,hasRateLimit?`rate-limit-cooldown-${stage}`:`core-sync-deferred-${stage}`);
      }else if(stage==='vwap'){
        await scheduleMarketStage(n,'prices',MARKET_STAGE_COOLDOWN_MS,'vwap-stage-finished');
      }else{
        let queue=[];try{const saved=await chrome.storage.local.get({marketSyncCycleQueue:[]});queue=Array.isArray(saved.marketSyncCycleQueue)?saved.marketSyncCycleQueue.map(validRealmNumber).filter(x=>x!=null):[];}catch{}
        queue=queue.filter(r=>r!==n);
        try{await chrome.storage.local.set({marketSyncCycleQueue:queue});}catch{}
        const nextRealm=queue[0];
        if(nextRealm!=null)await scheduleMarketStage(nextRealm,'vwap',MARKET_STAGE_REALM_COOLDOWN_MS,'previous-realm-market-finished');
        else {try{await chrome.storage.local.set({marketSyncCycleQueue:[],marketSyncCycleFinishedAt:new Date().toISOString()});}catch{}}
      }
      return {ok:Boolean(result?.ok),realm:n,stage,result,durationMs:Date.now()-started};
    }catch(e){const error=e?.message||String(e);await hydrateSimcoCooldowns();await recordBackgroundJobEvent(n,{job:`market-${stage}-stage`,trigger:reason,startedAt,finishedAt:new Date().toISOString(),durationMs:Date.now()-started,outcome:simcoRateLimitUntil>Date.now()?'rate-limited':'failure',error}).catch(()=>{});if(simcoRateLimitUntil>Date.now())await scheduleMarketStage(n,stage,Math.max(POST_SYNC_MARKET_COOLDOWN_MS,simcoRateLimitUntil-Date.now()),`rate-limit-cooldown-${stage}`);else if(stage==='vwap')await scheduleMarketStage(n,'prices',MARKET_STAGE_COOLDOWN_MS,'vwap-stage-failed');return {ok:false,realm:n,stage,error};}
  })().finally(()=>{marketStageRun=null;});
  return marketStageRun;
}

async function ensureLiveMarketRefreshAlarm(reason='ensure'){
  try{
    const existing=await chrome.alarms.get(LIVE_MARKET_REFRESH_ALARM_NAME);
    if(existing)return {ok:true,created:false,alarm:existing,reason};
    await chrome.alarms.create(LIVE_MARKET_REFRESH_ALARM_NAME,{
      delayInMinutes:LIVE_MARKET_REFRESH_PERIOD_MINUTES,
      periodInMinutes:LIVE_MARKET_REFRESH_PERIOD_MINUTES
    });
    const alarm=await chrome.alarms.get(LIVE_MARKET_REFRESH_ALARM_NAME);
    return {ok:!!alarm,created:true,alarm:alarm||null,reason};
  }catch(e){
    return {ok:false,created:false,error:e?.message||String(e),reason};
  }
}

async function runScheduledLiveMarketRefresh(reason='scheduled'){
  if(liveMarketRefreshAlarmRun)return liveMarketRefreshAlarmRun;
  liveMarketRefreshAlarmRun=(async()=>{
    await ensureRealmStorageMigration();
    if(await hasPendingMarketStageAlarm())return {ok:true,skipped:true,reason:'market-stage-already-scheduled'};
    const s=await state();
    const selected=validRealmNumber(s.activeRealmKey?.replace(/^realm:/,'')??s.selectedRealm??s.authData?.authCompany?.realmId);
    const first=selected??0;
    const scheduled=await scheduleMarketCycle(first,reason);
    return {...scheduled,queued:true};
  })().finally(()=>{liveMarketRefreshAlarmRun=null;});
  return liveMarketRefreshAlarmRun;
}

const VWAP_WATCH_ALARM_NAME='scm-vwap-watch';

async function ensureVwapWatchAlarm(reason='ensure'){
  try{
    await chrome.alarms.clear(VWAP_WATCH_ALARM_NAME);
    return {ok:true,created:false,disabled:true,reason:'VWAP watch network requests are folded into staged market sync.',reason};
  }catch(e){return {ok:false,created:false,error:e?.message||String(e),reason};}
}









const RESOURCE_IMAGE_CACHE_TTL_MS = 7*24*60*60*1000;
let resourceImageManifestPromise=null;
async function resourceImageManifest(){
  if(!resourceImageManifestPromise){
    resourceImageManifestPromise=fetch(chrome.runtime.getURL('resource-image-manifest.json'),{cache:'no-store'}).then(r=>r.ok?r.json():null).catch(()=>null);
  }
  return resourceImageManifestPromise;
}
function bytesToDataUrl(bytes,mime='image/png'){
  let binary=''; const chunk=0x8000;
  for(let i=0;i<bytes.length;i+=chunk) binary+=String.fromCharCode(...bytes.subarray(i,i+chunk));
  return `data:${mime};base64,${btoa(binary)}`;
}
async function sha256Bytes(bytes){
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function migrateResourceImageCache(){
  const s=await state();
  const key=s.activeRealmKey||identityFromAuth(s.authData);
  if(!key) return {cache:{},meta:{}};
  const store=s.realmStores?.[key]||{};
  const imgs=await resourceImagesStore();
  return {cache:{...imgs.cache,...(store.resourceImageCache||{}),...(store.resourceImageData||{})},meta:{...imgs.meta,...(store.resourceImageMeta||{})},key};
}
// v2.5.361 performance: images are written to their own key only (scmResourceImages). Each image used to rewrite the
// ~1 MB realm store and the ~2 MB image key, and read the full state three times; the weekly validation (also 1 min
// after every extension update) did that for ~150 images in a row, flooding every open page with storage events.
async function saveResourceImages(cachePatch={},metaPatch={}){
  if(!Object.keys(cachePatch).length&&!Object.keys(metaPatch).length)return;
  return withRealmStorageCommit(async()=>{
    const cur=await resourceImagesStore();
    const next={cache:{...cur.cache,...cachePatch},meta:{...cur.meta,...metaPatch},updatedAt:new Date().toISOString()};
    await rawStorageSet({[RESOURCE_IMAGES_KEY]:next});
    resourceImagesMemo={cache:next.cache,meta:next.meta};
  });
}
async function fetchAndCacheResourceImage(id,{forceValidate=false,batch=null}={}){
  const n=Number(id); if(!Number.isFinite(n)||n<=0) return {ok:false,error:'Invalid resource id'};
  const {cache,meta,key}=batch?.base||await migrateResourceImageCache();
  if(!key) return {ok:false,error:'No active realm for resource image cache'};
  const sid=String(n), previous=meta[sid]||{};
  const now=Date.now();
  if(cache[sid] && !forceValidate && previous.validatedAt && now-Date.parse(previous.validatedAt)<RESOURCE_IMAGE_CACHE_TTL_MS){
    return {ok:true,dataUrl:cache[sid],cached:true,validatedAt:previous.validatedAt,changed:false};
  }
  const manifest=await resourceImageManifest();
  let catalog=batch?.catalog;
  if(!catalog){const stateNow=await state();const store=stateNow.realmStores?.[key]||{};catalog=store.resourceCatalog||stateNow.resourceCatalog||{};}
  const catalogImage=catalog?.resourceImages?.[sid] || catalog?.constantsResources?.[sid]?.image || null;
  const filename=manifest?.resources?.[sid];
  const rawUrl=catalogImage || previous.url || (filename ? `${String(manifest.baseUrl||'https://www.simcompanies.com/static/images/resources/').replace(/\/$/,'')}/${filename}` : null);
  if(!rawUrl) return cache[sid]?{ok:true,dataUrl:cache[sid],cached:true,changed:false}:{ok:false,error:'No resource image source is known.'};
  const url=/^https?:\/\//i.test(String(rawUrl))?String(rawUrl):`https://www.simcompanies.com/static/${String(rawUrl).replace(/^\/+/, '')}`;
  try{
    const r=await fetch(url,{cache:'no-store',credentials:'omit'});
    if(!r.ok) throw new Error(`Image HTTP ${r.status}`);
    const mime=(r.headers.get('content-type')||'image/png').split(';')[0];
    const bytes=new Uint8Array(await r.arrayBuffer());
    const hash=await sha256Bytes(bytes);
    const changed=Boolean(cache[sid]&&previous.sha256&&previous.sha256!==hash);
    const dataUrl=bytesToDataUrl(bytes,mime);
    let changedFinal=changed, validatedAt=new Date(now).toISOString();
    changedFinal=Boolean(cache[sid]&&previous.sha256&&previous.sha256!==hash);
    const sameImage=Boolean(cache[sid]&&previous.sha256===hash);
    const metaNext={url,filename,sha256:hash,validatedAt,updatedAt:changedFinal||!previous.sha256?validatedAt:(previous.updatedAt||validatedAt),status:'verified'};
    // unchanged image: only the small meta entry is updated (no 2 MB rewrite of the image data)
    if(batch){if(!sameImage)batch.cache[sid]=dataUrl;batch.meta[sid]=metaNext;}
    else await saveResourceImages(sameImage?{}:{[sid]:dataUrl},{[sid]:metaNext});
    return {ok:true,dataUrl,cached:false,changed:changedFinal,validatedAt,url};
  }catch(e){
    if(cache[sid]) return {ok:true,dataUrl:cache[sid],cached:true,stale:true,error:e?.message||String(e)};
    return {ok:false,error:e?.message||String(e)};
  }
}
async function syncAllResourceImages({forceValidate=false}={}){
  const jobStarted=Date.now(),jobStartedAt=new Date(jobStarted).toISOString();
  const manifest=await resourceImageManifest();
  const ids=Object.keys(manifest?.resources||{}).map(Number).filter(Number.isFinite);
  let updated=0,verified=0,failed=0;
  // v2.5.361 one state read and ONE image write for the whole run (was one full read + two big writes per image).
  const base=await migrateResourceImageCache();const s0=await state();const catalog=(base.key&&s0.realmStores?.[base.key]?.resourceCatalog)||s0.resourceCatalog||{};
  const batch={base,catalog,cache:{},meta:{}};
  const queue=[...ids], workers=Array.from({length:4},async()=>{
    while(queue.length){
      const id=queue.shift();
      const r=await fetchAndCacheResourceImage(id,{forceValidate,batch});
      if(r.ok){verified++;if(r.changed||!r.cached)updated++;}else failed++;
    }
  });
  await Promise.all(workers);
  await saveResourceImages(batch.cache,batch.meta);
  const s=await state(); const key=s.activeRealmKey||identityFromAuth(s.authData); const realm=realmNumberFromKey(key); if(realm!=null){
    await withRealmWriteLock(realm,async()=>{
      const latest=await state(realm); const stores={...(latest.realmStores||{})}; const store={...(stores[key]||{})};
      const status={lastRunAt:new Date().toISOString(),forceValidate,resourceCount:ids.length,verified,updated,failed};
      store.resourceImageCacheStatus=status; stores[key]=store;
      const patch={realmStores:stores}; if(key===latest.activeRealmKey) patch.resourceImageCacheStatus=status;
      await storageSet(patch);
    });
  }
  const finishedAt=new Date().toISOString();
  if(realm!=null) await recordBackgroundJobEvent(realm,{job:'resource-image-cache-sync',trigger:forceValidate?'forced-validation':'startup-or-install',startedAt:jobStartedAt,finishedAt,durationMs:Date.now()-jobStarted,outcome:failed?(verified?'partial':'failure'):'success',requested:ids.length,fetched:updated,refreshed:updated,checked:verified,cached:Math.max(0,verified-updated),stale:0,error:failed?`${failed} resource image(s) failed to validate.`:null,details:{resourceCount:ids.length,verified,updated,failed,forceValidate}}).catch(()=>{});
  return {ok:true,resourceCount:ids.length,verified,updated,failed,durationMs:Date.now()-jobStarted};
}


function criticalContractRowsFromStore(store){
  const rows=[];
  const ep=store?.endpointData&&typeof store.endpointData==='object'?store.endpointData:{};
  for(const [url,entry] of Object.entries(ep)){
    if(!/\/api\/v3\/contracts-(?:incoming|outgoing)\//i.test(String(url||'')))continue;
    if(Number(entry?.status)<200||Number(entry?.status)>=300)continue;
    rows.push(...helperArray(entry?.data,['incomingContracts','outgoingContracts','contracts','data','items','results']));
  }
  return rows;
}
function criticalDataCounts(store){
  const ep=store?.endpointData&&typeof store.endpointData==='object'?store.endpointData:{};
  const contracts=criticalContractRowsFromStore(store).length;
  const vwap=Array.isArray(store?.vwapData?.rows)?store.vwapData.rows.length:0;
  return {contracts,vwap};
}
async function persistCriticalDataBaseline(realm,reason='sync-complete'){
  const n=validRealmNumber(realm); if(n==null)return {ok:false,error:'Invalid realm.'};
  const key=realmKeyFromRealm(n);
  let baseline=null;
  await withRealmWriteLock(n,async()=>{
    const latest=await state(n); const latestStores={...(latest.realmStores||{})}; const latestStore={...(latestStores[key]||{})};
    const counts=criticalDataCounts(latestStore);
    baseline={version:1,realm:n,capturedAt:new Date().toISOString(),reason,contracts:counts.contracts,vwap:counts.vwap};
    latestStore.criticalDataBaseline=baseline; latestStores[key]=latestStore;
    const patch={realmStores:latestStores}; if(latest.activeRealmKey===key)patch.criticalDataBaseline=baseline;
    await storageSet(patch);
  });
  return {ok:true,realm:n,baseline};
}
async function refreshContractsScheduled(reason='critical-data-guard',realmArg=null){
  const realm=validRealmNumber(realmArg); if(realm==null)return {ok:false,error:'Invalid realm.'};
  const results=[];
  for(const path of realmContractPaths(realm)){
    try{const r=await pageGet(path,realm); const ok=!!r?.ok; results.push({path,ok,status:Number(r?.status)||0}); if(ok)await saveData(path,r.data,r.status,'GET',realm);}catch(e){results.push({path,ok:false,status:0,error:e?.message||String(e)});}
  }
  const s=await state(realm); const key=realmKeyFromRealm(realm); const count=criticalContractRowsFromStore(s.realmStores?.[key]||{}).length;
  return {ok:results.every(x=>x.ok)&&count>0,realm,reason,results,count};
}
const CRITICAL_DATA_GUARD_ALARM='scm-critical-data-guard';
async function ensureCriticalDataGuard(reason='ensure'){try{await chrome.alarms.create(CRITICAL_DATA_GUARD_ALARM,{delayInMinutes:10,periodInMinutes:10});return {ok:true,reason};}catch(e){return {ok:false,error:e?.message||String(e)}}}
async function runCriticalDataGuard(reason='scheduled'){
  const report=[];
  for(const realm of [0,1]){
    try{
      const s=await state(realm); const key=realmKeyFromRealm(realm); const store=s.realmStores?.[key]||{}; const baseline=store.criticalDataBaseline;
      if(!baseline||Number(baseline.realm)!==realm){report.push({realm,skipped:'no-baseline'});continue;}
      const before=criticalDataCounts(store); const actions=[];
      if(Number(baseline.contracts)>0&&before.contracts===0){actions.push('contracts');await refreshContractsScheduled(reason,realm).catch(()=>{});}
      if(Number(baseline.vwap)>0&&before.vwap===0){actions.push('vwap');await scheduleMarketCycle(realm,'critical-data-guard').catch(()=>{});}
      const afterState=await state(realm); const after=criticalDataCounts(afterState.realmStores?.[key]||{});
      const required={contracts:Number(baseline.contracts)||0,vwap:Number(baseline.vwap)||0};
      const recovered=after.contracts>=required.contracts&&after.vwap>=required.vwap;
      report.push({realm,before,after,actions,recovered,baseline:required});
      if(actions.length&&recovered)await persistCriticalDataBaseline(realm,'critical-data-guard-revalidated').catch(()=>{});
    }catch(e){report.push({realm,error:e?.message||String(e)});}
  }
  return {ok:true,reason,report};
}

const INSTALL_KEEP_ALARM_PREFIXES=['scm-building-','scm-prodfin:','scm-followup:','scm-daily-summary',GAME_CONSTANTS_ALARM,ACCOUNTING_WEEK_REFRESH_ALARM_PREFIX,ACCOUNTING_DAY_WALK_ALARM_PREFIX,ACCOUNTING_WALK_DAILY_ALARM];
// v2.5.345 Chrome drops an extension's alarms when it is updated (and may on a browser restart), so the alarms that
// carry your state are re-created from storage: building reminders (buildingAlarms) and batch-finished alerts
// (from the stored buildings). Storage reads + alarm calls only, no network, no lock.
async function restorePersistedAlarms(reason='restore'){
  const out={reason,buildingReminders:0,production:[]};
  for(const n of [0,1]){
    try{
      const st=(await chrome.storage.local.get({[`scmRealmStore:${n}`]:null}))[`scmRealmStore:${n}`]||{};
      for(const a of Object.values(st.buildingAlarms||{})){
        const bid=Number(a?.buildingId),when=Number(a?.readyAt);if(!(bid>0)||!(when>Date.now()))continue;
        const name=`scm-building-${n}-${bid}`;if(!(await chrome.alarms.get(name))){await chrome.alarms.create(name,{when});out.buildingReminders++;}
      }
      if(Array.isArray(st.buildings)&&st.buildings.length)out.production.push(await scheduleProductionFinishAlarms(n,st.buildings));
      // v2.5.370 a scheduled / interrupted Accounting day walk survives an update or restart.
      const walk=st.accountingDayWalkStatus;
      if(walk&&(walk.status==='scheduled'||walk.status==='running')){const name=`${ACCOUNTING_DAY_WALK_ALARM_PREFIX}${n}`;if(!(await chrome.alarms.get(name))){await chrome.alarms.create(name,{when:Date.now()+15000});out.accountingDayWalk=(out.accountingDayWalk||0)+1;}}
    }catch(e){out.error=e?.message||String(e);}
  }
  return out;
}
chrome.runtime.onInstalled.addListener(async()=>{
  const current=await chrome.storage.local.get(null);
  // Preserve existing physical realm containers and global settings, but do
  // not recreate the old root mirror for realm-owned caches.
  const globalPatch={};
  for(const key of Object.keys(GLOBAL_DEFAULTS)){
    if(key==='realmStores'||key==='scmRealmStoreSchema'||key==='activeRealmKey') continue;
    if(Object.prototype.hasOwnProperty.call(current,key)) globalPatch[key]=current[key];
  }
  globalPatch.selectedRealm=current.selectedRealm??null;
  globalPatch.activeRealmKey=current.activeRealmKey??null;
  await storageSet(globalPatch);
  await ensureRealmStorageMigration();
  // v2.5.345 an update used to clear every alarm, dropping the building reminders you set, batch-finished
  // alerts, follow-ups, the daily summary and the constants refresh. Only the scheduler alarms re-created below
  // (and retired legacy ones) are cleared now.
  for(const a of await chrome.alarms.getAll()){if(!INSTALL_KEEP_ALARM_PREFIXES.some(p=>String(a?.name||'').startsWith(p)))await chrome.alarms.clear(a.name);}
  await ensureLiveMarketRefreshAlarm('installed');
  await chrome.alarms.create('scm-vwap-daily',{periodInMinutes:720});
  await chrome.alarms.create('scm-production-events-daily',{periodInMinutes:720});
  await chrome.alarms.create('scm-production-events-watch',{delayInMinutes:15,periodInMinutes:15});
  await ensureCriticalDataGuard('installed');
  await ensureVwapWatchAlarm('installed');
  await chrome.alarms.create('scm-resource-image-validation',{delayInMinutes:1,periodInMinutes:10080});
  await restorePersistedAlarms('installed').catch(()=>{});
  await ensureAccountingWalkSchedule('installed').catch(()=>{});
  syncAllResourceImages({forceValidate:false}).catch(()=>{});
  const installRealmState=await state();
  const installRealm=validRealmNumber(installRealmState.activeRealmKey?.replace(/^realm:/,'')??installRealmState.selectedRealm??installRealmState.authData?.authCompany?.realmId);
  if(installRealm===0) await seedBundledVwapFallback('install-seed').catch(()=>{});
  if(installRealm!=null) scheduleMarketCycle(installRealm,'install-complete').catch(()=>{});
});
chrome.runtime.onStartup.addListener(async()=>{
  await ensureLiveMarketRefreshAlarm('service-worker-startup');
  await restorePersistedAlarms('browser-startup').catch(()=>{});
  await ensureAccountingWalkSchedule('browser-startup').catch(()=>{});
  await recoverInterruptedSyncJobs('service-worker-startup');
  await ensureVwapWatchAlarm('service-worker-startup');
  await ensureCriticalDataGuard('startup');
  try{
    const s=await chrome.storage.local.get({activeRealmKey:null,selectedRealm:null,authData:null});
    const realm=validRealmNumber(s.activeRealmKey?.replace(/^realm:/,'')??s.selectedRealm??s.authData?.authCompany?.realmId);
    if(realm===0) await seedBundledVwapFallback('startup-seed').catch(()=>{});
    if(realm!=null) await refreshRealmVwapDaily('startup',realm);
  }catch{}
  const watchState=await chrome.storage.local.get({activeRealmKey:null,selectedRealm:null,authData:null});
  const watchRealm=validRealmNumber(watchState.activeRealmKey?.replace(/^realm:/,'')??watchState.selectedRealm??watchState.authData?.authCompany?.realmId);
  if(watchRealm!=null) scheduleMarketCycle(watchRealm,'startup-check').catch(()=>{});
  syncAllResourceImages({forceValidate:false}).catch(()=>{});
});
async function scanOpenGameTabsForProductionEvents(reason='scheduled') {
  let tabs=[];
  try {
    tabs=await chrome.tabs.query({url:['https://www.simcompanies.com/*','https://simcompanies.com/*']});
  } catch { return {ok:false,reason:'tabs-query-failed',scanned:0}; }
  const results=[];
  for(const tab of Array.isArray(tabs)?tabs:[]){
    if(!tab?.id) continue;
    try{
      const response=await chrome.tabs.sendMessage(tab.id,{type:'CAPTURE_PRODUCTION_EVENTS',reason});
      results.push({tabId:tab.id,ok:response?.ok!==false});
    }catch(e){
      results.push({tabId:tab.id,ok:false,error:e?.message||String(e)});
    }
  }
  const s=await state();
  const realm=validRealmNumber(s.activeRealmKey?.replace(/^realm:/,'')??s.selectedRealm??s.authData?.authCompany?.realmId);
  if(realm!=null){
    const key=realmKeyFromRealm(realm);
    await withRealmWriteLock(realm,async()=>{
      const latest=await state(realm);
      const stores={...(latest.realmStores||{})};
      const store={...(stores[key]||{})};
      const existing=store.productionEventMonitor||{};
      const monitor={...existing,lastCheckAt:new Date().toISOString(),lastCheckReason:String(reason||'scheduled'),tabsScanned:results.length,successfulScans:results.filter(x=>x.ok).length};
      store.productionEventMonitor=monitor;
      stores[key]=store;
      const patch={realmStores:stores};
      if(key===latest.activeRealmKey) patch.productionEventMonitor=monitor;
      await storageSet(patch);
    });
  }
  return {ok:true,scanned:results.length,results};
}

chrome.alarms.onAlarm.addListener(async a=>{
  if(String(a?.name||'').startsWith('scm-building-')){
    try{
      const m=String(a.name).match(/^scm-building-(\d+)-(\d+)$/);if(!m)return;const realm=Number(m[1]),buildingId=Number(m[2]);const s=await state(realm),key=realmKeyFromRealm(realm),store=s.realmStores?.[key]||{};const buildings=realmStoredBuildings(store,s,realm);await withRealmWriteLock(realm,async()=>{const latest=await state(realm),latestStore=latest.realmStores?.[key]||{},alarms={...(latestStore.buildingAlarms||{})};delete alarms[String(buildingId)];const stores={...(latest.realmStores||{})};stores[key]={...latestStore,buildingAlarms:alarms};await storageSet({realmStores:stores});});const b=buildings.find(x=>Number(x?.id)===buildingId);const tabs=await chrome.tabs.query({url:['https://www.simcompanies.com/*','https://simcompanies.com/*']});for(const tab of tabs||[])try{await chrome.tabs.sendMessage(tab.id,{type:'BUILDING_ALARM_FIRED',realm,buildingId,buildingName:b?.name||`Building ${buildingId}`,resourceName:b?.busy?.resource?.name||'Building job'});}catch{}return;
    }catch{return;}
  }

  const buildingEnrichMatch=String(a?.name||'').match(/^scm-building-enrich-r([01])$/);
  if(buildingEnrichMatch){
    const realm=Number(buildingEnrichMatch[1]);
    try{
      if(syncSessionForRealm(realm)){
        const name=`scm-building-enrich-r${realm}`;
        await chrome.alarms.create(name,{when:Date.now()+5000});
        return;
      }
      await postSyncBuildingUiRefresh(realm,()=>{}).catch(()=>{});
      try{scheduleGameOverlayRefreshNotification(realm,150);}catch{}
    }catch{}
    return;
  }

  if(a?.name===ACCOUNTING_WALK_DAILY_ALARM){await runScheduledAccountingWalk('alarm').catch(()=>{});return;}
  const dayWalkMatch=String(a?.name||'').match(/^scm-accounting-day-walk-r([01])$/);
  if(dayWalkMatch){
    const realm=Number(dayWalkMatch[1]);
    if(syncSessionForRealm(realm)){await chrome.alarms.create(a.name,{when:Date.now()+5000}).catch(()=>{});return;}
    await runAccountingDayWalk(realm,'after-sync').catch(()=>{});
    return;
  }
  const accountingWeekMatch=String(a?.name||'').match(/^scm-accounting-week-refresh-r([01])$/);
  if(accountingWeekMatch){
    const realm=Number(accountingWeekMatch[1]);
    try{
      if(syncSessionForRealm(realm)){
        const name=accountingWeekRefreshAlarmName(realm);
        if(name)await chrome.alarms.create(name,{when:Date.now()+5000});
        return;
      }
      try{
        await runDeferredAccountingWeekRefresh(realm,'alarm');
      }catch(e){
        const error=e?.message||String(e);
        try{
          await setAccountingWeekLedgerStatus(realm,'retrying',error,{retryAt:new Date(Date.now()+ACCOUNTING_WEEK_REFRESH_RETRY_MS).toISOString()});
          const name=accountingWeekRefreshAlarmName(realm);
          if(name)await chrome.alarms.create(name,{when:Date.now()+ACCOUNTING_WEEK_REFRESH_RETRY_MS});
        }catch{}
      }
    }catch{}
    return;
  }

  const marketStageMatch=String(a?.name||'').match(/^scm-market-stage-r([01])-(vwap|prices)$/);
  if(marketStageMatch){await runMarketStage(Number(marketStageMatch[1]),marketStageMatch[2],'alarm').catch(()=>{});return;}
  const legacyPostSyncMatch=String(a?.name||'').match(/^scm-post-sync-market-r([01])$/);
  if(legacyPostSyncMatch){await runMarketStage(Number(legacyPostSyncMatch[1]),'vwap','legacy-post-sync-alarm').catch(()=>{});return;}
  if(a.name===LIVE_MARKET_REFRESH_ALARM_NAME){ await runScheduledLiveMarketRefresh('hourly-market-cycle').catch(()=>{}); return; }
  if(a.name===CRITICAL_DATA_GUARD_ALARM){ await runCriticalDataGuard('scheduled').catch(()=>{}); return; }
  if(a.name==='scm-vwap-daily'||a.name==='scm-vwap-retry'){
    await runScheduledLiveMarketRefresh('legacy-vwap-alarm').catch(()=>{});
  }
  if(a.name==='scm-production-events-daily') scanOpenGameTabsForProductionEvents('daily').catch(()=>{});
  if(a.name==='scm-production-events-watch') scanOpenGameTabsForProductionEvents('watch').catch(()=>{});
  if(a.name===VWAP_WATCH_ALARM_NAME){
    // Legacy watcher alarms are intentionally ignored: VWAP network reads now
    // occur only in the staged market-sync pipeline.
    await chrome.alarms.clear(VWAP_WATCH_ALARM_NAME).catch(()=>{});
  }
  // v2.5.361 the install/update handler re-creates this alarm 1 min after every update; re-validate at most once a week.
  if(a.name==='scm-resource-image-validation') (async()=>{const r=await chrome.storage.local.get({scmResourceImagesValidatedAt:0});if(Date.now()-Number(r.scmResourceImagesValidatedAt||0)<6.5*24*3600e3)return;const res=await syncAllResourceImages({forceValidate:true});if(res?.ok)await rawStorageSet({scmResourceImagesValidatedAt:Date.now()});})().catch(()=>{});
});
function endpointCapturedAfter(s,target,sinceMs){
  const ep=s.endpointData||{};
  const since=Number(sinceMs)||0;
  const patterns={
    warehouse:[/\/api\/v3\/resources\/\d+(?:\/|\?|$)/i],
    buildings:[/\/api\/v2\/companies\/me\/buildings\/?(?:\?.*)?$/i],
    accounting:[
      /\/api\/v2\/companies\/(?:me|\d+)\/(?:balance-sheet|cashflow(?:\/recent)?|cashflow-statement|income-statement|past-finances-overview|administration-overhead)(?:\/\d+)?\/?(?:\?.*)?$/i,
      /\/api\/v3\/companies\/(?:me|\d+)\/past-finances(?:\/\d+)?\/?(?:\?.*)?$/i
    ],
    contracts:[
      /\/api\/v3\/contracts-incoming\/\d+\/me(?:\/\d+)?\/?(?:\?.*)?$/i,
      /\/api\/v3\/contracts-outgoing\/me(?:\/\d+)?\/?(?:\?.*)?$/i,
      /\/api\/v2\/warehouse-contracts-summary\/\d+\/o(?:\/\d+)?\/?(?:\?.*)?$/i
    ],
  };
  const rx=patterns[String(target||'').toLowerCase()];
  if(!rx) return null;
  let best=null;
  for(const url of Object.keys(ep)){
    if(!rx.some(r=>r.test(url))) continue;
    const item=ep[url]||{};
    const received=Date.parse(item.receivedAt||'');
    if(!Number.isFinite(received) || received<since) continue;
    if(Number(item.status)<200 || Number(item.status)>=300) continue;
    if(item.data==null) continue;
    if(!best || received>best.receivedAtMs) best={endpoint:url,receivedAtMs:received,status:item.status||0};
  }
  return best;
}
function endpointDataForSyncRealm(s, realm){
  const n=validRealmNumber(realm);
  if(n!=null){
    const key=realmKeyFromRealm(n);
    const store=s.realmStores?.[key];
    if(store?.endpointData && typeof store.endpointData==='object') return store.endpointData;
  }
  return s.endpointData&&typeof s.endpointData==='object'?s.endpointData:{};
}
function endpointCapturedAfterForRealm(s,target,sinceMs,realm){
  const view={...s,endpointData:endpointDataForSyncRealm(s,realm)};
  return endpointCapturedAfter(view,target,sinceMs);
}
async function waitForEndpointCapture(target,sinceMs,timeoutMs=15000,realm=null){
  const deadline=Date.now()+Math.max(1000,Number(timeoutMs)||15000);
  const syncRealm=validRealmNumber(realm)!=null?validRealmNumber(realm):validRealmNumber(currentCaptureSyncSession()?.realm);
  while(Date.now()<deadline){
    const s=syncRealm!=null?await state(syncRealm):await state();
    const found=endpointCapturedAfterForRealm(s,target,sinceMs,syncRealm);
    if(found) return {ok:true,target,endpoint:found.endpoint,status:found.status,receivedAt:found.receivedAtMs};
    await new Promise(r=>setTimeout(r,250));
  }
  const s=syncRealm!=null?await state(syncRealm):await state();
  const found=endpointCapturedAfterForRealm(s,target,sinceMs,syncRealm);
  if(found) return {ok:true,target,endpoint:found.endpoint,status:found.status,receivedAt:found.receivedAtMs};
  return {ok:false,target,error:`No ${String(target||'game')} API response was captured within ${Math.round((Number(timeoutMs)||15000)/1000)} seconds.`};
}

async function waitForBridge(tabId, timeoutMs=10000){
  const deadline=Date.now()+Math.max(1000,Number(timeoutMs)||10000);
  while(Date.now()<deadline){
    try{
      const r=await chrome.tabs.sendMessage(tabId,{type:'BRIDGE_STATUS'});
      if(r?.ready) return true;
    }catch{}
    // If the tab was already open before the extension loaded, inject the
    // isolated content script without reloading the game page. content.js is
    // idempotent and will inject page-hook.js only when needed.
    try{ await chrome.scripting.executeScript({target:{tabId},files:['content.js']}); }catch{}
    await new Promise(r=>setTimeout(r,300));
  }
  return false;
}


async function executeGameClick(tabId,target){
  const execution=chrome.scripting.executeScript({target:{tabId},func:async(cfg)=>{
    const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const norm=t=>String(t||'').replace(/\s+/g,' ').trim().toLowerCase();
    const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect?.();if(r&&(r.width===0||r.height===0))return false;const cs=getComputedStyle(el);return cs.display!=='none'&&cs.visibility!=='hidden'&&cs.pointerEvents!=='none';};
    const find=(labels,hrefHints)=>{
      const wanted=(labels||[]).map(norm), hrefs=(hrefHints||[]).map(norm);
      if(hrefs.length){
        const a=[...document.querySelectorAll('a[href]')].find(x=>{
          const h=norm(x.getAttribute('href'));
          return visible(x)&&hrefs.some(v=>v&&h.includes(v));
        });
        if(a)return a;
      }
      const nodes=[...document.querySelectorAll('a,button,[role="button"],li,[data-testid],[class*="tab"],[class*="menu"],[class*="nav"]')];
      let best=null,score=-1;
      for(const el of nodes){
        if(!visible(el))continue;
        const text=norm(el.textContent),aria=norm(el.getAttribute('aria-label')),title=norm(el.getAttribute('title')),href=norm(el.getAttribute('href')),tag=String(el.tagName||'').toLowerCase();
        for(const w of wanted){
          let n=-1;
          if(hrefs.some(h=>h&&href.includes(h)))n=150;
          else if(text===w||aria===w||title===w)n=(tag==='a'||tag==='button'||el.getAttribute('role')==='button')?125:90;
          else if(text.includes(w)||aria.includes(w)||title.includes(w))n=(tag==='a'||tag==='button'||el.getAttribute('role')==='button')?85:55;
          else if(href&&href.includes(w))n=75;
          if(n>score){best=el;score=n;}
        }
      }
      return best;
    };

    let el=find(cfg.labels,cfg.hrefHints||[]);

    // Accounting is nested under Headquarters in some SPA layouts.
    // Open that real UI section, let React render its children, then locate the
    // requested page. No direct API fallback is used here.
    if(!el&&cfg.name==='Accounting'){
      const menu=find(['Headquarters','HQ'],[]);
      if(menu){
        try{menu.click();}catch{}
        for(let i=0;i<6&&!el;i++){
          await sleep(250);
          el=find(cfg.labels,cfg.hrefHints||[]);
        }
      }
    }

    if(!el)return {ok:false,error:'Game page target was not found.'};
    const anchor=(cfg.hrefHints||[]).length ? (el.matches?.('a')?el:el.closest?.('a')) : null;
    const targetEl=anchor||el;
    const beforeUrl=String(location.href);
    const info={tag:targetEl.tagName||null,text:String(targetEl.textContent||'').replace(/\s+/g,' ').trim().slice(0,200),href:targetEl.getAttribute?.('href')||null,aria:targetEl.getAttribute?.('aria-label')||null,title:targetEl.getAttribute?.('title')||null};
    try{targetEl.click();}catch(e){return {ok:false,error:e?.message||String(e),element:info,beforeUrl};}
    return {ok:true,element:info,beforeUrl,urlAfterClick:String(location.href)};
  },args:[target]});
  let timer=null;
  try{
    const timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve({__scmTimeout:true}),SYNC_CLICK_TIMEOUT_MS);});
    const result=await Promise.race([execution,timeout]);
    if(result?.__scmTimeout) return {ok:false,error:`Game page click script did not return within ${Math.round(SYNC_CLICK_TIMEOUT_MS/1000)} seconds.`};
    return result?.[0]?.result||{ok:false,error:'Game click script returned no result.'};
  }finally{ if(timer) clearTimeout(timer); }
}
async function withSyncTimeout(promise,timeoutMs,label){
  let timer=null;
  try{
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} timed out after ${Math.round(timeoutMs/1000)} seconds.`)),timeoutMs);})
    ]);
  }finally{ if(timer) clearTimeout(timer); }
}


async function persistTransientSyncUi(realm,status,error=null){
  // Sync progress is ephemeral UI state. Persisting it through the realm-store
  // abstraction rewrites the entire (potentially very large) realm object.
  // Keep the live progress in the small root syncStatus/syncError keys; the
  // durable realm-local status is committed once when Sync finishes or fails.
  try{
    const prefix=realmDisplayNumber(realm)||'Realm';
    const text=String(status||'');
    await chrome.storage.local.set({syncStatus:text.startsWith(prefix)?text:`${prefix} ${text}`,syncError:error??null});
  }catch{}
}

async function setAccountingWeekLedgerStatus(realm,status,error=null,extra={}){
  const n=validRealmNumber(realm); if(n==null)return;
  const key=realmKeyFromRealm(n);
  return withRealmWriteLock(n,async()=>{
    const s=await state(n);
    const stores={...(s.realmStores||{})};
    const store={...(stores[key]||{})};
    const value={status:String(status||''),error:error??null,updatedAt:new Date().toISOString(),...extra};
    store.accountingWeekLedgerStatus=value;
    stores[key]=store;
    const patch={realmStores:stores};
    if(s.activeRealmKey===key)patch.accountingWeekLedgerStatus=value;
    await storageSet(patch);
  });
}
async function setAccountingDayWalkStatus(realm,value){
  const n=validRealmNumber(realm); if(n==null)return;
  const key=realmKeyFromRealm(n);
  return withRealmWriteLock(n,async()=>{
    const s=await state(n);
    const stores={...(s.realmStores||{})};
    const store={...(stores[key]||{})};
    store.accountingDayWalkStatus={...value,updatedAt:new Date().toISOString()};
    stores[key]=store;
    await storageSet({realmStores:stores});
  });
}
async function scheduleAccountingDayWalk(realm,delayMs=4000){
  const n=validRealmNumber(realm); if(n==null)return {ok:false,error:'Invalid realm.'};
  const name=`${ACCOUNTING_DAY_WALK_ALARM_PREFIX}${n}`;
  await setAccountingDayWalkStatus(n,{status:'scheduled',scheduledAt:new Date().toISOString()});
  await chrome.alarms.create(name,{when:Date.now()+Math.max(1000,Number(delayMs)||4000)});
  return {ok:true,scheduled:true,realm:n};
}
// One step on the game's Accounting page. op: 'probe' | 'mode' (index 0 Current, 1 Day) | 'day' (index n).
async function accountingPeriodStep(tabId,op,index=0){
  const run=chrome.scripting.executeScript({target:{tabId},func:(op,index)=>{
    const visible=el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0;};
    let bar=null;
    for(const lab of document.querySelectorAll('label')){
      const p=lab.parentElement; if(!p||p.firstElementChild!==lab)continue;
      const kids=[...p.children], modes=kids[1]?[...kids[1].children].filter(x=>x.tagName==='BUTTON'):[];
      if(modes.length!==4||!modes.every(visible))continue;
      const days=kids[2]?[...kids[2].children].filter(x=>x.tagName==='BUTTON'):[];
      bar={modes,days};break;
    }
    if(!bar)return {ok:false,found:false,url:location.pathname};
    if(op==='probe')return {ok:true,found:true,dayButtons:bar.days.length,url:location.pathname};
    const btn=op==='mode'?bar.modes[index]:bar.days[index];
    if(!btn)return {ok:false,found:true,error:`No ${op} button ${index} (day buttons: ${bar.days.length}).`};
    if(btn.disabled)return {ok:false,found:true,disabled:true};
    btn.click();
    return {ok:true,found:true,dayButtons:bar.days.length};
  },args:[op,index]});
  const timeout=new Promise(r=>setTimeout(()=>r(null),SYNC_CLICK_TIMEOUT_MS));
  const res=await Promise.race([run,timeout]).catch(e=>[{result:{ok:false,error:e?.message||String(e)}}]);
  return res?.[0]?.result||{ok:false,error:'Accounting page script did not return.'};
}
async function waitForAccountingDayCapture(realm,dayIndex,sinceMs,timeoutMs=ACCOUNTING_DAY_WALK_WAIT_MS){
  const path=`/api/v2/companies/me/income-statement/day/${dayIndex}/`;
  const key=realmKeyFromRealm(realm);
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const item=(await state(realm)).realmStores?.[key]?.endpointData?.[path];
    const t=Date.parse(item?.receivedAt||'');
    if(item&&Number(item.status)===200&&item.data&&validRealmNumber(item.captureRealm)===realm&&Number.isFinite(t)&&t>=sinceMs)
      return {ok:true,path,date:item.data.date||null,isComputed:item.data.isComputed===true};
    await new Promise(r=>setTimeout(r,500));
  }
  return {ok:false,path,error:`No ${path} response within ${Math.round(timeoutMs/1000)} s.`};
}
async function runAccountingDayWalk(realm,reason='scheduled'){
  const n=validRealmNumber(realm); if(n==null)return {ok:false,error:'Invalid realm.'};
  if(accountingDayWalkRunning.has(n))return {ok:false,busy:true};
  accountingDayWalkRunning.add(n);
  const startedAt=new Date().toISOString(); const days=[];
  const finish=async(status,error=null)=>{const v={status,error,reason,startedAt,finishedAt:new Date().toISOString(),days,captured:days.filter(d=>d.ok).length,wanted:ACCOUNTING_DAY_WALK_DAYS};await setAccountingDayWalkStatus(n,v).catch(()=>{});logActivity(n,'accounting-day-walk',status==='complete'?'success':status==='partial'?'partial':'failure',{rows:v.captured,wanted:v.wanted},error,Date.now(),reason);return {ok:status!=='failed',...v};};
  try{
    await setAccountingDayWalkStatus(n,{status:'running',reason,startedAt});
    const tab=await simTab();
    if(!tab?.id)return await finish('failed','Open Sim Companies in a browser tab.');
    await waitForBridge(tab.id,10000);
    let probe=await accountingPeriodStep(tab.id,'probe');
    if(!probe.found){
      const click=await executeGameClick(tab.id,{name:'Accounting',labels:['Accounting','Financials','Finance'],hrefHints:['/headquarters/accounting']}).catch(e=>({ok:false,error:e?.message||String(e)}));
      for(let i=0;i<40&&!probe.found;i++){await new Promise(r=>setTimeout(r,500));probe=await accountingPeriodStep(tab.id,'probe');}
      if(!probe.found)return await finish('failed',`Accounting period buttons not found (${click?.error||'page did not show them'}).`);
    }
    let since=Date.now();
    const day=await accountingPeriodStep(tab.id,'mode',1);
    if(!day.ok)return await finish('failed',day.error||'Could not tap Day.');
    for(let i=0;i<20;i++){probe=await accountingPeriodStep(tab.id,'probe');if(probe.dayButtons>=ACCOUNTING_DAY_WALK_DAYS)break;await new Promise(r=>setTimeout(r,500));}
    if(!(probe.dayButtons>=ACCOUNTING_DAY_WALK_DAYS))return await finish('failed',`Day buttons not shown (${probe.dayButtons||0}).`);
    for(let d=0;d<ACCOUNTING_DAY_WALK_DAYS;d++){
      // Tapping Day already loads day 0; later days need their own tap.
      if(d>0){since=Date.now();const c=await accountingPeriodStep(tab.id,'day',d);if(!c.ok){days.push({day:d,ok:false,error:c.error||'tap failed'});continue;}}
      const got=await waitForAccountingDayCapture(n,d,since);
      days.push({day:d,ok:got.ok&&got.isComputed,date:got.date||null,error:got.ok?(got.isComputed?null:'not computed yet'):got.error});
    }
    await accountingPeriodStep(tab.id,'mode',0).catch(()=>{});
    const ok=days.filter(x=>x.ok).length;
    return await finish(ok===ACCOUNTING_DAY_WALK_DAYS?'complete':ok?'partial':'failed',ok===ACCOUNTING_DAY_WALK_DAYS?null:`${ACCOUNTING_DAY_WALK_DAYS-ok} day(s) not captured`);
  }catch(e){return await finish(days.some(x=>x.ok)?'partial':'failed',e?.message||String(e));}
  finally{accountingDayWalkRunning.delete(n);}
}
async function yieldSyncStep(ms=SYNC_STEP_YIELD_MS){
  const delay=Math.max(0,Number(ms)||0);
  if(!delay)return;
  await new Promise(resolve=>setTimeout(resolve,delay));
}
async function runDeferredAccountingWeekRefresh(realm,reason='scheduled'){
  const n=validRealmNumber(realm);
  if(n==null)return {ok:false,error:'Invalid accounting realm.'};
  const existing=accountingWeekRefreshPromises.get(n);
  if(existing)return existing;
  const promise=(async()=>{
    const started=Date.now();
    await setAccountingWeekLedgerStatus(n,'running',null,{reason});
    try{
      const result=await syncCurrentWeekAccountingSales(n,()=>{});
      if(result?.ok){
        await setAccountingWeekLedgerStatus(n,'complete',null,{reason,fastRefresh:Boolean(result.fastRefresh),pages:Number(result.pages)||0,rows:Number(result.rows)||0,crossedBoundary:Boolean(result.crossedBoundary),endReached:Boolean(result.endReached),coverageComplete:Boolean(result.coverageComplete),boundary:result?.boundary!=null?new Date(Number(result.boundary)).toISOString():null,completedAt:new Date().toISOString(),durationMs:Date.now()-started});
        // The physical realm store is authoritative, but the dashboard is an
        // independent extension page. Give it an explicit completion event so
        // Overview never depends on a navigation or on a storage-change race.
        notifyDashboardAccountingLedgerReady(n);
        scheduleGameOverlayRefreshNotification(n,150);
        return {...result,realm:n};
      }
      const error=String(result?.error||'Current accounting ledger refresh failed.');
      await setAccountingWeekLedgerStatus(n,'failed',error,{reason,durationMs:Date.now()-started});
      return {ok:false,realm:n,error};
    }catch(e){
      const error=e?.message||String(e);
      await setAccountingWeekLedgerStatus(n,'failed',error,{reason,durationMs:Date.now()-started});
      throw e;
    }
  })();
  accountingWeekRefreshPromises.set(n,promise);
  promise.finally(()=>{if(accountingWeekRefreshPromises.get(n)===promise)accountingWeekRefreshPromises.delete(n);}).catch(()=>{});
  return promise;
}

async function syncNow(requestedRealm=null){
  const startedAt=Date.now();
  // Remains null during the active capture and becomes authoritative only
  // once finalization assigns the terminal completion time.
  let finishedAt=null;
  let syncTrace=[];
  let ownsSyncSession=false;
  let selected=null;
  let syncCoreSucceeded=false;
  const targets=[
    {name:'Warehouse',labels:['Warehouse','Headquarters','HQ'],hrefHints:['/headquarters/warehouse/'],waitFor:'warehouse'},
    {name:'Contracts',labels:['Contracts','Contract'],waitFor:'contracts'},
    // Accounting is intentionally LAST because it fans out across the game's
    // financial endpoints and is the slowest capture group.
    {name:'Accounting',labels:['Accounting','Financials','Finance'],waitFor:'accounting'},
  ];
  try{
    const pre=await chrome.storage.local.get({selectedRealm:null});
    const requested=validRealmNumber(requestedRealm);
    selected=requested!=null?requested:validRealmNumber(pre.selectedRealm);
    if(selected==null || ![0,1].includes(selected)){
      const err='Select R1 - Magnates or R2 - Entrepreneurs before syncing.';
      await storageSet({syncStatus:'Select a realm to sync',syncError:err});
      return {ok:false,error:err};
    }

    // Hard single-flight lock. A second Sync click must never start a second
    // realm capture while the first transaction is still writing realm-local
    // storage. Overlapping runs were a major source of UI churn and state races.
    const runningRealms=[...realmSyncSessions.keys()].filter(r=>validRealmNumber(r)!=null);
    if(runningRealms.length){
      const runningRealm=runningRealms[0];
      const err=`${realmDisplayNumber(runningRealm)||'Realm'} Sync is already running.`;
      return {ok:false,busy:true,realm:runningRealm,error:err};
    }
    // The two realm sync systems have independent sessions and storage queues.
    // Only the game-page capture itself remains single-flight because one
    // logged-in Sim Companies tab can represent only one authenticated realm
    // at a time. Background VWAP jobs do not use this capture lock.
    const session={realm:selected,startedAt,phase:'preflight'};
    realmSyncSessions.set(selected,session);
    syncCaptureRealm=selected;
    ownsSyncSession=true;
    const trace=(type,payload={})=>syncTrace.push({at:Date.now(),type,...payload});
    let lastTracePersistAt=0;
    const persistTrace=async(force=false)=>{
      if(!force && Date.now()-lastTracePersistAt<1000)return false;
      lastTracePersistAt=Date.now();
      try{
        await withSyncTimeout((async()=>{
          const ds=await state(selected); const dk=realmKeyFromRealm(selected); const dst=ds.realmStores?.[dk]||{};
          await saveFullSyncDiagnostic(buildSyncDiagnosticCheckpoint({
            realm:selected,
            status:dst.syncStatus||null,
            syncError:dst.syncError||null,
            lastSync:dst.lastSync||null,
            startedAt,
            finishedAt,
            existingDiagnostic:dst.fullSyncDiagnostics,
            endpointCount:Object.keys(dst.endpointData||{}).length,
            warehouseRows:Array.isArray(dst.warehouseResources)?dst.warehouseResources.length:0,
            syncPolicy:{apiFirst:true,clickTimeoutMs:SYNC_CLICK_TIMEOUT_MS,fallbackCaptureMs:SYNC_CAPTURE_FALLBACK_MS,pageApiTimeoutMs:SYNC_PAGE_API_TIMEOUT_MS,pageApiAttempts:SYNC_PAGE_API_ATTEMPTS},
            syncTrace
          }),selected);
        })(),5000,'Sync diagnostic persistence');
        return true;
      }catch(e){
        syncTrace.push({at:Date.now(),type:'diagnostic-persist-failed',error:e?.message||String(e)});
        return false;
      }
    };
    const syncStorageWrite=async(label,task,timeoutMs=8000)=>{
      try{return await withSyncTimeout(Promise.resolve().then(task),timeoutMs,label);}
      catch(e){trace('sync-storage-write-failed',{label,error:e?.message||String(e),timeoutMs});return null;}
    };
    trace('sync-start',{realm:selected,realmKey:realmKeyFromRealm(selected),storageCommitLane:`realm:${selected}`,pageCaptureLock:'single-tab'});
    await persistTrace(true);

    await ensureRealmStorageMigration();
    const check=await chrome.storage.local.get({selectedRealm:null});
    if(validRealmNumber(check.selectedRealm)!==selected) await storageSet({selectedRealm:selected});
    trace('realm-selected',{selectedRealm:selected});

    const tab=await simTab();
    if(!tab?.id) throw new Error('Open the logged-in Sim Companies tab before syncing.');
    const bridgeReady=await waitForBridge(tab.id,8000);
    if(!bridgeReady) throw new Error('Sim Companies page bridge could not be established. Keep the logged-in game tab open and try Sync again.');
    trace('bridge-ready',{tabId:tab.id});
    try{
      const sr=await chrome.tabs.sendMessage(tab.id,{type:'SET_SYNC_REALM',realm:selected,ttlMs:120000});
      if(!sr?.ok) throw new Error('Could not set the selected sync realm in the game page.');
      trace('capture-boundary-set',{realm:selected});
    }catch(e){
      throw new Error(`Could not establish the selected realm capture boundary: ${e?.message||String(e)}`);
    }

    // The authenticated game session is the realm boundary. Do this before
    // any page walk, then promote the verified realm to the active Manager
    // store. This makes R1 and R2 symmetric and prevents cross-realm writes.
    session.phase='auth-boundary';
    const authBoundary=await pageGet('/api/v3/companies/auth-data/',selected);
    const authRealm=validRealmNumber(authBoundary?.data?.authCompany?.realmId
      ??authBoundary?.data?.authCompany?.realm
      ??authBoundary?.data?.realmId
      ??authBoundary?.data?.realm
      ??authBoundary?.captureRealm);
    if(!authBoundary?.ok) throw new Error(`Could not verify the game session for ${realmDisplayNumber(selected)||'selected realm'} before sync (HTTP ${authBoundary?.status||0}).`);
    if(authRealm!==selected) throw new Error(`Game session is still ${realmDisplayNumber(authRealm)||'an unknown realm'}; selected sync target is ${realmDisplayNumber(selected)||'the selected realm'}. Switch the game first, then Sync again.`);
    trace('auth-verified',{realm:selected,captureRealm:validRealmNumber(authBoundary.captureRealm),status:Number(authBoundary.status)||0});
    // v2.5.339 the explicit auth-data GET bypasses saveData, so record the economy phase from it here
    // (storage only; seeded from the previously stored auth-data).
    try{const es=await state(selected);const ek=realmKeyFromRealm(selected);await recordEconomyState(selected,es?.realmStores?.[ek]?.endpointData?.['/api/v3/companies/auth-data/']||null,authBoundary.data);trace('economy-state-recorded',{realm:selected,economyState:Number(authBoundary.data?.temporals?.economyState)});}catch{}
    await saveData('/api/v3/companies/auth-data/',authBoundary.data,authBoundary.status,'GET',selected);
    await activateRealmByRealm(selected,authBoundary.data?.authCompany?authBoundary.data:null);
    const activated=await state();
    const activatedKey=activated.activeRealmKey||identityFromAuth(activated.authData);
    if(activatedKey!==realmKeyFromRealm(selected)) throw new Error(`Manager could not activate ${realmDisplayNumber(selected)||'the selected realm'} before sync.`);
    trace('realm-activated',{activeRealmKey:activatedKey,selectedRealm:selected});
    // Non-blocking game-state enrichment. This does not participate in Sync
    // success/failure; it only repopulates realm-local building/production data.
    try{
      const tab=await simTab();
      if(tab?.id){
        trace('game-state-refresh-requested',{realm:selected,source:'game-localStorage'});
        chrome.tabs.sendMessage(tab.id,{type:'PAGE_GAME_STATE'}).catch(()=>{});
        setTimeout(()=>{chrome.tabs.sendMessage(tab.id,{type:'PAGE_GAME_STATE'}).catch(()=>{});},1200);
      }
    }catch{}
    session.phase='running';

    await syncStorageWrite('Sync start job persistence',()=>setFullSyncJob(selected,{status:'running',startedAt:new Date(startedAt).toISOString(),step:0,total:targets.length}));
    await persistTransientSyncUi(selected,`${realmDisplayNumber(selected)||'Realm'} Sync: 0/${targets.length} starting…`,null);

    const results=[];
    const isRequiredEndpoint=(target,path,paths)=>{
      if(!Array.isArray(paths)||!paths.includes(path))return false;
      if(target.name==='Warehouse')return /\/api\/v3\/resources\/\d+\//i.test(path);
      if(target.name==='Contracts')return /\/api\/v3\/contracts-(?:incoming\/\d+\/me|outgoing\/me)(?:\/|$)/i.test(path);
      if(target.name==='Accounting')return ACCOUNTING_SYNC_PATHS.includes(path);
      return false;
    };
    const recordAuthoritative=async(path,response,row)=>{
    const responseRealm=validRealmNumber(response?.captureRealm);
    if(responseRealm!==selected){
      const failure={path,status:Number(response?.status)||0,error:responseRealm==null?'Response had no realm capture stamp.':'Response came from the wrong realm.'};
      (row.authoritativeFailures||(row.authoritativeFailures=[])).push(failure);
      trace('endpoint-persist-rejected',{path,reason:failure.error,status:failure.status});
      return false;
    }
    if(!response?.ok){
      const failure={path,status:Number(response?.status)||0,error:response?.error||`HTTP ${response?.status||0}`};
      (row.authoritativeFailures||(row.authoritativeFailures=[])).push(failure);
      trace('endpoint-api-rejected',{path,status:failure.status,error:failure.error});
      return false;
    }
    const persistStartedAt=Date.now();
    trace('endpoint-persist-start',{path,status:Number(response.status)||200,realm:selected});
    try{
      const persisted=await withSyncTimeout(saveData(path,response.data,response.status,'GET',selected,timing=>{
        trace('endpoint-storage-queue-timing',{path,...timing});
      },{realm:selected,startedAtMs:persistStartedAt,expectedData:response.data,expectedStatus:response.status,allowPreserved:row.name==='Accounting'}),8000,`Persist and verify ${path}`);
      const verification=persisted?.durableVerification;
      if(!verification?.ok)throw new Error(`Durable endpoint verification missing for ${path}.`);
      (row.authoritative||(row.authoritative=[])).push({path,status:Number(response.status)||200,ok:true,durable:true,captureRealm:responseRealm,verification});
      trace('endpoint-durable-write-verified',{path,status:Number(response.status)||200,realm:selected,durationMs:Date.now()-persistStartedAt,...verification});
      return true;
    }catch(e){
      const failure={path,status:Number(response?.status)||0,error:`API response succeeded but durable persistence was not verified: ${e?.message||String(e)}`,durationMs:Date.now()-persistStartedAt};
      (row.authoritativeFailures||(row.authoritativeFailures=[])).push(failure);
      trace('endpoint-durable-write-failed',{path,status:failure.status,error:failure.error,durationMs:failure.durationMs});
      return false;
    }
  };

    for(let i=0;i<targets.length;i++){
      const target=targets[i];
      const step=i+1;
      const targetStartedAt=Date.now();
      // Do not rewrite the full realm store just to persist a transient step.
      // The old per-target job/status writes caused expensive mobile storage
      // churn for large realm stores. Keep the durable job at sync start/final
      // commit and expose progress through the trace instead.

      const currentTab=await simTab();
      if(!currentTab?.id) throw new Error('The logged-in Sim Companies tab is no longer available.');
      const row={name:target.name,ok:false,status:'api-pending',endpoint:null,reason:null};
      await persistTransientSyncUi(selected,`${realmDisplayNumber(selected)||'Realm'} Sync: ${step}/${targets.length} ${target.name}…`,null);
      trace('target-start',{name:target.name,step});
      await persistTrace(true);

      // API-first: a sync transaction should not depend on a 10-second DOM
      // click. Direct authoritative reads are deterministic and available on
      // both realms. UI navigation is now only a fallback for failed reads.
      let companyId=0;
      try{
        const current=await state();
        const selectedStore=current.realmStores?.[realmKeyFromRealm(selected)]||{};
        companyId=Number(selectedStore.authData?.authCompany?.companyId||selectedStore.authData?.authCompany?.id||current.authData?.authCompany?.companyId||current.authData?.authCompany?.id)||0;
      }catch{}

      const authoritativePaths=target.name==='Warehouse'
        // Warehouse's authoritative, fast path is the resources endpoint.
        // The /buildings/ API is Cloudflare-protected on the live game and
        // must never block or fail an otherwise valid Warehouse sync. Building
        // state is enriched separately from the game's game-state/localStorage
        // capture, which is realm-bound and does not require a second DOM crawl.
        ? (companyId>0?[`/api/v3/resources/${companyId}/`]:[])
        : target.name==='Contracts'
          ? realmContractPaths(selected)
            : target.name==='Accounting'
              ? ACCOUNTING_SYNC_PATHS.slice()
              : [];

      row.startedAtMs=targetStartedAt;
      row.requestedPaths=authoritativePaths.slice();
      session.capturePaths=authoritativePaths.slice();
      if(!authoritativePaths.length){
        row.authoritativeFailures=[{path:null,status:0,error:'No authoritative API path could be resolved from the selected realm state.'}];
      }

      const directResults=[];
      if(target.name==='Accounting'){
        let accountingCursor=0;
        const accountingResults=Array.from({length:Math.min(ACCOUNTING_REFRESH_CONCURRENCY,authoritativePaths.length)},()=> (async()=>{
          while(true){
            const i=accountingCursor++; if(i>=authoritativePaths.length)return;
            const path=authoritativePaths[i];
            try{
              trace('authoritative-request',{name:target.name,path});
              const response=await pageGet(path,selected,null,`sync-accounting`);
              const ok=await recordAuthoritative(path,response,row);
              const result={path,ok,status:Number(response?.status)||0,captureRealm:validRealmNumber(response?.captureRealm),error:response?.error||null};
              directResults.push(result);
              trace(ok?'authoritative-success':'authoritative-failure',{name:target.name,path,status:result.status,captureRealm:result.captureRealm});
            }catch(e){
              const result={path,ok:false,status:0,error:e?.message||String(e)};
              directResults.push(result);
              row.authoritativeFailures=(row.authoritativeFailures||[]).concat(result);
              trace('authoritative-error',{name:target.name,path,error:result.error});
            }
          }
        })());
        await Promise.all(accountingResults);
        directResults.sort((a,b)=>authoritativePaths.indexOf(a.path)-authoritativePaths.indexOf(b.path));
      }else if(target.name==='Contracts'){
        // These targets have only two independent endpoints. Fetch them in
        // parallel; realm-scoped storage commits remain serialized by the API
        // queue, so concurrency improves latency without mixing stores.
        await Promise.all(authoritativePaths.map(async path=>{
          try{
            trace('authoritative-request',{name:target.name,path});
            const response=await pageGet(path,selected);
            const ok=await recordAuthoritative(path,response,row);
            directResults.push({path,ok,status:Number(response?.status)||0,captureRealm:validRealmNumber(response?.captureRealm),error:response?.error||null});
            trace(ok?'authoritative-success':'authoritative-failure',{name:target.name,path,status:Number(response?.status)||0,captureRealm:validRealmNumber(response?.captureRealm)});
            if(target.name==='Contracts' && path.includes('/contracts-incoming/') && ok){
              row.endpoint=path;
            }else if(target.name!=='Contracts' && ok){
              row.endpoint=row.endpoint||path;
            }
          }catch(e){
            trace('authoritative-error',{name:target.name,path,error:e?.message||String(e)});
            directResults.push({path,ok:false,status:0,error:e?.message||String(e)});
            row.authoritativeFailures=(row.authoritativeFailures||[]).concat({path,status:0,error:e?.message||String(e)});
          }
        }));
        directResults.sort((a,b)=>authoritativePaths.indexOf(a.path)-authoritativePaths.indexOf(b.path));
      }else{
        for(const path of authoritativePaths){
          try{
            trace('authoritative-request',{name:target.name,path});
            const response=await pageGet(path,selected);
            const ok=await recordAuthoritative(path,response,row);
            directResults.push({path,ok,status:Number(response?.status)||0,captureRealm:validRealmNumber(response?.captureRealm),error:response?.error||null});
            trace(ok?'authoritative-success':'authoritative-failure',{name:target.name,path,status:Number(response?.status)||0,captureRealm:validRealmNumber(response?.captureRealm)});
            if(target.name==='Contracts' && path.includes('/contracts-incoming/') && ok){
              row.endpoint=path;
            }else if(target.name!=='Contracts' && ok){
              row.endpoint=path;
            }
          }catch(e){
            trace('authoritative-error',{name:target.name,path,error:e?.message||String(e)});
            directResults.push({path,ok:false,status:0,error:e?.message||String(e)});
            row.authoritativeFailures=(row.authoritativeFailures||[]).concat({path,status:0,error:e?.message||String(e)});
          }
        }
      }

      const directSuccessCount=directResults.filter(x=>x.ok).length;
      const accountingCoreSuccess=target.name==='Accounting'
        ? directResults.some(x=>x.ok&&ACCOUNTING_CORE_PATH_RE.test(x.path))
        : false;
      const warehouseResourceOk=target.name==='Warehouse'
        ? directResults.some(x=>x.ok&&/\/api\/v3\/resources\/\d+\//i.test(x.path))
        : false;
      const directIncomingOk=target.name==='Warehouse'
        ? warehouseResourceOk
        : target.name==='Contracts'
          ? directResults.some(x=>x.ok&&x.path.includes('/contracts-incoming/'))
          : target.name==='Accounting'
            ? accountingCoreSuccess
            : directResults.some(x=>x.ok);

      if(directIncomingOk){
        row.ok=true;
        row.status=target.name==='Accounting' ? `api-captured ${directSuccessCount}/${authoritativePaths.length}` : 'api-captured';
        row.reason=null;
        row.directApiFirst=true;
        row.successCount=directSuccessCount;
        row.requestedCount=authoritativePaths.length;
        if(target.name==='Warehouse'){
          row.warehouseResourceCapture=warehouseResourceOk;
          try{
            const ps=await state(selected);
            const pst=ps.realmStores?.[realmKeyFromRealm(selected)]||{};
            row.buildingsCapture=Array.isArray(pst.buildings)&&pst.buildings.length>0;
          }catch{ row.buildingsCapture=false; }
          // Ask the page-hook for the realm-local game-state after the fast
          // Warehouse capture. This is intentionally non-blocking; it enriches
          // Buildings/production state without extending Sync latency.
          try{ chrome.tabs.sendMessage(currentTab.id,{type:'PAGE_GAME_STATE'}).catch(()=>{}); }catch{}
        }
        if(target.name==='Contracts' && !row.endpoint) row.endpoint=directResults.find(x=>x.ok)?.path||null;
        if(target.name==='Accounting' && directSuccessCount<authoritativePaths.length){
          trace('accounting-partial-direct-capture',{successCount:directSuccessCount,requestedCount:authoritativePaths.length});
          const fallbackStart=Date.now();
          let click={ok:false,error:'Accounting UI enrichment not attempted.'};
          try{ click=await executeGameClick(currentTab.id,{name:'Accounting',labels:target.labels,hrefHints:[]}); }catch(e){ click={ok:false,error:e?.message||String(e)}; }
          row.accountingUiEnrichment={click};
          if(click?.ok){
            const recovered=await waitForEndpointCapture('accounting',fallbackStart,Math.max(SYNC_CAPTURE_FALLBACK_MS,12000),selected).catch(()=>null);
            await withSyncTimeout(apiStorageQueueForRealm(selected),20000,'Accounting API storage queue drain').catch(()=>{});
            const post=await state();
            const postEp=endpointDataForSyncRealm(post,selected);
            const successPaths=ACCOUNTING_SYNC_PATHS.filter(path=>{
              const item=postEp[path];
              return Number(item?.status)>=200&&Number(item?.status)<300&&item?.data!=null;
            });
            row.successCount=Math.max(directSuccessCount,successPaths.length);
            row.status=`api-captured ${row.successCount}/${authoritativePaths.length}`;
            row.accountingUiEnrichment.endpoint=recovered?.endpoint||null;
            trace('accounting-ui-enrichment-complete',{successCount:row.successCount,requestedCount:authoritativePaths.length,endpoint:recovered?.endpoint||null});
          }
        }
      }

      if(target.name==='Accounting' && row.ok){
        // The authoritative Accounting target is complete once the seven
        // financial APIs are captured. The historical current-week ledger is
        // supplemental: it can require many sequential cursor pages and must
        // never hold the core Sync transaction open on mobile. It is scheduled
        // only after the core Sync transaction is finalized.
        row.accountingWeekLedger={ok:true,deferred:true,status:'scheduled'};
        trace('accounting-week-ledger-deferred',{realm:selected,reason:'core-sync-complete'});
      }

      if(!row.ok){
        // Fallback only: open the requested game page so its own traffic has a
        // chance to populate the same realm-scoped stores. The click itself is
        // deliberately short; it must never freeze Sync for ten seconds.
        let click={ok:false,error:'UI fallback not yet attempted.'};
        const fallbackStart=Date.now();
        try{
          click=await executeGameClick(currentTab.id,{name:target.name,labels:target.labels,hrefHints:target.hrefHints||[]});
        }catch(e){click={ok:false,error:e?.message||String(e)};}
        row.click=click;
        row.fallbackUsed=true;
        trace('ui-fallback-result',{name:target.name,ok:Boolean(click?.ok),error:click?.error||null});

        let recovered=null;
        try{
          recovered=await waitForEndpointCapture(target.waitFor,fallbackStart,SYNC_CAPTURE_FALLBACK_MS,selected);
        }catch{}

        if(recovered?.ok){
          if(target.name!=='Warehouse'){
            trace('ui-fallback-recovered',{name:target.name,endpoint:recovered.endpoint});
            row.ok=true;
            row.status='api-captured';
            row.endpoint=recovered.endpoint;
            row.reason=null;
            row.recoveredFromClickFailure=!click?.ok;
          }else{
            const warehouseSince=fallbackStart;
            const resourceRecovered=Boolean(endpointCapturedAfterForRealm(await state(selected),'warehouse',warehouseSince,selected));
            row.warehouseResourceCapture=resourceRecovered;
            // Buildings are enrichment, not a Warehouse target gate. Ask for a
            // fresh game-state sample and let it arrive in the realm store on
            // its own capture boundary. Do not navigate Map just to satisfy a
            // field that the buildings endpoint cannot reliably provide.
            try{ chrome.tabs.sendMessage(currentTab.id,{type:'PAGE_GAME_STATE'}).catch(()=>{}); }catch{}
            row.buildingsCapture=Boolean(Array.isArray((await state(selected)).realmStores?.[realmKeyFromRealm(selected)]?.buildings));
            if(resourceRecovered){
              trace('ui-fallback-recovered',{name:target.name,endpoint:recovered.endpoint||authoritativePaths.find(p=>p.includes('/resources/'))||null});
              row.ok=true;
              row.status='api-captured';
              row.endpoint=recovered.endpoint||authoritativePaths.find(p=>p.includes('/resources/'))||null;
              row.reason=null;
              row.recoveredFromClickFailure=!click?.ok;
            }else{
              row.reason='Warehouse resource API response was not captured after fallback.';
            }
          }
        }else{
          // One last direct attempt after the route change. This is especially
          // important for contract capture, where historical traces showed an HTTP
          // 200 response arriving outside the old passive 15-second window.
          for(const path of authoritativePaths){
            try{
              trace('authoritative-retry',{name:target.name,path});
              const response=await pageGet(path,selected);
              const ok=await recordAuthoritative(path,response,row);
              if(ok && (target.name!=='Contracts' || path.includes('/contracts-incoming/'))){
                row.ok=true;
                row.status='api-retry-captured';
                row.endpoint=row.endpoint||path;
                break;
              }
            }catch{}
          }
          if(!row.ok){
            row.status=click?.ok?'api-timeout':'click-failed';
            row.reason=click?.error||`No ${String(target.waitFor||'game')} API response was captured within the fallback window.`;
          }
        }
      }

      row.durationMs=Date.now()-targetStartedAt;
      results.push(row);
      session.capturePaths=[];
      trace('target-complete',{name:target.name,ok:row.ok,status:row.status,durationMs:row.durationMs,endpoint:row.endpoint||null});
      await persistTrace(true);
      // Persist only the small live UI status during the transaction. The
      // durable realm-local status is written once in the final commit.
      await persistTransientSyncUi(selected,`${realmDisplayNumber(selected)||'Realm'} Sync: ${step}/${targets.length} ${target.name} ${row.ok?'✓':'failed'}`,row.ok?null:row.reason);
      // Give the browser/storage event loop a short yield between major sync targets.
      // This is deliberately much smaller than a blanket 1-second delay and only
      // runs after a target has finished, so it cannot create a false readiness state.
      if(i<targets.length-1) await yieldSyncStep();
    }

    // Drain is best-effort: the final durable verification below re-reads and
    // retries every required endpoint, so a slow queue must not fail Sync.
    try{await withSyncTimeout(apiStorageQueueForRealm(selected),20000,'API storage queue drain');trace('api-queue-drained',{});}
    catch(e){trace('api-queue-drain-timeout',{error:e?.message||String(e)});}

    // Market-data requests are intentionally excluded from the core Sync transaction.
    // They run from a delayed post-sync alarm after game API captures and durable
    // storage verification have completed, so SimcoTools latency cannot fail Sync.

    let finalState=await state(selected);
    const key=realmKeyFromRealm(selected);
    const store=finalState.realmStores?.[key]||{};
    const entries=Object.values(store.endpointData||{});
    const foreign=entries.filter(x=>validRealmNumber(x?.captureRealm)!=null && validRealmNumber(x.captureRealm)!==selected);
    if(foreign.length) throw new Error(`Realm integrity failure: ${foreign.length} foreign API records found in ${realmDisplayNumber(selected)||'selected realm'}.`);
    trace('realm-integrity-pass',{foreignEndpointRecords:foreign.length,endpointCount:entries.length});

    // Final transaction barrier: the API queue can finish an endpoint write after
    // the individual caller's timeout. Re-read every required physical endpoint
    // now, retry only missing records, drain those retries, and verify again before
    // declaring any target successful.
    session.capturePaths=[];
    try{await withSyncTimeout(apiStorageQueueForRealm(selected),20000,'Final API storage queue drain');trace('final-api-queue-drained',{});}
    catch(e){trace('final-api-queue-drain-timeout',{error:e?.message||String(e)});}
    const total=results.length;
    for(const result of results){
      const target=targets.find(item=>item.name===result.name)||{name:result.name};
      const requestedPaths=Array.isArray(result.requestedPaths)?result.requestedPaths:[];
      const requiredPaths=requestedPaths.filter(path=>isRequiredEndpoint(target,path,requestedPaths));
      const verificationByPath=new Map();
      const retryPaths=[];
      const verifyPath=async requiredPath=>withSyncTimeout(
        verifyDurableEndpointWrite(selected,requiredPath,result.startedAtMs||startedAt,null,null,target.name==='Accounting'),
        3000,`Final durable endpoint verification ${requiredPath}`
      );
      for(const requiredPath of requiredPaths){
        let verification={ok:false,reason:'required-endpoint-not-durable'};
        try{verification=await verifyPath(requiredPath);}catch(e){verification={ok:false,reason:e?.message||String(e)};}
        verificationByPath.set(requiredPath,verification);
        if(!verification.ok){
          retryPaths.push(requiredPath);
          trace('target-required-endpoint-missing',{name:result.name,path:requiredPath,...verification});
        }else trace('target-required-endpoint-verified',{name:result.name,path:requiredPath,...verification});
      }
      // Retry failed reads/writes after the main queue drain. The retry writes
      // retain priority and are read back only after their queue slot completes.
      for(const requiredPath of retryPaths){
        session.capturePaths=[requiredPath];
        trace('required-endpoint-final-retry',{name:result.name,path:requiredPath,reason:verificationByPath.get(requiredPath)?.reason||'unverified'});
        try{
          const response=await pageGet(requiredPath,selected,null,`final-durability-retry:${target.name}`);
          const retryOk=await recordAuthoritative(requiredPath,response,result);
          trace('required-endpoint-final-retry-result',{name:result.name,path:requiredPath,ok:retryOk,status:Number(response?.status)||0});
        }catch(e){trace('required-endpoint-final-retry-error',{name:result.name,path:requiredPath,error:e?.message||String(e)});}
      }
      session.capturePaths=[];
      if(retryPaths.length){
        try{await withSyncTimeout(apiStorageQueueForRealm(selected),20000,'Final retry API storage queue drain');}
        catch(e){trace('final-retry-queue-drain-failed',{name:result.name,error:e?.message||String(e)});}
        for(const requiredPath of retryPaths){
          let verification={ok:false,reason:'required-endpoint-not-durable-after-retry'};
          try{verification=await verifyPath(requiredPath);}catch(e){verification={ok:false,reason:e?.message||String(e)};}
          verificationByPath.set(requiredPath,verification);
          trace(verification.ok?'target-required-endpoint-verified-after-retry':'target-required-endpoint-missing-after-retry',{name:result.name,path:requiredPath,...verification});
        }
      }
      const endpointVerifications=requiredPaths.map(path=>({path,...(verificationByPath.get(path)||{ok:false,reason:'verification-result-missing'})}));
      const verifiedCount=endpointVerifications.filter(item=>item.ok).length;
      const verification={ok:requiredPaths.length>0&&verifiedCount===requiredPaths.length,requiredCount:requiredPaths.length,verifiedCount,endpoints:endpointVerifications};
      result.finalDurableVerification=verification;
      if(verification.ok){
        if(!result.ok){result.ok=true;result.status='durable-write-recovered';result.reason=null;result.endpoint=result.endpoint||requiredPaths[0];}
        trace('target-required-writes-verified',{name:result.name,requiredCount:verification.requiredCount,verifiedCount:verification.verifiedCount,recoveredAfterTimeout:result.status==='durable-write-recovered'});
      }else{
        const missing=endpointVerifications.filter(item=>!item.ok);
        const missingSummary=missing.map(item=>`${item.path}: ${item.reason||'unverified'}`).join('; ')||'no required endpoint paths resolved';
        result.ok=false;result.status='required-write-unverified';result.reason=`Required endpoint durability failed (${missingSummary}).`;
        trace('target-durable-verification-failed',{name:result.name,requiredCount:verification.requiredCount,verifiedCount:verification.verifiedCount,missingEndpoints:missing});
      }
    }
    session.capturePaths=[];
    const missingRequiredEndpoints=results.flatMap(result=>(result.finalDurableVerification?.endpoints||[]).filter(item=>!item.ok).map(item=>({target:result.name,path:item.path,reason:item.reason||'unverified'})));
    const missingRequiredWrites=[...new Set(missingRequiredEndpoints.map(item=>item.target))];
    const successfulAfterDurability=results.filter(result=>result.ok&&result.finalDurableVerification?.ok).length;
    const failedAfterDurability=targets.length-successfulAfterDurability;
    const requiredOk=results.length===targets.length&&results.every(result=>result.ok&&result.finalDurableVerification?.ok);
    const accountingVerification=results.find(result=>result.name==='Accounting')?.finalDurableVerification;
    const accountingSuffix=accountingVerification?` · Accounting ${accountingVerification.verifiedCount}/${accountingVerification.requiredCount} APIs`:'';
    const successful=successfulAfterDurability;
    const failed=failedAfterDurability;
    const finalStatus=`${realmDisplayNumber(selected)||'Realm'} Sync ${requiredOk?'complete':'finished with errors'} · ${successful}/${targets.length} targets captured${accountingSuffix}`;
    const finalSyncError=requiredOk?null:`${failedAfterDurability} target(s) failed; ${missingRequiredEndpoints.length} required endpoint(s) were not durably verified.`;

    // Final invariant: the root view must still point at the realm that was
    // actually synced. This is checked before the completion record is saved.
    finalState=await state();
    if(finalState.activeRealmKey!==key || validRealmNumber(finalState.selectedRealm)!==selected){
      await activateRealmByRealm(selected,finalState.realmStores?.[key]?.authData?.authCompany?finalState.realmStores[key].authData:null);
      finalState=await state();
      if(finalState.activeRealmKey!==key || validRealmNumber(finalState.selectedRealm)!==selected){
        throw new Error(`Realm finalization failed: active=${finalState.activeRealmKey||'none'} selected=${finalState.selectedRealm??'none'} target=${key}.`);
      }
    }
    trace('realm-finalization-pass',{activeRealmKey:finalState.activeRealmKey,selectedRealm:finalState.selectedRealm});

    session.phase='finalizing';
    await syncStorageWrite('Sync finalizing job persistence',()=>setFullSyncJob(selected,{status:'finalizing',step:targets.length,total:targets.length,currentPage:null}));
    finishedAt=new Date().toISOString();
    const diagnosticState=await state(selected);
    const diagnosticStore=diagnosticState.realmStores?.[key]||{};
    await withSyncTimeout(saveFullSyncDiagnostic({
      realm:selected,
      mode:'api-first-sync-with-ui-fallback',
      status:finalStatus,
      syncError:finalSyncError,
      lastSync:finishedAt,
      walkResults:results,
      endpointCount:Object.keys(diagnosticStore.endpointData||{}).length,
      warehouseRows:Array.isArray(diagnosticStore.warehouseResources)?diagnosticStore.warehouseResources.length:0,
      startedAt,
      finishedAt,
      syncPolicy:{apiFirst:true,clickTimeoutMs:SYNC_CLICK_TIMEOUT_MS,fallbackCaptureMs:SYNC_CAPTURE_FALLBACK_MS,pageApiTimeoutMs:SYNC_PAGE_API_TIMEOUT_MS,pageApiAttempts:SYNC_PAGE_API_ATTEMPTS},
      syncTrace
    },selected),5000,'Final Sync diagnostic persistence');

    await withSyncTimeout(enqueueApiStorage(async()=>{
      const finalPersist=await state(selected); // v2.5.345 the synced realm's own store, even if the tab switched realms meanwhile
      const finalStores={...(finalPersist.realmStores||{})};
      finalStores[key]={...(finalStores[key]||{}),syncStatus:finalStatus,syncError:finalSyncError,lastSync:finishedAt,fullSyncJob:null};
      await storageSet({activeRealmKey:key,selectedRealm:selected,syncStatus:finalStatus,syncError:finalSyncError,lastSync:finishedAt,fullSyncJob:null,realmStores:finalStores});
    },selected),8000,'Final Sync commit');
    if(requiredOk) await persistCriticalDataBaseline(selected,'sync-complete').catch(()=>{});
    trace('sync-core-persisted',{realm:selected,finalStatus,finishedAt});
    syncCoreSucceeded=requiredOk;
    if(requiredOk && results.some(r=>r.name==='Accounting'&&r.ok&&r.accountingWeekLedger?.deferred)){
      await setAccountingWeekLedgerStatus(selected,'scheduled',null,{reason:'core-sync',scheduledAt:new Date().toISOString()}).catch(()=>{});
      const ledgerSchedule=await scheduleAccountingWeekRefresh(selected,1500).catch(e=>({ok:false,error:e?.message||String(e),realm:selected}));
      trace('accounting-week-ledger-scheduled',{realm:selected,...ledgerSchedule});
      const dayWalk=await scheduleAccountingDayWalk(selected,4000).catch(e=>({ok:false,error:e?.message||String(e)}));
      trace('accounting-day-walk-scheduled',{realm:selected,...dayWalk});
      ensureAccountingWalkSchedule('after-sync').catch(()=>{});
    }
    if(requiredOk){
      // Final realm-local commit: the selected realm store is authoritative.
      // IMPORTANT: after the split-sync change, Sync writes directly into the
      // realm container while the root remains the previous live mirror. Calling
      // persistActiveRealm() here reverses that direction and can overwrite fresh
      // Buildings/Warehouse/endpoint data with the stale root snapshot. Hydrate
      // the root FROM the committed realm store before handing the capture lock
      // to the optional post-sync UI refresh. This closes the handoff race where
      // another Sync could observe a still-finalizing root while the tail starts.
      const committedBeforeHydrate=await state(selected);
      const committedStoreBeforeHydrate=committedBeforeHydrate.realmStores?.[key]||{};
      await activateRealmByRealm(selected, committedStoreBeforeHydrate.authData?.authCompany ? committedStoreBeforeHydrate.authData : null);
      const committed=await state(selected);
      const committedStore=committed.realmStores?.[key]||{};
      trace('realm-store-commit',{realm:selected,endpointCount:Object.keys(committedStore.endpointData||{}).length,warehouseRows:Array.isArray(committedStore.warehouseResources)?committedStore.warehouseResources.length:0,fullSyncStatus:committedStore.syncStatus||null});
      trace('sync-complete',{ok:true,successful,failed,total,elapsedMs:Date.now()-startedAt});
      refreshMarketOrders(selected,0).catch(()=>{});refreshGameConstants().catch(()=>{});refreshExtraGameData(selected).catch(()=>{});
      const bridgeState=await state();
      if(bridgeState.liveBridge?.enabled && bridgeState.liveBridge?.pushOnSync) pushLiveBridge(selected,true).catch(()=>{});

      // Core Sync is complete. Run the proven bounded building enrichment tail
      // inside the same service-worker event before releasing the game-page
      // capture lock. Chrome alarms are intentionally NOT used for this handoff:
      // an alarm scheduled hundreds of milliseconds in the future is not a
      // sub-second continuation mechanism in installed Chrome extensions.
      const postStarted=Date.now();
      trace('post-sync-ui-refresh-start',{realm:selected});
      try{
        const buildingResult=await postSyncBuildingUiRefresh(selected,trace);
        trace('post-sync-ui-refresh-complete',{realm:selected,ok:Boolean(buildingResult?.ok),count:Number(buildingResult?.count)||0,source:buildingResult?.source||null,durationMs:Date.now()-postStarted});
      }catch(e){
        trace('post-sync-tail-error',{realm:selected,error:e?.message||String(e),durationMs:Date.now()-postStarted});
      }
      try{scheduleGameOverlayRefreshNotification(selected,150);}catch{}

      // Save the final diagnostic AFTER the building tail so it reports the
      // actual realm store, not the pre-enrichment state.
      try{
        const enrichState=await state(selected);
        const enrichStore=enrichState.realmStores?.[key]||{};
        const verified=await state(selected);
        const verifiedStore=verified.realmStores?.[key]||{};
        trace('post-sync-building-state',{realm:selected,count:Array.isArray(verifiedStore.buildings)?verifiedStore.buildings.length:0});
        await withSyncTimeout(saveFullSyncDiagnostic({
          realm:selected,
          mode:'api-first-sync-with-ui-fallback',
          status:finalStatus,
          syncError:finalSyncError,
          lastSync:finishedAt,
          walkResults:results,
          endpointCount:Object.keys(enrichStore.endpointData||{}).length,
          warehouseRows:Array.isArray(enrichStore.warehouseResources)?enrichStore.warehouseResources.length:0,
          startedAt,
          finishedAt,
          syncPolicy:{apiFirst:true,clickTimeoutMs:SYNC_CLICK_TIMEOUT_MS,fallbackCaptureMs:SYNC_CAPTURE_FALLBACK_MS,pageApiTimeoutMs:SYNC_PAGE_API_TIMEOUT_MS,pageApiAttempts:SYNC_PAGE_API_ATTEMPTS},
          syncTrace
        },selected),5000,'Post-enrichment Sync diagnostic persistence');
      }catch(e){
        trace('post-sync-diagnostic-save-error',{realm:selected,error:e?.message||String(e)});
      }
      // The diagnostic trace showed a completed R2 sync while the durable
      // realm-local status had reverted to "Never synced". A late status/progress
      // write can race the core final commit during the post-sync enrichment tail.
      // Reassert the terminal result against the latest physical realm store after
      // all tail work, and mirror it only if this realm is still active.
      try{
        await withSyncTimeout(commitLatestRealmPatch(selected,{
          syncStatus:finalStatus,
          syncError:finalSyncError,
          lastSync:finishedAt,
          fullSyncJob:null
        },['syncStatus','syncError','lastSync','fullSyncJob']),8000,'Final realm status reconciliation');
        trace('final-status-reconciled',{realm:selected,status:finalStatus,lastSync:finishedAt});
        await persistTrace(true);
      }catch(e){
        trace('final-status-reconciliation-error',{realm:selected,error:e?.message||String(e)});
        await persistTrace(true).catch(()=>{});
      }
      // Cleanup is centralized in finally so the capture boundary is released
      // exactly once and cannot hold the caller open indefinitely.
      return {ok:true,realm:selected,results,total,successful,failed,elapsedMs:Date.now()-startedAt};
    }
    return {ok:false,realm:selected,results,total,successful,failed,missingRequiredWrites,missingRequiredEndpoints,elapsedMs:Date.now()-startedAt,error:finalSyncError};
  }catch(e){
    const error=e?.message||String(e);
    syncTrace.push({at:Date.now(),type:'sync-exception',error});
    const sel=validRealmNumber((await chrome.storage.local.get({selectedRealm:null})).selectedRealm);
    if(sel!=null){
      const status=`Sync failed · ${realmDisplayNumber(sel)||'selected realm'}`;
      await withSyncTimeout(setRealmLoadStatus(sel,status,error),5000,'Sync failure status persistence').catch(()=>{});
      try{
        const failedState=await state(sel);
        const failedStore=failedState.realmStores?.[realmKeyFromRealm(sel)]||{};
        const finishedAt=new Date().toISOString();
        await withSyncTimeout(saveFullSyncDiagnostic({realm:sel,mode:'api-first-sync-with-ui-fallback',status,syncError:error,walkResults:[],endpointCount:Object.keys(failedStore.endpointData||{}).length,warehouseRows:Array.isArray(failedStore.warehouseResources)?failedStore.warehouseResources.length:0,startedAt,finishedAt,error,syncTrace:typeof syncTrace!=='undefined'?syncTrace:[]},sel),5000,'Sync failure diagnostic persistence').catch(()=>{});
        await withSyncTimeout(clearFullSyncJob(sel,{syncStatus:status,syncError:error}),5000,'Sync failure job cleanup').catch(()=>{});
      }catch{}
    }else await storageSet({syncStatus:'Sync failed',syncError:error,fullSyncJob:null});
    return {ok:false,error,realm:sel};
  }finally{
    // Page-hook cleanup is best-effort after terminal status has been written.
    // A missing content-script response must not keep SYNC_NOW pending or leave
    // the dashboard button disabled after the sync transaction has ended.
    try{
      const t=await simTab();
      if(t?.id) await withSyncTimeout(chrome.tabs.sendMessage(t.id,{type:'CLEAR_SYNC_REALM'}),1500,'Clear Sync realm capture boundary').catch(()=>{});
    }catch{}
    if(ownsSyncSession && selected!=null){ realmSyncSessions.delete(selected); if(syncCaptureRealm===selected) syncCaptureRealm=null; }
    if(ownsSyncSession && selected!=null){
      const syncFinishedAt=new Date().toISOString();
      const traceFailed=Array.isArray(syncTrace)&&syncTrace.some(x=>/failed|error|exception/i.test(String(x?.type||'')));
      await recordBackgroundJobEvent(selected,{job:'core-sync',trigger:'manual-or-dashboard',startedAt:new Date(startedAt).toISOString(),finishedAt:syncFinishedAt,durationMs:Date.now()-startedAt,outcome:syncCoreSucceeded?(traceFailed?'partial':'success'):'failure',requested:targets.length,fetched:syncTrace.filter(x=>x?.type==='endpoint-captured').length,refreshed:syncTrace.filter(x=>x?.type==='endpoint-captured').length,checked:targets.length,cached:0,stale:0,error:syncCoreSucceeded?null:([...syncTrace].reverse().find(x=>/sync-exception|sync-failed/i.test(String(x?.type||'')))?.error||null),details:{coreSyncSucceeded:Boolean(syncCoreSucceeded),traceEvents:syncTrace.length,targets:targets.map(t=>t.name)}}).catch(()=>{});
    }
    if(syncCoreSucceeded && selected!=null){
      const scheduled=await schedulePostSyncMarketRefresh(selected,'sync-complete').catch(e=>({ok:false,error:e?.message||String(e)}));
      try{await recordBackgroundJobEvent(selected,{job:'post-sync-market-refresh-scheduled',trigger:'sync-complete',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),durationMs:0,outcome:scheduled?.ok?'success':'failure',error:scheduled?.error||null,details:scheduled||{}});}catch{}
    }
  }
}

async function postSyncBuildingUiRefresh(realm, traceFn=null){
  const selected=validRealmNumber(realm);
  if(selected==null) return {ok:false,skipped:true,error:'Invalid realm.'};
  const started=Date.now();
  const note=(type,payload={})=>{try{traceFn?.(type,payload);}catch{}};
  const key=realmKeyFromRealm(selected);
  try{
    let current=await state(selected);
    let store=current.realmStores?.[key]||{};
    const existing=Array.isArray(store.buildings)?store.buildings:[];
    if(existing.length){
      note('building-enrichment-existing',{realm:selected,count:existing.length});
      return {ok:true,count:existing.length,source:'realm-store',elapsedMs:Date.now()-started};
    }
    const buildingPath='/api/v2/companies/me/buildings/';
    try{
      note('building-enrichment-api-request',{realm:selected,path:buildingPath});
      const response=await pageGet(buildingPath,selected,null,'building-enrichment');
      const rows=Array.isArray(response?.data)?response.data:(['buildings','data','items','results'].map(k=>Array.isArray(response?.data?.[k])?response.data[k]:null).find(Boolean)||[]);
      note(response?.ok&&rows.length?'building-enrichment-api-success':'building-enrichment-api-failure',{realm:selected,path:buildingPath,status:Number(response?.status)||0,count:rows.length,error:response?.error||null});
      if(response?.ok&&rows.length){
        await saveData(buildingPath,response.data,response.status,'GET',selected);
        const verified=await state(selected); const verifiedStore=verified.realmStores?.[key]||{};
        const count=Array.isArray(verifiedStore.buildings)?verifiedStore.buildings.length:0;
        if(count){ note('building-enrichment-success',{realm:selected,count,source:'buildings-api',elapsedMs:Date.now()-started}); return {ok:true,count,source:'buildings-api',elapsedMs:Date.now()-started}; }
      }
    }catch(e){ note('building-enrichment-api-error',{realm:selected,path:buildingPath,error:e?.message||String(e)}); }
    const tab=await simTab();
    if(!tab?.id) return {ok:false,count:0,error:'Logged-in game tab is not available.',elapsedMs:Date.now()-started};
    for(let i=0;i<5;i++){
      try{await chrome.tabs.sendMessage(tab.id,{type:'PAGE_GAME_STATE'});}catch{}
      await new Promise(r=>setTimeout(r,300));
      current=await state(selected); store=current.realmStores?.[key]||{};
      const buildings=Array.isArray(store.buildings)?store.buildings:[];
      if(buildings.length){ note('building-enrichment-game-state-success',{realm:selected,count:buildings.length,attempt:i+1,source:'game-localStorage',elapsedMs:Date.now()-started}); return {ok:true,count:buildings.length,source:'game-localStorage',elapsedMs:Date.now()-started}; }
    }
    let warehouseClick={ok:false,error:'UI click not attempted.'};
    try{warehouseClick=await executeGameClick(tab.id,{name:'Warehouse',labels:['Warehouse','Warehouses'],hrefHints:['/headquarters/warehouse/']});}catch(e){warehouseClick={ok:false,error:e?.message||String(e)};}
    note('building-ui-refresh-click',{step:'warehouse',ok:Boolean(warehouseClick?.ok),error:warehouseClick?.error||null,element:warehouseClick?.element||null,beforeUrl:warehouseClick?.beforeUrl||null,urlAfterClick:warehouseClick?.urlAfterClick||null});
    await new Promise(r=>setTimeout(r,400));
    let mapClick={ok:false,error:'Map UI click not attempted.'};
    try{mapClick=await executeGameClick(tab.id,{name:'Map',labels:['Map'],hrefHints:['/landscape/','/map/','/map']});}catch(e){mapClick={ok:false,error:e?.message||String(e)};}
    note('building-ui-refresh-click',{step:'map-final',ok:Boolean(mapClick?.ok),error:mapClick?.error||null,element:mapClick?.element||null,beforeUrl:mapClick?.beforeUrl||null,urlAfterClick:mapClick?.urlAfterClick||null});
    for(let i=0;i<8;i++){
      try{await chrome.tabs.sendMessage(tab.id,{type:'PAGE_GAME_STATE'});}catch{}
      await new Promise(r=>setTimeout(r,450));
      current=await state(selected); store=current.realmStores?.[key]||{};
      const buildings=Array.isArray(store.buildings)?store.buildings:[];
      if(buildings.length){ note('building-enrichment-success',{realm:selected,count:buildings.length,source:'game-page-ui->game-localStorage',elapsedMs:Date.now()-started}); return {ok:true,count:buildings.length,source:'game-page-ui->game-localStorage',elapsedMs:Date.now()-started}; }
    }
    note('building-enrichment-failed',{realm:selected,count:0,source:'all-building-paths',elapsedMs:Date.now()-started,warehouseClickOk:Boolean(warehouseClick?.ok),mapClickOk:Boolean(mapClick?.ok)});
    return {ok:false,count:0,error:'No building snapshot was captured by API or game-page enrichment.',elapsedMs:Date.now()-started};
  }catch(e){ note('building-enrichment-error',{realm:selected,error:e?.message||String(e),elapsedMs:Date.now()-started}); return {ok:false,count:0,error:e?.message||String(e),elapsedMs:Date.now()-started}; }
}
function bridgeSafeEndpointMap(store){
  const out={};
  for(const [url,v] of Object.entries(store?.endpointData||{})){
    if(!v || typeof v!=='object') continue;
    out[url]={status:Number(v.status)||0,receivedAt:v.receivedAt||null,captureRealm:validRealmNumber(v.captureRealm),method:String(v.method||'GET'),useful:Boolean(v.useful),data:v.data};
  }
  return out;
}
function buildLiveBridgePayload(s, realm, store, overlay){
  const auth=s.authData||store.authData||{};
  const authCompany=auth?.authCompany||{};
  return {
    schemaVersion:1,
    managerVersion:BUILD_VERSION,
    capturedAt:new Date().toISOString(),
    realm:Number(realm),
    realmKey:realmKeyFromRealm(Number(realm)),
    company:{id:Number(authCompany.id||authCompany.companyId||s.companyData?.id)||null,name:String(authCompany.name||s.companyData?.name||s.companyData?.companyName||'')||null},
    sync:{status:store.syncStatus||s.syncStatus||null,lastSync:store.lastSync||s.lastSync||null,error:store.syncError||s.syncError||null},
    production:{
      runHours:Number(store.productionRunHours||s.productionRunHours)||24,
      plans:store.productionPlans||{},
      rateSnapshots:store.productionRateSnapshots||{},
      events:Array.isArray(store.productionEvents)?store.productionEvents:[],
      buildings:Array.isArray(store.gameState?.buildings)?store.gameState.buildings:(Array.isArray(s.gameState?.buildings)?s.gameState.buildings:[])
    },
    warehouse:Array.isArray(store.warehouseResources)?store.warehouseResources:[],
    contracts:Array.isArray(store.contracts)?store.contracts:[],
    overlay:overlay||store.gameOverlaySnapshot||null,
    endpoints:bridgeSafeEndpointMap(store)
  };
}
async function pushLiveBridge(realm, force=false){
  const n=validRealmNumber(realm); if(n==null)return {ok:false,error:'Valid realm required.'};
  const s=await state(realm); const cfg=s.liveBridge||{};
  const url=String(cfg.url||'').trim(); const token=String(cfg.token||'').trim();
  if(!cfg.enabled||!url)return {ok:false,skipped:true,error:'Live bridge is not enabled or URL is missing.'};
  if(!/^https:\/\//i.test(url))return {ok:false,error:'Live bridge URL must use HTTPS.'};
  if(!force && cfg.lastPushAt && Date.now()-Date.parse(cfg.lastPushAt)<15000)return {ok:false,skipped:true,error:'Bridge push throttled.'};
  const key=realmKeyFromRealm(n); const store={...(s.realmStores?.[key]||{})};
  let overlay=null; try{overlay=await buildGameOverlayData(store,n,s);}catch{}
  const payload=buildLiveBridgePayload(s,n,store,overlay);
  const headers={'Content-Type':'application/json'}; if(token)headers.Authorization=`Bearer ${token}`;
  try{
    const r=await fetch(url,{method:'POST',headers,body:JSON.stringify(payload)});
    const text=await r.text();
    const status={ok:r.ok,at:new Date().toISOString(),status:r.status,error:r.ok?null:(text.slice(0,500)||`HTTP ${r.status}`)};
    await storageSet({liveBridge:{...cfg,lastPushAt:status.at,lastPushStatus:status}});
    return {ok:r.ok,status:r.status,error:status.error,realm:n};
  }catch(e){
    const status={ok:false,at:new Date().toISOString(),status:0,error:e?.message||String(e)};
    await storageSet({liveBridge:{...cfg,lastPushAt:status.at,lastPushStatus:status}});
    return {ok:false,error:status.error,realm:n};
  }
}

function overlaySnapshotSignature(data){
  const rows=Array.isArray(data?.rows)?data.rows:[];
  // The persisted snapshot is also the source for the in-game Copy Left UI.
  // Include every presentation field that can change the copied text, especially
  // resource+quality VWAP.  The old signature ignored VWAP, so a fresh overlay
  // could calculate prices correctly but persist no change when the only new
  // field was `vwap`; the browser would then keep receiving the price-less
  // snapshot indefinitely.
  return JSON.stringify({
    realm:Number(data?.realm),
    contractSource:String(data?.contractSource||''),
    savedContractsSignature:String(data?.savedContractsSignature||''),
    rows:rows.map(r=>({
      id:Number(r.id),
      name:String(r.name||""),
      quality:Number(r.quality)||0,
      warehouse:Number(r.warehouse)||0,
      demand:Number(r.demand)||0,
      contracted:Number(r.contracted)||0,
      incoming:Number(r.incoming)||0,
      outgoing:Number(r.outgoing)||0,
      stock:Number(r.stock)||0,
      difference:Number(r.difference)||0,
      surplus:Number(r.surplus)||0,
      vwap:Number.isFinite(Number(r.vwap))?Number(r.vwap):null
    })).sort((a,b)=>a.id-b.id||a.quality-b.quality)
  });
}
async function persistGameOverlaySnapshot(realm,data){
  const n=validRealmNumber(realm); if(n==null||!data)return;
  const overlayKey=gameOverlaySnapshotStorageKey(n); if(!overlayKey)return;
  const stripped=await stripOverlayEmbeddedImages(data).catch(()=>data);
  const next={...stripped,realm:n,signature:overlaySnapshotSignature(stripped),savedAt:new Date().toISOString()};
  const raw=await chrome.storage.local.get({[overlayKey]:null});
  const old=raw?.[overlayKey];
  const oldSig=old?JSON.stringify({realm:old.realm,rows:old.rows,contractSource:old.contractSource||'',savedContractsSignature:old.savedContractsSignature||''}):"";
  const newSig=JSON.stringify({realm:next.realm,rows:next.rows,contractSource:next.contractSource||'',savedContractsSignature:next.savedContractsSignature||''});
  if(oldSig===newSig)return;
  await rawStorageSet({[overlayKey]:next});
  gameOverlaySnapshotMemo.set(n,next);
  // The game-page saved-contract helper caches computed quantities briefly.
  // Invalidate it whenever the authoritative stock/demand/contract snapshot changes.
  if(typeof contractHelperCache!=='undefined')contractHelperCache.delete(n);
}
async function stripOverlayEmbeddedImages(v){
  if(!v||typeof v!=='object')return v;
  const lists=['rows','ticker'].filter(k=>Array.isArray(v[k])&&v[k].some(x=>typeof x?.image==='string'&&x.image.startsWith('data:')));
  if(!lists.length)return v;
  const assets=await gameOverlayAssets().catch(()=>null);
  if(!assets?.images||!assets.imageBase)return v;
  const out={...v};
  for(const k of lists)out[k]=v[k].map(x=>{const file=assets.images[String(x?.id)];return file&&typeof x?.image==='string'&&x.image.startsWith('data:')?{...x,image:`${assets.imageBase}${file}`}:x;});
  return out;
}
function lastGoodGameOverlaySnapshot(source,realm){
  const snap=source?.rows?source:(source?.gameOverlaySnapshot||null);
  if(!snap||Number(snap.realm)!==Number(realm)||!Array.isArray(snap.rows)||!snap.rows.length)return null;
  // Sanitize a legacy cached snapshot before the asynchronous heavy refresh.
  // v2.5.214 could persist an incoming-only, non-produced row such as R1 Water.
  // Do not let that stale row remain visible during the refresh window.
  const currentSavedContractSchema=String(snap.contractSource||'')==='manager-saved-contracts-only';
  if(currentSavedContractSchema){
    // Current snapshots were computed from the dedicated savedContracts list.
    // Preserve both saved incoming and outgoing impacts while a refresh runs;
    // stripping outgoing here caused the visible values to flip every refresh.
    return {...snap,rows:snap.rows.map(row=>({...row})),ok:true,stale:true,source:'realm-local-last-good-snapshot'};
  }
  const rows=snap.rows.map(row=>{
    // Unmarked legacy snapshots may include live outgoing game contracts. Strip
    // those legacy values once, until a new explicitly-sourced snapshot is stored.
    const incoming=Math.max(0,Number(row?.incoming)||0);
    const warehouse=Number(row?.warehouse)||0;
    const demand=Number(row?.demand)||0;
    const left=warehouse-demand+incoming;
    return {...row,outgoing:0,contracted:-incoming,leftover:left,difference:left,warehouseOnlyLeft:left};
  }).filter(row=>{
    const produced=Math.abs(Number(row?.produced)||0)>1e-9;
    const incoming=Math.abs(Number(row?.incoming)||0)>1e-9 || Number(row?.contracted)<-1e-9;
    return produced || !incoming;
  });
  if(!rows.length)return null;
  return {...snap,rows,ok:true,stale:true,source:"realm-local-last-good-snapshot"};
}

const GAME_OVERLAY_REFRESH_MS=30000;
const gameOverlayRefreshPromises=new Map();
const gameOverlayLastRefreshAt=new Map();
// v2.5.327 mobile: the game page polls GET_GAME_OVERLAY_DATA every 10 s. Each heavy rebuild reads the realm
// store, recomputes the overlay and fetches the warehouse through the page. Rebuild when data actually
// changed (any path that saves warehouse/building/contract data marks the realm dirty) or at most every
// GAME_OVERLAY_REFRESH_MS otherwise. The last snapshot is served from memory instead of storage.
const gameOverlayDirty=new Set();
const gameOverlaySnapshotMemo=new Map();
globalThis.__scmOwnWriteHooks?.push(items=>{for(const k of Object.keys(items)){const m=/^scmGameOverlaySnapshot:(\d+)$/.exec(k);if(m)gameOverlaySnapshotMemo.delete(Number(m[1]));}});
const contractHelperCache=new Map();
const gameOverlayNotifyTimers=new Map();
const warehouseMutationRefreshTimers=new Map();
// v2.5.328: several quick actions ("accept all" across buildings) are batched into one warehouse fetch.
// If an action lands while a fetch is already running, one more fetch runs afterwards so it is never missed.
const warehouseMutationLastAt=new Map();
function scheduleWarehouseRefreshAfterStockMutation(realm,delayMs=300){
  const n=validRealmNumber(realm); if(n==null)return;
  warehouseMutationLastAt.set(n,Date.now());
  const prior=warehouseMutationRefreshTimers.get(n); if(prior)clearTimeout(prior);
  const timer=setTimeout(()=>{
    warehouseMutationRefreshTimers.delete(n);
    const inFlight=warehouseOverlayRefreshRuns.get(n);
    const start=()=>{
      const startedAt=Date.now();
      refreshRealmWarehouseForOverlay(n,0).then(result=>{
        if(result?.ok&&result?.refreshed)scheduleGameOverlayRefreshNotification(n,50);
        if((warehouseMutationLastAt.get(n)||0)>startedAt&&!warehouseMutationRefreshTimers.has(n))scheduleWarehouseRefreshAfterStockMutation(n,150);
      }).catch(()=>{});
    };
    if(inFlight)inFlight.finally(start); else start();
  },Math.max(150,Number(delayMs)||300));
  warehouseMutationRefreshTimers.set(n,timer);
}

// A stock mutation and an overlay repaint often request the same warehouse snapshot.
// Share one authoritative fetch per realm so these triggers do not race or duplicate requests.
const warehouseOverlayRefreshRuns=new Map();
async function refreshRealmWarehouseForOverlay(realm,maxAgeMs=15000){
  const n=validRealmNumber(realm);if(n==null)return {ok:false,error:'Invalid realm.'};
  const existing=warehouseOverlayRefreshRuns.get(n);if(existing)return existing;
  if(warehouseOverlayRefreshInBackoff(n,maxAgeMs))return {ok:false,backoff:true,error:'Warehouse refresh paused after a failed attempt.'};
  const startedMs=Date.now(),startedAt=new Date(startedMs).toISOString();
  const run=refreshRealmWarehouseForOverlayUnlocked(n,maxAgeMs).then(async result=>{
    noteWarehouseOverlayRefreshResult(n,maxAgeMs,result);
    const finishedAt=new Date().toISOString();
    await recordBackgroundJobEvent(n,{job:'warehouse-refresh',trigger:maxAgeMs===0?'stock-mutation-or-forced':'overlay-refresh',startedAt,finishedAt,durationMs:Date.now()-startedMs,outcome:result?.ok?(result?.cached?'skipped':'success'):(result?.notReady?'skipped':(result?.stale||result?.incomplete?'partial':'failure')),requested:1,fetched:result?.refreshed?1:0,refreshed:result?.refreshed?1:0,checked:1,cached:result?.cached?1:0,error:result?.error||null,details:{rows:result?.rows??null,requestDurationMs:result?.requestDurationMs??null,storageCommitDurationMs:result?.storageCommitDurationMs??null,totalDurationMs:result?.totalDurationMs??null}}).catch(()=>{});
    return {...result,jobStartedAt:startedAt,jobFinishedAt:finishedAt,jobDurationMs:Date.now()-startedMs};
  }).finally(()=>{if(warehouseOverlayRefreshRuns.get(n)===run)warehouseOverlayRefreshRuns.delete(n);});
  warehouseOverlayRefreshRuns.set(n,run);return run;
}

function notifyDashboardAccountingLedgerReady(realm){
  const n=validRealmNumber(realm); if(n==null)return;
  try{chrome.runtime.sendMessage({type:'ACCOUNTING_WEEK_LEDGER_READY',realm:n}).catch(()=>{});}catch{}
}
async function notifyGameOverlayRefresh(realm){
  const n=validRealmNumber(realm);if(n==null)return {ok:false,error:'Invalid realm.'};
  const startedMs=Date.now(),startedAt=new Date(startedMs).toISOString();let tabs=[],sent=0,failed=0;
  try{tabs=await chrome.tabs.query({url:['https://www.simcompanies.com/*','https://simcompanies.com/*']});}catch(e){failed++;}
  for(const tab of tabs||[]){try{await chrome.tabs.sendMessage(tab.id,{type:'REFRESH_GAME_OVERLAY',realm:Number(n)});sent++;}catch{failed++;}}
  const finishedAt=new Date().toISOString();
  await recordBackgroundJobEvent(n,{job:'overlay-refresh-notification',trigger:'warehouse-snapshot-committed',startedAt,finishedAt,durationMs:Date.now()-startedMs,outcome:sent?(failed?'partial':'success'):'failure',requested:(tabs||[]).length,fetched:sent,refreshed:sent,checked:(tabs||[]).length,cached:0,error:sent?null:'No game tab acknowledged the overlay refresh message.',details:{tabsFound:(tabs||[]).length,messagesSent:sent,sendFailures:failed}}).catch(()=>{});
  return {ok:sent>0,sent,failed,tabsFound:(tabs||[]).length,durationMs:Date.now()-startedMs};
}
function scheduleGameOverlayRefreshNotification(realm,delayMs=650,{markDirty=true}={}){
  const n=validRealmNumber(realm); if(n==null)return;
  if(markDirty)gameOverlayDirty.add(n);
  const prior=gameOverlayNotifyTimers.get(n); if(prior)clearTimeout(prior);
  const timer=setTimeout(()=>{
    gameOverlayNotifyTimers.delete(n);
    notifyGameOverlayRefresh(n).catch(()=>{});
  },Math.max(150,Number(delayMs)||650));
  gameOverlayNotifyTimers.set(n,timer);
}

async function refreshGameOverlayDataHeavy(realm){
  const n=validRealmNumber(realm);
  if(n==null)return {ok:false,error:'No game realm available.'};
  const existing=gameOverlayRefreshPromises.get(n);
  // v2.5.328: data changed while an older rebuild is running -> that rebuild used the old stock; run one
  // more as soon as it finishes instead of waiting for a later poll.
  if(existing)return gameOverlayDirty.has(n)?existing.catch(()=>{}).then(()=>refreshGameOverlayDataHeavy(n)):existing;
  gameOverlayDirty.delete(n);
  const promise=(async()=>{
    const key=realmKeyFromRealm(n);
    if(!key)throw new Error('No game realm available.');
    await ensureRealmAuthData(n);
    let latest=await state(realm);
    let store={...(latest.realmStores?.[key]||{})};
    const haveWarehouse=Array.isArray(store.warehouseResources)&&store.warehouseResources.length>0;
    let data=null;

    // Do not block the first overlay paint on a second warehouse round-trip
    // when a usable warehouse snapshot is already present. Build immediately,
    // then refresh the warehouse and publish a replacement snapshot when it
    // arrives. This keeps the overlay responsive without sacrificing freshness.
    if(haveWarehouse){
      data=await buildGameOverlayData(store,n,latest);
      try{await persistGameOverlaySnapshot(n,data);}catch{}
      gameOverlayLastRefreshAt.set(n,Date.now());
      Promise.resolve().then(async()=>{
        try{
          const refreshed=await refreshRealmWarehouseForOverlay(n,12000);
          if(!refreshed?.ok||!refreshed?.refreshed)return;
          const freshState=await state(n);
          const freshStore={...(freshState.realmStores?.[key]||{})};
          const freshData=await buildGameOverlayData(freshStore,n,freshState);
          await persistGameOverlaySnapshot(n,freshData);
          gameOverlayLastRefreshAt.set(n,Date.now());
          scheduleGameOverlayRefreshNotification(n,150,{markDirty:false});
        }catch{}
      });
      return {ok:true,...data,refreshing:true};
    }

    // No usable warehouse snapshot exists yet; one bounded live fetch is still
    // required so the overlay does not publish an empty balance.
    try{await refreshRealmWarehouseForOverlay(n,12000);}catch{}
    latest=await state(realm);
    store={...(latest.realmStores?.[key]||{})};
    data=await buildGameOverlayData(store,n,latest);
    try{await persistGameOverlaySnapshot(n,data);}catch{}
    gameOverlayLastRefreshAt.set(n,Date.now());
    return {ok:true,...data,refreshing:false};
  })();
  gameOverlayRefreshPromises.set(n,promise);
  promise.then(()=>{if(gameOverlayRefreshPromises.get(n)===promise)gameOverlayRefreshPromises.delete(n);}, ()=>{if(gameOverlayRefreshPromises.get(n)===promise)gameOverlayRefreshPromises.delete(n);});
  return promise;
}


// v2.5.102: realm-scoped data provider for the in-game helper overlays.
// This is presentation data only; production/planner/construction calculations
// remain in their existing code paths.
function helperLatestEndpoint(store, rx){
  const entries=Object.entries(store?.endpointData||{}).filter(([url,v])=>rx.test(String(url||''))&&Number(v?.status)>=200&&Number(v?.status)<300&&v?.data!=null);
  entries.sort((a,b)=>Date.parse(b[1]?.receivedAt||0)-Date.parse(a[1]?.receivedAt||0));
  return entries[0]?.[1]?.data??null;
}
function helperArray(v, keys=['data','items','results']){
  if(Array.isArray(v))return v;
  if(!v||typeof v!=='object')return [];
  for(const k of keys)if(Array.isArray(v[k]))return v[k];
  return [];
}
chrome.tabs.onActivated.addListener(({tabId})=>{
  requestActiveGameRealm('tab-activated').catch(()=>{});
});
chrome.tabs.onUpdated.addListener((tabId,changeInfo,tab)=>{
  if(!tab?.active)return;
  if(changeInfo.status==='complete'||changeInfo.url) requestActiveGameRealm('active-game-tab-updated').catch(()=>{});
});


const jsDiagnosticPending = new Map();

function diffStringSet(previous=[], current=[]){
  const a=new Set(Array.isArray(previous)?previous.map(String):[]);
  const b=new Set(Array.isArray(current)?current.map(String):[]);
  return {added:[...b].filter(x=>!a.has(x)).sort(),removed:[...a].filter(x=>!b.has(x)).sort()};
}
function diffJsBundles(previous=[], current=[]){
  const a=new Map((Array.isArray(previous)?previous:[]).filter(x=>x?.url).map(x=>[String(x.url),x]));
  const b=new Map((Array.isArray(current)?current:[]).filter(x=>x?.url).map(x=>[String(x.url),x]));
  const added=[],removed=[],changed=[];
  for(const [url,x] of b){if(!a.has(url))added.push({url,hash:x.hash||null});else if((a.get(url)?.hash||null)!==(x.hash||null))changed.push({url,previousHash:a.get(url)?.hash||null,currentHash:x.hash||null});}
  for(const [url,x] of a)if(!b.has(url))removed.push({url,hash:x.hash||null});
  return {added,removed,changed};
}
function diffJsRuntime(previous,next){
  if(!previous||!next)return {available:false};
  const p=previous||{},n=next||{};
  const local=diffStringSet(p.storage?.localStorageKeys,n.storage?.localStorageKeys);
  const session=diffStringSet(p.storage?.sessionStorageKeys,n.storage?.sessionStorageKeys);
  const routes=diffStringSet(p.discoveredApiRoutes,n.discoveredApiRoutes);
  const symbols=diffStringSet(p.discoveredSymbols,n.discoveredSymbols);
  const caches=diffStringSet(p.caches?.names,n.caches?.names);
  const dbs=diffStringSet((p.indexedDB||[]).map(x=>x?.name), (n.indexedDB||[]).map(x=>x?.name));
  const globals=diffStringSet((p.globalKeys||[]).map(x=>x?.name), (n.globalKeys||[]).map(x=>x?.name));
  return {
    available:true,
    comparedAt:n.capturedAt||new Date().toISOString(),
    bundles:diffJsBundles(p.bundles,n.bundles),
    apiRoutes:routes,
    symbols,
    storage:{localStorage:local,sessionStorage:session},
    indexedDB:dbs,
    caches,
    globals,
    serviceWorkers:{previous:(p.serviceWorkers||[]).map(x=>x?.scope||x?.error||''),current:(n.serviceWorkers||[]).map(x=>x?.scope||x?.error||'')}
  };
}
async function saveJavascriptDiagnostic(diagnostic, realm){
  const n=validRealmNumber(realm ?? diagnostic?.runtime?.realm);
  if(n==null) return {ok:false,error:'No valid realm in JavaScript diagnostic.'};
  const key=realmKeyFromRealm(n);
  return withRealmWriteLock(n,async()=>{
    // This diagnostic is explicitly realm-scoped. Reading state() here would
    // return the currently active realm, so an inactive-realm diagnostic could
    // rebuild and overwrite the wrong physical container.
    const s=await state(n);
    const stores={...(s.realmStores||{})};
    const store={...(stores[key]||{})};
    const previous=store.javascriptDiagnostic||null;
    const snapshot={...diagnostic,realm:n,realmDisplay:realmDisplayNumber(n),realmName:realmDisplayName(n)};
    const history=Array.isArray(store.javascriptDiagnosticHistory)?store.javascriptDiagnosticHistory.slice():[];
    if(previous)history.push({capturedAt:previous.capturedAt||null,diff:diffJsRuntime(previous,snapshot)});
    const nextHistory=history.slice(-4);
    const next={...snapshot,previousCapturedAt:previous?.capturedAt||null,diffFromPrevious:diffJsRuntime(previous,snapshot)};
    stores[key]={...store,javascriptDiagnostic:next,javascriptDiagnosticHistory:nextHistory};
    const patch={realmStores:stores};
    if(s.activeRealmKey===key){patch.javascriptDiagnostic=next;patch.javascriptDiagnosticHistory=nextHistory;}
    await storageSet(patch);
    return {ok:true,realm:n,diagnostic:next};
  });
}
async function runQuickJavascriptDiagnostic(tab){
  try{
    const executePromise=chrome.scripting.executeScript({
      target:{tabId:tab.id},
      world:'MAIN',
      func:()=>{
        const realmMatch=location.pathname.match(/\/rc\/(\d+)\//);
        const realm=realmMatch?Number(realmMatch[1]):null;
        const keyList=[];
        try{for(let i=0;i<localStorage.length;i++)keyList.push(localStorage.key(i)||'');}catch{}
        return {
          diagnosticSchemaVersion:1,
          javascriptDiagnosticVersion:'quick-1.0.0',
          capturedAt:new Date().toISOString(),
          durationMs:0,
          runtime:{userAgent:String(navigator.userAgent||''),language:String(navigator.language||''),platform:String(navigator.platform||''),pageUrl:String(location.href),origin:String(location.origin||''),pathname:String(location.pathname||''),readyState:String(document.readyState||''),visibility:String(document.visibilityState||''),realm:Number.isFinite(realm)?realm:null,title:String(document.title||''),scriptTagCount:document.scripts.length,performanceResourceCount:performance.getEntriesByType('resource').length,online:navigator.onLine===true,serviceWorkerController:navigator.serviceWorker?.controller?String(navigator.serviceWorker.controller.scriptURL||''):null},
          bundles:[],performanceResources:performance.getEntriesByType('resource').slice(-200).map(e=>({name:String(e.name||''),initiatorType:String(e.initiatorType||''),duration:Number.isFinite(e.duration)?Math.round(e.duration*100)/100:null,transferSize:Number.isFinite(e.transferSize)?e.transferSize:null,encodedBodySize:Number.isFinite(e.encodedBodySize)?e.encodedBodySize:null,decodedBodySize:Number.isFinite(e.decodedBodySize)?e.decodedBodySize:null,startTime:Number.isFinite(e.startTime)?Math.round(e.startTime*100)/100:null,nextHopProtocol:String(e.nextHopProtocol||'')||null})),
          discoveredApiRoutes:[],discoveredSymbols:[],categoryHits:{},storage:{localStorageKeys:keyList.sort(),sessionStorageKeys:[]},indexedDB:[],caches:{names:[]},serviceWorkers:[],globalKeys:[],limits:{mode:'quick-fallback',note:'Deep page-hook diagnostic did not respond within its bounded window.'}
        };
      }
    });
    const result=await Promise.race([
      executePromise,
      new Promise((resolve)=>setTimeout(()=>resolve(null),3000))
    ]);
    if(!result) return {ok:false,error:'Runtime diagnostic script timed out while the Sim Companies page was unresponsive.'};
    const diagnostic=result?.[0]?.result;
    if(!diagnostic?.runtime)return {ok:false,error:'Quick JavaScript diagnostic returned no page data.'};
    const realm=validRealmNumber(diagnostic.runtime.realm);
    await saveJavascriptDiagnostic(diagnostic,realm);
    return {ok:true,realm,diagnostic,fallback:true};
  }catch(e){
    return {ok:false,error:e?.message||String(e)};
  }
}
async function requestJavascriptDiagnostic(send){
  const tabs=await chrome.tabs.query({active:true,lastFocusedWindow:true});
  let candidates=(tabs||[]).filter(t=>/^https:\/\/(?:www\.)?simcompanies\.com\//i.test(String(t.url||'')));
  if(!candidates.length)candidates=await chrome.tabs.query({url:['https://www.simcompanies.com/*','https://simcompanies.com/*']});
  const tab=candidates?.[0];
  if(!tab?.id)return {ok:false,error:'Open Sim Companies in a browser tab before running the JavaScript diagnostic.'};

  // The deep page-hook collector can contend with the game's SPA during heavy
  // renders and was the source of the repeated mobile timeout alert. Runtime
  // diagnostics are troubleshooting-only, so prefer the bounded quick collector
  // and never block the dashboard on a deep source scan.
  try{
    const quickResult=await Promise.race([
      chrome.tabs.sendMessage(tab.id,{type:'RUN_QUICK_JAVASCRIPT_DIAGNOSTIC'}),
      new Promise(resolve=>setTimeout(()=>resolve(null),1800))
    ]);
    if(quickResult?.ok&&quickResult.diagnostic?.runtime){
      const realm=validRealmNumber(quickResult.diagnostic.runtime.realm);
      await saveJavascriptDiagnostic(quickResult.diagnostic,realm);
      return {ok:true,realm,diagnostic:quickResult.diagnostic,fallback:true,source:'content-script'};
    }
  }catch{}

  const quick=await runQuickJavascriptDiagnostic(tab);
  if(quick.ok)return quick;
  // A runtime diagnostic is optional observability. Return a non-error result so
  // a slow/unresponsive game page never surfaces a blocking Chrome alert.
  return {ok:true,skipped:true,realm:validRealmNumber(candidates?.[0]?.url?.match(/\/rc\/(\d+)\//)?.[1]),diagnostic:null,source:'runtime-diagnostic-skipped',message:'Runtime diagnostic was skipped because the game page was busy.'};
}

replayEvent('runtime-start',{buildVersion:BUILD_VERSION,activeRealmKey:null});

chrome.runtime.onMessage.addListener((m,sender,send)=>{
  if(m?.type==='SET_ACCOUNTING_WALK_SCHEDULE'){(async()=>{const realm=validRealmNumber(m.realm);const patch={enabled:Boolean(m.enabled),offsetMin:accountingWalkOffset(m.offsetMin),attempt:0,retryAt:null};if(realm!=null)patch.realm=realm;await writeAccountingWalkSchedule(patch);const r=await ensureAccountingWalkSchedule('user');return {...r,schedule:await readAccountingWalkSchedule()};})().then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='RUN_ACCOUNTING_WALK_NOW'){(async()=>{const realm=validRealmNumber(m.realm);if(realm!=null)await writeAccountingWalkSchedule({realm});return runScheduledAccountingWalk('manual');})().then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='SCM_MOBILE_NET_START'){scmMobileNetStart(Number(m.tabId)).then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='SCM_MOBILE_NET_STOP'){scmMobileNetStop().then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='SCM_NET3_START'){scmNetStart(Number(m.tabId)).then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='SCM_NET3_STOP'){scmNetStop().then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='SCM_NET3_STATUS'){chrome.storage.local.get('scmNetworkCaptureV3Status').then(x=>send({ok:true,status:x.scmNetworkCaptureV3Status||{status:'idle'}})).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='SCM_NET3_EXPORT'){(async()=>{const id=String(m.captureId||scmNetCapture.captureId||'');if(!id)throw new Error('No Network Capture 3.0 session is available.');const all=await scmNetGetEvents(id);const offset=Math.max(0,Number(m.offset)||0),limit=Math.max(1,Math.min(500,Number(m.limit)||300)),events=all.slice(offset,offset+limit);send({ok:true,captureId:id,events,total:all.length,offset,summary:{eventCount:all.length,requests:all.filter(e=>e.kind==='request'||e.kind==='request-start').length,responses:all.filter(e=>e.kind==='response'||e.kind==='fetch'||e.kind==='xhr').length,bodies:all.filter(e=>e.kind==='response-body'||((e.kind==='fetch'||e.kind==='xhr')&&e.body!=null)).length,bodyUnavailable:all.filter(e=>e.kind==='body-unavailable').length,errors:all.filter(e=>e.kind==='capture-error'||e.kind==='loading-failed'||e.kind==='request-error').length},startedAt:scmNetCapture.startedAt,status:(await chrome.storage.local.get('scmNetworkCaptureV3Status')).scmNetworkCaptureV3Status?.status|| (scmNetCapture.active?'recording':'stopped')});})().catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='REPLAY_FLUSH'){flushReplayJournal(true).then(()=>send({ok:true,count:replayBuffer.length})).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='RUN_JAVASCRIPT_DIAGNOSTIC'){
    requestJavascriptDiagnostic().then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));
    return true;
  }
  if(m?.type==='JAVASCRIPT_DIAGNOSTIC'){
    (async()=>{
      try{
        const saved=await saveJavascriptDiagnostic(m.diagnostic,m.diagnostic?.runtime?.realm);
        const requestId=String(m.requestId||'');
        const pending=jsDiagnosticPending.get(requestId);
        if(pending){pending.resolve(saved);}
        send(saved);
      }catch(e){send({ok:false,error:e?.message||String(e)});}
    })();
    return true;
  }
  if(m?.type==='PRICE_HISTORY'){
    (async()=>{try{send(await getPriceHistory(validRealmNumber(m.realm),m.resourceId,m.quality,Boolean(m.force)));}catch(e){send({ok:false,error:e?.message||String(e)});}})();return true;
  }
  if(m?.type==='LIVE_MARKET_PRODUCT'){
    (async()=>{try{send(await runLiveMarketProduct(validRealmNumber(m.realm),m.resourceId,m.quality));}catch(e){send({ok:false,error:e?.message||String(e)});}})();return true;
  }
  if(m?.type==='LIVE_MARKET_REFRESH'){
    (async()=>{try{const realm=validRealmNumber(m.realm);send(await scheduleMarketCycle(realm,'manual-market-refresh'));}catch(e){send({ok:false,error:e?.message||String(e)});}})();return true;
  }
  if(m?.type==='SET_BUILDING_ALARM'){
    (async()=>{try{
      const realm=validRealmNumber(m.realm)!=null?validRealmNumber(m.realm):validRealmNumber((await state()).selectedRealm);const buildingId=Number(m.buildingId),readyAt=Number(m.readyAt);if(realm==null||!Number.isFinite(buildingId)||!Number.isFinite(readyAt)||readyAt<=Date.now()){send({ok:false,error:'Invalid building alarm.'});return;}
      await withRealmWriteLock(realm,async()=>{
        const key=realmKeyFromRealm(realm),latest=await state(realm),stores={...(latest.realmStores||{})},store={...(stores[key]||{})},alarms={...(store.buildingAlarms||{})};const alarmKey=String(buildingId);alarms[alarmKey]={buildingId,readyAt,createdAt:new Date().toISOString()};stores[key]={...store,buildingAlarms:alarms};await storageSet({realmStores:stores});
      });
      const alarmName=`scm-building-${realm}-${buildingId}`;await chrome.alarms.clear(alarmName);await chrome.alarms.create(alarmName,{when:readyAt});send({ok:true,realm,buildingId,readyAt});
    }catch(e){send({ok:false,error:e?.message||String(e)});}})();return true;
  }
  if(m?.type==='CLEAR_BUILDING_ALARM'){
    (async()=>{try{const realm=validRealmNumber(m.realm),buildingId=Number(m.buildingId);if(realm==null||!Number.isFinite(buildingId)){send({ok:false});return;}await withRealmWriteLock(realm,async()=>{const key=realmKeyFromRealm(realm),s=await state(realm),stores={...(s.realmStores||{})},store={...(stores[key]||{})},alarms={...(store.buildingAlarms||{})};delete alarms[String(buildingId)];stores[key]={...store,buildingAlarms:alarms};await storageSet({realmStores:stores});});await chrome.alarms.clear(`scm-building-${realm}-${buildingId}`);send({ok:true});}catch(e){send({ok:false,error:e?.message||String(e)});}})();return true;
  }
  if(m?.type==='OPEN_MANAGER_TAB') {
    (async()=>{
      try{
        const tabName=String(m.tab||'overview').replace(/[^a-z0-9_-]/gi,'')||'overview';
        const url=chrome.runtime.getURL(`dashboard.html?tab=${encodeURIComponent(tabName)}`);
        const tabs=await chrome.tabs.query({url:chrome.runtime.getURL('dashboard.html')+'*'});
        const existing=(tabs||[])[0];
        if(existing?.id){await chrome.tabs.update(existing.id,{active:true});chrome.runtime.sendMessage({type:'SCM_SELECT_DASHBOARD_TAB',tab:tabName}).catch(()=>{});try{await chrome.windows.update(existing.windowId,{focused:true});}catch{};send({ok:true,tab:tabName,tabId:existing.id});return;}
        const created=await chrome.tabs.create({url,active:true});
        send({ok:true,tab:tabName,tabId:created?.id??null});
      }catch(e){send({ok:false,error:e?.message||String(e)});}
    })(); return true;
  }
  if(m?.type==='SAVE_REALM_FIELD') {
    (async()=>{
      try{
        const realm=validRealmNumber(m.realm ?? (String(m.realmKey||'').match(/^realm:(\d+)$/)?.[1]));
        const field=String(m.field||'');
        const allowed=new Set(['accountingSnapshots','accountingDailySeries','productionRunHours','savedContracts']);
        if(realm==null||!allowed.has(field)){send({ok:false,error:'Invalid realm field.'});return;}
        let value=m.value;
        if(field==='productionRunHours'){
          value=Math.min(48,Math.max(1,Number(value)||24));
        }else if(field==='accountingSnapshots'){
          if(!value||typeof value!=='object'||Array.isArray(value)){send({ok:false,error:'Invalid accounting snapshot.'});return;}
          value={...value,realm:Number(value.realm??realm)};
          if(Number(value.realm)!==realm){send({ok:false,error:'Accounting snapshot realm mismatch.'});return;}
        }else if(field==='accountingDailySeries'){
          // v2.5.377: per-day figures Manager already read (Day statements / balance sheets), newest 120 days.
          const days=value&&typeof value.days==='object'&&!Array.isArray(value.days)?value.days:null;
          if(!days){send({ok:false,error:'Invalid accounting series.'});return;}
          const num=v=>v==null||v===''||!Number.isFinite(Number(v))?undefined:Number(v);
          const keep=Object.keys(days).filter(k=>/^\d{4}-\d{2}-\d{2}$/.test(k)).sort().slice(-120);
          value={v:1,days:Object.fromEntries(keep.map(k=>{const d=days[k]||{};const row={};for(const f of ['sales','operatingExpenses','netIncome','currentLiabilities']){const x=num(d[f]);if(x!==undefined)row[f]=x;}return [k,row];}))};
        }else if(field==='savedContracts'){
          if(!Array.isArray(value)){send({ok:false,error:'Invalid saved-contract list.'});return;}
          value=value.map(x=>x&&typeof x==='object'?{...x}:x);
        }
        const key=realmKeyFromRealm(realm);
        await withRealmWriteLock(realm,async()=>{
          const latest=await state(realm);
          const stores={...(latest.realmStores||{})};
          const store={...(stores[key]||{})};
          store[field]=value;
          stores[key]=store;
          const patch={realmStores:stores};
          if(latest.activeRealmKey===key)patch[field]=value;
          await storageSet(patch);
        });
        if(field==='productionRunHours'){
          const tabs=await chrome.tabs.query({url:['https://www.simcompanies.com/*','https://simcompanies.com/*']});
          for(const tab of tabs||[]){try{await chrome.tabs.sendMessage(tab.id,{type:'REFRESH_GAME_OVERLAY',realm,value});}catch{}}
        }
        send({ok:true,realm,field,value});
      }catch(e){send({ok:false,error:e?.message||String(e)});}
    })(); return true;
  }
  if(m?.type==='PRODUCTION_RUN_HOURS_CHANGED'){
    (async()=>{
      try{
        const realm=validRealmNumber(m.realm);
        if(realm==null){send({ok:false,error:'No realm.'});return;}
        // Tell the live SimCompanies page to rebuild its overlay immediately.
        // The overlay will then read the newly persisted realm-local Production Time.
        const tabs=await chrome.tabs.query({url:['https://www.simcompanies.com/*','https://simcompanies.com/*']});
        for(const tab of tabs||[]){
          try{await chrome.tabs.sendMessage(tab.id,{type:'REFRESH_GAME_OVERLAY',realm,value:Number(m.value)});}catch{}
        }
        send({ok:true,realm,value:Number(m.value)});
      }catch(e){send({ok:false,error:e?.message||String(e)});}
    })(); return true;
  }
  if(m?.type==='GET_COMPANY_AUTH_DATA'){
    (async()=>{
      try{
        const realm=validRealmNumber(m.realm);
        const r=await ensureRealmAuthData(realm);
        send(r);
      }catch(e){send({ok:false,error:e?.message||String(e)});}
    })(); return true;
  }
  if(m?.type==='GET_GAME_OVERLAY_DATA'){
    // v2.5.327 mobile: the game page polls this every 10 s. Replace embedded base64 images with the
    // game's own image URL (already cached by the game page), including in older stored snapshots.
    const reply=send;
    send=async(v)=>{try{reply(await stripOverlayEmbeddedImages(v));}catch{reply(v);}};
    (async()=>{
      let realm=null;
      try{
        const requestedRealm=validRealmNumber(m.realm);
        if(requestedRealm!=null){realm=requestedRealm;}else{
          const meta=await chrome.storage.local.get({activeRealmKey:null});
          realm=validRealmNumber(realmNumberFromKey(meta.activeRealmKey)??meta.activeRealmKey);
        }
        if(realm==null){send({ok:false,error:'No game realm available.'});return;}
        const overlayKey=gameOverlaySnapshotStorageKey(realm);
        let snapshotSource=gameOverlaySnapshotMemo.get(realm);
        if(!snapshotSource){const overlayRaw=overlayKey?await chrome.storage.local.get({[overlayKey]:null}):{};snapshotSource=overlayRaw?.[overlayKey]||null;if(snapshotSource)gameOverlaySnapshotMemo.set(realm,snapshotSource);}
        const fallback=lastGoodGameOverlaySnapshot(snapshotSource,realm);
        const snapshotAt=Date.parse(String(fallback?.savedAt||''));
        const lastRefresh=gameOverlayLastRefreshAt.get(realm)||(Number.isFinite(snapshotAt)?snapshotAt:0);
        if(fallback){
          // Return the last-good snapshot before starting any heavy refresh.
          // The refresh is deliberately deferred to the next task so the
          // overlay request itself never waits on the full realm state, API
          // walk, or contract enrichment.
          if(gameOverlayDirty.has(realm)||Date.now()-lastRefresh>=GAME_OVERLAY_REFRESH_MS){
            setTimeout(()=>{refreshGameOverlayDataHeavy(realm).then(()=>notifyGameOverlayRefresh(realm)).catch(()=>{});},0);
          }
          send(fallback);
          return;
        }
        const fresh=await refreshGameOverlayDataHeavy(realm);
        send(fresh?.ok?fresh:{ok:false,error:fresh?.error||'Unable to build game overlay data.'});
      }catch(e){
        try{
          const overlayKey=gameOverlaySnapshotStorageKey(realm);
          const latest=overlayKey?await chrome.storage.local.get({[overlayKey]:null}):{};
          const fallback=lastGoodGameOverlaySnapshot(latest?.[overlayKey],realm);
          if(fallback){send(fallback);return;}
        }catch{}
        send({ok:false,error:e?.message||String(e)});
      }
    })(); return true;
  }
  if(m?.type==='GET_BUILDING_VWAP_DATA'){
    (async()=>{
      try{const realm=validRealmNumber(m.realm);const r=await getRealmBuildingVwapData(realm,m.resourceName,m.quality);send(r);}catch(e){send({ok:false,error:e?.message||String(e)});}
    })(); return true;
  }
  // v2.5.359 #4 smart sell price for the game's Sell page: cheapest competing listing (quality ≥ the lot's, your own
  // listings left out), 7-day daily VWAP range of id:quality, your warehouse cost, fee from your listings. An order book
  // older than 15 min is refreshed through the game tab (throttled 5 min per product, no lock held while fetching).
  if(m?.type==='GET_SELL_PRICE_INFO'){
    (async()=>{
      try{
        const realm=validRealmNumber(m.realm),id=Number(m.resourceId),q=Number(m.quality);
        if(realm==null||!(id>0)||!Number.isFinite(q)){send({ok:false,error:'Invalid request.'});return;}
        const s=await state(realm);const store={...(s.realmStores?.[realmKeyFromRealm(realm)]||{})};const C=globalThis.SCM_TOOLS_CORE;
        const path=`/api/v3/market/${realm}/${id}/`,ep=store.endpointData?.[path],at=Date.parse(String(ep?.receivedAt||''));
        const haveBook=Array.isArray(ep?.data)&&Number.isFinite(at)&&Date.now()-at<6*3600e3;
        let refreshing=false;
        if(!haveBook||Date.now()-at>15*60e3){refreshing=true;fetchExchangeOrderBookForRealm(realm,id).catch(()=>{});}
        const mo=(await chrome.storage.local.get({[`scmMarketOrders:${realm}`]:null}))[`scmMarketOrders:${realm}`];
        const own=Array.isArray(mo?.orders)?mo.orders:[];
        const lots=(Array.isArray(store.warehouseResources)?store.warehouseResources:[]).filter(l=>Number(l?.kind)===id&&Number(l?.quality)===q);
        const cost=C.warehouseUnitCostAsGame(lots,id);
        const companyId=store.authData?.authCompany?.companyId??store.authData?.authCompany?.id??null;
        const advice=C.sellPriceAdvice({listings:haveBook?ep.data:[],quality:q,history:store.history?.[simcoVwapHistoryKey(id,q)],unitCost:cost?.unitCost??null,feePct:C.listingFeePct(own),companyId,ownIds:own.map(o=>o?.id),now:Date.now()});
        send({ok:true,realm,id,quality:q,orderBookAt:haveBook?ep.receivedAt:null,refreshing,...advice});
      }catch(e){send({ok:false,error:e?.message||String(e)});}
    })(); return true;
  }
  if(m?.type==='GET_INCOMING_CONTRACT_VWAP_DATA'){
    (async()=>{
      try{
        const requestedRealm=validRealmNumber(m.realm);
        // Overlay requests may explicitly target an inactive realm. Read the
        // authoritative physical realm store instead of the active-only view;
        // otherwise an inactive realm can appear empty and return no overlay data.
        const s=await state(requestedRealm);
        const inferredRealm=requestedRealm!=null?requestedRealm:(s.activeRealmKey?Number(String(s.activeRealmKey).replace('realm:','')):validRealmNumber(s.authData?.authCompany?.realmId));
        const realm=validRealmNumber(inferredRealm); if(realm==null){send({ok:false,error:'No realm.'});return;}
        const realmState=await state(realm);
        const key=realmKeyFromRealm(realm),store={...(realmState.realmStores?.[key]||{})};
        const incomingRaw=helperLatestEndpoint(store,/\/api\/v3\/contracts-incoming\/\d+\/me\/?$/i);
        const incoming=helperArray(incomingRaw,['incomingContracts','data','items','results']).map(c=>({id:Number(c?.id),kind:Number(c?.kind),quality:Number(c?.quality)||0,quantity:Number(c?.quantity)||0,price:Number(c?.price)||0,company:String(c?.seller?.company||c?.company||'Unknown seller'),datetime:c?.datetime||null})).filter(c=>Number.isFinite(c.id));
        // v2.5.359 #6 verdict: cheapest exchange listing at quality ≥ the contract's (captured order book, < 6 h; refreshed
        // through the game tab when older than 15 min, ≤ 3 products per pass, throttled 5 min each) and your warehouse cost.
        const C=globalThis.SCM_TOOLS_CORE,lots=Array.isArray(store.warehouseResources)?store.warehouseResources:[];let asked=0;
        for(const c of incoming){
          const comparison=overlayIncomingContractMarketComparison(store,c,realm);
          c.marketPrice=comparison.marketPrice;
          c.savingsPct=comparison.savingsPct;
          c.marketPriceSource=comparison.marketPriceSource;
          try{
            const ep=store.endpointData?.[`/api/v3/market/${realm}/${c.kind}/`],at=Date.parse(String(ep?.receivedAt||''));
            const book=Array.isArray(ep?.data)&&Number.isFinite(at)&&Date.now()-at<6*3600e3?ep.data:null;
            if((!book||Date.now()-at>15*60e3)&&asked<3&&c.kind>0){asked++;fetchExchangeOrderBookForRealm(realm,c.kind).catch(()=>{});}
            const comp=(book||[]).filter(r=>Number(r?.price)>0&&Number(r?.quality)>=c.quality);
            c.exchangePrice=comp.length?Math.min(...comp.map(r=>Number(r.price))):null;
            c.exchangeAt=book?ep.receivedAt:null;
            c.stockCost=C?.warehouseUnitCostAsGame?C.warehouseUnitCostAsGame(lots,c.kind)?.unitCost??null:null;
            c.verdict=C?.contractVerdict?C.contractVerdict({price:c.price,quantity:c.quantity,exchangePrice:c.exchangePrice,stockCost:c.stockCost}):null;
          }catch{}
        }
        send({ok:true,realm,contracts:incoming,marketPriceUpdatedAt:store.liveMarketPriceData?.updatedAt||store.liveMarketPriceData?.fetchedAt||null});
      }catch(e){send({ok:false,error:e?.message||String(e)});}
    })(); return true;
  }
  if(m?.type==='GET_CONTRACT_HELPER_DATA'){
    (async()=>{
      try{
        const realm=validRealmNumber(m.realm); if(realm==null){send({ok:false,error:'No realm.'});return;}
        const now=Date.now();
        const cached=contractHelperCache.get(realm);
        if(cached&&now-cached.at<3000){send(cached.value);return;}
        const s=await state(realm); const key=realmKeyFromRealm(realm); const store={...(s.realmStores?.[key]||{})};
        const saved=Array.isArray(store.savedContracts)?store.savedContracts:[];
        const incomingRaw=helperLatestEndpoint(store,/\/api\/v3\/contracts-incoming\/\d+\/me\/?$/i);
        const incoming=helperArray(incomingRaw,['incomingContracts','data','items','results']).map(c=>({id:Number(c?.id),kind:Number(c?.kind),quality:Number(c?.quality)||0,quantity:Number(c?.quantity)||0,price:Number(c?.price)||0,company:String(c?.seller?.company||c?.company||'Unknown seller'),datetime:c?.datetime||null})).filter(c=>Number.isFinite(c.id));
        const warehouse=Array.isArray(store.warehouseResources)?store.warehouseResources:[];
        const assets=await gameOverlayAssets();
        const grouped=new Map();
        for(const w of warehouse){const id=Number(w?.kind??w?.resourceId??w?.id),q=Number(w?.quality),qty=Number(w?.amount??w?.quantity??w?.qty??w?.units);if(!Number.isFinite(id)||!Number.isFinite(q)||!Number.isFinite(qty))continue;const k=`${id}:${q}`;grouped.set(k,(grouped.get(k)||0)+qty);}
        const stock=[...grouped.entries()].map(([k,qty])=>{const [id,q]=k.split(':').map(Number);return {id,quality:q,quantity:qty,name:assets.names.get(String(id))||`Resource #${id}`};});
        let baseBalanceByKey=new Map();
        try{
          const balance=await buildGameOverlayData(store,realm,s);
          for(const row of (balance.rows||[])){
            const id=Number(row?.id),quality=Number(row?.quality)||0;
            if(!Number.isFinite(id)||id<=0)continue;
            const warehouse=Number(row?.warehouse),demand=Number(row?.demand);
            baseBalanceByKey.set(`${id}:${quality}`,(Number.isFinite(warehouse)?warehouse:0)-(Number.isFinite(demand)?demand:0));
          }
        }catch{}
        for(const row of stock){
          const key=`${Number(row.id)}:${Number(row.quality)||0}`;
          if(!baseBalanceByKey.has(key))baseBalanceByKey.set(key,Math.max(0,Number(row.quantity)||0));
        }
        const plan=store?.frozenNetworkPlan||{};
        const plannerCore=globalThis.SCMPlannerCore;
        const hasCurrentPlanRows=Array.isArray(plan.productionRows)&&Array.isArray(plan.demandRows);
        const surplusByKey=plannerCore?.productionSurplusByKey&&hasCurrentPlanRows
          ?plannerCore.productionSurplusByKey(plan.productionRows,plan.demandRows)
          :new Map((Array.isArray(plan.surpluses)?plan.surpluses:[]).map(row=>[`${Number(row?.id)}:${Number(row?.quality)||0}`,Math.max(0,Number(row?.surplus)||0)]));
        const savedQuantityByContract=plannerCore?.resolveSavedContractQuantities
          ?plannerCore.resolveSavedContractQuantities({savedContracts:saved,baseBalanceByKey,surplusByKey})
          :new Map();
        const helperContracts=saved.map(c=>{
          let productId=Number(c?.productId), quality=Number(c?.quality);
          const keyMatch=String(c?.product||'').match(/^(\d+):(\d+)$/);
          if(keyMatch){productId=Number(keyMatch[1]);if(!Number.isFinite(quality))quality=Number(keyMatch[2]);}
          const productName=String(c?.productName||assets.names.get(String(productId))||c?.product||'').trim();
          const exact=stock.find(x=>Number(x.id)===productId&&Number(x.quality)===quality);
          const byId=stock.filter(x=>Number(x.id)===productId&&Number(x.quality)===quality).reduce((sum,x)=>sum+Number(x.quantity||0),0);
          const key=`${productId}:${Number.isFinite(quality)?quality:0}`;
          const surplus=Math.max(0,Number(surplusByKey.get(key))||0);
          const baseLeft=Math.max(0,Number(baseBalanceByKey.get(key))||0);
          const warehouseAvailable=Math.max(0,Number(exact?.quantity||0)||byId);
          const quantityMode=String(c?.quantityMode||'custom').toLowerCase();
          const resolvedQuantity=savedQuantityByContract.has(c)?Math.max(0,Number(savedQuantityByContract.get(c))||0):null;
          const savedEffectiveQuantity=resolvedQuantity!=null?resolvedQuantity:quantityMode==='surplus'?surplus:quantityMode==='left'?0:Math.max(0,Number(c?.quantity)||0);
          const left=quantityMode==='left'?savedEffectiveQuantity:baseLeft;
          return {...c,productId:Number.isFinite(productId)?productId:null,productName,quality:Number.isFinite(quality)?quality:null,available:surplus,warehouseAvailable,surplus,left,quantityMode,savedEffectiveQuantity};
        });
        const value={ok:true,realm,contracts:helperContracts,incomingContracts:incoming,warehouse:stock};
        contractHelperCache.set(realm,{at:now,value});
        send(value);
      }catch(e){send({ok:false,error:e?.message||String(e)});}
    })(); return true;
  }
  if(m?.type==='SAVE_SAVED_CONTRACT'){
    (async()=>{
      try{
        const realm=validRealmNumber(m.realm); if(realm==null){send({ok:false,error:'No realm.'});return;}
        const result=await withRealmWriteLock(realm,async()=>{
          const s=await state(realm); const key=realmKeyFromRealm(realm); const stores={...(s.realmStores||{})}; const store={...(stores[key]||{})};
          const current=Array.isArray(store.savedContracts)?store.savedContracts.slice():[];
          const mode=String(m.mode||'upsert'); const id=String(m.editId||m.contract?.id||'');
          let next=current;
          if(mode==='delete') next=current.filter(x=>String(x?.id)!==id);
          else {
            const record={...(m.contract||{})}; if(!record.id)record.id=crypto.randomUUID();
            const idx=current.findIndex(x=>String(x?.id)===String(record.id));
            next=idx>=0?current.map((x,i)=>i===idx?record:x):[...current,record];
          }
          const nextStore={...store,savedContracts:next}; stores[key]=nextStore;
          const patch={realmStores:stores}; if(s.activeRealmKey===key)patch.savedContracts=next;
          await storageSet(patch);
          contractHelperCache.delete(realm);
          return {ok:true,realm,savedContracts:next};
        });
        // Persistence acknowledgement is intentionally independent from the heavy
        // overlay refresh. The dashboard must be told the save succeeded as soon as
        // the realm-local storage commit completes; otherwise the Save button can
        // remain on "Saving…" while refreshGameOverlayDataHeavy waits on auth/state
        // work, making a successfully stored contract appear unsaved until a manual
        // Manager refresh. The overlay refresh remains asynchronous and best-effort.
        if(result?.ok===true){
          setTimeout(async()=>{
            try{
              // A refresh may already be in flight using the pre-save contract
              // list. Wait for that build to finish, then run a second build from
              // the committed savedContracts state so the older snapshot cannot
              // win the race and remain visible in the game overlay.
              const inFlight=gameOverlayRefreshPromises.get(realm);
              if(inFlight){try{await inFlight;}catch{}}
              await refreshGameOverlayDataHeavy(realm);
              await notifyGameOverlayRefresh(realm);
            }catch{}
          },0);
        }
        send(result);
      }catch(e){send({ok:false,error:e?.message||String(e)});}
    })(); return true;
  }
  if(m?.type==='GET_REALM_MARKET_PRICE'){
    (async()=>{
      try{
        const s=await state();
        const realm=validRealmNumber(m.realm);
        const resourceId=Number(m.resourceId),quality=Number(m.quality);
        if(realm==null||!Number.isFinite(resourceId)||resourceId<=0||!Number.isFinite(quality)){send({ok:false,price:null,error:'Valid realm, resource and quality required.'});return;}
        const key=realmKeyFromRealm(realm),store=s.realmStores?.[key]||{};
        const rows=Number(store.liveMarketPriceData?.realm)===realm&&Array.isArray(store.liveMarketPriceData?.rows)?store.liveMarketPriceData.rows:[];
        let row=rows.find(x=>Number(x?.resourceId)===resourceId&&Number(x?.quality)===quality);
        if(!row){
          const cache=store.liveMarketProductCache?.[`${resourceId}:${quality}`];
          if(Number(cache?.resourceId)===resourceId&&Number(cache?.quality)===quality&&Number(cache?.selected?.price)>0)row={price:cache.selected.price};
        }
        const price=Number(row?.price);
        send({ok:true,realm,resourceId,quality,price:Number.isFinite(price)&&price>0?price:null,source:row?'captured-market':'unavailable'});
      }catch(e){send({ok:false,price:null,error:e?.message||String(e)});}
    })();return true;
  }
  if(m?.type==='GET_VWAP_OVERLAY_DATA'){
    (async()=>{
      try{
        const s=await state();
        const requestedRealm=validRealmNumber(m.realm);
        const inferredRealm=requestedRealm!=null?requestedRealm:(validRealmNumber(s.selectedRealm)!=null?validRealmNumber(s.selectedRealm):(validRealmNumber(s.authData?.authCompany?.realmId)!=null?validRealmNumber(s.authData?.authCompany?.realmId):(s.activeRealmKey?Number(String(s.activeRealmKey).replace('realm:','')):null)));
        const realm=validRealmNumber(inferredRealm);
        const key=realmKeyFromRealm(realm);
        if(!key){send({ok:false,error:'No game realm available.'});return;}
        const store={...(s.realmStores?.[key]||{})};
        const endpointMap=store.endpointData||{};
        const endpointMarketIds=Object.keys(endpointMap).map(url=>{
          const m=String(url).match(new RegExp('^/api/v3/market/'+realm+'/(\\d+)/?$'));
          return m?{id:Number(m[1]),at:Date.parse(String(endpointMap[url]?.receivedAt||''))||0}:null;
        }).filter(Boolean).sort((a,b)=>b.at-a.at);
        const requestedResourceIdRaw=validRealmNumber(m.resourceId); const requestedResourceId=(requestedResourceIdRaw!=null&&Number(requestedResourceIdRaw)>0)?Number(requestedResourceIdRaw):null; const inferredResourceId=requestedResourceId!=null?requestedResourceId:(endpointMarketIds[0]?.id??null);
        const cachedRows=Array.isArray(store.vwapData?.rows)&&Number(store.vwapData?.sourceRealm)===realm?store.vwapData.rows:[];
        const cachedAt=Date.parse(String(store.vwapData?.fetchedAt||''));
        const fresh=Number.isFinite(cachedAt)&&(Date.now()-cachedAt)<(10*60*1000)&&!store.vwapData?.stale&&!store.vwapData?.fallback;
        let rows=cachedRows,sourceRealm=store.vwapData?.sourceRealm??null,fetchedAt=store.vwapData?.fetchedAt||null;
        let refreshInBackground=false;
        if(!rows.length){
          // Return immediately from the cached snapshot; all network market work
          // is queued through the staged scheduler and never blocks this request.
          refreshInBackground=true;
        }else if(!fresh){refreshInBackground=true;}
        const latestState=s; // v2.5.319: reuse the snapshot already read above (was a second full storage read)
        const latestStore={...(latestState.realmStores?.[key]||{})};
        const eid=Number.isFinite(Number(inferredResourceId))?Number(inferredResourceId):null;
        let marketRows=[];
        if(eid!=null){
          const direct=latestStore.endpointData?.[`/api/v3/market/${realm}/${eid}/`];
          if(Array.isArray(direct?.data))marketRows=direct.data;
        }
        if(!marketRows.length){
          const candidates=Object.entries(latestStore.endpointData||{})
            .map(([url,v])=>{const m=String(url).match(new RegExp('^/api/v3/market/'+realm+'/(\\d+)/?$'));return m?{id:Number(m[1]),data:Array.isArray(v?.data)?v.data:[],at:Date.parse(String(v?.receivedAt||''))||0}:null;})
            .filter(x=>x&&x.data.length>0)
            .sort((a,b)=>b.at-a.at);
          marketRows=candidates.find(x=>eid==null||x.id===eid)?.data||[];
        }
        send({ok:true,rows,marketRows,source:'SimcoTools',sourceRealm,fetchedAt,realm,resourceId:inferredResourceId,refreshing:refreshInBackground});
        if(refreshInBackground){void scheduleMarketCycle(realm,'exchange-cache-miss-or-stale').catch(()=>{});}
      }catch(e){send({ok:false,error:e?.message||String(e)});}
    })(); return true;
  }
  if(m?.type==='CLEAR_EXTENSION_DATA'){
    (async()=>{
      try{
        await chrome.storage.local.clear();
        await chrome.alarms.clearAll();
        const resetDefaults={...DEFAULTS,selectedRealm:null,activeRealmKey:null,vwapStatus:{message:'Waiting for VWAP sync.'},marketQueueStatus:{message:'Waiting for the logged-in Sim Companies tab.',updatedAt:new Date().toISOString()},resourceImageData:{}};
        await storageSet(resetDefaults);
        await chrome.alarms.create('scm-vwap-daily',{periodInMinutes:720});
        await chrome.alarms.create('scm-production-events-daily',{periodInMinutes:720});
        await chrome.alarms.create('scm-production-events-watch',{delayInMinutes:15,periodInMinutes:15});
        await ensureVwapWatchAlarm('clear-extension-data');
        await ensureCriticalDataGuard('clear-extension-data');
        send({ok:true});
      }catch(e){send({ok:false,error:e?.message||String(e)});}
    })();
    return true;
  }
  if(m?.type==='WAIT_FOR_ENDPOINT_CAPTURE'){waitForEndpointCapture(m.target,m.since,m.timeoutMs).then(r=>send(r)).catch(e=>send({ok:false,error:e?.message||String(e)}));return true}
  if(m?.type==='REFRESH_ACCOUNTING') {
    (async()=>{
      try{
        const realm=validRealmNumber(m.realm);
        if(realm==null){send({ok:false,error:'A valid realm is required for Accounting refresh.'});return;}
        const result=await refreshAccountingForRealm(realm,{force:Boolean(m.force),reason:String(m.reason||'dashboard')});
        send(result);
      }catch(e){send({ok:false,realm:validRealmNumber(m.realm),error:e?.message||String(e)});}
    })();
    return true;
  }
  if(m?.type==='REFRESH_ACCOUNTING_WEEK_LEDGER') {
    (async()=>{
      try{
        const realm=validRealmNumber(m.realm);
        if(realm==null){send({ok:false,error:'A valid realm is required for Accounting week ledger refresh.'});return;}
        if(syncSessionForRealm(realm)){send({ok:false,busy:true,realm,error:`${realmDisplayNumber(realm)||'Realm'} Sync is still finalizing.`});return;}
        const result=await runDeferredAccountingWeekRefresh(realm,String(m.reason||'dashboard-overview'));
        send(result);
      }catch(e){send({ok:false,realm:validRealmNumber(m.realm),error:e?.message||String(e)});
      }
    })();
    return true;
  }
  if(m?.type==='REALM_SWITCH'){
    replayEvent('realm-switch-message',{realm:validRealmNumber(m.realm),phase:'request',url:m.url||null,method:m.method||null});
    (async()=>{
      const incoming=validRealmNumber(m.realm);
      if(incoming!=null) await noteRealmSwitch(incoming).catch(()=>{});
      // The request announces intent, but does not activate Manager yet. The
      // game must first return a successful response so a rejected switch
      // cannot move the Manager to the wrong realm.
      send({ok:true,realm:incoming,autoSync:false,manualSelectionRequired:false,autoDetected:false,autoFollow:{ok:true,changed:false,reason:'awaiting-switch-confirmation'}});
    })().catch(e=>send({ok:false,error:e?.message||String(e)}));
    return true;
  }
  if(m?.type==='REALM_SWITCH_CONFIRMED'){
    replayEvent('realm-switch-message',{realm:validRealmNumber(m.realm),phase:'confirmed',url:m.url||null,method:m.method||null,status:Number(m.status)||0});
    (async()=>{
      const incoming=validRealmNumber(m.realm);
      if(incoming==null){send({ok:false,error:'Invalid confirmed realm.'});return;}
      if(currentCaptureSyncSession()){
        // An explicit Manager Sync owns realm activation until it finishes.
        send({ok:true,realm:incoming,changed:false,reason:'sync-session-active'});return;
      }
      await noteRealmSwitch(incoming).catch(()=>{});
      const before=await state();
      const current=validRealmNumber(before.activeRealmKey?.replace(/^realm:/,''));
      let changed=false;
      if(current!==incoming) changed=await activateRealmByRealmFast(incoming,null).catch(()=>false);
      send({ok:true,realm:incoming,changed:Boolean(changed),reason:'switch-confirmed'});
    })().catch(e=>send({ok:false,error:e?.message||String(e)}));
    return true;
  }
  if(m?.type==='NETWORK_CAPTURE_EVENT'){
    enqueueNetworkCaptureWrite(async()=>{
      const event=m.event&&typeof m.event==='object'?m.event:null;
      const incomingCaptureId=String(m.captureId||'');
      if(incomingCaptureId.startsWith('mobile-net-')){
        if(!event){send({ok:false,error:'Missing mobile network capture event.'});return;}
        const saved=(await chrome.storage.local.get('scmNetworkCaptureV3Status')).scmNetworkCaptureV3Status||{};
        if(saved.captureId!==incomingCaptureId||saved.mode!=='mobile-page'){send({ok:false,error:'Ignored stale mobile capture event.',captureId:incomingCaptureId});return;}
        await scmMobileNetSave(incomingCaptureId,event);send({ok:true,captureId:incomingCaptureId,status:saved.status});return;
      }
      if(!event){send({ok:false,error:'Missing network capture event.'});return;}
      const key='scmNetworkTrafficCapture';
      const captureId=String(m.captureId||'');
      const current=await chrome.storage.local.get({[key]:{schemaVersion:1,events:[]}});
      const prior=current[key]&&typeof current[key]==='object'?current[key]:{schemaVersion:1,events:[]};
      // A new start is a new capture session: never silently append stale events.
      const isStart=String(event.kind||'')==='capture-start';
      const sameSession=!isStart&&String(prior.captureId||'')===captureId;
      if(!isStart&&!sameSession){send({ok:false,error:'Ignored network event for a stale or mismatched capture ID.',captureId,status:prior.status||'missing'});return;}
      const events=sameSession&&Array.isArray(prior.events)?prior.events:[];
      const safeEvent={capturedAt:String(event.capturedAt||new Date().toISOString()),realm:validRealmNumber(event.realm),kind:String(event.kind||'network'),url:String(event.url||'').slice(0,2000),method:String(event.method||'').slice(0,12),status:Number.isFinite(Number(event.status))?Number(event.status):null,ok:typeof event.ok==='boolean'?event.ok:null,durationMs:Number.isFinite(Number(event.durationMs))?Number(event.durationMs):null,contentType:String(event.contentType||'').slice(0,160),errorName:String(event.errorName||'').slice(0,120),error:String(event.error||'').slice(0,500),transport:String(event.transport||'').slice(0,20),body:event.body??null,resources:Array.isArray(event.resources)?event.resources.slice(0,300):undefined,pageUrl:String(event.pageUrl||'').slice(0,300),resourceCount:Number.isFinite(Number(event.resourceCount))?Number(event.resourceCount):undefined,eventsCaptured:Number.isFinite(Number(event.eventsCaptured))?Number(event.eventsCaptured):undefined};
      events.push(safeEvent);
      let droppedThisWrite=0;
      let retained=events.slice(-240);
      droppedThisWrite+=Math.max(0,events.length-retained.length);
      while(retained.length>1&&JSON.stringify(retained).length>3500000){retained.shift();droppedThisWrite++;}
      const droppedEventCount=(isStart?0:Number(prior.droppedEventCount)||0)+droppedThisWrite;
      const status=safeEvent.kind==='capture-start'?'recording':safeEvent.kind==='capture-stop'?'stopped':String(prior.status||'recording');
      await chrome.storage.local.set({[key]:{schemaVersion:2,captureId,startedAt:isStart?safeEvent.capturedAt:(prior.startedAt||null),stoppedAt:safeEvent.kind==='capture-stop'?safeEvent.capturedAt:(prior.stoppedAt||null),status,updatedAt:new Date().toISOString(),eventCount:retained.length,droppedEventCount,truncated:droppedEventCount>0,events:retained}});
      send({ok:true,count:retained.length,captureId,status});
    }).catch(e=>send({ok:false,error:e?.message||String(e)}));
    return true;
  }
  if(m?.type==='GAME_CONFIG'){
    // v2.5.341 game config (executive training/settling times) for the admin-overhead calculation. Storage only.
    (async()=>{const c={};for(const k of ['executivesTimeToTrainS','executivesTimeToSettleInS']){const n=Number(m?.config?.[k]);if(Number.isFinite(n)&&n>0)c[k]=n;}
      if(Object.keys(c).length)await rawStorageSet({scmGameConfig:{...c,at:new Date().toISOString()}});send({ok:true});})().catch(e=>send({ok:false,error:String(e?.message||e)}));
    return true;
  }
  if(m?.type==='API_SEEN'){
    const method=String(m.method||'GET').toUpperCase();
    const url=String(m.url||'');
    replayEvent('api-seen',{realm:validRealmNumber(m.captureRealm),url,method});
    const session=currentCaptureSyncSession();
    if(method==='GET'&&session?.phase==='running'){
      // The sync's explicit saveData calls will update the endpoint registry;
      // do not write the whole realm store once before and again after each GET.
      send({ok:true,coveredBySyncCapture:true});
      return true;
    }
    queueEndpointSeen(url,method,m.captureRealm).then(()=>send({ok:true,queued:true}));
    return true;
  }
  if(m?.type==='STOCK_MUTATION_COMPLETE'){
    // v2.5.328: an untagged action belongs to the active realm. (validRealmNumber(null) is 0, which used to
    // refresh R1 while the player was in R2 — rejected as "not the active realm", so nothing updated.)
    (async()=>{let realm=(m.captureRealm===null||m.captureRealm===undefined||m.captureRealm==='')?null:validRealmNumber(m.captureRealm);
      if(realm==null){try{const meta=await chrome.storage.local.get({activeRealmKey:null});realm=validRealmNumber(realmNumberFromKey(meta.activeRealmKey)??meta.activeRealmKey);}catch{}}
      if(realm!=null)scheduleWarehouseRefreshAfterStockMutation(realm,150);})();
    send({ok:true});return true}
  if(m?.type==='GET_ENDPOINT_KEYS'){state().then(s=>send({ok:true,keys:Object.keys(s.endpointData||{})})).catch(e=>send({ok:false,error:e?.message||String(e)}));return true}
  if(m?.type==='WAREHOUSE_COST_DETAIL'){saveWarehouseCostDetail(m).then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='FULL_SYNC_DIAGNOSTIC'){saveFullSyncDiagnostic(m.diagnostic||{},m.diagnostic?.realm).then(d=>send({ok:true,diagnostic:d})).catch(e=>send({ok:false,error:e?.message||String(e)}));return true}
  if(m?.type==='SYNC_PROGRESS'){
    (async()=>{
      const s=await state(); const selected=validRealmNumber(s.selectedRealm); const incoming=validRealmNumber(currentCaptureSyncSession()?.realm);
      if(incoming==null || selected!==incoming){ send({ok:false,error:'Sync progress rejected: realm selection changed.'}); return; }
      const step=Number(m.step)||0,total=Number(m.total)||0,name=String(m.name||'').trim();
      const displayRealm=realmDisplayNumber(incoming)||'Realm';
      let status=`${displayRealm} Sync: ${step}/${total} ${name}`;
      if(m.status==='starting') status=`${displayRealm} Sync: ${step}/${total} ${name}…`;
      else if(m.status==='captured') status=`${displayRealm} Sync: ${step}/${total} ${name} ✓`;
      else if(m.status==='timeout') status=`${displayRealm} Sync: ${step}/${total} ${name} timed out`;
      else if(m.status==='error') status=`${displayRealm} Sync: ${step}/${total} ${name} error`;
      else if(m.status==='complete') status=`${displayRealm} Sync: game pages complete · finishing…`;
      await setRealmLoadStatus(incoming,status,m.error||null);
      send({ok:true});
    })().catch(e=>send({ok:false,error:e?.message||String(e)}));
    return true;
  }
  if(m?.type==='REPLAY_EVENT'){
    const r=validRealmNumber(m.realm);
    replayEvent(String(m.eventType||'page-event'),{realm:r,url:m.url||null,method:m.method||null,status:Number.isFinite(Number(m.status))?Number(m.status):null,transport:m.transport||null,detail:{key:m.key||null,storage:m.storage||null,reason:m.reason||null,captureRealm:validRealmNumber(m.captureRealm)}});
    send({ok:true});
    return true;
  }
  if(m?.type==='GAME_LOCAL_STORAGE_SNAPSHOT'){
    (async()=>{
      try{
        const realm=validRealmNumber(m.realm); if(realm==null){send({ok:false,error:'Invalid game localStorage snapshot realm.'});return;}
        const key=realmKeyFromRealm(realm);
        const sanitize=(snapshot)=>{
          if(!snapshot||typeof snapshot!=='object')return null;
          const entries={}; let total=0;
          const src=snapshot.entries&&typeof snapshot.entries==='object'?snapshot.entries:{};
          const sensitive=/(?:token|auth|cookie|csrf|session|password|secret|jwt|access)/i;
          for(const [k,v] of Object.entries(src)){
            const keyText=String(k||''); const value=String(v??''); const bytes=value.length*2;
            if(sensitive.test(keyText)||bytes>300000||total+bytes>750000)continue;
            entries[keyText]=value; total+=bytes;
          }
          return {schemaVersion:2,realm,capturedAt:String(snapshot.capturedAt||new Date().toISOString()),pageUrl:String(snapshot.pageUrl||''),reason:String(snapshot.reason||'runtime'),allKeys:Array.isArray(snapshot.allKeys)?snapshot.allKeys.map(String).slice(0,500):Object.keys(entries),keyMeta:Array.isArray(snapshot.keyMeta)?snapshot.keyMeta.slice(0,500):[],excludedSensitiveKeys:Array.isArray(snapshot.excludedSensitiveKeys)?snapshot.excludedSensitiveKeys.map(String).slice(0,200):[],capturedBytes:total,entries,parsedEntries:snapshot.parsedEntries&&typeof snapshot.parsedEntries==='object'?snapshot.parsedEntries:{},safeCapture:true};
        };
        const value=sanitize(m); if(!value){send({ok:false,error:'Invalid game localStorage snapshot.'});return;}
        replayEvent('game-store-snapshot',{realm,reason:value.reason,keyCount:value.allKeys.length,capturedKeyCount:Object.keys(value.entries).length,capturedBytes:value.capturedBytes,excludedSensitiveKeyCount:value.excludedSensitiveKeys.length,entriesHash:replayHash(value.entries)});
        await withRealmWriteLock(realm,async()=>{
          const latest=await state(realm); const stores={...(latest.realmStores||{})}; const store={...(stores[key]||{})};
          store.gameLocalStorageSnapshot=value; stores[key]=store;
          const patch={realmStores:stores}; if(latest.activeRealmKey===key)patch.gameLocalStorageSnapshot=value;
          await storageSet(patch);
        });
        send({ok:true,realm,capturedAt:value.capturedAt,keys:value.allKeys.length,capturedBytes:value.capturedBytes});
      }catch(e){send({ok:false,error:e?.message||String(e)});}
    })();
    return true;
  }
  if(m?.type==='GAME_STATE'){
    (async()=>{
      // GAME_STATE is realm-local data, not an authoritative session switch.
      // Saving it under its explicit realm keeps the stores correct without
      // allowing delayed snapshots from the previous realm to flip the Manager
      // back during a live R1/R2 transition.
      const result=await saveGameState(m);
      send({...result,autoDetected:false,autoFollow:{ok:true,changed:false,reason:'game-state-isolation'}});
    })().catch(e=>send({ok:false,error:e?.message||String(e)}));
    return true;
  }
  if(m?.type==='PRODUCTION_EVENTS'){saveProductionEvents(m).then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='CAPTURE_PRODUCTION_RATE_SNAPSHOT'){saveProductionRateSnapshot(m).then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='SCM_TEST_DAILY_SUMMARY'){fireDailySummary().then(()=>send({ok:true})).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='SCM_TEST_NOTIFICATION'){scmNotify(`test-${Date.now()}`,'Sim Companies Manager','Test notification — if you can read this, alerts work on this phone.').then(send);return true;}
  if(m?.type==='SCM_NOTIFY_SETTINGS'){(async()=>{try{if(m.set&&typeof m.set==='object'){const cur=await notifySettings();await rawStorageSet({[NOTIFY_SETTINGS_KEY]:{...cur,...m.set}});await scheduleDailySummary();for(const n of [0,1]){const st=(await chrome.storage.local.get({[`scmRealmStore:${n}`]:null}))[`scmRealmStore:${n}`];if(st)await scheduleProductionFinishAlarms(n,st.buildings);}}const prodfin=(await chrome.alarms.getAll()).filter(x=>String(x.name).startsWith('scm-prodfin:'));const nameStores={};for(const a of prodfin){const r=String(a.name).split(':')[1];if(!(r in nameStores))nameStores[r]=(await chrome.storage.local.get({[`scmRealmStore:${r}`]:null}))[`scmRealmStore:${r}`]||{};}
// v2.5.345 building names for the Alerts "Next" line (the dashboard rendered it before its own state had loaded).
const alarms=prodfin.map(x=>{const [,r,bid]=String(x.name).split(':');const b=(Array.isArray(nameStores[r]?.buildings)?nameStores[r].buildings:[]).find(y=>String(y?.id)===bid);return {name:x.name,when:x.scheduledTime,buildingName:b?.name?String(b.name):null};});const daily=await chrome.alarms.get('scm-daily-summary');send({ok:true,settings:await notifySettings(),available:!!chrome.notifications?.create,alarms,dailyAt:daily?.scheduledTime||null});}catch(e){send({ok:false,error:e?.message||String(e)});}})();return true;}
  if(m?.type==='FETCH_EXCHANGE_ORDER_BOOK'){fetchExchangeOrderBookForRealm(m.realm,m.resourceId).then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='FETCH_BUILDING_HISTORY'){fetchBuildingHistoryForRealm(m.realm,m.buildingId).then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='SAVE_PRODUCTION_PLANNER_STATE'){
    (async()=>{
      try{
        const realm=validRealmNumber(m.realm);
        const key=productionPlannerStateStorageKey(realm);
        const value=sanitizeProductionPlannerState(m.value,realm);
        if(realm==null||!key||!value){send({ok:false,error:'Invalid production planner state.'});return;}
        await rawStorageSet({[key]:value});
        send({ok:true,realm,value});
      }catch(e){send({ok:false,error:e?.message||String(e)});}
    })(); return true;
  }
  if(m?.type==='SAVE_FROZEN_NETWORK_PLAN'){saveFrozenNetworkPlanSnapshot(m).then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='ENSURE_FROZEN_PRODUCTION_RATES'){ensureFrozenProductionRatesForRealm(m.realm).then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='API_DATA'){
    (async()=>{
      const url=String(m.url||'');
      const session=currentCaptureSyncSession();
      if(!shouldPersistPassiveApiCaptureDuringSync(session,url,m.method||'GET')){
        replayEvent('sync-passive-api-capture-skipped',{realm:validRealmNumber(m.captureRealm),url,method:String(m.method||'GET').toUpperCase(),targetPaths:session?.capturePaths?.length||0});
        send({ok:true,skipped:true,reason:'outside-current-sync-target-paths'});
        return;
      }
      await saveData(url,m.data,m.status,m.method||'GET',m.captureRealm);
      if(/\/api\/v3\/companies\/auth-data\//.test(url)){
        const responseRealm=validRealmNumber(m.data?.authCompany?.realmId??m.data?.authCompany?.realm??m.data?.realmId??m.data?.realm);
        const captureRealm=validRealmNumber(m.captureRealm);
        const confirmedRealm=responseRealm??captureRealm;
        const meta=await chrome.storage.local.get({realmSwitchHint:null});
        const hintAt=Number(meta.realmSwitchHint?.at);
        const hintRealm=validRealmNumber(meta.realmSwitchHint?.realm);
        const hintFresh=hintRealm!=null && Number.isFinite(hintAt) && Date.now()-hintAt<15000;
        // During a live switch, an older auth-data response can arrive after
        // the new realm's switch request. The switch hint is a short-lived
        // ordering guard: only the auth-data response matching the requested
        // realm may promote the Manager's active view during that window.
        const captureMatchesHint=!hintFresh || (hintRealm===captureRealm && hintRealm===confirmedRealm);
        const confirmedForActivation=!hintFresh || (hintRealm===confirmedRealm && captureMatchesHint);
        if(confirmedRealm!=null && confirmedForActivation && !currentCaptureSyncSession()){
          // During the switch barrier, only auth-data whose request itself was
          // captured from the newly requested realm may activate it. A late
          // response from the old request can contain a valid old realm and
          // otherwise win the transition race.
          await activateRealmByRealmFast(confirmedRealm,m.data).catch(()=>{});
        }
      }
      send({ok:true});
    })().catch(e=>send({ok:false,error:e?.message||String(e)}));
    return true;
  }
  if(m?.type==='RESOURCE_CATALOG'){saveResourceCatalog(m.catalog,m.receivedAt).then(()=>send({ok:true}));return true}
  if(m?.type==='RESOURCE_IMAGE_RESULT'){(async()=>{
    if(m.resource&&m.dataUrl){
      const s=await state(); const realm=realmNumberFromKey(s.activeRealmKey||identityFromAuth(s.authData));
      if(realm!=null) await withRealmWriteLock(realm,async()=>{
        const latest=await state(realm); const key=realmKeyFromRealm(realm); const stores={...(latest.realmStores||{})}; const store={...(stores[key]||{})};
        const map={...(store.resourceImageCache||{})}; map[String(Number(m.resource))]=m.dataUrl; store.resourceImageCache=map; stores[key]=store;
        const patch={realmStores:stores}; if(key===latest.activeRealmKey) patch.resourceImageCache=map; await storageSet(patch);
      });
    }
    send({ok:true});
  })().catch(e=>send({ok:false,error:e?.message||String(e)}));return true}
  if(m?.type==='GET_RESOURCE_IMAGE'){(async()=>{const r=await fetchAndCacheResourceImage(Number(m.resource),{forceValidate:false}); if(r.ok){send({ok:true,dataUrl:r.dataUrl,cached:r.cached,stale:r.stale||false});return;} const tab=await simTab(); if(!tab?.id){send({ok:false,error:r.error||'Sim Companies tab is not open.'});return;} try{await chrome.tabs.sendMessage(tab.id,{type:'PAGE_RESOURCE_IMAGE',resource:Number(m.resource)}); send({ok:true,queued:true,error:r.error||null});}catch(e){send({ok:false,error:e?.message||String(e)});}})();return true}
  if(m?.type==='SYNC_RESOURCE_IMAGES'){syncAllResourceImages({forceValidate:Boolean(m.forceValidate)}).then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true}
  if(m?.type==='MARKET_CACHE'){saveMarketCache(m.resource,m.data,m.receivedAt,m.realm).then(()=>send({ok:true}));return true}
  if(m?.type==='SYNC_NOW'){syncNow(m.realm).then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true}
  if(m?.type==='SET_VIEW_REALM'){
    (async()=>{
      // Selection is a user preference only. It does not read or clone the
      // other realm's data. Activation happens only after the game identity is
      // verified or an explicit realm activation is requested.
      const value=m.realm==null||m.realm===''?null:Number(m.realm);
      if(value!==null&&(!Number.isFinite(value)||(!realmDefinition(value)))){send({ok:false,error:'Select R1 - Magnates or R2 - Entrepreneurs.'});return;}
      await ensureRealmStorageMigration();
      await storageSet({selectedRealm:value});
      send({ok:true,selectedRealm:value});
    })().catch(e=>send({ok:false,error:e?.message||String(e)})); return true;
  }
  if(m?.type==='PUSH_LIVE_BRIDGE'){
    pushLiveBridge(m.realm,Boolean(m.force)).then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;
  }
  if(m?.type==='SET_LIVE_BRIDGE'){
    (async()=>{try{
      const current=await chrome.storage.local.get({liveBridge:DEFAULTS.liveBridge});
      const next={...(current.liveBridge||{}),enabled:Boolean(m.enabled),url:String(m.url||'').trim(),token:String(m.token||''),pushOnSync:Boolean(m.pushOnSync)};
      if(next.url && !/^https:\/\//i.test(next.url)) throw new Error('Live bridge URL must use HTTPS.');
      await storageSet({liveBridge:next});
      send({ok:true,liveBridge:next});
    }catch(e){send({ok:false,error:e?.message||String(e)});}})();return true;
  }
  if(m?.type==='GET_STATE'){
    Promise.resolve().then(async()=>{
      await ensureRealmStorageMigration();
      const s=await state();
      const active=validRealmNumber(s.activeRealmKey?.replace(/^realm:/,''));
      const activeKey=active!=null?realmKeyFromRealm(active):null;
      const store=activeKey?(s.realmStores||{})[activeKey]||{}:{};
      return {...s,realmStores:activeKey?{[activeKey]:store}:{},activeRealmKey:activeKey,selectedRealm:s.selectedRealm!=null?Number(s.selectedRealm):null,viewRealm:active,captureRealm:active,apiBase:s.apiBase,syncMinutes:s.syncMinutes};
    }).then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;
  }
});

ensureRealmStorageMigration().catch(()=>{});

// v2.5.327: one-time (idempotent) move of resource images out of the realm stores.
moveResourceImagesOutOfRealmStores().catch(e=>console.debug('resource image move skipped',e));
// v2.5.327: stored overlay snapshots no longer carry base64 images (~450 KB -> ~12 KB per realm).
(async()=>{for(const r of [0,1]){try{const k=gameOverlaySnapshotStorageKey(r);const v=(await chrome.storage.local.get({[k]:null}))[k];if(!v)continue;const s=await stripOverlayEmbeddedImages(v);if(s!==v)await rawStorageSet({[k]:s});}catch(e){console.debug('overlay snapshot cleanup skipped',e);}}})();
