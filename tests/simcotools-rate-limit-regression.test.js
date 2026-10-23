'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
function extractFunction(source, name) {
  let marker = `async function ${name}(`;
  let start = source.indexOf(marker);
  if (start < 0) { marker = `function ${name}(`; start = source.indexOf(marker); }
  assert.notEqual(start, -1, `source contains ${name}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0, quote = null, escape = false, lineComment = false, blockComment = false;
  for (let i = braceStart; i < source.length; i++) {
    const c = source[i], n = source[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i++; } continue; }
    if (quote) { if (escape) { escape = false; continue; } if (c === '\\') { escape = true; continue; } if (c === quote) quote = null; continue; }
    if (c === '/' && n === '/') { lineComment = true; i++; continue; }
    if (c === '/' && n === '*') { blockComment = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not extract ${name}`);
}
assert.match(background, /if\(response\.status===429\)[\s\S]*?simcoActivateRateLimitCooldown\(response\)[\s\S]*?return \{ok:false,status:429,text,retryAt:[^}]+,rateLimited:true\}/,
  '429 response activates shared cooldown and returns without a per-request retry');
assert.match(background, /const SIMCOTOOLS_DEFAULT_RATE_LIMIT_COOLDOWN_MS=5\*60\*1000/);
assert.match(background, /const SIMCOTOOLS_MAX_CONCURRENT_REQUESTS=1/);
assert.match(background, /const SIMCOTOOLS_MIN_REQUEST_SPACING_MS=1200/);
assert.match(background, /async function hydrateSimcoCooldowns\(\)/, 'cooldowns survive service-worker restarts');
assert.match(background, /const existing=simcoRefreshRuns\.get\(realm\);[\s\S]*?if\(existing\)return existing/,
  'market requests use a single in-flight refresh per realm');
const constants = background.slice(background.indexOf('const SIMCOTOOLS_TIMEOUT_MS='), background.indexOf('const SYNC_PAGE_API_TIMEOUT_MS='));
const helpers = ['hydrateSimcoCooldowns','persistSimcoCooldowns','simcoRetryAfterMs','simcoActivateRateLimitCooldown','simcoWaitForRateLimitCooldown','simcoAcquireRequestSlot','simcoReleaseRequestSlot','simcoFetch'].map(name => extractFunction(background, name)).join('\n');
let calls = 0;
const ctx = {
  Date, Math, AbortController,
  setTimeout, clearTimeout,
  chrome: { storage: { local: { get: async defaults => defaults, set: async () => {} } } },
  fetch: async () => { calls++; return { status: 429, ok: false, headers: { get: name => name.toLowerCase() === 'retry-after' ? '0' : null }, text: async () => 'rate limit exceeded' }; },
};
vm.createContext(ctx);
vm.runInContext(`${constants}\n${helpers}`, ctx);
(async () => {
  const result = await ctx.simcoFetch('https://api.simcotools.com/test');
  assert.equal(result.status, 429);
  assert.equal(result.rateLimited, true);
  assert.equal(calls, 1, 'a 429 request is not retried');
  assert.equal(typeof result.retryAt, 'string', 'cooldown deadline is returned for diagnostics');
  assert.ok(Date.parse(result.retryAt) >= Date.now() + 4 * 60 * 1000, 'even Retry-After: 0 enforces a five-minute minimum cooldown');
  console.log('simcotools-rate-limit-regression: 10 assertions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
