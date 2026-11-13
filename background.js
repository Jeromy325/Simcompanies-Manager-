import './diagnostic-core.js';
import './planner-core.js';
import './tools-core.js';
import './market-core.js';
import './notify-core.js';
import './analyze-core.js';
import './self-test-core.js';
import './storage-core.js';
import './timers-core.js';
import {
  REALM_DEFINITIONS, validRealmNumber, realmDefinition, realmKeyFromRealm, realmStorageKey,
  realmDisplayNumber, realmDisplayName, realmContractPaths
} from './realm-core.js';
// Local error ring buffer (last 200 errors) for diagnostics; writes are debounced.
const SCM_ERROR_LOG_KEY='scmErrorLog';
const SCM_ERROR_LOG_MAX=200;
var scmErrorLogBuffer=null,scmErrorLogTimer=null,scmErrorLogLoading=null;
function scmErrorLogLoad(){if(scmErrorLogBuffer)return Promise.resolve(scmErrorLogBuffer);if(!scmErrorLogLoading)scmErrorLogLoading=chrome.storage.local.get({[SCM_ERROR_LOG_KEY]:[]}).then(r=>{const saved=Array.isArray(r?.[SCM_ERROR_LOG_KEY])?r[SCM_ERROR_LOG_KEY]:[];scmErrorLogBuffer=[...saved,...(scmErrorLogBuffer||[])].slice(-SCM_ERROR_LOG_MAX);return scmErrorLogBuffer;}).catch(()=>{scmErrorLogBuffer=scmErrorLogBuffer||[];return scmErrorLogBuffer;});return scmErrorLogLoading;}
function logError(context,err){try{
  const entry={at:new Date().toISOString(),context:String(context||'unknown').slice(0,120),message:String(err?.message??err??'').slice(0,1000),stack:err?.stack?String(err.stack).slice(0,2000):null,version:chrome.runtime.getManifest?.().version||null};
  scmErrorLogLoad().then(buf=>{buf.push(entry);if(buf.length>SCM_ERROR_LOG_MAX)buf.splice(0,buf.length-SCM_ERROR_LOG_MAX);if(scmErrorLogTimer)return;scmErrorLogTimer=setTimeout(()=>{scmErrorLogTimer=null;chrome.storage.local.set({[SCM_ERROR_LOG_KEY]:scmErrorLogBuffer.slice(-SCM_ERROR_LOG_MAX)}).catch(()=>{});},2000);});
}catch{}}
async function getErrorLog(){if(scmErrorLogTimer){clearTimeout(scmErrorLogTimer);scmErrorLogTimer=null;}const buf=await scmErrorLogLoad();await chrome.storage.local.set({[SCM_ERROR_LOG_KEY]:buf.slice(-SCM_ERROR_LOG_MAX)}).catch(()=>{});return buf.slice();}
self.addEventListener('error',e=>logError('uncaught',e?.error||e?.message||e));
// Alarms: ask for persistAcrossSessions explicitly where the browser's schema accepts it. Older/other Chromium
// builds reject unknown keys with a TypeError, so the first rejection is remembered and later calls omit it.
let scmAlarmPersistSupported=null;
async function scmAlarmCreate(name,info){
  if(scmAlarmPersistSupported!==false){
    try{const r=await chrome.alarms.create(name,{...(info||{}),persistAcrossSessions:true});scmAlarmPersistSupported=true;return r;}
    catch(e){if(scmAlarmPersistSupported===true)throw e;scmAlarmPersistSupported=false;}
  }
  return chrome.alarms.create(name,info);
}
// Background sync timers (Settings): scmSyncTimers, table and rules in timers-core.js. Read once per worker and kept
// in memory; only SCM_SET_TIMERS writes it (serialized), and Clear Stored Data drops the memo (no storage.onChanged).
// With nothing stored every alarm keeps the exact info it had before (legacy info passed by each caller).
// scmTimersMemoGen: bumped by every writer of the memo (fresh install, SCM_SET_TIMERS, Clear data). A storage read that
// started before such a write must not put its older answer into the memo (fresh install: a startup read of the empty
// key finishing after scmApplyFreshInstallTimers turned the timers back on and the alarms were created).
let scmTimersMemo=null,scmTimersWriteTail=Promise.resolve(),scmTimersMemoGen=0;
async function scmTimersConfig(){
  const C=globalThis.SCM_TIMERS_CORE;if(!C)return null;
  if(scmTimersMemo)return scmTimersMemo;
  try{
    const gen=scmTimersMemoGen;
    const got=await chrome.storage.local.get({[C.KEY]:null,scmTimersMigrations:{}});
    // A writer ran during the read: its value wins (the read may be from before it).
    if(gen!==scmTimersMemoGen)return scmTimersMemo||scmTimersConfig();
    if(scmTimersMemo)return scmTimersMemo;
    const raw=got[C.KEY];scmTimersMemo=C.normalize(raw);
    // One-time move (2.5.456): the SimcoTools timer floor went from 60 to 5 min. A stored 60 was the old default and
    // floor, so it becomes the new default 5; a value the player sets later is kept. Written in the timers write lane.
    // One-time move (2.5.457): the game order-book timer floor went from 1 to 5 min (the game's API guide allows one
    // request every 5 min, shared by every background job). A stored every:1..4 is already read as 5 (clamp to the new
    // floor); the migration writes that back once so the stored value matches, and the alarm is re-created at 5 min by
    // ensureOrderBookRefreshAlarm ('period' mode).
    const mig=got.scmTimersMigrations&&typeof got.scmTimersMigrations==='object'?got.scmTimersMigrations:{};
    if(raw&&(!mig.liveMarket5||!mig.orderBook5)){
      const cfg=scmTimersMemo;if(!mig.liveMarket5&&Number(raw?.timers?.liveMarket?.every)===60)cfg.liveMarket={...cfg.liveMarket,every:5};
      scmTimersWriteTail=scmTimersWriteTail.then(()=>chrome.storage.local.set({[C.KEY]:(o=>{delete o.timers.accountingWalk;return o;})(C.toStored(cfg)),scmTimersMigrations:{...mig,liveMarket5:true,orderBook5:true}})).catch(()=>{});
    }
  }catch{return C.defaults();}
  return scmTimersMemo;
}
async function scmTimerEntry(id){const cfg=await scmTimersConfig();return cfg?.[id]||null;}
async function scmTimerEnabled(id){const e=await scmTimerEntry(id);return e?e.enabled!==false:true;}
// A job whose Background timers switch is off makes no request; it writes one "not read" line (switchedOff), at most
// once per 30 min per realm + job (activityRepeatCheck). Returns true when the job must not run.
const SCM_SWITCHED_OFF_TEXT='Not read: switched off (Background timers)';
async function scmSwitchedOff(id,job,realm=null,trigger='manager'){
  if(await scmTimerEnabled(id).catch(()=>true))return false;
  let n=validRealmNumber(realm);if(n==null)n=await activeRealmNumber().catch(()=>null);
  if(n!=null)logActivity(n,job,'not-read',{switchedOff:true,timer:id},SCM_SWITCHED_OFF_TEXT,Date.now(),trigger);
  return true;
}
// Fresh install (onInstalled reason 'install'): every timer that contacts a server is written off
// (SCM_TIMERS_CORE.freshInstall); an update keeps what is stored. Through the timers write lane.
async function scmApplyFreshInstallTimers(){
  const C=globalThis.SCM_TIMERS_CORE;if(!C?.freshInstall)return null;
  const cfg=C.freshInstall();const stored=C.toStored(cfg);delete stored.timers.accountingWalk;
  scmTimersMemoGen++;scmTimersMemo=C.normalize(stored);
  scmTimersWriteTail=scmTimersWriteTail.then(()=>chrome.storage.local.set({[C.KEY]:stored,scmTimersMigrations:{liveMarket5:true,orderBook5:true,freshInstallOff:true}})).catch(()=>{});
  await scmTimersWriteTail;
  return stored;
}
// Alarm info for a timer: null when off; the caller's legacy info while the setting is at its default.
async function scmTimerAlarmInfo(id,legacy){
  const C=globalThis.SCM_TIMERS_CORE,t=C?.byId?.[id],e=await scmTimerEntry(id);
  if(!t||!e)return legacy;
  if(!e.enabled)return null;
  if(t.kind==='interval'){if(e.every===t.default)return legacy;const p=C.intervalMinutes(id,e);return {delayInMinutes:p,periodInMinutes:p};}
  if(e.at){const when=C.nextDailyAt(e.at);if(when)return {when,periodInMinutes:1440};}
  return legacy;
}
// mode 'missing': create only when absent; 'period': also when its period differs; 'always': re-create.
// A timer that is off has its alarm cleared and is never re-created here.
async function scmEnsureTimerAlarm(id,legacy,mode='missing'){
  const name=globalThis.SCM_TIMERS_CORE?.byId?.[id]?.alarmName;if(!name)return false;
  const info=await scmTimerAlarmInfo(id,legacy);
  if(!info){await chrome.alarms.clear(name).catch(()=>{});return false;}
  if(mode!=='always'){const cur=await chrome.alarms.get(name);if(cur&&(mode==='missing'||Number(cur.periodInMinutes)===Number(info.periodInMinutes)))return false;}
  await scmAlarmCreate(name,info);return true;
}
self.addEventListener('unhandledrejection',e=>logError('unhandledrejection',e?.reason));
// The service worker does not listen to chrome.storage.onChanged: every listener receives a full copy of each changed
// value. The three memos (images, game constants, overlay snapshots) are only written by this worker, so its own
// writes clear them.
const __scmOwnWriteHooks=globalThis.__scmOwnWriteHooks=[];
{const __orig=chrome.storage.local.set.bind(chrome.storage.local);chrome.storage.local.set=(items,...rest)=>{if(items&&typeof items==='object')for(const h of __scmOwnWriteHooks){try{h(items);}catch{}}return __orig(items,...rest);};}
// Chrome clamps one-shot alarms to >=30 s. scmCreateShortAlarm keeps the alarm as an eviction-safe fallback and,
// while the worker is alive, fires it on time via setTimeout (clearing the alarm first so it never runs twice).
const scmAlarmListeners=[];
{const __origAdd=chrome.alarms.onAlarm.addListener.bind(chrome.alarms.onAlarm);chrome.alarms.onAlarm.addListener=fn=>{scmAlarmListeners.push(fn);return __origAdd(fn);};}
async function scmCreateShortAlarm(name,delayMs){
  const when=Date.now()+Math.max(0,Number(delayMs)||0);
  await scmAlarmCreate(name,{when});
  if(delayMs<30000)setTimeout(async()=>{try{const a=await chrome.alarms.get(name);if(!a||Math.abs(Number(a.when)-when)>5)return;if(!(await chrome.alarms.clear(name)))return;for(const fn of scmAlarmListeners){try{Promise.resolve(fn({name,scheduledTime:when})).catch(e=>logError(`alarm:${name}`,e));}catch(e){logError(`alarm:${name}`,e);}}}catch(e){logError('short-alarm',e);}},Math.max(0,delayMs));
}
const realmSyncSessions=new Map();
let syncCaptureRealm=null;
// Sync priority: while a core Sync runs (setup, targets and the post-sync tail), optional background work
// (VWAP stages, warehouse/overlay refreshes, endpoint-seen flushes) waits instead of competing for the storage lane,
// and resumes once Sync ends.
const syncDeferredWork=new Map();
// Eviction visibility: running Sync sessions are mirrored to chrome.storage.session. A Sync cannot resume after the
// worker is evicted, so on wake leftover markers are logged as interrupted and cleared (never re-hydrated as live).
const SCM_SYNC_SESSION_KEY='scmActiveSyncSessionsV1';
function scmMirrorSyncSessions(){try{if(!chrome.storage?.session)return;const out={};for(const [n,v] of realmSyncSessions.entries())out[n]={realm:n,startedAt:v?.startedAt??null,capture:syncCaptureRealm===n};(Object.keys(out).length?chrome.storage.session.set({[SCM_SYNC_SESSION_KEY]:out}):chrome.storage.session.remove(SCM_SYNC_SESSION_KEY)).catch(()=>{});}catch{}}
async function scmCheckInterruptedSyncSessions(){try{if(!chrome.storage?.session)return;const saved=(await chrome.storage.session.get(SCM_SYNC_SESSION_KEY))?.[SCM_SYNC_SESSION_KEY];if(!saved||!Object.keys(saved).length||realmSyncSessions.size)return;for(const v of Object.values(saved))logError('sync-interrupted',new Error(`Sync for realm ${v?.realm} started ${v?.startedAt} was interrupted by service-worker shutdown.`));await chrome.storage.session.remove(SCM_SYNC_SESSION_KEY);}catch(e){logError('sync-session-check',e);}}
function coreSyncActive(){return realmSyncSessions.size>0;}
function deferUntilSyncEnds(key,fn){syncDeferredWork.set(String(key),fn);}
function resumeSyncDeferredWork(){
  if(coreSyncActive())return 0;
  const jobs=[...syncDeferredWork.values()];syncDeferredWork.clear();
  for(const fn of jobs){try{Promise.resolve(fn()).catch(()=>{});}catch{}}
  return jobs.length;
}
// A failed Sync retries itself once, a minute later, so the user does not have to notice and re-sync.
const SYNC_AUTO_RETRY_ALARM_PREFIX='scm-sync-retry-r';
const SYNC_AUTO_RETRY_DELAY_MS=60000;
const syncAutoRetryRuns=new Set();
// No answer from the game (HTTP 0), a timeout, or the page bridge not ready yet: worth the one automatic retry.
function syncFailureIsTransient(error){return /\(HTTP 0\)|HTTP 0\b|timed out|time-?out|bridge is not (?:ready|connected)|message channel closed/i.test(String(error||''));}
// The game pushed back (HTTP 401 / 403 / 429 / 503 named in the failure, such an answer to a Manager read during this
// run): a retry a minute later would only hit it again, so none is scheduled.
// Returns the plain-English reason, or null when the retry may run.
function syncAutoRetrySkipReason({error=null,blocked=false,backoff=null,startedAt=0}={}){
  const m=String(error||'').match(/HTTP (401|403|429|503)\b/);
  if(m)return `the Sync failure includes HTTP ${m[1]}`;
  if(backoff&&Number(backoff.at)>=(Number(startedAt)||0)&&Number(backoff.status))return `the game answered HTTP ${Number(backoff.status)} during this Sync`;
  return null;
}
let extensionClearGeneration=0; // bumped by Clear Stored Data; work started before it must not write afterwards
class SyncCancelledByClear extends Error{constructor(){super('Stored data was cleared; Sync stopped.');}}
const realmWriteQueues=new Map();
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
const SCM_NET_BODY_CAP=256*1024;
const SCM_NET_SECRET_PATH_RE=/auth|login|logout|token|session|password|passwd|signin|signup|register|oauth|csrf|2fa|otp/i;
const SCM_NET_SECRET_BODY_RE=/"(?:password|passwd|token|access_?token|refresh_?token|id_?token|session(?:id|_id)?|csrf(?:token)?|secret|api_?key|authorization|jwt)"\s*:|(?:^|[?&])(?:password|token|secret|csrf[a-z_]*|session[a-z_]*)=/i;
function scmNetRedactBody(url,body,skipContentScan){if(body==null)return {body:null,status:null};const str=String(body);let path='';try{path=new URL(String(url||'')).pathname;}catch{path=String(url||'');}if(SCM_NET_SECRET_PATH_RE.test(path)||(!skipContentScan&&SCM_NET_SECRET_BODY_RE.test(str.slice(0,SCM_NET_BODY_CAP))))return {body:'[REDACTED]',status:'redacted'};if(str.length>SCM_NET_BODY_CAP)return {body:str.slice(0,SCM_NET_BODY_CAP),status:'truncated'};return {body:str,status:null};}
async function scmNetPageEvents(captureId,offset,limit){const db=await scmNetDb();return await new Promise((resolve,reject)=>{const tx=db.transaction('events','readonly');const req=tx.objectStore('events').index('captureId').openCursor(IDBKeyRange.only(captureId));const events=[];const summary={eventCount:0,requests:0,responses:0,bodies:0,bodyUnavailable:0,errors:0};let i=0;req.onsuccess=()=>{const c=req.result;if(!c){resolve({events,total:i,summary});return;}const e=c.value||{};if(i>=offset&&events.length<limit)events.push(e);i++;summary.eventCount++;if(e.kind==='request'||e.kind==='request-start')summary.requests++;if(e.kind==='response'||e.kind==='fetch'||e.kind==='xhr')summary.responses++;if(e.kind==='response-body'||((e.kind==='fetch'||e.kind==='xhr')&&e.body!=null))summary.bodies++;if(e.kind==='body-unavailable')summary.bodyUnavailable++;if(e.kind==='capture-error'||e.kind==='loading-failed'||e.kind==='request-error')summary.errors++;c.continue();};req.onerror=()=>reject(req.error||new Error('IndexedDB read failed'));});}
async function scmNetClearAllEvents(){const db=await scmNetDb();await new Promise((resolve,reject)=>{const tx=db.transaction('events','readwrite');tx.objectStore('events').clear();tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error||new Error('IndexedDB clear failed'));});}
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
// A SimcoTools executive search: the URL holds the name the user typed and the answer is a list of people's names.
function scmIsPrivateSimcoUrl(raw){try{const u=new URL(String(raw));return u.hostname==='api.simcotools.com'&&/\/executives\/?$/i.test(u.pathname);}catch{return /api\.simcotools\.com\/[^?#]*\/executives\/?(?:[?#]|$)/i.test(String(raw||''));}}
function scmMobileNetSafeUrl(raw){try{const u=new URL(String(raw));const priv=scmIsPrivateSimcoUrl(raw);for(const k of [...u.searchParams.keys()])if(/token|auth|cookie|csrf|session|password|secret|jwt|access|key/i.test(k)||(priv&&/^name$/i.test(k)))u.searchParams.set(k,'[redacted]');return u.origin+u.pathname+u.search;}catch{return String(raw||'').split('?')[0].slice(0,2000);}}
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
 if(method==='Network.requestWillBeSent'){const req=params.request||{};const row={requestId:id,url:req.url||'',method:req.method||'GET',headers:scmNetSafeHeaders(Object.entries(req.headers||{}).map(([name,value])=>({name,value:String(value)}))),postData:req.postData==null?null:scmNetRedactBody(req.url,req.postData).body,resourceType:params.type||null,initiator:params.initiator||null,wallTime:params.wallTime||null,timestamp:params.timestamp||null,redirectResponse:params.redirectResponse?{status:params.redirectResponse.status,url:params.redirectResponse.url,headers:scmNetSafeHeaders(Object.entries(params.redirectResponse.headers||{}).map(([name,value])=>({name,value:String(value)})))}:null};scmNetCapture.requestMap.set(id,{request:row,response:null});await scmNetSave({kind:'request',...row});if(params.redirectResponse)await scmNetSave({kind:'redirect-response',requestId:id,url:params.redirectResponse.url,status:params.redirectResponse.status,headers:scmNetSafeHeaders(Object.entries(params.redirectResponse.headers||{}).map(([name,value])=>({name,value:String(value)})))});return;}
 if(method==='Network.responseReceived'){const resp=params.response||{};const entry=scmNetCapture.requestMap.get(id)||{request:{requestId:id,url:resp.url||'',method:'GET'},response:null};entry.response={url:resp.url||entry.request.url,status:resp.status,statusText:resp.statusText,mimeType:resp.mimeType,protocol:resp.protocol,fromDiskCache:resp.fromDiskCache,fromServiceWorker:resp.fromServiceWorker,headers:scmNetSafeHeaders(Object.entries(resp.headers||{}).map(([name,value])=>({name,value:String(value)}))),remoteIPAddress:resp.remoteIPAddress||null,encodedDataLength:resp.encodedDataLength??null,resourceType:params.type||null};scmNetCapture.requestMap.set(id,entry);await scmNetSave({kind:'response',requestId:id,...entry.response});return;}
 if(method==='Network.loadingFinished'){const entry=scmNetCapture.requestMap.get(id);await scmNetSave({kind:'loading-finished',requestId:id,encodedDataLength:params.encodedDataLength??null});if(entry){try{const result=await chrome.debugger.sendCommand(source,'Network.getResponseBody',{requestId:id});const rawBody=result?.body;const bodyUrl=entry.response?.url||entry.request?.url||'';const red=scmNetRedactBody(bodyUrl,rawBody,Boolean(result?.base64Encoded));const body=red.body;await scmNetSave({kind:'response-body',requestId:id,url:bodyUrl,base64Encoded:Boolean(result?.base64Encoded),body:body??null,bodyLength:typeof rawBody==='string'?rawBody.length:0,bodyCaptureStatus:rawBody==null?'empty':(red.status||'captured')});}catch(err){await scmNetSave({kind:'body-unavailable',requestId:id,url:entry.response?.url||entry.request?.url||'',reason:String(err?.message||err).slice(0,500)});}}scmNetCapture.requestMap.delete(id);return;}
 if(method==='Network.loadingFailed'){await scmNetSave({kind:'loading-failed',requestId:id,url:scmNetCapture.requestMap.get(id)?.request?.url||'',errorText:params.errorText||'',canceled:Boolean(params.canceled),blockedReason:params.blockedReason||null});scmNetCapture.requestMap.delete(id);return;}
 if(method.startsWith('Network.webSocket')||method.startsWith('Network.eventSource')){const clean={...params};if(clean.request)clean.request={url:clean.request.url,method:clean.request.method,headers:scmNetSafeHeaders(Object.entries(clean.request.headers||{}).map(([name,value])=>({name,value:String(value)})))};await scmNetSave({kind:'protocol-event',protocolMethod:method,params:clean});return;}
 if(method==='Network.dataReceived'){await scmNetSave({kind:'data-received',requestId:id,dataLength:params.dataLength??null,encodedDataLength:params.encodedDataLength??null});return;}
 if(method==='Network.requestServedFromCache'){await scmNetSave({kind:'served-from-cache',requestId:id});return;}
 }catch(err){try{await scmNetSave({kind:'capture-error',protocolMethod:method,error:String(err?.message||err).slice(0,500)});}catch{}}
}
// Debugger capture state lives in storage.session so a restarted service worker can
// detach a debugger session it no longer tracks (in-memory requestMap is lost on restart).
const SCM_NET_SESSION_KEY='scmNetCaptureSessionState';
async function scmNetPersistSession(){try{await chrome.storage.session?.set({[SCM_NET_SESSION_KEY]:{tabId:scmNetCapture.tabId,captureId:scmNetCapture.captureId,active:scmNetCapture.active,startedAt:scmNetCapture.startedAt}});}catch{}}
async function scmNetRecoverStaleSession(){try{if(!chrome.storage.session)return;const st=(await chrome.storage.session.get(SCM_NET_SESSION_KEY))[SCM_NET_SESSION_KEY];if(!st?.active||scmNetCapture.active)return;try{if(st.tabId!=null&&chrome.debugger?.detach)await chrome.debugger.detach({tabId:st.tabId});}catch{}await chrome.storage.session.set({[SCM_NET_SESSION_KEY]:{...st,active:false}});const cur=(await chrome.storage.local.get('scmNetworkCaptureV3Status')).scmNetworkCaptureV3Status||{};if(cur.captureId===st.captureId&&cur.status==='recording'&&cur.mode!=='mobile-page')await chrome.storage.local.set({scmNetworkCaptureV3Status:{...cur,status:'stopped',stopReason:'service-worker-restart',stoppedAt:new Date().toISOString()}});}catch{}}
const scmNetRecoveryPromise=scmNetRecoverStaleSession();
// debugger is an optional permission (some Android browsers remove extensions that require it), so bind only once it exists.
// Chrome 157 with "debugger" granted but not active throws on chrome.debugger / .onEvent (the worker died at load):
// every touch is wrapped, and the listeners bind only after chrome.permissions.contains says granted (async, never at
// load). A throw leaves it unbound and logs one error line.
let scmNetDebuggerBound=false,scmNetDebuggerDetachBound=false,scmNetDebuggerBindLogged=false;
function scmNetDebuggerBindFailed(err){if(scmNetDebuggerBindLogged)return;scmNetDebuggerBindLogged=true;try{logError('debugger-bind',err);}catch{}}
function scmNetBindDebugger(){if(scmNetDebuggerBound&&scmNetDebuggerDetachBound)return true;try{const d=chrome.debugger;const on=d&&d.onEvent,off=d&&d.onDetach;if(!on||typeof on.addListener!=='function'||!off||typeof off.addListener!=='function')return false;
  if(!scmNetDebuggerBound){on.addListener(scmNetDebuggerEvent);scmNetDebuggerBound=true;}
  if(!scmNetDebuggerDetachBound){off.addListener((source,reason)=>{if(source?.tabId===scmNetCapture.tabId){scmNetCapture.active=false;scmNetPersistSession();scmNetSave({kind:'capture-detached',reason:String(reason||'unknown')}).catch(()=>{});}});scmNetDebuggerDetachBound=true;}
  return true;}catch(err){scmNetDebuggerBindFailed(err);return false;}}
async function scmNetDebuggerGranted(){try{const P=chrome.permissions;if(!P||typeof P.contains!=='function')return false;return Boolean(await P.contains({permissions:['debugger']}));}catch(err){scmNetDebuggerBindFailed(err);return false;}}
async function scmNetBindDebuggerIfGranted(){try{if(await scmNetDebuggerGranted())return scmNetBindDebugger();}catch(err){scmNetDebuggerBindFailed(err);}return false;}
scmNetBindDebuggerIfGranted().catch(()=>{});
try{chrome.permissions?.onAdded?.addListener(p=>{if(p?.permissions?.includes('debugger'))scmNetBindDebuggerIfGranted().catch(()=>{});});}catch(err){scmNetDebuggerBindFailed(err);}
async function scmNetStart(tabId){try{await scmNetRecoveryPromise;}catch{}if(!(await scmNetBindDebuggerIfGranted()))throw new Error('Debugger permission not granted. Use page capture instead.');if(scmNetCapture.active)throw new Error('A network capture is already active. Stop it first.');const tab=await chrome.tabs.get(tabId);if(!tab?.url||!/^https:\/\/(www\.)?simcompanies\.com\//i.test(tab.url))throw new Error('Selected tab is not a Sim Companies page.');scmNetCapture.tabId=tabId;scmNetCapture.captureId=`net3-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;scmNetCapture.requestMap.clear();scmNetCapture.counters={events:0,requests:0,responses:0,bodies:0,errors:0};scmNetCapture.startedAt=new Date().toISOString();await scmNetClearEvents(scmNetCapture.captureId);await chrome.debugger.attach({tabId},'1.3');try{await chrome.debugger.sendCommand({tabId},'Network.enable',{maxTotalBufferSize:20000000,maxResourceBufferSize:10000000,maxPostDataSize:1000000});scmNetCapture.active=true;await scmNetPersistSession();await scmNetSave({kind:'capture-start',tabId,pageUrl:tab.url,coverage:'Chrome DevTools Protocol Network domain; browser-observed requests for this tab'});return {ok:true,captureId:scmNetCapture.captureId,tabId,status:'recording',note:'Chrome may display a debugging notification while capture is active.'};}catch(err){try{await chrome.debugger.detach({tabId});}catch{}scmNetCapture.active=false;throw err;}}
async function scmNetStop(){if(!scmNetCapture.captureId)return {ok:false,error:'No capture session exists.'};const tabId=scmNetCapture.tabId;scmNetCapture.active=false;await scmNetPersistSession();await scmNetSave({kind:'capture-stop',tabId,stopReason:'user-request'}).catch(()=>{});try{if(tabId!=null)await chrome.debugger.detach({tabId});}catch(err){await scmNetSave({kind:'capture-detach-error',error:String(err?.message||err)}).catch(()=>{});}const status={ok:true,captureId:scmNetCapture.captureId,tabId,status:'stopped',...scmNetCapture.counters};await chrome.storage.local.set({scmNetworkCaptureV3Status:{...status,startedAt:scmNetCapture.startedAt,stoppedAt:new Date().toISOString()}});return status;}

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
async function flushReplayJournal(){
  if(!replayBuffer.length)return {ok:true,empty:true};
  if(replayBuffer.length<REPLAY_CHUNK_SIZE)return {ok:true,buffered:true,count:replayBuffer.length};
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
// SimcoTools (api.simcotools.com) has its OWN limit: 2 requests per second, burst 25 (api docs). It has nothing to do
// with the game's 5-min rule: it never waits on the game lane and never blocks it. Every SimcoTools request goes through
// the SimcoTools channel (simcoFetch -> simcoChannelTake / simcoChannelResult; rules: SCM_TIMERS_CORE.simcoTake /
// simcoResult in timers-core.js). One attempt per request, no in-call retries: a refusal sends nothing and returns
// {queued:true,nextAt,reason}; the job's want stays queued and the 'scm-simco-channel' alarm runs it later.
// A 429 opens the channel cooldown (Retry-After, else SIMCO.COOLDOWN_DEFAULT_MS); a network failure (no connection,
// timeout) marks SimcoTools unreachable: one probe after 1, 2, 5, 10, then every 15 min, ONE log line per outage.
const SIMCOTOOLS_DEFAULT_RATE_LIMIT_COOLDOWN_MS=60*1000;
const SIMCOTOOLS_MAX_RATE_LIMIT_COOLDOWN_MS=60*60*1000;
const SIMCOTOOLS_PAIR_RATE_LIMIT_COOLDOWN_MS=5*60*1000;
// Up to 2.5.465: storage.session scmSimcoToolsGate (500 ms gate) and storage.local simcoToolsRateLimitUntil (5-min
// global cooldown). Both are replaced by scmSimcoChannel and removed once at startup (an old 5-min cooldown would
// otherwise hold every SimcoTools job).
try{chrome.storage?.session?.remove?.('scmSimcoToolsGate')?.catch?.(()=>{});}catch{}
try{chrome.storage?.local?.remove?.('simcoToolsRateLimitUntil')?.catch?.(()=>{});}catch{}
// Mirror of the channel's 429 cooldown (scmSimcoChannel.cooldownUntil), kept for the synchronous checks of the market
// stages; written only by simcoChannelStore.
let simcoRateLimitUntil=0;
const simcoRefreshRuns=new Map();
// Per-endpoint 429 cooldowns of the live-market price job (storage.local simcoToolsRateLimitUntilByUrl).
const simcoRateLimitUntilByUrl=new Map();
// Retry-After: seconds or an HTTP date -> ms from now (null when missing or unreadable).
function simcoRetryAfterMs(response){
  const raw=response?.headers?.get?.('Retry-After');
  if(raw==null||raw==='')return null;
  const seconds=Number(raw);
  let ms=Number.isFinite(seconds)&&seconds>=0?seconds*1000:Date.parse(String(raw))-Date.now();
  if(!Number.isFinite(ms)||ms<0)return null;
  return Math.min(ms,SIMCOTOOLS_MAX_RATE_LIMIT_COOLDOWN_MS);
}
// Game API answers can take 14–70 s on a slow phone connection. One attempt, up to 45 s (the page hook aborts at
// the same limit, max 60 s); retrying a slow request only doubles the load.
const SYNC_PAGE_API_TIMEOUT_MS=45000;
// Sync writes are serialized (~3 s each on a 6 MB realm store); a short timeout fails writes that land a few seconds
// later and forces a slow UI-click fallback. Wait in line instead.
const SYNC_PERSIST_VERIFY_TIMEOUT_MS=30000;
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
  'realmQuarantine','productionRateSnapshots','productionPlans',
  'productionRunHours','gameOverlaySnapshot','javascriptDiagnostic','javascriptDiagnosticHistory',
  'accountingWeekLedgerStatus','accountingDayWalkStatus','accountingDailySeries',
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
  productionRateSnapshots: {},
  productionPlans: {},
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
// The game's public constants (/api/v2/constants/core|buildings|resources/) → scmGameConstants, refreshed
// every 6 h; and your own exchange listings (/api/v2/companies/<id>/market-orders/, read through the game tab) → scmMarketOrders:<realm>.
// No storage lock held while fetching.
const GAME_CONSTANTS_ALARM='scm-game-constants';
// Read through the game tab (pageGet): a plain service-worker fetch of /api/v2/constants/ now gets a Cloudflare 403
// page or "Failed to fetch". After a failed read the next one waits 15 min, doubling up to the 6 h period. The
// backoff is kept in storage.session (scmGameConstantsRetry) so a restarted service worker keeps it; it is cleared
// on success and when the browser restarts or the extension is reloaded/updated. No game tab, a page bridge that is
// not ready yet (fresh install / worker start before the tab's content script runs) or a page that unloaded mid-read:
// a "not read" line (backoff not touched); a lane slot taken: a "waiting" line. After a finished Sync (opts.ignoreBackoff) the backoff is ignored:
// the Sync just proved the bridge works. A real failure is always logged: under the active realm, else the selected
// realm, else the extension error log (scmErrorLog).
const GAME_CONSTANTS_PERIOD_MS=6*3600000,GAME_CONSTANTS_RETRY_MIN_MS=15*60000,GAME_CONSTANTS_RETRY_KEY='scmGameConstantsRetry';
let gameConstantsRetryMem=null,gameConstantsInFlight=null;
// Per-read timeout for reads through the game tab that a slow game server can take 6-9 s to answer (constants,
// own listings, outgoing contracts). One attempt each; how often they run is unchanged.
const GAME_CONSTANTS_READ_TIMEOUT_MS=20000,SLOW_SERVER_PAGE_READ_TIMEOUT_MS=20000,GAME_CONSTANTS_PARTIAL_KEY='scmGameConstantsPartial';
// Refresh error text kept in storage / shown on the cards is capped (a game error page can be long).
const REFRESH_ERROR_MAX_CHARS=200;
function capRefreshError(e){const t=String(e??'');return t.length>REFRESH_ERROR_MAX_CHARS?`${t.slice(0,REFRESH_ERROR_MAX_CHARS-1)}…`:t;}
async function gameConstantsRetryGet(){try{if(chrome.storage?.session){const v=(await chrome.storage.session.get(GAME_CONSTANTS_RETRY_KEY))?.[GAME_CONSTANTS_RETRY_KEY];return v&&typeof v==='object'?v:null;}}catch{}return gameConstantsRetryMem;}
async function gameConstantsRetrySet(v){gameConstantsRetryMem=v;try{if(chrome.storage?.session){if(v)await chrome.storage.session.set({[GAME_CONSTANTS_RETRY_KEY]:v});else await chrome.storage.session.remove(GAME_CONSTANTS_RETRY_KEY);}}catch{}}
// Rate-limit stamps that must survive a service-worker restart (name -> ms): chrome.storage.session key
// scmGateStamps (TRUSTED_CONTEXTS, not readable by content scripts), memory fallback; writes serialized.
const SCM_GATE_STAMPS_KEY='scmGateStamps',scmGateStampsMem={};let scmGateStampTail=Promise.resolve();
async function scmGateStampGet(name){let v=Number(scmGateStampsMem[name])||0;try{if(chrome.storage?.session){const s=(await chrome.storage.session.get(SCM_GATE_STAMPS_KEY))?.[SCM_GATE_STAMPS_KEY];const x=Number(s?.[name])||0;if(x>v)v=x;}}catch{}return v;}
function scmGateStampSet(name,at){if(at)scmGateStampsMem[name]=at;else delete scmGateStampsMem[name];
  const run=scmGateStampTail.then(async()=>{try{if(!chrome.storage?.session)return;const cur=(await chrome.storage.session.get(SCM_GATE_STAMPS_KEY))?.[SCM_GATE_STAMPS_KEY];const next={...(cur&&typeof cur==='object'?cur:{})};if(at)next[name]=at;else delete next[name];await chrome.storage.session.set({[SCM_GATE_STAMPS_KEY]:next});}catch{}});
  scmGateStampTail=run;return run;}
// Install / update / worker start with no game tab (opts.quietNoTab): no "not read" line (the built-in copy already
// applies); a flag in storage.session (scmGameConstantsOnBridge) makes the next GAME_STATE from a game tab run it.
const GAME_CONSTANTS_ON_BRIDGE_KEY='scmGameConstantsOnBridge';let gameConstantsOnBridgeMem=false;
async function gameConstantsOnBridgeSet(v){gameConstantsOnBridgeMem=Boolean(v);try{if(chrome.storage?.session){if(v)await chrome.storage.session.set({[GAME_CONSTANTS_ON_BRIDGE_KEY]:Date.now()});else await chrome.storage.session.remove(GAME_CONSTANTS_ON_BRIDGE_KEY);}}catch{}}
async function gameConstantsOnBridgeTake(){let v=gameConstantsOnBridgeMem;try{if(chrome.storage?.session)v=v||Boolean((await chrome.storage.session.get(GAME_CONSTANTS_ON_BRIDGE_KEY))?.[GAME_CONSTANTS_ON_BRIDGE_KEY]);}catch{}if(v)await gameConstantsOnBridgeSet(false);return v;}
function refreshGameConstants(force=false,maxAgeMs=GAME_CONSTANTS_PERIOD_MS,opts={}){
  if(gameConstantsInFlight)return gameConstantsInFlight;
  gameConstantsInFlight=refreshGameConstantsOnce(force,maxAgeMs,opts).then(gameConstantsResultSource).finally(()=>{gameConstantsInFlight=null;});
  return gameConstantsInFlight;
}
// Every refresh answer says where the stored constants come from (source 'bundled' | 'game'); with the built-in copy
// it carries the status text (message) as well, whatever happened with the API read (skipped, backoff, failure).
async function gameConstantsResultSource(r){
  if(!r||typeof r!=='object'||r.source)return r;
  try{const cur=(await chrome.storage.local.get({scmGameConstants:null})).scmGameConstants;
    if(globalThis.SCM_TOOLS_CORE.gameConstantsOk(cur)){const bi=cur.source==='bundled';return {...r,source:bi?'bundled':'game',...(bi&&!r.message?{bundle:cur.bundle||null,message:bundledGameConstantsText(cur)}:{})};}}catch{}
  return r;
}
// The game tab cannot be asked right now (no content script / page hook yet, or the page unloaded): not a failed read.
function pageBridgeUnavailable(e){return Boolean(e?.pageClosed||e?.bridgeNotReady||e?.noGameTab||e?.tabHidden||e?.offline)||/page bridge is not (?:ready|connected)|Open Sim Companies and log in/i.test(String(e?.message||e||''));}
// Activity line when the active realm is not known yet (fresh install): the selected realm, else the error log
// (failure, partial and not-read lines; a waiting line is planned pace and goes nowhere without a realm).
async function logActivityAnyRealm(job,outcome,details={},error=null){
  let r=await activeRealmNumber();
  if(r==null){try{r=validRealmNumber((await chrome.storage.local.get({selectedRealm:null})).selectedRealm);}catch{}}
  if(r!=null)return logActivity(r,job,outcome,details,error);
  if(outcome==='failure'||outcome==='partial'||outcome==='not-read')logError(job,error||outcome);
}
// Built-in copy of the game constants: constants.json in the extension package, same shape as scmGameConstants
// ({core,buildings,resources,at,source,bundle}; `at` = the date of the game bundle it was taken from). Under the game's
// bot protection /api/v2/constants/* cannot be read, and the game's own pages never load them (they are compiled into
// its bundle), so without this a fresh install or Clear data had no constants at all. Read with fetch() of the
// extension's own file (no network, no web_accessible_resources entry needed). When scmGameConstants is missing (or
// unusable) it is written from the built-in copy with source:'bundled'; a stored copy is kept unless the built-in one
// is newer (`at`), so a newer live-read copy is never overwritten. Every scmGameConstants write (built-in or API) goes
// through gameConstantsWrite (one at a time; the built-in check re-reads the stored copy inside the queue).
const GAME_CONSTANTS_BUNDLED_FILE='constants.json';
let bundledGameConstantsPromise=null,gameConstantsWriteTail=Promise.resolve();
function bundledGameConstants(){
  if(!bundledGameConstantsPromise)bundledGameConstantsPromise=fetch(chrome.runtime.getURL(GAME_CONSTANTS_BUNDLED_FILE),{cache:'no-store'})
    .then(r=>r?.ok?r.json():null).then(c=>c&&typeof c==='object'&&globalThis.SCM_TOOLS_CORE.gameConstantsOk(c)&&Number.isFinite(Date.parse(c.at||''))?c:null)
    .catch(()=>null).then(c=>{if(!c)bundledGameConstantsPromise=null;return c;});
  return bundledGameConstantsPromise;
}
function gameConstantsWrite(fn){const run=gameConstantsWriteTail.then(fn);gameConstantsWriteTail=run.catch(()=>{});return run;}
function bundledGameConstantsText(c){return `Game constants from the Manager's built-in copy (game version ${String(c?.bundle||String(c?.at||'').slice(0,10)||'unknown').slice(0,80)})`;}
async function applyBundledGameConstants(){
  const b=await bundledGameConstants();
  if(!b)return {ok:false,applied:false,error:'The built-in game constants (constants.json) are missing or unreadable.'};
  return gameConstantsWrite(async()=>{
    const cur=(await chrome.storage.local.get({scmGameConstants:null})).scmGameConstants;
    const curAt=Date.parse(cur?.at||''),bAt=Date.parse(b.at);
    if(globalThis.SCM_TOOLS_CORE.gameConstantsOk(cur)&&Number.isFinite(curAt)&&curAt>=bAt)return {ok:true,applied:false,source:cur.source==='bundled'?'bundled':'game',bundle:b.bundle||null};
    await rawStorageSet({scmGameConstants:{...b,source:'bundled'}});
    return {ok:true,applied:true,source:'bundled',bundle:b.bundle||null,replaced:cur?(cur.source==='bundled'?'bundled':'game'):null};
  });
}
async function refreshGameConstantsOnce(force,maxAgeMs=GAME_CONSTANTS_PERIOD_MS,opts={}){
  // No game tab / bridge not up: quiet (flag, read on the next GAME_STATE) for every caller but a Sync or a forced
  // read, so a caller that forgets the option cannot bring the line back.
  opts={...(opts||{}),quietNoTab:opts?.quietNoTab??(!force&&!opts?.afterSync)};
  // Missing constants are filled from the built-in copy first, whatever happens with the API read below.
  let bundled=null;try{bundled=await applyBundledGameConstants();}catch{}
  if(bundled?.applied){try{const b=await bundledGameConstants();logActivityAnyRealm('game-constants','success',{source:'bundled',bundle:bundled.bundle,replaced:bundled.replaced,note:bundledGameConstantsText(b)});}catch{}}
  try{
    const cur=(await chrome.storage.local.get({scmGameConstants:null})).scmGameConstants;
    if(!force&&cur&&Date.now()-Date.parse(cur.at||0)<Math.max(GAME_CONSTANTS_PERIOD_MS,Number(maxAgeMs)||0))return {ok:true,cached:true,source:cur.source==='bundled'?'bundled':'game',...(cur.source==='bundled'?{message:bundledGameConstantsText(cur)}:{})};
    // A real backoff / missing tab only matters for the API read: the built-in copy already covers missing constants.
    if(cur?.source==='bundled'&&!(await simTab())?.id){if(opts?.quietNoTab){await gameConstantsOnBridgeSet(true);return {ok:true,skipped:true,quiet:true,source:'bundled',bundle:cur.bundle||null,message:bundledGameConstantsText(cur),error:'No Sim Companies tab open.'};}logActivityAnyRealm('game-constants','not-read',{},notReadReason('no-game-tab'));return {ok:true,skipped:true,source:'bundled',bundle:cur.bundle||null,message:bundledGameConstantsText(cur),error:'No Sim Companies tab open.'};}
    const retry=await gameConstantsRetryGet();
    if(!force&&!opts?.ignoreBackoff&&retry&&Number(retry.nextAt)>Date.now())return {ok:false,backoff:true,error:retry.error||null,nextAt:retry.nextAt};
    if(!(await simTab())?.id){if(opts?.quietNoTab){await gameConstantsOnBridgeSet(true);return {ok:false,skipped:true,quiet:true,error:'No Sim Companies tab open.'};}logActivityAnyRealm('game-constants','not-read',{},notReadReason('no-game-tab'));return {ok:false,skipped:true,error:'No Sim Companies tab open.'};}
  }catch(e){return {ok:false,error:String(e?.message||e)};}
  // Unattended (alarm, worker start, a game page or the dashboard asking for missing data): the three reads go through
  // the shared game lane (job 'gameConstants'), one per free slot; the parts already read wait in storage.session
  // (scmGameConstantsPartial, kept 1 h) for the next slot. After a Sync (afterSync) or force: all three now.
  // 2.5.465: every read is a lane read (forced / after Sync too): the parts already read wait for the next slot.
  const lane=true;
  let partial={};
  if(lane){try{const v=(await chrome.storage.session.get(GAME_CONSTANTS_PARTIAL_KEY))?.[GAME_CONSTANTS_PARTIAL_KEY];if(v&&typeof v==='object')partial=v;}catch{}}
  const partialFresh=p=>Boolean(partial[p]&&partial[p].data&&typeof partial[p].data==='object'&&Date.now()-Number(partial[p].at)<3600e3);
  try{
    const get=async p=>{
      if(lane&&partialFresh(p))return partial[p].data;
      const x=await pageGet(p,null,null,'game-constants',{timeoutMs:GAME_CONSTANTS_READ_TIMEOUT_MS,attempts:1,...(lane?{lane:'gameConstants'}:{})});
      if(x?.laneWait){const e=new Error(GAME_LANE_WAIT_TEXT);e.laneWait=true;e.nextAt=Number(x.nextAt)||0;throw e;}
      if(!x?.ok){const fe=new Error(`${p} ${x?.error||`HTTP ${x?.status||0}`}`);throw fe;}if(!x.data||typeof x.data!=='object')throw new Error(`${p} not JSON`);
      if(lane){partial={...partial,[p]:{data:x.data,at:Date.now()}};try{await chrome.storage.session.set({[GAME_CONSTANTS_PARTIAL_KEY]:partial});}catch{}}
      return x.data;};
    // One at a time: the first failure stops the rest.
    const core=await get('/api/v2/constants/core/'),buildings=await get('/api/v2/constants/buildings/'),resources=await get('/api/v2/constants/resources/');
    if(lane){try{await chrome.storage.session.remove(GAME_CONSTANTS_PARTIAL_KEY);}catch{}}
    const next={core,buildings,resources,at:new Date().toISOString()};
    if(!globalThis.SCM_TOOLS_CORE.gameConstantsOk(next))throw new Error('constants missing fields');
    await gameConstantsWrite(()=>rawStorageSet({scmGameConstants:next}));
    await gameConstantsRetrySet(null);
    logActivityAnyRealm('game-constants','success',{});
    return {ok:true};
  }catch(e){
    // Not this job's lane slot yet: a "waiting" line (parts read so far wait for the next slot).
    if(e?.laneWait&&gameRefusalActive()){logActivityAnyRealm('game-constants','skipped',{refused:true,nextAt:Number(gameRefusalMem.until),parts:Object.keys(partial).length},gameRefusalText(gameRefusalMem.until)+'; the stored constants stay in use');return {ok:true,skipped:true,laneWait:true,refused:true,reason:'refused'};}
    if(e?.laneWait){logActivityAnyRealm('game-constants','waiting',{laneWait:true,nextAt:Number(e.nextAt)||0,parts:Object.keys(partial).length},laneWaitText(e.nextAt));return {ok:true,skipped:true,laneWait:true,reason:'lane',parts:Object.keys(partial).length};}
    const error=capRefreshError(e?.message||e);
    // No game tab / page bridge not ready / page unloaded: a "not read" line, no backoff step.
    // Unattended (quietNoTab) and the tab went away / its bridge was not up yet (page loading after an update): no line,
    // the read runs on the next GAME_STATE. Hidden tab / offline lines go through the quiet-stretch rule instead.
    if(pageBridgeUnavailable(e)&&opts?.quietNoTab&&!e?.tabHidden&&!e?.offline&&!e?.pageClosed){await gameConstantsOnBridgeSet(true);return {ok:false,skipped:true,quiet:true,reason:'bridge-not-ready',error};}
    if(pageBridgeUnavailable(e)){logActivityAnyRealm('game-constants','not-read',{},notReadReason(e));return {ok:false,skipped:true,reason:'bridge-not-ready',reachedTab:!(e?.bridgeNotReady||e?.noGameTab)&&!/page bridge is not (?:ready|connected)|Open Sim Companies and log in/i.test(error),error};}
    try{const prev=await gameConstantsRetryGet();const failures=Math.min(30,(Number(prev?.failures)||0)+1);
      const waitMs=Math.min(GAME_CONSTANTS_PERIOD_MS,GAME_CONSTANTS_RETRY_MIN_MS*2**(failures-1));
      await gameConstantsRetrySet({failures,nextAt:Date.now()+waitMs,error,at:new Date().toISOString()});}catch{}
    await logActivityAnyRealm('game-constants','failure',{},error);return {ok:false,error};
  }
}
// Targeted delivery for the game-page cards: instead of the content script listening to every storage.local
// write (realm stores are ~1MB), tell Sim Companies tabs which small key changed.
async function notifyGameCardsKeyChanged(key){
  try{const tabs=await chrome.tabs.query({url:['https://www.simcompanies.com/*','https://simcompanies.com/*']});
    for(const t of tabs){if(t?.id!=null)chrome.tabs.sendMessage(t.id,{type:'SCM_CARD_KEY_CHANGED',key}).catch(()=>{});}
  }catch{}
}
// BRIDGE_STATUS answers took 2.6-3.6 s on a phone with real storage (2.5.464 phone-realistic run): local message waits.
const BRIDGE_STATUS_WAIT_MS=5000,SELF_TEST_BRIDGE_WAIT_MS=8000;
const ownListingsRefreshError=new Map(); // realm → {error,at} of the last failed refreshMarketOrders (cleared on success; memory only)
// One gate for every own-listings read (card refresh, game action, overlay refresh, Sync tail, undercut check), per
// realm: one read in flight (callers share it); at least 15 s between network reads whatever the caller or maxAgeMs;
// after a failed read the next waits 15 s, 30 s, then 60 s (cleared on success). A card / game-action call inside
// the gap or backoff gets ONE coalesced trailing read at its end (never dropped); a background call (Sync tail,
// undercut check, opts.background) just uses the stored scmMarketOrders. Gap/backoff state is kept in storage.session
// (scmMarketOrdersGate:<realm>, memory fallback) so a restarted service worker keeps it. A "not read" line (no
// request, no failure, no backoff step): no game tab, the tab is in the other realm, or (background calls only) the
// game tab is not the active tab in its window. A lane slot taken: a "waiting" line.
const MARKET_ORDERS_GAP_MS=15000,MARKET_ORDERS_BACKOFF_MS=[15000,30000,60000],MARKET_ORDERS_GATE_KEY='scmMarketOrdersGate:';
const marketOrdersGateMem=new Map(),marketOrdersInFlight=new Map(),marketOrdersTrailing=new Map(),marketOrdersNetStart=new Map();
async function marketOrdersGateGet(r){const key=MARKET_ORDERS_GATE_KEY+r;try{if(chrome.storage?.session){const v=(await chrome.storage.session.get(key))?.[key];return v&&typeof v==='object'?v:null;}}catch{}return marketOrdersGateMem.get(r)||null;}
async function marketOrdersGateSet(r,v){const key=MARKET_ORDERS_GATE_KEY+r;marketOrdersGateMem.set(r,v);try{if(chrome.storage?.session)await chrome.storage.session.set({[key]:v});}catch{}}
// Why a read must not go out now (null = go). Asks the tab's content script which realm it is in (BRIDGE_STATUS,
// local message, no network); an unknown realm goes ahead and pageGet's own realm check decides.
async function marketOrdersTabSkip(r,background){
  let tab=null;try{tab=await simTab();}catch{}
  if(!tab?.id)return 'no-game-tab';
  let b=null;try{b=await Promise.race([chrome.tabs.sendMessage(tab.id,{type:'BRIDGE_STATUS'}),new Promise(res=>setTimeout(()=>res(null),BRIDGE_STATUS_WAIT_MS))]);}catch{}
  // tab.active is not reliable on Chrome for Android (the game tab on screen reads active:false): the page's own
  // document.visibilityState (BRIDGE_STATUS.visible) also counts as "in use".
  if(background&&!tab.active&&b?.visible!==true)return 'game-tab-not-active';
  const tabRealm=b?.realm===0||b?.realm===1?b.realm:null;
  return tabRealm!=null&&tabRealm!==r?'other-realm':null;
}
function scheduleMarketOrdersTrailing(r,atMs){
  const prev=marketOrdersTrailing.get(r);
  if(prev&&prev.at>=atMs)return;
  if(prev)clearTimeout(prev.id);
  const e={at:atMs,id:0};
  e.id=setTimeout(()=>{if(marketOrdersTrailing.get(r)===e)marketOrdersTrailing.delete(r);refreshMarketOrders(r,0).catch(()=>{});},Math.max(0,atMs-Date.now())+25);
  marketOrdersTrailing.set(r,e);
}
// A listings read after a game action, or from the overlay's refresh button, that found the shared 5-min game slot
// taken (lane wait), its own 15 s gap or a backoff is not dropped: ONE deferred retry per realm (alarm
// scm-listings-retry-r<realm>, state {queuedAt,at,why} in storage.session scmMarketOrdersRetry:<realm>) runs when the
// slot frees (lane lastAt + 5 min, the 15 s gap and any backoff over). It is the read the action asked for, so it goes
// as a user read (it moves the lane's lastAt like one). While Sync runs, the game tab is hidden or the device is
// offline it waits (re-checked every minute; dropped 30 min after it was queued). A second queue call only moves it.
const MARKET_ORDERS_RETRY_ALARM_PREFIX='scm-listings-retry-r',MARKET_ORDERS_RETRY_KEY='scmMarketOrdersRetry:',MARKET_ORDERS_RETRY_MAX_MS=30*60000,MARKET_ORDERS_RETRY_RECHECK_MS=60000;
const marketOrdersRetryMem=new Map();let marketOrdersRetryTail=Promise.resolve();
function marketOrdersRetrySerial(fn){const run=marketOrdersRetryTail.then(fn,fn);marketOrdersRetryTail=run.catch(()=>{});return run;}
async function marketOrdersRetryGet(r){const key=MARKET_ORDERS_RETRY_KEY+r;try{if(chrome.storage?.session){const v=(await chrome.storage.session.get(key))?.[key];return v&&typeof v==='object'?v:null;}}catch{}return marketOrdersRetryMem.get(r)||null;}
async function marketOrdersRetrySet(r,v){const key=MARKET_ORDERS_RETRY_KEY+r;if(v)marketOrdersRetryMem.set(r,v);else marketOrdersRetryMem.delete(r);try{if(chrome.storage?.session){if(v)await chrome.storage.session.set({[key]:v});else await chrome.storage.session.remove(key);}}catch{}}
// Earliest time the retry may read: the lane's next free slot, the listings 15 s gap, a backoff.
async function marketOrdersRetryAt(r,now=Date.now()){
  let laneAt=0;try{const C=gameLaneCore();if(C)laneAt=C.laneNextSlotAt(await gameLaneLoad(),now);}catch{}
  const g=(await marketOrdersGateGet(r))||{};
  return Math.max(now+1000,laneAt,(Number(g.lastAt)||0)+MARKET_ORDERS_GAP_MS,Number(g.nextAt)||0);
}
// x: what refreshMarketOrders answered. True when that read was held back (no request made, no trailing read set).
function marketOrdersNeedsRetry(x){return Boolean(x&&!x.ok&&x.laneWait)||Boolean(x&&x.skipped&&(x.reason==='gap'||x.reason==='backoff')&&!x.trailingAt);}
function queueMarketOrdersRetry(realm,why='lane'){
  const r=validRealmNumber(realm);if(r==null)return Promise.resolve({queued:false});
  const clearGen=extensionClearGeneration;
  return marketOrdersRetrySerial(async()=>{
    if(clearGen!==extensionClearGeneration)return {queued:false,cleared:true};
    const cur=await marketOrdersRetryGet(r),now=Date.now();
    const queuedAt=Number(cur?.queuedAt)>0&&now-Number(cur.queuedAt)<MARKET_ORDERS_RETRY_MAX_MS?Number(cur.queuedAt):now;
    const at=await marketOrdersRetryAt(r,now);
    await marketOrdersRetrySet(r,{queuedAt,at,why:String(why).slice(0,20)});
    await scmCreateShortAlarm(MARKET_ORDERS_RETRY_ALARM_PREFIX+r,Math.max(0,at-now));
    return {queued:true,at,already:Boolean(cur)};
  });
}
// The game tab's BRIDGE_STATUS (local message, no network): b is null when there is no tab or it does not answer.
async function gameTabBridgeStatus(){
  let tab=null;try{tab=await simTab();}catch{}
  if(!tab?.id)return {tab:null,b:null};
  let b=null;try{b=await Promise.race([chrome.tabs.sendMessage(tab.id,{type:'BRIDGE_STATUS'}),new Promise(res=>setTimeout(()=>res(null),BRIDGE_STATUS_WAIT_MS))]);}catch{}
  return {tab,b};
}
function marketOrdersRetryClearAll(){return marketOrdersRetrySerial(async()=>{marketOrdersRetryMem.clear();try{await chrome.storage.session?.remove([MARKET_ORDERS_RETRY_KEY+0,MARKET_ORDERS_RETRY_KEY+1]);}catch{}});}
async function runMarketOrdersRetry(realm){
  const r=validRealmNumber(realm);if(r==null)return {ok:false};
  const step=await marketOrdersRetrySerial(async()=>{
    const cur=await marketOrdersRetryGet(r),now=Date.now();if(!cur)return {run:false,reason:'none'};
    const rearm=async(at,reason)=>{await marketOrdersRetrySet(r,{...cur,at});await scmCreateShortAlarm(MARKET_ORDERS_RETRY_ALARM_PREFIX+r,Math.max(0,at-now));return {run:false,reason};};
    if(now-(Number(cur.queuedAt)||now)>=MARKET_ORDERS_RETRY_MAX_MS){await marketOrdersRetrySet(r,null);return {run:false,reason:'expired'};}
    if(coreSyncActive())return await rearm(now+MARKET_ORDERS_RETRY_RECHECK_MS,'sync');
    const at=await marketOrdersRetryAt(r,now);if(at>now+1500)return await rearm(at,'slot');
    const {tab,b}=await gameTabBridgeStatus();
    const skip=!tab?'no-game-tab':b?.online===false||(typeof navigator!=='undefined'&&navigator.onLine===false)?'offline':null;
    if(skip==='offline'||skip==='game-tab-hidden'){logNotRead(r,'market-orders',skip,{deferredRetry:true},now,'retry');return await rearm(now+MARKET_ORDERS_RETRY_RECHECK_MS,skip);}
    if(skip){await marketOrdersRetrySet(r,null);logNotRead(r,'market-orders',skip,{deferredRetry:true},now,'retry');return {run:false,reason:skip};}
    return {run:true,cur};
  });
  if(!step.run)return {ok:true,...step};
  // A shared-lane read (job listings:<realm>): the lane keeps its place between slots, and once it has waited through
  // a slot it gets the next one (laneWinner). Lane says wait: still queued, asked again at the next slot.
  const res=await refreshMarketOrders(r,0,{deferredRetry:true,lane:`listings:${r}`});
  await marketOrdersRetrySerial(async()=>{const cur=await marketOrdersRetryGet(r);if(!cur||Number(cur.queuedAt)!==Number(step.cur?.queuedAt))return;
    if(res?.laneWait&&Date.now()-(Number(cur.queuedAt)||0)<MARKET_ORDERS_RETRY_MAX_MS){const at=Math.max(Date.now()+1000,Number(res.nextAt)||0);await marketOrdersRetrySet(r,{...cur,at});await scmCreateShortAlarm(MARKET_ORDERS_RETRY_ALARM_PREFIX+r,Math.max(0,at-Date.now()));return;}
    await marketOrdersRetrySet(r,null);});
  return res;
}
// One read serves every listings reader: a stored read or the game's own capture stamps the card poll's lane job (its
// 15 min spacing starts now) and drops the waiting card poll / held retry that asked before it (no second request).
function marketOrdersServed(realm,at=Date.now()){
  const r=validRealmNumber(realm);if(r==null)return;
  if(typeof gameLaneSerial==='function')gameLaneSerial(async()=>{const C=gameLaneCore();if(!C)return;const st=C.laneState(await gameLaneLoad(),Date.now());let ch=false;const k=`marketOrders:${r}`;
    if(!(Number(st.jobs[k])>=at)){st.jobs[k]=Math.min(at,Date.now());ch=true;}
    for(const w of [k,`listings:${r}`])if(st.wants[w]&&Number(st.wants[w].since)<=at){delete st.wants[w];ch=true;}
    if(ch)await gameLaneStore(st);}).catch(()=>{});
  marketOrdersRetrySerial(async()=>{const cur=await marketOrdersRetryGet(r);if(cur&&Number(cur.queuedAt)<=at)await marketOrdersRetrySet(r,null);}).catch(()=>{});
}
chrome.alarms.onAlarm.addListener(a=>{const m=String(a?.name||'').match(/^scm-listings-retry-r([01])$/);if(m)runMarketOrdersRetry(Number(m[1])).catch(e=>logError('alarm:listings-retry',e));});
// The game's own GET of your listings (warehouse page: /api/v2/companies/me/market-orders/; your company page:
// /api/v2/companies/<your id>/market-orders/) is the list refreshMarketOrders reads: store it as scmMarketOrders:<realm>
// with no request of our own, and count it as a read for the 15 s gap. Another company's list (its profile page) is
// never taken: a numeric id must be this realm's own company id.
// Path only, or the game origin (a foreign host is not the game's own listings).
const OWN_MARKET_ORDERS_URL_RE=/^(?:https:\/\/(?:www\.)?simcompanies\.com)?\/api\/v2\/companies\/(me|\d+)\/market-orders\/?(?:\?.*)?$/i;
async function captureOwnMarketOrders(realm,url,data){
  const r=validRealmNumber(realm);if(r==null)return {ok:false,reason:'no-realm'};
  const m=String(url||'').match(OWN_MARKET_ORDERS_URL_RE);if(!m)return {ok:false,reason:'not-own-orders-url'};
  const keys=['data','items','results','orders','marketOrders'];
  if(!Array.isArray(data)&&!(data&&typeof data==='object'&&keys.some(f=>Array.isArray(data[f]))))return {ok:false,reason:'not-a-list'};
  const clearGen=extensionClearGeneration;
  const k=`scmMarketOrders:${r}`;
  const st=await notifyRealmStore(r),ac=st?.authData?.authCompany;
  const acRealm=validRealmNumber(ac?.realmId??ac?.realm??st?.authData?.realmId??st?.authData?.realm);
  const safeCid=v=>{const n=Number(v);return Number.isSafeInteger(n)&&n>0?n:0;};
  const cur=(await chrome.storage.local.get({[k]:null}))[k];
  const own=(acRealm==null||acRealm===r?safeCid(ac?.companyId??ac?.id):0)||capturedCompanyIdForRealm(st,r)||safeCid(cur?.companyId);
  if(m[1].toLowerCase()!=='me'&&!(own>0&&Number(m[1])===own))return {ok:false,reason:'other-company'};
  const orders=helperArray(data,keys);
  // /me/ and /<own id>/ are the same list, but /me/ answered [] while /<id>/ had 4 (user capture 2026-11-12): within
  // 60 s of an /<id>/ answer (or a Manager read, which uses /<id>/) a /me/ answer is not stored.
  const via=m[1].toLowerCase()==='me'?'me':'id';
  const decision=ownOrdersCaptureDecision(cur,via,orders);
  if(!decision.write){if(decision.recheck&&typeof gameLaneEnqueue==='function')gameLaneEnqueue(`marketOrders:${r}`).catch(()=>{});return {ok:true,skipped:true,reason:decision.reason};}
  if(clearGen!==extensionClearGeneration)return {ok:false,reason:'cleared'};
  await rawStorageSet({[k]:{companyId:own||null,orders,at:new Date().toISOString(),via,source:'game'}});ownListingsRefreshError.delete(r);
  {const at=Date.now();await marketOrdersGateSet(r,{lastAt:at});notifyGameCardsKeyChanged(k);if(typeof marketOrdersServed==='function')marketOrdersServed(r,at);}
  logActivity(r,'market-orders','success',{rows:orders.length,source:'game'},null,Date.now(),'game');
  return {ok:true,rows:orders.length};
}
// The game's reply to your own listing action, as the game itself uses it (bundle 2026-11-12): a sell post
// (POST /api/v2/market-order/) answers {sellOrder?, moneyDelta?} and the game adds sellOrder to its own list (none when
// it all sold at once); a contract post (same POST with contractTo) answers {contract}; a cancel
// (DELETE /api/v2/market-order/<id>/) answers {fees} and the game drops that id. The game makes no listings GET after
// any of them, so the stored lists are changed the same way here. Returns true when a stored list was updated (or the
// action needs no list change); false = not a listing action / nothing stored to change (caller reads as before).
const GAME_MARKET_ORDER_PATH_RE=/^\/api\/v2\/market-order\/(?:(\d+)\/?)?(?:\?.*)?$/i;
async function applyGameListingReply(realm,method,url,data){
  const r=validRealmNumber(realm);if(r==null)return false;
  const m=String(url||'').replace(/^https:\/\/(?:www\.)?simcompanies\.com/i,'').match(GAME_MARKET_ORDER_PATH_RE);if(!m)return false;
  const verb=String(method||'').toUpperCase(),id=m[1]?Number(m[1]):null;
  const clearGen=extensionClearGeneration,nowIso=new Date().toISOString();
  const ok=x=>x&&typeof x==='object'&&!Array.isArray(x);
  if(verb==='POST'&&id==null){
    if(!ok(data))return false;
    if(ok(data.contract)){
      const k=`scmOutgoingContracts:${r}`;const small=(await chrome.storage.local.get({[k]:null}))[k];
      const captured=Object.entries((await notifyRealmStore(r))?.endpointData||{})
        .filter(([u,v])=>/\/api\/v3\/contracts-outgoing\/me\/?(?:\?.*)?$/i.test(String(u||''))&&Number(v?.status)>=200&&Number(v?.status)<300&&Array.isArray(v?.data))
        .map(([,v])=>({data:v.data,at:v.receivedAt}));
      const base=[small&&Array.isArray(small.data)?{data:small.data,at:small.at}:null,...captured].filter(Boolean).sort((a,b)=>(Date.parse(b.at||0)||0)-(Date.parse(a.at||0)||0))[0];
      if(!base)return false;
      const list=base.data.filter(c=>c?.id==null||c.id!==data.contract.id).concat([data.contract]);
      if(clearGen!==extensionClearGeneration)return true;
      await rawStorageSet({[k]:{data:list,at:nowIso,source:'game-post'}});notifyGameCardsKeyChanged(k);
      logActivity(r,'outgoing-contracts','success',{rows:list.length,source:'game-post'},null,Date.now(),'game');
      return true;
    }
    const k=`scmMarketOrders:${r}`;const cur=(await chrome.storage.local.get({[k]:null}))[k];
    if(!cur||!Array.isArray(cur.orders))return false;
    if(!ok(data.sellOrder))return true; // sold at once: no listing was added
    const orders=cur.orders.filter(o=>o?.id==null||o.id!==data.sellOrder.id).concat([data.sellOrder]);
    if(clearGen!==extensionClearGeneration)return true;
    await rawStorageSet({[k]:{...cur,orders,at:nowIso,source:'game-post'}});notifyGameCardsKeyChanged(k);
    logActivity(r,'market-orders','success',{rows:orders.length,source:'game-post'},null,Date.now(),'game');
    return true;
  }
  if(verb==='DELETE'&&id>0){
    const k=`scmMarketOrders:${r}`;const cur=(await chrome.storage.local.get({[k]:null}))[k];
    if(!cur||!Array.isArray(cur.orders))return false;
    const orders=cur.orders.filter(o=>Number(o?.id)!==id);
    if(clearGen!==extensionClearGeneration)return true;
    await rawStorageSet({[k]:{...cur,orders,at:nowIso,source:'game-cancel'}});notifyGameCardsKeyChanged(k);
    logActivity(r,'market-orders','success',{rows:orders.length,source:'game-cancel'},null,Date.now(),'game');
    return true;
  }
  return false;
}
// Read through the game tab (pageGet): a plain service-worker fetch of this URL now gets a Cloudflare 403 page.
async function refreshMarketOrders(realm,maxAgeMs=5*60000,opts=null){
  const r=validRealmNumber(realm);if(r==null)return {ok:false};
  const k=`scmMarketOrders:${r}`;let cur=null;
  try{cur=(await chrome.storage.local.get({[k]:null}))[k];}catch(e){return {ok:false,error:String(e?.message||e)};}
  if(cur&&Date.now()-Date.parse(cur.at||0)<maxAgeMs)return {ok:true,cached:true};
  // A card / game-action call while a read is already on the wire may carry a change that read missed: one
  // trailing read at the end of that read's gap.
  // opts.lane: the card poll / undercut check (unattended): a shared-lane read (job 'marketOrders:<realm>', at most
  // every 15 min), never a trailing read. Without it (a game action, the refresh button, after Sync) it reads now.
  const running=marketOrdersInFlight.get(r);
  if(running){const s=marketOrdersNetStart.get(r);if(s&&!opts?.background&&!opts?.lane)scheduleMarketOrdersTrailing(r,Math.max(s+MARKET_ORDERS_GAP_MS,Date.now()+1000));return running;}
  const p=marketOrdersReadOnce(r,cur,Boolean(opts?.background),typeof opts?.lane==='string'&&opts.lane?opts.lane:Boolean(opts?.lane)).finally(()=>{if(marketOrdersInFlight.get(r)===p){marketOrdersInFlight.delete(r);marketOrdersNetStart.delete(r);}});
  marketOrdersInFlight.set(r,p);
  return p;
}
// Company id from the realm's captured GET /api/v3/companies/auth-data/ response (newest 2xx whose realm is r or not stated).
function capturedCompanyIdForRealm(store,r){
  let best=null;
  for(const [u,v] of Object.entries(store?.endpointData||{})){
    if(!/\/api\/v3\/companies\/auth-data\/?(\?.*)?$/i.test(String(u||'')))continue;
    if(!(Number(v?.status)>=200&&Number(v?.status)<300)||!v?.data)continue;
    const ac=v.data?.authCompany;if(!ac)continue;
    const ar=validRealmNumber(ac.realmId??ac.realm);if(ar!=null&&ar!==r)continue;
    const cid=Number(ac.companyId??ac.id);if(!Number.isSafeInteger(cid)||cid<=0)continue;
    const at=Date.parse(v.receivedAt||0)||0;
    if(!best||at>best.at)best={cid,at};
  }
  return best?best.cid:0;
}
async function marketOrdersReadOnce(r,cur,background,lane=false){
  const laneKey=typeof lane==='string'&&lane?lane:`marketOrders:${r}`;
  const k=`scmMarketOrders:${r}`;
  let gate={},lastAt=0;
  // Clear Stored Data during this read: nothing it learns may be written afterwards (orders key, gate, error).
  const clearGen=extensionClearGeneration,cleared=()=>clearGen!==extensionClearGeneration;
  const cancelled={ok:false,skipped:true,cancelled:true,reason:'cleared'};
  const fail=async(rawError)=>{
    if(cleared())return cancelled;
    const error=capRefreshError(rawError);
    ownListingsRefreshError.set(r,{error,at:new Date().toISOString()});
    const failures=Math.min(MARKET_ORDERS_BACKOFF_MS.length,(Number(gate.failures)||0)+1);
    await marketOrdersGateSet(r,{lastAt:lastAt||Number(gate.lastAt)||0,failures,nextAt:Date.now()+MARKET_ORDERS_BACKOFF_MS[failures-1],error,at:new Date().toISOString()});
    logActivity(r,'market-orders','failure',{},error);notifyGameCardsKeyChanged(k);return {ok:false,error};
  };
  try{
    gate=(await marketOrdersGateGet(r))||{};
    const now=Date.now(),backoffAt=Number(gate.nextAt)||0,gapAt=(Number(gate.lastAt)||0)+MARKET_ORDERS_GAP_MS,waitUntil=Math.max(backoffAt,gapAt);
    if(waitUntil>now){
      const res=backoffAt>now?{ok:false,backoff:true,skipped:true,reason:'backoff',error:gate.error||null,nextAt:backoffAt}:{ok:true,throttled:true,skipped:true,reason:'gap',nextAt:waitUntil};
      if(background||lane)return res;
      const skip=await marketOrdersTabSkip(r,false);if(skip){logNotRead(r,'market-orders',otherRealmReason(skip,r));return {ok:false,skipped:true,reason:skip};}
      scheduleMarketOrdersTrailing(r,waitUntil);
      return {...res,trailingAt:waitUntil};
    }
    const skip=await marketOrdersTabSkip(r,background);if(skip){logNotRead(r,'market-orders',otherRealmReason(skip,r));return {ok:false,skipped:true,reason:skip};}
    // Company id of THIS realm: the realm store's authCompany when its realm is r (or not stated), else the id kept
    // in the small orders key from an earlier read. An authCompany that says another realm is never used.
    const st=await notifyRealmStore(r),ac=st?.authData?.authCompany;
    const acRealm=validRealmNumber(ac?.realmId??ac?.realm??st?.authData?.realmId??st?.authData?.realm);
    // The id goes into the request path: only a positive safe integer is used.
    const safeCid=v=>{const n=Number(v);return Number.isSafeInteger(n)&&n>0?n:0;};
    const storeCid=acRealm==null||acRealm===r?safeCid(ac?.companyId??ac?.id):0;
    // The realm's captured auth-data response (endpointData) carries the same company id when the stored authCompany is empty.
    const capturedCid=storeCid>0?0:capturedCompanyIdForRealm(st,r);
    const cid=storeCid>0?storeCid:(capturedCid>0?capturedCid:safeCid(cur?.companyId));
    // No company id yet (right after Clear data, before the game's auth-data is captured): no request, a "not read"
    // line, no backoff step; the next card / game-action call reads once the id exists.
    if(!(Number.isSafeInteger(cid)&&cid>0)){logNotRead(r,'market-orders','no-company-id');return {ok:false,skipped:true,reason:'no-company-id'};}
    if(cleared())return cancelled;
    // Not this job's lane slot: a "waiting" line before the gate is stamped (no request, no storage write but the line).
    if(lane){const pk=await gameLaneDecide(laneKey,{peek:true});if(!pk.take){logLaneWait(r,'market-orders',pk.nextAt);return {ok:false,skipped:true,laneWait:true,reason:'lane',nextAt:pk.nextAt};}}
    lastAt=Date.now();marketOrdersNetStart.set(r,lastAt);await marketOrdersGateSet(r,{...gate,lastAt});
    const x=await pageGet(`/api/v2/companies/${cid}/market-orders/`,r,null,'own-listings-card',{timeoutMs:SLOW_SERVER_PAGE_READ_TIMEOUT_MS,attempts:1,...(lane?{lane:laneKey}:{})});
    if(x?.laneWait){logLaneWait(r,'market-orders',x.nextAt);return {ok:false,skipped:true,laneWait:true,reason:'lane',nextAt:x.nextAt};}
    // The tab moved to the other realm meanwhile: a "not read" line (the gap still counts, no backoff step).
    if(x?.realmMismatch){logNotRead(r,'market-orders',x);return {ok:false,skipped:true,reason:'other-realm'};}
    if(!x?.ok||x.data==null)return await fail(x?.error||`HTTP ${x?.status||0}`);
    if(!Array.isArray(x.data)&&!(x.data&&typeof x.data==='object'&&['data','items','results','orders','marketOrders'].some(f=>Array.isArray(x.data[f]))))return await fail('not a list');
    const orders=helperArray(x.data,['data','items','results','orders','marketOrders']);
    if(cleared())return cancelled;
    await rawStorageSet({[k]:{companyId:cid,orders,at:new Date().toISOString()}});ownListingsRefreshError.delete(r);
    await marketOrdersGateSet(r,{lastAt});notifyGameCardsKeyChanged(k);if(typeof marketOrdersServed==='function')marketOrdersServed(r,lastAt);
    logActivity(r,'market-orders','success',{rows:orders.length});
    return {ok:true};
  }catch(e){
    // The game page unloaded mid-read (realm switch, reload): a "not read" line like other-realm (the gap counts, no backoff).
    if(pageMessageChannelClosed(e)){if(!cleared())logNotRead(r,'market-orders','page-closed');return {ok:false,skipped:true,reason:'page-closed'};}
    // No game tab / page bridge not ready or not connected: no request was made. A "not read" line (no backoff).
    if(pageBridgeUnavailable(e)){if(!cleared())logNotRead(r,'market-orders',e);return {ok:false,skipped:true,reason:'bridge-not-ready'};}
    return await fail(String(e?.message||e));
  }
}
// Your outgoing contracts read through the game tab into a small key scmOutgoingContracts:<realm>
// ({data,at}); the game-page card is told it changed by an SCM_CARD_KEY_CHANGED message, without touching the large
// realm store. A Manager pageGet is not captured by the page hook, so this never rewrites endpointData. No lock held.
const OUTGOING_CONTRACTS_REFRESH_GAP_MS=12000,OUTGOING_CONTRACTS_FRESH_MS=60000;
const outgoingContractsRefreshAt=new Map(); // realm → last page read (ms)
// opts.lane: the card poll (unattended): a shared-lane read (job 'contracts:<realm>', at most every 15 min).
async function refreshOutgoingContracts(realm,minGapMs=OUTGOING_CONTRACTS_REFRESH_GAP_MS,opts=null){
  const r=validRealmNumber(realm);if(r==null)return {ok:false};
  const now=Date.now(),prevAt=outgoingContractsRefreshAt.get(r)||0;if(now-prevAt<minGapMs)return {ok:true,throttled:true};
  const lane=opts?.lane?`contracts:${r}`:null;
  outgoingContractsRefreshAt.set(r,now);
  try{
    const x=await pageGet('/api/v3/contracts-outgoing/me/',r,null,'outgoing-contracts-card',{timeoutMs:SLOW_SERVER_PAGE_READ_TIMEOUT_MS,attempts:1,...(lane?{lane}:{})});
    if(x?.laneWait){if(outgoingContractsRefreshAt.get(r)===now)outgoingContractsRefreshAt.set(r,prevAt);logLaneWait(r,'outgoing-contracts',x.nextAt);return {ok:false,skipped:true,laneWait:true,nextAt:x.nextAt};}
    // Other realm / realm not shown yet: a "not read" line; a real failed read: a failure line.
    if(!x?.ok&&(x?.realmMismatch||x?.realmUnknown)){logNotRead(r,'outgoing-contracts',x);return {ok:false,error:x.error};}
    if(!x?.ok||x.data==null){const error=capRefreshError(x?.error||`HTTP ${x?.status||0}`);logActivity(r,'outgoing-contracts','failure',{},error);return {ok:false,error:x?.error||`HTTP ${x?.status||0}`};}
    // A 2xx whose body is not data (the game's HTML app shell for an unknown address) is never stored.
    if(endpointResponseRejected('/api/v3/contracts-outgoing/me/',x)){logActivity(r,'outgoing-contracts','failure',{},'The game answered with a page instead of data.');return {ok:false,error:'The game answered with a page instead of data.'};}
    await rawStorageSet({[`scmOutgoingContracts:${r}`]:{data:x.data,at:new Date().toISOString()}});notifyGameCardsKeyChanged(`scmOutgoingContracts:${r}`);
    return {ok:true};
  }catch(e){
    // No game tab / page bridge not ready / page unloaded: a "not read" line; anything else is a failure line.
    if(pageBridgeUnavailable(e)||pageMessageChannelClosed(e))logNotRead(r,'outgoing-contracts',e);
    else logActivity(r,'outgoing-contracts','failure',{},capRefreshError(e?.message||e));
    return {ok:false,error:String(e?.message||e)};
  }
}
// After the game confirms an action (list or cancel on the exchange, send or cancel a contract, …) both cards'
// sources are read again ~0.8 s later; a burst of actions collapses into one read.
const ownOrdersRefreshTimers=new Map(),ownOrdersRefreshFiredAt=new Map(),OWN_ORDERS_ACTION_MIN_GAP_MS=3000;
function scheduleOwnOrdersRefresh(realm,delayMs=800){
  const n=validRealmNumber(realm);if(n==null)return;
  clearTimeout(ownOrdersRefreshTimers.get(n));
  // A page reporting actions back to back gets one read per 3 s at most (the last one trails, so no change is missed).
  const wait=Math.max(delayMs,(ownOrdersRefreshFiredAt.get(n)||0)+OWN_ORDERS_ACTION_MIN_GAP_MS-Date.now());
  ownOrdersRefreshTimers.set(n,setTimeout(()=>{
    ownOrdersRefreshTimers.delete(n);ownOrdersRefreshFiredAt.set(n,Date.now());
    // Game reads after an action use the shared 5-min game slot (lane), like the card poll. A slot taken = "waiting" line.
    // Held back (slot taken, 15 s gap, backoff): ONE deferred retry when the slot frees (queueMarketOrdersRetry).
    refreshMarketOrders(n,0,{lane:true}).then(x=>{if(marketOrdersNeedsRetry(x))return queueMarketOrdersRetry(n,'action');}).catch(()=>{});
    refreshOutgoingContracts(n,0,{lane:true}).catch(()=>{});
  },wait));
}
// Buildings that make an abundance resource. The game constants (scmGameConstants, downloaded in the
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
    if(k.size)sources.push('game constants');for(const b of list)if(k.has(String(b?.kind)))ids.add(String(b.id));}catch{}
  // Constants missing or unreadable: the bundled list is the source (no warning when that fallback works).
  const bk=await bundledAbundanceKinds();if(!sources.length)sources.push(bk.size?'bundled list':'game constants missing');
  for(const b of list)if(bk.has(String(b?.kind)))ids.add(String(b.id));
  // Only a capture that holds abundance values marks its building kind: the game answers {abundance:{}} for a
  // building that has none (a Grocery store), which must not make every store of that kind an hourly read.
  const hasAbundance=e=>{const a=e?.data?.abundance;return Boolean(a&&typeof a==='object'&&Object.keys(a).length);};
  const ep=st?.endpointData||{},capturedKinds=new Set(list.filter(b=>hasAbundance(ep[`/api/v2/companies/buildings/${b?.id}/abundance/`])).map(b=>String(b?.kind)));
  for(const b of list)if(T?.isAbundanceResource?.(b?.busy?.resource?.kind)||capturedKinds.has(String(b?.kind)))ids.add(String(b.id));
  return {ids:[...ids],sources,buildings:list.length};
}
async function abundanceBuildingIds(st){return (await abundanceBuildingInfo(st)).ids;}
// One line in the Background updates monitor for work the Manager does (job history scmBackgroundJobs:<n>).
function logActivity(realm,job,outcome,details={},error=null,startedMs=Date.now(),trigger='manager'){
  const n=validRealmNumber(realm);if(n==null)return Promise.resolve();
  return recordBackgroundJobEvent(n,{job,trigger,outcome,startedAt:new Date(startedMs).toISOString(),finishedAt:new Date().toISOString(),durationMs:Date.now()-startedMs,details,error}).catch(()=>{});
}
// "not read" lines: the Manager wanted game data but could not get it (no game tab, page bridge not ready, page
// unloaded mid-read, tab in the other realm or its realm not shown yet, no company id
// yet). Not a failure: no backoff step, the data stays not fresh, the next cycle tries again. "waiting" lines: held for
// the shared 5-min game-request slot (planned pace). Plain-English reason for a pageGet answer, an Error or a reason code.
function notReadReason(v){
  if(v==null)return 'Not read: the game page did not answer';
  const code=typeof v==='string'?v:String(v?.reason||'');
  const msg=typeof v==='string'?'':String(v?.error??v?.message??'');
  if(/^Not read: /.test(msg))return msg;
  if(v?.realmMismatch||code==='other-realm'){const m=msg.match(/The game tab is in (.+?), not (.+?)\.?$/);return m?`Not read: the game tab is in ${m[1]}, not ${m[2]}`:'Not read: the game tab is in the other realm';}
  if(v?.realmUnknown||code==='realm-unknown')return 'Not read: the game tab has not shown its realm yet';
  if(code==='no-company-id')return 'Not read: no company id yet (open the game once)';
  if(code==='game-tab-not-active')return 'Not read: the game tab is not the active tab';
  if(v?.offline||code==='offline')return 'Not read: no network on this device (phone asleep or offline)';
  if(v?.tabHidden||code==='game-tab-hidden')return 'Not read: the game tab is in the background (open the game to read)';
  if(v?.pageClosed||code==='page-closed'||(typeof v!=='string'&&pageMessageChannelClosed(v))||/reloaded or closed|message channel closed|message port closed|Receiving end does not exist/i.test(msg))return 'Not read: the game page was reloaded or closed during the read';
  if(v?.noGameTab||code==='no-game-tab'||/Open Sim Companies and log in|No Sim Companies tab/i.test(msg))return 'Not read: no game tab is open';
  if(/page bridge is not connected/i.test(msg))return 'Not read: the game page was not connected (extension just restarted)';
  if(v?.bridgeNotReady||code==='bridge-not-ready'||/page bridge is not ready/i.test(msg))return 'Not read: the game page was not ready (page loading or extension just restarted)';
  return `Not read: ${msg||code||'the game page did not answer'}`.slice(0,200);
}
// True when a read made no request for one of the not-read reasons above (not a real failure).
function isNotReadAnswer(v){return Boolean(v&&(v.syncRunning||v.realmMismatch||v.realmUnknown||v.pageClosed||v.bridgeNotReady||v.noGameTab))||pageBridgeUnavailable(v)||(v instanceof Error&&pageMessageChannelClosed(v));}
function laneWaitClock(ms){const d=new Date(Number(ms)||0);return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;}
function laneWaitText(nextAt){return Number(nextAt)>0?`Waiting for the 5-min game slot (next at ${laneWaitClock(nextAt)})`:'Waiting for the 5-min game slot';}
// 'other-realm' from a local realm check (two realms: the tab is in the one that is not `realm`).
function otherRealmReason(code,realm){const n=validRealmNumber(realm);return code==='other-realm'&&n!=null?{reason:code,realmMismatch:true,error:`The game tab is in ${realmDisplayNumber(n===0?1:0)}, not ${realmDisplayNumber(n)}.`}:code;}
function logNotRead(realm,job,v,details={},startedMs=Date.now(),trigger='manager'){return logActivity(realm,job,'not-read',details,notReadReason(v),startedMs,trigger);}
function logLaneWait(realm,job,nextAt,details={},startedMs=Date.now(),trigger='manager'){
  if(typeof gameRefusalActive==='function'&&gameRefusalActive())return logActivity(realm,job,GAME_REFUSAL_COVERED_JOBS.has(job)?'skipped':'not-read',{...details,refused:true,nextAt:Number(gameRefusalMem.until)},gameRefusalText(gameRefusalMem.until),startedMs,trigger);
  return logActivity(realm,job,'waiting',{...details,laneWait:true,...(Number(nextAt)>0?{nextAt:Number(nextAt)}:{})},laneWaitText(nextAt),startedMs,trigger);}
// Anti-spam for not-read / waiting lines only: the same realm + job + outcome + error at most once per 60 s; the next
// line written for it carries details.repeats (how many were held back since). Memory only (a worker restart may lose
// the count). Success / failure lines are never held back. "No game tab is open" uses 30 min (ACTIVITY_REPEAT_NO_TAB_MS):
// with no game tab the order-book and ticker alarms would otherwise write it every 5 min and fill the 300-line history.
const ACTIVITY_REPEAT_MS=60000,ACTIVITY_REPEAT_NO_TAB_MS=30*60000,activityRepeatMem=new Map();
// The security-check pause line names its next try (the same for one pause): one line per job per pause, not one a minute.
const ACTIVITY_REFUSAL_RE=/security check \(Cloudflare\) refuses/i;
function activityRepeatWindow(err){const t=String(err||'');if(ACTIVITY_REFUSAL_RE.test(t))return 60*60000;return /no game tab is open|switched off \(Background timers\)/i.test(t)?ACTIVITY_REPEAT_NO_TAB_MS:ACTIVITY_REPEAT_MS;}
function activityRepeatCheck(n,event,now=Date.now()){
  const refusedSkip=event.outcome==='skipped'&&ACTIVITY_REFUSAL_RE.test(String(event.error||''));
  if(event.outcome!=='not-read'&&event.outcome!=='waiting'&&!refusedSkip)return {log:true,repeats:0};
  // A waiting line's slot time changes each time; the repeat key ignores it.
  const err=String(event.error||'').replace(/ \(next at \d\d:\d\d\)$/,'');
  const k=`${n}|${event.job}|${event.outcome}|${err}`,cur=activityRepeatMem.get(k);
  const windowMs=activityRepeatWindow(err);
  if(cur&&now-cur.at<windowMs){cur.held++;return {log:false};}
  activityRepeatMem.set(k,{at:now,held:0,windowMs});
  if(activityRepeatMem.size>200){for(const [kk,vv] of activityRepeatMem)if(now-vv.at>=(Number(vv.windowMs)||ACTIVITY_REPEAT_MS)&&kk!==k)activityRepeatMem.delete(kk);}
  return {log:true,repeats:cur?cur.held:0};
}
// Quiet not-read lines of unattended reads (game tab in the background / not the active tab, no network on the
// device, SimcoTools with no connection): ONE line per realm + job per stretch, not one every 5 min. The stretch
// lasts until that job writes any other line (a success, a failure, another reason); then the next quiet line is
// written again. Kept in storage.session (scmActivityQuietStretch) because the 5-min alarms wake a new service worker
// each time; memory fallback. Real failures (a visible, online "Failed to fetch", HTTP errors) are never held back.
const ACTIVITY_QUIET_RX=/^Not read: (?:the game tab is in the background|the game tab is not the active tab|no network on this device|no network connection)/;
const ACTIVITY_STRETCH_KEY='scmActivityQuietStretch';let activityStretchMem=null,activityStretchTail=Promise.resolve();
function activityStretchCheck(n,event,now=Date.now()){
  const run=activityStretchTail.then(async()=>{
    if(activityStretchMem==null){let v=null;try{if(chrome.storage?.session)v=(await chrome.storage.session.get(ACTIVITY_STRETCH_KEY))?.[ACTIVITY_STRETCH_KEY];}catch{}if(activityStretchMem==null)activityStretchMem=v&&typeof v==='object'&&!Array.isArray(v)?v:{};}
    const k=`${n}|${String(event.job||'unknown')}`,err=String(event.error||''),cur=activityStretchMem[k];
    const save=async()=>{try{if(chrome.storage?.session)await chrome.storage.session.set({[ACTIVITY_STRETCH_KEY]:activityStretchMem});}catch{}};
    if(event.outcome==='not-read'&&ACTIVITY_QUIET_RX.test(err)){
      if(cur&&cur.err===err){cur.held=(Number(cur.held)||0)+1;cur.lastAt=now;await save();return {log:false};}
      const prevEnded=cur&&Number(cur.held)>0?{held:Number(cur.held)||0,since:cur.at,err:cur.err}:null;
      activityStretchMem[k]={err,at:now,lastAt:now,held:0};
      const keys=Object.keys(activityStretchMem);if(keys.length>100)for(const kk of keys.sort((a,b)=>(activityStretchMem[a].lastAt||0)-(activityStretchMem[b].lastAt||0)).slice(0,keys.length-100))delete activityStretchMem[kk];
      await save();return {log:true,stretch:true,...(prevEnded?{ended:prevEnded}:{})};
    }
    // 'running' marks are not an end of the stretch.
    if(cur&&event.outcome!=='running'){delete activityStretchMem[k];await save();return {log:true,ended:{held:Number(cur.held)||0,since:cur.at,err:cur.err}};}
    return {log:true};
  });
  activityStretchTail=run.catch(()=>{});
  return run.catch(()=>({log:true}));
}
function activityStretchClear(){const run=activityStretchTail.then(async()=>{activityStretchMem={};try{await chrome.storage.session?.remove(ACTIVITY_STRETCH_KEY);}catch{}});activityStretchTail=run.catch(()=>{});return run;}
// "· 7 similar lines held back while the phone slept": added (details.what, shown by the monitor; details.heldBack = the
// count) to the first line after a quiet stretch that held lines back.
function activityHeldBackNote(ended){const n=Number(ended?.held)||0;if(n<=0)return null;
  const why=/no network/i.test(String(ended?.err||''))?'while the phone slept or was offline':'while the game tab was in the background';
  return `${n} similar line${n===1?'':'s'} held back ${why}`;}
async function activeRealmNumber(){try{const r=await chrome.storage.local.get({activeRealmKey:null});return validRealmNumber(realmNumberFromKey(r.activeRealmKey));}catch{return null;}}
// "Game data saved" lines in the monitor: one per kind of data, at most once a minute each.
const GAME_CAPTURE_FAMILIES=[[/\/companies\/me\/buildings\/?$/,'Buildings'],[/\/resources\/\d+\/?$/,'Warehouse'],[/\/contracts-(?:incoming|outgoing)/,'Contracts'],[/\/abundance\/?$/,'Abundance'],[/\/cashflow\/recent/,'Cash flow (sales)'],[/\/market\/\d+\/\d+\/?$/,'Exchange order book'],[/\/buildings\/\d+\/history/,'Building history'],[/\/government-orders/,'Government orders'],[/\/(?:balance-sheet|income-statement|cashflow-statement|past-finances)/,'Accounting'],[/\/executives\/?$/,'Executives']];
const gameCaptureLogAt=new Map();
function logGameCapture(realm,url){
  const path=String(url||'').split('?')[0];const f=GAME_CAPTURE_FAMILIES.find(([rx])=>rx.test(path));if(!f)return;
  const k=`${realm}|${f[1]}`;if(Date.now()-(gameCaptureLogAt.get(k)||0)<60000)return;gameCaptureLogAt.set(k,Date.now());
  logActivity(realm,'game-data-saved','success',{what:f[1]},null,Date.now(),'game');
}
// Abundance without a Sync or opening the mine: whenever the game's buildings list is captured, fetch
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
  if(await scmSwitchedOff('abundanceOnLoad','abundance-refresh',r,trigger))return {ok:true,skipped:true,switchedOff:true};
  abundanceAutoState.set(r,{running:true,at:Date.now()});
  const saved=[],errors=[],t0=Date.now();
  let bridgeSkip=false;
  try{
    const st=await notifyRealmStore(r);const info=await abundanceBuildingInfo(st);
    const ids=staleAbundanceIds(info.ids,st?.endpointData||{});
    if(!info.ids.length){logActivity(r,'abundance-refresh','skipped',{buildings:info.buildings,sources:info.sources.join(', ')},'No mine, oil rig or quarry found in your buildings',t0,trigger);return {ok:true,saved,wanted:0};}
    if(!ids.length){logActivity(r,'abundance-refresh','skipped',{mines:info.ids.length},'all fresh (under 1 h)',t0,trigger);return {ok:true,saved,wanted:0};}
    // No game tab / page bridge not ready or not connected, or the shared game lane slot
    // is taken: no request was made, and the rest would meet the same, so the loop stops there. Those buildings are
    // not failures (notRead) and stay stale for the next run. Unattended: one lane read (job 'abundance:<realm>') per slot.
    let notRead=0,why=null;
    for(let i=0;i<ids.length;i++){const id=ids[i];const p=`/api/v2/companies/buildings/${id}/abundance/`;try{const x=await readFollowingMoves(p,r,{captured:st?.endpointData||null,lane:`abundance:${r}`});if(x?.laneWait){notRead+=ids.length-i;why=x;break;}if(x?.realmMismatch||x?.realmUnknown||x?.laneWait||x?.queued||x?.syncRunning){notRead++;why=why||x;continue;}if(x?.ok){await saveData(p,x.data,x.status,'GET',r);saved.push(id);}else errors.push(`#${id}: ${x?.error||'HTTP '+(x?.status||0)}`);}catch(e){if(pageBridgeUnavailable(e)){notRead+=ids.length-i;why=e;break;}errors.push(`#${id}: ${e?.message||e}`);}}
    // Nothing read and no real failure: a "waiting" (lane slot) or "not read" line, and the 5 min gap does not count.
    if(notRead&&!saved.length&&!errors.length){bridgeSkip=true;
      if(why?.laneWait)logLaneWait(r,'abundance-refresh',why.nextAt,{wanted:ids.length},t0,trigger);
      else logNotRead(r,'abundance-refresh',why,{wanted:ids.length,notRead},t0,trigger);
      return {ok:true,skipped:true,bridgeUnavailable:true,saved,wanted:ids.length,notRead};}
    const tried=ids.length-notRead;
    logActivity(r,'abundance-refresh',saved.length===tried?'success':saved.length?'partial':'failure',{rows:saved.length,wanted:ids.length,...(notRead?{notRead,notReadReason:why?.laneWait?laneWaitText(why.nextAt):notReadReason(why)}:{}),sources:info.sources.join(', ')},errors.join(' · ')||null,t0,trigger);
    return {ok:true,saved,wanted:ids.length,...(notRead?{notRead}:{})};
  }finally{abundanceAutoState.set(r,{running:false,at:bridgeSkip?(cur.at||0):Date.now()});}
}
// movedReads: {fixed path: same address under another API version}, found by this Sync's walk. Read from there, stored
// under the fixed path every reader uses. Renames are never in it, and a read that is not data is not saved.
function extraReadPath(path,movedReads){const m=movedReads?.[path];return typeof m==='string'&&/^\/api\/v\d+\//.test(m)&&m.replace(/^\/api\/v\d+/,'')===path.replace(/^\/api\/v\d+/,'')?m:path;}
// One read that follows a version-only move: one this Sync's walk found, or the same address under another version in
// captured traffic. Anything else that only looks alike is reported, never read. A sibling building's abundance is not a candidate.
// lane: the shared game-lane job of an unattended caller (abundance refresh); after Sync there is none.
async function readFollowingMoves(path,realm,{movedReads=null,captured=null,lane=null}={}){
  const from=extraReadPath(path,movedReads);
  const x=await pageGet(from,realm,null,null,lane?{lane,timeoutMs:SLOW_SERVER_PAGE_READ_TIMEOUT_MS}:null);
  if(x?.ok&&endpointDataIsValid(path,x.data))return {ok:true,data:x.data,status:x.status,walkedPath:from!==path?from:null};
  const status=Number(x?.status)||0,failed={ok:false,status,error:x?.error||`HTTP ${status}`};
  // No request (lane slot taken): no move to look for; the caller logs a waiting / not-read line.
  if(x?.laneWait)return {...failed,laneWait:true,nextAt:Number(x.nextAt)||0};
  
  if(x?.realmMismatch||x?.realmUnknown)return {...failed,...(x.realmMismatch?{realmMismatch:true}:{realmUnknown:true})};
  if(!endpointFailureSuggestsMove(x,path))return failed;
  const pool={};
  for(const [k,v] of Object.entries(captured||{})){const b=String(k).replace(/^https?:\/\/[^/]+/,'');if(b===path||!/\/buildings\/\d+\/abundance\//.test(b)||b.replace(/^\/api\/v\d+/,'')===path.replace(/^\/api\/v\d+/,''))pool[k]=v;}
  const found=findMovedEndpoint(path,pool,[],0);
  if(found?.suspected)return {...failed,suspected:found.suspected};
  const to=found?String(found).replace(/^https?:\/\/[^/]+/,''):null;
  if(!to||extraReadPath(path,{[path]:to})===path||to===from)return failed;
  const y=await pageGet(to,realm,null,null,lane?{lane,timeoutMs:SLOW_SERVER_PAGE_READ_TIMEOUT_MS}:null);
  if(y?.laneWait)return {...failed,laneWait:true,nextAt:Number(y.nextAt)||0};
  return y?.ok&&endpointDataIsValid(path,y.data)?{ok:true,data:y.data,status:y.status,walkedPath:to}:failed;
}
// Logged-in extras through the game tab after Sync: research, government orders + your tier, and the
// abundance of every building whose abundance the game has shown (mines etc.). Each pageGet runs without a lock;
// saveData takes its own lock per response.
async function refreshExtraGameData(realm,{movedReads=null,captured=null}={}){
  const r=validRealmNumber(realm);if(r==null)return {ok:false};
  const st=await notifyRealmStore(r);const ep=st?.endpointData||{};
  const ab=new Set(Object.keys(ep).map(k=>(k.match(/^\/api\/v2\/companies\/buildings\/(\d+)\/abundance\/$/)||[])[1]).filter(Boolean));
  const kinds=new Set((Array.isArray(st?.buildings)?st.buildings:[]).filter(b=>ab.has(String(b?.id))).map(b=>String(b?.kind)));
  for(const b of (Array.isArray(st?.buildings)?st.buildings:[]))if(kinds.has(String(b?.kind)))ab.add(String(b.id));
  // Also every building that makes an abundance resource (mines, oil rigs, quarries: constants producedAt),
  // even when its abundance was never captured or the record was lost.
  for(const id of await abundanceBuildingIds(st))ab.add(id);
  // Government orders are never read from the game (2.5.466): the list comes from SimcoTools only; the tier is optional,
  // saved from passive capture when the game loads it.
  const paths=['/api/v3/players/research/',...[...ab].map(id=>`/api/v2/companies/buildings/${id}/abundance/`)];
  const out=[],errs=[],warnings=[],t0=Date.now();
  const pool={...ep,...(captured||{})};
  // No game tab / page bridge not ready or not connected: no request was made and the
  // rest would meet the same, so the loop stops; those reads are not failures (notRead), and nothing read with no real
  // failure logs a "not read" line with the reason.
  let notRead=0,why=null;
  for(let i=0;i<paths.length;i++){const p=paths[i];try{const x=await readFollowingMoves(p,r,{movedReads,captured:pool});if(x?.realmMismatch||x?.realmUnknown||x?.laneWait||x?.queued||x?.syncRunning){notRead++;why=why||x;continue;}if(x.ok&&x.walkedPath)warnings.push(`${p} moved to ${x.walkedPath}`);if(!x.ok){const ab=/\/abundance\/$/.test(p);if(x.suspected)warnings.push(`${p} (HTTP ${x.status}) may have moved to ${x.suspected}; not adopted`);else if(ab)warnings.push(`${p} failed (HTTP ${x.status}); kept the stored record`);}if(x.ok){await saveData(p,x.data,x.status,'GET',r);out.push(p);}else errs.push(`${p.replace('/api/','')}: ${x?.error||'HTTP '+(x?.status||0)}`);}catch(e){if(pageBridgeUnavailable(e)){notRead+=paths.length-i;why=e;break;}errs.push(`${p.replace('/api/','')}: ${e?.message||e}`);if(/\/abundance\/$/.test(p))warnings.push(`${p} not read: ${e?.message||e}`);}}
  if(notRead&&!out.length&&!errs.length){logNotRead(r,'extra-game-data',why,{wanted:paths.length,notRead},t0,'after-sync');return {ok:true,skipped:true,bridgeUnavailable:true,saved:out,warnings,notRead};}
  const abN=paths.filter(p=>/abundance/.test(p)).length,abOk=out.filter(p=>/abundance/.test(p)).length;
  logActivity(r,'extra-game-data',errs.length?(out.length?'partial':'failure'):'success',{rows:out.length,wanted:paths.length,abundance:`${abOk}/${abN}`,...(notRead?{notRead,notReadReason:notReadReason(why)}:{})},errs.slice(0,4).join(' · ')||null,t0,'after-sync');
  return {ok:true,saved:out,warnings,...(notRead?{notRead}:{})};
}
// Sync timers (gameConstants): off = no alarm and no read on worker start (Sync still reads them); a slower
// interval also raises the age below which the stored constants count as fresh.
function gameConstantsMaxAge(e){const C=globalThis.SCM_TIMERS_CORE;return e&&C&&!C.isDefault('gameConstants',{...e,enabled:true})?Math.max(GAME_CONSTANTS_PERIOD_MS,C.intervalMs('gameConstants',e)-60000):GAME_CONSTANTS_PERIOD_MS;}
chrome.alarms.onAlarm.addListener(a=>{if(a?.name!==GAME_CONSTANTS_ALARM)return;(async()=>{const e=await scmTimerEntry('gameConstants');if(e&&!e.enabled){await chrome.alarms.clear(GAME_CONSTANTS_ALARM);return;}await refreshGameConstants(false,gameConstantsMaxAge(e),{quietNoTab:true});})().catch(()=>{});});
// Only created when missing or its period changed: re-creating it on every service-worker start (delay 1 min)
// re-armed it each time and, with stale constants, retried the read about every minute.
// Timer off: the stored constants count as fresh whatever their age, so only completely missing constants are read.
// Timer off (2.5.458): no read at all on worker start (a fresh install starts with it off); Sync still reads them.
async function ensureGameConstantsAlarm(){try{await scmEnsureTimerAlarm('gameConstants',{delayInMinutes:1,periodInMinutes:360},'period');}catch{}const e=await scmTimerEntry('gameConstants').catch(()=>null);
  // Off: no game read, but the built-in copy (constants.json, no network) still fills missing constants at once.
  if(e&&!e.enabled){await applyBundledGameConstants().catch(()=>{});return;}refreshGameConstants(false,gameConstantsMaxAge(e),{quietNoTab:true}).catch(()=>{});}
ensureGameConstantsAlarm();
// Data the Manager cannot work without: game constants (scmGameConstants) and resource images (scmResourceImages).
// Triggers: a finished Sync (afterSync: constants by age as before, backoff ignored since the Sync proved the bridge
// works; images when the cache is empty or the last clean run is over 6.5 days old, i.e. failures since), a game tab
// reporting its state (GAME_STATE, onlyMissing), a realm switch (SET_VIEW_REALM) and the dashboard (SCM_ENSURE_GAME_DATA).
// Sync timers off (Settings) = no scheduled runs, but a store that is completely missing is still filled.
// Non-Sync triggers run at most once per 2 min, counted from a run that reached the game tab (a constants backoff
// or a page that unloaded mid-read counts; no tab / bridge not ready before any request does not).
// Page-originated triggers (onlyMissing: GAME_STATE from the page bridge) also start their own 2-min gap when they
// start, whatever the outcome, so a page cannot fire more than one fill per gap. SCM_ENSURE_GAME_DATA is accepted
// from extension pages only (SCM_PRIVILEGED_MESSAGE_TYPES).
// Once both are seen present, onlyMissing calls (every game-state report) return at once for this worker's life.
// The gap stamps (gameDataFill, gameDataPageFill) are mirrored to chrome.storage.session (scmGateStamps), so a
// service-worker restart does not reopen a gap; memory is the fallback and the larger of the two wins.
const GAME_DATA_FILL_GAP_MS=2*60000;let gameDataFillAt=0,gameDataPageFillAt=0,gameDataFillRun=null,gameDataPresent=false,gameDataFillGateChecks=new Map();
function fillMissingGameData(reason='manager',{afterSync=false,onlyMissing=false}={}){
  if(onlyMissing&&gameDataPresent)return Promise.resolve({ok:true,skipped:true,reason:'present'});
  if(gameDataFillRun)return gameDataFillRun;
  const start=()=>{gameDataFillRun=fillMissingGameDataOnce(reason,afterSync,onlyMissing).finally(()=>{gameDataFillRun=null;});return gameDataFillRun;};
  if(afterSync)return start();
  // One gate check at a time per kind (page-originated / manager); callers meanwhile share its answer.
  const mode=onlyMissing?'page':'manager',pending=gameDataFillGateChecks.get(mode);
  if(pending)return pending;
  const check=(async()=>{
    const [fillAt,pageAt]=await Promise.all([scmGateStampGet('gameDataFill'),scmGateStampGet('gameDataPageFill')]);
    gameDataFillAt=Math.max(gameDataFillAt,Number(fillAt)||0);gameDataPageFillAt=Math.max(gameDataPageFillAt,Number(pageAt)||0);
    if(gameDataFillRun)return gameDataFillRun;
    const now=Date.now();
    if(now-gameDataFillAt<GAME_DATA_FILL_GAP_MS)return {ok:true,skipped:true,reason:'recent'};
    if(onlyMissing){if(now-gameDataPageFillAt<GAME_DATA_FILL_GAP_MS)return {ok:true,skipped:true,reason:'recent'};gameDataPageFillAt=now;scmGateStampSet('gameDataPageFill',now);}
    return start();
  })().finally(()=>{if(gameDataFillGateChecks.get(mode)===check)gameDataFillGateChecks.delete(mode);});
  gameDataFillGateChecks.set(mode,check);
  return check;
}
async function fillMissingGameDataOnce(reason,afterSync,onlyMissing){
  const out={ok:true};
  const r=await chrome.storage.local.get({scmGameConstants:null,scmResourceImagesValidatedAt:0});
  const cEntry=await scmTimerEntry('gameConstants').catch(()=>null);
  // Not after a Sync (a game tab is up): no "no game tab" line (dashboard open, realm switch, a game page right after an
  // update); the built-in copy already applies and the read runs on the next GAME_STATE (quietNoTab flag).
  if(!r.scmGameConstants&&(afterSync||!cEntry||cEntry.enabled))out.constants=await refreshGameConstants(false,GAME_CONSTANTS_PERIOD_MS,{ignoreBackoff:afterSync,afterSync,quietNoTab:!afterSync});
  else if(afterSync)out.constants=await refreshGameConstants(false,gameConstantsMaxAge(cEntry),{ignoreBackoff:true,afterSync:true});
  // Timer off and constants missing: no game read, but the built-in copy (no network) still fills them.
  else if(!r.scmGameConstants&&cEntry&&!cEntry.enabled){try{const b=await applyBundledGameConstants();if(b?.applied)out.constants={ok:true,bundled:true,source:'bundled'};}catch{}}
  let cached=0;try{cached=Object.keys((await resourceImagesStore())?.cache||{}).length;}catch{}
  const imagesOn=await scmTimerEnabled('resourceImages').catch(()=>true);
  const imagesDue=Date.now()-(Number(r.scmResourceImagesValidatedAt)||0)>RESOURCE_IMAGE_VALIDATE_EVERY_MS;
  // resourceImages off (2.5.458): no image download at all, also with an empty cache (the dashboard shows a placeholder).
  // Never during a Sync (after-Sync waits for it to end) and never on dashboard open while other Manager reads run.
  if(imagesOn&&(cached===0||(!onlyMissing&&imagesDue))){
    if(coreSyncActive()){out.imagesDeferred='sync';deferUntilSyncEnds('resource-images',()=>{syncAllResourceImages({forceValidate:false,trigger:reason}).catch(()=>{});});}
    else if(reason==='dashboard-open'&&managerReadsInFlight>0)out.imagesDeferred='other-reads';
    else{out.images=true;syncAllResourceImages({forceValidate:false,trigger:reason}).catch(()=>{});}
  }else if(!imagesOn&&(cached===0||(!onlyMissing&&imagesDue)))scmSwitchedOff('resourceImages','resource-images',null,reason).catch(()=>{});
  const c=out.constants;if(!c||!c.skipped||c.reachedTab){gameDataFillAt=Date.now();scmGateStampSet('gameDataFill',gameDataFillAt);}
  let present=Boolean(r.scmGameConstants);if(!present&&out.constants){try{present=Boolean((await chrome.storage.local.get({scmGameConstants:null})).scmGameConstants);}catch{}}
  gameDataPresent=present&&cached>0;
  return out;
}
// Economy phase log per realm (scmEconomyStateLog:<realm>) from auth-data temporals.economyState.
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
    // Phase changed since the last observation → notification (setting "economyChange").
    if(last&&Number.isFinite(Number(last.s))&&Number(last.s)!==st&&next.length&&Number(next[next.length-1].s)===st){
      try{const cfg=await notifySettings();if(cfg.economyChange){const gc=(await chrome.storage.local.get({scmGameConstants:null})).scmGameConstants;const store=await notifyRealmStore(r);const msg=globalThis.SCM_NOTIFY_CORE.economyChanged({from:Number(last.s),to:st,realm:r,constants:gc,buildings:store?.buildings});await scmNotify(`economy-${r}-${Date.now()}`,msg.title,msg.message);}}catch(e){console.debug('economy notification failed',e);}
    }
  }).catch(()=>{});
  return economyLogChain;
}
// Resource images (base64 data URLs, ~2.3 MB) live in their own key, not the realm store, so state() reads and
// realm writes do not serialize them; only the code that draws images reads them. Any realm write that still
// carries image fields is routed here and merged (image writes are additive).
const RESOURCE_IMAGES_KEY='scmResourceImages';
// Resource / building ids from messages: integers only, bounded (numbers or digit strings).
function validResourceId(v){const n=typeof v==='string'&&/^\d{1,6}$/.test(v)?Number(v):v;return Number.isInteger(n)&&n>0&&n<100000?n:null;}
function validQuality(v){const n=typeof v==='string'&&/^\d{1,2}$/.test(v)?Number(v):v;return Number.isInteger(n)&&n>=0&&n<=20?n:null;}
function validBuildingId(v){const n=typeof v==='string'&&/^\d{1,13}$/.test(v)?Number(v):v;return Number.isSafeInteger(n)&&n>0?n:null;}
// Stored images: only a valid resource id with a raster data URL up to 1 MB (resourceImageDataUrlParts) is kept.
// The meta of a dropped image is dropped too, so the image counts as missing and is fetched again.
function cleanResourceImageEntries(cache,meta){
  const c={},m={},bad=new Set();let dropped=0;
  for(const [k,v] of Object.entries(cache&&typeof cache==='object'?cache:{})){const id=validResourceId(k);if(id!=null&&resourceImageDataUrlParts(v))c[String(id)]=v;else{dropped++;bad.add(String(k));}}
  for(const [k,v] of Object.entries(meta&&typeof meta==='object'?meta:{})){const id=validResourceId(k);if(id==null||!v||typeof v!=='object'||bad.has(String(k))){dropped++;continue;}m[String(id)]=v;}
  return {cache:c,meta:m,dropped};
}
const RESOURCE_IMAGE_FIELDS=['resourceImageCache','resourceImageData','resourceImageMeta'];
let resourceImagesMemo=null;
async function resourceImagesStore(){
  if(resourceImagesMemo)return resourceImagesMemo;
  const raw=(await chrome.storage.local.get({[RESOURCE_IMAGES_KEY]:null}))[RESOURCE_IMAGES_KEY];
  const clean=cleanResourceImageEntries(raw?.cache,raw?.meta);
  resourceImagesMemo={cache:clean.cache,meta:clean.meta};
  return resourceImagesMemo;
}
globalThis.__scmOwnWriteHooks?.push(items=>{if(Object.prototype.hasOwnProperty.call(items,RESOURCE_IMAGES_KEY)){const v=items[RESOURCE_IMAGES_KEY];resourceImagesMemo=v&&typeof v==='object'?{cache:{...(v.cache||{})},meta:{...(v.meta||{})}}:null;}});
async function routeResourceImagesOut(out){
  if(!out||typeof out!=='object')return out;
  let cache=null,meta=null;
  const bad=new Set();
  const take=(f,v)=>{if(!v||typeof v!=='object')return;if(f==='resourceImageMeta')meta={...(meta||{}),...cleanResourceImageEntries({},v).meta};else{const x=cleanResourceImageEntries(v,{}).cache;for(const k of Object.keys(v))if(!x[k])bad.add(String(k));cache={...(cache||{}),...x};}};
  for(const k of Object.keys(out)){
    if(!/^scmRealmStore:\d+$/.test(k))continue;
    const v=out[k];if(!v||typeof v!=='object')continue;
    if(!RESOURCE_IMAGE_FIELDS.some(f=>Object.prototype.hasOwnProperty.call(v,f)))continue;
    const clean={...v};for(const f of RESOURCE_IMAGE_FIELDS){take(f,clean[f]);delete clean[f];}out[k]=clean;
  }
  for(const f of RESOURCE_IMAGE_FIELDS){if(Object.prototype.hasOwnProperty.call(out,f)){take(f,out[f]);delete out[f];}}
  // the meta of an image that failed the check is not kept (the image is fetched again)
  if(meta)for(const k of bad)if(!cache?.[k])delete meta[k];
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
    // Root-level legacy copies (pre-realm-store versions) are moved too, then removed.
    const root=await chrome.storage.local.get(Object.fromEntries(RESOURCE_IMAGE_FIELDS.map(f=>[f,null])));
    const rootFields=RESOURCE_IMAGE_FIELDS.filter(f=>root[f]&&typeof root[f]==='object');
    for(const f of rootFields)out[f]=root[f];
    // Stored images that fail the image check (type, size, id) are dropped with their meta, so they are fetched again.
    const imgRaw=(await chrome.storage.local.get({[RESOURCE_IMAGES_KEY]:null}))[RESOURCE_IMAGES_KEY];
    const clean=cleanResourceImageEntries(imgRaw?.cache,imgRaw?.meta);
    if(imgRaw&&clean.dropped){const next={cache:clean.cache,meta:clean.meta,updatedAt:new Date().toISOString()};await rawStorageSet({[RESOURCE_IMAGES_KEY]:next});resourceImagesMemo={cache:next.cache,meta:next.meta};}
    if(!Object.keys(out).length)return {moved:false,dropped:clean.dropped};
    await rawStorageSet(await routeResourceImagesOut(out));
    if(rootFields.length)await chrome.storage.local.remove(rootFields);
    return {moved:true,stores:Object.keys(out).filter(k=>!RESOURCE_IMAGE_FIELDS.includes(k)),rootFields,dropped:clean.dropped};
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
// Realm patches are coalesced so captured API responses do not each rewrite the whole scmRealmStore:N (~800 KB)
// during Sync. storageSetRealmPatch merges patches (in order, shallow, same semantics as {...current,...patch}) into a
// per-realm buffer and writes at most once per REALM_PATCH_COALESCE_MS. In-worker readers stay exact:
// readPhysicalRealmStore/stateAllRealms overlay the in-flight + pending patch, and any whole-store write of
// that realm through storageSetUnlocked (which was built from such a read) absorbs and drops the buffer.
// flushRealmPatches() runs in the global commit lane; never await it from inside a withRealmStorageCommit task.
const REALM_PATCH_COALESCE_MS=750;
const pendingRealmPatches=new Map();   // realm -> {patch,timer}
const inflightRealmPatches=new Map();  // realm -> patch being written by a flush
// Lost-update guard. Realm-lane jobs read the store, then write the whole store back through the global lane. A write
// made in the global lane between those two steps (Sync's final status, a quarantine entry) would be overwritten by
// the stale copy, and a coalesced patch buffered in that gap would be dropped by it. Such writes stay here, overlaid on
// every read, until a job queued behind the realm lane confirms them. Nothing ever awaits that job, so a lane job
// calling these writers cannot deadlock on itself; a stuck lane costs a held overlay, never a blocked write.
const crossLaneRealmPatches=new Map(); // realm -> patch that must survive whole-store writes
function realmPatchOverlay(realm){
  const n=validRealmNumber(realm); if(n==null)return null;
  const inflight=inflightRealmPatches.get(n),pending=pendingRealmPatches.get(n)?.patch,cross=crossLaneRealmPatches.get(n);
  if(!inflight&&!pending&&!cross)return null;
  return {...(inflight||{}),...(pending||{}),...(cross||{})};
}
function holdCrossLaneRealmPatch(realm,patch){
  const n=validRealmNumber(realm); if(n==null)return;
  crossLaneRealmPatches.set(n,{...(crossLaneRealmPatches.get(n)||{}),...patch});
  scheduleCrossLaneConfirm(n);
}
const crossLaneConfirmQueued=new Set();
function scheduleCrossLaneConfirm(n){
  if(crossLaneConfirmQueued.has(n))return;
  crossLaneConfirmQueued.add(n);
  // Deliberately not awaited, and queued only behind the realm's lane: everything that could hold a stale read is ahead of it.
  enqueueApiStorageCommit(()=>withRealmStorageCommit(async()=>{
    crossLaneConfirmQueued.delete(n);
    const held=crossLaneRealmPatches.get(n); if(!held)return;
    const current=await state(n); // overlays the held patch
    await storageSetUnlocked({realmStores:{[realmKeyFromRealm(n)]:current}},{keepPendingRealmPatches:true});
    // Later fields added while writing stay held for the next pass.
    if(crossLaneRealmPatches.get(n)===held)crossLaneRealmPatches.delete(n);
    else scheduleCrossLaneConfirm(n);
  }),n).catch(()=>{crossLaneConfirmQueued.delete(n);});
}
// Eviction safety: pending (unflushed) realm patches are mirrored to chrome.storage.session so a service-worker
// eviction inside the coalesce window does not lose them; they are re-buffered and flushed on next wake.
const SCM_PENDING_PATCH_SESSION_KEY='scmPendingRealmPatchesV1';
const SCM_PENDING_PATCH_MIRROR_MAX_CHARS=4000000;
let scmPendingPatchMirrorTimer=null;
let scmPendingPatchMirrorLast=null; // last mirrored JSON ('' = known removed, null = unknown)
function scmMirrorPendingPatches(immediate=false){
  if(!chrome.storage?.session)return;
  if(scmPendingPatchMirrorTimer){clearTimeout(scmPendingPatchMirrorTimer);scmPendingPatchMirrorTimer=null;}
  const run=()=>{scmPendingPatchMirrorTimer=null;try{
    const out={};for(const n of new Set([...pendingRealmPatches.keys(),...inflightRealmPatches.keys()])){const p={...(inflightRealmPatches.get(n)||{}),...(pendingRealmPatches.get(n)?.patch||{})};if(Object.keys(p).length)out[n]=p;}
    if(!Object.keys(out).length){if(scmPendingPatchMirrorLast!==''){scmPendingPatchMirrorLast='';chrome.storage.session.remove(SCM_PENDING_PATCH_SESSION_KEY).catch(()=>{});}return;}
    const json=JSON.stringify(out);
    // Unchanged since the last mirror: skip the (up to 4MB) session write.
    if(json===scmPendingPatchMirrorLast)return;
    // Oversize: a stale smaller mirror must not survive to be restored over newer data later.
    if(json.length>SCM_PENDING_PATCH_MIRROR_MAX_CHARS){scmPendingPatchMirrorLast='';chrome.storage.session.remove(SCM_PENDING_PATCH_SESSION_KEY).catch(()=>{});return;}
    scmPendingPatchMirrorLast=json;
    chrome.storage.session.set({[SCM_PENDING_PATCH_SESSION_KEY]:out}).catch(e=>{scmPendingPatchMirrorLast=null;logError('pending-patch-mirror',e);});
  }catch(e){logError('pending-patch-mirror',e);}};
  if(immediate)run();else scmPendingPatchMirrorTimer=setTimeout(run,500);
}
async function scmRestorePendingRealmPatches(){
  try{
    if(!chrome.storage?.session)return;
    const saved=(await chrome.storage.session.get(SCM_PENDING_PATCH_SESSION_KEY))?.[SCM_PENDING_PATCH_SESSION_KEY];
    if(!saved||typeof saved!=='object')return;
    for(const [k,patch] of Object.entries(saved)){const n=validRealmNumber(k);if(n==null||!patch||typeof patch!=='object')continue;
      // Older restored values go underneath anything already buffered in this lifetime.
      const entry=pendingRealmPatches.get(n);if(entry){entry.patch={...patch,...entry.patch};}else await storageSetRealmPatch(n,patch);}
    await flushRealmPatches();
  }catch(e){logError('pending-patch-restore',e);}
}
function dropPendingRealmPatch(realm){
  const n=validRealmNumber(realm); if(n==null)return;
  const entry=pendingRealmPatches.get(n);
  if(entry){if(entry.timer)clearTimeout(entry.timer);pendingRealmPatches.delete(n);}
  scmMirrorPendingPatches(true);
}
function discardAllRealmPatches(){
  for(const n of [...pendingRealmPatches.keys()])dropPendingRealmPatch(n);
  inflightRealmPatches.clear();
  crossLaneRealmPatches.clear();
  scmMirrorPendingPatches(true);
}
function flushRealmPatches(realm=null){
  const only=realm==null?null:validRealmNumber(realm);
  if(realm!=null&&only==null)return Promise.resolve({ok:false,error:'invalid-realm'});
  // Always pass through the lane (even with nothing pending) so a caller also waits for an in-flight flush.
  return withRealmStorageCommit(async()=>{
    const targets=only!=null?[only]:[...pendingRealmPatches.keys()];
    let firstError=null;const flushed=[];
    for(const n of targets){
      const entry=pendingRealmPatches.get(n); if(!entry)continue;
      if(entry.timer)clearTimeout(entry.timer);
      pendingRealmPatches.delete(n);
      inflightRealmPatches.set(n,entry.patch);
      try{
        // state(n) overlays the in-flight patch (and anything buffered meanwhile, which stays pending and is
        // simply written again by its own flush), so the merge order is preserved.
        const current=await state(n);
        await storageSetUnlocked({realmStores:{[realmKeyFromRealm(n)]:current}},{keepPendingRealmPatches:true});
        flushed.push(n);
      }catch(error){firstError=firstError||error;}
      finally{if(inflightRealmPatches.get(n)===entry.patch)inflightRealmPatches.delete(n);}
    }
    scmMirrorPendingPatches(!firstError);
    if(firstError)throw firstError;
    return {ok:true,flushed};
  });
}
async function storageSetRealmPatch(realm, patch={}, onTiming=null){
  const n=validRealmNumber(realm);
  if(n==null) throw new Error('Realm-scoped write requires an explicit realm.');
  if(!patch || typeof patch!=='object') throw new TypeError('Realm-scoped patch must be an object.');
  const entry=pendingRealmPatches.get(n)||{patch:{},timer:null};
  entry.patch={...entry.patch,...patch};
  pendingRealmPatches.set(n,entry);
  scmMirrorPendingPatches();
  if(!entry.timer)entry.timer=setTimeout(()=>{entry.timer=null;flushRealmPatches(n).catch(e=>logError('storage:flush-realm-patches',e));},REALM_PATCH_COALESCE_MS);
  try{onTiming?.({realmCommitQueueWaitMs:0,realmStateReadMs:0,physicalWriteMs:0,realmCommitDurationMs:0,realmCommitBuffered:true});}catch{}
  return {ok:true,buffered:true,realm:n};
}
// Commit a realm-local patch against the latest physical stores, not a snapshot
// captured before an asynchronous fetch. This prevents a slow VWAP job from
// restoring stale endpointData or market fields over newer writes.
async function commitLatestRealmPatch(realm, realmPatch={}, mirrorKeys=[]){
  const n=validRealmNumber(realm);
  if(n==null) throw new Error('Latest realm patch requires an explicit realm.');
  if(!realmPatch || typeof realmPatch!=='object') throw new TypeError('Realm patch must be an object.');
  return withRealmStorageCommit(async()=>{
    // Only this realm's store is written (the other realm's copy read here would be just as stale), the buffer of
    // coalesced patches is kept (one may have arrived after this read), and the patch is held against stale writers.
    holdCrossLaneRealmPatch(n,realmPatch);
    const latest=await state(n);
    const key=realmKeyFromRealm(n);
    const nextStore=sanitizeRealmStore({...(latest.realmStores?.[key]||{}),...realmPatch},n);
    const rootPatch={};
    if(latest.activeRealmKey===key){
      for(const field of mirrorKeys){
        if(Object.prototype.hasOwnProperty.call(nextStore,field)) rootPatch[field]=nextStore[field];
      }
    }
    await storageSetUnlocked({realmStores:{[key]:nextStore},...rootPatch},{keepPendingRealmPatches:true});
    return nextStore;
  });
}
async function storageSetUnlocked(patch={},options={}){
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
    // This is an atomic read-modify-write in the commit lane, so absorb the realm's buffered patch here
    // (its side-key fields are routed like the realmStores path does) and drop the buffer.
    const buffered=options?.keepPendingRealmPatches?null:realmPatchOverlay(active);
    const existing=sanitizePhysicalRealmPayload(buffered?{...(existingRaw?.[physicalKey]||{}),...buffered}:existingRaw?.[physicalKey],active);
    const next={...existing};
    const out={...patch};
    if(buffered){
      if(diagKey&&buffered.fullSyncDiagnostics!=null&&!hasDiagnostic)out[diagKey]=buffered.fullSyncDiagnostics;
      if(overlayKey&&buffered.gameOverlaySnapshot&&!Object.prototype.hasOwnProperty.call(patch,'gameOverlaySnapshot'))out[overlayKey]=buffered.gameOverlaySnapshot;
      if(plannerKey&&buffered.productionPlannerState&&!Object.prototype.hasOwnProperty.call(patch,'productionPlannerState'))out[plannerKey]=sanitizeProductionPlannerState(buffered.productionPlannerState,active);
      dropPendingRealmPatch(active);
    }
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
    // A whole-store write was built from a state()/stateAllRealms() read, which overlays the buffered
    // patch, so the buffer is now part of this write.
    if(!options?.keepPendingRealmPatches)dropPendingRealmPatch(realm);
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
  const buffered=realmPatchOverlay(n); // Coalesced realm patch not yet written
  const physical=data?.[key];
  const store=buffered?{...(physical&&typeof physical==='object'?physical:{}),...buffered}:physical;
  const clean=store&&typeof store==='object'?sanitizeRealmStore(store,n):{};
  if(data?.[diagnosticKey]&&typeof data[diagnosticKey]==='object') clean.fullSyncDiagnostics=data[diagnosticKey];
  if(data?.[overlayKey]&&typeof data[overlayKey]==='object') clean.gameOverlaySnapshot=data[overlayKey];
  if(buffered?.fullSyncDiagnostics&&typeof buffered.fullSyncDiagnostics==='object') clean.fullSyncDiagnostics=buffered.fullSyncDiagnostics;
  if(buffered?.gameOverlaySnapshot&&typeof buffered.gameOverlaySnapshot==='object') clean.gameOverlaySnapshot=buffered.gameOverlaySnapshot;
  clean.__productionPlannerState=plannerKey?sanitizeProductionPlannerState(data?.[plannerKey],n):null;
  // A completed full-sync diagnostic is a durable proof of completion. Stored
  // data can lose the denormalized lastSync field during a later
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
  for(const key of REALM_SCOPED_KEYS){
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
    const buffered=realmPatchOverlay(r); // Coalesced realm patch not yet written
    if(buffered)stores[key]=sanitizeRealmStore({...(stores[key]||{}),...buffered},r);
  }
  return {...DEFAULTS,...base,realmStores:stores};
}

// Read + write are one transaction in the global commit lane. Callers run inside an API-queue job of
// some realm (possibly not the target realm), never inside withRealmStorageCommit, so this cannot nest the
// lane; and it does not enqueue into the target realm's API queue (which another realm's job awaiting it
// could deadlock against). The read overlays any coalesced realm patch, so nothing newer is reverted.
async function appendRealmQuarantine(realm,kind,payload){
  const n=validRealmNumber(realm);
  const entry={...payload,receivedAt:payload?.receivedAt||new Date().toISOString()};
  return withRealmStorageCommit(async()=>{
    const s=n!=null?await state(n):await state();
    const target=n!=null?n:realmNumberFromKey(s.activeRealmKey||identityFromAuth(s.authData));
    const key=target!=null?realmKeyFromRealm(target):null;
    // state() without a realm reads only the active realm; read the target's own store when it differs
    // (writing {realmQuarantine} over an unread store would replace that whole realm store).
    const ts=!key||n!=null||(s.activeRealmKey&&validRealmNumber(realmNumberFromKey(s.activeRealmKey))===target)?s:await state(target);
    const existing=ts.realmQuarantine&&typeof ts.realmQuarantine==='object'?ts.realmQuarantine:{};
    const list=Array.isArray(existing?.[kind])?existing[kind].slice(-199):[];
    list.push(entry);
    const next={...existing,[kind]:list};
    if(!key)return storageSetUnlocked({realmQuarantine:next});
    holdCrossLaneRealmPatch(target,{realmQuarantine:next});
    const store={...(ts.realmStores?.[key]||{}),realmQuarantine:next};
    const patch={realmStores:{[key]:store}};
    if(s.activeRealmKey===key)patch.realmQuarantine=next;
    return storageSetUnlocked(patch,{keepPendingRealmPatches:true});
  });
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
function productionSnapshotKey(buildingId,resourceId,product){
  return `${Number(buildingId)}|${Number(resourceId)||0}|${String(product||'').toLowerCase().replace(/\s+/g,' ').trim()}`;
}
function productionPlanKey(buildingId){return String(Number(buildingId));}
// A production plan is identity only (product, quality, level, mode). Rates come from the building's run
// (planner-core), never from a plan, so a plan keeps no rate fields (SCM_STORAGE_CORE.PRODUCTION_PLAN_RATE_FIELDS).
// Returns the plan to store, or null when the stored plan already says the same.
function nextProductionPlan(existing,m,realm){
  const buildingId=Number(m?.buildingId),resourceId=Number(m?.resourceId),quality=Math.max(0,Number(m?.quality)||0),plannedLevel=Math.min(20,Math.max(1,Number(m?.plannedLevel)||1));
  const product=String(m?.product||'').trim(); if(!Number.isFinite(buildingId)||buildingId<=0||!product)return null;
  const normalizedResourceId=Number.isFinite(resourceId)&&resourceId>0?resourceId:null;
  const rateFields=globalThis.SCM_STORAGE_CORE.PRODUCTION_PLAN_RATE_FIELDS;
  const sameProduct=existing&&String(existing.product||'')===product&&Number(existing.resourceId??null)===Number(normalizedResourceId??null)&&(Number(existing.quality)||0)===quality;
  if(!sameProduct)return {buildingId,product,resourceId:normalizedResourceId,quality,plannedLevel,mode:String(m?.mode||'live'),capturedAt:new Date().toISOString(),captureRealm:realm,source:String(m?.source||'building capture')};
  const nextLevel=existing.mode==='live'?plannedLevel:Math.min(20,Math.max(1,Number(existing.plannedLevel)||plannedLevel));
  const hasRateFields=rateFields.some(f=>Object.prototype.hasOwnProperty.call(existing,f));
  if(Number(existing.plannedLevel||0)===nextLevel&&!hasRateFields)return null;
  const plan={...existing,plannedLevel:nextLevel,mode:existing.mode||'live'};
  for(const f of rateFields)delete plan[f];
  return plan;
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
// All market price and VWAP reads below go through market-core.js, the one source every screen shares.
function overlayVwap(store,id,quality,realm){
  if(!Number.isInteger(Number(realm))||![0,1].includes(Number(realm)))return null;
  return globalThis.SCM_MARKET_CORE.vwap(store,Number(realm),id,quality)?.value??null;
}
// Full marketPrice() hit ({price,source,stale,...}) so payloads can say where a price came from.
function overlayMarketPriceHit(store,id,quality,realm,opts){
  if(!Number.isInteger(Number(realm))||![0,1].includes(Number(realm)))return null;
  return globalThis.SCM_MARKET_CORE.marketPrice(store,Number(realm),id,quality,{...opts,mode:'exact'})||null;
}
function overlayIncomingContractMarketComparison(store,contract,realm,opts){
  // One reference for the contract badge, savings and verdict: cheapest at the
  // contract's quality or better, excluding your own listings.
  const hit=Number.isInteger(Number(realm))&&[0,1].includes(Number(realm))
    ? globalThis.SCM_MARKET_CORE.marketPrice(store,Number(realm),contract?.kind,contract?.quality,{...opts,mode:'min'}) : null;
  const marketPrice=hit?.price??null;
  const price=Number(contract?.price);
  const savingsPct=marketPrice!=null&&marketPrice>0&&Number.isFinite(price)&&price>0
    ? (marketPrice-price)/marketPrice*100 : null;
  return {marketPrice,savingsPct,marketPriceSource:hit?(hit.source==='vwap'?'realm-vwap':hit.source):null,marketPriceStale:!!hit?.stale};
}
// Same realm rule as market-core vwap(); for payloads that send whole rows.
function vwapRowsForRealm(store,realm){
  const d=store?.vwapData;
  if(!d||!Array.isArray(d.rows))return [];
  return d.sourceRealm!=null&&Number(d.sourceRealm)!==Number(realm)?[]:d.rows;
}
// Your own listings, so market price does not compare you with yourself. Storage read only.
async function marketOwnOpts(store,realm){
  const companyId=store?.authData?.authCompany?.companyId??store?.authData?.authCompany?.id??null;
  // simcoPrices: the stored SimcoTools prices (scmSimcoPrices:<realm>), marketPrice()'s last fallback; undefined when none.
  // A failed lookup never blocks the caller (async wrapper: any error becomes null).
  const simcoPrices=(await (async()=>simcoPricesFor(realm))().catch(()=>null))||undefined;
  try{
    const k=`scmMarketOrders:${realm}`;
    const mo=(await chrome.storage.local.get({[k]:null}))[k];
    return {companyId,ownIds:(Array.isArray(mo?.orders)?mo.orders:[]).map(o=>o?.id).filter(v=>v!=null),simcoPrices};
  }catch{return {companyId,simcoPrices};}
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
  // the full week was crawled: a short recent feed can be marked complete
  // even though the cursor crawl never reached the week boundary.
  // Only reuse the durable cache when coverage was explicitly proven by the
  // crawl, or when the recent feed itself already crosses the week boundary.
  const coverageProven=Boolean(status?.coverageComplete)||
    (Array.isArray(recentRows)&&recentRows.length>0&&recentRows.some(x=>{
      const ms=Date.parse(String(x?.datetime||''));
      return Number.isFinite(ms)&&ms<boundary;
    }));
  if(!coverageProven)return false;
  // A completed ledger is not ready unless the summary itself is complete.
  if(!summary || !Array.isArray(summary.netProfit) || !Array.isArray(summary.gross))return false;
  // cashflow/recent is the incremental freshness feed. If its oldest captured
  // transaction is newer than the completed ledger's latest transaction, more
  // than the recent window may have arrived since the full crawl and the
  // durable cache is no longer provably gap-free. Force one authoritative
  // cursor crawl instead of silently losing sales.
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
// A ledger read skipped by the direct-read block: thrown (callers such as Sync keep their error path) but tagged, so
// the deferred week refresh treats it as a "not read" (not a failure).
// opts.lane: an unattended retry (the deferred week refresh after a failed run): every read goes through the shared
// game lane, one per slot; a read refused by the lane throws a laneWait-tagged error (no request went out), and a
// week / ledger page stored by an earlier slot of the same refresh (under 30 min old) is reused instead of read again,
// so successive slots make progress. Without it (Sync, after Sync, the dashboard) every read goes at once.
const ACCOUNTING_WEEK_LANE_REUSE_MS=30*60000;
function accountingLaneWaitError(r){const e=new Error(r?.error||GAME_LANE_WAIT_TEXT);e.laneWait=true;e.nextAt=Number(r?.nextAt)||0;return e;}
async function syncCurrentWeekAccountingSales(realm, trace, opts=null){
  const target=validRealmNumber(realm); if(target==null)return {ok:false,error:'Invalid sync realm.'};
  const lane=typeof opts?.lane==='string'&&opts.lane?opts.lane:null;
  const read=async(path,tr=null,label=null)=>{
    if(lane){const it=(await state(target)).realmStores?.[realmKeyFromRealm(target)]?.endpointData?.[path];const at=Date.parse(String(it?.receivedAt||''));
      if(it&&Number(it.status)>=200&&Number(it.status)<300&&it.data&&typeof it.data==='object'&&Number.isFinite(at)&&Date.now()-at<ACCOUNTING_WEEK_LANE_REUSE_MS)return {ok:true,status:Number(it.status),data:it.data,reused:true};}
    const r=await pageGet(path,target,tr,label,lane?{lane}:null);
    if(r?.laneWait)throw accountingLaneWaitError(r);
    // A 2xx whose body is not data (the game's HTML shell for a moved address) is a failed read, never stored.
    if(r?.ok&&endpointResponseRejected(path,r))return {...r,ok:false,error:`${path} answered with a page instead of data`};
    return r;
  };
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
  // normal Sync/API capture, so the cursor pages are not crawled again.
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

  const week=await read(weekPath);
  
  if(!week?.ok)throw new Error(`Current accounting week boundary request failed (HTTP ${week?.status||0}).`);
  if(!week.reused)await saveData(weekPath,week.data,week.status,'GET',target);
  s=await state(target); store=s.realmStores?.[realmKeyFromRealm(target)]||{};
  boundary=accountingWeekStart(store);
  if(!Number.isFinite(boundary))throw new Error('Current accounting week boundary was not present in the captured response.');
  ledger=rebuildAccountingWeekSales(store,boundary);
  recentRows=store.endpointData?.[recentPath]?.data?.data;
  if(!Array.isArray(recentRows)){
    const recent=await read(recentPath);
    
    if(!recent?.ok)throw new Error(`Current accounting ledger request failed (HTTP ${recent?.status||0}).`);
    if(!recent.reused)await saveData(recentPath,recent.data,recent.status,'GET',target);
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
    const response=await read(path,trace,'accounting-ledger-page');
    trace?.('ledger-page-response',{realm:target,cursor,path,page:pages,ok:!!response?.ok,status:response?.status||0,error:response?.error||null});
    
    if(!response?.ok)throw new Error(`Accounting ledger page ${cursor} failed (HTTP ${response?.status||0}).`);
    if(!response.reused)await saveData(path,response.data,response.status,'GET',target);
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
  const details0=event?.details&&typeof event.details==='object'?event.details:{};
  // A read that waited for the shared game lane made no request: a "waiting" line (planned pace, not a problem).
  if(event?.laneWait||details0.laneWait||isGameLaneWait(event?.error)||isGameLaneWait(details0.error)){
    const nextAt=Number(details0.nextAt??event?.nextAt)||0;
    // While the game's security check has paused Manager reads, the wait is that pause, not the 5-min slot.
    if(typeof gameRefusalActive==='function'&&gameRefusalActive())event={...event,outcome:GAME_REFUSAL_COVERED_JOBS.has(String(event?.job||''))?'skipped':'not-read',error:gameRefusalText(gameRefusalMem.until),details:{...details0,laneWait:false,refused:true,nextAt:Number(gameRefusalMem.until)}};
    else event={...event,outcome:'waiting',error:/^Waiting for the 5-min game slot/.test(String(event?.error||''))?event.error:laneWaitText(nextAt),details:{...details0,laneWait:true}};
  }
  // not-read / waiting: identical lines at most once per 60 s, "no game tab" once per 30 min (activityRepeatCheck); the next one carries details.repeats.
  // Quiet not-read lines (tab hidden / offline): one per job per stretch (activityStretchCheck).
  if(typeof activityStretchCheck==='function'){const st=await activityStretchCheck(n,{job:String(event.job||'unknown'),outcome:event.outcome,error:event.error?String(event.error).slice(0,400):''});if(!st.log)return {ok:true,suppressed:'stretch'};
    const note=typeof activityHeldBackNote==='function'?activityHeldBackNote(st.ended):null;
    if(note){const d0=event.details&&typeof event.details==='object'?event.details:{};event={...event,details:{...d0,heldBack:Number(st.ended.held)||0,what:d0.what?`${d0.what} · ${note}`:note}};}}
  {const rep=activityRepeatCheck(n,{job:String(event.job||'unknown'),outcome:event.outcome,error:event.error?String(event.error).slice(0,400):''});
    if(!rep.log)return {ok:true,suppressed:'repeat'};
    if(rep.repeats>0)event={...event,details:{...(event.details&&typeof event.details==='object'?event.details:{}),repeats:rep.repeats}};}
  const normalized={id:`${Date.now()}-${Math.random().toString(36).slice(2,8)}`,realm:n,job:String(event.job||'unknown'),trigger:String(event.trigger||'unknown'),startedAt:event.startedAt||new Date().toISOString(),finishedAt:event.finishedAt||new Date().toISOString(),durationMs:Math.max(0,Number(event.durationMs)||0),outcome:['success','partial','failure','skipped','not-read','waiting','running','retrying','rate-limited','deferred-core-sync'].includes(event.outcome)?event.outcome:'failure',requested:Number.isFinite(Number(event.requested))?Number(event.requested):null,fetched:Number.isFinite(Number(event.fetched))?Number(event.fetched):null,refreshed:Number.isFinite(Number(event.refreshed))?Number(event.refreshed):null,checked:Number.isFinite(Number(event.checked))?Number(event.checked):null,failed:Number.isFinite(Number(event.failed))?Number(event.failed):null,cached:Number.isFinite(Number(event.cached))?Number(event.cached):null,stale:Number.isFinite(Number(event.stale))?Number(event.stale):null,error:event.error?String(event.error).slice(0,400):null,details:event.details&&typeof event.details==='object'?event.details:{}};
  // Job history lives in its own small key so appending an entry does not rewrite the whole realm store under the
  // realm write lock. Entries for one realm are appended through a serial queue so none are lost.
  const histKey=backgroundJobHistoryKey(n);
  const run=(backgroundJobQueues.get(n)||Promise.resolve()).then(async()=>{
    const raw=(await chrome.storage.local.get({[histKey]:null}))[histKey];
    let history=Array.isArray(raw)?raw.slice():null;
    if(!history){const legacy=(await chrome.storage.local.get({[realmStorageKey(n)]:null}))[realmStorageKey(n)];history=Array.isArray(legacy?.backgroundJobHistory)?legacy.backgroundJobHistory.slice():[];}
    history.push(normalized);
    // not-read / waiting lines neither count toward nor reset the 'keeps failing' alert streak.
    if(normalized.outcome!=='not-read'&&normalized.outcome!=='waiting')notifyJobTrouble(n,normalized).catch(()=>{});
    await rawStorageSet({[histKey]:history.slice(-BACKGROUND_JOB_HISTORY_LIMIT)});
    return {ok:true,event:normalized};
  });
  backgroundJobQueues.set(n,run.catch(()=>{}));
  return run;
}
// Production cost history lives in its own key (scmProductionCostHistory:<realm>), written through a
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
// Analyze ledger archive: sale rows of every captured cash-flow page + the time each page proves complete.
function ledgerArchiveKey(realm){return `scmLedgerArchive:${Number(realm)}`;}
const ledgerArchiveQueues=new Map();
// Cash-flow pages are batched per realm (not one ~166 KB archive write per response) for
// LEDGER_ARCHIVE_BATCH_MS and merged in arrival order in one read/write; each caller's promise resolves with
// the result of the write that contains its pages. flushLedgerArchive(n) writes the batch now.
const LEDGER_ARCHIVE_BATCH_MS=2000;
const ledgerArchivePending=new Map(); // realm -> {pages,timer,promise,resolve}
function queueLedgerArchive(realm,pages){
  const n=validRealmNumber(realm);const list=(Array.isArray(pages)?pages:[]).filter(p=>p&&Array.isArray(p.rows)&&p.rows.length);
  if(n==null||!list.length)return Promise.resolve({ok:false});
  let batch=ledgerArchivePending.get(n);
  if(!batch){let resolve;const promise=new Promise(r=>{resolve=r;});batch={pages:[],timer:null,promise,resolve};ledgerArchivePending.set(n,batch);}
  batch.pages.push(...list);
  if(!batch.timer)batch.timer=setTimeout(()=>{flushLedgerArchive(n);},LEDGER_ARCHIVE_BATCH_MS);
  return batch.promise;
}
function flushLedgerArchive(realm){
  const n=validRealmNumber(realm);
  const batch=n==null?null:ledgerArchivePending.get(n);
  if(!batch)return n==null?Promise.resolve({ok:false}):(ledgerArchiveQueues.get(n)||Promise.resolve()).then(()=>({ok:true,pages:0}));
  ledgerArchivePending.delete(n);if(batch.timer)clearTimeout(batch.timer);
  const key=ledgerArchiveKey(n),list=batch.pages;
  const run=(ledgerArchiveQueues.get(n)||Promise.resolve()).then(async()=>{
    let a=(await chrome.storage.local.get({[key]:null}))[key];
    for(const p of list)a=globalThis.SCM_ANALYZE_CORE.archiveMerge(a,p.url,p.rows,p.receivedAt);
    const {added,...out}=a;await rawStorageSet({[key]:out});
    return {ok:true,rows:Object.keys(out.rows).length,spans:out.spans.length};
  });
  ledgerArchiveQueues.set(n,run.catch(()=>{}));
  const result=run.catch(()=>({ok:false}));
  batch.resolve(result);
  return result;
}
function discardPendingLedgerArchive(){
  for(const [n,batch] of [...ledgerArchivePending.entries()]){if(batch.timer)clearTimeout(batch.timer);batch.resolve({ok:false,discarded:true});ledgerArchivePending.delete(n);}
}
// Daily-walk ledger catch-up: cashflow/recent holds only the newest 30 rows, so on days without a Sync most of
// the day's rows were never captured. Walk /cashflow/<id>/ back from the oldest row of the newest archived stretch
// only until a page reaches the stretch before it (~5 pages a day). Each page goes through saveData, which archives it.
const LEDGER_CATCHUP_MAX_PAGES=40;
async function catchUpLedgerArchive(realm,reason='daily-walk'){
  const n=validRealmNumber(realm); if(n==null)return {ok:false,error:'Invalid realm.'};
  await flushLedgerArchive(n); // the refreshed recent page is archived first (including a pending batch)
  const plan=globalThis.SCM_ANALYZE_CORE.catchUpPlan((await chrome.storage.local.get({[ledgerArchiveKey(n)]:null}))[ledgerArchiveKey(n)]);
  if(!plan)return {ok:true,pages:0,caughtUp:true};
  let cursor=plan.startId,pages=0,oldest=plan.startAt;const seen=new Set();
  while(cursor&&oldest>plan.stopAt&&!seen.has(cursor)&&pages<LEDGER_CATCHUP_MAX_PAGES){
    seen.add(cursor);pages++;
    const path=`/api/v2/companies/me/cashflow/${cursor}/`;
    // No game tab / bridge not ready: no page was read, a "not read" line (not a
    // failure); the archive stays where it is and the next walk carries on. A real HTTP error stays a failure.
    let res;
    try{res=await pageGet(path,n,null,`ledger-catchup:${reason}`);}
    catch(e){if(pageBridgeUnavailable(e)){logNotRead(n,'ledger-catchup',e,{pages:pages-1},Date.now(),reason);return {ok:true,skipped:true,bridgeUnavailable:true,pages:pages-1,caughtUp:false,error:e?.message||String(e)};}throw e;}
    
    // 2.5.465: waiting for the 5-min game slot is not a failure; the next walk carries on.
    if(res?.laneWait||res?.queued||res?.syncRunning)return {ok:true,skipped:true,queued:true,nextAt:res?.nextAt||null,pages:pages-1,caughtUp:false};
    if(!res?.ok)return {ok:false,pages,error:`Ledger page ${cursor} failed (HTTP ${res?.status||0}).`};
    await saveData(path,res.data,res.status,'GET',n);
    cursor=null;
    for(const r of Array.isArray(res.data?.data)?res.data.data:[]){const t=Date.parse(String(r?.datetime||''));if(Number.isFinite(t)&&r?.id!=null&&t<=oldest){oldest=t;cursor=String(r.id);}}
  }
  return {ok:true,pages,caughtUp:!cursor||oldest<=plan.stopAt,capped:pages>=LEDGER_CATCHUP_MAX_PAGES&&oldest>plan.stopAt};
}
// Ledger cursor pages are kept in the realm store only while recent (see SCM_ANALYZE_CORE.pruneLedgerPages);
// their rows live in scmLedgerArchive. accountingCapture keeps /recent/ only.
const LEDGER_CURSOR_PAGE_RX=/\/api\/v2\/companies\/me\/cashflow\/\d+\/?$/i;
function pruneStoredLedgerPages(map){const f=globalThis.SCM_ANALYZE_CORE?.pruneLedgerPages;return f?f(map).map:map;}
function withoutLedgerCursorPages(map){
  const src=map&&typeof map==='object'?map:{};
  if(!Object.keys(src).some(k=>LEDGER_CURSOR_PAGE_RX.test(k)))return src;
  return Object.fromEntries(Object.entries(src).filter(([k])=>!LEDGER_CURSOR_PAGE_RX.test(k)));
}
// One-time shrink of stores that still hold every ledger page: archive each stored page first, then drop the old copies.
async function compactLedgerPagesOnce(){
  const FLAG='scmLedgerPagesCompactedV1';
  if(coreSyncActive()){deferUntilSyncEnds('ledger-pages-compact',()=>{compactLedgerPagesOnce().catch(()=>{});});return {ok:false,deferred:true};}
  if((await chrome.storage.local.get({[FLAG]:false}))[FLAG])return {ok:true,skipped:true};
  const out={};
  for(const n of [0,1]){
    out[n]=await enqueueApiStorage(async()=>{
      const s=await state(n);const store=s.realmStores?.[realmKeyFromRealm(n)]||{};
      const ep=store.endpointData||{},ac=store.accountingCapture||{};
      const pages=Object.entries({...ac,...ep}).filter(([k,v])=>LEDGER_CURSOR_PAGE_RX.test(k)&&validRealmNumber(v?.captureRealm)===n&&Array.isArray(v?.data?.data)).map(([k,v])=>({url:k,rows:v.data.data,receivedAt:v.receivedAt}));
      if(pages.length){const queued=queueLedgerArchive(n,pages);flushLedgerArchive(n);const a=await queued;if(!a?.ok)throw new Error('Ledger archive write failed.');}
      const nextEp=pruneStoredLedgerPages(ep),nextAc=withoutLedgerCursorPages(ac);
      if(nextEp===ep&&nextAc===ac)return {pages:pages.length,dropped:0};
      await storageSetRealmPatch(n,{endpointData:nextEp,accountingCapture:nextAc});
      return {pages:pages.length,dropped:Object.keys(ep).length-Object.keys(nextEp).length+Object.keys(ac).length-Object.keys(nextAc).length};
    },n,{priority:true});
  }
  await rawStorageSet({[FLAG]:true});
  return {ok:true,...out};
}
// Statement history: the game numbers day statements by age (/day/0/ = last finished day), so the store only
// ever held the latest 14. Every computed day statement is also kept by its own date in scmStatementHistory:<realm>
// ({ 'income-statement': { '<date>': data }, 'cashflow-statement': …, 'balance-sheet': … }), ~1 KB a day; the daily
// storage trim (scmPruneStorage) keeps 90 days.
const STATEMENT_DAY_RX=/\/api\/v2\/companies\/me\/(income-statement|cashflow-statement|balance-sheet)\/day\/\d+\/?$/;
function statementHistoryKey(realm){return `scmStatementHistory:${Number(realm)}`;}
const statementHistoryQueues=new Map();
function queueStatementHistory(realm,items,{keep=false}={}){
  const n=validRealmNumber(realm);const list=(Array.isArray(items)?items:[]).filter(x=>x&&x.kind&&x.data&&x.data.isComputed===true&&Number.isFinite(Date.parse(String(x.data.date||''))));
  if(n==null||!list.length)return Promise.resolve({ok:false});
  const key=statementHistoryKey(n);
  const run=(statementHistoryQueues.get(n)||Promise.resolve()).then(async()=>{
    const h=(await chrome.storage.local.get({[key]:null}))[key]||{};let added=0;
    for(const {kind,data} of list){const d=new Date(Date.parse(String(data.date))).toISOString();h[kind]=h[kind]||{};if(h[kind][d]&&keep)continue;if(!h[kind][d])added++;h[kind][d]=data;}
    await rawStorageSet({[key]:h});return {ok:true,added};
  });
  statementHistoryQueues.set(n,run.catch(()=>{}));
  return run.catch(()=>({ok:false}));
}
async function seedStatementHistoryOnce(){
  const FLAG='scmStatementHistorySeededV1';
  const got=await chrome.storage.local.get({[FLAG]:false,'scmRealmStore:0':null,'scmRealmStore:1':null});
  if(got[FLAG])return {ok:true,skipped:true};
  for(const n of [0,1]){
    const ep=got[`scmRealmStore:${n}`]?.endpointData||{};
    const items=Object.entries(ep).map(([k,v])=>[k.match(STATEMENT_DAY_RX),v]).filter(([m,v])=>m&&validRealmNumber(v?.captureRealm)===n).map(([m,v])=>({kind:m[1],data:v.data}));
    if(items.length)await queueStatementHistory(n,items);
  }
  await rawStorageSet({[FLAG]:true});
  return {ok:true};
}
setTimeout(()=>{seedStatementHistoryOnce().catch(()=>{});},6000);
// One-time seed from the cash-flow pages already in each realm store (stamped with that realm).
async function seedLedgerArchiveOnce(){
  const FLAG='scmLedgerArchiveSeededV2'; // V2: re-seed so retail rows from stored pages join the archive
  const got=await chrome.storage.local.get({[FLAG]:false,'scmRealmStore:0':null,'scmRealmStore:1':null});
  if(got[FLAG])return {ok:true,skipped:true};
  for(const n of [0,1]){
    const ep=got[`scmRealmStore:${n}`]?.endpointData||{};
    const pages=Object.entries(ep).filter(([k,v])=>/\/api\/v2\/companies\/me\/cashflow\/(?:recent|\d+)\/?$/.test(k)&&validRealmNumber(v?.captureRealm)===n&&Array.isArray(v?.data?.data))
      .map(([k,v])=>({url:k,rows:v.data.data,receivedAt:v.receivedAt}))
      // Recent first so its oldest row anchors the first cursor page, then cursor pages newest → oldest.
      .sort((a,b)=>(/recent/.test(b.url)-/recent/.test(a.url))||(Number(b.url.match(/\/(\d+)\/?$/)?.[1])||0)-(Number(a.url.match(/\/(\d+)\/?$/)?.[1])||0));
    if(pages.length)await queueLedgerArchive(n,pages);
  }
  await rawStorageSet({[FLAG]:true});
  return {ok:true};
}
setTimeout(()=>{seedLedgerArchiveOnce().catch(()=>{}).then(()=>compactLedgerPagesOnce()).catch(()=>{});},5000);
// One-time seed from data already captured (current buildings + stored building histories).
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
// Notifications. Settings in scmNotifySettings (fields: NOTIFY_DEFAULTS). Production-finished alerts use the
// game's own busy.started + busy.duration; one alarm per running batch, named scm-prodfin:<realm>:<buildingId>:<finishMs>.
// Whether the phone shows them depends on the browser's support for extension notifications.
const NOTIFY_SETTINGS_KEY='scmNotifySettings';
const NOTIFY_DEFAULTS={productionFinished:true,sales:true,priceTargets:[],bigMove:true,bigMovePct:5,incomingContracts:true,dailySummary:true,dailySummaryTime:'08:00',costChange:true,costChangePct:3,idle:true,idleHours:1,undercut:true,unprofitable:true,jobTrouble:true,economyChange:true,contestReminder:true,contestLeadHours:24};
// A Settings save: contestLeadHours an integer 1..336 (not a number = 24), contestReminder a boolean.
function sanitizeNotifySet(set){
  const out={...(set&&typeof set==='object'&&!Array.isArray(set)?set:{})};
  if('contestLeadHours' in out){const v=out.contestLeadHours,h=(typeof v==='number'||(typeof v==='string'&&v.trim()!==''))?Number(v):NaN;
    out.contestLeadHours=Number.isFinite(h)?Math.min(336,Math.max(1,Math.round(h))):24;}
  if('contestReminder' in out){const v=out.contestReminder;out.contestReminder=v===true||v==='true'||v===1||v==='1'||v==='on';}
  return out;
}
async function notifySettings(){const v=(await chrome.storage.local.get({[NOTIFY_SETTINGS_KEY]:null}))[NOTIFY_SETTINGS_KEY];return {...NOTIFY_DEFAULTS,...(v&&typeof v==='object'?v:{})};}
// Notification state (dedupe/re-arm) in its own key, written through one serial queue.
const NOTIFY_STATE_KEY='scmNotifyState';let notifyStateQueue=Promise.resolve();
function updateNotifyState(mut){const run=notifyStateQueue.then(async()=>{const cur=(await chrome.storage.local.get({[NOTIFY_STATE_KEY]:{}}))[NOTIFY_STATE_KEY]||{};const next=await mut({...cur});if(next)await rawStorageSet({[NOTIFY_STATE_KEY]:next});return next;});notifyStateQueue=run.catch(()=>{});return run;}
let notifyRecipesMemo=null;
// Recipe inputs/transport come from the game's constants (scmGameConstants) when present.
async function gameRecipesFromBundle(list){try{const c=(await chrome.storage.local.get({scmGameConstants:null})).scmGameConstants;return globalThis.SCM_TOOLS_CORE.recipesFromGameConstants(list,c);}catch{return Array.isArray(list)?list:[];}}
globalThis.__scmOwnWriteHooks?.push(items=>{if(Object.prototype.hasOwnProperty.call(items,'scmGameConstants')){notifyRecipesMemo=null;gameOverlayAssetsPromise=null;}});
async function notifyRecipes(){if(notifyRecipesMemo)return notifyRecipesMemo;try{const list=await gameRecipesFromBundle(await (await fetch(chrome.runtime.getURL('recipes.json'))).json());const byId=new Map(),names=new Map();for(const r of Array.isArray(list)?list:[]){byId.set(Number(r.id),r);names.set(Number(r.id),String(r.name||''));}notifyRecipesMemo={byId,names};}catch{notifyRecipesMemo={byId:new Map(),names:new Map()};}return notifyRecipesMemo;}
// Read-only copy of scmRealmStore:<realm> (1-2 MB on a real install: each read is a full structured clone on the worker
// thread, which delayed every message answer). Concurrent callers share one read; the value is kept 3 s and dropped at
// once when this worker writes or removes the key (own-write hook) or clears storage. Callers must not mutate it.
const REALM_STORE_MEMO_MS=3000,realmStoreMemo=new Map();let realmStoreMemoGen=0;
globalThis.__scmOwnWriteHooks?.push(items=>{for(const k of Object.keys(items)){const m=/^scmRealmStore:(\d+)$/.exec(k);if(m){realmStoreMemo.delete(Number(m[1]));realmStoreMemoGen++;}}});
{const lr=globalThis.chrome?.storage?.local;if(lr&&typeof lr.remove==='function'&&typeof lr.clear==='function'){const __rm=lr.remove.bind(lr),__cl=lr.clear.bind(lr);
  lr.remove=(keys,...rest)=>{for(const k of [].concat(keys||[])){const m=/^scmRealmStore:(\d+)$/.exec(String(k));if(m){realmStoreMemo.delete(Number(m[1]));realmStoreMemoGen++;}}return __rm(keys,...rest);};
  lr.clear=(...rest)=>{realmStoreMemo.clear();realmStoreMemoGen++;return __cl(...rest);};}}
function notifyRealmStore(realm){
  const n=validRealmNumber(realm),key=`scmRealmStore:${realm}`;
  if(n==null)return chrome.storage.local.get({[key]:null}).then(r=>r[key]||{});
  const now=Date.now(),cur=realmStoreMemo.get(n);
  if(cur&&(cur.pending||now-cur.at<REALM_STORE_MEMO_MS))return cur.promise;
  const gen=realmStoreMemoGen,e={at:now,pending:true,promise:null};
  e.promise=chrome.storage.local.get({[key]:null}).then(r=>{const v=r[key]||{};e.pending=false;e.at=Date.now();if(realmStoreMemoGen!==gen&&realmStoreMemo.get(n)===e)realmStoreMemo.delete(n);return v;},err=>{if(realmStoreMemo.get(n)===e)realmStoreMemo.delete(n);throw err;});
  realmStoreMemo.set(n,e);return e.promise;
}
async function notifyAfterPriceUpdate(realm){
  const n=validRealmNumber(realm);if(n==null)return;const cfg=await notifySettings();
  const wantTargets=Array.isArray(cfg.priceTargets)&&cfg.priceTargets.some(t=>Number(t?.realm??n)===n);
  if(!wantTargets&&!cfg.bigMove&&!cfg.unprofitable)return;
  const st=await notifyRealmStore(n);const rows=Array.isArray(st.liveMarketPriceData?.rows)?st.liveMarketPriceData.rows:[];if(!rows.length)return;const marketOwn=cfg.unprofitable?await marketOwnOpts(st,n):{};
  const {names}=await notifyRecipes();const N=globalThis.SCM_NOTIFY_CORE,C=globalThis.SCM_TOOLS_CORE;
  await updateNotifyState(async state=>{
    if(wantTargets){const key=`targets:${n}`;const r=N.priceTargetHits(cfg.priceTargets.filter(t=>Number(t?.realm??n)===n),rows,state[key]||{},names,n);state[key]=r.state;for(const f of r.fire)await scmNotify(`target-${n}-${f.id}-${f.q}-${Date.now()}`,f.title,f.message);}
    if(cfg.bigMove){const key=`moves:${n}`;const mv=C.moversFromTrend(rows);const r=N.bigMoves({movers:[...mv.ranked,...mv.unranked],lots:st.warehouseResources,threshold:Number(cfg.bigMovePct)||5,lastFired:state[key]||{},names,realm:n});state[key]=r.lastFired;for(const f of r.fire)await scmNotify(`move-${n}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,f.title,f.message);}
    if(cfg.unprofitable){const key=`unprof:${n}`;const r=N.unprofitable({buildings:st.buildings,store:st,realm:n,names,state:state[key]||{},...marketOwn});state[key]=r.state;for(const f of r.fire)await scmNotify(`unprof-${n}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,f.title,f.message);}
    return state;
  });
}
// Whenever the incoming-contracts list is captured. First capture only records what exists.
async function notifyIncomingContracts(realm,data){
  const n=validRealmNumber(realm);if(n==null)return;const cfg=await notifySettings();if(!cfg.incomingContracts)return;
  const {names}=await notifyRecipes();const N=globalThis.SCM_NOTIFY_CORE;
  await updateNotifyState(async state=>{const key=`contracts:${n}`;const r=N.newIncomingContracts(data,state[key],names,n);state[key]=r.seen;for(const f of r.fresh)await scmNotify(`contract-${n}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,f.title,f.message);return state;});
}
async function scheduleDailySummary(){const cfg=await notifySettings();await chrome.alarms.clear('scm-daily-summary');if(cfg.dailySummary)await scmAlarmCreate('scm-daily-summary',{when:globalThis.SCM_NOTIFY_CORE.nextDailyTime(cfg.dailySummaryTime),periodInMinutes:1440});}
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
// Follow-up after a finished batch: idle or not collected. Decided only from building data captured
// after the finish time; if none yet, look again in an hour (up to 3 times).
async function fireFollowUp(name){
  const clearGen=extensionClearGeneration;
  const m=String(name).match(/^scm-followup:(\d+):(\d+):(\d+):(\d+):(\d+)$/);if(!m)return;
  const realm=Number(m[1]),bid=Number(m[2]),startedMs=Number(m[3]),finishMs=Number(m[4]),attempt=Number(m[5]);
  const cfg=await notifySettings();if(!cfg.idle)return;
  const st=await notifyRealmStore(realm);const {names}=await notifyRecipes();
  if(clearGen!==extensionClearGeneration)return;
  const b=(Array.isArray(st.buildings)?st.buildings:[]).find(x=>Number(x?.id)===bid);if(!b)return;
  const seenAt=Date.parse(String(st.endpointData?.['/api/v2/companies/me/buildings/']?.receivedAt||''));
  // Batch size: the run's full output from its history row (busy.resource.amount is only what is still to come).
  const batchAmount=globalThis.SCMPlannerCore.runOutputAmount(b,st.endpointData?.[`/api/v2/companies/buildings/${bid}/history/`]?.data)??undefined;
  const r=globalThis.SCM_NOTIFY_CORE.followUp({building:b,startedMs,finishMs,seenAt,names,realm,batchAmount});
  if(r.kind==='unknown'){if(attempt<3)await createFollowupAlarm(`scm-followup:${realm}:${bid}:${startedMs}:${finishMs}:${attempt+1}`,Date.now()+3600e3,clearGen);return;}
  if(r.title)await scmNotify(`followup-${realm}-${bid}-${finishMs}`,r.title,r.message);
}
chrome.alarms.onAlarm.addListener(a=>{if(String(a?.name||'').startsWith('scm-followup:')){forgetFollowupAlarm(a.name).catch(()=>{});fireFollowUp(a.name).catch(()=>{});}});
// When an exchange order book is captured (by the game or the Manager), and after a warehouse update.
async function notifyOrderBook(realm,resourceId,rows){
  const n=validRealmNumber(realm);if(n==null)return;const cfg=await notifySettings();if(!cfg.undercut&&!cfg.unprofitable)return;
  if(cfg.undercut)await refreshMarketOrders(n,undefined,{background:true,lane:true}); // gated + shared game lane; when skipped the stored listings below are used
  const st=await notifyRealmStore(n);const {names}=await notifyRecipes();const N=globalThis.SCM_NOTIFY_CORE;
  const companyId=st?.authData?.authCompany?.id??st?.authData?.authCompany?.companyId;
  const mo=(await chrome.storage.local.get({[`scmMarketOrders:${n}`]:null}))[`scmMarketOrders:${n}`];
  const own=Array.isArray(mo?.orders)?mo.orders.filter(o=>Number(o?.kind)===Number(resourceId)):null;
  await updateNotifyState(async state=>{
    if(cfg.undercut){const key=`undercut:${n}`;const r=N.undercut({rows,companyId,own,id:Number(resourceId),names,realm:n,state:state[key]||{}});state[key]=r.state;for(const f of r.fire)await scmNotify(`undercut-${n}-${resourceId}-${Date.now()}`,f.title,f.message);}
    if(cfg.unprofitable){const key=`unprof:${n}`;const r=N.unprofitable({buildings:st.buildings,store:st,realm:n,names,state:state[key]||{},companyId,ownIds:(Array.isArray(mo?.orders)?mo.orders:[]).map(o=>o?.id).filter(v=>v!=null)});state[key]=r.state;for(const f of r.fire)await scmNotify(`unprof-${n}-${Date.now()}`,f.title,f.message);}
    return state;
  });
}
// Sales and accepted contracts from the cash-flow ledger the game/Manager just captured. No network.
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
// A new production run costs noticeably more/less than the last one (only runs started in the last 24 h).
async function notifyCostChanges(realm,history,newEntries){
  const n=validRealmNumber(realm);if(n==null||!newEntries.length)return;const cfg=await notifySettings();if(!cfg.costChange)return;
  const {names}=await notifyRecipes();
  for(const e of newEntries){if(Date.now()-Date.parse(e.t)>24*3600e3)continue;const r=globalThis.SCM_NOTIFY_CORE.costChanged({history,entry:e,thresholdPct:Number(cfg.costChangePct)||3,names,realm:n});if(r)await scmNotify(`cost-${n}-${e.k}`,r.title,r.message);}
}
chrome.alarms.get('scm-daily-summary').then(a=>{if(!a)scheduleDailySummary().catch(()=>{});}).catch(()=>{});
// Notifications: one stable ID per category+realm so updates replace instead of stacking; events arriving within
// SCM_NOTIFY_BATCH_MS are merged into one 'list' notification. The action badge counts alerts not yet seen.
const SCM_NOTIFY_BATCH_MS=2500;
const scmNotifyBatches=new Map(); // stableId -> {items:[],timer}
const SCM_BADGE_COUNT_KEY='scmAlertBadgeCount';
async function scmBumpAlertBadge(by){try{const cur=Number((await chrome.storage.session.get(SCM_BADGE_COUNT_KEY))?.[SCM_BADGE_COUNT_KEY])||0;const next=cur+by;await chrome.storage.session.set({[SCM_BADGE_COUNT_KEY]:next});await chrome.action?.setBadgeBackgroundColor?.({color:'#c0392b'});await chrome.action?.setBadgeText?.({text:next>99?'99+':String(next)});}catch(e){logError('badge',e);}}
async function scmClearAlertBadge(){try{await chrome.storage.session.remove(SCM_BADGE_COUNT_KEY);await chrome.action?.setBadgeText?.({text:''});}catch(e){logError('badge',e);}}
function scmNotify(id,title,message){
  {const m=String(id).match(/^[a-z]+-([01])-/);if(m&&!String(id).startsWith('jobs-'))logActivity(Number(m[1]),'alert-sent','success',{title:String(title).slice(0,80)});}
  const sid=String(id);
  if(sid.startsWith('test-'))return scmNotifyNow(sid,title,message);
  const cm=sid.match(/^([a-z]+)-([01])?/);
  const stableId=cm?`${cm[1]}-${cm[2]??'x'}-scm`:sid;
  // Callers await this inside notify-state locks, so resolve at once instead of holding them for the batch window.
  return new Promise(resolve=>{
    const b=scmNotifyBatches.get(stableId)||{items:[],timer:null};
    b.items.push({title:String(title),message:String(message)});resolve({ok:true,queued:true,id:stableId});
    scmNotifyBatches.set(stableId,b);
    if(!b.timer)b.timer=setTimeout(async()=>{
      scmNotifyBatches.delete(stableId);
      let r;
      try{
        if(b.items.length===1)r=await scmNotifyNow(stableId,b.items[0].title,b.items[0].message);
        else r=await scmNotifyNow(stableId,`${b.items.length} alerts: ${b.items[0].title}`,b.items.map(x=>x.title).join(' · '),b.items.slice(0,8).map(x=>({title:x.title.slice(0,60),message:x.message.slice(0,120)})));
        if(r?.ok)await scmBumpAlertBadge(b.items.length);
        else logError('notify',r?.error);
      }catch(e){logError('notify',e);}
    },SCM_NOTIFY_BATCH_MS);
  });
}
function scmNotifyNow(id,title,message,listItems=null){
  return new Promise(resolve=>{
    try{
      if(!chrome.notifications?.create)return resolve({ok:false,error:'This browser does not provide extension notifications (chrome.notifications is missing).'});
      const opts={type:listItems?'list':'basic',iconUrl:chrome.runtime.getURL('icons/icon128.png'),title:String(title).slice(0,120),message:String(message).slice(0,300),priority:2};
      if(listItems)opts.items=listItems;
      chrome.notifications.create(id,opts,nid=>{const e=chrome.runtime.lastError;resolve(e?{ok:false,error:e.message||String(e)}:{ok:true,id:nid});});
    }catch(e){resolve({ok:false,error:e?.message||String(e)});}
  });
}
function productionFinishAlarms(realm,buildings){
  const out=[];
  for(const b of Array.isArray(buildings)?buildings:[]){
    const st=Date.parse(String(b?.busy?.started||'')),dur=Number(b?.busy?.duration);
    if(!(Number(b?.id)>0)||!Number.isFinite(st)||!(dur>0))continue;
    if(String(b?.busy?.category||'')==='b')continue; // construction / upgrade, not a production batch
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
  for(const x of wanted)if(!have.has(x.name)){await scmAlarmCreate(x.name,{when:x.when});created++;}
  return {ok:true,created,total:wanted.length};
}
async function fireProductionFinished(name){
  const clearGen=extensionClearGeneration;
  const m=String(name).match(/^scm-prodfin:(\d+):(\d+):(\d+)$/);if(!m)return;
  const realm=Number(m[1]),bid=Number(m[2]);
  const cfg=await notifySettings();if(!cfg.productionFinished)return;
  const st=await notifyRealmStore(realm);
  const b=(Array.isArray(st.buildings)?st.buildings:[]).find(x=>Number(x?.id)===bid)||{id:bid,name:`Building ${bid}`};
  const {names}=await notifyRecipes();const N=globalThis.SCM_NOTIFY_CORE;
  if(clearGen!==extensionClearGeneration)return;
  {const r=N.batchFinishedMessage({building:b,store:st,realm,names,...(await marketOwnOpts(st,realm))});await scmNotify(`prodfin-${realm}-${bid}-${m[3]}`,r.title,r.message);}
  // Look again idleHours after the finish (idle, or still not collected).
  const st0=Date.parse(String(b?.busy?.started||''));
  if(cfg.idle&&Number.isFinite(st0)){const h=Math.max(0.25,Number(cfg.idleHours)||1);await createFollowupAlarm(`scm-followup:${realm}:${bid}:${st0}:${m[3]}:0`,Number(m[3])+h*3600e3>Date.now()?Number(m[3])+h*3600e3:Date.now()+60000,clearGen);}
}
chrome.alarms.onAlarm.addListener(a=>{if(String(a?.name||'').startsWith('scm-prodfin:'))fireProductionFinished(a.name).catch(e=>logError('alarm:prodfin',e));});
try{chrome.notifications?.onClicked?.addListener(id=>{scmClearAlertBadge();if(String(id).startsWith('prodfin-'))chrome.tabs.create({url:'https://www.simcompanies.com/'}).catch(()=>{});try{chrome.notifications.clear(id);}catch{}});}catch{}
function backgroundJobHistoryKey(realm){return `scmBackgroundJobs:${Number(realm)}`;}
const backgroundJobQueues=new Map();

// On a slow phone connection game API answers can take 14–70 s, so the background warehouse refresh makes one
// attempt with a longer page timeout, and overlay-triggered refreshes pause after a failure.
const WAREHOUSE_REFRESH_PAGE_TIMEOUT_MS=25000;
const WAREHOUSE_OVERLAY_FAILURE_BACKOFF_MS=60000;
const warehouseOverlayBackoffUntil=new Map();
function warehouseOverlayRefreshInBackoff(realm,maxAgeMs,now=Date.now()){
  if(Number(maxAgeMs)===0)return false; // refreshes after game actions always run
  return now<(warehouseOverlayBackoffUntil.get(realm)||0);
}
function noteWarehouseOverlayRefreshResult(realm,maxAgeMs,result,now=Date.now()){
  if(result?.ok){warehouseOverlayBackoffUntil.delete(realm);return;}
  if(Number(maxAgeMs)===0||result?.stale||result?.notReady||result?.otherRealm||result?.pageClosed||result?.bridgeUnavailable||result?.laneWait)return;
  warehouseOverlayBackoffUntil.set(realm,now+WAREHOUSE_OVERLAY_FAILURE_BACKOFF_MS);
}
// maxAgeMs>0: the game-page card's own refresh (unattended): a lane read (job 'warehouse:<realm>', priority 1, at most
// every 15 min), and a warehouse captured from the game's own pages in the last 15 min counts as fresh.
// maxAgeMs 0: a game action changed stock or the player pressed refresh: user-initiated, read now.
const WAREHOUSE_LANE_FRESH_MS=15*60000;
async function refreshRealmWarehouseForOverlayUnlocked(realm, maxAgeMs=15000, opts=null){
  const totalStartedAt=Date.now();
  const laneRead=Number(maxAgeMs)>0,freshMs=laneRead?Math.max(Number(maxAgeMs),WAREHOUSE_LANE_FRESH_MS):Number(maxAgeMs)||0;
  const n=validRealmNumber(realm); if(n==null)return {ok:false,error:'Invalid realm.'};
  await ensureRealmStorageMigration();
  let s=await state(n);
  const key=realmKeyFromRealm(n); if(!key)return {ok:false,error:'Invalid realm.'};
  const store={...(s.realmStores?.[key]||{})};
  const capturedAt=Date.parse(String(store.warehouseCapture?.receivedAt||''));
  if(Number.isFinite(capturedAt) && Date.now()-capturedAt<freshMs && Array.isArray(store.warehouseResources)&&store.warehouseResources.length){
    return {ok:true,cached:true,rows:store.warehouseResources.length};
  }
  const companyId=Number(store.authData?.authCompany?.companyId||store.authData?.authCompany?.id);
  // Nothing to refresh yet (auth-data not captured): a skip, not a failure in the background-jobs count.
  if(!Number.isFinite(companyId)||companyId<=0)return {ok:false,notReady:true,error:'Realm company ID unavailable.'};
  // The game tab is in the other realm (or mid-switch, before its auth-data made it the active session): a "not
  // read" line, not a partial refresh. The overlay of the realm just left can still ask for its warehouse for a moment.
  const activeKey=s.activeRealmKey;
  const otherRealmSkip=()=>{const live=realmDisplayNumber(realmNumberFromKey(s.activeRealmKey));return {ok:false,skipped:true,otherRealm:true,stale:true,error:`Skipped: the game tab is in ${live||'another realm'}, not ${realmDisplayNumber(n)||'this realm'}.`};};
  if(activeKey!==key)return otherRealmSkip();
  const path=`/api/v3/resources/${companyId}/`;
  try{
    const requestStartedAt=Date.now();
    const r=await pageGet(path,n,null,null,{timeoutMs:WAREHOUSE_REFRESH_PAGE_TIMEOUT_MS,attempts:1,lane:typeof opts?.lane==='string'&&opts.lane?opts.lane:`warehouse:${n}`});
    const requestDurationMs=Date.now()-requestStartedAt;
    if(r?.laneWait)return {ok:false,skipped:true,laneWait:true,reason:r.reason,nextAt:r.nextAt,error:r.error,requestDurationMs};
    if(r?.realmMismatch){s=await state(n);return {...otherRealmSkip(),requestDurationMs};}
    
    if(!r?.ok)return {ok:false,error:r?.error||`HTTP ${r?.status||0}`,status:r?.status||0,requestDurationMs};
    const rows=normalizeWarehouse(r.data);
    if(!looksLikeWarehouseRows(rows))return {ok:false,error:'Current game warehouse response was not recognizable.',status:r.status,requestDurationMs};
    return withRealmWriteLock(n,async()=>{
      const storageCommitStartedAt=Date.now();
      const fresh=await state(n);
      // The page may switch realms while pageGet() is pending. Never commit
      // a response unless both the active realm and company identity still match.
      if(fresh.activeRealmKey!==key)return {ok:false,skipped:true,otherRealm:true,stale:true,error:'Skipped: the game tab switched realm during the read; nothing saved.'};
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
  }catch(e){
    // The game page unloaded mid-read (realm switch, reload): "not read", nothing saved, no backoff.
    if(pageMessageChannelClosed(e))return {ok:false,skipped:true,pageClosed:true,error:'Skipped: the game page reloaded or closed during the read; nothing saved.',totalDurationMs:Date.now()-totalStartedAt};
    // No game tab / page bridge not ready or not connected: no request was made. "Not read", no backoff.
    if(pageBridgeUnavailable(e))return {ok:false,skipped:true,bridgeUnavailable:true,error:e?.message||String(e),totalDurationMs:Date.now()-totalStartedAt};
    return {ok:false,error:e?.message||String(e),totalDurationMs:Date.now()-totalStartedAt};
  }
}

function overlayProductionRunHours(store){
  const n=Number(store?.productionRunHours);
  return Number.isFinite(n)?Math.min(48,Math.max(1,n)):24;
}

// The realm store holds this realm's auth-data (its authCompany says this realm, or no realm). Storage read only.
function realmStoreHasAuthData(st,n){const ac=st?.authData?.authCompany;if(!ac)return false;const ar=validRealmNumber(ac.realmId??ac.realm);return ar==null||ar===n;}
async function realmHasStoredAuthData(realm){
  const n=validRealmNumber(realm);if(n==null)return false;
  try{return realmStoreHasAuthData(await notifyRealmStore(n),n);}catch{return false;}
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
  // No auth-data captured yet: one direct read in the shared game lane (job 'authData:<realm>', priority 1 like the
  // warehouse, at most every 15 min). Callers are unattended (the game-page card rebuild, the dashboard planner's
  // modifier check). Slot taken: a "waiting" line; direct reads blocked or no game tab: a "not read" line (skipped,
  // no error); the card keeps its waiting state and asks again on its next refresh, and the game's own pages capture
  // auth-data for free. A real failed read: a failure line.
  try{
    const r=await pageGet('/api/v3/companies/auth-data/',realm,null,'auth-data-fallback',{lane:`authData:${realm}`});
    if(r?.laneWait){logLaneWait(realm,'auth-data-read',r.nextAt);return {ok:false,skipped:true,laneWait:true,realm,nextAt:r.nextAt||null};}
    
    if(!r?.ok){logActivity(realm,'auth-data-read','failure',{},capRefreshError(r?.error||`HTTP ${r?.status||0}`));return {ok:false,realm,error:r?.error||`HTTP ${r?.status||0}`};}
    if(endpointResponseRejected('/api/v3/companies/auth-data/',r)){logActivity(realm,'auth-data-read','failure',{},'The game answered with a page instead of data.');return {ok:false,realm,error:'The game answered with a page instead of data.'};}
    await saveData('/api/v3/companies/auth-data/',r.data,r.status||200,'GET',realm);
    s=await state(realm);
    store={...(s.realmStores?.[key]||{})};
    return {ok:true,realm,authData:store.authData||r.data};
  }catch(e){
    if(pageBridgeUnavailable(e)){logNotRead(realm,'auth-data-read',e);return {ok:false,skipped:true,bridgeUnavailable:true,realm};}
    logActivity(realm,'auth-data-read','failure',{},capRefreshError(e?.message||e));
    return {ok:false,realm,error:e?.message||String(e)};
  }
}
// A stored building history gives that running building's current run its measured rate. It is kept as the run's
// 'production history' snapshot, so planner-core still has the rate when a later history capture lacks the row
// (replaced or pruned). Also refreshes the building's identity plan. Reads only stored data: no game request.
// Adds to patch only what differs from the stored plan and snapshot; returns whether it added anything.
function addRunHistoryCapture(patch,store,b,target){
  const core=globalThis.SCMPlannerCore,id=Number(b?.id);
  if(!Number.isFinite(id)||id<=0||String(b?.category||'').toLowerCase()!=='production')return false;
  let changed=false;
  // A building keeps the plan of the product it was last seen making, also while idle or being expanded.
  const res=b.busy?.resource,product=String(res?.name||'').trim();
  if(product){
    const plans=patch.productionPlans||store.productionPlans||{};
    const plan=nextProductionPlan(plans[productionPlanKey(id)],{buildingId:id,resourceId:Number(res?.kind??res?.resourceId),product,quality:Math.max(0,Number(res?.quality)||0),plannedLevel:core.buildingLevel(b),mode:'live',source:'live building capture'},target);
    if(plan){patch.productionPlans={...plans,[productionPlanKey(id)]:plan};changed=true;}
  }
  const run=core.buildingRun(b);
  const e=store.endpointData?.[`/api/v2/companies/buildings/${id}/history/`];const st=Number(e?.status)||200;
  const row=run&&st>=200&&st<300&&Array.isArray(e?.data)?core.matchRunHistoryRow(b,e.data):null;
  if(row){
    const snaps=patch.productionRateSnapshots||store.productionRateSnapshots||{};
    const outputAmount=Number(row.outputAmount??row.amount),observedRatePerHour=outputAmount*3600/run.durationSec;
    const sk=productionSnapshotKey(id,run.productId,run.product),prev=snaps[sk];
    const same=prev&&String(prev.source||'')==='production history'&&String(prev.started||'')===run.started&&Number(prev.resourceId)===run.productId&&(prev.quality??null)===run.quality&&Number(prev.durationSec)===run.durationSec&&Number(prev.outputAmount)===outputAmount&&Number(prev.observedRatePerHour)===observedRatePerHour;
    if(!same){patch.productionRateSnapshots={...snaps,[sk]:{buildingId:id,resourceId:run.productId,product:run.product,quality:run.quality,started:run.started,durationSec:run.durationSec,outputAmount,observedRatePerHour,source:'production history',capturedAt:new Date().toISOString(),captureRealm:target}};changed=true;}
  }
  return changed;
}
// Called after the history endpoint is stored, outside saveData's commit slot (the realm write lock queues behind it).
function recordRunHistoryCapture(realm,buildingId){
  const target=validRealmNumber(realm),id=Number(buildingId);
  if(target==null||!Number.isFinite(id)||id<=0)return Promise.resolve({ok:false,error:'Invalid realm or building.'});
  if(coreSyncActive()){deferUntilSyncEnds(`run-history:${target}:${id}`,()=>recordRunHistoryCapture(target,id));return Promise.resolve({ok:true,deferred:true});}
  const clearGen=extensionClearGeneration;
  return withRealmWriteLock(target,async()=>{
    if(clearGen!==extensionClearGeneration)return {ok:true,changed:false};
    const key=realmKeyFromRealm(target);const s=await state(target);const store=s.realmStores?.[key];
    if(!store)return {ok:true,changed:false};
    const b=realmStoredBuildings(store,s,target).find(x=>Number(x?.id)===id);
    const patch={};
    if(!b||!addRunHistoryCapture(patch,store,b,target))return {ok:true,changed:false};
    const stores={...(s.realmStores||{})};stores[key]={...store,...patch};
    await storageSet({realmStores:stores});
    return {ok:true,changed:true,plan:Boolean(patch.productionPlans),snapshot:Boolean(patch.productionRateSnapshots)};
  });
}
// After the buildings list is stored: a history stored before the list showed the new run gets its snapshot now, and
// plans of buildings that are gone or no longer production buildings are dropped. Reads only stored data: no game
// request. Called outside saveData's commit slot (the realm write lock queues behind it).
function reconcileProductionBuildings(realm){
  const target=validRealmNumber(realm);
  if(target==null)return Promise.resolve({ok:false,error:'Invalid realm.'});
  if(coreSyncActive()){deferUntilSyncEnds(`production-buildings:${target}`,()=>reconcileProductionBuildings(target));return Promise.resolve({ok:true,deferred:true});}
  const clearGen=extensionClearGeneration;
  return withRealmWriteLock(target,async()=>{
    if(clearGen!==extensionClearGeneration)return {ok:true,changed:false};
    const key=realmKeyFromRealm(target);const s=await state(target);const store=s.realmStores?.[key];
    if(!store)return {ok:true,changed:false};
    const buildings=realmStoredBuildings(store,s,target);
    if(!buildings.length)return {ok:true,changed:false};
    const production=buildings.filter(b=>String(b?.category||'').toLowerCase()==='production');
    const live=new Set(production.map(b=>productionPlanKey(b?.id)));
    const patch={};
    const stale=Object.keys(store.productionPlans||{}).filter(k=>Number.isFinite(Number(k))&&!live.has(productionPlanKey(k)));
    if(stale.length){const plans={...store.productionPlans};for(const k of stale)delete plans[k];patch.productionPlans=plans;}
    let snapshots=0;
    for(const b of production){
      // Only running buildings with a stored history: the same write recordRunHistoryCapture makes for them.
      const e=store.endpointData?.[`/api/v2/companies/buildings/${Number(b?.id)}/history/`];
      if(!globalThis.SCMPlannerCore.buildingRun(b)||!Array.isArray(e?.data))continue;
      const before=patch.productionRateSnapshots;
      addRunHistoryCapture(patch,store,b,target);
      if(patch.productionRateSnapshots!==before)snapshots++;
    }
    if(!Object.keys(patch).length)return {ok:true,changed:false};
    const stores={...(s.realmStores||{})};stores[key]={...store,...patch};
    await storageSet({realmStores:stores});
    return {ok:true,changed:true,pruned:stale.length,snapshots};
  });
}

// The overlay, the saved-contract helper and the order-book refresh all read this one calculation (planner-core),
// so they cannot disagree with each other or with the Production page. Game figures only: a running building makes
// its run's rate for the whole run (its history row, else the stored snapshot of that run, else the game formula as
// of the run's start); a building being expanded or idle makes 0. Plans are identity only and never change a figure
// here. Only the countdown (collect stamps) and the warehouse move during a run. No game request is made.
async function overlayProductionStock(store,realm,globalState){
  const core=globalThis.SCMPlannerCore,assets=await gameOverlayAssets(),n=Number(realm);
  const buildings=realmStoredBuildings(store,globalState,n);
  const logKey=`scmEconomyStateLog:${n}`,collectKey=buildingCollectsKey(n);
  let saved={};
  try{saved=await chrome.storage.local.get({scmGameConstants:null,[logKey]:[],[collectKey]:{}});}catch{}
  let collectStamps={};
  try{const raw=saved[collectKey]&&typeof saved[collectKey]==='object'?saved[collectKey]:{};collectStamps=liveCollectStamps(raw,buildings);if(Object.keys(collectStamps).length!==Object.keys(raw).length)pruneBuildingCollects(n,buildings);}catch{}
  const ctx=core.productionContext(store,{realm:n,now:Date.now(),buildings,constants:saved.scmGameConstants||null,economyLog:Array.isArray(saved[logKey])?saved[logKey]:[],normalRates:assets.rates});
  const network=core.buildNetwork({buildings:ctx.buildings,plans:store?.productionPlans||{},recipes:assets.recipes,hours:overlayProductionRunHours(store),ctx,resourceNames:assets.names,collectStamps,snapshotMs:buildingsSnapshotMs(store)});
  const grouped=overlayWarehouseRows(store?.warehouseResources);
  // Manager-saved contracts only. Captured live API contracts (store.contracts) are never an input: once sent, those
  // resources are already gone from the warehouse, so counting them would take them off twice.
  const savedContracts=Array.isArray(store?.savedContracts)?store.savedContracts:[];
  const stock=core.stockAfterDemand({warehouse:grouped.map(r=>({id:r.id,quality:r.quality,qty:r.qty})),productionRows:network.productionRows,demandRows:network.demandRows,savedContracts,upgradingKeys:network.upgradingKeys,runsByKey:network.etaRunsByKey});
  return {assets,ctx,network,stock,grouped,savedContracts};
}
// Countdown run as the game-page strip reads it. Only fields that stay fixed while the run lasts, so an unchanged run
// does not rewrite the stored overlay snapshot on every rebuild.
function overlayEtaRun(run){
  const out={amount:run?.amount??null,amountAvailableNow:Number(run?.amountAvailableNow)||0,canFetch:run?.canFetch===true,finishMs:run?.finishMs,ratePerHour:Number(run?.ratePerHour)||0};
  if(run?.collectedAtMs!=null)out.collectedAtMs=run.collectedAtMs;
  return out;
}

async function buildGameOverlayData(store,realm,globalState){
  store=store||{};
  const {assets,network,stock,grouped,savedContracts}=await overlayProductionStock(store,realm,globalState);
  // Market price per row comes from the shared reader at the row's exact quality. No request, no other quality.
  const marketOwn=await marketOwnOpts(store,realm);
  const overlayImageStore=await resourceImagesStore();
  // stockAfterDemand already holds Warehouse, Demand, Contracts, Left, Surplus and which rows show: every produced
  // resource+quality, every Manager-saved contract key, and every input running buildings need (producing:false with
  // reason 'upgrading' or 'not producing' when nothing makes it, so the shortfall shows).
  const rows=stock.rows.map(r=>{
    const file=assets.images[String(r.id)];
    // Never embed base64 images in the overlay payload when the game URL is known.
    const local=file?'':(overlayImageStore.cache?.[String(r.id)]||store?.resourceImageCache?.[String(r.id)]||store?.resourceImageData?.[String(r.id)]||'');
    const name=String(assets.names.get(String(r.id))||grouped.find(x=>Number(x.id)===Number(r.id))?.name||`Resource #${r.id}`);
    const quality=Number(r.quality)||0;
    const marketHit=overlayMarketPriceHit(store,r.id,quality,realm,marketOwn);
    const marketPrice=marketHit?.price??null,marketPriceQuality=marketPrice!=null?quality:null;
    const marketPriceSource=marketPrice!=null?(marketHit.source||null):null,marketPriceStale=marketPrice!=null&&marketHit.stale===true;
    const vwap=overlayVwap(store,r.id,quality,realm);
    const etaRuns=(network.etaRunsByKey.get(`${Number(r.id)}:${quality}`)||[]).map(overlayEtaRun);
    return {...r,etaRuns,name,quality,vwap,marketPrice,marketPriceQuality,marketPriceExact:marketPriceQuality===quality,marketPriceSource,marketPriceStale,image:local||(file?`${assets.imageBase}${file}`:'')};
  });
  const ticker=rows.map(r=>({...r,qty:r.warehouse,cost:null}));const sellingHistory=mergeSellingHistory(store);
  const savedContractsSignature=JSON.stringify(savedContracts.map(c=>[c?.id,c?.direction,c?.product,c?.quality,c?.quantity,c?.quantityMode,c?.price,c?.savedAt]));
  return {realm:Number(realm),ticker,rows,tickerSource:'game-runs',contractSource:'manager-saved-contracts-only',savedContractsSignature,sellingHistory:Object.values(sellingHistory),updatedAt:new Date().toISOString(),demandHorizonHours:network.hours,plannedOutputRows:network.productionRows.length,plannedDemandRows:network.demandRows.length};
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
  if(key==='gameOverlaySnapshot') return null;
  if(key==='gameLocalStorageSnapshot') return null;
  if(key==='criticalDataBaseline') return {...DEFAULTS.criticalDataBaseline};
  if(key==='marketQueueStatus') return {...DEFAULTS.marketQueueStatus};
  if(key==='accountingWeekLedgerStatus') return null;
  if(key==='accountingDayWalkStatus') return null;
  if(key==='accountingDailySeries') return null;
  if(key==='accountingWeekRevision') return 0;
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
  // Realm stores are already authoritative. Switching realms must not read,
  // merge, or rewrite the other physical container. Commit only the target
  // realm plus the tiny global activation metadata.
  await storageSet({realmStores:{[nextKey]:sanitizeRealmStore(target,Number(realm))},activeRealmKey:nextKey,selectedRealm:Number(realm)});
  return currentKey!==nextKey;
}

async function activateRealmByRealm(realm, authData=null, options={}){
  return enqueueApiStorage(()=>activateRealmByRealmUnlocked(realm,authData),validRealmNumber(realm),{priority:Boolean(options?.priority)});
}

// Game-initiated realm detection must never wait on the shared API/storage
// commit lane. The target realm already has its own authoritative physical
// container, so auto-follow only needs to flip the tiny global activation
// metadata. Verified/manual realm activation continues to use the full
// serialized path above.
let autoRealmActivationQueue=Promise.resolve();
function activateRealmByRealmFast(realm){
  const n=validRealmNumber(realm);
  if(n==null)return Promise.resolve(false);
  // IMPORTANT: this path may run from an auth-data response while another
  // realm-local API writer is committing contracts/VWAP. Writing a realm store
  // read here back with rawStorageSet could silently erase fields that had just
  // been captured, so auto-activation is metadata-only; auth-data itself is
  // persisted by saveData() through the normal realm write lane.
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
// Collect stamps. The game collects a building with POST /api/v2/order/take/<buildingId>/ (the same path shape is not
// known to be used for anything else; an id that is not a stored building writes nothing). busy.resource.amount is what
// the run still has to make as of the last collect, so a buildings snapshot taken before a collect still holds output
// that is now in the warehouse. One key per realm, scmBuildingCollects:<realm> = {buildingId: collectMs}, so it
// survives service worker restarts. Display only: a script in the game page can post any bridge message, so a forged
// stamp cannot be ruled out; it only lowers this countdown until the building data is captured again.
const buildingCollectsKey=realm=>`scmBuildingCollects:${realm}`;
const collectTakeBuildingIdFromUrl=url=>{const m=String(url||'').match(/^(?:https?:\/\/[^/]+)?\/api\/v2\/order\/take\/(\d+)\/?(?:[?#]|$)/);return m?Number(m[1]):null;};
// Owner realm per collected id: the tagged realm first, then the other (a tag can be wrong; building ids are unique).
function collectStampsByRealm(batch,idsByRealm){
  const out={0:{},1:{}};
  for(const [id,{at,tagged}] of batch){
    const order=tagged===0||tagged===1?[tagged,1-tagged]:[0,1];
    const owner=order.find(r=>idsByRealm?.[r]?.has(String(id)));
    if(owner!=null)out[owner][String(id)]=at;
  }
  return out;
}
// A stamp ends with its run: drop it once the building is gone or idle, or a later run started.
function liveCollectStamps(stamps,buildings){
  const next={};
  for(const [id,at] of Object.entries(stamps&&typeof stamps==='object'?stamps:{})){
    const b=(Array.isArray(buildings)?buildings:[]).find(x=>String(x?.id)===id),started=Date.parse(String(b?.busy?.started||''));
    if(Number.isFinite(started)&&Number(at)>0&&started<=Number(at))next[id]=Number(at);
  }
  return next;
}
// When the buildings snapshot was received (latest buildings capture), NaN when unknown.
function buildingsSnapshotMs(store){
  let at=NaN;
  for(const [url,entry] of Object.entries(store?.endpointData&&typeof store.endpointData==='object'?store.endpointData:{})){
    if(!/\/api\/v2\/companies\/(?:me|\d+)\/buildings\/?$/i.test(String(url||'')))continue;
    const t=Date.parse(String(entry?.receivedAt||''));if(Number.isFinite(t)&&!(t<=at))at=t;
  }
  return at;
}
// >>> scm-collect-core (2.5.465; pure, loaded by tests/collect-warehouse-apply.test.js)
// A game Collect (POST /api/v2/order/take/<buildingId>/) put into the stored warehouse at once, before the queued
// collectWarehouse game read confirms it. Per take: the reply body when it names what was taken, else an estimate from
// the stored buildings snapshot. busy.resource.amount is what the run still had to make as of its last collect (it
// counts down), amountAvailableNow the uncollected part at the snapshot. The run makes the rest evenly up to its
// finish, so at time T the uncollected output is amountAvailableNow + rate*(T - snapshot), rate = (amount -
// amountAvailableNow) / (finish - snapshot), never more than amount; a collect stamp after the snapshot (an earlier
// collect of the same run) starts the count from 0 at that stamp instead.
// Reply shapes (no capture of a reply body yet, 2026-11-12): a list or {resources|items|taken|collected|data:[...]} of
// rows with kind (or resource.kind) + quality + amount/quantity, or one such row. A row that looks like a full
// warehouse lot (has cost / datetime) is the new warehouse amount ('set'); otherwise it is the amount taken ('add').
// A building object (busy / category / position) is never read as taken output.
// A reply amount above this is not a real collect (page data cannot be trusted): ignored, the estimate is used instead.
const COLLECT_AMOUNT_MAX=1e7,COLLECT_PENDING_MAX=200;
function collectTakeRowsFromReply(body){
  const isBuilding=o=>o&&typeof o==='object'&&('busy' in o||'position' in o||(typeof o.category==='string'&&'size' in o));
  const rowOf=o=>{
    if(!o||typeof o!=='object'||Array.isArray(o)||isBuilding(o))return null;
    const res=o.resource&&typeof o.resource==='object'?o.resource:null;
    const kind=Number(o.kind??o.resourceId??res?.kind??res?.id),quality=Number(o.quality??res?.quality??0),amount=Number(o.amount??o.quantity??res?.amount);
    if(!(Number.isSafeInteger(kind)&&kind>0&&kind<100000)||!Number.isFinite(quality)||quality<0||quality>12||!Number.isFinite(amount)||amount<0||amount>COLLECT_AMOUNT_MAX)return null;
    const mode=(o.cost&&typeof o.cost==='object')||o.datetime!=null?'set':'add';
    return {kind,quality:Math.floor(quality),amount,mode};
  };
  let list=null;
  if(Array.isArray(body))list=body;
  else if(body&&typeof body==='object'){for(const k of ['resources','items','taken','collected','data']){if(Array.isArray(body[k])){list=body[k];break;}}if(!list){const one=rowOf(body);return one?[one]:[];}}
  else return [];
  const rows=list.map(rowOf);
  return rows.length&&rows.every(Boolean)?rows:[];
}
function collectEstimateFromBuilding(building,{at,snapshotMs,priorStampMs}={}){
  const busy=building?.busy,res=busy?.resource;
  if(!busy||!res||String(busy.category||'')==='b'||busy.expanding)return null;
  const kind=Number(res.kind??res.resourceId),quality=Number(res.quality??0);
  const startedMs=Date.parse(String(busy.started||'')),finishMs=startedMs+Number(busy.duration)*1000;
  const remaining=Number(res.amount),avail=Math.max(0,Number(res.amountAvailableNow)||0),T=Number(at);
  if(!(kind>0)||!Number.isFinite(startedMs)||!Number.isFinite(finishMs)||!Number.isFinite(remaining)||remaining<=0||!Number.isFinite(T))return null;
  if(startedMs>T)return null;
  const snap=Number(snapshotMs),prior=Number(priorStampMs);
  let madeBy,origin;
  if(avail>0){
    // The snapshot names the uncollected part: count on from the snapshot (or the take time when no snapshot time is known).
    origin=Number.isFinite(snap)&&snap<=T?snap:T;
    const rate=finishMs>origin?(remaining-avail)/(finishMs-origin):0;
    madeBy=t=>Math.min(remaining,avail+Math.max(0,rate)*Math.max(0,Math.min(t,finishMs)-origin));
  }else{
    // The game often sends amountAvailableNow 0 (R2 export 2026-11-12: Silicon, Power ...). amount then counts from the
    // run start, or from a collect of this run seen before the snapshot, evenly up to the finish.
    origin=Number.isFinite(prior)&&prior>=startedMs&&(!Number.isFinite(snap)||prior<=snap)&&prior<=T?prior:startedMs;
    const rate=finishMs>origin?remaining/(finishMs-origin):0;
    madeBy=t=>Math.min(remaining,rate*Math.max(0,Math.min(t,finishMs)-origin));
  }
  // A collect stamp after that point (an earlier collect of the same run) starts the count from 0 at that stamp.
  const from=Number.isFinite(prior)&&prior>origin&&prior<=T&&prior>=startedMs?madeBy(prior):0;
  const amount=Math.floor(Math.max(0,madeBy(T)-from));
  return amount>0?{kind,quality:Math.max(0,Math.floor(quality)),amount,mode:'add'}:null;
}
// takes: [{id, at, body}] of one realm's Collect burst. Returns {changes:[{kind,quality,amount,mode,buildingId,source}],
// fromReply, estimated, unknown:[ids]}.
function collectTakeChanges(takes,{buildings=[],stamps={},snapshotMs=NaN}={}){
  const out={changes:[],fromReply:0,estimated:0,unknown:[]};
  const byId=new Map((Array.isArray(buildings)?buildings:[]).map(b=>[String(b?.id),b]));
  for(const t of Array.isArray(takes)?takes:[]){
    const id=String(t?.id??'');if(!id)continue;
    const fromReply=collectTakeRowsFromReply(t.body);
    if(fromReply.length){out.fromReply++;for(const r of fromReply)out.changes.push({...r,buildingId:id,source:'reply'});continue;}
    const est=collectEstimateFromBuilding(byId.get(id),{at:t.at,snapshotMs,priorStampMs:stamps?.[id]});
    if(est){out.estimated++;out.changes.push({...est,buildingId:id,source:'building'});}
    else out.unknown.push(id);
  }
  return out;
}
// The stored warehouse rows with the changes applied (new array, rows copied; the amount field of a row is 'amount', or
// 'quantity' when the row only has that). A kind/quality not in the warehouse yet gets a new row {kind,quality,amount}.
function applyCollectToWarehouse(rows,changes){
  const next=(Array.isArray(rows)?rows:[]).map(r=>r&&typeof r==='object'?{...r}:r);
  const keyOf=r=>{if(!r||typeof r!=='object')return null;const k=r.kind&&typeof r.kind==='object'?Number(r.kind.id??r.kind.kind):Number(r.kind??r.resourceId);const q=Number(r.quality??0);return Number.isFinite(k)&&Number.isFinite(q)?`${k}:${q}`:null;};
  const idx=new Map();next.forEach((r,i)=>{const k=keyOf(r);if(k&&!idx.has(k))idx.set(k,i);});
  let added=0;
  for(const c of Array.isArray(changes)?changes:[]){
    const k=`${c.kind}:${c.quality}`;let i=idx.get(k);
    if(i==null){next.push({kind:c.kind,quality:c.quality,amount:0,source:'collect'});i=next.length-1;idx.set(k,i);}
    const row=next[i],field=row.amount==null&&row.quantity!=null?'quantity':'amount',cur=Number(row[field])||0;
    row[field]=c.mode==='set'?Number(c.amount):cur+Number(c.amount);added+=c.mode==='set'?0:Number(c.amount);
  }
  return {rows:next,added};
}
// Own listings from the game: /companies/me/market-orders/ and /companies/<own id>/market-orders/ are the same list,
// but the game's /me/ answer was [] while the /<id>/ answer had 4 listings (user capture 2026-11-12). Within 60 s of an
// /<id>/ answer (or a Manager read, which uses /<id>/), a /me/ answer never replaces it. Stored value: {..., via}.
const OWN_ORDERS_ID_PREFERRED_MS=60000;
function ownOrdersCaptureDecision(cur,via,orders,now=Date.now()){
  if(via!=='me')return {write:true};
  if(!cur||typeof cur!=='object')return {write:true};
  const curVia=cur.via==='me'?'me':'id',at=Date.parse(String(cur.at||''));
  // An empty /me/ never wipes a non-empty /<id>/ list (any age): /me/ answered [] while /<id>/ had 4; the queued
  // marketOrders game read (by id) decides whether the listings are really gone.
  if(curVia==='id'&&Array.isArray(orders)&&!orders.length&&Array.isArray(cur.orders)&&cur.orders.length)return {write:false,reason:'me-empty-kept-id',recheck:true};
  if(curVia==='id'&&Number.isFinite(at)&&now-at>=0&&now-at<OWN_ORDERS_ID_PREFERRED_MS)return {write:false,reason:Array.isArray(orders)&&!orders.length&&Array.isArray(cur.orders)&&cur.orders.length?'me-empty-kept-id':'id-preferred'};
  return {write:true};
}
// <<< scm-collect-core
const pendingBuildingCollects=new Map(); // buildingId -> {at, tagged}
let buildingCollectFlushTimer=null;
// Collect all sends one POST per building (13 in the user's 2026-11-12 capture, same millisecond; on a slow phone the
// replies can spread): one flush 1 s after the last take, at most 4 s after the first = one warehouse write + one toast.
const BUILDING_COLLECT_DEBOUNCE_MS=1000,BUILDING_COLLECT_MAX_WAIT_MS=4000;let buildingCollectFirstAt=0;
function noteBuildingTake(url,taggedRealm,body){
  const id=collectTakeBuildingIdFromUrl(url);if(id==null||!(id>0))return;
  const now=Date.now();
  if(!pendingBuildingCollects.has(id)&&pendingBuildingCollects.size>=COLLECT_PENDING_MAX)return;
  try{if(body!=null&&JSON.stringify(body).length>20000)body=null;}catch{body=null;}
  pendingBuildingCollects.set(id,{at:now,tagged:taggedRealm===0||taggedRealm===1?taggedRealm:null,body:body===undefined?null:body});
  if(buildingCollectFlushTimer)clearTimeout(buildingCollectFlushTimer);else buildingCollectFirstAt=now;
  const wait=Math.max(0,Math.min(BUILDING_COLLECT_DEBOUNCE_MS,buildingCollectFirstAt+BUILDING_COLLECT_MAX_WAIT_MS-now));
  buildingCollectFlushTimer=setTimeout(()=>{buildingCollectFlushTimer=null;flushBuildingCollects().catch(()=>{});},wait);
}
async function flushBuildingCollects(){
  const batch=[...pendingBuildingCollects];pendingBuildingCollects.clear();
  if(!batch.length)return;
  const gen=extensionClearGeneration,idsByRealm={},buildingsByRealm={},snapshotByRealm={};
  // Read only the realm(s) the takes are tagged with (each state() read costs seconds on a big store); the other realm
  // is read only when some building id was not found (a wrongly tagged take).
  const readRealm=async r=>{
    const fresh=await state(r),store=fresh.realmStores?.[realmKeyFromRealm(r)]||{};
    buildingsByRealm[r]=realmStoredBuildings(store,fresh,r);
    idsByRealm[r]=new Set(buildingsByRealm[r].map(b=>String(b?.id)));
    snapshotByRealm[r]=buildingsSnapshotMs(store);
  };
  const tagged=new Set(batch.map(([,v])=>v?.tagged));
  const first=tagged.has(null)?[0,1]:[0,1].filter(r=>tagged.has(r));
  for(const r of [0,1]){buildingsByRealm[r]=[];idsByRealm[r]=new Set();snapshotByRealm[r]=0;}
  for(const r of first)await readRealm(r);
  let byRealm=collectStampsByRealm(batch,idsByRealm);
  const placed=Object.keys(byRealm[0]).length+Object.keys(byRealm[1]).length;
  if(placed<batch.length){for(const r of [0,1])if(!first.includes(r))await readRealm(r);byRealm=collectStampsByRealm(batch,idsByRealm);}
  for(const r of [0,1]){
    if(!Object.keys(byRealm[r]).length)continue;
    const key=buildingCollectsKey(r);
    const takes=batch.filter(([id])=>Object.prototype.hasOwnProperty.call(byRealm[r],String(id))).map(([id,v])=>({id,at:v.at,body:v.body??null}));
    const startedMs=Math.min(...takes.map(t=>Number(t.at)||Date.now()));
    let applied=null;
    await withRealmWriteLock(r,async()=>{
      if(gen!==extensionClearGeneration)return;
      const cur=(await chrome.storage.local.get({[key]:{}}))[key]||{};
      const prior=liveCollectStamps(cur,buildingsByRealm[r]);
      // 2.5.465: the collected output goes into the stored warehouse now (stamps from BEFORE this burst decide what an
      // earlier collect already took); the queued collectWarehouse game read confirms it in the next game slot.
      try{applied=await applyCollectBatchToWarehouse(r,takes,buildingsByRealm[r],prior,snapshotByRealm[r],gen);}catch(e){applied={ok:false,reason:'error',error:e?.message||String(e),buildings:takes.length};}
      await rawStorageSet({[key]:{...prior,...byRealm[r]}});
    });
    if(applied)recordCollectApplied(r,applied,startedMs);
  }
  for(const r of [0,1])if(Object.keys(byRealm[r]).length)scheduleGameOverlayRefreshNotification(r,150);
}
// Runs inside withRealmWriteLock(r). One storage write for the whole burst. Not applied (no write): nothing known about
// the takes, no stored warehouse yet (fresh storage: the queued game read fills it, nothing is invented), a warehouse
// capture at/after the first take (it already holds the collect), or a clear meanwhile.
async function applyCollectBatchToWarehouse(r,takes,buildings,stamps,snapshotMs,gen){
  const key=realmKeyFromRealm(r);
  const plan=collectTakeChanges(takes,{buildings,stamps,snapshotMs});
  const replyKeys=[...new Set(takes.flatMap(t=>{const b=Array.isArray(t.body)?t.body[0]:t.body;return b&&typeof b==='object'?Object.keys(b).slice(0,12):[];}))].slice(0,20);
  const base={buildings:takes.length,fromReply:plan.fromReply,estimated:plan.estimated,unknown:plan.unknown.length,replyKeys};
  if(!plan.changes.length)return {ok:false,reason:'nothing-known',...base};
  const fresh=await state(r),existing={...(fresh.realmStores?.[key]||{})};
  const rows=Array.isArray(existing.warehouseResources)?existing.warehouseResources:[];
  if(!rows.length)return {ok:false,reason:'no-warehouse',...base};
  const firstAt=Math.min(...takes.map(t=>Number(t.at)||Infinity)),capAt=Date.parse(String(existing.warehouseCapture?.receivedAt||''));
  if(Number.isFinite(capAt)&&capAt>=firstAt)return {ok:false,reason:'warehouse-newer',...base};
  if(gen!==extensionClearGeneration)return {ok:false,reason:'cleared',...base};
  const {rows:next,added}=applyCollectToWarehouse(rows,plan.changes);
  // warehouseCapture is NOT touched: the confirming game read must still run (its receivedAt stays the last real read).
  const note={at:new Date().toISOString(),buildings:takes.length,units:added,fromReply:plan.fromReply,estimated:plan.estimated,unknown:plan.unknown.length};
  const stores={...(fresh.realmStores||{}),[key]:{...existing,warehouseResources:next,warehouseCollectApplied:note}};
  const patch={realmStores:stores};if(fresh.activeRealmKey===key)patch.warehouseResources=next;
  await storageSet(patch);
  return {ok:true,units:added,rows:next.length,...base};
}
// The burst's line: a warehouse-refresh success (trigger stock-mutation-or-forced, details.source 'collect') so the
// monitor shows ONE toast "Collected from N buildings · warehouse updated"; not applied: a replay event with the reason
// and the reply's keys (so a later export shows the reply shape).
function recordCollectApplied(r,a,startedMs){
  const now=Date.now(),start=Number(startedMs)||now;
  // 'warehouse-newer': the game's own warehouse read after the collect is already stored, so it is updated too.
  if(a?.ok||a?.reason==='warehouse-newer'){
    const n=Number(a.buildings)||0;
    recordBackgroundJobEvent(r,{job:'warehouse-refresh',trigger:'stock-mutation-or-forced',startedAt:new Date(start).toISOString(),finishedAt:new Date(now).toISOString(),durationMs:Math.max(0,now-start),outcome:'success',requested:0,fetched:0,refreshed:1,checked:1,cached:0,error:null,
      details:{source:'collect',buildings:n,units:a.units,rows:a.rows,fromReply:a.fromReply,estimated:a.estimated,unknown:a.unknown,replyKeys:a.replyKeys,what:a?.ok?`Collect: ${n} building${n===1?'':'s'}, +${Math.round(Number(a.units)||0).toLocaleString('en-US')} units; game read queued to confirm`:`Collect: ${n} building${n===1?'':'s'}; warehouse already read from the game after the collect`}})
      // Push to the game tabs so the toast turns to "warehouse updated" now, not at the next 3 s poll.
      .then(()=>notifyGameCardsKeyChanged(backgroundJobHistoryKey(r))).catch(()=>{});
    return;
  }
  try{replayEvent('collect-not-applied',{realm:r,detail:{reason:a?.reason||null,error:a?.error||null,buildings:a?.buildings??null,unknown:a?.unknown??null,replyKeys:a?.replyKeys||[]}});}catch{}
}
// Not awaited by its callers (the overlay build may already hold a realm lane).
function pruneBuildingCollects(realm,buildings){
  const n=validRealmNumber(realm);if(n==null)return Promise.resolve();
  const key=buildingCollectsKey(n),gen=extensionClearGeneration;
  return withRealmWriteLock(n,async()=>{
    if(gen!==extensionClearGeneration)return;
    const cur=(await chrome.storage.local.get({[key]:null}))[key];if(!cur||typeof cur!=='object')return;
    const next=liveCollectStamps(cur,buildings);
    if(Object.keys(next).length===Object.keys(cur).length)return;
    if(Object.keys(next).length)await rawStorageSet({[key]:next});else await chrome.storage.local.remove(key);
  }).catch(()=>{});
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

// Realm-key part of a read-early/write-late step. before = what the step read at its start, fresh = a re-read just before
// the write, wanted = what the step would write. A key someone changed in between is left alone (activeChanged says the
// active realm moved); an unchanged key is written only when the value differs, so a null is never written over null.
function realmMetaPatchUnlessChanged(before,fresh,wanted){
  const same=(a,b)=>(a??null)===(b??null);
  const patch={};let activeChanged=false;
  for(const key of ['activeRealmKey','selectedRealm']){
    if(!same(before?.[key],fresh?.[key])){if(key==='activeRealmKey')activeChanged=true;continue;}
    if(!same(wanted?.[key],fresh?.[key]))patch[key]=wanted?.[key]??null;
  }
  return {patch,activeChanged,fresh};
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
      // Physical realm stores are authoritative. A leftover
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
      migrated[key]=store;
    }
    const selected=validRealmNumber(s.selectedRealm??rootRealm);
    let active=validRealmNumber(s.activeRealmKey?.replace(/^realm:/,'')??rootRealm??selected);
    const patch={realmStores:migrated,realmIsolationSchemaVersion:REALM_ISOLATION_SCHEMA};
    // Clear every realm-scoped root mirror. It will be rehydrated from the
    // selected realm store by activateRealmByRealmUnlocked below.
    for(const k of REALM_SCOPED_KEYS) patch[k]=defaultRealmValue(k);
    // The realm keys were read at the top (s); a game tab may have set them since (fresh install: null -> realm).
    // Re-read them in the commit lane and only write the migrated value when nobody changed them meanwhile.
    const realmMeta=await withRealmStorageCommit(async()=>{
      const fresh=await chrome.storage.local.get({activeRealmKey:null,selectedRealm:null});
      const plan=realmMetaPatchUnlessChanged(s,fresh,{activeRealmKey:active!=null?realmKeyFromRealm(active):null,selectedRealm:selected!=null?selected:null});
      await storageSetUnlocked({...patch,...plan.patch});
      return plan;
    });
    // Whoever moved the active realm meanwhile already activated it; activating the stale one would switch it back.
    if(realmMeta.activeChanged) active=null;
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
const apiStorageCommitQueues=new Map();
const apiStorageSchedulers=new Map();
function shouldPersistPassiveApiCaptureDuringSync(session,url,method='GET'){
  if(!session||String(method||'GET').toUpperCase()!=='GET')return true;
  const allowed=Array.isArray(session.capturePaths)?session.capturePaths:[];
  // The market ticker the game page loads itself is kept even during a Sync (the Manager no longer reads it).
  if(/^\/api\/v3\/market-ticker\/\d+\/?$/.test(String(url||'')))return true;
  // So is a product's order book (live R2 2026-11-12: Power opened on the game tab 8 s before the crawl was dropped
  // here; the crawl's visit then got the game's cached copy and no request, so Power stayed missing).
  if(/^\/api\/v3\/market\/[01]\/\d+\/?$/.test(String(url||'')))return true;
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
    scheduler={queue:[],running:false};
    apiStorageSchedulers.set(key,scheduler);
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
    if(scheduler.queue.length)runApiStorageScheduler(key,scheduler);
  }
}
// Barrier, not "wait until idle": resolve once every job queued before this
// call has committed. Passive game captures keep arriving while the player
// browses, so waiting for a fully idle queue could starve Sync.
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
    await scmCreateShortAlarm(name,Math.max(500,Number(delayMs)||1500));
    return {ok:true,scheduled:true,existing:false,realm:n};
  }catch(e){return {ok:false,error:e?.message||String(e),realm:n};}
}
function syncSessionForRealm(realm){
  const n=validRealmNumber(realm);
  return n==null?null:(realmSyncSessions.get(n)||null);
}
// Walk and Sync captures come only from the Sync's game tab, top frame (session.gameTabId, set where the walk picks
// its tab). Another simcompanies.com tab or a subframe with the content script cannot feed a required path.
function syncCaptureFromSyncTab(session,sender){const id=session?.gameTabId;return id!=null&&sender?.tab?.id===id&&sender?.frameId===0;}
function recordSyncWalkCapture(session,m,sender){
  if(!session||!syncCaptureFromSyncTab(session,sender))return false;
  const url=String(m?.url||'');
  if(validRealmNumber(m.captureRealm)===validRealmNumber(session.realm)&&Number(m.status)>=200&&Number(m.status)<300){const p=url.replace(/^https?:\/\/[^/]+/,'').split('?')[0];const c={status:m.status,data:m.data,receivedAt:new Date().toISOString(),at:Date.now()};
    if(session.syncCaptures&&session.syncCapturePaths?.has(p))session.syncCaptures[p]=c;
    // Before the capture list is ready (auth reload, realm switch) the game already loads target data (live R2 2026-11-12:
    // both contracts at boot, 8 s before the list; later visits got the game cache and no request). Kept for this Sync.
    else if(!session.syncCapturePathsReady&&p.startsWith('/api/'))(session.syncEarlyCaptures||(session.syncEarlyCaptures={}))[p]=c;}
  if(session?.walkCaptures&&validRealmNumber(m.captureRealm)===validRealmNumber(session.realm)){session.walkCaptures[url]={status:m.status,data:m.data,receivedAt:new Date().toISOString(),at:Date.now()};if(/\/buildings\/\d+\/abundance\//.test(url)&&Number(m.status)>=200&&Number(m.status)<300)(session.abundanceCaptures||(session.abundanceCaptures={}))[url]=session.walkCaptures[url];}
  return true;
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
// API_SEEN arrives for every game request (dozens per page). Seen endpoints are collected for 20 s and written once,
// so the realm store is not rewritten per request; an endpoint already listed and seen in the last 10 min is not
// written again.
const pendingEndpointSeen=new Map();let pendingEndpointSeenTimer=0;
function queueEndpointSeen(url,method='GET',captureRealm=null){
  const n=validRealmNumber(captureRealm);
  if(n==null||!String(url||'').startsWith('/api/'))return saveEndpoint(url,method,captureRealm); // quarantine path unchanged
  const m=String(method||'GET').toUpperCase();pendingEndpointSeen.set(`${n}|${m}|${url}`,{url,method:m,realm:n});
  if(!pendingEndpointSeenTimer)pendingEndpointSeenTimer=setTimeout(function flush(){if(coreSyncActive()){pendingEndpointSeenTimer=setTimeout(flush,20000);return;}pendingEndpointSeenTimer=0;flushEndpointSeen().catch(()=>{});},20000);
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
// Bounds for page-sent payloads (RESOURCE_CATALOG, MARKET_CACHE, JAVASCRIPT_DIAGNOSTIC). Any page script can forge
// these before the port handshake, so only JSON-safe plain data within these caps is stored.
// Real sizes (storage export 2026-11-02): 151 resources, max id 155, game constants resources 56 KB, 146 cached images
// 2.79 MB in total (max 86 KB each). The caps leave several times that headroom.
const PAGE_CATALOG_MAX_IDS=1000,PAGE_CATALOG_NAME_MAX=120,PAGE_CATALOG_TEXT_MAX_BYTES=512*1024,PAGE_CATALOG_IMAGES_MAX_BYTES=8*1024*1024;
const PAGE_MARKET_MAX_ROWS=1000,PAGE_MARKET_ENTRY_MAX_BYTES=512*1024,PAGE_MARKET_MAX_ENTRIES=200,PAGE_MARKET_TOTAL_MAX_BYTES=8*1024*1024;
const PAGE_JS_DIAG_MAX_BYTES=2*1024*1024;
function isPlainObject(v){if(!v||typeof v!=='object'||Array.isArray(v))return false;const p=Object.getPrototypeOf(v);return p===Object.prototype||p===null;}
// JSON-safe copy: depth, array length, key count and string length capped; functions and non-finite numbers dropped.
// o.left (optional) is a running size budget in characters: once spent, the rest is left out.
function boundedPageJson(v,o,depth=0){
  if(o.left!=null&&(o.left-=8)<0)return undefined;
  if(v==null)return null;
  const t=typeof v;
  if(t==='string'){const x=v.length>o.str?v.slice(0,o.str):v;if(o.left!=null)o.left-=x.length;return x;}
  if(t==='number')return Number.isFinite(v)?v:null;
  if(t==='boolean')return v;
  if(t!=='object'||depth>=o.depth)return undefined;
  if(Array.isArray(v)){const out=[];for(const x of v.slice(0,o.arr)){const c=boundedPageJson(x,o,depth+1);if(c!==undefined)out.push(c);}return out;}
  if(!isPlainObject(v))return undefined;
  const out={};let n=0;
  for(const k of Object.keys(v)){if(n>=o.keys)break;if(k==='__proto__'||k.length>200)continue;if(o.left!=null)o.left-=k.length;const c=boundedPageJson(v[k],o,depth+1);if(c!==undefined){out[k]=c;n++;}}
  return out;
}
function validPageIso(v){if(typeof v!=='string'||v.length>40)return null;const t=Date.parse(v);return Number.isFinite(t)?new Date(t).toISOString():null;}
// A catalog image is a game image path (validResourceImagePath; a leading / or static/ is stripped), a game https URL
// (safeResourceImageUrl) or an image data URL that passes resourceImageDataUrlParts (allowed type, 1 MB cap).
function pageCatalogImage(v){
  if(typeof v!=='string')return null;const s=v.trim();
  if(/^data:/i.test(s))return resourceImageDataUrlParts(s)?s:null;
  if(/^https?:/i.test(s))return s.length<=1024?safeResourceImageUrl(s):null;
  if(s.length>200)return null;
  const p=s.replace(/^\/+/,'').replace(/^static\//,'');
  return validResourceImagePath(p)?p:null;
}
const PAGE_CATALOG_NAME_KEYS=['name','resourceName','displayName','title','label','enName','englishName'],PAGE_CATALOG_IMAGE_KEYS=['image','icon','iconUrl','imageUrl','picture','img'];
// Keeps only what the readers use: constantsResources (id -> {name,image}), resourceNames (id -> name), resourceImages
// (id -> image). Ids must be resource ids (1..99999, at most 1000 per map); names capped at 120 chars; names and
// constants share a 512 KB budget, images an 8 MB budget (ids past a budget are dropped). Null for a non-object.
function sanitizePageResourceCatalog(c){
  if(!isPlainObject(c))return null;
  const idOf=k=>validResourceId(typeof k==='number'?k:String(k??''));
  const nameOf=v=>typeof v==='string'&&v.trim()?v.trim().slice(0,PAGE_CATALOG_NAME_MAX):null;
  let text=0,imgBytes=0;
  const fits=(k,val,isImage)=>{const n=JSON.stringify(val).length+String(k).length+4;if(isImage){if(imgBytes+n>PAGE_CATALOG_IMAGES_MAX_BYTES)return false;imgBytes+=n;return true;}if(text+n>PAGE_CATALOG_TEXT_MAX_BYTES)return false;text+=n;return true;};
  const out={resourceNames:{},resourceImages:{}};
  const rawC=c.constantsResources;
  if(rawC!=null){
    const constants={};
    const entries=Array.isArray(rawC)?rawC.map(o=>[o&&typeof o==='object'?(o.resourceId??o.productId??o.kind??o.id??o.dbLetter):null,o]):isPlainObject(rawC)?Object.entries(rawC):[];
    let n=0;
    for(const [k,o] of entries){
      if(n>=PAGE_CATALOG_MAX_IDS)break;
      const id=idOf(k);if(id==null||!isPlainObject(o))continue;
      const e={};
      for(const nk of PAGE_CATALOG_NAME_KEYS){const v=nameOf(o[nk]);if(v){e.name=v;break;}}
      for(const ik of PAGE_CATALOG_IMAGE_KEYS){if(o[ik]==null)continue;const v=pageCatalogImage(o[ik]);if(v){e.image=v;break;}}
      if(!fits(id,e,false))break;
      constants[String(id)]=e;n++;
    }
    out.constantsResources=constants;
  }
  if(isPlainObject(c.resourceNames)){let n=0;for(const [k,v] of Object.entries(c.resourceNames)){if(n>=PAGE_CATALOG_MAX_IDS)break;const id=idOf(k),name=nameOf(v);if(id==null||!name)continue;if(!fits(id,name,false))break;out.resourceNames[String(id)]=name;n++;}}
  if(isPlainObject(c.resourceImages)){let n=0;for(const [k,v] of Object.entries(c.resourceImages)){if(n>=PAGE_CATALOG_MAX_IDS)break;const id=idOf(k),img=pageCatalogImage(v);if(id==null||!img)continue;if(!fits(id,img,true))continue;out.resourceImages[String(id)]=img;n++;}}
  return out;
}
// Market rows: plain objects; quality (quality/q) an integer 0-20 when present; price/unitPrice/amountPrice finite
// and >= 0 when present; at most 1000 rows and 512 KB per resource. Rows failing a check are dropped.
function sanitizePageMarketRows(rows){
  if(!Array.isArray(rows))return null;
  const out=[];let size=2;
  for(const r of rows.slice(0,PAGE_MARKET_MAX_ROWS)){
    if(!isPlainObject(r))continue;
    const q=r.quality??r.q;
    if(q!=null&&!((typeof q==='number'||typeof q==='string')&&String(q).trim()!==''&&Number.isInteger(Number(q))&&Number(q)>=0&&Number(q)<=20))continue;
    let bad=false;
    for(const k of ['price','unitPrice','amountPrice']){const v=r[k];if(v!=null&&!((typeof v==='number'||typeof v==='string')&&String(v).trim()!==''&&Number.isFinite(Number(v))&&Number(v)>=0)){bad=true;break;}}
    if(bad)continue;
    const c=boundedPageJson(r,{depth:4,arr:50,keys:60,str:512,left:64*1024});
    const len=JSON.stringify(c).length+1;
    if(size+len>PAGE_MARKET_ENTRY_MAX_BYTES)break;
    size+=len;out.push(c);
  }
  return out;
}
// At most 200 resources and 8 MB per realm marketCache; the oldest entries (receivedAt) go first, never the one in keep.
function boundPageMarketCache(cache,keep){
  const sizeOf=e=>Number.isFinite(e?.bytes)?e.bytes:JSON.stringify(e??null).length;
  const entries=Object.entries(cache).map(([k,e])=>({k,t:Date.parse(e?.receivedAt)||0,b:sizeOf(e)}));
  let total=entries.reduce((a,x)=>a+x.b,0),count=entries.length;
  if(count<=PAGE_MARKET_MAX_ENTRIES&&total<=PAGE_MARKET_TOTAL_MAX_BYTES)return cache;
  const out={...cache};
  for(const x of entries.filter(x=>x.k!==keep).sort((a,b)=>a.t-b.t)){
    if(count<=PAGE_MARKET_MAX_ENTRIES&&total<=PAGE_MARKET_TOTAL_MAX_BYTES)break;
    delete out[x.k];count--;total-=x.b;
  }
  return out;
}
// JavaScript diagnostic: JSON-safe copy (depth 7, arrays 2000, keys 200, strings 4096). Over 2 MB it is truncated in
// steps (per-bundle excerpts, category excerpts, all but the last 100 performance entries, then tighter caps) and
// marked limits.truncatedBySize; refused (null) only if it still does not fit.
function sanitizePageJsDiagnostic(d){
  if(!isPlainObject(d))return null;
  let c=boundedPageJson(d,{depth:7,arr:2000,keys:200,str:4096,left:4*PAGE_JS_DIAG_MAX_BYTES});
  const size=()=>JSON.stringify(c).length;
  if(size()<=PAGE_JS_DIAG_MAX_BYTES)return c;
  const steps=[
    ()=>{if(Array.isArray(c.bundles))c.bundles=c.bundles.map(b=>isPlainObject(b)?{...b,categories:{}}:b);},
    ()=>{c.categoryHits={};},
    ()=>{if(Array.isArray(c.performanceResources))c.performanceResources=c.performanceResources.slice(-100);},
    ()=>{c=boundedPageJson(c,{depth:5,arr:200,keys:100,str:512,left:PAGE_JS_DIAG_MAX_BYTES-4096});}
  ];
  for(const step of steps){
    step();
    if(size()<=PAGE_JS_DIAG_MAX_BYTES){c.limits={...(isPlainObject(c.limits)?c.limits:{}),truncatedBySize:true,maxBytes:PAGE_JS_DIAG_MAX_BYTES};return c;}
  }
  return null;
}
async function saveMarketCache(resource, value, receivedAt, capturedRealm=null){
  const rid=validResourceId(resource);
  if(rid==null) return;
  value=sanitizePageMarketRows(value);
  if(!value) return;
  receivedAt=validPageIso(receivedAt);
  resource=String(rid);
  const initial=await state();
  const realm=validRealmNumber(capturedRealm) ?? validRealmNumber(realmNumberFromKey(initial.activeRealmKey||identityFromAuth(initial.authData)));
  if(realm==null){
    const q={...(initial.realmQuarantine||{}),marketCache:Array.isArray(initial.realmQuarantine?.marketCache)?initial.realmQuarantine.marketCache.slice(-199):[]};
    q.marketCache.push({resource:rid,receivedAt:receivedAt||new Date().toISOString(),reason:'No capture realm'});
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
    const entry={data:value,receivedAt:receivedAt||new Date().toISOString(),source:'page-localStorage',captureRealm:realm};
    entry.bytes=JSON.stringify(entry).length;
    const marketCache=boundPageMarketCache({...(store.marketCache||{}),[resource]:entry},resource);
    stores[key]={...store,marketCache};
    const activeKey=s.activeRealmKey||identityFromAuth(s.authData);
    if(activeKey===key) await storageSet({marketCache,realmStores:stores});
    else await storageSet({realmStores:stores});
  });
}
async function saveResourceCatalog(catalog, receivedAt){
  catalog=sanitizePageResourceCatalog(catalog);
  if(!catalog)return;
  receivedAt=validPageIso(receivedAt);
  // Only the realm is needed here; the full store is read once, inside the lock.
  const {activeRealmKey}=await chrome.storage.local.get({activeRealmKey:null});
  const realm=realmNumberFromKey(activeRealmKey); if(realm==null)return;
  return withRealmWriteLock(realm,async()=>{
    const latest=await state(realm); const key=realmKeyFromRealm(realm);
    const stores={...(latest.realmStores||{})}; const store={...(stores[key]||{})};
    // The stored catalog is rebuilt from the known fields only (drops the old unread `data` copy of the constants);
    // the union is bounded again so repeated emits cannot grow it past the caps.
    const old=(store.resourceCatalog&&typeof store.resourceCatalog==='object'&&sanitizePageResourceCatalog(store.resourceCatalog))||{};
    const merged=sanitizePageResourceCatalog({
      constantsResources:catalog.constantsResources||old.constantsResources||{},
      resourceNames:{...(old.resourceNames||{}),...catalog.resourceNames},
      resourceImages:{...(old.resourceImages||{}),...catalog.resourceImages}
    });
    merged.receivedAt=receivedAt||new Date().toISOString();
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
  if(validResourceId(resourceId)==null||!Number.isFinite(unitCost)||unitCost<0) return {ok:false,error:'Invalid warehouse cost detail.'};
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

async function saveFullSyncDiagnosticUnlocked(diagnostic, realm, clearGen=extensionClearGeneration){
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
  if(clearGen!==extensionClearGeneration) return d; // begun before Clear Stored Data
  await rawStorageSet({[diagnosticKey]:d});
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
    // A fresh game-localStorage snapshot is the fastest live stock signal.
    // Do not wait for, or overwrite it with, an older API snapshot, or newly
    // gathered resources appear late in the Manager. The API capture remains
    // authoritative for later reconciliation/enrichment in saveData().
    patch.warehouseResources=mergeWarehouseSnapshot(warehouse,fresh.warehouseResources);
    const warehouseCapturedAt=new Date().toISOString();
    const priorCapture=fresh.warehouseCapture||{};
    const priorSource=String(priorCapture.source||'');
    const priorWasApiAuthoritative=/api-authoritative|api-enriched|overlay-live-resources/i.test(priorSource)||priorCapture.apiCostProtected===true;
    if(priorWasApiAuthoritative && Array.isArray(fresh.warehouseResources)){
      // Once an authoritative resource-API snapshot exists, keep the complete
      // matching API row together: quantity + cost + quality. A GAME_STATE row
      // can be newer as a message, yet still be an older/stale stock snapshot.
      // Mixing its quantity with API cost produces false unit costs.
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
  const result=await withRealmWriteLock(realm,()=>saveGameStateUnlocked(message));
  if(Array.isArray(message?.buildings)&&message.buildings.length)reconcileProductionBuildings(realm).catch(()=>{});
  return result;
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

const SCM_WORKER_BOOT_MS=Date.now();
setTimeout(()=>{recoverInterruptedSyncJobs('service-worker-boot').catch(()=>{});},0);
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
        if(Number.isFinite(started)&&started>=SCM_WORKER_BOOT_MS) continue;
        candidates.push(realm);
      }
      for(const realm of candidates){
        const latest=await state(realm);
        const job=latest.fullSyncJob;
        if(!job||job.status!=='running') continue;
        const started=Date.parse(String(job.startedAt||''));
        if(Number.isFinite(started)&&started>=SCM_WORKER_BOOT_MS) continue;
        const status=`${realmDisplayNumber(realm)||'Realm'} Sync interrupted · retry required`;
        const patch={fullSyncJob:null,syncStatus:status,syncError:'The previous sync transaction was interrupted before completion.'};
        await storageSetRealmPatch(realm,patch);
        // Live progress sits in the root keys, so clear it when it belongs to this realm.
        const rootSync=await chrome.storage.local.get({syncStatus:''});
        if(latest.activeRealmKey===realmKeyFromRealm(realm)||String(rootSync.syncStatus||'').startsWith(`${realmDisplayNumber(realm)||'Realm'} Sync`)){
          await storageSet({syncStatus:status,syncError:patch.syncError,fullSyncJob:null});
          await chrome.storage.local.set({syncStatus:status,syncError:patch.syncError});
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
// One statement at a time (2.5.458), in Sync and in every other refresh; 4 at once was part of a 503 burst.
const ACCOUNTING_REFRESH_CONCURRENCY=1;
const ACCOUNTING_WEEK_REFRESH_ALARM_PREFIX='scm-accounting-week-refresh-r';
// After Sync, walk the game's Accounting page: Day → day buttons 0–6 (the game offers 0–13). Each tap counts
// only when the game's own /income-statement/day/<n>/ response is captured for this realm. Buttons are found by the
// page structure (period bar = <label> + 4 mode buttons + 14 day buttons), never by their text (dates are locale text).
const ACCOUNTING_DAY_WALK_ALARM_PREFIX='scm-accounting-day-walk-r';
const ACCOUNTING_DAY_REWALK_ALARM_PREFIX='scm-accounting-day-rewalk-r'; // re-walk of only the days a partial walk missed
const ACCOUNTING_DAY_WALK_DAYS=7;
const ACCOUNTING_DAY_WALK_WAIT_MS=45000;
const accountingDayWalkRunning=new Set();
const dayWalkPageReturns=new Map(); // realm -> the page its Accounting day walk moved the tab away from
// Daily scheduled Accounting walk (user setting scmAccountingWalkSchedule {enabled, offsetMin, realm}).
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
  if(sch.retryAt&&Date.parse(sch.retryAt)>Date.now()){await scmAlarmCreate(ACCOUNTING_WALK_DAILY_ALARM,{when:Date.parse(sch.retryAt)});return {ok:true,enabled:true,nextAt:sch.retryAt,retry:true,reason};}
  const ready=await accountingStatementsReadyAt(sch.realm);
  const at=nextAccountingWalkAt(ready,sch.offsetMin);
  if(at==null){await chrome.alarms.clear(ACCOUNTING_WALK_DAILY_ALARM).catch(()=>{});await writeAccountingWalkSchedule({nextAt:null,waitingFor:'statement-time'});return {ok:false,enabled:true,error:'Sync once so the Manager knows when the game finishes your statements.',reason};}
  await scmAlarmCreate(ACCOUNTING_WALK_DAILY_ALARM,{when:at});
  await writeAccountingWalkSchedule({nextAt:new Date(at).toISOString(),readyAt:new Date(ready).toISOString(),waitingFor:null});
  return {ok:true,enabled:true,nextAt:new Date(at).toISOString(),reason};
}
async function runScheduledAccountingWalk(trigger='alarm'){
  const sch=await readAccountingWalkSchedule();
  const realm=validRealmNumber(sch.realm);
  if((!sch.enabled&&trigger==='alarm')||realm==null)return {ok:false,skipped:true};
  if(syncSessionForRealm(realm)||accountingDayWalkRunning.has(realm)){await scmAlarmCreate(ACCOUNTING_WALK_DAILY_ALARM,{when:Date.now()+60000});return {ok:false,busy:true};}
  if(trigger==='alarm'&&Number(sch.attempt)>0){
    const gate=await accountingWalkIdleGate(ACCOUNTING_WALK_DAILY_ALARM,realm).catch(()=>({run:true}));
    if(gate.deferred){const retryAt=new Date(gate.at).toISOString();await writeAccountingWalkSchedule({retryAt,nextAt:retryAt}).catch(()=>{});return {ok:false,deferred:true,idle:true,retryAt};}
    if(gate.exhausted){await writeAccountingWalkSchedule({attempt:0,retryAt:null,lastResult:{at:new Date().toISOString(),trigger,attempt:Number(sch.attempt)||0,error:'Walk retry given up: the game tab was in use for 60 min.',exhausted:true}});await ensureAccountingWalkSchedule('idle-exhausted');return {ok:false,exhausted:true};}
  }
  const before=await accountingStatementsReadyAt(realm);
  const attempt=(Number(sch.attempt)||0)+1;
  // Current statements + past finances through the game tab (same 7 Accounting requests as Sync), then the page walk.
  const refresh=await refreshAccountingForRealm(realm,{force:true,reason:`scheduled-walk:${trigger}`}).catch(e=>({ok:false,error:e?.message||String(e)}));
  const after=await accountingStatementsReadyAt(realm);
  const expected=Number.isFinite(Date.parse(sch.nextAt||''))?Date.parse(sch.nextAt)-accountingWalkOffset(sch.offsetMin)*60000:null;
  // The game has not finished today's statements yet (or no game tab): try again later, a few times.
  const rolled=after!=null&&(before==null||after>before||(expected!=null&&after>=expected-2*3600000));
  // Ledger rows since the last capture (the recent page was just refreshed above).
  const ledger=refresh?.ok?await catchUpLedgerArchive(realm,`scheduled:${trigger}`).catch(e=>({ok:false,error:e?.message||String(e)})):null;
  let walk=null;
  // While this alarm path still has retries left it re-runs the whole walk itself, so the walk schedules no re-walks.
  const ownRetry=trigger==='alarm'&&attempt<ACCOUNTING_WALK_MAX_ATTEMPTS;
  if(refresh?.ok&&rolled||trigger==='manual')walk=await runAccountingDayWalk(realm,`scheduled:${trigger}`,{noRewalk:ownRetry}).catch(e=>({ok:false,error:e?.message||String(e)}));
  // A partial walk (some days missing) is not a good run: it takes the retry path. A walk deferred by a Sync re-runs after it.
  const okRun=Boolean(walk&&walk.ok&&(walk.status==='complete'||walk.status==='deferred'));
  const result={at:new Date().toISOString(),trigger,attempt,refresh:refresh?.ok?'ok':(refresh?.error||'failed'),rolledOver:rolled,ledgerPages:ledger?.pages??null,ledger:ledger?(ledger.ok?(ledger.skipped?'skipped':ledger.caughtUp?'caught-up':'capped'):ledger.error):null,walk:walk?walk.status:null,captured:walk?.captured??null,error:okRun?null:(walk?.error||refresh?.error||(rolled?null:'Statements not updated yet'))};
  if(!okRun&&trigger==='alarm'&&attempt<ACCOUNTING_WALK_MAX_ATTEMPTS){
    const retryAt=new Date(Date.now()+ACCOUNTING_WALK_RETRY_MS).toISOString();
    await writeAccountingWalkSchedule({attempt,retryAt,nextAt:retryAt,lastResult:result});
    await scmAlarmCreate(ACCOUNTING_WALK_DAILY_ALARM,{when:Date.parse(retryAt)});
    return {ok:false,retryAt,...result};
  }
  await writeAccountingWalkSchedule({attempt:0,retryAt:null,lastResult:result});
  await ensureAccountingWalkSchedule('after-run');
  return {ok:okRun,...result};
}
// Deferred week-ledger refresh after Sync: the first run (alarm 1.5 s after Sync) is Sync's tail and reads at once.
// A failed run is retried at most 3 more times, 5 / 10 / 20 min later, each retry an unattended read in the shared
// game lane (job 'accountingWeek:<realm>'). A 404 / HTML / moved answer is a failed attempt like any other; 401 /
// 403 / 429 follow the direct-read block. After the 4th failed run it stops: status 'stopped' (calm text), ONE
// Activity line, no alarm; the next Sync (or the dashboard) tries again. Attempt count: scmAccountingWeekRetry:<realm>.
const ACCOUNTING_WEEK_MAX_ATTEMPTS=4,ACCOUNTING_WEEK_RETRY_BACKOFF_MS=[5*60000,10*60000,20*60000];
const ACCOUNTING_WEEK_RETRY_KEY='scmAccountingWeekRetry:';
async function accountingWeekRetryGet(n){try{const k=`${ACCOUNTING_WEEK_RETRY_KEY}${n}`;const v=(await chrome.storage.local.get({[k]:null}))[k];return v&&typeof v==='object'?v:null;}catch{return null;}}
async function accountingWeekRetrySet(n,v){const k=`${ACCOUNTING_WEEK_RETRY_KEY}${n}`;try{if(v)await rawStorageSet({[k]:v});else await chrome.storage.local.remove(k);}catch{}}
// One alarm firing of the deferred week refresh (see above). Returns what happened, for tests and the alarm log.
async function runAccountingWeekRefreshAlarm(realm){
  const n=validRealmNumber(realm);const name=accountingWeekRefreshAlarmName(n);if(n==null||!name)return {ok:false};
  const attempt=Number((await accountingWeekRetryGet(n))?.attempt)||0;
  const lane=attempt>0?`accountingWeek:${n}`:null;
  let res=null,err=null;
  try{res=await runDeferredAccountingWeekRefresh(n,'alarm',{lane});}catch(e){err=e;}
  if(res?.ok){await accountingWeekRetrySet(n,null);return {ok:true,attempt};}
  // Not this job's lane slot: no request went out, not an attempt; asked again when the slot opens.
  if(res?.laneWait){await scmAlarmCreate(name,{when:Math.max(Date.now()+30000,Number(res.nextAt)||0)});return {ok:false,laneWait:true,attempt};}
  const error=String(err?.message||res?.error||'Current accounting ledger refresh failed.');
  const next=attempt+1;
  if(next>=ACCOUNTING_WEEK_MAX_ATTEMPTS){
    await accountingWeekRetrySet(n,null);
    await setAccountingWeekLedgerStatus(n,'stopped',null,{reason:'alarm',attempts:next,lastError:error.slice(0,300),note:`Stopped after ${next} tries; the next Sync tries again.`});
    // Runs that never reached the game (no tab, reads blocked) stop silently: no request failed.
    if(!res?.skipped)logActivity(n,'accounting-week-ledger','failure',{attempts:next},`Week sales ledger not read after ${next} tries (${error.slice(0,160)}); the next Sync tries again.`,Date.now(),'alarm');
    return {ok:false,stopped:true,attempt:next};
  }
  const wait=ACCOUNTING_WEEK_RETRY_BACKOFF_MS[next-1];
  await accountingWeekRetrySet(n,{attempt:next,at:Date.now()});
  await setAccountingWeekLedgerStatus(n,'retrying',null,{reason:'alarm',attempt:next,lastError:error.slice(0,300),retryAt:new Date(Date.now()+wait).toISOString()});
  await scmAlarmCreate(name,{when:Date.now()+wait});
  return {ok:false,retrying:true,attempt:next,waitMs:wait};
}
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
// The Accounting refresh line from the per-statement results: read = answered and saved; not read = no request answered
// (other realm, realm not shown yet, reads blocked, no tab / bridge not ready / page unloaded); the rest failed.
// Pure (no storage), for the monitor text: "3 read · 4 not read: the game page was not ready".
function accountingRefreshLine(results,wanted,failedCount){
  const list=Array.isArray(results)?results:[];
  const read=list.filter(r=>r?.ok).length;
  const nr=list.filter(r=>!r?.ok&&(r?.realmMismatch||r?.realmUnknown||r?.bridgeUnavailable));
  const reasons=[...new Set(nr.map(r=>notReadReason(r).replace(/^Not read: /,'')))];
  const notReadText=nr.length?`${nr.length} not read: ${reasons.slice(0,2).join('; ')}`:'';
  const details={read,wanted:Number(wanted)||list.length,...(nr.length?{notRead:nr.length}:{})};
  if(!nr.length||failedCount)return {outcome:failedCount?'failure':'success',notRead:nr.length,notReadText,details,error:null};
  return {outcome:'not-read',notRead:nr.length,notReadText,details,error:`${read} read · ${notReadText}`};
}
async function refreshAccountingForRealm(realmArg=null,{force=false,reason='manual'}={}){
  const realm=validRealmNumber(realmArg);
  if(realm==null)return {ok:false,error:'A valid realm is required for Accounting refresh.'};
  if(realmSyncSessions.has(realm))return {ok:false,busy:true,realm,error:`${realmDisplayNumber(realm)||'Realm'} Sync is already running.`};
  // Dashboard open (reason 'dashboard', not forced): switch accountingOnOpen; when on, an unattended read through the
  // shared game lane (job 'accounting:<realm>'), at most one statement per slot; the rest wait for the next open.
  const onOpen=reason==='dashboard'&&!force;
  if(onOpen){const cur0=await state(realm);if(ACCOUNTING_SYNC_PATHS.some(p=>!accountingEndpointFreshForRealm(cur0,p,realm))&&await scmSwitchedOff('accountingOnOpen','accounting-refresh',realm,reason))return {ok:false,skipped:true,switchedOff:true,realm,error:SCM_SWITCHED_OFF_TEXT};}
  const laneKey=onOpen?`accounting:${realm}`:null;let laneWait=null,laneLeft=0;
  const tab=await simTab();
  if(!tab?.id){
    // A "not read" line only when some statement was due (fresh statements need no tab).
    try{const cur=await state(realm);const due=force?ACCOUNTING_SYNC_PATHS.length:ACCOUNTING_SYNC_PATHS.filter(p=>!accountingEndpointFreshForRealm(cur,p,realm)).length;if(due)logNotRead(realm,'accounting-refresh','no-game-tab',{rows:0,wanted:due,notRead:due},Date.now(),reason);}catch{}
    return {ok:false,realm,error:'Open Sim Companies in a browser tab before refreshing Accounting.'};
  }
  const current=await state(realm);
  const paths=ACCOUNTING_SYNC_PATHS.slice();
  const pending=force?paths:paths.filter(path=>!accountingEndpointFreshForRealm(current,path,realm));
  if(!pending.length)return {ok:true,realm,reason,requested:0,successful:paths.length,total:paths.length,skippedFresh:true};
  const results=[];
  let cursor=0;
  const worker=async()=>{
    while(true){
      const i=cursor++; if(i>=pending.length)return;
      const path=pending[i];
      if(laneWait){laneLeft++;continue;}
      try{
        const response=await pageGet(path,realm,null,`accounting-refresh:${reason}`,laneKey?{lane:laneKey}:null);
        if(response?.laneWait){laneWait=response;laneLeft++;continue;}
        const responseRealm=validRealmNumber(response?.captureRealm);
        // The game tab is in (or just moved to) the other realm: not read (not failed) for this statement, nothing saved.
        if(response?.realmMismatch||(responseRealm!=null&&responseRealm!==realm)){results.push({path,ok:false,skipped:true,realmMismatch:true,status:0,captureRealm:responseRealm,error:response?.error||'Skipped: the game tab is in the other realm.'});continue;}
        // The game page has just loaded and has not seen its own auth-data yet (slow server, right after Clear data or a
        // reload): it cannot say which realm the answer is for, so nothing is saved. Not read, like the other realm;
        // the statement is still not fresh, so the next refresh reads it again.
        if(response?.realmUnknown){results.push({path,ok:false,skipped:true,realmUnknown:true,status:0,captureRealm:null,error:response.error||'Skipped: the game tab has not shown which realm it is in yet.'});continue;}
        // The game blocks the Manager's own reads: not read (no request was made during the pause); the statements
        // come from the Accounting page Sync walks or the player opens.
        
        const ok=Boolean(response?.ok)&&responseRealm===realm;
        if(ok) await saveData(path,response.data,response.status,'GET',realm);
        results.push({path,ok,status:Number(response?.status)||0,captureRealm:responseRealm,error:ok?null:(response?.error||'Accounting response realm mismatch.')});
      }catch(e){
        // No game tab, or its bridge is not ready / not connected yet (e.g. right after the extension restarted),
        // or the page unloaded: no request was answered, so not read like realmUnknown; still not fresh, so the
        // next refresh reads it again.
        if(pageBridgeUnavailable(e)){results.push({path,ok:false,skipped:true,bridgeUnavailable:true,...(e?.pageClosed?{pageClosed:true}:{}),...(e?.noGameTab?{noGameTab:true}:{}),status:0,captureRealm:null,error:e?.message||String(e)});continue;}
        results.push({path,ok:false,status:0,captureRealm:null,error:e?.message||String(e)});
      }
    }
  };
  await Promise.all(Array.from({length:Math.min(ACCOUNTING_REFRESH_CONCURRENCY,pending.length)},()=>worker()));
  if(laneWait&&!results.length){logLaneWait(realm,'accounting-refresh',laneWait.nextAt,{wanted:pending.length},Date.now(),reason);return {ok:false,skipped:true,laneWait:true,nextAt:Number(laneWait.nextAt)||0,realm,reason,requested:0,waiting:laneLeft,total:paths.length,error:laneWait.error};}
  const freshState=await state(realm);
  const successful=paths.filter(path=>accountingEndpointFreshForRealm(freshState,path,realm,Number.MAX_SAFE_INTEGER)).length;
  // Statements skipped because the game tab switched realm are not failures: no failure/partial entry, the realm
  // load status is left alone, and the caller sees realmMismatch so it can try again on its next cycle.
  const skippedOtherRealm=results.filter(r=>r.realmMismatch||r.realmUnknown);
  const failed=results.filter(r=>!r.ok&&!r.realmMismatch&&!r.realmUnknown&&!r.bridgeUnavailable);
  const bridgeSkipped=results.filter(r=>r.bridgeUnavailable);
  // Keep the Executives readout from the last Sync on the header line this refresh overwrites.
  const executivesSummary=freshState.realmStores?.[realmKeyFromRealm(realm)]?.executivesSyncSummary||'';
  const status=(successful===paths.length?`${realmDisplayNumber(realm)||'Realm'} Accounting captured · ${successful}/${paths.length} APIs`:`${realmDisplayNumber(realm)||'Realm'} Accounting partial · ${successful}/${paths.length} APIs`)+executivesSummary;
  // One monitor line for every refresh that wanted statements: "3 read · 4 not read: <reason>" (not-read, not
  // failed, when nothing really failed), real failures still partial / failure.
  const line=accountingRefreshLine(results,pending.length,failed.length);
  if(failed.length===0&&line.outcome==='not-read')logActivity(realm,'accounting-refresh','not-read',line.details,line.error,Date.now(),reason);
  if(skippedOtherRealm.length&&!failed.length)return {ok:false,skipped:true,realmMismatch:skippedOtherRealm.some(r=>r.realmMismatch),realmUnknown:skippedOtherRealm.every(r=>r.realmUnknown),realm,reason,requested:pending.length,successful,total:paths.length,failed,skippedOtherRealm:skippedOtherRealm.length,results,error:skippedOtherRealm[0].error};
  // Game tab not reachable (no request answered) and no real failure: no failure/partial entry, the load status from
  // the last Sync stays, the skipped statements stay not fresh so the next refresh retries them.
  if(bridgeSkipped.length&&!failed.length)return {ok:false,skipped:true,bridgeUnavailable:true,realm,reason,requested:pending.length,successful,total:paths.length,failed,bridgeSkipped:bridgeSkipped.length,results,error:bridgeSkipped[0].error};
  await setRealmLoadStatus(realm,status,successful===paths.length?null:`${failed.length} Accounting API request(s) failed.`);
  if(line.outcome!=='not-read')logActivity(realm,'accounting-refresh',failed.length?(successful?'partial':'failure'):'success',{rows:successful,wanted:pending.length,...line.details},failed.length?`${failed.length} of ${pending.length} statements failed${line.notRead?` · ${line.notReadText}`:''}`:null,Date.now(),reason);
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

// A failed answer never replaces a good record. Its status, receivedAt and data stay as they were, so nothing counts it as
// freshly captured; the failure is kept apart in lastAttempt, and the next success replaces the whole record.
function endpointFailureKeepsRecord(old,incomingStatus){
  const n=Number(incomingStatus);
  return !(n>=200&&n<300)&&Boolean(old)&&Number(old.status)>=200&&Number(old.status)<300&&old.data!=null;
}
function endpointRecordWithFailedAttempt(old,incomingStatus,realm){
  return {...old,lastAttempt:{status:Number(incomingStatus)||0,receivedAt:new Date().toISOString(),captureRealm:realm}};
}
async function saveDataUnlocked(url,data,status=200,method='GET',captureRealm=null,onTiming=null){
  if(!url?.startsWith('/api/'))return;
  // Never store replies the Manager does not read (see SCM_STORAGE_CORE.UNUSED_ENDPOINT).
  if(globalThis.SCM_STORAGE_CORE?.UNUSED_ENDPOINT?.test(String(url||'')))return;
  // A successful GET that is not data (text, null, a boolean, an unlisted number), from any writer: it never replaces a record.
  if(Number(status)>=200&&Number(status)<300&&String(method||'GET').toUpperCase()==='GET'&&!endpointDataIsValid(url,data))return;
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
  // realm store (e.g. R1 building history stamped as captureRealm 1 would
  // otherwise appear in the R2 overlay).
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
  // New incoming contract notification (own state key, not awaited, no network).
  if(incomingContractRealm&&Number(status)>=200&&Number(status)<300)notifyIncomingContracts(validRealmNumber(incomingContractRealm[1]),data).catch(()=>{});
  if(Number(status)>=200&&Number(status)<300&&capturedRealm!=null)logGameCapture(capturedRealm,url);
  // Also on auth-data: on the phone the game does not load the buildings list at start, but it loads
  // auth-data on every page load and every 3 min. Uses the stored buildings.
  {const isB=/\/api\/v2\/companies\/me\/buildings\/?(?:\?.*)?$/i.test(String(url||'')),isA=/\/api\/v3\/companies\/auth-data\//i.test(String(url||''));const r=capturedRealm??(isA?responseRealm:null);
   if((isB||isA)&&Number(status)>=200&&Number(status)<300&&r!=null)setTimeout(()=>{refreshAbundanceIfStale(r,isA?'game-auth-data':'game-buildings').catch(()=>{});},3000);}
  {const ob=String(url||'').match(/\/api\/v3\/market\/(\d+)\/(\d+)\/?(?:\?.*)?$/);if(ob&&Number(status)>=200&&Number(status)<300&&Array.isArray(data)){const r=Number(ob[1]),id=Number(ob[2]);setTimeout(()=>{notifyOrderBook(r,id,data).catch(()=>{});},1500);}}
  // Your listings as the game itself loaded them (warehouse page): kept for the listings card and the undercut check.
  if(OWN_MARKET_ORDERS_URL_RE.test(String(url||''))&&String(method||'GET').toUpperCase()==='GET'&&Number(status)>=200&&Number(status)<300&&capturedRealm!=null)captureOwnMarketOrders(capturedRealm,url,data).catch(()=>{});
  if(/\/api\/v2\/companies\/me\/cashflow\/recent\/?(?:\?.*)?$/i.test(String(url||''))&&Number(status)>=200&&Number(status)<300){const r=validRealmNumber(capturedRealm);if(r!=null)setTimeout(()=>{notifySales(r,data).catch(()=>{});},1500);}
  // Accounting responses are realm-sensitive even when the API path uses /me/.
  // A missing capture realm must never be assigned to the current active realm:
  // an old R2 response racing an R1 switch would otherwise become R1 data.
  if(isRealmSensitiveAccountingUrl(url) && capturedRealm==null && !currentCaptureSyncSession()){
    await appendRealmQuarantine(validRealmNumber(before.selectedRealm??before.activeRealmKey?.replace(/^realm:/,'')),'apiData',{url,method:String(method||'GET').toUpperCase(),status:Number(status)||0,captureRealm:null,expectedRealm:validRealmNumber(before.selectedRealm),reason:'Accounting response missing capture realm; quarantined to prevent cross-realm contamination'});
    return;
  }
  // A game response with no realm tag and nothing in it that proves its realm is never filed under the
  // active (last-synced) realm, which could be the other realm. page-hook holds such responses until the
  // game's auth-data names the realm, so this only catches stragglers.
  if(!captureSession&&capturedRealm==null&&responseRealm==null&&companyRealm==null&&buildingRealm==null&&explicitUrlRealm==null&&switchHint==null){
    await appendRealmQuarantine(null,'apiData',{url,method:String(method||'GET').toUpperCase(),status:Number(status)||0,captureRealm:null,expectedRealm:null,reason:'No capture realm and nothing in the response proves its realm; not filed under the active realm'});
    return;
  }
  const targetRealm=captureSession?.realm??responseRealm??capturedRealm??companyRealm??buildingRealm??explicitUrlRealm??switchHint??realmNumberFromKey(before.activeRealmKey||identityFromAuth(before.authData));
  const targetKey=targetRealm!=null?realmKeyFromRealm(targetRealm):null;
  // One read of the target realm store serves both the endpoint list and the patch.
  // A capture with no realm tag runs in the 'unscoped' API queue, but its target realm (proven by the
  // response, company, building, URL or switch hint) has its own queue. Building whole maps (endpointData,
  // sellingHistory, ...) from a read taken outside that queue could overwrite a newer write made there, so the
  // read-build-commit tail runs in the target realm's queue. Deadlock-free: only the unscoped queue waits on a
  // realm queue here, and no realm-queue job ever waits on the unscoped queue.
  const laneRealm=validRealmNumber(captureRealm);
  const redispatch=laneRealm==null&&targetRealm!=null;
  const commitTail=async()=>{
  const targetState=targetRealm!=null?await state(targetRealm):before;
  const endpointResult=await saveEndpointUnlocked(url,method,targetRealm,false,targetState);

  // Auth responses are stored strictly under the realm proven by the response.
  // They never switch the user's selected/active realm automatically.
  const s2=redispatch?await state():before;
  const activeKey=s2.activeRealmKey||identityFromAuth(s2.authData);
  const isActiveTarget=!captureSession && (!targetKey || !activeKey || targetKey===activeKey);
  // If a background capture targets the non-active realm, read ONLY that
  // realm's physical store. The active Manager view must never become a cache
  // source for another realm.
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
  const preserveSuccessful=endpointFailureKeepsRecord(old,incomingStatus);
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
    preserveSuccessful?endpointRecordWithFailedAttempt(old,incomingStatus,targetRealm):
    (preserveCompletedStatement
      ?{...preservedEntry,lastAttempt:{status:incomingStatus,receivedAt:new Date().toISOString(),captureRealm:targetRealm}}
      :{status,data,receivedAt:new Date().toISOString(),captureRealm:targetRealm})};
  // Ledger cursor pages: endpointData keeps only recent ones; accountingCapture never keeps them (rows are archived).
  const ledgerCursorPage=LEDGER_CURSOR_PAGE_RX.test(String(url||''));
  const patch={endpointData:ledgerCursorPage?pruneStoredLedgerPages(endpointData):endpointData};
  if(isRealmSensitiveAccountingUrl(url) && !ledgerCursorPage && incomingStatus>=200 && incomingStatus<300 && data!=null){
    patch.accountingCapture=withoutLedgerCursorPages({
      ...(working.accountingCapture||{}),
      [url]:endpointData[url]
    });
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
    // Production cost history: every past batch from the building history endpoint.
    const hm=String(url||'').match(/\/api\/v2\/companies\/buildings\/(\d+)\/history\/?(?:\?.*)?$/i);
    if(hm&&incomingStatus>=200&&incomingStatus<300&&Array.isArray(data)){
      const bid=Number(hm[1]);const bn=(Array.isArray(working?.buildings)?working.buildings:[]).find(x=>Number(x?.id)===bid)?.name||'';
      queueProductionCostHistory(targetRealm,globalThis.SCM_TOOLS_CORE.productionCostEntriesFromHistory(bid,data,bn));
    }
  }
  if(isResourceUrl(url)){
    const rows=normalizeWarehouse(data);
    if(looksLikeWarehouseRows(rows)){
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
    const image=pageCatalogImage(resourceImageHint(data));
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
  if(midForPreserve){
    const arr=Array.isArray(data)?data:null;
    patch.marketDebug={...(working.marketDebug||{}),[String(midForPreserve.resource)]:{source:'api',status:incomingStatus,type:Array.isArray(data)?'array':typeof data,records:arr?arr.length:0,keys:data&&typeof data==='object'&&!Array.isArray(data)?Object.keys(data).slice(0,30):[],sample:arr?arr.slice(0,5):data,receivedAt:new Date().toISOString()}};
  }

  const overlayRelevant=Boolean(
    Object.prototype.hasOwnProperty.call(patch,'warehouseResources') ||
    Object.prototype.hasOwnProperty.call(patch,'contracts') ||
    Object.prototype.hasOwnProperty.call(patch,'savedContracts') ||
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
    // A new warehouse snapshot is what the overlay shows: tell it at once (150 ms coalesces the same page's other saves).
    if(overlayRelevant) scheduleGameOverlayRefreshNotification(targetRealm,Object.prototype.hasOwnProperty.call(patch,'warehouseResources')?150:650);
    if(buildingMatch&&incomingStatus>=200&&incomingStatus<300&&Array.isArray(data))recordRunHistoryCapture(targetRealm,Number(buildingMatch[1])).catch(()=>{});
    if(Array.isArray(patch.buildings)&&patch.buildings.length)reconcileProductionBuildings(targetRealm).catch(()=>{});
    {const sm=String(url||'').replace(/[?#].*$/,'').match(STATEMENT_DAY_RX);if(sm&&incomingStatus>=200&&incomingStatus<300&&data&&typeof data==='object')queueStatementHistory(targetRealm,[{kind:sm[1],data}]).catch(()=>{});}
    if(/\/api\/v2\/companies\/me\/cashflow\/(?:recent|\d+)\/?$/i.test(String(url||''))&&incomingStatus>=200&&incomingStatus<300&&Array.isArray(data?.data)) queueLedgerArchive(targetRealm,[{url:String(url).replace(/[?#].*$/,''),rows:data.data,receivedAt:endpointData[url]?.receivedAt}]).catch(()=>{});
  }
  };
  if(redispatch)return enqueueApiStorage(commitTail,targetRealm,{url:String(url||'')});
  return commitTail();
}
const warehouseArrivalSeq=new Map(); // realm -> number of the newest game warehouse answer
async function holdArrivedWarehouse(realm,data,seq=0){
  const n=validRealmNumber(realm);if(n==null)return false;
  if(currentCaptureSyncSession())return false; // a Sync commits its own captures
  const rows=normalizeWarehouse(data);if(!looksLikeWarehouseRows(rows))return false;
  const clearGen=extensionClearGeneration;
  const cur=await readPhysicalRealmStore(n);
  if(clearGen!==extensionClearGeneration||(seq&&warehouseArrivalSeq.get(n)!==seq))return false;
  await storageSetRealmPatch(n,{warehouseResources:mergeWarehouseSnapshot(rows,cur?.warehouseResources)});
  // The overlay's data is built in this worker, which reads the buffer: no need to wait for the physical write. Build it
  // first, then tell the page, so its first redraw already has the new rows (a page asking first gets the last snapshot).
  gameOverlayDirty.add(n);
  setTimeout(()=>{refreshGameOverlayDataHeavy(n).then(()=>notifyGameOverlayRefresh(n)).catch(()=>{});},0);
  return true;
}
async function saveData(url,data,status=200,method='GET',captureRealm=null,onTiming=null,durableOptions=null){
  const enqueuedAt=Date.now();
  const queueRealm=validRealmNumber(captureRealm);
  const queueKey=queueRealm!=null?`realm:${queueRealm}`:'unscoped';
  const schedulerAtEnqueue=apiStorageSchedulers.get(queueKey);
  const queuedJobsAheadAtEnqueue=schedulerAtEnqueue?(schedulerAtEnqueue.queue.length+(schedulerAtEnqueue.running?1:0)):0;
  const clearGen=extensionClearGeneration;
  // The game's own warehouse GET after a stock action is noted on arrival (its line + toast, the pending Manager read
  // cancelled): behind a long API storage queue (large realm stores) it used to be seen after the 10 s window, so the
  // single Collect had no line until the slow Manager read finished. The overlay is told after the save below.
  let gameWh=null;
  // The game's warehouse answer (e.g. back on Warehouse after posting on the exchange) is saved ahead of other queued
  // captures (live R2 2026-11-12: it waited 4.7 s behind the two contract saves the same page loads), so the overlay
  // follows at once. It never overtakes an older save of the same URL (enqueueApiStorage).
  const warehouseGet=String(method||'GET').toUpperCase()==='GET'&&Number(status)>=200&&Number(status)<300&&(captureRealm===0||captureRealm===1)&&/\/api\/v3\/resources\/\d+\/?(?:\?.*)?$/i.test(String(url||''));
  // Newest warehouse answer per realm: an older one still queued (two answers seconds apart) is not written over it.
  const warehouseSeq=warehouseGet?(warehouseArrivalSeq.set(queueRealm,(warehouseArrivalSeq.get(queueRealm)||0)+1),warehouseArrivalSeq.get(queueRealm)):0;
  if(warehouseGet){try{gameWh=noteGameWarehouseCapture(captureRealm,data,enqueuedAt,{notify:false});}catch{}
    // Shown at once: the rows go into the realm patch buffer (every reader sees it; it writes itself within 750 ms) and the
    // overlay is told now. Live R2 2026-11-12 the full save below still waited 4-5 s behind the page's other captures.
    holdArrivedWarehouse(captureRealm,data,warehouseSeq).catch(()=>{});}
  return enqueueApiStorage(async()=>{
    if(clearGen!==extensionClearGeneration)return; // queued before Clear Stored Data: must not bring the record back
    const queueWaitMs=Date.now()-enqueuedAt;
    // A newer warehouse answer arrived while this one waited: it is saved next (same URL, FIFO); this one is not.
    if(warehouseGet&&!durableOptions&&warehouseArrivalSeq.get(queueRealm)!==warehouseSeq){
      try{onTiming?.({queueWaitMs,queuedJobsAheadAtEnqueue,ok:true,skipped:'newer-warehouse'});}catch{}
      return {ok:true,skipped:'newer-warehouse'};
    }
    const schedulerAtStart=apiStorageSchedulers.get(queueKey);
    const queuedJobsBehindAtStart=schedulerAtStart?.queue?.length||0;
    const saveStartedAt=Date.now();
    const commitTiming={};
    const reportCommitTiming=detail=>Object.assign(commitTiming,detail||{});
    try{
      const result=await saveDataUnlocked(url,data,status,method,captureRealm,reportCommitTiming);
      // The game's own warehouse GET after a stock action: the action's update (noteGameWarehouseCapture).
      if(gameWh?.logged)scheduleGameOverlayRefreshNotification(gameWh.realm,50);
      let durableVerification=null;
      // Keep the per-endpoint read-back inside the same serialized API queue
      // slot as the write. Otherwise a later same-URL capture can race the
      // verifier and make a correct write look wrong (or validate stale data).
      if(durableOptions&&typeof durableOptions==='object'&&!durableOptions.priorityOnly){
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
  },captureRealm,{priority:Boolean(durableOptions)||warehouseGet,url:String(url||'')});
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
// Sync only (options.acceptRecentGameMs): a record the Sync did not write but that the game page itself loaded within
// that window (same realm, valid data) counts as verified, flagged fromGamePage ("from the game page at HH:MM").
// The stored record has no source marker: any realm-stamped 2xx record is the game's own answer (passive capture, or
// a Manager lane read of the same address).
// Age is taken at Sync start (options.recentGameAtMs): live R2 2026-11-12 the game kept its 14-min-old past-finances-overview
// for the whole Sync and never reloaded it, so judged at the final check (17.7 min) it failed Accounting.
const SYNC_RECENT_GAME_CAPTURE_MS=15*60000;
function syncRecentGameCaptureOk(entry,realm,path,now=Date.now(),maxAgeMs=SYNC_RECENT_GAME_CAPTURE_MS){
  const n=validRealmNumber(realm);
  if(n==null||!entry||typeof entry!=='object'||validRealmNumber(entry.captureRealm)!==n)return false;
  const st=Number(entry.status)||0;if(st<200||st>=300||!endpointDataIsValid(path,entry.data))return false;
  const at=Date.parse(String(entry.receivedAt||''));
  return Number.isFinite(at)&&at<=now+60000&&now-at<=Number(maxAgeMs);
}
async function verifyDurableEndpointWrite(realm,path,startedAtMs,expectedData=null,expectedStatus=null,allowPreserved=false,options=null){
  const n=validRealmNumber(realm);
  if(n==null||!String(path||'').startsWith('/api/'))return {ok:false,reason:'invalid-realm-or-endpoint'};
  // Durability means the physical key, so write the coalesced realm patch first (commit lane; callers of
  // this verifier are API-queue jobs or Sync, never a withRealmStorageCommit task).
  await flushRealmPatches(n);
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
  if(!freshRecord&&!(allowPreserved&&freshAttempt)&&Number(options?.acceptRecentGameMs)>0&&syncRecentGameCaptureOk(entry,n,path,Number(options.recentGameAtMs)>0?Number(options.recentGameAtMs):Date.now(),Number(options.acceptRecentGameMs))){
    return {ok:true,realm:n,path,status,receivedAt:entry.receivedAt||null,lastAttemptAt:entry.lastAttempt?.receivedAt||null,preservedPriorData:false,fromGamePage:true,fromGamePageAt:simcoChannelClock(receivedAt)};
  }
  if(!freshRecord&&!(allowPreserved&&freshAttempt))return {ok:false,reason:'stored-endpoint-is-stale',receivedAt:entry.receivedAt||null,lastAttemptAt:entry.lastAttempt?.receivedAt||null};
  if(expectedData!=null&&freshRecord&&!endpointPayloadsEqual(entry.data,expectedData))return {ok:false,reason:'stored-payload-mismatch'};
  return {ok:true,realm:n,path,status,receivedAt:entry.receivedAt||null,lastAttemptAt:entry.lastAttempt?.receivedAt||null,preservedPriorData:!freshRecord&&freshAttempt};
}
// Callers may pass {timeoutMs, attempts}. The page hook aborts its fetch at timeoutMs and the
// background waits a short grace beyond it, so a slow game response is reported by the page, not cut off here.
const PAGE_GET_BACKGROUND_GRACE_MS=2000;
// The game tab unloaded (realm switch, reload, closed) while a message to it was open: Chrome rejects with "message
// channel closed before a response was received" (or the content script answered pageClosed from pagehide). Not a
// failed request: callers log a pageClosed error as "not read" (no failure); their next cycle reads again.
function pageMessageChannelClosed(e){return Boolean(e?.pageClosed)||/message channel closed|message port closed|Receiving end does not exist|Extension context invalidated|No tab with id/i.test(String(e?.message||e||''));}
// Last 401 / 403 / 429 / 503 answer to any Manager read ({status,at,path}); Sync reads it to skip its automatic retry.
let lastGameBackoffAnswer=null;
const GAME_BACKOFF_STATUSES=new Set([401,403,429,503]);
function noteGameBackoffAnswer(path,status){const st=Number(status)||0;if(GAME_BACKOFF_STATUSES.has(st))lastGameBackoffAnswer={status:st,at:Date.now(),path:String(path||'').slice(0,200)};}
// 2.5.465: there is no Manager-wide read pause any more. A failed answer (403, 503, 429 ...) is recorded for that lane
// job only (SCM_TIMERS_CORE.laneResult: per-key backoff 5/10/15 min); every other job keeps its turn.
// Startup: the old pause record (storage.session 'scmDirectReadsBlocked', up to 2.5.464) is removed once.
const LEGACY_DIRECT_READ_BLOCK_KEY='scmDirectReadsBlocked';
try{chrome.storage?.session?.remove?.(LEGACY_DIRECT_READ_BLOCK_KEY)?.catch?.(()=>{});}catch{}
// 2.5.466: the game's Cloudflare check refuses the Manager's own reads with a 403 "Attention Required" page (the
// game signs its own requests with X-Prot/X-Ts; the Manager never forges them). Only that answer (not a plain 403)
// pauses every Manager game read for 1 h; then one read tries again. Meanwhile the game pages the user opens
// (passive capture) and SimcoTools keep the data current. State: storage.session scmGameRefusal {at,until,path}.
const GAME_REFUSAL_KEY='scmGameRefusal',GAME_REFUSAL_PAUSE_MS=60*60000;
let gameRefusalMem=null,gameRefusalLoaded=false;
function isGameSecurityRefusal(r){if(Number(r?.status)!==403)return false;const t=typeof r?.data==='string'?r.data:'';return /cloudflare|attention required|cf-ray|cf-chl|cf-error/i.test(t);}
async function gameRefusalGet(){if(!gameRefusalLoaded){gameRefusalLoaded=true;try{const v=(await chrome.storage.session.get(GAME_REFUSAL_KEY))?.[GAME_REFUSAL_KEY];if(v&&Number(v.until)>0&&!gameRefusalMem)gameRefusalMem=v;}catch{}}return gameRefusalMem;}
function gameRefusalActive(now=Date.now()){return Boolean(gameRefusalMem&&Number(gameRefusalMem.until)>now);}
async function gameRefusalSet(path){const now=Date.now();gameRefusalLoaded=true;gameRefusalMem={at:now,until:now+GAME_REFUSAL_PAUSE_MS,path:String(path||'').slice(0,200)};try{await chrome.storage.session.set({[GAME_REFUSAL_KEY]:gameRefusalMem});}catch{}gameLaneScheduleAlarm(gameRefusalMem.until+1000).catch(()=>{});}
async function gameRefusalClear(){gameRefusalLoaded=true;if(!gameRefusalMem)return;gameRefusalMem=null;try{await chrome.storage.session.remove(GAME_REFUSAL_KEY);}catch{}}
function gameRefusalText(until){return `Not read: the game's security check (Cloudflare) refuses the Manager's own game reads; this updates from the game pages you open and from SimcoTools${Number(until)>0?` (next try ${laneWaitClock(until)})`:''}`;}
// Jobs SimcoTools (or the built-in copy) already covers: a paused read of these is "skipped", not "not read".
const GAME_REFUSAL_COVERED_JOBS=new Set(['order-book-refresh','game-constants','abundance','market-ticker']);
// ---- Shared game-request lane (rules: SCM_TIMERS_CORE.laneDecide in timers-core.js) ----
// The game's API guide: GET only, at most one request every 5 minutes; suspected bots get a captcha. EVERY Manager
// game read (alarm, timer, card poll, Refresh button, opening a product, dashboard refresh, overlay) goes through the
// lane: laneDecide right before the request, laneResult right after it. A read that does not get the slot makes no
// request: its want stays queued and the lane alarm (scm-game-lane) serves it in the next slot; the caller gets
// {queued:true, laneWait:true, nextAt} so the UI can say "next game read in m:ss". Sync makes no Manager read at all
// (pure page walk: pageGet refuses while a Sync runs). State: chrome.storage.session scmGameLane (survives a worker
// restart), every change through one serialized chain.
const GAME_LANE_WAIT_TEXT='Queued for the next game slot (one Manager game read every 5 min).';
const PAGE_GET_DURING_SYNC_TEXT='Not read: Sync is running (Sync only walks game pages; the read is not queued, its own timer asks again after the Sync).';
let gameLaneMem,gameLaneTail=Promise.resolve();
function gameLaneCore(){const C=globalThis.SCM_TIMERS_CORE;return C&&C.laneDecide?C:null;}
async function gameLaneLoad(){
  if(gameLaneMem!==undefined)return gameLaneMem;
  const C=gameLaneCore();let v=null;
  try{if(C&&chrome.storage?.session)v=(await chrome.storage.session.get(C.LANE.KEY))?.[C.LANE.KEY]||null;}catch{}
  if(gameLaneMem===undefined)gameLaneMem=v;
  return gameLaneMem;
}
function gameLaneSerial(fn){const run=gameLaneTail.then(fn,fn);gameLaneTail=run.catch(()=>{});return run;}
async function gameLaneStore(st){gameLaneMem=st;try{const C=gameLaneCore();if(C&&chrome.storage?.session)await chrome.storage.session.set({[C.LANE.KEY]:st});}catch{}}
// A queued want is served by the lane alarm when its job has a runner (GAME_LANE_RUNNERS, below).
function gameLaneHasRunner(C,k){try{return Boolean(GAME_LANE_RUNNERS[C.laneBase(k)])||Boolean(C.laneSpec(k).runner);}catch{return false;}}
// take (peek:false) stamps the slot: the caller sends exactly one request. A refusal keeps the job's place in the
// queue (want) and arms the lane alarm for the next slot.
function gameLaneDecide(key,{peek=false}={}){
  return gameLaneSerial(async()=>{
    // timers-core.js is part of the package (importScripts); only a stripped harness lacks it: the read goes as before.
    const C=gameLaneCore();if(!C)return {take:true,noLane:true,nextAt:Date.now()};
    // The game's security check refused a Manager read: no slot until the pause ends (the want stays queued).
    const ref=typeof gameRefusalGet==='function'?await gameRefusalGet():null;
    if(ref&&Number(ref.until)>Date.now()){const p=C.laneDecide(await gameLaneLoad(),key,Date.now(),{peek:true});await gameLaneStore(p.state);gameLaneScheduleAlarm(Number(ref.until)+1000).catch(()=>{});return {take:false,reason:'refused',refused:true,nextAt:Number(ref.until),state:p.state};}
    const d=C.laneDecide(await gameLaneLoad(),key,Date.now(),{peek});
    await gameLaneStore(d.state);
    if(!d.take&&Object.keys(d.state.wants||{}).some(k=>gameLaneHasRunner(C,k)))gameLaneScheduleAlarm(d.nextAt).catch(()=>{});
    return d;
  });
}
// Queue a want without taking the slot (Sync's not-on-page paths, a game Collect, a Refresh button): the lane alarm
// serves it in the next slot. Returns {queued:true,nextAt}.
async function gameLaneEnqueue(key){
  const C=gameLaneCore();if(!C)return {queued:false,noLane:true};
  const d=await gameLaneDecide(key,{peek:true});
  const nextAt=d.take?Date.now():Number(d.nextAt)||Date.now();
  if(Object.keys(d.state?.wants||{}).length)gameLaneScheduleAlarm(nextAt).catch(()=>{});
  return {queued:true,key,reason:d.reason||(d.take?'free':null),nextAt};
}
// The answer of a read that took the slot: per-key result and failure backoff (laneResult, timers-core.js).
function gameLaneResult(key,{ok,status}={}){
  return gameLaneSerial(async()=>{
    const C=gameLaneCore();if(!C||typeof C.laneResult!=='function')return;
    const out=C.laneResult(await gameLaneLoad(),key,{ok:Boolean(ok),status:Number(status)||0},Date.now());
    const st=out&&typeof out==='object'&&out.state&&typeof out.state==='object'?out.state:out;
    if(st&&typeof st==='object')await gameLaneStore(st);
  });
}
function gameLaneDropWant(key){return gameLaneSerial(async()=>{const C=gameLaneCore();if(!C)return;const st=C.laneState(await gameLaneLoad(),Date.now());if(!st.wants[key])return;delete st.wants[key];await gameLaneStore(st);});}
function gameLaneWaitResponse(path,d){return {ok:false,status:0,skipped:true,laneWait:true,queued:true,reason:d?.reason||'gap',nextAt:Number(d?.nextAt)||0,error:d?.refused?gameRefusalText(d.nextAt):GAME_LANE_WAIT_TEXT,...(d?.refused?{refused:true}:{}),path:String(path||'')};}
function isGameLaneWait(v){return Boolean(v?.laneWait)||String(v?.error??v?.message??v??'').includes(GAME_LANE_WAIT_TEXT);}
// The lane job of a read whose caller named none (Refresh buttons, opening a product, dashboard / overlay reads).
// Keys are '<job>' or '<job>:<realm>' (laneKeyOk).
function gameLaneKeyForPath(path,realm){
  const p=String(path||'').split('?')[0],n=validRealmNumber(realm),sfx=n!=null?`:${n}`:'';
  if(/\/api\/v3\/resources\/\d+\/?$/i.test(p)||/\/companies\/me\/buildings\/?$/i.test(p))return `warehouse${sfx}`;
  if(/\/market-orders\/?$/i.test(p))return `marketOrders${sfx}`;
  if(/\/contracts-(?:incoming|outgoing)\//i.test(p))return `contracts${sfx}`;
  if(/\/auth-data\/?$/i.test(p))return `authData${sfx}`;
  if(/\/accounting\/|\/sales-records\//i.test(p))return `accounting${sfx}`;
  if(/\/market\/(?:\d+\/)?\d+\/?$|\/market\/.*order/i.test(p))return 'orderBook';
  if(/\/market-ticker\//i.test(p))return `ticker${sfx}`;
  if(/\/abundance\/?$/i.test(p))return `abundance${sfx}`;
  return 'other';
}
async function gameLaneScheduleAlarm(atMs){
  const C=gameLaneCore();if(!C||!chrome.alarms)return;
  const now=Date.now(),when=Math.max(now+30000,Number(atMs)||0);
  const cur=await chrome.alarms.get(C.LANE.ALARM).catch(()=>null);
  if(cur&&Number(cur.scheduledTime)>now&&Number(cur.scheduledTime)<=when+1000)return;
  await scmAlarmCreate(C.LANE.ALARM,{when});
}
// Manager reads in flight (any pageGet): the image job does not start on dashboard open while this is above 0.
let managerReadsInFlight=0;
// Offline (device or game tab): no request, the slot is not used. The game tab being in the background is NOT a skip
// (2.5.465: the slot is the gate). From a BRIDGE_STATUS answer (an old content.js without the fields: go).
function laneTabSkipCode(bridge,workerOnline=(typeof navigator==='undefined'||navigator.onLine!==false)){
  if(bridge?.online===false||!workerOnline)return 'offline';
  return null;
}
function laneTabSkipError(code){const e=new Error(notReadReason(code));if(code==='offline')e.offline=true;return e;}
async function pageGet(path, targetRealm=null, diagnosticTrace=null, diagnosticLabel=null, options=null){
  const traceDiag=(type,extra={})=>{
    try{ diagnosticTrace?.(type,{realm:targetRealm,path,label:diagnosticLabel,attempt:extra.attempt,...extra}); }catch{}
  };
  // Every Manager read is a lane read: the caller's job, else one derived from the path.
  const laneKey=typeof options?.lane==='string'&&options.lane?options.lane:gameLaneKeyForPath(path,targetRealm);
  // Sync is a pure page walk: no Manager read while it runs. The read is queued for the next slot instead.
  if(coreSyncActive()){
    traceDiag('pageget-refused-sync-running',{lane:laneKey});
    try{logError('pageget-during-sync',`${PAGE_GET_DURING_SYNC_TEXT} ${String(path||'').slice(0,160)} (${diagnosticLabel||laneKey})`);}catch{}
    // 2.5.466: nothing is queued from inside a Sync (the caller's own timer asks again after it).
    return {ok:false,status:0,skipped:true,syncRunning:true,laneWait:true,queued:false,nextAt:0,error:PAGE_GET_DURING_SYNC_TEXT,path:String(path||'')};
  }
  const customTimeout=Number(options?.timeoutMs);
  const timeoutMs=Number.isFinite(customTimeout)&&customTimeout>0?customTimeout:SYNC_PAGE_API_TIMEOUT_MS;
  const raceMs=timeoutMs+PAGE_GET_BACKGROUND_GRACE_MS;
  managerReadsInFlight++;
  try{
    const tab=await simTab();
    if(!tab?.id){const e=new Error('Open Sim Companies and log in before syncing.');e.noGameTab=true;throw e;}
    traceDiag('pageget-start',{attempt:1,tabId:tab.id,lane:laneKey});
    const bridgeReady=await waitForBridge(tab.id,3000);
    traceDiag('pageget-bridge-ready',{attempt:1,tabId:tab.id,ready:bridgeReady});
    if(!bridgeReady){traceDiag('pageget-bridge-not-ready',{attempt:1,tabId:tab.id});const e=new Error('Sim Companies page bridge is not ready.');e.bridgeNotReady=true;throw e;}
    if(typeof bridgeReady==='object'){const skip=laneTabSkipCode(bridgeReady);if(skip){traceDiag('pageget-lane-tab-skip',{attempt:1,reason:skip});throw laneTabSkipError(skip);}}
    // One request per slot: never a second attempt.
    const slot=await gameLaneDecide(laneKey);
    if(!slot.take){traceDiag('pageget-lane-wait',{attempt:1,reason:slot.reason,nextAt:slot.nextAt});return gameLaneWaitResponse(path,slot);}
    traceDiag('pageget-send',{attempt:1,tabId:tab.id});
    let r;
    try{
      r=await Promise.race([
        chrome.tabs.sendMessage(tab.id,{type:'PAGE_API_GET',path,realm:targetRealm,timeoutMs}),
        new Promise((_,reject)=>setTimeout(()=>reject(new Error('Sim Companies page bridge timed out.')),raceMs))
      ]);
    }catch(e){
      traceDiag('pageget-error',{attempt:1,tabId:tab.id,error:e?.message||String(e)});
      await gameLaneResult(laneKey,{ok:false,status:0});
      const fe=new Error(e?.message||'Sim Companies page bridge is not connected.');
      if(pageMessageChannelClosed(e))fe.pageClosed=true;
      throw fe;
    }
    traceDiag('pageget-response',{attempt:1,tabId:tab.id,ok:!!r?.ok,status:r?.status||0,error:r?.error||null});
    await gameLaneResult(laneKey,{ok:Boolean(r?.ok),status:Number(r?.status)||0});
    if(r&&!r.ok&&r.networkError&&(r.offline||laneTabSkipCode(null)==='offline')){traceDiag('pageget-lane-network-skip',{attempt:1,reason:'offline',error:r.error||null});throw laneTabSkipError('offline');}
    if(r?.pageClosed){const closedError=new Error(r.error||'The game page was reloaded or closed before the API answered.');closedError.pageClosed=true;throw closedError;}
    // A /me/ answer from a tab that is in the other realm belongs to that realm: never hand it to a
    // caller that will file it under targetRealm. (auth-data is exempt: Sync checks it and explains the mismatch.)
    const tr=validRealmNumber(targetRealm),rr=validRealmNumber(r?.captureRealm);
    if(r?.ok&&tr!=null&&rr==null&&/\/me\//.test(String(path))&&!/\/api\/v3\/companies\/auth-data\//.test(String(path))){traceDiag('pageget-realm-unknown',{attempt:1,tabId:tab.id,targetRealm:tr});return {ok:false,status:0,error:'The game tab has not shown which realm it is in yet.',realmUnknown:true};}
    if(r?.ok&&tr!=null&&rr!=null&&rr!==tr&&!/\/api\/v3\/companies\/auth-data\//.test(String(path))){traceDiag('pageget-realm-mismatch',{attempt:1,tabId:tab.id,targetRealm:tr,tabRealm:rr});return {ok:false,status:0,error:`The game tab is in ${realmDisplayNumber(rr)||'the other realm'}, not ${realmDisplayNumber(tr)||'the requested realm'}.`,captureRealm:rr,realmMismatch:true};}
    if(!r?.ok)noteGameBackoffAnswer(path,Number(r?.status)||0);
    // Cloudflare refused it: pause every Manager read for 1 h; the caller logs a "not read" line, not a failure.
    if(r&&isGameSecurityRefusal(r)){traceDiag('pageget-security-refusal',{attempt:1});await gameRefusalSet(path);return {ok:false,status:403,skipped:true,laneWait:true,refused:true,queued:true,reason:'refused',nextAt:Number(gameRefusalMem?.until)||0,error:gameRefusalText(gameRefusalMem?.until),path:String(path||'')};}
    if(r?.ok)gameRefusalClear().catch(()=>{});
    return r||{ok:false,status:0,error:'No response from Sim Companies page.'};
  }finally{managerReadsInFlight--;}
}
// Sync's realm boundary from the game's own auth-data (the game loads it on every page load and every 3 min):
// 1. a stored capture for this realm received in the last 10 min; 2. else reload the game tab so the game loads it,
// and wait up to 15 s for that capture; 3. else, only while direct reads are not blocked, read it directly.
const SYNC_AUTH_CAPTURE_MAX_AGE_MS=10*60*1000,SYNC_AUTH_RELOAD_WAIT_MS=30000;
const AUTH_DATA_PATH='/api/v3/companies/auth-data/';
function authDataRealmOf(data){return validRealmNumber(data?.authCompany?.realmId??data?.authCompany?.realm??data?.realmId??data?.realm);}
function freshCapturedAuthData(s,realm,sinceMs,now=Date.now()){
  const item=endpointDataForSyncRealm(s,realm)?.[AUTH_DATA_PATH];
  const at=Date.parse(String(item?.receivedAt||''));
  if(!item||Number(item.status)!==200||!item.data||typeof item.data!=='object')return null;
  if(validRealmNumber(item.captureRealm)!==validRealmNumber(realm))return null;
  const dataRealm=authDataRealmOf(item.data);if(dataRealm!=null&&dataRealm!==validRealmNumber(realm))return null;
  if(!Number.isFinite(at)||at<sinceMs||now-at>SYNC_AUTH_CAPTURE_MAX_AGE_MS)return null;
  // The tab may have switched realm since: the active view (set by the latest auth-data) must be this realm.
  if(s?.activeRealmKey&&s.activeRealmKey!==realmKeyFromRealm(realm))return null;
  return {ok:true,status:200,data:item.data,captureRealm:validRealmNumber(realm),fromPageCapture:true,receivedAt:item.receivedAt,ageMs:now-at};
}
function walkCapturedAuthData(session,realm){
  for(const [url,c] of Object.entries(session?.walkCaptures||{})){
    if(String(url).replace(/^https?:\/\/[^/]+/,'').split('?')[0]!==AUTH_DATA_PATH)continue;
    if(Number(c?.status)!==200||!c?.data||typeof c.data!=='object')continue;
    const dr=authDataRealmOf(c.data);if(dr!=null&&dr!==validRealmNumber(realm))continue;
    return {ok:true,status:200,data:c.data,captureRealm:validRealmNumber(realm),fromPageCapture:true,receivedAt:c.receivedAt,ageMs:Date.now()-Number(c.at||Date.now())};
  }
  return null;
}
async function syncAuthBoundaryFromGame(realm,tabId,session,trace){
  if(typeof trace!=='function')trace=()=>{};
  const n=validRealmNumber(realm);
  const stored=freshCapturedAuthData(await state(n),n,0);
  if(stored){trace('auth-from-game-capture',{realm:n,source:'stored',ageMs:stored.ageMs});return stored;}
  // Reload so the game itself loads auth-data; its response is kept for this Sync (walkCaptures) and stored.
  const reloadAt=Date.now();
  const prevPaths=session.capturePaths,prevWalk=session.walkCaptures;
  session.capturePaths=[AUTH_DATA_PATH];session.walkCaptures={};session.gameTabId=tabId;
  let found=null;
  try{
    trace('auth-reload-for-capture',{realm:n,tabId});
    await chrome.tabs.reload(tabId);
    const deadline=reloadAt+SYNC_AUTH_RELOAD_WAIT_MS;
    let boundarySet=false,storedCheckedAt=0;
    // Live R2 2026-11-12: the reloaded page sent its first request 10 s after the reload, and one slow stored-copy
    // read ran past the deadline, so the answer already in walkCaptures was never looked at. Now: the in-memory
    // copy is checked every 250 ms and once more after the deadline; the stored copy at most every 3 s; the bridge
    // ask is bounded.
    while(Date.now()<deadline&&!found){
      if(session.cancelled)throw new SyncCancelledByClear();
      if(!boundarySet){
        try{const br=await withSyncTimeout(chrome.tabs.sendMessage(tabId,{type:'BRIDGE_STATUS'}),1500,'Bridge status after reload');if(br?.ready){const sr=await withSyncTimeout(chrome.tabs.sendMessage(tabId,{type:'SET_SYNC_REALM',realm:n,ttlMs:120000}),1500,'Sync realm after reload');boundarySet=Boolean(sr?.ok);if(boundarySet)trace('capture-boundary-set',{realm:n,afterReload:true});}}catch{}
      }
      found=walkCapturedAuthData(session,n);
      if(!found&&Date.now()-storedCheckedAt>=3000){storedCheckedAt=Date.now();found=freshCapturedAuthData(await state(n),n,reloadAt);}
      if(!found)await new Promise(r=>setTimeout(r,250));
    }
    if(!found)found=walkCapturedAuthData(session,n);
    if(!boundarySet&&await waitForBridge(tabId,5000)){try{await chrome.tabs.sendMessage(tabId,{type:'SET_SYNC_REALM',realm:n,ttlMs:120000});}catch{}}
  }catch(e){if(e instanceof SyncCancelledByClear)throw e;trace('auth-reload-error',{error:e?.message||String(e)});}
  finally{session.capturePaths=prevPaths;session.walkCaptures=prevWalk;}
  if(found){trace('auth-from-game-capture',{realm:n,source:'reload',ms:Date.now()-reloadAt});return found;}
  trace('auth-capture-missing',{realm:n,waitedMs:Date.now()-reloadAt});
  // Sync makes no Manager read: the auth-data the game loads on its own pages is the only source.
  return {ok:false,status:0,notOnPage:true,error:`The game page did not load its session data within ${Math.round(SYNC_AUTH_RELOAD_WAIT_MS/1000)} s after a reload.`};
}
const BUILDING_HISTORY_REFETCH_COOLDOWN_MS=15000;
async function fetchBuildingHistoryForRealm(realm, buildingId){
  const target=validRealmNumber(realm);
  const id=validBuildingId(buildingId);
  if(target==null||id==null)return {ok:false,error:'Invalid realm or building.'};
  const path=`/api/v2/companies/buildings/${id}/history/`;
  const current=await state(realm);
  const store=current.realmStores?.[realmKeyFromRealm(target)]||{};
  const existing=store.endpointData?.[path];
  if(existing&&Number(existing.status)>=200&&Number(existing.status)<300&&validRealmNumber(existing.captureRealm)===target&&Array.isArray(existing.data)){
    // Fetch guard: the cache is enough when the building has no run to match (unknown, idle or expanding) or when
    // its current run already has its history row (the matcher the overlay and the page use).
    const core=globalThis.SCMPlannerCore,building=(Array.isArray(store.buildings)?store.buildings:[]).find(b=>Number(b?.id)===id);
    const hasCurrentCycle=!core.buildingRun(building)||Boolean(core.matchRunHistoryRow(building,existing.data));
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

// The game's Profit Calculator "Assumed wholesale price (based on the market)" is the cheapest exchange
// listing of ANY quality, Q0 included. The building card
// asks for a fresh order book through the game tab: same request the Exchange page makes. Network first, then saveData
// (which takes the realm lock) — no lock is held while fetching. One fetch per product per 5 min.
const ORDER_BOOK_REFETCH_MS=5*60*1000;const ORDER_BOOK_MANUAL_REFETCH_MS=30*1000;const orderBookFetchAt=new Map();
// Dashboard on-view reads (FETCH_EXCHANGE_ORDER_BOOK without manual: product select, planner card) share ONE gap of 30 s across all
// products and realms, so switching through many products sends one game request. The stamp is also kept in chrome.storage.session
// so a worker restart does not reset it. Refresh presses (manual) and lane jobs are not held by it.
const ORDER_BOOK_ONVIEW_GAP_MS=30*1000,ORDER_BOOK_ONVIEW_KEY='scmOrderBookOnViewAt';let orderBookOnViewAt=0;
// manual=true: a press of the Market page Refresh button may read again once the last read of that product is 30 s old.
// opts.lane: an unattended read (order-book alarm, incoming-contract card) that waits for the shared game lane slot;
// without it the read is user-initiated (Refresh press, opening a product) and only moves the lane's last-request time.
async function fetchExchangeOrderBookForRealm(realm,resourceId,manual=false,opts=null){
  const target=validRealmNumber(realm),id=validResourceId(resourceId);
  if(target==null||id==null)return {ok:false,error:'Invalid realm or resource.'};
  const path=`/api/v3/market/${target}/${id}/`,k=`${target}:${id}`;
  const last=orderBookFetchAt.get(k)||0;
  if(Date.now()-last<(manual===true?ORDER_BOOK_MANUAL_REFETCH_MS:ORDER_BOOK_REFETCH_MS))return {ok:true,throttled:true,lastAt:last};
  if(manual!==true&&opts?.onView===true){
    let st=orderBookOnViewAt;try{st=Math.max(st,Number((await chrome.storage.session?.get(ORDER_BOOK_ONVIEW_KEY))?.[ORDER_BOOK_ONVIEW_KEY])||0);}catch{}
    if(Date.now()-st<ORDER_BOOK_ONVIEW_GAP_MS)return {ok:true,throttled:true,lastAt:st};
    orderBookOnViewAt=Date.now();try{await chrome.storage.session?.set({[ORDER_BOOK_ONVIEW_KEY]:orderBookOnViewAt});}catch{}
  }
  orderBookFetchAt.set(k,Date.now());
  let response;
  const lane=typeof opts?.lane==='string'&&opts.lane?opts.lane:null;
  try{response=await pageGet(path,target,null,null,lane?{lane}:null);}
  catch(e){
    // No game tab / page bridge not ready or not connected / page unloaded: no request was answered. Not read
    // (bridgeUnavailable: the caller logs a not-read line, no backoff step); the 5 min gap does not count unless the page unloaded
    // mid-read (a request may have gone out then).
    if(pageBridgeUnavailable(e)){if(!e?.pageClosed)orderBookFetchAt.set(k,last);return {ok:false,skipped:true,bridgeUnavailable:true,...(e?.pageClosed?{pageClosed:true}:{}),...(e?.noGameTab?{noGameTab:true}:{}),status:0,error:e?.message||String(e)};}
    throw e;
  }
  // Not this job's lane slot: no request went out, so the 5 min gap of this product does not count.
  if(response?.laneWait){orderBookFetchAt.set(k,last);return {ok:false,skipped:true,laneWait:true,status:0,reason:response.reason,nextAt:response.nextAt,error:response.error};}
  const responseRealm=validRealmNumber(response?.captureRealm);
  // The game tab is in (or just moved to) the other realm: not read, nothing saved. realmMismatch is passed on
  // so the order-book alarm logs no failure and takes no backoff step; the 5 min gap for this product still counts.
  if(response?.realmMismatch||(responseRealm!=null&&responseRealm!==target))return {ok:false,skipped:true,realmMismatch:true,reason:'other-realm',error:'Order book came from the wrong realm.'};
  if(!response?.ok||!hasUsableMarketRows(response.data)){orderBookFetchAt.set(k,last);return {ok:false,status:response?.status||0,laneWait:Boolean(response?.laneWait),nextAt:Number(response?.nextAt)||0,skipped:Boolean(response?.laneWait),error:response?.error||'No usable order book returned (is the game tab open?).'};}
  await saveData(path,response.data,response.status,'GET',target);
  return {ok:true,rows:Array.isArray(response.data)?response.data.length:null};
}
// Monitor line for an order-book read a game-page card asked for (sell page, incoming contract): waiting (lane slot),
// not read (no tab / bridge / other realm / reads blocked), or a failed request (a 2xx without rows is an empty book).
// A success or a throttled call (no read wanted) adds no line, as before.
function logOrderBookSideRead(realm,resourceId,x,trigger){
  if(!x||x.ok||x.throttled)return;
  if(x.laneWait)return logLaneWait(realm,'order-book-refresh',x.nextAt,{resourceId},Date.now(),trigger);
  if(x.realmMismatch)return logNotRead(realm,'order-book-refresh',otherRealmReason('other-realm',realm),{resourceId},Date.now(),trigger);
  
  if(x.bridgeUnavailable)return logNotRead(realm,'order-book-refresh',x,{resourceId},Date.now(),trigger);
  const status=Number(x.status)||0;if(status>=200&&status<300)return;
  return logActivity(realm,'order-book-refresh','failure',{resourceId,status},x.error||null,Date.now(),trigger);
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

// Capped background order-book refresh: one alarm every 5 min, at most one order book per firing across all realms,
// and only when the shared game lane gives the slot (job 'orderBook', priority 2 after your warehouse).
// Only the tab pageGet would use is asked, because a request for the other realm would be refused there anyway.
// The worker usually dies between firings, so the back-off and last attempts live in a small key, written only when
// a request is made. A product with an empty book never gets a new receivedAt; its attempt time stops it blocking others.
const ORDER_BOOK_REFRESH_ALARM='scm-order-book-refresh';
const ORDER_BOOK_REFRESH_STATE_KEY='scmOrderBookRefresh';
const ORDER_BOOK_REFRESH_FAILURE_BACKOFF_MS=5.5*60000; // skips the next 5 firings
const ORDER_BOOK_REFRESH_429_BACKOFF_MS=15.5*60000; // skips the next 15 firings; the page bridge does not expose Retry-After
const ORDER_BOOK_REFRESH_ATTEMPT_KEEP_MS=24*3600e3;
let orderBookRefreshRunning=false;
// The alarm runs every 5 min (the shared game lane allows one background game request per 5 min anyway). With no
// active Sim Companies tab, a firing within 110 s of the last one is skipped.
async function scmOrderBookShouldThrottle(){
  try{
    const tabs=await chrome.tabs.query({active:true,url:['https://www.simcompanies.com/*','https://simcompanies.com/*']});
    if(tabs.length)return false;
    const key='scmOrderBookLastFiringAt',now=Date.now();
    const last=Number((await chrome.storage.session.get(key))?.[key])||0;
    if(now-last<110000)return true;
    await chrome.storage.session.set({[key]:now});
    return false;
  }catch{return false;}
}
async function ensureOrderBookRefreshAlarm(){
  try{await scmEnsureTimerAlarm('orderBook',{delayInMinutes:5,periodInMinutes:5},'period');}catch{}
}
// networkRows: the overlay network's production and demand rows of this realm (overlayProductionStock).
function orderBookRefreshResourceIds(store,realm,networkRows=[]){
  const ids=new Set();
  const add=v=>{const id=Number(v);if(Number.isInteger(id)&&id>0)ids.add(id);};
  for(const row of Array.isArray(store?.warehouseResources)?store.warehouseResources:[])add(row?.kind??row?.resourceId??row?.id);
  for(const row of Array.isArray(networkRows)?networkRows:[])add(row?.id);
  for(const p of Object.values(store?.productionPlans||{}))add(p?.productId??p?.resourceId);
  for(const b of Array.isArray(store?.buildings)?store.buildings:[])add(b?.busy?.resource?.kind??b?.busy?.resource?.resourceId);
  return ids;
}
// Pure: the used resource with the oldest or missing order book. A record stamped with another realm counts as missing.
function chooseOrderBookRefreshTarget(store,realm,attempts,now,minAgeMs=ORDER_BOOK_REFETCH_MS,networkRows=[]){
  const n=Number(realm),seen=new Map(),rx=new RegExp(`^/api/v3/market/${n}/(\\d+)/?(?:\\?.*)?$`);
  for(const [url,entry] of Object.entries(store?.endpointData||{})){
    const m=rx.exec(String(url));if(!m||Number(entry?.captureRealm)!==n||entry?.captureRealm==null)continue;
    const at=Date.parse(String(entry?.receivedAt||''));
    if(Number.isFinite(at))seen.set(Number(m[1]),Math.max(seen.get(Number(m[1]))||0,at));
  }
  let best=null,bestAt=Infinity;
  for(const id of orderBookRefreshResourceIds(store,n,networkRows)){
    const at=Math.max(seen.get(id)||0,Number(attempts?.[`${n}:${id}`])||0);
    if(now-at<minAgeMs)continue;
    if(at<bestAt||(at===bestAt&&id<best)){best=id;bestAt=at;}
  }
  return best;
}
async function runOrderBookRefreshFiring(){
  if(orderBookRefreshRunning||coreSyncActive())return {ok:true,skipped:true};
  orderBookRefreshRunning=true;
  try{
    const clearGen=extensionClearGeneration;
    const saved=(await chrome.storage.local.get({[ORDER_BOOK_REFRESH_STATE_KEY]:null}))[ORDER_BOOK_REFRESH_STATE_KEY]||{};
    const now=Date.now();
    if(Number(saved.backoffUntil)>now)return {ok:true,skipped:true};
    const tab=await simTab();if(!tab?.id){logActivityAnyRealm('order-book-refresh','not-read',{},notReadReason('no-game-tab'));return {ok:true,skipped:true};}
    const bridge=await withSyncTimeout(chrome.tabs.sendMessage(tab.id,{type:'BRIDGE_STATUS'}),BRIDGE_STATUS_WAIT_MS,'Order book refresh bridge check').catch(()=>null);
    const realm=bridge?.ready&&(bridge.realm===0||bridge.realm===1)?bridge.realm:null;
    // Bridge not ready, or the tab has not shown its realm yet: a "not read" line. A Sync / day walk of that realm: planned, no line.
    if(realm==null){logActivityAnyRealm('order-book-refresh','not-read',{},notReadReason(bridge?.ready?'realm-unknown':'bridge-not-ready'));return {ok:true,skipped:true};}
    if(syncSessionForRealm(realm)||accountingDayWalkRunning.has(realm))return {ok:true,skipped:true};
    {const skip=bridge?.online===false?'offline':null;if(skip){logNotRead(realm,'order-book-refresh',skip,{},now,'alarm');return {ok:true,skipped:true,reason:skip};}}
    // Shared game lane: not this job's turn (5 min since the last game request not over, or a job before it is
    // waiting): a "waiting" line before any product attempt is stamped; the lane alarm runs it again when the slot opens.
    const peek=await gameLaneDecide('orderBook',{peek:true});
    if(!peek.take){logLaneWait(realm,'order-book-refresh',peek.nextAt,{},now,'alarm');return {ok:true,skipped:true,laneWait:true,reason:peek.reason,nextAt:peek.nextAt};}
    const store=await notifyRealmStore(realm);
    const attempts=Object.fromEntries(Object.entries(saved.attempts||{}).filter(([,at])=>now-Number(at)<ORDER_BOOK_REFRESH_ATTEMPT_KEEP_MS));
    let networkRows=[];
    try{const {network}=await overlayProductionStock(store,realm,null);networkRows=[...network.productionRows,...network.demandRows];}catch{}
    const resourceId=chooseOrderBookRefreshTarget(store,realm,attempts,now,ORDER_BOOK_REFETCH_MS,networkRows);
    if(resourceId==null||coreSyncActive()||clearGen!==extensionClearGeneration)return {ok:true,skipped:true};
    attempts[`${realm}:${resourceId}`]=now;
    await rawStorageSet({[ORDER_BOOK_REFRESH_STATE_KEY]:{backoffUntil:0,attempts}});
    let result;
    try{result=await fetchExchangeOrderBookForRealm(realm,resourceId,false,{lane:'orderBook'});}catch(e){result={ok:false,status:0,error:e?.message||String(e)};}
    const status=Number(result?.status)||0;
    // The lane slot went to another job between the peek and the read: no request, the product's attempt is undone.
    if(result?.laneWait){delete attempts[`${realm}:${resourceId}`];if(clearGen===extensionClearGeneration)await rawStorageSet({[ORDER_BOOK_REFRESH_STATE_KEY]:{backoffUntil:0,attempts}});logLaneWait(realm,'order-book-refresh',result.nextAt,{resourceId},now,'alarm');return {...result,realm,resourceId,skipped:true};}
    // The game tab switched realm during the read: a "not read" line (no failure, no backoff, nothing saved).
    if(result?.realmMismatch){logNotRead(realm,'order-book-refresh',otherRealmReason('other-realm',realm),{resourceId},now,'alarm');return {...result,realm,resourceId};}
    // The game blocked this read (pageGet logged the block once): a "not read" line, no back-off.
    
    // No game tab / bridge not ready: no request was answered: a "not read" line, no back-off.
    if(result?.bridgeUnavailable){logNotRead(realm,'order-book-refresh',result,{resourceId},now,'alarm');return {...result,realm,resourceId,skipped:true};}
    // A 2xx without usable rows is an empty book, not a failed request.
    if(!result?.ok&&!(status>=200&&status<300)){
      const backoffMs=status===429?ORDER_BOOK_REFRESH_429_BACKOFF_MS:ORDER_BOOK_REFRESH_FAILURE_BACKOFF_MS;
      if(clearGen===extensionClearGeneration)await rawStorageSet({[ORDER_BOOK_REFRESH_STATE_KEY]:{backoffUntil:Date.now()+backoffMs,attempts}});
      logActivity(realm,'order-book-refresh','failure',{resourceId,status},result?.error||null,now,'alarm');
    }
    return {...result,realm,resourceId};
  }finally{orderBookRefreshRunning=false;}
}

// Market ticker: no active read any more. Nothing uses its prices (market-core reads them only with opts.gameBook), and
// the product images it carries are in the game constants. The game pages load it themselves; those passive captures are
// still saved (also during a Sync). This only clears ticker wants an older version left in the game lane.
async function runMarketTickerRefresh(){
  await gameLaneDropWant('ticker:0').catch(()=>{});await gameLaneDropWant('ticker:1').catch(()=>{});
  return {ok:true,skipped:true,reason:'no-active-read'};
}
// The lane alarm: the slot is free and an alarm job waits. Only the winner runs (it takes the slot through pageGet);
// a card poll that wins asks again by itself within seconds while its tab is visible. A winner that ran without
// asking again (nothing to read, no tab) is dropped from the queue, so the alarm never spins on it.
const GAME_LANE_RUNNERS={
  orderBook:async()=>{if(!(await scmTimerEnabled('orderBook').catch(()=>true)))return;await runOrderBookRefreshFiring();},
  lostData:async()=>{if(!(await scmTimerEnabled('criticalGuard').catch(()=>true)))return;await runCriticalDataGuard('lane');},
  gameConstants:async()=>{const e=await scmTimerEntry('gameConstants').catch(()=>null);if(e&&!e.enabled)return;await refreshGameConstants(false,gameConstantsMaxAge(e),{quietNoTab:true});},
  abundance:async realm=>{if(realm!=null)await refreshAbundanceIfStale(realm,'lane');},
  // The held listings read (deferred retry); nothing queued: no read (the want is dropped).
  listings:async realm=>{if(realm!=null)await runMarketOrdersRetry(realm);},
  // 2.5.465: queued reads (Refresh buttons, overlay, a game Collect, Sync not-on-page paths) are served here.
  collectWarehouse:async realm=>{if(realm!=null)await refreshRealmWarehouseForOverlay(realm,0,{lane:`collectWarehouse:${realm}`});},
  warehouse:async realm=>{if(realm!=null)await refreshRealmWarehouseForOverlay(realm,0);},
  marketOrders:async realm=>{if(realm!=null)await refreshMarketOrders(realm,0,{lane:true});},
  contracts:async realm=>{if(realm!=null)await refreshOutgoingContracts(realm,0,{lane:true});},
  // executive:<realm>:<id>: one executive record Sync's pages did not load, read in its own slot.
  executive:async(realm,key)=>{const id=Number(String(key||'').split(':')[2]);if(realm==null||!(id>0))return;const p=`/api/v4/executives/${id}/`;const x=await pageGet(p,realm,null,'executive-lane',{lane:key});if(x?.ok&&x.data&&typeof x.data==='object'&&!endpointResponseRejected(p,x))await saveData(p,x.data,x.status,'GET',realm);},
  // syncMissing:<realm>: the path is not in the key; the next Sync or page visit fills it (want dropped by the alarm).
  syncMissing:async()=>{}
};
const GAME_LANE_CARD_STALE_MS=60000;
async function runGameLaneAlarm(){
  const C=gameLaneCore();if(!C)return {ok:false};
  const now=Date.now(),st=C.laneState(await gameLaneLoad(),now);
  const hasRunner=s=>Object.keys(s.wants).some(k=>gameLaneHasRunner(C,k));
  if(!hasRunner(st))return {ok:true,idle:true};
  const next=C.laneNextSlotAt(st,now);
  if(next>now){await gameLaneScheduleAlarm(next);return {ok:true,waiting:true,nextAt:next};}
  if(coreSyncActive()){await gameLaneScheduleAlarm(now+60000);return {ok:true,sync:true};}
  // A winner with no runner is a card/page read: its card asks again by itself while it is open (want.at refreshed).
  // One not asked for in GAME_LANE_CARD_STALE_MS has no open card: drop it, or it holds the slot until its want TTL
  // (live 2026-11-12: accounting:1 from a Sync-time open blocked marketOrders/contracts/abundance for 16+ min).
  let winner=C.laneWinner(st.wants,now,st.lastAt);
  for(let i=0;winner&&i<12;i++){
    if(GAME_LANE_RUNNERS[String(winner).split(':')[0]])break;
    if(now-Number(st.wants[winner]?.at||0)<GAME_LANE_CARD_STALE_MS)break;
    await gameLaneDropWant(winner);delete st.wants[winner];winner=C.laneWinner(st.wants,now,st.lastAt);
  }
  if(!winner)return {ok:true,idle:true};
  const [base,rs]=String(winner||'').split(':');const run=GAME_LANE_RUNNERS[base];
  if(!run){await gameLaneScheduleAlarm(now+GAME_LANE_CARD_STALE_MS+1000);return {ok:true,winner,card:true};}
  const before=st.wants[winner]?.at;
  try{await run(rs!=null&&rs!==''?Number(rs):null,winner);}catch(e){logError('game-lane-run',e);}
  const after=C.laneState(await gameLaneLoad(),Date.now());
  if(after.wants[winner]&&after.wants[winner].at===before){await gameLaneDropWant(winner);delete after.wants[winner];}
  if(hasRunner(after))await gameLaneScheduleAlarm(C.laneNextSlotAt(after,Date.now()));
  return {ok:true,winner};
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
// Price observation log for the Tools tab (movers / price history). Kept under its own
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
// Loads the live-market per-endpoint cooldowns (storage.local) and the channel's 429 cooldown mirror (storage.session).
async function hydrateSimcoCooldowns(){
  try{
    const saved=await chrome.storage.local.get({simcoToolsRateLimitUntilByUrl:{}});
    for(const [url,untilRaw] of Object.entries(saved.simcoToolsRateLimitUntilByUrl||{})){
      const until=Number(untilRaw); if(Number.isFinite(until)&&until>Date.now())simcoRateLimitUntilByUrl.set(url,Math.max(Number(simcoRateLimitUntilByUrl.get(url))||0,until));
    }
  }catch{}
  try{const st=await simcoChannelPeek();simcoRateLimitUntil=Number(st?.cooldownUntil)||0;}catch{}
}
async function persistSimcoCooldowns(){
  try{const byUrl={};for(const [url,until] of simcoRateLimitUntilByUrl.entries())if(Number(until)>Date.now())byUrl[url]=Number(until);await chrome.storage.local.set({simcoToolsRateLimitUntilByUrl:byUrl});}catch{}
}
// ---- SimcoTools channel (rules: SCM_TIMERS_CORE.simcoTake / simcoResult in timers-core.js) ----
// State: chrome.storage.session scmSimcoChannel (survives a worker restart), every change through ONE serialized chain
// (simcoChannelSerial), the same pattern as the game lane (scmGameLane). Wants are keyed by job: 'job' or 'job:<realm>'.
// Job keys (SIMCO.JOBS priority): refresh:<realm> Market Refresh button (1); prices:<realm> /market/prices (2);
// vwap:<realm> VWAP dataset and pairs (3); snapshot:<realm> one product, candles:<realm> its price history,
// followed:<realm> the batched current prices (4); public:<realm> / public every other public-data job (5).
// A refused job keeps its want; the 'scm-simco-channel' alarm (and a short timer for waits under 25 s) runs the queued
// jobs' runners (SIMCO_CHANNEL_RUNNERS) in priority order. A job without a runner (snapshot, candles: the dashboard asks
// again itself) drops when its want expires (SIMCO.WANT_TTL_MS); while SimcoTools is unreachable such a want is dropped
// once its caller stopped asking (SIMCO_CHANNEL_STALE_WANT_MS), so it does not hold the probe of a queued job.
const SIMCO_CHANNEL_ALARM='scm-simco-channel';
const SIMCO_CHANNEL_STALE_WANT_MS=2*60000;
// The Market Refresh press being served ({[realm]:{resourceId,quality,at}}), so the queued refresh:<realm> job reads the
// same product later. storage.session, written in the channel chain.
const SIMCO_REFRESH_WANT_KEY='scmSimcoRefreshWant';
let simcoChannelMem,simcoChannelTail=Promise.resolve(),simcoChannelTimer=null,simcoChannelQueueRun=null;
function simcoChannelCore(){const C=globalThis.SCM_TIMERS_CORE;return C&&C.SIMCO&&typeof C.simcoTake==='function'&&typeof C.simcoResult==='function'?C:null;}
async function simcoChannelLoad(){
  if(simcoChannelMem!==undefined)return simcoChannelMem;
  const C=simcoChannelCore();let v=null;
  try{if(C&&chrome.storage?.session)v=(await chrome.storage.session.get(C.SIMCO.KEY))?.[C.SIMCO.KEY]||null;}catch{}
  if(simcoChannelMem===undefined)simcoChannelMem=v;
  return simcoChannelMem;
}
function simcoChannelSerial(fn){const run=simcoChannelTail.then(fn,fn);simcoChannelTail=run.catch(()=>{});return run;}
async function simcoChannelStore(st){
  simcoChannelMem=st;simcoRateLimitUntil=Number(st?.cooldownUntil)>Date.now()?Number(st.cooldownUntil):0;
  try{const C=simcoChannelCore();if(C&&chrome.storage?.session)await chrome.storage.session.set({[C.SIMCO.KEY]:st});}catch{}
}
// The channel state now (read-only, no write).
function simcoChannelPeek(){return simcoChannelSerial(async()=>{const C=simcoChannelCore();return C?C.simcoState(await simcoChannelLoad(),Date.now()):null;});}
// The channel job of a SimcoTools URL whose caller named none.
function simcoJobKeyForUrl(url){
  let p='';try{p=new URL(String(url)).pathname;}catch{p=String(url||'').split(/[?#]/)[0];}
  const m=p.match(/\/v1\/realms\/(\d+)(?:\/|$)/),sfx=m&&(m[1]==='0'||m[1]==='1')?`:${m[1]}`:'';
  if(/\/market\/vwaps(?:\/|$)/i.test(p))return `vwap${sfx}`;
  if(/\/market\/followed\/?$/i.test(p))return `followed${sfx}`;
  if(/\/market\/prices\/?$/i.test(p))return `prices${sfx}`;
  if(/\/market\/resources\/\d+\/\d+\/candlesticks\/?$/i.test(p))return `candles${sfx}`;
  if(/\/market\/resources\/\d+\/\d+\/?$/i.test(p))return `snapshot${sfx}`;
  return `public${sfx}`;
}
function simcoChannelClock(ms){const d=new Date(Number(ms)||Date.now());return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;}
const SIMCO_OUTAGE_RETRY_TEXT='retrying 1, 2, 5, 10, then every 15 min';
function simcoUnreachableText(since){return `SimcoTools unreachable since ${simcoChannelClock(since)}; ${SIMCO_OUTAGE_RETRY_TEXT}`;}
// The channel's wants in serving order (prio, then oldest), as SCM_TIMERS_CORE orders them.
function simcoChannelOrder(C,st){
  return Object.entries(st?.wants||{}).map(([k,w])=>({k,since:Number(w?.since)||0,at:Number(w?.at)||0,prio:C.simcoSpec(k).prio,flying:w?.reason==='in flight'}))
    .sort((a,b)=>a.prio-b.prio||a.since-b.since||(a.k<b.k?-1:a.k>b.k?1:0));
}
function simcoChannelHasRunner(C,k){try{return typeof SIMCO_CHANNEL_RUNNERS[C.laneBase(k)]==='function';}catch{return false;}}
// When the queue may be served next: the cooldown end, the next probe, or when a token is back.
function simcoChannelNextAt(st,now=Date.now()){
  if(!st)return now;
  if(Number(st.cooldownUntil)>now)return Number(st.cooldownUntil);
  if(st.unreachableSince)return Math.max(now,Number(st.nextProbeAt)||now);
  const C=simcoChannelCore(),rate=Number(C?.SIMCO?.RATE_PER_S)||2;
  return Number(st.tokens)<1?now+Math.ceil((1-Number(st.tokens))*1000/rate):now;
}
// Arms the queue run when a queued want has a runner: a timer for a wait under 25 s (a token / a short Retry-After),
// else (and also, as the backstop for a worker that sleeps) the one 'scm-simco-channel' alarm at the earliest time.
function simcoChannelArm(st,hintAt=0){
  const C=simcoChannelCore();if(!C||!st)return;
  const now=Date.now();
  // While SimcoTools is unreachable the probe is always armed, even with only runner-less wants (or none): the queue
  // run then probes through the public-data runner (SIMCO_CHANNEL_FALLBACK_PROBE), so an outage never stays stuck.
  const servable=Object.entries(st.wants||{}).some(([k,w])=>w?.reason!=='in flight'&&simcoChannelHasRunner(C,k));
  if(!st.unreachableSince&&!servable)return;
  // Fallback-probe only: no sooner than 1 min (an overdue probe whose job had nothing due does not spin every 30 s).
  const at=Math.max(Number(hintAt)||0,simcoChannelNextAt(st,now),servable?0:now+60000);
  if(at-now<25000){if(simcoChannelTimer)clearTimeout(simcoChannelTimer);simcoChannelTimer=setTimeout(()=>{simcoChannelTimer=null;simcoChannelRunQueue('timer').catch(()=>{});},Math.max(250,at-now+50));}
  (async()=>{
    if(!chrome.alarms)return;
    const when=Math.max(now+30000,at);
    const cur=await chrome.alarms.get(SIMCO_CHANNEL_ALARM).catch(()=>null);
    if(cur&&Number(cur.scheduledTime)>now&&Number(cur.scheduledTime)<=when+1000)return;
    await scmAlarmCreate(SIMCO_CHANNEL_ALARM,{when});
  })().catch(()=>{});
}
// take:true -> the caller sends exactly ONE request now. A refusal sends nothing: the want stays queued, the queue is armed.
function simcoChannelTake(key,{peek=false}={}){
  return simcoChannelSerial(async()=>{
    // timers-core.js is part of the package (importScripts); only a stripped harness lacks it: the request goes as before.
    const C=simcoChannelCore();if(!C)return {take:true,noChannel:true,nextAt:Date.now()};
    const d=C.simcoTake(await simcoChannelLoad(),key,Date.now(),{peek,canRun:k=>simcoChannelHasRunner(C,k)});
    await simcoChannelStore(d.state);
    if(!d.take)simcoChannelArm(d.state,d.nextAt);
    return d;
  });
}
// ONE Activity line per outage (error log when no realm is known yet), one when SimcoTools answers again.
function simcoChannelLogOutage(since){try{logActivityAnyRealm('simcotools-channel','not-read',{unreachableSince:new Date(Number(since)||Date.now()).toISOString(),outage:true},simcoUnreachableText(since));}catch{}}
function simcoChannelLogRecovered(){try{logActivityAnyRealm('simcotools-channel','success',{recovered:true},'SimcoTools is reachable again');}catch{}}
// The answer of a request that took a token: {ok,status,network,retryAfterMs}.
function simcoChannelResult(key,res){
  return simcoChannelSerial(async()=>{
    const C=simcoChannelCore();if(!C)return null;
    const now=Date.now(),out=C.simcoResult(await simcoChannelLoad(),key,res||{},now);
    await simcoChannelStore(out.state);
    if(out.logOutage)simcoChannelLogOutage(out.state?.unreachableSince||now);
    if(out.recovered){simcoChannelLogRecovered();if(!simcoChannelQueueRun)setTimeout(()=>{simcoChannelRunQueue('recovered').catch(()=>{});},0);}
    if(!res?.ok)simcoChannelArm(out.state);
    return out;
  });
}
function simcoChannelDropWant(key){return simcoChannelSerial(async()=>{const C=simcoChannelCore();if(!C)return;const st=C.simcoState(await simcoChannelLoad(),Date.now());if(!st.wants[key])return;delete st.wants[key];await simcoChannelStore(st);});}
async function simcoRefreshWantSet(realm,product){
  return simcoChannelSerial(async()=>{try{if(!chrome.storage?.session)return;const cur=(await chrome.storage.session.get(SIMCO_REFRESH_WANT_KEY))?.[SIMCO_REFRESH_WANT_KEY];
    const next=cur&&typeof cur==='object'&&!Array.isArray(cur)?{...cur}:{};next[String(realm)]={resourceId:product?.resourceId??null,quality:product?.quality??null,at:Date.now()};
    await chrome.storage.session.set({[SIMCO_REFRESH_WANT_KEY]:next});}catch{}});
}
async function simcoRefreshWantGet(realm){try{const cur=(await chrome.storage.session.get(SIMCO_REFRESH_WANT_KEY))?.[SIMCO_REFRESH_WANT_KEY];return cur&&typeof cur==='object'?cur[String(realm)]||null:null;}catch{return null;}}
// What a refused request returns (nothing was sent): the caller keeps its stored data; the job runs later from the queue.
function simcoChannelRefusal(key,d){
  const st=d?.state||{},nextAt=Number(d?.nextAt)||Date.now(),reason=String(d?.reason||'rate');
  const unreachableSince=Number(st.unreachableSince)||0;
  const error=reason==='unreachable'?`${simcoUnreachableText(unreachableSince)} (next try ${simcoChannelClock(nextAt)})`
    :reason==='cooldown'?`SimcoTools asked to wait (429) until ${simcoChannelClock(nextAt)}`
    :reason==='bad-key'?'SimcoTools request refused: bad channel job'
    :'Waiting for the SimcoTools limit (2 per second)';
  return {ok:false,status:0,text:'',skipped:true,queued:reason!=='bad-key',limited:true,rateLimited:reason==='cooldown',unreachable:reason==='unreachable',
    reason,job:key,nextAt,retryAt:new Date(nextAt).toISOString(),unreachableSince:unreachableSince||null,error};
}
// Queue run (alarm / timer / recovery): each queued job with a runner, in priority order, once per run. Its want keeps
// its place while the runner asks again (a refusal keeps it queued and re-arms); a want the runner did not ask for drops. While SimcoTools is unreachable only the
// first job runs (it is the probe); when it answers, the run goes on with the rest.
const SIMCO_CHANNEL_RUNNERS={
  refresh:async realm=>{if(realm==null)return;const w=await simcoRefreshWantGet(realm);await runSimcoMarketRefresh(realm,w?.resourceId,w?.quality,{fromQueue:true});},
  prices:async()=>{await runSimcoPublicData('channel');},
  public:async()=>{await runSimcoPublicData('channel');},
  vwap:async realm=>{if(realm!=null)await runVwapSync({realm,reason:'simco-channel-queue'});},
  followed:async realm=>{if(realm!=null)await runLiveMarketRefresh(realm);}
};
// The outage probe when no queued want can be served: the public-data job (prices first when they are due).
const SIMCO_CHANNEL_FALLBACK_PROBE=async()=>{await runSimcoPublicData('channel-probe');};
function simcoChannelRunQueue(trigger='alarm'){
  if(simcoChannelQueueRun)return simcoChannelQueueRun;
  let startLastAt=-1;
  simcoChannelQueueRun=(async()=>{
    const C=simcoChannelCore();if(!C)return {ok:false,reason:'no-channel'};
    const done=new Set(),ran=[];startLastAt=Number((await simcoChannelPeek())?.lastAt)||0;
    for(let i=0;i<16;i++){
      if(coreSyncActive())break;
      const now=Date.now(),st=await simcoChannelPeek();if(!st)break;
      if(Number(st.cooldownUntil)>now)break;
      if(st.unreachableSince&&now<Number(st.nextProbeAt))break;
      const order=simcoChannelOrder(C,st).filter(x=>!x.flying&&!done.has(x.k));
      if(st.unreachableSince){
        // A want nobody can serve (no runner) and nobody asks for any more would hold the probe: dropped.
        const first=order.find(x=>!simcoChannelHasRunner(C,x.k));
        if(first&&order[0]===first&&now-first.at>=SIMCO_CHANNEL_STALE_WANT_MS){await simcoChannelDropWant(first.k);done.add(first.k);continue;}
      }
      const next=order.find(x=>simcoChannelHasRunner(C,x.k));
      if(!next){
        // Unreachable with no servable want (only runner-less wants, or none): probe once through the public-data job.
        if(st.unreachableSince&&!done.has('#probe')){done.add('#probe');try{await SIMCO_CHANNEL_FALLBACK_PROBE();}catch(e){logError('simco-channel-probe',e);}ran.push('#probe');continue;}
        break;
      }
      done.add(next.k);
      const parts=next.k.split(':'),realm=parts.length>1?validRealmNumber(parts[1]):null;
      try{await SIMCO_CHANNEL_RUNNERS[C.laneBase(next.k)](realm);}catch(e){logError('simco-channel-runner',e);}
      ran.push(next.k);
      // The want keeps its place (its age) while the runner asks again; a runner that asked nothing for it (its data was
      // fresh, its timer off) leaves the want untouched: dropped, or it would be run again and again.
      await simcoChannelSerial(async()=>{const s=C.simcoState(await simcoChannelLoad(),Date.now()),w=s.wants[next.k];if(w&&w.reason!=='in flight'&&Number(w.at)===next.at){delete s.wants[next.k];await simcoChannelStore(s);}});
      // A probe that went out moved nextProbeAt (or a 429 opened the cooldown): the checks at the top end the run.
    }
    return {ok:true,trigger,ran};
  // A run that sent nothing (every runner refused, e.g. a newer want ahead of it) re-arms no sooner than 30 s: no tight loop.
  })().finally(async()=>{simcoChannelQueueRun=null;try{const st=await simcoChannelPeek();simcoChannelArm(st,(Number(st?.lastAt)||0)===startLastAt?Date.now()+30000:0);}catch{}});
  return simcoChannelQueueRun;
}
try{chrome.alarms?.onAlarm?.addListener?.(a=>{if(a?.name===SIMCO_CHANNEL_ALARM)simcoChannelRunQueue('alarm').catch(()=>{});});}catch{}
// THE SimcoTools request: the only fetch of api.simcotools.com. opts.job: the channel job key (else from the URL).
// One attempt; a refused slot sends nothing. A network failure / timeout returns {ok:false,status:0,network:true}
// (never thrown); the channel writes one line per outage, so callers write no per-attempt line for it (outageLogged).
async function simcoFetch(url, timeoutMs=SIMCOTOOLS_TIMEOUT_MS, opts=null){
  // An executive search keeps the typed name out of every stored copy of the URL (net log) and no body preview; the
  // request itself uses the real URL.
  const privateUrl=scmIsPrivateSimcoUrl(url);
  const logUrl=scmMobileNetSafeUrl(privateUrl?scmMobileNetSafeUrl(url):String(url));
  const key=typeof opts?.job==='string'&&opts.job?opts.job:simcoJobKeyForUrl(url);
  const slot=await simcoChannelTake(key);
  if(!slot.take){
    const refused=simcoChannelRefusal(key,slot);
    await scmMobileNetLogBackground({kind:'request-skipped',url:logUrl,method:'GET',status:0,reason:`simcotools-channel-${refused.reason}`,retryAt:refused.retryAt});
    return refused;
  }
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  const requestStartedAt=Date.now();
  try{
    await scmMobileNetLogBackground({kind:'request-start',url:logUrl,method:'GET',startedAt:new Date(requestStartedAt).toISOString()});
    // No cookies or auth sent to SimcoTools (public API; nothing of the browser session goes to a third party).
    const response=await fetch(url,{method:'GET',cache:'no-store',credentials:'omit',headers:{accept:'application/json'},signal:controller.signal});
    const text=await response.text();
    const status=Number(response.status)||0;
    await scmMobileNetLogBackground({kind:'fetch',url:logUrl,method:'GET',status,ok:Boolean(response.ok),durationMs:Date.now()-requestStartedAt,transport:'extension-background',contentType:String(response.headers?.get?.('content-type')||''),body:text?(privateUrl?{truncated:true,originalLength:text.length,preview:'',redacted:true}:{truncated:text.length>4000,originalLength:text.length,preview:text.slice(0,4000)}):null});
    if(status===429){
      // No per-request retry: the channel cooldown (Retry-After, else the default) holds every SimcoTools job.
      const out=await simcoChannelResult(key,{ok:false,status:429,retryAfterMs:simcoRetryAfterMs(response)});
      const until=Number(out?.state?.cooldownUntil)||Date.now()+SIMCOTOOLS_DEFAULT_RATE_LIMIT_COOLDOWN_MS;
      return {ok:false,status:429,text,retryAt:new Date(until).toISOString(),nextAt:until,rateLimited:true,job:key};
    }
    await simcoChannelResult(key,{ok:Boolean(response.ok),status});
    return {ok:Boolean(response.ok),status,text,job:key};
  }catch(e){
    // "Failed to fetch" / TypeError / timeout (abort) / a dropped body: SimcoTools did not answer -> network.
    const timedOut=e?.name==='AbortError';
    const error=timedOut?`SimcoTools request timed out after ${Math.round(timeoutMs/1000)}s`:`SimcoTools network error: ${e?.message||String(e)}`;
    try{await scmMobileNetLogBackground({kind:'fetch',url:logUrl,method:'GET',status:0,ok:false,durationMs:Date.now()-requestStartedAt,transport:'extension-background',error:error.slice(0,200)});}catch{}
    const out=await simcoChannelResult(key,{ok:false,status:0,network:true});
    const st=out?.state||{},nextAt=Number(st.nextProbeAt)||0;
    return {ok:false,status:0,text:'',network:true,timedOut,outageLogged:true,error,job:key,unreachableSince:Number(st.unreachableSince)||Date.now(),nextAt,retryAt:nextAt?new Date(nextAt).toISOString():null};
  }finally{clearTimeout(timer);}
}
// A refused / failed simcoFetch answer as an Error (callers that throw), with the channel fields kept.
function simcoRespError(resp){
  const e=new Error(resp?.error||(resp?.limited?'Waiting for the SimcoTools limit':`HTTP ${Number(resp?.status)||0} from SimcoTools`));
  for(const k of ['status','retryAt','rateLimited','limited','queued','nextAt','reason','unreachableSince','network','outageLogged','job'])if(resp&&resp[k]!==undefined)e[k]=resp[k];
  e.rateLimited=Boolean(resp?.rateLimited);e.limited=Boolean(resp?.limited);
  return e;
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
async function fetchSimcoVwapPairs(realm,pairs,opts=null){
  const requested=Number.isFinite(Number(realm))?Number(realm):null;
  if(requested==null||!realmDefinition(requested))return {ok:false,rows:[],realm:requested,requested:0,failed:0,failures:[{error:'A valid realm is required for VWAP pair fetch.'}]};
  const list=Array.isArray(pairs)?pairs:[];
  const rows=[];const failures=[];const seen=new Set();
  // One request at a time (SimcoTools rate limit).
  for(const pair of list){
    const rid=Number(pair?.resourceId),q=Number(pair?.quality);
    const url=`https://api.simcotools.com/v1/realms/${requested}/market/vwaps/${rid}/${q}`;
    try{
      const resp=await simcoFetch(url,15000,{job:opts?.job||`vwap:${requested}`});
      // Refused by the channel (nothing sent) or no connection: the remaining pairs wait for the queued run.
      if(resp?.limited||resp?.network){failures.push({resourceId:rid,quality:q,error:resp.error||'Waiting for the SimcoTools limit',status:resp.status||0,rateLimited:Boolean(resp.rateLimited),limited:Boolean(resp.limited),network:Boolean(resp.network),queued:Boolean(resp.queued),nextAt:resp.nextAt||null,retryAt:resp.retryAt||null});break;}
      if(!resp.ok)throw simcoRespError(resp);
      const data=parseSimcoResponse(resp.text);
      const value=extractSimcoExactVwap(data);
      if(value==null) throw new Error('No exact VWAP value returned');
      const key=vwapPairKey(rid,q);
      if(!seen.has(key)){seen.add(key);rows.push({resourceId:rid,quality:q,value});}
    }catch(e){const failure={resourceId:rid,quality:q,error:e?.message||String(e)};if(Number(e?.status)===429||e?.rateLimited){failure.status=429;failure.rateLimited=true;failure.retryAt=e?.retryAt||null;}failures.push(failure);}
  }
  return {ok:rows.length>0,rows,realm:requested,requested:list.length,failed:failures.length,failures};
}

async function fetchSimcoVwapDataset(realm,opts=null){
  const requestedRealm=Number.isFinite(Number(realm))?Number(realm):null;
  if(requestedRealm==null || !realmDefinition(requestedRealm)){
    return {ok:false,rows:[],source:'SimcoTools',realm:requestedRealm,failed:0,total:0,failures:[{error:'A valid game realm is required for VWAP data.'}]};
  }
  // VWAP is strictly realm-specific. Never fall back to another realm.
  try{
    const url=`https://api.simcotools.com/v1/realms/${requestedRealm}/market/vwaps`;
    const resp=await simcoFetch(url,SIMCOTOOLS_TIMEOUT_MS,{job:opts?.job||`vwap:${requestedRealm}`});
    if(resp?.limited)return {ok:false,rows:[],source:'SimcoTools',realm:requestedRealm,failed:0,total:0,limited:true,queued:Boolean(resp.queued),reason:resp.reason||null,nextAt:resp.nextAt||null,unreachableSince:resp.unreachableSince||null,retryAt:resp.retryAt,failures:[{error:resp.error||'Waiting for the SimcoTools limit',status:resp.status||0,rateLimited:Boolean(resp.rateLimited),limited:true,retryAt:resp.retryAt}]};
    if(resp?.network)return {ok:false,rows:[],source:'SimcoTools',realm:requestedRealm,failed:0,total:0,network:true,unreachableSince:resp.unreachableSince||null,nextAt:resp.nextAt||null,retryAt:resp.retryAt||null,failures:[{error:resp.error,status:0,network:true}]};
    const data=parseSimcoResponse(resp.text);
    if(!resp.ok) return {ok:false,rows:[],source:'SimcoTools',realm:requestedRealm,failed:0,total:0,status:resp.status,rateLimited:Boolean(resp.rateLimited),retryAt:resp.retryAt||null,failures:[{error:`HTTP ${resp.status} from SimcoTools realm ${requestedRealm}`,status:resp.status,rateLimited:Boolean(resp.rateLimited),retryAt:resp.retryAt||null}]};
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

// SimcoTools / Sim Companies publish VWAP once a day; each download is the full ~989-row dataset plus a large store write.
// After a download that CHANGED the data, the next one waits 20 h; while the data is unchanged (not published yet),
// retry no sooner than every 3 h. That converges on ~1-3 downloads a day, at most ~3 h after the daily update.
const VWAP_AFTER_CHANGE_MS=20*3600e3;
const VWAP_RECHECK_MS=3*3600e3;
function vwapCacheFresh(cached,now=Date.now()){
  const fetched=Date.parse(String(cached?.fetchedAt||'')),changed=Date.parse(String(cached?.dataChangedAt||''));
  if(Number.isFinite(changed)&&now-changed>=0&&now-changed<VWAP_AFTER_CHANGE_MS)return true;
  return Number.isFinite(fetched)&&now-fetched>=0&&now-fetched<VWAP_RECHECK_MS;
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
  // Every exit leaves vwapSyncing false: "Syncing…" is written only right before a request, each branch writes its
  // own final status, and a throw anywhere writes a failed status (then rethrows). A vwapSyncing:true left by an
  // older version is cleared by the next run whichever branch it takes.
  const label=`R${realm===0?'1':'2'}`;
  try{
    return await runVwapSyncForRealm(realm,targetKey,label,options);
  }catch(e){
    const error=e?.message||String(e);
    try{await vwapLockedStatus({message:`${label} VWAP sync failed: ${error}`,vwapError:error,vwapSyncing:false,vwapRealm:realm},realm);}catch{}
    throw e;
  }
}
async function runVwapSyncForRealm(realm,targetKey,label,options={}){
  const targetState=await state(realm);
  const targetStore={...(targetState.realmStores?.[targetKey]||{})};
  const warehouseRows=Array.isArray(options.warehouseRows)&&options.warehouseRows.length?options.warehouseRows:(Array.isArray(targetStore.warehouseResources)?targetStore.warehouseResources:[]);
  const cached=targetStore.vwapData||null;
  const cachedRows=Array.isArray(cached?.rows)&&Number(cached?.sourceRealm)===realm?cached.rows:[];
  const cacheFresh=!options.force&&vwapCacheFresh(cached,Date.now())&&!cached?.stale&&!cached?.fallback&&Number(cached?.sourceRealm)===realm;
  const today=new Date().toISOString().slice(0,10);
  if(cachedRows.length&&cacheFresh){
    const warehouseVwaps=filterVwapRowsToWarehouse(cachedRows,warehouseRows);
    const mergedHistory=mergeDailyVwapHistory(targetStore.history||{},warehouseVwaps,today);
    // Nothing new: no history / VWAP write. The status is written only when it is not a settled one (vwapSyncing:true
    // left by an older version, or an old error), so the usual unchanged run writes nothing.
    if(JSON.stringify(mergedHistory)===JSON.stringify(targetStore.history||{})){
      const st=targetState.vwapStatus||targetStore.vwapStatus||{};
      if(st.vwapSyncing||st.vwapError)await vwapLockedStatus({message:`${label} VWAP data already current for ${today}: ${cachedRows.length} values; ${warehouseVwaps.length} warehouse matches.`,vwapRecords:cachedRows.length,vwapWarehouseRecords:warehouseVwaps.length,vwapRequested:cachedRows.length,vwapFailed:0,vwapFetchedAt:cached.fetchedAt||null,vwapSourceRealm:realm,vwapWarehouseRealm:realm,vwapWarehouseRows:warehouseRows.length,vwapSyncing:false,vwapError:null,vwapRealm:realm},realm);
      return {ok:true,cached:true,unchanged:true,records:warehouseVwaps.length,requested:cachedRows.length,failed:0,source:cached.source||'SimcoTools',realm};
    }
    await vwapLockedCommit(realm,{history:mergedHistory},['history','vwapData']);
    await vwapLockedStatus({message:`R${realm===0?'1':'2'} VWAP data already current for ${today}: ${cachedRows.length} values; ${warehouseVwaps.length} warehouse matches.`,vwapRecords:cachedRows.length,vwapWarehouseRecords:warehouseVwaps.length,vwapRequested:cachedRows.length,vwapFailed:0,vwapFetchedAt:targetStore.vwapData.fetchedAt,vwapSourceRealm:realm,vwapWarehouseRealm:realm,vwapWarehouseRows:warehouseRows.length,vwapSyncing:false,vwapError:null,vwapRealm:realm},realm);
    return {ok:true,cached:true,records:warehouseVwaps.length,requested:cachedRows.length,failed:0,source:targetStore.vwapData.source||'SimcoTools',realm};
  }

  // A request is about to be made: only now is "Syncing…" shown (every path below writes vwapSyncing:false).
  await vwapLockedStatus({message:`Syncing ${label} VWAP data from SimcoTools…`,vwapSyncing:true,vwapError:null,vwapRealm:realm},realm);
  const vwapJob=typeof options.job==='string'&&options.job?options.job:`vwap:${realm}`;
  let result=await fetchSimcoVwapDataset(realm,{job:vwapJob});
  // Refused by the SimcoTools channel: nothing was requested; the stored VWAP stays and the queued job runs later.
  if(result.limited){
    const why=result.reason==='unreachable'?`SimcoTools (unreachable since ${simcoChannelClock(result.unreachableSince)})`:result.reason==='cooldown'?'SimcoTools (it asked to wait, 429)':'the SimcoTools limit';
    await vwapLockedStatus({message:`${label} VWAP waits for ${why}.`,vwapSyncing:false,vwapRealm:realm},realm);
    return {ok:false,skipped:true,limited:true,queued:Boolean(result.queued),reason:result.reason||null,nextAt:result.nextAt||null,unreachableSince:result.unreachableSince||null,realm,requested:0,failed:0,retryAt:result.retryAt,failures:result.failures};
  }
  let allVwaps=Array.isArray(result.allRows)?result.allRows:(Array.isArray(result.rows)?result.rows:[]);
  let sourceMode='live-bulk';
  let failures=(result.failures||[]).slice(0,50);

  // If the bulk dataset is unavailable, use the realm-specific per-resource/per-quality
  // endpoint. This never crosses realms and does not reuse another realm's data.
  // Not when SimcoTools did not answer or asked to wait: every pair request would be refused by the channel anyway.
  if(!allVwaps.length&&!result.network&&!result.rateLimited){
    const pairs=await vwapPairsForRealm(targetStore);
    const pairResult=await fetchSimcoVwapPairs(realm,pairs,{job:vwapJob});
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
  const signature=vwapDatasetSignature(allVwaps),prevSignature=Number(cached?.sourceRealm)===realm&&!cached?.stale?String(cached?.signature||''):'';
  const dataChangedAt=stale?(cached?.dataChangedAt||null):(prevSignature&&prevSignature===signature?(cached?.dataChangedAt||null):now);
  const vwapData={rows:allVwaps,fetchedAt:stale?(cached?.fetchedAt||now):now,updatedAt:now,dataChangedAt,source:'SimcoTools',sourceMode,stale,fallback:stale,endpoint:`/v1/realms/${realm}/market/vwaps`,count:allVwaps.length,warehouseOnly:false,warehouseCombinations:warehouseVwaps.length,requestedCombinations:sourceMode==='live-pairs'?allVwaps.length:null,failedCombinations:failures.length,datasetRows:result.datasetRows||allVwaps.length,sourceRealm:realm,warehouseRealm:realm,failures:failures.slice(0,50),signature};
  const nextWatch={...(targetStore.vwapWatch||DEFAULTS.vwapWatch),lastSourceRealm:realm};
  await vwapLockedCommit(realm,{vwapData,history:mergedHistory,vwapWatch:nextWatch},['vwapData','history','vwapWatch']);
  if(!stale)void recordPriceObservations(realm,allVwaps,now);
  await vwapLockedStatus({message:`R${realm===0?'1':'2'} VWAP sync ${stale?'loaded the R1 last-known fallback':'complete'}: ${allVwaps.length} values; ${warehouseVwaps.length} match the current warehouse.`,vwapRecords:allVwaps.length,vwapWarehouseRecords:warehouseVwaps.length,vwapRequested:allVwaps.length,vwapFailed:failures.length,vwapFetchedAt:vwapData.fetchedAt,vwapUpdatedAt:now,vwapSourceRealm:realm,vwapWarehouseRealm:realm,vwapWarehouseRows:warehouseRows.length,vwapSyncing:false,vwapError:stale?'Live VWAP fetch failed; using stale R1 fallback.':null,vwapFallback:stale,vwapRealm:realm},realm);
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
// SimcoTools' summary already carries the recent trade closes and the
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
// One SimcoTools request for many products: GET /v1/realms/{realm}/market/followed?resources=<id>q<quality>,...
// (40 pairs per request). Returns Map "id:q" -> the same snapshot shape as fetchSimcoMarketSnapshot.
async function fetchSimcoFollowedSnapshots(realm,pairs,opts=null){
  const snaps=new Map();
  const list=(Array.isArray(pairs)?pairs:[]).map(p=>({id:Number(p.resourceId),q:Number(p.quality)})).filter(p=>Number.isSafeInteger(p.id)&&p.id>0&&Number.isSafeInteger(p.q)&&p.q>=0);
  for(let i=0;i<list.length;i+=40){
    const chunk=list.slice(i,i+40);
    const url=`https://api.simcotools.com/v1/realms/${realm}/market/followed?resources=${chunk.map(p=>`${p.id}q${p.q}`).join(',')}`;
    const resp=await simcoFetch(url,20000,{job:opts?.job||`followed:${realm}`});
    if(resp?.limited)return {ok:false,error:resp.error||'Waiting for the SimcoTools limit',status:resp.status||0,rateLimited:Boolean(resp.rateLimited),limited:true,queued:Boolean(resp.queued),reason:resp.reason||null,nextAt:resp.nextAt||null,unreachableSince:resp.unreachableSince||null,retryAt:resp.retryAt||null,snaps};
    // No connection: like a refusal (limited, no per-pair 429 cooldown); the channel probes and runs the queued job.
    if(resp?.network)return {ok:false,error:resp.error,status:0,network:true,limited:true,unreachableSince:resp.unreachableSince||null,nextAt:resp.nextAt||null,retryAt:resp.retryAt||null,snaps};
    if(!resp?.ok)return {ok:false,error:`HTTP ${resp?.status||0} from SimcoTools`,status:resp?.status||0,rateLimited:Boolean(resp?.rateLimited),retryAt:resp?.retryAt||null,snaps};
    const data=parseSimcoResponse(resp.text);
    const rows=Array.isArray(data?.summaries)?data.summaries:[];
    for(const s of rows){const rid=Number(s?.resourceId),q=Number(s?.quality);if(Number.isFinite(rid)&&Number.isFinite(q))snaps.set(vwapPairKey(rid,q),normalizeSimcoMarketSnapshot(s,rid,q));}
  }
  return {ok:true,snaps};
}
async function fetchSimcoMarketSnapshot(realm,resourceId,quality,opts=null){
  const url=`https://api.simcotools.com/v1/realms/${realm}/market/resources/${resourceId}/${quality}`;
  const resp=await simcoFetch(url,12000,{job:opts?.job||`snapshot:${realm}`});
  if(!resp.ok)throw simcoRespError(resp);
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
async function fetchSimcoMarketCandles(realm,resourceId,quality,opts=null){
  const url=`https://api.simcotools.com/v1/realms/${realm}/market/resources/${resourceId}/${quality}/candlesticks`;
  const resp=await simcoFetch(url,12000,{job:opts?.job||`candles:${realm}`});
  if(!resp.ok)throw simcoRespError(resp);
  const data=parseSimcoResponse(resp.text);
  return simcoCandleRows(data).map(normalizeSimcoCandle).filter(Boolean);
}
function cachedSimcoVwapForProduct(store,realm,resourceId,quality){
  return globalThis.SCM_MARKET_CORE.vwap(store,realm,resourceId,quality)?.value??null;
}
function validPositiveMarketNumber(value){
  if(value==null||value==='')return null;
  const n=Number(value);
  return Number.isFinite(n)&&n>0?n:null;
}
// Price history for one product/quality from SimcoTools (daily candles +
// recent trade closes). Cached per realm in its own storage key; no storage lock is
// held while fetching.
const PRICE_HISTORY_TTL_MS=3*60*60*1000;
let priceHistoryWriteTail=Promise.resolve();
async function getPriceHistory(realm,resourceIdArg,qualityArg,force=false){
  const resourceId=validResourceId(resourceIdArg),quality=validQuality(qualityArg);
  if(validRealmNumber(realm)==null||resourceId==null||quality==null)return {ok:false,error:'Invalid product selection.'};
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
async function runLiveMarketProduct(realmArg,resourceIdArg,qualityArg,opts=null){
  const realm=validRealmNumber(realmArg),resourceId=validResourceId(resourceIdArg),quality=validQuality(qualityArg);
  if(realm==null||resourceId==null||quality==null)return {ok:false,error:'Invalid market resource selection.'};

  // Fetch one selected SimcoTools product only. Preserve each completed product
  // by resource+quality so out-of-order responses cannot erase the user's selection.
  // One SimcoTools request per call (SimcoTools channel): the current price, or - when the stored price is
  // under 15 min old and the chart is missing or over 3 h old - the chart. A refused call throws (limited, queued).
  // opts.job: the channel job (the Market Refresh button passes refresh:<realm>; else snapshot / candles).
  const pre=(await state(realm)).realmStores?.[realmKeyFromRealm(realm)]?.liveMarketProductCache?.[`${resourceId}:${quality}`]||null;
  const preAt=Date.parse(String(pre?.fetchedAt||'')),preCandlesAt=Date.parse(String(pre?.candlesFetchedAt||''));
  const preCandles=Array.isArray(pre?.selected?.candles)?pre.selected.candles:[];
  const snapFresh=Boolean(pre?.selected)&&Number.isFinite(preAt)&&Date.now()-preAt<15*60e3;
  const candlesStale=!preCandles.length||!(Date.now()-preCandlesAt<3*3600e3);
  let selectedRaw,snapshotAt=new Date().toISOString(),candlesFetchedAt=pre?.candlesFetchedAt||null;
  if(snapFresh&&candlesStale){
    selectedRaw={...pre.selected};snapshotAt=pre.fetchedAt;
    selectedRaw.candles=await fetchSimcoMarketCandles(realm,resourceId,quality,opts);candlesFetchedAt=new Date().toISOString();
  }else{
    selectedRaw=await fetchSimcoMarketSnapshot(realm,resourceId,quality,opts);
    selectedRaw.candles=preCandles;
  }
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
    const bulkVwap=cachedSimcoVwapForProduct(store,realm,resourceId,quality);
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
    const selectedPriceRow={resourceId,quality,price:selectedPrice,lastTrade:selected.lastTrade||null,vwap:selected.vwap??bulkVwap,fetchedAt:snapshotAt};
    // Do not overwrite a good cached exchange value with an empty/invalid payload.
    if(selectedPrice!=null)currentPriceData.set(productKey,selectedPriceRow);
    const qualityRows=Array.from(currentPriceData.values())
      .filter(row=>Number(row?.resourceId)===resourceId)
      .map(row=>({
        resourceId:Number(row.resourceId),quality:Number(row.quality),price:validPositiveMarketNumber(row.price),
        lastTrade:row.lastTrade||null,
        vwap:validPositiveMarketNumber(row.vwap)??cachedSimcoVwapForProduct(store,realm,row.resourceId,row.quality)
      }))
      .sort((a,b)=>a.quality-b.quality);
    data={...existingProduct,resourceId,quality,selected,qualities:qualityRows,vwap:selected.vwap??bulkVwap,failures:[],fetchedAt:snapshotAt,candlesFetchedAt,updatedAt:checkedAt,source:'SimcoTools'};
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
  // Oldest (or no) backup price first. Normally one batched request covers every pair that needs a price; without the
  // batch only one product is asked per run, the others keep their stored price for later runs (queued, not failed).
  const pairAge=p=>{const t=Date.parse(String(existingPriceByKey.get(vwapPairKey(p.resourceId,p.quality))?.fetchedAt||''));return Number.isFinite(t)?t:0;};
  pairs.sort((a,b)=>pairAge(a)-pairAge(b));
  let networkAttempts=0,queued=0;
  // One batched SimcoTools request for every pair that needs a new price (the per-pair requests are gone).
  const batchNeeded=pairs.filter(p=>{const row=existingPriceByKey.get(vwapPairKey(p.resourceId,p.quality));const at=Date.parse(String(row?.fetchedAt||''));return !(row&&!row.stale&&validPositiveMarketNumber(row.price)!=null&&Number.isFinite(at)&&Date.now()-at<15*60*1000);});
  let batchSnaps=null,batchError=null;
  if(batchNeeded.length){const b=await fetchSimcoFollowedSnapshots(realm,batchNeeded);if(b.ok)batchSnaps=b.snaps;else{batchSnaps=new Map();batchError=b;}}
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
    if(!batchSnaps){if(networkAttempts>=1){queued++;continue;}networkAttempts++;}
    try{const snap=batchSnaps?batchSnaps.get(pairKey):await fetchSimcoMarketSnapshot(realm,pair.resourceId,pair.quality);if(batchSnaps&&!snap&&batchError)throw Object.assign(new Error(batchError.error||'SimcoTools batch failed'),{status:batchError.status,rateLimited:batchError.rateLimited,limited:batchError.limited,retryAt:batchError.retryAt});const price=validPositiveMarketNumber(snap?.price);if(price==null)throw new Error('No valid current price returned');delete pairCooldowns[pairKey];delete endpointCooldowns[endpoint];out.push({resourceId:Number(pair.resourceId),quality:Number(pair.quality),price,lastTrade:snap.lastTrade||null,trend:snap.trend||null,fetchedAt:new Date().toISOString(),stale:false});}
    catch(e){const failure={resourceId:Number(pair.resourceId),quality:Number(pair.quality),error:e?.message||String(e)};if(e?.limited){failure.status=429;failure.rateLimited=true;failure.limited=true;failure.retryAt=e?.retryAt||null;}else if(Number(e?.status)===429||e?.rateLimited){const parsed=Date.parse(String(e?.retryAt||''));const until=Number.isFinite(parsed)&&parsed>Date.now()?parsed:Date.now()+SIMCOTOOLS_PAIR_RATE_LIMIT_COOLDOWN_MS;pairCooldowns[pairKey]=until;endpointCooldowns[endpoint]=until;simcoRateLimitUntilByUrl.set(endpoint,until);failure.status=429;failure.rateLimited=true;failure.retryAt=new Date(until).toISOString();await persistSimcoCooldowns();}failures.push(failure);}
  }};
  await worker();
  const merged=new Map();
  for(const row of (Array.isArray(previousPriceData.rows)?previousPriceData.rows:[])){
    const id=Number(row?.resourceId),q=Number(row?.quality),price=validPositiveMarketNumber(row?.price),pairKey=vwapPairKey(id,q),cachedAt=Date.parse(String(row?.fetchedAt||''));
    // One product per run means most rows are minutes to hours old: a row is stale only after 3 h (market-core's SimcoTools age).
    const stillFresh=!row?.stale&&Number.isFinite(cachedAt)&&Date.now()-cachedAt<(globalThis.SCM_MARKET_CORE?.SIMCOTOOLS_MAX_AGE_MS||3*3600e3);
    if(id>0&&Number.isFinite(id)&&q>=0&&Number.isFinite(q)&&price!=null)merged.set(pairKey,{...row,resourceId:id,quality:q,price,fetchedAt:row.fetchedAt||previousPriceData.fetchedAt||null,stale:!stillFresh});
  }
  for(const row of out)merged.set(vwapPairKey(row.resourceId,row.quality),{...row,stale:false});
  const priceRows=[...merged.values()];
  const lastSuccessfulUpdate=out.map(row=>Date.parse(String(row.fetchedAt||''))).filter(Number.isFinite).reduce((max,value)=>Math.max(max,value),0);
  const lastSuccessfulUpdateAt=lastSuccessfulUpdate?new Date(lastSuccessfulUpdate).toISOString():(previousPriceData.updatedAt||previousPriceData.fetchedAt||null);
  const priceData={...previousPriceData,rows:priceRows,fetchedAt:lastSuccessfulUpdateAt,updatedAt:lastSuccessfulUpdateAt,lastAttemptAt:checkedAt,source:'SimcoTools',sourceMode:'live-warehouse-and-production-current-prices',realm,warehouseCount:warehouseRows.filter(row=>warehouseQuantity(row)>0).length,productionAndWarehousePairCount:pairs.length,requested:pairs.length,checked:pairs.length-failures.filter(f=>/cooldown/i.test(String(f.error||''))).length,fetched:out.length,updated:out.length,refreshed:out.length,cacheHits:freshCacheHits,cached:priceRows.filter(row=>row.stale).length,freshRows:out.length+freshCacheHits,staleRows:priceRows.filter(row=>row.stale).length,failed:failures.length,queued,failures:failures.slice(0,50),rateLimitedUntilByPair:{...pairCooldowns},rateLimitedUntilByEndpoint:{...endpointCooldowns}};
  const productCache={...(targetStore.liveMarketProductCache||{})};
  for(const row of out){const productKey=`${row.resourceId}:${row.quality}`,existing=productCache[productKey]&&typeof productCache[productKey]==='object'?productCache[productKey]:{};const selected={...(existing.selected||{}),resourceId:row.resourceId,quality:row.quality,price:row.price,lastTrade:row.lastTrade,fetchedAt:row.fetchedAt};productCache[productKey]={...existing,resourceId:row.resourceId,quality:row.quality,selected,fetchedAt:row.fetchedAt,updatedAt:row.fetchedAt,source:'SimcoTools'};}
  await withRealmWriteLock(realm,async()=>{const latest=await state(realm),stores={...(latest.realmStores||{})},store={...(stores[key]||{})};stores[key]={...store,liveMarketPriceData:priceData,liveMarketProductCache:productCache};const rootPatch=key===latest.activeRealmKey?{liveMarketPriceData:priceData,liveMarketProductCache:productCache}:{};await storageSet({realmStores:stores,...rootPatch});});
  scheduleGameOverlayRefreshNotification(realm,150);
  const finishedAt=new Date().toISOString(),durationMs=Date.now()-jobStartedMs;
  // Nothing downloaded because every price was still fresh (<15 min) is a skip, not a failure.
  const onlyLimited=failures.length>0&&failures.every(f=>f?.limited);
  const outcome=out.length?(failures.length&&!onlyLimited?'partial':'success'):(((freshCacheHits>0||queued>0)&&!failures.length)||onlyLimited?'skipped':'failure');
  // One cause text for the job entry and the returned result, so market-current-price-stage and market-prices-stage agree.
  const firstFailure=failures[0];
  const noFreshPriceError=`No fresh current-price data returned (${failures.length}/${pairs.length} failed${firstFailure?.error?`: ${String(firstFailure.error).slice(0,160)}`:''}).`;
  await recordBackgroundJobEvent(realm,{job:'market-current-price-stage',trigger:'scheduled-or-message',startedAt:jobStartedAt,finishedAt,durationMs,outcome,requested:pairs.length,fetched:out.length,refreshed:out.length,checked:pairs.length-failures.filter(f=>/cooldown/i.test(String(f.error||''))).length,cacheHits:freshCacheHits,cached:priceRows.filter(row=>row.stale).length,stale:priceRows.filter(row=>row.stale).length,error:outcome==='failure'?noFreshPriceError:null,details:{failed:failures.length,rateLimited:failures.filter(f=>f.rateLimited).length}}).catch(()=>{});
  if(outcome!=='failure')notifyAfterPriceUpdate(realm).catch(()=>{});
  return {ok:out.length>0||freshCacheHits>0,queued,limited:onlyLimited&&!out.length,realm,stage:'prices',requested:pairs.length,checked:pairs.length-failures.filter(f=>/cooldown/i.test(String(f.error||''))).length,fetched:out.length,refreshed:out.length,cacheHits:freshCacheHits,cached:priceRows.filter(row=>row.stale).length,stale:priceRows.filter(row=>row.stale).length,failed:failures.length,currentPricesUpdated:out.length,currentPricesFailed:failures.length,errors:failures.slice(0,10),error:(out.length>0||freshCacheHits>0)?null:noFreshPriceError,startedAt:jobStartedAt,finishedAt,durationMs};
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

// SimcoTools channel status for a reply: {queued, nextAt, unreachableSince, nextProbeAt, cooldownUntil}. key: one job's
// want (else any want). nextAt: when the channel serves again (0 when nothing waits and it is open).
async function simcoChannelStatus(key=null){
  const st=await simcoChannelPeek(),now=Date.now();
  if(!st)return {queued:false,nextAt:0,unreachableSince:null,nextProbeAt:null,cooldownUntil:null};
  const queued=key?Boolean(st.wants?.[key]&&st.wants[key].reason!=='in flight'):Object.keys(st.wants||{}).length>0;
  const cool=Number(st.cooldownUntil)>now?Number(st.cooldownUntil):null;
  return {queued,nextAt:queued||st.unreachableSince||cool?simcoChannelNextAt(st,now):0,unreachableSince:st.unreachableSince||null,nextProbeAt:st.unreachableSince?Number(st.nextProbeAt)||null:null,cooldownUntil:cool};
}
// The Market Refresh button (LIVE_MARKET_REFRESH manual:true): SimcoTools only, NEVER a game request. One request in the
// channel job refresh:<realm> (priority 1): the product being viewed (its SimcoTools snapshot / chart, runLiveMarketProduct),
// else all prices (the realm's VWAP dataset, fetchSimcoVwapDataset through runVwapSync). Refused or SimcoTools down: no
// request now; the job stays queued and the channel queue runs it (same product, SIMCO_REFRESH_WANT_KEY) later.
// Reply: {ok, queued, nextAt, unreachableSince, reason, realm, resourceId, quality, target:'product'|'all-prices',
// source:'SimcoTools', noGameRead:true, fetchedAt, error} - the dashboard shows "SimcoTools unreachable since HH:MM · retry m:ss".
async function runSimcoMarketRefresh(realmArg,resourceIdArg,qualityArg,{fromQueue=false}={}){
  const realm=validRealmNumber(realmArg);
  if(realm==null)return {ok:false,queued:false,nextAt:0,unreachableSince:null,noGameRead:true,source:'SimcoTools',error:'No valid realm.'};
  const resourceId=resourceIdArg==null||resourceIdArg===''?null:validResourceId(resourceIdArg),quality=qualityArg==null||qualityArg===''?null:validQuality(qualityArg);
  const product=resourceId!=null&&quality!=null,job=`refresh:${realm}`;
  if(!fromQueue)await simcoRefreshWantSet(realm,product?{resourceId,quality}:null);
  let r=null,err=null;
  try{r=product?await runLiveMarketProduct(realm,resourceId,quality,{job}):await runVwapSync({realm,force:true,reason:'manual-market-refresh',job});}
  catch(e){err=e;}
  const ok=!err&&Boolean(r?.ok);
  const s=await simcoChannelStatus(job);
  const queued=!ok&&Boolean(s.queued||err?.queued||r?.queued);
  return {ok,queued,nextAt:queued?(Number(s.nextAt)||Number(err?.nextAt||r?.nextAt)||0):0,unreachableSince:s.unreachableSince,
    reason:queued?(err?.reason||r?.reason||(s.unreachableSince?'unreachable':s.cooldownUntil?'cooldown':'rate')):null,
    realm,resourceId:product?resourceId:null,quality:product?quality:null,target:product?'product':'all-prices',source:'SimcoTools',noGameRead:true,
    fetchedAt:ok?(r?.fetchedAt||new Date().toISOString()):null,error:ok?null:String(err?.message||r?.error||'').slice(0,300)||null};
}

// The VWAP sync's network work (SimcoTools downloads: hundreds of spaced requests, rate-limit cooldowns) runs outside
// the realm storage queue, so game captures keep updating the warehouse and overlay meanwhile; each storage write is
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

const LIVE_MARKET_REFRESH_ALARM_NAME='scm-live-market-refresh';
const LIVE_MARKET_REFRESH_PERIOD_MINUTES=5;
// {lastPricesRealm, at}: which realm the last timer run took a backup price for, so runs alternate realms.
const LIVE_MARKET_ROTATION_KEY='scmLiveMarketRotation';
const MARKET_STAGE_ALARM_PREFIX='scm-market-stage-r';
// Start optional market work as soon as core Sync releases its capture lock.
// Resource-image downloads continue independently and provide natural API quiet time.
const POST_SYNC_MARKET_COOLDOWN_MS=1000;
// Chained stages (after Sync / Refresh) each make one SimcoTools request; they stay 5 min (+5 s) apart, (the SimcoTools channel itself allows 2/s, burst 25).
const MARKET_STAGE_COOLDOWN_MS=5*60*1000+5000;
const MARKET_STAGE_REALM_COOLDOWN_MS=5*60*1000+5000;
let liveMarketRefreshAlarmRun=null;
let marketStageRun=null;
function marketStageAlarmName(realm,stage){const n=validRealmNumber(realm);return n==null?null:`${MARKET_STAGE_ALARM_PREFIX}${n}-${stage}`;}
// A stage that fired during a core Sync is parked in syncDeferredWork (key market:<realm>:<stage>) without an alarm;
// it counts as pending too, or every price ask during Sync queues another stage that is deferred again (a ~2 s loop).
function hasDeferredMarketStage(){for(const k of syncDeferredWork.keys())if(String(k).startsWith('market:'))return true;return false;}
// Set synchronously by scheduleMarketCycle so concurrent callers do not each queue a cycle.
let marketCycleScheduling=null;
async function hasPendingMarketStageAlarm(){
  if(marketStageRun||hasDeferredMarketStage())return true;
  try{const all=await chrome.alarms.getAll();return all.some(a=>/^scm-market-stage-r[01]-(?:vwap|prices)$/.test(String(a?.name||'')));}catch{return Boolean(marketStageRun);}
}
async function scheduleMarketStage(realm,stage,delayMs=MARKET_STAGE_COOLDOWN_MS,reason='scheduled'){
  const n=validRealmNumber(realm),name=marketStageAlarmName(realm,stage);
  if(n==null||!name||!['vwap','prices'].includes(stage))return {ok:false,error:'Invalid market stage or realm.'};
  try{await scmCreateShortAlarm(name,Math.max(1000,Number(delayMs)||0));await recordBackgroundJobEvent(n,{job:`market-${stage}-stage-scheduled`,trigger:reason,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),durationMs:0,outcome:'success',details:{alarm:name,delayMs:Math.max(1000,Number(delayMs)||0)}}).catch(()=>{});return {ok:true,realm:n,stage,alarm:name,delayMs:Math.max(1000,Number(delayMs)||0),reason};}
  catch(e){return {ok:false,realm:n,stage,error:e?.message||String(e),reason};}
}
async function scheduleMarketCycle(realmArg,reason='scheduled-market-cycle'){
  const n=validRealmNumber(realmArg);if(n==null)return {ok:false,error:'Invalid realm for market cycle.'};
  // Every automatic start (install, startup, after Sync, cache miss, lost-data check) follows the liveMarket timer;
  // only the Market Refresh button starts it while that timer is off.
  if(reason!=='manual-market-refresh'&&await scmSwitchedOff('liveMarket','market-cycle',n,reason))return {ok:true,queued:false,skipped:true,switchedOff:true,reason:'switched-off'};
  const pending={ok:true,queued:false,skipped:true,reason:'market-cycle-already-pending'};
  if(marketCycleScheduling)return pending;
  const run=(async()=>{
    if(await hasPendingMarketStageAlarm())return pending;
    const other=n===0?1:0;
    try{await chrome.storage.local.set({marketSyncCycleQueue:[n,other]});}catch{}
    return scheduleMarketStage(n,'vwap',POST_SYNC_MARKET_COOLDOWN_MS,reason);
  })();
  marketCycleScheduling=run;
  try{return await run;}finally{if(marketCycleScheduling===run)marketCycleScheduling=null;}
}
async function runMarketStage(realm,stage,reason='alarm'){
  const n=validRealmNumber(realm);if(n==null)return {ok:false,error:'Invalid realm for market stage.'};
  if(coreSyncActive()){deferUntilSyncEnds(`market:${n}:${stage}`,()=>scheduleMarketStage(n,stage,POST_SYNC_MARKET_COOLDOWN_MS,'resumed-after-sync'));return {ok:false,skipped:true,reason:'core-sync-active',realm:n,stage};}
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
        else {try{await chrome.storage.local.set({marketSyncCycleQueue:[]});}catch{}}
      }
      return {ok:Boolean(result?.ok),realm:n,stage,result,durationMs:Date.now()-started};
    }catch(e){const error=e?.message||String(e);await hydrateSimcoCooldowns();await recordBackgroundJobEvent(n,{job:`market-${stage}-stage`,trigger:reason,startedAt,finishedAt:new Date().toISOString(),durationMs:Date.now()-started,outcome:simcoRateLimitUntil>Date.now()?'rate-limited':'failure',error}).catch(()=>{});if(simcoRateLimitUntil>Date.now())await scheduleMarketStage(n,stage,Math.max(POST_SYNC_MARKET_COOLDOWN_MS,simcoRateLimitUntil-Date.now()),`rate-limit-cooldown-${stage}`);else if(stage==='vwap')await scheduleMarketStage(n,'prices',MARKET_STAGE_COOLDOWN_MS,'vwap-stage-failed');return {ok:false,realm:n,stage,error};}
  })().finally(()=>{marketStageRun=null;});
  return marketStageRun;
}

async function ensureLiveMarketRefreshAlarm(reason='ensure'){
  try{
    // Sync timers (liveMarket): off clears it; a changed interval re-creates it, otherwise it is only created when missing.
    const created=await scmEnsureTimerAlarm('liveMarket',{
      delayInMinutes:LIVE_MARKET_REFRESH_PERIOD_MINUTES,
      periodInMinutes:LIVE_MARKET_REFRESH_PERIOD_MINUTES
    },'period');
    const alarm=await chrome.alarms.get(LIVE_MARKET_REFRESH_ALARM_NAME);
    if(!created)return {ok:true,created:false,alarm:alarm||null,disabled:!alarm,reason};
    return {ok:!!alarm,created:true,alarm:alarm||null,reason};
  }catch(e){
    return {ok:false,created:false,error:e?.message||String(e),reason};
  }
}

async function runScheduledLiveMarketRefresh(reason='scheduled'){
  if(liveMarketRefreshAlarmRun)return liveMarketRefreshAlarmRun;
  liveMarketRefreshAlarmRun=(async()=>{
    await ensureRealmStorageMigration();
    if(marketCycleScheduling||await hasPendingMarketStageAlarm())return {ok:true,skipped:true,reason:'market-stage-already-scheduled'};
    const s=await state();
    const selected=validRealmNumber(s.activeRealmKey?.replace(/^realm:/,'')??s.selectedRealm??s.authData?.authCompany?.realmId);
    const first=selected??0,other=first===0?1:0;
    // Every run (default every 5 min) makes at most ONE SimcoTools request (by design; the SimcoTools channel allows 2/s, burst 25):
    // 1. VWAP of the game's realm, then of the other realm, when due (one bulk call each, ~1-3 a day, see VWAP_RECHECK_MS);
    // 2. otherwise one backup price, alternating realms, the product with the oldest backup price first.
    // A step that needs no request (VWAP still current, no products) moves on to the next step in the same run.
    if(coreSyncActive())return {ok:true,skipped:true,reason:'core-sync-active'};
    // SimcoTools cooling down after a 429, or unreachable and its next probe not due: no step (the queued jobs run from
    // the channel queue at that time).
    {const st=await simcoChannelPeek(),now=Date.now();if(st&&(Number(st.cooldownUntil)>now||(st.unreachableSince&&now<Number(st.nextProbeAt)))){const at=simcoChannelNextAt(st,now);return {ok:true,skipped:true,reason:st.unreachableSince?'simcotools-unreachable':'simcotools-cooldown',retryAt:new Date(at).toISOString(),unreachableSince:st.unreachableSince||null};}}
    let rot={};try{rot=(await chrome.storage.local.get({[LIVE_MARKET_ROTATION_KEY]:{}}))[LIVE_MARKET_ROTATION_KEY]||{};}catch{}
    const pricesFirst=validRealmNumber(rot.lastPricesRealm)===first?other:first;
    const steps=[['vwap',first],['vwap',other],['prices',pricesFirst],['prices',pricesFirst===first?other:first]];
    const ran=[];
    for(const [stage,realm] of steps){
      if(coreSyncActive())break;
      const before=Number((await simcoChannelPeek())?.lastAt)||0;
      let result=null;
      try{result=stage==='vwap'?await runVwapSync({realm,reason:'timer-market-vwap'}):await runLiveMarketRefresh(realm);}catch(e){result={ok:false,error:e?.message||String(e)};}
      const requested=(Number((await simcoChannelPeek())?.lastAt)||0)!==before;
      ran.push({stage,realm,ok:Boolean(result?.ok),requested,limited:Boolean(result?.limited)});
      if(stage==='prices'&&requested){try{await rawStorageSet({[LIVE_MARKET_ROTATION_KEY]:{lastPricesRealm:realm,at:Date.now()}});}catch{}}
      if(requested||result?.limited)break;
    }
    return {ok:true,reason,steps:ran};
  })().finally(()=>{liveMarketRefreshAlarmRun=null;});
  return liveMarketRefreshAlarmRun;
}

// SimcoTools public data. The game's data stays the main source; these are the fallback.
//  scmSimcoPrices:<realm>    {at, rows:[[resourceId,quality,price,tradedAtMs],...]}      every 15 min, active realm
//  scmSimcoGovOrders:<realm> {at, orders:[{id,projectName,daysToFulfill,created,resources}]} every 1 h, active realm
//  scmSimcoPhases:<realm>    {at, ranges:[{phase:'normal'|'boom'|'recession',start,end,days,weeks}]} newest first;
//                            1 h while the game's auth-data phase is not fresh (seen < 15 min), else 6 h; 10 min after the stored phase ended
//  scmSimcoEvents:<realm>    {at, events:[{id,resource,resourceName,speedModifier,since,until,producedAt,producedAtName}]}
//                            only while the game's production-modifiers capture is over 6 h old or older than Monday 00:00Z; every 3 h
//  scmSimcoCompany:<realm>   {at, companyId, notTracked?, rows:[{date,rank,evaRank,value,buildingsValue,patentsValue,workers,bondsSold}]}
//                            oldest first, daily history; once a day or when the company id changes (404 = notTracked, rows [])
//  scmSimcoGovHistory:<realm> {at, names:{[resourceId]:name}, orders:[{id,projectName,daysToFulfill,created,res:[[resourceId,quality]]}]}
//                            every order read by the gov-orders job (no extra request), newest 300 first, deduped by id, old ones kept
//  scmSimcoRanking:<realm>   {at, date, companyId, rank, partial?, total?, rows:[{companyId,companyName,rank,rankDiff,evaRank,companyValue,workers}]}
//                            own row + 5 above + 5 below, once a day; the page comes from the rank (company history / partial);
//                            no rank: own row only (partial) and the page next firing. pageMissAt / lookup: page did not hold the own row
//  scmSimcoContests:<realm>  {at, contests:[{id,name,resourceId,resourceName,buildingId,buildingName,start,end}]} once a day or when
//                            a stored contest ended after the read; ended over a day ago dropped. Reminders: runContestReminders
//  scmSimcoSummary:<realm>   {at, rows:[{date,activeCompanies,companiesValue,totalBuildings,bondsSold,phase}]} oldest first, 100 days, daily
//  scmSimcoBuildingStats:<realm> {at, total, rows:[[id,count,proportion]]}                    count of each building type in the realm, daily
//  scmSimcoCertKinds:<realm> {at, kinds:[{kind,relevant,resources:[resourceId]}]}           certificate kind catalogue, daily (100 kinds, 200 resources each)
//  scmSimcoCertHolders:<realm> {at, byKind:{[kind]:{at,total,rows:[[companyId,companyName,resourceKind,certInfo,date]]}}}
//                            page 1 (newest 100) of a kind that covers a product the user makes or holds; one kind per firing,
//                            each kind once a day, at most 6 kinds a day / stored. certInfo {amount,datetime}|null, date {w,m,y} raw numbers
//  scmSimcoExecLookup:<realm> {[nameLower|position]:{at,rows:[{id,name,age,position,employerId,employerName}]}}
//                            on-demand executive name search (SCM_SIMCO_EXEC_LOOKUP), 20 searches x 20 rows, reused for 24 h
//  scmSimcoBuildings       {at, byId:{[kind]:{costUnits,buildDuration /*s*/}}}            list once a day, then one building per slot
//  scmSimcoBuildingsMeta     {listAt, ids:[...], entryAt:{[id]:ms}, missing:{[id]:ms}}       progress of the buildings round
//  scmSimcoResources         {at, phase, byId}                                                once a day; never written into scmGameConstants
//  scmSimcoResourcesRetry    {until, fails}                                                   after a non-200: 1 h doubling to 24 h
// One alarm (scm-simco-public, every 5 min, 2.5 min after the live-market alarm so it never takes its slot) runs at most
// ONE job per firing, so at most one SimcoTools request (gov orders: one page, newest 100).
// Every request goes through simcoFetch (the SimcoTools channel: 2/s, burst 25, 429 cooldown, outage probes), one attempt.
// Nothing runs during a Sync, while the SimcoTools timer (liveMarket) is off, during a 429 cooldown or while SimcoTools is
// unreachable and no probe is due (the channel queue runs the job then).
const SIMCO_PUBLIC_ALARM='scm-simco-public';
const SIMCO_PUBLIC_PERIOD_MINUTES=5,SIMCO_PUBLIC_OFFSET_MS=150000,SIMCO_PUBLIC_DUE_SLACK_MS=30000;
const SIMCO_PRICES_MAX_AGE_MS=15*60000;
const SIMCO_GOV_ORDERS_MAX_AGE_MS=60*60000,SIMCO_GOV_ORDERS_CAPTURE_MAX_AGE_MS=24*3600000;
const SIMCO_BUILDINGS_LIST_MAX_AGE_MS=24*3600000,SIMCO_BUILDING_ENTRY_MAX_AGE_MS=24*3600000;
const SIMCO_RESOURCES_MAX_AGE_MS=24*3600000,SIMCO_RESOURCES_RETRY_MIN_MS=3600000,SIMCO_RESOURCES_RETRY_MAX_MS=24*3600000;
// Fallbacks for data the game's own pages give (passive capture first). Phases: the game's auth-data says the current
// phase; only SimcoTools has the end time and the history. Events: the game's production-modifiers response is the source.
const SIMCO_PHASE_PASSIVE_FRESH_MS=15*60000,SIMCO_PHASES_MAX_AGE_MS=3600000,SIMCO_PHASES_FRESH_PASSIVE_MAX_AGE_MS=6*3600000,SIMCO_PHASES_ENDED_MIN_AGE_MS=10*60000;
const SIMCO_EVENTS_PASSIVE_MAX_AGE_MS=6*3600000,SIMCO_EVENTS_MAX_AGE_MS=3*3600000;
const SIMCO_COMPANY_MAX_AGE_MS=24*3600000;
// Gov orders: the game's own list captured under 1 h ago = no SimcoTools read (passive capture first).
const SIMCO_GOV_ORDERS_PASSIVE_FRESH_MS=60*60000;
// Ranking, contests, realm summaries, building counts: once a day. A passive source (a game page that loads the same
// data) can set ctx.<job>PassiveAt later; while that is under a day old the job is not due.
const SIMCO_DAILY_MAX_AGE_MS=24*3600000,SIMCO_SUMMARY_DAYS=100;
const SIMCO_API='https://api.simcotools.com/v1';
let simcoPublicWriteTail=Promise.resolve(),simcoPublicRun=null;
const simcoPricesMemo=new Map();
// Every write of the keys above goes through this one tail (read-modify-write of the buildings merge included).
// A run that started before Clear data writes nothing (its answer would bring cleared data back).
let simcoPublicGen=null;
function simcoPublicWrite(fn,genArg){const gen=genArg!==undefined?genArg:simcoPublicGen;const run=simcoPublicWriteTail.then(()=>gen!=null&&gen!==extensionClearGeneration?null:fn());simcoPublicWriteTail=run.catch(()=>{});return run;}
const simcoPricesKey=r=>`scmSimcoPrices:${r}`,simcoGovOrdersKey=r=>`scmSimcoGovOrders:${r}`;
const simcoPhasesKey=r=>`scmSimcoPhases:${r}`,simcoEventsKey=r=>`scmSimcoEvents:${r}`,simcoCompanyKey=r=>`scmSimcoCompany:${r}`;
const simcoGovHistoryKey=r=>`scmSimcoGovHistory:${r}`,simcoRankingKey=r=>`scmSimcoRanking:${r}`,simcoContestsKey=r=>`scmSimcoContests:${r}`;
const simcoSummaryKey=r=>`scmSimcoSummary:${r}`,simcoBuildingStatsKey=r=>`scmSimcoBuildingStats:${r}`;
const simcoCertKindsKey=r=>`scmSimcoCertKinds:${r}`,simcoCertHoldersKey=r=>`scmSimcoCertHolders:${r}`,simcoExecLookupKey=r=>`scmSimcoExecLookup:${r}`;
async function simcoPublicGet(defaults){try{return await chrome.storage.local.get(defaults);}catch{return {...defaults};}}
function simcoAgeOk(at,maxAgeMs,now=Date.now()){const t=Number(at);return Number.isFinite(t)&&t>0&&now-t<maxAgeMs;}
// Stored SimcoTools prices of a realm ({at,rows}) or null. Only this file writes the key, so the memo is set on write.
async function simcoPricesFor(realm){
  const n=validRealmNumber(realm);if(n==null)return null;
  if(simcoPricesMemo.has(n))return simcoPricesMemo.get(n);
  const v=(await simcoPublicGet({[simcoPricesKey(n)]:null}))[simcoPricesKey(n)];
  const out=v&&typeof v==='object'&&Array.isArray(v.rows)?v:null;
  simcoPricesMemo.set(n,out);return out;
}
// GET /market/prices -> {prices:[{datetime,resourceId,quality,price}]}; stored as compact rows.
// Bounded storage: every stored SimcoTools answer is capped in rows and string length, and a body over 2 MB is
// never parsed (simcoPublicParse). Only the documented fields are kept.
const SIMCO_MAX_BODY_CHARS=2*1024*1024;
const SIMCO_CAP={prices:5000,govOrders:200,govOrderResources:20,buildingIds:500,resources:1000,inputs:50,retailInfo:20,text:80,iso:40,events:100,phaseRanges:30,companyRows:120,rankingRows:11,rankingScan:500,summaryRows:100,buildingStats:200,contests:20,govHistory:300,govHistoryNames:200,
  // certResources 200 (not 50): kind 41 (PRODUCER) lists ~140 resources; a cut list would hide most of the user's products.
  certKinds:100,certResources:200,certKindsPerDay:6,certHolderRows:100,execLookup:20,execRows:20,productIds:500};
const SIMCO_RETAIL_FIELDS=['quality','buildingLevelsNeededPerUnitPerHour','modeledProductionCostPerUnit','modeledStoreWages','modeledUnitsSoldAnHour','retailModelingQualityWeight','profitPerBuildingLevel','retailAdjustment','averagePrice','saturation','salesWages'];
// Control characters become spaces, then trimmed, then capped (every stored SimcoTools string goes through this).
const simcoText=(v,n=SIMCO_CAP.text)=>String(v??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,n);
const simcoNum=v=>{const n=Number(v);return Number.isFinite(n)?n:null;};
// {data} or {tooLarge:true} (no JSON.parse of a body over 2 MB).
function simcoPublicParse(text){const s=String(text??'');if(s.length>SIMCO_MAX_BODY_CHARS)return {tooLarge:true,length:s.length};return {data:parseSimcoResponse(s)};}
function simcoPricesRowsFromResponse(data){
  const list=Array.isArray(data?.prices)?data.prices:Array.isArray(data)?data:[];const rows=[];
  for(const x of list){if(rows.length>=SIMCO_CAP.prices)break;const id=Number(x?.resourceId),q=Number(x?.quality),p=Number(x?.price),t=Date.parse(String(x?.datetime||'').slice(0,SIMCO_CAP.iso));
    if(!Number.isInteger(id)||id<=0||!Number.isInteger(q)||q<0||!Number.isFinite(p)||p<=0)continue;
    rows.push([id,q,p,Number.isFinite(t)?t:0]);}
  return rows;
}
function simcoGovOrdersFromResponse(data){
  const list=Array.isArray(data?.orders)?data.orders:[];
  return list.filter(o=>o&&typeof o==='object'&&(typeof o.id==='number'||typeof o.id==='string')).slice(0,SIMCO_CAP.govOrders).map(o=>({id:typeof o.id==='number'?o.id:simcoText(o.id,SIMCO_CAP.iso),projectName:simcoText(o.projectName),daysToFulfill:Number(o.daysToFulfill),created:simcoText(o.created,SIMCO_CAP.iso),
    resources:(Array.isArray(o.resources)?o.resources:[]).slice(0,SIMCO_CAP.govOrderResources).map(r=>({resourceId:Number(r?.resourceId),quality:Number(r?.quality),resourceName:simcoText(r?.resourceName)})).filter(r=>Number.isInteger(r.resourceId)&&r.resourceId>0)}));
}
// Still open: created + daysToFulfill days is later than now.
function simcoCurrentGovOrders(orders,now=Date.now()){return (orders||[]).filter(o=>{const c=Date.parse(String(o?.created||'')),d=Number(o?.daysToFulfill);return Number.isFinite(c)&&Number.isFinite(d)&&c+d*86400000>now;});}
function simcoBuildingIdsFromResponse(data){
  const list=Array.isArray(data)?data:Array.isArray(data?.buildings)?data.buildings:Array.isArray(data?.results)?data.results:Array.isArray(data?.items)?data.items:[];
  return [...new Set(list.map(b=>String(b?.id??'').trim().slice(0,12)).filter(id=>/^\d+$/.test(id)))].slice(0,SIMCO_CAP.buildingIds);
}
// GET /buildings/<id> -> {building:{id,costUnits,buildDuration,name}} (buildDuration in seconds, as the game's constants).
function simcoBuildingEntryFromResponse(data){
  const b=data?.building&&typeof data.building==='object'?data.building:data;
  const kind=String(b?.id??'').trim(),costUnits=Number(b?.costUnits),buildDuration=Number(b?.buildDuration);
  if(!/^\d+$/.test(kind)||!Number.isFinite(costUnits)||costUnits<0||!Number.isFinite(buildDuration)||buildDuration<0)return null;
  return {kind,costUnits,buildDuration};
}
function simcoResourcesFromResponse(data){
  const raw=Array.isArray(data)?data:Array.isArray(data?.resources)?data.resources:data?.resources&&typeof data.resources==='object'?Object.values(data.resources):[];
  const byId={};let n=0;
  for(const x of raw){if(n>=SIMCO_CAP.resources)break;const id=x?.id??x?.resourceId??x?.kind;if(!x||typeof x!=='object'||id==null||!/^\d{1,9}$/.test(String(id)))continue;
    if(!byId[String(id)])n++;byId[String(id)]=simcoResourceEntry(x,Number(id));}
  const phase=data?.phase??data?.metadata?.phase??null;
  return {byId,phase:phase==null||typeof phase==='object'?null:simcoText(phase)};
}
// Whitelisted fields of one resource (documented SimcoTools fields only; numbers as numbers, strings capped).
function simcoResourceEntry(x,id){
  const out={id};
  if(x.name!=null)out.name=simcoText(x.name);
  if(typeof x.isResearch==='boolean')out.isResearch=x.isResearch;
  for(const k of ['transportation','producedAnHour','speedModifier','wages']){const v=simcoNum(x[k]);if(v!=null)out[k]=v;}
  if(Array.isArray(x.inputs))out.inputs=x.inputs.slice(0,SIMCO_CAP.inputs).filter(i=>i&&typeof i==='object').map(i=>{const o={};
    for(const k of ['id','resourceId','quantity']){const v=simcoNum(i[k]);if(v!=null)o[k]=v;}if(i.name!=null)o.name=simcoText(i.name);return o;});
  if(Array.isArray(x.retailInfo))out.retailInfo=x.retailInfo.slice(0,SIMCO_CAP.retailInfo).filter(r=>r&&typeof r==='object').map(r=>{const o={};
    for(const k of SIMCO_RETAIL_FIELDS){const v=simcoNum(r[k]);if(v!=null)o[k]=v;}return o;});
  return out;
}
// Next resources attempt after a failed one: 1 h, doubling, at most 24 h.
function simcoResourcesRetryNext(prev,now=Date.now()){const fails=Math.max(0,Number(prev?.fails)||0)+1;return {until:now+Math.min(SIMCO_RESOURCES_RETRY_MAX_MS,SIMCO_RESOURCES_RETRY_MIN_MS*2**(fails-1)),fails};}
// The building due next: never read or read over a day ago (404s included), oldest first.
function simcoNextBuildingId(meta,now=Date.now()){
  const at=meta?.entryAt&&typeof meta.entryAt==='object'?meta.entryAt:{};let best=null,bestAt=Infinity;
  for(const id of (Array.isArray(meta?.ids)?meta.ids:[])){const t=Number(at[id])||0;if(simcoAgeOk(t,SIMCO_BUILDING_ENTRY_MAX_AGE_MS,now))continue;if(t<bestAt){best=id;bestAt=t;}}
  return best;
}
// Absent / empty / boolean field = null (simcoNum alone reads null as 0).
const simcoNumOrNull=v=>v==null||v===''||typeof v==='boolean'?null:simcoNum(v);
const simcoIso=v=>{const s=simcoText(v,SIMCO_CAP.iso);return s&&Number.isFinite(Date.parse(s))?s:null;};
const SIMCO_PHASE_NAMES=['normal','boom','recession'];
// GET /phases -> {metadata, ranges:[{phase,start,end,days,weeks}]}; newest first (by start), unknown phase names dropped.
function simcoPhasesFromResponse(data){
  const list=Array.isArray(data?.ranges)?data.ranges:[];const out=[];
  for(const x of list){if(!x||typeof x!=='object')continue;const phase=simcoText(x.phase,20).trim().toLowerCase();
    if(!SIMCO_PHASE_NAMES.includes(phase))continue;const start=simcoIso(x.start);if(!start)continue;
    out.push({phase,start,end:simcoIso(x.end),days:simcoNumOrNull(x.days),weeks:simcoNumOrNull(x.weeks)});}
  return out.sort((a,b)=>Date.parse(b.start)-Date.parse(a.start)).slice(0,SIMCO_CAP.phaseRanges);
}
// GET /events -> {events:[{id,resource,resourceName,speedModifier,since,until,producedAt,producedAtName}]}; ended ones kept.
function simcoEventsFromResponse(data){
  const list=Array.isArray(data?.events)?data.events:[];const out=[];
  for(const x of list){if(out.length>=SIMCO_CAP.events)break;if(!x||typeof x!=='object')continue;
    const resource=simcoNumOrNull(x.resource);if(!Number.isInteger(resource)||resource<=0)continue;
    const pa=x.producedAt;const producedAt=typeof pa==='number'?simcoNum(pa):pa==null?null:simcoText(pa,SIMCO_CAP.iso);
    out.push({id:simcoNumOrNull(x.id),resource,resourceName:simcoText(x.resourceName),speedModifier:simcoNumOrNull(x.speedModifier),since:simcoIso(x.since),until:simcoIso(x.until),
      producedAt,producedAtName:x.producedAtName==null?null:simcoText(x.producedAtName)});}
  return out;
}
const SIMCO_COMPANY_FIELDS=['rank','evaRank','value','buildingsValue','patentsValue','workers','bondsSold'];
// GET /companies/<id>/history -> {history:[{date,...}]} (newest first, sort=-date); stored oldest first, the newest 120 days.
// null when the answer has no history list (garbage); [] when the list is empty.
function simcoCompanyRowsFromResponse(data){
  if(!Array.isArray(data?.history))return null;const rows=[];
  for(const x of data.history){if(!x||typeof x!=='object')continue;const date=simcoIso(x.date);if(!date)continue;
    const row={date};for(const k of SIMCO_COMPANY_FIELDS)row[k]=simcoNumOrNull(x[k]);rows.push(row);}
  rows.sort((a,b)=>Date.parse(b.date)-Date.parse(a.date));
  return rows.slice(0,SIMCO_CAP.companyRows).reverse();
}
// The list of an answer: the answer itself or its first array field of the given names; null = no list (garbage).
function simcoListOf(data,...names){if(Array.isArray(data))return data;if(!data||typeof data!=='object')return null;for(const n of names)if(Array.isArray(data[n]))return data[n];return null;}
const simcoUtcDay=ms=>new Date(ms).toISOString().slice(0,10);
// Ids that go into storage keys / notification ids: finite numbers, or short word strings.
const simcoSafeId=v=>typeof v==='number'?(Number.isSafeInteger(v)?v:null):typeof v==='string'&&/^[\w-]{1,40}$/.test(v)?v:null;
const simcoCount=v=>{const n=simcoNumOrNull(v);return n!=null&&n>=0?n:null;};
function simcoRankingRow(x){
  if(!x||typeof x!=='object')return null;const c=x.company&&typeof x.company==='object'?x.company:null;
  const companyId=simcoSafeCompanyId(x.companyId??c?.id??x.id);if(!companyId)return null;
  const rank=simcoNumOrNull(x.rank);
  return {companyId,companyName:simcoText(x.companyName??c?.name??x.name),rank:Number.isSafeInteger(rank)&&rank>0?rank:null,rankDiff:simcoNumOrNull(x.rankDiff),
    evaRank:simcoNumOrNull(x.evaRank),companyValue:simcoNumOrNull(x.companyValue??x.value),workers:simcoNumOrNull(x.workers)};
}
// GET /ranking -> {ranking|companies|results:[{companyId,companyName,rank,rankDiff,evaRank,companyValue,workers}], metadata}.
// {date, rows (own row + 5 above + 5 below, by rank), total, found} or null (no list). found=false: own row not in the answer.
function simcoRankingFromResponse(data,companyId){
  const list=simcoListOf(data,'ranking','companies','results','items','rows');if(!list)return null;
  const cid=simcoSafeCompanyId(companyId),all=[],seen=new Set();
  for(const x of list.slice(0,SIMCO_CAP.rankingScan)){const r=simcoRankingRow(x);if(r&&!seen.has(r.companyId)){seen.add(r.companyId);all.push(r);}}
  all.sort((a,b)=>(a.rank??Infinity)-(b.rank??Infinity));
  const i=cid?all.findIndex(r=>r.companyId===cid):-1,span=Math.floor((SIMCO_CAP.rankingRows-1)/2);
  const rows=i<0?[]:all.slice(Math.max(0,i-span),i+span+1);
  const m=data&&typeof data==='object'&&!Array.isArray(data)?data:{};
  const t=simcoNumOrNull(m.metadata?.totalRecords??m.metadata?.totalCount??m.metadata?.total??m.metadata?.count??m.total??m.count);
  const d=simcoIso(m.date??m.metadata?.date??list[0]?.date);
  return {date:d?d.slice(0,10):null,rows,total:Number.isSafeInteger(t)&&t>=0?t:null,found:i>=0};
}
// The game's own ranking page (GET /api/v4/encyclopedia/ranking/<realm>/<page>/, 400 rows a page, page = floor(rank/400)):
// a plain list of {id, company, realmId, logo, rank (0-based: shown as rank+1), year, value}. Rows in the scmSimcoRanking row
// shape (rank 1-based); fields the game does not give are null. eva=true for /eva-ranking/ (value = EVA, rank = EVA rank).
function gameRankingRows(data,opts={}){
  const list=Array.isArray(data)?data:simcoListOf(data,'ranking','companies','results');if(!list)return [];const out=[],seen=new Set();
  for(const x of list.slice(0,SIMCO_CAP.rankingScan)){if(!x||typeof x!=='object')continue;const companyId=simcoSafeCompanyId(x.id??x.companyId);if(!companyId||seen.has(companyId))continue;
    const r0=simcoNumOrNull(x.rank),rank=Number.isSafeInteger(r0)&&r0>=0?r0+1:null;seen.add(companyId);
    out.push({companyId,companyName:simcoText(typeof x.company==='string'?x.company:x.companyName),rank:opts.eva?null:rank,rankDiff:null,
      evaRank:opts.eva?rank:null,companyValue:opts.eva?null:simcoNumOrNull(x.value),workers:null});}
  return out;
}
// Newest captured game ranking page of the realm (status 2xx) that holds the company: its time, else 0. Storage only.
// Cheap (runs every 5-min firing): only keys under the realm's ranking prefix are looked at, newest first, and the scan stops
// at the first page that holds the company (no normalising of the rows).
function simcoGameRankingPassiveAt(store,realm,companyId){
  const r=validRealmNumber(realm),cid=simcoSafeCompanyId(companyId);if(r==null||!cid)return 0;
  const ed=store?.endpointData&&typeof store.endpointData==='object'?store.endpointData:{},pre=`/api/v4/encyclopedia/ranking/${r}/`,cands=[];
  for(const u of Object.keys(ed)){if(!u.startsWith(pre)||!/^\d+\/?(\?.*)?$/.test(u.slice(pre.length)))continue;const v=ed[u];
    const s=Number(v?.status||200);if(!(s>=200&&s<300))continue;const at=Date.parse(String(v?.receivedAt||''))||0;if(at>0)cands.push([at,v]);}
  cands.sort((a,b)=>b[0]-a[0]);
  for(const [at,v] of cands){const d=v?.data,list=Array.isArray(d)?d:simcoListOf(d,'ranking','companies','results');
    if(list&&list.slice(0,SIMCO_CAP.rankingScan).some(x=>x&&typeof x==='object'&&simcoSafeCompanyId(x.id??x.companyId)===cid))return at;}
  return 0;
}
const SIMCO_SUMMARY_FIELDS=['activeCompanies','companiesValue','totalBuildings','bondsSold'];
// GET /summaries -> {summaries:[{date,activeCompanies,companiesValue,totalBuildings,bondsSold,phase}]}; oldest first, one per date,
// the newest 100. null = no list.
function simcoSummariesFromResponse(data){
  const list=simcoListOf(data,'summaries','results','items','rows');if(!list)return null;const byDate=new Map();
  for(const x of list.slice(0,SIMCO_CAP.rankingScan)){if(!x||typeof x!=='object')continue;const date=simcoIso(x.date);if(!date)continue;
    const row={date};for(const k of SIMCO_SUMMARY_FIELDS)row[k]=simcoNumOrNull(x[k]);
    const ph=x.phase;row.phase=typeof ph==='number'?simcoNum(ph):typeof ph==='string'?simcoText(ph,20):null;byDate.set(date,row);}
  return [...byDate.values()].sort((a,b)=>Date.parse(a.date)-Date.parse(b.date)).slice(-SIMCO_CAP.summaryRows);
}
// GET /stats/buildings -> {buildings:[{id,name,count,proportion}], totalBuildings}; names are not kept (the game's buildings have them).
function simcoBuildingStatsFromResponse(data){
  const list=simcoListOf(data,'buildings','stats','results','items');if(!list)return null;const rows=[],seen=new Set();
  for(const x of list){if(rows.length>=SIMCO_CAP.buildingStats)break;if(!x||typeof x!=='object')continue;
    const id=String(x.id??x.kind??'').trim();if(!/^[0-9A-Za-z]{1,12}$/.test(id)||seen.has(id))continue;
    const count=simcoCount(x.count);if(count==null)continue;seen.add(id);rows.push([id,count,simcoCount(x.proportion)]);}
  const m=data&&typeof data==='object'&&!Array.isArray(data)?data:{};
  return {total:simcoCount(m.totalBuildings??m.total??m.metadata?.totalBuildings),rows};
}
// GET /contests -> {contests:[{id,name,resource{id,name}|resourceId,resourceName,building{id,name}|buildingId,buildingName,start,end}]};
// only contests that end after now - 1 day, at most 20. null = no list.
function simcoContestsFromResponse(data,now=Date.now()){
  const list=simcoListOf(data,'contests','results','items');if(!list)return null;const out=[],seen=new Set();
  for(const x of list.slice(0,SIMCO_CAP.rankingScan)){if(out.length>=SIMCO_CAP.contests)break;if(!x||typeof x!=='object')continue;
    const id=simcoSafeId(x.id);if(id==null||seen.has(String(id)))continue;
    const start=simcoIso(x.start??x.startDate??x.start_date),end=simcoIso(x.end??x.endDate??x.end_date);if(!start||!end)continue;
    if(!(Date.parse(end)>now-86400000))continue;
    const res=x.resource&&typeof x.resource==='object'?x.resource:null,b=x.building&&typeof x.building==='object'?x.building:null;
    const rid=simcoNumOrNull(x.resourceId??res?.id??(typeof x.resource==='number'?x.resource:null));
    const bid=x.buildingId??b?.id??(typeof x.building==='string'||typeof x.building==='number'?x.building:null);
    seen.add(String(id));
    out.push({id,name:simcoText(x.name),resourceId:Number.isSafeInteger(rid)&&rid>0?rid:null,resourceName:simcoText(x.resourceName??res?.name),
      buildingId:bid==null||!/^[0-9A-Za-z]{1,12}$/.test(String(bid))?null:String(bid),buildingName:simcoText(x.buildingName??b?.name),start,end});}
  return out;
}
// One gov-history order from a parsed SimcoTools order ({resources:[{resourceId,quality}]}) or a stored one ({res:[[id,q]]}).
function simcoGovHistoryOrder(o){
  if(!o||typeof o!=='object')return null;const id=simcoSafeId(o.id);if(id==null)return null;
  const src=Array.isArray(o.res)?o.res.map(r=>Array.isArray(r)?{resourceId:r[0],quality:r[1]}:null):Array.isArray(o.resources)?o.resources:[];
  const res=[];for(const r of src.slice(0,SIMCO_CAP.govOrderResources)){const rid=Number(r?.resourceId),q=simcoNumOrNull(r?.quality);
    if(Number.isSafeInteger(rid)&&rid>0)res.push([rid,Number.isInteger(q)&&q>=0?q:null]);}
  const d=simcoNumOrNull(o.daysToFulfill);
  return {id,projectName:simcoText(o.projectName),daysToFulfill:d,created:simcoText(o.created,SIMCO_CAP.iso),res};
}
// Stored history + every order just read: deduped by id (the new copy wins), newest 300 by created, older stored ones kept.
// names: resource names of the kept orders (new names first), at most 200.
function simcoGovHistoryMerge(prev,allOrders){
  const byId=new Map();
  for(const o of Array.isArray(prev?.orders)?prev.orders:[]){const n=simcoGovHistoryOrder(o);if(n&&!byId.has(String(n.id)))byId.set(String(n.id),n);}
  for(const o of Array.isArray(allOrders)?allOrders:[]){const n=simcoGovHistoryOrder(o);if(n)byId.set(String(n.id),n);}
  const orders=[...byId.values()].sort((a,b)=>(Date.parse(b.created)||0)-(Date.parse(a.created)||0)).slice(0,SIMCO_CAP.govHistory);
  const used=new Set();for(const o of orders)for(const r of o.res)used.add(String(r[0]));
  const names={};let n=0;const add=(id,name)=>{const k=String(id),s=simcoText(name).trim();if(n>=SIMCO_CAP.govHistoryNames||!s||!used.has(k)||names[k]!=null)return;names[k]=s;n++;};
  for(const o of Array.isArray(allOrders)?allOrders:[])for(const r of Array.isArray(o?.resources)?o.resources:[])add(r?.resourceId,r?.resourceName);
  const pn=prev?.names&&typeof prev.names==='object'?prev.names:{};for(const k of Object.keys(pn))add(k,pn[k]);
  return {names,orders};
}
// Most recent Monday 00:00 UTC at or before now (the game's production events start the week).
function simcoLastMondayUtc(now=Date.now()){const d=new Date(now);return Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()-((d.getUTCDay()+6)%7));}
// When the game's own pages last gave the data (storage only): the realm's production-modifiers capture (status 200) and the
// newest auth-data economy phase (the economy log's last 'l', or the auth-data capture with temporals.economyState).
function simcoPublicPassive(store,realm,economyLog){
  let eventsPassiveAt=0,phasePassiveAt=0;const r=validRealmNumber(realm);
  for(const [u,v] of Object.entries(store?.endpointData&&typeof store.endpointData==='object'?store.endpointData:{})){
    const at=Date.parse(String(v?.receivedAt||''))||0;
    const m=String(u||'').match(/\/api\/v2\/production-modifiers\/(\d+)\/?(\?.*)?$/i);
    if(m){if(Number(v?.status)===200&&(r==null||Number(m[1])===r)&&at>eventsPassiveAt)eventsPassiveAt=at;continue;}
    if(!/\/api\/v3\/companies\/auth-data\/?(\?.*)?$/i.test(String(u||'')))continue;
    if(!(Number(v?.status)>=200&&Number(v?.status)<300)||!Number.isFinite(Number(v?.data?.temporals?.economyState))||v?.data?.temporals?.economyState==null)continue;
    const ac=v.data?.authCompany;const ar=validRealmNumber(ac?.realmId??ac?.realm);if(ar!=null&&r!=null&&ar!==r)continue;
    if(at>phasePassiveAt)phasePassiveAt=at;
  }
  const last=Array.isArray(economyLog)&&economyLog.length?economyLog[economyLog.length-1]:null;
  const l=Date.parse(String(last?.l||last?.f||''))||0;if(l>phasePassiveAt)phasePassiveAt=l;
  return {eventsPassiveAt,phasePassiveAt};
}
function simcoPhasesDue(g,realm,ctx,now){
  const cur=g?.[simcoPhasesKey(realm)],at=Number(cur?.at)||0,slack=SIMCO_PUBLIC_DUE_SLACK_MS;
  // The stored current phase has ended and the copy was read before that end: read again after 10 min (once; after that the
  // normal ages apply, so a SimcoTools copy that is slow to show the next phase is not asked every 10 min).
  const end=Date.parse(String(cur?.ranges?.[0]?.end||''));
  if(at>0&&Number.isFinite(end)&&end<=now&&at<end&&now-at>=SIMCO_PHASES_ENDED_MIN_AGE_MS)return true;
  const p=Number(ctx?.phasePassiveAt)||0,passiveFresh=p>0&&now-p<SIMCO_PHASE_PASSIVE_FRESH_MS;
  return !simcoAgeOk(at,(passiveFresh?SIMCO_PHASES_FRESH_PASSIVE_MAX_AGE_MS:SIMCO_PHASES_MAX_AGE_MS)-slack,now);
}
function simcoEventsDue(g,realm,ctx,now){
  const p=Number(ctx?.eventsPassiveAt)||0;
  const passiveStale=!(p>0)||now-p>=SIMCO_EVENTS_PASSIVE_MAX_AGE_MS||p<simcoLastMondayUtc(now);
  return passiveStale&&!simcoAgeOk(g?.[simcoEventsKey(realm)]?.at,SIMCO_EVENTS_MAX_AGE_MS-SIMCO_PUBLIC_DUE_SLACK_MS,now);
}
const simcoSafeCompanyId=v=>{const n=Number(v);return Number.isSafeInteger(n)&&n>0?n:0;};
// 'due', 'no-id' (due but no company id known: no request) or null.
function simcoCompanyDue(g,realm,ctx,now){
  const cur=g?.[simcoCompanyKey(realm)],cid=simcoSafeCompanyId(ctx?.companyId);
  if(cur&&cid&&Number(cur.companyId)===cid&&simcoAgeOk(cur.at,SIMCO_COMPANY_MAX_AGE_MS-SIMCO_PUBLIC_DUE_SLACK_MS,now))return null;
  if(!cid)return cur&&simcoAgeOk(cur.at,SIMCO_COMPANY_MAX_AGE_MS-SIMCO_PUBLIC_DUE_SLACK_MS,now)?null:'no-id';
  return 'due';
}
// The game's own gov-orders list of the realm (status 2xx, data present): when it was captured (storage only).
function simcoGovPassiveAt(store,realm){
  const r=validRealmNumber(realm);if(r==null)return 0;const e=store?.endpointData?.[`/api/v3/government-orders/${r}/`];
  const s=Number(e?.status||200);if(!e||e.data==null||!(s>=200&&s<300))return 0;return Date.parse(String(e.receivedAt||''))||0;
}
const simcoPassiveFresh=(at,maxAgeMs,now)=>{const p=Number(at)||0;return p>0&&p<=now+60000&&now-p<maxAgeMs;};
function simcoGovOrdersDue(g,realm,ctx,now){
  if(ctx&&simcoPassiveFresh(ctx.govPassiveAt,SIMCO_GOV_ORDERS_PASSIVE_FRESH_MS,now))return false;
  return !simcoAgeOk(g?.[simcoGovOrdersKey(realm)]?.at,SIMCO_GOV_ORDERS_MAX_AGE_MS-SIMCO_PUBLIC_DUE_SLACK_MS,now);
}
const simcoDailyStale=(v,now)=>!simcoAgeOk(v?.at,SIMCO_DAILY_MAX_AGE_MS-SIMCO_PUBLIC_DUE_SLACK_MS,now);
// Rank from the newest company-history row of the same company, or null.
function simcoHistoryRank(g,realm,cid){
  const h=g?.[simcoCompanyKey(realm)];if(!h||Number(h.companyId)!==cid||!Array.isArray(h.rows)||!h.rows.length)return null;
  const r=Number(h.rows[h.rows.length-1]?.rank);return Number.isSafeInteger(r)&&r>0?r:null;
}
// null (not due) or {mode:'page',rank} (the 100-row page holding the rank) or {mode:'own'} (own row only, partial).
function simcoRankingDue(g,realm,ctx,now){
  const cid=simcoSafeCompanyId(ctx?.companyId);if(!cid)return null;
  if(simcoPassiveFresh(ctx?.rankingPassiveAt,SIMCO_DAILY_MAX_AGE_MS,now))return null;
  const cur=g?.[simcoRankingKey(realm)],same=Boolean(cur&&typeof cur==='object'&&Number(cur.companyId)===cid);
  const fresh=same&&!simcoDailyStale(cur,now);
  if(fresh&&!cur.partial)return null;
  // A partial copy after the page did not hold the own row: no more tries until the copy is a day old.
  if(fresh&&cur.partial&&Number(cur.pageMissAt)>0)return null;
  if(same&&cur.lookup)return {mode:'own'};
  const pr=fresh&&cur.partial?Number(cur.rank):NaN;
  const rank=Number.isSafeInteger(pr)&&pr>0?pr:simcoHistoryRank(g,realm,cid);
  return rank?{mode:'page',rank}:{mode:'own'};
}
function simcoContestsDue(g,realm,ctx,now){
  if(simcoPassiveFresh(ctx?.contestsPassiveAt,SIMCO_DAILY_MAX_AGE_MS,now))return false;
  const cur=g?.[simcoContestsKey(realm)];if(simcoDailyStale(cur,now))return true;
  // A stored contest ended after the copy was read: read again (once; the new copy is newer than that end).
  const at=Number(cur.at);return (Array.isArray(cur.contests)?cur.contests:[]).some(c=>{const e=Date.parse(String(c?.end||''));return Number.isFinite(e)&&e>at&&e<=now;});
}
function simcoSummariesDue(g,realm,ctx,now){return !simcoPassiveFresh(ctx?.summariesPassiveAt,SIMCO_DAILY_MAX_AGE_MS,now)&&simcoDailyStale(g?.[simcoSummaryKey(realm)],now);}
function simcoBuildingStatsDue(g,realm,ctx,now){return !simcoPassiveFresh(ctx?.buildingStatsPassiveAt,SIMCO_DAILY_MAX_AGE_MS,now)&&simcoDailyStale(g?.[simcoBuildingStatsKey(realm)],now);}
// --- Certificates (build 3b) ---
const simcoSmallInt=(v,max)=>{const n=simcoNumOrNull(v);return Number.isSafeInteger(n)&&n>=0&&n<=max?n:null;};
// GET /certificates -> {certificates_kinds:[{kind, relevant, resources?:[resourceId]}], realm} (page_size is ignored; a
// catalogue). One entry per kind (first wins), 100 kinds, 200 resources each. null = no list (garbage).
function simcoCertKindsFromResponse(data){
  const list=simcoListOf(data,'certificates_kinds','certificatesKinds','kinds','results');if(!list)return null;const out=[],seen=new Set();
  for(const x of list.slice(0,SIMCO_CAP.rankingScan)){if(out.length>=SIMCO_CAP.certKinds)break;if(!x||typeof x!=='object')continue;
    const kind=simcoSmallInt(x.kind,9999);if(kind==null||seen.has(kind))continue;seen.add(kind);
    const res=[...new Set((Array.isArray(x.resources)?x.resources:[]).slice(0,SIMCO_CAP.rankingScan).map(Number).filter(n=>Number.isSafeInteger(n)&&n>0&&n<1e6))].slice(0,SIMCO_CAP.certResources);
    out.push({kind,relevant:x.relevant===true,resources:res});}
  return out;
}
// certInfo as given ({amount, datetime}) compacted; a string is cut to 80 chars; anything else null.
function simcoCertInfo(v){
  if(typeof v==='string'){const s=simcoText(v);return s||null;}
  if(!v||typeof v!=='object'||Array.isArray(v))return null;
  const o={amount:simcoNumOrNull(v.amount),datetime:simcoIso(v.datetime)};return o.amount==null&&o.datetime==null?null:o;
}
// The certificate date as the raw numbers given ({week?, month, year}); never turned into a calendar date. null = none.
function simcoCertDate(v){
  if(!v||typeof v!=='object'||Array.isArray(v))return null;
  const o={w:simcoSmallInt(v.week??v.w,60),m:simcoSmallInt(v.month??v.m,13),y:simcoSmallInt(v.year??v.y,9999)};
  return o.w==null&&o.m==null&&o.y==null?null:o;
}
// GET /certificates/<kind> -> {certificates:[{id,companyId,companyName,certInfo,date,resourceKind}], metadata:{totalRecords}}.
// {total, rows:[[companyId,companyName,resourceKind,certInfo,date]]} (100 rows) or null (no list).
function simcoCertHoldersFromResponse(data){
  const list=simcoListOf(data,'certificates','results','items','rows');if(!list)return null;const rows=[];
  for(const x of list.slice(0,SIMCO_CAP.rankingScan)){if(rows.length>=SIMCO_CAP.certHolderRows)break;if(!x||typeof x!=='object')continue;
    const cid=simcoSafeCompanyId(x.companyId??x.company?.id);if(!cid)continue;const rk=simcoSmallInt(x.resourceKind??x.resource,1e6);
    rows.push([cid,simcoText(x.companyName??x.company?.name),rk,simcoCertInfo(x.certInfo),simcoCertDate(x.date)]);}
  const m=data&&typeof data==='object'&&!Array.isArray(data)?data:{};
  const t=simcoNumOrNull(m.metadata?.totalRecords??m.metadata?.total??m.total);
  return {total:Number.isSafeInteger(t)&&t>=0?t:rows.length,rows};
}
// Resource ids the user makes or holds (storage only): warehouse rows with stock, production plans, running buildings.
function simcoProductIds(store){
  const ids=new Set(),add=v=>{if(ids.size>=SIMCO_CAP.productIds)return;const n=Number(v&&typeof v==='object'?(v.kind??v.resourceId??v.id):v);if(Number.isSafeInteger(n)&&n>0&&n<1e6)ids.add(n);};
  for(const row of Array.isArray(store?.warehouseResources)?store.warehouseResources:[]){if(!row||typeof row!=='object')continue;const q=Number(row.amount??row.quantity);if(Number.isFinite(q)&&q<=0)continue;add(row.kind??row.resourceId??row.id);}
  for(const p of Object.values(store?.productionPlans&&typeof store.productionPlans==='object'?store.productionPlans:{}))add(p?.productId??p?.resourceId);
  for(const b of Array.isArray(store?.buildings)?store.buildings:[])add(b?.busy?.resource?.kind??b?.busy?.resource?.resourceId);
  return [...ids];
}
// Kinds whose resource list holds one of the products: relevant kinds first, then catalogue order; at most 6.
function simcoCertKindsForProducts(kinds,productIds){
  const want=new Set((Array.isArray(productIds)?productIds:[...(productIds||[])]).map(Number));if(!want.size)return [];
  const hit=(Array.isArray(kinds)?kinds:[]).filter(k=>k&&Array.isArray(k.resources)&&k.resources.some(r=>want.has(Number(r))));
  return [...hit.filter(k=>k.relevant===true),...hit.filter(k=>k.relevant!==true)].map(k=>k.kind).slice(0,SIMCO_CAP.certKindsPerDay);
}
function simcoCertKindsDue(g,realm,ctx,now){return !simcoPassiveFresh(ctx?.certKindsPassiveAt,SIMCO_DAILY_MAX_AGE_MS,now)&&simcoDailyStale(g?.[simcoCertKindsKey(realm)],now);}
// The kind to read this firing, or null: a kind of the user's products whose copy is a day old, while fewer than 6 kinds were
// read in the last 24 h. ctx.certHoldersPassiveAt: hook for a game page that gives the same data (none known yet).
function simcoCertHoldersDue(g,realm,ctx,now){
  if(!Array.isArray(ctx?.productIds)||!ctx.productIds.length)return null;
  if(simcoPassiveFresh(ctx?.certHoldersPassiveAt,SIMCO_DAILY_MAX_AGE_MS,now))return null;
  const cat=g?.[simcoCertKindsKey(realm)];const want=simcoCertKindsForProducts(cat?.kinds,ctx.productIds);if(!want.length)return null;
  const by=g?.[simcoCertHoldersKey(realm)]?.byKind;const byKind=by&&typeof by==='object'?by:{};
  const readToday=Object.values(byKind).filter(v=>simcoAgeOk(v?.at,SIMCO_DAILY_MAX_AGE_MS,now)).length;
  if(readToday>=SIMCO_CAP.certKindsPerDay)return null;
  const k=want.find(kind=>simcoDailyStale(byKind[kind],now));return k==null?null:k;
}
// The user's own certificates from the game's own page (GET /api/v2/companies/<id>/certificates/ -> {certificates:[{kind,
// resourceKind,amount,level,date,yearStarted}]}), captured by the page hook. Storage only. {at, items:[{kind,resourceKind}]}
// from the newest 2xx capture of that company (any company id when companyId is 0), or null when not captured.
function ownCertificatesFromCapture(endpointData,companyId){
  const ed=endpointData&&typeof endpointData==='object'?endpointData:{},cid=simcoSafeCompanyId(companyId);let best=null,bestAt=-1;
  for(const [u,v] of Object.entries(ed)){const m=/\/api\/v2\/companies\/(\d+)\/certificates\/?(\?.*)?$/i.exec(String(u||''));if(!m)continue;
    if(cid&&Number(m[1])!==cid)continue;const s=Number(v?.status||200);if(!(s>=200&&s<300)||v?.data==null)continue;
    const at=Date.parse(String(v?.receivedAt||''))||0;if(at>bestAt){bestAt=at;best=v;}}
  if(!best)return null;const list=simcoListOf(best.data,'certificates','results');if(!list)return null;const items=[],seen=new Set();
  for(const x of list.slice(0,SIMCO_CAP.rankingScan)){if(!x||typeof x!=='object')continue;const kind=simcoSmallInt(x.kind,9999);if(kind==null)continue;
    const resourceKind=simcoSmallInt(x.resourceKind??x.resource,1e6);const key=`${kind}:${resourceKind}`;if(seen.has(key))continue;seen.add(key);items.push({kind,resourceKind});}
  return {at:bestAt>0?bestAt:0,items};
}
// --- Executives name lookup (build 3b, on demand) ---
const SIMCO_EXEC_POSITIONS=new Set(['coo','cfo','cmo','cto','staff']);
const SIMCO_EXEC_LOOKUP_MAX_AGE_MS=24*3600000;
// GET /executives?name= -> {executives:[{id,name,age,position,currentEmployer:{id,name}|null}], metadata}. 20 rows or null.
function simcoExecutivesFromResponse(data){
  const list=simcoListOf(data,'executives','results','items','rows');if(!list)return null;const out=[],seen=new Set();
  for(const x of list.slice(0,SIMCO_CAP.rankingScan)){if(out.length>=SIMCO_CAP.execRows)break;if(!x||typeof x!=='object')continue;
    const id=simcoSafeCompanyId(x.id);if(!id||seen.has(id))continue;seen.add(id);
    const e=x.currentEmployer&&typeof x.currentEmployer==='object'?x.currentEmployer:null,age=simcoSmallInt(x.age,200);
    const pos=typeof x.position==='string'?x.position.trim().toLowerCase():'';
    out.push({id,name:simcoText(x.name),age,position:/^[a-z]{1,12}$/.test(pos)?pos:null,employerId:simcoSafeCompanyId(e?.id)||null,employerName:e?simcoText(e.name)||null:null});}
  return out;
}
// {name, position, key} of a valid search, or {error}. name: a string, trimmed 2-40 chars, no control characters.
function simcoExecLookupQuery(m){
  if(typeof m?.name!=='string')return {error:'Type a name (2-40 letters).'};
  const name=m.name.trim();if(name.length<2||name.length>40||/[\u0000-\u001f\u007f]/.test(name))return {error:'Type a name (2-40 letters).'};
  const p=m.position==null||m.position===''?'':typeof m.position==='string'?m.position.trim().toLowerCase():null;
  if(p==null||(p&&!SIMCO_EXEC_POSITIONS.has(p)))return {error:'Unknown position.'};
  return {name,position:p||null,key:`${name.toLowerCase()}|${p}`};
}
// Cache with the entry put in; the 20 newest searches kept.
function simcoExecLookupCachePut(cache,key,entry){
  const c=cache&&typeof cache==='object'&&!Array.isArray(cache)?{...cache}:{};delete c[key];
  const keep=Object.entries(c).filter(([,v])=>v&&typeof v==='object').sort((a,b)=>(Number(b[1].at)||0)-(Number(a[1].at)||0)).slice(0,SIMCO_CAP.execLookup-1);
  return Object.fromEntries([...keep,[key,entry]]);
}
// The one job this firing runs, or null. Priority: prices, gov orders, phases, events, buildings list, resources,
// company history, ranking, contests, realm summaries, building counts, certificate kinds, certificate holders (one kind of the
// user's products, ctx.productIds), one building. ctx = {companyId, productIds, eventsPassiveAt,
// phasePassiveAt, govPassiveAt} (runSimcoPublicData builds it from the realm store); a call without ctx (older callers) never
// picks the phases / events / company / ranking / contests / summaries / building-stats jobs. Gov orders with ctx: not read
// while the game's own list is under 1 h old.
// A job whose last try failed or was not read waits out its back-off (g.scmSimcoJobBackoff, simcoJobBackedOff), so the
// jobs after it get their turn instead of the same job being picked at every firing (2.5.464: prices failing every
// firing kept ranking / certificate kinds from ever running).
function simcoPublicPickJob(g,realm,now=Date.now(),ctx=null){
  const slack=SIMCO_PUBLIC_DUE_SLACK_MS,withCtx=realm!=null&&ctx!=null&&typeof ctx==='object'&&!ctx.__none;
  // ctx.__rotate (set by simcoPublicPickFair): also skip a due job tried in the last firing (scmSimcoJobTried), and the
  // jobs already found (__exclude) while collecting every due job.
  const rot=ctx&&typeof ctx==='object'?ctx.__rotate:null,excl=ctx&&typeof ctx==='object'?ctx.__exclude:null;
  const ok=j=>!simcoJobBackedOff(g?.scmSimcoJobBackoff,realm,j,now)&&!(rot&&simcoJobTriedRecently(g?.scmSimcoJobTried,realm,j,now))&&!(excl&&excl.has(j));
  if(realm!=null&&ok('prices')&&!simcoAgeOk(g?.[simcoPricesKey(realm)]?.at,SIMCO_PRICES_MAX_AGE_MS-slack,now))return {job:'prices'};
  if(realm!=null&&ok('gov-orders')&&simcoGovOrdersDue(g,realm,withCtx?ctx:null,now))return {job:'gov-orders'};
  if(withCtx&&ok('phases')&&simcoPhasesDue(g,realm,ctx,now))return {job:'phases'};
  if(withCtx&&ok('events')&&simcoEventsDue(g,realm,ctx,now))return {job:'events'};
  const meta=g?.scmSimcoBuildingsMeta||{};
  if(ok('buildings-list')&&!simcoAgeOk(meta.listAt,SIMCO_BUILDINGS_LIST_MAX_AGE_MS-slack,now))return {job:'buildings-list'};
  if(realm!=null&&ok('resources')&&!(Number(g?.scmSimcoResourcesRetry?.until)>now)&&!simcoAgeOk(g?.scmSimcoResources?.at,SIMCO_RESOURCES_MAX_AGE_MS-slack,now))return {job:'resources'};
  // No company id yet: not picked (the lower jobs go on); runSimcoPublicData logs a 'not-read' line for it.
  if(withCtx&&ok('company')&&simcoCompanyDue(g,realm,ctx,now)==='due')return {job:'company',companyId:simcoSafeCompanyId(ctx.companyId)};
  if(withCtx&&ok('ranking')){const rk=simcoRankingDue(g,realm,ctx,now);if(rk)return {job:'ranking',companyId:simcoSafeCompanyId(ctx.companyId),...rk};}
  if(withCtx&&ok('contests')&&simcoContestsDue(g,realm,ctx,now))return {job:'contests'};
  if(withCtx&&ok('summaries')&&simcoSummariesDue(g,realm,ctx,now))return {job:'summaries'};
  if(withCtx&&ok('building-stats')&&simcoBuildingStatsDue(g,realm,ctx,now))return {job:'building-stats'};
  if(withCtx&&ok('cert-kinds')&&simcoCertKindsDue(g,realm,ctx,now))return {job:'cert-kinds'};
  if(withCtx&&ok('cert-holders')){const kind=simcoCertHoldersDue(g,realm,ctx,now);if(kind!=null)return {job:'cert-holders',kind};}
  if(!ok('building'))return null;
  const id=simcoNextBuildingId(meta,now);
  return id?{job:'building',id}:null;
}
// Rotation (2.5.464): a job whose try gave no data (offline, timeout, failure, not-read) is marked
// scmSimcoJobTried["<realm>|<job>"]=time (kept up to a day); a due job with no mark goes first, and when every due job
// is marked the one tried longest ago goes, so with no connection the due jobs take turns (round robin) instead of
// prices at every firing. A success clears the mark; a 429 or a channel refusal sets none.
function simcoJobTriedRecently(map,realm,job,now=Date.now()){const t=Number(map&&typeof map==='object'?map[simcoJobBackoffKey(realm,job)]:0)||0;return t>0&&now-t<86400000;}
function simcoPublicPickFair(g,realm,now=Date.now(),ctx=null){
  const base=ctx&&typeof ctx==='object'?ctx:null;
  const first=simcoPublicPickJob(g,realm,now,base?{...base,__rotate:true}:{__rotate:true,__none:true});
  if(first)return first;
  // Every due job was tried in the last firing (or none is due): the due job tried longest ago.
  const exclude=new Set(),due=[];
  for(let i=0;i<20;i++){const d=simcoPublicPickJob(g,realm,now,base?{...base,__exclude:exclude}:{__exclude:exclude,__none:true});if(!d)break;due.push(d);exclude.add(d.job);}
  if(!due.length)return null;
  const tried=j=>Number(g?.scmSimcoJobTried?.[simcoJobBackoffKey(realm,j)])||0;
  return due.reduce((a,b)=>tried(b.job)<tried(a.job)?b:a);
}
function simcoJobTriedNext(map,realm,job,result,now=Date.now()){
  const m=map&&typeof map==='object'&&!Array.isArray(map)?{...map}:{},k=simcoJobBackoffKey(realm,job);
  for(const [kk,v] of Object.entries(m))if(!(Number(v)>now-86400000))delete m[kk];
  if(result?.ok){if(!(k in m))return null;delete m[k];return m;}
  if(result?.gateWait||String(result?.outcome||'')==='rate-limited')return null;
  m[k]=now;return m;
}
// scmSimcoJobBackoff {"<realm>|<job>": {until, fails}} (storage.local, cleared with the data): after a failed or
// not-read try a job waits 30 min, doubling per further miss up to 4 h; a success removes it. A 429, the shared
// gate and "no network" are not the job's fault and set no back-off (the global cooldowns cover them).
const SIMCO_JOB_BACKOFF_KEY='scmSimcoJobBackoff',SIMCO_JOB_BACKOFF_MS=30*60000,SIMCO_JOB_BACKOFF_MAX_MS=4*3600000;
function simcoJobBackoffKey(realm,job){return `${realm==null?'-':realm}|${job}`;}
function simcoJobBackedOff(map,realm,job,now=Date.now()){const e=map&&typeof map==='object'?map[simcoJobBackoffKey(realm,job)]:null;return Boolean(e&&Number(e.until)>now);}
function simcoJobBackoffNext(map,realm,job,result,now=Date.now()){
  const m=map&&typeof map==='object'&&!Array.isArray(map)?{...map}:{},k=simcoJobBackoffKey(realm,job);
  for(const [kk,v] of Object.entries(m))if(!v||!(Number(v.until)>now-SIMCO_JOB_BACKOFF_MAX_MS))delete m[kk];
  if(result?.ok){if(!(k in m))return null;delete m[k];return m;}
  const o=String(result?.outcome||'');if(result?.gateWait||(o!=='failure'&&o!=='not-read'))return null;
  const fails=Math.min(10,(Number(m[k]?.fails)||0)+1);
  m[k]={until:now+Math.min(SIMCO_JOB_BACKOFF_MAX_MS,SIMCO_JOB_BACKOFF_MS*2**(fails-1)),fails};
  return m;
}
const SIMCO_JOB_TRIED_KEY='scmSimcoJobTried';
async function simcoJobBackoffRecord(realm,job,result){
  try{await simcoPublicWrite(async()=>{if(simcoPublicGen!==extensionClearGeneration)return;const got=await chrome.storage.local.get({[SIMCO_JOB_BACKOFF_KEY]:null,[SIMCO_JOB_TRIED_KEY]:null});
    const patch={},next=simcoJobBackoffNext(got[SIMCO_JOB_BACKOFF_KEY],realm,job,result),tried=simcoJobTriedNext(got[SIMCO_JOB_TRIED_KEY],realm,job,result);
    if(next)patch[SIMCO_JOB_BACKOFF_KEY]=next;if(tried)patch[SIMCO_JOB_TRIED_KEY]=tried;if(Object.keys(patch).length)await rawStorageSet(patch);});}catch{}
}
// One SimcoTools channel request (job from the URL: prices:<realm> for /market/prices, else public:<realm>). network:
// SimcoTools did not answer (no connection, timeout); the channel wrote the one outage line.
async function simcoPublicFetch(url,job=null){try{return await simcoFetch(url,SIMCOTOOLS_TIMEOUT_MS,job?{job}:null);}catch(e){const m=e?.message||String(e);return {ok:false,status:0,error:m};}}
function simcoPublicLog(realm,job,outcome,details,error,t0,trigger){return realm!=null?logActivity(realm,job,outcome,details,error,t0,trigger):logActivityAnyRealm(job,outcome,details,error);}
// A request that did not give data: not read (no request: gate / cooldown), rate-limited (server 429) or failed.
function simcoPublicTooLarge(realm,job,p,t0,trigger,extra={}){simcoPublicLog(realm,job,'failure',{...extra,chars:p.length},'response too large',t0,trigger);return {ok:false,outcome:'failure',tooLarge:true};}
// Set when a request was held by the SimcoTools channel (refusal / cooldown) (not the job's fault): runSimcoPublicData marks that
// result gateWait so it sets no job back-off.
let simcoPublicGateMissSeen=false;
function simcoPublicMiss(realm,job,resp,t0,trigger,extra={}){
  const status=Number(resp?.status)||0;
  // Refused by the SimcoTools channel (nothing sent; the job stays queued). While SimcoTools is unreachable the channel's
  // one outage line covers every job: no line per job and firing.
  if(resp?.skipped||resp?.limited){simcoPublicGateMissSeen=true;if(resp?.reason!=='unreachable')simcoPublicLog(realm,job,'not-read',{...extra,retryAt:resp?.retryAt||null,reason:resp?.reason||null},resp?.error?`Not read: ${resp.error}`:'Not read: waiting for the SimcoTools limit',t0,trigger);return 'not-read';}
  // SimcoTools did not answer (no connection / timeout): the channel logged the outage once; no line here.
  // Returns 'offline' so no caller reads it as a rate limit and no back-off step is set.
  if(status===0&&resp?.network&&resp?.outageLogged)return 'offline';
  // No connection at all (the same firing fails for the game too): not read, next firing tries again (no failure line).
  // A manual request (user is on the page) stays a failure.
  if(status===0&&resp?.network&&trigger!=='manual'){simcoPublicLog(realm,job,'not-read',{...extra,network:true,error:String(resp.error||'').slice(0,120)},'Not read: no network connection (phone asleep or offline); the next firing tries again',t0,trigger);return 'offline';}
  if(status===429){simcoPublicLog(realm,job,'rate-limited',{...extra,status,retryAt:resp?.retryAt||null},'SimcoTools answered 429 (rate limit); waiting for the cooldown',t0,trigger);return 'rate-limited';}
  simcoPublicLog(realm,job,'failure',{...extra,status},resp?.error||`HTTP ${status} from SimcoTools`,t0,trigger);return 'failure';
}
async function simcoPublicPrices(realm,t0,trigger){
  const job='simcotools-prices',resp=await simcoPublicFetch(`${SIMCO_API}/realms/${realm}/market/prices`);
  if(!resp?.ok)return {ok:false,outcome:simcoPublicMiss(realm,job,resp,t0,trigger)};
  const p=simcoPublicParse(resp.text);if(p.tooLarge)return simcoPublicTooLarge(realm,job,p,t0,trigger);
  const rows=simcoPricesRowsFromResponse(p.data);
  if(!rows.length){simcoPublicLog(realm,job,'failure',{status:resp.status},'SimcoTools returned no usable prices; the stored prices stay',t0,trigger);return {ok:false,outcome:'failure'};}
  const value={at:Date.now(),rows};
  await simcoPublicWrite(async()=>{await rawStorageSet({[simcoPricesKey(realm)]:value});simcoPricesMemo.set(realm,value);});
  simcoPublicLog(realm,job,'success',{rows:rows.length},null,t0,trigger);
  return {ok:true,rows:rows.length};
}
async function simcoPublicGovOrders(realm,t0,trigger){
  const job='simcotools-gov-orders',base=`${SIMCO_API}/realms/${realm}/government-orders?sort=-created_at&page_size=100`;
  // One page: newest first, 100 per page covers every order still open (a round is a few dozen orders).
  const resp=await simcoPublicFetch(base);
  if(!resp?.ok)return {ok:false,outcome:simcoPublicMiss(realm,job,resp,t0,trigger)};
  const p=simcoPublicParse(resp.text);if(p.tooLarge)return simcoPublicTooLarge(realm,job,p,t0,trigger);
  // No orders list in the answer (garbage): nothing written, the stored orders and history stay.
  if(!Array.isArray(p.data?.orders)){simcoPublicLog(realm,job,'failure',{status:resp.status},'SimcoTools returned no orders list; the stored orders stay',t0,trigger);return {ok:false,outcome:'failure'};}
  const all=simcoGovOrdersFromResponse(p.data);
  // Only orders still open (created + daysToFulfill days > now). Between two rounds that can be none: stored as an
  // empty list, never as expired orders (the dashboard then uses the game's data or hides the panel).
  const orders=simcoCurrentGovOrders(all);
  const now=Date.now(),value={at:now,orders};
  // Every order read (expired ones too) goes into the history in the same write: no extra request.
  const hist=await simcoPublicWrite(async()=>{
    const hk=simcoGovHistoryKey(realm),prev=(await simcoPublicGet({[hk]:null}))[hk];
    const h={at:now,...simcoGovHistoryMerge(prev,all)};await rawStorageSet({[simcoGovOrdersKey(realm)]:value,[hk]:h});return h;});
  simcoPublicLog(realm,job,'success',{rows:orders.length,read:all.length,history:hist?.orders?.length??null},orders.length?null:'0 current orders',t0,trigger);
  return {ok:true,orders:orders.length,history:hist?.orders?.length??0};
}
async function simcoPublicBuildingsList(realm,t0,trigger){
  const job='simcotools-buildings',resp=await simcoPublicFetch(`${SIMCO_API}/realms/0/buildings?disable_pagination=true`);
  if(!resp?.ok)return {ok:false,outcome:simcoPublicMiss(realm,job,resp,t0,trigger,{step:'list'})};
  const p=simcoPublicParse(resp.text);if(p.tooLarge)return simcoPublicTooLarge(realm,job,p,t0,trigger,{step:'list'});
  const ids=simcoBuildingIdsFromResponse(p.data);
  if(!ids.length){simcoPublicLog(realm,job,'failure',{step:'list',status:resp.status},'SimcoTools returned no building ids',t0,trigger);return {ok:false,outcome:'failure'};}
  await simcoPublicWrite(async()=>{
    const cur=(await simcoPublicGet({scmSimcoBuildingsMeta:null})).scmSimcoBuildingsMeta||{};
    const keep=o=>Object.fromEntries(Object.entries(o&&typeof o==='object'?o:{}).filter(([id])=>ids.includes(id)));
    await rawStorageSet({scmSimcoBuildingsMeta:{listAt:Date.now(),ids,entryAt:keep(cur.entryAt),missing:keep(cur.missing)}});
  });
  simcoPublicLog(realm,job,'success',{step:'list',rows:ids.length},null,t0,trigger);
  return {ok:true,ids:ids.length};
}
async function simcoPublicBuilding(realm,id,t0,trigger){
  const job='simcotools-buildings',resp=await simcoPublicFetch(`${SIMCO_API}/realms/0/buildings/${encodeURIComponent(id)}`);
  const status=Number(resp?.status)||0;
  if(!resp?.ok&&status!==404)return {ok:false,outcome:simcoPublicMiss(realm,job,resp,t0,trigger,{step:'building',id})};
  // A body over 2 MB is not parsed: one failure line, then skipped for a day like a 404.
  const p=resp?.ok?simcoPublicParse(resp.text):null;if(p?.tooLarge)simcoPublicTooLarge(realm,job,p,t0,trigger,{step:'building',id});
  const entry=p&&!p.tooLarge?simcoBuildingEntryFromResponse(p.data):null;
  const now=Date.now();
  // A 404 (or an answer without the two numbers) is skipped for a day, not a failure.
  const left=await simcoPublicWrite(async()=>{
    const g=await simcoPublicGet({scmSimcoBuildingsMeta:null,scmSimcoBuildings:null});
    const meta={...(g.scmSimcoBuildingsMeta||{})};meta.entryAt={...(meta.entryAt||{}),[id]:now};
    const patch={};
    if(entry){const cur=g.scmSimcoBuildings&&typeof g.scmSimcoBuildings==='object'?g.scmSimcoBuildings:{};const byId={...(cur.byId&&typeof cur.byId==='object'?cur.byId:{})};
      byId[entry.kind]={costUnits:entry.costUnits,buildDuration:entry.buildDuration};patch.scmSimcoBuildings={at:now,byId};
      if(meta.missing?.[id]!=null){meta.missing={...meta.missing};delete meta.missing[id];}}
    else meta.missing={...(meta.missing||{}),[id]:now};
    patch.scmSimcoBuildingsMeta=meta;await rawStorageSet(patch);
    return {next:simcoNextBuildingId(meta,now),total:(meta.ids||[]).length,missing:Object.keys(meta.missing||{}).length,stored:Object.keys(patch.scmSimcoBuildings?.byId||g.scmSimcoBuildings?.byId||{}).length};
  });
  if(!left)return {ok:false,cleared:true};
  // One line per round (when the last due building is read), not one per building; a skipped one gets its own line.
  if(!entry&&!p?.tooLarge)simcoPublicLog(realm,job,'skipped',{step:'building',id,status},status===404?`Building ${id} is not on SimcoTools (404); skipped for a day`:`Building ${id}: no cost or build time in the answer; skipped for a day`,t0,trigger);
  if(!left.next)simcoPublicLog(realm,job,'success',{step:'round',rows:left.stored,wanted:left.total,missing:left.missing},null,t0,trigger);
  return {ok:true,id,stored:Boolean(entry)};
}
async function simcoPublicResources(realm,t0,trigger){
  const job='simcotools-resources',resp=await simcoPublicFetch(`${SIMCO_API}/realms/${realm}/resources?disable_pagination=true`);
  // No request made (gate / cooldown): no backoff step.
  if(resp?.skipped||resp?.limited)return {ok:false,outcome:simcoPublicMiss(realm,job,resp,t0,trigger)};
  const p=resp?.ok?simcoPublicParse(resp.text):null;
  const parsed=p&&!p.tooLarge?simcoResourcesFromResponse(p.data):null;
  if(!parsed||!Object.keys(parsed.byId).length){
    const prev=(await simcoPublicGet({scmSimcoResourcesRetry:null})).scmSimcoResourcesRetry;
    const next=simcoResourcesRetryNext(prev);
    await simcoPublicWrite(()=>rawStorageSet({scmSimcoResourcesRetry:next}));
    const status=Number(resp?.status)||0;
    simcoPublicLog(realm,job,Number(resp?.status)===429?'rate-limited':'failure',{status,fails:next.fails,retryAt:new Date(next.until).toISOString()},`${p?.tooLarge?'response too large':resp?.ok?'SimcoTools returned no resources':resp?.error||`HTTP ${status} from SimcoTools`}; next try after ${new Date(next.until).toISOString().slice(11,16)} UTC`,t0,trigger);
    return {ok:false,outcome:'failure',retry:next};
  }
  await simcoPublicWrite(async()=>{await rawStorageSet({scmSimcoResources:{at:Date.now(),phase:parsed.phase,byId:parsed.byId}});await chrome.storage.local.remove('scmSimcoResourcesRetry').catch(()=>{});});
  simcoPublicLog(realm,job,'success',{rows:Object.keys(parsed.byId).length},null,t0,trigger);
  return {ok:true,rows:Object.keys(parsed.byId).length};
}
async function simcoPublicPhases(realm,t0,trigger){
  const job='simcotools-phases',resp=await simcoPublicFetch(`${SIMCO_API}/realms/${realm}/phases?page_size=30&sort=-end_date`);
  if(!resp?.ok)return {ok:false,outcome:simcoPublicMiss(realm,job,resp,t0,trigger)};
  const p=simcoPublicParse(resp.text);if(p.tooLarge)return simcoPublicTooLarge(realm,job,p,t0,trigger);
  const ranges=simcoPhasesFromResponse(p.data);
  if(!ranges.length){simcoPublicLog(realm,job,'failure',{status:resp.status},'SimcoTools returned no usable phases; the stored phases stay',t0,trigger);return {ok:false,outcome:'failure'};}
  await simcoPublicWrite(()=>rawStorageSet({[simcoPhasesKey(realm)]:{at:Date.now(),ranges}}));
  simcoPublicLog(realm,job,'success',{rows:ranges.length,phase:ranges[0].phase},null,t0,trigger);
  return {ok:true,ranges:ranges.length};
}
async function simcoPublicEvents(realm,t0,trigger){
  // All events, not only the running ones: ended events are needed to look up the event in force when a run started.
  const job='simcotools-events',resp=await simcoPublicFetch(`${SIMCO_API}/realms/${realm}/events?sort=-id&page_size=100`);
  if(!resp?.ok)return {ok:false,outcome:simcoPublicMiss(realm,job,resp,t0,trigger)};
  const p=simcoPublicParse(resp.text);if(p.tooLarge)return simcoPublicTooLarge(realm,job,p,t0,trigger);
  const events=simcoEventsFromResponse(p.data);
  if(!events.length){simcoPublicLog(realm,job,'failure',{status:resp.status},'SimcoTools returned no usable events; the stored events stay',t0,trigger);return {ok:false,outcome:'failure'};}
  await simcoPublicWrite(()=>rawStorageSet({[simcoEventsKey(realm)]:{at:Date.now(),events}}));
  simcoPublicLog(realm,job,'success',{rows:events.length},null,t0,trigger);
  return {ok:true,events:events.length};
}
async function simcoPublicCompany(realm,companyId,t0,trigger){
  const job='simcotools-company',cid=simcoSafeCompanyId(companyId);
  // The id goes into the request path: only a positive safe integer, as String(Number(id)).
  if(!cid){simcoPublicLog(realm,job,'not-read',{},'Not read: no company id yet (open the game once)',t0,trigger);return {ok:false,outcome:'not-read'};}
  const resp=await simcoPublicFetch(`${SIMCO_API}/realms/${realm}/companies/${String(Number(cid))}/history?period=day&page_size=100&sort=-date`);
  const status=Number(resp?.status)||0;
  if(!resp?.ok&&status===404){
    // Company not on SimcoTools: stored as not tracked, asked again after a day (or when the company id changes).
    await simcoPublicWrite(()=>rawStorageSet({[simcoCompanyKey(realm)]:{at:Date.now(),companyId:cid,rows:[],notTracked:true}}));
    simcoPublicLog(realm,job,'skipped',{status,companyId:cid},'Company is not on SimcoTools (404); skipped for a day',t0,trigger);
    return {ok:true,notTracked:true};
  }
  if(!resp?.ok)return {ok:false,outcome:simcoPublicMiss(realm,job,resp,t0,trigger,{companyId:cid})};
  const p=simcoPublicParse(resp.text);if(p.tooLarge)return simcoPublicTooLarge(realm,job,p,t0,trigger,{companyId:cid});
  const rows=simcoCompanyRowsFromResponse(p.data);
  if(!rows){simcoPublicLog(realm,job,'failure',{status:resp.status,companyId:cid},'SimcoTools returned no company history; the stored history stays',t0,trigger);return {ok:false,outcome:'failure'};}
  await simcoPublicWrite(()=>rawStorageSet({[simcoCompanyKey(realm)]:{at:Date.now(),companyId:cid,rows}}));
  simcoPublicLog(realm,job,'success',{rows:rows.length,companyId:cid},rows.length?null:'0 history rows',t0,trigger);
  return {ok:true,rows:rows.length};
}
// Ranking: ONE request. plan {mode:'page',rank}: the 100-row page holding the rank (page = ceil(rank/100), 1-based);
// {mode:'own'}: the company's own row only (stored partial; the page comes next firing). Own row not on the page: no second
// page this firing; the next firing asks for the own row once (lookup), then nothing more until the copy is a day old.
async function simcoPublicRanking(realm,companyId,t0,trigger,plan=null){
  const job='simcotools-ranking',cid=simcoSafeCompanyId(companyId),key=simcoRankingKey(realm);
  if(!cid){simcoPublicLog(realm,job,'not-read',{},'Not read: no company id yet (open the game once)',t0,trigger);return {ok:false,outcome:'not-read'};}
  const rank=Number(plan?.rank),page=plan?.mode==='page'&&Number.isSafeInteger(rank)&&rank>0?Math.ceil(rank/100):0,step=page?'page':'own';
  const url=page?`${SIMCO_API}/realms/${realm}/ranking?sort=rank&page_size=100&page=${page}`:`${SIMCO_API}/realms/${realm}/ranking?companies=${String(Number(cid))}&page_size=1`;
  const resp=await simcoPublicFetch(url);const status=Number(resp?.status)||0;
  if(!resp?.ok&&status!==404)return {ok:false,outcome:simcoPublicMiss(realm,job,resp,t0,trigger,{step,companyId:cid})};
  const p=resp?.ok?simcoPublicParse(resp.text):null;if(p?.tooLarge)return simcoPublicTooLarge(realm,job,p,t0,trigger,{step,companyId:cid});
  const r=p?simcoRankingFromResponse(p.data,cid):{date:null,rows:[],total:null,found:false};
  if(!r){simcoPublicLog(realm,job,'failure',{step,status,companyId:cid},'SimcoTools returned no ranking; the stored ranking stays',t0,trigger);return {ok:false,outcome:'failure'};}
  const now=Date.now(),date=r.date||simcoUtcDay(now);
  const kind=await simcoPublicWrite(async()=>{
    const cur=(await simcoPublicGet({[key]:null}))[key];const same=Boolean(cur&&typeof cur==='object'&&Number(cur.companyId)===cid);
    const missAt=same&&Number(cur.pageMissAt)>0&&now-Number(cur.pageMissAt)<SIMCO_DAILY_MAX_AGE_MS?Number(cur.pageMissAt):0;
    let value,kind;
    if(r.found){const own=r.rows.find(x=>x.companyId===cid);
      value=page?{at:now,date,companyId:cid,rank:own.rank,rows:r.rows}:{at:now,date,companyId:cid,rank:own.rank,partial:true,rows:[own]};
      if(r.total!=null)value.total=r.total;if(!page&&(missAt||own.rank==null))value.pageMissAt=missAt||now;kind=page?'full':'partial';}
    else if(page){
      const freshPartial=same&&cur.partial&&simcoAgeOk(cur.at,SIMCO_DAILY_MAX_AGE_MS,now);
      if(freshPartial)value={...cur,pageMissAt:now};
      else{value={...(same?cur:{companyId:cid,rank:null,rows:[]}),at:same?Number(cur.at)||0:0,lookup:true,pageMissAt:now};}
      kind='page-miss';}
    else{value={at:now,date,companyId:cid,rank:null,partial:true,rows:[],pageMissAt:now};kind='not-listed';}
    await rawStorageSet({[key]:value});return kind;
  });
  if(!kind)return {ok:false,cleared:true};
  if(kind==='full'||kind==='partial')simcoPublicLog(realm,job,'success',{step,rows:kind==='full'?r.rows.length:1,companyId:cid,partial:kind==='partial'},null,t0,trigger);
  else simcoPublicLog(realm,job,'skipped',{step,status,companyId:cid},kind==='page-miss'?'Own company not on the ranking page; the own row is asked for next':'Company is not in the SimcoTools ranking; skipped for a day',t0,trigger);
  return {ok:true,kind};
}
async function simcoPublicContests(realm,t0,trigger){
  const job='simcotools-contests',resp=await simcoPublicFetch(`${SIMCO_API}/realms/${realm}/contests?sort=-start_date&page_size=20`);
  if(!resp?.ok)return {ok:false,outcome:simcoPublicMiss(realm,job,resp,t0,trigger)};
  const p=simcoPublicParse(resp.text);if(p.tooLarge)return simcoPublicTooLarge(realm,job,p,t0,trigger);
  const contests=simcoContestsFromResponse(p.data,Date.now());
  // No list (garbage): stored contests stay. An empty list is a real answer (no contest now).
  if(!contests){simcoPublicLog(realm,job,'failure',{status:resp.status},'SimcoTools returned no contests list; the stored contests stay',t0,trigger);return {ok:false,outcome:'failure'};}
  const w=await simcoPublicWrite(async()=>{await rawStorageSet({[simcoContestsKey(realm)]:{at:Date.now(),contests}});return true;});
  if(!w)return {ok:false,cleared:true};
  simcoPublicLog(realm,job,'success',{rows:contests.length},contests.length?null:'0 contests',t0,trigger);
  return {ok:true,contests:contests.length};
}
async function simcoPublicSummaries(realm,t0,trigger){
  const since=simcoUtcDay(Date.now()-SIMCO_SUMMARY_DAYS*86400000);
  const job='simcotools-summaries',resp=await simcoPublicFetch(`${SIMCO_API}/realms/${realm}/summaries?since_date=${since}&page_size=100&sort=date`);
  if(!resp?.ok)return {ok:false,outcome:simcoPublicMiss(realm,job,resp,t0,trigger)};
  const p=simcoPublicParse(resp.text);if(p.tooLarge)return simcoPublicTooLarge(realm,job,p,t0,trigger);
  const rows=simcoSummariesFromResponse(p.data);
  if(!rows?.length){simcoPublicLog(realm,job,'failure',{status:resp.status},'SimcoTools returned no usable realm summaries; the stored summaries stay',t0,trigger);return {ok:false,outcome:'failure'};}
  await simcoPublicWrite(()=>rawStorageSet({[simcoSummaryKey(realm)]:{at:Date.now(),rows}}));
  simcoPublicLog(realm,job,'success',{rows:rows.length},null,t0,trigger);
  return {ok:true,rows:rows.length};
}
async function simcoPublicBuildingStats(realm,t0,trigger){
  const job='simcotools-building-stats',resp=await simcoPublicFetch(`${SIMCO_API}/realms/${realm}/stats/buildings?page_size=100&sort=-count`);
  if(!resp?.ok)return {ok:false,outcome:simcoPublicMiss(realm,job,resp,t0,trigger)};
  const p=simcoPublicParse(resp.text);if(p.tooLarge)return simcoPublicTooLarge(realm,job,p,t0,trigger);
  const s=simcoBuildingStatsFromResponse(p.data);
  if(!s?.rows.length){simcoPublicLog(realm,job,'failure',{status:resp.status},'SimcoTools returned no usable building counts; the stored counts stay',t0,trigger);return {ok:false,outcome:'failure'};}
  await simcoPublicWrite(()=>rawStorageSet({[simcoBuildingStatsKey(realm)]:{at:Date.now(),total:s.total,rows:s.rows}}));
  simcoPublicLog(realm,job,'success',{rows:s.rows.length},null,t0,trigger);
  return {ok:true,rows:s.rows.length};
}
async function simcoPublicCertKinds(realm,t0,trigger){
  const job='simcotools-cert-kinds',resp=await simcoPublicFetch(`${SIMCO_API}/realms/${realm}/certificates?page_size=100`);
  if(!resp?.ok)return {ok:false,outcome:simcoPublicMiss(realm,job,resp,t0,trigger)};
  const p=simcoPublicParse(resp.text);if(p.tooLarge)return simcoPublicTooLarge(realm,job,p,t0,trigger);
  const kinds=simcoCertKindsFromResponse(p.data);
  if(!kinds?.length){simcoPublicLog(realm,job,'failure',{status:resp.status},'SimcoTools returned no certificate kinds; the stored list stays',t0,trigger);return {ok:false,outcome:'failure'};}
  const w=await simcoPublicWrite(async()=>{await rawStorageSet({[simcoCertKindsKey(realm)]:{at:Date.now(),kinds}});return true;});
  if(!w)return {ok:false,cleared:true};
  simcoPublicLog(realm,job,'success',{rows:kinds.length},null,t0,trigger);
  return {ok:true,rows:kinds.length};
}
// Page 1 of one kind. 404 = no holders (stored empty, not asked again for a day). Only the 6 newest kinds are kept.
async function simcoPublicCertHolders(realm,kind,t0,trigger){
  const job='simcotools-cert-holders',k=simcoSmallInt(kind,9999);
  if(k==null){simcoPublicLog(realm,job,'failure',{kind:String(kind).slice(0,12)},'Bad certificate kind',t0,trigger);return {ok:false,outcome:'failure'};}
  const resp=await simcoPublicFetch(`${SIMCO_API}/realms/${realm}/certificates/${String(k)}?page_size=100`);const status=Number(resp?.status)||0;
  if(!resp?.ok&&status!==404)return {ok:false,outcome:simcoPublicMiss(realm,job,resp,t0,trigger,{kind:k})};
  const p=resp?.ok?simcoPublicParse(resp.text):null;if(p?.tooLarge)return simcoPublicTooLarge(realm,job,p,t0,trigger,{kind:k});
  const h=p?simcoCertHoldersFromResponse(p.data):{total:0,rows:[]};
  if(!h){simcoPublicLog(realm,job,'failure',{kind:k,status},'SimcoTools returned no certificate list; the stored holders stay',t0,trigger);return {ok:false,outcome:'failure'};}
  const key=simcoCertHoldersKey(realm);
  const w=await simcoPublicWrite(async()=>{
    const cur=(await simcoPublicGet({[key]:null}))[key];const prev=cur?.byKind&&typeof cur.byKind==='object'?cur.byKind:{};const now=Date.now();
    const keep=Object.entries(prev).filter(([kk,v])=>String(kk)!==String(k)&&v&&typeof v==='object').sort((a,b)=>(Number(b[1].at)||0)-(Number(a[1].at)||0)).slice(0,SIMCO_CAP.certKindsPerDay-1);
    await rawStorageSet({[key]:{at:now,byKind:Object.fromEntries([...keep,[String(k),{at:now,total:h.total,rows:h.rows}]])}});return true;});
  if(!w)return {ok:false,cleared:true};
  simcoPublicLog(realm,job,status===404?'skipped':'success',{kind:k,rows:h.rows.length,total:h.total},status===404?`No holders of certificate ${k} on SimcoTools (404)`:null,t0,trigger);
  return {ok:true,kind:k,rows:h.rows.length};
}
// Executive name search (SCM_SIMCO_EXEC_LOOKUP). On demand, ONE request through the SimcoTools channel; the same search within
// 24 h is answered from scmSimcoExecLookup:<realm>. No request during a Sync ({busy}), a 429 cooldown or while SimcoTools is
// unreachable ({limited, retryAt}); lookups at least SIMCO_EXEC_LOOKUP_GAP_MS apart (no burst from repeated clicks). A running
// request (lookup or alarm job) is never interrupted. A lookup started before Clear data writes nothing.
// Lookups run one at a time (promise tail). The gap slot is reserved (memory at once, then storage.session so a worker
// restart keeps it) only when a request will be made; a cache hit or a refusal uses no slot. A request simcoFetch did not
// send (gate / cooldown: skipped) gives the slot back; a sent request keeps it whatever its answer.
const SIMCO_EXEC_LOOKUP_GAP_MS=30000,SIMCO_EXEC_LOOKUP_GAP_KEY='scmSimcoExecLookupGap';
let simcoExecLookupLastAt=null,simcoExecLookupTail=Promise.resolve();
async function simcoExecLookupGapLoad(){
  if(simcoExecLookupLastAt!=null)return simcoExecLookupLastAt;
  let v=0;try{if(chrome.storage?.session)v=Number((await chrome.storage.session.get(SIMCO_EXEC_LOOKUP_GAP_KEY))?.[SIMCO_EXEC_LOOKUP_GAP_KEY]?.lastAt)||0;}catch{}
  if(simcoExecLookupLastAt==null)simcoExecLookupLastAt=v;return simcoExecLookupLastAt;
}
async function simcoExecLookupGapSave(at){simcoExecLookupLastAt=at;try{if(chrome.storage?.session)await chrome.storage.session.set({[SIMCO_EXEC_LOOKUP_GAP_KEY]:{lastAt:at}});}catch{}}
function simcoExecLookup(m){const run=simcoExecLookupTail.then(()=>simcoExecLookupRun(m));simcoExecLookupTail=run.catch(()=>{});return run;}
async function simcoExecLookupRun(m){
  const q=simcoExecLookupQuery(m);if(q.error)return {ok:false,error:q.error};
  const gen=extensionClearGeneration;
  const realm=validRealmNumber(m?.realm)??await activeRealmNumber();if(realm==null)return {ok:false,error:'Pick a realm first.'};
  const key=simcoExecLookupKey(realm),now=Date.now();
  const cache=(await simcoPublicGet({[key]:null}))[key];const hit=cache&&typeof cache==='object'?cache[q.key]:null;
  if(hit&&Array.isArray(hit.rows)&&simcoAgeOk(hit.at,SIMCO_EXEC_LOOKUP_MAX_AGE_MS,now))return {ok:true,cached:true,realm,at:Number(hit.at),rows:hit.rows};
  if(coreSyncActive()||realmSyncSessions.size>0)return {ok:false,busy:true};
  const ch=await simcoChannelPeek(),lastAt=await simcoExecLookupGapLoad(),t=Date.now();
  // The channel's 429 cooldown or the next probe while SimcoTools is unreachable (a token wait is under a second: the
  // request goes and the channel decides).
  const chAt=ch&&(Number(ch.cooldownUntil)>t||ch.unreachableSince)?simcoChannelNextAt(ch,t):0;
  const waitUntil=Math.max(chAt,lastAt?lastAt+SIMCO_EXEC_LOOKUP_GAP_MS:0);
  if(waitUntil>t)return {ok:false,limited:true,retryAt:new Date(waitUntil).toISOString()};
  simcoExecLookupLastAt=t;await simcoExecLookupGapSave(t);
  const t0=Date.now(),job='simcotools-exec-lookup';
  const url=`${SIMCO_API}/realms/${realm}/executives?name=${encodeURIComponent(q.name)}&page_size=${SIMCO_CAP.execRows}${q.position?`&position=${encodeURIComponent(q.position)}`:''}`;
  const resp=await simcoPublicFetch(url);
  // Not sent (gate / cooldown): the slot goes back.
  if(resp?.skipped&&simcoExecLookupLastAt===t)await simcoExecLookupGapSave(lastAt);
  if(!resp?.ok){const outcome=simcoPublicMiss(realm,job,resp,t0,'manual',{position:q.position});
    if(outcome==='not-read'||outcome==='rate-limited'||outcome==='offline')return {ok:false,limited:true,...(resp?.network||resp?.unreachable?{unreachable:true,unreachableSince:resp?.unreachableSince||null}:{}),retryAt:resp?.retryAt||new Date(Date.now()+SIMCOTOOLS_DEFAULT_RATE_LIMIT_COOLDOWN_MS).toISOString()};
    return {ok:false,error:resp?.error||`HTTP ${Number(resp?.status)||0} from SimcoTools`};}
  const p=simcoPublicParse(resp.text);if(p.tooLarge){simcoPublicTooLarge(realm,job,p,t0,'manual');return {ok:false,error:'SimcoTools answer too large'};}
  const rows=simcoExecutivesFromResponse(p.data);
  if(!rows){simcoPublicLog(realm,job,'failure',{status:resp.status},'SimcoTools returned no executives list',t0,'manual');return {ok:false,error:'SimcoTools returned no executives list'};}
  const at=Date.now();
  const w=await simcoPublicWrite(async()=>{const cur=(await simcoPublicGet({[key]:null}))[key];await rawStorageSet({[key]:simcoExecLookupCachePut(cur,q.key,{at,rows})});return true;},gen);
  if(!w)return {ok:false,cleared:true};
  simcoPublicLog(realm,job,'success',{rows:rows.length,position:q.position},rows.length?null:'0 executives found',t0,'manual');
  return {ok:true,cached:false,realm,at,rows};
}
// The SimcoTools company-history line when no company id is known: at most once an hour (no request is made).
let simcoCompanyNoIdLogAt=0;
// ctx for simcoPublicPickJob from the realm store (storage only): company id and when the game's pages last gave phases / events.
async function simcoPublicContext(realm,economyLog){
  const store=await notifyRealmStore(realm).catch(()=>({}));
  const ac=store?.authData?.authCompany;const ar=validRealmNumber(ac?.realmId??ac?.realm??store?.authData?.realmId??store?.authData?.realm);
  const captured=capturedCompanyIdForRealm(store,realm);
  const companyId=captured>0?captured:(ar==null||ar===realm?simcoSafeCompanyId(ac?.companyId??ac?.id):0);
  // govPassiveAt: the game's own gov-orders list; rankingPassiveAt: a game ranking page holding the company (both captured only).
  // productIds: what the user makes or holds (certificate holders job; empty = no holders job).
  return {companyId,productIds:simcoProductIds(store),...simcoPublicPassive(store,realm,economyLog),govPassiveAt:simcoGovPassiveAt(store,realm),rankingPassiveAt:simcoGameRankingPassiveAt(store,realm,companyId)};
}
async function runSimcoPublicData(trigger='alarm'){
  if(simcoPublicRun)return simcoPublicRun;
  simcoPublicRun=(async()=>{
    simcoPublicGen=extensionClearGeneration;
    if(coreSyncActive()||realmSyncSessions.size>0)return {ok:true,skipped:true,reason:'sync'};
    // The SimcoTools timer (Settings, liveMarket) covers these too: off = no request (a fresh install starts with it off).
    if(!(await scmTimerEnabled('liveMarket').catch(()=>true)))return {ok:true,skipped:true,reason:'switched-off'};
    // Fired within 20 s of the live-market alarm (both were re-created at once, e.g. after an update): move this alarm
    // 2.5 min after it and leave the slot to the VWAP / followed prices run.
    if(trigger==='alarm'){const lm=await chrome.alarms.get(LIVE_MARKET_REFRESH_ALARM_NAME).catch(()=>null);const d=Number(lm?.scheduledTime)-Date.now();const p=Number(lm?.periodInMinutes)*60000;
      if(lm&&(Math.abs(d)<20000||(p>0&&Math.abs(d-p)<20000))){await chrome.alarms.clear(SIMCO_PUBLIC_ALARM).catch(()=>{});await ensureSimcoPublicAlarm();return {ok:true,skipped:true,reason:'live-market-slot'};}}
    // SimcoTools cooling down after a 429 or unreachable with no probe due: no request (the channel queue runs the job).
    {const st=await simcoChannelPeek(),now=Date.now();if(st&&Number(st.cooldownUntil)>now)return {ok:true,skipped:true,reason:'rate-limit-cooldown'};
      if(st&&st.unreachableSince&&now<Number(st.nextProbeAt)){const ar=await activeRealmNumber();await simcoChannelTake(ar===0||ar===1?`public:${ar}`:'public',{peek:true}).catch(()=>{});return {ok:true,skipped:true,reason:'simcotools-unreachable'};}}
    const realm=await activeRealmNumber();
    const keys={scmSimcoBuildingsMeta:null,scmSimcoResources:null,scmSimcoResourcesRetry:null,[SIMCO_JOB_BACKOFF_KEY]:null,scmSimcoJobTried:null};
    if(realm!=null){for(const k of [simcoPricesKey(realm),simcoGovOrdersKey(realm),simcoPhasesKey(realm),simcoEventsKey(realm),simcoCompanyKey(realm),simcoRankingKey(realm),simcoContestsKey(realm),simcoSummaryKey(realm),simcoBuildingStatsKey(realm),simcoCertKindsKey(realm),simcoCertHoldersKey(realm)])keys[k]=null;keys[`scmEconomyStateLog:${realm}`]=[];}
    const g=await simcoPublicGet(keys);
    const ctx=realm!=null?await simcoPublicContext(realm,g[`scmEconomyStateLog:${realm}`]):null;
    const due=simcoPublicPickFair(g,realm,Date.now(),ctx);
    if(ctx&&(!due||['building','ranking','contests','summaries','building-stats','cert-kinds','cert-holders'].includes(due.job))&&simcoCompanyDue(g,realm,ctx,Date.now())==='no-id'&&Date.now()-simcoCompanyNoIdLogAt>=3600000){
      simcoCompanyNoIdLogAt=Date.now();simcoPublicLog(realm,'simcotools-company','not-read',{},'Not read: no company id yet (open the game once)',Date.now(),trigger);}
    if(!due)return {ok:true,skipped:true,reason:'all-fresh'};
    if(coreSyncActive())return {ok:true,skipped:true,reason:'sync'};
    simcoPublicGateMissSeen=false;
    let res=await simcoPublicRunJob(due,realm,trigger);
    if(simcoPublicGateMissSeen&&!res?.ok)res={...res,gateWait:true};
    await simcoJobBackoffRecord(realm,due.job,res);
    return res;
  })().catch(e=>{logError('simcotools-public',e);return {ok:false,error:e?.message||String(e)};}).finally(()=>{simcoPublicRun=null;});
  return simcoPublicRun;
}
async function simcoPublicRunJob(due,realm,trigger){
  {
    const t0=Date.now();
    if(due.job==='prices')return {job:due.job,...(await simcoPublicPrices(realm,t0,trigger))};
    if(due.job==='gov-orders')return {job:due.job,...(await simcoPublicGovOrders(realm,t0,trigger))};
    if(due.job==='phases')return {job:due.job,...(await simcoPublicPhases(realm,t0,trigger))};
    if(due.job==='events')return {job:due.job,...(await simcoPublicEvents(realm,t0,trigger))};
    if(due.job==='company')return {job:due.job,...(await simcoPublicCompany(realm,due.companyId,t0,trigger))};
    if(due.job==='buildings-list')return {job:due.job,...(await simcoPublicBuildingsList(realm,t0,trigger))};
    if(due.job==='resources')return {job:due.job,...(await simcoPublicResources(realm,t0,trigger))};
    if(due.job==='ranking')return {job:due.job,...(await simcoPublicRanking(realm,due.companyId,t0,trigger,due))};
    if(due.job==='contests'){const r=await simcoPublicContests(realm,t0,trigger);if(r?.ok)await runContestReminders(realm).catch(()=>{});return {job:due.job,...r};}
    if(due.job==='summaries')return {job:due.job,...(await simcoPublicSummaries(realm,t0,trigger))};
    if(due.job==='building-stats')return {job:due.job,...(await simcoPublicBuildingStats(realm,t0,trigger))};
    if(due.job==='cert-kinds')return {job:due.job,...(await simcoPublicCertKinds(realm,t0,trigger))};
    if(due.job==='cert-holders')return {job:due.job,...(await simcoPublicCertHolders(realm,due.kind,t0,trigger))};
    return {job:due.job,...(await simcoPublicBuilding(realm,due.id,t0,trigger))};
  }
}
// Created when missing (or its period changed), 2.5 min after the live-market alarm's next firing, so the two never meet.
async function ensureSimcoPublicAlarm(){
  try{
    const a=await chrome.alarms.get(SIMCO_PUBLIC_ALARM);
    if(a&&Number(a.periodInMinutes)===SIMCO_PUBLIC_PERIOD_MINUTES)return {ok:true,created:false};
    const lm=await chrome.alarms.get(LIVE_MARKET_REFRESH_ALARM_NAME).catch(()=>null);
    let when=Number(lm?.scheduledTime)>0?Number(lm.scheduledTime)+SIMCO_PUBLIC_OFFSET_MS:Date.now()+SIMCO_PUBLIC_OFFSET_MS;
    const periodMs=SIMCO_PUBLIC_PERIOD_MINUTES*60000;
    while(when-periodMs>Date.now()+30000)when-=periodMs;
    while(when<Date.now()+30000)when+=periodMs;
    await scmAlarmCreate(SIMCO_PUBLIC_ALARM,{when,periodInMinutes:SIMCO_PUBLIC_PERIOD_MINUTES});
    return {ok:true,created:true,when};
  }catch(e){return {ok:false,error:e?.message||String(e)};}
}
// Contest reminders: from stored contests only (no request), every firing, before the Sync / timer / 429 / gate checks, so
// they work with the SimcoTools timer off. Uses SCM_NOTIFY_CORE.contestReminders when that build has it.
async function runContestReminders(realm){
  const n=validRealmNumber(realm);if(n==null)return {ok:false,reason:'realm'};
  const N=globalThis.SCM_NOTIFY_CORE;if(typeof N?.contestReminders!=='function')return {ok:true,skipped:true,reason:'no-core'};
  const cfg=await notifySettings();if(!cfg.contestReminder)return {ok:true,skipped:true,reason:'switched-off'};
  const key=simcoContestsKey(n),cur=(await simcoPublicGet({[key]:null}))[key];
  const contests=Array.isArray(cur?.contests)?cur.contests:[];
  const lead=Number(cfg.contestLeadHours),leadHours=Number.isFinite(lead)&&lead>0?Math.min(lead,336):24;
  let fired=0;
  await updateNotifyState(async state=>{
    const sk=`contests:${n}`,prev=state[sk]&&typeof state[sk]==='object'?state[sk]:{};
    if(!contests.length&&!Object.keys(prev).length)return null;
    const r=N.contestReminders({contests,state:{...prev},now:Date.now(),leadHours,realm:n});
    // State pruned to the stored contests (keys '<id>:start' / '<id>:end').
    const ids=new Set(contests.map(c=>String(c?.id))),next={};
    for(const [k,v] of Object.entries(r?.state&&typeof r.state==='object'?r.state:{})){const i=k.lastIndexOf(':');if(i>0&&ids.has(k.slice(0,i)))next[k]=v;}
    const fire=Array.isArray(r?.fire)?r.fire:[];
    for(const f of fire){await scmNotify(`contest-${n}-${String(f?.id??'').replace(/[^\w:-]/g,'').slice(0,60)}`,String(f?.title||''),String(f?.message||''));fired++;}
    if(!fire.length&&JSON.stringify(next)===JSON.stringify(prev))return null;
    state[sk]=next;return state;
  });
  return {ok:true,fired};
}
async function runContestRemindersAll(){for(const r of [0,1])await runContestReminders(r).catch(e=>logError('contest-reminders',e));}
chrome.alarms.onAlarm.addListener(a=>{if(a?.name!==SIMCO_PUBLIC_ALARM)return;runContestRemindersAll().catch(()=>{});runSimcoPublicData('alarm').catch(()=>{});});
ensureSimcoPublicAlarm();
// Game gov-orders list read after Sync: not needed while the SimcoTools copy is under 1 h old and the game's own list
// was captured within 24 h. Only the list; the tier read stays.
async function govOrdersListCoveredBySimco(realm,endpointData){
  const n=validRealmNumber(realm);if(n==null)return false;
  const g=(await simcoPublicGet({[simcoGovOrdersKey(n)]:null}))[simcoGovOrdersKey(n)];
  if(!simcoAgeOk(g?.at,SIMCO_GOV_ORDERS_MAX_AGE_MS))return false;
  const e=endpointData?.[`/api/v3/government-orders/${n}/`];const at=Date.parse(String(e?.receivedAt||''));
  return Boolean(e&&e.data!=null&&Number(e.status||200)>=200&&Number(e.status||200)<300&&simcoAgeOk(at,SIMCO_GOV_ORDERS_CAPTURE_MAX_AGE_MS));
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
  // Legacy realm-store fields (normally moved out at start-up) pass the same image check as scmResourceImages.
  const legacy=cleanResourceImageEntries({...(store.resourceImageCache||{}),...(store.resourceImageData||{})},store.resourceImageMeta);
  return {cache:{...imgs.cache,...legacy.cache},meta:{...imgs.meta,...legacy.meta},key};
}
// Images are written to their own key only (scmResourceImages), never through the realm store, so the weekly
// validation of ~150 images does not flood open pages with storage events.
async function saveResourceImages(cachePatch={},metaPatch={}){
  if(!Object.keys(cachePatch).length&&!Object.keys(metaPatch).length)return;
  return withRealmStorageCommit(async()=>{
    const cur=await resourceImagesStore();
    const next={cache:{...cur.cache,...cachePatch},meta:{...cur.meta,...metaPatch},updatedAt:new Date().toISOString()};
    await rawStorageSet({[RESOURCE_IMAGES_KEY]:next});
    resourceImagesMemo={cache:next.cache,meta:next.meta};
  });
}
// The game's own image path per resource (market ticker: {kind,image}). The bundled manifest only guesses
// file names; 31 of 151 guesses were wrong (e.g. smartphones.png vs the game's smart-phones.png) and never loaded.
// Only plain file names under images/resources are accepted from game data ('..', '\', '?', '#' are not), and every
// image fetch must end on the game's own static images path (checked on the normalised URL).
function validResourceImagePath(p){return typeof p==='string'&&/^images\/resources\/[A-Za-z0-9._-]+$/.test(p)&&!/^\.+$/.test(p.slice('images/resources/'.length));}
function safeResourceImageUrl(u){
  try{const x=new URL(String(u));
    if(x.protocol!=='https:'||x.origin!=='https://www.simcompanies.com'||x.username||x.password||!x.pathname.startsWith('/static/images/'))return null;
    if(x.pathname.split('/').some(s=>/^(?:\.|%2e){2}$/i.test(s)||s.includes('\\')))return null;
    return x.href;}catch{return null;}
}
function capturedResourceImages(store){
  const out={};
  for(const [url,entry] of Object.entries(store?.endpointData||{})){
    if(!/^\/api\/v3\/market-ticker\/\d+\/?$/.test(url)||!Array.isArray(entry?.data))continue;
    for(const x of entry.data){const k=Number(x?.kind);if(Number.isInteger(k)&&k>0&&validResourceImagePath(x?.image))out[String(k)]=x.image;}
  }
  return out;
}
// The game's own image path per resource from the game constants (scmGameConstants.resources[id].image). The five
// aerospace items that are not exchange-tradable (90, 94-97) never appear in the market ticker, so before this they
// were only tried at the bundled guess and failed every run.
async function constantsResourceImages(){
  try{const gc=(await chrome.storage.local.get({scmGameConstants:null})).scmGameConstants;const out={};
    for(const [k,x] of Object.entries(gc?.resources||{}))if(validResourceImagePath(x?.image))out[String(k)]=x.image;
    return out;}catch{return {};}
}
// Bundled-manifest file names the game answers 404 for (same list as dashboard.js RESOURCE_IMAGE_404_FILENAMES).
// With no game path known for such a resource nothing is fetched and it counts as unavailable, not as failed.
const RESOURCE_IMAGE_KNOWN_404_FILENAMES=new Set(['smartphones.png','basic-interior.png','economy-electric-car.png','luxury-electric-car.png','economy-fuel-car.png','luxury-fuel-car.png','skirt.png','high-heels.png','handbag.png','sports-shoes.png','luxury-watch.png','carbon-fibers.png','high-grade-e-comps.png','propellant-tank.png','solid-fuel-booster.png','aerospace-research.png','beams.png','cows.png','pigs.png','frozen-pizza.png','meat-balls.png','cocoa.png','sauce.png','samosa.png','chocolate-icecream.png','apple-icecream.png']);
// Resource images through the game tab. Since the game moved behind Cloudflare a plain service-worker fetch of
// /static/images/ gets a 403 page or "Failed to fetch"; the page hook then reads the image same-origin (IMAGE_GET via
// content.js PAGE_IMAGE_GET; safeResourceImageUrl paths only, checked again in content.js and page-hook.js). One read
// at a time with a short gap (the game page loads these images itself, usually from the browser cache).
const RESOURCE_IMAGE_PAGE_TIMEOUT_MS=10000,RESOURCE_IMAGE_PAGE_GAP_MS=150;
// Stored resource images: raster types only (no SVG, which can carry script), at most 1 MB decoded. Same list and cap
// as page-hook.js IMAGE_GET; checked again here on every source (worker fetch, game tab, RESOURCE_IMAGE_RESULT).
const RESOURCE_IMAGE_MIME_RE=/^image\/(?:png|jpeg|webp|gif|avif)$/,RESOURCE_IMAGE_MAX_BYTES=1024*1024;
// Parses a base64 image data URL; returns {mime,b64} or null (type not allowed, not base64, or over the cap; the
// size is checked from the base64 length before anything is decoded).
function resourceImageDataUrlParts(u){
  const m=typeof u==='string'&&u.length<=Math.ceil(RESOURCE_IMAGE_MAX_BYTES/3)*4+64?u.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/i):null;
  if(!m)return null;const mime=m[1].toLowerCase();if(!RESOURCE_IMAGE_MIME_RE.test(mime))return null;
  const pad=m[2].endsWith('==')?2:m[2].endsWith('=')?1:0;if(Math.floor(m[2].length*3/4)-pad>RESOURCE_IMAGE_MAX_BYTES)return null;
  return {mime,b64:m[2]};
}
let resourceImagePageChain=Promise.resolve();
// Resource ids the Manager knows: bundled manifest, game constants, the active realm's resource catalog.
async function knownResourceIds(){
  const ids=new Set();const add=o=>{for(const k of Object.keys(o&&typeof o==='object'?o:{})){const id=validResourceId(k);if(id!=null)ids.add(id);}};
  try{add((await resourceImageManifest())?.resources);}catch{}
  try{add((await chrome.storage.local.get({scmGameConstants:null})).scmGameConstants?.resources);}catch{}
  try{const s=await state();const key=s.activeRealmKey||identityFromAuth(s.authData);const c=(key&&s.realmStores?.[key]?.resourceCatalog)||s.resourceCatalog||{};add(c.resourceImages);add(c.constantsResources);add(c.resourceNames);}catch{}
  return ids;
}
// RESOURCE_IMAGE_RESULT is accepted only as the answer to a PAGE_RESOURCE_IMAGE ask (GET_RESOURCE_IMAGE) made in the
// last RESOURCE_IMAGE_PAGE_ASK_MS for that id; one answer per ask.
const RESOURCE_IMAGE_PAGE_ASK_MS=30000,resourceImagePageAsks=new Map();
// skip(): checked when this read's turn comes (a batch whose game tab turned out not ready stops its queued reads).
function pageImageGet(safeUrl,skip=null){
  let read=false;
  const run=resourceImagePageChain.then(()=>{const why=skip?.();if(why){const e=new Error(why);e.bridgeNotReady=true;throw e;}read=true;return pageImageGetOnce(safeUrl);});
  resourceImagePageChain=run.catch(()=>{}).then(()=>read?new Promise(r=>setTimeout(r,RESOURCE_IMAGE_PAGE_GAP_MS)):null);
  return run;
}
async function pageImageGetOnce(safeUrl){
  const ok=safeResourceImageUrl(safeUrl);if(!ok)throw new Error('Image address is not on the game image path; not fetched.');
  const path=new URL(ok).pathname;
  const tab=await simTab();
  if(!tab?.id){const e=new Error('No Sim Companies tab open.');e.noGameTab=true;throw e;}
  if(!(await waitForBridge(tab.id,3000))){const e=new Error('Sim Companies page bridge is not ready.');e.bridgeNotReady=true;throw e;}
  let r;
  try{r=await Promise.race([chrome.tabs.sendMessage(tab.id,{type:'PAGE_IMAGE_GET',path,timeoutMs:RESOURCE_IMAGE_PAGE_TIMEOUT_MS}),new Promise((_,rej)=>setTimeout(()=>rej(new Error('Game tab image read timed out.')),RESOURCE_IMAGE_PAGE_TIMEOUT_MS+PAGE_GET_BACKGROUND_GRACE_MS))]);}
  catch(e){if(pageMessageChannelClosed(e)){const x=new Error(e?.message||String(e));x.pageClosed=true;throw x;}throw e;}
  if(r?.pageClosed){const x=new Error(r.error||'The game page was reloaded or closed.');x.pageClosed=true;throw x;}
  if(!r?.ok)throw new Error(r?.error||`Image HTTP ${r?.status||0}`);
  const m=String(r.dataUrl||'').match(/^data:(image\/[a-z0-9.+-]+);base64,/i);
  if(!m)throw new Error('Game tab answer was not an image.');
  const p=resourceImageDataUrlParts(r.dataUrl);
  if(!p)throw new Error(RESOURCE_IMAGE_MIME_RE.test(m[1].toLowerCase())?'Game tab image is too large or not base64.':`Image type not allowed (${m[1].toLowerCase()}).`);
  const bin=atob(p.b64);if(bin.length>RESOURCE_IMAGE_MAX_BYTES)throw new Error('Game tab image is too large.');
  const bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
  return {mime:p.mime,bytes};
}
async function fetchAndCacheResourceImage(id,{forceValidate=false,batch=null}={}){
  const n=validResourceId(id); if(n==null) return {ok:false,error:'Invalid resource id'};
  const {cache,meta,key}=batch?.base||await migrateResourceImageCache();
  if(!key) return {ok:false,error:'No active realm for resource image cache'};
  const sid=String(n), previous=meta[sid]||{};
  const now=Date.now();
  if(cache[sid] && !forceValidate && previous.validatedAt && now-Date.parse(previous.validatedAt)<RESOURCE_IMAGE_CACHE_TTL_MS){
    return {ok:true,dataUrl:cache[sid],cached:true,validatedAt:previous.validatedAt,changed:false};
  }
  const manifest=await resourceImageManifest();
  let catalog=batch?.catalog, captured=batch?.captured, fromConstants=batch?.constantsImages;
  if(!catalog||!captured){const stateNow=await state();const store=stateNow.realmStores?.[key]||{};catalog=catalog||store.resourceCatalog||stateNow.resourceCatalog||{};captured=captured||capturedResourceImages(store);}
  if(!fromConstants)fromConstants=await constantsResourceImages();
  const catalogImage=catalog?.resourceImages?.[sid] || catalog?.constantsResources?.[sid]?.image || null;
  const filename=manifest?.resources?.[sid];
  const guessKnown404=Boolean(filename&&RESOURCE_IMAGE_KNOWN_404_FILENAMES.has(String(filename).split('?')[0].toLowerCase()));
  const rawUrl=catalogImage || captured?.[sid] || fromConstants?.[sid] || previous.url || (filename&&!guessKnown404 ? `${String(manifest.baseUrl||'https://www.simcompanies.com/static/images/resources/').replace(/\/$/,'')}/${filename}` : null);
  if(!rawUrl) return cache[sid]?{ok:true,dataUrl:cache[sid],cached:true,changed:false}:guessKnown404?{ok:false,unavailable:true,error:'No game image path known yet (the bundled file name is not on the game server).'}:{ok:false,error:'No resource image source is known.'};
  const url=/^https?:\/\//i.test(String(rawUrl))?String(rawUrl):`https://www.simcompanies.com/static/${String(rawUrl).replace(/^\/+/, '')}`;
  const safeUrl=safeResourceImageUrl(url);
  if(!safeUrl) return cache[sid]?{ok:true,dataUrl:cache[sid],cached:true,changed:false}:{ok:false,unavailable:true,error:'Image address is not on the game image path; not fetched.'};
  try{
    let mime=null,bytes=null,workerError=batch?.workerError||null;
    // Worker fetch first (still works where Cloudflare lets it through). In a batch, a 403/503/network error stops
    // the worker fetch for the rest of the run, so ~150 blocked requests are not repeated.
    if(!batch?.workerError){
      try{
        if(batch?.pace)await batch.pace();
        const r=await fetch(safeUrl,{cache:'no-store',credentials:'omit'}).finally(()=>{if(batch)batch.lastFetchAt=Date.now();});
        if(!r.ok){const he=new Error(`Image HTTP ${r.status}`);he.status=r.status;throw he;}
        mime=(r.headers.get('content-type')||'image/png').split(';')[0].trim().toLowerCase();
        if(!RESOURCE_IMAGE_MIME_RE.test(mime))throw Object.assign(new Error(`Image type not allowed (${mime}).`),{status:r.status});
        const len=Number(r.headers.get('content-length'));if(Number.isFinite(len)&&len>RESOURCE_IMAGE_MAX_BYTES)throw Object.assign(new Error('Image too large.'),{status:r.status});
        const got=new Uint8Array(await r.arrayBuffer());if(got.length>RESOURCE_IMAGE_MAX_BYTES)throw Object.assign(new Error('Image too large.'),{status:r.status});
        bytes=got;
      }catch(we){workerError=we?.message||String(we);if(batch&&(!we?.status||we.status===403||we.status===503))batch.workerError=workerError;}
    }
    if(!bytes){
      // Through the game tab. No tab / bridge not ready / page closed: the rest of the batch does not wait on it again.
      if(batch?.pageError)throw new Error(`${workerError}; game tab: ${batch.pageError}`);
      try{if(batch?.pace)await batch.pace();const p=await pageImageGet(safeUrl,batch?()=>batch.pageError:null).finally(()=>{if(batch)batch.lastFetchAt=Date.now();});mime=p.mime;bytes=p.bytes;}
      catch(pe){const t=pe?.message||String(pe);if(batch&&pageBridgeUnavailable(pe))batch.pageError=t;throw new Error(`${workerError}; game tab: ${t}`);}
    }
    const hash=await sha256Bytes(bytes);
    const changed=Boolean(cache[sid]&&previous.sha256&&previous.sha256!==hash);
    const dataUrl=bytesToDataUrl(bytes,mime);
    const validatedAt=new Date(now).toISOString();
    const sameImage=Boolean(cache[sid]&&previous.sha256===hash);
    const metaNext={url:safeUrl,filename,sha256:hash,validatedAt,updatedAt:changed||!previous.sha256?validatedAt:(previous.updatedAt||validatedAt),status:'verified'};
    // unchanged image: only the small meta entry is updated (no 2 MB rewrite of the image data)
    if(batch){if(!sameImage)batch.cache[sid]=dataUrl;batch.meta[sid]=metaNext;}
    else await saveResourceImages(sameImage?{}:{[sid]:dataUrl},{[sid]:metaNext});
    return {ok:true,dataUrl,cached:false,changed,validatedAt,url:safeUrl};
  }catch(e){
    if(cache[sid]) return {ok:true,dataUrl:cache[sid],cached:true,stale:true,error:e?.message||String(e)};
    return {ok:false,error:e?.message||String(e)};
  }
}
// onInstalled (an update, or a Chrome update) and onStartup can both fire as the browser starts: one run at a time,
// and a non-forced run within 10 min of the last one is not repeated (it would only re-try the same images).
// A run that could not reach the game tab (no tab / bridge not ready) or had no realm yet does not start that gap.
const RESOURCE_IMAGE_SYNC_REPEAT_GAP_MS=10*60000,RESOURCE_IMAGE_VALIDATE_EVERY_MS=6.5*24*3600e3;
// The 10-min gap stamp is mirrored to chrome.storage.session (scmGateStamps 'resourceImageSync') so a worker restart
// does not start a new run of ~150 image reads at once.
let resourceImageSyncRun=null,resourceImageSyncRunForced=false,resourceImageSyncLastAt=0,resourceImageSyncGateCheck=null;
function syncAllResourceImages({forceValidate=false,trigger=null}={}){
  // The weekly forced validation that meets a running startup run waits for it, then validates.
  if(resourceImageSyncRun)return forceValidate&&!resourceImageSyncRunForced?resourceImageSyncRun.catch(()=>null).then(()=>syncAllResourceImages({forceValidate:true,trigger})):resourceImageSyncRun;
  const stamp=()=>{resourceImageSyncLastAt=Date.now();scmGateStampSet('resourceImageSync',resourceImageSyncLastAt);};
  const start=()=>{
    resourceImageSyncRunForced=Boolean(forceValidate);
    resourceImageSyncRun=syncAllResourceImagesOnce({forceValidate,trigger})
      .then(r=>{if(!r?.skipped)stamp();return r;},e=>{stamp();throw e;})
      .finally(()=>{resourceImageSyncRun=null;});
    return resourceImageSyncRun;
  };
  if(forceValidate)return start();
  if(Date.now()-resourceImageSyncLastAt<RESOURCE_IMAGE_SYNC_REPEAT_GAP_MS)return Promise.resolve({ok:true,skipped:true,reason:'recent-run'});
  if(resourceImageSyncGateCheck)return resourceImageSyncGateCheck;
  const check=(async()=>{
    const saved=Number(await scmGateStampGet('resourceImageSync'))||0;if(saved>resourceImageSyncLastAt)resourceImageSyncLastAt=saved;
    if(resourceImageSyncRun)return resourceImageSyncRun;
    if(Date.now()-resourceImageSyncLastAt<RESOURCE_IMAGE_SYNC_REPEAT_GAP_MS)return {ok:true,skipped:true,reason:'recent-run'};
    return start();
  })().finally(()=>{if(resourceImageSyncGateCheck===check)resourceImageSyncGateCheck=null;});
  resourceImageSyncGateCheck=check;
  return check;
}
async function syncAllResourceImagesOnce({forceValidate=false,trigger=null}={}){
  const RESOURCE_IMAGE_FETCH_GAP_MS=3000,RESOURCE_IMAGE_MAX_FETCHES_PER_RUN=20;
  // Ids whose image is missing, has no check time, or was checked ttlMs or longer ago.
  const resourceImagesDue=(ids,cache,meta,ttlMs,now)=>ids.filter(id=>{const sid=String(id);if(!cache?.[sid])return true;const t=Date.parse(String(meta?.[sid]?.validatedAt||''));return !Number.isFinite(t)||now-t>=ttlMs;});
  // Timer off: no image request (a "not read" line once per 30 min). During a Sync: not started (not a run).
  if(await scmSwitchedOff('resourceImages','resource-images',null,trigger||'manager'))return {ok:true,skipped:true,reason:'switched-off'};
  if(coreSyncActive())return {ok:true,skipped:true,reason:'sync'};
  const jobStarted=Date.now(),jobStartedAt=new Date(jobStarted).toISOString();
  const manifest=await resourceImageManifest();
  const ids=Object.keys(manifest?.resources||{}).map(Number).filter(Number.isFinite);
  let updated=0,verified=0,failed=0,unavailable=0,stale=0,firstError=null;
  // One state read and ONE image write for the whole run.
  const base=await migrateResourceImageCache();
  // Before the first Sync there is no realm to file the cache under: nothing is tried (not a run).
  if(!base?.key)return {ok:false,skipped:true,reason:'no-realm',error:'No active realm for resource image cache'};
  const s0=await state();const catalog=(base.key&&s0.realmStores?.[base.key]?.resourceCatalog)||s0.resourceCatalog||{};
  const batch={base,catalog,captured:capturedResourceImages(base.key&&s0.realmStores?.[base.key]),constantsImages:await constantsResourceImages(),cache:{},meta:{},workerError:null,pageError:null};
  // 2.5.458: never a burst. Only images missing from the cache or older than the TTL (forced weekly check: older than
  // RESOURCE_IMAGE_VALIDATE_EVERY_MS) are read, ONE at a time, at least RESOURCE_IMAGE_FETCH_GAP_MS from the end of one request to the start of the next
  // (batch.pace), at most RESOURCE_IMAGE_MAX_FETCHES_PER_RUN requests per run; the rest wait for the next run. Stops
  // when a Sync starts. The 403/503 stop of the worker fetch (batch.workerError) is unchanged.
  const ttl=forceValidate?RESOURCE_IMAGE_VALIDATE_EVERY_MS:RESOURCE_IMAGE_CACHE_TTL_MS,nowMs=Date.now();
  const due=resourceImagesDue(ids,base.cache,base.meta,ttl,nowMs);verified+=ids.length-due.length;
  batch.fetches=0;batch.lastFetchAt=0;batch.pace=async()=>{const w=batch.lastFetchAt+RESOURCE_IMAGE_FETCH_GAP_MS-Date.now();if(batch.lastFetchAt&&w>0)await new Promise(r=>setTimeout(r,w));batch.lastFetchAt=Date.now();batch.fetches++;};
  let left=0;
  for(let i=0;i<due.length;i++){
    if(batch.fetches>=RESOURCE_IMAGE_MAX_FETCHES_PER_RUN||coreSyncActive()){left=due.length-i;break;}
    const r=await fetchAndCacheResourceImage(due[i],{forceValidate:true,batch});
    if(r.ok){verified++;if(r.changed||!r.cached)updated++;if(r.stale){stale++;if(!firstError)firstError=r.error||null;}}
    else if(r.unavailable)unavailable++;else{failed++;if(!firstError)firstError=r.error||null;}
  }
  await saveResourceImages(batch.cache,batch.meta);
  const s=await state(); const key=s.activeRealmKey||identityFromAuth(s.authData); const realm=realmNumberFromKey(key); if(realm!=null){
    await withRealmWriteLock(realm,async()=>{
      const latest=await state(realm); const stores={...(latest.realmStores||{})}; const store={...(stores[key]||{})};
      const status={lastRunAt:new Date().toISOString(),forceValidate,resourceCount:ids.length,verified,updated,failed,stale,unavailable};
      store.resourceImageCacheStatus=status; stores[key]=store;
      const patch={realmStores:stores}; if(key===latest.activeRealmKey) patch.resourceImageCacheStatus=status;
      await storageSet(patch);
    });
  }
  // scmResourceImagesValidatedAt (the weekly validation clock) is stamped only after a clean run: nothing failed and
  // nothing was only kept stale from the cache. With failures it stays as it was, so the next Sync / game tab retries.
  const clean=failed===0&&stale===0&&verified>0&&left===0;
  if(clean){try{const v=Number((await chrome.storage.local.get({scmResourceImagesValidatedAt:0})).scmResourceImagesValidatedAt)||0;
    if(forceValidate||Date.now()-v>RESOURCE_IMAGE_VALIDATE_EVERY_MS)await rawStorageSet({scmResourceImagesValidatedAt:Date.now()});}catch{}}
  const bad=failed+stale;
  const errorText=bad?capRefreshError(`${[failed?`${failed} resource image(s) failed`:'',stale?`${stale} kept from cache (could not re-check)`:''].filter(Boolean).join(', ')}. First error: ${firstError||'unknown'}`):null;
  // The game tab could not be asked (no tab / bridge not ready / page closed): a skipped run, not the 10-min gap.
  const tabSkipped=Boolean(batch.pageError)&&bad>0;
  const outcome=tabSkipped?'skipped':bad?(verified-stale>0?'partial':'failure'):'success';
  const finishedAt=new Date().toISOString();
  const event={job:'resource-image-cache-sync',trigger:trigger||(forceValidate?'forced-validation':'startup-or-install'),startedAt:jobStartedAt,finishedAt,durationMs:Date.now()-jobStarted,outcome,requested:ids.length,fetched:updated,refreshed:updated,checked:verified,cached:Math.max(0,verified-updated),stale,error:errorText,details:{resourceCount:ids.length,verified,updated,failed,stale,unavailable,forceValidate,firstError:firstError?capRefreshError(firstError):null,workerError:batch.workerError?capRefreshError(batch.workerError):null,gameTabError:batch.pageError?capRefreshError(batch.pageError):null}};
  if(realm!=null) await recordBackgroundJobEvent(realm,event).catch(()=>{});
  else if(bad&&!tabSkipped) logError('resource-image-cache-sync',errorText);
  return {ok:true,skipped:tabSkipped||undefined,reason:tabSkipped?'game-tab-not-ready':undefined,resourceCount:ids.length,due:due.length,left,fetches:batch.fetches,verified,updated,failed,stale,unavailable,firstError,clean,durationMs:Date.now()-jobStarted};
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
// The lost-data check (unattended): each contract path is one lane read (job 'lostData:<realm>'), one per slot; a path
// read in the last 30 min is not read again, so successive slots move on to the next path.
const lostDataReadAt=new Map();
async function refreshContractsScheduled(reason='critical-data-guard',realmArg=null){
  const realm=validRealmNumber(realmArg); if(realm==null)return {ok:false,error:'Invalid realm.'};
  const results=[];const lane=`lostData:${realm}`;
  for(const path of realmContractPaths(realm)){
    const k=`${realm}|${path}`;if(Date.now()-(lostDataReadAt.get(k)||0)<30*60000)continue;
    try{const r=await pageGet(path,realm,null,'lost-data-check',{lane});
      if(r?.laneWait){results.push({path,ok:false,skipped:true,laneWait:true,status:0});logLaneWait(realm,'lost-data-check',r.nextAt,{},Date.now(),reason);break;}
      
      lostDataReadAt.set(k,Date.now());
      // Other realm / realm not shown yet: a "not read" line (flow unchanged: stamped, the next path goes on).
      if(!r?.ok&&(r?.realmMismatch||r?.realmUnknown)){results.push({path,ok:false,skipped:true,status:0});logNotRead(realm,'lost-data-check',r,{},Date.now(),reason);continue;}
      const ok=!!r?.ok&&!endpointResponseRejected(path,r); results.push({path,ok,status:Number(r?.status)||0}); if(ok)await saveData(path,r.data,r.status,'GET',realm);}
    catch(e){if(pageBridgeUnavailable(e)){results.push({path,ok:false,skipped:true,bridgeUnavailable:true,status:0});logNotRead(realm,'lost-data-check',e,{},Date.now(),reason);break;}results.push({path,ok:false,status:0,error:e?.message||String(e)});}
  }
  // Real failed reads (not the waiting / not-read ones above): one failure line.
  {const bad=results.filter(x=>!x.ok&&!x.skipped);if(bad.length)logActivity(realm,'lost-data-check','failure',{rows:results.filter(x=>x.ok).length,wanted:results.length},bad.map(x=>`${x.path.replace('/api/','')}: ${x.error||'HTTP '+x.status}`).slice(0,3).join(' · '),Date.now(),reason);}
  const s=await state(realm); const key=realmKeyFromRealm(realm); const count=criticalContractRowsFromStore(s.realmStores?.[key]||{}).length;
  return {ok:results.every(x=>x.ok)&&count>0,realm,reason,results,count};
}
const CRITICAL_DATA_GUARD_ALARM='scm-critical-data-guard';
async function ensureCriticalDataGuard(reason='ensure'){try{const created=await scmEnsureTimerAlarm('criticalGuard',{delayInMinutes:10,periodInMinutes:10},'always');return {ok:true,reason,...(created?{}:{disabled:true})};}catch(e){return {ok:false,error:e?.message||String(e)}}}
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

const INSTALL_KEEP_ALARM_PREFIXES=['scm-prodfin:','scm-followup:','scm-daily-summary',GAME_CONSTANTS_ALARM,ACCOUNTING_WEEK_REFRESH_ALARM_PREFIX,ACCOUNTING_DAY_WALK_ALARM_PREFIX,ACCOUNTING_DAY_REWALK_ALARM_PREFIX,ACCOUNTING_WALK_DAILY_ALARM,SYNC_AUTO_RETRY_ALARM_PREFIX];
const FOLLOWUP_ALARMS_KEY='scmFollowupAlarms';
// Follow-ups exist only as alarms (their whole state is in the name), so they are also listed in storage to survive a
// lost alarm. Serialized through the commit lane; removed as they fire.
function createFollowupAlarm(name,when,clearGen=extensionClearGeneration){
  return withRealmStorageCommit(async()=>{
    if(clearGen!==extensionClearGeneration)return; // started before Clear Stored Data: must not bring anything back
    const cur=(await chrome.storage.local.get({[FOLLOWUP_ALARMS_KEY]:{}}))[FOLLOWUP_ALARMS_KEY]||{};
    await rawStorageSet({[FOLLOWUP_ALARMS_KEY]:{...cur,[name]:when}});
    await scmAlarmCreate(name,{when});
  });
}
function forgetFollowupAlarm(name){
  return withRealmStorageCommit(async()=>{
    const cur=(await chrome.storage.local.get({[FOLLOWUP_ALARMS_KEY]:{}}))[FOLLOWUP_ALARMS_KEY]||{};
    if(!(name in cur))return;
    const next={...cur};delete next[name];
    await rawStorageSet({[FOLLOWUP_ALARMS_KEY]:next});
  });
}
// Periodic jobs both onInstalled and onStartup must leave in place. Created only when missing, so a browser start does not push them back.
// [alarm, info while the Sync timers setting is at its default, timer id]. A timer switched off is not created.
const STANDING_ALARMS=[
  ['scm-resource-image-validation',{delayInMinutes:1,periodInMinutes:10080},'resourceImages'],
  ['scm-storage-prune',{delayInMinutes:30,periodInMinutes:1440},'storagePrune'],
];
// Alarms older versions created and nothing handles any more (the production-events page scan, removed in 2.5.461:
// events come from the game's production-modifiers response, SimcoTools as fallback). Cleared on every install /
// startup so browsers that still hold them drop them; a firing one is cleared too.
const OBSOLETE_ALARMS=['scm-production-events-daily','scm-production-events-watch'];
async function clearObsoleteAlarms(){for(const n of OBSOLETE_ALARMS){try{await chrome.alarms.clear(n);}catch{}}}
async function ensureStandingAlarms({simcoPublic=true}={}){
  await clearObsoleteAlarms();
  for(const [,info,id] of STANDING_ALARMS)await scmEnsureTimerAlarm(id,info,'missing');
  await scmEnsureTimerAlarm('gameConstants',{delayInMinutes:1,periodInMinutes:360},'missing'); // GAME_CONSTANTS_ALARM
  // scm-simco-public (no timer id: it stays registered with the timer off, as the self-test "Background alarms" row
  // expects): re-created when missing at every start that runs this. simcoPublic:false when the caller places it itself
  // after re-creating the live-market alarm (clear data), so it keeps its 2.5 min offset.
  if(simcoPublic&&typeof ensureSimcoPublicAlarm==='function')await ensureSimcoPublicAlarm();
}
// Chrome drops an extension's alarms when it is updated (and may on a browser restart), so the alarms that
// carry your state are re-created from storage: follow-ups, the daily summary, batch-finished alerts (from the stored
// buildings) and pending Accounting walks. Storage reads + alarm calls only, no network, no lock.
async function restorePersistedAlarms(reason='restore'){
  const out={reason,production:[],followups:0};
  try{
    const fu=(await chrome.storage.local.get({[FOLLOWUP_ALARMS_KEY]:{}}))[FOLLOWUP_ALARMS_KEY]||{};
    for(const [name,when] of Object.entries(fu)){
      if(await chrome.alarms.get(name))continue;
      // Already due while the browser was closed: run it shortly instead of dropping it.
      await scmAlarmCreate(name,{when:Math.max(Number(when)||0,Date.now()+60000)});out.followups++;
    }
  }catch(e){out.error=e?.message||String(e);logError('alarms:restore',e);}
  try{if(!(await chrome.alarms.get('scm-daily-summary')))await scheduleDailySummary();}catch(e){out.error=e?.message||String(e);}
  for(const n of [0,1]){
    try{
      const st=(await chrome.storage.local.get({[`scmRealmStore:${n}`]:null}))[`scmRealmStore:${n}`]||{};
      if(Array.isArray(st.buildings)&&st.buildings.length)out.production.push(await scheduleProductionFinishAlarms(n,st.buildings));
      // A scheduled / interrupted Accounting day walk survives an update or restart.
      const walk=st.accountingDayWalkStatus;
      if(walk&&(walk.status==='scheduled'||walk.status==='running')){const name=`${ACCOUNTING_DAY_WALK_ALARM_PREFIX}${n}`;if(!(await chrome.alarms.get(name))){await scmAlarmCreate(name,{when:Date.now()+15000});out.accountingDayWalk=(out.accountingDayWalk||0)+1;}}
      // A pending re-walk of the missing days keeps its time (at least 1 min from now).
      if(walk?.status==='partial'&&walk.rewalk?.pending){const name=`${ACCOUNTING_DAY_REWALK_ALARM_PREFIX}${n}`;if(!(await chrome.alarms.get(name))){await scmAlarmCreate(name,{when:Math.max(Date.parse(walk.rewalk.at)||0,Date.now()+60000)});out.accountingDayRewalk=(out.accountingDayRewalk||0)+1;}}
      // The current-week ledger refresh that was waiting or retrying has the same problem.
      const ledger=st.accountingWeekLedgerStatus?.status;
      if(ledger==='scheduled'||ledger==='retrying'||ledger==='running'){const name=accountingWeekRefreshAlarmName(n);if(name&&!(await chrome.alarms.get(name))){await scmAlarmCreate(name,{when:Date.now()+20000});out.accountingWeekLedger=(out.accountingWeekLedger||0)+1;}}
    }catch(e){out.error=e?.message||String(e);}
  }
  return out;
}
// Storage retention: 90 days. One pass over the time-series families; every
// rule and what reads each family is in storage-core.js. Each standalone key is
// pruned inside its own writer queue (no lost appends) and the realm-store fields under the realm storage queue.
// Only keys that changed are written. Settings, tokens, snapshots, alarms, saved contracts and planner state are
// never read here. Safe to run any number of times; a corrupt value is left as it is.
const STORAGE_PRUNE_DAYS=90;
let scmPruneRunning=null;
async function scmStorageBytes(){try{return await chrome.storage.local.getBytesInUse(null);}catch{return null;}}
async function scmStorageTopKeys(n=8){
  const SC=globalThis.SCM_STORAGE_CORE;const sizes={};
  let keys=null;try{if(typeof chrome.storage.local.getKeys==='function')keys=await chrome.storage.local.getKeys();}catch{}
  if(Array.isArray(keys)){for(const k of keys){try{sizes[k]=await chrome.storage.local.getBytesInUse(k);}catch{}}}
  else{const all=await chrome.storage.local.get(null);for(const [k,v] of Object.entries(all||{}))sizes[k]=SC.approxBytes(v)+k.length;}
  return SC.topKeys(sizes,n);
}
// Largest top-level fields inside the biggest realm store (names + sizes only, never values).
async function scmRealmStoreTopFields(n=6){
  const SC=globalThis.SCM_STORAGE_CORE;const all=await chrome.storage.local.get(null);let best=null;
  for(const [k,v] of Object.entries(all||{}))if(/^scmRealmStore:\d+$/.test(k)&&v&&typeof v==='object'){const b=SC.approxBytes(v);if(!best||b>best.b)best={k,v,b};}
  if(!best)return null;const sizes={};for(const [f,v] of Object.entries(best.v))sizes[f]=SC.approxBytes(v);
  // endpointData grouped by path pattern (numbers → :n), sizes only.
  const groups={};const ed=best.v.endpointData&&typeof best.v.endpointData==='object'?best.v.endpointData:{};
  for(const [u,v] of Object.entries(ed)){const g=String(u).replace(/[?#].*$/,'').replace(/\/\d+(?=\/|$)/g,'/:n').slice(0,80);const e=groups[g]||(groups[g]={bytes:0,count:0});e.bytes+=SC.approxBytes(v);e.count++;}
  const endpointGroups=Object.entries(groups).sort((a,b)=>b[1].bytes-a[1].bytes).slice(0,8).map(([path,e])=>({path,bytes:e.bytes,count:e.count}));
  return {key:best.k,top:SC.topKeys(sizes,n),endpointGroups};
}
// Old production rate data (rates in plans, the frozen network plan, reference-rate snapshots;
// SCM_STORAGE_CORE.withoutProductionRateData), dropped under the realm write lock. Writes only when some is left, so
// after the first run it is a read. The frozen plan's planner UI state is kept when no planner state is stored.
async function migrateProductionRateData(realm){
  const n=validRealmNumber(realm);if(n==null)return 0;
  const SC=globalThis.SCM_STORAGE_CORE,key=realmKeyFromRealm(n),plannerKey=productionPlannerStateStorageKey(n);
  return withRealmWriteLock(n,async()=>{
    const s=await state(n);const stores={...(s.realmStores||{})};
    const r=SC.withoutProductionRateData(stores[key]);
    if(!r.removed)return 0;
    if(r.plannerState&&plannerKey&&!s.productionPlannerState){const planner=sanitizeProductionPlannerState(r.plannerState,n);if(planner)await rawStorageSet({[plannerKey]:planner});}
    stores[key]=r.value;
    await storageSet({realmStores:stores});
    return r.removed;
  });
}
async function scmPruneStorage({days=STORAGE_PRUNE_DAYS,reason='manual'}={}){
  if(scmPruneRunning)return scmPruneRunning;
  scmPruneRunning=(async()=>{
    const SC=globalThis.SCM_STORAGE_CORE;const now=Date.now();const removed={};const written=[];
    const add=(r)=>{for(const [k,v] of Object.entries(r||{}))removed[k]=(removed[k]||0)+v;};
    const before=await scmStorageBytes();
    const pruneKey=async(key,plan)=>{const got=await chrome.storage.local.get({[key]:null});const r=plan(got);if(r&&Object.keys(r.patch).length){await rawStorageSet(r.patch);written.push(...Object.keys(r.patch));add(r.removed);}};
    for(const n of [0,1]){
      const one=key=>got=>{const r=SC.planRealmKeys(n,got,now,days);return {patch:r.patch[key]!==undefined?{[key]:r.patch[key]}:{},removed:Object.fromEntries(Object.entries(r.removed).filter(([f])=>key.startsWith(f+':')))};};
      const chain=(map,key)=>{const run=(map.get(n)||Promise.resolve()).then(()=>pruneKey(key,one(key)));map.set(n,run.catch(()=>{}));return run;};
      try{await chain(productionCostQueues,`scmProductionCostHistory:${n}`);}catch(e){logError('prune:pch',e);}
      try{await chain(statementHistoryQueues,`scmStatementHistory:${n}`);}catch(e){logError('prune:statements',e);}
      try{await chain(backgroundJobQueues,`scmBackgroundJobs:${n}`);}catch(e){logError('prune:jobs',e);}
      try{priceLogQueue=priceLogQueue.then(()=>pruneKey(`scmPriceLog:${n}`,one(`scmPriceLog:${n}`))).catch(e=>logError('prune:pricelog',e));await priceLogQueue;}catch{}
    }
    // Realm-store fields: under the realm storage queue, never during a Sync (it holds the store).
    if(coreSyncActive())deferUntilSyncEnds('storage-prune-realm',()=>{scmPruneStorage({days,reason:'after-sync'}).catch(()=>{});});
    else for(const n of [0,1]){
      try{
        const r=await enqueueApiStorage(async()=>{
          // Fields older versions left in the store (SCM_STORAGE_CORE.OBSOLETE_REALM_FIELDS); nothing reads them.
          const k=realmStorageKey(n);
          const dropped=await withRealmStorageCommit(async()=>{const cur=(await chrome.storage.local.get({[k]:null}))[k];const o=SC.withoutObsoleteRealmFields(cur);if(o.removed)await rawStorageSet({[k]:o.value});return o.removed;});
          if(dropped){written.push(k);add({obsoleteRealmFields:dropped});}
          const raw=(await chrome.storage.local.get({[realmStorageKey(n)]:null}))[realmStorageKey(n)];
          const plan=SC.planRealmStore(raw,now,days);
          if(!Object.keys(plan.patch).length)return plan;
          await storageSetRealmPatch(n,plan.patch);return plan;
        },n,{priority:true});
        if(r&&Object.keys(r.patch||{}).length){await flushRealmPatches(n);written.push(realmStorageKey(n));add(r.removed);}
      }catch(e){logError('prune:realm-store',e);}
    }
    if(!coreSyncActive())for(const n of [0,1]){
      try{const dropped=await migrateProductionRateData(n);if(dropped){written.push(realmStorageKey(n));add({productionRateData:dropped});}}catch(e){logError('prune:production-rate-data',e);}
    }
    // Keys older versions wrote and nothing reads any more (SCM_STORAGE_CORE.OBSOLETE_KEYS).
    try{const present=Object.keys(await chrome.storage.local.get(SC.OBSOLETE_KEYS));if(present.length){await chrome.storage.local.remove(present);written.push(...present);add({obsoleteKeys:present.length});}}catch(e){logError('prune:obsolete-keys',e);}
    // Error log: flush the in-memory buffer first, then trim it in place so a later debounced write keeps the trim.
    try{const log=await getErrorLog();const r=SC.planGlobal({scmErrorLog:log},now,days);if(r.patch.scmErrorLog){scmErrorLogBuffer=r.patch.scmErrorLog;await rawStorageSet(r.patch);written.push('scmErrorLog');add(r.removed);}}catch(e){logError('prune:error-log',e);}
    const after=await scmStorageBytes();
    const result={ok:true,reason,days,before,after,freed:before!=null&&after!=null?before-after:null,removed,written:[...new Set(written)],at:new Date(now).toISOString()};
    await rawStorageSet({scmStoragePruneLast:result}).catch(()=>{});
    return result;
  })().catch(e=>{logError('prune',e);return {ok:false,error:e?.message||String(e)};}).finally(()=>{scmPruneRunning=null;});
  return scmPruneRunning;
}
globalThis.scmPruneStorage=scmPruneStorage;
// Each lifecycle step is isolated: one failing step is logged and must not skip the rest.
async function scmLifecycleStep(label,fn){try{return await fn();}catch(e){logError(`lifecycle:${label}`,e);return undefined;}}
// Global keys onInstalled never reads or writes back. The realm keys are set by the game tab (activateRealmByRealmFast)
// and by Sync while this step runs; writing back an earlier read would null out (or roll back) the realm they just set.
// Every reader treats an absent selectedRealm/activeRealmKey as null, so a fresh install needs no default written.
const INSTALL_GLOBAL_PATCH_SKIP_KEYS=new Set(['realmStores','scmRealmStoreSchema','activeRealmKey','selectedRealm','realmSwitchHint']);
async function scmInstalledGlobalPatch(){
  // Targeted read of only the global keys we preserve (never storage.local.get(null)). Preserve existing physical realm
  // containers and global settings, but do not recreate the old root mirror for realm-owned caches.
  const keys=Object.keys(GLOBAL_DEFAULTS).filter(k=>!INSTALL_GLOBAL_PATCH_SKIP_KEYS.has(k));
  const current=await chrome.storage.local.get(keys);
  const globalPatch={};
  for(const key of keys){if(Object.prototype.hasOwnProperty.call(current,key)) globalPatch[key]=current[key];}
  if(Object.keys(globalPatch).length) await storageSet(globalPatch);
}
chrome.runtime.onInstalled.addListener(async(details)=>{
  // Fresh install: every server-contacting timer starts off, before any alarm or read below looks at the timers.
  if(details?.reason==='install')await scmLifecycleStep('installed:fresh-timers-off',()=>scmApplyFreshInstallTimers());
  await scmLifecycleStep('installed:global-patch',()=>scmInstalledGlobalPatch());
  await scmLifecycleStep('installed:drop-ticker-wants',()=>runMarketTickerRefresh());
  await scmLifecycleStep('installed:live-bridge-token',()=>migrateLiveBridgeToken());
  await scmLifecycleStep('installed:realm-migration',()=>ensureRealmStorageMigration());
  // Only the scheduler alarms re-created below (and retired legacy ones) are cleared; batch-finished alerts,
  // follow-ups, the daily summary, the constants refresh, Accounting walks and Sync retries survive an update.
  await scmLifecycleStep('installed:clear-alarms',async()=>{for(const a of await chrome.alarms.getAll()){if(!INSTALL_KEEP_ALARM_PREFIXES.some(p=>String(a?.name||'').startsWith(p)))await chrome.alarms.clear(a.name);}});
  await scmLifecycleStep('installed:live-market-alarm',()=>ensureLiveMarketRefreshAlarm('installed'));
  await scmLifecycleStep('installed:order-book-alarm',()=>ensureOrderBookRefreshAlarm());
  await scmLifecycleStep('installed:obsolete-alarms',()=>clearObsoleteAlarms());
  for(const [name,info,id] of STANDING_ALARMS)await scmLifecycleStep(`installed:alarm:${name}`,()=>scmEnsureTimerAlarm(id,info,'period'));
  // scm-simco-public is not in INSTALL_KEEP_ALARM_PREFIXES, so the clear above removed the copy the top-level call made;
  // re-created here, after the live-market alarm (it is placed 2.5 min after it).
  await scmLifecycleStep('installed:simco-public-alarm',()=>ensureSimcoPublicAlarm());
  await scmLifecycleStep('installed:critical-data-guard',()=>ensureCriticalDataGuard('installed'));
  await scmLifecycleStep('installed:storage-prune',()=>scmPruneStorage({reason:'installed'}));
  await scmLifecycleStep('installed:restore-alarms',()=>restorePersistedAlarms('installed'));
  await scmLifecycleStep('installed:accounting-walk',()=>ensureAccountingWalkSchedule('installed'));
  // An update restarts the worker too; a Sync interrupted by it must not stay "running" (jobs this worker started are skipped).
  await scmLifecycleStep('installed:recover-sync',()=>recoverInterruptedSyncJobs('installed'));
  syncAllResourceImages({forceValidate:false}).catch(()=>{});
  await scmLifecycleStep('installed:market-cycle',async()=>{
    const installRealmState=await state();
    const installRealm=validRealmNumber(installRealmState.activeRealmKey?.replace(/^realm:/,'')??installRealmState.selectedRealm??installRealmState.authData?.authCompany?.realmId);
    if(installRealm===0) await seedBundledVwapFallback('install-seed').catch(()=>{});
    if(installRealm!=null) scheduleMarketCycle(installRealm,'install-complete').catch(()=>{});
  });
});
chrome.runtime.onStartup.addListener(async()=>{
  await scmLifecycleStep('startup:live-bridge-token',()=>migrateLiveBridgeToken());
  await scmLifecycleStep('startup:drop-ticker-wants',()=>runMarketTickerRefresh());
  await scmLifecycleStep('startup:live-market-alarm',()=>ensureLiveMarketRefreshAlarm('service-worker-startup'));
  await scmLifecycleStep('startup:order-book-alarm',()=>ensureOrderBookRefreshAlarm());
  await scmLifecycleStep('startup:simco-public-alarm',()=>ensureSimcoPublicAlarm());
  await scmLifecycleStep('startup:standing-alarms',()=>ensureStandingAlarms());
  await scmLifecycleStep('startup:storage-prune',()=>scmPruneStorage({reason:'startup'}));
  await scmLifecycleStep('startup:restore-alarms',()=>restorePersistedAlarms('browser-startup'));
  await scmLifecycleStep('startup:accounting-walk',()=>ensureAccountingWalkSchedule('browser-startup'));
  await scmLifecycleStep('startup:recover-sync',()=>recoverInterruptedSyncJobs('service-worker-startup'));
  await scmLifecycleStep('startup:critical-data-guard',()=>ensureCriticalDataGuard('startup'));
  await scmLifecycleStep('startup:market-cycle',async()=>{
    const s=await chrome.storage.local.get({activeRealmKey:null,selectedRealm:null,authData:null});
    const realm=validRealmNumber(s.activeRealmKey?.replace(/^realm:/,'')??s.selectedRealm??s.authData?.authCompany?.realmId);
    if(realm===0) await seedBundledVwapFallback('startup-seed').catch(()=>{});
    if(realm!=null) await scheduleMarketCycle(realm,'startup-check');
  });
  syncAllResourceImages({forceValidate:false}).catch(()=>{});
});
chrome.alarms.onAlarm.addListener(async a=>{
  // Sync timers: an alarm that survived its timer being switched off is cleared, not run. (accountingWalk checks its own
  // schedule, the constants alarm its own listener.)
  const timerId=globalThis.SCM_TIMERS_CORE?.timerForAlarm(a?.name);
  if(timerId&&timerId!=='accountingWalk'&&timerId!=='gameConstants'&&!(await scmTimerEnabled(timerId).catch(()=>true))){await chrome.alarms.clear(a.name).catch(()=>{});return;}
  const syncRetryMatch=String(a?.name||'').match(/^scm-sync-retry-r([01])$/);
  if(syncRetryMatch){
    const realm=Number(syncRetryMatch[1]);
    if(coreSyncActive()){await scmAlarmCreate(a.name,{when:Date.now()+30000}).catch(()=>{});return;}
    syncAutoRetryRuns.add(realm);
    await syncNow(realm).catch(e=>logError('sync:auto-retry',e));
    syncAutoRetryRuns.delete(realm);
    return;
  }
  if(a?.name===ACCOUNTING_WALK_DAILY_ALARM){await runScheduledAccountingWalk('alarm').catch(e=>logError('alarm:accounting-walk',e));return;}
  const dayWalkMatch=String(a?.name||'').match(/^scm-accounting-day-walk-r([01])$/);
  if(dayWalkMatch){
    const realm=Number(dayWalkMatch[1]);
    if(syncSessionForRealm(realm)){await scmAlarmCreate(a.name,{when:Date.now()+5000}).catch(()=>{});return;}
    await runAccountingDayWalk(realm,'after-sync').catch(e=>logError('alarm:accounting-day-walk',e));
    return;
  }
  const dayRewalkMatch=String(a?.name||'').match(/^scm-accounting-day-rewalk-r([01])$/);
  if(dayRewalkMatch){
    const realm=Number(dayRewalkMatch[1]);
    if(syncSessionForRealm(realm)||accountingDayWalkRunning.has(realm)){await scmAlarmCreate(a.name,{when:Date.now()+60000}).catch(()=>{});return;}
    const gate=await accountingWalkIdleGate(a.name,realm).catch(()=>({run:true}));
    if(gate.exhausted){
      const st=(await state(realm)).realmStores?.[realmKeyFromRealm(realm)]?.accountingDayWalkStatus;
      if(st?.rewalk?.pending)await setAccountingDayWalkStatus(realm,{...st,rewalk:{...st.rewalk,pending:false,exhausted:true,idleTimeout:true}}).catch(()=>{});
      logActivity(realm,'accounting-day-walk','skipped',{},'Re-walk given up: the game tab was in use for 60 min.',Date.now(),'rewalk');
    }
    if(!gate.run)return;
    await runAccountingDayRewalk(realm).catch(e=>logError('alarm:accounting-day-rewalk',e));
    return;
  }
  const accountingWeekMatch=String(a?.name||'').match(/^scm-accounting-week-refresh-r([01])$/);
  if(accountingWeekMatch){
    const realm=Number(accountingWeekMatch[1]);
    try{
      if(syncSessionForRealm(realm)){
        const name=accountingWeekRefreshAlarmName(realm);
        if(name)await scmAlarmCreate(name,{when:Date.now()+5000});
        return;
      }
      await runAccountingWeekRefreshAlarm(realm).catch(e=>logError('alarm:accounting-week',e));
    }catch{}
    return;
  }
  const marketStageMatch=String(a?.name||'').match(/^scm-market-stage-r([01])-(vwap|prices)$/);
  if(marketStageMatch){await runMarketStage(Number(marketStageMatch[1]),marketStageMatch[2],'alarm').catch(e=>logError('alarm:market-stage',e));return;}
  if(a.name===LIVE_MARKET_REFRESH_ALARM_NAME){ await runScheduledLiveMarketRefresh('hourly-market-cycle').catch(()=>{}); return; }
  if(a.name===ORDER_BOOK_REFRESH_ALARM){ if(await scmOrderBookShouldThrottle())return; await runOrderBookRefreshFiring().catch(e=>logError('order-book-refresh',e)); return; }
  if(a.name===globalThis.SCM_TIMERS_CORE?.LANE?.ALARM){ await runGameLaneAlarm().catch(e=>logError('game-lane',e)); return; }
  if(a.name==='scm-storage-prune'){ await scmPruneStorage({reason:'daily-alarm'}).catch(()=>{}); return; }
  if(a.name===CRITICAL_DATA_GUARD_ALARM){ await runCriticalDataGuard('scheduled').catch(()=>{}); return; }
  if(OBSOLETE_ALARMS.includes(a.name)){ await chrome.alarms.clear(a.name).catch(()=>{}); return; }
  // The install/update handler re-creates this alarm 1 min after every update; re-validate at most once a week.
  if(a.name==='scm-resource-image-validation') (async()=>{const r=await chrome.storage.local.get({scmResourceImagesValidatedAt:0});if(Date.now()-Number(r.scmResourceImagesValidatedAt||0)<RESOURCE_IMAGE_VALIDATE_EVERY_MS)return;await syncAllResourceImages({forceValidate:true,trigger:'forced-validation'});/* the run stamps scmResourceImagesValidatedAt itself, clean runs only */})().catch(()=>{});
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
      if(r?.ready) return r; // truthy: callers test it; pageGet reads visible / online from it
    }catch{}
    // If the tab was already open before the extension loaded, inject the
    // isolated content script without reloading the game page. content.js is
    // idempotent and will inject page-hook.js only when needed.
    try{ await chrome.scripting.executeScript({target:{tabId},files:['timers-core.js','content.js']}); }catch{}
    await new Promise(r=>setTimeout(r,300));
  }
  return false;
}

// A page visit counts only when the game actually went there: the click landed on a real target and the address
// changed to it (or the tab was already on it). A click that moves nothing is a failed visit, never a silent ok.
const GAME_CLICK_NAV_CONFIRM_MS=1500;
function gamePageVisitOutcome(clicked,beforeUrl,afterUrl,hrefHints=[]){
  if(!clicked?.ok)return {...(clicked||{}),ok:false,navigated:false};
  const hints=(hrefHints||[]).map(h=>String(h||'').toLowerCase()).filter(Boolean);
  const path=u=>{try{const x=new URL(String(u));return (x.pathname+x.search).toLowerCase();}catch{return String(u||'').toLowerCase();}};
  const onHint=u=>hints.some(h=>path(u).includes(h));
  const navigated=Boolean(afterUrl)&&afterUrl!==beforeUrl;
  if(clicked.alreadyThere)return {...clicked,ok:true,navigated:false,urlAfterClick:afterUrl||beforeUrl};
  if(navigated&&(!hints.length||onHint(afterUrl)))return {...clicked,ok:true,navigated:true,urlAfterClick:afterUrl};
  if(navigated)return {...clicked,ok:false,navigated:true,urlAfterClick:afterUrl,error:`The click went to ${path(afterUrl)}, not the ${clicked.target||'requested'} page.`};
  return {...clicked,ok:false,navigated:false,urlAfterClick:afterUrl||beforeUrl,error:`The click did not change the page (${clicked.element?.tag||'element'}${clicked.element?.href?` ${clicked.element.href}`:''}).`};
}
async function gameTabUrl(tabId){
  try{
    const run=chrome.scripting.executeScript({target:{tabId},func:()=>String(location.href)}).then(r=>r?.[0]?.result||null,()=>null);
    const live=await Promise.race([run,new Promise(r=>setTimeout(()=>r(null),800))]);
    if(live)return live;
  }catch{}
  try{return (await chrome.tabs.get(tabId))?.url||null;}catch{return null;}
}
async function confirmGameNavigation(tabId,beforeUrl){
  const deadline=Date.now()+GAME_CLICK_NAV_CONFIRM_MS;
  let url=await gameTabUrl(tabId);
  while(Date.now()<deadline&&(!url||url===beforeUrl)){
    await new Promise(r=>setTimeout(r,100));
    url=await gameTabUrl(tabId);
  }
  return url;
}
async function executeGameClick(tabId,target,depth=0){
  const clicked=await executeGameClickRaw(tabId,target);
  if(clicked?.element)for(const k of ['text','href','aria','title'])if(clicked.element[k]!=null)clicked.element[k]=safeWalkText(clicked.element[k]);
  const after=clicked?.ok&&!clicked.alreadyThere?await confirmGameNavigation(tabId,clicked.beforeUrl):clicked?.urlAfterClick;
  const outcome=gamePageVisitOutcome({...clicked,target:target?.name},clicked?.beforeUrl,after,target?.hrefHints);
  // A label such as Headquarters can open the parent page first; the real link is on it.
  if(!outcome.ok&&outcome.navigated&&depth<1){const second=await executeGameClick(tabId,target,depth+1);return {...second,beforeUrl:clicked.beforeUrl};}
  return outcome;
}
// Remembers the page a player was on before Sync moved the tab and puts it back at the end of the run.
// walkUrl is where the walk last left the tab; a tab anywhere else was moved by the player, who is left alone.
const SYNC_RETURN_TIMEOUT_MS=6000;
const GAME_URL_RX=/^https:\/\/(?:www\.)?simcompanies\.com\//i;
function pageReturnDecision({startUrl,walkUrl,currentUrl}){
  if(!currentUrl)return 'tab-gone';
  if(!GAME_URL_RX.test(currentUrl))return 'off-game';
  if(!startUrl||!GAME_URL_RX.test(startUrl))return 'no-start-page';
  if(currentUrl===startUrl)return 'already-there';
  if(currentUrl!==walkUrl)return 'user-navigated';
  return 'restore';
}
async function spaNavigateGameTab(tabId,url){
  const run=chrome.scripting.executeScript({target:{tabId},func:async(to)=>{
    const dest=new URL(to,location.href);
    if(location.href===dest.href)return {ok:true,same:true,url:location.href};
    const wanted=dest.pathname+dest.search+dest.hash;
    const own=el=>Boolean(el?.closest?.('[id^="scm-"],[class*="scm-"]'));
    const link=[...document.querySelectorAll('a[href]')].find(a=>{try{const u=new URL(a.href);return u.origin===location.origin&&u.pathname+u.search+u.hash===wanted&&!own(a);}catch{return false;}});
    // The page must really react: a pushState alone changes the address even if the game ignores it.
    let rendered=false;
    const ob=new MutationObserver(list=>{if(list.some(m=>!own(m.target.nodeType===1?m.target:m.target.parentElement)))rendered=true;});
    ob.observe(document.body,{subtree:true,childList:true,characterData:true});
    if(link)link.click();
    else{history.pushState(null,'',dest.href);dispatchEvent(new PopStateEvent('popstate',{state:null}));}
    for(let i=0;i<30&&!(location.href===dest.href&&rendered);i++)await new Promise(r=>setTimeout(r,50));
    ob.disconnect();
    return {ok:location.href===dest.href&&rendered,via:link?'link':'history',rendered,url:location.href};
  },args:[url]}).then(r=>r?.[0]?.result||{ok:false,error:'No result from the game page.'},e=>({ok:false,error:e?.message||String(e)}));
  return Promise.race([run,new Promise(r=>setTimeout(()=>r({ok:false,error:'SPA navigation did not return.'}),2500))]);
}
// Same game page: path only, without query, hash or a trailing slash (relative paths resolve on the game origin).
function gameUrlSamePage(a,b){
  const k=u=>{try{const x=new URL(String(u||''),'https://www.simcompanies.com');return x.host.replace(/^www\./,'')+x.pathname.replace(/\/+$/,'');}catch{return String(u||'');}};
  return a!=null&&b!=null&&k(a)===k(b);
}
function pageReturnPendingKey(realm){return `scmSyncReturnPending:${realm}`;}
function createPageReturn(traceFn=null,{realm=null}={}){
  const tabs=new Map();
  const note=(type,payload)=>{try{traceFn?.(type,payload);}catch{}};
  const clearGen=extensionClearGeneration;
  let writes=Promise.resolve();
  // The record survives a worker restart, so the page can still be put back. Writes keep their order.
  const persist=()=>{
    if(realm==null)return writes;
    writes=writes.then(async()=>{
      if(clearGen!==extensionClearGeneration)return;
      await chrome.storage.local.set({[pageReturnPendingKey(realm)]:{at:Date.now(),realm,tabs:Object.fromEntries([...tabs].map(([id,e])=>[id,{startUrl:e.startUrl,walkUrl:e.walkUrl}]))}});
    }).catch(()=>{});
    return writes;
  };
  const api={
    tabs,
    forget(){if(realm==null)return writes;writes=writes.then(()=>chrome.storage.local.remove(pageReturnPendingKey(realm))).catch(()=>{});return writes;},
    async remember(tabId,seedUrl=null){
      if(tabId==null||tabs.has(tabId))return tabs.get(tabId)||null;
      const url=await gameTabUrl(tabId);
      const entry={startUrl:seedUrl||url,walkUrl:url,userMoved:false};
      tabs.set(tabId,entry);note('page-return-remembered',{tabId,startUrl:entry.startUrl});
      await persist();
      return entry;
    },
    // A player who moved during the run keeps that page: it becomes the place to return to, and walking stops.
    async checkUser(tabId){
      const e=await api.remember(tabId);if(!e)return false;
      const now=await gameTabUrl(tabId);
      if(now&&!gameUrlSamePage(now,e.walkUrl)&&GAME_URL_RX.test(now)){e.userMoved=true;e.startUrl=now;e.walkUrl=now;note('page-return-user-navigated',{tabId,url:now});await persist();}
      return e.userMoved;
    },
    // Once the player moved the tab, no walk step (page visit, bounce, fallback click, post-Sync tail) touches it again.
    async walkClick(tabId,target){
      if(await api.checkUser(tabId)){note('page-return-click-skipped',{tabId,target:target?.name||null});return {ok:false,skipped:'user-navigated',error:'The player moved the game tab; Sync leaves it there.'};}
      const r=await executeGameClick(tabId,target);
      const e=tabs.get(tabId);const now=r?.urlAfterClick||await gameTabUrl(tabId);
      if(e&&now){e.walkUrl=now;await persist();}
      return r;
    },
    async walkTo(tabId,url){
      if(await api.checkUser(tabId)){note('page-return-route-skipped',{tabId});return {ok:false,skipped:'user-navigated',error:'The player moved the game tab; Sync leaves it there.'};}
      const r=await spaNavigateGameTab(tabId,url);
      // A slow page (navigation answer after 2.5 s) left walkUrl on the previous page, so the next check took the
      // walk's own move for the player's (live R2 2026-11-12: market crawl stopped after 1 of 16 pages). The tab on
      // the walk's destination is the walk's page.
      const e=tabs.get(tabId);
      if(e){
        let landed=r?.url||null;
        if(!landed){const now=await gameTabUrl(tabId);if(now&&gameUrlSamePage(now,url))landed=now;}
        if(landed){e.walkUrl=landed;await persist();}
      }
      return r;
    },
    async restore(){
      const out=[];
      for(const [tabId,e] of tabs){
        const currentUrl=await gameTabUrl(tabId);
        const decision=pageReturnDecision({startUrl:e.startUrl,walkUrl:e.walkUrl,currentUrl});
        const row={tabId,decision,startUrl:e.startUrl,walkUrl:e.walkUrl,currentUrl};
        if(decision==='restore'){
          const spa=await spaNavigateGameTab(tabId,e.startUrl);
          row.spa=spa;row.how='spa';
          if(!spa?.ok){
            try{await chrome.tabs.update(tabId,{url:e.startUrl});row.how='tab-update';}catch(err){row.how='failed';row.error=err?.message||String(err);}
          }
        }
        note('page-return',row);out.push(row);
      }
      return out;
    }
  };
  return api;
}
// A worker that died mid-run left a pending record: finish the return now, with the same rules as a live run.
const PAGE_RETURN_PENDING_MAX_MS=10*60*1000;
async function recoverPendingPageReturns(reason='service-worker-boot'){
  const out=[],clearGen=extensionClearGeneration;
  for(const realm of [0,1]){
    const key=pageReturnPendingKey(realm);
    const rec=(await chrome.storage.local.get({[key]:null}))[key];
    if(!rec)continue;
    if(realmSyncSessions.has(realm)||dayWalkPageReturns.has(realm))continue; // a live run owns it
    const row={realm,reason,tabs:[]};
    if(!(Date.now()-Number(rec.at)<PAGE_RETURN_PENDING_MAX_MS)){row.expired=true;}
    else for(const [id,e] of Object.entries(rec.tabs||{})){
      const tabId=Number(id);
      let currentUrl=null;try{currentUrl=(await chrome.tabs.get(tabId))?.url||null;}catch{}
      const decision=pageReturnDecision({startUrl:e?.startUrl,walkUrl:e?.walkUrl,currentUrl});
      const t={tabId,decision,how:null};
      if(decision==='restore'){
        const spa=await spaNavigateGameTab(tabId,e.startUrl);t.how='spa';
        if(!spa?.ok){try{await chrome.tabs.update(tabId,{url:e.startUrl});t.how='tab-update';}catch{t.how='failed';}}
      }
      row.tabs.push(t);
    }
    if(clearGen!==extensionClearGeneration)return out;
    await chrome.storage.local.remove(key);
    await chrome.storage.local.set({[`scmSyncReturn:${realm}`]:{at:new Date().toISOString(),recovered:true,expired:Boolean(row.expired),tabs:row.tabs}});
    out.push(row);
  }
  return out;
}
setTimeout(()=>{recoverPendingPageReturns().catch(()=>{});},0);
async function restoreGamePageBounded(pageReturn,label='Return to the starting page'){
  if(!pageReturn)return null;
  try{return await withSyncTimeout(pageReturn.restore(),SYNC_RETURN_TIMEOUT_MS,label);}
  catch(e){return {error:e?.message||String(e)};}
}
// How long a walked page gets to show its traffic. Responses are what matter: a burst followed by a quiet gap means
// the page has loaded; a confirmed page with no traffic at all is given up on sooner than one still talking.
const SYNC_WALK_QUIET_MS=1200,SYNC_WALK_NAV_GAP_MS=1000;
// The page clicked first when the walk finds the tab already on its target (the Warehouse link is on every HQ page;
// on the Warehouse page itself its Incoming contracts tab is).
function syncBouncePage(targetName){
  return targetName==='Warehouse'
    ?{name:'Contracts',labels:['Contracts','Contract'],hrefHints:['/headquarters/warehouse/incoming-contracts/'],route:'/headquarters/warehouse/incoming-contracts/'}
    :{name:'Warehouse',labels:['Warehouse'],hrefHints:['/headquarters/warehouse/'],route:'/headquarters/warehouse/'};
}
const SYNC_WALK_NO_TRAFFIC_MS=3000;
// ---- Sync = pure page walk (2.5.465) ----
// Per walked page: wait until that page's expected paths are captured, at most SYNC_WALK_PATH_WAIT_MS (event-driven,
// no fixed sleeps). A path still missing is 'not-on-page': traced and listed in the Sync result (2.5.466: never queued).
const SYNC_WALK_PATH_WAIT_MS=20000;
async function waitForWalkPath(find,sinceMs,maxMs=SYNC_WALK_PATH_WAIT_MS){
  const deadline=(Number(sinceMs)||Date.now())+maxMs;
  for(;;){const c=find();if(c)return c;if(Date.now()>=deadline)return null;await new Promise(r=>setTimeout(r,100));}
}
// The lane job that serves a path Sync's pages did not load.
function syncMissingLaneKey(path,realm){
  const p=String(path||'').split('?')[0],n=validRealmNumber(realm),r=n!=null?n:0;
  const ex=p.match(/^\/api\/v\d+\/companies\/(\d+)\/executives\/?/i);if(ex)return `executive:${r}:${ex[1]}`;
  if(/\/api\/v\d+\/resources\/\d+\/?$/i.test(p))return `warehouse:${r}`;
  if(/\/contracts-(?:incoming|outgoing)\//i.test(p))return `contracts:${r}`;
  if(typeof ACCOUNTING_SYNC_PATHS!=='undefined'&&ACCOUNTING_SYNC_PATHS.includes(p))return `accounting:${r}`;
  return `syncMissing:${r}`;
}
async function syncNotOnPage(session,realm,path,trace=()=>{}){
  const key=syncMissingLaneKey(path,realm);
  // 2.5.466: Sync queues NO game read. The path is only recorded ("not loaded this Sync"); an optional address the
  // game no longer loads (SYNC_OPTIONAL_PATH_RX) goes on its own info list, never on the error list.
  const optional=syncPathOptional(path);
  if(session){const l=optional?(session.optionalNotLoaded||(session.optionalNotLoaded=[])):(session.notOnPage||(session.notOnPage=[]));if(!l.includes(path))l.push(path);}
  try{trace('not-on-page',{path,lane:key,optional,queued:false});}catch{}
}
// Addresses the game may no longer load (0 hits in the 2026-11-12 capture): saved when the game loads them, otherwise
// listed as "not loaded by the game"; they never fail Accounting or Executives.
const SYNC_OPTIONAL_PATH_RX=/^\/api\/v\d+\/companies\/me\/administration-overhead\/?$|^\/api\/v\d+\/executives\/\d+\/?$/i;
function syncPathOptional(path){return SYNC_OPTIONAL_PATH_RX.test(String(path||'').split('?')[0]);}
// Lane wants that only Sync's not-on-page paths queued (up to 2.5.465): removed once at start-up (Sync queues none now).
const SYNC_STALE_LANE_WANT_RX=/^(?:syncMissing|contracts|accounting)(?::|$)/;
function gameLanePurgeSyncWants(){
  return gameLaneSerial(async()=>{
    const C=gameLaneCore();if(!C)return 0;
    const st=C.laneState(await gameLaneLoad(),Date.now());
    const gone=Object.keys(st.wants||{}).filter(k=>SYNC_STALE_LANE_WANT_RX.test(k));
    if(!gone.length)return 0;
    for(const k of gone)delete st.wants[k];
    await gameLaneStore(st);
    return gone.length;
  });
}
try{gameLanePurgeSyncWants().catch(()=>{});}catch{}
// Before walking: the page hook in the game tab must answer (hello). If not, the tab is reloaded once (navigation,
// not an API read) and its hello awaited.
async function syncEnsurePageHook(tabId,trace=()=>{}){
  const first=await waitForBridge(tabId,3000).catch(()=>null);
  if(first){trace('page-hook-alive',{tabId});return true;}
  trace('page-hook-missing-reload',{tabId});
  try{await chrome.tabs.reload(tabId);}catch(e){trace('page-hook-reload-error',{error:e?.message||String(e)});return false;}
  const ok=Boolean(await waitForBridge(tabId,20000).catch(()=>null));
  trace(ok?'page-hook-alive-after-reload':'page-hook-still-missing',{tabId});
  return ok;
}
async function waitForWalkTraffic(session,sinceMs,capMs=SYNC_CAPTURE_FALLBACK_MS,{quietMs=SYNC_WALK_QUIET_MS,noTrafficMs=SYNC_WALK_NO_TRAFFIC_MS,expect=null}={}){
  // Expected paths known (2.5.465): event-driven, done as soon as every one is captured from this visit, else at most 20 s.
  const want=Array.isArray(expect)?expect.map(p=>String(p||'').split('?')[0]).filter(Boolean):[];
  if(want.length){
    const t0=Date.now(),end=t0+SYNC_WALK_PATH_WAIT_MS;
    const have=()=>{const got=new Set(Object.entries(session?.walkCaptures||{}).filter(([,c])=>Number(c?.at)>=sinceMs&&Number(c?.status)>=200&&Number(c?.status)<300).map(([u])=>String(u).replace(/^https?:\/\/[^/]+/,'').split('?')[0]));return want.filter(p=>got.has(p));};
    while(Date.now()<end){if(have().length===want.length)return {seen:want.length,reason:'all-captured',ms:Date.now()-t0};await new Promise(r=>setTimeout(r,100));}
    const got=have();return {seen:got.length,reason:'cap',missing:want.filter(p=>!got.includes(p)),ms:Date.now()-t0};
  }
  const started=Date.now(),deadline=started+Math.max(1000,Number(capMs)||SYNC_CAPTURE_FALLBACK_MS);
  let seen=0,lastAt=0;
  while(Date.now()<deadline){
    const count=Object.values(session?.walkCaptures||{}).filter(x=>Number(x?.at)>=sinceMs).length;
    if(count!==seen){seen=count;lastAt=Date.now();}
    if(seen&&Date.now()-lastAt>=quietMs)return {seen,reason:'quiet',ms:Date.now()-started};
    if(!seen&&Date.now()-started>=noTrafficMs)return {seen:0,reason:'no-traffic',ms:Date.now()-started};
    await new Promise(r=>setTimeout(r,100));
  }
  return {seen,reason:'cap',ms:Date.now()-started};
}
// Final durability recovery for a target's required endpoints whose durable write was not verified in time. Under the
// game's bot protection the direct read gets 403, so the sources are tried in this order: (1) the game's own fresh
// 2xx page response for that path from this Sync (captureFor(path,sinceMs)); (2) one revisit of the target's page,
// then its capture; (3) the direct read, only while reads are not blocked. Bounded by budgetMs (each record call has
// its own persist timeout). Returns one {path,ok,source} per path.
const SYNC_FINAL_RECOVERY_BUDGET_MS=60000;
async function recoverRequiredEndpointsFinal({paths,sinceMs,captureFor,revisit=null,onMissing=null,record,trace=()=>{},budgetMs=SYNC_FINAL_RECOVERY_BUDGET_MS}){
  const started=Date.now(),out=[];
  const overBudget=()=>Date.now()-started>=budgetMs;
  const fromCapture=async(path,since,source)=>{
    const c=captureFor(path,since);
    if(!c)return false;
    // record() throws only when Sync was stopped; that ends the recovery.
    const ok=Boolean(await record(path,c));
    trace('required-endpoint-final-retry-result',{path,source,ok,status:Number(c.status)||0});
    if(ok)out.push({path,ok:true,source});
    return ok;
  };
  let pending=[];
  for(const path of paths){if(!await fromCapture(path,sinceMs,'walk-capture'))pending.push(path);}
  if(pending.length&&revisit&&!overBudget()){
    const visitStartedAt=Date.now();
    let visit=null;try{visit=await revisit(pending.slice());}catch(e){visit={ok:false,error:e?.message||String(e)};}
    trace('required-endpoint-final-revisit',{paths:pending.slice(),ok:Boolean(visit?.ok),error:visit?.ok?undefined:(visit?.error||visit?.skipped||null),durationMs:Date.now()-visitStartedAt});
    const next=[];
    for(const path of pending){if(!await fromCapture(path,visitStartedAt,'page-revisit'))next.push(path);}
    pending=next;
  }
  for(const path of pending){
    if(overBudget()){trace('required-endpoint-final-retry-skipped',{path,reason:'recovery-time-budget'});out.push({path,ok:false,source:null,reason:'recovery-time-budget'});continue;}
    // Sync makes no Manager read: a path the game's pages did not load is reported (not queued, 2.5.466).
    trace('not-on-page',{path,stage:'final-recovery'});
    try{await onMissing?.(path);}catch{}
    out.push({path,ok:false,source:null,reason:'not-on-page'});
  }
  return out;
}
async function executeGameClickRaw(tabId,target){
  const execution=chrome.scripting.executeScript({target:{tabId},func:async(cfg)=>{
    const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const norm=t=>String(t||'').replace(/\s+/g,' ').trim().toLowerCase();
    const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect?.();if(r&&(r.width===0||r.height===0))return false;const cs=getComputedStyle(el);return cs.display!=='none'&&cs.visibility!=='hidden'&&cs.pointerEvents!=='none';};
    // The Manager's own overlays sit in the same page ("Warehouse: waiting", "Close my outgoing contracts").
    const own=el=>Boolean(el.closest?.('[id^="scm-"],[class*="scm-"]'));
    const find=(labels,hrefHints)=>{
      const wanted=(labels||[]).map(norm), hrefs=(hrefHints||[]).map(norm);
      if(hrefs.length){
        const a=[...document.querySelectorAll('a[href]')].find(x=>{
          const h=norm(x.getAttribute('href'));
          return visible(x)&&!own(x)&&hrefs.some(v=>v&&h.includes(v));
        });
        if(a)return a;
      }
      const nodes=[...document.querySelectorAll('a,button,[role="button"],li,[data-testid],[class*="tab"],[class*="menu"],[class*="nav"]')];
      let best=null,score=-1;
      for(const el of nodes){
        if(!visible(el)||own(el))continue;
        const text=norm(el.textContent),aria=norm(el.getAttribute('aria-label')),title=norm(el.getAttribute('title')),href=norm(el.getAttribute('href')),tag=String(el.tagName||'').toLowerCase();
        const interactive=tag==='a'||tag==='button'||el.getAttribute('role')==='button';
        for(const w of wanted){
          let n=-1;
          if(hrefs.some(h=>h&&href.includes(h)))n=150;
          else if(text===w||aria===w||title===w)n=interactive?125:90;
          // A container holding the word among lots of other text is not a link to that page.
          else if(text.includes(w)||aria.includes(w)||title.includes(w))n=interactive?85:(text.length<=w.length+12?55:-1);
          else if(href&&href.includes(w))n=75;
          if(n>score){best=el;score=n;}
        }
      }
      return best;
    };
    const noSlash=v=>norm(v).replace(/\/$/,'');
    if((cfg.hrefHints||[]).some(h=>h&&noSlash(location.pathname)===noSlash(h)))return {ok:true,alreadyThere:true,beforeUrl:String(location.href),urlAfterClick:String(location.href)};

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
  if(value?.clearGeneration!=null&&value.clearGeneration!==extensionClearGeneration)return;
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
  await scmCreateShortAlarm(name,Math.max(1000,Number(delayMs)||4000));
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
// The day walk drives the game page and floods the storage queue; it stops as soon as a Sync starts and
// re-runs after it.
class AccountingWalkYield extends Error{constructor(){super('Sync started; the Accounting walk will run again after it.');}}
async function waitForAccountingDayCapture(realm,dayIndex,sinceMs,timeoutMs=ACCOUNTING_DAY_WALK_WAIT_MS){
  const path=`/api/v2/companies/me/income-statement/day/${dayIndex}/`;
  const key=realmKeyFromRealm(realm);
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    if(coreSyncActive())throw new AccountingWalkYield();
    const item=(await state(realm)).realmStores?.[key]?.endpointData?.[path];
    const t=Date.parse(item?.receivedAt||'');
    if(item&&Number(item.status)===200&&item.data&&validRealmNumber(item.captureRealm)===realm&&Number.isFinite(t)&&t>=sinceMs)
      return {ok:true,path,date:item.data.date||null,isComputed:item.data.isComputed===true};
    await new Promise(r=>setTimeout(r,500));
  }
  return {ok:false,path,error:`No ${path} response within ${Math.round(timeoutMs/1000)} s.`};
}
// Per-day errors for the Activity details, grouped by cause: "1,4,5,6: timeout" or "1: timeout; 6: tap failed".
function accountingDayWalkErrorSummary(days){
  const kind=e=>{const t=String(e||'');return /response within/i.test(t)?'timeout':/not computed/i.test(t)?'not computed':/tap|button|script did not return/i.test(t)?'tap failed':(t.slice(0,40)||'failed');};
  const groups=new Map();
  for(const d of [...(days||[])].sort((a,b)=>a.day-b.day))if(!d.ok){const k=kind(d.error);groups.set(k,[...(groups.get(k)||[]),d.day]);}
  return [...groups.entries()].map(([k,list])=>`${list.join(',')}: ${k}`).join('; ');
}
// A failed tap (or a tap the game did not answer) is tried once more after 1.5 s; the second wait also accepts a late
// answer to the first tap. After a partial walk, up to 2 re-walks of only the missing days run 15 min apart
// (alarm scm-accounting-day-rewalk-r<n>, pending state in accountingDayWalkStatus.rewalk), cleared on a complete walk.
// A re-walk taps the same game buttons, so it reads only what the game page loads.
const ACCOUNTING_DAY_WALK_RETAP_MS=1500,ACCOUNTING_DAY_WALK_RETRY_WAIT_MS=20000;
const ACCOUNTING_DAY_REWALK_DELAY_MS=15*60000,ACCOUNTING_DAY_REWALK_MAX=2;
// Day d is already stored for this realm when its computed statement is dated one game day per index before the day-0
// statement this walk (or the walk it re-does) captured. Storage read only.
const ACCOUNTING_DAY_DATE_TOLERANCE_MS=3*3600000;
async function accountingDayAlreadyCaptured(realm,d,days){
  const day0=Date.parse(String((days||[]).find(x=>x?.day===0&&x.ok)?.date||'').replace(' ','T'));
  if(!Number.isFinite(day0))return null;
  const item=(await state(realm)).realmStores?.[realmKeyFromRealm(realm)]?.endpointData?.[`/api/v2/companies/me/income-statement/day/${d}/`];
  if(!item||Number(item.status)!==200||validRealmNumber(item.captureRealm)!==realm||item.data?.isComputed!==true)return null;
  const t=Date.parse(String(item.data?.date||'').replace(' ','T'));
  return Number.isFinite(t)&&Math.abs(day0-d*86400000-t)<=ACCOUNTING_DAY_DATE_TOLERANCE_MS?{date:item.data.date}:null;
}
// Re-walks and walk retries tap the user's game tab, so they wait until the user has been idle in the game for 2 min.
// "Last game action" is the monitor's line: the last successful warehouse-refresh job with trigger stock-mutation-or-forced.
// Storage reads only (no game request). A busy game tab pushes the alarm back 2 min; after 60 min of that the run is given up.
const ACCOUNTING_WALK_IDLE_MS=2*60000,ACCOUNTING_WALK_IDLE_GIVE_UP_MS=60*60000,ACCOUNTING_WALK_IDLE_KEY='scmWalkIdleDeferSince';
async function lastGameActionAt(realm){
  const k=backgroundJobHistoryKey(realm);const h=(await chrome.storage.local.get({[k]:null}))[k];
  if(!Array.isArray(h))return 0;
  for(let i=h.length-1;i>=0;i--){const j=h[i];if(j?.job==='warehouse-refresh'&&j.trigger==='stock-mutation-or-forced'&&j.outcome==='success')return Date.parse(j.finishedAt||j.startedAt||'')||0;}
  return 0;
}
async function accountingWalkIdleGate(name,realm,now=Date.now()){
  const map={...((await chrome.storage.local.get({[ACCOUNTING_WALK_IDLE_KEY]:{}}))[ACCOUNTING_WALK_IDLE_KEY]||{})};
  const tab=await activeSimCompaniesTab().catch(()=>null);
  const last=tab?await lastGameActionAt(realm):0;
  if(!tab||!last||now-last>=ACCOUNTING_WALK_IDLE_MS){
    if(name in map){delete map[name];await rawStorageSet({[ACCOUNTING_WALK_IDLE_KEY]:map});}
    return {run:true};
  }
  const since=Number(map[name])||now;
  if(now-since>=ACCOUNTING_WALK_IDLE_GIVE_UP_MS){delete map[name];await rawStorageSet({[ACCOUNTING_WALK_IDLE_KEY]:map});return {run:false,exhausted:true};}
  map[name]=since;await rawStorageSet({[ACCOUNTING_WALK_IDLE_KEY]:map});
  const at=now+ACCOUNTING_WALK_IDLE_MS;await scmAlarmCreate(name,{when:at}).catch(()=>{});
  return {run:false,deferred:true,at};
}
async function runAccountingDayRewalk(realm){
  const n=validRealmNumber(realm); if(n==null)return {ok:false,error:'Invalid realm.'};
  const st=(await state(n)).realmStores?.[realmKeyFromRealm(n)]?.accountingDayWalkStatus;
  const rw=st?.rewalk;
  const missing=Array.isArray(rw?.days)?rw.days.map(Number).filter(d=>Number.isInteger(d)&&d>=0&&d<ACCOUNTING_DAY_WALK_DAYS):[];
  if(!rw?.pending||!missing.length)return {ok:true,skipped:true,reason:'no-rewalk-pending'};
  return runAccountingDayWalk(n,'rewalk',{onlyDays:missing,rewalkCount:Number(rw.count)||1,priorDays:Array.isArray(st.days)?st.days:[]});
}
async function runAccountingDayWalk(realm,reason='scheduled',opts=null){
  const n=validRealmNumber(realm); if(n==null)return {ok:false,error:'Invalid realm.'};
  if(accountingDayWalkRunning.has(n))return {ok:false,busy:true};
  accountingDayWalkRunning.add(n);
  const wanted=new Set(Array.isArray(opts?.onlyDays)&&opts.onlyDays.length?opts.onlyDays.map(Number).filter(d=>Number.isInteger(d)&&d>=0&&d<ACCOUNTING_DAY_WALK_DAYS):Array.from({length:ACCOUNTING_DAY_WALK_DAYS},(_,i)=>i));
  // A re-walk keeps the days the earlier walk already captured.
  const startedAt=new Date().toISOString(); const days=(Array.isArray(opts?.priorDays)?opts.priorDays:[]).filter(d=>d?.ok&&!wanted.has(Number(d.day)));const clearGeneration=extensionClearGeneration;
  const rewalkName=`${ACCOUNTING_DAY_REWALK_ALARM_PREFIX}${n}`;
  const finish=async(status,error=null)=>{
    if(clearGeneration!==extensionClearGeneration)return {ok:false,cancelled:true};
    days.sort((a,b)=>a.day-b.day);
    // A re-walk that could not tap anything still holds the days captured before: partial, not failed.
    if(status==='failed'&&days.some(d=>d.ok))status='partial';
    const v={status,error,reason,startedAt,finishedAt:new Date().toISOString(),days,captured:days.filter(d=>d.ok).length,wanted:ACCOUNTING_DAY_WALK_DAYS};
    const missing=Array.from({length:ACCOUNTING_DAY_WALK_DAYS},(_,i)=>i).filter(i=>!days.some(d=>d.day===i&&d.ok));
    if(status==='complete'){v.rewalk=null;await chrome.alarms.clear(rewalkName).catch(()=>{});}
    else if(status==='partial'&&!opts?.noRewalk){
      const count=(Number(opts?.rewalkCount)||0)+1;
      if(count<=ACCOUNTING_DAY_REWALK_MAX){const at=Date.now()+ACCOUNTING_DAY_REWALK_DELAY_MS;v.rewalk={pending:true,count,days:missing,at:new Date(at).toISOString()};await scmAlarmCreate(rewalkName,{when:at}).catch(()=>{});}
      else v.rewalk={pending:false,count:count-1,days:missing,exhausted:true};
    }
    await setAccountingDayWalkStatus(n,v).catch(()=>{});
    const details={rows:v.captured,wanted:v.wanted};
    const dayErrors=accountingDayWalkErrorSummary(days);if(dayErrors)details.days=dayErrors;
    if(v.rewalk?.pending)details.rewalkAt=v.rewalk.at;
    logActivity(n,'accounting-day-walk',status==='complete'?'success':status==='partial'?'partial':status==='deferred'?'skipped':'failure',details,error,Date.now(),reason);
    return {ok:status!=='failed',...v};
  };
  // Tap day d (d=0: the Day mode button already loaded it) and wait for its answer; one more tap after 1.5 s if the
  // tap failed or the game sent nothing.
  const tapAndWait=async(tabId,d,firstSince,tapFirst)=>{
    let since=firstSince,tapError=null;
    if(tapFirst){since=Date.now();const c=await accountingPeriodStep(tabId,'day',d);if(!c.ok)tapError=c.error||'tap failed';}
    if(!tapError){const got=await waitForAccountingDayCapture(n,d,since);if(got.ok)return got;}
    if(clearGeneration!==extensionClearGeneration)return {ok:false,error:'cancelled'};
    if(coreSyncActive())throw new AccountingWalkYield();
    await new Promise(r=>setTimeout(r,ACCOUNTING_DAY_WALK_RETAP_MS));
    const retryAt=Date.now();
    const c=await accountingPeriodStep(tabId,'day',d);
    if(!c.ok)return {ok:false,error:c.error||tapError||'tap failed'};
    // A late answer to the first tap counts too.
    return await waitForAccountingDayCapture(n,d,tapError?retryAt:since,ACCOUNTING_DAY_WALK_RETRY_WAIT_MS);
  };
  try{
    await setAccountingDayWalkStatus(n,{status:'running',reason,startedAt});
    const tab=await simTab();
    if(!tab?.id)return await finish('failed','Open Sim Companies in a browser tab.');
    await waitForBridge(tab.id,10000);
    let probe=await accountingPeriodStep(tab.id,'probe');
    if(!probe.found){
      const walkReturn=createPageReturn(null,{realm:n});dayWalkPageReturns.set(n,walkReturn);await walkReturn.remember(tab.id);
      const click=await walkReturn.walkClick(tab.id,{name:'Accounting',labels:['Accounting','Financials','Finance'],hrefHints:['/headquarters/accounting']}).catch(e=>({ok:false,error:e?.message||String(e)}));
      for(let i=0;i<40&&!probe.found;i++){await new Promise(r=>setTimeout(r,500));probe=await accountingPeriodStep(tab.id,'probe');}
      if(!probe.found)return await finish('failed',`Accounting period buttons not found (${click?.error||'page did not show them'}).`);
    }
    let since=Date.now();
    const day=await accountingPeriodStep(tab.id,'mode',1);
    if(!day.ok)return await finish('failed',day.error||'Could not tap Day.');
    for(let i=0;i<20;i++){probe=await accountingPeriodStep(tab.id,'probe');if(probe.dayButtons>=ACCOUNTING_DAY_WALK_DAYS)break;await new Promise(r=>setTimeout(r,500));}
    if(!(probe.dayButtons>=ACCOUNTING_DAY_WALK_DAYS))return await finish('failed',`Day buttons not shown (${probe.dayButtons||0}).`);
    for(let d=0;d<ACCOUNTING_DAY_WALK_DAYS;d++){
      if(!wanted.has(d))continue;
      if(clearGeneration!==extensionClearGeneration)return await finish('failed');
      if(coreSyncActive())throw new AccountingWalkYield();
      // Already held (e.g. Sync read it minutes ago, and the game page serves it from its own cache without a new
      // request): no tap needed.
      const held=d>0?await accountingDayAlreadyCaptured(n,d,days):null;
      if(held){days.push({day:d,ok:true,date:held.date,error:null,held:true});continue;}
      // Tapping Day already loads day 0; later days need their own tap.
      const got=await tapAndWait(tab.id,d,since,d>0);
      days.push({day:d,ok:Boolean(got.ok&&got.isComputed),date:got.date||null,error:got.ok?(got.isComputed?null:'not computed yet'):got.error});
    }
    await accountingPeriodStep(tab.id,'mode',0).catch(()=>{});
    const ok=days.filter(x=>x.ok).length;
    return await finish(ok===ACCOUNTING_DAY_WALK_DAYS?'complete':ok?'partial':'failed',ok===ACCOUNTING_DAY_WALK_DAYS?null:`${ACCOUNTING_DAY_WALK_DAYS-ok} day(s) not captured`);
  }catch(e){
    if(e instanceof AccountingWalkYield){
      deferUntilSyncEnds(`accounting-day-walk:${n}`,()=>{scheduleAccountingDayWalk(n,4000).catch(()=>{});});
      return await finish('deferred',e.message);
    }
    return await finish(days.some(x=>x.ok)?'partial':'failed',e?.message||String(e));
  }
  finally{
    accountingDayWalkRunning.delete(n);
    // Put the page back unless a Sync took over; that Sync has taken this start page as its own.
    const back=dayWalkPageReturns.get(n);dayWalkPageReturns.delete(n);
    if(back&&!coreSyncActive()){await restoreGamePageBounded(back,'Accounting walk return to page');await back.forget();}
  }
}
async function yieldSyncStep(ms=SYNC_STEP_YIELD_MS){
  const delay=Math.max(0,Number(ms)||0);
  if(!delay)return;
  await new Promise(resolve=>setTimeout(resolve,delay));
}
async function runDeferredAccountingWeekRefresh(realm,reason='scheduled',opts=null){
  const n=validRealmNumber(realm);
  if(n==null)return {ok:false,error:'Invalid accounting realm.'};
  const existing=accountingWeekRefreshPromises.get(n);
  if(existing)return existing;
  const promise=(async()=>{
    const started=Date.now();
    await setAccountingWeekLedgerStatus(n,'running',null,{reason});
    try{
      const result=await syncCurrentWeekAccountingSales(n,()=>{},opts?.lane?{lane:opts.lane}:null);
      if(result?.ok){
        await accountingWeekRetrySet(n,null);
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
      // Not this job's lane slot: no request went out; status stays scheduled, the alarm asks again (no attempt).
      if(e?.laneWait){await setAccountingWeekLedgerStatus(n,'scheduled',null,{reason,waiting:'game-lane'});logLaneWait(n,'accounting-week-ledger',e.nextAt,{},started,reason);return {ok:false,skipped:true,laneWait:true,nextAt:e.nextAt||0,realm:n};}
      // No game tab / bridge not ready or not connected: no request was answered.
      // A "not read" line (no failed status, no error text in the status). The alarm path counts it as one of its
      // capped attempts, so it never loops; the next Sync starts again.
      if(pageBridgeUnavailable(e)){
        logNotRead(n,'accounting-week-ledger',e,{},started,reason);
        await setAccountingWeekLedgerStatus(n,'scheduled',null,{reason,skipped:'bridge-unavailable',durationMs:Date.now()-started});
        return {ok:false,skipped:true,realm:n,bridgeUnavailable:pageBridgeUnavailable(e),error};
      }
      await setAccountingWeekLedgerStatus(n,'failed',error,{reason,durationMs:Date.now()-started});
      throw e;
    }
  })();
  accountingWeekRefreshPromises.set(n,promise);
  promise.finally(()=>{if(accountingWeekRefreshPromises.get(n)===promise)accountingWeekRefreshPromises.delete(n);}).catch(()=>{});
  return promise;
}

// Executives step of the Sync page walk: the board-room roster (the record the Executives tab reads,
// endpointData['/api/v3/companies/<id>/executives/'].data.executives), then each executive's own record
// (GET /api/v4/executives/<id>/, the game's executive page: workHistory and trainings arrays).
// Optional target: a missing roster never fails Sync. Detail fetches run one at a time so the realm
// storage queue sees one write at a time.
const EXECUTIVES_SYNC_DETAIL_MAX=40;
function executivesRosterPath(companyId){const n=Number(companyId);return Number.isInteger(n)&&n>0?`/api/v3/companies/${n}/executives/`:null;}
function executiveDetailPaths(executives,max=EXECUTIVES_SYNC_DETAIL_MAX){
  const out=[],seen=new Set();
  for(const e of (Array.isArray(executives)?executives:[])){
    const id=Number(e?.id);
    if(!Number.isInteger(id)||id<=0||e?.isCandidate||seen.has(id))continue;
    seen.add(id);out.push(`/api/v4/executives/${id}/`);
    if(out.length>=max)break;
  }
  return out;
}
// Short Executives readout for the Sync status line, e.g. " · Executives 5/5 records · trainings captured".
function executivesSyncSuffix(row){
  if(!row?.ok)return ' · Executives not captured';
  const d=row.executiveDetails||{};
  return ` · Executives ${d.saved||0}/${d.requested||0} records · ${d.trainings?.ok?'trainings captured':'trainings missing'}`;
}
// Sync is complete when every required target is captured and durably verified; optional targets
// (Executives) are reported but never fail Sync.
function syncRequiredTargetsOk(targets,results){
  if(!Array.isArray(targets)||!Array.isArray(results)||results.length!==targets.length)return false;
  return results.every(r=>r?.optional||(r?.ok&&r?.finalDurableVerification?.ok));
}
// Which failed reads mean the address itself moved. 401/403/429/5xx say nothing about the address (session, rate
// limit, outage) and 400/422 mean the route exists but rejected the request, so none of those trigger a search.
// A success whose body is not data (see endpointDataIsValid) is the site's catch-all for an unknown address.
const ENDPOINT_MOVED_STATUSES=new Set([301,302,303,307,308,404,405,410]);
function endpointResponseRejected(path,response){
  const status=Number(response?.status);
  return status>=200&&status<300&&!endpointDataIsValid(path,response?.data);
}
function endpointFailureSuggestsMove(response,path=''){
  return ENDPOINT_MOVED_STATUSES.has(Number(response?.status))||endpointResponseRejected(path,response);
}
// Extra pages for a clicked Sync: each is the game page behind data the Manager reads outside the required targets.
// They are visited so their traffic is seen, and their fixed addresses checked, but never affect Sync success.
// Research is a tab under Warehouse (/headquarters/warehouse/research/, confirmed by the user opening it 2026-11-09), so
// it has a route and is reached by history when its link is not on the current page. Government orders is still
// unconfirmed: if its link is not found the visit is reported as failed rather than forced to a guessed address.
// Sync market crawl: at most this many product pages per Sync, each waited on at most this long.
const SYNC_MARKET_CRAWL_MAX_PRODUCTS=60;
// The first product page also loads the game's market page code, so it gets longer; a page that gave no answer is
// visited once more after the others (R2 2026-11-12: Power, the first page, missed at 6 s).
const SYNC_MARKET_CRAWL_WAIT_MS=6000,SYNC_MARKET_CRAWL_FIRST_WAIT_MS=15000,SYNC_MARKET_CRAWL_RETRY_WAIT_MS=10000,SYNC_MARKET_CRAWL_RETRY_MAX=3,SYNC_MARKET_CRAWL_FRESH_MS=15*60000;
function syncExtraWalkPages(realm){
  return [
    {name:'Map',labels:['Map'],hrefHints:['/landscape/','/map/','/map'],route:'/landscape/',expects:[/\/api\/v2\/companies\/me\/buildings\/?$/i],paths:[]},
    {name:'Market',labels:['Market','Exchange'],hrefHints:['/market/resource/'],route:'/market/resource/1/',expects:[/\/api\/v\d+\/market(?:-ticker)?\//i],paths:[]},
    {name:'Research',labels:['Research'],hrefHints:['/headquarters/warehouse/research/'],route:'/headquarters/warehouse/research/',expects:[/\/api\/v\d+\/players\/research\/?$/i],paths:['/api/v3/players/research/']},
    // Government orders are not walked (2.5.466, user decision): the list comes from SimcoTools only
    // (simcoPublicGovOrders); the player's tier (/government-orders/tier/) is saved from passive capture when the game loads it.
  ];
}
// An unreachable extra page matters only when nothing else proved its data still works: every direct read must have
// returned valid data at its own address. A page with no direct reads has no such proof, so it still warns.
function extraPageVisitNeedsWarning(page,extra){
  if(extra?.pageVisit?.ok||extra?.pageVisit?.skipped)return false;
  const paths=page?.paths||[],reads=extra?.paths||[];
  return !(paths.length>0&&reads.length===paths.length&&reads.every(r=>r.ok&&r.valid&&!r.walkedPath));
}
// A Sync that succeeded with failed trace steps (core-sync "partial"): the unique failed step types (max 10) and one
// plain line naming them, e.g. "Sync finished; some steps failed: building enrichment (HTTP 403)". A step's HTTP
// status is its own, else the last earlier status of the same step family (building-enrichment-api-failure → 403).
// Pure (Node test syncPartialSummary.test.js).
const SYNC_FAILED_STEP_RX=/failed|error|exception/i;
function syncPartialSummary(trace){
  const list=Array.isArray(trace)?trace:[];
  const steps=[],seen=new Set();
  list.forEach((x,i)=>{
    const type=String(x?.type||'');if(!SYNC_FAILED_STEP_RX.test(type)||seen.has(type))return;
    seen.add(type);
    const family=type.replace(/-(?:failed|failure|error|exception)$/i,'');
    let status=Number(x?.status||x?.answerStatus)||0;
    for(let k=i-1;k>=0&&!status;k--){const y=list[k];if(String(y?.type||'').startsWith(`${family}-`))status=Number(y?.status||y?.answerStatus)||0;}
    steps.push({type,name:family.replace(/[-_]+/g,' ').trim()||type,status});
  });
  if(!steps.length)return {failedSteps:[],error:null};
  const shown=steps.slice(0,3).map(s=>s.status?`${s.name} (HTTP ${s.status})`:s.name).join(', ');
  return {failedSteps:steps.slice(0,10).map(s=>s.type),error:`Sync finished; some steps failed: ${shown}${steps.length>3?`; +${steps.length-3} more in the diagnostic`:''}`};
}
// One readable line per problem for the Sync status; the full list goes in the diagnostic.
function syncWarningsSuffix(warnings){
  if(!warnings?.length)return '';
  const shown=warnings.slice(0,3).join('; ');
  return ` · ${warnings.length} endpoint warning${warnings.length===1?'':'s'}: ${shown}${warnings.length>3?`; +${warnings.length-3} more in the diagnostic`:''}`;
}
// Text from a page or a response, going into stored diagnostics: bounded, one line. Display escapes it as usual.
function safeWalkText(v,max=200){const t=String(v??'').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g,' ').trim();return t.length>max?`${t.slice(0,max)}…`:t;}
function endpointIsScalar(item){return item&&item.data!=null&&typeof item.data!=='object';}

// Finds where a gone endpoint moved, among responses captured while walking the game. First the same address
// under another API version; then a renamed address whose response has the same structure as this endpoint's
// last good response. Exactly one structural match is required: a tie or no earlier data finds nothing.
function endpointShape(data){
  const sample=Array.isArray(data)?data[0]:data;
  if(!sample||typeof sample!=='object'||Array.isArray(sample))return null;
  const keys=Object.keys(sample);
  return keys.length>=3?{list:Array.isArray(data),keys:new Set(keys)}:null;
}
// Game API answers are objects or arrays. Anything else (a page, text, a BOM, a comment) is not data, whatever it starts
// with. Known single-number endpoints are listed; their record cannot be relied on to tell, since the page's own failed
// request may just have replaced it.
const SCALAR_ENDPOINT_RX=/\/administration-overhead\/(?:\?.*)?$/;
function endpointDataIsValid(path,data){
  if(data!==null&&typeof data==='object')return true;
  return typeof data==='number'&&Number.isFinite(data)&&SCALAR_ENDPOINT_RX.test(String(path||''));
}
function findMovedEndpoint(path,captured,knownPaths=[],sinceMs=0){
  const bare=k=>String(k).replace(/^https?:\/\/[^/]+/,'');
  const good=k=>Number(captured?.[k]?.status)>=200&&Number(captured?.[k]?.status)<300&&endpointDataIsValid(bare(k),captured[k]?.data);
  const others=Object.keys(captured||{}).filter(k=>bare(k)!==path&&!knownPaths.includes(bare(k))&&good(k));
  const tail=path.replace(/^\/api\/v\d+/,'');
  const sameTail=others.find(k=>bare(k).replace(/^\/api\/v\d+/,'')===tail);
  if(sameTail)return sameTail;
  const before=endpointShape(captured?.[path]?.data);
  if(!before)return null;
  // Only responses captured during this section's own page visit can stand in for its endpoint.
  const matches=others.filter(k=>{
    if(!(Date.parse(String(captured[k]?.receivedAt||''))>=sinceMs))return false;
    const now=endpointShape(captured[k].data);
    if(!now||now.list!==before.list)return false;
    const shared=[...before.keys].filter(x=>now.keys.has(x)).length;
    return shared/new Set([...before.keys,...now.keys]).size>=0.8;
  });
  // Matching structure cannot prove it is the same data, so a rename is reported and never stored.
  return matches.length===1?{suspected:matches[0]}:null;
}
async function syncNow(requestedRealm=null,{fullWalk=false}={}){
  const startedAt=Date.now();
  // Remains null during the active capture and becomes authoritative only
  // once finalization assigns the terminal completion time.
  let finishedAt=null;
  let syncTrace=[];
  let ownsSyncSession=false;
  let selected=null;
  let syncCoreSucceeded=false;
  let syncRetrySkip=null;
  let pageReturn=null;
  const targets=[
    {name:'Warehouse',labels:['Warehouse','Headquarters','HQ'],hrefHints:['/headquarters/warehouse/'],route:'/headquarters/warehouse/',waitFor:'warehouse'},
    {name:'Contracts',labels:['Contracts','Contract'],hrefHints:['/headquarters/warehouse/incoming-contracts/'],route:'/headquarters/warehouse/incoming-contracts/',waitFor:'contracts'},
    // Executives roster + each executive's work history and trainings, so a new device has the
    // Executives tab filled without opening the game's Executives page. Optional (never fails Sync).
    {name:'Executives',labels:['Executives','Board room'],hrefHints:['/headquarters/executives/'],route:'/headquarters/executives/',waitFor:'executives',optional:true},
    // Accounting is intentionally LAST because it fans out across the game's
    // financial endpoints and is the slowest capture group.
    {name:'Accounting',labels:['Accounting','Financials','Finance'],hrefHints:['/headquarters/accounting'],route:'/headquarters/accounting/',waitFor:'accounting'},
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
    // realm capture while the first transaction is still writing realm-local storage.
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
    const session={realm:selected,startedAt,phase:'preflight',gameTabId:null};
    realmSyncSessions.set(selected,session);
    scmMirrorSyncSessions();
    // Whatever this key says from now on is about this run.
    chrome.storage.local.remove(`scmSyncReturn:${selected}`).catch(()=>{});
    syncCaptureRealm=selected;
    ownsSyncSession=true;
    chrome.alarms.clear(`${SYNC_AUTO_RETRY_ALARM_PREFIX}${selected}`).catch(()=>{});
    const trace=(type,payload={})=>syncTrace.push({at:Date.now(),type,...payload});
    let lastTracePersistAt=0;
    const persistTrace=async(force=false)=>{
      if(session.cancelled)return false;
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
        // A checkpoint that timed out is only a gap once a later one is saved (live R2 2026-11-12: one mid-Sync
        // checkpoint missed its 5 s, the rest saved, and a 4/4 Sync was reported "partial: diagnostic persist").
        if(session.diagnosticPersistGaps){for(const x of syncTrace)if(x.type==='diagnostic-persist-failed')x.type='diagnostic-persist-late';session.diagnosticPersistGaps=0;}
        return true;
      }catch(e){
        session.diagnosticPersistGaps=(session.diagnosticPersistGaps||0)+1;
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
    // Walk and Sync captures are taken only from this game tab (top frame); a walk that moves to another tab updates it.
    session.gameTabId=tab.id;
    const bridgeReady=await waitForBridge(tab.id,8000);
    if(!bridgeReady) throw new Error('Sim Companies page bridge could not be established. Keep the logged-in game tab open and try Sync again.');
    trace('bridge-ready',{tabId:tab.id});
    // The page to come back to. An Accounting walk this Sync interrupted has already moved the tab: use its start.
    pageReturn=createPageReturn(trace,{realm:selected});
    await pageReturn.remember(tab.id,dayWalkPageReturns.get(selected)?.tabs.get(tab.id)?.startUrl||null);
    session.warnings=[];session.notOnPage=[];
    if(!await syncEnsurePageHook(tab.id,trace))throw new Error('The Manager could not reach the game page (page hook did not answer after a reload).');
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
    const authBoundary=await syncAuthBoundaryFromGame(selected,tab.id,session,trace);
    const authRealm=validRealmNumber(authBoundary?.data?.authCompany?.realmId
      ??authBoundary?.data?.authCompany?.realm
      ??authBoundary?.data?.realmId
      ??authBoundary?.data?.realm
      ??authBoundary?.captureRealm);
    if(!authBoundary?.ok) throw new Error(authBoundary?.notOnPage?`Could not verify the game session for ${realmDisplayNumber(selected)||'selected realm'}: the game page did not load its session data within ${Math.round(SYNC_AUTH_RELOAD_WAIT_MS/1000)} s after a reload.`:`Could not verify the game session for ${realmDisplayNumber(selected)||'selected realm'} before sync (HTTP ${authBoundary?.status||0}).`);
    trace('auth-boundary-source',{source:authBoundary.fromPageCapture?'game-capture':'direct-read',ageMs:authBoundary.ageMs??null});
    if(authRealm!==selected) throw new Error(`Game session is still ${realmDisplayNumber(authRealm)||'an unknown realm'}; selected sync target is ${realmDisplayNumber(selected)||'the selected realm'}. Switch the game first, then Sync again.`);
    trace('auth-verified',{realm:selected,captureRealm:validRealmNumber(authBoundary.captureRealm),status:Number(authBoundary.status)||0});
    // The explicit auth-data GET bypasses saveData, so record the economy phase from it here
    // (storage only; seeded from the previously stored auth-data).
    try{const es=await state(selected);const ek=realmKeyFromRealm(selected);await recordEconomyState(selected,es?.realmStores?.[ek]?.endpointData?.['/api/v3/companies/auth-data/']||null,authBoundary.data);trace('economy-state-recorded',{realm:selected,economyState:Number(authBoundary.data?.temporals?.economyState)});}catch{}
    // Sync's own writes go ahead of queued passive game captures and are bounded.
    await withSyncTimeout(saveData('/api/v3/companies/auth-data/',authBoundary.data,authBoundary.status,'GET',selected,null,{priorityOnly:true}),SYNC_PERSIST_VERIFY_TIMEOUT_MS,'Save game session');
    await withSyncTimeout(activateRealmByRealm(selected,authBoundary.data?.authCompany?authBoundary.data:null,{priority:true}),SYNC_PERSIST_VERIFY_TIMEOUT_MS,'Activate realm');
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
      if(!Array.isArray(paths)||!paths.includes(path)||syncPathOptional(path))return false;
      if(target.name==='Warehouse')return /\/api\/v3\/resources\/\d+\//i.test(path);
      if(target.name==='Contracts')return /\/api\/v3\/contracts-(?:incoming\/\d+\/me|outgoing\/me)(?:\/|$)/i.test(path);
      if(target.name==='Accounting')return ACCOUNTING_SYNC_PATHS.includes(path);
      if(target.name==='Executives')return /^\/api\/v3\/companies\/\d+\/executives\/$/.test(path);
      return false;
    };
    // If a fixed path is gone, use the same endpoint the game was captured calling under another API version.
    // The response is still stored under the fixed path, so every reader keeps working.
    let walkSinceMs=Date.now();
    // The game's own response to a walked page is the source of truth: a fresh 2xx capture of this path from this
    // page visit is used without a request. Otherwise the direct read runs (non-fatal); when the game blocks it, the
    // capture is looked for again (a slow page can answer after the visit wait).
    const walkCaptureFor=path=>{
      for(const [url,c] of Object.entries(session.walkCaptures||{})){
        if(String(url).replace(/^https?:\/\/[^/]+/,'').split('?')[0]!==path)continue;
        const st=Number(c?.status)||0;
        if(st<200||st>=300||!endpointDataIsValid(path,c?.data)||Number(c?.at)<walkSinceMs)continue;
        return {ok:true,status:st,data:c.data,captureRealm:selected,fromPageCapture:true,receivedAt:c.receivedAt};
      }
      return null;
    };
    // Every target's required paths keep their latest 2xx page response for the whole Sync (walkCaptures is reset
    // per page), so the final durability recovery can re-save the game's own answer without a direct read.
    session.syncCapturePaths=new Set();session.syncCaptures={};
    const syncCaptureFor=(path,sinceMs)=>{
      const c=session.syncCaptures?.[path]||session.syncEarlyCaptures?.[path];
      const st=Number(c?.status)||0;
      if(!c||st<200||st>=300||Number(c.at)<Number(sinceMs)||!endpointDataIsValid(path,c.data))return null;
      return {ok:true,status:st,data:c.data,captureRealm:selected,fromPageCapture:true,receivedAt:c.receivedAt};
    };
    const syncTargetPaths=(name,companyId)=>name==='Warehouse'
      // Warehouse's authoritative, fast path is the resources endpoint. The /buildings/ API is Cloudflare-protected on
      // the live game and must never block or fail a Warehouse sync (building state comes from the game-state capture).
      ? (companyId>0?[`/api/v3/resources/${companyId}/`]:[])
      : name==='Contracts'
        ? realmContractPaths(selected)
        : name==='Accounting'
          ? ACCOUNTING_SYNC_PATHS.slice()
          : name==='Executives'
            ? [executivesRosterPath(companyId)].filter(Boolean)
            : [];
    // Sync makes ZERO Manager game requests (2.5.465): a path comes from the walked page's own traffic, or it is
    // reported 'not-on-page' (recorded only; 2.5.466 queues no game read).
    const capturedUnder=(walkedUrl)=>{
      const want=String(walkedUrl||'').replace(/^https?:\/\/[^/]+/,'').split('?')[0];
      for(const [url,c] of Object.entries(session.walkCaptures||{})){
        if(String(url).replace(/^https?:\/\/[^/]+/,'').split('?')[0]!==want)continue;
        const st=Number(c?.status)||0;if(st<200||st>=300||Number(c?.at)<walkSinceMs)continue;
        return {ok:true,status:st,data:c.data,captureRealm:selected,fromPageCapture:true,receivedAt:c.receivedAt};
      }
      return null;
    };
    // This visit's own request for the path, answered with an error status (latest one).
    const walkFailedCaptureFor=path=>{
      let out=null;
      for(const [url,c] of Object.entries(session.walkCaptures||{})){
        if(String(url).replace(/^https?:\/\/[^/]+/,'').split('?')[0]!==path)continue;
        const st=Number(c?.status)||0;if(Number(c?.at)<walkSinceMs||(st>=200&&st<300))continue;
        if(!out||Number(c.at)>out.at)out={ok:false,status:st,at:Number(c.at)};
      }
      return out;
    };
    const pageGetWalked=async(path)=>{
      const page=walkCaptureFor(path);
      if(page){trace('walk-page-capture-used',{path,status:page.status});return page;}
      // The game loaded it on an earlier page of this Sync (any walked page counts).
      const earlier=syncCaptureFor(path,startedAt);
      if(earlier){trace('walk-sync-capture-used',{path,status:earlier.status,receivedAt:earlier.receivedAt});return earlier;}
      // The page may still be answering: wait for this path (event-driven, at most SYNC_WALK_PATH_WAIT_MS since the visit).
      // A failed answer to the page's own request ends the wait too (it is reported below, not waited out).
      const late=await waitForWalkPath(()=>walkCaptureFor(path)||walkFailedCaptureFor(path),walkSinceMs);
      if(late&&late.ok){trace('walk-page-capture-used',{path,status:late.status,late:true});return late;}
      // A version-only move the page itself called (same data shape): its own response is used, stored under the fixed path.
      const stored=endpointDataForSyncRealm(await state(selected),selected);
      const walked=findMovedEndpoint(path,{...stored,...session.walkCaptures},[...ACCOUNTING_SYNC_PATHS,...realmContractPaths(selected)],walkSinceMs);
      if(walked&&!walked.suspected){
        const moved=capturedUnder(walked);
        if(moved&&endpointDataIsValid(path,moved.data)){
          trace('endpoint-walked-path',{path,walked});
          (session.movedReads||(session.movedReads={}))[path]=walked.replace(/^https?:\/\/[^/]+/,'');
          return {...moved,walkedPath:walked};
        }
      }else if(walked?.suspected){trace('endpoint-suspected-move',{path,suspected:walked.suspected});session.warnings?.push(`${path} may have moved to ${walked.suspected}; not adopted`);}
      // The game page did request it, and the game answered with an error: that answer is reported with its status
      // (an optional address only on the info list). The stored record is kept (the record step refuses a failure).
      const failed=walkFailedCaptureFor(path);
      if(failed){
        trace('walk-page-capture-failed',{path,status:failed.status,optional:syncPathOptional(path)});
        if(syncPathOptional(path)){const l=session.optionalFailed||(session.optionalFailed=[]);if(!l.some(x=>x.path===path))l.push({path,status:failed.status});}
        return {ok:false,status:failed.status,failedOnPage:true,optional:syncPathOptional(path),captureRealm:selected,error:`The game page's own request answered HTTP ${failed.status}.`};
      }
      await syncNotOnPage(session,selected,path,trace);
      return {ok:false,status:0,notOnPage:true,optional:syncPathOptional(path),captureRealm:selected,error:syncPathOptional(path)?'Not loaded by the game (optional).':'Not loaded by the game pages this Sync.'};
    };
    // Visits a page by its link; if the link did not navigate and the route is known, by the game's router. The
    // result is true only if the page was reached. Stops visiting once the player has moved the tab themselves.
    // A walk page is never opened sooner than SYNC_WALK_NAV_GAP_MS after the previous visit settled (2.5.458).
    let walkSettledAt=0;
    const visitWalkPage=async(...args)=>{
      const wait=walkSettledAt+SYNC_WALK_NAV_GAP_MS-Date.now();if(wait>0)await new Promise(r=>setTimeout(r,wait));
      try{return await visitWalkPageOnce(...args);}finally{walkSettledAt=Date.now();}
    };
    // One page click; when the tab is already on the target (2.5.466) the game's SPA sends nothing for it, so another
    // game page is clicked first, then the target again: the game makes its own fresh requests (page clicks only).
    const walkClickFresh=async(tabId,target)=>{
      let visit=await pageReturn.walkClick(tabId,{name:target.name,labels:target.labels,hrefHints:target.hrefHints||[]});
      if(visit?.ok&&visit.alreadyThere){
        const bounce=syncBouncePage(target.name);
        let away=await pageReturn.walkClick(tabId,bounce).catch(e=>({ok:false,error:e?.message||String(e)}));
        if(!away?.ok||away.alreadyThere){
          // The link was not usable here: the game's own router (history navigation) to the bounce page.
          const origin=(await gameTabUrl(tabId)||'').match(/^https:\/\/[^/]+/)?.[0];
          const spa=origin?await pageReturn.walkTo(tabId,origin+bounce.route).catch(()=>({ok:false})):{ok:false};
          if(spa?.ok)away={ok:true,navigated:true,via:`route-${spa.via}`};
        }
        trace('walk-page-bounce',{name:target.name,via:bounce.name,ok:Boolean(away?.ok),error:away?.ok?undefined:safeWalkText(away?.error||'')});
        if(away?.ok&&!away.alreadyThere){
          await new Promise(r=>setTimeout(r,SYNC_WALK_NAV_GAP_MS));
          const back=await pageReturn.walkClick(tabId,{name:target.name,labels:target.labels,hrefHints:target.hrefHints||[]});
          visit={...back,bounced:bounce.name,ok:Boolean(back?.ok),navigated:Boolean(back?.ok&&back.navigated)};
        }
      }
      return visit;
    };
    const visitWalkPageOnce=async(tabId,target,sess)=>{
      try{
        if(await pageReturn.checkUser(tabId)){trace('walk-page-skipped',{name:target.name,reason:'user-navigated'});return {ok:false,skipped:'user-navigated'};}
        const startedAt=Date.now();
        let visit=await walkClickFresh(tabId,target);
        if(!visit?.ok&&target.route){
          const origin=(await gameTabUrl(tabId)||'').match(/^https:\/\/[^/]+/)?.[0];
          const spa=origin?await pageReturn.walkTo(tabId,origin+target.route):{ok:false};
          trace('walk-page-route-fallback',{name:target.name,ok:Boolean(spa?.ok),via:spa?.via||null,clickError:visit?.error||null});
          if(spa?.ok)visit={ok:true,navigated:true,via:`route-${spa.via}`,urlAfterClick:spa.url,clickError:visit?.error||null};
        }
        if(visit?.ok&&visit.navigated)visit.traffic=await waitForWalkTraffic(sess,startedAt,undefined,{expect:sess?.capturePaths});
        if(visit)visit.loaded=[...new Set(Object.keys(sess.walkCaptures||{}).map(u=>safeWalkText(String(u).split('?')[0])))].slice(0,40);
        return visit;
      }catch(e){return {ok:false,error:e?.message||String(e)};}
    };
    const recordAuthoritative=async(path,response,row)=>{
    if(session.cancelled)throw new SyncCancelledByClear();
    if(endpointResponseRejected(path,response)){
      // Every read path ends here (retries use pageGet directly), so nothing that is not data replaces the stored record.
      (row.authoritativeFailures||(row.authoritativeFailures=[])).push({path,status:Number(response?.status)||0,error:'The address did not return data.'});
      session.warnings?.push(`${path} (HTTP ${Number(response?.status)||0}) did not return data; kept the stored record`);
      trace('endpoint-not-data-rejected',{path,status:Number(response?.status)||0});
      return false;
    }
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
    if(response.walkedPath)(row.movedEndpoints||(row.movedEndpoints=[])).push({path,walkedPath:response.walkedPath});
    const persistStartedAt=Date.now();
    trace('endpoint-persist-start',{path,status:Number(response.status)||200,realm:selected});
    try{
      const persisted=await withSyncTimeout(saveData(path,response.data,response.status,'GET',selected,timing=>{
        trace('endpoint-storage-queue-timing',{path,...timing});
      },{realm:selected,startedAtMs:persistStartedAt,expectedData:response.data,expectedStatus:response.status,allowPreserved:row.name==='Accounting'}),SYNC_PERSIST_VERIFY_TIMEOUT_MS,`Persist and verify ${path}`);
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

    // Every target's paths are captured from the FIRST walked page on (2.5.466): the game loads some of them on another
    // target's page (outgoing contracts on the Warehouse page), and that answer counts for this Sync.
    {
      let cid=0;
      try{const cur=await state();const st0=cur.realmStores?.[realmKeyFromRealm(selected)]||{};cid=Number(st0.authData?.authCompany?.companyId||st0.authData?.authCompany?.id||cur.authData?.authCompany?.companyId||cur.authData?.authCompany?.id)||0;}catch{}
      for(const t of targets)for(const p of syncTargetPaths(t.name,cid))session.syncCapturePaths.add(p);
      session.syncCapturePathsReady=true;
      trace('sync-capture-paths',{count:session.syncCapturePaths.size,early:Object.keys(session.syncEarlyCaptures||{}).filter(p=>session.syncCapturePaths.has(p))});
    }
    for(let i=0;i<targets.length;i++){
      const target=targets[i];
      const step=i+1;
      const targetStartedAt=Date.now();
      walkSinceMs=targetStartedAt;
      session.walkCaptures={};
      if(session.cancelled)throw new SyncCancelledByClear();
      const currentTab=await simTab();
      if(!currentTab?.id) throw new Error('The logged-in Sim Companies tab is no longer available.');
      session.gameTabId=currentTab.id;
      const row={name:target.name,ok:false,status:'api-pending',endpoint:null,reason:null};
      await persistTransientSyncUi(selected,`${realmDisplayNumber(selected)||'Realm'} Sync: ${step}/${targets.length} ${target.name}…`,null);
      trace('target-start',{name:target.name,step});
      await persistTrace(true);

      // API-first: direct authoritative reads are deterministic and available on
      // both realms. UI navigation is only a fallback for failed reads.
      let companyId=0;
      try{
        const current=await state();
        const selectedStore=current.realmStores?.[realmKeyFromRealm(selected)]||{};
        companyId=Number(selectedStore.authData?.authCompany?.companyId||selectedStore.authData?.authCompany?.id||current.authData?.authCompany?.companyId||current.authData?.authCompany?.id)||0;
      }catch{}

      const authoritativePaths=syncTargetPaths(target.name,companyId);

      row.optional=Boolean(target.optional);
      row.startedAtMs=targetStartedAt;
      row.requestedPaths=authoritativePaths.slice();
      // The visit waits only for the required paths; an optional one (the game may no longer load it) is taken if seen.
      session.capturePaths=authoritativePaths.filter(p=>!syncPathOptional(p));
      for(const p of authoritativePaths)session.syncCapturePaths.add(p);
      if(!authoritativePaths.length){
        row.authoritativeFailures=[{path:null,status:0,error:'No authoritative API path could be resolved from the selected realm state.'}];
      }

      // Sync is a pure page walk (2.5.465): every target's page is visited; its own traffic is the only data source.
      {
        // Walk the game's own page first, so its requests run as they do for a player. A failed visit only
        // skips the wait and is reported; the direct reads below (and their fallback) still run.
        row.pageVisit=await visitWalkPage(currentTab.id,target,session);
        if(row.pageVisit?.traffic)trace('walk-page-traffic',{name:target.name,...row.pageVisit.traffic});
        if(!row.pageVisit?.ok&&!row.pageVisit?.skipped)session.warnings.push(`${target.name} page not reached: ${row.pageVisit?.error||'no navigation'}`);
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
              const response=await pageGetWalked(path,selected,null,`sync-accounting`);
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
        // Contracts has only two independent endpoints. Fetch them in
        // parallel; realm-scoped storage commits remain serialized by the API
        // queue, so concurrency improves latency without mixing stores.
        await Promise.all(authoritativePaths.map(async path=>{
          try{
            trace('authoritative-request',{name:target.name,path});
            const response=await pageGetWalked(path,selected);
            const ok=await recordAuthoritative(path,response,row);
            directResults.push({path,ok,status:Number(response?.status)||0,captureRealm:validRealmNumber(response?.captureRealm),error:response?.error||null});
            trace(ok?'authoritative-success':'authoritative-failure',{name:target.name,path,status:Number(response?.status)||0,captureRealm:validRealmNumber(response?.captureRealm)});
            if(path.includes('/contracts-incoming/') && ok){
              row.endpoint=path;
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
            const response=await pageGetWalked(path,selected);
            const ok=await recordAuthoritative(path,response,row);
            directResults.push({path,ok,status:Number(response?.status)||0,captureRealm:validRealmNumber(response?.captureRealm),error:response?.error||null});
            trace(ok?'authoritative-success':'authoritative-failure',{name:target.name,path,status:Number(response?.status)||0,captureRealm:validRealmNumber(response?.captureRealm)});
            if(ok){
              row.endpoint=path;
            }
          }catch(e){
            trace('authoritative-error',{name:target.name,path,error:e?.message||String(e)});
            directResults.push({path,ok:false,status:0,error:e?.message||String(e)});
            row.authoritativeFailures=(row.authoritativeFailures||[]).concat({path,status:0,error:e?.message||String(e)});
          }
        }
      }

      if(session.cancelled)throw new SyncCancelledByClear(); // the reads above catch it, so stop here
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
        // Only a missing REQUIRED Accounting path clicks the page again; an optional one the game does not load does not.
        if(target.name==='Accounting' && directResults.filter(x=>x.ok&&!syncPathOptional(x.path)).length<authoritativePaths.filter(p=>!syncPathOptional(p)).length){
          trace('accounting-partial-direct-capture',{successCount:directSuccessCount,requestedCount:authoritativePaths.length});
          const fallbackStart=Date.now();
          let click={ok:false,error:'Accounting UI enrichment not attempted.'};
          try{ click=await walkClickFresh(currentTab.id,target); }catch(e){ click={ok:false,error:e?.message||String(e)}; }
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

      if(target.name==='Executives' && row.ok){
        // Each executive's own record (work history + trainings), one request and one write at a time.
        const details={requested:0,saved:0,failed:[]};
        try{
          const rosterPath=authoritativePaths[0];
          const rosterItem=endpointDataForSyncRealm(await state(selected),selected)?.[rosterPath];
          const detailPaths=executiveDetailPaths(rosterItem?.data?.executives);
          details.requested=detailPaths.length;
          for(const path of detailPaths){
            try{
              trace('executive-detail-request',{path});
              const response=await pageGetWalked(path,selected,null,'sync-executives');
              const ok=await recordAuthoritative(path,response,row);
              if(ok)details.saved++;else if(response?.notOnPage)(details.notLoaded||(details.notLoaded=[])).push(path);else details.failed.push({path,status:Number(response?.status)||0,error:response?.error||null});
            }catch(e){details.failed.push({path,status:0,error:e?.message||String(e)});}
          }
          // Executive records the game did not load are info (optional address), not a warning; a failed answer still warns.
          if(details.failed.length)session.warnings.push(`${details.failed.length} of ${details.requested} executive records not captured (${details.failed[0].path}: HTTP ${details.failed[0].status})`);
          // Trainings done per executive: the Executives tab reads this company-wide count, and the game
          // only requests it when its Executives page opens, so Sync must fetch it itself.
          const trainingsPath=`/api/v3/companies/${Number(companyId)}/executives/trainings-count/`;
          try{
            trace('executive-trainings-request',{path:trainingsPath});
            const response=await pageGetWalked(trainingsPath,selected,null,'sync-executives');
            const ok=await recordAuthoritative(trainingsPath,response,row);
            details.trainings={ok:Boolean(ok),status:Number(response?.status)||0};
          }catch(e){details.trainings={ok:false,status:0,error:e?.message||String(e)};}
          if(!details.trainings?.ok)session.warnings.push(`${trainingsPath} not captured (HTTP ${details.trainings?.status||0})`);
        }catch(e){details.error=e?.message||String(e);}
        row.executiveDetails=details;
        row.status=`api-captured · ${details.saved}/${details.requested} executive records`;
        trace('executive-details-complete',{requested:details.requested,saved:details.saved,failed:details.failed.length});
      }

      if(!row.ok && target.optional){
        // Optional step: no UI navigation fallback; Sync carries on. The final check retries the roster once.
        row.status='optional-not-captured';
        row.reason=row.authoritativeFailures?.[0]?.error||(authoritativePaths.length?'Executives roster was not captured.':'Company id not known yet; Executives skipped.');
        trace('optional-target-skipped',{name:target.name,reason:row.reason});
        session.warnings.push(`${target.name} not captured: ${row.reason}`);
      }else if(!row.ok){
        // Fallback only: open the requested game page so its own traffic has a
        // chance to populate the same realm-scoped stores. The click itself is
        // deliberately short; it must never freeze Sync for ten seconds.
        let click={ok:false,error:'UI fallback not yet attempted.'};
        const fallbackStart=Date.now();
        try{
          click=await walkClickFresh(currentTab.id,target);
        }catch(e){click={ok:false,error:e?.message||String(e)};}
        row.click=click;
        row.fallbackUsed=true;
        trace('ui-fallback-result',{name:target.name,ok:Boolean(click?.ok),error:click?.error||null});

        let recovered=null;
        try{
          recovered=await waitForEndpointCapture(target.waitFor,fallbackStart,SYNC_CAPTURE_FALLBACK_MS,selected);
        }catch{}
        if(!recovered?.ok){
          // The page visit may have just revealed a moved endpoint, so try the paths again.
          const saved=[];
          for(const path of authoritativePaths){
            try{const response=await pageGetWalked(path,selected);if(await recordAuthoritative(path,response,row))saved.push(path);}catch{}
          }
          const required=target.name==='Accounting'?saved.some(x=>ACCOUNTING_CORE_PATH_RE.test(x)):target.name==='Contracts'?saved.some(x=>x.includes('/contracts-incoming/')):saved.length>0;
          if(required)recovered={ok:true,endpoint:saved[0]};
        }

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
          // One last direct attempt after the route change: a response (contracts
          // especially) can arrive after the passive capture window.
          for(const path of authoritativePaths){
            try{
              trace('authoritative-retry',{name:target.name,path});
              const response=await pageGetWalked(path);
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
      await persistTransientSyncUi(selected,`${realmDisplayNumber(selected)||'Realm'} Sync: ${step}/${targets.length} ${target.name} ${row.ok?'✓':target.optional?'skipped':'failed'}`,row.ok||target.optional?null:row.reason);
      // Short yield between targets, only after a target has finished, so it cannot create a false readiness state.
      if(i<targets.length-1) await yieldSyncStep();
    }

    // Clicked Sync also walks the other pages the Manager gathers data from, to catch their endpoints changing.
    // Report only: no effect on Sync success, nothing stored here (refreshExtraGameData stores these after Sync).
    const walkReport=[];
    if(fullWalk){
      session.capturePaths=[];
      for(const page of syncExtraWalkPages(selected)){
        const rowStart=Date.now();
        walkSinceMs=rowStart;session.walkCaptures={};
        const extra={name:page.name,paths:[],seen:[]};
        try{
          const extraTab=await simTab();
          if(!extraTab?.id)throw new Error('The game tab is no longer available.');
          session.gameTabId=extraTab.id;
          extra.pageVisit=await visitWalkPage(extraTab.id,page,session);
          const urls=Object.keys(session.walkCaptures||{});
          extra.seen=[...new Set(urls.map(u=>safeWalkText(u.split('?')[0])).filter(u=>page.expects.some(rx=>rx.test(u))))];
          // Every URL the page loaded (not only the expected ones), for the walk report.
          extra.loaded=[...new Set(urls.map(u=>safeWalkText(u.split('?')[0])))].slice(0,40);
          for(const path of page.paths){
            // Same per-read timeout as the other slow-server reads: at 5 s a game answering in 6-9 s showed as HTTP 0, and the
            // failed read also turned an unreachable Research link into a "page not reached" warning. Still one attempt.
            const r=await pageGetWalked(path,selected,null,'sync-walk-check',{timeoutMs:SLOW_SERVER_PAGE_READ_TIMEOUT_MS,attempts:1}).catch(e=>({ok:false,status:0,error:e?.message||String(e)}));
            extra.paths.push({path,ok:Boolean(r?.ok),status:Number(r?.status)||0,walkedPath:r?.walkedPath||null,valid:Boolean(r?.ok)&&!endpointFailureSuggestsMove(r,path),fromPage:Boolean(r?.fromPageCapture)});
            // The game's own answer on this page is stored like any capture outside Sync (refreshExtraGameData cannot read it now).
            if(r?.fromPageCapture){try{await withSyncTimeout(saveData(path,r.data,r.status,'GET',selected),SYNC_PERSIST_VERIFY_TIMEOUT_MS,`Save ${path}`);}catch(e){trace('walk-extra-save-failed',{path,error:e?.message||String(e)});}}
            // The status that started (or holds) the pause is named per path: a 503 (busy) is not the 403 bot block.
            
            if(r?.walkedPath)session.warnings.push(`${path} moved to ${r.walkedPath}`);
            else if(!r?.ok&&!r?.notOnPage&&!endpointFailureSuggestsMove(r,path))session.warnings.push(`${path} failed (HTTP ${Number(r?.status)||0})`);
          }
        }catch(e){extra.error=e?.message||String(e);session.warnings.push(`${page.name} walk failed: ${extra.error}`);}
        if(extra.pageVisit&&extraPageVisitNeedsWarning(page,extra))session.warnings.push(`${page.name} page not reached: ${extra.pageVisit.error||'no navigation'}`);
        extra.durationMs=Date.now()-rowStart;
        walkReport.push(extra);
        trace('walk-extra-page',{name:page.name,ok:Boolean(extra.pageVisit?.ok),error:extra.pageVisit?.ok?undefined:safeWalkText(extra.pageVisit?.error||''),reads:`${extra.paths.filter(r=>r.valid).length}/${page.paths.length}`,seen:extra.seen.length,durationMs:extra.durationMs});
      }
      session.walkCaptures=null;
    }

    // Market crawl (timer syncMarketCrawl, default on): after the targets, open the game's own market page of every
    // product the company stocks or produces (orderBookRefreshResourceIds), so the game itself loads
    // /api/v3/market/<realm>/<id>/. Its response is stored in endpointData, where marketPrice() reads exact game
    // prices. No request of the Manager's own. Each page waits at most SYNC_MARKET_CRAWL_WAIT_MS and moves on as soon
    // as the response lands. Stops when the player takes over the tab; the start page is restored below as for any walk.
    const marketCrawl={enabled:false,products:0,captured:0,missed:[],durationMs:0};
    if(!session.cancelled&&await scmTimerEnabled('syncMarketCrawl').catch(()=>true)){
      marketCrawl.enabled=true;const crawlStart=Date.now();
      try{
        try{await withSyncTimeout(apiStorageQueueForRealm(selected),20000,'Market crawl queue drain');}catch{}
        const cs=await state(selected),cst=cs.realmStores?.[realmKeyFromRealm(selected)]||{};
        let networkRows=[];try{const {network}=await overlayProductionStock(cst,selected,null);networkRows=[...network.productionRows,...network.demandRows];}catch{}
        const ids=[...orderBookRefreshResourceIds(cst,selected,networkRows)].sort((a,b)=>a-b).slice(0,SYNC_MARKET_CRAWL_MAX_PRODUCTS);
        marketCrawl.products=ids.length;
        const crawlTab=ids.length?await simTab():null;
        if(crawlTab?.id)session.gameTabId=crawlTab.id;
        const origin=crawlTab?.id?(await gameTabUrl(crawlTab.id)||'').match(/^https:\/\/[^/]+/)?.[0]:null;
        session.capturePaths=[];
        // One capture list for the whole crawl: an answer that lands after its page's wait (while the next page loads) still counts.
        session.walkCaptures={};
        const gotFor=path=>{
          for(const [url,c] of Object.entries(session.walkCaptures||{})){
            if(String(url).replace(/^https?:\/\/[^/]+/,'').split('?')[0]!==path)continue;
            const st=Number(c?.status)||0;if(st>=200&&st<300&&Array.isArray(c?.data))return c;
          }
          return null;
        };
        const saved=new Set();
        const saveGot=async(id,path,got)=>{
          if(saved.has(id))return true;
          try{await withSyncTimeout(saveData(path,got.data,Number(got.status)||200,'GET',selected),SYNC_PERSIST_VERIFY_TIMEOUT_MS,`Save ${path}`);saved.add(id);marketCrawl.captured++;return true;}
          catch(e){marketCrawl.missed.push({id,reason:'save-failed'});return false;}
        };
        const visit=async(id,waitMs)=>{
          const path=`/api/v3/market/${selected}/${id}/`,dest=`${origin}/market/resource/${id}/`,t0=Date.now();
          // The tab already on this product (live R2 2026-11-12: Power, where the player left it) loads nothing new
          // when "opened" again: open the Market page first, then the product.
          if(gameUrlSamePage(await gameTabUrl(crawlTab.id).catch(()=>null),dest))await pageReturn.walkTo(crawlTab.id,`${origin}/market/`).catch(()=>null);
          let nav=await pageReturn.walkTo(crawlTab.id,dest).catch(e=>({ok:false,error:e?.message||String(e)}));
          // A slow page answers after the navigation's 2.5 s limit: the tab on the product still gets its wait.
          if(!nav?.ok&&!nav?.skipped&&gameUrlSamePage(await gameTabUrl(crawlTab.id).catch(()=>null),dest))nav={...nav,ok:true,slow:true};
          let got=null;
          while(nav?.ok&&!got&&Date.now()-t0<waitMs){got=gotFor(path);if(!got)await new Promise(res=>setTimeout(res,100));}
          return {path,nav,got,ms:Date.now()-t0};
        };
        const late=[];
        for(let i=0;i<ids.length;i++){
          const id=ids[i];
          if(session.cancelled)throw new SyncCancelledByClear();
          if(!origin)break;
          if(await pageReturn.checkUser(crawlTab.id)){marketCrawl.stopped='user-navigated';break;}
          const v=await visit(id,i===0?SYNC_MARKET_CRAWL_FIRST_WAIT_MS:SYNC_MARKET_CRAWL_WAIT_MS);
          if(v.got)await saveGot(id,v.path,v.got);
          else late.push({id,path:v.path,reason:v.nav?.ok?'no-response':'not-reached',ms:v.ms});
        }
        // Answers that came late, then one more visit for up to SYNC_MARKET_CRAWL_RETRY_MAX pages that still have none.
        let retries=0;
        for(const m of late){
          let got=gotFor(m.path);
          if(!got&&m.reason==='no-response'&&retries<SYNC_MARKET_CRAWL_RETRY_MAX&&origin&&!marketCrawl.stopped&&!session.cancelled){
            if(await pageReturn.checkUser(crawlTab.id)){marketCrawl.stopped='user-navigated';}
            else{retries++;const v=await visit(m.id,SYNC_MARKET_CRAWL_RETRY_WAIT_MS);got=v.got;m.retryMs=v.ms;}
          }
          if(got){if(await saveGot(m.id,m.path,got))continue;}
          else marketCrawl.missed.push({id:m.id,reason:m.reason,ms:m.ms,...(m.retryMs!=null?{retryMs:m.retryMs}:{})});
        }
        marketCrawl.retried=retries;
        // The game keeps an order book it loaded a little while ago and asks for nothing when the page opens again
        // (live R2 2026-11-12: Power loaded 2 min before Sync). That stored copy, same realm and recent, counts.
        if(marketCrawl.missed.some(m=>m.reason==='no-response')){
          const ed=((await state(selected)).realmStores?.[realmKeyFromRealm(selected)]||{}).endpointData||{},now=Date.now();
          marketCrawl.missed=marketCrawl.missed.filter(m=>{
            if(m.reason!=='no-response')return true;
            const e=ed[`/api/v3/market/${selected}/${m.id}/`],at=Date.parse(String(e?.receivedAt||''));
            if(e?.captureRealm==null||Number(e.captureRealm)!==Number(selected)||!Array.isArray(e?.data)||!(now-at>=0&&now-at<SYNC_MARKET_CRAWL_FRESH_MS))return true;
            marketCrawl.captured++;(marketCrawl.fresh||(marketCrawl.fresh=[])).push({id:m.id,ageMs:now-at});return false;
          });
        }
      }catch(e){if(e instanceof SyncCancelledByClear)throw e;marketCrawl.error=e?.message||String(e);}
      session.walkCaptures=null;session.capturePaths=[];
      marketCrawl.durationMs=Date.now()-crawlStart;
      marketCrawl.missed=marketCrawl.missed.slice(0,20);
      trace('market-crawl',marketCrawl);
      if(marketCrawl.products&&marketCrawl.captured<marketCrawl.products)session.warnings.push(`Market prices: ${marketCrawl.captured}/${marketCrawl.products} product pages loaded their order book`);
    }

    // Drain is best-effort: the final durable verification below re-reads and
    // retries every required endpoint, so a slow queue must not fail Sync.
    try{await withSyncTimeout(apiStorageQueueForRealm(selected),20000,'API storage queue drain');trace('api-queue-drained',{});}
    catch(e){trace('api-queue-drain-timeout',{error:e?.message||String(e)});}

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
      const verifyPath=async requiredPath=>{
        const v=await withSyncTimeout(
          verifyDurableEndpointWrite(selected,requiredPath,result.startedAtMs||startedAt,null,null,target.name==='Accounting',{acceptRecentGameMs:SYNC_RECENT_GAME_CAPTURE_MS,recentGameAtMs:startedAt}),
          3000,`Final durable endpoint verification ${requiredPath}`
        );
        if(v?.ok&&v.fromGamePage){
          (session.fromGamePage||(session.fromGamePage=[])).push({target:result.name,path:requiredPath,receivedAt:v.receivedAt,at:v.fromGamePageAt});
          trace('target-required-endpoint-from-game-page',{name:result.name,path:requiredPath,receivedAt:v.receivedAt,text:`from the game page at ${v.fromGamePageAt}`});
        }
        return v;
      };
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
      for(const requiredPath of retryPaths)trace('required-endpoint-final-retry',{name:result.name,path:requiredPath,reason:verificationByPath.get(requiredPath)?.reason||'unverified'});
      if(retryPaths.length){
        if(session.cancelled)throw new SyncCancelledByClear();
        // The game's own response from this Sync first; a direct read gets 403 under bot protection.
        result.finalRecovery=await recoverRequiredEndpointsFinal({
          paths:retryPaths,
          // Any walked page of this Sync counts (2.5.466), not only this target's own visit.
          sinceMs:startedAt,
          captureFor:syncCaptureFor,
          revisit:async paths=>{
            const tab=await simTab();
            if(!tab?.id)return {ok:false,error:'The game tab is no longer available.'};
            session.gameTabId=tab.id;
            session.capturePaths=paths.slice();session.walkCaptures={};
            try{
              const visitStartedAt=Date.now();
              const visit=await visitWalkPage(tab.id,target,session);
              // A slow page can answer after its traffic went quiet; wait for these paths up to the capture window.
              while(visit?.ok&&Date.now()-visitStartedAt<SYNC_CAPTURE_FALLBACK_MS&&!paths.every(p=>syncCaptureFor(p,visitStartedAt)))await new Promise(r=>setTimeout(r,100));
              return visit;
            }finally{session.walkCaptures=null;}
          },
          onMissing:async path=>{await syncNotOnPage(session,selected,path,trace);},
          record:(path,response)=>recordAuthoritative(path,response,result),
          trace:(event,detail)=>trace(event,{name:result.name,...detail})
        });
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
        result.ok=false;result.status=result.optional?'optional-not-captured':'required-write-unverified';result.reason=result.optional?(result.reason||`Optional ${result.name} not captured (${missingSummary}).`):`Required endpoint durability failed (${missingSummary}).`;
        trace('target-durable-verification-failed',{name:result.name,requiredCount:verification.requiredCount,verifiedCount:verification.verifiedCount,missingEndpoints:missing});
      }
    }
    session.capturePaths=[];session.syncCaptures=null;session.syncCapturePaths=null;session.syncEarlyCaptures=null;
    const missingRequiredEndpoints=results.filter(result=>!result.optional).flatMap(result=>(result.finalDurableVerification?.endpoints||[]).filter(item=>!item.ok).map(item=>({target:result.name,path:item.path,reason:item.reason||'unverified'})));
    const missingRequiredWrites=[...new Set(missingRequiredEndpoints.map(item=>item.target))];
    const successfulAfterDurability=results.filter(result=>result.ok&&result.finalDurableVerification?.ok).length;
    const failedAfterDurability=targets.filter(t=>!t.optional).length-results.filter(result=>!result.optional&&result.ok&&result.finalDurableVerification?.ok).length;
    const requiredOk=syncRequiredTargetsOk(targets,results);
    const accountingVerification=results.find(result=>result.name==='Accounting')?.finalDurableVerification;
    const accountingSuffix=accountingVerification?` · Accounting ${accountingVerification.verifiedCount}/${accountingVerification.requiredCount} APIs`:'';
    const successful=successfulAfterDurability;
    const failed=failedAfterDurability;
    const executivesSummary=executivesSyncSuffix(results.find(result=>result.name==='Executives'));
    // 2.5.466: only a REQUIRED address still missing is a warning. Addresses the game did not load that are optional, not
    // required, or verified from the game's own recent load go on the info list (syncInfo), never in syncError.
    const missingPathSet=new Set(missingRequiredEndpoints.map(item=>item.path));
    const notLoadedRequired=(session.notOnPage||[]).filter(p=>missingPathSet.has(p));
    const notLoadedOther=(session.notOnPage||[]).filter(p=>!missingPathSet.has(p)&&!(session.fromGamePage||[]).some(x=>x.path===p));
    if(notLoadedRequired.length)session.warnings.unshift(`${notLoadedRequired.length} required game address(es) not loaded by the game pages this Sync: ${notLoadedRequired.slice(0,6).join(', ')}`);
    const syncInfo=[];
    for(const x of session.fromGamePage||[])syncInfo.push(`${x.target}: ${x.path} from the game page at ${x.at}`);
    const optionalMissed=[...new Set([...(session.optionalNotLoaded||[]),...notLoadedOther])];
    for(const x of session.optionalFailed||[])syncInfo.push(`optional ${x.path}: the game answered HTTP ${x.status}; stored value kept`);
    if(optionalMissed.length)syncInfo.push(`${optionalMissed.length} optional game address(es) not loaded by the game: ${optionalMissed.slice(0,6).join(', ')}${optionalMissed.length>6?` +${optionalMissed.length-6} more`:''}`);
    if(syncInfo.length)trace('sync-info',{info:syncInfo});
    const endpointWarnings=[...new Set((session.warnings||[]).map(w=>safeWalkText(w)))];
    if(endpointWarnings.length)trace('endpoint-warnings',{count:endpointWarnings.length,warnings:endpointWarnings});
    // Plain line when every required target is in ("R2 Sync complete · 4/4"); the detail stays for a failed Sync.
    // ("complete" is kept: the dashboard and the post-Sync checks match /Sync complete/.)
    const finalStatusBase=requiredOk
      ?`${realmDisplayNumber(selected)||'Realm'} Sync complete · ${successful}/${targets.length}`
      :`${realmDisplayNumber(selected)||'Realm'} Sync finished with errors · ${successful}/${targets.length} targets captured${accountingSuffix}${executivesSummary}`;
    let finalStatus=`${finalStatusBase}${syncWarningsSuffix(endpointWarnings)}`;
    const finalSyncError=requiredOk?null:`${failedAfterDurability} target(s) failed; ${missingRequiredEndpoints.length} required endpoint(s) were not durably verified.${endpointWarnings.length?` Endpoint problems: ${endpointWarnings.join('; ')}.`:''}`;

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

    if(session.cancelled)throw new SyncCancelledByClear();
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
      walkReport,
      endpointWarnings,
      syncInfo,
      endpointCount:Object.keys(diagnosticStore.endpointData||{}).length,
      warehouseRows:Array.isArray(diagnosticStore.warehouseResources)?diagnosticStore.warehouseResources.length:0,
      startedAt,
      finishedAt,
      syncPolicy:{apiFirst:true,clickTimeoutMs:SYNC_CLICK_TIMEOUT_MS,fallbackCaptureMs:SYNC_CAPTURE_FALLBACK_MS,pageApiTimeoutMs:SYNC_PAGE_API_TIMEOUT_MS,pageApiAttempts:SYNC_PAGE_API_ATTEMPTS},
      syncTrace
    },selected),5000,'Final Sync diagnostic persistence');
    if(session.diagnosticPersistGaps){for(const x of syncTrace)if(x.type==='diagnostic-persist-failed')x.type='diagnostic-persist-late';session.diagnosticPersistGaps=0;}

    await withSyncTimeout(enqueueApiStorage(async()=>{
      const finalPersist=await state(selected); // The synced realm's own store, even if the tab switched realms meanwhile
      const finalStores={...(finalPersist.realmStores||{})};
      finalStores[key]={...(finalStores[key]||{}),syncStatus:finalStatus,syncError:finalSyncError,lastSync:finishedAt,fullSyncJob:null,executivesSyncSummary:executivesSummary};
      await storageSet({activeRealmKey:key,selectedRealm:selected,syncStatus:finalStatus,syncError:finalSyncError,lastSync:finishedAt,fullSyncJob:null,realmStores:finalStores});
    },selected,{priority:true}),8000,'Final Sync commit');
    if(requiredOk) await persistCriticalDataBaseline(selected,'sync-complete').catch(()=>{});
    trace('sync-core-persisted',{realm:selected,finalStatus,finishedAt});
    syncCoreSucceeded=requiredOk;
    if(!requiredOk)trace('sync-failed',{error:finalSyncError});
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
      // Hydrate the root FROM the committed realm store (never the reverse, which
      // could overwrite fresh data with the stale root) before handing the capture
      // lock to the optional post-sync UI refresh, so another Sync cannot observe
      // a still-finalizing root while the tail starts.
      const committedBeforeHydrate=await state(selected);
      const committedStoreBeforeHydrate=committedBeforeHydrate.realmStores?.[key]||{};
      await activateRealmByRealm(selected, committedStoreBeforeHydrate.authData?.authCompany ? committedStoreBeforeHydrate.authData : null);
      const committed=await state(selected);
      const committedStore=committed.realmStores?.[key]||{};
      trace('realm-store-commit',{realm:selected,endpointCount:Object.keys(committedStore.endpointData||{}).length,warehouseRows:Array.isArray(committedStore.warehouseResources)?committedStore.warehouseResources.length:0,fullSyncStatus:committedStore.syncStatus||null});
      trace('sync-complete',{ok:true,successful,failed,total,elapsedMs:Date.now()-startedAt});
      refreshMarketOrders(selected,0,{background:true}).catch(()=>{});fillMissingGameData('after-sync',{afterSync:true}).catch(()=>{});
      // Awaited (bounded) so its failures can reach this run's status; the final status is written again after the tail.
      try{
        const extra=await scmSwitchedOff('afterSyncExtras','extra-game-data',selected,'after-sync')?{ok:true,skipped:true,switchedOff:true}:await withSyncTimeout(refreshExtraGameData(selected,{movedReads:session.movedReads||null,captured:session.abundanceCaptures||null}),15000,'After-Sync reads');
        for(const w of extra?.warnings||[]){const t=safeWalkText(w);if(!endpointWarnings.includes(t))endpointWarnings.push(t);}
      }catch(e){endpointWarnings.push(safeWalkText(e?.message||e));}
      finalStatus=`${finalStatusBase}${syncWarningsSuffix(endpointWarnings)}`;
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
        const buildingResult=await postSyncBuildingUiRefresh(selected,trace,pageReturn);
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
        trace('post-sync-building-state',{realm:selected,count:Array.isArray(enrichStore.buildings)?enrichStore.buildings.length:0});
        await withSyncTimeout(saveFullSyncDiagnostic({
          realm:selected,
          mode:'api-first-sync-with-ui-fallback',
          status:finalStatus,
          syncError:finalSyncError,
          lastSync:finishedAt,
          walkResults:results,
          walkReport,
          endpointWarnings,
          syncInfo,
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
      // A late status/progress write can race the core final commit during the
      // post-sync enrichment tail and revert the durable realm-local status.
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
      return {ok:true,realm:selected,results,walkReport,marketCrawl,endpointWarnings,syncInfo,total,successful,failed,elapsedMs:Date.now()-startedAt};
    }
    return {ok:false,realm:selected,results,walkReport,marketCrawl,endpointWarnings,syncInfo,total,successful,failed,missingRequiredWrites,missingRequiredEndpoints,elapsedMs:Date.now()-startedAt,error:finalSyncError};
  }catch(e){
    const error=e?.message||String(e);
    // A transient failure that the automatic retry will run again is not an error-log entry; the retry's own failure is.
    if(!(syncFailureIsTransient(error)&&!syncAutoRetrySkipReason({error,backoff:lastGameBackoffAnswer,startedAt})&&validRealmNumber(selected)!=null&&!syncAutoRetryRuns.has(selected)&&!(e instanceof SyncCancelledByClear)))logError('sync',e);
    // Nothing of this run may reach storage after a clear, not even its failure status.
    if(e instanceof SyncCancelledByClear)return {ok:false,cancelled:true,error,realm:selected};
    syncTrace.push({at:Date.now(),type:'sync-exception',error});
    // Mark the realm this run was syncing (the stored selectedRealm can name the other realm by now).
    const sel=ownsSyncSession&&validRealmNumber(selected)!=null?validRealmNumber(selected):validRealmNumber((await chrome.storage.local.get({selectedRealm:null})).selectedRealm);
    if(sel!=null){
      const status=`Sync failed · ${realmDisplayNumber(sel)||'selected realm'}`;
      await withSyncTimeout(setRealmLoadStatus(sel,status,error),5000,'Sync failure status persistence').catch(()=>{});
      // The small root status still held the last progress line ("R2 Sync: 4/4 Accounting ✓" from an older run).
      await persistTransientSyncUi(sel,status,error);
      try{
        const failedState=await state(sel);
        const failedStore=failedState.realmStores?.[realmKeyFromRealm(sel)]||{};
        const finishedAt=new Date().toISOString();
        await withSyncTimeout(saveFullSyncDiagnostic({realm:sel,mode:'api-first-sync-with-ui-fallback',status,syncError:error,walkResults:[],endpointCount:Object.keys(failedStore.endpointData||{}).length,warehouseRows:Array.isArray(failedStore.warehouseResources)?failedStore.warehouseResources.length:0,startedAt,finishedAt,error,syncTrace},sel),5000,'Sync failure diagnostic persistence').catch(()=>{});
        await withSyncTimeout(clearFullSyncJob(sel,{syncStatus:status,syncError:error}),5000,'Sync failure job cleanup').catch(()=>{});
      }catch{}
    }else await storageSet({syncStatus:'Sync failed',syncError:error,fullSyncJob:null});
    return {ok:false,error,realm:sel};
  }finally{
    const clearedDuringRun=ownsSyncSession&&selected!=null&&realmSyncSessions.get(selected)?.cancelled===true;
    // Sync end makes every coalesced realm patch physical (bounded so it cannot hold SYNC_NOW open).
    if(ownsSyncSession && selected!=null && !clearedDuringRun) await withSyncTimeout(flushRealmPatches(selected),5000,'Sync end realm patch flush').catch(()=>{});
    // Page-hook cleanup is best-effort after terminal status has been written.
    // A missing content-script response must not keep SYNC_NOW pending or leave
    // the dashboard button disabled after the sync transaction has ended.
    try{
      const t=await simTab();
      if(t?.id) await withSyncTimeout(chrome.tabs.sendMessage(t.id,{type:'CLEAR_SYNC_REALM'}),1500,'Clear Sync realm capture boundary').catch(()=>{});
    }catch{}
    if(ownsSyncSession && selected!=null){ realmSyncSessions.delete(selected); if(syncCaptureRealm===selected) syncCaptureRealm=null; scmMirrorSyncSessions(); }
    if(ownsSyncSession && selected!=null && !clearedDuringRun){
      const syncFinishedAt=new Date().toISOString();
      const traceFailed=Array.isArray(syncTrace)&&syncTrace.some(x=>SYNC_FAILED_STEP_RX.test(String(x?.type||'')));
      const partial=syncCoreSucceeded&&traceFailed?syncPartialSummary(syncTrace):null;
      const syncFailError=syncCoreSucceeded?null:([...syncTrace].reverse().find(x=>/sync-exception|sync-failed/i.test(String(x?.type||'')))?.error||null);
      if(!syncCoreSucceeded)syncRetrySkip=syncAutoRetrySkipReason({error:syncFailError,blocked:false,backoff:lastGameBackoffAnswer,startedAt});
      // A transient failure (no answer / timeout) that gets the automatic retry below is "retrying", not a failure;
      // the retry run (wasAutoRetry) logs failure if it fails too. A failure the game pushed back on is a failure.
      const coreOutcome=syncCoreSucceeded?(traceFailed?'partial':'success'):(!syncRetrySkip&&!syncAutoRetryRuns.has(selected)&&syncFailureIsTransient(syncFailError)?'retrying':'failure');
      await recordBackgroundJobEvent(selected,{job:'core-sync',trigger:'manual-or-dashboard',startedAt:new Date(startedAt).toISOString(),finishedAt:syncFinishedAt,durationMs:Date.now()-startedAt,outcome:coreOutcome,requested:targets.length,fetched:0,refreshed:0,checked:targets.length,cached:0,stale:0,error:syncCoreSucceeded?(partial?.error||null):([...syncTrace].reverse().find(x=>/sync-exception|sync-failed/i.test(String(x?.type||'')))?.error||null),details:{coreSyncSucceeded:Boolean(syncCoreSucceeded),traceEvents:syncTrace.length,targets:targets.map(t=>t.name),...(partial?{failedSteps:partial.failedSteps}:{})}}).catch(()=>{});
    }
    if(syncCoreSucceeded && selected!=null){
      const scheduled=await scheduleMarketCycle(selected,'sync-complete').catch(e=>({ok:false,error:e?.message||String(e)}));
      try{await recordBackgroundJobEvent(selected,{job:'post-sync-market-refresh-scheduled',trigger:'sync-complete',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),durationMs:0,outcome:scheduled?.ok?'success':'failure',error:scheduled?.error||null,details:scheduled||{}});}catch{}
    }
    if(ownsSyncSession && selected!=null){
      const wasAutoRetry=syncAutoRetryRuns.delete(selected);
      if(!syncCoreSucceeded && !wasAutoRetry && !clearedDuringRun && syncRetrySkip){
        logActivity(selected,'sync-auto-retry-skipped','skipped',{reason:syncRetrySkip,...(lastGameBackoffAnswer&&lastGameBackoffAnswer.at>=startedAt?{status:lastGameBackoffAnswer.status,path:lastGameBackoffAnswer.path}:{})},`No automatic retry: ${syncRetrySkip}.`,Date.now(),'sync-failed');
      }else if(!syncCoreSucceeded && !wasAutoRetry && !clearedDuringRun){
        await scmAlarmCreate(`${SYNC_AUTO_RETRY_ALARM_PREFIX}${selected}`,{when:Date.now()+SYNC_AUTO_RETRY_DELAY_MS}).catch(()=>{});
        logActivity(selected,'sync-auto-retry-scheduled','success',{delayMs:SYNC_AUTO_RETRY_DELAY_MS},null,Date.now(),'sync-failed');
      }
    }
    // Back to the page the player started on: last, once status and lock are done, and bounded.
    if(ownsSyncSession&&pageReturn){
      const back=await restoreGamePageBounded(pageReturn,'Sync return to page');
      if(selected!=null&&!clearedDuringRun)await rawStorageSet({[`scmSyncReturn:${selected}`]:Array.isArray(back)?{at:new Date().toISOString(),tabs:back.map(({tabId,decision,how})=>({tabId,decision,how:how||null}))}:{at:new Date().toISOString(),tabs:[],timedOut:true,error:safeWalkText(back?.error)}}).catch(()=>{});
      await pageReturn.forget();
    }
    if(ownsSyncSession)resumeSyncDeferredWork();
  }
}

async function postSyncBuildingUiRefresh(realm, traceFn=null, pageReturnArg=null){
  const selected=validRealmNumber(realm);
  if(selected==null) return {ok:false,skipped:true,error:'Invalid realm.'};
  const started=Date.now();
  const note=(type,payload={})=>{try{traceFn?.(type,payload);}catch{}};
  const key=realmKeyFromRealm(selected);
  // Called on its own (the alarm path) it must also put the page back; inside Sync the run does that.
  const pageReturn=pageReturnArg||createPageReturn(note,{realm:selected});
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
    try{warehouseClick=await pageReturn.walkClick(tab.id,{name:'Warehouse',labels:['Warehouse','Warehouses'],hrefHints:['/headquarters/warehouse/']});}catch(e){warehouseClick={ok:false,error:e?.message||String(e)};}
    note('building-ui-refresh-click',{step:'warehouse',ok:Boolean(warehouseClick?.ok),error:warehouseClick?.error||null,element:warehouseClick?.element||null,beforeUrl:warehouseClick?.beforeUrl||null,urlAfterClick:warehouseClick?.urlAfterClick||null});
    await new Promise(r=>setTimeout(r,400));
    let mapClick={ok:false,error:'Map UI click not attempted.'};
    try{mapClick=await pageReturn.walkClick(tab.id,{name:'Map',labels:['Map'],hrefHints:['/landscape/','/map/','/map']});}catch(e){mapClick={ok:false,error:e?.message||String(e)};}
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
  finally{ if(!pageReturnArg){await restoreGamePageBounded(pageReturn,'Building refresh return to page');await pageReturn.forget();} }
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
      buildings:Array.isArray(store.gameState?.buildings)?store.gameState.buildings:(Array.isArray(s.gameState?.buildings)?s.gameState.buildings:[])
    },
    warehouse:Array.isArray(store.warehouseResources)?store.warehouseResources:[],
    contracts:Array.isArray(store.contracts)?store.contracts:[],
    overlay:overlay||store.gameOverlaySnapshot||null,
    endpoints:bridgeSafeEndpointMap(store)
  };
}
// Live bridge token lives in chrome.storage.session (TRUSTED_CONTEXTS: never visible to content
// scripts, never in storage.local backups). Session storage clears on browser restart, so the token is restored
// from an extension-origin IndexedDB backup (below); storage.local keeps only a non-secret liveBridge.tokenSet flag.
const LIVE_BRIDGE_TOKEN_SESSION_KEY='scmLiveBridgeToken';
// Legacy storage.local key (readable by content scripts); migrated into extension-origin IndexedDB.
const LIVE_BRIDGE_TOKEN_BACKUP_KEY='scmLiveBridgeTokenBackup';
const LIVE_BRIDGE_SECRET_DB='scmSecrets';
function liveBridgeSecretDb(){return new Promise((resolve,reject)=>{const req=indexedDB.open(LIVE_BRIDGE_SECRET_DB,1);req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains('kv'))db.createObjectStore('kv');};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error||new Error('IndexedDB open failed'));});}
async function liveBridgeSecretOp(mode,fn){const db=await liveBridgeSecretDb();try{return await new Promise((resolve,reject)=>{const tx=db.transaction('kv',mode);const st=tx.objectStore('kv');let out;const r=fn(st);if(r)r.onsuccess=()=>{out=r.result;};tx.oncomplete=()=>resolve(out);tx.onerror=tx.onabort=()=>reject(tx.error||new Error('IndexedDB tx failed'));});}finally{db.close();}}
async function liveBridgeBackupGet(){try{return String(await liveBridgeSecretOp('readonly',st=>st.get('liveBridgeToken'))||'');}catch{return '';}}
async function liveBridgeBackupSet(token){await liveBridgeSecretOp('readwrite',st=>st.put(String(token),'liveBridgeToken'));}
async function liveBridgeBackupClear(){try{await liveBridgeSecretOp('readwrite',st=>st.delete('liveBridgeToken'));}catch{}}
async function migrateLegacyLiveBridgeBackup(){
  try{const legacy=String((await chrome.storage.local.get(LIVE_BRIDGE_TOKEN_BACKUP_KEY))?.[LIVE_BRIDGE_TOKEN_BACKUP_KEY]||'');
    if(legacy){if(!(await liveBridgeBackupGet()))await liveBridgeBackupSet(legacy);}
    await chrome.storage.local.remove(LIVE_BRIDGE_TOKEN_BACKUP_KEY);
  }catch(e){logError('live-bridge-backup-migrate',e);}
}
async function migrateLiveBridgeToken(){
  const cur=(await chrome.storage.local.get({liveBridge:null})).liveBridge;
  const legacy=cur&&typeof cur==='object'?String(cur.token||''):'';
  if(!legacy)return null;
  if(chrome.storage.session)await chrome.storage.session.set({[LIVE_BRIDGE_TOKEN_SESSION_KEY]:legacy});
  await liveBridgeBackupSet(legacy);
  await storageSet({liveBridge:{...cur,token:'',tokenSet:true}});
  return legacy;
}
async function getLiveBridgeToken(){
  try{const migrated=await migrateLiveBridgeToken();if(migrated)return migrated;}catch(e){logError('live-bridge-token-migrate',e);}
  await migrateLegacyLiveBridgeBackup();
  let t='';try{t=String((await chrome.storage.session?.get(LIVE_BRIDGE_TOKEN_SESSION_KEY))?.[LIVE_BRIDGE_TOKEN_SESSION_KEY]||'');}catch{}
  if(t)return t;
  // Session storage is cleared on browser restart; restore from the extension-origin IndexedDB
  // backup (not reachable from content scripts) so the user never has to re-enter the token.
  try{t=await liveBridgeBackupGet();if(t&&chrome.storage.session)await chrome.storage.session.set({[LIVE_BRIDGE_TOKEN_SESSION_KEY]:t});}catch{}
  return t;
}
migrateLegacyLiveBridgeBackup();
async function pushLiveBridge(realm, force=false){
  const n=validRealmNumber(realm); if(n==null)return {ok:false,error:'Valid realm required.'};
  const s=await state(realm); const cfg=s.liveBridge||{};
  const url=String(cfg.url||'').trim(); const token=String(await getLiveBridgeToken()).trim();
  if(!cfg.enabled||!url)return {ok:false,skipped:true,error:'Live bridge is not enabled or URL is missing.'};
  if(!/^https:\/\//i.test(url))return {ok:false,error:'Live bridge URL must use HTTPS.'};
  if(!token&&cfg.tokenSet)return {ok:false,error:'Live bridge token is missing. Re-enter it in Settings.'};
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
  // resource+quality VWAP, or a change that only affects `vwap` would not be persisted.
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
      stockLeft:Number(r.stockLeft)||0,
      surplus:Number(r.surplus)||0,
      vwap:Number.isFinite(Number(r.vwap))?Number(r.vwap):null,
      marketPriceSource:r.marketPriceSource||null,
      marketPriceStale:r.marketPriceStale===true
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
  contractHelperCache.delete(n);
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
  // A snapshot saved without contractSource is cleaned before it is served while the heavy refresh runs: it can
  // hold an incoming-only row for a resource that is not produced, which must not stay visible meanwhile.
  const currentSavedContractSchema=String(snap.contractSource||'')==='manager-saved-contracts-only';
  if(currentSavedContractSchema){
    // Current snapshots were computed from the dedicated savedContracts list.
    // Preserve both saved incoming and outgoing impacts while a refresh runs;
    // stripping outgoing here would make the visible values flip on every refresh.
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
const GAME_OVERLAY_MANUAL_REFRESH_GAP_MS=15000;
const gameOverlayManualRefreshAt=new Map(); // realm → last accepted REFRESH_GAME_OVERLAY_NOW (ms)
const gameOverlayRefreshPromises=new Map();
const gameOverlayLastRefreshAt=new Map();
// The game page polls GET_GAME_OVERLAY_DATA every 10 s. Each heavy rebuild reads the realm
// store, recomputes the overlay and fetches the warehouse through the page. Rebuild when data actually
// changed (any path that saves warehouse/building/contract data marks the realm dirty) or at most every
// GAME_OVERLAY_REFRESH_MS otherwise. The last snapshot is served from memory instead of storage.
const gameOverlayDirty=new Set();
const gameOverlaySnapshotMemo=new Map();
globalThis.__scmOwnWriteHooks?.push(items=>{for(const k of Object.keys(items)){const m=/^scmGameOverlaySnapshot:(\d+)$/.exec(k);if(m)gameOverlaySnapshotMemo.delete(Number(m[1]));}});
const contractHelperCache=new Map();
const gameOverlayNotifyTimers=new Map();
const warehouseMutationRefreshTimers=new Map();
// Several quick actions ("accept all" across buildings) are batched into one warehouse fetch.
// If an action lands while a fetch is already running, one more fetch runs afterwards so it is never missed.
const warehouseMutationLastAt=new Map();
const warehouseMutationRefreshStartAt=new Map(),WAREHOUSE_MUTATION_MIN_GAP_MS=3000;
// The game's own GET /api/v3/resources/<id>/ stored within 10 s of a reported stock action (GAME_STOCK_MUTATION) is that
// action's warehouse update: a warehouse-refresh success line (trigger stock-mutation-or-forced, source game, so the
// monitor toasts at once) and the Manager read still waiting for it is cancelled. When the game sends no GET the
// Manager read stays the fallback. A Manager read already on the wire when the game's copy lands logs its own line as
// stock-mutation-confirm (no second toast).
const GAME_WAREHOUSE_MUTATION_WINDOW_MS=10000,warehouseMutationGameCoveredAt=new Map();
function noteGameWarehouseCapture(realm,data,now=Date.now(),{notify=true}={}){
  const n=validRealmNumber(realm);if(n==null)return {logged:false,reason:'realm'};
  const at=warehouseMutationLastAt.get(n)||0;if(!at||now-at>GAME_WAREHOUSE_MUTATION_WINDOW_MS)return {logged:false,reason:'no-recent-action'};
  if((warehouseMutationGameCoveredAt.get(n)||0)>=at)return {logged:false,reason:'already-covered'};
  const timer=warehouseMutationRefreshTimers.get(n);let cancelled=false;
  if(timer){clearTimeout(timer);warehouseMutationRefreshTimers.delete(n);cancelled=true;}
  warehouseMutationGameCoveredAt.set(n,now);
  let rows=null;try{rows=normalizeWarehouse(data).length;}catch{}
  const iso=new Date(now).toISOString();
  recordBackgroundJobEvent(n,{job:'warehouse-refresh',trigger:'stock-mutation-or-forced',startedAt:new Date(at).toISOString(),finishedAt:iso,durationMs:now-at,outcome:'success',requested:0,fetched:0,refreshed:1,checked:1,cached:0,error:null,details:{rows,source:'game',managerReadCancelled:cancelled}}).catch(()=>{});
  if(notify)scheduleGameOverlayRefreshNotification(n,50);
  return {logged:true,cancelled,rows,realm:n};
}
function scheduleWarehouseRefreshAfterStockMutation(realm,delayMs=300){
  const n=validRealmNumber(realm); if(n==null)return;
  warehouseMutationLastAt.set(n,Date.now());
  const prior=warehouseMutationRefreshTimers.get(n); if(prior)clearTimeout(prior);
  // Page-reported actions start at most one warehouse read per 3 s per realm (trailing).
  const floor=(warehouseMutationRefreshStartAt.get(n)||0)+WAREHOUSE_MUTATION_MIN_GAP_MS-Date.now();
  const timer=setTimeout(()=>{
    warehouseMutationRefreshTimers.delete(n);
    const inFlight=warehouseOverlayRefreshRuns.get(n);
    const start=()=>{
      const startedAt=Date.now();warehouseMutationRefreshStartAt.set(n,startedAt);
      refreshRealmWarehouseForOverlay(n,0).then(result=>{
        if(result?.ok&&result?.refreshed)scheduleGameOverlayRefreshNotification(n,50);
        if((warehouseMutationLastAt.get(n)||0)>startedAt&&!warehouseMutationRefreshTimers.has(n))scheduleWarehouseRefreshAfterStockMutation(n,150);
      }).catch(()=>{});
    };
    if(inFlight)inFlight.finally(start); else start();
  },Math.max(150,Number(delayMs)||300,floor));
  warehouseMutationRefreshTimers.set(n,timer);
}

// A stock mutation and an overlay repaint often request the same warehouse snapshot.
// Share one authoritative fetch per realm so these triggers do not race or duplicate requests.
const warehouseOverlayRefreshRuns=new Map();
function warehouseNotReadReason(result){
  if(result?.notReady)return notReadReason('no-company-id');
  if(result?.otherRealm)return `Not read: ${String(result.error||'the game tab is in the other realm').replace(/^Skipped: /,'').replace(/(?:; nothing saved)?[.]?$/,'')}`;
  return notReadReason(result);
}
async function refreshRealmWarehouseForOverlay(realm,maxAgeMs=15000,opts=null){
  const n=validRealmNumber(realm);if(n==null)return {ok:false,error:'Invalid realm.'};
  const existing=warehouseOverlayRefreshRuns.get(n);if(existing)return existing;
  if(coreSyncActive()){if(maxAgeMs===0)deferUntilSyncEnds(`warehouse:${n}`,()=>scheduleWarehouseRefreshAfterStockMutation(n,300));return {ok:false,skipped:true,deferredByCoreSync:true,error:'Warehouse refresh deferred until Sync completes.'};}
  if(warehouseOverlayRefreshInBackoff(n,maxAgeMs))return {ok:false,backoff:true,error:'Warehouse refresh paused after a failed attempt.'};
  const startedMs=Date.now(),startedAt=new Date(startedMs).toISOString();
  const run=refreshRealmWarehouseForOverlayUnlocked(n,maxAgeMs,opts).then(async result=>{
    noteWarehouseOverlayRefreshResult(n,maxAgeMs,result);
    const finishedAt=new Date().toISOString();
    // Lane slot taken: a "waiting" line. No company id yet / other realm / page unloaded / reads blocked / no tab or
    // bridge: a "not read" line with the reason (no backoff step, see noteWarehouseOverlayRefreshResult).
    const notRead=!result?.ok&&!result?.laneWait&&Boolean(result?.notReady||result?.otherRealm||result?.pageClosed||result?.bridgeUnavailable);
    const outcome=result?.ok?(result?.cached?'skipped':'success'):result?.laneWait?'waiting':notRead?'not-read':(result?.stale||result?.incomplete?'partial':'failure');
    const error=result?.laneWait?laneWaitText(result.nextAt):notRead?warehouseNotReadReason(result):(result?.error||null);
    const coveredByGame=maxAgeMs===0&&(warehouseMutationGameCoveredAt.get(n)||0)>=startedMs;
    await recordBackgroundJobEvent(n,{job:'warehouse-refresh',trigger:maxAgeMs===0?(coveredByGame?'stock-mutation-confirm':'stock-mutation-or-forced'):'overlay-refresh',startedAt,finishedAt,durationMs:Date.now()-startedMs,outcome,requested:1,fetched:result?.refreshed?1:0,refreshed:result?.refreshed?1:0,checked:1,cached:result?.cached?1:0,error,details:{rows:result?.rows??null,requestDurationMs:result?.requestDurationMs??null,storageCommitDurationMs:result?.storageCommitDurationMs??null,totalDurationMs:result?.totalDurationMs??null,...(result?.laneWait?{laneWait:true,nextAt:Number(result.nextAt)||0}:{}),}}).catch(()=>{});
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
  const startedMs=Date.now(),startedAt=new Date(startedMs).toISOString();let tabs=[],sent=0,failed=0,unloading=0;
  try{tabs=await chrome.tabs.query({url:['https://www.simcompanies.com/*','https://simcompanies.com/*']});}catch(e){failed++;}
  // A tab that is navigating (its page unloading, or the new page's content script not loaded yet) closes the message
  // channel: a skip, not a failure. The new page draws its overlay from storage when it loads.
  for(const tab of tabs||[]){try{await chrome.tabs.sendMessage(tab.id,{type:'REFRESH_GAME_OVERLAY',realm:Number(n)});sent++;}catch(e){if(pageMessageChannelClosed(e))unloading++;else failed++;}}
  const finishedAt=new Date().toISOString();
  const outcome=sent?(failed?'partial':'success'):(unloading&&!failed?'skipped':'failure');
  const error=sent?null:(outcome==='skipped'?'Skipped: the game page was loading or unloading.':'No game tab acknowledged the overlay refresh message.');
  await recordBackgroundJobEvent(n,{job:'overlay-refresh-notification',trigger:'warehouse-snapshot-committed',startedAt,finishedAt,durationMs:Date.now()-startedMs,outcome,requested:(tabs||[]).length,fetched:sent,refreshed:sent,checked:(tabs||[]).length,cached:0,error,details:{tabsFound:(tabs||[]).length,messagesSent:sent,sendFailures:failed,pageUnloading:unloading}}).catch(()=>{});
  return {ok:sent>0,sent,failed,unloading,tabsFound:(tabs||[]).length,durationMs:Date.now()-startedMs};
}
function scheduleGameOverlayRefreshNotification(realm,delayMs=650,{markDirty=true}={}){
  const n=validRealmNumber(realm); if(n==null)return;
  if(markDirty)gameOverlayDirty.add(n);
  const prior=gameOverlayNotifyTimers.get(n); if(prior)clearTimeout(prior);
  const timer=setTimeout(()=>{
    gameOverlayNotifyTimers.delete(n);
    if(coreSyncActive()){deferUntilSyncEnds(`overlay:${n}`,()=>scheduleGameOverlayRefreshNotification(n,150,{markDirty:false}));return;}
    // Pages re-read after this notice; make the coalesced realm patch physical first.
    flushRealmPatches(n).catch(()=>{}).then(()=>notifyGameOverlayRefresh(n)).catch(()=>{});
  },Math.max(150,Number(delayMs)||650));
  gameOverlayNotifyTimers.set(n,timer);
}

async function refreshGameOverlayDataHeavy(realm){
  const n=validRealmNumber(realm);
  if(n==null)return {ok:false,error:'No game realm available.'};
  const existing=gameOverlayRefreshPromises.get(n);
  // Data changed while an older rebuild is running -> that rebuild used the old stock; run one
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

// Realm-scoped data for the in-game helper overlays (presentation data only).
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
chrome.tabs.onActivated.addListener(()=>{
  requestActiveGameRealm('tab-activated').catch(()=>{});
});
chrome.tabs.onUpdated.addListener((tabId,changeInfo,tab)=>{
  if(!tab?.active)return;
  if(changeInfo.status==='complete'||changeInfo.url) requestActiveGameRealm('active-game-tab-updated').catch(()=>{});
});

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
  // Page-sent (JAVASCRIPT_DIAGNOSTIC) or MAIN-world results: bounded copy, truncated over 2 MB.
  diagnostic=sanitizePageJsDiagnostic(diagnostic);
  if(!diagnostic) return {ok:false,error:'JavaScript diagnostic is missing, not an object, or too large.'};
  // The realm store comes from the caller (background-run collectors) or the Manager's active realm (activeRealmKey,
  // moved by REALM_SWITCH_CONFIRMED), never from the payload's runtime.realm: a page script can forge that. A
  // differing page value is kept as runtime.pageRealm for troubleshooting.
  const n=validRealmNumber(realm) ?? await activeRealmNumber();
  if(n==null) return {ok:false,error:'No active realm for the JavaScript diagnostic.'};
  if(isPlainObject(diagnostic.runtime)&&diagnostic.runtime.realm!==n){diagnostic.runtime.pageRealm=validRealmNumber(diagnostic.runtime.realm);diagnostic.runtime.realm=n;}
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
async function requestJavascriptDiagnostic(){
  const tabs=await chrome.tabs.query({active:true,lastFocusedWindow:true});
  let candidates=(tabs||[]).filter(t=>/^https:\/\/(?:www\.)?simcompanies\.com\//i.test(String(t.url||'')));
  if(!candidates.length)candidates=await chrome.tabs.query({url:['https://www.simcompanies.com/*','https://simcompanies.com/*']});
  const tab=candidates?.[0];
  if(!tab?.id)return {ok:false,error:'Open Sim Companies in a browser tab before running the JavaScript diagnostic.'};

  // The deep page-hook collector can contend with the game's SPA during heavy
  // renders and time out on mobile. Runtime
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

// In-app self-test (Settings → Run self-test). READ-ONLY toward the game: at most one GET through the
// existing page path (pageGet), with its own cooldown; no orders, no game writes, no heavy jobs.
const scmSelfTestSeen={apiSeenAt:null,apiDataAt:null};
let scmSelfTestLiveAt=0;
const SCM_SELF_TEST_LIVE_COOLDOWN_MS=60000;
async function scmRunSelfTest(opts={}){
  const C=globalThis.SCM_SELF_TEST_CORE,now=Date.now(),out=[];
  const add=(...a)=>out.push(C.row(...a));
  const safe=async(id,name,fn)=>{try{await fn();}catch(e){add(id,name,'fail',`Check threw: ${String(e?.message||e).slice(0,200)}`);}};
  const GAME_URLS=['https://www.simcompanies.com/*','https://simcompanies.com/*'];
  // 1. Extension health
  await safe('ext-version','Extension version & service worker',async()=>{add('ext-version','Extension version & service worker','pass',`v${BUILD_VERSION}, service worker answered`,{version:BUILD_VERSION,manifestVersion:chrome.runtime.getManifest().manifest_version});});
  await safe('ext-permissions','Permissions',async()=>{const want=['storage','alarms','tabs','scripting'];const p=await chrome.permissions.getAll();const missing=want.filter(x=>!(p.permissions||[]).includes(x));const hostOk=(p.origins||[]).some(o=>/simcompanies\.com/.test(o));add('ext-permissions','Permissions',missing.length||!hostOk?'fail':'pass',missing.length?`Missing: ${missing.join(', ')}`:hostOk?'Required permissions and game host access granted':'No host access to simcompanies.com',{missing:missing.length,hostAccess:hostOk,notifications:(p.permissions||[]).includes('notifications')});});
  await safe('ext-alarms','Background alarms',async()=>{const present=await chrome.alarms.getAll();const expected=[];for(const [name,id] of [...STANDING_ALARMS.map(a=>[a[0],a[2]]),[GAME_CONSTANTS_ALARM,'gameConstants'],[CRITICAL_DATA_GUARD_ALARM,'criticalGuard'],[SIMCO_PUBLIC_ALARM,null]])if(id==null||await scmTimerEnabled(id).catch(()=>true))expected.push(name);/* scm-simco-public stays registered with its timer off (each run checks liveMarket itself) *//* a timer switched off in Settings is not missing */const r=C.evalAlarms(expected,present);add('ext-alarms','Background alarms',r.status,r.missing.length?`Missing: ${r.missing.join(', ')}`:`All ${r.expected} standing alarms registered`,{expected:r.expected,present:r.present,missing:r.missing});});
  await safe('ext-storage','Storage usage',async()=>{let bytes=null;try{bytes=await chrome.storage.local.getBytesInUse(null);}catch{}let top=[];try{top=await scmStorageTopKeys(8);}catch{}const last=(await chrome.storage.local.get({scmStoragePruneLast:null})).scmStoragePruneLast;const topTxt=top.length?`; largest: ${top.map(t=>`${t.key} ${(t.bytes/1024).toFixed(0)} KB`).join(', ')}`:'';let inner=null;try{inner=await scmRealmStoreTopFields(6);}catch{}const innerTxt=inner?.top?.length?`; inside ${inner.key}: ${inner.top.map(t=>`${t.key} ${(t.bytes/1024).toFixed(0)} KB`).join(', ')}`:'';const egTxt=inner?.endpointGroups?.length?`; endpointData by path: ${inner.endpointGroups.map(g=>`${g.path} x${g.count} ${(g.bytes/1024).toFixed(0)} KB`).join(', ')}`:'';add('ext-storage','Storage usage',bytes==null?'skip':'pass',bytes==null?'getBytesInUse not supported':`${(bytes/1048576).toFixed(2)} MB in storage.local${topTxt}${innerTxt}${egTxt}`,{bytes,top,realmStoreFields:inner,lastPruneAt:last?.at||null,lastPruneFreed:last?.freed??null});});
  await safe('ext-errors','Error log (24 h)',async()=>{const ver=chrome.runtime.getManifest().version;const r=C.evalErrorLog(await getErrorLog(),now,86400000,ver);const olderTxt=r.older24h?` (${r.older24h} more from older versions, ignored)`:'';add('ext-errors','Error log (24 h)',r.status,(r.count24h?`${r.count24h} error(s) in 24 h on v${ver}; top: ${r.top.map(t=>`${t.context} x${t.count}`).join(', ')}`:`No errors in the last 24 h on v${ver}`)+olderTxt,{count24h:r.count24h,older24h:r.older24h,total:r.total,top:r.top});});
  // 2. Game tab
  let tab=null,bridge=null,tabRealm=null;
  await safe('tab-open','Game tab open',async()=>{tab=await simTab();const n=(await chrome.tabs.query({url:GAME_URLS})).length;add('tab-open','Game tab open',tab?'pass':'fail',tab?'A simcompanies.com tab is open':'Open www.simcompanies.com and log in, then run again',{tabs:n});});
  await safe('tab-content','Content script & page bridge',async()=>{
    if(!tab?.id){add('tab-content','Content script & page bridge','skip','No game tab');return;}
    try{bridge=await Promise.race([chrome.tabs.sendMessage(tab.id,{type:'BRIDGE_STATUS'}),new Promise(r=>setTimeout(()=>r(null),SELF_TEST_BRIDGE_WAIT_MS))]);}catch{bridge=null;}
    tabRealm=validRealmNumber(bridge?.realm);
    add('tab-content','Content script & page bridge',!bridge?'fail':bridge.ready?'pass':'warn',!bridge?'Content script did not answer (reload the game tab)':bridge.ready?'Content script answered; page-hook bridge connected':'Content script answered but the page-hook bridge is not ready',{contentScript:!!bridge,bridgeReady:!!bridge?.ready,realmKnown:tabRealm!=null});});
  // 3. Captured data per realm
  const stores={};
  // The realm you play now (game tab, else the active / selected realm): only its gaps are a warning; the other
  // realm's partial data (an old visit, no auth-data) is reported as info (skip).
  let playRealm=tabRealm;if(playRealm==null){try{playRealm=await activeRealmNumber();}catch{}}
  if(playRealm==null){try{playRealm=validRealmNumber((await chrome.storage.local.get({selectedRealm:null})).selectedRealm);}catch{}}
  for(const n of Object.keys(REALM_DEFINITIONS).map(Number)){
    const id=`realm-${n}`,name=`Captured data ${realmDisplayNumber(n)}`;
    await safe(id,name,async()=>{const st=await notifyRealmStore(n);stores[n]=st;const s=C.realmDataSummary(st);
      const mo=(await chrome.storage.local.get({[`scmMarketOrders:${n}`]:null}))[`scmMarketOrders:${n}`];s.marketOrders=Array.isArray(mo?.data)?mo.data.length:Array.isArray(mo?.orders)?mo.orders.length:0;
      const v0=C.evalRealmData(s),other=playRealm!=null&&n!==playRealm,v=other&&v0==='warn'?'skip':v0;
      add(id,name,v,v0==='skip'?'No data captured for this realm yet':`${other&&v0==='warn'?`Not the realm you play (${realmDisplayNumber(playRealm)}), info only: `:''}auth ${s.hasAuthData?'yes':'no'}, ${s.buildings} buildings, ${s.resources} resources, ${s.marketOrders} market orders, ${s.contracts} contracts; last sync ${s.lastSync||'never'}${s.hasSyncError?' (last sync reported an error)':''}`,s);});
  }
  await safe('api-fresh','Recent game API capture',async()=>{const cand=[scmSelfTestSeen.apiDataAt,scmSelfTestSeen.apiSeenAt,...Object.values(stores).map(s=>Date.parse(C.realmDataSummary(s).latestReceived||''))].filter(Number.isFinite).sort((a,b)=>b-a);const f=C.evalFreshness(cand[0],now,30,24*60);const iso=v=>v?new Date(v).toISOString():null;add('api-fresh','Recent game API capture',f.status,f.ageMin==null?'No API data captured yet':`Last captured ${f.ageMin} min ago`,{ageMin:f.ageMin,apiSeenAt:iso(scmSelfTestSeen.apiSeenAt),apiDataAt:iso(scmSelfTestSeen.apiDataAt)});});
  // 4. Live read-only fetch: one GET through the existing page path, own cooldown, skipped during a sync
  await safe('live-fetch','Live read-only fetch',async()=>{
    if(opts.liveFetch===false){add('live-fetch','Live read-only fetch','skip','Not selected');return;}
    if(!bridge?.ready){add('live-fetch','Live read-only fetch','skip','Game tab bridge not ready');return;}
    if(now-scmSelfTestLiveAt<SCM_SELF_TEST_LIVE_COOLDOWN_MS){add('live-fetch','Live read-only fetch','skip',`Cooldown: wait ${Math.ceil((SCM_SELF_TEST_LIVE_COOLDOWN_MS-(now-scmSelfTestLiveAt))/1000)} s`);return;}
    if(tabRealm!=null&&syncSessionForRealm(tabRealm)){add('live-fetch','Live read-only fetch','skip','A sync is running; skipped to respect rate limits');return;}
    scmSelfTestLiveAt=now;const t0=Date.now();
    const r=await pageGet('/api/v3/companies/auth-data/',tabRealm,null,'self-test',{timeoutMs:8000,attempts:1}).catch(e=>({ok:false,status:0,error:e?.message||String(e)}));
    // 2.5.466: the shared 5-min game slot was taken = planned pace, not a failure (live self-test said FAIL). No read was
    // sent; its want is dropped so the self-test leaves nothing queued, and the cooldown is not spent.
    if(r?.refused){scmSelfTestLiveAt=0;add('live-fetch','Live read-only fetch','skip',`${gameRefusalText(r.nextAt)}.`);return;}
    if(isGameLaneWait(r)){gameLaneDropWant(gameLaneKeyForPath('/api/v3/companies/auth-data/',tabRealm)).catch(()=>{});scmSelfTestLiveAt=0;const s=Math.max(0,Math.ceil((Number(r?.nextAt)-Date.now())/1000));add('live-fetch','Live read-only fetch','skip',`Waiting for the game slot (one Manager game read every 5 min)${s?`; next slot in ${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`:''}. Run again then.`);return;}
    const v=C.evalLiveFetch(r);add('live-fetch','Live read-only fetch',v.status,v.status==='pass'?'GET auth-data returned 200 with the expected shape':`GET auth-data: ${r?.error?String(r.error).slice(0,160):`status ${v.httpStatus}`}`,{httpStatus:v.httpStatus,shapeOk:v.shapeOk,ms:Date.now()-t0});});
  // 5. Calculations sanity on stored data (core market pricing)
  await safe('calc','Calculations sanity',async()=>{
    const M=globalThis.SCM_MARKET_CORE;let lots=0,priced=0,bPriced=0,bTotal=0,bBusy=0;const vals=[],amounts=[];
    for(const [k,st] of Object.entries(stores)){const n=Number(k);const simcoPrices=(await simcoPricesFor(n).catch(()=>null))||undefined;
      for(const w of (Array.isArray(st?.warehouseResources)?st.warehouseResources:[]).slice(0,300)){lots++;amounts.push(w?.amount);const id=Number(w?.kind?.db_letter??w?.kind??w?.resourceId);if(!(id>0))continue;const p=M.marketPrice(st,n,id,Number(w?.quality)||0,{mode:'exact',simcoPrices})?.price;if(p!=null){priced++;vals.push(p,Number(w?.amount)*p);}}
      for(const b of (Array.isArray(st?.buildings)?st.buildings:[])){bTotal++;const rid=Number(b?.busy?.resource?.kind??b?.busy?.resource?.resourceId);if(!(rid>0))continue;bBusy++;const p=M.marketPrice(st,n,rid,Number(b?.busy?.resource?.quality??b?.busy?.quality)||0,{mode:'exact',simcoPrices})?.price;if(p!=null){bPriced++;vals.push(p);}}}
    if(!bTotal&&!lots){add('calc','Calculations sanity','skip','No stored buildings or inventory to evaluate');return;}
    const s=C.scanNumbers([...vals,...amounts]);
    add('calc','Calculations sanity',s.status,`${s.checked} values checked: ${s.nan} NaN, ${s.infinite} Infinity, ${s.negative} negative; ${bPriced}/${bBusy} producing buildings priced (${bTotal} total), ${priced}/${lots} inventory lots priced`,{...s,buildings:bTotal,buildingsProducing:bBusy,buildingsPriced:bPriced,lots,lotsPriced:priced});});
  // 6. Game-tab cards: no-op key the card listeners ignore, then count card elements in the tab
  await safe('cards','Game-tab cards',async()=>{
    if(!tab?.id||!bridge){add('cards','Game-tab cards','skip','No responsive game tab');return;}
    let delivered=false;try{await chrome.tabs.sendMessage(tab.id,{type:'SCM_CARD_KEY_CHANGED',key:'scmSelfTestPing'});delivered=true;}catch(e){delivered=!/Receiving end does not exist|Could not establish/i.test(String(e?.message||e));}
    let dom=null;try{const [r]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>({cards:document.querySelectorAll('#scm-listings-pill,#scm-listings-card,#scm-contracts-pill,#scm-contracts-card').length})});dom=r?.result||null;}catch{}
    const status=!delivered?'fail':dom?.cards?'pass':'skip';
    add('cards','Game-tab cards',status,!delivered?'SCM_CARD_KEY_CHANGED could not be delivered':dom?.cards?`Ping delivered; ${dom.cards} card element(s) present`:'Ping delivered; no card elements on this page',{delivered,cardElements:dom?.cards??null});});
  // 7. Notifications / badge
  await safe('notify','Notifications & badge',async()=>{let level=null;try{level=chrome.notifications?.getPermissionLevel?await chrome.notifications.getPermissionLevel():null;}catch{}const badge=!!chrome.action?.setBadgeText;
    add('notify','Notifications & badge',!chrome.notifications&&!badge?'skip':level==='denied'?'warn':'pass',!chrome.notifications?'Notifications API not available in this browser':`Notifications ${level||'available'}; badge ${badge?'available':'unavailable'}`,{notifications:!!chrome.notifications,permissionLevel:level,badge});});
  return {ok:true,version:BUILD_VERSION,at:new Date(now).toISOString(),totals:C.totals(out),results:out};
}
// Sync timers (Settings card): SCM_GET_TIMERS / SCM_SET_TIMERS. scmSyncTimers holds every timer except accountingWalk,
// whose setting stays scmAccountingWalkSchedule {enabled, offsetMin, realm} (one control, one key): its clock time is
// shown as statements-ready time + offsetMin and a picked time is stored back as offsetMin (5..240 min after ready).
function scmTimerLegacyInfo(id){
  const std=STANDING_ALARMS.find(a=>a[2]===id);if(std)return std[1];
  return {liveMarket:{delayInMinutes:LIVE_MARKET_REFRESH_PERIOD_MINUTES,periodInMinutes:LIVE_MARKET_REFRESH_PERIOD_MINUTES},orderBook:{delayInMinutes:5,periodInMinutes:5},
    criticalGuard:{delayInMinutes:10,periodInMinutes:10},gameConstants:{delayInMinutes:1,periodInMinutes:360}}[id]||null;
}
// Walk offset (min after the statements are ready) for a local clock time, or null outside 5 min..4 h.
function accountingWalkOffsetForClock(readyAtMs,at){
  const C=globalThis.SCM_TIMERS_CORE,s=C.normalizeAt(at),r=C.clockOf(readyAtMs);if(!s||!r)return null;
  const mins=x=>Number(x.slice(0,2))*60+Number(x.slice(3));
  const off=(mins(s)-mins(r)+1440)%1440;return off>=5&&off<=240?off:null;
}
// Realm the walk setting applies to: the stored one, else the active realm, else the selected realm (a fresh user has
// no stored walk realm until the walk is first set, but already knows when their statements are ready after a Sync).
async function scmAccountingWalkRealm(stored){
  const r=validRealmNumber(stored);if(r!=null)return r;
  const a=await activeRealmNumber();if(a!=null)return a;
  try{return validRealmNumber((await chrome.storage.local.get({selectedRealm:null})).selectedRealm);}catch{return null;}
}
async function scmTimersView(){
  const C=globalThis.SCM_TIMERS_CORE;const timers={...(await scmTimersConfig())};
  const sch=await readAccountingWalkSchedule();const realm=await scmAccountingWalkRealm(sch.realm);
  const ready=realm!=null?await accountingStatementsReadyAt(realm).catch(()=>null):null;
  timers.accountingWalk={enabled:Boolean(sch.enabled),at:ready!=null?C.clockOf(ready+accountingWalkOffset(sch.offsetMin)*60000):null};
  const status={};
  let alarms=[];try{alarms=await chrome.alarms.getAll();}catch{}
  for(const t of C.TIMERS){if(!t.alarmName)continue;const a=alarms.find(x=>x?.name===t.alarmName);status[t.id]=a?{nextRun:Number(a.scheduledTime)||null}:{nextRun:null};}
  try{const r=await chrome.storage.local.get({scmStoragePruneLast:null,scmResourceImagesValidatedAt:0,scmGameConstants:null});
    const p=Date.parse(r.scmStoragePruneLast?.at||'');if(Number.isFinite(p))status.storagePrune.lastRun=p;
    // Where the stored constants came from: the built-in copy (constants.json) or a live read of the game.
    if(r.scmGameConstants&&status.gameConstants){const bi=r.scmGameConstants.source==='bundled';status.gameConstants.source=bi?'bundled':'game';status.gameConstants.note=bi?bundledGameConstantsText(r.scmGameConstants):null;}
    if(Number(r.scmResourceImagesValidatedAt)>0)status.resourceImages.lastRun=Number(r.scmResourceImagesValidatedAt);}catch{}
  const lw=Date.parse(sch.lastResult?.at||'');if(Number.isFinite(lw))status.accountingWalk.lastRun=lw;
  status.accountingWalk.realm=realm;status.accountingWalk.offsetMin=accountingWalkOffset(sch.offsetMin);
  if(ready!=null){status.accountingWalk.readyAt=ready;status.accountingWalk.earliest=ready+5*60000;status.accountingWalk.latest=ready+240*60000;} // timestamps (ms); the dashboard formats them
  return {timers,status};
}
async function notifyGameTabsTimersChanged(timers){
  try{const tabs=await chrome.tabs.query({url:['https://www.simcompanies.com/*','https://simcompanies.com/*']});
    for(const t of tabs){if(t?.id!=null)chrome.tabs.sendMessage(t.id,{type:'SCM_TIMERS_CHANGED',timers}).catch(()=>{});}}catch{}
}
// patch: {<id>:{enabled?, every?, at?}}; values are clamped (never faster than the default for server timers).
// Writes are serialized; only timers that changed get their alarm re-created (or cleared when off).
function scmSetTimers(patch,realmHint=null){
  const run=scmTimersWriteTail.catch(()=>{}).then(async()=>{
    const C=globalThis.SCM_TIMERS_CORE;
    if(!patch||typeof patch!=='object'||Array.isArray(patch))return {ok:false,error:'No timer settings given.'};
    const errors={};const own={...patch};const walk=own.accountingWalk;delete own.accountingWalk;
    const before=await scmTimersConfig();const next=C.merge(before,own);
    const changed=C.IDS.filter(id=>id!=='accountingWalk'&&JSON.stringify(next[id])!==JSON.stringify(before[id]));
    if(changed.length){
      const stored=C.toStored(next);delete stored.timers.accountingWalk;
      // A value saved from here on is the player's own: the one-time liveMarket move (scmTimersConfig) never touches it.
      await chrome.storage.local.set({[C.KEY]:stored,scmTimersMigrations:{liveMarket5:true,orderBook5:true}});scmTimersMemoGen++;scmTimersMemo=next;
      for(const id of changed){const t=C.byId[id];if(!t.alarmName)continue;
        try{await scmEnsureTimerAlarm(id,scmTimerLegacyInfo(id),'always');}catch(e){errors[id]=e?.message||String(e);}}
      if(changed.some(id=>C.byId[id].group==='Game page'))notifyGameTabsTimersChanged(next).catch(()=>{});
    }
    if(walk&&typeof walk==='object'){
      const sch=await readAccountingWalkSchedule();
      const realm=validRealmNumber(walk.realm)??validRealmNumber(realmHint)??await scmAccountingWalkRealm(sch.realm);
      const p={attempt:0,retryAt:null};if(realm!=null)p.realm=realm;
      if(typeof walk.enabled==='boolean')p.enabled=walk.enabled;
      if(walk.at===null)p.offsetMin=ACCOUNTING_WALK_DEFAULT_OFFSET_MIN; // cleared time: back to the default offset
      else if(walk.at!==undefined){
        const ready=realm!=null?await accountingStatementsReadyAt(realm):null;
        if(!C.normalizeAt(walk.at))errors.accountingWalk='Pick a time as HH:MM.';
        else if(ready==null)errors.accountingWalk='Sync once so the Manager knows when the game finishes your statements.';
        else{const off=accountingWalkOffsetForClock(ready,walk.at);
          if(off==null)errors.accountingWalk=`Pick a time from ${C.clockOf(ready+5*60000)} to ${C.clockOf(ready+240*60000)} (5 min to 4 h after the game finishes statements at ${C.clockOf(ready)}).`;
          else p.offsetMin=off;}
      }
      if(!errors.accountingWalk){
        if(p.enabled&&realm==null)errors.accountingWalk='Sync a realm first.';
        else{await writeAccountingWalkSchedule(p);const r=await ensureAccountingWalkSchedule('timers');if(r?.error)errors.accountingWalk=r.error;}
      }
    }
    const view=await scmTimersView();const failed=Object.keys(errors);
    return {ok:!failed.length,...view,...(failed.length?{errors,error:Object.values(errors).join(' ')}:{})};
  });
  scmTimersWriteTail=run.catch(()=>{});
  return run;
}
const SCM_PRIVILEGED_MESSAGE_TYPES=new Set(['SCM_SIMCO_EXEC_LOOKUP','SCM_GET_TIMERS','SCM_SET_TIMERS','RUN_SELF_TEST','PRUNE_STORAGE','SYNC_NOW','RUN_ACCOUNTING_WALK_NOW','RUN_JAVASCRIPT_DIAGNOSTIC','LIVE_MARKET_REFRESH','CLEAR_EXTENSION_DATA','IMPORT_CSV_STATEMENTS','IMPORT_CSV_LEDGER','SCM_NET3_START','SCM_NET3_STOP','SCM_NET3_EXPORT','SCM_MOBILE_NET_START','SCM_MOBILE_NET_STOP','SET_LIVE_BRIDGE','PUSH_LIVE_BRIDGE','SCM_NOTIFY_SETTINGS','SET_ACCOUNTING_WALK_SCHEDULE','SAVE_REALM_FIELD','SAVE_PRODUCTION_PLANNER_STATE','SAVE_SAVED_CONTRACT','SCM_TEST_NOTIFICATION','SCM_TEST_DAILY_SUMMARY','GET_COMPANY_AUTH_DATA','GET_ERROR_LOG','GET_LIVE_BRIDGE_TOKEN','SCM_ENSURE_GAME_DATA','REFRESH_ACCOUNTING','REFRESH_ACCOUNTING_WEEK_LEDGER','PRICE_HISTORY','LIVE_MARKET_PRODUCT','FETCH_EXCHANGE_ORDER_BOOK','FETCH_BUILDING_HISTORY','GET_RESOURCE_IMAGE','SET_VIEW_REALM']);
// The last eight are sent by extension pages only (dashboard / tools); each starts game or SimcoTools reads or writes settings.
// GET_STATE from a non-extension-page context (content script) never carries secrets.
// NOTE (authData): authData is the game's /api/v3/companies/auth-data/ payload (company id/name, user/session
// metadata), captured from the game page itself. It stays in storage.local (top level and per realmStores) because
// many readers depend on it; content scripts run on the same game origin that already holds the session, so it
// grants them nothing new. It is stripped here (GET_STATE defense in depth) and by SCM_DIAGNOSTIC_CORE.redactSecrets
// in every export/copy path. Bearer-style secrets (the live-bridge token) are NOT kept in storage.local.
function scmStripStateSecrets(out){const o={...out};if(o.liveBridge&&typeof o.liveBridge==='object'){const{token,...rest}=o.liveBridge;o.liveBridge={...rest,hasToken:Boolean(token||rest.tokenSet)};}delete o.authData;if(o.realmStores&&typeof o.realmStores==='object'){const rs={};for(const[k,v]of Object.entries(o.realmStores)){if(v&&typeof v==='object'){const{authData,...rest}=v;rs[k]=rest;}else rs[k]=v;}o.realmStores=rs;}return o;}
function scmIsExtensionPageSender(sender){const base=chrome.runtime.getURL('');return typeof sender?.url==='string'&&sender.url.startsWith(base)&&!(sender.tab&&!String(sender.tab.url||'').startsWith(base)&&sender.frameId===0);}
replayEvent('runtime-start',{buildVersion:BUILD_VERSION,activeRealmKey:null});
setTimeout(()=>{scmRestorePendingRealmPatches();scmCheckInterruptedSyncSessions();},0);

chrome.runtime.onMessage.addListener((m,sender,send)=>{
  // Sender hardening: only this extension may message us, and privileged/destructive
  // types are accepted only from extension pages (popup/dashboard/options), never content scripts.
  if(!sender||sender.id!==chrome.runtime.id)return false;
  if(SCM_PRIVILEGED_MESSAGE_TYPES.has(m?.type)&&!scmIsExtensionPageSender(sender)){try{send({ok:false,error:'Not allowed from this context.'});}catch{}return false;}
  if(m?.type==='API_SEEN')scmSelfTestSeen.apiSeenAt=Date.now();else if(m?.type==='API_DATA')scmSelfTestSeen.apiDataAt=Date.now();
  if(m?.type==='PRUNE_STORAGE'){scmPruneStorage({reason:'manual'}).then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='RUN_SELF_TEST'){scmRunSelfTest({liveFetch:m.liveFetch!==false}).then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='GET_ERROR_LOG'){getErrorLog().then(log=>send({ok:true,log,version:BUILD_VERSION,at:new Date().toISOString()})).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='SCM_CLEAR_ALERT_BADGE'){if(!scmIsExtensionPageSender(sender))return false;scmClearAlertBadge().then(()=>send({ok:true})).catch(()=>send({ok:false}));return true;}
  // Executive name search (Executives tab): extension pages only; one SimcoTools request per new search.
  if(m?.type==='SCM_SIMCO_EXEC_LOOKUP'){if(!scmIsExtensionPageSender(sender)){try{send({ok:false,error:'Not allowed from this context.'});}catch{}return false;}
    simcoExecLookup(m).then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='SCM_GET_TIMERS'){scmTimersView().then(v=>send({ok:true,...v})).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='SCM_SET_TIMERS'){scmSetTimers(m.timers,m.realm).then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='SET_ACCOUNTING_WALK_SCHEDULE'){(async()=>{const realm=validRealmNumber(m.realm);const patch={enabled:Boolean(m.enabled),offsetMin:accountingWalkOffset(m.offsetMin),attempt:0,retryAt:null};if(realm!=null)patch.realm=realm;await writeAccountingWalkSchedule(patch);const r=await ensureAccountingWalkSchedule('user');return {...r,schedule:await readAccountingWalkSchedule()};})().then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  // CSV import from Analyze → Data: statements by date and ledger rows; captured data always wins.
  if(m?.type==='IMPORT_CSV_STATEMENTS'){(async()=>{const realm=validRealmNumber(m.realm);if(realm==null)return {ok:false,error:'Pick a realm first.'};if(!/^(income-statement|cashflow-statement|balance-sheet)$/.test(String(m.field||'')))return {ok:false,error:'Unknown statement.'};return queueStatementHistory(realm,(Array.isArray(m.items)?m.items:[]).map(data=>({kind:m.field,data})),{keep:true});})().then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='IMPORT_CSV_LEDGER'){(async()=>{const n=validRealmNumber(m.realm);if(n==null)return {ok:false,error:'Pick a realm first.'};const key=ledgerArchiveKey(n);
    const run=(ledgerArchiveQueues.get(n)||Promise.resolve()).then(async()=>{const a=(await chrome.storage.local.get({[key]:null}))[key];const {added,...out}=globalThis.SCM_ANALYZE_CORE.archiveImport(a,m.rows);await rawStorageSet({[key]:out});return {ok:true,added};});
    ledgerArchiveQueues.set(n,run.catch(()=>{}));return run;})().then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='RUN_ACCOUNTING_WALK_NOW'){(async()=>{const realm=validRealmNumber(m.realm);if(realm!=null)await writeAccountingWalkSchedule({realm});return runScheduledAccountingWalk('manual');})().then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='SCM_MOBILE_NET_START'){scmMobileNetStart(Number(m.tabId)).then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='SCM_MOBILE_NET_STOP'){scmMobileNetStop().then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='SCM_NET3_START'){scmNetStart(Number(m.tabId)).then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='SCM_NET3_STOP'){scmNetStop().then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='SCM_NET3_STATUS'){chrome.storage.local.get('scmNetworkCaptureV3Status').then(x=>send({ok:true,status:x.scmNetworkCaptureV3Status||{status:'idle'}})).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='SCM_NET3_EXPORT'){(async()=>{const id=String(m.captureId||scmNetCapture.captureId||'');if(!id)throw new Error('No Network Capture 3.0 session is available.');const offset=Math.max(0,Number(m.offset)||0),limit=Math.max(1,Math.min(500,Number(m.limit)||300));const pg=await scmNetPageEvents(id,offset,limit);send({ok:true,captureId:id,events:pg.events,total:pg.total,offset,summary:pg.summary,startedAt:scmNetCapture.startedAt,status:(await chrome.storage.local.get('scmNetworkCaptureV3Status')).scmNetworkCaptureV3Status?.status|| (scmNetCapture.active?'recording':'stopped')});})().catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='RUN_JAVASCRIPT_DIAGNOSTIC'){
    requestJavascriptDiagnostic().then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));
    return true;
  }
  if(m?.type==='JAVASCRIPT_DIAGNOSTIC'){
    (async()=>{
      try{
        const saved=await saveJavascriptDiagnostic(m.diagnostic);
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
    // manual:true (the Market Refresh button): SimcoTools only (runSimcoMarketRefresh), never a game request. Without it
    // (the dashboard's market timer): the VWAP + prices cycle, plus the channel status for the note.
    (async()=>{try{const realm=validRealmNumber(m.realm);
      if(m.manual===true||m.resourceId!=null){send(await runSimcoMarketRefresh(realm,m.resourceId,m.quality));return;}
      const r=await scheduleMarketCycle(realm,'manual-market-refresh');const s=await simcoChannelStatus();
      send({...r,...s,simcoNextAt:s.nextAt?new Date(s.nextAt).toISOString():null});}catch(e){send({ok:false,error:e?.message||String(e)});}})();return true;
  }
  // Manual refresh of the "Stock After Demand & Contracts" overlay: warehouse, outgoing contracts, own market orders.
  // Answers {ok,throttled,error} once the reads settle; never fetches order books.
  if(m?.type==='REFRESH_GAME_OVERLAY_NOW'){
    (async()=>{
      try{
        const realm=m.realm;
        if(realm!==0&&realm!==1){send({ok:false,throttled:false,error:'Invalid realm.'});return;}
        const now=Date.now();
        if(now-(gameOverlayManualRefreshAt.get(realm)||0)<GAME_OVERLAY_MANUAL_REFRESH_GAP_MS){send({ok:true,throttled:true});return;}
        if(coreSyncActive()){send({ok:false,throttled:false,error:'Sync is running.'});return;}
        gameOverlayManualRefreshAt.set(realm,now);
        const results=await Promise.allSettled([refreshRealmWarehouseForOverlay(realm,0),refreshOutgoingContracts(realm,0,{lane:true}),refreshMarketOrders(realm,0,{lane:true})]);
        const outcomes=results.map(r=>r.status==='fulfilled'?r.value:{ok:false,error:r.reason?.message||String(r.reason)});
        // Your listings held back (slot taken / 15 s gap / backoff): not dropped, ONE deferred retry when the slot frees.
        if(marketOrdersNeedsRetry(outcomes[2]))queueMarketOrdersRetry(realm,'overlay').catch(()=>{});
        if(outcomes.some(r=>r?.ok))scheduleGameOverlayRefreshNotification(realm,150);
        // One text per cause: under the direct-read block all three reads fail with the same notice.
        // A shared-lane wait (laneWait: no request made, the lane's next slot is later) is a planned skip, not a failure;
        // counting it made the reply "<block notice> Refresh failed." and hid the block note on the card.
        const bad=outcomes.filter(r=>!r?.ok&&!r?.laneWait);
        const errors=[...new Set(bad.map(r=>r?.error||'Refresh failed.'))];
        const queuedAll=bad.length>0&&bad.every(r=>r?.laneWait||r?.queued);const nextAt=Math.max(0,...bad.map(r=>Number(r?.nextAt)||0));
        send({ok:errors.length===0,throttled:false,queued:queuedAll,nextAt:queuedAll?nextAt:0,error:queuedAll?null:errors.length?errors.join(' '):null});
      }catch(e){send({ok:false,throttled:false,error:e?.message||String(e)});}
    })();return true;
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
          // Per-day figures Manager already read (Day statements / balance sheets), newest 120 days.
          const days=value&&typeof value.days==='object'&&!Array.isArray(value.days)?value.days:null;
          if(!days){send({ok:false,error:'Invalid accounting series.'});return;}
          const num=v=>v==null||v===''||!Number.isFinite(Number(v))?undefined:Number(v);
          const keep=Object.keys(days).filter(k=>/^\d{4}-\d{2}-\d{2}$/.test(k)).sort().slice(-120);
          value={v:1,days:Object.fromEntries(keep.map(k=>{const d=days[k]||{};const row={};for(const f of ['sales','operatingExpenses','netIncome','currentLiabilities','cogs','freightOut','marketFees','executives','cashChange']){const x=num(d[f]);if(x!==undefined)row[f]=x;}return [k,row];}))};
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
    // The game page polls this every 10 s. Replace embedded base64 images with the
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
  // Game-page "My listings" card: your own exchange listings (scmMarketOrders:<realm>) with names, images and the
  // realm's cached VWAP. refresh:true asks refreshMarketOrders (maxAge 0, no lock; its gate reads at most once per 15 s per realm),
  // without waiting; the card is told the key changed by an SCM_CARD_KEY_CHANGED message. A game action also reads
  // it at once (scheduleOwnOrdersRefresh).
  if(m?.type==='GET_OWN_LISTINGS_DATA'){
    (async()=>{
      try{
        const realm=validRealmNumber(m.realm);if(realm==null){send({ok:false,error:'No realm.'});return;}
        // No stored auth-data for this realm yet: no lane read (the auth-data fallback needs the slot first).
        // One realm-store read for the auth-data check and the VWAP column (it was read twice per card request).
        const storeP=notifyRealmStore(realm).catch(()=>({}));
        if(m.refresh&&realmStoreHasAuthData(await storeP,realm))refreshMarketOrders(realm,0,{lane:true}).catch(()=>{});
        const k=`scmMarketOrders:${realm}`;const mo=(await chrome.storage.local.get({[k]:null}))[k];
        // refreshError: the last refresh failed (message + when), so old or empty rows are not real "0 listings".
        const refreshError=ownListingsRefreshError.get(realm)||null;
        if(!mo||!Array.isArray(mo.orders)){send({ok:true,realm,at:null,rows:[],missing:true,refreshError});return;}
        const [assets,store]=await Promise.all([gameOverlayAssets(),storeP]);
        const rows=mo.orders.map(o=>{
          const kind=Number(o?.kind??o?.resourceId??o?.resource?.id),quality=Number(o?.quality)||0,quantity=Number(o?.quantity??o?.amount)||0,price=Number(o?.price)||0;
          const file=assets.images?.[String(kind)];const vwap=overlayVwap(store,kind,quality,realm);
          return {id:o?.id??null,kind,quality,quantity,price,total:quantity*price,name:String(assets.names.get(String(kind))||o?.resource?.name||`Resource #${kind}`),image:file?`${assets.imageBase}${file}`:'',vwap,vsVwapPct:vwap&&price>0?(price-vwap)/vwap*100:null};
        }).filter(r=>r.kind>0&&r.quantity>0);
        send({ok:true,realm,at:mo.at||null,rows,refreshError});
      }catch(e){send({ok:false,error:e?.message||String(e)});}
    })(); return true;
  }
  // Game-page "Outgoing contracts" card: the game's outgoing contracts as last captured for this realm
  // (endpointData of /api/v3/contracts-outgoing/me/, or the newer scmOutgoingContracts:<realm> read). refresh:true
  // also starts refreshOutgoingContracts (12 s gap per realm) without waiting; the card follows that key.
  if(m?.type==='GET_OUTGOING_CONTRACTS_DATA'){
    (async()=>{
      try{
        const realm=validRealmNumber(m.realm);if(realm==null){send({ok:false,error:'No realm.'});return;}
        if(m.refresh&&await realmHasStoredAuthData(realm))refreshOutgoingContracts(realm,undefined,{lane:true}).catch(()=>{});
        const k=`scmOutgoingContracts:${realm}`;
        const small=(await chrome.storage.local.get({[k]:null}))[k];
        const read=small?.data!=null?{data:small.data,receivedAt:small.at}:null;
        // a read under 60 s old is answered without loading the large realm store
        const fresh=!!read&&Date.now()-(Date.parse(read.receivedAt||0)||0)<OUTGOING_CONTRACTS_FRESH_MS;
        const captured=fresh?null:Object.entries((await notifyRealmStore(realm))?.endpointData||{})
          .filter(([u,v])=>/\/api\/v3\/contracts-outgoing\/me(?:\/\d+)?\/?(?:\?.*)?$/i.test(String(u||''))&&Number(v?.status)>=200&&Number(v?.status)<300&&v?.data!=null)
          .sort((a,b)=>Date.parse(b[1]?.receivedAt||0)-Date.parse(a[1]?.receivedAt||0))[0]?.[1];
        const hit=[captured,read].filter(Boolean).sort((a,b)=>(Date.parse(b.receivedAt||0)||0)-(Date.parse(a.receivedAt||0)||0))[0];
        if(!hit){send({ok:true,realm,at:null,rows:[],missing:true});return;}
        const assets=await gameOverlayAssets();
        const rows=helperArray(hit.data,['outgoingContracts','contracts','data','items','results']).map(c=>{
          const kind=Number(c?.kind??c?.resourceId??c?.resource?.id),quality=Number(c?.quality)||0,quantity=Number(c?.quantity)||0,price=Number(c?.price)||0;
          const file=assets.images?.[String(kind)];
          return {id:c?.id??null,kind,quality,quantity,price,total:quantity*price,name:String(assets.names.get(String(kind))||c?.resource?.name||`Resource #${kind}`),image:file?`${assets.imageBase}${file}`:'',datetime:c?.datetime||null};
        }).filter(r=>r.kind>0&&r.quantity>0);
        send({ok:true,realm,at:hit.receivedAt||null,rows});
      }catch(e){send({ok:false,error:e?.message||String(e)});}
    })(); return true;
  }
  // Smart sell price for the game's Sell page: cheapest competing listing (quality ≥ the lot's, your own
  // listings left out), 7-day daily VWAP range of id:quality, your warehouse cost, fee from your listings. An order book
  // older than 15 min is refreshed through the game tab (throttled 5 min per product, no lock held while fetching).
  if(m?.type==='GET_SELL_PRICE_INFO'){
    (async()=>{
      try{
        const realm=validRealmNumber(m.realm),id=validResourceId(m.resourceId),q=validQuality(m.quality);
        if(realm==null||id==null||q==null){send({ok:false,error:'Invalid request.'});return;}
        const s=await state(realm);const store={...(s.realmStores?.[realmKeyFromRealm(realm)]||{})};const C=globalThis.SCM_TOOLS_CORE;
        const path=`/api/v3/market/${realm}/${id}/`,ep=store.endpointData?.[path],at=Date.parse(String(ep?.receivedAt||''));
        const haveBook=Array.isArray(ep?.data)&&Number.isFinite(at)&&Date.now()-at<6*3600e3;
        let refreshing=false;
        if(!haveBook||Date.now()-at>15*60e3){refreshing=true;fetchExchangeOrderBookForRealm(realm,id).then(x=>logOrderBookSideRead(realm,id,x,'sell-page')).catch(()=>{});}
        const mo=(await chrome.storage.local.get({[`scmMarketOrders:${realm}`]:null}))[`scmMarketOrders:${realm}`];
        const own=Array.isArray(mo?.orders)?mo.orders:[];
        const lots=(Array.isArray(store.warehouseResources)?store.warehouseResources:[]).filter(l=>Number(l?.kind)===id&&Number(l?.quality)===q);
        const cost=C.warehouseUnitCostAsGame(lots,id);
        const companyId=store.authData?.authCompany?.companyId??store.authData?.authCompany?.id??null;
        const advice=C.sellPriceAdvice({listings:haveBook?ep.data:[],quality:q,history:store.history?.[simcoVwapHistoryKey(id,q)],unitCost:cost?.unitCost??null,feePct:C.EXCHANGE_FEE_PCT,companyId,ownIds:own.map(o=>o?.id),now:Date.now()});
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
        // State(requestedRealm) / state() of the active realm already is this realm's state; read again
        // only when the realm came from authData (no active realm, so the first read had no realm store).
        const realmState=(requestedRealm!=null||(s.activeRealmKey&&realmNumberFromKey(s.activeRealmKey)===realm))?s:await state(realm);
        const key=realmKeyFromRealm(realm),store={...(realmState.realmStores?.[key]||{})};
        const incomingRaw=helperLatestEndpoint(store,/\/api\/v3\/contracts-incoming\/\d+\/me\/?$/i);
        const incoming=helperArray(incomingRaw,['incomingContracts','data','items','results']).map(c=>({id:Number(c?.id),kind:Number(c?.kind),quality:Number(c?.quality)||0,quantity:Number(c?.quantity)||0,price:Number(c?.price)||0,company:String(c?.seller?.company||c?.company||'Unknown seller'),datetime:c?.datetime||null})).filter(c=>Number.isFinite(c.id));
        // Verdict: same reference as the badge, market-core at quality ≥ the contract's (order book < 6 h first; refreshed
        // through the game tab when older than 15 min: one product per pass, in the shared game lane as job
        // 'contractBook' (this card polls, so it is unattended), throttled 5 min each) and your warehouse cost.
        const C=globalThis.SCM_TOOLS_CORE,lots=Array.isArray(store.warehouseResources)?store.warehouseResources:[];let asked=0;
        const marketOwn=await marketOwnOpts(store,realm);
        for(const c of incoming){
          const comparison=overlayIncomingContractMarketComparison(store,c,realm,marketOwn);
          c.marketPrice=comparison.marketPrice;
          c.savingsPct=comparison.savingsPct;
          c.marketPriceSource=comparison.marketPriceSource;
          c.marketPriceStale=comparison.marketPriceStale;
          try{
            const ep=store.endpointData?.[`/api/v3/market/${realm}/${c.kind}/`],at=Date.parse(String(ep?.receivedAt||''));
            const book=Array.isArray(ep?.data)&&Number.isFinite(at)&&Date.now()-at<6*3600e3?ep.data:null;
            if((!book||Date.now()-at>15*60e3)&&asked<1&&c.kind>0){asked++;const kind=c.kind;fetchExchangeOrderBookForRealm(realm,kind,false,{lane:'contractBook'}).then(x=>logOrderBookSideRead(realm,kind,x,'contract-card')).catch(()=>{});}
            c.exchangePrice=c.marketPrice;
            // A game price: the order book ('exchange') or the game's market ticker ('ticker', lowest Q0 ask), each with its own capture time.
            c.exchangeAt=c.marketPriceSource==='exchange'?ep.receivedAt:c.marketPriceSource==='ticker'?(store.endpointData?.[`/api/v3/market-ticker/${realm}/`]?.receivedAt||null):null;
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
        // Surplus, the base Left and the saved-contract quantities come from the overlay's own calculation, so the
        // helper and the Stock After Demand card always show the same numbers.
        const plannerCore=globalThis.SCMPlannerCore;
        let calc=null;
        try{calc=(await overlayProductionStock(store,realm,s)).stock;}catch{}
        const baseBalanceByKey=calc?.baseBalanceByKey||new Map();
        for(const row of stock){
          const key=`${Number(row.id)}:${Number(row.quality)||0}`;
          if(!baseBalanceByKey.has(key))baseBalanceByKey.set(key,Math.max(0,Number(row.quantity)||0));
        }
        const surplusByKey=calc?.surplusByKey||new Map();
        const savedQuantityByContract=calc?.savedQuantities||new Map();
        const marketOwn=await marketOwnOpts(store,realm);
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
          const mHit=overlayMarketPriceHit(store,productId,quality,realm,marketOwn);
          const helperPrice=plannerCore?.savedContractCurrentPrice?plannerCore.savedContractCurrentPrice(c,mHit?.price??null):c?.price;
          // Source only when the shown price was derived from the market price (discount contracts), else null.
          const fromMarket=mHit?.price!=null&&helperPrice!==c?.price;
          return {...c,price:helperPrice,marketPriceSource:fromMarket?(mHit.source||null):null,marketPriceStale:fromMarket&&mHit.stale===true,productId:Number.isFinite(productId)?productId:null,productName,quality:Number.isFinite(quality)?quality:null,available:surplus,warehouseAvailable,surplus,left,quantityMode,savedEffectiveQuantity};
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
        const cachedRows=vwapRowsForRealm(store,realm);
        const cachedAt=Date.parse(String(store.vwapData?.fetchedAt||''));
        const fresh=Number.isFinite(cachedAt)&&vwapCacheFresh(store.vwapData)&&!store.vwapData?.stale&&!store.vwapData?.fallback;
        let rows=cachedRows,sourceRealm=store.vwapData?.sourceRealm??null,fetchedAt=store.vwapData?.fetchedAt||null;
        let refreshInBackground=false;
        if(!rows.length){
          // Return immediately from the cached snapshot; all network market work
          // is queued through the staged scheduler and never blocks this request.
          refreshInBackground=true;
        }else if(!fresh){refreshInBackground=true;}
        const eid=Number.isFinite(Number(inferredResourceId))?Number(inferredResourceId):null;
        let marketRows=[];
        if(eid!=null){
          const direct=store.endpointData?.[`/api/v3/market/${realm}/${eid}/`];
          if(Array.isArray(direct?.data))marketRows=direct.data;
        }
        if(!marketRows.length){
          const candidates=Object.entries(store.endpointData||{})
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
        // Stop what is running first. A Sync still walking would write its data back over the clear.
        extensionClearGeneration++;
        for(const session of realmSyncSessions.values())session.cancelled=true;
        await chrome.alarms.clearAll();
        syncDeferredWork.clear();
        dayWalkPageReturns.clear();
        for(const timers of [ownOrdersRefreshTimers,gameOverlayNotifyTimers,warehouseMutationRefreshTimers]){for(const t of timers.values())clearTimeout(t);timers.clear();}
        // Bounded: writes already queued get a moment to finish, but a stuck one cannot hold the clear up.
        const drains=[0,1].map(r=>apiStorageQueueForRealm(r));
        await withSyncTimeout(Promise.all([...drains,realmStorageCommitTail]),5000,'Writes before clear').catch(()=>{});
        // Buffered writes must not land after the clear and resurrect cleared data.
        discardAllRealmPatches();discardPendingLedgerArchive();
        pendingEndpointSeen.clear();
        pendingBuildingCollects.clear();if(buildingCollectFlushTimer){clearTimeout(buildingCollectFlushTimer);buildingCollectFlushTimer=null;} // collect stamps (scmBuildingCollects:N) go with the clear below
        await withRealmStorageCommit(()=>chrome.storage.local.clear());
        await scmNetClearAllEvents().catch(()=>{});
        await chrome.storage.session?.remove(LIVE_BRIDGE_TOKEN_SESSION_KEY).catch(()=>{});await liveBridgeBackupClear(); // session token + IDB backup
        // In-memory copies of cleared data would otherwise be served (and written back) until the worker restarts.
        resourceImagesMemo=null;notifyRecipesMemo=null;gameOverlayAssetsPromise=null;resourceImageSyncLastAt=0;gameDataFillAt=0;gameDataPageFillAt=0;gameDataPresent=false;resourceImagePageAsks.clear();await chrome.storage.session?.remove(SCM_GATE_STAMPS_KEY).catch(()=>{});for(const k of Object.keys(scmGateStampsMem))delete scmGateStampsMem[k];
        gameOverlaySnapshotMemo.clear();contractHelperCache.clear();
        gameOverlayLastRefreshAt.clear();gameOverlayDirty.clear();warehouseMutationLastAt.clear();warehouseOverlayBackoffUntil.clear();
        marketOrdersGateMem.clear();for(const t of marketOrdersTrailing.values())clearTimeout(t.id);marketOrdersTrailing.clear();
        // A listings read still on the wire sees the new generation and writes nothing; new reads may start at once.
        marketOrdersInFlight.clear();marketOrdersNetStart.clear();ownListingsRefreshError.clear();
        await chrome.storage.session?.remove([MARKET_ORDERS_GATE_KEY+0,MARKET_ORDERS_GATE_KEY+1]).catch(()=>{});
        // Deferred listings retries (their alarms went with clearAll above) and the quiet not-read stretches.
        try{await marketOrdersRetryClearAll();}catch{}
        try{await activityStretchClear();}catch{}
        outgoingContractsRefreshAt.clear();abundanceAutoState.clear();gameCaptureLogAt.clear();gameOverlayManualRefreshAt.clear();
        // The constants were just cleared: drop their retry backoff too, so the scm-game-constants alarm that
        // ensureStandingAlarms re-creates below (1 min delay) reads them again instead of waiting out an old backoff.
        await gameConstantsRetrySet(null);
        // The constants-on-bridge flag (scmGameConstantsOnBridge, storage.session) and its in-memory copy go too.
        try{await gameConstantsOnBridgeSet(false);}catch{}
        // The SimcoTools channel (scmSimcoChannel, storage.session): its queued jobs and the pending Refresh product go;
        // the rate tokens, a 429 cooldown and an outage stay (they describe SimcoTools, not the user's data).
        {const C=simcoChannelCore();await simcoChannelSerial(async()=>{if(C){const st=C.simcoState(await simcoChannelLoad(),Date.now());st.wants={};await simcoChannelStore(st);}try{await chrome.storage.session?.remove(SIMCO_REFRESH_WANT_KEY);}catch{}}).catch(()=>{});}
        scmTimersMemoGen++;scmTimersMemo=null; // scmSyncTimers was cleared: every timer is back to its default
        simcoPricesMemo.clear(); // scmSimcoPrices:<n> was cleared
        realmStorageMigrationChecked=false;realmMigrationPromise=null;
        const resetDefaults={...DEFAULTS,selectedRealm:null,activeRealmKey:null,vwapStatus:{message:'Waiting for VWAP sync.'},marketQueueStatus:{message:'Waiting for the logged-in Sim Companies tab.',updatedAt:new Date().toISOString()},resourceImageData:{}};
        await storageSet(resetDefaults);
        await ensureStandingAlarms({simcoPublic:false}); // scm-simco-public is placed below, after the live-market alarm
        await applyBundledGameConstants().catch(()=>{}); // scmGameConstants back from the built-in copy (constants.json) at once
        await ensureCriticalDataGuard('clear-extension-data');
        await ensureLiveMarketRefreshAlarm('clear-extension-data'); // ClearAll removed it too
        await ensureSimcoPublicAlarm(); // after the live-market alarm: it is placed 2.5 min after it
        await ensureOrderBookRefreshAlarm();
        send({ok:true});
      }catch(e){send({ok:false,error:e?.message||String(e)});}
    })();
    return true;
  }
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
      if(current!==incoming) changed=await activateRealmByRealmFast(incoming).catch(()=>false);
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
    // Game config (executive training/settling times) for the admin-overhead calculation. Storage only.
    (async()=>{const c={};for(const k of ['executivesTimeToTrainS','executivesTimeToSettleInS']){const n=Number(m?.config?.[k]);if(Number.isFinite(n)&&n>0)c[k]=n;}
      if(Object.keys(c).length)await rawStorageSet({scmGameConfig:{...c,at:new Date().toISOString()}});send({ok:true});})().catch(e=>send({ok:false,error:String(e?.message||e)}));
    return true;
  }
  if(m?.type==='API_SEEN'){
    const method=String(m.method||'GET').toUpperCase();
    const url=String(m.url||'');
    replayEvent('api-seen',{realm:validRealmNumber(m.captureRealm),url,method});
    const session=currentCaptureSyncSession();
    if(method==='GET'&&session){
      // The sync's explicit saveData calls will update the endpoint registry;
      // do not write the whole realm store once before and again after each GET.
      send({ok:true,coveredBySyncCapture:true});
      return true;
    }
    queueEndpointSeen(url,method,m.captureRealm).then(()=>send({ok:true,queued:true})).catch(e=>send({ok:false,error:e?.message||String(e)}));
    return true;
  }
  // Both request channels at a glance (game lane + SimcoTools): SCM_TIMERS_CORE.channelSnapshot over storage.session.
  if(m?.type==='scm-channels-snapshot'){(async()=>{try{const C=globalThis.SCM_TIMERS_CORE;if(!C||typeof C.channelSnapshot!=='function'){send({ok:false,error:'channelSnapshot unavailable'});return;}const simKey=C.SIMCO?.KEY||'scmSimcoChannel';const v=await chrome.storage.session.get([C.LANE.KEY,simKey]);const snap=C.channelSnapshot(v?.[C.LANE.KEY]||null,v?.[simKey]||null,Date.now());{const ref=await gameRefusalGet();if(ref&&Number(ref.until)>Date.now()&&snap?.game){snap.game.nextAt=Math.max(Number(snap.game.nextAt)||0,Number(ref.until));snap.game.paused={until:Number(ref.until),refused:true,reason:"the game's security check refuses Manager reads; pages you open and SimcoTools keep the data current"};if(Array.isArray(snap.game.queue))snap.game.queue=snap.game.queue.map(q=>({...q,reason:'paused (security check)'}));}}send({ok:true,snapshot:snap,...snap});}catch(e){send({ok:false,error:e?.message||String(e)});}})();return true;}
  if(m?.type==='STOCK_MUTATION_COMPLETE'){
    // An untagged action belongs to the active realm. Check for null first: validRealmNumber(null) is 0 (R1).
    (async()=>{let realm=(m.captureRealm===null||m.captureRealm===undefined||m.captureRealm==='')?null:validRealmNumber(m.captureRealm);
      // A building collect is stamped at once (no reply is read); an id that is not a stored building writes nothing.
      // m.data: the game's parsed reply (page-hook.js, take path only, at most 20,000 chars) or absent.
      if(String(m.method||'').toUpperCase()==='POST'&&collectTakeBuildingIdFromUrl(m.url)!=null){try{noteBuildingTake(m.url,realm,m.data);}catch{}}
      if(realm==null){try{const meta=await chrome.storage.local.get({activeRealmKey:null});realm=validRealmNumber(realmNumberFromKey(meta.activeRealmKey)??meta.activeRealmKey);}catch{}}
      // A collect (POST /api/v2/order/take/<id>/, one per building for "Collect all") is NOT followed by a game warehouse
      // GET (the game updates its own state from the POST replies; captures of 2026-11-11 show the next /api/v3/resources/
      // only when the warehouse page is opened). So it gets the same batched warehouse read as a contract accept; a burst
      // of collects shares one read (scheduleWarehouseRefreshAfterStockMutation: 150 ms debounce, 3 s floor).
      const isTake=String(m.method||'').toUpperCase()==='POST'&&collectTakeBuildingIdFromUrl(m.url)!=null;
      // 2.5.465: a game Collect queues collectWarehouse:<realm> (prio 1, first in the next game slot); a burst shares one want.
      if(realm!=null&&isTake){gameLaneEnqueue(`collectWarehouse:${realm}`).catch(()=>{});return;}
      // 2.5.466: a listing post/cancel is applied from the game's own reply at once (no read of the Manager's own).
      let applied=false;if(realm!=null){try{applied=await applyGameListingReply(realm,m.method,m.url,m.data);}catch(e){logError('listing-reply',e);}}
      if(realm!=null){scheduleWarehouseRefreshAfterStockMutation(realm,150);if(!applied)scheduleOwnOrdersRefresh(realm);}})();
    send({ok:true});return true}
  if(m?.type==='WAREHOUSE_COST_DETAIL'){saveWarehouseCostDetail(m).then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
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
      // The game tab is up: fill constants / images that are completely missing (fresh install).
      fillMissingGameData('game-tab',{onlyMissing:true}).catch(()=>{});
      // A constants read held back at install / update / worker start for want of a game tab runs now.
      (async()=>{if(!(await gameConstantsOnBridgeTake()))return;const e=await scmTimerEntry('gameConstants').catch(()=>null);if(e&&!e.enabled)return;await refreshGameConstants(false,gameConstantsMaxAge(e),{quietNoTab:true});})().catch(()=>{});
    })().catch(e=>send({ok:false,error:e?.message||String(e)}));
    return true;
  }
  if(m?.type==='SCM_TEST_DAILY_SUMMARY'){fireDailySummary().then(()=>send({ok:true})).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='SCM_TEST_NOTIFICATION'){scmNotify(`test-${Date.now()}`,'Sim Companies Manager','Test notification — if you can read this, alerts work on this phone.').then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='SCM_NOTIFY_SETTINGS'){(async()=>{try{if(m.set&&typeof m.set==='object'){const cur=await notifySettings();await rawStorageSet({[NOTIFY_SETTINGS_KEY]:{...cur,...sanitizeNotifySet(m.set)}});await scheduleDailySummary();for(const n of [0,1]){const st=(await chrome.storage.local.get({[`scmRealmStore:${n}`]:null}))[`scmRealmStore:${n}`];if(st)await scheduleProductionFinishAlarms(n,st.buildings);}}const prodfin=(await chrome.alarms.getAll()).filter(x=>String(x.name).startsWith('scm-prodfin:'));const nameStores={};for(const a of prodfin){const r=String(a.name).split(':')[1];if(!(r in nameStores))nameStores[r]=(await chrome.storage.local.get({[`scmRealmStore:${r}`]:null}))[`scmRealmStore:${r}`]||{};}
// Building names for the Alerts "Next" line, so the dashboard can show it before its own state has loaded.
const alarms=prodfin.map(x=>{const [,r,bid]=String(x.name).split(':');const b=(Array.isArray(nameStores[r]?.buildings)?nameStores[r].buildings:[]).find(y=>String(y?.id)===bid);return {name:x.name,when:x.scheduledTime,buildingName:b?.name?String(b.name):null};});const daily=await chrome.alarms.get('scm-daily-summary');send({ok:true,settings:await notifySettings(),available:!!chrome.notifications?.create,alarms,dailyAt:daily?.scheduledTime||null});}catch(e){send({ok:false,error:e?.message||String(e)});}})();return true;}
  // The Market Refresh press (manual:true) makes no game request: SimcoTools only (LIVE_MARKET_REFRESH manual / LIVE_MARKET_PRODUCT);
  // the order book updates from the game pages you open. Answers the SimcoTools channel status instead.
  if(m?.type==='FETCH_EXCHANGE_ORDER_BOOK'&&m.manual===true){(async()=>{try{const s=await simcoChannelStatus();send({ok:false,skipped:true,noGameRead:true,simcoOnly:true,...s,error:'Refresh reads SimcoTools only; the order book updates from the game pages you open.'});}catch(e){send({ok:false,skipped:true,noGameRead:true,error:e?.message||String(e)});}})();return true;}
  if(m?.type==='FETCH_EXCHANGE_ORDER_BOOK'){if(m.manual!==undefined&&typeof m.manual!=='boolean'){send({ok:false,error:'Invalid request.'});return true;}fetchExchangeOrderBookForRealm(m.realm,m.resourceId,m.manual===true,m.manual===true?null:{onView:true}).then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
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
  if(m?.type==='API_DATA'){
    (async()=>{
      const url=String(m.url||'');
      const session=currentCaptureSyncSession();
      // Every response in a walked page's traffic is kept in memory for this section: Sync times the page by it
      // and uses it to spot an endpoint that moved. Stored or not is decided next.
      // A target's required path also keeps its latest 2xx answer for the whole Sync (final durability recovery).
      // Only the Sync's own game tab (top frame) feeds these; another simcompanies.com tab or a subframe cannot.
      recordSyncWalkCapture(session,m,sender);
      if(!shouldPersistPassiveApiCaptureDuringSync(session,url,m.method||'GET')){
        replayEvent('sync-passive-api-capture-skipped',{realm:validRealmNumber(m.captureRealm),url,method:String(m.method||'GET').toUpperCase(),targetPaths:session?.capturePaths?.length||0});
        send({ok:true,skipped:true,reason:'outside-current-sync-target-paths'});
        return;
      }
      // Warehouse answers: how long the save waited and took (replay journal), so overlay lag can be traced.
      const whTiming=/\/api\/v3\/resources\/\d+\/?(?:\?.*)?$/i.test(url)?t=>replayEvent('warehouse-save-timing',{realm:validRealmNumber(m.captureRealm),queueWaitMs:t?.queueWaitMs,aheadAtEnqueue:t?.queuedJobsAheadAtEnqueue,saveMs:t?.saveDurationMs,totalMs:t?.totalDurationMs,ok:t?.ok}):null;
      await saveData(url,m.data,m.status,m.method||'GET',m.captureRealm,whTiming);
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
          await activateRealmByRealmFast(confirmedRealm).catch(()=>{});
        }
      }
      send({ok:true});
    })().catch(e=>send({ok:false,error:e?.message||String(e)}));
    return true;
  }
  if(m?.type==='RESOURCE_CATALOG'){saveResourceCatalog(m.catalog,m.receivedAt).then(()=>send({ok:true})).catch(e=>send({ok:false,error:e?.message||String(e)}));return true}
  if(m?.type==='RESOURCE_IMAGE_RESULT'){(async()=>{
    // From the page (content.js relay): raster image data URLs up to 1 MB only (resourceImageDataUrlParts).
    if(m.dataUrl&&!resourceImageDataUrlParts(m.dataUrl)){send({ok:false,error:'Image type not allowed or too large.'});return;}
    if(!m.dataUrl){send({ok:true});return;}
    // A known resource id (integer 1..99999 in the manifest, constants or catalog) that was asked for; else nothing is written.
    const id=validResourceId(m.resource);
    if(id==null||!(await knownResourceIds()).has(id)){send({ok:false,error:'Unknown resource id.'});return;}
    const asked=resourceImagePageAsks.get(id);
    if(!asked||Date.now()-asked>RESOURCE_IMAGE_PAGE_ASK_MS){send({ok:false,error:'No image was asked for this resource.'});return;}
    resourceImagePageAsks.delete(id);
    const s=await state(); const realm=realmNumberFromKey(s.activeRealmKey||identityFromAuth(s.authData));
    if(realm!=null) await saveResourceImages({[String(id)]:m.dataUrl},{});
    send({ok:true});
  })().catch(e=>send({ok:false,error:e?.message||String(e)}));return true}
  // Dashboard open: read game constants / resource images if they are missing (see fillMissingGameData).
  if(m?.type==='SCM_ENSURE_GAME_DATA'){fillMissingGameData('dashboard-open').then(r=>send({ok:true,...r})).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;}
  if(m?.type==='GET_RESOURCE_IMAGE'){(async()=>{const rid=validResourceId(m.resource);if(rid==null||!(await knownResourceIds()).has(rid)){send({ok:false,error:'Invalid resource id'});return;}
    // resourceImages off: the stored image or nothing (placeholder); no download, no game tab ask.
    if(!(await scmTimerEnabled('resourceImages').catch(()=>true))){let d=null;try{d=(await resourceImagesStore())?.cache?.[String(rid)]||null;}catch{}send(d?{ok:true,dataUrl:d,cached:true,stale:false}:{ok:false,switchedOff:true,placeholder:true,error:SCM_SWITCHED_OFF_TEXT});return;}const r=await fetchAndCacheResourceImage(rid,{forceValidate:false}); if(r.ok){send({ok:true,dataUrl:r.dataUrl,cached:r.cached,stale:r.stale||false});return;} const tab=await simTab(); if(!tab?.id){send({ok:false,error:r.error||'Sim Companies tab is not open.'});return;} try{resourceImagePageAsks.set(rid,Date.now());await chrome.tabs.sendMessage(tab.id,{type:'PAGE_RESOURCE_IMAGE',resource:rid}); send({ok:true,queued:true,error:r.error||null});}catch(e){send({ok:false,error:e?.message||String(e)});}})().catch(e=>send({ok:false,error:e?.message||String(e)}));return true}
  if(m?.type==='MARKET_CACHE'){saveMarketCache(m.resource,m.data,m.receivedAt,m.realm).then(()=>send({ok:true})).catch(e=>send({ok:false,error:e?.message||String(e)}));return true}
  if(m?.type==='SYNC_NOW'){syncNow(m.realm,{fullWalk:true}).then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true}
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
      fillMissingGameData('view-realm').catch(()=>{});
    })().catch(e=>send({ok:false,error:e?.message||String(e)})); return true;
  }
  if(m?.type==='PUSH_LIVE_BRIDGE'){
    pushLiveBridge(m.realm,Boolean(m.force)).then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;
  }
  if(m?.type==='GET_LIVE_BRIDGE_TOKEN'){
    getLiveBridgeToken().then(token=>send({ok:true,token:String(token||'')})).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;
  }
  if(m?.type==='SET_LIVE_BRIDGE'){
    (async()=>{try{
      const current=await chrome.storage.local.get({liveBridge:DEFAULTS.liveBridge});
      const token=String(m.token||'');
      const next={...(current.liveBridge||{}),enabled:Boolean(m.enabled),url:String(m.url||'').trim(),token:'',tokenSet:Boolean(token),pushOnSync:Boolean(m.pushOnSync)};
      if(next.url && !/^https:\/\//i.test(next.url)) throw new Error('Live bridge URL must use HTTPS.');
      if(token){if(!chrome.storage.session)throw new Error('Session storage unavailable; cannot store bridge token.');await chrome.storage.session.set({[LIVE_BRIDGE_TOKEN_SESSION_KEY]:token});await liveBridgeBackupSet(token);await chrome.storage.local.remove(LIVE_BRIDGE_TOKEN_BACKUP_KEY);}
      else {await chrome.storage.session?.remove(LIVE_BRIDGE_TOKEN_SESSION_KEY);await chrome.storage.local.remove(LIVE_BRIDGE_TOKEN_BACKUP_KEY);await liveBridgeBackupClear();}
      await storageSet({liveBridge:next});
      send({ok:true,liveBridge:{...next,hasToken:Boolean(token)}});
    }catch(e){send({ok:false,error:e?.message||String(e)});}})();return true;
  }
  if(m?.type==='GET_STATE'){
    Promise.resolve().then(async()=>{
      await ensureRealmStorageMigration();
      const s=await state();
      const active=validRealmNumber(s.activeRealmKey?.replace(/^realm:/,''));
      const activeKey=active!=null?realmKeyFromRealm(active):null;
      const store=activeKey?(s.realmStores||{})[activeKey]||{}:{};
      const out={...s,realmStores:activeKey?{[activeKey]:store}:{},activeRealmKey:activeKey,selectedRealm:s.selectedRealm!=null?Number(s.selectedRealm):null,viewRealm:active,captureRealm:active,apiBase:s.apiBase,syncMinutes:s.syncMinutes};
      return scmIsExtensionPageSender(sender)?out:scmStripStateSecrets(out);
    }).then(send).catch(e=>send({ok:false,error:e?.message||String(e)}));return true;
  }
});

ensureRealmStorageMigration().catch(()=>{});

// One-time (idempotent) move of resource images out of the realm stores.
moveResourceImagesOutOfRealmStores().catch(e=>console.debug('resource image move skipped',e));
// Stored overlay snapshots no longer carry base64 images (~450 KB -> ~12 KB per realm).
(async()=>{for(const r of [0,1]){try{const k=gameOverlaySnapshotStorageKey(r);const v=(await chrome.storage.local.get({[k]:null}))[k];if(!v)continue;const s=await stripOverlayEmbeddedImages(v);if(s!==v)await rawStorageSet({[k]:s});}catch(e){console.debug('overlay snapshot cleanup skipped',e);}}})();
