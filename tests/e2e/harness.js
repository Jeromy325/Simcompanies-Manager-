// SCM E2E harness (Playwright persistent Chromium with the unpacked extension). Reused by tests/e2e/*.e2e.js.
const { chromium } = require('playwright');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';
const EXT = path.resolve(__dirname, '..', '..');
async function launch({ ext = EXT, viewport = { width: 360, height: 780 }, mobile = true, dir } = {}) {
  dir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'scm-e2e-'));
  const ctx = await chromium.launchPersistentContext(dir, { headless: false, viewport, isMobile: mobile, hasTouch: mobile,
    args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
  ctx._dir = dir; return ctx;
}
async function worker(ctx) { return ctx.serviceWorkers()[0] || ctx.waitForEvent('serviceworker', { timeout: 15000 }); }
async function seed(ctx, { realm = 1, store = {}, extra = {} } = {}) {
  const sw = await worker(ctx);
  await sw.evaluate(async ({ realm, store, extra }) => {
    await chrome.storage.local.set({ activeRealmKey: `realm:${realm}`, selectedRealm: String(realm), realmIsolationSchemaVersion: 13, scmRealmStoreSchema: 1, [`scmRealmStore:${realm}`]: store, ...extra });
  }, { realm, store, extra });
}
// html: page body; api: {path: json}; delays: {path: ms}
async function fakeGame(ctx, { html = '<div id="root"></div>', api = {}, delays = {}, realm = 1, companyId = 5294950 } = {}) {
  const auth = { authCompany: { realmId: realm, companyId, company: 'Hewitt Corporation' } };
  await ctx.route('https://www.simcompanies.com/**', async route => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith('/api/')) {
      const p = u.pathname; if (delays[p]) await new Promise(r => setTimeout(r, delays[p]));
      const body = p === '/api/v3/companies/auth-data/' ? auth : api[p];
      return route.fulfill({ status: body === undefined ? 404 : 200, contentType: 'application/json', body: JSON.stringify(body ?? {}) });
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><script>window.reactjs={props:{}};</script></head><body style="background:#222;color:#eee;font-family:sans-serif;margin:0">${html}<script>fetch('/api/v3/companies/auth-data/');${Object.keys(api).map(p => `fetch(${JSON.stringify(p)});`).join('')}</script></body></html>` });
  });
}
async function fakeSimcoTools(ctx, dir) {
  await ctx.route('https://api.simcotools.com/**', route => {
    const f = dir && path.join(dir, new URL(route.request().url()).pathname.replace(/\W+/g, '_') + '.json');
    return f && fs.existsSync(f) ? route.fulfill({ status: 200, contentType: 'application/json', body: fs.readFileSync(f, 'utf8') }) : route.fulfill({ status: 404, body: '{}' });
  });
}
async function fireAlarm(page, name) { await page.evaluate(n => chrome.alarms.create(n, { when: Date.now() + 300 }), name); }
async function storeKeys(ctx, realm) { const sw = await worker(ctx); return sw.evaluate(async r => Object.keys((await chrome.storage.local.get(`scmRealmStore:${r}`))[`scmRealmStore:${r}`] || {}).length, realm); }
async function shot(page, name) { fs.mkdirSync('/tmp/e2e', { recursive: true }); const f = `/tmp/e2e/${name}.png`; await page.screenshot({ path: f }); return f; }
let fails = 0, passes = 0;
function check(what, ok, expected, got) { ok ? passes++ : fails++; console.log(`${ok ? 'PASS' : 'FAIL'} ${what} expected=${expected} got=${got}`); }
function done() { console.log(`${passes}/${passes + fails} passed`); process.exitCode = fails ? 1 : 0; }
module.exports = { launch, worker, seed, fakeGame, fakeSimcoTools, fireAlarm, storeKeys, shot, check, done, EXT };
