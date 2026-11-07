import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const EXT = path.resolve(import.meta.dirname, '../..');

// 200 days of history seeded into every time-series family; PRUNE_STORAGE trims to 90 days, keeps settings,
// saved contracts and planner state, and the dashboard still renders without errors.
test('storage prune: 200 days of history trimmed to 90, needed data kept, dashboard renders', async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-e2e-prune-'));
  const opts = {
    channel: 'chromium', headless: true, viewport: { width: 360, height: 740 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  };
  if (process.env.PW_CHROMIUM_PATH) { opts.executablePath = process.env.PW_CHROMIUM_PATH; delete opts.channel; }
  const ctx = await chromium.launchPersistentContext(userDir, opts);
  try {
    await ctx.route(/simcompanies\.com|simcotools|simconomist/, r => r.abort());
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    const id = sw.url().split('/')[2];
    const opt = await ctx.newPage();
    await opt.goto(`chrome-extension://${id}/options.html`);
    await opt.waitForLoadState('load');
    await opt.waitForTimeout(1500); // let install-time steps settle
    await opt.evaluate(async () => {
      const DAY = 86400000, now = Date.now(), iso = d => new Date(now - d * DAY).toISOString();
      const N = 200, pad = 'x'.repeat(300);
      const series = {}, vwap = {}, pch = [], jobs = [], sell = {}, stmt = { 'income-statement': {}, 'balance-sheet': {} };
      for (let r = 1; r <= 30; r++) { series[r] = []; vwap[`${r}:0`] = []; }
      for (let d = N - 1; d >= 0; d--) {
        for (let r = 1; r <= 30; r++) {
          for (let h = 0; h < 6; h++) series[r].push([now - d * DAY - h * 3600000, r + h]);
          vwap[`${r}:0`].push({ date: iso(d).slice(0, 10), vwap: r });
          pch.push({ k: `${r}|${iso(d)}`, b: r, bn: 'B', id: r, q: 0, c: 1, t: iso(d), n: 10 });
        }
        stmt['income-statement'][iso(d)] = { date: iso(d), isComputed: true, sales: 1, pad };
        stmt['balance-sheet'][iso(d)] = { date: iso(d), isComputed: true, pad };
        sell[`s${d}`] = { id: `s${d}`, resourceId: 1, amount: 1, profit: 1, datetime: iso(d) };
        jobs.push({ id: `j${d}`, realm: 0, job: 'sync', trigger: 't', startedAt: iso(d), finishedAt: iso(d), durationMs: 1, pad });
      }
      await chrome.storage.local.set({
        syncMinutes: 7,
        'scmPriceLog:0': { v: 1, realm: 0, series },
        'scmProductionCostHistory:0': pch,
        'scmStatementHistory:0': stmt,
        'scmBackgroundJobs:0': jobs,
        'scmProductionPlannerState:0': { planningLevels: { 101: 7 }, runHours: 12 },
        'scmRealmStore:0': { savedContracts: [{ id: 'c1', at: iso(400) }], productionPlans: { p: 1 }, history: vwap, sellingHistory: sell, lastSync: iso(0) },
      });
    });
    const before = await opt.evaluate(() => chrome.storage.local.getBytesInUse(null));
    const r = await opt.evaluate(() => chrome.runtime.sendMessage({ type: 'PRUNE_STORAGE' }));
    expect(r.ok).toBe(true);
    expect(r.written).toEqual(expect.arrayContaining(['scmPriceLog:0', 'scmProductionCostHistory:0', 'scmStatementHistory:0', 'scmBackgroundJobs:0', 'scmRealmStore:0']));
    const after = await opt.evaluate(() => chrome.storage.local.getBytesInUse(null));
    console.log(`storage prune e2e: ${before} -> ${after} bytes (${Math.round((1 - after / before) * 100)}% smaller)`);
    expect(after).toBeLessThan(before * 0.6);
    const got = await opt.evaluate(() => chrome.storage.local.get(null));
    const cut = Date.now() - 91 * 86400000;
    expect(got['scmPriceLog:0'].series[1].every(p => p[0] >= cut)).toBe(true);
    expect(got['scmPriceLog:0'].series[1].length).toBeGreaterThan(400);
    expect(Object.keys(got['scmStatementHistory:0']['income-statement']).length).toBeLessThanOrEqual(91);
    expect(got['scmProductionCostHistory:0'].length).toBeLessThanOrEqual(30 * 91);
    expect(got['scmRealmStore:0'].history['1:0'].length).toBeLessThanOrEqual(91);
    expect(got['scmRealmStore:0'].savedContracts).toEqual([{ id: 'c1', at: expect.any(String) }]);
    expect(got['scmRealmStore:0'].productionPlans).toEqual({ p: 1 });
    expect(got['scmProductionPlannerState:0'].planningLevels).toEqual({ 101: 7 });
    expect(got.syncMinutes).toBe(7);
    // Idempotent: a second pass writes nothing.
    const r2 = await opt.evaluate(() => chrome.runtime.sendMessage({ type: 'PRUNE_STORAGE' }));
    expect(r2.ok).toBe(true);
    expect(r2.written.filter(k => k !== 'scmErrorLog')).toEqual([]);
    // Self-test lists the largest keys (names only).
    const st = await opt.evaluate(() => chrome.runtime.sendMessage({ type: 'RUN_SELF_TEST', liveFetch: false }));
    const storage = st.results.find(x => x.id === 'ext-storage');
    expect(storage.metrics.top.length).toBeGreaterThan(0);
    expect(storage.metrics.top.length).toBeLessThanOrEqual(8);
    expect(storage.detail).toMatch(/largest: /);

    const dash = await ctx.newPage();
    const errors = [];
    dash.on('pageerror', e => errors.push(String(e)));
    await dash.goto(`chrome-extension://${id}/dashboard.html`);
    await dash.waitForLoadState('load');
    await dash.waitForTimeout(2000);
    expect(errors, 'dashboard uncaught errors').toEqual([]);
    await expect(dash.locator('#trimStorageNow')).toBeAttached();
  } finally {
    await ctx.close();
    fs.rmSync(userDir, { recursive: true, force: true });
  }
});
