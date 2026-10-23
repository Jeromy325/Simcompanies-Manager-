(() => {
  'use strict';

  const clampDiscount = value => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
  };
  const normalizeName = value => String(value ?? '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .replace(/s$/, '');
  const nameVariants = value => {
    const raw=String(value ?? '');
    const normalized=normalizeName(raw);
    const out=new Set([normalized]);
    if(normalized==='cracker') out.add('xmascracker');
    const compact=raw.toLowerCase().replace(/[’']/g,'').replace(/[^a-z0-9]+/g,'');
    if(compact.endsWith('ies')&&compact.length>3){const c=compact.slice(0,-3)+'y';out.add(c);out.add(normalizeName(c));}
    if(compact.endsWith('es')&&compact.length>3){const c=compact.slice(0,-2);out.add(c);out.add(normalizeName(c));}
    if(compact.endsWith('s')&&compact.length>2){const c=compact.slice(0,-1);out.add(c);out.add(normalizeName(c));}
    return out;
  };
  const vwapKey = (resourceId, quality) => `${Number(resourceId)}:${Number(quality)}`;
  const buildVwapMap = vwapData => {
    const map = new Map();
    const rows = Array.isArray(vwapData?.rows) ? vwapData.rows : [];
    for (const row of rows) {
      const id = Number(row?.resourceId);
      const q = Number(row?.quality);
      const value = Number(row?.value);
      if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(q) || !Number.isFinite(value) || value <= 0) continue;
      const key = vwapKey(id, q);
      if (!map.has(key)) map.set(key, value); // deterministic first-wins mapping
    }
    return map;
  };
  const exactVwap = (map, resourceId, quality) => {
    if (!(map instanceof Map)) return null;
    const n = Number(map.get(vwapKey(resourceId, quality)));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const roundCurrencyUp = value => {
    const n = Number(value);
    if (!Number.isFinite(n)) return NaN;
    const scaled = n * 100;
    return Math.ceil(scaled - Number.EPSILON * Math.max(1, Math.abs(scaled))) / 100;
  };
  const roundResourceDown = (value, precision = 3) => {
    const n = Number(value), digits = Number(precision);
    if (!Number.isFinite(n) || !Number.isInteger(digits) || digits < 0 || digits > 8) return NaN;
    const factor = 10 ** digits, scaled = n * factor;
    return Math.floor(scaled + Number.EPSILON * Math.max(1, Math.abs(scaled))) / factor;
  };
  const discountedUnitPrice = (vwap, discount) => {
    const value = Number(vwap);
    if (!Number.isFinite(value) || value <= 0) return null;
    return roundCurrencyUp(value * (1 - clampDiscount(discount) / 100));
  };
  const discountedTotal = (vwap, amount, discount) => {
    const unit = discountedUnitPrice(vwap, discount);
    const qty = Number(amount);
    return unit != null && Number.isFinite(qty) && qty > 0 ? roundCurrencyUp(unit * qty) : null;
  };
  const warehouseBalance = (warehouse, demand) => Number(warehouse || 0) - Number(demand || 0);

  // Derive an observed rate only from the history row belonging to the
  // building's currently running cycle. History amounts are cycle output,
  // while busy.duration is that cycle's duration in seconds. The resulting
  // rate already includes game-applied modifiers, so callers must not apply
  // those modifiers a second time.
  function observedProductionRatePerHour(building, historyRows, plannedLevel) {
    const raw = building?.raw || building || {};
    const busy = raw?.busy || building?.busy || {};
    const duration = Number(busy?.duration);
    const started = Date.parse(String(busy?.started || ''));
    const resourceId = Number(busy?.resource?.kind ?? busy?.resource?.resourceId);
    const productName = normalizeName(busy?.resource?.name || building?.currentResource || '');
    const currentLevel = Number(building?.level ?? raw?.level ?? raw?.size ?? 1);
    const targetLevel = Number(plannedLevel ?? currentLevel);
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(started) ||
        !Number.isFinite(currentLevel) || currentLevel <= 0 ||
        !Number.isFinite(targetLevel) || targetLevel <= 0) return null;
    const matches = (Array.isArray(historyRows) ? historyRows : []).filter(row => {
      const amount = Number(row?.outputAmount ?? row?.amount);
      const rowId = Number(row?.kind);
      const rowTime = Date.parse(String(row?.datetime || ''));
      const idMatches = Number.isFinite(resourceId) && resourceId > 0 && rowId === resourceId;
      const nameMatches = productName && normalizeName(row?.resourceName || row?.name || '') === productName;
      return Number.isFinite(amount) && amount > 0 && Number.isFinite(rowTime) &&
        Math.abs(rowTime - started) <= 5000 && (idMatches || (!resourceId && nameMatches));
    });
    if (!matches.length) return null;
    matches.sort((a, b) => Date.parse(String(b?.datetime || '')) - Date.parse(String(a?.datetime || '')));
    const amount = Number(matches[0]?.outputAmount ?? matches[0]?.amount);
    const rateAtCurrentLevel = amount / (duration / 3600);
    const rate = rateAtCurrentLevel * targetLevel / currentLevel;
    return Number.isFinite(rate) && rate > 0
      ? { rate, observedRateAtCurrentLevel: rateAtCurrentLevel, amount, duration, currentLevel, plannedLevel: targetLevel, row: matches[0] }
      : null;
  }

  // Game resource modifiers are keyed by resource `kind` and have explicit
  // active windows. Do not derive them from the extension's event-monitor UI.
  function activeResourceProductionModifier(rows, resourceId, now = Date.now()) {
    const id = Number(resourceId);
    if (!Number.isFinite(id) || id <= 0) return 0;
    let total = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
      if (Number(row?.kind) !== id) continue;
      const since = Date.parse(String(row?.since || ''));
      const until = Date.parse(String(row?.until || ''));
      if (Number.isFinite(since) && now < since) continue;
      if (Number.isFinite(until) && now >= until) continue;
      const modifier = Number(row?.speedModifier);
      if (Number.isFinite(modifier)) total += modifier;
    }
    return Math.max(-99, Math.min(99, total));
  }

  const normalizeFrozenPlanEntries = entries => (Array.isArray(entries) ? entries : Object.values(entries || {}))
    .map(x => ({
      buildingId: Number(x?.buildingId),
      product: String(x?.product || ''),
      productId: Number(x?.productId),
      resourceId: Number(x?.resourceId),
      quality: Math.max(0, Number(x?.quality) || 0),
      plannedLevel: Math.min(20, Math.max(1, Number(x?.plannedLevel ?? x?.level) || 1)),
      baseRatePerLevel: Number(x?.baseRatePerLevel) > 0 ? Number(x.baseRatePerLevel) : null,
      mode: String(x?.mode || 'live')
    }))
    .filter(x => x.buildingId > 0 && x.product && x.productId > 0 && x.plannedLevel > 0)
    .sort((a,b) => a.buildingId - b.buildingId || a.product.localeCompare(b.product));

  const frozenPlanSignature = (entries, hours, modifiers = {}) => JSON.stringify({
    hours: Math.max(1, Number(hours) || 24),
    companyProductionModifier: Number(modifiers?.companyProductionModifier) || 0,
    events: Object.entries(modifiers?.events || {})
      .map(([k,v]) => [String(k), Number(v) || 0])
      .sort((a,b) => a[0].localeCompare(b[0])),
    entries: normalizeFrozenPlanEntries(entries).map(x => ({
      buildingId:x.buildingId, product:x.product, productId:x.productId, resourceId:x.resourceId,
      quality:x.quality, plannedLevel:x.plannedLevel, baseRatePerLevel:x.baseRatePerLevel, mode:x.mode
    }))
  });

  function productionPlanLedger(specs, recipeByProduct, hours, resourceNames){
    const networkHours=Math.max(1,Number(hours)||24);
    const productionRows=[];
    const demandRows=[];
    const activeSpecs=[];
    for(const spec of Array.isArray(specs)?specs:[]){
      const rate=Number(spec?.ratePerHour);
      const productId=Number(spec?.productId);
      const quality=Math.max(0,Number(spec?.quality)||0);
      const recipe=spec?.recipe||recipeByProduct?.get(normalizeName(spec?.product))||null;
      if(!Number.isFinite(rate)||rate<=0||!Number.isFinite(productId)||productId<=0||!recipe)continue;
      const output=rate*networkHours;
      productionRows.push({id:productId,quality,amount:output});
      activeSpecs.push({...spec,productId,quality,recipe,outputRun:output});
      for(const material of Array.isArray(recipe.materials)?recipe.materials:[]){
        const id=Number(material?.id),per=Number(material?.quantity);
        if(!Number.isFinite(id)||id<=0||!Number.isFinite(per)||per<=0)continue;
        demandRows.push({
          id,
          minQuality:Math.max(0,quality-1),
          amount:output*per
        });
      }
    }
    return {hours:networkHours,productionRows,demandRows,activeSpecs};
  }

  function productionSurplusByKey(productionRows = [], demandRows = []){
    const suppliesById=new Map();
    const demandsById=new Map();
    const add=(map,id,row)=>{const n=Number(id);if(!Number.isFinite(n)||n<=0)return;if(!map.has(n))map.set(n,[]);map.get(n).push(row);};
    for(const row of Array.isArray(productionRows)?productionRows:[]){
      const id=Number(row?.id??row?.resourceId??row?.kind);
      const quality=Math.max(0,Number(row?.quality??row?.q)||0);
      const amount=Number(row?.amount??row?.qty??row?.quantity);
      if(Number.isFinite(id)&&id>0&&Number.isFinite(amount)&&amount>0)add(suppliesById,id,{quality,amount});
    }
    for(const row of Array.isArray(demandRows)?demandRows:[]){
      const id=Number(row?.id??row?.resourceId??row?.kind);
      const minQuality=Math.max(0,Number(row?.minQuality??row?.quality??row?.q)||0);
      const amount=Number(row?.amount??row?.qty??row?.quantity);
      if(Number.isFinite(id)&&id>0&&Number.isFinite(amount)&&amount>0)add(demandsById,id,{minQuality,amount});
    }
    const result=new Map();
    const ids=new Set([...suppliesById.keys(),...demandsById.keys()]);
    for(const id of ids){
      const supplies=(suppliesById.get(id)||[]).map(x=>({...x,amount:Number(x.amount)||0})).sort((a,b)=>b.quality-a.quality||b.amount-a.amount);
      const demands=(demandsById.get(id)||[]).map(x=>({...x,amount:Number(x.amount)||0})).sort((a,b)=>b.minQuality-a.minQuality||b.amount-a.amount);
      for(const demand of demands){
        let need=Number(demand.amount)||0;
        for(const supply of supplies){
          if(need<=1e-9)break;
          if(supply.amount<=1e-9||supply.quality<demand.minQuality)continue;
          const take=Math.min(need,supply.amount);
          supply.amount-=take;
          need-=take;
        }
      }
      for(const supply of supplies){
        const amount=Math.max(0,Number(supply.amount)||0);
        if(amount>1e-9)result.set(vwapKey(id,supply.quality),amount);
      }
    }
    return result;
  }

  function productionBalance(specs, recipeByProduct, hours, resourceNames){
    const ledger=productionPlanLedger(specs,recipeByProduct,hours,resourceNames);
    const resourceMap=new Map();
    const byResource=(id,name='')=>{
      const n=Number(id);
      if(!Number.isFinite(n)||n<=0)return null;
      if(!resourceMap.has(n))resourceMap.set(n,{id:n,name:String(name||`Resource #${n}`),productionByQuality:[],demandByMinQuality:[]});
      const row=resourceMap.get(n);
      if(name&&(!row.name||row.name===`Resource #${n}`))row.name=String(name);
      return row;
    };
    for(const row of ledger.productionRows){
      const out=byResource(row.id,resourceNames instanceof Map?resourceNames.get(String(row.id)):'');
      if(out)out.productionByQuality.push({quality:Number(row.quality)||0,amount:Number(row.amount)||0});
    }
    for(const row of ledger.demandRows){
      const knownName=resourceNames instanceof Map?resourceNames.get(String(row.id)):resourceNames&&typeof resourceNames==='object'?resourceNames[String(row.id)]:'';
      const out=byResource(row.id,knownName||'');
      if(out)out.demandByMinQuality.push({minQuality:Number(row.minQuality)||0,amount:Number(row.amount)||0});
    }
    const resources=[];
    for(const row of resourceMap.values()){
      const supplies=(row.productionByQuality||[]).map(x=>({quality:Number(x.quality)||0,amount:Number(x.amount)||0})).filter(x=>x.amount>1e-9).sort((a,b)=>b.quality-a.quality||b.amount-a.amount);
      const demands=(row.demandByMinQuality||[]).map(x=>({minQuality:Number(x.minQuality)||0,amount:Number(x.amount)||0})).filter(x=>x.amount>1e-9).sort((a,b)=>b.minQuality-a.minQuality||b.amount-a.amount);
      const unmet=new Map();
      for(const demand of demands){
        let need=demand.amount;
        for(const supply of supplies){
          if(need<=1e-9)break;
          if(supply.amount<=1e-9||supply.quality<demand.minQuality)continue;
          const take=Math.min(need,supply.amount);supply.amount-=take;need-=take;
        }
        if(need>1e-9)unmet.set(demand.minQuality,(unmet.get(demand.minQuality)||0)+need);
      }
      for(const [quality,amount] of [...unmet.entries()].sort((a,b)=>b[0]-a[0]))resources.push({id:row.id,name:row.name,deficit:amount,surplus:0,balance:-amount,status:'Deficit',quality,minQuality:[quality],produced:0,required:amount,productionByQuality:[],demandByMinQuality:[{minQuality:quality,amount}]});
      const remaining=new Map();
      for(const supply of supplies)if(supply.amount>1e-9)remaining.set(supply.quality,(remaining.get(supply.quality)||0)+supply.amount);
      for(const [quality,amount] of [...remaining.entries()].sort((a,b)=>b[0]-a[0]))resources.push({id:row.id,name:row.name,deficit:0,surplus:amount,balance:amount,status:'Surplus',quality,minQuality:[],produced:amount,required:0,productionByQuality:[{quality,amount}],demandByMinQuality:[]});
    }
    resources.sort((a,b)=>({Deficit:0,Surplus:1,Balanced:2}[a.status]-{Deficit:0,Surplus:1,Balanced:2}[b.status]||Number(b.quality||0)-Number(a.quality||0)||Number(a.id)-Number(b.id)));
    return {hours:ledger.hours,productionRows:ledger.productionRows,demandRows:ledger.demandRows,activeSpecs:ledger.activeSpecs,resources,deficits:resources.filter(r=>r.status==='Deficit'),surpluses:resources.filter(r=>r.status==='Surplus')};
  }

  const balanceSupplyDemandContracts = ({warehouseRows = [], productionRows = [], demandRows = [], contractRows = [], incomingContractRows = [], includeQualityRows = false} = {}) => {
    const suppliesById = new Map();
    const demandById = new Map();
    const contractsById = new Map();
    const add = (map, id, row) => {
      const n = Number(id);
      if (!Number.isFinite(n) || n <= 0) return;
      if (!map.has(n)) map.set(n, []);
      map.get(n).push(row);
    };
    for (const row of Array.isArray(warehouseRows) ? warehouseRows : []) {
      const id = Number(row?.id ?? row?._id ?? row?.resourceId ?? row?.kind);
      const quality = Math.max(0, Number(row?.quality ?? row?._quality ?? row?.q) || 0);
      const amount = Number(row?.amount ?? row?.qty ?? row?._qty ?? row?.quantity);
      if (Number.isFinite(id) && id > 0 && Number.isFinite(amount) && amount > 0) add(suppliesById, id, {quality, amount, source:'warehouse'});
    }
    for (const row of Array.isArray(productionRows) ? productionRows : []) {
      const id = Number(row?.id ?? row?.resourceId ?? row?.kind);
      const quality = Math.max(0, Number(row?.quality ?? row?.q) || 0);
      const amount = Number(row?.amount ?? row?.qty ?? row?.quantity);
      if (Number.isFinite(id) && id > 0 && Number.isFinite(amount) && amount > 0) add(suppliesById, id, {quality, amount, source:'production'});
    }
    for (const row of Array.isArray(incomingContractRows) ? incomingContractRows : []) {
      const id = Number(row?.id ?? row?.resourceId ?? row?.kind);
      const quality = Math.max(0, Number(row?.quality ?? row?.q) || 0);
      const amount = Number(row?.amount ?? row?.qty ?? row?.quantity);
      if (Number.isFinite(id) && id > 0 && Number.isFinite(amount) && amount > 0) add(suppliesById, id, {quality, amount, source:'incoming'});
    }
    for (const row of Array.isArray(demandRows) ? demandRows : []) {
      const id = Number(row?.id ?? row?.resourceId ?? row?.kind);
      const minQuality = Math.max(0, Number(row?.minQuality ?? row?.quality ?? row?.q) || 0);
      const amount = Number(row?.amount ?? row?.qty ?? row?.quantity);
      if (Number.isFinite(id) && id > 0 && Number.isFinite(amount) && amount > 0) add(demandById, id, {minQuality, amount});
    }
    for (const row of Array.isArray(contractRows) ? contractRows : []) {
      const id = Number(row?.id ?? row?.resourceId ?? row?.kind);
      const quality = Math.max(0, Number(row?.quality ?? row?.q) || 0);
      const amount = Number(row?.amount ?? row?.qty ?? row?.quantity);
      if (Number.isFinite(id) && id > 0 && Number.isFinite(amount) && amount > 0) add(contractsById, id, {quality, amount});
    }

    const ids = new Set([...suppliesById.keys(), ...demandById.keys(), ...contractsById.keys()]);
    const rows = [];
    const qualityRows = [];
    for (const id of ids) {
      const supplies = (suppliesById.get(id) || []).map(x => ({...x, amount:Number(x.amount)||0}));
      const initialSupplies = supplies.map(x => ({...x, amount:Number(x.amount)||0}));
      const idDemands = (demandById.get(id) || []).map(x => ({...x, amount:Number(x.amount)||0}));
      const idContracts = (contractsById.get(id) || []).map(x => ({...x, amount:Number(x.amount)||0}));
      const combined = new Map();
      for (const x of supplies) combined.set(x.quality, (combined.get(x.quality)||0) + x.amount);
      const available = [...combined.entries()].map(([quality, amount]) => ({quality:Number(quality), amount:Number(amount)||0})).sort((a,b)=>b.quality-a.quality);
      const warehouse = supplies.filter(x=>x.source==='warehouse').reduce((n,x)=>n+x.amount,0);
      const produced = supplies.filter(x=>x.source==='production').reduce((n,x)=>n+x.amount,0);
      const incoming = supplies.filter(x=>x.source==='incoming').reduce((n,x)=>n+x.amount,0);
      let demand = 0, contracted = 0, unmetDemand = 0, unmetContracts = 0;
      for (const req of [...(demandById.get(id)||[])].sort((a,b)=>b.minQuality-a.minQuality)) {
        let need=Number(req.amount)||0;
        demand += need;
        for (const supply of available) {
          if (need<=1e-9) break;
          if (supply.amount<=1e-9 || supply.quality<req.minQuality) continue;
          const take=Math.min(need,supply.amount); supply.amount-=take; need-=take;
        }
        unmetDemand += need;
      }
      for (const req of [...(contractsById.get(id)||[])].sort((a,b)=>b.quality-a.quality)) {
        let need=Number(req.amount)||0;
        contracted += need;
        for (const supply of available) {
          if (need<=1e-9) break;
          if (supply.amount<=1e-9 || supply.quality<req.quality) continue;
          const take=Math.min(need,supply.amount); supply.amount-=take; need-=take;
        }
        unmetContracts += need;
      }
      const leftover=available.reduce((n,x)=>n+x.amount,0);
      const shortfall=unmetDemand+unmetContracts;
      const warehouseOnlyLeft=warehouse-demand-contracted;
      rows.push({id,warehouse,produced,incoming,demand,contracted,leftover:shortfall>1e-9?-shortfall:leftover,warehouseOnlyLeft});

      if(includeQualityRows){
        // Quality rows are a presentation of the SAME allocation performed above.
        // A lower-quality requirement may be satisfied by higher-quality supply.
        // Do not create a false "demand-only" row for a quality that is not
        // actually produced when an eligible higher-quality supply covered it.
        const displaySupplies=(initialSupplies||[]).map(x=>({quality:Number(x.quality)||0,amount:Number(x.amount)||0,source:x.source}));
        const displayDemandAlloc=new Map();
        const displayContractAlloc=new Map();
        const displayUnmetDemand=new Map();
        const displayUnmetContracts=new Map();
        const takeForDisplay=(availableRows,need,minQuality,allocMap)=>{
          let remaining=Number(need)||0;
          for(const supply of availableRows){
            if(remaining<=1e-9)break;
            if(supply.amount<=1e-9||supply.quality<minQuality)continue;
            const take=Math.min(remaining,supply.amount);
            supply.amount-=take;
            remaining-=take;
            allocMap.set(supply.quality,(allocMap.get(supply.quality)||0)+take);
          }
          return remaining;
        };
        const displayAvailable=displaySupplies.map(x=>({...x})).sort((a,b)=>b.quality-a.quality||b.amount-a.amount);
        for(const req of [...idDemands].sort((a,b)=>b.minQuality-a.minQuality)){
          const unmet=takeForDisplay(displayAvailable,req.amount,req.minQuality,displayDemandAlloc);
          if(unmet>1e-9)displayUnmetDemand.set(req.minQuality,(displayUnmetDemand.get(req.minQuality)||0)+unmet);
        }
        for(const req of [...idContracts].sort((a,b)=>b.quality-a.quality)){
          const unmet=takeForDisplay(displayAvailable,req.amount,req.quality,displayContractAlloc);
          if(unmet>1e-9)displayUnmetContracts.set(req.quality,(displayUnmetContracts.get(req.quality)||0)+unmet);
        }

        const qualitySet=new Set();
        for(const x of initialSupplies)qualitySet.add(Number(x.quality)||0);
        for(const q of displayDemandAlloc.keys())qualitySet.add(Number(q)||0);
        for(const q of displayContractAlloc.keys())qualitySet.add(Number(q)||0);
        for(const q of displayUnmetDemand.keys())qualitySet.add(Number(q)||0);
        for(const q of displayUnmetContracts.keys())qualitySet.add(Number(q)||0);
        for(const quality of [...qualitySet].sort((a,b)=>b-a)){
          const warehouseQ=initialSupplies.filter(x=>x.source==='warehouse'&&Number(x.quality)===quality).reduce((n,x)=>n+(Number(x.amount)||0),0);
          const producedQ=initialSupplies.filter(x=>x.source==='production'&&Number(x.quality)===quality).reduce((n,x)=>n+(Number(x.amount)||0),0);
          const incomingQ=initialSupplies.filter(x=>x.source==='incoming'&&Number(x.quality)===quality).reduce((n,x)=>n+(Number(x.amount)||0),0);
          const allocatedDemandQ=Number(displayDemandAlloc.get(quality)||0);
          const allocatedContractQ=Number(displayContractAlloc.get(quality)||0);
          const unmetDemandQ=Number(displayUnmetDemand.get(quality)||0);
          const unmetContractQ=Number(displayUnmetContracts.get(quality)||0);
          const leftoverQ=displayAvailable.filter(x=>Number(x.quality)===quality).reduce((n,x)=>n+(Number(x.amount)||0),0);
          const demandQ=allocatedDemandQ+unmetDemandQ;
          const contractedQ=allocatedContractQ+unmetContractQ;
          const displayLeft=unmetDemandQ+unmetContractQ>1e-9?-unmetDemandQ-unmetContractQ:leftoverQ;
          if(Math.abs(warehouseQ)>1e-9||Math.abs(producedQ)>1e-9||Math.abs(incomingQ)>1e-9||Math.abs(demandQ)>1e-9||Math.abs(contractedQ)>1e-9||Math.abs(displayLeft)>1e-9){
            qualityRows.push({id,quality,warehouse:warehouseQ,produced:producedQ,incoming:incomingQ,demand:demandQ,contracted:contractedQ,leftover:displayLeft,warehouseOnlyLeft:warehouseQ-demandQ-contractedQ});
          }
        }
      }
    }
    rows.sort((a,b)=>a.id-b.id);
    if(includeQualityRows){
      qualityRows.sort((a,b)=>a.id-b.id||Number(b.quality)-Number(a.quality));
      Object.defineProperty(rows,'qualityRows',{value:qualityRows,enumerable:false});
    }
    return rows;
  };

  // Resolve Manager-saved contract quantities from a clean stock/demand balance.
  // This is deliberately independent of the previous overlay snapshot: using a prior
  // `difference` as the next `Left` quantity makes a contract consume its own output
  // and oscillate between zero and the available balance.
  function resolveSavedContractQuantities({savedContracts = [], baseBalanceByKey = new Map(), surplusByKey = new Map()} = {}) {
    const readMap = (source, key, fallback = 0) => {
      let value;
      if (source instanceof Map) value = source.get(key);
      else if (source && typeof source === 'object' && Object.prototype.hasOwnProperty.call(source, key)) value = source[key];
      const n = Number(value);
      return Number.isFinite(n) ? n : fallback;
    };
    const asKey = c => {
      const parsed = String(c?.product ?? '').trim().match(/^(\d+)(?::(\d+))?$/);
      const rawId = c?.productId != null ? c.productId : (parsed ? parsed[1] : NaN);
      const rawQuality = c?.quality != null ? c.quality : (parsed ? parsed[2] ?? 0 : 0);
      const id = Number(rawId), quality = Number(rawQuality);
      return Number.isFinite(id) && id > 0 && Number.isFinite(quality) && quality >= 0
        ? {id, quality, key: `${id}:${quality}`}
        : null;
    };
    const groups = new Map();
    (Array.isArray(savedContracts) ? savedContracts : []).forEach((contract, index) => {
      if (!contract || typeof contract !== 'object') return;
      const direction = String(contract.direction ?? '').trim().toLowerCase();
      if (direction !== 'incoming' && direction !== 'outgoing') return;
      const product = asKey(contract);
      if (!product) return;
      const rawMode = String(contract.quantityMode ?? 'custom').trim().toLowerCase();
      const mode = ['custom', 'surplus', 'left'].includes(rawMode) ? rawMode : 'custom';
      const record = {contract, direction, mode, index, key: product.key};
      if (!groups.has(product.key)) groups.set(product.key, []);
      groups.get(product.key).push(record);
    });

    const quantities = new Map();
    for (const [key, records] of groups) {
      records.sort((a, b) => {
        const at = Date.parse(a.contract?.savedAt || '') || 0;
        const bt = Date.parse(b.contract?.savedAt || '') || 0;
        return at - bt || a.index - b.index;
      });
      // Custom and Surplus quantities are determined from saved inputs/current plan.
      // Only Left-mode quantities are allocated from the remaining positive balance.
      let balanceBeforeLeft = readMap(baseBalanceByKey, key, 0);
      const leftIncoming = [];
      const leftOutgoing = [];
      for (const record of records) {
        if (record.mode === 'left') {
          (record.direction === 'incoming' ? leftIncoming : leftOutgoing).push(record);
          continue;
        }
        let quantity = 0;
        if (record.mode === 'surplus') {
          quantity = Math.max(0, readMap(surplusByKey, key, 0));
        } else {
          const raw = Number(record.contract?.quantity);
          quantity = Number.isFinite(raw) && raw > 0 ? raw : 0;
        }
        quantities.set(record.contract, quantity);
        balanceBeforeLeft += record.direction === 'incoming' ? quantity : -quantity;
      }

      // Incoming Left contracts are each based on the same pre-Left balance, not
      // on a snapshot which already includes their own delivery. They add stock,
      // so they do not compete with one another for inventory being sold.
      const incomingLeftQuantity = Math.max(0, balanceBeforeLeft);
      let incomingLeftTotal = 0;
      for (const record of leftIncoming) {
        quantities.set(record.contract, incomingLeftQuantity);
        incomingLeftTotal += incomingLeftQuantity;
      }

      // Outgoing Left contracts share the available balance. Stable save order
      // gives the first contract the remaining balance and prevents duplicate
      // Left contracts from each claiming all of the same stock.
      let outgoingLeftPool = Math.max(0, balanceBeforeLeft + incomingLeftTotal);
      for (const record of leftOutgoing) {
        const quantity = outgoingLeftPool;
        quantities.set(record.contract, quantity);
        outgoingLeftPool = Math.max(0, outgoingLeftPool - quantity);
      }
    }
    return quantities;
  }

  globalThis.SCMPlannerCore = Object.freeze({
    clampDiscount,
    roundCurrencyUp,
    roundResourceDown,
    normalizeName,
    nameVariants,
    vwapKey,
    buildVwapMap,
    exactVwap,
    discountedUnitPrice,
    discountedTotal,
    warehouseBalance,
    observedProductionRatePerHour,
    activeResourceProductionModifier,
    normalizeFrozenPlanEntries,
    frozenPlanSignature,
    productionPlanLedger,
    productionSurplusByKey,
    productionBalance,
    balanceSupplyDemandContracts,
    resolveSavedContractQuantities,
  });
})();
