'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
assert.match(background, /if\(m\?\.type==='NETWORK_CAPTURE_EVENT'\)[\s\S]*?enqueueNetworkCaptureWrite\(async\(\)=>/, 'diagnostic storage serialization is scoped to network capture events');
assert.match(background, /if\(m\?\.type==='API_SEEN'\)/, 'normal API/sync handlers remain present after diagnostic branch');
console.log('core-handlers-regression: diagnostic serialization and API handlers present');
