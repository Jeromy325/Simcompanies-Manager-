async function send(msg){ try{ return await chrome.runtime.sendMessage(msg); }catch(e){ return {ok:false,error:String(e?.message||e||'Background unavailable')}; } }
async function state(){ const s=await send({type:'GET_STATE'}); return (s&&typeof s==='object'&&s.ok!==false)?s:{syncStatus:(s&&s.error)?'Could not load data: '+s.error:'Could not load data. Try reopening the popup.'}; }
async function render(){ const s=await state(); document.querySelector('#companyName').textContent=s.companyData?.name || s.companyData?.companyName || s.authData?.authCompany?.company || 'Not loaded'; document.querySelector('#lastSync').textContent=s.lastSync ? new Date(s.lastSync).toLocaleString() : 'Never'; document.querySelector('#status').textContent=s.syncStatus || 'Ready'; }
document.querySelector('#sync').onclick=async()=>{ document.querySelector('#status').textContent='Syncing…'; const r=await send({type:'SYNC_NOW'}); document.querySelector('#status').textContent=r?.ok?'Synced':(r?.error||'Sync failed. Try again.'); render().catch(()=>{}); };
// v2.5.330: reuse the open Manager tab instead of opening a fresh one (which always started on Overview).
document.querySelector('#openDashboard').onclick=async()=>{const base=chrome.runtime.getURL('dashboard.html');try{const tabs=await chrome.tabs.query({url:base+'*'});const t=(tabs||[])[0];if(t?.id){await chrome.tabs.update(t.id,{active:true});try{await chrome.windows.update(t.windowId,{focused:true});}catch{}window.close();return;}}catch{}chrome.tabs.create({url:base});};
render().catch(()=>{ document.querySelector('#status').textContent='Could not load data. Try reopening the popup.'; });
render();
try{chrome.runtime.sendMessage({type:'SCM_CLEAR_ALERT_BADGE'}).catch(()=>{});}catch{}

// v2.5.438 Self-test now lives in the dashboard Settings tab too.
document.querySelector('#openSelfTest')?.addEventListener('click',()=>{chrome.tabs.create({url:chrome.runtime.getURL('dashboard.html?tab=selftest')});window.close();});
