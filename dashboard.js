const BUILD_VERSION=chrome.runtime.getManifest().version;
// Paint the build number as soon as this script starts (the full load can take seconds on phones).
try{const b=document.getElementById('managerBuild');if(b)b.textContent=`Build ${BUILD_VERSION}`;const si=document.getElementById('syncInfo');if(si)si.textContent='Loading…';}catch{}
function updateDeviceLayout(){const width=Math.max(window.innerWidth||0,window.visualViewport?.width||0),root=document.documentElement;root.classList.toggle('scm-mobile',width<=600);root.classList.toggle('scm-tablet',width>600&&width<=1000);root.classList.toggle('scm-desktop',width>1000);}
updateDeviceLayout();window.addEventListener('resize',updateDeviceLayout,{passive:true});window.visualViewport?.addEventListener('resize',updateDeviceLayout,{passive:true});
const $=s=>document.querySelector(s), $$=s=>document.querySelectorAll(s);
function validRealmNumber(v){const n=Number(v);return Number.isFinite(n)&&Number.isInteger(n)&&n>=0?n:null;}
let activeTab='overview';
let accountingPeriodView='current';
let __scmState=null;
let __realmViewEpoch=0;
let __realmHydrationPending=false;
let accountingRefreshPending=false;
let accountingWeekLedgerRefreshPending=false;
let accountingWeekLedgerRetryCount=0;
let accountingWeekLedgerRetryTimer=null;
// While the Manager tab is hidden (you are in the game) the storage listeners are detached: Chrome would otherwise
// deliver every realm-store write (~1.3 MB each, several a minute) and queue renders that all run on return.
// On return the page reads storage once.
const __scmStorageListeners=new Set();let __scmListenersAttached=true,__scmHiddenAt=0;const __scmResumeHandlers=new Set();
function scmOnStorageChanged(fn){__scmStorageListeners.add(fn);if(__scmListenersAttached)try{chrome.storage.onChanged.addListener(fn);}catch{}}
function scmOnDashboardResume(fn){__scmResumeHandlers.add(fn);}
globalThis.scmOnStorageChanged=scmOnStorageChanged;globalThis.scmOnDashboardResume=scmOnDashboardResume;
document.addEventListener('visibilitychange',()=>{
  if(document.hidden){__scmHiddenAt=Date.now();if(__scmListenersAttached){for(const fn of __scmStorageListeners)try{chrome.storage.onChanged.removeListener(fn);}catch{}__scmListenersAttached=false;}return;}
  if(!__scmListenersAttached){for(const fn of __scmStorageListeners)try{chrome.storage.onChanged.addListener(fn);}catch{}__scmListenersAttached=true;}
  if(Date.now()-__scmHiddenAt<2000)return;
  for(const fn of __scmResumeHandlers)try{fn();}catch{}
});
function commitDashboardState(next){
  if(!next||typeof next!=='object')return false;
  const current=__scmState;
  const currentKey=current?.activeRealmKey!=null?String(current.activeRealmKey):'';
  const nextKey=next?.activeRealmKey!=null?String(next.activeRealmKey):'';
  if(currentKey&&nextKey&&currentKey!==nextKey)return false;
  const currentView=validRealmNumber(current?.viewRealm);
  const nextView=validRealmNumber(next?.viewRealm);
  if(currentView!=null&&nextView!=null&&currentKey===nextKey&&currentView!==nextView)return false;
  __scmState=next;
  window.__scmState=next;
  return true;
}
const plannerUiStateByRealm=Object.create(null);
let plannerModifierFetchPending=false;
function plannerUiRealmKey(s){const r=s?.viewRealm!=null?s.viewRealm:(s?.selectedRealm!=null?s.selectedRealm:s?.authData?.authCompany?.realmId);return String(Number.isFinite(Number(r))?Number(r):'default');}
function plannerUiStateFromPersisted(persisted){
  const p=persisted&&typeof persisted==='object'?persisted:{};
  const selected=p.selectedBuildingId!=null?String(p.selectedBuildingId):null;
  const planningLevels={...(p.planningLevels&&typeof p.planningLevels==='object'?p.planningLevels:{})};
  const productOverrides={...(p.productOverrides&&typeof p.productOverrides==='object'?p.productOverrides:{})};
  const qualityByBuilding={...(p.qualityByBuilding&&typeof p.qualityByBuilding==='object'?p.qualityByBuilding:{})};
  const planModes={...(p.planModes&&typeof p.planModes==='object'?p.planModes:{})};
  const kindOverrides={...(p.kindOverrides&&typeof p.kindOverrides==='object'?p.kindOverrides:{})};
  const quality=selected!=null&&qualityByBuilding[selected]!=null?Number(qualityByBuilding[selected])||0:null;
  return {buildingId:selected,planningLevels,productOverrides,quality,qualityByBuilding,runHours:Math.min(48,Math.max(1,Number(p.runHours)||24)),discount:Math.min(10,Math.max(0,Number(p.discount)||0)),planModes,kindOverrides};
}
function plannerUiState(s){const key=plannerUiRealmKey(s);if(!plannerUiStateByRealm[key]){const persisted=s?.productionPlannerState&&typeof s.productionPlannerState==='object'?s.productionPlannerState:{};plannerUiStateByRealm[key]=plannerUiStateFromPersisted(persisted);}return plannerUiStateByRealm[key];}
function queuePlannerUiPersist(s){
  const realm=validRealmNumber(s?.viewRealm!=null?s.viewRealm:(s?.selectedRealm!=null?s.selectedRealm:s?.authData?.authCompany?.realmId));
  if(realm==null)return;
  const ui=plannerUiState(s);
  const payload={version:1,realm,selectedBuildingId:ui.buildingId!=null?String(ui.buildingId):null,planningLevels:{...(ui.planningLevels||{})},productOverrides:{...(ui.productOverrides||{})},qualityByBuilding:{...(ui.qualityByBuilding||{})},runHours:Math.min(48,Math.max(1,Number(ui.runHours)||24)),discount:Math.min(10,Math.max(0,Number(ui.discount)||0)),planModes:{...(ui.planModes||{})},kindOverrides:{...(ui.kindOverrides||{})},updatedAt:new Date().toISOString()};
  // Planner controls are lightweight user preferences. Persist them immediately
  // so a fast page/navigation change cannot outrun a debounce window.
  try{chrome.runtime.sendMessage({type:'SAVE_PRODUCTION_PLANNER_STATE',realm,value:payload}).catch(()=>{});}catch{}
}
async function requestAccountingRefresh(){
  if(accountingRefreshPending)return;
  const requestEpoch=__realmViewEpoch;
  const s=window.__scmState||await get();
  if(requestEpoch!==__realmViewEpoch)return;
  const realm=Number(s?.viewRealm??s?.selectedRealm??s?.authData?.authCompany?.realmId);
  if(!Number.isFinite(realm)||![0,1].includes(realm))return;
  const paths=[
    '/api/v2/companies/me/cashflow-statement/','/api/v2/companies/me/income-statement/','/api/v2/companies/me/balance-sheet/',
    '/api/v2/companies/me/past-finances-overview/','/api/v2/companies/me/cashflow/recent/','/api/v2/companies/me/administration-overhead/','/api/v3/companies/me/past-finances/'
  ];
  const key=`realm:${realm}`;
  const store=s?.realmStores?.[key]||s;
  const fresh=path=>{const x=store?.endpointData?.[path];return x&&Number(x.status)>=200&&Number(x.status)<300&&x.data!=null&&Number.isFinite(Date.parse(x.receivedAt||''))&&Date.now()-Date.parse(x.receivedAt)<300000;};
  if(paths.every(fresh))return;
  accountingRefreshPending=true;
  try{
    if(requestEpoch!==__realmViewEpoch)return;
    const r=await chrome.runtime.sendMessage({type:'REFRESH_ACCOUNTING',realm});
    if(r?.ok){const freshState=await get();try{render(freshState);}catch(e){console.error('Accounting refresh render failed',e);}}
  }catch(e){
    // The extension was reloaded or updated while the refresh was running: Chrome closes the reply channel. Not a failure;
    // the endpoints stay stale and the next refresh (next visit or render) fetches them.
    if(/message channel closed|Extension context invalidated|receiving end does not exist/i.test(String(e?.message||e)))console.info('Accounting refresh interrupted by an extension reload; it will run again on the next visit.');
    else console.error('Accounting refresh failed',e);
  }
  finally{accountingRefreshPending=false;}
}
async function requestAccountingWeekLedgerRefresh(reason='dashboard-overview'){
  if(accountingWeekLedgerRefreshPending)return;
  const requestEpoch=__realmViewEpoch;
  const s=window.__scmState||await get();
  if(requestEpoch!==__realmViewEpoch)return;
  const realm=Number(s?.viewRealm??s?.selectedRealm??s?.authData?.authCompany?.realmId);
  if(!Number.isFinite(realm)||![0,1].includes(realm))return;
  const key=`realm:${realm}`;
  const store=s?.realmStores?.[key]||s;
  const status=store?.accountingWeekLedgerStatus;
  const summary=store?.accountingWeekSalesSummary;
  const ledger=store?.accountingWeekSales&&typeof store.accountingWeekSales==='object'?store.accountingWeekSales:{};
  const hasSummary=Array.isArray(summary?.netProfit)&&Array.isArray(summary?.gross)&&Number(summary?.transactionCount)>0;
  const ready=status?.status==='complete'&&status?.coverageComplete===true&&hasSummary;
  if(ready){accountingWeekLedgerRetryCount=0;return;}
  const syncStatus=String(store?.syncStatus||'');
  const syncJobRunning=store?.fullSyncJob?.status==='running';
  const syncStillRunning=!/Sync complete/i.test(syncStatus)&&/Syncing|Sync:/i.test(syncStatus);
  if(syncJobRunning||syncStillRunning)return;
  const hasCoreSync=Boolean(store?.lastSync||/Sync complete/i.test(syncStatus)||store?.fullSyncDiagnostics?.lastSync);
  if(!hasCoreSync)return;
  accountingWeekLedgerRefreshPending=true;
  try{
    if(requestEpoch!==__realmViewEpoch)return;
    const result=await chrome.runtime.sendMessage({type:'REFRESH_ACCOUNTING_WEEK_LEDGER',realm,reason:String(reason||'dashboard-overview')});
    if(requestEpoch!==__realmViewEpoch)return;
    const fresh=await get();
    if(requestEpoch!==__realmViewEpoch)return;
    if(commitDashboardState(fresh)){
      try{patchOverviewGrossResources(scmReactiveViewState(fresh));}catch{}
      if(activeTab==='overview')scheduleDashboardRender();
    }
    if(result?.ok){
      accountingWeekLedgerRetryCount=0;
    }else if(!result?.busy && !hasSummary && Object.keys(ledger).length===0){
      accountingWeekLedgerRetryCount=Math.min(accountingWeekLedgerRetryCount+1,3);
      if(accountingWeekLedgerRetryCount<=3 && accountingWeekLedgerRetryTimer==null){
        const delay=2500*Math.pow(2,accountingWeekLedgerRetryCount-1);
        accountingWeekLedgerRetryTimer=setTimeout(()=>{
          accountingWeekLedgerRetryTimer=null;
          requestAccountingWeekLedgerRefresh('dashboard-retry').catch(()=>{});
        },delay);
      }
    }
  }catch(e){
    console.debug('Accounting week ledger refresh failed',e);
    accountingWeekLedgerRetryCount=Math.min(accountingWeekLedgerRetryCount+1,3);
    if(accountingWeekLedgerRetryCount<=3 && accountingWeekLedgerRetryTimer==null){
      const delay=2500*Math.pow(2,accountingWeekLedgerRetryCount-1);
      accountingWeekLedgerRetryTimer=setTimeout(()=>{
        accountingWeekLedgerRetryTimer=null;
        requestAccountingWeekLedgerRefresh('dashboard-retry').catch(()=>{});
      },delay);
    }
  }finally{
    accountingWeekLedgerRefreshPending=false;
  }
}
document.addEventListener('click',e=>{const t=e.target?.closest?.('[data-goto-tab]');if(!t)return;const tab=document.querySelector(`.tab[data-tab="${CSS.escape(t.dataset.gotoTab||'')}"]`);if(tab){tab.click();window.scrollTo(0,0);}});$$('.tab').forEach(b=>b.onclick=()=>{activeTab=b.dataset.tab;document.body.classList.toggle('production-active',activeTab==='production');$$('.tab').forEach(x=>x.classList.remove('active'));$$('.tabpage').forEach(x=>x.classList.remove('active'));b.classList.add('active');$('#'+b.dataset.tab).classList.add('active');if((b.dataset.tab==='market'||b.dataset.tab==='warehouse')&&window.__scmState){const n=marketRealmFromState(window.__scmState);if(n!=null)requestLiveMarketRefresh(n,true);}if(window.__scmState){try{render(window.__scmState);}catch(e){console.error('Dashboard tab render failed',e);}}});
document.addEventListener('click',e=>{const b=e.target?.closest?.('[data-accounting-period]');if(!b)return;accountingPeriodView=String(b.dataset.accountingPeriod||'current');document.querySelectorAll('[data-accounting-period]').forEach(x=>x.classList.toggle('active',x===b));if(window.__scmState){try{render(window.__scmState);}catch(err){console.error('Accounting period render failed',err);}}});
// Mobile-friendly row focus for every horizontally scrollable dashboard table.
// Event delegation keeps it working after reactive table patches/re-renders.
document.addEventListener('click',e=>{
  const row=e.target?.closest?.('.tabpage .table-wrap > table tbody > tr');
  if(!row||row.querySelector('[colspan]'))return;
  if(e.target?.closest?.('button,input,select,textarea,a,[contenteditable=\"true\"]'))return;
  const table=row.closest('table');
  table?.querySelectorAll('tbody > tr.scm-row-selected').forEach(x=>x.classList.remove('scm-row-selected'));
  row.classList.add('scm-row-selected');
});
// 'alerts' and 'diagnostic' were merged into 'settings' (saved last tab, ?tab=, SCM_SELECT_DASHBOARD_TAB).
const SCM_TAB_ALIASES={alerts:'settings',diagnostic:'settings',selftest:'settings'};
function selectDashboardTab(tab){let key=String(tab||'').trim();key=SCM_TAB_ALIASES[key]||key;const b=[...$$('.tab')].find(x=>x.dataset.tab===key);if(b)b.click();}
// Remember the open tab and scroll position. Mobile browsers unload background
// tabs, so coming back to the Manager reloads the page — it now reopens where you left it.
const SCM_LAST_TAB_KEY='scmDashboardLastTabV1';
function rememberDashboardTab(){try{localStorage.setItem(SCM_LAST_TAB_KEY,JSON.stringify({tab:activeTab,y:Math.round(window.scrollY||0),at:Date.now()}));}catch{}}
$$('.tab').forEach(b=>b.addEventListener('click',()=>setTimeout(rememberDashboardTab,0)));
let rememberScrollTimer=0;window.addEventListener('scroll',()=>{clearTimeout(rememberScrollTimer);rememberScrollTimer=setTimeout(rememberDashboardTab,250);},{passive:true});
document.addEventListener('visibilitychange',()=>{if(document.hidden)rememberDashboardTab();});
window.addEventListener('pagehide',rememberDashboardTab);
try{
  const requested=new URLSearchParams(location.search).get('tab');
  let saved=null;try{saved=JSON.parse(localStorage.getItem(SCM_LAST_TAB_KEY)||'null');}catch{}
  let target=requested||saved?.tab;target=SCM_TAB_ALIASES[target]||target;
  if(target&&target!==activeTab)selectDashboardTab(target);
  if(requested==='selftest')setTimeout(()=>{const c=$('#selfTestCard');if(c){if(typeof scmSetCollapsed==='function')scmSetCollapsed(c,false);c.scrollIntoView({block:'start'});}},300);
  if(!requested&&saved?.tab&&saved.y>0){const y=saved.y;let tries=0;const restore=()=>{if(document.documentElement.scrollHeight>=y+innerHeight*0.5||tries++>20){window.scrollTo(0,y);return;}setTimeout(restore,150);};setTimeout(restore,300);}
}catch{}
chrome.runtime.onMessage.addListener(m=>{if(m?.type==='SCM_SELECT_DASHBOARD_TAB'&&m.tab)selectDashboardTab(String(m.tab));});
let dashboardImagesMemo=null;
// blob: URLs are not an option here (manifest CSP img-src has no blob:). Icons stay data: URIs in src; the fallback
// candidate list does not repeat the payload (see scmCandidatesJson).
// data: entries (~26KB each) are blanked in data-candidates; the src already carries the first image.
// Image src allow-list. EVERY <img src> / img.src built in the UI files goes through this one helper: only base64 raster data URIs,
// https://www.simcompanies.com/static/images/... and bundled icons/... are allowed; anything else returns '' (= no image / placeholder).
function scmSafeImgSrc(u){if(typeof u!=='string')return '';const v=u.trim();if(!v||v.length>400000||/[\s"'<>`\\]/.test(v))return '';if(/^data:image\/(png|jpeg|webp|gif|avif);base64,[A-Za-z0-9+\/]+=*$/.test(v))return v;if(/^https:\/\/www\.simcompanies\.com\/static\/images\/[A-Za-z0-9_\-.\/@%]+(\?[A-Za-z0-9_=&.\-]*)?$/.test(v)&&!/\.\.|\/\//.test(v.slice(8)))return v;if(/^icons\/[A-Za-z0-9_\-.]+(\/[A-Za-z0-9_\-.]+)*$/.test(v)&&!v.includes('..'))return v;return '';}
const scmCandidatesJson=list=>JSON.stringify((list||[]).map(u=>typeof u==='string'&&u.startsWith('data:')?'':scmSafeImgSrc(u)));
async function dashboardResourceImages(){
  if(dashboardImagesMemo)return dashboardImagesMemo;
  const raw=(await chrome.storage.local.get({scmResourceImages:null})).scmResourceImages;
  dashboardImagesMemo=raw&&raw.cache&&typeof raw.cache==='object'?raw.cache:{};
  return dashboardImagesMemo;
}
scmOnStorageChanged((changes,area)=>{if(area==='local'&&changes.scmResourceImages)dashboardImagesMemo=null;});
scmOnDashboardResume(()=>{dashboardImagesMemo=null;});
async function get(attempt=0){
  const readEpoch=__realmViewEpoch;
  const s=await chrome.storage.local.get({activeRealmKey:null,selectedRealm:null,apiBase:'https://www.simcompanies.com',syncMinutes:5});
  const activeRealm=s.activeRealmKey&&String(s.activeRealmKey).match(/^realm:(\d+)$/)?.[1];
  const viewKey=activeRealm!=null?`realm:${activeRealm}`:null;
  let store=null;
  let productionPlannerState=null;
  // Perf: all remaining independent keys are read in ONE storage call (each call deserializes large blobs).
  const rn=activeRealm!=null?Number(activeRealm):null;
  const extraRealm=validRealmNumber(activeRealm!=null?rn:(s.selectedRealm!=null?Number(s.selectedRealm):null));
  const defaults={scmGameConstants:null,scmGameConfig:null,[`scmMarketOrders:${extraRealm}`]:null,[`scmSimcoPrices:${extraRealm}`]:null,scmSimcoBuildings:null,[`scmSimcoGovOrders:${extraRealm}`]:null,[`scmSimcoEvents:${extraRealm}`]:null,[`scmSimcoPhases:${extraRealm}`]:null,[`scmSimcoCompany:${extraRealm}`]:null};
  if(rn!=null){defaults[`scmRealmStore:${rn}`]=null;defaults[`scmRealmDiagnostic:${rn}`]=null;defaults[`scmProductionPlannerState:${rn}`]=null;defaults[`scmGameOverlaySnapshot:${rn}`]=null;}
  if(extraRealm!=null){defaults[`scmBackgroundJobs:${extraRealm}`]=null;defaults[`scmProductionCostHistory:${extraRealm}`]=[];defaults[`scmStatementHistory:${extraRealm}`]=null;defaults[`scmLedgerArchive:${extraRealm}`]=null;defaults[`scmEconomyStateLog:${extraRealm}`]=[];}
  const physical=await chrome.storage.local.get(defaults);
  if(activeRealm!=null){
    const realmNumber=rn;
    store=physical[`scmRealmStore:${realmNumber}`]||null;
    if(store&&physical[`scmRealmDiagnostic:${realmNumber}`]&&typeof physical[`scmRealmDiagnostic:${realmNumber}`]==='object') store={...store,fullSyncDiagnostics:physical[`scmRealmDiagnostic:${realmNumber}`]};
    if(physical[`scmGameOverlaySnapshot:${realmNumber}`]&&typeof physical[`scmGameOverlaySnapshot:${realmNumber}`]==='object') store={...(store||{}),gameOverlaySnapshot:physical[`scmGameOverlaySnapshot:${realmNumber}`]};
    productionPlannerState=physical[`scmProductionPlannerState:${realmNumber}`]&&typeof physical[`scmProductionPlannerState:${realmNumber}`]==='object'?physical[`scmProductionPlannerState:${realmNumber}`]:null;
  }
  const empty={authData:null,companyData:null,buildings:null,warehouseResources:[],gameState:null,resourceCatalog:null,endpointData:{},apiEndpoints:[],history:{},contracts:[],savedContracts:[],contractEvents:[],marketCache:{},marketDebug:{},marketTicker:null,marketQueue:[],marketQueueCursor:0,marketLastRequestAt:null,marketQueueStatus:null,liveMarketData:null,liveMarketProduct:null,liveMarketProductCache:{},liveMarketPriceData:null,resourceImageData:{},resourceImageCache:{},resourceImageMeta:{},resourceImageCacheStatus:null,warehouseCapture:null,lastSync:null,syncStatus:'No active realm data',syncError:null,fullSyncDiagnostics:null,warehouseCostDetails:{},accountingLastComputed:null,accountingLastComputedIncome:null,accountingCapture:{},accountingSnapshots:{},tickerSnapshots:{},sellingHistory:{},accountingWeekSales:{},accountingWeekSalesSummary:null,vwapData:null,vwapWatch:null,vwapStatus:null,realmQuarantine:{},productionRateSnapshots:{},productionPlans:{},productionPlannerState:null,gameOverlaySnapshot:null,productionRunHours:24,accountingWeekLedgerStatus:null,accountingDayWalkStatus:null,accountingDailySeries:null,javascriptDiagnostic:null,javascriptDiagnosticHistory:[]};
  const scoped={...empty};
  if(store){for(const key of Object.keys(empty)){if(Object.prototype.hasOwnProperty.call(store,key))scoped[key]=store[key];}}
  const result={...scoped,productionPlannerState,realmStores:viewKey?{[viewKey]:scoped}:{},activeRealmKey:s.activeRealmKey??null,selectedRealm:s.selectedRealm!=null?Number(s.selectedRealm):null,viewRealm:activeRealm!=null?Number(activeRealm):null,captureRealm:activeRealm!=null?Number(activeRealm):null,apiBase:s.apiBase,syncMinutes:s.syncMinutes};
  if(readEpoch!==__realmViewEpoch&&attempt<3)return get(attempt+1);
  const currentMeta=await chrome.storage.local.get({activeRealmKey:null});
  if(String(currentMeta.activeRealmKey??'')!==String(result.activeRealmKey??'')&&attempt<3)return get(attempt+1);
  // Images live in their own storage key (loaded once, refreshed only when images change).
  try{const imgs=await dashboardResourceImages();result.resourceImageCache={...(result.resourceImageCache||{}),...imgs};}catch{}
  // Per-realm side keys (read together above).
  try{const r=validRealmNumber(result.viewRealm??result.selectedRealm);if(r!=null&&r===extraRealm){
    const h=physical[`scmBackgroundJobs:${r}`];if(Array.isArray(h)){result.backgroundJobHistory=h;if(viewKey&&result.realmStores?.[viewKey])result.realmStores[viewKey]={...result.realmStores[viewKey],backgroundJobHistory:h};}
    const ph=physical[`scmProductionCostHistory:${r}`];result.productionCostHistory=Array.isArray(ph)?ph:[];
    const sh=physical[`scmStatementHistory:${r}`];result.statementHistory=sh&&typeof sh==='object'?sh:null;
    const la=physical[`scmLedgerArchive:${r}`];result.ledgerArchive=la&&typeof la==='object'?la:null;
    const el=physical[`scmEconomyStateLog:${r}`];result.economyStateLog=Array.isArray(el)?el:[];
  }}catch{}
  try{const r=validRealmNumber(result.viewRealm??result.selectedRealm);result.gameConstants=physical.scmGameConstants||null;result.marketOrders=physical[`scmMarketOrders:${r}`]||null;result.simcoPrices=physical[`scmSimcoPrices:${r}`]||null;result.simcoBuildings=physical.scmSimcoBuildings||null;result.simcoGovOrders=physical[`scmSimcoGovOrders:${r}`]||null;result.simcoEvents=scmSimcoAtIso(physical[`scmSimcoEvents:${r}`]);result.simcoPhases=scmSimcoAtIso(physical[`scmSimcoPhases:${r}`]);result.simcoCompany=scmSimcoAtIso(physical[`scmSimcoCompany:${r}`]);}catch{}
  try{result.gameConfig=physical.scmGameConfig||null;}catch{}
  commitDashboardState(result);
  return result;
}

// The planner core reads the SimcoTools `at` stamps as ISO strings; a numeric stamp is converted when read (storage is untouched).
function scmSimcoAtIso(v){if(v&&typeof v==='object'&&typeof v.at==='number'&&Number.isFinite(v.at))return {...v,at:new Date(v.at).toISOString()};return v||null;}
function roundCurrencyUp(value){const n=Number(value);if(!Number.isFinite(n))return NaN;const scaled=n*100;const result=Math.ceil(scaled-Number.EPSILON*Math.max(1,Math.abs(scaled)))/100;return result===0?0:result;}
function roundResourceDown(value,precision=3){const n=Number(value),digits=Number(precision);if(!Number.isFinite(n)||!Number.isInteger(digits)||digits<0||digits>8)return NaN;const factor=10**digits,scaled=n*factor;const result=Math.floor(scaled+Number.EPSILON*Math.max(1,Math.abs(scaled)))/factor;return result===0?0:result;}
function money(v){if(v==null||v==='')return '—';const n=Number(v);return Number.isFinite(n)?n.toLocaleString(undefined,{style:'currency',currency:'USD',maximumFractionDigits:2}):'—'}
function contractPriceMoney(v){const n=Number(v);return Number.isFinite(n)?n.toLocaleString(undefined,{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:3}):'—'}
function num(v){const n=Number(v);return Number.isFinite(n)?n.toLocaleString():'—'}
function escapeHtml(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
async function copyDiagnosticText(text,button){let out=String(text??'');try{const parsed=JSON.parse(out);if(parsed&&typeof parsed==='object')out=JSON.stringify(SCM_DIAGNOSTIC_CORE.redactSecrets(parsed),null,2);}catch{}try{await navigator.clipboard.writeText(out);if(button){const old=button.textContent;button.textContent='Copied';setTimeout(()=>button.textContent=old,1200);}}catch(e){const ta=document.createElement('textarea');ta.value=out;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.focus();ta.select();try{document.execCommand('copy');if(button){const old=button.textContent;button.textContent='Copied';setTimeout(()=>button.textContent=old,1200);}}finally{ta.remove();}}}
function pick(o,keys){for(const k of keys)if(o?.[k]!==undefined&&o?.[k]!==null)return o[k];return null}
function flattenObjects(x,out=[]){if(!x)return out;if(Array.isArray(x)){for(const v of x)flattenObjects(v,out);return out}if(typeof x==='object'){out.push(x);for(const v of Object.values(x)){if(v&&typeof v==='object')flattenObjects(v,out)}}return out}
const FALLBACK_RESOURCE_NAMES = {'-1':'Power',1:'Power',2:'Water',3:'Apples',4:'Oranges',5:'Grapes',6:'Grain',7:'Steak',8:'Sausages',9:'Eggs',10:'Crude oil',11:'Petrol',12:'Diesel',13:'Transport',14:'Minerals',15:'Bauxite',16:'Silicon',17:'Chemicals',18:'Aluminium',19:'Plastic',20:'Processors',21:'Electronic components',22:'Batteries',23:'Displays',24:'Smart phones',25:'Tablets',26:'Laptops',27:'Monitors',28:'Televisions',29:'Plant research',30:'Energy research',31:'Mining research',32:'Electronics research',33:'Breeding research',34:'Chemistry research',35:'Software',40:'Cotton',41:'Fabric',42:'Iron ore',43:'Steel',44:'Sand',45:'Glass',46:'Leather',47:'On-board computer',48:'Electric motor',49:'Luxury car interior',50:'Basic interior',51:'Car body',52:'Combustion engine',53:'Economy e-car',54:'Luxury e-car',55:'Economy car',56:'Luxury car',57:'Truck',58:'Automotive research',59:'Fashion research',60:'Underwear',61:'Gloves',62:'Dress',63:'Stiletto Heel',64:'Handbags',65:'Sneakers',66:'Seeds',67:'Xmas crackers',68:'Gold ore',69:'Golden bars',70:'Luxury watch',71:'Necklace',72:'Sugarcane',73:'Ethanol',74:'Methane',75:'Carbon fibers',76:'Carbon composite',77:'Fuselage',78:'Wing',79:'High grade e-comps',80:'Flight computer',81:'Cockpit',82:'Attitude control',83:'Rocket fuel',84:'Propellant tank',85:'Solid fuel booster',86:'Rocket engine',87:'Heat shield',88:'Ion drive',89:'Jet engine',90:'Sub-orbital 2nd stage',91:'Sub-orbital rocket',92:'Orbital booster',93:'Starship',94:'BFR',95:'Jumbo jet',96:'Luxury jet',97:'Single engine plane',98:'Quadcopter',99:'Satellite',100:'Aerospace research',101:'Reinforced concrete',102:'Bricks',103:'Cement',104:'Clay',105:'Limestone',106:'Wood',107:'Steel beams',108:'Planks',109:'Windows',110:'Tools',111:'Construction units',112:'Bulldozer',113:'Materials research',114:'Robots',115:'Cows',116:'Pigs',117:'Milk',118:'Coffee beans',119:'Coffee powder',120:'Vegetables',121:'Bread',122:'Cheese',123:'Apple pie',124:'Orange juice',125:'Apple cider',126:'Ginger beer',127:'Frozen pizza',128:'Pasta',129:'Hamburger',130:'Lasagna',131:'Meat balls',132:'Cocktails',133:'Flour',134:'Butter',135:'Sugar',136:'Cocoa',137:'Dough',138:'Sauce',139:'Fodder',140:'Chocolate',141:'Vegetable oil',142:'Salad',143:'Samosa',144:'Xmas ornament',145:'Recipes',146:'Pumpkin',147:'Jack o\'lantern',148:'Witch costume',149:'Pumpkin soup',150:'Tree',151:'Easter Bunny',152:'Ramadan sweets',153:'Chocolate icecream',154:'Apple icecream',155:'Cream egg'};
// resourceInfo() runs this for every warehouse row / planner resource and, when an image is not in the catalog, would
// flatten the whole captured endpoint data (MBs) per resource. Both are memoized per captured object.
const __scmCatalogMemo=new WeakMap(),__scmImageIndexMemo=new WeakMap(),__scmFlatMemo=new WeakMap();
function catalogEntries(s){
  const cat=s?.resourceCatalog;if(cat&&typeof cat==='object'){const m=__scmCatalogMemo.get(cat);if(m)return m;const built=catalogEntriesBuild(s);__scmCatalogMemo.set(cat,built);return built;}
  return catalogEntriesBuild(s);
}
// id → image found anywhere in the captured objects (buildings, game state, endpoint data); built once per object set.
function scmCapturedImageIndex(s,sources){
  const anchor=s?.endpointData&&typeof s.endpointData==='object'?s.endpointData:null;
  const memo=anchor?__scmImageIndexMemo.get(anchor):null;
  if(memo&&memo.b===s?.buildings&&memo.g===s?.gameState)return memo.index;
  const index=new Map();
  for(const o of flattenObjects(sources)){
    if(!o||typeof o!=='object')continue;
    const img=pick(o,['image','icon','iconUrl','imageUrl','picture','img']);
    if(!img||!/(?:^|\/)images\/resources\//i.test(String(img)))continue;
    const oid=pick(o,['kind','resourceId','productId','resource','product']);
    if(oid!=null&&Number.isFinite(Number(oid))&&!index.has(Number(oid)))index.set(Number(oid),img);
  }
  if(anchor)__scmImageIndexMemo.set(anchor,{b:s?.buildings,g:s?.gameState,index});
  return index;
}
function catalogEntriesBuild(s){
  const root=s.resourceCatalog?.constantsResources||{}; const out=new Map();
  const imageMap=s.resourceCatalog?.resourceImages||{}; const nameMap=s.resourceCatalog?.resourceNames||{};
  const add=(id,o)=>{if(id==null)return; const sid=String(id); const n=pick(o,['name','resourceName','displayName','title','label','enName','englishName'])||nameMap[sid]; const image=pick(o,['image','icon','iconUrl','imageUrl','picture','img'])||imageMap[sid]; if(n||image)out.set(sid,{name:n||FALLBACK_RESOURCE_NAMES[id]||`Resource #${id}`,image});};
  if(Array.isArray(root)) root.forEach(o=>add(pick(o,['resourceId','productId','kind','id','dbLetter']),o));
  else Object.entries(root).forEach(([id,o])=>add(id,o));
  Object.keys(imageMap).forEach(id=>{if(!out.has(id))out.set(id,{name:nameMap[id]||FALLBACK_RESOURCE_NAMES[id]||`Resource #${id}`,image:imageMap[id]});});
  return out;
}
function imageCandidates(image){
  if(!image)return [];
  const raw=String(image).trim(); if(/^data:image\//i.test(raw))return [raw];
  const out=[]; const add=u=>{if(u&&!out.includes(u))out.push(u)};
  if(/^https?:\/\//i.test(raw)||raw.startsWith('//')) add(raw);
  else {
    const path=raw.startsWith('/')?raw:'/'+raw;
    if(path.startsWith('/static/')) add('https://www.simcompanies.com'+path);
    else if(path.startsWith('/images/')) { add('https://www.simcompanies.com/static'+path); add('https://www.simcompanies.com'+path); }
    else if(path.startsWith('/resources/')) { add('https://www.simcompanies.com/static/images'+path); add('https://www.simcompanies.com/static'+path); }
    else { add('https://www.simcompanies.com/static/'+path.replace(/^\//,'')); add('https://www.simcompanies.com/'+path.replace(/^\//,'')); }
  }
  return out;
}
const pendingResourceImages=new Map();
function requestResourceImage(id){const n=Number(id);if(!Number.isFinite(n))return;const now=Date.now();const last=pendingResourceImages.get(n)||0;if(now-last<10000)return;pendingResourceImages.set(n,now);try{chrome.runtime.sendMessage({type:'GET_RESOURCE_IMAGE',resource:n}).catch(()=>{});}catch{}}
const RESOURCE_IMAGE_FILE_OVERRIDES={
  1:'power.png',2:'water.png',3:'apples.png',4:'oranges.png',5:'grapes.png',6:'grain.png',7:'steak.png',8:'sausages.png',9:'eggs.png',10:'crude-oil.png',11:'petrol.png',12:'diesel.png',13:'transport.png',14:'minerals.png',15:'bauxite.png',16:'silicon.png',17:'chemicals.png',18:'aluminium.png',19:'plastic.png',20:'processors.png',21:'electronic-components.png',22:'batteries.png',23:'displays.png',24:'smart-phones.png',25:'tablets.png',26:'laptops.png',27:'monitors.png',28:'televisions.png',29:'plant-research.png',30:'energy-research.png',31:'mining-research.png',32:'electronics-research.png',33:'breeding-research.png',34:'chemistry-research.png',35:'software.png',40:'cotton.png',41:'fabric.png',42:'iron-ore.png',43:'steel.png',44:'sand.png',45:'glass.png',46:'leather.png',47:'on-board-computer.png',48:'electric-motor.png',49:'luxury-car-interior.png',50:'car-interior.png',51:'car-body.png',52:'combustion-engine.png',53:'economy-e-car.png',54:'luxury-e-car.png',55:'economy-car.png',56:'luxury-car.png',57:'truck.png',58:'automotive-research.png',59:'fashion-research.png',60:'underwear.png',61:'gloves.png',62:'dress.png',63:'simmi-shoes.png',64:'handbags.png',65:'sneakers.png',66:'seeds.png',67:'xmas-crackers.png',68:'gold-ore.png',69:'golden-bars.png',70:'gold-watch.png',71:'necklace.png',72:'sugarcane.png',73:'ethanol.png',74:'methane.png',75:'carbon-fiber.png',76:'carbon-composite.png',77:'fuselage.png',78:'wing.png',79:'high-grade-e-components.png',80:'flight-computer.png',81:'cockpit.png',82:'attitude-control.png',83:'rocket-fuel.png',84:'fuel-tank.png',85:'solid-rocket.png',86:'rocket-engine.png',87:'heat-shield.png',88:'ion-drive.png',89:'jet-engine.png',90:'sub-orbital-second-stage.png',91:'sub-orbital-rocket2.png',92:'orbital-booster.png',93:'starship.png',94:'BFR.png',95:'jumbojet2.png',96:'private-jet.png',97:'single-engine.png',98:'quadcopter.png',99:'satellite.png',100:'aero-research.png',101:'reinforced-concrete.png',102:'bricks.png',103:'cement.png',104:'clay.png',105:'limestone.png',106:'wood.png',107:'steel-beams.png',108:'planks.png',109:'windows.png',110:'tools.png',111:'construction-units.png',112:'bulldozer.png',113:'materials-research.png',114:'robots.png',115:'cow.png',116:'pig.png',117:'milk.png',118:'coffee-beans.png',119:'coffee-ground.png',120:'vegetables.png',121:'bread.png',122:'cheese.png',123:'apple-pie.png',124:'orange-juice.png',125:'apple-cider.png',126:'ginger-beer.png',127:'pizza.png',128:'pasta.png',129:'hamburger.png',130:'lasagna.png',131:'meatballs.png',132:'cocktails.png',133:'flour.png',134:'butter.png',135:'sugar.png',136:'cocoa-beans.png',137:'dough.png',138:'gravy-boat.png',139:'fodder.png',140:'chocolate.png',141:'vegetable-oil.png',142:'salad.png',143:'samosas.png',144:'xmas-ornament.png',145:'recipes.png',146:'pumpkin.png',147:'jack-o-lantern.png',148:'witch-costume.png',149:'pumpkin-soup.png',150:'tree.png',151:'easter-bunny.png',152:'ramadan-sweets.png',153:'icecream-chocolate.png',154:'icecream-apple.png',155:'cream-egg.png'
};
// Same list and same rule (lowercase filename, query stripped) as background.js RESOURCE_IMAGE_KNOWN_404_FILENAMES.
function isKnown404ResourceImage(nameOrUrl){return RESOURCE_IMAGE_404_FILENAMES.has(String(nameOrUrl||"").split("/").pop().split("?")[0].toLowerCase());}
const RESOURCE_IMAGE_404_FILENAMES=new Set(["smartphones.png", "basic-interior.png", "economy-electric-car.png", "luxury-electric-car.png", "economy-fuel-car.png", "luxury-fuel-car.png", "skirt.png", "high-heels.png", "handbag.png", "sports-shoes.png", "luxury-watch.png", "carbon-fibers.png", "high-grade-e-comps.png", "propellant-tank.png", "solid-fuel-booster.png", "aerospace-research.png", "beams.png", "cows.png", "pigs.png", "frozen-pizza.png", "meat-balls.png", "cocoa.png", "sauce.png", "samosa.png", "chocolate-icecream.png", "apple-icecream.png"]);
function resourceImageSlug(name){
  return String(name||'').toLowerCase().replace(/&/g,'and').replace(/['’]/g,'').replace(/\bsub orbital\b/g,'sub-orbital').replace(/\s*2nd\s*stage\b/g,'2nd-stage').replace(/\s+/g,'-').replace(/[^a-z0-9-]+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
}
// Perf: per-captured-object memos (first path per resource id; flattened objects per data blob).
const __scmResPathMemo=new WeakMap();
function scmResourcePathIndex(ed){
  const keys=Object.keys(ed);const m=__scmResPathMemo.get(ed);if(m&&m.n===keys.length&&m.first===keys[0]&&m.last===keys[keys.length-1])return m.index;
  const index=new Map();for(const k of keys){const mm=k.match(/^\/api\/v3\/resources\/(\d+)\/?(?:\?.*)?$/);if(mm&&!index.has(Number(mm[1])))index.set(Number(mm[1]),k);}
  __scmResPathMemo.set(ed,{n:keys.length,first:keys[0],last:keys[keys.length-1],index});return index;
}
function scmFlatObjects(data){
  if(!data||typeof data!=='object')return flattenObjects(data);
  const m=__scmFlatMemo.get(data);if(m&&m.flat)return m.flat;
  const flat=flattenObjects(data);__scmFlatMemo.set(data,{flat});return flat;
}
function resourceInfo(x,s){
  const id=pick(x,['kind','resource','resourceId','productId']); const map=catalogEntries(s); const c=id!=null?map.get(String(id)):null;
  let image=s.resourceImageCache?.[String(id)]||s.resourceImageData?.[String(id)]||c?.image||s.resourceCatalog?.resourceImages?.[String(id)]||null;
  if(!image && id!=null){
    const root=s.resourceCatalog?.constantsResources||{}; const o=root[String(id)];
    image=pick(o,['image','icon','iconUrl','imageUrl','picture','img']);
  }
  if(!image && id!=null){
    const ed=s.endpointData&&typeof s.endpointData==='object'?s.endpointData:null;
    const path=ed?scmResourcePathIndex(ed).get(Number(id)):null;
    const data=path?ed[path]?.data:null;
    const found=scmFlatObjects(data).find(o=>o&&typeof o==='object'&&pick(o,['image','icon','iconUrl','imageUrl','picture','img']));
    image=found?pick(found,['image','icon','iconUrl','imageUrl','picture','img']):null;
  }
  const name=c?.name||FALLBACK_RESOURCE_NAMES[id]||pick(x,['product','name','resourceName'])||`Resource #${id}`;
  if(!image && id!=null){
    image=scmCapturedImageIndex(s,[s.buildings,s.gameState,s.endpointData]).get(Number(id))||null;
  }
  const candidates=imageCandidates(image).filter(candidate=>!isKnown404ResourceImage(candidate));
  const override=Number.isFinite(Number(id))?RESOURCE_IMAGE_FILE_OVERRIDES[String(Number(id))]:null;
  const guessedName=override||`${resourceImageSlug(name)}.png`;
  if(guessedName&&!isKnown404ResourceImage(guessedName)){
    const guessed=`https://www.simcompanies.com/static/images/resources/${guessedName}`;
    if(!candidates.includes(guessed))candidates.push(guessed);
  }
  return {id:Number(id),name,imageCandidates:candidates};
}
function resourceName(x,s){return resourceInfo(x,s).name}
function warehouseId(x){
  const v=pick(x,['kind','resource','resourceId','productId','resourceKind','dbLetter']);
  if(v&&typeof v==='object') return Number(pick(v,['kind','resourceId','productId','id']));
  return Number(v);
}
function warehouseQuality(x){
  const v=pick(x,['quality','q','resourceQuality','itemQuality']);
  if(v&&typeof v==='object') return Number(pick(v,['quality','q','value']));
  return Number(v);
}
function warehouseQuantity(x){
  const v=pick(x,['amount','quantity','qty','units','count','resourceQuantity','productQuantity','stock','inventory','quantityInWarehouse','amountInWarehouse','available']);
  if(v&&typeof v==='object') return Number(pick(v,['amount','quantity','qty','units','count','value']));
  return Number(v);
}
function warehouseCostDetailCandidates(s,id,q,qty){
  const realm=Number(s.viewRealm??s.authData?.authCompany?.realmId??s.authData?.authCompany?.realm);
  const key=Number.isFinite(realm)?`realm:${realm}`:null;
  const details=key?(s.warehouseCostDetails?.[String(id)]??null):null;
  if(!Array.isArray(details)||!details.length)return [];
  const exactQ=details.filter(x=>Number(x.quality)===Number(q));
  if(exactQ.length)return exactQ;
  // The game UI and resource API can represent quality differently on some
  // warehouse screens. Try the adjacent quality index, but only use it when
  // quantity also agrees or there is a single unambiguous captured detail.
  const adjacentQ=details.filter(x=>Math.abs(Number(x.quality)-Number(q))===1 && Number(x.quantity)===Number(qty));
  if(adjacentQ.length)return adjacentQ;
  const exactQty=details.filter(x=>Number(x.quantity)===Number(qty));
  if(exactQty.length)return exactQty;
  return details.length===1?details:[];
}

function warehouseRows(s){
  const source = Array.isArray(s.warehouseResources) && s.warehouseResources.length
    ? s.warehouseResources
    : (Array.isArray(s.gameState?.region?.warehouseResources) ? s.gameState.region.warehouseResources : []);
  // The game-localStorage snapshot can contain the full sourcing-cost breakdown
  // even when the later API resource response omits it. Keep that snapshot as a
  // cost fallback for the exact product/quality row instead of losing a known
  // cost just because a second response replaced the warehouse array.
  const costFallback = new Map();
  const fallbackRows = Array.isArray(s.gameState?.region?.warehouseResources) ? s.gameState.region.warehouseResources : [];
  for(const row of fallbackRows){
    if(!row || typeof row!=='object') continue;
    const id=warehouseId(row), q=warehouseQuality(row);
    if(Number.isFinite(id)&&Number.isFinite(q)) costFallback.set(`${id}:${q}`, row);
  }
  const groups = new Map();
  const numericCost = v => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') { const n=Number(v.replace(/[$,%\s,]/g,'')); return Number.isFinite(n)?n:null; }
    return null;
  };
  // Sim Companies exposes sourcing cost in more than one shape. The normal
  // warehouse response uses `cost` as a breakdown, but some resource rows can
  // expose a sourcing/total cost field instead. Keep the original breakdown
  // behavior and add explicit sourcing-cost aliases without treating arbitrary
  // numeric fields (quantities, ids, percentages) as costs.
  const costFromValue = (v, depth=0) => {
    if (depth>5 || v==null) return null;
    const direct=numericCost(v);
    if(direct!=null) return direct;
    if(Array.isArray(v)){
      let sum=0, found=false;
      for(const item of v){
        if(item&&typeof item==='object'){
          const candidate=item.cost ?? item.totalCost ?? item.amountCost ?? item.value ?? item.price ?? item.sourcingCost ?? item.totalSourcingCost;
          const n=costFromValue(candidate,depth+1);
          if(n!=null){sum+=n;found=true;}
        }else{
          const n=costFromValue(item,depth+1); if(n!=null){sum+=n;found=true;}
        }
      }
      return found?sum:null;
    }
    if(typeof v==='object'){
      let sum=0, found=false;
      for(const [k,val] of Object.entries(v)){
        // This function is called only on a cost/sourcing-cost value. Numeric
        // amount/quantity fields inside that cost breakdown are therefore valid
        // cost components (for example a nested labor/material amount). Do not
        // discard them merely because the same names are quantity fields on the
        // outer warehouse row.
        if(/^(id|kind|quality|percentage|percent|share)$/i.test(k)) continue;
        const n=costFromValue(val,depth+1);
        if(n!=null){sum+=n;found=true;}
      }
      return found?sum:null;
    }
    return null;
  };
  const extractCost = (x, qty) => {
    let totalCost=null;
    if(x.cost!=null) totalCost=costFromValue(x.cost);
    if(totalCost==null){
      const totalCandidate=x.totalCost ?? x.totalCostValue ?? x.costTotal ?? x.totalSourcingCost ?? x.sourcingCostTotal ?? x.sourcingCost;
      if(totalCandidate!=null){
        const n=costFromValue(totalCandidate);
        if(n!=null){
          const key=Object.keys(x).find(k=>x[k]===totalCandidate) || '';
          const looksUnit=/unit|per.?item|average|avg/i.test(key);
          totalCost=looksUnit?n*qty:n;
        }
      }
    }
    if(totalCost==null){
      for(const key of ['unitCost','costPerUnit','cost_per_unit','averageCost','avgCost','costPerItem','unitSourcingCost','sourcingCostPerUnit','averageSourcingCost']){
        const unit=numericCost(x[key]);
        if(unit!=null){ totalCost=unit*qty; break; }
      }
    }
    return totalCost;
  };
  for(const x of source){
    if(!x || typeof x!=='object') continue;
    const id=warehouseId(x);
    const q=warehouseQuality(x);
    const qty=warehouseQuantity(x)||0;
    if(!Number.isFinite(id)||id<=0||!Number.isFinite(q)||!Number.isFinite(qty)||qty<=0) continue;
    const key=`${id}:${q}`;
    let totalCost=extractCost(x,qty);
    if(totalCost==null){
      const fallback=costFallback.get(key);
      if(fallback && fallback!==x) totalCost=extractCost(fallback,qty);
    }
    if(totalCost==null){
      const details=warehouseCostDetailCandidates(s,id,q,qty);
      if(details.length){
        const d=details[details.length-1];
        const unit=Number(d.unitCost);
        if(Number.isFinite(unit)) totalCost=unit*qty;
      }
    }
    // Keep the exact lot evidence even though downstream market/planner views
    // still use a product+quality aggregate. Never collapse provenance into the
    // aggregate-only row: lot id, timestamp, quantity, blocked flag, materials,
    // raw cost components and the source of any fallback cost remain inspectable.
    const lotCostSource = x.cost!=null ? 'warehouse-lot-cost-components'
      : (costFallback.get(key)&&costFallback.get(key)!==x&&extractCost(costFallback.get(key),warehouseQuantity(costFallback.get(key))||qty)!=null ? 'same-product-quality-snapshot-fallback' : 'no-lot-cost');
    const lotProvenance = {
      id:x.id??x.lotId??null, datetime:x.datetime??x.timestamp??null,
      kind:id, quality:q, amount:qty, blocked:Boolean(x.blocked),
      materials:Array.isArray(x.materials)?[...x.materials]:null,
      rawCost:x.cost!=null?JSON.parse(JSON.stringify(x.cost)):null,
      totalCost:totalCost, unitCost:totalCost!=null&&qty>0?totalCost/qty:null,
      costSource:lotCostSource
    };
    const g=groups.get(key);
    if(g){
      g._qty+=qty;
      g._lots.push(lotProvenance);
      if(totalCost!=null){
        g._totalCost=(g._totalCost??0)+totalCost;
      }
    } else {
      groups.set(key,{...x,_qty:qty,_quality:q,_id:id,_totalCost:totalCost,_lots:[lotProvenance]});
    }
  }
  return [...groups.values()].map(x=>({...x,_unitCost:x._qty>0&&x._totalCost!=null?x._totalCost/x._qty:null}));
}


function simcoVwapRows(s,id,q){
  const v=cachedMarketVwap(s,id,q);
  return v!=null?[{quality:Number(q),price:v,quantity:1,source:'SimcoTools'}]:[];
}
function labelize(k){
  return String(k||'').replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/[_-]+/g,' ').replace(/\s+/g,' ').replace(/^./,c=>c.toUpperCase());
}
function numericValue(v){
  if(typeof v==='number'&&Number.isFinite(v))return v;
  if(typeof v==='string'){const n=Number(v.replace(/[$,%\s,]/g,''));return Number.isFinite(n)?n:null;}
  return null;
}
function financialEntries(obj, exclude=new Set()){
  const out=[]; if(!obj||typeof obj!=='object'||Array.isArray(obj))return out;
  for(const [k,v] of Object.entries(obj)){
    if(exclude.has(k))continue;
    const n=numericValue(v); if(n!==null)out.push([labelize(k),n,k]);
  }
  return out;
}
function pickNumericDeep(obj, keys){
  const wanted=new Set(keys.map(k=>String(k).toLowerCase())); const seen=new Set();
  const walk=v=>{
    if(!v||typeof v!=='object'||seen.has(v))return null; seen.add(v);
    if(!Array.isArray(v)){
      for(const [k,x] of Object.entries(v)){ if(wanted.has(String(k).toLowerCase())){const n=numericValue(x);if(n!==null)return n;} }
      for(const x of Object.values(v)){const r=walk(x);if(r!==null)return r;}
    } else for(const x of v){const r=walk(x);if(r!==null)return r;}
    return null;
  };
  return walk(obj);
}
function renderStatementRows(rows){return rows.length?rows.map(([k,v])=>`<tr><td>${escapeHtml(k)}</td><td>${money(v)}</td></tr>`).join(''):'<tr><td colspan="2">No numeric fields captured yet.</td></tr>';}
function statementTable(title,rows){return `<div class="statement-card"><h3>${escapeHtml(title)}</h3><div class="table-wrap"><table class="statement-table"><thead><tr><th>Item</th><th>Amount</th></tr></thead><tbody>${renderStatementRows(rows)}</tbody></table></div></div>`;}
function gameStatementCard(title,lines,extra){
  const rows=lines.map(l=>{
    if(l.kind==='head')return `<tr class="stmt-head"><td colspan="2">${escapeHtml(l.label)}</td></tr>`;
    if(l.kind==='sub')return `<tr class="stmt-sub"><td colspan="2">${escapeHtml(l.label)}</td></tr>`;
    const cls=l.kind==='line'?(l.indent?'stmt-indent':''):`stmt-${l.kind}`;
    return `<tr class="${cls}"><td>${escapeHtml(l.label||'')}</td><td>${money(l.value)}</td></tr>`;
  }).join('');
  const more=(extra||[]).length?`<h4 class="stmt-extra-head">Other captured fields</h4><div class="table-wrap"><table class="statement-table game-statement"><colgroup><col><col class="stmt-val"></colgroup><tbody>${extra.map(x=>`<tr><td>${escapeHtml(labelize(x.key))}</td><td>${money(x.value)}</td></tr>`).join('')}</tbody></table></div>`:'';
  return `<div class="table-wrap"><table class="statement-table game-statement" aria-label="${escapeHtml(title)}"><colgroup><col><col class="stmt-val"></colgroup><tbody>${rows}</tbody></table></div>${more}`;
}
function gameRatioValue(r){
  if(!Number.isFinite(r.value))return Number.isNaN(r.value)?'—':(r.value<0?'-∞':'∞');
  return r.percent?`${(r.value*100).toFixed(2)}%`:r.value.toFixed(3);
}
function accountingFinancialRatios(income,bs){
  const g=SCM_TOOLS_CORE.gameFinancialStatements(income,bs,{});
  if(!g.ratiosAvailable)return '<p class="muted">Ratios need a computed income statement and balance sheet. Open Accounting in the game and press Sync.</p>';
  const rows=g.ratios.map(r=>r.kind?`<tr class="stmt-head"><td colspan="2">${escapeHtml(r.label)}</td></tr>`:`<tr><td>${escapeHtml(r.label)}<div class="muted stmt-formula">${escapeHtml(r.formula)}</div></td><td class="${r.value>=0?'ok':'warn'}">${gameRatioValue(r)}</td></tr>`).join('');
  return `<div class="table-wrap"><table class="statement-table game-statement" aria-label="Financial Ratios"><colgroup><col><col class="stmt-val"></colgroup><tbody>${rows}</tbody></table></div>`;
}
function buildBalanceSections(bs){
  if(!bs||typeof bs!=='object')return '<p class="muted">No balance sheet response captured yet. Open Sim Companies HQ/Accounting and press Sync.</p>';
  if(Object.keys(bs).length&&typeof SCM_TOOLS_CORE!=='undefined'){const g=SCM_TOOLS_CORE.gameFinancialStatements({},bs,{});return gameStatementCard('Balance Sheet',g.balance,g.extra.bs);}
  const used=new Set();
  const add=(keys,label)=>{const rows=[];for(const k of keys){if(bs[k]!==undefined){const n=numericValue(bs[k]);if(n!==null){rows.push([labelize(k),n]);used.add(k);}}}return rows;};
  const assets=add(['cash','accountsReceivable','materials','workInProcess','finishedGoods','research','deposits','investmentInBonds','buildings','patents','valuationAllowance','otherAssets'],'Assets');
  if(bs.materials!==undefined||bs.workInProcess!==undefined||bs.finishedGoods!==undefined||bs.valuationAllowance!==undefined){const inv=(numericValue(bs.materials)||0)+(numericValue(bs.workInProcess)||0)+(numericValue(bs.finishedGoods)||0)+(numericValue(bs.valuationAllowance)||0);assets.splice(1,0,['Inventory',inv]);}
  const liabilities=add(['bondsPayable','accountsPayable','loans','otherLiabilities','liabilities','totalLiabilities'],'Liabilities');
  const equity=add(['contributedCapital','retainedEarnings','equity','totalEquity'],'Equity');
  const extra=financialEntries(bs,used);
  return `<div class="statement-grid">${statementTable('Assets',assets)}${statementTable('Liabilities',liabilities)}${statementTable('Equity',equity)}${extra.length?statementTable('Other balance-sheet fields',extra):''}</div>`;
}
// The game's own daily history (past-finances-overview + v3 past-finances)
// gives every completed day's profit, assets, liabilities, inventory and cash. Use it
// for the "vs previous day" comparison instead of whatever the dashboard last rendered.
function accountingDailyHistory(overview,detail,ledger=[],check={sales:true,expenses:true}){
  const byDay=new Map();
  const dayKey=d=>{const t=Date.parse(String(d||'').replace(' ','T'));return Number.isFinite(t)?t:null;};
  const add=(rows,map)=>{for(const r of Array.isArray(rows)?rows:[]){const t=dayKey(r?.date);if(t==null)continue;const k=Math.round(t/3600000);const cur=byDay.get(k)||{t};map(cur,r);byDay.set(k,cur);}};
  const n=v=>{if(v==null||v==='')return null;const x=Number(v);return Number.isFinite(x)?x:null;};
  add(detail,(c,r)=>{c.cash=n(r.cashAndReceivables);c.inventory=n(r.inventory);c.assets=n(r.total);c.liabilities=n(r.liabilities);c.currentAssets=n(r.currentAssets);c.rank=n(r.rank);c.buildings=n(r.buildings);c.patents=n(r.patents);});
  add(overview,(c,r)=>{c.profit=n(r.evaProfit);c.economicValueAdded=n(r.economicValueAdded);c.assets=n(r.total)??c.assets;c.liabilities=n(r.liabilities)??c.liabilities;c.currentAssets=n(r.currentAssets)??c.currentAssets;c.rank=n(r.rank)??c.rank;c.evaRank=n(r.evaRank);});
  const days=[...byDay.values()].sort((a,b)=>a.t-b.t);
  // Revenue / expenses per completed day from the cash-flow ledger, only when the ledger
  // reaches back past the start of that day (otherwise the total would be incomplete).
  const first=ledger.reduce((m,[t])=>Math.min(m,t),Infinity);
  for(let i=1;i<days.length;i++){
    const start=days[i-1].t,end=days[i].t;
    if(!(first<start))continue;
    // Sales = exchange fills (m) + contract/retail sales (t, r): equals the income
    // statement's Sales (fromExchange + fromCustomers); royalties/interest are not sales.
    let inc=0,exp=0,sales=0;for(const [t,m,c] of ledger){if(t>=start&&t<end){if(m>0){inc+=m;if(c==='m'||c==='t'||c==='r')sales+=m;}else exp+=-m;}}
    if(check.sales){days[i].cashIn=inc;days[i].sales=sales;}if(check.expenses)days[i].expenses=exp;
  }
  return days;
}
function gameOperatingExpenses(e){
  // Game income statement "Operating expenses" subtotal (GamePages): construction + salaries + training + poaching + exchange fees.
  if(!e||typeof e!=='object'||!('marketFees' in e||'salariesCosts' in e))return null;
  const v=k=>Number(e[k])||0; return v('constructionCosts')+v('salariesCosts')+v('trainingCosts')+v('poachingCosts')+v('marketFees');
}
function accountingDayBalanceSheets(endpointData,realmMatches=()=>true){
  const out=new Map();const n=v=>v==null||v===''||!Number.isFinite(Number(v))?null:Number(v);
  for(const [k,item] of Object.entries(endpointData||{})){
    if(!/\/api\/v2\/companies\/(?:me|\d+)\/balance-sheet\/day\/\d+\/?$/i.test(k))continue;
    const e=item?.data; if(Number(item?.status)!==200||!e||typeof e!=='object'||e.isComputed===false||!realmMatches(item))continue;
    const t=Date.parse(String(e.date||'').replace(' ','T')); if(!Number.isFinite(t))continue;
    out.set(Math.round(t/60000),{accountsPayable:n(e.accountsPayable),bondsPayable:n(e.bondsPayable)});
  }
  return out;
}
function accountingDayStatements(endpointData,realmMatches=()=>true){
  const out=new Map();
  for(const [k,item] of Object.entries(endpointData||{})){
    if(!/\/api\/v2\/companies\/(?:me|\d+)\/income-statement\/day\/\d+\/?$/i.test(k))continue;
    const e=item?.data; if(Number(item?.status)!==200||!e||e.isComputed!==true||!realmMatches(item))continue;
    const t=Date.parse(String(e.date||'').replace(' ','T')); if(!Number.isFinite(t))continue;
    out.set(Math.round(t/60000),accountingStatementDay(e));
  }
  return out;
}
function accountingStatementDay(e){
  // One completed game day of the income statement, as the Accounting overview cards read it.
  // Executives cost = salaries + training + poaching (game Operating expenses lines).
  const v=k=>Number(e?.[k])||0;
  return {sales:v('sales'),cogs:v('cogs'),freightOut:v('freightOut'),marketFees:v('marketFees'),executives:v('salariesCosts')+v('trainingCosts')+v('poachingCosts'),operatingExpenses:gameOperatingExpenses(e),netIncome:v('netIncome'),dateFrom:e?.dateFrom,date:e?.date};
}
function accountingDayCashflows(endpointData,realmMatches=()=>true){
  // /cashflow-statement/day/<n>/ (read by the Accounting walk): Total change in cash per completed day.
  const out=new Map();
  for(const [k,item] of Object.entries(endpointData||{})){
    if(!/\/api\/v2\/companies\/(?:me|\d+)\/cashflow-statement\/day\/\d+\/?$/i.test(k))continue;
    const e=item?.data; if(Number(item?.status)!==200||!e||e.isComputed!==true||!realmMatches(item))continue;
    const t=Date.parse(String(e.date||'').replace(' ','T')); if(!Number.isFinite(t))continue;
    out.set(Math.round(t/60000),accountingCashChange(e));
  }
  return out;
}
function accountingCashChange(e){
  // Game cash-flow statement "Total change in cash" = all cash in + all cash out (cashAllExpenses is negative).
  if(!e||typeof e!=='object'||e.cashAllIncome==null||e.cashAllExpenses==null)return null;
  const n=Number(e.cashAllIncome)+Number(e.cashAllExpenses);return Number.isFinite(n)?n:null;
}
function accountingPreviousPeriod(history,periodEnd){
  const end=Date.parse(String(periodEnd||''));
  if(!Array.isArray(history)||!history.length)return null;
  const rows=Number.isFinite(end)?history.filter(r=>r.t<end-3600000):history.slice(0,-1);
  const r=rows[rows.length-1];
  if(!r)return null;
  return {cash:r.cash??null,cashChange:r.cashChange??null,sales:r.sales??null,netIncome:r.netIncome??r.profit??null,cogs:r.cogs??null,freightOut:r.freightOut??null,marketFees:r.marketFees??null,executives:r.executives??null,profit:r.netIncome??r.profit??null,operatingExpenses:r.operatingExpenses??null,assets:r.assets??null,liabilities:r.liabilities??null,inventory:r.inventory??null,currentAssets:r.currentAssets??null,currentLiabilities:r.liabilities??null,revenue:r.sales??null,cashIn:r.statement?null:(r.cashIn??null),expenses:r.expenses??null,date:new Date(r.t).toISOString(),source:'game-history'};
}
function accounting(s, realmStore=null){
  const endpointData=(realmStore?.endpointData&&typeof realmStore.endpointData==='object')?realmStore.endpointData:(s.endpointData||{});
  const viewRealm=Number.isFinite(Number(s.viewRealm))?Number(s.viewRealm):Number.isFinite(Number(realmStore?.accountingSnapshots?.realm))?Number(realmStore.accountingSnapshots.realm):null;
  const realmMatches=item=>{const cr=Number(item?.captureRealm);return viewRealm==null || (Number.isFinite(cr)&&cr===viewRealm);};
  const eps=Object.keys(endpointData);
  const latest=(rx)=>{
    const ks=eps.filter(k=>rx.test(k)&&Number(endpointData[k]?.status)===200&&endpointData[k]?.data!=null&&realmMatches(endpointData[k]));
    ks.sort((a,b)=>new Date(endpointData[b]?.receivedAt||0)-new Date(endpointData[a]?.receivedAt||0));
    return ks.length?endpointData[ks[0]]?.data:null;
  };
  const supplemental=realmStore?.accountingCapture||{};
  const latestSupplemental=(path)=>{const item=supplemental[path];return item&&realmMatches(item)?item.data??null:null;};
  // The latest finished game day = the computed statement with the newest end date, from this realm only.
  // The current statement and the Accounting walk's day/0 are the same day; whichever was read last is newer.
  // (Sorting by receipt time let an older day, or the other realm's statement, set the period.)
  const statementEnd=x=>{const t=Date.parse(String(x?.data?.date||'').replace(' ','T'));return Number.isFinite(t)?t:0;};
  const latestComputed=(rx,path)=>{
    const candidates=eps.filter(k=>rx.test(k)&&Number(endpointData[k]?.status)===200&&endpointData[k]?.data!=null)
      .map(k=>endpointData[k]).filter(x=>x?.data?.isComputed===true&&realmMatches(x))
      .sort((a,b)=>statementEnd(b)-statementEnd(a)||new Date(b.receivedAt||0)-new Date(a.receivedAt||0));
    if(candidates.length)return candidates[0].data;
    const direct=latestSupplemental(path);
    if(direct?.isComputed===true)return direct;
    if(path.includes('cashflow-statement')){
      const savedItem=realmStore?.accountingLastComputed;
      const saved=savedItem&&realmMatches(savedItem)?savedItem.data:null;
      if(saved?.isComputed===true)return saved;
    }
    if(path.includes('income-statement')){
      const savedItem=realmStore?.accountingLastComputedIncome;
      const saved=savedItem&&realmMatches(savedItem)?savedItem.data:null;
      if(saved?.isComputed===true)return saved;
    }
    return null;
  };
  const bs=latest(/\/api\/v2\/companies\/(?:me|\d+)\/balance-sheet\/?$/i)
    ?? latestSupplemental('/api/v2/companies/me/balance-sheet/');
  // Prefer the most recent COMPLETED aggregate period. At the daily rollover
  // Sim Companies can return an isComputed:false zero placeholder; that is not
  // an accounting period and must never replace the previous completed data.
  const cf=latestComputed(/\/api\/v2\/companies\/(?:me|\d+)\/cashflow-statement(?:\/day\/0|\/\d+)?\/?$/i,'/api/v2/companies/me/cashflow-statement/')
    ?? latest(/\/api\/v2\/companies\/(?:me|\d+)\/cashflow-statement(?:\/\d+)?\/?$/i)
    ?? latest(/\/api\/v2\/companies\/(?:me|\d+)\/cashflow(?:\/recent)?(?:\/\d+)?\/?$/i);
  // Prefer the dedicated recent cash-flow ledger. Other financial endpoints can
  // be newer than it during Full Sync, but Top 10 Gross Resources needs the
  // transaction rows from /cashflow/recent/ (amount, price, profit, resource).
  const recent=latest(/\/api\/v2\/companies\/(?:me|\d+)\/cashflow\/recent\/?$/i)
    ?? latest(/\/api\/(?:v2|v3)\/companies\/(?:me|\d+)(?:\/[^?]*)?(?:cashflow|cash-flow|financial)[^?]*(?:\/\d+)?\/?(?:\?.*)?$/i);
  const pf=latest(/\/api\/(?:v2\/companies\/(?:me|\d+)\/past-finances-overview|v3\/companies\/(?:me|\d+)\/past-finances)(?:\/\d+)?\/?/i);
  const income=latestComputed(/\/api\/v2\/companies\/(?:me|\d+)\/income-statement(?:\/day\/0|\/\d+)?\/?$/i,'/api/v2/companies/me/income-statement/')
    ?? latest(/\/api\/v2\/companies\/(?:me|\d+)\/(?:income-statement|profit-loss)\/?$/i);

  const norm=k=>String(k).toLowerCase().replace(/[^a-z0-9]/g,'');
  const numeric=v=>{
    if(typeof v==='number'&&Number.isFinite(v))return v;
    if(typeof v==='string'){
      const n=Number(v.replace(/[$,%\s,]/g,''));
      return Number.isFinite(n)?n:null;
    }
    return null;
  };
  const obj=(x)=>x&&typeof x==='object'&&!Array.isArray(x)?x:null;
  const get=(o,keys)=>{
    const n=obj(o); if(!n)return null;
    for(const k of keys){if(n[k]!==undefined&&n[k]!==null){const v=numeric(n[k]);if(v!==null)return v;}}
    return null;
  };

  // Exact current Sim Companies cash-flow fields. These are the most reliable
  // live financial figures available in the captured API response.
  const cfObj=obj(cf)||{};
  const recentObj=obj(recent)||{};
  const cashAllIncome=get(cfObj,['cashAllIncome']) ?? get(recentObj,['cashAllIncome','totalIncome']);
  const cashAllExpenses=get(cfObj,['cashAllExpenses']) ?? get(recentObj,['cashAllExpenses','totalExpenses']);
  const fromCustomers=get(cfObj,['fromCustomers'])||0;
  const fromExchange=get(cfObj,['fromExchange'])||0;
  const fromRetail=get(cfObj,['fromRetail'])||0;
  const fromRoyalties=get(cfObj,['fromRoyalties'])||0;
  const fromInterest=get(cfObj,['fromInterest'])||0;
  const fromGame=get(cfObj,['fromGame'])||0;
  const toEmployees=get(cfObj,['toEmployees'])||0;
  const toExchange=get(cfObj,['toExchange'])||0;
  const toSuppliers=get(cfObj,['toSuppliers'])||0;
  const toGame=get(cfObj,['toGame'])||0;
  const forFees=get(cfObj,['forFees'])||0;
  const forInterest=get(cfObj,['forInterest'])||0;

  let cash=get(bs,['cash']) ?? get(cfObj,['money','cash']) ?? get(recent,['money']);
  // Current company cash is authoritative in auth-data. The Accounting page can
  // omit the balance-sheet endpoint during a SPA navigation, so do not display
  // a dash when the live company record already contains the current cash.
  cash=cash ?? get(s.authData?.authCompany,['money','cash']);
  cash=cash ?? get(realmStore?.authData?.authCompany,['money','cash']);

  // In the current response the income-statement object is null. Therefore
  // use the cash-flow totals rather than accidentally grabbing an unrelated
  // "profit" field from a recent transaction (e.g. a single contract profit).
  // Some current Sim Companies responses expose only the recent transaction
  // ledger ({data:[{money,...}]}) rather than the aggregate cashAllIncome /
  // cashAllExpenses fields. All category-total fields are then absent, so derive the current captured
  // cash-flow totals from the transaction money values instead.
  const transactionRows=[];
  const transactionSeen=new Set();
  for(const source of [cfObj,recentObj]){
    const rows=Array.isArray(source?.data)?source.data:[];
    for(const row of rows){
      if(!row||typeof row!=='object')continue;
      const id=row.id!=null?String(row.id):JSON.stringify([row.datetime,row.description,row.money]);
      if(transactionSeen.has(id))continue;
      transactionSeen.add(id);
      const moneyValue=numeric(row.money);
      if(moneyValue!=null) transactionRows.push({...row,money:moneyValue});
    }
  }
  let revenue=cashAllIncome;
  if(revenue==null){
    const categoryTotal=fromCustomers+fromExchange+fromRetail+fromRoyalties+fromInterest+fromGame;
    revenue=categoryTotal>0?categoryTotal:null;
  }

  let expenses=cashAllExpenses!=null ? Math.abs(cashAllExpenses) : null;
  if(expenses==null){
    const categoryTotal=Math.abs(toEmployees+toExchange+toSuppliers+toGame+forFees+forInterest);
    expenses=categoryTotal>0?categoryTotal:null;
  }
  if(!Number.isFinite(expenses)) expenses=null;

  // Never sum the /cashflow/recent/ ledger as if it were the full accounting
  // period. If no aggregate statement is captured yet, show unavailable rather
  // than a plausible but incomplete revenue/profit number.
  let profit=null;
  if(revenue!=null && expenses!=null) profit=roundCurrencyUp(revenue-expenses);

  const transactionDates=transactionRows
    .map(x=>new Date(x.datetime))
    .filter(x=>Number.isFinite(x.getTime()))
    .sort((a,b)=>a-b);
  const transactionDateFrom=transactionDates[0]?.toISOString()||null;
  const transactionDateTo=transactionDates[transactionDates.length-1]?.toISOString()||null;

  const latestPastFinanceRow=(()=>{
    if(!Array.isArray(pf)) return obj(pf);
    const rows=pf.filter(x=>x&&typeof x==='object');
    rows.sort((a,b)=>{
      const ta=Date.parse(String(a?.date||a?.datetime||a?.periodEnd||''));
      const tb=Date.parse(String(b?.date||b?.datetime||b?.periodEnd||''));
      return (Number.isFinite(tb)?tb:0)-(Number.isFinite(ta)?ta:0);
    });
    return rows[0]||null;
  })();
  // Total assets / liabilities as the game's balance sheet computes them (GamePages).
  const gameBs=obj(bs)&&('cash' in bs||'buildings' in bs)&&typeof SCM_TOOLS_CORE!=='undefined'?SCM_TOOLS_CORE.gameFinancialStatements({},bs,{}):null;
  const gameTotal=(g,label)=>{const r=g?.balance?.find(x=>x.label===label);return r?r.value:null;};
  const assets=gameTotal(gameBs,'Total assets') ?? get(bs,['assets','totalAssets']) ?? pickNumericDeep(bs,['assets','totalAssets']) ?? get(latestPastFinanceRow,['assets','totalAssets','total']);
  const liabilities=(gameBs?get(bs,['bondsPayable']):null) ?? get(bs,['liabilities','totalLiabilities']) ?? pickNumericDeep(bs,['liabilities','totalLiabilities']) ?? get(latestPastFinanceRow,['liabilities','totalLiabilities','liabilities']);

  // The balance sheet exposes the inventory components explicitly.
  // Inventory = materials + work in process + finished goods.
  let inventory=null;
  if(obj(bs)){
    const materials=get(bs,['materials'])||0;
    const wip=get(bs,['workInProcess'])||0;
    const finished=get(bs,['finishedGoods'])||0;
    const valuationAllowance=get(bs,['valuationAllowance','valuation_allowance'])||0;
    const research=get(bs,['research'])||0;
    if(materials||wip||finished||valuationAllowance||('materials' in bs)||('workInProcess' in bs)||('finishedGoods' in bs)||('valuationAllowance' in bs)) inventory=materials+research+wip+finished+valuationAllowance;
  }
  if(inventory==null){
    const snapshotInventory=get(realmStore?.accountingSnapshots?.current,['inventory']) ?? get(s.accountingSnapshots?.current,['inventory']);
    if(snapshotInventory!=null) inventory=snapshotInventory;
  }
  if(inventory==null){
    inventory=(s.warehouseResources||[]).reduce((sum,r)=>{
      const c=r?.cost;
      if(c&&typeof c==='object')return sum+Object.values(c).reduce((a,v)=>a+(numeric(v)||0),0);
      const qty=numeric(r?.amount??r?.quantity??r?.qty??r?.units)||0;
      const unit=numeric(r?.unitCost??r?.costPerUnit??r?.averageCost)||0;
      return sum+qty*unit;
    },0);
    if(!inventory)inventory=null;
  }

  // Prefer the dedicated income-statement response, then the live cash-flow
  // totals. past-finances-overview can legitimately contain zero/summary
  // placeholders in R2, so it must not override valid current-period values.
  // Income Statement responses can be either object-shaped (sales/netIncome
  // fields) or row-shaped (for example {name:'Sales', value:1871019}).
  // Read both forms so the dashboard uses the game's actual statement rather
  // than falling back to a cash-flow total or an unrelated finance snapshot.
  const statementMetric=(root,labels,fieldKeys=['value','amount','total','money','result'])=>{
    const wanted=new Set(labels.map(x=>norm(x)));
    const seen=new Set();
    const walk=v=>{
      if(v==null||typeof v!=='object'||seen.has(v))return null;
      seen.add(v);
      if(Array.isArray(v)){
        for(const x of v){const r=walk(x);if(r!=null)return r;}
        return null;
      }
      const labelCandidates=[v.name,v.label,v.title,v.key,v.category,v.type,v.description,v.metric,v.code];
      const label=labelCandidates.find(x=>typeof x==='string'&&wanted.has(norm(x)));
      if(label){
        for(const k of fieldKeys){const n=numeric(v?.[k]);if(n!==null)return n;}
        const n=pickNumericDeep(v,fieldKeys);if(n!==null)return n;
      }
      for(const [k,x] of Object.entries(v)){
        if(wanted.has(norm(k))){
          const n=numeric(x);if(n!==null)return n;
          const nested=pickNumericDeep(x,fieldKeys);if(nested!==null)return nested;
        }
      }
      for(const x of Object.values(v)){const r=walk(x);if(r!=null)return r;}
      return null;
    };
    return walk(root);
  };
  const incomeProfit=income?(pickNumericDeep(income,['netIncome','netProfit','profit','netResult']) ?? statementMetric(income,['net income','net profit','profit','net result','operating profit'])):null;
  const incomeRevenue=income?(pickNumericDeep(income,['revenue','sales','totalRevenue','income']) ?? statementMetric(income,['sales','revenue','total revenue'])):null;
  const incomeMargin=income?(pickNumericDeep(income,['netMargin','netProfitMargin','netMarginPercentage','netProfitPercentage','netProfitPercent','netProfitMarginPct','netMarginPct','netProfitMarginPercentage']) ?? statementMetric(income,['net profit margin','net margin'])):null;
  const companyProfit=incomeProfit==null?pickNumericDeep(s.companyData,['netIncome','netProfit','profit','netResult']):null;
  const companyRevenue=incomeRevenue==null?pickNumericDeep(s.companyData,['revenue','sales','totalRevenue','income']):null;
  const finalProfit=incomeProfit!=null?incomeProfit:(profit!=null?profit:companyProfit);
  const finalRevenue=incomeRevenue!=null?incomeRevenue:(revenue!=null?revenue:companyRevenue);
  const finalMargin=incomeMargin!=null?(Math.abs(incomeMargin)<=1?incomeMargin*100:incomeMargin):(finalRevenue&&finalProfit!=null?finalProfit/finalRevenue*100:null);
  const accountsReceivable=get(bs,['accountsReceivable','receivables','accounts_receivable']);
  const accountsPayable=get(bs,['accountsPayable','payables','accounts_payable']);
  const bondsPayable=get(bs,['bondsPayable','bonds','bondLiabilities']);
  const currentAssetsParts=[cash,accountsReceivable,inventory].filter(v=>v!=null);
  const currentAssets=currentAssetsParts.length?currentAssetsParts.reduce((a,v)=>a+v,0):null;
  // The balance-sheet API has no accounts-payable field. Total liabilities
  // (game history) minus bonds payable (balance sheet) is the current-liability part.
  const derivedPayable=accountsPayable==null&&liabilities!=null&&bondsPayable!=null?Math.max(0,Math.abs(liabilities)-Math.abs(bondsPayable)):null;
  const payable=accountsPayable??derivedPayable;
  const currentLiabilities=payable==null?null:Math.abs(payable);
  // Statement period = the latest finished game day: the newer of the cash-flow and income statements' periods.
  const incomeObj=obj(income)||{};const stmtObj=Date.parse(String(incomeObj.date||''))>Date.parse(String(cfObj.date||''))?incomeObj:cfObj;
  const period={dateFrom:stmtObj.dateFrom||cfObj.dateFrom||transactionDateFrom,date:stmtObj.date||cfObj.date||transactionDateTo};
  // Every cash-flow ledger page captured (/cashflow/<id>/ and /cashflow/recent/). Summing
  // its money per game day reproduces the statement's cashAllIncome / cashAllExpenses exactly.
  const ledger=new Map();
  const addLedger=v=>{const rows=Array.isArray(v?.data)?v.data:(Array.isArray(v)?v:[]);for(const r of rows){const t=Date.parse(String(r?.datetime||''));const m=numeric(r?.money);if(r?.id!=null&&Number.isFinite(t)&&m!=null)ledger.set(String(r.id),[t,m,String(r?.category||'')]);}};
  for(const k of eps)if(/\/api\/v2\/companies\/(?:me|\d+)\/cashflow\/(?:\d+|recent)\/?$/i.test(k)&&Number(endpointData[k]?.status)===200&&realmMatches(endpointData[k]))addLedger(endpointData[k]?.data);
  for(const [k,item] of Object.entries(supplemental))if(/\/cashflow\/(?:\d+|recent)\/?$/i.test(k)&&realmMatches(item))addLedger(item?.data);
  // Prove the ledger is complete before trusting it for earlier days: its sums for the
  // current statement period must equal the statement's own Sales and expenses.
  const ledgerCheck=(()=>{
    const a0=Date.parse(String(cfObj.dateFrom||'')),b0=Date.parse(String(cfObj.date||''));
    if(!Number.isFinite(a0)||!Number.isFinite(b0)||!ledger.size)return {sales:false,expenses:false};
    let sales=0,exp=0;for(const [t,m,c] of ledger.values()){if(t>=a0&&t<b0){if(m>0&&(c==='m'||c==='t'||c==='r'))sales+=m;else if(m<0)exp+=-m;}}
    const stSales=fromCustomers+fromExchange+fromRetail,stExp=cashAllExpenses==null?null:Math.abs(cashAllExpenses);
    return {sales:Math.abs(sales-stSales)<=1,expenses:stExp!=null&&Math.abs(exp-stExp)<=1,ledgerSales:sales,ledgerExpenses:exp,statementSales:stSales,statementExpenses:stExp};
  })();
  const history=accountingDailyHistory(
    latest(/\/api\/v2\/companies\/(?:me|\d+)\/past-finances-overview\/?$/i)??latestSupplemental('/api/v2/companies/me/past-finances-overview/'),
    latest(/\/api\/v3\/companies\/(?:me|\d+)\/past-finances\/?$/i)??latestSupplemental('/api/v3/companies/me/past-finances/'),[...ledger.values()],ledgerCheck);
  // The game's own per-day income statements (/income-statement/day/<n>/, captured when
  // the game's Accounting page shows a Day period) give each completed day's exact Sales,
  // Operating expenses and Net income. Matched to history rows by the statement's end date.
  const dayIncome=accountingDayStatements(endpointData,realmMatches);
  const dayCash=accountingDayCashflows(endpointData,realmMatches);
  // The current (latest finished day) statements are that day's figures even before the walk reads day/0.
  const dayMinute=e=>{const t=Date.parse(String(e?.date||'').replace(' ','T'));return Number.isFinite(t)?Math.round(t/60000):null;};
  if(obj(income)?.isComputed===true&&dayMinute(income)!=null&&!dayIncome.has(dayMinute(income)))dayIncome.set(dayMinute(income),accountingStatementDay(income));
  if(cfObj.isComputed===true&&dayMinute(cfObj)!=null&&!dayCash.has(dayMinute(cfObj)))dayCash.set(dayMinute(cfObj),accountingCashChange(cfObj));
  for(const r of history){const m=Math.round(r.t/60000);const st=dayIncome.get(m);if(st){r.sales=st.sales;r.cogs=st.cogs;r.freightOut=st.freightOut;r.marketFees=st.marketFees;r.executives=st.executives;r.operatingExpenses=st.operatingExpenses;r.netIncome=st.netIncome;r.statement=true;}const cc=dayCash.get(m);if(cc!=null)r.cashChange=cc;}
  // Current Liabilities per completed day = the Day balance sheet's accounts payable, or (as for the
  // card) that day's total liabilities minus its bonds payable. Matched to history rows by the sheet's date.
  const daySheets=accountingDayBalanceSheets(endpointData,realmMatches);
  for(const r of history){const bsd=daySheets.get(Math.round(r.t/60000));if(!bsd)continue;const cl=bsd.accountsPayable!=null?Math.abs(bsd.accountsPayable):(r.liabilities!=null&&bsd.bondsPayable!=null?Math.max(0,Math.abs(r.liabilities)-Math.abs(bsd.bondsPayable)):null);if(cl!=null)r.currentLiabilities=cl;}
  const operatingExpenses=gameOperatingExpenses(income);
  const statementNow=obj(income)&&'sales' in income?accountingStatementDay(income):null;
  const previousPeriod=accountingPreviousPeriod(history,period.date);
  return {cash,revenue:finalRevenue,expenses,operatingExpenses,cogs:statementNow?.cogs??null,freightOut:statementNow?.freightOut??null,marketFees:statementNow?.marketFees??null,executives:statementNow?.executives??null,cashChange:accountingCashChange(cfObj),profit:finalProfit,netMargin:finalMargin,assets,liabilities,inventory,accountsReceivable,accountsPayable:payable,bondsPayable,currentAssets,currentLiabilities,period,history,previousPeriod,ledgerCheck,source:{bs,cf,recent,pf,income},sourceType: income ? 'income-statement' : (cf ? (transactionRows.length?'cash-flow-transactions':'cash-flow-derived') : 'unavailable')};
}
// Product images: when every URL candidate has failed, ask the game tab for the image (GET_RESOURCE_IMAGE) and use the
// returned dataUrl. The box is kept (visibility:hidden, never display:none) so the row does not shift. Per page session
// each resource id is asked once: __scmImgState remembers pending / failed / ok, and re-renders go through scmImgSrcs so
// a known-bad id never creates another failing <img>.
const __scmImgState=new Map();
function scmImgSrcs(rid,srcs){const m=__scmImgState.get(Number(rid));const list=(Array.isArray(srcs)?srcs:[]).filter(u=>scmSafeImgSrc(u));if(!m)return list;if(m.s==='ok'&&scmSafeImgSrc(m.url))return [m.url,...list.filter(u=>u!==m.url)];return list.filter(u=>u.startsWith('data:'));}
scmOnDashboardResume(()=>{for(const [k,v] of [...__scmImgState])if(v.s!=='ok')__scmImgState.delete(k);});
function scmResourceImageFallback(rid,img){
  const m=__scmImgState.get(rid);
  if(m?.s==='ok'&&m.url){if(img.dataset.scmData==='1'){__scmImgState.set(rid,{s:'failed',t:Date.now()});return;}img.dataset.scmData='1';img.src=scmSafeImgSrc(m.url);img.style.visibility='';return;}
  if(m)return;
  __scmImgState.set(rid,{s:'pending',t:Date.now()});
  let p;try{p=chrome.runtime.sendMessage({type:'GET_RESOURCE_IMAGE',resource:rid});}catch{p=null;}
  Promise.resolve(p).then(r=>{
    if(r&&r.ok&&r.dataUrl){__scmImgState.set(rid,{s:'ok',url:r.dataUrl,t:Date.now()});document.querySelectorAll(`img[data-rid="${rid}"]`).forEach(el=>{el.dataset.scmData='1';el.style.visibility='';el.src=scmSafeImgSrc(r.dataUrl);});}
    else if(!(r&&r.queued))__scmImgState.set(rid,{s:'failed',t:Date.now()});
  }).catch(()=>__scmImgState.set(rid,{s:'failed',t:Date.now()}));
}
window.scmImageFallback=function(img){try{const c=JSON.parse(img.dataset.candidates||'[]');let i=Number(img.dataset.idx||0)+1;while(i<c.length&&!c[i])i++;if(i<c.length){img.dataset.idx=String(i);img.src=scmSafeImgSrc(c[i]);return;}img.style.visibility='hidden';const rid=Number(img.dataset.rid);if(rid>0)scmResourceImageFallback(rid,img);}catch{img.style.visibility='hidden';}};
function snapshotRealmKey(s){const r=s.viewRealm!=null?Number(s.viewRealm):(s.captureRealm!=null?Number(s.captureRealm):null);return r!=null?`realm:${r}`:'auto';}
function accountingSnapshotValues(a){return {cash:a.cash,revenue:a.revenue,expenses:a.expenses,profit:a.profit,assets:a.assets,liabilities:a.liabilities,inventory:a.inventory};}
function topSellingResourcesByProfit(accounting,s){
  const summary=s?.accountingWeekSalesSummary&&typeof s.accountingWeekSalesSummary==='object'?s.accountingWeekSalesSummary:null;
  const ledgerStatus=String(s?.accountingWeekLedgerStatus?.status||'');
  const ledger=s?.accountingWeekSales&&typeof s.accountingWeekSales==='object'?s.accountingWeekSales:{};
  const summaryUpdated=Date.parse(String(summary?.updatedAt||''));
  const statusUpdated=Date.parse(String(s?.accountingWeekLedgerStatus?.updatedAt||''));
  const summaryFreshEnough=Number.isFinite(summaryUpdated)&&(!Number.isFinite(statusUpdated)||summaryUpdated>=statusUpdated);
  const usableSummary=summary&&Array.isArray(summary.netProfit)&&Number(summary.transactionCount)>0&&(
    (ledgerStatus==='complete'&&s?.accountingWeekLedgerStatus?.coverageComplete===true) ||
    (Object.keys(ledger).length>0&&summaryFreshEnough&&ledgerStatus!=='running')
  );
  // A transient refresh failure must not hide a newer durable summary.
  if(usableSummary){
    const items=summary.netProfit.map((x,i)=>{
      const info=resourceInfo({kind:Number(x.resourceId)},s);const images=info.imageCandidates||[];const image=images[0]||'';
      if(!image)requestResourceImage(Number(x.resourceId));
      return {...x,rank:i+1,name:info.name,image,images};
    });
    return {items,rangeStart:summary.rangeStart??null,rangeEnd:summary.rangeEnd??null};
  }
  const ledgerKnown=ledgerStatus||s?.lastSync||s?.fullSyncDiagnostics;
  if(ledgerKnown && ledgerStatus==='running')return {items:[],rangeStart:null,rangeEnd:null,loading:true};
  const canonical=Array.isArray(s?.accountingWeekSales)?s.accountingWeekSales:(s?.accountingWeekSales&&typeof s.accountingWeekSales==='object'?Object.values(s.accountingWeekSales):[]);
  const history=s?.sellingHistory&&typeof s.sellingHistory==='object'?Object.values(s.sellingHistory):[];
  const fallback=Array.isArray(accounting?.source?.recent?.data)?accounting.source.recent.data:[];
  const sourceRows=canonical.length?canonical:(history.length?history:fallback);
  const groups=new Map(),seen=new Set();
  for(const x of sourceRows){
    const rid=Number(x?.resourceId??x?.details?.resource??x?.details?.resourceId); const amount=Number(x?.amount??x?.details?.amount); const profit=Number(x?.profit??x?.details?.profit);
    const id=String(x?.id??`${x?.datetime||''}|${rid}|${amount}|${profit}`);
    if(!Number.isFinite(rid)||rid<=0||!Number.isFinite(amount)||amount<=0||!Number.isFinite(profit)||profit<=0||seen.has(id))continue;
    seen.add(id); const g=groups.get(String(rid))||{resourceId:rid,amount:0,profit:0};g.amount+=amount;g.profit+=profit;groups.set(String(rid),g);
  }
  const dated=sourceRows.map(x=>Date.parse(String(x?.datetime||''))).filter(Number.isFinite);
  const rangeStart=dated.length?Math.min(...dated):null, rangeEnd=dated.length?Math.max(...dated):null;
  const items=[...groups.values()].sort((a,b)=>b.profit-a.profit||b.amount-a.amount).slice(0,10).map((x,i)=>{const info=resourceInfo({kind:x.resourceId},s);const images=info.imageCandidates||[];const image=images[0]||'';if(!image)requestResourceImage(x.resourceId);return {...x,rank:i+1,name:info.name,image,images};});
  return {items,rangeStart,rangeEnd};
}
function topGrossResources(a,s){
  const summary=s?.accountingWeekSalesSummary&&typeof s.accountingWeekSalesSummary==='object'?s.accountingWeekSalesSummary:null;
  const ledgerStatus=String(s?.accountingWeekLedgerStatus?.status||'');
  const ledger=s?.accountingWeekSales&&typeof s.accountingWeekSales==='object'?s.accountingWeekSales:{};
  const summaryUpdated=Date.parse(String(summary?.updatedAt||''));
  const statusUpdated=Date.parse(String(s?.accountingWeekLedgerStatus?.updatedAt||''));
  const summaryFreshEnough=Number.isFinite(summaryUpdated)&&(!Number.isFinite(statusUpdated)||summaryUpdated>=statusUpdated);
  const usableSummary=summary&&Array.isArray(summary.gross)&&Number(summary.transactionCount)>0&&(
    (ledgerStatus==='complete'&&s?.accountingWeekLedgerStatus?.coverageComplete===true) ||
    (Object.keys(ledger).length>0&&summaryFreshEnough&&ledgerStatus!=='running')
  );
  if(usableSummary){
    // Gross is independent of net profit. The weekly ledger retains sale rows
    // even when a sale has zero/negative profit, so those resources remain
    // eligible for the Gross Top 10.
    const items=summary.gross.map((x,i)=>{
      const info=resourceInfo({kind:Number(x.resourceId)},s);const images=info.imageCandidates||[];const image=images[0]||'';
      if(!image)requestResourceImage(Number(x.resourceId));
      return {...x,rank:i+1,name:info.name,image,images};
    });
    return {items,rangeStart:summary.rangeStart??null,rangeEnd:summary.rangeEnd??null};
  }
  const ledgerKnown=ledgerStatus||s?.lastSync||s?.fullSyncDiagnostics;
  if(ledgerKnown && ledgerStatus==='running')return {items:[],rangeStart:null,rangeEnd:null,loading:true};
  const canonical=Array.isArray(s?.accountingWeekSales)?s.accountingWeekSales:(s?.accountingWeekSales&&typeof s.accountingWeekSales==='object'?Object.values(s.accountingWeekSales):[]);
  if(canonical.length){
    const groups=new Map();
    for(const x of canonical){
      const rid=Number(x?.resourceId),qty=Number(x?.amount),gross=Number(x?.gross),profit=Number(x?.profit);
      if(!Number.isFinite(rid)||rid<=0||!Number.isFinite(qty)||qty<=0||!Number.isFinite(gross)||gross<=0||!Number.isFinite(profit))continue;
      const g=groups.get(String(rid))||{resourceId:rid,gross:0,amount:0};g.gross+=gross;g.amount+=qty;groups.set(String(rid),g);
    }
    const items=[...groups.values()].sort((a,b)=>b.gross-a.gross||b.amount-a.amount).slice(0,10).map((x,i)=>{const info=resourceInfo({kind:x.resourceId},s);const images=info.imageCandidates||[];const image=images[0]||'';if(!image)requestResourceImage(x.resourceId);return {...x,rank:i+1,name:info.name,image,images};});
    const dated=canonical.map(x=>Date.parse(String(x?.datetime||''))).filter(Number.isFinite);
    return {items,rangeStart:dated.length?Math.min(...dated):null,rangeEnd:dated.length?Math.max(...dated):null};
  }
  const groups=new Map(); const rows=accountingTransactionRows(a);
  for(const x of rows){
    const rid=Number(x.resourceId); if(!Number.isFinite(rid)||rid<=0)continue;
    const details=x.details||{}, raw=x.row||{};
    const profit=Number(x.profit), money=Number(x.money);
    if(!Number.isFinite(money)||money<=0||!Number.isFinite(profit))continue;
    const saleCategory=String(raw.category||'').toLowerCase()==='m';
    const saleContract=String(raw.descriptionKey||'').toLowerCase().startsWith('cs-');
    if(!saleCategory&&!saleContract)continue;
    const candidates=[details.gross,details.revenue,details.sales,details.total,details.proceeds,raw.gross,raw.revenue,raw.sales,raw.total,raw.proceeds];
    let gross=candidates.map(numericValue).find(v=>Number.isFinite(v)&&v>0);
    const qty=Number(x.quantity),price=Number(x.price);
    if(gross==null&&Number.isFinite(qty)&&qty>0&&Number.isFinite(price)&&price>0)gross=roundCurrencyUp(qty*price);
    if(gross==null)gross=money;
    if(!Number.isFinite(gross)||gross<=0)continue;
    const g=groups.get(String(rid))||{resourceId:rid,gross:0,amount:0};g.gross+=gross;if(Number.isFinite(qty)&&qty>0)g.amount+=qty;groups.set(String(rid),g);
  }
  const items=[...groups.values()].sort((a,b)=>b.gross-a.gross||b.amount-a.amount).slice(0,10).map((x,i)=>{const info=resourceInfo({kind:x.resourceId},s);const images=info.imageCandidates||[];const image=images[0]||'';if(!image)requestResourceImage(x.resourceId);return {...x,rank:i+1,name:info.name,image,images};});
  const dated=rows.filter(x=>Number.isFinite(x.datetime)&&Number.isFinite(x.money)&&x.money>0&&Number.isFinite(x.profit)).map(x=>x.datetime);return {items,rangeStart:dated.length?Math.min(...dated):null,rangeEnd:dated.length?Math.max(...dated):null};
}
function snapshotSignature(o){return JSON.stringify(o,Object.keys(o).sort());}
function scmAccountingSignature(store){
  const ep=store?.endpointData&&typeof store.endpointData==='object'?store.endpointData:{};
  const rx=/\/api\/(?:v2|v3)\/companies\/(?:me|\d+)\/(?:balance-sheet|cashflow(?:\/recent)?|cashflow-statement|income-statement|past-finances-overview|administration-overhead|past-finances)(?:\/\d+)?\/?$/i;
  const summarizeData=data=>{
    if(Array.isArray(data)){
      const first=data[0],last=data[data.length-1];
      const marker=row=>row&&typeof row==='object'?{id:row.id??null,datetime:row.datetime??null,money:row.money??null,description:row.description??null}:null;
      return {shape:'array',length:data.length,first:marker(first),last:marker(last)};
    }
    if(data&&typeof data==='object'){
      // Accounting endpoints are small summary objects in the live workflow.
      // Include their primitive fields so a value change with the same date
      // still triggers the Accounting tab to refresh. Ignore nested arrays/
      // objects because they can contain large transaction payloads.
      const primitive=Object.entries(data)
        .filter(([,v])=>v==null||['string','number','boolean'].includes(typeof v))
        .sort(([a],[b])=>a.localeCompare(b));
      return {shape:'object',primitive,isComputed:data.isComputed??null,date:data.date??null,dateFrom:data.dateFrom??null};
    }
    return {shape:typeof data};
  };
  const entries=Object.entries(ep)
    .filter(([url])=>rx.test(String(url||'')))
    .map(([url,v])=>({url,status:v?.status??null,receivedAt:v?.receivedAt??null,data:summarizeData(v?.data)}))
    .sort((a,b)=>a.url.localeCompare(b.url));
  const supplemental=store?.accountingCapture&&typeof store.accountingCapture==='object'?store.accountingCapture:{};
  const supplementalSig=Object.entries(supplemental)
    .map(([url,v])=>({url,captureRealm:v?.captureRealm??null,receivedAt:v?.receivedAt??null,data:summarizeData(v?.data)}))
    .sort((a,b)=>a.url.localeCompare(b.url));
  const summarizeComputed=x=>x&&typeof x==='object'?{captureRealm:x.captureRealm??null,receivedAt:x.receivedAt??null,isComputed:x.data?.isComputed??null,date:x.data?.date??null,dateFrom:x.data?.dateFrom??null}:{value:x??null};
  const weekSummary=store?.accountingWeekSalesSummary&&typeof store.accountingWeekSalesSummary==='object'?{rangeStart:store.accountingWeekSalesSummary.rangeStart??null,rangeEnd:store.accountingWeekSalesSummary.rangeEnd??null,transactionCount:store.accountingWeekSalesSummary.transactionCount??0,updatedAt:store.accountingWeekSalesSummary.updatedAt??null}:{};
  const weekStatus=store?.accountingWeekLedgerStatus&&typeof store.accountingWeekLedgerStatus==='object'?{status:store.accountingWeekLedgerStatus.status??null,updatedAt:store.accountingWeekLedgerStatus.updatedAt??null,completedAt:store.accountingWeekLedgerStatus.completedAt??null,rows:store.accountingWeekLedgerStatus.rows??null,pages:store.accountingWeekLedgerStatus.pages??null}:{};
  // The day-walk status drives the Last 7 days note; without it a walk finishing after the tab rendered never showed.
  const dw=store?.accountingDayWalkStatus&&typeof store.accountingDayWalkStatus==='object'?store.accountingDayWalkStatus:null;
  const dayWalk=dw?{status:dw.status??null,updatedAt:dw.updatedAt??null,finishedAt:dw.finishedAt??null,captured:dw.captured??null}:{};
  return JSON.stringify({entries,supplemental:supplementalSig,lastComputed:summarizeComputed(store?.accountingLastComputed),lastComputedIncome:summarizeComputed(store?.accountingLastComputedIncome),accountingWeekRevision:Number(store?.accountingWeekRevision)||0,weekSummary,weekStatus,dayWalk});
}
function realmSnapshotStore(s){
  const key=snapshotRealmKey(s);
  if(!key||key==='auto') return null;
  const stores={...(s.realmStores||{})};
  const store={...(stores[key]||{})};
  return {key,stores,store};
}
async function persistAccountingSnapshotRealm(realmKey,snapshot){
  if(!realmKey)return;
  try{
    await chrome.runtime.sendMessage({type:'SAVE_REALM_FIELD',realmKey,field:'accountingSnapshots',value:snapshot});
  }catch{}
}
function updateAccountingSnapshot(s,a){
  const realm=realmSnapshotStore(s);
  const current=accountingSnapshotValues(a);
  if(!realm) return {previous:null,current};
  const old=realm.store.accountingSnapshots||null;
  const sig=snapshotSignature(current);
  const sameRealm=old?.baselineVersion===1 && Number(old?.realm)===Number(s.viewRealm);
  // Snapshots without baselineSchemaVersion 2 can hold a stale pre-realm comparison (notably R1's
  // $2.28M cash baseline) and are treated as invalid; the captured current values are kept for diagnostics/history.
  const baselineSchemaVersion=Number(old?.baselineSchemaVersion)||0;
  const validBaseline=sameRealm && baselineSchemaVersion===2;
  const aggregateUncomputed=a?.source?.cf?.isComputed===false || a?.source?.income?.isComputed===false;
  const rolloverPlaceholder=aggregateUncomputed && Number(a?.revenue)===0 && Number(a?.profit)===0;
  // At the daily rollover Sim Companies briefly exposes an uncomputed zero
  // aggregate. Never replace the last completed dashboard baseline with that
  // placeholder, or the next render will lose the prior period's comparison.
  if(validBaseline && rolloverPlaceholder && old?.current && (
    Number.isFinite(Number(old.current.revenue)) && Number(old.current.revenue)!==0 ||
    Number.isFinite(Number(old.current.profit)) && Number(old.current.profit)!==0
  )){
    s.accountingSnapshots=old;
    return old;
  }
  let snap=old;
  if(!validBaseline||old.signature!==sig){
    snap={previous:validBaseline?old?.current||null:null,current,signature:sig,realm:Number(s.viewRealm),baselineVersion:1,baselineSchemaVersion:2,period:a.period||null,updatedAt:new Date().toISOString()};
    if(old&&!validBaseline) snap.legacyPrevious=old;
    realm.store.accountingSnapshots=snap;
    realm.stores[realm.key]=realm.store;
    s.accountingSnapshots=snap;
    // Render-time state can be older than a concurrent background capture.
    // Persist only this field against the latest realm store so navigation
    // cannot overwrite endpointData/warehouse captures.
    persistAccountingSnapshotRealm(realm.key,snap).catch(()=>{});
  } else s.accountingSnapshots=old;
  return snap||{previous:null,current};
}
// The game marks construction and upgrades with busy.category "b" (EXPANDING; "r" is producing).
function buildingIsExpanding(b){return String(b?.busy?.category||'')==='b'||Boolean(b?.busy?.expanding);}
function buildingExpandFinish(b){const st=Date.parse(String(b?.busy?.started||'')),d=Number(b?.busy?.duration);return Number.isFinite(st)&&d>0?st+d*1000:null;}
function buildingArrayFromState(s){
  const candidates=[];
  // Prefer the raw buildings API response. The game's localStorage bridge strips
  // busy/production fields, so using it first makes quantity/time disappear.
  const ep=s.endpointData||{};
  const viewRealm=Number(s.viewRealm);
  const paths=Object.keys(ep).filter(k=>{
    if(!/\/api\/v2\/companies\/(?:me|\d+)\/buildings\/?(?:\d+)?$/i.test(k)) return false;
    const item=ep[k];
    if(Number(item?.status)!==200||item?.data==null) return false;
    const capturedRealm=Number(item?.captureRealm);
    return !Number.isFinite(viewRealm)||!Number.isFinite(capturedRealm)||capturedRealm===viewRealm;
  }).sort((a,b)=>new Date(ep[b]?.receivedAt||0)-new Date(ep[a]?.receivedAt||0));
  const extract=v=>{if(Array.isArray(v))return v;if(!v||typeof v!=='object')return [];for(const k of ['buildings','data','items','results'])if(Array.isArray(v[k]))return v[k];return [];};
  for(const path of paths){const arr=extract(ep[path]?.data);if(arr.length){candidates.push(...arr);break;}}
  if(Array.isArray(s.buildings)) candidates.push(...s.buildings);
  const region=s.gameState?.region;
  if(Array.isArray(region?.buildings)) candidates.push(...region.buildings);
  // De-duplicate the full building records by id.
  const out=[]; const seen=new Set();
  for(const b of candidates){
    if(!b||typeof b!=='object') continue;
    const id=pick(b,['id','buildingId']);
    const key=id!=null?String(id):JSON.stringify({kind:b.kind,position:b.position,size:b.size});
    if(seen.has(key)) continue; seen.add(key); out.push(b);
  }
  return out;
}
function activeProductionCostEntries(s){
  const out=[];
  for(const b of buildingArrayFromState(s||{})){
    const r=b?.busy?.resource;
    const id=Number(r?.kind),quality=Number(r?.quality),unitCost=Number(r?.unitCost);
    if(!Number.isFinite(id)||id<=0||!Number.isFinite(quality)||!Number.isFinite(unitCost)||unitCost<0)continue;
    out.push({key:`${id}:${quality}`,id,quality,unitCost,name:String(r?.name||resourceName({kind:id},s||{})),building:buildingName(b,s||{})});
  }
  return out;
}
function activeProductionCostCells(s,r){
  const entries=activeProductionCostEntries(s).filter(x=>x.id===Number(r?._id)&&x.quality===Number(r?._quality));
  if(!entries.length)return {costHtml:'—',diffHtml:'—'};
  const warehouse=Number(r?._unitCost);const hasWarehouse=r?._unitCost!=null&&Number.isFinite(warehouse)&&warehouse>=0;
  const line=(x)=>{
    const diff=hasWarehouse?x.unitCost-warehouse:null;
    const cls=diff==null?'':diff>1e-9?'negative':diff< -1e-9?'positive':'neutral';
    const label=escapeHtml(x.building);
    const diffLabel=diff==null?'—':diff>1e-9?`+${money(Math.abs(diff))}`:diff< -1e-9?`−${money(Math.abs(diff))}`:money(0);
    return {cost:`<span class="active-cost-line"><strong>${money(x.unitCost)}</strong><small>${label}</small></span>`,diff:`<span class="active-cost-line ${cls}"><strong>${diffLabel}</strong><small>${label}</small></span>`};
  };
  // Buildings running at the same cost are shown once ("$30.46 · 7 Mills")
  // so a card never grows sideways with one column per building.
  const groups=new Map();
  for(const x of entries){const k=money(x.unitCost);const g=groups.get(k)||{...x,names:[]};g.names.push(String(x.building||''));groups.set(k,g);}
  const lines=[...groups.values()].map(g=>{
    const kind=g.names.length>1?String(g.names[0]).replace(/\s*#\d+.*$/,'').trim():'';
    const label=g.names.length>1?`${g.names.length} ${kind?kind+(/s$/i.test(kind)?'':'s'):'buildings'}`:g.names[0];
    const l=line({...g,building:label});
    const title=escapeHtml(g.names.join(', '));
    return {cost:l.cost.replace('<span class="active-cost-line"',`<span title="${title}" class="active-cost-line"`),diff:l.diff.replace('<span class="active-cost-line',`<span title="${title}" class="active-cost-line`)};
  });
  return {costHtml:`<span class="active-cost-list">${lines.map(x=>x.cost).join('')}</span>`,diffHtml:`<span class="active-cost-list">${lines.map(x=>x.diff).join('')}</span>`};
}
const BUILDING_KIND_NAMES={a:'Farm',b:'Ranch',c:'Bakery',d:'Beverage Factory',e:'Catering',f:'Food Processing Plant',g:'Mill',h:'Slaughterhouse',i:'Concrete Plant',j:'Construction Factory',k:'General Contractor',l:'Quarry',m:'Fashion Factory',n:'Bank',o:'Oil Rig',p:'Power Plant',q:'Refinery',r:'Aerospace Electronics',s:'Electronics Factory',t:'Car Factory',u:'Propulsion Factory',v:'Aerospace Factory',w:'Hangar',x:'Factory',y:'Academy',z:'Water Reservoir'};
function buildingName(b,s){const raw=pick(b,['name','buildingName','displayName','title','typeName']);if(typeof raw==='string'&&raw.trim())return raw.trim();const k=String(pick(b,['kind','buildingKind','type'])??'');return BUILDING_KIND_NAMES[k]||`Building ${k||'—'}`;}
function buildingLevel(b){const n=Number(pick(b,['level','lvl','buildingLevel','size']));return Number.isFinite(n)?n:'—';}
function findNestedObject(root, keys, maxDepth=5){
  const wanted=new Set(keys.map(String)); const seen=new Set();
  const walk=(v,d)=>{
    if(!v||typeof v!=='object'||seen.has(v)||d>maxDepth)return null; seen.add(v);
    if(!Array.isArray(v)){
      for(const k of Object.keys(v)) if(wanted.has(k)&&v[k]!=null) return v;
      for(const x of Object.values(v)){const r=walk(x,d+1);if(r)return r;}
    } else for(const x of v){const r=walk(x,d+1);if(r)return r;}
    return null;
  };
  return walk(root,0);
}
function busyObject(b){
  if(b?.busy&&typeof b.busy==='object') return b.busy;
  const x=findNestedObject(b,['busy','production','productionState','currentProduction','runningProduction']);
  return x||null;
}
const REALM_DEFINITIONS={0:{display:'R1',name:'Magnates'},1:{display:'R2',name:'Entrepreneurs'}};
function realmName(realm){return REALM_DEFINITIONS[Number(realm)]?`${REALM_DEFINITIONS[Number(realm)].display} - ${REALM_DEFINITIONS[Number(realm)].name}`:`Realm ${realm}`;}
function realmDisplayNumber(realm){return REALM_DEFINITIONS[Number(realm)]?.display||`R${realm}`;}
let __realmSelectionPromise=Promise.resolve();
let __realmSelectionPending=null;
async function setViewRealm(realm){
  const n=realm===''?null:Number(realm);
  if(n!==null&&(!Number.isFinite(n)||![0,1].includes(n))) return;
  // Persist the user's explicit choice immediately. Do not let a background
  // render or an unrelated game-realm event replace the selection.
  __realmSelectionPending=n;
  const el=$('#realmSelect'); if(el) el.value=n==null?'':String(n);
  __realmSelectionPromise=(async()=>{
  try{
    const r=await chrome.runtime.sendMessage({type:'SET_VIEW_REALM',realm:n});
    if(!r?.ok) return;
    const s=await get();
    render(s);
  }catch(e){
    console.error('Unable to set realm',e);
  } finally {
    if(__realmSelectionPending===n) __realmSelectionPending=null;
  }
  })();
  await __realmSelectionPromise;
}
function updateRealmSwitcher(s){
  const el=$('#realmSelect'); if(!el)return;
  // The dropdown represents the user's explicit sync/view selection. Never
  // substitute the detected game realm when the user has not selected one.
  const view=__realmSelectionPending!=null?__realmSelectionPending:(s.selectedRealm!=null?Number(s.selectedRealm):null);
  if(document.activeElement!==el || __realmSelectionPending==null) el.value=view==null?'':String(view);
  const status=$('#realmViewStatus');
  const capture=s.captureRealm;
  if(status){
    status.textContent=capture==null?'No game realm detected':capture===view?'Live game realm':view==null?'Viewing saved data':`R${Number(view)+1} selected. Showing R${Number(capture)+1} until the game switches`;
    status.className=`realm-view-status ${capture===view?'live':'saved'}`;
  }
}
$('#realmSelect')?.addEventListener('change',e=>setViewRealm(e.target.value));

let __liveMarketTimer=null;
let __liveMarketBusy=false;
const __liveMarketProductPending=new Set();
const __liveMarketProductLastRequestedAt=new Map();
let __selectedMarketKey='';
function marketRealmFromState(s){return validRealmNumber(s?.viewRealm!=null?s.viewRealm:(s?.selectedRealm!=null?s.selectedRealm:s?.captureRealm));}
function requestLiveMarketRefresh(realm,force=false){
  if(__liveMarketBusy&&!force)return;
  const n=validRealmNumber(realm); if(n==null)return;
  __liveMarketBusy=true;
  return chrome.runtime.sendMessage({type:'LIVE_MARKET_REFRESH',realm:n}).catch(()=>null).finally(()=>{__liveMarketBusy=false;});
}
async function requestLiveMarketProduct(realm,resourceId,quality,force=false){
  const n=validRealmNumber(realm),id=Number(resourceId),q=Number(quality);
  if(n==null||!Number.isFinite(id)||id<=0||!Number.isFinite(q)||q<0)return;
  const requestEpoch=__realmViewEpoch;
  const requestKey=`${n}:${id}:${q}`;
  // Deduplicate only the same product. Requests for different resources may
  // overlap safely because the background now caches by resource+quality.
  if(__liveMarketProductPending.has(requestKey))return;
  const now=Date.now(),lastRequest=__liveMarketProductLastRequestedAt.get(requestKey)||0;
  if(!force&&lastRequest&&now-lastRequest<45000)return;
  __liveMarketProductPending.add(requestKey);
  __liveMarketProductLastRequestedAt.set(requestKey,now);
  try{
    const result=await chrome.runtime.sendMessage({type:'LIVE_MARKET_PRODUCT',realm:n,resourceId:id,quality:q});
    if(requestEpoch!==__realmViewEpoch)return;
    const fresh=await get();
    if(requestEpoch!==__realmViewEpoch)return;
    if(marketRealmFromState(fresh)!==n)return;
    const productKey=`${id}:${q}`;
    const store=fresh?.realmStores?.[`realm:${n}`]||fresh;
    const cached=store?.liveMarketProductCache?.[productKey];
    const pointer=store?.liveMarketProduct;
    const pointerMatches=Number(pointer?.resourceId)===id&&Number(pointer?.quality)===q;
    if(cached||pointerMatches||result?.ok===false){
      commitDashboardState(fresh);
      renderLiveMarketProduct(fresh);
    }else{
      // Even if another product finished last and owns the legacy pointer,
      // re-render from the keyed cache/price rows rather than leaving the view stale.
      commitDashboardState(fresh);
      renderLiveMarketProduct(fresh);
    }
  }catch(e){
    console.debug('Live market product request failed',e);
    try{const fresh=await get();if(requestEpoch===__realmViewEpoch&&marketRealmFromState(fresh)===n){commitDashboardState(fresh);renderLiveMarketProduct(fresh);}}catch{}
  }finally{
    __liveMarketProductPending.delete(requestKey);
  }
}
// Game order book (/api/v3/market/<realm>/<id>/) read through the game tab: stored receivedAt for one product, newest of the
// root state and the realm store, only entries captured for this realm.
function marketBookStamp(s,realm,id){
  let best=0;const paths=[`/api/v3/market/${realm}/${id}/`,`/api/v3/market/${realm}/${id}`];
  for(const st of [s,s?.realmStores?.[`realm:${realm}`]]){
    for(const p of paths){const e=st?.endpointData?.[p];if(!e||(e.captureRealm!=null&&Number(e.captureRealm)!==Number(realm)))continue;const t=Date.parse(String(e.receivedAt||''));if(Number.isFinite(t)&&t>best)best=t;}
  }
  return best||null;
}
function marketClock(v){const d=new Date(v);return Number.isFinite(d.getTime())?d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false}):'';}
// Newest of the game order book and the SimcoTools fetch, with the name of the source.
function marketNewestStamp(bookAt,toolsAt,bookSource='Game market'){
  const t=toolsAt?Date.parse(String(toolsAt)):NaN,tools=Number.isFinite(t)?t:null;
  if(bookAt&&(!tools||bookAt>=tools))return {at:bookAt,source:bookSource};
  if(tools)return {at:tools,source:'SimcoTools'};
  return null;
}
let __marketRefreshNote='';let __marketRefreshBusy=false;
function setMarketRefreshNote(text){__marketRefreshNote=String(text||'');const el=$('#marketRefreshNote');if(el)el.textContent=__marketRefreshNote;}
const MARKET_BLOCKED_NOTE='The game now blocks direct reads; data updates from game pages you open and from Sync.';
const MARKET_BUSY_NOTE="The game answered 503 (busy or refusing reads); the Manager's own reads pause for 30 min. Data still updates from game pages you open.";
// 403 or 503 wording for a blocked read: the background's own text when it is a notice, else the block status kept in session storage (read only).
async function scmBlockedNoteText(errText){
  const t=String(errText||'');if(scmIsBlockNotice(t))return t;
  try{const r=await chrome.storage.session.get('scmDirectReadsBlocked');if(Number(r?.scmDirectReadsBlocked?.status)===503)return MARKET_BUSY_NOTE;}catch{}
  return /503/.test(t)?MARKET_BUSY_NOTE:MARKET_BLOCKED_NOTE;
}
const __marketBookAsked=new Map();
// Ask the background for the product's game order book. manual=true is the Refresh press (30 s gap there), otherwise automatic (5 min gap).
async function requestMarketOrderBook(realm,id,manual){
  const n=validRealmNumber(realm),rid=Number(id);if(n==null||!(rid>0))return null;
  const epoch=__realmViewEpoch;const stampBefore=marketBookStamp(window.__scmState,n,rid)||0;
  let r=null;try{r=await chrome.runtime.sendMessage(manual?{type:'FETCH_EXCHANGE_ORDER_BOOK',realm:n,resourceId:rid,manual:true}:{type:'FETCH_EXCHANGE_ORDER_BOOK',realm:n,resourceId:rid});}catch{r=null;}
  if(r?.ok&&!r.throttled&&epoch===__realmViewEpoch){
    // The background answers when the read is saved; local storage can show it a moment later. Up to 4 local reads (no game request) until the newer book is there.
    try{for(let i=0;i<4;i++){const fresh=await get();if(epoch!==__realmViewEpoch||marketRealmFromState(fresh)!==n)break;const at=marketBookStamp(fresh,n,rid)||0;if(at>stampBefore||i===3){commitDashboardState(fresh);renderLiveMarketProduct(fresh);break;}await new Promise(x=>setTimeout(x,500));}}catch{}
  }
  return r;
}
function marketAutoOrderBook(realm,id){
  const n=validRealmNumber(realm);if(n==null||!(Number(id)>0))return;
  const at=marketBookStamp(window.__scmState,n,id);if(at&&Date.now()-at<5*60000)return;
  const k=`${n}:${id}`;if(Date.now()-(__marketBookAsked.get(k)||0)<60000)return;__marketBookAsked.set(k,Date.now());
  requestMarketOrderBook(n,id,false);
}
async function marketManualRefresh(btn){
  if(__marketRefreshBusy)return;
  const realm=marketRealmFromState(window.__scmState);if(realm==null)return;
  const [id,q]=String(__selectedMarketKey).split(':').map(Number);const haveProduct=Number.isFinite(id)&&id>0&&Number.isFinite(q);
  __marketRefreshBusy=true;if(btn)btn.disabled=true;setMarketRefreshNote('Updating prices…');
  const epoch=__realmViewEpoch;
  try{
    const [tools,,book]=await Promise.all([requestLiveMarketRefresh(realm,true),haveProduct?requestLiveMarketProduct(realm,id,q,true):null,haveProduct?requestMarketOrderBook(realm,id,true):null]);
    if(epoch!==__realmViewEpoch)return;
    // The two parallel requests each render from their own read; one last local read so the newest storage wins.
    try{const fresh=await get();if(epoch===__realmViewEpoch&&marketRealmFromState(fresh)===realm){commitDashboardState(fresh);renderLiveMarketProduct(fresh);}}catch{}
    if(epoch!==__realmViewEpoch)return;
    let text;
    if(!haveProduct)text='Select a warehouse resource first.';
    else if(book?.directReadsBlocked)text=await scmBlockedNoteText(book.error);
    else if(book?.ok&&!book.throttled)text=`Order book updated ${marketClock(Date.now())}`;
    else if(book?.ok){const at=marketBookStamp(window.__scmState,realm,id)||Number(book.lastAt)||0;text=at?`Order book is from ${marketClock(at)}`:'Order book is up to date.';}
    else if(book?.realmMismatch||book?.skipped)text='Order book not updated: open the game tab on this realm.';
    else text='Order book could not be updated now. Try again in a minute.';
    const next=tools&&tools.simcoNextAt?marketClock(tools.simcoNextAt):'';
    if(next)text+=` · Next SimcoTools refresh at ${next}`;
    setMarketRefreshNote(text);
  }finally{__marketRefreshBusy=false;if(btn)btn.disabled=false;}
}
// Dashboard market refresh (Settings > Background timers, 'dashLiveMarket'): on/off and the interval come from the saved
// timer config; re-armed after a save and when the dashboard becomes visible again. Default 5 min, never faster.
let __liveMarketCfg='unset';
function scmLiveMarketTick(){
  if(activeTab!=='market'&&activeTab!=='warehouse')return;
  const state=window.__scmState;if(!state)return;
  const n=marketRealmFromState(state); if(n==null)return;
  requestLiveMarketRefresh(n);
  const key=String(__selectedMarketKey||'');
  if(key.includes(':')){const [id,q]=key.split(':').map(Number);if(Number.isFinite(id)&&Number.isFinite(q))requestLiveMarketProduct(n,id,q);}
}
function scmApplyLiveMarketTimer(){
  const C=scmTimersCore();
  if(__liveMarketTimer){clearInterval(__liveMarketTimer);__liveMarketTimer=null;}
  const entry=(__timersCfg&&__timersCfg.dashLiveMarket)||(C?C.defaults().dashLiveMarket:{enabled:true});
  __liveMarketCfg='ready';
  if(entry.enabled===false)return;
  const ms=C?C.intervalMs('dashLiveMarket',entry):300000;
  __liveMarketTimer=setInterval(scmLiveMarketTick,ms||300000);
}
function ensureLiveMarketTimer(s){
  if(__liveMarketTimer||__liveMarketCfg!=='unset')return;
  __liveMarketCfg='loading';
  scmLoadTimers().then(scmApplyLiveMarketTimer,scmApplyLiveMarketTimer);
}
function marketWarehouseOptions(s){
  const rows=warehouseRows(s).filter(r=>Number(r?._qty||0)>0&&Number.isFinite(Number(r?._id))&&Number.isFinite(Number(r?._quality)));
  const seen=new Set();
  return rows.map(r=>({key:`${Number(r._id)}:${Number(r._quality)}`,id:Number(r._id),quality:Number(r._quality),qty:Number(r._qty)||0,name:resourceName(r,s),cost:Number(r._unitCost)})).filter(x=>{if(seen.has(x.key))return false;seen.add(x.key);return true;}).sort((a,b)=>a.name.localeCompare(b.name)||a.quality-b.quality);
}
function marketNumeric(v){if(v===null||v===undefined||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null;}
function marketMoney(v){const n=marketNumeric(v);return n==null?'—':money(n);}
function marketDate(v){if(v==null)return '—';if(typeof v==='object'){v=v.timestamp??v.time??v.date??v.at??v.value??null;}const d=new Date(v);return Number.isNaN(d.getTime())?String(v):d.toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});}
// Single source for market price and VWAP: market-core.js (SCM_MARKET_CORE). Modes: 'exact' quality, 'min' quality or better,
// 'any' cheapest listing of any quality (the game calculator rule). Never borrows a neighbouring quality.
// Memoised per state object (warehouse tables call this once per row); the memo expires after 5 s so ages stay honest.
const __scmMarketMemo=new WeakMap();
function scmMarketCtx(s){
  if(!s||typeof s!=='object')return null;
  const now=Date.now();let m=__scmMarketMemo.get(s);
  if(!m||now-m.t>5000){
    const ac=s.authData?.authCompany,cid=Number(ac?.companyId??ac?.id);
    const realm=validRealmNumber(s.viewRealm??s.captureRealm??s.selectedRealm??ac?.realmId);
    // A realm sub-store has no marketOrders: read the root state's, only when the root views the same realm.
    let mo=s.marketOrders;
    if(!mo){const root=typeof window!=='undefined'?window.__scmState:null;if(realm!=null&&root&&root!==s&&validRealmNumber(root.viewRealm??root.captureRealm??root.selectedRealm)===realm)mo=root.marketOrders;}
    const orders=Array.isArray(mo?.orders)?mo.orders:[];
    const cid2=cid>0?cid:Number(mo?.companyId);
    m={t:now,realm:realm==null?-1:realm,companyId:cid2>0?cid2:null,ownIds:new Set(orders.map(o=>o?.id).filter(v=>v!=null).map(String)),prices:new Map(),vwaps:new Map()};
    __scmMarketMemo.set(s,m);
  }
  return m;
}
// The realm is never taken from the price data being validated. A realm sub-store that carries no realm field of its own
// gets the view realm stamped on a shallow copy (null realm: returned as is, so market-core finds no price).
function scmStoreWithRealm(store,realm){
  if(!store||typeof store!=='object'||realm==null)return store;
  if(validRealmNumber(store.viewRealm??store.captureRealm??store.selectedRealm??store.authData?.authCompany?.realmId)!=null)return store;
  return {...store,viewRealm:realm};
}
// SimcoTools side data lives on the root state only; a realm sub-store borrows it when the root views the same realm.
function scmSimcoData(s,field){
  if(s&&s[field])return s[field];
  const root=typeof window!=='undefined'?window.__scmState:null;
  const r=validRealmNumber(s?.viewRealm??s?.captureRealm??s?.selectedRealm??s?.authData?.authCompany?.realmId),rr=root?validRealmNumber(root.viewRealm??root.captureRealm??root.selectedRealm):null;
  return root&&root!==s&&(field==='simcoBuildings'||(r!=null&&r===rr))?(root[field]||null):null;
}
function scmMarketPrice(s,id,quality,mode='exact'){
  const core=globalThis.SCM_MARKET_CORE,m=scmMarketCtx(s);if(!core||!m)return null;
  const key=`${mode}|${Number(id)}|${Number(quality)}`;
  if(m.prices.has(key))return m.prices.get(key);
  const r=core.marketPrice(s,m.realm,id,quality,{mode,now:m.t,companyId:m.companyId,ownIds:m.ownIds,simcoPrices:typeof scmSimcoData==='function'?scmSimcoData(s,'simcoPrices'):(s?.simcoPrices||null)});
  m.prices.set(key,r);return r;
}
function cachedMarketVwap(s,resourceId,quality){
  const core=globalThis.SCM_MARKET_CORE,m=scmMarketCtx(s);if(!core||!m)return null;
  const key=`${Number(resourceId)}|${Number(quality)}`;
  if(!m.vwaps.has(key))m.vwaps.set(key,core.vwap(s,m.realm,resourceId,quality,m.t));
  return m.vwaps.get(key)?.value??null;
}
// Origin label for a price that is not a real exchange order-book price (shared rule: exchange => no label).
function scmSrcLabel(p){return p?(p.source==='vwap'?'VWAP fallback':p.source==='ticker'?'Game ticker':p.source==='simcotools'?(p.stale?'SimcoTools · stale':'SimcoTools'):p.source==='simcotools-prices'?(p.stale?'SimcoTools last trade · stale':'SimcoTools last trade'):''):'';}
function scmSrcTag(p,cls){const l=scmSrcLabel(p);return l?`<small class="${cls||'market-inline-vwap'}">${escapeHtml(l)}</small>`:'';}
// Short origin text for a shared-source price: where it came from, how old, and "old" when it is stale.
function scmMarketSourceText(p){
  if(!p)return 'Market price not captured';
  const age=p.ageMs!=null?plannerAge(p.ageMs):'';
  const base=p.source==='exchange'?'Exchange listing':p.source==='ticker'?'Game ticker':p.source==='simcotools'?'SimcoTools':p.source==='simcotools-prices'?'SimcoTools last trade':scmSrcLabel(p);
  return `${base}${age?` · ${age}`:''}${p.stale?(p.source==='simcotools'||p.source==='simcotools-prices'?' · stale':p.source==='exchange'?' · old':''):''}`;
}
function renderWarehouseMarketTimestamp(s){ensureLiveMarketTimer(s);const el=$('#warehouseMarketUpdated');if(!el)return;const data=s?.liveMarketPriceData;const realm=Number(s?.viewRealm??s?.captureRealm??s?.authData?.authCompany?.realmId);const valid=Number(data?.realm)===realm;const stamp=valid?(data?.updatedAt||data?.fetchedAt):null;const rows=valid&&Array.isArray(data?.rows)?data.rows:[];const pairs=new Set(warehouseRows(s).filter(r=>Number(r?._qty||0)>0&&Number.isFinite(Number(r?._id))&&Number(r?._id)>0&&Number.isFinite(Number(r?._q))&&Number(r?._q)>=0).map(r=>`${Number(r._id)}:${Number(r._q)}`));const captured=new Set(rows.filter(r=>Number(r?.price)>0&&pairs.has(`${Number(r?.resourceId)}:${Number(r?.quality)}`)).map(r=>`${Number(r.resourceId)}:${Number(r.quality)}`));const completeness=pairs.size?` · ${captured.size}/${pairs.size} warehouse prices captured`:'';el.textContent=stamp?`Market prices last updated: ${marketDate(stamp)}${completeness}`:'Market prices last updated: not captured for this realm';}
function marketSnapshotCandle(m){
  const c=m?.selected||{};
  const rawFiveMinute=m?.raw?.summary?.fiveMinutesCandlestick||m?.selected?.raw?.summary?.fiveMinutesCandlestick||{}; const rawSummary=m?.raw?.summary||m?.selected?.raw?.summary||{}; return {open:marketNumeric(c.open)??marketNumeric(rawFiveMinute.open),close:marketNumeric(c.close)??marketNumeric(rawFiveMinute.close),high:marketNumeric(c.high)??marketNumeric(rawFiveMinute.high),low:marketNumeric(c.low)??marketNumeric(rawFiveMinute.low),volume:marketNumeric(c.candleVolume)??marketNumeric(c.volume)??marketNumeric(rawFiveMinute.volume)??marketNumeric(rawSummary.volume)};
}
function resolveLiveMarketProductView(activeStore,s,item){
  const productCache=activeStore?.liveMarketProductCache&&typeof activeStore.liveMarketProductCache==='object'?activeStore.liveMarketProductCache:{};
  const cacheProduct=productCache[item.key];
  const pointer=activeStore?.liveMarketProduct||s?.liveMarketProduct||{};
  const pointerMatches=Number(pointer?.resourceId)===item.id&&Number(pointer?.quality)===item.quality;
  const fullProduct=cacheProduct&&Number(cacheProduct.resourceId)===item.id&&Number(cacheProduct.quality)===item.quality?cacheProduct:(pointerMatches?pointer:null);
  const priceData=activeStore?.liveMarketPriceData||s?.liveMarketPriceData||{};
  const allPriceRows=Array.isArray(priceData.rows)?priceData.rows:[];
  const currentPriceRow=allPriceRows.find(r=>Number(r?.resourceId)===item.id&&Number(r?.quality)===item.quality&&marketNumeric(r?.price)!=null&&Number(r.price)>0)||null;
  const vwap=cachedMarketVwap(activeStore,item.id,item.quality);
  // Use the cached row while detail/candle fetch is pending; a different
  // selected-product pointer must never blank an already-known product price.
  const quickView=!fullProduct&&currentPriceRow?{
    resourceId:item.id,quality:item.quality,fetchedAt:currentPriceRow.fetchedAt||priceData.updatedAt||null,
    vwap,qualities:allPriceRows.filter(r=>Number(r?.resourceId)===item.id).map(r=>({resourceId:Number(r.resourceId),quality:Number(r.quality),price:marketNumeric(r.price),lastTrade:r.lastTrade||null,vwap:cachedMarketVwap(activeStore,r.resourceId,r.quality)})),
    selected:{resourceId:item.id,quality:item.quality,price:marketNumeric(currentPriceRow.price),volume:null,lastTrade:currentPriceRow.lastTrade||null,open:null,close:null,high:null,low:null,candleVolume:null},candles:[]
  }:null;
  return {fullProduct,currentPriceRow,vwap,selected:fullProduct||quickView};
}

function renderLiveMarketProduct(s){
  const host=$('#marketProductPanel'),select=$('#marketWarehouseSelect'); if(!host||!select)return;
  ensureLiveMarketTimer(s);
  const realm=marketRealmFromState(s), options=marketWarehouseOptions(s);
  const previous=select.value||__selectedMarketKey;
  select.innerHTML='<option value="">Select warehouse resource…</option>'+options.map(x=>`<option value="${escapeHtml(x.key)}">${escapeHtml(x.name)} · Q${escapeHtml(String(x.quality))} · ${num(x.qty)} in warehouse</option>`).join('');
  if(options.some(x=>x.key===previous)){select.value=previous;__selectedMarketKey=previous;} else if(options.length){select.value=options[0].key;__selectedMarketKey=options[0].key;}
  const selectedKey=select.value||'';
  const item=options.find(x=>x.key===selectedKey);
  if(!item){host.innerHTML='<div class="market-empty-state">No warehouse resources with quantity greater than zero were captured for this realm.</div>';return;}
  const activeStore=scmStoreWithRealm(s?.realmStores?.[`realm:${realm}`]||s||{},realm);
  const {fullProduct,currentPriceRow,vwap,selected}=resolveLiveMarketProductView(activeStore,s,item);
  const liveStatus=$('#marketLiveStatus'),liveUpdated=$('#marketLiveUpdated'),realmEl=$('#marketSiteRealm');
  if(realmEl)realmEl.textContent=realm===1?'R2':'R1';
  const sharedForLabel=scmMarketPrice(activeStore,item.id,item.quality,'exact');
  // A price from the game ticker is a real game price: its time counts like the order book's.
  // The Updated label names the source of the price that is shown: the game book/ticker only when that price comes from it (SimcoTools is the default).
  const gameShown=sharedForLabel?.source==='ticker'||sharedForLabel?.source==='exchange';
  const bookOrTickerAt=!gameShown?null:Math.max(marketBookStamp(s,realm,item.id)||0,sharedForLabel?.source==='ticker'&&Number(sharedForLabel.at)>0?Number(sharedForLabel.at):0)||null;
  const simcoAt=selected?.fetchedAt||(sharedForLabel?.source==='simcotools-prices'&&Number(sharedForLabel.at)>0?new Date(Number(sharedForLabel.at)).toISOString():null);
  const newest=marketNewestStamp(bookOrTickerAt,simcoAt,sharedForLabel?.source==='ticker'&&Number(sharedForLabel.at)===bookOrTickerAt?'Game ticker':'Game market');
  const newestText=newest?`Updated ${marketDate(newest.at)} · ${newest.source}`:'';
  if(liveStatus)liveStatus.textContent=newest?'Live':'Waiting';
  if(liveUpdated)liveUpdated.textContent=newest?newestText:'Waiting for market data…';
  const snap=selected?.selected||{};
  const candle=marketSnapshotCandle(selected);
  const cost=Number.isFinite(item.cost)?item.cost:null;
  const plannerDiscount=plannerDiscountPercent(plannerUiState(s).discount);
  const discountInput=$('#marketContractDiscount');
  if(discountInput){discountInput.max='10';discountInput.value=String(plannerDiscount);}
  const discount=plannerDiscount;
  const sharedPrice=scmMarketPrice(activeStore,item.id,item.quality,'exact'),currentMarketPrice=sharedPrice?.price??null;const contract=currentMarketPrice==null?null:roundCurrencyUp(currentMarketPrice*(1-discount/100));
  const qualityRows=Array.isArray(selected?.qualities)?selected.qualities:[];
  const info=resourceInfo(item,s),src=(s.resourceImageCache?.[String(item.id)]||s.resourceImageData?.[String(item.id)]||info.imageCandidates?.[0]||'');
  const img=scmSafeImgSrc(src)?`<img class="market-resource-icon" src="${escapeHtml(scmSafeImgSrc(src))}" alt="">`:'';
  const change=marketNumeric(candle.open)!=null&&candle.open!==0&&marketNumeric(candle.close)!=null?(candle.close-candle.open)/candle.open*100:null;
  const tableRows=qualityRows.map(q=>{const qp=scmMarketPrice(activeStore,item.id,q.quality,'exact'),price=qp?.price??null,qv=cachedMarketVwap(activeStore,item.id,q.quality);const discounted=price==null?null:roundCurrencyUp(price*(1-discount/100));return `<tr><td>Q${q.quality}</td><td><strong>${marketMoney(price)}</strong>${scmSrcTag(qp)}${qv!=null?`<small class="market-inline-vwap">VWAP ${marketMoney(qv)}</small>`:''}</td><td>${marketMoney(discounted)}</td><td>${marketDate(q.lastTrade)}</td></tr>`;}).join('')||'<tr><td colspan="4">Waiting for exchange data…</td></tr>';
  const candles=Array.isArray(selected?.selected?.candles)?selected.selected.candles.slice(-36):[];
  const volume=marketNumeric(snap.volume)??marketNumeric(snap.candleVolume)??marketNumeric(selected?.volume)??marketNumeric(selected?.raw?.summary?.fiveMinutesCandlestick?.volume)??marketNumeric(selected?.raw?.summary?.volume);
  host.innerHTML=`<div class="market-product-head"><div class="market-product-title">${img}<div><h2>${escapeHtml(item.name)} Q${item.quality}</h2><p>${num(item.qty)} units in warehouse · Your cost ${cost==null?'—':money(cost)}</p></div></div><span class="market-follow">★</span></div><div class="market-primary-grid"><div class="market-primary-price"><small>MARKET PRICE</small><strong>${marketMoney(currentMarketPrice)}</strong><span>${change==null?'':`${change>=0?'+':''}${change.toFixed(2)}%`} · Last trade ${marketDate(snap.lastTrade??currentPriceRow?.lastTrade)}${sharedPrice?` · ${escapeHtml(scmMarketSourceText(sharedPrice))}`:''}</span></div><div class="market-primary-stat"><span>Volume</span><strong>${volume==null?'—':num(volume)}</strong><small>${escapeHtml(selected?.volumePeriod||'Current market')}</small></div><div class="market-primary-stat"><span>VWAP</span><strong>${marketMoney(vwap)}</strong><small>${contract==null?'':`Contract ${money(contract)} at ${discount.toFixed(1)}% off`}</small></div></div><div class="market-five"><div><strong>5 minutes</strong><span>Open ${marketMoney(candle.open)}</span><span>Close ${marketMoney(candle.close)}</span><span>Range ${marketMoney(candle.low)} – ${marketMoney(candle.high)}</span><span>Volume ${candle.volume==null?'—':num(candle.volume)}</span></div></div><div class="market-contract-table"><div class="market-contract-table-head"><strong>EXCHANGE / CONTRACT DATA</strong><span>Discount ${discount.toFixed(1)}%</span></div><div class="table-wrap"><table class="mobile-cards"><thead><tr><th>QUALITY</th><th>MARKET DATA</th><th>CONTRACT PRICE</th><th>LAST TRADE</th></tr></thead><tbody>${tableRows}</tbody></table></div></div><div class="market-candle-wrap"><div class="market-candle-head"><strong>MARKET CHART</strong><span>${candles.length?`${candles.length} recent candles`:'Waiting for chart data'}</span></div><div id="marketLiveCandleChart" class="market-live-candle-chart">${renderLiveCandleChart(candles)}</div></div><div class="market-product-footer"><span>${newest?escapeHtml(newest.source==='SimcoTools'?'Live SimcoTools market data':newest.source==='Game ticker'?'Game ticker data':'Game market data'):'Live market data'}</span><span>${newest?escapeHtml(newestText):'Waiting for update…'}</span></div>`;
  if(!select.dataset.bound){
    select.addEventListener('change',()=>{__selectedMarketKey=select.value;const [id,q]=select.value.split(':').map(Number);const currentRealm=marketRealmFromState(window.__scmState);if(Number.isFinite(id)&&Number.isFinite(q)&&currentRealm!=null){requestLiveMarketProduct(currentRealm,id,q,true);marketAutoOrderBook(currentRealm,id);}setMarketRefreshNote('');if(window.__scmState)renderLiveMarketProduct(window.__scmState);});
    $('#marketContractDiscount')?.addEventListener('input',()=>{
      const state=window.__scmState;if(!state)return;
      const input=$('#marketContractDiscount');
      const ui=plannerUiState(state);
      ui.discount=plannerDiscountPercent(input?.value);
      if(input)input.value=String(ui.discount);
      queuePlannerUiPersist(state);
      renderLiveMarketProduct(state);
      if($('#buildingPlanner'))renderBuildingPlanner(state);
    });
    $('#marketRefreshNow')?.addEventListener('click',e=>{marketManualRefresh(e.currentTarget).catch(()=>{});});
    select.dataset.bound='1';
  }
  if(!fullProduct)requestLiveMarketProduct(realm,item.id,item.quality);
}
function renderLiveCandleChart(rows){
  const valid=(Array.isArray(rows)?rows:[]).filter(r=>Number.isFinite(Number(r.open))&&Number.isFinite(Number(r.close))&&Number.isFinite(Number(r.high))&&Number.isFinite(Number(r.low)));
  if(!valid.length)return '<div class="market-chart-empty muted">Waiting for SimcoTools market chart data…</div>';
  const W=900,H=290,PL=58,PR=18,PT=16,PB=34,iw=W-PL-PR,ih=H-PT-PB;let min=Math.min(...valid.map(r=>r.low)),max=Math.max(...valid.map(r=>r.high));if(min===max){min-=1;max+=1;}const pad=(max-min)*.08;min=Math.max(0,min-pad);max+=pad;const x=i=>PL+(valid.length===1?iw/2:(i/(valid.length-1))*iw),y=v=>PT+(1-(v-min)/(max-min))*ih,step=Math.max(5,iw/valid.length*.45);const grid=[0,.25,.5,.75,1].map(t=>{const yy=PT+t*ih,val=max-t*(max-min);return `<line x1="${PL}" y1="${yy}" x2="${W-PR}" y2="${yy}" stroke="rgba(127,127,127,.18)"/><text x="${PL-7}" y="${yy+4}" text-anchor="end" fill="currentColor" opacity=".62" font-size="11">${money(val)}</text>`}).join('');const candles=valid.map((r,i)=>{const xx=x(i),up=r.close>=r.open,top=y(Math.max(r.open,r.close)),bottom=y(Math.min(r.open,r.close)),wickTop=y(r.high),wickBottom=y(r.low),body=Math.max(2,bottom-top);return `<g><line x1="${xx}" y1="${wickTop}" x2="${xx}" y2="${wickBottom}" stroke="currentColor" opacity=".8"/><rect x="${xx-step/2}" y="${top}" width="${step}" height="${body}" fill="currentColor" opacity="${up?.9:.45}"/><title>${escapeHtml(String(r.time??''))} · O ${money(r.open)} H ${money(r.high)} L ${money(r.low)} C ${money(r.close)}</title></g>`}).join('');return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="SimcoTools market candlestick chart"><g>${grid}</g>${candles}</svg>`;
}

function renderMarketHistory(s){
 const rows=warehouseRows(s), history=s.history||{};
 const select=$('#marketChartSelect'), box=$('#marketChart'), stats=$('#marketSelectedStats'), historyRowsEl=$('#historyRows'), countEl=$('#marketHistoryCount'), empty=$('#marketEmpty');
 if(!select||!box)return;
 const items=rows.filter(r=>Number.isFinite(r._id)&&r._quality!=null).map(r=>({key:`${r._id}:${r._quality}`,id:r._id,quality:r._quality,name:resourceName(r,s),cost:r._unitCost}));
 const seen=new Set(); const opts=items.filter(x=>{if(seen.has(x.key))return false;seen.add(x.key);return true;});
 const previous=select.value;
 select.innerHTML='<option value="">Select product</option>'+opts.map(x=>`<option value="${escapeHtml(x.key)}">${escapeHtml(x.name)} · Q${escapeHtml(String(x.quality))}</option>`).join('');
 if(opts.some(x=>x.key===previous)) select.value=previous; else if(opts.length) select.value=opts[0].key;
 const draw=()=>{
   const item=opts.find(x=>x.key===select.value);
   if(!item){box.innerHTML='<div class="market-chart-empty muted">Select a product with VWAP history.</div>';if(stats)stats.innerHTML='';if(historyRowsEl)historyRowsEl.innerHTML='<tr><td colspan="3">Select a product to view history.</td></tr>';if(countEl)countEl.textContent='';return;}
   const raw=Array.isArray(history[item.key])?history[item.key]:[];
   const currentRealmVwap=simcoVwapRows(s,item.id,item.quality)[0]?.price;
   const seeded=raw.slice();
   if(Number.isFinite(Number(currentRealmVwap))&&Number(currentRealmVwap)>0){
     const today=new Date().toISOString().slice(0,10);
     const idx=seeded.findIndex(x=>String(x?.date)===today);
     const point={date:today,vwap:Number(currentRealmVwap)};
     if(idx>=0)seeded[idx]=point; else seeded.push(point);
   }
   const points=seeded.slice(-30).filter(x=>Number.isFinite(Number(x.vwap))).map(x=>({date:String(x.date),vwap:Number(x.vwap)}));
   const last=points[points.length-1];
   const first=points[0];
   const changePct=first&&last&&first.vwap!==0?(last.vwap-first.vwap)/first.vwap*100:null;
   const margin=last&&Number.isFinite(item.cost)&&item.cost>0?(last.vwap-item.cost)/item.cost*100:null;
   if(empty)empty.textContent=points.length?`${item.name} · Q${item.quality} — ${points.length} daily VWAP snapshot${points.length===1?'':'s'} available.`:'No daily VWAP history yet for this product. Keep the extension running and syncing.';
   if(stats){
     stats.innerHTML=`<div class="market-stat"><span>Latest VWAP</span><strong>${last?money(last.vwap):'—'}</strong></div><div class="market-stat"><span>Your cost</span><strong>${Number.isFinite(item.cost)?money(item.cost):'—'}</strong></div><div class="market-stat"><span>30-day change</span><strong class="${changePct==null?'':changePct>=0?'positive':'negative'}">${changePct==null?'—':`${changePct>=0?'+':''}${changePct.toFixed(1)}%`}</strong></div><div class="market-stat"><span>Margin vs VWAP</span><strong class="${margin==null?'':margin>=0?'positive':'negative'}">${margin==null?'—':`${margin>=0?'+':''}${margin.toFixed(1)}%`}</strong></div>`;
   }
   if(countEl)countEl.textContent=`Showing ${points.length} of up to 30 days`;
   if(historyRowsEl){
     const reversed=points.slice().reverse();
     historyRowsEl.innerHTML=reversed.map((p,i)=>{const newer=reversed[i-1];const ch=newer&&p.vwap!==0?(newer.vwap-p.vwap)/p.vwap*100:null;return `<tr><td>${escapeHtml(p.date)}</td><td><strong>${money(p.vwap)}</strong></td><td class="${ch==null?'':ch>=0?'positive':'negative'}">${ch==null?'—':`${ch>=0?'+':''}${ch.toFixed(1)}%`}</td></tr>`}).join('')||'<tr><td colspan="3">No daily VWAP history yet.</td></tr>';
   }
   if(!points.length){box.innerHTML='<div class="market-chart-empty muted">No daily VWAP history yet for this product. Keep the extension running and syncing.</div>';return;}
   const W=760,H=250,PL=58,PR=18,PT=18,PB=38,iw=W-PL-PR,ih=H-PT-PB;
   const vals=points.map(p=>p.vwap); if(Number.isFinite(item.cost)) vals.push(Number(item.cost));
   let min=Math.min(...vals),max=Math.max(...vals); if(min===max){min-=1;max+=1;} const pad=(max-min)*.1;min=Math.max(0,min-pad);max=max+pad;
   const x=i=>PL+(points.length===1?iw/2:(i/(points.length-1))*iw); const y=v=>PT+(1-(v-min)/(max-min))*ih;
   const path=points.map((p,i)=>`${i?'L':'M'} ${x(i).toFixed(1)} ${y(p.vwap).toFixed(1)}`).join(' ');
   const grid=[0,.25,.5,.75,1].map(t=>{const yy=PT+t*ih;const val=max-t*(max-min);return `<line x1="${PL}" y1="${yy}" x2="${W-PR}" y2="${yy}" stroke="rgba(127,127,127,.18)"/><text x="${PL-8}" y="${yy+4}" text-anchor="end" fill="currentColor" opacity=".62" font-size="11">${money(val)}</text>`}).join('');
   const labels=points.map((p,i)=>{if(i!==0&&i!==points.length-1&&i%Math.max(1,Math.floor(points.length/5))!==0)return '';return `<text x="${x(i)}" y="${H-10}" text-anchor="middle" fill="currentColor" opacity=".62" font-size="10">${escapeHtml(p.date.slice(5))}</text>`}).join('');
   const costLine=Number.isFinite(item.cost)?`<line x1="${PL}" y1="${y(Number(item.cost))}" x2="${W-PR}" y2="${y(Number(item.cost))}" stroke="currentColor" stroke-dasharray="6 5" opacity=".65"/>`:'';
   box.innerHTML=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="30 day VWAP chart"><g>${grid}</g>${costLine}<path d="${path}" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${points.map((p,i)=>`<circle cx="${x(i)}" cy="${y(p.vwap)}" r="3.5" fill="currentColor"><title>${escapeHtml(p.date)} · ${escapeHtml(money(p.vwap))}</title></circle>`).join('')}<g>${labels}</g></svg>`;
 };
 if(!select.dataset.chartBound){select.addEventListener('change',draw);select.dataset.chartBound='1';}
 draw();
}

function accountingTransactionRows(a){
  const sources=[a?.source?.recent,a?.source?.cf];
  const rows=[]; const seen=new Set();
  const extract=root=>{
    if(Array.isArray(root))return root;
    if(!root||typeof root!=='object')return [];
    for(const k of ['data','transactions','transaction','items','entries','movements','operations','results','cashflow','cashFlow','history','records']){
      if(Array.isArray(root[k]))return root[k];
    }
    // /cashflow/recent/ is captured as {data:[...], money, oldestPulled}.
    // The endpoint wrapper and its payload both use the key `data`, so when
    // accounting() passes the payload object here the first-level array check
    // above sees another object instead of the transaction rows. Unwrap that
    // one response layer without broad recursive walking.
    if(root.data&&typeof root.data==='object')return extract(root.data);
    return [];
  };
  for(const source of sources){
    for(const row of extract(source)){
      if(!row||typeof row!=='object')continue;
      const details=row.details&&typeof row.details==='object'?row.details:{};
      const id=String(row.id??`${row.datetime||''}|${row.description||''}|${row.money??row.amount??''}`);
      if(seen.has(id))continue;seen.add(id);
      const moneyValue=numericValue(row.money??details.money??row.cashChange??row.change);
      const profitValue=numericValue(row.profit??details.profit??row.netProfit??details.netProfit);
      const priceValue=numericValue(row.price??details.price??row.unitPrice??details.unitPrice??row.pricePerUnit??details.pricePerUnit);
      const quantityValue=numericValue(row.quantity??details.quantity??row.amount??details.amount??row.qty??details.qty);
      const datetime=Date.parse(String(row.datetime??details.datetime??row.date??details.date??''));
      const resourceId=Number(row.resource??details.resource??row.resourceId??details.resourceId??row.productId??details.productId);
      if(moneyValue==null&&profitValue==null&&priceValue==null&&quantityValue==null)continue;
      rows.push({row,details,id,money:moneyValue,profit:profitValue,price:priceValue,quantity:quantityValue,datetime:Number.isFinite(datetime)?datetime:null,resourceId:Number.isFinite(resourceId)?resourceId:null});
    }
  }
  return rows;
}
function accountingPeriodViewData(a,mode){
  const key=String(mode||'current');
  if(key==='current')return {...a,periodMode:'current',periodSource:'aggregate'};
  const rows=accountingTransactionRows(a).filter(x=>Number.isFinite(x.datetime));
  if(!rows.length)return {...a,periodMode:key,periodSource:'unavailable'};
  const end=Math.max(...rows.map(x=>x.datetime));
  const days=key==='day'?1:key==='week'?7:30;
  const start=end-days*86400000;
  const selected=rows.filter(x=>x.datetime>=start&&x.datetime<=end);
  const cashChange=selected.reduce((sum,x)=>sum+(Number(x.money)||0),0);
  const revenue=selected.reduce((sum,x)=>sum+Math.max(0,Number(x.money)||0),0);
  const expenses=selected.reduce((sum,x)=>sum+Math.max(0,-(Number(x.money)||0)),0);
  const explicitProfit=selected.reduce((sum,x)=>sum+(Number(x.profit)||0),0);
  const hasExplicitProfit=selected.some(x=>Number.isFinite(Number(x.profit)));
  const profit=hasExplicitProfit?explicitProfit:(revenue||expenses?revenue-expenses:null);
  return {...a,revenue:revenue||null,expenses:expenses||null,profit,netMargin:revenue&&profit!=null?profit/revenue*100:null,cashChange,period:{...(a.period||{}),dateFrom:new Date(start).toISOString(),date:new Date(end).toISOString()},periodMode:key,periodSource:'recent-cashflow',periodTransactionCount:selected.length};
}
function accountingComparisonBase(a){
  // Only the game's own completed-day history and cash-flow ledger are used: a "last value this dashboard saw"
  // baseline could equal the current figures (or be empty) and produce fake +100% / $0 changes.
  const p=a?.previousPeriod||null;
  if(p&&a?.sourceType!=='income-statement'&&p.cashIn!=null)return {...p,revenue:p.cashIn,sales:p.cashIn};
  return p;
}
// Daily Accounting walk card (Accounting tab): next / last result and Run now. On/off and the time are set in Settings > Background timers.
function accountingWalkTimes(sch){
  const t=v=>{const d=new Date(v);return v&&Number.isFinite(d.getTime())?d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}):null;};
  const dt=v=>{const d=new Date(v);return v&&Number.isFinite(d.getTime())?`${d.toLocaleDateString(undefined,{weekday:'short'})} ${t(v)}`:'—';};
  return {t,dt};
}
function accountingWalkHeadText(sch){
  const {t}=accountingWalkTimes(sch);
  if(!sch?.enabled)return 'Off';
  if(sch?.retryAt)return `On · retry ${t(sch.retryAt)||'—'}`;
  if(sch?.nextAt)return `On · ${t(sch.nextAt)}`;
  return 'On · Sync first';
}
function accountingWalkScheduleHtml(sch,walk,realm){
  const {dt}=accountingWalkTimes(sch);
  const on=Boolean(sch?.enabled), off=Number(sch?.offsetMin)||30, r=sch?.realm!=null?Number(sch.realm):realm;
  const lr=sch?.lastResult;
  const last=lr?(lr.error?`<span class="warn">${Number(lr.captured)||0}/7 ✗</span>`:`<span class="ok">${Number(lr.captured)||0}/7 ✓</span>`):'—';
  const next=on?(sch?.nextAt?escapeHtml(dt(sch.nextAt)):'Sync first'):'Off';
  const other=on&&r!=null&&realm!=null&&r!==realm?` · ${escapeHtml(realmName(r))}`:'';
  return `<div class="acct-walk">
<div class="acct-walk-row acct-walk-info"><span>Next <strong>${next}</strong>${other}</span><span>Last <strong>${last}</strong></span></div>
<div class="acct-walk-row"><button id="acctWalkRunNow" type="button">Run now</button><span id="acctWalkMsg" class="muted">${escapeHtml(accountingWalkMsg||(lr?.error?lr.error:''))}</span></div>
<div class="acct-walk-row muted">Turn it on and set the time in Settings, Background timers.</div>
</div>`;
}
async function renderAccountingWalkSchedule(s){
  const el=document.querySelector('#accountingWalkSchedule'); if(!el)return;
  let sch=null; try{sch=(await chrome.storage.local.get({scmAccountingWalkSchedule:null})).scmAccountingWalkSchedule;}catch{}
  const realm=Number.isFinite(Number(s?.viewRealm))?Number(s.viewRealm):null;
  scmSetHTML(el,accountingWalkScheduleHtml(sch||{},null,realm));
  const head=document.querySelector('#acctWalkHead'); if(head)head.textContent=accountingWalkHeadText(sch||{});
}
function accountingWalkRealm(){const s=window.__scmState||{};const v=s.viewRealm??s.selectedRealm;return v==null||v===''?null:validRealmNumber(v);}
let accountingWalkMsg='';
function setAccountingWalkMsg(t){accountingWalkMsg=String(t||'');const m=document.querySelector('#acctWalkMsg');if(m)m.textContent=accountingWalkMsg;}
document.addEventListener('click',async e=>{
  if(e.target?.id!=='acctWalkRunNow')return;
  e.target.disabled=true; setAccountingWalkMsg('Walking the game Accounting page…');
  try{const r=await chrome.runtime.sendMessage({type:'RUN_ACCOUNTING_WALK_NOW',realm:accountingWalkRealm()});setAccountingWalkMsg(r?.error?r.error:`${Number(r?.captured)||0}/7 days read${r?.ledgerPages!=null?` · ledger ${r.ledgerPages} page${r.ledgerPages===1?'':'s'}${r.ledger==='caught-up'?'':r.ledger==='capped'?' (more next run)':` (${r.ledger})`}`:''}.`);}
  catch(err){setAccountingWalkMsg(err?.message||String(err));}
  finally{renderAccountingWalkSchedule(window.__scmState||{});}
});
scmOnStorageChanged((ch,area)=>{if(area==='local'&&ch.scmAccountingWalkSchedule)renderAccountingWalkSchedule(window.__scmState||{});});
// Settings > Background timers: one list of every background sync timer. On/off, how often (or what time of day),
// what it does, when it runs next. The service worker owns the values (SCM_GET_TIMERS / SCM_SET_TIMERS); this only
// shows them and sends the fields that changed. The Dashboard market refresh below reads the same config.
let __timersCfg=null,__timersStatus={},__timersErrors={},__timersMsg='',__timersLoading=null;
function scmTimersCore(){return globalThis.SCM_TIMERS_CORE||null;}
function scmTimersRealm(){const s=window.__scmState||{};const v=s.viewRealm??s.selectedRealm;return v==null||v===''?null:validRealmNumber(v);}
// A timer the dashboard depends on counts as switched off only when it is in the saved list and disabled (an id this build does not know is never "off").
function scmTimerOff(id){const e=__timersCfg&&__timersCfg[id];return !!e&&e.enabled===false;}
const SCM_OFF_LINK='<button type="button" class="tm-reset" data-open-timers>Open settings</button>';
function scmOffNoteHtml(label){return `${escapeHtml(label)}: off in Background timers · ${SCM_OFF_LINK}`;}
// Market price source: the game order book is off, or none of the other price sources is on.
function scmMarketSourceOff(){return scmTimerOff('orderBook')||(scmTimerOff('dashLiveMarket')&&scmTimerOff('liveMarket')&&(__timersCfg.marketTicker===undefined||scmTimerOff('marketTicker')));}
let __offSig='';
function scmUpdateOffNotes(){
  const set=(sel,on,label)=>{const el=document.querySelector(sel);if(!el)return;if(on){const h=scmOffNoteHtml(label);if(el.__scmOff!==h){el.innerHTML=h;el.__scmOff=h;}el.hidden=false;}else{el.hidden=true;el.__scmOff=null;el.textContent='';}};
  set('#marketOffNote',scmMarketSourceOff(),'Market prices');
  set('#accountingOffNote',scmTimerOff('accountingOnOpen'),'Accounting update on open');
  const sig=[scmTimerOff('abundanceOnLoad')?1:0].join('');
  if(sig!==__offSig){const first=__offSig==='';__offSig=sig;if(!first){try{scheduleDashboardRender();}catch{}}}
}
document.addEventListener('click',e=>{
  const b=e.target?.closest?.('[data-open-timers]');if(!b)return;
  scmCollapseWrite('settings:timers',false);
  document.querySelector('.tab[data-tab="settings"]')?.click();
  const open=()=>{const c=document.querySelector('#timersCard');if(!c)return;scmSetCollapsed(c,false);c.scrollIntoView({block:'start'});};
  open();setTimeout(open,300);
});
function scmTimersApply(r){
  const C=scmTimersCore();if(!C||!r||!r.ok||!r.timers)return false;
  __timersCfg=C.merge(r.timers,{});__timersStatus=r.status&&typeof r.status==='object'?r.status:{};scmUpdateOffNotes();return true;
}
// Reads the saved timer settings. Falls back to the built-in defaults when the service worker does not answer.
async function scmLoadTimers(){
  if(__timersLoading)return __timersLoading;
  __timersLoading=(async()=>{
    let ok=false;try{ok=scmTimersApply(await chrome.runtime.sendMessage({type:'SCM_GET_TIMERS'}));}catch{}
    if(!ok&&!__timersCfg&&scmTimersCore()){__timersCfg=scmTimersCore().defaults();scmUpdateOffNotes();}
    return __timersCfg;
  })().finally(()=>{__timersLoading=null;});
  return __timersLoading;
}
// The block notice from the background (game blocks direct reads) is information, not a failure: no "failed" wording.
function scmIsBlockNotice(t){return /blocks direct reads|Manager's own reads pause/i.test(String(t||''));}
function scmSyncProblemText(err,fallback){const m=String(err||fallback||'');return scmIsBlockNotice(m)?m:`Sync failed: ${m}`;}
function timersClock(ms){const d=new Date(Number(ms));if(!Number.isFinite(d.getTime()))return null;const same=new Date().toDateString()===d.toDateString();const t=d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});return same?t:`${d.toLocaleDateString(undefined,{weekday:'short'})} ${t}`;}
function timersAgo(ms){const d=Date.now()-Number(ms);if(!Number.isFinite(d))return null;if(d<60000)return 'just now';if(d<3600000)return `${Math.round(d/60000)} min ago`;if(d<86400000)return `${Math.round(d/3600000)} h ago`;return `${Math.round(d/86400000)} d ago`;}
function timersUnitText(t,n){return t.unit==='sec'?'sec':t.unit==='min'?'min':(n===1?'day':'days');}
function timersRowHtml(t,e){
  const st=__timersStatus?.[t.id]||{};const err=__timersErrors[t.id];const on=e.enabled!==false;
  const name=escapeHtml(t.label);let value='',hint='';
  if(t.kind==='interval'){
    const u=timersUnitText(t,e.every);
    value=`<span class="nf-val"><input type="number" inputmode="numeric" min="${Number(t.min)}" max="${Number(t.max)}" step="1" value="${escapeHtml(e.every)}" data-tm-every="${escapeHtml(t.id)}" aria-label="${name}: every, in ${escapeHtml(u)}"><span class="tm-unit">${t.unit==='day'?'days':escapeHtml(u)}</span></span>`;
    hint=`min ${Number(t.min)} – max ${Number(t.max)} ${t.unit==='day'?'days':escapeHtml(t.unit)}${t.hitsServer?' · can’t be faster than today, to keep game-server requests low':''}`;
  }else if(t.kind==='toggle'){
    value='';hint='';
  }else{
    const isWalk=t.id==='accountingWalk';
    value=`<span class="nf-val"><input type="time" value="${escapeHtml(e.at||'')}" data-tm-at="${escapeHtml(t.id)}" aria-label="${name}: time of day"></span>`;
    const C=scmTimersCore();const defTxt=isWalk?(Number(st.offsetMin)>0?`${Number(st.offsetMin)} min after the game finishes statements`:'after the game finishes statements'):t.defaultText;
    const parts=[e.at?`Default is ${defTxt}`:`Default (${defTxt})`];
    if(isWalk){const a=st.earliest?C.clockOf(st.earliest):null,z=st.latest?C.clockOf(st.latest):null;parts.push(a&&z?`allowed time ${a} – ${z}, 5 min to 4 h after the game finishes statements`:'press Sync once to set a time (the allowed time depends on when the game finishes statements)');}
    hint=escapeHtml(parts.join(' · '))+(e.at?` · <button type="button" class="tm-reset" data-tm-reset="${escapeHtml(t.id)}">Use default</button>`:'');
  }
  const bits=[];
  if(on&&st.nextRun)bits.push(`Next: ${escapeHtml(timersClock(st.nextRun)||'—')}`);
  if(st.lastRun)bits.push(`Last: ${escapeHtml(timersAgo(st.lastRun)||'—')}`);
  return `<div class="tm-row${on?'':' is-off'}" data-timer="${escapeHtml(t.id)}"><div class="nf-row${on?'':' is-off'}"><label><input type="checkbox" data-tm-en="${escapeHtml(t.id)}" ${on?'checked':''}><span>${name}</span></label>${value}</div><p class="notify-help tm-desc">${escapeHtml(t.description)}</p><div class="tm-meta">${hint}</div>${bits.length?`<div class="tm-meta tm-status">${bits.join(' · ')}</div>`:''}${err?`<div class="tm-err" role="alert">${escapeHtml(err)}</div>`:''}</div>`;
}
function renderTimersUi(){
  const el=document.querySelector('#timersBody');if(!el)return;
  const C=scmTimersCore();if(!C){el.textContent='Timers are not available.';return;}
  if(!__timersCfg){scmSetHTML(el,'<div class="muted">Loading…</div>');return;}
  const groups=[];for(const id of C.IDS){const t=C.byId[id];let g=groups.find(x=>x.name===t.group);if(!g){g={name:t.group,items:[]};groups.push(g);}g.items.push(t);}
  const html=`<div class="nf-compact tm-list">${groups.map(g=>`<h3 class="nf-group">${escapeHtml(g.name)}</h3>${g.items.map(t=>timersRowHtml(t,__timersCfg[t.id]||{})).join('')}`).join('')}</div><div class="tm-foot muted" role="status" aria-live="polite">${escapeHtml(__timersMsg)}</div>`;
  scmSetHTML(el,html);
}
async function loadTimersUi(){await scmLoadTimers();renderTimersUi();}
// Sends only the changed fields. The reply holds the saved values; anything refused comes back in errors[id].
async function saveTimerPatch(id,patch){
  __timersErrors={};__timersMsg='';
  try{
    const r=await chrome.runtime.sendMessage({type:'SCM_SET_TIMERS',timers:{[id]:patch},realm:scmTimersRealm()});
    if(r&&r.ok!==false&&scmTimersApply(r)){if(r.errors&&typeof r.errors==='object')__timersErrors=r.errors;else __timersMsg='Saved.';}
    else{__timersErrors={[id]:(r&&(r.error||(r.errors&&r.errors[id])))||'Could not save.'};await scmLoadTimers();}
  }catch(e){__timersErrors={[id]:e?.message||String(e)};}
  document.activeElement?.blur?.();
  if(document.querySelector('#timersBody')){const el=document.querySelector('#timersBody');el.__scmHtml=null;renderTimersUi();}
  scmApplyLiveMarketTimer();
}
document.addEventListener('change',e=>{
  const t=e.target;if(!t||!t.dataset)return;
  if(t.dataset.tmEn){saveTimerPatch(t.dataset.tmEn,{enabled:t.checked});return;}
  if(t.dataset.tmEvery){const v=Number(t.value);if(!Number.isFinite(v)||t.value===''){renderTimersUi();return;}saveTimerPatch(t.dataset.tmEvery,{every:v});return;}
  if(t.dataset.tmAt){saveTimerPatch(t.dataset.tmAt,{at:t.value||null});}
});
document.addEventListener('click',e=>{const b=e.target?.closest?.('[data-tm-reset]');if(b)saveTimerPatch(b.dataset.tmReset,{at:null});});
$$('.tab').forEach(b=>b.addEventListener('click',()=>{if(b.dataset.tab==='settings')loadTimersUi();}));
scmOnDashboardResume(()=>{scmLoadTimers().then(()=>{if(activeTab==='settings')renderTimersUi();scmApplyLiveMarketTimer();});});
function accountingHistoryTable(history,walk=null){
  const rows=(Array.isArray(history)?history:[]).filter(r=>r.profit!=null||r.assets!=null).slice(-7).reverse();
  if(!rows.length)return '<p class="muted">No daily history captured yet. Open Accounting in the game once, then Sync.</p>';
  const d=t=>new Date(t).toLocaleDateString(undefined,{month:'short',day:'numeric'});
  const tone=v=>v==null?'':(v>=0?'positive':'negative');
  const field=(label,v,cls=false)=>`<div class="acct-day-field"><span>${label}</span><strong class="${cls?tone(v):''}">${v==null?'—':money(v)}</strong></div>`;
  // One collapsible card per day; collapsed shows the day and its profit (right).
  const key=r=>{const t=new Date(r.t);return Number.isFinite(t.getTime())?t.toISOString().slice(0,10):String(r.t);};
  return `<div class="acct-day-list">${rows.map(r=>`<div class="acct-day" data-collapse="acctday:${escapeHtml(key(r))}" data-collapse-default="closed"><div class="acct-day-head" data-collapse-head><span>${escapeHtml(d(r.t))}</span><strong class="${tone(r.profit)}">${r.profit==null?'—':money(r.profit)}</strong></div><div class="acct-day-body">${field('Sales',r.sales)}${r.statement?field('Operating expenses',r.operatingExpenses,true):field('Cash paid out',r.expenses)}${field(r.statement?'Net income':'Profit (EVA)',r.statement?r.netIncome:r.profit,true)}${field('Cash',r.cash)}${field('Inventory',r.inventory)}${field('Total assets',r.assets)}<div class="acct-day-field"><span>Rank</span><strong>${r.rank==null?'—':'#'+Number(r.rank).toLocaleString()}</strong></div></div></div>`).join('')}</div><p class="muted">One row per completed game day. Sales, Operating expenses and Net income are the game's Day statements, read by Sync from the game's Accounting page. A day without one shows the game's Profit (EVA).</p>${accountingDayWalkNote(walk)}`;
}
function accountingDayWalkNote(w){
  if(!w||!w.status)return '';
  const when=v=>{const d=new Date(v);return Number.isFinite(d.getTime())?d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'';};
  if(w.status==='scheduled'||w.status==='running')return `<p class="muted acct-walk-note">Reading the game's Day statements (days 0–6) on the game tab…</p>`;
  const missed=(w.days||[]).filter(d=>!d.ok).map(d=>`day ${d.day}`);
  const txt=w.status==='complete'?`Day statements 0–6 read from the game ${escapeHtml(when(w.finishedAt))}.`:`Day statements: ${Number(w.captured)||0}/${Number(w.wanted)||7} read ${escapeHtml(when(w.finishedAt))}${missed.length?` · missing ${escapeHtml(missed.join(', '))}`:''}${w.error?` · ${escapeHtml(w.error)}`:''}. Older data is kept.`;
  return `<p class="muted acct-walk-note ${w.status==='complete'?'':'warn'}">${txt}</p>`;
}
function accountingOverview(a,previous){
  // Accounting overview: one row per figure, grouped Cash / Income / Expenses. Every row is the latest
  // finished game day (the current statements) against the day before it. Expenses show as positive costs, so a
  // cost going up is red and a cost going down is green. The statement date is shown in the page header only.
  const groups=[['Cash',[['Cash','cash',a.cash],['Total change in cash','cashChange',a.cashChange]]],['Income',[['Sales','sales',a.revenue],['Net income','netIncome',a.profit]]],
    ['Expenses',[['Cost of goods sold','cogs',a.cogs],['Freight out','freightOut',a.freightOut],['Exchange fees','marketFees',a.marketFees],['Executives cost','executives',a.executives],['Operating expenses','operatingExpenses',a.operatingExpenses]]]];
  acctCardNow={};
  const row=([label,key,value])=>{
    const v=acctSigned(key,value),p=acctSigned(key,previous?.[key]);acctCardNow[key]={label,value:v,prev:p};
    return `<div class="acct-row" data-acct-card="${key}"><div class="acct-row-txt" data-acct-part="${key}"><span class="acct-row-label">${escapeHtml(label)}</span><strong class="acct-row-val">${v==null?'—':money(v)}</strong>${acctChangeHtml(key,v,p)}</div><div class="acct-chart acct-row-chart" data-acct-chart="${key}"></div><button type="button" class="acct-chart-open" data-acct-open="${key}" aria-expanded="false" aria-label="Open ${escapeHtml(label)} chart">${ACCT_CHART_ICON}</button></div>`;
  };
  // each row carries a data-acct-part block so a background refresh patches only the rows whose numbers changed
  // (scmPatchParts); the chart area (data-acct-chart) is left to renderAccountingCharts.
  return `<div class="acct-chart-bar">${acctRangeButtons()}</div><div class="acct-chart-pending" data-acct-pending hidden><span></span><button type="button" class="acct-chart-apply" data-acct-apply>Update charts</button></div>${groups.map(([title,rows])=>`<div class="acct-group"><div class="acct-group-head">${escapeHtml(title)}</div>${rows.map(row).join('')}</div>`).join('')}`;
}
function acctNum(v){if(v==null||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null;}
// Expenses are stored as the game shows them (negative); cards and charts show them as positive costs.
function acctSigned(key,v){const n=acctNum(v);return n==null?null:(ACCT_COST_KEYS.has(key)&&n!==0?-n:n);}
// good = green: a rise for cash / income, a fall for an expense.
function acctChangeClass(key,d){return !d?'acct-flat':((ACCT_COST_KEYS.has(key)?d<0:d>0)?'change-up':'change-down');}
function acctChangeHtml(key,v,p){
  if(v==null)return '<span class="acct-row-chg acct-flat">—</span>';
  if(p==null)return '<span class="acct-row-chg acct-flat">No earlier figure captured</span>';
  const delta=roundCurrencyUp(v-p),pct=p!==0?(delta/Math.abs(p))*100:null;
  return `<span class="acct-row-chg ${acctChangeClass(key,delta)}">${delta>0?'↑':delta<0?'↓':'—'} ${delta>0?'+':''}${escapeHtml(acctCompact(delta))} · ${pct==null?'N/A':`${pct>0?'+':''}${pct.toFixed(1)}%`}</span>`;
}
function acctRangeButtons(){return `<div class="acct-range" role="group" aria-label="Chart range">${ACCT_CHART_RANGES.map(n=>`<button type="button" class="acct-range-btn" data-acct-range="${n}" aria-pressed="${n===acctChartRange}">${n}D</button>`).join('')}</div>`;}
function accountingStatementPeriodText(period){
  // Game format, e.g. "8:21 PM 10/24 to 8:20 PM 10/25".
  const f=v=>{const d=new Date(v);return v&&Number.isFinite(d.getTime())?`${d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})} ${d.toLocaleDateString(undefined,{month:'numeric',day:'numeric'})}`:null;};
  const a=f(period?.dateFrom),b=f(period?.date);
  return a&&b?`${a} to ${b}`:(b||'');
}

// Accounting card charts: up to 90 days per card, straight trend line + 7-day average, one 7D/30D/90D
// range for every card, tap readout (date, value, change from the day before). Gaps are joined.
// Background refreshes never rebuild the cards: values are patched in place, and while a chart is being touched
// or its full view is open, new chart data waits behind an "Update charts" button.
// The full view is a popout over the page (✕, tap outside or Esc closes it).
const ACCT_CHART_RANGES=[7,30,90];
const ACCT_CHART_DAY=86400000;
const ACCT_SERIES_KEEP_DAYS=90;
const ACCT_CHART_ICON='<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 11h10M2 8l3-3 2 2 4-5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// Card key -> daily history field. Cash = the game's 90-day history (cash & receivables). The statement figures come
// from the game's Day statements (income / cash-flow) and build up day by day: older days come from
// accountingDailySeries, which keeps what Manager has already read (nothing extra is requested).
const ACCT_CHART_FIELDS={cash:'cash',cashChange:'cashChange',sales:'sales',netIncome:'netIncome',cogs:'cogs',freightOut:'freightOut',marketFees:'marketFees',executives:'executives',operatingExpenses:'operatingExpenses'};
const ACCT_CHART_TITLES={cash:'Cash & receivables'};
// Expense cards: shown as positive costs, so a rising line is bad news.
const ACCT_COST_KEYS=new Set(['cogs','freightOut','marketFees','executives','operatingExpenses']);
let acctChartRange=90, acctChartOpenKey=null, acctChartTouching=false, acctChartPending=null, acctChartPendingCount=0, acctChartDrawn=null, acctCardNow={};
function acctDayKey(t){const d=new Date(t);return Number.isFinite(d.getTime())?d.toISOString().slice(0,10):null;}
function accountingDailySeriesMerge(oldSeries,history,statementHistory,now=Date.now()){
  // Saves each completed day's statement / balance-sheet figures by the day's end date, last 90 days.
  // Days imported on Analyze (CSV) or read earlier (scmStatementHistory) fill days and fields captures lack.
  const days={...(oldSeries&&typeof oldSeries.days==='object'?oldSeries.days:{})};
  for(const r of Array.isArray(history)?history:[]){
    const k=acctDayKey(r?.t);if(!k)continue;const cur={...(days[k]||{})};
    const put=(f,v)=>{if(v!=null&&v!==''&&Number.isFinite(Number(v)))cur[f]=Number(v);};
    if(r.statement){put('sales',r.sales);put('operatingExpenses',r.operatingExpenses);put('netIncome',r.netIncome);put('cogs',r.cogs);put('freightOut',r.freightOut);put('marketFees',r.marketFees);put('executives',r.executives);}
    put('cashChange',r.cashChange);put('currentLiabilities',r.currentLiabilities);
    if(Object.keys(cur).length)days[k]=cur;
  }
  const fill=(k,vals)=>{if(!k)return;const cur={...(days[k]||{})};let n=0;for(const [f,v] of Object.entries(vals)){if(cur[f]==null&&v!=null&&Number.isFinite(Number(v))){cur[f]=Number(v);n++;}}if(n)days[k]=cur;};
  const sh=statementHistory&&typeof statementHistory==='object'?statementHistory:{};
  for(const e of Object.values(sh['income-statement']||{})){if(e?.isComputed===false)continue;const d=accountingStatementDay(e);fill(acctDayKey(Date.parse(String(e?.date||''))),{sales:d.sales,operatingExpenses:d.operatingExpenses,netIncome:d.netIncome,cogs:d.cogs,freightOut:d.freightOut,marketFees:d.marketFees,executives:d.executives});}
  for(const e of Object.values(sh['cashflow-statement']||{})){if(e?.isComputed===false)continue;fill(acctDayKey(Date.parse(String(e?.date||''))),{cashChange:accountingCashChange(e)});}
  const cutKey=acctDayKey(now-ACCT_SERIES_KEEP_DAYS*ACCT_CHART_DAY);
  const keep=Object.keys(days).sort().filter(k=>!cutKey||k>=cutKey).slice(-ACCT_SERIES_KEEP_DAYS);
  return {v:1,days:Object.fromEntries(keep.map(k=>[k,days[k]]))};
}
function updateAccountingDailySeries(s,a){
  const realm=realmSnapshotStore(s);
  const old=realm?.store?.accountingDailySeries||s.accountingDailySeries||null;
  const next=accountingDailySeriesMerge(old,a?.history,s.statementHistory);
  if(JSON.stringify(old?.days||{})!==JSON.stringify(next.days)&&realm){
    realm.store.accountingDailySeries=next;realm.stores[realm.key]=realm.store;
    chrome.runtime.sendMessage({type:'SAVE_REALM_FIELD',realmKey:realm.key,field:'accountingDailySeries',value:next}).catch(()=>{});
  }
  s.accountingDailySeries=next;
  return next;
}
function accountingChartPoints(history,series,key,range){
  // One point per game day: [t, value]. Game history first, saved days fill fields history lacks.
  const field=ACCT_CHART_FIELDS[key];if(!field)return [];
  const saved=series?.days||{};const byDay=new Map();
  for(const r of Array.isArray(history)?history:[]){const k=acctDayKey(r?.t);if(k)byDay.set(k,{t:r.t,v:r[field]});}
  for(const [k,row] of Object.entries(saved)){const cur=byDay.get(k);if(cur){if(cur.v==null)cur.v=row?.[field];}else byDay.set(k,{t:Date.parse(k+'T00:00:00Z'),v:row?.[field],saved:true});}
  const pts=[...byDay.values()].filter(p=>p.v!=null&&Number.isFinite(Number(p.v))&&Number.isFinite(p.t)).map(p=>[p.t,acctSigned(key,p.v)]).sort((x,y)=>x[0]-y[0]);
  if(!pts.length)return pts;
  const end=pts[pts.length-1][0],from=end-(range-1)*ACCT_CHART_DAY-ACCT_CHART_DAY/2;
  return pts.filter(p=>p[0]>=from);
}
function accountingChartTrend(pts){
  // Least-squares straight line; x in days so the slope reads per day.
  if(pts.length<2)return null;const t0=pts[0][0];let sx=0,sy=0,sxy=0,sxx=0;const n=pts.length;
  for(const [t,y] of pts){const x=(t-t0)/ACCT_CHART_DAY;sx+=x;sy+=y;sxy+=x*y;sxx+=x*x;}
  const den=n*sxx-sx*sx;if(!den)return null;const m=(n*sxy-sx*sy)/den;const b=(sy-m*sx)/n;
  return {m,at:t=>m*((t-t0)/ACCT_CHART_DAY)+b};
}
function accountingChartAverage(pts,days=7){
  return pts.map(([t])=>{const w=pts.filter(([u])=>u<=t&&u>t-days*ACCT_CHART_DAY);return [t,w.reduce((s,[,v])=>s+v,0)/w.length];});
}
function acctCompact(v){const n=Number(v);return Number.isFinite(n)?n.toLocaleString(undefined,{style:'currency',currency:'USD',notation:'compact',maximumFractionDigits:2}):'—';}
function acctTone(key,m){if(!m)return 'flat';const up=m>0;return (ACCT_COST_KEYS.has(key)?!up:up)?'good':'bad';}
function accountingSparkline(key,pts){
  if(!pts.length)return '<div class="acct-chart-empty">No daily history yet</div>';
  const W=160,H=64,P=4,t0=pts[0][0],t1=pts[pts.length-1][0];
  let lo=Math.min(...pts.map(p=>p[1])),hi=Math.max(...pts.map(p=>p[1]));if(lo===hi){lo-=1;hi+=1;}
  const X=t=>t1===t0?W/2:P+(t-t0)*(W-2*P)/(t1-t0),Y=v=>H-P-(v-lo)*(H-2*P)/(hi-lo);
  const tr=accountingChartTrend(pts),tone=acctTone(key,tr?.m);
  const path=list=>list.map((p,i)=>(i?'L':'M')+X(p[0]).toFixed(1)+','+Y(p[1]).toFixed(1)).join('');
  const line=path(pts),e=pts[pts.length-1];
  const area=pts.length>1?`<path class="acct-area" d="${line}L${X(t1).toFixed(1)},${H}L${X(t0).toFixed(1)},${H}Z"/>`:'';
  const avg=pts.length>2?`<path class="acct-avg" d="${path(accountingChartAverage(pts))}"/>`:'';
  const trend=tr?`<line class="acct-trend" x1="${X(t0).toFixed(1)}" y1="${Y(tr.at(t0)).toFixed(1)}" x2="${X(t1).toFixed(1)}" y2="${Y(tr.at(t1)).toFixed(1)}"/>`:'';
  return `<svg class="acct-spark acct-${tone}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(key)} trend" data-acct-spark="${escapeHtml(key)}">${area}<path class="acct-line" d="${line}"/>${avg}${trend}<circle class="acct-dot" cx="${X(e[0]).toFixed(1)}" cy="${Y(e[1]).toFixed(1)}" r="2.4"/><line class="acct-cross" x1="0" x2="0" y1="0" y2="${H}"/></svg>`;
}
function accountingChartFooter(key,pts){
  const tr=accountingChartTrend(pts),tone=acctTone(key,tr?.m);
  return `<span class="acct-row-trend acct-${tone}">${tr?`${tr.m>=0?'+':''}${acctCompact(tr.m)}/day`:'needs 2 days'}</span>`;
}
function acctChartDays(pts){return pts.length?Math.round((pts[pts.length-1][0]-pts[0][0])/ACCT_CHART_DAY)+1:0;}
function accountingChartPop(key,pts,range){
  // Popout: name, "N of R days collected" while history is still building, value + change, range, full chart.
  const c=acctCardNow[key]||{},label=ACCT_CHART_TITLES[key]||c.label||key,have=acctChartDays(pts);
  return `<div class="acct-pop" role="dialog" aria-modal="true" aria-label="${escapeHtml(label)} chart"><div class="acct-pop-head"><div><strong>${escapeHtml(label)}</strong>${have<range?`<small>${have} of ${range} days collected</small>`:''}</div><button type="button" class="acct-pop-x" data-acct-close aria-label="Close">✕</button></div><div class="acct-pop-val"><b>${c.value==null?'—':money(c.value)}</b>${acctChangeHtml(key,c.value,c.prev)}</div><div class="acct-chart-bar">${acctRangeButtons()}</div>${accountingChartSheet(key,label,pts,range)}<p class="acct-pop-foot">Tap outside, ✕ or Esc to close</p></div>`;
}
function acctPopEl(){
  // Lives on <body> so it covers the whole page whatever the card's position.
  let el=document.getElementById('acctChartPop');
  if(!el){el=document.createElement('div');el.id='acctChartPop';el.className='acct-pop-backdrop';el.hidden=true;document.body.appendChild(el);}
  return el;
}
function accountingChartSheet(key,label,pts,range){
  const W=340,H=170,L=50,R=8,T=8,B=20;
  if(!pts.length)return '<p class="muted">No daily history yet.</p>';
  const t0=pts[0][0],t1=pts[pts.length-1][0];let lo=Math.min(...pts.map(p=>p[1])),hi=Math.max(...pts.map(p=>p[1]));if(lo===hi){lo-=1;hi+=1;}const pad=(hi-lo)*.08;lo-=pad;hi+=pad;
  const X=t=>t1===t0?(L+W-R)/2:L+(t-t0)*(W-L-R)/(t1-t0),Y=v=>T+(hi-v)*(H-T-B)/(hi-lo);
  const tr=accountingChartTrend(pts),tone=acctTone(key,tr?.m);
  const path=list=>list.map((p,i)=>(i?'L':'M')+X(p[0]).toFixed(1)+','+Y(p[1]).toFixed(1)).join('');
  const day=t=>new Date(t).toLocaleDateString(undefined,{month:'short',day:'numeric'});
  const grid=[0,1,2,3].map(i=>lo+(hi-lo)*i/3).map(v=>`<line class="acct-grid" x1="${L}" x2="${W-R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text x="${L-4}" y="${(Y(v)+3).toFixed(1)}" text-anchor="end">${escapeHtml(acctCompact(v))}</text>`).join('');
  const ticks=(t1===t0?[t0]:[t0,t0+(t1-t0)/2,t1]).map((t,i,a)=>`<text x="${X(t).toFixed(1)}" y="${H-6}" text-anchor="${a.length===1?'middle':['start','middle','end'][i]}">${escapeHtml(day(t))}</text>`).join('');
  const line=path(pts),vals=pts.map(p=>p[1]),change=tr?tr.at(t1)-tr.at(t0):null;
  const body=pts.length>1?`<path class="acct-area" d="${line}L${X(t1).toFixed(1)},${Y(lo).toFixed(1)}L${X(t0).toFixed(1)},${Y(lo).toFixed(1)}Z"/><path class="acct-line" d="${line}"/>`:`<circle class="acct-dot" cx="${X(t0).toFixed(1)}" cy="${Y(pts[0][1]).toFixed(1)}" r="3"/>`;
  const avg=pts.length>2?`<path class="acct-avg" d="${path(accountingChartAverage(pts))}"/>`:'';
  const trend=tr?`<line class="acct-trend" x1="${X(t0).toFixed(1)}" y1="${Y(tr.at(t0)).toFixed(1)}" x2="${X(t1).toFixed(1)}" y2="${Y(tr.at(t1)).toFixed(1)}"/>`:'';
  return `<svg class="acct-big acct-${tone}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(label)} chart">${grid}${body}${avg}${trend}${ticks}</svg><div class="acct-legend"><span><i class="acct-key-line"></i>Daily value</span><span><i class="acct-key-avg"></i>7-day average</span><span><i class="acct-key-trend"></i>Trend</span></div><div class="acct-stats"><div><span>High</span><b>${escapeHtml(acctCompact(Math.max(...vals)))}</b></div><div><span>Low</span><b>${escapeHtml(acctCompact(Math.min(...vals)))}</b></div><div><span>Trend change</span><b class="acct-${tone}">${change==null?'—':`${change>=0?'+':''}${escapeHtml(acctCompact(change))}`}</b></div></div>`;
}
function scmPatchParts(root,html){
  // Excel-style refresh: rebuild only when the card layout itself changed; otherwise replace just the
  // [data-acct-part] blocks whose HTML differs. Untouched blocks keep their DOM, focus and hover state.
  if(!root)return [];
  const tpl=document.createElement('template');tpl.innerHTML=html;
  const layout=[...tpl.content.querySelectorAll('[data-acct-part]')].map(e=>e.dataset.acctPart).join('|');
  if(root.__scmLayout!==layout){root.innerHTML=html;root.__scmLayout=layout;root.__scmParts={};root.querySelectorAll('[data-acct-part]').forEach(e=>{root.__scmParts[e.dataset.acctPart]=e.innerHTML;});return null;}
  const changed=[];
  for(const src of tpl.content.querySelectorAll('[data-acct-part]')){const k=src.dataset.acctPart;if(root.__scmParts[k]===src.innerHTML)continue;const dst=root.querySelector(`[data-acct-part="${CSS.escape(k)}"]`);if(!dst)continue;dst.innerHTML=src.innerHTML;root.__scmParts[k]=src.innerHTML;changed.push(k);}
  return changed;
}
function scmSetHTML(el,html){
  // Writes only when the section's HTML changed, so an unchanged section keeps its DOM between refreshes.
  if(!el||el.__scmHtml===html)return false;el.innerHTML=html;el.__scmHtml=html;return true;
}
function renderAccountingOverview(root,a,previous,history,series){
  if(!root)return;
  const changed=scmPatchParts(root,accountingOverview(a,previous));
  if(changed)for(const k of changed){const card=root.querySelector(`[data-acct-card="${CSS.escape(k)}"]`);if(card){card.classList.remove('acct-patched');void card.offsetWidth;card.classList.add('acct-patched');}}
  root.querySelectorAll('[data-acct-range]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.acctRange)===acctChartRange)));
  const data={history,series};
  // Nothing to hold yet (first draw, or no daily history drawn so far): draw straight away.
  if(changed===null||!acctChartDrawn?.hasData){acctChartPending=null;renderAccountingCharts(root,data);return;}
  if(acctChartTouching||acctChartOpenKey){
    if(accountingChartSignature(data)!==acctChartDrawn.sig){acctChartPending=data;acctChartPendingCount=(acctChartPendingCount||0)+1;}
    accountingChartPendingBar(root);return;
  }
  renderAccountingCharts(root,data);
}
function accountingChartSignature(data){return JSON.stringify(Object.keys(ACCT_CHART_FIELDS).map(k=>accountingChartPoints(data.history,data.series,k,acctChartRange)));}
function accountingChartPendingBar(root){
  const bar=root?.querySelector('[data-acct-pending]');if(!bar)return;
  // No bar while the popout is open: closing it applies the update, and the bar would shift the rows behind it.
  const n=acctChartPending&&!acctChartOpenKey?acctChartPendingCount:0;bar.hidden=!n;
  if(n)bar.querySelector('span').textContent=`${n} update${n===1?'':'s'} waiting while you look`;
}
function renderAccountingCharts(root,data){
  if(!root||!data)return;
  const sig=accountingChartSignature(data);
  for(const key of Object.keys(ACCT_CHART_FIELDS)){
    const box=root.querySelector(`[data-acct-chart="${key}"]`);if(!box)continue;
    const pts=accountingChartPoints(data.history,data.series,key,acctChartRange);
    const html=accountingSparkline(key,pts)+accountingChartFooter(key,pts);
    if(box.__scmHtml!==html){box.innerHTML=html;box.__scmHtml=html;}
    box.__acctPts=pts;
  }
  acctChartDrawn={sig,data,hasData:/\d/.test(sig)};acctChartPending=null;acctChartPendingCount=0;accountingChartPendingBar(root);
  root.querySelectorAll('[data-acct-open]').forEach(b=>b.setAttribute('aria-expanded',String(b.dataset.acctOpen===acctChartOpenKey)));
  const pop=acctPopEl(),wasOpen=!pop.hidden,focusRange=pop.contains(document.activeElement)?document.activeElement?.dataset?.acctRange:null;
  if(acctChartOpenKey&&root.querySelector(`[data-acct-card="${CSS.escape(acctChartOpenKey)}"]`)){
    const k=acctChartOpenKey;pop.innerHTML=accountingChartPop(k,accountingChartPoints(data.history,data.series,k,acctChartRange),acctChartRange);pop.hidden=false;document.body.classList.add('acct-pop-open');
    if(!wasOpen)pop.querySelector('[data-acct-close]')?.focus({preventScroll:true});
    else if(focusRange)pop.querySelector(`[data-acct-range="${CSS.escape(focusRange)}"]`)?.focus({preventScroll:true});
  }else if(wasOpen||pop.innerHTML){pop.hidden=true;pop.innerHTML='';document.body.classList.remove('acct-pop-open');}
}
function accountingChartFlush(){
  if(acctChartTouching||acctChartOpenKey||!acctChartPending)return;
  renderAccountingCharts(document.getElementById('accountingOverview'),acctChartPending);
}
function accountingChartTip(svg,clientX){
  const box=svg.closest('[data-acct-chart]');const pts=box?.__acctPts||[];if(!pts.length)return;
  const r=svg.getBoundingClientRect();if(!r.width)return;
  const t0=pts[0][0],t1=pts[pts.length-1][0];const at=t0+Math.min(1,Math.max(0,((clientX-r.left)/r.width*160-4)/152))*(t1-t0);
  let i=0;for(let j=1;j<pts.length;j++)if(Math.abs(pts[j][0]-at)<Math.abs(pts[i][0]-at))i=j;
  const [t,v]=pts[i],prev=i>0?pts[i-1][1]:null;
  const x=t1===t0?80:4+(t-t0)*152/(t1-t0);const cross=svg.querySelector('.acct-cross');if(cross){cross.setAttribute('x1',x.toFixed(1));cross.setAttribute('x2',x.toFixed(1));cross.classList.add('on');}
  let tip=box.querySelector('.acct-tip');if(!tip){tip=document.createElement('div');tip.className='acct-tip';box.appendChild(tip);}
  const d=prev==null?null:roundCurrencyUp(v-prev),pct=prev?d/Math.abs(prev)*100:null;
  const date=new Date(t).toLocaleDateString(undefined,{month:'short',day:'numeric'});
  tip.innerHTML=`<span>${escapeHtml(date)}</span><b>${escapeHtml(money(roundCurrencyUp(v)))}</b>${d==null?'<span class="acct-flat">First day</span>':`<span class="${acctChangeClass(box.dataset.acctChart,d)}">${d>0?'+':''}${escapeHtml(money(d))}${pct==null?'':` (${pct>0?'+':''}${pct.toFixed(2)}%)`}</span>`}`;
  // A readout wider than the row chart opens to the left, over the row's text, never off the screen.
  const left=x/160*r.width,max=r.width-tip.offsetWidth;tip.style.left=(max<0?max:Math.max(0,Math.min(max,left-tip.offsetWidth/2)))+'px';
}
function accountingChartTipEnd(svg){
  const box=svg?.closest?.('[data-acct-chart]');box?.querySelector('.acct-tip')?.remove();svg?.querySelector?.('.acct-cross')?.classList.remove('on');
  acctChartTouching=false;accountingChartFlush();
}
document.addEventListener('pointermove',e=>{const svg=e.target?.closest?.('[data-acct-spark]');if(!svg)return;acctChartTouching=true;accountingChartTip(svg,e.clientX);});
document.addEventListener('pointerdown',e=>{const svg=e.target?.closest?.('[data-acct-spark]');if(!svg)return;acctChartTouching=true;accountingChartTip(svg,e.clientX);});
document.addEventListener('pointerout',e=>{const svg=e.target?.closest?.('[data-acct-spark]');if(svg&&!svg.contains(e.relatedTarget))accountingChartTipEnd(svg);});
document.addEventListener('pointerup',e=>{if(e.pointerType==='mouse')return;const svg=e.target?.closest?.('[data-acct-spark]');if(svg)setTimeout(()=>accountingChartTipEnd(svg),1500);});
function accountingChartClose(){
  if(!acctChartOpenKey)return;const k=acctChartOpenKey;acctChartOpenKey=null;
  const root=document.getElementById('accountingOverview');renderAccountingCharts(root,acctChartPending||acctChartDrawn?.data);
  root?.querySelector(`[data-acct-open="${CSS.escape(k)}"]`)?.focus({preventScroll:true});
}
document.addEventListener('click',e=>{
  const root=document.getElementById('accountingOverview'),pop=document.getElementById('acctChartPop');
  const inPop=!!pop&&!pop.hidden&&pop.contains(e.target);if(!root||!(root.contains(e.target)||inPop))return;
  const range=e.target.closest('[data-acct-range]'),open=e.target.closest('[data-acct-open]'),close=e.target.closest('[data-acct-close]'),apply=e.target.closest('[data-acct-apply]');
  if(range){acctChartRange=Number(range.dataset.acctRange)||90;document.querySelectorAll('[data-acct-range]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.acctRange)===acctChartRange)));renderAccountingCharts(root,acctChartPending||acctChartDrawn?.data);}
  else if(open){acctChartOpenKey=open.dataset.acctOpen;renderAccountingCharts(root,acctChartPending||acctChartDrawn?.data);}
  else if(close||e.target===pop){accountingChartClose();}
  else if(apply){renderAccountingCharts(root,acctChartPending||acctChartDrawn?.data);}
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&acctChartOpenKey){e.preventDefault();accountingChartClose();}});

function renderFullSyncDiagnostics(s){
  // Diagnostic rendering is derived from the realm-scoped endpoint store and must never break the main render.
  const realm=Number(s.viewRealm??s.authData?.authCompany?.realmId??s.authData?.authCompany?.realm);
  const ep=s.endpointData&&typeof s.endpointData==='object'?s.endpointData:{};
  const endpointEntries=Object.entries(ep).filter(([,v])=>v&&typeof v==='object');
  const matches=(rx)=>endpointEntries
    .filter(([url])=>rx.test(String(url||'')))
    .sort((a,b)=>new Date(b[1]?.receivedAt||0)-new Date(a[1]?.receivedAt||0))
    .map(([url,v])=>({url,status:v?.status,receivedAt:v?.receivedAt||null}));
  const card=(id,status,detail,entries=[],copyType=null)=>{
    const el=document.querySelector('#'+id); if(!el)return;
    const ok=String(status||'').toUpperCase()==='CAPTURED';
    const list=Array.isArray(entries)?entries:[];
    el.innerHTML=`<div class="page-diag-summary"><span class="diag-status ${ok?'diag-ok':'diag-waiting'}">${escapeHtml(status||'WAITING')}</span><strong>${escapeHtml(detail||'')}</strong></div>${list.length?`<details><summary>${list.length} matching API endpoint${list.length===1?'':'s'}</summary><pre>${escapeHtml(JSON.stringify(list.slice(0,30),null,2))}</pre></details>`:''}${copyType?`<div class="diag-meta">Realm ${Number.isFinite(realm)?escapeHtml(realmName(realm)):'—'} · Raw response data is available through the Copy JSON button below.</div>`:''}`;
  };

  const vRows=Array.isArray(s.vwapData?.rows)?s.vwapData.rows.length:0;
  const vKeys=matches(/market|orders|orderbook|vwap/i);
  const hCount=Object.keys(s.history||{}).length;
  card('marketPageDiagnostics',vRows||vKeys.length?'CAPTURED':'WAITING',`${vRows||Object.keys(s.vwapData||{}).length} VWAP values · ${hCount} history series`,vKeys,'market-page');
}


async function loadBuildingPlannerData(){
  // Recipe inputs/transport and building outputs follow the game's constants (scmGameConstants) when
  // captured; the bundled files are the fallback. Rebuilt when the constants change.
  const gc=window.__scmState?.gameConstants||null,gcAt=String(gc?.at||'');
  if(window.__scmBuildingPlannerData&&window.__scmBuildingPlannerDataAt===gcAt)return window.__scmBuildingPlannerData;
  const load=async file=>{try{const r=await fetch(chrome.runtime.getURL(file));return await r.json();}catch{return null;}};
  if(!window.__scmBuildingPlannerRaw){const [buildings,recipes,rates]=await Promise.all([load('buildings.json'),load('recipes.json'),load('production_rates_normal.json')]);window.__scmBuildingPlannerRaw={buildings:Array.isArray(buildings)?buildings:[],recipes:Array.isArray(recipes)?recipes:[],rates:rates&&typeof rates==='object'?rates:{}};}
  const raw=window.__scmBuildingPlannerRaw,C=globalThis.SCM_TOOLS_CORE;
  const recipes=C?.recipesFromGameConstants?C.recipesFromGameConstants(raw.recipes,gc):raw.recipes;
  const buildings=C?.buildingsFromGameConstants?C.buildingsFromGameConstants(raw.buildings,recipes,gc):raw.buildings;
  window.__scmBuildingPlannerData={buildings,recipes,rates:raw.rates};window.__scmBuildingPlannerDataAt=gcAt;
  return window.__scmBuildingPlannerData;
}
function plannerNormalizeName(v){return globalThis.SCMPlannerCore?.normalizeName?globalThis.SCMPlannerCore.normalizeName(v):String(v??'').toLowerCase().replace(/[’']/g,'').replace(/[^a-z0-9]+/g,'').replace(/s$/,'');}
function plannerRecipeMap(recipes){const m=new Map();for(const r of recipes||[]){m.set(Number(r.id),r);m.set(plannerNormalizeName(r.name),r);}return m;}
function plannerCompanyAuthData(s){
  const direct=s?.authData?.authCompany;
  if(direct&&typeof direct==='object') return direct;
  const ep=s?.endpointData||{};
  const viewRealm=Number(s?.viewRealm); const entries=Object.entries(ep).filter(([url,v])=>/\/api\/v3\/companies\/auth-data\/?$/i.test(url)&&Number(v?.status)===200&&v?.data!=null&&(!Number.isFinite(viewRealm)||validRealmNumber(v?.captureRealm)==null||validRealmNumber(v?.captureRealm)===viewRealm));
  entries.sort((a,b)=>Date.parse(b[1]?.receivedAt||'')-Date.parse(a[1]?.receivedAt||''));
  const data=entries[0]?.[1]?.data;
  return data?.authCompany||data?.company||data||null;
}
function plannerCompanySalesModifier(s){
  const modifier=Number(plannerCompanyAuthData(s)?.salesModifier);
  return Number.isFinite(modifier)?Math.max(-99,Math.min(99,modifier)):null;
}

// Abundance % of a natural resource at a building (mines, oil rigs, quarries), from the game's
// /api/v2/companies/buildings/<id>/abundance/ — only resources the game lists there have one.
function plannerAbundancePct(s,buildingId,resourceId){const d=s?.endpointData?.[`/api/v2/companies/buildings/${Number(buildingId)}/abundance/`]?.data?.abundance;const v=Number(d?.[String(resourceId)]);return d&&Number.isFinite(v)?v:null;}
// Economy phase now. The game's own value (log / auth-data) is used as before; SimcoTools phase ranges only fill in when the game value is stale or missing.
function plannerAuthAt(s){
  const direct=s?.authData?.receivedAt??s?.authData?.capturedAt;if(direct)return direct;
  let best=null;for(const [url,e] of Object.entries(s?.endpointData||{})){if(/\/api\/v3\/companies\/auth-data\/?$/i.test(url)&&Number(e?.status)===200&&e?.receivedAt&&(!best||Date.parse(e.receivedAt)>Date.parse(best)))best=e.receivedAt;}
  return best;
}
function plannerPhaseInfo(s,now){
  const C=globalThis.SCM_TOOLS_CORE;if(!C?.economyPhaseNow)return null;
  const ranges=scmSimcoData(s,'simcoPhases');
  try{return C.economyPhaseNow({log:Array.isArray(s?.economyStateLog)?s.economyStateLog:[],authState:s?.authData?.temporals?.economyState,authAt:plannerAuthAt(s),simcoRanges:Array.isArray(ranges?.ranges)?ranges.ranges:null,simcoAt:ranges?.at,now:now??Date.now()});}catch{return null;}
}
function plannerEconomyNow(s){
  const log=Array.isArray(s?.economyStateLog)?s.economyStateLog:[];const a=Number(s?.authData?.temporals?.economyState);
  const game=log.length?Number(log[log.length-1].s):(Number.isFinite(a)?a:null);
  if(!Array.isArray(scmSimcoData(s,'simcoPhases')?.ranges))return game;
  const info=plannerPhaseInfo(s);
  return info&&info.source==='simcotools'&&info.state!=null?info.state:game;
}
function plannerRate(name,recipes,rates,s){
  const target=plannerNormalizeName(name);
  // Game constants: exact base rate for the current economy phase.
  try{const C=globalThis.SCM_TOOLS_CORE,ph=plannerEconomyNow(s),rec=(Array.isArray(recipes)?recipes:[]).find(r=>plannerNormalizeName(r?.name)===target);
    const b=ph!=null&&rec&&C?.gameBaseRate?C.gameBaseRate(s?.gameConstants,rec.id,ph):null;if(b>0)return {rate:b,source:'game constants'};}catch{}
  // Production-rate mapping is canonicalized by normalized resource name so
  // harmless capitalization differences (e.g. "Electronic components" vs
  // "Electronic Components") cannot silently remove a production rate.
  for(const [key,value] of Object.entries(rates||{})){
    if(plannerNormalizeName(key)!==target)continue;
    const direct=Number(value);
    if(Number.isFinite(direct)&&direct>0)return {rate:direct,source:'normal-economy reference'};
  }
  return {rate:null,source:'not available'};
}
// One production context per store snapshot: the same calculation the game-page overlay uses (planner-core.js).
function plannerProductionContext(s,rawBuildings,rates){
  const opts={realm:s?.viewRealm,buildings:rawBuildings,constants:s?.gameConstants,economyLog:s?.economyStateLog,normalRates:rates};
  const ev=scmSimcoData(s,'simcoEvents'),ph=scmSimcoData(s,'simcoPhases');
  opts.simcoEvents=ev&&typeof ev==='object'?ev:{events:null,at:null};if(ph&&typeof ph==='object')opts.simcoPhases=ph;
  return globalThis.SCMPlannerCore.productionContext(s,opts);
}
const __plannerBaseCtx={s:null,t:0,ctx:null};
function plannerBaseContext(s){
  const t=Math.floor(Date.now()/30000);
  if(__plannerBaseCtx.s===s&&__plannerBaseCtx.t===t&&__plannerBaseCtx.ctx)return __plannerBaseCtx.ctx;
  const ctx=plannerProductionContext(s,buildingArrayFromState(s),window.__scmBuildingPlannerData?.rates||null);
  Object.assign(__plannerBaseCtx,{s,t,ctx});
  return ctx;
}
// ---- SimcoTools context: production strip (Production tab) and company history card (Overview tab) ----
const SCM_CH_FIELDS=[['value','Company value','money'],['rank','Rank','rank'],['workers','Workers','count'],['buildingsValue','Building value','money']];
let __scmCompanyHistRange=30;
function scmUtcStamp(ms,withTime){const o=withTime?{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:'UTC'}:{month:'short',day:'numeric',timeZone:'UTC'};return new Date(ms).toLocaleString('en-US',o)+(withTime?' UTC':'');}
function scmAgoText(ms,now){const m=Math.max(0,Math.round(((now??Date.now())-ms)/60000));if(m<60)return `${m} min ago`;const h=Math.round(m/60);return h<48?`${h} h ago`:`${Math.round(h/24)} days ago`;}
function plannerPassiveAt(s){let best=0;for(const [url,e] of Object.entries(s?.endpointData||{})){if(/^\/api\/v2\/production-modifiers\/\d+\/?$/.test(url)&&Number(e?.status)===200){const t=Date.parse(String(e.receivedAt||''));if(t>best)best=t;}}return best||null;}
function renderProductionStrip(s,recipes,now){try{return scmProductionStripHtml(s,recipes,now);}catch(e){console.debug('production strip failed',e);return '';}}
function scmProductionStripHtml(s,recipes,now){
  now=now??Date.now();
  let ctx=null;try{ctx=plannerBaseContext(s);}catch{}
  const info=plannerPhaseInfo(s,now),simPh=scmSimcoData(s,'simcoPhases'),simEv=scmSimcoData(s,'simcoEvents');
  const chips=[],notes=[];
  if(info&&info.state!=null){
    const nm=String(info.name||'').replace(/^./,c=>c.toUpperCase());
    const until=info.endsAt?Date.parse(info.endsAt):NaN;
    chips.push(`<span class="ps-chip ps-phase ps-phase-${escapeHtml(String(info.name||'unknown').replace(/[^a-z0-9]/gi,''))}"${info.mismatch?' title="SimcoTools lists a different phase; the game page value is used."':''}>${escapeHtml(nm)}${Number.isFinite(until)?` until ${escapeHtml(scmUtcStamp(until,true))}`:' economy'}</span>`);
    notes.push(info.source==='simcotools'?'Phase from SimcoTools':'Phase from the game page');
    if(info.source==='game-stale'){const t=Date.parse(String(plannerAuthAt(s)||''));if(Number.isFinite(t))notes.push(`phase last update ${scmAgoText(t,now)}`);}
  }
  const past=(Array.isArray(simPh?.ranges)?simPh.ranges:[]).map(r=>({st:String(r?.phase||''),a:Date.parse(String(r?.start||'')),b:Date.parse(String(r?.end||''))})).filter(r=>['normal','boom','recession'].includes(r.st)&&Number.isFinite(r.a)&&Number.isFinite(r.b)&&r.b<=now).sort((x,y)=>y.b-x.b).slice(0,5);
  const pastHtml=past.map(r=>`<span class="ps-chip ps-past">${escapeHtml(r.st.replace(/^./,c=>c.toUpperCase()))} ${escapeHtml(scmUtcStamp(r.a))} – ${escapeHtml(scmUtcStamp(r.b))}</span>`).join('');
  const src=ctx?.modifierSource,events=[];
  if(src&&src!=='none'){
    const seen=new Set();
    for(const row of Array.isArray(ctx.modifierRows)?ctx.modifierRows:[]){
      const kind=Number(row?.kind);if(!(kind>0)||seen.has(kind))continue;
      const a=Date.parse(String(row?.since||'')),b=Date.parse(String(row?.until||''));
      if(Number.isFinite(a)&&now<a)continue;if(Number.isFinite(b)&&now>b)continue;
      const m=Number(row?.speedModifier);if(!Number.isFinite(m)||m===0)continue;
      seen.add(kind);
      const simName=(Array.isArray(simEv?.events)?simEv.events:[]).find(e=>Number(e?.resource)===kind)?.resourceName;
      let name=simName;if(!name){try{name=plannerResourceNameById(recipes,kind,s);}catch{}}
      const sign=m>0?'+':'−',abs=Math.abs(Math.round(m*100)/100);
      events.push(`<span class="ps-chip ps-event ${m>0?'ps-pos':'ps-neg'}">${escapeHtml(name||`#${kind}`)} <b>${sign}${escapeHtml(String(abs))}%</b>${Number.isFinite(b)?` until ${escapeHtml(scmUtcStamp(b))}`:''}</span>`);
    }
    notes.push(src==='simcotools'?'Events from SimcoTools':'Events from the game page');
    if(src==='game-stale'){const t=plannerPassiveAt(s);if(t)notes.push(`events last update ${scmAgoText(t,now)}`);}
  }
  if(!chips.length&&!pastHtml&&!events.length)return '';
  return `<div class="production-strip" id="productionStrip" aria-label="Economy phase and production events"><div class="ps-row">${chips.join('')}${events.join('')}</div>${pastHtml?`<div class="ps-row ps-past-row" aria-label="Past economy phases">${pastHtml}</div>`:''}${notes.length?`<div class="ps-note muted">${escapeHtml(notes.join(' · '))}</div>`:''}</div>`;
}
function companyHistorySpark(pts,tone){
  if(pts.length<2)return '<div class="acct-chart-empty">Needs 2 days</div>';
  const W=160,H=48,P=4,t0=pts[0][0],t1=pts[pts.length-1][0];
  let lo=Math.min(...pts.map(p=>p[1])),hi=Math.max(...pts.map(p=>p[1]));if(lo===hi){lo-=1;hi+=1;}
  const X=t=>P+(t-t0)*(W-2*P)/(t1-t0),Y=v=>H-P-(v-lo)*(H-2*P)/(hi-lo);
  const line=pts.map((p,i)=>(i?'L':'M')+X(p[0]).toFixed(1)+','+Y(p[1]).toFixed(1)).join('');
  const e=pts[pts.length-1],tr=accountingChartTrend(pts);
  const trend=tr?`<line class="acct-trend" x1="${X(t0).toFixed(1)}" y1="${Y(tr.at(t0)).toFixed(1)}" x2="${X(t1).toFixed(1)}" y2="${Y(tr.at(t1)).toFixed(1)}"/>`:'';
  return `<svg class="acct-spark ch-spark acct-${tone}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="trend"><path class="acct-area" d="${line}L${X(t1).toFixed(1)},${H}L${X(t0).toFixed(1)},${H}Z"/><path class="acct-line" d="${line}"/>${trend}<circle class="acct-dot" cx="${X(e[0]).toFixed(1)}" cy="${Y(e[1]).toFixed(1)}" r="2.4"/></svg>`;
}
function renderCompanyHistoryCard(s,now){
  now=now??Date.now();
  const co=scmSimcoData(s,'simcoCompany'),C=globalThis.SCM_TOOLS_CORE;
  const chHead=(x,sub)=>`<div class="overview-section-head"><div><h3>Company history</h3><span>${escapeHtml(sub)}</span></div>${x||''}</div>`;
  if(!co||typeof co!=='object'||!C?.companyHistorySeries)return '';
  if(co.notTracked)return `<div class="overview-section company-history-card" id="companyHistoryCard">${chHead('','Daily values')}<div class="overview-selling-empty">No SimcoTools history for this company yet.</div></div>`;
  const rows=Array.isArray(co.rows)?co.rows:[];if(!rows.length)return '';
  const range=__scmCompanyHistRange===100?100:30;
  const cells=SCM_CH_FIELDS.map(([f,label,kind])=>{
    const ser=C.companyHistorySeries(rows,f,range,now);if(ser.latest==null)return '';
    const fmt=v=>kind==='money'?acctCompact(v):kind==='rank'?'#'+num(Math.round(v)):num(Math.round(v));
    const ch=ser.change;let tone='flat';if(ch){const better=ser.better==='down'?ch<0:ch>0;tone=better?'good':'bad';}
    let chg='—';
    if(ch!=null){
      if(kind==='rank')chg=ch===0?'no change':`${ch<0?'▲':'▼'} ${num(Math.abs(Math.round(ch)))} places`;
      else chg=`${ch>0?'▲':ch<0?'▼':'—'} ${ch>0?'+':''}${fmt(ch).replace(/^#/,'')}${ser.changePct==null?'':` · ${ser.changePct>0?'+':''}${ser.changePct.toFixed(1)}%`}`;
    }
    const pts=ser.points.map(p=>[p.t,p.v]);
    return `<div class="overview-stat-card ch-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(fmt(ser.latest))}</strong><small class="ch-chg acct-${tone}">${escapeHtml(chg)}</small>${companyHistorySpark(pts,tone)}</div>`;
  }).filter(Boolean).join('');
  if(!cells)return '';
  const at=Date.parse(String(co.at||'')),ago=Number.isFinite(at)?` · updated ${scmAgoText(at,now)}`:'';
  const btn=n=>`<button type="button" class="acct-range-btn" data-ch-range="${n}" aria-pressed="${range===n}">${n} days</button>`;
  return `<div class="overview-section company-history-card" id="companyHistoryCard">${chHead(`<div class="acct-range ch-ranges">${btn(30)}${btn(100)}</div>`,`Daily values · last ${range} days`)}<div class="overview-stat-grid ch-grid">${cells}</div><div class="ch-note muted">Public data from SimcoTools${escapeHtml(ago)}</div></div>`;
}
document.addEventListener('click',e=>{const b=e.target.closest?.('[data-ch-range]');if(!b)return;__scmCompanyHistRange=Number(b.dataset.chRange)===100?100:30;const host=document.getElementById('companyHistoryCard');const st=window.__scmState;if(host&&st){const t=document.createElement('div');t.innerHTML=renderCompanyHistoryCard(st);if(t.firstElementChild)host.replaceWith(t.firstElementChild);}});
// Active production event (%) of a resource, from the game's production-modifiers rows only.
function plannerEventPct(s,resourceId,atMs){return globalThis.SCMPlannerCore.activeResourceProductionModifier(plannerBaseContext(s).modifierRows,Number(resourceId),atMs??Date.now())||0;}
// Company production modifier plus the recreation bonus: the bonus the game divides every rate by.
function plannerBonusPct(s){const c=plannerBaseContext(s);return (Number(c.companyModifier)||0)+(Number(c.recreationBonus)||0);}
const plannerHistoryAudit = new Map();
function plannerHistoryAuditKey(realm, buildingId, product){return `${Number(realm)||0}:${Number(buildingId)||0}:${plannerNormalizeName(product)}`;}
function plannerHistoryAuditExport(){return [...plannerHistoryAudit.values()].sort((a,b)=>a.buildingId-b.buildingId||a.product.localeCompare(b.product)).map(x=>({...x}));}
function productionHistoryComparisonExport(store){
  const endpoints=Object.entries(store?.endpointData||{}).filter(([url])=>/^\/api\/v2\/companies\/buildings\/\d+\/history\//.test(url)).map(([url,value])=>{
    const match=url.match(/buildings\/(\d+)\/history/);const rows=Array.isArray(value?.data)?value.data:[];const timestamps=rows.map(r=>Date.parse(String(r?.datetime||r?.started||r?.timestamp||''))).filter(Number.isFinite);return {url,buildingId:match?Number(match[1]):null,status:Number(value?.status)||null,captureRealm:value?.captureRealm??null,receivedAt:value?.receivedAt||null,rowCount:rows.length,latestHistoryAt:timestamps.length?new Date(Math.max(...timestamps)).toISOString():null,rows:rows.slice(-50)};
  });
  const buildings=(Array.isArray(store?.buildings)?store.buildings:[]).map(b=>{const id=Number(b?.id),path=`/api/v2/companies/buildings/${id}/history/`,ep=store?.endpointData?.[path],rows=Array.isArray(ep?.data)?ep.data:[],busy=b?.busy||{};const resourceId=Number(busy?.resource?.kind??busy?.resource?.resourceId);const productName=String(busy?.resource?.name||'').trim().toLowerCase();const candidates=rows.filter(r=>{const rid=Number(r?.kind);const name=String(r?.resourceName||r?.name||'').trim().toLowerCase();const amount=Number(r?.outputAmount??r?.amount);return amount>0&&(!Number.isFinite(resourceId)||resourceId<=0||rid===resourceId)&&(!productName||!name||name===productName)});candidates.sort((a,b)=>Date.parse(String(b?.datetime||''))-Date.parse(String(a?.datetime||'')));return {buildingId:id,buildingName:String(b?.name||''),product:String(busy?.resource?.name||''),resourceId:Number.isFinite(resourceId)?resourceId:null,cycleStarted:busy?.started||null,historyEndpointPresent:Boolean(ep),historyStatus:Number(ep?.status)||null,historyRows:rows.length,matchingHistoryRows:candidates.length,latestMatch:candidates[0]||null,historyRequestAt:ep?.receivedAt||null};});
  return {capturedAt:new Date().toISOString(),buildingCount:buildings.length,historyEndpointCount:endpoints.length,buildings,endpoints};
}
function plannerRecordHistoryAudit(building,name,s,details={}){
  const raw=building?.raw||building||{}; const id=Number(raw?.id??building?.id); const realm=Number(s?.viewRealm??s?.captureRealm);
  if(!Number.isFinite(id)||id<=0)return;
  const busy=busyObject(raw)||raw?.busy||{}; const path=`/api/v2/companies/buildings/${id}/history/`; const endpoint=s?.endpointData?.[path];
  const row=globalThis.SCMPlannerCore.matchRunHistoryRow(raw,endpoint?.data);
  const key=plannerHistoryAuditKey(realm,id,name); const prior=plannerHistoryAudit.get(key)||{};
  plannerHistoryAudit.set(key,{realm:Number.isFinite(realm)?realm:null,buildingId:id,buildingName:String(building?.name||raw?.name||''),product:String(name||''),resourceId:Number(busy?.resource?.kind??busy?.resource?.resourceId)||null,cycleStarted:String(busy?.started||''),historyEndpointPresent:!!endpoint,historyHttpStatus:Number(endpoint?.status)||null,historyCaptureRealm:validRealmNumber(endpoint?.captureRealm),matchedCurrentCycle:!!row,matchedAmount:row?Number(row.outputAmount??row.amount):null,matchedDurationSeconds:row?Number(busy?.duration)||null:null,selectedRateSource:details.source??prior.selectedRateSource??null,fallbackReason:details.fallbackReason??prior.fallbackReason??null,historyRequestStatus:prior.historyRequestStatus??'not-requested',historyRequestAt:prior.historyRequestAt??null,lastEvaluatedAt:new Date().toISOString()});
}
function plannerSetHistoryRequestAudit(realm,buildingId,product,status,error=null){
  const key=plannerHistoryAuditKey(realm,buildingId,product); const prior=plannerHistoryAudit.get(key)||{realm,buildingId:Number(buildingId),product:String(product||'')};
  plannerHistoryAudit.set(key,{...prior,historyRequestStatus:status,historyRequestError:error?String(error).slice(0,240):null,historyRequestAt:new Date().toISOString()});
}
// The building's game rate for a product, from the shared core (planner-core.js resolveBuildingRate). The running
// product gives the run's own rate; any other product gives the next-run formula rate at the given level.
// result = the core's full answer (ratePerHour, locked, eventPct, bonusPct, nextRun ...); nextRun = the next-run rate
// of the asked product (the core's own for the running product, the formula for another).
function plannerRateForProduct(name,building,level,recipes,rates,s,ctx){
  const core=globalThis.SCMPlannerCore,raw=building?.raw||building||{};
  const recipe=(Array.isArray(recipes)?recipes:[]).find(r=>plannerNormalizeName(r?.name)===plannerNormalizeName(name));
  const c=ctx||plannerProductionContext(s,buildingArrayFromState(s),rates);
  const productId=Number(recipe?.id);
  const result=core.resolveBuildingRate(raw,c,{identity:{productId,product:String(name||''),quality:Number(building?.currentQuality)||0}});
  const same=Boolean(result.running)&&productId>0&&Number(result.productId)===productId;
  const lvl=Math.max(1,Number(level)||1);
  let nextRun=same?result.nextRun:null;
  if(!same&&productId>0){
    const f=core.formulaRatePerLevel(c,{productId,product:String(name||''),buildingId:Number(raw?.id??building?.id),eventAtMs:c.now});
    nextRun=f?{ratePerHour:f.perLevel*lvl,perLevel:f.perLevel,level:lvl,eventPct:f.eventPct,bonusPct:f.bonusPct,abundancePct:f.abundancePct,phase:f.phase,source:f.source}:null;
  }
  const out=same?{rate:result.ratePerHour,source:result.sourceLabel}:(nextRun?{rate:nextRun.ratePerHour,source:`next run (${nextRun.source})`}:{rate:null,source:'not available'});
  plannerRecordHistoryAudit(building,name,s,{source:out.source,fallbackReason:same&&result.source==='game-formula'?'no history row of the current run; game formula estimate':null});
  return {...out,same,result,nextRun};
}
function plannerAssetUrl(image){
  const candidates=imageCandidates(image).filter(candidate=>!isKnown404ResourceImage(candidate));
  return candidates[0]||'';
}
function plannerResourceImage(id,s){
  const info=resourceInfo({kind:Number(id)},s);
  if(!info.imageCandidates.length && Number.isFinite(Number(id))) requestResourceImage(Number(id));
  return info.imageCandidates[0]||'';
}
function plannerImage(src,alt,cls='planner-icon',fallback='•'){
  return scmSafeImgSrc(src)?`<img class="${cls}" src="${escapeHtml(scmSafeImgSrc(src))}" alt="${escapeHtml(alt)}" loading="lazy" data-scm-hide-on-error="1" data-scm-fallback-text="${escapeHtml(fallback)}">`:`<span class="${cls} planner-icon-fallback" title="${escapeHtml(alt)}">${escapeHtml(fallback)}</span>`;
}
function plannerResourceNameById(recipes,id,s){
  const r=(recipes||[]).find(x=>Number(x.id)===Number(id));
  if(r?.name)return r.name;
  return resourceName({_id:Number(id),kind:Number(id)},s);
}
function plannerMoney(v){return v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?money(Number(v)):'—';}
// KindOverrides {buildingId: buildings.json kind}: a planner-only "what if this building were X" test.
// The test building keeps its id and level but drops the game's busy/plan/image/cost data of the real
// building, so nothing measured for the real building is reused for the test kind. Reset removes the override.
function ownedPlannerBuildings(s, definitions, kindOverrides={}){
  const actual=buildingArrayFromState(s);
  const byKind=new Map((definitions||[]).map(b=>[String(b.id),b]));
  return actual.map((gameRaw,index)=>{
    const gameKind=String(pick(gameRaw,['kind','buildingKind','type'])??'');
    const testKind=String(kindOverrides?.[String(pick(gameRaw,['id','buildingId'])??index)]||'');
    const isTest=Boolean(testKind)&&testKind!==gameKind&&byKind.has(testKind);
    const raw=isTest?{id:pick(gameRaw,['id','buildingId'])??index,kind:testKind,level:pick(gameRaw,['level','lvl','buildingLevel','size']),size:gameRaw?.size,category:gameRaw?.category,scmTestKind:true}:gameRaw;
    const kind=isTest?testKind:gameKind;
    const def=byKind.get(kind)||null;
    const levelRaw=Number(pick(raw,['level','lvl','buildingLevel','size']));
    const level=Number.isFinite(levelRaw)&&levelRaw>0?Math.min(20,levelRaw):1;
    const name=isTest?String(def.name):buildingName(raw,s);
    const category=def?.category || (String(pick(raw,['category'])||'').toLowerCase()==='other'?'Other':'Uncategorized');
    const produces=Array.isArray(def?.produces)?def.produces:[];
    const pinned=pick(raw,['pinnedResource']);
    const specialization=pick(raw,['robotsSpecialization']);
    const expanding=buildingIsExpanding(isTest?gameRaw:raw),expandFinish=expanding?buildingExpandFinish(gameRaw):null;
    const busy=expanding?null:(raw?.busy?.resource||null);
    const idKey=String(pick(raw,['id','buildingId'])??index);
    // A plan saved for another kind (a test kind, or the game kind while testing) is not this building's plan.
    const kindOk=p=>p&&(p.kind==null||String(p.kind)===kind)?p:null;
    const plan=isTest?null:kindOk(s?.productionPlans?.[idKey]||null);
    const currentResource=busy?.name||plan?.product||null;
    const currentResourceId=Number.isFinite(Number(busy?.kind))?Number(busy.kind):Number.isFinite(Number(plan?.resourceId))?Number(plan.resourceId):null;
    const pinnedResource=Number.isFinite(Number(pinned))?Number(pinned):null;
    const robotsSpecialization=Number.isFinite(Number(specialization))?Number(specialization):null;
    const currentQuality=Number.isFinite(Number(busy?.quality))?Number(busy.quality):Number.isFinite(Number(plan?.quality))?Number(plan.quality):null;
    return {raw,index,id:pick(raw,['id','buildingId'])??index,kind,name,category,level,produces,pinnedResource,currentResource,currentResourceId,robotsSpecialization,currentQuality,productionPlan:plan||null,expanding,expandFinish,testKind:isTest,gameKind,gameName:isTest?buildingName(gameRaw,s):name};
  });
}
function plannerCurrentProduct(building, recipes){
  const stored=building?.productionPlan||null;const produces=Array.isArray(building?.produces)?building.produces:[];const findByName=name=>{if(!name)return null;return produces.find(p=>plannerNormalizeName(p)===plannerNormalizeName(name))||null;};const storedProduct=findByName(stored?.product);if(storedProduct)return storedProduct;const liveByName=findByName(building?.currentResource);if(liveByName)return liveByName;const recipeById=new Map((recipes||[]).map(r=>[Number(r.id),r]));const byId=id=>{const n=Number(id);if(!Number.isFinite(n))return null;return findByName(recipeById.get(n)?.name);};for(const id of [building?.currentResourceId,building?.pinnedResource,building?.robotsSpecialization]){const p=byId(id);if(p)return p;}return produces[0]||'';}
function plannerBuildingIcon(category){
  const c=String(category||'').toLowerCase();
  if(c.includes('energy')) return '⚡';
  if(c.includes('agriculture')) return '🌾';
  if(c.includes('food')) return '🍴';
  if(c.includes('construction')) return '🏗️';
  if(c.includes('automotive')) return '🚗';
  if(c.includes('aerospace')) return '🚀';
  if(c.includes('electronics')) return '🔌';
  if(c.includes('resources')) return '⛏️';
  if(c.includes('fashion')) return '👗';
  return '🏭';
}
// Identity plans for the shared network: which product, quality and level each building is meant to make. They never
// carry a rate; the core takes every rate from the building's real run.
function plannerBuildPlans(owned,ui,planningLevels,productOverrides){
  const plans={};
  for(const b of Array.isArray(owned)?owned:[]){
    const id=String(b.id),ovr=(b.produces||[]).includes(productOverrides?.[id])?productOverrides[id]:'';
    const planner=b.testKind||(ui?.planModes||{})[id]==='planner';
    const product=String(ovr||(b.testKind?(b.produces?.[0]||''):(b.currentResource||''))).trim();
    if(!product)continue;
    const qRaw=planner?ui?.qualityByBuilding?.[id]:null;
    const quality=Math.max(0,qRaw!=null&&Number.isFinite(Number(qRaw))?Number(qRaw):(Number(b.currentQuality)||0));
    plans[id]={buildingId:Number(b.id),product,quality,plannedLevel:Math.min(20,Math.max(1,Number(planningLevels?.[id])||Number(b.level)||1)),mode:(ui?.planModes||{})[id]||'live'};
  }
  return plans;
}
// The production network of all owned buildings, from the shared core. Game figures only; what-ifs appear as `planned`.
function plannerProductionNetwork(s,owned,recipes,rates,runHours,overrides={}){
  const core=globalThis.SCMPlannerCore,raws=(Array.isArray(owned)?owned:[]).map(b=>b.raw);
  const ctx=overrides.ctx||plannerProductionContext(s,raws,rates);
  const resourceNames=new Map((recipes||[]).map(r=>[String(r.id),r.name]));
  const net=core.buildNetwork({buildings:raws,plans:overrides.plans||s?.productionPlans||{},recipes,hours:runHours,ctx,resourceNames});
  return {...net,ctx};
}
// The game's own upgrade cost (GamePages bundle: amount = perCostUnit × building costUnits × current level,
// per level step). costUnits comes from /api/v2/constants/buildings/; perCostUnit is the game client's table
// (not served by any API). baseQty × cost ÷ 10350 is the fallback estimate, used only when the constants are missing.
const CONSTRUCTION_MATERIALS=[
  {id:101,name:'Reinforced concrete',perCostUnit:4,baseQty:12,referencePrice:166.66},
  {id:102,name:'Bricks',perCostUnit:55,baseQty:165,referencePrice:2.16},
  {id:108,name:'Planks',perCostUnit:16,baseQty:48,referencePrice:9.08},
  {id:111,name:'Construction units',perCostUnit:1,baseQty:3,referencePrice:2501.71}
];
function constructionCostUnits(s,building){const k=String(building?.raw?.kind??building?.kind??'');const bc=k?globalThis.SCM_TOOLS_CORE?.buildingConst?.(s?.gameConstants,(typeof scmSimcoData==='function'?scmSimcoData(s,'simcoBuildings'):(s?.simcoBuildings||null)),k):null;const cu=Number(bc?.costUnits);return k&&cu>0?cu:null;}
function constructionWarehouseStock(s,id){
  return warehouseRows(s).filter(row=>Number(row?._id)===Number(id)).reduce((sum,row)=>sum+(Number(row?._qty)||0),0);
}
function constructionMaterialPlan(s,building,currentLevel,targetLevel,discount){
  const current=Math.min(20,Math.max(1,Number(currentLevel)||1));
  const target=Math.min(20,Math.max(1,Number(targetLevel)||current));
  if(target<=current) return {current,target,stepFactor:0,items:[],deficitItems:[],totalCost:0};
  const costUnits=constructionCostUnits(s,building);
  const baseCost=Number(building?.raw?.cost);
  if(costUnits==null&&(!Number.isFinite(baseCost)||baseCost<=0)) return {current,target,stepFactor:0,items:[],deficitItems:[],totalCost:0,unavailable:true};
  const stepFactor=((target-current)*(current+target-1))/2;
  const scale=costUnits!=null?null:baseCost/10350;
  const items=CONSTRUCTION_MATERIALS.map(mat=>{
    const required=roundResourceDown(costUnits!=null?mat.perCostUnit*costUnits*stepFactor:mat.baseQty*scale*stepFactor,3);
    // Warehouse coverage is quality-agnostic. Every stored unit counts toward
    // the construction requirement regardless of its quality level. Keep ALL
    // required material rows here so multi-building aggregation can sum the
    // full requirement before warehouse stock is applied once.
    const warehouseQty=constructionWarehouseStock(s,mat.id);
    const amount=Math.max(0,roundResourceDown(required-warehouseQty,3));
    const marketRef=scmMarketPrice(s,mat.id,0,'exact');const marketPrice=marketRef?.price??null,marketPriceSrc=scmSrcLabel(marketRef);
    const rawPrice=marketPrice!=null?Number(marketPrice):null;
    const pct=globalThis.SCMPlannerCore?.clampDiscount?globalThis.SCMPlannerCore.clampDiscount(discount):Math.min(10,Math.max(0,Number(discount)||0));
    const price=rawPrice==null?null:(globalThis.SCMPlannerCore?.discountedUnitPrice?globalThis.SCMPlannerCore.discountedUnitPrice(rawPrice,pct):roundCurrencyUp(rawPrice*(1-pct/100)));
    const lineTotal=price!=null&&Number.isFinite(price)?roundCurrencyUp(price*amount):null;
    return {...mat,required,warehouseQty,amount,quality:0,marketPrice,marketPriceSrc,price,lineTotal};
  });
  const deficitItems=items.filter(x=>x.amount>0);
  const totalCost=roundCurrencyUp(deficitItems.reduce((sum,x)=>sum+(x.lineTotal!=null?Number(x.lineTotal)||0:0),0));
  const missingPrice=deficitItems.filter(x=>x.price==null).length;
  return {current,target,stepFactor,items,deficitItems,totalCost,missingPrice,costUnits,source:costUnits!=null?'game-constants':'cost-estimate'};
}
// Construction totals never count a missing price as $0: priced lines are summed, unpriced lines are counted and flagged.
function constructionMissingCount(items){return (items||[]).filter(x=>Number(x?.amount??x?.buy)>0&&!(Number(x?.price)>=0&&x?.price!=null)).length;}
function constructionMissingText(n){return n>0?`${n} material price${n===1?'':'s'} missing, total incomplete`:'';}
function plannerDiscountPercent(value){return globalThis.SCMPlannerCore?.clampDiscount?globalThis.SCMPlannerCore.clampDiscount(value):Math.min(10,Math.max(0,Number(value)||0));}
function plannerDiscountQuote(s,x,type,discount){const q=qualityForPlannerResource(x,type);const amount=type==='deficit'?Number(x.deficit)||0:Number(x.surplus)||0;const reference=scmMarketPrice(s,x.id,q,'exact');const marketPrice=reference?.price??null;const pct=plannerDiscountPercent(discount);const unitPrice=marketPrice!=null?roundCurrencyUp(marketPrice*(1-pct/100)):null;const total=unitPrice!=null&&amount>0?roundCurrencyUp(unitPrice*amount):null;return {id:Number(x.id),name:x.name,quality:q,amount,marketPrice,marketPriceQuality:reference?.quality??null,marketPriceExact:reference?.exact??false,marketPriceStale:Boolean(reference?.stale),marketPriceSrc:scmSrcLabel(reference),discount:pct,unitPrice,total,type,key:`${Number(x.id)}:${Number(q)}`};}
function qualityForPlannerResource(x,type){if(Number.isFinite(Number(x?.quality)))return Number(x.quality);if(type==='deficit'){const qs=Array.isArray(x?.minQuality)?x.minQuality.map(Number).filter(Number.isFinite):[];return qs.length?Math.max(...qs):0;}const qs=(x?.productionByQuality||[]).map(v=>Number(v?.quality)).filter(Number.isFinite);return qs.length?Math.max(...qs):0;}
async function ensurePlannerCompanyModifiers(s){
  const company=plannerCompanyAuthData(s)||{};
  const hasProduction=Number.isFinite(Number(company.productionModifier));
  const hasSales=Number.isFinite(Number(company.salesModifier));
  if(hasProduction&&hasSales) return s;
  if(plannerModifierFetchPending) return s;
  const realm=Number(s?.viewRealm??s?.captureRealm??s?.authData?.authCompany?.realmId);
  if(!Number.isFinite(realm)) return s;
  plannerModifierFetchPending=true;
  try{
    const result=await chrome.runtime.sendMessage({type:'GET_COMPANY_AUTH_DATA',realm});
    if(result?.ok){
      const refreshed=await get();
      const refreshedCompany=plannerCompanyAuthData(refreshed)||{};
      if(Number.isFinite(Number(refreshedCompany.productionModifier))||Number.isFinite(Number(refreshedCompany.salesModifier))) return refreshed;
    }
  }catch{}
  finally{plannerModifierFetchPending=false;}
  return s;
}
// One history request per building and run in this page session, and only when no row of the run is stored yet.
const plannerHistoryAsked=new Set();
function requestPlannerBuildingHistory(building,s){
  const core=globalThis.SCMPlannerCore;
  const realm=Number(s?.viewRealm);
  const id=Number(building?.id);
  const raw=building?.raw;
  const product=String(building?.currentResource||'').trim();
  if(!Number.isFinite(realm)||!Number.isFinite(id)||id<=0||!raw?.busy||!core?.buildingRun(raw))return;
  const path=`/api/v2/companies/buildings/${id}/history/`;
  const endpoint=s?.endpointData?.[path];
  const endpointRealm=validRealmNumber(endpoint?.captureRealm);
  const sameRealm=endpointRealm==null||endpointRealm===realm;
  const ok=endpoint&&sameRealm&&Number(endpoint.status)>=200&&Number(endpoint.status)<300;
  if(ok&&core.matchRunHistoryRow(raw,endpoint.data)){plannerSetHistoryRequestAudit(realm,id,product,'not-needed-current-cycle-matched');return;}
  const key=`${realm}:${id}:${String(raw.busy.started||'')}`;
  if(plannerHistoryAsked.has(key)){plannerSetHistoryRequestAudit(realm,id,product,'already-requested-for-this-run');return;}
  plannerHistoryAsked.add(key); plannerSetHistoryRequestAudit(realm,id,product,'requested');
  Promise.resolve().then(()=>chrome.runtime.sendMessage({type:'FETCH_BUILDING_HISTORY',realm,buildingId:id}))
    .then(result=>plannerSetHistoryRequestAudit(realm,id,product,result?.ok?'success':(result?.skipped?'skipped':'failed'),result?.error||null))
    .catch(error=>plannerSetHistoryRequestAudit(realm,id,product,'failed',error?.message||String(error)));
}
function showBuildingUpgradeProjection(host,ctx){
  const existing=document.getElementById('scm-upgrade-projection');
  if(existing) existing.remove();
  const {building,plan,discount}=ctx||{};
  if(!building||!plan)return;
  const current=Number(plan.current)||Number(building.level)||1;
  const target=Number(plan.target)||current;
  const scale=Number(building?.raw?.cost)/10350;
  const costUnits=Number(plan.costUnits)>0?Number(plan.costUnits):null;
  const materials=CONSTRUCTION_MATERIALS.map(mat=>{
    // Same game formula as constructionMaterialPlan (costUnits from the game's constants).
    const required=roundResourceDown(costUnits!=null?mat.perCostUnit*costUnits*Number(plan.stepFactor||0):Number(mat.baseQty)*scale*Number(plan.stepFactor||0),3);
    const warehouse=constructionWarehouseStock(ctx.state,mat.id);
    const buy=Math.max(0,roundResourceDown(required-warehouse,3));
    const item=plan.items.find(x=>Number(x.id)===Number(mat.id));
    const marketPrice=item?.marketPrice!=null?Number(item.marketPrice):null;
    const pct=globalThis.SCMPlannerCore?.clampDiscount?globalThis.SCMPlannerCore.clampDiscount(discount):Math.min(10,Math.max(0,Number(discount)||0));
    const price=marketPrice!=null&&Number.isFinite(marketPrice)?roundCurrencyUp(marketPrice*(1-pct/100)):null;
    return {...mat,required,warehouse,buy,marketPrice,marketPriceSrc:item?.marketPriceSrc||'',price,lineTotal:Number.isFinite(price)?roundCurrencyUp(price*buy):null};
  });
  const buyRows=materials.filter(x=>x.buy>0);
  const total=roundCurrencyUp(buyRows.reduce((a,x)=>a+(x.lineTotal!=null?Number(x.lineTotal)||0:0),0));
  const missingN=buyRows.filter(x=>x.price==null).length,missingMsg=constructionMissingText(missingN);
  const esc2=escapeHtml;
  const num2=v=>Number.isFinite(Number(v))?Number(v).toLocaleString(undefined,{maximumFractionDigits:0}):'—';
  const money2=v=>Number.isFinite(Number(v))?money(Number(v)):'—';
  const buyText=buyRows.length?`==============================\n🔽🔽🔽 BUYING -${Math.min(10,Math.max(0,Number(discount)||0))}% MARKET 🔽🔽🔽\n\n${buyRows.map(x=>`➡️ ${num2(x.buy)} - ${x.name} :re-${Number(x.id)}: - ${money2(x.price)}${x.price!=null&&x.marketPriceSrc?` (${x.marketPriceSrc})`:''}`).join('\n')}\n\n==============================`:'==============================\nNo additional construction materials required.\n==============================' ;
  const overlay=document.createElement('div');overlay.id='scm-upgrade-projection';overlay.className='scm-upgrade-projection';overlay.innerHTML=`<div class="scm-upgrade-backdrop" data-close-upgrade></div><section class="scm-upgrade-dialog" role="dialog" aria-modal="true" aria-label="Building upgrade projection"><header class="scm-upgrade-head"><div><div class="scm-upgrade-kicker">BUILDING UPGRADE PROJECTION</div><h3>${esc2(building.name||'Building')}</h3><div class="scm-upgrade-level">Current Level: ${current} <span>→</span> Upgrade to Level ${target}</div></div><button type="button" class="scm-upgrade-close" data-close-upgrade aria-label="Close">×</button></header><div class="scm-upgrade-rule"></div><div class="scm-upgrade-grid"><div class="scm-upgrade-panel"><div class="scm-upgrade-label">Level Change</div><strong>${current} → ${target}</strong><small>Construction projection for this building</small></div><div class="scm-upgrade-panel"><div class="scm-upgrade-label">Estimated Material Cost</div><strong id="scm-upgrade-total">${money2(total)}</strong><small>Buying ${Math.min(10,Math.max(0,Number(discount)||0))}% below Market Price</small>${missingMsg?`<small class="planner-missing-prices" id="scm-upgrade-missing" role="status">${esc2(missingMsg)}</small>`:''}</div></div><div class="scm-upgrade-section"><div class="scm-upgrade-section-title">Materials Needed</div><div class="scm-upgrade-materials">${materials.map(x=>`<div class="scm-upgrade-row"><span>➡️ ${num2(x.required)} - ${esc2(x.name)} :re-${Number(x.id)}:</span><strong>${num2(x.required)}</strong></div>`).join('')}</div></div><div class="scm-upgrade-section"><div class="scm-upgrade-section-title">Warehouse Coverage</div><div class="scm-upgrade-materials">${materials.map(x=>`<div class="scm-upgrade-row"><span>${esc2(x.name)}</span><strong>${num2(Math.min(x.warehouse,x.required))} / ${num2(x.required)} ${x.warehouse>=x.required?'✓':''}</strong></div>`).join('')}</div></div><div class="scm-upgrade-section"><div class="scm-upgrade-section-title">Remaining to Buy</div><div class="scm-upgrade-materials">${buyRows.length?buyRows.map(x=>`<div class="scm-upgrade-row"><span>➡️ ${num2(x.buy)} - ${esc2(x.name)} :re-${Number(x.id)}: - ${money2(x.price)}</span><strong>${money2(x.lineTotal)}</strong></div>`).join(''):'<div class="scm-upgrade-empty">Warehouse covers all required construction materials.</div>'}</div></div><div class="scm-upgrade-rule"></div><div class="scm-upgrade-actions"><button type="button" class="planner-copy-btn" data-copy-upgrade>📋 Copy Buy Message</button><button type="button" class="planner-copy-btn" data-close-upgrade>Close</button></div></section>`;
  document.body.appendChild(overlay);
  const close=()=>overlay.remove();
  overlay.querySelectorAll('[data-close-upgrade]').forEach(x=>x.addEventListener('click',close));
  overlay.querySelector('[data-copy-upgrade]')?.addEventListener('click',async()=>{
    try{await navigator.clipboard.writeText(buyText);const b=overlay.querySelector('[data-copy-upgrade]');if(b){const old=b.textContent;b.textContent='✓ Copied';setTimeout(()=>b.textContent=old,1200);}}catch{}
  });
}


// Profit / h / level inside the building card. Uses the card's own data: the measured
// production/hour for the planning level, the recipe's per-unit inputs at the input quality the card
// shows (production quality − 1), and current market prices (VWAP when no market price is captured).
const PLANNER_PROFIT_KEY='scmPlannerProfitSettingsV1';
const __plannerProfitLast={};
function plannerProfitSettings(){let v={};try{v=JSON.parse(localStorage.getItem(PLANNER_PROFIT_KEY)||'{}')||{};}catch{}return {inputSource:'warehouse',sellMode:'exchange',exchangeFeePct:'',contractDiscountPct:0,adminOverheadPct:'',wages:{},...v,wages:{...(v.wages||{})}};}
function savePlannerProfitSettings(v){try{localStorage.setItem(PLANNER_PROFIT_KEY,JSON.stringify(v));}catch{}}
// Price resolvers that match the game's own Profit Calculator.
// Market: the captured exchange order book first (cheapest listing at the exact quality when selling,
// at that quality or better when buying inputs), then captured current market prices, then VWAP.
// Warehouse: your actual sourcing cost per unit for the lowest stocked quality that satisfies the input.
function plannerAge(ms){const m=Math.round(ms/60000);return m<1?'just now':m<60?`${m} min ago`:m<1440?`${Math.round(m/60)} h ago`:`${Math.round(m/1440)} d ago`;}
// Shared source (market-core): mode 'any' = cheapest listing of any quality (the game calculator rule), 'min' = required quality or
// better (bought inputs, make-or-buy, run-out, transport), 'exact' = that quality only. Returns {price,quality,source:text,stale}.
function plannerMarketPrice(s,id,q,mode){
  const p=scmMarketPrice(s,id,q,mode==='any'||mode==='min'?mode:'exact');
  if(!p)return null;
  const age=p.ageMs!=null?plannerAge(p.ageMs):'',old=p.stale?(p.source==='simcotools'||p.source==='simcotools-prices'?' · stale':' · old'):'';
  const where=p.source==='exchange'?(mode==='any'?'cheapest exchange listing, any quality (as game)':'exchange listing')
    :p.source==='ticker'?'Game ticker (lowest Q0 ask)'
    :p.source==='simcotools'?(mode==='any'?'SimcoTools, cheapest captured quality':'SimcoTools current price')
    :p.source==='simcotools-prices'?'SimcoTools last trade'
    :'VWAP fallback';
  const hint=p.source==='simcotools'&&mode==='any'?' — open the game to load the exchange':'';
  return {price:p.price,quality:p.quality,source:`${where}${age?` · ${age}`:''}${old}${hint}`,stale:p.stale,origin:p.source,srcLabel:scmSrcLabel(p)};
}
function plannerProfitWageKey(building){return String(building?.raw?.kind||building?.kind||building?.category||building?.name||'building');}
// Labour and admin come from the game's own cost records, never hard-coded:
// every produced warehouse lot carries cost.workers and cost.admin for the whole lot, so
//   workers per unit = cost.workers ÷ amount   and   admin overhead = cost.admin ÷ cost.workers.
// The latest lot of the product is used; the last value seen is cached so it survives selling out.
const PLANNER_LABOUR_CACHE_KEY='scmPlannerLabourCacheV1';
function plannerRealmOf(s){return validRealmNumber(s?.viewRealm??s?.captureRealm??s?.authData?.authCompany?.realmId);}
function plannerWarehouseLots(s){return Array.isArray(s?.warehouseResources)?s.warehouseResources:[];}
function plannerAdminOverheadFromLots(s){
  const lots=plannerWarehouseLots(s).filter(x=>Number(x?.cost?.workers)>0&&Number.isFinite(Number(x?.cost?.admin)));
  if(!lots.length)return null;
  lots.sort((a,b)=>String(b.datetime||'').localeCompare(String(a.datetime||'')));
  const l=lots[0];return {pct:Number(l.cost.admin)/Number(l.cost.workers)*100,at:l.datetime||null};
}
function plannerLabourFromLots(s,productId,quality){
  const key=`${plannerRealmOf(s)}:${Number(productId)}:${Number(quality)}`;
  const lots=plannerWarehouseLots(s).filter(x=>Number(x?.kind)===Number(productId)&&Number(x?.amount)>0&&Number(x?.cost?.workers)>0);
  let cache={};try{cache=JSON.parse(localStorage.getItem(PLANNER_LABOUR_CACHE_KEY)||'{}')||{};}catch{}
  if(lots.length){
    lots.sort((a,b)=>((Number(b.quality)===Number(quality))-(Number(a.quality)===Number(quality)))||String(b.datetime||'').localeCompare(String(a.datetime||'')));
    const l=lots[0];let ps=null;try{ps=globalThis.SCM_TOOLS_CORE?.lotWorkersPerProducedUnit?.(l)||null;}catch{}
    const out={workersPerUnit:ps?ps.workersPerUnit:Number(l.cost.workers)/Number(l.amount),quality:Number(l.quality),at:l.datetime||null,cached:false,boughtUnits:ps&&ps.mixed?ps.boughtUnits:0,amount:Number(l.amount)};
    if(out.quality===Number(quality)){cache[key]={workersPerUnit:out.workersPerUnit,at:out.at};try{localStorage.setItem(PLANNER_LABOUR_CACHE_KEY,JSON.stringify(cache));}catch{}}
    return out;
  }
  const c=cache[key];return c&&Number(c.workersPerUnit)>0?{workersPerUnit:Number(c.workersPerUnit),quality:Number(quality),at:c.at||null,cached:true}:null;
}
// Exchange fee from your own sales: each exchange sale writes a 'marketfilled-<id>' entry and a matching
// 'fees-<id>' entry in the cashflow ledger at the same moment. fee % = fees ÷ sale value (latest large sale).
function plannerExchangeFeeFromSales(s){
  const ep=s?.endpointData||{},rows=[];
  for(const [k,v] of Object.entries(ep)){if(!/\/api\/v2\/companies\/me\/cashflow\/(?:recent|\d+)\/?$/.test(k))continue;const d=v?.data;const list=Array.isArray(d?.data)?d.data:Array.isArray(d)?d:[];rows.push(...list);}
  const fees=rows.filter(r=>r?.category==='f'&&/^fees-\d+$/.test(String(r?.descriptionKey||''))&&Number(r?.money)<0);
  const sales=rows.filter(r=>r?.category==='m'&&/^marketfilled-\d+$/.test(String(r?.descriptionKey||''))&&Number(r?.money)>0);
  const pairs=[];
  for(const f of fees){const id=String(f.descriptionKey).slice(5),t=Date.parse(f.datetime);const m=sales.find(x=>String(x.descriptionKey).slice(13)===id&&Math.abs(Date.parse(x.datetime)-t)<5000);if(m&&Number(m.money)>=1000)pairs.push({pct:-Number(f.money)/Number(m.money)*100,at:f.datetime,value:Number(m.money)});}
  if(!pairs.length)return null;
  pairs.sort((a,b)=>String(b.at).localeCompare(String(a.at)));
  const recent=pairs.slice(0,10).sort((a,b)=>b.value-a.value)[0];
  return {pct:Math.round(recent.pct*100)/100,at:recent.at};
}
// Ask the background for a fresh exchange order book (through the game tab) when the stored one is older
// than 15 min; re-render this card when it arrives. Background throttles to once per product per 5 min.
const __plannerOrderBookAsked=new Map();
function plannerRequestOrderBook(ctx,host,productId){
  try{
    const realm=plannerRealmOf(ctx.s);if(realm==null||!(productId>0))return;
    const ep=ctx.s?.endpointData?.[`/api/v3/market/${realm}/${productId}/`];const at=Date.parse(String(ep?.receivedAt||''));
    if(Number.isFinite(at)&&Date.now()-at<15*60000)return;
    const k=`${realm}:${productId}`;if(Date.now()-(__plannerOrderBookAsked.get(k)||0)<60000)return;__plannerOrderBookAsked.set(k,Date.now());
    chrome.runtime.sendMessage({type:'FETCH_EXCHANGE_ORDER_BOOK',realm,resourceId:productId}).then(async r=>{
      if(!r?.ok||r.throttled)return;const fresh=await get();if(!commitDashboardState(fresh))return;
      if(host.__plannerProfitCtx){host.__plannerProfitCtx={...host.__plannerProfitCtx,s:fresh};renderPlannerProfit(host);}
    }).catch(()=>{});
  }catch{}
}
function plannerDate(v){const t=Date.parse(String(v||''));return Number.isFinite(t)?new Date(t).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'—';}
// Economy phase for the profit card. The running batch keeps the phase it started in; the game's
// Profit Calculator uses the current phase. Wage per hour per level does not change with the phase, so labour
// per unit = wage ÷ units per hour (game: 67.82 × 6.613 = 73.94 × 6.066 = 448.5 $/h/level).
const PLANNER_PHASE_RATE_KEY='scmPlannerPhaseRateV1',PLANNER_WAGE_KEY='scmPlannerWageV1';
function plannerLocalGet(k){try{return JSON.parse(localStorage.getItem(k)||'{}')||{};}catch{return {};}}
function plannerLocalPut(k,v){try{localStorage.setItem(k,JSON.stringify(v));}catch{}}
function plannerEconomy(ctx){
  const C=globalThis.SCM_TOOLS_CORE,log=Array.isArray(ctx.s?.economyStateLog)?ctx.s.economyStateLog:[];
  const current=plannerEconomyNow(ctx.s);
  let batch=ctx.rateFromBatch&&ctx.batchStarted&&C?.economyStateAt?C.economyStateAt(log,ctx.batchStarted):null;
  // Batch started before the log's first entry: phase unknown. If the economy is normal now and the
  // batch's measured rate is far from the normal rate, it was produced in another phase.
  if(!batch&&ctx.rateFromBatch&&current===1&&C?.batchPhaseFromRate){const v=C.batchPhaseFromRate(Number(ctx.outputPerHour),ctx.referenceRate);if(v&&v.differs)batch={state:'other',inferred:true,diffPct:v.diffPct};}
  const realm=plannerRealmOf(ctx.s),level=Math.max(1,Number(ctx.level)||1),measured=Number(ctx.outputPerHour);
  const rates=plannerLocalGet(PLANNER_PHASE_RATE_KEY);
  if(batch&&!batch.inferred&&realm!=null&&measured>0){rates[`${realm}:${ctx.productId}:${batch.state}`]={perLevel:measured/level,at:ctx.batchStarted};plannerLocalPut(PLANNER_PHASE_RATE_KEY,rates);}
  const known=current!=null?rates[`${realm}:${ctx.productId}:${current}`]:null;
  // Game constants: rate = the game's own formula for the current phase (what its Profit Calculator uses);
  // the running batch's phase is the log's, else the phase whose game rate matches its measured rate.
  const gc=ctx.s?.gameConstants,opts={eventPct:ctx.eventPct||0,bonusPct:ctx.bonusPct||0,abundancePct:ctx.abundancePct??null};
  const gameNow=current!=null&&C?.gameRatePerLevel?C.gameRatePerLevel(gc,ctx.productId,current,opts):null;
  if(gameNow>0){
    if((!batch||(batch.inferred&&!batch.matched))&&ctx.rateFromBatch&&measured>0){const m=C.phaseFromMeasuredRate(gc,ctx.productId,measured/level,opts);if(m)batch={state:m.state,inferred:true,matched:true};}
    const changed=batch!=null&&batch.state!=null&&String(batch.state)!==String(current);
    const diffPct=measured>0?(measured-gameNow*level)/(gameNow*level)*100:null;
    return {rate:gameNow*level,source:'game-constants',changed,current,batch,measured,diffPct,name:v=>C?.economyName?C.economyName(v):String(v)};
  }
  const p=C?.projectionRate?C.projectionRate({measuredRate:measured,batchPhase:batch?.state,currentPhase:current,phaseRate:known&&known.at!==ctx.batchStarted?Number(known.perLevel)*level:null,referenceRate:current===1?ctx.referenceRate:null}):{rate:measured>0?measured:null,source:'measured',changed:false};
  return {...p,current,batch,measured,name:v=>C?.economyName?C.economyName(v):String(v)};
}
// Wage $/h/level from the produced lot: workers per produced unit × the batch rate per level. Only fresh when
// the lot holds output of the measured batch (lot time ≥ batch start); otherwise the last fresh value is used.
function plannerWage(ctx,lab){
  if(!lab)return null;const realm=plannerRealmOf(ctx.s),key=`${realm}:${ctx.productId}`,level=Math.max(1,Number(ctx.level)||1);
  const cache=plannerLocalGet(PLANNER_WAGE_KEY),measured=Number(ctx.outputPerHour);
  const fresh=ctx.rateFromBatch&&!lab.cached&&measured>0&&Date.parse(String(lab.at||''))>=Date.parse(String(ctx.batchStarted||''));
  if(fresh){const w=lab.workersPerUnit*measured/level;cache[key]={wage:w,at:lab.at};plannerLocalPut(PLANNER_WAGE_KEY,cache);return {wage:w,fresh:true,at:lab.at};}
  if(cache[key]&&Number(cache[key].wage)>0)return {wage:Number(cache[key].wage),fresh:false,at:cache[key].at};
  return measured>0?{wage:lab.workersPerUnit*measured/level,fresh:false,at:lab.at}:null;
}
// The player's OWN executives roster. endpointData also holds rosters of other companies viewed in the game
// (no skills/salary/trainings), so never pick "any" roster; with no own id or no own roster return null.
function ownExecutivesKey(s){
  const ac=s?.authData?.authCompany,id=Number(ac?.companyId??ac?.id);
  if(!(id>0))return null;
  const k=`/api/v3/companies/${id}/executives/`;
  return s?.endpointData&&s.endpointData[k]?k:null;
}
// Current admin overhead exactly as the game computes it: captured base (/administration-overhead/) and
// executives, plus the game page's executive timing config (scmGameConfig). Null when anything is missing.
function plannerGameAdmin(s){
  try{
    const C=globalThis.SCM_TOOLS_CORE,ep=s?.endpointData||{},cfg=s?.gameConfig||{};
    const base=Number(ep['/api/v2/companies/me/administration-overhead/']?.data);
    const exKey=ownExecutivesKey(s);
    const ex=exKey?ep[exKey]?.data?.executives:null;
    const r=C?.effectiveAdminOverhead?C.effectiveAdminOverhead({base,executives:ex,buildings:s?.buildings,trainS:cfg.executivesTimeToTrainS,settleS:cfg.executivesTimeToSettleInS}):null;
    return r?{...r,at:ep[exKey]?.receivedAt||null}:null;
  }catch{return null;}
}
// Executives tab: roster cards, Team Impact (game admin formula), COO ROI, training planner, apprentice vs main.
// Salaries are $/day (confirmed by the user against the game's Salaries line); training cost and skill gain per session are user inputs (not from the game's API).
const EXEC_PLAN_KEY='scmExecPlanner',EXEC_MAX_TRAININGS=20;
function execPlanSettings(){try{const v=JSON.parse(localStorage.getItem(EXEC_PLAN_KEY)||'{}');return {cost:v.cost??10000,gain:v.gain??1.5};}catch{return {cost:10000,gain:1.5};}}
// Executives charts: inline SVG, no library. Colour follows the role (validated dark categorical slots 1–5
// on the panel surface #1d1b1a), one y-axis per chart, 2px lines, hover crosshair + tooltip, legend + direct labels.
const EXEC_COLOR={o:'#3987e5',v:'#d95926',f:'#199e70',m:'#c98500',t:'#d55181'};
const __execCharts=new Map();
function execNiceTicks(lo,hi,n=4){const span=hi-lo||1,raw=span/n,mag=10**Math.floor(Math.log10(raw)),step=[1,2,2.5,5,10].map(m=>m*mag).find(x=>x>=raw)||raw;const a=Math.floor(lo/step)*step,b=Math.ceil(hi/step-1e-9)*step,out=[];for(let v=a;v<=b+step*1e-9;v+=step)out.push(+v.toFixed(10));return out;}
function execLineChart(id,{series,xLabel,xFmt=v=>num(v),yFmt=v=>`${v.toFixed(1)}%`,markers=[]}){
  const W=340,H=210,L=40,R=14,T=14,B=34,xs=series.flatMap(s=>s.points.map(p=>p[0])),ys=series.flatMap(s=>s.points.map(p=>p[1])).concat(markers.map(m=>m.y));
  if(!xs.length)return '';
  const x0=Math.min(...xs),x1=Math.max(...xs)||1,yt=execNiceTicks(Math.min(...ys),Math.max(...ys)),y0=yt[0],y1=yt[yt.length-1]>y0?yt[yt.length-1]:y0+1;
  const X=v=>L+(v-x0)/((x1-x0)||1)*(W-L-R),Y=v=>T+(1-(v-y0)/(y1-y0))*(H-T-B);
  const xt=execNiceTicks(x0,x1,5).filter(v=>v>=x0&&v<=x1);
  const grid=yt.map(v=>`<line class="ec-grid" x1="${L}" x2="${W-R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="ec-tick" x="${L-6}" y="${(Y(v)+3.5).toFixed(1)}" text-anchor="end">${escapeHtml(yFmt(v,true))}</text>`).join('')
    +xt.map(v=>`<text class="ec-tick" x="${X(v).toFixed(1)}" y="${H-B+14}" text-anchor="middle">${escapeHtml(xFmt(v))}</text>`).join('');
  const lines=series.map(s=>`<path class="ec-line" stroke="${s.color}" d="${s.points.map((p,i)=>`${i?'L':'M'}${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join('')}"/>`).join('');
  const ends=series.length>1?series.map(s=>{const p=s.points[s.points.length-1];return `<circle class="ec-dot" cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="4" fill="${s.color}"/>`;}).join(''):'';
  const mk=markers.map(m=>{const cx=X(m.x),right=cx<W*0.72;return `<circle class="ec-dot" cx="${cx.toFixed(1)}" cy="${Y(m.y).toFixed(1)}" r="4.5" fill="${m.color||'#eeeded'}"/><text class="ec-mlabel" x="${(cx+(right?8:-8)).toFixed(1)}" y="${(Y(m.y)-6).toFixed(1)}" text-anchor="${right?'start':'end'}">${escapeHtml(m.label)}</text>`;}).join('');
  __execCharts.set(id,{series,markers,x0,x1,L,R,W,H,T,B,X,Y,xFmt,yFmt,xLabel});
  const legend=series.length>1?`<div class="ec-legend">${series.map(s=>`<span><i style="background:${s.color}"></i>${escapeHtml(s.name)}</span>`).join('')}</div>`:'';
  return `${legend}<div class="ec-wrap" data-exec-chart="${id}"><svg class="ec-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(xLabel)}">${grid}<line class="ec-axis" x1="${L}" x2="${W-R}" y1="${H-B}" y2="${H-B}"/>${lines}${ends}${mk}<line class="ec-cross" x1="0" x2="0" y1="${T}" y2="${H-B}" visibility="hidden"/><text class="ec-xlabel" x="${(L+W-R)/2}" y="${H-4}" text-anchor="middle">${escapeHtml(xLabel)}</text><rect class="ec-hit" x="${L}" y="${T}" width="${W-L-R}" height="${H-T-B}"/></svg><div class="ec-tip" hidden></div></div>`;
}
function execPieChart(id,{slices,fmt,center}){
  const tot=slices.reduce((a,s)=>a+s.value,0);if(!(tot>0))return '';
  const W=340,H=200,cx=100,cy=100,r=86,ri=52;let a=-Math.PI/2;
  const pt=(rad,ang)=>`${(cx+rad*Math.cos(ang)).toFixed(2)} ${(cy+rad*Math.sin(ang)).toFixed(2)}`;
  const arcs=slices.map((s,i)=>{const sw=s.value/tot*Math.PI*2,a1=a+sw,big=sw>Math.PI?1:0;const d=slices.length===1?`M${pt(r,a)}A${r} ${r} 0 1 1 ${pt(r,a+Math.PI*1.9999)}L${pt(ri,a+Math.PI*1.9999)}A${ri} ${ri} 0 1 0 ${pt(ri,a)}Z`:`M${pt(r,a)}A${r} ${r} 0 ${big} 1 ${pt(r,a1)}L${pt(ri,a1)}A${ri} ${ri} 0 ${big} 0 ${pt(ri,a)}Z`;a=a1;return `<path class="ec-wedge" data-i="${i}" d="${d}" fill="${s.color}"/>`;}).join('');
  __execCharts.set(id,{pie:true,slices,tot,fmt});
  const rows=slices.map((s,i)=>`<g class="ec-prow" data-i="${i}" transform="translate(206 ${(cy-slices.length*17+i*34+12).toFixed(0)})"><rect x="0" y="-9" width="10" height="10" rx="2" fill="${s.color}"/><text class="ec-plabel" x="16" y="0">${escapeHtml(s.name)}</text><text class="ec-pval" x="16" y="14">${escapeHtml(fmt(s.value))} · ${(s.value/tot*100).toFixed(0)}%</text></g>`).join('');
  return `<div class="ec-wrap" data-exec-chart="${id}"><svg class="ec-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(center[1])}">${arcs}<text class="ec-center" x="${cx}" y="${cy+2}" text-anchor="middle">${escapeHtml(center[0])}</text><text class="ec-csub" x="${cx}" y="${cy+18}" text-anchor="middle">${escapeHtml(center[1])}</text>${rows}</svg><div class="ec-tip" hidden></div></div>`;
}
function wireExecCharts(root){
  root.querySelectorAll('[data-exec-chart]').forEach(w=>{
    const c=__execCharts.get(w.dataset.execChart),svg=w.querySelector('svg'),tip=w.querySelector('.ec-tip');if(!c||!svg)return;
    const place=(e,html)=>{tip.innerHTML=html;tip.hidden=false;const b=w.getBoundingClientRect(),x=e.clientX-b.left,y=e.clientY-b.top;tip.style.left=`${Math.max(4,Math.min(b.width-tip.offsetWidth-4,x+12))}px`;tip.style.top=`${Math.max(0,y-tip.offsetHeight-10)}px`;};
    const hide=()=>{tip.hidden=true;svg.querySelector('.ec-cross')?.setAttribute('visibility','hidden');svg.querySelectorAll('.ec-wedge').forEach(p=>p.classList.remove('dim'));};
    svg.addEventListener('pointerleave',hide);
    if(c.pie){svg.querySelectorAll('.ec-wedge,.ec-prow').forEach(p=>['pointermove','pointerdown'].forEach(ev=>p.addEventListener(ev,e=>{const i=+p.dataset.i,s=c.slices[i];svg.querySelectorAll('.ec-wedge').forEach(q=>q.classList.toggle('dim',+q.dataset.i!==i));place(e,`<b>${escapeHtml(s.name)}</b><br>${escapeHtml(c.fmt(s.value))} · ${(s.value/c.tot*100).toFixed(1)}%${s.note?`<br><small>${escapeHtml(s.note)}</small>`:''}`);})));return;}
    const onMove=e=>{
      const m=svg.getScreenCTM();if(!m)return;const px=(e.clientX-m.e)/m.a;if(px<c.L||px>c.W-c.R){hide();return;}
      const xv=c.x0+(px-c.L)/(c.W-c.L-c.R)*((c.x1-c.x0)||1);
      const allX=[...new Set(c.series.flatMap(s=>s.points.map(p=>p[0])))].sort((a,b)=>a-b);const nx=allX.reduce((b,v)=>Math.abs(v-xv)<Math.abs(b-xv)?v:b,allX[0]);
      const cr=svg.querySelector('.ec-cross');cr.setAttribute('x1',c.X(nx));cr.setAttribute('x2',c.X(nx));cr.setAttribute('visibility','visible');
      const rows=c.series.map(s=>{const p=s.points.find(q=>q[0]===nx);return p?`<div><i style="background:${s.color}"></i>${escapeHtml(s.name)} <b>${escapeHtml(c.yFmt(p[1]))}</b></div>`:'';}).join('');
      const mk=c.markers.filter(q=>Math.abs(q.x-nx)<1e-9).map(q=>`<div><small>${escapeHtml(q.label)}</small></div>`).join('');
      place(e,`<b>${escapeHtml(c.xFmt(nx))}</b> ${escapeHtml(c.xLabel)}${rows}${mk}`);
    };
    svg.addEventListener('pointermove',onMove);svg.addEventListener('pointerdown',onMove);
  });
}
function renderBoardRoom(s){
  const el=$('#execBody'),C=globalThis.SCM_TOOLS_CORE;if(!el||!C?.executiveRoster)return;
  const ep=s?.endpointData||{},cfg=s?.gameConfig||{};
  const exKey=ownExecutivesKey(s);
  const ex=exKey?ep[exKey]?.data?.executives:null;
  if(!Array.isArray(ex)||!ex.length){el.innerHTML='<div class="planner-profit-empty">No executives captured yet. Open the Executives page in the game once, then come back.</div>';return;}
  const trainS=cfg.executivesTimeToTrainS,settleS=cfg.executivesTimeToSettleInS,now=Date.now();
  const base=Number(ep['/api/v2/companies/me/administration-overhead/']?.data);
  const blds=buildingArrayFromState(s).map(b=>({kind:String(pick(b,['kind','buildingKind','type'])??''),level:Number(pick(b,['level','lvl','buildingLevel','size']))||1,size:b?.size,position:b?.position,purchasedRecently:b?.purchasedRecently,robotsSpecialization:Boolean(b?.robotsSpecialization),busy:b?.busy||null}));
  const st=execPlanSettings();
  // Trainings done come from the walk-captured trainings-count endpoint of the same company, matched by executive id.
  const companyId=exKey.match(/\/companies\/(\d+)\//)[1],tc=ep[`/api/v3/companies/${companyId}/executives/trainings-count/`]?.data?.trainingsCount;
  const tcOf=id=>{const v=tc?.[String(id)];return v!=null&&Number.isFinite(Number(v))?Number(v):null;};
  const roster=C.executiveRoster(ex,{now,trainS,settleS}).map(r=>({...r,trainings:tcOf(r.id)})),suite=roster.filter(r=>!r.staff);
  const args={base,executives:ex,buildings:blds,now,trainS,settleS};
  const ga=C.effectiveAdminOverhead(args);
  const labour=C.dailyBaseLabour(s?.gameConstants,blds);
  const salaries=roster.reduce((a,r)=>a+(r.salary||0),0),salKnown=roster.some(r=>r.salary!=null);
  const pct=v=>v==null||!Number.isFinite(v)?'—':`${(+v).toFixed(2)}%`;
  const own={o:'coo',v:'coo',f:'cfo',x:'cfo',m:'cmo',y:'cmo',t:'cto',z:'cto'};
  const bars=r=>['coo','cfo','cmo','cto'].map(k=>{const v=r.skills[k],w=Math.min(100,v/40*100);return `<div class="exec-skill${own[r.position]===k?' own':''}"><span>${k.toUpperCase()}</span><i style="width:${w.toFixed(1)}%"></i><b>${num(v)}</b></div>`;}).join('');
  const card=r=>`<div class="exec-card${r.staff?' staff':''}"><div class="exec-head"><div><strong>${escapeHtml(r.role)}</strong> ${escapeHtml(r.name||'')}${r.age!=null?` <small>${num(r.age)} y/o</small>`:''}</div><small>${r.trainings!=null?`${num(r.trainings)}/${EXEC_MAX_TRAININGS} trainings`:'trainings —'}</small></div><div class="exec-skills">${bars(r)}</div><div class="exec-foot"><span>Salary ${r.salary!=null?plannerMoney(r.salary):'—'}</span><span class="exec-status ${escapeHtml(r.status.replace(' ','-'))}">${escapeHtml(r.status)}${r.trainingEndsAt?` · until ${escapeHtml(new Date(r.trainingEndsAt).toLocaleString())}`:''}</span></div></div>`;
  const row=(l,v,n='',cls='')=>`<div class="pp-row ${cls}"><div class="pp-label">${l}${n?`<small>${n}</small>`:''}</div><div class="pp-value">${v}</div></div>`;
  const skillOf=k=>{try{return C.executiveSkill(ex,k,{now,trainS,settleS,academyActive:C.academyActiveSize(blds)});}catch{return null;}};
  const perDay=r=>labour>0&&r?labour*r.pct/100:null;
  // Team Impact
  const impact=`<div class="pp-list">${row('Administration overhead',ga?`${pct(ga.basePct)} <span class="is-profit">−${(+ga.reductionPct).toFixed(2)}%</span> = ${pct(ga.pct)}`:'—',ga?`effective COO ${num(ga.coo)} pts: COO full, COO apprentice ½ (academy ≥ 5), other C-suite ¼; base ${pct(ga.basePct)} × ${num(ga.coo)}%`:(!(base>=1)?'admin base not captured — open the game once':'game timing config not captured — reload the game page'))}${['cfo','cmo','cto'].map(k=>row(`Effective ${k.toUpperCase()} skill`,num(skillOf(k)),'same weighting as COO')).join('')}${row('Salaries',salKnown?plannerMoney(salaries):'—',salKnown?`${roster.filter(r=>r.salary!=null).length} people`:'salary field not in captured data')}</div>`;
  // COO ROI
  const roi=ga?C.executiveRoi({dailyLabour:labour,reductionPct:ga.reductionPct,salariesPerDay:salKnown?salaries:null}):null;
  const roiHtml=roi?`<div class="pp-stats"><div class="pp-stat is-profit"><strong>${plannerMoney(roi.savedPerDay)}</strong><span>Admin saved / day</span></div><div class="pp-stat"><strong>${plannerMoney(roi.salariesPerDay)}</strong><span>Salaries / day</span></div><div class="pp-stat ${roi.netPerDay==null?'':roi.netPerDay>=0?'is-profit':'is-loss'}"><strong>${plannerMoney(roi.netPerDay)}</strong><span>Net / day</span></div></div><div class="pp-list">${row('Base labour / day',plannerMoney(labour),'game wage × level × 24 h, producing buildings, before admin')}${row('Admin cost / day now',plannerMoney(perDay(ga)),`${pct(ga.pct)} of base labour`)}${row('Admin cost / day without executives',plannerMoney(labour*ga.basePct/100),pct(ga.basePct))}${row('Verdict',roi.paysForItself==null?'—':roi.paysForItself?'<span class="is-profit">Pays for itself</span>':'<span class="is-loss">Costs more than it saves</span>','salaries are per day (game)')}</div>`:`<div class="planner-profit-empty">${labour>0?'Admin overhead not available yet.':'Game constants or producing buildings not captured yet — Sync first.'}</div>`;
  // Training planner
  const plan=suite.map(r=>{const left=r.trainings!=null?Math.max(0,EXEC_MAX_TRAININGS-r.trainings):null;const add=left!=null?left*Number(st.gain||0):null;
    const after=add!=null&&ga?C.executiveAdminWhatIf({...args,edit:e=>(String(e.id)===String(r.id)&&e.currentWorkHistory?.position===r.position?(e.skills={...e.skills,coo:(Number(e.skills?.coo)||0)+add},e):e)}):null;
    const gain=after&&labour>0?labour*(ga.pct-after.pct)/100:null,cost=left!=null?left*Number(st.cost||0):null;
    return `<tr><td>${escapeHtml(r.role)}<small>${escapeHtml(r.name||'')}</small></td><td>${r.trainings!=null?num(r.trainings):'—'}</td><td>${left==null?'—':num(left)}</td><td>${cost==null?'—':plannerMoney(cost)}</td><td>${add==null?'—':`+${num(+add.toFixed(1))} → ${num(+(r.skills[own[r.position]]+add).toFixed(1))}`}</td><td>${after?pct(after.pct):'—'}</td><td>${gain==null?'—':plannerMoney(gain)}</td><td>${gain>0&&cost>0?`${num(+(cost/gain).toFixed(1))} d`:left===0?'maxed':'—'}</td></tr>`;}).join('');
  const planHtml=`<div class="planner-profit-controls"><label>Cost / training $<input id="execCost" type="number" step="any" inputmode="decimal" value="${escapeHtml(st.cost)}"></label><label>Skill gain / training<input id="execGain" type="number" step="any" inputmode="decimal" value="${escapeHtml(st.gain)}"></label></div><div class="pp-hint">Training time ${Number(trainS)>0?`${num(+(trainS/3600).toFixed(1))} h (game)`:'— (open the game)'} · max ${EXEC_MAX_TRAININGS} trainings · gain is added to own skill; admin effect assumes it lands on COO.${suite.some(r=>r.trainings==null)?' <b>Trainings done isn’t in the captured data yet — run Sync with the game open to capture it.</b>':''}</div><div class="table-wrap"><table class="exec-plan"><thead><tr><th>Exec</th><th>Done</th><th>Left</th><th>Cost</th><th>Skill</th><th>Admin after</th><th>Saved / day</th><th>Payback</th></tr></thead><tbody>${plan}</tbody></table></div>`;
  // Apprentice vs main
  const main=roster.find(r=>r.position==='o'),app=roster.find(r=>r.position==='v');
  const leave=ga&&main?C.executiveAdminWhatIf({...args,edit:e=>e.currentWorkHistory?.position==='o'?null:e}):null;
  const promote=ga&&main&&app?C.executiveAdminWhatIf({...args,edit:e=>{const p=e.currentWorkHistory?.position;if(p==='o')return null;if(p==='v'){e.currentWorkHistory={...e.currentWorkHistory,position:'o',accelerated:true};}return e;}}):null;
  const cmp=(l,r,n)=>{const d=r&&ga&&labour>0?labour*(r.pct-ga.pct)/100:null;return row(l,r?pct(r.pct):'—',`${r?`admin overhead · effective COO ${num(r.coo)} pts`:''}${d!=null&&Math.abs(d)>=0.005?` · <span class="${d>0?'is-loss':'is-profit'}">${d>0?'+':'−'}${plannerMoney(Math.abs(d))} / day admin cost</span>`:''}${n?` · ${n}`:''}`);};
  const mn=escapeHtml(main?.name||'your COO');
  const appHtml=main?`<div class="pp-hint">What happens to admin overhead if ${mn} (COO ${num(main.skills.coo)}${main.age!=null?`, ${num(main.age)} y/o`:''}) retires or is fired. The apprentice is the back-up who can take over.</div><div class="pp-list">${cmp(`Today: ${mn} is COO`,ga,'')}${app?cmp(`${escapeHtml(app.name||'Apprentice')} takes over (COO ${num(app.skills.coo)})`,promote,'apprentice slot empty after'):row('Apprentice','—','no COO apprentice hired')}${cmp('No replacement',leave,'')}</div>`:'<div class="planner-profit-empty">No COO in the board room.</div>';
  // Charts
  const first=n=>String(n||'').split(' ')[0]||'—',acad=C.academyActiveSize(blds);
  const w8={o:[1,'full skill'],v:[0.5,'½ skill (academy ≥ 5)'],f:[0.25,'¼ skill'],m:[0.25,'¼ skill'],t:[0.25,'¼ skill']};
  const cooSlices=suite.filter(r=>r.status==='active'&&w8[r.position]&&(r.position!=='v'||acad>=5)&&r.skills.coo>0).map(r=>({name:`${first(r.name)} (${r.role.replace(' Apprentice',' App.')})`,value:r.skills.coo*w8[r.position][0],color:EXEC_COLOR[r.position],note:`COO ${num(r.skills.coo)} × ${w8[r.position][1]}`}));
  const cooPie=ga&&cooSlices.length?`<h4 class="ec-title">Where your COO points come from</h4>${execPieChart('cooPie',{slices:cooSlices,fmt:v=>`${num(+v.toFixed(1))} pts`,center:[num(ga.coo),'COO pts']})}`:'';
  const salSlices=suite.filter(r=>r.salary>0).map(r=>({name:`${first(r.name)} (${r.role.replace(' Apprentice',' App.')})`,value:r.salary,color:EXEC_COLOR[r.position]||'#a5a09e'}));
  const salPie=salSlices.length?`<h4 class="ec-title">Salaries per day</h4>${execPieChart('salPie',{slices:salSlices,fmt:v=>plannerMoney(v).replace(/\.00$/,''),center:[`$${(salaries/1000).toFixed(0)}k`,'per day']})}`:'';
  const dim=r=>{let x=Math.floor(r);if(x>80)x=80+(x-80)/2;if(x>60)x=60+(x-60)/2;return Math.floor(x);};
  const curve=ga?`<h4 class="ec-title">Admin overhead vs COO points</h4>${execLineChart('aoCurve',{xLabel:'COO points',series:[{name:'Admin overhead',color:EXEC_COLOR.o,points:Array.from({length:101},(_,i)=>[i,ga.basePct*(1-dim(i)/100)])}],markers:[promote&&{x:promote.coo,y:promote.pct,label:`${first(app?.name)} ${pct(promote.pct)}`,color:EXEC_COLOR.v},leave&&{x:leave.coo,y:leave.pct,label:`None ${pct(leave.pct)}`,color:'#a5a09e'},{x:ga.coo,y:ga.pct,label:`Today ${pct(ga.pct)}`,color:EXEC_COLOR.o}].filter(Boolean)})}<div class="pp-hint">Each COO point cuts ${(ga.basePct/100).toFixed(2)}% off admin. Past 60 points each point counts half, past 80 a quarter.</div>`:'';
  const proj=ga?suite.filter(r=>r.trainings!=null&&r.trainings<EXEC_MAX_TRAININGS&&EXEC_COLOR[r.position]).map(r=>{const left=EXEC_MAX_TRAININGS-r.trainings;return {name:first(r.name),color:EXEC_COLOR[r.position],points:Array.from({length:left+1},(_,k)=>{const a=C.executiveAdminWhatIf({...args,edit:e=>(String(e.id)===String(r.id)&&e.currentWorkHistory?.position===r.position&&(e.skills={...e.skills,coo:(Number(e.skills?.coo)||0)+k*Number(st.gain||0)}),e)});return [k,a?a.pct:ga.pct];})};}):[];
  const projHtml=ga?(proj.length?`<h4 class="ec-title">Admin overhead as each exec trains</h4>${execLineChart('trainProj',{xLabel:'Trainings from now',series:proj})}`:`<div class="pp-hint">${suite.some(r=>r.trainings==null)?'Run Sync to capture trainings done and see the projection chart.':'Everyone is at 20 trainings — nothing left to project.'}</div>`):'';
  const at=ep[exKey]?.receivedAt;
  el.innerHTML=`<div class="exec-grid">${roster.map(card).join('')}</div>${at?`<div class="pp-hint">Captured ${escapeHtml(new Date(at).toLocaleString())}</div>`:''}
<div class="exec-panels"><div class="panel"><h3>Team impact</h3>${impact}${cooPie}${salPie}</div><div class="panel"><h3>COO ROI / break-even</h3>${roiHtml}</div><div class="panel"><h3>Training planner</h3>${planHtml}${projHtml}</div><div class="panel"><h3>If your COO leaves</h3>${appHtml}${curve}</div></div>`;
  wireExecCharts(el);
  const save=(k,v)=>{const c=execPlanSettings();c[k]=v;try{localStorage.setItem(EXEC_PLAN_KEY,JSON.stringify(c));}catch{}renderBoardRoom(s);};
  el.querySelector('#execCost')?.addEventListener('change',e=>save('cost',e.target.value));
  el.querySelector('#execGain')?.addEventListener('change',e=>save('gain',e.target.value));
}
function renderPlannerProfit(host){
  const ctx=host.__plannerProfitCtx,el=host.querySelector('#plannerProfit'),C=globalThis.SCM_TOOLS_CORE;
  if(!ctx||!el||!C)return;
  const cfg=plannerProfitSettings(),wageKey=plannerProfitWageKey(ctx.building);
  const lotAdmin=plannerAdminOverheadFromLots(ctx.s),gameAdmin=plannerGameAdmin(ctx.s),salesFee=plannerExchangeFeeFromSales(ctx.s);
  const autoAdmin=gameAdmin?gameAdmin.pct:lotAdmin?.pct;
  const fld=(id,label,value,extra='')=>`<label>${label}<input id="${id}" type="number" step="any" inputmode="decimal" value="${escapeHtml(value??'')}" ${extra}></label>`;
  el.innerHTML=`<div class="planner-profit-controls"><label>Inputs<select id="ppInputSource"><option value="warehouse"${cfg.inputSource!=='market'&&cfg.inputSource!=='market-any'?' selected':''}>Warehouse cost</option><option value="market-any"${cfg.inputSource==='market-any'?' selected':''}>Market · cheapest any Q (as game)</option><option value="market"${cfg.inputSource==='market'?' selected':''}>Market · required Q or better</option></select></label><label>Sell via<select id="ppSellMode"><option value="exchange"${cfg.sellMode==='exchange'?' selected':''}>Exchange</option><option value="contract"${cfg.sellMode==='contract'?' selected':''}>Contract</option></select></label>${cfg.sellMode==='exchange'?fld('ppFee','Exchange fee %',cfg.exchangeFeePct??'',`placeholder="4"`):fld('ppDiscount','Contract discount %',cfg.contractDiscountPct)}${fld('ppOverhead','Admin overhead %',cfg.adminOverheadPct??'',`placeholder="${autoAdmin!=null?autoAdmin.toFixed(2):'0'} auto"`)}${fld('ppWage','Wages $/h/level (override)',cfg.wages[wageKey]??'','placeholder="auto"')}</div><div class="pp-hint">Blank = auto from your data: fee ${salesFee?`${salesFee.pct.toFixed(2)}% from your exchange sales`:'4% default (no exchange sale captured yet)'} · admin ${gameAdmin?`${gameAdmin.pct.toFixed(2)}% (${gameAdmin.basePct.toFixed(2)}% − ${gameAdmin.reductionPct.toFixed(2)}% executives, as the game)`:lotAdmin?`${lotAdmin.pct.toFixed(2)}% from your latest batch (open the game once to load the executives calculation)`:'0% (no batch captured yet)'} · labour from your produced batches. Type a value to override.</div><div id="plannerProfitResults"></div>`;
  const results=()=>{
    const c=plannerProfitSettings();
    const setNum=v=>v!==''&&v!=null&&Number.isFinite(Number(v));
    const overhead=setNum(c.adminOverheadPct)?Number(c.adminOverheadPct):(autoAdmin??0);
    const feePct=setNum(c.exchangeFeePct)?Number(c.exchangeFeePct):(C.EXCHANGE_FEE_PCT??4); // always 4% unless typed
    const productId=Number(ctx.productId);
    const sale=Number.isFinite(productId)?plannerMarketPrice(ctx.s,productId,ctx.quality,'any'):null;
    plannerRequestOrderBook(ctx,host,productId);
    const transport=plannerMarketPrice(ctx.s,13,0,'min');
    const isMarket=c.inputSource==='market'||c.inputSource==='market-any';
    // Warehouse inputs as the game: cheapest lot of that resource, any quality, Σ cost ÷ amount, not rounded
    // (Water Q0 $0.347, not the Q1 lot $0.37); not in the warehouse → cheapest listing of any quality, as the game.
    const lotsAll=plannerWarehouseLots(ctx.s);
    const inputs=(ctx.plannedInputs||[]).map(x=>{let p=null;if(!isMarket&&C.warehouseUnitCostAsGame){const w=C.warehouseUnitCostAsGame(lotsAll,x.id);if(w)p={price:w.unitCost,quality:w.quality,lot:true,source:`warehouse, cheapest lot (as game) · ${num(w.amount)} in stock`};}if(!p){p=plannerMarketPrice(ctx.s,x.id,x.minQuality,c.inputSource==='market'?'min':'any');if(p&&!isMarket)p={...p,source:`${p.source} (not in warehouse)`};}return {id:x.id,name:x.name,quality:x.minQuality,qtyPerUnit:Number(x.perOutput)||0,unitPrice:p?.price??null,priceQuality:p?.quality??null,lot:Boolean(p?.lot),source:p?.source||null};});
    const wageOverride=setNum(c.wages?.[wageKey])?Number(c.wages[wageKey]):null;
    let lab=wageOverride==null&&Number.isFinite(productId)?plannerLabourFromLots(ctx.s,productId,ctx.quality):null;
    const eco=plannerEconomy(ctx),lvl=Math.max(1,Number(ctx.level)||1),ownUnitsPerHour=ctx.nextPerLevel>0?ctx.nextPerLevel*lvl:(eco.rate||ctx.outputPerHour);
    // The game's Profit Calculator rates mine/oil/quarry resources at a fixed 90 % abundance (Minerals
    // 116.641/h/level, not your mine's 129.6); the card uses the same rate. Your own abundance is shown in a note.
    const calcRate=C.isAbundanceResource?.(productId)&&eco.current!=null&&C.gameProfitCalcRatePerLevel?C.gameProfitCalcRatePerLevel(ctx.s?.gameConstants,productId,eco.current,{eventPct:ctx.eventPct||0,bonusPct:ctx.bonusPct||0}):null;
    const unitsPerHour=calcRate>0?calcRate*lvl:ownUnitsPerHour;
    // Game wage from constants (AVERAGE_SALARY × salaryModifier × 0.97 with robots) when available.
    const gWage=wageOverride==null&&C.gameWagePerLevel?C.gameWagePerLevel(ctx.s?.gameConstants,ctx.buildingKind,ctx.robots):null;
    let wage=null;
    if(gWage>0&&unitsPerHour>0){lab={quality:ctx.quality,at:null,cached:false,boughtUnits:0,...(lab||{}),workersPerUnit:gWage/(unitsPerHour/Math.max(1,Number(ctx.level)||1)),game:true};wage={wage:gWage,fresh:false,game:true};}
    else{wage=lab?plannerWage(ctx,lab):null;
    // Labour per unit follows the projected rate (wage per hour is phase-independent).
    if(lab&&wage&&unitsPerHour>0&&(eco.changed||!wage.fresh))lab.workersPerUnit=wage.wage/(unitsPerHour/Math.max(1,Number(ctx.level)||1));}
    // Worker and admin cost shown in cents (as the game shows them)...
    const r2=v=>Math.round(v*100)/100;const wPU=lab?r2(lab.workersPerUnit):null,aPU=lab?r2(wPU*overhead/100):null;
    // ...but the game's profit uses them unrounded (Power: $0.19787, not $0.20 → $151.04 / h / level).
    const labourPerUnit=lab?lab.workersPerUnit*(1+overhead/100):null;
    const profitArgs={level:ctx.level,salePrice:sale?.price??null,inputs,transportUnits:ctx.transportUnits,transportUnitCost:transport?.price??0,sellMode:c.sellMode,exchangeFeePct:feePct,contractDiscountPct:Number(c.contractDiscountPct),wagePerHourPerLevel:wageOverride??0,adminOverheadPct:overhead};
    const r=C.buildingProfit({...profitArgs,unitsPerHour,labourPerUnit});
    // Your building at its own abundance (labour per unit scales with the rate; wage per hour does not change).
    let own=null;
    if(calcRate>0){const ab=Number(ctx.abundancePct);
      if(ctx.abundancePct!=null&&Number.isFinite(ab)&&ownUnitsPerHour>0){const ro=C.buildingProfit({...profitArgs,unitsPerHour:ownUnitsPerHour,labourPerUnit:labourPerUnit==null?null:labourPerUnit*unitsPerHour/ownUnitsPerHour});if(ro.ok)own={abundancePct:ab,ratePerLevel:ownUnitsPerHour/lvl,perLevel:(ro.profitPerUnit+ro.feePerUnit+ro.contractDiscountPerUnit+ro.transportPerUnit)*ro.unitsPerHour/lvl,netPerLevel:ro.profitPerHourPerLevel};}
      else own={abundancePct:null};}
    try{__plannerProfitLast[String(ctx.building?.id??ctx.building?.raw?.id??ctx.product)]={at:new Date().toISOString(),building:String(ctx.building?.name||''),product:ctx.product,productId,quality:ctx.quality,level:ctx.level,unitsPerHour,measuredUnitsPerHour:ctx.outputPerHour,economy:{current:eco.current,batch:eco.batch,source:eco.source,changed:eco.changed},wage,sale,inputs,labour:lab?{workersPerUnit:lab.workersPerUnit,lotAt:lab.at,lotQuality:lab.quality,cached:lab.cached}:null,adminOverheadPct:overhead,adminSource:setNum(c.adminOverheadPct)?'override':gameAdmin?'game formula (executives)':lotAdmin?'latest batch':'none',gameAdmin,exchangeFeePct:feePct,labourPerUnit,gameCalc:{abundanceResource:calcRate>0,assumedAbundancePct:calcRate>0?C.GAME_PROFIT_CALC_ABUNDANCE_PCT:null,ratePerLevel:unitsPerHour/lvl,ownRatePerLevel:ownUnitsPerHour/lvl,ownAbundancePct:ctx.abundancePct??null,own},result:r.ok?{inputCostPerUnit:r.inputCostPerUnit,labourPerUnit:r.labourPerUnit,sourcingCostPerUnit:r.inputCostPerUnit+r.labourPerUnit,profitPerUnitGameBasis:r.profitPerUnit+r.feePerUnit+r.contractDiscountPerUnit+r.transportPerUnit,profitPerHourPerLevelGameBasis:(r.profitPerUnit+r.feePerUnit+r.contractDiscountPerUnit+r.transportPerUnit)*r.unitsPerHour/lvl,profitPerHourPerLevelAfterFee:r.profitPerHourPerLevel}:{error:r.error},runningBatchUnitCost:Number(ctx.building?.raw?.busy?.resource?.unitCost)||null};}catch{}
    const out=host.querySelector('#plannerProfitResults');if(!out)return;
    const nrn=ctx.nextRun,nextRunNote=nrn&&ctx.nextPerLevel>0?`<div class="pp-basis">Next run: ${num(+(ctx.nextPerLevel*lvl).toFixed(3))}/h at Level ${num(lvl)} (${num(+ctx.nextPerLevel.toFixed(3))}/h/level · event ${Number(nrn.eventPct||0)>=0?'+':''}${num(+Number(nrn.eventPct||0).toFixed(2))}% · speed bonus ${num(+Number(nrn.bonusPct||0).toFixed(2))}%${nrn.abundancePct!=null?` · abundance ${num(+Number(nrn.abundancePct).toFixed(2))}%`:''})${ctx.runPerLevel!=null?` · running batch ${num(+(ctx.runPerLevel*Math.max(1,Number(ctx.building?.level)||lvl)).toFixed(3))}/h at Level ${num(Math.max(1,Number(ctx.building?.level)||lvl))} (game)`:''}</div>`:'';
    if(!r.ok){out.innerHTML=`<div class="planner-profit-empty">${escapeHtml(sale?r.error:`No market or VWAP price captured for ${ctx.product||'this product'} Q${ctx.quality} yet.`)}</div>${nextRunNote}`;try{renderPlannerInsights(host);}catch(e){console.error('Smart insights render failed',e);}return;}
    const tone=v=>v>0.0001?'is-profit':v<-0.0001?'is-loss':'';
    const perLevel=v=>v*r.unitsPerHour/ctx.level;
    // Game basis = the game's Profit Calculator: sale price − sourcing cost (inputs + labour), no fee or transport.
    const gameUnit=r.profitPerUnit+r.feePerUnit+r.contractDiscountPerUnit+r.transportPerUnit;
    const row=(label,value,note='',cls='')=>`<div class="pp-row ${cls}"><div class="pp-label">${label}${note?`<small>${note}</small>`:''}</div><div class="pp-value">${value}</div></div>`;
    const inputRows=inputs.map(i=>row(`${escapeHtml(i.name)} Q${i.quality} × ${num(i.qtyPerUnit)}`,i.unitPrice==null?'—':`−${plannerMoney(i.unitPrice*i.qtyPerUnit)}`,i.unitPrice==null?'no price captured':`${plannerMoney(i.unitPrice)} each · ${escapeHtml(i.source)}${i.priceQuality!=null&&i.priceQuality!==i.quality?` · Q${i.priceQuality} ${i.lot?'lot':'listing'}`:''}`)).join('');
    const labourNote=wageOverride!=null?`wage override $${num(wageOverride)}/h/level · ${num(+overhead.toFixed(2))}% admin`
      :lab&&lab.game?`workers ${plannerMoney(wPU)} + admin ${plannerMoney(aPU)} (${num(+overhead.toFixed(2))}%) · game wage ${plannerMoney(wage.wage)}/h/level${ctx.robots?' (robots −3%)':''} ÷ ${num(+(unitsPerHour/Math.max(1,Number(ctx.level)||1)).toFixed(3))} units/h/level`
      :lab?`workers ${plannerMoney(wPU)} + admin ${plannerMoney(aPU)} (${num(+overhead.toFixed(2))}%) · from your ${escapeHtml(ctx.product)} Q${lab.quality} batch ${plannerDate(lab.at)}${lab.cached?' (last seen)':''}${lab.boughtUnits>=0.5?` · ${num(Math.round(lab.boughtUnits))} bought units in that lot left out`:''}${wage&&(eco.changed||!wage.fresh)?` · wage ${plannerMoney(wage.wage)}/h/level ÷ ${num(+(unitsPerHour/Math.max(1,Number(ctx.level)||1)).toFixed(3))} units/h/level`:''}`
      :`no produced ${escapeHtml(ctx.product||'')} batch in the warehouse yet — appears after the first batch, or enter a wage override`;
    const ecoSrc={'game-constants':`the game's ${eco.name(eco.current)}-economy rate, from its constants`,'phase-measured':`your ${eco.name(eco.current)}-economy rate measured earlier`,reference:`normal-economy rate ÷ (1 − your speed bonus), the game's formula`,'measured-stale':`no ${eco.name(eco.current)} rate captured yet — still the running batch's rate`}[eco.source];
    const ecoNote=eco.changed?`<div class="pp-basis pp-economy">Economy is ${escapeHtml(eco.name(eco.current))} now; ${eco.batch?.inferred&&!eco.batch?.matched?`the running batch (${num(+eco.measured.toFixed(3))}/h) started in another phase — its rate is ${num(+eco.batch.diffPct.toFixed(1))}% off the normal rate`:`the running batch started in ${escapeHtml(eco.name(eco.batch?.state))} at ${num(+eco.measured.toFixed(3))}/h`}. Profit uses ${num(+Number(unitsPerHour).toFixed(3))}/h (${escapeHtml(ecoSrc||'')}).</div>`:(eco.source==='game-constants'&&eco.diffPct!=null&&Math.abs(eco.diffPct)>1?`<div class="pp-basis pp-economy">Your running batch measures ${num(+eco.measured.toFixed(3))}/h; the game's formula gives ${num(+Number(eco.rate).toFixed(3))}/h (${num(+eco.diffPct.toFixed(1))}%). Profit uses the game's figure, as its calculator does.</div>`:'');
    const abundanceNote=calcRate>0?`<div class="pp-basis pp-economy">The game's calculator assumes ${num(C.GAME_PROFIT_CALC_ABUNDANCE_PCT)}% abundance (${num(+calcRate.toFixed(3))}/h/level), and so does this card. ${own&&own.abundancePct!=null?`Next run at your building's ${num(+own.abundancePct.toFixed(2))}% abundance (${num(+own.ratePerLevel.toFixed(3))}/h/level): ${plannerMoney(own.perLevel)} / h / level, ${plannerMoney(own.netPerLevel)} after ${c.sellMode==='exchange'?'fee':'discount'} &amp; transport.`:`Your building's own abundance isn't captured yet — open the building in the game once.`}</div>`:'';
    // Research progress for this product (/api/v3/players/research/).
    const rs=(Array.isArray(ctx.s?.endpointData?.['/api/v3/players/research/']?.data)?ctx.s.endpointData['/api/v3/players/research/'].data:[]).find(x=>Number(x?.kind)===productId);
    const researchNote=rs?`<div class="pp-basis">Research level Q${num(rs.quality)} · ${num(rs.patents)} / ${num(rs.patentsNeeded)} patents for the next level</div>`:'';
    const sellLabel=c.sellMode==='exchange'?`Exchange fee ${num(+feePct.toFixed(2))}%`:`Contract discount ${num(c.contractDiscountPct)}%`;
    const busy=ctx.building?.raw?.busy?.resource;
    const batchCost=busy&&Number(busy.kind)===productId&&Number(busy.unitCost)>0?Number(busy.unitCost):null;
    out.innerHTML=`<div class="pp-stats"><div class="pp-stat ${tone(gameUnit)}"><strong>${plannerMoney(perLevel(gameUnit))}</strong><span>Profit / h / level</span></div><div class="pp-stat ${tone(gameUnit)}"><strong>${plannerMoney(gameUnit*r.unitsPerHour)}</strong><span>Profit / h · Level ${ctx.level}</span></div><div class="pp-stat ${tone(gameUnit)}"><strong>${plannerMoney(gameUnit)}</strong><span>Profit / unit</span></div></div>
<div class="pp-basis">Same basis as the game’s Profit Calculator (before market fee &amp; transport).</div>${ecoNote}${nextRunNote}${abundanceNote}${researchNote}${batchCost!=null?`<div class="pp-batch"><div><strong>$${batchCost.toLocaleString(undefined,{minimumFractionDigits:3,maximumFractionDigits:3})}</strong><span>Cost per unit · running batch (game)</span></div><small>What the game charged for the batch in progress: the inputs it actually consumed when the batch started + labour. “Sourcing cost / unit” below is what a new batch would cost at today’s warehouse costs (the game’s Profit Calculator figure). Difference ${plannerMoney(batchCost-(r.inputCostPerUnit+r.labourPerUnit))}.</small></div>`:''}
<div class="pp-stats pp-stats-net"><div class="pp-stat ${tone(r.profitPerHourPerLevel)}"><strong>${plannerMoney(r.profitPerHourPerLevel)}</strong><span>/ h / level after ${c.sellMode==='exchange'?'fee':'discount'} &amp; transport</span></div><div class="pp-stat ${tone(r.profitPerUnit)}"><strong>${plannerMoney(r.profitPerUnit)}</strong><span>/ unit after ${c.sellMode==='exchange'?'fee':'discount'} &amp; transport</span></div></div>
<div class="pp-list">
${row('Sale price (market, any quality)',plannerMoney(sale.price),`${escapeHtml(sale.source)} · Q${sale.quality} listing`)}
${inputRows}
${row('Labour (incl. admin)',r.labourPerUnit>0?`−${plannerMoney(r.labourPerUnit)}`:'—',labourNote)}
${row('Sourcing cost / unit',plannerMoney(r.inputCostPerUnit+r.labourPerUnit),'inputs + labour','pp-sub')}
${row('Profit / unit (game basis)',plannerMoney(gameUnit),'','pp-total')}
${row(sellLabel,`−${plannerMoney(r.feePerUnit+r.contractDiscountPerUnit)}`)}
${row('Transport',`−${plannerMoney(r.transportPerUnit)}`,`${num(ctx.transportUnits)} units × ${plannerMoney(transport?.price??0)}`)}
${row('Profit / unit after fee &amp; transport',plannerMoney(r.profitPerUnit),'','pp-total')}
${row('Break-even sale price',plannerMoney(r.breakEvenPrice))}
${row('Production / h',num(r.unitsPerHour),`Level ${ctx.level} · ${num(+(r.unitsPerHour/ctx.level).toFixed(3))} per level · ${eco.changed?(eco.source==='measured-stale'?'running batch rate (economy changed)':`${escapeHtml(eco.name(eco.current))} economy rate, see note above`):calcRate>0?`game's calculator rate at ${num(C.GAME_PROFIT_CALC_ABUNDANCE_PCT)}% abundance`:eco.source==='game-constants'?'game formula (constants), as the game':'measured rate from this card'}`)}

</div>${r.incomplete?`<div class="planner-profit-empty">Missing price for: ${escapeHtml(r.missingInputs.join(', '))}. Those inputs are not counted.</div>`:''}`;
    try{renderPlannerInsights(host);}catch(e){console.error('Smart insights render failed',e);}
  };
  const save=mut=>{const c=plannerProfitSettings();mut(c);savePlannerProfitSettings(c);results();};
  el.querySelector('#ppSellMode').onchange=e=>{save(c=>{c.sellMode=e.target.value;});renderPlannerProfit(host);};
  el.querySelector('#ppFee')?.addEventListener('input',e=>save(c=>{c.exchangeFeePct=e.target.value;}));
  el.querySelector('#ppDiscount')?.addEventListener('input',e=>save(c=>{c.contractDiscountPct=e.target.value;}));
  el.querySelector('#ppWage').addEventListener('input',e=>save(c=>{c.wages[wageKey]=e.target.value;}));
  el.querySelector('#ppOverhead').addEventListener('input',e=>save(c=>{c.adminOverheadPct=e.target.value;}));
  el.querySelector('#ppInputSource').onchange=e=>save(c=>{c.inputSource=e.target.value;});
  results();
}
// Smart insights under the profit card: (1) best product for this building, (2) input run-out for all
// buildings with a suggested buy, (3) make or buy each input. Same basis as the game's Profit Calculator (tools-core
// gameCalcProduct reproduces the card's $151.04 / $422.05 / $474.45). No new network requests.
function plannerInsightsData(ctx){
  const C=globalThis.SCM_TOOLS_CORE,s=ctx?.s,gc=s?.gameConstants;
  if(!C?.gameCalcProduct||!C.gameConstantsOk?.(gc))return {ok:false,reason:'Game constants not loaded yet — they load on their own; if this stays, press Sync.'};
  const economyState=plannerEconomyNow(s);
  if(economyState==null)return {ok:false,reason:'Economy phase not captured yet — open the game once.'};
  const cfg=plannerProfitSettings(),setNum=v=>v!==''&&v!=null&&Number.isFinite(Number(v));
  const gameAdmin=plannerGameAdmin(s),lotAdmin=plannerAdminOverheadFromLots(s);
  const adminPct=setNum(cfg.adminOverheadPct)?Number(cfg.adminOverheadPct):(gameAdmin?.pct??lotAdmin?.pct??0);
  const isMarket=cfg.inputSource==='market'||cfg.inputSource==='market-any',lots=plannerWarehouseLots(s);
  const inputCostOf=id=>{if(!isMarket){const w=C.warehouseUnitCostAsGame(lots,id);if(w)return w.unitCost;}const p=plannerMarketPrice(s,id,0,cfg.inputSource==='market'?'min':'any');return p?p.price:null;};
  const recipes=Array.isArray(ctx.recipes)?ctx.recipes:[];
  const nameOf=id=>{try{return plannerResourceNameById(recipes,id,s)||`#${id}`;}catch{return `#${id}`;}};
  const eventPctOf=id=>{try{return plannerEventPct(s,id);}catch{return 0;}};
  return {ok:true,C,s,gc,economyState,adminPct,bonusPct:Number(ctx.bonusPct)||0,inputCostOf,nameOf,eventPctOf};
}
// Analyze tab context: the same price, warehouse and game-calculator helpers the Production cards use, so
// Analyze numbers match them. Reads stored state only (no network); products by resource id + quality.
function analyzeContext(s){
  const lots=plannerWarehouseLots(s),realm=validRealmNumber(s?.viewRealm??s?.selectedRealm??s?.authData?.authCompany?.realmId);
  let d=null;try{d=plannerInsightsData({s,recipes:[],bonusPct:plannerBonusPct(s)});}catch{}
  const owned=Array.isArray(s?.buildings)?s.buildings:[];
  const maker=id=>owned.find(b=>Number(b?.busy?.resource?.kind??b?.busy?.resource?.resourceId)===Number(id))||owned.find(b=>Number(b?.pinnedResource)===Number(id))||null;
  return {realm,lots,buildingIds:owned.map(b=>Number(b?.id)).filter(id=>id>0),companyName:s?.authData?.authCompany?.company||'',
    nameOf:id=>resourceName({_id:Number(id),kind:Number(id)},s),
    // CSV import: the background stores it (realm-keyed queues; captured data wins).
    importCsv:msg=>chrome.runtime.sendMessage(msg),
    priceOf:(id,q)=>{const p=plannerMarketPrice(s,id,q,'exact');return p&&Number(p.price)>0?{price:Number(p.price),source:p.source||''}:null;},
    // Transport units per unit sold: game constants (.transportation), else the bundled recipes.
    transportOf:id=>{const gv=s?.gameConstants?.resources?.[String(id)]?.transportation,g=gv==null||gv===''?NaN:Number(gv);if(Number.isFinite(g)&&g>=0)return g;const r=(window.__scmBuildingPlannerRaw?.recipes||[]).find(x=>Number(x?.id)===Number(id));const t=Number(r?.transport);return Number.isFinite(t)&&t>=0?t:null;},
    calcOf:(id,q,salePrice)=>{
      if(!d?.ok)return {ok:false,reason:d?.reason||'Calculator not available.'};
      const b=maker(id);
      return d.C.gameCalcProduct({c:d.gc,resourceId:Number(id),economyState:d.economyState,eventPct:d.eventPctOf(Number(id)),bonusPct:d.bonusPct,adminPct:d.adminPct,robots:Boolean(b?.robotsSpecialization),salePrice,inputCostOf:d.inputCostOf,abundancePct:b?plannerAbundancePct(s,b.id,Number(id)):null});
    }};
}
function renderPlannerInsights(host){
  const el=host?.querySelector?.('#plannerInsights'),ctx=host?.__plannerProfitCtx;
  if(!el||!ctx)return;
  const d=plannerInsightsData(ctx);
  if(!d.ok){el.innerHTML=`<div class="planner-profit-empty">${escapeHtml(d.reason)}</div>`;return;}
  const {C,s,gc,economyState,adminPct,bonusPct,inputCostOf,nameOf,eventPctOf}=d;
  const row=(label,value,note='',cls='')=>`<div class="pp-row ${cls}"><div class="pp-label">${label}${note?`<small>${note}</small>`:''}</div><div class="pp-value">${value}</div></div>`;
  const tone=v=>v>0.0001?'si-good':v<-0.0001?'si-bad':'';
  // (1) Best product for the selected building.
  const kind=String(ctx.buildingKind||''),lvl=Math.max(1,Number(ctx.level)||1);
  const ranked=C.rankBuildingProducts({c:gc,buildingKind:kind,economyState,bonusPct,adminPct,robots:Boolean(ctx.robots),eventPctOf,priceOf:id=>plannerMarketPrice(s,id,0,'any'),inputCostOf});
  const curId=Number(ctx.productId),cur=ranked.find(x=>x.resourceId===curId),best=ranked.find(x=>x.profitPerHourPerLevel!=null&&x.complete);
  let verdict='';
  if(best&&cur&&cur.profitPerHourPerLevel!=null&&best.resourceId!==curId){const gain=best.profitPerHourPerLevel-cur.profitPerHourPerLevel,pct=cur.profitPerHourPerLevel>0?gain/cur.profitPerHourPerLevel*100:null;verdict=gain>0.005?`Switching to <b>${escapeHtml(nameOf(best.resourceId))}</b> earns ${plannerMoney(gain*lvl)}/h more at level ${num(lvl)}${pct!=null?` (+${num(+pct.toFixed(1))}%)`:''}.`:'';}
  else if(best&&best.resourceId===curId)verdict=`${escapeHtml(nameOf(curId))} is already the best product for this building.`;
  const priced=ranked.filter(x=>x.profitPerHourPerLevel!=null),unpriced=ranked.filter(x=>x.profitPerHourPerLevel==null);const top=priced.slice(0,5);if(cur&&!top.includes(cur))top.push(cur);
  const srcShort=v=>String(v||'').split(' — ')[0].replace('cheapest exchange listing, any quality (as game)','exchange').replace('SimcoTools, cheapest captured quality','SimcoTools').replace('Game ticker (lowest Q0 ask)','Game ticker');
  // Profit / h / level in each economy phase (same prices; the game's rate and labour per unit change).
  const phaseOf=x=>x.complete&&x.salePrice!=null?C.phaseProfits({c:gc,resourceId:x.resourceId,bonusPct,adminPct,robots:Boolean(ctx.robots),eventPct:eventPctOf(x.resourceId),salePrice:x.salePrice,inputCostOf}):null;
  const phases=new Map(priced.map(x=>[x.resourceId,phaseOf(x)]));
  const phaseKeys=Object.keys(gc.core.SALARY_MID);
  const pname=st=>{const n=C.economyName?C.economyName(st):String(st);return n.charAt(0).toUpperCase()+n.slice(1);};
  const phaseLine=x=>{const ph=phases.get(x.resourceId);if(!ph)return '';return phaseKeys.map(st=>{const v=ph[st];const txt=`${pname(st)} ${v==null?'—':plannerMoney(v)}`;return Number(st)===Number(economyState)?`<b>${txt}</b>`:txt;}).join(' · ');};
  const bestByPhase=phaseKeys.map(st=>{let b=null;for(const [id,ph] of phases){if(ph&&ph[st]!=null&&(!b||ph[st]>b.v))b={id,v:ph[st]};}return {st,b};});
  const phaseBestDiffers=bestByPhase.some(x=>x.b&&best&&x.b.id!==best.resourceId);
  const phaseVerdict=phaseBestDiffers?`<div class="pp-basis si-phase">Best by phase: ${bestByPhase.map(x=>`${pname(x.st)} ${x.b?escapeHtml(nameOf(x.b.id)):'—'}`).join(' · ')}</div>`:'';
  const bestRows=top.map(x=>{const v=x.profitPerHourPerLevel;const note=[x.sale?`sale ${plannerMoney(x.sale.price)} (${escapeHtml(srcShort(x.sale.source))})`:'no price captured',x.complete?`cost ${plannerMoney(x.sourcingCostPerUnit)}/unit`:`cost unknown — no price for ${escapeHtml(x.missing.map(nameOf).join(', '))}`].filter(Boolean).join(' · ')+(phases.get(x.resourceId)?`<br><span class="si-phase">${phaseLine(x)}</span>`:'');return row(`${escapeHtml(nameOf(x.resourceId))}${x.resourceId===curId?' <em class="si-tag">current</em>':''}`,v==null?'—':`<span class="${tone(v)}">${plannerMoney(v)}</span>`,note,x===best?'si-best':'');}).join('');
  const sec1=`${verdict?`<div class="pp-basis si-verdict">${verdict}</div>`:''}${phaseVerdict}${ranked.length?`${top.length?`<div class="pp-list">${bestRows}</div>`:''}${unpriced.filter(x=>x!==cur).length?`<div class="pp-basis">No price captured yet: ${escapeHtml(unpriced.filter(x=>x!==cur).map(x=>nameOf(x.resourceId)).join(', '))}</div>`:''}`:'<div class="planner-profit-empty">No tradable products for this building in the game constants.</div>'}`;
  el.innerHTML=`${sec1}<div class="pp-basis">Game Profit Calculator basis (before fee &amp; transport) · admin ${num(+adminPct.toFixed(2))}% · sale = cheapest listing any quality, else VWAP.</div>`;
  try{renderPlannerPayback(host,d);}catch(e){console.error('Upgrade payback render failed',e);}
}
// Upgrade payback: construction materials for the next level (constructionMaterialPlan: game costUnits × level,
// valued at the cheapest market price) ÷ the extra level's profit / h (game Profit Calculator basis, own abundance).
function renderPlannerPayback(host,d){
  const el=host?.querySelector?.('#plannerPayback'),ctx=host?.__plannerProfitCtx;
  if(!el||!ctx)return;
  if(!d?.ok){el.innerHTML=`<div class="planner-profit-empty">${escapeHtml(d?.reason||'')}</div>`;return;}
  const {C,s,gc,economyState,adminPct,bonusPct,inputCostOf,nameOf,eventPctOf}=d;
  const owned=Array.isArray(ctx.owned)?ctx.owned:[];
  const dur=h=>h==null?'—':h<48?`${num(+h.toFixed(1))} h`:`${num(+(h/24).toFixed(1))} d`;
  const rows=[];
  // Extra admin per hour from one more level: wages of every producing level × (1/170) × (1 − COO%).
  let ga=null;try{ga=plannerGameAdmin(s);}catch{}
  const coo=Number(ga?.coo)||0,dAdmin=C.adminIncreasePerLevel(coo);
  const wageAll=owned.filter(b=>Number(b.currentResourceId)>0).reduce((a,b)=>a+(Number(C.gameWagePerLevel(gc,String(b.kind||''),Boolean(b.robotsSpecialization)))||0)*Math.max(1,Number(b.level)||1),0);
  for(const b of owned){
    const pid=Number(b.currentResourceId),lvl=Math.max(1,Number(b.level)||1);
    if(!(pid>0))continue;
    if(lvl>=20){rows.push({b,lvl,max:true});continue;}
    const bd=Number(C.buildingConst?.(gc,scmSimcoData(s,'simcoBuildings'),String(b.kind||''))?.buildDuration),upHours=bd>0?lvl*bd/3600:0;
    const extraAdmin=(wageAll+(Number(C.gameWagePerLevel(gc,String(b.kind||''),Boolean(b.robotsSpecialization)))||0))*dAdmin;
    const sale=plannerMarketPrice(s,pid,0,'any');
    const res=C.gameCalcProduct({c:gc,resourceId:pid,economyState,eventPct:eventPctOf(pid),bonusPct,adminPct,robots:Boolean(b.robotsSpecialization),salePrice:sale?.price??null,inputCostOf,abundancePct:plannerAbundancePct(s,b.raw?.id??b.id,pid)});
    let plan=null;try{plan=constructionMaterialPlan(s,b,lvl,lvl+1,0);}catch{}
    const items=(plan?.items||[]).map(it=>{const p=plannerMarketPrice(s,it.id,0,'any');const price=p?.price??null;return {...it,price};});
    const missing=items.filter(it=>it.price==null).map(it=>it.name);
    const cost=items.length&&!missing.length?items.reduce((a,it)=>a+Number(it.required)*it.price,0):null;
    const gain=res.ok&&res.complete?res.profitPerHourPerLevel:null;
    rows.push({b,lvl,pid,cost,gain,missing,unavailable:!items.length,upHours,extraAdmin,pay:C.upgradePaybackFull({cost,gainPerHour:gain,currentProfitPerHour:gain!=null?gain*lvl:0,upgradeHours:upHours,extraAdminPerHour:extraAdmin})});
  }
  rows.sort((a,b)=>(a.pay?.hours==null)-(b.pay?.hours==null)||(a.pay?.hours??0)-(b.pay?.hours??0));
  const row=(label,value,note='',cls='')=>`<div class="pp-row ${cls}"><div class="pp-label">${label}${note?`<small>${note}</small>`:''}</div><div class="pp-value">${value}</div></div>`;
  const html=rows.map((r,i)=>{
    const label=`${escapeHtml(r.b.name)} <em class="si-tag">L${num(r.lvl)}${r.max?'':`→${num(r.lvl+1)}`}</em>`;
    if(r.max)return row(label,'max','already level 20');
    const note=[r.unavailable?'construction cost not available (game constants missing)':r.missing.length?`no price for ${escapeHtml(r.missing.join(', '))}`:`materials ${plannerMoney(r.cost)}`,r.gain==null?'profit unknown (missing price)':`${r.gain>0?'+':''}${plannerMoney(r.gain)}/h from ${escapeHtml(nameOf(r.pid))} − ${plannerMoney(r.extraAdmin)}/h more admin`,r.upHours>0?`upgrade ${dur(r.upHours)}${r.pay.lostProfit>0?`, ${plannerMoney(r.pay.lostProfit)} profit lost`:''}`:''].filter(Boolean).join(' · ');
    const v=r.pay.hours!=null?`<span class="${r.pay.hours<72?'si-good':r.pay.hours<336?'si-warn':'si-bad'}">${dur(r.pay.hours)}</span>`:r.pay.reason==='not-profitable'&&r.gain!=null?'<span class="si-bad">never</span>':'—';
    return row(label,v,note,i===0&&r.pay.hours!=null?'si-best':'');
  }).join('');
  el.innerHTML=rows.length?`<div class="pp-list">${html}</div><div class="pp-basis">Payback from the start of the upgrade = upgrade time (level × build time; the building doesn't produce) + (materials at the cheapest market price + profit lost while upgrading) ÷ (extra profit / h − extra admin / h). Extra admin: one more level adds 1/170 to the base overhead${coo?`, ${num(coo)}% less with your COO`:''}, on the wages of every producing building (game formula). Upgrade-speed boosts are not counted. Green &lt; 3 days, orange &lt; 2 weeks.</div>`:'<div class="planner-profit-empty">No building is producing anything right now.</div>';
}
// Inputs run-out & make or buy lives on the Warehouse tab (all buildings). ctx: {s, recipes,
// owned, runHours, bonusPct}. Returns HTML.
function plannerRunOutHtml(ctx){
  const d=plannerInsightsData(ctx);
  if(!d.ok)return `<div class="planner-profit-empty">${escapeHtml(d.reason)}</div>`;
  const {C,s,gc,economyState,adminPct,bonusPct,inputCostOf,nameOf,eventPctOf}=d;
  const row=(label,value,note='',cls='')=>`<div class="pp-row ${cls}"><div class="pp-label">${label}${note?`<small>${note}</small>`:''}</div><div class="pp-value">${value}</div></div>`;
  const owned=Array.isArray(ctx.owned)?ctx.owned:[];
  const specs=owned.map(b=>({id:b.id,name:b.name,kind:String(b.kind||''),level:Number(b.level)||1,productId:Number(b.currentResourceId),quality:Number(b.currentQuality)||0,raw:b.raw})).filter(b=>b.productId>0);
  const hours=Math.max(1,Number(ctx.runHours)||24);
  const runout=C.inputRunOut({c:gc,buildings:specs,economyState,bonusPct,eventPctOf,abundanceOf:(b,pid)=>plannerAbundancePct(s,b.raw?.id??b.id,pid),lots:plannerWarehouseLots(s),hours});
  const ownedKinds=new Map();for(const b of owned){const k=String(b.kind||'');if(k&&!ownedKinds.has(k))ownedKinds.set(k,b);}
  const lasts=h=>h==null?'covered':h<1?`${num(Math.round(h*60))} min`:h<48?`${num(+h.toFixed(1))} h`:`${num(+(h/24).toFixed(1))} d`;
  const lastCls=h=>h==null?'si-good':h<6?'si-bad':h<hours?'si-warn':'si-good';
  const runRows=runout.map(r=>{
    const mk=plannerMarketPrice(s,r.id,r.minQuality,'min');
    const maker=owned.find(b=>Number(b?.currentResourceId)===Number(r.id))||owned.find(b=>Number(b?.pinnedResource)===Number(r.id))||ownedKinds.get(String(gc.resources[String(r.id)]?.producedAt??''));
    let own=null,ownMissing='';if(maker){const res=C.gameCalcProduct({c:gc,resourceId:r.id,economyState,eventPct:eventPctOf(r.id),bonusPct,adminPct,robots:Boolean(maker.robotsSpecialization),inputCostOf,abundancePct:plannerAbundancePct(s,maker.raw?.id??maker.id,r.id)});if(res.ok&&res.complete)own=res.sourcingCostPerUnit;else if(res.ok)ownMissing=res.missing.map(nameOf).join(', ');}
    const mob=C.makeOrBuy(own,mk?.price);
    const mkTag=mk?.srcLabel?` <small>${escapeHtml(mk.srcLabel)}</small>`:'';const mobText=mob.verdict==='make'?`<span class="si-good">Make</span>: your cost ${plannerMoney(mob.ownCost)} vs market ${plannerMoney(mob.marketPrice)}${mkTag} — saves ${plannerMoney(mob.savesPerUnit)}/unit (${num(+mob.savesPct.toFixed(1))}%)`:mob.verdict==='buy'?`<span class="si-bad">Buy</span>: market ${plannerMoney(mob.marketPrice)}${mkTag} vs your cost ${plannerMoney(mob.ownCost)} — ${plannerMoney(mob.savesPerUnit)}/unit cheaper (${num(+mob.savesPct.toFixed(1))}%)`:maker&&mob.verdict==='no-price'?`Your cost ${plannerMoney(mob.ownCost)}/unit · no market price captured`:maker&&ownMissing?`Make or buy: your cost unknown — no price for ${escapeHtml(ownMissing)}`:'';
    const buyText=r.buyQty>0?` · buy ${num(r.buyQty)} for ${num(hours)} h${mk?` ≈ ${plannerMoney(r.buyQty*mk.price)} (${plannerMoney(mk.price)} Q${mk.quality}${mk.srcLabel?` · ${escapeHtml(mk.srcLabel)}`:''})`:''}`:'';
    const note=`Stock ${num(Math.floor(r.stock))} (Q${r.minQuality}+) · uses ${num(+r.usePerHour.toFixed(2))}/h${r.madePerHour>0?` − makes ${num(+r.madePerHour.toFixed(2))}/h`:''}${buyText}${mobText?`<br>${mobText}`:''}`;
    return row(`${escapeHtml(nameOf(r.id))}`,`<span class="${lastCls(r.hoursLeft)}">${lasts(r.hoursLeft)}</span>`,note);
  }).join('');
  return `${runout.length?`<div class="pp-list">${runRows}</div>`:'<div class="planner-profit-empty">No building is producing anything with inputs right now.</div>'}<div class="pp-basis">Rates from the game's formula (${escapeHtml(C.economyName?C.economyName(economyState):String(economyState))} economy) for each building's current output. Buy quantity covers the Production Time (${num(hours)} h). “Your cost” = inputs at warehouse cost + labour, the game's Profit Calculator basis; making also uses building time.</div>`;
}
let __scmWhRunOutToken=0;
function renderWarehouseRunOut(s){
  const el=$('#warehouseRunOut');if(!el||!s)return;
  const token=++__scmWhRunOutToken;
  loadBuildingPlannerData().then(data=>{
    if(token!==__scmWhRunOutToken)return;
    let ui=null;try{ui=plannerUiState(s);}catch{}
    const runHours=Math.min(48,Math.max(1,Number(ui?.runHours)||Number(s?.productionRunHours)||24));
    const owned=ownedPlannerBuildings(s,data.buildings);
    el.innerHTML=plannerRunOutHtml({s,recipes:data.recipes,owned,runHours,bonusPct:plannerBonusPct(s)});
  }).catch(e=>{if(token===__scmWhRunOutToken)el.innerHTML=`<div class="planner-profit-empty">Could not calculate: ${escapeHtml(String(e?.message||e))}</div>`;});
}
// Planner repaint guard. Background/storage-driven repaints (options.background) are queued while the user is editing
// anywhere in the dashboard and replayed once editing ends; user-initiated repaints (onchange handlers) always run.
function plannerRepaintBlocked(host,options){
  if(!options?.background)return false;
  let blocked=false;try{blocked=(typeof dashboardEditorActive==='function'&&dashboardEditorActive())||__dashboardUserScrolling;}catch{}
  if(!blocked)return false;
  host.__plannerPendingRepaint=true;
  clearTimeout(host.__plannerPendingTimer);
  host.__plannerPendingTimer=setTimeout(()=>plannerFlushPendingRepaint(host),400);
  return true;
}
function plannerFlushPendingRepaint(host){
  if(!host||!host.__plannerPendingRepaint||!host.isConnected)return;
  let blocked=false;try{blocked=dashboardEditorActive();}catch{}
  if(blocked){clearTimeout(host.__plannerPendingTimer);host.__plannerPendingTimer=setTimeout(()=>plannerFlushPendingRepaint(host),400);return;}
  host.__plannerPendingRepaint=false;
  const st=window.__scmState;if(!st)return;
  try{renderBuildingPlanner(scmReactiveViewState(st),{background:true});}catch(e){console.debug('planner deferred repaint failed',e);}
}
function renderBuildingPlanner(s,options={}){
  const host=$('#buildingPlanner');if(!host)return;
  if(plannerRepaintBlocked(host,options))return;
  const renderToken=String((Number(host.dataset.renderToken)||0)+1);
  host.dataset.renderToken=renderToken;
  loadBuildingPlannerData().then(async data=>{
    if(host.dataset.renderToken!==renderToken)return;
    const definitions=data.buildings, recipes=data.recipes, rates=data.rates;
    const modifierState=await ensurePlannerCompanyModifiers(s);
    if(modifierState!==s){ renderBuildingPlanner(modifierState,options); return; }
    s=await get();
    const ui=plannerUiState(s);
    const owned=ownedPlannerBuildings(s,definitions,ui.kindOverrides||{}).sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),undefined,{numeric:true,sensitivity:'base'}));
    if(!owned.length){
      host.innerHTML='<div class="building-empty-state"><h3>No building data captured yet</h3><p class="muted">Open your logged-in Sim Companies game page and let the Manager capture your current buildings, then return here. Full Sync also keeps the captured building data in the selected realm.</p></div>';
      return;
    }
    const recipeBy=plannerRecipeMap(recipes);
    const currentId=ui.buildingId!=null?String(ui.buildingId):(host.dataset.buildingId||String(owned[0].id));
    const building=owned.find(b=>String(b.id)===String(currentId))||owned[0];
    ui.buildingId=String(building.id);
    let planningLevels={...ui.planningLevels};
    try{Object.assign(planningLevels,JSON.parse(host.dataset.planningLevels||'{}')||{});}catch{}
    owned.forEach(b=>{if(!Number.isFinite(Number(planningLevels[String(b.id)]))) planningLevels[String(b.id)]=Number(b.level)||1;});
    ui.planningLevels=planningLevels;
    host.dataset.buildingId=String(building.id); host.dataset.planningLevels=JSON.stringify(planningLevels);
    const level=Math.min(20,Math.max(1,Number(planningLevels[String(building.id)])||building.level||1));
    const quality=Math.min(12,Math.max(0,ui.quality!=null?Number(ui.quality):(Number(host.dataset.quality) || Number(building.currentQuality) || 0)));
    ui.quality=quality; host.dataset.quality=String(quality);
    let productOverrides={...ui.productOverrides};
    try{Object.assign(productOverrides,JSON.parse(host.dataset.productOverrides||'{}')||{});}catch{}
    ui.productOverrides=productOverrides; host.dataset.productOverrides=JSON.stringify(productOverrides);
    const manualProduct=productOverrides[String(building.id)]||'';
    const currentProduct=plannerCurrentProduct(building,recipes);
    const runHours=Math.min(48,Math.max(1,ui.runHours!=null?Number(ui.runHours):(Number(s.productionRunHours)||Number(host.dataset.runHours)||24)));
    ui.runHours=runHours; host.dataset.runHours=String(runHours);
    const product=building.produces.includes(manualProduct)?manualProduct:currentProduct;
    const productPickerValue=building.produces.includes(manualProduct)?manualProduct:'__current__';
    const productRecipe=recipeBy.get(plannerNormalizeName(product));
    // Game figures come from the shared core; a what-if (other product, level or quality) is a separate `planned` value.
    const plans=plannerBuildPlans(owned,ui,planningLevels,productOverrides);
    if(product)plans[String(building.id)]={buildingId:Number(building.id),product,quality,plannedLevel:level,mode:(ui.planModes||{})[String(building.id)]||'live'};
    const network=plannerProductionNetwork(s,owned,recipes,rates,runHours,{plans});
    const entry=network.buildings.find(e=>String(e.buildingId)===String(building.id))||null;
    // Only the user's own changes (type, output, level, quality) are what-ifs; a second network holds just those.
    const whatIfIds=new Set(owned.filter(b=>{const id=String(b.id);return Boolean(ui.kindOverrides?.[id])||Boolean(productOverrides[id])||(planningLevels[id]!=null&&Number(planningLevels[id])!==Number(b.level))||(ui.planModes||{})[id]==='planner';}).map(b=>String(b.id)));
    const whatIfPlans=Object.fromEntries(Object.entries(plans).filter(([id])=>whatIfIds.has(id)));
    const planNetwork=whatIfIds.size?plannerProductionNetwork(s,owned,recipes,rates,runHours,{plans:whatIfPlans,ctx:network.ctx}):null;
    const planned=planNetwork?.buildings.find(e=>String(e.buildingId)===String(building.id))?.planned||null;
    const productRate=product?plannerRateForProduct(product,building,level,recipes,rates,s,network.ctx):{rate:null,source:null};
    requestPlannerBuildingHistory(building,s);
    const gameRunning=Boolean(entry?.running);
    const gameRate=gameRunning?Number(entry.ratePerHour)||0:0;
    const upgrading=Boolean(building.expanding||entry?.expanding);
    const statusLabel=upgrading?'Upgrading':building.testKind?'Test building':!gameRunning?'Idle':(gameRate>0?'':'Rate unknown');
    const outputPerHour=gameRate>0||upgrading?gameRate:null;
    const outputPerPlan=outputPerHour!=null?outputPerHour*runHours:null;
    const plannedPerHour=planned&&planned.ratePerHour>0?planned.ratePerHour:null;
    const diffPerHour=planned&&plannedPerHour!=null&&gameRunning&&gameRate>0&&Number(planned.productId)===Number(entry.productId)&&Number(planned.level)!==Number(entry.level)?plannedPerHour-gameRate:null;
    const diffStat=(v,label)=>`<div class="planner-output-stat planner-output-diff ${v>0?'is-profit':v<0?'is-loss':''}"><strong>${v>0?'+':v<0?'−':''}${num(Math.abs(v))}</strong><span>${label}</span></div>`;
    const minInputQuality=Math.max(0,quality-1);
    const inputs=Array.isArray(productRecipe?.materials)?productRecipe.materials:[];
    const inputRate=planned?plannedPerHour:(gameRate>0&&entry&&Number(entry.productId)===Number(productRecipe?.id)?gameRate:null);
    const plannedInputs=inputs.map(m=>{
      const id=Number(m.id), perOutput=Number(m.quantity)||0;
      const required=inputRate!=null?perOutput*inputRate:null;
      const requiredPlan=required!=null?required*runHours:null;
      return {id,name:plannerResourceNameById(recipes,id,s),perOutput,required,requiredPlan,minQuality:minInputQuality};
    });
    const summaryNet=planNetwork?.planned||network;

    const productImage=productRecipe?.id!=null?plannerResourceImage(Number(productRecipe.id),s):'';
    const buildingImage=plannerAssetUrl(building.raw?.image);
    const kindOverrides={...(ui.kindOverrides||{})};
    const hasPlannerChange=b=>{const id=String(b.id);return Boolean(kindOverrides[id])||Boolean(productOverrides[id])||(planningLevels[id]!=null&&Number(planningLevels[id])!==Number(b.level))||(ui.planModes||{})[id]==='planner';};
    const changedCount=owned.filter(hasPlannerChange).length;
    const kindList=[...definitions].filter(d=>String(d.id)!==String(building.gameKind)&&String(d?.name||'').trim()&&(d.produces||[]).length).sort((x,y)=>String(x.name).localeCompare(String(y.name)));
    // Flat list: optgroups made Yandex's Android picker indent rows unevenly.
    const kindOpts=`<option value="__game__" ${building.testKind?'':'selected'}>Game: ${escapeHtml(building.gameName||building.name)}</option>`+kindList.map(d=>`<option value="${escapeHtml(String(d.id))}" ${building.testKind&&String(d.id)===String(building.kind)?'selected':''}>${escapeHtml(d.name)}</option>`).join('');
    const productOptions=[`<option value="__current__" ${productPickerValue==='__current__'?'selected':''}>Current output${currentProduct?` — ${escapeHtml(currentProduct)}`:''}</option>`].concat((building.produces||[]).map(p=>`<option value="${escapeHtml(p)}" ${p===productPickerValue?'selected':''}>${escapeHtml(p)}</option>`)).join('');
    const busyText=building.testKind?`Test building — game: ${escapeHtml(building.gameName)}`:building.expanding?`Under construction${building.expandFinish?` · done ${new Date(building.expandFinish).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}`:''}`:building.currentResource?`Currently producing: ${escapeHtml(building.currentResource)}${building.currentQuality!=null?` Q${escapeHtml(building.currentQuality)}`:''}`:'Currently producing: Idle';
    const levelOpts=Array.from({length:20},(_,i)=>i+1).map(v=>`<option value="${v}" ${v===level?'selected':''}>Level ${v}</option>`).join('');
    const company=plannerCompanyAuthData(s)||{};
    const productionModifier=Number(company.productionModifier);
    const salesModifier=plannerCompanySalesModifier(s);
    const modifierText=value=>Number.isFinite(value)?`${value>=0?'+':''}${value.toFixed(0)}%`:'—';
    const qOpts=Array.from({length:13},(_,q)=>`<option value="${q}" ${q===quality?'selected':''}>Q${q}</option>`).join('');

    const buildingCards=owned.map(b=>{
      const img=plannerAssetUrl(b.raw?.image);
      const testBadge=b.testKind?`<span class="owned-building-test">TEST · was ${escapeHtml(b.gameName)}</span>`:'';
      const cardOvr=(b.produces||[]).includes(productOverrides[String(b.id)])?productOverrides[String(b.id)]:null;
      const cardQ=Number(ui.qualityByBuilding?.[String(b.id)]);
      const cardPlan=cardOvr?{product:cardOvr,quality:Number.isFinite(cardQ)?cardQ:(b.currentQuality??0)}:b.testKind?{product:b.produces?.[0]||'',quality:Number.isFinite(cardQ)?cardQ:0}:b.productionPlan||null;
      const cardProduct=String(cardPlan?.product||plannerCurrentProduct(b,recipes)||'').trim();
      const cardQuality=Number.isFinite(Number(cardPlan?.quality))?Number(cardPlan.quality):b.currentQuality;
      const cardRecipe=cardProduct?recipeBy.get(plannerNormalizeName(cardProduct)):null;
      const cardInputs=(cardRecipe?.materials||[]).map(m=>`${plannerResourceNameById(recipes,Number(m.id),s)}${cardQuality!=null?` Q${Math.max(0,Number(cardQuality)-1)}`:''}`).filter(Boolean);
      const outputLabel=cardProduct?`${cardProduct}${cardQuality!=null?` Q${cardQuality}`:''}`:'Idle';
      const inputLabel=cardInputs.length?cardInputs.join(' · '):'None';
      const constructionLine=b.expanding?'<span class="owned-building-io owned-building-construction"><b>Under construction</b></span>':'';
      // Abundance (game's /api/v2/companies/buildings/<id>/abundance/) for mines, oil rigs and quarries.
      const TC=globalThis.SCM_TOOLS_CORE,cardResId=Number(cardRecipe?.id);
      const cardAb=cardResId>0&&TC?.isAbundanceResource?.(cardResId)?plannerAbundancePct(s,b.raw?.id??b.id,cardResId):undefined;
      const abundanceLine=cardAb===undefined?'':cardAb==null?`<span class="owned-building-io owned-building-abundance ab-none"><b>Abundance:</b> not captured${scmTimerOff('abundanceOnLoad')?' · off in Background timers':''}</span>`:`<span class="owned-building-io owned-building-abundance ab-${TC.abundanceTone(cardAb)}"><b>Abundance:</b> <em>${num(+cardAb.toFixed(2))}%</em></span>`;
      return `<button type="button" class="owned-building-card ${String(b.id)===String(building.id)?'active':''}" data-building-id="${escapeHtml(String(b.id))}"><div class="owned-building-image-wrap">${b.testKind?`<span class="owned-building-image planner-icon-fallback">${plannerBuildingIcon(b.category)}</span>`:plannerImage(img,b.name,'owned-building-image',plannerBuildingIcon(b.category))}<span class="owned-building-level">Level ${b.level}${Number(planningLevels[String(b.id)])!==Number(b.level)?` · Plan ${Number(planningLevels[String(b.id)])}`:''}</span></div><strong>${escapeHtml(b.name)}</strong>${testBadge}<span class="owned-building-io owned-building-output"><b>Output:</b> ${escapeHtml(outputLabel)}</span><span class="owned-building-io owned-building-inputs"><b>Inputs:</b> ${escapeHtml(inputLabel)}</span>${constructionLine}${abundanceLine}</button>`;
    }).join('');

    const rows=plannedInputs.map(x=>{
      const img=plannerResourceImage(x.id,s);
      const qualityLabel=`Q${x.minQuality}`;
      return `<tr><td><div class="planner-resource-cell">${plannerImage(img,x.name,'planner-resource-icon')}<span><strong>${escapeHtml(x.name)} (${qualityLabel})</strong></span></div></td><td>${x.required==null?'—':num(x.required)}</td><td>${x.requiredPlan==null?'—':num(x.requiredPlan)}</td></tr>`;
    }).join('');

    const discount=plannerDiscountPercent(ui.discount!=null?ui.discount:host.dataset.discount);
    ui.discount=discount; host.dataset.discount=String(discount);
    const discountOpts=Array.from({length:11},(_,i)=>i).map(v=>`<option value="${v}" ${v===discount?'selected':''}>${v}%</option>`).join('');
    // Freeze the captured resource-id + quality market-price mapping for this render.
    // Discount changes operate only on these frozen quotes; the mapping itself
    // is never recomputed by the selector.
    const deficitBase=summaryNet.deficits.map(x=>plannerDiscountQuote(s,x,'deficit',0));
    const surplusBase=summaryNet.surpluses.map(x=>plannerDiscountQuote(s,x,'surplus',0));
    const applyDiscount=(quote,pct)=>({...quote,discount:pct,unitPrice:quote.marketPrice!=null?roundCurrencyUp(quote.marketPrice*(1-pct/100)):null,total:quote.marketPrice!=null&&quote.amount>0?roundCurrencyUp(roundCurrencyUp(quote.marketPrice*(1-pct/100))*quote.amount):null});
    const deficitQuotes=deficitBase.map(q=>applyDiscount(q,discount));
    const surplusQuotes=surplusBase.map(q=>applyDiscount(q,discount));
    const summaryRows=(quotes,type)=>quotes.length?quotes.map(q=>{
      return `<div class="planner-summary-row"><div class="planner-summary-resource">${plannerImage(plannerResourceImage(q.id,s),q.name,'planner-summary-icon')}<span>${escapeHtml(q.name)}<small>Q${q.quality}${q.marketPriceQuality!=null&&Number(q.marketPriceQuality)!==Number(q.quality)?` · market Q${q.marketPriceQuality}`:''}</small></span></div><strong>${type==='deficit'?'-':'+'}${num(q.amount)}</strong><span class="planner-summary-money" data-market-price="${q.marketPrice??''}" data-amount="${q.amount}" data-summary-type="${type}"><small>Market</small> ${plannerMoney(q.marketPrice)}${q.marketPriceSrc?` <small>${escapeHtml(q.marketPriceSrc)}</small>`:''}<br><small>Est. ${type==='deficit'?'Buy Cost':'Sale Value'} · ${q.discount}% discount</small> ${plannerMoney(q.total)} <small>(${plannerMoney(q.unitPrice)} / unit)</small></span></div>`;
    }).join(''):`<div class="planner-summary-empty">No ${type}s for this production plan.</div>`;
    // Text-box format: keep the resource reference separated by spaces
    // so the Sim Companies chat parser renders :re-###: as an image. Keep each
    // material on one unbroken line and use the same compact layout the user
    // verified manually in-game.
    const textHeader=type=>type==='deficit'?`==============================\n🔽🔽🔽 BUYING -${discount}% MARKET 🔽🔽🔽`: `==============================\n🔽🔽🔽 SELLING -${discount}% MARKET 🔽🔽🔽`;
    const textRows=(quotes,type)=>{
      if(!quotes.length) return {plain:`No ${type}s for this production plan.`,html:`<div class="planner-copy-empty">No ${type}s for this production plan.</div>`};
      const rows=quotes.map(q=>{
        const code=`:re-${Number(q.id)}:`;
        const priceQuality=q.marketPriceQuality!=null&&Number(q.marketPriceQuality)!==Number(q.quality)?` (market Q${q.marketPriceQuality})`:'';const plain=`➡️ ${num(q.amount)} - Q${q.quality} ${q.name}${priceQuality} ${code} - ${q.unitPrice!=null?money(q.unitPrice):'Market unavailable'}${q.unitPrice!=null&&q.marketPriceSrc?` (${q.marketPriceSrc})`:''}`;
        return {plain,html:`<div class="planner-copy-line"><span>${escapeHtml(plain)}</span></div>`};
      });
      return {plain:rows.map(r=>r.plain).join('\n'),html:rows.map(r=>r.html).join('')};
    };
    const deficitTextRows=textRows(deficitQuotes,'deficit');
    const surplusTextRows=textRows(surplusQuotes,'surplus');
    const deficitCopyText=`${textHeader('deficit')}\n${deficitTextRows.plain}\n==============================`;
    const surplusCopyText=`${textHeader('surplus')}\n${surplusTextRows.plain}\n==============================`;
    const constructionPlans=owned.map(b=>{
      const target=Math.min(20,Math.max(1,Number(planningLevels[String(b.id)])||b.level||1));
      return {building:b,plan:constructionMaterialPlan(s,b,b.level,target,discount)};
    }).filter(x=>Number(x.plan.stepFactor||0)>0);
    // Aggregate requirements across all planned buildings first, then apply
    // warehouse stock once per material. Quality is intentionally ignored:
    // every owned unit counts toward the construction need.
    const constructionTotals=new Map();
    constructionPlans.forEach(({plan})=>plan.items.forEach(item=>{
      const key=String(item.id), prev=constructionTotals.get(key);
      if(prev){
        prev.required+=Number(item.required)||0;
      }else{
        constructionTotals.set(key,{...item,required:Number(item.required)||0});
      }
    }));
    const constructionRequirementItems=[...constructionTotals.values()].map(item=>{
      const warehouseQty=constructionWarehouseStock(s,item.id);
      const amount=Math.max(0,roundResourceDown(Number(item.required)-warehouseQty,3));
      const price=item.price!=null?Number(item.price):null;
      const lineTotal=Number.isFinite(price)?roundCurrencyUp(price*amount):null;
      return {...item,warehouseQty,amount,quality:0,lineTotal};
    });
    const constructionTotalItems=constructionRequirementItems.filter(x=>x.amount>0);
    const constructionTotalCost=roundCurrencyUp(constructionTotalItems.reduce((sum,x)=>sum+(x.lineTotal!=null?Number(x.lineTotal)||0:0),0));
    const constructionMissing=constructionMissingCount(constructionTotalItems);
    const constructionTextRows=constructionTotalItems.length?{
      plain:`${textHeader('deficit')}\n${constructionTotalItems.map(x=>`➡️ ${num(x.amount)} - ${x.name} :re-${Number(x.id)}: - ${x.price!=null?money(x.price):'—'}${x.price!=null&&x.marketPriceSrc?` (${x.marketPriceSrc})`:''}`).join('\n')}\n==============================`,
      html:`${constructionTotalItems.map(x=>`<div class="planner-copy-line"><span>${escapeHtml(`➡️ ${num(x.amount)} - ${x.name} :re-${Number(x.id)}: - ${x.price!=null?money(x.price):'—'}${x.price!=null&&x.marketPriceSrc?` (${x.marketPriceSrc})`:''}`)}</span></div>`).join('')}`
    }:{
      plain:'No additional construction materials required for the planned building levels.',
      html:'<div class="planner-copy-empty">No additional construction materials required for the planned building levels.</div>'
    };
    const constructionCopyText=constructionTotalItems.length?constructionTextRows.plain:`${textHeader('deficit')}\nNo additional construction materials required for the planned building levels.\n==============================`;
    const discountSnapshot={
      deficits:deficitQuotes,
      surpluses:surplusQuotes
    };
    host.__plannerDiscountSnapshot=discountSnapshot;
    host.__plannerConstructionRequirements=constructionRequirementItems;
    host.__plannerConstructionItems=constructionTotalItems;
    host.__plannerConstructionTotal=constructionTotalCost;host.__plannerConstructionMissing=constructionMissing;
    const totalQuotes=quotes=>roundCurrencyUp(quotes.reduce((sum,q)=>sum+(q.total!=null?q.total:0),0));
    const deficitHasValue=deficitQuotes.some(q=>q.total!=null);
    const surplusHasValue=surplusQuotes.some(q=>q.total!=null);
    const deficitTotal=deficitHasValue?plannerMoney(totalQuotes(deficitQuotes)):'—';
    const surplusTotal=surplusHasValue?plannerMoney(totalQuotes(surplusQuotes)):'—';
    // Preserve both the page position and the horizontal Buildings strip when
    // a background/storage update causes the planner to repaint. Without this,
    // replacing host.innerHTML resets the inner strip to the first building and
    // can also make mobile Chrome jump back toward the start of the planner.
    const pageScrollX=window.scrollX||window.pageXOffset||0;
    const pageScrollY=window.scrollY||window.pageYOffset||0;
    const activeField=document.activeElement;
    const activeEditSnapshot=activeField&&host.contains(activeField)&&activeField.id?{
      id:activeField.id,
      value:'value' in activeField?activeField.value:null,
      selectionStart:typeof activeField.selectionStart==='number'?activeField.selectionStart:null,
      selectionEnd:typeof activeField.selectionEnd==='number'?activeField.selectionEnd:null
    }:null;
    if(plannerRepaintBlocked(host,options))return; // user began editing while this async render was computing
    const previousBuildingsStrip=host.querySelector('.owned-buildings-strip');
    const buildingsStripScrollLeft=previousBuildingsStrip?previousBuildingsStrip.scrollLeft:0;
    const plannerHtml=`${renderProductionStrip(s,recipes)}<div class="owned-buildings-heading"><h3>Your Buildings</h3><span class="owned-building-count">Total Buildings: ${owned.length}</span></div><div class="owned-buildings-strip">${buildingCards}</div><div class="planner-speed-modifiers" aria-label="Current production and sales speed modifiers"><div class="planner-speed-modifier"><span>Production Speed</span><strong>${modifierText(productionModifier)}</strong></div><div class="planner-speed-modifier"><span>Sales Speed</span><strong>${modifierText(salesModifier)}</strong></div></div><article class="planner-main-card"><div class="planner-selected-head"><div class="planner-building-hero">${plannerImage(buildingImage,building.name,'planner-building-hero-image',plannerBuildingIcon(building.category))}<div><h3>${escapeHtml(building.name)}</h3><div class="planner-selected-category">${escapeHtml(building.category||'Resources')}</div><div class="planner-selected-line">Current Level: ${building.level} · Planning Level: ${level}</div><div class="planner-selected-line ${building.currentResource?'is-producing':''}">${busyText.replace(/·/g,'')}</div></div></div><div class="building-detail-controls"><div class="planner-kind-row"><label>Building Type<select id="buildingKind">${kindOpts}</select></label><label>Output<select id="buildingOutput" aria-label="Production output">${productOptions}</select></label></div><label>Planning Level<select id="buildingLevel">${levelOpts}</select></label><label>Production Quality<select id="buildingQuality">${qOpts}</select></label><label>Production Time<input id="buildingRunHours" type="number" min="1" max="48" step="1" value="${runHours}"><small>1–48 hours</small></label><div class="planner-reset-row">${hasPlannerChange(building)?'<button type="button" id="plannerResetBuilding">Reset to game data</button>':''}${changedCount>1||(changedCount===1&&!hasPlannerChange(building))?`<button type="button" id="plannerResetAll">Reset all (${changedCount})</button>`:''}</div></div></div><div class="planner-divider"></div><div class="planner-section-label">Production Output</div><div class="planner-output-grid${diffPerHour!=null?' has-diff':''}${planned?' has-planned':''}"><div class="planner-output-product planner-output-product-picker" title="Click to change production output">${plannerImage(productImage,product,'planner-output-image')}<div><strong>${escapeHtml(product||'No product')}</strong><span>Primary Product</span></div><select id="buildingProduct" class="planner-output-product-picker-select" aria-label="Change production output">${productOptions}</select></div><div class="planner-output-stat"><strong>${outputPerHour==null?'—':num(outputPerHour)}</strong><span>Production / hr${statusLabel?` · ${statusLabel}`:''}</span></div><div class="planner-output-stat"><strong>${outputPerPlan==null?'—':num(outputPerPlan)}</strong><span>Production / ${runHours} hr${statusLabel?` · ${statusLabel}`:''}</span></div>${planned?`<div class="planner-output-stat planner-output-planned"><strong>${plannedPerHour==null?'—':num(plannedPerHour)}</strong><span>Planned / hr · ${escapeHtml(planned.product)} Q${planned.quality} · Level ${planned.level}</span></div><div class="planner-output-stat planner-output-planned"><strong>${plannedPerHour==null?'—':num(plannedPerHour*runHours)}</strong><span>Planned / ${runHours} hr</span></div>`:''}${diffPerHour!=null?diffStat(diffPerHour,`vs game Level ${num(building.level)} / hr`)+diffStat(diffPerHour*runHours,`vs game Level ${num(building.level)} / ${runHours} hr`):''}</div><div class="planner-section-label">Required Inputs <span>(for ${escapeHtml(product||'selected product')} Q${quality}${planned?' · Planned':''})</span></div><div class="table-wrap planner-table-wrap"><table class="building-input-table planner-input-table mobile-cards"><thead><tr><th>Resource</th><th>Required / hr</th><th>Required / ${runHours} hr</th></tr></thead><tbody>${rows||'<tr><td colspan="3">No recipe inputs are defined for this product.</td></tr>'}</tbody></table></div><div class="planner-section-label">Profit / h / level <span>(${escapeHtml(product || 'selected product')} Q${quality} · Level ${level})</span></div><div id="plannerProfit" class="planner-profit"></div><div class="planner-section-label">Best product <span>(for this building · profit / h / level)</span></div><div id="plannerInsights" class="planner-profit planner-insights"></div><div class="planner-section-label">Upgrade payback <span>(all buildings · next level)</span></div><div id="plannerPayback" class="planner-profit planner-insights"></div><div class="planner-section-label planner-summary-label">Deficit &amp; Surplus${planNetwork?.planned?' <span>(Planned · includes your what-if changes)</span>':''}</div><div class="planner-discount-control"><label>Buying - selected discount from VWAP<select id="plannerDiscount">${discountOpts}</select></label></div><div class="planner-summary-grid"><div class="planner-summary-card deficit-card"><div class="planner-summary-head"><span>Deficit - Total</span><strong id="plannerDeficitTotal">${deficitTotal}</strong></div><div class="planner-summary-table-scroll"><div class="planner-summary-table-head"><span>Resource</span><span>Amount</span><span>VWAP / Est. Market Cost</span></div>${summaryRows(deficitQuotes,'deficit')}</div></div><div class="planner-summary-card surplus-card"><div class="planner-summary-head"><span>Surplus - Total</span><strong id="plannerSurplusTotal">${surplusTotal}</strong></div><div class="planner-summary-table-scroll"><div class="planner-summary-table-head"><span>Resource</span><span>Amount</span><span>VWAP / Est. Market Value</span></div>${summaryRows(surplusQuotes,'surplus')}</div></div></div><div class="planner-text-grid"><div class="planner-text-card deficit-card"><div class="planner-summary-head"><span>Deficit Text</span><button type="button" class="planner-copy-btn" data-copy-target="deficitText">Copy</button></div><div id="deficitText" class="planner-copy-area"><div class="planner-copy-heading">==============================<br>🔽🔽🔽 BUYING -${discount}% MARKET 🔽🔽🔽</div>${deficitTextRows.html}<div class="planner-copy-heading">==============================</div></div></div><div class="planner-text-card surplus-card"><div class="planner-summary-head"><span>Selling Text</span><button type="button" class="planner-copy-btn" data-copy-target="surplusText">Copy</button></div><div id="surplusText" class="planner-copy-area"><div class="planner-copy-heading">==============================<br>🔽🔽🔽 SELLING -${discount}% MARKET 🔽🔽🔽</div>${surplusTextRows.html}<div class="planner-copy-heading">==============================</div></div></div></div><div class="planner-construction-card planner-text-card"><div class="planner-summary-head"><span>Construction Materials</span><strong id="plannerConstructionTotal">${plannerMoney(constructionTotalCost)}</strong><button type="button" class="planner-copy-btn" data-upgrade-projection>Upgrade View</button><button type="button" class="planner-copy-btn" data-copy-target="constructionMaterialsText">Copy</button></div><div class="planner-missing-prices" id="plannerConstructionMissing" role="status">${escapeHtml(constructionMissingText(constructionMissing))}</div><div id="constructionMaterialsText" class="planner-copy-area"><div class="planner-copy-heading">==============================<br>🔽🔽🔽 BUYING -${discount}% MARKET 🔽🔽🔽</div>${constructionTotalItems.length?constructionTotalItems.map(x=>`<div class="planner-copy-line"><span>${escapeHtml(`➡️ ${num(x.amount)} - ${x.name} :re-${Number(x.id)}: - ${x.price!=null?money(x.price):'—'}${x.price!=null&&x.marketPriceSrc?` (${x.marketPriceSrc})`:''}`)}</span></div>`).join(''):'<div class="planner-copy-empty">No additional construction materials required for the planned building levels.</div>'}<div class="planner-copy-heading">==============================</div></div></div><div class="planner-quality-footer"><div class="planner-info-dot">i</div><div><strong>Quality Note</strong><p>Inputs must be at least one quality level below the selected production quality. Higher quality inputs can also be used. Production quantity is not affected by quality level.</p><p class="planner-network-reference">Deficit and surplus are calculated from all owned buildings for the selected production time. Warehouse inventory is applied to construction-material needs by total quantity, regardless of stored quality.</p></div></div></article>`;
    // A background repaint that would draw the same planner is skipped (it re-laid out the page and jumped)
    const plannerSkip=Boolean(options?.background&&host.__plannerHtml===plannerHtml&&host.querySelector('.owned-buildings-strip'));
    if(!plannerSkip){host.__plannerHtml=plannerHtml;host.innerHTML=plannerHtml;}

    const deficitTextEl=$('#deficitText'); if(deficitTextEl) deficitTextEl.dataset.copyText=deficitCopyText;
    const surplusTextEl=$('#surplusText'); if(surplusTextEl) surplusTextEl.dataset.copyText=surplusCopyText;
    const constructionTextEl=$('#constructionMaterialsText'); if(constructionTextEl) constructionTextEl.dataset.copyText=constructionCopyText;
    host.__upgradeProjectionContext={state:s,building,plan:constructionMaterialPlan(s,building,building.level,level,discount),discount};
  // Economy phase: the running batch's rate is the game's (locked) rate; "Next run" is the same formula at today's economy
  // with the building's real abundance (core nextRun). The reference rate is the normal-economy rate with the same modifiers.
  const pr=productRate?.result||null,nr=productRate?.nextRun||null,sameRun=Boolean(productRate?.same);
  const bonusPct=pr?Number(pr.bonusPct)||0:plannerBonusPct(s);
  let referenceRate=null;try{const rb=plannerRate(product,recipes,rates,s);if(Number(rb?.rate)>0)referenceRate=Number(rb.rate)*level*(1+(nr?.eventPct||0)/100)/(1-bonusPct/100);}catch{}
  const runPerLevel=sameRun&&Number(pr.perLevel)>0?Number(pr.perLevel):null,nextPerLevel=Number(nr?.perLevel)>0?Number(nr.perLevel):null;
  const rateFromBatch=sameRun&&Boolean(pr.locked)&&runPerLevel!=null;
  host.__plannerProfitCtx={s,building,product,productId:Number(productRecipe?.id),quality,level,outputPerHour:runPerLevel!=null?runPerLevel*level:(nextPerLevel!=null?nextPerLevel*level:null),eventPct:nr?.eventPct??0,abundancePct:nr?.abundancePct??plannerAbundancePct(s,building?.raw?.id??building?.id,Number(productRecipe?.id)),bonusPct,buildingKind:String(building?.raw?.kind??building?.kind??''),robots:Boolean(building?.raw?.robotsSpecialization),rateSource:productRate?.source||null,rateFromBatch,batchStarted:rateFromBatch?String(building.raw.busy.started):null,referenceRate,runPerLevel,nextPerLevel,nextRun:nr,plannedInputs,transportUnits:Number(productRecipe?.transport)||0,owned,recipes,runHours};
  try{renderPlannerProfit(host);}catch(e){console.error('Planner profit render failed',e);}
  if(plannerSkip)return; // same DOM and handlers as the last paint; no scroll restore
    host.querySelector('[data-upgrade-projection]')?.addEventListener('click',()=>showBuildingUpgradeProjection(host,host.__upgradeProjectionContext));
    const restorePlannerScroll=()=>{
      const strip=host.querySelector('.owned-buildings-strip');
      if(strip)strip.scrollLeft=buildingsStripScrollLeft;
      window.scrollTo(pageScrollX,pageScrollY);
    };
    requestAnimationFrame(()=>{
      restorePlannerScroll();
      if(activeEditSnapshot){
        const restored=document.getElementById(activeEditSnapshot.id);
        if(restored&&'value' in restored){
          restored.value=activeEditSnapshot.value??'';
          try{restored.focus({preventScroll:true});}catch{restored.focus();}
          if(activeEditSnapshot.selectionStart!=null&&typeof restored.setSelectionRange==='function'){
            try{restored.setSelectionRange(activeEditSnapshot.selectionStart,activeEditSnapshot.selectionEnd??activeEditSnapshot.selectionStart);}catch{}
          }
        }
      }
      requestAnimationFrame(restorePlannerScroll);
      setTimeout(restorePlannerScroll,50);
    });
    host.querySelectorAll('[data-building-id]').forEach(b=>b.onclick=()=>{ui.buildingId=b.dataset.buildingId;const ownedB=owned.find(x=>String(x.id)===String(b.dataset.buildingId));const savedQ=(ui.planModes||{})[String(b.dataset.buildingId)]==='planner'?ui.qualityByBuilding?.[String(b.dataset.buildingId)]:undefined;ui.quality=Number(savedQ??ownedB?.currentQuality??0);ui.qualityByBuilding={...(ui.qualityByBuilding||{}),[String(b.dataset.buildingId)]:ui.quality};host.dataset.buildingId=b.dataset.buildingId;host.dataset.quality=String(ui.quality);queuePlannerUiPersist(s);renderBuildingPlanner(s);});
    const onProductPick=value=>{
      let overrides={};
      try{overrides=JSON.parse(host.dataset.productOverrides||'{}')||{};}catch{}
      if(value==='__current__'||!building.produces.includes(value)){ delete overrides[String(building.id)]; } else overrides[String(building.id)]=value;
      ui.productOverrides=overrides;ui.planModes={...(ui.planModes||{}),[String(building.id)]:value==='__current__'?'live':'planner'};host.dataset.productOverrides=JSON.stringify(overrides);queuePlannerUiPersist(s);
      renderBuildingPlanner(s);
    };
    $('#buildingProduct').onchange=()=>onProductPick($('#buildingProduct').value);
    $('#buildingOutput').onchange=()=>onProductPick($('#buildingOutput').value);
    const writePlannerMaps=(next)=>{Object.assign(ui,next);host.dataset.productOverrides=JSON.stringify(ui.productOverrides||{});host.dataset.planningLevels=JSON.stringify(ui.planningLevels||{});queuePlannerUiPersist(s);};
    $('#buildingKind').onchange=()=>{const id=String(building.id),value=$('#buildingKind').value;const kinds={...(ui.kindOverrides||{})},products={...(ui.productOverrides||{})};if(value==='__game__'||!definitions.some(d=>String(d.id)===value&&String(d?.name||'').trim()))delete kinds[id];else kinds[id]=value;delete products[id];writePlannerMaps({kindOverrides:kinds,productOverrides:products,planModes:{...(ui.planModes||{}),[id]:kinds[id]?'planner':'live'}});renderBuildingPlanner(s);};
    const resetPlannerBuildings=ids=>{const kinds={...(ui.kindOverrides||{})},products={...(ui.productOverrides||{})},levels={...(ui.planningLevels||{})},qualities={...(ui.qualityByBuilding||{})},modes={...(ui.planModes||{})};for(const id of ids.map(String)){delete kinds[id];delete products[id];delete levels[id];delete qualities[id];delete modes[id];}if(ids.map(String).includes(String(building.id))){ui.quality=null;host.dataset.quality='';}writePlannerMaps({kindOverrides:kinds,productOverrides:products,planningLevels:levels,qualityByBuilding:qualities,planModes:modes});renderBuildingPlanner(s);};
    host.querySelector('#plannerResetBuilding')?.addEventListener('click',()=>resetPlannerBuildings([building.id]));
    host.querySelector('#plannerResetAll')?.addEventListener('click',()=>resetPlannerBuildings(owned.filter(hasPlannerChange).map(b=>b.id)));
    $('#buildingLevel').onchange=()=>{const levels={...(ui.planningLevels||{})};levels[String(building.id)]=Math.min(20,Math.max(1,Number($('#buildingLevel').value)||building.level||1));ui.planningLevels=levels;ui.planModes={...(ui.planModes||{}),[String(building.id)]:'planner'};host.dataset.planningLevels=JSON.stringify(levels);queuePlannerUiPersist(s);renderBuildingPlanner(s);};
    $('#buildingQuality').onchange=()=>{ui.quality=Number($('#buildingQuality').value)||0;ui.qualityByBuilding={...(ui.qualityByBuilding||{}),[String(building.id)]:ui.quality};ui.planModes={...(ui.planModes||{}),[String(building.id)]:'planner'};host.dataset.quality=String(ui.quality);queuePlannerUiPersist(s);renderBuildingPlanner(s);};
    let runHoursSaveTimer=0;
    const applyRunHours=async()=>{
      const next=Math.min(48,Math.max(1,Number($('#buildingRunHours').value)||24));
      ui.runHours=next;
      host.dataset.runHours=String(next);
      // Repaint immediately from the live UI value, then persist it. This keeps
      // every Manager calculation responsive while the game overlay receives the
      // persisted realm value through the same storage path.
      renderBuildingPlanner(s);
      queuePlannerUiPersist(s);
      try{await saveRealmField('productionRunHours',next,s);}catch{}
    };
    $('#buildingRunHours').oninput=()=>{
      const next=Math.min(48,Math.max(1,Number($('#buildingRunHours').value)||24));
      ui.runHours=next;
      host.dataset.runHours=String(next);
      // Typing only records the value: repainting here replaced the input mid-edit and swallowed keystrokes.
      // The repaint + save happen once the edit is committed (change/blur/Enter).
    };
    $('#buildingRunHours').onchange=()=>{clearTimeout(runHoursSaveTimer);applyRunHours().catch(()=>{});};
    $('#buildingRunHours').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();e.target.blur?.();}};
    $('#plannerDiscount').onchange=()=>{ui.discount=plannerDiscountPercent($('#plannerDiscount').value);host.dataset.discount=String(ui.discount);queuePlannerUiPersist(s);const marketDiscount=$('#marketContractDiscount');if(marketDiscount)marketDiscount.value=String(ui.discount);if(window.__scmState)renderLiveMarketProduct(window.__scmState);renderBuildingPlanner(s);};
    host.querySelectorAll('.planner-copy-btn').forEach(btn=>btn.onclick=async()=>{const el=document.getElementById(btn.dataset.copyTarget);if(!el)return;const text=el.dataset.copyText??el.value??el.textContent??'';try{await navigator.clipboard.writeText(text);}catch{const ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();}btn.textContent='Copied';setTimeout(()=>btn.textContent='Copy',1200);});
  });
}

document.querySelector('#saveJson')?.addEventListener('click',async()=>{try{const s=await get();const manifestVersion=chrome.runtime.getManifest()?.version||BUILD_VERSION;const payload={exportedAt:new Date().toISOString(),page:'simcompanies-manager',version:manifestVersion,manifestVersion,buildVersion:BUILD_VERSION,activeRealmKey:s.activeRealmKey??null,selectedRealm:s.selectedRealm??null,captureRealm:s.captureRealm??null,realmStores:s.realmStores??{},activeState:{authData:s.authData??null,companyData:s.companyData??null,warehouseResources:s.warehouseResources??[],gameState:s.gameState??null,endpointData:s.endpointData??{},apiEndpoints:s.apiEndpoints??[],contracts:s.contracts??[],savedContracts:s.savedContracts??[],contractEvents:s.contractEvents??[],gameLocalStorageSnapshot:s.gameLocalStorageSnapshot??null,vwapData:s.vwapData??null,history:s.history??{},marketCache:s.marketCache??{},marketDebug:s.marketDebug??{},vwapStatus:s.vwapStatus??null,vwapWatch:s.vwapWatch??null,syncStatus:s.syncStatus??null,syncError:s.syncError??null,fullSyncDiagnostics:s.fullSyncDiagnostics??null,warehouseCostDetails:s.warehouseCostDetails??{},javascriptDiagnostic:s.javascriptDiagnostic??null,javascriptDiagnosticHistory:s.javascriptDiagnosticHistory??[]}};const blob=new Blob([JSON.stringify(SCM_DIAGNOSTIC_CORE.redactSecrets(payload),null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`simcompanies-manager-diagnostic-${realmDisplayNumber(payload.captureRealm)}-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;document.body.appendChild(a);a.click();a.remove();scmDownloadToast(a.download,blob.size);setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){alert('Unable to save diagnostic JSON: '+(e?.message||String(e)));}});
document.querySelector('#downloadStorage')?.addEventListener('click',async()=>{try{const storage=await chrome.storage.local.get(null);const manifestVersion=chrome.runtime.getManifest()?.version||BUILD_VERSION;const payload={exportedAt:new Date().toISOString(),page:'simcompanies-manager-storage',version:manifestVersion,manifestVersion,buildVersion:BUILD_VERSION,storage:SCM_DIAGNOSTIC_CORE.redactSecrets(storage)};const blob=new Blob([JSON.stringify(SCM_DIAGNOSTIC_CORE.redactSecrets(payload),null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`simcompanies-manager-storage-${manifestVersion}-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;document.body.appendChild(a);a.click();a.remove();scmDownloadToast(a.download,blob.size);setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){alert('Unable to download stored data: '+(e?.message||String(e)));}});
document.querySelector('#downloadDiagnosticBundle')?.addEventListener('click',async()=>{try{const s=await get();downloadDiagnosticFile(`simcompanies-manager-diagnostic-bundle-${realmDisplayNumber(s.viewRealm)}-${diagnosticFileStamp()}.json`,await buildDiagnosticBundle(s));}catch(e){alert('Unable to download diagnostic bundle: '+(e?.message||String(e)));}});
document.querySelector('#downloadApiCapture')?.addEventListener('click',async()=>{try{const s=await get();const {realm,store}=diagnosticStore(s);const payload={exportedAt:new Date().toISOString(),managerVersion:BUILD_VERSION,realm,activeRealmKey:s.activeRealmKey??null,selectedRealm:s.selectedRealm??null,apiEndpoints:store?.apiEndpoints??[],endpointData:store?.endpointData??{},apiLastRequestAt:store?.apiLastRequestAt??null};downloadDiagnosticFile(`simcompanies-manager-api-capture-${realmDisplayNumber(realm)}-${diagnosticFileStamp()}.json`,payload);}catch(e){alert('Unable to download API capture: '+(e?.message||String(e)));}});
let networkCaptureActive=false;let networkCaptureId='';let networkCaptureTabId=null;
const networkCaptureStatusEl=document.querySelector('#networkCaptureStatus');
const networkCaptureButton=document.querySelector('#startNetworkCapture');
// Android uses MAIN-world page capture (fetch/XHR); desktop uses browser-level CDP capture.
const networkCaptureUnsupportedOnAndroid=/Android/i.test(navigator.userAgent||'');
// Android unloads the game tab while you are in the Manager (tab status
// "unloaded"); scripting a sleeping tab fails with "Cannot access contents of the page".
// Pick an awake game tab, or reload the sleeping one and wait for it before running.
async function pickAwakeGameTab(stage,button){
  stage('tab-selection','started');
  const isGame=t=>/^https:\/\/(?:www\.)?simcompanies\.com\//i.test(String(t?.url||t?.pendingUrl||''));
  const all=(await chrome.tabs.query({url:['https://www.simcompanies.com/*','https://simcompanies.com/*']})).filter(t=>t?.id!=null&&isGame(t));
  if(!all.length)throw new Error('Could not find an open Sim Companies tab. Open the game and try again.');
  const awake=t=>!t.discarded&&t.status==='complete';
  let tab=all.find(t=>t.active&&awake(t))||all.find(awake)||all.find(t=>!t.discarded)||all[0];
  stage('tab-selection','ok',{tabId:tab.id,url:String(tab.url||'').split('?')[0],status:tab.status||null,discarded:Boolean(tab.discarded)});
  if(!awake(tab)){
    stage('wake-game-tab','started',{status:tab.status||null,discarded:Boolean(tab.discarded)});
    if(button)button.textContent='Waking the game tab…';
    try{await chrome.tabs.reload(tab.id);}catch(e){stage('wake-game-tab','failed',{error:String(e?.message||e)});throw new Error('The game tab is asleep and could not be reloaded. Open the game tab once, then come back and try again.');}
    const until=Date.now()+25000;
    while(Date.now()<until){await new Promise(r=>setTimeout(r,400));try{tab=await chrome.tabs.get(tab.id);}catch{break;}if(awake(tab))break;}
    if(!awake(tab)){stage('wake-game-tab','failed',{status:tab?.status||null});throw new Error('The game tab did not finish loading. Open the game tab once, then try again.');}
    await new Promise(r=>setTimeout(r,2500));
    stage('wake-game-tab','ok',{status:tab.status});
  }
  return tab;
}
function showDiagResult(button,ok,text){
  if(!button)return;
  let el=button.nextElementSibling;
  if(!el||!el.classList?.contains('diag-result')){el=document.createElement('div');el.className='diag-result';el.setAttribute('role','status');button.insertAdjacentElement('afterend',el);}
  el.className=`diag-result ${ok?'diag-result-ok':'diag-result-bad'}`;
  el.textContent=`${ok?'✓':'✗'} ${text} · ${new Date().toLocaleTimeString()}`;
}
async function sendGameTabMessage(tabId,message,{timeoutMs=5000,bootstrapTimeoutMs=1200}={}){
  const attempt=async(ms)=>Promise.race([chrome.tabs.sendMessage(tabId,message),new Promise((_,reject)=>setTimeout(()=>reject(new Error(`No content-script response within ${ms} ms`)),ms))]);
  try{return await attempt(bootstrapTimeoutMs);}catch(firstError){
    if(!chrome.scripting?.executeScript)throw new Error(`Game content script is unavailable (${firstError?.message||firstError}) and scripting fallback is unavailable.`);
    try{await chrome.scripting.executeScript({target:{tabId},files:['content.js']});}catch(injectError){throw new Error(`Could not initialize game diagnostics: ${injectError?.message||injectError}`);}
    try{return await attempt(timeoutMs);}catch(retryError){throw new Error(`Game content script did not respond after initialization: ${retryError?.message||retryError}`);}
  }
}
async function readNetworkCapture(){const raw=await chrome.storage.local.get('scmNetworkTrafficCapture');return raw?.scmNetworkTrafficCapture||null;}
function renderNetworkCaptureStatus(capture){const stats=SCM_DIAGNOSTIC_CORE.summarizeNetworkCapture(capture);const status=stats.status;const errors=stats.requestErrorCount+stats.recorderErrorCount;if(networkCaptureStatusEl){networkCaptureStatusEl.textContent=`Network capture ${status}${status==='stopped'&&stats.stopCount?' and saved':''} · ${stats.eventCount} events · ${stats.requestCount} requests · ${stats.responseCount} responses · ${errors} errors`;networkCaptureStatusEl.dataset.status=status;networkCaptureStatusEl.dataset.eventCount=String(stats.eventCount);networkCaptureStatusEl.dataset.countsMatch=String(stats.countsMatch);if(status==='stopped'&&stats.eventCount===0)networkCaptureStatusEl.textContent+=' · FAILURE: no events captured';else if(status==='stopped'&&!stats.stopCount)networkCaptureStatusEl.textContent+=' · WARNING: stop marker missing';if(capture?.truncated||Number(capture?.droppedEventCount)>0)networkCaptureStatusEl.textContent+=` · INCOMPLETE: ${Number(capture?.droppedEventCount)||0} events dropped`;}}
async function refreshNetworkCaptureStatus(){try{const v3=await chrome.runtime.sendMessage({type:'SCM_NET3_STATUS'});if(v3?.status?.status==='recording'||v3?.status?.captureId){const x=v3.status,active=x.status==='recording';networkCaptureActive=active;networkCaptureId=String(x.captureId||networkCaptureId||'');if(networkCaptureStatusEl)networkCaptureStatusEl.textContent=`${x.mode==='mobile-page'?'Mobile page capture':'Network Capture 3.0'} ${x.status} · ${x.events||0} events · ${x.requests||0} requests · ${x.responses||0} responses · ${x.errors||0} errors${x.mode==='mobile-page'?' · fetch/XHR only':''}`;if(networkCaptureButton){networkCaptureButton.textContent=active?'Stop Network Capture':'Start Network Capture';networkCaptureButton.setAttribute('aria-pressed',String(active));}return;}const capture=await readNetworkCapture();renderNetworkCaptureStatus(capture);const active=['starting','recording','stopping'].includes(String(capture?.status||''));networkCaptureActive=active;networkCaptureId=String(capture?.captureId||networkCaptureId||'');if(networkCaptureButton){networkCaptureButton.textContent=active?'Stop Network Capture':'Start Network Capture';networkCaptureButton.setAttribute('aria-pressed',String(active));}if(networkCaptureUnsupportedOnAndroid&&networkCaptureStatusEl&&!capture)networkCaptureStatusEl.textContent='Mobile capture records game-page fetch/XHR requests while the game tab is running. Keep the game tab open overnight; Android may suspend background tabs.';}catch{}}
async function resolveNetworkCaptureTab(){if(networkCaptureTabId!=null){try{const tab=await chrome.tabs.get(networkCaptureTabId);if(tab?.id&&/^https:\/\/(?:www\.)?simcompanies\.com\//i.test(String(tab.url||'')))return tab;}catch{}}const tabs=await chrome.tabs.query({url:['https://www.simcompanies.com/*','https://simcompanies.com/*']});const tab=(tabs||[]).find(t=>t.active)||tabs?.[0];if(tab?.id)networkCaptureTabId=tab.id;return tab||null;}
scmOnStorageChanged((changes,area)=>{if(area==='local'&&changes.scmNetworkTrafficCapture){renderNetworkCaptureStatus(changes.scmNetworkTrafficCapture.newValue);const c=changes.scmNetworkTrafficCapture.newValue;networkCaptureActive=['starting','recording','stopping'].includes(String(c?.status||''));if(c?.captureId)networkCaptureId=String(c.captureId);if(networkCaptureButton){networkCaptureButton.textContent=networkCaptureActive?'Stop Network Capture':'Start Network Capture';networkCaptureButton.setAttribute('aria-pressed',String(networkCaptureActive));}}});
refreshNetworkCaptureStatus();
async function toggleMobileNetworkCapture(button){const stat=await chrome.runtime.sendMessage({type:'SCM_NET3_STATUS'});const status=stat?.status||{};if(status.status==='recording'&&status.mode==='mobile-page'){const stopped=await chrome.runtime.sendMessage({type:'SCM_MOBILE_NET_STOP'});if(!stopped?.ok)throw new Error(stopped?.error||'Could not stop mobile capture.');networkCaptureActive=false;networkCaptureId=stopped.captureId;if(networkCaptureStatusEl)networkCaptureStatusEl.textContent=`Mobile page capture stopped · ${stopped.events||0} events · ${stopped.requests||0} requests · ${stopped.responses||0} responses · ${stopped.errors||0} errors`;button.textContent='Start Network Capture';button.setAttribute('aria-pressed','false');alert(`Mobile network capture stopped.\n\nEvents: ${stopped.events||0}\nRequests: ${stopped.requests||0}\nResponses: ${stopped.responses||0}\nErrors: ${stopped.errors||0}\n\nUse Download Network Capture to export the JSON.`);return;}const tab=await resolveNetworkCaptureTab();if(!tab?.id)throw new Error('Open Sim Companies in a browser tab first.');networkCaptureTabId=tab.id;const result=await chrome.runtime.sendMessage({type:'SCM_MOBILE_NET_START',tabId:tab.id});if(!result?.ok)throw new Error(result?.error||'Could not start mobile page capture.');networkCaptureId=result.captureId;networkCaptureActive=true;button.textContent='Stop Network Capture';button.setAttribute('aria-pressed','true');if(networkCaptureStatusEl)networkCaptureStatusEl.textContent=`Mobile page capture recording · ${result.events||0} events · fetch/XHR only · up to 100,000 events. Keep game tab open; Android may suspend background tabs.`;alert('Mobile network capture started. Keep the Sim Companies tab open overnight. Android may suspend a background tab, so this records activity only while the page is running.');}
networkCaptureButton?.addEventListener('click',async e=>{const button=e.currentTarget;button.disabled=true;try{if(networkCaptureUnsupportedOnAndroid){await toggleMobileNetworkCapture(button);return;}const stat=await chrome.runtime.sendMessage({type:'SCM_NET3_STATUS'});const status=stat?.status||{};if(status.status==='recording'){const stopped=await chrome.runtime.sendMessage({type:status.mode==='mobile-page'?'SCM_MOBILE_NET_STOP':'SCM_NET3_STOP'});if(!stopped?.ok)throw new Error(stopped?.error||'Could not stop browser network capture.');networkCaptureActive=false;button.textContent='Start Network Capture';button.setAttribute('aria-pressed','false');if(networkCaptureStatusEl)networkCaptureStatusEl.textContent=`Network Capture 3.0 stopped · ${stopped.events||0} events · ${stopped.requests||0} requests · ${stopped.responses||0} responses · ${stopped.bodies||0} response bodies · ${stopped.errors||0} errors`;alert(`Network Capture 3.0 stopped.\n\nEvents: ${stopped.events}\nRequests: ${stopped.requests}\nResponses: ${stopped.responses}\nBodies captured: ${stopped.bodies}\nErrors: ${stopped.errors}\n\nUse Download Network Traffic JSON to export the capture.`);}else{const hasDebugger=await chrome.permissions.contains({permissions:['debugger']}).catch(()=>false)||await chrome.permissions.request({permissions:['debugger']}).catch(()=>false);if(!hasDebugger){await toggleMobileNetworkCapture(button);return;}const tab=await resolveNetworkCaptureTab();if(!tab?.id)throw new Error('Open Sim Companies in a browser tab first.');networkCaptureTabId=tab.id;const result=await chrome.runtime.sendMessage({type:'SCM_NET3_START',tabId:tab.id});if(!result?.ok)throw new Error(result?.error||'Could not start Chrome browser-level capture.');networkCaptureId=result.captureId;networkCaptureActive=true;button.textContent='Stop Network Capture';button.setAttribute('aria-pressed','true');if(networkCaptureStatusEl)networkCaptureStatusEl.textContent=`Network Capture 3.0 recording · tab ${tab.id} · browser-level requests and response bodies. Chrome debugging indicator may appear.`;}}catch(err){const message=String(err?.message||err);if(networkCaptureStatusEl)networkCaptureStatusEl.textContent=`Network Capture 3.0 error · ${message}`;alert('Network Capture 3.0 error: '+message);}finally{button.disabled=false;}});
document.querySelector('#downloadNetworkCapture')?.addEventListener('click',async()=>{const button=document.querySelector('#downloadNetworkCapture');const old=button?.textContent;if(button){button.disabled=true;button.textContent='Exporting all network events…';}try{let st=await chrome.runtime.sendMessage({type:'SCM_NET3_STATUS'});let status=st?.status||{};if(status.status==='recording'){const stopped=await chrome.runtime.sendMessage({type:'SCM_NET3_STOP'});if(!stopped?.ok)throw new Error(stopped?.error||'Could not stop capture before export.');status={...status,...stopped,status:'stopped'};networkCaptureActive=false;if(networkCaptureButton){networkCaptureButton.textContent='Start Network Capture';networkCaptureButton.setAttribute('aria-pressed','false');}}const captureId=String(status.captureId||networkCaptureId||'');if(!captureId)throw new Error('No Network Capture 3.0 capture is available. Start the recorder, browse the game, then stop it.');let events=[],offset=0,total=0;do{const page=await chrome.runtime.sendMessage({type:'SCM_NET3_EXPORT',captureId,offset,limit:300});if(!page?.ok)throw new Error(page?.error||'Unable to read capture data from IndexedDB.');events.push(...(page.events||[]));total=Number(page.total)||events.length;offset=events.length;if(!page.events?.length)break;if(events.length<total&&networkCaptureStatusEl)networkCaptureStatusEl.textContent=`Exporting network events · ${events.length}/${total}`;}while(events.length<total);const requests=events.filter(x=>x.kind==='request'||x.kind==='request-start'),responses=events.filter(x=>x.kind==='response'||x.kind==='fetch'||x.kind==='xhr');const coverage=globalThis.SCM_DIAGNOSTIC_CORE?.summarizeNetworkCaptureV3?globalThis.SCM_DIAGNOSTIC_CORE.summarizeNetworkCaptureV3(events):{responseCount:responses.length,responseBodiesCaptured:events.filter(x=>x.kind==='response-body'&&x.body!=null).length,responseBodiesUnavailable:Math.max(0,responses.length-events.filter(x=>x.kind==='response-body'&&x.body!=null).length),bodyCoveragePercent:responses.length?Number((events.filter(x=>x.kind==='response-body'&&x.body!=null).length/responses.length*100).toFixed(1)):0,responseBodyOutcomes:[]};const payload={schemaVersion:3,diagnostic:'simcompanies-network-capture-v3',exportedAt:new Date().toISOString(),managerVersion:BUILD_VERSION,captureId,status:'stopped',startedAt:status.startedAt||null,stoppedAt:status.stoppedAt||new Date().toISOString(),scope:{captureMechanism:status.mode==='mobile-page'?'MAIN-world page fetch/XHR instrumentation':'Chrome DevTools Protocol Network domain via chrome.debugger',tabId:status.tabId??networkCaptureTabId,coverage:status.mode==='mobile-page'?'Includes game-page fetch/XHR and Manager background SimcoTools fetches. Page-level capture is same-origin only; background capture covers the Manager SimcoTools fetch wrapper. Does not observe all browser-internal traffic, images/navigation, WebSockets or other extension requests.':'Browser-observed Network-domain events for the attached tab, including cross-origin HTTP(S) requests, request/response metadata, bodies when Chrome exposes them, redirects, cache events, WebSocket/EventSource protocol events and failures.',limitations:['No browser extension can promise literally every byte across every process or traffic mechanism.','Mobile capture is page-level and cannot observe all browser traffic; Android may suspend the tab overnight.','Request/response headers, cookies, authorization values and request bodies are not recorded by the mobile recorder.','Mobile API response previews are truncated at 4 KB; capture is capped at 100,000 events.']},summary:{eventCount:events.length,requestCount:requests.length,...coverage,requestFailures:events.filter(x=>x.kind==='loading-failed').length,recorderErrors:events.filter(x=>x.kind==='capture-error').length},events};downloadDiagnosticFile(`simcompanies-manager-network-capture-v3-${diagnosticFileStamp()}.json`,payload);if(networkCaptureStatusEl)networkCaptureStatusEl.textContent=`Network Capture 3.0 export complete · ${events.length} events · ${coverage.responseBodiesCaptured} bodies · ${coverage.responseBodiesUnavailable} responses without bodies`;alert(`Network Capture 3.0 exported.\n\nEvents: ${events.length}\nRequests: ${requests.length}\nResponses: ${responses.length}\nBodies captured: ${coverage.responseBodiesCaptured}\nResponses without bodies: ${coverage.responseBodiesUnavailable}\n\nUnavailable bodies are listed with reasons; they are not silently counted as captured.`);}catch(e){alert('Unable to export Network Capture 3.0: '+(e?.message||String(e)));}finally{if(button){button.disabled=false;button.textContent=old||'Download Network Traffic JSON';}}});
document.querySelector('#downloadProductionDiagnostic')?.addEventListener('click',async()=>{try{const s=await get();const {realm,store}=diagnosticStore(s);const payload={exportedAt:new Date().toISOString(),managerVersion:BUILD_VERSION,realm,buildings:store?.buildings??null,productionRateSnapshots:store?.productionRateSnapshots??{},productionPlans:store?.productionPlans??{},productionHistoryAudit:plannerHistoryAuditExport(),productionHistoryComparison:productionHistoryComparisonExport(store||{}),backgroundJobHistory:store?.backgroundJobHistory??[],productionRunHours:store?.productionRunHours??24,productionPlannerState:s?.productionPlannerState??null,history:store?.history??{},gameOverlaySnapshot:store?.gameOverlaySnapshot??null,warehouseResources:store?.warehouseResources??[],warehouseLotProvenance:warehouseRows(store||{}).flatMap(row=>Array.isArray(row?._lots)?row._lots:[]),warehouseCapture:store?.warehouseCapture??null};downloadDiagnosticFile(`simcompanies-manager-production-overlay-${realmDisplayNumber(realm)}-${diagnosticFileStamp()}.json`,payload);}catch(e){alert('Unable to download production/overlay diagnostics: '+(e?.message||String(e)));}});
document.querySelector('#downloadDomRuntimeDiagnostic')?.addEventListener('click',async(e)=>{const button=e.currentTarget;const old=button.textContent;let tab=null;const stages=[];const stage=(name,status,detail={})=>stages.push({stage:name,status,at:new Date().toISOString(),...detail});button.disabled=true;button.textContent='Inspecting game DOM…';try{tab=await pickAwakeGameTab(stage,button);button.textContent='Collecting DOM evidence…';stage('isolated-content-script','started');const requestId=`dom-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;let response;try{response=await sendGameTabMessage(tab.id,{type:'RUN_DOM_RUNTIME_DIAGNOSTIC',requestId},{timeoutMs:8500,bootstrapTimeoutMs:1200});}catch(error){stage('isolated-content-script','failed',{error:String(error?.message||error)});throw error;}stage('isolated-content-script',response?.ok&&response?.diagnostic?'ok':'failed',{ok:Boolean(response?.ok),error:response?.error||null});if(!response?.ok||!response?.diagnostic)throw new Error(response?.error||'The content script returned no DOM report.');const report={...response.diagnostic,managerVersion:BUILD_VERSION,exportedAt:new Date().toISOString(),diagnosticStages:stages};downloadDiagnosticFile(`simcompanies-dom-runtime-inspection-${diagnosticFileStamp()}.json`,report);const dom=report.dom||{};const mainWorld=report.runtime?.mainWorld===true;showDiagResult(button,true,`Downloaded simcompanies-dom-runtime-inspection JSON · ${dom.scannedElementCount||0} elements inspected`);alert(`DOM/runtime report exported and verified: ${dom.scannedElementCount||0} elements inspected, ${dom.reactMarkerCount||0} React markers, ${(dom.relevantNodes||[]).length} relevant DOM nodes, ${(dom.relevantBodyTextSnippets||[]).length} relevant visible-text snippets. ${mainWorld?'MAIN-world inspection completed.':'MAIN-world inspection marker missing; treat this as partial.'} ${report.limits?.truncated?'Scan was bounded/truncated.':'Scan completed within limits.'}`);}catch(error){stage('capture','failed',{error:String(error?.message||error)});const failure={diagnostic:'simcompanies-dom-runtime-inspection-failure',schemaVersion:1,managerVersion:BUILD_VERSION,exportedAt:new Date().toISOString(),selectedTab:tab?{id:tab.id,url:String(tab.url||'').split('?')[0],status:tab.status||null}:null,error:{name:String(error?.name||'Error'),message:String(error?.message||error)},stages,limitations:{fullDomDump:false,rawApplicationState:false}};downloadDiagnosticFile(`simcompanies-dom-runtime-failure-${diagnosticFileStamp()}.json`,failure);showDiagResult(button,false,'DOM inspection failed: '+(error?.message||String(error))+' — a failure report was downloaded.');alert('DOM/runtime inspection failed: '+(error?.message||String(error))+'. A failure report was downloaded.');}finally{button.disabled=false;button.textContent=old;}});

document.querySelector('#downloadReduxStoreDump')?.addEventListener('click',async(e)=>{const button=e.currentTarget;const old=button.textContent;const stages=[];let tab=null;const stage=(name,status,detail={})=>stages.push({stage:name,status,at:new Date().toISOString(),...detail});button.disabled=true;button.textContent='Selecting game tab…';try{tab=await pickAwakeGameTab(stage,button);button.textContent='Requesting page-hook diagnostic…';stage('page-hook-request','started');const requestId=`redux-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;let response;try{response=await sendGameTabMessage(tab.id,{type:'RUN_REDUX_STATE_DIAGNOSTIC',requestId},{timeoutMs:7500,bootstrapTimeoutMs:1200});}catch(error){stage('page-hook-request','failed',{error:String(error?.message||error)});throw error;}stage('page-hook-request',response?.ok?'returned':'failed',{ok:Boolean(response?.ok),error:response?.error||null});if(!response?.ok||!response?.diagnostic)throw new Error(response?.error||'The page hook returned no state diagnostic.');const d=response.diagnostic;const outcome=SCM_DIAGNOSTIC_CORE.classifyStateDiscovery(d);stage('discovery-result',outcome.status,{candidateCount:outcome.candidates,fiberRootCount:outcome.fibers,visitedNodes:outcome.visitedNodes,stateMatchCount:outcome.stateMatchCount});const report={...d,discoveryOutcome:outcome,diagnosticStages:stages,managerVersion:BUILD_VERSION,exportedAt:new Date().toISOString()};downloadDiagnosticFile(`simcompanies-runtime-state-access-${realmDisplayNumber(d.runtime?.realm)}-${diagnosticFileStamp()}.json`,report);showDiagResult(button,true,`Downloaded runtime/state JSON · ${outcome.status}`);alert(`Runtime/state diagnostic exported: ${outcome.status}. ${outcome.reason} Component snapshots: ${report.componentSnapshotCount||0}; React fibers visited: ${report.fiberNodesVisited||0}; state paths: ${report.stateMatches?.length||0}.`);}catch(err){stage('capture','failed',{error:String(err?.message||err)});const failure={diagnostic:'simcompanies-redux-state-capture-failure',schemaVersion:2,exportedAt:new Date().toISOString(),managerVersion:BUILD_VERSION,selectedTab:tab?{id:tab.id,url:String(tab.url||'').split('?')[0],status:tab.status||null}:null,error:{name:String(err?.name||'Error'),message:String(err?.message||err)},stages,limitations:{fullRawReduxStateNotExported:true,gamePageMayKeepStoreInsideModuleClosure:true,usesExistingPageHookBridge:true}};downloadDiagnosticFile(`simcompanies-redux-capture-failure-${diagnosticFileStamp()}.json`,failure);showDiagResult(button,false,'Redux / app state failed: '+(err?.message||String(err))+' — a failure report was downloaded.');alert('Unable to capture Redux / app state: '+(err?.message||String(err))+'. A diagnostic failure-report JSON was downloaded.');}finally{button.disabled=false;button.textContent=old;}});
document.querySelector('#downloadSyncTrace')?.addEventListener('click',async()=>{try{const s=await get();const {realm,store}=diagnosticStore(s);const endpointEntries=Object.entries(store?.endpointData||{}).map(([url,v])=>({url,captureRealm:v?.captureRealm??null,status:v?.status??null,receivedAt:v?.receivedAt??null})).sort((a,b)=>Date.parse(b.receivedAt||0)-Date.parse(a.receivedAt||0));const payload={exportedAt:new Date().toISOString(),managerVersion:BUILD_VERSION,realm,activeRealmKey:s.activeRealmKey??null,selectedRealm:s.selectedRealm??null,lastSync:store?.lastSync??null,syncStatus:store?.syncStatus??null,syncError:store?.syncError??null,fullSyncDiagnostics:store?.fullSyncDiagnostics??null,vwapStatus:store?.vwapStatus??null,apiEndpoints:store?.apiEndpoints??[],endpointTrace:endpointEntries};downloadDiagnosticFile(`simcompanies-manager-sync-trace-${realmDisplayNumber(realm)}-${diagnosticFileStamp()}.json`,payload);}catch(e){alert('Unable to download sync trace: '+(e?.message||String(e)));}});

async function runJavascriptDiagnosticFromDashboard(button){
  if(!button)return;
  const original=button.textContent;
  button.disabled=true;button.textContent='Collecting…';
  const timeout=new Promise((_,reject)=>setTimeout(()=>reject(new Error('Runtime diagnostic timed out after 12 seconds.')),12000));
  try{
    const result=await Promise.race([chrome.runtime.sendMessage({type:'RUN_JAVASCRIPT_DIAGNOSTIC'}),timeout]);
    if(!result?.ok)throw new Error(result?.error||'JavaScript diagnostic failed.');
    alert(`JavaScript diagnostic captured for ${realmName(result.realm)}.`);
    const fresh=await get(); renderDiagnostics(fresh);
  }catch(e){alert('Unable to run JavaScript diagnostic: '+(e?.message||String(e)));}
  finally{button.disabled=false;button.textContent=original;}
}
document.querySelector('#runJavascriptDiagnostic')?.addEventListener('click',e=>runJavascriptDiagnosticFromDashboard(e.currentTarget));
document.querySelector('#runJavascriptDiagnosticInline')?.addEventListener('click',e=>runJavascriptDiagnosticFromDashboard(e.currentTarget));

document.querySelector('#clearStoredData')?.addEventListener('click',async()=>{if(!confirm('Clear all data stored by Sim Companies Manager?\n\nThis cannot be undone. Your Sim Companies account and game data will not be affected.\n\nIf you want a backup first, use Full Stored Data (Settings tab › Diagnostic › Advanced diagnostics).')) return; const button=document.querySelector('#clearStoredData'); button.disabled=true; try{const result=await chrome.runtime.sendMessage({type:'CLEAR_EXTENSION_DATA'}); if(!result?.ok) throw new Error(result?.error||'Reset failed.'); alert('Stored data cleared. The Manager is starting fresh.'); window.location.reload();}catch(e){button.disabled=false; alert('Unable to clear stored data: '+(e?.message||String(e)));}});
document.addEventListener('click',async e=>{const b=e.target.closest('.diag-copy');if(!b)return;let s=await get();let text='';const type=b.dataset.copyJson;const realm=Number(s.viewRealm??s.authData?.authCompany?.realmId??s.authData?.authCompany?.realm);const ep=s.endpointData||{};const endpointEntries=Object.entries(ep).sort((a,c)=>new Date(c[1]?.receivedAt||0)-new Date(a[1]?.receivedAt||0));const matching=(rx)=>endpointEntries.filter(([k])=>rx.test(k)).map(([k,v])=>({endpoint:k,status:v?.status,receivedAt:v?.receivedAt,data:v?.data??null}));
if(type==='market-page'){text=JSON.stringify({page:'market',realm:Number.isFinite(realm)?realm:null,vwapData:s.vwapData||{},history:s.history||{},marketDebug:s.marketDebug||{},marketCache:s.marketCache||{},endpoints:matching(/market|orders|orderbook|vwap/i)},null,2);}
if(text)await copyDiagnosticText(text,b);});

function diagnosticStore(s){
  const realm=Number.isFinite(Number(s?.viewRealm))?Number(s.viewRealm):Number(s?.captureRealm);
  const key=Number.isFinite(realm)?`realm:${realm}`:null;
  return {realm,key,store:key&&s?.realmStores?.[key]?s.realmStores[key]:s};
}
function diagnosticResourceKey(id,quality){return `${Number(id)}:${Number(quality)}`;}
function diagnosticProducedKeys(s){
  const keys=new Set();
  const buildings=buildingArrayFromState(s);
  for(const b of buildings){
    if(String(b?.category||'').toLowerCase()!=='production') continue;
    const resource=b?.busy?.resource;
    const id=Number(resource?.kind??b?.pinnedResource);
    const q=Number(resource?.quality);
    if(Number.isFinite(id)&&id>0&&Number.isFinite(q)) keys.add(diagnosticResourceKey(id,q));
  }
  for(const snap of Object.values(s?.productionRateSnapshots||{})){
    const id=Number(snap?.resourceId),q=Number(snap?.quality??snap?.productQuality);
    if(Number.isFinite(id)&&id>0&&Number.isFinite(q)) keys.add(diagnosticResourceKey(id,q));
  }
  return keys;
}
// Every download shows a visible confirmation (alerts are easy to miss on Android).
function scmDownloadToast(name,bytes){try{let t=document.getElementById('scmToast');if(!t){t=document.createElement('div');t.id='scmToast';t.className='scm-toast';t.setAttribute('role','status');document.body.appendChild(t);}const kb=Number(bytes)>0?` (${Math.max(1,Math.round(bytes/1024)).toLocaleString()} KB)`:'';t.textContent=`⬇ Downloaded ${name}${kb} — check your Downloads folder`;t.classList.add('show');clearTimeout(scmDownloadToast.timer);scmDownloadToast.timer=setTimeout(()=>t.classList.remove('show'),5000);}catch{}}
function downloadDiagnosticFile(name,payload){
  const blob=new Blob([JSON.stringify(SCM_DIAGNOSTIC_CORE.redactSecrets(payload),null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();scmDownloadToast(a.download,blob.size);
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function diagnosticFileStamp(){return new Date().toISOString().replace(/[:.]/g,'-');}
async function buildDiagnosticBundle(s){return SCM_DIAGNOSTIC_CORE.redactSecrets(await buildDiagnosticBundleRaw(s));}
async function buildDiagnosticBundleRaw(s){
  const {realm,key,store}=diagnosticStore(s);
  const endpointEntries=Object.entries(store?.endpointData||{}).map(([url,v])=>({url,captureRealm:v?.captureRealm??null,status:v?.status??null,receivedAt:v?.receivedAt??null,data:v?.data??null}));
  const replayRaw=await chrome.storage.local.get(null);
  const replayChunkKeys=Object.keys(replayRaw||{}).filter(k=>String(k).startsWith('scmReplayChunk:')).sort();
  const replayEvents=replayChunkKeys.flatMap(k=>Array.isArray(replayRaw[k])?replayRaw[k]:[]);
  // Environment + storage sizes (lag), endpoint index, production cost history, and the exact
  // numbers each building card used for Profit / h / level (to reconcile against the game's Profit Calculator).
  const bytesByKey=Object.fromEntries(Object.entries(replayRaw||{}).map(([k,v])=>{let n=0;try{n=JSON.stringify(v)?.length||0;}catch{}return [k,n];}).sort((a,b)=>b[1]-a[1]));
  const endpointIndex=endpointEntries.map(x=>{let n=0;try{n=JSON.stringify(x.data)?.length||0;}catch{}return {url:x.url,status:x.status,receivedAt:x.receivedAt,captureRealm:x.captureRealm,bytes:n};}).sort((a,b)=>String(b.receivedAt||'').localeCompare(String(a.receivedAt||'')));
  const extra={
    environment:{userAgent:navigator.userAgent,viewport:{w:innerWidth,h:innerHeight,dpr:devicePixelRatio},mobileLayout:document.documentElement.classList.contains('scm-mobile'),activeTab:typeof activeTab!=='undefined'?activeTab:null,storageBytesByKey:bytesByKey,storageBytesTotal:Object.values(bytesByKey).reduce((a,b)=>a+b,0)},
    endpointIndex,
    productionCostHistory:realm!=null&&Array.isArray(replayRaw[`scmProductionCostHistory:${realm}`])?replayRaw[`scmProductionCostHistory:${realm}`]:[],
    backgroundJobs:realm!=null&&Array.isArray(replayRaw[`scmBackgroundJobs:${realm}`])?replayRaw[`scmBackgroundJobs:${realm}`].slice(-200):[],
    profitCalculatorInputs:{note:'Values the Manager used for each building card opened in this session (open the Production tab and the building first).',buildings:JSON.parse(JSON.stringify(__plannerProfitLast))}
  };
  return {
    ...extra,
    replay:{meta:replayRaw.scmReplayMeta||null,events:replayEvents.slice(-4000)},
    exportedAt:new Date().toISOString(),managerVersion:BUILD_VERSION,realm,realmKey:key,
    activeRealmKey:s?.activeRealmKey??null,selectedRealm:s?.selectedRealm??null,captureRealm:s?.captureRealm??null,
    integrity:{
      activeRealmMatchesSelected:s?.activeRealmKey===key,
      overlayRealm:store?.gameOverlaySnapshot?.realm??null,
      overlayRealmMatchesSelected:Number(store?.gameOverlaySnapshot?.realm)===Number(realm),
      endpointCaptureMismatches:endpointEntries.filter(x=>x.captureRealm!=null&&Number(x.captureRealm)!==Number(realm)).length
    },
    sync:{lastSync:store?.lastSync??null,syncStatus:store?.syncStatus??null,syncError:store?.syncError??null,fullSyncDiagnostics:store?.fullSyncDiagnostics??null,backgroundJobHistory:store?.backgroundJobHistory??[]},
    production:{buildings:store?.buildings??null,productionRateSnapshots:store?.productionRateSnapshots??{},productionPlans:store?.productionPlans??{},productionHistoryAudit:plannerHistoryAuditExport(),productionHistoryComparison:productionHistoryComparisonExport(store||{}),backgroundJobHistory:store?.backgroundJobHistory??[],productionRunHours:store?.productionRunHours??24,history:store?.history??{}},
    overlay:{gameOverlaySnapshot:store?.gameOverlaySnapshot??null},
    warehouse:{warehouseResources:store?.warehouseResources??[],warehouseCapture:store?.warehouseCapture??null,warehouseCostDetails:store?.warehouseCostDetails??{}},
    gameStore:{gameLocalStorageSnapshot:store?.gameLocalStorageSnapshot??null},
    contracts:{contracts:store?.contracts??[],contractEvents:store?.contractEvents??[],savedContracts:store?.savedContracts??[]},
    market:{vwapData:store?.vwapData??null,vwapStatus:store?.vwapStatus??null,vwapWatch:store?.vwapWatch??null,liveMarketData:store?.liveMarketData??null,liveMarketPriceData:store?.liveMarketPriceData??null,marketCache:store?.marketCache??{},marketDebug:store?.marketDebug??{}},
    api:{apiEndpoints:store?.apiEndpoints??[],endpointData:Object.fromEntries(endpointEntries.map(x=>[x.url,{captureRealm:x.captureRealm,status:x.status,receivedAt:x.receivedAt,data:x.data}]))},javascript:{diagnostic:store?.javascriptDiagnostic??null,history:store?.javascriptDiagnosticHistory??[]}
  };
}
function renderJavascriptDiagnostic(s){
  const host=$('#javascriptDiagnosticStatus');
  if(!host)return;
  const d=s?.javascriptDiagnostic;
  if(!d){host.innerHTML='<p class="muted">No JavaScript/runtime diagnostic captured yet. Open Sim Companies and run the diagnostic.</p>';return;}
  const b=Array.isArray(d.bundles)?d.bundles:[];
  const routes=Array.isArray(d.discoveredApiRoutes)?d.discoveredApiRoutes:[];
  const perf=Array.isArray(d.performanceResources)?d.performanceResources:[];
  const storage=d.storage||{};
  const diff=d.diffFromPrevious;
  const addedBundles=diff?.bundles?.added?.length||0;
  const changedBundles=diff?.bundles?.changed?.length||0;
  const addedRoutes=diff?.apiRoutes?.added?.length||0;
  const removedRoutes=diff?.apiRoutes?.removed?.length||0;
  const errorBundles=b.filter(x=>x.error||x.skipped).length;
  const categories=Object.entries(d.categoryHits||{}).filter(([,v])=>Array.isArray(v)&&v.length).map(([k,v])=>`${k}: ${v.length}`).join(' · ')||'No category matches retained';
  host.innerHTML=`<div class="page-diag-grid diagnostic-summary-grid">
    <div><span>Diagnostic version</span><strong>${escapeHtml(d.javascriptDiagnosticVersion||'—')}</strong></div>
    <div><span>Captured</span><strong>${escapeHtml(d.capturedAt?new Date(d.capturedAt).toLocaleString():'—')}</strong></div>
    <div><span>Realm</span><strong>${escapeHtml(realmName(d.realm))}</strong></div>
    <div><span>JS bundles</span><strong>${b.length}${errorBundles?` · ${errorBundles} skipped/error`:''}</strong></div>
    <div><span>Discovered API routes</span><strong>${routes.length}</strong></div>
    <div><span>Performance resources</span><strong>${perf.length}</strong></div>
    <div><span>IndexedDB databases</span><strong>${Array.isArray(d.indexedDB)?d.indexedDB.length:0}</strong></div>
    <div><span>Cache names</span><strong>${Array.isArray(d.caches?.names)?d.caches.names.length:0}</strong></div>
    <div><span>Service workers</span><strong>${Array.isArray(d.serviceWorkers)?d.serviceWorkers.length:0}</strong></div>
    <div><span>Local storage keys</span><strong>${Array.isArray(storage.localStorageKeys)?storage.localStorageKeys.length:0}</strong></div>
    <div><span>Session storage keys</span><strong>${Array.isArray(storage.sessionStorageKeys)?storage.sessionStorageKeys.length:0}</strong></div>
    <div><span>Snapshot changes</span><strong>${diff?.available?`${addedBundles} new bundles · ${changedBundles} changed · ${addedRoutes} new routes`:'First snapshot'}</strong></div>
  </div>
  <p class="muted">${escapeHtml(categories)}</p>
  ${diff?.available?`<details><summary>Snapshot diff: ${addedBundles} new bundles, ${changedBundles} changed bundles, ${addedRoutes} new routes, ${removedRoutes} removed routes</summary><pre class="diagnostic-pre">${escapeHtml(JSON.stringify(diff,null,2).slice(0,80000))}</pre></details>`:''}
  <details><summary>Discovered API routes (${routes.length})</summary><pre class="diagnostic-pre">${escapeHtml(JSON.stringify(routes,null,2).slice(0,50000))}</pre></details>
  <details><summary>Bundle inventory (${b.length})</summary><pre class="diagnostic-pre">${escapeHtml(JSON.stringify(b,null,2).slice(0,100000))}</pre></details>
  <details><summary>Runtime / storage / worker metadata</summary><pre class="diagnostic-pre">${escapeHtml(JSON.stringify({runtime:d.runtime,storage:d.storage,indexedDB:d.indexedDB,caches:d.caches,serviceWorkers:d.serviceWorkers,globalKeys:d.globalKeys},null,2).slice(0,100000))}</pre></details>`;
}
function renderDiagnostics(s){
  const {realm, key, store}=diagnosticStore(s);
  const producedKeys=diagnosticProducedKeys(store||{});
  const overlayRows=Array.isArray(store?.gameOverlaySnapshot?.rows)?store.gameOverlaySnapshot.rows:[];
  const endpointEntries=Object.entries(store?.endpointData||{}).map(([url,v])=>({url,captureRealm:v?.captureRealm??null,status:v?.status??null,receivedAt:v?.receivedAt??null})).sort((a,b)=>Date.parse(b.receivedAt||0)-Date.parse(a.receivedAt||0));
  const mismatches=endpointEntries.filter(x=>x.captureRealm!=null&&Number(x.captureRealm)!==Number(realm));
  const overlayRealm=store?.gameOverlaySnapshot?.realm;
  const overlayMismatch=overlayRealm!=null&&Number(overlayRealm)!==Number(realm);
  const outputRows=overlayRows.filter(r=>producedKeys.has(diagnosticResourceKey(r.id,r.quality)));
  const demandOnlyRows=overlayRows.filter(r=>Number(r.demand||0)>0&&!producedKeys.has(diagnosticResourceKey(r.id,r.quality)));
  const warehouseRowsNow=warehouseRows(store||{});
  const productionHistoryCount=Object.keys(store?.endpointData||{}).filter(k=>/\/companies\/buildings\/\d+\/history\/?/i.test(k)).length;
  const vwapRows=Array.isArray(store?.vwapData?.rows)?store.vwapData.rows.length:Number(store?.vwapData?.count)||0;
  const summary=$('#diagnosticSummary');
  if(summary)summary.innerHTML=`<div class="page-diag-grid diagnostic-summary-grid">
    <div><span>Selected realm</span><strong>${escapeHtml(realmName(realm))}</strong></div>
    <div><span>Active realm key</span><strong>${escapeHtml(s?.activeRealmKey||'—')}</strong></div>
    <div><span>Capture realm</span><strong>${escapeHtml(store?.authData?.authCompany?.realmId??store?.gameOverlaySnapshot?.realm??'—')}</strong></div>
    <div><span>Sync status</span><strong>${escapeHtml(store?.syncStatus||'—')}</strong></div>
    <div><span>Sync error</span><strong>${escapeHtml(store?.syncError&&scmIsBlockNotice(store.syncError)?`Note: ${store.syncError}`:(store?.syncError||'None'))}</strong></div>
    <div><span>Buildings</span><strong>${buildingArrayFromState(store||{}).length}</strong></div>
    <div><span>Warehouse lines</span><strong>${warehouseRowsNow.length}</strong></div>
    <div><span>Overlay rows</span><strong>${overlayRows.length}</strong></div>
    <div><span>Planned output keys</span><strong>${producedKeys.size}</strong></div>
    <div><span>Demand-only overlay rows</span><strong>${demandOnlyRows.length}</strong></div>
    <div><span>History endpoint captures</span><strong>${productionHistoryCount}</strong></div>
    <div><span>Production snapshots</span><strong>${Object.keys(store?.productionRateSnapshots||{}).length}</strong></div>
    <div><span>API responses</span><strong>${Object.keys(store?.endpointData||{}).length}</strong></div>
    <div><span>API realm mismatches</span><strong>${mismatches.length}</strong></div>
    <div><span>VWAP rows</span><strong>${vwapRows}</strong></div>
    <div><span>Full sync diagnostic</span><strong>${store?.fullSyncDiagnostics?'Captured':'Not captured'}</strong></div>
  </div>`;

  const integrity=$('#diagnosticIntegrity');
  if(integrity){
    const checks=[
      [s?.activeRealmKey===key,'Active realm key matches selected realm',`Selected ${key||'—'} · active ${s?.activeRealmKey||'—'}`],
      [!overlayMismatch,'Overlay realm matches selected realm',`Overlay realm ${overlayRealm??'—'} · selected ${realm??'—'}`],
      [mismatches.length===0,'All captured API responses match selected realm',mismatches.length?`${mismatches.length} response(s) are stamped with another capture realm.`:'No stamped API capture mismatches.'],
      [(() => {
        const diag=store?.fullSyncDiagnostics||{};
        const diagRealm=validRealmNumber(diag?.realm);
        const selected=validRealmNumber(realm);
        const completedAt=String(store?.lastSync||diag?.lastSync||diag?.finishedAt||'').trim();
        const complete=/Sync complete/i.test(String(diag?.status||'')) && !diag?.syncError &&
          (diagRealm==null || selected==null || diagRealm===selected) &&
          !!completedAt && Number.isFinite(Date.parse(completedAt));
        return complete;
      })(), 'Sync completed without an error', (() => {
        const diag=store?.fullSyncDiagnostics||{};
        const completedAt=String(store?.lastSync||diag?.lastSync||diag?.finishedAt||'').trim();
        return completedAt ? (store?.syncError||'Completion recorded.') : 'No completed sync transaction is recorded.';
      })()],
      [Array.isArray(store?.warehouseResources)&&store.warehouseResources.length>0,'Warehouse data captured',`${Array.isArray(store?.warehouseResources)?store.warehouseResources.length:0} warehouse rows.`],
      [overlayRows.length>0,'Overlay snapshot captured',`${overlayRows.length} overlay rows.`]
    ];
    integrity.innerHTML=`<div class="diagnostic-check-list">${checks.map(([ok,title,detail])=>`<div class="diagnostic-check ${ok?'ok':'warn'}"><strong>${ok?'PASS':'CHECK'}</strong><span><b>${escapeHtml(title)}</b><small>${escapeHtml(detail)}</small></span></div>`).join('')}</div>`;
  }

  const overlayAudit=$('#diagnosticOverlayAudit');
  if(overlayAudit){
    const rowsHtml=overlayRows.map(r=>{
      const made=producedKeys.has(diagnosticResourceKey(r.id,r.quality));
      const flag=!made&&Number(r.demand||0)>0?'demand-only':made?'output':'other';
      return `<tr><td>${escapeHtml(r.name||resourceName({kind:r.id},store||{}))}</td><td>${escapeHtml(r.id??'—')}</td><td>Q${r.quality??'—'}</td><td>${num(r.warehouse)}</td><td>${num(r.produced)}</td><td>${num(r.demand)}</td><td>${num(r.leftover)}</td><td><span class="diagnostic-pill ${flag}">${escapeHtml(flag)}</span></td></tr>`;
    }).join('');
    overlayAudit.innerHTML=`<p class="muted">${outputRows.length} output rows, ${demandOnlyRows.length} demand-only rows. Demand-only rows are the quality mappings we need to trace.</p><div class="table-wrap"><table class="diagnostic-table"><thead><tr><th>Resource</th><th>ID</th><th>Quality</th><th>Warehouse</th><th>Produced</th><th>Demand</th><th>Left</th><th>Status</th></tr></thead><tbody>${rowsHtml||'<tr><td colspan="8">No overlay rows captured.</td></tr>'}</tbody></table></div>`;
  }

  const costAudit=$('#diagnosticCostAudit');
  if(costAudit){
    const activeOutputCosts=[];
    for(const b of buildingArrayFromState(store||{})){
      const br=b?.busy?.resource;
      if(br?.kind!=null&&br?.quality!=null&&br?.unitCost!=null)activeOutputCosts.push({name:br.name,id:Number(br.kind),quality:Number(br.quality),unitCost:Number(br.unitCost),building:b.name||b.id});
    }
    const costRows=warehouseRowsNow.map(r=>`<tr><td>${escapeHtml(resourceName(r,store||{}))}</td><td>Q${escapeHtml(r._quality)}</td><td>${num(r._qty)}</td><td>${r._unitCost==null?'—':money(r._unitCost)}</td></tr>`).join('');
    const outputRowsCost=activeOutputCosts.map(r=>`<tr><td>${escapeHtml(r.name)}</td><td>Q${r.quality}</td><td>${money(r.unitCost)}</td><td>${escapeHtml(r.building)}</td></tr>`).join('');
    costAudit.innerHTML=`<div class="diagnostic-cost-grid"><div><h4>Warehouse calculated cost</h4><div class="table-wrap"><table class="diagnostic-table"><thead><tr><th>Resource</th><th>Q</th><th>Qty</th><th>Your Cost</th></tr></thead><tbody>${costRows||'<tr><td colspan="4">No warehouse rows.</td></tr>'}</tbody></table></div></div><div><h4>Active production unit cost</h4><div class="table-wrap"><table class="diagnostic-table"><thead><tr><th>Output</th><th>Q</th><th>Unit cost</th><th>Building</th></tr></thead><tbody>${outputRowsCost||'<tr><td colspan="4">No active production costs.</td></tr>'}</tbody></table></div></div></div><details><summary>Captured warehouse cost details</summary><pre class="diagnostic-pre">${escapeHtml(JSON.stringify(store?.warehouseCostDetails||{},null,2).slice(0,50000))}</pre></details>`;
  }

  const trace=$('#diagnosticApiTrace');
  if(trace){
    const traceRows=endpointEntries.slice(0,80).map(x=>{const mismatch=x.captureRealm!=null&&Number(x.captureRealm)!==Number(realm);const status=Number(x.status);const cls=mismatch||status>=400?'warn':'ok';return `<tr><td>${escapeHtml(x.captureRealm??'—')}</td><td>${status||'—'}</td><td>${escapeHtml(x.receivedAt?new Date(x.receivedAt).toLocaleTimeString():'—')}</td><td class="${cls}">${escapeHtml(x.url)}</td></tr>`;}).join('');
    trace.innerHTML=`<div class="table-wrap"><table class="diagnostic-table api-trace-table"><thead><tr><th>Capture realm</th><th>Status</th><th>Time</th><th>Endpoint</th></tr></thead><tbody>${traceRows||'<tr><td colspan="4">No captured API responses.</td></tr>'}</tbody></table></div>`;
  }
  renderJavascriptDiagnostic(s); const raw=$('#diagnosticRaw');if(raw)buildDiagnosticBundle(s).then(b=>{raw.textContent=JSON.stringify(b,null,2).slice(0,100000)}).catch(()=>{});
}

function accountingCashflowSummary(cf){
  if(!cf||typeof cf!=='object')return '<p class="muted">No cash-flow response captured yet.</p>';
  const exclude=new Set(['data','transactions','transaction','items','entries','movements','operations','results','cashflow','cashFlow','history','records','isComputed']);
  if(cf.isComputed!==false&&Object.keys(cf).length&&typeof SCM_TOOLS_CORE!=='undefined'){const g=SCM_TOOLS_CORE.gameFinancialStatements({},{},cf);return gameStatementCard('Cashflow Statement',g.cashflow,g.extra.cf);}
  const rows=financialEntries(cf,exclude);
  return rows.length?`<div class="statement-grid">${statementTable('Cash Flow Fields',rows.slice(0,40))}</div>`:'<p class="muted">The cash-flow endpoint was captured, but it did not expose numeric summary fields.</p>';
}
function accountingIncomeStatement(src){
  if(!src||typeof src!=='object')return '<p class="muted">No income statement response captured yet.</p>';
  const exclude=new Set(['data','rows','items','entries','transactions','results','isComputed']);
  if(src.isComputed!==false&&Object.keys(src).length&&typeof SCM_TOOLS_CORE!=='undefined'){const g=SCM_TOOLS_CORE.gameFinancialStatements(src,{},{});return gameStatementCard('Income Statement',g.income,g.extra.income);}
  const rows=financialEntries(src,exclude);
  return rows.length?`<div class="statement-grid">${statementTable('Income Statement Fields',rows.slice(0,60))}</div>`:'<p class="muted">No readable income-statement summary fields were captured.</p>';
}
// Overview quick-view cards: Accounting, Warehouse, Production. Read-only summaries of data the Manager
// already holds at render time. No fetches, no new formulas and no side effects: acctCardNow, image requests and
// the planner are left alone. Each card links to the tab that has the full detail.
function accountingLatestTime(s){
  const rx=/\/api\/(?:v2|v3)\/companies\/(?:me|\d+)\/(?:balance-sheet|cashflow(?:\/recent)?|cashflow-statement|income-statement|past-finances-overview|administration-overhead|past-finances)(?:\/\d+)?\/?$/i;
  const times=Object.entries(s?.endpointData||{})
    .filter(([url,v])=>rx.test(url)&&Number(v?.status)===200&&v?.data!=null)
    .map(([,v])=>Date.parse(v?.receivedAt||''))
    .filter(Number.isFinite)
    .sort((x,y)=>y-x);
  return times[0]||null;
}
// The same five expense lines the Accounting tab lists, shown as positive costs (acctSigned), added together.
const OV_EXPENSE_KEYS=['cogs','freightOut','marketFees','executives','operatingExpenses'];
function ovExpenseTotal(a){if(!a)return null;let sum=0,seen=0;for(const k of OV_EXPENSE_KEYS){const v=acctSigned(k,a[k]);if(v!=null){sum+=v;seen++;}}return seen?sum:null;}
function ovGoto(tab,text,tabLabel){return `<button type="button" class="ov-link" data-goto-tab="${escapeHtml(tab)}">${escapeHtml(text)} <b>${escapeHtml(tabLabel)}</b></button>`;}
function ovHead(title,sub,badge){return `<div class="overview-section-head"><div><h3>${escapeHtml(title)}</h3><span>${escapeHtml(sub)}</span></div>${badge?`<span class="overview-section-badge">${escapeHtml(badge)}</span>`:''}</div>`;}
function overviewAccountingCard(s,display,previous){
  const sales=acctSigned('sales',display?.revenue),salesPrev=acctSigned('sales',previous?.sales);
  const exp=ovExpenseTotal(display),expPrev=previous?ovExpenseTotal(previous):null;
  const t=accountingLatestTime(s);
  const when=t?`Last updated: ${new Date(t).toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'})}`:'Waiting for latest financial response';
  const period=accountingStatementPeriodText(display?.period);
  // 'cogs' only selects cost colouring in acctChangeHtml (a fall in expenses is green).
  const tile=(label,key,v,p)=>`<div class="finance-card"><span class="finance-label">${escapeHtml(label)}</span><div class="finance-value">${v==null?'—':money(v)}</div>${acctChangeHtml(key,v,p)}</div>`;
  return `<div class="overview-section ov-half ov-accounting" data-collapse-default="open">${ovHead('Accounting',period?`Current statements · ${period}`:'Current statements vs the day before')}`
    +`<div class="accounting-live"><span class="accounting-live-dot"></span><strong>LIVE</strong><span class="accounting-live-divider"></span><span>${escapeHtml(when)}</span></div>`
    +`<div class="ov-fin">${tile('Sales','sales',sales,salesPrev)}${tile('Expenses · 5 cost lines','cogs',exp,expPrev)}</div>`
    +`${ovGoto('accounting','Full statements in','Accounting')}</div>`;
}
function overviewWarehouseCard(s,rows){
  const all=Array.isArray(rows)?rows:[];
  // largest lines by stock value: market price when known, otherwise the line's own unit cost
  const top=all.map(r=>{const price=scmMarketPrice(s,r._id,r._quality,'exact')?.price??null;const unit=Number(r._unitCost);const each=price!=null?Number(price):(Number.isFinite(unit)?unit:0);return {r,price,value:each*(Number(r._qty)||0)};})
    .sort((x,y)=>y.value-x.value).slice(0,4);
  const row=({r,price})=>{
    const margin=price!=null&&r._unitCost>0?(price-r._unitCost)/r._unitCost*100:null;
    const ri=resourceInfo(r,s),local=s?.resourceImageCache?.[String(r._id)]||s?.resourceImageData?.[String(r._id)]||null;
    const srcs=scmImgSrcs(r._id,local?[local,...(ri.imageCandidates||[])]:(ri.imageCandidates||[]));
    const img=srcs.length?`<img class="resource-icon" src="${escapeHtml(scmSafeImgSrc(srcs[0]))}" data-candidates="${escapeHtml(scmCandidatesJson(srcs))}" data-idx="0" data-rid="${Number(r._id)||0}" alt="" loading="lazy" data-scm-fallback="1">`:'<span class="resource-icon"></span>';
    return `<tr><td><div class="product-cell">${img}<span><strong>${escapeHtml(resourceName(r,s))}</strong><small>Q${escapeHtml(String(r._quality??'—'))}</small></span></div></td><td>${num(r._qty)}</td><td>${r._unitCost!=null?money(r._unitCost):'—'}</td><td>${price!=null?money(price):'—'}</td><td class="${margin==null?'':margin>=0?'positive':'negative'}">${margin==null?'—':margin.toFixed(1)+'%'}</td></tr>`;
  };
  const body=top.length?`<div class="table-wrap"><table class="warehouse-table ov-wh-table"><thead><tr><th>Product</th><th>Qty</th><th>Cost</th><th>Market</th><th>Margin</th></tr></thead><tbody>${top.map(row).join('')}</tbody></table></div>`:'<div class="overview-selling-empty">No warehouse data captured yet.</div>';
  return `<div class="overview-section ov-half ov-warehouse" data-collapse-default="open">${ovHead('Warehouse','Largest stock lines by value',`${all.length} line${all.length===1?'':'s'}`)}${body}${ovGoto('warehouse',`All ${all.length} lines in`,'Warehouse')}</div>`;
}
function overviewProductionCard(s){
  // Production buildings only (category 'production', as background.js / diagnosticProducedKeys): the Academy, Bank and
  // other non-production buildings are not idle. A building that is expanding (construction / upgrade) is counted apart.
  const all=buildingArrayFromState(s),prod=all.filter(b=>String(b?.category||'').toLowerCase()==='production');
  const expanding=prod.filter(buildingIsExpanding),busy=prod.filter(b=>!buildingIsExpanding(b)&&b?.busy?.resource),idle=prod.length-expanding.length-busy.length;
  const stat=(l,v)=>`<div class="overview-stat-card"><span>${escapeHtml(l)}</span><strong>${escapeHtml(String(v))}</strong></div>`;
  const has=prod.length>0;
  const tiles=`<div class="overview-stat-grid ${expanding.length?'':'overview-stat-grid-compact'}">${stat('Production buildings',has?prod.length:'—')}${stat('Producing',has?busy.length:'—')}${stat('Idle',has?idle:'—')}${expanding.length?stat('Under construction',expanding.length):''}</div>`;
  const making=busy.slice(0,4).map(b=>{const r=b.busy.resource;const id=Number(r?.kind);const name=String(r?.name||(Number.isFinite(id)?resourceName({kind:id},s):'—'));return `<div class="planner-summary-row"><span>${escapeHtml(buildingName(b,s))}<small>Lv ${escapeHtml(String(buildingLevel(b)))}</small></span><strong>${escapeHtml(name)}${r?.quality!=null?` Q${escapeHtml(String(r.quality))}`:''}</strong></div>`;}).join('');
  const sub=has?`${prod.length} production building${prod.length===1?'':'s'} · ${busy.length} producing${expanding.length?` · ${expanding.length} under construction`:''}`:'Waiting for building data';
  return `<div class="overview-section ov-wide ov-production" data-collapse-default="open">${ovHead('Production',sub,busy.length>4?`Showing 4 of ${busy.length}`:'')}${tiles}${making?`<div class="ov-making">${making}</div>`:''}${ovGoto('production','Buildings, inputs, deficit and surplus in','Production')}</div>`;
}
function render(s){
  const currentKey=__scmState?.activeRealmKey!=null?String(__scmState.activeRealmKey):'';
  const incomingKey=s?.activeRealmKey!=null?String(s.activeRealmKey):'';
  if(currentKey&&incomingKey&&currentKey!==incomingKey)return false;
  const currentView=validRealmNumber(__scmState?.viewRealm);
  const incomingView=validRealmNumber(s?.viewRealm);
  if(currentView!=null&&incomingView!=null&&currentKey===incomingKey&&currentView!==incomingView)return false;
  // Preserve the user's exact scroll position while live storage updates redraw the dashboard.
  // Sync/background progress can change content above the current viewport; restoring the
  // position prevents the page from jumping when Sync updates state.
  const __scrollX=window.scrollX, __scrollY=window.scrollY;
  s=s||{}; s.endpointData=s.endpointData||{}; commitDashboardState(s); updateRealmSwitcher(s); renderLiveMarketProduct(s); if(activeTab==='settings')renderFullSyncDiagnostics(s);
 const viewRealm=s.viewRealm!=null?Number(s.viewRealm):(s.captureRealm!=null?Number(s.captureRealm):null);
 const viewKey=viewRealm!=null?`realm:${viewRealm}`:null;
 const viewStore=viewKey&&s.realmStores?.[viewKey]?s.realmStores[viewKey]:null;
 // The header is part of the selected realm view too. Do not fall back to the
 // live realm's auth/company snapshot when the user is viewing the other realm,
 // otherwise the warehouse/contracts/etc. can switch correctly while the header
 // still shows the live company's name and sync state.
 const viewAuth=viewStore?.authData || (viewRealm==null?s.authData:null);
 const d=viewAuth?.authCompany||{};const a=accounting(s,viewStore);const accountingSnap=updateAccountingSnapshot(s,a);
 const accountingRollover=(a?.source?.cf?.isComputed===false || a?.source?.income?.isComputed===false) && Number(a?.revenue)===0 && Number(a?.profit)===0;
 const accountingDisplayBase=accountingRollover && accountingSnap?.current ? {...a,revenue:accountingSnap.current.revenue??a.revenue,expenses:accountingSnap.current.expenses??a.expenses,profit:accountingSnap.current.profit??a.profit,period:accountingSnap.period||a.period} : a; const accountingDisplay=accountingPeriodViewData(accountingDisplayBase,accountingPeriodView);
 const rows=warehouseRows(s);
 $('#title').textContent=d.company||'Company Manager';const buildEl=$('#managerBuild');if(buildEl)buildEl.textContent=`Build ${BUILD_VERSION}`;const realm=viewRealm!=null?viewRealm:(d.realmId!=null?d.realmId:d.realm);const realmEl=$('#realmInfo');if(realmEl)realmEl.textContent=realm!=null?realmName(realm):'Realm —';const syncEl=$('#syncInfo');if(syncEl){const liveStatus=s.syncStatus||'';const liveError=s.syncError||'';const hasCapturedData=!!(viewStore&&(viewStore.lastSync||viewStore.fullSyncDiagnostics||viewStore.gameOverlaySnapshot||(Array.isArray(viewStore.buildings)&&viewStore.buildings.length)||(Array.isArray(viewStore.warehouseResources)&&viewStore.warehouseResources.length)||(viewStore.endpointData&&Object.keys(viewStore.endpointData).length)||(viewStore.productionRateSnapshots&&Object.keys(viewStore.productionRateSnapshots).length)));if(__realmHydrationPending&&viewRealm!=null) syncEl.textContent=`Switching to ${realmName(viewRealm)}…`;else if(liveStatus&&(liveStatus.startsWith('R1 Sync:')||liveStatus.startsWith('R2 Sync:'))) syncEl.textContent=liveStatus;else if(liveError) syncEl.textContent=`${liveStatus||'Error'}: ${liveError}`;else if(viewStore?.lastSync) syncEl.textContent=`Last sync ${new Date(viewStore.lastSync).toLocaleString()} · ${viewStore.syncStatus||'OK'}`;else if(viewRealm!=null&&hasCapturedData) syncEl.textContent='Captured data available · Sync not completed';else if(viewRealm!=null) syncEl.textContent='No data captured for this realm';else syncEl.textContent='No sync yet';}
 const acctDailySeries=updateAccountingDailySeries(s,a); if(activeTab==='overview'){ const contractRows=currentContracts(s); const incomingGross=contractRows.filter(c=>c.direction==='Incoming').reduce((sum,c)=>sum+(Number(c.total)||0),0); const outgoingGross=contractRows.filter(c=>c.direction==='Outgoing').reduce((sum,c)=>sum+(Number(c.total)||0),0); const savedRows=savedContracts(s); const savedGross=savedRows.reduce((sum,c)=>sum+roundCurrencyUp((Number(savedContractPrice(c,s))||0)*savedContractEffectiveQuantity(c,s)),0); const buildingCount=buildingArrayFromState(s).length; const warehouseQty=rows.reduce((sum,r)=>sum+(Number(r._qty)||0),0); const vwapCount=Array.isArray(s.vwapData?.rows)?s.vwapData.rows.length:Number(s.vwapData?.count)||0; const topSelling=topSellingResourcesByProfit(accountingDisplayBase,s); const topGross=topGrossResources(accountingDisplayBase,s); const overviewDate=v=>{const d=v!=null?new Date(v):null;return d&&Number.isFinite(d.getTime())?d.toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}):null;}; const overviewRange=overviewDate(topSelling.rangeStart)&&overviewDate(topSelling.rangeEnd)?`${overviewDate(topSelling.rangeStart)} – ${overviewDate(topSelling.rangeEnd)}`:'Captured range unavailable'; const overviewCards=$('#overviewCards'); if(overviewCards) overviewCards.innerHTML=`<div class="overview-grid">
<div class="overview-section overview-operations-card"><div class="overview-section-head"><div><h3>Operations</h3><span>Company activity at a glance</span></div></div><div class="overview-stat-grid"><div class="overview-stat-card"><span>Buildings</span><strong>${buildingCount||'—'}</strong></div><div class="overview-stat-card"><span>Warehouse Lines</span><strong>${rows.length||'—'}</strong></div><div class="overview-stat-card"><span>Warehouse Qty</span><strong>${warehouseQty?num(warehouseQty):'—'}</strong></div><div class="overview-stat-card"><span>VWAP Values</span><strong>${vwapCount?num(vwapCount):'—'}</strong></div></div></div>
<div class="overview-section"><div class="overview-section-head"><div><h3>Contracts</h3><span>Current active and saved value</span></div></div><div class="overview-stat-grid overview-stat-grid-compact"><div class="overview-stat-card"><span>Incoming</span><strong>${money(incomingGross)}</strong><small>${contractRows.filter(c=>c.direction==='Incoming').length} active</small></div><div class="overview-stat-card"><span>Outgoing</span><strong>${money(outgoingGross)}</strong><small>${contractRows.filter(c=>c.direction==='Outgoing').length} active</small></div><div class="overview-stat-card"><span>Saved</span><strong>${money(savedGross)}</strong><small>${savedRows.length} saved</small></div></div></div>
<div class="overview-resource-ranking-stack"><div class="overview-section overview-top-selling"><div class="overview-section-head"><div><h3>Top 10 Net Profit Resources</h3><span>Captured selling profit · ${escapeHtml(overviewRange)}</span></div><span class="overview-section-badge">Net Profit</span></div><div class="overview-selling-list">${topSelling.loading?'<div class="overview-selling-empty">Loading weekly sales ledger…</div>':topSelling.items.length?topSelling.items.map(x=>{const srcs=scmImgSrcs(x.resourceId,x.image?[x.image,...x.images.filter(v=>v!==x.image)]:x.images);const img=srcs.length?`<img class="overview-resource-icon" src="${escapeHtml(scmSafeImgSrc(srcs[0]))}" data-candidates="${escapeHtml(scmCandidatesJson(srcs))}" data-idx="0" data-rid="${Number(x.resourceId)||0}" alt="" loading="lazy" data-scm-fallback="1">`:'<span class="overview-resource-icon" aria-hidden="true"></span>';return `<div class="overview-selling-row"><span class="overview-rank">${x.rank}</span>${img}<span class="overview-selling-name">${escapeHtml(x.name)}</span><span class="overview-selling-quantity"><small>Qty sold</small><strong>${num(x.amount)}</strong></span><span class="overview-selling-profit"><small>Net Profit</small><strong>${money(x.profit)}</strong></span></div>`}).join(''):'<div class="overview-selling-empty">No selling profit data captured yet.</div>'}</div></div>
<div id="overviewTopGross" class="overview-section overview-top-selling"><div class="overview-section-head"><div><h3>Top 10 Gross Resources</h3><span>Captured sales value · ${escapeHtml(overviewDate(topGross.rangeStart)&&overviewDate(topGross.rangeEnd)?`${overviewDate(topGross.rangeStart)} – ${overviewDate(topGross.rangeEnd)}`:'Captured range unavailable')}</span></div><span class="overview-section-badge">Gross</span></div><div class="overview-selling-list">${topGross.loading?'<div class="overview-selling-empty">Loading weekly sales ledger…</div>':topGross.items.length?topGross.items.map(x=>{const srcs=scmImgSrcs(x.resourceId,x.image?[x.image,...x.images.filter(v=>v!==x.image)]:x.images);const img=srcs.length?`<img class="overview-resource-icon" src="${escapeHtml(scmSafeImgSrc(srcs[0]))}" data-candidates="${escapeHtml(scmCandidatesJson(srcs))}" data-idx="0" data-rid="${Number(x.resourceId)||0}" alt="" loading="lazy" data-scm-fallback="1">`:'<span class="overview-resource-icon" aria-hidden="true"></span>';return `<div class="overview-selling-row"><span class="overview-rank">${x.rank}</span>${img}<span class="overview-selling-name">${escapeHtml(x.name)}</span><span class="overview-selling-quantity"><small>Qty sold</small><strong>${num(x.amount)}</strong></span><span class="overview-selling-profit"><small>Gross</small><strong>${money(x.gross)}</strong></span></div>`}).join(''):'<div class="overview-selling-empty">No gross sales data captured yet.</div>'}</div></div></div>${overviewAccountingCard(s,accountingDisplayBase,accountingComparisonBase(a))}${overviewWarehouseCard(s,rows)}${overviewProductionCard(s)}</div>${renderCompanyHistoryCard(s)}`; if($('#overviewRealmBadge')){const syncTime=viewStore?.lastSync||s.lastSync;const hasCapturedData=!!(viewStore&&(viewStore.lastSync||viewStore.fullSyncDiagnostics||viewStore.gameOverlaySnapshot||(Array.isArray(viewStore.buildings)&&viewStore.buildings.length)||(Array.isArray(viewStore.warehouseResources)&&viewStore.warehouseResources.length)||(viewStore.endpointData&&Object.keys(viewStore.endpointData).length)||(viewStore.productionRateSnapshots&&Object.keys(viewStore.productionRateSnapshots).length)));const badgeStatus=__realmHydrationPending?'Switching…':syncTime?new Date(syncTime).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):(hasCapturedData?'Captured · sync not completed':'Not synced');$('#overviewRealmBadge').textContent=`${realm!=null?realmName(realm):'Realm —'} · ${badgeStatus}`; } } if(activeTab==='accounting'){ if($('#accountingSource')){const period=accountingDisplay.period?.dateFrom&&accountingDisplay.period?.date?` · ${new Date(accountingDisplay.period.dateFrom).toLocaleDateString()}–${new Date(accountingDisplay.period.date).toLocaleDateString()}`:(accountingDisplay.period?.date?` · ${new Date(accountingDisplay.period.date).toLocaleDateString()}`:''); $('#accountingSource').textContent=`Source: ${a.sourceType==='income-statement'?'income statement':a.sourceType==='cash-flow-derived'?'cash-flow statement':'unavailable'}${period}`;} if($('#accountingPeriodBadge')){const dateEl=$('#accountingPeriodDate'),metaEl=$('#accountingPeriodMeta');document.querySelectorAll('[data-accounting-period]').forEach(x=>x.classList.toggle('active',String(x.dataset.accountingPeriod||'current')===accountingPeriodView));const labels={current:'Current statements date',day:'Day',week:'Week',month:'Month'};const stmtText=accountingPeriodView==='current'?accountingStatementPeriodText(accountingDisplay.period):'';if(dateEl)dateEl.textContent=labels[accountingPeriodView]||labels.current;if(metaEl)metaEl.textContent=accountingDisplay.periodSource==='recent-cashflow'?`Derived from captured cash-flow rows · ${Number(accountingDisplay.periodTransactionCount)||0} transactions`:(stmtText||'Game accounting view');} if($('#accountingLiveStatus')){
   const latestTime=accountingLatestTime(s);
   $('#accountingLiveStatus').textContent=latestTime
     ?`Last updated: ${new Date(latestTime).toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'})}`
     :'Waiting for latest financial response';
} if($('#accountingOverview'))renderAccountingOverview($('#accountingOverview'),accountingDisplay,accountingPeriodView==='current'?accountingComparisonBase(a):null,a.history,acctDailySeries); if($('#accountingHistory')){if(scmSetHTML($('#accountingHistory'),accountingHistoryTable(a.history,(viewStore||s)?.accountingDayWalkStatus||null)))scmApplyCollapse($('#accountingHistory'));renderAccountingWalkSchedule(s);} if($('#accountingBalanceSummary'))scmSetHTML($('#accountingBalanceSummary'),`<div class="overview-stat-grid accounting-balance-summary"><div class="overview-stat-card"><span>Cash</span><strong>${money(a.cash)}</strong></div><div class="overview-stat-card"><span>Accounts Receivable</span><strong>${money(a.accountsReceivable)}</strong></div><div class="overview-stat-card"><span>Inventory</span><strong>${money(a.inventory)}</strong></div><div class="overview-stat-card"><span>Current Assets</span><strong>${money(a.currentAssets)}</strong></div><div class="overview-stat-card"><span>Accounts Payable</span><strong>${money(a.accountsPayable)}</strong></div><div class="overview-stat-card"><span>Bonds Payable</span><strong>${money(a.bondsPayable)}</strong></div><div class="overview-stat-card"><span>Current Liabilities</span><strong>${money(a.currentLiabilities)}</strong></div><div class="overview-stat-card"><span>Total Assets</span><strong>${money(a.assets)}</strong></div><div class="overview-stat-card"><span>Total Liabilities</span><strong>${money(a.liabilities)}</strong></div></div>`); if($('#accountingCashflowSummary'))scmSetHTML($('#accountingCashflowSummary'),accountingCashflowSummary(a.source?.cf)); if($('#accountingIncomeStatement'))scmSetHTML($('#accountingIncomeStatement'),accountingIncomeStatement(a.source?.income)); if($('#balanceDetails'))scmSetHTML($('#balanceDetails'),buildBalanceSections(a.source?.bs)); if($('#accountingRatios'))scmSetHTML($('#accountingRatios'),accountingFinancialRatios(a.source?.income,a.source?.bs)); }
 if(activeTab==='warehouse'){ renderWarehouseMarketTimestamp(s); try{renderWarehouseRunOut(s);}catch(e){console.error('Run-out render failed',e);} const inventoryRowsEl=$('#inventoryRows'); if(inventoryRowsEl) inventoryRowsEl.innerHTML=rows.length?rows.map(r=>{const priceRef=scmMarketPrice(s,r._id,r._quality,'exact'),marketPrice=priceRef?.price??null;const margin=marketPrice!=null&&r._unitCost>0?(marketPrice-r._unitCost)/r._unitCost*100:null;const ri=resourceInfo(r,s);const imgs=ri.imageCandidates||[];const localImage=s.resourceImageCache?.[String(r._id)]||s.resourceImageData?.[String(r._id)]||null;if(!localImage) requestResourceImage(r._id);const srcs=scmImgSrcs(r._id,localImage?[localImage,...imgs]:imgs);const img=srcs.length?`<img class="resource-icon" src="${escapeHtml(scmSafeImgSrc(srcs[0]))}" data-candidates="${escapeHtml(scmCandidatesJson(srcs))}" data-idx="0" data-rid="${Number(r._id)||0}" alt="" loading="lazy" data-scm-fallback="1">`:'';const activeCost=activeProductionCostCells(s,r);return `<tr data-warehouse-key="${Number(r._id)}:${Number(r._quality)}"><td><div class="product-cell">${img}<span><strong>${escapeHtml(resourceName(r,s))}</strong><small>#${escapeHtml(r._id)}</small></span></div>${warehouseHeadCost(r)}</td><td>${num(r._qty)}</td><td>${escapeHtml(r._quality??'—')}</td><td>${r._unitCost==null?'—':money(r._unitCost)}</td><td>${activeCost.costHtml}</td><td>${activeCost.diffHtml}</td><td data-cell="prod-cost-history">${productionCostHistoryCell(s,r)}</td><td><span class="cell-stack">${marketPrice==null?'—':money(marketPrice)}<small class="market-source">${escapeHtml(scmMarketSourceText(priceRef))}</small></span></td><td class="${margin==null?'':margin>=0?'positive':'negative'}">${margin==null?'—':margin.toFixed(1)+'%'}</td></tr>`}).join(''):'<tr><td colspan="9">No warehouse data captured.</td></tr>'; }
 if(activeTab==='market'){ renderLiveMarketProduct(s); renderMarketHistory(s); } if(activeTab==='production') renderBuildingPlanner(s,{background:true}); // same-HTML repaints are skipped
 renderVwapDiagnostics(s);
 if(activeTab==='executives'){try{renderBoardRoom(s);}catch(e){console.error('Executives tab render failed',e);}} if(activeTab==='tools'){try{globalThis.SCM_TOOLS_UI?.render(s,catalogEntries(s));}catch(e){console.error('Tools tab render failed',e);}} if(activeTab==='analyze'){try{globalThis.SCM_ANALYZE_UI?.render(s,analyzeContext(s));}catch(e){console.error('Analyze tab render failed',e);}} if(activeTab==='contracts') { populateContractProducts(s); renderContracts(s); } if(activeTab==='settings'){ renderDiagnostics(s); }
  requestAnimationFrame(()=>{ if(Math.abs(window.scrollX-__scrollX)>0 || Math.abs(window.scrollY-__scrollY)>0) window.scrollTo(__scrollX,__scrollY); });
}
function deepCompanyName(v, seen=new Set()){
  if(v==null)return null;
  if(typeof v==='string')return v.trim()||null;
  if(typeof v==='number')return null;
  if(typeof v!=='object'||seen.has(v))return null;
  seen.add(v);
  for(const k of ['companyName','company','name','displayName','title','username']){
    const x=v[k]; if(typeof x==='string'&&x.trim())return x.trim();
  }
  for(const k of ['companyInfo','buyer','seller','counterparty','partner','from','to','player','owner','customer']){
    const x=deepCompanyName(v[k],seen); if(x)return x;
  }
  return null;
}
function contractArraysFromState(s){
  const ep=s.endpointData||{};
  const realm=Number(s.authData?.authCompany?.realmId);
  const companyId=Number(s.authData?.authCompany?.companyId||s.authData?.authCompany?.id);

  const contractRecordMatchesRealm=(record,direction)=>{
    if(!record||typeof record!=='object'||!Number.isFinite(realm)) return true;
    const partyKeys=direction==='Incoming'?['seller','sender','from','counterparty','companyInfo','company']:['buyer','receiver','to','counterparty','companyInfo','company'];
    let foundRealm=null;
    const seen=new Set();
    const walk=v=>{
      if(foundRealm!=null||v==null||typeof v!=='object'||seen.has(v)) return;
      seen.add(v);
      if(v.realmId!=null&&Number.isFinite(Number(v.realmId))){ foundRealm=Number(v.realmId); return; }
      for(const k of partyKeys){ if(v[k]!=null) walk(v[k]); }
    };
    for(const k of partyKeys){ if(record[k]!=null) walk(record[k]); if(foundRealm!=null) break; }
    return foundRealm==null || foundRealm===realm;
  };

  const belongsToCurrentContext=(url)=>{
    const text=String(url||'');
    const incoming=text.match(/\/api\/v3\/contracts-incoming\/(\d+)\/me(?:\/|\?|$)/i);
    // Incoming contracts are cross-realm: the numeric segment in the endpoint
    // identifies the realm whose incoming list is being requested. The game can
    // request both /incoming/0/me and /incoming/1/me while the page itself is
    // in only one realm, so captureRealm alone is not sufficient here. Prefer
    // the endpoint whose realm segment matches the selected company realm.
    if(incoming && Number.isFinite(realm)){
      return Number(incoming[1])===realm;
    }
    const summary=text.match(/\/api\/v2\/warehouse-contracts-summary\/(\d+)\/o(?:\/|$)/i);
    if(summary && Number.isFinite(companyId) && Number(summary[1])!==companyId) return false;
    return true;
  };

  const findAll=(rx)=>Object.keys(ep)
    .filter(k=>belongsToCurrentContext(k)&&rx.test(k))
    .sort((a,b)=>new Date(ep[b]?.receivedAt||0)-new Date(ep[a]?.receivedAt||0))
    .map(k=>ep[k]?.data).filter(Boolean);

  // Current contracts in current game builds. The /200 suffix is the page size.
  const incomingCurrent=findAll(/\/api\/v3\/contracts-incoming\/\d+\/me(?:\/\d+)?\/?(?:\?.*)?$/i);
  const outgoingCurrent=findAll(/\/api\/v3\/contracts-outgoing\/me(?:\/\d+)?\/?(?:\?.*)?$/i);
  const outgoingWarehouseSummary=findAll(/\/api\/v2\/warehouse-contracts-summary\/\d+\/o(?:\/\d+)?\/?(?:\?.*)?$/i);

  const incomingFallback=findAll(/\/api\/v2\/contracts-history-incoming\/?(?:\?.*)?$/i);
  const outgoingFallback=findAll(/\/api\/v2\/contracts-history-outgoing\/?(?:\?.*)?$/i);

  const isContractRecord=(x)=>{
    if(!x||typeof x!=='object'||Array.isArray(x))return false;
    const hasId=['id','contractId','uuid'].some(k=>x[k]!=null);
    const hasQty=['quantity','amount','units','qty','resourceAmount','count'].some(k=>x[k]!=null);
    const hasPrice=['price','unitPrice','pricePerUnit','price_per_unit','pricePerItem','total','totalPrice','contractValue','value'].some(k=>x[k]!=null);
    const hasParty=['company','companyInfo','counterparty','buyer','seller','partner','from','to'].some(k=>x[k]!=null);
    const hasResource=['resource','resourceInfo','resourceData','product','productInfo','resourceId','productId','kind'].some(k=>x[k]!=null);
    return (hasId && (hasPrice||hasQty||hasParty||hasResource)) || (hasQty&&hasPrice) || (hasParty&&hasResource&&hasPrice);
  };
  const extract=(data)=>{
    if(Array.isArray(data))return data;
    if(!data||typeof data!=='object')return [];
    const preferred=['contracts','contractOffers','outgoingContracts','incomingContracts','currentContracts','activeContracts','items','results','incoming','outgoing','data'];
    for(const k of preferred){
      if(Array.isArray(data[k])){
        // An API response can expose an empty preferred list plus the actual
        // contracts in another nested field. Only stop early when the list
        // contains records.
        if(data[k].length)return data[k];
      }
      if(data[k]&&typeof data[k]==='object'){
        const nested=extract(data[k]);
        if(nested.length)return nested;
      }
    }
    const out=[]; const seen=new Set();
    const walk=v=>{
      if(Array.isArray(v)){
        for(const x of v){
          if(isContractRecord(x)){
            const key=x.id??x.contractId??x.uuid??JSON.stringify(x);
            if(!seen.has(String(key))){seen.add(String(key));out.push(x);}
          }
        }
        for(const x of v) if(x&&typeof x==='object'&&!isContractRecord(x)) walk(x);
        return;
      }
      if(v&&typeof v==='object') for(const x of Object.values(v)) walk(x);
    };
    walk(data); return out;
  };
  const dedupe=(list,direction)=>{
    const out=[]; const seen=new Set();
    for(const c of list.flatMap(extract)){
      if(!contractRecordMatchesRealm(c,direction)) continue;
      const id=pick(c,['id','contractId','uuid']);
      const key=id!=null?`id:${id}`:JSON.stringify(c);
      if(seen.has(key))continue; seen.add(key); out.push(c);
    }
    return out;
  };

  const events=Array.isArray(s.contractEvents)?s.contractEvents.filter(x=>x?.data&&belongsToCurrentContext(x.url)):[];
  const incomingEvents=events.filter(x=>/contracts-incoming/i.test(String(x.url||''))).map(x=>x.data);
  const outgoingEvents=events.filter(x=>/contracts-outgoing/i.test(String(x.url||''))).map(x=>x.data);

  const outgoingSource=outgoingCurrent.length
    ? outgoingCurrent
    : (outgoingWarehouseSummary.length ? outgoingWarehouseSummary : outgoingFallback);

  return {
    incoming:dedupe([...(incomingCurrent.length?incomingCurrent:incomingFallback),...incomingEvents],'Incoming'),
    outgoing:dedupe([...outgoingSource,...outgoingEvents],'Outgoing')
  };
}

function deepContractField(root,keys,maxDepth=6){
  const wanted=new Set(keys.map(String)); const seen=new Set();
  const walk=(v,depth)=>{
    if(v==null||depth>maxDepth)return null;
    if(typeof v!=='object')return null;
    if(seen.has(v))return null; seen.add(v);
    for(const k of Object.keys(v)){ if(wanted.has(k) && v[k]!=null && v[k]!=='' ) return v[k]; }
    for(const k of Object.keys(v)){ const x=walk(v[k],depth+1); if(x!=null)return x; }
    return null;
  };
  return walk(root,0);
}
function contractNumber(root,keys){
  const v=deepContractField(root,keys);
  if(v==null||v==='')return null;
  const n=typeof v==='number'?v:Number(String(v).replace(/[$,]/g,''));
  return Number.isFinite(n)?n:null;
}
function contractResourceId(root){
  const direct=deepContractField(root,['resourceId','productId','resource_id','resourceKind','dbLetter']);
  if(direct!=null && Number.isFinite(Number(direct)))return Number(direct);
  const kind=deepContractField(root,['kind']);
  return kind!=null && Number.isFinite(Number(kind))?Number(kind):null;
}
function normalizeContract(c,direction,s){
  const resourceObj=pick(c,['resourceInfo','resourceData','productInfo','resource','product','item']);
  const id=contractResourceId(c) ?? (typeof resourceObj==='object'?contractResourceId(resourceObj):null);
  const product=deepContractField(c,['productName','resourceName','resource_name','productNameText','displayName','resourceDisplayName']) || (typeof resourceObj==='object'?deepContractField(resourceObj,['name','displayName','resourceName','productName']):null) || (id!=null?resourceName({kind:id},s):'—');
  const company=deepCompanyName(c)||deepCompanyName(c?.counterparty)||deepCompanyName(c?.companyInfo)||'—';
  const quantity=contractNumber(c,['quantity','amount','units','qty','resourceAmount','count']);
  const quality=contractNumber(c,['quality','q','resourceQuality']);
  const price=contractNumber(c,['price','unitPrice','pricePerUnit','unit_price','pricePerItem']);
  const totalRaw=deepContractField(c,['total','totalPrice','amountTotal','contractValue','money','totalValue']);
  const totalN=totalRaw!=null?contractNumber({x:totalRaw},['x']):null;
  const total=totalN!=null?totalN:(price!=null&&quantity!=null?price*quantity:0);
  const discount=contractNumber(c,['discount','discountPercent','discountPercentage']);
  // Contract comparison uses the shared market price (market-core, exact quality; VWAP only when no
  // current price is captured). Never a neighbouring quality or a stale contract quote.
  const mwap=Number.isFinite(Number(id))&&Number.isFinite(Number(quality))
    ? contractMarketPrice({productId:id,quality},s) : null;
  return {direction,company,product,productId:id,quantity:quantity??0,quality:quality!=null?quality:'—',mwap,discount:discount,price:price,total};
}
function currentContracts(s){
  const a=contractArraysFromState(s);
  // Keep one row per actual current contract. Combining equal contracts can
  // make quantity and totals look wrong and hides which contract is which.
  return [
    ...a.outgoing.map(c=>normalizeContract(c,'Outgoing',s)),
    ...a.incoming.map(c=>normalizeContract(c,'Incoming',s))
  ];
}
function savedContractQuantityMode(c){
  const mode=String(c?.quantityMode||'custom').trim().toLowerCase();
  return mode==='surplus'||mode==='left'||mode==='custom'?mode:'custom';
}
function savedContractProductKey(c){
  const parsed=String(c?.product??'').trim().match(/^(\d+)(?::(\d+))?$/);
  const id=Number(c?.productId!=null?c.productId:(parsed?parsed[1]:NaN));
  const quality=Number(c?.quality!=null?c.quality:(parsed?parsed[2]:0));
  return Number.isFinite(id)?{id,quality:Number.isFinite(quality)?quality:0}:null;
}
// Saved contracts, the Contracts page and the overlay share planner-core.js: the production network of the owned buildings
// (game figures only) and stockAfterDemand. Recomputed when the state, the planner data or the minute changes.
let __savedContractModel=null;
function savedContractStockModel(s,data){
  const core=globalThis.SCMPlannerCore,d=data||window.__scmBuildingPlannerData||null;
  const contracts=savedContracts(s),minute=Math.floor(Date.now()/60000);
  const keyOf=[s,s?.warehouseResources,s?.buildings,s?.endpointData,s?.productionPlans,s?.productionRunHours,s?.gameConstants,contracts,d,minute];
  const m=__savedContractModel;
  if(m&&m.key.length===keyOf.length&&m.key.every((v,i)=>v===keyOf[i]))return m;
  const runHours=Math.min(48,Math.max(1,Number(s?.productionRunHours)||24));
  const raws=buildingArrayFromState(s);
  let net=null;
  if(core&&d&&Array.isArray(d.recipes)&&d.recipes.length&&raws.length){
    net=plannerProductionNetwork(s,raws.map(raw=>({raw})),d.recipes,d.rates||{},runHours,{});
  }
  const warehouse=warehouseRows(s).map(r=>({id:r._id,quality:r._quality,qty:warehouseQuantity(r)}));
  const sd=core.stockAfterDemand({warehouse,productionRows:net?.productionRows||[],demandRows:net?.demandRows||[],savedContracts:contracts,upgradingKeys:net?.upgradingKeys});
  __savedContractModel={key:keyOf,net,sd,runHours};
  return __savedContractModel;
}
function savedContractSurplusMap(s){return savedContractStockModel(s).sd.surplusByKey;}
function savedContractProductionSurplusQuantity(c,s){
  const key=savedContractProductKey(c);if(!key)return 0;
  const value=Number(savedContractSurplusMap(s).get(`${key.id}:${key.quality}`));
  return Number.isFinite(value)?Math.max(0,value):0;
}
function savedContracts(s){
  if(Array.isArray(s?.savedContracts))return s.savedContracts;
  const realm=Number(s?.viewRealm??s?.selectedRealm??s?.captureRealm??s?.authData?.authCompany?.realmId);
  const store=Number.isFinite(realm)?s?.realmStores?.[`realm:${realm}`]:null;
  return Array.isArray(store?.savedContracts)?store.savedContracts:[];
}
function savedContractBaseBalanceMap(s){return savedContractStockModel(s).sd.baseBalanceByKey;}
function savedContractResolvedQuantityMap(s){return savedContractStockModel(s).sd.savedQuantities;}
function savedContractEffectiveQuantity(c,s){
  const quantities=savedContractResolvedQuantityMap(s);
  if(quantities.has(c))return Math.max(0,Number(quantities.get(c))||0);
  const mode=savedContractQuantityMode(c);
  if(mode==='surplus')return savedContractProductionSurplusQuantity(c,s);
  if(mode==='left')return 0;
  const q=Number(c?.quantity);
  return Number.isFinite(q)&&q>0?q:0;
}
function savedContractQuantityLabel(c,s){
  const mode=savedContractQuantityMode(c);
  const q=savedContractEffectiveQuantity(c,s);
  if(mode==='surplus')return `Surplus (${num(q)})`;
  if(mode==='left')return `Left (${num(q)})`;
  return num(q);
}
async function saveRealmField(field,value,s){
  const raw=await chrome.storage.local.get({activeRealmKey:null});
  const active=raw.activeRealmKey&&String(raw.activeRealmKey).match(/^realm:(\d+)$/)?.[1];
  const realm=active!=null?Number(active):null;
  if(realm==null)return false;
  try{
    const result=await chrome.runtime.sendMessage({type:'SAVE_REALM_FIELD',realm,field,value});
    return result?.ok===true;
  }catch{return false;}
}
// Shared price record for a contract's product (market-core, exact quality); contractMarketPrice keeps the numeric callers.
function contractMarketInfo(c,s){
  const parsed=String(c?.product??'').trim().match(/^(\d+)(?::(\d+))?$/);
  const id=Number(c?.productId!=null?c.productId:(parsed?parsed[1]:NaN));
  const quality=Number(c?.quality!=null?c.quality:(parsed?parsed[2]??0:NaN));
  if(!Number.isFinite(id)||id<=0||!Number.isFinite(quality))return null;
  return scmMarketPrice(s,id,quality,'exact');
}
function contractMarketPrice(c,s){return contractMarketInfo(c,s)?.price??null;}
// "VWAP" when the price is the VWAP fallback, "old" when stale; empty for a fresh current price.
function contractPriceNote(info){return scmSrcLabel(info);}
function setContractMwapNote(text){const el=$('#contractMwapNote');if(el)el.textContent=text||'';}
function savedContractPrice(c,s){const core=globalThis.SCMPlannerCore;return core?.savedContractCurrentPrice?core.savedContractCurrentPrice(c,contractMarketPrice(c,s)):c?.price;}
function contractMarketDiscount(c,s){const price=Number(c?.price),marketPrice=contractMarketPrice(c,s);if(!Number.isFinite(price)||!Number.isFinite(marketPrice)||marketPrice<=0)return null;return (price-marketPrice)/marketPrice*100;}
function contractDiscountHtml(c,s,saved){
  const customOff=saved&&globalThis.SCMPlannerCore?.savedContractIsCustomPrice?.(c)?contractMarketDiscount(c,s):null;
  const value=saved?(customOff!=null?-customOff:Number(c?.discount)):contractMarketDiscount(c,s);
  if(!Number.isFinite(value))return '—';
  let cls='';
  if(!saved && String(c?.direction)==='Incoming'){
    cls=value<0?'contract-discount-good':value>0?'contract-discount-bad':'';
  }
  const sign=!saved&&value>0?'+':'';
  return `<span class="${cls}">${sign}${value.toFixed(2)}%</span>`;
}
function contractRow(c,s, saved=false, includeDirection=true){const effectiveQty=saved?savedContractEffectiveQuantity(c,s):Number(c.quantity)||0;const qtyText=saved?savedContractQuantityLabel(c,s):num(c.quantity);const qtyLabel=c.count>1?`${qtyText} (${num(c.count)} contracts)`:qtyText;const displayPrice=saved?savedContractPrice(c,s):c.price;const rowTotal=saved?roundCurrencyUp((Number(displayPrice)||0)*effectiveQty):(Number(c.total)||0);const productParts=String(c.product||'').match(/^(\d+)(?::(\d+))?$/);const pid=Number.isFinite(Number(c.productId))?Number(c.productId):(productParts?Number(productParts[1]):null);const pq=Number.isFinite(Number(c.quality))?Number(c.quality):(productParts?Number(productParts[2]):null);const info=pid!=null?resourceInfo({kind:pid,quality:pq},s||{}):{imageCandidates:[]};const src=(info.imageCandidates||[])[0]||'';const image=scmSafeImgSrc(src)?`<img class="contract-product-icon" src="${escapeHtml(scmSafeImgSrc(src))}" alt="" loading="lazy">`:'';const productLabel=saved&&pid!=null?resourceName({kind:pid,quality:pq},s||{}):(c.productName||c.product||'—');return `<tr>${includeDirection?`<td>${escapeHtml(c.direction||'—')}</td>`:''}<td>${escapeHtml(c.company||'—')}</td><td class="contract-product-cell">${image}<span>${escapeHtml(productLabel)}</span></td><td>${escapeHtml(qtyLabel)}</td><td>${escapeHtml(c.quality??'—')}</td><td>${(()=>{const mi=contractMarketInfo(c,s);if(mi==null)return '—';const nt=contractPriceNote(mi);return `${money(mi.price)}${nt?` <small class="market-inline-vwap">${escapeHtml(nt)}</small>`:''}`;})()}</td><td>${contractDiscountHtml(c,s,saved)}</td><td>${contractPriceMoney(displayPrice)}</td><td>${money(rowTotal)}</td>${saved?`<td><button class="saved-edit" data-id="${escapeHtml(c.id||'')}">Edit</button> <button class="danger saved-delete" data-id="${escapeHtml(c.id||'')}">Delete</button></td>`:''}</tr>`}
function contractSurplusAfterOutgoing(s,data){
  // Contracts are displayed as signed net inventory impact: outgoing (+) uses stock; incoming (-) adds stock.
  const model=savedContractStockModel(s,data);
  const recipes=Array.isArray(data?.recipes)?data.recipes:[];
  const rows=model.sd.idRows.map(r=>{
    const info=resourceInfo({kind:r.id},s||{});
    return {...r,name:info.name||plannerResourceNameById(recipes,r.id,s)};
  });
  return {runHours:model.runHours,rows:rows.filter(r=>Math.abs(r.leftover)>1e-9||Math.abs(r.incoming)>1e-9||r.warehouse>1e-9||r.produced>1e-9||r.demand>1e-9||Math.abs(r.contracted)>1e-9)};
}

let contractSurplusRenderKey='';
let contractSurplusRenderToken=0;
async function renderContractSurplusAfterOutgoing(s,force=false){
  const cacheKey=JSON.stringify({
    realm:Number(s?.viewRealm),
    hours:Number(s?.productionRunHours)||24,
    warehouseAt:s?.warehouseCapture?.receivedAt||null,
    vwapAt:s?.vwapData?.fetchedAt||null,
    lastSync:s?.lastSync||null,
    saved:savedContracts(s).map(c=>[c?.id,c?.quantity,c?.quantityMode,c?.price,c?.product,c?.quality,c?.direction,c?.savedAt]),
    overlayRows:Array.isArray(s?.gameOverlaySnapshot?.rows)?s.gameOverlaySnapshot.rows.map(r=>[r?.id,r?.quality,r?.warehouse,r?.demand]):[]
  });
  const bodyExisting=$('#contractSurplusRows');
  const body=$('#contractSurplusRows');
  const hoursEl=$('#contractSurplusHours');
  if(!body)return;
  if(!force&&contractSurplusRenderKey===cacheKey&&bodyExisting?.dataset?.ready==='1')return;
  contractSurplusRenderKey=cacheKey;
  const renderToken=++contractSurplusRenderToken;
  if(hoursEl)hoursEl.textContent=`${Math.min(48,Math.max(1,Number(s?.productionRunHours)||24))} hr`;
  body.innerHTML='<tr><td colspan="5">Calculating surplus…</td></tr>';
  try{
    const data=await loadBuildingPlannerData();
    if(renderToken!==contractSurplusRenderToken)return;
    if(!buildingArrayFromState(s).length||!Array.isArray(data.recipes)||!data.recipes.length){
      body.innerHTML='<tr><td colspan="5">Production data is not available yet.</td></tr>';
      body.dataset.ready='1';
      return;
    }
    const result=contractSurplusAfterOutgoing(s,data);
    if(hoursEl)hoursEl.textContent=`${result.runHours} hr`;
    if(!result.rows.length){
      body.innerHTML='<tr><td colspan="5">No surplus or demand to account for.</td></tr>';
      body.dataset.ready='1';
      return;
    }
    body.innerHTML=result.rows.map(r=>{const warehouseLeft=Number(r.warehouse||0)-Number(r.demand||0)-Number(r.contracted||0);return `<tr><td class="contract-product-cell"><span>${escapeHtml(r.name||'—')}</span></td><td>${num(r.warehouse)}</td><td>${num(r.demand)}</td><td>${num(r.contracted)}</td><td class="${warehouseLeft<0?'contract-surplus-negative':''}">${num(warehouseLeft)}</td></tr>`;}).join('');
    body.dataset.ready='1';
  }catch(e){
    if(renderToken===contractSurplusRenderToken){body.innerHTML=`<tr><td colspan="5">Unable to calculate surplus: ${escapeHtml(e?.message||String(e))}</td></tr>`;body.dataset.ready='1';}
  }
}
// Current government orders (/api/v3/government-orders/<realm>/) with the amount at your tier
// (/government-orders/tier/: game = ceil(amountBase × resourceMultiplicator)) and your stock at that quality or better.
function renderGovernmentOrders(s){
  const sec=document.getElementById('contracts');if(!sec)return;
  let box=document.getElementById('govOrders');
  const realm=validRealmNumber(s?.viewRealm??s?.captureRealm),ep=s?.endpointData||{};
  const orders=realm!=null?ep[`/api/v3/government-orders/${realm}/`]?.data?.governmentOrders:null;
  const mult=Number(ep['/api/v3/government-orders/tier/']?.data?.tier?.resourceMultiplicator);
  const simco=scmSimcoData(s,'simcoGovOrders');
  const merged=globalThis.SCM_TOOLS_CORE?.mergeGovOrders?.(orders,mult,simco)||{source:Array.isArray(orders)&&orders.length?'game':null,rows:[]};
  if(!merged.source||!merged.rows.length){if(box)box.remove();return;}
  if(!box){box=document.createElement('div');box.id='govOrders';box.className='gov-orders';sec.appendChild(box);}
  let rows=[];try{rows=warehouseRows(s);}catch{}
  const have=(id,q)=>rows.filter(r=>Number(r?._id)===Number(id)&&Number(r?._quality)>=Number(q)).reduce((a,r)=>a+(Number(r._qty)||0),0);
  const title=k=>String(k||'').toLowerCase().replace(/_/g,' ').replace(/^./,c=>c.toUpperCase());
  const fromGame=merged.source==='game';
  const at=fromGame?Date.parse(String(ep[`/api/v3/government-orders/${realm}/`]?.receivedAt||'')):Number(simco?.at);
  const sub=fromGame?(Number.isFinite(mult)?`Amounts at your tier (×${num(+mult.toFixed(3))})`:'Base amounts (tier not captured yet)'):'Amounts need a visit to the game\u2019s Government orders page.';
  box.dataset.collapse='contracts:gov';box.innerHTML=`<h3 data-collapse-head>Government orders</h3><p class="gov-sub">${escapeHtml(sub)}${Number.isFinite(at)?` · ${plannerAge(Date.now()-at)}`:''}</p>`+merged.rows.map(o=>{
    const req=o.resources.map(r=>{
      const nm=fromGame?(resourceInfo({kind:Number(r.kind)},s).name||`#${r.kind}`):(r.name||resourceInfo({kind:Number(r.kind)},s).name||`#${r.kind}`);
      const got=have(r.kind,r.quality);
      if(r.need==null)return `<div class="gov-row"><span>${escapeHtml(nm)} Q${num(r.quality)}</span><span>${num(got)} / —</span></div>`;
      const need=r.need;
      return `<div class="gov-row"><span>${escapeHtml(nm)} Q${num(r.quality)}</span><span class="${got>=need?'gov-ok':'gov-short'}">${num(got)} / ${num(need)}</span></div>`;}).join('');
    const ttl=fromGame?title(o.title):String(o.title||'—');
    return `<div class="gov-card" data-collapse="gov:${escapeHtml(String(o.title||''))}"><div class="gov-head" data-collapse-head><strong>${escapeHtml(ttl)}</strong><span>${num(o.daysToFulfill)} days</span></div>${req}</div>`;
  }).join('');
  scmApplyCollapse(box);
}
function renderContracts(s){
  try{
  if(!window.__scmBuildingPlannerData&&!window.__scmContractsDataKick){window.__scmContractsDataKick=true;loadBuildingPlannerData().then(()=>{window.__scmContractsDataKick=false;if(window.__scmState)renderContracts(scmReactiveViewState(window.__scmState));}).catch(()=>{window.__scmContractsDataKick=false;});}
  const rows=currentContracts(s);
  const incoming=rows.filter(c=>String(c.direction)==='Incoming');
  const outgoing=rows.filter(c=>String(c.direction)==='Outgoing');
  const total=list=>roundCurrencyUp(list.reduce((sum,c)=>sum+(Number(c.total)||0),0));
  const incomingGross=total(incoming), outgoingGross=total(outgoing);
  const saved=savedContracts(s);
  const savedIncoming=saved.filter(c=>String(c.direction||'').trim().toLowerCase()==='incoming');
  const savedOutgoing=saved.filter(c=>String(c.direction||'').trim().toLowerCase()==='outgoing');
  const savedTotal=list=>roundCurrencyUp(list.reduce((sum,c)=>sum+roundCurrencyUp((Number(savedContractPrice(c,s))||0)*savedContractEffectiveQuantity(c,s)),0));
  const savedIncomingGross=savedTotal(savedIncoming), savedOutgoingGross=savedTotal(savedOutgoing);
  // Saved-contract totals are directional financial flows from the player's perspective:
  // Outgoing contracts are sales/income; Incoming contracts are purchases/expense.
  // Therefore All is net income: outgoing income minus incoming expense.
  const savedGross=savedOutgoingGross-savedIncomingGross;
  const setRows=(selector,list,colspan,message)=>{const el=$(selector);if(!el)return;const saved=selector==='#savedContractRows';el.innerHTML=list.length?list.map(c=>contractRow(c,s,saved,saved)).join(''):`<tr><td colspan="${Number(colspan)||1}">${escapeHtml(message)}</td></tr>`;};
  setRows('#incomingContractRows',incoming,8,'No incoming contracts captured yet. Sync with Sim Companies open.');
  setRows('#outgoingContractRows',outgoing,8,'No outgoing contracts captured yet. Sync with Sim Companies open.');
  setRows('#savedContractRows',saved,10,'No saved contracts yet.');
  if($('#incomingContractTotal')) $('#incomingContractTotal').textContent=money(incomingGross);
  if($('#outgoingContractTotal')) $('#outgoingContractTotal').textContent=money(outgoingGross);
  if($('#savedOutgoingContractTotal')) $('#savedOutgoingContractTotal').textContent=money(savedOutgoingGross);
  if($('#savedIncomingContractTotal')) $('#savedIncomingContractTotal').textContent=money(savedIncomingGross);
  if($('#savedContractTotal')) $('#savedContractTotal').textContent=money(savedGross);
  document.querySelectorAll('.saved-edit').forEach(b=>b.onclick=async()=>{const s2=await get();const c=savedContracts(s2).find(x=>String(x.id)===String(b.dataset.id));if(c)startContractEdit(c);});
  document.querySelectorAll('.saved-delete').forEach(b=>b.onclick=async()=>{const id=b.dataset.id;const s2=await get();const realm=Number(s2.viewRealm??s2.captureRealm);if(!Number.isFinite(realm))return;const r=await chrome.runtime.sendMessage({type:'SAVE_SAVED_CONTRACT',realm,mode:'delete',editId:String(id)});if(r?.ok)render(await get());});
  renderContractSurplusAfterOutgoing(s);
  try{renderGovernmentOrders(s);}catch(e){console.error('Government orders render failed',e);}
  }catch(error){console.error('Saved Contracts render failed',error);const table=$('#savedContractRows');if(table)table.innerHTML='<tr><td colspan="10">Unable to render saved contracts. Other Manager sections remain available.</td></tr>';}
}

function populateContractProducts(s){
  const el=$('#contractProduct'); if(!el)return;
  const current=el.value;
  const rows=warehouseRows(s); const seen=new Set(); const options=[];
  rows.forEach(r=>{const key=`${r._id}:${r._quality}`;if(seen.has(key))return;seen.add(key);const marketPrice=scmMarketPrice(s,r._id,r._quality,'exact')?.price??null;const mwap=marketPrice;options.push({key,id:r._id,quality:r._quality,mwap,note:contractPriceNote(scmMarketPrice(s,r._id,r._quality,'exact')),name:resourceName(r,s)});});
  const signature=options.map(o=>`${o.key}|${o.mwap??''}|${o.note}|${o.name}`).join('||');
  if(el.dataset.optionsSig!==signature){
    const html=['<option value="">Select warehouse product</option>',...options.map(o=>`<option value="${escapeHtml(o.key)}" data-id="${escapeHtml(o.id)}" data-quality="${escapeHtml(o.quality)}" data-mwap="${escapeHtml(o.mwap??'')}" data-mwap-note="${escapeHtml(o.note||'')}">${escapeHtml(o.name)} · Q${escapeHtml(o.quality)}</option>`)].join('');
    el.innerHTML=html;
    el.dataset.optionsSig=signature;
  }
  if(current&&[...el.options].some(o=>o.value===current))el.value=current;
  // Keep an open form on the live market; updateContractPrice leaves a custom price alone.
  const liveMwap=el.selectedOptions[0]?.dataset?.mwap;
  if(liveMwap&&$('#contractMwap')&&!$('#contractForm')?.classList.contains('hidden')){$('#contractMwap').value=liveMwap;setContractMwapNote(el.selectedOptions[0]?.dataset?.mwapNote);updateContractPrice(false);}
}
function syncContractQuantityUI(){
  const modeEl=$('#contractQuantityMode');const qtyEl=$('#contractQuantity');if(!modeEl||!qtyEl)return;
  const mode=String(modeEl.value||'');const custom=mode==='custom';qtyEl.classList.toggle('hidden',!custom);qtyEl.required=custom;qtyEl.disabled=!custom;if(!custom)qtyEl.value='';
}
function getContractQuantityMode(){return String($('#contractQuantityMode')?.value||'');}
function getContractDiscountValue(){const select=$('#contractDiscount');const raw=String(select?.value??'');if(raw==='custom'){const custom=Number($('#contractDiscountCustom')?.value);return Number.isFinite(custom)&&custom>=0&&custom<=100?custom:null;}const value=Number(raw);return Number.isFinite(value)&&value>=0&&value<=10?value:null;}
function syncContractDiscountUI(){const custom=$('#contractDiscountCustom');if(!custom)return;const isCustom=String($('#contractDiscount')?.value)==='custom';custom.classList.toggle('hidden',!isCustom);if(!isCustom)custom.value='';}
function updateContractPrice(force=false){syncContractDiscountUI();const mwap=Number($('#contractMwap')?.value), discount=getContractDiscountValue();const price=$('#contractPrice');if(!price)return;const calculated=Number.isFinite(mwap)&&mwap>0&&Number.isFinite(discount)?mwap*(1-discount/100):null;if(force||price.dataset.manual!=='1')price.value=calculated!=null?roundCurrencyUp(calculated).toFixed(2):'';}
function resetContractEditor(){const f=$('#contractForm');if(!f)return;f.reset();setContractMwapNote('');if(f.elements.price)delete f.elements.price.dataset.manual;delete f.dataset.editId;const save=f.querySelector('button[type="submit"]');if(save)save.textContent='Save Contract';const cancel=$('#cancelContractEdit');if(cancel)cancel.classList.add('hidden');$('#contractDiscount').value='';$('#contractDiscountCustom').value='';$('#contractQuantityMode').value='';$('#contractQuantity').value='';syncContractQuantityUI();syncContractDiscountUI();updateContractPrice();}
function startContractEdit(c){
  const f=$('#contractForm');if(!f)return;f.classList.remove('hidden');f.dataset.editId=String(c.id||'');
  const product=$('#contractProduct');product.value=String(c.product||'');
  const o=product.selectedOptions[0];
  $('#contractQuality').value=c.quality??o?.dataset?.quality??'';$('#contractMwap').value=o?.dataset?.mwap||(c.mwap??'');setContractMwapNote(o?.dataset?.mwap?o.dataset.mwapNote:'');const savedDiscount=Number(c.discount);if(Number.isFinite(savedDiscount)&&savedDiscount>=0&&savedDiscount<=10){$('#contractDiscount').value=String(savedDiscount);$('#contractDiscountCustom').value='';}else{const custom=Number.isFinite(savedDiscount)&&savedDiscount>=0&&savedDiscount<=100?savedDiscount:0;$('#contractDiscount').value='custom';$('#contractDiscountCustom').value=String(custom);}syncContractDiscountUI();$('#contractDirection').value=c.direction||'Outgoing';if(globalThis.SCMPlannerCore?.savedContractIsCustomPrice?.(c)){f.elements.price.value=c.price??'';f.elements.price.dataset.manual='1';}else{delete f.elements.price.dataset.manual;updateContractPrice(true);if(!f.elements.price.value)f.elements.price.value=c.price??'';}
  f.elements.company.value=c.company||'';const mode=savedContractQuantityMode(c);$('#contractQuantityMode').value=mode;$('#contractQuantity').value=mode==='custom'?(c.quantity||''):'';syncContractQuantityUI();
  const save=f.querySelector('button[type="submit"]');if(save)save.textContent='Update Contract';$('#cancelContractEdit')?.classList.remove('hidden');f.scrollIntoView({behavior:'smooth',block:'center'});
}
$('#newContract').onclick=()=>{const f=$('#contractForm');if(f.classList.contains('hidden')){resetContractEditor();f.classList.remove('hidden');}else f.classList.add('hidden');};
$('#cancelContractEdit').onclick=()=>{resetContractEditor();$('#contractForm').classList.add('hidden');};
$('#contractQuantityMode').onchange=()=>syncContractQuantityUI();
$('#contractProduct').onchange=()=>{const o=$('#contractProduct').selectedOptions[0];$('#contractQuality').value=o?.dataset?.quality||'';$('#contractMwap').value=o?.dataset?.mwap||'';setContractMwapNote(o?.dataset?.mwap?o.dataset.mwapNote:'');const price=$('#contractPrice');if(price)delete price.dataset.manual;updateContractPrice(true);};
$('#contractDiscount').onchange=()=>{syncContractDiscountUI();updateContractPrice(false);};
$('#contractDiscountCustom').oninput=()=>updateContractPrice(false);
$('#contractPrice').oninput=()=>{const price=$('#contractPrice');if(!price)return;if(String(price.value).trim()==='')delete price.dataset.manual;else price.dataset.manual='1';};
$('#contractPrice').onchange=()=>{const price=$('#contractPrice');if(price&&String(price.value).trim()==='')updateContractPrice(true);};
$('#contractForm').onsubmit=async e=>{
  e.preventDefault();
  const f=e.target;
  if(f.dataset.saving==='1')return;
  const submit=f.querySelector('button[type="submit"]');
  const previousText=submit?.textContent||'Save Contract';
  f.dataset.saving='1'; if(submit)submit.disabled=true; if(submit)submit.textContent='Saving…';
  try{
    const fd=new FormData(f); const mwap=Number(fd.get('mwap')); const discount=getContractDiscountValue(); const price=roundCurrencyUp(Number(fd.get('price'))); const quantityMode=getContractQuantityMode(); const quantity=Number(fd.get('quantity'));
    if(!Number.isFinite(mwap)||mwap<=0){alert('Select a product with available market price first.');return;}
    if(!Number.isFinite(price)||price<=0){alert('Enter a valid price per unit.');return;}
    if(!['custom','surplus','left'].includes(quantityMode)){alert('Choose a quantity mode: Custom amount, Surplus, or Left.');return;}
    if(quantityMode==='custom'&&(!Number.isFinite(quantity)||quantity<=0)){alert('Enter a valid custom quantity.');return;}
    const s=await get(); const realm=Number(s.viewRealm??s.captureRealm); if(!Number.isFinite(realm))throw new Error('No active realm.');
    const editId=f.dataset.editId?String(f.dataset.editId):'';
    const record={id:editId||crypto.randomUUID(),direction:fd.get('direction'),company:fd.get('company'),product:fd.get('product'),quantity:quantityMode==='custom'?quantity:0,quantityMode,quality:Number(fd.get('quality')),mwap,discount,price,customPrice:f.elements.price.dataset.manual==='1',total:quantityMode==='custom'?roundCurrencyUp(price*quantity):0,savedAt:new Date().toISOString()};
    const r=await chrome.runtime.sendMessage({type:'SAVE_SAVED_CONTRACT',realm,mode:'upsert',editId,contract:record});
    if(!r?.ok)throw new Error(r?.error||'Unable to save contract.');
    resetContractEditor();f.classList.add('hidden');render(await get());
  }catch(err){alert(err?.message||String(err));}
  finally{delete f.dataset.saving;if(submit){submit.disabled=false;submit.textContent=previousText;}}
};$('#sync').onclick=async()=>{
  await __realmSelectionPromise;
  const btn=$('#sync'); btn.disabled=true; btn.textContent='Syncing…'; $('#syncInfo').textContent='Sync starting — visiting game pages…';
  try{
    const selectedState=await get();
    const syncRealm=Number(selectedState?.selectedRealm);
    if(!Number.isFinite(syncRealm)||![0,1].includes(syncRealm)) throw new Error('Select R1 - Magnates or R2 - Entrepreneurs before syncing.');
    const r=await chrome.runtime.sendMessage({type:'SYNC_NOW',realm:syncRealm});
    const st=await get(); try{ render(st); }catch(renderError){ console.error('Render after sync failed',renderError); $('#syncInfo').textContent=`Sync completed, but dashboard render failed: ${renderError?.message||renderError}`; }
    if(r?.ok){
      $('#syncInfo').textContent=`${realmDisplayNumber(r.realm)} Sync complete · ${r.successful||0}/${r.total||0} game pages captured · finishing weekly sales ledger…`;
      requestAccountingWeekLedgerRefresh('sync-complete').catch(()=>{});
    }
    else { $('#syncInfo').textContent=scmSyncProblemText(r?.error,'No response from extension service worker.'); }
  }catch(e){
    $('#syncInfo').textContent=scmSyncProblemText(e?.message||String(e));
  }finally{ btn.disabled=false; btn.textContent='Sync'; }
};
let __renderTimer=null;
let __renderPendingWhileEditing=false;
let __dashboardScrollTimer=null;
let __dashboardUserScrolling=false;
window.addEventListener('scroll',()=>{
  __dashboardUserScrolling=true;
  if(__dashboardScrollTimer)clearTimeout(__dashboardScrollTimer);
  __dashboardScrollTimer=setTimeout(()=>{
    __dashboardScrollTimer=null;
    __dashboardUserScrolling=false;
    if(__renderPendingWhileEditing||__renderTimer) scheduleDashboardRender();
  },180);
},{passive:true});
// Global edit guard: a background/storage-driven render must never replace DOM the user is typing in. "Editing" means
// a focused input/select/textarea/contenteditable (a focused <select> stays focused while its native list is open),
// or any field edited within SCM_EDIT_QUIET_MS. Renders are queued and flushed once editing ends.
const SCM_EDIT_QUIET_MS=2000;
let __lastDashboardEditAt=0;
const __scmEditSelector='input,textarea,select,[contenteditable="true"]';
// A file input holds no text to protect, so choosing a file does not start the edit-quiet window that defers renders.
const __scmNoteEdit=e=>{try{if(e?.target?.matches?.(__scmEditSelector)&&e.target.type!=='file')__lastDashboardEditAt=Date.now();}catch{}};
document.addEventListener('input',__scmNoteEdit,true);
document.addEventListener('change',__scmNoteEdit,true);
document.addEventListener('keydown',__scmNoteEdit,true);
const dashboardEditorActive=()=>{
  const el=document.activeElement;
  if(el&&(el.matches?.(__scmEditSelector)||el.closest?.('#contractForm,#buildingPlanner')))return true;
  return Date.now()-__lastDashboardEditAt<SCM_EDIT_QUIET_MS;
};
let __flushRenderTimer=0;
const flushPendingDashboardRender=()=>{
  if(!__renderPendingWhileEditing)return;
  if(dashboardEditorActive()||__dashboardUserScrolling){
    // Still editing (or inside the quiet window): re-check shortly instead of dropping the queued render.
    clearTimeout(__flushRenderTimer);__flushRenderTimer=setTimeout(flushPendingDashboardRender,400);return;
  }
  __renderPendingWhileEditing=false;
  scheduleDashboardRender();
};
// Throttled: at most one full render per SCM_RENDER_MIN_GAP_MS with a trailing render, so storage bursts neither
// starve the UI nor re-render on every event. Deferred while editing or scrolling.
const SCM_RENDER_MIN_GAP_MS=2500;
let __lastDashboardRenderAt=0;
const scheduleDashboardRender=()=>{
  if(dashboardEditorActive()||__dashboardUserScrolling){__renderPendingWhileEditing=true;clearTimeout(__flushRenderTimer);__flushRenderTimer=setTimeout(flushPendingDashboardRender,400);return;}
  if(__renderTimer)return;
  const wait=Math.max(150,SCM_RENDER_MIN_GAP_MS-(Date.now()-__lastDashboardRenderAt));
  __renderTimer=setTimeout(()=>{
    __renderTimer=null;
    if(dashboardEditorActive()||__dashboardUserScrolling){__renderPendingWhileEditing=true;clearTimeout(__flushRenderTimer);__flushRenderTimer=setTimeout(flushPendingDashboardRender,400);return;}
    __lastDashboardRenderAt=Date.now();
    const cached=__scmState;
    if(cached){try{render(cached);return;}catch(e){console.error('Dashboard render failed',e);}}
    get().then(s=>{try{render(s)}catch(e){console.error('Dashboard render failed',e)}});
  },wait);
};
document.addEventListener('focusout',()=>setTimeout(flushPendingDashboardRender,80),true);

function dashboardChangeAffectsTab(changes,tab){
  const keys=new Set(Object.keys(changes||{}));
  const has=k=>keys.has(k);
  if(has('activeRealmKey')||has('selectedRealm'))return true;
  // Physical realm stores are committed as one storage key. Inspect changed
  // subfields for every tab whose UI derives values from market/VWAP data.
  // Without this, prices can be persisted successfully while Warehouse and
  // Market keep rendering the previous in-memory view until another action
  // (often opening Market) happens to trigger a render.
  // Physical realm stores (scmRealmStore:N) are reconciled by queuePhysicalRealmStateRefresh, which patches or schedules
  // the active tab itself. Do not JSON.stringify big per-field blobs on every storage event here.
  if(tab==='contracts'&&has('endpointData')){
    const rx=/\/(?:contracts-incoming\/|contracts-outgoing\/|warehouse-contracts-summary\/|contracts-history-(?:incoming|outgoing)\/)/i;
    const oldEp=changes.endpointData?.oldValue&&typeof changes.endpointData.oldValue==='object'?changes.endpointData.oldValue:{};
    const newEp=changes.endpointData?.newValue&&typeof changes.endpointData.newValue==='object'?changes.endpointData.newValue:{};
    const urls=new Set([...Object.keys(oldEp),...Object.keys(newEp)].filter(u=>rx.test(String(u))));
    for(const url of urls){if(JSON.stringify(oldEp[url]||null)!==JSON.stringify(newEp[url]||null))return true;}
    keys.delete('endpointData');
  }
  if(tab==='contracts'&&keys.size===0)return false;
  if(tab==='overview')return ['authData','companyData','warehouseResources','contracts','savedContracts','contractEvents','vwapData','history','sellingHistory','buildings','accountingLastComputed','accountingLastComputedIncome','accountingCapture','accountingSnapshots','accountingWeekLedgerStatus','accountingWeekSalesSummary','accountingWeekRevision','syncStatus','syncError','lastSync','fullSyncJob','fullSyncProgress'].some(has);
  if(tab==='warehouse')return ['warehouseResources','vwapData','vwapStatus','liveMarketData','liveMarketPriceData','history','contracts','savedContracts','contractEvents','warehouseCostDetails'].some(has);
  if(tab==='market')return ['vwapData','vwapStatus','liveMarketData','liveMarketPriceData','history','warehouseResources','warehouseCostDetails'].some(has);
  if((tab==='production'||tab==='overview')&&[...keys].some(k=>/^scmSimco(Events|Phases|Company):\d+$/.test(k)))return true;
  if(tab==='production')return ['buildings','warehouseResources','productionRateSnapshots','productionPlans','productionRunHours','vwapData','vwapStatus','liveMarketData','liveMarketPriceData'].some(has);
  if(tab==='contracts')return ['contracts','savedContracts','contractEvents','endpointData','warehouseResources','liveMarketPriceData','liveMarketProductCache'].some(has);
  if(tab==='tools')return ['warehouseResources','vwapData','liveMarketPriceData','history'].some(has);
  if(tab==='executives')return ['endpointData','buildings','scmGameConfig','scmGameConstants'].some(has);
  
  if(tab==='settings')return ['syncStatus','syncError','lastSync','fullSyncJob','fullSyncProgress','endpointData','apiEndpoints','realmQuarantine','productionRateSnapshots','productionPlans','gameOverlaySnapshot','warehouseResources','vwapData'].some(has);
  return false;
}
function scmWarehouseSignature(store){
  const rows=Array.isArray(store?.warehouseResources)?store.warehouseResources:[];
  let out=`${rows.length}|`;
  for(const r of rows){
    const unitCost=Number(r?._unitCost??r?.unitCost??r?.cost?.market);
    out+=`${warehouseId(r)},${warehouseQuality(r)},${warehouseQuantity(r)},${Number.isFinite(unitCost)?unitCost:''}|`;
  }
  const cd=store?.warehouseCostDetails;
  if(cd&&typeof cd==='object'){
    const costParts=[];
    for(const [id,list] of Object.entries(cd)){
      if(!Array.isArray(list))continue;
      for(const item of list){
        costParts.push(`${id}:${item?.quality??''}:${item?.quantity??''}:${item?.unitCost??''}:${item?.capturedAt??''}`);
      }
    }
    out+=`cd:${costParts.sort().join(',')}`;
  }else out+='cd:';
  return out;
}
// Order books (/api/v3/market/<realm>/<id>/) feed scmMarketPrice. Signature = those keys and their receivedAt only (no data walk).
function scmMarketBookSignature(store){
  const ep=store?.endpointData;if(!ep||typeof ep!=='object')return '';
  let out='';for(const k in ep){if(k.startsWith('/api/v3/market/'))out+=`${k}@${ep[k]?.receivedAt||''};`;}
  return out;
}
function scmVwapSignature(store){
  const data=store?.vwapData||{};
  const watch=store?.vwapWatch||{};
  const status=store?.vwapStatus||{};
  return [
    data.signature||'',
    data.fetchedAt||'',
    data.updatedAt||'',
    data.sourceRealm??'',
    Array.isArray(data.rows)?data.rows.length:(data.count||0),
    watch.lastCheckedAt||'',
    watch.lastChangedAt||'',
    watch.checkCount||0,
    watch.changeCount||0,
    watch.status||'',
    watch.lastError||'',
    status.updatedAt||'',
    status.vwapError||''
  ].join('|');
}
function renderVwapDiagnostics(s){
  const host=$('#marketDiagnostics');
  if(!host)return;
  const v=s?.vwapData||{};
  const rowsCount=Array.isArray(v.rows)?v.rows.length:Number(v.count)||0;
  const qs=s?.vwapStatus||{};
  const qmsg=qs.message||'Waiting for VWAP sync.';
  const qerr=qs.vwapError||'';
  const detail=v?.failures?.[0]?.error||qerr||'';
  const realmInfo=v?.realm!=null?` · SimcoTools realm ${escapeHtml(String(v.realm))}`:'';
  const vw=s?.vwapWatch||{};
  const checked=vw.lastCheckedAt?new Date(vw.lastCheckedAt).toLocaleString(): 'Not yet';
  const changed=vw.lastChangedAt?new Date(vw.lastChangedAt).toLocaleString(): 'Not observed yet';
  const watchMsg=vw.status==='changed'
    ?`New dataset detected · ${Number(vw.lastRowCount)||0} values`
    :vw.status==='error'
      ?`Watch error: ${vw.lastError||'unknown error'}`
      :vw.status==='initialized'
        ?`Baseline captured · ${Number(vw.lastRowCount)||0} values`
        :`No dataset change detected`;
  const fetched= v.fetchedAt?new Date(v.fetchedAt).toLocaleString():'Not yet';
  host.innerHTML=`<div class="diag-item"><strong>VWAP sync</strong><span>${rowsCount?`Captured ${rowsCount} product/quality VWAP values from SimcoTools.`:escapeHtml(qmsg)}</span><small>${escapeHtml(v.source||'SimcoTools')} · Fetched: ${escapeHtml(fetched)}${realmInfo}${detail?` · ${escapeHtml(detail)}`:''}</small></div><div class="diag-item"><strong>VWAP update monitor</strong><span>${escapeHtml(watchMsg)}</span><small>Last checked: ${escapeHtml(checked)} · Last change observed: ${escapeHtml(changed)} · Changes: ${Number(vw.changeCount)||0} · Checks: ${Number(vw.checkCount)||0}</small></div><div class="diag-item"><strong>Market collection</strong><span>Complete VWAP dataset is fetched from SimcoTools and stored for all resource/quality combinations.</span><small>VWAP data is isolated by realm. R1 uses only R1 VWAPs and R2 uses only R2 VWAPs. No cross-realm VWAP fallback is permitted.</small></div>`;
}
function scmBuildingsSignature(store){
  const buildings=Array.isArray(store?.buildings)?store.buildings:[];
  const sig=buildings.map(b=>{
    const busy=b?.busy||{}; const resource=busy?.resource||{};
    return [
      Number(b?.id??b?.buildingId)||0, String(b?.category||''), String(b?.kind||''), String(b?.name||''),
      Number(b?.size??b?.level??b?.buildingLevel)||0, Number(b?.pinnedResource??resource?.kind)||0,
      String(busy?.started||''), Number(busy?.duration)||0, Number(resource?.kind??resource?.resourceId)||0,
      String(resource?.name||''), Number(resource?.quality)||0, String(busy?.category||''), Boolean(busy?.expanding),
      // A new abundance capture repaints the building cards
      JSON.stringify(store?.endpointData?.[`/api/v2/companies/buildings/${Number(b?.id??b?.buildingId)||0}/abundance/`]?.data?.abundance||null),
      // Rate inputs: the current cycle's history capture
      String(store?.endpointData?.[`/api/v2/companies/buildings/${Number(b?.id??b?.buildingId)||0}/history/`]?.receivedAt||'')
    ].join(',');
  }).sort().join('|');
  // Rate inputs shared by every building: production-modifier captures and the company's production modifier
  const modifierStamps=Object.entries(store?.endpointData||{}).filter(([url])=>/\/api\/v2\/production-modifiers\/\d+\//i.test(url)).map(([url,v])=>url+'@'+String(v?.receivedAt||'')).sort().join(';');
  return sig+`#${buildings.length}#${modifierStamps}#${Number(plannerCompanyAuthData(store)?.productionModifier)||0}`;
}
function scmHistorySignature(store){
  const history=store?.history&&typeof store.history==='object'?store.history:{};
  return Object.entries(history).map(([key,rows])=>[key,Array.isArray(rows)?rows.map(x=>[x?.date??'',x?.vwap??'']):[]]).sort(([a],[b])=>a.localeCompare(b)).map(x=>JSON.stringify(x)).join('|');
}
function scmProductionSignature(store,opts){
  const parts=[];
  // Everything the shared production calculation reads: production-modifier rows, the company modifier, run histories,
  // the stored run snapshots and plans, and each building's current run.
  const ep=store?.endpointData&&typeof store.endpointData==='object'?store.endpointData:{};
  const epParts=[];
  for(const [url,e] of Object.entries(ep)){
    if(/^\/api\/v2\/production-modifiers\/\d+\/?$/.test(url)||/^\/api\/v2\/companies\/buildings\/\d+\/(?:history|abundance)\/?$/.test(url))epParts.push(`${url}:${e?.status??''}:${e?.receivedAt??''}:${Array.isArray(e?.data)?e.data.length:''}`);
  }
  parts.push('endpoints',epParts.sort().join(';'));
  const sd=f=>typeof scmSimcoData==='function'?scmSimcoData(store,f):(store?.[f]||null);
  parts.push('simco',String(sd('simcoEvents')?.at??''),String(sd('simcoPhases')?.at??''),String(sd('simcoCompany')?.at??''));
  parts.push('company',String(store?.authData?.authCompany?.productionModifier??''),String(store?.authData?.temporals?.economyState??''));
  parts.push('runs',(Array.isArray(store?.buildings)?store.buildings:[]).map(b=>`${b?.id??''}:${b?.busy?.started??''}:${b?.busy?.category??''}`).sort().join(';'));
  const snaps=store?.productionRateSnapshots&&typeof store.productionRateSnapshots==='object'?store.productionRateSnapshots:{};
  parts.push('rates',Object.values(snaps).map(x=>`${x?.buildingId??''}:${x?.resourceId??''}:${x?.product??''}:${x?.started??''}:${x?.observedRatePerHour??''}:${x?.source??''}`).sort().join(';'));
  const plans=store?.productionPlans&&typeof store.productionPlans==='object'?store.productionPlans:{};
  parts.push('plans',Object.values(plans).map(x=>`${x?.buildingId??''}:${x?.resourceId??''}:${x?.product??''}:${x?.quality??''}:${x?.plannedLevel??''}`).sort().join(';'));
  if(!opts?.ignoreHours)parts.push('hours',Number(store?.productionRunHours)||24);
  return parts.join('|');
}
function scmDiagnosticSignature(store){
  const ep=store?.endpointData&&typeof store.endpointData==='object'?store.endpointData:{};
  let maxAt=0,ok=0,total=0;
  for(const item of Object.values(ep)){
    total++; if(Number(item?.status)>=200&&Number(item?.status)<300)ok++;
    const at=Date.parse(String(item?.receivedAt||'')); if(at>maxAt)maxAt=at;
  }
  const job=store?.fullSyncJob||{}; const diag=store?.fullSyncDiagnostics||{}; const q=store?.realmQuarantine||{}; const js=store?.javascriptDiagnostic||{};
  return [
    total,ok,maxAt,job?.status||'',job?.step||'',job?.total||'',job?.updatedAt||'',
    diag?.capturedAt||'',diag?.status||'',diag?.phase||'',
    store?.gameOverlaySnapshot?.savedAt||'',
    store?.gameOverlaySnapshot?.signature||'',
    Array.isArray(store?.gameOverlaySnapshot?.rows)?store.gameOverlaySnapshot.rows.length:0,
    js?.capturedAt||'',js?.runtime?.realm??'',
    Array.isArray(q?.apiData)?q.apiData.length:0
  ].join('|');
}
function patchOverviewOperations(state){
  if(activeTab!=='overview')return;
  const card=$('#overviewCards .overview-operations-card');
  if(!card)return;
  const stats=[...card.querySelectorAll('.overview-stat-card')];
  if(stats.length<4)return;
  const rows=warehouseRows(state);
  const buildingCount=buildingArrayFromState(state).length;
  const warehouseQty=rows.reduce((sum,r)=>sum+(Number(r._qty)||0),0);
  const vwapCount=Array.isArray(state?.vwapData?.rows)?state.vwapData.rows.length:Number(state?.vwapData?.count)||0;
  const values=[buildingCount,rows.length,warehouseQty,vwapCount];
  values.forEach((value,i)=>{const el=stats[i]?.querySelector('strong');if(el)el.textContent=value?num(value):'—';});
}
function scmContractSignature(store){
  const parts=[];
  for(const k of ['contracts','savedContracts','contractEvents']){
    const v=store?.[k];
    if(Array.isArray(v)){
      const rows=v.map(x=>({
        id:x?.id??x?.contractId??x?.editId??null,
        direction:x?.direction??null,
        productId:x?.productId??x?.resourceId??null,
        product:x?.product??null,
        productName:x?.productName??null,
        quality:x?.quality??null,
        quantity:x?.quantity??x?.amount??null,
        price:x?.price??null,
        mwap:x?.mwap??null,
        discount:x?.discount??null,
        company:x?.company??x?.counterparty??x?.companyName??null,
        datetime:x?.datetime??null
      }));
      parts.push(k,v.length,JSON.stringify(rows));
    }else parts.push(k,typeof v==='object'&&v?JSON.stringify(v):String(v??''));
  }
  // Current live contracts are stored inside endpointData rather than the
  // legacy `contracts` array. Include only contract-related endpoint metadata
  // so a fresh API response can trigger a tiny table patch without scanning or
  // rebuilding the whole dashboard.
  const ep=store?.endpointData||{};
  for(const [url,item] of Object.entries(ep)){
    if(!/\/api\/(?:v2|v3)\/(?:contracts-(?:incoming|outgoing|history-(?:incoming|outgoing))|warehouse-contracts-summary\/)/i.test(String(url||'')))continue;
    const data=item?.data;
    const shape=Array.isArray(data)?`a:${data.length}`:(data&&typeof data==='object'?`o:${Object.keys(data).length}`:`${typeof data}`);
    parts.push('ep',url,item?.status||'',item?.receivedAt||'',shape);
  }
  return parts.join('|');
}
function scmReactiveViewState(state){
  // The game can be actively on one realm while the Manager is viewing the
  // other. Reactive patches must therefore read the selected/view realm store,
  // not blindly use activeRealmKey. Build a shallow view object so existing UI
  // helpers see the newest selected-realm data without forcing a full render.
  const base=state||{};
  const realm=Number(base.viewRealm!=null?base.viewRealm:base.captureRealm);
  const key=Number.isFinite(realm)?`realm:${realm}`:null;
  const store=key&&base.realmStores?.[key];
  if(!store||typeof store!=='object')return base;
  return {...base,...store,viewRealm:realm,captureRealm:realm};
}
// Phone card header: warehouse stock cost per unit at the top right (same value as the
// "Warehouse Stock Cost" cell; hidden on wide screens where that column is visible).
function warehouseHeadCost(r){return r?._unitCost==null?'':`<span class="wh-head-cost" title="Warehouse stock cost per unit"><strong>${money(r._unitCost)}</strong><small>cost / unit</small></span>`;}
// Production cost history cell: newest run vs the run before it, for this product/quality.
// The change is a button that opens every stored run with a line chart.
function productionCostHistoryOf(s){const r=validRealmNumber(s?.viewRealm??s?.selectedRealm);const h=s?.productionCostHistory??(r!=null?s?.[`scmProductionCostHistory:${r}`]:null);return Array.isArray(h)?h:[];}
function pchMoney(v){const n=Number(v);return Math.abs(n)<1&&Number.isFinite(n)?'$'+n.toFixed(3):money(n);}
function productionCostHistoryCell(s,r){
  const C=globalThis.SCM_TOOLS_CORE;const sum=C?.productionCostSummary?C.productionCostSummary(productionCostHistoryOf(s),r?._id,r?._quality):null;
  if(!sum)return '<span class="muted">—</span>';
  const key=`${Number(r._id)}:${Number(r._quality)}`;
  if(!sum.last)return `<span class="pch-cell"><span>now <strong>${pchMoney(sum.current.c)}</strong></span><button type="button" class="pch-link pch-flat" data-pch="${key}">1 run</button></span>`;
  const d=sum.diff,cls=d>0.00005?'pch-up':d<-0.00005?'pch-down':'pch-flat';
  const sign=d>0.00005?'+':d<-0.00005?'−':'±';
  return `<span class="pch-cell"><span>last ${pchMoney(sum.last.c)} · now <strong>${pchMoney(sum.current.c)}</strong></span><button type="button" class="pch-link ${cls}" data-pch="${key}" title="Show every production run">${sign}${pchMoney(Math.abs(d))}</button></span>`;
}
function openProductionCostHistory(s,key){
  const [id,q]=String(key).split(':').map(Number);const C=globalThis.SCM_TOOLS_CORE;
  const sum=C.productionCostSummary(productionCostHistoryOf(s),id,q);if(!sum)return;
  const name=resourceName({_id:id,kind:id},s);
  const runs=sum.runs;const W=320,H=150,P={l:44,r:8,t:10,b:22};
  const xs=runs.map(e=>Date.parse(e.t)),ys=runs.map(e=>e.c);
  const x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
  const pad=(y1-y0)*0.1||Math.max(0.01,y1*0.02);const lo=y0-pad,hi=y1+pad;
  const X=t=>x1===x0?P.l+(W-P.l-P.r)/2:P.l+(t-x0)/(x1-x0)*(W-P.l-P.r),Y=v=>P.t+(hi-v)/(hi-lo)*(H-P.t-P.b);
  const pts=runs.map(e=>`${X(Date.parse(e.t)).toFixed(1)},${Y(e.c).toFixed(1)}`).join(' ');
  const fmtD=t=>new Date(t).toLocaleDateString(undefined,{month:'short',day:'numeric'});
  const svg=`<svg class="pch-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Production cost per run"><line x1="${P.l}" y1="${H-P.b}" x2="${W-P.r}" y2="${H-P.b}" class="pch-axis"/><text x="${P.l-4}" y="${Y(y1)+4}" text-anchor="end">${escapeHtml(pchMoney(y1))}</text><text x="${P.l-4}" y="${Y(y0)+4}" text-anchor="end">${escapeHtml(pchMoney(y0))}</text><text x="${P.l}" y="${H-6}">${escapeHtml(fmtD(x0))}</text><text x="${W-P.r}" y="${H-6}" text-anchor="end">${escapeHtml(fmtD(x1))}</text>${runs.length>1?`<polyline points="${pts}" class="pch-line"/>`:''}${runs.map(e=>`<circle cx="${X(Date.parse(e.t)).toFixed(1)}" cy="${Y(e.c).toFixed(1)}" r="2.6" class="pch-pt"/>`).join('')}</svg>`;
  const rows=runs.slice().reverse().map((e,i,arr)=>{const prev=arr[i+1];const d=prev?e.c-prev.c:null;const cls=d==null?'':d>0.00005?'pch-up':d<-0.00005?'pch-down':'pch-flat';return `<tr><td>${escapeHtml(new Date(e.t).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}))}<small>${escapeHtml(e.bn||('Building #'+e.b))}${e.n?` · ${num(e.n)} units`:''}</small></td><td>${pchMoney(e.c)}</td><td class="${cls}">${d==null?'—':(d>0?'+':d<0?'−':'±')+pchMoney(Math.abs(d))}</td></tr>`;}).join('');
  document.getElementById('scm-pch')?.remove();
  const o=document.createElement('div');o.id='scm-pch';o.className='scm-upgrade-projection';
  o.innerHTML=`<div class="scm-upgrade-backdrop" data-close-pch></div><section class="scm-upgrade-dialog pch-dialog" role="dialog" aria-modal="true" aria-label="Production cost history"><header class="scm-upgrade-head"><div><div class="scm-upgrade-kicker">PRODUCTION COST HISTORY</div><h3>${escapeHtml(name)} Q${q}</h3><div class="scm-upgrade-level">${runs.length} run${runs.length===1?'':'s'} · cost per unit from the game</div></div><button type="button" class="scm-upgrade-close" data-close-pch aria-label="Close">×</button></header>${svg}<div class="table-wrap"><table class="statement-table pch-table"><thead><tr><th>Run started</th><th>Cost / unit</th><th>Change</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  document.body.appendChild(o);
  o.querySelectorAll('[data-close-pch]').forEach(x=>x.addEventListener('click',()=>o.remove()));
}
document.addEventListener('click',e=>{const b=e.target?.closest?.('[data-pch]');if(!b)return;e.preventDefault();try{openProductionCostHistory(__scmState||{},b.dataset.pch);}catch(err){console.debug('production cost history',err);}});
try{scmOnStorageChanged((changes,area)=>{if(area!=='local'||!__scmState)return;const r=validRealmNumber(__scmState.viewRealm??__scmState.selectedRealm);const c=r!=null?changes[`scmProductionCostHistory:${r}`]:null;if(!c)return;__scmState.productionCostHistory=Array.isArray(c.newValue)?c.newValue:[];if(activeTab==='warehouse'){try{patchWarehouseCells(__scmState);}catch{}}});}catch{}
// Statement history (CSV import, new day statements) recomputes Analyze too.
try{scmOnStorageChanged((changes,area)=>{if(area!=='local'||!__scmState)return;const r=validRealmNumber(__scmState.viewRealm??__scmState.selectedRealm);const c=r!=null?changes[`scmStatementHistory:${r}`]:null;if(!c)return;__scmState.statementHistory=c.newValue&&typeof c.newValue==='object'?c.newValue:null;if(activeTab==='analyze'){globalThis.SCM_ANALYZE_UI?.refresh?.();scheduleDashboardRender();}});}catch{}
// A new ledger page in the archive recomputes Analyze while it is open (the archive is realm-keyed).
try{scmOnStorageChanged((changes,area)=>{if(area!=='local'||!__scmState)return;const r=validRealmNumber(__scmState.viewRealm??__scmState.selectedRealm);const c=r!=null?changes[`scmLedgerArchive:${r}`]:null;if(!c)return;__scmState.ledgerArchive=c.newValue&&typeof c.newValue==='object'?c.newValue:null;if(activeTab==='analyze'){globalThis.SCM_ANALYZE_UI?.refresh?.();scheduleDashboardRender();}});}catch{}
function patchWarehouseCells(state){
  renderWarehouseMarketTimestamp(state);
  const body=$('#inventoryRows'); if(!body)return;
  const rows=warehouseRows(state);
  const existing=new Map([...body.querySelectorAll('tr[data-warehouse-key]')].map(tr=>[tr.dataset.warehouseKey,tr]));
  const wanted=[];
  for(const r of rows){
    const key=`${Number(r._id)}:${Number(r._quality)}`;
    const priceInfo=scmMarketPrice(state,r._id,r._quality,'exact');const currentMarketPrice=priceInfo?.price??null;const margin=currentMarketPrice!=null&&r._unitCost>0?(currentMarketPrice-r._unitCost)/r._unitCost*100:null;
    const ri=resourceInfo(r,state); const imgs=ri.imageCandidates||[];
    const localImage=state.resourceImageCache?.[String(r._id)]||state.resourceImageData?.[String(r._id)]||null;
    if(!localImage) requestResourceImage(r._id);
    const srcs=scmImgSrcs(r._id,localImage?[localImage,...imgs]:imgs);
    const img=srcs.length?`<img class="resource-icon" src="${escapeHtml(scmSafeImgSrc(srcs[0]))}" data-candidates="${escapeHtml(scmCandidatesJson(srcs))}" data-idx="0" data-rid="${Number(r._id)||0}" alt="" loading="lazy" data-scm-fallback="1">`:'';
    let tr=existing.get(key);
    const activeCost=activeProductionCostCells(state,r);const html=[`<td><div class="product-cell">${img}<span><strong>${escapeHtml(resourceName(r,state))}</strong><small>#${escapeHtml(r._id)}</small></span></div>${warehouseHeadCost(r)}</td>`, `<td data-cell="qty">${num(r._qty)}</td>`, `<td data-cell="quality">${escapeHtml(r._quality??'—')}</td>`, `<td data-cell="cost">${r._unitCost==null?'—':money(r._unitCost)}</td>`, `<td data-cell="active-production-cost">${activeCost.costHtml}</td>`, `<td data-cell="production-stock-diff">${activeCost.diffHtml}</td>`, `<td data-cell="prod-cost-history">${productionCostHistoryCell(state,r)}</td>`, `<td data-cell="vwap"><span class="cell-stack">${currentMarketPrice==null?'—':money(currentMarketPrice)}<small class="market-source">${escapeHtml(scmMarketSourceText(priceInfo))}</small></span></td>`, `<td data-cell="margin" class="${margin==null?'':margin>=0?'positive':'negative'}">${margin==null?'—':margin.toFixed(1)+'%'}</td>`];
    if(!tr){tr=document.createElement('tr');tr.dataset.warehouseKey=key;tr.innerHTML=html.join('');}
    else {
      const cells=tr.children;
      for(let i=0;i<html.length;i++) if(cells[i] && cells[i].outerHTML!==html[i]) cells[i].outerHTML=html[i];
    }
    wanted.push(tr); existing.delete(key);
  }
  for(const tr of existing.values()) tr.remove();
  const frag=document.createDocumentFragment(); wanted.forEach(tr=>frag.appendChild(tr)); body.appendChild(frag);
  if(!rows.length) body.innerHTML='<tr><td colspan="9">No warehouse data captured.</td></tr>';
}
function patchOverviewGrossResources(state){
  if(activeTab!=='overview')return;
  const grossSection=$('#overviewTopGross');
  const netSection=$('.overview-top-selling:not(#overviewTopGross)');
  if(!grossSection&&!netSection)return;
  const realm=Number(state?.viewRealm!=null?state.viewRealm:state?.captureRealm);
  const viewStore=Number.isFinite(realm)?state?.realmStores?.[`realm:${realm}`]:null;
  const a=accounting(state,viewStore);
  const snap=updateAccountingSnapshot(state,a);
  const rollover=(a?.source?.cf?.isComputed===false || a?.source?.income?.isComputed===false) && Number(a?.revenue)===0 && Number(a?.profit)===0;
  const base=rollover&&snap?.current?{...a,revenue:snap.current.revenue??a.revenue,expenses:snap.current.expenses??a.expenses,profit:snap.current.profit??a.profit,period:snap.period||a.period}:a;
  const topSelling=topSellingResourcesByProfit(base,state);
  const topGross=topGrossResources(base,state);
  const dateLabel=v=>{const d=v!=null?new Date(v):null;return d&&Number.isFinite(d.getTime())?d.toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}):null;};
  const range=(item)=>dateLabel(item.rangeStart)&&dateLabel(item.rangeEnd)?`${dateLabel(item.rangeStart)} – ${dateLabel(item.rangeEnd)}`:'Captured range unavailable';
  if(netSection){
    const head=netSection.querySelector('.overview-section-head span:first-of-type');
    if(head)head.textContent=`Captured selling profit · ${range(topSelling)}`;
    const list=netSection.querySelector('.overview-selling-list');
    if(list)list.innerHTML=topSelling.loading?'<div class="overview-selling-empty">Loading weekly sales ledger…</div>':topSelling.items.length?topSelling.items.map(x=>{const srcs=scmImgSrcs(x.resourceId,x.image?[x.image,...x.images.filter(v=>v!==x.image)]:x.images);const img=srcs.length?`<img class="overview-resource-icon" src="${escapeHtml(scmSafeImgSrc(srcs[0]))}" data-candidates="${escapeHtml(scmCandidatesJson(srcs))}" data-idx="0" data-rid="${Number(x.resourceId)||0}" alt="" loading="lazy" data-scm-fallback="1">`:'<span class="overview-resource-icon" aria-hidden="true"></span>';return `<div class="overview-selling-row"><span class="overview-rank">${x.rank}</span>${img}<span class="overview-selling-name">${escapeHtml(x.name)}</span><span class="overview-selling-quantity"><small>Qty sold</small><strong>${num(x.amount)}</strong></span><span class="overview-selling-profit"><small>Net Profit</small><strong>${money(x.profit)}</strong></span></div>`}).join(''):'<div class="overview-selling-empty">No selling profit data captured yet.</div>';
  }
  if(grossSection){
    const head=grossSection.querySelector('.overview-section-head span:first-of-type');
    if(head)head.textContent=`Captured sales value · ${range(topGross)}`;
    const list=grossSection.querySelector('.overview-selling-list');
    if(list)list.innerHTML=topGross.loading?'<div class="overview-selling-empty">Loading weekly sales ledger…</div>':topGross.items.length?topGross.items.map(x=>{const srcs=scmImgSrcs(x.resourceId,x.image?[x.image,...x.images.filter(v=>v!==x.image)]:x.images);const img=srcs.length?`<img class="overview-resource-icon" src="${escapeHtml(scmSafeImgSrc(srcs[0]))}" data-candidates="${escapeHtml(scmCandidatesJson(srcs))}" data-idx="0" data-rid="${Number(x.resourceId)||0}" alt="" loading="lazy" data-scm-fallback="1">`:'<span class="overview-resource-icon" aria-hidden="true"></span>';return `<div class="overview-selling-row"><span class="overview-rank">${x.rank}</span>${img}<span class="overview-selling-name">${escapeHtml(x.name)}</span><span class="overview-selling-quantity"><small>Qty sold</small><strong>${num(x.amount)}</strong></span><span class="overview-selling-profit"><small>Gross</small><strong>${money(x.gross)}</strong></span></div>`}).join(''):'<div class="overview-selling-empty">No gross sales data captured yet.</div>';
  }
}
function patchConstructionMaterials(state){
  const host=$('#buildingPlanner');
  const textEl=$('#constructionMaterialsText');
  const totalEl=$('#plannerConstructionTotal');
  const requirements=Array.isArray(host?.__plannerConstructionRequirements)?host.__plannerConstructionRequirements:null;
  if(!host||!textEl||!requirements)return;
  const discount=plannerDiscountPercent(host.dataset.discount);
  const updated=requirements.map(item=>{
    const warehouseQty=constructionWarehouseStock(state,item.id);
    const amount=Math.max(0,roundResourceDown(Number(item.required||0)-warehouseQty,3));
    // Prices are re-read from the shared source (market or order-book change); quantities stay as planned.
    const rawRef=scmMarketPrice(state,item.id,0,'exact'),raw=rawRef?.price??null,marketPriceSrc=scmSrcLabel(rawRef);
    const pct=plannerDiscountPercent(discount);
    const price=raw==null?null:(globalThis.SCMPlannerCore?.discountedUnitPrice?globalThis.SCMPlannerCore.discountedUnitPrice(raw,pct):roundCurrencyUp(raw*(1-pct/100)));
    const lineTotal=price!=null&&Number.isFinite(price)?roundCurrencyUp(price*amount):null;
    return {...item,warehouseQty,amount,quality:0,marketPrice:raw,marketPriceSrc,price,lineTotal};
  });
  const items=updated.filter(x=>x.amount>0);
  const total=roundCurrencyUp(items.reduce((sum,x)=>sum+(x.lineTotal!=null?Number(x.lineTotal)||0:0),0));
  const missing=constructionMissingCount(items);
  const body=items.length
    ?items.map(x=>`<div class="planner-copy-line"><span>${escapeHtml(`➡️ ${num(x.amount)} - ${x.name} :re-${Number(x.id)}: - ${x.price!=null?money(x.price):'—'}${x.price!=null&&x.marketPriceSrc?` (${x.marketPriceSrc})`:''}`)}</span></div>`).join('')
    :'<div class="planner-copy-empty">No additional construction materials required for the planned building levels.</div>';
  const copyText=items.length
    ?`==============================\n🔽🔽🔽 BUYING -${discount}% MARKET 🔽🔽🔽\n${items.map(x=>`➡️ ${num(x.amount)} - ${x.name} :re-${Number(x.id)}: - ${x.price!=null?money(x.price):'—'}${x.price!=null&&x.marketPriceSrc?` (${x.marketPriceSrc})`:''}`).join('\n')}\n==============================`
    :`==============================\n🔽🔽🔽 BUYING -${discount}% MARKET 🔽🔽🔽\nNo additional construction materials required for the planned building levels.\n==============================`;
  textEl.innerHTML=`<div class="planner-copy-heading">==============================<br>🔽🔽🔽 BUYING -${discount}% MARKET 🔽🔽🔽</div>${body}<div class="planner-copy-heading">==============================</div>`;
  textEl.dataset.copyText=copyText;
  if(totalEl)totalEl.textContent=plannerMoney(total);
  const missEl=$('#plannerConstructionMissing');if(missEl)missEl.textContent=constructionMissingText(missing);
  host.__plannerConstructionMissing=missing;
  host.__plannerConstructionItems=items;
  host.__plannerConstructionTotal=total;
}

function patchContractTables(state){
  const renderRows=(rows,direction)=>{
    const filtered=rows.filter(c=>c.direction===direction);
    return filtered.map(c=>`<tr data-contract-key="${escapeHtml(String(c.id??c.contractId??`${c.company||''}|${c.productId||c.resourceId||''}|${c.quantity||c.amount||''}|${c.price||''}`))}"><td>${escapeHtml(c.company||c.counterparty||c.companyName||'—')}</td><td>${escapeHtml(c.product||c.productName||resourceName({_id:c.productId??c.resourceId},state))}</td><td>${num(c.quantity??c.amount)}</td><td>${c.quality??'—'}</td><td>${c.mwap==null?'—':money(c.mwap)}</td><td>${c.discount==null?'—':c.discount+'%'}</td><td>${c.price==null?'—':money(c.price)}</td><td>${c.total==null?'—':money(c.total)}</td></tr>`).join('')||'<tr><td colspan="8">No contracts captured.</td></tr>';
  };
  const incoming=$('#incomingContractRows'), outgoing=$('#outgoingContractRows');
  if(incoming) incoming.innerHTML=renderRows(currentContracts(state),'Incoming');
  if(outgoing) outgoing.innerHTML=renderRows(currentContracts(state),'Outgoing');
  const rows=currentContracts(state);
  const total=(dir)=>roundCurrencyUp(rows.filter(c=>c.direction===dir).reduce((sum,c)=>sum+(Number(c.total)||0),0));
  if($('#incomingContractTotal'))$('#incomingContractTotal').textContent=money(total('Incoming'));
  if($('#outgoingContractTotal'))$('#outgoingContractTotal').textContent=money(total('Outgoing'));
}
function patchReactiveData(state, flags){
  if(flags.warehouseChanged||flags.vwapChanged||flags.liveMarketPriceDataChanged) patchWarehouseCells(state);
  if(flags.vwapChanged){
    renderVwapDiagnostics(state);
    patchOverviewOperations(state);
  }
  if(flags.accountingChanged){ patchOverviewGrossResources(state); }
  if(flags.contractsChanged||flags.vwapChanged||flags.liveMarketPriceDataChanged){
    if($('#incomingContractRows')||$('#outgoingContractRows')) patchContractTables(state);
  }
  if(flags.warehouseChanged||flags.liveMarketPriceDataChanged){
    try{patchConstructionMaterials(state);}catch(e){console.debug('Reactive construction-material patch failed',e);}
  }
  if((flags.warehouseChanged||flags.contractsChanged) && activeTab==='contracts'){
    try{renderContractSurplusAfterOutgoing(state,true);}catch(e){console.debug('Reactive surplus patch failed',e);}
  }
}
let __physicalStateRefreshTimer=null;
let __physicalStateRefreshQueued=false;
let __physicalStateRefreshPreviousState=null;
let __physicalStateRefreshPendingStores=Object.create(null);
let __physicalStateRefreshPendingDiagnostics=Object.create(null);
let __physicalStateRefreshRealmChangePending=false;
const queuePhysicalRealmStateRefresh=(previousState,changes={})=>{
  if(previousState&&!__physicalStateRefreshPreviousState)__physicalStateRefreshPreviousState=previousState;
  for(const [key,change] of Object.entries(changes||{})){
    const m=String(key).match(/^scmRealmStore:(\d+)$/);if(m){__physicalStateRefreshPendingStores[Number(m[1])]=change.newValue||{};continue;}
    const d=String(key).match(/^scmRealmDiagnostic:(\d+)$/);if(d){__physicalStateRefreshPendingDiagnostics[Number(d[1])]=change.newValue||null;}
  }
  __physicalStateRefreshQueued=true;
  if(__physicalStateRefreshTimer)return;
  __physicalStateRefreshTimer=setTimeout(async()=>{
    __physicalStateRefreshTimer=null;if(!__physicalStateRefreshQueued)return;__physicalStateRefreshQueued=false;
    const previous=__physicalStateRefreshPreviousState||__scmState;__physicalStateRefreshPreviousState=null;
    try{
      let fresh=__scmState;
      const activeRealm=Number(fresh?.viewRealm??fresh?.captureRealm??fresh?.selectedRealm);
      const activePhysical=Number.isFinite(activeRealm)?__physicalStateRefreshPendingStores[activeRealm]:undefined;
      const activeDiagnostic=Number.isFinite(activeRealm)?__physicalStateRefreshPendingDiagnostics[activeRealm]:undefined;
      if(__physicalStateRefreshRealmChangePending){
        // activeRealmKey is the view boundary. A realm switch may emit only the
        // tiny activation metadata change, with no simultaneous physical-store
        // change event. Re-read the newly active physical container instead of
        // mutating the old realm snapshot's fields to say "R2".
        fresh=await get();
      }else if(fresh&&activePhysical!==undefined){
        const viewKey=`realm:${activeRealm}`;const newStore={...(activePhysical&&typeof activePhysical==='object'?activePhysical:{})};
        if(activeDiagnostic&&typeof activeDiagnostic==='object')newStore.fullSyncDiagnostics=activeDiagnostic;
        fresh={...fresh,...newStore,realmStores:{[viewKey]:newStore},viewRealm:activeRealm,captureRealm:activeRealm};
        if(fresh.activeRealmKey==null)fresh.activeRealmKey=viewKey;
      }else if(fresh&&activeDiagnostic!==undefined&&Number.isFinite(activeRealm))fresh={...fresh,fullSyncDiagnostics:activeDiagnostic};
      else if(!fresh||!Number.isFinite(activeRealm))fresh=await get();
      __physicalStateRefreshPendingStores=Object.create(null);__physicalStateRefreshPendingDiagnostics=Object.create(null);
      __physicalStateRefreshRealmChangePending=false;
      const realm=Number(fresh?.viewRealm??fresh?.captureRealm??fresh?.selectedRealm);const viewKey=Number.isFinite(realm)?`realm:${realm}`:fresh?.activeRealmKey||null;
      const oldStore=previous?.realmStores?.[viewKey]||{};const newStore=fresh?.realmStores?.[viewKey]||{};
      const flags={buildingsChanged:scmBuildingsSignature(oldStore)!==scmBuildingsSignature(newStore),warehouseChanged:scmWarehouseSignature(oldStore)!==scmWarehouseSignature(newStore),vwapChanged:scmVwapSignature(oldStore)!==scmVwapSignature(newStore),contractsChanged:scmContractSignature(oldStore)!==scmContractSignature(newStore),accountingChanged:scmAccountingSignature(oldStore)!==scmAccountingSignature(newStore),productionChanged:scmProductionSignature(oldStore)!==scmProductionSignature(newStore),historyChanged:scmHistorySignature(oldStore)!==scmHistorySignature(newStore),diagnosticChanged:scmDiagnosticSignature(oldStore)!==scmDiagnosticSignature(newStore),liveMarketProductChanged:JSON.stringify(oldStore?.liveMarketProduct||null)!==JSON.stringify(newStore?.liveMarketProduct||null),liveMarketProductCacheChanged:JSON.stringify(oldStore?.liveMarketProductCache||{})!==JSON.stringify(newStore?.liveMarketProductCache||{}),liveMarketPriceDataChanged:JSON.stringify(oldStore?.liveMarketPriceData||null)!==JSON.stringify(newStore?.liveMarketPriceData||null)||scmMarketBookSignature(oldStore)!==scmMarketBookSignature(newStore)};
      if(!commitDashboardState(fresh))return;
      if(__realmHydrationPending){
        const hydratedStore=fresh?.realmStores?.[viewKey]||{};
        const hydrated=Boolean(hydratedStore?.lastSync||hydratedStore?.fullSyncDiagnostics||hydratedStore?.gameOverlaySnapshot||Array.isArray(hydratedStore?.warehouseResources)&&hydratedStore.warehouseResources.length||hydratedStore?.endpointData&&Object.keys(hydratedStore.endpointData).length);
        if(hydrated)__realmHydrationPending=false;
      }
      if(flags.buildingsChanged||flags.warehouseChanged||flags.vwapChanged||flags.accountingChanged){try{patchOverviewOperations(scmReactiveViewState(fresh));}catch{}}
      if(flags.warehouseChanged||flags.vwapChanged||flags.contractsChanged||flags.accountingChanged||flags.liveMarketPriceDataChanged||flags.liveMarketProductChanged||flags.liveMarketProductCacheChanged){try{patchReactiveData(scmReactiveViewState(fresh),flags);}catch{}}
      if(flags.buildingsChanged||flags.productionChanged||flags.vwapChanged||flags.liveMarketPriceDataChanged||flags.liveMarketProductChanged||flags.liveMarketProductCacheChanged){
         if(activeTab==='production'){
           // Keep reactive updates inside the Production feature. A market/warehouse
           // refresh only changes profitability values, so update that panel alone;
           // only building/production changes require refreshing the planner itself.
           // A run-hours save echoing back the value the planner already shows is not a planner input change.
           let hoursEchoOnly=false;
           try{hoursEchoOnly=flags.productionChanged&&!flags.buildingsChanged&&scmProductionSignature(oldStore,{ignoreHours:true})===scmProductionSignature(newStore,{ignoreHours:true})&&(Number(newStore?.productionRunHours)||24)===Number(plannerUiState(scmReactiveViewState(fresh))?.runHours);}catch{}
           const plannerInputsChanged=flags.buildingsChanged||(flags.productionChanged&&!hoursEchoOnly);
           if(plannerInputsChanged)renderBuildingPlanner(scmReactiveViewState(fresh),{background:true});
           else {
           }
         }else if(activeTab==='settings')scheduleDashboardRender();
       }
      if((flags.warehouseChanged||flags.vwapChanged||flags.liveMarketPriceDataChanged||flags.liveMarketProductChanged||flags.liveMarketProductCacheChanged)&&activeTab==='warehouse'){
        // Full re-render only when rows appeared/disappeared; otherwise patchWarehouseCells updates cells in place.
        const rowKeys=st=>{try{return warehouseRows(scmReactiveViewState(st)).map(r=>`${Number(r._id)}:${Number(r._quality)}`).sort().join(',');}catch{return null;}};
        const kOld=rowKeys(previous||fresh),kNew=rowKeys(fresh);
        if(kOld==null||kNew==null||kOld!==kNew)scheduleDashboardRender();
        else{try{patchWarehouseCells(scmReactiveViewState(fresh));}catch(e){console.debug('warehouse cell patch failed',e);scheduleDashboardRender();}}
      }
      if(activeTab==='executives'&&(flags.buildingsChanged||(previous?.realmStores?.[viewKey]?.endpointData!==fresh?.realmStores?.[viewKey]?.endpointData)))scheduleDashboardRender();
      if((flags.liveMarketPriceDataChanged||flags.vwapChanged||flags.warehouseChanged)&&activeTab==='tools')scheduleDashboardRender();
      if((flags.liveMarketPriceDataChanged||flags.vwapChanged||flags.warehouseChanged||flags.accountingChanged||flags.historyChanged||flags.buildingsChanged)&&activeTab==='analyze')scheduleDashboardRender();
      if((flags.contractsChanged||flags.liveMarketPriceDataChanged||flags.liveMarketProductCacheChanged)&&(activeTab==='overview'||activeTab==='contracts'))scheduleDashboardRender();if(flags.accountingChanged&&activeTab==='accounting')scheduleDashboardRender();if(flags.diagnosticChanged&&activeTab==='settings')scheduleDashboardRender();if((flags.vwapChanged||flags.warehouseChanged||flags.historyChanged||flags.liveMarketProductChanged||flags.liveMarketProductCacheChanged||flags.liveMarketPriceDataChanged)&&activeTab==='market')scheduleDashboardRender();
    }catch(e){__physicalStateRefreshPendingStores=Object.create(null);__physicalStateRefreshPendingDiagnostics=Object.create(null);console.debug('Physical realm state refresh failed',e);}
  },120);
};
chrome.runtime.onMessage.addListener((message)=>{
  if(message?.type!=='ACCOUNTING_WEEK_LEDGER_READY')return;
  const readyRealm=Number(message.realm);
  const viewRealm=Number(__scmState?.viewRealm??__scmState?.selectedRealm);
  if(!Number.isFinite(readyRealm)||readyRealm!==viewRealm)return;
  const epoch=__realmViewEpoch;
  get().then(fresh=>{
    if(epoch!==__realmViewEpoch)return;
    if(Number(fresh?.viewRealm??fresh?.selectedRealm)!==readyRealm)return;
    try{
      commitDashboardState(fresh);
      patchOverviewGrossResources(scmReactiveViewState(fresh));
      if(activeTab==='overview')scheduleDashboardRender();
    }catch(e){console.debug('Accounting ledger ready refresh failed',e);}
  }).catch(()=>{});
});
scmOnStorageChanged((changes, area)=>{
  if(area!=='local')return;
  const previousStateForPhysicalChange=__scmState?{
    ...__scmState,
    realmStores:__scmState.realmStores
  }:null;
  if(__scmState){
    for(const [key,change] of Object.entries(changes||{})){
      if(key==='realmStores'||/^scmRealmStore:\d+$/.test(key))continue;
      __scmState[key]=change.newValue;
    }
    if(changes.realmStores)__scmState.realmStores=changes.realmStores.newValue||{};
    if(changes.activeRealmKey){
      __realmViewEpoch++;
      const switchEpoch=__realmViewEpoch;
      const active=__scmState.activeRealmKey;
      const activeRealm=active?Number(String(active).replace('realm:','')):null;
      const viewKey=Number.isFinite(activeRealm)?`realm:${activeRealm}`:null;
      const targetChange=Number.isFinite(activeRealm)?changes[`scmRealmStore:${activeRealm}`]:null;
      const targetStore=targetChange?.newValue&&typeof targetChange.newValue==='object'?targetChange.newValue:{};
      const switchedState={...__scmState,activeRealmKey:active,selectedRealm:__scmState.selectedRealm,viewRealm:Number.isFinite(activeRealm)?activeRealm:null,captureRealm:Number.isFinite(activeRealm)?activeRealm:null,realmStores:viewKey?{[viewKey]:targetStore}:{}};
      // This is the one intentional state replacement across realm keys. All
      // asynchronous reads use commitDashboardState(), which refuses an older
      // realm from overwriting this newly selected realm.
      __scmState=switchedState;
      window.__scmState=switchedState;
      __realmHydrationPending=true;
      const hydrationEpoch=switchEpoch;
      setTimeout(()=>{if(hydrationEpoch!==__realmViewEpoch||!__realmHydrationPending)return;__realmHydrationPending=false;try{render(__scmState);}catch{}} ,1500);
      __physicalStateRefreshRealmChangePending=true;
      // A realm switch is an asynchronous read boundary. Clear the old realm's
      // physical view immediately, then hydrate the target realm. Any read that
      // started before this switch is rejected by the epoch/current-key guard.
      if(__realmSelectionPending==null){
        get().then(fresh=>{
          if(switchEpoch!==__realmViewEpoch)return;
          try{if(commitDashboardState(fresh)){const target=fresh?.realmStores?.[viewKey]||{};const hydrated=Boolean(target?.lastSync||target?.fullSyncDiagnostics||target?.gameOverlaySnapshot||Array.isArray(target?.warehouseResources)&&target.warehouseResources.length||target?.endpointData&&Object.keys(target.endpointData).length);if(hydrated)__realmHydrationPending=false;render(fresh);}}catch(e){console.debug('Realm-switch render failed',e);}
          requestAccountingRefresh().catch(()=>{});
          requestAccountingWeekLedgerRefresh('realm-switch').catch(()=>{});
        }).catch(()=>{});
      }
    }
  }
  if(changes.syncStatus||changes.syncError||changes.lastSync){
    const el=$('#syncInfo');
    const status=(changes.syncStatus?.newValue??__scmState?.syncStatus)||'';
    const error=(changes.syncError?.newValue??__scmState?.syncError)||'';
    if(el)el.textContent=__realmHydrationPending&&__scmState?.viewRealm!=null?`Switching to ${realmName(Number(__scmState.viewRealm))}…`:error?(scmIsBlockNotice(error)?String(error):`${status||'Error'}: ${error}`):String(status||'No sync yet');
    if(changes.syncStatus&&/Sync complete/i.test(String(status))&&__scmState){
      setTimeout(()=>{
        try{patchOverviewGrossResources(__scmState);}catch(e){console.debug('Reactive gross-resource sync patch failed',e);}
        requestAccountingWeekLedgerRefresh('sync-status-complete').catch(()=>{});
      },1200);
    }
  }
  const plannerKeys=Object.keys(changes||{}).filter(k=>/^scmProductionPlannerState:\d+$/.test(k));
  if(plannerKeys.length&&__scmState){
    for(const key of plannerKeys){const m=key.match(/^scmProductionPlannerState:(\d+)$/);if(m&&Number(m[1])===Number(__scmState.viewRealm))__scmState.productionPlannerState=changes[key].newValue??null;}
  }
  const physicalRealmKeys=Object.keys(changes||{}).filter(k=>/^scmRealmStore:\d+$/.test(k));
  if((changes.realmStores||physicalRealmKeys.length>0||Object.keys(changes||{}).some(k=>/^scmRealmDiagnostic:\d+$/.test(k)))&&__scmState)queuePhysicalRealmStateRefresh(previousStateForPhysicalChange,changes);
  // Game constants / images arrive from the worker (SCM_ENSURE_GAME_DATA, daily refresh): map them onto the view state
  // and re-render whatever tab is open, so notes like "Game constants not loaded yet" clear without a reload.
  const simcoKeys=Object.keys(changes||{}).filter(k=>k==='scmSimcoBuildings'||/^scmSimco(Prices|GovOrders|Events|Phases|Company):\d+$/.test(k));
  if(simcoKeys.length&&__scmState){for(const k of simcoKeys){const v=changes[k].newValue??null;if(k==='scmSimcoBuildings'){__scmState.simcoBuildings=v;continue;}const m=k.match(/^scmSimco(Prices|GovOrders|Events|Phases|Company):(\d+)$/);if(m&&Number(m[2])===Number(__scmState.viewRealm))__scmState['simco'+m[1]]=/^(Events|Phases|Company)$/.test(m[1])?scmSimcoAtIso(v):v;}}
  const gameDataChanged=simcoKeys.length>0||Boolean(changes.scmGameConstants||changes.scmGameConfig||changes.scmResourceImages);
  if(gameDataChanged&&__scmState){
    if(changes.scmGameConstants)__scmState.gameConstants=changes.scmGameConstants.newValue||null;
    if(changes.scmGameConfig)__scmState.gameConfig=changes.scmGameConfig.newValue||null;
    if(changes.scmResourceImages){const raw=changes.scmResourceImages.newValue,c=raw&&raw.cache&&typeof raw.cache==='object'?raw.cache:{};dashboardImagesMemo=c;__scmState.resourceImageCache={...(__scmState.resourceImageCache||{}),...c};for(const [k,v] of [...__scmImgState])if(v.s!=='ok')__scmImgState.delete(k);}
  }
  const relevant=gameDataChanged||dashboardChangeAffectsTab(changes,activeTab);
  // Physical realm-store writes are already reconciled by queuePhysicalRealmStateRefresh.
  // That path patches the active feature in place (and specifically updates the
  // Production planner only when its actual inputs changed). Scheduling render() again here would
  // replace every dashboard section after the targeted patch, causing flicker, scroll/layout churn and recipe reloads.
  const physicalTabHandled=activeTab==='production' && physicalRealmKeys.length>0 &&
    !changes.activeRealmKey && !changes.selectedRealm;
  if(relevant&&!physicalTabHandled)scheduleDashboardRender();
});
// Ask the worker once per open/resume to fill any missing game constants and images (it does nothing when nothing is missing).
function scmEnsureGameData(){try{const p=chrome.runtime.sendMessage({type:'SCM_ENSURE_GAME_DATA'});if(p&&p.catch)p.catch(()=>{});}catch{}}
scmEnsureGameData();
scmOnDashboardResume(scmEnsureGameData);
scmOnDashboardResume(async()=>{
  try{
    const meta=await chrome.storage.local.get({activeRealmKey:null});
    if(__scmState&&String(meta.activeRealmKey??'')!==String(__scmState.activeRealmKey??'')){location.reload();return;}
    const fresh=await get();if(commitDashboardState(fresh))scheduleDashboardRender();
  }catch(e){console.debug('resume refresh failed',e);}
});
// Initial load must survive an extension update. While the worker restarts (Android Chromium
// especially) chrome.storage reads can reject or never settle, which left the page showing only the static
// HTML ("Build —", "No sync yet") until manual refreshes. Header renders at once; the data load is bounded
// by a timeout and retried with backoff; once loaded, storage changes keep it live.
const SCM_INITIAL_LOAD_DELAYS=[300,1000,2000,4000,4000,4000];
function scmWithTimeout(promise,ms){return Promise.race([promise,new Promise((_,rej)=>setTimeout(()=>rej(new Error(`timed out after ${ms}ms`)),ms))]);}
function scmPaintLoadingHeader(text){try{const b=$('#managerBuild');if(b)b.textContent=`Build ${BUILD_VERSION}`;const si=$('#syncInfo');if(si&&text&&!window.__scmDashboardLoaded)si.textContent=text;}catch{}}
scmPaintLoadingHeader('Loading…');
async function scmInitialDashboardLoad(){
  for(let attempt=0;;attempt++){
    let s=null;
    try{s=await scmWithTimeout(get(),3000);}catch(e){console.warn('Dashboard initial load failed, retrying',e?.message||e);}
    if(s){
      try{render(s);window.__scmDashboardLoaded=true;}catch(e){console.error('Dashboard render failed',e);}
      if(window.__scmDashboardLoaded){
        if(s.viewRealm==null)scmPaintLoadingHeader();
        requestAccountingRefresh().catch(()=>{});requestAccountingWeekLedgerRefresh('dashboard-initial-load').catch(()=>{});
        return;
      }
    }
    if(attempt>=SCM_INITIAL_LOAD_DELAYS.length){scmPaintLoadingHeader();const si=$('#syncInfo');if(si)si.textContent='Could not load data yet — waiting for the extension to finish updating';return;}
    scmPaintLoadingHeader(attempt>=1?'Waiting for the extension to finish updating…':'Loading…');
    await new Promise(r=>setTimeout(r,SCM_INITIAL_LOAD_DELAYS[attempt]));
  }
}
scmInitialDashboardLoad();
// If the first load never succeeded, any storage write (the updated worker finishing its migration) retries it.
scmOnStorageChanged((changes,area)=>{if(area==='local'&&!window.__scmDashboardLoaded&&(changes.activeRealmKey||Object.keys(changes||{}).some(k=>/^scmRealmStore:\d+$/.test(k))))scmWithTimeout(get(),3000).then(s=>{if(!window.__scmDashboardLoaded){render(s);window.__scmDashboardLoaded=true;}}).catch(()=>{});});

// Mobile: on phone widths, tables marked .mobile-cards render as stacked cards (CSS). Each cell
// gets its column name as data-label; rows are re-labelled whenever a table body is re-rendered.
(function(){
  const label=()=>{
    for(const table of document.querySelectorAll('table.mobile-cards')){
      const heads=[...table.querySelectorAll('thead th')].map(th=>th.textContent.replace(/\s+/g,' ').trim());
      for(const tr of table.querySelectorAll('tbody tr')){
        const cells=[...tr.children];
        if(cells.length===1&&Number(cells[0].colSpan)>1){tr.classList.add('mc-full');continue;}
        cells.forEach((td,i)=>{const l=heads[i]||'';if(td.dataset.label!==l)td.dataset.label=l;});
      }
    }
  };
  let raf=0;const schedule=()=>{if(raf)return;raf=requestAnimationFrame(()=>{raf=0;if(document.documentElement.classList.contains('scm-mobile'))label();});};
  new MutationObserver(muts=>{if(muts.some(m=>m.target.closest?.('table.mobile-cards')||[...m.addedNodes].some(n=>n.nodeType===1&&(n.matches?.('table.mobile-cards')||n.querySelector?.('table.mobile-cards')))))schedule();}).observe(document.body,{childList:true,subtree:true});
  window.addEventListener('resize',schedule,{passive:true});schedule();
  // Keep the active tab visible in the one-row tab bar, and show the top of the newly opened tab.
  document.querySelector('.shell>nav')?.addEventListener('click',e=>{
    const b=e.target.closest('.tab');if(!b||!document.documentElement.classList.contains('scm-mobile'))return;
    b.scrollIntoView({inline:'center',block:'nearest'});
    const main=document.querySelector('.shell>main'),nav=document.querySelector('.shell>nav');
    if(main&&nav)requestAnimationFrame(()=>requestAnimationFrame(()=>{const top=main.getBoundingClientRect().top+window.scrollY-nav.offsetHeight-6;if(window.scrollY>top)window.scrollTo({top});}));
  });
})();


// Extension pages forbid inline event handlers (CSP script-src 'self'), so onerror="..." attributes would never run.
// One capture-phase listener does the fallback job for every image marked data-scm-fallback.
document.addEventListener('error',e=>{const t=e.target;if(!t||t.tagName!=='IMG'||!t.dataset)return;if(t.dataset.scmFallback==='1'&&typeof window.scmImageFallback==='function'){try{window.scmImageFallback(t);}catch{}}else if(t.dataset.scmHideOnError==='1'){const f=document.createElement('span');f.className=(t.className+' planner-icon-fallback').trim();f.title=t.alt||'';f.textContent=t.dataset.scmFallbackText||'•';t.replaceWith(f);}},true);

// Alerts tab: one switch per alert, thresholds and price targets.
(function(){
  const st=$('#notifyStatus');if(!st)return;
  let cfg=null;
  const when=ms=>new Date(ms).toLocaleString(undefined,{weekday:'short',hour:'numeric',minute:'2-digit'});
  const realmNow=()=>validRealmNumber(__scmState?.viewRealm??__scmState?.selectedRealm);
  const prodName=(id)=>{try{return resourceName({_id:id,kind:id},__scmState||{});}catch{return '#'+id;}};
  // Filled when tapped (state may not be loaded yet when the Alerts tab opens first); lists warehouse
  // items and products your buildings are making now.
  const fillProducts=()=>{const sel=$('#nfTProduct');if(!sel)return;const s=__scmState||{};let opts=[];try{opts=marketWarehouseOptions(s).map(o=>({key:`${o.id}:${o.quality}`,label:`${o.name} Q${o.quality} · ${num(o.qty)} in warehouse`}));}catch{}
    const have=new Set(opts.map(o=>o.key));for(const b of Array.isArray(s.buildings)?s.buildings:[]){const r=b?.busy?.resource;const id=Number(r?.kind),q=Number(r?.quality);if(id>0&&Number.isFinite(q)&&!have.has(`${id}:${q}`)){have.add(`${id}:${q}`);opts.push({key:`${id}:${q}`,label:`${r.name||prodName(id)} Q${q} · producing`});}}
    const cur=sel.value;sel.innerHTML=opts.length?'<option value="">Choose a product…</option>'+opts.map(o=>`<option value="${escapeHtml(o.key)}">${escapeHtml(o.label)}</option>`).join(''):'<option value="">Loading your warehouse… tap again</option>';if(cur&&have.has(cur))sel.value=cur;};
  ['pointerdown','focus'].forEach(ev=>$('#nfTProduct')?.addEventListener(ev,fillProducts));setTimeout(fillProducts,2500);
  const renderTargets=()=>{const host=$('#nfTargets');if(!host)return;const r=realmNow();const list=(cfg?.priceTargets||[]).map((t,i)=>({...t,i})).filter(t=>Number(t.realm??r)===r);
    host.innerHTML=list.length?list.map(t=>`<div class="notify-target"><span><strong>${escapeHtml(prodName(t.id))} Q${escapeHtml(t.q)}</strong><br><small>Alert when the price ${t.op==='>='?'rises to':'drops to'} ${money(t.price)} or ${t.op==='>='?'higher':'lower'}</small></span><button type="button" class="secondary" data-nf-del="${Number(t.i)}" aria-label="Remove target">×</button></div>`).join(''):'<div class="muted nf-empty">No targets yet. Choose a product, when to alert, and a price, then tap Add.</div>';};
  const show=r=>{
    if(!r?.ok){st.textContent='Could not read notification settings: '+(r?.error||'no answer');return;}
    cfg=r.settings;
    document.querySelectorAll('[data-nf]').forEach(el=>{el.checked=!!cfg[el.dataset.nf];});
    document.querySelectorAll('[data-nfv]').forEach(el=>{if(document.activeElement!==el)el.value=cfg[el.dataset.nfv]??'';});document.querySelectorAll('.nf-row').forEach(el=>{const sw=el.querySelector('[data-nf]');if(sw)el.classList.toggle('is-off',!sw.checked);});
    renderTargets();fillProducts();
    if(!r.available){st.textContent='This browser does not offer extension notifications.';return;}
    const list=(r.alarms||[]).sort((a,b)=>a.when-b.when).slice(0,5).map(a=>{const [,realm,bid]=a.name.split(':');const b=(__scmState?.buildings||[]).find(x=>String(x?.id)===bid);return `${a.buildingName||b?.name||'Building '+bid} (R${Number(realm)+1}) · ${when(a.when)}`;});
    const lines=[];
    if(cfg.productionFinished)lines.push(list.length?'Next: '+list.slice(0,3).map(escapeHtml).join(' · '):'No running production captured yet (open the game).');
    if(cfg.dailySummary&&r.dailyAt)lines.push('Summary: '+escapeHtml(when(r.dailyAt)));
    
    st.innerHTML=lines.join('<br>');
  };
  const load=set=>chrome.runtime.sendMessage({type:'SCM_NOTIFY_SETTINGS',set}).then(show).catch(e=>show({ok:false,error:e?.message}));
  document.querySelectorAll('[data-nf]').forEach(el=>el.addEventListener('change',()=>load({[el.dataset.nf]:el.checked})));
  document.querySelectorAll('[data-nfv]').forEach(el=>el.addEventListener('change',()=>{const k=el.dataset.nfv;if(el.type==='time'){if(/^\d{1,2}:\d{2}$/.test(el.value))load({[k]:el.value});return;}const v=Number(el.value);if(v>0)load({[k]:v});}));
  $('#nfTAdd')?.addEventListener('click',()=>{const [id,q]=String($('#nfTProduct')?.value||'').split(':').map(Number);const price=Number($('#nfTPrice')?.value);const op=$('#nfTOp')?.value==='>='?'>=':'<=';
    if(!(id>0)||!Number.isFinite(q)||!(price>0)){st.textContent='Choose a product and enter a target price above 0.';$('#nfTProduct')?.scrollIntoView({block:'center'});return;}
    const list=[...(cfg?.priceTargets||[]),{realm:realmNow(),id,q,op,price}];$('#nfTPrice').value='';load({priceTargets:list});});
  $('#nfTargets')?.addEventListener('click',e=>{const b=e.target.closest('[data-nf-del]');if(!b)return;const list=[...(cfg?.priceTargets||[])];list.splice(Number(b.dataset.nfDel),1);load({priceTargets:list});});
  $('#notifyTest')?.addEventListener('click',async e=>{const b=e.currentTarget;b.disabled=true;try{const r=await chrome.runtime.sendMessage({type:'SCM_TEST_NOTIFICATION'});st.textContent=r?.ok?'Test sent.':'Test failed: '+(r?.error||'no answer');}catch(err){st.textContent='Test failed: '+(err?.message||err);}b.disabled=false;});
  $('#notifyDailyNow')?.addEventListener('click',async e=>{const b=e.currentTarget;b.disabled=true;try{const r=await chrome.runtime.sendMessage({type:'SCM_TEST_DAILY_SUMMARY'});st.textContent=r?.ok?'Daily summary sent.':'Failed: '+(r?.error||'no answer');}catch(err){st.textContent='Failed: '+(err?.message||err);}b.disabled=false;});
  load(null);
})();


// Expandable / collapsible cards. A container marked data-collapse="<key>" collapses to its
// [data-collapse-head] child; taps on the head toggle it. Choices are kept per key in localStorage
// (scmCollapseV2). data-collapse-default="open" starts expanded; everything else starts collapsed. No inline handlers (CSP).
const SCM_COLLAPSE_KEY='scmCollapseV2';
function scmCollapseRead(){try{const v=JSON.parse(localStorage.getItem(SCM_COLLAPSE_KEY)||'{}');return v&&typeof v==='object'?v:{};}catch{return {};}}
function scmCollapseWrite(key,collapsed){try{const v=scmCollapseRead();delete v[key];v[key]=collapsed?1:0;const keys=Object.keys(v);for(const k of keys.slice(0,Math.max(0,keys.length-300)))delete v[k];localStorage.setItem(SCM_COLLAPSE_KEY,JSON.stringify(v));}catch{}}
function scmSetCollapsed(el,collapsed){el.classList.toggle('is-collapsed',!!collapsed);const h=el.querySelector(':scope>[data-collapse-head]');if(h)h.setAttribute('aria-expanded',collapsed?'false':'true');}
function scmApplyCollapse(root){
  if(!root)return;const saved=scmCollapseRead();
  const list=[...(root.matches?.('[data-collapse]')?[root]:[]),...root.querySelectorAll('[data-collapse]')];
  for(const el of list){const k=el.dataset.collapse;const h=el.querySelector(':scope>[data-collapse-head]');if(!h)continue;h.classList.add('collapse-head');h.setAttribute('role','button');h.tabIndex=0;scmSetCollapsed(el,k in saved?!!saved[k]:el.dataset.collapseDefault!=='open');}
}
// Every card in the Manager is expandable / collapsible. Cards rendered without data-collapse get it here,
// on every render (MutationObserver, runs before the next paint):
//  - label + content sections (Production page labels, Your Buildings, Alerts groups) are wrapped into one card;
//  - card containers below whose direct child is a heading: that heading becomes the tap target.
// The key is <tab>:<heading text without numbers>, so a choice survives re-renders and value changes.
const SCM_AUTO_SECTIONS=[
  {root:'#buildingPlanner',label:'.owned-buildings-heading',stop:'.planner-main-card'},
  {root:'#buildingPlanner .planner-main-card',label:'.planner-section-label',stop:'.planner-construction-card,.planner-quality-footer'},
  {root:'#notifyPanel',label:'h3.nf-group',stop:null}
];
const SCM_AUTO_CARDS=[
  ['.panel',':scope>.section-head,:scope>h3,:scope>h2,:scope>.market-chart-head'],
  ['.statement-card',':scope>h3'],
  ['.overview-section',':scope>.overview-section-head'],
  ['.planner-summary-card,.planner-text-card',':scope>.planner-summary-head']
];
function scmCollapseSlug(head){
  let txt='';for(const n of head.childNodes){if(n.nodeType===3&&n.textContent.trim()){txt=n.textContent;break;}}
  if(!txt)txt=(head.querySelector('h1,h2,h3,h4,strong,span')||head).textContent||'';
  return txt.replace(/[0-9$.,%:+−]+/g,' ').trim().toLowerCase().replace(/[^a-z]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40)||'card';
}
function scmCollapseKeyFor(el,head,used){
  const tab=el.closest('.tabpage')?.id||'page';let k=`auto:${tab}:${scmCollapseSlug(head)}`;
  if(used.has(k)){let i=2;while(used.has(`${k}-${i}`))i++;k=`${k}-${i}`;}used.add(k);return k;
}
function scmAutoCollapse(root){
  if(!root?.querySelectorAll)return;
  const used=new Set([...root.querySelectorAll('[data-collapse]')].map(e=>e.dataset.collapse));
  for(const sec of SCM_AUTO_SECTIONS){
    for(const box of root.querySelectorAll(sec.root)){
      for(const label of [...box.children].filter(k=>k.matches(sec.label))){
        if(label.hasAttribute('data-collapse-head'))continue;
        const wrap=document.createElement('div');wrap.className='scm-auto-section';
        label.before(wrap);wrap.appendChild(label);label.setAttribute('data-collapse-head','');label.classList.add('scm-auto-head');
        let n=wrap.nextElementSibling;while(n&&!n.matches(sec.label)&&!(sec.stop&&n.matches(sec.stop))){const nx=n.nextElementSibling;wrap.appendChild(n);n=nx;}
        wrap.dataset.collapse=scmCollapseKeyFor(wrap,label,used);
      }
    }
  }
  for(const [cardSel,headSel] of SCM_AUTO_CARDS){
    for(const el of root.querySelectorAll(cardSel)){
      if(el.hasAttribute('data-collapse'))continue;
      const head=el.querySelector(headSel);if(!head||el.children.length<2)continue;
      head.setAttribute('data-collapse-head','');if(/^H[1-6]$/.test(head.tagName))head.classList.add('scm-auto-head');
      el.dataset.collapse=scmCollapseKeyFor(el,head,used);
    }
  }
  const fresh=[...root.querySelectorAll('[data-collapse]')].filter(el=>{const h=el.querySelector(':scope>[data-collapse-head]');return h&&!h.classList.contains('collapse-head');});
  if(fresh.length){const saved=scmCollapseRead();for(const el of fresh){const k=el.dataset.collapse,h=el.querySelector(':scope>[data-collapse-head]');h.classList.add('collapse-head');h.setAttribute('role','button');h.tabIndex=0;scmSetCollapsed(el,k in saved?!!saved[k]:el.dataset.collapseDefault!=='open');}}
}
(function(){
  const toggle=(head,e)=>{const el=head.parentElement;if(!el?.dataset?.collapse)return;
    // buttons/fields inside a head (e.g. New Contract) work as before; a collapsed card opens so the form shows
    if(e&&e.target!==head&&e.target.closest('button,input,select,textarea,a,label')){if(el.classList.contains('is-collapsed')){scmSetCollapsed(el,false);scmCollapseWrite(el.dataset.collapse,false);}return;}
    const next=!el.classList.contains('is-collapsed');scmSetCollapsed(el,next);scmCollapseWrite(el.dataset.collapse,next);};
  document.addEventListener('click',e=>{const head=e.target.closest?.('[data-collapse-head]');if(head)toggle(head,e);});
  document.addEventListener('keydown',e=>{if(e.key!=='Enter'&&e.key!==' ')return;const head=e.target.closest?.('[data-collapse-head]');if(head&&e.target===head){e.preventDefault();toggle(head,null);}});
  scmApplyCollapse(document.getElementById('accounting'));scmApplyCollapse(document.getElementById('contracts'));
  // Debounced to one pass per frame; mutations made by scmAutoCollapse itself are ignored.
  let acRaf=0,acBusy=false;const acRun=()=>{acRaf=0;acBusy=true;try{scmAutoCollapse(document.body);}catch(e){console.error('Auto collapse failed',e);}finally{acObs?.takeRecords();acBusy=false;}};
  let acObs=null;
  try{scmAutoCollapse(document.body);acObs=new MutationObserver(()=>{if(acBusy||acRaf)return;acRaf=requestAnimationFrame(acRun);});acObs.observe(document.body,{childList:true,subtree:true});}catch(e){console.error('Auto collapse failed',e);}
})();

try{chrome.runtime.sendMessage({type:'SCM_CLEAR_ALERT_BADGE'}).catch(()=>{});}catch{}

// Settings → Diagnostic → Storage: "Trim now" runs the 90-day retention pass and shows bytes before/after.
document.querySelector('#trimStorageNow')?.addEventListener('click',async e=>{const btn=e.currentTarget,out=document.querySelector('#trimStorageStatus');const mb=b=>b==null?'?':`${(b/1048576).toFixed(2)} MB`;btn.disabled=true;if(out)out.textContent='Trimming…';try{const r=await chrome.runtime.sendMessage({type:'PRUNE_STORAGE'});if(out)out.textContent=r?.ok?`${mb(r.before)} → ${mb(r.after)}${r.written?.length?'':' (nothing older than 90 days)'}`:`Trim failed: ${r?.error||'no answer'}`;}catch(err){if(out)out.textContent=`Trim failed: ${err?.message||err}`;}finally{btn.disabled=false;}});
