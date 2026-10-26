/* Sim Companies Manager — Analyze tab maths (pure, no DOM, no network).
 * Reads only what the manager already captured: cash-flow ledger pages, warehouse lots, past finances, day statements,
 * production cost history and stored prices. Products are matched by resource id + quality, never by page text.
 * Nothing here hardcodes a game value: the exchange fee comes from the ledger (fees-<id> ÷ marketfilled-<id>). */
(function (root) {
  'use strict';
  const DAY = 864e5;
  const num = v => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  const pos = v => Number.isFinite(Number(v)) && Number(v) > 0;
  const keyOf = (id, q) => `${Number(id)}:${Number(q)}`;
  const ms = v => { const t = Date.parse(String(v || '')); return Number.isFinite(t) ? t : null; };

  /* ------------------------------------------------------------ realm */
  // Only captures stamped with this realm (endpointData[url].captureRealm, set on every write). Entries from another
  // realm or with no stamp are dropped, and with no realm nothing is kept: Analyze never mixes R1 and R2.
  function realmEndpoints(endpointData, realm) {
    const n = num(realm), out = {};
    if (n == null) return out;
    for (const [k, v] of Object.entries(endpointData || {})) if (v && typeof v === 'object' && num(v.captureRealm) === n) out[k] = v;
    return out;
  }
  // Production runs (entries carry the building id b) only from buildings this realm owns. No building list = no runs.
  function realmCostHistory(history, buildingIds) {
    const own = new Set([...(buildingIds || [])].map(Number).filter(pos));
    return own.size ? (Array.isArray(history) ? history : []).filter(e => e && own.has(Number(e.b))) : [];
  }

  /* ------------------------------------------------------------ ledger */
  const LEDGER_RX = /\/api\/v2\/companies\/me\/cashflow\/(?:recent|\d+)\/?$/;
  // Every captured cash-flow page (recent + cursor pages) plus the archive's rows, deduped by row id, newest first.
  function ledgerRows(endpointData, archive) {
    const out = new Map();
    for (const r of Object.values((archive && archive.rows) || {})) if (r && typeof r === 'object' && ms(r.datetime) != null) out.set(String(r.id != null ? r.id : `${r.datetime}|${r.descriptionKey}|${r.money}`), r);
    for (const [k, v] of Object.entries(endpointData || {})) {
      if (!LEDGER_RX.test(k)) continue;
      const d = v && v.data, list = Array.isArray(d && d.data) ? d.data : Array.isArray(d) ? d : [];
      for (const r of list) {
        if (!r || typeof r !== 'object' || ms(r.datetime) == null) continue;
        out.set(String(r.id != null ? r.id : `${r.datetime}|${r.descriptionKey}|${r.money}`), r);
      }
    }
    return [...out.values()].sort((a, b) => ms(b.datetime) - ms(a.datetime));
  }
  // Exchange fills ('marketfilled-<resource>', category m), contract sales ('cs-<resource>-<buyer>') and retail sales
  // ('retail-<resource>', category s: no resource/amount in details; amount = money ÷ price, cost = unit_cogs, quality =
  // the sold stock's average, e.g. 0.586 → keyed at the nearest whole quality, the average kept as qAvg).
  // Each exchange fill is paired with the 'fees-<resource>' row written at the same moment (≤ 5 s apart).
  // Money in only (money > 0): a row where money goes out is a purchase, never a sale.
  function salesFromLedger(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const fees = list.filter(r => r && r.category === 'f' && /^fees-\d+$/.test(String(r.descriptionKey || '')) && Number(r.money) < 0);
    const used = new Set(), out = [];
    for (const r of list) {
      const dk = String(r && r.descriptionKey || ''), d = (r && r.details) || {};
      const exchange = r && r.category === 'm' && /^marketfilled-\d+$/.test(dk), contract = /^cs-\d+/.test(dk), retail = r && r.category === 's' && /^retail-\d+$/.test(dk);
      if ((!exchange && !contract && !retail) || !pos(r.money)) continue;
      const price = num(d.price), t = ms(r.datetime), qRaw = num(d.quality);
      const rid = retail ? num(dk.slice(7)) : num(d.resource), q = retail && qRaw != null ? Math.round(qRaw) : qRaw;
      const amount = retail ? (pos(price) ? Math.round(Number(r.money) / price) : null) : num(d.amount);
      if (!pos(rid) || q == null || !pos(amount) || !pos(price) || t == null) continue;
      const gross = Number(r.money);
      if (retail) {
        const cogs = num(d.unit_cogs);
        out.push({ id: String(r.id), t, rid, q, qAvg: qRaw, amount, price, gross, fee: null, ledgerProfit: cogs != null ? gross - cogs * amount : null, ledgerCost: cogs, channel: 'retail', buyer: String(d.building_name || '') });
        continue;
      }
      let fee = null;
      if (exchange) {
        const f = fees.find(x => !used.has(x) && x.descriptionKey === `fees-${rid}` && Math.abs(ms(x.datetime) - t) <= 5000);
        if (f) { used.add(f); fee = -Number(f.money); }
      }
      const profit = num(d.profit);
      out.push({ id: String(r.id), t, rid, q, amount, price, gross, fee, ledgerProfit: profit, ledgerCost: profit != null ? (gross - profit) / amount : null, channel: exchange ? 'exchange' : 'contract', buyer: String(d.buyer || (contract ? dk.split('-').slice(2).join('-') : '')) });
    }
    return out.sort((a, b) => b.t - a.t);
  }
  /* ------------------------------------------------------------ ledger archive */
  // cashflow/recent holds only the newest 30 rows and every capture replaces it, so sales that roll off it between full
  // syncs were lost to Analyze. The archive (one per realm, scmLedgerArchive:<realm>) keeps the sale rows of every
  // captured page plus the time span each page proves complete: recent = oldest row → capture time; a cursor page
  // /cashflow/<id>/ = its oldest row → the time of row <id> (the oldest row of the page before it, kept in anchors).
  const ARCHIVE_DAYS = 35;
  const PAGE_RX = /\/api\/v2\/companies\/me\/cashflow\/(recent|\d+)\/?$/;
  const saleKey = dk => /^(?:marketfilled|fees|retail)-\d+$/.test(dk) || /^cs-\d+/.test(dk);
  const DETAIL_KEYS = ['resource', 'quality', 'amount', 'price', 'profit', 'buyer', 'unit_cogs', 'building_name'];
  function slimRow(r) {
    const d = (r && r.details) || {}, details = {};
    for (const k of DETAIL_KEYS) if (d[k] !== undefined) details[k] = d[k];
    return { id: r.id, datetime: r.datetime, category: r.category, descriptionKey: r.descriptionKey, money: r.money, details };
  }
  function mergeSpans(spans) {
    const s = (Array.isArray(spans) ? spans : []).filter(x => Array.isArray(x) && Number.isFinite(x[0]) && Number.isFinite(x[1]) && x[1] >= x[0]).map(x => [x[0], x[1]]).sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const x of s) { const l = out[out.length - 1]; if (l && x[0] <= l[1] + 1000) l[1] = Math.max(l[1], x[1]); else out.push(x); }
    return out;
  }
  // One captured page → { rows (sale rows only), span, anchor } or null.
  function pageCapture(url, list, receivedAt, anchors) {
    const m = String(url || '').match(PAGE_RX); if (!m || !Array.isArray(list) || !list.length) return null;
    const dated = list.filter(r => r && typeof r === 'object' && ms(r.datetime) != null);
    if (!dated.length) return null;
    let oldest = dated[0]; for (const r of dated) if (ms(r.datetime) < ms(oldest.datetime)) oldest = r;
    const lo = ms(oldest.datetime), newest = Math.max(...dated.map(r => ms(r.datetime)));
    const hi = m[1] === 'recent' ? Math.max(newest, ms(receivedAt) ?? newest) : Math.max(newest, num(anchors && anchors[m[1]]) ?? newest);
    return { rows: dated.filter(r => saleKey(String(r.descriptionKey || ''))).map(slimRow), span: [lo, hi], anchor: oldest.id != null ? [String(oldest.id), lo] : null };
  }
  // Pure merge of one page into an archive. Drops anything older than ARCHIVE_DAYS before `now`.
  function archiveMerge(archive, url, list, receivedAt, now = Date.now()) {
    const a = archive && typeof archive === 'object' ? archive : {};
    const rows = { ...(a.rows || {}) }, anchors = { ...(a.anchors || {}) };
    const p = pageCapture(url, list, receivedAt, anchors);
    let spans = Array.isArray(a.spans) ? a.spans : [];
    if (p) {
      for (const r of p.rows) rows[String(r.id != null ? r.id : `${r.datetime}|${r.descriptionKey}|${r.money}`)] = r;
      if (p.anchor) anchors[p.anchor[0]] = p.anchor[1];
      spans = [...spans, p.span];
    }
    const cut = now - ARCHIVE_DAYS * DAY;
    for (const [k, r] of Object.entries(rows)) if (!(ms(r && r.datetime) >= cut)) delete rows[k];
    for (const [k, t] of Object.entries(anchors)) if (!(Number(t) >= cut)) delete anchors[k];
    spans = mergeSpans(spans.map(x => [Math.max(x[0], cut), x[1]]));
    return { v: 1, rows, anchors, spans, added: p ? p.rows.length : 0 };
  }
  // 2.5.389 Ledger pages (/cashflow/<id>/) in a realm store: keep only those with a row from the last keepDays,
  // newest maxPages at most. Their sale rows live on in the ledger archive; the store copy is rewritten on every
  // save, and 307 kept pages (5.1 MB of a 7.6 MB R2 store) made each Sync write take seconds. /recent/ always stays.
  const LEDGER_PAGE_KEEP_DAYS = 8, LEDGER_PAGE_KEEP_MAX = 60;
  function pruneLedgerPages(map, now = Date.now(), keepDays = LEDGER_PAGE_KEEP_DAYS, maxPages = LEDGER_PAGE_KEEP_MAX) {
    const src = map && typeof map === 'object' ? map : {};
    const cut = now - keepDays * DAY, pages = [];
    for (const [k, v] of Object.entries(src)) {
      const m = k.match(PAGE_RX); if (!m || m[1] === 'recent') continue;
      const d = v && v.data, list = Array.isArray(d && d.data) ? d.data : Array.isArray(d) ? d : [];
      let newest = null; for (const r of list) { const t = ms(r && r.datetime); if (t != null && (newest == null || t > newest)) newest = t; }
      pages.push([k, newest == null ? ms(v && v.receivedAt) : newest]);
    }
    pages.sort((a, b) => (b[1] || 0) - (a[1] || 0));
    const drop = pages.filter(([, t], i) => i >= maxPages || !(t >= cut)).map(([k]) => k);
    if (!drop.length) return { map: src, dropped: 0 };
    const out = { ...src }; for (const k of drop) delete out[k];
    return { map: out, dropped: drop.length };
  }
  // Daily-walk ledger catch-up plan: the newest span holds the latest captures; walk back from its oldest row (the
  // anchor at its start) until a page reaches the span before it. One span = no hole = nothing to fetch (null).
  function catchUpPlan(archive) {
    const sp = mergeSpans(archive && archive.spans), last = sp[sp.length - 1];
    if (sp.length < 2) return null;
    let startId = null; for (const [id, t] of Object.entries((archive && archive.anchors) || {})) if (Number(t) === last[0]) startId = id;
    return startId ? { startId, startAt: last[0], stopAt: sp[sp.length - 2][1] } : null;
  }
  // Spans proven by the pages still in endpointData (same rules, anchors from those pages).
  function pageSpans(endpointData) {
    const pages = Object.entries(endpointData || {}).filter(([k]) => PAGE_RX.test(k)).map(([k, v]) => [k, v && v.data, v && v.receivedAt]);
    const anchors = {};
    for (const [, d] of pages) { const p = pageCapture('/api/v2/companies/me/cashflow/recent/', Array.isArray(d && d.data) ? d.data : d, null, null); if (p && p.anchor) anchors[p.anchor[0]] = p.anchor[1]; }
    return mergeSpans(pages.map(([k, d, at]) => pageCapture(k, Array.isArray(d && d.data) ? d.data : d, at, anchors)).filter(Boolean).map(p => p.span));
  }

  // Fee rate = Σ paired fees ÷ Σ paired sale value (sales ≥ $1,000 so integer rounding of small fees cannot skew it).
  function feeRate(sales) {
    const p = (Array.isArray(sales) ? sales : []).filter(s => s.channel === 'exchange' && s.fee != null && s.gross >= 1000);
    if (!p.length) return null;
    const fee = p.reduce((a, s) => a + s.fee, 0), gross = p.reduce((a, s) => a + s.gross, 0);
    return gross > 0 ? { rate: fee / gross, pairs: p.length, at: Math.max(...p.map(s => s.t)) } : null;
  }
  const inWindow = (list, days, now) => (Array.isArray(list) ? list : []).filter(x => x.t >= now - days * DAY && x.t <= now + 60000);

  /* ------------------------------------------------------------ warehouse */
  const lotTotal = l => Object.values((l && l.cost) || {}).reduce((a, v) => a + (Number(v) || 0), 0);
  // Warehouse cost per unit for one product + quality = Σ lot cost breakdown ÷ Σ amount.
  function warehouseCost(lots, rid, q) {
    let cost = 0, amount = 0, oldest = null;
    for (const l of Array.isArray(lots) ? lots : []) {
      if (!l || Number(l.kind) !== Number(rid) || Number(l.quality) !== Number(q) || !pos(l.amount)) continue;
      cost += lotTotal(l); amount += Number(l.amount);
      const t = ms(l.datetime); if (t != null && (oldest == null || t < oldest)) oldest = t;
    }
    return amount > 0 ? { unitCost: cost / amount, cost, amount, oldest } : null;
  }
  // Split of one product's lot cost per unit: named materials (lot.materials[i] ↔ cost.material{i+1}), labour (workers + admin), bought (market).
  function costSplit(lots, rid, q) {
    const parts = new Map(); let amount = 0, workers = 0, admin = 0, market = 0;
    for (const l of Array.isArray(lots) ? lots : []) {
      if (!l || Number(l.kind) !== Number(rid) || Number(l.quality) !== Number(q) || !pos(l.amount)) continue;
      amount += Number(l.amount); const c = l.cost || {};
      workers += Number(c.workers) || 0; admin += Number(c.admin) || 0; market += Number(c.market) || 0;
      const names = Array.isArray(l.materials) ? l.materials : [];
      for (let i = 0; i < 5; i++) { const v = Number(c[`material${i + 1}`]) || 0; if (!v) continue; const n = String(names[i] || `Material ${i + 1}`); parts.set(n, (parts.get(n) || 0) + v); }
    }
    if (!(amount > 0)) return null;
    const inputs = [...parts].map(([name, v]) => ({ name, perUnit: v / amount }));
    const inputsPU = inputs.reduce((a, x) => a + x.perUnit, 0);
    return { amount, inputs, inputsPerUnit: inputsPU, labourPerUnit: (workers + admin) / amount, workersPerUnit: workers / amount, adminPerUnit: admin / amount, boughtPerUnit: market / amount, totalPerUnit: inputsPU + (workers + admin + market) / amount };
  }
  const breakEven = (cost, rate) => (pos(cost) && rate != null && rate < 1 ? cost / (1 - rate) : null);
  const headroom = (price, be) => (pos(price) && be != null ? (price - be) / price : null);
  // Stock by product + quality: units, cost, value at today's price, break-even with fee, price-fall headroom, oldest lot date.
  function stock(lots, { priceOf, rate = null, minUnits = 0 } = {}) {
    const keys = new Map();
    for (const l of Array.isArray(lots) ? lots : []) if (l && pos(l.amount) && pos(l.kind)) keys.set(keyOf(l.kind, l.quality), [Number(l.kind), Number(l.quality)]);
    const rows = [];
    for (const [k, [rid, q]] of keys) {
      const w = warehouseCost(lots, rid, q); if (!w || w.amount < minUnits) continue;
      const p = typeof priceOf === 'function' ? priceOf(rid, q) : null, price = p && pos(p.price) ? Number(p.price) : null;
      const value = price != null ? w.amount * price : null, be = breakEven(w.unitCost, rate);
      rows.push({ key: k, rid, q, units: w.amount, unitCost: w.unitCost, cost: w.cost, price, priceSource: p && p.source || null, value, diff: value != null ? value - w.cost : null, breakEven: be, headroom: headroom(price, be), oldest: w.oldest });
    }
    rows.sort((a, b) => (a.diff == null) - (b.diff == null) || (a.diff ?? 0) - (b.diff ?? 0));
    const priced = rows.filter(r => r.value != null);
    return { rows, value: priced.reduce((a, r) => a + r.value, 0), cost: priced.reduce((a, r) => a + r.cost, 0), diff: priced.reduce((a, r) => a + r.diff, 0), below: priced.filter(r => r.diff < 0), unpriced: rows.filter(r => r.value == null) };
  }

  /* ------------------------------------------------------------ margins */
  // Calculator profit per unit (game Profit Calculator basis) = sale − Σ input qty × unit cost − labour. No fee, no transport.
  function calculatorProfit({ salePrice, inputs = [], labourPerUnit = 0, ratePerLevel = null } = {}) {
    if (!pos(salePrice)) return null;
    const cost = inputs.reduce((a, x) => a + Number(x.qty) * Number(x.unitCost), 0) + Number(labourPerUnit || 0);
    const profit = Number(salePrice) - cost;
    return { cost, profit, profitPerHourPerLevel: pos(ratePerLevel) ? profit * Number(ratePerLevel) : null };
  }
  // Per product + quality + channel (2.5.391: contract and retail too, each its own row):
  //   exchange earned/unit = avg sold − cost/unit − avg sold × fee rate; gap = calculator − earned = (price now − avg sold) + fee + (cost − calculator cost).
  //   contract earned/unit = avg sold − cost/unit (no fee: the ledger has none for contracts; transport not included).
  //   retail   earned/unit = avg sold − the game's COGS per unit (unit_cogs on each retail row).
  // Calculator and gap only for exchange rows (the calculator prices at today's exchange price).
  const CHANNEL_ORDER = { exchange: 0, contract: 1, retail: 2 };
  function margins(sales, { costOf, priceOf, calcOf, rate = null } = {}) {
    const g = new Map();
    for (const s of Array.isArray(sales) ? sales : []) {
      if (!(s.channel in CHANNEL_ORDER)) continue;
      const k = keyOf(s.rid, s.q), id = `${k}|${s.channel}`, x = g.get(id) || { id, key: k, rid: s.rid, q: s.q, channel: s.channel, units: 0, gross: 0, n: 0, fees: 0, ledgerCostSum: 0, ledgerUnits: 0 };
      x.units += s.amount; x.gross += s.gross; x.n++; if (s.fee != null) x.fees += s.fee;
      if (s.ledgerCost != null) { x.ledgerCostSum += s.ledgerCost * s.amount; x.ledgerUnits += s.amount; }
      g.set(id, x);
    }
    const rows = [];
    for (const x of g.values()) {
      const ex = x.channel === 'exchange', avg = x.gross / x.units, ledgerCost = x.ledgerUnits ? x.ledgerCostSum / x.ledgerUnits : null;
      const w = x.channel !== 'retail' && typeof costOf === 'function' ? costOf(x.rid, x.q) : null;
      const cost = w != null ? w : ledgerCost, costSource = w != null ? 'warehouse' : ledgerCost != null ? 'ledger' : null;
      const feePU = ex ? (rate != null ? avg * rate : null) : 0;
      const earned = cost != null && feePU != null ? avg - cost - feePU : null;
      const p = typeof priceOf === 'function' ? priceOf(x.rid, x.q) : null, price = p && pos(p.price) ? Number(p.price) : null;
      const c = ex && typeof calcOf === 'function' && price != null ? calcOf(x.rid, x.q, price) : null;
      const calc = c && c.ok && c.complete && c.profitPerUnit != null ? c.profitPerUnit : null;
      const calcCost = c && c.ok && c.complete ? c.sourcingCostPerUnit : null;
      const gap = calc != null && earned != null ? calc - earned : null;
      rows.push({ ...x, avg, cost, costSource, ledgerCost, feePU, earned, total: earned != null ? earned * x.units : null, price, priceSource: p && p.source || null, calc, calcCost, calcResult: c,
        gap, priceDiff: ex && price != null ? price - avg : null, costDiff: calcCost != null && cost != null ? cost - calcCost : null, pctOfCalc: calc != null && calc > 0 && earned != null ? earned / calc : null });
    }
    return rows.sort((a, b) => CHANNEL_ORDER[a.channel] - CHANNEL_ORDER[b.channel] || (b.gap ?? -Infinity) - (a.gap ?? -Infinity) || (b.total ?? -Infinity) - (a.total ?? -Infinity));
  }
  // Earned by channel from margin rows.
  function earnedBy(rows) {
    const out = { exchange: 0, contract: 0, retail: 0, total: 0 };
    for (const r of Array.isArray(rows) ? rows : []) if (r.total != null && r.channel in out) { out[r.channel] += r.total; out.total += r.total; }
    return out;
  }

  /* ------------------------------------------------------------ costs */
  // Production cost history (one entry per run: {id, q, c unit cost, t start}) for one product + quality.
  function costSeries(history, rid, q, days, now) {
    const pts = (Array.isArray(history) ? history : []).filter(e => e && Number(e.id) === Number(rid) && Number(e.q) === Number(q) && pos(e.c) && ms(e.t) != null)
      .map(e => [ms(e.t), Number(e.c)]).filter(([t]) => days == null || t >= now - days * DAY).sort((a, b) => a[0] - b[0]);
    const first = pts[0], last = pts[pts.length - 1];
    return { pts, first: first ? first[1] : null, last: last ? last[1] : null, change: pts.length > 1 && first[1] > 0 ? (last[1] - first[1]) / first[1] : null };
  }
  function producedKeys(history, days, now) {
    const m = new Map();
    for (const e of Array.isArray(history) ? history : []) { const t = ms(e && e.t); if (e && pos(e.id) && t != null && t >= now - days * DAY) m.set(keyOf(e.id, e.q), [Number(e.id), Number(e.q)]); }
    return [...m.values()];
  }

  /* ------------------------------------------------------------ fees & routes */
  function feesSummary(sales, rate) {
    const ex = (Array.isArray(sales) ? sales : []).filter(s => s.channel === 'exchange');
    const gross = ex.reduce((a, s) => a + s.gross, 0), paid = ex.reduce((a, s) => a + (s.fee || 0), 0), unpaired = ex.filter(s => s.fee == null).length;
    const by = new Map();
    for (const s of ex) { const k = keyOf(s.rid, s.q), x = by.get(k) || { key: k, rid: s.rid, q: s.q, fee: 0, units: 0, gross: 0 }; x.fee += s.fee || 0; x.units += s.amount; x.gross += s.gross; by.set(k, x); }
    const products = [...by.values()].map(x => ({ ...x, share: paid > 0 ? x.fee / paid : null, perUnit: x.units ? x.fee / x.units : null })).sort((a, b) => b.fee - a.fee);
    return { gross, paid, rate: rate != null ? rate : (gross > 0 && !unpaired ? paid / gross : null), unpaired, products };
  }
  // Day statements: /income-statement/day/<n>/ → [{t, fees, sales}] oldest first (company totals, unaffected by missing ledger pages).
  // history (2.5.392) = scmStatementHistory:<realm>: the same statements kept by date, so days past /day/13/ stay.
  function dayStatements(endpointData, field, history) {
    const out = [], seen = new Set();
    for (const d of Object.values((history && history[field]) || {})) { const t = ms(d && d.date); if (t != null && d.isComputed !== false && !seen.has(t)) { seen.add(t); out.push({ t, day: null, data: d }); } }
    for (const [k, v] of Object.entries(endpointData || {})) {
      const m = k.match(/\/api\/v2\/companies\/me\/(income-statement|cashflow-statement|balance-sheet)\/day\/(\d+)\/?$/);
      if (!m || m[1] !== field) continue;
      const d = v && v.data, t = ms(d && d.date); if (t == null) continue;
      const i = seen.has(t) ? out.findIndex(x => x.t === t) : -1;
      if (i >= 0) out[i] = { t, day: Number(m[2]), data: d }; else { seen.add(t); out.push({ t, day: Number(m[2]), data: d }); }
    }
    return out.sort((a, b) => a.t - b.t);
  }
  // Contract vs exchange per product: contract = average of your own paid contracts in the window; exchange net = price × (1 − fee).
  function routes(sales, { priceOf, rate = null } = {}) {
    const g = new Map();
    for (const s of Array.isArray(sales) ? sales : []) {
      const k = keyOf(s.rid, s.q), x = g.get(k) || { key: k, rid: s.rid, q: s.q, contracts: [], cUnits: 0, cGross: 0, exUnits: 0 };
      if (s.channel === 'contract') { x.contracts.push(s); x.cUnits += s.amount; x.cGross += s.gross; } else if (s.channel === 'exchange') x.exUnits += s.amount; else continue;
      g.set(k, x);
    }
    return [...g.values()].map(x => {
      const p = typeof priceOf === 'function' ? priceOf(x.rid, x.q) : null, price = p && pos(p.price) ? Number(p.price) : null;
      const exNet = price != null && rate != null ? price * (1 - rate) : null, cAvg = x.cUnits ? x.cGross / x.cUnits : null;
      return { ...x, price, exNet, contractAvg: cAvg, last: x.contracts[0] ? x.contracts[0].price : null, diff: cAvg != null && exNet != null ? cAvg - exNet : null, diffPct: cAvg != null && exNet ? (cAvg - exNet) / exNet : null };
    }).sort((a, b) => (b.contracts.length > 0) - (a.contracts.length > 0) || (b.diff ?? -Infinity) - (a.diff ?? -Infinity));
  }

  /* ------------------------------------------------------------ company & cash */
  const PF_ASSETS = [['buildings', 'Buildings'], ['patents', 'Patents'], ['cashAndReceivables', 'Cash and receivables'], ['investmentInBonds', 'Investment in bonds'], ['inventory', 'Inventory'], ['deposits', 'Deposits']];
  function pastFinances(endpointData) {
    const ep = endpointData || {}, d = ep['/api/v3/companies/me/past-finances/'] && ep['/api/v3/companies/me/past-finances/'].data;
    return (Array.isArray(d) ? d : []).map(r => ({ ...r, t: ms(r && r.date) })).filter(r => r.t != null && Number.isFinite(Number(r.total))).sort((a, b) => a.t - b.t);
  }
  function company(endpointData, now) {
    const rows = pastFinances(endpointData); if (!rows.length) return null;
    const last = rows[rows.length - 1], pts = rows.map(r => [r.t, Number(r.total)]);
    const back = (days) => { const tgt = last.t - days * DAY; let best = null; for (const r of rows) if (r.t <= tgt + DAY / 2 && (!best || r.t > best.t)) best = r; return best; };
    const w = back(7);
    const parts = PF_ASSETS.map(([k, label]) => ({ key: k, label, value: Number(last[k]) || 0 })).filter(p => p.value !== 0);
    const assets = Number(last.total), liabilities = Number(last.liabilities) || 0;
    const ov = endpointData && endpointData['/api/v2/companies/me/past-finances-overview/'] && endpointData['/api/v2/companies/me/past-finances-overview/'].data;
    const eva = (Array.isArray(ov) ? ov : []).map(r => ({ t: ms(r && r.date), v: num(r && r.economicValueAdded), rank: num(r && r.evaRank) })).filter(r => r.t != null && r.v != null).sort((a, b) => a.t - b.t);
    // EVA by week: 7-day buckets counted back from the newest daily row.
    const weeks = [];
    if (eva.length) { const end = eva[eva.length - 1].t; for (let i = 0; i < 6; i++) { const hi = end - i * 7 * DAY, lo = hi - 7 * DAY; const b = eva.filter(r => r.t > lo && r.t <= hi); if (!b.length) break; weeks.unshift({ end: hi, v: b.reduce((a, r) => a + r.v, 0), days: b.length }); } }
    return { last, pts, value: assets, liabilities, net: assets - liabilities, rank: num(last.rank), weekAgo: w ? Number(w.total) : null, change7: w && Number(w.total) ? (assets - Number(w.total)) / Number(w.total) : null, parts, assets, eva, weeks };
  }
  function cash(endpointData) {
    const rows = pastFinances(endpointData);
    const bs = endpointData && endpointData['/api/v2/companies/me/balance-sheet/'] && endpointData['/api/v2/companies/me/balance-sheet/'].data;
    const days = dayStatements(endpointData, 'cashflow-statement').map(d => -Number(d.data.cashAllExpenses)).filter(v => Number.isFinite(v) && v > 0);
    const cf = endpointData && endpointData['/api/v2/companies/me/cashflow-statement/'] && endpointData['/api/v2/companies/me/cashflow-statement/'].data;
    if (!days.length && cf && Number(cf.cashAllExpenses) < 0) days.push(-Number(cf.cashAllExpenses));
    const last = rows[rows.length - 1] || null;
    const car = last ? Number(last.cashAndReceivables) : (bs ? (Number(bs.cash) || 0) + (Number(bs.accountsReceivable) || 0) + (Number(bs.cashReservedForOrders) || 0) : null);
    const payout = days.length ? days.reduce((a, v) => a + v, 0) / days.length : null;
    return { pts: rows.map(r => [r.t, Number(r.cashAndReceivables)]).filter(p => Number.isFinite(p[1])), share: rows.map(r => [r.t, Number(r.total) ? Number(r.cashAndReceivables) / Number(r.total) : null]).filter(p => p[1] != null),
      value: car, total: last ? Number(last.total) : null, shareNow: last && Number(last.total) ? Number(last.cashAndReceivables) / Number(last.total) : null,
      cashOnHand: bs ? num(bs.cash) : null, reserved: bs ? num(bs.cashReservedForOrders) : null, receivable: bs ? num(bs.accountsReceivable) : null,
      payoutPerDay: payout, payoutDays: days.length, covers: payout && car != null ? car / payout : null };
  }

  /* ------------------------------------------------------------ findings & coverage */
  function findings({ stockRows = [], marginRows = [], costRows = [], routeRows = [] } = {}) {
    const out = [];
    for (const r of stockRows) if (r.diff != null && r.diff < 0) out.push({ tone: 'bad', w: -r.diff, key: r.key, kind: 'stock', r });
    for (const r of marginRows) {
      if (r.earned != null && r.earned < 0) out.push({ tone: 'bad', w: -r.total, key: r.key, kind: 'loss', r });
      else if (r.pctOfCalc != null && r.pctOfCalc < 0.75) out.push({ tone: 'warn', w: r.gap * r.units, key: r.key, kind: 'margin', r });
    }
    for (const r of costRows) if (r.change != null && r.change > 0.05) out.push({ tone: 'warn', w: r.change * 1000, key: r.key, kind: 'cost', r });
    for (const r of routeRows) if (r.diff != null && r.diff > 0 && r.contracts.length) out.push({ tone: 'good', w: r.diff * r.cUnits, key: r.key, kind: 'route', r });
    const rank = { bad: 0, warn: 1, good: 2 };
    return out.sort((a, b) => rank[a.tone] - rank[b.tone] || b.w - a.w);
  }
  // With spans (time proven complete by captured pages): coverage = covered time ÷ window up to the last capture, and
  // gaps = holes between spans inside the window (≥ 1 minute). Without spans: oldest row → now, as before.
  function ledgerCoverage(rows, days, now, spans) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return { rows: 0, oldest: null, newest: null, coverage: 0, spanDays: 0, gaps: [], gapMs: 0, lastCapture: null };
    const ts = list.map(r => ms(r.datetime)), oldest = Math.min(...ts), newest = Math.max(...ts), start = now - days * DAY;
    const sp = mergeSpans(spans);
    if (!sp.length) return { rows: list.length, oldest, newest, spanDays: (newest - oldest) / DAY, coverage: oldest <= start ? 1 : Math.max(0, Math.min(1, (now - oldest) / (now - start))), gaps: [], gapMs: 0, lastCapture: null };
    const end = Math.min(now, Math.max(...sp.map(x => x[1]))), inW = sp.map(([a, b]) => [Math.max(a, start), Math.min(b, end)]).filter(([a, b]) => b > a);
    const covered = inW.reduce((s, [a, b]) => s + b - a, 0), gaps = [];
    for (let i = 1; i < inW.length; i++) if (inW[i][0] - inW[i - 1][1] >= 60000) gaps.push([inW[i - 1][1], inW[i][0]]);
    const reach = inW.length ? inW[0][0] : end;
    return { rows: list.length, oldest, newest, spanDays: (end - reach) / DAY, coverage: end > start ? Math.max(0, Math.min(1, covered / (end - start))) : 0, gaps, gapMs: gaps.reduce((s, [a, b]) => s + b - a, 0), reach, lastCapture: end };
  }

  /* ------------------------------------------------------------ chart (build 2.5.382 Accounting sparkline style) */
  function trend(pts) {
    if (pts.length < 2) return null; const t0 = pts[0][0]; let sx = 0, sy = 0, sxy = 0, sxx = 0; const n = pts.length;
    for (const [t, y] of pts) { const x = (t - t0) / DAY; sx += x; sy += y; sxy += x * y; sxx += x * x; }
    const den = n * sxx - sx * sx; if (!den) return null; const m = (n * sxy - sx * sy) / den, b = (sy - m * sx) / n;
    return { m, at: t => m * ((t - t0) / DAY) + b };
  }
  function average(pts, days = 7) { return pts.map(([t]) => { const w = pts.filter(([u]) => u <= t && u > t - days * DAY); return [t, w.reduce((s, [, v]) => s + v, 0) / w.length]; }); }
  // tone: 'up-good' (value, price), 'up-bad' (cost, fees) or a fixed 'good' | 'bad' | 'flat'.
  function sparkline(pts, { tone = 'up-good', label = 'trend' } = {}) {
    const p = (Array.isArray(pts) ? pts : []).filter(x => Number.isFinite(x[0]) && Number.isFinite(x[1]));
    if (!p.length) return '<div class="acct-chart-empty">No history captured yet</div>';
    const W = 160, H = 64, P = 4, t0 = p[0][0], t1 = p[p.length - 1][0];
    let lo = Math.min(...p.map(x => x[1])), hi = Math.max(...p.map(x => x[1])); if (lo === hi) { lo -= 1; hi += 1; }
    const X = t => (t1 === t0 ? W / 2 : P + (t - t0) * (W - 2 * P) / (t1 - t0)), Y = v => H - P - (v - lo) * (H - 2 * P) / (hi - lo);
    const tr = trend(p), up = tr ? tr.m > 0 : null;
    const cls = tone === 'up-good' || tone === 'up-bad' ? (up == null || !tr.m ? 'flat' : (up === (tone === 'up-good') ? 'good' : 'bad')) : tone;
    const path = list => list.map((x, i) => (i ? 'L' : 'M') + X(x[0]).toFixed(1) + ',' + Y(x[1]).toFixed(1)).join('');
    const line = path(p), e = p[p.length - 1];
    const area = p.length > 1 ? `<path class="acct-area" d="${line}L${X(t1).toFixed(1)},${H}L${X(t0).toFixed(1)},${H}Z"/>` : '';
    const avg = p.length > 2 ? `<path class="acct-avg" d="${path(average(p))}"/>` : '';
    const tl = tr ? `<line class="acct-trend" x1="${X(t0).toFixed(1)}" y1="${Y(tr.at(t0)).toFixed(1)}" x2="${X(t1).toFixed(1)}" y2="${Y(tr.at(t1)).toFixed(1)}"/>` : '';
    const safe = String(label).replace(/[&<>"']/g, '');
    return `<svg class="acct-spark an-spark acct-${cls}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${safe}">${area}<path class="acct-line" d="${line}"/>${avg}${tl}<circle class="acct-dot" cx="${X(e[0]).toFixed(1)}" cy="${Y(e[1]).toFixed(1)}" r="2.4"/></svg>`;
  }
  const rangeStats = pts => { const v = (pts || []).map(p => p[1]); return v.length ? { lo: Math.min(...v), hi: Math.max(...v), change: v.length > 1 && v[0] ? (v[v.length - 1] - v[0]) / Math.abs(v[0]) : null } : null; };

  const api = { DAY, keyOf, realmEndpoints, realmCostHistory, ledgerRows, salesFromLedger, ARCHIVE_DAYS, archiveMerge, pruneLedgerPages, catchUpPlan, pageSpans, mergeSpans, feeRate, inWindow, lotTotal, warehouseCost, costSplit, breakEven, headroom, stock, calculatorProfit, margins, earnedBy, costSeries, producedKeys, feesSummary, dayStatements, routes, pastFinances, company, cash, findings, ledgerCoverage, trend, average, sparkline, rangeStats };
  root.SCM_ANALYZE_CORE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
