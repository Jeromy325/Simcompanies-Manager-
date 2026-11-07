import { describe, it, expect } from 'vitest';
import { loadCore } from './load.mjs';
import * as R from '../../realm-core.js';

// vm contexts have their own Array/Object prototypes, so compare via JSON where structure matters.
const plain = v => JSON.parse(JSON.stringify(v));

describe('tools-core', () => {
  const T = loadCore('tools-core.js').SCM_TOOLS_CORE;
  it('roi computes payback and net', () => {
    const r = T.roi({ cost: 1000, extraProfitPerHour: 10, leadTimeHours: 5, horizonDays: 30 });
    expect(r.ok).toBe(true);
    expect(r.paybackHours).toBe(105);
    expect(r.netOverHorizon).toBe(10 * (720 - 5) - 1000);
    expect(r.paysBackWithinHorizon).toBe(true);
  });
  it('roi validates input', () => {
    expect(T.roi({ cost: 0, extraProfitPerHour: 1 }).ok).toBe(false);
    expect(T.roi({ cost: 5 }).ok).toBe(false);
  });
});

describe('market-core', () => {
  const M = loadCore('market-core.js').SCM_MARKET_CORE;
  const now = 1_700_000_000_000;
  it('prefers a fresh order book, cheapest exact quality', () => {
    const store = { endpointData: { '/api/v3/market/0/1/': { receivedAt: new Date(now - 1000).toISOString(), data: [
      { id: 1, price: 0.5, quality: 1 }, { id: 2, price: 0.4, quality: 1 }, { id: 3, price: 0.2, quality: 0 }] } } };
    const p = M.marketPrice(store, 0, 1, 1, { now });
    expect(p).not.toBeNull();
    expect(p.price).toBe(0.4);
    expect(p.source).toBe('exchange');
  });
  it('falls back to exact-quality VWAP only', () => {
    const store = { vwapData: { sourceRealm: 0, fetchedAt: new Date(now).toISOString(), rows: [{ resourceId: 7, quality: 2, value: 3.3 }] } };
    expect(M.vwap(store, 0, 7, 2, now).value).toBe(3.3);
    expect(M.vwap(store, 0, 7, 3, now)).toBeNull();
    expect(M.marketPrice({}, 0, 7, 2, { now })).toBeNull();
  });
});

describe('planner-core', () => {
  const P = loadCore('planner-core.js').SCMPlannerCore;
  it('discounts and rounds currency up', () => {
    expect(P.clampDiscount(150)).toBe(100);
    expect(P.discountedUnitPrice(10, 3)).toBe(9.7);
    expect(P.discountedUnitPrice(1.001, 0)).toBe(1.01);
    expect(P.discountedUnitPrice(0, 5)).toBeNull();
    expect(P.roundResourceDown(1.23456)).toBe(1.234);
  });
});

describe('notify-core', () => {
  const N = loadCore('notify-core.js').SCM_NOTIFY_CORE;
  it('formats money and totals', () => {
    expect(N.money(1234.5)).toBe('$1,234.50');
    expect(N.money(0.1234)).toBe('$0.123');
    expect(N.money(-2)).toBe('−$2.00');
    expect(N.total(1234.6)).toBe('$1,235');
    expect(N.money(null)).toBe('—');
  });
});

describe('analyze-core', () => {
  const A = loadCore('analyze-core.js').SCM_ANALYZE_CORE;
  it('derives exchange fee rate from ledger sales', () => {
    const r = A.feeRate([
      { channel: 'exchange', fee: 40, gross: 1000, t: 1 },
      { channel: 'exchange', fee: 60, gross: 1500, t: 5 },
      { channel: 'contract', fee: 0, gross: 9000, t: 9 },
      { channel: 'exchange', fee: 1, gross: 10, t: 9 }]);
    expect(r.rate).toBeCloseTo(0.04);
    expect(r.pairs).toBe(2);
    expect(r.at).toBe(5);
    expect(A.feeRate([])).toBeNull();
  });
});

describe('diagnostic-core', () => {
  const D = loadCore('diagnostic-core.js').SCM_DIAGNOSTIC_CORE;
  it('serial queue runs tasks in order', async () => {
    const q = D.createSerialQueue(), out = [];
    await Promise.all([q(async () => { await new Promise(r => setTimeout(r, 10)); out.push(1); }), q(async () => out.push(2))]);
    expect(out).toEqual([1, 2]);
  });
});

describe('realm-core (ES module)', () => {
  it('maps realms', () => {
    expect(R.validRealmNumber('1')).toBe(1);
    expect(R.validRealmNumber(5)).toBeNull();
    expect(R.realmDisplayName(0)).toBe('R1 - Magnates');
    expect(R.realmStorageKey(1)).toBe('scmRealmStore:1');
    expect(plain(R.realmContractPaths(9))).toEqual([]);
  });
});
