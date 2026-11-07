import { describe, it, expect } from 'vitest';
import { loadCore } from './load.mjs';

const plain = v => JSON.parse(JSON.stringify(v));
const SC = loadCore('storage-core.js').SCM_STORAGE_CORE;
const DAY = 86400000;
const now = Date.parse('2026-11-07T12:00:00Z');
const iso = d => new Date(now - d * DAY).toISOString();
const ymd = d => iso(d).slice(0, 10);
const cut = SC.cutoff(now, 90);

describe('storage-core retention (90 days)', () => {
  it('price log: drops points older than 90 days, keeps recent and the newest point of a stale series', () => {
    const log = { v: 1, realm: 1, series: { 10: Array.from({ length: 200 }, (_, i) => [now - (199 - i) * DAY, i]), 11: [[now - 150 * DAY, 1], [now - 120 * DAY, 2]] } };
    const r = SC.prunePriceLog(log, cut);
    expect(r.value.series[10].length).toBe(91);
    expect(r.value.series[10].every(p => p[0] >= cut)).toBe(true);
    expect(plain(r.value.series[11])).toEqual([[now - 120 * DAY, 2]]);
    expect(r.removed).toBe(109 + 1);
    expect(SC.prunePriceLog(r.value, cut).removed).toBe(0); // idempotent
  });
  it('production cost history: old runs dropped but the last two runs of every building/product stay', () => {
    const list = [];
    for (let d = 199; d >= 0; d--) list.push({ k: `1|${iso(d)}`, b: 1, id: 5, q: 0, c: 1 + d, t: iso(d) });
    list.push({ k: `2|${iso(180)}`, b: 2, id: 7, q: 1, c: 3, t: iso(180) }, { k: `2|${iso(170)}`, b: 2, id: 7, q: 1, c: 4, t: iso(170) }, { k: `2|${iso(160)}`, b: 2, id: 7, q: 1, c: 5, t: iso(160) });
    const r = SC.pruneProductionCostHistory(list, cut);
    expect(r.value.filter(e => e.b === 1).length).toBe(91);
    expect(r.value.filter(e => e.b === 2).map(e => e.c)).toEqual([4, 5]); // rare product: "last run" comparison survives
    expect(SC.pruneProductionCostHistory(r.value, cut).removed).toBe(0);
  });
  it('statement history, VWAP history, selling history, endpoint data', () => {
    const days = Object.fromEntries(Array.from({ length: 200 }, (_, d) => [iso(d), { date: iso(d), isComputed: true }]));
    const sh = SC.pruneStatementHistory({ 'income-statement': days, 'balance-sheet': { [iso(5)]: {} } }, cut);
    expect(Object.keys(sh.value['income-statement']).length).toBe(91);
    expect(Object.keys(sh.value['balance-sheet']).length).toBe(1);
    const vw = SC.pruneVwapHistory({ '1:0': Array.from({ length: 200 }, (_, i) => ({ date: ymd(199 - i), vwap: i })), '2:0': [{ date: ymd(300), vwap: 9 }] }, cut);
    expect(vw.value['1:0'].length).toBeLessThanOrEqual(91);
    expect(vw.value['1:0'].at(-1).vwap).toBe(199);
    expect(plain(vw.value['2:0'])).toEqual([{ date: ymd(300), vwap: 9 }]);
    const sell = SC.pruneTimedMap({ a: { datetime: iso(1) }, b: { datetime: iso(100) }, c: {} }, v => v?.datetime, cut);
    expect(Object.keys(sell.value)).toEqual(['a', 'c']);
    const ep = SC.pruneEndpointData({
      '/api/v2/companies/me/': { receivedAt: iso(200) }, // generic: kept whatever its age
      '/api/v2/companies/me/income-statement/day/3/': { receivedAt: iso(200) }, // statement day: kept
      '/api/v2/companies/buildings/12345/history/': { receivedAt: iso(120) }, // stale per-item cache: dropped
      '/api/v2/companies/buildings/12346/history/': { receivedAt: iso(2) },
      '/api/v3/0/market/12': { receivedAt: iso(1) }, '/api/v3/0/market/12/': { receivedAt: iso(3) }, // dedupe: newest copy kept
    }, cut);
    expect(Object.keys(ep.value).sort()).toEqual(['/api/v2/companies/buildings/12346/history/', '/api/v2/companies/me/', '/api/v2/companies/me/income-statement/day/3/', '/api/v3/0/market/12']);
    expect(ep.removed).toBe(2);
  });
  it('planners: only changed keys/fields, never touches unrelated fields, safe on corrupt input', () => {
    const got = { 'scmPriceLog:1': { v: 1, series: { 1: [[now - 100 * DAY, 1], [now - 99 * DAY, 1], [now, 2]] } }, 'scmStatementHistory:1': 'corrupt', 'scmProductionCostHistory:1': null,
      'scmBackgroundJobs:1': Array.from({ length: 50 }, (_, i) => ({ finishedAt: iso(150 - i) })) };
    const p = SC.planRealmKeys(1, got, now);
    expect(Object.keys(p.patch).sort()).toEqual(['scmBackgroundJobs:1', 'scmPriceLog:1']);
    expect(p.patch['scmBackgroundJobs:1'].length).toBe(20); // newest 20 always kept
    const store = { savedContracts: [{ at: iso(400) }], productionPlans: { x: 1 }, history: { '1:0': [{ date: ymd(200) }, { date: ymd(1) }] }, contractEvents: 'bad', endpointData: {} };
    const rs = SC.planRealmStore(store, now);
    expect(Object.keys(rs.patch)).toEqual(['history']);
    expect(plain(SC.planRealmStore(null, now))).toEqual({ patch: {}, removed: {} });
    expect(plain(SC.planRealmKeys(0, undefined, now))).toEqual({ patch: {}, removed: {} });
    expect(plain(SC.planGlobal({ scmErrorLog: 'x' }, now))).toEqual({ patch: {}, removed: {} });
  });
  it('topKeys: largest first, names only', () => {
    const t = SC.topKeys({ 'scmRealmStore:1': 5e6, 'scmPriceLog:1': 3e5, tiny: 1, zero: 0, 'scmA:1': 2, scmB: 3, c: 4, d: 5, e: 6, f: 7 }, 8);
    expect(t.length).toBe(8);
    expect(plain(t[0])).toEqual({ key: 'scmRealmStore:1', bytes: 5e6 });
  });
});

describe('unused endpoint replies (2.5.442)', () => {
  it('trim drops replies the Manager never reads and keeps used ones', async () => {
    const { loadCore } = await import('./load.mjs');
    const SC = loadCore('storage-core.js').SCM_STORAGE_CORE;
    const now = Date.parse('2026-11-07T12:00:00Z'), at = new Date(now - 1000).toISOString();
    const map = { '/api/v2/market-collectibles/': { receivedAt: at }, '/api/messages_by_company/': { receivedAt: at },
      '/api/v2/building-auctions/1/': { receivedAt: at }, '/api/v2/resources-transactions/1/2/': { receivedAt: at },
      '/api/v3/market/1/112/': { receivedAt: at }, '/api/v4/1/resources-retail-info/': { receivedAt: at } };
    const r = SC.pruneEndpointData(map, now - 90 * 86400000);
    expect(r.removed).toBe(4);
    expect(Object.keys(r.value).sort()).toEqual(['/api/v3/market/1/112/', '/api/v4/1/resources-retail-info/']);
  });
});
