document.documentElement.dataset.siteremadeVersion='23';
(() => {
  const wait=()=>typeof state!=='undefined'&&typeof qs==='function'&&typeof renderAll==='function';
  const moneySafe=n=>typeof money==='function'?money(n):`$${Math.round(Number(n)||0).toLocaleString()}`;
  const make=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};
  const websiteLead=l=>/website|chat/i.test(String(l.source||''));

  function addHero(viewId,id,kicker,title,copy){
    const view=qs(viewId),head=view?.querySelector('.page-head');if(!view||!head)return null;
    let box=qs('#'+id);if(!box){box=make('section','v22-hero');box.id=id;head.insertAdjacentElement('afterend',box);}
    box.innerHTML=`<div class="v22-hero-copy"><p class="eyebrow">${kicker}</p><h2>${title}</h2><p>${copy}</p></div><div class="v22-hero-stats"></div>`;
    return box;
  }

  function renderHomeHero(){
    const box=addHero('#view-home','v22HomeHero','TODAY\'S BUSINESS','Know exactly what to do next.','SiteRemade pulls your leads, replies, bookings and money into one operating view.');if(!box)return;
    const active=state.leads.filter(l=>!['Won','Lost'].includes(l.status)).length;
    const waiting=state.conversations.reduce((n,c)=>n+Math.max(0,Number(c.unread)||0),0);
    // Same "needs a follow-up" definition v19-client.js's now-retired focus
    // strip used (active lead, untouched 2+ days) — folded in here instead
    // of duplicated in its own row; see PHASE3-ROUTE-MAP.md.
    const stale=state.leads.filter(l=>!['Won','Lost'].includes(l.status)&&Math.max(0,Math.floor((Date.now()-new Date(l.updatedAt||l.createdAt||Date.now()).getTime())/86400000))>=2).length;
    const upcoming=state.appointments.filter(a=>new Date(a.start)>=new Date()).length;
    const pending=state.invoices.filter(i=>i.status==='Pending').reduce((n,i)=>n+Number(i.amount||0),0);
    const s=box.querySelector('.v22-hero-stats');
    [['Active leads',active,'leads'],['Waiting replies',waiting,'inbox'],['Follow-ups due',stale,'leads'],['Upcoming',upcoming,'calendar'],['Outstanding',moneySafe(pending),'payments']].forEach(([label,val,view])=>{const b=make('button','v22-hero-stat');b.innerHTML=`<span>${label}</span><strong>${val}</strong>`;b.onclick=()=>switchView(view);s.appendChild(b);});
  }

  function websiteNumbers(){
    const leads=state.leads.filter(websiteLead);
    const ids=new Set(leads.map(l=>l.id));
    const conversations=state.conversations.filter(c=>ids.has(c.leadId)&&Array.isArray(c.messages)&&c.messages.length>0).length;
    const bookings=state.appointments.filter(a=>ids.has(a.leadId)).length;
    const won=leads.filter(l=>l.status==='Won');
    const wonValue=won.reduce((n,l)=>n+(Number(l.value)||0),0);
    const closed=leads.filter(l=>['Won','Lost'].includes(l.status));
    return {leads:leads.length,conversations,bookings,won:won.length,wonValue,closeRate:closed.length?Math.round(won.length/closed.length*100):0};
  }

  function renderAnalyticsHero(){
    const box=addHero('#view-analytics','v22AnalyticsHero','GROWTH OVERVIEW','From leads to revenue.','See exactly what SiteRemade can verify: inquiries, bookings, wins and collected revenue.');if(!box)return;
    const won=state.leads.filter(l=>l.status==='Won').length,closed=state.leads.filter(l=>['Won','Lost'].includes(l.status)).length,rate=closed?Math.round(won/closed*100):0;
    const web=websiteNumbers();
    const paid=state.invoices.filter(i=>i.status==='Paid').reduce((n,i)=>n+Number(i.amount||0),0);
    const s=box.querySelector('.v22-hero-stats');
    [['Win rate',`${rate}%`],['Website inquiries',web.leads],['Website bookings',web.bookings],['Collected',moneySafe(paid)]].forEach(([label,val])=>{const d=make('div','v22-hero-stat');d.innerHTML=`<span>${label}</span><strong>${val}</strong>`;s.appendChild(d);});
  }

  function renderWebsiteResults(){
    const panel=qs('#view-analytics .traffic-panel');if(!panel)return;
    const web=websiteNumbers();
    panel.className='panel traffic-panel v23-website-results';
    panel.innerHTML=`<div class="panel-head v23-results-head"><div><p class="eyebrow">WEBSITE RESULTS</p><h2>What your website is actually generating</h2><p>Only verified SiteRemade lead and booking data is shown here. No estimated visitor counts.</p></div><span class="status-pill">LIVE DATA</span></div><div class="v23-results-grid"><article><span>WEBSITE INQUIRIES</span><strong>${web.leads}</strong><small>Leads captured from the website or website chat</small></article><article><span>CONVERSATIONS</span><strong>${web.conversations}</strong><small>Website leads with a real message thread</small></article><article><span>BOOKINGS</span><strong>${web.bookings}</strong><small>Appointments tied to website leads</small></article><article><span>WON VALUE</span><strong>${moneySafe(web.wonValue)}</strong><small>${web.won} won website lead${web.won===1?'':'s'} · ${web.closeRate}% close rate</small></article></div>`;
  }

  function fixInboxExplainer(){
    const explainer=qs('#v17InboxExplainer'),view=qs('#view-inbox');
    if(explainer&&view&&explainer.parentElement!==view)view.insertBefore(explainer,view.firstChild);
  }

  function polishAnalytics(){
    const view=qs('#view-analytics');if(!view)return;
    const metrics=view.querySelector('.analytics-metrics');const traffic=view.querySelector('.traffic-panel');
    if(traffic&&metrics&&traffic.previousElementSibling!==metrics)metrics.insertAdjacentElement('afterend',traffic);
    const ad=view.querySelector('.ads-panel');if(ad)ad.classList.add('v22-secondary-feature');
    renderWebsiteResults();
  }

  function polishNav(){
    const inbox=qs('[data-view="inbox"] strong');if(inbox)inbox.textContent='Messages';
    const home=qs('[data-view="home"] strong');if(home)home.textContent='Overview';
  }

  function renderV22(){fixInboxExplainer();renderHomeHero();renderAnalyticsHero();polishAnalytics();polishNav();}
  function install(){if(!wait())return setTimeout(install,80);const old=renderAll;renderAll=function(){const r=old();renderV22();return r;};renderV22();setTimeout(renderV22,250);}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
})();
