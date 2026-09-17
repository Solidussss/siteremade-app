(()=>{
const PRICE_CENTS=3900;
const PRICE_LABEL='$39';
function patch(){
  try{
    if(typeof state!=='undefined'&&state.billing)state.billing.monthlyCents=PRICE_CENTS;
    const el=document.querySelector('#lockSubscriptionPrice');
    if(el)el.textContent=PRICE_LABEL;
    const copy=document.querySelector('.subscription-lock-copy');
    if(copy&&!/\$39/.test(copy.textContent||''))copy.textContent='Your workspace is ready. Start your $39/month SiteRemade plan to unlock leads, AI conversations, bookings, payments, analytics and automations.';
  }catch{}
}
function install(){patch();setTimeout(patch,250);setTimeout(patch,1200);new MutationObserver(patch).observe(document.documentElement,{subtree:true,childList:true});}
document.readyState==='loading'?document.addEventListener('DOMContentLoaded',install):install();
})();
