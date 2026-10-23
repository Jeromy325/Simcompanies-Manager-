'use strict';
// Guards against ReferenceErrors that syntax checks and string-match tests miss.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const content=read('content.js'), dashboard=read('dashboard.js'), background=read('background.js');

// 1. content.js: REFRESH_GAME_OVERLAY must be handled in the same top-level IIFE that declares load().
const lines=content.split('\n');
const blocks=[];let start=null;
lines.forEach((l,i)=>{if(/^\(\(\)\s*=>\s*\{/.test(l))start=i;else if(/^\}\)\(\);/.test(l)&&start!=null){blocks.push(lines.slice(start,i+1).join('\n'));start=null;}});
const handlers=blocks.filter(b=>b.includes("'REFRESH_GAME_OVERLAY'")&&/\bload\(/.test(b));
assert.ok(handlers.length>=1,'REFRESH_GAME_OVERLAY handler exists');
for(const b of handlers) assert.match(b,/const load=async/,'REFRESH_GAME_OVERLAY handler must live in the scope that defines load()');

// 2. dashboard.js: refresh guards must be declared (reading an undeclared variable throws).
for(const name of ['accountingRefreshPending','accountingWeekLedgerRefreshPending','accountingWeekLedgerRetryCount','accountingWeekLedgerRetryTimer'])
  assert.match(dashboard,new RegExp(`^let ${name}\\b`,'m'),`${name} is declared`);

// 3. background.js: no calls to the removed helper.
assert.doesNotMatch(background,/warehouseRowsForVwap/,'undefined warehouseRowsForVwap helper is not referenced');
console.log('runtime-scope-regression: all assertions passed');
