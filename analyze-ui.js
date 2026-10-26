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
  // Column labels (7 across a phone): $152k, $24.8k, −$9.6k, $1.2M.
  const short = v => { if (!fin(v)) return '—'; const n = Math.abs(Number(v)), s = Number(v) < 0 ? '−$' : '$'; return n >= 1e6 ? `${s}${(n / 1e6).toFixed(1)}M` : n >= 1e5 ? `${s}${Math.round(n / 1e3)}k` : n >= 1e3 ? `${s}${(n / 1e3).toFixed(1)}k` : `${s}${Math.round(n)}`; };
  const sbig = v => fin(v) ? (Number(v) > 0 ? '+' : '') + big(v) : '—';
  const pct = (v, d = 1) => fin(v) ? `${(Number(v) * 100).toFixed(d)}%` : '—';
  const spct = (v, d = 1) => fin(v) ? `${Number(v) > 0 ? '+' : ''}${(Number(v) * 100).toFixed(d)}%` : '—';
  const units = v => fin(v) ? Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—';
  const tone = (v, upGood = true) => !fin(v) || Math.abs(Number(v)) < 1e-9 ? 'an-flat' : (Number(v) > 0) === upGood ? 'an-good' : 'an-bad';
  const store = { get(k, d) { try { const v = localStorage.getItem('scmAnalyze:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem('scmAnalyze:' + k, JSON.stringify(v)); } catch { /* ignore */ } } };
  const DAY = 864e5;
  const PAGES = [['overview', 'Overview'], ['margins', 'Margins'], ['stock', 'Stock'], ['costs', 'Costs'], ['company', 'Company'], ['fees', 'Fees'], ['cash', 'Cash'], ['sales', 'Sales'], ['routes', 'Routes'], ['data', 'Data']];

  const S = { page: PAGES.some(p => p[0] === store.get('page', 'overview')) ? store.get('page', 'overview') : 'overview', prod: null, back: 'overview', days: [7, 14, 30].includes(store.get('days', 7)) ? store.get('days', 7) : 7, minUnits: store.get('minUnits', 0) === 5 ? 5 : 0, range: store.get('range', 30), salesKey: 'all', salesShow: 20, closed: new Set(store.get('closed', [])), auto: store.get('auto', true) !== false, keep: store.get('keep', true) !== false, s: null, ctx: null, model: null, modelSig: '', took: 0, at: 0, log: null, logRealm: null, logLoading: false };

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
  function compute(force, revisit = false) {
    const s = S.s, ctx = S.ctx || {}, sig = dataSig(s);
    const set = `${S.days}|${S.minUnits}`;
    if (!force && S.model && S.modelSet === set) {
      // Settings: "Compute when the tab opens" off = keep the last result until Recalculate; "Keep the last result for
      // 10 minutes" = coming back to the tab within 10 minutes shows the last result at once; data arriving while the
      // tab is open always recomputes.
      if (sig === S.modelSig || !S.auto || (revisit && S.keep && Date.now() - S.at < 10 * 60000)) return S.model;
    }
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
    S.modelSig = sig; S.modelSet = set; S.took = performance.now() - t0; S.at = now;
    return S.model;
  }


  /* ------------------------------------------------------------ building blocks (layout follows the Analyze mockups) */
  const row = (l, v, cls = '') => `<div class="an-row ${cls}"><span>${l}</span><b>${v}</b></div>`;
  const hr = '<div class="an-hr"></div>';
  const small = (html, cls = '') => `<p class="an-small ${cls}">${html}</p>`;
  const intro = html => `<p class="an-intro">${html}</p>`;
  const gapbox = (html, cls = '') => `<div class="an-gapbox ${cls}">${html}</div>`;
  const dash = html => `<div class="an-card an-dash">${html}</div>`;
  const isOpen = (id, open = true) => (S.closed.has(id) ? false : open);
  // A section: heading above its card; the heading folds the card away (collapsible, never a card inside a card).
  const sec = (id, title, body, { open = true, cls = '', right = '' } = {}) => `<details class="an-sec" data-an-card="${esc(id)}"${isOpen(id, open) ? ' open' : ''}><summary class="an-h2"><span>${title}</span>${right ? `<em>${right}</em>` : ''}</summary><div class="an-card ${cls}">${body}</div></details>`;
  // A product card: the card itself folds; its header row stays visible.
  const pcard = (id, head, body, { cls = '', open = true } = {}) => `<details class="an-card an-pc ${cls}" data-an-card="${esc(id)}"${isOpen(id, open) ? ' open' : ''}><summary class="an-pc-head">${head}</summary><div class="an-pc-body">${body}</div></details>`;
  const pill = (txt, kind) => `<span class="an-pill an-pill-${kind}">${txt}</span>`;
  const plink = (rid, q, text) => `<button type="button" class="an-plink" data-an-prod="${A.keyOf(rid, q)}">${text || label(rid, q)} <i>›</i></button>`;
  const link = (page, text, cls = '') => `<button type="button" class="an-link ${cls}" data-an-go="${page}">${text} ›</button>`;
  const when = t => { if (!fin(t)) return '—'; const d = new Date(t), n = new Date(), hm = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); const days = Math.floor((new Date(n.toDateString()) - new Date(d.toDateString())) / DAY); return days === 0 ? `Today ${hm}` : days === 1 ? `Yesterday ${hm}` : days < 7 ? `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${hm}` : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
  const age = t => { if (!fin(t)) return '—'; const h = (Date.now() - t) / 36e5; return h < 48 ? `${Math.max(0, h).toFixed(0)} h` : `${(h / 24).toFixed(1)} days`; };
  const stats = (pts, fmt, lbl) => { const r = A.rangeStats(pts); return r ? `<div class="acct-stats"><div><span>Low</span><b>${fmt(r.lo)}</b></div><div><span>High</span><b>${fmt(r.hi)}</b></div><div><span>Change${lbl ? ` · ${lbl}` : ''}</span><b class="${r.change == null ? '' : r.change >= 0 ? 'acct-good' : 'acct-bad'}">${spct(r.change)}</b></div></div>` : ''; };
  const rangePills = () => `<div class="acct-chart-bar"><div class="acct-range">${[[7, '7d'], [30, '30d'], [90, '90d'], [0, 'All']].map(([d, l]) => `<button type="button" class="acct-range-btn" data-an-range="${d}" aria-pressed="${Number(S.range) === d}">${l}</button>`).join('')}</div></div>`;
  const rangeLbl = () => (Number(S.range) ? `${S.range}d` : 'all');
  const cut = (pts, days) => { if (!days || !pts.length) return pts; const end = pts[pts.length - 1][0]; return pts.filter(p => p[0] >= end - days * DAY); };
  const legend = name => `<div class="acct-legend"><span><i class="acct-key-line"></i>${name}</span><span><i class="acct-key-avg"></i>Average</span><span><i class="acct-key-trend"></i>Trend</span></div>`;
  const feeLbl = m => (m.rate == null ? 'fee' : `${pct(m.rate, 2)}`);
  const daySeg = () => `<div class="an-seg2">${[7, 14, 30].map(d => `<button type="button" data-an-days="${d}" aria-pressed="${S.days === d}">${d} days</button>`).join('')}</div>`;
  function priceSeries(rid, q) {
    const h = S.s?.history?.[A.keyOf(rid, q)];
    const daily = (Array.isArray(h) ? h : []).map(x => [Date.parse(`${x?.date}T12:00:00Z`), Number(x?.vwap)]).filter(p => Number.isFinite(p[0]) && p[1] > 0).sort((a, b) => a[0] - b[0]);
    if (daily.length > 1) return { pts: daily, src: `daily VWAP, Q${q}` };
    const log = S.log?.series?.[rid];
    return { pts: (Array.isArray(log) ? log : []).filter(p => Number.isFinite(p?.[0]) && Number(p?.[1]) > 0).map(p => [p[0], Number(p[1])]), src: 'price log, lowest captured quality' };
  }
  const MAIN = [['overview', 'Overview'], ['margins', 'Margins'], ['stock', 'Stock'], ['costs', 'Costs']];
  const BACK_LABEL = { overview: 'Overview', margins: 'Margins', stock: 'Stock', costs: 'Costs', company: 'Company', fees: 'Fees', cash: 'Cash', sales: 'All sales', routes: 'Routes', data: 'Data and settings' };
  const settingsIcon = '<button type="button" class="an-icon" data-an-go="data" aria-label="Data and settings"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="9" cy="7" r="2" fill="#1a2029"/><circle cx="15" cy="12" r="2" fill="#1a2029"/><circle cx="8" cy="17" r="2" fill="#1a2029"/></svg></button>';
  // Main pages: "Analyze" eyebrow + title, then the four-way switch (Overview · Margins · Stock · Costs).
  const mainHead = (title, right = '') => `<div class="an-top"><div><div class="an-eyebrow">Analyze</div><div class="an-h1">${title}</div></div>${right}</div><div class="an-seg">${MAIN.map(([k, l]) => `<button type="button" data-an-go="${k}" aria-pressed="${S.page === k}">${l}</button>`).join('')}</div>`;
  // Detail pages: "‹ Back" link, then the title.
  const detailHead = (title, backTo = 'overview', right = '') => `<div class="an-top"><button type="button" class="an-back" data-an-back="${backTo}">‹ ${esc(BACK_LABEL[backTo] || 'Overview')}</button></div><div class="an-titlerow"><div class="an-h1">${title}</div>${right}</div>`;
  const quality = () => link('data', 'Data quality');

  /* ------------------------------------------------------------ pages */
  const tile = (page, lbl, val, sub, subCls = '', valCls = '') => `<button type="button" class="an-tile" data-an-go="${page}"><span>${lbl} ›</span><b class="${valCls}">${val}</b><small class="${subCls}">${sub}</small></button>`;
  function findingText(f) {
    const r = f.r, L = label(r.rid, r.q);
    if (f.kind === 'stock') return [`${L}: ${units(r.units)} units sit ${big(-r.diff)} below cost`, `Cost ${money(r.unitCost)}, price now ${money(r.price)}. Break-even with fee ${money(r.breakEven)}.`];
    if (f.kind === 'loss') return [`${L}: ${money(r.earned)} earned per unit`, `Sold at ${money(r.avg)} avg, cost ${money(r.cost)}, fee ${money(r.feePU)}.`];
    if (f.kind === 'margin') return [`${L}: ${money(r.earned)} earned per unit, ${money(r.calc)} on the calculator`, `Sold ${money(Math.abs(r.priceDiff))} ${r.priceDiff >= 0 ? 'under' : 'over'} today's price, plus ${money(r.feePU)} exchange fee`];
    if (f.kind === 'cost') return [`${esc(nameOf(r.rid))} costs ${spct(r.change)} in ${S.days} days`, `${money(r.first)} → ${money(r.last)} per unit, from your production runs`];
    if (f.kind === 'route') return [`${esc(nameOf(r.rid))} pays more by contract`, `${money(r.contractAvg)} vs ${money(r.exNet)} net on the exchange (${spct(r.diffPct)})`];
    return ['', ''];
  }
  function pageOverview(m) {
    const c = m.company, ca = m.cash, w = c?.weeks || [], thisW = w[w.length - 1], lastW = w[w.length - 2];
    const tiles = [
      tile('company', 'Company value', big(c?.value), c?.change7 != null ? `${spct(c.change7)} in 7 days` : 'from past finances', tone(c?.change7)),
      tile('company', 'EVA this week', sbig(thisW?.v), thisW && lastW ? `${thisW.v >= lastW.v ? 'up' : 'down'} on last week` : `${thisW?.days || 0} days so far`, thisW && lastW ? tone(thisW.v - lastW.v) : ''),
      tile('margins', 'Earned from sales', big(m.earned), `${S.days} days, after cost and fee`),
      tile('stock', 'Warehouse vs cost', sbig(m.stock.diff), `${big(m.stock.value)} at today's prices`, '', tone(m.stock.diff)),
      tile('fees', 'Exchange fees', big(m.fees.paid), m.rate != null ? `${pct(m.rate, 2)} of ${big(m.fees.gross)} sold` : 'no fee rows yet'),
      tile('cash', 'Idle cash', pct(ca?.shareNow, 0), 'of total assets', 'an-warn')
    ].join('');
    const pts = cut(c?.pts || [], 30);
    const chart = c ? `<button type="button" class="an-card an-cardbtn" data-an-go="company"><span class="an-cardbtn-h"><b>Company value · 30 days ›</b><small>from past-finances</small></span>${A.sparkline(pts, { label: 'Company value, 30 days' })}<span class="an-axis"><span>${big(pts[0]?.[1])}</span><span>${big(pts[pts.length - 1]?.[1])}</span></span></button>` : '';
    const fl = m.findings.slice(0, 5).map(f => { const [a, b] = findingText(f); const target = f.kind === 'route' ? 'data-an-go="routes"' : f.kind === 'cost' ? 'data-an-go="costs"' : `data-an-prod="${f.key}"`; return `<button type="button" class="an-find" ${target}><i class="an-dot an-dot-${f.tone}"></i><span><b>${a}</b><small>${b}</small></span><em aria-hidden="true">›</em></button>`; }).join('');
    const finds = `<div class="an-card"><div class="an-card-t">Worth a look · tap for detail</div>${fl || small('Nothing stands out in the captured data.')}</div>`;
    const salesUnits = m.sales.reduce((a, s) => a + s.amount, 0);
    const how = `<details class="an-card an-dash an-how" data-an-card="ov-how"${isOpen('ov-how') ? ' open' : ''}><summary>How to read the numbers</summary><div><b>Earned</b> = sold price − cost per unit − ${feeLbl(m)} exchange fee, from your sales.</div><div><b>Calculator</b> = the game's profit calculator at today's price. It leaves the fee out.</div><div><b>Cost per unit</b> = inputs + labour from your warehouse lot.</div></details>`;
    return `${mainHead(esc(S.ctx?.companyName || 'Your company'), settingsIcon)}<div class="an-tiles">${tiles}</div>${chart}${finds}<button type="button" class="an-wide" data-an-go="sales"><span>All sales · last ${S.days} days</span><b>${units(salesUnits)} units ›</b></button>${how}`;
  }
  function marginCard(r, m) {
    const k = r.pctOfCalc == null ? null : r.pctOfCalc < 0.75 ? 'bad' : r.pctOfCalc < 0.95 ? 'warn' : 'good';
    const badge = r.calc != null && r.calc < 0 && r.price != null && r.avg > r.price ? pill(`Price fell ${pct((r.avg - r.price) / r.avg, 0)}`, 'bad') : k ? pill(`${pct(r.pctOfCalc, 0)} of calculator`, k) : '';
    const parts = [];
    if (r.priceDiff != null) parts.push(`you sold ${money(Math.abs(r.priceDiff))} ${r.priceDiff >= 0 ? 'under' : 'above'} today's price`);
    if (r.feePU != null) parts.push(`paid ${money(r.feePU)} in fee`);
    if (r.costDiff != null && Math.abs(r.costDiff) >= 0.005) parts.push(`your cost is ${money(Math.abs(r.costDiff))} ${r.costDiff > 0 ? 'above' : 'below'} the calculator's`);
    const gap = r.gap != null ? gapbox(`Gap of ${money(r.gap)} per unit: ${parts.join(', ')}.`) : r.price == null ? gapbox('No current price captured for this quality, so no calculator figure.') : r.calcResult && !r.calcResult.ok ? gapbox(esc(r.calcResult.error || r.calcResult.reason || 'Calculator not available.')) : r.calcResult && !r.calcResult.complete ? gapbox(`Calculator needs a price for ${esc((r.calcResult.missing || []).map(nameOf).join(', '))}.`) : '';
    const body = [
      row(`Sold for (avg of ${r.n} sale${r.n === 1 ? '' : 's'})`, money(r.avg)),
      row(`− Cost per unit (${r.costSource === 'ledger' ? 'game cost at sale' : 'inputs + labour'})`, money(r.cost)),
      row(`− Exchange fee ${feeLbl(m)}`, money(r.feePU)), hr,
      row('Earned per unit', money(r.earned), `an-total ${r.earned != null && r.earned < 0 ? 'an-bad' : ''}`),
      row(`Calculator today (price ${money(r.price)}, no fee)`, money(r.calc), r.calc != null && r.calc < 0 ? 'an-bad' : ''),
      row(`Total earned (${units(r.units)} units)`, money(r.total, 0)),
      r.ledgerCost != null && r.costSource === 'warehouse' ? row('Game cost at sale (check)', money(r.ledgerCost)) : '',
      gap
    ].join('');
    return pcard(`mg-${r.key}`, `${plink(r.rid, r.q)}${badge}`, body);
  }
  function pageMargins(m) {
    const u = m.margins.reduce((a, r) => a + r.units, 0), rev = m.margins.reduce((a, r) => a + r.gross, 0);
    const sum = `<div class="an-card an-sumrow"><div><small>Earned from exchange sales · ${S.days} days</small><b>${money(m.earned, 0)}</b></div><div class="an-sumright"><button type="button" class="an-link" data-an-go="sales">${units(u)} units sold ›</button><small>${money(rev, 0)} revenue</small></div></div>`;
    const cards = m.margins.map(r => marginCard(r, m)).join('') || dash(`No exchange sales in the captured ledger for the last ${S.days} days.`);
    return `${mainHead('What each product earns')}${sum}${intro('Each card shows how a product\'s sale price turns into profit, then compares it with the game\'s calculator. Sorted by biggest gap.')}${cards}${dash(`Coverage ${pct(m.coverage.coverage, 0)}: ${m.coverage.coverage < 1 ? 'some ledger pages are missing, so this uses only the sales the ledger shows. ' : ''}Cost per unit is the current warehouse lot cost, not the cost at the time of each sale. ${quality()}`)}`;
  }
  function stockCard(r, m) {
    const tip = r.price == null ? gapbox('No current price captured for this quality.') : r.headroom != null ? gapbox(r.headroom >= 0 ? `Price can fall ${pct(r.headroom)} before this lot loses money.` : `Price must rise ${pct(r.breakEven / r.price - 1)} to break even.`, r.headroom >= 0 ? 'an-good' : 'an-bad') : '';
    const body = [row('Units in warehouse', units(r.units)), row('Cost per unit', money(r.unitCost)), row('Exchange price now', money(r.price)), row('Break-even price (with fee)', money(r.breakEven)), row('Total cost → value today', `${money(r.cost, 0)} → ${money(r.value, 0)}`), row('Oldest lot', age(r.oldest)), tip].join('');
    return pcard(`st-${r.key}`, `${plink(r.rid, r.q)}<b class="an-pc-val ${tone(r.diff)}">${sbig(r.diff)}</b>`, body, { cls: r.diff == null ? '' : r.diff < 0 ? 'an-edge-bad' : 'an-edge-good' });
  }
  function pageStock(m) {
    const st = m.stock;
    const top = `<div class="an-stats3"><div><span>Value today</span><b>${big(st.value)}</b></div><div><span>What it cost</span><b>${big(st.cost)}</b></div><div><span>Difference</span><b class="${tone(st.diff)}">${sbig(st.diff)}</b></div></div>`;
    const alert = st.below.length ? `<div class="an-alert">${st.below.length} of ${st.rows.length} lots ${st.below.length === 1 ? 'is' : 'are'} priced below cost: ${st.below.slice(0, 3).map(r => `${label(r.rid, r.q)}, ${big(r.diff)}`).join('; ')}.</div>` : '';
    return `${mainHead('Warehouse stock')}${top}${alert}${intro(`Value today = units × exchange price at your quality. Cost = what your warehouse lot recorded (inputs + labour). Break-even adds the ${feeLbl(m)} fee: cost ÷ (1 − fee).`)}${st.rows.map(r => stockCard(r, m)).join('') || dash('No warehouse lots captured yet.')}${dash(`Lot age comes from the date on each warehouse lot.${st.unpriced.length ? ` ${st.unpriced.length} product(s) have no current price and are left out of the totals.` : ''} ${quality()}`)}`;
  }
  function costCard(r) {
    const sp = r.split;
    const head = `<span class="an-cost-name">${plink(r.rid, r.q, esc(nameOf(r.rid)))}<small>${money(r.first)} → ${money(r.last)}</small></span><span class="an-mini">${A.sparkline(r.pts, { tone: 'up-bad', label: `${nameOf(r.rid)} cost per unit` })}</span><b class="an-pc-chg ${tone(r.change, false)}">${r.change == null ? '—' : spct(r.change)}</b>`;
    const body = sp ? `${row('Inputs (lot now)', money(sp.inputsPerUnit))}${row('Labour (lot now)', money(sp.labourPerUnit))}${sp.boughtPerUnit > 0 ? row('Bought on the market', money(sp.boughtPerUnit)) : ''}` : small('No warehouse lot of this quality, so no inputs / labour split.');
    return pcard(`co-${r.key}`, head, body);
  }
  function routeBlock(r, m) {
    return `<div class="an-rt"><div class="an-rt-h"><span>${label(r.rid, r.q)}</span><b class="${tone(r.diff)}">${smoney(r.diff)} (${spct(r.diffPct)})</b></div>${row(`Exchange (${money(r.price)} less ${feeLbl(m)})`, money(r.exNet))}${row('Contract (your average paid)', money(r.contractAvg))}</div>`;
  }
  function pageCosts(m) {
    const cards = m.costRows.map(costCard).join('') || dash(`No production runs captured in the last ${S.days} days.`);
    const f = m.fees;
    const fees = sec('co-fees', `Exchange fees · ${S.days} days`, `${row('Sold on the exchange', money(f.gross, 0))}${row('Fee rate (from your ledger)', pct(m.rate, 2))}${hr}${row('Fees paid', money(f.paid, 0), 'an-total')}${small(`${m.earned > 0 ? `That is ${pct(f.paid / m.earned, 0)} of the ${money(m.earned, 0)} you earned. ` : ''}${link('fees', 'See fee breakdown')}`)}`);
    const rr = m.routes.filter(r => r.contracts.length).slice(0, 3);
    const routes = sec('co-routes', 'Contract vs exchange · net per unit', `${rr.map(r => routeBlock(r, m)).join(hr) || small(`No paid contracts in the last ${S.days} days.`)}${small(`Contract transport is not included in these figures. ${link('routes', 'All routes')}`)}`);
    return `${mainHead('Costs, fees and routes')}<div class="an-h2 an-h2-static">Cost per unit · last ${S.days} days</div>${intro('From your production history. Split into inputs (materials) and labour (wages + admin) from your warehouse lot.')}${cards}${fees}${routes}`;
  }
  function pageCompany(m) {
    const c = m.company; if (!c) return `${detailHead('Company value and EVA')}${dash('Past finances not captured yet. Open Accounting in the game, then Sync.')}`;
    const pts = cut(c.pts, Number(S.range));
    const hero = `<div class="an-card"><small class="an-lbl">Company value</small><div class="an-big">${big(c.value)}</div><div class="an-sub ${tone(c.change7)}">${c.weekAgo != null ? `${sbig(c.value - c.weekAgo)} (${spct(c.change7)}) in 7 days · was ${big(c.weekAgo)}` : ''}</div>${rangePills()}<div class="an-chart-lg">${A.sparkline(pts, { label: 'Company value' })}</div>${legend('Value')}${stats(pts, big, rangeLbl())}</div>`;
    const total = c.parts.reduce((a, p) => a + p.value, 0) || 1, colors = ['#46c2ad', '#6aa9e8', '#e8b04a', '#b58be8', '#f07167', '#8d98a8'];
    const own = sec('cp-own', 'What the company owns', `<div class="an-bar" aria-hidden="true">${c.parts.map((p, i) => `<i style="width:${(p.value / total * 100).toFixed(2)}%;background:${colors[i % 6]}"></i>`).join('')}</div>${c.parts.map((p, i) => row(`<i class="an-sq" style="color:${colors[i % 6]}">■</i> ${esc(p.label)}`, `${big(p.value)} · ${pct(p.value / total)}`, 'an-row-txt')).join('')}${hr}${row('Total assets', big(c.assets), 'an-total14')}${row('− Liabilities', big(c.liabilities))}${row('Company value', big(c.net), 'an-total')}`);
    const wk = c.weeks;
    const eva = sec('cp-eva', 'EVA by week', wk.length ? `${wk.length > 1 ? A.sparkline(wk.map(x => [x.end, x.v]), { label: 'EVA by week' }) : A.sparkline(c.eva.map(r => [r.t, r.v]), { label: 'EVA by day' })}<div class="an-cols">${(wk.length > 1 ? wk : c.eva.slice(-7).map(r => ({ v: r.v, t: r.t }))).map((x, i, a) => `<span class="${i === a.length - 1 ? 'an-now' : ''}">${short(x.v)}</span>`).join('')}</div><div class="an-cols an-cols-lbl">${(wk.length > 1 ? wk.map((x, i) => (i === wk.length - 1 ? 'this' : i === wk.length - 2 ? 'last' : `${wk.length - 1 - i} wk`)) : c.eva.slice(-7).map(r => new Date(r.t).toLocaleDateString(undefined, { weekday: 'short' }))).map(x => `<span>${x}</span>`).join('')}</div>${small(`EVA is the operating profit left after a charge for the capital the company uses.${wk.length > 1 ? ` ${wk[wk.length - 1].v >= wk[wk.length - 2].v ? 'Up' : 'Down'} ${big(Math.abs(wk[wk.length - 1].v - wk[wk.length - 2].v))} on last week.` : ` Daily values: one week captured so far (${wk[0].days} days, ${sbig(wk[0].v)}).`}`)}` : small('No EVA rows captured yet.'));
    return `${detailHead('Company value and EVA')}${hero}${own}${eva}${dash('Source: the game\'s past-finances and balance-sheet captures. Asset names follow the game\'s own balance sheet.')}`;
  }
  function pageFees(m) {
    const f = m.fees, fd = m.feeDays.slice(-7);
    const hero = `<div class="an-card"><small class="an-lbl">Fees paid · ${S.days} days</small><div class="an-big">${money(f.paid)}</div><div class="an-sub an-muted">${pct(m.rate, 2)} of ${money(f.gross, 0)} sold${m.earned > 0 ? ` · ${pct(f.paid / m.earned, 0)} of what you earned` : ''}</div></div>`;
    const days = sec('fe-days', 'Fees by day', fd.length ? `${A.sparkline(fd.map(d => [d.t, d.fee]), { tone: 'up-bad', label: 'Fees by day' })}<div class="an-cols">${fd.map(d => `<span>${short(d.fee)}</span>`).join('')}</div><div class="an-cols an-cols-lbl">${fd.map(d => `<span>${new Date(d.t).toLocaleDateString(undefined, { weekday: 'short' })}</span>`).join('')}</div>` : small('No day income statements captured yet.'));
    const prods = sec('fe-prod', 'Fees by product', f.products.map(p => `<button type="button" class="an-barrow" data-an-prod="${p.key}"><span class="an-row"><span>${label(p.rid, p.q)} ›</span><b>${money(p.fee)}</b></span><span class="an-prog"><i style="width:${((p.share || 0) * 100).toFixed(1)}%"></i></span><small>${units(p.units)} units × ${money(p.perUnit)} · ${pct(p.share)} of fees</small></button>`).join('') || small('No paired fee rows in the window.'));
    const how = `<div class="an-card"><div class="an-card-t">Where the rate comes from</div>${small(`Fee paid ÷ sale value on matching ledger pairs (fees-… against marketfilled-…). Your ledger shows ${pct(m.rate, 2)}${m.fr ? ` over ${m.fr.pairs} sales of $1,000 or more` : ''}.`)}</div>`;
    return `${detailHead('Exchange fees')}${hero}${days}${prods}${how}${dash(`Daily figures come from the game's day income statements, so missing ledger pages do not change them. Fees by product use the ledger pages captured.${f.unpaired ? ` ${f.unpaired} sale(s) had no matching fee row.` : ''} ${quality()}`)}`;
  }
  function pageCash(m) {
    const c = m.cash; if (!c || c.value == null) return `${detailHead('Cash')}${dash('Past finances or balance sheet not captured yet.')}`;
    const pts = cut(c.pts, Number(S.range)), share = c.share.slice(-5);
    const hero = `<div class="an-card"><small class="an-lbl">Cash and receivables</small><div class="an-big">${big(c.value)}</div><div class="an-sub an-warn">${pct(c.shareNow, 0)} of ${big(c.total)} total assets</div><div class="an-share" aria-hidden="true"><i style="width:${((c.shareNow || 0) * 100).toFixed(1)}%"></i></div></div>`;
    const chart = sec('ca-chart', `Cash · ${Number(S.range) ? `${S.range} days` : 'all'}`, `${rangePills()}<div class="an-chart-lg">${A.sparkline(pts, { label: 'Cash' })}</div>${legend('Cash')}${stats(pts, big, rangeLbl())}`);
    const br = sec('ca-br', 'Breakdown', `${row('Available cash', big(c.cashOnHand))}${row('Reserved for open buy orders', big(c.reserved))}${row('Accounts receivable', big(c.receivable))}${hr}${row('Cash and receivables', big(c.value), 'an-total14')}`);
    const last = sec('ca-last', 'How long it lasts', `${row(`Cash paid out per day (${c.payoutDays}-day avg)`, big(c.payoutPerDay))}${row('Covers', c.covers != null ? `${c.covers.toFixed(1)} days` : '—', 'an-total')}${small('Cash and receivables ÷ cash paid out per day. This is the game\'s "defensive interval" ratio.')}`);
    const sh = sec('ca-share', `Share of assets, last ${share.length} days`, `${A.sparkline(share, { tone: 'flat', label: 'Cash share of assets' })}<div class="an-cols">${share.map((p, i) => `<span class="${i === share.length - 1 ? 'an-now' : ''}">${pct(p[1])}</span>`).join('')}</div>`);
    return `${detailHead('Cash')}${hero}${chart}${br}${last}${sh}${dash('This page only reports. It does not say what to do with the cash.')}`;
  }
  function saleCard(s, m) {
    const cost = A.warehouseCost(m.lots, s.rid, s.q)?.unitCost ?? s.ledgerCost, fee = s.fee != null ? s.fee : (m.rate != null && s.channel === 'exchange' ? s.gross * m.rate : 0);
    const earned = cost != null ? s.gross - fee - cost * s.amount : null;
    return `<div class="an-card an-sale"><div class="an-sale-h"><button type="button" class="an-plink an-plink-sm" data-an-prod="${A.keyOf(s.rid, s.q)}">${label(s.rid, s.q)}</button><small>${when(s.t)}${s.channel === 'contract' ? ' · contract' : ''}</small></div>${row(`${units(s.amount)} × ${money(s.price)}`, money(s.gross))}${s.channel === 'exchange' ? row(`Fee ${feeLbl(m)}`, money(-fee)) : row('Contract fee / transport', '<span class="an-warn">to verify</span>')}${row(`Cost ${units(s.amount)} × ${money(cost)}`, money(cost != null ? -cost * s.amount : null))}${row('Earned', smoney(earned), `an-total14 ${tone(earned)}`)}</div>`;
  }
  function pageSales(m) {
    const prods = [...new Map(m.sales.map(s => [A.keyOf(s.rid, s.q), s])).values()];
    const list = S.salesKey === 'all' ? m.sales : m.sales.filter(s => A.keyOf(s.rid, s.q) === S.salesKey);
    const chips = `<div class="an-chips">${[['all', 'All'], ...prods.map(s => [A.keyOf(s.rid, s.q), nameOf(s.rid)])].map(([k, l]) => `<button type="button" data-an-filter="${k}" aria-pressed="${S.salesKey === k}">${esc(l)}</button>`).join('')}</div>`;
    const earned = S.salesKey === 'all' ? m.earned : m.margins.find(r => r.key === S.salesKey)?.total;
    const sum = `<div class="an-card an-sumbar"><span>${units(list.reduce((a, s) => a + s.amount, 0))} units · ${money(list.reduce((a, s) => a + s.gross, 0), 0)}</span><b>Earned ${money(earned, 0)}</b></div>`;
    const more = list.length > S.salesShow ? `<button type="button" class="an-wide" data-an-more><span>Show more</span><b>${S.salesShow} of ${list.length} sales ›</b></button>` : '';
    return `${detailHead('All sales')}${chips}${daySeg()}${sum}${list.slice(0, S.salesShow).map(s => saleCard(s, m)).join('') || dash('No sales in the captured ledger for this window.')}${more}${dash(`Sales come from the cash-flow ledger. Cost uses the current warehouse lot cost. Ledger pages that were never captured are missing here. ${quality()}`)}`;
  }
  function routeCard(r, m) {
    if (!r.contracts.length) return `<div class="an-card an-dash">${plink(r.rid, r.q)}${small(`No contracts in the last ${S.days} days. Exchange net would be ${money(r.exNet)} per unit at today's price.`)}</div>`;
    return pcard(`rt-${r.key}`, `${plink(r.rid, r.q)}<b class="an-pc-val ${tone(r.diff)}">${spct(r.diffPct)}</b>`, `${row(`Exchange (${money(r.price)} less ${feeLbl(m)})`, money(r.exNet))}${row('Contract average', money(r.contractAvg))}${hr}<small class="an-lbl">Last contracts</small>${r.contracts.slice(0, 4).map(c => row(`${when(c.t)} · ${units(c.amount)} × ${money(c.price)}${c.buyer ? ` · ${esc(c.buyer)}` : ''}`, money(c.gross), 'an-row-txt')).join('')}`);
  }
  function pageRoutes(m) {
    return `${detailHead('Contract vs exchange', 'costs')}${intro(`Net per unit if you sell by contract or on the exchange, using your own paid contracts from the last ${S.days} days. Products with no contracts show an empty card.`)}${m.routes.map(r => routeCard(r, m)).join('') || dash('No sales in the captured ledger for this window.')}${dash(`Not included: contract transport. Whether contracts carry a fee is still to verify in your ledger. ${quality()}`)}`;
  }
  function pageProduct(m) {
    const [rid, q] = String(S.prod || '').split(':').map(Number);
    if (!(rid > 0)) { S.page = 'overview'; return pageOverview(m); }
    const key = A.keyOf(rid, q), p = m.priceOf(rid, q), price = p?.price ?? null, ser = priceSeries(rid, q);
    const wk = ser.pts.length ? ser.pts.filter(x => x[0] <= ser.pts[ser.pts.length - 1][0] - 7 * DAY).pop() : null;
    const mg = m.margins.find(r => r.key === key);
    const st = m.stock.rows.find(r => r.key === key) || (() => { const w = A.warehouseCost(m.lots, rid, q); if (!w) return null; const be = A.breakEven(w.unitCost, m.rate); return { units: w.amount, unitCost: w.unitCost, cost: w.cost, price, value: price != null ? price * w.amount : null, diff: price != null ? price * w.amount - w.cost : null, breakEven: be, headroom: A.headroom(price, be), oldest: w.oldest }; })();
    const calc = price != null ? m.calcOf(rid, q, price) : null, cs = A.costSeries(m.pch, rid, q, S.days, m.now), split = A.costSplit(m.lots, rid, q);
    const route = m.routes.find(r => r.key === key), sales = m.sales.filter(s => s.rid === rid && s.q === q);
    const k = mg?.pctOfCalc == null ? null : mg.pctOfCalc < 0.75 ? 'bad' : mg.pctOfCalc < 0.95 ? 'warn' : 'good';
    const priceCard = `<div class="an-card"><small class="an-lbl">Exchange price now</small><div class="an-pricerow"><div><div class="an-big an-big28">${money(price)}</div><div class="an-sub ${wk && price ? tone(price - wk[1]) : 'an-muted'}">${wk && price ? `${spct((price - wk[1]) / wk[1])} vs ${money(wk[1])} a week ago` : esc(p?.source || 'no current price captured')}</div></div><span class="an-mini">${A.sparkline(ser.pts.slice(-60), { label: `${nameOf(rid)} price` })}</span></div>${small(`Trend: ${ser.src}.`)}</div>`;
    const per = sec('pd-per', 'Per unit sold', mg ? `${row(`Sold for (avg of ${mg.n} sales)`, money(mg.avg))}${row('− Cost per unit', money(mg.cost))}${row(`− Exchange fee ${feeLbl(m)}`, money(mg.feePU))}${hr}${row('Earned per unit', money(mg.earned), 'an-total')}${row('Calculator today (no fee)', money(mg.calc))}${mg.gap != null ? gapbox(`Gap ${money(mg.gap)}: sold ${money(Math.abs(mg.priceDiff))} ${mg.priceDiff >= 0 ? 'under' : 'above'} today's price, ${money(mg.feePU)} fee${mg.costDiff != null && Math.abs(mg.costDiff) >= 0.005 ? `, cost ${money(Math.abs(mg.costDiff))} ${mg.costDiff > 0 ? 'above' : 'below'} the calculator's` : ''}.`) : ''}` : small(`No exchange sales of this quality in the last ${S.days} days.`));
    const calcLines = calc && calc.ok ? `${calc.inputs.map(x => row(`${esc(nameOf(x.id))} × ${x.qty} @ ${money(x.unitCost)}`, x.unitCost == null ? 'no price' : money(x.qty * x.unitCost))).join('')}${row('Labour (wages + admin)', money(calc.labourPerUnit))}${hr}${row('Total per unit', money(calc.sourcingCostPerUnit), 'an-total14')}${calc.profitPerUnit != null ? row(`Calculator profit at ${money(price)}`, money(calc.profitPerUnit), tone(calc.profitPerUnit)) : ''}${calc.profitPerHourPerLevel != null ? row(`Profit / h / level (× ${calc.ratePerLevel.toFixed(3)})`, money(calc.profitPerHourPerLevel)) : ''}${small(`Game calculator basis: recipe from the game constants, input costs from your cheapest warehouse lot (as the game does), else the market. Lines are rounded to cents.${cs.first != null && cs.pts.length > 1 ? ` ${S.days} days ago: ${money(cs.first)} (${spct(cs.change)}).` : ''}`)}` : small(esc(calc?.error || calc?.reason || (price == null ? 'No current price for this quality, so no calculator figure.' : 'Calculator not available.')));
    const cost = sec('pd-cost', 'Cost per unit', calcLines);
    const lot = split ? sec('pd-lot', 'Your warehouse lot', `${split.inputs.map(x => row(esc(x.name), money(x.perUnit))).join('')}${row('Labour (wages + admin)', money(split.labourPerUnit))}${split.boughtPerUnit > 0 ? row('Bought on the market', money(split.boughtPerUnit)) : ''}${hr}${row('Lot cost per unit', money(split.totalPerUnit), 'an-total14')}`) : '';
    const wh = sec('pd-wh', 'In your warehouse', st ? `${row('Units', units(st.units))}${row('Total cost → value today', `${money(st.cost, 0)} → ${money(st.value, 0)}`)}${row('Break-even price (with fee)', money(st.breakEven))}${row('Oldest lot', age(st.oldest))}${row('Difference', sbig(st.diff), `an-total14 ${tone(st.diff)}`)}${st.headroom != null ? small(st.headroom >= 0 ? `Price can fall ${pct(st.headroom)} before this lot loses money.` : `Price must rise ${pct(st.breakEven / st.price - 1)} to break even.`, st.headroom >= 0 ? 'an-good' : 'an-bad') : ''}` : small('None of this quality in the warehouse.'), { cls: st?.diff == null ? '' : st.diff < 0 ? 'an-edge-bad' : 'an-edge-good' });
    const earnedOf = s => { const c = st?.unitCost ?? s.ledgerCost; const fee = s.fee != null ? s.fee : (m.rate != null && s.channel === 'exchange' ? s.gross * m.rate : 0); return c != null ? s.gross - fee - c * s.amount : null; };
    const rs = sec('pd-sales', 'Recent sales', `${sales.slice(0, 5).map(s => { const e = earnedOf(s); return row(`${when(s.t)} · ${units(s.amount)} × ${money(s.price)}`, smoney(e), `an-row-txt ${tone(e)}`); }).join('') || small(`No sales in the last ${S.days} days.`)}<button type="button" class="an-link" data-an-sales="${key}">All ${esc(nameOf(rid))} sales ›</button>`);
    const rt = route && route.contracts.length ? sec('pd-route', 'Contract vs exchange', `${row(`Exchange (${money(route.price)} less ${feeLbl(m)})`, money(route.exNet))}${row('Contract average', money(route.contractAvg))}${row('Difference', `${smoney(route.diff)} (${spct(route.diffPct)})`, `an-total14 ${tone(route.diff)}`)}${link('routes', 'All routes')}`) : `<div class="an-h2 an-h2-static">Contract vs exchange</div>${dash(`No outgoing contracts for this product in the last ${S.days} days, so there is nothing to compare. ${link('routes', 'All routes')}`)}`;
    return `${detailHead(label(rid, q), S.back, k ? pill(`${pct(mg.pctOfCalc, 0)} of calculator`, k) : '')}${priceCard}${per}${cost}${lot}${wh}${rs}${rt}`;
  }
  function sources(m) {
    const s = S.s || {}, ep = s.endpointData || {}, gc = s.gameConstants;
    const days = A.dayStatements(ep, 'income-statement').length, pf = A.pastFinances(ep).length, log = S.log?.series ? Object.keys(S.log.series).length : 0;
    const prods = new Set(m.lots.map(l => `${l.kind}:${l.quality}`)).size;
    return [
      ['Warehouse lots', `${prods} products · ${m.lots.length} lots${s.lastSync ? ` · sync ${when(Date.parse(s.lastSync))}` : ''}`, m.lots.length > 0, m.lots.length ? 'Complete' : 'Missing'],
      ['Cash-flow ledger', `${units(m.coverage.rows)} rows · ${m.coverage.spanDays.toFixed(1)} days${m.coverage.coverage < 1 ? ' · pages missing' : ''}`, m.coverage.coverage >= 1, `${pct(m.coverage.coverage, 0)} coverage`],
      ['Day income statements', days ? `Day 0 to ${days - 1} captured` : 'None captured', days >= 7, `${days} of 7`],
      ['Past finances', `${pf} daily rows`, pf > 1, pf ? 'Complete' : 'Missing'],
      ['Production cost history', `${units(m.pch.length)} runs`, m.pch.length > 0, m.pch.length ? 'Complete' : 'None yet'],
      ['Price log', `${log} products · VWAP and live prices`, log > 0, log ? 'Complete' : 'None yet'],
      ['Recipes and constants', gc ? 'Game constants' : 'Not loaded', !!gc, gc ? 'Complete' : 'Missing']
    ].map(([a, b, ok, c]) => `<div class="an-src"><div><div>${a}</div><small>${b}</small></div><b class="${ok ? 'an-good' : 'an-warn'}">${c}</b></div>`).join(hr);
  }
  const sw = (key, on, title, sub) => `<div class="an-swrow"><div><div>${title}</div><small>${sub}</small></div><button type="button" class="an-sw" role="switch" aria-checked="${on}" aria-label="${esc(title)}" data-an-switch="${key}"><i></i></button></div>`;
  function pageData(m) {
    const gaps = [
      ['Ledger pages missing.', m.coverage.coverage < 1 ? `The captured ledger reaches back ${m.coverage.spanDays.toFixed(1)} days. Per-product sales and fees read low for the days before; company totals use the day statements instead.` : 'None for this window.', m.coverage.coverage < 1],
      ['Cost at time of sale.', 'Earned figures use the current lot cost, not the cost when each unit was made. Margins shows the game\'s own cost at sale as a check.', true],
      ['Contracts.', 'Only your own contracts. Transport and any contract fee are not confirmed.', true],
      ['Cost split over time.', 'Production history keeps the total cost per run, so the inputs / labour split is today\'s lot.', true]
    ].map(([a, b, warn]) => `<div class="an-gapitem"><i class="an-dot ${warn ? 'an-dot-warn' : 'an-dot-good'}"></i><div><b>${a}</b> <span>${esc(b)}</span></div></div>`).join('');
    const set = `${sw('auto', S.auto, 'Compute when the tab opens', 'No background work')}${hr}${sw('keep', S.keep, 'Keep the last result for 10 minutes', 'Opens instantly on revisit')}${hr}${sw('min', S.minUnits > 0, 'Ignore lots under 5 units', 'Hides tiny leftovers on Stock')}${hr}<div class="an-setblk"><div>Look-back window</div>${daySeg()}</div>`;
    return `${detailHead('Data and settings')}${sec('dt-src', 'What Analyze reads', sources(m))}${sec('dt-gaps', 'Known gaps', gaps)}${sec('dt-set', 'Settings', set)}<button type="button" class="an-btn" data-an-recalc>Recalculate now</button><p class="an-center">Last calculated ${when(S.at)} · took ${S.took < 1000 ? `${S.took.toFixed(0)} ms` : `${(S.took / 1000).toFixed(1)} s`} · 0 network calls</p><button type="button" class="an-link an-link-c" data-an-go="empty">Preview the first-run screen ›</button>`;
  }
  function pageEmpty(m) {
    const ledgerDays = m.coverage.spanDays, items = [
      [m.lots.length > 0, false, 'Warehouse captured', 'Unlocks Stock', 'stock', 'Stock'],
      [A.pastFinances(S.s?.endpointData).length > 0, false, 'Past finances captured', 'Unlocks Company value and Cash', 'company', 'Company value and EVA'],
      [ledgerDays >= 3, m.coverage.rows > 0, `Cash-flow ledger: ${m.coverage.rows ? `${ledgerDays.toFixed(1)} days so far` : 'none yet'}`, 'Needs 3 or more days for Margins, Sales and Fees', 'margins', 'Margins'],
      [m.pch.length > 1, m.pch.length > 0, `Production cost history: ${m.pch.length ? `${m.pch.length} run${m.pch.length === 1 ? '' : 's'}` : 'none yet'}`, 'Needs 2 runs for the cost trend on Costs', 'costs', 'Costs']
    ], ready = items.filter(x => x[0]);
    const preview = S.page === 'empty';
    const head = `${preview ? `<div class="an-top"><button type="button" class="an-back" data-an-back="data">‹ Data and settings</button></div>` : ''}<div><div class="an-eyebrow">Analyze</div><div class="an-h1">Not enough data yet</div></div>`;
    const list = items.map(([ok, part, a, b]) => `<div class="an-check"><i class="${ok ? 'an-ck-ok' : part ? 'an-ck-part' : 'an-ck-no'}" aria-hidden="true">${ok ? '✓' : ''}</i><div><div>${esc(a)}</div><small>${esc(b)}</small></div></div>`).join('');
    const card = `<div class="an-card">${row('Ready', `${ready.length} of ${items.length}`)}<div class="an-share an-share-teal" aria-hidden="true"><i style="width:${ready.length / items.length * 100}%"></i></div>${list}</div>`;
    const avail = ready.length ? `<div class="an-card"><div class="an-card-t">Available now</div>${ready.map(x => `<button type="button" class="an-navrow" data-an-go="${x[4]}"><span>${x[5]}</span><i>›</i></button>`).join(hr)}</div>` : '';
    return `${head}${intro('Analyze works from what the manager has already captured. It needs a little more before the reports make sense.')}${card}<button type="button" class="an-btn" data-an-sync>Run Sync now</button>${avail}`;
  }
  const isEmpty = m => !m.lots.length && !m.company && !m.sales.length;

  /* ------------------------------------------------------------ shell */
  function shell() {
    const root = $('#analyzeBody'); if (!root) return null;
    if (!root.dataset.ready) {
      root.dataset.ready = '1';
      root.addEventListener('click', onClick);
      root.addEventListener('toggle', e => { const d = e.target; if (!d?.matches?.('[data-an-card]')) return; const id = d.dataset.anCard; if (d.open) S.closed.delete(id); else S.closed.add(id); store.set('closed', [...S.closed].slice(-200)); }, true);
      document.querySelectorAll('nav .tab').forEach(b => b.addEventListener('click', () => { if (b.dataset.tab !== 'analyze') S.left = true; }));
    }
    return root;
  }
  function go(page) { if (page !== 'product' && page !== 'empty') { S.back = page; store.set('page', page); } S.page = page; S.salesShow = 20; paint(true); $('#analyze')?.scrollIntoView?.({ block: 'start' }); }
  function onClick(e) {
    const t = e.target.closest('button'); if (!t) return;
    const d = t.dataset;
    if (t.closest('summary') && (d.anProd || d.anGo)) e.preventDefault(); // a link in a card header opens the page, it does not fold the card
    if (d.anGo) return go(d.anGo);
    if (d.anProd) { if (S.page !== 'product') S.back = S.page; S.prod = d.anProd; S.page = 'product'; paint(true); $('#analyze')?.scrollIntoView?.({ block: 'start' }); return; }
    if ('anBack' in d) { const to = d.anBack || S.back; S.page = to && to !== 'product' && to !== 'empty' ? to : 'overview'; return paint(true); }
    if (d.anDays) { S.days = Number(d.anDays); store.set('days', S.days); return paint(true); }
    if ('anRange' in d) { S.range = Number(d.anRange); store.set('range', S.range); return paint(true); }
    if (d.anFilter) { S.salesKey = d.anFilter; S.salesShow = 20; return paint(true); }
    if (d.anSales) { S.salesKey = d.anSales; return go('sales'); }
    if (d.anSwitch) {
      if (d.anSwitch === 'auto') { S.auto = !S.auto; store.set('auto', S.auto); }
      if (d.anSwitch === 'keep') { S.keep = !S.keep; store.set('keep', S.keep); }
      if (d.anSwitch === 'min') { S.minUnits = S.minUnits ? 0 : 5; store.set('minUnits', S.minUnits); }
      return paint(true);
    }
    if ('anMore' in d) { S.salesShow += 20; return paint(true); }
    if ('anRecalc' in d) { compute(true); return paint(true); }
    if ('anSync' in d) { $('#sync')?.click(); return; }
  }
  let lastSig = '';
  function paint(force, revisit = false) {
    const root = shell(); if (!root || !S.s || !A) return;
    const m = compute(false, revisit);
    const sig = [S.page, S.prod, S.days, S.minUnits, S.range, S.salesKey, S.salesShow, S.auto, S.keep, S.modelSig, S.at, S.logRealm, S.log?.updatedAt].join('|');
    if (!force && sig === lastSig) return;
    lastSig = sig;
    const page = S.page === 'empty' || (isEmpty(m) && S.page !== 'data') ? 'empty' : S.page;
    const fn = { overview: pageOverview, margins: pageMargins, stock: pageStock, costs: pageCosts, company: pageCompany, fees: pageFees, cash: pageCash, sales: pageSales, routes: pageRoutes, product: pageProduct, data: pageData, empty: pageEmpty }[page] || pageOverview;
    let html = '';
    try { html = fn(m); } catch (err) { console.error('Analyze page failed', err); html = `${mainHead('Analyze')}<div class="an-alert">This page could not be built: ${esc(err?.message || err)}</div>`; }
    root.innerHTML = `${html}<p class="an-center">Computed on open from stored data · 0 network calls · updated ${new Date(S.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</p>`;
  }
  function render(s, ctx) {
    S.s = s; S.ctx = ctx || {};
    const revisit = !!S.left; S.left = false;
    loadLog(S.ctx.realm);
    paint(false, revisit);
  }
  globalThis.SCM_ANALYZE_UI = { render, _state: S, _go: go };
})();
