import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const EXT = path.resolve(import.meta.dirname, '../..');
const STORE = { authData: { authCompany: { company: 'ACME', realmId: 0 } }, lastSync: Date.now(), syncStatus: 'OK', buildings: [], warehouseResources: [] };

// v2.5.438: after an extension update the dashboard opened while the worker restarts showed only
// static HTML ("Build —", "No sync yet") until the user refreshed several times.
test('dashboard/popup/options recover from storage failing during an update, and pick up late data', async () => {
  test.setTimeout(90000);
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-e2e-upd-'));
  const opts = { channel: 'chromium', headless: true, viewport: { width: 360, height: 740 }, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] };
  if (process.env.PW_CHROMIUM_PATH) { opts.executablePath = process.env.PW_CHROMIUM_PATH; delete opts.channel; }
  const ctx = await chromium.launchPersistentContext(userDir, opts);
  try {
    await ctx.route(/simcompanies\.com|simcotools|simconomist/, r => r.abort());
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    const id = sw.url().split('/')[2];
    const version = await sw.evaluate(() => chrome.runtime.getManifest().version);
    await new Promise(r => setTimeout(r, 2000));

    // (a) Update window: storage reads fail / hang for the first ~1.5 s after the page opens.
    await sw.evaluate(s => chrome.storage.local.set({ activeRealmKey: 'realm:0', selectedRealm: 0, 'scmRealmStore:0': s }), STORE);
    const flaky = () => {
      const t0 = Date.now(); const area = chrome.storage.local; const orig = area.get.bind(area); let n = 0;
      area.get = (...a) => { n++; if (Date.now() - t0 < 1500) return n % 2 ? Promise.reject(new Error('Extension context invalidated.')) : new Promise(() => {}); return orig(...a); };
    };
    for (const page of ['dashboard.html', 'popup.html', 'options.html']) {
      const p = await ctx.newPage();
      await p.addInitScript(flaky);
      await p.goto(`chrome-extension://${id}/${page}`);
      if (page === 'dashboard.html') {
        await expect(p.locator('#managerBuild')).toHaveText(`Build ${version}`, { timeout: 1500 });
        await expect(p.locator('#title')).toHaveText('ACME', { timeout: 12000 });
        await expect(p.locator('#syncInfo')).toContainText('Last sync', { timeout: 2000 });
      } else {
        await p.waitForTimeout(6000);
        await expect(p.locator('body')).toBeVisible();
        if (page === 'options.html') await expect(p.locator('#apiBase')).toHaveValue(/simcompanies/);
      }
      await p.close();
    }

    // (c) Fresh install: page open before any game data exists, data written afterwards.
    await sw.evaluate(() => chrome.storage.local.remove(['activeRealmKey', 'selectedRealm', 'scmRealmStore:0']));
    const p = await ctx.newPage();
    await p.goto(`chrome-extension://${id}/dashboard.html`);
    await expect(p.locator('#managerBuild')).toHaveText(`Build ${version}`);
    await p.waitForTimeout(800);
    await sw.evaluate(s => chrome.storage.local.set({ 'scmRealmStore:0': s, activeRealmKey: 'realm:0', selectedRealm: 0 }), STORE);
    await expect(p.locator('#title')).toHaveText('ACME', { timeout: 8000 });
    await p.close();
  } finally {
    await ctx.close();
    fs.rmSync(userDir, { recursive: true, force: true });
  }
});
