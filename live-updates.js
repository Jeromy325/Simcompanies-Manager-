/* Sim Companies Manager — visible proof of background updates (v2.5.330).
 * Reads the background job history (scmBackgroundJobs:<realm>) that background.js records for
 * every warehouse refresh, overlay notification and price update, and shows it under the header.
 * A toast appears whenever the warehouse is refreshed because of something you did in the game
 * (collecting from buildings, buying, selling, contracts). Writes only its own display setting
 * (scmMonitorGameMode: how the game-page monitor shows: bar / mini / hidden). */
(function () {
  'use strict';
  if (!globalThis.chrome?.storage?.local) return;
  // v2.5.352 also runs on the game page (content script): a floating monitor you can drag, tap to expand.
  const GAME = typeof location !== 'undefined' && /(^|\.)simcompanies\.com$/i.test(location.hostname);
  if (GAME && (window.top !== window || document.getElementById('scmMonitor'))) return;
  const POS_KEY = 'scmMonitorPos';
  function gameHost() {
    const host = document.createElement('div');
    host.id = 'scmMonitor'; host.className = 'live-updates scm-monitor';
    // v2.5.361 × collapses the monitor to a small dot (tap the dot to bring the bar back). It no longer hides it: a hidden
    // monitor could only be brought back from the Manager. Tapping outside closes the expanded list.
    host.innerHTML = '<div class="scm-monitor-grip" title="Drag to move" aria-label="Drag to move">⠿</div><div class="scm-monitor-body"></div><div class="scm-monitor-ctrl"><button type="button" class="scm-monitor-hide" aria-label="Collapse to a small dot" title="Collapse to a small dot (tap the dot to open)">×</button></div><button type="button" class="scm-monitor-mini" aria-label="Show background updates"><span class="lu-dot"></span><b></b></button>';
    (document.body || document.documentElement).appendChild(host);
    const place = (x, y) => { const w = host.offsetWidth || 260, h = host.offsetHeight || 40; x = Math.max(0, Math.min(window.innerWidth - Math.min(w, window.innerWidth), x)); y = Math.max(0, Math.min(window.innerHeight - Math.min(h, window.innerHeight), y)); host.style.left = x + 'px'; host.style.top = y + 'px'; return { x, y }; };
    let pos = null; try { pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch {}
    requestAnimationFrame(() => place(pos?.x ?? 8, pos?.y ?? Math.max(60, window.innerHeight - 110)));
    const grip = host.querySelector('.scm-monitor-grip');
    let drag = null;
    grip.addEventListener('pointerdown', e => { drag = { dx: e.clientX - host.offsetLeft, dy: e.clientY - host.offsetTop }; try { grip.setPointerCapture(e.pointerId); } catch {} e.preventDefault(); });
    grip.addEventListener('pointermove', e => { if (drag) place(e.clientX - drag.dx, e.clientY - drag.dy); });
    const end = () => { if (!drag) return; drag = null; try { localStorage.setItem(POS_KEY, JSON.stringify({ x: host.offsetLeft, y: host.offsetTop })); } catch {} };
    grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => place(host.offsetLeft, host.offsetTop), { passive: true });
    host.__refit = () => requestAnimationFrame(() => place(host.offsetLeft, host.offsetTop)); // keep an expanded panel on screen
    const setMode = m => { try { chrome.storage.local.set({ scmMonitorGameMode: m }); } catch {} applyMode(m); };
    let curMode = '';
    const applyMode = m => { const mode = ['bar', 'mini', 'hidden'].includes(m) ? m : 'bar'; if (mode === curMode) return; curMode = mode; host.classList.toggle('is-mini', mode === 'mini'); host.hidden = mode === 'hidden'; host.__refit(); };
    host.querySelector('.scm-monitor-hide').addEventListener('click', e => { e.stopPropagation(); setMode('mini'); });
    host.querySelector('.scm-monitor-mini').addEventListener('click', () => setMode('bar'));
    // v2.5.361 a monitor hidden with the old × comes back as the small dot (once); "Hidden" chosen in the Manager still hides it.
    chrome.storage.local.get({ scmMonitorGameMode: 'bar', scmMonitorHideMigrated: false }).then(r => {
      if (r.scmMonitorGameMode === 'hidden' && !r.scmMonitorHideMigrated) { chrome.storage.local.set({ scmMonitorGameMode: 'mini', scmMonitorHideMigrated: true }).catch(() => {}); applyMode('mini'); }
      else { if (!r.scmMonitorHideMigrated) chrome.storage.local.set({ scmMonitorHideMigrated: true }).catch(() => {}); applyMode(r.scmMonitorGameMode); }
    }).catch(() => {});
    // v2.5.361 performance: no chrome.storage.onChanged listener on the game page. Every storage write (the ~1 MB realm
    // store) was copied into the game tab twice per write. The mode is read with the small poll in init() instead.
    host.__applyMode = applyMode;
    return host.querySelector('.scm-monitor-body');
  }
  let el = GAME ? null : document.getElementById('liveUpdates');
  if (!GAME && !el) return;
  if (GAME) { const start = () => { if (!el) { el = gameHost(); init(); } }; if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true }); }
  function init() {
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
    'accounting-week-ledger': 'Accounting week ledger',
    'abundance-refresh': 'Abundance of your mines / oil rigs / quarries',
    'abundance-refresh|game-auth-data': 'Abundance checked (game page loaded)',
    'extra-game-data': 'After Sync: research, government orders, abundance',
    'game-constants': 'Game constants downloaded (rates, recipes)',
    'market-orders': 'Your exchange listings checked',
    'accounting-refresh': 'Accounting statements refreshed',
    'alert-sent': 'Alert sent',
    'game-data-saved': 'Saved from the game'
  };
  // v2.5.352 extra detail per line (what, alert title, counts).
  const detail = j => { const d = j.details || {}; const out = [];
    if (d.what) out.push(d.what); if (d.title) out.push(d.title);
    if (d.rows != null && d.wanted != null) out.push(`${d.rows}/${d.wanted}`); else if (d.rows != null) out.push(`${d.rows} items`);
    if (d.abundance) out.push(`abundance ${d.abundance}`); if (d.mines != null) out.push(`${d.mines} mines`);
    if (d.sources && /missing|unreadable/.test(d.sources)) out.push(d.sources);
    return out.length ? ' · ' + out.map(esc).join(' · ') : ''; };
  // v2.5.331 one-line legend shown above the job list.
  const LEGEND = 'Warehouse = last time the Manager re-read your warehouse from the game · last game action = last collect/buy/sell/contract it reacted to · prices = last SimcoTools price download (VWAP + current prices, about every 10 min). Green dot = warehouse refreshed in the last 15 min. "skipped" = nothing needed (data still fresh), not an error.';
  const label = j => LABEL[`${j.job}|${j.trigger}`] || LABEL[j.job] || String(j.job || 'job').replace(/-/g, ' ');
  let realm = null, jobs = [], lastSeenId = null, toastTimer = 0, open = false, lastPollSig = '';
  try { open = GAME && localStorage.getItem('scmMonitorOpen') === '1'; } catch {}

  function toast(text) {
    let t = document.getElementById('scmToast');
    if (!t) { t = document.createElement('div'); t.id = 'scmToast'; t.className = GAME ? 'scm-toast scm-game-toast' : 'scm-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = text; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 4500);
  }
  function lastOf(pred) { for (let i = jobs.length - 1; i >= 0; i--) if (pred(jobs[i])) return jobs[i]; return null; }
  // v2.5.331: the strip used to rebuild its whole innerHTML every 15 s (restarting the dot animation and
  // redrawing the open list = visible flash). Now the structure is built once and only changed text is written.
  let ui = null, lastListKey = '';
  function build() {
    el.innerHTML = '<button type="button" class="lu-bar" aria-expanded="false"><span class="lu-dot"></span><span class="lu-text"></span><span class="lu-more">▼</span></button><div class="lu-panel" hidden>' + (GAME ? '' : '<label class="lu-game-mode">Monitor on the game page <select><option value="bar">Bar</option><option value="mini">Small dot</option><option value="hidden">Hidden</option></select></label>') + '<p class="lu-legend"></p><p class="lu-count"></p><ol class="lu-list"></ol></div>';
    ui = { bar: el.querySelector('.lu-bar'), dot: el.querySelector('.lu-dot'), text: el.querySelector('.lu-text'), more: el.querySelector('.lu-more'), panel: el.querySelector('.lu-panel'), list: el.querySelector('.lu-list'), count: el.querySelector('.lu-count') };
    el.querySelector('.lu-legend').textContent = LEGEND;
    const gm = el.querySelector('.lu-game-mode select');
    if (gm) { chrome.storage.local.get({ scmMonitorGameMode: 'bar' }).then(r => { gm.value = r.scmMonitorGameMode; }).catch(() => {}); gm.addEventListener('change', () => { chrome.storage.local.set({ scmMonitorGameMode: gm.value }).catch(() => {}); }); }
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
    if (GAME) { const mini = document.querySelector('#scmMonitor .scm-monitor-mini'); if (mini) { mini.querySelector('.lu-dot').classList.toggle('on', fresh); mini.querySelector('b').textContent = fails ? String(fails) : ''; mini.classList.toggle('has-bad', !!fails); } }
    setHtml(ui.text, `${GAME ? "" : "Background updates · "}${parts.join(' · ')}`);
    ui.bar.setAttribute('aria-expanded', String(open));
    ui.more.textContent = open ? '▲' : '▼';
    ui.panel.hidden = !open;
    if (open) {
      const last = jobs.slice().reverse(); // v2.5.352 every stored activity (newest first), not only the last 10
      const key = last.length + ':' + (last[0]?.id || '');
      if (key !== lastListKey) {
        lastListKey = key;
        if (ui.count) ui.count.textContent = `${last.length} activities (newest first)`;
        ui.list.innerHTML = last.map(j => `<li class="lu-${esc(j.outcome)}"><span>${esc(new Date(t(j)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }))}</span> ${esc(label(j))}${detail(j)}${j.outcome !== 'success' ? ` · <b>${esc(j.outcome)}</b>${j.error ? ': ' + esc(j.error) : ''}` : ''}</li>`).join('') || '<li>No background activity recorded yet for this realm.</li>';
      }
    }
  }
  async function load(notify) {
    try {
      const r = await chrome.storage.local.get({ selectedRealm: null, activeRealmKey: null });
      // game page: the realm this game tab is in (content.js), else the active realm
      const tabRealm = GAME ? Number(window.__SCM_GAME_REALM__) : NaN;
      const n = tabRealm === 0 || tabRealm === 1 ? tabRealm : GAME ? Number(String(r.activeRealmKey || '').replace('realm:', '')) : Number(r.selectedRealm ?? String(r.activeRealmKey || '').replace('realm:', ''));
      realm = n === 0 || n === 1 ? n : null;
      if (realm == null) { el.innerHTML = ''; ui = null; return; }
      const key = `scmBackgroundJobs:${realm}`;
      const got = await chrome.storage.local.get(GAME ? { [key]: [], scmMonitorGameMode: 'bar' } : { [key]: [] });
      if (GAME) document.getElementById('scmMonitor')?.__applyMode?.(got.scmMonitorGameMode);
      const h = got[key];
      // v2.5.361 game page polls: skip the repaint when nothing changed
      const sig = Array.isArray(h) && h.length ? `${h.length}:${h[h.length - 1]?.id}:${h[h.length - 1]?.finishedAt}` : '0';
      if (GAME && notify === 'poll' && sig === lastPollSig) { paint(); return; }
      lastPollSig = sig;
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
  if (GAME) document.addEventListener('pointerdown', e => { if (open && !e.target.closest?.('#scmMonitor')) { open = false; try { localStorage.setItem('scmMonitorOpen', '0'); } catch {} paint(); document.getElementById('scmMonitor')?.__refit?.(); } }, true);
  el.addEventListener('click', e => { if (e.target.closest('.lu-bar')) { open = !open; if (GAME) { try { localStorage.setItem('scmMonitorOpen', open ? '1' : '0'); } catch {} } paint(); if (GAME) document.getElementById('scmMonitor')?.__refit?.(); } });
  // Manager: storage listener (attached only while the Manager is visible). Game page: a small poll of this realm's
  // job list instead (v2.5.361 performance, see gameHost).
  if (!GAME) (globalThis.scmOnStorageChanged || (fn => chrome.storage.onChanged.addListener(fn)))((changes, area) => {
    if (area !== 'local') return;
    if (changes.selectedRealm || changes.activeRealmKey || (realm != null && changes[`scmBackgroundJobs:${realm}`])) load(true);
  });
  // game page: the tab learns its realm a few seconds after load; jobs and mode are re-read every 3 s while visible
  setInterval(() => { if (GAME) { if (document.hidden) return; const tr = Number(window.__SCM_GAME_REALM__); if ((tr === 0 || tr === 1) && tr !== realm) { load(false); return; } load('poll'); return; } if (!document.hidden) paint(); }, GAME ? 3000 : 15000);
  if (globalThis.scmOnDashboardResume) globalThis.scmOnDashboardResume(() => load(true));
  load(false);
  globalThis.SCM_LIVE_UPDATES = { reload: load };
  }
  if (!GAME) init();
})();
