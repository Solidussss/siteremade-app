document.documentElement.dataset.trafficVersion='21';
(() => {
  const ready=()=>typeof state!=='undefined'&&typeof qs==='function'&&typeof renderWebsiteTraffic==='function';
  function ensure(){
    const panel=document.querySelector('.traffic-panel');if(!panel)return;
    const head=panel.querySelector('.panel-head');
    const eyebrow=head?.querySelector('.eyebrow');if(eyebrow)eyebrow.textContent='WEBSITE PERFORMANCE';
    const title=head?.querySelector('h2');if(title)title.textContent='Your website traffic';
    const intro=head?.querySelector('p:not(.eyebrow)');if(intro)intro.textContent='See how many people are visiting your website. SiteRemade handles the tracking setup for you.';
    const form=document.querySelector('#websiteTrafficForm');if(form){form.classList.add('v21-domain-form');const btn=form.querySelector('button[type="submit"]');if(btn)btn.textContent='Update website';}
    const old=document.querySelector('#v20TrafficSetup');if(old)old.remove();
    if(!document.querySelector('#v21TrafficHelp')&&form){const help=document.createElement('div');help.id='v21TrafficHelp';help.className='v21-traffic-help';help.innerHTML='<div class="v21-live-dot"></div><div><strong>Managed by SiteRemade</strong><span>Traffic tracking is installed and maintained by us. You only need to keep your website address correct.</span></div>';form.insertAdjacentElement('afterend',help);}
    const note=panel.querySelector('.traffic-note');if(note)note.textContent='Visitor data updates automatically after tracking is installed on your website.';
  }
  function render(){ensure();const a=state.websiteAnalytics||{},status=document.querySelector('#trafficConnectionStatus'),help=document.querySelector('#v21TrafficHelp');if(status){status.textContent=a.connected?'TRACKING LIVE':a.domain?'SETUP PENDING':'ADD WEBSITE';status.classList.toggle('neutral',!a.connected);}if(help){const strong=help.querySelector('strong'),span=help.querySelector('span');if(a.connected){strong.textContent='Tracking is live';span.textContent='SiteRemade is collecting real visits from your website automatically.';}else if(a.domain){strong.textContent='Website saved';span.textContent='SiteRemade will connect tracking for this website. There is nothing else for you to install.';}else{strong.textContent='Add your website';span.textContent='Enter the website address above and SiteRemade will handle the tracking setup.';}}}
  function install(){if(!ready())return setTimeout(install,80);const old=renderWebsiteTraffic;renderWebsiteTraffic=function(){const r=old();render();return r;};render();}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
})();
