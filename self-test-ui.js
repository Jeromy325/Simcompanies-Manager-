// Self-test UI, shared by options.html and the dashboard Settings tab: RUN_SELF_TEST (extension-page-only) -> results list; Copy report is redacted (counts/booleans only).
(()=>{
  const $=s=>document.querySelector(s);const run=$('#runSelfTest'),copy=$('#copySelfTest'),list=$('#selfTestResults'),st=$('#selfTestStatus');
  if(!run||!list)return;let last=null;
  run.addEventListener('click',async()=>{
    run.disabled=true;copy.disabled=true;st.textContent=' Running...';list.textContent='';
    try{
      const r=await chrome.runtime.sendMessage({type:'RUN_SELF_TEST',liveFetch:!!$('#selfTestLive')?.checked});
      if(!r?.ok)throw new Error(r?.error||'Self-test unavailable');last=r;
      for(const x of r.results){const li=document.createElement('li');li.className=`st-${x.status}`;const b=document.createElement('b');b.textContent=x.status.toUpperCase();li.append(b,` ${x.name}: ${x.detail}`);list.append(li);}
      const t=r.totals;st.textContent=` ${t.pass} pass, ${t.warn} warn, ${t.fail} fail, ${t.skip} skip`;copy.disabled=false;
    }catch(e){st.textContent=' Failed: '+(e?.message||e);}
    finally{run.disabled=false;}
  });
  copy?.addEventListener('click',async()=>{
    if(!last)return;
    const rep=globalThis.SCM_SELF_TEST_CORE.buildReport(last.results,{version:last.version,userAgent:navigator.userAgent,at:last.at},v=>globalThis.SCM_DIAGNOSTIC_CORE.redactSecrets(v));
    try{await navigator.clipboard.writeText(rep.text);st.textContent=' Report copied.';}catch{st.textContent=' Copy failed (clipboard blocked).';}
  });
})();
