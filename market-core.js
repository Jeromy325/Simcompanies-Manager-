/* Sim Companies Manager - single source for market price and VWAP. Pure functions: no chrome.*, no network.
 * Everything that shows or uses a market price calls marketPrice(); everything that uses VWAP calls vwap().
 * Never borrows a neighbouring quality. Load: service worker `import './market-core.js'` (before notify-core.js),
 * dashboard <script src="market-core.js"> (before tools-core/analyze/dashboard), Node require. */
(function (root) {
  'use strict';
  const BOOK_MAX_AGE_MS = 6 * 3600e3;       // game order book capture: usable while younger than 6 h
  const SIMCOTOOLS_MAX_AGE_MS = 3 * 3600e3; // SimcoTools current prices: fresh while younger than 3 h; older is returned flagged stale
  const n = v => { if (v == null || v === '') return null; const x = Number(v); return Number.isFinite(x) ? x : null; };
  const ts = v => { const t = Date.parse(String(v || '')); return Number.isFinite(t) ? t : null; };
  // Strict: data must carry an integer realm stamp equal to the requested realm, else it is ignored (never read an unstamped store as another realm's).
  const realmOk = (dataRealm, realm) => typeof dataRealm !== 'boolean' && dataRealm !== '' && dataRealm != null && Number.isInteger(Number(dataRealm)) && Number.isInteger(Number(realm)) && Number(dataRealm) === Number(realm);
  const eligible = (mode, want, q) => (mode === 'any' ? true : mode === 'min' ? q >= want : q === want);
  const sellerOf = r => n(r?.seller?.id ?? r?.sellerId ?? r?.company?.id ?? r?.companyId ?? (typeof r?.seller === 'object' ? null : r?.seller));
  const make = (price, quality, want, source, at, now, stale) => ({ price, quality, source, at: at ?? null, ageMs: at != null ? Math.max(0, now - at) : null, stale: !!stale, exact: quality === want });

  // Sole VWAP reader. Exact quality only. Rows: resourceId|id|kind, quality, value|vwap|price.
  function vwap(store, realm, id, quality, now = Date.now()) {
    const d = store?.vwapData; if (!d || !Array.isArray(d.rows)) return null;
    if (!realmOk(d.sourceRealm, realm)) return null;
    id = Number(id); quality = Number(quality);
    const hit = d.rows.find(x => Number(x?.resourceId ?? x?.id ?? x?.kind) === id && Number(x?.quality) === quality && n(x?.value ?? x?.vwap ?? x?.price) > 0);
    if (!hit) return null;
    const at = ts(hit.fetchedAt || d.fetchedAt || d.updatedAt);
    return { value: Number(hit.value ?? hit.vwap ?? hit.price), at, stale: d.stale === true || d.fallback === true || hit.stale === true, fallback: d.fallback === true };
  }

  // Order: fresh game order book > fresh SimcoTools (rows, then per-product cache) > stale SimcoTools (stale:true) > exact-quality VWAP.
  // mode: 'exact' quality === q | 'min' quality >= q | 'any' any quality (the game calculator rule). opts.noVwap skips the VWAP step.
  function marketPrice(store, realm, id, quality, opts = {}) {
    id = Number(id); const want = Number(quality) || 0;
    const mode = opts.mode === 'min' || opts.mode === 'any' ? opts.mode : 'exact';
    const now = opts.now ?? Date.now();
    const bookMax = opts.bookMaxAgeMs ?? BOOK_MAX_AGE_MS, stMax = opts.simcotoolsMaxAgeMs ?? SIMCOTOOLS_MAX_AGE_MS;
    const cid = n(opts.companyId);
    const own = opts.ownIds ? new Set([...(opts.ownIds.values ? opts.ownIds.values() : opts.ownIds)].map(String)) : null;

    const ep = store?.endpointData?.[`/api/v3/market/${realm}/${id}/`];
    const bat = ts(ep?.receivedAt);
    if (Array.isArray(ep?.data) && bat != null && now - bat < bookMax) {
      const ok = ep.data.filter(r => n(r?.price) > 0 && n(r?.quality) != null && eligible(mode, want, Number(r.quality))
        && !(own && r?.id != null && own.has(String(r.id))) && !(cid != null && sellerOf(r) === cid));
      if (ok.length) { const b = ok.reduce((a, c) => (Number(c.price) < Number(a.price) ? c : a)); return make(Number(b.price), Number(b.quality), want, 'exchange', bat, now, false); }
    }

    const lp = store?.liveMarketPriceData;
    let best = null;
    if (lp && realmOk(lp.realm, realm) && Array.isArray(lp.rows)) {
      for (const r of lp.rows) {
        if (Number(r?.resourceId) !== id || !(n(r?.price) > 0) || n(r?.quality) == null || !eligible(mode, want, Number(r.quality))) continue;
        if (!best || Number(r.price) < best.price) best = { price: Number(r.price), quality: Number(r.quality), at: ts(r.fetchedAt || lp.updatedAt), flagged: r.stale === true };
      }
    }
    if (!best && store?.liveMarketProductCache && typeof store.liveMarketProductCache === 'object') { // keyed id:q; the realm store is already per realm
      for (const [k, p] of Object.entries(store.liveMarketProductCache)) {
        const pq = Number(p?.quality);
        if (Number(p?.resourceId) !== id || k !== `${id}:${pq}` ||!eligible(mode, want, pq)) continue;
        const pr = n(p?.selected?.price); if (!(pr > 0)) continue;
        if (!best || pr < best.price) best = { price: pr, quality: pq, at: ts(p.fetchedAt || p.updatedAt || p.receivedAt), flagged: p.stale === true };
      }
    }
    if (best) return make(best.price, best.quality, want, 'simcotools', best.at, now, best.flagged || best.at == null || now - best.at >= stMax);

    if (!opts.noVwap) {
      const v = vwap(store, realm, id, want, now);
      if (v) return make(v.value, want, want, 'vwap', v.at, now, v.stale);
    }
    return null;
  }

  const api = { marketPrice, vwap, BOOK_MAX_AGE_MS, SIMCOTOOLS_MAX_AGE_MS };
  root.SCM_MARKET_CORE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
