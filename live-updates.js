/* Sim Companies Manager — visible proof of background updates (v2.5.330).
 * Reads the background job history (scmBackgroundJobs:<realm>) that background.js records for
 * every warehouse refresh, overlay notification and price update, and shows it under the header.
 * A toast appears whenever the warehouse is refreshed because of something you did in the game
 * (collecting from buildings, buying, selling, contracts). Read-only: never writes storage. */
(function () {
  'use strict';
  const el = document.getElementById('liveUpdates');
  if (!el || !globalThis.chrome?.storage?.local) return;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ago = t => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
  const LABEL = {
    'warehouse-refresh|stock-mutation-or-forced': 'Warehouse refreshed after a game action (collect / buy / sell / contract)',
    'warehouse-refresh|overlay-refresh': 'Warehouse checked for the game overlay',
    'overlay-refresh-notification': 'Game overlay told to update',
    'market-vwap-stage': 'VWAP prices downloaded',
    'market-vwap-stage-scheduled': 'VWAP download queued',
    'market-prices-stage': 'Market price job finished',
    'market-prices-stage-scheduled': 'Current-price download queued',
    'market-current-price-stage': 'Current market prices downloaded',
    'post-sync-market-refresh-scheduled': 'Price refresh queued after Sync',
    'resource-image-cache-sync': 'Product images checked',
    'core-sync': 'Sync',
    'accounting-week-ledger': 'Accounting week ledger'
  };
  // v2.5.331 one-line legend shown above the job list.
  const LEGEND = 'Warehouse = last time the Manager re-read your warehouse from the game · last game action = last collect/buy/sell/contract it reacted to · prices = last SimcoTools price download (VWAP + current prices, about every 10 min). Green dot = warehouse refreshed in the last 15 min. "skipped" = nothing needed (data still fresh), not an error.';
  const label = j => LABEL[`${j.job}|${j.trigger}`] || LABEL[j.job] || String(j.job || 'job').replace(/-/g, ' ');
  let realm = null, jobs = [], lastSeenId = null, toastTimer = 0, open = false;

  function toast(text) {
    let t = document.getElementById('scmToast');
    if (!t) { t = document.createElement('div'); t.id = 'scmToast'; t.className = 'scm-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = text; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 4500);
  }
  function lastOf(pred) { for (let i = jobs.length - 1; i >= 0; i--) if (pred(jobs[i])) return jobs[i]; return null; }
  // v2.5.331: the strip used to rebuild its whole innerHTML every 15 s (restarting the dot animation and
  // redrawing the open list = visible flash). Now the structure is built once and only changed text is written.
  let ui = null, lastListKey = '';
  function build() {
    el.innerHTML = '<button type="button" class="lu-bar" aria-expanded="false"><span class="lu-dot"></span><span class="lu-text"></span><span class="lu-more">▼</span></button><div class="lu-panel" hidden><p class="lu-legend"></p><ol class="lu-list"></ol></div>';
    ui = { bar: el.querySelector('.lu-bar'), dot: el.querySelector('.lu-dot'), text: el.querySelector('.lu-text'), more: el.querySelector('.lu-more'), panel: el.querySelector('.lu-panel'), list: el.querySelector('.lu-list') };
    el.querySelector('.lu-legend').textContent = LEGEND;
    lastListKey = '';
  }
  const setHtml = (node, html) => { if (node.__h !== html) { node.innerHTML = html; node.__h = html; } };
  function paint() {
    if (!ui || !el.contains(ui.bar)) build();
    const t = j => Date.parse(j?.finishedAt || j?.startedAt || '') || 0;
    const wh = lastOf(j => j.job === 'warehouse-refresh' && j.outcome === 'success');
    const action = lastOf(j => j.job === 'warehouse-refresh' && j.trigger === 'stock-mutation-or-forced' && j.outcome === 'success');
    const price = lastOf(j => /^market-(?:current-price|vwap)-stage$/.test(j.job) && j.outcome === 'success');
    const fails = jobs.filter(j => j.outcome === 'failure' && Date.now() - t(j) < 3600e3).length;
    const fresh = !!(wh && Date.now() - t(wh) < 15 * 60e3);
    const parts = [
      wh ? `Warehouse <b>${esc(ago(t(wh)))}</b>` : 'Warehouse: waiting',
      action ? `last game action <b>${esc(ago(t(action)))}</b>` : null,
      price ? `prices <b>${esc(ago(t(price)))}</b>` : null,
      fails ? `<span class="lu-bad">${fails} failed in the last hour</span>` : null
    ].filter(Boolean);
    ui.dot.classList.toggle('on', fresh);
    setHtml(ui.text, `Background updates · ${parts.join(' · ')}`);
    ui.bar.setAttribute('aria-expanded', String(open));
    ui.more.textContent = open ? '▲' : '▼';
    ui.panel.hidden = !open;
    if (open) {
      const last = jobs.slice(-10).reverse();
      const key = last.map(j => j.id).join(',');
      if (key !== lastListKey) {
        lastListKey = key;
        ui.list.innerHTML = last.map(j => `<li class="lu-${esc(j.outcome)}"><span>${esc(new Date(t(j)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }))}</span> ${esc(label(j))}${j.details?.rows != null ? ` · ${esc(j.details.rows)} items` : ''}${j.outcome !== 'success' ? ` · <b>${esc(j.outcome)}</b>${j.error ? ': ' + esc(j.error) : ''}` : ''}</li>`).join('') || '<li>No background activity recorded yet for this realm.</li>';
      }
    }
  }
  async function load(notify) {
    try {
      const r = await chrome.storage.local.get({ selectedRealm: null, activeRealmKey: null });
      const n = Number(r.selectedRealm ?? String(r.activeRealmKey || '').replace('realm:', ''));
      realm = n === 0 || n === 1 ? n : null;
      if (realm == null) { el.innerHTML = ''; ui = null; return; }
      const key = `scmBackgroundJobs:${realm}`;
      const h = (await chrome.storage.local.get({ [key]: [] }))[key];
      jobs = Array.isArray(h) ? h.filter(j => j && typeof j === 'object') : [];
      const newest = lastOf(j => j.job === 'warehouse-refresh' && j.trigger === 'stock-mutation-or-forced' && j.outcome === 'success');
      if (notify && newest && newest.id !== lastSeenId && Date.now() - Date.parse(newest.finishedAt || 0) < 60e3) {
        toast(`✓ Warehouse updated from the game${newest.details?.rows != null ? ` (${newest.details.rows} items)` : ''}`);
        el.classList.remove('lu-flash'); void el.offsetWidth; el.classList.add('lu-flash');
      }
      if (newest) lastSeenId = newest.id;
      paint();
    } catch { /* storage unavailable: keep last view */ }
  }
  el.addEventListener('click', e => { if (e.target.closest('.lu-bar')) { open = !open; paint(); } });
  (globalThis.scmOnStorageChanged || (fn => chrome.storage.onChanged.addListener(fn)))((changes, area) => {
    if (area !== 'local') return;
    if (changes.selectedRealm || changes.activeRealmKey || (realm != null && changes[`scmBackgroundJobs:${realm}`])) load(true);
  });
  setInterval(() => { if (!document.hidden) paint(); }, 15000);
  if (globalThis.scmOnDashboardResume) globalThis.scmOnDashboardResume(() => load(true));
  load(false);
  globalThis.SCM_LIVE_UPDATES = { reload: load };
})();
