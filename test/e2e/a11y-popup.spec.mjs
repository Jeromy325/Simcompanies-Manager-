import { test, expect, chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const EXT = path.resolve(import.meta.dirname, '../..');
let ctx, userDir, id;

test.beforeAll(async () => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-a11y-'));
  const opts = {
    channel: 'chromium', headless: true, viewport: { width: 360, height: 740 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  };
  if (process.env.PW_CHROMIUM_PATH) { opts.executablePath = process.env.PW_CHROMIUM_PATH; delete opts.channel; }
  ctx = await chromium.launchPersistentContext(userDir, opts);
  await ctx.route(/simcompanies\.com|simcotools|simconomist/, r => r.abort());
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  id = sw.url().split('/')[2];
});
test.afterAll(async () => { await ctx?.close(); fs.rmSync(userDir, { recursive: true, force: true }); });

// Accessibility smoke: fail only on 'critical'; 'serious' is reported in the output.
for (const page of ['popup.html', 'options.html', 'dashboard.html']) {
  test(`axe: no critical violations in ${page} at 360px`, async () => {
    const p = await ctx.newPage();
    await p.goto(`chrome-extension://${id}/${page}`);
    await p.waitForLoadState('load');
    await p.waitForTimeout(1000);
    const { violations } = await new AxeBuilder({ page: p }).analyze();
    const serious = violations.filter(v => v.impact === 'serious');
    if (serious.length) console.log(`[axe] ${page} serious: ` + serious.map(v => `${v.id}(${v.nodes.length})`).join(', '));
    const critical = violations.filter(v => v.impact === 'critical');
    expect(critical.map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`), `${page} critical`).toEqual([]);
    await p.close();
  });
}

// Popup must not throw when the background replies undefined, rejects, or returns an error.
for (const [label, impl] of [
  ['undefined', 'async () => undefined'],
  ['rejection', 'async () => { throw new Error("Receiving end does not exist") }'],
  ['error reply', 'async () => ({ ok: false, error: "boom" })'],
]) {
  test(`popup survives background reply: ${label}`, async () => {
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', e => errors.push(String(e)));
    await p.addInitScript(`chrome.runtime.sendMessage = ${impl};`);
    await p.goto(`chrome-extension://${id}/popup.html`);
    await expect(p.locator('#status')).toContainText(/Could not load data/);
    await p.click('#sync');
    await expect(p.locator('#status')).toContainText(/Could not load data|Sync failed|Receiving end|boom/);
    expect(errors).toEqual([]);
    await p.close();
  });
}
