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
}
function refresh(){decorateCalendar();decorateInbox()}
function install(){if(installed)return;installed=true;setTimeout(refresh,900);document.addEventListener('click',e=>{if(e.target.closest('[data-view="calendar"],[data-view="inbox"],[data-view="integrations"]'))setTimeout(refresh,350)})}
document.readyState==='loading'?document.addEventListener('DOMContentLoaded',install):install();
})();
