/* Sim Companies Manager — Analyze tab UI (Overview, Margins, Stock, Costs, Company, Fees, Cash, Sales, Routes,
 * product pages, Data & settings, first-run state). Pure presentation over SCM_ANALYZE_CORE; reads stored state only.
 * No network calls: the one storage read is the price log (scmPriceLog:<realm>) that the Tools tab already keeps.
 * Rendered from dashboard.js render() while the Analyze tab is active; ctx comes from dashboard.js analyzeContext(s). */
(function () {
  'use strict';
  const A = globalThis.SCM_ANALYZE_CORE;
  const $ = s => document.querySelector(s);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fin = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  const money = (v, d = 2) => fin(v) ? (Number(v) < 0 ? '−$' : '$') + Math.abs(Number(v)).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
  const smoney = (v, d = 2) => fin(v) ? (Number(v) > 0 ? '+' : '') + money(v, d) : '—';
  const big = v => { if (!fin(v)) return '—'; const n = Math.abs(Number(v)), s = Number(v) < 0 ? '−$' : '$'; return n >= 1e6 ? `${s}${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${s}${(n / 1e3).toFixed(1)}k` : `${s}${Math.round(n).toLocaleString()}`; };
  const sbig = v => fin(v) ? (Number(v) > 0 ? '+' : '') + big(v) : '—';
  const pct = (v, d = 1) => fin(v) ? `${(Number(v) * 100).toFixed(d)}%` : '—';
  const spct = (v, d = 1) => fin(v) ? `${Number(v) > 0 ? '+' : ''}${(Number(v) * 100).toFixed(d)}%` : '—';
  const units = v => fin(v) ? Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—';
  const tone = (v, upGood = true) => !fin(v) || Math.abs(Number(v)) < 1e-9 ? 'an-flat' : (Number(v) > 0) === upGood ? 'an-good' : 'an-bad';
  const store = { get(k, d) { try { const v = localStorage.getItem('scmAnalyze:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem('scmAnalyze:' + k, JSON.stringify(v)); } catch { /* ignore */ } } };
  const DAY = 864e5;
  const PAGES = [['overview', 'Overview'], ['margins', 'Margins'], ['stock', 'Stock'], ['costs', 'Costs'], ['company', 'Company'], ['fees', 'Fees'], ['cash', 'Cash'], ['sales', 'Sales'], ['routes', 'Routes'], ['data', 'Data']];

  const S = { page: PAGES.some(p => p[0] === store.get('page', 'overview')) ? store.get('page', 'overview') : 'overview', prod: null, back: 'overview', days: [7, 14, 30].includes(store.get('days', 7)) ? store.get('days', 7) : 7, minUnits: store.get('minUnits', 0) === 5 ? 5 : 0, range: store.get('range', 30), salesKey: 'all', salesShow: 20, closed: new Set(store.get('closed', [])), s: null, ctx: null, model: null, modelSig: '', took: 0, at: 0, log: null, logRealm: null, logLoading: false };

  /* ------------------------------------------------------------ data */
  function loadLog(realm) {
    if (realm == null || S.logLoading || (S.logRealm === realm && S.log)) return;
    S.logLoading = true;
    chrome.storage.local.get({ ['scmPriceLog:' + realm]: null }).then(r => { S.log = r['scmPriceLog:' + realm]; S.logRealm = realm; })
      .catch(() => { S.log = null; }).finally(() => { S.logLoading = false; if (isActive()) paint(true); });
  }
  const isActive = () => $('#analyze')?.classList.contains('active');
  const nameOf = rid => { try { return S.ctx?.nameOf?.(rid) || `Resource #${rid}`; } catch { return `Resource #${rid}`; } };
  const label = (rid, q) => `${esc(nameOf(rid))} Q${Number(q)}`;
  function dataSig(s) {
    const ep = s?.endpointData || {};
    const ledger = Object.keys(ep).filter(k => /\/cashflow\/(?:recent|\d+)\/?$/.test(k)).map(k => ep[k]?.receivedAt || '').join(',');
    return [S.days, S.minUnits, s?.lastSync, ledger, (s?.warehouseResources || []).length, JSON.stringify((s?.warehouseResources || []).map(l => [l?.id, l?.amount])).length, s?.vwapData?.updatedAt, s?.liveMarketPriceData?.updatedAt, (s?.productionCostHistory || []).length, ep['/api/v3/companies/me/past-finances/']?.receivedAt, ep['/api/v2/companies/me/balance-sheet/']?.receivedAt].join('|');
  }
  function compute(force) {
    const s = S.s, ctx = S.ctx || {}, sig = dataSig(s);
    if (!force && S.model && sig === S.modelSig) return S.model;
    const t0 = performance.now(), now = Date.now(), ep = s?.endpointData || {};
    const memo = new Map(), priceOf = (rid, q) => { const k = A.keyOf(rid, q); if (!memo.has(k)) { let p = null; try { p = ctx.priceOf?.(rid, q) || null; } catch { /* no price */ } memo.set(k, p); } return memo.get(k); };
    const calcMemo = new Map(), calcOf = (rid, q, price) => { const k = `${A.keyOf(rid, q)}@${price}`; if (!calcMemo.has(k)) { let c = null; try { c = ctx.calcOf?.(rid, q, price) || null; } catch { /* no calculator */ } calcMemo.set(k, c); } return calcMemo.get(k); };
    const lots = Array.isArray(ctx.lots) ? ctx.lots : [];
    const rows = A.ledgerRows(ep), allSales = A.salesFromLedger(rows), fr = A.feeRate(allSales), rate = fr ? fr.rate : null;
    const sales = A.inWindow(allSales, S.days, now);
    const stock = A.stock(lots, { priceOf, rate, minUnits: S.minUnits });
    const costOf = (rid, q) => A.warehouseCost(lots, rid, q)?.unitCost ?? null;
    const margins = A.margins(sales, { costOf, priceOf, calcOf, rate });
    const pch = Array.isArray(s?.productionCostHistory) ? s.productionCostHistory : [];
    const keys = new Map(A.producedKeys(pch, S.days, now).map(([r, q]) => [A.keyOf(r, q), [r, q]]));
    for (const m of margins) if (!keys.has(m.key) && A.costSeries(pch, m.rid, m.q, S.days, now).pts.length) keys.set(m.key, [m.rid, m.q]);
    const costRows = [...keys.values()].map(([rid, q]) => ({ key: A.keyOf(rid, q), rid, q, ...A.costSeries(pch, rid, q, S.days, now), split: A.costSplit(lots, rid, q) })).sort((a, b) => (b.change ?? -Infinity) - (a.change ?? -Infinity));
    const fees = A.feesSummary(sales, rate);
    const feeDays = A.dayStatements(ep, 'income-statement').map(d => ({ t: d.t, fee: -Number(d.data.marketFees) || 0, sales: Number(d.data.sales) || 0 }));
    const routes = A.routes(sales, { priceOf, rate });
    const company = A.company(ep, now), cash = A.cash(ep);
    const findings = A.findings({ stockRows: stock.rows, marginRows: margins, costRows, routeRows: routes });
    const coverage = A.ledgerCoverage(rows, S.days, now);
    const earned = margins.filter(m => m.total != null).reduce((a, m) => a + m.total, 0);
    S.model = { now, rows, allSales, sales, fr, rate, lots, stock, margins, costRows, fees, feeDays, routes, company, cash, findings, coverage, earned, priceOf, calcOf, pch };
    S.modelSig = sig; S.took = performance.now() - t0; S.at = now;
    return S.model;
  }

  /* ------------------------------------------------------------ building blocks */
  const row = (l, v, cls = '') => `<div class="an-row ${cls}"><span>${l}</span><b>${v}</b></div>`;
  const note = (html, cls = '') => `<p class="an-note ${cls}">${html}</p>`;
  function card(id, title, body, { open = true, right = '', cls = '' } = {}) {
    const isOpen = S.closed.has(id) ? false : open;
    return `<details class="an-card ${cls}" data-an-card="${esc(id)}"${isOpen ? ' open' : ''}><summary><span class="an-card-t">${title}</span>${right ? `<span class="an-card-r">${right}</span>` : ''}</summary><div class="an-body">${body}</div></details>`;
  }
  const prodBtn = (rid, q, text) => `<button type="button" class="an-link" data-an-prod="${A.keyOf(rid, q)}">${text || label(rid, q)} ›</button>`;
  const goBtn = (page, text) => `<button type="button" class="an-link" data-an-go="${page}">${text} ›</button>`;
  const when = t => { if (!fin(t)) return '—'; const d = new Date(t), n = new Date(), hm = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); const days = Math.floor((new Date(n.toDateString()) - new Date(d.toDateString())) / DAY); return days === 0 ? `Today ${hm}` : days === 1 ? `Yesterday ${hm}` : days < 7 ? `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${hm}` : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
  const age = t => { if (!fin(t)) return '—'; const h = (Date.now() - t) / 36e5; return h < 48 ? `${Math.max(0, h).toFixed(0)} h` : `${(h / 24).toFixed(1)} days`; };
  const stats = (pts, fmt) => { const r = A.rangeStats(pts); return r ? `<div class="acct-stats"><div><span>Low</span><b>${fmt(r.lo)}</b></div><div><span>High</span><b>${fmt(r.hi)}</b></div><div><span>Change</span><b class="${r.change == null ? '' : r.change >= 0 ? 'acct-good' : 'acct-bad'}">${spct(r.change)}</b></div></div>` : ''; };
  const rangePills = () => `<div class="acct-chart-bar"><div class="acct-range">${[[7, '7d'], [30, '30d'], [90, '90d'], [0, 'All']].map(([d, l]) => `<button type="button" class="acct-range-btn" data-an-range="${d}" aria-pressed="${Number(S.range) === d}">${l}</button>`).join('')}</div></div>`;
  const cut = (pts, days) => { if (!days || !pts.length) return pts; const end = pts[pts.length - 1][0]; return pts.filter(p => p[0] >= end - days * DAY); };
  const legend = '<div class="acct-legend"><span><i class="acct-key-line"></i>Value</span><span><i class="acct-key-avg"></i>7-day average</span><span><i class="acct-key-trend"></i>Trend</span></div>';
  const feeTxt = m => m.rate == null ? 'fee rate unknown' : `${pct(m.rate, 2)} exchange fee`;
  function priceSeries(rid, q) {
    const h = S.s?.history?.[A.keyOf(rid, q)];
    const daily = (Array.isArray(h) ? h : []).map(x => [Date.parse(`${x?.date}T12:00:00Z`), Number(x?.vwap)]).filter(p => Number.isFinite(p[0]) && p[1] > 0).sort((a, b) => a[0] - b[0]);
    if (daily.length > 1) return { pts: daily, src: `daily VWAP, Q${q}` };
    const log = S.log?.series?.[rid];
    const pts = (Array.isArray(log) ? log : []).filter(p => Number.isFinite(p?.[0]) && Number(p?.[1]) > 0).map(p => [p[0], Number(p[1])]);
    return { pts, src: 'price log, lowest captured quality' };
  }

  /* ------------------------------------------------------------ pages */
  function head(title, { back = false } = {}) {
    return `<div class="an-head">${back ? `<button type="button" class="an-back" data-an-back>‹ Back</button>` : `<div><div class="an-eyebrow">Analyze · ${esc(S.ctx?.companyName || 'your company')}</div><h3>${title}</h3></div>`}${back ? `<h3 class="an-title">${title}</h3>` : `<button type="button" class="an-icon" data-an-go="data" aria-label="Data and settings"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="17" r="2"/></svg></button>`}</div>`;
  }
  const nav = () => `<div class="an-nav" role="tablist">${PAGES.map(([k, l]) => `<button type="button" class="an-chip" data-an-go="${k}" aria-pressed="${S.page === k}">${l}</button>`).join('')}</div>`;
  const tile = (page, lbl, val, sub, cls = '') => `<button type="button" class="an-tile" data-an-go="${page}"><span>${lbl} ›</span><b class="${cls}">${val}</b><small>${sub}</small></button>`;

  function findingText(f, m) {
    const r = f.r, L = label(r.rid, r.q);
    if (f.kind === 'stock') return [`${L}: ${units(r.units)} units sit ${big(-r.diff)} below cost`, `Cost ${money(r.unitCost)}, price now ${money(r.price)}. Break-even with fee ${money(r.breakEven)}.`];
    if (f.kind === 'loss') return [`${L}: ${money(r.earned)} earned per unit`, `Sold at ${money(r.avg)} avg, cost ${money(r.cost)}, fee ${money(r.feePU)}.`];
    if (f.kind === 'margin') return [`${L}: ${money(r.earned)} earned per unit, ${money(r.calc)} on the calculator`, `Sold ${money(Math.abs(r.priceDiff))} ${r.priceDiff >= 0 ? 'under' : 'over'} today's price, plus ${money(r.feePU)} exchange fee.`];
    if (f.kind === 'cost') return [`${L} costs ${spct(r.change)} in ${S.days} days`, `${money(r.first)} → ${money(r.last)} per unit, from your production runs.`];
    if (f.kind === 'route') return [`${L} pays more by contract`, `${money(r.contractAvg)} vs ${money(r.exNet)} net on the exchange (${spct(r.diffPct)}).`];
    return ['', ''];
  }
  function pageOverview(m) {
    const c = m.company, ca = m.cash, w = c?.weeks || [], thisW = w[w.length - 1], lastW = w[w.length - 2];
    const tiles = [
      tile('company', 'Company value', big(c?.value), c?.change7 != null ? `${spct(c.change7)} in 7 days` : 'from past finances', ''),
      tile('company', 'EVA this week', sbig(thisW?.v), thisW && lastW ? `${thisW.v >= lastW.v ? 'up' : 'down'} on last week` : `${thisW?.days || 0} days so far`, tone(thisW?.v)),
      tile('margins', 'Earned from sales', sbig(m.earned), `${S.days} days, after cost and fee`, tone(m.earned)),
      tile('stock', 'Warehouse vs cost', sbig(m.stock.diff), `${big(m.stock.value)} at today's prices`, tone(m.stock.diff)),
      tile('fees', 'Exchange fees', big(m.fees.paid), m.rate != null ? `${pct(m.rate, 2)} of ${big(m.fees.gross)} sold` : 'no paired fee rows yet'),
      tile('cash', 'Idle cash', pct(ca?.shareNow, 0), 'of total assets', ca?.shareNow > 0.25 ? 'an-warn' : '')
    ].join('');
    const pts = cut(c?.pts || [], 30);
    const valCard = c ? card('ov-value', 'Company value · 30 days', `${A.sparkline(pts, { label: 'Company value, 30 days' })}<div class="an-axis"><span>${big(pts[0]?.[1])}</span><span>${big(pts[pts.length - 1]?.[1])}</span></div>${goBtn('company', 'Value and EVA')}`, { right: 'past finances' }) : '';
    const fl = m.findings.slice(0, 6).map(f => { const [a, b] = findingText(f, m); const target = f.kind === 'route' ? 'data-an-go="routes"' : `data-an-prod="${f.key}"`; return `<button type="button" class="an-find" ${target}><i class="an-dot an-dot-${f.tone}"></i><span><b>${a}</b><small>${b}</small></span><em aria-hidden="true">›</em></button>`; }).join('');
    const finds = card('ov-finds', 'Worth a look', fl || note('Nothing stands out in the captured data.'), { right: `${m.findings.length} found` });
    const salesUnits = m.sales.reduce((a, s) => a + s.amount, 0);
    const how = card('ov-how', 'How to read the numbers', `${note(`<b>Earned</b> = sold price − cost per unit − sold price × ${feeTxt(m)} (rate from your ledger).`)}${note('<b>Calculator</b> = the game\'s Profit Calculator at today\'s price for that quality. It leaves the fee and transport out.')}${note('<b>Cost per unit</b> = warehouse lot cost (inputs + labour) ÷ units. If no lot is left, the cost the game recorded at sale.')}`, { open: false });
    return `${head('Overview')}${nav()}<div class="an-tiles">${tiles}</div>${valCard}${finds}<button type="button" class="an-wide" data-an-go="sales"><span>All sales · last ${S.days} days</span><b>${units(salesUnits)} units ›</b></button>${how}`;
  }
  function marginCard(r, m) {
    const badge = r.pctOfCalc != null ? `<span class="an-pill ${r.pctOfCalc < 0.75 ? 'an-pill-bad' : r.pctOfCalc < 0.95 ? 'an-pill-warn' : 'an-pill-good'}">${pct(r.pctOfCalc, 0)} of calculator</span>` : '';
    const parts = [];
    if (r.priceDiff != null) parts.push(`sold ${money(Math.abs(r.priceDiff))} ${r.priceDiff >= 0 ? 'under' : 'over'} today's price`);
    if (r.feePU != null) parts.push(`${money(r.feePU)} fee`);
    if (r.costDiff != null && Math.abs(r.costDiff) >= 0.005) parts.push(`cost ${money(Math.abs(r.costDiff))} ${r.costDiff > 0 ? 'above' : 'below'} the calculator's`);
    const gap = r.gap != null ? note(`Gap of ${money(r.gap)} per unit: ${parts.join(', ')}.`, 'an-box') : r.price == null ? note('No current price captured for this quality, so no calculator figure.', 'an-box') : r.calcResult && !r.calcResult.ok ? note(esc(r.calcResult.error || r.calcResult.reason || 'Calculator not available.'), 'an-box') : r.calcResult && !r.calcResult.complete ? note(`Calculator incomplete: no price for ${esc((r.calcResult.missing || []).map(nameOf).join(', '))}.`, 'an-box') : '';
    const body = [
      row(`Sold for (avg of ${r.n} sale${r.n === 1 ? '' : 's'})`, money(r.avg)),
      row(`− Cost per unit (${r.costSource === 'ledger' ? 'game cost at sale' : 'warehouse lot'})`, money(r.cost)),
      row(`− Exchange fee ${pct(m.rate, 2)}`, money(r.feePU)),
      row('Earned per unit', money(r.earned), `an-total ${tone(r.earned)}`),
      row(`Calculator today (price ${money(r.price)}, no fee)`, money(r.calc), r.calc != null && r.calc < 0 ? 'an-bad' : ''),
      row(`Total earned (${units(r.units)} units)`, money(r.total, 0)),
      r.ledgerCost != null && r.costSource === 'warehouse' ? row('Game cost at sale (ledger, check)', money(r.ledgerCost), 'an-sub') : '',
      gap
    ].join('');
    return card(`mg-${r.key}`, prodBtn(r.rid, r.q), body, { right: badge });
  }
  function pageMargins(m) {
    const units_ = m.margins.reduce((a, r) => a + r.units, 0), rev = m.margins.reduce((a, r) => a + r.gross, 0);
    const sum = card('mg-sum', `Earned from exchange sales · ${S.days} days`, `${row('Earned', money(m.earned, 0), `an-total ${tone(m.earned)}`)}${row('Units sold', `${units(units_)}`)}${row('Revenue', money(rev, 0))}${goBtn('sales', 'All sales')}`);
    const cards = m.margins.map(r => marginCard(r, m)).join('') || note(`No exchange sales in the captured ledger for the last ${S.days} days.`);
    return `${head('What each product earns')}${nav()}${sum}${note('Each card shows how the sale price turns into profit, then compares it with the game\'s calculator. Sorted by biggest gap.')}${cards}${note(`Ledger coverage ${pct(m.coverage.coverage, 0)} of ${S.days} days. Cost per unit is the current warehouse lot cost, not the cost when each unit was made.`, 'an-dashed')}`;
  }
  function stockCard(r, m) {
    const body = [
      row('Units in warehouse', units(r.units)), row('Cost per unit', money(r.unitCost)), row('Exchange price now', money(r.price)),
      row(`Break-even price (with ${pct(m.rate, 2)} fee)`, money(r.breakEven)), row('Total cost → value today', `${big(r.cost)} → ${big(r.value)}`), row('Oldest lot', age(r.oldest)),
      r.price == null ? note('No current price captured for this quality.', 'an-box') : r.headroom != null ? note(r.headroom >= 0 ? `Price can fall ${pct(r.headroom)} before this lot loses money.` : `Price must rise ${pct(r.breakEven / r.price - 1)} to break even.`, `an-box ${r.headroom >= 0 ? 'an-good' : 'an-bad'}`) : ''
    ].join('');
    return card(`st-${r.key}`, prodBtn(r.rid, r.q), body, { right: `<b class="${tone(r.diff)}">${sbig(r.diff)}</b>`, cls: r.diff != null && r.diff < 0 ? 'an-edge-bad' : '' });
  }
  function pageStock(m) {
    const st = m.stock;
    const top = `<div class="an-stats3"><div><span>Value today</span><b>${big(st.value)}</b></div><div><span>What it cost</span><b>${big(st.cost)}</b></div><div><span>Difference</span><b class="${tone(st.diff)}">${sbig(st.diff)}</b></div></div>`;
    const alert = st.below.length ? `<div class="an-alert">${st.below.length} of ${st.rows.length} products priced below cost: ${st.below.slice(0, 3).map(r => `${label(r.rid, r.q)} ${big(r.diff)}`).join(', ')}.</div>` : '';
    return `${head('Warehouse stock')}${nav()}${top}${alert}${note(`Value today = units × exchange price at that quality. Cost = your warehouse lot cost breakdown. Break-even = cost ÷ (1 − ${m.rate != null ? pct(m.rate, 2) : 'fee'}).${st.unpriced.length ? ` ${st.unpriced.length} product(s) have no current price and are left out of the totals.` : ''}`)}${st.rows.map(r => stockCard(r, m)).join('') || note('No warehouse lots captured yet.')}`;
  }
  function costCard(r) {
    const sp = r.split;
    const split = sp ? [
      ...sp.inputs.map(x => row(esc(x.name), money(x.perUnit), 'an-sub')),
      row('Inputs', money(sp.inputsPerUnit)), row('Labour (wages + admin)', money(sp.labourPerUnit)),
      sp.boughtPerUnit > 0 ? row('Bought on the market', money(sp.boughtPerUnit)) : '', row('Lot cost per unit now', money(sp.totalPerUnit), 'an-total')
    ].join('') : note('No warehouse lot for this quality, so no input / labour split.');
    return card(`co-${r.key}`, prodBtn(r.rid, r.q), `<div class="an-cost-top"><b>${money(r.first)} → ${money(r.last)}</b><span class="${tone(r.change, false)}">${r.change == null ? 'one run' : spct(r.change)}</span></div>${A.sparkline(r.pts, { tone: 'up-bad', label: `${nameOf(r.rid)} cost per unit` })}${split}`, { right: `${r.pts.length} run${r.pts.length === 1 ? '' : 's'}` });
  }
  function routeLines(r, m, n = 3) {
    if (!r.contracts.length) return note(`No contracts in the last ${S.days} days. Exchange net would be ${money(r.exNet)} per unit at today's price.`);
    return `${row(`Exchange (${money(r.price)} less ${pct(m.rate, 2)})`, money(r.exNet))}${row('Contract average (your paid contracts)', money(r.contractAvg))}${row('Contract fee and transport', '<span class="an-tv">to verify</span>')}${r.contracts.slice(0, n).map(c => row(`${when(c.t)} · ${units(c.amount)} × ${money(c.price)}${c.buyer ? ` · ${esc(c.buyer)}` : ''}`, money(c.gross), 'an-sub')).join('')}`;
  }
  function pageCosts(m) {
    const cards = m.costRows.map(costCard).join('') || note(`No production runs captured in the last ${S.days} days.`);
    const f = m.fees;
    const fees = card('co-fees', `Exchange fees · ${S.days} days`, `${row('Sold on the exchange', money(f.gross, 0))}${row('Fee rate (from your ledger)', pct(m.rate, 2))}${row('Fees paid', money(f.paid, 0))}${m.earned > 0 ? note(`That is ${pct(f.paid / m.earned, 0)} of the ${money(m.earned, 0)} you earned.`) : ''}${goBtn('fees', 'Fee breakdown')}`);
    const rr = m.routes.filter(r => r.contracts.length).slice(0, 3);
    const routes = card('co-routes', 'Contract vs exchange · net per unit', `${rr.map(r => `<div class="an-sec">${prodBtn(r.rid, r.q)}<span class="${tone(r.diff)}">${smoney(r.diff)} (${spct(r.diffPct)})</span></div>${row(`Exchange (${money(r.price)} less ${pct(m.rate, 2)})`, money(r.exNet))}${row('Contract (your average paid)', money(r.contractAvg))}`).join('') || note(`No paid contracts in the last ${S.days} days.`)}${note('Contract transport and any contract fee are not included (to verify).')}${goBtn('routes', 'All routes')}`);
    return `${head('Costs, fees and routes')}${nav()}${note(`Cost per unit · last ${S.days} days, from your production runs (cost the game shows on each batch). Split = your warehouse lot now: inputs and labour (wages + admin).`)}${cards}${fees}${routes}`;
  }
  function pageCompany(m) {
    const c = m.company; if (!c) return `${head('Company value and EVA')}${nav()}${note('Past finances not captured yet. Open Accounting in the game, then Sync.')}`;
    const pts = cut(c.pts, Number(S.range));
    const val = card('cp-value', 'Company value', `<div class="an-hero"><b>${big(c.value)}</b><span class="${tone(c.change7)}">${c.weekAgo != null ? `${sbig(c.value - c.weekAgo)} (${spct(c.change7)}) in 7 days · was ${big(c.weekAgo)}` : ''}</span>${c.rank != null ? `<small>Rank ${units(c.rank)}</small>` : ''}</div>${rangePills()}${A.sparkline(pts, { label: 'Company value' })}${legend}${stats(pts, big)}`);
    const total = c.parts.reduce((a, p) => a + p.value, 0) || 1, colors = ['#46c2ad', '#6aa9e8', '#e8b04a', '#b58be8', '#f07167', '#8d98a8'];
    const comp = card('cp-own', 'What the company owns', `<div class="an-bar" aria-hidden="true">${c.parts.map((p, i) => `<i style="width:${(p.value / total * 100).toFixed(2)}%;background:${colors[i % colors.length]}"></i>`).join('')}</div>${c.parts.map((p, i) => row(`<i class="an-sw" style="background:${colors[i % colors.length]}"></i>${esc(p.label)}`, `${big(p.value)} · ${pct(p.value / total)}`)).join('')}${row('Total (game value)', big(c.assets), 'an-total')}${row('− Liabilities', big(c.liabilities))}${row('Net of liabilities', big(c.net), 'an-total')}`);
    const wk = c.weeks;
    const eva = card('cp-eva', 'EVA by week', wk.length ? `${wk.length > 1 ? A.sparkline(wk.map(w => [w.end, w.v]), { label: 'EVA by week' }) : `${A.sparkline(c.eva.map(r => [r.t, r.v]), { label: 'EVA by day' })}${note(`Daily EVA, ${c.eva.length} days (one week captured so far).`, 'an-sub')}`}<div class="an-weeks">${wk.map((w, i) => `<span${i === wk.length - 1 ? ' class="an-now"' : ''}><b>${sbig(w.v)}</b><small>${i === wk.length - 1 ? 'this' : `${wk.length - 1 - i} wk`}${w.days < 7 ? ` · ${w.days}d` : ''}</small></span>`).join('')}</div>${note(`EVA is the profit left after a charge for the capital the company uses. Weeks are 7-day sums of the game's daily EVA${wk.length > 1 ? `; ${wk[wk.length - 1].v >= wk[wk.length - 2].v ? 'up' : 'down'} ${big(Math.abs(wk[wk.length - 1].v - wk[wk.length - 2].v))} on last week` : ''}.`)}` : note('No EVA rows captured yet (past-finances-overview).'));
    return `${head('Company value and EVA', { back: true })}${nav()}${val}${comp}${eva}${note('Source: the game\'s past-finances, past-finances-overview and balance-sheet captures. Asset names follow the game\'s balance sheet.', 'an-dashed')}`;
  }
  function pageFees(m) {
    const f = m.fees, fd = m.feeDays.slice(-7);
    const top = card('fe-sum', `Fees paid · ${S.days} days`, `<div class="an-hero"><b>${money(f.paid)}</b><span>${pct(m.rate, 2)} of ${money(f.gross, 0)} sold${m.earned > 0 ? ` · ${pct(f.paid / m.earned, 0)} of what you earned` : ''}</span></div>${f.unpaired ? note(`${f.unpaired} exchange sale(s) had no matching fee row in the captured pages.`) : ''}`);
    const days = card('fe-days', 'Fees by day (company total)', fd.length ? `${A.sparkline(fd.map(d => [d.t, d.fee]), { tone: 'up-bad', label: 'Fees by day' })}<div class="an-weeks">${fd.map(d => `<span><b>${big(d.fee)}</b><small>${new Date(d.t).toLocaleDateString(undefined, { weekday: 'short' })}</small></span>`).join('')}</div>${note('From the game\'s day income statements (market fees), so missing ledger pages do not affect it.')}` : note('No day income statements captured yet.'));
    const prods = card('fe-prod', 'Fees by product', f.products.map(p => `${row(prodBtn(p.rid, p.q), money(p.fee))}${note(`${units(p.units)} units × ${money(p.perUnit)} · ${pct(p.share)} of fees`, 'an-sub')}`).join('') || note('No paired fee rows in the window.'));
    const how = card('fe-how', 'Where the rate comes from', `${note(`Fee paid ÷ sale value on matching ledger pairs (fees-… against marketfilled-…, same second). ${m.fr ? `${m.fr.pairs} pairs of $1,000 or more give ${pct(m.rate, 2)}; latest ${when(m.fr.at)}.` : 'No pairs captured yet.'}`)}`, { open: false });
    return `${head('Exchange fees', { back: true })}${nav()}${top}${days}${prods}${how}`;
  }
  function pageCash(m) {
    const c = m.cash; if (!c || c.value == null) return `${head('Cash', { back: true })}${nav()}${note('Past finances or balance sheet not captured yet.')}`;
    const pts = cut(c.pts, Number(S.range));
    const top = card('ca-val', 'Cash and receivables', `<div class="an-hero"><b>${big(c.value)}</b><span>${pct(c.shareNow, 0)} of ${big(c.total)} total assets</span></div>${rangePills()}${A.sparkline(pts, { label: 'Cash' })}${legend}${stats(pts, big)}`);
    const br = card('ca-br', 'Breakdown (balance sheet)', `${row('Available cash', big(c.cashOnHand))}${row('Reserved for open buy orders', big(c.reserved))}${row('Accounts receivable', big(c.receivable))}${row('Cash and receivables', big(c.value), 'an-total')}`);
    const last = card('ca-last', 'How long it lasts', `${row(`Cash paid out per day (${c.payoutDays}-day avg)`, big(c.payoutPerDay))}${row('Covers', c.covers != null ? `${c.covers.toFixed(1)} days` : '—', 'an-total')}${note('Cash and receivables ÷ cash paid out per day (day cash-flow statements, all expenses including exchange buys).')}`);
    const sh = card('ca-share', 'Share of assets', `${A.sparkline(cut(c.share, Number(S.range) || 0), { tone: 'flat', label: 'Cash share of assets' })}${stats(cut(c.share, Number(S.range) || 0), v => pct(v))}`);
    return `${head('Cash', { back: true })}${nav()}${top}${br}${last}${sh}${note('This page only reports. It does not say what to do with the cash.', 'an-dashed')}`;
  }
  function saleRow(s, m) {
    const cost = A.warehouseCost(m.lots, s.rid, s.q)?.unitCost ?? s.ledgerCost, fee = s.fee != null ? s.fee : (m.rate != null && s.channel === 'exchange' ? s.gross * m.rate : 0);
    const earned = cost != null ? s.gross - fee - cost * s.amount : null;
    const body = `${row(`${units(s.amount)} × ${money(s.price)}`, money(s.gross))}${s.channel === 'exchange' ? row(`Fee${s.fee == null ? ` (${pct(m.rate, 2)})` : ''}`, money(-fee)) : row('Contract fee / transport', '<span class="an-tv">to verify</span>')}${row(`Cost ${units(s.amount)} × ${money(cost)}`, money(cost != null ? -cost * s.amount : null))}${row('Earned', smoney(earned), `an-total ${tone(earned)}`)}`;
    return `<div class="an-sale"><div class="an-sec">${prodBtn(s.rid, s.q)}<span class="an-muted">${when(s.t)} · ${s.channel === 'exchange' ? 'exchange' : `contract${s.buyer ? ` · ${esc(s.buyer)}` : ''}`}</span></div>${body}</div>`;
  }
  function pageSales(m) {
    const prods = [...new Map(m.sales.map(s => [A.keyOf(s.rid, s.q), s])).values()];
    const list = S.salesKey === 'all' ? m.sales : m.sales.filter(s => A.keyOf(s.rid, s.q) === S.salesKey);
    const filt = `<div class="an-nav">${[['all', 'All'], ...prods.map(s => [A.keyOf(s.rid, s.q), `${nameOf(s.rid)} Q${s.q}`])].map(([k, l]) => `<button type="button" class="an-chip" data-an-filter="${k}" aria-pressed="${S.salesKey === k}">${esc(l)}</button>`).join('')}</div>`;
    const sum = `<div class="an-stats3"><div><span>Units</span><b>${units(list.reduce((a, s) => a + s.amount, 0))}</b></div><div><span>Revenue</span><b>${big(list.reduce((a, s) => a + s.gross, 0))}</b></div><div><span>Earned (margins)</span><b class="${tone(m.earned)}">${sbig(S.salesKey === 'all' ? m.earned : m.margins.find(r => r.key === S.salesKey)?.total)}</b></div></div>`;
    const more = list.length > S.salesShow ? `<button type="button" class="an-wide" data-an-more><span>Show more</span><b>${S.salesShow} of ${list.length} sales</b></button>` : '';
    return `${head('All sales', { back: true })}${nav()}${dayPills()}${filt}${sum}${list.slice(0, S.salesShow).map(s => saleRow(s, m)).join('') || note('No sales in the captured ledger for this window.')}${more}${note('Sales come from the cash-flow ledger. Cost uses the current warehouse lot cost (else the game\'s cost at sale). Ledger pages never captured are missing here.', 'an-dashed')}`;
  }
  const dayPills = () => `<div class="acct-chart-bar"><div class="acct-range">${[7, 14, 30].map(d => `<button type="button" class="acct-range-btn" data-an-days="${d}" aria-pressed="${S.days === d}">${d} days</button>`).join('')}</div></div>`;
  function pageRoutes(m) {
    const cards = m.routes.map(r => card(`rt-${r.key}`, prodBtn(r.rid, r.q), routeLines(r, m, 4), { right: r.contracts.length && r.diffPct != null ? `<b class="${tone(r.diff)}">${spct(r.diffPct)}</b>` : '' })).join('');
    return `${head('Contract vs exchange', { back: true })}${nav()}${note(`Net per unit by contract or on the exchange, using your own paid contracts from the last ${S.days} days. Exchange net = price now × (1 − ${pct(m.rate, 2)}).`)}${cards || note('No sales in the captured ledger for this window.')}${note('Not included: contract transport. Whether contracts carry a fee is still to verify.', 'an-dashed')}`;
  }
  function pageProduct(m) {
    const [rid, q] = String(S.prod || '').split(':').map(Number);
    if (!(rid > 0)) { S.page = 'overview'; return pageOverview(m); }
    const p = m.priceOf(rid, q), price = p?.price ?? null, ser = priceSeries(rid, q), wk = ser.pts.length ? ser.pts.filter(x => x[0] <= ser.pts[ser.pts.length - 1][0] - 7 * DAY).pop() : null;
    const mg = m.margins.find(r => r.key === A.keyOf(rid, q)), st = m.stock.rows.find(r => r.key === A.keyOf(rid, q)) || (() => { const w = A.warehouseCost(m.lots, rid, q); if (!w) return null; const be = A.breakEven(w.unitCost, m.rate); return { units: w.amount, unitCost: w.unitCost, cost: w.cost, price, value: price != null ? price * w.amount : null, diff: price != null ? price * w.amount - w.cost : null, breakEven: be, headroom: A.headroom(price, be), oldest: w.oldest }; })();
    const calc = price != null ? m.calcOf(rid, q, price) : null, cs = A.costSeries(m.pch, rid, q, S.days, m.now), split = A.costSplit(m.lots, rid, q);
    const route = m.routes.find(r => r.key === A.keyOf(rid, q)), sales = m.sales.filter(s => s.rid === rid && s.q === q);
    const pr = card('pd-price', 'Exchange price now', `<div class="an-hero"><b>${money(price)}</b><span class="${tone(wk && price ? price - wk[1] : null)}">${wk && price ? `${spct((price - wk[1]) / wk[1])} vs ${money(wk[1])} a week ago` : ''}</span><small>${esc(p?.source || 'no current price captured')}</small></div>${A.sparkline(ser.pts.slice(-60), { label: `${nameOf(rid)} price` })}${note(`Trend: ${ser.src}.`, 'an-sub')}`);
    const per = card('pd-per', 'Per unit sold', mg ? `${row(`Sold for (avg of ${mg.n} sales)`, money(mg.avg))}${row('− Cost per unit', money(mg.cost))}${row(`− Exchange fee ${pct(m.rate, 2)}`, money(mg.feePU))}${row('Earned per unit', money(mg.earned), `an-total ${tone(mg.earned)}`)}${row('Calculator today (no fee)', money(mg.calc))}${mg.gap != null ? note(`Gap ${money(mg.gap)}: sold ${money(Math.abs(mg.priceDiff))} ${mg.priceDiff >= 0 ? 'under' : 'over'} today's price, ${money(mg.feePU)} fee${mg.costDiff != null && Math.abs(mg.costDiff) >= 0.005 ? `, cost ${money(Math.abs(mg.costDiff))} ${mg.costDiff > 0 ? 'above' : 'below'} the calculator's` : ''}.`, 'an-box') : ''}` : note(`No exchange sales of this quality in the last ${S.days} days.`), { right: mg?.pctOfCalc != null ? `<span class="an-pill ${mg.pctOfCalc < 0.75 ? 'an-pill-bad' : 'an-pill-good'}">${pct(mg.pctOfCalc, 0)} of calculator</span>` : '' });
    const calcLines = calc && calc.ok ? `${calc.inputs.map(x => row(`${esc(nameOf(x.id))} × ${x.qty} @ ${money(x.unitCost)}`, x.unitCost == null ? 'no price' : money(x.qty * x.unitCost))).join('')}${row('Labour (wages + admin)', money(calc.labourPerUnit))}${row('Calculator cost per unit', money(calc.sourcingCostPerUnit), 'an-total')}${calc.profitPerUnit != null ? row(`Profit per unit at ${money(price)}`, money(calc.profitPerUnit), tone(calc.profitPerUnit)) : ''}${calc.profitPerHourPerLevel != null ? row(`Profit / h / level (× ${calc.ratePerLevel.toFixed(3)})`, money(calc.profitPerHourPerLevel), 'an-sub') : ''}` : note(esc(calc?.error || calc?.reason || (price == null ? 'No current price for this quality.' : 'Calculator not available.')));
    const lotLines = split ? `<div class="an-sec"><b>Your warehouse lot</b></div>${split.inputs.map(x => row(esc(x.name), money(x.perUnit), 'an-sub')).join('')}${row('Labour (wages + admin)', money(split.labourPerUnit), 'an-sub')}${split.boughtPerUnit > 0 ? row('Bought on the market', money(split.boughtPerUnit), 'an-sub') : ''}${row('Lot cost per unit', money(split.totalPerUnit), 'an-total')}` : '';
    const cost = card('pd-cost', 'Cost per unit', `${calcLines}${lotLines}${cs.pts.length ? `${A.sparkline(cs.pts, { tone: 'up-bad', label: 'Cost per unit' })}${note(`${S.days} days of production runs: ${money(cs.first)} → ${money(cs.last)}${cs.change != null ? ` (${spct(cs.change)})` : ''}.`, 'an-sub')}` : ''}${note('Input names and quantities come from the game constants recipe (resource id), unit costs from your cheapest warehouse lot as the game does, else the market.', 'an-sub')}`);
    const wh = card('pd-wh', 'In your warehouse', st ? `${row('Units', units(st.units))}${row('Total cost → value today', `${big(st.cost)} → ${big(st.value)}`)}${row('Break-even price (with fee)', money(st.breakEven))}${row('Difference', sbig(st.diff), tone(st.diff))}${row('Oldest lot', age(st.oldest))}${st.headroom != null ? note(st.headroom >= 0 ? `Price can fall ${pct(st.headroom)} before this lot loses money.` : `Price must rise ${pct(st.breakEven / st.price - 1)} to break even.`, `an-box ${st.headroom >= 0 ? 'an-good' : 'an-bad'}`) : ''}` : note('None of this quality in the warehouse.'));
    const rs = card('pd-sales', 'Recent sales', `${sales.slice(0, 5).map(s => row(`${when(s.t)} · ${units(s.amount)} × ${money(s.price)} · ${s.channel}`, money(s.gross))).join('') || note(`No sales in the last ${S.days} days.`)}<button type="button" class="an-link" data-an-sales="${A.keyOf(rid, q)}">All ${esc(nameOf(rid))} sales ›</button>`);
    const rt = card('pd-route', 'Contract vs exchange', route ? routeLines(route, m) : note(`No sales in the last ${S.days} days, so nothing to compare.`));
    return `${head(label(rid, q), { back: true })}${pr}${per}${cost}${wh}${rs}${rt}`;
  }
  function sources(m) {
    const s = S.s || {}, ep = s.endpointData || {}, gc = s.gameConstants;
    const days = A.dayStatements(ep, 'income-statement').length, pf = A.pastFinances(ep).length, log = S.log?.series ? Object.keys(S.log.series).length : 0;
    const st = (ok, txt) => `<span class="an-st ${ok ? 'an-good' : 'an-warn'}">${txt}</span>`;
    return [
      ['Warehouse lots', `${m.lots.length} lots${s.lastSync ? ` · sync ${when(Date.parse(s.lastSync))}` : ''}`, st(m.lots.length > 0, m.lots.length ? 'Captured' : 'Missing')],
      ['Cash-flow ledger', `${units(m.coverage.rows)} rows · ${m.coverage.spanDays.toFixed(1)} days`, st(m.coverage.coverage >= 1, `${pct(m.coverage.coverage, 0)} of ${S.days} days`)],
      ['Day income statements', `${days} day(s) captured`, st(days >= 7, `${days} of 7`)],
      ['Past finances', `${pf} daily rows`, st(pf > 1, pf ? 'Captured' : 'Missing')],
      ['Production cost history', `${units(m.pch.length)} runs`, st(m.pch.length > 0, m.pch.length ? 'Captured' : 'None yet')],
      ['Price log', `${log} products tracked`, st(log > 0, log ? 'Captured' : 'None yet')],
      ['Recipes and constants', gc ? 'Game constants loaded' : 'Not loaded', st(!!gc, gc ? 'Loaded' : 'Missing')]
    ].map(([a, b, c]) => `<div class="an-src"><span><b>${a}</b><small>${b}</small></span>${c}</div>`).join('');
  }
  function pageData(m) {
    const src = card('dt-src', 'What Analyze reads', sources(m));
    const gaps = card('dt-gaps', 'Known gaps', [
      ['Ledger pages missing.', m.coverage.coverage < 1 ? `The captured ledger reaches back ${m.coverage.spanDays.toFixed(1)} days. Per-product sales and fees read low before that; company totals use the day statements.` : 'None for this window.'],
      ['Cost at time of sale.', 'Earned uses the current warehouse lot cost. The game\'s own cost at sale is shown on Margins as a check.'],
      ['Contracts.', 'Only your own paid contracts. Contract transport and any contract fee are still to verify.'],
      ['Cost split over time.', 'Production history stores the total cost per run only, so the inputs / labour split is today\'s lot.']
    ].map(([a, b]) => `<div class="an-gap"><b>${a}</b> ${esc(b)}</div>`).join(''), { open: false });
    const set = card('dt-set', 'Settings', `<div class="an-set"><span><b>Look-back window</b><small>Sales, margins, fees, routes, cost trends</small></span></div>${dayPills()}<label class="an-switch"><input type="checkbox" data-an-min${S.minUnits ? ' checked' : ''}><span><b>Ignore lots under 5 units</b><small>Hides tiny leftovers on Stock</small></span></label><div class="an-set"><span><b>Computed when the tab opens</b><small>No background work · result kept until the data changes</small></span></div><button type="button" class="an-wide" data-an-recalc><span>Recalculate now</span><b>${S.took.toFixed(0)} ms · 0 network calls</b></button>${note(`Last calculated ${when(S.at)}.`, 'an-sub')}<button type="button" class="an-link" data-an-go="empty">Preview the first-run screen ›</button>`);
    return `${head('Data and settings', { back: true })}${nav()}${src}${gaps}${set}`;
  }
  function pageEmpty(m) {
    const ledgerDays = m.coverage.spanDays, items = [
      [m.lots.length > 0, 'Warehouse captured', 'Unlocks Stock', 'stock'],
      [A.pastFinances(S.s?.endpointData).length > 0, 'Past finances captured', 'Unlocks Company value and Cash', 'company'],
      [ledgerDays >= 3, `Cash-flow ledger: ${ledgerDays.toFixed(1)} days so far`, 'Needs 3 or more days for Margins, Sales and Fees', 'margins'],
      [m.pch.length > 1, `Production cost history: ${m.pch.length ? `${m.pch.length} runs` : 'none yet'}`, 'Needs 2 runs for the cost trend on Costs', 'costs']
    ], ready = items.filter(x => x[0]);
    return `${head('Not enough data yet', { back: S.page === 'empty' })}${note('Analyze works from what the manager has already captured. It needs a little more before the reports make sense.')}${card('em-ready', `Ready · ${ready.length} of ${items.length}`, items.map(([ok, a, b]) => `<div class="an-src"><span><b>${ok ? '✓ ' : ''}${esc(a)}</b><small>${esc(b)}</small></span><span class="an-st ${ok ? 'an-good' : 'an-warn'}">${ok ? 'Ready' : 'Waiting'}</span></div>`).join(''))}<button type="button" class="an-wide" data-an-sync><span>Run Sync now</span><b>›</b></button>${ready.length ? card('em-now', 'Available now', ready.map(x => goBtn(x[3], x[2].replace(/^Unlocks /, ''))).join('')) : ''}`;
  }
  const isEmpty = m => !m.lots.length && !m.company && !m.sales.length;

  /* ------------------------------------------------------------ shell */
  function shell() {
    const root = $('#analyzeBody'); if (!root) return null;
    if (!root.dataset.ready) {
      root.dataset.ready = '1';
      root.addEventListener('click', onClick);
      root.addEventListener('change', e => { if (e.target.matches('[data-an-min]')) { S.minUnits = e.target.checked ? 5 : 0; store.set('minUnits', S.minUnits); paint(true); } });
      root.addEventListener('toggle', e => { const d = e.target; if (!d?.matches?.('[data-an-card]')) return; const id = d.dataset.anCard; if (d.open) S.closed.delete(id); else S.closed.add(id); store.set('closed', [...S.closed].slice(-200)); }, true);
    }
    return root;
  }
  function go(page) { if (page !== 'product' && page !== 'empty') { S.back = page; store.set('page', page); } S.page = page; S.salesShow = 20; paint(true); $('#analyze')?.scrollIntoView?.({ block: 'start' }); }
  function onClick(e) {
    const t = e.target.closest('button'); if (!t) return;
    const d = t.dataset;
    if (d.anGo) return go(d.anGo);
    if (d.anProd) { if (S.page !== 'product') S.back = S.page; S.prod = d.anProd; S.page = 'product'; paint(true); $('#analyze')?.scrollIntoView?.({ block: 'start' }); return; }
    if ('anBack' in d) { S.page = S.back && S.back !== 'product' ? S.back : 'overview'; return paint(true); }
    if (d.anDays) { S.days = Number(d.anDays); store.set('days', S.days); return paint(true); }
    if ('anRange' in d) { S.range = Number(d.anRange); store.set('range', S.range); return paint(true); }
    if (d.anFilter) { S.salesKey = d.anFilter; S.salesShow = 20; return paint(true); }
    if (d.anSales) { S.salesKey = d.anSales; return go('sales'); }
    if ('anMore' in d) { S.salesShow += 20; return paint(true); }
    if ('anRecalc' in d) { compute(true); return paint(true); }
    if ('anSync' in d) { $('#sync')?.click(); return; }
  }
  let lastSig = '';
  function paint(force) {
    const root = shell(); if (!root || !S.s || !A) return;
    const m = compute(false);
    const sig = [S.page, S.prod, S.days, S.minUnits, S.range, S.salesKey, S.salesShow, S.modelSig, S.logRealm, S.log?.updatedAt].join('|');
    if (!force && sig === lastSig) return;
    lastSig = sig;
    const page = S.page === 'empty' || (isEmpty(m) && S.page !== 'data') ? 'empty' : S.page;
    const fn = { overview: pageOverview, margins: pageMargins, stock: pageStock, costs: pageCosts, company: pageCompany, fees: pageFees, cash: pageCash, sales: pageSales, routes: pageRoutes, product: pageProduct, data: pageData, empty: pageEmpty }[page] || pageOverview;
    let html = '';
    try { html = fn(m); } catch (err) { console.error('Analyze page failed', err); html = `${head('Analyze')}${nav()}${note(`This page could not be built: ${esc(err?.message || err)}`, 'an-alert')}`; }
    root.innerHTML = `${html}<div class="an-foot">Computed on open from stored data · 0 network calls · ${S.took.toFixed(0)} ms · ${when(S.at)}</div>`;
  }
  function render(s, ctx) {
    S.s = s; S.ctx = ctx || {};
    loadLog(S.ctx.realm);
    paint(false);
  }
  globalThis.SCM_ANALYZE_UI = { render, _state: S, _go: go };
})();
