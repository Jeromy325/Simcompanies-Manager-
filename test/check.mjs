// Syntax-check every root *.js. ES modules (background.js and files using import/export) are checked as module input.
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
let fail = 0;
for (const f of readdirSync('.').filter(f => f.endsWith('.js')).sort()) {
  const src = readFileSync(f, 'utf8');
  const esm = f === 'background.js' || /^\s*(import|export)\s/m.test(src);
  const r = esm
    ? spawnSync(process.execPath, ['--input-type=module', '--check'], { input: src, encoding: 'utf8' })
    : spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { fail++; console.error(`FAIL ${f}\n${r.stderr}`); } else console.log(`ok   ${f}${esm ? ' (module)' : ''}`);
}
if (fail) { console.error(`${fail} file(s) failed`); process.exit(1); }
