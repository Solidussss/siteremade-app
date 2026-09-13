(()=>{
function run(){
  const head=document.querySelector('#view-calendar .page-head');
  if(!head||document.querySelector('#v38CalendarStatus'))return;
  const badge=document.createElement('span');
  badge.id='v38CalendarStatus';
  badge.className='coming-badge neutral';
  badge.textContent='CALENDAR SYNC';
  head.appendChild(badge);
}
document.readyState==='loading'?document.addEventListener('DOMContentLoaded',run):run();
})();
