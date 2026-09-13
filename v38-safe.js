(()=>{
let installed=false,twilioStatus=null;
const $=s=>document.querySelector(s);
async function getJson(url,opts={}){const r=await fetch(url,{credentials:'same-origin',...opts,headers:{'Content-Type':'application/json',...(opts.headers||{})}}),j=await r.json().catch(()=>({}));if(!r.ok||j.ok===false)throw Error(j.message||'Request failed');return j}
function providerState(id){
  const button=document.querySelector(`[data-v34="${id}"]`);
  const card=button?.closest('.v34-card');
  const state=card?.querySelector('.v34-state')?.textContent?.trim()||'';
  const label=card?.querySelector('.v34-label')?.textContent?.trim()||'';
  return{button,connected:state==='Connected',label};
}
async function loadTwilioStatus(){try{twilioStatus=await getJson('/api/app/integrations/twilio/status')}catch{twilioStatus={configured:false,connected:false}}return twilioStatus}
function selectedLead(){const c=state?.conversations?.find(x=>x.id===state.selectedConversationId);return c?state.leads.find(l=>l.id===c.leadId):null}
async function textCustomer(lead){if(!lead?.phone)return alert('This customer does not have a phone number.');const s=twilioStatus||await loadTwilioStatus();if(!s.connected)return alert('Connect the phone integration first.');const text=prompt(`Message ${lead.name||lead.phone}:`,'');if(!text?.trim())return;if(!confirm(`Send this message to ${lead.name||lead.phone}?`))return;try{const r=await getJson('/api/app/integrations/twilio/send',{method:'POST',body:JSON.stringify({leadId:lead.id,text:text.trim(),confirmSend:true})});if(typeof refreshLight==='function')await refreshLight();if(r.conversationId)state.selectedConversationId=r.conversationId;if(typeof renderInbox==='function')renderInbox();alert('Message sent.')}catch(e){alert(e.message)}}
function decorateCalendar(){
  const head=$('#view-calendar .page-head');if(!head)return;
  let wrap=$('#v38CalendarStatus');
  if(!wrap){wrap=document.createElement('div');wrap.id='v38CalendarStatus';wrap.className='head-actions';head.appendChild(wrap)}
  const c=providerState('google_calendar');
  wrap.innerHTML=c.connected?'<span class="coming-badge">GOOGLE CALENDAR CONNECTED</span><button class="secondary-button" type="button" id="v38CalendarSync">Sync calendar</button>':'<span class="coming-badge neutral">GOOGLE CALENDAR NOT CONNECTED</span>';
  const b=$('#v38CalendarSync');if(b)b.onclick=()=>c.button?.click();
}
async function syncSms(button){const old=button.textContent;button.disabled=true;button.textContent='Syncing…';try{const j=await getJson('/api/app/integrations/twilio/sync',{method:'POST',body:'{}'});if(typeof refreshLight==='function')await refreshLight();if(typeof renderInbox==='function')renderInbox();await loadTwilioStatus();await decorateInbox();button.textContent=`Synced ${j.imported||0}`;setTimeout(()=>{button.textContent='↻ Sync SMS';button.disabled=false},1200)}catch(e){button.disabled=false;button.textContent=old;alert(e.message)}}
async function connectTwilio(){const integrationButton=document.querySelector('[data-v34="twilio"]');if(integrationButton){integrationButton.click();return}document.querySelector('[data-view="integrations"]')?.click()}
async function decorateInbox(){
  const bar=$('#v29MailboxBar');if(!bar)return;
  let box=$('#v38SmsStatus');if(!box){box=document.createElement('section');box.id='v38SmsStatus';box.className='v29-mailbar';bar.insertAdjacentElement('afterend',box)}
  const s=await loadTwilioStatus();
  if(s.connected){box.innerHTML=`<div class="v29-mail-account"><span class="v29-dot live"></span><strong>Business SMS</strong><small>${s.phoneNumber||s.label||'Phone line connected'} · customer texts sync into Messages</small></div><div class="v29-mail-actions"><button type="button" class="secondary-button" id="v38SmsSync">↻ Sync SMS</button></div>`;const sb=$('#v38SmsSync');if(sb)sb.onclick=()=>syncSms(sb)}
  else if(s.configured){box.innerHTML='<div class="v29-mail-account"><span class="v29-dot"></span><strong>Business SMS</strong><small>Twilio is ready. Connect your business number to sync texts into Messages.</small></div><div class="v29-mail-actions"><button type="button" class="secondary-button" id="v38SmsConnect">Connect</button></div>';const cb=$('#v38SmsConnect');if(cb)cb.onclick=connectTwilio}
  else box.innerHTML='<div class="v29-mail-account"><span class="v29-dot"></span><strong>Business SMS</strong><small>Twilio is not configured yet.</small></div>';
  const lead=selectedLead(),panel=$('#v29CustomerPanel'),actions=panel?.querySelector('.v29-panel-actions');
  if(s.connected&&lead?.phone&&actions&&!actions.querySelector('#v38TextCustomer')){const b=document.createElement('button');b.id='v38TextCustomer';b.type='button';b.textContent='Text';b.onclick=()=>textCustomer(lead);actions.insertBefore(b,actions.lastElementChild)}
}
function decoratePayments(){
  const view=$('#view-payments');if(!view)return;let box=$('#v38StripeStatus');
  if(!box){box=document.createElement('div');box.id='v38StripeStatus';box.className='panel';view.querySelector('.payment-metrics')?.insertAdjacentElement('beforebegin',box)}
  const s=providerState('stripe'),invoices=state?.invoices||[],paid=invoices.filter(i=>i.status==='Paid').length,open=invoices.filter(i=>i.status==='Pending').length;
  box.innerHTML=`<div class="panel-head"><div><p class="eyebrow">CONNECTED PAYMENTS</p><h2>${s.connected?'Stripe is active across customer payments':'Connect Stripe to activate the full payment workflow'}</h2><p>${s.connected?'Payment links and invoice status stay attached to customer records.':'Payment links work, but connected account status and payouts are not active yet.'}</p></div><span class="status-pill ${s.connected?'':'neutral'}">${s.connected?'ACTIVE':'NOT CONNECTED'}</span></div><div class="ad-metrics"><div><span>PAID INVOICES</span><strong>${paid}</strong></div><div><span>OPEN INVOICES</span><strong>${open}</strong></div><div><span>ACCOUNT</span><strong>${s.connected?'CONNECTED':'—'}</strong></div><div><span>WORKFLOW</span><strong>${s.connected?'LIVE':'—'}</strong></div></div>`;
}
function refresh(){decorateCalendar();decorateInbox();decoratePayments()}
function patch(){if(typeof renderConversationWindow==='function'){const old=renderConversationWindow;renderConversationWindow=function(){const r=old.apply(this,arguments);setTimeout(decorateInbox,0);return r}}}
function install(){if(installed||typeof state==='undefined')return setTimeout(install,100);installed=true;patch();setTimeout(refresh,700);document.addEventListener('click',e=>{if(e.target.closest('[data-view="calendar"],[data-view="inbox"],[data-view="payments"],[data-view="integrations"]'))setTimeout(refresh,250)});setInterval(()=>{if($('#view-inbox')?.classList.contains('active'))decorateInbox()},30000)}
document.readyState==='loading'?document.addEventListener('DOMContentLoaded',install):install();
})();
