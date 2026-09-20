(()=>{
const $=s=>document.querySelector(s);
let busy=false,lastSig='';
const clean=v=>String(v||'').replace(/\D/g,'');
const fmt=id=>clean(id).replace(/(\d{3})(\d{3})(\d{4})/,'$1-$2-$3');
async function getAccounts(){const r=await fetch('/api/app/google-ads/accounts',{credentials:'same-origin'});let j={};try{j=await r.json()}catch{}if(!r.ok||j.ok===false)throw Error(j.message||`Google Ads accounts failed (${r.status})`);return j}
function ensureNote(select){let note=document.getElementById('v46GoogleAccountNote');if(!note){note=document.createElement('div');note.id='v46GoogleAccountNote';note.style.cssText='margin-top:10px;padding:12px 14px;border:1px solid #ead9b8;border-radius:12px;background:#fffaf0;font-size:12px;line-height:1.5;color:#665c4c';select.closest('label')?.insertAdjacentElement('afterend',note)}return note}
async function patch(){if(busy)return;const select=$('#v44GoogleAccount');if(!select)return;busy=true;try{const data=await getAccounts();const manager=clean(data.managerCustomerId);const hierarchy=Array.isArray(data.hierarchy)?data.hierarchy:[];const names=new Map(hierarchy.map(a=>[clean(a.id),a.name||`Google Ads ${clean(a.id)}`]));const direct=(Array.isArray(data.direct)?data.direct:[]).map(clean).filter(Boolean);const existing=new Set([...select.options].map(o=>clean(o.value)).filter(Boolean));for(const id of direct){if(existing.has(id))continue;const o=document.createElement('option');o.value=id;o.textContent=`${names.get(id)|| (id===manager?'SiteRemade manager':'Accessible Google Ads account')} · ${fmt(id)}`;select.appendChild(o);existing.add(id)}
const usable=[...select.options].filter(o=>clean(o.value)&&clean(o.value)!==manager);const sig=usable.map(o=>o.value).join('|');const note=ensureNote(select);if(!usable.length){select.value='';select.disabled=true;select.options[0].textContent='No linked client ad accounts';note.innerHTML='<strong style="display:block;color:#2b2823;margin-bottom:4px">Google Ads is connected, but the manager has no client account linked yet.</strong>Your manager account is connected successfully. Link or create a client/test ad account under manager <b>'+fmt(manager)+'</b>, then click <b>Refresh accounts</b>. Manager accounts themselves cannot run campaigns, so SiteRemade will not treat the manager as a client account.';note.hidden=false;return}
select.disabled=false;if(select.options[0])select.options[0].textContent='Choose account…';note.hidden=true;if(!select.value&&usable.length===1&&sig!==lastSig){lastSig=sig;select.value=usable[0].value;select.dispatchEvent(new Event('change',{bubbles:true}))}
}catch(e){console.warn('Google Ads account fallback:',e.message)}finally{busy=false}}
// Main-thread hygiene pass: this used to schedule a real network fetch
// (patch() -> getAccounts()) 80ms after EVERY childList mutation anywhere
// in the document, as long as the select element existed anywhere in the
// DOM — meaning every 5-second live-refresh tick (or any other view's
// render) queued another Google Ads accounts request even while looking
// at Leads or Inbox. Not an infinite loop (patch()'s own busy flag
// prevents re-entry, and each individual call is cheap), just constant
// unnecessary background fetches. Gated to only act while the admin view
// is actually open, matching the same guard pattern used elsewhere.
function install(){setTimeout(patch,900);document.addEventListener('click',e=>{if(e.target?.id==='v44LoadAccounts'||e.target?.closest?.('[data-view="admin"]'))setTimeout(patch,1200)});new MutationObserver(()=>{if(!document.querySelector('#view-admin')?.classList.contains('active'))return;if($('#v44GoogleAccount'))setTimeout(patch,80)}).observe(document.documentElement,{subtree:true,childList:true})}
document.readyState==='loading'?document.addEventListener('DOMContentLoaded',install):install();
})();
