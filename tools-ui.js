/* Sim Companies Manager — Tools tab UI (price movers, price history, profit/h/level, ROI, loan, allocation).
 * Pure presentation: all maths lives in tools-core.js. Rendered from dashboard.js render() while the Tools tab is active. */
(function () {
  'use strict';
  const C = globalThis.SCM_TOOLS_CORE;
  const $ = s => document.querySelector(s);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (v, d = 2) => Number.isFinite(Number(v)) ? (Number(v) < 0 ? '-$' : '$') + Math.abs(Number(v)).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
  const pct = (v, d = 2) => Number.isFinite(Number(v)) ? `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(d)}%` : '—';
  const cls = v => (Number.isFinite(Number(v)) ? (v > 0.0001 ? 'tl-up' : v < -0.0001 ? 'tl-down' : 'tl-flat') : 'tl-flat');
  const hrs = h => !Number.isFinite(h) ? '—' : h >= 48 ? `${(h / 24).toFixed(1)} days` : `${h.toFixed(1)} h`;
  const store = { get(k, d) { try { const v = localStorage.getItem('scmTools:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem('scmTools:' + k, JSON.stringify(v)); } catch { /* ignore */ } } };

  const S = { sub: ['movers','history','roi','loan','alloc'].includes(store.get('sub', 'movers')) ? store.get('sub', 'movers') : 'movers', realm: null, log: null, logAt: 0, logLoading: false, data: null, dataPromise: null, state: null, names: new Map(), historyId: store.get('historyId', null), historyKey: store.get('historyKey', null), range: store.get('range', '1M'), hist: new Map(), histLoading: new Set() };

  function loadStaticData() {
    if (S.data) return Promise.resolve(S.data);
    if (!S.dataPromise) {
      const get = f => fetch(chrome.runtime.getURL(f)).then(r => r.json()).catch(() => null);
      S.dataPromise = Promise.all([get('recipes.json'), get('production_rates_normal.json')]).then(([recipes, rates]) => { S.data = { recipes: recipes || [], rates: rates || {} }; return S.data; });
    }
    return S.dataPromise;
  }
  function realmOf(s) {
    for (const c of [s?.viewRealm, s?.selectedRealm, String(s?.activeRealmKey || '').replace('realm:', '') || null, s?.authData?.authCompany?.realmId]) {
      if (c === null || c === undefined || c === '') continue;
      const n = Number(c); if (n === 0 || n === 1) return n;
    }
    return null;
  }
  function loadLog(realm, force) {
    if (realm == null || S.logLoading) return;
    if (!force && S.realm === realm && S.log && Date.now() - S.logAt < 15000) return;
    S.logLoading = true;
    chrome.storage.local.get({ ['scmPriceLog:' + realm]: null }).then(r => {
      S.log = r['scmPriceLog:' + realm]; S.realm = realm; S.logAt = Date.now();
    }).catch(() => { S.log = null; }).finally(() => { S.logLoading = false; if (S.state && isActive()) paint(); });
  }
  const isActive = () => $('#tools')?.classList.contains('active');
  function priceMap(s) {
    const m = new Map();
    const v = s?.vwapData;
    for (const r of Array.isArray(v?.rows) ? v.rows : []) { const val = Number(r?.value); if (val > 0) m.set(`${Number(r.resourceId)}:${Number(r.quality)}`, val); }
    return m;
  }
  const nameOf = id => S.names.get(String(id))?.name || (S.data?.recipes || []).find(r => Number(r.id) === Number(id))?.name || `Resource #${id}`;

  /* ------------------------------------------------------------ shell */
  const TABS = [['movers', 'Price movers'], ['history', 'Price history'], ['roi', 'Building ROI'], ['loan', 'Loan & bond'], ['alloc', 'Capital allocation']];
  function shell() {
    const root = $('#toolsBody'); if (!root) return null;
    if (!root.dataset.ready) {
      root.dataset.ready = '1';
      root.innerHTML = `<div class="tl-tabs" role="tablist">${TABS.map(([k, l]) => `<button type="button" class="tl-tab" data-tl="${k}">${l}</button>`).join('')}</div><div id="tlPane"></div>`;
      root.addEventListener('click', e => {
        const b = e.target.closest('[data-tl]'); if (b) { S.sub = b.dataset.tl; store.set('sub', S.sub); paint(true); return; }
        const r = e.target.closest('[data-range]'); if (r) { S.range = r.dataset.range; store.set('range', S.range); paint(true); return; }
        const h = e.target.closest('[data-hist]'); if (h) { e.preventDefault(); const k = String(h.dataset.hist); if (k.includes(':')) { S.historyKey = k; store.set('historyKey', k); } else { S.historyId = Number(k); store.set('historyId', S.historyId); } S.sub = 'history'; store.set('sub', 'history'); paint(true); return; }
        if (e.target.closest('#tlRefreshPrices')) { const b = e.target.closest('#tlRefreshPrices'); b.disabled = true; b.textContent = 'Refreshing… this takes 2–3 minutes'; chrome.runtime.sendMessage({ type: 'LIVE_MARKET_REFRESH', realm: realmOf(S.state) }).catch(() => {}); return; }
        if (e.target.closest('#tlHistReload')) { const k = S.historyKey; if (k) { S.hist.delete(k); requestHistory(k, true); } return; }
        if (e.target.closest('#tlCsv')) exportCsv();
        if (e.target.closest('#tlAddOpt')) { const o = store.get('allocOpts', []); o.push({ name: '', cost: '', profit: '', lead: '' }); store.set('allocOpts', o); paint(true); }
        const del = e.target.closest('[data-del-opt]'); if (del) { const o = store.get('allocOpts', []); o.splice(Number(del.dataset.delOpt), 1); store.set('allocOpts', o); paint(true); }
      });
      root.addEventListener('input', e => { if (e.target.closest('[data-calc]')) calcInput(e.target); });
      root.addEventListener('change', e => { if (e.target.closest('[data-calc]')) calcInput(e.target); });
    }
    root.querySelectorAll('.tl-tab').forEach(b => b.classList.toggle('active', b.dataset.tl === S.sub));
    return $('#tlPane');
  }

  /* ----------------------------------------------------- price series */
  function allSeries() {
    const out = new Map();
    const ids = new Set(Object.keys(S.log?.series || {}).map(Number));
    for (const k of Object.keys(S.state?.history || {})) ids.add(Number(k.split(':')[0]));
    for (const id of ids) { if (!(id > 0)) continue; const s = C.seriesForResource(id, S.log?.series?.[id], S.state?.history); if (s.length) out.set(id, s); }
    return out;
  }
  const collecting = () => {
    const first = Math.min(...Object.values(S.log?.series || {}).map(a => a?.[0]?.[0]).filter(Number.isFinite));
    return Number.isFinite(first) ? `Collecting since ${new Date(first).toLocaleString()} · ${Object.keys(S.log.series).length} products` : 'No snapshots recorded yet — the first one is saved after the next VWAP sync.';
  };

  /* Price movers: SimcoTools trade closes for every product you make or hold (stored with the
   * hourly current-price refresh). The Manager's own hourly snapshots cover everything else. */
  const ago = t => { if (!Number.isFinite(t)) return '—'; const m = Math.max(0, (Date.now() - t) / 60000); return m < 60 ? `${Math.round(m)} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
  function trendRows() { const r = S.state?.liveMarketPriceData?.rows; return Array.isArray(r) ? r : []; }
  function paintMovers(pane) {
    const nm = new Map(trendRows().map(r => [String(r.resourceId), { name: nameOf(r.resourceId) }]));
    const { ranked, unranked } = C.moversFromTrend(trendRows(), nm);
    const chg = v => `<td class="${cls(v)}">${v == null ? '—' : (v > 0 ? '▲ ' : v < 0 ? '▼ ' : '■ ') + pct(v, 1)}</td>`;
    const updated = S.state?.liveMarketPriceData?.fetchedAt;
    const rows = ranked.concat(unranked);
    const head = `<p class="tl-note"><b>What this shows:</b> how the price of each product you make or keep in your warehouse has moved. <b>24h</b> = latest trade price compared with the price 24 hours earlier. <b>Day VWAP</b> = yesterday's average traded price compared with the day before. Source: SimcoTools trades, refreshed every hour${updated ? ` (last ${esc(ago(Date.parse(updated)))})` : ''}. Tap a product to see its chart.</p>`;
    const table = rows.length ? `<div class="table-wrap"><table class="tl-table mobile-cards"><thead><tr><th>Product</th><th>Price</th><th>1h</th><th>24h</th><th>3 days</th><th>Day VWAP</th><th>Last trade</th></tr></thead><tbody>${
      rows.map(r => `<tr><td><a href="#" data-hist="${r.id}:${r.quality}">${esc(r.name)}</a> <small>Q${r.quality}</small></td><td>${money(r.price, r.price < 10 ? 3 : 2)}</td>${chg(r.change['1h'])}${chg(r.change['24h'])}${chg(r.change['3d'])}${chg(r.dayVwapPct)}<td>${esc(ago(r.lastTradeAt))}</td></tr>`).join('')}</tbody></table></div>`
      : `<div class="tl-empty">No trend data stored yet. It arrives with the next hourly price refresh — or refresh now.<br><button type="button" id="tlRefreshPrices">Refresh prices now</button></div>`;
    // Manager's own hourly VWAP snapshots for all other products.
    const series = allSeries(), nm2 = new Map([...series.keys()].map(id => [String(id), { name: nameOf(id) }]));
    const own = C.moversTable(series, nm2);
    const ownHtml = own.ranked.length ? `<details class="tl-more"><summary>All products — Manager's hourly VWAP snapshots (${own.ranked.length})</summary><div class="table-wrap"><table class="tl-table mobile-cards"><thead><tr><th>Product</th><th>VWAP</th><th>24h</th><th>7d</th></tr></thead><tbody>${own.ranked.map(r => `<tr><td>${esc(r.name)}</td><td>${money(r.price, 3)}</td>${chg(r.change['24h'])}${chg(r.change['7d'])}</tr>`).join('')}</tbody></table></div></details>` : `<p class="tl-note">All-products movers (from the Manager's own hourly VWAP snapshots) start showing after 24 hours of collecting. ${esc(collecting())}</p>`;
    pane.innerHTML = head + table + ownHtml;
  }

  function chartSvg(series) {
    if (series.length < 2) return '<div class="tl-empty">Not enough points to chart yet.</div>';
    const W = 640, H = 220, P = 34, xs = series.map(p => p[0]), ys = series.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), yr = y1 - y0 || y1 || 1;
    const X = t => P + (t - x0) / ((x1 - x0) || 1) * (W - P - 8), Y = v => H - 22 - (v - y0) / yr * (H - 40);
    const d = series.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" class="tl-chart" role="img" aria-label="Price history"><path d="${d}" fill="none" stroke="var(--accent)" stroke-width="1.6"/><text x="4" y="${Y(y1) + 4}" class="tl-axis">${money(y1, 2)}</text><text x="4" y="${Y(y0) + 4}" class="tl-axis">${money(y0, 2)}</text><text x="${P}" y="${H - 6}" class="tl-axis">${new Date(x0).toLocaleDateString()}</text><text x="${W - 8}" y="${H - 6}" text-anchor="end" class="tl-axis">${new Date(x1).toLocaleDateString()}</text></svg>`;
  }
  /* Price history: daily candles + recent trades from SimcoTools for one product/quality. */
  function historyPairs() {
    const seen = new Map();
    for (const r of trendRows()) { const k = `${Number(r.resourceId)}:${Number(r.quality)}`; if (Number(r.resourceId) > 0) seen.set(k, { key: k, id: Number(r.resourceId), q: Number(r.quality) }); }
    for (const w of Array.isArray(S.state?.warehouseResources) ? S.state.warehouseResources : []) {
      const id = Number(w?.kind ?? w?.resourceId ?? w?.resource?.id), q = Number(w?.quality ?? 0);
      if (id > 0 && q >= 0) { const k = `${id}:${q}`; if (!seen.has(k)) seen.set(k, { key: k, id, q }); }
    }
    return [...seen.values()].sort((a, b) => nameOf(a.id).localeCompare(nameOf(b.id)) || a.q - b.q);
  }
  function requestHistory(key, force) {
    if (!key || S.histLoading.has(key) || (!force && S.hist.has(key))) return;
    const [id, q] = key.split(':').map(Number);
    S.histLoading.add(key);
    chrome.runtime.sendMessage({ type: 'PRICE_HISTORY', realm: realmOf(S.state), resourceId: id, quality: q, force: !!force })
      .then(r => { S.hist.set(key, r || { ok: false, error: 'No response' }); })
      .catch(e => { S.hist.set(key, { ok: false, error: e?.message || String(e) }); })
      .finally(() => { S.histLoading.delete(key); if (isActive() && S.sub === 'history') paint(true); });
  }
  function historySeries(h) {
    const daily = C.cleanSeries((h?.daily || []).map(x => [x[0], x[1]]));
    const recent = C.cleanSeries(h?.closes || []);
    if (!recent.length) return daily;
    const first = recent[0][0];
    return daily.filter(([t]) => t < first - 12 * C.HOUR).concat(recent);
  }
  function currentHistorySeries() { const h = S.hist.get(S.historyKey); return h?.ok ? historySeries(h) : []; }
  function paintHistory(pane) {
    const pairs = historyPairs();
    if (!S.historyKey || !pairs.some(p => p.key === S.historyKey)) S.historyKey = pairs[0]?.key || null;
    const key = S.historyKey, h = key ? S.hist.get(key) : null;
    if (key && !h) requestHistory(key, false);
    const full = currentHistorySeries(), series = C.sliceRange(full, S.range, Date.now()), st = C.rangeStats(series);
    const status = !key ? 'No products found. Run a Sync first.' : S.histLoading.has(key) ? 'Loading price history from SimcoTools…' : h && !h.ok ? `Could not load history: ${h.error}` : h ? `SimcoTools · ${h.daily?.length || 0} daily prices + ${h.closes?.length || 0} recent trades · fetched ${ago(Date.parse(h.fetchedAt))}${h.stale ? ' (offline copy)' : ''}` : '';
    pane.innerHTML = `<p class="tl-note"><b>What this shows:</b> the traded price of one product over time. Long ranges use one price per day (daily close); the last days use individual trades. Pick a range with the buttons.</p>
      <div class="tl-row"><label>Product <select id="tlProduct" data-calc="hist">${pairs.map(p => `<option value="${p.key}"${p.key === key ? ' selected' : ''}>${esc(nameOf(p.id))} · Q${p.q}</option>`).join('')}</select></label>
      <span class="tl-ranges">${['1D', '1W', '1M', '3M', '1Y', 'MAX'].map(r => `<button type="button" data-range="${r}" class="${r === S.range ? 'active' : ''}">${r}</button>`).join('')}</span>
      <button type="button" id="tlCsv">Export CSV</button> <button type="button" id="tlHistReload">Reload</button></div>
      <p class="tl-note">${esc(status)}</p>
      ${series.length ? chartSvg(series) : (h?.ok ? `<div class="tl-empty">No trades in this range — try a longer one.</div>` : '')}
      ${st ? `<div class="tl-stats"><div><span>Latest</span>${money(st.last, 3)}</div><div><span>Low</span>${money(st.low, 3)}</div><div><span>High</span>${money(st.high, 3)}</div><div><span>Average</span>${money(st.average, 3)}</div><div><span>Where the latest sits in the range</span>${st.positionPct == null ? '—' : st.positionPct.toFixed(0) + '%'}</div><div><span>Points</span>${st.count}</div></div>` : ''}`;
  }
  function exportCsv() {
    const s = C.sliceRange(currentHistorySeries(), S.range); if (!s.length) return;
    const url = URL.createObjectURL(new Blob([C.seriesToCsv(s)], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = `price-history-${String(S.historyKey || '').replace(':', '-Q')}-${S.range}.csv`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  const num = v => (v === '' || v == null ? NaN : Number(v));
  /* -------------------------------------------------- calculators */
  const field = (id, label, val, extra = '') => `<label>${label}<input id="${id}" data-calc="__KIND__" type="number" step="any" value="${esc(val)}" ${extra}></label>`;
  function paintRoi(pane) {
    const c = store.get('roi', { cost: 100000, profit: 50, lead: 0, days: 30 }), f = (id, l) => field(id, l, c[id.replace('roi_', '')]).replace('__KIND__', 'roi');
    pane.innerHTML = `<details class="tl-help" open><summary>How Building ROI works</summary>
      <p>Use it to decide if a <b>new building</b> or an <b>upgrade</b> is worth the money.</p>
      <ol><li><b>Up-front cost</b> — what the game charges to build or upgrade (shown on its construction screen).</li>
      <li><b>Extra profit per hour</b> — how much <em>more</em> you will earn per hour once it is finished. For an upgrade by one level, use the <b>Profit / h / level</b> number on that building's card in the Production tab.</li>
      <li><b>Build time</b> — hours it is under construction; it earns nothing during that time.</li>
      <li><b>Horizon</b> — how many days ahead you want to judge it over.</li></ol>
      <p>Example: an upgrade costs $100,000 and adds $3,000/h. It pays for itself after about 33 hours; over 30 days it earns $2.16M minus the $100,000 cost.</p></details>
      <div class="tl-form">${f('roi_cost', 'Up-front cost ($)')}${f('roi_profit', 'Extra profit ($/hour)')}${f('roi_lead', 'Build / upgrade time (hours)')}${f('roi_days', 'Horizon (days)')}</div><div id="tlVerdict" class="tl-verdict"></div><div id="tlOut" class="tl-stats"></div>`;
    calcRoi();
  }
  function calcRoi() {
    const v = k => $('#roi_' + k)?.value, c = { cost: v('cost'), profit: v('profit'), lead: v('lead'), days: v('days') }; store.set('roi', c);
    const r = C.roi({ cost: num(c.cost), extraProfitPerHour: num(c.profit), leadTimeHours: num(c.lead) || 0, horizonDays: num(c.days) });
    const vd = $('#tlVerdict'); if (vd) vd.innerHTML = !r.ok ? '' : r.paybackHours == null ? `<b class="tl-down">It never pays back</b> — the extra profit per hour must be above $0.` : `It pays for itself after <b>${hrs(r.paybackHours)}</b>. After ${r.horizonDays} days you are <b class="${cls(r.netOverHorizon)}">${money(r.netOverHorizon, 0)} ${r.netOverHorizon >= 0 ? 'ahead' : 'behind'}</b>${r.paysBackWithinHorizon ? '.' : ' — it has not paid back yet within that time.'}`;
    $('#tlOut').innerHTML = !r.ok ? `<div class="tl-empty">${esc(r.error)}</div>` : `<div><span>Payback (incl. build time)</span>${r.paybackHours == null ? 'never' : hrs(r.paybackHours)}</div><div><span>Net over ${r.horizonDays} days</span><b class="${cls(r.netOverHorizon)}">${money(r.netOverHorizon)}</b></div><div><span>ROI over horizon</span><b class="${cls(r.roiOverHorizon)}">${pct(r.roiOverHorizon * 100, 1)}</b></div><div><span>Annualised (simple)</span><b class="${cls(r.annualisedReturn)}">${pct(r.annualisedReturn * 100, 1)}</b></div><p class="tl-note tl-wide">${esc(r.formula)}</p>`;
  }
  function paintLoan(pane) {
    const c = store.get('loan', { principal: 100000, rate: 1, per: 'day', days: 14, profit: 50, lead: 0 }), f = (id, l) => field(id, l, c[id.replace('loan_', '')]).replace('__KIND__', 'loan');
    pane.innerHTML = `<details class="tl-help" open><summary>How Loan &amp; bond works</summary>
      <p>Use it when you would <b>borrow money</b> (for example by selling a bond in the game) to pay for a building or upgrade, and want to know if it is worth the interest.</p>
      <ol><li><b>Principal</b> — how much you borrow.</li>
      <li><b>Interest rate</b> and <b>per</b> — the rate exactly as the game shows it (per day, per week…).</li>
      <li><b>Term</b> — days until you pay it back.</li>
      <li><b>Funded item profit</b> — profit per hour the thing you buy will make (Profit / h / level × levels added).</li></ol>
      <p>The Manager works out the total interest, what the debt costs you per hour, and whether the item earns more than that. Interest is simple (not compounded).</p></details>
      <div class="tl-form">${f('loan_principal', 'Principal ($)')}${f('loan_rate', 'Interest rate (%)')}<label>per<select id="loan_per" data-calc="loan">${['hour', 'day', 'week', 'year'].map(p => `<option${p === c.per ? ' selected' : ''}>${p}</option>`).join('')}</select></label>${f('loan_days', 'Term (days)')}${f('loan_profit', 'Funded item profit ($/hour)')}${f('loan_lead', 'Build time (hours)')}</div><div id="tlVerdict" class="tl-verdict"></div><div id="tlOut" class="tl-stats"></div>`;
    calcLoan();
  }
  function calcLoan() {
    const v = k => $('#loan_' + k)?.value, c = { principal: v('principal'), rate: v('rate'), per: v('per'), days: v('days'), profit: v('profit'), lead: v('lead') }; store.set('loan', c);
    const r = C.loan({ principal: num(c.principal), ratePct: num(c.rate), ratePeriod: c.per, termDays: num(c.days), fundedProfitPerHour: num(c.profit) || 0, leadTimeHours: num(c.lead) || 0 });
    const vd = $('#tlVerdict'); if (vd) vd.innerHTML = !r.ok ? '' : `Borrowing ${money(r.principal, 0)} for ${r.termDays} days costs <b>${money(r.totalInterest, 0)}</b> in interest (${money(r.hourlyDebtCost)}/h). The item earns ${money(r.fundedProfitPerHour)}/h${r.leadTimeHours > 0 ? ` after ${hrs(r.leadTimeHours)} of building` : ''}: ${money(r.earnedOverTerm, 0)} over the term, so ${r.netOverTerm >= 0 ? `you keep <b class="tl-up">${money(r.netOverTerm, 0)}</b> after interest — <b class="tl-up">worth it</b>.` : `you lose <b class="tl-down">${money(-r.netOverTerm, 0)}</b> — <b class="tl-down">not worth it</b> at this rate.`}`;
    $('#tlOut').innerHTML = !r.ok ? `<div class="tl-empty">${esc(r.error)}</div>` : `<div><span>Total interest</span>${money(r.totalInterest)}</div><div><span>Total repayment</span>${money(r.totalRepayment)}</div><div><span>Hourly cost of debt</span>${money(r.hourlyDebtCost)}/h</div><div><span>Net per hour</span><b class="${cls(r.netHourly)}">${money(r.netHourly)}/h</b></div><div><span>Net over term</span><b class="${cls(r.netOverTerm)}">${money(r.netOverTerm)}</b></div><div><span>Verdict</span><b class="${r.outEarnsDebt ? 'tl-up' : 'tl-down'}">${r.outEarnsDebt ? 'Out-earns the debt' : 'Does not cover the debt'}</b></div><p class="tl-note tl-wide">Break-even: the item must earn at least ${money(r.breakEvenProfitPerHour)}/h. ${esc(r.formula)}</p>`;
  }
  // v2.5.331 phone layout: help collapsed, suggestion first, one compact card per option, and amounts
  // accept shorthand (250k, 1.2m, 3,500). parseAmt is pure text parsing — no game values involved.
  function parseAmt(v) {
    const m = String(v ?? '').trim().toLowerCase().replace(/[$,\s]/g, '').match(/^(-?\d*\.?\d+)([kmb]?)$/);
    if (!m) return NaN;
    return Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1);
  }
  function allocInput(i, k, v, label, ph) {
    return `<label class="al-f al-${k}"><span>${label}</span><input data-calc="alloc" data-i="${i}" data-k="${k}" type="text" inputmode="decimal" autocomplete="off" placeholder="${ph}" value="${esc(v)}"></label>`;
  }
  function paintAlloc(pane) {
    let opts = store.get('allocOpts', null);
    if (!Array.isArray(opts)) { opts = [{ name: 'Option A', cost: 100000, profit: 50, lead: 0 }, { name: 'Option B', cost: 20000, profit: 14, lead: 0 }]; store.set('allocOpts', opts); }
    pane.innerHTML = `<div class="al-top"><label class="al-budget"><span>Budget</span><input id="alloc_budget" data-calc="alloc" type="text" inputmode="decimal" autocomplete="off" placeholder="optional, e.g. 250k" value="${esc(store.get('allocBudget', ''))}"></label><button type="button" id="tlAddOpt" class="al-add">+ Option</button></div>
      <div id="tlAllocPlan"></div>
      <div class="al-opts">${opts.map((o, i) => `<div class="al-opt"><div class="al-row1"><input class="al-name" data-calc="alloc" data-i="${i}" data-k="name" placeholder="Name, e.g. Upgrade Mill #3" value="${esc(o.name)}"><button type="button" class="al-del" data-del-opt="${i}" aria-label="Remove option">×</button></div><div class="al-row2">${allocInput(i, 'cost', o.cost, 'Cost $', '100k')}${allocInput(i, 'profit', o.profit, 'Profit $/h', '50')}${allocInput(i, 'lead', o.lead, 'Build h', '0')}</div></div>`).join('')}</div>
      <div id="tlOut"></div>
      <details class="tl-help"><summary>How Capital allocation works</summary>
      <p>Use it when you have <b>limited cash</b> and several things you could spend it on — e.g. "Upgrade Mill #3", "New Farm", "Research".</p>
      <ol><li>One card per option: its <b>cost</b> and the <b>profit per hour</b> it adds (Profit / h / level from the Production tab × levels added). Build hours are optional. You can type 250k or 1.2m.</li>
      <li>Optionally enter your <b>budget</b>.</li></ol>
      <p>Options are ranked by <b>Profit/h</b>. <b>Return / day</b> is daily profit as a % of the cost — the best use of each dollar. <b>Payback</b> is how long until it has paid for itself. <b>Opportunity cost</b> is the profit per hour you give up by picking that option instead of the top one. With a budget, the Manager suggests the set of options with the best return that fits.</p></details>`;
    calcAlloc();
  }
  function calcAlloc() {
    const opts = store.get('allocOpts', []);
    const r = C.allocate(opts.map(o => ({ name: o.name, cost: parseAmt(o.cost), profitPerHour: parseAmt(o.profit), leadTimeHours: parseAmt(o.lead) || 0 })), { budget: parseAmt(store.get('allocBudget', '')) });
    const plan = $('#tlAllocPlan');
    if (plan) plan.innerHTML = r.plan ? `<div class="tl-verdict">${r.plan.picked.length ? `With ${money(r.plan.spent + r.plan.left, 0)}: pick <b>${esc(r.plan.picked.join(' + '))}</b> — costs ${money(r.plan.spent, 0)}, adds <b class="tl-up">${money(r.plan.profitPerHour)}/h</b>, leaves ${money(r.plan.left, 0)}.` : 'Nothing fits the budget.'}</div>` : '';
    $('#tlOut').innerHTML = r.rows.length ? `<ol class="al-res">${r.rows.map(x => `<li class="${x.affordable ? '' : 'al-over'}"><div><b>${x.rank}. ${esc(x.name)}</b><span class="${cls(x.profitPerHour)}">${money(x.profitPerHour)}/h</span></div><small>${pct(x.returnPerDay * 100, 2)}/day · payback ${x.paybackHours == null ? 'never' : hrs(x.paybackHours)} · gives up ${money(x.opportunityCostPerHour)}/h${x.affordable ? '' : ' · over budget'}</small></li>`).join('')}</ol><p class="tl-note">Best use of each dollar: ${esc(r.rankingByReturnOnCapital.join(' › ') || '—')}</p>` : '<div class="tl-empty">Enter a cost and profit/h for at least one option.</div>';
  }

  function calcInput(t) {
    const kind = t.dataset.calc;
    if (kind === 'roi') calcRoi();
    else if (kind === 'loan') calcLoan();
    else if (kind === 'alloc') {
      if (t.id === 'alloc_budget') store.set('allocBudget', t.value);
      else { const o = store.get('allocOpts', []); const i = Number(t.dataset.i); if (o[i]) { o[i][t.dataset.k] = t.value; store.set('allocOpts', o); } }
      calcAlloc();
    } else if (kind === 'hist') { S.historyKey = String(t.value); store.set('historyKey', S.historyKey); paint(true); }
  }

  /* ------------------------------------------------------------ paint */
  let lastSig = '';
  function paint(force) {
    const pane = shell(); if (!pane || !S.state) return;
    const typing = pane.contains(document.activeElement) && /^(INPUT|SELECT)$/.test(document.activeElement.tagName);
    const sig = [S.sub, S.range, S.historyKey, S.logAt, S.state?.vwapData?.updatedAt, S.state?.liveMarketPriceData?.fetchedAt, S.names.size, S.data ? 1 : 0].join('|');
    if (!force && (typing || sig === lastSig)) return; // never rebuild a form while the user is typing in it
    lastSig = sig;
    ({ movers: paintMovers, history: paintHistory, roi: paintRoi, loan: paintLoan, alloc: paintAlloc }[S.sub] || paintMovers)(pane);
  }
  function render(s, names) {
    S.state = s; if (names instanceof Map) S.names = names;
    const realm = realmOf(s); loadLog(realm, S.realm !== realm);
    loadStaticData().then(() => { if (isActive()) paint(); });
    paint();
  }
  globalThis.SCM_TOOLS_UI = { render, _state: S };
})();
