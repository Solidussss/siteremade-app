(() => {
  function install(){
    if(typeof state==='undefined'||typeof api!=='function')return setTimeout(install,100);
    const form=document.getElementById('prospectingForm');if(!form)return;
    form.onsubmit=async event=>{
      event.preventDefault();
      const status=document.getElementById('prospectingStatus');
      if(status)status.textContent='Searching up to 60 real businesses…';
      try{
        const payload=Object.fromEntries(new FormData(form));
        const d=await api('/api/v19/prospects/search',{method:'POST',body:JSON.stringify(payload)});
        state.prospects=d.prospects||[];
        if(status)status.textContent=d.live?`${state.prospects.length} businesses matched — best-fit results first.`:'Market Finder needs a Google Places API key.';
        renderProspects();
      }catch(e){if(status)status.textContent=e.message;}
    };
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
})();
