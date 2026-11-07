import { describe, it, expect } from 'vitest';
import { loadCore } from './load.mjs';
const P = loadCore('planner-core.js').SCMPlannerCore;

describe('contract allocation by quality', () => {
  it('a Q1 contract consumes Q1 stock before higher qualities (bulldozer case)', () => {
    const r = P.balanceSupplyDemandContracts({
      warehouseRows: [{ id: 112, quality: 3, amount: 199 }, { id: 112, quality: 1, amount: 81 }],
      productionRows: [{ id: 112, quality: 3, amount: 400 }, { id: 112, quality: 1, amount: 501 }],
      contractRows: [{ id: 112, quality: 1, amount: 500 }],
      includeQualityRows: true,
    });
    const q = Object.fromEntries(r.qualityRows.map(x => [x.quality, x]));
    expect(q[1].contracted).toBe(500);
    expect(q[1].warehouseOnlyLeft).toBe(81 - 500);
    expect(q[1].leftover).toBe(81 + 501 - 500);
    expect(q[3].contracted || 0).toBe(0);
    expect(q[3].warehouseOnlyLeft).toBe(199);
  });
  it('falls back to higher quality when the contract quality runs out', () => {
    const r = P.balanceSupplyDemandContracts({
      warehouseRows: [{ id: 5, quality: 1, amount: 10 }, { id: 5, quality: 2, amount: 50 }],
      contractRows: [{ id: 5, quality: 1, amount: 30 }], includeQualityRows: true,
    });
    const q = Object.fromEntries(r.qualityRows.map(x => [x.quality, x]));
    expect([q[1].contracted, q[2].contracted]).toEqual([10, 20]);
    expect(r[0].leftover).toBe(30);
  });
});
