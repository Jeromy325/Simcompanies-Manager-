import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const EXT = path.resolve(import.meta.dirname, '../..');

// Secrets must not reach content scripts, privileged triggers are extension-page-only,
// and the live bridge token lives in storage.session (migrated once from storage.local).
test('security: GET_STATE from content script has no secrets; bridge token is session-only', async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-e2e-sec-'));
  const opts = {
    channel: 'chromium', headless: true, viewport: { width: 360, height: 740 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  };
  if (process.env.PW_CHROMIUM_PATH) { opts.executablePath = process.env.PW_CHROMIUM_PATH; delete opts.channel; }
  const ctx = await chromium.launchPersistentContext(userDir, opts);
  try {
    await ctx.route(/simcotools|simconomist|example\.invalid/, r => r.abort());
    await ctx.route(/simcompanies\.com/, r => {
      if (r.request().url().includes('/api/')) return r.fulfill({ contentType: 'application/json', body: '{}' });
      return r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>SimCompanies</title></head><body>game</body></html>' });
    });
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    const id = sw.url().split('/')[2];

    // Legacy layout: token in storage.local. Migration moves it to storage.session.
    const ext = await ctx.newPage();
    await ext.goto(`chrome-extension://${id}/options.html`);
    await ext.waitForLoadState('load');
    await ext.evaluate(() => chrome.storage.local.set({ liveBridge: { enabled: false, url: 'https://example.invalid/b', token: 'legacy-secret', pushOnSync: false } }));
    await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'PUSH_LIVE_BRIDGE', realm: 0, force: true }));
    const migrated = await ext.evaluate(async () => ({
      local: (await chrome.storage.local.get('liveBridge')).liveBridge,
      session: (await chrome.storage.session.get('scmLiveBridgeToken')).scmLiveBridgeToken,
    }));
    expect(migrated.session).toBe('legacy-secret');
    expect(migrated.local.token).toBe('');
    expect(migrated.local.tokenSet).toBe(true);

    // SET_LIVE_BRIDGE stores the new token in session only.
    const set = await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'SET_LIVE_BRIDGE', enabled: false, url: 'https://example.invalid/b', token: 'tok-123', pushOnSync: false }));
    expect(set.ok).toBe(true);
    expect(set.liveBridge.token).toBe('');
    const after = await ext.evaluate(async () => ({ local: JSON.stringify(await chrome.storage.local.get(null)), session: (await chrome.storage.session.get('scmLiveBridgeToken')).scmLiveBridgeToken }));
    expect(after.session).toBe('tok-123');
    expect(after.local).not.toContain('tok-123');

    // Content-script (isolated world) context on the game page.
    const p = await ctx.newPage();
    const cdp = await ctx.newCDPSession(p);
    const worlds = [];
    cdp.on('Runtime.executionContextCreated', e => { if (e.context?.origin?.startsWith('chrome-extension://') || e.context?.auxData?.type === 'isolated') worlds.push(e.context.id); });
    await cdp.send('Runtime.enable');
    await p.goto('https://www.simcompanies.com/r1/');
    await p.waitForTimeout(2500);
    expect(worlds.length, 'content script isolated world found').toBeGreaterThan(0);
    const inCs = async expr => (await cdp.send('Runtime.evaluate', { expression: expr, contextId: worlds[worlds.length - 1], awaitPromise: true, returnByValue: true })).result.value;
    const csState = await inCs(`chrome.runtime.sendMessage({type:'GET_STATE'}).then(r=>JSON.stringify(r))`);
    expect(csState).not.toContain('tok-123');
    const parsed = JSON.parse(csState);
    expect(parsed.liveBridge?.token).toBeUndefined();
    expect(parsed.liveBridge?.hasToken).toBe(true);
    expect('authData' in parsed).toBe(false);
    for (const type of ['SYNC_NOW', 'RUN_ACCOUNTING_WALK_NOW', 'RUN_JAVASCRIPT_DIAGNOSTIC', 'LIVE_MARKET_REFRESH']) {
      const r = await inCs(`chrome.runtime.sendMessage({type:'${type}'})`);
      expect(r, type).toEqual({ ok: false, error: 'Not allowed from this context.' });
    }

    // Extension page still gets the full shape.
    const pageState = await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }));
    expect('authData' in pageState).toBe(true);

    // Lifecycle steps ran without errors and the standing alarms were created (persistAcrossSessions fallback works).
    const names = await ext.evaluate(async () => (await chrome.alarms.getAll()).map(a => a.name));
    expect(names).toContain('scm-production-events-watch');
    const log = await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_ERROR_LOG' }));
    expect((log.log || []).filter(e => /^lifecycle:/.test(e.context))).toEqual([]);
  } finally {
    await ctx.close();
    fs.rmSync(userDir, { recursive: true, force: true });
  }
});
