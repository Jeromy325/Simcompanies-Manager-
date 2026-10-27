// 2.5.345: fixes from the 2.5.344 E2E audit (claude/SCM-Audit-2.5.344.md).
// Fixture = the game's real public constants fetched 2026-10-23, trimmed.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const C = require('../tools-core.js');
require('../planner-core.js'); const P = globalThis.SCMPlannerCore;
const manifest = JSON.parse(read('manifest.json'));
assert.equal(manifest.version, '2.5.395');
const bg = read('background.js'), dash = read('dashboard.js'), hook = read('page-hook.js'), content = read('content.js');
const fx = JSON.parse(read('tests/fixtures/game-constants-recipes-2026-10-23.json'));
const gc = { core: fx.core, buildings: fx.buildings, resources: fx.resources, at: '2026-10-23T20:00:00Z' };
const slice = (src, start, end) => { const a = src.indexOf(start); const b = src.indexOf(end, a + 1); assert.ok(a >= 0 && b > a, start); return src.slice(a, b + end.length); };
const near = (a, b, t, m) => assert.ok(Math.abs(a - b) <= t, `${m}: ${a} vs ${b}`);

// 1. Realm: page responses with no realm are held until auth-data names the session's realm.
{
  const src = slice(hook, 'const realmPending = [];', 'realmPending.push({ type, payload });\n  };');
  const ctx = { out: [], sessionStorage: { removeItem() {} }, lastKnownRealm: null, forcedCaptureRealm: 1, forcedCaptureRealmUntil: Date.now() + 60000 };
  vm.createContext(ctx);
  vm.runInContext(`var lastKnownRealm=null,forcedCaptureRealm=1,forcedCaptureRealmUntil=Date.now()+60000;const emit=(t,p)=>out.push([t,p]);${src}\nthis.learnRealm=learnRealm;this.emitRealmScoped=emitRealmScoped;this.st=()=>({lastKnownRealm,forcedCaptureRealm});`, ctx);
  ctx.emitRealmScoped('API_DATA', { url: '/api/v2/companies/me/buildings/', data: [{ id: 7001 }], captureRealm: null });
  ctx.emitRealmScoped('STOCK_MUTATION_COMPLETE', { url: '/api/v2/companies/buildings/1/collect/', captureRealm: null });
  ctx.emitRealmScoped('API_DATA', { url: '/api/v3/market/1/112/', data: [], captureRealm: 1 });
  assert.equal(ctx.out.length, 1, 'realm-tagged response passes, untagged ones are held');
  ctx.learnRealm(0, 'auth-data');
  assert.deepEqual(ctx.out.map(x => x[0]), ['API_DATA', 'PAGE_REALM', 'API_DATA', 'STOCK_MUTATION_COMPLETE']);
  assert.ok(ctx.out.slice(2).every(x => x[1].captureRealm === 0), 'held responses sent with the auth-data realm');
  assert.equal(ctx.st().forcedCaptureRealm, null, 'a Sync boundary for the other realm is dropped');
  ctx.emitRealmScoped('API_DATA', { url: '/api/v2/companies/me/buildings/', captureRealm: null });
  assert.equal(ctx.out[ctx.out.length - 1][1].captureRealm, 0, 'after the realm is known, late answers get it');
}
assert.ok(/learnRealm\(ar, 'auth-data'\)/.test(hook) && /realmPending\.length=0/.test(hook), 'auth-data teaches the realm; a switch drops held responses');
assert.ok(hook.includes("source:'switch'") && hook.includes("emit('PAGE_REALM', { realm: startupSwitchRealm"), 'reload after a switch knows its realm at once');
assert.ok(content.includes("d.type === 'PAGE_REALM'") && content.includes('if(actualPageRealm==null){'), 'overlay waits for the tab realm');
{
  const wait = slice(content, 'if(actualPageRealm==null){', 'return;\n    }');
  assert.ok(!/GET_GAME_OVERLAY_DATA/.test(wait), 'unknown realm: no overlay request');
}
assert.ok(content.includes("type:'GET_VWAP_OVERLAY_DATA',resourceId:hintedRid,realm:tabRealm") && content.includes("type:'GET_INCOMING_CONTRACT_VWAP_DATA',realm:tabRealm"), 'badges use the tab realm');
{
  const stale = slice(content, 'if(overrideRealm!=null && actualPageRealm!=null && overrideRealm!==actualPageRealm){', 'setTimeout(()=>load(actualPageRealm),0);');
  assert.ok(!/writeCollapsedPreference\(true\)/.test(stale), "the other realm's refresh no longer collapses the card");
}
{
  const g = slice(bg, '// v2.5.345 a game response with no realm tag', 'const targetRealm=');
  assert.ok(/appendRealmQuarantine\(null/.test(g) && g.indexOf('return;') > 0, 'untagged unproven capture is quarantined, never filed under the active realm');
}
// pageGet refuses a /me/ answer from the other realm's tab (auth-data exempt).
const pageGetSrc = slice(bg, 'const PAGE_GET_BACKGROUND_GRACE_MS', "throw new Error(lastError?.message||'Sim Companies page bridge is not connected.');\n}");
const pgSandbox = reply => {
  const sent = [];
  const ctx = { SYNC_PAGE_API_TIMEOUT_MS: 45000, SYNC_PAGE_API_ATTEMPTS: 1, setTimeout, clearTimeout, Promise, Date, Number, Error, String, Map,
    simTab: async () => ({ id: 7 }), waitForBridge: async () => true,
    validRealmNumber: v => (v === null || v === undefined || v === '' ? null : ([0, 1].includes(Number(v)) ? Number(v) : null)), realmDisplayNumber: r => `R${Number(r) + 1}`,
    chrome: { tabs: { sendMessage: async (id, msg) => { sent.push(msg); return reply; } } } };
  vm.createContext(ctx); vm.runInContext(pageGetSrc + '\nthis.pageGet=pageGet;', ctx); return { ctx, sent };
};
(async () => {
  {
    const { ctx, sent } = pgSandbox({ ok: true, status: 200, data: [], captureRealm: 0 });
    const r = await ctx.pageGet('/api/v3/contracts-outgoing/me/', 1);
    assert.equal(r.ok, false); assert.equal(r.realmMismatch, true);
    assert.equal(sent[0].timeoutMs, 45000, 'Sync reads tell the page 45 s');
    assert.equal((await ctx.pageGet('/api/v3/companies/auth-data/', 1)).ok, true, 'auth-data exempt (Sync explains the mismatch)');
    assert.equal((await ctx.pageGet('/api/v3/contracts-outgoing/me/', 0)).ok, true, 'same realm passes');
  }
  {
    const { ctx } = pgSandbox({ ok: true, status: 200, data: [], captureRealm: null });
    assert.equal((await ctx.pageGet('/api/v2/companies/me/balance-sheet/', 1)).realmUnknown, true, '/me/ answer from a tab of unknown realm refused');
    assert.equal((await ctx.pageGet('/api/v3/resources/5294950/', 1)).ok, true, 'company-id URL is fine');
  }
  console.log('v345-regression async ok');
})().catch(e => { console.error(e); process.exit(1); });

// 1b. Realm store writers read the realm they write (state() holds only the active realm; after a realm switch
// {...undefined} + one field replaced the other realm's whole store — reproduced: R2 60 keys → 0 by the image sync).
{
  const bad = [];
  for (const m of bg.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await state\(\)/g)) {
    const seg = bg.slice(m.index + m[0].length, m.index + m[0].length + 1500);
    if (seg.includes(`{...(${m[1]}.realmStores||{})}`)) bad.push(bg.slice(0, m.index).split('\n').length);
  }
  assert.deepEqual(bad, [], `active-only state() copied into a realm-store write at lines ${bad.join(',')}`);
  // 2.5.361: the image cache no longer writes the realm store at all (saveResourceImages writes only scmResourceImages)
  assert.ok(bg.includes('async function saveResourceImages(') && !/fetchAndCacheResourceImage[\s\S]{0,4000}withRealmWriteLock\(writeRealm/.test(bg) && bg.includes('const finalPersist=await state(selected);'));
}

// 2. Sync timeouts.
assert.ok(bg.includes('const SYNC_PAGE_API_TIMEOUT_MS=45000;') && bg.includes('const SYNC_PAGE_API_ATTEMPTS=1;'));
assert.ok(bg.includes("chrome.tabs.sendMessage(tab.id,{type:'PAGE_API_GET',path,realm:targetRealm,timeoutMs})"));
assert.ok(hook.includes('Math.min(requestedTimeout, 60000) : 8000'));

// 3. Speed bonus divides everywhere (game: rate = base × event ÷ (1 − bonus)); frozen plans carry the formula.
assert.ok(!/\(1\+companyModifier\/100\)/.test(bg) && !/\(1\+companyModifier\/100\)/.test(dash), 'no ×(1+bonus) left');
assert.ok(bg.includes("const OVERLAY_SPEED_FORMULA='game-divide';") && dash.includes("speedFormula:'game-divide'"));
{
  const e = [{ buildingId: 1, product: 'Steel', productId: 43, quality: 2, plannedLevel: 3, baseRatePerLevel: 192.5 }];
  assert.notEqual(P.frozenPlanSignature(e, 24, { companyProductionModifier: 8 }), P.frozenPlanSignature(e, 24, { companyProductionModifier: 8, speedFormula: 'game-divide' }), 'old plans are rebuilt');
  // Steel Q2 per 24 h at L4 Bulldozer, +8%: game 2,329.21; old ×1.08 path gave 2,314.30 (audit).
  const base = C.gameBaseRate(gc, 112, 1), perHour = base * 4 / (1 - 0.08), steel24 = perHour * 4 * 24;
  near(steel24, 2329.211, 0.01, 'Steel demand 24 h');
  near(base * 4 * 1.08 * 0.92 / (1 - 0.08) * 4 * 24, 2314.30, 0.02, 'old formula reproduces the audit figure');
}

// 4. Recipes from the game's constants; bundled recipes.json matches them.
{
  const bundled = JSON.parse(read('recipes.json'));
  const rec = C.recipesFromGameConstants(bundled, gc);
  const by = id => rec.find(r => r.id === id);
  assert.deepEqual(by(13).materials, [{ id: 1, quantity: 0.01 }, { id: 12, quantity: 0.005 }], 'Transport');
  assert.equal(by(120).transport, 0.2, 'Vegetables transport');
  assert.deepEqual(by(150).materials, [{ id: 2, quantity: 12 }], 'Tree');
  for (const id of [13, 120, 150]) { const b = bundled.find(r => r.id === id), g = by(id); assert.deepEqual(b.materials, g.materials, `bundled ${id}`); assert.equal(b.transport, g.transport, `bundled ${id} transport`); }
  assert.equal(C.recipesFromGameConstants(bundled, null), bundled, 'no constants → bundled');
  assert.ok(bg.includes('const recipes=await gameRecipesFromBundle(bundledRecipes);') && bg.includes('list=await gameRecipesFromBundle('), 'overlay + alerts use them');
  assert.ok(dash.includes('C.recipesFromGameConstants(raw.recipes,gc)'), 'Production uses them');
  // 9. buildings from constants: research labs and Cream egg
  const defs = JSON.parse(read('buildings.json'));
  const b = C.buildingsFromGameConstants(defs, rec, gc);
  const lab = b.find(d => d.id === 'p'); assert.ok(lab && lab.category === 'Research' && lab.produces.includes('Plant research'), 'research building added');
  assert.ok(b.find(d => d.id === 'k').produces.includes('Cream egg'), 'Cream egg at Food Processing Plant');
  assert.ok(b.find(d => d.id === '1').produces.length >= defs.find(d => d.id === '1').produces.length, 'nothing dropped');
}

// 5. Background fallback rate from constants; bundled file corrected.
{
  const fn = slice(bg, 'function overlayGameBaseRate(store,constants,resourceId,buildingId){', '  }catch{return null;}\n}');
  const ctx = { globalThis: { SCM_TOOLS_CORE: C }, Number, String };
  vm.createContext(ctx); vm.runInContext(fn + '\nthis.f=overlayGameBaseRate;', ctx);
  near(ctx.f({ authData: { temporals: { economyState: 1 } } }, gc, 7, 1), 25.669447221102295, 1e-9, 'Steak normal (game)');
  near(ctx.f({ authData: { temporals: { economyState: 0 } } }, gc, 112, 1), 14 * Math.pow(345 / 655, 1.3), 1e-9, 'recession phase');
  near(ctx.f({ authData: { temporals: { economyState: 1 } }, endpointData: { '/api/v2/companies/buildings/9/abundance/': { data: { abundance: { 7: 50 } } } } }, gc, 7, 9), 25.669447221102295 / 2, 1e-9, 'abundance applied');
  assert.equal(ctx.f({}, gc, 7, 1), null, 'no phase → null');
  const rates = JSON.parse(read('production_rates_normal.json'));
  near(rates.Steak, 25.669447221102295, 1e-9, 'bundled Steak'); near(rates.Sausages, C.gameBaseRate(gc, 8, 1), 1e-9, 'bundled Sausages');
  assert.ok(rates.Dress > 0 && !('Dresses' in rates), 'Dress key');
}

// 6. Construction: game formula perCostUnit × costUnits × level.
{
  const ext = name => { const a = dash.indexOf(`function ${name}(`); assert.ok(a >= 0, name); let i = dash.indexOf('{', dash.indexOf(')', a)), d = 0; for (; i < dash.length; i++) { if (dash[i] === '{') d++; else if (dash[i] === '}' && --d === 0) break; } return dash.slice(a, i + 1); };
  const arr = slice(dash, 'const CONSTRUCTION_MATERIALS=[', '];');
  const ctx = { Map, Number, Math, String, Array, Object, globalThis: {}, warehouseRows: () => [], exactMarketPrice: () => 100, buildMarketPriceMap: () => new Map() };
  vm.createContext(ctx);
  vm.runInContext([ext('roundCurrencyUp'), ext('roundResourceDown'), arr, ext('constructionWarehouseStock'), ext('constructionCostUnits'), ext('constructionMaterialPlan')].join('\n') + '\nthis.plan=constructionMaterialPlan;', ctx);
  const s = { gameConstants: { buildings: { 1: { costUnits: 27 } } } };
  const p = ctx.plan(s, { raw: { kind: '1', cost: 1 } }, 4, 5, 0, new Map());
  const q = id => p.items.find(x => x.id === id).required;
  assert.deepEqual([q(101), q(102), q(108), q(111)], [4 * 27 * 4, 55 * 27 * 4, 16 * 27 * 4, 27 * 4], 'Car factory L4→5');
  assert.equal(p.source, 'game-constants');
  const p2 = ctx.plan(s, { raw: { kind: '1' } }, 4, 6, 0, new Map());
  assert.equal(p2.items.find(x => x.id === 101).required, 4 * 27 * (4 + 5), 'two steps');
  const p3 = ctx.plan({}, { raw: { cost: 65550 } }, 12, 13, 0, new Map());
  assert.equal(p3.items.find(x => x.id === 101).required, 912, 'old estimate kept when constants are missing');
  assert.ok(dash.includes('mat.perCostUnit*costUnits*Number(plan.stepFactor||0)'), 'upgrade view uses the same formula');
}

// 7. No stale version_name.
assert.ok(!manifest.version_name || String(manifest.version_name).startsWith(manifest.version), 'version_name matches version');

// 8. Alerts "Next" names come from the background.
assert.ok(bg.includes('buildingName:b?.name?String(b.name):null') && dash.includes("a.buildingName||b?.name||'Building '+bid"));

// 10. Missing company id → skipped, no backoff.
{
  const src = slice(bg, 'function noteWarehouseOverlayRefreshResult(', '\n}');
  const ctx = { warehouseOverlayBackoffUntil: new Map(), WAREHOUSE_OVERLAY_FAILURE_BACKOFF_MS: 60000, Number, Date };
  vm.createContext(ctx); vm.runInContext(src + '\nthis.note=noteWarehouseOverlayRefreshResult;', ctx);
  ctx.note(1, 12000, { ok: false, notReady: true });
  assert.equal(ctx.warehouseOverlayBackoffUntil.size, 0, 'no backoff for not-ready');
  assert.ok(bg.includes("(result?.notReady?'skipped':"));
}

// 11. Update keeps user/production alarms.
{
  const inst = slice(bg, 'chrome.runtime.onInstalled.addListener(async()=>{', '\n});\nchrome.runtime.onStartup');
  assert.ok(!/clearAll\(\)/.test(inst), 'no clearAll on update');
  assert.ok(inst.includes("await restorePersistedAlarms('installed')") && bg.includes("await restorePersistedAlarms('browser-startup')"), 'alarms re-created after update / browser start');
  const fn = slice(bg, "async function restorePersistedAlarms(reason='restore'){", '  return out;\n}');
  const made = [], have = new Set(['scm-building-1-5']);
  const store1 = { buildingAlarms: { 9001: { buildingId: 9001, readyAt: Date.now() + 3600e3 }, 5: { buildingId: 5, readyAt: Date.now() + 3600e3 }, 7: { buildingId: 7, readyAt: Date.now() - 1000 } }, buildings: [{ id: 9001 }] };
  const ctx = { Number, Object, Array, Date, String,
    scheduleProductionFinishAlarms: async (n, b) => ({ realm: n, buildings: b.length }),
    chrome: { storage: { local: { get: async q => { const k = Object.keys(q)[0]; return { [k]: k === 'scmRealmStore:1' ? store1 : null }; } } },
      alarms: { get: async n => (have.has(n) ? { name: n } : undefined), create: async (n, o) => { made.push([n, o.when > Date.now()]); } } } };
  vm.createContext(ctx); vm.runInContext(fn + '\nthis.restore=restorePersistedAlarms;', ctx);
  ctx.restore('test').then(r => {
    assert.deepEqual(made, [['scm-building-1-9001', true]], 'missing future reminder re-created; existing and past ones not');
    assert.equal(r.production.length, 1, 'batch alarms rescheduled from stored buildings');
    console.log('v345-regression alarms ok');
  }).catch(e => { console.error(e); process.exit(1); });
  assert.ok(bg.includes("const INSTALL_KEEP_ALARM_PREFIXES=['scm-building-','scm-prodfin:','scm-followup:','scm-daily-summary',GAME_CONSTANTS_ALARM,ACCOUNTING_WEEK_REFRESH_ALARM_PREFIX,ACCOUNTING_DAY_WALK_ALARM_PREFIX,ACCOUNTING_WALK_DAILY_ALARM];"));
}
console.log('v345-regression ok');
