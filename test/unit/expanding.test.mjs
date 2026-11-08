// v2.5.450 the game marks construction / upgrade with busy.category "b" (EXPANDING); "r" is producing.
// background.js and dashboard.js are not loadable cores, so the plain functions are pulled out of the source by name.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
const ROOT = path.resolve(import.meta.dirname, '../..');
function extract(file, names) {
  const src = readFileSync(path.join(ROOT, file), 'utf8');
  const parts = names.map(name => {
    const start = src.indexOf(`\nfunction ${name}(`);
    if (start < 0) throw new Error(`${name} not found in ${file}`);
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
    return src.slice(start + 1, i + 1);
  });
  const ctx = vm.createContext({});
  vm.runInContext(parts.join('\n'), ctx);
  return ctx;
}

const started = '2026-11-08T10:00:00.000Z', t0 = Date.parse(started);
const construction = { id: 7, busy: { category: 'b', started, duration: 3600 } };
const producing = { id: 8, busy: { category: 'r', started, duration: 7200, resource: { kind: 1, name: 'Power' } } };

describe('construction (busy.category "b")', () => {
  it('productionFinishAlarms skips construction, keeps production batches', () => {
    const { productionFinishAlarms } = extract('background.js', ['productionFinishAlarms']);
    const out = productionFinishAlarms(0, [construction, producing]);
    expect(out.map(a => a.buildingId)).toEqual([8]);
    expect(out[0].when).toBe(t0 + 7200e3);
  });
  it('buildingIsExpanding / buildingExpandFinish', () => {
    const { buildingIsExpanding, buildingExpandFinish } = extract('dashboard.js', ['buildingIsExpanding', 'buildingExpandFinish']);
    expect(buildingIsExpanding(construction)).toBe(true);
    expect(buildingIsExpanding(producing)).toBe(false);
    expect(buildingIsExpanding({ busy: null })).toBe(false);
    expect(buildingIsExpanding({})).toBe(false);
    expect(buildingExpandFinish(construction)).toBe(t0 + 3600e3);
    expect(buildingExpandFinish({ busy: { category: 'b' } })).toBe(null);
  });
});
