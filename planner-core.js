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
  const vwapKey = (resourceId, quality) => `${Number(resourceId)}:${Number(quality)}`;
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

  function productionPlanLedger(specs, recipeByProduct, hours){
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
    const ledger=productionPlanLedger(specs,recipeByProduct,hours);
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
    resources.sort((a,b)=>({Deficit:0,Surplus:1}[a.status]-{Deficit:0,Surplus:1}[b.status]||Number(b.quality||0)-Number(a.quality||0)||Number(a.id)-Number(b.id)));
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
        // A contract is filled from its own quality first, then the next higher one (never spend Q3 on a Q1 contract
        // while Q1 stock is there), so its consumption lands on the row the contract is shown on.
        for (const supply of [...available].sort((a,b)=>a.quality-b.quality)) {
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
        const displayAvailableAsc=[...displayAvailable].sort((a,b)=>a.quality-b.quality);
        for(const req of [...idContracts].sort((a,b)=>b.quality-a.quality)){
          const unmet=takeForDisplay(displayAvailableAsc,req.amount,req.quality,displayContractAlloc);
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

  // Like roundCurrencyUp but never returns -0 (a 100% discount would otherwise give -0).
  function savedContractRoundUp(value) {
    const scaled = Number(value) * 100;
    const result = Math.ceil(scaled - Number.EPSILON * Math.max(1, Math.abs(scaled))) / 100;
    return result === 0 ? 0 : result;
  }
  function savedContractHasDiscount(contract) {
    const raw = contract?.discount;
    const discount = Number(raw);
    return raw != null && raw !== '' && Number.isFinite(discount) && discount >= 0 && discount <= 100;
  }
  // A saved contract follows the market unless its price was typed by hand.
  // Contracts saved before customPrice existed count as custom only when their
  // price differs from what their own saved market price and discount produce.
  function savedContractIsCustomPrice(contract) {
    if (typeof contract?.customPrice === 'boolean') return contract.customPrice;
    const mwap = Number(contract?.mwap), price = Number(contract?.price);
    if (!savedContractHasDiscount(contract) || !(mwap > 0) || !(price > 0)) return true;
    return Math.abs(price - savedContractRoundUp(mwap * (1 - Number(contract.discount) / 100))) >= 0.005;
  }
  function savedContractCurrentPrice(contract, marketPrice) {
    const market = Number(marketPrice);
    if (savedContractIsCustomPrice(contract) || !(market > 0) || !savedContractHasDiscount(contract)) return contract?.price;
    return savedContractRoundUp(market * (1 - Number(contract.discount) / 100));
  }

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

  // Overlay rows are per resource+quality. Stock at a quality the company does not produce is folded into the produced
  // row it can serve, so that row's Warehouse counts all usable stock while Demand stays the full plan:
  //  - higher quality -> the nearest LOWER produced quality (higher quality can always stand in for lower), as before;
  //  - lower quality  -> the nearest HIGHER produced quality, but only when some recipe accepts it, i.e. quality >= the
  //    lowest minQuality among that resource's demand rows (inputs may be one quality below the product).
  // Stock below every demand's minQuality is never counted. Produced rows and rows with a saved contract (keepKeys) stay.
  const foldQualityStock = (detailRows = [], producedKeys = new Set(), keepKeys = null, demandRows = []) => {
    const out = (Array.isArray(detailRows) ? detailRows : []).map(r => ({...r}));
    const byKey = new Map(out.map(r => [`${Number(r.id)}:${Number(r.quality) || 0}`, r]));
    const minNeed = new Map();
    for (const d of Array.isArray(demandRows) ? demandRows : []) {
      const id = Number(d?.id), mq = Math.max(0, Number(d?.minQuality) || 0);
      if (!Number.isFinite(id) || !(Number(d?.amount) > 0)) continue;
      minNeed.set(id, minNeed.has(id) ? Math.min(minNeed.get(id), mq) : mq);
    }
    const produced = [...(producedKeys || [])].map(k => String(k).split(':').map(Number));
    const drop = new Set();
    for (const r of out) {
      const id = Number(r.id), q = Number(r.quality) || 0, key = `${id}:${q}`;
      if (producedKeys?.has?.(key) || keepKeys?.has?.(key)) continue;
      let tq = null;
      for (const [i, pq] of produced) if (i === id && pq < q && (tq == null || pq > tq)) tq = pq;
      if (tq == null && minNeed.has(id) && q >= minNeed.get(id)) {
        for (const [i, pq] of produced) if (i === id && pq > q && (tq == null || pq < tq)) tq = pq;
      }
      const t = tq != null ? byKey.get(`${id}:${tq}`) : null;
      if (!t || t === r) continue;
      for (const f of ['warehouse', 'produced', 'incoming', 'demand', 'contracted', 'leftover', 'warehouseOnlyLeft']) t[f] = (Number(t[f]) || 0) + (Number(r[f]) || 0);
      if ((Number(r.warehouse) || 0) > 0) {
        t.substituteQualities = [...new Set([...(t.substituteQualities || []), q])].sort((x, y) => x - y);
        if (!t.warehouseByQuality) t.warehouseByQuality = [{quality: Number(t.quality) || 0, amount: (Number(t.warehouse) || 0) - (Number(r.warehouse) || 0)}];
        t.warehouseByQuality.push({quality: q, amount: Number(r.warehouse) || 0});
        t.warehouseByQuality.sort((x, y) => y.quality - x.quality);
      }
      drop.add(r);
    }
    return out.filter(r => !drop.has(r));
  };
  /* ===================================================================================================
   * Shared production calculation (one implementation for the game-page overlay and the Production page).
   *
   * Game rules (game bundle, verified against all running buildings of the 2.5.450 export):
   *   rate/h = level x base x (abundance resource ? abundance/100 : 1) x (1 + event/100) / (1 - (companyModifier + recreationBonus)/100)
   *   base   = producedPerHourRaw x (AVERAGE_SALARY / SALARY_MID[phase]) ^ building.salaryModifier   (tools-core gameBaseRate)
   * A run's rate is fixed when the run starts. Its history row holds the full output, so
   * run rate = row amount x 3600 / busy.duration. busy.resource.amount is what is STILL TO COME and is never a rate input.
   * Events come only from the game's /api/v2/production-modifiers/<realm>/ rows (the DOM event monitor is display only).
   * =================================================================================================== */
  const HOUR_MS = 3600000;
  const finiteNum = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const rawBuilding = b => (b && b.raw && typeof b.raw === 'object' ? b.raw : (b || {}));
  const buildingLevel = b => {
    const raw = rawBuilding(b);
    const direct = Number(b?.level ?? raw?.level ?? raw?.lvl ?? raw?.buildingLevel);
    if (Number.isFinite(direct) && direct > 0) return Math.min(20, direct);
    const size = Number(raw?.size);
    return Number.isFinite(size) && size > 0 ? Math.min(20, size) : 1;
  };
  // busy.category 'b' = the building is being expanded: it makes nothing until the upgrade finishes.
  const buildingExpanding = b => { const busy = rawBuilding(b)?.busy; return String(busy?.category || '') === 'b' || Boolean(busy?.expanding); };
  // The run the building is busy with (null when idle, expanding, or the busy object carries no product run).
  function buildingRun(building) {
    const raw = rawBuilding(building), busy = raw?.busy, res = busy?.resource;
    if (!busy || !res || buildingExpanding(building)) return null;
    const startedMs = Date.parse(String(busy.started || '')), durationSec = Number(busy.duration);
    const productId = Number(res.kind ?? res.resourceId);
    if (!Number.isFinite(startedMs) || !(durationSec > 0) || !(productId > 0)) return null;
    const q = res.quality == null ? NaN : Number(res.quality);
    const remaining = res.amount == null ? NaN : Number(res.amount), avail = Number(res.amountAvailableNow);
    return {
      startedMs, durationSec, finishMs: startedMs + durationSec * 1000, productId, product: String(res.name || ''),
      quality: Number.isFinite(q) ? Math.max(0, q) : null,
      remainingAmount: Number.isFinite(remaining) && remaining >= 0 ? remaining : null,
      amountAvailableNow: Number.isFinite(avail) && avail > 0 ? avail : 0,
      canFetch: busy.canFetch === true, started: String(busy.started)
    };
  }

  // THE history-row matcher: started within 5 s, same product, same quality when both are known, output > 0, newest first.
  function matchRunHistoryRow(building, rows) {
    const run = buildingRun(building);
    if (!run) return null;
    const matches = (Array.isArray(rows) ? rows : []).filter(row => {
      const amount = Number(row?.outputAmount ?? row?.amount), when = Date.parse(String(row?.datetime || ''));
      if (!(amount > 0) || !Number.isFinite(when) || Math.abs(when - run.startedMs) > 5000) return false;
      if (Number(row?.kind ?? row?.resourceId) !== run.productId) return false;
      const rq = row?.quality == null ? NaN : Number(row.quality);
      return !(Number.isFinite(rq) && run.quality != null && rq !== run.quality);
    });
    if (!matches.length) return null;
    matches.sort((a, b) => Date.parse(String(b?.datetime || '')) - Date.parse(String(a?.datetime || '')));
    return matches[0];
  }
  // Full output of the running run as the game recorded it (notification batch size), null when no history row.
  function runOutputAmount(building, historyRows) {
    const row = matchRunHistoryRow(building, historyRows);
    return row ? Number(row.outputAmount ?? row.amount) : null;
  }

  // Sum of `size` of recreation buildings busy with upkeep (realm 0 Lake = 1).
  function recreationBonus(buildings) {
    let sum = 0;
    for (const b of Array.isArray(buildings) ? buildings : []) {
      const raw = rawBuilding(b), busy = raw?.busy;
      if (String(raw?.category || '').toLowerCase() !== 'recreation' || !busy) continue;
      if (busy.upkeep !== true && String(busy.category || '') !== 'u') continue;
      const size = Number(raw.size ?? raw.level);
      if (Number.isFinite(size) && size > 0) sum += size;
    }
    return sum;
  }

  const toolsCore = ctx => ctx?.tools || globalThis.SCM_TOOLS_CORE || null;
  const bonusPctOf = ctx => Math.min(99, (finiteNum(ctx?.companyModifier) ?? 0) + (finiteNum(ctx?.recreationBonus) ?? 0));
  const normalRateFor = (ctx, name) => {
    const rates = ctx?.normalRates;
    const target = normalizeName(name);
    if (!rates || typeof rates !== 'object' || !target) return null;
    for (const [k, v] of Object.entries(rates)) if (normalizeName(k) === target && Number(v) > 0) return Number(v);
    return null;
  };
  // Game formula rate per level for a resource. eventAtMs = the moment the event is read (a run's start for a running
  // run; now for "the next run"). Null when no base rate is known.
  function formulaRatePerLevel(ctx, { productId, product = '', buildingId = null, eventAtMs, phase = null }) {
    const T = toolsCore(ctx);
    const ph = phase != null ? phase : finiteNum(ctx?.economyState);
    const eventPct = activeResourceProductionModifier(ctx?.modifierRows, productId, eventAtMs ?? ctx?.now ?? Date.now());
    const bonusPct = bonusPctOf(ctx);
    const abRaw = ctx?.abundanceByBuilding?.[String(buildingId)]?.[String(productId)];
    const abundancePct = abRaw != null && Number.isFinite(Number(abRaw)) ? Number(abRaw) : null;
    let perLevel = null, source = null;
    if (T?.gameRatePerLevel && ph != null && ctx?.constants) {
      perLevel = T.gameRatePerLevel(ctx.constants, productId, ph, { eventPct, bonusPct, abundancePct });
      if (perLevel > 0) source = 'game formula';
    }
    if (!(perLevel > 0)) {
      const base = normalRateFor(ctx, product);
      if (base > 0) {
        perLevel = base * (abundancePct != null ? abundancePct / 100 : 1) * (1 + eventPct / 100) / (1 - bonusPct / 100);
        source = 'normal-economy reference';
      }
    }
    if (!(perLevel > 0)) return null;
    return { perLevel, source, eventPct, bonusPct, abundancePct, phase: ph };
  }

  function snapshotForRun(building, run, snapshots) {
    const id = Number(rawBuilding(building)?.id ?? building?.id);
    for (const s of Object.values(snapshots && typeof snapshots === 'object' ? snapshots : {})) {
      if (Number(s?.buildingId) === id && Number(s?.resourceId) === run.productId && String(s?.started || '') === run.started &&
          String(s?.source || '') === 'production history' && Number(s?.observedRatePerHour) > 0) return s;
    }
    return null;
  }

  // What the building makes per hour in the game right now.
  //  1. running run + history row of that run                                   -> measured, locked for the whole run
  //  2. running run + same-started snapshot whose source is 'production history' -> measured, locked
  //  3. running run, nothing measured                                           -> game formula (event at the run's start)
  //  4. expanding or idle                                                       -> 0, running:false
  // `nextRun` is the same formula for the next run at today's economy (event now): the profit card's second rate.
  // opts.identity {product, productId, quality} names the product of an idle/expanding building (from a plan) for nextRun.
  function resolveBuildingRate(building, ctx, opts = {}) {
    const raw = rawBuilding(building), id = Number(raw?.id ?? building?.id), level = buildingLevel(building);
    const expanding = buildingExpanding(building), run = buildingRun(building), now = ctx?.now ?? Date.now();
    const out = {
      buildingId: id, running: false, expanding, level, ratePerHour: 0, perLevel: 0, source: null, sourceLabel: expanding ? 'expanding' : (run ? '' : 'idle'),
      locked: false, productId: run?.productId ?? null, product: run?.product || '', quality: run?.quality ?? null,
      startedMs: run?.startedMs ?? null, durationSec: run?.durationSec ?? null, finishMs: run?.finishMs ?? null,
      outputPerRun: null, eventPct: null, bonusPct: bonusPctOf(ctx), abundancePct: null, phase: finiteNum(ctx?.economyState), nextRun: null
    };
    const identity = run ? { productId: run.productId, product: run.product, quality: run.quality } : (opts.identity || null);
    const nextId = identity && Number(identity.productId) > 0 ? Number(identity.productId) : null;
    if (nextId) {
      if (!out.productId) { out.productId = nextId; out.product = String(identity.product || ''); out.quality = identity.quality ?? null; }
      const f = formulaRatePerLevel(ctx, { productId: nextId, product: identity.product, buildingId: id, eventAtMs: now });
      if (f) out.nextRun = { ratePerHour: f.perLevel * level, perLevel: f.perLevel, level, eventPct: f.eventPct, bonusPct: f.bonusPct, abundancePct: f.abundancePct, phase: f.phase, source: f.source };
    }
    if (!run) return out;
    out.running = true;
    const row = matchRunHistoryRow(building, ctx?.historyByBuilding?.[String(id)] || []);
    const eventAtStart = activeResourceProductionModifier(ctx?.modifierRows, run.productId, run.startedMs);
    if (row) {
      const amount = Number(row.outputAmount ?? row.amount);
      Object.assign(out, { ratePerHour: amount * 3600 / run.durationSec, outputPerRun: amount, source: 'run-history', sourceLabel: 'run history (game)', locked: true, eventPct: eventAtStart });
    } else {
      const snap = snapshotForRun(building, run, ctx?.snapshots);
      if (snap) {
        const rate = Number(snap.observedRatePerHour);
        Object.assign(out, { ratePerHour: rate, outputPerRun: rate * run.durationSec / 3600, source: 'run-snapshot', sourceLabel: 'run history (stored)', locked: true, eventPct: eventAtStart });
      } else {
        const T = toolsCore(ctx), log = ctx?.economyLog;
        const startedPhase = T?.economyStateAt && Array.isArray(log) && log.length ? (T.economyStateAt(log, new Date(run.startedMs).toISOString())?.state ?? null) : null;
        const f = formulaRatePerLevel(ctx, { productId: run.productId, product: run.product, buildingId: id, eventAtMs: run.startedMs, phase: startedPhase });
        if (f) Object.assign(out, { ratePerHour: f.perLevel * level, outputPerRun: f.perLevel * level * run.durationSec / 3600, source: 'game-formula', sourceLabel: 'game formula estimate', locked: false, eventPct: f.eventPct, abundancePct: f.abundancePct, phase: f.phase });
        else Object.assign(out, { sourceLabel: 'rate unknown', eventPct: eventAtStart });
      }
    }
    out.perLevel = level > 0 ? out.ratePerHour / level : 0;
    if (out.abundancePct == null) {
      const ab = ctx?.abundanceByBuilding?.[String(id)]?.[String(run.productId)];
      out.abundancePct = ab != null && Number.isFinite(Number(ab)) ? Number(ab) : null;
    }
    return out;
  }

  // Per-level rate with the event (read at the run's start) and the company/recreation bonus taken out. Null when the
  // building has no measured run. For display and checks only; never an input to a figure.
  function neutralBaseRatePerLevel(building, ctx) {
    const r = resolveBuildingRate(building, ctx);
    if (!r.running || !r.locked || !(r.perLevel > 0)) return null;
    const factor = 1 + (r.eventPct || 0) / 100;
    return factor > 0 ? r.perLevel * (1 - r.bonusPct / 100) / factor : null;
  }

  // The run's remaining output as the game page shows it. A collect after the buildings snapshot (stamp) leaves only the
  // output from that collect to the finish (capped by the snapshot amount); a snapshot at/after the stamp supersedes it.
  function collectAdjustedRun(run, stampMs, snapshotMs) {
    const at = Number(stampMs);
    if (!(at > 0) || (Number.isFinite(snapshotMs) && snapshotMs >= at)) return run;
    const rate = Number(run?.ratePerHour), amount = run?.amount;
    const left = amount != null && rate > 0 ? Math.min(Number(amount), Math.max(0, rate * (Number(run.finishMs) - at) / HOUR_MS)) : amount;
    return { ...run, amount: left, amountAvailableNow: 0, canFetch: false, collectedAtMs: at };
  }
  // Countdown input for a running building: {amount (still to come), amountAvailableNow, canFetch, finishMs, ratePerHour,
  // quality, productId, startedMs, finished, remainingMs}. null when the building has no run.
  function runCountdown(building, nowMs, collectStampMs, snapshotMs, ratePerHour = 0) {
    const run = buildingRun(building);
    if (!run) return null;
    const adjusted = collectAdjustedRun({
      amount: run.remainingAmount, amountAvailableNow: run.amountAvailableNow, canFetch: run.canFetch,
      finishMs: run.finishMs, ratePerHour: Number(ratePerHour) || 0
    }, collectStampMs, snapshotMs);
    const now = Number(nowMs);
    return { ...adjusted, quality: run.quality, productId: run.productId, startedMs: run.startedMs,
      finished: Number.isFinite(now) ? now >= run.finishMs : false, remainingMs: Number.isFinite(now) ? Math.max(0, run.finishMs - now) : null };
  }

  const asRecipeMaps = recipes => {
    if (recipes instanceof Map) {
      const byId = new Map();
      for (const r of recipes.values()) if (r && Number(r.id) > 0) byId.set(Number(r.id), r);
      return { byProduct: recipes, byId };
    }
    const list = Array.isArray(recipes) ? recipes : [];
    return { byProduct: new Map(list.map(r => [normalizeName(r?.name), r])), byId: new Map(list.filter(r => Number(r?.id) > 0).map(r => [Number(r.id), r])) };
  };
  const plansList = plans => {
    const m = new Map();
    for (const p of Array.isArray(plans) ? plans : Object.values(plans && typeof plans === 'object' ? plans : {})) {
      const id = Number(p?.buildingId);
      if (id > 0 && String(p?.product || '').trim()) m.set(id, p);
    }
    return m;
  };

  // Countdown runs per product+quality key for every running building (a run with an unknown rate is still listed).
  function etaRunsFromEntries(entries) {
    const map = new Map();
    for (const e of entries) {
      if (!e.running || !e.countdown) continue;
      const key = `${e.productId}:${e.quality != null ? e.quality : 0}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(e.countdown);
    }
    return map;
  }

  // The production network. `plans` are identity only (product, quality, plannedLevel, mode); they never supply a rate.
  // Game figures come from the buildings' real runs. Where a plan differs from what the building runs (other product,
  // level or quality, or a building that is not producing) the difference is a separate `planned` figure and `planned`
  // network; the game figures stay untouched.
  function buildNetwork({ buildings = [], plans = {}, recipes = [], hours = 24, ctx = {}, resourceNames = null, collectStamps = null, snapshotMs = NaN, now = null } = {}) {
    const nowMs = now ?? ctx.now ?? Date.now();
    const c = { ...ctx, now: nowMs };
    const { byProduct, byId } = asRecipeMaps(recipes);
    const planById = plansList(plans);
    const networkHours = Math.max(1, Number(hours) || 24);
    const entries = [], specs = [], plannedSpecs = [], upgradingKeys = new Set();
    let anyPlanned = false;
    for (const b of Array.isArray(buildings) ? buildings : []) {
      const raw = rawBuilding(b), id = Number(raw?.id ?? b?.id), plan = planById.get(id) || null;
      const isProduction = String(raw?.category || '').toLowerCase() === 'production';
      const planRecipe = plan ? (byProduct.get(normalizeName(plan.product)) || byId.get(Number(plan.productId))) : null;
      const identity = planRecipe ? { productId: Number(planRecipe.id), product: planRecipe.name, quality: Math.max(0, Number(plan?.quality) || 0) } : null;
      let rate = resolveBuildingRate(b, c, { identity });
      if (rate.expanding) {
        // What an expanding building was making: its plan's product, else the newest history row.
        let pid = identity?.productId, pq = identity?.quality;
        if (!(pid > 0)) {
          const last = [...(c.historyByBuilding?.[String(id)] || [])].sort((x, y) => Date.parse(String(y?.datetime || '')) - Date.parse(String(x?.datetime || '')))[0];
          if (last && Number(last.kind) > 0) { pid = Number(last.kind); pq = last.quality == null ? 0 : Number(last.quality); }
        }
        if (!(pid > 0)) {
          // No plan or history: what the building can make (its abundance list, else the resources its kind produces) is "id:*".
          const ab = c.abundanceByBuilding?.[String(id)];
          const ids = ab ? Object.keys(ab) : Object.entries(c.constants?.resources || {}).filter(([, r]) => String(r?.producedAt) === String(raw?.kind)).map(([k]) => k);
          for (const k of ids) upgradingKeys.add(`${Number(k)}:*`);
        }
        if (pid > 0) { upgradingKeys.add(`${pid}:${Math.max(0, Number(pq) || 0)}`); if (!rate.productId) { rate = { ...rate, productId: pid, quality: Math.max(0, Number(pq) || 0) }; } }
      }
      if (!isProduction && !rate.running && !plan) continue;
      const recipe = (rate.running ? (byId.get(rate.productId) || byProduct.get(normalizeName(rate.product))) : null) || null;
      const quality = rate.quality != null ? rate.quality : Math.max(0, Number(plan?.quality) || 0);
      const entry = { ...rate, quality, recipe: recipe ? recipe.name : null, inputs: [], inputsPerRun: [], planned: null, countdown: null };
      if (rate.running) {
        entry.countdown = runCountdown(b, nowMs, collectStamps?.[String(id)], snapshotMs, rate.ratePerHour);
        if (recipe && rate.ratePerHour > 0) {
          const outputRun = rate.ratePerHour * networkHours;
          for (const m of Array.isArray(recipe.materials) ? recipe.materials : []) {
            const mid = Number(m?.id), per = Number(m?.quantity);
            if (!(mid > 0) || !(per > 0)) continue;
            entry.inputs.push({ id: mid, perQuantity: per, required: outputRun * per, minQuality: Math.max(0, quality - 1) });
            // The game takes whole units per run: ceil(run output x quantity).
            if (rate.outputPerRun > 0) entry.inputsPerRun.push({ id: mid, amount: Math.ceil(rate.outputPerRun * per - 1e-9) });
          }
          specs.push({ buildingId: id, product: recipe.name, productId: Number(recipe.id), quality, level: rate.level, ratePerHour: rate.ratePerHour, recipe, source: rate.source, locked: rate.locked });
        }
      }
      if (plan && planRecipe) {
        const plannedLevel = Math.min(20, Math.max(1, Number(plan.plannedLevel) || rate.level));
        const plannedQuality = Math.max(0, Number(plan.quality) || 0);
        const sameProduct = rate.running && Number(planRecipe.id) === rate.productId;
        const differs = !rate.running || !sameProduct || plannedLevel !== rate.level || (rate.quality != null && plannedQuality !== rate.quality);
        if (differs) {
          let plannedRate = 0, source = 'planned';
          if (String(plan.mode || '') === 'disabled') source = 'planned (disabled)';
          else if (sameProduct && rate.perLevel > 0) { plannedRate = rate.perLevel * plannedLevel; source = 'planned (game rate x level)'; }
          else {
            const f = formulaRatePerLevel(c, { productId: Number(planRecipe.id), product: planRecipe.name, buildingId: id, eventAtMs: nowMs });
            plannedRate = f ? f.perLevel * plannedLevel : 0;
            source = f ? 'planned (game formula)' : 'planned (rate unknown)';
          }
          entry.planned = { ratePerHour: plannedRate, level: plannedLevel, product: planRecipe.name, productId: Number(planRecipe.id), quality: plannedQuality, source };
          anyPlanned = true;
        }
      }
      entries.push(entry);
      const ps = entry.planned
        ? (entry.planned.ratePerHour > 0 ? { buildingId: id, product: entry.planned.product, productId: entry.planned.productId, quality: entry.planned.quality, level: entry.planned.level, ratePerHour: entry.planned.ratePerHour, recipe: planRecipe, source: entry.planned.source, locked: false } : null)
        : (specs.find(sp => sp.buildingId === id) || null);
      if (ps) plannedSpecs.push(ps);
    }
    const names = resourceNames || new Map([...byId.values()].map(r => [String(r.id), r.name]));
    const balance = list => {
      const core = productionBalance(list, byProduct, networkHours, names);
      return { ...core, surplusByKey: productionSurplusByKey(core.productionRows, core.demandRows) };
    };
    const game = balance(specs);
    return {
      hours: networkHours, buildings: entries, specs, activeSpecs: game.activeSpecs,
      productionRows: game.productionRows, demandRows: game.demandRows, resources: game.resources, deficits: game.deficits, surpluses: game.surpluses,
      surplusByKey: game.surplusByKey, upgradingKeys, etaRunsByKey: etaRunsFromEntries(entries),
      planned: anyPlanned ? balance(plannedSpecs) : null
    };
  }

  // Stock after demand and contracts: ONE implementation for the overlay, the contract helper, the Contracts page and
  // saved-contract quantities. Inputs: warehouse rows ({id|kind, quality, qty|amount}), the network's production and demand
  // rows, the Manager-saved contracts (live API contracts are never an input).
  // A resource+quality that running buildings need as input stays listed even when nothing produces it right now
// (producing:false; reason 'upgrading' when its only producer is being expanded, else 'not producing'), so a shortfall shows.
// upgradingKeys: Set of "id:quality" (or "id:*" when the quality is unknown) made by expanding buildings (network.upgradingKeys).
function stockAfterDemand({ warehouse = [], productionRows = [], demandRows = [], savedContracts = [], upgradingKeys = null } = {}) {
    const grouped = new Map();
    for (const row of Array.isArray(warehouse) ? warehouse : []) {
      const id = Number(row?.id ?? row?._id ?? row?.kind ?? row?.resourceId), q = Number(row?.quality ?? row?._quality ?? row?.q ?? row?.resourceQuality);
      const qty = Number(row?.qty ?? row?._qty ?? row?.amount ?? row?.quantity ?? row?.units);
      if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(q) || !Number.isFinite(qty) || qty <= 0) continue;
      const key = `${id}:${q}`, g = grouped.get(key) || { id, quality: q, qty: 0 };
      g.qty += qty; grouped.set(key, g);
    }
    const groupedRows = [...grouped.values()];
    const warehouseRowsForCore = groupedRows.map(r => ({ id: r.id, quality: r.quality, amount: r.qty }));
    const surplusByKey = productionSurplusByKey(productionRows, demandRows);
    // Baseline without contracts: Left quantities come from the current input balance, never from an earlier snapshot.
    const baseCoreRows = balanceSupplyDemandContracts({ warehouseRows: warehouseRowsForCore, productionRows, demandRows, includeQualityRows: true });
    const baseDetailRows = Array.isArray(baseCoreRows?.qualityRows) && baseCoreRows.qualityRows.length ? baseCoreRows.qualityRows : baseCoreRows;
    const baseBalanceByKey = new Map();
    for (const row of baseDetailRows) {
      const id = Number(row?.id), quality = Number(row?.quality) || 0;
      if (!Number.isFinite(id) || id <= 0) continue;
      const fallback = (Number(row?.warehouse) || 0) - (Number(row?.demand) || 0);
      baseBalanceByKey.set(`${id}:${quality}`, Number.isFinite(Number(row?.warehouseOnlyLeft)) ? Number(row.warehouseOnlyLeft) : fallback);
    }
    for (const row of groupedRows) {
      const key = `${Number(row.id)}:${Number(row.quality) || 0}`;
      if (!baseBalanceByKey.has(key)) baseBalanceByKey.set(key, Math.max(0, Number(row.qty) || 0));
    }
    const contracts = Array.isArray(savedContracts) ? savedContracts : [];
    const savedQuantities = resolveSavedContractQuantities({ savedContracts: contracts, baseBalanceByKey, surplusByKey });
    const effectiveSavedQty = (c, id, quality) => {
      if (savedQuantities.has(c)) return Math.max(0, Number(savedQuantities.get(c)) || 0);
      const mode = String(c?.quantityMode || 'custom').trim().toLowerCase();
      if (mode === 'surplus') return Math.max(0, Number(surplusByKey.get(`${id}:${quality}`)) || 0);
      if (mode === 'left') return Math.max(0, Number(baseBalanceByKey.get(`${id}:${quality}`)) || 0);
      const q = Number(c?.quantity); return Number.isFinite(q) && q > 0 ? q : 0;
    };
    const contractRows = [], incomingByKey = new Map(), outgoingByKey = new Map(), savedContractKeys = new Set();
    for (const c of contracts) {
      const direction = String(c?.direction || '').trim().toLowerCase();
      if (direction !== 'incoming' && direction !== 'outgoing') continue;
      const parsed = String(c?.product ?? '').trim().match(/^(\d+)(?::(\d+))?$/);
      const id = Number(c?.productId != null ? c.productId : (parsed ? parsed[1] : null));
      const quality = Math.max(0, Number(c?.quality != null ? c.quality : (parsed ? parsed[2] : 0)) || 0);
      if (!(Number.isFinite(id) && id > 0)) continue;
      const key = `${id}:${quality}`;
      savedContractKeys.add(key);
      const amount = effectiveSavedQty(c, id, quality);
      if (!(Number.isFinite(amount) && amount > 0)) continue;
      if (direction === 'outgoing') { contractRows.push({ id, quality, amount }); outgoingByKey.set(key, (outgoingByKey.get(key) || 0) + amount); }
      else incomingByKey.set(key, (incomingByKey.get(key) || 0) + amount);
    }
    const coreRows = balanceSupplyDemandContracts({ warehouseRows: warehouseRowsForCore, productionRows, demandRows, contractRows, includeQualityRows: true });
    let detailRows = Array.isArray(coreRows?.qualityRows) && coreRows.qualityRows.length ? coreRows.qualityRows : coreRows.slice();
    const detailByKey = new Map(detailRows.map(r => [`${Number(r.id)}:${Number(r.quality) || 0}`, r]));
    for (const key of incomingByKey.keys()) {
      if (detailByKey.has(key)) continue;
      const [idText, qText] = key.split(':');
      detailRows.push({ id: Number(idText), quality: Number(qText) || 0, warehouse: 0, produced: 0, demand: 0, contracted: 0, leftover: 0, warehouseOnlyLeft: 0 });
    }
    // Ownership is resource+quality: a company may produce Q3 and consume the same resource at Q1/Q2.
    const producedKeys = new Set((productionRows || []).map(r => {
      const id = Number(r?.id), quality = Math.max(0, Number(r?.quality ?? r?.minQuality) || 0);
      return Number.isFinite(id) && id > 0 ? `${id}:${quality}` : null;
    }).filter(Boolean));
    // An input nothing produces folds its usable stock into the row of its lowest demanded quality, as a produced one does.
    const foldKeys = new Set(producedKeys), producedIds = new Set([...producedKeys].map(k => Number(k.split(':')[0])));
    const lowestDemand = new Map();
    for (const d of demandRows || []) {
      const id = Number(d?.id), mq = Math.max(0, Number(d?.minQuality) || 0);
      if (id > 0 && Number(d?.amount) > 0 && !producedIds.has(id)) lowestDemand.set(id, lowestDemand.has(id) ? Math.min(lowestDemand.get(id), mq) : mq);
    }
    for (const [id, mq] of lowestDemand) foldKeys.add(`${id}:${mq}`);
    detailRows = foldQualityStock(detailRows, foldKeys, savedContractKeys, demandRows);
    const rows = detailRows.map(r => {
      const quality = Number(r.quality) || 0, key = `${Number(r.id)}:${quality}`;
      const outgoing = Number(outgoingByKey.get(key) || 0), incoming = Number(incomingByKey.get(key) || 0);
      const left = (Number(r.warehouseOnlyLeft) || 0) + incoming;
      const producing = producedKeys.has(key);
      const upgrading = !producing && upgradingKeys && typeof upgradingKeys.has === 'function' && (upgradingKeys.has(key) || upgradingKeys.has(`${Number(r.id)}:*`));
      return { ...r, quality, contracted: outgoing - incoming, incoming, outgoing, leftover: left, difference: left, warehouseOnlyLeft: left,
        surplus: Math.max(0, Number(surplusByKey.get(key)) || 0), producing, reason: producing ? null : (upgrading ? 'upgrading' : 'not producing') };
    }).filter(r => {
      const key = `${Number(r.id)}:${Number(r.quality) || 0}`;
      const visible = producedKeys.has(key) || savedContractKeys.has(key) || (Number(r.demand) || 0) > 1e-9;
      const changed = Math.abs(Number(r.produced) || 0) > 1e-9 || Math.abs(Number(r.demand) || 0) > 1e-9 || Math.abs(Number(r.contracted) || 0) > 1e-9 || Math.abs(Number(r.leftover) || 0) > 1e-9;
      return visible && changed;
    });
    // Per resource (all qualities together, the Contracts page's view): the same allocation, summed.
    const idMap = new Map();
    for (const r of coreRows) idMap.set(Number(r.id), { ...r });
    const incomingById = new Map();
    for (const [key, amt] of incomingByKey) { const id = Number(key.split(':')[0]); incomingById.set(id, (incomingById.get(id) || 0) + amt); }
    for (const id of incomingById.keys()) if (!idMap.has(id)) {
      const wh = groupedRows.filter(r => r.id === id).reduce((n, r) => n + r.qty, 0);
      idMap.set(id, { id, warehouse: wh, produced: 0, incoming: 0, demand: 0, contracted: 0, leftover: wh, warehouseOnlyLeft: wh });
    }
    const idRows = [...idMap.values()].sort((a, b) => a.id - b.id).map(r => {
      const outgoing = Number(r.contracted) || 0, incoming = Number(incomingById.get(Number(r.id)) || 0);
      const left = (Number(r.warehouse) || 0) - (Number(r.demand) || 0) - (outgoing - incoming);
      return { ...r, incoming, outgoing, contracted: outgoing - incoming, leftover: left, difference: left, warehouseOnlyLeft: left, quality: null };
    });
    return { rows, idRows, surplusByKey, baseBalanceByKey, savedQuantities, savedContractKeys, producedKeys, incomingByKey, outgoingByKey };
  }

  // Everything the rate resolution reads, taken from a realm store (the overlay's store and the Production page's state
  // have the same shape). Both surfaces build their context here, so the same store gives the same numbers.
  //   opts: {realm, now, buildings, constants, economyLog, normalRates, tools}
  function productionContext(store, opts = {}) {
    const s = store && typeof store === 'object' ? store : {};
    const ep = s.endpointData && typeof s.endpointData === 'object' ? s.endpointData : {};
    const realm = finiteNum(opts.realm ?? s.viewRealm ?? s.captureRealm);
    const okStatus = e => { const st = Number(e?.status); return !Number.isFinite(st) || st === 0 || (st >= 200 && st < 300); };
    const sameRealm = e => realm == null || e?.captureRealm == null || Number(e.captureRealm) === realm;
    let buildings = Array.isArray(opts.buildings) ? opts.buildings : (Array.isArray(s.buildings) ? s.buildings : []);
    if (!buildings.length) {
      for (const [url, e] of Object.entries(ep)) {
        if (!/\/api\/v2\/companies\/(?:me|\d+)\/buildings\/?$/i.test(url) || !okStatus(e) || !sameRealm(e)) continue;
        const d = e?.data, list = Array.isArray(d) ? d : (['buildings', 'data', 'items', 'results'].map(k => Array.isArray(d?.[k]) ? d[k] : null).find(Boolean) || []);
        if (list.length) { buildings = list; break; }
      }
    }
    const historyByBuilding = {};
    for (const [url, e] of Object.entries(ep)) {
      const m = url.match(/^\/api\/v2\/companies\/buildings\/(\d+)\/history\/?$/);
      if (m && okStatus(e) && sameRealm(e) && Array.isArray(e?.data)) historyByBuilding[m[1]] = e.data;
    }
    let modifierRows = [], newest = -Infinity;
    for (const [url, e] of Object.entries(ep)) {
      const m = url.match(/^\/api\/v2\/production-modifiers\/(\d+)\/?$/);
      if (!m || Number(e?.status) !== 200 || !Array.isArray(e?.data?.resourceProductionModifiers)) continue;
      if (realm != null && Number(m[1]) !== realm) continue;
      const at = Date.parse(String(e.receivedAt || '')) || 0;
      if (at >= newest) { newest = at; modifierRows = e.data.resourceProductionModifiers; }
    }
    let auth = s.authData?.authCompany && typeof s.authData.authCompany === 'object' ? s.authData.authCompany : null;
    let temporals = s.authData?.temporals || null;
    if (!auth) {
      const found = Object.entries(ep).filter(([url, e]) => /\/api\/v3\/companies\/auth-data\/?$/i.test(url) && Number(e?.status) === 200 && e?.data != null && sameRealm(e))
        .sort((a, b) => Date.parse(String(b[1]?.receivedAt || '')) - Date.parse(String(a[1]?.receivedAt || '')))[0];
      const d = found?.[1]?.data;
      auth = d?.authCompany || d?.company || null; temporals = temporals || d?.temporals || null;
    }
    const mod = Number(auth?.productionModifier);
    const log = Array.isArray(opts.economyLog) ? opts.economyLog : (Array.isArray(s.economyStateLog) ? s.economyStateLog : []);
    const authPhase = finiteNum(temporals?.economyState);
    const phase = authPhase != null ? authPhase : (log.length ? finiteNum(log[log.length - 1]?.s) : null);
    const abundanceByBuilding = {};
    for (const [url, e] of Object.entries(ep)) {
      const m = url.match(/^\/api\/v2\/companies\/buildings\/(\d+)\/abundance\/?$/);
      if (m && okStatus(e) && e?.data?.abundance && typeof e.data.abundance === 'object') abundanceByBuilding[m[1]] = e.data.abundance;
    }
    return {
      now: opts.now ?? Date.now(), realm, buildings, historyByBuilding, snapshots: s.productionRateSnapshots || {},
      modifierRows, companyModifier: Number.isFinite(mod) ? Math.max(-99, Math.min(99, mod)) : 0,
      recreationBonus: recreationBonus(buildings), constants: opts.constants || s.gameConstants || null,
      economyState: phase, economyLog: log, abundanceByBuilding, normalRates: opts.normalRates || null, tools: opts.tools || null
    };
  }
  const api = Object.freeze({
    clampDiscount,
    roundCurrencyUp,
    roundResourceDown,
    normalizeName,
    discountedUnitPrice,
    activeResourceProductionModifier,
    productionSurplusByKey,
    productionBalance,
    balanceSupplyDemandContracts,
    foldQualityStock,
    resolveSavedContractQuantities,
    savedContractIsCustomPrice,
    savedContractCurrentPrice,
    matchRunHistoryRow,
    runOutputAmount,
    recreationBonus,
    buildingRun,
    buildingLevel,
    buildingExpanding,
    formulaRatePerLevel,
    resolveBuildingRate,
    neutralBaseRatePerLevel,
    collectAdjustedRun,
    runCountdown,
    buildNetwork,
    stockAfterDemand,
    productionContext,
  });
  globalThis.SCMPlannerCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
