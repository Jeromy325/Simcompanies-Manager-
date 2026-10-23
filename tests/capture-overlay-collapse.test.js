'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const content=fs.readFileSync(path.join(root,'content.js'),'utf8');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
assert.equal(manifest.version,'2.5.339');
assert.match(content,/data-capture-toggle/,'capture overlay has an explicit toggle control');
assert.match(content,/Collapse network capture status/,'expanded state has accessible collapse label');
assert.match(content,/Expand network capture status/,'collapsed state has accessible expand label');
assert.match(content,/scmCaptureOverlayCollapsed = !scmCaptureOverlayCollapsed/,'toggle changes collapsed state');
assert.match(content,/Captured: \$\{events\.toLocaleString\(\)\} events/,'expanded card shows event count');
assert.match(content,/Capture · \$\{events\.toLocaleString\(\)\}/,'collapsed card retains a live event count');
assert.match(content,/count\.style\.display = scmCaptureOverlayCollapsed \? 'none' : 'block'/,'collapse hides detail rows');
assert.match(content,/detail\.style\.display = scmCaptureOverlayCollapsed \? 'none' : 'block'/,'collapse hides request/error details');
console.log('capture-overlay-collapse: 9 assertions passed');

assert.match(content,/scm-game-balance-card/,'capture overlay anchors below Stock After Demand & Contracts by default');
assert.match(content,/pointerdown/,'capture overlay can be dragged by its header');
assert.match(content,/scmMobileCaptureOverlayPositionV1/,'drag position persists across reloads');
assert.match(content,/min\(136px,calc\(100vw - 8px\)\)/,'collapsed capture card is compact on mobile');
assert.match(content,/touch-action:none/,'drag handle supports touch pointer input');

assert.match(content,/scmMobileCaptureOverlayCollapsedV1/,'expanded/collapsed preference persists across page reloads');
assert.match(content,/saveCaptureOverlayCollapsed\(scmCaptureOverlayCollapsed\)/,'toggle persists its state');
assert.match(content,/restoreMobileCaptureOverlay\(\)/,'active capture overlay restores on content-script startup');
assert.match(content,/mobile-resume-\$\{Date\.now\(\)\}/,'mobile recorder resumes after page-hook reload');
