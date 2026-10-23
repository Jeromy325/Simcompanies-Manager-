'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
function extractFunction(name) {
  const marker = source.includes(`async function ${name}(`) ? `async function ${name}(` : `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `background.js contains ${name}`);
  const bodyMarker = source.indexOf('){', start), open = bodyMarker + 1;
  let depth = 0, quote = null, escape = false, lineComment = false, blockComment = false;
  for (let i = open; i < source.length; i++) {
    const c = source[i], n = source[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i++; } continue; }
    if (quote) { if (escape) { escape = false; continue; } if (c === '\\') { escape = true; continue; } if ((quote === '`' && c === '`') || (quote !== '`' && c === quote)) quote = null; continue; }
    if (c === '/' && n === '/') { lineComment = true; i++; continue; }
    if (c === '/' && n === '*') { blockComment = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') depth++; else if (c === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not extract ${name}`);
}
const context = {
  Promise, Boolean, String, Map,
  validRealmNumber: v => v === 0 || v === 1 ? v : null,
  apiStorageQueues: new Map(), apiStorageCommitQueues: new Map(), apiStorageSchedulers: new Map()
};
vm.createContext(context);
for (const name of ['enqueueApiStorageCommit', 'enqueueApiStorage', 'runApiStorageScheduler']) vm.runInContext(extractFunction(name), context);
(async () => {
  const order = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const running = context.enqueueApiStorage(async () => { order.push('running'); await gate; }, 1, { url: '/api/running/' });
  await Promise.resolve();
  const passive = context.enqueueApiStorage(async () => { order.push('passive'); }, 1, { url: '/api/passive/' });
  const durable = context.enqueueApiStorage(async () => { order.push('durable'); }, 1, { priority: true, url: '/api/contracts-outgoing/' });
  release();
  await Promise.all([running, durable, passive]);
  assert.deepEqual(order, ['running', 'durable', 'passive'], 'durable sync writes jump queued unrelated passive writes');
  const orderSameUrl = [];
  let releaseSame;
  const gateSame = new Promise(resolve => { releaseSame = resolve; });
  const runningSame = context.enqueueApiStorage(async () => { orderSameUrl.push('running'); await gateSame; }, 1, { url: '/api/running-2/' });
  await Promise.resolve();
  const olderSame = context.enqueueApiStorage(async () => { orderSameUrl.push('older-same-url'); }, 1, { url: '/api/contracts-outgoing/' });
  const unrelated = context.enqueueApiStorage(async () => { orderSameUrl.push('unrelated'); }, 1, { url: '/api/unrelated-2/' });
  const newerSame = context.enqueueApiStorage(async () => { orderSameUrl.push('newer-same-url'); }, 1, { priority: true, url: '/api/contracts-outgoing/' });
  releaseSame();
  await Promise.all([runningSame, olderSame, unrelated, newerSame]);
  assert.deepEqual(orderSameUrl, ['running', 'older-same-url', 'newer-same-url', 'unrelated'], 'priority preserves FIFO for the same endpoint while skipping unrelated queued work');
  assert.match(source, /priority:Boolean\(durableOptions\),url:String\(url\|\|''\)/, 'only verified durable writes receive priority');
  assert.match(source, /lastSameUrl>=0\)insertAt=Math\.max\(insertAt,lastSameUrl\+1\)/, 'priority does not overtake an already queued same-URL write');
  assert.match(source, /queuedJobsAheadAtEnqueue/, 'queue profiling records jobs ahead of each write when enqueued');
  assert.match(source, /queuedJobsBehindAtStart/, 'queue profiling records backlog remaining when each write starts');
  assert.match(source, /onTiming\?\.\(\{queueWaitMs,queuedJobsAheadAtEnqueue,queuedJobsBehindAtStart/, 'queue depth accompanies queue wait and write timings');
  console.log('sync-write-priority: 7 assertions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
