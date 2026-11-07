import { describe, it, expect } from 'vitest';
import { loadCore } from './load.mjs';

const plain = v => JSON.parse(JSON.stringify(v));
const S = loadCore('self-test-core.js').SCM_SELF_TEST_CORE;
const D = loadCore('diagnostic-core.js').SCM_DIAGNOSTIC_CORE;
const now = Date.parse('2026-11-07T12:00:00Z');

describe('self-test-core', () => {
  it('row normalizes status and totals counts each status', () => {
    expect(S.row('a', 'A', 'bogus', 1).status).toBe('warn');
    expect(plain(S.totals([S.row('a', 'A', 'pass'), S.row('b', 'B', 'fail'), S.row('c', 'C', 'skip'), S.row('d', 'D', 'pass')])))
      .toEqual({ pass: 2, warn: 0, fail: 1, skip: 1, total: 4 });
  });
  it('evalAlarms lists missing names and supports prefixes', () => {
    const r = S.evalAlarms(['x', 'y', 'scm-building-*'], [{ name: 'x' }, { name: 'scm-building-0-5' }]);
    expect(plain(r.missing)).toEqual(['y']);
    expect(r.status).toBe('warn');
    expect(S.evalAlarms(['x'], ['x']).status).toBe('pass');
  });
  it('evalErrorLog counts only the last 24 h and ranks contexts', () => {
    const log = [
      { at: new Date(now - 1000).toISOString(), context: 'sync', message: 'timed out https://api.example.com/x?token=abc ' + 'Z'.repeat(30) },
      { at: new Date(now - 2000).toISOString(), context: 'sync' },
      { at: new Date(now - 3000).toISOString(), context: 'market' },
      { at: new Date(now - 2 * 86400000).toISOString(), context: 'old' },
    ];
    const r = S.evalErrorLog(log, now);
    expect(r.count24h).toBe(3);
    expect(plain(r.top[0])).toMatchObject({ context: 'sync', count: 2 });
    expect(r.top[0].sample).toContain('timed out');
    expect(r.top[0].sample).not.toContain('https://');
    expect(r.top[0].sample).not.toContain('ZZZZZZZZZZZZZZZZZZZZZZZZ');
    expect(r.status).toBe('warn');
    expect(S.evalErrorLog([], now).status).toBe('pass');
  });
  it('evalErrorLog ignores entries from other versions when a current version is given', () => {
    const at = new Date(now - 1000).toISOString();
    const r = S.evalErrorLog([{ at, context: 'old', version: '1.0' }, { at, context: 'new', version: '2.0' }, { at, context: 'nov' }], now, 86400000, '2.0');
    expect([r.count24h, r.older24h, r.status]).toEqual([2, 1, 'warn']);
    expect(S.evalErrorLog([{ at, context: 'old', version: '1.0' }], now, 86400000, '2.0').status).toBe('pass');
  });
  it('evalFreshness grades age', () => {
    expect(S.evalFreshness(now - 5 * 60000, now).status).toBe('pass');
    expect(S.evalFreshness(now - 120 * 60000, now).status).toBe('warn');
    expect(S.evalFreshness(now - 3 * 86400000, now).status).toBe('fail');
    expect(S.evalFreshness(null, now).status).toBe('skip');
  });
  it('scanNumbers flags NaN, Infinity and negatives', () => {
    const r = S.scanNumbers([1, 'x', Infinity, -2, null, 0]);
    expect([r.checked, r.nan, r.infinite, r.negative, r.status]).toEqual([5, 1, 1, 1, 'fail']);
    expect(S.scanNumbers([-1]).status).toBe('warn');
    expect(S.scanNumbers([1, 2]).status).toBe('pass');
  });
  it('realmDataSummary returns only counts/booleans', () => {
    const s = S.realmDataSummary({ authData: { authCompany: { companyId: 99, company: 'Secret Co' } }, buildings: [{}, {}], warehouseResources: [{}], contracts: [{}],
      endpointData: { a: { receivedAt: '2026-11-07T11:00:00Z' } }, lastSync: '2026-11-07T10:00:00Z' });
    expect(s.hasCompanyId).toBe(true);
    expect([s.buildings, s.resources, s.contracts, s.endpoints]).toEqual([2, 1, 1, 1]);
    expect(JSON.stringify(s)).not.toMatch(/Secret Co|99/);
    expect(S.evalRealmData(s)).toBe('pass');
    expect(S.evalRealmData(S.realmDataSummary({}))).toBe('skip');
  });
  it('evalLiveFetch requires 200 and an object', () => {
    expect(S.evalLiveFetch({ ok: true, status: 200, data: { authCompany: {} } }).status).toBe('pass');
    expect(S.evalLiveFetch({ ok: true, status: 200, data: null }).status).toBe('warn');
    expect(S.evalLiveFetch({ ok: false, status: 0 }).status).toBe('fail');
  });
  it('buildReport has a header with totals and redacts secret keys', () => {
    const rep = S.buildReport([S.row('a', 'A', 'pass', 'ok', { token: 'tok-xyz', n: 1 })], { version: '9.9', userAgent: 'UA', at: 'T' }, v => D.redactSecrets(v));
    expect(rep.json.header.totals.pass).toBe(1);
    expect(rep.text).toContain('v9.9');
    expect(rep.text).not.toContain('tok-xyz');
  });
});
