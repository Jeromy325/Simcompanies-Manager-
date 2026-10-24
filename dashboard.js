const BUILD_VERSION=chrome.runtime.getManifest().version;
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
// v2.5.331 lag fix: while the Manager tab is hidden (you are in the game), Chrome kept delivering every
// realm-store write (~1.3 MB each, several a minute) to this page and queued renders that all ran when you
// switched back. Storage listeners are now detached while hidden; on return the page reads storage once.
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
  const quality=selected!=null&&qualityByBuilding[selected]!=null?Number(qualityByBuilding[selected])||0:null;
  return {buildingId:selected,planningLevels,productOverrides,quality,qualityByBuilding,runHours:Math.min(48,Math.max(1,Number(p.runHours)||24)),discount:Math.min(10,Math.max(0,Number(p.discount)||0)),planModes};
}
function plannerUiState(s){const key=plannerUiRealmKey(s);if(!plannerUiStateByRealm[key]){const persisted=s?.productionPlannerState&&typeof s.productionPlannerState==='object'?s.productionPlannerState:(s?.frozenNetworkPlan?.plannerState||{});plannerUiStateByRealm[key]=plannerUiStateFromPersisted(persisted);}return plannerUiStateByRealm[key];}
function queuePlannerUiPersist(s){
  const realm=validRealmNumber(s?.viewRealm!=null?s.viewRealm:(s?.selectedRealm!=null?s.selectedRealm:s?.authData?.authCompany?.realmId));
  if(realm==null)return;
  const ui=plannerUiState(s);
  const payload={version:1,realm,selectedBuildingId:ui.buildingId!=null?String(ui.buildingId):null,planningLevels:{...(ui.planningLevels||{})},productOverrides:{...(ui.productOverrides||{})},qualityByBuilding:{...(ui.qualityByBuilding||{})},runHours:Math.min(48,Math.max(1,Number(ui.runHours)||24)),discount:Math.min(10,Math.max(0,Number(ui.discount)||0)),planModes:{...(ui.planModes||{})},updatedAt:new Date().toISOString()};
  // Planner controls are lightweight user preferences. Persist them immediately
  // so a fast page/navigation change cannot outrun a debounce window.
  try{chrome.runtime.sendMessage({type:'SAVE_PRODUCTION_PLANNER_STATE',realm,value:payload}).catch(()=>{});}catch{}
}
function plannerFrozenBuildingPlan(s,id){const map=s?.frozenNetworkPlan?.buildingPlans;if(!map||typeof map!=='object')return null;const p=map[String(id)];return p&&typeof p==='object'?p:null;}
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
  }catch(e){console.error('Accounting refresh failed',e);}
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
$$('.tab').forEach(b=>b.onclick=()=>{activeTab=b.dataset.tab;document.body.classList.toggle('production-active',activeTab==='production');$$('.tab').forEach(x=>x.classList.remove('active'));$$('.tabpage').forEach(x=>x.classList.remove('active'));b.classList.add('active');$('#'+b.dataset.tab).classList.add('active');if((b.dataset.tab==='market'||b.dataset.tab==='warehouse')&&window.__scmState){const n=marketRealmFromState(window.__scmState);if(n!=null)requestLiveMarketRefresh(n,true);}if(window.__scmState){try{render(window.__scmState);}catch(e){console.error('Dashboard tab render failed',e);}}});
document.addEventListener('click',e=>{const b=e.target?.closest?.('[data-accounting-period]');if(!b)return;accountingPeriodView=String(b.dataset.accountingPeriod||'current');document.querySelectorAll('[data-accounting-period]').forEach(x=>x.classList.toggle('active',x===b));if(window.__scmState){try{render(window.__scmState);}catch(err){console.error('Accounting period render failed',err);}}});
// v2.5.171: mobile-friendly row focus for every horizontally scrollable dashboard table.
// Event delegation keeps it working after reactive table patches/re-renders.
document.addEventListener('click',e=>{
  const row=e.target?.closest?.('.tabpage .table-wrap > table tbody > tr');
  if(!row||row.querySelector('[colspan]'))return;
  if(e.target?.closest?.('button,input,select,textarea,a,[contenteditable=\"true\"]'))return;
  const table=row.closest('table');
  table?.querySelectorAll('tbody > tr.scm-row-selected').forEach(x=>x.classList.remove('scm-row-selected'));
  row.classList.add('scm-row-selected');
});
function selectDashboardTab(tab){const key=String(tab||'').trim();const b=[...$$('.tab')].find(x=>x.dataset.tab===key);if(b)b.click();}
// v2.5.330: remember the open tab and scroll position. Mobile browsers unload background
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
  const target=requested||saved?.tab;
  if(target&&target!==activeTab)selectDashboardTab(target);
  if(!requested&&saved?.tab&&saved.y>0){const y=saved.y;let tries=0;const restore=()=>{if(document.documentElement.scrollHeight>=y+innerHeight*0.5||tries++>20){window.scrollTo(0,y);return;}setTimeout(restore,150);};setTimeout(restore,300);}
}catch{}
chrome.runtime.onMessage.addListener(m=>{if(m?.type==='SCM_SELECT_DASHBOARD_TAB'&&m.tab)selectDashboardTab(String(m.tab));});
$$('.helper-page-grid [data-helper-tab]').forEach(b=>b.addEventListener('click',()=>selectDashboardTab(b.dataset.helperTab)));
let dashboardImagesMemo=null;
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
  if(activeRealm!=null){
    const realmNumber=Number(activeRealm);
    const physical=await chrome.storage.local.get({[`scmRealmStore:${realmNumber}`]:null,[`scmRealmDiagnostic:${realmNumber}`]:null,[`scmProductionPlannerState:${realmNumber}`]:null,[`scmGameOverlaySnapshot:${realmNumber}`]:null});
    store=physical[`scmRealmStore:${realmNumber}`]||null;
    if(store&&physical[`scmRealmDiagnostic:${realmNumber}`]&&typeof physical[`scmRealmDiagnostic:${realmNumber}`]==='object') store={...store,fullSyncDiagnostics:physical[`scmRealmDiagnostic:${realmNumber}`]};
    if(physical[`scmGameOverlaySnapshot:${realmNumber}`]&&typeof physical[`scmGameOverlaySnapshot:${realmNumber}`]==='object') store={...(store||{}),gameOverlaySnapshot:physical[`scmGameOverlaySnapshot:${realmNumber}`]};
    productionPlannerState=physical[`scmProductionPlannerState:${realmNumber}`]&&typeof physical[`scmProductionPlannerState:${realmNumber}`]==='object'?physical[`scmProductionPlannerState:${realmNumber}`]:null;
  }
  const empty={authData:null,companyData:null,buildings:null,warehouseResources:[],gameState:null,resourceCatalog:null,endpointData:{},apiEndpoints:[],history:{},contracts:[],savedContracts:[],contractEvents:[],marketCache:{},marketDebug:{},marketTicker:null,marketQueue:[],marketQueueCursor:0,marketLastRequestAt:null,marketQueueStatus:null,liveMarketData:null,liveMarketProduct:null,liveMarketProductCache:{},liveMarketPriceData:null,resourceImageData:{},resourceImageCache:{},resourceImageMeta:{},resourceImageCacheStatus:null,warehouseCapture:null,lastSync:null,syncStatus:'No active realm data',syncError:null,fullSyncDiagnostics:null,warehouseCostDetails:{},accountingLastComputed:null,accountingLastComputedIncome:null,accountingCapture:{},accountingSnapshots:{},tickerSnapshots:{},sellingHistory:{},accountingWeekSales:{},accountingWeekSalesSummary:null,vwapData:null,vwapWatch:null,vwapStatus:null,realmQuarantine:{},productionEvents:[],productionRateSnapshots:{},productionPlans:{},frozenNetworkPlan:null,productionPlannerState:null,gameOverlaySnapshot:null,productionRunHours:24,accountingWeekLedgerStatus:null,javascriptDiagnostic:null,javascriptDiagnosticHistory:[]};
  const scoped={...empty};
  if(store){for(const key of Object.keys(empty)){if(Object.prototype.hasOwnProperty.call(store,key))scoped[key]=store[key];}}
  const result={...scoped,productionPlannerState,realmStores:viewKey?{[viewKey]:scoped}:{},activeRealmKey:s.activeRealmKey??null,selectedRealm:s.selectedRealm!=null?Number(s.selectedRealm):null,viewRealm:activeRealm!=null?Number(activeRealm):null,captureRealm:activeRealm!=null?Number(activeRealm):null,apiBase:s.apiBase,syncMinutes:s.syncMinutes};
  if(readEpoch!==__realmViewEpoch&&attempt<3)return get(attempt+1);
  const currentMeta=await chrome.storage.local.get({activeRealmKey:null});
  if(String(currentMeta.activeRealmKey??'')!==String(result.activeRealmKey??'')&&attempt<3)return get(attempt+1);
  // v2.5.327: images live in their own storage key (loaded once, refreshed only when images change).
  try{const imgs=await dashboardResourceImages();result.resourceImageCache={...(result.resourceImageCache||{}),...imgs};}catch{}
  // v2.5.327: background job history lives in its own key (falls back to the legacy copy in the realm store).
  try{const r=validRealmNumber(result.viewRealm??result.selectedRealm);if(r!=null){const k=`scmBackgroundJobs:${r}`;const h=(await chrome.storage.local.get({[k]:null}))[k];if(Array.isArray(h)){result.backgroundJobHistory=h;if(viewKey&&result.realmStores?.[viewKey])result.realmStores[viewKey]={...result.realmStores[viewKey],backgroundJobHistory:h};}}}catch{}
  // v2.5.331 production cost history (one entry per production run) lives in its own key.
  try{const r=validRealmNumber(result.viewRealm??result.selectedRealm);if(r!=null){const k=`scmProductionCostHistory:${r}`;const h=(await chrome.storage.local.get({[k]:[]}))[k];result.productionCostHistory=Array.isArray(h)?h:[];}}catch{}
  // v2.5.342 game constants (public API) and your exchange listings.
  try{const r=validRealmNumber(result.viewRealm??result.selectedRealm);const g=await chrome.storage.local.get({scmGameConstants:null,[`scmMarketOrders:${r}`]:null});result.gameConstants=g.scmGameConstants||null;result.marketOrders=g[`scmMarketOrders:${r}`]||null;}catch{}
  // v2.5.341 game page config (executive timing) for the admin-overhead calculation.
  try{result.gameConfig=(await chrome.storage.local.get({scmGameConfig:null})).scmGameConfig||null;}catch{}
  // v2.5.338 economy phase log (auth-data temporals.economyState) lives in its own key.
  try{const r=validRealmNumber(result.viewRealm??result.selectedRealm);if(r!=null){const k=`scmEconomyStateLog:${r}`;const h=(await chrome.storage.local.get({[k]:[]}))[k];result.economyStateLog=Array.isArray(h)?h:[];}}catch{}
  commitDashboardState(result);
  return result;
}

function roundCurrencyUp(value){const n=Number(value);if(!Number.isFinite(n))return NaN;const scaled=n*100;const result=Math.ceil(scaled-Number.EPSILON*Math.max(1,Math.abs(scaled)))/100;return result===0?0:result;}
function roundResourceDown(value,precision=3){const n=Number(value),digits=Number(precision);if(!Number.isFinite(n)||!Number.isInteger(digits)||digits<0||digits>8)return NaN;const factor=10**digits,scaled=n*factor;const result=Math.floor(scaled+Number.EPSILON*Math.max(1,Math.abs(scaled)))/factor;return result===0?0:result;}
function money(v){if(v==null||v==='')return '—';const n=Number(v);return Number.isFinite(n)?n.toLocaleString(undefined,{style:'currency',currency:'USD',maximumFractionDigits:2}):'—'}
function contractPriceMoney(v){const n=Number(v);return Number.isFinite(n)?n.toLocaleString(undefined,{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:3}):'—'}
function num(v){const n=Number(v);return Number.isFinite(n)?n.toLocaleString():'—'}
function escapeHtml(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
async function copyDiagnosticText(text,button){try{await navigator.clipboard.writeText(String(text??''));if(button){const old=button.textContent;button.textContent='Copied';setTimeout(()=>button.textContent=old,1200);}}catch(e){const ta=document.createElement('textarea');ta.value=String(text??'');ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.focus();ta.select();try{document.execCommand('copy');if(button){const old=button.textContent;button.textContent='Copied';setTimeout(()=>button.textContent=old,1200);}}finally{ta.remove();}}}
function pick(o,keys){for(const k of keys)if(o?.[k]!==undefined&&o?.[k]!==null)return o[k];return null}
function flattenObjects(x,out=[]){if(!x)return out;if(Array.isArray(x)){for(const v of x)flattenObjects(v,out);return out}if(typeof x==='object'){out.push(x);for(const v of Object.values(x)){if(v&&typeof v==='object')flattenObjects(v,out)}}return out}
const FALLBACK_RESOURCE_NAMES = {'-1':'Power',1:'Power',2:'Water',3:'Apples',4:'Oranges',5:'Grapes',6:'Grain',7:'Steak',8:'Sausages',9:'Eggs',10:'Crude oil',11:'Petrol',12:'Diesel',13:'Transport',14:'Minerals',15:'Bauxite',16:'Silicon',17:'Chemicals',18:'Aluminium',19:'Plastic',20:'Processors',21:'Electronic components',22:'Batteries',23:'Displays',24:'Smart phones',25:'Tablets',26:'Laptops',27:'Monitors',28:'Televisions',29:'Plant research',30:'Energy research',31:'Mining research',32:'Electronics research',33:'Breeding research',34:'Chemistry research',35:'Software',40:'Cotton',41:'Fabric',42:'Iron ore',43:'Steel',44:'Sand',45:'Glass',46:'Leather',47:'On-board computer',48:'Electric motor',49:'Luxury car interior',50:'Basic interior',51:'Car body',52:'Combustion engine',53:'Economy e-car',54:'Luxury e-car',55:'Economy car',56:'Luxury car',57:'Truck',58:'Automotive research',59:'Fashion research',60:'Underwear',61:'Gloves',62:'Dress',63:'Stiletto Heel',64:'Handbags',65:'Sneakers',66:'Seeds',67:'Xmas crackers',68:'Gold ore',69:'Golden bars',70:'Luxury watch',71:'Necklace',72:'Sugarcane',73:'Ethanol',74:'Methane',75:'Carbon fibers',76:'Carbon composite',77:'Fuselage',78:'Wing',79:'High grade e-comps',80:'Flight computer',81:'Cockpit',82:'Attitude control',83:'Rocket fuel',84:'Propellant tank',85:'Solid fuel booster',86:'Rocket engine',87:'Heat shield',88:'Ion drive',89:'Jet engine',90:'Sub-orbital 2nd stage',91:'Sub-orbital rocket',92:'Orbital booster',93:'Starship',94:'BFR',95:'Jumbo jet',96:'Luxury jet',97:'Single engine plane',98:'Quadcopter',99:'Satellite',100:'Aerospace research',101:'Reinforced concrete',102:'Bricks',103:'Cement',104:'Clay',105:'Limestone',106:'Wood',107:'Steel beams',108:'Planks',109:'Windows',110:'Tools',111:'Construction units',112:'Bulldozer',113:'Materials research',114:'Robots',115:'Cows',116:'Pigs',117:'Milk',118:'Coffee beans',119:'Coffee powder',120:'Vegetables',121:'Bread',122:'Cheese',123:'Apple pie',124:'Orange juice',125:'Apple cider',126:'Ginger beer',127:'Frozen pizza',128:'Pasta',129:'Hamburger',130:'Lasagna',131:'Meat balls',132:'Cocktails',133:'Flour',134:'Butter',135:'Sugar',136:'Cocoa',137:'Dough',138:'Sauce',139:'Fodder',140:'Chocolate',141:'Vegetable oil',142:'Salad',143:'Samosa',144:'Xmas ornament',145:'Recipes',146:'Pumpkin',147:'Jack o\'lantern',148:'Witch costume',149:'Pumpkin soup',150:'Tree',151:'Easter Bunny',152:'Ramadan sweets',153:'Chocolate icecream',154:'Apple icecream',155:'Cream egg'};
// v2.5.361 performance: resourceInfo() ran this for every warehouse row / planner resource and, when an image was not in
// the catalog, flattened the whole captured endpoint data (MBs) per resource. Both are now memoized per captured object.
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
  1:'power.png',2:'water.png',3:'apples.png',4:'oranges.png',5:'grapes.png',6:'grain.png',7:'steak.png',8:'sausages.png',9:'eggs.png',10:'crude-oil.png',11:'petrol.png',12:'diesel.png',13:'transport.png',14:'minerals.png',15:'bauxite.png',16:'silicon.png',17:'chemicals.png',18:'aluminium.png',19:'plastic.png',20:'processors.png',21:'electronic-components.png',22:'batteries.png',23:'displays.png',24:'smartphones.png',25:'tablets.png',26:'laptops.png',27:'monitors.png',28:'televisions.png',29:'plant-research.png',30:'energy-research.png',31:'mining-research.png',32:'electronics-research.png',33:'breeding-research.png',34:'chemistry-research.png',35:'software.png',40:'cotton.png',41:'fabric.png',42:'iron-ore.png',43:'steel.png',44:'sand.png',45:'glass.png',46:'leather.png',47:'on-board-computer.png',48:'electric-motor.png',49:'luxury-car-interior.png',50:'basic-interior.png',51:'car-body.png',52:'combustion-engine.png',53:'economy-electric-car.png',54:'luxury-electric-car.png',55:'economy-fuel-car.png',56:'luxury-fuel-car.png',57:'truck.png',58:'automotive-research.png',59:'fashion-research.png',60:'underwear.png',61:'gloves.png',62:'skirt.png',63:'high-heels.png',64:'handbag.png',65:'sports-shoes.png',66:'seeds.png',67:'xmas-crackers.png',68:'gold-ore.png',69:'golden-bars.png',70:'luxury-watch.png',71:'necklace.png',72:'sugarcane.png',73:'ethanol.png',74:'methane.png',75:'carbon-fibers.png',76:'carbon-composite.png',77:'fuselage.png',78:'wing.png',79:'high-grade-e-comps.png',80:'flight-computer.png',81:'cockpit.png',82:'attitude-control.png',83:'rocket-fuel.png',84:'propellant-tank.png',85:'solid-fuel-booster.png',86:'rocket-engine.png',87:'heat-shield.png',88:'ion-drive.png',89:'jet-engine.png',90:'sub-orbital-2nd-stage.png',91:'sub-orbital-rocket.png',92:'orbital-booster.png',93:'starship.png',94:'bfr.png',95:'jumbo-jet.png',96:'luxury-jet.png',97:'single-engine-plane.png',98:'quadcopter.png',99:'satellite.png',100:'aerospace-research.png',101:'reinforced-concrete.png',102:'bricks.png',103:'cement.png',104:'clay.png',105:'limestone.png',106:'wood.png',107:'beams.png',108:'planks.png',109:'windows.png',110:'tools.png',111:'construction-units.png',112:'bulldozer.png',113:'materials-research.png',114:'robots.png',115:'cows.png',116:'pigs.png',117:'milk.png',118:'coffee-beans.png',119:'coffee-ground.png',120:'vegetables.png',121:'bread.png',122:'cheese.png',123:'apple-pie.png',124:'orange-juice.png',125:'apple-cider.png',126:'ginger-beer.png',127:'frozen-pizza.png',128:'pasta.png',129:'hamburger.png',130:'lasagna.png',131:'meat-balls.png',132:'cocktails.png',133:'flour.png',134:'butter.png',135:'sugar.png',136:'cocoa.png',137:'dough.png',138:'sauce.png',139:'fodder.png',140:'chocolate.png',141:'vegetable-oil.png',142:'salad.png',143:'samosa.png',144:'xmas-ornament.png',145:'recipes.png',146:'pumpkin.png',147:'jack-o-lantern.png',148:'witch-costume.png',149:'pumpkin-soup.png',150:'tree.png',151:'easter-bunny.png',152:'ramadan-sweets.png',153:'chocolate-icecream.png',154:'apple-icecream.png',155:'cream-egg.png'
};
const RESOURCE_IMAGE_404_FILENAMES=new Set(["smartphones.png", "basic-interior.png", "economy-electric-car.png", "luxury-electric-car.png", "economy-fuel-car.png", "luxury-fuel-car.png", "skirt.png", "high-heels.png", "handbag.png", "sports-shoes.png", "luxury-watch.png", "carbon-fibers.png", "high-grade-e-comps.png", "propellant-tank.png", "solid-fuel-booster.png", "sub-orbital-2nd-stage.png", "bfr.png", "jumbo-jet.png", "luxury-jet.png", "single-engine-plane.png", "aerospace-research.png", "beams.png", "cows.png", "pigs.png", "frozen-pizza.png", "meat-balls.png", "cocoa.png", "sauce.png", "samosa.png", "chocolate-icecream.png", "apple-icecream.png"]);
function resourceImageSlug(name){
  return String(name||'').toLowerCase().replace(/&/g,'and').replace(/['’]/g,'').replace(/\bsub orbital\b/g,'sub-orbital').replace(/\s*2nd\s*stage\b/g,'2nd-stage').replace(/\s+/g,'-').replace(/[^a-z0-9-]+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
}
function resourceInfo(x,s){
  const id=pick(x,['kind','resource','resourceId','productId']); const map=catalogEntries(s); const c=id!=null?map.get(String(id)):null;
  let image=s.resourceImageCache?.[String(id)]||s.resourceImageData?.[String(id)]||c?.image||s.resourceCatalog?.resourceImages?.[String(id)]||null;
  if(!image && id!=null){
    const root=s.resourceCatalog?.constantsResources||{}; const o=root[String(id)];
    image=pick(o,['image','icon','iconUrl','imageUrl','picture','img']);
  }
  if(!image && id!=null){
    const path=Object.keys(s.endpointData||{}).find(k=>{const m=k.match(/^\/api\/v3\/resources\/(\d+)\/?(?:\?.*)?$/);return m&&Number(m[1])===Number(id)});
    const data=path?s.endpointData[path]?.data:null;
    const found=flattenObjects(data).find(o=>o&&typeof o==='object'&&pick(o,['image','icon','iconUrl','imageUrl','picture','img']));
    image=found?pick(found,['image','icon','iconUrl','imageUrl','picture','img']):null;
  }
  const name=c?.name||FALLBACK_RESOURCE_NAMES[id]||pick(x,['product','name','resourceName'])||`Resource #${id}`;
  if(!image && id!=null){
    image=scmCapturedImageIndex(s,[s.buildings,s.gameState,s.endpointData]).get(Number(id))||null;
  }
  const candidates=imageCandidates(image).filter(candidate=>!RESOURCE_IMAGE_404_FILENAMES.has(String(candidate).split("/").pop().split("?")[0]));
  const override=Number.isFinite(Number(id))?RESOURCE_IMAGE_FILE_OVERRIDES[String(Number(id))]:null;
  const guessedName=override||`${resourceImageSlug(name)}.png`;
  if(guessedName&&!RESOURCE_IMAGE_404_FILENAMES.has(guessedName)){
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

function warehouseAlertUnitCost(s,r){
  const fallback=Number(r?._unitCost);
  const realm=Number(s.viewRealm??s.captureRealm??s.authData?.authCompany?.realmId??s.authData?.authCompany?.realm);
  const key=Number.isFinite(realm)?`realm:${realm}`:null;
  const detailMap=key?(s.warehouseCostDetails?.[key]||s.warehouseCostDetails||{}):{};
  const details=Array.isArray(detailMap?.[String(r?._id)])?detailMap[String(r._id)].filter(x=>x?.unitCost!==null&&x?.unitCost!==undefined&&Number.isFinite(Number(x.unitCost))&&Number(x.unitCost)>=0):[];
  if(details.length){
    const warehouseQualities=warehouseRows(s).filter(x=>Number(x._id)===Number(r._id)).map(x=>Number(x._quality)).filter(Number.isFinite);
    const exact=details.filter(d=>warehouseQualities.includes(Number(d.quality)) && Number(d.quality)===Number(r._quality));
    if(exact.length)return Number(exact.sort((a,b)=>Date.parse(b.capturedAt||'')-Date.parse(a.capturedAt||''))[0].unitCost);
    // The warehouse-page parser can report the star count differently from the
    // API quality on some game screens. If this product exists at only one
    // warehouse quality, the latest game sourcing-cost capture is authoritative.
    const distinct=new Set(warehouseQualities);
    if(distinct.size===1){
      return Number(details.sort((a,b)=>Date.parse(b.capturedAt||'')-Date.parse(a.capturedAt||''))[0].unitCost);
    }
  }
  return r?._unitCost!==null&&r?._unitCost!==undefined&&Number.isFinite(fallback)&&fallback>=0?fallback:null;
}

function marketArray(data){
  if(Array.isArray(data)) return data;
  if(!data || typeof data!=='object') return [];
  const directKeys=['data','orders','market','results','items','entries','sellOrders','buyOrders','offers','list'];
  for(const k of directKeys){ if(Array.isArray(data[k])) return data[k]; }
  // Some Sim Companies responses are nested by quality/side. Find the first
  // meaningful array of order-like objects instead of assuming one shape.
  const candidates=[];
  const walk=(v)=>{
    if(Array.isArray(v)){
      if(v.some(x=>x&&typeof x==='object' && ('price' in x || 'quality' in x))) candidates.push(v);
      return;
    }
    if(v&&typeof v==='object') Object.values(v).forEach(walk);
  };
  walk(data);
  return candidates.sort((a,b)=>b.length-a.length)[0]||[];
}

function simcoVwapRows(s,id,q){
  const rows=Array.isArray(s.vwapData?.rows)?s.vwapData.rows:[];
  const n=Number(id), qual=Number(q);
  return rows.filter(x=>Number(x.resourceId)===n && Number(x.quality)===qual).map(x=>({quality:qual,price:Number(x.value),quantity:1,source:'SimcoTools'}));
}
function marketPaths(s,id){
  const n=Number(id);
  return Object.keys(s.endpointData||{}).filter(k=>{const m=String(k).match(/^\/api\/v3\/market(?:\/all)?\/(\d+)\/(\d+)\/?(?:\?.*)?$/);return m&&Number(m[2])===n;}).sort((a,b)=>new Date(s.endpointData[b]?.receivedAt||0)-new Date(s.endpointData[a]?.receivedAt||0));
}
function marketRows(s,id,q=null){
  if(q!=null){const vw=simcoVwapRows(s,id,q);if(vw.length)return vw;}
  for(const path of marketPaths(s,id)){
    const rows=marketArray(s.endpointData?.[path]?.data);
    if(rows.length) return rows;
  }
  return marketArray(s.marketCache?.[String(id)]?.data);
}
function marketSource(s,id,q=null){
  if(q!=null && cachedMarketPrice(s,id,q)!=null) return 'Current market price';
  return 'Market price not captured';
}
function marketStats(rows,q){
  const usable=rows.map(o=>({
    q:Number(pick(o,['quality','q'])),
    p:Number(pick(o,['price','unitPrice','amountPrice'])),
    a:Number(pick(o,['amount','quantity','units','volume','available','count']))||0
  })).filter(o=>Number.isFinite(o.p)&&o.p>0&&Number.isFinite(o.q));
  const exact=usable.filter(o=>o.q===q);
  const eligible=usable.filter(o=>o.q>=q);
  const pool=exact.length?exact:eligible;
  const best=pool.length?Math.min(...pool.map(o=>o.p)):null;
  const weighted=pool.filter(o=>o.a>0);
  const vwap=weighted.length?weighted.reduce((s,o)=>s+o.p*o.a,0)/weighted.reduce((s,o)=>s+o.a,0):null;
  return {best,vwap,quality:exact.length?q:(pool.length?Math.min(...pool.map(o=>o.q)):null),fallback:!exact.length&&pool.length,orderCount:usable.length};
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
function buildBalanceSections(bs){
  if(!bs||typeof bs!=='object')return '<p class="muted">No balance sheet response captured yet. Open Sim Companies HQ/Accounting and press Sync.</p>';
  const used=new Set();
  const add=(keys,label)=>{const rows=[];for(const k of keys){if(bs[k]!==undefined){const n=numericValue(bs[k]);if(n!==null){rows.push([labelize(k),n]);used.add(k);}}}return rows;};
  const assets=add(['cash','accountsReceivable','materials','workInProcess','finishedGoods','research','deposits','investmentInBonds','buildings','patents','valuationAllowance','otherAssets'],'Assets');
  if(bs.materials!==undefined||bs.workInProcess!==undefined||bs.finishedGoods!==undefined||bs.valuationAllowance!==undefined){const inv=(numericValue(bs.materials)||0)+(numericValue(bs.workInProcess)||0)+(numericValue(bs.finishedGoods)||0)+(numericValue(bs.valuationAllowance)||0);assets.splice(1,0,['Inventory',inv]);}
  const liabilities=add(['bondsPayable','accountsPayable','loans','otherLiabilities','liabilities','totalLiabilities'],'Liabilities');
  const equity=add(['contributedCapital','retainedEarnings','equity','totalEquity'],'Equity');
  const extra=financialEntries(bs,used);
  return `<div class="statement-grid">${statementTable('Assets',assets)}${statementTable('Liabilities',liabilities)}${statementTable('Equity',equity)}${extra.length?statementTable('Other balance-sheet fields',extra):''}</div>`;
}
function buildCashflowSections(cf,recent){
  let tx=[];
  const extract=v=>{
    if(Array.isArray(v))return v;
    if(!v||typeof v!=='object')return [];
    for(const k of ['transactions','transaction','items','entries','movements','operations','data','results','cashflow','cashFlow','history','records']){if(Array.isArray(v[k]))return v[k];}
    const found=[]; const walk=x=>{if(Array.isArray(x)){x.forEach(y=>{if(y&&typeof y==='object')found.push(y)});return;}if(x&&typeof x==='object')Object.values(x).forEach(walk)}; walk(v);
    return found.filter(x=>pick(x,['amount','cashChange','change','value','money','description','profit','netProfit','price','quantity','qty'] )!=null);
  };
  tx=extract(recent).length?extract(recent):extract(cf);
  if(!tx.length){
    const source=(cf&&typeof cf==='object')?cf:recent;
    const rows=financialEntries(source||{}).slice(0,80);
    return rows.length?`<div class="statement-card full-width"><h3>Cash-flow statement</h3><div class="table-wrap"><table class="statement-table"><thead><tr><th>Item</th><th>Amount</th></tr></thead><tbody>${renderStatementRows(rows)}</tbody></table></div></div>`:'<p class="muted">The cash-flow endpoint was captured, but it did not contain a readable transaction list yet.</p>';
  }
  const transactionMetric=(t,keys)=>pickNumericDeep(t,keys);
  const txRows=tx.slice(0,100).map(t=>{
    const desc=pick(t,['description','name','title','text'])||pick(t.details||{},['description','name','title','text'])||'Transaction';
    const amount=transactionMetric(t,['amount','cashChange','change','value','money']);
    const price=transactionMetric(t,['price','unitPrice','pricePerUnit','unit_price']);
    const profit=transactionMetric(t,['profit','netProfit','earnings']);
    const quantity=transactionQuantity(t,price,amount);
    return `<tr><td>${escapeHtml(desc)}</td><td>${amount==null?'—':money(amount)}</td><td>${price==null?'—':money(price)}</td><td>${profit==null?'—':money(profit)}</td><td>${quantity==null?'—':num(quantity)}</td></tr>`;
  }).join('');
  return `<div class="statement-card full-width"><h3>Recent cash-flow transactions</h3><div class="table-wrap"><table class="statement-table"><thead><tr><th>Description</th><th>Amount</th><th>Price</th><th>Profit</th><th>Qty</th></tr></thead><tbody>${txRows}</tbody></table></div></div>`;
}
function pickQuantityDeep(obj){
  const preferred=['quantity','qty','units','amountItems','itemQuantity','itemCount','quantityItems','itemsQuantity','countItems','resourceQuantity','productQuantity','quantitySold','quantityBought','itemQty','resourceAmount','unitsAmount','unitCount','volume','count'];
  const wanted=new Set(preferred.map(k=>k.toLowerCase())); const seen=new Set();
  const walk=v=>{
    if(!v||typeof v!=='object'||seen.has(v))return null; seen.add(v);
    if(!Array.isArray(v)){
      for(const [k,x] of Object.entries(v)){
        if(wanted.has(String(k).toLowerCase())){const n=numericValue(x);if(n!==null&&Math.abs(n)<1e9)return n;}
      }
      for(const x of Object.values(v)){const r=walk(x);if(r!==null)return r;}
    } else for(const x of v){const r=walk(x);if(r!==null)return r;}
    return null;
  };
  return walk(obj);
}
function transactionQuantity(t,price,amount){
  const direct=pickQuantityDeep(t); if(direct!=null)return direct;
  if(Number.isFinite(price)&&price>0&&Number.isFinite(amount)&&Math.abs(amount)>0){
    const d=JSON.stringify(t).toLowerCase();
    if(/sell|sale|sold|buy|purchase|exchange|market|contract/.test(d)){ const q=Math.abs(amount)/price; if(Number.isFinite(q)&&q<1e9)return q; }
  }
  return null;
}
// v2.5.330: the game's own daily history (past-finances-overview + v3 past-finances)
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
function accountingPreviousPeriod(history,periodEnd){
  const end=Date.parse(String(periodEnd||''));
  if(!Array.isArray(history)||!history.length)return null;
  const rows=Number.isFinite(end)?history.filter(r=>r.t<end-3600000):history.slice(0,-1);
  const r=rows[rows.length-1];
  if(!r)return null;
  return {cash:r.cash??null,profit:r.profit??null,assets:r.assets??null,liabilities:r.liabilities??null,inventory:r.inventory??null,currentAssets:r.currentAssets??null,currentLiabilities:r.liabilities??null,revenue:r.sales??null,cashIn:r.cashIn??null,expenses:r.expenses??null,date:new Date(r.t).toISOString(),source:'game-history'};
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
  const latestComputed=(rx,path)=>{
    const candidates=eps.filter(k=>rx.test(k)&&Number(endpointData[k]?.status)===200&&endpointData[k]?.data!=null)
      .map(k=>endpointData[k]).filter(x=>x?.data?.isComputed===true)
      .sort((a,b)=>new Date(b.receivedAt||0)-new Date(a.receivedAt||0));
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
  const bs=latest(/\/api\/v2\/companies\/(?:me|\d+)\/balance-sheet(?:\/\d+)?\/?/i)
    ?? latestSupplemental('/api/v2/companies/me/balance-sheet/');
  // Prefer the most recent COMPLETED aggregate period. At the daily rollover
  // Sim Companies can return an isComputed:false zero placeholder; that is not
  // an accounting period and must never replace the previous completed data.
  const cf=latestComputed(/\/api\/v2\/companies\/(?:me|\d+)\/cashflow-statement(?:\/\d+)?\/?$/i,'/api/v2/companies/me/cashflow-statement/')
    ?? latest(/\/api\/v2\/companies\/(?:me|\d+)\/cashflow-statement(?:\/\d+)?\/?$/i)
    ?? latest(/\/api\/v2\/companies\/(?:me|\d+)\/cashflow(?:\/recent)?(?:\/\d+)?\/?$/i);
  // Prefer the dedicated recent cash-flow ledger. Other financial endpoints can
  // be newer than it during Full Sync, but Top 10 Gross Resources needs the
  // transaction rows from /cashflow/recent/ (amount, price, profit, resource).
  const recent=latest(/\/api\/v2\/companies\/(?:me|\d+)\/cashflow\/recent\/?$/i)
    ?? latest(/\/api\/(?:v2|v3)\/companies\/(?:me|\d+)(?:\/[^?]*)?(?:cashflow|cash-flow|financial)[^?]*(?:\/\d+)?\/?(?:\?.*)?$/i);
  const pf=latest(/\/api\/(?:v2\/companies\/(?:me|\d+)\/past-finances-overview|v3\/companies\/(?:me|\d+)\/past-finances)(?:\/\d+)?\/?/i);
  const income=latestComputed(/\/api\/v2\/companies\/(?:me|\d+)\/income-statement(?:\/\d+)?\/?$/i,'/api/v2/companies/me/income-statement/')
    ?? latest(/\/api\/v2\/companies\/(?:me|\d+)\/(?:income-statement|profit-loss)(?:\/\d+)?\/?/i);

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
  // cashAllExpenses fields. In that shape the old code fell through to zeros
  // because all category-total fields were absent. Derive the current captured
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
  const transactionIncome=transactionRows
    .filter(x=>x.money>0)
    .reduce((sum,x)=>sum+x.money,0);
  const transactionExpenses=transactionRows
    .filter(x=>x.money<0)
    .reduce((sum,x)=>sum+Math.abs(x.money),0);

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
  const assets=get(bs,['assets','totalAssets']) ?? pickNumericDeep(bs,['assets','totalAssets']) ?? get(latestPastFinanceRow,['assets','totalAssets','total']);
  const liabilities=get(bs,['liabilities','totalLiabilities']) ?? pickNumericDeep(bs,['liabilities','totalLiabilities']) ?? get(latestPastFinanceRow,['liabilities','totalLiabilities','liabilities']);

  // The balance sheet exposes the inventory components explicitly.
  // Inventory = materials + work in process + finished goods.
  let inventory=null;
  if(obj(bs)){
    const materials=get(bs,['materials'])||0;
    const wip=get(bs,['workInProcess'])||0;
    const finished=get(bs,['finishedGoods'])||0;
    const valuationAllowance=get(bs,['valuationAllowance','valuation_allowance'])||0;
    if(materials||wip||finished||valuationAllowance||('materials' in bs)||('workInProcess' in bs)||('finishedGoods' in bs)||('valuationAllowance' in bs)) inventory=materials+wip+finished+valuationAllowance;
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
  // v2.5.330: the balance-sheet API has no accounts-payable field. Total liabilities
  // (game history) minus bonds payable (balance sheet) is the current-liability part.
  const derivedPayable=accountsPayable==null&&liabilities!=null&&bondsPayable!=null?Math.max(0,Math.abs(liabilities)-Math.abs(bondsPayable)):null;
  const payable=accountsPayable??derivedPayable;
  const currentLiabilities=payable==null?null:Math.abs(payable);
  const period={dateFrom:cfObj.dateFrom||transactionDateFrom,date:cfObj.date||transactionDateTo};
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
  return {cash,revenue:finalRevenue,expenses,profit:finalProfit,netMargin:finalMargin,assets,liabilities,inventory,accountsReceivable,accountsPayable:payable,bondsPayable,currentAssets,currentLiabilities,period,history,previousPeriod:accountingPreviousPeriod(history,period.date),ledgerCheck,source:{bs,cf,recent,pf,income},sourceType: income ? 'income-statement' : (cf ? (transactionRows.length?'cash-flow-transactions':'cash-flow-derived') : 'unavailable')};
}
window.scmImageFallback=function(img){try{const c=JSON.parse(img.dataset.candidates||'[]');const i=Number(img.dataset.idx||0)+1;if(i<c.length){img.dataset.idx=String(i);img.src=c[i];return;}img.style.display='none';}catch{img.style.display='none';}};
function recordHistory(s,rows){const history={...(s.history||{})},day=new Date().toISOString().slice(0,10);for(const r of rows){if(!Number.isFinite(r._id)||r._quality==null)continue;const st=marketStats(marketRows(s,r._id,r._quality),r._quality);if(st.vwap==null)continue;const key=`${r._id}:${r._quality}`;const arr=Array.isArray(history[key])?history[key].slice():[];const idx=arr.findIndex(x=>x.date===day);const item={date:day,vwap:st.vwap};if(idx>=0)arr[idx]=item;else arr.push(item);history[key]=arr}return history}
function snapshotRealmKey(s){const r=s.viewRealm!=null?Number(s.viewRealm):(s.captureRealm!=null?Number(s.captureRealm):null);return r!=null?`realm:${r}`:'auto';}
function changeArrow(current,previous){const a=Number(current),b=Number(previous);if(!Number.isFinite(a)||!Number.isFinite(b)||a===b)return '';const up=a>b;return `<span class="change-arrow ${up?'change-up':'change-down'}" title="${up?'Increased':'Decreased'} from previous value">${up?'↑':'↓'}</span>`;}
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
  return JSON.stringify({entries,supplemental:supplementalSig,lastComputed:summarizeComputed(store?.accountingLastComputed),lastComputedIncome:summarizeComputed(store?.accountingLastComputedIncome),accountingWeekRevision:Number(store?.accountingWeekRevision)||0,weekSummary,weekStatus});
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
  // v2.4.43/v2.4.44 snapshots did not carry a baseline schema marker.
  // Those snapshots could contain a stale pre-realm comparison (notably R1's
  // $2.28M cash baseline). Treat that legacy comparison as invalid exactly
  // once, while preserving the captured current values for diagnostics/history.
  const baselineSchemaVersion=Number(old?.baselineSchemaVersion)||0;
  const validBaseline=sameRealm && baselineSchemaVersion===2;
  const legacyBaseline=sameRealm && baselineSchemaVersion<2;
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
function adminOverheadData(s,rows){
  const ep=s.endpointData||{};
  const keys=Object.keys(ep).filter(k=>/\/api\/v3\/companies-by-company\//i.test(k)||/\/api\/v2\/companies\/me\/administration-overhead\/?(?:\d+)?$/i.test(k)||/administration-overhead/i.test(k)).sort((a,b)=>new Date(ep[b]?.receivedAt||0)-new Date(ep[a]?.receivedAt||0));
  const sources=[]; for(const k of keys)if(ep[k]?.data!=null)sources.push(ep[k].data);
  if(s.gameState?.region)sources.push(s.gameState.region); if(s.authData)sources.push(s.authData);
  let raw=null; for(const data of sources){raw=pickNumericDeep(data,['administrationOverhead','administration','adminOverhead','overheadPercentage','overhead','percentage']);if(raw!=null)break;}
  if(raw==null||!Number.isFinite(Number(raw))){const buildings=buildingArrayFromState(s);const levels=buildings.reduce((sum,b)=>{const n=Number(pick(b,['size','level','lvl','buildingLevel']));return sum+(Number.isFinite(n)&&n>0?n:0);},0);if(levels>0){const base=Math.max(0,(levels-1)/170*100);return {base,reduction:0,net:base,bonus:0,bonusExact:0,raw:null,source:'building-level calculation',levels};}return {base:null,reduction:0,net:null,bonus:0,bonusExact:0};}
  raw=Number(raw);const basePct=raw>10?raw:raw>1?(raw-1)*100:raw*100;return {base:basePct,reduction:0,net:Math.max(0,basePct),bonus:0,bonusExact:0,raw,source:'game endpoint'};
}
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
  // v2.5.330: buildings running at the same cost are shown once ("$30.46 · 7 Mills")
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
function deepValue(root, keys, maxDepth=6){
  const wanted=new Set(keys.map(k=>String(k).toLowerCase())); const seen=new Set();
  const walk=v=>{
    if(v==null||typeof v!=='object'||seen.has(v))return null; seen.add(v);
    if(!Array.isArray(v)){
      for(const [k,x] of Object.entries(v)){if(wanted.has(String(k).toLowerCase())&&x!=null)return x;}
      for(const x of Object.values(v)){const r=walk(x);if(r!=null)return r;}
    } else for(const x of v){const r=walk(x);if(r!=null)return r;}
    return null;
  };
  return walk(root);
}
function busyObject(b){
  if(b?.busy&&typeof b.busy==='object') return b.busy;
  const x=findNestedObject(b,['busy','production','productionState','currentProduction','runningProduction']);
  return x||null;
}
function productionResourceId(b){
  const busy=busyObject(b)||b;
  const v=deepValue(busy,['resourceId','productId','resource','product','output','resourceKind','dbLetter','kind']);
  if(v&&typeof v==='object'){const n=Number(pick(v,['kind','resourceId','productId','id']));return Number.isFinite(n)?n:null;}
  const n=Number(v);return Number.isFinite(n)?n:null;
}
function productionQuantity(b){
  const busy=busyObject(b);
  const roots=[busy,b].filter(x=>x&&typeof x==='object');
  const keys=['quantityRemaining','amountRemaining','unitsRemaining','remainingQuantity','remainingAmount','remainingUnits','productionLeft','quantityLeft','amountLeft','unitsLeft','outputAmount','outputQuantity','outputUnits','productionQuantity','productionAmount','productionUnits','amountProduced','quantityProduced','batchSize','batchQuantity','totalQuantity','quantity','amount','qty','units'];
  for(const root of roots){
    for(const k of keys){
      const v=root?.[k];
      if(v&&typeof v==='object'){
        const n=Number(pick(v,['quantity','amount','qty','units','remaining','value']));
        if(Number.isFinite(n)&&n>=0)return n;
      } else {
        const n=Number(v);
        if(Number.isFinite(n)&&n>=0)return n;
      }
    }
    const v=deepValue(root,keys);
    const n=Number(v);
    if(Number.isFinite(n)&&n>=0)return n;
  }
  return null;
}
function productionEnd(b){
  const busy=busyObject(b);
  const roots=[busy,b].filter(x=>x&&typeof x==='object');
  const keys=['endsAt','endAt','until','finishAt','finishedAt','completionAt','completeAt','productionEnd','productionEndTime','timeEnd','timeRemaining','remainingTime','secondsLeft','timeLeft','finish','finishTime','completionTime','endTime','runEnd','productionFinish','productionFinishTime'];
  for(const root of roots){const v=deepValue(root,keys);if(v!=null)return v;}
  return null;
}
function timeLeftText(value){if(value==null)return '—';const t=Date.parse(String(value));if(Number.isFinite(t)){const sec=Math.max(0,Math.floor((t-Date.now())/1000));const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),ss=sec%60;return h?`${h}h ${m}m`:m?`${m}m ${ss}s`:`${ss}s`;}const n=Number(value);if(Number.isFinite(n)&&n>=0){const sec=n>100000?Math.floor(n/1000):Math.floor(n);const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),ss=sec%60;return h?`${h}h ${m}m`:m?`${m}m ${ss}s`:`${ss}s`;}return String(value);}
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
    status.textContent=capture==null?'No game realm detected':capture===view?'Live game realm':'Viewing saved data';
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
  chrome.runtime.sendMessage({type:'LIVE_MARKET_REFRESH',realm:n}).catch(()=>{}).finally(()=>{__liveMarketBusy=false;});
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
function ensureLiveMarketTimer(s){
  if(__liveMarketTimer)return;
  __liveMarketTimer=setInterval(()=>{
    if(activeTab!=='market'&&activeTab!=='warehouse')return;
    const state=window.__scmState||s;
    const n=marketRealmFromState(state); if(n==null)return;
    requestLiveMarketRefresh(n);
    const key=String(__selectedMarketKey||'');
    if(key.includes(':')){const [id,q]=key.split(':').map(Number);if(Number.isFinite(id)&&Number.isFinite(q))requestLiveMarketProduct(n,id,q);}
  },300000);
}
function marketWarehouseOptions(s){
  const rows=warehouseRows(s).filter(r=>Number(r?._qty||0)>0&&Number.isFinite(Number(r?._id))&&Number.isFinite(Number(r?._quality)));
  const seen=new Set();
  return rows.map(r=>({key:`${Number(r._id)}:${Number(r._quality)}`,id:Number(r._id),quality:Number(r._quality),qty:Number(r._qty)||0,name:resourceName(r,s),cost:Number(r._unitCost)})).filter(x=>{if(seen.has(x.key))return false;seen.add(x.key);return true;}).sort((a,b)=>a.name.localeCompare(b.name)||a.quality-b.quality);
}
function marketNumeric(v){if(v===null||v===undefined||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null;}
function marketMoney(v){const n=marketNumeric(v);return n==null?'—':money(n);}
function cachedMarketVwap(s,resourceId,quality){const rows=Array.isArray(s?.vwapData?.rows)?s.vwapData.rows:[];const row=rows.find(r=>Number(r?.resourceId)===Number(resourceId)&&Number(r?.quality)===Number(quality));const v=marketNumeric(row?.value??row?.vwap??row?.price);return v!=null&&v>0?v:null;}
function cachedMarketPrice(s,resourceId,quality){
  const id=Number(resourceId),q=Number(quality),rows=Array.isArray(s?.liveMarketPriceData?.rows)?s.liveMarketPriceData.rows:[];
  const row=rows.find(r=>Number(r?.resourceId)===id&&Number(r?.quality)===q);
  const direct=marketNumeric(row?.price);if(direct!=null&&direct>0)return direct;
  const key=`${id}:${q}`,product=s?.liveMarketProductCache?.[key];
  const selected=Number(product?.resourceId)===id&&Number(product?.quality)===q?marketNumeric(product?.selected?.price):null;
  return selected!=null&&selected>0?selected:null;
}
function buildMarketPriceMap(s){
  const map=new Map(),rows=Array.isArray(s?.liveMarketPriceData?.rows)?s.liveMarketPriceData.rows:[];
  for(const row of rows){const id=Number(row?.resourceId),q=Number(row?.quality),price=marketNumeric(row?.price);if(Number.isFinite(id)&&id>0&&Number.isFinite(q)&&price!=null&&price>0)map.set(`${id}:${q}`,price);}
  for(const [key,product] of Object.entries(s?.liveMarketProductCache||{})){const id=Number(product?.resourceId),q=Number(product?.quality),price=marketNumeric(product?.selected?.price);if(Number.isFinite(id)&&id>0&&Number.isFinite(q)&&price!=null&&price>0&&key===`${id}:${q}`&&!map.has(key))map.set(key,price);}
  return map;
}
function exactMarketPrice(map,id,quality){const value=marketNumeric(map instanceof Map?map.get(`${Number(id)}:${Number(quality)}`):null);return value!=null&&value>0?value:null;}
function marketPriceReference(map,id,quality){
  const exact=exactMarketPrice(map,id,quality);
  if(exact!=null)return {price:exact,quality:Number(quality),exact:true};
  if(!(map instanceof Map))return null;
  const targetId=Number(id),targetQ=Number(quality);
  if(!Number.isFinite(targetId)||!Number.isFinite(targetQ))return null;
  const candidates=[];
  for(const [key,value] of map){
    const match=String(key).match(/^(\d+):(\d+)$/);
    if(!match||Number(match[1])!==targetId||!(Number(value)>0))continue;
    candidates.push({price:Number(value),quality:Number(match[2]),distance:Math.abs(Number(match[2])-targetQ)});
  }
  candidates.sort((a,b)=>a.distance-b.distance||a.quality-b.quality);
  return candidates.length?{price:candidates[0].price,quality:candidates[0].quality,exact:false}:null;
}

function marketDate(v){if(v==null)return '—';if(typeof v==='object'){v=v.timestamp??v.time??v.date??v.at??v.value??null;}const d=new Date(v);return Number.isNaN(d.getTime())?String(v):d.toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});}
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
  const vwap=cachedMarketVwap(activeStore,item.id,item.quality)??marketNumeric(fullProduct?.vwap)??marketNumeric(fullProduct?.selected?.vwap)??marketNumeric(currentPriceRow?.vwap);
  // Use the cached row while detail/candle fetch is pending; a different
  // selected-product pointer must never blank an already-known product price.
  const quickView=!fullProduct&&currentPriceRow?{
    resourceId:item.id,quality:item.quality,fetchedAt:currentPriceRow.fetchedAt||priceData.updatedAt||null,
    vwap,qualities:allPriceRows.filter(r=>Number(r?.resourceId)===item.id).map(r=>({resourceId:Number(r.resourceId),quality:Number(r.quality),price:marketNumeric(r.price),lastTrade:r.lastTrade||null,vwap:marketNumeric(r.vwap)??cachedMarketVwap(activeStore,r.resourceId,r.quality)})),
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
  const activeStore=s?.realmStores?.[`realm:${realm}`]||s||{};
  const {fullProduct,currentPriceRow,vwap,selected}=resolveLiveMarketProductView(activeStore,s,item);
  const liveStatus=$('#marketLiveStatus'),liveUpdated=$('#marketLiveUpdated'),realmEl=$('#marketSiteRealm');
  if(realmEl)realmEl.textContent=realm===1?'R2':'R1';
  if(liveStatus)liveStatus.textContent=selected?.fetchedAt?'Live':'Waiting';
  if(liveUpdated)liveUpdated.textContent=selected?.fetchedAt?`Updated ${marketDate(selected.fetchedAt)}`:'Waiting for market data…';
  const snap=selected?.selected||{};
  const candle=marketSnapshotCandle(selected);
  const cost=Number.isFinite(item.cost)?item.cost:null;
  const plannerDiscount=plannerDiscountPercent(plannerUiState(s).discount);
  const discountInput=$('#marketContractDiscount');
  if(discountInput){discountInput.max='10';discountInput.value=String(plannerDiscount);}
  const discount=plannerDiscount;
  const currentMarketPrice=marketNumeric(selected?.selected?.price)??marketNumeric(currentPriceRow?.price)??cachedMarketPrice(activeStore,item.id,item.quality);const contract=currentMarketPrice==null?null:roundCurrencyUp(currentMarketPrice*(1-discount/100));
  const qualityRows=Array.isArray(selected?.qualities)?selected.qualities:[];
  const info=resourceInfo(item,s),src=(s.resourceImageCache?.[String(item.id)]||s.resourceImageData?.[String(item.id)]||info.imageCandidates?.[0]||'');
  const img=src?`<img class="market-resource-icon" src="${escapeHtml(src)}" alt="">`:'';
  const change=marketNumeric(candle.open)!=null&&candle.open!==0&&marketNumeric(candle.close)!=null?(candle.close-candle.open)/candle.open*100:null;
  const tableRows=qualityRows.map(q=>{const price=marketNumeric(q.price),qv=marketNumeric(q.vwap)??cachedMarketVwap(activeStore,item.id,q.quality);const discounted=price==null?null:roundCurrencyUp(price*(1-discount/100));return `<tr><td>Q${q.quality}</td><td><strong>${marketMoney(price)}</strong>${qv!=null?`<small class="market-inline-vwap">VWAP ${marketMoney(qv)}</small>`:''}</td><td>${marketMoney(discounted)}</td><td>${marketDate(q.lastTrade)}</td></tr>`;}).join('')||'<tr><td colspan="4">Waiting for exchange data…</td></tr>';
  const candles=Array.isArray(selected?.selected?.candles)?selected.selected.candles.slice(-36):[];
  const volume=marketNumeric(snap.volume)??marketNumeric(snap.candleVolume)??marketNumeric(selected?.volume)??marketNumeric(selected?.raw?.summary?.fiveMinutesCandlestick?.volume)??marketNumeric(selected?.raw?.summary?.volume);
  host.innerHTML=`<div class="market-product-head"><div class="market-product-title">${img}<div><h2>${escapeHtml(item.name)} Q${item.quality}</h2><p>${num(item.qty)} units in warehouse · Your cost ${cost==null?'—':money(cost)}</p></div></div><span class="market-follow">★</span></div><div class="market-primary-grid"><div class="market-primary-price"><small>LAST TRADE / MARKET PRICE</small><strong>${marketMoney(snap.price??currentPriceRow?.price)}</strong><span>${change==null?'':`${change>=0?'+':''}${change.toFixed(2)}%`} · Last trade ${marketDate(snap.lastTrade??currentPriceRow?.lastTrade)}</span></div><div class="market-primary-stat"><span>Volume</span><strong>${volume==null?'—':num(volume)}</strong><small>${escapeHtml(selected?.volumePeriod||'Current market')}</small></div><div class="market-primary-stat"><span>VWAP</span><strong>${marketMoney(vwap)}</strong><small>${contract==null?'':`Contract ${money(contract)} at ${discount.toFixed(1)}% off`}</small></div></div><div class="market-five"><div><strong>5 minutes</strong><span>Open ${marketMoney(candle.open)}</span><span>Close ${marketMoney(candle.close)}</span><span>Range ${marketMoney(candle.low)} – ${marketMoney(candle.high)}</span><span>Volume ${candle.volume==null?'—':num(candle.volume)}</span></div></div><div class="market-contract-table"><div class="market-contract-table-head"><strong>EXCHANGE / CONTRACT DATA</strong><span>Discount ${discount.toFixed(1)}%</span></div><div class="table-wrap"><table class="mobile-cards"><thead><tr><th>QUALITY</th><th>MARKET DATA</th><th>CONTRACT PRICE</th><th>LAST TRADE</th></tr></thead><tbody>${tableRows}</tbody></table></div></div><div class="market-candle-wrap"><div class="market-candle-head"><strong>MARKET CHART</strong><span>${candles.length?`${candles.length} recent candles`:'Waiting for chart data'}</span></div><div id="marketLiveCandleChart" class="market-live-candle-chart">${renderLiveCandleChart(candles)}</div></div><div class="market-product-footer"><span>Live SimcoTools market data</span><span>${selected?.fetchedAt?`Updated ${marketDate(selected.fetchedAt)}`:'Waiting for update…'}</span></div>`;
  if(!select.dataset.bound){
    select.addEventListener('change',()=>{__selectedMarketKey=select.value;const [id,q]=select.value.split(':').map(Number);const currentRealm=marketRealmFromState(window.__scmState);if(Number.isFinite(id)&&Number.isFinite(q)&&currentRealm!=null)requestLiveMarketProduct(currentRealm,id,q,true);if(window.__scmState)renderLiveMarketProduct(window.__scmState);});
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
    $('#marketRefreshNow')?.addEventListener('click',()=>{const currentRealm=marketRealmFromState(window.__scmState);if(currentRealm!=null){requestLiveMarketRefresh(currentRealm,true);const [id,q]=String(__selectedMarketKey).split(':').map(Number);if(Number.isFinite(id)&&Number.isFinite(q))requestLiveMarketProduct(currentRealm,id,q,true);}});
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
function normalizedKey(v){return String(v??'').toLowerCase().replace(/[^a-z0-9]/g,'');}
function findNormalizedNumeric(root,aliases){
  const wanted=new Set(aliases.map(normalizedKey)); const seen=new Set();
  const walk=v=>{
    if(v==null||typeof v!=='object'||seen.has(v))return null;seen.add(v);
    if(Array.isArray(v)){for(const item of v){const r=walk(item);if(r!=null)return r;}return null;}
    for(const [k,x] of Object.entries(v)){
      if(wanted.has(normalizedKey(k))){const n=numericValue(x);if(n!==null)return n;const nested=pickNumericDeep(x,['value','amount','total','result','percent','percentage']);if(nested!==null)return nested;}
    }
    const label=pick(v,['name','label','title','metric','description','type','code']);
    if(typeof label==='string'&&wanted.has(normalizedKey(label))){const n=pickNumericDeep(v,['value','amount','total','result','percent','percentage','ratio']);if(n!==null)return n;}
    for(const x of Object.values(v)){const r=walk(x);if(r!=null)return r;}
    return null;
  };
  return walk(root);
}
function gameEmployeeCount(a,s){
  const roots=[s?.companyData,s?.gameState,a?.source?.pf,a?.source?.income,a?.source?.bs,a?.source?.cf];
  for(const root of roots){
    const v=findNormalizedNumeric(root,['employees','employeecount','numberofemployees','staffcount','workers','workercount']);
    if(Number.isFinite(v)&&v>0)return v;
    const list=findNestedObject(root,['employees','staff','workers']);
    if(Array.isArray(list)&&list.length)return list.length;
  }
  return null;
}

function accountingComparisonBase(a){
  // Only the game's own completed-day history and cash-flow ledger are used. The old
  // "last value this dashboard saw" baseline could equal the current figures (or be
  // empty) and produced fake +100% / $0 changes, so it is no longer used here.
  const p=a?.previousPeriod||null;
  if(p&&a?.sourceType!=='income-statement'&&p.cashIn!=null)return {...p,revenue:p.cashIn};
  return p;
}
function accountingHistoryTable(history){
  const rows=(Array.isArray(history)?history:[]).filter(r=>r.profit!=null||r.assets!=null).slice(-8).reverse();
  if(!rows.length)return '<p class="muted">No daily history captured yet. Open Accounting in the game once, then Sync.</p>';
  const d=t=>new Date(t).toLocaleDateString(undefined,{month:'short',day:'numeric'});
  const tone=v=>v==null?'':(v>=0?'positive':'negative');
  const field=(label,v,cls=false)=>`<div class="acct-day-field"><span>${label}</span><strong class="${cls?tone(v):''}">${v==null?'—':money(v)}</strong></div>`;
  // v2.5.350 one collapsible card per day; collapsed shows the day and its profit (right).
  const key=r=>{const t=new Date(r.t);return Number.isFinite(t.getTime())?t.toISOString().slice(0,10):String(r.t);};
  return `<div class="acct-day-list">${rows.map(r=>`<div class="acct-day" data-collapse="acctday:${escapeHtml(key(r))}" data-collapse-default="closed"><div class="acct-day-head" data-collapse-head><span>${escapeHtml(d(r.t))}</span><strong class="${tone(r.profit)}">${r.profit==null?'—':money(r.profit)}</strong></div><div class="acct-day-body">${field('Sales',r.sales)}${field('Expenses',r.expenses)}${field('Profit',r.profit,true)}${field('Cash',r.cash)}${field('Inventory',r.inventory)}${field('Total assets',r.assets)}<div class="acct-day-field"><span>Rank</span><strong>${r.rank==null?'—':'#'+Number(r.rank).toLocaleString()}</strong></div></div></div>`).join('')}</div><p class="muted">From the game's past-finances history (one row per completed day). Sales and expenses are summed from the captured cash-flow ledger; a dash means the ledger does not reach back that far or is missing entries (checked against today's statement).</p>`;
}
function accountingOverview(a,previous){
  const cards=[['Cash','cash',a.cash],['Revenue','revenue',a.revenue],['Expenses','expenses',a.expenses],['Profit','profit',a.profit],['Total Assets','assets',a.assets],['Liabilities','liabilities',a.liabilities],['Inventory','inventory',a.inventory],['Current Assets','currentAssets',a.currentAssets],['Current Liabilities','currentLiabilities',a.currentLiabilities]];
  const changeInfo=(value,old)=>{
    const v=value==null||value===''?NaN:Number(value),p=old==null||old===''?NaN:Number(old);
    if(!Number.isFinite(v)) return `<div class="finance-change neutral-change"><span class="finance-change-arrow">—</span><div class="finance-change-values"><strong>—</strong><small>N/A</small></div></div>`;
    if(!Number.isFinite(p)) return `<div class="finance-change neutral-change"><span class="finance-change-arrow">·</span><div class="finance-change-values"><small>No earlier figure captured</small></div></div>`;
    const delta=roundCurrencyUp(v-p), pct=p!==0?(delta/p)*100:null;
    if(delta===0) return `<div class="finance-change neutral-change"><span class="finance-change-arrow">—</span><div class="finance-change-values"><strong>$0</strong><small>0.00%</small></div></div>`;
    const up=delta>0;
    return `<div class="finance-change ${up?'change-up':'change-down'}"><span class="finance-change-arrow">${up?'↑':'↓'}</span><div class="finance-change-values"><strong>${delta>0?'+':''}${money(delta)}</strong><small>${pct==null?'N/A':`${pct>0?'+':''}${pct.toFixed(2)}%`}</small></div></div>`;
  };
  const basis=previous?.date?`<p class="muted finance-basis">Changes compare with the day ending ${escapeHtml(new Date(previous.date).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}))} (game history).</p>`:'';
  return basis+`<div class="finance-card-grid">${cards.map(([label,key,value])=>`<div class="finance-card"><span class="finance-label">${escapeHtml(label)}</span><div class="finance-value">${value==null?'—':money(value)}</div>${changeInfo(value,previous?.[key])}</div>`).join('')}</div>`;
}

function renderFullSyncDiagnostics(s){
  // Diagnostic rendering must never be able to break the main dashboard render.
  // Keep all helpers local to this diagnostic pass and derive them from the same
  // realm-scoped endpoint store used by the data cards.
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

  // Existing warehouse cost diagnostic (kept intact, but safely scoped).
  const d=s.fullSyncDiagnostics&&typeof s.fullSyncDiagnostics==='object'?s.fullSyncDiagnostics:{};
  const costEl=document.querySelector('#warehouseCostDiagnostics');
  if(costEl){
    const rows=Array.isArray(d.warehouseCosts)?d.warehouseCosts:[];
    if(!rows.length){
      costEl.innerHTML='<p class="muted">No diagnostic captured yet. Run Sync.</p>';
    }else{
      const html=rows.map(e=>{const f=e.fields||{};const v=k=>(f[k]===null||f[k]===undefined)?'—':JSON.stringify(f[k]);const name=resourceInfo({kind:e.resourceId},s).name||('Resource #'+e.resourceId);return `<tr><td>${escapeHtml(name)}</td><td>${e.resourceId}</td><td>${e.quality}</td><td>${escapeHtml(e.source||'')}</td><td>${v('quantity')}</td><td>${v('cost')}</td><td>${v('sourcingCost')}</td><td>${v('totalCost')}</td><td>${v('unitCost')}</td><td>${v('averageCost')}</td></tr>`}).join('');
      const detailMap=Number.isFinite(realm)?(s.warehouseCostDetails||{}):{};
      const detailRows=Object.values(detailMap).flatMap(v=>Array.isArray(v)?v:[]);
      const detailHtml=detailRows.length?`<h4>Captured from game sourcing-cost screen</h4><div class="table-wrap"><table class="statement-table"><thead><tr><th>Resource</th><th>Quality</th><th>Qty</th><th>Unit cost</th><th>Captured</th></tr></thead><tbody>${detailRows.map(e=>`<tr><td>${escapeHtml(resourceInfo({kind:e.resourceId},s).name||('#'+e.resourceId))}</td><td>${e.quality==null?'—':e.quality}</td><td>${e.quantity==null?'—':num(e.quantity)}</td><td>${money(e.unitCost)}</td><td>${escapeHtml(e.capturedAt||'')}</td></tr>`).join('')}</tbody></table></div>`:'';
      const rawWarehouse=JSON.stringify(rows,null,2);
      costEl.innerHTML=detailHtml+`<div class="table-wrap"><table class="statement-table"><thead><tr><th>Resource</th><th>ID</th><th>Quality</th><th>Source</th><th>Qty</th><th>cost</th><th>sourcingCost</th><th>totalCost</th><th>unitCost</th><th>averageCost</th></tr></thead><tbody>${html}</tbody></table></div><details><summary>Raw diagnostic JSON</summary><pre>${escapeHtml(rawWarehouse.slice(0,50000))}</pre></details>`;
    }
  }

  const wr=warehouseRows(s);
  const costRealm=Number.isFinite(realm)?(s.warehouseCostDetails||{}):{};
  const costDetails=Object.values(costRealm).flatMap(v=>Array.isArray(v)?v:[]);
  const wKeys=matches(/\/api\/v(?:2|3)\/(?:resources|warehouse|warehouse-resources)(?:\/|$)/i);
  const wMissing=wr.filter(r=>r._unitCost==null).length;
  card('warehousePageDiagnostics',wKeys.length||costDetails.length?'CAPTURED':'WAITING',`${wr.length} rows · ${costDetails.length} sourcing-cost captures · ${wMissing} rows without cost`,wKeys,'warehouse-page');
  const warehouseDiagEl=document.querySelector('#warehousePageDiagnostics');
  if(warehouseDiagEl){
    const vw=s.vwapData||{};
    // Only show a timestamp when a complete SimcoTools dataset is actually
    // stored. Do not fall back to the status object, because that can retain
    // an old timestamp after the dataset itself was lost or a refresh failed.
    const vwapUpdated=(Array.isArray(vw.rows)&&vw.rows.length)?(vw.updatedAt||vw.fetchedAt):null;
    const vwapCount=Array.isArray(vw.rows)?vw.rows.length:Number(vw.count)||0;
    const vwapStamp=vwapUpdated?new Date(vwapUpdated):null;
    const vwapStampText=vwapStamp&&Number.isFinite(vwapStamp.getTime())
      ? vwapStamp.toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})
      : 'Not updated yet';
    warehouseDiagEl.insertAdjacentHTML('beforeend',`<div class="diag-vwap-update"><strong>SimcoTools VWAP data updated:</strong> ${escapeHtml(vwapStampText)}${vwapCount?` · ${vwapCount.toLocaleString()} total values`:''}</div>`);
  }

  const a=accounting(s);
  const snap=s.accountingSnapshots||{};
  const rollover=(a?.source?.cf?.isComputed===false || a?.source?.income?.isComputed===false) && Number(a?.revenue)===0 && Number(a?.profit)===0;
  const display=rollover&&snap?.current?{...a,revenue:snap.current.revenue??a.revenue,expenses:snap.current.expenses??a.expenses,profit:snap.current.profit??a.profit,period:snap.period||a.period}:a;
  const aKeys=matches(/accounting|balance-sheet|cash-flow|cashflow|profit|income-statement|financial/i);
  const aFields=['cash','revenue','expenses','profit','assets','liabilities','inventory'].filter(k=>display[k]!=null).length;
  const accountingCapture=s.accountingCapture&&typeof s.accountingCapture==='object'?s.accountingCapture:{};
  const accountingSourcePaths=[
    '/api/v2/companies/me/cashflow-statement/',
    '/api/v2/companies/me/income-statement/',
    '/api/v2/companies/me/balance-sheet/',
    '/api/v2/companies/me/past-finances-overview/',
    '/api/v2/companies/me/cashflow/recent/',
    '/api/v2/companies/me/administration-overhead/',
    '/api/v3/companies/me/past-finances/'
  ];
  const accountingSourceCount=accountingSourcePaths.filter(path=>accountingCapture[path]?.data!=null).length;
  const accountingComplete=accountingSourceCount===accountingSourcePaths.length;
  const accountingStatus=accountingComplete?'CAPTURED':(accountingSourceCount?'PARTIAL':'NO ACCOUNTING RESPONSE');
  card('accountingPageDiagnostics',accountingStatus,`${accountingSourceCount}/${accountingSourcePaths.length} Accounting sources · ${aFields}/7 core financial fields · revenue ${display.revenue==null?'—':money(display.revenue)} · profit ${display.profit==null?'—':money(display.profit)}`,aKeys,'accounting-page');

  const cRows=currentContracts(s);
  const cKeys=matches(/contracts-(?:incoming|outgoing)|warehouse-contracts-summary|contracts-history-(?:incoming|outgoing)/i);
  const ci=cRows.filter(c=>c.direction==='Incoming').length, co=cRows.filter(c=>c.direction==='Outgoing').length;
  card('contractsPageDiagnostics',cKeys.length?'CAPTURED':'WAITING',`${cRows.length} current contracts · ${ci} incoming · ${co} outgoing`,cKeys,'contracts-page');

  const vRows=Array.isArray(s.vwapData?.rows)?s.vwapData.rows.length:0;
  const vKeys=matches(/market|orders|orderbook|vwap/i);
  const hCount=Object.keys(s.history||{}).length;
  card('marketPageDiagnostics',vRows||vKeys.length?'CAPTURED':'WAITING',`${vRows||Object.keys(s.vwapData||{}).length} VWAP values · ${hCount} history series`,vKeys,'market-page');

  // Overview diagnostic: this is the authoritative high-level view of the
  // current realm's sync transaction. It is deliberately derived from the same
  // endpointData/fullSyncDiagnostics objects that feed the individual cards.
  const walk=Array.isArray(d.walkResults)?d.walkResults:[];
  const captured=walk.filter(x=>x?.ok).length;
  const endpointCount=endpointEntries.filter(([,v])=>Number(v?.status)>=200&&Number(v?.status)<300&&v?.data!=null).length;
  const syncStatus=String(s.syncStatus||d.status||'WAITING');
  const overview=document.querySelector('#overviewSyncDiagnostics');
  if(overview){
    const target=Number.isFinite(realm)?`${realmDisplayNumber(realm)} - ${realmName(realm).replace(/^R\d+ - /,'')}`:'No realm selected';
    const error=s.syncError||d.error||'';
    overview.innerHTML=`<div class="overview-diag-grid"><div class="diag-stat"><span>Realm</span><strong>${escapeHtml(target)}</strong></div><div class="diag-stat"><span>Sync status</span><strong>${escapeHtml(syncStatus)}</strong></div><div class="diag-stat"><span>Game pages</span><strong>${walk.length?`${captured}/${walk.length}`:'Not started'}</strong></div><div class="diag-stat"><span>Successful API responses</span><strong>${endpointCount}</strong></div></div><div class="overview-diag-foot">${error?`<span class="diag-error">${escapeHtml(error)}</span>`:`Raw API responses are being stored inside ${escapeHtml(Number.isFinite(realm)?`realm:${realm}`:'the selected realm')} and are used by the page cards.`}</div>`;
  }
}


let scmRecipesCache=null;
async function loadBuildingPlannerData(){
  // v2.5.345 recipe inputs/transport and building outputs follow the game's constants (scmGameConstants) when
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
function plannerResourceMap(rows){const m=new Map();for(const r of rows||[]){const id=Number(r.id);if(Number.isFinite(id)&&id>0){m.set(id,r);const n=plannerNormalizeName(r.name);if(n)m.set(n,r);}}return m;}
function plannerRecipeMap(recipes){const m=new Map();for(const r of recipes||[]){m.set(Number(r.id),r);m.set(plannerNormalizeName(r.name),r);}return m;}
function plannerProductionEvents(s){
  const out=[];
  const sources=[s?.endpointData?.['/api/v2/companies/me/cashflow/recent/'],s?.accountingCapture?.['/api/v2/companies/me/cashflow/recent/']];
  for(const entry of sources){
    const rows=entry?.data?.data;
    if(!Array.isArray(rows)) continue;
    for(const e of rows){
      if(e?.category==='p' && e?.details?.amount!=null) out.push(e);
    }
  }
  return out;
}
function plannerStoredProductionPlan(s,building){
  const id=Number(building?.id??building?.raw?.id);
  const plan=s?.productionPlans?.[String(id)];
  return plan&&String(plan.product||'').trim()?plan:null;
}
function plannerProductionSnapshotKey(building,product,s){
  const b=building?.raw||building||{};
  const busy=b?.busy||{};
  const plan=plannerStoredProductionPlan(s,building);
  // The frozen realm plan owns the product/resource identity. Live busy data
  // may advance, disappear, or change between renders and must not select a
  // different rate snapshot for the same frozen plan.
  const rid=Number(plan?.resourceId??busy?.resource?.kind??busy?.resource?.resourceId);
  return `${Number(b?.id)}|${Number(rid)||0}|${String(product||'').toLowerCase().replace(/\s+/g,' ').trim()}`;
}
function plannerCompanyAuthData(s){
  const direct=s?.authData?.authCompany;
  if(direct&&typeof direct==='object') return direct;
  const ep=s?.endpointData||{};
  const viewRealm=Number(s?.viewRealm); const entries=Object.entries(ep).filter(([url,v])=>/\/api\/v3\/companies\/auth-data\/?$/i.test(url)&&Number(v?.status)===200&&v?.data!=null&&(!Number.isFinite(viewRealm)||validRealmNumber(v?.captureRealm)==null||validRealmNumber(v?.captureRealm)===viewRealm));
  entries.sort((a,b)=>Date.parse(b[1]?.receivedAt||'')-Date.parse(a[1]?.receivedAt||''));
  const data=entries[0]?.[1]?.data;
  return data?.authCompany||data?.company||data||null;
}
function plannerCompanyProductionModifier(s){
  const modifier=Number(plannerCompanyAuthData(s)?.productionModifier);
  return Number.isFinite(modifier)?Math.max(-99,Math.min(99,modifier)):0;
}
function plannerCompanySalesModifier(s){
  const modifier=Number(plannerCompanyAuthData(s)?.salesModifier);
  return Number.isFinite(modifier)?Math.max(-99,Math.min(99,modifier)):null;
}
// v2.5.341 game formula (bundle tSe): rate = base × event / (1 − bonus/100), e.g. 8% → ÷0.92 = ×1.08696.
function plannerCompanyProductionFactor(s){
  const m=plannerCompanyProductionModifier(s);return m<100?1/(1-m/100):0;
}
function plannerCaptureProductionRateSnapshot(building,product,baseRatePerLevel,observedRatePerHour,eventModifier,source,s){
  if(!chrome?.runtime?.id||!Number.isFinite(Number(baseRatePerLevel))||Number(baseRatePerLevel)<=0)return;
  const key=plannerProductionSnapshotKey(building,product,s);
  if(s?.productionRateSnapshots?.[key])return;
  const b=building?.raw||building||{};
  const busy=b?.busy||{};
  const rid=Number(busy?.resource?.kind??busy?.resource?.resourceId);
  const realm=Number(s?.viewRealm??s?.captureRealm??s?.authData?.authCompany?.realmId);
  if(!Number.isFinite(realm)||!Number.isFinite(rid)||rid<=0)return;
  try{chrome.runtime.sendMessage({type:'CAPTURE_PRODUCTION_RATE_SNAPSHOT',realm,buildingId:Number(b?.id),resourceId:rid,started:busy?.started,product,baseRatePerLevel:Number(baseRatePerLevel),observedRatePerHour:Number(observedRatePerHour)||null,eventModifier:Number(eventModifier)||0,companyProductionModifier:plannerCompanyProductionModifier(s),companyModifierNormalized:true,source});}catch{}
}

// v2.5.343 abundance % of a natural resource at a building (mines, oil rigs, quarries), from the game's
// /api/v2/companies/buildings/<id>/abundance/ — only resources the game lists there have one.
function plannerAbundancePct(s,buildingId,resourceId){const d=s?.endpointData?.[`/api/v2/companies/buildings/${Number(buildingId)}/abundance/`]?.data?.abundance;const v=Number(d?.[String(resourceId)]);return d&&Number.isFinite(v)?v:null;}
function plannerEconomyNow(s){const log=Array.isArray(s?.economyStateLog)?s.economyStateLog:[];const a=Number(s?.authData?.temporals?.economyState);return log.length?Number(log[log.length-1].s):(Number.isFinite(a)?a:null);}
function plannerRate(name,recipes,rates,s){
  const target=plannerNormalizeName(name);
  // v2.5.342 game constants: exact base rate for the current economy phase.
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
  // v2.5.361 flattened once per captured catalog/endpoint objects (was per call).
  const fk=s?.endpointData&&typeof s.endpointData==='object'?s.endpointData:null;let fm=fk?__scmFlatMemo.get(fk):null;
  if(!fm||fm.c!==s?.resourceCatalog){fm={c:s?.resourceCatalog,objects:flattenObjects(s?.resourceCatalog||{}).concat(flattenObjects(s?.endpointData||{}))};if(fk)__scmFlatMemo.set(fk,fm);}
  const objects=fm.objects;
  for(const o of objects){
    if(!o||typeof o!=='object')continue;
    const n=pick(o,['name','resourceName','displayName','title','label']);
    if(plannerNormalizeName(n)!==target)continue;
    for(const key of ['producedAnHour','producedPerHour','productionPerHour','productionRate','amountPerHour','unitsPerHour','ratePerHour']){
      const v=Number(o[key]);if(Number.isFinite(v)&&v>0)return {rate:v,source:'captured game data'};
    }
  }
  return {rate:null,source:'not available'};
}
function plannerProductionModifierRows(s){
  const endpoints=Object.entries(s?.endpointData||{}).filter(([url,value])=>
    /\/api\/v2\/production-modifiers\/\d+\//i.test(url)&&
    Number(value?.status)===200&&Array.isArray(value?.data?.resourceProductionModifiers)
  );
  const viewRealm=Number(s?.viewRealm??s?.captureRealm);
  const matching=endpoints.filter(([,value])=>!Number.isFinite(viewRealm)||!Number.isFinite(Number(value?.captureRealm))||Number(value.captureRealm)===viewRealm);
  matching.sort((a,b)=>Date.parse(String(b[1]?.receivedAt||''))-Date.parse(String(a[1]?.receivedAt||'')));
  return matching.length?matching[0][1].data.resourceProductionModifiers:[];
}
function plannerActiveProductionEvent(s,product,recipes,resourceId){
  const recipe=(Array.isArray(recipes)?recipes:[]).find(r=>plannerNormalizeName(r?.name)===plannerNormalizeName(product));
  const id=Number(resourceId??recipe?.id);
  return globalThis.SCMPlannerCore?.activeResourceProductionModifier
    ?globalThis.SCMPlannerCore.activeResourceProductionModifier(plannerProductionModifierRows(s),id,Date.now()):0;
}
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
  const currentCycle=globalThis.SCMPlannerCore?.observedProductionRatePerHour?globalThis.SCMPlannerCore.observedProductionRatePerHour(raw,plannerHistoryRowsForCurrentCycle(raw,name,endpoint?.data),building?.level):null;
  const key=plannerHistoryAuditKey(realm,id,name); const prior=plannerHistoryAudit.get(key)||{};
  plannerHistoryAudit.set(key,{realm:Number.isFinite(realm)?realm:null,buildingId:id,buildingName:String(building?.name||raw?.name||''),product:String(name||''),resourceId:Number(busy?.resource?.kind??busy?.resource?.resourceId)||null,cycleStarted:String(busy?.started||''),historyEndpointPresent:!!endpoint,historyHttpStatus:Number(endpoint?.status)||null,historyCaptureRealm:validRealmNumber(endpoint?.captureRealm),matchedCurrentCycle:!!(currentCycle?.rate>0),matchedAmount:currentCycle?.amount??null,matchedDurationSeconds:currentCycle?.duration??null,selectedRateSource:details.source??prior.selectedRateSource??null,fallbackReason:details.fallbackReason??prior.fallbackReason??null,historyRequestStatus:prior.historyRequestStatus??'not-requested',historyRequestAt:prior.historyRequestAt??null,lastEvaluatedAt:new Date().toISOString()});
}
function plannerSetHistoryRequestAudit(realm,buildingId,product,status,error=null){
  const key=plannerHistoryAuditKey(realm,buildingId,product); const prior=plannerHistoryAudit.get(key)||{realm,buildingId:Number(buildingId),product:String(product||'')};
  plannerHistoryAudit.set(key,{...prior,historyRequestStatus:status,historyRequestError:error?String(error).slice(0,240):null,historyRequestAt:new Date().toISOString()});
}
// Prefer an output amount from the exact live cycle. That rate already includes
// the game's current company and resource modifiers, so it must not be modified
// a second time. Only normalized base rates and static reference rates need
// current modifiers applied when no exact cycle measurement is available.
function plannerHistoryRowsForCurrentCycle(building,product,historyRows){
  const raw=building?.raw||building||{},busy=busyObject(raw)||raw?.busy||{};
  const started=Date.parse(String(busy?.started||''));
  const currentName=plannerNormalizeName(busy?.resource?.name||product||'');
  const resourceId=Number(busy?.resource?.kind??busy?.resource?.resourceId);
  if(!Number.isFinite(started)||!Number.isFinite(Number(busy?.duration))||Number(busy.duration)<=0)return [];
  return (Array.isArray(historyRows)?historyRows:[]).filter(row=>{
    const when=Date.parse(String(row?.datetime||'')),amount=Number(row?.outputAmount??row?.amount);
    if(!Number.isFinite(when)||Math.abs(when-started)>5000||!Number.isFinite(amount)||amount<=0)return false;
    const rowName=plannerNormalizeName(row?.resourceName||row?.name||'');
    if(currentName&&rowName&&rowName!==currentName)return false;
    const rowId=Number(row?.kind);
    const rowQuality=Number(row?.quality),currentQuality=Number(busy?.resource?.quality);
    if(Number.isFinite(rowQuality)&&Number.isFinite(currentQuality)&&rowQuality!==currentQuality)return false;
    return Number.isFinite(resourceId)&&resourceId>0?rowId===resourceId:Boolean(currentName&&rowName===currentName);
  });
}
function plannerRateForProduct(name,building,level,recipes,rates,s){
  const raw=building?.raw||building||{};
  const busy=busyObject(raw)||raw?.busy||{};
  const currentProduct=String(busy?.resource?.name||'').trim();
  const finish=(result,fallbackReason=null)=>{plannerRecordHistoryAudit(building,name,s,{source:result?.source||'unknown',fallbackReason});return result;};
  const isCurrentProduct=Boolean(currentProduct)&&plannerNormalizeName(currentProduct)===plannerNormalizeName(name);
  const history=s?.endpointData?.[`/api/v2/companies/buildings/${Number(raw?.id??building?.id)}/history/`];
  const cycle=isCurrentProduct&&globalThis.SCMPlannerCore?.observedProductionRatePerHour
    ?globalThis.SCMPlannerCore.observedProductionRatePerHour(raw,plannerHistoryRowsForCurrentCycle(raw,name,history?.data),level):null;
  if(cycle?.rate>0)return finish({rate:cycle.rate,source:'exact current-cycle production history'},null);

  // The snapshot's observed rate is the measured rate for its recorded cycle,
  // including modifiers. Reuse it only when that cycle still matches; never
  // multiply it by modifiers again or reuse a prior cycle's observed rate.
  const snapshot=s?.productionRateSnapshots?.[plannerProductionSnapshotKey(building,name,s)];
  const currentStarted=String(busy?.started||'');
  const currentLevel=Number(building?.level||raw?.size||1);
  if(isCurrentProduct&&snapshot&&currentStarted&&String(snapshot?.started||'')===currentStarted&&
     plannerNormalizeName(snapshot?.product)===plannerNormalizeName(name)&&
     Number(snapshot?.observedRatePerHour)>0&&currentLevel>0){
    return finish({rate:Number(snapshot.observedRatePerHour)*Math.max(1,Number(level)||1)/currentLevel,source:'matching current-cycle rate snapshot'},'current history row unavailable; matching-cycle snapshot used');
  }

  // Last-resort measured rate from the active cycle itself. The amount and
  // duration belong to the current busy resource, so only accept them when the
  // product matches and both values are finite and positive. This measurement
  // already reflects game modifiers; do not apply modifiers a second time.
  if(isCurrentProduct){
    const cycleAmount=Number(busy?.resource?.amount);
    const cycleDuration=Number(busy?.duration);
    if(Number.isFinite(cycleAmount)&&cycleAmount>0&&Number.isFinite(cycleDuration)&&cycleDuration>0){
      const scale=Math.max(1,Number(level)||1)/Math.max(1,Number(building?.level||raw?.size)||1);
      const measuredRate=cycleAmount*3600/cycleDuration*scale;
      if(Number.isFinite(measuredRate)&&measuredRate>0)
        return finish({rate:measuredRate,source:'active cycle amount ÷ duration (measured game rate)'},'history and matching-cycle snapshot unavailable; active cycle amount/duration used');
    }
  }

  if(isCurrentProduct)for(const root of [busy,raw]){
    if(!root||typeof root!=='object')continue;
    for(const key of ['producedPerHour','producedAnHour','productionPerHour','productionRatePerHour','productionRate','ratePerHour','outputPerHour','unitsPerHour','amountPerHour']){
      const n=Number(root[key]);
      if(Number.isFinite(n)&&n>0){
        const scale=Math.max(1,Number(level)||1)/Math.max(1,Number(building?.level||raw?.size)||1);
        return finish({rate:n*scale,source:'captured game production rate'},'no matching history row or matching-cycle snapshot; captured game rate used');
      }
    }
  }

  const recipe=(Array.isArray(recipes)?recipes:[]).find(r=>plannerNormalizeName(r?.name)===plannerNormalizeName(name));
  const resourceId=Number(busy?.resource?.kind??busy?.resource?.resourceId??recipe?.id);
  const eventModifier=plannerActiveProductionEvent(s,name,recipes,resourceId);
  const eventFactor=1+eventModifier/100;
  const companyModifier=plannerCompanyProductionModifier(s);
  const companyFactor=plannerCompanyProductionFactor(s);
  if(eventFactor<=0||companyFactor<=0)return finish({rate:null,source:'invalid production modifier'},'modifier factor was non-positive');
  const base=plannerRate(name,recipes,rates,s);
  if(Number.isFinite(Number(base?.rate))&&Number(base.rate)>0)
    {const ab=plannerAbundancePct(s,raw?.id??building?.id,recipe?.id??resourceId);if(ab!=null)return finish({rate:Number(base.rate)*level*eventFactor*companyFactor*ab/100,source:`${base.source} fallback × game modifiers × abundance ${ab.toFixed(1)}%`},'reference rate with the building abundance');}
    return finish({rate:Number(base.rate)*level*eventFactor*companyFactor,source:`${base.source} fallback × game modifiers`},'no matching current-cycle history or usable live rate; reference rate used');
  return finish(base,base?.rate>0?'no matching current-cycle history or usable live rate; reference rate used':'no usable current-cycle history, snapshot, live rate or reference rate');
}
function plannerAssetUrl(image){
  const candidates=imageCandidates(image).filter(candidate=>!RESOURCE_IMAGE_404_FILENAMES.has(String(candidate).split("/").pop().split("?")[0]));
  return candidates[0]||'';
}
function plannerResourceImage(id,s){
  const info=resourceInfo({kind:Number(id)},s);
  if(!info.imageCandidates.length && Number.isFinite(Number(id))) requestResourceImage(Number(id));
  return info.imageCandidates[0]||'';
}
function plannerImage(src,alt,cls='planner-icon'){
  return src?`<img class="${cls}" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" data-scm-hide-on-error="1">`:`<span class="${cls} planner-icon-fallback">•</span>`;
}
function plannerResourceNameById(recipes,id,s){
  const r=(recipes||[]).find(x=>Number(x.id)===Number(id));
  if(r?.name)return r.name;
  return resourceName({_id:Number(id),kind:Number(id)},s);
}
function plannerMoney(v){return v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?money(Number(v)):'—';}
function ownedPlannerBuildings(s, definitions){
  const actual=buildingArrayFromState(s);
  const byKind=new Map((definitions||[]).map(b=>[String(b.id),b]));
  return actual.map((raw,index)=>{
    const kind=String(pick(raw,['kind','buildingKind','type'])??'');
    const def=byKind.get(kind)||null;
    const levelRaw=Number(pick(raw,['level','lvl','buildingLevel','size']));
    const level=Number.isFinite(levelRaw)&&levelRaw>0?Math.min(20,levelRaw):1;
    const name=buildingName(raw,s);
    const category=def?.category || (String(pick(raw,['category'])||'').toLowerCase()==='other'?'Other':'Uncategorized');
    const produces=Array.isArray(def?.produces)?def.produces:[];
    const pinned=pick(raw,['pinnedResource']);
    const specialization=pick(raw,['robotsSpecialization']);
    const busy=raw?.busy?.resource||null;
    const idKey=String(pick(raw,['id','buildingId'])??index);
    const frozenPlan=s?.frozenNetworkPlan?.buildingPlans?.[idKey]||null;
    const plan=frozenPlan||s?.productionPlans?.[idKey]||null;
    const currentResource=busy?.name||plan?.product||null;
    const currentResourceId=Number.isFinite(Number(busy?.kind))?Number(busy.kind):Number.isFinite(Number(plan?.resourceId))?Number(plan.resourceId):null;
    const pinnedResource=Number.isFinite(Number(pinned))?Number(pinned):null;
    const robotsSpecialization=Number.isFinite(Number(specialization))?Number(specialization):null;
    const currentQuality=Number.isFinite(Number(busy?.quality))?Number(busy.quality):Number.isFinite(Number(plan?.quality))?Number(plan.quality):null;
    return {raw,index,id:pick(raw,['id','buildingId'])??index,kind,name,category,level,produces,pinnedResource,currentResource,currentResourceId,robotsSpecialization,currentQuality,productionPlan:plan||null};
  });
}
function plannerCurrentProduct(building, recipes){
  const frozen=building?.productionPlan||null;const produces=Array.isArray(building?.produces)?building.produces:[];const findByName=name=>{if(!name)return null;return produces.find(p=>plannerNormalizeName(p)===plannerNormalizeName(name))||null;};const frozenProduct=findByName(frozen?.product);if(frozenProduct)return frozenProduct;const liveByName=findByName(building?.currentResource);if(liveByName)return liveByName;const recipeById=new Map((recipes||[]).map(r=>[Number(r.id),r]));const byId=id=>{const n=Number(id);if(!Number.isFinite(n))return null;return findByName(recipeById.get(n)?.name);};for(const id of [building?.currentResourceId,building?.pinnedResource,building?.robotsSpecialization]){const p=byId(id);if(p)return p;}return produces[0]||'';}
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
function plannerProductionNetwork(s, owned, recipes, rates, runHours, overrides={}){
  const selectedId=overrides?.buildingId!=null?String(overrides.buildingId):null;const planningLevels=(overrides?.planningLevels&&typeof overrides.planningLevels==='object')?overrides.planningLevels:{};const frozenPlans=(overrides?.planState&&typeof overrides.planState==='object')?overrides.planState:(s?.frozenNetworkPlan?.buildingPlans||{});const networkHours=Math.max(1,Number(runHours)||24);const activeBuildings=[];const specs=[];const recipeBy=plannerRecipeMap(recipes);
  for(const b of Array.isArray(owned)?owned:[]){const isSelected=selectedId!=null&&String(b.id)===selectedId;const stored=frozenPlans?.[String(b.id)]||plannerStoredProductionPlan(s,b)||null;const frozenProduct=String(stored?.product||b.currentResource||'').trim();const product=isSelected?String(overrides.product||frozenProduct||'').trim():frozenProduct;if(!product)continue;const frozenQuality=Number.isFinite(Number(stored?.quality))?Math.max(0,Number(stored.quality)):Math.max(0,Number(b.currentQuality)||0);const quality=isSelected?Math.max(0,Number(overrides.quality)||0):frozenQuality;const plannedLevel=Math.min(20,Math.max(1,Number(planningLevels[String(b.id)])||Number(stored?.plannedLevel)||Number(b.level)||1));const level=isSelected?Math.min(20,Math.max(1,Number(overrides.level)||plannedLevel)):plannedLevel;const rateInfo=plannerRateForProduct(product,b,level,recipes,rates,s);const rate=Number(rateInfo?.rate);const recipe=recipeBy.get(plannerNormalizeName(product));const outputId=Number(recipe?.id);if(!Number.isFinite(rate)||rate<=0||!Number.isFinite(outputId)||!recipe){activeBuildings.push({building:b,product,quality,level,rate:null,outputRun:null,source:rateInfo?.source||'not available',inputs:[]});continue;}const outputRun=rate*networkHours;const inputs=(recipe.materials||[]).map(m=>{const id=Number(m.id),perOutput=Number(m.quantity)||0,required=outputRun*perOutput,minQuality=Math.max(0,quality-1);return {id,name:plannerResourceNameById(recipes,id,s),required,minQuality};});activeBuildings.push({building:b,product,quality,level,rate,outputRun,source:rateInfo?.source||'unknown',inputs});specs.push({buildingId:Number(b.id),product,productId:outputId,quality,level,ratePerHour:rate,recipe});}
  const resourceNames=new Map((recipes||[]).map(r=>[String(r.id),r.name]));const core=globalThis.SCMPlannerCore?.productionBalance?globalThis.SCMPlannerCore.productionBalance(specs,recipeBy,networkHours,resourceNames):{resources:[],deficits:[],surpluses:[],productionRows:[],demandRows:[]};return {activeBuildings,resources:core.resources,deficits:core.deficits,surpluses:core.surpluses,productionRows:core.productionRows,demandRows:core.demandRows,activeSpecs:specs,hours:networkHours};
}
// v2.5.345 the game's own upgrade cost (GamePages bundle: amount = perCostUnit × building costUnits × current level,
// per level step). costUnits comes from /api/v2/constants/buildings/; perCostUnit is the game client's table
// (not served by any API). baseQty × cost ÷ 10350 is the old estimate, kept only when the constants are missing.
const CONSTRUCTION_MATERIALS=[
  {id:101,name:'Reinforced concrete',perCostUnit:4,baseQty:12,referencePrice:166.66},
  {id:102,name:'Bricks',perCostUnit:55,baseQty:165,referencePrice:2.16},
  {id:108,name:'Planks',perCostUnit:16,baseQty:48,referencePrice:9.08},
  {id:111,name:'Construction units',perCostUnit:1,baseQty:3,referencePrice:2501.71}
];
function constructionCostUnits(s,building){const k=String(building?.raw?.kind??building?.kind??'');const cu=Number(s?.gameConstants?.buildings?.[k]?.costUnits);return k&&cu>0?cu:null;}
function constructionWarehouseStock(s,id){
  return warehouseRows(s).filter(row=>Number(row?._id)===Number(id)).reduce((sum,row)=>sum+(Number(row?._qty)||0),0);
}
function constructionMaterialPlan(s,building,currentLevel,targetLevel,discount,vwapMap){
  const current=Math.min(20,Math.max(1,Number(currentLevel)||1));
  const target=Math.min(20,Math.max(1,Number(targetLevel)||current));
  if(target<=current) return {current,target,stepFactor:0,items:[],deficitItems:[],totalCost:0};
  const costUnits=constructionCostUnits(s,building);
  const baseCost=Number(building?.raw?.cost);
  if(costUnits==null&&(!Number.isFinite(baseCost)||baseCost<=0)) return {current,target,stepFactor:0,items:[],deficitItems:[],totalCost:0,unavailable:true};
  const stepFactor=((target-current)*(current+target-1))/2;
  const scale=costUnits!=null?null:baseCost/10350;
  const map=vwapMap instanceof Map?vwapMap:buildMarketPriceMap(s);
  const items=CONSTRUCTION_MATERIALS.map(mat=>{
    const required=roundResourceDown(costUnits!=null?mat.perCostUnit*costUnits*stepFactor:mat.baseQty*scale*stepFactor,3);
    // Warehouse coverage is quality-agnostic. Every stored unit counts toward
    // the construction requirement regardless of its quality level. Keep ALL
    // required material rows here so multi-building aggregation can sum the
    // full requirement before warehouse stock is applied once.
    const warehouseQty=constructionWarehouseStock(s,mat.id);
    const amount=Math.max(0,roundResourceDown(required-warehouseQty,3));
    const marketPrice=exactMarketPrice(map,mat.id,0);
    const rawPrice=marketPrice!=null?Number(marketPrice):null;
    const pct=globalThis.SCMPlannerCore?.clampDiscount?globalThis.SCMPlannerCore.clampDiscount(discount):Math.min(10,Math.max(0,Number(discount)||0));
    const price=globalThis.SCMPlannerCore?.discountedUnitPrice?globalThis.SCMPlannerCore.discountedUnitPrice(rawPrice,pct):roundCurrencyUp(rawPrice*(1-pct/100));
    const lineTotal=Number.isFinite(price)?roundCurrencyUp(price*amount):null;
    return {...mat,required,warehouseQty,amount,quality:0,marketPrice,price,lineTotal};
  });
  const deficitItems=items.filter(x=>x.amount>0);
  const totalCost=roundCurrencyUp(deficitItems.reduce((sum,x)=>sum+(Number(x.lineTotal)||0),0));
  return {current,target,stepFactor,items,deficitItems,totalCost,costUnits,source:costUnits!=null?'game-constants':'cost-estimate'};
}
function renderConstructionMaterialText(s,plan,building,discount){
  const displayItems=Array.isArray(plan.deficitItems)?plan.deficitItems:(plan.items||[]).filter(x=>x.amount>0);
  if(plan.unavailable){
    return {plain:'Construction material data unavailable for this building.',html:'<div class="planner-copy-empty">Construction material data unavailable for this building.</div>'};
  }
  if(!displayItems.length){
    const text=`No additional construction materials required at Level ${plan.current}.`;
    return {plain:text,html:`<div class="planner-copy-empty">${escapeHtml(text)}</div>`};
  }
  const pct=globalThis.SCMPlannerCore?.clampDiscount?globalThis.SCMPlannerCore.clampDiscount(discount):Math.min(10,Math.max(0,Number(discount)||0));
  const rows=displayItems.map((x,i)=>{
    const code=`:re-${Number(x.id)}:`;
    const unit=x.price!=null?money(x.price):'—';
    const line=x.lineTotal!=null?money(x.lineTotal):'—';
    const plain=`${num(x.amount)}-Q${x.quality}-${x.name}-${code}-${unit} @ ${pct}% off-${line}`;
    return {plain,html:`<div class="planner-copy-line"><span>${escapeHtml(plain)}</span></div>`};
  });
  const totalLine=`Total material cost - ${money(plan.totalCost)}`;
  return {plain:`${rows.map(r=>r.plain).join('\n')}\n${totalLine}`,html:`${rows.map(r=>r.html).join('')}<div class="planner-copy-total"><strong>${escapeHtml(totalLine)}</strong></div>`};
}
function plannerDiscountPercent(value){return globalThis.SCMPlannerCore?.clampDiscount?globalThis.SCMPlannerCore.clampDiscount(value):Math.min(10,Math.max(0,Number(value)||0));}
function plannerExactVwap(s,id,quality,vwapMap){const map=vwapMap instanceof Map?vwapMap:buildMarketPriceMap(s);return globalThis.SCMPlannerCore?.exactVwap?globalThis.SCMPlannerCore.exactVwap(map,id,quality):null;}
function plannerDiscountQuote(s,x,type,discount,marketPriceMap){const q=qualityForPlannerResource(x,type);const amount=type==='deficit'?Number(x.deficit)||0:Number(x.surplus)||0;const reference=marketPriceReference(marketPriceMap instanceof Map?marketPriceMap:buildMarketPriceMap(s),x.id,q);const marketPrice=reference?.price??null;const pct=plannerDiscountPercent(discount);const unitPrice=marketPrice!=null?roundCurrencyUp(marketPrice*(1-pct/100)):null;const total=unitPrice!=null&&amount>0?roundCurrencyUp(unitPrice*amount):null;return {id:Number(x.id),name:x.name,quality:q,amount,marketPrice,marketPriceQuality:reference?.quality??null,marketPriceExact:reference?.exact??false,discount:pct,unitPrice,total,type,key:`${Number(x.id)}:${Number(q)}`};}
function qualityForPlannerResource(x,type){if(Number.isFinite(Number(x?.quality)))return Number(x.quality);if(type==='deficit'){const qs=Array.isArray(x?.minQuality)?x.minQuality.map(Number).filter(Number.isFinite):[];return qs.length?Math.max(...qs):0;}const qs=(x?.productionByQuality||[]).map(v=>Number(v?.quality)).filter(Number.isFinite);return qs.length?Math.max(...qs):0;}
function discountedMarketValue(marketPrice,amount,discount){const p=plannerDiscountPercent(discount);const v=Number(marketPrice),q=Number(amount);return Number.isFinite(v)&&v>0&&Number.isFinite(q)&&q>0?roundCurrencyUp(roundCurrencyUp(v*(1-p/100))*q):null;}
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
const plannerHistoryFetchPending=new Set();
function requestPlannerBuildingHistory(building,s){
  const realm=Number(s?.viewRealm);
  const id=Number(building?.id);
  const product=String(building?.currentResource||'').trim();
  if(!Number.isFinite(realm)||!Number.isFinite(id)||id<=0||!product||!building?.raw?.busy)return;
  const path=`/api/v2/companies/buildings/${id}/history/`;
  const endpoint=s?.endpointData?.[path];
  const endpointRealm=validRealmNumber(endpoint?.captureRealm);
  const sameRealm=endpointRealm==null||endpointRealm===realm;
  const currentCycle=endpoint&&sameRealm&&globalThis.SCMPlannerCore?.observedProductionRatePerHour
    ?globalThis.SCMPlannerCore.observedProductionRatePerHour(building.raw,plannerHistoryRowsForCurrentCycle(building.raw,product,endpoint.data),building.level):null;
  if(endpoint&&Number(endpoint.status)>=200&&Number(endpoint.status)<300&&currentCycle?.rate>0){plannerSetHistoryRequestAudit(realm,id,product,'not-needed-current-cycle-matched');return;}
  const key=`${realm}:${id}`;
  if(plannerHistoryFetchPending.has(key)){plannerSetHistoryRequestAudit(realm,id,product,'deduplicated-in-flight');return;}
  plannerHistoryFetchPending.add(key); plannerSetHistoryRequestAudit(realm,id,product,'requested');
  Promise.resolve().then(()=>chrome.runtime.sendMessage({type:'FETCH_BUILDING_HISTORY',realm,buildingId:id}))
    .then(result=>plannerSetHistoryRequestAudit(realm,id,product,result?.ok?'success':(result?.skipped?'skipped':'failed'),result?.error||null))
    .catch(error=>plannerSetHistoryRequestAudit(realm,id,product,'failed',error?.message||String(error)))
    .finally(()=>plannerHistoryFetchPending.delete(key));
}
function showBuildingUpgradeProjection(host,ctx){
  const existing=document.getElementById('scm-upgrade-projection');
  if(existing) existing.remove();
  const {building,plan,discount,vwapMap}=ctx||{};
  if(!building||!plan)return;
  const current=Number(plan.current)||Number(building.level)||1;
  const target=Number(plan.target)||current;
  const scale=Number(building?.raw?.cost)/10350;
  const costUnits=Number(plan.costUnits)>0?Number(plan.costUnits):null;
  const materials=CONSTRUCTION_MATERIALS.map(mat=>{
    // v2.5.345 same game formula as constructionMaterialPlan (costUnits from the game's constants).
    const required=roundResourceDown(costUnits!=null?mat.perCostUnit*costUnits*Number(plan.stepFactor||0):Number(mat.baseQty)*scale*Number(plan.stepFactor||0),3);
    const warehouse=constructionWarehouseStock(ctx.state,mat.id);
    const buy=Math.max(0,roundResourceDown(required-warehouse,3));
    const item=plan.items.find(x=>Number(x.id)===Number(mat.id));
    const marketPrice=item?.marketPrice!=null?Number(item.marketPrice):exactMarketPrice(vwapMap,mat.id,0);
    const pct=globalThis.SCMPlannerCore?.clampDiscount?globalThis.SCMPlannerCore.clampDiscount(discount):Math.min(10,Math.max(0,Number(discount)||0));
    const price=marketPrice!=null&&Number.isFinite(marketPrice)?roundCurrencyUp(marketPrice*(1-pct/100)):null;
    return {...mat,required,warehouse,buy,marketPrice,price,lineTotal:Number.isFinite(price)?roundCurrencyUp(price*buy):null};
  });
  const buyRows=materials.filter(x=>x.buy>0);
  const total=roundCurrencyUp(buyRows.reduce((a,x)=>a+(Number(x.lineTotal)||0),0));
  const esc2=escapeHtml;
  const num2=v=>Number.isFinite(Number(v))?Number(v).toLocaleString(undefined,{maximumFractionDigits:0}):'—';
  const money2=v=>Number.isFinite(Number(v))?money(Number(v)):'—';
  const buyText=buyRows.length?`==============================\n🔽🔽🔽 BUYING -${Math.min(10,Math.max(0,Number(discount)||0))}% MARKET 🔽🔽🔽\n\n${buyRows.map(x=>`➡️ ${num2(x.buy)} - ${x.name} :re-${Number(x.id)}: - ${money2(x.price)}`).join('\n')}\n\n==============================`:'==============================\nNo additional construction materials required.\n==============================' ;
  const overlay=document.createElement('div');overlay.id='scm-upgrade-projection';overlay.className='scm-upgrade-projection';overlay.innerHTML=`<div class="scm-upgrade-backdrop" data-close-upgrade></div><section class="scm-upgrade-dialog" role="dialog" aria-modal="true" aria-label="Building upgrade projection"><header class="scm-upgrade-head"><div><div class="scm-upgrade-kicker">BUILDING UPGRADE PROJECTION</div><h3>${esc2(building.name||'Building')}</h3><div class="scm-upgrade-level">Current Level: ${current} <span>→</span> Upgrade to Level ${target}</div></div><button type="button" class="scm-upgrade-close" data-close-upgrade aria-label="Close">×</button></header><div class="scm-upgrade-rule"></div><div class="scm-upgrade-grid"><div class="scm-upgrade-panel"><div class="scm-upgrade-label">Level Change</div><strong>${current} → ${target}</strong><small>Construction projection for this building</small></div><div class="scm-upgrade-panel"><div class="scm-upgrade-label">Estimated Material Cost</div><strong id="scm-upgrade-total">${money2(total)}</strong><small>Buying ${Math.min(10,Math.max(0,Number(discount)||0))}% below Market Price</small></div></div><div class="scm-upgrade-section"><div class="scm-upgrade-section-title">Materials Needed</div><div class="scm-upgrade-materials">${materials.map(x=>`<div class="scm-upgrade-row"><span>➡️ ${num2(x.required)} - ${esc2(x.name)} :re-${Number(x.id)}:</span><strong>${num2(x.required)}</strong></div>`).join('')}</div></div><div class="scm-upgrade-section"><div class="scm-upgrade-section-title">Warehouse Coverage</div><div class="scm-upgrade-materials">${materials.map(x=>`<div class="scm-upgrade-row"><span>${esc2(x.name)}</span><strong>${num2(Math.min(x.warehouse,x.required))} / ${num2(x.required)} ${x.warehouse>=x.required?'✓':''}</strong></div>`).join('')}</div></div><div class="scm-upgrade-section"><div class="scm-upgrade-section-title">Remaining to Buy</div><div class="scm-upgrade-materials">${buyRows.length?buyRows.map(x=>`<div class="scm-upgrade-row"><span>➡️ ${num2(x.buy)} - ${esc2(x.name)} :re-${Number(x.id)}: - ${money2(x.price)}</span><strong>${money2(x.lineTotal)}</strong></div>`).join(''):'<div class="scm-upgrade-empty">Warehouse covers all required construction materials.</div>'}</div></div><div class="scm-upgrade-rule"></div><div class="scm-upgrade-actions"><button type="button" class="planner-copy-btn" data-copy-upgrade>📋 Copy Buy Message</button><button type="button" class="planner-copy-btn" data-close-upgrade>Close</button></div></section>`;
  document.body.appendChild(overlay);
  const close=()=>overlay.remove();
  overlay.querySelectorAll('[data-close-upgrade]').forEach(x=>x.addEventListener('click',close));
  overlay.querySelector('[data-copy-upgrade]')?.addEventListener('click',async()=>{
    try{await navigator.clipboard.writeText(buyText);const b=overlay.querySelector('[data-copy-upgrade]');if(b){const old=b.textContent;b.textContent='✓ Copied';setTimeout(()=>b.textContent=old,1200);}}catch{}
  });
}


// v2.5.323 Profit / h / level inside the building card. Uses the card's own data: the measured
// production/hour for the planning level, the recipe's per-unit inputs at the input quality the card
// shows (production quality − 1), and current market prices (VWAP when no market price is captured).
const PLANNER_PROFIT_KEY='scmPlannerProfitSettingsV1';
const __plannerProfitLast={};
function plannerProfitSettings(){let v={};try{v=JSON.parse(localStorage.getItem(PLANNER_PROFIT_KEY)||'{}')||{};}catch{}return {inputSource:'warehouse',sellMode:'exchange',exchangeFeePct:'',contractDiscountPct:0,adminOverheadPct:'',wages:{},...v,wages:{...(v.wages||{})}};}
function savePlannerProfitSettings(v){try{localStorage.setItem(PLANNER_PROFIT_KEY,JSON.stringify(v));}catch{}}
// v2.5.324 price resolvers that match the game's own Profit Calculator.
// Market: the captured exchange order book first (cheapest listing at the exact quality when selling,
// at that quality or better when buying inputs), then captured current market prices, then VWAP.
// Warehouse: your actual sourcing cost per unit for the lowest stocked quality that satisfies the input.
function plannerAge(ms){const m=Math.round(ms/60000);return m<1?'just now':m<60?`${m} min ago`:m<1440?`${Math.round(m/60)} h ago`:`${Math.round(m/1440)} d ago`;}
function plannerMarketPrice(s,map,id,q,mode){
  id=Number(id);q=Number(q);
  const realm=validRealmNumber(s?.viewRealm??s?.captureRealm??s?.authData?.authCompany?.realmId);
  const ep=realm!=null?s?.endpointData?.[`/api/v3/market/${realm}/${id}/`]:null;
  const at=Date.parse(String(ep?.receivedAt||''));
  if(Array.isArray(ep?.data)&&Number.isFinite(at)&&Date.now()-at<6*3600000){
    const ok=ep.data.filter(r=>Number(r?.price)>0&&Number.isFinite(Number(r?.quality))&&(mode==='sell'?Number(r.quality)===q:(mode==='buy-any'||mode==='sell-any')?true:Number(r.quality)>=q));
    if(ok.length){const best=ok.reduce((a,b)=>Number(b.price)<Number(a.price)?b:a);return {price:Number(best.price),quality:Number(best.quality),source:mode==='sell-any'?`cheapest exchange listing, any quality (as game) · ${plannerAge(Date.now()-at)}`:`exchange listing · ${plannerAge(Date.now()-at)}`};}
  }
  if(mode==='sell-any'&&map instanceof Map){
    let best=null;for(const [k,v] of map){const mm=String(k).match(/^(\d+):(\d+)$/);if(mm&&Number(mm[1])===id&&Number(v)>0&&(!best||Number(v)<best.price))best={price:Number(v),quality:Number(mm[2])};}
    if(best){const row=(Array.isArray(s?.liveMarketPriceData?.rows)?s.liveMarketPriceData.rows:[]).find(r=>Number(r?.resourceId)===id&&Number(r?.quality)===best.quality);const t=Date.parse(String(row?.fetchedAt||s?.liveMarketPriceData?.updatedAt||''));return {...best,source:`SimcoTools, cheapest captured quality${Number.isFinite(t)?` · ${plannerAge(Date.now()-t)}`:''} — open the game to load the exchange`};}
  }
  if(map instanceof Map){
    if(map.has(`${id}:${q}`)){const row=(Array.isArray(s?.liveMarketPriceData?.rows)?s.liveMarketPriceData.rows:[]).find(r=>Number(r?.resourceId)===id&&Number(r?.quality)===q);const t=Date.parse(String(row?.fetchedAt||s?.liveMarketPriceData?.updatedAt||''));return {price:Number(map.get(`${id}:${q}`)),quality:q,source:`SimcoTools current price${Number.isFinite(t)?` · ${plannerAge(Date.now()-t)}`:''}`};}
    if(mode!=='sell'){let best=null;for(const [k,v] of map){const m=String(k).match(/^(\d+):(\d+)$/);if(m&&Number(m[1])===id&&(mode==='buy-any'||Number(m[2])>=q)&&Number(v)>0&&(!best||Number(v)<best.price))best={price:Number(v),quality:Number(m[2]),source:'market'};}if(best)return best;}
  }
  const rows=Array.isArray(s?.vwapData?.rows)?s.vwapData.rows:[];
  const v=rows.find(r=>Number(r?.resourceId)===id&&Number(r?.quality)===q&&Number(r?.value)>0);
  if(v)return {price:Number(v.value),quality:q,source:'VWAP'};
  return null;
}
function plannerWarehouseCost(s,id,minQ){
  let rows=[];try{rows=warehouseRows(s);}catch{}
  const lots=rows.filter(r=>Number(r?._id)===Number(id)&&Number(r?._quality)>=Number(minQ)&&Number(r?._qty)>0).sort((a,b)=>Number(a._quality)-Number(b._quality));
  for(const r of lots){let c=null;try{c=warehouseAlertUnitCost(s,r);}catch{c=r._unitCost;}if(Number.isFinite(Number(c))&&Number(c)>=0)return {price:Math.round(Number(c)*100)/100,quality:Number(r._quality),source:`warehouse · ${num(r._qty)} in stock`};}
  return null;
}
function plannerProfitWageKey(building){return String(building?.raw?.kind||building?.kind||building?.category||building?.name||'building');}
// v2.5.324 Labour and admin come from the game's own cost records, never hard-coded:
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
// v2.5.332 ask the background for a fresh exchange order book (through the game tab) when the stored one is older
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
// v2.5.338 economy phase for the profit card. The running batch keeps the phase it started in; the game's
// Profit Calculator uses the current phase. Wage per hour per level does not change with the phase, so labour
// per unit = wage ÷ units per hour (game: 67.82 × 6.613 = 73.94 × 6.066 = 448.5 $/h/level).
const PLANNER_PHASE_RATE_KEY='scmPlannerPhaseRateV1',PLANNER_WAGE_KEY='scmPlannerWageV1';
function plannerLocalGet(k){try{return JSON.parse(localStorage.getItem(k)||'{}')||{};}catch{return {};}}
function plannerLocalPut(k,v){try{localStorage.setItem(k,JSON.stringify(v));}catch{}}
function plannerEconomy(ctx){
  const C=globalThis.SCM_TOOLS_CORE,log=Array.isArray(ctx.s?.economyStateLog)?ctx.s.economyStateLog:[];
  const authSt=Number(ctx.s?.authData?.temporals?.economyState);
  const current=log.length?Number(log[log.length-1].s):(Number.isFinite(authSt)?authSt:null);
  let batch=ctx.rateFromBatch&&ctx.batchStarted&&C?.economyStateAt?C.economyStateAt(log,ctx.batchStarted):null;
  // 2.5.340 batch started before the log's first entry: phase unknown. If the economy is normal now and the
  // batch's measured rate is far from the normal rate, it was produced in another phase.
  if(!batch&&ctx.rateFromBatch&&current===1&&C?.batchPhaseFromRate){const v=C.batchPhaseFromRate(Number(ctx.outputPerHour),ctx.referenceRate);if(v&&v.differs)batch={state:'other',inferred:true,diffPct:v.diffPct};}
  const realm=plannerRealmOf(ctx.s),level=Math.max(1,Number(ctx.level)||1),measured=Number(ctx.outputPerHour);
  const rates=plannerLocalGet(PLANNER_PHASE_RATE_KEY);
  if(batch&&!batch.inferred&&realm!=null&&measured>0){rates[`${realm}:${ctx.productId}:${batch.state}`]={perLevel:measured/level,at:ctx.batchStarted};plannerLocalPut(PLANNER_PHASE_RATE_KEY,rates);}
  const known=current!=null?rates[`${realm}:${ctx.productId}:${current}`]:null;
  // v2.5.342 game constants: rate = the game's own formula for the current phase (what its Profit Calculator uses);
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
// v2.5.341 current admin overhead exactly as the game computes it: captured base (/administration-overhead/) and
// executives, plus the game page's executive timing config (scmGameConfig). Null when anything is missing.
function plannerGameAdmin(s){
  try{
    const C=globalThis.SCM_TOOLS_CORE,ep=s?.endpointData||{},cfg=s?.gameConfig||{};
    const base=Number(ep['/api/v2/companies/me/administration-overhead/']?.data);
    const exKey=Object.keys(ep).find(k=>/^\/api\/v3\/companies\/\d+\/executives\/$/.test(k));
    const ex=exKey?ep[exKey]?.data?.executives:null;
    const r=C?.effectiveAdminOverhead?C.effectiveAdminOverhead({base,executives:ex,buildings:s?.buildings,trainS:cfg.executivesTimeToTrainS,settleS:cfg.executivesTimeToSettleInS}):null;
    return r?{...r,at:ep[exKey]?.receivedAt||null}:null;
  }catch{return null;}
}
function renderPlannerProfit(host){
  const ctx=host.__plannerProfitCtx,el=host.querySelector('#plannerProfit'),C=globalThis.SCM_TOOLS_CORE;
  if(!ctx||!el||!C)return;
  const cfg=plannerProfitSettings(),wageKey=plannerProfitWageKey(ctx.building);
  const lotAdmin=plannerAdminOverheadFromLots(ctx.s),gameAdmin=plannerGameAdmin(ctx.s),salesFee=plannerExchangeFeeFromSales(ctx.s);
  const autoAdmin=gameAdmin?gameAdmin.pct:lotAdmin?.pct;
  const fld=(id,label,value,extra='')=>`<label>${label}<input id="${id}" type="number" step="any" inputmode="decimal" value="${escapeHtml(value??'')}" ${extra}></label>`;
  el.innerHTML=`<div class="planner-profit-controls"><label>Inputs<select id="ppInputSource"><option value="warehouse"${cfg.inputSource!=='market'&&cfg.inputSource!=='market-any'?' selected':''}>Warehouse cost</option><option value="market-any"${cfg.inputSource==='market-any'?' selected':''}>Market · cheapest any Q (as game)</option><option value="market"${cfg.inputSource==='market'?' selected':''}>Market · required Q or better</option></select></label><label>Sell via<select id="ppSellMode"><option value="exchange"${cfg.sellMode==='exchange'?' selected':''}>Exchange</option><option value="contract"${cfg.sellMode==='contract'?' selected':''}>Contract</option></select></label>${cfg.sellMode==='exchange'?fld('ppFee','Exchange fee %',cfg.exchangeFeePct??'',`placeholder="${salesFee?salesFee.pct.toFixed(2):'4'} auto"`):fld('ppDiscount','Contract discount %',cfg.contractDiscountPct)}${fld('ppOverhead','Admin overhead %',cfg.adminOverheadPct??'',`placeholder="${autoAdmin!=null?autoAdmin.toFixed(2):'0'} auto"`)}${fld('ppWage','Wages $/h/level (override)',cfg.wages[wageKey]??'','placeholder="auto"')}</div><div class="pp-hint">Blank = auto from your data: fee ${salesFee?`${salesFee.pct.toFixed(2)}% from your exchange sales`:'4% default (no exchange sale captured yet)'} · admin ${gameAdmin?`${gameAdmin.pct.toFixed(2)}% (${gameAdmin.basePct.toFixed(2)}% − ${gameAdmin.reductionPct.toFixed(2)}% executives, as the game)`:lotAdmin?`${lotAdmin.pct.toFixed(2)}% from your latest batch (open the game once to load the executives calculation)`:'0% (no batch captured yet)'} · labour from your produced batches. Type a value to override.</div><div id="plannerProfitResults"></div>`;
  const results=()=>{
    const c=plannerProfitSettings();
    const setNum=v=>v!==''&&v!=null&&Number.isFinite(Number(v));
    const overhead=setNum(c.adminOverheadPct)?Number(c.adminOverheadPct):(autoAdmin??0);
    const listFee=C.listingFeePct?C.listingFeePct(ctx.s?.marketOrders?.orders):null;const feePct=setNum(c.exchangeFeePct)?Number(c.exchangeFeePct):(salesFee?.pct??(listFee!=null?Math.round(listFee*100)/100:4));
    const productId=Number(ctx.productId);
    const sale=Number.isFinite(productId)?plannerMarketPrice(ctx.s,ctx.priceMap,productId,ctx.quality,'sell-any'):null;
    plannerRequestOrderBook(ctx,host,productId);
    const transport=plannerMarketPrice(ctx.s,ctx.priceMap,13,0,'buy');
    const isMarket=c.inputSource==='market'||c.inputSource==='market-any';
    // v2.5.348 warehouse inputs as the game: cheapest lot of that resource, any quality, Σ cost ÷ amount, not rounded
    // (Water Q0 $0.347, not the Q1 lot $0.37); not in the warehouse → cheapest listing of any quality, as the game.
    const lotsAll=plannerWarehouseLots(ctx.s);
    const inputs=(ctx.plannedInputs||[]).map(x=>{let p=null;if(!isMarket&&C.warehouseUnitCostAsGame){const w=C.warehouseUnitCostAsGame(lotsAll,x.id);if(w)p={price:w.unitCost,quality:w.quality,lot:true,source:`warehouse, cheapest lot (as game) · ${num(w.amount)} in stock`};}if(!p){p=plannerMarketPrice(ctx.s,ctx.priceMap,x.id,x.minQuality,c.inputSource==='market'?'buy':'buy-any');if(p&&!isMarket)p={...p,source:`${p.source} (not in warehouse)`};}return {id:x.id,name:x.name,quality:x.minQuality,qtyPerUnit:Number(x.perOutput)||0,unitPrice:p?.price??null,priceQuality:p?.quality??null,lot:Boolean(p?.lot),source:p?.source||null};});
    const wageOverride=setNum(c.wages?.[wageKey])?Number(c.wages[wageKey]):null;
    let lab=wageOverride==null&&Number.isFinite(productId)?plannerLabourFromLots(ctx.s,productId,ctx.quality):null;
    const eco=plannerEconomy(ctx),lvl=Math.max(1,Number(ctx.level)||1),ownUnitsPerHour=eco.rate||ctx.outputPerHour;
    // v2.5.348 the game's Profit Calculator rates mine/oil/quarry resources at a fixed 90 % abundance (Minerals
    // 116.641/h/level, not your mine's 129.6); the card uses the same rate. Your own abundance is shown in a note.
    const calcRate=C.isAbundanceResource?.(productId)&&eco.current!=null&&C.gameProfitCalcRatePerLevel?C.gameProfitCalcRatePerLevel(ctx.s?.gameConstants,productId,eco.current,{eventPct:ctx.eventPct||0,bonusPct:ctx.bonusPct||0}):null;
    const unitsPerHour=calcRate>0?calcRate*lvl:ownUnitsPerHour;
    // v2.5.342 game wage from constants (AVERAGE_SALARY × salaryModifier × 0.97 with robots) when available.
    const gWage=wageOverride==null&&C.gameWagePerLevel?C.gameWagePerLevel(ctx.s?.gameConstants,ctx.buildingKind,ctx.robots):null;
    let wage=null;
    if(gWage>0&&unitsPerHour>0){lab={quality:ctx.quality,at:null,cached:false,boughtUnits:0,...(lab||{}),workersPerUnit:gWage/(unitsPerHour/Math.max(1,Number(ctx.level)||1)),game:true};wage={wage:gWage,fresh:false,game:true};}
    else{wage=lab?plannerWage(ctx,lab):null;
    // Labour per unit follows the projected rate (wage per hour is phase-independent).
    if(lab&&wage&&unitsPerHour>0&&(eco.changed||!wage.fresh))lab.workersPerUnit=wage.wage/(unitsPerHour/Math.max(1,Number(ctx.level)||1));}
    // Worker and admin cost shown in cents (as the game shows them)...
    const r2=v=>Math.round(v*100)/100;const wPU=lab?r2(lab.workersPerUnit):null,aPU=lab?r2(wPU*overhead/100):null;
    // ...but v2.5.348 the game's profit uses them unrounded (Power: $0.19787, not $0.20 → $151.04 / h / level).
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
    if(!r.ok){out.innerHTML=`<div class="planner-profit-empty">${escapeHtml(sale?r.error:`No market or VWAP price captured for ${ctx.product||'this product'} Q${ctx.quality} yet.`)}</div>`;try{renderPlannerInsights(host);}catch(e){console.error('Smart insights render failed',e);}return;}
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
    const abundanceNote=calcRate>0?`<div class="pp-basis pp-economy">The game's calculator assumes ${num(C.GAME_PROFIT_CALC_ABUNDANCE_PCT)}% abundance (${num(+calcRate.toFixed(3))}/h/level), and so does this card. ${own&&own.abundancePct!=null?`Your building at ${num(+own.abundancePct.toFixed(2))}% (${num(+own.ratePerLevel.toFixed(3))}/h/level): ${plannerMoney(own.perLevel)} / h / level, ${plannerMoney(own.netPerLevel)} after ${c.sellMode==='exchange'?'fee':'discount'} &amp; transport.`:`Your building's own abundance isn't captured yet — open the building in the game once.`}</div>`:'';
    // v2.5.343 research progress for this product (/api/v3/players/research/).
    const rs=(Array.isArray(ctx.s?.endpointData?.['/api/v3/players/research/']?.data)?ctx.s.endpointData['/api/v3/players/research/'].data:[]).find(x=>Number(x?.kind)===productId);
    const researchNote=rs?`<div class="pp-basis">Research level Q${num(rs.quality)} · ${num(rs.patents)} / ${num(rs.patentsNeeded)} patents for the next level</div>`:'';
    const sellLabel=c.sellMode==='exchange'?`Exchange fee ${num(+feePct.toFixed(2))}%${!setNum(c.exchangeFeePct)&&salesFee?' (from your sales)':''}`:`Contract discount ${num(c.contractDiscountPct)}%`;
    const busy=ctx.building?.raw?.busy?.resource;
    const batchCost=busy&&Number(busy.kind)===productId&&Number(busy.unitCost)>0?Number(busy.unitCost):null;
    out.innerHTML=`<div class="pp-stats"><div class="pp-stat ${tone(gameUnit)}"><strong>${plannerMoney(perLevel(gameUnit))}</strong><span>Profit / h / level</span></div><div class="pp-stat ${tone(gameUnit)}"><strong>${plannerMoney(gameUnit*r.unitsPerHour)}</strong><span>Profit / h · Level ${ctx.level}</span></div><div class="pp-stat ${tone(gameUnit)}"><strong>${plannerMoney(gameUnit)}</strong><span>Profit / unit</span></div></div>
<div class="pp-basis">Same basis as the game’s Profit Calculator (before market fee &amp; transport).</div>${ecoNote}${abundanceNote}${researchNote}${batchCost!=null?`<div class="pp-batch"><div><strong>$${batchCost.toLocaleString(undefined,{minimumFractionDigits:3,maximumFractionDigits:3})}</strong><span>Cost per unit · running batch (game)</span></div><small>What the game charged for the batch in progress: the inputs it actually consumed when the batch started + labour. “Sourcing cost / unit” below is what a new batch would cost at today’s warehouse costs (the game’s Profit Calculator figure). Difference ${plannerMoney(batchCost-(r.inputCostPerUnit+r.labourPerUnit))}.</small></div>`:''}
<div class="pp-stats pp-stats-net"><div class="pp-stat ${tone(r.profitPerHourPerLevel)}"><strong>${plannerMoney(r.profitPerHourPerLevel)}</strong><span>/ h / level after ${c.sellMode==='exchange'?'fee':'discount'} &amp; transport</span></div><div class="pp-stat ${tone(r.profitPerUnit)}"><strong>${plannerMoney(r.profitPerUnit)}</strong><span>/ unit after ${c.sellMode==='exchange'?'fee':'discount'} &amp; transport</span></div></div>
<div class="pp-list">
${row('Sale price (market, any quality)',plannerMoney(sale.price),`${escapeHtml(sale.source)} · Q${sale.quality} listing`)}
${inputRows}
${row('Labour (incl. admin)',r.labourPerUnit>0?`−${plannerMoney(r.labourPerUnit)}`:'—',labourNote)}
${row('Sourcing cost / unit',plannerMoney(r.inputCostPerUnit+r.labourPerUnit),'inputs + labour','pp-sub')}
${row('Profit / unit (game basis)',plannerMoney(gameUnit),'','pp-total')}
${row(sellLabel,`−${plannerMoney(r.feePerUnit+r.contractDiscountPerUnit)}`)}
${row('Transport',`−${plannerMoney(r.transportPerUnit)}`,`${num(ctx.transportUnits)} units × ${plannerMoney(transport?.price??0)}${c.sellMode==='contract'?' · 50% paid by buyer':''}`)}
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
// v2.5.357 Smart insights under the profit card: (1) best product for this building, (2) input run-out for all
// buildings with a suggested buy, (3) make or buy each input. Same basis as the game's Profit Calculator (tools-core
// gameCalcProduct reproduces the card's $151.04 / $422.05 / $474.45). No new network requests.
function plannerInsightsData(ctx){
  const C=globalThis.SCM_TOOLS_CORE,s=ctx?.s,gc=s?.gameConstants;
  if(!C?.gameCalcProduct||!C.gameConstantsOk?.(gc))return {ok:false,reason:'Game constants not loaded yet — open the Manager again after the next Sync.'};
  const log=Array.isArray(s?.economyStateLog)?s.economyStateLog:[],authSt=Number(s?.authData?.temporals?.economyState);
  const economyState=log.length?Number(log[log.length-1].s):(Number.isFinite(authSt)?authSt:null);
  if(economyState==null)return {ok:false,reason:'Economy phase not captured yet — open the game once.'};
  const cfg=plannerProfitSettings(),setNum=v=>v!==''&&v!=null&&Number.isFinite(Number(v));
  const gameAdmin=plannerGameAdmin(s),lotAdmin=plannerAdminOverheadFromLots(s);
  const adminPct=setNum(cfg.adminOverheadPct)?Number(cfg.adminOverheadPct):(gameAdmin?.pct??lotAdmin?.pct??0);
  const isMarket=cfg.inputSource==='market'||cfg.inputSource==='market-any',lots=plannerWarehouseLots(s),map=ctx.priceMap;
  const inputCostOf=id=>{if(!isMarket){const w=C.warehouseUnitCostAsGame(lots,id);if(w)return w.unitCost;}const p=plannerMarketPrice(s,map,id,0,cfg.inputSource==='market'?'buy':'buy-any');return p?p.price:null;};
  const recipes=Array.isArray(ctx.recipes)?ctx.recipes:[];
  const nameOf=id=>{try{return plannerResourceNameById(recipes,id,s)||`#${id}`;}catch{return `#${id}`;}};
  const eventPctOf=id=>{try{return plannerActiveProductionEvent(s,nameOf(id),recipes,id)||0;}catch{return 0;}};
  return {ok:true,C,s,gc,economyState,adminPct,bonusPct:Number(ctx.bonusPct)||0,inputCostOf,nameOf,eventPctOf,map};
}
function renderPlannerInsights(host){
  const el=host?.querySelector?.('#plannerInsights'),ctx=host?.__plannerProfitCtx;
  if(!el||!ctx)return;
  const d=plannerInsightsData(ctx);
  if(!d.ok){el.innerHTML=`<div class="planner-profit-empty">${escapeHtml(d.reason)}</div>`;return;}
  const {C,s,gc,economyState,adminPct,bonusPct,inputCostOf,nameOf,eventPctOf,map}=d;
  const row=(label,value,note='',cls='')=>`<div class="pp-row ${cls}"><div class="pp-label">${label}${note?`<small>${note}</small>`:''}</div><div class="pp-value">${value}</div></div>`;
  const tone=v=>v>0.0001?'si-good':v<-0.0001?'si-bad':'';
  // (1) Best product for the selected building.
  const kind=String(ctx.buildingKind||''),lvl=Math.max(1,Number(ctx.level)||1);
  const ranked=C.rankBuildingProducts({c:gc,buildingKind:kind,economyState,bonusPct,adminPct,robots:Boolean(ctx.robots),eventPctOf,priceOf:id=>plannerMarketPrice(s,map,id,0,'sell-any'),inputCostOf});
  const curId=Number(ctx.productId),cur=ranked.find(x=>x.resourceId===curId),best=ranked.find(x=>x.profitPerHourPerLevel!=null&&x.complete);
  let verdict='';
  if(best&&cur&&cur.profitPerHourPerLevel!=null&&best.resourceId!==curId){const gain=best.profitPerHourPerLevel-cur.profitPerHourPerLevel,pct=cur.profitPerHourPerLevel>0?gain/cur.profitPerHourPerLevel*100:null;verdict=gain>0.005?`Switching to <b>${escapeHtml(nameOf(best.resourceId))}</b> earns ${plannerMoney(gain*lvl)}/h more at level ${num(lvl)}${pct!=null?` (+${num(+pct.toFixed(1))}%)`:''}.`:'';}
  else if(best&&best.resourceId===curId)verdict=`${escapeHtml(nameOf(curId))} is already the best product for this building.`;
  const priced=ranked.filter(x=>x.profitPerHourPerLevel!=null),unpriced=ranked.filter(x=>x.profitPerHourPerLevel==null);const top=priced.slice(0,5);if(cur&&!top.includes(cur))top.push(cur);
  const srcShort=v=>String(v||'').split(' — ')[0].replace('cheapest exchange listing, any quality (as game)','exchange').replace('SimcoTools, cheapest captured quality','SimcoTools');
  // v2.5.359 #5 profit / h / level in each economy phase (same prices; the game's rate and labour per unit change).
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
// v2.5.359 #7 upgrade payback: construction materials for the next level (constructionMaterialPlan: game costUnits × level,
// valued at the cheapest market price) ÷ the extra level's profit / h (game Profit Calculator basis, own abundance).
function renderPlannerPayback(host,d){
  const el=host?.querySelector?.('#plannerPayback'),ctx=host?.__plannerProfitCtx;
  if(!el||!ctx)return;
  if(!d?.ok){el.innerHTML=`<div class="planner-profit-empty">${escapeHtml(d?.reason||'')}</div>`;return;}
  const {C,s,gc,economyState,adminPct,bonusPct,inputCostOf,nameOf,eventPctOf,map}=d;
  const owned=Array.isArray(ctx.owned)?ctx.owned:[];
  const dur=h=>h==null?'—':h<48?`${num(+h.toFixed(1))} h`:`${num(+(h/24).toFixed(1))} d`;
  const rows=[];
  // v2.5.360 extra admin per hour from one more level: wages of every producing level × (1/170) × (1 − COO%).
  let ga=null;try{ga=plannerGameAdmin(s);}catch{}
  const coo=Number(ga?.coo)||0,dAdmin=C.adminIncreasePerLevel(coo);
  const wageAll=owned.filter(b=>Number(b.currentResourceId)>0).reduce((a,b)=>a+(Number(C.gameWagePerLevel(gc,String(b.kind||''),Boolean(b.robotsSpecialization)))||0)*Math.max(1,Number(b.level)||1),0);
  for(const b of owned){
    const pid=Number(b.currentResourceId),lvl=Math.max(1,Number(b.level)||1);
    if(!(pid>0))continue;
    if(lvl>=20){rows.push({b,lvl,max:true});continue;}
    const bd=Number(gc.buildings?.[String(b.kind||'')]?.buildDuration),upHours=bd>0?lvl*bd/3600:0;
    const extraAdmin=(wageAll+(Number(C.gameWagePerLevel(gc,String(b.kind||''),Boolean(b.robotsSpecialization)))||0))*dAdmin;
    const sale=plannerMarketPrice(s,map,pid,0,'sell-any');
    const res=C.gameCalcProduct({c:gc,resourceId:pid,economyState,eventPct:eventPctOf(pid),bonusPct,adminPct,robots:Boolean(b.robotsSpecialization),salePrice:sale?.price??null,inputCostOf,abundancePct:plannerAbundancePct(s,b.raw?.id??b.id,pid)});
    let plan=null;try{plan=constructionMaterialPlan(s,b,lvl,lvl+1,0,map);}catch{}
    const items=(plan?.items||[]).map(it=>{const p=plannerMarketPrice(s,map,it.id,0,'buy-any');const price=p?.price??(Number(it.marketPrice)>0?Number(it.marketPrice):null);return {...it,price};});
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
// v2.5.358 inputs run-out & make or buy lives on the Warehouse tab (all buildings). ctx: {s, priceMap, recipes,
// owned, runHours, bonusPct}. Returns HTML.
function plannerRunOutHtml(ctx){
  const d=plannerInsightsData(ctx);
  if(!d.ok)return `<div class="planner-profit-empty">${escapeHtml(d.reason)}</div>`;
  const {C,s,gc,economyState,adminPct,bonusPct,inputCostOf,nameOf,eventPctOf,map}=d;
  const row=(label,value,note='',cls='')=>`<div class="pp-row ${cls}"><div class="pp-label">${label}${note?`<small>${note}</small>`:''}</div><div class="pp-value">${value}</div></div>`;
  const owned=Array.isArray(ctx.owned)?ctx.owned:[];
  const specs=owned.map(b=>({id:b.id,name:b.name,kind:String(b.kind||''),level:Number(b.level)||1,productId:Number(b.currentResourceId),quality:Number(b.currentQuality)||0,raw:b.raw})).filter(b=>b.productId>0);
  const hours=Math.max(1,Number(ctx.runHours)||24);
  const runout=C.inputRunOut({c:gc,buildings:specs,economyState,bonusPct,eventPctOf,abundanceOf:(b,pid)=>plannerAbundancePct(s,b.raw?.id??b.id,pid),lots:plannerWarehouseLots(s),hours});
  const ownedKinds=new Map();for(const b of owned){const k=String(b.kind||'');if(k&&!ownedKinds.has(k))ownedKinds.set(k,b);}
  const lasts=h=>h==null?'covered':h<1?`${num(Math.round(h*60))} min`:h<48?`${num(+h.toFixed(1))} h`:`${num(+(h/24).toFixed(1))} d`;
  const lastCls=h=>h==null?'si-good':h<6?'si-bad':h<hours?'si-warn':'si-good';
  const runRows=runout.map(r=>{
    const mk=plannerMarketPrice(s,map,r.id,r.minQuality,'buy');
    const maker=ownedKinds.get(String(gc.resources[String(r.id)]?.producedAt??''));
    let own=null,ownMissing='';if(maker){const res=C.gameCalcProduct({c:gc,resourceId:r.id,economyState,eventPct:eventPctOf(r.id),bonusPct,adminPct,robots:Boolean(maker.robotsSpecialization),inputCostOf,abundancePct:plannerAbundancePct(s,maker.raw?.id??maker.id,r.id)});if(res.ok&&res.complete)own=res.sourcingCostPerUnit;else if(res.ok)ownMissing=res.missing.map(nameOf).join(', ');}
    const mob=C.makeOrBuy(own,mk?.price);
    const mobText=mob.verdict==='make'?`<span class="si-good">Make</span>: your cost ${plannerMoney(mob.ownCost)} vs market ${plannerMoney(mob.marketPrice)} — saves ${plannerMoney(mob.savesPerUnit)}/unit (${num(+mob.savesPct.toFixed(1))}%)`:mob.verdict==='buy'?`<span class="si-bad">Buy</span>: market ${plannerMoney(mob.marketPrice)} vs your cost ${plannerMoney(mob.ownCost)} — ${plannerMoney(mob.savesPerUnit)}/unit cheaper (${num(+mob.savesPct.toFixed(1))}%)`:maker&&mob.verdict==='no-price'?`Your cost ${plannerMoney(mob.ownCost)}/unit · no market price captured`:maker&&ownMissing?`Make or buy: your cost unknown — no price for ${escapeHtml(ownMissing)}`:'';
    const buyText=r.buyQty>0?` · buy ${num(r.buyQty)} for ${num(hours)} h${mk?` ≈ ${plannerMoney(r.buyQty*mk.price)} (${plannerMoney(mk.price)} Q${mk.quality})`:''}`:'';
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
    el.innerHTML=plannerRunOutHtml({s,priceMap:buildMarketPriceMap(s),recipes:data.recipes,owned,runHours,bonusPct:plannerCompanyProductionModifier(s)});
  }).catch(e=>{if(token===__scmWhRunOutToken)el.innerHTML=`<div class="planner-profit-empty">Could not calculate: ${escapeHtml(String(e?.message||e))}</div>`;});
}
function renderBuildingPlanner(s,options={}){
  const host=$('#buildingPlanner');if(!host)return;
  const renderToken=String((Number(host.dataset.renderToken)||0)+1);
  host.dataset.renderToken=renderToken;
  loadBuildingPlannerData().then(async data=>{
    if(host.dataset.renderToken!==renderToken)return;
    const definitions=data.buildings, recipes=data.recipes, rates=data.rates;
    const modifierState=await ensurePlannerCompanyModifiers(s);
    if(modifierState!==s){ renderBuildingPlanner(modifierState); return; }
    const realm=Number(s?.viewRealm??s?.captureRealm??s?.authData?.authCompany?.realmId);
    let ensurePromise=null;
    if(Number.isFinite(realm)&&!options.skipEnsure){
      ensurePromise=chrome.runtime.sendMessage({type:'ENSURE_FROZEN_PRODUCTION_RATES',realm}).catch(()=>({ok:false}));
      // Do not hold the Production UI hostage to history/rate reconciliation.
      // Render immediately from the realm-local state we already have, then
      // refresh once the authoritative frozen-rate transaction completes.
      if(ensurePromise){
        ensurePromise.then(async result=>{
          if(result?.ok&&host.dataset.renderToken===renderToken&&host.dataset.rateRefreshToken!==renderToken){
            host.dataset.rateRefreshToken=renderToken;
            try{renderBuildingPlanner(await get(),{skipEnsure:true});}catch{}
          }
        }).catch(()=>{});
      }
    }
    // Use the already-captured realm state passed into this render. Re-reading the
    // full physical realm store here made every planner interaction pay for another
    // large storage deserialization. The async rate reconciliation above remains
    // responsible for triggering a single fresh render when authoritative rates change.
    const owned=ownedPlannerBuildings(s,definitions).sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),undefined,{numeric:true,sensitivity:'base'}));
    if(!owned.length){
      host.innerHTML='<div class="building-empty-state"><h3>No building data captured yet</h3><p class="muted">Open your logged-in Sim Companies game page and let the Manager capture your current buildings, then return here. Full Sync also keeps the captured building data in the selected realm.</p></div>';
      return;
    }
    const recipeBy=plannerRecipeMap(recipes);
    const ui=plannerUiState(s);
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
    const productRate=product?plannerRateForProduct(product,building,level,recipes,rates,s):{rate:null,source:null};
    if(building.currentResource&&plannerNormalizeName(product)===plannerNormalizeName(building.currentResource))requestPlannerBuildingHistory(building,s);
    const outputPerHour=productRate.rate!=null?productRate.rate:null;
    const outputPerPlan=outputPerHour!=null?outputPerHour*runHours:null;
    // v2.5.350 planning level ≠ current level: the same rate function at the building's own level, for the difference.
    let originalPerHour=null;
    if(product&&level!==Number(building.level)&&outputPerHour!=null){try{const r0=plannerRateForProduct(product,building,Number(building.level)||1,recipes,rates,s);if(r0?.rate!=null&&Number.isFinite(Number(r0.rate)))originalPerHour=Number(r0.rate);}catch{}}
    const diffPerHour=originalPerHour!=null?outputPerHour-originalPerHour:null;
    const diffStat=(v,label)=>`<div class="planner-output-stat planner-output-diff ${v>0?'is-profit':v<0?'is-loss':''}"><strong>${v>0?'+':v<0?'−':''}${num(Math.abs(v))}</strong><span>${label}</span></div>`;
    const minInputQuality=Math.max(0,quality-1);
    const inputs=Array.isArray(productRecipe?.materials)?productRecipe.materials:[];
    const plannedInputs=inputs.map(m=>{
      const id=Number(m.id), perOutput=Number(m.quantity)||0;
      const required=outputPerHour!=null?perOutput*outputPerHour:null;
      const requiredPlan=required!=null?required*runHours:null;
      return {id,name:plannerResourceNameById(recipes,id,s),perOutput,required,requiredPlan,minQuality:minInputQuality};
    });

    // Aggregate the realm's frozen building plan for the selected 1–48 hour plan.
    // The selected building's planner overrides are applied to its contribution;
    // every other building uses its realm-local frozen product/quality/level/rate.
    const existingPlanMap=(s?.frozenNetworkPlan?.buildingPlans&&typeof s.frozenNetworkPlan.buildingPlans==='object')?s.frozenNetworkPlan.buildingPlans:{};const existingProdPlans=s?.productionPlans||{};const planModes={...(s?.frozenNetworkPlan?.plannerState?.planModes||{}),...(ui.planModes||{})};const planState={};
    for(const b of owned){const id=String(b.id);const persisted=existingPlanMap[id]||existingProdPlans[id]||{};const selected=String(b.id)===String(building.id);const p=selected?product:String(persisted.product||b.currentResource||'').trim();if(!p)continue;const rcp=recipeBy.get(plannerNormalizeName(p));const q=selected?quality:Math.max(0,Number(persisted.quality??b.currentQuality??0)||0);const lvl=selected?level:Math.min(20,Math.max(1,Number(persisted.plannedLevel)||Number(b.level)||1));const base=Number(persisted.baseRatePerLevel||0);planState[id]={buildingId:Number(b.id),product:p,productId:Number(rcp?.id||persisted.productId||0),resourceId:Number(persisted.resourceId||rcp?.id||0)||null,quality:q,plannedLevel:lvl,baseRatePerLevel:base>0?base:null,mode:planModes[id]||persisted.mode||'live'};}
    const network=plannerProductionNetwork(s,owned,recipes,rates,runHours,{buildingId:building.id,product,level,quality,planningLevels,planState});
    for(const spec of (network.activeSpecs||[])){const id=String(spec.buildingId);const current=planState[id]||{};const eventModifier=plannerActiveProductionEvent(s,spec.product,recipes,spec.productId);const divisor=(1+eventModifier/100)*plannerCompanyProductionFactor(s);if(divisor>0&&Number(spec.ratePerHour)>0)current.baseRatePerLevel=Number(spec.ratePerHour)/(Math.max(1,Number(spec.level)||1)*divisor);current.product=spec.product;current.productId=Number(spec.productId);current.quality=Math.max(0,Number(spec.quality)||0);current.plannedLevel=Math.min(20,Math.max(1,Number(spec.level)||1));current.buildingId=Number(spec.buildingId);planState[id]=current;}
    try{const eventMap={};for(const entry of Object.values(planState))eventMap[plannerNormalizeName(entry.product)]=plannerActiveProductionEvent(s,entry.product,recipes,entry.productId);const signature=globalThis.SCMPlannerCore?.frozenPlanSignature?globalThis.SCMPlannerCore.frozenPlanSignature(planState,runHours,{companyProductionModifier:plannerCompanyProductionModifier(s),events:eventMap,speedFormula:'game-divide'}):JSON.stringify({hours:runHours,planState});const plannerState={selectedBuildingId:String(building.id),planningLevels,productOverrides,qualityByBuilding:{...(s?.frozenNetworkPlan?.plannerState?.qualityByBuilding||{}),[String(building.id)]:quality},runHours,discount:ui.discount||0,planModes};const frozenSignature=String(s?.frozenNetworkPlan?.signature||'');const shouldPersistFrozen=host.__lastFrozenPlanSignature!==signature&&(!frozenSignature||frozenSignature!==signature);if(shouldPersistFrozen){host.__lastFrozenPlanSignature=signature;chrome.runtime.sendMessage({type:'SAVE_FROZEN_NETWORK_PLAN',realm:Number(realm),signature,plan:{hours:runHours,productionRows:network.productionRows,demandRows:network.demandRows,activeSpecs:network.activeSpecs,buildingPlans:planState,plannerState,modifiers:{companyProductionModifier:plannerCompanyProductionModifier(s),events:eventMap,speedFormula:'game-divide'},resources:network.resources,deficits:network.deficits,surpluses:network.surpluses}}).catch(()=>{});}}catch{}
    s=await get();

    const productImage=productRecipe?.id!=null?plannerResourceImage(Number(productRecipe.id),s):'';
    const buildingImage=plannerAssetUrl(building.raw?.image);
    const productOptions=[`<option value="__current__" ${productPickerValue==='__current__'?'selected':''}>Current output${currentProduct?` — ${escapeHtml(currentProduct)}`:''}</option>`].concat((building.produces||[]).map(p=>`<option value="${escapeHtml(p)}" ${p===productPickerValue?'selected':''}>${escapeHtml(p)}</option>`)).join('');
    const busyText=building.currentResource?`Currently producing: ${building.currentResource}${building.currentQuality!=null?` Q${building.currentQuality}`:''}`:'Currently producing: Idle';
    const levelOpts=Array.from({length:20},(_,i)=>i+1).map(v=>`<option value="${v}" ${v===level?'selected':''}>Level ${v}</option>`).join('');
    const company=plannerCompanyAuthData(s)||{};
    const productionModifier=Number(company.productionModifier);
    const salesModifier=plannerCompanySalesModifier(s);
    const modifierText=value=>Number.isFinite(value)?`${value>=0?'+':''}${value.toFixed(0)}%`:'—';
    const qOpts=Array.from({length:13},(_,q)=>`<option value="${q}" ${q===quality?'selected':''}>Q${q}</option>`).join('');

    const buildingCards=owned.map(b=>{
      const img=plannerAssetUrl(b.raw?.image);
      const cardPlan=plannerFrozenBuildingPlan(s,b.id)||b.productionPlan||null;
      const cardProduct=String(cardPlan?.product||b.currentResource||b.produces?.[0]||'').trim();
      const cardQuality=Number.isFinite(Number(cardPlan?.quality))?Number(cardPlan.quality):b.currentQuality;
      const cardRecipe=cardProduct?recipeBy.get(plannerNormalizeName(cardProduct)):null;
      const cardInputs=(cardRecipe?.materials||[]).map(m=>`${plannerResourceNameById(recipes,Number(m.id),s)}${cardQuality!=null?` Q${Math.max(0,Number(cardQuality)-1)}`:''}`).filter(Boolean);
      const outputLabel=cardProduct?`${cardProduct}${cardQuality!=null?` Q${cardQuality}`:''}`:'Idle';
      const inputLabel=cardInputs.length?cardInputs.join(' · '):'None';
      // v2.5.350 abundance (game's /api/v2/companies/buildings/<id>/abundance/) for mines, oil rigs and quarries.
      const TC=globalThis.SCM_TOOLS_CORE,cardResId=Number(cardRecipe?.id);
      const cardAb=cardResId>0&&TC?.isAbundanceResource?.(cardResId)?plannerAbundancePct(s,b.raw?.id??b.id,cardResId):undefined;
      const abundanceLine=cardAb===undefined?'':cardAb==null?'<span class="owned-building-io owned-building-abundance ab-none"><b>Abundance:</b> not captured</span>':`<span class="owned-building-io owned-building-abundance ab-${TC.abundanceTone(cardAb)}"><b>Abundance:</b> <em>${num(+cardAb.toFixed(2))}%</em></span>`;
      return `<button type="button" class="owned-building-card ${String(b.id)===String(building.id)?'active':''}" data-building-id="${escapeHtml(String(b.id))}"><div class="owned-building-image-wrap">${plannerImage(img,b.name,'owned-building-image')}<span class="owned-building-level">Level ${b.level}${Number(planningLevels[String(b.id)])!==Number(b.level)?` · Plan ${Number(planningLevels[String(b.id)])}`:''}</span></div><strong>${escapeHtml(b.name)}</strong><span class="owned-building-io owned-building-output"><b>Output:</b> ${escapeHtml(outputLabel)}</span><span class="owned-building-io owned-building-inputs"><b>Inputs:</b> ${escapeHtml(inputLabel)}</span>${abundanceLine}</button>`;
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
    const frozenVwapMap=buildMarketPriceMap(s);
    host.__plannerVwapMap=frozenVwapMap;
    const deficitBase=network.deficits.map(x=>plannerDiscountQuote(s,x,'deficit',0,frozenVwapMap));
    const surplusBase=network.surpluses.map(x=>plannerDiscountQuote(s,x,'surplus',0,frozenVwapMap));
    const applyDiscount=(quote,pct)=>({...quote,discount:pct,unitPrice:quote.marketPrice!=null?roundCurrencyUp(quote.marketPrice*(1-pct/100)):null,total:quote.marketPrice!=null&&quote.amount>0?roundCurrencyUp(roundCurrencyUp(quote.marketPrice*(1-pct/100))*quote.amount):null});
    const deficitQuotes=deficitBase.map(q=>applyDiscount(q,discount));
    const surplusQuotes=surplusBase.map(q=>applyDiscount(q,discount));
    const summaryRows=(quotes,type)=>quotes.length?quotes.map(q=>{
      return `<div class="planner-summary-row"><div class="planner-summary-resource">${plannerImage(plannerResourceImage(q.id,s),q.name,'planner-summary-icon')}<span>${escapeHtml(q.name)}<small>Q${q.quality}${q.marketPriceQuality!=null&&Number(q.marketPriceQuality)!==Number(q.quality)?` · market Q${q.marketPriceQuality}`:''}</small></span></div><strong>${type==='deficit'?'-':'+'}${num(q.amount)}</strong><span class="planner-summary-money" data-market-price="${q.marketPrice??''}" data-amount="${q.amount}" data-summary-type="${type}"><small>Market</small> ${plannerMoney(q.marketPrice)}<br><small>Est. ${type==='deficit'?'Buy Cost':'Sale Value'} · ${q.discount}% discount</small> ${plannerMoney(q.total)} <small>(${plannerMoney(q.unitPrice)} / unit)</small></span></div>`;
    }).join(''):`<div class="planner-summary-empty">No ${type}s for this production plan.</div>`;
    // v2.5.86 text-box format: keep the resource reference separated by spaces
    // so the Sim Companies chat parser renders :re-###: as an image. Keep each
    // material on one unbroken line and use the same compact layout the user
    // verified manually in-game.
    const textHeader=type=>type==='deficit'?`==============================\n🔽🔽🔽 BUYING -${discount}% MARKET 🔽🔽🔽`: `==============================\n🔽🔽🔽 SELLING -${discount}% MARKET 🔽🔽🔽`;
    const textRows=(quotes,type)=>{
      if(!quotes.length) return {plain:`No ${type}s for this production plan.`,html:`<div class="planner-copy-empty">No ${type}s for this production plan.</div>`};
      const rows=quotes.map(q=>{
        const code=`:re-${Number(q.id)}:`;
        const priceQuality=q.marketPriceQuality!=null&&Number(q.marketPriceQuality)!==Number(q.quality)?` (market Q${q.marketPriceQuality})`:'';const plain=`➡️ ${num(q.amount)} - Q${q.quality} ${q.name}${priceQuality} ${code} - ${q.unitPrice!=null?money(q.unitPrice):'Market unavailable'}`;
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
      return {building:b,plan:constructionMaterialPlan(s,b,b.level,target,discount,frozenVwapMap)};
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
    const constructionTotalCost=roundCurrencyUp(constructionTotalItems.reduce((sum,x)=>sum+(Number(x.lineTotal)||0),0));
    const constructionTextRows=constructionTotalItems.length?{
      plain:`${textHeader('deficit')}\n${constructionTotalItems.map(x=>`➡️ ${num(x.amount)} - ${x.name} :re-${Number(x.id)}: - ${x.price!=null?money(x.price):'—'}`).join('\n')}\n==============================`,
      html:`${constructionTotalItems.map(x=>`<div class="planner-copy-line"><span>${escapeHtml(`➡️ ${num(x.amount)} - ${x.name} :re-${Number(x.id)}: - ${x.price!=null?money(x.price):'—'}`)}</span></div>`).join('')}`
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
    host.__plannerConstructionTotal=constructionTotalCost;
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
    const previousBuildingsStrip=host.querySelector('.owned-buildings-strip');
    const buildingsStripScrollLeft=previousBuildingsStrip?previousBuildingsStrip.scrollLeft:0;
    host.innerHTML=`<div class="owned-buildings-heading"><h3>Your Buildings</h3><span class="owned-building-count">Total Buildings: ${owned.length}</span></div><div class="owned-buildings-strip">${buildingCards}</div><div class="planner-speed-modifiers" aria-label="Current production and sales speed modifiers"><div class="planner-speed-modifier"><span>Production Speed</span><strong>${modifierText(productionModifier)}</strong></div><div class="planner-speed-modifier"><span>Sales Speed</span><strong>${modifierText(salesModifier)}</strong></div></div><article class="planner-main-card"><div class="planner-selected-head"><div class="planner-building-hero">${plannerImage(buildingImage,building.name,'planner-building-hero-image')}<div><h3>${escapeHtml(building.name)}</h3><div class="planner-selected-category">${escapeHtml(building.category||'Resources')}</div><div class="planner-selected-line">Current Level: ${building.level} · Planning Level: ${level}</div><div class="planner-selected-line ${building.currentResource?'is-producing':''}">${busyText.replace(/·/g,'')}</div></div></div><div class="building-detail-controls"><label>Planning Level<select id="buildingLevel">${levelOpts}</select></label><label>Production Quality<select id="buildingQuality">${qOpts}</select></label><label>Production Time<input id="buildingRunHours" type="number" min="1" max="48" step="1" value="${runHours}"><small>1–48 hours</small></label></div></div><div class="planner-divider"></div><div class="planner-section-label">Production Output</div><div class="planner-output-grid${diffPerHour!=null?' has-diff':''}"><div class="planner-output-product planner-output-product-picker" title="Click to change production output">${plannerImage(productImage,product,'planner-output-image')}<div><strong>${escapeHtml(product||'No product')}</strong><span>Primary Product</span></div><select id="buildingProduct" class="planner-output-product-picker-select" aria-label="Change production output">${productOptions}</select></div><div class="planner-output-stat"><strong>${outputPerHour==null?'—':num(outputPerHour)}</strong><span>Production / hr</span></div>${diffPerHour!=null?diffStat(diffPerHour,`vs Level ${num(building.level)} / hr`):''}<div class="planner-output-stat"><strong>${outputPerPlan==null?'—':num(outputPerPlan)}</strong><span>Production / ${runHours} hr</span></div>${diffPerHour!=null?diffStat(diffPerHour*runHours,`vs Level ${num(building.level)} / ${runHours} hr`):''}</div><div class="planner-section-label">Required Inputs <span>(for ${escapeHtml(product||'selected product')} Q${quality})</span></div><div class="table-wrap planner-table-wrap"><table class="building-input-table planner-input-table mobile-cards"><thead><tr><th>Resource</th><th>Required / hr</th><th>Required / ${runHours} hr</th></tr></thead><tbody>${rows||'<tr><td colspan="3">No recipe inputs are defined for this product.</td></tr>'}</tbody></table></div><div class="planner-section-label">Profit / h / level <span>(${escapeHtml(product || 'selected product')} Q${quality} · Level ${level})</span></div><div id="plannerProfit" class="planner-profit"></div><div class="planner-section-label">Best product <span>(for this building · profit / h / level)</span></div><div id="plannerInsights" class="planner-profit planner-insights"></div><div class="planner-section-label">Upgrade payback <span>(all buildings · next level)</span></div><div id="plannerPayback" class="planner-profit planner-insights"></div><div class="planner-section-label planner-summary-label">Deficit &amp; Surplus</div><div class="planner-discount-control"><label>Buying - selected discount from VWAP<select id="plannerDiscount">${discountOpts}</select></label></div><div class="planner-summary-grid"><div class="planner-summary-card deficit-card"><div class="planner-summary-head"><span>Deficit - Total</span><strong id="plannerDeficitTotal">${deficitTotal}</strong></div><div class="planner-summary-table-scroll"><div class="planner-summary-table-head"><span>Resource</span><span>Amount</span><span>VWAP / Est. Market Cost</span></div>${summaryRows(deficitQuotes,'deficit')}</div></div><div class="planner-summary-card surplus-card"><div class="planner-summary-head"><span>Surplus - Total</span><strong id="plannerSurplusTotal">${surplusTotal}</strong></div><div class="planner-summary-table-scroll"><div class="planner-summary-table-head"><span>Resource</span><span>Amount</span><span>VWAP / Est. Market Value</span></div>${summaryRows(surplusQuotes,'surplus')}</div></div></div><div class="planner-text-grid"><div class="planner-text-card deficit-card"><div class="planner-summary-head"><span>Deficit Text</span><button type="button" class="planner-copy-btn" data-copy-target="deficitText">Copy</button></div><div id="deficitText" class="planner-copy-area"><div class="planner-copy-heading">==============================<br>🔽🔽🔽 BUYING -${discount}% MARKET 🔽🔽🔽</div>${deficitTextRows.html}<div class="planner-copy-heading">==============================</div></div></div><div class="planner-text-card surplus-card"><div class="planner-summary-head"><span>Selling Text</span><button type="button" class="planner-copy-btn" data-copy-target="surplusText">Copy</button></div><div id="surplusText" class="planner-copy-area"><div class="planner-copy-heading">==============================<br>🔽🔽🔽 SELLING -${discount}% MARKET 🔽🔽🔽</div>${surplusTextRows.html}<div class="planner-copy-heading">==============================</div></div></div></div><div class="planner-construction-card planner-text-card"><div class="planner-summary-head"><span>Construction Materials</span><strong id="plannerConstructionTotal">${plannerMoney(constructionTotalCost)}</strong><button type="button" class="planner-copy-btn" data-upgrade-projection>Upgrade View</button><button type="button" class="planner-copy-btn" data-copy-target="constructionMaterialsText">Copy</button></div><div id="constructionMaterialsText" class="planner-copy-area"><div class="planner-copy-heading">==============================<br>🔽🔽🔽 BUYING -${discount}% MARKET 🔽🔽🔽</div>${constructionTotalItems.length?constructionTotalItems.map(x=>`<div class="planner-copy-line"><span>${escapeHtml(`➡️ ${num(x.amount)} - ${x.name} :re-${Number(x.id)}: - ${x.price!=null?money(x.price):'—'}`)}</span></div>`).join(''):'<div class="planner-copy-empty">No additional construction materials required for the planned building levels.</div>'}<div class="planner-copy-heading">==============================</div></div></div><div class="planner-quality-footer"><div class="planner-info-dot">i</div><div><strong>Quality Note</strong><p>Inputs must be at least one quality level below the selected production quality. Higher quality inputs can also be used. Production quantity is not affected by quality level.</p><p class="planner-network-reference">Deficit and surplus are calculated from all owned buildings for the selected production time. Warehouse inventory is applied to construction-material needs by total quantity, regardless of stored quality.</p></div></div></article>`;

    const deficitTextEl=$('#deficitText'); if(deficitTextEl) deficitTextEl.dataset.copyText=deficitCopyText;
    const surplusTextEl=$('#surplusText'); if(surplusTextEl) surplusTextEl.dataset.copyText=surplusCopyText;
    const constructionTextEl=$('#constructionMaterialsText'); if(constructionTextEl) constructionTextEl.dataset.copyText=constructionCopyText;
    host.__upgradeProjectionContext={state:s,building,plan:constructionMaterialPlan(s,building,building.level,level,discount,frozenVwapMap),discount,vwapMap:frozenVwapMap};
  // v2.5.338 economy phase: the measured rate belongs to the running batch's phase; also pass the
  // normal-economy reference rate (× the same game modifiers) for when the phase has changed since.
  let referenceRate=null;try{const rb=plannerRate(product,recipes,rates,s);const ev=1+plannerActiveProductionEvent(s,product,recipes,Number(productRecipe?.id))/100;const cf=plannerCompanyProductionFactor(s);if(Number(rb?.rate)>0&&ev>0&&cf>0)referenceRate=Number(rb.rate)*level*ev*cf;}catch{}
  let ctxEventPct=0;try{ctxEventPct=plannerActiveProductionEvent(s,product,recipes,Number(productRecipe?.id))||0;}catch{}
  const busyRaw=building?.raw?.busy;const rateFromBatch=Boolean(busyRaw?.started)&&Number(busyRaw?.resource?.kind)===Number(productRecipe?.id)&&!/reference/i.test(String(productRate?.source||''));
  host.__plannerProfitCtx={s,building,product,productId:Number(productRecipe?.id),quality,level,outputPerHour,eventPct:ctxEventPct,abundancePct:plannerAbundancePct(s,building?.raw?.id??building?.id,Number(productRecipe?.id)),bonusPct:plannerCompanyProductionModifier(s),buildingKind:String(building?.raw?.kind??building?.kind??''),robots:Boolean(building?.raw?.robotsSpecialization),rateSource:productRate?.source||null,rateFromBatch,batchStarted:rateFromBatch?String(busyRaw.started):null,referenceRate,plannedInputs,transportUnits:Number(productRecipe?.transport)||0,priceMap:frozenVwapMap,owned,recipes,runHours};
  try{renderPlannerProfit(host);}catch(e){console.error('Planner profit render failed',e);}
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
    host.querySelectorAll('[data-building-id]').forEach(b=>b.onclick=()=>{ui.buildingId=b.dataset.buildingId;const ownedB=owned.find(x=>String(x.id)===String(b.dataset.buildingId));const saved=plannerFrozenBuildingPlan(s,b.dataset.buildingId);ui.quality=Number(saved?.quality??ui.qualityByBuilding?.[String(b.dataset.buildingId)]??ownedB?.currentQuality??0);ui.qualityByBuilding={...(ui.qualityByBuilding||{}),[String(b.dataset.buildingId)]:ui.quality};host.dataset.buildingId=b.dataset.buildingId;host.dataset.quality=String(ui.quality);queuePlannerUiPersist(s);renderBuildingPlanner(s);});
    $('#buildingProduct').onchange=()=>{
      let overrides={};
      try{overrides=JSON.parse(host.dataset.productOverrides||'{}')||{};}catch{}
      const value=$('#buildingProduct').value;
      if(value==='__current__'||!building.produces.includes(value)){ delete overrides[String(building.id)]; } else overrides[String(building.id)]=value;
      ui.productOverrides=overrides;ui.planModes={...(ui.planModes||{}),[String(building.id)]:value==='__current__'?'live':'planner'};host.dataset.productOverrides=JSON.stringify(overrides);queuePlannerUiPersist(s);
      renderBuildingPlanner(s);
    };
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
      clearTimeout(runHoursSaveTimer);
      runHoursSaveTimer=setTimeout(()=>{applyRunHours().catch(()=>{});},250);
    };
    $('#buildingRunHours').onchange=()=>{clearTimeout(runHoursSaveTimer);applyRunHours().catch(()=>{});};
    $('#plannerDiscount').onchange=()=>{ui.discount=plannerDiscountPercent($('#plannerDiscount').value);host.dataset.discount=String(ui.discount);queuePlannerUiPersist(s);const marketDiscount=$('#marketContractDiscount');if(marketDiscount)marketDiscount.value=String(ui.discount);if(window.__scmState)renderLiveMarketProduct(window.__scmState);renderBuildingPlanner(s);};
    host.querySelectorAll('.planner-copy-btn').forEach(btn=>btn.onclick=async()=>{const el=document.getElementById(btn.dataset.copyTarget);if(!el)return;const text=el.dataset.copyText??el.value??el.textContent??'';try{await navigator.clipboard.writeText(text);}catch{const ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();}btn.textContent='Copied';setTimeout(()=>btn.textContent='Copy',1200);});
  });
}
function renderMarketAlerts(s){const host=$('#marketAlerts');if(!host)return;const alerts=[];for(const r of warehouseRows(s)){const marketPrice=exactMarketPrice(buildMarketPriceMap(s),r._id,r._quality);const alertCost=warehouseAlertUnitCost(s,r);if(marketPrice==null||!Number.isFinite(alertCost)||alertCost<=0)continue;const pct=(marketPrice-alertCost)/alertCost*100;if(Math.abs(pct)>=5)alerts.push({name:resourceName(r,s),quality:r._quality,cost:alertCost,marketPrice,pct});}alerts.sort((a,b)=>Math.abs(b.pct)-Math.abs(a.pct));host.innerHTML=alerts.length?`<div class="market-alert-list">${alerts.slice(0,10).map(a=>`<div class="market-alert-row"><div><strong>${escapeHtml(a.name)}</strong><small>Q${escapeHtml(String(a.quality))}</small></div><div>${money(a.cost)} → ${money(a.marketPrice)}</div><strong class="${a.pct>=0?'positive':'negative'}">${a.pct>=0?'+':''}${a.pct.toFixed(1)}%</strong></div>`).join('')}</div><p class="muted">Warehouse sourcing cost compared with captured current SimcoTools Market price (not VWAP). Alerts trigger at 5% or more.</p>`:'<p class="muted">No warehouse Market alerts at the current 5% threshold.</p>';}

document.querySelector('#saveJson')?.addEventListener('click',async()=>{try{const s=await get();const manifestVersion=chrome.runtime.getManifest()?.version||BUILD_VERSION;const payload={exportedAt:new Date().toISOString(),page:'simcompanies-manager',version:manifestVersion,manifestVersion,buildVersion:BUILD_VERSION,activeRealmKey:s.activeRealmKey??null,selectedRealm:s.selectedRealm??null,captureRealm:s.captureRealm??null,realmStores:s.realmStores??{},activeState:{authData:s.authData??null,companyData:s.companyData??null,warehouseResources:s.warehouseResources??[],gameState:s.gameState??null,endpointData:s.endpointData??{},apiEndpoints:s.apiEndpoints??[],contracts:s.contracts??[],savedContracts:s.savedContracts??[],contractEvents:s.contractEvents??[],gameLocalStorageSnapshot:s.gameLocalStorageSnapshot??null,vwapData:s.vwapData??null,history:s.history??{},marketCache:s.marketCache??{},marketDebug:s.marketDebug??{},vwapStatus:s.vwapStatus??null,vwapWatch:s.vwapWatch??null,productionEvents:s.productionEvents??[],syncStatus:s.syncStatus??null,syncError:s.syncError??null,fullSyncDiagnostics:s.fullSyncDiagnostics??null,warehouseCostDetails:s.warehouseCostDetails??{},javascriptDiagnostic:s.javascriptDiagnostic??null,javascriptDiagnosticHistory:s.javascriptDiagnosticHistory??[]}};const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`simcompanies-manager-diagnostic-${realmDisplayNumber(payload.captureRealm)}-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;document.body.appendChild(a);a.click();a.remove();scmDownloadToast(a.download,blob.size);setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){alert('Unable to save diagnostic JSON: '+(e?.message||String(e)));}});
document.querySelector('#downloadStorage')?.addEventListener('click',async()=>{try{const storage=await chrome.storage.local.get(null);const manifestVersion=chrome.runtime.getManifest()?.version||BUILD_VERSION;const payload={exportedAt:new Date().toISOString(),page:'simcompanies-manager-storage',version:manifestVersion,manifestVersion,buildVersion:BUILD_VERSION,storage:storage};const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`simcompanies-manager-storage-${manifestVersion}-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;document.body.appendChild(a);a.click();a.remove();scmDownloadToast(a.download,blob.size);setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){alert('Unable to download stored data: '+(e?.message||String(e)));}});
document.querySelector('#downloadDiagnosticBundle')?.addEventListener('click',async()=>{try{const s=await get();downloadDiagnosticFile(`simcompanies-manager-diagnostic-bundle-${realmDisplayNumber(s.viewRealm)}-${diagnosticFileStamp()}.json`,await buildDiagnosticBundle(s));}catch(e){alert('Unable to download diagnostic bundle: '+(e?.message||String(e)));}});
document.querySelector('#downloadApiCapture')?.addEventListener('click',async()=>{try{const s=await get();const {realm,store}=diagnosticStore(s);const payload={exportedAt:new Date().toISOString(),managerVersion:BUILD_VERSION,realm,activeRealmKey:s.activeRealmKey??null,selectedRealm:s.selectedRealm??null,apiEndpoints:store?.apiEndpoints??[],endpointData:store?.endpointData??{},apiLastRequestAt:store?.apiLastRequestAt??null};downloadDiagnosticFile(`simcompanies-manager-api-capture-${realmDisplayNumber(realm)}-${diagnosticFileStamp()}.json`,payload);}catch(e){alert('Unable to download API capture: '+(e?.message||String(e)));}});
let networkCaptureActive=false;let networkCaptureId='';let networkCaptureTabId=null;
const networkCaptureStatusEl=document.querySelector('#networkCaptureStatus');
const networkCaptureButton=document.querySelector('#startNetworkCapture');
// Android uses MAIN-world page capture (fetch/XHR); desktop uses browser-level CDP capture.
const networkCaptureUnsupportedOnAndroid=/Android/i.test(navigator.userAgent||'');
// v2.5.330: Android unloads the game tab while you are in the Manager (tab status
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
async function waitForNetworkCaptureStarted(captureId,timeoutMs=4000){const started=Date.now();while(Date.now()-started<timeoutMs){const capture=await readNetworkCapture();if(capture?.captureId===captureId&&capture?.status==='recording'&&Array.isArray(capture.events)&&capture.events.some(event=>event?.kind==='capture-start'))return capture;await new Promise(resolve=>setTimeout(resolve,100));}const capture=await readNetworkCapture();throw new Error(`Recorder did not confirm start in storage (status=${capture?.status||'missing'}, events=${Array.isArray(capture?.events)?capture.events.length:0}).`);}
async function resolveNetworkCaptureTab(){if(networkCaptureTabId!=null){try{const tab=await chrome.tabs.get(networkCaptureTabId);if(tab?.id&&/^https:\/\/(?:www\.)?simcompanies\.com\//i.test(String(tab.url||'')))return tab;}catch{}}const tabs=await chrome.tabs.query({url:['https://www.simcompanies.com/*','https://simcompanies.com/*']});const tab=(tabs||[]).find(t=>t.active)||tabs?.[0];if(tab?.id)networkCaptureTabId=tab.id;return tab||null;}
async function waitForNetworkCaptureQuiet(quietMs=900,timeoutMs=8000){const started=Date.now();let lastCount=-1,lastChange=Date.now();while(Date.now()-started<timeoutMs){const c=await readNetworkCapture();const count=Array.isArray(c?.events)?c.events.length:0;if(count!==lastCount){lastCount=count;lastChange=Date.now();}if(Date.now()-lastChange>=quietMs&&c?.status==='stopped')return c;await new Promise(r=>setTimeout(r,150));}return await readNetworkCapture();}
async function stopNetworkCapture({allowPartial=false}={}){
  const capture=await readNetworkCapture();
  if(!capture||!['starting','recording','stopping'].includes(String(capture.status||''))){networkCaptureActive=false;await refreshNetworkCaptureStatus();return {capture,confirmed:capture?.status==='stopped'};}
  networkCaptureId=String(capture.captureId||networkCaptureId||'');
  const tab=await resolveNetworkCaptureTab();
  if(!tab?.id)throw new Error('Cannot find the Sim Companies tab for this capture. Reopen the game tab and retry Stop.');
  const result=await sendGameTabMessage(tab.id,{type:'SET_NETWORK_CAPTURE',enabled:false,captureId:networkCaptureId},{timeoutMs:6500,bootstrapTimeoutMs:1200});
  if(result?.ok!==true)throw new Error(result?.error||'The game-page recorder did not acknowledge Stop.');
  networkCaptureActive=false;
  if(networkCaptureButton){networkCaptureButton.textContent='Start Network Capture';networkCaptureButton.setAttribute('aria-pressed','false');}
  if(networkCaptureStatusEl)networkCaptureStatusEl.textContent='Network capture stopping · waiting for pending writes…';
  const settled=await waitForNetworkCaptureQuiet(900,8000);
  const confirmed=settled?.captureId===networkCaptureId&&settled?.status==='stopped'&&Array.isArray(settled.events)&&settled.events.some(event=>event?.kind==='capture-stop');
  await refreshNetworkCaptureStatus();
  if(!confirmed&&!allowPartial)throw new Error(`Stop was acknowledged by the game page, but the durable stop marker was not saved (status=${settled?.status||'missing'}, events=${settled?.events?.length||0}, captureIdMatch=${settled?.captureId===networkCaptureId}). Existing events are preserved; export the partial capture and retry Stop.`);
  return {capture:settled,confirmed};
}
scmOnStorageChanged((changes,area)=>{if(area==='local'&&changes.scmNetworkTrafficCapture){renderNetworkCaptureStatus(changes.scmNetworkTrafficCapture.newValue);const c=changes.scmNetworkTrafficCapture.newValue;networkCaptureActive=['starting','recording','stopping'].includes(String(c?.status||''));if(c?.captureId)networkCaptureId=String(c.captureId);if(networkCaptureButton){networkCaptureButton.textContent=networkCaptureActive?'Stop Network Capture':'Start Network Capture';networkCaptureButton.setAttribute('aria-pressed',String(networkCaptureActive));}}});
refreshNetworkCaptureStatus();
async function toggleMobileNetworkCapture(button){const stat=await chrome.runtime.sendMessage({type:'SCM_NET3_STATUS'});const status=stat?.status||{};if(status.status==='recording'&&status.mode==='mobile-page'){const stopped=await chrome.runtime.sendMessage({type:'SCM_MOBILE_NET_STOP'});if(!stopped?.ok)throw new Error(stopped?.error||'Could not stop mobile capture.');networkCaptureActive=false;networkCaptureId=stopped.captureId;if(networkCaptureStatusEl)networkCaptureStatusEl.textContent=`Mobile page capture stopped · ${stopped.events||0} events · ${stopped.requests||0} requests · ${stopped.responses||0} responses · ${stopped.errors||0} errors`;button.textContent='Start Network Capture';button.setAttribute('aria-pressed','false');alert(`Mobile network capture stopped.\n\nEvents: ${stopped.events||0}\nRequests: ${stopped.requests||0}\nResponses: ${stopped.responses||0}\nErrors: ${stopped.errors||0}\n\nUse Download Network Capture to export the JSON.`);return;}const tab=await resolveNetworkCaptureTab();if(!tab?.id)throw new Error('Open Sim Companies in a browser tab first.');networkCaptureTabId=tab.id;const result=await chrome.runtime.sendMessage({type:'SCM_MOBILE_NET_START',tabId:tab.id});if(!result?.ok)throw new Error(result?.error||'Could not start mobile page capture.');networkCaptureId=result.captureId;networkCaptureActive=true;button.textContent='Stop Network Capture';button.setAttribute('aria-pressed','true');if(networkCaptureStatusEl)networkCaptureStatusEl.textContent=`Mobile page capture recording · ${result.events||0} events · fetch/XHR only · up to 100,000 events. Keep game tab open; Android may suspend background tabs.`;alert('Mobile network capture started. Keep the Sim Companies tab open overnight. Android may suspend a background tab, so this records activity only while the page is running.');}
networkCaptureButton?.addEventListener('click',async e=>{const button=e.currentTarget;button.disabled=true;try{if(networkCaptureUnsupportedOnAndroid){await toggleMobileNetworkCapture(button);return;}const stat=await chrome.runtime.sendMessage({type:'SCM_NET3_STATUS'});const status=stat?.status||{};if(status.status==='recording'){const stopped=await chrome.runtime.sendMessage({type:status.mode==='mobile-page'?'SCM_MOBILE_NET_STOP':'SCM_NET3_STOP'});if(!stopped?.ok)throw new Error(stopped?.error||'Could not stop browser network capture.');networkCaptureActive=false;button.textContent='Start Network Capture';button.setAttribute('aria-pressed','false');if(networkCaptureStatusEl)networkCaptureStatusEl.textContent=`Network Capture 3.0 stopped · ${stopped.events||0} events · ${stopped.requests||0} requests · ${stopped.responses||0} responses · ${stopped.bodies||0} response bodies · ${stopped.errors||0} errors`;alert(`Network Capture 3.0 stopped.\n\nEvents: ${stopped.events}\nRequests: ${stopped.requests}\nResponses: ${stopped.responses}\nBodies captured: ${stopped.bodies}\nErrors: ${stopped.errors}\n\nUse Download Network Traffic JSON to export the capture.`);}else{const tab=await resolveNetworkCaptureTab();if(!tab?.id)throw new Error('Open Sim Companies in a browser tab first.');networkCaptureTabId=tab.id;const result=await chrome.runtime.sendMessage({type:'SCM_NET3_START',tabId:tab.id});if(!result?.ok)throw new Error(result?.error||'Could not start Chrome browser-level capture.');networkCaptureId=result.captureId;networkCaptureActive=true;button.textContent='Stop Network Capture';button.setAttribute('aria-pressed','true');if(networkCaptureStatusEl)networkCaptureStatusEl.textContent=`Network Capture 3.0 recording · tab ${tab.id} · browser-level requests and response bodies. Chrome debugging indicator may appear.`;}}catch(err){const message=String(err?.message||err);if(networkCaptureStatusEl)networkCaptureStatusEl.textContent=`Network Capture 3.0 error · ${message}`;alert('Network Capture 3.0 error: '+message);}finally{button.disabled=false;}});
document.querySelector('#downloadNetworkCapture')?.addEventListener('click',async()=>{const button=document.querySelector('#downloadNetworkCapture');const old=button?.textContent;if(button){button.disabled=true;button.textContent='Exporting all network events…';}try{let st=await chrome.runtime.sendMessage({type:'SCM_NET3_STATUS'});let status=st?.status||{};if(status.status==='recording'){const stopped=await chrome.runtime.sendMessage({type:'SCM_NET3_STOP'});if(!stopped?.ok)throw new Error(stopped?.error||'Could not stop capture before export.');status={...status,...stopped,status:'stopped'};networkCaptureActive=false;if(networkCaptureButton){networkCaptureButton.textContent='Start Network Capture';networkCaptureButton.setAttribute('aria-pressed','false');}}const captureId=String(status.captureId||networkCaptureId||'');if(!captureId)throw new Error('No Network Capture 3.0 capture is available. Start the recorder, browse the game, then stop it.');let events=[],offset=0,total=0;do{const page=await chrome.runtime.sendMessage({type:'SCM_NET3_EXPORT',captureId,offset,limit:300});if(!page?.ok)throw new Error(page?.error||'Unable to read capture data from IndexedDB.');events.push(...(page.events||[]));total=Number(page.total)||events.length;offset=events.length;if(!page.events?.length)break;if(events.length<total&&networkCaptureStatusEl)networkCaptureStatusEl.textContent=`Exporting network events · ${events.length}/${total}`;}while(events.length<total);const requests=events.filter(x=>x.kind==='request'||x.kind==='request-start'),responses=events.filter(x=>x.kind==='response'||x.kind==='fetch'||x.kind==='xhr');const coverage=globalThis.SCM_DIAGNOSTIC_CORE?.summarizeNetworkCaptureV3?globalThis.SCM_DIAGNOSTIC_CORE.summarizeNetworkCaptureV3(events):{responseCount:responses.length,responseBodiesCaptured:events.filter(x=>x.kind==='response-body'&&x.body!=null).length,responseBodiesUnavailable:Math.max(0,responses.length-events.filter(x=>x.kind==='response-body'&&x.body!=null).length),bodyCoveragePercent:responses.length?Number((events.filter(x=>x.kind==='response-body'&&x.body!=null).length/responses.length*100).toFixed(1)):0,responseBodyOutcomes:[]};const payload={schemaVersion:3,diagnostic:'simcompanies-network-capture-v3',exportedAt:new Date().toISOString(),managerVersion:BUILD_VERSION,captureId,status:'stopped',startedAt:status.startedAt||null,stoppedAt:status.stoppedAt||new Date().toISOString(),scope:{captureMechanism:status.mode==='mobile-page'?'MAIN-world page fetch/XHR instrumentation':'Chrome DevTools Protocol Network domain via chrome.debugger',tabId:status.tabId??networkCaptureTabId,coverage:status.mode==='mobile-page'?'Includes game-page fetch/XHR and Manager background SimcoTools fetches. Page-level capture is same-origin only; background capture covers the Manager SimcoTools fetch wrapper. Does not observe all browser-internal traffic, images/navigation, WebSockets or other extension requests.':'Browser-observed Network-domain events for the attached tab, including cross-origin HTTP(S) requests, request/response metadata, bodies when Chrome exposes them, redirects, cache events, WebSocket/EventSource protocol events and failures.',limitations:['No browser extension can promise literally every byte across every process or traffic mechanism.','Mobile capture is page-level and cannot observe all browser traffic; Android may suspend the tab overnight.','Request/response headers, cookies, authorization values and request bodies are not recorded by the mobile recorder.','Mobile API response previews are truncated at 4 KB; capture is capped at 100,000 events.']},summary:{eventCount:events.length,requestCount:requests.length,...coverage,requestFailures:events.filter(x=>x.kind==='loading-failed').length,recorderErrors:events.filter(x=>x.kind==='capture-error').length},events};downloadDiagnosticFile(`simcompanies-manager-network-capture-v3-${diagnosticFileStamp()}.json`,payload);if(networkCaptureStatusEl)networkCaptureStatusEl.textContent=`Network Capture 3.0 export complete · ${events.length} events · ${coverage.responseBodiesCaptured} bodies · ${coverage.responseBodiesUnavailable} responses without bodies`;alert(`Network Capture 3.0 exported.\n\nEvents: ${events.length}\nRequests: ${requests.length}\nResponses: ${responses.length}\nBodies captured: ${coverage.responseBodiesCaptured}\nResponses without bodies: ${coverage.responseBodiesUnavailable}\n\nUnavailable bodies are listed with reasons; they are not silently counted as captured.`);}catch(e){alert('Unable to export Network Capture 3.0: '+(e?.message||String(e)));}finally{if(button){button.disabled=false;button.textContent=old||'Download Network Traffic JSON';}}});
document.querySelector('#downloadProductionDiagnostic')?.addEventListener('click',async()=>{try{const s=await get();const {realm,store}=diagnosticStore(s);const payload={exportedAt:new Date().toISOString(),managerVersion:BUILD_VERSION,realm,buildings:store?.buildings??null,productionRateSnapshots:store?.productionRateSnapshots??{},productionPlans:store?.productionPlans??{},productionEvents:store?.productionEvents??[],productionHistoryAudit:plannerHistoryAuditExport(),productionHistoryComparison:productionHistoryComparisonExport(store||{}),backgroundJobHistory:store?.backgroundJobHistory??[],productionRunHours:store?.productionRunHours??24,productionPlannerState:s?.productionPlannerState??null,history:store?.history??{},gameOverlaySnapshot:store?.gameOverlaySnapshot??null,warehouseResources:store?.warehouseResources??[],warehouseLotProvenance:warehouseRows(store||{}).flatMap(row=>Array.isArray(row?._lots)?row._lots:[]),warehouseCapture:store?.warehouseCapture??null};downloadDiagnosticFile(`simcompanies-manager-production-overlay-${realmDisplayNumber(realm)}-${diagnosticFileStamp()}.json`,payload);}catch(e){alert('Unable to download production/overlay diagnostics: '+(e?.message||String(e)));}});
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

document.querySelector('#clearStoredData')?.addEventListener('click',async()=>{if(!confirm('Clear all data stored by Sim Companies Manager?\n\nThis cannot be undone. Your Sim Companies account and game data will not be affected.\n\nIf you want a backup first, use Download Stored Data.')) return; const button=document.querySelector('#clearStoredData'); button.disabled=true; try{const result=await chrome.runtime.sendMessage({type:'CLEAR_EXTENSION_DATA'}); if(!result?.ok) throw new Error(result?.error||'Reset failed.'); alert('Stored data cleared. The Manager is starting fresh.'); window.location.reload();}catch(e){button.disabled=false; alert('Unable to clear stored data: '+(e?.message||String(e)));}});
document.addEventListener('click',async e=>{const b=e.target.closest('.diag-copy');if(!b)return;let s=await get();let text='';const type=b.dataset.copyJson;const realm=Number(s.viewRealm??s.authData?.authCompany?.realmId??s.authData?.authCompany?.realm);const realmKey=Number.isFinite(realm)?`realm:${realm}`:null;const ep=s.endpointData||{};const endpointEntries=Object.entries(ep).sort((a,c)=>new Date(c[1]?.receivedAt||0)-new Date(a[1]?.receivedAt||0));const matching=(rx)=>endpointEntries.filter(([k])=>rx.test(k)).map(([k,v])=>({endpoint:k,status:v?.status,receivedAt:v?.receivedAt,data:v?.data??null}));
if(type==='sync')text=JSON.stringify({page:'sync',realm:Number.isFinite(realm)?realm:null,syncStatus:s.syncStatus||null,syncError:s.syncError||null,fullSyncDiagnostics:s.fullSyncDiagnostics||null,endpointData:s.endpointData||{},apiEndpoints:s.apiEndpoints||[]},null,2);
else if(type==='warehouse')text=JSON.stringify(s.fullSyncDiagnostics?.warehouseCosts||[],null,2);
else if(type==='walk')text=JSON.stringify(s.fullSyncDiagnostics?.walkResults||[],null,2);
else if(type==='warehouse-page'){const costDetails=realmKey?s.warehouseCostDetails?.[realmKey]||{}:{};const vw=s.vwapData||{};text=JSON.stringify({page:'warehouse',realm:Number.isFinite(realm)?realm:null,warehouseRows:warehouseRows(s),sourcingCostCaptures:Object.values(costDetails).flatMap(v=>Array.isArray(v)?v:[]),warehouseDiagnostics:s.fullSyncDiagnostics?.warehouseCosts||[],vwapDataUpdatedAt:vw.fetchedAt||vw.updatedAt||s.vwapStatus?.vwapUpdatedAt||s.vwapStatus?.vwapFetchedAt||null,vwapDatasetCount:Array.isArray(vw.rows)?vw.rows.length:(Number(vw.count)||0),vwapSource:vw.source||'SimcoTools',endpoints:matching(/\/api\/v(?:2|3)\/(?:resources|warehouse|warehouse-resources)(?:\/|$)/i)},null,2);}
else if(type==='market-page'){text=JSON.stringify({page:'market',realm:Number.isFinite(realm)?realm:null,vwapData:s.vwapData||{},history:s.history||{},marketDebug:s.marketDebug||{},marketCache:s.marketCache||{},endpoints:matching(/market|orders|orderbook|vwap/i)},null,2);}
else if(type==='accounting-page'){text=JSON.stringify({page:'accounting',realm:Number.isFinite(realm)?realm:null,accounting:accounting(s),accountingSnapshots:s.accountingSnapshots||{},endpoints:matching(/accounting|balance-sheet|cash-flow|cashflow|profit|income-statement|financial/i)},null,2);}
else if(type==='contracts-page'){text=JSON.stringify({page:'contracts',realm:Number.isFinite(realm)?realm:null,currentContracts:currentContracts(s),contractEvents:s.contractEvents||[],endpoints:matching(/contracts-(?:incoming|outgoing)|warehouse-contracts-summary|contracts-history-(?:incoming|outgoing)/i)},null,2);}
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
// v2.5.330: every download shows a visible confirmation (alerts are easy to miss on Android).
function scmDownloadToast(name,bytes){try{let t=document.getElementById('scmToast');if(!t){t=document.createElement('div');t.id='scmToast';t.className='scm-toast';t.setAttribute('role','status');document.body.appendChild(t);}const kb=Number(bytes)>0?` (${Math.max(1,Math.round(bytes/1024)).toLocaleString()} KB)`:'';t.textContent=`⬇ Downloaded ${name}${kb} — check your Downloads folder`;t.classList.add('show');clearTimeout(scmDownloadToast.timer);scmDownloadToast.timer=setTimeout(()=>t.classList.remove('show'),5000);}catch{}}
function downloadDiagnosticFile(name,payload){
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();scmDownloadToast(a.download,blob.size);
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function diagnosticFileStamp(){return new Date().toISOString().replace(/[:.]/g,'-');}
async function buildDiagnosticBundle(s){
  const {realm,key,store}=diagnosticStore(s);
  const endpointEntries=Object.entries(store?.endpointData||{}).map(([url,v])=>({url,captureRealm:v?.captureRealm??null,status:v?.status??null,receivedAt:v?.receivedAt??null,data:v?.data??null}));
  const replayRaw=await chrome.storage.local.get(null);
  const replayChunkKeys=Object.keys(replayRaw||{}).filter(k=>String(k).startsWith('scmReplayChunk:')).sort();
  const replayEvents=replayChunkKeys.flatMap(k=>Array.isArray(replayRaw[k])?replayRaw[k]:[]);
  // v2.5.331 additions: environment + storage sizes (lag), endpoint index, production cost history, and the exact
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
    production:{buildings:store?.buildings??null,productionRateSnapshots:store?.productionRateSnapshots??{},productionPlans:store?.productionPlans??{},productionEvents:store?.productionEvents??[],productionHistoryAudit:plannerHistoryAuditExport(),productionHistoryComparison:productionHistoryComparisonExport(store||{}),backgroundJobHistory:store?.backgroundJobHistory??[],productionRunHours:store?.productionRunHours??24,history:store?.history??{}},
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
    <div><span>Sync error</span><strong>${escapeHtml(store?.syncError||'None')}</strong></div>
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
      return `<tr><td>${escapeHtml(r.name||resourceName({kind:r.id},store||{}))}</td><td>${r.id??'—'}</td><td>Q${r.quality??'—'}</td><td>${num(r.warehouse)}</td><td>${num(r.produced)}</td><td>${num(r.demand)}</td><td>${num(r.leftover)}</td><td><span class="diagnostic-pill ${flag}">${escapeHtml(flag)}</span></td></tr>`;
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
    const costRows=warehouseRowsNow.map(r=>`<tr><td>${escapeHtml(resourceName(r,store||{}))}</td><td>Q${r._quality}</td><td>${num(r._qty)}</td><td>${r._unitCost==null?'—':money(r._unitCost)}</td></tr>`).join('');
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
  const rows=financialEntries(cf,exclude);
  return rows.length?`<div class="statement-grid">${statementTable('Cash Flow Fields',rows.slice(0,40))}</div>`:'<p class="muted">The cash-flow endpoint was captured, but it did not expose numeric summary fields.</p>';
}
function accountingIncomeStatement(src){
  if(!src||typeof src!=='object')return '<p class="muted">No income statement response captured yet.</p>';
  const exclude=new Set(['data','rows','items','entries','transactions','results','isComputed']);
  const rows=financialEntries(src,exclude);
  return rows.length?`<div class="statement-grid">${statementTable('Income Statement Fields',rows.slice(0,60))}</div>`:'<p class="muted">No readable income-statement summary fields were captured.</p>';
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
  s=s||{}; s.endpointData=s.endpointData||{}; commitDashboardState(s); updateRealmSwitcher(s); renderLiveMarketProduct(s); if(activeTab==='diagnostic')renderFullSyncDiagnostics(s);
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
 const rows=warehouseRows(s);const history=recordHistory(s,rows);
 $('#title').textContent=d.company||'Company Manager';const buildEl=$('#managerBuild');if(buildEl)buildEl.textContent=`Build ${BUILD_VERSION}`;const realm=viewRealm!=null?viewRealm:(d.realmId!=null?d.realmId:d.realm);const realmEl=$('#realmInfo');if(realmEl)realmEl.textContent=realm!=null?realmName(realm):'Realm —';const syncEl=$('#syncInfo');if(syncEl){const liveStatus=s.syncStatus||'';const liveError=s.syncError||'';const hasCapturedData=!!(viewStore&&(viewStore.lastSync||viewStore.fullSyncDiagnostics||viewStore.gameOverlaySnapshot||(Array.isArray(viewStore.buildings)&&viewStore.buildings.length)||(Array.isArray(viewStore.warehouseResources)&&viewStore.warehouseResources.length)||(viewStore.endpointData&&Object.keys(viewStore.endpointData).length)||(viewStore.productionRateSnapshots&&Object.keys(viewStore.productionRateSnapshots).length)));if(__realmHydrationPending&&viewRealm!=null) syncEl.textContent=`Switching to ${realmName(viewRealm)}…`;else if(liveStatus&&(liveStatus.startsWith('R1 Sync:')||liveStatus.startsWith('R2 Sync:'))) syncEl.textContent=liveStatus;else if(liveError) syncEl.textContent=`${liveStatus||'Error'}: ${liveError}`;else if(viewStore?.lastSync) syncEl.textContent=`Last sync ${new Date(viewStore.lastSync).toLocaleString()} · ${viewStore.syncStatus||'OK'}`;else if(viewRealm!=null&&hasCapturedData) syncEl.textContent='Captured data available · Sync not completed';else if(viewRealm!=null) syncEl.textContent='No data captured for this realm';else syncEl.textContent='No sync yet';}
 const contractRows=currentContracts(s); const incomingGross=contractRows.filter(c=>c.direction==='Incoming').reduce((sum,c)=>sum+(Number(c.total)||0),0); const outgoingGross=contractRows.filter(c=>c.direction==='Outgoing').reduce((sum,c)=>sum+(Number(c.total)||0),0); const savedRows=savedContracts(s); const savedGross=savedRows.reduce((sum,c)=>sum+(Number(c.total)||0),0); const buildingCount=buildingArrayFromState(s).length; const warehouseQty=rows.reduce((sum,r)=>sum+(Number(r._qty)||0),0); const vwapCount=Array.isArray(s.vwapData?.rows)?s.vwapData.rows.length:Number(s.vwapData?.count)||0; const topSelling=topSellingResourcesByProfit(accountingDisplayBase,s); const topGross=topGrossResources(accountingDisplayBase,s); const overviewDate=v=>{const d=v!=null?new Date(v):null;return d&&Number.isFinite(d.getTime())?d.toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}):null;}; const overviewRange=overviewDate(topSelling.rangeStart)&&overviewDate(topSelling.rangeEnd)?`${overviewDate(topSelling.rangeStart)} – ${overviewDate(topSelling.rangeEnd)}`:'Captured range unavailable'; const overviewCards=$('#overviewCards'); if(overviewCards) overviewCards.innerHTML=`<div class="overview-grid">
<div class="overview-section overview-operations-card"><div class="overview-section-head"><div><h3>Operations</h3><span>Company activity at a glance</span></div></div><div class="overview-stat-grid"><div class="overview-stat-card"><span>Buildings</span><strong>${buildingCount||'—'}</strong></div><div class="overview-stat-card"><span>Warehouse Lines</span><strong>${rows.length||'—'}</strong></div><div class="overview-stat-card"><span>Warehouse Qty</span><strong>${warehouseQty?num(warehouseQty):'—'}</strong></div><div class="overview-stat-card"><span>VWAP Values</span><strong>${vwapCount?num(vwapCount):'—'}</strong></div></div></div>
<div class="overview-section"><div class="overview-section-head"><div><h3>Contracts</h3><span>Current active and saved value</span></div></div><div class="overview-stat-grid overview-stat-grid-compact"><div class="overview-stat-card"><span>Incoming</span><strong>${money(incomingGross)}</strong><small>${contractRows.filter(c=>c.direction==='Incoming').length} active</small></div><div class="overview-stat-card"><span>Outgoing</span><strong>${money(outgoingGross)}</strong><small>${contractRows.filter(c=>c.direction==='Outgoing').length} active</small></div><div class="overview-stat-card"><span>Saved</span><strong>${money(savedGross)}</strong><small>${savedRows.length} saved</small></div></div></div>
<div class="overview-resource-ranking-stack"><div class="overview-section overview-top-selling"><div class="overview-section-head"><div><h3>Top 10 Net Profit Resources</h3><span>Captured selling profit · ${escapeHtml(overviewRange)}</span></div><span class="overview-section-badge">Net Profit</span></div><div class="overview-selling-list">${topSelling.loading?'<div class="overview-selling-empty">Loading weekly sales ledger…</div>':topSelling.items.length?topSelling.items.map(x=>{const srcs=x.image?[x.image,...x.images.filter(v=>v!==x.image)]:x.images;const img=srcs.length?`<img class="overview-resource-icon" src="${escapeHtml(srcs[0])}" data-candidates="${escapeHtml(JSON.stringify(srcs))}" data-idx="0" alt="" loading="lazy" data-scm-fallback="1">`:'';return `<div class="overview-selling-row"><span class="overview-rank">${x.rank}</span>${img}<span class="overview-selling-name">${escapeHtml(x.name)}</span><span class="overview-selling-quantity"><small>Qty sold</small><strong>${num(x.amount)}</strong></span><span class="overview-selling-profit"><small>Net Profit</small><strong>${money(x.profit)}</strong></span></div>`}).join(''):'<div class="overview-selling-empty">No selling profit data captured yet.</div>'}</div></div>
<div id="overviewTopGross" class="overview-section overview-top-selling"><div class="overview-section-head"><div><h3>Top 10 Gross Resources</h3><span>Captured sales value · ${escapeHtml(overviewDate(topGross.rangeStart)&&overviewDate(topGross.rangeEnd)?`${overviewDate(topGross.rangeStart)} – ${overviewDate(topGross.rangeEnd)}`:'Captured range unavailable')}</span></div><span class="overview-section-badge">Gross</span></div><div class="overview-selling-list">${topGross.loading?'<div class="overview-selling-empty">Loading weekly sales ledger…</div>':topGross.items.length?topGross.items.map(x=>{const srcs=x.image?[x.image,...x.images.filter(v=>v!==x.image)]:x.images;const img=srcs.length?`<img class="overview-resource-icon" src="${escapeHtml(srcs[0])}" data-candidates="${escapeHtml(JSON.stringify(srcs))}" data-idx="0" alt="" loading="lazy" data-scm-fallback="1">`:'';return `<div class="overview-selling-row"><span class="overview-rank">${x.rank}</span>${img}<span class="overview-selling-name">${escapeHtml(x.name)}</span><span class="overview-selling-quantity"><small>Qty sold</small><strong>${num(x.amount)}</strong></span><span class="overview-selling-profit"><small>Gross</small><strong>${money(x.gross)}</strong></span></div>`}).join(''):'<div class="overview-selling-empty">No gross sales data captured yet.</div>'}</div></div></div>`; if($('#overviewRealmBadge')){const syncTime=viewStore?.lastSync||s.lastSync;const hasCapturedData=!!(viewStore&&(viewStore.lastSync||viewStore.fullSyncDiagnostics||viewStore.gameOverlaySnapshot||(Array.isArray(viewStore.buildings)&&viewStore.buildings.length)||(Array.isArray(viewStore.warehouseResources)&&viewStore.warehouseResources.length)||(viewStore.endpointData&&Object.keys(viewStore.endpointData).length)||(viewStore.productionRateSnapshots&&Object.keys(viewStore.productionRateSnapshots).length)));const badgeStatus=__realmHydrationPending?'Switching…':syncTime?new Date(syncTime).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):(hasCapturedData?'Captured · sync not completed':'Not synced');$('#overviewRealmBadge').textContent=`${realm!=null?realmName(realm):'Realm —'} · ${badgeStatus}`; } if($('#accountingSource')){const period=accountingDisplay.period?.dateFrom&&accountingDisplay.period?.date?` · ${new Date(accountingDisplay.period.dateFrom).toLocaleDateString()}–${new Date(accountingDisplay.period.date).toLocaleDateString()}`:(accountingDisplay.period?.date?` · ${new Date(accountingDisplay.period.date).toLocaleDateString()}`:''); $('#accountingSource').textContent=`Source: ${a.sourceType==='income-statement'?'income statement':a.sourceType==='cash-flow-derived'?'cash-flow statement':'unavailable'}${period}`;} if($('#accountingPeriodBadge')){const badge=$('#accountingPeriodBadge'),dateEl=$('#accountingPeriodDate'),metaEl=$('#accountingPeriodMeta');document.querySelectorAll('[data-accounting-period]').forEach(x=>x.classList.toggle('active',String(x.dataset.accountingPeriod||'current')===accountingPeriodView));const labels={current:'Current',day:'Day',week:'Week',month:'Month'};if(dateEl)dateEl.textContent=labels[accountingPeriodView]||'Current';if(metaEl)metaEl.textContent=accountingDisplay.periodSource==='recent-cashflow'?`Derived from captured cash-flow rows · ${Number(accountingDisplay.periodTransactionCount)||0} transactions`:'Game accounting view';} if($('#accountingLiveStatus')){
   const accountingEndpoint=/\/api\/(?:v2|v3)\/companies\/(?:me|\d+)\/(?:balance-sheet|cashflow(?:\/recent)?|cashflow-statement|income-statement|past-finances-overview|administration-overhead|past-finances)(?:\/\d+)?\/?$/i;
   const accountingTimes=Object.entries(s.endpointData||{})
     .filter(([url,v])=>accountingEndpoint.test(url)&&Number(v?.status)===200&&v?.data!=null)
     .map(([,v])=>Date.parse(v?.receivedAt||''))
     .filter(Number.isFinite)
     .sort((x,y)=>y-x);
   const latestTime=accountingTimes[0]||null;
   $('#accountingLiveStatus').textContent=latestTime
     ?`Last updated: ${new Date(latestTime).toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'})}`
     :'Waiting for latest financial response';
} if($('#accountingOverview'))$('#accountingOverview').innerHTML=accountingOverview(accountingDisplay,accountingPeriodView==='current'?accountingComparisonBase(a):null); if($('#accountingHistory')){$('#accountingHistory').innerHTML=accountingHistoryTable(a.history);scmApplyCollapse($('#accountingHistory'));} if($('#accountingBalanceSummary'))$('#accountingBalanceSummary').innerHTML=`<div class="overview-stat-grid accounting-balance-summary"><div class="overview-stat-card"><span>Cash</span><strong>${money(a.cash)}</strong></div><div class="overview-stat-card"><span>Accounts Receivable</span><strong>${money(a.accountsReceivable)}</strong></div><div class="overview-stat-card"><span>Inventory</span><strong>${money(a.inventory)}</strong></div><div class="overview-stat-card"><span>Current Assets</span><strong>${money(a.currentAssets)}</strong></div><div class="overview-stat-card"><span>Accounts Payable</span><strong>${money(a.accountsPayable)}</strong></div><div class="overview-stat-card"><span>Bonds Payable</span><strong>${money(a.bondsPayable)}</strong></div><div class="overview-stat-card"><span>Current Liabilities</span><strong>${money(a.currentLiabilities)}</strong></div><div class="overview-stat-card"><span>Total Assets</span><strong>${money(a.assets)}</strong></div><div class="overview-stat-card"><span>Total Liabilities</span><strong>${money(a.liabilities)}</strong></div></div>`; if($('#accountingCashflowSummary'))$('#accountingCashflowSummary').innerHTML=accountingCashflowSummary(a.source?.cf); if($('#accountingIncomeStatement'))$('#accountingIncomeStatement').innerHTML=accountingIncomeStatement(a.source?.income); if($('#balanceDetails'))$('#balanceDetails').innerHTML=buildBalanceSections(a.source?.bs);
 renderWarehouseMarketTimestamp(s); try{renderWarehouseRunOut(s);}catch(e){console.error('Run-out render failed',e);} const inventoryRowsEl=$('#inventoryRows'); if(inventoryRowsEl) inventoryRowsEl.innerHTML=rows.length?rows.map(r=>{const marketPrice=cachedMarketPrice(s,r._id,r._quality);const margin=marketPrice!=null&&r._unitCost>0?(marketPrice-r._unitCost)/r._unitCost*100:null;const ri=resourceInfo(r,s);const imgs=ri.imageCandidates||[];const localImage=s.resourceImageCache?.[String(r._id)]||s.resourceImageData?.[String(r._id)]||null;if(!localImage) requestResourceImage(r._id);const srcs=localImage?[localImage,...imgs]:imgs;const img=srcs.length?`<img class="resource-icon" src="${escapeHtml(srcs[0])}" data-candidates="${escapeHtml(JSON.stringify(srcs))}" data-idx="0" alt="" loading="lazy" data-scm-fallback="1">`:'';const activeCost=activeProductionCostCells(s,r);return `<tr data-warehouse-key="${Number(r._id)}:${Number(r._quality)}"><td><div class="product-cell">${img}<span><strong>${resourceName(r,s)}</strong><small>#${r._id}</small></span></div>${warehouseHeadCost(r)}</td><td>${num(r._qty)}</td><td>${r._quality??'—'}</td><td>${r._unitCost==null?'—':money(r._unitCost)}</td><td>${activeCost.costHtml}</td><td>${activeCost.diffHtml}</td><td data-cell="prod-cost-history">${productionCostHistoryCell(s,r)}</td><td><span class="cell-stack">${marketPrice==null?'—':money(marketPrice)}<small class="market-source">${marketPrice==null?'Market price not captured':'Current market price'}</small></span></td><td class="${margin==null?'':margin>=0?'positive':'negative'}">${margin==null?'—':margin.toFixed(1)+'%'}</td></tr>`}).join(''):'<tr><td colspan="9">No warehouse data captured.</td></tr>';
 if(activeTab==='overview'&&$('#cashflowDetails'))$('#cashflowDetails').innerHTML=buildCashflowSections(a.source?.cf,a.source?.recent); if(activeTab==='market'){ renderLiveMarketProduct(s); renderMarketHistory(s); renderMarketAlerts(s); } if(activeTab==='production') renderBuildingPlanner(s);
 renderVwapDiagnostics(s);
 const rawEl=$('#raw'); if(rawEl) rawEl.textContent=JSON.stringify({auth:s.authData,warehouseCount:rows.length,accounting:a,marketEndpointCount:Object.keys(s.endpointData||{}).filter(k=>/\/market\//.test(k)).length,marketCacheResources:Object.keys(s.marketCache||{}).length,marketDebug:s.marketDebug||{}},null,2).slice(0,30000);
 if(activeTab==='tools'){try{globalThis.SCM_TOOLS_UI?.render(s,catalogEntries(s));}catch(e){console.error('Tools tab render failed',e);}} if(activeTab==='contracts') { populateContractProducts(s); renderContracts(s); } if(activeTab==='diagnostic'){ renderApiList(s); renderDiagnostics(s); }
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
  // Contract comparison uses the captured current market price for the exact
  // resource and quality. Never substitute VWAP or a stale contract quote.
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
function savedContractWarehouseQuantity(c,s){
  const key=savedContractProductKey(c);if(!key)return 0;
  return warehouseRows(s).filter(r=>Number(r?._id)===key.id&&Number(r?._quality)===key.quality).reduce((n,r)=>n+Math.max(0,Number(r?._qty)||0),0);
}
function savedContractPlanForState(s){
  const realm=Number(s?.viewRealm??s?.selectedRealm??s?.captureRealm??s?.authData?.authCompany?.realmId);
  const store=Number.isFinite(realm)?s?.realmStores?.[`realm:${realm}`]:null;
  return s?.frozenNetworkPlan||store?.frozenNetworkPlan||null;
}
function savedContractSurplusMap(s){
  const plan=savedContractPlanForState(s);
  const core=globalThis.SCMPlannerCore;
  // If the current plan rows exist, their computed result is authoritative even
  // when a resource has zero surplus. Do not revive a stale cached positive row.
  if(core?.productionSurplusByKey&&Array.isArray(plan?.productionRows)&&Array.isArray(plan?.demandRows)){
    return core.productionSurplusByKey(plan.productionRows,plan.demandRows);
  }
  const fallback=new Map();
  for(const row of (Array.isArray(plan?.surpluses)?plan.surpluses:[])){
    const id=Number(row?.id),quality=Number(row?.quality)||0,value=Number(row?.surplus);
    if(Number.isFinite(id)&&id>0&&Number.isFinite(value))fallback.set(`${id}:${quality}`,Math.max(0,value));
  }
  return fallback;
}
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
function savedContractBaseBalanceMap(s){
  const realm=Number(s?.viewRealm??s?.selectedRealm??s?.captureRealm??s?.authData?.authCompany?.realmId);
  const realmStore=Number.isFinite(realm)?s?.realmStores?.[`realm:${realm}`]:null;
  let snapshot=s?.gameOverlaySnapshot;
  if(Number.isFinite(realm)&&snapshot&&Number(snapshot.realm)!=realm)snapshot=null;
  if(!Array.isArray(snapshot?.rows))snapshot=realmStore?.gameOverlaySnapshot||null;
  const balances=new Map();
  for(const row of (Array.isArray(snapshot?.rows)?snapshot.rows:[])){
    const id=Number(row?.id),quality=Math.max(0,Number(row?.quality)||0);
    if(!Number.isFinite(id)||id<=0)continue;
    const warehouse=Number(row?.warehouse),demand=Number(row?.demand);
    const base=(Number.isFinite(warehouse)?warehouse:0)-(Number.isFinite(demand)?demand:0);
    balances.set(`${id}:${quality}`,base);
  }
  // Include held stock for keys that have not yet appeared in an overlay row.
  // This fallback is current warehouse data, not a prior calculated Difference.
  const sourceState=realmStore?{...s,...realmStore}:s;
  for(const row of warehouseRows(sourceState)){
    const id=Number(row?._id),quality=Math.max(0,Number(row?._quality)||0);
    if(!Number.isFinite(id)||id<=0)continue;
    const key=`${id}:${quality}`;
    if(!balances.has(key))balances.set(key,Math.max(0,Number(row?._qty)||0));
  }
  return balances;
}
function savedContractResolvedQuantityMap(s){
  // Recompute from the current stock/demand/production inputs on each render.
  // Do not cache by state-object identity: nested warehouse/surplus snapshots can
  // be refreshed while a page remains open.
  const core=globalThis.SCMPlannerCore;
  const contracts=savedContracts(s);
  return core?.resolveSavedContractQuantities
    ?core.resolveSavedContractQuantities({savedContracts:contracts,baseBalanceByKey:savedContractBaseBalanceMap(s),surplusByKey:savedContractSurplusMap(s)})
    :new Map();
}
function savedContractLeftQuantity(c,s){
  const quantities=savedContractResolvedQuantityMap(s);
  return quantities.has(c)?Math.max(0,Number(quantities.get(c))||0):0;
}
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
async function ensureSavedContractsKey(s){
  // Never promote captured live API contracts into Manager-saved contracts.
  if(!Array.isArray(s?.savedContracts))await saveRealmField('savedContracts',[],s);
}
function contractMarketPrice(c,s){
  const parsed=String(c?.product??'').trim().match(/^(\d+)(?::(\d+))?$/);
  const id=Number(c?.productId!=null?c.productId:(parsed?parsed[1]:NaN));
  const quality=Number(c?.quality!=null?c.quality:(parsed?parsed[2]??0:NaN));
  if(!Number.isFinite(id)||id<=0||!Number.isFinite(quality))return null;
  return exactMarketPrice(buildMarketPriceMap(s),id,quality);
}
function contractMarketDiscount(c,s){const price=Number(c?.price),marketPrice=contractMarketPrice(c,s);if(!Number.isFinite(price)||!Number.isFinite(marketPrice)||marketPrice<=0)return null;return (price-marketPrice)/marketPrice*100;}
function contractDiscountHtml(c,s,saved){
  const value=saved?Number(c?.discount):contractMarketDiscount(c,s);
  if(!Number.isFinite(value))return '—';
  let cls='';
  if(!saved && String(c?.direction)==='Incoming'){
    cls=value<0?'contract-discount-good':value>0?'contract-discount-bad':'';
  }
  const sign=!saved&&value>0?'+':'';
  return `<span class="${cls}">${sign}${value.toFixed(2)}%</span>`;
}
function contractRow(c,s, saved=false, includeDirection=true){const effectiveQty=saved?savedContractEffectiveQuantity(c,s):Number(c.quantity)||0;const qtyText=saved?savedContractQuantityLabel(c,s):num(c.quantity);const qtyLabel=c.count>1?`${qtyText} (${c.count} contracts)`:qtyText;const rowTotal=saved?roundCurrencyUp((Number(c.price)||0)*effectiveQty):(Number(c.total)||0);const productParts=String(c.product||'').match(/^(\d+)(?::(\d+))?$/);const pid=Number.isFinite(Number(c.productId))?Number(c.productId):(productParts?Number(productParts[1]):null);const pq=Number.isFinite(Number(c.quality))?Number(c.quality):(productParts?Number(productParts[2]):null);const info=pid!=null?resourceInfo({kind:pid,quality:pq},s||{}):{imageCandidates:[]};const src=(info.imageCandidates||[])[0]||'';const image=src?`<img class="contract-product-icon" src="${escapeHtml(src)}" alt="" loading="lazy">`:'';const productLabel=saved&&pid!=null?resourceName({kind:pid,quality:pq},s||{}):(c.productName||c.product||'—');return `<tr>${includeDirection?`<td>${escapeHtml(c.direction||'—')}</td>`:''}<td>${escapeHtml(c.company||'—')}</td><td class="contract-product-cell">${image}<span>${escapeHtml(productLabel)}</span></td><td>${qtyLabel}</td><td>${c.quality??'—'}</td><td>${contractMarketPrice(c,s)==null?'—':money(contractMarketPrice(c,s))}</td><td>${contractDiscountHtml(c,s,saved)}</td><td>${contractPriceMoney(c.price)}</td><td>${money(rowTotal)}</td>${saved?`<td><button class="saved-edit" data-id="${escapeHtml(c.id||'')}">Edit</button> <button class="danger saved-delete" data-id="${escapeHtml(c.id||'')}">Delete</button></td>`:''}</tr>`}
function renderApiList(s){
  const el=$('#apiList');
  if(!el)return;
  const catalog=Array.isArray(s?.apiEndpoints)?s.apiEndpoints:[];
  if(!catalog.length){
    el.innerHTML='<div class="status">No live API endpoints captured yet.</div>';
    return;
  }
  const rows=catalog.slice().sort((a,b)=>new Date(b.seenAt||0)-new Date(a.seenAt||0));
  el.innerHTML=rows.map(item=>{
    const url=String(item?.url||'');
    const method=String(item?.method||'GET').toUpperCase();
    const d=(s.endpointData||{})[url]||{};
    const status=Number(d.status)||0;
    const suffix=status?`<span>${status}</span>`:'';
    return `<div class="api-row"><code>${escapeHtml(method)} ${escapeHtml(url)}</code>${suffix}</div>`;
  }).join('');
}
function contractSurplusAfterOutgoing(s, owned, recipes, rates){
  // Contracts are displayed as signed net inventory impact: outgoing (+) uses stock; incoming (-) adds stock.
  const runHours=Math.min(48,Math.max(1,Number(s?.productionRunHours)||24));
  const network=plannerProductionNetwork(s,owned,recipes,rates,runHours,{});
  const warehouseRowsForCore=warehouseRows(s).map(r=>({id:r._id,quality:r._quality,amount:warehouseQuantity(r)}));
  const productionRows=[];
  const demandRows=[];
  for(const b of (network.activeBuildings||[])){
    if(Number.isFinite(Number(b.outputRun))&&Number(b.outputRun)>0){
      const rec=recipes.find(r=>plannerNormalizeName(r.name)===plannerNormalizeName(b.product));
      if(rec) productionRows.push({id:rec.id,quality:b.quality,amount:b.outputRun});
    }
    for(const input of (b.inputs||[])){
      if(Number.isFinite(Number(input.id))&&Number(input.required)>0) demandRows.push({id:Number(input.id),minQuality:Number(input.minQuality)||0,amount:Number(input.required)||0});
    }
  }
  const outgoingSaved=savedContracts(s).filter(c=>String(c.direction||'').trim().toLowerCase()==='outgoing');
  const incomingSaved=savedContracts(s).filter(c=>String(c.direction||'').trim().toLowerCase()==='incoming');
  const incomingById=new Map();
  const incomingRows=[];
  for(const c of incomingSaved){
    const raw=String(c.product??'').trim();
    const parsed=raw.match(/^(\d+)(?::(\d+))?$/);
    const id=Number(c.productId!=null?c.productId:(parsed?parsed[1]:null));
    const quality=Math.max(0,Number(c.quality!=null?c.quality:(parsed?parsed[2]:0))||0);
    const qty=savedContractEffectiveQuantity(c,s);
    if(Number.isFinite(id)&&id>0&&qty>0){
      incomingById.set(id,(incomingById.get(id)||0)+qty);
      incomingRows.push({id,quality,amount:qty});
    }
  }
  const contractRows=[];
  const leftCandidates=[];
  for(const c of outgoingSaved){
    const raw=String(c.product??'').trim();
    const parsed=raw.match(/^(\d+)(?::(\d+))?$/);
    const id=Number(c.productId!=null?c.productId:(parsed?parsed[1]:null));
    const quality=Math.max(0,Number(c.quality!=null?c.quality:(parsed?parsed[2]:0))||0);
    const mode=savedContractQuantityMode(c);
    const qty=mode==='surplus'?savedContractProductionSurplusQuantity(c,s):mode==='left'?0:Number(c.quantity)||0;
    if(Number.isFinite(id)&&id>0&&qty>0)contractRows.push({id,quality,amount:qty});
    if(Number.isFinite(id)&&id>0&&mode==='left')leftCandidates.push({c,id,quality});
  }
  const calcCore=(rows)=>globalThis.SCMPlannerCore?.balanceSupplyDemandContracts
    ?globalThis.SCMPlannerCore.balanceSupplyDemandContracts({warehouseRows:warehouseRowsForCore,productionRows,demandRows,contractRows:rows,incomingContractRows:incomingRows})
    :[];
  let coreRows=calcCore(contractRows);
  if(leftCandidates.length){
    const additions=[];const assigned=new Set();
    for(const item of leftCandidates){
      const key=`${item.id}:${item.quality}`;if(assigned.has(key))continue;
      const base=coreRows.find(r=>Number(r.id)===item.id);
      const amount=Math.max(0,Number(base?.leftover)||0);
      if(amount>0){additions.push({id:item.id,quality:item.quality,amount});assigned.add(key);}
    }
    if(additions.length)coreRows=calcCore([...contractRows,...additions]);
  }
  const rowsById=new Map(coreRows.map(r=>[Number(r.id),r]));
  for(const [id,incomingQty] of incomingById.entries()){
    if(!rowsById.has(id)){
      const warehouse=warehouseRowsForCore.filter(r=>Number(r.id)===id).reduce((n,r)=>n+Math.max(0,Number(r.amount)||0),0);
      rowsById.set(id,{id,warehouse,produced:0,demand:0,contracted:0,leftover:incomingQty+warehouse,warehouseOnlyLeft:warehouse});
    }
  }
  const rows=[...rowsById.values()].map(r=>{
    const incoming=Number(incomingById.get(Number(r.id))||0);
    const outgoing=Number(r.contracted)||0;
    // The Contracts column is a signed net inventory impact:
    // outgoing consumes stock (+), incoming supplies stock (-).
    const netContracts=outgoing-incoming;
    const warehouse=Number(r.warehouse)||0;
    const demand=Number(r.demand)||0;
    const displayedLeft=warehouse-demand-netContracts;
    const info=resourceInfo({kind:r.id},s||{});
    return {...r,incoming,contracted:netContracts,leftover:displayedLeft,warehouseOnlyLeft:warehouse-demand,
      name:info.name||plannerResourceNameById(recipes,r.id,s),quality:null};
  });
  return {runHours,rows:rows.filter(r=>Math.abs(r.leftover)>1e-9||Math.abs(r.incoming)>1e-9||r.warehouse>1e-9||r.produced>1e-9||r.demand>1e-9||Math.abs(r.contracted)>1e-9)};
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
    const owned=ownedPlannerBuildings(s,data.buildings||[]);
    if(!owned.length||!Array.isArray(data.recipes)||!data.recipes.length){
      body.innerHTML='<tr><td colspan="5">Production data is not available yet.</td></tr>';
      body.dataset.ready='1';
      return;
    }
    const result=contractSurplusAfterOutgoing(s,owned,data.recipes,data.rates||{});
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
// v2.5.343 current government orders (/api/v3/government-orders/<realm>/) with the amount at your tier
// (/government-orders/tier/: game = ceil(amountBase × resourceMultiplicator)) and your stock at that quality or better.
function renderGovernmentOrders(s){
  const sec=document.getElementById('contracts');if(!sec)return;
  let box=document.getElementById('govOrders');
  const realm=validRealmNumber(s?.viewRealm??s?.captureRealm),ep=s?.endpointData||{};
  const orders=realm!=null?ep[`/api/v3/government-orders/${realm}/`]?.data?.governmentOrders:null;
  const mult=Number(ep['/api/v3/government-orders/tier/']?.data?.tier?.resourceMultiplicator);
  if(!Array.isArray(orders)||!orders.length){if(box)box.remove();return;}
  if(!box){box=document.createElement('div');box.id='govOrders';box.className='gov-orders';sec.appendChild(box);}
  let rows=[];try{rows=warehouseRows(s);}catch{}
  const have=(id,q)=>rows.filter(r=>Number(r?._id)===Number(id)&&Number(r?._quality)>=Number(q)).reduce((a,r)=>a+(Number(r._qty)||0),0);
  const title=k=>String(k||'').toLowerCase().replace(/_/g,' ').replace(/^./,c=>c.toUpperCase());
  const at=Date.parse(String(ep[`/api/v3/government-orders/${realm}/`]?.receivedAt||''));
  box.dataset.collapse='contracts:gov';box.innerHTML=`<h3 data-collapse-head>Government orders</h3><p class="gov-sub">${Number.isFinite(mult)?`Amounts at your tier (×${num(+mult.toFixed(3))})`:'Base amounts (tier not captured yet)'}${Number.isFinite(at)?` · ${plannerAge(Date.now()-at)}`:''}</p>`+orders.map(o=>{
    const req=(Array.isArray(o?.governmentorderrequiredresourceSet)?o.governmentorderrequiredresourceSet:[]).map(r=>{
      const need=Number.isFinite(mult)?Math.max(1,Math.ceil(Number(r.amountBase)*mult)):Number(r.amountBase),got=have(r.kind,r.quality);
      return `<div class="gov-row"><span>${escapeHtml(resourceInfo({kind:Number(r.kind)},s).name||`#${r.kind}`)} Q${num(r.quality)}</span><span class="${got>=need?'gov-ok':'gov-short'}">${num(got)} / ${num(need)}</span></div>`;}).join('');
    return `<div class="gov-card" data-collapse="gov:${escapeHtml(String(o?.projectKey||''))}"><div class="gov-head" data-collapse-head><strong>${escapeHtml(title(o?.projectKey))}</strong><span>${num(o?.daysToFulfill)} days</span></div>${req}</div>`;
  }).join('');
  scmApplyCollapse(box);
}
function renderContracts(s){
  try{
  const rows=currentContracts(s);
  const incoming=rows.filter(c=>String(c.direction)==='Incoming');
  const outgoing=rows.filter(c=>String(c.direction)==='Outgoing');
  const total=list=>roundCurrencyUp(list.reduce((sum,c)=>sum+(Number(c.total)||0),0));
  const incomingGross=total(incoming), outgoingGross=total(outgoing);
  const saved=savedContracts(s);
  const savedIncoming=saved.filter(c=>String(c.direction||'').trim().toLowerCase()==='incoming');
  const savedOutgoing=saved.filter(c=>String(c.direction||'').trim().toLowerCase()==='outgoing');
  const savedTotal=list=>roundCurrencyUp(list.reduce((sum,c)=>sum+roundCurrencyUp((Number(c.price)||0)*savedContractEffectiveQuantity(c,s)),0));
  const savedIncomingGross=savedTotal(savedIncoming), savedOutgoingGross=savedTotal(savedOutgoing);
  // Saved-contract totals are directional financial flows from the player's perspective:
  // Outgoing contracts are sales/income; Incoming contracts are purchases/expense.
  // Therefore All is net income: outgoing income minus incoming expense.
  const savedGross=savedOutgoingGross-savedIncomingGross;
  const setRows=(selector,list,colspan,message)=>{const el=$(selector);if(!el)return;const saved=selector==='#savedContractRows';el.innerHTML=list.length?list.map(c=>contractRow(c,s,saved,saved)).join(''):`<tr><td colspan="${colspan}">${message}</td></tr>`;};
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
  rows.forEach(r=>{const key=`${r._id}:${r._quality}`;if(seen.has(key))return;seen.add(key);const marketPrice=exactMarketPrice(buildMarketPriceMap(s),r._id,r._quality);const mwap=marketPrice;options.push({key,id:r._id,quality:r._quality,mwap,name:resourceName(r,s)});});
  const signature=options.map(o=>`${o.key}|${o.mwap??''}|${o.name}`).join('||');
  if(el.dataset.optionsSig!==signature){
    const html=['<option value="">Select warehouse product</option>',...options.map(o=>`<option value="${escapeHtml(o.key)}" data-id="${o.id}" data-quality="${o.quality}" data-mwap="${o.mwap??''}">${escapeHtml(o.name)} · Q${o.quality}</option>`)].join('');
    el.innerHTML=html;
    el.dataset.optionsSig=signature;
  }
  if(current&&[...el.options].some(o=>o.value===current))el.value=current;
}
function syncContractQuantityUI(){
  const modeEl=$('#contractQuantityMode');const qtyEl=$('#contractQuantity');if(!modeEl||!qtyEl)return;
  const mode=String(modeEl.value||'');const custom=mode==='custom';qtyEl.classList.toggle('hidden',!custom);qtyEl.required=custom;qtyEl.disabled=!custom;if(!custom)qtyEl.value='';
}
function getContractQuantityMode(){return String($('#contractQuantityMode')?.value||'');}
function getContractDiscountValue(){const select=$('#contractDiscount');const raw=String(select?.value??'');if(raw==='custom'){const custom=Number($('#contractDiscountCustom')?.value);return Number.isFinite(custom)&&custom>=0&&custom<=100?custom:null;}const value=Number(raw);return Number.isFinite(value)&&value>=0&&value<=10?value:null;}
function syncContractDiscountUI(){const custom=$('#contractDiscountCustom');if(!custom)return;const isCustom=String($('#contractDiscount')?.value)==='custom';custom.classList.toggle('hidden',!isCustom);if(!isCustom)custom.value='';}
function updateContractPrice(force=false){syncContractDiscountUI();const mwap=Number($('#contractMwap')?.value), discount=getContractDiscountValue();const price=$('#contractPrice');if(!price)return;const calculated=Number.isFinite(mwap)&&mwap>0&&Number.isFinite(discount)?mwap*(1-discount/100):null;if(force||price.dataset.manual!=='1')price.value=calculated!=null?roundCurrencyUp(calculated).toFixed(2):'';}
function resetContractEditor(){const f=$('#contractForm');if(!f)return;f.reset();delete f.dataset.editId;const save=f.querySelector('button[type="submit"]');if(save)save.textContent='Save Contract';const cancel=$('#cancelContractEdit');if(cancel)cancel.classList.add('hidden');$('#contractDiscount').value='';$('#contractDiscountCustom').value='';$('#contractQuantityMode').value='';$('#contractQuantity').value='';syncContractQuantityUI();syncContractDiscountUI();updateContractPrice();}
function startContractEdit(c){
  const f=$('#contractForm');if(!f)return;f.classList.remove('hidden');f.dataset.editId=String(c.id||'');
  const product=$('#contractProduct');product.value=String(c.product||'');
  const o=product.selectedOptions[0];
  $('#contractQuality').value=c.quality??o?.dataset?.quality??'';$('#contractMwap').value=c.mwap??o?.dataset?.mwap??'';const savedDiscount=Number(c.discount);if(Number.isFinite(savedDiscount)&&savedDiscount>=0&&savedDiscount<=10){$('#contractDiscount').value=String(savedDiscount);$('#contractDiscountCustom').value='';}else{const custom=Number.isFinite(savedDiscount)&&savedDiscount>=0&&savedDiscount<=100?savedDiscount:0;$('#contractDiscount').value='custom';$('#contractDiscountCustom').value=String(custom);}syncContractDiscountUI();$('#contractDirection').value=c.direction||'Outgoing';f.elements.price.value=c.price??'';delete f.elements.price.dataset.manual;
  f.elements.company.value=c.company||'';const mode=savedContractQuantityMode(c);$('#contractQuantityMode').value=mode;$('#contractQuantity').value=mode==='custom'?(c.quantity||''):'';syncContractQuantityUI();
  const save=f.querySelector('button[type="submit"]');if(save)save.textContent='Update Contract';$('#cancelContractEdit')?.classList.remove('hidden');f.scrollIntoView({behavior:'smooth',block:'center'});
}
$('#newContract').onclick=()=>{const f=$('#contractForm');if(f.classList.contains('hidden')){resetContractEditor();f.classList.remove('hidden');}else f.classList.add('hidden');};
$('#cancelContractEdit').onclick=()=>{resetContractEditor();$('#contractForm').classList.add('hidden');};
$('#contractQuantityMode').onchange=()=>syncContractQuantityUI();
$('#contractProduct').onchange=()=>{const o=$('#contractProduct').selectedOptions[0];$('#contractQuality').value=o?.dataset?.quality||'';$('#contractMwap').value=o?.dataset?.mwap||'';const price=$('#contractPrice');if(price)delete price.dataset.manual;updateContractPrice(true);};
$('#contractDiscount').onchange=()=>{syncContractDiscountUI();updateContractPrice(false);};
$('#contractDiscountCustom').oninput=()=>updateContractPrice(false);
$('#contractPrice').oninput=()=>{const price=$('#contractPrice');if(price)price.dataset.manual='1';};
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
    const record={id:editId||crypto.randomUUID(),direction:fd.get('direction'),company:fd.get('company'),product:fd.get('product'),quantity:quantityMode==='custom'?quantity:0,quantityMode,quality:Number(fd.get('quality')),mwap,discount,price,total:quantityMode==='custom'?roundCurrencyUp(price*quantity):0,savedAt:new Date().toISOString()};
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
    else { $('#syncInfo').textContent=`Sync failed: ${r?.error||'No response from extension service worker.'}`; }
  }catch(e){
    $('#syncInfo').textContent=`Sync failed: ${e?.message||String(e)}`;
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
const dashboardEditorActive=()=>{
  const el=document.activeElement;
  return !!el&&(el.matches?.('input,textarea,select,[contenteditable="true"]')||el.closest?.('#contractForm,#buildingPlanner'));
};
const flushPendingDashboardRender=()=>{
  if(__renderPendingWhileEditing&&!dashboardEditorActive()&&!__dashboardUserScrolling){
    __renderPendingWhileEditing=false;
    scheduleDashboardRender();
  }
};
const scheduleDashboardRender=()=>{
  if(dashboardEditorActive()||__dashboardUserScrolling){__renderPendingWhileEditing=true;return;}
  if(__renderTimer) clearTimeout(__renderTimer);
  // Batch storage bursts and never replace a form/planner while the user is actively editing it.
  // Sync can emit many realm-local writes in quick succession; a longer coalescing
  // window prevents repeated full-dashboard DOM replacement while scrolling.
  __renderTimer=setTimeout(()=>{
    __renderTimer=null;
    if(dashboardEditorActive()){__renderPendingWhileEditing=true;return;}
    const cached=__scmState;
    if(cached){try{render(cached);return;}catch(e){console.error('Dashboard render failed',e);}}
    get().then(s=>{try{render(s)}catch(e){console.error('Dashboard render failed',e)}});
  },650);
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
  const physicalFieldsByTab={
    warehouse:['warehouseResources','warehouseCostDetails','contracts','savedContracts','contractEvents','vwapData','vwapStatus','liveMarketData','liveMarketPriceData'],
    market:['warehouseResources','warehouseCostDetails','vwapData','vwapStatus','liveMarketData','liveMarketPriceData'],
    production:['buildings','warehouseResources','productionEvents','productionRateSnapshots','productionPlans','frozenNetworkPlan','productionRunHours','vwapData','vwapStatus','liveMarketData','liveMarketPriceData'],
    tools:['warehouseResources','vwapData','liveMarketPriceData','history']
  };
  const physicalFields=physicalFieldsByTab[tab];
  if(physicalFields){
    const viewRealm=Number(__scmState?.viewRealm??__scmState?.selectedRealm);
    const physicalKey=Number.isFinite(viewRealm)?`scmRealmStore:${viewRealm}`:null;
    const physicalChange=physicalKey?changes[physicalKey]:null;
    if(physicalChange){
      const before=physicalChange.oldValue&&typeof physicalChange.oldValue==='object'?physicalChange.oldValue:{};
      const after=physicalChange.newValue&&typeof physicalChange.newValue==='object'?physicalChange.newValue:{};
      if(physicalFields.some(field=>JSON.stringify(before[field]??null)!==JSON.stringify(after[field]??null)))return true;
    }
  }
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
  if(tab==='production')return ['buildings','warehouseResources','productionEvents','productionRateSnapshots','productionPlans','frozenNetworkPlan','productionRunHours','vwapData','vwapStatus','liveMarketData','liveMarketPriceData'].some(has);
  if(tab==='contracts')return ['contracts','savedContracts','contractEvents','endpointData','warehouseResources'].some(has);
  if(tab==='tools')return ['warehouseResources','vwapData','liveMarketPriceData','history'].some(has);
  
  if(tab==='diagnostic')return ['syncStatus','syncError','lastSync','fullSyncJob','fullSyncProgress','endpointData','apiEndpoints','realmQuarantine','productionEvents','productionRateSnapshots','productionPlans','frozenNetworkPlan','gameOverlaySnapshot','warehouseResources','vwapData'].some(has);
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
  const stamp=v.fetchedAt?new Date(v.fetchedAt).toLocaleTimeString():(v.receivedAt?new Date(v.receivedAt).toLocaleTimeString():'—');
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
  return buildings.map(b=>{
    const busy=b?.busy||{}; const resource=busy?.resource||{};
    return [
      Number(b?.id??b?.buildingId)||0, String(b?.category||''), String(b?.kind||''), String(b?.name||''),
      Number(b?.size??b?.level??b?.buildingLevel)||0, Number(b?.pinnedResource??resource?.kind)||0,
      String(busy?.started||''), Number(busy?.duration)||0, Number(resource?.kind??resource?.resourceId)||0,
      String(resource?.name||''), Number(resource?.quality)||0, Boolean(busy?.expanding),
      // v2.5.351 a new abundance capture repaints the building cards
      JSON.stringify(store?.endpointData?.[`/api/v2/companies/buildings/${Number(b?.id??b?.buildingId)||0}/abundance/`]?.data?.abundance||null)
    ].join(',');
  }).sort().join('|')+`#${buildings.length}`;
}
function scmHistorySignature(store){
  const history=store?.history&&typeof store.history==='object'?store.history:{};
  return Object.entries(history).map(([key,rows])=>[key,Array.isArray(rows)?rows.map(x=>[x?.date??'',x?.vwap??'']):[]]).sort(([a],[b])=>a.localeCompare(b)).map(x=>JSON.stringify(x)).join('|');
}
function scmProductionSignature(store){
  const parts=[];
  const events=Array.isArray(store?.productionEvents)?store.productionEvents:[];
  parts.push('events',events.map(e=>`${e?.resourceId??''}:${e?.resourceName??''}:${e?.modifier??''}:${e?.expiresAt??''}:${e?.capturedAt??''}`).sort().join(';'));
  const snaps=store?.productionRateSnapshots&&typeof store.productionRateSnapshots==='object'?store.productionRateSnapshots:{};
  parts.push('rates',Object.values(snaps).map(x=>`${x?.buildingId??''}:${x?.resourceId??''}:${x?.product??''}:${x?.started??''}:${x?.baseRatePerLevel??''}:${x?.observedRatePerHour??''}:${x?.capturedAt??''}`).sort().join(';'));
  const plans=store?.productionPlans&&typeof store.productionPlans==='object'?store.productionPlans:{};
  parts.push('plans',Object.values(plans).map(x=>`${x?.buildingId??''}:${x?.resourceId??''}:${x?.product??''}:${x?.quality??''}:${x?.plannedLevel??''}:${x?.baseRatePerLevel??''}:${x?.rateCapturedAt??''}`).sort().join(';'));
  const frozen=store?.frozenNetworkPlan;
  const frozenPlans=frozen?.buildingPlans&&typeof frozen.buildingPlans==='object'?frozen.buildingPlans:{};
  parts.push('frozen',String(frozen?.createdAt||frozen?.capturedAt||''),Object.values(frozenPlans).map(x=>`${x?.buildingId??''}:${x?.resourceId??''}:${x?.product??''}:${x?.quality??''}:${x?.plannedLevel??''}:${x?.baseRatePerLevel??''}`).sort().join(';'));
  parts.push('hours',Number(store?.productionRunHours)||24);
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
// v2.5.331 phone card header: warehouse stock cost per unit at the top right (same value as the
// "Warehouse Stock Cost" cell; hidden on wide screens where that column is visible).
function warehouseHeadCost(r){return r?._unitCost==null?'':`<span class="wh-head-cost" title="Warehouse stock cost per unit"><strong>${money(r._unitCost)}</strong><small>cost / unit</small></span>`;}
// v2.5.331 production cost history cell: newest run vs the run before it, for this product/quality.
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
function patchWarehouseCells(state){
  renderWarehouseMarketTimestamp(state);
  const body=$('#inventoryRows'); if(!body)return;
  const rows=warehouseRows(state);
  const existing=new Map([...body.querySelectorAll('tr[data-warehouse-key]')].map(tr=>[tr.dataset.warehouseKey,tr]));
  const wanted=[];
  for(const r of rows){
    const key=`${Number(r._id)}:${Number(r._quality)}`;
    const st=marketStats(marketRows(state,r._id,r._quality),r._quality);
    const currentMarketPrice=exactMarketPrice(buildMarketPriceMap(state),r._id,r._quality);const margin=currentMarketPrice!=null&&r._unitCost>0?(currentMarketPrice-r._unitCost)/r._unitCost*100:null;
    const ri=resourceInfo(r,state); const imgs=ri.imageCandidates||[];
    const localImage=state.resourceImageCache?.[String(r._id)]||state.resourceImageData?.[String(r._id)]||null;
    if(!localImage) requestResourceImage(r._id);
    const srcs=localImage?[localImage,...imgs]:imgs;
    const img=srcs.length?`<img class="resource-icon" src="${escapeHtml(srcs[0])}" data-candidates="${escapeHtml(JSON.stringify(srcs))}" data-idx="0" alt="" loading="lazy" data-scm-fallback="1">`:'';
    let tr=existing.get(key);
    const activeCost=activeProductionCostCells(state,r);const html=[`<td><div class="product-cell">${img}<span><strong>${escapeHtml(resourceName(r,state))}</strong><small>#${r._id}</small></span></div>${warehouseHeadCost(r)}</td>`, `<td data-cell="qty">${num(r._qty)}</td>`, `<td data-cell="quality">${r._quality??'—'}</td>`, `<td data-cell="cost">${r._unitCost==null?'—':money(r._unitCost)}</td>`, `<td data-cell="active-production-cost">${activeCost.costHtml}</td>`, `<td data-cell="production-stock-diff">${activeCost.diffHtml}</td>`, `<td data-cell="prod-cost-history">${productionCostHistoryCell(state,r)}</td>`, `<td data-cell="vwap"><span class="cell-stack">${currentMarketPrice==null?'—':money(currentMarketPrice)}<small class="market-source">${marketSource(state,r._id,r._quality)}</small></span></td>`, `<td data-cell="margin" class="${margin==null?'':margin>=0?'positive':'negative'}">${margin==null?'—':margin.toFixed(1)+'%'}</td>`];
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
    if(list)list.innerHTML=topSelling.loading?'<div class="overview-selling-empty">Loading weekly sales ledger…</div>':topSelling.items.length?topSelling.items.map(x=>{const srcs=x.image?[x.image,...x.images.filter(v=>v!==x.image)]:x.images;const img=srcs.length?`<img class="overview-resource-icon" src="${escapeHtml(srcs[0])}" data-candidates="${escapeHtml(JSON.stringify(srcs))}" data-idx="0" alt="" loading="lazy" data-scm-fallback="1">`:'';return `<div class="overview-selling-row"><span class="overview-rank">${x.rank}</span>${img}<span class="overview-selling-name">${escapeHtml(x.name)}</span><span class="overview-selling-quantity"><small>Qty sold</small><strong>${num(x.amount)}</strong></span><span class="overview-selling-profit"><small>Net Profit</small><strong>${money(x.profit)}</strong></span></div>`}).join(''):'<div class="overview-selling-empty">No selling profit data captured yet.</div>';
  }
  if(grossSection){
    const head=grossSection.querySelector('.overview-section-head span:first-of-type');
    if(head)head.textContent=`Captured sales value · ${range(topGross)}`;
    const list=grossSection.querySelector('.overview-selling-list');
    if(list)list.innerHTML=topGross.loading?'<div class="overview-selling-empty">Loading weekly sales ledger…</div>':topGross.items.length?topGross.items.map(x=>{const srcs=x.image?[x.image,...x.images.filter(v=>v!==x.image)]:x.images;const img=srcs.length?`<img class="overview-resource-icon" src="${escapeHtml(srcs[0])}" data-candidates="${escapeHtml(JSON.stringify(srcs))}" data-idx="0" alt="" loading="lazy" data-scm-fallback="1">`:'';return `<div class="overview-selling-row"><span class="overview-rank">${x.rank}</span>${img}<span class="overview-selling-name">${escapeHtml(x.name)}</span><span class="overview-selling-quantity"><small>Qty sold</small><strong>${num(x.amount)}</strong></span><span class="overview-selling-profit"><small>Gross</small><strong>${money(x.gross)}</strong></span></div>`}).join(''):'<div class="overview-selling-empty">No gross sales data captured yet.</div>';
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
    const price=item.price!=null?Number(item.price):null;
    const lineTotal=Number.isFinite(price)?roundCurrencyUp(price*amount):null;
    return {...item,warehouseQty,amount,quality:0,lineTotal};
  });
  const items=updated.filter(x=>x.amount>0);
  const total=roundCurrencyUp(items.reduce((sum,x)=>sum+(Number(x.lineTotal)||0),0));
  const body=items.length
    ?items.map(x=>`<div class="planner-copy-line"><span>${escapeHtml(`➡️ ${num(x.amount)} - ${x.name} :re-${Number(x.id)}: - ${x.price!=null?money(x.price):'—'}`)}</span></div>`).join('')
    :'<div class="planner-copy-empty">No additional construction materials required for the planned building levels.</div>';
  const copyText=items.length
    ?`==============================\n🔽🔽🔽 BUYING -${discount}% MARKET 🔽🔽🔽\n${items.map(x=>`➡️ ${num(x.amount)} - ${x.name} :re-${Number(x.id)}: - ${x.price!=null?money(x.price):'—'}`).join('\n')}\n==============================`
    :`==============================\n🔽🔽🔽 BUYING -${discount}% MARKET 🔽🔽🔽\nNo additional construction materials required for the planned building levels.\n==============================`;
  textEl.innerHTML=`<div class="planner-copy-heading">==============================<br>🔽🔽🔽 BUYING -${discount}% MARKET 🔽🔽🔽</div>${body}<div class="planner-copy-heading">==============================</div>`;
  textEl.dataset.copyText=copyText;
  if(totalEl)totalEl.textContent=plannerMoney(total);
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
  if(flags.warehouseChanged||flags.vwapChanged) patchWarehouseCells(state);
  if(flags.vwapChanged){
    renderVwapDiagnostics(state);
    patchOverviewOperations(state);
  }
  if(flags.accountingChanged){ patchOverviewGrossResources(state); }
  if(flags.contractsChanged||flags.vwapChanged){
    if($('#incomingContractRows')||$('#outgoingContractRows')) patchContractTables(state);
  }
  if(flags.warehouseChanged){
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
      const flags={buildingsChanged:scmBuildingsSignature(oldStore)!==scmBuildingsSignature(newStore),warehouseChanged:scmWarehouseSignature(oldStore)!==scmWarehouseSignature(newStore),vwapChanged:scmVwapSignature(oldStore)!==scmVwapSignature(newStore),contractsChanged:scmContractSignature(oldStore)!==scmContractSignature(newStore),accountingChanged:scmAccountingSignature(oldStore)!==scmAccountingSignature(newStore),productionChanged:scmProductionSignature(oldStore)!==scmProductionSignature(newStore),historyChanged:scmHistorySignature(oldStore)!==scmHistorySignature(newStore),diagnosticChanged:scmDiagnosticSignature(oldStore)!==scmDiagnosticSignature(newStore),liveMarketProductChanged:JSON.stringify(oldStore?.liveMarketProduct||null)!==JSON.stringify(newStore?.liveMarketProduct||null),liveMarketProductCacheChanged:JSON.stringify(oldStore?.liveMarketProductCache||{})!==JSON.stringify(newStore?.liveMarketProductCache||{}),liveMarketPriceDataChanged:JSON.stringify(oldStore?.liveMarketPriceData||null)!==JSON.stringify(newStore?.liveMarketPriceData||null)};
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
           const plannerInputsChanged=flags.buildingsChanged||flags.productionChanged;
           if(plannerInputsChanged)renderBuildingPlanner(scmReactiveViewState(fresh));
           else {
           }
         }else if(activeTab==='diagnostic')scheduleDashboardRender();
       }
      if((flags.warehouseChanged||flags.vwapChanged||flags.liveMarketPriceDataChanged||flags.liveMarketProductChanged||flags.liveMarketProductCacheChanged)&&activeTab==='warehouse')scheduleDashboardRender();
      if((flags.liveMarketPriceDataChanged||flags.vwapChanged||flags.warehouseChanged)&&activeTab==='tools')scheduleDashboardRender();
      if(flags.contractsChanged&&activeTab==='overview')scheduleDashboardRender();if(flags.accountingChanged&&activeTab==='accounting')scheduleDashboardRender();if(flags.diagnosticChanged&&activeTab==='diagnostic')scheduleDashboardRender();if((flags.vwapChanged||flags.warehouseChanged||flags.historyChanged||flags.liveMarketProductChanged||flags.liveMarketProductCacheChanged||flags.liveMarketPriceDataChanged)&&activeTab==='market')scheduleDashboardRender();
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
    if(el)el.textContent=__realmHydrationPending&&__scmState?.viewRealm!=null?`Switching to ${realmName(Number(__scmState.viewRealm))}…`:error?`${status||'Error'}: ${error}`:String(status||'No sync yet');
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
  const relevant=dashboardChangeAffectsTab(changes,activeTab);
  // Physical realm-store writes are already reconciled by queuePhysicalRealmStateRefresh.
  // That path patches the active feature in place (and specifically updates the
  // Production planner only when its actual inputs changed). Scheduling render()
  // again here used to replace every dashboard section after the targeted patch,
  // causing visible flicker, scroll/layout churn, and unnecessary recipe reloads.
  const physicalTabHandled=activeTab==='production' && physicalRealmKeys.length>0 &&
    !changes.activeRealmKey && !changes.selectedRealm;
  if(relevant&&!physicalTabHandled)scheduleDashboardRender();
});
scmOnDashboardResume(async()=>{
  try{
    const meta=await chrome.storage.local.get({activeRealmKey:null});
    if(__scmState&&String(meta.activeRealmKey??'')!==String(__scmState.activeRealmKey??'')){location.reload();return;}
    const fresh=await get();if(commitDashboardState(fresh))scheduleDashboardRender();
  }catch(e){console.debug('resume refresh failed',e);}
});
get().then(s=>{try{render(s)}catch(e){console.error('Dashboard render failed',e)};requestAccountingRefresh().catch(()=>{});requestAccountingWeekLedgerRefresh('dashboard-initial-load').catch(()=>{});});

// v2.5.327 mobile: on phone widths, tables marked .mobile-cards render as stacked cards (CSS). Each cell
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


// v2.5.328: extension pages forbid inline event handlers (CSP script-src 'self'), so the old
// onerror="window.scmImageFallback(this)" attributes never ran and a failed product image stayed broken.
// One capture-phase listener does the same job for every image marked data-scm-fallback.
document.addEventListener('error',e=>{const t=e.target;if(!t||t.tagName!=='IMG'||!t.dataset)return;if(t.dataset.scmFallback==='1'&&typeof window.scmImageFallback==='function'){try{window.scmImageFallback(t);}catch{}}else if(t.dataset.scmHideOnError==='1'){t.style.visibility='hidden';}},true);

// v2.5.335 Alerts tab: one switch per alert, thresholds and price targets.
(function(){
  const st=$('#notifyStatus');if(!st)return;
  let cfg=null;
  const when=ms=>new Date(ms).toLocaleString(undefined,{weekday:'short',hour:'numeric',minute:'2-digit'});
  const realmNow=()=>validRealmNumber(__scmState?.viewRealm??__scmState?.selectedRealm);
  const prodName=(id)=>{try{return resourceName({_id:id,kind:id},__scmState||{});}catch{return '#'+id;}};
  // v2.5.336: filled when tapped (state may not be loaded yet when the Alerts tab opens first); lists warehouse
  // items and products your buildings are making now.
  const fillProducts=()=>{const sel=$('#nfTProduct');if(!sel)return;const s=__scmState||{};let opts=[];try{opts=marketWarehouseOptions(s).map(o=>({key:`${o.id}:${o.quality}`,label:`${o.name} Q${o.quality} · ${num(o.qty)} in warehouse`}));}catch{}
    const have=new Set(opts.map(o=>o.key));for(const b of Array.isArray(s.buildings)?s.buildings:[]){const r=b?.busy?.resource;const id=Number(r?.kind),q=Number(r?.quality);if(id>0&&Number.isFinite(q)&&!have.has(`${id}:${q}`)){have.add(`${id}:${q}`);opts.push({key:`${id}:${q}`,label:`${r.name||prodName(id)} Q${q} · producing`});}}
    const cur=sel.value;sel.innerHTML=opts.length?'<option value="">Choose a product…</option>'+opts.map(o=>`<option value="${o.key}">${escapeHtml(o.label)}</option>`).join(''):'<option value="">Loading your warehouse… tap again</option>';if(cur&&have.has(cur))sel.value=cur;};
  ['pointerdown','focus'].forEach(ev=>$('#nfTProduct')?.addEventListener(ev,fillProducts));setTimeout(fillProducts,2500);
  const renderTargets=()=>{const host=$('#nfTargets');if(!host)return;const r=realmNow();const list=(cfg?.priceTargets||[]).map((t,i)=>({...t,i})).filter(t=>Number(t.realm??r)===r);
    host.innerHTML=list.length?list.map(t=>`<div class="notify-target"><span><strong>${escapeHtml(prodName(t.id))} Q${t.q}</strong><br><small>Alert when the price ${t.op==='>='?'rises to':'drops to'} ${money(t.price)} or ${t.op==='>='?'higher':'lower'}</small></span><button type="button" class="secondary" data-nf-del="${t.i}" aria-label="Remove target">×</button></div>`).join(''):'<div class="muted nf-empty">No targets yet. Choose a product, when to alert, and a price, then tap Add.</div>';};
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


// v2.5.350 expandable / collapsible cards. A container marked data-collapse="<key>" collapses to its
// [data-collapse-head] child; taps on the head toggle it. Choices are kept per key in localStorage
// (scmCollapseV1). data-collapse-default="closed" starts collapsed. No inline handlers (CSP).
const SCM_COLLAPSE_KEY='scmCollapseV1';
function scmCollapseRead(){try{const v=JSON.parse(localStorage.getItem(SCM_COLLAPSE_KEY)||'{}');return v&&typeof v==='object'?v:{};}catch{return {};}}
function scmCollapseWrite(key,collapsed){try{const v=scmCollapseRead();delete v[key];v[key]=collapsed?1:0;const keys=Object.keys(v);for(const k of keys.slice(0,Math.max(0,keys.length-300)))delete v[k];localStorage.setItem(SCM_COLLAPSE_KEY,JSON.stringify(v));}catch{}}
function scmSetCollapsed(el,collapsed){el.classList.toggle('is-collapsed',!!collapsed);const h=el.querySelector(':scope>[data-collapse-head]');if(h)h.setAttribute('aria-expanded',collapsed?'false':'true');}
function scmApplyCollapse(root){
  if(!root)return;const saved=scmCollapseRead();
  const list=[...(root.matches?.('[data-collapse]')?[root]:[]),...root.querySelectorAll('[data-collapse]')];
  for(const el of list){const k=el.dataset.collapse;const h=el.querySelector(':scope>[data-collapse-head]');if(!h)continue;h.classList.add('collapse-head');h.setAttribute('role','button');h.tabIndex=0;scmSetCollapsed(el,k in saved?!!saved[k]:el.dataset.collapseDefault==='closed');}
}
// v2.5.358 every card in the Manager is expandable / collapsible. Cards rendered without data-collapse get it here,
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
  if(fresh.length){const saved=scmCollapseRead();for(const el of fresh){const k=el.dataset.collapse,h=el.querySelector(':scope>[data-collapse-head]');h.classList.add('collapse-head');h.setAttribute('role','button');h.tabIndex=0;scmSetCollapsed(el,k in saved?!!saved[k]:el.dataset.collapseDefault==='closed');}}
}
(function(){
  const toggle=(head,e)=>{const el=head.parentElement;if(!el?.dataset?.collapse)return;
    // buttons/fields inside a head (e.g. New Contract) work as before; a collapsed card opens so the form shows
    if(e&&e.target!==head&&e.target.closest('button,input,select,textarea,a,label')){if(el.classList.contains('is-collapsed')){scmSetCollapsed(el,false);scmCollapseWrite(el.dataset.collapse,false);}return;}
    const next=!el.classList.contains('is-collapsed');scmSetCollapsed(el,next);scmCollapseWrite(el.dataset.collapse,next);};
  document.addEventListener('click',e=>{const head=e.target.closest?.('[data-collapse-head]');if(head)toggle(head,e);});
  document.addEventListener('keydown',e=>{if(e.key!=='Enter'&&e.key!==' ')return;const head=e.target.closest?.('[data-collapse-head]');if(head&&e.target===head){e.preventDefault();toggle(head,null);}});
  scmApplyCollapse(document.getElementById('accounting'));scmApplyCollapse(document.getElementById('contracts'));
  try{scmAutoCollapse(document.body);new MutationObserver(()=>scmAutoCollapse(document.body)).observe(document.body,{childList:true,subtree:true});}catch(e){console.error('Auto collapse failed',e);}
})();
