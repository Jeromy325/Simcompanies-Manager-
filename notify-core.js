/* Sim Companies Manager — notification texts and checks. Pure functions: no chrome.*, no network.
 * Every number comes from captured game / SimcoTools data passed in by background.js.
 * Texts are plain sentences: what happened, the numbers, and what it means in dollars. */
(function (root) {
  'use strict';
  const n = v => { if (v == null || v === '') return null; const x = Number(v); return Number.isFinite(x) ? x : null; };
  // money = per-unit price (cents; 3 decimals under $1). total = whole dollars.
  const money = v => { const x = n(v); if (x == null) return '—'; const a = Math.abs(x); const s = a >= 1 ? a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : a.toFixed(3); return (x < 0 ? '−$' : '$') + s; };
  const total = v => { const x = n(v); if (x == null) return '—'; return (x < 0 ? '−$' : '$') + Math.round(Math.abs(x)).toLocaleString('en-US'); };
  const int = v => (n(v) == null ? '—' : Math.round(Number(v)).toLocaleString('en-US'));
  const pct = (v, d = 1) => (n(v) == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(d) + '%');
  const signed = (v, f = money) => (n(v) == null ? '—' : (v >= 0 ? '+' : '') + f(v));
  const ago = ms => { const m = Math.round(ms / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
  const clock = t => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const nameOf = (names, id) => (names && (names.get ? names.get(Number(id)) : names[id])) || `Resource #${id}`;
  const R = realm => `R${Number(realm) + 1}`;

  // Cheapest market price for a product at quality >= minQ (minQ 0 = any quality, the game's calculator rule).
  // Delegates to market-core marketPrice (the single market-price source): order book younger than maxAgeMs, else
  // SimcoTools current prices. No VWAP step here: a notification says 'cheapest on the market', not an average.
  // market-core is loaded by the service worker (import './market-core.js' before notify-core.js) or required in Node.
  const marketCore = () => root.SCM_MARKET_CORE || (typeof require === 'function' ? require('./market-core.js') : null);
  function cheapestListing(store, realm, id, minQ = 0, now = Date.now(), maxAgeMs = 6 * 3600e3, own = {}) {
    minQ = Number(minQ) || 0;
    const mc = marketCore(); if (!mc) return null;
    const r = mc.marketPrice(store, realm, id, minQ, { mode: minQ > 0 ? 'min' : 'any', now, bookMaxAgeMs: maxAgeMs, noVwap: true, companyId: own?.companyId, ownIds: own?.ownIds });
    if (!r) return null;
    return { price: r.price, quality: r.quality, source: r.source === 'exchange' ? `exchange, ${ago(r.ageMs)}` : `SimcoTools${r.ageMs != null ? ', ' + ago(r.ageMs) : ''}` };
  }
  const batchName = (r, names, amount = r?.amount) => `${n(amount) != null ? int(amount) + ' ' : ''}${r?.name || nameOf(names, r?.kind ?? r?.resourceId)}${n(r?.quality) != null ? ' Q' + r.quality : ''}`;
  // Size of the finished batch: the run's history row holds the full output (busy.resource.amount is only what is still to
  // come, so it understates the batch after a collect). Without a row, a finished run's amountAvailableNow is the batch.
  // planner-core is loaded next to this file (service worker import, dashboard script, Node require).
  const plannerCore = () => root.SCMPlannerCore || (typeof require === 'function' ? require('./planner-core.js') : null);
  function batchSize(building, store) {
    const rows = store?.endpointData?.[`/api/v2/companies/buildings/${Number(building?.id)}/history/`]?.data;
    const fromHistory = Array.isArray(rows) ? n(plannerCore()?.runOutputAmount?.(building, rows)) : null;
    if (fromHistory != null) return fromHistory;
    const ready = n(building?.busy?.resource?.amountAvailableNow);
    return ready != null && ready > 0 ? ready : null;
  }

  // Batch finished, with what it is worth at today's market (game basis: cheapest listing, any quality).
  function batchFinishedMessage({ building, store, realm, names, now = Date.now(), companyId, ownIds }) {
    const r = building?.busy?.resource || {};
    const id = Number(r.kind ?? r.resourceId), amount = batchSize(building, store), cost = n(r.unitCost);
    const title = `${building?.name || 'Building ' + building?.id} finished ${batchName(r, names, amount)}`;
    const lines = ['Ready to collect.'];
    const mk = id > 0 ? cheapestListing(store, realm, id, 0, now, undefined, { companyId, ownIds }) : null;
    if (cost != null) lines.push(`They cost you ${money(cost)} each.`);
    if (mk) lines.push(`Cheapest on the market now: ${money(mk.price)} (Q${mk.quality} listing, ${mk.source}).`);
    if (cost != null && mk) {
      const per = mk.price - cost;
      lines.push(`Selling now: about ${signed(per)} each${amount != null ? `, ${signed(per * amount, total)} for the batch` : ''}, before fees.`);
    }
    lines.push(R(realm));
    return { title, message: lines.join('\n') };
  }

  // Price targets [{id, q, op:'<='|'>=', price}] against SimcoTools current prices. Fires when the condition
  // becomes true; re-arms when it becomes false again (state: { 'id:q:op:price': true while met }).
  function priceTargetHits(targets, rows, state = {}, names, realm = 1) {
    const fire = [], next = {};
    for (const t of Array.isArray(targets) ? targets : []) {
      const id = Number(t?.id), q = Number(t?.q), lim = n(t?.price), op = t?.op === '>=' ? '>=' : '<=';
      if (!(id > 0) || !Number.isFinite(q) || lim == null) continue;
      const row = (rows || []).find(r => Number(r?.resourceId) === id && Number(r?.quality) === q && n(r?.price) > 0);
      const k = `${id}:${q}:${op}:${lim}`;
      if (!row) { if (state[k]) next[k] = true; continue; }
      const met = op === '<=' ? row.price <= lim : row.price >= lim;
      if (met) {
        next[k] = true;
        if (!state[k]) fire.push({ title: `Price alert: ${nameOf(names, id)} Q${q} is now ${money(row.price)}`, message: `That's ${op === '<=' ? 'at or below' : 'at or above'} your target of ${money(lim)}.${n(row.vwap) ? ` Average trade price (VWAP): ${money(row.vwap)}.` : ''}\n${R(realm)}`, id, q });
      }
    }
    return { fire, state: next };
  }

  function lotCost(l) {
    const c = l?.cost; if (c == null) return null;
    if (typeof c === 'number') return c;
    let s = 0, f = false; for (const v of Object.values(c)) { const x = n(v); if (x != null) { s += x; f = true; } }
    return f ? s : null;
  }
  function holdings(lots) {
    const held = new Map();
    for (const l of Array.isArray(lots) ? lots : []) {
      const id = Number(l?.kind), q = Number(l?.quality), a = n(l?.amount); if (!(id > 0) || !(a > 0)) continue;
      const k = `${id}:${q}`, cur = held.get(k) || { qty: 0, cost: 0, costKnown: true };
      cur.qty += a; const c = lotCost(l); if (c == null) cur.costKnown = false; else cur.cost += c; held.set(k, cur);
    }
    return held;
  }

  // Big 1 h move on something you hold (SimcoTools trend data; moversFromTrend rows).
  function bigMoves({ movers, lots, threshold = 5, lastFired = {}, now = Date.now(), cooldownMs = 3 * 3600e3, names, realm = 1 }) {
    const held = holdings(lots);
    const fire = [], next = { ...lastFired };
    for (const m of movers || []) {
      const k = `${m.id}:${m.quality}`, h = held.get(k), ch = n(m.change?.['1h']);
      if (!h || ch == null || Math.abs(ch) < threshold) continue;
      const key = `${k}:${ch > 0 ? 'up' : 'down'}`;
      if (now - (Number(lastFired[key]) || 0) < cooldownMs) continue;
      next[key] = now;
      const unit = h.costKnown && h.qty > 0 ? h.cost / h.qty : null;
      const before = m.price / (1 + ch / 100);
      const lines = [`${money(before)} → ${money(m.price)} now. You have ${int(h.qty)} in stock${unit != null ? ` (your cost ${money(unit)} each)` : ''}.`];
      if (unit != null) { const per = m.price - unit; lines.push(`Selling now: ${signed(per)} each (${pct(per / unit * 100)}) ≈ ${signed(per * h.qty, total)} total, before fees.`); }
      if (n(m.change?.['24h']) != null) lines.push(`Over 24 h: ${pct(m.change['24h'])}.`);
      lines.push(R(realm));
      fire.push({ title: `${nameOf(names, m.id) || m.name} Q${m.quality} price ${ch > 0 ? 'up' : 'down'} ${Math.abs(ch).toFixed(1)}% in the last hour`, message: lines.join('\n') });
    }
    return { fire, lastFired: next };
  }

  // New incoming contracts. data = /api/v3/contracts-incoming/<realm>/me/ response. seen = ids already known
  // (null on first run: everything is recorded, nothing fires).
  function contractRows(data) {
    if (Array.isArray(data)) return data;
    for (const k of ['contracts', 'results', 'data', 'items', 'incoming']) if (Array.isArray(data?.[k])) return data[k];
    return [];
  }
  const pickNum = (o, keys) => { for (const k of keys) { const x = n(o?.[k]); if (x != null) return x; } return null; };
  const companyOf = c => { for (const k of ['seller', 'sender', 'from', 'company', 'companyInfo', 'counterparty']) { const v = c?.[k]; if (typeof v === 'string' && v) return v; if (v && typeof v === 'object') { const s = v.company || v.name || v.companyName; if (s) return String(s); } } return c?.companyName || c?.company_name || 'a company'; };
  function newIncomingContracts(data, seen, names, realm = 1) {
    const rows = contractRows(data), ids = rows.map((c, i) => String(c?.id ?? c?.contractId ?? `${companyOf(c)}|${c?.kind ?? c?.resourceId}|${c?.quantity ?? c?.amount}|${c?.price}|${i}`));
    if (!Array.isArray(seen)) return { fresh: [], seen: ids };
    const known = new Set(seen), fresh = [];
    rows.forEach((c, i) => {
      if (known.has(ids[i])) return;
      const kind = n(c?.kind ?? c?.resourceId ?? c?.resource?.kind ?? c?.resource?.id);
      const qty = pickNum(c, ['quantity', 'amount', 'units']), price = pickNum(c, ['price', 'unitPrice', 'pricePerUnit']), q = pickNum(c, ['quality', 'q']);
      const tot = pickNum(c, ['total', 'totalPrice']) ?? (qty != null && price != null ? qty * price : null);
      const pname = c?.resource?.name || c?.resourceName || c?.productName || (kind ? nameOf(names, kind) : 'product');
      fresh.push({ title: `New incoming contract from ${companyOf(c)}`, message: `They offer ${qty != null ? int(qty) + ' ' : ''}${pname}${q != null ? ' Q' + q : ''}${price != null ? ` at ${money(price)} each` : ''}${tot != null ? `, ${total(tot)} in total` : ''}.\n${R(realm)}` });
    });
    return { fresh, seen: ids.slice(-500) };
  }

  // Sales from the game's cash-flow ledger (/api/v2/companies/me/cashflow/recent/ → data[]), the same
  // rows the Accounting tab reads: category 'm' + descriptionKey 'marketfilled-<id>' = exchange sale,
  // descriptionKey 'cs-…' = money from an outgoing contract the buyer accepted. First capture only records ids.
  function saleKind(row) {
    const k = String(row?.descriptionKey || '').toLowerCase();
    if (k.startsWith('cs-')) return 'contract';
    if (String(row?.category || '').toLowerCase() === 'm' && k.startsWith('marketfilled-')) return 'exchange';
    return null;
  }
  function newSales(rows, seen, names, realm = 1, now = Date.now(), maxAgeMs = 24 * 3600e3) {
    const list = (Array.isArray(rows) ? rows : []).filter(r => saleKind(r));
    const idOf = r => String(r?.id ?? `${r?.datetime || ''}|${r?.descriptionKey || ''}|${r?.money ?? ''}`);
    const ids = list.map(idOf);
    if (!Array.isArray(seen)) return { fresh: [], seen: ids.slice(-500) };
    const known = new Set(seen), fresh = [];
    for (const r of list) {
      if (known.has(idOf(r))) continue;
      const t = Date.parse(String(r?.datetime || ''));
      if (Number.isFinite(t) && now - t > maxAgeMs) continue;
      const d = r?.details && typeof r.details === 'object' ? r.details : {};
      const kind = n(d.resource ?? d.resourceId ?? r.resource ?? r.resourceId);
      const qty = n(d.amount ?? r.amount), price = n(d.price ?? r.price), got = n(r.money ?? d.money), profit = n(d.profit ?? r.profit);
      const gross = qty != null && price != null ? qty * price : got;
      const what = `${qty != null ? int(qty) + ' ' : ''}${kind ? nameOf(names, kind) : 'items'}`;
      const nums = `${price != null ? `${money(price)} each` : ''}${gross != null ? `${price != null ? ', ' : ''}${total(gross)}` : ''}${profit != null ? ` · profit ${signed(profit, total)}` : ''}`;
      const when = Number.isFinite(t) ? ` · ${clock(t)}` : '';
      if (saleKind(r) === 'contract') fresh.push({ title: `Contract accepted: ${what}`, message: `The buyer accepted your outgoing contract${nums ? ': ' + nums : ''}.\n${R(realm)}${when}` });
      else fresh.push({ title: `Sold on the exchange: ${what}`, message: `${nums || 'Sale filled'}.\n${R(realm)}${when}` });
    }
    return { fresh, seen: [...new Set([...seen, ...ids])].slice(-500) };
  }

  // Daily summary: latest completed day from the game's past-finances-overview (evaProfit, total assets,
  // rank) + production runs started in the last 24 h from the Manager's cost history.
  function dailySummary({ overview, runs, realm, names, now = Date.now() }) {
    const rows = (Array.isArray(overview) ? overview : Array.isArray(overview?.data) ? overview.data : [])
      .map(r => ({ t: Date.parse(String(r?.date || '').replace(' ', 'T')), profit: n(r?.evaProfit), assets: n(r?.total), rank: n(r?.rank) }))
      .filter(r => Number.isFinite(r.t)).sort((a, b) => a.t - b.t);
    const last = rows[rows.length - 1], prev = rows[rows.length - 2];
    const recent = (Array.isArray(runs) ? runs : []).filter(e => now - Date.parse(e.t) < 24 * 3600e3);
    const byProduct = new Map();
    for (const e of recent) { const k = `${e.id}:${e.q}`; const g = byProduct.get(k) || { id: e.id, q: e.q, runs: 0, units: 0 }; g.runs++; g.units += n(e.n) || 0; byProduct.set(k, g); }
    const top = [...byProduct.values()].sort((a, b) => b.units - a.units).slice(0, 3);
    const parts = [];
    if (last) {
      const s = [`Profit ${last.profit != null ? total(last.profit) : '—'}.`];
      if (last.assets != null) s.push(`Company value (assets) ${total(last.assets)}${prev?.assets != null ? `, ${last.assets - prev.assets >= 0 ? 'up' : 'down'} ${total(Math.abs(last.assets - prev.assets))} from the day before` : ''}.`);
      if (last.rank != null) s.push(`Rank ${int(last.rank)}${prev?.rank != null && prev.rank !== last.rank ? ` (was ${int(prev.rank)})` : ''}.`);
      parts.push(s.join(' '));
    } else parts.push('No daily finance history captured yet (open the Accounting tab once).');
    parts.push(`${recent.length} batch${recent.length === 1 ? '' : 'es'} started in the last 24 h${top.length ? ': ' + top.map(g => `${int(g.units)} ${nameOf(names, g.id)} Q${g.q}`).join(', ') : ''}.`);
    const day = last ? new Date(last.t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'yesterday';
    return { title: `${R(realm)} daily summary for ${day}`, message: parts.join('\n') };
  }

  // A new batch costs noticeably more or less than the previous batch of the same product + quality.
  // history = production cost history (oldest first); entry = the new run.
  function costChanged({ history, entry, thresholdPct = 3, names, realm = 1 }) {
    const prev = (Array.isArray(history) ? history : []).filter(e => e.id === entry.id && e.q === entry.q && e.k !== entry.k && Date.parse(e.t) < Date.parse(entry.t) && n(e.c) > 0)
      .sort((a, b) => Date.parse(b.t) - Date.parse(a.t))[0];
    if (!prev || !(n(entry.c) > 0)) return null;
    const d = entry.c - prev.c, p = d / prev.c * 100;
    if (Math.abs(p) < thresholdPct) return null;
    return { title: `${entry.bn || 'Building ' + entry.b}: new batch costs ${d > 0 ? 'more' : 'less'}`, message: `${nameOf(names, entry.id)} Q${entry.q} now costs ${money(entry.c)} each, ${d > 0 ? 'up' : 'down'} ${money(Math.abs(d))} (${pct(p)}) from the last batch (${money(prev.c)}${prev.bn && prev.bn !== entry.bn ? `, ${prev.bn}` : ''}).${n(entry.n) ? ` On ${int(entry.n)} units that's ${signed(d * entry.n, total)}.` : ''}\n${R(realm)}` };
  }

  // Follow-up after a batch finished: idle (no batch running) or not collected (the same batch is
  // still shown as running after its finish time). Only decided from building data captured after the finish.
  function followUp({ building, startedMs, finishMs, seenAt, now = Date.now(), names, realm = 1, batchAmount }) {
    if (!Number.isFinite(seenAt) || seenAt < finishMs) return { kind: 'unknown' };
    const busy = building?.busy, st = Date.parse(String(busy?.started || ''));
    const label = building?.name || 'Building';
    if (busy && Number.isFinite(st) && Math.abs(st - startedMs) <= 5000) {
      return { kind: 'uncollected', title: `${label} hasn't been collected`, message: `${batchName(busy.resource || {}, names, batchAmount)} finished at ${clock(finishMs)} (${ago(now - finishMs)}) and is still waiting to be collected.\nCollect it and start the next batch to keep the building busy.\n${R(realm)}` };
    }
    if (!busy || !Number.isFinite(st)) {
      return { kind: 'idle', title: `${label} is idle`, message: `Its last batch finished at ${clock(finishMs)} (${ago(now - finishMs)}) and no new batch has started.\nManager last saw your buildings ${ago(now - seenAt)}.\n${R(realm)}` };
    }
    return { kind: 'busy' };
  }

  // Undercut: someone lists cheaper than your own listing at the same quality, from a captured order book.
  // Your listings are found by your company id on the listing's seller.
  const sellerId = r => n(r?.seller?.id ?? r?.sellerId ?? r?.company?.id ?? r?.companyId ?? r?.seller);
  // own: your listings from /market-orders/ — used even when the order book page doesn't show them.
  function undercut({ rows, companyId, id, names, realm = 1, state = {}, own = null }) {
    const cid = n(companyId); if (cid == null || !Array.isArray(rows)) return { fire: [], state };
    const mine = (Array.isArray(own) && own.length ? own : rows).filter(r => (own && own.length ? true : sellerId(r) === cid) && n(r?.price) > 0);
    const fire = [], next = { ...state };
    for (const q of [...new Set(mine.map(r => Number(r.quality)))]) {
      const my = Math.min(...mine.filter(r => Number(r.quality) === q).map(r => Number(r.price)));
      const others = rows.filter(r => sellerId(r) !== cid && Number(r?.quality) === q && n(r?.price) > 0 && Number(r.price) < my);
      const key = `${id}:${q}`;
      if (!others.length) { delete next[key]; continue; }
      const best = others.reduce((a, c) => (Number(c.price) < Number(a.price) ? c : a));
      const sig = `${my}:${best.price}`;
      if (next[key] === sig) continue;
      next[key] = sig;
      fire.push({ title: `You've been undercut on ${nameOf(names, id)} Q${q}`, message: `Your listing: ${money(my)}. Cheapest other seller now: ${money(best.price)}${best?.seller?.company ? ` (${best.seller.company})` : ''}, ${money(my - best.price)} less.\n${others.length} listing${others.length === 1 ? ' is' : 's are'} cheaper than yours.\n${R(realm)}` });
    }
    return { fire, state: next };
  }

  // A product you are producing is worth less than its running batch cost (game basis price). Re-arms when
  // it is profitable again.
  function unprofitable({ buildings, store, realm, names, state = {}, now = Date.now(), companyId, ownIds }) {
    const fire = [], next = {};
    for (const b of Array.isArray(buildings) ? buildings : []) {
      const r = b?.busy?.resource; const id = Number(r?.kind), cost = n(r?.unitCost);
      if (!(id > 0) || !(cost > 0)) continue;
      const mk = cheapestListing(store, realm, id, 0, now, undefined, { companyId, ownIds }); if (!mk) continue;
      const key = `${b.id}:${id}:${r.quality}`;
      if (mk.price < cost) {
        next[key] = true;
        if (!state[key]) { const per = mk.price - cost; fire.push({ title: `${r.name || nameOf(names, id)} Q${r.quality} is no longer profitable`, message: `${b.name || 'Your building'}'s running batch cost ${money(cost)} each, but the cheapest listing is now ${money(mk.price)} (Q${mk.quality}, ${mk.source}).\nSelling now: ${money(per)} each${n(r.amount) ? `, ${total(per * r.amount)} on ${int(r.amount)}` : ''}, before fees.\n${R(realm)}` }); }
      }
    }
    return { fire, state: next };
  }

  // Background trouble: the same background job failed `limit` times in a row.
  const JOB_LABEL = { 'market-vwap-stage': 'VWAP price downloads', 'market-prices-stage': 'Market price downloads', 'market-current-price-stage': 'Current price downloads', 'warehouse-refresh': 'Warehouse refreshes', 'core-sync': 'Sync', 'overlay-refresh-notification': 'Game overlay updates' };
  function jobTrouble({ counts = {}, event, limit = 3, realm = 1, now = Date.now(), pricesUpdatedAt = null }) {
    const key = `${event?.job}`; const next = { ...counts };
    if (!JOB_LABEL[key]) return { counts: next, fire: null };
    const bad = event.outcome === 'failure' || event.outcome === 'rate-limited';
    if (!bad) { delete next[key]; return { counts: next, fire: null }; }
    next[key] = (next[key] || 0) + 1;
    if (next[key] !== limit) return { counts: next, fire: null };
    const age = Date.parse(String(pricesUpdatedAt || ''));
    return { counts: next, fire: { title: `Manager: ${JOB_LABEL[key].toLowerCase()} keep failing`, message: `${limit} failures in a row${event.error ? `. Last error: ${String(event.error).slice(0, 120).replace(/[.\s]+$/, '')}` : ''}.${/price|vwap/i.test(key) && Number.isFinite(age) ? ` Last price update: ${ago(now - age)}.` : ''}\nThe Manager keeps retrying on its own. Opening the game usually helps.\n${R(realm)}` } };
  }

  // Next local time hh:mm after now (for the daily summary alarm).
  function nextDailyTime(hhmm, now = Date.now()) {
    const m = String(hhmm || '08:00').match(/^(\d{1,2}):(\d{2})$/); const h = m ? Math.min(23, Number(m[1])) : 8, mi = m ? Math.min(59, Number(m[2])) : 0;
    const d = new Date(now); d.setHours(h, mi, 0, 0); if (d.getTime() <= now) d.setDate(d.getDate() + 1); return d.getTime();
  }

  // Economy phase changed (auth-data temporals.economyState). Rate factor per building kind you own, from the
  // game's formula: rate ∝ (AVERAGE_SALARY / SALARY_MID[phase])^salaryModifier → factor = (MID[from] / MID[to])^sm.
  function economyChanged({ from, to, realm = 1, constants = null, buildings = [] }) {
    const nm = { 0: 'Recession', 1: 'Normal', 2: 'Boom' };
    const name = v => nm[Number(v)] || `Phase ${v}`;
    const lines = [];
    const mid = constants && constants.core && constants.core.SALARY_MID, defs = constants && constants.buildings;
    if (mid && defs && n(mid[from]) && n(mid[to])) {
      const seen = new Map();
      for (const b of Array.isArray(buildings) ? buildings : []) {
        const k = String(b?.kind ?? ''); if (!k || seen.has(k)) continue;
        const sm = n(defs[k]?.salaryModifier); if (sm == null) continue;
        seen.set(k, { label: String(b?.name || k).replace(/\s*#\d+.*$/, ''), f: Math.pow(Number(mid[from]) / Number(mid[to]), sm) });
      }
      const parts = [...seen.values()].slice(0, 6).map(x => `${x.label} ${pct((x.f - 1) * 100)}`);
      if (parts.length) lines.push(`Production speed now (game formula): ${parts.join(', ')}.`);
    }
    lines.push('Best product on the Production tab shows profit per phase.');
    lines.push(R(realm));
    return { title: `Economy: ${name(from)} → ${name(to)}`, message: lines.join('\n') };
  }
  // Contest start/end reminders. Pure: state is {[id+':start'|id+':end']: firedAtMs}; returns the next state.
  function contestReminders({ contests, state, now = Date.now(), leadHours = 24, realm = 1 } = {}) {
    const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const lead = Number.isFinite(Number(leadHours)) && Number(leadHours) > 0 ? Number(leadHours) : 24;
    const prev = state && typeof state === 'object' ? state : {};
    const ms = v => typeof v === 'number' ? (Number.isFinite(v) ? v : NaN) : (typeof v === 'string' && v ? Date.parse(v) : NaN);
    const clean = v => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 80);
    const next = {}, fire = [];
    for (const c of Array.isArray(contests) ? contests : []) {
      if (!c || typeof c !== 'object' || c.id == null || c.id === '') continue;
      const id = String(c.id), ks = id + ':start', ke = id + ':end';
      if (prev[ks] != null) next[ks] = prev[ks];
      if (prev[ke] != null) next[ke] = prev[ke];
      const s = ms(c.start), e = ms(c.end);
      if (Number.isFinite(e) && nowMs >= e) continue;
      const label = clean(c.name) || clean(c.resourceName) || clean(c.buildingName) || 'Contest';
      const what = [clean(c.resourceName), clean(c.buildingName)].filter(Boolean).join(', ');
      const hours = `${Math.round(lead * 100) / 100} h`;
      if (Number.isFinite(s) && next[ks] == null) {
        if (nowMs >= s) next[ks] = nowMs; // first seen already running: no start reminder
        else if (s - nowMs <= lead * 3600e3) {
          next[ks] = nowMs;
          fire.push({ id: `contest-${realm}-${id}-start`, title: `Contest starting soon: ${label}`, message: `It starts within ${hours}${what ? ` (${what})` : ''}.\n${R(realm)}` });
        }
      }
      if (Number.isFinite(e) && next[ke] == null && e - nowMs <= lead * 3600e3) {
        next[ke] = nowMs;
        fire.push({ id: `contest-${realm}-${id}-end`, title: `Contest ending soon: ${label}`, message: `It ends within ${hours}${what ? ` (${what})` : ''}.\n${R(realm)}` });
      }
    }
    return { fire, state: next };
  }
  const api = { contestReminders, economyChanged, newSales, money, total, cheapestListing, batchFinishedMessage, priceTargetHits, bigMoves, newIncomingContracts, dailySummary, nextDailyTime, costChanged, followUp, undercut, unprofitable, jobTrouble };
  root.SCM_NOTIFY_CORE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
