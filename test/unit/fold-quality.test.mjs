import { describe, it, expect } from 'vitest';
import { loadCore } from './load.mjs';
const P = loadCore('planner-core.js').SCMPlannerCore;
const row = (id, quality, warehouse, demand = 0, extra = {}) => ({ id, quality, warehouse, demand, produced: 0, incoming: 0, contracted: 0, leftover: warehouse - demand, warehouseOnlyLeft: warehouse - demand, ...extra });
const keys = (...k) => new Set(k);

describe('foldQualityStock (overlay "Stock After Demand & Contracts")', () => {
  it('folds higher-quality stock into the nearest lower produced row (engines / bulldozers case)', () => {
    const out = P.foldQualityStock([row(7, 2, 100, 300), row(7, 4, 50)], keys('7:2'), null, [{ id: 7, minQuality: 1, amount: 300 }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ quality: 2, warehouse: 150, demand: 300, warehouseOnlyLeft: -150, substituteQualities: [4] });
  });
  it('folds eligible LOWER-quality stock into the produced row it can cover (Power Q2 -> Q3, recipes accept >= Q2)', () => {
    const out = P.foldQualityStock([row(1, 3, 1_200_000, 1_294_224), row(1, 2, 400_000)], keys('1:3'), null, [{ id: 1, minQuality: 2, amount: 1_294_224 }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ quality: 3, warehouse: 1_600_000, demand: 1_294_224, warehouseOnlyLeft: 305_776, substituteQualities: [2] });
    expect(out[0].warehouseByQuality).toEqual([{ quality: 3, amount: 1_200_000 }, { quality: 2, amount: 400_000 }]);
  });
  it('uses the lowest minQuality among demand rows, and never counts stock below it', () => {
    const demand = [{ id: 1, minQuality: 3, amount: 10 }, { id: 1, minQuality: 2, amount: 10 }];
    const out = P.foldQualityStock([row(1, 3, 5, 20), row(1, 2, 7), row(1, 1, 9)], keys('1:3'), null, demand);
    expect(out.find(r => r.quality === 3)).toMatchObject({ warehouse: 12, substituteQualities: [2] });
    expect(out.find(r => r.quality === 1)).toMatchObject({ warehouse: 9 });
  });
  it('does not fold lower stock when nothing demands the resource', () => {
    const out = P.foldQualityStock([row(1, 3, 5), row(1, 2, 7)], keys('1:3'), null, []);
    expect(out).toHaveLength(2);
  });
  it('leaves produced rows and rows with a saved contract untouched', () => {
    const out = P.foldQualityStock([row(1, 3, 5, 10), row(1, 2, 7), row(1, 4, 2)], keys('1:3', '1:2'), keys('1:4'), [{ id: 1, minQuality: 2, amount: 10 }]);
    expect(out).toHaveLength(3);
    expect(out.find(r => r.quality === 3).warehouse).toBe(5);
  });
  it('prefers the higher-quality rule when both directions are possible', () => {
    const out = P.foldQualityStock([row(1, 2, 5, 10), row(1, 4, 5, 10), row(1, 3, 6)], keys('1:2', '1:4'), null, [{ id: 1, minQuality: 1, amount: 20 }]);
    expect(out.find(r => r.quality === 2)).toMatchObject({ warehouse: 11, substituteQualities: [3] });
    expect(out.find(r => r.quality === 4).warehouse).toBe(5);
  });
});
