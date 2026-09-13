(() => {
  const wait = () => typeof state !== 'undefined' && typeof qs === 'function' && typeof renderAll === 'function';
  const ageDays = iso => Math.floor((Date.now() - new Date(iso || Date.now()).getTime()) / 86400000);
  const activeLead = l => !['Won','Lost'].includes(l.status);
  const realConversation = c => Array.isArray(c?.messages) && c.messages.length > 0;
  const lastMessage = c => c?.messages?.[c.messages.length - 1];

  function scoreLead(l){
    let score=0;
    if(l.phone) score+=24;
    if(l.email) score+=12;
    if(l.message && l.message.length>15) score+=16;
    if(l.service) score+=10;
    if(Number(l.value)>0) score+=8;
    if(l.status==='Quoted') score+=18;
    if(l.status==='Contacted') score+=12;
    if(l.status==='New') score+=10;
    const age=ageDays(l.updatedAt||l.createdAt);
    if(age<=1) score+=12; else if(age<=3) score+=7;
    return Math.min(100,score);
  }
  function leadConversation(l){return state.conversations.find(c=>c.leadId===l.id&&realConversation(c));}
  function needsReply(l){const c=leadConversation(l),m=lastMessage(c);return !!(m&&m.from==='customer');}
  function nextAction(l){
    if(needsReply(l)) return {label:'Reply now',kind:'inbox'};
    if(l.status==='New') return {label:'Contact lead',kind:'contact'};
    if(l.status==='Contacted') return {label:'Follow up',kind:'contact'};
    if(l.status==='Quoted') return {label:'Follow up quote',kind:'contact'};
    return {label:'Open lead',kind:'lead'};
  }
  function openAction(l,kind){
    if(kind==='inbox'){
      const c=leadConversation(l); if(c){state.selectedConversationId=c.id;switchView('inbox');renderInbox();return;}
    }
    openLead(l.id);
  }
  function injectHome(){
    const view=qs('#view-home'); if(!view||qs('#v18Command')) return;
    const head=view.querySelector('.page-head');
    const box=document.createElement('section');box.id='v18Command';box.className='v18-command';
    box.innerHTML='<div class="v18-command-head"><div><p class="eyebrow">CONVERSION COMMAND CENTER</p><h2>What needs attention</h2><p>SiteRemade ranks the customers most likely to need action right now.</p></div><button class="secondary-button" data-v18-all>View pipeline</button></div><div class="v18-action-grid" id="v18ActionGrid"></div>';
    head.insertAdjacentElement('afterend',box);box.querySelector('[data-v18-all]').onclick=()=>switchView('leads');
  }
  function renderCommand(){
    injectHome();const el=qs('#v18ActionGrid');if(!el)return;
    const ranked=state.leads.filter(activeLead).map(l=>({l,score:scoreLead(l),reply:needsReply(l),age:ageDays(l.updatedAt||l.createdAt)})).sort((a,b)=>(b.reply-a.reply)||(b.score-a.score)||(b.age-a.age)).slice(0,5);
    el.innerHTML=ranked.length?ranked.map(({l,score,reply,age})=>{const a=nextAction(l);return `<button class="v18-action-card" data-v18-lead="${l.id}" data-v18-kind="${a.kind}"><span class="v18-score">${score}</span><div><strong>${esc(l.name)}</strong><span>${esc(l.service||'Customer')} · ${esc(l.status)}</span><small>${reply?'Waiting for your reply':age>=2?`${age} days since activity`:'Recent opportunity'}</small></div><em>${a.label} ↗</em></button>`}).join(''):'<div class="empty-state">No active leads need attention right now.</div>';
    el.querySelectorAll('[data-v18-lead]').forEach(b=>b.onclick=()=>{const l=state.leads.find(x=>x.id===b.dataset.v18Lead);if(l)openAction(l,b.dataset.v18Kind)});
  }
  function upgradeLeads(){
    document.querySelectorAll('#leadTableBody tr[data-id]').forEach(row=>{
      const l=state.leads.find(x=>x.id===row.dataset.id);if(!l)return;
      let cell=row.querySelector('.v18-next-cell');
      if(!cell){cell=document.createElement('td');cell.className='v18-next-cell';row.insertBefore(cell,row.lastElementChild);}
      const a=nextAction(l);cell.innerHTML=`<button type="button" class="v18-next" data-v18-row="${l.id}" data-kind="${a.kind}">${a.label}</button>`;
      cell.querySelector('button').onclick=e=>{e.stopPropagation();openAction(l,a.kind)};
    });
    const table=qs('.lead-table thead tr');if(table&&!table.querySelector('.v18-next-head')){const th=document.createElement('th');th.className='v18-next-head';th.textContent='Next action';table.insertBefore(th,table.lastElementChild);}
  }
  function upgradeMarket(){
    const title=qs('#prospectResultsTitle');if(title)title.title='Search by the exact type of customer, location, rating, review count, website and phone availability.';
    document.querySelectorAll('.prospect-card').forEach((card,i)=>{const p=state.prospects[i];if(!p||card.querySelector('.v18-fit'))return;let fit=35;if(p.phone)fit+=20;if(p.website)fit+=8;if(Number(p.rating)>=4)fit+=12;if(Number(p.reviews)>=10)fit+=10;if(Number(p.reviews)<=150)fit+=8;fit=Math.min(100,fit);const badge=document.createElement('span');badge.className='v18-fit';badge.textContent=`FIT ${fit}`;card.querySelector('.prospect-title-row')?.appendChild(badge);});
  }
  function upgradeCalendar(){
    document.querySelectorAll('[data-appt]').forEach(b=>{const a=state.appointments.find(x=>x.id===b.dataset.appt),l=a?.leadId?state.leads.find(x=>x.id===a.leadId):null;if(l&&!b.querySelector('.v18-appt-status')){const s=document.createElement('i');s.className='v18-appt-status';s.textContent=l.status;b.appendChild(s);}});
  }
  function renderHealth(){
    const top=qs('.topbar-status');if(!top)return;let h=qs('#v18Health');if(!h){h=document.createElement('span');h.id='v18Health';h.className='v18-health';top.appendChild(h);}const active=state.leads.filter(activeLead).length,waiting=state.leads.filter(needsReply).length,stale=state.leads.filter(l=>activeLead(l)&&ageDays(l.updatedAt||l.createdAt)>=2).length;h.textContent=`${active} active · ${waiting} waiting · ${stale} follow-up`;
  }
  function install(){
    if(!wait())return setTimeout(install,80);
    const oldAll=renderAll;renderAll=function(){const r=oldAll();renderCommand();upgradeLeads();upgradeMarket();upgradeCalendar();renderHealth();return r;};
    const oldLeads=renderLeads;renderLeads=function(){const r=oldLeads();upgradeLeads();return r;};
    const oldProspects=renderProspects;renderProspects=function(){const r=oldProspects();upgradeMarket();return r;};
    const oldCalendar=renderCalendar;renderCalendar=function(){const r=oldCalendar();upgradeCalendar();return r;};
    renderCommand();upgradeLeads();upgradeMarket();upgradeCalendar();renderHealth();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
})();
