'use strict';
// v2.5.327: resource images are kept out of the realm store; mobile layout rules exist.
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const root=path.join(__dirname,'..');const bg=fs.readFileSync(path.join(root,'background.js'),'utf8');
const a=bg.indexOf("const RESOURCE_IMAGES_KEY='scmResourceImages';"),b=bg.indexOf('async function moveResourceImagesOutOfRealmStores(');
assert.ok(a>0&&b>a,'image routing block present');
const J=v=>JSON.parse(JSON.stringify(v));
(async()=>{
  let stored={scmResourceImages:{cache:{'1':'data:old1'},meta:{'1':{v:1}}}};
  const chrome={storage:{local:{get:async(q)=>{const out={};for(const k of Object.keys(q))out[k]=stored[k]??q[k];return out;}},onChanged:{addListener(){}}}};
  const ctx={chrome,console,JSON,Object};vm.createContext(ctx);
  vm.runInContext(bg.slice(a,b)+';this.route=routeResourceImagesOut;',ctx);
  // a realm write carrying images: images leave the realm payload and are merged (never replaced)
  const out=await ctx.route({'scmRealmStore:1':{warehouseResources:[1],resourceImageCache:{'2':'data:new2'},resourceImageMeta:{'2':{v:2}}},scmRealmStoreSchema:1});
  assert.equal('resourceImageCache' in out['scmRealmStore:1'],false,'images removed from the realm store payload');
  assert.deepEqual(J(out['scmRealmStore:1'].warehouseResources),[1],'other realm data untouched');
  assert.deepEqual(J(out.scmResourceImages.cache),{'1':'data:old1','2':'data:new2'},'images merged into their own key');
  assert.deepEqual(J(Object.keys(out.scmResourceImages.meta).sort()),['1','2']);
  // a write with no new images does not rewrite the image key
  stored.scmResourceImages=out.scmResourceImages;
  const out2=await ctx.route({'scmRealmStore:1':{x:1,resourceImageCache:{'2':'data:new2'}}});
  assert.equal('scmResourceImages' in out2,false,'unchanged images are not rewritten');
  const out3=await ctx.route({'scmRealmStore:0':{x:1,resourceImageCache:{}}});
  assert.equal('scmResourceImages' in out3,false,'empty image maps are ignored');
  assert.equal('resourceImageCache' in out3['scmRealmStore:0'],false);
  // wiring
  assert.equal((bg.match(/return rawStorageSet\(await routeResourceImagesOut\(out\)\);/g)||[]).length,2,'both realm write paths route images out');
  assert.match(bg,/moveResourceImagesOutOfRealmStores\(\)\.catch/,'existing stores are migrated at startup');
  assert.match(bg,/const local=file\?'':/,'overlay uses the game image URL instead of embedding base64');
  assert.match(bg,/stripOverlayEmbeddedImages/,'older stored overlay snapshots are stripped before sending');
  const dash=fs.readFileSync(path.join(root,'dashboard.js'),'utf8');
  assert.match(dash,/result\.resourceImageCache=\{\.\.\.\(result\.resourceImageCache\|\|\{\}\),\.\.\.imgs\}/,'dashboard reads images from their own key');
  const css=fs.readFileSync(path.join(root,'styles.css'),'utf8'),html=fs.readFileSync(path.join(root,'dashboard.html'),'utf8');
  assert.match(css,/html\.scm-mobile \.shell>nav\{position:sticky/,'sticky one-row tab bar on phones');
  assert.match(css,/html\.scm-mobile table\.mobile-cards td::before\{content:attr\(data-label\)/,'tables become cards on phones');
  assert.match(html,/<table class="warehouse-table mobile-cards">/);
  const content=fs.readFileSync(path.join(root,'content.js'),'utf8');
  assert.match(content,/S\.refreshTimer=setInterval\(\(\)=>\{if\(!document\.hidden\)load\(\);\},10000\)/,'overlay polling pauses in hidden tabs');
  console.log('mobile-storage-regression: all assertions passed');
})().catch(e=>{console.error(e);process.exit(1);});
// v2.5.327 (continued): overlay rebuilds on data change, snapshot memo, job history key, card tables.
{
  const bg2=fs.readFileSync(path.join(root,'background.js'),'utf8'),dash2=fs.readFileSync(path.join(root,'dashboard.js'),'utf8');
  assert.match(bg2,/const GAME_OVERLAY_REFRESH_MS=30000;/,'timed overlay rebuild every 30 s (was 5 s, i.e. every 10 s poll)');
  assert.match(bg2,/if\(gameOverlayDirty\.has\(realm\)\|\|Date\.now\(\)-lastRefresh>=GAME_OVERLAY_REFRESH_MS\)/,'data changes trigger an immediate rebuild');
  assert.match(bg2,/function scheduleGameOverlayRefreshNotification\(realm,delayMs=650,\{markDirty=true\}=\{\}\)\{\n  const n=validRealmNumber\(realm\); if\(n==null\)return;\n  if\(markDirty\)gameOverlayDirty\.add\(n\);/,'every data-save notification marks the overlay dirty');
  assert.match(bg2,/scheduleGameOverlayRefreshNotification\(n,150,\{markDirty:false\}\)/,'the rebuild\'s own notification does not re-mark dirty (no rebuild loop)');
  assert.match(bg2,/gameOverlaySnapshotMemo\.set\(n,next\)/,'snapshot kept in memory after persisting');
  assert.match(bg2,/const stripped=await stripOverlayEmbeddedImages\(data\)/,'snapshots are stored without base64 images');
  assert.match(bg2,/const histKey=backgroundJobHistoryKey\(n\);/,'job history no longer rewrites the realm store');
  assert.match(dash2,/scmBackgroundJobs:\$\{r\}/,'dashboard merges job history from its own key');
  assert.match(dash2,/<table class="building-input-table planner-input-table mobile-cards">/,'production inputs table is card-style on phones');
  console.log('mobile-storage-regression: overlay/job-history assertions passed');
}
