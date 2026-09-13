(()=>{
  if(!document.querySelector('link[href^="/v28-market.css"]')){const l=document.createElement('link');l.rel='stylesheet';l.href='/v28-market.css?v=28';document.head.appendChild(l);}
  if(!document.querySelector('script[src^="/v28-market-client.js"]')){const s=document.createElement('script');s.src='/v28-market-client.js?v=28';s.defer=true;document.head.appendChild(s);}
  let lastKey='';
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num=n=>Number(n?.value??n??0).toLocaleString();
  const ready=()=>typeof state!=='undefined'&&typeof renderAll==='function';
  const currentWorkspace=()=>typeof state!=='undefined'&&state.workspace?.id?state.workspace.id:'';
  const currentBusiness=()=>typeof state!=='undefined'&&state.workspace?.businessName?state.workspace.businessName:'';
  const currentDomain=()=>typeof state!=='undefined'&&state.websiteAnalytics?.domain?state.websiteAnalytics.domain:'';

  function setupMarkup(domain=''){
    return `<div class="v24-site-picker">
      <div>
        <p class="eyebrow">CLIENT WEBSITE</p>
        <h2>Website analytics</h2>
        <p>Select the website this workspace should track. SiteRemade creates and links its private analytics property automatically.</p>
      </div>
      <form id="v24WebsiteForm" class="traffic-domain-form v21-domain-form">
        <label>Website domain<input name="domain" value="${esc(domain)}" placeholder="yourbusiness.com" autocomplete="url" required /></label>
        <button class="secondary-button" type="submit">${domain?'Change website':'Connect website'}</button>
        <p class="modal-status" id="v24WebsiteStatus"></p>
      </form>
    </div>`;
  }

  function bindSetup(panel){
    const form=panel.querySelector('#v24WebsiteForm');
    if(!form||form.dataset.bound)return;
    form.dataset.bound='1';
    form.addEventListener('submit',async e=>{
      e.preventDefault();
      const status=form.querySelector('#v24WebsiteStatus');
      const btn=form.querySelector('button[type="submit"]');
      const domain=String(new FormData(form).get('domain')||'').trim();
      if(!domain)return;
      if(status)status.textContent='Connecting website…';
      if(btn)btn.disabled=true;
      try{
        const wid=currentWorkspace();
        const r=await fetch('/api/app/analytics/website',{
          method:'POST',
          credentials:'same-origin',
          headers:{'content-type':'application/json',...(wid?{'x-workspace-id':wid}:{})},
          body:JSON.stringify({domain,businessName:currentBusiness()})
        });
        const j=await r.json();
        if(!r.ok)throw Error(j.message||'Could not connect website');
        if(typeof state!=='undefined'){
          state.websiteAnalytics=state.websiteAnalytics||{};
          state.websiteAnalytics.domain=j.domain;
          state.websiteAnalytics.connected=true;
          state.websiteAnalytics.provider='umami';
        }
        if(status)status.textContent='Website connected.';
        lastKey='';
        setTimeout(load,150);
      }catch(err){if(status)status.textContent=err.message||'Could not connect website.';}
      finally{if(btn)btn.disabled=false;}
    });
  }

  const rows=(a,label)=>`<div class="v24-list"><strong>${label}</strong>${(Array.isArray(a)?a:[]).slice(0,6).map(x=>`<div><span>${esc(x.x||x.name||x.value||'Direct')}</span><b>${num(x.y??x.count??0)}</b></div>`).join('')||'<small>No data yet</small>'}</div>`;

  async function load(){
    const view=document.querySelector('#view-analytics');
    if(!view||!view.classList.contains('active'))return;
    const wid=currentWorkspace();
    const key=wid+':'+Math.floor(Date.now()/30000);
    if(key===lastKey)return;
    lastKey=key;
    const panel=view.querySelector('.traffic-panel');
    if(!panel)return;
    try{
      const r=await fetch('/api/app/umami/analytics?days=30',{credentials:'same-origin',headers:wid?{'x-workspace-id':wid}:{}}),j=await r.json();
      if(!r.ok)throw Error(j.message||'Analytics unavailable');
      if(!j.connected){
        panel.className='panel traffic-panel';
        panel.innerHTML=`${setupMarkup(j.domain||currentDomain())}<div class="panel-head"><div><p class="eyebrow">WEBSITE TRAFFIC</p><h2>No website connected yet</h2><p>Enter this client's website above. Once tracking is installed on that website, its real visitor data appears here.</p></div><span class="status-pill neutral">SETUP</span></div>`;
        bindSetup(panel);
        return;
      }
      const s=j.stats||{},active=j.active?.visitors??j.active?.value??j.active??0;
      panel.className='panel traffic-panel';
      panel.innerHTML=`${setupMarkup(j.domain||'')}
        <div class="panel-head"><div><p class="eyebrow">WEBSITE TRAFFIC · LAST 30 DAYS</p><h2>${esc(j.domain)}</h2><p>Measured from this client's own website through SiteRemade analytics.</p></div><span class="status-pill">LIVE · ${num(active)} NOW</span></div>
        <div class="v23-results-grid">
          <article><span>VISITORS</span><strong>${num(s.visitors)}</strong><small>Unique measured visitors</small></article>
          <article><span>VISITS</span><strong>${num(s.visits)}</strong><small>Website sessions</small></article>
          <article><span>PAGEVIEWS</span><strong>${num(s.pageviews)}</strong><small>Pages viewed</small></article>
          <article><span>BOUNCE RATE</span><strong>${s.bounces&&s.visits?Math.round((Number(s.bounces.value??s.bounces)/Number(s.visits.value??s.visits))*100)+'%':'0%'}</strong><small>Single-page visits</small></article>
        </div>
        <div class="v24-breakdown">${rows(j.pages,'Top pages')}${rows(j.referrers,'Referrers')}${rows(j.devices,'Devices')}${rows(j.countries,'Countries')}</div>`;
      bindSetup(panel);
    }catch(e){
      panel.className='panel traffic-panel';
      panel.innerHTML=`${setupMarkup(currentDomain())}<div class="panel-head"><div><p class="eyebrow">WEBSITE TRAFFIC</p><h2>Analytics temporarily unavailable</h2><p>${esc(e.message)}</p></div></div>`;
      bindSetup(panel);
    }
  }

  function install(){
    if(!ready())return setTimeout(install,100);
    const old=renderAll;
    renderAll=function(){const r=old.apply(this,arguments);setTimeout(()=>{lastKey='';load()},20);return r;};
    document.addEventListener('click',e=>{if(e.target.closest('[data-view="analytics"]'))setTimeout(()=>{lastKey='';load()},80)});
    setTimeout(()=>{lastKey='';load()},250);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
})();
