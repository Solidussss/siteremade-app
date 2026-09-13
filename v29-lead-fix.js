(()=>{
  const ready=()=>typeof state!=='undefined'&&typeof api==='function'&&typeof switchView==='function';
  const lead=()=>state.leads.find(l=>l.id===state.selectedLeadId);
  const drawer=()=>document.querySelector('#leadDrawer');
  const close=()=>{const d=drawer();if(d)d.hidden=true;};

  async function openMessage(){
    const l=lead();if(!l)return;
    const existing=state.conversations.find(c=>c.leadId===l.id&&Array.isArray(c.messages)&&c.messages.length);
    if(existing){state.selectedConversationId=existing.id;close();switchView('inbox');renderInbox();setTimeout(()=>document.querySelector('#messageInput')?.focus(),80);return;}
    if(state.integrations?.twilio&&l.phone){
      try{
        let c=state.conversations.find(x=>x.leadId===l.id);
        if(!c){const d=await api('/api/app/conversations',{method:'POST',body:JSON.stringify({leadId:l.id})});c=d.conversation;}
        if(typeof refreshLight==='function')await refreshLight();
        state.selectedConversationId=c.id;close();switchView('inbox');renderInbox();setTimeout(()=>document.querySelector('#messageInput')?.focus(),80);
      }catch(e){alert(e.message||'Could not open message.');}
      return;
    }
    if(l.phone){window.location.href=`sms:${l.phone}`;return;}
    if(l.email){window.location.href=`mailto:${l.email}`;return;}
    alert('Add a phone number or email before messaging this customer.');
  }

  function book(){
    const l=lead();if(!l)return;
    const modal=document.querySelector('#appointmentModal');if(!modal)return;
    if(typeof fillLeadSelects==='function')fillLeadSelects();
    modal.hidden=false;
    const select=document.querySelector('#appointmentLead');if(select)select.value=l.id;
    const date=document.querySelector('#appointmentForm [name="date"]');
    const time=document.querySelector('#appointmentForm [name="time"]');
    if(date&&!date.value){const d=new Date();d.setDate(d.getDate()+1);date.value=d.toISOString().slice(0,10);}
    if(time&&!time.value)time.value='09:00';
  }

  function wire(){
    if(!ready())return setTimeout(wire,100);
    const message=document.querySelector('#messageLeadButton');if(message){message.textContent='Message customer';message.onclick=openMessage;}
    const bookBtn=document.querySelector('#bookLeadButton');if(bookBtn)bookBtn.onclick=book;
    const closeBtn=document.querySelector('#closeDrawer');if(closeBtn)closeBtn.onclick=close;
    const d=drawer();if(d&&!d.dataset.v29){d.dataset.v29='1';new MutationObserver(()=>{if(!d.hidden){const m=document.querySelector('#messageLeadButton');if(m)m.onclick=openMessage;const b=document.querySelector('#bookLeadButton');if(b)b.onclick=book;}}).observe(d,{attributes:true,attributeFilter:['hidden']});}
  }
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',wire):wire();
})();