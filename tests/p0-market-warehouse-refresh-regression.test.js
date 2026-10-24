'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const background=fs.readFileSync(path.join(root,'background.js'),'utf8');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));

assert.match(background,/const SIMCOTOOLS_PAIR_RATE_LIMIT_COOLDOWN_MS=5\*60\*1000/,
  'market pair cooldown has a conservative default');
assert.match(background,/rateLimitedUntilByPair\|\|\{\}/,
  'pair cooldown survives refreshes in the stored market price dataset');
assert.match(background,/Skipped during shared rate-limit cooldown/,
  'a still-rate-limited pair is skipped before a new API request');
assert.match(background,/failure\.status=429;failure\.rateLimited=true;failure\.retryAt=new Date\(until\)\.toISOString\(\)/,
  'rate-limited pairs expose cooldown status and retry time for diagnostics');
assert.match(background,/rateLimitedUntilByPair:\{\.\.\.pairCooldowns\}/,
  'cooldown state is persisted alongside current market data');
assert.match(background,/error\.status=resp\.status;error\.retryAt=resp\.retryAt\|\|null;error\.rateLimited=Boolean\(resp\.rateLimited\)/,
  'Retry-After metadata reaches the pair-level cooldown handler');
assert.match(background,/const warehouseOverlayRefreshRuns=new Map\(\)/,
  'warehouse refreshes share one in-flight operation per realm');
assert.match(background,/const existing=warehouseOverlayRefreshRuns\.get\(n\);if\(existing\)return existing/,
  'concurrent stock-mutation and overlay refresh triggers reuse the same request');
assert.match(background,/result\?\.ok&&result\?\.refreshed\)scheduleGameOverlayRefreshNotification\(n,\d+\)/,
  'successful stock mutation refresh notifies the game overlay after commit');
assert.equal(manifest.version, '2.5.358','package version is bumped for the P0 repair');
console.log('p0-market-warehouse-refresh-regression: 10 assertions passed');
