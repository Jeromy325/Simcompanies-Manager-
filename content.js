// Page bridge. content.js hands page-hook.js a private MessageChannel port (with a crypto-random
// per-world nonce echoed in the ack). Once the matching PORT_ACK arrives, page-hook traffic is accepted
// only over that port, so other page scripts can no longer read it or inject window-path events. This is
// NOT authentication of earlier traffic: before the ack, window.postMessage (targetOrigin=location.origin)
// is used and any page script could forge messages; type/size validation limits what they can carry.
// A forged PORT_HANDOFF cannot silence capture: page-hook adopts only the first handoff, and this side
// keeps the window path until an ack with OUR nonce arrives. PORT_PING is answered only while the
// extension context is valid, which lets a reloaded extension's new world take over a dead port.
if(!globalThis.__scmPageBridge)globalThis.__scmPageBridge=(()=>{
  const SRC='SIMCO_MANAGER',GRACE_MS=1500;
  const KNOWN=Object.assign(Object.create(null),Object.fromEntries(['API_DATA','API_RESULT','API_SEEN','BRIDGE_QUEUE_FLUSHED','DOM_RUNTIME_DIAGNOSTIC_RESULT','GAME_CONFIG','GAME_LOCAL_STORAGE_SNAPSHOT','GAME_STATE','HOOK_READY','INITIALIZED_ACK','JAVASCRIPT_DIAGNOSTIC','MARKET_CACHE','NETWORK_CAPTURE_CONTROL_ACK','NETWORK_CAPTURE_EVENT','PAGE_REALM','REALM_SWITCH','REALM_SWITCH_CONFIRMED','REDUX_STATE_DIAGNOSTIC_RESULT','REPLAY_EVENT','RESOURCE_CATALOG','RESOURCE_IMAGE_RESULT','STOCK_MUTATION_COMPLETE','PORT_ACK','PORT_PING'].map(t=>[t,true])));const MAX_KEYS=64;
  const nonce=(()=>{try{const a=new Uint8Array(16);crypto.getRandomValues(a);return Array.from(a,b=>b.toString(16).padStart(2,'0')).join('');}catch{return `${Date.now()}-${Math.random()}`.replace('.','');}})();
  const origin=(()=>{try{return location.origin&&location.origin!=='null'?location.origin:'*';}catch{return '*';}})();
  const STR_KEYS=['id','requestId','captureId','url','method','reason','realmResolvedBy','eventType'];
  const valid=d=>{
    if(!d||typeof d!=='object'||d.source!==SRC)return false;
    const t=d.type;if(typeof t!=='string'||t.length>64||KNOWN[t]!==true)return false;
    try{if(Object.keys(d).length>MAX_KEYS)return false;}catch{return false;}
    for(const k of STR_KEYS){const v=d[k];if(v!=null&&(typeof v==='object'||String(v).length>8192))return false;}
    return true;
  };
  const handlers=[];let port=null,portAt=0,handoffs=0,oldPort=null;
  const dispatch=d=>{const ev={source:window,data:d};for(const h of handlers.slice()){try{h(ev);}catch(e){try{setTimeout(()=>{throw e;});}catch{}}}};
  const handoff=()=>{
    if(port||handoffs>=30)return;handoffs++;
    let ch;try{ch=new MessageChannel();}catch{return;}
    const p=ch.port1;
    p.onmessage=e=>{const d=e.data;if(!valid(d))return;
      if(d.type==='PORT_ACK'){if(!port&&d.nonce===nonce){port=p;portAt=Date.now();oldPort=null;}return;}
      if(d.type==='PORT_PING'){let ok=false;try{ok=!!chrome?.runtime?.id;}catch{}if(ok&&p===port){try{p.postMessage({source:SRC,type:'PORT_PONG'});}catch{}}return;}
      if(p!==port&&p!==oldPort)return;dispatch(d);};
    try{window.postMessage({source:SRC,type:'PORT_HANDOFF',nonce},origin,[ch.port2]);}catch{}
  };
  window.addEventListener('message',ev=>{
    if(ev.source!==window)return;const d=ev.data;if(!valid(d)||d.type==='PORT_ACK'||d.type==='PORT_PING')return;
    // After the port handshake only port traffic is trusted (short grace for in-flight window posts).
    if(port&&Date.now()-portAt>GRACE_MS)return;
    if(d.type==='HOOK_READY'&&!port)handoff();
    dispatch(d);
  });
  const send=m=>{const msg={...m,source:SRC};if(port){try{port.postMessage(msg);return;}catch{}}window.postMessage(msg,origin);};
  // bfcache (Chrome 123+ may restore pages with open MessageChannels closed): after a persisted
  // pageshow, drop to the window path and hand over a fresh port. page-hook only replaces its port if
  // the old one stops answering, so this never lets a page script take over. The old port keeps being
  // accepted (if it is still alive) until the new port's PORT_ACK arrives, so no traffic is dropped.
  try{window.addEventListener('pageshow',e=>{if(!e.persisted)return;if(port)oldPort=port;port=null;handoffs=0;handoff();});}catch{}
  return {listen:h=>{handlers.push(h);},send,handoff};
})();
// Teardown when the extension context is invalidated (extension reloaded/updated): orphaned
// content scripts otherwise keep their intervals and subtree observers running forever. This only
// records intervals/observers created in this isolated world; nothing changes while the context is valid.
// The global marks the patches as installed: background can inject content.js again into the same world.
if(!globalThis.__scmTeardown)globalThis.__scmTeardown=(()=>{
  const intervals=new Set(),observers=new Set();let dead=false;
  try{const si=globalThis.setInterval,ci=globalThis.clearInterval;
    globalThis.setInterval=function(...a){const id=si.apply(this,a);if(!dead)intervals.add(id);return id;};
    globalThis.clearInterval=function(id){intervals.delete(id);return ci.call(this,id);};
    const proto=MutationObserver.prototype,obs=proto.observe;
    proto.observe=function(...a){observers.add(this);return obs.apply(this,a);};
    const disc=proto.disconnect;proto.disconnect=function(){observers.delete(this);return disc.call(this);};
    const alive=()=>{try{return !!chrome?.runtime?.id;}catch{return false;}};
    const kill=()=>{if(dead||alive())return;dead=true;for(const id of intervals){try{ci(id);}catch{}}intervals.clear();for(const o of Array.from(observers)){try{o.disconnect();}catch{}}observers.clear();};
    const watch=si(()=>{kill();if(dead)ci(watch);},10000);
    document.addEventListener('visibilitychange',kill);
    return true;
  }catch{return true;}
})();
// Sync timers (Settings): the four game-page loops below read their interval and on/off here every time they
// reschedule (self-rescheduling setTimeout). The config is read once from scmSyncTimers (a small key) and then
// updated by SCM_TIMERS_CHANGED from the background (no storage.onChanged). Until it loads, or without
// timers-core.js, every loop runs at its old fixed interval. A loop stops once the extension context is gone.
// Made once per world, like __scmTeardown: a second injection of content.js adds no listener.
if(!globalThis.__scmTimers)globalThis.__scmTimers=(()=>{
  const C=globalThis.SCM_TIMERS_CORE||null;
  let cfg=null;const loops=new Set();
  const alive=()=>{try{return !!chrome?.runtime?.id;}catch{return false;}};
  const get=(id,fallbackMs)=>{const e=cfg?.[id];if(!C||!e)return {enabled:true,ms:fallbackMs};return {enabled:e.enabled!==false,ms:C.intervalMs(id,e)||fallbackMs};};
  const set=next=>{if(!C)return;const prev=JSON.stringify(cfg);cfg=C.normalize({v:1,timers:next});if(JSON.stringify(cfg)!==prev)for(const l of loops)l.reschedule();};
  // fn runs once per interval; a timer that is off waits for the setting to change. Returns {stop, reschedule}.
  const loop=(id,fallbackMs,fn)=>{
    let t=0,stopped=false;
    const l={stop(){stopped=true;clearTimeout(t);loops.delete(l);},
      reschedule(){clearTimeout(t);t=0;if(stopped)return;if(!alive()){l.stop();return;}const c=get(id,fallbackMs);if(c.enabled)t=setTimeout(tick,c.ms);}};
    const tick=()=>{t=0;if(stopped)return;try{fn();}catch{}l.reschedule();};
    loops.add(l);l.reschedule();return l;
  };
  try{const key=C?.KEY||'scmSyncTimers';chrome.storage.local.get({[key]:null}).then(r=>{const s=r?.[key];if(s&&s.v===1)set(s.timers);}).catch(()=>{});}catch{}
  try{chrome.runtime.onMessage.addListener(msg=>{if(msg?.type==='SCM_TIMERS_CHANGED'&&msg.timers&&typeof msg.timers==='object')set(msg.timers);return false;});}catch{}
  return {loop,get};
})();
(() => {
  if (window.__SCM_BRIDGE__) return;
  const safeRuntimeSend = (message) => {
    try {
      if (!chrome?.runtime?.id) return;
      const result = chrome.runtime.sendMessage(message);
      if (result?.catch) result.catch(() => {});
    } catch {}
  };

  // Small on-page indicator for mobile overnight network capture. The displayed
  // count is read from the background's durable status, so it includes both
  // game-page fetch/XHR events and instrumented extension-background events.
  let scmCaptureOverlayTimer = null;
  let scmCaptureOverlay = null;
  let scmCaptureOverlayPollInFlight = false;
  const SCM_CAPTURE_OVERLAY_COLLAPSED_KEY = 'scmMobileCaptureOverlayCollapsedV1';
  const readCaptureOverlayCollapsed = () => { try { const saved = localStorage.getItem(SCM_CAPTURE_OVERLAY_COLLAPSED_KEY); return saved === null ? true : saved === '1'; } catch { return true; } };
  const saveCaptureOverlayCollapsed = (collapsed) => { try { localStorage.setItem(SCM_CAPTURE_OVERLAY_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch {} };
  let scmCaptureOverlayCollapsed = readCaptureOverlayCollapsed();
  let scmCaptureOverlayUserMoved = false;
  const SCM_CAPTURE_OVERLAY_POSITION_KEY = 'scmMobileCaptureOverlayPositionV1';
  const readCaptureOverlayPosition = () => {
    try { const raw = localStorage.getItem(SCM_CAPTURE_OVERLAY_POSITION_KEY); if (!raw) return null; const p = JSON.parse(raw); if (Number.isFinite(p?.left) && Number.isFinite(p?.top)) { scmCaptureOverlayUserMoved = true; return {left:p.left,top:p.top}; } } catch {}
    return null;
  };
  const saveCaptureOverlayPosition = (left, top) => {
    try { localStorage.setItem(SCM_CAPTURE_OVERLAY_POSITION_KEY, JSON.stringify({left:Math.round(left),top:Math.round(top)})); scmCaptureOverlayUserMoved = true; } catch {}
  };
  const clampCaptureOverlayPosition = (left, top, card) => {
    const r = card.getBoundingClientRect(); const width = r.width || (scmCaptureOverlayCollapsed ? 130 : 190); const height = r.height || 34;
    return {left:Math.max(4,Math.min(window.innerWidth-width-4,left)),top:Math.max(4,Math.min(window.innerHeight-height-4,top))};
  };
  const positionCaptureOverlay = () => {
    if (!scmCaptureOverlay?.isConnected) return;
    let pos = readCaptureOverlayPosition();
    if (!pos && !scmCaptureOverlayUserMoved) {
      const stock = document.getElementById('scm-game-balance-card');
      const r = stock?.getBoundingClientRect();
      if (r && r.width && r.height) pos = {left:r.left,top:r.bottom+6};
      else pos = {left:8,top:Math.max(70,(window.innerHeight||600)*0.18)};
    }
    if (!pos) return;
    pos = clampCaptureOverlayPosition(pos.left,pos.top,scmCaptureOverlay);
    scmCaptureOverlay.style.left = `${Math.round(pos.left)}px`; scmCaptureOverlay.style.top = `${Math.round(pos.top)}px`;
    scmCaptureOverlay.style.right = 'auto';
  };
  const ensureCaptureOverlay = () => {
    if (scmCaptureOverlay?.isConnected) return scmCaptureOverlay;
    const old = document.getElementById('scm-mobile-network-capture-indicator');
    if (old) old.remove();
    const card = document.createElement('div');
    card.setAttribute('role','status');
    card.setAttribute('aria-live','polite');
    card.style.cssText = 'position:fixed;z-index:2147483646;top:calc(env(safe-area-inset-top, 0px) + 8px);left:8px;max-width:min(190px,calc(100vw - 16px));box-sizing:border-box;padding:5px 7px;border:1px solid rgba(242,139,87,.75);border-radius:9px;background:rgba(17,16,15,.94);color:#f6f6f6;box-shadow:0 3px 12px rgba(0,0,0,.38);font:400 12px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;pointer-events:auto;touch-action:manipulation;';
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;min-width:0;cursor:move;touch-action:none;user-select:none;-webkit-user-select:none;';
    const title = document.createElement('div');
    title.dataset.captureTitle = '1';
    title.textContent = '● Network capture';
    title.style.cssText = 'font-size:12px;font-weight:400;color:#abd59d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.dataset.captureToggle = '1';
    toggle.textContent = '−';
    toggle.setAttribute('aria-label','Collapse network capture status');
    toggle.setAttribute('aria-expanded','true');
    toggle.style.cssText = 'flex:0 0 24px;width:24px;height:24px;padding:0;border:1px solid #625d5b;border-radius:6px;background:#262524;color:#f6f6f6;font:400 17px/1 system-ui,-apple-system,Segoe UI,sans-serif;cursor:pointer;touch-action:manipulation;';
    toggle.addEventListener('click', () => {
      scmCaptureOverlayCollapsed = !scmCaptureOverlayCollapsed;
      saveCaptureOverlayCollapsed(scmCaptureOverlayCollapsed);
      applyCaptureOverlayCollapsedState();
    });
    header.append(title,toggle);
    let drag = null;
    header.addEventListener('pointerdown', (event) => {
      if (event.target === toggle || event.target.closest?.('button')) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      const rect = card.getBoundingClientRect(); drag = {id:event.pointerId,dx:event.clientX-rect.left,dy:event.clientY-rect.top};
      try { header.setPointerCapture(event.pointerId); } catch {}
      event.preventDefault();
    });
    header.addEventListener('pointermove', (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      const pos = clampCaptureOverlayPosition(event.clientX-drag.dx,event.clientY-drag.dy,card);
      card.style.left = `${Math.round(pos.left)}px`; card.style.top = `${Math.round(pos.top)}px`; card.style.right = 'auto';
      scmCaptureOverlayUserMoved = true;
    });
    const finishDrag = (event) => { if (!drag || (event && drag.id !== event.pointerId)) return; const r=card.getBoundingClientRect(); saveCaptureOverlayPosition(r.left,r.top); drag=null; };
    header.addEventListener('pointerup', finishDrag); header.addEventListener('pointercancel', finishDrag);
    const count = document.createElement('div');
    count.dataset.captureCount = '1';
    count.textContent = 'Captured: 0 events';
    count.style.cssText = 'margin-top:2px;font-size:13px;font-weight:400;overflow-wrap:anywhere;';
    const detail = document.createElement('div');
    detail.dataset.captureDetail = '1';
    detail.textContent = 'Starting…';
    detail.style.cssText = 'margin-top:1px;font-size:11px;font-weight:400;color:#c9c6c5;';
    card.append(header,count,detail);
    // Self-contained floating panel -> isolated in a shadow root so game CSS cannot restyle it
    // and page scripts cannot query its contents via document selectors. Falls back to a plain append.
    const host = document.createElement('div');
    host.id = 'scm-mobile-network-capture-indicator';
    host.setAttribute('data-scm-owned','1');
    host.style.cssText = 'all:initial;position:static;';
    let shadow = null;
    try { shadow = host.attachShadow({mode:'closed'}); } catch {}
    if (shadow) { shadow.appendChild(card); card.__scmHost = host; (document.documentElement || document.body)?.appendChild(host); }
    else { card.id = 'scm-mobile-network-capture-indicator'; (document.documentElement || document.body)?.appendChild(card); }
    scmCaptureOverlay = card;
    positionCaptureOverlay();
    return card;
  };
  const applyCaptureOverlayCollapsedState = () => {
    if (!scmCaptureOverlay?.isConnected) return;
    const count = scmCaptureOverlay.querySelector('[data-capture-count]');
    const detail = scmCaptureOverlay.querySelector('[data-capture-detail]');
    const title = scmCaptureOverlay.querySelector('[data-capture-title]');
    const toggle = scmCaptureOverlay.querySelector('[data-capture-toggle]');
    if (count) count.style.display = scmCaptureOverlayCollapsed ? 'none' : 'block';
    if (detail) detail.style.display = scmCaptureOverlayCollapsed ? 'none' : 'block';
    if (toggle) {
      toggle.textContent = scmCaptureOverlayCollapsed ? '+' : '−';
      toggle.setAttribute('aria-expanded', scmCaptureOverlayCollapsed ? 'false' : 'true');
      toggle.setAttribute('aria-label', scmCaptureOverlayCollapsed ? 'Expand network capture status' : 'Collapse network capture status');
    }
    if (title) title.style.maxWidth = scmCaptureOverlayCollapsed ? 'min(96px,calc(100vw - 54px))' : 'min(150px,calc(100vw - 60px))';
    if (scmCaptureOverlay) {
      scmCaptureOverlay.style.maxWidth = scmCaptureOverlayCollapsed ? 'min(136px,calc(100vw - 8px))' : 'min(210px,calc(100vw - 8px))';
      scmCaptureOverlay.style.padding = scmCaptureOverlayCollapsed ? '3px 5px' : '6px 8px';
      scmCaptureOverlay.style.borderRadius = scmCaptureOverlayCollapsed ? '7px' : '9px';
    }
    positionCaptureOverlay();
  };
  const updateCaptureOverlay = (status) => {
    const card = ensureCaptureOverlay();
    const count = card.querySelector('[data-capture-count]');
    const detail = card.querySelector('[data-capture-detail]');
    const events = Math.max(0,Number(status?.events ?? status?.eventCount)||0);
    const requests = Math.max(0,Number(status?.requests)||0);
    const errors = Math.max(0,Number(status?.errors)||0);
    if (count) count.textContent = `Captured: ${events.toLocaleString()} events`;
    if (detail) detail.textContent = `${requests.toLocaleString()} requests · ${errors.toLocaleString()} errors`;
    card.dataset.captureStatus = String(status?.status||'recording');
    const title = card.querySelector('[data-capture-title]');
    if (title) title.textContent = status?.status === 'limit-reached' ? '⚠ Capture limit reached' : status?.status === 'recording' ? (scmCaptureOverlayCollapsed ? `● Capture · ${events.toLocaleString()}` : '● Network capture') : `Network capture · ${status?.status||'active'}`;
    if (title && status?.status !== 'limit-reached') title.style.color = status?.status === 'recording' ? '#abd59d' : '#f5d18a';
    applyCaptureOverlayCollapsedState();
  };
  const stopCaptureOverlay = () => {
    if (scmCaptureOverlayTimer) clearInterval(scmCaptureOverlayTimer);
    scmCaptureOverlayTimer = null;
    scmCaptureOverlay?.__scmHost?.remove();
    scmCaptureOverlay?.remove();
    scmCaptureOverlay = null;
  };
  const pollCaptureOverlayStatus = async () => {
    if (scmCaptureOverlayPollInFlight) return;
    scmCaptureOverlayPollInFlight = true;
    try {
      const result = await chrome.runtime.sendMessage({type:'SCM_NET3_STATUS'});
      const status = result?.status || {};
      if (status.mode !== 'mobile-page' || !status.captureId || !['recording','limit-reached'].includes(status.status)) {
        if (status.mode === 'mobile-page' && status.captureId && status.status === 'stopped') stopCaptureOverlay();
        return;
      }
      updateCaptureOverlay(status);
    } catch {} finally { scmCaptureOverlayPollInFlight = false; }
  };
  const startCaptureOverlay = () => {
    ensureCaptureOverlay();
    applyCaptureOverlayCollapsedState();
    pollCaptureOverlayStatus();
    if (!scmCaptureOverlayTimer) scmCaptureOverlayTimer = setInterval(pollCaptureOverlayStatus,2000);
  };
  // The content script is recreated on a full game-page refresh. Restore the
  // on-page indicator from the durable background capture status instead of
  // requiring the user to stop and start capture again.
  const restoreMobileCaptureOverlay = async () => {
    try {
      const result = await chrome.runtime.sendMessage({type:'SCM_NET3_STATUS'});
      const status = result?.status || {};
      if (status.mode === 'mobile-page' && status.captureId && ['recording','limit-reached'].includes(status.status)) {
        startCaptureOverlay();
      }
    } catch {}
  };
  restoreMobileCaptureOverlay();
  window.__SCM_BRIDGE__ = true;
  const pending = new Map();
  const pendingNetworkControl = new Map();
  const pendingReduxDiagnostics = new Map();
  const pendingDomDiagnostics = new Map();
  let networkResumeRequestedCaptureId = '';

  // Yandex/mobile builds do not always honor MV3 MAIN-world content scripts.
  // Inject the page hook as a real page script as a fallback, and independently
  // read the game's localStorage snapshot for warehouse/building state.
  const appendPageHookScript = () => {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('page-hook.js');
    script.async = false;
    script.onload = () => script.remove();
    script.onerror = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  };
  try {
    const inject = () => {
      if (document.documentElement?.dataset?.scmHookInjected === '1') return;
      appendPageHookScript();
      if (document.documentElement) document.documentElement.dataset.scmHookInjected = '1';
    };
    if (document.documentElement) inject();
    else document.addEventListener('DOMContentLoaded', inject, {once:true});
  } catch {}

  let directStateFingerprint = '';
  let directKnownRealm = null;
  let directCaptureRealm = null;
  const publishGameRealm = (realm, reason='') => {
    const n=Number(realm);
    if(n!==0 && n!==1) return null;
    directKnownRealm=n;
    try {
      window.__SCM_GAME_REALM__=n;
      window.dispatchEvent(new CustomEvent('scm-game-realm-change',{detail:{realm:n,reason}}));
    } catch {}
    return n;
  };
  let lastWarehouseCostDetailFingerprint = '';
  let lastProductionEventFingerprint = '';

  const parseEventExpiry = (untilText) => {
    const text=String(untilText||'').trim();
    const now=Date.now();
    let m=text.match(/(\d+)\s*d(?:ays?)?\s*(\d+)\s*h(?:ours?)?/i);
    if(m)return now+(Number(m[1])*86400+Number(m[2])*3600)*1000;
    m=text.match(/(\d+)\s*h(?:ours?)?/i);
    if(m)return now+Number(m[1])*3600000;
    m=text.match(/(\d+)\s*m(?:in(?:utes?)?)?/i);
    if(m)return now+Number(m[1])*60000;
    m=text.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
    if(m){const yy=Number(m[3]);const year=yy<100?2000+yy:yy;const d=new Date(year,Number(m[1])-1,Number(m[2]),23,59,59,999);if(Number.isFinite(d.getTime()))return d.getTime();}
    return null;
  };

  const captureProductionEvents = () => {
    try {
      let realm=directKnownRealm;
      const rm=String(location.pathname||'').match(/(?:\/rc\/|\/realm\/)(\d+)/i);
      if(rm)realm=Number(rm[1]);
      if(!Number.isFinite(realm))return;
      const events=[];
      for(const tr of document.querySelectorAll('tr')){
        const text=String(tr.textContent||'').replace(/\s+/g,' ').trim();
        const m=text.match(/([+-])\s*(\d+(?:\.\d+)?)%/);
        if(!m)continue;
        const cells=[...tr.querySelectorAll('th,td')].map(c=>String(c.textContent||'').replace(/\s+/g,' ').trim()).filter(Boolean);
        const resourceCell=cells[0]||'';
        const modifier=(m[1]==='-'?-1:1)*Number(m[2]);
        const resourceName=resourceCell.replace(/\s+(?:Q\d+|\d+\s*⭐).*$/,'').trim();
        if(!resourceName)continue;
        const untilText=cells.find(c=>/(?:\d+\s*d|\d+\s*h|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|until)/i.test(c))||'';
        events.push({resourceName,modifier,untilText,expiresAt:parseEventExpiry(untilText)});
      }
      const body=String(document.body?.innerText||'').replace(/\s+/g,' ').trim();
      const am=body.match(/production speed temporarily (increased|decreased) by (\d+(?:\.\d+)?)% until ([^.]+?)(?:\.|$)/i);
      if(am){
        const contextual=body.match(/([A-Za-z][A-Za-z0-9 &'\-]{2,60})\s+Q\d{1,2}\b.{0,140}?production speed temporarily/i);
        const headings=[...document.querySelectorAll('h1,h2,h3,[class*=title],[class*=name]')].map(x=>String(x.textContent||'').replace(/\s+/g,' ').trim()).filter(x=>/[A-Za-z]/.test(x)&&x.length>=3&&x.length<100);
        const usableHeadings=headings.filter(x=>!/(?:manager|production balance|show ticker|hide ticker|deficit|surplus|warehouse|vwap)/i.test(x));
        const heading=(contextual?.[1]||usableHeadings.find(x=>/\bQ\d{1,2}\b/i.test(x))||'');
        const resourceName=(heading||'').replace(/\s+Q\d+.*$/i,'').trim();
        if(resourceName)events.push({resourceName,modifier:(am[1].toLowerCase()==='decreased'?-1:1)*Number(am[2]),untilText:am[3].trim(),expiresAt:parseEventExpiry(am[3])});
      }
      const unique=new Map();
      for(const e of events){if(e.expiresAt!=null&&e.expiresAt<=Date.now())continue;unique.set(`${e.resourceName}|${e.modifier}|${e.untilText}`,e);}
      const list=[...unique.values()];
      if(!list.length && !/\bEVENTS\b/i.test(body))return;
      const fp=JSON.stringify({realm,list});
      if(fp===lastProductionEventFingerprint)return;
      lastProductionEventFingerprint=fp;
      safeRuntimeSend({type:'PRODUCTION_EVENTS',realm,events:list,capturedAt:new Date().toISOString()});
    } catch {}
  };

  const captureWarehouseCostDetail = () => {
    try {
      const path = String(location.pathname || '');
      if (!/\/headquarters\/warehouse\/[^/]+\/?$/.test(path)) return;
      const resourceLink = document.querySelector('a[href*="/encyclopedia/"][href*="/resource/"]');
      const resourceHref = resourceLink?.getAttribute('href') || '';
      const idMatch = resourceHref.match(/\/resource\/(\d+)\/?$/);
      const resourceId = idMatch ? Number(idMatch[1]) : null;
      if (!Number.isFinite(resourceId)) return;

      const bodyText = String(document.body?.innerText || '').replace(/\s+/g, ' ').trim();
      const costMatch = bodyText.match(/\$([0-9][0-9,]*(?:\.[0-9]+)?)\s*Sourcing cost/i);
      if (!costMatch) return;
      const unitCost = Number(costMatch[1].replace(/,/g, ''));
      if (!Number.isFinite(unitCost)) return;

      const qtyEl = document.querySelector('span.css-nzibbl > b');
      const qtyText = qtyEl?.textContent || bodyText.match(/([0-9][0-9,]*)\s+units/i)?.[1] || '';
      const quantity = Number(String(qtyText).replace(/,/g, ''));

      let quality = null;
      const starSelectors = ['svg[data-icon="star"]','svg.fa-star','.fa-star','[class*="fa-star"]'];
      for (const sel of starSelectors) {
        const stars = [...document.querySelectorAll(sel)];
        if (!stars.length) continue;
        const groups = new Map();
        for (const star of stars) {
          const parent = star.parentElement;
          if (!groups.has(parent)) groups.set(parent, []);
          groups.get(parent).push(star);
        }
        let maxQ = 0;
        for (const [parent, group] of groups) {
          const txt = String(parent?.textContent || '').trim();
          const m = txt.match(/^(\d+)/);
          if (m) maxQ = Math.max(maxQ, Number(m[1]));
          else maxQ = Math.max(maxQ, group.length);
        }
        if (maxQ > 0) { quality = maxQ; break; }
      }

      const fingerprint = JSON.stringify({resourceId,quality,quantity,unitCost});
      if (fingerprint === lastWarehouseCostDetailFingerprint) return;
      lastWarehouseCostDetailFingerprint = fingerprint;
      safeRuntimeSend({
        type: 'WAREHOUSE_COST_DETAIL',
        realm: directKnownRealm,
        resourceId,
        quality,
        quantity: Number.isFinite(quantity) ? quantity : null,
        unitCost,
        url: path,
        capturedAt: new Date().toISOString()
      });
    } catch {}
  };

  const scheduleWarehouseCostDetailCapture = () => {
    captureWarehouseCostDetail();
    setTimeout(captureWarehouseCostDetail, 500);
    setTimeout(captureWarehouseCostDetail, 1500);
  };

  let lastDirectStateRawByRealm = new Map();
  const captureDirectGameState = () => {
    try {
      let realm = null;
      const m = location.pathname.match(/\/rc\/(\d+)\//);
      if (m) realm = Number(m[1]); else realm = directKnownRealm;
      const preferred = (directCaptureRealm === 0 || directCaptureRealm === 1) ? directCaptureRealm : realm;
      const candidates = Number.isFinite(preferred) ? [preferred] : [];
      for (const r of candidates) {
        const raw = localStorage.getItem(`SimcompaniesRetailCalculation_${r}`);
        if (!raw) continue;
        if (lastDirectStateRawByRealm.get(r) === raw) return;
        lastDirectStateRawByRealm.set(r, raw);
        let parsed;
        try { parsed = JSON.parse(raw); } catch { continue; }
        if (!parsed || typeof parsed !== 'object') continue;
        const warehouseResources = Array.isArray(parsed.warehouseResources) ? parsed.warehouseResources : null;
        const buildings = Array.isArray(parsed.buildings) ? parsed.buildings : null;
        if (!warehouseResources && !buildings && parsed.administration == null && parsed.academyActive == null) continue;
        const fp = JSON.stringify({realm:r,warehouseResources,buildings,administration:parsed.administration,academyActive:parsed.academyActive});
        if (fp === directStateFingerprint) return;
        directStateFingerprint = fp;
        chrome.runtime.sendMessage({type:'GAME_STATE', realm:r, warehouseResources, buildings, region:parsed}).catch(()=>{});
        return;
      }
    } catch {}
  };
  captureDirectGameState();
  captureProductionEvents();
  scheduleWarehouseCostDetailCapture();
  setTimeout(captureDirectGameState, 1000);
  setTimeout(captureDirectGameState, 3000);
  // page-hook is the primary, change-driven game-state source. This 1-second fallback polls only while the
  // MAIN-world hook is unavailable (no duplicate GAME_STATE writes or realm-follow races); a raw storage value
  // is parsed only when it changed.
  setInterval(()=>{if(!hookReady&&!document.hidden)captureDirectGameState();}, 1000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!hookReady){try{captureDirectGameState();}catch{}}});
  // Mobile: background tabs do no polling work; a fresh capture runs when the tab is shown again.
  globalThis.__scmTimers.loop('prodEventsCapture',15000,()=>{if(!document.hidden)captureProductionEvents();});
  globalThis.__scmTimers.loop('warehouseCostCapture',10000,()=>{if(!document.hidden)captureWarehouseCostDetail();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){try{captureWarehouseCostDetail();}catch{}}});

  let seq = 0;
  const forceInjectPageHook = () => {
    try {
      if (hookReady) return;
      appendPageHookScript();
    } catch {}
  };
  const waitForHookReady = (timeoutMs=3000) => new Promise(resolve => {
    if (hookReady) return resolve(true);
    startPing();
    forceInjectPageHook();
    const deadline=Date.now()+Math.max(500,Number(timeoutMs)||3000);
    const timer=setInterval(()=>{
      if(hookReady || Date.now()>=deadline){clearInterval(timer);resolve(!!hookReady);}
    },150);
  });
  let hookReady = false;
  // Tell page-hook.js we are listening so it releases its queued network events.
  let bridgeInitializedAck = false;
  const sendBridgeInitialized = () => { try { globalThis.__scmPageBridge.handoff(); globalThis.__scmPageBridge.send({ source:'SIMCO_MANAGER', type:'INITIALIZED' }); } catch {} };
  let pingTimer = null;
  const pingHook = () => { try { globalThis.__scmPageBridge.send({source:'SIMCO_MANAGER',type:'BRIDGE_PING'}); } catch {} };
  const startPing = () => { if (hookReady || pingTimer) return; pingHook(); pingTimer = setInterval(() => { if (hookReady) { clearInterval(pingTimer); pingTimer=null; } else pingHook(); }, 1000); };

  globalThis.__scmPageBridge.listen((event) => {
    if (event.source !== window || event.data?.source !== 'SIMCO_MANAGER') return;
    const d = event.data;
    if (d.type === 'NETWORK_CAPTURE_CONTROL_ACK') {
      const resolveControl = pendingNetworkControl.get(String(d.requestId || ''));
      if (resolveControl) resolveControl({ok: d.ok !== false, error: d.error || null, captureId: d.captureId || '', enabled: Boolean(d.enabled)});
      return;
    }
    if (d.type === 'INITIALIZED_ACK' || d.type === 'BRIDGE_QUEUE_FLUSHED') {
      bridgeInitializedAck = true;
      if (Number(d.dropped) > 0) console.warn(`SCM bridge: ${d.dropped} early page events were dropped (queue limit).`);
      return;
    }
    if (d.type === 'HOOK_READY') {
      hookReady = true;
      // The page hook may have started after our first INITIALIZED was posted; repeat it (idempotent).
      if (!bridgeInitializedAck) sendBridgeInitialized();
      if (pingTimer) { clearInterval(pingTimer); pingTimer=null; }
      // If a diagnostic capture was active before a full page reload, resume it
      // under the same capture ID. A page reload destroys page-hook memory, not the
      // extension's durable capture record. Never resume a stopped/starting session.
      try {
        chrome.storage.local.get('scmNetworkTrafficCapture').then(raw => {
          const c=raw?.scmNetworkTrafficCapture;
          if(c?.status!=='recording'||!c?.captureId||networkResumeRequestedCaptureId===String(c.captureId))return;
          networkResumeRequestedCaptureId=String(c.captureId);
          globalThis.__scmPageBridge.send({source:'SIMCO_MANAGER',type:'SET_NETWORK_CAPTURE',enabled:true,resume:true,captureId:String(c.captureId),requestId:`resume-${Date.now()}`});
        }).catch(()=>{});
        chrome.runtime.sendMessage({type:'SCM_NET3_STATUS'}).then(result => {
          const c=result?.status;
          if(c?.mode!=='mobile-page'||c?.status!=='recording'||!c?.captureId)return;
          startCaptureOverlay();
          globalThis.__scmPageBridge.send({source:'SIMCO_MANAGER',type:'SET_NETWORK_CAPTURE',enabled:true,resume:true,captureId:String(c.captureId),requestId:`mobile-resume-${Date.now()}`});
        }).catch(()=>{});
      } catch {}
      return;
    }
    if (d.type === 'REALM_SWITCH') {
      const r=publishGameRealm(d.realm,'realm-switch-request');
      safeRuntimeSend({ type: 'REALM_SWITCH', realm: r??d.realm, url: d.url, method: d.method });
      return;
    }
    if (d.type === 'PAGE_REALM') {
      publishGameRealm(d.realm, `page-hook-${String(d.reason||'')}`);
      return;
    }
    if (d.type === 'REALM_SWITCH_CONFIRMED') {
      const r=publishGameRealm(d.realm,'realm-switch-confirmed');
      safeRuntimeSend({ type: 'REALM_SWITCH_CONFIRMED', realm: r??d.realm, url: d.url, method: d.method, status:d.status });
      return;
    }
    if (d.type === 'NETWORK_CAPTURE_EVENT') {
      // Refresh the visible count immediately; background polling reconciles it
      // with persisted counts, including events emitted by extension background.
      if (scmCaptureOverlay?.isConnected) {
        const count = scmCaptureOverlay.querySelector('[data-capture-count]');
        if (count) count.textContent = 'Captured: event recorded…';
      }
      safeRuntimeSend({type:'NETWORK_CAPTURE_EVENT',event:d.event||{},captureId:d.captureId||''});
      return;
    }
    if (d.type === 'GAME_CONFIG') {
      safeRuntimeSend({ type: 'GAME_CONFIG', config: d.config });
      return;
    }
    if (d.type === 'API_SEEN') {
      safeRuntimeSend({ type: 'API_SEEN', method: d.method, url: d.url, captureRealm: d.captureRealm });
      return;
    }
    if (d.type === 'STOCK_MUTATION_COMPLETE') {
      safeRuntimeSend({ type: 'STOCK_MUTATION_COMPLETE', method: d.method, url: d.url, status: d.status, captureRealm: d.captureRealm });
      return;
    }
    if (d.type === 'API_DATA') {
      if (/\/api\/v3\/companies\/auth-data\//.test(String(d.url||''))) { const a=d.data?.authCompany||{}; const r=Number(a.realmId??a.realm??d.data?.realmId??d.data?.realm); if(Number.isFinite(r)) publishGameRealm(r,'auth-data'); }
      safeRuntimeSend({ type: 'API_DATA', url: d.url, status: d.status, data: d.data, captureRealm: d.captureRealm });
      return;
    }
    if (d.type === 'MARKET_CACHE') {
      // Integer resource id and an array of at most 1000 rows; background.js checks every row (quality, prices, size).
      const rid = Number(d.resource);
      if (!Number.isInteger(rid) || rid <= 0 || rid >= 100000 || !Array.isArray(d.data)) return;
      const realm = Number.isInteger(d.realm) && d.realm >= 0 && d.realm < 100 ? d.realm : null;
      safeRuntimeSend({ type: 'MARKET_CACHE', resource: rid, realm, data: d.data.slice(0, 1000), receivedAt: typeof d.receivedAt === 'string' ? d.receivedAt.slice(0, 40) : null });
      return;
    }
    if (d.type === 'GAME_LOCAL_STORAGE_SNAPSHOT') {
      safeRuntimeSend({ type:'GAME_LOCAL_STORAGE_SNAPSHOT', ...d });
      return;
    }
    if (d.type === 'REPLAY_EVENT') {
      safeRuntimeSend({ type:'REPLAY_EVENT', ...d });
      return;
    }
    if (d.type === 'GAME_STATE') {
      const r=publishGameRealm(d.realm,'game-state');
      safeRuntimeSend({ type: 'GAME_STATE', realm: r??d.realm, warehouseResources: d.warehouseResources, buildings: d.buildings, region: d.region });
      return;
    }
    if (d.type === 'RESOURCE_CATALOG') {
      // Plain object, only the fields background.js reads, at most 16 MB serialized; background.js bounds every entry.
      const c = d.catalog;
      if (!c || typeof c !== 'object' || Array.isArray(c)) return;
      const catalog = { constantsResources: c.constantsResources ?? null, resourceImages: c.resourceImages ?? null, resourceNames: c.resourceNames ?? null };
      try { if (JSON.stringify(catalog).length > 16 * 1024 * 1024) return; } catch { return; }
      safeRuntimeSend({ type: 'RESOURCE_CATALOG', catalog, receivedAt: typeof d.receivedAt === 'string' ? d.receivedAt.slice(0, 40) : null });
      return;
    }
    if (d.type === 'RESOURCE_IMAGE_RESULT') {
      // Integer resource id and a string data URL within the 1 MB image cap only; background.js checks id, ask and image again.
      const rid = Number(d.resource);
      if (!Number.isInteger(rid) || rid <= 0 || rid >= 100000) return;
      if (d.dataUrl != null && (typeof d.dataUrl !== 'string' || d.dataUrl.length > 1398200)) return;
      safeRuntimeSend({ type: 'RESOURCE_IMAGE_RESULT', resource: rid, dataUrl: d.dataUrl || null, error: d.error ? String(d.error).slice(0, 300) : null });
      return;
    }
    if (d.type === 'JAVASCRIPT_DIAGNOSTIC') {
      // Object or null; background.js bounds and truncates it (2 MB). Over 16 MB serialized it is not forwarded.
      const diagnostic = d.diagnostic && typeof d.diagnostic === 'object' && !Array.isArray(d.diagnostic) ? d.diagnostic : null;
      try { if (diagnostic && JSON.stringify(diagnostic).length > 16 * 1024 * 1024) return; } catch { return; }
      safeRuntimeSend({ type:'JAVASCRIPT_DIAGNOSTIC', requestId:d.requestId ? String(d.requestId).slice(0, 200) : null, diagnostic, error:d.error ? String(d.error).slice(0, 500) : null });
      return;
    }
    if (d.type === 'REDUX_STATE_DIAGNOSTIC_RESULT') {
      const finish=pendingReduxDiagnostics.get(String(d.requestId||''));
      if(finish) finish({ok:!d.error && Boolean(d.diagnostic),diagnostic:d.diagnostic||null,error:d.error||null});
      return;
    }
    if (d.type === 'DOM_RUNTIME_DIAGNOSTIC_RESULT') {
      const finish=pendingDomDiagnostics.get(String(d.requestId||''));
      if(finish) finish({ok:!d.error && Boolean(d.diagnostic),diagnostic:d.diagnostic||null,error:d.error||null});
      return;
    }
    if (d.type === 'API_RESULT') {
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      p.resolve(d);
    }
  });

  let lastWarehouseCostPath = location.pathname;
  // Mobile CPU: coalesce the subtree callback to one path check per idle slot/frame.
  let warehouseCostPathCheckPending = false;
  const checkWarehouseCostPath = () => {
    warehouseCostPathCheckPending = false;
    if (lastWarehouseCostPath !== location.pathname) {
      lastWarehouseCostPath = location.pathname;
      lastWarehouseCostDetailFingerprint = '';
      scheduleWarehouseCostDetailCapture();
    }
  };
  new MutationObserver(() => {
    if (warehouseCostPathCheckPending) return;
    warehouseCostPathCheckPending = true;
    if (typeof requestIdleCallback === 'function') requestIdleCallback(checkWarehouseCostPath, {timeout:300}); else setTimeout(checkWarehouseCostPath, 100);
  }).observe(document.documentElement || document, {subtree:true, childList:true});

  startPing();
  // The page is going away (realm switch, reload, bfcache): answer every open PAGE_API_GET now.
  try { window.addEventListener('pagehide', () => { for (const p of Array.from(pending.values())) { try { p.resolve({ ok:false, status:0, error:'The game page was reloaded or closed before the API answered.', pageClosed:true }); } catch {} } }); } catch {}

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if(message?.type==='RUN_DOM_RUNTIME_DIAGNOSTIC'){
      const requestId=String(message.requestId||`dom-${Date.now()}-${++seq}`);
      let settled=false;
      const finish=(result)=>{if(settled)return;settled=true;clearTimeout(timer);pendingDomDiagnostics.delete(requestId);sendResponse(result);};
      const timer=setTimeout(()=>finish({ok:false,error:'Timed out waiting for the MAIN-world DOM/runtime inspection. The report was not marked successful.'}),7000);
      pendingDomDiagnostics.set(requestId,finish);
      (async()=>{
        const ready=await waitForHookReady(4500);
        if(!ready)throw new Error('Sim Companies page hook was not ready; reload the game tab and retry.');
        globalThis.__scmPageBridge.send({source:'SIMCO_MANAGER',type:'DOM_RUNTIME_DIAGNOSTIC_GET',id:requestId});
      })().catch(error=>finish({ok:false,error:error?.message||String(error)}));
      return true;
    }
    if(message?.type==='RUN_REDUX_STATE_DIAGNOSTIC'){
      const requestId=String(message.requestId||`redux-${Date.now()}-${++seq}`);
      let settled=false;
      const finish=(result)=>{if(settled)return;settled=true;clearTimeout(timer);pendingReduxDiagnostics.delete(requestId);sendResponse(result);};
      const timer=setTimeout(()=>finish({ok:false,error:'Timed out waiting for the page-hook state diagnostic response.'}),6500);
      pendingReduxDiagnostics.set(requestId,finish);
      (async()=>{
        const ready=await waitForHookReady(3500);
        if(!ready) throw new Error('Sim Companies page hook was not ready; reload the game tab and retry.');
        globalThis.__scmPageBridge.send({source:'SIMCO_MANAGER',type:'REDUX_STATE_DIAGNOSTIC_GET',id:requestId});
      })().catch(error=>finish({ok:false,error:error?.message||String(error)}));
      return true;
    }
    if(message?.type==='SET_NETWORK_CAPTURE'){
      const requestId=`netcap-${Date.now()}-${++seq}`;
      let settled=false;
      const finish=(result)=>{if(settled)return;settled=true;clearTimeout(timer);pendingNetworkControl.delete(requestId);sendResponse(result);};
      const timer=setTimeout(()=>finish({ok:false,error:'Timed out waiting for the game-page recorder to acknowledge the capture command.'}),5000);
      pendingNetworkControl.set(requestId,finish);
      (async()=>{
        const ready=await waitForHookReady(3500);
        if(!ready)throw new Error('Game-page recorder hook is not ready. Reload the Sim Companies tab and try again.');
        if (message.enabled) startCaptureOverlay();
        else stopCaptureOverlay();
        globalThis.__scmPageBridge.send({source:'SIMCO_MANAGER',type:'SET_NETWORK_CAPTURE',enabled:Boolean(message.enabled),captureId:String(message.captureId||''),requestId});
      })().catch(error=>{if(message.enabled)stopCaptureOverlay();finish({ok:false,error:error?.message||String(error)});});
      return true;
    }
    // REFRESH_GAME_OVERLAY is handled inside the overlay IIFE below, where load() is in scope.
    if (message?.type === 'CAPTURE_PRODUCTION_EVENTS') {
      captureProductionEvents();
      sendResponse({ok:true});
      return false;
    }
    if (message?.type === 'SET_SYNC_REALM') {
      const forced = Number(message.realm);
      directCaptureRealm = forced === 0 || forced === 1 ? forced : null;
      globalThis.__scmPageBridge.send({ source: 'SIMCO_MANAGER', type: 'SET_SYNC_REALM', realm: forced, ttlMs: Number(message.ttlMs) || 120000 });
      sendResponse({ok:true,realm:forced});
      return false;
    }
    if (message?.type === 'CLEAR_SYNC_REALM') {
      directCaptureRealm = null;
      globalThis.__scmPageBridge.send({ source: 'SIMCO_MANAGER', type: 'CLEAR_SYNC_REALM' });
      sendResponse({ok:true});
      return false;
    }
    if (message?.type === 'BRIDGE_STATUS') {
      sendResponse({ok:true, ready:!!hookReady, realm:directKnownRealm===0||directKnownRealm===1?directKnownRealm:null});
      return false;
    }
    if (message?.type === 'PAGE_GAME_STATE') {
      globalThis.__scmPageBridge.send({ source: 'SIMCO_MANAGER', type: 'GAME_STATE_GET' });
      sendResponse({ok:true});
      return false;
    }
    if (message?.type === 'PAGE_RESOURCE_IMAGE') {
      globalThis.__scmPageBridge.send({ source: 'SIMCO_MANAGER', type: 'RESOURCE_IMAGE_GET', resource: Number(message.resource) });
      sendResponse({ok:true});
      return false;
    }
    if (message?.type === 'RUN_QUICK_JAVASCRIPT_DIAGNOSTIC') {
      try {
        const realmMatch=location.pathname.match(/\/rc\/(\d+)\//);
        const realm=realmMatch?Number(realmMatch[1]):null;
        const localStorageKeys=[];
        try{for(let i=0;i<localStorage.length;i++)localStorageKeys.push(localStorage.key(i)||'');}catch{}
        const diagnostic={
          diagnosticSchemaVersion:1,
          javascriptDiagnosticVersion:'quick-content-1.0.0',
          capturedAt:new Date().toISOString(),
          durationMs:0,
          runtime:{userAgent:String(navigator.userAgent||''),language:String(navigator.language||''),platform:String(navigator.platform||''),pageUrl:String(location.href||''),origin:String(location.origin||''),pathname:String(location.pathname||''),readyState:String(document.readyState||''),visibility:String(document.visibilityState||''),realm:Number.isFinite(realm)?realm:null,title:String(document.title||''),scriptTagCount:document.scripts.length,performanceResourceCount:performance.getEntriesByType('resource').length,online:navigator.onLine===true},
          bundles:[],
          performanceResources:performance.getEntriesByType('resource').slice(-100).map(e=>({name:String(e.name||''),initiatorType:String(e.initiatorType||''),duration:Number.isFinite(e.duration)?Math.round(e.duration*100)/100:null,transferSize:Number.isFinite(e.transferSize)?e.transferSize:null,encodedBodySize:Number.isFinite(e.encodedBodySize)?e.encodedBodySize:null,startTime:Number.isFinite(e.startTime)?Math.round(e.startTime*100)/100:null})),
          discoveredApiRoutes:[],discoveredSymbols:[],categoryHits:{},
          storage:{localStorageKeys:localStorageKeys.sort(),sessionStorageKeys:[]},
          indexedDB:[],caches:{names:[]},serviceWorkers:[],globalKeys:[],
          limits:{mode:'quick-content-fallback',note:'Deep page-hook diagnostic was unavailable or timed out.'}
        };
        sendResponse({ok:true,diagnostic});
      } catch(e) { sendResponse({ok:false,error:e?.message||String(e)}); }
      return false;
    }
    if (message?.type === 'RUN_JAVASCRIPT_DIAGNOSTIC') {
      waitForHookReady(3500).then(ready => {
        if (!ready) {
          sendResponse({ok:false,error:'Sim Companies page hook was not ready after reinjection.'});
          return;
        }
        globalThis.__scmPageBridge.send({ source:'SIMCO_MANAGER', type:'JAVASCRIPT_DIAGNOSTIC_GET', id:message.requestId||null });
        sendResponse({ok:true});
      }).catch(e => sendResponse({ok:false,error:e?.message||String(e)}));
      return true;
    }
    // PAGE_IMAGE_GET (background resource-image cache): same reply path as PAGE_API_GET; the page hook reads a
    // /static/images/ file same-origin (IMAGE_GET) and answers {ok, status, mime, dataUrl}. Other paths are refused here.
    const isImage = message?.type === 'PAGE_IMAGE_GET';
    if (!isImage && message?.type !== 'PAGE_API_GET') return;
    if (isImage && (typeof message.path !== 'string' || !/^\/static\/images\/[A-Za-z0-9._\/-]+$/.test(message.path) || message.path.split('/').some(s => /^\.+$/.test(s)))) { sendResponse({ ok:false, status:400, error:'Only /static/images/ paths are allowed.' }); return false; }
    // Every path answers: the page-hook's API_RESULT, a failed bridge send, a last-resort timeout (after the
    // background's own race, so it never changes timing; it only frees the entry), or pagehide (the realm switch or a
    // reload unloads the page; background treats pageClosed as a quiet skip). Without this, a page unload left the
    // channel open and Chrome reported "message channel closed before a response was received".
    const id = `${Date.now()}-${++seq}`;
    const requested = Number(message.timeoutMs);
    const hookTimeoutMs = Number.isFinite(requested) && requested >= 3000 ? Math.min(requested, 60000) : 8000;
    let settled = false;
    const reply = (result) => { if (settled) return; settled = true; clearTimeout(timer); pending.delete(id); try { sendResponse(result); } catch {} };
    const timer = setTimeout(() => reply({ ok:false, status:0, error:'Sim Companies page API request timed out.' }), hookTimeoutMs + 3000);
    pending.set(id, { resolve: reply });
    try { globalThis.__scmPageBridge.send({ source: 'SIMCO_MANAGER', type: isImage ? 'IMAGE_GET' : 'API_GET', id, path: message.path, timeoutMs: message.timeoutMs }); }
    catch (e) { reply({ ok:false, status:0, error:e?.message || String(e) }); }
    return true;
  });
})();

// Page text for "which page is this" checks that run from mutation observers. document.body.innerText
// forces a full layout; this walks text nodes (no layout), skipping script/style, and joins them with spaces.
function scmPageTextNoLayout(){
  try{
    const body=document.body;if(!body)return '';
    const skip=/^(?:SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/;
    const walker=document.createTreeWalker(body,NodeFilter.SHOW_TEXT,{acceptNode:n=>skip.test(n.parentNode?.nodeName||'')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT});
    const parts=[];let node;
    while((node=walker.nextNode()))parts.push(node.nodeValue);
    return parts.join(' ');
  }catch{return String(document.body?.textContent||'');}
}

// Exchange VWAP overlay: a VWAP comparison badge in each listing row of the game's Exchange page.
(() => {
  // waitForBridge can inject content.js again into a tab where it already runs; one instance per tab, or
  // duplicate listeners and timers repaint the same cards from different snapshots.
  if (window.__SCM_EXCHANGE_OVERLAY__) return;
  window.__SCM_EXCHANGE_OVERLAY__ = true;
  const money=v=>Number.isFinite(Number(v))?'$'+Number(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
  const norm=v=>String(v??'').toLowerCase().replace(/[^a-z0-9]+/g,'').replace(/s$/,'');
  const isExchange=()=>{
    const path=String(location.pathname||'');
    return /\/market\/resource\/\d+/i.test(path) || /\/(?:exchange)(?:\/|$)/i.test(path);
  };
  const resourceIdFromPage=()=>{
    const path=String(location.pathname||'');
    const parts=path.split('/').filter(Boolean);
    const marketIndex=parts.findIndex(x=>/^(?:market|exchange)$/i.test(x));
    if(marketIndex>=0){
      for(let i=marketIndex+1;i<parts.length;i++){
        if(/^\d+$/.test(parts[i])){const id=Number(parts[i]);if(id>0)return id;}
      }
    }
    const el=document.querySelector('[data-resource-id],[data-resource]');
    if(el){
      for(const a of ['data-resource-id','data-resource']){
        const n=Number(el.getAttribute(a));if(Number.isFinite(n)&&n>0)return n;
      }
    }
    return null;
  };
  const nativeText=el=>{
    try{
      const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);
      const out=[];let n;
      while(n=walker.nextNode()){
        if(n.parentElement?.closest?.('.scx-vwap-host,.scx-vwap-badge,.scx-vwap-popover'))continue;
        out.push(String(n.nodeValue||''));
      }
      return out.join(' ').replace(/\s+/g,' ').trim();
    }catch{return String(el?.textContent||'').replace(/\s+/g,' ').trim();}
  };
  const parseNum=v=>{
    const t=String(v??'').replace(/\u00a0/g,' ').trim();
    const m=t.match(/-?\d[\d,]*(?:\.\d+)?/);
    return m?Number(m[0].replace(/,/g,'')):null;
  };
  const parsePriceCell=cell=>{
    const t=nativeText(cell);
    const m=t.match(/\$\s*([0-9][0-9,]*(?:\.\d+)?)/);
    return m?Number(m[1].replace(/,/g,'')):null;
  };
  // Exchange rows are seller -> quality -> quantity -> price. Do not infer this from generic numeric ordering.
  const qualityFromCell=cell=>{
    if(!cell)return null;
    const text=nativeText(cell);
    const q=text.match(/\bq\s*(\d{1,2})\b/i);
    if(q)return Number(q[1]);
    const star=/[★☆⭐]/.test(text)||cell.querySelector?.('svg,svg *,[class*="star" i],[data-testid*="star" i],img[alt*="star" i],img[src*="star" i],i[class*="star" i],span[class*="star" i]');
    if(star){
      const n=text.match(/(?:^|\s)(\d{1,2})(?:\s|$)/);
      if(n)return Number(n[1]);
    }
    return null;
  };
  const extractQualityFromRow=row=>{
    const cells=[...row?.querySelectorAll?.('td')||[]];
    // Native Exchange layout: td[1] contains the quality number + star marker.
    for(const idx of [1,2,0]){
      const q=qualityFromCell(cells[idx]);
      if(Number.isFinite(q))return q;
    }
    const text=nativeText(row);
    const q=text.match(/\bq\s*(\d{1,2})\b/i);
    return q?Number(q[1]):null;
  };
  const parseListingRow=row=>{
    if(!row||row.nodeType!==1)return null;
    const tag=String(row.tagName||'').toUpperCase();
    if(tag==='TR'&&row.querySelector('th'))return null;
    const cells=[...row.querySelectorAll?.('td')||[]];
    if(cells.length>=4){
      // This is the actual SimCompanies mobile/desktop Exchange ordering:
      // [seller] [quality] [quantity] [price].
      const quality=extractQualityFromRow(row);
      const quantity=parseNum(nativeText(cells[2]));
      const price=parsePriceCell(cells[3]);
      if(Number.isFinite(price)&&Number.isFinite(quantity)){
        return {row,price,quantity,quality,priceCell:cells[3],cellForRail:cells[3]};
      }
      // Desktop variants can swap quantity/price while retaining a quality cell.
      const p2=parsePriceCell(cells[2]);
      const q3=parseNum(nativeText(cells[3]));
      if(Number.isFinite(p2)&&Number.isFinite(q3)){
        return {row,price:p2,quantity:q3,quality,priceCell:cells[2],cellForRail:cells[2]};
      }
    }
    if(cells.length>=3){
      const priceCell=cells.find(c=>parsePriceCell(c)!=null);
      const price=priceCell?parsePriceCell(priceCell):null;
      if(Number.isFinite(price)){
        const priceIndex=cells.indexOf(priceCell);
        const candidates=cells.map((c,i)=>({i,n:parseNum(nativeText(c))}))
          .filter(x=>Number.isFinite(x.n)&&x.i!==priceIndex);
        const quality=extractQualityFromRow(row);
        // Prefer the largest non-price numeric cell, excluding the quality cell.
        const filtered=candidates.filter(x=>!(x.i===1&&Number.isFinite(quality)&&x.n===quality));
        filtered.sort((a,b)=>b.n-a.n);
        const quantity=(filtered[0]||candidates[0])?.n;
        if(Number.isFinite(quantity))return {row,price,quantity,quality,priceCell,cellForRail:priceCell};
      }
    }
    const text=nativeText(row);
    const pm=text.match(/\$\s*([0-9][0-9,]*(?:\.\d+)?)/);
    if(!pm)return null;
    const price=Number(pm[1].replace(/,/g,''));
    const before=text.split('$')[0];
    const nums=[...before.matchAll(/\b[0-9][0-9,]*\b/g)].map(m=>Number(m[0].replace(/,/g,''))).filter(Number.isFinite);
    const quality=extractQualityFromRow(row);
    const quantity=nums.length?nums[nums.length-1]:null;
    return Number.isFinite(quantity)?{row,price,quantity,quality,priceCell:cells[cells.length-1]||row,cellForRail:cells[cells.length-1]||row}:null;
  };
  const sellerTokens=name=>{const n=norm(name);return [...new Set((n.match(/[a-z0-9]{4,}/g)||[]))].sort((a,b)=>b.length-a.length)};
  const matchRecord=(parsed,marketRows)=>{
    if(!parsed)return null;
    const p=Number(parsed.price),q=Number(parsed.quantity);
    if(!Number.isFinite(p)||!Number.isFinite(q))return null;
    let candidates=(Array.isArray(marketRows)?marketRows:[]).filter(x=>Number(x?.price)===p&&Number(x?.quantity)===q);
    if(!candidates.length)return null;
    // Prefer the quality extracted from the actual Exchange row. This avoids ambiguous matches
    // when multiple quality listings share the same price and quantity.
    if(Number.isFinite(Number(parsed.quality))){
      const byQuality=candidates.filter(x=>Number(x?.quality)===Number(parsed.quality));
      if(byQuality.length)candidates=byQuality;
    }
    if(candidates.length===1)return {...parsed,record:candidates[0]};
    const text=norm(nativeText(parsed.row));
    for(const c of candidates){
      const tok=sellerTokens(c?.seller?.company||'');
      if(tok.some(t=>text.includes(t)))return {...parsed,record:c};
    }
    const qualities=[...new Set(candidates.map(x=>Number(x?.quality)).filter(Number.isFinite))];
    return qualities.length===1?{...parsed,record:candidates[0]}:null;
  };

  let dataCache=null,cacheAt=0,cacheRealm=null,cacheResourceId=null,scheduled=0,processing=false,raf=0,dataInflight=null,startupRetryTimer=0,startupRetryAttempt=0,rerun=false;
  // Use the game's own market response directly (seen by the page hook) instead of
  // waiting for it to be written to storage and read back. VWAP rows are cached separately.
  const liveMarket=new Map();let liveLatestId=null,vwapCache=null;
  globalThis.__scmPageBridge.listen(event=>{
    if(event.source!==window||event.data?.source!=='SIMCO_MANAGER'||event.data?.type!=='API_DATA')return;
    const d=event.data,m=String(d.url||'').match(/^\/api\/v3\/market\/(\d+)\/(\d+)\/?(?:\?.*)?$/);
    if(!m||!(Number(d.status)>=200&&Number(d.status)<300)||!Array.isArray(d.data))return;
    const rid=Number(m[2]);liveMarket.delete(rid);liveMarket.set(rid,{rows:d.data,realm:Number(m[1]),at:Date.now()});liveLatestId=rid;
    while(liveMarket.size>40)liveMarket.delete(liveMarket.keys().next().value);
    if(isExchange())schedule();
  });
  const loadData=async()=>{
    if(!isExchange())return null;
    const hint=resourceIdFromPage(),now=Date.now();
    const hintedRid=Number.isFinite(Number(hint))?Number(hint):null;
    const wantRid=hintedRid??liveLatestId,live=wantRid!=null?liveMarket.get(wantRid):null;
    if(live&&live.rows.length&&now-live.at<120000&&vwapCache&&vwapCache.realm===live.realm&&vwapCache.rows.length&&now-vwapCache.at<600000)
      return {rows:vwapCache.rows,marketRows:live.rows,realm:live.realm,resourceId:wantRid};
    if(dataCache&&cacheResourceId===hintedRid&&cacheRealm!=null&&now-cacheAt<60000&&Array.isArray(dataCache.rows)&&dataCache.rows.length&&Array.isArray(dataCache.marketRows)&&dataCache.marketRows.length)return dataCache;
    if(dataInflight)return dataInflight;
    dataInflight=new Promise(resolve=>{
      try{
        // Exchange routes do not encode the realm: use this tab's realm (from the game's auth-data); until it
        // is known, show no badge rather than the last-synced realm's VWAP.
        const tabRealm=Number(window.__SCM_GAME_REALM__);
        if(tabRealm!==0&&tabRealm!==1){resolve(null);return;}
        chrome.runtime.sendMessage({type:'GET_VWAP_OVERLAY_DATA',resourceId:hintedRid,realm:tabRealm},r=>resolve(chrome.runtime.lastError?null:r||null));
      }
      catch{resolve(null);}
    }).then(response=>{
      if(!response?.ok)return null;
      const vrows=Array.isArray(response.rows)?response.rows:[];
      const rid=Number(response.resourceId||hintedRid);
      const realmN=Number(response.realm);
      let marketRows=Array.isArray(response.marketRows)?response.marketRows:[];
      const lv=liveMarket.get(rid);if(lv&&lv.realm===realmN&&lv.rows.length)marketRows=lv.rows;
      // The overlay compares with VWAP only (see exchangeCompare); marketRows are kept for other readers.
      if(!vrows.length&&!marketRows.length)return null;
      response.rows=vrows;
      if(vrows.length)vwapCache={rows:vrows,realm:realmN,at:Date.now()};
      const next={rows:response.rows,marketRows,realm:realmN,resourceId:rid};
      dataCache=next;cacheRealm=next.realm;cacheResourceId=rid;cacheAt=Date.now();return next;
    }).finally(()=>{dataInflight=null;});
    return dataInflight;
  };

  const removeBadge=host=>{
    if(!host)return;
    const pop=host.__scmPopover;if(pop?.parentNode)pop.remove();
    host.remove();
  };
  const clear=()=>document.querySelectorAll('.scx-vwap-host').forEach(removeBadge);

  const positionPopover=host=>{
    const pop=host?.__scmPopover;if(!pop)return;
    const badge=host.querySelector('.scx-vwap-badge');if(!badge)return;
    const r=badge.getBoundingClientRect();if(r.width<1)return;
    pop.style.display='block';
    const pw=Math.min(250,window.innerWidth-20),ph=Math.min(220,window.innerHeight-20);
    let left=r.left-pw-8;if(left<10)left=Math.min(window.innerWidth-pw-10,r.right+8);
    let top=r.top;if(top+ph>window.innerHeight-10)top=Math.max(10,window.innerHeight-ph-10);
    pop.style.left=`${Math.max(10,left)}px`;pop.style.top=`${top}px`;
  };
  const styles=()=>{
    if(document.getElementById('scm-exchange-vwap-style'))return;
    const st=document.createElement('style');st.id='scm-exchange-vwap-style';
    st.textContent=`.scx-vwap-host{position:relative;display:inline-flex;align-items:center;justify-content:flex-end;white-space:nowrap;vertical-align:middle;min-width:0;z-index:5}.scx-vwap-badge{position:relative;z-index:6;display:inline-flex;align-items:center;padding:2px 5px;border-radius:6px;cursor:pointer;user-select:none;white-space:nowrap;font:700 9px/1.1 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 1px 2px rgba(0,0,0,.25);pointer-events:auto}.scx-vwap-badge.scx-expensive{color:#f9ddd8;background:rgba(120,33,20,.90);border:1px solid rgba(232,129,113,.55)}.scx-vwap-badge.scx-cheap{color:#d4eacd;background:rgba(48,84,36,.90);border:1px solid rgba(134,194,114,.55)}.scx-vwap-badge.scx-flat{color:#eeeded;background:rgba(23,22,21,.92);border:1px solid rgba(149,144,141,.55)}.scx-vwap-popover{position:fixed;z-index:2147483647;display:none;width:max-content;min-width:190px;max-width:min(250px,calc(100vw - 20px));background:#181716;color:#eeeded;border:1px solid #4d4947;border-radius:8px;padding:8px;box-shadow:0 8px 24px rgba(0,0,0,.55);font:10px/1.25 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.scx-vwap-popover-title{font-weight:800;color:#bfbcba;margin-bottom:5px;padding-bottom:5px;border-bottom:1px solid #3a3736}.scx-vwap-popover-row{display:flex;justify-content:space-between;gap:12px;margin-top:4px}.scx-vwap-popover-label{color:#a6a19f}.scx-vwap-popover-value{font-weight:700;white-space:nowrap}`;
    (document.head||document.documentElement).appendChild(st);
  };
  // Compare a listing with the VWAP for its own quality only. VWAP is the previous day's figure.
  // No VWAP for that quality means no badge. ±2% = Fair.
  const exchangeCompare=(listing,vwap)=>{
    const price=Number(listing?.price);
    if(!Number.isFinite(price)||price<=0)return null;
    const ref=Number(vwap);
    if(!Number.isFinite(ref)||ref<=0)return null;
    const pct=(price-ref)/ref*100;
    return {ref,pct,diff:price-ref,verdict:pct<=-2?'Cheap':pct>=2?'Expensive':'Fair'};
  };
  const pctText=p=>`${p>=0?'+':'−'}${Math.abs(p).toFixed(1)}%`;
  // What a badge shows. A closed badge is rebuilt only when this changes.
  const badgeSignature=(candidate,mapped)=>{
    const q=Number(candidate?.record?.quality);if(!Number.isFinite(q))return '';
    const cmp=exchangeCompare({price:candidate.price,quantity:candidate.quantity},mapped.get(q));
    return cmp?`${q}|${candidate.price}|${candidate.quantity}|${cmp.ref}|${cmp.pct}|${cmp.diff}|${cmp.verdict}`:'';
  };
  const makeBadge=(candidate,rid,mapped)=>{
    const q=Number(candidate.record?.quality);if(!Number.isFinite(q))return null;
    const cmp=exchangeCompare({price:candidate.price,quantity:candidate.quantity},mapped.get(q));if(!cmp)return null;
    const pct=cmp.pct,diff=cmp.diff,refLabel=`VWAP Q${q}`;
    const host=document.createElement('span');host.className='scx-vwap-host';
    host.dataset.vwapKey=`${rid}:${candidate.record?.id??`${q}:${candidate.quantity}:${candidate.price}`}`;
    const b=document.createElement('button');b.type='button';b.className='scx-vwap-badge '+(pct>0.0001?'scx-expensive':pct<-0.0001?'scx-cheap':'scx-flat');
    const verdictText=`${cmp.verdict} ${pctText(pct)} · Q${q}`;
    b.textContent=`ⓘ ${verdictText}`;b.title='Compare with market price';b.setAttribute('aria-label','Compare with market price');
    const pop=document.createElement('div');pop.className='scx-vwap-popover';
    const row=(k,val,cls='')=>`<div class="scx-vwap-popover-row"><span class="scx-vwap-popover-label">${k}</span><span class="scx-vwap-popover-value ${cls}">${val}</span></div>`;
    const fee=0.04; // the Manager's exchange fee is always 4%
    pop.innerHTML=`<div class="scx-vwap-popover-title">${verdictText}</div>${row('Listing price',money(candidate.price))}${row(refLabel,money(cmp.ref))}${row('Difference',`${diff>=0?'+':''}${money(diff)} · ${pctText(pct)}`,pct<=-2?'good':pct>=2?'bad':'')}${row('Listing quantity',candidate.quantity.toLocaleString())}${row('Net after 4% fee',money(candidate.price*(1-fee)))}`;
    host.__scmPopover=pop;host.__scmRow=candidate.row;host.__scmSig=badgeSignature(candidate,mapped);
    b.addEventListener('click',e=>{
      e.preventDefault();e.stopPropagation();
      const wasOpen=pop.style.display==='block'&&host.dataset.open==='1';
      document.querySelectorAll('.scx-vwap-host[data-open="1"]').forEach(x=>{x.dataset.open='0';if(x.__scmPopover)x.__scmPopover.style.display='none';});
      if(wasOpen){pop.style.display='none';host.dataset.open='0';}
      else{host.dataset.open='1';positionPopover(host);}
    });
    b.addEventListener('pointerdown',e=>e.stopPropagation(),{passive:true});
    host.appendChild(b);
    document.body.appendChild(pop);
    // Inject into the native price cell. Do not rewrite the cell's display/flex styles; React owns them.
    const cell=candidate.priceCell||candidate.cellForRail||candidate.row.querySelectorAll?.('td')?.item?.(candidate.row.querySelectorAll?.('td')?.length-1)||candidate.row;
    if(cell){
      host.dataset.scmExchangeInjected='1';
      host.style.marginLeft='6px';
      host.style.display='inline-flex';
      host.style.verticalAlign='middle';
      host.style.pointerEvents='auto';
      cell.appendChild(host);
    }else{candidate.row.appendChild(host);}
    return host;
  };

  const processVwapUI=async(startup=false)=>{
    if(!isExchange())return;
    if(processing){rerun=true;return;}
    processing=true;
    try{
      styles();
      const data=await loadData();
      if(!data?.rows?.length){if(startup)scheduleStartupRetry();return;}
      const rid=Number(data.resourceId);if(!Number.isFinite(rid)||rid<=0){if(startup)scheduleStartupRetry();return;}
      const mapped=new Map(data.rows.filter(x=>Number(x.resourceId)===rid).map(x=>[Number(x.quality),Number(x.value)]));
      if(!mapped.size&&!(data.marketRows||[]).length){if(startup)scheduleStartupRetry();return;}
      const rows=[...document.querySelectorAll('tbody tr, tr, div.row')].filter(row=>row.nodeType===1&&!row.querySelector?.('th'));
      const wanted=new Set();
      const existingHosts=new Map([...document.querySelectorAll('.scx-vwap-host')].map(host=>[String(host.dataset.vwapKey||''),host]));
      let matchedCount=0;
      for(const row of rows){
        const parsed=parseListingRow(row);if(!parsed)continue;
        // The cheapest (first) rows are the ones that change fastest, so the stored order-book
        // snapshot is often stale for exactly those rows. The badge only needs the quality shown in the row
        // and its price, so fall back to the row's own quality instead of skipping the row.
        let candidate=matchRecord(parsed,data.marketRows||[]);
        if(!candidate){const rq=Number(parsed.quality);if(Number.isFinite(rq))candidate={...parsed,record:{quality:rq}};else continue;}
        matchedCount++;
        const key=`${rid}:${candidate.record?.id??`${candidate.record?.quality}:${candidate.quantity}:${candidate.price}`}`;wanted.add(key);
        let host=existingHosts.get(key)||null;
        if(!host||host.__scmRow!==row||(host.dataset.open!=='1'&&host.__scmSig!==badgeSignature(candidate,mapped))){
          if(host)removeBadge(host);
          host=makeBadge(candidate,rid,mapped);
        }else{
          host.__scmRow=row;
        }
        if(host&&host.dataset.open==='1'&&host.__scmPopover?.style.display==='block')positionPopover(host);
      }
      for(const host of [...document.querySelectorAll('.scx-vwap-host')])if(!wanted.has(String(host.dataset.vwapKey||'')))removeBadge(host);
      if(matchedCount>0)resetStartupRetry();else if(startup)scheduleStartupRetry();
    }finally{processing=false;if(rerun){rerun=false;schedule(startup);}}
  };
  const scheduleStartupRetry=()=>{
    if(!isExchange()||startupRetryTimer)return;
    const delays=[150,300,600,1200,2500,5000,8000];
    const delay=delays[Math.min(startupRetryAttempt,delays.length-1)];
    startupRetryAttempt++;
    startupRetryTimer=setTimeout(()=>{startupRetryTimer=0;processVwapUI(true);},delay);
  };
  const resetStartupRetry=()=>{if(startupRetryTimer){clearTimeout(startupRetryTimer);startupRetryTimer=0;}startupRetryAttempt=0;};
  const schedule=(startup=false)=>{if(scheduled)return;scheduled=setTimeout(()=>{scheduled=0;processVwapUI(startup);},350);};
  const reposition=()=>{if(raf)return;raf=requestAnimationFrame(()=>{raf=0;for(const host of [...document.querySelectorAll('.scx-vwap-host')])if(host.__scmPopover?.style.display==='block')positionPopover(host);});};
  const observer=new MutationObserver(muts=>{
    if(!isExchange())return;
    const relevant=muts.some(m=>{
      if(m.type!=='childList')return false;
      const target=m.target?.closest?.('.scx-vwap-host,.scx-vwap-popover');if(target)return false;
      const nodes=[...(m.addedNodes||[]),...(m.removedNodes||[])];
      if(nodes.length&&nodes.every(n=>n.nodeType===1 && (n.matches?.('.scx-vwap-host,.scx-vwap-popover,[data-scm-owned]')||n.closest?.('.scx-vwap-host,.scx-vwap-popover,[data-scm-owned]'))))return false;
      return nodes.length>0;
    });
    if(relevant)schedule();
  });
  const cleanup=()=>{clear();document.querySelectorAll('.scx-vwap-popover').forEach(x=>x.remove());resetStartupRetry();if(dataInflight){dataInflight=null;}};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>processVwapUI(true),{once:true});else processVwapUI(true);
  observer.observe(document.body||document.documentElement,{childList:true,subtree:true});
  window.addEventListener('scroll',reposition,{passive:true,capture:true});
  window.addEventListener('resize',reposition,{passive:true});
  document.addEventListener('pointerdown',e=>{
    const open=document.querySelector('.scx-vwap-host[data-open="1"]');
    if(!open)return;
    if(open.contains(e.target)||open.__scmPopover?.contains?.(e.target))return;
    open.dataset.open='0';if(open.__scmPopover)open.__scmPopover.style.display='none';
  },{capture:true,passive:true});
  let last=location.href;
  const route=()=>{if(location.href===last)return;last=location.href;dataCache=null;cacheAt=0;cacheRealm=null;cacheResourceId=null;cleanup();if(isExchange())setTimeout(()=>processVwapUI(true),180);};
  const push=history.pushState,replace=history.replaceState;
  history.pushState=function(){const r=push.apply(this,arguments);setTimeout(route,0);return r;};
  history.replaceState=function(){const r=replace.apply(this,arguments);setTimeout(route,0);return r;};
  window.addEventListener('popstate',route);window.addEventListener('hashchange',route);window.addEventListener('pageshow',()=>setTimeout(()=>processVwapUI(true),180));window.addEventListener('beforeunload',cleanup);document.addEventListener('visibilitychange',()=>{if(!document.hidden)setTimeout(()=>processVwapUI(true),180);});
})();


// Incoming Contracts inline market-price comparison: decorates the game's own incoming-contract rows only.
(() => {
  if (window.__SCM_INCOMING_CONTRACT_OVERLAY__) return; // one instance per tab (see the Exchange VWAP overlay)
  window.__SCM_INCOMING_CONTRACT_OVERLAY__ = true;
  const money=v=>Number.isFinite(Number(v))?'$'+Number(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
  const norm=v=>String(v??'').toLowerCase().replace(/[’']/g,'').replace(/[^a-z0-9]+/g,'').replace(/s$/,'');
  const visible=el=>{if(!el)return false;const cs=getComputedStyle(el),r=el.getBoundingClientRect?.();return cs.display!=='none'&&cs.visibility!=='hidden'&&(!r||r.width>0&&r.height>0);};
  const text=el=>String(el?.innerText||el?.textContent||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
  const parsePrice=t=>{const m=String(t||'').match(/\$\s*([0-9][0-9,]*(?:\.\d+)?)/);return m?Number(m[1].replace(/,/g,'')):null;};
  // Performance: the visible page text is read at most once per 1.5 s per URL.
  let incomingCheck={at:0,path:'',value:false};
  const isIncomingPage=()=>{
    const path=String(location.pathname||''),now=Date.now();
    // A positive answer is kept 5 s; a negative one 1.5 s so a freshly rendered page is picked up quickly.
    if(incomingCheck.path===path&&now-incomingCheck.at<(incomingCheck.value?5000:1500))return incomingCheck.value;
    incomingCheck={at:now,path,value:isIncomingPageNow()};
    return incomingCheck.value;
  };
  const isIncomingPageNow=()=>{
    const body=scmPageTextNoLayout(); // no innerText (forced layout) from mutation observers
    // No trailing word boundary: our own badge text can sit right after the Accept label
    // ("Accept25.00% above market"), and the check must not then fail and wipe the badges.
    return /incoming contracts/i.test(body)&&/accept/i.test(body)&&/\$\s*[0-9]/.test(body);
  };
  // This tab's realm only; unknown realm → no badges.
  const getDataOnce=()=>new Promise(resolve=>{try{const tabRealm=Number(window.__SCM_GAME_REALM__);if(tabRealm!==0&&tabRealm!==1){resolve(null);return;}chrome.runtime.sendMessage({type:'GET_INCOMING_CONTRACT_VWAP_DATA',realm:tabRealm},r=>resolve(chrome.runtime.lastError?null:r||null));}catch{resolve(null);}});
  // A sleeping/restarting service worker can drop the first message; retry once before giving up.
  const getData=async()=>{const first=await getDataOnce();if(first?.ok)return first;await new Promise(r=>setTimeout(r,400));return (await getDataOnce())||first;};
  const priceText=v=>`$${Number(v).toLocaleString(undefined,{minimumFractionDigits:3,maximumFractionDigits:3})}`;
  // Resolve the displayed card from its unit-price node, then walk upward until
  // that card contains the seller and quantity (searching subtrees for seller + any
  // matching price can pick a wrapper with the total price and no unit-price anchor).
  // The DOM is scanned once per pass (cheap textContent pre-filter, layout only for
  // price-like nodes), not once per contract record.
  const collectPriceNodes=()=>{
    const out=[];
    for(const el of document.querySelectorAll('body *')){
      const raw=el.textContent;
      if(!raw||raw.length>60||raw.indexOf('$')<0)continue;
      const t=text(el);if(t.length>40)continue;
      const p=parsePrice(t);if(!Number.isFinite(p))continue;
      if(!visible(el))continue;
      out.push({el,p,len:t.length});
    }
    return out.sort((a,b)=>a.len-b.len);
  };
  const findContractTarget=(record,allPriceNodes)=>{
    const company=norm(record?.company), price=Number(record?.price), qty=Number(record?.quantity);
    if(!company||!Number.isFinite(price)||price<=0||!Number.isFinite(qty)||qty<=0)return null;
    const priceNodes=(allPriceNodes||collectPriceNodes()).filter(x=>Math.abs(x.p-price)<0.000001).map(x=>x.el);
    const qtyText=qty.toLocaleString('en-US');
    const hasQuantity=t=>{
      const normalized=String(t||'').replace(/,/g,'');
      return new RegExp(`(^|\\D)${Math.trunc(qty)}(?!\\d)`).test(normalized)||String(t||'').includes(qtyText);
    };
    const candidates=[];
    for(const anchor of priceNodes){
      let p=anchor;
      for(let depth=0;depth<12&&p&&p!==document.body;depth++,p=p.parentElement){
        const t=text(p),nt=norm(t);
        if(t.length>1400)break;
        if(!nt.includes(company)||!hasQuantity(t))continue;
        // Prefer the smallest ancestor containing seller, quantity and the exact
        // unit price. A parent with the contract's total/other prices is avoided.
        candidates.push({row:p,anchor,score:t.length+depth*0.01});
        break;
      }
    }
    candidates.sort((a,b)=>a.score-b.score);
    return candidates[0]||null;
  };
  // Compact badge: only the % vs market price (VWAP when no market price is captured); tap it for the details popup.
  const marketLabel=record=>(record?.marketPriceSource==='realm-vwap'||record?.marketPriceSource==='vwap')?'VWAP':'market price';
  const oldTag=record=>record?.marketPriceStale?' (old)':'';
  // Origin label for a price that is not a real exchange order-book price; absent fields or 'exchange' => no label.
  const priceSrcLabel=(src,stale)=>src==='vwap'||src==='realm-vwap'?'VWAP fallback':src==='simcotools'?(stale?'SimcoTools · stale':'SimcoTools'):'';
  const priceSrcSuffix=(src,stale)=>{const l=priceSrcLabel(src,stale);return l?` · ${l}`:'';};
  const detailLines=record=>{
    const marketPrice=Number(record?.marketPrice),p=Number(record?.price),qty=Number(record?.quantity),rk=record?._scmRank;
    if(!Number.isFinite(p)||p<=0)return [];
    const hasMarket=Number.isFinite(marketPrice)&&marketPrice>0;
    const pct=hasMarket?(p-marketPrice)/marketPrice*100:0,label=marketLabel(record);
    const v=record?.verdict||null,ex=v&&Number(v.exchangePrice)>0?v:null;
    const lines=[];
    lines.push({k:'Contract',v:`${qty>0?qty.toLocaleString('en-US')+' @ ':''}${priceText(p)}${qty>0?` (${money(p*qty)})`:''}`});
    if(rk&&rk.of>1)lines.push({k:'Price rank',v:`#${rk.rank} of ${rk.of} incoming Q${Number(record?.quality)||0} (1 = cheapest)`,cls:rk.rank===1?'cheap':'flat'});
    if(!hasMarket){lines.push({k:'Market price',v:'not captured yet (no VWAP either)'});return lines;}
    lines.push({k:label==='VWAP'?'VWAP (no market price)':'Market price',v:priceText(marketPrice)+(record?.marketPriceSource==='simcotools'?'':oldTag(record))+priceSrcSuffix(record?.marketPriceSource,record?.marketPriceStale)});
    lines.push({k:'Vs '+label,v:Math.abs(pct)<0.05?`At ${label}`:`${Math.abs(pct).toFixed(2)}% ${pct<0?'cheaper than':'above'} ${label}`,cls:pct< -0.0001?'cheap':pct>0.0001?'expensive':'flat'});
    const refName=record?.marketPriceSource==='realm-vwap'?'VWAP':record?.marketPriceSource==='simcotools'?'SimcoTools':'exchange';
    if(ex)lines.push({k:refName==='VWAP'?`VWAP Q${Number(record?.quality)||0}`:`${refName==='exchange'?'Exchange':refName} Q${Number(record?.quality)||0}+`,v:ex.savesPerUnit>=0?`saves ${priceText(ex.savesPerUnit)}/u vs ${refName} ${priceText(ex.exchangePrice)} (${money(ex.savesTotal)})`:`${refName} ${priceText(ex.exchangePrice)} is ${priceText(-ex.savesPerUnit)}/u cheaper (${money(-ex.savesTotal)})`,cls:ex.savesPerUnit>0.0000001?'cheap':ex.savesPerUnit< -0.0000001?'expensive':'flat'});
    else lines.push({k:'Exchange',v:'order book not captured yet'});
    if(v&&Number(v.stockCost)>0)lines.push({k:'Your stock',v:`${priceText(v.stockCost)}/u`});
    return lines;
  };
  // Rank among the visible incoming contracts of the same product + quality by unit price:
  // cheapest = 1, equal prices share a rank (1, 1, 3). One entry per displayed contract key.
  const contractPriceRanks=records=>{
    const groups=new Map();
    for(const r of Array.isArray(records)?records:[]){
      const p=Number(r?.price);if(!Number.isFinite(p)||p<=0||!r?.key)continue;
      const g=`${Number(r.kind)}:${Number(r.quality)}`;if(!groups.has(g))groups.set(g,new Map());
      groups.get(g).set(r.key,p);
    }
    const out=new Map();
    for(const m of groups.values()){
      const prices=[...m.values()];
      for(const [key,p] of m)out.set(key,{rank:1+prices.filter(x=>x<p-1e-9).length,of:prices.length});
    }
    return out;
  };
  const rankText=record=>record?._scmRank&&record._scmRank.of>1?`#${record._scmRank.rank} of ${record._scmRank.of}`:'';
  const badgeFor=record=>{
    const marketPrice=Number(record?.marketPrice),p=Number(record?.price),rt=rankText(record);
    const hasMarket=Number.isFinite(marketPrice)&&marketPrice>0&&Number.isFinite(p)&&p>0;
    if(!hasMarket&&!rt)return null;
    const pct=hasMarket?(p-marketPrice)/marketPrice*100:0,label=marketLabel(record);
    const badge=document.createElement('span');
    const cls=!hasMarket?'flat':pct< -0.0001?'cheap':pct>0.0001?'expensive':'flat';
    badge.className='scm-contract-vwap-badge '+cls;
    const vs=!hasMarket?'':Math.abs(pct)<0.05?`= ${label}${oldTag(record)}`:`${pct<0?'▼':'▲'} ${Math.abs(pct).toFixed(2)}% ${pct<0?'below':'above'} ${label}${oldTag(record)}`;
    badge.textContent=`${[rt,vs].filter(Boolean).join(' · ')} ⓘ`;
    badge.title='Tap for details';
    badge.setAttribute('role','button');
    badge.dataset.scmOwned='1';
    badge._scmRecord=record;
    return badge;
  };
  const closePopup=()=>document.getElementById('scm-contract-detail-pop')?.remove();
  const openPopup=record=>{
    closePopup();
    const lines=detailLines(record);if(!lines.length)return;
    const wrap=document.createElement('div');wrap.id='scm-contract-detail-pop';wrap.dataset.scmOwned='1';
    const card=document.createElement('div');card.className='scm-cdp-card';
    const head=document.createElement('div');head.className='scm-cdp-head';
    const title=document.createElement('div');title.className='scm-cdp-title';title.textContent=String(record?.company||'Contract');
    const x=document.createElement('button');x.type='button';x.className='scm-cdp-close';x.textContent='×';x.setAttribute('aria-label','Close');
    head.append(title,x);card.appendChild(head);
    for(const line of lines){
      const row=document.createElement('div');row.className='scm-cdp-row'+(line.cls?' '+line.cls:'');
      const k=document.createElement('span');k.className='scm-cdp-k';k.textContent=line.k;
      const val=document.createElement('span');val.className='scm-cdp-v';val.textContent=line.v;
      row.append(k,val);card.appendChild(row);
    }
    wrap.appendChild(card);(document.body||document.documentElement).appendChild(wrap);
  };
  // Capture phase on window: the game's own handlers on the contract card must not see the tap.
  const onBadgeTap=e=>{
    const pop=document.getElementById('scm-contract-detail-pop');
    if(pop&&pop.contains(e.target)){if(e.target===pop||e.target.closest?.('.scm-cdp-close')){e.preventDefault();e.stopPropagation();closePopup();}return;}
    const b=e.target?.closest?.('.scm-contract-vwap-badge');if(!b)return;
    e.preventDefault();e.stopPropagation();e.stopImmediatePropagation?.();
    openPopup(b._scmRecord);
  };
  window.addEventListener('click',onBadgeTap,true);
  const style=()=>{
    if(document.getElementById('scm-contract-vwap-inline-style'))return;
    const st=document.createElement('style');st.id='scm-contract-vwap-inline-style';
    st.textContent=`.scm-contract-vwap-badge{position:static!important;display:inline-flex!important;vertical-align:middle!important;align-items:center!important;justify-content:center!important;box-sizing:border-box!important;width:auto!important;min-width:0!important;max-width:100%!important;height:auto!important;min-height:0!important;max-height:none!important;flex:0 0 auto!important;grid-area:auto!important;justify-self:auto!important;align-self:auto!important;margin:3px 0 3px 6px!important;padding:3px 6px!important;border-radius:5px!important;font:700 9px/1.15 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;white-space:normal!important;overflow-wrap:normal!important;text-align:center!important;box-shadow:0 1px 2px rgba(0,0,0,.22)!important;pointer-events:auto!important;cursor:pointer!important}.scm-contract-vwap-badge.cheap{color:#d4eacd!important;background:rgba(48,84,36,.94)!important;border:1px solid rgba(134,194,114,.55)!important}.scm-contract-vwap-badge.expensive{color:#f9ddd8!important;background:rgba(120,33,20,.94)!important;border:1px solid rgba(232,129,113,.55)!important}.scm-contract-vwap-badge.flat{color:#eeeded!important;background:rgba(23,22,21,.94)!important;border:1px solid rgba(149,144,141,.55)!important}@media(max-width:600px){.scm-contract-vwap-badge{font-size:8px!important;padding:3px 5px!important;margin-left:4px!important}}.scm-contract-vwap-badge{text-align:left!important;line-height:1.25!important}#scm-contract-detail-pop{position:fixed;inset:0;z-index:2147483600;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box}#scm-contract-detail-pop .scm-cdp-card{width:min(360px,100%);max-height:80vh;overflow:auto;box-sizing:border-box;background:rgba(16,15,15,.98);color:#efeeed;border:1px solid #3d3a38;border-radius:8px;padding:8px 10px;font:12px/1.35 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}#scm-contract-detail-pop .scm-cdp-head{display:flex;align-items:center;gap:6px;margin-bottom:4px}#scm-contract-detail-pop .scm-cdp-title{flex:1;min-width:0;font-weight:700;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#scm-contract-detail-pop .scm-cdp-close{flex:0 0 auto;width:32px;height:32px;border:1px solid #3d3a38;border-radius:6px;background:#22201f;color:#efeeed;font-size:18px;line-height:1;padding:0;cursor:pointer}#scm-contract-detail-pop .scm-cdp-row{display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-top:1px solid #2e2b2a}#scm-contract-detail-pop .scm-cdp-k{color:#b4b0ae;flex:0 0 auto}#scm-contract-detail-pop .scm-cdp-v{text-align:right;min-width:0;overflow-wrap:anywhere}#scm-contract-detail-pop .cheap .scm-cdp-v{color:#a0d090}#scm-contract-detail-pop .expensive .scm-cdp-v{color:#efa99f}`;
    (document.head||document.documentElement).appendChild(st);
  };
  let scheduled=0,inflight=null,again=false,retryTimer=0,retryAttempt=0,pageMiss=0;
  const clearStale=()=>{document.querySelectorAll('.scm-contract-vwap-badge').forEach(x=>x.remove());closePopup();};
  // A failed/empty data fetch or a not-yet-rendered row keeps the last good badges and retries with short backoff.
  const scheduleRetry=()=>{if(retryTimer)return;const d=[600,1500,3000,6000][Math.min(retryAttempt,3)];retryAttempt++;retryTimer=setTimeout(()=>{retryTimer=0;schedule();},d);};
  const process=async()=>{
    if(!isIncomingPage()){
      // Only remove badges after two consecutive misses so one mid-render snapshot cannot wipe them.
      if(!document.querySelector('.scm-contract-vwap-badge')){pageMiss=0;return;}
      if(++pageMiss>=2){clearStale();pageMiss=0;}else scheduleRetry();
      return;
    }
    pageMiss=0;
    style();
    const data=await getData();
    if(!data?.ok||!Array.isArray(data.contracts)){scheduleRetry();return;}
    const records=data.contracts.filter(c=>Number.isFinite(Number(c?.price))&&Number.isFinite(Number(c?.quantity)));
    if(!records.length){scheduleRetry();return;}
    const wanted=new Set();let missing=0;const priceNodes=collectPriceNodes();
    const processedKeys=new Set();
    const ranks=contractPriceRanks(records.map(r=>({key:`${Number(r.kind)}:${Number(r.quality)}:${Number(r.price)}:${norm(r.company)}`,kind:r.kind,quality:r.quality,price:r.price})));
    for(const record of records){
      const key=`${Number(record.kind)}:${Number(record.quality)}:${Number(record.price)}:${norm(record.company)}`;
      // Identical API records commonly collapse into one visible row (e.g. 4x).
      // Process the displayed contract identity once per pass.
      if(processedKeys.has(key)){wanted.add(key);continue;}
      processedKeys.add(key);
      wanted.add(key);
      record._scmRank=ranks.get(key)||null;
      const target=findContractTarget(record,priceNodes);if(!target){missing++;continue;}
      const {row,anchor}=target;
      // A single displayed game row can represent multiple identical API contracts.
      // Search globally, not only inside the inferred row: the game DOM can place
      // the price anchor and the seller/quantity wrapper in different subtrees, so
      // row.querySelectorAll() is not a reliable idempotency boundary.
      const allBadges=[...document.querySelectorAll('.scm-contract-vwap-badge')];
      let badge=allBadges.find(b=>b.dataset.contractKey===key&&b.isConnected);
      // Remove duplicates left by previous passes/builds, including badges attached
      // to a different wrapper for the same contract key.
      for(const extra of allBadges.filter(b=>b!==badge&&b.dataset.contractKey===key))extra.remove();
      if(!badge){badge=badgeFor(record);if(!badge)continue;}
      // Place the badge in normal document flow immediately beside the exact
      // unit-price element. Never absolutely position it over the contract card: on
      // mobile the inferred row can be a narrow seller/price column, so an overlay
      // covers the seller and price.
      const placement=anchor?.parentElement&&row.contains(anchor.parentElement)?anchor.parentElement:row;
      const fresh=badgeFor(record);
      if(fresh){badge.className=fresh.className;badge.textContent=fresh.textContent;badge.title=fresh.title;badge._scmRecord=record;}
      if(badge.parentElement!==placement)placement.appendChild(badge);
      badge.dataset.contractKey=key;
    }
    for(const badge of [...document.querySelectorAll('.scm-contract-vwap-badge')]){
      if(!badge.isConnected||!badge.closest('body')||!wanted.has(String(badge.dataset.contractKey||'')))badge.remove();
    }
    if(missing>0)scheduleRetry();else retryAttempt=0;
  };
  const schedule=()=>{if(scheduled)return;scheduled=setTimeout(()=>{scheduled=0;if(inflight){again=true;return;}inflight=process().catch(()=>{scheduleRetry();}).finally(()=>{inflight=null;if(again){again=false;schedule();}});},300);};
  const observer=new MutationObserver(muts=>{if(muts.some(m=>[...m.addedNodes||[]].some(n=>n.nodeType===1&&!n.closest?.('[data-scm-owned],.scm-contract-vwap-badge'))))schedule();});
  const start=()=>{style();schedule();observer.observe(document.body||document.documentElement,{childList:true,subtree:true});};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
  window.addEventListener('pageshow',schedule);window.addEventListener('popstate',schedule);window.addEventListener('hashchange',schedule);document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule();});
  setInterval(()=>{if(!document.hidden&&isIncomingPage())schedule();},5000);
})();

// Game-page cards: Stock After Demand & Contracts, Copy Left, saved-contract and sell helpers,
// My listings, Outgoing contracts.
(() => {
  if (window.__SCM_GAME_CARDS__) return; // one instance per tab (see the Exchange VWAP overlay)
  window.__SCM_GAME_CARDS__ = true;
  const OVERLAY_COLLAPSED_KEY='scm-stock-demand-contracts-collapsed-v1';
  const readCollapsedPreference=()=>{try{const value=localStorage.getItem(OVERLAY_COLLAPSED_KEY);return value===null?true:value!=='0';}catch{return true;}};
  const writeCollapsedPreference=collapsed=>{try{localStorage.setItem(OVERLAY_COLLAPSED_KEY,collapsed?'1':'0');}catch{}};
  const S={data:null,realm:null,styled:false,collapsed:readCollapsedPreference(),signature:'',contractSignature:'',contractCardSignature:'',contractDismissedKey:'',contractQtyMode:'saved',contractCustomQty:'',refreshTimer:null,recoveryTimer:null,lastUrl:location.href,observer:null,loadInFlight:false,loadQueued:false,loadEpoch:0,helperTimer:null,positionRaf:0,contractFillTimer:0,leftCopyDiscount:3,leftCopySignature:'',leftCopyOpen:false};
  const esc=v=>String(v??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  // Origin suffix for a price that is not a real exchange order-book price; absent fields or 'exchange' => ''.
  const priceSrcSuffix=(src,stale)=>{const l=src==='vwap'||src==='realm-vwap'?'VWAP fallback':src==='simcotools'?(stale?'SimcoTools · stale':'SimcoTools'):'';return l?` · ${l}`:'';};
  const num=v=>Number.isFinite(Number(v))?Number(v).toLocaleString(undefined,{maximumFractionDigits:0}):'—';
  const money=v=>Number.isFinite(Number(v))?'$'+Number(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
  const norm=v=>String(v??'').toLowerCase().replace(/[’']/g,'').replace(/[^a-z0-9]+/g,'').replace(/s$/,'');
  const currentRealm=()=>{
    const known=Number(window.__SCM_GAME_REALM__);
    if(known===0||known===1)return known;
    const m=String(location.pathname||'').match(/(?:\/rc\/|\/realm\/)(\d+)/i);
    return m?Number(m[1]):null;
  };
  const isSimCompaniesPage=()=>/^(www\.)?simcompanies\.com$/i.test(location.hostname);
  const visible=el=>{if(!el)return false;const s=getComputedStyle(el);const r=el.getBoundingClientRect?.();return s.display!=='none'&&s.visibility!=='hidden'&&(!r||r.width>0&&r.height>0);};
  const headerBottom=()=>{
    const els=[...document.querySelectorAll('header,nav,[role="banner"],[class*="header"],[class*="navbar"],[class*="topbar"]')];
    let best=0;for(const el of els){const r=el.getBoundingClientRect();if(r.width<Math.min(280,window.innerWidth*.55)||r.height<38||r.height>150)continue;const cs=getComputedStyle(el);if(!['fixed','sticky'].includes(cs.position)&&r.top>10)continue;if(r.top<=20)best=Math.max(best,r.bottom);}return Math.max(54,Math.min(best||62,window.innerHeight*.45));
  };
  const style=()=>{
    if(S.styled)return;S.styled=true;
    const st=document.createElement('style');
    st.id='scm-game-overlay-style';
    st.textContent=`
.scm-go-head,.scm-left-copy-head,.scm-ch-head,.scm-go-collapsed .scm-go-toggle{touch-action:none;cursor:move;-webkit-user-select:none;user-select:none}
#scm-game-balance-card,#scm-contract-helper-card,#scm-left-copy-card{position:fixed;z-index:2147483000;box-sizing:border-box;left:5px;right:5px;width:auto;max-width:none;max-height:48vh;overflow-y:auto;overflow-x:hidden;background:rgba(16,15,15,.97);color:#efeeed;border:1px solid #3d3a38;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.30);font:12px/1.3 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:6px;pointer-events:auto}
#scm-game-balance-card *,#scm-contract-helper-card *,#scm-left-copy-card *{box-sizing:border-box}.scm-go-head,.scm-ch-head{display:flex;align-items:center;justify-content:space-between;gap:5px;min-height:28px}
#scm-game-balance-card .scm-go-eta{grid-column:1/-1;display:grid;gap:5px;border-top:1px solid #433f3d;padding-top:7px;font-size:13px}#scm-game-balance-card .scm-go-eta-top{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 8px}#scm-game-balance-card .scm-go-eta-main{font-weight:500}#scm-game-balance-card .scm-go-eta-sub{font-size:12px;color:#b9b6b4}#scm-game-balance-card .scm-go-eta-bar{display:block;height:5px;background:#383534;border-radius:3px;overflow:hidden}#scm-game-balance-card .scm-go-eta-bar i{display:block;height:100%;background:#f5a37a}#scm-game-balance-card .scm-go-eta-running .scm-go-eta-main{color:#f5a37a}#scm-game-balance-card .scm-go-eta-covered .scm-go-eta-main{color:#7ebf68}#scm-game-balance-card .scm-go-eta-late .scm-go-eta-main{color:#ed9a8d}#scm-game-balance-card .scm-go-eta-none .scm-go-eta-main{color:#b9b6b4}#scm-game-balance-card .scm-go-split{display:block;font-size:12px;color:#9b9693}#scm-game-balance-card .scm-go-sub{border:2px solid #7ebf68}#scm-game-balance-card .scm-go-sub-neg{border-color:#ed9a8d}#scm-game-balance-card .scm-go-head{position:sticky;top:-6px;z-index:5;margin:-6px -6px 0;padding:6px;background:rgba(16,15,15,.98);border-bottom:1px solid #3a3736;isolation:isolate}.scm-go-title,.scm-ch-title{font-size:13px;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}.scm-go-head-actions{display:flex;align-items:center;gap:4px;flex:0 0 auto} .scm-go-copy{width:auto;min-width:72px;padding:0 8px;font-size:11px;flex:0 0 auto}.scm-left-copy-card{padding:8px}.scm-left-copy-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.scm-left-copy-title{font-size:11px;font-weight:800}.scm-left-copy-meta{color:#afaaa8;font-size:8px;margin-top:2px}.scm-left-copy-controls{display:flex;align-items:center;gap:6px;margin-top:7px}.scm-left-copy-controls label{color:#afaaa8;font-size:8px;white-space:nowrap}.scm-left-copy-controls select{height:28px;border:1px solid #514d4b;background:#1d1c1b;color:#efeeed;border-radius:5px;padding:0 7px;font:700 9px system-ui;min-width:76px}.scm-left-copy-text{display:block;width:100%;min-height:150px;margin-top:7px;border:1px solid #514d4b;background:#191817;color:#efeeed;border-radius:6px;padding:8px;font:10px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;resize:vertical}.scm-left-copy-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:7px}.scm-left-copy-btn,.scm-left-copy-close{height:28px;border:1px solid #514d4b;background:#242221;color:#efeeed;border-radius:5px;padding:0 10px;font:700 9px system-ui;cursor:pointer}.scm-left-copy-btn{font-weight:800}.scm-left-copy-none{color:#afaaa8;font-size:9px;padding:12px 4px;text-align:center}.scm-go-toggle,.scm-ch-fill{border:1px solid #514d4b;background:#242221;color:#e9e8e8;border-radius:5px;padding:0;font:700 9px/1 system-ui;cursor:pointer;white-space:nowrap;width:26px;height:26px;min-width:26px;min-height:26px;display:inline-flex;align-items:center;justify-content:center}.scm-go-grid{display:flex;flex-direction:column;gap:4px;margin-top:4px;max-height:none;overflow:visible;padding-bottom:4px;align-items:stretch}.scm-go-row{display:grid;grid-template-columns:18px minmax(120px,1.4fr) repeat(4,minmax(90px,1fr));align-items:center;gap:5px;width:100%;min-width:0;min-height:36px;height:auto;padding:5px 7px;border:1px solid #3a3736;border-radius:4px;background:#191817}.scm-go-row img{width:20px;height:20px;object-fit:contain}.scm-go-name{font-size:13px;font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.scm-go-stock,.scm-go-contract,.scm-go-remaining{color:#e7e5e4;white-space:nowrap;font-size:11px;min-width:0;overflow:hidden;text-overflow:ellipsis}.scm-go-contract{color:#f0c674}.scm-go-remaining{font-weight:500}.scm-go-remaining.negative{color:#e98575}.scm-go-remaining.positive{color:#6ab451}.scm-go-status{font-weight:800;white-space:nowrap}.scm-go-status.surplus{color:#6ab451}.scm-go-status.deficit{color:#e98575}.scm-go-status.balanced{color:#c9c6c4}.scm-go-collapsed{width:28px!important;min-width:28px!important;min-height:28px!important;height:28px!important;padding:0!important;display:flex;align-items:center;justify-content:center}#scm-game-balance-card.scm-go-collapsed{left:8px}.scm-go-collapsed .scm-go-toggle{width:26px;height:26px;min-width:26px;min-height:26px;font-size:16px!important}.scm-ch-card{padding:5px}.scm-ch-close{width:26px;height:26px;min-width:26px;border:1px solid #514d4b;border-radius:5px;background:#242221;color:#efeeed;font:700 14px/1 system-ui;cursor:pointer;padding:0;display:inline-flex;align-items:center;justify-content:center}.scm-ch-meta{color:#afaaa8;font-size:8px;margin-top:2px}.scm-ch-row{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:4px;padding:5px;border:1px solid #3a3736;border-radius:5px;background:#191817}.scm-ch-info{min-width:0}.scm-ch-info strong{display:block;font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.scm-ch-info span{display:block;color:#afaaa8;font-size:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.scm-ch-actions{display:flex;align-items:center;gap:4px}.scm-ch-price{font-size:8px;color:#e7e6e5;white-space:nowrap}.scm-ch-fill{padding:0;width:26px;height:26px;min-width:26px}.scm-ch-none{color:#afaaa8;font-size:8px;padding:5px}.scm-ch-qty{display:flex;align-items:center;gap:5px;margin-top:5px}.scm-ch-qty label{color:#afaaa8;font-size:8px;white-space:nowrap}.scm-ch-qty select,.scm-ch-qty input{height:26px;border:1px solid #514d4b;background:#1d1c1b;color:#efeeed;border-radius:5px;padding:0 6px;font:700 9px system-ui;min-width:120px;max-width:180px}.scm-ch-qty input{min-width:90px;width:90px}.scm-ch-cap{color:#95908d;font-size:8px;margin-top:3px}
#scm-sell-qty-card{position:fixed;z-index:2147483001;box-sizing:border-box;width:min(230px,calc(100vw - 8px));background:rgba(16,15,15,.97);color:#efeeed;border:1px solid #3d3a38;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.35);font:12px/1.3 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:5px;pointer-events:auto}#scm-sell-qty-card *{box-sizing:border-box}.scm-sq-head{display:flex;align-items:center;gap:5px;min-height:28px;cursor:move;touch-action:none;user-select:none;-webkit-user-select:none}.scm-sq-grip{color:#98928f;font-size:14px;line-height:1}.scm-sq-title{flex:1;min-width:0;font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.scm-sq-close{width:28px;height:28px;min-width:28px;border:1px solid #514d4b;border-radius:5px;background:#242221;color:#efeeed;font:700 15px/1 system-ui;cursor:pointer;padding:0}.scm-sq-btns{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:5px}.scm-sq-fill{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:40px;border:1px solid #514d4b;border-radius:6px;background:#242221;color:#efeeed;font:600 10px/1.2 system-ui;cursor:pointer;padding:3px}.scm-sq-fill b{font-size:14px;font-weight:800;color:#6ab451}.scm-sq-fill:disabled{opacity:.5;cursor:default}.scm-sq-fill:disabled b{color:#afaaa8}.scm-sq-fill.scm-sq-done{border-color:#6ab451;background:#1e3317}.scm-sq-note{color:#afaaa8;font-size:9px;margin-top:4px}.scm-sq-price{margin-top:5px;border-top:1px solid #3a3736;padding-top:5px}.scm-sq-pbtn{width:100%;min-height:34px}.scm-sq-warn{color:#efa69a;font-size:10px;font-weight:700;margin-top:3px}
@media(max-width:700px){
#scm-game-balance-card,#scm-contract-helper-card,#scm-left-copy-card{left:5px;right:5px;width:auto;max-width:none;max-height:48vh;overflow-x:hidden;overscroll-behavior-x:none;touch-action:pan-y}
#scm-game-balance-card{max-width:calc(100vw - 10px);min-width:0}
.scm-go-head{min-width:0;flex-wrap:nowrap}.scm-go-title{font-size:15px;line-height:1.25}.scm-go-copy{min-width:76px;padding:0 7px;font-size:11px}
.scm-go-grid{width:100%;min-width:0;overflow:visible}
.scm-go-row{grid-template-columns:22px minmax(0,1fr) minmax(0,1fr);grid-auto-rows:minmax(20px,auto);min-width:0;width:100%;max-width:100%;min-height:0;height:auto;padding:7px 6px;gap:5px;overflow:hidden}
.scm-go-row>span{min-width:0;max-width:100%}
.scm-go-row>span:nth-child(1){grid-column:1;grid-row:1;align-self:center}
.scm-go-row>span:nth-child(2){grid-column:2/4;grid-row:1;font-size:14px;line-height:1.3;white-space:normal;overflow-wrap:anywhere}
.scm-go-row>span:nth-child(3){grid-column:2;grid-row:2}
.scm-go-row>span:nth-child(4){grid-column:3;grid-row:2}
.scm-go-row>span:nth-child(5){grid-column:2;grid-row:3}
.scm-go-row>span:nth-child(6){grid-column:3;grid-row:3}
.scm-go-row img{width:20px;height:20px}
.scm-go-name{font-size:14px;white-space:normal;overflow:visible;text-overflow:clip}
.scm-go-stock,.scm-go-contract,.scm-go-remaining{font-size:12px;line-height:1.3;white-space:normal;overflow-wrap:anywhere;overflow:visible;text-overflow:clip}
.scm-go-remaining{font-weight:400}
}
`;
    (document.head||document.documentElement).appendChild(st);
  };
  const ensureCard=(id,cls)=>{let el=document.getElementById(id);if(el&&document.documentElement.contains(el))return el;el=document.createElement('section');el.id=id;el.className=cls;document.documentElement.appendChild(el);return el;};
  // Every game-page card can be minimised to its header (− / +); remembered per card in page localStorage.
  // (Stock After Demand & Contracts already collapses to ›, the monitor to a dot, Network capture to its bar.)
  const MIN_KEY='scm-card-min-v1';
  const MIN_CARDS={'scm-left-copy-card':'.scm-left-copy-head','scm-contract-helper-card':'.scm-ch-head','scm-sell-qty-card':'.scm-sq-head','scm-listings-card':'.scm-ls-head'};
  const minRead=()=>{try{const v=JSON.parse(localStorage.getItem(MIN_KEY)||'{}');return v&&typeof v==='object'?v:{};}catch{return {};}};
  const applyMin=card=>{
    if(!card||!MIN_CARDS[card.id])return;
    if(!document.getElementById('scm-min-style')){const st=document.createElement('style');st.id='scm-min-style';st.textContent='#scm-left-copy-card.scm-card-min>:not(.scm-left-copy-head),#scm-contract-helper-card.scm-card-min>:not(.scm-ch-head),#scm-sell-qty-card.scm-card-min>:not(.scm-sq-head),#scm-listings-card.scm-card-min>:not(.scm-ls-head){display:none!important}.scm-min-btn{background:#292625;color:#efeeed;border:1px solid #44403e;border-radius:6px;min-width:26px;height:24px;padding:0 6px;font:14px/1 system-ui,sans-serif;cursor:pointer;flex:0 0 auto;margin-left:auto}.scm-min-btn+button{margin-left:4px}.scm-card-min{max-height:none!important}';(document.head||document.documentElement).appendChild(st);}
    const head=card.querySelector(':scope>'+MIN_CARDS[card.id]);if(!head)return;
    let b=head.querySelector(':scope>[data-scm-min]');
    if(!b){b=document.createElement('button');b.type='button';b.className='scm-min-btn';b.dataset.scmMin='1';const close=head.querySelector(':scope>button');if(close)head.insertBefore(b,close);else head.appendChild(b);}
    const min=!!minRead()[card.id];card.classList.toggle('scm-card-min',min);b.textContent=min?'+':'−';b.setAttribute('aria-label',min?'Expand card':'Minimise card');
  };
  document.addEventListener('click',e=>{
    const b=e.target.closest?.('[data-scm-min]');if(!b)return;const card=b.closest(Object.keys(MIN_CARDS).map(id=>'#'+id).join(','));if(!card)return;
    e.preventDefault();e.stopPropagation();const v=minRead();v[card.id]=!card.classList.contains('scm-card-min');try{localStorage.setItem(MIN_KEY,JSON.stringify(v));}catch{}applyMin(card);try{schedulePosition();}catch{}
  },true);
  // Every overlay card can be dragged by its header (or the collapsed › button); its position is kept
  // per card in page localStorage (scmCardPos:<id>). Double-tap the header to put it back in its default place.
  const DRAG_CARDS=['scm-game-balance-card','scm-left-copy-card','scm-contract-helper-card'];
  const DRAG_HANDLES='.scm-go-head,.scm-go-collapsed .scm-go-toggle,.scm-left-copy-head,.scm-ch-head';
  const cardPos=id=>{try{const v=JSON.parse(localStorage.getItem('scmCardPos:'+id)||'null');return v&&Number.isFinite(v.x)&&Number.isFinite(v.y)?v:null;}catch{return null;}};
  // The whole card stays on screen: an expanded card near the bottom opens upwards.
  const placeCard=(el,x,y)=>{const w=Math.min(el.offsetWidth||300,window.innerWidth),h=Math.min(el.offsetHeight||40,window.innerHeight);x=Math.max(0,Math.min(window.innerWidth-w,x));y=Math.max(0,Math.min(window.innerHeight-h,y));el.style.left=`${Math.round(x)}px`;el.style.top=`${Math.round(y)}px`;return {x,y};};
  // Width follows the card's state: the collapsed › keeps its own CSS size; an open card gets its normal
  // width (screen − 10 px, as when it is not moved), so a card dragged while collapsed does not open 28 px wide.
  const pinCard=(el,pos)=>{const collapsed=el.classList.contains('scm-go-collapsed');el.style.width=collapsed?'':`${Math.max(0,Math.round(window.innerWidth-10))}px`;el.style.right='auto';el.dataset.scmMoved='1';placeCard(el,pos.x,pos.y);};
  const unpinCard=el=>{delete el.dataset.scmMoved;el.style.width='';el.style.right='';el.style.left='';};
  (()=>{
    let d=null,lastTap={id:'',t:0};
    document.addEventListener('pointerdown',e=>{
      const h=e.target.closest?.(DRAG_HANDLES);if(!h)return;const card=DRAG_CARDS.map(id=>document.getElementById(id)).find(c=>c&&c.contains(h));if(!card)return;
      if(e.target.closest('input,select,textarea'))return;if(e.pointerType==='mouse'&&e.button!==0)return;
      const r=card.getBoundingClientRect();d={card,id:card.id,pid:e.pointerId,sx:e.clientX,sy:e.clientY,dx:e.clientX-r.left,dy:e.clientY-r.top,moved:false};
    },true);
    document.addEventListener('pointermove',e=>{if(!d||e.pointerId!==d.pid)return;if(!d.moved&&Math.hypot(e.clientX-d.sx,e.clientY-d.sy)<6)return;d.moved=true;e.preventDefault();pinCard(d.card,{x:e.clientX-d.dx,y:e.clientY-d.dy});},{capture:true,passive:false});
    const end=e=>{if(!d||(e&&e.pointerId!==d.pid))return;const x=d;d=null;
      if(x.moved){try{localStorage.setItem('scmCardPos:'+x.id,JSON.stringify({x:x.card.offsetLeft,y:x.card.offsetTop}));}catch{}const stop=ev=>{ev.stopPropagation();ev.preventDefault();};document.addEventListener('click',stop,{capture:true,once:true});setTimeout(()=>document.removeEventListener('click',stop,true),400);return;}
      if(e?.target?.closest?.('button'))return;const now=Date.now();if(lastTap.id===x.id&&now-lastTap.t<350){try{localStorage.removeItem('scmCardPos:'+x.id);}catch{}unpinCard(x.card);schedulePosition();lastTap={id:'',t:0};}else lastTap={id:x.id,t:now};};
    document.addEventListener('pointerup',end,true);document.addEventListener('pointercancel',end,true);
    window.addEventListener('resize',()=>{for(const id of DRAG_CARDS){const el=document.getElementById(id);if(el?.dataset.scmMoved)pinCard(el,{x:el.offsetLeft,y:el.offsetTop});}},{passive:true});
  })();
  const position=()=>{
    // cards you moved stay where you put them; the others stack under the game's header as before
    const placed=id=>{const el=document.getElementById(id);if(!el)return null;const p=cardPos(id);if(p){pinCard(el,p);return 'moved';}if(el.dataset.scmMoved)unpinCard(el);return el;};
    const main=placed('scm-game-balance-card');
    const top=Math.round(headerBottom()+4);
    if(main&&main!=='moved')main.style.top=`${top}px`;
    let a=main&&main!=='moved'&&main.offsetHeight?main.getBoundingClientRect().bottom:top;
    const left=placed('scm-left-copy-card'); if(left&&left!=='moved'){left.style.top=`${Math.round(a+5)}px`;a=left.getBoundingClientRect().bottom;}
    const ch=placed('scm-contract-helper-card'); if(ch&&ch!=='moved')ch.style.top=`${Math.round(a+5)}px`;
  };
  const schedulePosition=()=>{
    if(S.positionRaf)return;
    S.positionRaf=requestAnimationFrame(()=>{S.positionRaf=0;try{position();}catch{}});
  };
  // "Listings & contracts" card: ONE floating card with two separated sections, "My listings" on top and "Outgoing
  // contracts" below. Data: background GET_OWN_LISTINGS_DATA (scmMarketOrders:<realm>) and GET_OUTGOING_CONTRACTS_DATA
  // (game capture or the Manager's read, scmOutgoingContracts:<realm>); each section has its own seq guard and its own
  // "updated/captured X ago". Drag by the header (pointer events, touch too), - / + minimise (scm-card-min-v1), x closes
  // to one small pill on the right edge (draggable; tap reopens). Open state in page localStorage scm-lc-card-v1 (first
  // run: open if either old key scm-listings-card-v1 / scm-contracts-card-v1 was open), position in
  // scmCardPos:scm-listings-card / scmCardPos:scm-listings-pill (ids kept so saved positions carry over). No
  // MutationObserver: it lives on <html>, outside the game's React root; it re-renders only when a section's data
  // signature changes; the "ago" texts are updated in place every 30 s.
  const Listings=(()=>{
    const CARD='scm-listings-card',PILL='scm-listings-pill',OPEN_KEY='scm-lc-card-v1';
    const L={open:true,data:null,cdata:null,realm:null,sig:'',seq:0,cseq:0,changeTimer:0,cchangeTimer:0,agoTimer:0,refreshTimer:0,started:false,noClickUntil:0};
    try{
      const v=JSON.parse(localStorage.getItem(OPEN_KEY)||'null');
      if(v&&typeof v.open==='boolean')L.open=v.open;
      else{const old=k=>{try{const o=JSON.parse(localStorage.getItem(k)||'null');return o&&typeof o.open==='boolean'?o.open:null;}catch{return null;}};const a=old('scm-listings-card-v1'),b=old('scm-contracts-card-v1');if(a!=null||b!=null)L.open=!!(a||b);else if(Math.min(window.innerWidth,window.screen?.width||9999)<700)L.open=false;/* phone (content scripts can start before the page viewport is applied, so innerWidth alone may read 980): the card is nearly full width and would cover the game's content; start as the small pill until the player opens it */}
    }catch{}
    const saveOpen=()=>{try{localStorage.setItem(OPEN_KEY,JSON.stringify({open:L.open}));}catch{}};
    const readPos=id=>{try{const v=JSON.parse(localStorage.getItem('scmCardPos:'+id)||'null');return v&&Number.isFinite(v.x)&&Number.isFinite(v.y)?v:null;}catch{return null;}};
    const agoOf=(iso,none,word)=>{const t=Date.parse(String(iso||''));if(!Number.isFinite(t))return none;const s=Math.max(0,Math.round((Date.now()-t)/1000));return s<60?`${word} just now`:s<3600?`${word} ${Math.floor(s/60)} min ago`:s<86400?`${word} ${Math.floor(s/3600)} h ago`:`${word} ${Math.floor(s/86400)} d ago`;};
    const agoL=iso=>agoOf(iso,'not read yet','updated'),agoC=iso=>agoOf(iso,'not captured yet','captured');
    const lstyle=()=>{
      if(document.getElementById('scm-listings-style'))return;
      const st=document.createElement('style');st.id='scm-listings-style';
      st.textContent=`#scm-listings-card{position:fixed;z-index:2147483000;box-sizing:border-box;width:min(340px,calc(100vw - 10px));max-height:55vh;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;touch-action:pan-y;background:rgba(16,15,15,.97);color:#efeeed;border:1px solid #3d3a38;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.30);font:12px/1.3 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:6px;pointer-events:auto}
#scm-listings-card *{box-sizing:border-box}#scm-listings-card.scm-card-min{overflow:hidden}
.scm-ls-head{display:flex;align-items:center;gap:5px;min-height:28px;cursor:move;touch-action:none;-webkit-user-select:none;user-select:none;position:sticky;top:-6px;z-index:2;margin:-6px -6px 0;padding:6px;background:rgba(16,15,15,.98)}
#scm-listings-card:not(.scm-card-min) .scm-ls-head{border-bottom:1px solid #3a3736}
.scm-ls-grip{color:#98928f;font-size:14px;line-height:1}.scm-ls-title{flex:1;min-width:0;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.scm-ls-close{width:26px;height:26px;min-width:26px;border:1px solid #514d4b;border-radius:5px;background:#242221;color:#efeeed;font:700 14px/1 system-ui;cursor:pointer;padding:0;display:inline-flex;align-items:center;justify-content:center}
.scm-ls-sec+.scm-ls-sec{margin-top:10px;padding-top:8px;border-top:2px solid #4a4644}
.scm-ls-sech{margin:6px 1px 0;color:#efeeed;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}.scm-ls-sec+.scm-ls-sec .scm-ls-sech{margin-top:0}
.scm-ls-sum{display:flex;justify-content:space-between;gap:6px;color:#afaaa8;font-size:11px;margin:3px 1px 0}.scm-ls-sum b{color:#efeeed;font-weight:600}
.scm-ls-warn{color:#f0c674;font-size:11px;margin:4px 1px 0}
.scm-ls-row{display:grid;grid-template-columns:22px minmax(0,1fr) auto;gap:2px 6px;align-items:center;margin-top:4px;padding:5px 6px;border:1px solid #3a3736;border-radius:4px;background:#191817}
.scm-ls-row img,.scm-ls-noimg{width:20px;height:20px;object-fit:contain;grid-row:1/3}.scm-ls-name{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.scm-ls-total{text-align:right;white-space:nowrap;font-weight:600}.scm-ls-sub{color:#afaaa8;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.scm-ls-vs{text-align:right;white-space:nowrap;font-size:11px;color:#afaaa8}.scm-ls-vs.hi{color:#f0c674}.scm-ls-vs.lo{color:#f5a37a}
.scm-ls-none{color:#afaaa8;font-size:11px;padding:10px 4px;text-align:center}
#scm-listings-pill{white-space:nowrap;position:fixed;z-index:2147483000;box-sizing:border-box;border:1px solid #514d4b;border-radius:14px;background:rgba(36,34,33,.9);color:#e9e8e8;font:700 11px/1 system-ui,-apple-system,sans-serif;padding:6px 9px;min-height:26px;cursor:pointer;touch-action:none;-webkit-user-select:none;user-select:none;box-shadow:0 3px 10px rgba(0,0,0,.3);opacity:.85}`;
      (document.head||document.documentElement).appendChild(st);
    };
    // Card: default top-right under the game header; pill: right edge, a little below the middle (clear of the
    // game's top bar and bottom navigation). Both clamped to the viewport on every placement and on resize.
    const place=(el,pos)=>{if(!el)return;el.style.right='auto';el.style.bottom='auto';placeCard(el,pos.x,pos.y);};
    const defaultPos=el=>el.id===CARD?{x:window.innerWidth-(el.offsetWidth||340)-5,y:Math.round(headerBottom()+40)}:{x:window.innerWidth-(el.offsetWidth||80)-4,y:Math.round(window.innerHeight*.58)};
    const placeSaved=el=>{if(el)place(el,readPos(el.id)||defaultPos(el));};
    const ensure=(id,tag)=>{let el=document.getElementById(id);if(el&&document.documentElement.contains(el))return el;el=document.createElement(tag);el.id=id;el.dataset.scmOwned='1';document.documentElement.appendChild(el);return el;};
    const byTotal=d=>Array.isArray(d?.rows)?[...d.rows].sort((a,b)=>b.total-a.total||String(a.name).localeCompare(String(b.name))||a.quality-b.quality):[];
    const rowHtml=(r,withVs)=>{
      const vs=withVs&&Number.isFinite(r.vsVwapPct)?r.vsVwapPct:null;const cls=vs==null||Math.abs(vs)<1?'':vs>0?'hi':'lo';
      return `<div class="scm-ls-row">${r.image?`<img src="${esc(r.image)}" alt="" loading="lazy">`:'<span class="scm-ls-noimg"></span>'}<span class="scm-ls-name">${esc(r.name)} <span class="scm-ls-q">Q${esc(r.quality)}</span></span><span class="scm-ls-total">${money(r.total)}</span><span class="scm-ls-sub">${num(r.quantity)} × ${money(r.price)}</span><span class="scm-ls-vs ${cls}">${vs==null?'':`${vs>0?'+':''}${vs.toFixed(1)}% vs VWAP`}</span></div>`;
    };
    const section=(key,heading,noun,d,realm,agoFn,msgs,withVs,warn)=>{
      const rows=byTotal(d),total=rows.reduce((a,r)=>a+(Number(r.total)||0),0);
      const body=realm==null?`<div class="scm-ls-none">${msgs.realm}</div>`
        :!d?`<div class="scm-ls-none">${msgs.loading}</div>`
        :d.missing?`<div class="scm-ls-none">${msgs.missing}</div>`
        :`<div class="scm-ls-sum"><span><b>${rows.length}</b> ${noun}${rows.length===1?'':'s'} · <b>${money(total)}</b></span><span class="scm-ls-ago" data-ago="${key}">${esc(agoFn(d.at))}</span></div>${rows.length?rows.map(r=>rowHtml(r,withVs)).join(''):`<div class="scm-ls-none">${msgs.empty}</div>`}`;
      return `<div class="scm-ls-sec" data-sec="${key}"><div class="scm-ls-sech">${heading}</div>${warn?`<div class="scm-ls-warn">${esc(warn)}</div>`:''}${body}</div>`;
    };
    const render=()=>{
      lstyle();
      const pill=document.getElementById(PILL);
      if(!L.open){document.getElementById(CARD)?.remove();const p=ensure(PILL,'button');p.type='button';p.setAttribute('aria-label','Show my listings and outgoing contracts');const n=L.data?.rows?.length,c=L.cdata?.rows?.length;p.textContent=`Listings${Number.isFinite(n)?' '+n:''} · Contracts${Number.isFinite(c)?' '+c:''}`;if(drag?.el!==p)placeSaved(p);return;}
      pill?.remove();
      const card=ensure(CARD,'section');const realm=currentRealm();
      const title=`${realm!=null?`R${realm+1}`:'Game'} · Listings & contracts`;
      const re=L.data?.refreshError;const warn=re&&re.error?`Couldn't update: ${re.error}`:'';
      const sec1=section('listings','My listings','listing',L.data,realm,agoL,{realm:'Checking which realm this game tab is in…',loading:'Loading your listings…',missing:'Your listings have not been read yet. They load once the game has told the Manager your company.',empty:'Nothing listed on the exchange.'},true,warn);
      const sec2=section('contracts','Outgoing contracts','contract',L.cdata,realm,agoC,{realm:'Checking which realm this game tab is in…',loading:'Loading your contracts…',missing:'Outgoing contracts have not been captured yet. Open your contracts in the game (or run Sync) and they appear here.',empty:'No outgoing contracts.'},false,'');
      card.innerHTML=`<div class="scm-ls-head"><span class="scm-ls-grip" aria-hidden="true">⠿</span><span class="scm-ls-title">${esc(title)}</span><button type="button" class="scm-ls-close" aria-label="Close my listings and outgoing contracts">×</button></div>${sec1}${sec2}`;
      applyMin(card);if(drag?.el!==card)placeSaved(card);
    };
    // `at` of the contracts is left out of the signature: a read with the same contracts only updates the "captured X ago" text
    const signature=()=>{const d=L.data,c=L.cdata;return JSON.stringify([currentRealm(),L.open,d?.realm,d?.at,d?.missing,d?.refreshError?.error||null,(d?.rows||[]).map(r=>[r.id,r.kind,r.quality,r.quantity,r.price,r.vwap,r.image]),c?.realm,c?.missing,(c?.rows||[]).map(r=>[r.id,r.kind,r.quality,r.quantity,r.price])]);};
    const updateAgo=()=>{const root=document.getElementById(CARD);if(!root)return;const a=root.querySelector('[data-ago="listings"]'),b=root.querySelector('[data-ago="contracts"]');if(a&&L.data)a.textContent=agoL(L.data.at);if(b&&L.cdata)b.textContent=agoC(L.cdata.at);};
    const paint=()=>{const s=signature();const have=document.getElementById(L.open?CARD:PILL);
      if(s===L.sig&&have){if(L.open)updateAgo();return;}
      L.sig=s;render();};
    const requestL=(refresh=false)=>{
      if(!L.open&&!refresh&&L.data)return;
      const realm=currentRealm();if(realm==null){paint();return;}
      const seq=++L.seq;
      try{chrome.runtime.sendMessage({type:'GET_OWN_LISTINGS_DATA',realm,refresh},r=>{
        if(chrome.runtime.lastError||seq!==L.seq||currentRealm()!==realm||!r?.ok||Number(r.realm)!==realm)return;
        L.data=r;paint();
      });}catch{}
    };
    // contracts: a read through the game tab only while the card is open; closed, the pill count uses the stored data
    const requestC=(refresh=false)=>{
      const realm=currentRealm();if(realm==null){paint();return;}
      const seq=++L.cseq;
      try{chrome.runtime.sendMessage({type:'GET_OUTGOING_CONTRACTS_DATA',realm,refresh:!!(refresh&&L.open)},r=>{
        if(chrome.runtime.lastError||seq!==L.cseq||currentRealm()!==realm||!r?.ok||Number(r.realm)!==realm)return;
        L.cdata=r;paint();
      });}catch{}
    };
    const request=(refresh=false)=>{requestL(refresh);if(L.open||refresh)requestC(refresh);};
    const tickAgo=()=>{if(document.hidden||!L.open)return;updateAgo();if(!document.getElementById(CARD))paint();};
    const setOpen=open=>{L.open=open;saveOpen();L.sig='';paint();if(open)request(true);else{if(!L.data)requestL(true);if(!L.cdata)requestC(false);}};
    // drag (card header / pill), clamped; a tap on the pill reopens the card
    let drag=null;
    document.addEventListener('pointerdown',e=>{
      const t=e.target;const el=t?.closest?.('#scm-listings-pill')||(t?.closest?.('#scm-listings-card .scm-ls-head')&&!t.closest('button')?document.getElementById(CARD):null);if(!el)return;
      if(e.pointerType==='mouse'&&e.button!==0)return;
      const r=el.getBoundingClientRect();drag={el,pid:e.pointerId,sx:e.clientX,sy:e.clientY,dx:e.clientX-r.left,dy:e.clientY-r.top,moved:false};
      try{el.setPointerCapture(e.pointerId);}catch{}
    },true);
    document.addEventListener('pointermove',e=>{if(!drag||e.pointerId!==drag.pid)return;if(!drag.moved&&Math.hypot(e.clientX-drag.sx,e.clientY-drag.sy)<6)return;drag.moved=true;e.preventDefault();place(drag.el,{x:e.clientX-drag.dx,y:e.clientY-drag.dy});},{capture:true,passive:false});
    const end=e=>{if(!drag||e.pointerId!==drag.pid)return;const x=drag;drag=null;try{x.el.releasePointerCapture(e.pointerId);}catch{}
      if(x.moved){try{localStorage.setItem('scmCardPos:'+x.el.id,JSON.stringify({x:x.el.offsetLeft,y:x.el.offsetTop}));}catch{}L.noClickUntil=Date.now()+400;}};
    document.addEventListener('pointerup',end,true);document.addEventListener('pointercancel',end,true);
    document.addEventListener('click',e=>{
      if(Date.now()<(L.noClickUntil||0)&&e.target.closest?.('#scm-listings-pill,#scm-listings-card .scm-ls-head')){e.preventDefault();e.stopPropagation();return;}
      if(e.target.closest?.('#scm-listings-card .scm-ls-close')){e.preventDefault();e.stopPropagation();setOpen(false);return;}
      if(e.target.closest?.('#scm-listings-pill')){e.preventDefault();e.stopPropagation();setOpen(true);}
    },true);
    window.addEventListener('resize',()=>{placeSaved(document.getElementById(CARD));placeSaved(document.getElementById(PILL));},{passive:true});
    // Background tells us when a small key changes (no storage.onChanged: it would deliver every large realm-store write).
    chrome.runtime?.onMessage?.addListener((msg)=>{
      if(msg?.type!=='SCM_CARD_KEY_CHANGED')return false;
      const realm=currentRealm();if(realm==null||!L.open)return false;
      if(msg.key===`scmMarketOrders:${realm}`){clearTimeout(L.changeTimer);L.changeTimer=setTimeout(()=>requestL(false),300);}
      else if(msg.key===`scmOutgoingContracts:${realm}`){clearTimeout(L.cchangeTimer);L.cchangeTimer=setTimeout(()=>requestC(false),300);}
      return false;
    });
    document.addEventListener('visibilitychange',()=>{if(!document.hidden&&L.open){request(true);tickAgo();}});
    // the game re-announces its realm on every state update; act only on a real change
    window.addEventListener('scm-game-realm-change',()=>{const r=currentRealm();if(r===L.realm)return;L.realm=r;L.data=null;L.cdata=null;L.seq++;L.cseq++;paint();request(true);});
    const start=()=>{if(L.started||!isSimCompaniesPage())return;L.started=true;L.realm=currentRealm();paint();request(true);L.agoTimer=setInterval(tickAgo,30000);L.refreshTimer=globalThis.__scmTimers.loop('listingsRefresh',15000,()=>{if(!document.hidden&&L.open)request(true);});};
    return {start,style:lstyle};
  })();
  if(document.readyState!=='loading')Listings.start();else document.addEventListener('DOMContentLoaded',()=>Listings.start(),{once:true});
  // Performance: this runs on every DOM mutation batch. The URL decides at once; otherwise the visible page text
  // is read at most once per 1.5 s per URL.
  let contractTextCheck={at:0,path:'',value:false};
  const likelyContractPage=()=>{
    const path=String(location.pathname||'');
    if(/contract/i.test(path))return true;
    const now=Date.now();
    // No innerText (forced layout) here; positive answers kept 5 s, negative 1.5 s.
    if(contractTextCheck.path===path&&now-contractTextCheck.at<(contractTextCheck.value?5000:1500))return contractTextCheck.value;
    contractTextCheck={at:now,path,value:/(?:recipient|price\s+per\s+unit|please\s+enter\s+amount|select\s+company)/i.test(scmPageTextNoLayout())};
    return contractTextCheck.value;
  };
  const scheduleContractHelper=()=>{
    if(!likelyContractPage())return;
    if(S.helperTimer)clearTimeout(S.helperTimer);
    S.helperTimer=setTimeout(()=>{S.helperTimer=null;Promise.resolve(loadContractHelper()).finally(()=>schedulePosition());},450);
  };
  const leftRows=()=>{
    const rows=Array.isArray(S.data?.rows)?S.data.rows:[];
    return rows.filter(r=>{const remaining=Number(r.remaining??r.difference);return Number.isFinite(remaining)&&remaining>0;});
  };
  const buildLeftCopyText=()=>{
    const d=Math.max(0,Number(S.leftCopyDiscount)||0);
    const rows=leftRows();
    const lines=['==============================',`🔽🔽🔽 SELLING ${d?`-${d}%`:''} VWAP 🔽🔽🔽`,''];
    for(const r of rows){
      const id=Number(r.id);
      const name=String(r.name||`Resource #${id||0}`);
      const remaining=Number(r.remaining??r.difference);
      const rawVwap=r?.vwap;
      const vwap=Number(rawVwap);
      const hasVwap=rawVwap!==null&&rawVwap!==undefined&&String(rawVwap).trim()!==''&&Number.isFinite(vwap)&&vwap>0;
      // Copy Left is keyed to this row's exact realm/resource/quality VWAP. Never
      // substitute another quality or the current market price when VWAP is absent.
      const price=hasVwap?` - ${money(vwap*(1-d/100))}`:' - VWAP unavailable';
      lines.push(`➡️ ${num(remaining)} - ${name}${Number.isFinite(Number(r.quality))?` Q${Number(r.quality)}`:''}${Number.isFinite(id)&&id>0?` :re-${id}:`:''}${price}`);
    }
    lines.push('','==============================');
    return lines.join('\n');
  };
  const closeLeftCopy=()=>{
    S.leftCopyOpen=false;
    S.leftCopySignature='';
    document.getElementById('scm-left-copy-card')?.remove();
    schedulePosition();
  };
  const openLeftCopy=()=>{
    S.leftCopyOpen=true;
    const card=ensureCard('scm-left-copy-card','scm-left-copy-card');
    const rows=leftRows();
    const title=`${S.realm!=null?`R${S.realm+1}`:'Game'} · Copy Left Resources`;
    card.innerHTML=`<div class="scm-left-copy-head"><div><div class="scm-left-copy-title">${esc(title)}</div><div class="scm-left-copy-meta">${num(rows.length)} resources left after Demand & Contracts · VWAP prices</div></div><button type="button" class="scm-left-copy-close" data-left-copy-close aria-label="Close left resources card">×</button></div><div class="scm-left-copy-controls"><label for="scm-left-copy-discount">Market discount</label><select id="scm-left-copy-discount"><option value="0">0%</option><option value="3"${S.leftCopyDiscount===3?' selected':''}>3%</option><option value="5"${S.leftCopyDiscount===5?' selected':''}>5%</option><option value="10"${S.leftCopyDiscount===10?' selected':''}>10%</option></select></div><textarea class="scm-left-copy-text" id="scm-left-copy-text" readonly aria-label="Left resources copy text"></textarea><div class="scm-left-copy-actions"><button type="button" class="scm-left-copy-close" data-left-copy-close>Close</button><button type="button" class="scm-left-copy-btn" data-left-copy-copy>📋 Copy</button></div>`;
    const textEl=card.querySelector('#scm-left-copy-text');
    const discountEl=card.querySelector('#scm-left-copy-discount');
    const build=()=>{S.leftCopyDiscount=Number(discountEl?.value)||0;if(textEl)textEl.value=buildLeftCopyText();S.leftCopySignature=JSON.stringify({discount:S.leftCopyDiscount,rows:leftRows().map(r=>[r.id,r.remaining??r.difference,r.vwap,r.quality])});};
    discountEl?.addEventListener('change',build);
    card.querySelectorAll('[data-left-copy-close]').forEach(btn=>btn.addEventListener('click',closeLeftCopy));
    card.querySelector('[data-left-copy-copy]')?.addEventListener('click',async()=>{const value=String(textEl?.value||'');try{await navigator.clipboard.writeText(value);const b=card.querySelector('[data-left-copy-copy]');if(b){const old=b.textContent;b.textContent='✓ Copied';setTimeout(()=>{if(b.isConnected)b.textContent=old;},1100);}}catch{}});
    build();
    applyMin(card);
    schedulePosition();
  };
  // When stock covers Left (need = -Left). Output is collectable all through a run, so it reaches the warehouse at the
  // run rate. amount is all output outstanding since the last collect (already cut by a newer collect stamp), so the
  // part produced and not collected yet is amount minus what the rest of the run still makes (rate x time to finish):
  // engines amount 736, 14.81 h left at 48.67/hr => 720.8 to come, 15.2 ready now (the game's amountAvailableNow 15).
  // The whole amount is in the warehouse by the run end. A finished run not collected yet has all of it ready now.
  const demandEta=(left,runs,now)=>{
    const list=Array.isArray(runs)?runs:[],accrue=[];
    let ready=0,total=0,ratePerHour=0,lastFinish=0;
    for(const x of list){
      const amount=x?.amount==null?NaN:Number(x.amount),fin=Number(x?.finishMs),rate=Number(x?.ratePerHour);
      // A run without the game's amount or a rate (older snapshot, missing field): show no strip rather than a guess.
      if(!Number.isFinite(amount)||!Number.isFinite(fin))return {state:'nodata'};
      const a=Math.max(0,amount);total+=a;
      if(fin<=now){ready+=a;continue;}
      if(!(rate>0))return {state:'nodata'};
      const future=Math.min(a,rate*(fin-now)/3600000);
      ready+=a-future;ratePerHour+=rate;lastFinish=Math.max(lastFinish,fin);
      if(future>0)accrue.push({rate,endMs:now+future/rate*3600000});
    }
    const spare=left+total;
    if(left+ready>=0)return {state:'covered',ready,spare,active:ratePerHour>0};
    if(!(ratePerHour>0))return ready>0?{state:'late',missing:-(left+ready),runEndsMs:null,ratePerHour:0,ready}:{state:'none',ready};
    // Stock grows at the sum of the rates, each run stopping at its own end.
    accrue.sort((p,q)=>p.endMs-q.endMs);
    let short=-(left+ready),rate=accrue.reduce((s,x)=>s+x.rate,0),t=now;
    for(const run of accrue){
      const made=rate*(run.endMs-t)/3600000;
      if(made>=short)return {state:'running',metAtMs:t+short/rate*3600000,ratePerHour,ready,spare};
      short-=made;t=run.endMs;rate-=run.rate;
    }
    return {state:'late',missing:-spare,runEndsMs:lastFinish,ratePerHour,ready};
  };
  const etaDuration=ms=>{const s=Math.max(0,Math.floor(ms/1000)),h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return h?`${h}h ${String(m).padStart(2,'0')}m ${String(x).padStart(2,'0')}s`:`${m}m ${String(x).padStart(2,'0')}s`;};
  const etaText=(at,done)=>{const ms=at-Date.now();return ms>0?etaDuration(ms):done;};
  const etaStrip=(r,left)=>{
    // Older saved snapshots have no run data, so show no timer rather than a false "Not producing".
    if(!Array.isArray(r.etaRuns))return '';
    const now=Date.now(),e=demandEta(left,r.etaRuns,now),demand=Number(r.demand)||0;
    if(e.state==='nodata')return '';
    const need=demand+(Number(r.contracted)||0),held=(Number(r.warehouse)||0)+(Number(e.ready)||0);
    const pct=e.state==='covered'?100:e.state==='none'||!(need>0)?0:Math.max(0,Math.min(100,held/need*100));
    let main,sub;
    if(e.state==='covered'){
      main=left>=0?'✓ Covered':'✓ Ready to collect';
      sub=`${e.ready>0&&left<0?`${num(e.ready)} ready now · `:''}${num(e.spare)} spare${e.active?' at run end':''}`;
    }
    // An input nothing makes right now (producing:false); 'upgrading' = its only producer is being expanded.
    else if(e.state==='none'){main=r.producing===false&&r.reason==='upgrading'?'Upgrading':'Not producing';sub=r.producing===false&&r.reason==='upgrading'?'Its building is being expanded · buy it to cover the demand':'Buy it or start production';}
    else if(e.state==='late'){
      main=`Short ${num(e.missing)} after run`;
      sub=e.runEndsMs?`${num(e.ratePerHour)}/hr · run left: <span data-eta-at="${e.runEndsMs}" data-eta-done="none">${etaText(e.runEndsMs,'none')}</span>`:`${num(e.ready)} ready to collect · not producing`;
    }
    else{main=`⏱ <span data-eta-at="${e.metAtMs}" data-eta-done="met, collect to stock">${etaText(e.metAtMs,'met, collect to stock')}</span>`;sub=`${num(e.ratePerHour)}/hr · met ${esc(new Date(e.metAtMs).toLocaleString(undefined,{weekday:'short',hour:'numeric',minute:'2-digit'}))} · ${num(e.spare)} spare at run end`;}
    return `<span class="scm-go-eta scm-go-eta-${e.state}" data-eta-row="${esc(`${r.id}:${Number(r.quality)||0}`)}"><span class="scm-go-eta-top"><span class="scm-go-eta-main">${main}</span><span class="scm-go-eta-sub">${sub}</span></span><span class="scm-go-eta-bar"><i style="width:${pct.toFixed(1)}%"></i></span></span>`;
  };
  const tickEta=()=>{
    if(document.hidden)return;
    // About once a minute, swap only the timer strips in place (card, scroll and Copy Left stay untouched).
    if(Date.now()-(S.etaStripAt||0)>=60000){
      S.etaStripAt=Date.now();
      const rows=Array.isArray(S.data?.rows)?S.data.rows:[];
      document.querySelectorAll('#scm-game-balance-card [data-eta-row]').forEach(el=>{
        const r=rows.find(x=>`${x.id}:${Number(x.quality)||0}`===el.getAttribute('data-eta-row'));if(!r)return;
        const t=document.createElement('template');t.innerHTML=etaStrip(r,Number(r.remaining??r.difference)||0);
        if(t.content.firstElementChild)el.replaceWith(t.content.firstElementChild);
      });
    }
    document.querySelectorAll('#scm-game-balance-card [data-eta-at]').forEach(el=>{el.textContent=etaText(Number(el.getAttribute('data-eta-at')),el.getAttribute('data-eta-done'));});
  };
  const refreshGameOverlay=()=>{
    if(S.refreshBusy||(S.realm!==0&&S.realm!==1))return;
    S.refreshBusy=true;S.refreshError='';
    let done=false;
    const finish=(err)=>{
      if(done)return;done=true;clearTimeout(S.refreshTimeout);S.refreshBusy=false;S.refreshError=err||'';
      try{load();}catch{}
      renderBalance();
    };
    S.refreshTimeout=setTimeout(()=>finish('Refresh timed out'),60000);
    renderBalance();
    try{
      chrome.runtime.sendMessage({type:'REFRESH_GAME_OVERLAY_NOW',realm:S.realm},res=>{
        const le=chrome.runtime.lastError;
        if(le)return finish(le.message||'Refresh failed');
        finish(res&&res.ok===false?(res.error||'Refresh failed'):'');
      });
    }catch(e){finish(String(e&&e.message||e||'Refresh failed'));}
  };
  const renderBalance=()=>{
    if(!S.etaTimer){S.etaTimer=setInterval(()=>{if(!document.hidden)tickEta();},1000);document.addEventListener('visibilitychange',()=>{if(!document.hidden){try{tickEta();}catch{}}});}
    const host=ensureCard('scm-game-balance-card','');style();
    if(S.collapsed){host.className='scm-go-collapsed';host.innerHTML='<button type="button" class="scm-go-toggle" aria-label="Expand production balance">›</button>';host.querySelector('button').onclick=()=>{S.collapsed=false;writeCollapsedPreference(false);renderBalance();schedulePosition();};return;}
    host.className='';
    const rows=Array.isArray(S.data?.rows)?S.data.rows:[];
    const title=`${S.realm!=null?`R${S.realm+1}`:'Game'} · Stock After Demand & Contracts`;
    const items=rows.map(r=>{const remaining=Number(r.remaining??r.difference)||0;const cls=remaining>0?'positive':remaining<0?'negative':'balanced';const sub=Array.isArray(r.substituteQualities)&&r.substituteQualities.length?` scm-go-sub ${remaining<0?'scm-go-sub-neg':'scm-go-sub-pos'}`:'';return `<div class="scm-go-row${sub}"${sub?` title="Includes Q${r.substituteQualities.join(', Q')} stock"`:''}><span>${r.image?`<img src="${esc(r.image)}" alt="">`:''}</span><span class="scm-go-name">${esc(r.name)}${Number.isFinite(Number(r.quality))?` Q${Number(r.quality)}`:''}</span><span class="scm-go-stock">Warehouse ${num(r.warehouse)}${sub&&Array.isArray(r.warehouseByQuality)?`<span class="scm-go-split">${r.warehouseByQuality.map(x=>`${num(x.amount)} Q${x.quality}`).join(' + ')}</span>`:''}</span><span class="scm-go-contract">Demand ${num(r.demand)}</span><span class="scm-go-contract">Contracts (net) ${num(r.contracted)}</span><span class="scm-go-remaining ${cls}">Left ${num(remaining)}</span>${etaStrip(r,remaining)}</div>`;}).join('');
    host.innerHTML=`<div class="scm-go-head"><span class="scm-go-title">${esc(title)}</span><span class="scm-go-head-actions"><button type="button" class="scm-go-toggle scm-go-copy" aria-label="Copy left resources">COPY LEFT</button><button type="button" class="scm-go-toggle scm-go-refresh" aria-label="Refresh stock after demand">↻</button><button type="button" class="scm-go-toggle" aria-label="Collapse production balance">‹</button></span></div>${items?`<div class="scm-go-grid">${items}</div>`:`<div class="scm-ch-none">${S.realm==null?'Checking which realm this game tab is in…':'Waiting for production data.'}</div>`}`;
    host.querySelector('.scm-go-copy').onclick=openLeftCopy;
    const rbtn=host.querySelector('.scm-go-refresh');
    if(rbtn){rbtn.onclick=refreshGameOverlay;rbtn.disabled=!!S.refreshBusy;if(S.refreshError)rbtn.title=S.refreshError;}
    host.querySelectorAll('.scm-go-toggle:not(.scm-go-copy):not(.scm-go-refresh)').forEach(btn=>btn.onclick=()=>{S.collapsed=true;writeCollapsedPreference(true);renderBalance();schedulePosition();});
    if(S.leftCopyOpen){
      const sig=JSON.stringify({discount:S.leftCopyDiscount,rows:leftRows().map(r=>[r.id,r.remaining??r.difference,r.vwap,r.quality])});
      if(sig!==S.leftCopySignature){openLeftCopy();}
    }
  };
  const normalizeFieldName=v=>String(v??'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const fieldMatches=(text,names)=>{
    const t=normalizeFieldName(text);
    return (names||[]).some(n=>{const q=normalizeFieldName(n);return q&&(t===q||t.includes(q));});
  };
  const fieldText=(names)=>{
    const controls=[...document.querySelectorAll('input,textarea,select,[contenteditable="true"]')];
    for(const el of controls){
      const attrs=[el.getAttribute?.('aria-label'),el.getAttribute?.('placeholder'),el.getAttribute?.('name'),el.getAttribute?.('id'),el.getAttribute?.('data-testid')].filter(Boolean);
      if(attrs.some(a=>fieldMatches(a,names))){
        const value=String(el.value??el.textContent??'').replace(/\s+/g,' ').trim();
        if(value)return value;
      }
      const id=el.getAttribute?.('id');
      if(id){
        const label=document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if(label&&fieldMatches(label.textContent,names)){
          const value=String(el.value??el.textContent??'').replace(/\s+/g,' ').trim();
          if(value)return value;
        }
      }
      const parent=el.closest?.('label');
      if(parent&&fieldMatches(parent.textContent,names)){
        const value=String(el.value??el.textContent??'').replace(/\s+/g,' ').trim();
        if(value)return value;
      }
    }
    return '';
  };
  const labeledValue=(lines,names)=>{
    for(let i=0;i<lines.length;i++){
      const line=String(lines[i]||'').trim();
      for(const name of (names||[])){
        const escaped=String(name).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
        const m=line.match(new RegExp('^'+escaped+'\\s*[:\\-]?\\s*(.*)$','i'));
        if(m&&m[1].trim())return m[1].trim();
        if(m&&lines[i+1])return String(lines[i+1]).trim();
      }
    }
    return '';
  };
  const fireInput=el=>{
    try{el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));el.dispatchEvent(new Event('blur',{bubbles:true}));}catch{}
  };
  const setNativeValue=(el,value)=>{
    if(!el)return false;
    try{
      const proto=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;
      const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;
      if(setter)setter.call(el,String(value));else el.value=String(value);
      fireInput(el);
      return true;
    }catch{return false;}
  };
  const visibleControl=el=>{const r=el?.getBoundingClientRect?.();if(!r)return false;const cs=getComputedStyle(el);return cs.display!=='none'&&cs.visibility!=='hidden'&&r.width>0&&r.height>0;};
  const contractInput=(names,fallbackIndex,excluded=new Set())=>{
    const wanted=(names||[]).map(normalizeFieldName).filter(Boolean);
    const controls=[...document.querySelectorAll('input,textarea,[contenteditable="true"]')].filter(visibleControl);
    const visibleTextElements=[...document.querySelectorAll('body *')].filter(visibleControl);
    const rectDistance=(a,b)=>{
      const ax=a.left+a.width/2, ay=a.top+a.height/2;
      const bx=b.left+b.width/2, by=b.top+b.height/2;
      return Math.hypot(ax-bx,ay-by);
    };
    const exactLabelCandidates=[];
    for(const el of visibleTextElements){
      if(controls.includes(el))continue;
      const text=normalizeFieldName(String(el.textContent||''));
      if(!text||text.length>80)continue;
      for(const w of wanted){
        if(text===w)exactLabelCandidates.push({el,w});
      }
    }
    let best=null,bestScore=-1;
    for(const el of controls){
      if(excluded.has(el))continue;
      const direct=[el.getAttribute?.('aria-label'),el.getAttribute?.('placeholder'),el.getAttribute?.('name'),el.getAttribute?.('id'),el.getAttribute?.('data-testid')].filter(Boolean).map(normalizeFieldName);
      const labelTexts=[];
      const id=el.getAttribute?.('id');
      if(id){const lab=document.querySelector(`label[for="${CSS.escape(id)}"]`);if(lab)labelTexts.push(normalizeFieldName(lab.textContent||''));}
      const label=el.closest?.('label');if(label)labelTexts.push(normalizeFieldName(label.textContent||''));
      // The contract page can place AMOUNT and PRICE PER UNIT in the same
      // broad parent, so parent text is deliberately NOT treated as a field
      // label. Only exact nearby label text may identify the control.
      const prev=el.previousElementSibling;
      if(prev)labelTexts.push(normalizeFieldName(prev.textContent||''));
      let score=0;
      for(const w of wanted){if(!w)continue;
        if(labelTexts.some(t=>t===w))score=Math.max(score,2000+w.length);
        else if(labelTexts.some(t=>t.includes(w)&&t.length<=40))score=Math.max(score,430+w.length);
        else if(direct.some(t=>t===w))score=Math.max(score,300+w.length);
        else if(direct.some(t=>t.includes(w)))score=Math.max(score,260+w.length);
      }
      const cr=el.getBoundingClientRect?.();
      if(cr){
        for(const {el:lab,w} of exactLabelCandidates){
          const lr=lab.getBoundingClientRect?.();
          if(!lr)continue;
          const d=rectDistance(cr,lr);
          // Nearby exact visible labels are the authoritative mapping. This
          // prevents a generic input name/id from making PRICE become AMOUNT.
          if(d<=220)score=Math.max(score,1000+w.length-Math.min(300,d));
        }
      }
      if(score>bestScore){bestScore=score;best=el;}
    }
    const fallback=controls.filter(el=>!excluded.has(el))[fallbackIndex]||controls.find(el=>!excluded.has(el))||null;
    return bestScore>0?best:fallback;
  };
  const selectedRecipientCandidates=()=>{
    const out=[];const add=v=>{
      const t=String(v||'').replace(/\bchange\b/ig,' ').replace(/\brecipient\b/ig,' ').replace(/\s+/g,' ').trim();
      // The game's selected-recipient container also contains generic labels such
      // as RECIPIENT/COMPANY. Never let one of those become candidate #1.
      if(!t||/^(recipient|company|select company|choose company|amount|price|price per unit)$/i.test(t))return;
      if(/^(change|search|cancel|all)$/i.test(t))return;
      if(t.length>1&&t.length<120&&!out.includes(t))out.push(t);
    };
    const visible=el=>{const r=el?.getBoundingClientRect?.();const cs=el?getComputedStyle(el):null;return !!el&&(!r||r.width>0&&r.height>0)&&cs?.display!=='none'&&cs?.visibility!=='hidden';};
    const changes=[...document.querySelectorAll('a,button,[role="button"],span,div')].filter(el=>visible(el)&&String(el.textContent||'').trim().toLowerCase()==='change');
    for(const ch of changes.slice(0,8)){
      let p=ch.parentElement;
      for(let i=0;i<3&&p;i++,p=p.parentElement){
        const lines=String(p.innerText||'').split('\n').map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean);
        for(const line of lines){if(!/^change$/i.test(line))add(line);}
        if(out.length)break;
      }
      if(out.length)break;
    }
    return out;
  };
  // The game's warehouse resource page (/headquarters/warehouse/<resource>/sell/ or /contract/) names its
  // resource only through the header's encyclopedia link /encyclopedia/<realm>/resource/<id>/ (game bundle). Quality:
  // "Current exchange orders for Q<q>+" (selected lot), else the header's stars. Page text is never used for the
  // product: the exchange-order list holds company names such as "PATO SILICON AND METALS".
  const warehousePageResource=()=>{
    const tab=(String(location.pathname||'').match(/\/headquarters\/warehouse\/[^/]+\/(sell|contract)\/?$/i)||[])[1];
    if(!tab)return null;
    const links=[...document.querySelectorAll('a[href*="/encyclopedia/"][href*="/resource/"]')];
    const link=links.find(a=>a.querySelector('img'))||links[0];
    const idMatch=String(link?.getAttribute('href')||'').match(/\/resource\/(\d+)\/?(?:[?#].*)?$/);
    if(!idMatch)return null;
    let quality=null;
    const q=String(document.body?.innerText||'').match(/exchange orders for Q(\d+)\+/i);
    if(q)quality=Number(q[1]);
    else{
      const block=link.parentElement?.parentElement;
      for(const sel of ['svg[data-icon="star"]','svg.fa-star','.fa-star','[class*="fa-star"]']){
        const stars=block?[...block.querySelectorAll(sel)]:[];
        if(!stars.length)continue;
        const holder=stars[0].parentElement;const lead=String(holder?.textContent||'').trim().match(/^(\d+)/);
        quality=lead?Number(lead[1]):stars.filter(x=>x.parentElement===holder).length;break;
      }
    }
    const name=String(link.querySelector('img')?.getAttribute('alt')||'').trim();
    return {id:Number(idMatch[1]),quality:Number.isFinite(quality)?quality:null,name,tab:tab.toLowerCase()};
  };
  const detectContractContext=()=>{
    const raw=String(document.body?.innerText||'').replace(/\r/g,'');
    const lines=raw.split('\n').map(s=>s.replace(/\s+/g,' ').trim()).filter(Boolean);
    const selectedRecipients=selectedRecipientCandidates();
    const fieldRecipient=fieldText(['recipient']);
    const recipient=selectedRecipients[0]||'';
    const pageResource=warehousePageResource();
    const product=fieldText(['product','resource'])||labeledValue(lines,['product','resource']);
    const qualityText=fieldText(['quality'])||labeledValue(lines,['quality']);
    const quality=(qualityText.match(/\bQ?([0-9]{1,2})\b/i)||[])[1]??pageResource?.quality;
    const contractPage=/(?:recipient|amount|price per unit|please enter amount)/i.test(raw)||/contract/i.test(String(location.pathname||''));
    if(!contractPage&&!selectedRecipients.length&&!fieldRecipient&&!product)return null;
    return {body:raw,lines,recipient,fieldRecipient,selectedRecipient:selectedRecipients.length>0,product,productId:pageResource?.id??null,quality:quality!=null&&Number.isFinite(Number(quality))?Number(quality):null};
  };
  const matchSavedContract=(ctx,saved)=>{
    if(!ctx)return null;
    const recipientCandidates=[ctx.recipient,...(ctx.fieldRecipient?[ctx.fieldRecipient]:[])].map(norm).filter(Boolean);
    if(!recipientCandidates.length)return null;
    const pageId=Number(ctx.productId);
    if(pageId>0){
      // The page names its resource: only saved contracts for that resource id can match.
      let hit=null,hitScore=-1;
      for(const c of saved){
        const id=Number(c?.productId??(String(c?.product||'').match(/^(\d+):/)||[])[1]);
        if(id!==pageId||!recipientCandidates.includes(norm(c?.company)))continue;
        const score=ctx.quality!=null&&Number(c.quality)===ctx.quality?2:1;
        if(score>hitScore){hitScore=score;hit=c;}
      }
      return hit;
    }
    const prod=norm(ctx.product);const body=String(ctx.body||'').toLowerCase();
    let best=null,bestScore=-1;
    for(const c of saved){
      const company=norm(c.company),product=norm(c.productName||c.product||'');
      if(!company||!product||!recipientCandidates.includes(company))continue;
      let score=120;
      if(prod&&prod===product)score+=70;
      else if(body.includes(String(c.productName||c.product||'').toLowerCase()))score+=60;
      else continue;
      if(ctx.quality!=null&&Number(c.quality)===ctx.quality)score+=15;
      if(score>bestScore){bestScore=score;best=c;}
    }
    return best;
  };
  const fillContractForm=(c,qty)=>{
    if(S.contractFillTimer)clearTimeout(S.contractFillTimer);
    const qtyEl=contractInput(['amount','quantity','units'],0);
    // Keep quantity and price on distinct controls even when the game's DOM
    // exposes overlapping generic attributes.
    const priceEl=contractInput(['price per unit','unit price','contract price','price'],1,new Set(qtyEl?[qtyEl]:[]));
    const apply=()=>{
      if(qty!=null&&String(qtyEl?.value??'')!==String(qty))setNativeValue(qtyEl,qty);
      if(String(priceEl?.value??'')!==String(c.price??''))setNativeValue(priceEl,c.price??'');
    };
    apply();
    S.contractFillTimer=setTimeout(()=>{S.contractFillTimer=0;apply();},500);
  };
  const desiredContractQty=(c)=>{
    // The selected helper mode is the source of truth for the Amount field.
    // Saved amount = saved contract quantity; Surplus = current production surplus after demand;
    // Custom = user-entered quantity. Left = current positive Stock-After-Demand-And-Contracts leftover.
    // Whole units only: the game's Amount box is step 1.
    const surplus=Math.floor(Math.max(0,Number(c.surplus??c.available)||0));
    const left=Math.floor(Math.max(0,Number(c.left)||0));
    if(S.contractQtyMode==='surplus')return surplus;
    if(S.contractQtyMode==='custom'){const raw=Number(S.contractCustomQty);return Number.isFinite(raw)&&raw>0?raw:null;}
    const savedMode=String(c.quantityMode||'custom').toLowerCase();
    if(savedMode==='surplus')return surplus;
    if(savedMode==='left')return left;
    return Math.max(0,Number(c.quantity)||0);
  };
  const loadContractHelper=async()=>{
    const ctx=detectContractContext();const existing=document.getElementById('scm-contract-helper-card');if(!ctx||!Number.isFinite(S.realm)){existing?.remove();S.contractSignature='';return;}
    try{
      const r=await chrome.runtime.sendMessage({type:'GET_CONTRACT_HELPER_DATA',realm:S.realm});if(!r?.ok){existing?.remove();return;}
      const c=matchSavedContract(ctx,r.contracts||[]);if(!c){existing?.remove();S.contractSignature='';return;}
      const available=Math.max(0,Number(c.surplus??c.available)||0);const qty=desiredContractQty(c);
      const matchKey=JSON.stringify({realm:S.realm,id:c.id,price:c.price,recipient:ctx.recipient,product:ctx.product});
      if(S.contractDismissedKey===matchKey){existing?.remove();return;}
      const sig=JSON.stringify({realm:S.realm,id:c.id,qty,mode:S.contractQtyMode,custom:S.contractCustomQty,price:c.price,recipient:ctx.recipient,product:ctx.product,surplus:available});
      const qtyElNow=contractInput(['amount','quantity','units'],0);const priceElNow=contractInput(['price per unit','unit price','contract price','price'],1,new Set(qtyElNow?[qtyElNow]:[]));
      const needsFill=sig!==S.contractSignature||(c.price!=null&&String(priceElNow?.value??'')==='')||(qty!=null&&String(qtyElNow?.value??'')==='');
      if(needsFill){S.contractSignature=sig;fillContractForm(c,qty);}else S.contractSignature=sig;
      const card=existing||ensureCard('scm-contract-helper-card','scm-ch-card');
      const selectedSaved=S.contractQtyMode==='saved'?' selected':'';const selectedSurplus=S.contractQtyMode==='surplus'?' selected':'';const selectedCustom=S.contractQtyMode==='custom'?' selected':'';
      const customValue=S.contractQtyMode==='custom'&&Number.isFinite(Number(S.contractCustomQty))?String(S.contractCustomQty):'';
      const savedModeLabel=String(c.quantityMode||'custom').toLowerCase()==='surplus'?'Surplus':String(c.quantityMode||'custom').toLowerCase()==='left'?'Left':'Custom amount';
      const savedModeText=String(c.quantityMode||'custom').toLowerCase()==='custom'?`Custom amount · ${num(c.quantity)}`:`${savedModeLabel}`;
      const renderSig=JSON.stringify({id:c.id,price:c.price,quantity:c.quantity,quantityMode:c.quantityMode,surplus:available,mode:S.contractQtyMode,custom:customValue});
      const modeElBefore=card.querySelector('#scm-contract-qty-mode');
      // Never replace the select while it has focus. The game's SPA can emit
      // mutations while the native dropdown is open; replacing the element
      // makes Android close the popup immediately (the visible flash).
      if(modeElBefore!==document.activeElement && renderSig!==S.contractCardSignature){
        S.contractCardSignature=renderSig;
        card.innerHTML=`<div class="scm-ch-head"><span class="scm-ch-title">Saved contract matched</span><button type="button" class="scm-ch-close" data-contract-close aria-label="Close saved contract helper">×</button></div><div class="scm-ch-meta">${esc(c.company)} · ${esc(c.productName)} · Q${esc(c.quality)} · ${money(c.price)}/unit</div><div class="scm-ch-qty"><label>Quantity</label><select id="scm-contract-qty-mode"><option value="saved"${selectedSaved}>Saved · ${esc(savedModeText)}</option><option value="surplus"${selectedSurplus}>Surplus · ${num(Math.floor(Number(c.surplus??c.available)||0))}</option><option value="custom"${selectedCustom}>Custom amount</option></select>${S.contractQtyMode==='custom'?`<input id="scm-contract-custom-qty" type="number" min="1" step="1" value="${esc(customValue)}" aria-label="Custom amount">`:''}</div><div class="scm-ch-cap">Maximum available surplus: ${num(available)}</div>`;
      }
      const modeEl=card.querySelector('#scm-contract-qty-mode');
      if(modeEl)modeEl.onchange=()=>{S.contractQtyMode=String(modeEl.value||'saved');if(S.contractQtyMode!=='custom')S.contractCustomQty='';S.contractSignature='';S.contractCardSignature='';loadContractHelper();};
      const closeEl=card.querySelector('[data-contract-close]');
      if(closeEl)closeEl.onclick=()=>{S.contractDismissedKey=matchKey;S.contractSignature='';S.contractCardSignature='';card.remove();schedulePosition();};
      applyMin(card);
      const customEl=card.querySelector('#scm-contract-custom-qty');
      if(customEl){customEl.oninput=()=>{S.contractCustomQty=customEl.value;S.contractSignature='';fillContractForm(c,desiredContractQty(c));};}
    }catch{existing?.remove();}
  };
  // "Sell on the exchange" quantity helper. The game's sell form (warehouse …/sell/) has
  // input[name="amount"] and input[name="price"] (game bundle). Left = the overlay row's Left (stock after
  // demand & saved contracts), Surplus = the overlay row's production surplus; both whole units, never < 0.
  const SELL_POS_KEY='scmSellQtyCardPos';
  const sellAmountInput=()=>{const el=[...document.querySelectorAll('form input[name="amount"]')].find(x=>visible(x)&&x.closest('form')?.querySelector('input[name="price"]'));return el||null;};
  const sellQuantities=res=>{
    const rows=S.data&&res&&res.quality!=null&&Number(S.data.realm)===Number(S.realm)&&Array.isArray(S.data.rows)?S.data.rows:[];
    const row=rows.find(r=>Number(r?.id)===res.id&&(Number(r?.quality)||0)===res.quality)||null;
    const whole=v=>Number.isFinite(Number(v))?Math.floor(Math.max(0,Number(v))):null;
    return {row,left:row?whole(row.remaining??row.difference):null,surplus:row?whole(row.surplus):null};
  };
  const placeSellCard=(card,x,y)=>{
    const w=card.offsetWidth||220,h=card.offsetHeight||90;
    const left=Math.min(Math.max(4,x),Math.max(4,window.innerWidth-w-4)),top=Math.min(Math.max(4,y),Math.max(4,window.innerHeight-h-4));
    card.style.left=`${Math.round(left)}px`;card.style.top=`${Math.round(top)}px`;
  };
  const sellMoney=v=>{const x=Number(v);if(!Number.isFinite(x))return '—';return '$'+x.toLocaleString(undefined,{minimumFractionDigits:x<1?3:2,maximumFractionDigits:x<1?3:2});};
  const sellPriceHtml=(p,quality)=>{
    if(!p)return '';
    const lines=[];
    if(p.suggested!=null)lines.push(`Cheapest Q${quality}+ listing${p.cheapestQuality!=null&&p.cheapestQuality!==quality?` (a Q${p.cheapestQuality})`:''} · ${num(p.competing)} competing${priceSrcSuffix(p.marketPriceSource,p.marketPriceStale)}`);
    else lines.push(p.refreshing?'Loading the exchange listings…':'No competing listing captured.');
    if(p.range)lines.push(`7-day VWAP ${sellMoney(p.range.low)}–${sellMoney(p.range.high)} (avg ${sellMoney(p.range.average)})`);
    const tail=[];if(p.unitCost!=null)tail.push(`your cost ${sellMoney(p.unitCost)}`);if(p.net!=null)tail.push(`you get ${sellMoney(p.net)} after ${Number(p.feePct).toFixed(1)}% fee`);if(tail.length)lines.push(tail.join(' · '));
    const warn=(p.warnings||[]).map(w=>w==='below-7d-low'?'Below the 7-day low':w==='below-cost'?'Below your cost':'').filter(Boolean);
    return `<div class="scm-sq-price">${p.suggested!=null?`<button type="button" class="scm-sq-fill scm-sq-pbtn" data-sq-price="${esc(String(p.suggested))}"><span>Price · match cheapest</span><b>${sellMoney(p.suggested)}</b></button>`:''}<div class="scm-sq-note">${lines.map(esc).join('<br>')}</div>${warn.length?`<div class="scm-sq-warn">${esc(warn.join(' · '))}</div>`:''}</div>`;
  };
  const removeSellCard=()=>{document.getElementById('scm-sell-qty-card')?.remove();S.sellCardSignature='';};
  const loadSellHelper=()=>{
    const res=warehousePageResource();const amountEl=res?.tab==='sell'?sellAmountInput():null;
    if(!amountEl||S.sellDismissedPath===location.pathname||!Number.isFinite(S.realm)){removeSellCard();return;}
    const q=sellQuantities(res);
    // Smart sell price (background GET_SELL_PRICE_INFO); re-asked every 20 s, 3 s after an order-book refresh.
    const pk=res.quality!=null&&res.id>0?`${S.realm}:${res.id}:${res.quality}`:'';
    const pc=pk&&S.sellPrice&&S.sellPrice.key===pk?S.sellPrice:null;
    if(pk&&(!pc||Date.now()-pc.at>20000)&&!S.sellPriceInflight){
      S.sellPriceInflight=true;
      try{chrome.runtime.sendMessage({type:'GET_SELL_PRICE_INFO',realm:S.realm,resourceId:res.id,quality:res.quality},r=>{S.sellPriceInflight=false;const ok=!chrome.runtime.lastError&&r&&r.ok;S.sellPrice={key:pk,at:ok&&r.refreshing?Date.now()-17000:Date.now(),info:ok?r:null};if(ok&&r.refreshing)setTimeout(scheduleSellHelper,3200);scheduleSellHelper();});}catch{S.sellPriceInflight=false;S.sellPrice={key:pk,at:Date.now(),info:null};}
    }
    const pinfo=pc&&pc.info?pc.info:null;
    const title=`${res.name||'Resource'}${res.quality!=null?` Q${res.quality}`:''}`;
    const note=res.quality==null?'Quality not found on this page.':!S.data?'Waiting for Manager data…':!q.row?'Not in your Stock After Demand overlay.':q.surplus==null?'Surplus not built yet — refreshing.':'Tap to fill Amount.';
    const sig=JSON.stringify([S.realm,res.id,res.quality,title,q.left,q.surplus,note,pinfo?[pinfo.suggested,pinfo.cheapestQuality,pinfo.competing,pinfo.range,pinfo.unitCost,pinfo.net,pinfo.warnings,pinfo.refreshing]:null]);
    let card=document.getElementById('scm-sell-qty-card');
    if(card&&S.sellCardSignature===sig)return;
    const fresh=!card;
    if(!card){card=document.createElement('section');card.id='scm-sell-qty-card';document.documentElement.appendChild(card);}
    S.sellCardSignature=sig;
    const btn=(kind,label,value)=>`<button type="button" class="scm-sq-fill" data-sq-fill="${kind}"${value==null?' disabled':''}><span>${label}</span><b>${value==null?'—':num(value)}</b></button>`;
    card.innerHTML=`<div class="scm-sq-head" data-sq-drag><span class="scm-sq-grip" aria-hidden="true">⠿</span><span class="scm-sq-title">${esc(title)}</span><button type="button" class="scm-sq-close" data-sq-close aria-label="Close sell helper">×</button></div><div class="scm-sq-btns">${btn('left','Left',q.left)}${btn('surplus','Surplus',q.surplus)}</div><div class="scm-sq-note">${esc(note)}</div>${sellPriceHtml(pinfo,res.quality)}`;
    card.querySelector('[data-sq-price]')?.addEventListener('click',e=>{const b=e.currentTarget;const v=Number(b.dataset.sqPrice);const amount=sellAmountInput();const input=amount?.closest('form')?.querySelector('input[name="price"]');if(Number.isFinite(v)&&input){setNativeValue(input,v);b.classList.add('scm-sq-done');setTimeout(()=>b.classList.remove('scm-sq-done'),700);}});
    card.querySelectorAll('[data-sq-fill]').forEach(b=>{b.onclick=()=>{const cur=sellQuantities(warehousePageResource());const v=cur[b.dataset.sqFill];const input=sellAmountInput();if(v!=null&&input){setNativeValue(input,v);b.classList.add('scm-sq-done');setTimeout(()=>b.classList.remove('scm-sq-done'),700);}};});
    card.querySelector('[data-sq-close]').onclick=()=>{S.sellDismissedPath=location.pathname;removeSellCard();};
    applyMin(card);
    const head=card.querySelector('[data-sq-drag]');
    head.onpointerdown=e=>{
      if(e.target.closest('[data-sq-close],[data-scm-min]'))return;
      const r=card.getBoundingClientRect();const dx=e.clientX-r.left,dy=e.clientY-r.top;
      try{head.setPointerCapture(e.pointerId);}catch{}
      head.onpointermove=m=>{placeSellCard(card,m.clientX-dx,m.clientY-dy);};
      head.onpointerup=head.onpointercancel=()=>{head.onpointermove=null;try{localStorage.setItem(SELL_POS_KEY,JSON.stringify({x:parseFloat(card.style.left)||0,y:parseFloat(card.style.top)||0}));}catch{}};
      e.preventDefault();
    };
    if(fresh){
      let saved=null;try{saved=JSON.parse(localStorage.getItem(SELL_POS_KEY)||'null');}catch{}
      if(saved&&Number.isFinite(saved.x)&&Number.isFinite(saved.y))placeSellCard(card,saved.x,saved.y);
      else placeSellCard(card,window.innerWidth-(card.offsetWidth||220)-8,window.innerHeight-(card.offsetHeight||90)-96);
    }else placeSellCard(card,parseFloat(card.style.left)||0,parseFloat(card.style.top)||0);
  };
  const scheduleSellHelper=()=>{
    if(!/\/headquarters\/warehouse\/[^/]+\/sell\/?$/i.test(String(location.pathname||''))){if(document.getElementById('scm-sell-qty-card'))removeSellCard();return;}
    if(S.sellTimer)return;
    S.sellTimer=setTimeout(()=>{S.sellTimer=0;try{loadSellHelper();}catch{}},250);
  };
  const load=async(realmOverride=null)=>{
    if(!isSimCompaniesPage())return;
    // Never remove a working overlay just because a refresh is starting: a slow or
    // failed refresh must not make the overlay disappear.
    if(S.loadInFlight){S.loadQueued=true;return;}
    S.loadInFlight=true;
    const requestEpoch=S.loadEpoch;
    const overrideRealm=(realmOverride===0||realmOverride===1)?Number(realmOverride):null;
    const actualPageRealm=currentRealm();
    // A delayed background refresh notification can cross a SPA realm switch.
    // Never render an explicitly requested realm into a tab that identifies as
    // the other realm.
    if(overrideRealm!=null && actualPageRealm!=null && overrideRealm!==actualPageRealm){
      // Reject a stale realm notification without stranding the single-flight
      // loader (this path returns before try/finally, so it clears loadInFlight itself).
      S.loadInFlight=false;S.loadQueued=false;
      // The other realm's refresh is ignored: keep this realm's card as it is.
      if(S.data&&Number(S.data.realm)===actualPageRealm)return;
      S.realm=actualPageRealm;S.data=null;S.signature='';S.loadEpoch++;
      renderBalance();schedulePosition();
      document.getElementById('scm-contract-helper-card')?.remove();
      document.getElementById('scm-left-copy-card')?.remove();
      setTimeout(()=>load(actualPageRealm),0);
      return;
    }
    // Until this tab's realm is known (the game's auth-data answer), show nothing realm-specific: asking
    // without a realm would return the last-synced realm's overlay.
    if(actualPageRealm==null){
      S.loadInFlight=false;S.loadQueued=false;
      if(S.data!=null||S.realm!=null){S.data=null;S.realm=null;S.signature='';}
      if(!document.getElementById('scm-game-balance-card')||S.realmPendingShown!==true){S.realmPendingShown=true;renderBalance();}
      schedulePosition();
      return;
    }
    S.realmPendingShown=false;
    const pageRealm=overrideRealm??actualPageRealm;
    try{
      // Repaint the last valid realm-local snapshot immediately if the SPA
      // replaced the page DOM. This is deliberately before the async refresh.
      if(!document.getElementById('scm-game-balance-card') && S.data && Number(S.data.realm)===pageRealm){
        renderBalance();
        schedulePosition();
      }
      const r=await chrome.runtime.sendMessage({type:'GET_GAME_OVERLAY_DATA',realm:pageRealm});
      // A realm transition invalidates older in-flight requests. Never let an
      // R1 response arrive after an R2 switch and repopulate the visible card.
      if(requestEpoch!==S.loadEpoch)return;
      // A failed/slow refresh never clears the last known-good overlay.
      if(!r?.ok){schedulePosition();return;}
      if(Number(r.realm)!==Number(pageRealm)){
        // Never allow an old active-realm response to repopulate a newly
        // selected realm overlay. Explicit realm requests are authoritative.
        S.realm=Number(pageRealm);
        S.data=null;
        S.signature='';
        renderBalance();schedulePosition();
        return;
      }
      // Re-render when any field used by Stock After Demand & Contracts or
      // Copy Left changes (VWAP included, or Copy Left keeps blank prices).
      const signature=JSON.stringify({
        realm:r.realm,
        rows:(Array.isArray(r.rows)?r.rows:[]).map(row=>({
          id:Number(row?.id),
          quality:Number(row?.quality)||0,
          warehouse:Number(row?.warehouse)||0,
          demand:Number(row?.demand)||0,
          contracted:Number(row?.contracted)||0,
          difference:Number(row?.difference)||0,
          etaRuns:row?.etaRuns,
          marketPrice:Number.isFinite(Number(row?.marketPrice))?Number(row.marketPrice):null,
          vwap:Number.isFinite(Number(row?.vwap))?Number(row.vwap):null
        })).sort((a,b)=>a.id-b.id||a.quality-b.quality)
      });
      S.realm=r.realm;S.data=r;
      if(signature!==S.signature||!document.getElementById('scm-game-balance-card')){S.signature=signature;renderBalance();}
      if(likelyContractPage())await loadContractHelper();schedulePosition();scheduleSellHelper();
    }catch{
      if(requestEpoch!==S.loadEpoch)return;
      // Keep the existing card and data intact on bridge/API failures.
      if(!document.getElementById('scm-game-balance-card') && S.data && Number(S.data.realm)===pageRealm){
        try{renderBalance();schedulePosition();}catch{}
      }else schedulePosition();
    }finally{
      S.loadInFlight=false;
      if(S.loadQueued){S.loadQueued=false;setTimeout(load,250);}
    }
  };
  const route=()=>{
    // Route changes are the one time we intentionally remove route-specific
    // helpers. The production balance itself is realm-scoped and is allowed to
    // survive until the new realm snapshot has been rendered.
    if(location.href!==S.lastUrl){S.lastUrl=location.href;S.loadEpoch++;S.signature='';S.contractSignature='';S.contractCardSignature='';S.contractDismissedKey='';S.leftCopySignature='';S.leftCopyOpen=false;document.getElementById('scm-left-copy-card')?.remove();S.sellDismissedPath='';removeSellCard();}
    load();scheduleSellHelper();
  };
  chrome.runtime.onMessage.addListener((message)=>{
    if(message?.type!=='REFRESH_GAME_OVERLAY')return false;
    try{
      const targetRealm=(message.realm===0||message.realm===1)?Number(message.realm):null;
      if(targetRealm!=null) load(targetRealm);
      else load();
    }catch(e){console.debug('SCM overlay refresh failed',e);}
    return false;
  });
  window.addEventListener('scm-game-realm-change',(event)=>{
    const n=Number(event?.detail?.realm);
    if(n!==0 && n!==1)return;
    if(Number(S.realm)===n && S.data?.realm===n)return;
    // Invalidate the visible R1/R2 card immediately. Do not leave stale data
    // on screen while the target realm snapshot is being loaded.
    // Collapse only on a real switch between two known realms, not when this tab first learns its realm.
    const switchedFromOther=(S.realm===0||S.realm===1)&&Number(S.realm)!==n;
    S.realm=n; S.data=null; S.loadEpoch++; S.signature=''; S.contractSignature=''; S.contractCardSignature=''; S.leftCopySignature=''; S.leftCopyOpen=false;
    if(switchedFromOther){S.collapsed=true;writeCollapsedPreference(true);}
    renderBalance();schedulePosition();
    document.getElementById('scm-contract-helper-card')?.remove();
    document.getElementById('scm-left-copy-card')?.remove();
    load(n);
  });

  const start=()=>{
    style();document.getElementById('scm-left-copy-card')?.remove();S.leftCopyOpen=false;S.leftCopySignature='';
    // Create the always-available collapsed control synchronously, before the
    // background data request can complete or fail.
    S.collapsed=true;writeCollapsedPreference(true);renderBalance();schedulePosition();load();
    S.refreshTimer?.stop?.();S.refreshTimer=globalThis.__scmTimers.loop('overlayRefresh',10000,()=>{if(!document.hidden)load();});
    if(!S.visibilityHooked){S.visibilityHooked=true;document.addEventListener('visibilitychange',()=>{if(!document.hidden)load();});}
    if(S.recoveryTimer)clearInterval(S.recoveryTimer);
    // Watchdog: if the game's SPA removes the injected card without a route
    // change, restore the last good realm-local snapshot without waiting for
    // the next API refresh.
    S.recoveryTimer=setInterval(()=>{
      if(document.hidden||!isSimCompaniesPage())return;
      const pageRealm=currentRealm();
      if(!document.getElementById('scm-game-balance-card')){
        try{
          if(S.data&&(pageRealm==null||Number(S.data.realm)===pageRealm))renderBalance();
          else {S.collapsed=true;renderBalance();setTimeout(()=>load(pageRealm),0);}
          schedulePosition();
        }catch{}
      }
    },3000);
    // The sell/contract helper checks run once per idle slot instead of on every mutation batch. The
    // balance-card re-insert below stays synchronous so a React re-render cannot make the card flicker.
    let helperCheckPending=false;
    const runHelperChecks=()=>{helperCheckPending=false;try{scheduleSellHelper();if(document.getElementById('scm-game-balance-card')&&likelyContractPage())scheduleContractHelper();}catch{}};
    const queueHelperChecks=()=>{if(helperCheckPending)return;helperCheckPending=true;if(typeof requestIdleCallback==='function')requestIdleCallback(runHelperChecks,{timeout:400});else setTimeout(runHelperChecks,150);};
    // Mutations only inside the extension's own UI need no work here (the card-removal
    // mutation targets the game's parent node, so it is never skipped).
    const scmOwnMutation=m=>{const t=m.target;return t&&t.nodeType===1&&!!t.closest?.('[id^="scm-"],[data-scm-owned]');};
    if(S.observer)S.observer.disconnect();S.observer=new MutationObserver(muts=>{
      if(muts&&muts.length&&muts.every(scmOwnMutation))return;
      queueHelperChecks();
      const card=document.getElementById('scm-game-balance-card');
      if(!card){
        const pageRealm=currentRealm();
        try{
          if(S.data&&(pageRealm==null||Number(S.data.realm)===pageRealm))renderBalance();
          else {S.collapsed=true;renderBalance();setTimeout(()=>load(pageRealm),0);}
          schedulePosition();
        }catch{}
        return;
      }
    });
    S.observer.observe(document.documentElement,{childList:true,subtree:true});
    // start() can run again (DOMContentLoaded + readyState race); never stack listeners/timers.
    if(!S.posHooks){S.posHooks=true;window.addEventListener('resize',()=>{schedulePosition();},{passive:true});setInterval(()=>{if(!document.hidden)schedulePosition();},8000);}
  };
  if(document.readyState!=='loading')start();else document.addEventListener('DOMContentLoaded',start,{once:true});
  window.addEventListener('pageshow',()=>{setTimeout(load,600);setTimeout(load,1800);});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){setTimeout(load,350);}});
  // Mobile CPU: SPA route changes come from the Navigation API (+popstate); the URL poll is now
  // only a slow, visible-tab safety net (3 s without the Navigation API, 10 s with it).
  let last=location.href;const onRouteChange=()=>{if(location.href!==last){last=location.href;route();setTimeout(load,500);}};
  const nav=window.navigation;let hasNavApi=false;
  try{if(nav&&typeof nav.addEventListener==='function'){nav.addEventListener('currententrychange',()=>setTimeout(onRouteChange,0));nav.addEventListener('navigatesuccess',()=>setTimeout(onRouteChange,0));hasNavApi=true;}}catch{}
  window.addEventListener('popstate',()=>setTimeout(onRouteChange,0));
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)onRouteChange();});
  setInterval(()=>{if(!document.hidden)onRouteChange();},hasNavApi?10000:3000);
})();

// Every content.js listener above is now attached; release page-hook.js's queued events.
// postMessage is delivered asynchronously, so the flush always arrives after all listeners exist.
try { globalThis.__scmPageBridge.handoff(); globalThis.__scmPageBridge.send({ source:'SIMCO_MANAGER', type:'INITIALIZED' }); } catch {}
