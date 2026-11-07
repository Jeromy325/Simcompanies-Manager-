// v2.5.436 self-test: pure evaluation helpers for the in-app "Run self-test" (Settings). No chrome.* or network
// here; background.js gathers raw facts and these helpers turn them into {id,name,status,detail,metrics} rows.
// Rows carry only counts, booleans, timestamps and error messages: never names, ids, tokens or money values.
(function (root) {
  'use strict';
  const STATUSES = ['pass', 'warn', 'fail', 'skip'];
  const row = (id, name, status, detail, metrics) => ({ id: String(id), name: String(name), status: STATUSES.includes(status) ? status : 'warn', detail: String(detail || ''), metrics: metrics && typeof metrics === 'object' ? metrics : {} });
  const arr = v => (Array.isArray(v) ? v : []);
  const ms = v => { const t = typeof v === 'number' ? v : Date.parse(String(v || '')); return Number.isFinite(t) ? t : null; };

  function totals(results) {
    const t = { pass: 0, warn: 0, fail: 0, skip: 0, total: 0 };
    for (const r of arr(results)) { if (t[r?.status] != null) t[r.status]++; t.total++; }
    return t;
  }

  // expected: alarm names (strings) or prefixes ending in '*'. present: alarm objects or names.
  function evalAlarms(expected, present) {
    const names = arr(present).map(a => String(a?.name ?? a));
    const missing = arr(expected).filter(e => { const s = String(e); return s.endsWith('*') ? !names.some(n => n.startsWith(s.slice(0, -1))) : !names.includes(s); });
    return { expected: arr(expected).length, present: names.length, missing, status: missing.length ? 'warn' : 'pass' };
  }

  // currentVersion (optional): entries tagged with another version are counted as `older` and do not affect status,
  // so errors logged before an update (e.g. already-fixed bugs) don't fail the report.
  function evalErrorLog(log, now, windowMs = 86400000, currentVersion = '') {
    const since = now - windowMs; const counts = new Map(); let n = 0; let older = 0;
    const samples = new Map();
    // A short, scrubbed sample message per context (URLs and long tokens removed) so reports show what failed.
    const scrub = m => String(m || '').replace(/https?:\/\/\S+/g, '<url>').replace(/[A-Za-z0-9_\-]{24,}/g, '<redacted>').slice(0, 140);
    for (const e of arr(log)) { const t = ms(e?.at); if (t == null || t < since) continue; if (currentVersion && e?.version && String(e.version) !== String(currentVersion)) { older++; continue; } n++; const c = String(e?.context || 'unknown').slice(0, 60); counts.set(c, (counts.get(c) || 0) + 1); const m = scrub(e?.message ?? e?.error ?? e?.msg); if (m) samples.set(c, m); }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([context, count]) => ({ context, count, sample: samples.get(context) || '' }));
    return { count24h: n, older24h: older, total: arr(log).length, top, status: n === 0 ? 'pass' : n > 20 ? 'fail' : 'warn' };
  }

  // Freshness of a timestamp: pass within warnMin, warn within failMin, else fail; skip when absent.
  function evalFreshness(ts, now, warnMin = 30, failMin = 24 * 60) {
    const t = ms(ts); if (t == null) return { status: 'skip', ageMin: null };
    const ageMin = Math.max(0, Math.round((now - t) / 60000));
    return { status: ageMin <= warnMin ? 'pass' : ageMin <= failMin ? 'warn' : 'fail', ageMin };
  }

  // Counts NaN/Infinity and negatives (for values that must be >= 0).
  function scanNumbers(values, { nonNegative = true } = {}) {
    const out = { checked: 0, nan: 0, infinite: 0, negative: 0 };
    for (const v of arr(values)) {
      if (v === null || v === undefined || v === '') continue;
      const n = Number(v); out.checked++;
      if (Number.isNaN(n)) out.nan++; else if (!Number.isFinite(n)) out.infinite++; else if (nonNegative && n < 0) out.negative++;
    }
    out.status = out.nan || out.infinite ? 'fail' : out.negative ? 'warn' : 'pass';
    return out;
  }

  // Realm store → counts/booleans only. latestReceived is the newest endpointData.receivedAt.
  function realmDataSummary(store) {
    const s = store && typeof store === 'object' ? store : {};
    const auth = s.authData && typeof s.authData === 'object' ? s.authData : null;
    const ac = auth?.authCompany;
    let latest = null, endpoints = 0;
    for (const v of Object.values(s.endpointData && typeof s.endpointData === 'object' ? s.endpointData : {})) { endpoints++; const t = ms(v?.receivedAt); if (t != null && (latest == null || t > latest)) latest = t; }
    const contracts = Array.isArray(s.contracts) ? s.contracts.length : (s.contracts && typeof s.contracts === 'object' ? Object.values(s.contracts).reduce((a, v) => a + (Array.isArray(v) ? v.length : 0), 0) : 0);
    return {
      hasAuthData: !!auth, hasCompanyId: Number(ac?.companyId ?? ac?.id) > 0, hasCompanyData: !!(s.companyData && typeof s.companyData === 'object'),
      buildings: arr(s.buildings).length, resources: arr(s.warehouseResources).length, contracts, endpoints,
      lastSync: ms(s.lastSync) != null ? new Date(ms(s.lastSync)).toISOString() : null,
      syncStatus: typeof s.syncStatus === 'string' ? s.syncStatus.slice(0, 40) : (s.syncStatus?.status ? String(s.syncStatus.status).slice(0, 40) : null),
      hasSyncError: !!s.syncError,
      latestReceived: latest != null ? new Date(latest).toISOString() : null,
    };
  }

  function evalRealmData(sum) {
    if (!sum || (!sum.hasAuthData && !sum.buildings && !sum.resources && !sum.endpoints)) return 'skip';
    if (!sum.hasAuthData || !sum.hasCompanyId) return 'warn';
    if (sum.hasSyncError) return 'warn';
    return sum.buildings > 0 ? 'pass' : 'warn';
  }

  // Live GET result shape: {ok,status,data}. Expect 200 and an object with an authCompany (only presence is reported).
  function evalLiveFetch(r) {
    if (!r) return { status: 'fail', httpStatus: 0, shapeOk: false };
    const httpStatus = Number(r.status) || 0;
    const shapeOk = !!(r.data && typeof r.data === 'object' && (r.data.authCompany || r.data.authUser || Object.keys(r.data).length));
    return { status: r.ok && httpStatus === 200 && shapeOk ? 'pass' : r.ok ? 'warn' : 'fail', httpStatus, shapeOk };
  }

  function buildReport(results, meta, redact) {
    const red = typeof redact === 'function' ? redact : (v => v);
    const t = totals(results);
    const clean = arr(results).map(r => red(row(r.id, r.name, r.status, r.detail, r.metrics)));
    const header = { tool: 'Sim Companies Manager self-test', version: String(meta?.version || ''), userAgent: String(meta?.userAgent || '').slice(0, 300), at: String(meta?.at || new Date().toISOString()), totals: t };
    const json = { header, results: clean };
    const lines = [`${header.tool} v${header.version}`, `At: ${header.at}`, `UA: ${header.userAgent}`, `Totals: ${t.pass} pass, ${t.warn} warn, ${t.fail} fail, ${t.skip} skip`, ''];
    for (const r of clean) lines.push(`[${r.status.toUpperCase()}] ${r.name}: ${r.detail}`);
    return { json, text: lines.join('\n') + '\n\n' + JSON.stringify(json, null, 2) };
  }

  root.SCM_SELF_TEST_CORE = { row, totals, evalAlarms, evalErrorLog, evalFreshness, scanNumbers, realmDataSummary, evalRealmData, evalLiveFetch, buildReport };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SCM_SELF_TEST_CORE;
})(typeof globalThis !== 'undefined' ? globalThis : self);
