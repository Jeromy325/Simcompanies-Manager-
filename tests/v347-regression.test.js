// 2.5.347: saved contract injected the wrong price on the Electronic components contract page (user screenshot
// 2026-10-23: Chemi Kitties, price 8.15, amount 768.395…), and the exchange Sell page gets a Left/Surplus helper.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const content = read('content.js'), background = read('background.js');
assert.equal(JSON.parse(read('manifest.json')).version, '2.5.390');

// Run the real matcher. The page lists exchange sellers ("PATO SILICON AND METALS"), so a saved Silicon contract
// for the same company matched the Electronic components page by page text and injected its price.
const slice = (from, to) => { const a = content.indexOf(from), b = content.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return content.slice(a, b); };
const ctxSrc = slice('  const matchSavedContract=', '  const fillContractForm=');
const qtySrc = slice('  const desiredContractQty=', '  const loadContractHelper=');
const sandbox = { S: { contractQtyMode: 'saved' }, norm: v => String(v ?? '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '').replace(/s$/, '') };
vm.runInNewContext(`${ctxSrc}\n${qtySrc}\nthis.matchSavedContract=matchSavedContract;this.desiredContractQty=desiredContractQty;`, sandbox);
const saved = [
  { id: 'si', company: 'Chemi Kitties', product: '16:1', productId: 16, productName: 'Silicon', quality: 1, price: 8.15, quantityMode: 'left', left: 768.3953 },
  { id: 'ec', company: 'Chemi Kitties', product: '21:2', productId: 21, productName: 'Electronic components', quality: 2, price: 55, quantityMode: 'custom', quantity: 569 }
];
const body = 'ELECTRONIC COMPONENTS\n5,760 units\nRECIPIENT\nChemi Kitties\nChange\nAMOUNT\nPRICE PER UNIT\nCurrent exchange orders for Q2+\nPATO SILICON AND METALS\nAPEX 97';
const oldCtx = { recipient: 'Chemi Kitties', product: '', body, quality: null };
assert.equal(sandbox.matchSavedContract(oldCtx, saved).id, 'si', 'reproduces the bug when the page resource is unknown');
const pageCtx = { ...oldCtx, productId: 21, quality: 2 };
const hit = sandbox.matchSavedContract(pageCtx, saved);
assert.equal(hit.id, 'ec'); assert.equal(hit.price, 55);
assert.equal(sandbox.matchSavedContract({ ...pageCtx, productId: 43 }, saved), null, 'no saved contract for the page resource → no injection');
assert.equal(sandbox.matchSavedContract({ ...pageCtx, recipient: 'Apex 97' }, saved), null, 'other recipient → no injection');
// Prefer the saved contract with the page quality when the same company has several qualities.
const twoQ = [{ ...saved[1], id: 'q3', quality: 3, price: 57 }, saved[1]];
assert.equal(sandbox.matchSavedContract(pageCtx, twoQ).id, 'ec');

// Amounts are whole units (game Amount box is step 1).
assert.equal(sandbox.desiredContractQty(saved[0]), 768);
assert.equal(sandbox.desiredContractQty({ quantityMode: 'surplus', surplus: 12.9 }), 12);
assert.equal(sandbox.desiredContractQty(saved[1]), 569);

// Page resource comes from the game's header encyclopedia link, quality from "exchange orders for Q<q>+" or stars.
const wpr = slice('  const warehousePageResource=', '  const detectContractContext=');
assert.match(wpr, /\/headquarters\\\/warehouse\\\/\[\^\/\]\+\\\/\(sell\|contract\)/);
assert.match(wpr, /a\[href\*="\/encyclopedia\/"\]\[href\*="\/resource\/"\]/);
assert.match(wpr, /exchange orders for Q\(\\d\+\)\\\+/);
assert.match(content, /productId:pageResource\?\.id\?\?null/);
// Run it on a fake page: header link + stars, with and without the "Current exchange orders for Q<q>+" line.
const runWpr = (pathname, bodyText, starCount, lead = '') => {
  const holder = { textContent: lead }; const stars = Array.from({ length: starCount }, () => ({ parentElement: holder }));
  const block = { querySelectorAll: sel => sel === 'svg[data-icon="star"]' ? stars : [] };
  const link = { getAttribute: () => '/encyclopedia/1/resource/21/', querySelector: () => ({ getAttribute: () => 'Electronic components' }), parentElement: { parentElement: block } };
  const doc = { body: { innerText: bodyText }, querySelectorAll: () => [link] };
  return vm.runInNewContext(`${wpr};warehousePageResource()`, { document: doc, location: { pathname } });
};
assert.deepEqual({ ...runWpr('/headquarters/warehouse/electronic-components/contract/', 'Current exchange orders for Q2+', 3) }, { id: 21, quality: 2, name: 'Electronic components', tab: 'contract' });
assert.equal(runWpr('/headquarters/warehouse/electronic-components/sell/', 'All exchange orders', 3).quality, 3, 'stars fallback');
assert.equal(runWpr('/headquarters/warehouse/electronic-components/sell/', '', 1, '7 ').quality, 7, 'Q above 5 shows "7 ★"');
assert.equal(runWpr('/headquarters/warehouse/electronic-components/sell/', '', 0).quality, null, 'unknown quality is not guessed');
assert.equal(runWpr('/headquarters/warehouse/', 'Current exchange orders for Q2+', 2), null, 'only the sell/contract pages');

// Sell helper: Left = overlay row Left, Surplus = overlay row production surplus; draggable, closable, no inline handlers.
assert.match(background, /const surplus=Math\.max\(0,Number\(productionSurplusByKey\.get\(key\)\)\|\|0\);\n\s*return \{\.\.\.r,[^}]*warehouseOnlyLeft:left,surplus,/);
const sell = slice("  const SELL_POS_KEY='scmSellQtyCardPos';", '  const cleanupStaleOverlays=');
assert.match(sell, /input\[name="amount"\]/); assert.match(sell, /input\[name="price"\]/);
assert.match(sell, /data-sq-fill="\$\{kind\}"/); assert.match(sell, /data-sq-close/); assert.match(sell, /onpointerdown/);
assert.match(sell, /localStorage\.setItem\(SELL_POS_KEY/);
assert.doesNotMatch(sell, /\son[a-z]+="/, 'no inline event handlers');
const sq = vm.runInNewContext(`(()=>{const S={data:{realm:1,rows:[{id:21,quality:2,difference:-5,surplus:40.7},{id:16,quality:1,difference:768.39,surplus:0}]},realm:1};${slice('  const sellQuantities=', '  const placeSellCard=')};return sellQuantities;})()`);
assert.deepEqual(JSON.parse(JSON.stringify(sq({ id: 16, quality: 1 }))).left, 768);
assert.equal(sq({ id: 21, quality: 2 }).left, 0, 'negative Left (deficit) fills 0');
assert.equal(sq({ id: 21, quality: 2 }).surplus, 40);
assert.equal(sq({ id: 21, quality: 3 }).row, null);
console.log('v347-regression ok');
