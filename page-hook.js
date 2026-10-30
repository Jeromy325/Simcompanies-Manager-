(() => {
  if (window.__SCM_PAGE_HOOK__) return;
  window.__SCM_PAGE_HOOK__ = true;

  const isApi = (url) => {
    try {
      const u = new URL(url, location.href);
      return u.origin === location.origin && u.pathname.startsWith('/api/');
    } catch { return false; }
  };

  // v2.5.326 bridge event queue. window.postMessage is fire-and-forget: anything posted before
  // content.js has attached its listener (both scripts start at document_start, in either order, and
  // mobile Chromium can start the isolated world late) is lost. Intercepted network events are
  // therefore held here, in order, until content.js sends an 'INITIALIZED' handshake; then the queue
  // is flushed and later events are posted directly. Replies to content.js requests are never queued
  // (content.js is necessarily listening when it asks). If no handshake arrives within
  // BRIDGE_FALLBACK_FLUSH_MS the queue is flushed anyway, so behaviour is never worse than before.
  const BRIDGE_IMMEDIATE_TYPES = new Set(['HOOK_READY','INITIALIZED_ACK','BRIDGE_QUEUE_FLUSHED','API_RESULT','NETWORK_CAPTURE_CONTROL_ACK','JAVASCRIPT_DIAGNOSTIC','DOM_RUNTIME_DIAGNOSTIC_RESULT','REDUX_STATE_DIAGNOSTIC_RESULT','SYNC_REALM_SET','SYNC_REALM_CLEARED','RESOURCE_IMAGE_RESULT']);
  const BRIDGE_QUEUE_MAX = 500;
  const BRIDGE_FALLBACK_FLUSH_MS = 15000;
  const bridgeQueue = [];
  let bridgeInitialized = false, bridgeDropped = 0, bridgeQueuedTotal = 0;
  const post = (type, payload) => {
    window.postMessage({ source: 'SIMCO_MANAGER', type, ...payload }, '*');
  };
  const flushBridgeQueue = () => {
    bridgeInitialized = true;
    let flushed = 0;
    while (bridgeQueue.length) {
      const item = bridgeQueue.shift();
      try { post(item.type, item.payload); flushed++; } catch {}
    }
    return flushed;
  };
  const emit = (type, payload) => {
    if (bridgeInitialized || BRIDGE_IMMEDIATE_TYPES.has(type)) { post(type, payload); return; }
    if (bridgeQueue.length >= BRIDGE_QUEUE_MAX) { bridgeQueue.shift(); bridgeDropped++; }
    bridgeQueue.push({ type, payload });
    bridgeQueuedTotal++;
  };
  setTimeout(() => {
    if (bridgeInitialized) return;
    const flushed = flushBridgeQueue();
    post('BRIDGE_QUEUE_FLUSHED', { reason: 'no-initialized-handshake', flushed, dropped: bridgeDropped, queuedTotal: bridgeQueuedTotal });
  }, BRIDGE_FALLBACK_FLUSH_MS);
  const replay = (type,payload={}) => {
    try { emit('REPLAY_EVENT',{eventType:type,...payload,at:new Date().toISOString(),realm:pageRealm()}); } catch {}
  };

  // Reusable JavaScript/runtime diagnostic collector.
  // This is intentionally generic: it inventories the game's runtime and loaded
  // JavaScript without changing game state or capturing credential values.
  const JS_DIAGNOSTIC_VERSION = '1.1.0';
  const JS_DIAG_TOTAL_TIMEOUT_MS = 24000;
  const JS_DIAG_BUNDLE_TIMEOUT_MS = 4000;
  const JS_DIAG_STORAGE_TIMEOUT_MS = 2500;
  const JS_DIAG_MAX_BUNDLES = 20;
  const JS_DIAG_MAX_BUNDLE_BYTES = 1500000;
  const JS_DIAG_MAX_TOTAL_SOURCE_BYTES = 12000000;
  const JS_DIAG_MAX_EXCERPTS_PER_CATEGORY = 8;
  const JS_DIAG_CATEGORIES = {
    apiRoutes: /\b\/api\/v(?:1|2|3|4)(?:\/[A-Za-z0-9_?=&${}.\-/:]+)?/gi,
    networking: /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/gi,
    storage: /\b(localStorage|sessionStorage|indexedDB|caches|CacheStorage|serviceWorker)\b/gi,
    messaging: /\b(postMessage|MessageChannel|BroadcastChannel|runtime\.sendMessage|tabs\.sendMessage)\b/gi,
    realm: /\b(realm|realmId|selectedRealm|activeRealm|captureRealm)\b/gi,
    market: /\b(market|orderbook|ticker|trade|transaction|price|pricing|vwap|reference.?price)\b/gi,
    resources: /\b(resource|warehouse|inventory|building|production|recipe)\b/gi,
    contracts: /\b(contract|contracts|incoming|outgoing)\b/gi,
    accounting: /\b(accounting|cashflow|balance.?sheet|income.?statement|financial)\b/gi,
    calculation: /\b(calculate|calculation|compute|average|weighted|cost|margin|formula|multiplier)\b/gi,
    featureFlags: /\b(feature.?flag|featureFlags|experiment|config|configuration|settings)\b/gi
  };

  const jsDiagTextHash = async (text) => {
    try {
      const bytes = new TextEncoder().encode(String(text || ''));
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
    } catch { return null; }
  };

  const jsDiagExcerpt = (text, index, radius=180) => {
    const start=Math.max(0,index-radius), end=Math.min(String(text).length,index+radius);
    return String(text).slice(start,end).replace(/\s+/g,' ').trim();
  };

  const jsDiagMatches = (text, rx, max=JS_DIAG_MAX_EXCERPTS_PER_CATEGORY) => {
    const out=[], source=String(text||'');
    rx.lastIndex=0;
    let m;
    while(out.length<max && (m=rx.exec(source))){
      const value=String(m[0]||'');
      out.push({match:value,offset:m.index,context:jsDiagExcerpt(source,m.index)});
      if(!value && rx.lastIndex===m.index) rx.lastIndex++;
    }
    rx.lastIndex=0;
    return out;
  };

  const jsDiagUnique = (values) => [...new Set((Array.isArray(values)?values:[]).map(v=>String(v||'').trim()).filter(Boolean))];

  const jsDiagDeadline = (startedAt) => performance.now() - startedAt >= JS_DIAG_TOTAL_TIMEOUT_MS;
  const jsDiagTimed = async (promise, timeoutMs, label) => {
    let timer=null;
    try{
      return await Promise.race([
        Promise.resolve(promise),
        new Promise((_,reject)=>{
          timer=setTimeout(()=>reject(new Error(`${label} timed out after ${timeoutMs}ms`)),timeoutMs);
        })
      ]);
    }finally{
      if(timer)clearTimeout(timer);
    }
  };

  const collectJsRuntimeDiagnostic = async () => {
    const startedAt=performance.now();
    const now=new Date().toISOString();
    const realm=pageRealm();
    const pageUrl=String(location.href);
    const scripts=[...document.scripts].map(s=>String(s.src||'')).filter(Boolean);
    const performanceResources=[...performance.getEntriesByType('resource')].map(e=>({
      name:String(e.name||''),
      initiatorType:String(e.initiatorType||''),
      duration:Number.isFinite(e.duration)?Math.round(e.duration*100)/100:null,
      transferSize:Number.isFinite(e.transferSize)?e.transferSize:null,
      encodedBodySize:Number.isFinite(e.encodedBodySize)?e.encodedBodySize:null,
      decodedBodySize:Number.isFinite(e.decodedBodySize)?e.decodedBodySize:null,
      startTime:Number.isFinite(e.startTime)?Math.round(e.startTime*100)/100:null,
      nextHopProtocol:String(e.nextHopProtocol||'')||null
    })).filter(e=>e.name);
    const scriptResources=performanceResources.filter(e=>e.initiatorType==='script'||/\.m?js(?:[?#]|$)/i.test(e.name));
    const bundleUrls=jsDiagUnique([
      ...scripts,
      ...scriptResources.map(e=>e.name)
    ]).filter(url=>/^https?:/i.test(url));

    const bundles=[];
    const discoveredRoutes=new Set();
    const discoveredSymbols=new Set();
    const categoryHits={};
    let totalSourceBytes=0;
    for(const url of bundleUrls.slice(0,JS_DIAG_MAX_BUNDLES)){
      if(totalSourceBytes>=JS_DIAG_MAX_TOTAL_SOURCE_BYTES)break;
      const meta=scriptResources.find(e=>e.name===url)||null;
      const record={url,origin:null,pathname:null,resourceType:'script',transferSize:meta?.transferSize??null,encodedBodySize:meta?.encodedBodySize??null,decodedBodySize:meta?.decodedBodySize??null,duration:meta?.duration??null,hash:null,sourceBytes:null,truncated:false,categories:{}};
      try{
        const u=new URL(url,location.href); record.origin=u.origin; record.pathname=u.pathname;
        if(u.origin!==location.origin){record.skipped='cross-origin';bundles.push(record);continue;}
        if(jsDiagDeadline(startedAt)){
          record.skipped='diagnostic-deadline';
          bundles.push(record);
          break;
        }
        const remainingMs=Math.max(1,JS_DIAG_TOTAL_TIMEOUT_MS-(performance.now()-startedAt));
        const bundleTimeoutMs=Math.min(JS_DIAG_BUNDLE_TIMEOUT_MS,remainingMs);
        const controller=new AbortController();
        const timeout=setTimeout(()=>controller.abort(),bundleTimeoutMs);
        let response;
        try{
          response=await fetch(u.href,{credentials:'include',cache:'force-cache',signal:controller.signal});
        }finally{
          clearTimeout(timeout);
        }
        if(!response.ok){record.skipped=`http-${response.status}`;bundles.push(record);continue;}
        const text=await jsDiagTimed(response.text(),Math.min(JS_DIAG_BUNDLE_TIMEOUT_MS,Math.max(1,JS_DIAG_TOTAL_TIMEOUT_MS-(performance.now()-startedAt))),`Bundle body read ${u.pathname}`);
        record.sourceBytes=text.length;
        record.hash=await jsDiagTextHash(text);
        const usable=text.slice(0,Math.min(text.length,JS_DIAG_MAX_BUNDLE_BYTES,JS_DIAG_MAX_TOTAL_SOURCE_BYTES-totalSourceBytes));
        totalSourceBytes+=usable.length;
        record.truncated=usable.length<text.length;
        for(const [category,rx] of Object.entries(JS_DIAG_CATEGORIES)){
          const hits=jsDiagMatches(usable,rx);
          if(hits.length){
            record.categories[category]=hits;
            if(!categoryHits[category])categoryHits[category]=[];
            for(const h of hits.slice(0,4)){
              categoryHits[category].push({bundle:url,match:h.match,context:h.context,offset:h.offset});
            }
          }
        }
        const symbolRx=/\b(?:function|class)\s+([A-Za-z_$][\w$]*)/g;
        let sm;
        while(discoveredSymbols.size<200 && (sm=symbolRx.exec(usable)))discoveredSymbols.add(sm[1]);
        const routeRx=/["'`]((?:\/api\/v[1-4]\/)[^"'`\s\\]{1,240})["'`]/g;
        let rm;
        while((rm=routeRx.exec(usable)) && discoveredRoutes.size<500)discoveredRoutes.add(rm[1]);
      }catch(error){record.error=String(error?.message||error);}
      bundles.push(record);
    }

    const storage={localStorageKeys:[],sessionStorageKeys:[]};
    try{storage.localStorageKeys=Object.keys(localStorage).sort();}catch(error){storage.localStorageError=String(error?.message||error);}
    try{storage.sessionStorageKeys=Object.keys(sessionStorage).sort();}catch(error){storage.sessionStorageError=String(error?.message||error);}

    const indexedDbInfo=[];
    try{
      if(jsDiagDeadline(startedAt)) throw new Error('diagnostic deadline reached before IndexedDB inspection');
      if(window.indexedDB?.databases){
        const dbs=await jsDiagTimed(window.indexedDB.databases(),JS_DIAG_STORAGE_TIMEOUT_MS,'IndexedDB inspection');
        for(const db of Array.isArray(dbs)?dbs:[])indexedDbInfo.push({name:String(db?.name||''),version:Number(db?.version)||null});
      }
    }catch(error){indexedDbInfo.push({error:String(error?.message||error)});}

    const cachesInfo={names:[]};
    try{
      if(jsDiagDeadline(startedAt)) throw new Error('diagnostic deadline reached before CacheStorage inspection');
      if(window.caches){cachesInfo.names=(await jsDiagTimed(caches.keys(),JS_DIAG_STORAGE_TIMEOUT_MS,'CacheStorage inspection')).map(String).sort();}
    }catch(error){cachesInfo.error=String(error?.message||error);}

    const serviceWorkers=[];
    try{
      if(jsDiagDeadline(startedAt)) throw new Error('diagnostic deadline reached before service-worker inspection');
      if(navigator.serviceWorker){
        const regs=await jsDiagTimed(navigator.serviceWorker.getRegistrations(),JS_DIAG_STORAGE_TIMEOUT_MS,'Service-worker inspection');
        for(const r of regs)serviceWorkers.push({
          scope:String(r.scope||''),
          active:r.active?{scriptURL:String(r.active.scriptURL||''),state:String(r.active.state||'')} : null,
          waiting:r.waiting?{scriptURL:String(r.waiting.scriptURL||''),state:String(r.waiting.state||'')} : null,
          installing:r.installing?{scriptURL:String(r.installing.scriptURL||''),state:String(r.installing.state||'')} : null
        });
      }
    }catch(error){serviceWorkers.push({error:String(error?.message||error)});}

    const globalKeys=[];
    try{
      const interesting=/(?:simcompanies|simco|scm|game|app|store|state|market|resource|warehouse|building|production|accounting|contract|api|config|realm)/i;
      for(const key of Object.getOwnPropertyNames(window).filter(k=>interesting.test(k)).sort().slice(0,300)){
        let type='unknown';
        try{type=typeof window[key];}catch{}
        globalKeys.push({name:key,type});
      }
    }catch(error){globalKeys.push({error:String(error?.message||error)});}

    const relevantPerformance=performanceResources.filter(e=>/\/api\/|\.m?js(?:[?#]|$)|worker|serviceworker/i.test(e.name));
    const runtime={
      userAgent:String(navigator.userAgent||''),
      language:String(navigator.language||''),
      platform:String(navigator.platform||''),
      pageUrl,
      origin:String(location.origin||''),
      pathname:String(location.pathname||''),
      readyState:String(document.readyState||''),
      visibility:String(document.visibilityState||''),
      realm:Number.isFinite(Number(realm))?Number(realm):null,
      title:String(document.title||''),
      scriptTagCount:scripts.length,
      performanceResourceCount:performanceResources.length,
      relevantPerformanceCount:relevantPerformance.length,
      online:navigator.onLine===true,
      serviceWorkerController:navigator.serviceWorker?.controller?String(navigator.serviceWorker.controller.scriptURL||''):null
    };

    return {
      diagnosticSchemaVersion:1,
      javascriptDiagnosticVersion:JS_DIAGNOSTIC_VERSION,
      capturedAt:now,
      durationMs:Math.round((performance.now()-startedAt)*100)/100,
      runtime,
      bundles,
      performanceResources:relevantPerformance.slice(-500),
      discoveredApiRoutes:[...discoveredRoutes].sort(),
      discoveredSymbols:[...discoveredSymbols].sort(),
      categoryHits:Object.fromEntries(Object.entries(categoryHits).map(([k,v])=>[k,v.slice(0,60)])),
      storage,
      indexedDB:indexedDbInfo,
      caches:cachesInfo,
      serviceWorkers,
      globalKeys,
      limits:{
        maxBundles:JS_DIAG_MAX_BUNDLES,
        maxBundleBytes:JS_DIAG_MAX_BUNDLE_BYTES,
        maxTotalSourceBytes:JS_DIAG_MAX_TOTAL_SOURCE_BYTES,
        totalTimeoutMs:JS_DIAG_TOTAL_TIMEOUT_MS,
        bundleTimeoutMs:JS_DIAG_BUNDLE_TIMEOUT_MS,
        storageTimeoutMs:JS_DIAG_STORAGE_TIMEOUT_MS,
        note:'Bundle source is not exported; only metadata, hashes, discovered routes/symbols, and contextual excerpts are retained. Individual bundle and runtime-storage inspections are bounded so the diagnostic returns partial results instead of waiting indefinitely.'
      }
    };
  };

  const imageDataCache = new Map();
  const imageCapture = async (url) => {
    if (!url) return null;
    if (/^data:image\//i.test(url)) return url;
    if (imageDataCache.has(url)) return imageDataCache.get(url);
    try {
      let raw=String(url).trim();
      if(/^images\/resources\//i.test(raw)) raw='/static/'+raw;
      else if(/^\/images\/resources\//i.test(raw)) raw='/static'+raw;
      const response = await fetch(new URL(raw, location.href).href, {credentials:'include', cache:'force-cache'});
      if (!response.ok) return null;
      const blob = await response.blob();
      if (!blob.type.startsWith('image/')) return null;
      const data = await new Promise(resolve => { const r=new FileReader(); r.onload=()=>resolve(r.result); r.onerror=()=>resolve(null); r.readAsDataURL(blob); });
      if (data) imageDataCache.set(url,data);
      return data;
    } catch { return null; }
  };
  let catalogCaptureBusy=false;
  // P4: the catalog (up to ~2 MB of base64 images) is posted only when what it would contain changes:
  // the sorted resource ids that have an image plus the constants count/size. Explicit requests force it.
  let lastResourceCatalogSignature='';

  async function emitResourceCatalog(force = false) {
    try {
      const raw = localStorage.getItem('SimcompaniesConstantsData');
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      const constants = parsed?.constantsResources || {};
      if (!constants || typeof constants !== 'object') return false;
      const resourceImages = {};
      const resourceNames = {};

      // Current Sim Companies constants are keyed by the numeric resource id and
      // normally contain an `image` path such as images/resources/<file>.png.
      // Keep that direct mapping instead of relying only on recursive discovery.
      for (const [key, value] of Object.entries(constants)) {
        if (!value || typeof value !== 'object') continue;
        const id = Number(value.resourceId ?? value.productId ?? value.kind ?? value.id ?? value.dbLetter ?? key);
        if (!Number.isFinite(id) || id <= 0) continue;
        const image = value.image ?? value.icon ?? value.iconUrl ?? value.imageUrl ?? value.picture ?? value.img;
        const name = value.name ?? value.resourceName ?? value.displayName ?? value.title ?? value.label ?? value.enName ?? value.englishName;
        if (image) resourceImages[String(id)] = image;
        if (name) resourceNames[String(id)] = name;
      }

      const visit = (v, inheritedId = null) => {
        if (!v || typeof v !== 'object') return;
        if (Array.isArray(v)) { v.forEach(x => visit(x, inheritedId)); return; }
        const id = Number(inheritedId ?? v.resourceId ?? v.productId ?? v.kind ?? v.id ?? v.dbLetter);
        const image = v.image ?? v.icon ?? v.iconUrl ?? v.imageUrl ?? v.picture ?? v.img;
        const name = v.name ?? v.resourceName ?? v.displayName ?? v.title ?? v.label ?? v.enName ?? v.englishName;
        if (Number.isFinite(id) && id > 0) {
          if (image) resourceImages[String(id)] = image;
          if (name) resourceNames[String(id)] = name;
        }
        Object.entries(v).forEach(([k,x]) => visit(x, /^\d+$/.test(k) ? Number(k) : inheritedId));
      };
      visit(constants);

      // The game itself renders the authoritative artwork using
      // /static/images/resources/... . Capture those URLs and match them back to
      // constantsResources. This handles hashed asset URLs even when the constants
      // object is loaded after our hook starts.
      const normalizeImage = (src) => {
        try {
          const u = new URL(src, location.href);
          let path = u.pathname.replace(/^\/static\//, '');
          path = path.replace(/\.[0-9a-f]{6,}\.(png|jpg|jpeg|gif|svg|webp)$/i, '.$1');
          return path;
        } catch { return String(src || '').replace(/^\/static\//, ''); }
      };
      const constantByImage = new Map();
      for (const [key, value] of Object.entries(constants)) {
        if (!value || typeof value !== 'object' || !value.image) continue;
        const id = Number(value.resourceId ?? value.productId ?? value.kind ?? value.id ?? value.dbLetter ?? key);
        if (!Number.isFinite(id) || id <= 0) continue;
        constantByImage.set(normalizeImage(value.image), String(id));
      }
      const normalizeName = (v) => String(v || '').toLowerCase().replace(/&amp;/g,'&').replace(/[^a-z0-9]+/g,' ').trim();
      const nameToId = new Map();
      Object.entries(resourceNames).forEach(([id,name]) => { const n=normalizeName(name); if(n) nameToId.set(n,String(id)); });
      // Match rendered game artwork to the resource using the strongest signals available:
      // resource id/data attributes or resource links first, then image labels/text.
      document.querySelectorAll('img').forEach(img => {
        const src = img.currentSrc || img.getAttribute('src') || '';
        if (!src) return;
        const looksLikeResourceImage = /(?:\/static\/)?images\/resources\//i.test(src);
        if (!looksLikeResourceImage && ![...constantByImage.keys()].some(k=>String(k).split('/').pop() && normalizeImage(src).endsWith(String(k).split('/').pop()))) return;
        const normalized = normalizeImage(src);
        const directId = constantByImage.get(normalized);
        if (directId) { resourceImages[directId] = src; return; }

        let id = null;
        let node = img;
        for(let depth=0; node && depth<6; depth++, node=node.parentElement){
          const attrs=['data-resource-id','data-resource','data-kind','data-product-id','data-product','data-resourceid','data-kind-id'];
          for(const a of attrs){ const v=node.getAttribute?.(a); if(v!=null){ const n=Number(v); if(Number.isFinite(n)&&n>0){id=String(n);break;} } }
          if(id) break;
          const href=node.getAttribute?.('href')||'';
          const hm=href.match(/\/resource(?:s)?\/(\d+)(?:\/|$)/i);
          if(hm){id=hm[1];break;}
          const textAttrs=[node.getAttribute?.('aria-label'),node.getAttribute?.('title')];
          for(const label of textAttrs){ const hit=nameToId.get(normalizeName(label)); if(hit){id=hit;break;} }
          if(id) break;
        }
        if(!id){
          const labels=[img.getAttribute('alt'),img.getAttribute('title'),img.getAttribute('aria-label')];
          for (const label of labels) { const hit=nameToId.get(normalizeName(label)); if(hit){id=hit;break;} }
        }
        if(!id){
          const parent=img.parentElement;
          const text=parent ? normalizeName(parent.textContent || '') : '';
          for(const [name,cid] of nameToId){ if(name && text.includes(name)){id=cid;break;} }
        }
        if(id) resourceImages[id] = src;
      });

      // Some pages use background-image instead of <img>. If the element or one of
      // its ancestors identifies a resource, capture that asset too.
      document.querySelectorAll('[data-resource-id],[data-resource],[data-kind],[data-product-id],[href*="/resource/"]').forEach(node=>{
        const bg=node instanceof HTMLElement ? getComputedStyle(node).backgroundImage : '';
        const m=String(bg||'').match(/url\(["']?(.*?)["']?\)/i); if(!m) return;
        const src=m[1]; if(!/(?:\/static\/)?images\/resources\//i.test(src)) return;
        let id=null;
        for(const a of ['data-resource-id','data-resource','data-kind','data-product-id']){const n=Number(node.getAttribute?.(a));if(Number.isFinite(n)&&n>0){id=String(n);break;}}
        if(!id){const hm=(node.getAttribute?.('href')||'').match(/\/resource(?:s)?\/(\d+)(?:\/|$)/i);if(hm)id=hm[1];}
        if(id) resourceImages[id]=src;
      });

      // The game may load resource artwork before the relevant DOM card exists.
      // Match the browser's already-loaded image URLs against the constants catalog
      // so the mapping survives React page transitions and lazy rendering.
      try {
        const perf = performance.getEntriesByType('resource') || [];
        for (const entry of perf) {
          const src = entry?.name || '';
          if (!src || !/images\/resources\//i.test(src)) continue;
          const normalized = normalizeImage(src);
          const directId = constantByImage.get(normalized);
          if (directId) resourceImages[directId] = src;
          else {
            const base = normalized.split('/').pop();
            if (!base) continue;
            for (const [imgPath, id] of constantByImage.entries()) {
              if (String(imgPath).split('/').pop() === base) { resourceImages[id] = src; break; }
            }
          }
        }
      } catch {}

      const catalogSignature = `${Object.keys(constants).length}|${raw.length}|${Object.keys(resourceImages).sort((a,b)=>Number(a)-Number(b)).join(',')}`;
      if (force !== true && catalogSignature === lastResourceCatalogSignature) return false;
      let imagesCaptured = false;
      if(!catalogCaptureBusy){
        catalogCaptureBusy=true;imagesCaptured=true;
        try{
          const ids=Object.keys(resourceImages).slice(0,80);
          const captured=await Promise.all(ids.map(async id=>[id,await imageCapture(resourceImages[id])]));
          for(const [id,data] of captured) if(data) resourceImages[id]=data;
        } finally { catalogCaptureBusy=false; }
      }

      emit('RESOURCE_CATALOG', {
        catalog: { constantsResources: constants, resourceImages, resourceNames, data: parsed?.data || null },
        receivedAt: new Date().toISOString()
      });
      // Only a pass that also captured the image data counts as delivered.
      if (imagesCaptured) lastResourceCatalogSignature = catalogSignature;
      return true;
    } catch { return false; }
  }

  function resourceImagePath(resourceId) {
    try {
      const raw = localStorage.getItem('SimcompaniesConstantsData');
      const parsed = raw ? JSON.parse(raw) : null;
      const constants = parsed?.constantsResources || {};
      const wanted = Number(resourceId);
      let direct = null;
      const find = (v, inheritedId=null) => {
        if (!v || typeof v !== 'object') return;
        if (Array.isArray(v)) { for (const x of v) find(x,inheritedId); return; }
        const id = Number(inheritedId ?? v.resourceId ?? v.productId ?? v.kind ?? v.id ?? v.dbLetter);
        const image = v.image ?? v.icon ?? v.iconUrl ?? v.imageUrl ?? v.picture ?? v.img;
        if (Number.isFinite(id) && id===wanted && image && !direct) direct=String(image);
        for (const [k,x] of Object.entries(v)) find(x,/^\d+$/.test(k)?Number(k):inheritedId);
      };
      find(constants);
      const normalize = (src) => {
        try { return new URL(src, location.href).pathname.replace(/^\/static\//,'').replace(/\.[0-9a-f]{6,}\.(png|jpg|jpeg|gif|svg|webp)$/i, '.$1'); }
        catch { return String(src||'').replace(/^\/static\//,''); }
      };
      // If constants use a different object shape, match any rendered resource
      // image against the resource's known image path.
      let target='';
      const findTargetImage = (v, inheritedId=null) => {
        if (target || !v || typeof v!=='object') return;
        if (Array.isArray(v)) { for (const x of v) findTargetImage(x, inheritedId); return; }
        const id=Number(inheritedId ?? v.resourceId ?? v.productId ?? v.kind ?? v.id ?? v.dbLetter);
        const image=v.image ?? v.icon ?? v.iconUrl ?? v.imageUrl ?? v.picture ?? v.img;
        if (Number.isFinite(id) && id===wanted && image) { target=normalize(image); return; }
        for (const [k,x] of Object.entries(v)) findTargetImage(x,/^\d+$/.test(k)?Number(k):inheritedId);
      };
      findTargetImage(constants);
      if (target) {
        const img=[...document.querySelectorAll('img[src*="/static/images/resources/"]')].find(el=>normalize(el.currentSrc||el.src||el.getAttribute('src'))===target);
        if(img)return img.currentSrc||img.src||img.getAttribute('src');
      }
      const targetName = (() => {
        let found=null;
        const walk=(v,inheritedId=null)=>{
          if(!v||typeof v!=='object'||found)return;
          if(Array.isArray(v)){v.forEach(x=>walk(x,inheritedId));return;}
          const id=Number(inheritedId ?? v.resourceId ?? v.productId ?? v.kind ?? v.id ?? v.dbLetter);
          const name=v.name ?? v.resourceName ?? v.displayName ?? v.title ?? v.label ?? v.enName ?? v.englishName;
          if(Number.isFinite(id)&&id===wanted&&name) found=String(name);
          Object.entries(v).forEach(([k,x])=>walk(x,/^\d+$/.test(k)?Number(k):inheritedId));
        }; walk(constants); return found;
      })();
      const rendered=[...document.querySelectorAll('img')].filter(img=>{
        const src=img.currentSrc||img.src||img.getAttribute('src')||'';
        return /(?:\/static\/)?images\/resources\//i.test(src);
      });
      if(targetName){
        const nn=targetName.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
        const hit=rendered.find(img=>{
          const labels=[img.alt,img.title,img.getAttribute('aria-label')].map(x=>String(x||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim());
          return labels.includes(nn) || labels.some(x=>x&&x.includes(nn));
        });
        if(hit)return hit.currentSrc||hit.src||hit.getAttribute('src');
      }
      if(direct) return direct;
      return rendered.length===1 ? (rendered[0].currentSrc||rendered[0].src||rendered[0].getAttribute('src')) : null;
    } catch { return null; }
  }

  async function emitResourceImage(resourceId) {
    const id = Number(resourceId);
    if (!Number.isFinite(id) || id <= 0) return;
    try {
      let src = resourceImagePath(id);
      if (!src) {
        const raw = localStorage.getItem('SimcompaniesConstantsData');
        const parsed = raw ? JSON.parse(raw) : null;
        const root = parsed?.constantsResources || {};
        const direct = root?.[String(id)] || root?.[id];
        if (direct && typeof direct === 'object') src = direct.image || direct.icon || direct.iconUrl || direct.imageUrl || direct.picture || direct.img || null;
        if (!src) {
          const walk = (v, inheritedId=null) => {
            if (src || !v || typeof v!=='object') return;
            if (Array.isArray(v)) { for (const x of v) walk(x,inheritedId); return; }
            const rid=Number(inheritedId ?? v.resourceId ?? v.productId ?? v.kind ?? v.id ?? v.dbLetter);
            const image=v.image ?? v.icon ?? v.iconUrl ?? v.imageUrl ?? v.picture ?? v.img;
            if (Number.isFinite(rid) && rid===id && image) { src=String(image); return; }
            for (const [k,x] of Object.entries(v)) walk(x,/^\d+$/.test(k)?Number(k):inheritedId);
          };
          walk(root);
        }
      }
      if (!src) { emit('RESOURCE_IMAGE_RESULT', { resource:id, error:'No resource image path found.' }); return; }
      const url = new URL(String(src), location.href);
      if (!url.pathname.startsWith('/static/')) url.pathname = '/static/' + url.pathname.replace(/^\//,'');
      const response = await fetch(url.href, { credentials:'include', cache:'force-cache' });
      if (!response.ok) throw new Error(`Image HTTP ${response.status}`);
      const blob = await response.blob();
      const reader = new FileReader();
      reader.onload = () => emit('RESOURCE_IMAGE_RESULT', { resource:id, dataUrl:reader.result });
      reader.onerror = () => emit('RESOURCE_IMAGE_RESULT', { resource:id, error:'Could not convert image.' });
      reader.readAsDataURL(blob);
    } catch (e) {
      emit('RESOURCE_IMAGE_RESULT', { resource:id, error:e?.message || String(e) });
    }
  }

  let lastGameStateFingerprint = '';
  let lastKnownRealm = null;
  let forcedCaptureRealm = null;
  let forcedCaptureRealmUntil = 0;
  let startupSwitchRealm = null;
  try {
    const raw = sessionStorage.getItem('SCM_SYNC_REALM');
    const saved = raw ? JSON.parse(raw) : null;
    if (saved && Number.isFinite(Number(saved.realm)) && Number(saved.until) > Date.now()) {
      forcedCaptureRealm = Number(saved.realm);
      forcedCaptureRealmUntil = Number(saved.until);
      // v2.5.345 the game reloads the page after a confirmed realm switch: that realm is this page's realm.
      if (saved.source === 'switch' && (forcedCaptureRealm === 0 || forcedCaptureRealm === 1)) { lastKnownRealm = forcedCaptureRealm; startupSwitchRealm = forcedCaptureRealm; }
    }
  } catch {}
  function realmFromAuthData(data) {
    const candidates=[data?.authCompany?.realmId,data?.authCompany?.realm,data?.realmId,data?.realm,data?.company?.realmId,data?.company?.realm];
    for(const v of candidates){const n=Number(v);if(Number.isFinite(n))return n;}
    return null;
  }
  // v2.5.345 the game requests auth-data, buildings and the warehouse in parallel on load, and the realm is not
  // in the URL. Responses to requests started before this page knew its realm were tagged with no realm and the
  // Manager filed them under the last-synced realm (R1 buildings/warehouse in the R2 store). They are now held
  // here until auth-data proves the session's realm, then sent with that realm. A realm switch reloads the page,
  // so held responses can only belong to the realm auth-data reports; on a switch they are dropped (old realm unknown).
  const realmPending = [];
  const REALM_PENDING_MAX = 300;
  const learnRealm = (r, reason) => {
    if (r !== 0 && r !== 1) return;
    lastKnownRealm = r;
    // A Sync boundary for the other realm is wrong for this session: never tag game traffic with it.
    if ((forcedCaptureRealm === 0 || forcedCaptureRealm === 1) && forcedCaptureRealm !== r) {
      forcedCaptureRealm = null; forcedCaptureRealmUntil = 0;
      try { sessionStorage.removeItem('SCM_SYNC_REALM'); } catch {}
    }
    emit('PAGE_REALM', { realm: r, reason });
    while (realmPending.length) {
      const item = realmPending.shift();
      try { emit(item.type, { ...item.payload, captureRealm: r, realmResolvedBy: reason }); } catch {}
    }
  };
  const emitRealmScoped = (type, payload) => {
    if (payload.captureRealm === 0 || payload.captureRealm === 1) { emit(type, payload); return; }
    if (lastKnownRealm === 0 || lastKnownRealm === 1) { emit(type, { ...payload, captureRealm: lastKnownRealm, realmResolvedBy: 'known-at-response' }); return; }
    if (realmPending.length >= REALM_PENDING_MAX) realmPending.shift();
    realmPending.push({ type, payload });
  };
  let gameStateRawByRealm = new Map();
  let gameStateEmitScheduled = false;
  const scheduleGameStateEmit = (delayMs=50) => {
    if (gameStateEmitScheduled) return;
    gameStateEmitScheduled = true;
    setTimeout(() => {
      gameStateEmitScheduled = false;
      try { emitGameState(); } catch {}
    }, Math.max(0, Number(delayMs) || 0));
  };
  function emitGameState() {
    try {
      let realm = null;
      if ((forcedCaptureRealm === 0 || forcedCaptureRealm === 1) && Date.now() < forcedCaptureRealmUntil) {
        realm = forcedCaptureRealm;
      } else {
        const m = location.pathname.match(/\/rc\/(\d+)\//);
        if (m) realm = Number(m[1]);
      }
      // Never guess the other realm. If the URL/explicit Sync boundary does
      // not identify a realm, only use the realm already learned from this tab.
      const candidates = Number.isFinite(realm) && (realm === 0 || realm === 1)
        ? [realm]
        : (Number.isFinite(lastKnownRealm) ? [lastKnownRealm] : []);
      let parsed = null, usedRealm = null;
      for (const r of candidates) {
        const raw = localStorage.getItem(`SimcompaniesRetailCalculation_${r}`);
        if (!raw) continue;
        const previousRaw = gameStateRawByRealm.get(r);
        if (previousRaw === raw) {
          lastKnownRealm = r;
          return true;
        }
        try {
          const obj = JSON.parse(raw);
          if (obj && typeof obj === 'object') { parsed = obj; usedRealm = r; break; }
        } catch {}
      }
      if (!parsed) return false;
      lastKnownRealm = usedRealm;
      try { gameStateRawByRealm.set(usedRealm, localStorage.getItem(`SimcompaniesRetailCalculation_${usedRealm}`)); } catch {}
      const payload = {
        realm: usedRealm,
        warehouseResources: Array.isArray(parsed.warehouseResources) ? parsed.warehouseResources : null,
        buildings: Array.isArray(parsed.buildings) ? parsed.buildings : null,
        region: parsed
      };
      const fingerprint = JSON.stringify({
        realm: payload.realm,
        warehouse: payload.warehouseResources,
        buildings: payload.buildings,
        administration: parsed.administration,
        academyActive: parsed.academyActive
      });
      if (fingerprint === lastGameStateFingerprint) return true;
      lastGameStateFingerprint = fingerprint;
      emit('GAME_STATE', payload);
      return true;
    } catch { return false; }
  }


    const GAME_STORAGE_VALUE_CAP = 300000;
  const GAME_STORAGE_TOTAL_CAP = 750000;
  // This runs only on the SimCompanies page. Capture the page's non-sensitive
  // localStorage values rather than relying on a narrow prefix allow-list. The
  // previous prefix filter could inventory harmless game keys but capture zero
  // values when SimCompanies changed its client-side key names. The sensitive
  // filter remains mandatory, and the byte/key caps prevent an unbounded dump.
  const GAME_STORAGE_SENSITIVE = /(?:token|auth|cookie|csrf|session|password|secret|jwt|access)/i;
  let lastGameStorageSnapshotFingerprint = '';
  function emitGameLocalStorageSnapshot(reason='scheduled') {
    try {
      const realm = pageRealm();
      if(realm!==0&&realm!==1)return false;
      const allKeys=[]; const keyMeta=[]; const entries={}; const excludedSensitiveKeys=[];
      let totalBytes=0;
      for(let i=0;i<localStorage.length;i++){
        const key=String(localStorage.key(i)||'');
        if(!key)continue;
        allKeys.push(key);
        let raw=''; try{raw=String(localStorage.getItem(key)||'');}catch{raw='';}
        const bytes=raw.length*2;
        const meta={key,sizeBytes:bytes,captured:false};
        if(GAME_STORAGE_SENSITIVE.test(key)){excludedSensitiveKeys.push(key);keyMeta.push(meta);continue;}
        if(bytes>GAME_STORAGE_VALUE_CAP||totalBytes+bytes>GAME_STORAGE_TOTAL_CAP){keyMeta.push(meta);continue;}
        entries[key]=raw; meta.captured=true; keyMeta.push(meta); totalBytes+=bytes;
      }
      allKeys.sort(); keyMeta.sort((a,b)=>a.key.localeCompare(b.key)); excludedSensitiveKeys.sort();
      const parsedEntries={};
      for(const [k,v] of Object.entries(entries)){
        if(Object.keys(parsedEntries).length>=40)break;
        if(String(v).length>120000)continue;
        try{const parsed=JSON.parse(v); if(parsed&&typeof parsed==='object')parsedEntries[k]=parsed;}catch{}
      }
      const payload={schemaVersion:2,realm,capturedAt:new Date().toISOString(),pageUrl:String(location.href||''),reason,allKeys,keyMeta,excludedSensitiveKeys,capturedBytes:totalBytes,entries,parsedEntries,safeCapture:true};
      const fp=JSON.stringify({realm,allKeys,keyMeta,entries});
      if(fp===lastGameStorageSnapshotFingerprint)return true;
      lastGameStorageSnapshotFingerprint=fp;
      emit('GAME_LOCAL_STORAGE_SNAPSHOT',payload);
      return true;
    }catch{return false;}
  }

  function emitMarketCache() {
    try {
      const realmMatch = location.pathname.match(/\/rc\/(\d+)\//);
      const realm = pageRealm();
      // Market localStorage contains keys for both realms. Only emit entries
      // belonging to the current/forced realm so the background never has to
      // receive or classify the other realm's cache.
      if (realm !== 0 && realm !== 1) return false;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i) || '';
        let m = key.match(/^market_all_(\d+)_(\d+)$/);
        if (!m) m = key.match(/^market_(\d+)_(\d+)$/);
        if (!m) continue;
        const r = Number(m[1]), resource = Number(m[2]);
        if (!Number.isFinite(r) || !Number.isFinite(resource) || r !== realm) continue;
        let raw = localStorage.getItem(key), parsed = null;
        try { parsed = JSON.parse(raw); } catch { continue; }
        let data = parsed?.data ?? parsed?.orders ?? parsed?.market ?? parsed;
        if (!Array.isArray(data) && parsed && typeof parsed === 'object') {
          const candidates=[];
          const walk=v=>{
            if(Array.isArray(v)){ if(v.some(x=>x&&typeof x==='object'&&('price' in x||'quality' in x))) candidates.push(v); return; }
            if(v&&typeof v==='object') Object.values(v).forEach(walk);
          };
          walk(parsed); data=candidates.sort((a,b)=>b.length-a.length)[0]||data;
        }
        if (Array.isArray(data)) emit('MARKET_CACHE', { resource, realm: r, data, receivedAt: (parsed && (parsed.timestamp || parsed.receivedAt)) ? new Date(parsed.timestamp || parsed.receivedAt).toISOString() : new Date().toISOString(), cacheKey:key });
      }
      return true;
    } catch { return false; }
  }

  function pageRealm() {
    if (Number.isFinite(forcedCaptureRealm) && forcedCaptureRealmUntil > Date.now()) return forcedCaptureRealm;
    if (forcedCaptureRealmUntil && forcedCaptureRealmUntil <= Date.now()) { forcedCaptureRealm = null; forcedCaptureRealmUntil = 0; try { sessionStorage.removeItem('SCM_SYNC_REALM'); } catch {} }
    try {
      const m = location.pathname.match(/\/rc\/(\d+)\//);
      if (m) return Number(m[1]);
    } catch {}
    return Number.isFinite(lastKnownRealm) ? lastKnownRealm : null;
  }

  const realmSwitchFromUrl = (url) => {
    try {
      const u = new URL(url, location.href);
      const m = u.pathname.match(/^\/api\/v1\/realm\/(0|1)\/(?:switch|sync)\/?$/);
      return m ? Number(m[1]) : null;
    } catch { return null; }
  };

  // A successful realm-switch response is the authoritative browser-side
  // confirmation that the game actually changed realms. The request itself is
  // only intent. Once confirmed, immediately retag subsequent API/state
  // captures with the new realm because the SPA URL may remain unchanged.
  const confirmRealmSwitch = (url, method, response) => {
    try {
      const switchRealm=realmSwitchFromUrl(url);
      if(switchRealm==null || !response?.ok) return null;
      realmPending.length=0; // started in the old realm, whose identity this page never learned
      lastKnownRealm=switchRealm;
      forcedCaptureRealm=switchRealm;
      forcedCaptureRealmUntil=Date.now()+30000;
      try { sessionStorage.setItem('SCM_SYNC_REALM', JSON.stringify({realm:switchRealm,until:forcedCaptureRealmUntil,source:'switch'})); } catch {}
      const u=new URL(url,location.href);
      emit('REALM_SWITCH_CONFIRMED',{realm:switchRealm,url:u.pathname+u.search,method:String(method||'GET').toUpperCase(),status:Number(response.status)||200});
      return switchRealm;
    } catch { return null; }
  };

  const emitSeen = (url, method, captureRealm=null) => {
    try {
      const u = new URL(url, location.href);
      if (u.origin !== location.origin || !u.pathname.startsWith('/api/')) return;
      const normalizedMethod=String(method || 'GET').toUpperCase();
      const switchRealm=realmSwitchFromUrl(url);
      if (switchRealm!=null) emit('REALM_SWITCH', { realm:switchRealm, url:u.pathname + u.search, method:normalizedMethod });
      emit('API_SEEN', { method: normalizedMethod, url: u.pathname + u.search, captureRealm: Number.isFinite(Number(captureRealm)) ? Number(captureRealm) : null });
    } catch {}
  };

  // API_GET requests originate from the extension and are explicitly persisted
  // by the background transaction after the API_RESULT arrives. The fetch/XHR
  // observers must not enqueue duplicate API_SEEN/API_DATA writes for those
  // same requests: under a multi-endpoint sync that multiplies queue depth and
  // lets the observer race the transaction's durable read-back.
  const explicitApiGetCaptures = new Map();
  function explicitApiGetKey(url){
    try {
      const u=new URL(url,location.href);
      if(u.origin!==location.origin||!u.pathname.startsWith('/api/'))return null;
      return `${u.pathname}${u.search}`;
    } catch { return null; }
  }
  function markExplicitApiGetCapture(url){
    const key=explicitApiGetKey(url);
    if(!key)return;
    const now=Date.now();
    const pending=(explicitApiGetCaptures.get(key)||[]).filter(expiresAt=>expiresAt>now);
    pending.push(now+15000);
    explicitApiGetCaptures.set(key,pending);
  }
  function consumeExplicitApiGetCapture(url,method){
    if(String(method||'GET').toUpperCase()!=='GET')return false;
    const key=explicitApiGetKey(url);
    const now=Date.now();
    const pending=key?(explicitApiGetCaptures.get(key)||[]).filter(expiresAt=>expiresAt>now):[];
    if(!key||!pending.length){if(key)explicitApiGetCaptures.delete(key);return false;}
    pending.shift();
    if(pending.length)explicitApiGetCaptures.set(key,pending); else explicitApiGetCaptures.delete(key);
    return true;
  }

  const isStockMutationUrl = (url, method) => {
    try {
      const u = new URL(url, location.href);
      const normalizedMethod = String(method || 'GET').toUpperCase();
      // v2.5.328: any successful game action that can move stock refreshes the warehouse — collecting
      // finished production from buildings, starting production, contracts, exchange buys/sells, retail.
      // Previously only exchange buys (/order/take/) and market orders matched, so collecting resources from
      // a building never updated the Manager. Requests that cannot change stock are excluded.
      if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD' || normalizedMethod === 'OPTIONS') return false;
      if (u.origin !== location.origin || !u.pathname.startsWith('/api/')) return false;
      return !/(?:chat|message|mail|notification|forum|comment|setting|preference|profile|avatar|logo|achievement|tutorial|feedback|report-|analytics|track|log-?in|log-?out|password|session|friend|follow|block|language|theme|executive|training|\/realm\/\d+\/(?:switch|sync))/i.test(u.pathname);
    } catch { return false; }
  };

  // Opt-in bounded recorder for same-origin game traffic. No request headers,
  // cookies, credentials, or request bodies are recorded. API response bodies are capped.
  let networkCaptureEnabled=false, networkCaptureId='', networkCaptureCount=0;
  const NETWORK_CAPTURE_MAX_EVENTS=100000, NETWORK_CAPTURE_MAX_BODY=4000;
  const safeNetworkUrl=(raw)=>{try{const u=new URL(raw,location.href);if(u.origin!==location.origin)return null;for(const k of [...u.searchParams.keys()])if(/token|auth|cookie|csrf|session|password|secret|jwt|access|key/i.test(k))u.searchParams.set(k,'[redacted]');return u.pathname+u.search;}catch{return null;}};
  const networkCaptureEmit=(event)=>{if(!networkCaptureEnabled)return;if(networkCaptureCount>=NETWORK_CAPTURE_MAX_EVENTS){networkCaptureEnabled=false;try{emit('NETWORK_CAPTURE_EVENT',{captureId:networkCaptureId,event:{capturedAt:new Date().toISOString(),realm:pageRealm(),kind:'capture-limit',limit:NETWORK_CAPTURE_MAX_EVENTS,note:'Page recorder stopped at its 100,000-event cap; export this capture and start a new one.'}});}catch{}return;}networkCaptureCount++;try{emit('NETWORK_CAPTURE_EVENT',{captureId:networkCaptureId,event:{capturedAt:new Date().toISOString(),realm:pageRealm(),...event}});}catch{}};
  const captureResponseBody=async(response)=>{try{const type=String(response.headers?.get('content-type')||'');if(!/json|text|javascript|xml/i.test(type))return null;const text=await response.clone().text();if(!text)return null;if(text.length>NETWORK_CAPTURE_MAX_BODY)return {truncated:true,originalLength:text.length,preview:text.slice(0,NETWORK_CAPTURE_MAX_BODY)};try{return JSON.parse(text);}catch{return text;}}catch{return null;}};
  const snapshotResourceTiming=()=>{try{const entries=performance.getEntriesByType('resource').filter(e=>/simcompanies\.com/i.test(e.name)).slice(-300).map(e=>({url:safeNetworkUrl(e.name)||new URL(e.name,location.href).pathname,initiatorType:e.initiatorType,durationMs:Math.round(e.duration*100)/100,transferSize:e.transferSize||0}));networkCaptureEmit({kind:'resource-timing-snapshot',resources:entries});}catch{}};
  const originalFetch = window.fetch;
  window.fetch = async function(input, init) {
    let url = '', method = 'GET', captureRealm = null, explicitManagerApiGet = false;
    try {
      url = typeof input === 'string' ? input : input?.url;
      method = (init?.method || (typeof input !== 'string' && input?.method) || 'GET').toUpperCase();
      captureRealm = pageRealm();
      explicitManagerApiGet = consumeExplicitApiGetCapture(url,method);
      if(!explicitManagerApiGet)emitSeen(url, method, captureRealm);
      replay('network-request',{url:new URL(url,location.href).pathname,method,captureRealm,explicitManagerApiGet});
    } catch {}
    const startedAt=Date.now();
    if(networkCaptureEnabled){const safeUrl=safeNetworkUrl(url);if(safeUrl)networkCaptureEmit({kind:'request-start',transport:'fetch',url:safeUrl,method,startedAt:new Date(startedAt).toISOString()});}
    let response;
    try { response = await originalFetch.apply(this, arguments); } catch(error) {
      if(networkCaptureEnabled){const safeUrl=safeNetworkUrl(url);if(safeUrl)networkCaptureEmit({kind:'request-error',transport:'fetch',url:safeUrl,method,errorName:String(error?.name||'Error'),error:String(error?.message||error).slice(0,500),durationMs:Date.now()-startedAt});}
      throw error;
    }
    replay('network-response',{url:String(url||''),method,status:Number(response?.status)||0,ok:Boolean(response?.ok),captureRealm});
    if(networkCaptureEnabled){const safeUrl=safeNetworkUrl(url);if(safeUrl){const apiUrl=safeUrl.split('?')[0].startsWith('/api/');const body=apiUrl?await captureResponseBody(response):null;networkCaptureEmit({kind:'fetch',url:safeUrl,method,status:Number(response?.status)||0,ok:Boolean(response?.ok),durationMs:Date.now()-startedAt,contentType:String(response.headers?.get('content-type')||''),body});}}
    confirmRealmSwitch(url, method, response);
    if (isStockMutationUrl(url, method)) {
      try {
        const u = new URL(url, location.href);
        if (response.ok) emitRealmScoped('STOCK_MUTATION_COMPLETE', { method, url: u.pathname + u.search, status: response.status, captureRealm });
      } catch {}
    }
    if (!explicitManagerApiGet && isApi(url) && (method === 'GET' || /\/api\/(?:v2|v3)\/.*contracts/i.test(url))) {
      try {
        const clone = response.clone();
        const text = await clone.text();
        if (text && text.length <= 2000000) {
          let data = null;
          try { data = JSON.parse(text); } catch { data = text; }
          const u = new URL(url, location.href);
          const ar = /\/api\/v3\/companies\/auth-data\//.test(u.pathname) && response.ok ? realmFromAuthData(data) : null;
          if (ar === 0 || ar === 1) { emit('API_DATA', { url: u.pathname + u.search, status: response.status, method, data, captureRealm: ar }); learnRealm(ar, 'auth-data'); }
          else emitRealmScoped('API_DATA', { url: u.pathname + u.search, status: response.status, method, data, captureRealm });
        }
      } catch {}
    }
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__scmMethod = String(method || 'GET').toUpperCase();
    this.__scmUrl = url;
    this.__scmStartedAt = Date.now();
    this.__scmCaptureRealm = pageRealm();
    try { emitSeen(url, this.__scmMethod, this.__scmCaptureRealm); replay('network-request',{url:new URL(url,location.href).pathname,method:this.__scmMethod,captureRealm:this.__scmCaptureRealm,transport:'xhr'}); } catch {}
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    if(networkCaptureEnabled){try{const safeUrl=safeNetworkUrl(this.__scmUrl);if(safeUrl)networkCaptureEmit({kind:'request-start',transport:'xhr',url:safeUrl,method:this.__scmMethod,startedAt:new Date(this.__scmStartedAt||Date.now()).toISOString()});}catch{}this.addEventListener('error',()=>{try{const safeUrl=safeNetworkUrl(this.__scmUrl);if(safeUrl)networkCaptureEmit({kind:'request-error',transport:'xhr',url:safeUrl,method:this.__scmMethod,errorName:'NetworkError',error:'XMLHttpRequest error event',durationMs:Date.now()-(this.__scmStartedAt||Date.now())});}catch{}});this.addEventListener('timeout',()=>{try{const safeUrl=safeNetworkUrl(this.__scmUrl);if(safeUrl)networkCaptureEmit({kind:'request-error',transport:'xhr',url:safeUrl,method:this.__scmMethod,errorName:'TimeoutError',error:'XMLHttpRequest timeout event',durationMs:Date.now()-(this.__scmStartedAt||Date.now())});}catch{}});this.addEventListener('load',()=>{try{const safeUrl=safeNetworkUrl(this.__scmUrl);if(!safeUrl)return;const apiUrl=safeUrl.split('?')[0].startsWith('/api/');let body=null;if(apiUrl){const text=String(this.responseText||'');if(text.length>0&&text.length<=NETWORK_CAPTURE_MAX_BODY){try{body=JSON.parse(text);}catch{body=text;}}else if(text.length>NETWORK_CAPTURE_MAX_BODY)body={truncated:true,originalLength:text.length,preview:text.slice(0,NETWORK_CAPTURE_MAX_BODY)};}networkCaptureEmit({kind:'xhr',url:safeUrl,method:this.__scmMethod,status:Number(this.status)||0,ok:this.status>=200&&this.status<300,durationMs:Date.now()-(this.__scmStartedAt||Date.now()),contentType:String(this.getResponseHeader('content-type')||''),body});}catch{}});}
    if (realmSwitchFromUrl(this.__scmUrl)!=null) {
      this.addEventListener('load', () => {
        try { replay('network-response',{url:String(this.__scmUrl||''),method:this.__scmMethod,status:Number(this.status)||0,ok:this.status>=200&&this.status<300,captureRealm:this.__scmCaptureRealm,transport:'xhr'}); confirmRealmSwitch(this.__scmUrl, this.__scmMethod, {ok:this.status>=200&&this.status<300,status:this.status}); } catch {}
      });
    }
    if (isStockMutationUrl(this.__scmUrl, this.__scmMethod)) {
      this.addEventListener('load', () => {
        try {
          const u = new URL(this.__scmUrl, location.href);
          if (this.status >= 200 && this.status < 300) emitRealmScoped('STOCK_MUTATION_COMPLETE', { method: this.__scmMethod, url: u.pathname + u.search, status: this.status, captureRealm: this.__scmCaptureRealm });
        } catch {}
      });
    }
    if (isApi(this.__scmUrl) && (this.__scmMethod === 'GET' || /\/api\/(?:v2|v3)\/.*contracts/i.test(this.__scmUrl))) {
      this.addEventListener('load', () => {
        try {
          let data = null;
          try { data = JSON.parse(this.responseText); } catch { data = this.responseText; }
          const u = new URL(this.__scmUrl, location.href);
          const ar = /\/api\/v3\/companies\/auth-data\//.test(u.pathname) && this.status >= 200 && this.status < 300 ? realmFromAuthData(data) : null;
          if (String(this.responseText || '').length <= 2000000) {
            if (ar === 0 || ar === 1) emit('API_DATA', { url: u.pathname + u.search, status: this.status, method: this.__scmMethod, data, captureRealm: ar });
            else emitRealmScoped('API_DATA', { url: u.pathname + u.search, status: this.status, method: this.__scmMethod, data, captureRealm: this.__scmCaptureRealm });
          }
          if (ar === 0 || ar === 1) learnRealm(ar, 'auth-data');
        } catch {}
      });
    }
    return originalSend.apply(this, arguments);
  };

  // Small, bounded state/runtime probe used by the Manager diagnostic bridge.
  // Unlike chrome.scripting.executeScript, this returns through the page hook that is
  // already communicating with the extension. It reports metadata/path summaries only.
  const collectStateAccessDiagnostic = (requestId) => {
    const startedAt = performance.now();
    const sensitiveKey = /token|auth|cookie|password|secret|credential|session.?id|access.?key|email|phone|address|billing|payment.?method|credit.?card/i;
    const relevantKey = /redux|store|state|building|abundance|resource|production|recipe|level|efficien|modifier|company|warehouse/i;
    const candidates = [], matches = [], seen = new WeakSet();
    let visitedNodes = 0, truncated = false, scannedElements = 0;
    const addCandidate = (path, value, reason) => {
      if (!value || (typeof value !== 'object' && typeof value !== 'function')) return;
      if (candidates.some(item => item.value === value)) return;
      candidates.push({path, value, reason});
    };
    let globalKeys = [];
    try { globalKeys = Object.keys(window).slice(0, 1200); } catch {}
    for (const key of globalKeys) {
      if (!relevantKey.test(key) || sensitiveKey.test(key)) continue;
      try {
        const value = window[key];
        if (value && typeof value === 'object') addCandidate(`window.${key}`, value, /store|redux/i.test(key) ? 'store-like global' : 'relevant global');
        else if (typeof value === 'function' && /store|redux/i.test(key)) addCandidate(`window.${key}`, value, 'store-like function');
      } catch {}
      if (candidates.length >= 40 || performance.now() - startedAt > 350) { truncated = true; break; }
    }
    const fiberRoots = [];
    const rootNodes = [];
    for (const selector of ['#root', '#app', '#__next', '#game', '[data-reactroot]', 'canvas']) {
      try { const node = document.querySelector(selector); if (node && !rootNodes.includes(node)) rootNodes.push(node); } catch {}
    }
    // Scan a small live DOM prefix. Never spread/materialize the full DOM collection.
    try {
      const elements = document.getElementsByTagName('*');
      for (let i = 0; i < elements.length && scannedElements < 250 && performance.now() - startedAt < 600; i++) {
        const el = elements[i]; scannedElements++;
        if (rootNodes.length < 30 && /root|app|game|landscape|canvas/i.test(String(el.id || ''))) rootNodes.push(el);
        let keys=[]; try { keys=Object.keys(el); } catch {}
        for (const key of keys) if (key.startsWith('__reactContainer$') || key.startsWith('__reactFiber$') || key === '_reactRootContainer') {
          try { fiberRoots.push({path:`DOM(${String(el.id || el.tagName).slice(0,60)}).${key}`, value:el[key]}); } catch {}
        }
        if (fiberRoots.length >= 20) break;
      }
    } catch {}
    for (const root of fiberRoots) addCandidate(root.path, root.value, 'React fiber root');
    const candidateSummary = [];
    const componentSnapshots = [];
    let fiberNodesVisited = 0, snapshotNodesVisited = 0;
    const snapshotSeen = new WeakSet();
    const snapshotValue = (value, depth=0) => {
      if (value == null || ['string','number','boolean'].includes(typeof value)) {
        if (typeof value === 'string') return value.slice(0,300);
        return value;
      }
      if (typeof value !== 'object' || depth >= 5 || snapshotNodesVisited >= 2500) return undefined;
      if (snapshotSeen.has(value)) return '[Circular/Repeated]';
      snapshotSeen.add(value); snapshotNodesVisited++;
      if (Array.isArray(value)) return value.slice(0,30).map(item=>snapshotValue(item,depth+1)).filter(item=>item!==undefined);
      const out={}; let keys=[]; try { keys=Object.keys(value).slice(0,80); } catch { return '[Unreadable]'; }
      for (const key of keys) {
        if (sensitiveKey.test(key) || /^(return|child|sibling|alternate|_owner|ref|next|queue|baseQueue|dependencies|stateNode|updateQueue|debugInfo)$/i.test(key)) continue;
        let child; try { child=value[key]; } catch { continue; }
        const safe=snapshotValue(child,depth+1);
        if (safe!==undefined) out[key]=safe;
        if (snapshotNodesVisited>=2500) break;
      }
      return out;
    };
    const componentName = fiber => {
      const type=fiber?.elementType||fiber?.type;
      if (typeof type==='string') return type;
      try { return String(type?.displayName||type?.name||type?.render?.displayName||type?.render?.name||'AnonymousComponent').slice(0,120); } catch { return 'UnknownComponent'; }
    };
    const inspectFiberTree = rootValue => {
      let root=rootValue;
      try { root=rootValue?._internalRoot?.current||rootValue?.current||rootValue; } catch {}
      const stack=[]; if(root&&typeof root==='object')stack.push({fiber:root,depth:0});
      const seenFibers=new WeakSet();
      while(stack.length && fiberNodesVisited<1800 && componentSnapshots.length<180){
        const {fiber,depth}=stack.pop(); if(!fiber||typeof fiber!=='object'||seenFibers.has(fiber)||depth>60)continue;
        seenFibers.add(fiber);fiberNodesVisited++;
        const name=componentName(fiber), props=fiber.memoizedProps, state=fiber.memoizedState;
        let propKeys=[],stateKeys=[];try{propKeys=Object.keys(props||{});}catch{}try{stateKeys=Object.keys(state||{});}catch{}
        const searchable=`${name} ${propKeys.join(' ')} ${stateKeys.join(' ')}`;
        if(relevantKey.test(searchable) && (props||state)){
          componentSnapshots.push({component:name,depth,props:props?snapshotValue(props):null,state:state?snapshotValue(state):null,propsKeys:propKeys.filter(k=>!sensitiveKey.test(k)).slice(0,60),stateKeys:stateKeys.filter(k=>!sensitiveKey.test(k)).slice(0,40)});
        }
        try { if(fiber.sibling)stack.push({fiber:fiber.sibling,depth}); if(fiber.child)stack.push({fiber:fiber.child,depth:depth+1}); } catch {}
      }
    };
    const walk = (value, path, depth) => {
      if (performance.now() - startedAt > 1200 || visitedNodes >= 250 || matches.length >= 300) { truncated = true; return; }
      if (!value || typeof value !== 'object' || seen.has(value) || depth > 5) return;
      seen.add(value); visitedNodes++;
      let keys=[]; try { keys=Object.keys(value).slice(0,60); } catch { return; }
      for (const key of keys) {
        if (sensitiveKey.test(key)) continue;
        let child; try { child=value[key]; } catch { continue; }
        const childPath=`${path}.${key}`;
        if (relevantKey.test(key)) {
          const summary={path:childPath,type:Array.isArray(child)?'array':child===null?'null':typeof child};
          if (Array.isArray(child)) summary.length=child.length;
          else if (child && typeof child==='object') { try { summary.keys=Object.keys(child).filter(k=>!sensitiveKey.test(k)).slice(0,25); } catch {} }
          else if (['string','number','boolean'].includes(typeof child)) summary.value=typeof child==='string'?child.slice(0,160):child;
          matches.push(summary);
        }
        if (child && typeof child==='object' && depth < 5) walk(child,childPath,depth+1);
        if (performance.now() - startedAt > 1200 || visitedNodes >= 250 || matches.length >= 300) { truncated=true; return; }
      }
    };
    for (const candidate of candidates.slice(0,40)) {
      let keys=[]; try { keys=Object.keys(candidate.value).filter(k=>!sensitiveKey.test(k)).slice(0,50); } catch {}
      candidateSummary.push({path:candidate.path,reason:candidate.reason,type:Array.isArray(candidate.value)?'array':typeof candidate.value,keys});
      if (/store|state|redux|fiber|reactrootcontainer|rootcontainer|internalroot/i.test(candidate.path) || candidate.reason==='store-like global') { walk(candidate.value,candidate.path,0); if(/reactrootcontainer|rootcontainer|internalroot|fiber/i.test(candidate.path)) inspectFiberTree(candidate.value); }
    }
    const discovery={reduxStoreCandidateCount:candidates.filter(c=>/store|redux|getState/i.test(c.path)||/store/i.test(c.reason)).length,globalKeyCount:globalKeys.length,reactFiberRootCount:fiberRoots.length,candidates:candidateSummary};
    const report={diagnostic:'simcompanies-runtime-state-access-diagnostic',schemaVersion:4,capturedAt:new Date().toISOString(),requestId:requestId||null,runtime:{url:String(location.href).split('?')[0],pathname:String(location.pathname),readyState:String(document.readyState),realm:pageRealm()},discovery,stateMatches:matches,componentSnapshots,componentSnapshotCount:componentSnapshots.length,fiberNodesVisited,snapshotNodesVisited,runtimeAccess:{relevantGlobalNames:globalKeys.filter(k=>relevantKey.test(k)&&!sensitiveKey.test(k)).slice(0,100),rootElementIds:rootNodes.slice(0,30).map(e=>({id:String(e.id||'').slice(0,100),tagName:String(e.tagName||'')})),frameworkSignals:{reactGlobal:typeof window.React!=='undefined',reactDomGlobal:typeof window.ReactDOM!=='undefined',webpackChunkGlobals:globalKeys.filter(k=>/^webpackChunk|^webpackJsonp/i.test(k)).slice(0,20)},scriptResources:performance.getEntriesByType('resource').filter(e=>e.initiatorType==='script'||/\.m?js(?:[?#]|$)/i.test(e.name)).slice(-50).map(e=>({url:String(e.name).split('?')[0].slice(0,300),initiatorType:e.initiatorType,durationMs:Math.round(Number(e.duration)||0)}))},limits:{maxNodes:250,maxMatches:300,maxDepth:5,visitedNodes,truncated,scannedElements,elapsedMs:Math.round(performance.now()-startedAt),note:'Bounded read-only state diagnostic. React component props/state snapshots are included where discoverable; sensitive-key branches and cyclic framework links are excluded. This is not guaranteed to be a complete raw Redux export.'}};
    return report;
  };

  // MAIN-world DOM/runtime inspection: unlike the isolated content-script world,
  // this can see page-owned React expando properties attached to DOM nodes.
  const collectDomRuntimeDiagnostic = (requestId) => {
    const started=performance.now(), nodes=[], roots=[], reactMarkers=[], scripts=[], embeddedJsonScripts=[];
    let scanned=0, truncated=false, totalElementCount=null;
    const fullText=el=>{try{return String(el.innerText||el.textContent||'');}catch{return ''}};
    const attrs=el=>{const out={};try{for(const a of Array.from(el.attributes||[]))out[String(a.name||'')]=String(a.value||'');}catch{}return out;};
    const all=[];
    try{totalElementCount=document.getElementsByTagName('*').length;for(const el of document.querySelectorAll('*'))all.push(el);}catch{}
    for(const el of all){
      scanned++;
      const tag=String(el.tagName||'').toLowerCase(), id=String(el.id||''), text=fullText(el);
      if((/root|app|game|landscape|main/i.test(id)||tag==='main')&&roots.length<100)roots.push({id,tagName:tag});
      try{for(const key of Object.keys(el)){if((key.startsWith('__reactFiber$')||key.startsWith('__reactProps$')||key.startsWith('__reactContainer$')||key==='_reactRootContainer')&&reactMarkers.length<500)reactMarkers.push({tagName:tag,id,marker:key.split('$')[0]});}}catch{}
      if(tag==='script'){const type=String(el.type||'').toLowerCase(),src=String(el.src||'');if(src&&scripts.length<500)scripts.push({src,type:type||null});if(type==='application/json'||id==='__NEXT_DATA__'){let parseStatus='not-json',parsedKeys=[];try{const parsed=JSON.parse(String(el.textContent||''));parsedKeys=parsed&&typeof parsed==='object'?Object.keys(parsed):[];parseStatus='parsed';}catch{parseStatus='parse-failed';}embeddedJsonScripts.push({id,type:type||null,characterCount:String(el.textContent||'').length,parseStatus,topLevelKeys:parsedKeys});}}
      nodes.push({index:scanned,tagName:tag,attributes:attrs(el),text:text||null,outerHTML:String(el.outerHTML||'')});
    }
    let scriptResources=[];try{scriptResources=performance.getEntriesByType('resource').filter(e=>e.initiatorType==='script'||/\.m?js(?:[?#]|$)/i.test(e.name)).map(e=>({url:String(e.name||''),initiatorType:String(e.initiatorType||''),durationMs:Math.round(Number(e.duration)||0)}));}catch{}
    let bodyText='';try{bodyText=String(document.body?.innerText||'');}catch{}
    const coverage=totalElementCount>0?Math.min(1,scanned/totalElementCount):null;
    const complete=totalElementCount!=null&&scanned===totalElementCount;
    return {diagnostic:'simcompanies-dom-runtime-inspection',schemaVersion:4,requestId:requestId||null,capturedAt:new Date().toISOString(),page:{url:String(location.href||''),pathname:String(location.pathname||''),readyState:String(document.readyState||''),title:String(document.title||'')},dom:{totalElementCount,scannedElementCount:scanned,scanCoverageRatio:coverage,scanCoveragePercent:coverage==null?null:Math.round(coverage*1000)/10,scanCompleteness:complete?'complete':'partial',bodyTextCharacterCount:bodyText.length,bodyText,roots,reactMarkerCount:reactMarkers.length,reactMarkers,embeddedJsonScripts,scriptElements:scripts,relevantNodes:nodes,relevantBodyTextSnippets:bodyText.split(/\n+/)},runtime:{mainWorld:true,windowReactGlobal:typeof window.React!=='undefined',windowReactDomGlobal:typeof window.ReactDOM!=='undefined',globalKeyCount:Object.keys(window).length,webpackChunkGlobals:Object.keys(window).filter(k=>/^webpackChunk|^webpackJsonp/i.test(k)),scriptResources},limits:{maxScannedElements:null,maxRelevantNodes:null,maxElapsedMs:null,elapsedMs:Math.round(performance.now()-started),truncated,partial:!complete,coverageWarning:complete?null:'Element count and scan count differ; report is partial.',note:'Full read-only DOM export: all element attributes, outerHTML and text are included without keyword or sensitive-content filtering. DOM script tags and Resource Timing script resources are separate evidence sources. This can contain personal or session-related page content; inspect the JSON before sharing. It is not a raw JavaScript heap or application-state dump.'}};
  };

  // Request a GET using the game's page context and its existing cookies/session.
  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.source !== 'SIMCO_MANAGER') return;
    if(event.data.type==='SET_NETWORK_CAPTURE'){
      const wasEnabled=networkCaptureEnabled, priorCount=networkCaptureCount, priorCaptureId=networkCaptureId;
      const requestId=String(event.data.requestId||'');
      const requestedCaptureId=String(event.data.captureId||networkCaptureId||'');
      networkCaptureId=requestedCaptureId;
      if(Boolean(event.data.enabled)){
        const resume=Boolean(event.data.resume);
        const sameCapture=wasEnabled&&priorCaptureId===requestedCaptureId;
        networkCaptureEnabled=true;
        if(!resume&&!sameCapture){networkCaptureCount=0;networkCaptureEmit({kind:'capture-start',pageUrl:location.pathname,resourceCount:performance.getEntriesByType('resource').length});}
        else if(resume&&!sameCapture){networkCaptureCount=0;networkCaptureEmit({kind:'capture-resume',pageUrl:location.pathname,resourceCount:performance.getEntriesByType('resource').length,afterPageReload:true});}
        snapshotResourceTiming();
      } else {
        // A full page refresh resets this in-memory flag. Stop must still write a
        // stop marker for the durable matching session rather than acknowledging a
        // stop that can never reach extension storage.
        networkCaptureEnabled=true;
        networkCaptureEmit({kind:'capture-stop',pageUrl:location.pathname,eventsCaptured:priorCount,recorderWasEnabled:wasEnabled,resumedAfterReload:!wasEnabled});
        networkCaptureEnabled=false;
      }
      emit('NETWORK_CAPTURE_CONTROL_ACK',{requestId,ok:true,captureId:networkCaptureId,enabled:Boolean(event.data.enabled),recorderWasEnabled:wasEnabled});
      return;
    }
    if (event.data.type === 'JAVASCRIPT_DIAGNOSTIC_GET') {
      collectJsRuntimeDiagnostic().then(diagnostic => emit('JAVASCRIPT_DIAGNOSTIC', { diagnostic, requestId:event.data.id||null })).catch(error => emit('JAVASCRIPT_DIAGNOSTIC', { diagnostic:null, requestId:event.data.id||null, error:String(error?.message||error) }));
      return;
    }
    if (event.data.type === 'DOM_RUNTIME_DIAGNOSTIC_GET') {
      const requestId=String(event.data.id||'');
      try { emit('DOM_RUNTIME_DIAGNOSTIC_RESULT',{requestId,diagnostic:collectDomRuntimeDiagnostic(requestId)}); }
      catch(error) { emit('DOM_RUNTIME_DIAGNOSTIC_RESULT',{requestId,diagnostic:null,error:String(error?.message||error)}); }
      return;
    }
    if (event.data.type === 'REDUX_STATE_DIAGNOSTIC_GET') {
      const requestId=String(event.data.id||'');
      try { emit('REDUX_STATE_DIAGNOSTIC_RESULT',{requestId,diagnostic:collectStateAccessDiagnostic(requestId)}); }
      catch(error) { emit('REDUX_STATE_DIAGNOSTIC_RESULT',{requestId,diagnostic:null,error:String(error?.message||error)}); }
      return;
    }
    if (event.data.type !== 'API_GET') return;
    const id = event.data.id;
    const path = String(event.data.path || '');
    if (!path.startsWith('/api/')) {
      emit('API_RESULT', { id, ok: false, status: 400, error: 'Only /api/ GET paths are allowed.' });
      return;
    }
    const controller = new AbortController();
    const requestedTimeout = Number(event.data.timeoutMs);
    const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout >= 3000 ? Math.min(requestedTimeout, 60000) : 8000; // v2.5.345 max 60 s (Sync waits 45 s)
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      markExplicitApiGetCapture(path);
      const response = await fetch(path, {
        method: 'GET', credentials: 'include', cache: 'no-store', signal: controller.signal,
        headers: { 'Accept': 'application/json' }
      });
      const text = await response.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = text; }
      // Explicit API_GET responses bypass the generic API_DATA observer, so
      // update the page's realm identity here before returning auth-data.
      try {
        if(response.ok&&/\/api\/v3\/companies\/auth-data\//.test(new URL(path,location.href).pathname)){
          const authRealm=realmFromAuthData(data);
          if(authRealm===0||authRealm===1)learnRealm(authRealm,'manager-auth-check');
        }
      } catch {}
      emit('API_RESULT', { id, ok: response.ok, status: response.status, statusText: response.statusText, data, captureRealm: (Number.isFinite(forcedCaptureRealm) && forcedCaptureRealmUntil > Date.now()) ? forcedCaptureRealm : lastKnownRealm });
    } catch (error) {
      emit('API_RESULT', { id, ok: false, status: 0, error: error?.name === 'AbortError' ? 'Sim Companies page API request timed out.' : (error?.message || String(error)) });
    } finally {
      clearTimeout(timeout);
    }
  });

  window.addEventListener('storage', (event) => {
    if (event.key === 'SimcompaniesConstantsData') emitResourceCatalog(true);
    if (event.key && (/^market_all_\d+_\d+$/.test(event.key) || /^market_\d+_\d+$/.test(event.key))) emitMarketCache();
    if (event.key && /^SimcompaniesRetailCalculation_[01]$/.test(event.key)) scheduleGameStateEmit(0);
  });

  // The game updates its own localStorage in the same page, so the browser's
  // `storage` event does not fire back into this document. Observe the write API
  // for the exact game-state keys and trigger a debounced capture immediately.
  try {
    const originalStorageSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      const result = originalStorageSetItem.apply(this, arguments);
      try {
        if (this === localStorage) replay('game-store-write',{storage:'localStorage',key:String(key||''),valueBytes:String(value??'').length*2});
        if (this === localStorage && /^SimcompaniesRetailCalculation_[01]$/.test(String(key || ''))) scheduleGameStateEmit(50);
      } catch {}
      return result;
    };
  } catch {}
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'SIMCO_MANAGER') return;
    if (event.data.type === 'BRIDGE_PING') emit('HOOK_READY', {});
    if (event.data.type === 'INITIALIZED') {
      const first = !bridgeInitialized;
      const flushed = flushBridgeQueue();
      post('INITIALIZED_ACK', { first, flushed, dropped: bridgeDropped, queuedTotal: bridgeQueuedTotal });
      return;
    }
    if (event.data.type === 'SET_SYNC_REALM') {
      const n = Number(event.data.realm);
      if (n === 0 || n === 1) {
        forcedCaptureRealm = n;
        forcedCaptureRealmUntil = Date.now() + Math.max(30000, Number(event.data.ttlMs) || 120000);
        try { sessionStorage.setItem('SCM_SYNC_REALM', JSON.stringify({realm:n,until:forcedCaptureRealmUntil})); } catch {}
      }
      emit('SYNC_REALM_SET', {realm: forcedCaptureRealm});
    }
    if (event.data.type === 'CLEAR_SYNC_REALM') {
      forcedCaptureRealm = null;
      forcedCaptureRealmUntil = 0;
      try { sessionStorage.removeItem('SCM_SYNC_REALM'); } catch {}
      emit('SYNC_REALM_CLEARED', {});
    }
    if (event.data.type === 'RESOURCE_CATALOG_GET') emitResourceCatalog(true);
    if (event.data.type === 'RESOURCE_IMAGE_GET') emitResourceImage(event.data.resource);
    if (event.data.type === 'MARKET_CACHE_GET') emitMarketCache();
    if (event.data.type === 'GAME_STATE_GET') { emitGameState(); emitGameLocalStorageSnapshot('game-state-request'); }
  });
  emitGameState();
  emitGameLocalStorageSnapshot('startup');
  setTimeout(emitGameState, 1000);
  setTimeout(emitGameState, 3000);
  setTimeout(()=>emitGameLocalStorageSnapshot('startup-delayed'), 3000);
  // Safety net: the primary path is change-driven, but a 1-second raw-value
  // check catches game updates performed through an internal storage wrapper.
  // The full JSON is parsed only when the raw snapshot actually changed.
  setInterval(() => {
    if (document.hidden) return; // v2.5.327 mobile: no per-second localStorage reads in a hidden tab
    try {
      const realm = pageRealm();
      if (realm !== 0 && realm !== 1) return;
      const raw = localStorage.getItem(`SimcompaniesRetailCalculation_${realm}`);
      if (raw && gameStateRawByRealm.get(realm) !== raw) scheduleGameStateEmit(0);
    } catch {}
  }, 1000);
  setInterval(() => { try { emitGameLocalStorageSnapshot('periodic-5m'); } catch {} }, 300000);
  document.addEventListener('visibilitychange', () => { if(document.visibilityState==='visible') emitGameLocalStorageSnapshot('visibility'); }, {passive:true});
  emitResourceCatalog();
  setTimeout(emitResourceCatalog, 1000);
  setTimeout(emitResourceCatalog, 3000);
  setTimeout(emitResourceCatalog, 8000);
  try {
    // P4: DOM mutations re-check the catalog at most every 30 s (it walks every <img> on the page).
    const RESOURCE_CATALOG_OBSERVER_MIN_MS=30000;
    let resourceCatalogTimer=0,resourceCatalogLastRun=0;
    const scheduleResourceCatalog=()=>{
      if(resourceCatalogTimer)return;
      const wait=Math.max(1000,RESOURCE_CATALOG_OBSERVER_MIN_MS-(Date.now()-resourceCatalogLastRun));
      resourceCatalogTimer=setTimeout(()=>{resourceCatalogTimer=0;resourceCatalogLastRun=Date.now();emitResourceCatalog();},wait);
    };
    const imageObserver = new MutationObserver(() => { scheduleResourceCatalog(); });
    imageObserver.observe(document.documentElement || document.body, { childList: true, subtree: true });
  } catch {}
  setTimeout(emitMarketCache, 1000);
  setTimeout(emitMarketCache, 3000);
  // v2.5.341 the game's own executive timing config (window.reactjs.props), used by the game to decide which
  // executives count toward the admin-overhead reduction. Read-only; sent once the page has set it.
  const emitGameConfig = () => {
    try {
      const p = (window.reactjs && window.reactjs.props) || {};
      const config = {};
      for (const k of ['executivesTimeToTrainS', 'executivesTimeToSettleInS']) { const n = Number(p[k]); if (Number.isFinite(n) && n > 0) config[k] = n; }
      if (Object.keys(config).length) emit('GAME_CONFIG', { config });
    } catch {}
  };
  setTimeout(emitGameConfig, 1500);
  setTimeout(emitGameConfig, 6000);
  // v2.5.345 tell content.js this page's realm as soon as it is known (reload after a confirmed realm switch).
  // If the game has not revealed it 10 s after load, read auth-data once (the game itself re-reads it every 3 min).
  if (startupSwitchRealm === 0 || startupSwitchRealm === 1) emit('PAGE_REALM', { realm: startupSwitchRealm, reason: 'switch-reload' });
  setTimeout(() => {
    if (lastKnownRealm === 0 || lastKnownRealm === 1) return;
    try { window.fetch('/api/v3/companies/auth-data/', { credentials: 'include', headers: { Accept: 'application/json' } }).catch(() => {}); } catch {}
  }, 10000);
  emit('HOOK_READY', {});
})();
