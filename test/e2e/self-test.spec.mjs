import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const EXT = path.resolve(import.meta.dirname, '../..');

// Settings → Run self-test on the fake game harness: result shape, redacted report, content scripts refused.
test('self-test: RUN_SELF_TEST shape, redacted report, refused from content scripts', async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-e2e-st-'));
  const opts = {
    channel: 'chromium', headless: true, viewport: { width: 360, height: 740 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  };
  if (process.env.PW_CHROMIUM_PATH) { opts.executablePath = process.env.PW_CHROMIUM_PATH; delete opts.channel; }
  const ctx = await chromium.launchPersistentContext(userDir, opts);
  try {
    const methods = [];
    await ctx.route(/simcotools|simconomist|example\.invalid/, r => r.abort());
    await ctx.route(/simcompanies\.com/, r => {
      const u = r.request().url();
      if (u.includes('/api/')) { methods.push(r.request().method()); return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ authCompany: { companyId: 4242, company: 'SecretCorp', realmId: 0 } }) }); }
      return r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>SimCompanies</title></head><body>game</body></html>' });
    });
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    const id = sw.url().split('/')[2];

    const opt = await ctx.newPage();
    await opt.goto(`chrome-extension://${id}/options.html`);
    await opt.waitForLoadState('load');
    await opt.evaluate(() => chrome.storage.local.set({
      authData: { authCompany: { companyId: 4242 }, sessionSecret: 'auth-secret-xyz' },
      liveBridge: { enabled: false, url: '', token: 'tok-secret-xyz', pushOnSync: false },
      'scmRealmStore:0': { authData: { authCompany: { companyId: 4242, company: 'SecretCorp' }, token: 'tok-secret-xyz' },
        buildings: [{ id: 1, busy: { resource: { kind: 1, quality: 0 } } }], warehouseResources: [{ kind: 1, quality: 0, amount: 10 }],
        endpointData: { '/api/v3/market/0/1/': { receivedAt: new Date().toISOString(), data: [{ price: 0.5, quality: 0 }] } }, lastSync: new Date().toISOString() },
    }));

    const game = await ctx.newPage();
    const cdp = await ctx.newCDPSession(game);
    const worlds = [];
    cdp.on('Runtime.executionContextCreated', e => { if (e.context?.auxData?.type === 'isolated') worlds.push(e.context.id); });
    await cdp.send('Runtime.enable');
    await game.goto('https://www.simcompanies.com/r1/');
    await game.waitForTimeout(2500);

    const r = await opt.evaluate(() => chrome.runtime.sendMessage({ type: 'RUN_SELF_TEST', liveFetch: true }));
    expect(r.ok).toBe(true);
    expect(r.results.length).toBeGreaterThanOrEqual(10);
    for (const x of r.results) {
      expect(typeof x.id).toBe('string');
      expect(typeof x.name).toBe('string');
      expect(['pass', 'warn', 'fail', 'skip']).toContain(x.status);
      expect(typeof x.detail).toBe('string');
      expect(typeof x.metrics).toBe('object');
    }
    const byId = Object.fromEntries(r.results.map(x => [x.id, x]));
    expect(byId['ext-version'].status).toBe('pass');
    expect(byId['tab-open'].status).toBe('pass');
    expect(byId['realm-0'].metrics.buildings).toBe(1);
    expect(byId['calc'].metrics.nan).toBe(0);
    expect(r.totals.total).toBe(r.results.length);
    // Read-only toward the game.
    expect(methods.filter(m => m !== 'GET')).toEqual([]);

    // UI: run + copy report; the report carries no secrets, names or ids.
    await opt.click('#runSelfTest');
    await expect(opt.locator('#selfTestResults li').first()).toBeVisible({ timeout: 30000 });
    await expect(opt.locator('#copySelfTest')).toBeEnabled({ timeout: 30000 });
    await opt.click('#copySelfTest');
    const report = await opt.evaluate(() => globalThis.__scmSelfTestReport);
    expect(report).toContain('Totals:');
    for (const s of ['tok-secret-xyz', 'auth-secret-xyz', 'SecretCorp', '4242']) expect(report).not.toContain(s);
    expect(JSON.stringify(r)).not.toMatch(/tok-secret-xyz|auth-secret-xyz|SecretCorp|4242/);
    const width = await opt.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(360);

    // Content scripts are refused.
    expect(worlds.length).toBeGreaterThan(0);
    const cs = (await cdp.send('Runtime.evaluate', { expression: `chrome.runtime.sendMessage({type:'RUN_SELF_TEST'})`, contextId: worlds[worlds.length - 1], awaitPromise: true, returnByValue: true })).result.value;
    expect(cs).toEqual({ ok: false, error: 'Not allowed from this context.' });
  } finally {
    await ctx.close();
  }
});
