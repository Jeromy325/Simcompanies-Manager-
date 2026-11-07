import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const EXT = path.resolve(import.meta.dirname, '../..');

// Serves a fake simcompanies.com page so content.js + page-hook.js run, then checks
// the MessageChannel bridge handshake and that the fetch hook leaves responses intact.
test('game page: bridge handshake, fetch hook transparent, no extension errors', async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-e2e-'));
  const opts = {
    channel: 'chromium', headless: true, viewport: { width: 360, height: 740 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  };
  if (process.env.PW_CHROMIUM_PATH) { opts.executablePath = process.env.PW_CHROMIUM_PATH; delete opts.channel; }
  const ctx = await chromium.launchPersistentContext(userDir, opts);
  try {
    await ctx.route(/simcotools|simconomist/, r => r.abort());
    await ctx.route(/simcompanies\.com/, r => {
      const u = r.request().url();
      if (u.includes('/api/')) return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: 1, id: 42 }) });
      return r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>SimCompanies</title><script>window.__seen=[];addEventListener("message",e=>{if(e.data&&e.data.source==="SIMCO_MANAGER")window.__seen.push(e.data.type)})</script></head><body><div id="root">game</div></body></html>' });
    });
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', e => errors.push(String(e)));
    await p.goto('https://www.simcompanies.com/r1/');
    await p.waitForTimeout(3000);
    const seen = await p.evaluate(() => window.__seen.slice());
    expect(seen, 'content script handed a port to page-hook').toContain('PORT_HANDOFF');
    const body = await p.evaluate(() => fetch('/api/v2/test/').then(r => r.json()));
    expect(body).toEqual({ ok: 1, id: 42 });
    const xhr = await p.evaluate(() => new Promise(res => { const x = new XMLHttpRequest(); x.open('GET', '/api/v2/x/'); x.onload = () => res(JSON.parse(x.responseText)); x.send(); }));
    expect(xhr.id).toBe(42);
    expect(errors, 'uncaught page errors').toEqual([]);
  } finally {
    await ctx.close();
    fs.rmSync(userDir, { recursive: true, force: true });
  }
});
