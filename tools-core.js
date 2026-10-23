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
      ok: true, principal: P, ratePct: r, ratePeriod, termDays: term, termHours,
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
    const transportPerUnit = num(p.transportUnits) * num(p.transportUnitCost) * (exchange ? 1 : num(p.contractTransportShare, 0.5));
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
  // Phase in force at `at`: inside or after an entry's seen window → that entry; before the first entry →
  // the first entry's phase (assumed); in a gap between two different phases → null (unknown).
  function economyStateAt(log, at) {
    const list = Array.isArray(log) ? log : [], t = Date.parse(String(at || ''));
    if (!list.length || !Number.isFinite(t)) return null;
    if (t < Date.parse(list[0].f)) return { state: Number(list[0].s), assumed: true };
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
    const changed = batchPhase != null && currentPhase != null && Number(batchPhase) !== Number(currentPhase);
    if (!changed) return { rate: m || null, source: 'measured', changed: false };
    if (pos(phaseRate)) return { rate: pos(phaseRate), source: 'phase-measured', changed: true };
    if (pos(referenceRate)) return { rate: pos(referenceRate), source: 'reference', changed: true };
    return { rate: m || null, source: 'measured-stale', changed: true };
  }

  const api = {
    economyLogAppend, economyStateAt, economyName, lotWorkersPerProducedUnit, projectionRate,
    HOUR, WINDOWS, normalizeName, roi, loan, allocate, profitPerHour, buildingProfit, rankProducts,
    cleanSeries, seriesForResource, changeOver, volatility, rangeStats, sliceRange, moversTable,
    seriesToCsv, headlineFromVwapRows, appendObservations, priceAt, moversFromTrend,
    productionCostEntriesFromBuildings, productionCostEntriesFromHistory, mergeProductionCostHistory, productionCostSummary
  };
  root.SCM_TOOLS_CORE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
