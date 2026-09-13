document.documentElement.dataset.siteremadeVersion='19';
(() => {
  const byId=id=>document.getElementById(id);
  const make=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};
  const activeLead=l=>!['Won','Lost'].includes(l.status);
  const daysOld=iso=>Math.max(0,Math.floor((Date.now()-new Date(iso||Date.now()).getTime())/86400000));
  function addStat(parent,label,value,view){const b=make('button','v19-focus-card');b.dataset.view=view;b.append(make('span','',label),make('strong','',String(value)));b.addEventListener('click',()=>switchView(view));parent.appendChild(b);}
  function renderFocus(){const strip=byId('v19FocusStrip');if(!strip||typeof state==='undefined')return;strip.replaceChildren();const active=state.leads.filter(activeLead).length;const unread=state.conversations.reduce((n,c)=>n+Math.max(0,Number(c.unread)||0),0);const stale=state.leads.filter(l=>activeLead(l)&&daysOld(l.updatedAt||l.createdAt)>=2).length;const today=new Date().toDateString();const booked=state.appointments.filter(a=>new Date(a.start).toDateString()===today).length;addStat(strip,'ACTIVE LEADS',active,'leads');addStat(strip,'WAITING REPLIES',unread,'inbox');addStat(strip,'FOLLOW UPS',stale,'leads');addStat(strip,"TODAY'S BOOKINGS",booked,'calendar');}
  function install(){if(typeof state==='undefined'||typeof switchView!=='function')return setTimeout(install,100);const home=byId('view-home');if(home&&!byId('v19FocusStrip')){const strip=make('div','v19-focus-strip');strip.id='v19FocusStrip';const head=home.querySelector('.page-head');if(head)head.insertAdjacentElement('afterend',strip);}renderFocus();}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
  window.SiteRemadeV19={renderFocus};
})();
