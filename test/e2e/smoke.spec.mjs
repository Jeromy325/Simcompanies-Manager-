import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const EXT = path.resolve(import.meta.dirname, '../..');

test('extension loads offline; pages render without errors at 360px', async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-e2e-'));
  const opts = {
    channel: 'chromium', headless: true, viewport: { width: 360, height: 740 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  };
  if (process.env.PW_CHROMIUM_PATH) { opts.executablePath = process.env.PW_CHROMIUM_PATH; delete opts.channel; }
  const ctx = await chromium.launchPersistentContext(userDir, opts);
  try {
    // Offline: never touch the game or third-party price sources.
    await ctx.route(/simcompanies\.com|simcotools|simconomist/, r => r.abort());
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    expect(sw.url()).toMatch(/^chrome-extension:\/\/[a-p]{32}\/background\.js$/);
    const id = sw.url().split('/')[2];

    for (const page of ['popup.html', 'dashboard.html', 'options.html']) {
      const p = await ctx.newPage();
      const errors = [];
      p.on('pageerror', e => errors.push(String(e)));
      await p.goto(`chrome-extension://${id}/${page}`);
      await p.waitForLoadState('load');
      await p.waitForTimeout(1500);
      await expect(p.locator('body')).toBeAttached();
      expect(errors, `${page} uncaught errors`).toEqual([]);
      await p.close();
    }
  } finally {
    await ctx.close();
    fs.rmSync(userDir, { recursive: true, force: true });
  }
});
