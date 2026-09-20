const state={workspace:{},workspaces:[],user:null,locked:false,integrations:{},leads:[],conversations:[],appointments:[],invoices:[],automations:[],activities:[],adSpend:[],adFunds:[],billing:{},prospects:[],prospectViews:[],websiteAnalytics:{},websiteUpdates:[],websiteProjects:[],selectedProjectId:null,filter:'all',search:'',selectedConversationId:null,selectedLeadId:null,calendarDate:new Date(),rangeDays:30};
let liveRefreshing=false,lastLiveCounts={leads:0,unread:0},toastTimer=null;
const qs=s=>document.querySelector(s), qsa=s=>[...document.querySelectorAll(s)];
const money=n=>new Intl.NumberFormat('en-CA',{style:'currency',currency:state.workspace.currency||'CAD',maximumFractionDigits:0}).format(Number(n)||0);
const esc=(v='')=>String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const initials=(n='')=>n.split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join('').toUpperCase()||'•';
const relative=iso=>{const d=Math.max(0,(Date.now()-new Date(iso))/1000);if(d<60)return'now';if(d<3600)return`${Math.floor(d/60)}m`;if(d<86400)return`${Math.floor(d/3600)}h`;return`${Math.floor(d/86400)}d`;};
const dateLabel=iso=>new Intl.DateTimeFormat('en-CA',{month:'short',day:'numeric'}).format(new Date(iso));
const dateTimeLabel=iso=>new Intl.DateTimeFormat('en-CA',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(iso));

async function api(url,opts={}){const r=await fetch(url,{...opts,headers:{'Content-Type':'application/json',...(opts.headers||{})}});const data=await r.json().catch(()=>({}));if(!r.ok||data.ok===false)throw new Error(data.message||`Request failed (${r.status})`);return data;}
// Production-readiness/performance review: these files are dashboard
// feature layers (mail, market finder, ads, calendar, daily workflow,
// analytics, existing-number wizard, etc.) that only ever style or act on
// elements inside the dashboard, hidden behind #authScreen until a session
// exists — none of them do anything the login/signup screen needs. They
// used to be static <link>/<script> tags in index.html, so every visitor
// downloaded ~300KB of dashboard-only CSS/JS (plus everything several of
// the scripts further pull in via dynamic import()), and the CSS was
// render-blocking, just to see the login form. They still load exactly
// once, in the same order (scripts kept in order via `script.async =
// false`, the standard way to preserve document order for scripts inserted
// this way), and behave identically — just from the moment the dashboard
// actually becomes visible instead of from page load.
let dashboardScriptsLoaded=false;
function loadDashboardFeatureScripts(){
  if(dashboardScriptsLoaded)return;
  dashboardScriptsLoaded=true;
  ['/v22.css?v=27','/v24.css?v=27','/v20.css?v=20','/v17.css?v=17','/v18.css?v=18','/v19.css?v=19'].forEach(href=>{
    const l=document.createElement('link');
    l.rel='stylesheet';l.href=href;
    document.head.appendChild(l);
  });
  ['/v40-existing-number-client.js?v=3','/v45-ad-intelligence-client.js','/v22-client.js?v=27','/v24-umami-client.js?v=27','/v20-client.js?v=20','/v29-bootstrap.js?v=36','/v17-client.js?v=17','/v18-client.js?v=18','/v19-client.js?v=19'].forEach(src=>{
    const s=document.createElement('script');
    s.src=src;s.async=false;
    document.body.appendChild(s);
  });
}
async function bootstrap(){try{const d=await api('/api/app/bootstrap');Object.assign(state,{workspace:d.workspace||{},workspaces:d.workspaces||[],user:d.user||null,locked:!!d.locked,integrations:d.integrations||{},leads:d.leads||[],conversations:d.conversations||[],appointments:d.appointments||[],invoices:d.invoices||[],automations:d.automations||[],activities:d.activities||[],adSpend:d.adSpend||[],adFunds:d.adFunds||[],billing:d.billing||{},prospectViews:d.prospectViews||[],websiteAnalytics:d.websiteAnalytics||{},websiteUpdates:d.websiteUpdates||[],websiteProjects:d.websiteProjects||[]});qs('#authScreen').hidden=true;renderAll();loadDashboardFeatureScripts();qs('#systemStatus').textContent='Cloud database live';const qp=new URLSearchParams(location.search),sid=qp.get('session_id');if(sid&&(qp.get('billing')==='success'||qp.get('adfund')==='success')){try{await api('/api/app/checkout/confirm?sessionId='+encodeURIComponent(sid));history.replaceState({},'',location.pathname);const d2=await api('/api/app/bootstrap');Object.assign(state,{workspace:d2.workspace||{},workspaces:d2.workspaces||[],user:d2.user||state.user,locked:!!d2.locked,integrations:d2.integrations||{},leads:d2.leads||[],conversations:d2.conversations||[],appointments:d2.appointments||[],invoices:d2.invoices||[],automations:d2.automations||[],activities:d2.activities||[],adSpend:d2.adSpend||[],adFunds:d2.adFunds||[],billing:d2.billing||{},prospectViews:d2.prospectViews||[],websiteAnalytics:d2.websiteAnalytics||{},websiteUpdates:d2.websiteUpdates||[],websiteProjects:d2.websiteProjects||[]});renderAll();}catch(err){console.error('Checkout confirmation:',err)}}return true;}catch(e){qs('#authScreen').hidden=false;qs('#systemStatus').textContent=e.message.includes('Supabase')?'Supabase setup required':'Sign in required';if(e.message.includes('Supabase')){const s=qs('#loginStatus');s.textContent=e.message;s.style.color='#c54747';}console.error(e);return false;}}

function renderSubscriptionGate(){
  const lock=qs('#subscriptionLock');if(!lock)return;
  const locked=state.user?.role!=='owner'&&!!state.locked;
  lock.hidden=!locked;document.body.classList.toggle('subscription-locked',locked);
  const cents=Number(state.billing?.monthlyCents||3900),status=String(state.billing?.status||'inactive');
  if(qs('#lockSubscriptionPrice'))qs('#lockSubscriptionPrice').textContent=money(cents/100);
  if(qs('#lockSubscriptionStatus'))qs('#lockSubscriptionStatus').textContent=status.toUpperCase();
}
function safeRender(name,fn){try{fn();}catch(err){console.error('Render failed:',name,err);}}
function renderAll(){
  [
    ['subscription',renderSubscriptionGate],['workspace',renderWorkspace],['dashboard',renderDashboard],
    ['leads',renderLeads],['inbox',renderInbox],['calendar',renderCalendar],['payments',renderPayments],
    ['analytics',renderAnalytics],['website-traffic',renderWebsiteTraffic],['website-updates',renderWebsiteUpdates],['website-projects',renderWebsiteProjects],
    ['automations',renderAutomations],['settings',renderSettings],['notifications',renderNotifications],
    ['prospects',renderProspects],['lead-selects',fillLeadSelects],['workspace-menu',renderWorkspaceMenu],
    ['admin',()=>renderAdmin()],['badges',renderBadges]
  ].forEach(([name,fn])=>safeRender(name,fn));
}
function renderBadges(){const newLeads=state.leads.filter(l=>l.status==='New').length,unread=state.conversations.reduce((s,c)=>s+Math.max(0,Number(c.unread)||0),0),total=newLeads+unread;const lb=qs('#leadBadge'),ib=qs('#inboxBadge'),nc=qs('#notificationCount'),dot=qs('#notificationDot');if(lb){lb.textContent=newLeads;lb.style.display=newLeads?'grid':'none';}if(ib){ib.textContent=unread;ib.style.display=unread?'grid':'none';}if(nc){nc.textContent=total>99?'99+':String(total);nc.hidden=!total;}if(dot)dot.style.display=total?'block':'none';return{newLeads,unread,total};}
function showToast(title,detail=''){let t=qs('#appToast');if(!t){t=document.createElement('div');t.id='appToast';t.className='app-toast';document.body.appendChild(t);}t.innerHTML=`<strong>${esc(title)}</strong><span>${esc(detail)}</span>`;t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),3600);}
function renderWorkspace(){const n=state.workspace.businessName||'Your business';qs('#workspaceName').textContent=n;qs('#homeGreeting').textContent=`${n.split(/\s+/)[0]} overview`;qs('.workspace-mark').textContent=(n[0]||'S').toUpperCase();qs('#todayLabel').textContent=new Intl.DateTimeFormat('en-CA',{weekday:'long',month:'long',day:'numeric'}).format(new Date()).toUpperCase();const uc=qs('.user-card strong');if(uc&&state.user)uc.textContent=state.user.name;const us=qs('.user-card small');if(us&&state.user)us.textContent=state.user.role==='owner'?'SiteRemade owner':'Administrator';qs('#adminNav').style.display=state.user?.role==='owner'?'grid':'none';const man=qs('#mobileAdminNav');if(man)man.style.display=state.user?.role==='owner'?'block':'none';}
function greeting(){const h=new Date().getHours();return h<12?'morning':h<18?'afternoon':'evening';}
function inRange(iso){return Date.now()-new Date(iso).getTime()<=state.rangeDays*86400000;}
function renderDashboard(){
  const days=Number(state.rangeDays)||30,ms=days*86400000,nowMs=Date.now();
  const current=state.leads.filter(l=>{const t=new Date(l.createdAt).getTime();return t>=nowMs-ms&&t<=nowMs;});
  const previous=state.leads.filter(l=>{const t=new Date(l.createdAt).getTime();return t>=nowMs-(ms*2)&&t<nowMs-ms;});
  const upcoming=state.appointments.filter(a=>new Date(a.start)>=new Date()).sort((a,b)=>new Date(a.start)-new Date(b.start));
  const won=state.leads.filter(l=>l.status==='Won'),wonValue=won.reduce((sum,l)=>sum+(Number(l.value)||0),0);
  qs('#metricLeads').textContent=current.length;
  const period=qs('#leadMetricPeriod');if(period)period.textContent=`LAST ${days} DAYS`;
  const trend=qs('#leadTrend');if(trend){let label='→ 0%',cls='neutral';if(previous.length===0&&current.length>0){label='↗ NEW';cls='positive';}else if(previous.length>0){const pct=Math.round(((current.length-previous.length)/previous.length)*100);if(pct>0){label=`↗ ${pct}%`;cls='positive';}else if(pct<0){label=`↓ ${Math.abs(pct)}%`;cls='negative';}else label='→ 0%';}trend.textContent=label;trend.className=`trend ${cls}`;}
  qs('#metricAppointments').textContent=upcoming.length;qs('#appointmentMeta').textContent=upcoming.length?`Next: ${upcoming[0].title} · ${dateTimeLabel(upcoming[0].start)}`:'No upcoming appointments';
  const convWithReplies=state.conversations.filter(c=>c.messages?.length>1);qs('#metricResponse').textContent=convWithReplies.length?`${Math.round(convWithReplies.reduce((sum,c)=>{const m=c.messages;return sum+Math.max(1,(new Date(m[1].createdAt)-new Date(m[0].createdAt))/60000)},0)/convWithReplies.length)}m`:'—';const responseMeta=qs('#responseMeta');if(responseMeta)responseMeta.textContent=convWithReplies.length?`Across ${convWithReplies.length} repl${convWithReplies.length===1?'y':'ies'}`:'Not enough replies yet to measure';
  qs('#metricValue').textContent=money(wonValue);qs('#valueMeta').textContent=`From ${won.length} won opportunit${won.length===1?'y':'ies'}`;const newLeadCount=state.leads.filter(l=>l.status==='New').length;const leadBadge=qs('#leadBadge');if(leadBadge){leadBadge.textContent=newLeadCount;leadBadge.style.display=newLeadCount?'grid':'none';}
  renderRecent();renderPipeline();renderActivity();renderBars();
}
function renderRecent(){const list=qs('#recentLeadList');const src=[...state.leads].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,5);list.innerHTML=src.length?src.map(l=>`<button class="lead-row clickable-lead" data-id="${l.id}"><span class="avatar">${esc(initials(l.name))}</span><div class="lead-person"><strong>${esc(l.name)}</strong><span>${esc(l.phone||l.email||'No contact')}</span></div><span class="lead-service">${esc(l.service)}</span><span class="lead-time">${relative(l.createdAt)}</span><span class="lead-status status-${esc(l.status)}">${esc(l.status)}</span></button>`).join(''):'<div class="empty-state">No leads yet.</div>';qsa('.clickable-lead').forEach(b=>b.onclick=()=>openLead(b.dataset.id));}
function renderActivity(){qs('#activityTimeline').innerHTML=(state.activities||[]).slice(0,6).map(a=>`<div class="timeline-item"><span class="timeline-icon">${({lead:'◎',appointment:'□',payment:'◇',won:'↗',message:'◌',status:'↗',delete:'×'}[a.type]||'•')}</span><div><strong>${esc(a.title)}</strong><p>${esc(a.detail||'')}</p><small>${relative(a.createdAt)}</small></div></div>`).join('')||'<div class="empty-state">Activity will appear here.</div>';}
function renderBars(){const arr=Array.from({length:22},(_,i)=>state.leads.filter(l=>{const age=(Date.now()-new Date(l.createdAt))/86400000;return age>=i&&age<i+1}).length);const max=Math.max(1,...arr);qs('#leadBars').innerHTML=arr.reverse().map(v=>`<i style="height:${20+(v/max)*80}%"></i>`).join('');}
function renderPipeline(){const statuses=['New','Contacted','Quoted','Won','Lost'];const max=Math.max(1,...statuses.map(s=>state.leads.filter(l=>l.status===s).length));qs('#pipelineStats').innerHTML=statuses.map(s=>{const n=state.leads.filter(l=>l.status===s).length;return`<div class="pipeline-column"><span>${s.toUpperCase()}</span><strong>${n}</strong><div class="pipeline-bar"><i style="width:${Math.max(n?8:0,n/max*100)}%"></i></div></div>`}).join('');}

function filteredLeads(){return state.leads.filter(l=>(state.filter==='all'||l.status===state.filter)&&(!state.search||`${l.name} ${l.email} ${l.phone} ${l.service} ${l.source} ${l.message}`.toLowerCase().includes(state.search)));}
function renderLeads(){const leads=filteredLeads();qs('#leadCountLabel').textContent=`${leads.length} lead${leads.length===1?'':'s'}`;qs('#leadTableBody').innerHTML=leads.length?leads.map(l=>`<tr class="lead-table-row" data-id="${l.id}"><td><strong>${esc(l.name)}</strong><small>${esc(l.phone||l.email||'No contact details')}</small></td><td>${esc(l.service)}</td><td>${esc(l.source)}</td><td>${dateLabel(l.createdAt)}</td><td><select class="status-select lead-status status-${esc(l.status)}" data-id="${l.id}">${['New','Contacted','Quoted','Won','Lost'].map(s=>`<option ${s===l.status?'selected':''}>${s}</option>`).join('')}</select></td><td><button class="row-menu" data-open="${l.id}">•••</button></td></tr>`).join(''):'<tr><td class="empty-row" colspan="6">No leads match this view.</td></tr>';qsa('.status-select').forEach(x=>x.onchange=e=>{e.stopPropagation();updateLead(x.dataset.id,{status:x.value})});qsa('.lead-table-row').forEach(r=>r.onclick=e=>{if(e.target.closest('select,button'))return;openLead(r.dataset.id)});qsa('[data-open]').forEach(b=>b.onclick=()=>openLead(b.dataset.open));}
async function updateLead(id,patch){try{const d=await api(`/api/app/leads/${id}`,{method:'PATCH',body:JSON.stringify(patch)});const i=state.leads.findIndex(x=>x.id===id);if(i>=0)state.leads[i]=d.lead;await refreshLight();if(state.selectedLeadId===id)populateDrawer(d.lead);}catch(e){alert(e.message)}}
function openLead(id){const l=state.leads.find(x=>x.id===id);if(!l)return;state.selectedLeadId=id;populateDrawer(l);qs('#leadDrawer').hidden=false;}
function populateDrawer(l){qs('#drawerName').textContent=l.name;qs('#drawerStatus').value=l.status;qs('#drawerValue').value=l.value||'';qs('#drawerLeadName').value=l.name||'';qs('#drawerService').value=l.service||'';qs('#drawerPhone').value=l.phone||'';qs('#drawerEmail').value=l.email||'';qs('#drawerMessage').value=l.message||'';qs('#drawerNote').value='';qs('#drawerNotes').innerHTML=(l.notes||[]).map(n=>`<div class="note-item">${esc(n)}</div>`).join('')||'<div class="empty-state">No notes yet.</div>';const actions=qs('#drawerContactActions');if(actions)actions.innerHTML=`${l.phone?`<a class="contact-chip" href="tel:${esc(l.phone)}">Call ${esc(l.phone)}</a>`:''}${l.email?`<a class="contact-chip" href="mailto:${esc(l.email)}">Email ${esc(l.email)}</a>`:''}<span class="contact-source">Source: ${esc(l.source||'Manual')}</span>`;renderDrawerProject(l);}

function renderInbox(){const list=qs('#conversationList');const convs=[...state.conversations].sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt));if(!state.selectedConversationId&&convs[0])state.selectedConversationId=convs[0].id;list.innerHTML=convs.length?convs.map(c=>{const last=c.messages?.[c.messages.length-1];return`<button class="conversation ${c.id===state.selectedConversationId?'active':''} ${Number(c.unread)>0?'unread':''}" data-conv="${c.id}"><span class="avatar small">${initials(c.name)}</span><div><strong>${esc(c.name)}</strong><p>${esc(last?.text||'No messages yet')}</p></div><small>${relative(c.updatedAt)}</small></button>`}).join(''):'<div class="empty-state padded">No conversations yet.</div>';qsa('[data-conv]').forEach(b=>b.onclick=async()=>{state.selectedConversationId=b.dataset.conv;const c=state.conversations.find(x=>x.id===b.dataset.conv);if(c&&c.unread){try{const d=await api(`/api/app/conversations/${c.id}`,{method:'PATCH',body:JSON.stringify({read:true})});c.unread=0;if(d.conversation)Object.assign(c,d.conversation);}catch{}}renderInbox();renderNotifications();renderBadges();});renderConversationWindow();renderBadges();}
function renderConversationWindow(){const c=state.conversations.find(x=>x.id===state.selectedConversationId);const input=qs('#messageInput'),send=qs('#messageForm button'),contact=qs('#conversationContact'),delivery=qs('#deliveryStatus');if(!c){qs('#conversationName').textContent='Select a conversation';qs('#conversationMode').textContent='No conversation selected';qs('#messageList').innerHTML='<div class="empty-state">Choose a conversation to view messages.</div>';qs('#takeoverButton').disabled=true;input.disabled=true;send.disabled=true;if(contact)contact.hidden=true;if(delivery){delivery.className='delivery-status';delivery.textContent='Select a customer to see delivery channels.';}return;}const lead=state.leads.find(l=>l.id===c.leadId);qs('#conversationName').textContent=c.name;qs('#conversationMode').textContent=c.mode==='ai'?'AI is handling this conversation':'You are handling this conversation';qs('#takeoverButton').disabled=false;qs('#takeoverButton').textContent=c.mode==='ai'?'Take over':'Return to AI';input.disabled=false;send.disabled=false;const emailLive=!!state.integrations?.resend&&!!lead?.email,smsLive=!!state.integrations?.twilio&&!!lead?.phone;input.placeholder=`Reply to ${c.name}…`;if(contact){contact.hidden=false;contact.innerHTML=`${lead?.phone?`<a class="contact-link" href="tel:${esc(lead.phone)}">Call ${esc(lead.phone)}</a>`:''}${lead?.email?`<a class="contact-link" href="mailto:${esc(lead.email)}">Email ${esc(lead.email)}</a>`:''}<span class="channel-chip live">Website chat</span><span class="channel-chip ${emailLive?'live':'off'}">Email ${emailLive?'live':'not connected'}</span><span class="channel-chip ${smsLive?'live':'off'}">SMS ${smsLive?'live':'not connected'}</span>`;}if(delivery){const active=['website chat'];if(emailLive)active.push('email');if(smsLive)active.push('SMS');delivery.className='delivery-status';delivery.textContent=`Replies deliver through ${active.join(' + ')}.${(!emailLive&&!smsLive)?' Connect Resend/Twilio for off-site delivery.':''}`;}qs('#messageList').innerHTML=(c.messages||[]).map(m=>`<div class="message ${m.from==='customer'?'inbound':m.from==='ai'?'ai':'business'}"><span>${esc(m.text)}</span><small>${relative(m.createdAt)}</small></div>`).join('')||'<div class="empty-state">No messages yet.</div>';qs('#messageList').scrollTop=qs('#messageList').scrollHeight;}

function renderCalendar(){const d=state.calendarDate,y=d.getFullYear(),m=d.getMonth();qs('#calendarTitle').textContent=new Intl.DateTimeFormat('en-CA',{month:'long',year:'numeric'}).format(d);const first=(new Date(y,m,1).getDay()+6)%7;const days=new Date(y,m+1,0).getDate();let html='';for(let i=0;i<first;i++)html+='<div class="calendar-day muted-day"></div>';for(let day=1;day<=days;day++){const events=state.appointments.filter(a=>{const x=new Date(a.start);return x.getFullYear()===y&&x.getMonth()===m&&x.getDate()===day}).sort((a,b)=>new Date(a.start)-new Date(b.start));html+=`<div class="calendar-day ${isToday(y,m,day)?'today-cell':''}"><span>${day}</span>${events.map(a=>`<button class="calendar-event" data-appt="${a.id}"><strong>${new Intl.DateTimeFormat('en-CA',{hour:'numeric',minute:'2-digit'}).format(new Date(a.start))} · ${esc(a.customer||'Customer')}</strong><small>${esc(a.title)} · ${esc(a.status||'Booked')}</small></button>`).join('')}</div>`}qs('#calendarGrid').innerHTML=html;qsa('[data-appt]').forEach(b=>b.onclick=e=>{e.stopPropagation();const a=state.appointments.find(x=>x.id===b.dataset.appt);if(!a)return;const lead=a.leadId?state.leads.find(l=>l.id===a.leadId):null;const detailName=qs('#appointmentDetailName'),detailMeta=qs('#appointmentDetailMeta'),detailTitle=qs('#appointmentDetailTitle'),detailNotes=qs('#appointmentDetailNotes');if(detailName)detailName.textContent=a.customer||lead?.name||'Customer';if(detailMeta)detailMeta.textContent=`${dateTimeLabel(a.start)} · ${a.duration||60} min · ${a.status||'Booked'}`;if(detailTitle)detailTitle.textContent=a.title||'Appointment';if(detailNotes)detailNotes.textContent=a.notes||'No appointment notes.';const contact=qs('#appointmentDetailContact');if(contact)contact.innerHTML=`${lead?.phone?`<a class="contact-chip" href="tel:${esc(lead.phone)}">Call</a>`:''}${lead?.email?`<a class="contact-chip" href="mailto:${esc(lead.email)}">Email</a>`:''}${lead?`<button class="contact-chip" type="button" id="appointmentOpenLead">Open customer</button>`:''}`;const deleteButton=qs('#appointmentDeleteButton');if(deleteButton)deleteButton.dataset.id=a.id;if(qs('#appointmentDetailModal'))showModal('appointmentDetailModal');const open=qs('#appointmentOpenLead');if(open)open.onclick=()=>{hideModal('appointmentDetailModal');openLead(lead.id);};});}
function isToday(y,m,d){const n=new Date();return n.getFullYear()===y&&n.getMonth()===m&&n.getDate()===d;}

function renderPayments(){
  const paid=state.invoices.filter(i=>i.status==='Paid'),open=state.invoices.filter(i=>i.status==='Pending');
  const collected=paid.reduce((s,i)=>s+Number(i.amount||0),0),outstanding=open.reduce((s,i)=>s+Number(i.amount||0),0),avg=state.invoices.length?state.invoices.reduce((s,i)=>s+Number(i.amount||0),0)/state.invoices.length:0;
  qs('#payCollected').textContent=money(collected);qs('#payCollectedMeta').textContent=`${paid.length} paid invoice${paid.length===1?'':'s'}`;qs('#payOutstanding').textContent=money(outstanding);qs('#payOutstandingMeta').textContent=`${open.length} open invoice${open.length===1?'':'s'}`;qs('#payAverage').textContent=money(avg);qs('#payConversion').textContent=state.invoices.length?`${Math.round(paid.length/state.invoices.length*100)}%`:'0%';
  qs('#transactionList').innerHTML=state.invoices.length?state.invoices.map(i=>`<div><span class="payment-icon">◇</span><strong>${esc(i.customer)}</strong><span>${esc(i.description)}</span><em>${money(i.amount)}</em><select class="invoice-status ${i.status.toLowerCase()}" data-invoice="${i.id}">${['Draft','Pending','Paid','Void'].map(x=>`<option ${x===i.status?'selected':''}>${x}</option>`).join('')}</select><button class="transaction-delete" data-delete-invoice="${i.id}" title="Delete invoice">×</button></div>`).join(''):'<div class="empty-state">No customer invoices yet.</div>';qsa('[data-invoice]').forEach(sel=>sel.onchange=()=>updateInvoice(sel.dataset.invoice,sel.value));qsa('[data-delete-invoice]').forEach(btn=>btn.onclick=()=>deleteInvoice(btn.dataset.deleteInvoice));
  const monthly=(Number(state.billing?.monthlyCents)||0)/100,status=state.billing?.status||state.workspace.siteRemadeSubscriptionStatus||'inactive';
  qs('#subscriptionPrice').textContent=money(monthly);const ss=qs('#subscriptionStatus');ss.textContent=String(status).replace('_',' ').toUpperCase();ss.classList.toggle('neutral',!['active','trialing'].includes(status));
  qs('#startSubscriptionButton').textContent=['active','trialing'].includes(status)?'Subscription active':'Start monthly plan';qs('#startSubscriptionButton').disabled=['active','trialing'].includes(status);
  const funded=(state.adFunds||[]).filter(f=>f.status==='Funded').reduce((x,f)=>x+Number(f.amount||0),0),spent=(state.adSpend||[]).reduce((x,a)=>x+Number(a.spend||0),0),available=Math.max(0,funded-spent);
  qs('#adFundedTotal').textContent=money(funded);qs('#adFundSpent').textContent=money(spent);qs('#adFundAvailable').textContent=money(available);
  qs('#adFundHistory').innerHTML=(state.adFunds||[]).length?state.adFunds.map(f=>`<div><span class="payment-icon">↗</span><strong>${esc(f.platform)} ads</strong><span>${dateLabel(f.createdAt)}</span><em>${money(f.amount)}</em><span class="status-pill ${f.status==='Funded'?'':'neutral'}">${esc(f.status)}</span></div>`).join(''):'<div class="empty-state">No advertising funds added yet.</div>';const fundForm=qs('#adFundForm');if(fundForm){fundForm.style.display=state.user?.role==='owner'?'none':'grid';if(state.user?.role==='owner')qs('#adFundStatus').textContent='Client approves/funds the advertising budget. You manage campaign delivery and record performance from this workspace.';}
}
function renderAnalytics(){const closed=state.leads.filter(l=>['Won','Lost'].includes(l.status));const won=state.leads.filter(l=>l.status==='Won');const collected=state.invoices.filter(i=>i.status==='Paid').reduce((s,i)=>s+Number(i.amount||0),0);qs('#analyticsLeads').textContent=state.leads.length;qs('#analyticsWinRate').textContent=closed.length?`${Math.round(won.length/closed.length*100)}%`:'0%';qs('#analyticsBookings').textContent=state.appointments.length;qs('#analyticsRevenue').textContent=money(collected);renderAnalyticsBars('#analyticsPipeline',['New','Contacted','Quoted','Won','Lost'].map(k=>[k,state.leads.filter(l=>l.status===k).length]));const src={};state.leads.forEach(l=>src[l.source||'Unknown']=(src[l.source||'Unknown']||0)+1);renderAnalyticsBars('#analyticsSources',Object.entries(src).sort((a,b)=>b[1]-a[1]));renderAdSpend(collected);const form=qs('#adSpendForm');if(form){form.style.display=state.user?.role==='owner'?'grid':'none';const status=qs('#adSpendStatus');if(status&&state.user?.role!=='owner')status.textContent='Campaign spend is managed and reported by SiteRemade.';}}
function renderAnalyticsBars(sel,rows){const max=Math.max(1,...rows.map(r=>r[1]));qs(sel).innerHTML=rows.map(([label,n])=>`<div class="analytics-row"><div><strong>${esc(label)}</strong><span>${n}</span></div><div class="analytics-track"><i style="width:${n/max*100}%"></i></div></div>`).join('')||'<div class="empty-state">No data yet.</div>';}
function renderWebsiteTraffic(){const a=state.websiteAnalytics||{},domain=qs('#trafficDomain'),status=qs('#trafficConnectionStatus');if(domain)domain.value=a.domain||'';if(qs('#trafficSessions'))qs('#trafficSessions').textContent=a.connected?Number(a.sessions||0).toLocaleString('en-CA'):'—';if(qs('#trafficUsers'))qs('#trafficUsers').textContent=a.connected?Number(a.users||0).toLocaleString('en-CA'):'—';if(qs('#trafficPageviews'))qs('#trafficPageviews').textContent=a.connected?Number(a.pageviews||0).toLocaleString('en-CA'):'—';if(qs('#trafficLastSync'))qs('#trafficLastSync').textContent=a.lastSync?dateTimeLabel(a.lastSync):'Not connected';if(status){status.textContent=a.connected?'GOOGLE ANALYTICS CONNECTED':a.domain?'DOMAIN SAVED · ANALYTICS NOT CONNECTED':'ADD WEBSITE DOMAIN';status.classList.toggle('neutral',!a.connected);}}
function renderWebsiteUpdates(){
  const rows=(state.websiteUpdates||[]).filter(r=>!r.projectId),list=qs('#websiteUpdateList'),count=qs('#websiteUpdateCount'),badge=qs('#websiteUpdateBadge');
  const open=rows.filter(r=>r.status!=='Completed').length;
  if(count)count.textContent=`${rows.length} REQUEST${rows.length===1?'':'S'}`;
  if(badge){badge.textContent=open;badge.style.display=open?'grid':'none';}
  if(!list)return;
  list.innerHTML=rows.length?rows.map(r=>`<article class="website-update-item"><div class="website-update-top"><div><span class="website-update-page">${esc(r.page)}</span><strong>${esc(r.request)}</strong></div><span class="status-pill ${r.status==='Completed'?'':'neutral'}">${esc(r.status.toUpperCase())}</span></div><p>${esc(r.notes||'No extra notes.')}</p><div class="website-update-meta"><span>${esc(r.priority)} priority · ${dateTimeLabel(r.createdAt)}</span>${state.user?.role==='owner'?`<select class="website-update-status" data-update-status="${r.id}">${['Requested','In Progress','Completed'].map(x=>`<option ${x===r.status?'selected':''}>${x}</option>`).join('')}</select>`:''}</div></article>`).join(''):'<div class="empty-state">No website update requests yet.</div>';
  qsa('[data-update-status]').forEach(sel=>sel.onchange=()=>updateWebsiteRequest(sel.dataset.updateStatus,sel.value));
}

// Website Projects — Lead → Start Website Project → Structured Intake → Build Brief →
// Building → Client Review → Revisions → Payment/Handoff → Delivered → Ongoing Updates.
// Revisions and client feedback share the website_updates table with the legacy
// general-request flow above (see server.js mapProject/mapWebsiteUpdate).
const PROJECT_STATUSES=['Intake','Brief Ready','Building','Review','Delivered'];
// Website Projects structured intake/brief (product-experience pass): the
// intake and brief data shapes stored by the backend are unchanged — these
// are just pick-lists that make filling them in faster than typing free
// text, with a "Custom…"/typed fallback everywhere so nothing is a closed
// list. See PHASE3-ROUTE-MAP.md for why this page needed the rework.
const PROJECT_STYLE_PRESETS=['Modern & minimal','Bold & editorial','Warm & approachable','Corporate & professional','Luxury & refined','Rustic & handcrafted','Playful & vibrant'];
const PROJECT_SECTION_PRESETS=['Home','About','Services','Gallery / Portfolio','Testimonials','FAQ','Service Area','Pricing','Contact','Blog'];
const PROJECT_COLOR_PRESETS=['#0d0e11','#315cff','#14865d','#b67716','#c54747','#7750b8','#1c1c1c','#ffffff'];
function styleFieldHtml(idPrefix,current){
  const isPreset=PROJECT_STYLE_PRESETS.includes(current);
  return `<label>Style / direction<select id="${idPrefix}Select">
    <option value="">Choose a style…</option>
    ${PROJECT_STYLE_PRESETS.map(s=>`<option ${s===current?'selected':''}>${esc(s)}</option>`).join('')}
    <option value="__custom__" ${current&&!isPreset?'selected':''}>Custom…</option>
  </select></label>
  <label class="wide-field" id="${idPrefix}CustomWrap" style="${current&&!isPreset?'':'display:none'}">Custom style description<input id="${idPrefix}CustomInput" value="${esc(!isPreset?(current||''):'')}" /></label>`;
}
function wireStylePicker(idPrefix){
  const sel=qs('#'+idPrefix+'Select');if(!sel)return;
  sel.onchange=()=>{const wrap=qs('#'+idPrefix+'CustomWrap');if(wrap)wrap.style.display=sel.value==='__custom__'?'':'none';};
}
function collectStyle(idPrefix){
  const sel=qs('#'+idPrefix+'Select');if(!sel)return'';
  return sel.value==='__custom__'?(qs('#'+idPrefix+'CustomInput')?.value||'').trim():sel.value;
}
function colorChipHtml(c,readOnly){return `<span class="color-chip" data-color-chip="${esc(c)}"><i style="background:${esc(c)}"></i>${esc(c)}${readOnly?'':'<button type="button" class="chip-remove" data-remove-color>×</button>'}</span>`;}
function colorPickerHtml(idPrefix,colors=[]){
  return `<div class="chip-row" id="${idPrefix}Chips">${colors.map(c=>colorChipHtml(c)).join('')}</div>
    <div class="color-picker-row">
      ${PROJECT_COLOR_PRESETS.map(c=>`<button type="button" class="color-swatch-button" style="background:${c}" data-add-color="${idPrefix}" data-color="${c}" title="${c}"></button>`).join('')}
      <span class="custom-color-row"><input type="color" id="${idPrefix}CustomInput" value="#315cff" /><button type="button" class="secondary-button" data-add-custom-color="${idPrefix}">Add</button></span>
    </div>`;
}
function wireColorRemoveButtons(idPrefix){
  const host=qs('#'+idPrefix+'Chips');if(!host)return;
  host.querySelectorAll('[data-remove-color]').forEach(btn=>btn.onclick=()=>btn.closest('.color-chip').remove());
}
function addColorChip(idPrefix,color){
  const host=qs('#'+idPrefix+'Chips');if(!host||!color)return;
  if([...host.querySelectorAll('[data-color-chip]')].some(c=>c.dataset.colorChip.toLowerCase()===color.toLowerCase()))return;
  host.insertAdjacentHTML('beforeend',colorChipHtml(color));
  wireColorRemoveButtons(idPrefix);
}
function wireColorPicker(idPrefix){
  qsa(`[data-add-color="${idPrefix}"]`).forEach(btn=>btn.onclick=()=>addColorChip(idPrefix,btn.dataset.color));
  const addCustom=qs(`[data-add-custom-color="${idPrefix}"]`);
  if(addCustom)addCustom.onclick=()=>addColorChip(idPrefix,qs('#'+idPrefix+'CustomInput').value);
  wireColorRemoveButtons(idPrefix);
}
function collectColors(idPrefix){
  const host=qs('#'+idPrefix+'Chips');if(!host)return[];
  return [...host.querySelectorAll('[data-color-chip]')].map(c=>c.dataset.colorChip);
}
function customChipHtml(attr,s){return `<span class="color-chip" data-${attr}="${esc(s)}">${esc(s)}<button type="button" class="chip-remove" data-remove-${attr}>×</button></span>`;}
function sectionsPickerHtml(idPrefix,selected=[]){
  const customOnes=selected.filter(s=>!PROJECT_SECTION_PRESETS.includes(s));
  return `<div class="chip-row" id="${idPrefix}Presets">${PROJECT_SECTION_PRESETS.map(s=>`<button type="button" class="option-chip ${selected.includes(s)?'selected':''}" data-toggle-section="${idPrefix}" data-section="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    <div class="chip-row" id="${idPrefix}Custom">${customOnes.map(s=>customChipHtml('custom-section',s)).join('')}</div>
    <div style="display:flex;gap:6px;margin-top:6px"><input id="${idPrefix}CustomInput" placeholder="Add a custom section" style="flex:1;border:1px solid var(--line);border-radius:11px;padding:9px 11px" /><button type="button" class="secondary-button" data-add-custom-section="${idPrefix}">Add</button></div>`;
}
function wireCustomSectionRemove(idPrefix){
  const host=qs('#'+idPrefix+'Custom');if(!host)return;
  host.querySelectorAll('[data-remove-custom-section]').forEach(btn=>btn.onclick=()=>btn.closest('.color-chip').remove());
}
function wireSectionsPicker(idPrefix){
  qsa(`[data-toggle-section="${idPrefix}"]`).forEach(btn=>btn.onclick=()=>btn.classList.toggle('selected'));
  const addCustom=qs(`[data-add-custom-section="${idPrefix}"]`);
  if(addCustom)addCustom.onclick=()=>{
    const input=qs('#'+idPrefix+'CustomInput'),v=(input.value||'').trim();if(!v)return;
    const host=qs('#'+idPrefix+'Custom');
    if([...host.querySelectorAll('[data-custom-section]')].some(c=>c.dataset.customSection.toLowerCase()===v.toLowerCase())){input.value='';return;}
    host.insertAdjacentHTML('beforeend',customChipHtml('custom-section',v));
    wireCustomSectionRemove(idPrefix);input.value='';
  };
  wireCustomSectionRemove(idPrefix);
}
function collectSections(idPrefix){
  const presets=qsa(`[data-toggle-section="${idPrefix}"].selected`).map(b=>b.dataset.section);
  const customs=[...(qs('#'+idPrefix+'Custom')?.querySelectorAll('[data-custom-section]')||[])].map(c=>c.dataset.customSection);
  return [...presets,...customs];
}
function briefListRowHtml(fields,item={}){
  return `<div class="list-editor-row ${fields.length>1?'two-field':''}">
    ${fields.map(f=>f.long?`<textarea data-f="${f.key}" rows="2" placeholder="${esc(f.placeholder||'')}">${esc(item[f.key]||'')}</textarea>`:`<input data-f="${f.key}" placeholder="${esc(f.placeholder||'')}" value="${esc(item[f.key]||'')}" />`).join('')}
    <button type="button" class="list-editor-remove">×</button>
  </div>`;
}
function briefListHtml(idPrefix,items,fields){
  return `<div class="list-editor" id="${idPrefix}">${(items||[]).map(item=>briefListRowHtml(fields,item)).join('')}</div>
    <button type="button" class="secondary-button list-editor-add" data-list="${idPrefix}">+ Add</button>`;
}
const BRIEF_LIST_FIELDS={
  briefServicesList:[{key:'name',placeholder:'Service name'},{key:'description',placeholder:'Short description',long:true}],
  briefFaqList:[{key:'question',placeholder:'Question'},{key:'answer',placeholder:'Answer',long:true}]
};
function wireBriefListEditors(){
  qsa('.list-editor-remove').forEach(btn=>btn.onclick=()=>btn.closest('.list-editor-row').remove());
  qsa('.list-editor-add').forEach(btn=>btn.onclick=()=>{
    const fields=BRIEF_LIST_FIELDS[btn.dataset.list];if(!fields)return;
    qs('#'+btn.dataset.list).insertAdjacentHTML('beforeend',briefListRowHtml(fields));
    wireBriefListEditors();
  });
}
function collectListItems(idPrefix){
  const fields=BRIEF_LIST_FIELDS[idPrefix];
  return qsa(`#${idPrefix} .list-editor-row`).map(row=>{
    const obj={};fields.forEach(f=>{obj[f.key]=(row.querySelector(`[data-f="${f.key}"]`)?.value||'').trim();});
    return obj;
  }).filter(o=>Object.values(o).some(Boolean));
}
function linesToList(v){return String(v||'').split('\n').map(x=>x.trim()).filter(Boolean);}
function briefEditorHtml(brief){
  const b=brief&&Object.keys(brief).length?brief:{},sd=b.styleDirection||{},content=b.content||{},hero=content.hero||{},qform=content.quoteForm||{};
  return `
    <label class="wide-field">Summary<textarea id="briefSummary" rows="2" placeholder="A short summary of this website project">${esc(b.summary||'')}</textarea></label>
    <label class="wide-field">Business positioning<textarea id="briefPositioning" rows="2" placeholder="How this business should be positioned">${esc(b.businessPositioning||'')}</textarea></label>
    <p class="brief-subhead">Style direction</p>
    ${styleFieldHtml('briefStyle',sd.style||'')}
    <label>Visual tone<input id="briefVisualTone" value="${esc(sd.visualTone||'')}" placeholder="e.g. crisp, confident, calm" /></label>
    <label>Typography<input id="briefTypography" value="${esc(sd.typography||'')}" placeholder="Font personality / hierarchy" /></label>
    <label class="wide-field">Colors / branding${colorPickerHtml('briefColors',sd.colors||[])}</label>
    <label class="wide-field">Layout guidance<textarea id="briefLayout" rows="2">${esc(sd.layout||'')}</textarea></label>
    <label class="wide-field">Motion guidance<textarea id="briefMotion" rows="2">${esc(sd.motion||'')}</textarea></label>
    <p class="brief-subhead">Hero section</p>
    <label>Kicker<input id="briefHeroKicker" value="${esc(hero.kicker||'')}" /></label>
    <label>Headline<input id="briefHeroHeadline" value="${esc(hero.headline||'')}" /></label>
    <label class="wide-field">Subhead<textarea id="briefHeroSubhead" rows="2">${esc(hero.subhead||'')}</textarea></label>
    <label>Primary CTA<input id="briefHeroPrimaryCta" value="${esc(hero.primaryCta||'')}" /></label>
    <label>Secondary CTA<input id="briefHeroSecondaryCta" value="${esc(hero.secondaryCta||'')}" /></label>
    <p class="brief-subhead">Services</p>
    <label class="wide-field">${briefListHtml('briefServicesList',content.services||[],BRIEF_LIST_FIELDS.briefServicesList)}</label>
    <p class="brief-subhead">Trust points (one per line)</p>
    <label class="wide-field"><textarea id="briefTrust" rows="3" placeholder="Only points supported by the client's actual information">${esc((content.trust||[]).join('\n'))}</textarea></label>
    <p class="brief-subhead">About</p>
    <label class="wide-field"><textarea id="briefAbout" rows="3">${esc(content.about||'')}</textarea></label>
    <p class="brief-subhead">FAQ</p>
    <label class="wide-field">${briefListHtml('briefFaqList',content.faq||[],BRIEF_LIST_FIELDS.briefFaqList)}</label>
    <p class="brief-subhead">Quote / contact form</p>
    <label>Fields to collect (comma separated)<input id="briefQuoteFields" value="${esc((qform.fields||[]).join(', '))}" /></label>
    <label class="wide-field">Intro copy<input id="briefQuoteIntro" value="${esc(qform.intro||'')}" /></label>
    <p class="brief-subhead">Build rules (one per line)</p>
    <label class="wide-field"><textarea id="briefBuildRules" rows="3">${esc((b.buildRules||[]).join('\n'))}</textarea></label>
    <p class="brief-subhead">Avoid (one per line)</p>
    <label class="wide-field"><textarea id="briefAvoid" rows="3" placeholder="Things that would make this feel cheap or generic">${esc((b.avoid||[]).join('\n'))}</textarea></label>
  `;
}
function wireBriefEditor(){wireStylePicker('briefStyle');wireColorPicker('briefColors');wireBriefListEditors();}
function collectBriefFromEditor(){
  return {
    summary:qs('#briefSummary').value.trim(),
    businessPositioning:qs('#briefPositioning').value.trim(),
    styleDirection:{style:collectStyle('briefStyle'),visualTone:qs('#briefVisualTone').value.trim(),colors:collectColors('briefColors'),typography:qs('#briefTypography').value.trim(),layout:qs('#briefLayout').value.trim(),motion:qs('#briefMotion').value.trim()},
    content:{hero:{kicker:qs('#briefHeroKicker').value.trim(),headline:qs('#briefHeroHeadline').value.trim(),subhead:qs('#briefHeroSubhead').value.trim(),primaryCta:qs('#briefHeroPrimaryCta').value.trim(),secondaryCta:qs('#briefHeroSecondaryCta').value.trim()},services:collectListItems('briefServicesList'),trust:linesToList(qs('#briefTrust').value),about:qs('#briefAbout').value.trim(),faq:collectListItems('briefFaqList'),quoteForm:{fields:(qs('#briefQuoteFields').value||'').split(',').map(x=>x.trim()).filter(Boolean),intro:qs('#briefQuoteIntro').value.trim()}},
    buildRules:linesToList(qs('#briefBuildRules').value),
    avoid:linesToList(qs('#briefAvoid').value),
    builderPrompt:qs('#projectBuilderPrompt')?.value||''
  };
}
function briefSummaryReadOnlyHtml(brief){
  const b=brief||{},sd=b.styleDirection||{},content=b.content||{},hero=content.hero||{};
  const row=(label,val)=>val?`<div class="setting-row"><div><strong>${esc(label)}</strong><span>${esc(val)}</span></div></div>`:'';
  return `
    ${row('Summary',b.summary)}
    ${row('Positioning',b.businessPositioning)}
    ${row('Style',sd.style)}
    ${(sd.colors||[]).length?`<div class="chip-row">${sd.colors.map(c=>colorChipHtml(c,true)).join('')}</div>`:''}
    ${row('Headline',hero.headline)}
    ${(content.services||[]).length?`<div class="setting-row"><div><strong>Services</strong><span>${esc(content.services.map(s=>s.name).filter(Boolean).join(', '))}</span></div></div>`:''}
    ${(b.avoid||[]).length?`<div class="setting-row"><div><strong>Avoid</strong><span>${esc(b.avoid.join('; '))}</span></div></div>`:''}
  `;
}
function findLeadWebsiteProject(leadId){return (state.websiteProjects||[]).find(p=>p.leadId===leadId);}
function renderWebsiteProjects(){
  const rows=[...(state.websiteProjects||[])].sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt));
  const list=qs('#websiteProjectList'),count=qs('#websiteProjectCount'),badge=qs('#websiteProjectBadge');
  if(count)count.textContent=`${rows.length} PROJECT${rows.length===1?'':'S'}`;
  const active=rows.filter(p=>p.status!=='Delivered').length;
  if(badge){badge.textContent=active;badge.style.display=active?'grid':'none';}
  if(state.selectedProjectId&&!rows.find(p=>p.id===state.selectedProjectId))state.selectedProjectId=null;
  if(!state.selectedProjectId&&rows[0])state.selectedProjectId=rows[0].id;
  if(list){
    list.innerHTML=rows.length?rows.map(p=>`<button type="button" class="website-update-item" data-project="${p.id}" style="text-align:left;width:100%;cursor:pointer;border:${p.id===state.selectedProjectId?'1px solid var(--accent,#4c6ef5)':'none'}"><div class="website-update-top"><div><span class="website-update-page">${esc(p.status)}</span><strong>${esc(p.businessName||'Untitled project')}</strong></div><span class="status-pill ${p.clientReviewStatus==='approved'?'':'neutral'}">${esc((p.clientReviewStatus||'not_submitted').replace('_',' ').toUpperCase())}</span></div><p>${p.revisionCount||0} revision${p.revisionCount===1?'':'s'} · ${esc((p.payment&&p.payment.paymentStatus||'none').toUpperCase())}</p></button>`).join(''):'<div class="empty-state">No website projects yet. Start one from a lead.</div>';
    qsa('[data-project]').forEach(b=>b.onclick=()=>{state.selectedProjectId=b.dataset.project;renderWebsiteProjects();});
  }
  renderProjectDetail();
}
function renderProjectDetail(){
  const host=qs('#websiteProjectDetail'),title=qs('#websiteProjectDetailTitle');
  if(!host)return;
  const p=(state.websiteProjects||[]).find(x=>x.id===state.selectedProjectId);
  if(!p){if(title)title.textContent='Select a project';host.innerHTML='<div class="empty-state">Choose a project on the left to view its intake, brief and review status.</div>';return;}
  if(title)title.textContent=p.businessName||'Website project';
  const lead=state.leads.find(l=>l.id===p.leadId);
  const intake=p.intake||{},vd=intake.visualDirection||{};
  if(state.user?.role==='owner'){
    host.innerHTML=`
      <div class="project-section">
        <div class="settings-grid" style="grid-template-columns:1fr 1fr">
          <div class="setting-row"><div><strong>Lead</strong><span>${esc(lead?.name||'—')}</span></div></div>
          <div class="setting-row"><div><strong>Payment</strong><span>${esc((p.payment&&p.payment.paymentStatus||'none').toUpperCase())} · ${p.payment?.invoiceCount||0} invoice(s)</span></div></div>
        </div>
        <label>Status<select id="projectStatusSelect">${PROJECT_STATUSES.map(s=>`<option ${s===p.status?'selected':''}>${s}</option>`).join('')}</select></label>
      </div>
      <form id="projectIntakeForm">
        <div class="project-section">
          <div class="project-section-head"><div><p class="eyebrow">BUSINESS &amp; PROJECT</p><h3>What the site is for</h3></div></div>
          <div class="website-update-form">
            <label class="wide-field">Business identity<textarea name="businessIdentity" rows="2" placeholder="What this business does, who it's for">${esc(intake.businessIdentity||'')}</textarea></label>
            <label>Current website (if any)<input name="currentWebsiteUrl" value="${esc(intake.currentWebsiteUrl||'')}" placeholder="https://…" /></label>
            <label class="wide-field">Website goals<textarea name="goals" rows="2" placeholder="What should this site accomplish for the business?">${esc(intake.goals||'')}</textarea></label>
          </div>
        </div>
        <div class="project-section">
          <div class="project-section-head"><div><p class="eyebrow">STYLE &amp; DIRECTION</p><h3>Look and feel</h3></div></div>
          <div class="website-update-form">
            ${styleFieldHtml('intakeStyle',vd.style||'')}
            <label>Typography<input name="visualTypography" value="${esc(vd.typography||'')}" placeholder="e.g. clean sans-serif, editorial serif" /></label>
            <label class="wide-field">Visual notes<textarea name="visualNotes" rows="2" placeholder="Anything else about the look and feel">${esc(vd.notes||'')}</textarea></label>
          </div>
        </div>
        <div class="project-section">
          <div class="project-section-head"><div><p class="eyebrow">COLORS &amp; BRANDING</p><h3>Palette and logo</h3></div></div>
          ${colorPickerHtml('intakeColors',vd.colors||[])}
          <div class="website-update-form" style="margin-top:10px">
            <label class="wide-field">Logo / asset links (comma separated)<input name="logoAssets" value="${esc((intake.logoAssets||[]).join(', '))}" placeholder="Links to logo files, brand guide, etc." /></label>
          </div>
        </div>
        <div class="project-section">
          <div class="project-section-head"><div><p class="eyebrow">DESIRED SECTIONS</p><h3>Pages this site needs</h3></div></div>
          ${sectionsPickerHtml('intakeSections',intake.desiredPages||[])}
        </div>
        <div class="project-section">
          <div class="project-section-head"><div><p class="eyebrow">SERVICES &amp; SERVICE AREA</p><h3>What they offer, and where</h3></div></div>
          <div class="website-update-form">
            <label class="wide-field">Services<textarea name="services" rows="2" placeholder="Services to feature on the site">${esc(intake.services||'')}</textarea></label>
            <label>Service area<input name="serviceArea" value="${esc(intake.serviceArea||'')}" placeholder="Cities / region served" /></label>
          </div>
        </div>
        <div class="project-section">
          <div class="project-section-head"><div><p class="eyebrow">ASSETS &amp; CONTENT</p><h3>What the client supplied</h3></div></div>
          <div class="website-update-form">
            <label class="wide-field">Examples / references (comma separated)<textarea name="references" rows="2" placeholder="Sites they like, for style reference">${esc((intake.references||[]).join(', '))}</textarea></label>
          </div>
        </div>
        <div class="project-section">
          <div class="project-section-head"><div><p class="eyebrow">ADDITIONAL INSTRUCTIONS</p></div></div>
          <div class="website-update-form">
            <label class="wide-field">Anything else the builder should know<textarea name="notes" rows="2">${esc(intake.notes||'')}</textarea></label>
            <button class="primary-action" type="submit">Save intake</button>
            <p class="modal-status" id="projectIntakeStatus"></p>
          </div>
        </div>
      </form>
      <div class="project-section">
        <div class="project-section-head"><div><p class="eyebrow">GENERATED BRIEF</p><h3>What the builder will work from</h3></div><button type="button" class="secondary-button" id="generateBriefButton">Generate with AI</button></div>
        <div class="website-update-form" id="briefEditorHost">${briefEditorHtml(p.brief)}</div>
        <label class="wide-field" style="margin-top:8px">Builder / export prompt<textarea id="projectBuilderPrompt" rows="4">${esc(p.builderPrompt||'')}</textarea></label>
        <div style="display:flex;gap:8px;align-items:center;margin:10px 0">
          <button type="button" class="secondary-button" id="saveBriefButton">Save brief</button>
          <button type="button" class="json-toggle" id="briefJsonToggle">View/edit as raw JSON</button>
        </div>
        <textarea id="projectBriefText" rows="12" hidden style="width:100%;font-family:monospace">${esc(JSON.stringify(p.brief&&Object.keys(p.brief).length?p.brief:{summary:''},null,2))}</textarea>
        <p class="modal-status" id="projectBriefStatus"></p>
      </div>
      ${(p.briefHistory||[]).length?`
      <div class="project-section">
        <div class="project-section-head"><div><p class="eyebrow">BRIEF HISTORY</p><h3>${p.briefHistory.length} prior version${p.briefHistory.length===1?'':'s'}</h3></div></div>
        <div class="brief-history-list">${p.briefHistory.map(h=>`<details class="brief-history-item"><summary><strong>${esc(h.summary||'Untitled version')}</strong><span>Replaced ${dateTimeLabel(h._replacedAt)}</span></summary><div class="brief-history-body">${briefSummaryReadOnlyHtml(h)||'<p class="helper-copy">No details recorded for this version.</p>'}</div></details>`).join('')}</div>
      </div>`:''}
      <div class="project-section">
        <div class="project-section-head"><div><p class="eyebrow">PREVIEW &amp; LIVE URL</p></div></div>
        <div class="form-grid">
          <label>Preview / review URL<input id="projectPreviewUrl" value="${esc(p.previewUrl||'')}" /></label>
          <label>Live URL<input id="projectLiveUrl" value="${esc(p.liveUrl||'')}" /></label>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0">
          <button type="button" class="secondary-button" id="saveUrlsButton">Save URLs</button>
          <button type="button" class="primary-action" id="markDeliveredButton" ${p.status==='Delivered'?'disabled':''}>${p.status==='Delivered'?'Delivered':'Mark delivered'}</button>
          <button type="button" class="secondary-button" id="createProjectInvoiceButton">Create invoice for this project</button>
        </div>
      </div>
      <div class="project-section">
        <div class="project-section-head"><div><p class="eyebrow">CLIENT REVIEW &amp; PROJECT STATUS</p></div><span class="status-pill ${p.clientReviewStatus==='approved'?'':'neutral'}">${esc((p.clientReviewStatus||'not_submitted').replace('_',' ').toUpperCase())}</span></div>
        ${p.clientReviewFeedback?`<p class="helper-copy">Latest client feedback: ${esc(p.clientReviewFeedback)}</p>`:'<p class="helper-copy">No client feedback yet.</p>'}
      </div>
      <div class="project-section">
        <div class="project-section-head"><div><p class="eyebrow">ADD REVISION</p></div></div>
        <form id="projectRevisionForm" class="website-update-form">
          <label>Page<input name="page" placeholder="Home" /></label>
          <label class="wide-field">What changed<textarea name="request" rows="2" required></textarea></label>
          <button class="secondary-button" type="submit">Add revision</button>
        </form>
      </div>
      <div class="project-section">
        <div class="project-section-head"><div><p class="eyebrow">REVISIONS &amp; FEEDBACK</p></div></div>
        <div class="website-update-list">${(p.revisions||[]).length?p.revisions.map(r=>`<article class="website-update-item"><div class="website-update-top"><div><span class="website-update-page">${esc(r.kind)}</span><strong>${esc(r.request)}</strong></div></div><div class="website-update-meta"><span>${dateTimeLabel(r.createdAt)}</span></div></article>`).join(''):'<div class="empty-state">No revisions yet.</div>'}</div>
      </div>
    `;
    wireStylePicker('intakeStyle');wireColorPicker('intakeColors');wireSectionsPicker('intakeSections');wireBriefEditor();
    qs('#projectStatusSelect').onchange=e=>patchProject(p.id,{status:e.target.value});
    qs('#projectIntakeForm').onsubmit=e=>{
      e.preventDefault();const f=Object.fromEntries(new FormData(e.currentTarget));
      const intakePayload={businessIdentity:f.businessIdentity,services:f.services,serviceArea:f.serviceArea,currentWebsiteUrl:f.currentWebsiteUrl,goals:f.goals,desiredPages:collectSections('intakeSections'),visualDirection:{style:collectStyle('intakeStyle'),colors:collectColors('intakeColors'),typography:f.visualTypography,notes:f.visualNotes},logoAssets:(f.logoAssets||'').split(',').map(x=>x.trim()).filter(Boolean),references:(f.references||'').split(',').map(x=>x.trim()).filter(Boolean),notes:f.notes};
      qs('#projectIntakeStatus').textContent='Saving…';patchProject(p.id,{intake:intakePayload},'#projectIntakeStatus');
    };
    qs('#generateBriefButton').onclick=()=>generateBrief(p.id);
    qs('#briefJsonToggle').onclick=()=>{
      const structured=qs('#briefEditorHost'),raw=qs('#projectBriefText');
      if(raw.hidden){try{raw.value=JSON.stringify(collectBriefFromEditor(),null,2);}catch{}structured.hidden=true;raw.hidden=false;qs('#briefJsonToggle').textContent='Back to structured view';}
      else{try{const parsed=JSON.parse(raw.value||'{}');structured.innerHTML=briefEditorHtml(parsed);wireBriefEditor();}catch{qs('#projectBriefStatus').textContent='That JSON could not be parsed — fix it or switch back without saving.';return;}structured.hidden=false;raw.hidden=true;qs('#briefJsonToggle').textContent='View/edit as raw JSON';}
    };
    qs('#saveBriefButton').onclick=()=>{
      let briefObj;
      if(!qs('#projectBriefText').hidden){try{briefObj=JSON.parse(qs('#projectBriefText').value||'{}');}catch{qs('#projectBriefStatus').textContent='Brief must be valid JSON.';return;}}
      else{briefObj=collectBriefFromEditor();}
      const builderPrompt=qs('#projectBuilderPrompt').value;
      patchProject(p.id,{brief:briefObj,builderPrompt},'#projectBriefStatus');
    };
    qs('#saveUrlsButton').onclick=()=>patchProject(p.id,{previewUrl:qs('#projectPreviewUrl').value,liveUrl:qs('#projectLiveUrl').value});
    qs('#markDeliveredButton').onclick=()=>{if(p.status==='Delivered')return;patchProject(p.id,{status:'Delivered',deliveredAt:new Date().toISOString()});};
    qs('#createProjectInvoiceButton').onclick=()=>{const pid=qs('#invoiceProjectId');if(pid)pid.value=p.id;const sel=qs('#invoiceLead');if(sel)sel.value=p.leadId;showModal('invoiceModal');};
    qs('#projectRevisionForm').onsubmit=e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.currentTarget));addRevision(p.id,f);e.currentTarget.reset();};
  }else{
    const canReview=!!p.previewUrl||['Review','Delivered'].includes(p.status);
    host.innerHTML=`
      <div class="setting-row"><div><strong>Status</strong><span>${esc(p.status)}</span></div></div>
      ${p.previewUrl?`<div class="setting-row"><div><strong>Preview</strong><span><a href="${esc(p.previewUrl)}" target="_blank" rel="noopener">${esc(p.previewUrl)}</a></span></div></div>`:''}
      ${p.liveUrl?`<div class="setting-row"><div><strong>Live site</strong><span><a href="${esc(p.liveUrl)}" target="_blank" rel="noopener">${esc(p.liveUrl)}</a></span></div></div>`:''}
      <div class="setting-row"><div><strong>Payment</strong><span>${esc((p.payment&&p.payment.paymentStatus||'none').toUpperCase())}</span></div></div>
      ${canReview?`
      <div class="panel-head" style="padding:16px 0 8px"><div><p class="eyebrow">REVIEW</p></div><span class="status-pill ${p.clientReviewStatus==='approved'?'':'neutral'}">${esc((p.clientReviewStatus||'not_submitted').replace('_',' ').toUpperCase())}</span></div>
      <form id="projectReviewForm" class="website-update-form">
        <label class="wide-field">Feedback (optional if approving)<textarea name="feedback" rows="3" placeholder="Anything you'd like changed before this goes live?"></textarea></label>
        <div style="display:flex;gap:8px"><button class="primary-action" type="submit">Approve</button><button class="secondary-button" type="button" id="requestChangesButton">Request changes</button></div>
        <p class="modal-status" id="projectReviewStatus"></p>
      </form>`:'<div class="empty-state">Your website preview isn’t ready for review yet.</div>'}
      <div class="panel-head" style="padding:16px 0 8px"><div><p class="eyebrow">HISTORY</p></div></div>
      <div class="website-update-list">${(p.revisions||[]).length?p.revisions.map(r=>`<article class="website-update-item"><div class="website-update-top"><div><strong>${esc(r.request)}</strong></div></div><div class="website-update-meta"><span>${dateTimeLabel(r.createdAt)}</span></div></article>`).join(''):'<div class="empty-state">No history yet.</div>'}</div>
    `;
    if(canReview){
      qs('#projectReviewForm').onsubmit=e=>{e.preventDefault();const feedback=new FormData(e.currentTarget).get('feedback');submitReview(p.id,'approved',feedback);};
      qs('#requestChangesButton').onclick=()=>{const feedback=qs('#projectReviewForm [name=feedback]').value;if(!feedback.trim()){alert('Add a note about what should change before requesting changes.');return;}submitReview(p.id,'changes_requested',feedback);};
    }
  }
}
async function patchProject(id,patch,statusSel){
  try{
    const d=await api(`/api/app/website-projects/${id}`,{method:'PATCH',body:JSON.stringify(patch)});
    const i=state.websiteProjects.findIndex(x=>x.id===id);if(i>=0)state.websiteProjects[i]={...state.websiteProjects[i],...d.project};
    renderWebsiteProjects();if(state.selectedLeadId)renderDrawerProject(state.leads.find(l=>l.id===state.selectedLeadId));
    if(statusSel&&qs(statusSel))qs(statusSel).textContent='Saved.';
  }catch(e){if(statusSel&&qs(statusSel))qs(statusSel).textContent=e.message;else alert(e.message);}
}
async function generateBrief(id){
  const btn=qs('#generateBriefButton');if(btn){btn.disabled=true;btn.textContent='Generating…';}
  const st=qs('#projectBriefStatus');if(st)st.textContent='';
  try{
    const d=await api(`/api/app/website-projects/${id}/brief`,{method:'POST'});
    const i=state.websiteProjects.findIndex(x=>x.id===id);if(i>=0)state.websiteProjects[i]=d.project;
    renderWebsiteProjects();
  }catch(e){if(st)st.textContent=e.message;else alert(e.message);}
  finally{if(btn){btn.disabled=false;btn.textContent='Generate with AI';}}
}
async function addRevision(id,f){
  try{
    await api(`/api/app/website-projects/${id}/revisions`,{method:'POST',body:JSON.stringify(f)});
    await refreshProjectsOnly();
  }catch(e){alert(e.message)}
}
async function submitReview(id,decision,feedback){
  try{
    const d=await api(`/api/app/website-projects/${id}/review`,{method:'POST',body:JSON.stringify({decision,feedback})});
    const i=state.websiteProjects.findIndex(x=>x.id===id);if(i>=0)state.websiteProjects[i]=d.project;
    renderWebsiteProjects();
  }catch(e){const st=qs('#projectReviewStatus');if(st)st.textContent=e.message;else alert(e.message)}
}
async function startWebsiteProject(leadId){
  try{
    const d=await api('/api/app/website-projects',{method:'POST',body:JSON.stringify({leadId})});
    const i=state.websiteProjects.findIndex(x=>x.id===d.project.id);
    if(i>=0)state.websiteProjects[i]=d.project;else state.websiteProjects.unshift(d.project);
    state.selectedProjectId=d.project.id;
    renderDrawerProject(state.leads.find(l=>l.id===leadId));
    qs('#leadDrawer').hidden=true;switchView('website-projects');renderWebsiteProjects();
  }catch(e){alert(e.message)}
}
async function refreshProjectsOnly(){
  try{const d=await api('/api/app/website-projects');state.websiteProjects=d.projects||[];renderWebsiteProjects();if(state.selectedLeadId)renderDrawerProject(state.leads.find(l=>l.id===state.selectedLeadId));}catch(e){console.warn('Could not refresh website projects:',e.message)}
}
function renderDrawerProject(l){
  const host=qs('#drawerWebsiteProject');if(!host||!l)return;
  const p=findLeadWebsiteProject(l.id);
  if(!p){host.innerHTML='<button type="button" class="secondary-button" id="startProjectButton">Start Website Project</button>';const b=qs('#startProjectButton');if(b)b.onclick=()=>startWebsiteProject(l.id);return;}
  host.innerHTML=`<button type="button" class="secondary-button" id="openProjectButton">Open Website Project · ${esc(p.status)}</button>`;
  const b=qs('#openProjectButton');if(b)b.onclick=()=>{state.selectedProjectId=p.id;qs('#leadDrawer').hidden=true;switchView('website-projects');renderWebsiteProjects();};
}

function renderAutomations(){qs('#automationList').innerHTML=state.automations.map(a=>`<button class="automation-card automation-toggle" data-auto="${a.id}"><span class="automation-icon">${a.id==='lead-confirmation'?'✦':a.id==='lead-alert'?'↗':'□'}</span><div><strong>${esc(a.name)}</strong><p>${esc(a.description)}</p></div><span class="toggle ${a.enabled?'on':''}"></span></button>`).join('');qsa('[data-auto]').forEach(b=>b.onclick=()=>toggleAutomation(b.dataset.auto));}
function renderSettings(){qs('#settingsBusiness').value=state.workspace.businessName||'';qs('#settingsEmail').value=state.workspace.email||'';qs('#settingsPhone').value=state.workspace.phone||'';qs('#settingsTimezone').value=state.workspace.timezone||'';qs('#aiServices').value=state.workspace.ai?.services||'';qs('#aiServiceArea').value=state.workspace.ai?.serviceArea||'';qs('#aiTone').value=state.workspace.ai?.tone||'';const labels={supabase:'Database + Auth',openai:'AI engine',googlePlaces:'Google Places',resend:'Email',twilio:'SMS',stripe:'Stripe payments'};qs('#integrationList').innerHTML=Object.entries(labels).map(([k,l])=>`<div class="setting-row"><div><strong>${l}</strong><span>${state.integrations[k]?'Connected / configured':'Needs server credentials'}</span></div>${k==='stripe'&&state.integrations.stripe?`<button class="text-button" id="connectStripeButton">${state.workspace.stripeAccountId?'Reconnect':'Connect'}</button>`:`<span class="status-pill ${state.integrations[k]?'':'neutral'}">${state.integrations[k]?'LIVE':'OFF'}</span>`}</div>`).join('');const aiBadge=qs('#aiReceptionistBadge');if(aiBadge){const live=!!state.integrations.openai&&state.workspace.ai?.enabled!==false;aiBadge.textContent=live?'LIVE':'OFF';aiBadge.classList.toggle('neutral',!live);}const sb=qs('#connectStripeButton');if(sb)sb.onclick=async()=>{try{const d=await api('/api/app/integrations/stripe/connect',{method:'POST'});if(d.url)location.href=d.url}catch(e){alert(e.message)}};}
function renderNotifications(){const actionable=[];state.conversations.filter(c=>Number(c.unread)>0).forEach(c=>actionable.push({kind:'conversation',id:c.id,title:`${c.unread} unread · ${c.name}`,detail:c.messages?.[c.messages.length-1]?.text||'New customer message',createdAt:c.updatedAt}));state.leads.filter(l=>l.status==='New').forEach(l=>actionable.push({kind:'lead',id:l.id,title:`New lead · ${l.name}`,detail:`${l.service} · ${l.source}`,createdAt:l.createdAt}));const items=[...actionable.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)),...(state.activities||[]).slice(0,8)].slice(0,12);qs('#notificationList').innerHTML=items.length?items.map(a=>`<button class="notification-item" ${a.kind?`data-notify-kind="${a.kind}" data-notify-id="${a.id}"`:''}><strong>${esc(a.title)}</strong><span>${esc(a.detail||'')}</span><small>${relative(a.createdAt)}</small></button>`).join(''):'<div class="empty-state padded">Nothing needs attention.</div>';qsa('[data-notify-kind]').forEach(b=>b.onclick=()=>{qs('#notificationPopover').hidden=true;if(b.dataset.notifyKind==='lead'){switchView('leads');openLead(b.dataset.notifyId);}else{state.selectedConversationId=b.dataset.notifyId;switchView('inbox');renderInbox();}});renderBadges();}
function fillLeadSelects(){for(const id of ['appointmentLead','invoiceLead','conversationLead']){const el=qs('#'+id);if(!el)continue;const current=el.value;el.innerHTML='<option value="">Choose a lead</option>'+state.leads.map(l=>`<option value="${l.id}">${esc(l.name)} — ${esc(l.service)}</option>`).join('');if(current)el.value=current;}}

function renderProspects(){
  const el=qs('#prospectResults');if(!el)return;
  const purpose=state.prospects[0]?.purpose||qs('#prospectPurpose')?.value||'prospects';
  const labels={prospects:'Sales prospects',commercial:'Commercial targets',partners:'Referral partners',competitors:'Competitors'};
  const title=qs('#prospectResultsTitle');if(title)title.textContent=labels[purpose]||'Businesses';
  qs('#prospectCount').textContent=`${state.prospects.length} FOUND`;
  el.innerHTML=state.prospects.length?state.prospects.map((p,i)=>`<div class="prospect-card ${p.viewed?'prospect-viewed':''} ${p.purpose==='competitors'?'competitor-result':''}"><div><div class="prospect-title-row"><h3>${esc(p.name)}</h3>${p.viewed?'<span class="viewed-badge">VIEWED</span>':''}<span class="prospect-purpose-badge">${esc(labels[p.purpose]||'Business')}</span></div><p>${esc(p.address||'')}</p><p>${esc(p.phone||p.website||'No public contact details')}</p><div class="prospect-meta">${p.rating?`<span>★ ${esc(p.rating)} · ${esc(p.reviews||0)} reviews</span>`:'<span>No rating data</span>'}${p.website?'<span>Website</span>':'<span>No website found</span>'}${p.phone?'<span>Phone available</span>':'<span>No phone found</span>'}</div></div><div class="prospect-actions">${p.website?`<button class="text-button" data-view-prospect="${i}" data-prospect-url="${esc(p.website)}">Open website</button>`:(p.mapsUrl?`<button class="text-button" data-view-prospect="${i}" data-prospect-url="${esc(p.mapsUrl)}">Open Google</button>`:'')}${p.mapsUrl&&p.website?`<button class="text-button" data-view-prospect="${i}" data-prospect-url="${esc(p.mapsUrl)}">Google</button>`:''}${p.purpose==='competitors'?`<button class="secondary-button" data-mark-prospect="${i}">${p.viewed?'Reviewed':'Mark reviewed'}</button>`:`<button class="secondary-button" data-import-prospect="${i}">Add to pipeline</button>`}</div></div>`).join(''):'<div class="empty-state">No businesses matched those filters. Widen the filters or try a different category.</div>';
  qsa('[data-view-prospect]').forEach(b=>b.onclick=async()=>{const i=Number(b.dataset.viewProspect),p=state.prospects[i];if(!p)return;window.open(b.dataset.prospectUrl,'_blank','noopener');await markProspectViewed(p);});
  qsa('[data-import-prospect]').forEach(b=>b.onclick=()=>importProspect(Number(b.dataset.importProspect)));
  qsa('[data-mark-prospect]').forEach(b=>b.onclick=async()=>{const p=state.prospects[Number(b.dataset.markProspect)];if(p)await markProspectViewed(p);});
}
async function markProspectViewed(p){if(!p?.placeId||p.viewed)return;try{await api('/api/app/prospects/viewed',{method:'POST',body:JSON.stringify({placeId:p.placeId,name:p.name,website:p.website||''})});p.viewed=true;if(!state.prospectViews.includes(p.placeId))state.prospectViews.push(p.placeId);renderProspects();}catch(e){console.error('Could not save viewed prospect:',e)}}
async function importProspect(i){
  const p=state.prospects[i];if(!p)return;
  try{
    await markProspectViewed(p);
    const source=state.user?.role==='owner'?'SiteRemade':'Market Finder';
    const service=p.purpose==='commercial'?'Commercial prospect':p.purpose==='partners'?'Referral opportunity':'Outbound prospect';
    await api('/api/app/leads',{method:'POST',body:JSON.stringify({name:p.name,phone:p.phone||'',email:'',service,source,message:`${p.address||''}${p.website?` · ${p.website}`:''}${p.rating?` · ${p.rating}★ / ${p.reviews||0} reviews`:''}`})});
    await refreshLight();switchView('leads');
  }catch(e){alert(e.message)}
}
function renderAdSpend(collected=0){
  const rows=state.adSpend||[],spend=rows.reduce((s,r)=>s+Number(r.spend||0),0),leads=rows.reduce((s,r)=>s+Number(r.leads||0),0);
  const spendEl=qs('#adSpendTotal');if(!spendEl)return;
  spendEl.textContent=money(spend);qs('#adLeadTotal').textContent=leads;
  qs('#adCpl').textContent=leads?money(spend/leads):'—';
  qs('#adRoas').textContent=spend?`${(collected/spend).toFixed(1)}×`:'—';
  qs('#adSpendList').innerHTML=rows.length?rows.map(r=>`<div class="ad-spend-row"><div><strong>${esc(r.platform)} · ${esc(r.campaign||'Campaign')}</strong><span>${dateLabel(r.createdAt)} · ${Number(r.leads||0)} leads</span></div><em>${money(r.spend)}</em><span>${r.source==='live'?'LIVE':'MANUAL'}</span></div>`).join(''):'<div class="empty-state">No ad spend recorded yet.</div>';
}
async function askAssistant(prompt){
  const input=qs('#assistantInput'),out=qs('#assistantAnswer'),pill=qs('#assistantStatusPill');
  const text=(prompt||input?.value||'').trim();if(!text)return;
  if(input)input.value='';out.textContent='Thinking…';if(pill)pill.textContent='THINKING';
  try{const d=await api('/api/app/assistant',{method:'POST',body:JSON.stringify({message:text})});out.textContent=d.reply||'No answer returned.';if(pill)pill.textContent=d.ai?'AI':'SMART SUMMARY';}
  catch(e){out.textContent=e.message;if(pill)pill.textContent='ERROR';}
}

async function refreshLight(){const d=await api('/api/app/bootstrap');Object.assign(state,{workspace:d.workspace||{},workspaces:d.workspaces||[],user:d.user||state.user,locked:!!d.locked,integrations:d.integrations||{},leads:d.leads||[],conversations:d.conversations||[],appointments:d.appointments||[],invoices:d.invoices||[],automations:d.automations||[],activities:d.activities||[],adSpend:d.adSpend||[],adFunds:d.adFunds||[],billing:d.billing||{},prospectViews:d.prospectViews||[],websiteAnalytics:d.websiteAnalytics||{},websiteUpdates:d.websiteUpdates||[],websiteProjects:d.websiteProjects||[]});renderAll();}
function switchView(v){qsa('.view').forEach(x=>x.classList.toggle('active',x.id===`view-${v}`));qsa('[data-view]').forEach(x=>x.classList.toggle('active',x.dataset.view===v));const sheet=qs('#mobileMoreSheet'),more=qs('#mobileMoreButton');if(sheet)sheet.hidden=true;if(more)more.setAttribute('aria-expanded','false');window.scrollTo({top:0,behavior:'smooth'});if(v==='leads')setTimeout(()=>{},0);}
function showModal(id){qs('#'+id).hidden=false;}function hideModal(id){qs('#'+id).hidden=true;}

qsa('[data-view]').forEach(b=>b.onclick=()=>switchView(b.dataset.view));
const mobileMoreButton=qs('#mobileMoreButton'),mobileMoreSheet=qs('#mobileMoreSheet'),mobileMoreClose=qs('#mobileMoreClose');
if(mobileMoreButton)mobileMoreButton.onclick=()=>{const opening=!!mobileMoreSheet?.hidden;if(mobileMoreSheet)mobileMoreSheet.hidden=!opening;mobileMoreButton.setAttribute('aria-expanded',opening?'true':'false');};
if(mobileMoreClose)mobileMoreClose.onclick=()=>{if(mobileMoreSheet)mobileMoreSheet.hidden=true;if(mobileMoreButton)mobileMoreButton.setAttribute('aria-expanded','false');};
qsa('[data-jump]').forEach(b=>b.onclick=()=>switchView(b.dataset.jump));
qs('#leadFilters').onclick=e=>{const b=e.target.closest('button');if(!b)return;state.filter=b.dataset.status;qsa('#leadFilters button').forEach(x=>x.classList.toggle('active',x===b));renderLeads();};
qs('#leadSearch').oninput=e=>{state.search=e.target.value.trim().toLowerCase();renderLeads();};
qs('#globalSearchButton').onclick=()=>{switchView('leads');setTimeout(()=>qs('#leadSearch').focus(),100)};
qs('#notificationButton').onclick=()=>{const p=qs('#notificationPopover');p.hidden=!p.hidden;};qs('#closeNotifications').onclick=()=>qs('#notificationPopover').hidden=true;
qs('#rangeControl').onclick=e=>{const b=e.target.closest('button');if(!b)return;state.rangeDays=Number(b.dataset.days)||30;qsa('#rangeControl button').forEach(x=>x.classList.toggle('active',x===b));renderDashboard();};

['#newLeadButton','#newLeadButton2'].forEach(s=>qs(s).onclick=()=>showModal('leadModal'));qs('#closeLeadModal').onclick=()=>hideModal('leadModal');qs('#cancelLeadModal').onclick=()=>hideModal('leadModal');
qs('#manualLeadForm').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget;const out=qs('#manualLeadStatus');out.textContent='Creating…';try{const d=await api('/api/app/leads',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))});state.leads.unshift(d.lead);form.reset();hideModal('leadModal');await refreshLight();switchView('leads');}catch(err){out.textContent=err.message;}};

qs('#closeDrawer').onclick=()=>qs('#leadDrawer').hidden=true;qs('#leadDetailForm').onsubmit=async e=>{e.preventDefault();if(!state.selectedLeadId)return;const fd=Object.fromEntries(new FormData(e.currentTarget));qs('#drawerStatusText').textContent='Saving…';await updateLead(state.selectedLeadId,fd);qs('#drawerStatusText').textContent='Saved.';setTimeout(()=>qs('#drawerStatusText').textContent='',1200)};
qs('#deleteLeadButton').onclick=async()=>{if(!state.selectedLeadId)return;const l=state.leads.find(x=>x.id===state.selectedLeadId);if(!confirm(`Delete ${l?.name||'this lead'}?`))return;try{await api(`/api/app/leads/${state.selectedLeadId}`,{method:'DELETE'});qs('#leadDrawer').hidden=true;state.selectedLeadId=null;await refreshLight();}catch(e){alert(e.message)}};
qs('#messageLeadButton').onclick=async()=>{if(!state.selectedLeadId)return;try{let c=state.conversations.find(x=>x.leadId===state.selectedLeadId);if(!c){const d=await api('/api/app/conversations',{method:'POST',body:JSON.stringify({leadId:state.selectedLeadId})});c=d.conversation;await refreshLight();}state.selectedConversationId=c.id;qs('#leadDrawer').hidden=true;switchView('inbox');renderInbox();}catch(e){alert(e.message)}};
qs('#bookLeadButton').onclick=()=>{if(state.selectedLeadId){showModal('appointmentModal');qs('#appointmentLead').value=state.selectedLeadId;const d=new Date();d.setDate(d.getDate()+1);qs('#appointmentForm [name=date]').value=d.toISOString().slice(0,10);qs('#appointmentForm [name=time]').value='09:00';}};

qs('#newConversationButton').onclick=()=>showModal('conversationModal');qs('#conversationForm').onsubmit=async e=>{e.preventDefault();const leadId=new FormData(e.currentTarget).get('leadId');if(!leadId)return;try{const d=await api('/api/app/conversations',{method:'POST',body:JSON.stringify({leadId})});state.selectedConversationId=d.conversation.id;hideModal('conversationModal');await refreshLight();switchView('inbox');}catch(err){alert(err.message)}};
qs('#messageForm').onsubmit=async e=>{e.preventDefault();const c=state.conversations.find(x=>x.id===state.selectedConversationId),input=qs('#messageInput'),send=qs('#messageForm button'),delivery=qs('#deliveryStatus');if(!c||!input.value.trim())return;const text=input.value.trim();input.value='';try{send.disabled=true;if(delivery){delivery.className='delivery-status';delivery.textContent='Sending…';}const d=await api(`/api/app/conversations/${c.id}/messages`,{method:'POST',body:JSON.stringify({text,from:'business'})});const channels=['website chat'];if(d.delivery?.email)channels.push('email');if(d.delivery?.sms)channels.push('SMS');if(delivery){delivery.className=`delivery-status ${channels.length>1?'success':'warn'}`;delivery.textContent=`Sent through ${channels.join(' + ')}${channels.length===1?' — connect email/SMS for off-site delivery.':''}`;}showToast('Message sent',channels.join(' + '));await refreshLight();state.selectedConversationId=c.id;renderInbox();}catch(err){input.value=text;if(delivery){delivery.className='delivery-status warn';delivery.textContent=err.message;}alert(err.message)}finally{send.disabled=false;}};
qs('#takeoverButton').onclick=async()=>{const c=state.conversations.find(x=>x.id===state.selectedConversationId);if(!c)return;try{await api(`/api/app/conversations/${c.id}`,{method:'PATCH',body:JSON.stringify({mode:c.mode==='ai'?'human':'ai'})});await refreshLight();state.selectedConversationId=c.id;renderInbox();}catch(e){alert(e.message)}};

qs('#newAppointmentButton').onclick=()=>{showModal('appointmentModal');const d=new Date();d.setDate(d.getDate()+1);qs('#appointmentForm [name=date]').value=d.toISOString().slice(0,10);qs('#appointmentForm [name=time]').value='09:00';};
qs('#appointmentForm').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget;const f=Object.fromEntries(new FormData(form));const lead=state.leads.find(l=>l.id===f.leadId);f.customer=lead?.name||'';f.start=new Date(`${f.date}T${f.time}:00`).toISOString();try{await api('/api/app/appointments',{method:'POST',body:JSON.stringify(f)});form.reset();hideModal('appointmentModal');await refreshLight();switchView('calendar');}catch(err){qs('#appointmentStatus').textContent=err.message}};
async function deleteAppointment(id){try{await api(`/api/app/appointments/${id}`,{method:'DELETE'});await refreshLight();}catch(e){alert(e.message)}}
if(qs('#appointmentDeleteButton'))qs('#appointmentDeleteButton').onclick=async()=>{const id=qs('#appointmentDeleteButton').dataset.id;if(!id)return;if(confirm('Delete this appointment?')){hideModal('appointmentDetailModal');await deleteAppointment(id);}};
qs('#prevMonthButton').onclick=()=>{state.calendarDate=new Date(state.calendarDate.getFullYear(),state.calendarDate.getMonth()-1,1);renderCalendar()};qs('#nextMonthButton').onclick=()=>{state.calendarDate=new Date(state.calendarDate.getFullYear(),state.calendarDate.getMonth()+1,1);renderCalendar()};qs('#todayButton').onclick=()=>{state.calendarDate=new Date();renderCalendar()};

qs('#newInvoiceButton').onclick=()=>{const pid=qs('#invoiceProjectId');if(pid)pid.value='';showModal('invoiceModal');};qs('#invoiceForm').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget;const f=Object.fromEntries(new FormData(form));const lead=state.leads.find(l=>l.id===f.leadId);f.customer=lead?.name||'';try{await api('/api/app/invoices',{method:'POST',body:JSON.stringify(f)});form.reset();hideModal('invoiceModal');await refreshLight();switchView('payments');}catch(err){qs('#invoiceStatus').textContent=err.message}};
async function updateInvoice(id,status){try{await api(`/api/app/invoices/${id}`,{method:'PATCH',body:JSON.stringify({status})});await refreshLight();}catch(e){alert(e.message)}}
async function deleteInvoice(id){
  const inv=state.invoices.find(x=>x.id===id);if(!inv)return;
  if(!confirm(`Delete ${inv.customer}'s ${inv.description} invoice?\n\nThis removes the record from SiteRemade. It does not refund or cancel a payment already processed by Stripe.`))return;
  try{
    const result=await api(`/api/app/invoices/${id}`,{method:'DELETE'});
    if(!result?.ok)throw new Error(result?.message||'Could not delete invoice.');
    state.invoices=state.invoices.filter(x=>x.id!==id);
    renderPayments();renderDashboard();renderAnalytics();fillLeadSelects();
    await refreshLight();
  }catch(e){alert(e.message)}
}
async function updateWebsiteRequest(id,status){try{await api(`/api/app/website-updates/${id}`,{method:'PATCH',body:JSON.stringify({status})});await refreshLight();}catch(e){alert(e.message)}}
if(qs('#lockStartSubscriptionButton'))qs('#lockStartSubscriptionButton').onclick=async()=>{const out=qs('#lockBillingStatus');out.textContent='Opening secure billing…';try{const d=await api('/api/app/billing/subscription/start',{method:'POST'});if(d.url)location.href=d.url}catch(e){out.textContent=e.message}};
if(qs('#lockManageBillingButton'))qs('#lockManageBillingButton').onclick=async()=>{const out=qs('#lockBillingStatus');out.textContent='Opening billing portal…';try{const d=await api('/api/app/billing/portal',{method:'POST'});if(d.url)location.href=d.url}catch(e){out.textContent=e.message}};
if(qs('#lockLogoutButton'))qs('#lockLogoutButton').onclick=async()=>{try{await api('/api/auth/logout',{method:'POST'});}catch{}location.reload()};
if(qs('#startSubscriptionButton'))qs('#startSubscriptionButton').onclick=async()=>{const out=qs('#billingStatus');out.textContent='Opening secure billing…';try{const d=await api('/api/app/billing/subscription/start',{method:'POST'});if(d.url)location.href=d.url}catch(e){out.textContent=e.message}};
if(qs('#manageBillingButton'))qs('#manageBillingButton').onclick=async()=>{const out=qs('#billingStatus');out.textContent='Opening billing portal…';try{const d=await api('/api/app/billing/portal',{method:'POST'});if(d.url)location.href=d.url}catch(e){out.textContent=e.message}};
if(qs('#adFundForm'))qs('#adFundForm').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,out=qs('#adFundStatus');out.textContent='Opening secure checkout…';try{const d=await api('/api/app/ad-funds',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))});if(d.url)location.href=d.url}catch(err){out.textContent=err.message}};

async function toggleAutomation(id){const a=state.automations.find(x=>x.id===id);if(!a)return;try{await api(`/api/app/automations/${id}`,{method:'PATCH',body:JSON.stringify({enabled:!a.enabled})});await refreshLight();}catch(e){alert(e.message)}}
qs('#settingsForm').onsubmit=async e=>{e.preventDefault();const out=qs('#settingsStatus');out.textContent='Saving…';try{const d=await api('/api/app/settings',{method:'PATCH',body:JSON.stringify(Object.fromEntries(new FormData(e.currentTarget)))});state.workspace=d.workspace;renderAll();out.textContent='Saved.';setTimeout(()=>out.textContent='',1500)}catch(err){out.textContent=err.message}};

qsa('[data-close]').forEach(b=>b.onclick=()=>hideModal(b.dataset.close));qsa('.modal-backdrop').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)m.hidden=true}));document.addEventListener('keydown',e=>{if(e.key==='Escape'){qsa('.modal-backdrop').forEach(m=>m.hidden=true);qs('#leadDrawer').hidden=true;qs('#notificationPopover').hidden=true;}});


function renderWorkspaceMenu(){const menu=qs('#workspaceMenu');if(!menu)return;menu.innerHTML=(state.workspaces||[]).map(w=>`<button data-workspace="${w.id}" class="workspace-option ${w.id===state.workspace.id?'active':''}"><span>${esc(w.businessName)}</span><small>${esc(w.plan||'Client')}</small></button>`).join('');qsa('[data-workspace]').forEach(b=>b.onclick=async()=>{await api('/api/app/workspaces/switch',{method:'POST',body:JSON.stringify({workspaceId:b.dataset.workspace})});menu.hidden=true;await refreshLight();});}
async function renderAdmin(){if(state.user?.role!=='owner')return;try{const d=await api('/api/app/admin');qs('#adminWorkspaceList').innerHTML=d.workspaces.map(w=>`<div class="admin-row growth-admin-row"><div><strong>${esc(w.businessName)}</strong><span>${esc(w.email||'No email')} · ${Number(w.leads||0)} leads · ${money(w.adFunded||0)} funded · ${money(w.adSpent||0)} spent</span></div><div class="admin-actions"><span class="status-pill ${['active','trialing'].includes(w.siteRemadeSubscriptionStatus)?'':'neutral'}">${esc((w.siteRemadeSubscriptionStatus||'inactive').toUpperCase())}</span><button class="secondary-button" data-open-workspace="${w.id}">Open workspace</button></div></div>`).join('');qs('#adminWorkspaceSelect').innerHTML=d.workspaces.map(w=>`<option value="${w.id}">${esc(w.businessName)}</option>`).join('');qsa('[data-open-workspace]').forEach(b=>b.onclick=async()=>{await api('/api/app/workspaces/switch',{method:'POST',body:JSON.stringify({workspaceId:b.dataset.openWorkspace})});await refreshLight();switchView('home');});}catch{}}
qs('#loginForm').onsubmit=async e=>{e.preventDefault();const out=qs('#loginStatus');out.style.color='';out.textContent='Signing in…';try{await api('/api/auth/login',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.currentTarget)))});out.textContent='';if(await bootstrap())startLiveSync();}catch(err){out.style.color='#c54747';out.textContent=err.message}};
function setAuthMode(mode){const login=qs('#loginForm'),signup=qs('#signupForm'),a=qs('#showLogin'),b=qs('#showSignup');const isSignup=mode==='signup';login.hidden=isSignup;signup.hidden=!isSignup;a.classList.toggle('active',!isSignup);b.classList.toggle('active',isSignup);a.setAttribute('aria-selected',String(!isSignup));b.setAttribute('aria-selected',String(isSignup));}
qs('#showLogin').onclick=()=>setAuthMode('login');
qs('#showSignup').onclick=()=>setAuthMode('signup');
qs('#signupForm').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,out=qs('#signupStatus');out.className='';out.textContent='Creating your workspace…';try{const d=await api('/api/auth/signup',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))});out.className='success';out.textContent='Account created. Loading your workspace…';if(await bootstrap())startLiveSync();}catch(err){out.className='error';out.textContent=err.message;}};
qs('#logoutButton').onclick=async()=>{try{await api('/api/auth/logout',{method:'POST'});}catch{}location.reload()};
qs('#workspaceSwitchButton').onclick=()=>{const m=qs('#workspaceMenu');m.hidden=!m.hidden};
qs('#aiSettingsForm').onsubmit=async e=>{e.preventDefault();await api('/api/app/settings',{method:'PATCH',body:JSON.stringify(Object.fromEntries(new FormData(e.currentTarget)))});await refreshLight();};
if(qs('#testAiButton'))qs('#testAiButton').onclick=()=>{const demo=qs('#widgetDemo');demo.hidden=false;const msgs=qs('#widgetMessages');msgs.innerHTML='<div class="widget-bubble ai">Hi — tell me what you need help with and I’ll get the details for the business.</div>';};
if(qs('#closeWidgetDemo'))qs('#closeWidgetDemo').onclick=()=>qs('#widgetDemo').hidden=true;
if(qs('#widgetForm'))qs('#widgetForm').onsubmit=async e=>{e.preventDefault();const text=qs('#widgetText').value.trim();if(!text)return;const msgs=qs('#widgetMessages');const safe=esc(text);msgs.insertAdjacentHTML('beforeend',`<div class="widget-bubble customer">${safe}</div>`);qs('#widgetText').value='';try{const d=await api('/api/public/chat',{method:'POST',body:JSON.stringify({workspaceId:state.workspace.id,publicKey:state.workspace.publicKey,leadId:qs('#widgetForm').dataset.leadId||'',name:qs('#widgetName').value.trim(),email:qs('#widgetEmail').value.trim(),phone:qs('#widgetPhone').value.trim(),text})});qs('#widgetForm').dataset.leadId=d.leadId||'';if(d.reply)msgs.insertAdjacentHTML('beforeend',`<div class="widget-bubble ai">${esc(d.reply)}</div>`);else msgs.insertAdjacentHTML('beforeend','<div class="widget-bubble ai">Message sent to the team. They can reply here or by email/SMS.</div>');}catch(err){msgs.insertAdjacentHTML('beforeend',`<div class="widget-bubble ai">${esc(err.message)}</div>`);}msgs.scrollTop=msgs.scrollHeight;};
qs('#workspaceForm').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget;const out=qs('#workspaceFormStatus');try{await api('/api/app/workspaces',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))});form.reset();out.textContent='Workspace created.';await refreshLight();}catch(err){out.textContent=err.message}};
qs('#userForm').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget;const out=qs('#userFormStatus');try{await api('/api/app/users',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))});form.reset();out.textContent='User created.';await renderAdmin();}catch(err){out.textContent=err.message}};

if(qs('#websiteUpdateForm'))qs('#websiteUpdateForm').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,out=qs('#websiteUpdateStatus');out.textContent='Sending…';try{await api('/api/app/website-updates',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))});form.reset();out.textContent='Request sent to SiteRemade.';await refreshLight();switchView('website-updates');}catch(err){out.textContent=err.message;}};
if(qs('#assistantForm'))qs('#assistantForm').onsubmit=e=>{e.preventDefault();askAssistant();};
qsa('[data-assistant-prompt]').forEach(b=>b.onclick=()=>askAssistant(b.dataset.assistantPrompt));
if(qs('#askAdsButton'))qs('#askAdsButton').onclick=()=>{switchView('home');setTimeout(()=>askAssistant('Analyze my ad spend, leads and collected revenue. Tell me what looks good, what looks weak, and what I should do next.'),100)};
if(qs('#websiteTrafficForm'))qs('#websiteTrafficForm').onsubmit=async e=>{e.preventDefault();const out=qs('#websiteTrafficStatus');out.textContent='Saving…';try{const d=await api('/api/app/analytics/website',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.currentTarget)))});state.websiteAnalytics=d.websiteAnalytics||{};renderWebsiteTraffic();out.textContent='Website domain saved. Connect Google Analytics to show real visitor traffic.';}catch(err){out.textContent=err.message;}};
if(qs('#prospectingForm'))qs('#prospectingForm').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,out=qs('#prospectingStatus');out.textContent='Searching Google Places…';try{const d=await api('/api/app/prospects/search',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))});state.prospects=d.prospects||[];out.textContent=d.live?`${state.prospects.length} businesses matched your search and filters.`:'Market Finder needs a Google Places API key.';renderProspects();}catch(err){out.textContent=err.message;}};
if(qs('#adSpendForm'))qs('#adSpendForm').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,out=qs('#adSpendStatus');out.textContent='Saving…';try{await api('/api/app/ad-spend',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))});form.reset();out.textContent='Saved.';await refreshLight();}catch(err){out.textContent=err.message;}};

// Performance: paired with the ETag the server now computes over the
// bootstrap response (see server.js's GET /api/app/bootstrap). Sending it
// back as If-None-Match lets a poll where nothing changed get a bodyless
// 304 instead of the full payload + a full re-render of every view — same
// 5-second cadence, same data whenever something did change (a fresh
// fetch and a fresh ETag), nothing skipped that would have shown up
// before.
let lastBootstrapETag=null;
async function liveRefresh(){if(liveRefreshing||document.hidden||!state.user)return;liveRefreshing=true;document.body.classList.add('live-syncing');try{const before=renderBadges();const selectedConversationId=state.selectedConversationId,selectedLeadId=state.selectedLeadId;const headers={'Content-Type':'application/json'};if(lastBootstrapETag)headers['If-None-Match']=lastBootstrapETag;const res=await fetch('/api/app/bootstrap',{headers});if(res.status===304)return;const etag=res.headers.get('ETag');const d=await res.json().catch(()=>({}));if(!res.ok||d.ok===false)throw new Error(d.message||`Request failed (${res.status})`);if(etag)lastBootstrapETag=etag;Object.assign(state,{workspace:d.workspace||state.workspace,workspaces:d.workspaces||state.workspaces,user:d.user||state.user,locked:!!d.locked,integrations:d.integrations||{},leads:d.leads||[],conversations:d.conversations||[],appointments:d.appointments||[],invoices:d.invoices||[],automations:d.automations||[],activities:d.activities||[],adSpend:d.adSpend||[],adFunds:d.adFunds||[],billing:d.billing||{},prospectViews:d.prospectViews||[],websiteAnalytics:d.websiteAnalytics||{},websiteUpdates:d.websiteUpdates||[],websiteProjects:d.websiteProjects||[]});state.selectedConversationId=selectedConversationId;state.selectedLeadId=selectedLeadId;const after={newLeads:state.leads.filter(l=>l.status==='New').length,unread:state.conversations.reduce((sum,c)=>sum+Math.max(0,Number(c.unread)||0),0)};renderDashboard();renderLeads();renderInbox();renderCalendar();renderPayments();renderAnalytics();renderNotifications();renderWebsiteProjects();fillLeadSelects();if(after.newLeads>lastLiveCounts.leads&&lastLiveCounts.leads>=0){const newest=state.leads.find(l=>l.status==='New');if(newest)showToast('New lead',`${newest.name} · ${newest.service}`);}else if(after.unread>lastLiveCounts.unread&&lastLiveCounts.unread>=0){const newest=state.conversations.find(c=>Number(c.unread)>0);if(newest)showToast('New customer message',newest.name);}lastLiveCounts={leads:after.newLeads,unread:after.unread};}catch(e){console.warn('Live refresh:',e.message);}finally{liveRefreshing=false;document.body.classList.remove('live-syncing');}}
let liveSyncStarted=false;
function startLiveSync(){if(liveSyncStarted||!state.user)return;liveSyncStarted=true;const c=renderBadges();lastLiveCounts={leads:c.newLeads,unread:c.unread};setInterval(liveRefresh,5000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)liveRefresh();});window.addEventListener('focus',liveRefresh);}
if('serviceWorker' in navigator){
  navigator.serviceWorker.getRegistrations().then(rs=>Promise.all(rs.map(r=>r.unregister()))).catch(()=>{});
}

bootstrap().then(ok=>{if(ok)startLiveSync();});


function installMetaAdsSetup(){
  async function getStatus(){
    try{return await api('/api/app/integrations/status')}catch{return{providers:{}}}
  }
  async function paintMetaSetup(){
    const admin=qs('#view-admin');
    if(!admin)return;
    let host=qs('#metaAdsSetupCard');
    if(!host){
      host=document.createElement('section');
      host.id='metaAdsSetupCard';
      host.className='panel';
      host.style.marginTop='12px';
      const anchor=qs('#v43AdControl')||admin.querySelector('.panel:last-of-type');
      if(anchor)anchor.insertAdjacentElement('afterend',host);else admin.appendChild(host);
    }
    const st=await getStatus();
    const meta=st?.providers?.meta_ads||{};
    host.innerHTML=`
      <div class="panel-head">
        <div><p class="eyebrow">META ADS CONNECTION</p><h2>${meta.configured?'Ready to connect':'Setup required'}</h2></div>
        <span class="status-pill ${meta.configured?'':'neutral'}">${meta.configured?'READY':'NOT CONFIGURED'}</span>
      </div>
      <div style="display:grid;gap:10px">
        <p class="helper-copy" style="margin:0">Connect Facebook and Instagram advertising so SiteRemade can report spend, leads, cost per lead and attributed revenue beside Google Ads.</p>
        <div class="settings-grid" style="grid-template-columns:1fr 1fr">
          <div class="setting-row"><div><strong>Meta App ID</strong><span>${meta.configured?'Configured':'Not provided yet'}</span></div></div>
          <div class="setting-row"><div><strong>Meta App Secret</strong><span>${meta.configured?'Configured':'Not provided yet'}</span></div></div>
        </div>
        <div class="setting-row">
          <div><strong>OAuth callback</strong><span>https://app.siteremade.com/api/app/meta-ads/callback</span></div>
        </div>
        <div class="setting-row">
          <div><strong>Required Meta access</strong><span>Ads Management + Ads Read for the connected Business / ad account.</span></div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" class="primary-action" ${meta.configured?'':'disabled'} id="metaAdsConnectButton">${meta.configured?'Connect Meta Ads':'Add Meta credentials first'}</button>
          <button type="button" class="secondary-button" id="metaAdsRefreshButton">Refresh status</button>
        </div>
        <p class="modal-status" id="metaAdsSetupStatus">${meta.configured?'Meta app credentials detected. OAuth/account connection can be enabled next.':'Meta advertising credentials haven’t been added yet, so this can’t connect until they are.'}</p>
      </div>`;
    qs('#metaAdsRefreshButton')?.addEventListener('click',paintMetaSetup);
    qs('#metaAdsConnectButton')?.addEventListener('click',()=>{
      const s=qs('#metaAdsSetupStatus');
      if(s)s.textContent='Meta credentials are ready, but the OAuth callback flow still needs to be enabled on the server before account authorization.';
    });
  }
  document.addEventListener('click',e=>{
    const v=e.target.closest?.('[data-view]')?.dataset.view;
    if(v==='admin')setTimeout(paintMetaSetup,180);
    if(v==='integrations')setTimeout(()=>{
      const card=[...document.querySelectorAll('.v34-card')].find(x=>x.querySelector('[data-v34="meta_ads"]'));
      if(card){
        const btn=card.querySelector('[data-v34="meta_ads"]');
        const state=card.querySelector('.v34-state');
        getStatus().then(st=>{
          const meta=st?.providers?.meta_ads||{};
          if(state){state.textContent=meta.configured?'Ready':'Needs setup';state.className='v34-state '+(meta.configured?'ready':'')}
          if(btn){btn.disabled=false;btn.textContent=meta.configured?'Manage':'Set up';btn.onclick=ev=>{ev.preventDefault();document.querySelector('[data-view="admin"]')?.click();setTimeout(()=>qs('#metaAdsSetupCard')?.scrollIntoView({behavior:'smooth',block:'center'}),250)}}
        });
      }
    },400);
  },true);
  setTimeout(()=>{if(qs('#view-admin')?.classList.contains('active'))paintMetaSetup()},500);
}

installMetaAdsSetup();
