(() => {
  function install(){
    const view=document.getElementById('view-website-updates');
    if(!view||document.getElementById('v19UpdateNotice'))return;
    const head=view.querySelector('.page-head');
    if(!head)return;
    const note=document.createElement('div');
    note.id='v19UpdateNotice';
    note.className='v19-update-notice';
    const strong=document.createElement('strong');
    strong.textContent='Requests go directly to SiteRemade.';
    const span=document.createElement('span');
    span.textContent='Every request is tracked here and SiteRemade receives an email alert when email delivery is connected.';
    note.append(strong,span);
    head.insertAdjacentElement('afterend',note);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
})();
