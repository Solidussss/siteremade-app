const state={workspace:{},workspaces:[],user:null,locked:false,integrations:{},leads:[],conversations:[],appointments:[],invoices:[],automations:[],activities:[],adSpend:[],adFunds:[],billing:{},prospects:[],prospectViews:[],websiteAnalytics:{},websiteUpdates:[],websiteProjects:[],selectedProjectId:null,filter:'all',search:'',selectedConversationId:null,selectedLeadId:null,calendarDate:new Date(),rangeDays:30};
let liveRefreshing=false,lastLiveCounts={leads:0,unread:0},toastTimer=null;
const qs=s=>document.querySelector(s), qsa=s=>[...document.querySelectorAll(s)];
const money=n=>new Intl.NumberFormat('en-CA',{style:'currency',currency:state.workspace.currency||'CAD',maximumFractionDigits:0}).format(Number(n)||0);
const esc=(v='')=>String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const initials=(n='')=>n.split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join('').toUpperCase()||'•';
const relative=iso=>{const d=Math.max(0,(Date.now()-new Date(iso))/1000);if(d<60)return'now';if(d<3600)return`${Math.floor(d/60)}m`;if(d<86400)return`${Math.floor(d/3600)}h`;return`${Math.floor(d/86400)}d`;};
const dateLabel=iso=>new Intl.DateTimeFormat('en-CA',{month:'short',day:'numeric'}).format(new Date(iso));
const dateTimeLabel=iso=>new Intl.DateTimeFormat('en-CA',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(iso));

async function api(url,opts={}){const r=await fetch(url,{...opts,headers:{'Content-Type':'application/json',...(opts.headers||{})}});if(opts.onResponse)opts.onResponse(r);const data=await r.json().catch(()=>({}));if(!r.ok||data.ok===false)throw new Error(data.message||`Request failed (${r.status})`);return data;}
// Login/startup performance pass: three separate dashboard-feature scripts
// (v36-connectors-client.js, v38-safe.js, v39-phone-setup-client.js) each
// independently check Twilio's connection status on their own short timer
// right after the dashboard loads, with no idea the other two exist — a
// real instrumented run measured 3-4 near-simultaneous requests for the
// exact same data on every single login. v38-safe.js's refresh() also
// re-fetches it on every calendar/inbox/payments/integrations nav click.
// This shares one in-flight/recent fetch across all callers instead;
// pass force=true only where the caller just changed the connection state
// itself and genuinely needs a non-cached answer.
let twilioStatusPromise=null,twilioStatusAt=0;
window.getSharedTwilioStatus=function(force){
  if(!force&&twilioStatusPromise&&Date.now()-twilioStatusAt<3000)return twilioStatusPromise;
  twilioStatusAt=Date.now();
  twilioStatusPromise=api('/api/app/integrations/twilio/status').catch(e=>{twilioStatusPromise=null;throw e;});
  return twilioStatusPromise;
};
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
//
// Website-first shell (Phase 3I): this list was unthreaded. Disconnected
// (files left on disk, just no longer loaded) because they only existed to
// build the old customer Overview / Analytics / Market Finder presentation
// — and would clobber or duplicate the new views if still loaded:
//   v22-client.js + v22.css  (Overview/Analytics "hero" bands, nav relabeling,
//                             plus a whole third token/shell theme)
//   v24-umami-client.js + v24.css (old Analytics renderer; the new
//                             renderAnalytics() reads the same
//                             /api/app/umami/analytics endpoint) — this was
//                             also the only loader of v28-market-client.js
//                             + v28-market.css (Market Finder decorations)
//   v20-client.js + v20.css  (old "website traffic" panel wrapper)
//   v19-client.js            (CRM setup checklist, pipeline board, lead
//                             "next action" column, prospect fit scores)
//   v18.css                  (styles no remaining script renders)
// Still loaded, for compatibility: v17-client.js/v17.css (legacy inbox/
// calendar/drawer rules for the staff-only internal screens), v18-client.js
// (Google sign-in fragment handling — auth-adjacent, deliberately untouched;
// it also imports v19-agency/v19-updates/v19-market/v29-lead-fix), v19.css
// (still styles v19-agency.js's Admin overview), v40 (Business SMS number
// wizard, now opened from Settings → Connections), v45 (Admin ad
// intelligence) and v29-bootstrap.js (see that file for its own split).
// Full list: PHASE3-ROUTE-MAP.md, "Website-first shell".
let dashboardScriptsLoaded=false;
function loadDashboardFeatureScripts(){
  if(dashboardScriptsLoaded)return;
  dashboardScriptsLoaded=true;
  ['/v17.css?v=17','/v19.css?v=19'].forEach(href=>{
    const l=document.createElement('link');
    l.rel='stylesheet';l.href=href;
    document.head.appendChild(l);
  });
  ['/v40-existing-number-client.js?v=4','/v45-ad-intelligence-client.js','/v29-bootstrap.js?v=38','/v17-client.js?v=17','/v18-client.js?v=18'].forEach(src=>{
    const s=document.createElement('script');
    s.src=src;s.async=false;
    document.body.appendChild(s);
  });
}
// Unified-login pass: the SiteRemade generator (a separate codebase/
// deployment) sends a visitor here with ?handoff_return=<generator
// url>&handoff_mode=session|link when they click "Continue with
// SiteRemade" / "Connect your SiteRemade account" there. This app has no
// idea yet whether that visitor already has a session here or is about to
// create one (email/password sign-in, signup, or the existing Google
// OAuth round trip, which itself leaves and returns to this exact origin
// before finishing with a plain page reload) -- so the intent is parked in
// sessionStorage the instant it arrives (surviving all three of those
// paths, all same-origin), and only acted on from bootstrap()'s own single
// "a real session now exists" success path below, whichever of those three
// ways got it there. See routes/website-builder-handoff.js for what
// actually mints the return trip once we act on it.
(function captureWebsiteBuilderHandoffIntent(){
  const qp=new URLSearchParams(location.search),ret=qp.get('handoff_return');
  if(!ret)return;
  try{sessionStorage.setItem('sr_pending_handoff',JSON.stringify({ret,mode:qp.get('handoff_mode')==='link'?'link':'session'}));}catch(e){}
  qp.delete('handoff_return');qp.delete('handoff_mode');
  const rest=qp.toString();
  history.replaceState({},'',location.pathname+(rest?'?'+rest:''));
})();
// Password-recovery pass: clicking the link in Supabase's own recovery
// email lands the visitor back here with a URL FRAGMENT (never a query
// param -- fragments never reach the server), the same implicit-flow
// mechanism the existing Google sign-in round trip already relies on
// (installGoogleLogin() in v18-client.js parses access_token/refresh_token
// off location.hash the same way). There is no flowType override anywhere
// in this codebase (grepped), and supabase-js defaults to implicit when
// none is set, so this -- not PKCE, not a `code` query param -- is the
// real mechanism in this app, confirmed rather than assumed. A successful
// recovery link arrives as
// #access_token=...&refresh_token=...&type=recovery&expires_in=...; an
// already-expired or already-used one instead arrives as
// #error=access_denied&error_code=otp_expired&error_description=...
// (Supabase's own documented behavior). Nothing else in this app ever
// puts an `error` key in the URL fragment (the Google flow's own failure
// path redirects with a *query* param, ?auth_error=..., see
// routes/google-signin.js), so any fragment carrying one here is
// unambiguously a dead recovery link.
//
// The token pair is held ONLY in this module-scope variable, never in
// localStorage/sessionStorage, and the fragment is scrubbed from the
// visible URL immediately below -- before bootstrap() or anything else
// in this file runs -- so a reload, a shared screenshot, or browser
// history never carries the recovery tokens.
let pendingRecoverySession=null;
(function detectPasswordRecoveryFragment(){
  const raw=location.hash.replace(/^#/,'');
  if(!raw)return;
  const h=new URLSearchParams(raw);
  const errorCode=h.get('error_code')||h.get('error');
  const type=h.get('type');
  const accessToken=h.get('access_token'),refreshToken=h.get('refresh_token');
  const isRecovery=type==='recovery'&&accessToken&&refreshToken;
  if(!isRecovery&&!errorCode)return; // not recovery-shaped (e.g. the Google OAuth flow's own #access_token fragment) -- leave it untouched for that flow to consume
  history.replaceState({},'',location.pathname+location.search);
  if(isRecovery){
    pendingRecoverySession={accessToken,refreshToken};
    setAuthMode('reset');
  }else{
    setAuthMode('reset');
    const title=qs('#resetFormTitle'),copy=qs('#resetFormCopy'),retry=qs('#showForgotFromReset');
    if(title)title.textContent='Link expired';
    if(copy)copy.textContent='This password reset link is invalid or has expired.';
    qsa('#resetForm input').forEach(i=>i.disabled=true);
    if(qs('#resetFormSubmit'))qs('#resetFormSubmit').hidden=true;
    if(retry)retry.hidden=false;
  }
  // setAuthMode() is declared further down in this same script, but
  // function declarations hoist with their full body in JS, so this
  // earlier call already resolves to the real implementation -- and the
  // DOM elements it touches already exist, since app.js runs as a plain
  // synchronous script placed after the auth markup in index.html, same
  // as every other qs('#...') call elsewhere in this file that runs
  // unconditionally at top level (e.g. captureWebsiteBuilderHandoffIntent
  // above).
})();
function maybeRedirectForWebsiteBuilderHandoff(){
  let pending=null;
  try{pending=JSON.parse(sessionStorage.getItem('sr_pending_handoff')||'null');}catch(e){}
  if(!pending||!pending.ret)return false;
  try{sessionStorage.removeItem('sr_pending_handoff');}catch(e){}
  location.href='/handoff/website-builder?return='+encodeURIComponent(pending.ret)+'&mode='+encodeURIComponent(pending.mode||'session');
  return true;
}
async function bootstrap(){try{const d=await api('/api/app/bootstrap',{onResponse:r=>{const et=r.headers.get('ETag');if(et)lastBootstrapETag=et;}});Object.assign(state,{workspace:d.workspace||{},workspaces:d.workspaces||[],user:d.user||null,locked:!!d.locked,integrations:d.integrations||{},leads:d.leads||[],conversations:d.conversations||[],appointments:d.appointments||[],invoices:d.invoices||[],automations:d.automations||[],activities:d.activities||[],adSpend:d.adSpend||[],adFunds:d.adFunds||[],billing:d.billing||{},prospectViews:d.prospectViews||[],websiteAnalytics:d.websiteAnalytics||{},websiteUpdates:d.websiteUpdates||[],websiteProjects:d.websiteProjects||[]});qs('#authScreen').hidden=true;if(maybeRedirectForWebsiteBuilderHandoff())return true;renderAll();loadDashboardFeatureScripts();handleConnectionReturn();qs('#systemStatus').textContent='Cloud database live';const qp=new URLSearchParams(location.search),sid=qp.get('session_id');if(sid&&(qp.get('billing')==='success'||qp.get('adfund')==='success')){try{await api('/api/app/checkout/confirm?sessionId='+encodeURIComponent(sid));history.replaceState({},'',location.pathname);const d2=await api('/api/app/bootstrap');Object.assign(state,{workspace:d2.workspace||{},workspaces:d2.workspaces||[],user:d2.user||state.user,locked:!!d2.locked,integrations:d2.integrations||{},leads:d2.leads||[],conversations:d2.conversations||[],appointments:d2.appointments||[],invoices:d2.invoices||[],automations:d2.automations||[],activities:d2.activities||[],adSpend:d2.adSpend||[],adFunds:d2.adFunds||[],billing:d2.billing||{},prospectViews:d2.prospectViews||[],websiteAnalytics:d2.websiteAnalytics||{},websiteUpdates:d2.websiteUpdates||[],websiteProjects:d2.websiteProjects||[]});renderAll();}catch(err){console.error('Checkout confirmation:',err)}}return true;}catch(e){qs('#authScreen').hidden=false;qs('#systemStatus').textContent=e.message.includes('Supabase')?'Supabase setup required':'Sign in required';if(e.message.includes('Supabase')){const s=qs('#loginStatus');s.textContent=e.message;s.style.color='#c54747';}console.error(e);return false;}}

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
    ['subscription',renderSubscriptionGate],['workspace',renderWorkspace],['website',renderWebsite],['contact',renderContact],['ads',renderAds],['dashboard',renderDashboard],
    ['leads',renderLeads],['inbox',renderInbox],['calendar',renderCalendar],['payments',renderPayments],
    ['analytics',renderAnalytics],['website-traffic',renderWebsiteTraffic],['website-updates',renderWebsiteUpdates],['website-projects',renderWebsiteProjects],
    ['automations',renderAutomations],['settings',renderSettings],['notifications',renderNotifications],
    ['prospects',renderProspects],['lead-selects',fillLeadSelects],['workspace-menu',renderWorkspaceMenu],
    ['admin',()=>renderAdmin()],['badges',renderBadges]
  ].forEach(([name,fn])=>safeRender(name,fn));
}
// Contact (website-first shell). "Who contacted me through my website?" is
// answered from the real leads table, minus records nobody submitted
// (typed in by hand, or imported from Market Finder / by SiteRemade staff).
// A submission is unread while its linked conversation still has unread
// messages — the same counter POST /api/public/lead sets to 1 and the
// existing PATCH /api/app/conversations/:id {read:true} clears. No new
// column, no new route.
const CONTACT_EXCLUDED_SOURCES=new Set(['manual','market finder','siteremade']);
function isContactSubmission(l){return !CONTACT_EXCLUDED_SOURCES.has(String(l?.source||'').trim().toLowerCase());}
function contactConversation(l){return (state.conversations||[]).find(c=>c.leadId===l.id)||null;}
function isContactUnread(l){return Number(contactConversation(l)?.unread||0)>0;}
function contactSubmissions(){return (state.leads||[]).filter(isContactSubmission).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));}
function renderBadges(){const newLeads=state.leads.filter(l=>l.status==='New').length,unread=state.conversations.reduce((s,c)=>s+Math.max(0,Number(c.unread)||0),0),total=newLeads+unread;const lb=qs('#leadBadge'),ib=qs('#inboxBadge'),nc=qs('#notificationCount'),dot=qs('#notificationDot');if(lb){lb.textContent=newLeads;lb.style.display=newLeads?'grid':'none';}if(ib){ib.textContent=unread;ib.style.display=unread?'grid':'none';}if(nc){nc.textContent=total>99?'99+':String(total);nc.hidden=!total;}if(dot)dot.style.display=total?'block':'none';
  const contactUnread=contactSubmissions().filter(isContactUnread).length,cb=qs('#contactBadge'),md=qs('#mobileContactDot');
  if(cb){cb.textContent=contactUnread>99?'99+':String(contactUnread);cb.hidden=!contactUnread;cb.style.display=contactUnread?'grid':'none';}
  if(md)md.hidden=!contactUnread;
  return{newLeads,unread,total,contactUnread};}
function showToast(title,detail=''){let t=qs('#appToast');if(!t){t=document.createElement('div');t.id='appToast';t.className='app-toast';document.body.appendChild(t);}t.innerHTML=`<strong>${esc(title)}</strong><span>${esc(detail)}</span>`;t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),3600);}
function renderWorkspace(){const n=state.workspace.businessName||'Your business';qs('#workspaceName').textContent=n;qs('#homeGreeting').textContent=`${n.split(/\s+/)[0]} overview`;qs('.workspace-mark').textContent=(n[0]||'S').toUpperCase();qs('#todayLabel').textContent=new Intl.DateTimeFormat('en-CA',{weekday:'long',month:'long',day:'numeric'}).format(new Date()).toUpperCase();const uc=qs('.user-card strong');if(uc&&state.user)uc.textContent=state.user.name;const us=qs('.user-card small');if(us&&state.user)us.textContent=state.user.role==='owner'?'SiteRemade owner':'Administrator';const isOwner=state.user?.role==='owner';qs('#adminNav').style.display=isOwner?'grid':'none';
// V2 redesign: the sidebar's Admin group is now its own labeled section
// (divider + eyebrow label) wrapping the single Admin nav button, instead
// of the button living unlabeled at the end of a shared list. Owner-gating
// used to only need to hide the button itself; now the wrapper has to be
// hidden too, or a non-owner sees an empty "Admin" section heading with
// nothing under it.
const adminDivider=qs('#adminDivider'),adminLabel=qs('#adminLabel');if(adminDivider)adminDivider.style.display=isOwner?'block':'none';if(adminLabel)adminLabel.style.display=isOwner?'block':'none';
// Website-first shell: the mobile bar's Admin slot uses the `hidden`
// attribute (not an inline display value) so the bar's grid only reserves a
// sixth column for SiteRemade staff.
const av=qs('.user-card .avatar');if(av&&state.user)av.textContent=initials(state.user.name||state.user.email||'');
const man=qs('#mobileAdminNav');if(man)man.hidden=!isOwner;const mwn=qs('#mobileWorkspaceName');if(mwn)mwn.textContent=n;}
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
function renderLeads(){const leads=filteredLeads();qs('#leadCountLabel').textContent=`${leads.length} lead${leads.length===1?'':'s'}`;qs('#leadTableBody').innerHTML=leads.length?leads.map(l=>`<tr class="lead-table-row" data-id="${l.id}"><td><div class="customer-id"><span class="avatar small">${initials(l.name)}</span><div><strong>${esc(l.name)}</strong><small>${esc(l.phone||l.email||'No contact details')}</small></div></div></td><td>${esc(l.service)}</td><td>${esc(l.source)}</td><td>${dateLabel(l.createdAt)}</td><td><select class="status-select lead-status status-${esc(l.status)}" data-id="${l.id}">${['New','Contacted','Quoted','Won','Lost'].map(s=>`<option ${s===l.status?'selected':''}>${s}</option>`).join('')}</select></td><td><button class="row-menu" data-open="${l.id}">•••</button></td></tr>`).join(''):'<tr><td class="empty-row" colspan="6">No leads match this view.</td></tr>';qsa('.status-select').forEach(x=>x.onchange=e=>{e.stopPropagation();updateLead(x.dataset.id,{status:x.value})});qsa('.lead-table-row').forEach(r=>r.onclick=e=>{if(e.target.closest('select,button'))return;openLead(r.dataset.id)});qsa('[data-open]').forEach(b=>b.onclick=()=>openLead(b.dataset.open));}
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
  // V2 redesign (connected-journey pass): the customer name is now the
  // same avatar+name identity treatment used in Leads/Inbox, and links
  // back to that lead's record when the invoice has a leadId (every
  // customer invoice does -- it's set wherever the invoice is created,
  // from the lead drawer, a project, or the admin form). This surfaces a
  // relationship the backend already has (invoice.leadId) rather than
  // inventing one -- previously Payments was the one screen in the
  // journey with no way back to the customer record at all.
  qs('#transactionList').innerHTML=state.invoices.length?state.invoices.map(i=>{const lead=i.leadId?state.leads.find(l=>l.id===i.leadId):null;const nameHtml=lead?`<button type="button" class="customer-id customer-id-link" data-open-invoice-lead="${lead.id}"><span class="avatar small">${initials(i.customer)}</span><strong>${esc(i.customer)}</strong></button>`:`<div class="customer-id"><span class="avatar small">${initials(i.customer)}</span><strong>${esc(i.customer)}</strong></div>`;return `<div>${nameHtml}<span>${esc(i.description)}</span><em>${money(i.amount)}</em><select class="invoice-status ${i.status.toLowerCase()}" data-invoice="${i.id}">${['Draft','Pending','Paid','Void'].map(x=>`<option ${x===i.status?'selected':''}>${x}</option>`).join('')}</select><button class="transaction-delete" data-delete-invoice="${i.id}" title="Delete invoice">×</button></div>`}).join(''):'<div class="empty-state">No customer invoices yet.</div>';qsa('[data-invoice]').forEach(sel=>sel.onchange=()=>updateInvoice(sel.dataset.invoice,sel.value));qsa('[data-delete-invoice]').forEach(btn=>btn.onclick=()=>deleteInvoice(btn.dataset.deleteInvoice));qsa('[data-open-invoice-lead]').forEach(btn=>btn.onclick=()=>{switchView('leads');setTimeout(()=>openLead(btn.dataset.openInvoiceLead),50)});
  const monthly=(Number(state.billing?.monthlyCents)||0)/100,status=state.billing?.status||state.workspace.siteRemadeSubscriptionStatus||'inactive';
  qs('#subscriptionPrice').textContent=money(monthly);const ss=qs('#subscriptionStatus');ss.textContent=String(status).replace('_',' ').toUpperCase();ss.classList.toggle('neutral',!['active','trialing'].includes(status));
  qs('#startSubscriptionButton').textContent=['active','trialing'].includes(status)?'Subscription active':'Start monthly plan';qs('#startSubscriptionButton').disabled=['active','trialing'].includes(status);
  const funded=(state.adFunds||[]).filter(f=>f.status==='Funded').reduce((x,f)=>x+Number(f.amount||0),0),spent=(state.adSpend||[]).reduce((x,a)=>x+Number(a.spend||0),0),available=Math.max(0,funded-spent);
  qs('#adFundedTotal').textContent=money(funded);qs('#adFundSpent').textContent=money(spent);qs('#adFundAvailable').textContent=money(available);
  qs('#adFundHistory').innerHTML=(state.adFunds||[]).length?state.adFunds.map(f=>`<div><span class="payment-icon">↗</span><strong>${esc(f.platform)} ads</strong><span>${dateLabel(f.createdAt)}</span><em>${money(f.amount)}</em><span class="status-pill ${f.status==='Funded'?'':'neutral'}">${esc(f.status)}</span></div>`).join(''):'<div class="empty-state">No advertising funds added yet.</div>';const fundForm=qs('#adFundForm');if(fundForm){fundForm.style.display=state.user?.role==='owner'?'none':'grid';if(state.user?.role==='owner')qs('#adFundStatus').textContent='Client approves/funds the advertising budget. You manage campaign delivery and record performance from this workspace.';}
}
// Legacy renderAnalytics (lead/won-rate/bookings/revenue cards) was replaced by
// the website analytics view below (Phase 3E).
// ===========================================================================
// Analytics — Phase 3E
// ===========================================================================
// Reads the same real Umami-backed endpoint the old view used
// (routes/umami-analytics.js, GET /api/app/umami/analytics?days=N →
// {connected, domain, stats, series, active, pages, referrers, devices,
// countries, channels, events, …}). Fetched when the view is opened or the
// range changes (at most once a minute per range), never on the 5s live
// refresh. "Form submissions" is counted from this app's own contact
// submissions (real rows, same definition as Contact), not guessed from
// analytics events. CTA clicks come only from tracked Umami events whose
// names look like clicks; if the site doesn't tag any, the view says so.
const analyticsState={days:30,cache:{},loading:false,error:null};
const anNum=v=>{const n=Number(v?.value??v??0);return Number.isFinite(n)?n:0;};
const anFmt=n=>Number(n||0).toLocaleString('en-CA');
const AN_CTA=/click|cta|call|phone|tel|book|quote|button|email|directions/i,AN_FORM=/form|submit/i;
// Phase 9: when the switcher has a specific (non-default) website
// selected, reads THAT project's own analytics (GET /api/app/website/
// projects/:id/analytics) instead of the workspace-level endpoint --
// otherwise every connected website would show whichever one the legacy
// workspace-level row happens to be tracking. switchToWebsiteProject()
// already clears analyticsState.cache on every switch, so a days-only
// cache key is still safe here (never serves one website's cached numbers
// under another's selection).
async function loadWebsiteAnalytics(force){
  const days=analyticsState.days,hit=analyticsState.cache[days];
  if(!force&&hit&&Date.now()-hit.at<60000){renderAnalytics();return;}
  analyticsState.loading=true;analyticsState.error=null;renderAnalytics();
  try{
    const scoped=websiteView.selectedGeneratorProjectId;
    const url=scoped?`/api/app/website/projects/${encodeURIComponent(scoped)}/analytics?days=${days}`:`/api/app/umami/analytics?days=${days}`;
    const d=await api(url);analyticsState.cache[days]={data:d,at:Date.now()};
  }
  catch(e){analyticsState.error=e.message||'Analytics unavailable';}
  finally{analyticsState.loading=false;renderAnalytics();}
}
// Phase 8: "Form submissions" / conversion rate count only enquiries made ON
// the website. Texts to the business number arrive with source 'Twilio SMS'
// (routes/twilio-stripe.js) or 'Business SMS' (v40-twilio-subaccounts.js,
// hosted/ported numbers); only the first was excluded, so every text to a
// hosted number was counted as a website form submission.
const SMS_SOURCES=new Set(['twilio sms','business sms']);
function analyticsSubmissions(days){const since=Date.now()-days*86400000;return contactSubmissions().filter(l=>!SMS_SOURCES.has(String(l.source||'').trim().toLowerCase())&&new Date(l.createdAt).getTime()>=since).length;}
function renderAnalytics(){
  const body=qs('#analyticsBody');if(!body)return;
  renderProjectSwitcher('analyticsProjectSwitcher',websiteView.selectedGeneratorProjectId||(canonicalWebsite.status==='ready'?canonicalWebsite.project.projectId:null));
  qsa('[data-an-days]').forEach(b=>{const on=Number(b.dataset.anDays)===analyticsState.days;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));});
  const hit=analyticsState.cache[analyticsState.days],d=hit?.data;
  body.classList.toggle('is-refreshing',analyticsState.loading&&!!d);
  // Called from renderAll()/live refresh too: only rebuild when something
  // this view shows actually changed, so an open tooltip or "Show as a
  // table" isn't reset every 5 seconds.
  const sig=JSON.stringify([analyticsState.days,hit?.at,analyticsState.error,!!d||analyticsState.loading,d?analyticsSubmissions(d.days||analyticsState.days):0]);
  if(body.dataset.sig===sig)return;body.dataset.sig=sig;
  const range=qs('#analyticsRange');
  if(!d){
    if(range)range.hidden=true;
    if(analyticsState.loading){body.innerHTML='<div class="an-skeleton" aria-label="Loading analytics"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton an-skeleton-chart"></div></div>';return;}
    if(analyticsState.error){body.innerHTML=`<div class="an-empty"><strong>Analytics are unavailable right now.</strong><span>We couldn't reach the analytics service (${esc(analyticsState.error)}). Your website isn't affected — try again in a little while.</span><button type="button" class="text-link" id="analyticsRetry">Try again</button></div>`;qs('#analyticsRetry').onclick=()=>loadWebsiteAnalytics(true);return;}
    body.innerHTML='';return;
  }
  if(!d.connected){
    if(range)range.hidden=true;
    qs('#analyticsSubtitle').textContent='Visitors, what they look at, and how many get in touch.';
    // Phase 8: connected:false means no analytics site exists for this
    // workspace at all (routes/umami-analytics.js only reports connected
    // once one is stored). With a domain on file that is a pre-Umami
    // address (V12's website_analytics default provider) -- visits can
    // never arrive until it is saved again, which is what sets tracking
    // up. The old copy said "nothing else to install" and hid the
    // Settings link in exactly that case: a dead end.
    body.innerHTML=d.domain
      ?`<div class="an-empty" id="analyticsNotSetUp"><strong>Visitor tracking isn’t set up yet.</strong><span>We have your address (${esc(d.domain)}), but analytics hasn’t been turned on for it, so no visits are being counted. Save the address in Settings to set it up — it takes a moment.</span><button type="button" class="text-link" data-an-settings>Set up in Settings</button></div>`
      :`<div class="an-empty" id="analyticsNotSetUp"><strong>Analytics will appear once your site is live.</strong><span>As soon as your website is live and connected, you’ll see visitors, popular pages and enquiries here.</span><button type="button" class="text-link" data-an-settings>Add your website address in Settings</button></div>`;
    const go=body.querySelector('[data-an-settings]');if(go)go.onclick=()=>switchView('settings');
    return;
  }
  if(range)range.hidden=false;
  const days=d.days||analyticsState.days,s=d.stats||{};
  const visitors=anNum(s.visitors),views=anNum(s.pageviews),visits=anNum(s.visits);
  const events=Array.isArray(d.events)?d.events:[];
  const ctaEvents=events.filter(e=>AN_CTA.test(String(e.x||''))&&!AN_FORM.test(String(e.x||'')));
  const cta=ctaEvents.reduce((n,e)=>n+anNum(e.y),0);
  const subs=analyticsSubmissions(days);
  const conv=visitors>=50?(subs/visitors*100):null;
  const active=anNum(d.active?.visitors??d.active?.x??d.active);
  qs('#analyticsSubtitle').innerHTML=d.domain?`${esc(d.domain)}${active?` · <span class="chip chip-success">${anFmt(active)} on your site now</span>`:''}`:'Visitors, what they look at, and how many get in touch.';
  // Phase 5: analytics is now set up automatically when the website is
  // linked to its builder project -- possibly before any domain exists and
  // before a single visit. That's a ready state, not a problem to fix, so
  // no "connect"/"add your address" prompt here. Honest about where visits
  // come from: pages carrying the SiteRemade code from Settings.
  if(!visitors&&!views){
    body.innerHTML=`<div class="an-empty" id="analyticsReadyEmpty"><strong>Your site is ready.</strong><span>We’ll start showing visitor activity here as data comes in${d.domain?` from ${esc(d.domain)}`:''}. Visits are counted on pages that include your SiteRemade website code (Settings → Website).${subs?` Meanwhile, ${subs} ${subs===1?'person has':'people have'} contacted you through your site.`:''}</span></div>`;
    return;
  }
  const stat=(label,value,note,extra='')=>`<div class="an-stat ${extra}"><dt>${label}</dt><dd>${value}</dd><p>${note}</p></div>`;
  const list=(title,rows,empty,fmtLabel=x=>x)=>{const data=(Array.isArray(rows)?rows:[]).slice(0,6),max=Math.max(1,...data.map(r=>anNum(r.y)));return `<section class="an-list"><h3>${title}</h3>${data.length?`<ol>${data.map(r=>`<li><span class="an-list-label" title="${esc(r.x||'')}">${esc(fmtLabel(r.x||'(none)'))}</span><span class="an-list-value">${anFmt(anNum(r.y))}</span><i style="width:${Math.max(3,anNum(r.y)/max*100)}%"></i></li>`).join('')}</ol>`:`<p class="an-list-empty">${empty}</p>`}</section>`;};
  const sources=(Array.isArray(d.channels)&&d.channels.length)?d.channels:d.referrers;
  body.innerHTML=`
    <dl class="an-stats">
      ${stat('Visitors',anFmt(visitors),`People who visited in the last ${days} days`)}
      ${stat('Page views',anFmt(views),visits?`${(views/Math.max(1,visits)).toFixed(1)} pages per visit`:'Pages people opened')}
      ${stat('Form submissions',anFmt(subs),'Contact form and chat requests received')}
      ${stat('Button clicks',ctaEvents.length?anFmt(cta):'—',ctaEvents.length?'Calls, bookings and other tracked buttons':'Not tracked on your site yet')}
      ${stat('Conversion rate',conv===null?'—':`${conv<10?conv.toFixed(1):Math.round(conv)}%`,conv===null?'Shown once you’ve had 50+ visitors':'Visitors who got in touch')}
    </dl>
    <section class="an-trend"><div class="an-trend-head"><h2>Visits per day</h2><span class="an-trend-total" id="anTrendReadout"></span></div><div class="an-chart" id="anChart"></div>
      <details class="an-table"><summary>Show as a table</summary><div id="anTable"></div></details></section>
    <div class="an-primary">${list('Most viewed pages',d.pages,'Pages appear here as people browse.')}</div>
    <div class="an-secondary">
      ${list('Where visitors come from',sources,'Direct, search and social visits appear here.')}
      ${list('Devices',d.devices,'No device data yet.',x=>String(x).charAt(0).toUpperCase()+String(x).slice(1))}
      ${list('Countries',d.countries,'No location data yet.',anCountry)}
    </div>
    ${ctaEvents.length||events.length?`<div class="an-secondary an-secondary-one">${list('Tracked actions',events,'')}</div>`:''}`;
  renderAnalyticsChart(anDailySeries(d,days));
}
function anCountry(code){try{return new Intl.DisplayNames(['en'],{type:'region'}).of(String(code).toUpperCase())||code;}catch{return code;}}
// Umami returns only the days that had traffic; fill the gaps with zeros so
// the line doesn't skip across empty days.
function anDailySeries(d,days){
  const raw=(d.series&&(d.series.sessions||d.series.pageviews))||[],by={};
  const key=t=>{const x=new Date(t);return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`;};
  raw.forEach(p=>{const t=typeof p.x==='string'?p.x.replace(' ','T'):p.x;const k=key(t);if(k.includes('NaN'))return;by[k]=(by[k]||0)+anNum(p.y);});
  const out=[];for(let i=days-1;i>=0;i--){const t=new Date();t.setHours(12,0,0,0);t.setDate(t.getDate()-i);out.push({date:t,y:by[key(t)]||0});}
  return out;
}
let anChartSeries=[];
function renderAnalyticsChart(series){
  anChartSeries=series;
  const host=qs('#anChart'),table=qs('#anTable');if(!host)return;
  const fmtD=t=>new Intl.DateTimeFormat('en-CA',{month:'short',day:'numeric'}).format(t);
  if(table)table.innerHTML=`<table><thead><tr><th>Day</th><th>Visits</th></tr></thead><tbody>${series.map(p=>`<tr><td>${esc(fmtD(p.date))}</td><td>${anFmt(p.y)}</td></tr>`).join('')}</tbody></table>`;
  const W=Math.max(280,host.clientWidth||640),H=200,pl=8,pr=8,pt=14,pb=26;
  const max=Math.max(1,...series.map(p=>p.y)),niceMax=max<=4?4:Math.ceil(max/4)*4;
  const x=i=>pl+(series.length<2?0:i*(W-pl-pr)/(series.length-1)),y=v=>pt+(H-pt-pb)*(1-v/niceMax);
  const line=series.map((p,i)=>`${i?'L':'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join('');
  const area=`${line}L${x(series.length-1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;
  const grid=[0,.5,1].map(f=>`<line x1="${pl}" x2="${W-pr}" y1="${y(niceMax*f)}" y2="${y(niceMax*f)}" class="an-grid"/><text x="${W-pr}" y="${y(niceMax*f)-4}" text-anchor="end" class="an-axis">${anFmt(niceMax*f)}</text>`).join('');
  const ticks=[0,Math.floor((series.length-1)/2),series.length-1].map((i,k)=>`<text x="${x(i)}" y="${H-6}" text-anchor="${k===0?'start':k===2?'end':'middle'}" class="an-axis">${esc(fmtD(series[i].date))}</text>`).join('');
  host.innerHTML=`<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Visits per day, last ${series.length} days" tabindex="0">${grid}<path d="${area}" class="an-area"/><path d="${line}" class="an-line"/>${ticks}<line class="an-cross" y1="${pt}" y2="${y(0)}" x1="0" x2="0" visibility="hidden"/><circle class="an-dot" r="4.5" visibility="hidden"/><rect x="0" y="0" width="${W}" height="${H}" fill="transparent" class="an-hit"/></svg><div class="an-tip" hidden><strong></strong><span></span></div>`;
  const svg=host.querySelector('svg'),cross=svg.querySelector('.an-cross'),dot=svg.querySelector('.an-dot'),tip=host.querySelector('.an-tip');
  const total=series.reduce((n,p)=>n+p.y,0),readout=qs('#anTrendReadout');if(readout)readout.textContent=`${anFmt(total)} visits`;
  let focusIdx=series.length-1;
  const show=i=>{i=Math.max(0,Math.min(series.length-1,i));focusIdx=i;const px=x(i),py=y(series[i].y);cross.setAttribute('x1',px);cross.setAttribute('x2',px);cross.setAttribute('visibility','visible');dot.setAttribute('cx',px);dot.setAttribute('cy',py);dot.setAttribute('visibility','visible');tip.hidden=false;tip.querySelector('strong').textContent=`${anFmt(series[i].y)} visit${series[i].y===1?'':'s'}`;tip.querySelector('span').textContent=fmtD(series[i].date);const tw=tip.offsetWidth||110;tip.style.left=Math.min(W-tw,Math.max(0,px-tw/2))+'px';tip.style.top=Math.max(0,py-58)+'px';};
  const hide=()=>{cross.setAttribute('visibility','hidden');dot.setAttribute('visibility','hidden');tip.hidden=true;};
  svg.addEventListener('pointermove',e=>{const r=svg.getBoundingClientRect(),px=(e.clientX-r.left)*(W/r.width);show(Math.round((px-pl)/((W-pl-pr)/Math.max(1,series.length-1))));});
  svg.addEventListener('pointerleave',hide);svg.addEventListener('blur',hide);
  svg.addEventListener('focus',()=>show(focusIdx));
  svg.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'){e.preventDefault();show(focusIdx-1);}else if(e.key==='ArrowRight'){e.preventDefault();show(focusIdx+1);}});
}
if(window.ResizeObserver&&qs('#view-analytics')){let anW=0;new ResizeObserver(()=>{const h=qs('#anChart');if(h&&h.clientWidth&&Math.abs(h.clientWidth-anW)>8){anW=h.clientWidth;if(anChartSeries.length)renderAnalyticsChart(anChartSeries);}}).observe(qs('#view-analytics'));}
qsa('[data-an-days]').forEach(b=>b.onclick=()=>{analyticsState.days=Number(b.dataset.anDays)||30;loadWebsiteAnalytics();});
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
// V2 redesign (Website Projects flagship pass): a purely visual lifecycle
// stepper, additive alongside the existing status control — it does not
// replace or touch #projectStatusSelect's markup or its onchange handler
// (still the only thing that actually changes a project's status), and
// the client-facing branch never had a status control to begin with, just
// a plain text row. Shown to both owner and client views since "where is
// my website right now" is exactly the kind of thing a delivery workspace
// should make visually obvious at a glance instead of burying in a select.
function projectStepper(status){
  const i=Math.max(0,PROJECT_STATUSES.indexOf(status));
  return `<div class="project-stepper">${PROJECT_STATUSES.map((s,idx)=>`<div class="project-stepper-step ${idx<i?'done':idx===i?'current':''}"><i>${idx<i?'✓':idx+1}</i><span>${esc(s)}</span></div>`).join('')}</div>`;
}
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
    // V2 redesign: was an inline style="border:..." per row (with a fallback
    // accent color, #4c6ef5, that did not match the real --accent token
    // anywhere else in the app -- see DESIGN-SYSTEM-V2.md's audit). A
    // .selected class instead lets design-system.css give the active
    // project a real, deliberate selected-state treatment (tinted
    // background + left accent bar) instead of a thin conditional border.
    list.innerHTML=rows.length?rows.map(p=>`<button type="button" class="website-update-item${p.id===state.selectedProjectId?' selected':''}" data-project="${p.id}" style="text-align:left;width:100%;cursor:pointer"><div class="website-update-top"><div><span class="website-update-page">${esc(p.status)}</span><strong>${esc(p.businessName||'Untitled project')}</strong></div><span class="status-pill ${p.clientReviewStatus==='approved'?'':'neutral'}">${esc((p.clientReviewStatus||'not_submitted').replace('_',' ').toUpperCase())}</span></div><p>${p.revisionCount||0} revision${p.revisionCount===1?'':'s'} · ${esc((p.payment&&p.payment.paymentStatus||'none').toUpperCase())}</p></button>`).join(''):'<div class="empty-state">No website projects yet. Start one from a lead.</div>';
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
      ${projectStepper(p.status)}
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
      ${projectStepper(p.status)}
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

// ===========================================================================
// Website (home) — Phase 3C/3D, wired to the builder in Phase 4
// ===========================================================================
// Two data sources, kept deliberately separate (WEBSITEPROJECT-CONTRACT.md):
//  - canonicalWebsite: the generator's own project (the real, editable
//    website), fetched through this app's server (GET /api/app/website ->
//    routes/website-bridge.js -> the generator's /api/app-bridge/website,
//    authorized by the signed-in user's own session). Only filled when that
//    call genuinely succeeds -- never from website_projects.
//  - the delivery record: the app's own website_projects row(s), SiteRemade's
//    internal build/handover tracker. Its staff-entered previewUrl/liveUrl
//    still drive the preview frame (the builder has no preview-rendering
//    URL), and every place they appear says they come from the delivery
//    record. When the builder isn't connected for this customer (bridge off,
//    account not linked, no builder project, staff viewing a customer
//    workspace, any error), the view falls back to exactly the Phase 3
//    delivery-record presentation.
// Phase 9: canonicalWebsite.project now shows either the CANONICAL project
// (the singular /api/app/website, unchanged -- "most recently purchased",
// same as always) or, once the customer has picked a different one from
// the switcher below, that SPECIFIC project (via the project-scoped GET
// /api/app/website/projects/:id). Which one is current is tracked by
// canonicalWebsite.scopedProjectId (null = canonical/default); every
// other reader of canonicalWebsite.project (renderWebsite, renderSettings,
// websiteEditService, deployment/domain display) works unmodified either
// way, since both endpoints return the same summary shape.
const canonicalWebsite={project:null,status:'idle',code:null,message:null,loadedAt:0,inflight:null,scopedProjectId:null};
async function loadCanonicalWebsite(force){
  if(canonicalWebsite.inflight)return canonicalWebsite.inflight;
  if(!force&&canonicalWebsite.status!=='idle'&&Date.now()-canonicalWebsite.loadedAt<60000)return;
  if(canonicalWebsite.status==='idle')canonicalWebsite.status='loading';
  canonicalWebsite.inflight=(async()=>{
    const scoped=websiteView.selectedGeneratorProjectId||null;
    try{
      const url=scoped?`/api/app/website/projects/${encodeURIComponent(scoped)}`:'/api/app/website';
      const r=await fetch(url,{headers:{'Content-Type':'application/json'}});
      const d=await r.json().catch(()=>({}));
      // Phase 8: a builder project existing is no longer enough to call this
      // "Connected" -- the workspace also has to actually be LINKED to it
      // (link.status !== 'not_linked'). A successful summary with
      // link.status:'not_linked' means the builder has a real purchased
      // project for this person, but nobody has connected it to this
      // workspace yet -- exactly the "Connect a website" case below, same
      // as no_project, not the "ready to edit" case. (The project-scoped
      // route never returns a `link` field at all -- forWorkspaceProject
      // already proved this workspace is linked to it before answering, so
      // `!d.link` alone correctly falls into the "ready" branch below.)
      if(r.ok&&d.ok&&d.source==='generator'&&d.projectId&&(!d.link||d.link.status!=='not_linked')){Object.assign(canonicalWebsite,{project:d,status:'ready',code:null,message:null,scopedProjectId:scoped});if(!scoped)loadWebsiteProjectsList();}
      else if(!scoped&&r.ok&&d.ok&&d.source==='generator'&&d.projectId&&d.link&&d.link.status==='not_linked'){Object.assign(canonicalWebsite,{project:null,status:'unavailable',code:'no_project',message:null,scopedProjectId:null});}
      else Object.assign(canonicalWebsite,{project:null,status:'unavailable',code:d.code||'bridge_unavailable',message:d.message||null,scopedProjectId:null});
    }catch(e){Object.assign(canonicalWebsite,{project:null,status:'unavailable',code:'bridge_unavailable',message:null,scopedProjectId:null});}
    finally{canonicalWebsite.loadedAt=Date.now();canonicalWebsite.inflight=null;safeRender('website',renderWebsite);safeRender('settings',renderSettings);}
  })();
  return canonicalWebsite.inflight;
}
// Phase 9: every SiteRemade website this workspace has actually connected
// (not "could connect" -- that's websiteCandidates above). Powers the
// project switcher in the Website/Analytics headers, shown only once
// there's more than one -- for the common single-website case this list is
// length <=1 and nothing in the UI changes. Loaded lazily, only once the
// default/canonical project has confirmed this workspace has at least one
// real connection (see loadCanonicalWebsite's success branch above).
const multiProject={status:'idle',list:[],loadedAt:0,inflight:null};
async function loadWebsiteProjectsList(force){
  if(multiProject.inflight)return multiProject.inflight;
  if(!force&&multiProject.status!=='idle'&&Date.now()-multiProject.loadedAt<60000)return;
  if(multiProject.status==='idle')multiProject.status='loading';
  multiProject.inflight=(async()=>{
    try{
      const r=await fetch('/api/app/website/projects',{headers:{'Content-Type':'application/json'}});
      const d=await r.json().catch(()=>({}));
      if(r.ok&&d.ok&&Array.isArray(d.projects))Object.assign(multiProject,{status:'ready',list:d.projects});
      else Object.assign(multiProject,{status:'unavailable',list:[]});
    }catch(e){Object.assign(multiProject,{status:'unavailable',list:[]});}
    finally{multiProject.loadedAt=Date.now();multiProject.inflight=null;safeRender('website',renderWebsite);safeRender('analytics',renderAnalytics);}
  })();
  return multiProject.inflight;
}
// Customer-facing names only -- never a generator project id or the words
// "canonical"/"linked"/"bridge" (ticket: no internal architecture terms in
// the UI). Falls back to a stable, still-plain-English label when a
// project has no business name yet.
function websiteProjectLabel(p,i){return (p&&(p.businessName||p.name))||`Website ${i+1}`;}
function switchToWebsiteProject(projectId){
  const next=projectId||null;
  if(websiteView.selectedGeneratorProjectId===next)return;
  websiteView.selectedGeneratorProjectId=next;
  canonicalWebsite.status='idle';canonicalWebsite.loadedAt=0;
  analyticsState.cache={}; // a different website's own numbers -- never show a stale cached read from the last one
  loadCanonicalWebsite(true);
  safeRender('website',renderWebsite);safeRender('analytics',renderAnalytics);
  if(qs('#view-analytics')?.classList.contains('active'))loadWebsiteAnalytics(true);
}
function renderProjectSwitcher(hostId,current){
  const host=qs('#'+hostId);if(!host)return;
  const list=multiProject.list;
  if(list.length<2){host.hidden=true;host.innerHTML='';host.dataset.sig='';return;}
  const currentId=current||list.find(p=>!p.unavailable)?.projectId||list[0].projectId;
  // Signature-guarded like the rest of this file's small status blocks
  // (renderWebsiteBuilderBlock etc.): this can be re-rendered every 5s by
  // the live refresh, and rebuilding the <select> mid-interaction would
  // drop an open dropdown or the customer's in-progress click.
  const sig=JSON.stringify([list.map(p=>[p.projectId,p.businessName,p.name,p.unavailable]),currentId]);
  if(host.dataset.sig===sig)return;host.dataset.sig=sig;
  host.hidden=false;
  host.innerHTML=`<label for="${hostId}Select">Website<select id="${hostId}Select">${list.map((p,i)=>`<option value="${esc(p.projectId)}" ${p.projectId===currentId?'selected':''}>${esc(websiteProjectLabel(p,i))}${p.unavailable?' (unavailable)':''}</option>`).join('')}</select></label>`;
  const sel=qs('#'+hostId+'Select');if(sel)sel.onchange=()=>switchToWebsiteProject(sel.value);
}
// Phase 8: "connect a website" -- every SiteRemade website this signed-in
// person has actually purchased, fetched fresh from the builder (GET
// /api/app/website/candidates -> routes/website-bridge.js -> the builder's
// GET /api/app-bridge/website/candidates, same token-verified ownership
// check as everything else here). Separate from canonicalWebsite, which
// only ever answers "what is THE linked/canonical project" -- this answers
// "what COULD this workspace connect to", so the Website page can offer a
// real 0/1/many "Connect a website" action instead of a dead end.
const websiteCandidates={status:'idle',list:[],loadedAt:0,inflight:null,connecting:null,error:null};
async function loadWebsiteCandidates(force){
  if(websiteCandidates.inflight)return websiteCandidates.inflight;
  if(!force&&websiteCandidates.status!=='idle'&&Date.now()-websiteCandidates.loadedAt<60000)return;
  if(websiteCandidates.status==='idle')websiteCandidates.status='loading';
  websiteCandidates.inflight=(async()=>{
    try{
      const r=await fetch('/api/app/website/candidates',{headers:{'Content-Type':'application/json'}});
      const d=await r.json().catch(()=>({}));
      if(r.ok&&d.ok&&Array.isArray(d.candidates)){Object.assign(websiteCandidates,{status:'ready',list:d.candidates,error:null});}
      else Object.assign(websiteCandidates,{status:'unavailable',list:[],error:null});
    }catch(e){Object.assign(websiteCandidates,{status:'unavailable',list:[],error:null});}
    finally{websiteCandidates.loadedAt=Date.now();websiteCandidates.inflight=null;safeRender('website',renderWebsite);}
  })();
  return websiteCandidates.inflight;
}
// The explicit connect action (POST /api/app/website/connect). Re-verified
// server-side against a fresh candidates call there too -- this just names
// which one the customer picked.
async function connectWebsite(projectId){
  if(websiteCandidates.connecting)return;
  websiteCandidates.connecting=projectId;websiteCandidates.error=null;renderWebsiteBuilderBlock();
  try{
    await api('/api/app/website/connect',{method:'POST',body:JSON.stringify({projectId})});
    websiteCandidates.connecting=null;
    await Promise.all([loadCanonicalWebsite(true),loadWebsiteCandidates(true)]);
  }catch(e){
    websiteCandidates.connecting=null;websiteCandidates.error=e.message||'Couldn’t connect your website right now.';renderWebsiteBuilderBlock();
  }
}
// The single seam the editor uses to reach the builder. Real network calls
// only when the builder genuinely returned this customer's project;
// otherwise it answers contract_unavailable WITHOUT a network call, and
// nothing is ever reported as applied unless the builder said it saved it.
const websiteEditService={
  available(){const p=canonicalWebsite.project;return canonicalWebsite.status==='ready'&&!!(p&&p.canEdit);},
  _unavailable(){return {ok:false,code:'contract_unavailable',message:'Your site isn’t connected to the SiteRemade builder yet, so this app can’t change it.'};},
  async _post(url,payload){
    try{
      const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const d=await r.json().catch(()=>({}));
      if(r.ok&&d.ok)return d;
      return {ok:false,status:r.status,code:d.code||'bridge_unavailable',message:d.message||'That didn’t go through.',currentRevision:d.currentRevision};
    }catch(e){return {ok:false,code:'bridge_unavailable',message:'The SiteRemade builder couldn’t be reached.'};}
  },
  // Phase 9: when the switcher has a specific (non-default) website
  // selected, canonicalWebsite.scopedProjectId is that project's id -- use
  // the project-scoped edit/publish routes so this genuinely targets THAT
  // website. The singular routes only ever resolve "the canonical
  // (most-recently-purchased) website", so posting to them for a
  // deliberately different selection would just 409 revision_conflict
  // every time. The default/canonical case (scopedProjectId null) is
  // untouched -- same URL, same body shape as before Phase 9.
  async requestEdit({projectId,baseRevision,instruction}){
    if(!this.available())return this._unavailable();
    const scoped=canonicalWebsite.scopedProjectId;
    if(scoped)return this._post(`/api/app/website/projects/${encodeURIComponent(scoped)}/edits`,{baseRevision,request:instruction});
    return this._post('/api/app/website/edits',{baseRevision,request:instruction,expectedProjectId:projectId});
  },
  async publish({projectId,revision}){
    if(!this.available())return this._unavailable();
    const scoped=canonicalWebsite.scopedProjectId;
    if(scoped)return this._post(`/api/app/website/projects/${encodeURIComponent(scoped)}/publish`,{revision});
    return this._post('/api/app/website/publish',{revision,expectedProjectId:projectId});
  }
};
// Editor states (contract §6, Phase 4N). Spec name -> state here:
//   READY -> idle/typing · PLANNING -> planning (the edit request is with
//   the builder) · APPLYING -> applying (re-reading the builder to confirm
//   the saved draft) · PREVIEW_READY -> preview_ready (the plain-language
//   change summary, NOT a rendered preview -- the builder has no preview
//   URL yet) · PUBLISHING -> publishing · LIVE -> live ("Published": the
//   version the builder will export; nothing is pushed to the web address
//   automatically) · CONFLICT -> conflict · FAILED -> failed.
// 'unavailable' is the Phase 3 not-connected state, unchanged.
const WEBSITE_EDITOR_STATES=['idle','typing','planning','applying','preview_ready','publishing','live','conflict','failed','unavailable'];
const EDITOR_STICKY_STATES=['planning','applying','preview_ready','publishing','live','conflict','failed'];
const EDITOR_BUSY_STATES=['planning','applying','publishing'];
const websiteEditor={state:'idle',edit:null,error:null,sentToTeam:null,sending:false,published:null};
const EDITOR_DEV_REQUESTED=new URLSearchParams(location.search).get('editor')==='dev';
function editorDevMode(){return EDITOR_DEV_REQUESTED&&state.user?.role==='owner';}
// selectedGeneratorProjectId: Phase 9's project switcher -- null means "the
// default/canonical SiteRemade website" (unchanged behavior); a real
// generator project id means the customer explicitly picked a different
// one of their connected websites. Distinct from projectId below, which is
// the unrelated legacy delivery-record (website_projects) selection.
const websiteView={device:null,frameSrc:'',projectId:null,selectedGeneratorProjectId:null};
const EDIT_MAX_CHARS=600;

// Only ever hand http(s) URLs to an <iframe>/<a>: these are free-text
// fields staff type into, so anything else (javascript:, data:, junk) is
// treated as "no address".
function safeSiteUrl(raw){const v=String(raw||'').trim();if(!v)return '';try{const u=new URL(/^https?:\/\//i.test(v)?v:'https://'+v);return /^https?:$/.test(u.protocol)&&u.hostname.includes('.')?u.toString():'';}catch{return '';}}
function siteHost(url){try{return new URL(url).hostname.replace(/^www\./,'');}catch{return '';}}
function deliveryProjects(){const rank=p=>safeSiteUrl(p.liveUrl)?2:safeSiteUrl(p.previewUrl)?1:0;return [...(state.websiteProjects||[])].sort((a,b)=>rank(b)-rank(a)||new Date(b.updatedAt)-new Date(a.updatedAt));}
function currentDeliveryProject(){const rows=deliveryProjects();return rows.find(p=>p.id===websiteView.projectId)||rows[0]||null;}
function websiteSnapshot(){
  const p=currentDeliveryProject(),live=safeSiteUrl(p?.liveUrl),preview=safeSiteUrl(p?.previewUrl);
  const c=canonicalWebsite.status==='ready'?canonicalWebsite.project:null;
  const builderDomain=c&&c.domains&&c.domains[0]?c.domains[0].domain:'';
  const domain=builderDomain||siteHost(live)||String(state.websiteAnalytics?.domain||'').trim();
  const key=live?'live':preview?'preview':p?'building':'none';
  return {project:p,canonical:c,live,preview,url:live||preview,domain,key};
}
const WEBSITE_STATE_COPY={
  live:{chip:'Live',tone:'success',caption:'Showing your live site'},
  preview:{chip:'Preview · not live yet',tone:'warning',caption:'Showing your preview'},
  building:{chip:'Being built',tone:'neutral',caption:'No preview yet'},
  none:{chip:'Not set up yet',tone:'neutral',caption:'No preview yet'}
};
// Builder-sourced status (only when canonicalWebsite is 'ready').
function canonicalChip(c){
  if(c.status!=='purchased')return {chip:'Draft · not purchased yet',tone:'neutral'};
  if(c.hasUnpublishedChanges)return {chip:'Unpublished changes',tone:'warning'};
  return {chip:'Up to date',tone:'success'};
}
const DEPLOYMENT_COPY={
  not_deployed:['Not hosted by SiteRemade','SiteRemade doesn’t host or push your site automatically yet.'],
  packaging:['Preparing your files',''],
  ready:['Download prepared in the builder','A downloadable copy of your site was prepared in the builder (My Websites) — download again there after publishing to get the newest version. SiteRemade doesn’t push your site to your web address automatically yet.'],
  failed:['Last export didn’t finish','Open the builder to try the download again.'],
  live:['Live','']
};
const DOMAIN_STATE_COPY={not_configured:'not set up',instructions_generated:'DNS instructions ready',dns_pending:'waiting for DNS',verified:'reachable (not yet HTTPS)',ssl_pending:'waiting for HTTPS',live:'reachable over HTTPS'};
function setChip(el,text,tone){if(!el)return;el.textContent=text;el.className=`chip chip-${tone||'neutral'}`;}

function renderWebsite(){
  const view=qs('#view-website');if(!view)return;
  if(canonicalWebsite.status==='idle'&&state.user)loadCanonicalWebsite();
  renderProjectSwitcher('websiteProjectSwitcher',websiteView.selectedGeneratorProjectId||(canonicalWebsite.status==='ready'?canonicalWebsite.project.projectId:null));
  const s=websiteSnapshot(),copy=WEBSITE_STATE_COPY[s.key],p=s.project,c=s.canonical;
  const name=(c&&c.businessName)||state.workspace.businessName||'Your website';
  qs('#websiteTitle').textContent=name;
  const status=c?canonicalChip(c):{chip:copy.chip,tone:copy.tone};
  setChip(qs('#websiteStateChip'),status.chip,status.tone);
  qs('#websiteDomainLine').textContent=s.domain||'No web address yet';
  const view_=qs('#websiteViewLink');if(view_){view_.hidden=!s.url;if(s.url){view_.href=s.url;view_.textContent=s.live?'View website ↗':'Open preview ↗';}}
  // Publish: builder-only (contract §9). Never shown from delivery data.
  const pub=qs('#websitePublishButton');if(pub){pub.hidden=!(c&&c.canPublish&&c.hasUnpublishedChanges)||EDITOR_BUSY_STATES.includes(websiteEditor.state);pub.disabled=EDITOR_BUSY_STATES.includes(websiteEditor.state);}
  // Status rail
  const stateVal=qs('#websiteStateValue');if(stateVal)stateVal.innerHTML=c?`<span class="chip chip-${status.tone}">${esc(status.chip)}</span>`:`<span class="chip chip-${copy.tone}">${esc(s.key==='building'&&p?`Being built · ${p.status}`:copy.chip)}</span>`;
  const dom=qs('#websiteDomainValue');if(dom){const bd=c&&c.domains&&c.domains[0];dom.textContent=bd?`${bd.domain} · ${DOMAIN_STATE_COPY[bd.state]||bd.state}`:(s.domain||'Not set');}
  const dep=qs('#websiteDeployValue');if(dep){if(c){const dc=DEPLOYMENT_COPY[c.deploymentStatus]||DEPLOYMENT_COPY.not_deployed;dep.textContent=dc[0];dep.title=dc[1];}else{dep.textContent='Not reported yet';dep.title='The SiteRemade builder doesn’t share deployment status with this app yet.';}}
  const updLabel=qs('#websiteUpdatedLabel');if(updLabel)updLabel.textContent=c?'Last edited':'Record updated';
  const upd=qs('#websiteUpdatedValue');if(upd)upd.textContent=c?`${c.updatedAt?dateLabel(c.updatedAt):'—'} · version ${c.revision}`:(p?.updatedAt?dateLabel(p.updatedAt):'—');
  // Stage (the frame can only ever show a delivery-record address -- the
  // builder has no preview-rendering URL -- so it says so)
  qs('#websiteChromeUrl').textContent=s.url?s.url.replace(/^https?:\/\//,'').replace(/\/$/,''):'No web address yet';
  qs('#websiteCaption').textContent=s.url
    ?(c?`${copy.caption} · address from your SiteRemade delivery record. Builder changes appear there only once they’re published and put live.`:`${copy.caption} · from your SiteRemade delivery record`)
    :(c?'There’s no visual preview in this app yet — your builder project is connected, and changes you make are listed below the editor.':(p?`Your site is being built (${p.status}). The preview appears here once it's ready.`:'No preview yet'));
  const capLink=qs('#websiteCaptionLink');if(capLink){capLink.hidden=!s.url;if(s.url)capLink.href=s.url;}
  const emptyCopy=qs('#websiteEmptyCopy');if(emptyCopy)emptyCopy.textContent=c?'This app can’t render your builder project yet. Open the SiteRemade builder to see it, or check the change summary after an update.':(p?`Your site is being built — currently at “${p.status}”. The preview appears here once SiteRemade adds it.`:'As soon as SiteRemade has a preview or live address for your site, you’ll see it right here.');
  if(!websiteView.device)setWebsiteDevice(window.matchMedia('(max-width:640px)').matches?'mobile':'desktop');
  setWebsiteFrame(s.url);
  renderWebsiteBuilderBlock();renderWebsiteDelivery(s);renderWebsiteRequests();renderWebsiteEditor();
}
// "Builder project" support block: real connection state, never guessed.
// Phase 8: when there's no link yet, this is now a real "Connect a
// website" action (0/1/many purchased-project cases), not just a status
// message -- see websiteCandidates above.
function renderWebsiteBuilderBlock(){
  const host=qs('#websiteBuilder');if(!host)return;
  const c=canonicalWebsite.status==='ready'?canonicalWebsite.project:null,code=canonicalWebsite.code,st=canonicalWebsite.status;
  const sig=JSON.stringify([st,code,c&&[c.projectId,c.revision,c.updatedAt,c.status,c.lastPublishedAt,c.link&&c.link.status],websiteCandidates.status,websiteCandidates.list,websiteCandidates.connecting,websiteCandidates.error]);if(host.dataset.sig===sig)return;host.dataset.sig=sig;
  const link='<a class="site-support-link" href="/handoff/website-builder">Open the SiteRemade builder ↗</a>';
  if(c){
    host.innerHTML=`<p class="eyebrow">BUILDER PROJECT</p><h3>Connected</h3><p>Version ${esc(String(c.revision))}${c.updatedAt?` · last edited ${esc(dateLabel(c.updatedAt))}`:''}. ${c.status==='purchased'?(c.lastPublishedAt?`Last published ${esc(dateLabel(c.lastPublishedAt))}.`:'Not re-published since purchase.'):'Not purchased yet — edits are saved as drafts.'} Updates you ask for above are saved straight to this project.</p>${c.link&&(c.link.status==='mismatch'||c.link.status==='conflict')?`<p class="site-support-note" id="websiteLinkNote">${c.link.status==='mismatch'?'This business is linked to a different builder website than the one your account shows now. Nothing was changed — contact SiteRemade if that isn’t expected.':'This builder website is already linked to another business on SiteRemade. Contact SiteRemade if that isn’t expected.'}</p>`:''}${link}`;
    return;
  }
  // Staff viewing a customer workspace, or an account tied to more than one
  // business: never shown a connect chooser here (that's exactly the
  // ambiguity workspaceGate exists to avoid) -- Admin's "Website links"
  // panel is the right place for staff, and a multi-workspace person picks
  // a workspace elsewhere in this app first.
  if(code==='workspace_mismatch'){
    host.innerHTML=`<p class="eyebrow">BUILDER PROJECT</p><h3>Not connected here</h3><p>${esc(canonicalWebsite.message||'Builder data isn’t shown for this workspace.')}</p>${link}`;
    return;
  }
  if(code==='identity_not_linked'){
    const connectAccount='<a class="primary-action" href="/handoff/website-builder?mode=link&return='+encodeURIComponent('https://www.siteremade.com/')+'">Connect your SiteRemade account</a>';
    host.innerHTML=`<p class="eyebrow">BUILDER PROJECT</p><h3>${st==='loading'?'Checking…':'Connect your account'}</h3><p>Your Workplace account and SiteRemade builder account need to be linked once before your purchased websites can appear here.</p><div class="admin-relink-actions">${connectAccount}</div>`;
    return;
  }
  // Every other case (no_project, or the canonical lookup simply hasn't
  // resolved) is exactly where a real connect flow belongs: ask the
  // builder, with this same session, what this person has actually bought.
  if(websiteCandidates.status==='idle')loadWebsiteCandidates();
  if(st==='loading'||websiteCandidates.status==='loading'){
    host.innerHTML=`<p class="eyebrow">BUILDER PROJECT</p><h3>Checking…</h3><p>Looking for your SiteRemade websites…</p>`;
    return;
  }
  if(websiteCandidates.status==='unavailable'){
    host.innerHTML=`<p class="eyebrow">BUILDER PROJECT</p><h3>Not connected yet</h3><p>${esc(canonicalWebsite.message||'Your site\'s editable source lives in the SiteRemade builder. This app couldn\'t check your SiteRemade websites just now.')}</p>${link}`;
    return;
  }
  const cands=websiteCandidates.list,errLine=websiteCandidates.error?`<p class="modal-status" role="status">${esc(websiteCandidates.error)}</p>`:'';
  if(!cands.length){
    host.innerHTML=`<p class="eyebrow">BUILDER PROJECT</p><h3>Connect a website</h3><p>We didn’t find a purchased SiteRemade website on your account yet. Once you’ve bought one in the builder, it’ll show up here to connect.</p>${link}`;
    return;
  }
  const nameOf=k=>k.businessName||k.name||'Untitled website';
  if(cands.length===1){
    const k=cands[0],dom=k.domains&&k.domains[0]?k.domains[0].domain:null,busy=websiteCandidates.connecting===k.projectId;
    host.innerHTML=`<p class="eyebrow">BUILDER PROJECT</p><h3>We found your SiteRemade website</h3><p>“${esc(nameOf(k))}”${dom?` · ${esc(dom)}`:''} — connect it to start editing, publishing and seeing its status from here.</p><div class="admin-relink-actions"><button type="button" class="primary-action" id="websiteConnectSingle" ${busy?'disabled':''}>${busy?'Connecting…':'Connect this website'}</button></div>${errLine}${link}`;
    const btn=qs('#websiteConnectSingle');if(btn)btn.onclick=()=>connectWebsite(k.projectId);
    return;
  }
  const cardFor=k=>{const dom=k.domains&&k.domains[0]?k.domains[0].domain:null;return `<label class="admin-relink-option"><input type="radio" name="website-connect-pick" value="${esc(k.projectId)}" ${websiteCandidates.connecting?'disabled':''}><span><strong>${esc(nameOf(k))}</strong>${dom?` · ${esc(dom)}`:''} · version ${k.revision!==null&&k.revision!==undefined?esc(String(k.revision)):'—'}${k.purchasedAt?` · purchased ${esc(dateLabel(k.purchasedAt))}`:''}</span></label>`;};
  host.innerHTML=`<p class="eyebrow">BUILDER PROJECT</p><h3>Connect a website</h3><p>We found ${cands.length} SiteRemade websites on your account. Choose the one for this business.</p><fieldset class="admin-relink-list">${cands.map(cardFor).join('')}</fieldset><div class="admin-relink-actions"><button type="button" class="primary-action" id="websiteConnectChosen" ${websiteCandidates.connecting?'disabled':''}>${websiteCandidates.connecting?'Connecting…':'Connect'}</button></div>${errLine}${link}`;
  const goBtn=qs('#websiteConnectChosen');if(goBtn)goBtn.onclick=()=>{const picked=qs('input[name="website-connect-pick"]:checked');if(!picked){websiteCandidates.error='Choose a website first.';host.dataset.sig='';renderWebsiteBuilderBlock();return;}connectWebsite(picked.value);};
}
function setWebsiteFrame(url){
  const f=qs('#websiteFrame'),empty=qs('#websiteEmpty');if(!f||!empty)return;
  if(!url){f.hidden=true;if(f.getAttribute('src'))f.removeAttribute('src');websiteView.frameSrc='';empty.hidden=false;return;}
  empty.hidden=true;f.hidden=false;
  if(websiteView.frameSrc!==url){websiteView.frameSrc=url;f.src=url;}
  fitWebsiteFrame();
}
function setWebsiteDevice(dev){
  websiteView.device=dev==='mobile'?'mobile':'desktop';
  const stage=qs('#websiteStage');if(stage)stage.dataset.device=websiteView.device;
  qsa('[data-site-device]').forEach(b=>{const on=b.dataset.siteDevice===websiteView.device;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));});
  fitWebsiteFrame();
}
// Renders the site at a real desktop (1440px) or phone (390px) width and
// scales it down to the stage, so "Desktop" actually shows the desktop
// layout instead of whatever breakpoint the stage width happens to hit.
function fitWebsiteFrame(){
  const c=qs('#websiteCanvas'),f=qs('#websiteFrame');if(!c||!f||f.hidden)return;
  const W=c.clientWidth,H=c.clientHeight;if(!W||!H)return;
  if(websiteView.device==='mobile'){const bw=390,bh=844,sc=Math.min(1,H/bh,W/bw);f.style.width=bw+'px';f.style.height=bh+'px';f.style.transform=`scale(${sc})`;f.style.left=Math.max(0,(W-bw*sc)/2)+'px';f.style.top=Math.max(0,(H-bh*sc)/2)+'px';}
  else{const bw=1440,sc=W/bw;f.style.width=bw+'px';f.style.height=(H/sc)+'px';f.style.transform=`scale(${sc})`;f.style.left='0px';f.style.top='0px';}
}
if(window.ResizeObserver&&qs('#websiteCanvas'))new ResizeObserver(()=>fitWebsiteFrame()).observe(qs('#websiteCanvas'));
qsa('[data-site-device]').forEach(b=>b.onclick=()=>setWebsiteDevice(b.dataset.siteDevice));

// Build & handover (the delivery record), including the client review step
// that used to live on the Website Projects screen. Re-rendered only when
// its data actually changes, so the 5s live refresh can't wipe feedback a
// customer is typing.
function renderWebsiteDelivery(s){
  const host=qs('#websiteDelivery');if(!host)return;
  const p=s.project,rows=deliveryProjects(),owner=state.user?.role==='owner';
  const canReview=!!p&&(!!safeSiteUrl(p.previewUrl)||p.status==='Review')&&p.status!=='Delivered'&&p.clientReviewStatus!=='approved';
  const sig=JSON.stringify([p?.id,p?.status,p?.clientReviewStatus,p?.clientReviewFeedback,p?.updatedAt,rows.length,owner,canReview]);
  if(host.dataset.sig===sig)return;host.dataset.sig=sig;
  if(!p){host.innerHTML=`<p class="eyebrow">BUILD &amp; HANDOVER</p><h3>Nothing on file yet</h3><p>When SiteRemade starts building your site, its progress shows up here.</p>`;return;}
  const review=p.clientReviewStatus==='approved'?'<p class="site-support-note">You approved this version.</p>':p.clientReviewStatus==='changes_requested'?`<p class="site-support-note">You asked for changes${p.clientReviewFeedback?`: “${esc(p.clientReviewFeedback)}”`:''}. SiteRemade is on it.</p>`:'';
  host.innerHTML=`
    <p class="eyebrow">BUILD &amp; HANDOVER</p>
    <h3>${esc(p.status==='Delivered'?'Delivered':`In progress · ${p.status}`)}</h3>
    ${rows.length>1?`<label class="site-project-pick">Showing<select id="websiteProjectPick">${rows.map(r=>`<option value="${esc(r.id)}" ${r.id===p.id?'selected':''}>${esc(r.businessName||'Your website')}</option>`).join('')}</select></label>`:''}
    ${projectStepper(p.status)}
    <p>From your SiteRemade delivery record — this tracks the build and handover of your site, not live edits.</p>
    ${review}
    ${canReview?`<form id="websiteReviewForm" class="site-review">
      <label for="websiteReviewFeedback">Your preview is ready for review</label>
      <textarea id="websiteReviewFeedback" rows="3" placeholder="Anything you'd like changed before it goes live? (optional if you're approving)"></textarea>
      <div class="site-review-actions"><button class="primary-action" type="submit">Approve</button><button class="secondary-button" type="button" id="websiteRequestChanges">Request changes</button></div>
      <p class="modal-status" id="websiteReviewStatus" role="status"></p>
    </form>`:''}
    ${owner?`<button type="button" class="site-support-link" id="websiteOpenProject">Edit delivery record (staff) →</button>`:''}`;
  const pick=qs('#websiteProjectPick');if(pick)pick.onchange=()=>{websiteView.projectId=pick.value;renderWebsite();};
  const open=qs('#websiteOpenProject');if(open)open.onclick=()=>{state.selectedProjectId=p.id;switchView('website-projects');renderWebsiteProjects();};
  const form=qs('#websiteReviewForm');
  if(form){
    const send=async(decision)=>{const fb=qs('#websiteReviewFeedback').value.trim(),out=qs('#websiteReviewStatus');if(decision==='changes_requested'&&!fb){out.textContent='Add a note about what should change first.';return;}out.textContent='Sending…';try{const d=await api(`/api/app/website-projects/${p.id}/review`,{method:'POST',body:JSON.stringify({decision,feedback:fb})});const i=state.websiteProjects.findIndex(x=>x.id===p.id);if(i>=0)state.websiteProjects[i]=d.project;host.dataset.sig='';renderWebsite();renderWebsiteProjects();}catch(e){out.textContent=e.message;}};
    form.onsubmit=e=>{e.preventDefault();send('approved');};
    qs('#websiteRequestChanges').onclick=()=>send('changes_requested');
  }
}

// Requests sent to the SiteRemade team (the pre-existing human queue:
// website_updates rows with no project_id). Read-only here.
function renderWebsiteRequests(){
  const host=qs('#websiteRequests');if(!host)return;
  const rows=(state.websiteUpdates||[]).filter(r=>!r.projectId).slice(0,4);
  const sig=JSON.stringify(rows.map(r=>[r.id,r.status,r.updatedAt]));if(host.dataset.sig===sig)return;host.dataset.sig=sig;
  const tone=st=>st==='Completed'?'success':st==='In Progress'?'info':'neutral';
  host.innerHTML=`<p class="eyebrow">REQUESTS TO THE TEAM</p><h3>${rows.length?'Your recent requests':'Nothing sent yet'}</h3>`+
    (rows.length?`<ul class="site-request-list">${rows.map(r=>`<li><p>${esc(r.request)}</p><span><span class="chip chip-${tone(r.status)}">${esc(r.status)}</span> ${esc(dateLabel(r.createdAt))}</span></li>`).join('')}</ul>`
    :`<p>Things you send to the SiteRemade team show up here with their status. A person handles these — they aren't automatic edits.</p>`);
}

// ---- Update My Website: the interaction shell ------------------------------
function withNothingChanged(msg){const m=String(msg||'That didn’t go through.').trim();return /nothing (on your website )?was changed|nothing was changed/i.test(m)?m:`${m} Nothing on your website was changed.`;}
function renderWebsiteEditor(){
  const box=qs('#siteEditor'),input=qs('#siteEditorInput');if(!box||!input)return;
  const available=websiteEditService.available(),dev=editorDevMode(),text=input.value.trim(),c=canonicalWebsite.project;
  let st=websiteEditor.state;
  if(!EDITOR_STICKY_STATES.includes(st))st=!available&&!dev?'unavailable':(text?'typing':'idle');
  websiteEditor.state=st;box.dataset.state=st;box.dataset.hasText=text?'1':'0';
  const pill={unavailable:canonicalWebsite.status==='loading'?'Checking…':'Not connected yet',idle:dev&&!available?'Development mode':'Ready',typing:dev&&!available?'Development mode':'Ready',planning:'Working out your change…',applying:'Saving your update…',preview_ready:'Change ready to review',publishing:'Publishing…',live:'Published',conflict:'Website changed',failed:'Nothing was changed'}[st];
  qs('#siteEditorPill').textContent=pill;
  const busy=EDITOR_BUSY_STATES.includes(st);
  const submit=qs('#siteEditorSubmit');submit.disabled=!(available||dev)||!text||busy;
  input.readOnly=busy;
  const handoff=qs('#siteEditorHandoff');handoff.hidden=!text||websiteEditor.sending||busy||(available&&st!=='failed');
  const prog=qs('#siteEditorProgress'),order=['planning','applying','preview_ready','live'],cur={planning:0,applying:1,preview_ready:2,publishing:3,live:4}[st];prog.hidden=cur===undefined;
  qsa('#siteEditorProgress li').forEach(li=>{const i=order.indexOf(li.dataset.step);li.classList.toggle('done',cur>i);li.classList.toggle('current',cur===i||(st==='publishing'&&li.dataset.step==='live'));});
  // "What changed" review panel: the builder's own plain-language summary of
  // what it actually saved -- the honest stand-in for a rendered preview.
  const review=qs('#siteEditorReview');
  if(review){
    const showReview=['preview_ready','publishing','live'].includes(st)&&!!websiteEditor.edit;
    review.hidden=!showReview&&st!=='live'&&st!=='conflict';
    const list=qs('#siteEditorChanges'),note=qs('#siteEditorReviewNote'),head=qs('#siteEditorReviewTitle');
    const sig=JSON.stringify([st,websiteEditor.edit,websiteEditor.published,c&&[c.canPublish,c.revision,c.hasUnpublishedChanges]]);
    if(review.dataset.sig!==sig){
      review.dataset.sig=sig;
      const items=(websiteEditor.edit&&websiteEditor.edit.changeSummary)||[];
      if(head)head.textContent=st==='conflict'?'Your website changed':st==='live'?'Published':'What changed';
      if(list){list.hidden=st==='conflict'||!items.length;list.innerHTML=items.map(t=>`<li>${esc(t)}</li>`).join('');}
      const credits=websiteEditor.edit&&Number.isFinite(websiteEditor.edit.creditsCharged)&&websiteEditor.edit.creditsCharged>0?` This update used ${websiteEditor.edit.creditsCharged} builder credit${websiteEditor.edit.creditsCharged===1?'':'s'}${Number.isFinite(websiteEditor.edit.creditsRemaining)?` (${websiteEditor.edit.creditsRemaining} left today)`:''}.`:'';
      if(note){
        if(st==='conflict')note.textContent='Your text is still in the box above. Refresh to load the latest version, then apply your update again.';
        else if(st==='live')note.textContent=`Version ${websiteEditor.published?.revision??c?.revision} is now your published version — downloads of your site files from the builder include it from now on. Updating the site at your web address isn’t automatic yet: download the files from the builder, or ask the SiteRemade team.`;
        else if(c&&c.canPublish)note.textContent=`Saved as a draft (version ${websiteEditor.edit?.revision}). Your published version hasn’t changed. There’s no visual preview in this app yet — open the builder to see it, then publish when you’re happy.${credits}`;
        else note.textContent=`Saved to your builder project (version ${websiteEditor.edit?.revision}). There’s no visual preview in this app yet — open the builder to see it. Publishing becomes available once your website is purchased.${credits}`;
      }
    }
    const pubBtn=qs('#siteEditorPublish');if(pubBtn){pubBtn.hidden=!(st==='preview_ready'&&c&&c.canPublish&&c.hasUnpublishedChanges);pubBtn.disabled=busy;}
    const refBtn=qs('#siteEditorRefresh');if(refBtn)refBtn.hidden=st!=='conflict';
    const doneBtn=qs('#siteEditorDone');if(doneBtn)doneBtn.hidden=!['preview_ready','live'].includes(st);
  }
  const fb=qs('#siteEditorFeedback');fb.classList.toggle('is-error',st==='failed'||st==='conflict');fb.classList.toggle('is-success',(!!websiteEditor.sentToTeam&&st!=='failed')||st==='live');
  if(websiteEditor.sending)fb.textContent='Sending to the SiteRemade team…';
  else if(st==='failed')fb.textContent=`${withNothingChanged(websiteEditor.error?.message)} Your text is still here.`;
  else if(st==='conflict')fb.textContent='This website changed since you opened it. Refresh before applying this update.';
  else if(st==='planning')fb.textContent='Working out and saving your change — this can take up to a minute.';
  else if(st==='applying')fb.textContent='Checking the saved version with the builder…';
  else if(st==='publishing')fb.textContent='Publishing…';
  else if(websiteEditor.sentToTeam)fb.textContent='Sent to the SiteRemade team. A person will review it — your website hasn’t changed yet. You can follow it under “Requests to the team” below.';
  else if(st==='unavailable')fb.textContent=canonicalWebsite.status==='loading'?'Checking whether your site is connected to the SiteRemade builder…':'Editing from here turns on once your site is connected to the SiteRemade builder. Nothing you type is sent or changed until you choose to.';
  else if(dev&&!available)fb.textContent='Development mode (staff only): submitting runs the edit service stub, which always ends in “nothing was changed” until the builder contract exists.';
  else fb.textContent='';
}
function setEditorState(next,extra={}){if(!WEBSITE_EDITOR_STATES.includes(next))return;Object.assign(websiteEditor,extra,{state:next});renderWebsiteEditor();safeRender('website-publish',()=>{const pub=qs('#websitePublishButton'),c=canonicalWebsite.status==='ready'?canonicalWebsite.project:null;if(pub){pub.hidden=!(c&&c.canPublish&&c.hasUnpublishedChanges)||EDITOR_BUSY_STATES.includes(next);pub.disabled=EDITOR_BUSY_STATES.includes(next);}});}
async function submitWebsiteEdit(){
  const input=qs('#siteEditorInput'),text=input.value.trim();if(!text||EDITOR_BUSY_STATES.includes(websiteEditor.state))return;
  if(!websiteEditService.available()&&!editorDevMode()){renderWebsiteEditor();return;}
  websiteEditor.sentToTeam=null;
  if(websiteEditService.available()&&text.length>EDIT_MAX_CHARS){setEditorState('failed',{error:{message:`Please keep automatic updates under ${EDIT_MAX_CHARS} characters — or send longer requests to the SiteRemade team.`}});return;}
  setEditorState('planning',{error:null,edit:null,published:null});
  const c=canonicalWebsite.project;
  const res=await websiteEditService.requestEdit({projectId:c?.projectId||null,baseRevision:c?.revision??null,instruction:text});
  if(!res||!res.ok){
    if(res&&res.code==='revision_conflict'){setEditorState('conflict',{error:res});return;}
    setEditorState('failed',{error:res||{message:'No response.'}});return;
  }
  // Saved by the builder. APPLYING = confirm that saved draft by re-reading
  // the builder project (a real call, not a timed animation).
  setEditorState('applying',{edit:{revision:res.revision,changeSummary:res.changeSummary||[],creditsCharged:res.creditsCharged,creditsRemaining:res.creditsRemaining}});
  input.value='';
  await loadCanonicalWebsite(true);
  setEditorState('preview_ready');
}
async function publishWebsite(){
  const c=canonicalWebsite.status==='ready'?canonicalWebsite.project:null;
  if(!c||!c.canPublish||EDITOR_BUSY_STATES.includes(websiteEditor.state))return;
  setEditorState('publishing',{error:null});
  const res=await websiteEditService.publish({projectId:c.projectId,revision:c.revision});
  if(!res||!res.ok){
    if(res&&res.code==='revision_conflict'){setEditorState('conflict',{error:res});return;}
    setEditorState('failed',{error:{message:(res&&res.message)||'Publishing didn’t go through.'}});return;
  }
  websiteEditor.published={revision:res.revision,publishedAt:res.publishedAt};
  await loadCanonicalWebsite(true);
  setEditorState('live');
}
async function refreshAfterConflict(){
  await loadCanonicalWebsite(true);
  setEditorState(qs('#siteEditorInput').value.trim()?'typing':'idle',{error:null,edit:null});
}
async function sendWebsiteEditToTeam(){
  const input=qs('#siteEditorInput'),text=input.value.trim();if(!text||websiteEditor.sending)return;
  websiteEditor.sending=true;renderWebsiteEditor();
  try{
    const d=await api('/api/app/website-updates',{method:'POST',body:JSON.stringify({page:'Other',priority:'Normal',request:text,notes:websiteEditService.available()?'Sent from the Website view ("Update My Website") after the automatic update couldn’t make this change — nothing was changed automatically.':'Sent from the Website view ("Update My Website"). Builder editing is not connected, so this was routed to the SiteRemade team as a manual request — nothing was changed automatically.'})});
    if(d.websiteUpdate)state.websiteUpdates=[d.websiteUpdate,...(state.websiteUpdates||[])];
    input.value='';websiteEditor.sending=false;setEditorState('idle',{sentToTeam:d.websiteUpdate||true,error:null});renderWebsiteRequests();
  }catch(e){websiteEditor.sending=false;setEditorState('failed',{error:{message:e.message}});}
}
if(qs('#siteEditorForm')){
  qs('#siteEditorForm').onsubmit=e=>{e.preventDefault();submitWebsiteEdit();};
  qs('#siteEditorInput').addEventListener('input',()=>{websiteEditor.sentToTeam=null;if(['failed','preview_ready','live'].includes(websiteEditor.state))websiteEditor.state='idle';renderWebsiteEditor();});
  qs('#siteEditorInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();submitWebsiteEdit();}});
  qs('#siteEditorHandoff').onclick=()=>sendWebsiteEditToTeam();
  qsa('[data-edit-example]').forEach(b=>b.onclick=()=>{const input=qs('#siteEditorInput');if(input.readOnly)return;const add=b.dataset.editExample;input.value=input.value.trim()?`${input.value.trim()}\n${add}`:add;input.focus();input.setSelectionRange(input.value.length,input.value.length);input.dispatchEvent(new Event('input'));});
  const pubInline=qs('#siteEditorPublish');if(pubInline)pubInline.onclick=()=>publishWebsite();
  const refresh=qs('#siteEditorRefresh');if(refresh)refresh.onclick=()=>refreshAfterConflict();
  const done=qs('#siteEditorDone');if(done)done.onclick=()=>{setEditorState('idle',{edit:null,published:null,error:null});qs('#siteEditorInput').focus();};
}
if(qs('#websitePublishButton'))qs('#websitePublishButton').onclick=()=>publishWebsite();

// ===========================================================================
// Contact — Phase 3F
// ===========================================================================
// Who contacted this business through its website. Rows are the real
// leads (see contactSubmissions() near renderBadges for what's included),
// shown as submissions: name, how to reach them, what they said, where it
// came from, when. Opening one marks it read through the existing
// PATCH /api/app/conversations/:id {read:true}. Nothing here edits a lead.
const contactState={filter:'all',open:new Set()};
const CONTACT_SOURCE_LABELS={'website':'Website form','ai chat':'Website chat','twilio sms':'Text message','business sms':'Text message'};
// Phase 8: everything after the first message of a contact (a second text,
// the chat's back-and-forth, email replies pulled in by Gmail sync) only
// ever lived in the conversation -- it raised the unread count, but nothing
// in the customer UI showed it. The detail panel now lists the thread
// (read-only; same rows GET /api/app/bootstrap already returns).
const CONTACT_SENDER_LABELS={customer:'Them',ai:'Chat assistant',business:'You',human:'You'};
function contactThread(l){return ((contactConversation(l)?.messages)||[]).filter(m=>String(m.text||'').trim());}
function contactThreadHtml(l,msg){const t=contactThread(l);if(!t.length||(t.length===1&&t[0].from==='customer'&&String(t[0].text).trim()===String(msg||'').trim()))return '';return `<section class="ct-thread" aria-label="Conversation"><h3>Conversation</h3><ol>${t.map(m=>`<li class="ct-thread-${m.from==='customer'?'them':'us'}"><span class="ct-thread-who">${esc(CONTACT_SENDER_LABELS[m.from]||'You')}<time datetime="${esc(m.createdAt)}" title="${esc(dateTimeLabel(m.createdAt))}">${esc(contactWhen(m.createdAt))}</time></span><p>${esc(m.text)}</p></li>`).join('')}</ol></section>`;}
function contactSourceLabel(l){const k=String(l.source||'').trim().toLowerCase();return CONTACT_SOURCE_LABELS[k]||l.source||'Website';}
function contactMessage(l){if(String(l.message||'').trim())return l.message;const c=contactConversation(l);const m=(c?.messages||[]).find(x=>x.from==='customer'&&String(x.text||'').trim());return m?m.text:'';}
function contactWhen(iso){const t=new Date(iso).getTime();if(!Number.isFinite(t))return '';const m=Math.max(0,Math.round((Date.now()-t)/60000));if(m<1)return 'Just now';if(m<60)return `${m} min ago`;if(m<1440){const h=Math.round(m/60);return `${h} hour${h===1?'':'s'} ago`;}if(m<2880)return 'Yesterday';return dateLabel(iso);}
function renderContact(){
  const host=qs('#contactList');if(!host)return;
  const all=contactSubmissions(),unread=all.filter(isContactUnread),rows=contactState.filter==='unread'?unread:all;
  const uc=qs('#contactUnreadCount');if(uc)uc.textContent=unread.length?` · ${unread.length}`:'';
  qsa('[data-ct-filter]').forEach(b=>{const on=b.dataset.ctFilter===contactState.filter;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));});
  const excluded=(state.leads||[]).length-all.length,foot=qs('#contactFootnote');if(foot)foot.hidden=excluded<=0;
  const sig=JSON.stringify([contactState.filter,[...contactState.open],rows.map(l=>{const cv=contactConversation(l);return [l.id,l.updatedAt,isContactUnread(l),contactMessage(l).length,cv?.unread||0,cv?.messages?.length||0];})]);
  if(host.dataset.sig===sig)return;host.dataset.sig=sig;
  if(!rows.length){host.innerHTML=all.length?'<div class="ct-empty"><strong>You’re all caught up.</strong><span>Nothing unread right now.</span></div>':'<div class="ct-empty"><strong>Contact form submissions will appear here.</strong><span>When someone fills in the form or chats on your website, you’ll see who they are, how to reach them and what they asked — right here.</span></div>';return;}
  host.innerHTML=rows.map(l=>{
    const open=contactState.open.has(l.id),un=isContactUnread(l),msg=contactMessage(l);
    const reach=[l.email,l.phone].filter(Boolean).join(' · ')||'No contact details left';
    const asked=l.service&&!/^general inquiry$/i.test(l.service)?l.service:'';
    return `<article class="ct-item${un?' is-unread':''}${open?' is-open':''}" data-contact="${esc(l.id)}">
      <button type="button" class="ct-row" aria-expanded="${open}" aria-controls="ct-d-${esc(l.id)}">
        <span class="ct-dot" aria-hidden="true"></span>
        <span class="ct-who"><strong>${esc(l.name||'Someone')}</strong><span>${esc(reach)}</span></span>
        <span class="ct-msg">${msg?esc(msg):'<em>No message — they left their details.</em>'}</span>
        <span class="ct-meta"><span class="ct-source">${esc(contactSourceLabel(l))}</span><time datetime="${esc(l.createdAt)}" title="${esc(dateTimeLabel(l.createdAt))}">${esc(contactWhen(l.createdAt))}</time>${un?'<span class="sr-only">Unread</span>':''}</span>
      </button>
      <div class="ct-detail" id="ct-d-${esc(l.id)}" ${open?'':'hidden'}>
        ${msg?`<p class="ct-full">${esc(msg)}</p>`:''}
        ${contactThreadHtml(l,msg)}
        <dl class="ct-facts">
          ${l.email?`<div><dt>Email</dt><dd><a href="mailto:${esc(l.email)}">${esc(l.email)}</a></dd></div>`:''}
          ${l.phone?`<div><dt>Phone</dt><dd><a href="tel:${esc(l.phone)}">${esc(l.phone)}</a></dd></div>`:''}
          ${asked?`<div><dt>Asked about</dt><dd>${esc(asked)}</dd></div>`:''}
          <div><dt>Came from</dt><dd>${esc(contactSourceLabel(l))}</dd></div>
          <div><dt>Received</dt><dd>${esc(dateTimeLabel(l.createdAt))}</dd></div>
        </dl>
        <div class="ct-actions">
          ${l.email?`<a class="primary-action" href="mailto:${esc(l.email)}?subject=${encodeURIComponent('Re: your message to '+(state.workspace.businessName||'us'))}">Reply by email</a>`:''}
          ${l.phone?`<a class="secondary-button" href="tel:${esc(l.phone)}">Call</a><a class="secondary-button" href="sms:${esc(l.phone)}">Text</a>`:''}
        </div>
      </div>
    </article>`;}).join('');
  qsa('#contactList .ct-row').forEach(b=>b.onclick=()=>toggleContact(b.closest('[data-contact]').dataset.contact));
}
async function toggleContact(id){
  const l=(state.leads||[]).find(x=>x.id===id);if(!l)return;
  if(contactState.open.has(id))contactState.open.delete(id);else contactState.open.add(id);
  renderContact();
  const c=contactConversation(l);
  if(contactState.open.has(id)&&c&&Number(c.unread)>0){
    try{const d=await api(`/api/app/conversations/${c.id}`,{method:'PATCH',body:JSON.stringify({read:true})});c.unread=0;if(d.conversation)Object.assign(c,d.conversation);}catch(e){console.warn('Could not mark as read:',e.message);}
    renderContact();renderBadges();
  }
}
qsa('[data-ct-filter]').forEach(b=>b.onclick=()=>{contactState.filter=b.dataset.ctFilter==='unread'?'unread':'all';renderContact();});

// ===========================================================================
// Ads — Phase 3G
// ===========================================================================
// Read-only. Everyone: Google Ads connection status (GET
// /api/app/google-ads/status) and the spend SiteRemade has reported
// (state.adSpend, from the ad_spend table in bootstrap). SiteRemade staff
// additionally get live campaign numbers (GET /api/app/google-ads/campaigns)
// and the persisted recommendations (GET /api/app/ad-recommendations) —
// both routes are owner-only on the server and stay that way. There is no
// approve/apply/execute control anywhere in this view.
const adsState={status:null,campaigns:null,recs:null,loading:false,error:null,at:0};
async function loadAds(force){
  if(!force&&adsState.at&&Date.now()-adsState.at<60000){renderAds();return;}
  adsState.loading=true;adsState.error=null;renderAds();
  try{
    adsState.status=await api('/api/app/google-ads/status');
    const owner=state.user?.role==='owner',st=adsState.status;
    adsState.campaigns=null;adsState.recs=null;
    if(owner&&st.connected&&st.scopeReady&&st.selectedCustomerId){
      const [c,r]=await Promise.allSettled([api('/api/app/google-ads/campaigns?customerId='+encodeURIComponent(st.selectedCustomerId)),api('/api/app/ad-recommendations?customerId='+encodeURIComponent(st.selectedCustomerId))]);
      if(c.status==='fulfilled')adsState.campaigns=c.value;else adsState.error=c.reason?.message||'Could not load campaigns.';
      if(r.status==='fulfilled')adsState.recs=r.value.recommendations||[];
    }
  }catch(e){adsState.error=e.message;}
  finally{adsState.loading=false;adsState.at=Date.now();renderAds();}
}
function adsObservations(rows){
  // Plain, factual observations from reported spend — arithmetic on real
  // rows, not predictions and not instructions.
  const by={};rows.forEach(r=>{const k=`${r.platform} · ${r.campaign||'Campaign'}`;by[k]=by[k]||{name:k,spend:0,leads:0};by[k].spend+=Number(r.spend)||0;by[k].leads+=Number(r.leads)||0;});
  const list=Object.values(by),out=[],spend=list.reduce((n,c)=>n+c.spend,0),leads=list.reduce((n,c)=>n+c.leads,0);
  if(spend>0&&leads>0)out.push(`Across reported campaigns you've paid about ${money(spend/leads)} per lead.`);
  const withLeads=list.filter(c=>c.leads>0&&c.spend>0).sort((a,b)=>a.spend/a.leads-b.spend/b.leads);
  if(withLeads.length>=2){const a=withLeads[0],b=withLeads[withLeads.length-1];if(b.spend/b.leads>a.spend/a.leads*1.2)out.push(`${a.name} brings in leads for less (${money(a.spend/a.leads)} each) than ${b.name} (${money(b.spend/b.leads)} each).`);}
  list.filter(c=>c.spend>0&&!c.leads).forEach(c=>out.push(`${c.name} has spent ${money(c.spend)} without a reported lead yet.`));
  return out.slice(0,4);
}
function renderAds(){
  const host=qs('#adsBody');if(!host)return;
  const owner=state.user?.role==='owner',st=adsState.status,rows=state.adSpend||[];
  const sig=JSON.stringify([adsState.at,adsState.loading,adsState.error,owner,rows.map(r=>[r.id,r.spend,r.leads])]);
  if(host.dataset.sig===sig)return;host.dataset.sig=sig;
  if(!st&&adsState.loading){host.innerHTML='<div class="an-skeleton"><div class="skeleton"></div><div class="skeleton an-skeleton-chart"></div></div>';return;}
  const fmtId=id=>String(id||'').replace(/\D/g,'').replace(/(\d{3})(\d{3})(\d{4})/,'$1-$2-$3');
  // Connected account
  let acct,acctTone='neutral',acctLabel='Not connected',acctAction='';
  if(!st){acct='Couldn’t check the Google Ads connection right now.';}
  else if(!st.connected){acct=owner?(st.configured?'Google Ads isn’t connected for this workspace yet.':'Google Ads credentials aren’t set up on the server yet.'):'No ad account is connected yet. SiteRemade connects it for you when your ads start.';if(owner&&st.configured)acctAction='<a class="secondary-button" href="/api/app/google-ads/start">Connect Google Ads</a>';}
  else if(!st.scopeReady){acctTone='warning';acctLabel='Needs permission';acct='Google is connected, but Ads access wasn’t granted yet.';if(owner)acctAction='<a class="secondary-button" href="/api/app/google-ads/start">Grant Ads access</a>';}
  else{acctTone='success';acctLabel='Connected';acct=st.selectedCustomerId?`Google Ads account ${esc(fmtId(st.selectedCustomerId))}`:'Connected — no ad account chosen yet.';if(owner)acctAction=`<button type="button" class="secondary-button" data-ads-admin data-view="admin">${st.selectedCustomerId?'Manage in Admin':'Choose account in Admin'}</button>`;}
  const account=`<section class="ads-block ads-account"><div><p class="eyebrow">CONNECTED ACCOUNT</p><h2>Google Ads <span class="chip chip-${acctTone}">${acctLabel}</span></h2><p>${acct}</p></div>${acctAction?`<div class="ads-account-actions">${acctAction}</div>`:''}</section>`;
  // Performance
  let perf='';
  const stat=(l,v,n)=>`<div class="an-stat"><dt>${l}</dt><dd>${v}</dd><p>${n}</p></div>`;
  const camp=adsState.campaigns;
  if(camp&&owner){
    const s=camp.summary||{},list=camp.campaigns||[],cpa=s.conversions?s.spend/s.conversions:0;
    perf=`<section class="ads-block"><p class="eyebrow">CAMPAIGN PERFORMANCE · LAST 30 DAYS</p><p class="ads-source">Live from Google Ads (visible to SiteRemade staff).</p>
      <dl class="an-stats ads-stats">${stat('Spend',money(s.spend),'Total ad spend')}${stat('Clicks',anFmt(s.clicks),s.impressions?`${(s.clicks/s.impressions*100).toFixed(1)}% of ${anFmt(s.impressions)} views`:'People who clicked an ad')}${stat('Conversions',anFmt(Math.round((s.conversions||0)*10)/10),'Calls, forms and bookings Google counted')}${stat('Cost per conversion',cpa?money(cpa):'—',cpa?'Spend ÷ conversions':'No conversions yet')}</dl>
      ${list.length?`<ul class="ads-campaigns">${list.slice(0,12).map(c=>`<li><div><strong>${esc(c.name)}</strong><span>${esc(String(c.status||'').toLowerCase())}${c.channel?` · ${esc(String(c.channel).toLowerCase().replace(/_/g,' '))}`:''}</span></div><span>${anFmt(c.clicks)} clicks</span><span>${anFmt(Math.round((c.conversions||0)*10)/10)} conv.</span><b>${money(c.spend)}</b></li>`).join('')}</ul>`:'<p class="ads-muted">No campaign activity in the last 30 days.</p>'}</section>`;
  }
  const spend=rows.reduce((n,r)=>n+(Number(r.spend)||0),0),leads=rows.reduce((n,r)=>n+(Number(r.leads)||0),0);
  if(rows.length){
    perf+=`<section class="ads-block"><p class="eyebrow">REPORTED BY SITEREMADE</p><p class="ads-source">Spend and results SiteRemade has recorded for your campaigns.</p>
      <dl class="an-stats ads-stats ads-stats-3">${stat('Spend',money(spend),`${rows.length} report${rows.length===1?'':'s'}`)}${stat('Leads',anFmt(leads),'Enquiries from ads')}${stat('Cost per lead',leads?money(spend/leads):'—',leads?'Spend ÷ leads':'No leads reported yet')}</dl>
      <ul class="ads-campaigns">${rows.slice(0,12).map(r=>`<li><div><strong>${esc(r.platform)} · ${esc(r.campaign||'Campaign')}</strong><span>${esc(dateLabel(r.createdAt))}</span></div><span></span><span>${anFmt(r.leads)} leads</span><b>${money(r.spend)}</b></li>`).join('')}</ul></section>`;
  }
  if(!perf)perf=`<div class="an-empty ads-empty"><strong>No ads running yet.</strong><span>When SiteRemade runs ads for you, what you spent, how many people clicked and how many got in touch will show up here.</span></div>`;
  // Recommendations (advisory)
  const obs=adsObservations(rows),recs=(adsState.recs||[]).filter(r=>r.status!=='dismissed').slice(0,6);
  let rec='';
  if(recs.length||obs.length){
    rec=`<section class="ads-block"><p class="eyebrow">RECOMMENDATIONS</p><h2>Things worth a look</h2><p class="ads-source">Suggestions only — a person at SiteRemade decides and makes any change.</p><ul class="ads-recs">`+
      recs.map(r=>`<li><strong>${esc(r.title)}</strong><span>${esc(r.reason||'')}</span>${r.proposed_action?`<em>${esc(r.proposed_action)}</em>`:''}${r.status==='approved'?'<span class="chip chip-success">Approved for later · not applied</span>':''}</li>`).join('')+
      obs.map(o=>`<li><span>${esc(o)}</span></li>`).join('')+`</ul>${owner&&recs.length?'<button type="button" class="text-link" data-ads-admin data-view="admin">Review in Admin</button>':''}</section>`;
  }
  const err=adsState.error?`<p class="ads-muted">${esc(adsState.error)}</p>`:'';
  host.innerHTML=account+err+perf+rec;
  qsa('#adsBody [data-ads-admin]').forEach(b=>b.onclick=()=>switchView('admin'));
}

function renderAutomations(){qs('#automationList').innerHTML=state.automations.map(a=>`<button class="automation-card automation-toggle" data-auto="${a.id}"><span class="automation-icon">${a.id==='lead-confirmation'?'✦':a.id==='lead-alert'?'↗':'□'}</span><div><strong>${esc(a.name)}</strong><p>${esc(a.description)}</p></div><span class="toggle ${a.enabled?'on':''}"></span></button>`).join('');qsa('[data-auto]').forEach(b=>b.onclick=()=>toggleAutomation(b.dataset.auto));}
// ===========================================================================
// Settings — Phase 3H
// ===========================================================================
// Six groups: Account, Website, Domain & hosting, Billing, Connections,
// Advanced. The old renderSettings() (business form + a "modules" list that
// said Website/Lead System were LIVE regardless + an env-var integrations
// list) was replaced. Form/field ids are unchanged so the existing
// #settingsForm submit handler keeps working as-is.
function renderSettings(){
  const w=state.workspace||{},set=(id,v)=>{const el=qs('#'+id);if(el&&document.activeElement!==el)el.value=v||'';};
  set('settingsBusiness',w.businessName);set('settingsEmail',w.email);set('settingsPhone',w.phone);set('settingsTimezone',w.timezone);
  set('aiServices',w.ai?.services);set('aiServiceArea',w.ai?.serviceArea);set('aiTone',w.ai?.tone);
  set('settingsDomain',state.websiteAnalytics?.domain);
  const signed=qs('#settingsSignedIn');if(signed&&state.user)signed.textContent=`${state.user.name||''}${state.user.email&&state.user.email!==state.user.name?` · ${state.user.email}`:''}`;
  // Phase 8: the website chat's AI replies come ONLY from OpenAI
  // (server.js externalAI(); /api/public/chat never calls Anthropic, which
  // is used for website briefs), so an Anthropic-only server showed "On"
  // while visitors got the built-in scripted replies. Three honest states.
  const ai=qs('#aiReceptionistBadge');if(ai){const enabled=w.ai?.enabled!==false,live=enabled&&!!state.integrations.openai;setChip(ai,live?'AI replies on':enabled?'Basic replies':'Off',live?'success':'neutral');ai.title=live?'Replies are written by AI using the details below.':enabled?'AI replies aren’t turned on for SiteRemade yet. The chat asks a few standard questions and passes the conversation to you.':'The chat only confirms that a message was received.';}
  const code=qs('#settingsEmbedCode');if(code)code.textContent=`<script src="${location.origin}/widget.js" data-workspace="${w.id||''}" data-public-key="${w.publicKey||''}"></script>`;
  // Domain & hosting — read-only, and honest about what isn't reported yet.
  const snap=websiteSnapshot(),dr=qs('#settingsDomainRows');
  if(dr)dr.innerHTML=`
    <div class="st-row"><div><strong>Live address</strong><span>${snap.live?`<a href="${esc(snap.live)}" target="_blank" rel="noopener noreferrer">${esc(snap.live.replace(/^https?:\/\//,'').replace(/\/$/,''))}</a>`:'Not live yet'}</span></div></div>
    <div class="st-row"><div><strong>Preview address</strong><span>${snap.preview?`<a href="${esc(snap.preview)}" target="_blank" rel="noopener noreferrer">${esc(snap.preview.replace(/^https?:\/\//,'').replace(/\/$/,''))}</a>`:'None'}</span></div></div>
    ${snap.canonical?`<div class="st-row"><div><strong>Domain status</strong><span>${snap.canonical.domains&&snap.canonical.domains.length?snap.canonical.domains.map(d=>`${esc(d.domain)} — ${esc(DOMAIN_STATE_COPY[d.state]||d.state)}`).join('<br>'):'No domain connected in the builder yet.'}</span></div><span class="chip chip-neutral">Builder</span></div>
    <div class="st-row"><div><strong>Hosting</strong><span>${esc((DEPLOYMENT_COPY[snap.canonical.deploymentStatus]||DEPLOYMENT_COPY.not_deployed)[0])} — SiteRemade doesn’t push your site to your web address automatically yet.</span></div></div>
    <p class="st-note">Live and preview addresses come from your SiteRemade delivery record. Domain and hosting status come from your SiteRemade builder project. A domain marked “reachable” only means it answered a web request — it isn’t proof of ownership.</p>`
    :`<div class="st-row"><div><strong>Domain status &amp; SSL</strong><span>Not reported yet — SiteRemade manages this for you. Ask your SiteRemade contact about domain changes.</span></div><span class="chip chip-neutral">Managed</span></div>
    <p class="st-note">Addresses come from your SiteRemade delivery record. Live DNS, SSL and deployment status will appear here once the SiteRemade builder is connected to this app.</p>`}`;
  // Billing
  const b=state.billing||{},status=String(b.status||w.siteRemadeSubscriptionStatus||'inactive'),active=['active','trialing'].includes(status);
  const pl=qs('#settingsPlanLine');if(pl)pl.textContent=`${money((Number(b.monthlyCents)||0)/100)} per month`;
  setChip(qs('#settingsPlanStatus'),status.replace('_',' ').replace(/^./,c=>c.toUpperCase()),active?'success':status==='past_due'?'warning':'neutral');
  const sp=qs('#settingsStartPlan');if(sp)sp.hidden=active;
  // Advanced — notification automations (real automations rows)
  const AUTO_COPY={'lead-alert':['Tell me when someone gets in touch','Email and text you as soon as a new contact form or chat comes in.'],'lead-confirmation':['Send an automatic “we got your message” reply','Confirms to the person that their message arrived.'],'appointment-reminder':['Appointment reminders','Reminds customers before a booked appointment.']};
  const au=qs('#settingsAutomations');
  if(au)au.innerHTML=(state.automations||[]).length?state.automations.map(a=>{const [t,d]=AUTO_COPY[a.id]||[a.name,a.description];return `<div class="st-row"><div><strong>${esc(t)}</strong><span>${esc(d||'')}</span></div><button type="button" class="st-toggle${a.enabled?' on':''}" role="switch" aria-checked="${a.enabled}" aria-label="${esc(t)}" data-st-auto="${esc(a.id)}"><i></i></button></div>`;}).join(''):'<p class="st-note">No notifications are set up for this workspace.</p>';
  qsa('[data-st-auto]').forEach(t=>t.onclick=async()=>{t.disabled=true;await toggleAutomation(t.dataset.stAuto);t.disabled=false;});
  const wd=qs('#settingsWorkspaceDetails');if(wd)wd.innerHTML=`<div class="st-row"><div><strong>Workspace ID</strong><span class="st-mono">${esc(w.id||'—')}</span></div></div><div class="st-row"><div><strong>Public key</strong><span class="st-mono">${esc(w.publicKey||'—')}</span><span>Safe to share — it's what your website uses to send enquiries here.</span></div></div>`;
  renderConnections();
}
// Connections: real providers only, each backed by an existing route.
const connState={gmail:null,calendar:null,twilio:null,stripe:null,ads:null,at:0,loading:false};
async function loadConnections(force){
  if(!force&&connState.at&&Date.now()-connState.at<30000){renderConnections();return;}
  connState.loading=true;renderConnections();
  const get=u=>api(u).catch(e=>({ok:false,error:e.message}));
  const [gmail,calendar,twilio,stripe,ads]=await Promise.all([get('/api/app/mailbox/status'),get('/api/app/integrations/google-calendar/status'),(window.getSharedTwilioStatus?window.getSharedTwilioStatus(force).catch(e=>({ok:false,error:e.message})):get('/api/app/integrations/twilio/status')),get('/api/app/integrations/stripe/status'),get('/api/app/google-ads/status')]);
  Object.assign(connState,{gmail,calendar,twilio,stripe,ads,at:Date.now(),loading:false});
  renderConnections();
}
function renderConnections(){
  const host=qs('#settingsConnections');if(!host)return;
  if(!connState.at){host.innerHTML='<div class="an-skeleton"><div class="skeleton"></div><div class="skeleton"></div></div>';return;}
  const owner=state.user?.role==='owner',{gmail,calendar,twilio,stripe,ads}=connState;
  const unavailable='<span class="chip chip-neutral">Not available yet</span>';
  const row=(key,name,what,chip,actions)=>`<div class="st-row st-conn" data-conn="${key}"><div><strong>${name}</strong><span>${what}</span></div><div class="st-conn-side">${chip}${actions}</div></div>`;
  const on=(t)=>`<span class="chip chip-success">${esc(t||'Connected')}</span>`,off='<span class="chip chip-neutral">Not connected</span>';
  const btn=(act,label,kind='secondary-button')=>`<button type="button" class="${kind}" data-conn-act="${act}">${label}</button>`;
  const rows=[];
  // Gmail (mailbox_connections; Google Calendar reuses the same Google connection)
  if(gmail?.ok===false)rows.push(row('gmail','Gmail','Reply to website enquiries from your own inbox.',`<span class="chip chip-warning">Couldn't check</span>`,''));
  else if(gmail?.connected)rows.push(row('gmail','Gmail',`${esc(gmail.email||'Connected')}${gmail.lastSync?` · synced ${esc(contactWhen(gmail.lastSync).toLowerCase())}`:''}`,on(),btn('gmail-sync','Sync now')+btn('gmail-disconnect','Disconnect','text-link')));
  else rows.push(row('gmail','Gmail','Reply to website enquiries from your own inbox.',gmail?.available?.gmail===false?unavailable:off,gmail?.available?.gmail===false?'':btn('gmail-connect','Connect')));
  // Google Calendar
  if(calendar?.connected)rows.push(row('calendar','Google Calendar',`${esc(calendar.email||'Connected')} · bookings stay in sync`,on(),btn('calendar-sync','Sync now')));
  else rows.push(row('calendar','Google Calendar','Keep appointments in sync with your calendar.',calendar?.configured===false?unavailable:off,calendar?.configured===false?'':btn('calendar-connect','Connect')));
  // Business texting (Twilio)
  if(twilio?.connected)rows.push(row('twilio','Business texting',`${esc(twilio.phoneNumber||'Your business number')} · texts to this number show up in Contact`,on(),btn('twilio-disconnect','Disconnect','text-link')));
  else rows.push(row('twilio','Business texting','Get text messages from customers on the number you already use.',twilio?.configured===false?unavailable:off,twilio?.configured===false?'':btn('twilio-connect','Connect number')));
  // Stripe (customer payments)
  if(stripe?.connected)rows.push(row('stripe','Stripe payments',`${esc(stripe.label||'Connected')} · card payments from your customers`,on(),''));
  else rows.push(row('stripe','Stripe payments',stripe?.accountId?'Stripe setup was started but isn’t finished yet.':'Take card payments from your customers.',stripe?.configured===false?unavailable:(stripe?.accountId?'<span class="chip chip-warning">Setup incomplete</span>':off),stripe?.configured===false?'':btn('stripe-connect',stripe?.accountId?'Finish setup':'Connect')));
  // Google Ads (connection is staff-managed: /start is owner-only)
  if(ads?.connected&&ads?.scopeReady)rows.push(row('ads','Google Ads',ads.selectedCustomerId?`Account ${esc(String(ads.selectedCustomerId).replace(/(\d{3})(\d{3})(\d{4})/,'$1-$2-$3'))} · reporting only`:'Connected · no ad account chosen yet',on(),owner?btn('ads-admin','Manage in Admin'):''));
  else rows.push(row('ads','Google Ads',owner?'Read campaign results into the Ads page. Changes are never made automatically.':'SiteRemade connects this for you when your ads start.',ads?.connected?'<span class="chip chip-warning">Needs permission</span>':off,owner&&ads?.configured?btn('ads-connect',ads?.connected?'Grant access':'Connect'):''));
  host.innerHTML=rows.join('')+'<p class="st-note" id="settingsConnStatus" role="status"></p>';
  qsa('[data-conn-act]').forEach(b=>b.onclick=()=>connectionAction(b.dataset.connAct,b));
}
async function connectionAction(act,b){
  const out=qs('#settingsConnStatus'),say=t=>{if(out)out.textContent=t;};
  const busy=async(label,fn)=>{const old=b.textContent;b.disabled=true;b.textContent=label;try{await fn();}catch(e){say(e.message);}finally{b.disabled=false;b.textContent=old;}};
  if(act==='gmail-connect')return location.assign('/api/app/gmail/start');
  if(act==='calendar-connect')return location.assign('/api/app/integrations/google-calendar/start');
  if(act==='ads-connect')return location.assign('/api/app/google-ads/start');
  if(act==='ads-admin')return switchView('admin');
  if(act==='gmail-sync')return busy('Syncing…',async()=>{const d=await api('/api/app/mailbox/sync',{method:'POST'});say(`Inbox synced${d.added?` — ${d.added} new message${d.added===1?'':'s'}`:''}.`);await loadConnections(true);});
  if(act==='calendar-sync')return busy('Syncing…',async()=>{const d=await api('/api/app/integrations/google-calendar/sync',{method:'POST'});say(`Calendar synced — ${d.created||0} added, ${d.updated||0} updated.`);});
  if(act==='gmail-disconnect'){if(!confirm('Disconnect Gmail from this workspace? Google Calendar sync uses the same Google connection and will stop too.'))return;return busy('Disconnecting…',async()=>{await api('/api/app/mailbox',{method:'DELETE'});say('Gmail disconnected.');await loadConnections(true);});}
  if(act==='twilio-connect'){if(typeof window.srOpenBusinessNumberSetup==='function')return window.srOpenBusinessNumberSetup();say('The number setup is still loading — try again in a moment.');return;}
  if(act==='twilio-disconnect'){if(!confirm('Disconnect your business number? Texts to it will stop showing up here.'))return;return busy('Disconnecting…',async()=>{await api('/api/app/integrations/twilio',{method:'DELETE'});say('Business number disconnected.');await loadConnections(true);});}
  if(act==='stripe-connect')return busy('Opening Stripe…',async()=>{const d=await api('/api/app/integrations/stripe/connect',{method:'POST',body:'{}'});if(!d.url)throw new Error('Stripe didn’t return a setup link.');location.assign(d.url);});
}
qsa('[data-st-jump]').forEach(a=>a.onclick=e=>{e.preventDefault();qs('#'+a.dataset.stJump)?.scrollIntoView({behavior:'smooth',block:'start'});});
if(qs('#settingsSignOut'))qs('#settingsSignOut').onclick=async()=>{try{await api('/api/auth/logout',{method:'POST'});}catch{}location.reload();};
if(qs('#settingsCopyEmbed'))qs('#settingsCopyEmbed').onclick=async()=>{const t=qs('#settingsEmbedCode').textContent,b=qs('#settingsCopyEmbed');try{await navigator.clipboard.writeText(t);b.textContent='Copied';}catch{b.textContent='Select and copy';}setTimeout(()=>b.textContent='Copy',1600);};
if(qs('#settingsDomainForm'))qs('#settingsDomainForm').onsubmit=async e=>{e.preventDefault();const out=qs('#settingsDomainStatus');out.textContent='Saving…';try{const d=await api('/api/app/analytics/website',{method:'POST',body:JSON.stringify({domain:qs('#settingsDomain').value,businessName:state.workspace.businessName})});state.websiteAnalytics={...(state.websiteAnalytics||{}),...(d.websiteAnalytics||{}),domain:d.domain||d.websiteAnalytics?.domain};analyticsState.cache={};out.textContent='Saved. Visits will show in Analytics once your site sends them.';renderWebsite();}catch(err){out.textContent=err.message;}};
const planStart=async(btn,out)=>{out.textContent='Opening secure billing…';try{const d=await api('/api/app/billing/subscription/start',{method:'POST'});if(d.url)location.href=d.url;}catch(e){out.textContent=e.message;}};
if(qs('#settingsStartPlan'))qs('#settingsStartPlan').onclick=()=>planStart(qs('#settingsStartPlan'),qs('#settingsBillingStatus'));
if(qs('#settingsManageBilling'))qs('#settingsManageBilling').onclick=async()=>{const out=qs('#settingsBillingStatus');out.textContent='Opening billing portal…';try{const d=await api('/api/app/billing/portal',{method:'POST'});if(d.url)location.href=d.url;}catch(e){out.textContent=e.message;}};
// Returning from Gmail / Stripe OAuth lands on /?mailbox=… or /?stripe=… —
// open Settings → Connections and say what happened. (Google Ads returns
// are still handled by v44, which opens Admin.)
function handleConnectionReturn(){
  const q=new URLSearchParams(location.search),mb=q.get('mailbox'),sp=q.get('stripe');if(!mb&&!sp)return;
  switchView('settings');setTimeout(()=>qs('#st-connections')?.scrollIntoView({block:'start'}),80);
  if(mb==='connected')showToast('Gmail connected','Enquiry replies can now come from your inbox.');
  else if(mb==='error')showToast('Gmail wasn’t connected',q.get('reason')||'Please try again.');
  if(sp==='connected')showToast('Stripe','Returned from Stripe setup.');
  ['mailbox','reason','stripe'].forEach(k=>q.delete(k));const rest=q.toString();history.replaceState({},'',location.pathname+(rest?'?'+rest:''));
  loadConnections(true);
}
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
// Website-first shell: views that load their own data (Analytics, Ads,
// Settings → Connections) do it when they are opened, not on every 5-second
// live-refresh tick. Each hook is looked up lazily so it can be defined
// anywhere in this file.
const VIEW_SHOWN_HOOKS={website:()=>loadCanonicalWebsite(),analytics:()=>loadWebsiteAnalytics(),ads:()=>loadAds(),settings:()=>loadConnections()};
function switchView(v){if(!qs(`#view-${v}`))v='website';qsa('.view').forEach(x=>x.classList.toggle('active',x.id===`view-${v}`));qsa('[data-view]').forEach(x=>x.classList.toggle('active',x.dataset.view===v));const sheet=qs('#mobileMoreSheet'),more=qs('#mobileMoreButton');if(sheet)sheet.hidden=true;if(more)more.setAttribute('aria-expanded','false');window.scrollTo({top:0,behavior:'smooth'});const hook=VIEW_SHOWN_HOOKS[v];if(hook){try{hook();}catch(err){console.error('View hook failed:',v,err);}}}
function showModal(id){qs('#'+id).hidden=false;}function hideModal(id){qs('#'+id).hidden=true;}

qsa('[data-view]').forEach(b=>b.onclick=()=>switchView(b.dataset.view));
const mobileMoreButton=qs('#mobileMoreButton'),mobileMoreSheet=qs('#mobileMoreSheet'),mobileMoreClose=qs('#mobileMoreClose');
if(mobileMoreButton)mobileMoreButton.onclick=()=>{const opening=!!mobileMoreSheet?.hidden;if(mobileMoreSheet)mobileMoreSheet.hidden=!opening;mobileMoreButton.setAttribute('aria-expanded',opening?'true':'false');};
if(mobileMoreClose)mobileMoreClose.onclick=()=>{if(mobileMoreSheet)mobileMoreSheet.hidden=true;if(mobileMoreButton)mobileMoreButton.setAttribute('aria-expanded','false');};
qsa('[data-jump]').forEach(b=>b.onclick=()=>switchView(b.dataset.jump));
qs('#leadFilters').onclick=e=>{const b=e.target.closest('button');if(!b)return;state.filter=b.dataset.status;qsa('#leadFilters button').forEach(x=>x.classList.toggle('active',x===b));renderLeads();};
qs('#leadSearch').oninput=e=>{state.search=e.target.value.trim().toLowerCase();renderLeads();};
// Website-first shell: the topbar's search / notification bell / "+ Add
// lead" buttons were removed from index.html (CRM actions, not website
// actions). Every binding below is null-guarded so a missing element can
// never throw here — this is top-level code, and one TypeError would stop
// the rest of app.js from wiring anything at all.
if(qs('#globalSearchButton'))qs('#globalSearchButton').onclick=()=>{switchView('leads');setTimeout(()=>qs('#leadSearch').focus(),100)};
if(qs('#notificationButton'))qs('#notificationButton').onclick=()=>{const p=qs('#notificationPopover');p.hidden=!p.hidden;};if(qs('#closeNotifications'))qs('#closeNotifications').onclick=()=>qs('#notificationPopover').hidden=true;
qs('#rangeControl').onclick=e=>{const b=e.target.closest('button');if(!b)return;state.rangeDays=Number(b.dataset.days)||30;qsa('#rangeControl button').forEach(x=>x.classList.toggle('active',x===b));renderDashboard();};

['#newLeadButton','#newLeadButton2'].forEach(s=>{const b=qs(s);if(b)b.onclick=()=>showModal('leadModal');});qs('#closeLeadModal').onclick=()=>hideModal('leadModal');qs('#cancelLeadModal').onclick=()=>hideModal('leadModal');
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
qs('#settingsForm').onsubmit=async e=>{e.preventDefault();const out=qs('#settingsStatus');out.textContent='Saving…';try{const d=await api('/api/app/settings',{method:'PATCH',body:JSON.stringify(Object.fromEntries(new FormData(e.currentTarget)))});state.workspace=d.workspace;state.workspaces=(state.workspaces||[]).map(x=>x.id===d.workspace.id?d.workspace:x);renderAll();out.textContent='Saved.';setTimeout(()=>out.textContent='',1500)}catch(err){out.textContent=err.message}};

qsa('[data-close]').forEach(b=>b.onclick=()=>hideModal(b.dataset.close));qsa('.modal-backdrop').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)m.hidden=true}));document.addEventListener('keydown',e=>{if(e.key==='Escape'){qsa('.modal-backdrop').forEach(m=>m.hidden=true);qs('#leadDrawer').hidden=true;qs('#notificationPopover').hidden=true;}});


function renderWorkspaceMenu(){const menu=qs('#workspaceMenu');if(!menu)return;menu.innerHTML=(state.workspaces||[]).map(w=>`<button data-workspace="${w.id}" class="workspace-option ${w.id===state.workspace.id?'active':''}"><span>${esc(w.businessName)}</span><small>${esc(w.plan||'Client')}</small></button>`).join('');qsa('[data-workspace]').forEach(b=>b.onclick=async()=>{await api('/api/app/workspaces/switch',{method:'POST',body:JSON.stringify({workspaceId:b.dataset.workspace})});menu.hidden=true;await refreshLight();});}
async function renderAdmin(){if(state.user?.role!=='owner')return;try{const d=await api('/api/app/admin');qs('#adminWorkspaceList').innerHTML=d.workspaces.map(w=>`<div class="admin-row growth-admin-row"><div><strong>${esc(w.businessName)}</strong><span>${esc(w.email||'No email')} · ${Number(w.leads||0)} leads · ${money(w.adFunded||0)} funded · ${money(w.adSpent||0)} spent</span></div><div class="admin-actions"><span class="status-pill ${['active','trialing'].includes(w.siteRemadeSubscriptionStatus)?'':'neutral'}">${esc((w.siteRemadeSubscriptionStatus||'inactive').toUpperCase())}</span><button class="secondary-button" data-open-workspace="${w.id}">Open workspace</button></div></div>`).join('');qs('#adminWorkspaceSelect').innerHTML=d.workspaces.map(w=>`<option value="${w.id}">${esc(w.businessName)}</option>`).join('');qsa('[data-open-workspace]').forEach(b=>b.onclick=async()=>{await api('/api/app/workspaces/switch',{method:'POST',body:JSON.stringify({workspaceId:b.dataset.openWorkspace})});await refreshLight();switchView('website');});renderAdminWebsite(d);}catch{}}
// Phase 5: staff-only "Website links" list — which builder project each
// workspace is linked to (by id, never domain), the last revision the app
// saw, whether its analytics site exists, and the server-wide contact
// intake protection. Read-only status, same quiet admin-row style.
// Phase 6: + whether the builder bridge is switched on at all, and a
// "Resolve" control for a link that needs review. Staff can only pick from
// the candidate projects the customer's own session captured (verified by
// the builder); choosing is a two-step confirm, nothing is pre-selected,
// and ids are shown truncated. State lives here so the 5s live refresh
// re-render can't drop a half-finished choice.
const adminRelink={open:null,choice:null,confirming:false,busy:false,status:''};
const BUILDER_BRIDGE_COPY={on:'Builder connection: on.',off:'Builder connection: off — the builder’s app bridge isn’t switched on (SITEREMADE_APP_BRIDGE_ENABLED), so customers see their delivery record only and no new links are made.',unreachable:'Builder connection: the builder couldn’t be reached from this app (check WEBSITE_BUILDER_URL). Links below are the last known state.'};
function renderAdminWebsite(d){const host=qs('#adminWebsiteList');if(!host)return;const short=id=>{const s=String(id||'');return s.length>14?`${s.slice(0,9)}…${s.slice(-4)}`:s;};
  const bridgeLine=d.builderBridge&&BUILDER_BRIDGE_COPY[d.builderBridge]?`<p class="helper-copy admin-bridge-state" id="adminBuilderBridge" data-state="${esc(d.builderBridge)}">${esc(BUILDER_BRIDGE_COPY[d.builderBridge])}</p>`:'';
  if(d.websiteLinksAvailable===false){host.innerHTML=bridgeLine+'<p class="helper-copy">Website links aren’t available yet — the V52 migration hasn’t been applied.</p>';}
  else host.innerHTML=bridgeLine+(d.websiteLinkCandidatesAvailable===false?'<p class="helper-copy">Reviewing a link needs the V53 migration, which hasn’t been applied yet.</p>':'')+d.workspaces.map(w=>{
    // Phase 9: a workspace can have several linked SiteRemade projects now
    // (websites, plural) — one admin-row per project, so staff can see and
    // manage each one, not just whichever happened to load first. A
    // workspace with none yet still gets exactly the one "not linked" row
    // it always did.
    const websites=Array.isArray(w.websites)&&w.websites.length?w.websites:[{linked:false}];
    return websites.map((x,i)=>{
    const detail=x.linked?`${esc(short(x.projectId))}${x.lastSeenRevision!==null?` · version ${esc(String(x.lastSeenRevision))}`:''}${x.linkedAt?` · linked ${esc(dateLabel(x.linkedAt))}`:''} · ${x.analyticsReady?'Analytics site ready':'Analytics site not set up yet'}${x.needsReview?` · builder now reports ${esc(short(x.reportedProjectId))} — link left unchanged`:''}`:'The customer connects this themselves from their Website page — Admin has no way to see or choose their purchases without their own sign-in (see routes/website-bridge.js workspaceGate).';
    const open=x.needsReview&&adminRelink.open===w.id;
    const resolveBtn=x.needsReview?`<button type="button" class="secondary-button" data-relink-open="${esc(w.id)}" aria-expanded="${open?'true':'false'}">${open?'Close':'Resolve'}</button>`:'';
    let panel='';
    if(open){
      const cands=Array.isArray(x.candidates)?x.candidates:null;
      if(!cands||!cands.length){panel=`<div class="admin-relink" data-relink-panel="${esc(w.id)}"><p class="helper-copy">No candidate data available — ask the customer to revisit their Website view to refresh this.</p></div>`;}
      else{
        const chosen=cands.find(k=>k.projectId===adminRelink.choice)||null;
        const opts=cands.map(k=>`<label class="admin-relink-option"><input type="radio" name="relink-${esc(w.id)}" value="${esc(k.projectId)}" ${chosen&&chosen.projectId===k.projectId?'checked':''} ${adminRelink.busy?'disabled':''}><span><strong>${esc(short(k.projectId))}</strong> · ${k.purchasedAt?`purchased ${esc(dateLabel(k.purchasedAt))}`:'purchase date not recorded'}${k.revision!==null&&k.revision!==undefined?` · version ${esc(String(k.revision))}`:''}${k.current?' · <em>currently linked</em>':''}${k.reported?' · <em>what the customer’s Website view shows now</em>':''}</span></label>`).join('');
        const step=!chosen?`<p class="helper-copy">Choose the project that is this business’s website. Nothing changes until you confirm.</p>`
          :!adminRelink.confirming?`<div class="admin-relink-actions"><button type="button" class="secondary-button" data-relink-next="${esc(w.id)}">${chosen.current?'Keep this link':'Link to this project'}</button></div>`
          :`<div class="admin-relink-actions"><p class="helper-copy"><strong>Confirm:</strong> ${chosen.current?`keep ${esc(w.businessName)} linked to ${esc(short(chosen.projectId))} and clear the review.`:`link ${esc(w.businessName)} to ${esc(short(chosen.projectId))}. Contact form submissions and analytics for this workspace follow the linked project from now on.`}${chosen.reported?'':' The builder still shows the customer a different project, so this may be flagged for review again on their next visit.'}</p><button type="button" class="primary-action" data-relink-confirm="${esc(w.id)}" ${adminRelink.busy?'disabled':''}>${adminRelink.busy?'Saving…':'Confirm'}</button><button type="button" class="secondary-button" data-relink-cancel="${esc(w.id)}" ${adminRelink.busy?'disabled':''}>Cancel</button></div>`;
        panel=`<div class="admin-relink" data-relink-panel="${esc(w.id)}"><p class="helper-copy">Verified purchases for this customer${x.candidatesCapturedAt?`, captured ${esc(dateLabel(x.candidatesCapturedAt))} from their own session`:''}:</p><fieldset class="admin-relink-list">${opts}</fieldset>${step}</div>`;
      }
      if(adminRelink.status)panel=panel.replace(/<\/div>$/,`<p class="modal-status" role="status" data-relink-status>${esc(adminRelink.status)}</p></div>`);
    }
    // Business name only labels the FIRST row per workspace; additional
    // projects for the same business are shown under a plain "also linked"
    // label so multiple rows for one workspace don't read as separate
    // customers.
    const label=i===0?esc(w.businessName):'Also linked';
    return `<div class="admin-row admin-link-row"><div><strong>${label}</strong><span>${detail}</span></div><div class="admin-actions"><span class="status-pill ${x.linked&&!x.needsReview?'':'neutral'}">${x.linked?(x.needsReview?'REVIEW':'LINKED'):'NOT LINKED'}</span>${resolveBtn}</div></div>${panel}`;
    }).join('');
  }).join('');
  qsa('[data-relink-open]').forEach(b=>b.onclick=()=>{const wid=b.dataset.relinkOpen;Object.assign(adminRelink,{open:adminRelink.open===wid?null:wid,choice:null,confirming:false,status:''});renderAdminWebsite(d);});
  qsa('.admin-relink input[type=radio]').forEach(r=>r.onchange=()=>{Object.assign(adminRelink,{choice:r.value,confirming:false,status:''});renderAdminWebsite(d);});
  qsa('[data-relink-next]').forEach(b=>b.onclick=()=>{adminRelink.confirming=true;renderAdminWebsite(d);});
  qsa('[data-relink-cancel]').forEach(b=>b.onclick=()=>{Object.assign(adminRelink,{confirming:false,status:''});renderAdminWebsite(d);});
  qsa('[data-relink-confirm]').forEach(b=>b.onclick=async()=>{const wid=b.dataset.relinkConfirm;if(adminRelink.busy||!adminRelink.choice)return;adminRelink.busy=true;renderAdminWebsite(d);try{await api(`/api/app/admin/website-links/${encodeURIComponent(wid)}/relink`,{method:'POST',body:JSON.stringify({generatorProjectId:adminRelink.choice})});Object.assign(adminRelink,{open:null,choice:null,confirming:false,busy:false,status:''});await renderAdmin();}catch(err){Object.assign(adminRelink,{busy:false,confirming:false,status:err.message});renderAdminWebsite(d);}});
  const prot=qs('#adminContactProtection');if(prot)prot.textContent=d.contactIntake&&d.contactIntake.rateLimited?`Contact intake: website forms, site submissions and chat are rate limited server-wide (${d.contactIntake.rules.map(r=>r.endpoint.replace(/^POST \/api\/public\//,'')).join(', ')}).`:'';}
qs('#loginForm').onsubmit=async e=>{e.preventDefault();const out=qs('#loginStatus');out.style.color='';out.textContent='Signing in…';try{await api('/api/auth/login',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.currentTarget)))});out.textContent='';if(await bootstrap())startLiveSync();}catch(err){out.style.color='#c54747';out.textContent=err.message}};
// Extended for the password-recovery pass to cover 4 states instead of 2
// ('forgot' and 'reset' alongside the original 'login'/'signup'). The tab
// row above the forms is only ever a choice between "Sign in" and "Create
// account" -- forgot/reset are reached from a link, not a tab -- so it's
// hidden outright for those two rather than left showing neither tab
// active. display is set directly (not the `hidden` attribute) since
// .auth-tabs already carries an author `display:grid` rule that would
// otherwise beat the UA [hidden] rule's display:none.
function setAuthMode(mode){
  const forms={login:qs('#loginForm'),signup:qs('#signupForm'),forgot:qs('#forgotForm'),reset:qs('#resetForm')};
  Object.keys(forms).forEach(k=>{ if(forms[k]) forms[k].hidden=(k!==mode); });
  const tabs=qs('.auth-tabs');
  if(tabs) tabs.style.display=(mode==='login'||mode==='signup')?'':'none';
  const a=qs('#showLogin'),b=qs('#showSignup');
  a.classList.toggle('active',mode==='login');b.classList.toggle('active',mode==='signup');
  a.setAttribute('aria-selected',String(mode==='login'));b.setAttribute('aria-selected',String(mode==='signup'));
}
qs('#showLogin').onclick=()=>setAuthMode('login');
qs('#showSignup').onclick=()=>setAuthMode('signup');
qs('#signupForm').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,out=qs('#signupStatus');out.className='';out.textContent='Creating your workspace…';try{const d=await api('/api/auth/signup',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))});out.className='success';out.textContent='Account created. Loading your workspace…';if(await bootstrap())startLiveSync();}catch(err){out.className='error';out.textContent=err.message;}};
// "Forgot password?" -- carries over whatever email the visitor already
// typed into the login form, if any, as a convenience only (never
// required, never validated here; the server does its own validation and
// never reveals whether the address has an account).
qs('#showForgotPassword').onclick=()=>{
  const le=qs('#loginForm [name=email]'),fe=qs('#forgotForm [name=email]');
  if(le&&fe&&le.value) fe.value=le.value;
  const out=qs('#forgotStatus'); out.style.color=''; out.textContent='';
  setAuthMode('forgot');
};
qs('#showLoginFromForgot').onclick=()=>setAuthMode('login');
qs('#forgotForm').onsubmit=async e=>{
  e.preventDefault();
  const out=qs('#forgotStatus'); out.style.color=''; out.textContent='Sending…';
  try{
    const d=await api('/api/auth/forgot-password',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.currentTarget)))});
    out.style.color='#14865d';
    out.textContent=d.message||'If an account exists for that email, we sent a password reset link.';
    e.currentTarget.reset();
  }catch(err){
    // A 400 (malformed email) or 429 (rate limited) surfaces here as a
    // real, specific error -- neither one reveals account existence, so
    // there's nothing unsafe about showing it plainly.
    out.style.color='#c54747';
    out.textContent=err.message;
  }
};
// Reached only by arriving through a real recovery link (see the
// detectPasswordRecoveryFragment IIFE near the top of this file, which
// populates pendingRecoverySession and switches to this form before any
// of this runs) or by clicking "Request a new link" from an
// already-expired one.
qs('#resetForm').onsubmit=async e=>{
  e.preventDefault();
  const out=qs('#resetStatus'); out.style.color='';
  const fd=Object.fromEntries(new FormData(e.currentTarget));
  const password=String(fd.password||''),confirmPassword=String(fd.confirmPassword||'');
  if(password.length<8){ out.style.color='#c54747'; out.textContent='Password must be at least 8 characters.'; return; }
  if(password!==confirmPassword){ out.style.color='#c54747'; out.textContent='Passwords do not match.'; return; }
  if(!pendingRecoverySession){
    out.style.color='#c54747';
    out.textContent='This reset link is invalid or has expired. Request a new one.';
    qs('#showForgotFromReset').hidden=false;
    return;
  }
  out.textContent='Setting your new password…';
  try{
    await api('/api/auth/reset-password',{method:'POST',body:JSON.stringify({accessToken:pendingRecoverySession.accessToken,refreshToken:pendingRecoverySession.refreshToken,password})});
    pendingRecoverySession=null;
    out.style.color='#14865d';
    out.textContent='Password updated. Signing you in…';
    if(await bootstrap()){
      startLiveSync();
    }else{
      // Extremely unlikely given the route only returns success once real
      // session cookies are already set, but a clean fallback rather than
      // leaving the visitor stuck on a "signing you in…" message forever.
      setAuthMode('login');
      const ls=qs('#loginStatus'); ls.style.color='#14865d'; ls.textContent='Password updated. Sign in with your new password.';
    }
  }catch(err){
    out.style.color='#c54747';
    out.textContent=err.message;
    qs('#showForgotFromReset').hidden=false;
  }
};
qs('#showForgotFromReset').onclick=()=>{
  pendingRecoverySession=null;
  setAuthMode('forgot');
};
qs('#logoutButton').onclick=async()=>{try{await api('/api/auth/logout',{method:'POST'});}catch{}location.reload()};
qs('#workspaceSwitchButton').onclick=()=>{const m=qs('#workspaceMenu');m.hidden=!m.hidden};
qs('#aiSettingsForm').onsubmit=async e=>{e.preventDefault();const out=qs('#aiSettingsStatus');if(out)out.textContent='Saving…';try{await api('/api/app/settings',{method:'PATCH',body:JSON.stringify(Object.fromEntries(new FormData(e.currentTarget)))});await refreshLight();if(out)out.textContent='Saved.';}catch(err){if(out)out.textContent=err.message;}};
// Phase 8: "Try the chat" is a preview (POST /api/app/chat-preview): the same
// reply the live widget would give, but nothing is saved -- it used to post
// to the public widget endpoint and leave a real "Website chat" contact
// behind for every test. History is kept here, in the page, only.
let widgetPreviewHistory=[];
const WIDGET_PREVIEW_MODE={ai:'Replies written by AI — this is what visitors would see. Preview only: nothing is saved or added to Contact.',basic:'AI replies aren’t turned on, so the chat uses its built-in questions — this is what visitors would see. Preview only: nothing is saved or added to Contact.',off:'The chat assistant is off, so visitors only get a “message received” reply. Preview only: nothing is saved or added to Contact.'};
if(qs('#testAiButton'))qs('#testAiButton').onclick=()=>{const demo=qs('#widgetDemo');demo.hidden=false;widgetPreviewHistory=[];const msgs=qs('#widgetMessages');msgs.innerHTML='<div class="widget-bubble ai">Hi — tell me what you need help with and I’ll get the details for the business.</div>';const note=qs('#widgetPreviewNote');if(note)note.textContent='Preview only: nothing you type here is saved or added to Contact.';};
if(qs('#closeWidgetDemo'))qs('#closeWidgetDemo').onclick=()=>qs('#widgetDemo').hidden=true;
if(qs('#widgetForm'))qs('#widgetForm').onsubmit=async e=>{e.preventDefault();const text=qs('#widgetText').value.trim();if(!text)return;const msgs=qs('#widgetMessages');const safe=esc(text);msgs.insertAdjacentHTML('beforeend',`<div class="widget-bubble customer">${safe}</div>`);qs('#widgetText').value='';try{const d=await api('/api/app/chat-preview',{method:'POST',body:JSON.stringify({text,history:widgetPreviewHistory})});widgetPreviewHistory.push({from:'customer',text},{from:'ai',text:d.reply||''});widgetPreviewHistory=widgetPreviewHistory.slice(-18);msgs.insertAdjacentHTML('beforeend',`<div class="widget-bubble ai">${esc(d.reply||'')}</div>`);const note=qs('#widgetPreviewNote');if(note)note.textContent=WIDGET_PREVIEW_MODE[d.mode]||WIDGET_PREVIEW_MODE.basic;}catch(err){msgs.insertAdjacentHTML('beforeend',`<div class="widget-bubble ai">${esc(err.message)}</div>`);}msgs.scrollTop=msgs.scrollHeight;};
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
//
// Login/startup performance pass: this was only ever being set inside
// liveRefresh() itself, never from bootstrap()'s own fetch (the one that
// runs on every page load and right after login) — so the FIRST 5-second
// poll after every single login always sent no If-None-Match at all and
// paid full backend cost even when nothing had changed since the page
// finished loading a moment earlier. bootstrap() now captures its own
// response's ETag too (see the api() call above), so that first poll can
// actually 304 like every one after it already could.
let lastBootstrapETag=null;
async function liveRefresh(){if(liveRefreshing||document.hidden||!state.user)return;liveRefreshing=true;document.body.classList.add('live-syncing');try{const before=renderBadges();const selectedConversationId=state.selectedConversationId,selectedLeadId=state.selectedLeadId;const headers={'Content-Type':'application/json'};if(lastBootstrapETag)headers['If-None-Match']=lastBootstrapETag;const res=await fetch('/api/app/bootstrap',{headers});if(res.status===304)return;const etag=res.headers.get('ETag');const d=await res.json().catch(()=>({}));if(!res.ok||d.ok===false)throw new Error(d.message||`Request failed (${res.status})`);if(etag)lastBootstrapETag=etag;Object.assign(state,{workspace:d.workspace||state.workspace,workspaces:d.workspaces||state.workspaces,user:d.user||state.user,locked:!!d.locked,integrations:d.integrations||{},leads:d.leads||[],conversations:d.conversations||[],appointments:d.appointments||[],invoices:d.invoices||[],automations:d.automations||[],activities:d.activities||[],adSpend:d.adSpend||[],adFunds:d.adFunds||[],billing:d.billing||{},prospectViews:d.prospectViews||[],websiteAnalytics:d.websiteAnalytics||{},websiteUpdates:d.websiteUpdates||[],websiteProjects:d.websiteProjects||[]});state.selectedConversationId=selectedConversationId;state.selectedLeadId=selectedLeadId;const after={newLeads:state.leads.filter(l=>l.status==='New').length,unread:state.conversations.reduce((sum,c)=>sum+Math.max(0,Number(c.unread)||0),0)};renderWebsite();renderContact();renderAds();renderDashboard();renderLeads();renderInbox();renderCalendar();renderPayments();renderAnalytics();renderNotifications();renderWebsiteProjects();fillLeadSelects();if(after.newLeads>lastLiveCounts.leads&&lastLiveCounts.leads>=0){const newest=state.leads.find(l=>l.status==='New');if(newest)showToast('New lead',`${newest.name} · ${newest.service}`);}else if(after.unread>lastLiveCounts.unread&&lastLiveCounts.unread>=0){const newest=state.conversations.find(c=>Number(c.unread)>0);if(newest)showToast('New customer message',newest.name);}lastLiveCounts={leads:after.newLeads,unread:after.unread};}catch(e){console.warn('Live refresh:',e.message);}finally{liveRefreshing=false;document.body.classList.remove('live-syncing');}}
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
