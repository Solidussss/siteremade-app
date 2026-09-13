(() => {
  const make=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
  async function render(){
    if(typeof state==='undefined'||state.user?.role!=='owner')return;
    const view=document.getElementById('view-admin');if(!view)return;
    let box=document.getElementById('v19AgencyOverview');
    if(!box){box=make('section');box.id='v19AgencyOverview';box.className='v19-agency-overview';view.querySelector('.page-head')?.insertAdjacentElement('afterend',box);}
    box.replaceChildren(make('p','Loading agency overview…'));
    try{
      const d=await api('/api/v19/admin/overview');
      box.replaceChildren();
      const heading=make('div');heading.className='v19-agency-heading';heading.append(make('span','AGENCY COMMAND CENTER'),make('strong',`${d.workspaces.length} client workspaces`));box.appendChild(heading);
      const metrics=make('div');metrics.className='v19-agency-metrics';
      const values=[['Active leads',d.workspaces.reduce((n,w)=>n+Number(w.activeLeads||0),0)],['Unread messages',d.workspaces.reduce((n,w)=>n+Number(w.unread||0),0)],['Open website requests',d.updateRequests.filter(r=>r.status!=='Completed').length]];
      values.forEach(([label,value])=>{const card=make('div');card.append(make('span',label),make('strong',String(value)));metrics.appendChild(card)});box.appendChild(metrics);
      const queue=make('div');queue.className='v19-agency-queue';queue.appendChild(make('strong','Latest website requests'));
      d.updateRequests.slice(0,12).forEach(r=>{const row=make('div');row.append(make('b',r.businessName),make('span',`${r.page} · ${r.request}`),make('small',`${r.priority} · ${r.status}`));queue.appendChild(row)});if(!d.updateRequests.length)queue.appendChild(make('p','No website requests waiting.'));box.appendChild(queue);
    }catch(e){box.replaceChildren(make('p',e.message));}
  }
  function install(){if(typeof state==='undefined'||typeof api!=='function')return setTimeout(install,100);document.querySelectorAll('[data-view="admin"]').forEach(b=>b.addEventListener('click',()=>setTimeout(render,50)));render();}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
})();
