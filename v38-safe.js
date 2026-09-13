(()=>{
let installed=false;
function calendarState(){
  const button=document.querySelector('[data-v34="google_calendar"]');
  const card=button?.closest('.v34-card');
  const state=card?.querySelector('.v34-state')?.textContent?.trim()||'';
  return{button,connected:state==='Connected'};
}
function decorateCalendar(){
  const head=document.querySelector('#view-calendar .page-head');if(!head)return;
  let wrap=document.querySelector('#v38CalendarStatus');
  if(!wrap){wrap=document.createElement('div');wrap.id='v38CalendarStatus';wrap.className='head-actions';head.appendChild(wrap)}
  const c=calendarState();
  wrap.innerHTML=c.connected?'<span class="coming-badge">GOOGLE CALENDAR CONNECTED</span><button class="secondary-button" type="button" id="v38CalendarSync">Sync calendar</button>':'<span class="coming-badge neutral">GOOGLE CALENDAR NOT CONNECTED</span>';
  const b=document.querySelector('#v38CalendarSync');if(b)b.onclick=()=>c.button?.click();
}
function install(){if(installed)return;installed=true;setTimeout(decorateCalendar,900);document.addEventListener('click',e=>{if(e.target.closest('[data-view="calendar"],[data-view="integrations"]'))setTimeout(decorateCalendar,350)})}
document.readyState==='loading'?document.addEventListener('DOMContentLoaded',install):install();
})();
