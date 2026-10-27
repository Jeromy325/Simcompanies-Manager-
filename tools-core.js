/* Sim Companies Manager — Tools core (pure functions, no DOM, no chrome.*).
 * Price movers, price history stats, ROI / loan / capital-allocation calculators and
 * profit-per-hour-per-level. Shared by the dashboard Tools tab and the node tests.
 *
 * Formulas follow the public methodology of simconomist.com (production profit) and the
 * ROI formulas shown on its Building ROI calculator. Nothing here is forecast: every figure
 * is arithmetic on observed prices and user-entered inputs.
 */
(function (root) {
  'use strict';

  const HOUR = 3600 * 1000;
  const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const pos = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
  const normalizeName = v => String(v ?? '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '').replace(/s$/, '');

  /* ---------------------------------------------------------------- ROI */
  // Net over horizon = profitPerHour * (horizonHours - leadTimeHours) - cost   (simconomist formula)
  // ROI = net / cost.  Annualised = simple (not compounded) scaling of the horizon ROI.
  function roi({ cost, extraProfitPerHour, leadTimeHours = 0, horizonDays = 30 } = {}) {
    const c = pos(cost), p = extraProfitPerHour == null || extraProfitPerHour === '' ? NaN : Number(extraProfitPerHour);
    const lead = Math.max(0, num(leadTimeHours)), horizonH = pos(horizonDays) ? horizonDays * 24 : null;
    if (!c) return { ok: false, error: 'Enter an up-front cost greater than 0.' };
    if (!Number.isFinite(p)) return { ok: false, error: 'Enter the extra profit per hour.' };
    if (!horizonH) return { ok: false, error: 'Enter a horizon greater than 0 days.' };
    const productiveHours = Math.max(0, horizonH - lead);
    const net = p * productiveHours - c;
    const ratio = net / c;
    const paybackHours = p > 0 ? lead + c / p : null;
    return {
      ok: true, cost: c, extraProfitPerHour: p, leadTimeHours: lead, horizonDays, horizonHours: horizonH,
      paybackHours, paybackDays: paybackHours == null ? null : paybackHours / 24,
      netOverHorizon: net, roiOverHorizon: ratio,
      annualisedReturn: ratio * (365 / horizonDays), // simple, not compounded
      paysBackWithinHorizon: paybackHours != null && paybackHours <= horizonH,
      formula: 'net = profit/h × (horizon h − lead h) − cost;  ROI = net ÷ cost;  payback = lead h + cost ÷ profit/h'
    };
  }

  /* --------------------------------------------------------------- Loan */
  // Simple (non-compounding) interest. The game's own loan/bond terms are not published, so the
  // rate, its period and the term are inputs. Outputs the hourly cost of the debt and whether the
  // funded item is expected to out-earn it.
  const PERIOD_HOURS = { hour: 1, day: 24, week: 168, year: 8760 };
  function loan({ principal, ratePct, ratePeriod = 'day', termDays, fundedProfitPerHour = 0, leadTimeHours = 0 } = {}) {
    const P = pos(principal), r = Number(ratePct), term = pos(termDays), per = PERIOD_HOURS[ratePeriod];
    if (!P) return { ok: false, error: 'Enter a principal greater than 0.' };
    if (!Number.isFinite(r) || r < 0) return { ok: false, error: 'Enter an interest rate of 0 or more.' };
    if (!term) return { ok: false, error: 'Enter a term greater than 0 days.' };
    if (!per) return { ok: false, error: 'Unknown rate period.' };
    const termHours = term * 24;
    const periods = termHours / per;
    const interest = P * (r / 100) * periods;
    const hourlyDebtCost = interest / termHours;
    const earn = num(fundedProfitPerHour), lead = Math.max(0, num(leadTimeHours));
    const earnedOverTerm = earn * Math.max(0, termHours - lead);
    return {
      ok: true, principal: P, ratePct: r, ratePeriod, termDays: term, termHours, leadTimeHours: lead,
      totalInterest: interest, totalRepayment: P + interest, hourlyDebtCost,
      fundedProfitPerHour: earn, netHourly: earn - hourlyDebtCost,
      earnedOverTerm, netOverTerm: earnedOverTerm - interest,
      outEarnsDebt: earnedOverTerm > interest,
      breakEvenProfitPerHour: hourlyDebtCost,
      formula: 'interest = principal × rate × (term h ÷ period h);  debt cost/h = interest ÷ term h'
    };
  }

  /* -------------------------------------------------------- Allocation */
  // Rank competing uses of capital by profit per hour (return on capital is reported separately).
  function allocate(options = [], { budget = null } = {}) {
    const cap = pos(budget);
    const rows = (options || []).map((o, i) => {
      const cost = pos(o?.cost), p = Number(o?.profitPerHour), lead = Math.max(0, num(o?.leadTimeHours));
      if (!cost || !Number.isFinite(p)) return null;
      return {
        index: i, name: String(o?.name || `Option ${i + 1}`), cost, profitPerHour: p, leadTimeHours: lead,
        returnPerDay: p * 24 / cost, // return on capital per day
        paybackHours: p > 0 ? lead + cost / p : null,
        affordable: cap == null ? true : cost <= cap
      };
    }).filter(Boolean);
    rows.sort((a, b) => b.profitPerHour - a.profitPerHour);
    rows.forEach((r, i) => {
      r.rank = i + 1;
      const best = rows[0], next = rows[1];
      // Opportunity cost per hour: what you give up by choosing this option instead of the best one;
      // for the best option, what the runner-up would have earned instead.
      r.opportunityCostPerHour = i === 0 ? (next ? Math.max(0, next.profitPerHour) : 0) : Math.max(0, best.profitPerHour) - r.profitPerHour;
    });
    const byReturn = rows.slice().sort((a, b) => b.returnPerDay - a.returnPerDay).map(r => r.name);
    // v2.5.330: with a budget, pick options best-return-first while they still fit.
    let plan = null;
    if (cap != null) {
      let left = cap; const picked = [];
      for (const r of rows.slice().filter(r => r.profitPerHour > 0).sort((a, b) => b.returnPerDay - a.returnPerDay)) {
        if (r.cost <= left) { picked.push(r); left -= r.cost; }
      }
      plan = { picked: picked.map(r => r.name), pickedIndexes: picked.map(r => r.index), spent: cap - left, left, profitPerHour: picked.reduce((a, r) => a + r.profitPerHour, 0) };
    }
    return { ok: true, rows, rankingByReturnOnCapital: byReturn, plan };
  }

  /* ------------------------------------------- Profit per hour per level */
  function profitPerHour(p = {}) {
    const level = pos(p.level) || 1;
    const base = pos(p.baseRatePerLevel);
    if (!base) return { ok: false, error: 'No base production rate for this product.' };
    const sale = p.salePrice == null || p.salePrice === '' ? NaN : Number(p.salePrice);
    if (!Number.isFinite(sale) || sale < 0) return { ok: false, error: 'No sale price available.' };
    const exchange = p.sellMode !== 'contract';
    const fee = exchange ? num(p.exchangeFee, 0.03) : 0;
    const bonus = num(p.productionBonusPct) / 100, abundance = (p.abundancePct == null ? 100 : num(p.abundancePct, 100)) / 100;
    const unitsPerHour = base * level * (1 + bonus) * abundance;
    if (!(unitsPerHour > 0)) return { ok: false, error: 'Units per hour is 0.' };
    const robots = Boolean(p.robots);
    const hourlyWages = num(p.wagePerHourPerLevel) * level * (robots ? num(p.robotMultiplier, 0.97) : 1);
    // labourPerUnit (incl. admin) can be supplied directly from the game's own cost records.
    const labourPerUnit = p.labourPerUnit != null && p.labourPerUnit !== '' && Number.isFinite(Number(p.labourPerUnit)) ? Number(p.labourPerUnit) : hourlyWages / unitsPerHour * (1 + num(p.adminOverheadPct) / 100);
    let inputCostPerUnit = 0, missing = [];
    for (const i of p.inputs || []) {
      const price = i?.unitPrice == null || i?.unitPrice === '' ? NaN : Number(i.unitPrice), q = num(i?.qty);
      if (!Number.isFinite(price)) { missing.push(i?.name || String(i?.id ?? '?')); continue; }
      inputCostPerUnit += q * price;
    }
    const transportPerUnit = num(p.transportUnits) * num(p.transportUnitCost) * (exchange ? 1 : num(p.contractTransportShare, 1)); // 2.5.395 contracts use the same units
    // Contracts carry no exchange fee but are normally sold below market: contractDiscountPct models that.
    const contractDiscount = exchange ? 0 : Math.min(100, Math.max(0, num(p.contractDiscountPct))) / 100;
    const netRevenuePerUnit = sale * (1 - fee) * (1 - contractDiscount);
    const profitPerUnit = netRevenuePerUnit - inputCostPerUnit - labourPerUnit - transportPerUnit;
    const totalCostPerUnit = inputCostPerUnit + labourPerUnit + transportPerUnit;
    return {
      ok: true, incomplete: missing.length > 0, missingInputs: missing,
      level, unitsPerHour, hourlyWages, labourPerUnit, inputCostPerUnit, transportPerUnit,
      netRevenuePerUnit, profitPerUnit, profitPerHour: profitPerUnit * unitsPerHour,
      profitPerHourPerLevel: profitPerUnit * unitsPerHour / level,
      totalCostPerUnit, breakEvenPrice: totalCostPerUnit / ((1 - fee) * (1 - contractDiscount) || 1),
      grossRevenuePerUnit: sale, feePerUnit: sale * fee, contractDiscountPerUnit: sale * (1 - fee) * contractDiscount,
      marginPct: sale > 0 ? profitPerUnit / sale * 100 : null
    };
  }

  // Profit for one building from the planner's own data: the measured units/hour for the planned level,
  // the per-unit input quantities and the prices at the qualities actually used.
  //   unitsPerHour: output/hour at `level` (already includes production speed, events, etc.)
  //   inputs: [{ name, qtyPerUnit, unitPrice }]
  function buildingProfit(b = {}) {
    const level = pos(b.level) || 1, uph = pos(b.unitsPerHour);
    if (!uph) return { ok: false, error: 'No production rate for this building yet.' };
    return profitPerHour({
      ...b, level, baseRatePerLevel: uph / level, productionBonusPct: 0, abundancePct: 100,
      exchangeFee: num(b.exchangeFeePct, 4) / 100,
      inputs: (b.inputs || []).map(i => ({ name: i.name, id: i.id, qty: i.qtyPerUnit, unitPrice: i.unitPrice }))
    });
  }

  // Rank every producible product by profit per hour per level, from VWAP prices.
  //   recipes: [{id,name,materials:[{id,quantity}],transport}]   rates: {name: baseRatePerLevel}
  //   priceOf(resourceId, quality) -> number|null
  function rankProducts({ recipes = [], rates = {}, priceOf, names = new Map(), quality = 0, inputQuality = 0, settings = {} } = {}) {
    const rateByName = new Map(Object.entries(rates || {}).map(([k, v]) => [normalizeName(k), Number(v)]));
    const nameOf = id => (names instanceof Map ? names.get(String(id))?.name || names.get(id)?.name : null) || null;
    const transportUnitCost = settings.transportUnitCost != null ? settings.transportUnitCost : (typeof priceOf === 'function' ? priceOf(13, 0) : null);
    const out = [], skipped = [];
    for (const r of recipes || []) {
      const base = rateByName.get(normalizeName(r?.name));
      if (!pos(base)) { skipped.push({ id: r?.id, name: r?.name, reason: 'no base rate' }); continue; }
      const sale = priceOf ? priceOf(Number(r.id), quality) : null;
      if (sale == null) { skipped.push({ id: r.id, name: r.name, reason: 'no price' }); continue; }
      const inputs = (r.materials || []).map(m => ({
        id: m.id, name: nameOf(m.id) || `#${m.id}`, qty: Number(m.quantity),
        unitPrice: priceOf ? priceOf(Number(m.id), inputQuality) : null
      }));
      const res = profitPerHour({
        ...settings, baseRatePerLevel: base, salePrice: sale, inputs,
        transportUnits: r.transport, transportUnitCost: transportUnitCost ?? 0, level: 1
      });
      if (!res.ok) { skipped.push({ id: r.id, name: r.name, reason: res.error }); continue; }
      out.push({ id: r.id, name: r.name, salePrice: sale, baseRatePerLevel: base, ...res });
    }
    out.sort((a, b) => (a.incomplete - b.incomplete) || (b.profitPerHourPerLevel - a.profitPerHourPerLevel));
    return { rows: out, skipped };
  }

  /* ------------------------------------------- Price series, movers, stats */
  // A series is [[timestampMs, price], ...] sorted ascending.
  function cleanSeries(arr) {
    const out = [];
    for (const p of arr || []) {
      const t = Number(p?.[0]), v = Number(p?.[1]);
      if (Number.isFinite(t) && Number.isFinite(v) && v > 0) out.push([t, v]);
    }
    out.sort((a, b) => a[0] - b[0]);
    return out;
  }

  // Merge the live observation log with the Manager's older daily VWAP history (warehouse items only).
  // history: { "resourceId:quality": [{date:'YYYY-MM-DD', vwap}] }.  Uses the lowest stored quality.
  function seriesForResource(resourceId, logSeries, history) {
    const live = cleanSeries(logSeries);
    let daily = [];
    let bestQ = null;
    for (const key of Object.keys(history || {})) {
      const [rid, q] = key.split(':').map(Number);
      if (rid !== Number(resourceId) || !Number.isFinite(q)) continue;
      if (bestQ == null || q < bestQ) bestQ = q;
    }
    if (bestQ != null) {
      daily = cleanSeries((history[`${Number(resourceId)}:${bestQ}`] || []).map(x => [Date.parse(`${x?.date}T12:00:00Z`), x?.vwap]));
    }
    if (!live.length) return daily;
    const firstLive = live[0][0];
    // Only use daily points that precede the live log so the two sources are never interleaved.
    return daily.filter(([t]) => t < firstLive - 6 * HOUR).concat(live);
  }

  const WINDOWS = {
    '1h': { ms: 1 * HOUR, tol: 20 * 60 * 1000 },
    '24h': { ms: 24 * HOUR, tol: 3 * HOUR },
    '7d': { ms: 7 * 24 * HOUR, tol: 12 * HOUR },
    '30d': { ms: 30 * 24 * HOUR, tol: 24 * HOUR }
  };

  // Compare the latest observation with the one closest to (latest - window). A change is returned
  // only when an observation exists near enough to that age; otherwise null (shown as a dash).
  function changeOver(series, windowKey) {
    const w = WINDOWS[windowKey];
    if (!w || !series || series.length < 2) return null;
    const [tNow, vNow] = series[series.length - 1];
    const target = tNow - w.ms;
    let best = null, bestD = Infinity;
    for (let i = series.length - 2; i >= 0; i--) {
      const d = Math.abs(series[i][0] - target);
      if (d < bestD) { bestD = d; best = series[i]; }
      if (series[i][0] < target - w.tol) break;
    }
    if (!best || bestD > w.tol || best[1] <= 0) return null;
    return (vNow / best[1] - 1) * 100;
  }

  function volatility(series, windowMs = 7 * 24 * HOUR) {
    if (!series || series.length < 3) return null;
    const cut = series[series.length - 1][0] - windowMs;
    const pts = series.filter(([t]) => t >= cut);
    if (pts.length < 3) return null;
    const rets = [];
    for (let i = 1; i < pts.length; i++) rets.push(pts[i][1] / pts[i - 1][1] - 1);
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1 || 1);
    return Math.sqrt(variance) * 100;
  }

  function rangeStats(series) {
    if (!series || !series.length) return null;
    let lo = Infinity, hi = -Infinity, sum = 0;
    for (const [, v] of series) { if (v < lo) lo = v; if (v > hi) hi = v; sum += v; }
    const last = series[series.length - 1][1];
    return { low: lo, high: hi, average: sum / series.length, last, count: series.length, positionPct: hi > lo ? (last - lo) / (hi - lo) * 100 : null };
  }

  function sliceRange(series, rangeKey, nowMs = null) {
    if (!series || !series.length) return [];
    const spans = { '1D': 24, '1W': 168, '1M': 720, '3M': 2160, '1Y': 8760 };
    if (rangeKey === 'MAX' || !spans[rangeKey]) return series;
    const end = nowMs ?? series[series.length - 1][0];
    return series.filter(([t]) => t >= end - spans[rangeKey] * HOUR);
  }

  // moversTable: seriesById = Map|object of resourceId -> series. Ranked by |24h change|.
  function moversTable(seriesById, names = new Map()) {
    const entries = seriesById instanceof Map ? [...seriesById.entries()] : Object.entries(seriesById || {});
    const rows = [];
    for (const [id, s] of entries) {
      const series = cleanSeries(s);
      if (series.length < 2) continue;
      const nm = names instanceof Map ? (names.get(String(id))?.name || names.get(Number(id))?.name) : null;
      rows.push({
        id: Number(id), name: nm || `Resource #${id}`, price: series[series.length - 1][1],
        lastAt: series[series.length - 1][0], observations: series.length,
        change: { '1h': changeOver(series, '1h'), '24h': changeOver(series, '24h'), '7d': changeOver(series, '7d') },
        volatility7d: volatility(series)
      });
    }
    const ranked = rows.filter(r => r.change['24h'] != null).sort((a, b) => Math.abs(b.change['24h']) - Math.abs(a.change['24h']));
    const unranked = rows.filter(r => r.change['24h'] == null).sort((a, b) => a.name.localeCompare(b.name));
    return { ranked, unranked };
  }

  // v2.5.330: movers from SimcoTools trade closes (stored with each current-price row).
  // priceAt(closes, t) = the close in effect at time t (last trade at or before t).
  function priceAt(closes, t) {
    let v = null;
    for (const [ct, p] of closes || []) { if (ct <= t) v = p; else break; }
    return v;
  }
  function moversFromTrend(rows, names = new Map()) {
    const out = [];
    for (const r of rows || []) {
      const id = Number(r?.resourceId), q = Number(r?.quality), price = Number(r?.price);
      const tr = r?.trend; if (!(id > 0) || !(price > 0) || !tr) continue;
      const closes = cleanSeries(tr.closes);
      const now = Date.parse(String(r.fetchedAt || '')) || (closes.length ? closes[closes.length - 1][0] : Date.now());
      const chg = ms => { const ref = priceAt(closes, now - ms); return ref > 0 ? (price / ref - 1) * 100 : null; };
      const nm = names instanceof Map ? (names.get(String(id))?.name || names.get(id)?.name) : null;
      const lastAt = closes.length ? closes[closes.length - 1][0] : null;
      out.push({ id, quality: q, name: nm || `Resource #${id}`, price, lastTradeAt: lastAt, fetchedAt: now,
        change: { '1h': chg(HOUR), '24h': chg(24 * HOUR), '3d': chg(72 * HOUR) },
        trades24h: closes.filter(([t]) => t >= now - 24 * HOUR).length,
        dayVwap: tr.day?.vwap ?? null, dayVwapPct: Number.isFinite(Number(tr.day?.vwapChangePct)) && tr.day?.vwapChangePct != null ? Number(tr.day.vwapChangePct) : null });
    }
    const key = r => r.change['24h'] ?? r.dayVwapPct;
    const ranked = out.filter(r => key(r) != null).sort((a, b) => Math.abs(key(b)) - Math.abs(key(a)));
    const unranked = out.filter(r => key(r) == null);
    return { ranked, unranked };
  }

  function seriesToCsv(series) {
    return 'timestamp,iso,price\n' + (series || []).map(([t, v]) => `${t},${new Date(t).toISOString()},${v}`).join('\n') + '\n';
  }

  // Lowest-quality VWAP per resource, used for the observation log and "headline" price.
  function headlineFromVwapRows(rows) {
    const best = new Map();
    for (const row of rows || []) {
      const id = Number(row?.resourceId), q = Number(row?.quality), v = Number(row?.value);
      if (!(id > 0) || !Number.isFinite(q) || !(v > 0)) continue;
      const cur = best.get(id);
      if (!cur || q < cur.q) best.set(id, { q, v });
    }
    return best;
  }

  // Append observations to a log object { v:1, realm, series:{id:[[t,p],...]}, updatedAt }.
  // Pure: returns a new log. Skips an id when its last point is newer than minGapMs.
  function appendObservations(log, rows, atMs, { minGapMs = 10 * 60 * 1000, maxPoints = 2200, maxAgeMs = 120 * 24 * HOUR } = {}) {
    const next = { v: 1, realm: log?.realm ?? null, series: { ...(log?.series || {}) }, updatedAt: new Date(atMs).toISOString() };
    let added = 0;
    for (const [id, { v }] of headlineFromVwapRows(rows)) {
      const arr = Array.isArray(next.series[id]) ? next.series[id].slice() : [];
      const last = arr[arr.length - 1];
      if (last && atMs - last[0] < minGapMs) { next.series[id] = arr; continue; }
      arr.push([atMs, Math.round(v * 10000) / 10000]); added++;
      while (arr.length > maxPoints) arr.shift();
      while (arr.length && atMs - arr[0][0] > maxAgeMs) arr.shift();
      next.series[id] = arr;
    }
    next.added = added;
    return next;
  }

  /* ------------------------------------------- Production cost history (v2.5.331) */
  // One entry per production run: { k: 'buildingId|startedISO', b, bn, id, q, c (unit cost), t (start), n (amount) }.
  // Sources (both from the game API, nothing estimated):
  //   buildings[].busy.resource.unitCost  — the running batch ("Cost per unit" on the building page)
  //   /api/v2/companies/buildings/<id>/history/ rows — price = unit cost of each past batch
  const PCH_CAP = 4000;
  function pchEntry(b, bn, id, q, c, t, n) {
    const ms = Date.parse(String(t || ''));
    if (!(Number(b) > 0) || !(Number(id) > 0) || !Number.isFinite(Number(q)) || !(Number(c) > 0) || !Number.isFinite(ms)) return null;
    const iso = new Date(ms).toISOString();
    return { k: `${Number(b)}|${iso}`, b: Number(b), bn: String(bn || ''), id: Number(id), q: Number(q), c: Number(c), t: iso, n: Number(n) > 0 ? Number(n) : null };
  }
  function productionCostEntriesFromBuildings(rows) {
    const out = [];
    for (const b of Array.isArray(rows) ? rows : []) {
      const busy = b?.busy, r = busy?.resource;
      const e = pchEntry(b?.id, b?.name, r?.kind ?? r?.resourceId, r?.quality, r?.unitCost, busy?.started, r?.amount ?? busy?.amount);
      if (e) out.push(e);
    }
    return out;
  }
  function productionCostEntriesFromHistory(buildingId, rows, buildingName = '') {
    const out = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      const e = pchEntry(buildingId, buildingName, r?.kind, r?.quality, r?.price, r?.datetime, r?.outputAmount ?? r?.amount);
      if (e) out.push(e);
    }
    return out;
  }
  // Merge by key (a later sighting of the same run updates it), oldest first, capped.
  function mergeProductionCostHistory(existing, entries, cap = PCH_CAP) {
    const map = new Map(), idx = new Map();
    const gk = e => `${e.b}|${e.id}|${e.q}`;
    const index = e => { const g = gk(e); if (!idx.has(g)) idx.set(g, []); idx.get(g).push([Date.parse(e.t), e.k]); };
    for (const e of Array.isArray(existing) ? existing : []) if (e && e.k && !map.has(e.k)) { map.set(e.k, e); index(e); }
    let added = 0, changed = 0;
    for (const e of Array.isArray(entries) ? entries : []) {
      if (!e || !e.k) continue;
      let old = map.get(e.k);
      if (!old) {
        // Same building + product + quality starting within 5 s = the same run seen from another source.
        const et = Date.parse(e.t);
        const hit = (idx.get(gk(e)) || []).find(([t]) => Math.abs(t - et) <= 5000);
        if (hit) old = map.get(hit[1]);
      }
      if (!old) { map.set(e.k, e); index(e); added++; continue; }
      const next = { ...old, ...Object.fromEntries(Object.entries(e).filter(([k, v]) => k !== 'k' && k !== 't' && v != null && v !== '')) };
      if (next.c !== old.c || next.n !== old.n || next.bn !== old.bn) { map.set(old.k, next); changed++; }
    }
    const list = [...map.values()].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    return { list: list.slice(-cap), added, changed };
  }
  // Runs of one product/quality, oldest first; current = newest run, last = the run before it.
  function productionCostSummary(history, id, q) {
    const runs = (Array.isArray(history) ? history : []).filter(e => Number(e?.id) === Number(id) && Number(e?.q) === Number(q) && Number(e?.c) > 0)
      .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    if (!runs.length) return null;
    const current = runs[runs.length - 1], last = runs.length > 1 ? runs[runs.length - 2] : null;
    return { runs, current, last, diff: last ? current.c - last.c : null, diffPct: last ? (current.c - last.c) / last.c * 100 : null };
  }

  // v2.5.338 economy phase. auth-data temporals.economyState (0 = recession, seen in R2 capture
  // 2026-10-23). The game's FAQ: the phase changes production quantities; wages per hour do not change,
  // so labour per unit moves inversely with the rate. A running batch keeps the phase it started in.
  // Log entries: { s: state, f: first seen ISO, l: last seen ISO }.
  function economyLogAppend(log, state, at) {
    const st = Number(state), t = Date.parse(String(at || ''));
    const list = Array.isArray(log) ? log.filter(e => e && Number.isFinite(Number(e.s)) && Number.isFinite(Date.parse(e.f))).map(e => ({ ...e })) : [];
    if (!Number.isFinite(st) || !Number.isFinite(t)) return list;
    const iso = new Date(t).toISOString(), last = list[list.length - 1];
    if (last && Date.parse(last.l || last.f) > t) return list; // older observation than what we have: ignore
    if (last && Number(last.s) === st) last.l = iso; else list.push({ s: st, f: iso, l: iso });
    return list.slice(-30);
  }
  // Phase in force at `at`: inside or after an entry's seen window → that entry; before the first entry or in a
  // gap between two different phases → null (unknown).
  function economyStateAt(log, at) {
    const list = Array.isArray(log) ? log : [], t = Date.parse(String(at || ''));
    if (!list.length || !Number.isFinite(t)) return null;
    if (t < Date.parse(list[0].f)) return null; // before the first observation: phase unknown (2.5.340)
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (t >= Date.parse(e.f)) {
        if (t <= Date.parse(e.l || e.f) || i === list.length - 1) return { state: Number(e.s), assumed: false };
        return null; // after this entry was last seen but before the next phase was first seen
      }
    }
    return null;
  }
  const ECONOMY_NAMES = { 0: 'recession', 1: 'normal', 2: 'boom' };
  function economyName(state) { return ECONOMY_NAMES[Number(state)] || (Number.isFinite(Number(state)) ? `phase ${Number(state)}` : 'unknown'); }
  // Workers cost per PRODUCED unit of a warehouse lot. A lot can also hold bought units (cost.market) that
  // carry no workers cost; dividing by the whole amount understates labour. Produced units are estimated
  // from the lot's produced share of cost.
  function lotWorkersPerProducedUnit(lot) {
    const c = lot && lot.cost, amount = Number(lot && lot.amount), workers = Number(c && c.workers);
    if (!(amount > 0) || !(workers > 0)) return null;
    let total = 0; for (const v of Object.values(c)) { const n = Number(v); if (Number.isFinite(n)) total += n; }
    const market = Math.max(0, Number(c.market) || 0);
    const share = total > 0 ? (total - market) / total : 1;
    if (!(share > 0)) return null;
    const produced = amount * Math.min(1, share);
    return { workersPerUnit: workers / produced, producedUnits: produced, boughtUnits: amount - produced, mixed: market > 0 };
  }
  // Rate to project profit with. measured = running batch (its own phase). If the economy changed since
  // the batch started, use a rate measured earlier in the current phase, else the reference rate (estimate).
  function projectionRate({ measuredRate, batchPhase, currentPhase, phaseRate, referenceRate } = {}) {
    const m = pos(measuredRate);
    const changed = batchPhase != null && currentPhase != null && String(batchPhase) !== String(currentPhase);
    if (!changed) return { rate: m || null, source: 'measured', changed: false };
    if (pos(phaseRate)) return { rate: pos(phaseRate), source: 'phase-measured', changed: true };
    if (pos(referenceRate)) return { rate: pos(referenceRate), source: 'reference', changed: true };
    return { rate: m || null, source: 'measured-stale', changed: true };
  }

  // 2.5.340 when the log can't say which phase a running batch started in (it started before the first
  // observation), compare its measured rate with the normal-economy reference rate (same modifiers). A batch
  // more than `tolPct` away from it cannot be a normal-economy batch. Only used when the economy is normal now.
  function batchPhaseFromRate(measuredRate, referenceRate, tolPct = 5) {
    const m = pos(measuredRate), r = pos(referenceRate);
    if (!m || !r) return null;
    const diffPct = (m - r) / r * 100;
    return Math.abs(diffPct) > tolPct ? { differs: true, diffPct } : { differs: false, diffPct };
  }

  // v2.5.341 effective administration overhead, as the game computes it (game bundle index-*.js, 2026-10-23):
  //   effective = base − (base − 1) × COO / 100, base = /administration-overhead/ (e.g. 1.6176).
  //   COO = floor(diminish(floor(Σ))) over active executives: COO 'o' full coo skill, COO apprentice 'v' half
  //   (only if the academy's active size ≥ 5), other C-suite ('f','m','t') a quarter; staff '1'–'5' excluded.
  //   Not active: settling in (C-suite/apprentice started < settle s ago, not accelerated, not candidate), in
  //   training (training started < train s ago, not accelerated), on strike. Diminish: >80 → 80+(x−80)/2, >60 → 60+(x−60)/2.
  //   trainS / settleS come from the game page config (window.reactjs.props), never hardcoded.
  const EXEC_CSUITE = ['o', 'f', 'm', 't'], EXEC_APPRENTICE = { v: 'coo', x: 'cfo', y: 'cmo', z: 'cto' }, EXEC_STAFF = ['1', '2', '3', '4', '5'];
  const EXEC_APPRENTICE_ACADEMY = { v: 5, x: 10, y: 15, z: 20 }; // game: Nh*1..Nh*4, Nh = 5
  function academyActiveSize(buildings) {
    return (Array.isArray(buildings) ? buildings : []).filter(b => b && b.kind === 'y' && !b.purchasedRecently)
      .reduce((n, b) => n + (!b.busy && !String(b.position || '').startsWith('l') ? Number(b.size) || 0 : 0), 0);
  }
  function executiveSkill(executives, skill, { now = Date.now(), trainS, settleS, academyActive = 0 } = {}) {
    const list = Array.isArray(executives) ? executives : [];
    const pos = e => String(e && e.currentWorkHistory && e.currentWorkHistory.position || '');
    const active = list.filter(e => e && e.currentWorkHistory && !EXEC_STAFF.includes(pos(e))).filter(e => {
      const p = pos(e), w = e.currentWorkHistory, start = Date.parse(w.start);
      if ((EXEC_CSUITE.includes(p) || EXEC_APPRENTICE[p]) && now - start < settleS * 1000 && !w.accelerated && !e.isCandidate) return false;
      const t = e.currentTraining, ts = t && !t.accelerated && Date.parse(t.datetime);
      if (ts && ts > now - trainS * 1000) return false;
      if (e.strikeUntil && Date.parse(e.strikeUntil) > now) return false;
      return !EXEC_APPRENTICE[p] || academyActive >= EXEC_APPRENTICE_ACADEMY[p];
    });
    const own = { coo: 'o', cfo: 'f', cmo: 'm', cto: 't' }[skill];
    const raw = Math.floor(active.map(e => {
      const p = pos(e), v = Number(e.skills && e.skills[skill]) || 0;
      if (p === own) return v;
      if (EXEC_APPRENTICE[p] === skill) return v / 2;
      return EXEC_CSUITE.includes(p) ? v / 4 : 0;
    }).reduce((a, b) => a + b, 0));
    let r = raw; if (r > 80) r = 80 + (r - 80) / 2; if (r > 60) r = 60 + (r - 60) / 2;
    return Math.floor(r);
  }
  function effectiveAdminOverhead({ base, executives, buildings, now = Date.now(), trainS, settleS } = {}) {
    const b = Number(base);
    if (!(b >= 1) || !Array.isArray(executives) || !pos(trainS) || !pos(settleS)) return null;
    const coo = executiveSkill(executives, 'coo', { now, trainS, settleS, academyActive: academyActiveSize(buildings) });
    const eff = b - (b - 1) * coo / 100;
    return { factor: eff, pct: (eff - 1) * 100, basePct: (b - 1) * 100, reductionPct: (b - 1) * coo, coo };
  }

  // v2.5.374 Executives tab. Roster rows from captured /executives/ data. Name/age/salary/trainings field names are
  // read from the first key present (not verified against the game bundle); missing → null, shown as —.
  const EXEC_ROLE = { o: 'COO', f: 'CFO', m: 'CMO', t: 'CTO', v: 'COO Apprentice', x: 'CFO Apprentice', y: 'CMO Apprentice', z: 'CTO Apprentice' };
  const EXEC_ORDER = ['o', 'v', 'f', 'x', 'm', 'y', 't', 'z'];
  const firstKey = (o, keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return null; };
  function executiveRoster(executives, { now = Date.now(), trainS, settleS } = {}) {
    return (Array.isArray(executives) ? executives : []).filter(e => e && e.currentWorkHistory).map(e => {
      const p = String(e.currentWorkHistory.position || ''), sk = e.skills || {};
      const born = firstKey(e, ['dateOfBirth', 'birthDate', 'born']);
      const ageRaw = firstKey(e, ['age']), age = ageRaw != null ? Number(ageRaw) : born && Date.parse(born) ? Math.floor((now - Date.parse(born)) / 31557600000) : null;
      const tr = firstKey(e, ['trainingsCount', 'trainingCount', 'timesTrained', 'trainings', 'nrTrainings']);
      const trainings = Array.isArray(tr) ? tr.length : tr != null && Number.isFinite(Number(tr)) ? Number(tr) : null;
      const salary = firstKey(e, ['salary', 'wage', 'dailySalary']);
      const t = e.currentTraining, ts = t && !t.accelerated && Date.parse(t.datetime), start = Date.parse(e.currentWorkHistory.start);
      const status = e.strikeUntil && Date.parse(e.strikeUntil) > now ? 'on strike'
        : pos(trainS) && ts && ts > now - trainS * 1000 ? 'training'
        : pos(settleS) && EXEC_ROLE[p] && now - start < settleS * 1000 && !e.currentWorkHistory.accelerated && !e.isCandidate ? 'settling in' : 'active';
      return { id: e.id ?? null, position: p, role: EXEC_ROLE[p] || (EXEC_STAFF.includes(p) ? 'Staff' : p || '—'), staff: EXEC_STAFF.includes(p),
        name: firstKey(e, ['name', 'fullName']), age: Number.isFinite(age) ? age : null, salary: salary != null && Number.isFinite(Number(salary)) ? Number(salary) : null,
        trainings, status, trainingEndsAt: ts && pos(trainS) ? new Date(ts + trainS * 1000).toISOString() : null,
        skills: { coo: num(sk.coo), cfo: num(sk.cfo), cmo: num(sk.cmo), cto: num(sk.cto) } };
    }).sort((a, b) => (EXEC_ORDER.indexOf(a.position) + 1 || 99) - (EXEC_ORDER.indexOf(b.position) + 1 || 99));
  }
  // Base labour $/day: game wage/h/level × level × 24 over producing buildings (before admin overhead).
  function dailyBaseLabour(c, buildings) {
    if (!gameConstantsOk(c)) return null;
    return (Array.isArray(buildings) ? buildings : []).filter(b => b && b.busy && b.busy.resource).reduce((a, b) => {
      const w = gameWagePerLevel(c, String(b.kind || ''), Boolean(b.robotsSpecialization));
      return a + (Number(w) || 0) * Math.max(1, Number(b.level ?? b.size) || 1) * 24;
    }, 0);
  }
  // What-if admin: same game formula with executives changed (skills added, positions moved or removed).
  function executiveAdminWhatIf({ base, executives, buildings, now = Date.now(), trainS, settleS, edit } = {}) {
    const list = (Array.isArray(executives) ? executives : []).map(e => edit ? edit(JSON.parse(JSON.stringify(e))) : e).filter(Boolean);
    return effectiveAdminOverhead({ base, executives: list, buildings, now, trainS, settleS });
  }
  // COO ROI: admin saved per day by the executives' COO reduction vs their salaries per day.
  function executiveRoi({ dailyLabour, reductionPct, salariesPerDay } = {}) {
    const L = Number(dailyLabour), r = Number(reductionPct);
    if (!(L > 0) || !Number.isFinite(r)) return null;
    const saved = L * r / 100, sal = Number(salariesPerDay);
    return { savedPerDay: saved, salariesPerDay: Number.isFinite(sal) ? sal : null, netPerDay: Number.isFinite(sal) ? saved - sal : null, paysForItself: Number.isFinite(sal) ? saved >= sal : null };
  }

  // v2.5.342 game constants (/api/v2/constants/core|buildings|resources/, public). Game code (tSe/eSe):
  //   base/level = producedPerHourRaw × (AVERAGE_SALARY / SALARY_MID[economyState])^building.salaryModifier
  //   rate/level = base × abundance%/100 (abundance resources only) × (1 + event/100) ÷ (1 − bonus/100)
  //   wage $/h/level = AVERAGE_SALARY × building.salaryModifier × (0.97 with robots)
  function gameConstantsOk(c) { return !!(c && c.core && c.buildings && c.resources && pos(c.core.AVERAGE_SALARY) && c.core.SALARY_MID); }
  function gameBaseRate(c, resourceId, economyState) {
    if (!gameConstantsOk(c)) return null;
    const r = c.resources[String(resourceId)], b = r && c.buildings[String(r.producedAt)];
    const mid = pos(c.core.SALARY_MID[String(economyState)]), raw = pos(r && r.producedPerHourRaw), sm = Number(b && b.salaryModifier);
    if (!raw || !mid || !Number.isFinite(sm)) return null;
    return raw * Math.pow(c.core.AVERAGE_SALARY / mid, sm);
  }
  function gameRatePerLevel(c, resourceId, economyState, { eventPct = 0, bonusPct = 0, abundancePct = null } = {}) {
    const base = gameBaseRate(c, resourceId, economyState);
    if (base == null || bonusPct >= 100) return null;
    const ab = abundancePct != null && Number.isFinite(Number(abundancePct)) ? Number(abundancePct) / 100 : 1;
    return base * ab * (1 + (Number(eventPct) || 0) / 100) / (1 - (Number(bonusPct) || 0) / 100);
  }
  function gameWagePerLevel(c, buildingKind, robots = false) {
    if (!gameConstantsOk(c)) return null;
    const b = c.buildings[String(buildingKind)], sm = Number(b && b.salaryModifier);
    return Number.isFinite(sm) ? c.core.AVERAGE_SALARY * sm * (robots ? 0.97 : 1) : null;
  }
  // v2.5.348 the game's Profit Calculator (GamePages bundle, encyclopedia resource page, read 2026-10-24):
  //   units/h/level L = tSe(resource, productionModifier, recreationBonus, 90, 1, base, event): abundance resources
  //     (game list xjr) always at 90 % abundance, whatever your building's abundance is.
  //   labour/unit = AVERAGE_SALARY × salaryModifier ÷ L × admin factor (no robots, not rounded).
  //   warehouse input = cheapest lot of that resource, any quality: Σ cost ÷ amount (not rounded); none → cheapest listing.
  //   profit/unit = cheapest listing (any quality) − (Σ qty × input + labour); profit/h/level = profit/unit × L.
  // The 90 % and the resource list are literals in the game's code, not in its API.
  const GAME_PROFIT_CALC_ABUNDANCE_PCT = 90;
  const GAME_ABUNDANCE_RESOURCE_IDS = [10, 14, 15, 42, 44, 68, 74, 104, 105]; // Crude oil, Minerals, Bauxite, Iron ore, Sand, Gold ore, Methane, Clay, Limestone
  function isAbundanceResource(id) { return GAME_ABUNDANCE_RESOURCE_IDS.includes(Number(id)); }
  // v2.5.350 colour band for a building's abundance (user's thresholds): ≥ 90 % good, > 85 % warn, ≤ 85 % bad.
  function abundanceTone(pct) { const v = Number(pct); if (pct == null || pct === '' || !Number.isFinite(v)) return null; return v >= 90 ? 'good' : v > 85 ? 'warn' : 'bad'; }
  function warehouseUnitCostAsGame(lots, resourceId) {
    let best = null;
    for (const l of Array.isArray(lots) ? lots : []) {
      if (!l || Number(l.kind) !== Number(resourceId) || !l.cost || typeof l.cost !== 'object') continue;
      const amount = Number(l.amount); if (!(amount > 0)) continue;
      const unitCost = Object.values(l.cost).reduce((a, v) => a + Number(v), 0) / amount;
      if (Number.isFinite(unitCost) && (!best || unitCost < best.unitCost)) best = { unitCost, quality: Number(l.quality), amount };
    }
    return best && best.unitCost > 0 ? best : null; // game: a $0 cheapest lot falls back to the market price
  }
  function gameProfitCalcRatePerLevel(c, resourceId, economyState, { eventPct = 0, bonusPct = 0 } = {}) {
    return gameRatePerLevel(c, resourceId, economyState, { eventPct, bonusPct, abundancePct: isAbundanceResource(resourceId) ? GAME_PROFIT_CALC_ABUNDANCE_PCT : null });
  }
  // Which economy phase a measured batch rate belongs to: the phase whose game rate is closest, if within tolPct.
  function phaseFromMeasuredRate(c, resourceId, measuredPerLevel, opts = {}, tolPct = 2) {
    const m = pos(measuredPerLevel); if (!m || !gameConstantsOk(c)) return null;
    let best = null;
    for (const st of Object.keys(c.core.SALARY_MID)) {
      const r = gameRatePerLevel(c, resourceId, st, opts); if (!r) continue;
      const d = Math.abs(m - r) / r * 100;
      if (!best || d < best.diffPct) best = { state: Number(st), diffPct: d, rate: r };
    }
    return best && best.diffPct <= tolPct ? best : null;
  }
  // v2.5.345 recipes as the game defines them: inputs per unit = constants resources[id].producedFrom
  // ({inputId: qty}), transport units = .transportation. The bundled recipes.json is only the fallback.
  function recipesFromGameConstants(recipes, c) {
    const list = Array.isArray(recipes) ? recipes : [];
    if (!gameConstantsOk(c)) return list;
    return list.map(r => {
      const g = r && c.resources[String(r.id)];
      if (!g || !g.producedFrom || typeof g.producedFrom !== 'object') return r;
      const materials = Object.entries(g.producedFrom).map(([id, q]) => ({ id: Number(id), quantity: Number(q) })).filter(m => m.id > 0 && Number.isFinite(m.quantity) && m.quantity > 0);
      const t = Number(g.transportation);
      return { ...r, materials, transport: Number.isFinite(t) && t >= 0 ? t : r.transport, recipeSource: 'game-constants' };
    });
  }
  // v2.5.345 building outputs as the game defines them: every resource lists the building letter it is produced at
  // (constants resources[id].producedAt). Adds buildings missing from buildings.json (research labs …) and outputs
  // missing from a known building (e.g. Cream egg); an output the game places at another building is dropped.
  function buildingsFromGameConstants(defs, recipes, c) {
    const list = Array.isArray(defs) ? defs : [];
    if (!gameConstantsOk(c)) return list;
    const at = new Map(), placeOf = new Map();
    for (const r of Array.isArray(recipes) ? recipes : []) {
      const g = r && c.resources[String(r.id)]; const l = g && g.producedAt != null ? String(g.producedAt) : '';
      if (!l || !r.name) continue;
      placeOf.set(normalizeName(r.name), l);
      if (!at.has(l)) at.set(l, []); at.get(l).push(String(r.name));
    }
    const merge = (letter, existing) => {
      const out = [], seen = new Set();
      for (const p of [...(existing || []), ...(at.get(letter) || [])]) {
        const k = normalizeName(p); if (!k || seen.has(k)) continue;
        const where = placeOf.get(k); if (where != null && where !== letter) continue;
        seen.add(k); out.push(p);
      }
      return out;
    };
    const known = new Set(list.map(d => String(d && d.id)));
    const next = list.map(d => (d && at.has(String(d.id)) ? { ...d, produces: merge(String(d.id), d.produces) } : d));
    for (const [letter, names] of at) {
      if (known.has(letter) || !names.length) continue;
      const cat = String((c.buildings[letter] && c.buildings[letter].category) || '');
      next.push({ id: letter, name: null, category: cat ? cat[0].toUpperCase() + cat.slice(1) : 'Other', produces: merge(letter, []), source: 'game-constants' });
    }
    return next;
  }
  // v2.5.357 Smart insights (pure). One product on the game's Profit Calculator basis (the building card's headline):
  //   L = game rate/level (abundance resources at 90 %, or abundancePct when given), labour = wage ÷ L × (1 + admin%),
  //   inputs = constants producedFrom qty × inputCostOf(id), profit/h/level = (salePrice − sourcing) × L.
  function gameCalcProduct({ c, resourceId, economyState, eventPct = 0, bonusPct = 0, adminPct = 0, robots = false, salePrice = null, inputCostOf, abundancePct = null } = {}) {
    if (!gameConstantsOk(c)) return { ok: false, error: 'no game constants' };
    const rid = Number(resourceId), r = c.resources[String(rid)];
    if (!r) return { ok: false, error: 'unknown resource' };
    const opts = { eventPct: Number(eventPct) || 0, bonusPct: Number(bonusPct) || 0 };
    const L = abundancePct != null && isAbundanceResource(rid) ? gameRatePerLevel(c, rid, economyState, { ...opts, abundancePct }) : gameProfitCalcRatePerLevel(c, rid, economyState, opts);
    const wage = gameWagePerLevel(c, r.producedAt, robots);
    if (!pos(L) || wage == null || !(wage >= 0)) return { ok: false, error: 'no rate' };
    const labourPerUnit = wage / L * (1 + Math.max(0, Number(adminPct) || 0) / 100);
    const inputs = [], missing = []; let inputCost = 0;
    for (const [id, q] of Object.entries(r.producedFrom && typeof r.producedFrom === 'object' ? r.producedFrom : {})) {
      const qty = Number(q); if (!(qty > 0)) continue;
      const raw = typeof inputCostOf === 'function' ? inputCostOf(Number(id)) : null;
      const p = raw != null && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null;
      if (p == null) missing.push(Number(id)); else inputCost += qty * p;
      inputs.push({ id: Number(id), qty, unitCost: p });
    }
    const sale = Number(salePrice), hasSale = salePrice != null && salePrice !== '' && Number.isFinite(sale) && sale > 0;
    const sourcing = inputCost + labourPerUnit, profitPerUnit = hasSale ? sale - sourcing : null;
    return { ok: true, resourceId: rid, ratePerLevel: L, wagePerLevel: wage, labourPerUnit, inputCostPerUnit: inputCost, sourcingCostPerUnit: sourcing, inputs, missing, complete: missing.length === 0, salePrice: hasSale ? sale : null, profitPerUnit, profitPerHourPerLevel: profitPerUnit == null ? null : profitPerUnit * L };
  }
  // Idea 1: every tradable product a building kind can make, ranked by profit/h/level (game basis).
  // priceOf(id) -> number | {price, quality, source} | null. Complete, priced products first; then incomplete; then unpriced.
  function rankBuildingProducts({ c, buildingKind, economyState, bonusPct = 0, adminPct = 0, robots = false, eventPctOf, priceOf, inputCostOf } = {}) {
    if (!gameConstantsOk(c) || buildingKind == null || buildingKind === '') return [];
    const out = [];
    for (const [id, r] of Object.entries(c.resources)) {
      if (!r || String(r.producedAt) !== String(buildingKind) || r.isExchangeTradable === false) continue;
      const rid = Number(id), sale = typeof priceOf === 'function' ? priceOf(rid) : null;
      const salePrice = sale != null && typeof sale === 'object' ? sale.price : sale;
      const res = gameCalcProduct({ c, resourceId: rid, economyState, eventPct: typeof eventPctOf === 'function' ? eventPctOf(rid) : 0, bonusPct, adminPct, robots, salePrice, inputCostOf });
      if (res.ok) out.push({ ...res, sale: sale != null && typeof sale === 'object' ? sale : null });
    }
    const tier = x => (x.profitPerHourPerLevel == null ? 2 : x.complete ? 0 : 1);
    return out.sort((a, b) => tier(a) - tier(b) || (b.profitPerHourPerLevel ?? 0) - (a.profitPerHourPerLevel ?? 0) || a.resourceId - b.resourceId);
  }
  // Idea 2: how long warehouse stock of each input lasts at the current production of all buildings.
  //   buildings: [{id, name, kind, level, productId, quality}]   lots: warehouse lots {kind, quality, amount}
  //   Stock counts lots at quality ≥ the lowest quality any consumer needs (production quality − 1, the game's rule).
  //   Own production of the same resource is subtracted (net use). buyQty covers `hours` of net use.
  function inputRunOut({ c, buildings, economyState, bonusPct = 0, eventPctOf, abundanceOf, lots, hours = 24 } = {}) {
    if (!gameConstantsOk(c)) return [];
    const use = new Map(), make = new Map();
    for (const b of Array.isArray(buildings) ? buildings : []) {
      const pid = Number(b && b.productId), res = pid > 0 ? c.resources[String(pid)] : null;
      if (!res) continue;
      let ab = null;
      if (isAbundanceResource(pid)) { const v = typeof abundanceOf === 'function' ? abundanceOf(b, pid) : null; ab = v != null && Number.isFinite(Number(v)) ? Number(v) : GAME_PROFIT_CALC_ABUNDANCE_PCT; }
      const L = gameRatePerLevel(c, pid, economyState, { eventPct: typeof eventPctOf === 'function' ? Number(eventPctOf(pid)) || 0 : 0, bonusPct: Number(bonusPct) || 0, abundancePct: ab });
      if (!pos(L)) continue;
      const rate = L * Math.max(1, Number(b.level) || 1);
      make.set(pid, (make.get(pid) || 0) + rate);
      const minQ = Math.max(0, (Number(b.quality) || 0) - 1);
      for (const [id, q] of Object.entries(res.producedFrom && typeof res.producedFrom === 'object' ? res.producedFrom : {})) {
        const qty = Number(q); if (!(qty > 0)) continue;
        const e = use.get(Number(id)) || { id: Number(id), usePerHour: 0, minQuality: Infinity, users: [] };
        e.usePerHour += qty * rate; e.minQuality = Math.min(e.minQuality, minQ);
        if (b.name && !e.users.includes(String(b.name))) e.users.push(String(b.name));
        use.set(Number(id), e);
      }
    }
    const H = pos(hours) || 24, rows = [];
    for (const e of use.values()) {
      const minQuality = Number.isFinite(e.minQuality) ? e.minQuality : 0;
      const stock = (Array.isArray(lots) ? lots : []).filter(l => l && Number(l.kind) === e.id && Number(l.quality) >= minQuality).reduce((a, l) => a + (Number(l.amount) || 0), 0);
      const madePerHour = make.get(e.id) || 0, net = e.usePerHour - madePerHour;
      const hoursLeft = net > 1e-9 ? stock / net : null;
      rows.push({ ...e, minQuality, stock, madePerHour, netPerHour: net, hoursLeft, hours: H, buyQty: net > 1e-9 ? Math.max(0, Math.ceil(net * H - stock)) : 0 });
    }
    return rows.sort((a, b) => (a.hoursLeft == null) - (b.hoursLeft == null) || (a.hoursLeft ?? 0) - (b.hoursLeft ?? 0) || a.id - b.id);
  }
  // Idea 3: make or buy one input. ownCost = sourcing cost/unit if you made it (null = can't make it); marketPrice = cheapest
  // listing at the needed quality. saves > 0 means making is cheaper by that much per unit.
  function makeOrBuy(ownCost, marketPrice) {
    const o = ownCost != null && Number.isFinite(Number(ownCost)) ? Number(ownCost) : null, m = pos(marketPrice);
    if (o == null || !m) return { verdict: o == null ? 'cannot-make' : 'no-price', ownCost: o, marketPrice: m || null };
    const saves = m - o;
    return { verdict: saves >= 0 ? 'make' : 'buy', ownCost: o, marketPrice: m, savesPerUnit: Math.abs(saves), savesPct: Math.abs(saves) / m * 100 };
  }

  // v2.5.359 #5 profit/h/level in every economy phase. Same sale price and input costs; the game's rate (and so labour
  // per unit, wage per hour being phase-independent) changes with SALARY_MID[phase]. {state: value|null}.
  function phaseProfits(args = {}) {
    const c = args.c; if (!gameConstantsOk(c)) return null;
    const out = {};
    for (const st of Object.keys(c.core.SALARY_MID)) { const r = gameCalcProduct({ ...args, economyState: Number(st) }); out[st] = r.ok ? r.profitPerHourPerLevel : null; }
    return out;
  }
  // Rate factor when the economy goes from → to, for a building kind: rate ∝ (AVERAGE_SALARY / SALARY_MID)^salaryModifier.
  function phaseRateRatio(c, buildingKind, from, to) {
    if (!gameConstantsOk(c)) return null;
    const b = c.buildings[String(buildingKind)], sm = Number(b && b.salaryModifier);
    const mf = pos(c.core.SALARY_MID[String(from)]), mt = pos(c.core.SALARY_MID[String(to)]);
    return Number.isFinite(sm) && mf && mt ? Math.pow(mf / mt, sm) : null;
  }
  // #7 upgrade payback: hours until the extra level's profit pays the construction materials.
  function upgradePayback({ cost, gainPerHour } = {}) {
    const c = pos(cost), g = Number(gainPerHour);
    if (!c) return { hours: null, reason: 'no-cost' };
    if (!(g > 0)) return { hours: null, reason: 'not-profitable' };
    return { hours: c / g };
  }
  // v2.5.360 full upgrade payback (game code, user-confirmed 2026-10-24):
  //   admin overhead base = 1 + (total building levels − 1) / 170 → one more level adds 1/170 to the base; the COO cuts
  //   (base − 1) by coo %, so the effective factor rises by (1/170) × (1 − coo/100), on the wages of every producing level.
  //   upgrade time = level × buildDuration ÷ acceleration (default 1) — the building does not produce meanwhile.
  //   payback (from the start) = upgrade time + (materials + profit lost while upgrading) ÷ (extra profit − extra admin) per h.
  function adminIncreasePerLevel(cooPct = 0) { return (1 / 170) * (1 - Math.max(0, Math.min(100, Number(cooPct) || 0)) / 100); }
  function upgradePaybackFull({ cost, gainPerHour, currentProfitPerHour = 0, upgradeHours = 0, extraAdminPerHour = 0 } = {}) {
    const c = pos(cost), g = Number(gainPerHour), up = Math.max(0, Number(upgradeHours) || 0), cur = Number(currentProfitPerHour) || 0;
    if (!c) return { hours: null, reason: 'no-cost' };
    const net = g - (Number(extraAdminPerHour) || 0), lost = Math.max(0, cur) * up;
    if (!(net > 0)) return { hours: null, reason: 'not-profitable', netGainPerHour: net, lostProfit: lost, upgradeHours: up };
    return { hours: up + (c + lost) / net, netGainPerHour: net, lostProfit: lost, upgradeHours: up };
  }
  // #4 sell price advice for a lot of quality q. Competing listings = quality ≥ q (the game's sell page shows
  // "Current exchange orders for Q<q>+"), your own listings excluded. history = daily VWAP [{date, vwap}] of id:q.
  function sellPriceAdvice({ listings, quality, history, unitCost = null, feePct = null, companyId = null, ownIds = [], now = Date.now(), days = 7 } = {}) {
    const q = Number(quality) || 0, own = new Set((ownIds || []).map(Number)), cid = companyId == null ? null : Number(companyId);
    const sid = r => Number(r && (r.seller && r.seller.id != null ? r.seller.id : r.sellerId));
    const comp = (Array.isArray(listings) ? listings : []).filter(r => r && Number(r.price) > 0 && Number(r.quality) >= q && !own.has(Number(r.id)) && !(cid != null && sid(r) === cid));
    const cheapest = comp.length ? comp.reduce((a, b) => (Number(b.price) < Number(a.price) ? b : a)) : null;
    const from = now - days * 24 * HOUR;
    const pts = (Array.isArray(history) ? history : []).map(h => ({ t: Date.parse(String(h && h.date)), v: Number(h && h.vwap) })).filter(p => Number.isFinite(p.t) && p.t >= from - 24 * HOUR && p.v > 0);
    const vs = pts.map(p => p.v);
    const range = vs.length ? { low: Math.min(...vs), high: Math.max(...vs), average: vs.reduce((a, b) => a + b, 0) / vs.length, days: vs.length } : null;
    const suggested = cheapest ? Number(cheapest.price) : null;
    const fee = feePct != null && Number.isFinite(Number(feePct)) ? Number(feePct) : null;
    const net = suggested != null && fee != null ? suggested * (1 - fee / 100) : null;
    const cost = unitCost != null && Number.isFinite(Number(unitCost)) && Number(unitCost) > 0 ? Number(unitCost) : null;
    const warnings = [];
    if (suggested != null && range && suggested < range.low) warnings.push('below-7d-low');
    if (suggested != null && cost != null && (net != null ? net : suggested) < cost) warnings.push('below-cost');
    return { suggested, cheapestQuality: cheapest ? Number(cheapest.quality) : null, competing: comp.length, range, unitCost: cost, feePct: fee, net, warnings };
  }
  // #6 incoming contract (you buy): unit price vs the cheapest exchange listing at quality ≥ the contract's, and vs
  // your warehouse cost of that product. Positive saves = the contract is cheaper.
  function contractVerdict({ price, quantity, exchangePrice = null, stockCost = null } = {}) {
    const p = pos(price), qty = pos(quantity) || 0, x = pos(exchangePrice), s = pos(stockCost);
    if (!p) return null;
    const out = { price: p, quantity: qty };
    if (x) { out.exchangePrice = x; out.savesPerUnit = x - p; out.savesTotal = (x - p) * qty; out.savesPct = (x - p) / x * 100; out.verdict = x - p >= 0 ? 'cheaper' : 'dearer'; }
    if (s) { out.stockCost = s; out.vsStockPerUnit = s - p; }
    return out;
  }

  // Exchange fee % from your own listings (/api/v2/companies/<id>/market-orders/): fees ÷ (quantity × price).
  function listingFeePct(orders) {
    const ok = (Array.isArray(orders) ? orders : []).filter(o => pos(o && o.fees) && pos(o.quantity) && pos(o.price));
    if (!ok.length) return null;
    const v = ok.reduce((a, o) => a + o.quantity * o.price, 0), f = ok.reduce((a, o) => a + o.fees, 0);
    return f / v * 100;
  }

  /* Game Accounting screens (GamePages bundle, read 2026-10-25): income statement, balance sheet,
   * cash-flow statement and Financial Ratios. Lines, order, subtotals and ratio formulas copy the
   * game's components; inputs are the raw /api/v2/companies/me/{income-statement,balance-sheet,
   * cashflow-statement}/ fields. kind: head | sub (sub-heading) | line | subtotal | total. */
  function gameFinancialStatements(income, bs, cf) {
    const e = income && typeof income === 'object' ? income : {};
    const b = bs && typeof bs === 'object' ? bs : {};
    const c = cf && typeof cf === 'object' ? cf : {};
    const v = (o, k) => num(o[k]);
    const used = { income: new Set(['date', 'dateFrom', 'isComputed']), bs: new Set(['date']), cf: new Set(['date', 'dateFrom', 'isComputed']) };
    const L = (src, set, key, label, indent = 0) => { set.add(key); return { kind: 'line', key, label, value: v(src, key), indent }; };
    const H = (label, kind = 'head', indent = 0) => ({ kind, label, indent });
    const T = (label, value, kind = 'subtotal') => ({ kind, label, value });
    const iL = (k, l, i) => L(e, used.income, k, l, i), bL = (k, l, i) => L(b, used.bs, k, l, i), cL = (k, l, i) => L(c, used.cf, k, l, i);

    const gross = v(e, 'sales') + v(e, 'cogs') + v(e, 'freightOut');
    const opex = v(e, 'constructionCosts') + v(e, 'salariesCosts') + v(e, 'trainingCosts') + v(e, 'poachingCosts') + v(e, 'marketFees');
    const other = v(e, 'gameIncome') + v(e, 'executiveRoyalties') + v(e, 'gainOnSale') + v(e, 'patentConversion') + v(e, 'accountingOverhead') + v(e, 'bondInterestIncome') + v(e, 'bondInterestExpense') + v(e, 'bondWriteoffs') + v(e, 'bondDefaults') + v(e, 'donations') + v(e, 'goDepositForfeitures');
    const evaProfit = v(e, 'netIncome') - v(e, 'gameIncome') - v(e, 'patentConversion');
    const capitalCharge = evaProfit - v(e, 'economicValueAdded');
    const incomeLines = [
      H('Gross profit'), iL('sales', 'Sales'), iL('cogs', 'Cost of goods sold'), iL('freightOut', 'Freight Out'), T('', gross),
      H('Operating expenses'), iL('constructionCosts', 'Construction costs'), iL('marketFees', 'Exchange fees'), H('Executives costs', 'sub'),
      iL('salariesCosts', 'Salaries', 1), iL('trainingCosts', 'Training', 1), iL('poachingCosts', 'Poaching', 1), T('', opex),
      H('Other income (loss)'), iL('gameIncome', 'Game income'), iL('executiveRoyalties', 'Executive royalties'), iL('gainOnSale', 'Gain on sale'),
      iL('patentConversion', 'Patent conversion'), iL('accountingOverhead', 'Accounting overhead'), iL('donations', 'Donations'),
      iL('goDepositForfeitures', 'Government order deposit forfeitures'), H('Bonds', 'sub'), iL('bondInterestIncome', 'Interest income', 1),
      iL('bondInterestExpense', 'Interest expense', 1), iL('bondWriteoffs', 'Write offs', 1), iL('bondDefaults', 'Defaults', 1), T('', other),
      { ...iL('netIncome', 'Net income'), kind: 'total' }, iL('otherComprehensiveIncome', 'Other comprehensive income'),
      T('Total comprehensive income', v(e, 'netIncome') + v(e, 'otherComprehensiveIncome'), 'total'),
      H('EVA score'), T('Operating profit', evaProfit, 'line'), T('Capital charge', -capitalCharge, 'line'),
      { ...iL('economicValueAdded', ''), kind: 'subtotal' }
    ];

    const totalAssets = ['cash', 'cashReservedForOrders', 'accountsReceivable', 'materials', 'research', 'workInProcess', 'finishedGoods', 'valuationAllowance', 'deposits', 'investmentInBonds', 'buildings', 'constructionInProgress', 'patents'].reduce((a, k) => a + v(b, k), 0);
    const equity = v(b, 'contributedCapital') + v(b, 'retainedEarnings');
    const balanceLines = [
      H('Current assets'), bL('cash', 'Cash'), bL('cashReservedForOrders', 'Cash reserved for orders'), bL('accountsReceivable', 'Accounts receivable'),
      H('Inventory', 'sub'), bL('materials', 'Materials', 1), bL('research', 'Research', 1), bL('workInProcess', 'Work in process', 1),
      bL('finishedGoods', 'Finished goods', 1), bL('valuationAllowance', 'Valuation allowance', 1),
      H('Non-current assets'), bL('deposits', 'Deposits'), bL('investmentInBonds', 'Investment in bonds'), bL('buildings', 'Buildings'),
      bL('constructionInProgress', 'Construction in progress'), bL('patents', 'Patents'), T('Total assets', totalAssets, 'total'),
      H('Liabilities'), bL('bondsPayable', 'Bonds Payable'), H('Equity'), bL('contributedCapital', 'Contributed Capital'), bL('retainedEarnings', 'Retained earnings'),
      T('Total debt and equity', v(b, 'bondsPayable') + equity, 'total'), T('Company value', equity, 'total')
    ];

    const operating = ['fromRetail', 'fromCustomers', 'fromExchange', 'fromInterest', 'fromPoaching', 'fromRoyalties', 'fromEmployees', 'toGame', 'toSuppliers', 'toExchange', 'toEmployees', 'toExecutives', 'forInterest', 'forFees', 'forAccounting'].reduce((a, k) => a + v(c, k), 0);
    const cashflowLines = [
      H('Operating activities'), H('Cash receipts', 'sub'), cL('fromRetail', 'From retail', 1), cL('fromCustomers', 'From customers', 1), cL('fromExchange', 'From exchange', 1),
      cL('fromInterest', 'From interest', 1), cL('fromPoaching', 'From poaching', 1), cL('fromRoyalties', 'From royalties', 1), cL('fromEmployees', 'From employees', 1),
      H('Cash payments', 'sub'), cL('toSuppliers', 'To suppliers', 1), cL('toExchange', 'To exchange', 1), cL('toEmployees', 'To employees', 1), cL('toExecutives', 'To executives', 1),
      cL('forInterest', 'For interest', 1), cL('forFees', 'For fees', 1), cL('forAccounting', 'For accounting', 1), cL('toGame', 'For PA quests', 1), T('', operating),
      H('Investing activities'), cL('investmentInBonds', 'Investment in bonds'), cL('goDeposits', 'Deposits'),
      H('Financing activities'), cL('bonds', 'Bonds'), cL('fromGame', 'From game'),
      T('Total change in cash', v(c, 'cashAllIncome') + v(c, 'cashAllExpenses'), 'total')
    ];
    used.cf.add('cashAllIncome'); used.cf.add('cashAllExpenses'); used.income.add('economicValueAdded');

    // Financial Ratios (game bfr component). Division results are not guarded, as in the game (0/0 → NaN, x/0 → ±Infinity).
    const operatingIncome = v(e, 'sales') + v(e, 'cogs') + v(e, 'freightOut') + v(e, 'constructionCosts') + v(e, 'marketFees') + v(e, 'salariesCosts') + v(e, 'poachingCosts') + v(e, 'trainingCosts');
    const emp = v(b, 'employees'); const adjEmployees = Math.floor(emp * 100 * (1 + (emp - 1) / 170));
    const inventory = v(b, 'materials') + v(b, 'research') + v(b, 'workInProcess') + v(b, 'finishedGoods') + v(b, 'valuationAllowance');
    const quick = v(b, 'cash') + v(b, 'accountsReceivable');
    const R = (label, value, percent, formula) => ({ label, value, percent, formula });
    const ratios = [
      H('Profitability ratios'),
      R('Gross Margin', gross / v(e, 'sales'), true, 'Gross Profit / Sales'),
      R('Operating Margin', operatingIncome / v(e, 'sales'), true, 'Operating Income / Sales'),
      R('Net Profit Margin', v(e, 'netIncome') / v(e, 'sales'), true, 'Net Income / Sales'),
      R('Return on Quick Assets', v(e, 'netIncome') / quick, true, 'Net Income / (Cash + Receivable)'),
      R('Return on Equity', v(e, 'netIncome') / equity, true, 'Net Income / Equity'),
      R('Sales per Employee', v(e, 'sales') / adjEmployees, false, 'Sales / Employees'),
      R('Income per Employee', v(e, 'netIncome') / adjEmployees, false, 'Net Income / Employees'),
      H('Operating efficiency'),
      R('Inventory Turnover', (Math.abs(v(e, 'cogs')) + v(e, 'freightOut')) / inventory, false, '(COGS + Freight Out) / Inventory'),
      R('Assets Turnover', v(e, 'sales') / equity, false, 'Sales / Total Assets'),
      R('Operating Assets Turnover', v(e, 'sales') / (inventory + quick + v(b, 'deposits')), false, 'Sales / (Current Assets + Deposits)'),
      H('Liquidity ratios'),
      R('Defensive Interval', quick / Math.abs(v(e, 'cashAllExpenses')), false, '(Cash + Receivable) / Daily Cash Expenditure'),
      R('Interest Coverage', operatingIncome / -v(e, 'bondInterestExpense'), false, 'Operating Income / Interest Expense'),
      R('Debt to Building Ratio', v(b, 'bondsPayable') / v(b, 'buildings'), true, 'Bonds Payable / Buildings')
    ];
    for (const r of ratios) if (r.kind) delete r.value;
    used.income.add('cashAllExpenses'); used.bs.add('employees');
    const extras = (src, set) => Object.entries(src).filter(([k, x]) => !set.has(k) && Number.isFinite(Number(x)) && typeof x !== 'boolean').map(([k, x]) => ({ kind: 'line', key: k, value: Number(x) }));
    return {
      income: incomeLines, balance: balanceLines, cashflow: cashflowLines, ratios,
      ratiosAvailable: Object.keys(e).length > 0 && Object.keys(b).length > 0 && e.isComputed !== false,
      adjustedEmployees: adjEmployees,
      extra: { income: extras(e, used.income), bs: extras(b, used.bs), cf: extras(c, used.cf) }
    };
  }

  const api = {
    gameFinancialStatements, economyLogAppend, gameConstantsOk, recipesFromGameConstants, buildingsFromGameConstants, gameBaseRate, gameRatePerLevel, gameWagePerLevel, GAME_PROFIT_CALC_ABUNDANCE_PCT, isAbundanceResource, abundanceTone, warehouseUnitCostAsGame, gameProfitCalcRatePerLevel, phaseFromMeasuredRate, listingFeePct, gameCalcProduct, rankBuildingProducts, inputRunOut, makeOrBuy, phaseProfits, phaseRateRatio, upgradePayback, adminIncreasePerLevel, upgradePaybackFull, sellPriceAdvice, contractVerdict, effectiveAdminOverhead, executiveSkill, academyActiveSize, executiveRoster, dailyBaseLabour, executiveAdminWhatIf, executiveRoi, batchPhaseFromRate, economyStateAt, economyName, lotWorkersPerProducedUnit, projectionRate,
    HOUR, WINDOWS, normalizeName, roi, loan, allocate, profitPerHour, buildingProfit, rankProducts,
    cleanSeries, seriesForResource, changeOver, volatility, rangeStats, sliceRange, moversTable,
    seriesToCsv, headlineFromVwapRows, appendObservations, priceAt, moversFromTrend,
    productionCostEntriesFromBuildings, productionCostEntriesFromHistory, mergeProductionCostHistory, productionCostSummary
  };
  root.SCM_TOOLS_CORE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
