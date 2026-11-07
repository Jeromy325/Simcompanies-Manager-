// v2.5.439 storage retention: pure helpers for scmPruneStorage (background.js). No chrome.* here.
// Every helper takes a value as stored, returns {value, removed}; removed === 0 means "unchanged, do not write".
// Corrupt / unexpected shapes are returned untouched (removed 0) so a bad key is never made worse.
// See research_notes/storage_inventory.md for what reads each family and how far back.
(function (root) {
  'use strict';
  const DAY = 86400000;
  const ms = v => { const t = typeof v === 'number' ? v : Date.parse(String(v || '')); return Number.isFinite(t) ? t : null; };
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const same = value => ({ value, removed: 0 });
  const cutoff = (now, days) => now - Math.max(1, Number(days) || 90) * DAY;

  // Array of entries; entries without a readable time are kept. keepLast = newest N kept whatever their age.
  function pruneList(list, timeOf, cut, keepLast = 0) {
    if (!Array.isArray(list)) return same(list);
    const keepFrom = Math.max(0, list.length - keepLast);
    const out = list.filter((e, i) => { if (i >= keepFrom) return true; const t = ms(timeOf(e)); return t == null || t >= cut; });
    return out.length === list.length ? same(list) : { value: out, removed: list.length - out.length };
  }
  // scmPriceLog:N {v:1, series:{id:[[t,p],…]}}. The newest point of each series always stays.
  function prunePriceLog(log, cut) {
    if (!isObj(log) || !isObj(log.series)) return same(log);
    let removed = 0; const series = {};
    for (const [id, arr] of Object.entries(log.series)) {
      if (!Array.isArray(arr)) { series[id] = arr; continue; }
      const r = pruneList(arr, p => (Array.isArray(p) ? p[0] : null), cut, 1);
      series[id] = r.value; removed += r.removed;
    }
    return removed ? { value: { ...log, series }, removed } : same(log);
  }
  // scmProductionCostHistory:N [{b,id,q,t,…}]. "Last run" cost compares the newest two runs of a building+product,
  // which can be older than 90 days for a rarely made product, so the newest 2 per building|product|quality stay.
  function pruneProductionCostHistory(list, cut) {
    if (!Array.isArray(list)) return same(list);
    const newest = new Map();
    for (const e of list) { const t = ms(e?.t); if (t == null) continue; const g = `${e.b}|${e.id}|${e.q}`; const a = newest.get(g) || []; a.push(t); newest.set(g, a); }
    const floor = new Map([...newest].map(([g, a]) => [g, a.sort((x, y) => y - x)[Math.min(1, a.length - 1)]]));
    const out = list.filter(e => { const t = ms(e?.t); if (t == null || t >= cut) return true; return t >= floor.get(`${e.b}|${e.id}|${e.q}`); });
    return out.length === list.length ? same(list) : { value: out, removed: list.length - out.length };
  }
  // scmStatementHistory:N {kind:{isoDate:data}}.
  function pruneStatementHistory(h, cut) {
    if (!isObj(h)) return same(h);
    let removed = 0; const next = {};
    for (const [kind, days] of Object.entries(h)) {
      if (!isObj(days)) { next[kind] = days; continue; }
      const keep = Object.entries(days).filter(([d]) => { const t = ms(d); return t == null || t >= cut; });
      removed += Object.keys(days).length - keep.length; next[kind] = Object.fromEntries(keep);
    }
    return removed ? { value: next, removed } : same(h);
  }
  // Realm-store `history` (daily VWAP) {"rid:q":[{date:'YYYY-MM-DD',vwap}]}. Newest point per product stays.
  function pruneVwapHistory(h, cut) {
    if (!isObj(h)) return same(h);
    let removed = 0; const next = {};
    for (const [k, arr] of Object.entries(h)) {
      if (!Array.isArray(arr)) { next[k] = arr; continue; }
      const r = pruneList(arr, x => (x && x.date ? `${x.date}T12:00:00Z` : null), cut, 1);
      next[k] = r.value; removed += r.removed;
    }
    return removed ? { value: next, removed } : same(h);
  }
  // sellingHistory {id:{datetime,…}} (fallback for the weekly sales card only).
  function pruneTimedMap(map, timeOf, cut) {
    if (!isObj(map)) return same(map);
    const keep = Object.entries(map).filter(([, v]) => { const t = ms(timeOf(v)); return t == null || t >= cut; });
    const removed = Object.keys(map).length - keep.length;
    return removed ? { value: Object.fromEntries(keep), removed } : same(map);
  }
  // endpointData {url:{receivedAt,data,…}}: latest copy per URL. (1) Copies of one URL that differ only by a trailing
  // slash keep the newest. (2) Per-item caches (a numeric id in the path) not refreshed for `cut` are dropped; day
  // statements (/day/N/) and generic endpoints are never dropped by age.
  const STATEMENT_DAY = /\/(income-statement|cashflow-statement|balance-sheet)\/day\/\d+\/?$/;
  const PER_ITEM = /\/\d{2,}(\/[a-z-]+)?\/?(\?|$)/i;
  // v2.5.442: large game replies the Manager never reads (collectibles ~1.4 MB, messages, auctions, transaction
  // pages). They are not stored on capture and are removed from existing stores by the daily trim.
  const UNUSED_ENDPOINT = /\/api\/v\d+\/(?:market-collectibles|building-auctions|resources-transactions)\/|\/api\/messages_by_company\//i;
  function pruneEndpointData(map, cut) {
    if (!isObj(map)) return same(map);
    const byNorm = new Map();
    for (const [k, v] of Object.entries(map)) {
      const n = k.replace(/\/+(\?|$)/, '$1');
      const prev = byNorm.get(n);
      if (!prev || (ms(v?.receivedAt) ?? -1) > (ms(map[prev]?.receivedAt) ?? -1)) byNorm.set(n, k);
    }
    const winners = new Set(byNorm.values());
    const keep = Object.entries(map).filter(([k, v]) => {
      if (!winners.has(k)) return false;
      if (UNUSED_ENDPOINT.test(k)) return false;
      if (STATEMENT_DAY.test(k) || !PER_ITEM.test(k)) return true;
      const t = ms(v?.receivedAt); return t == null || t >= cut;
    });
    const removed = Object.keys(map).length - keep.length;
    return removed ? { value: Object.fromEntries(keep), removed } : same(map);
  }

  // Plan for the standalone keys of one realm. got = {key: value} as read. Returns {patch, removed:{family:n}}.
  function planRealmKeys(n, got, now, days = 90) {
    const cut = cutoff(now, days), patch = {}, removed = {};
    const apply = (key, fam, r) => { if (r.removed > 0) { patch[key] = r.value; removed[fam] = (removed[fam] || 0) + r.removed; } };
    const g = k => (got ? got[k] : undefined);
    apply(`scmPriceLog:${n}`, 'scmPriceLog', prunePriceLog(g(`scmPriceLog:${n}`), cut));
    apply(`scmProductionCostHistory:${n}`, 'scmProductionCostHistory', pruneProductionCostHistory(g(`scmProductionCostHistory:${n}`), cut));
    apply(`scmStatementHistory:${n}`, 'scmStatementHistory', pruneStatementHistory(g(`scmStatementHistory:${n}`), cut));
    apply(`scmBackgroundJobs:${n}`, 'scmBackgroundJobs', pruneList(g(`scmBackgroundJobs:${n}`), e => e?.finishedAt || e?.startedAt, cut, 20));
    return { patch, removed };
  }
  // Plan for fields inside scmRealmStore:N. Returns {patch, removed}.
  function planRealmStore(store, now, days = 90) {
    if (!isObj(store)) return { patch: {}, removed: {} };
    const cut = cutoff(now, days), patch = {}, removed = {};
    const apply = (f, r) => { if (r.removed > 0) { patch[f] = r.value; removed[f] = r.removed; } };
    apply('history', pruneVwapHistory(store.history, cut));
    apply('sellingHistory', pruneTimedMap(store.sellingHistory, v => v?.datetime, cut));
    apply('contractEvents', pruneList(store.contractEvents, e => e?.receivedAt, cut, 10));
    apply('endpointData', pruneEndpointData(store.endpointData, cut));
    // v2.5.443 Accounting chart series {v,days:{'YYYY-MM-DD':{…}}}: same 90-day trim as the other time series.
    if (isObj(store.accountingDailySeries) && isObj(store.accountingDailySeries.days)) { const r = pruneTimedMap(Object.fromEntries(Object.keys(store.accountingDailySeries.days).map(k => [k, k])), k => `${k}T23:59:59Z`, cut); if (r.removed > 0) apply('accountingDailySeries', { removed: r.removed, value: { ...store.accountingDailySeries, days: Object.fromEntries(Object.keys(r.value).map(k => [k, store.accountingDailySeries.days[k]])) } }); }
    return { patch, removed };
  }
  function planGlobal(got, now, days = 90) {
    const cut = cutoff(now, days), patch = {}, removed = {};
    const r = pruneList(got?.scmErrorLog, e => e?.at, cut, 20);
    if (r.removed) { patch.scmErrorLog = r.value; removed.scmErrorLog = r.removed; }
    return { patch, removed };
  }
  // Top N keys by approximate size; key names only (numbers past ':' kept: 'scmRealmStore:1').
  function topKeys(sizes, n = 8) {
    return Object.entries(isObj(sizes) ? sizes : {}).filter(([, b]) => Number(b) > 0)
      .sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, bytes]) => ({ key: String(key).replace(/^([A-Za-z_]+(?::\d+)?).*$/, '$1').slice(0, 60), bytes: Number(bytes) }));
  }
  const approxBytes = v => { try { return v === undefined ? 0 : JSON.stringify(v).length; } catch { return 0; } };

  root.SCM_STORAGE_CORE = { UNUSED_ENDPOINT, DAY, cutoff, pruneList, prunePriceLog, pruneProductionCostHistory, pruneStatementHistory, pruneVwapHistory, pruneTimedMap, pruneEndpointData, planRealmKeys, planRealmStore, planGlobal, topKeys, approxBytes };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SCM_STORAGE_CORE;
})(typeof globalThis !== 'undefined' ? globalThis : self);
