async function state(){ return await chrome.runtime.sendMessage({type:'GET_STATE'}); }
async function render(){ const s=await state(); document.querySelector('#companyName').textContent=s.companyData?.name || s.companyData?.companyName || 'Not loaded'; document.querySelector('#lastSync').textContent=s.lastSync ? new Date(s.lastSync).toLocaleString() : 'Never'; document.querySelector('#status').textContent=s.syncStatus || 'Ready'; }
document.querySelector('#sync').onclick=async()=>{ document.querySelector('#status').textContent='Syncing…'; const r=await chrome.runtime.sendMessage({type:'SYNC_NOW'}); document.querySelector('#status').textContent=r.ok?'Synced':r.error; render(); };
// v2.5.330: reuse the open Manager tab instead of opening a fresh one (which always started on Overview).
document.querySelector('#openDashboard').onclick=async()=>{const base=chrome.runtime.getURL('dashboard.html');try{const tabs=await chrome.tabs.query({url:base+'*'});const t=(tabs||[])[0];if(t?.id){await chrome.tabs.update(t.id,{active:true});try{await chrome.windows.update(t.windowId,{focused:true});}catch{}window.close();return;}}catch{}chrome.tabs.create({url:base});};
document.querySelector('#openOptions').onclick=()=>chrome.runtime.openOptionsPage();
render();
