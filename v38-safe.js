(()=>{
let installed=false;
const $=s=>document.querySelector(s);
function providerState(id){
  const button=document.querySelector(`[data-v34="${id}"]`);
  const card=button?.closest('.v34-card');
  const state=card?.querySelector('.v34-state')?.textContent?.trim()||'';
  const label=card?.querySelector('.v34-label')?.textContent?.trim()||'';
  return{button,connected:state==='Connected',label};
}
async function post(url,data){const r=await fetch(url,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}),j=await r.json().catch(()=>({}));if(!r.ok||j.ok===false)throw Error(j.message||'Request failed');return j}
function selectedLead(){const c=state?.conversations?.find(x=>x.id===state.selectedConversationId);return c?state.leads.find(l=>l.id===c.leadId):null}
async function textCustomer(lead){if(!lead?.phone)return alert('This customer does not have a phone number.');const p=providerState('twilio');if(!p.connected)return alert('Connect the phone integration first.');const text=prompt(`Message ${lead.name||lead.phone}:`,'');if(!text?.trim())return;if(!confirm(`Send this message to ${lead.name||lead.phone}?`))return;try{const r=await post('/api/app/integrations/twilio/send',{leadId:lead.id,text:text.trim(),confirmSend:true});if(typeof refreshLight==='function')await refreshLight();if(r.conversationId)state.selectedConversationId=r.conversationId;if(typeof renderInbox==='function')renderInbox();alert('Message sent.')}catch(e){alert(e.message)}}
function decorateCalendar(){
  const head=$('#view-calendar .page-head');if(!head)return;
  let wrap=$('#v38CalendarStatus');
  if(!wrap){wrap=document.createElement('div');wrap.id='v38CalendarStatus';wrap.className='head-actions';head.appendChild(wrap)}
  const c=providerState('google_calendar');
  wrap.innerHTML=c.connected?'<span class="coming-badge">GOOGLE CALENDAR CONNECTED</span><button class="secondary-button" type="button" id="v38CalendarSync">Sync calendar</button>':'<span class="coming-badge neutral">GOOGLE CALENDAR NOT CONNECTED</span>';
  const b=$('#v38CalendarSync');if(b)b.onclick=()=>c.button?.click();
}
function decorateInbox(){
  const bar=$('#v29MailboxBar');if(!bar)return;
  let box=$('#v38SmsStatus');if(!box){box=document.createElement('section');box.id='v38SmsStatus';box.className='v29-mailbar';bar.insertAdjacentElement('afterend',box)}
  const p=providerState('twilio');
  box.innerHTML=p.connected?`<div class="v29-mail-account"><span class="v29-dot live"></span><strong>Business SMS connected</strong><small>${p.label||'Phone line connected'} · incoming customer texts are added to Messages</small></div>`:'<div class="v29-mail-account"><span class="v29-dot"></span><strong>Business SMS</strong><small>Connect the phone integration to bring customer texts into Messages.</small></div>';
  const lead=selectedLead(),panel=$('#v29CustomerPanel'),actions=panel?.querySelector('.v29-panel-actions');
  if(p.connected&&lead?.phone&&actions&&!actions.querySelector('#v38TextCustomer')){const b=document.createElement('button');b.id='v38TextCustomer';b.type='button';b.textContent='Text';b.onclick=()=>textCustomer(lead);actions.insertBefore(b,actions.lastElementChild)}
}
function decoratePayments(){
  const view=$('#view-payments');if(!view)return;let box=$('#v38StripeStatus');
  if(!box){box=document.createElement('div');box.id='v38StripeStatus';box.className='panel';view.querySelector('.payment-metrics')?.insertAdjacentElement('beforebegin',box)}
  const s=providerState('stripe'),invoices=state?.invoices||[],paid=invoices.filter(i=>i.status==='Paid').length,open=invoices.filter(i=>i.status==='Pending').length;
  box.innerHTML=`<div class="panel-head"><div><p class="eyebrow">CONNECTED PAYMENTS</p><h2>${s.connected?'Stripe is active across customer payments':'Connect Stripe to activate the full payment workflow'}</h2><p>${s.connected?'Payment links and invoice status stay attached to customer records.':'Payment links work, but connected account status and payouts are not active yet.'}</p></div><span class="status-pill ${s.connected?'':'neutral'}">${s.connected?'ACTIVE':'NOT CONNECTED'}</span></div><div class="ad-metrics"><div><span>PAID INVOICES</span><strong>${paid}</strong></div><div><span>OPEN INVOICES</span><strong>${open}</strong></div><div><span>ACCOUNT</span><strong>${s.connected?'CONNECTED':'—'}</strong></div><div><span>WORKFLOW</span><strong>${s.connected?'LIVE':'—'}</strong></div></div>`;
}
function refresh(){decorateCalendar();decorateInbox();decoratePayments()}
function patch(){if(typeof renderConversationWindow==='function'){const old=renderConversationWindow;renderConversationWindow=function(){const r=old.apply(this,arguments);setTimeout(decorateInbox,0);return r}}}
function install(){if(installed||typeof state==='undefined')return setTimeout(install,100);installed=true;patch();setTimeout(refresh,900);document.addEventListener('click',e=>{if(e.target.closest('[data-view="calendar"],[data-view="inbox"],[data-view="payments"],[data-view="integrations"]'))setTimeout(refresh,350)})}
document.readyState==='loading'?document.addEventListener('DOMContentLoaded',install):install();
})();
