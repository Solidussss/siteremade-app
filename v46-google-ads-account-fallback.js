(()=>{
const $=s=>document.querySelector(s);
let busy=false,lastSig='';
const clean=v=>String(v||'').replace(/\D/g,'');
const fmt=id=>clean(id).replace(/(\d{3})(\d{3})(\d{4})/,'$1-$2-$3');
async function getAccounts(){const r=await fetch('/api/app/google-ads/accounts',{credentials:'same-origin'});let j={};try{j=await r.json()}catch{}if(!r.ok||j.ok===false)throw Error(j.message||`Google Ads accounts failed (${r.status})`);return j}
async function patch(){if(busy)return;const select=$('#v44GoogleAccount');if(!select)return;busy=true;try{const data=await getAccounts();const manager=clean(data.managerCustomerId);const hierarchy=Array.isArray(data.hierarchy)?data.hierarchy:[];const names=new Map(hierarchy.map(a=>[clean(a.id),a.name||`Google Ads ${clean(a.id)}`]));const direct=(Array.isArray(data.direct)?data.direct:[]).map(clean).filter(Boolean);const existing=new Set([...select.options].map(o=>clean(o.value)).filter(Boolean));for(const id of direct){if(existing.has(id))continue;const o=document.createElement('option');o.value=id;o.textContent=`${names.get(id)|| (id===manager?'SiteRemade manager':'Accessible Google Ads account')} · ${fmt(id)}`;select.appendChild(o);existing.add(id)}
const usable=[...select.options].filter(o=>clean(o.value)&&clean(o.value)!==manager);const sig=usable.map(o=>o.value).join('|');if(!select.value&&usable.length===1&&sig!==lastSig){lastSig=sig;select.value=usable[0].value;select.dispatchEvent(new Event('change',{bubbles:true}))}
}catch(e){console.warn('Google Ads account fallback:',e.message)}finally{busy=false}}
function install(){setTimeout(patch,900);document.addEventListener('click',e=>{if(e.target?.id==='v44LoadAccounts'||e.target?.closest?.('[data-view="admin"]'))setTimeout(patch,1200)});new MutationObserver(()=>{if($('#v44GoogleAccount'))setTimeout(patch,80)}).observe(document.documentElement,{subtree:true,childList:true})}
document.readyState==='loading'?document.addEventListener('DOMContentLoaded',install):install();
})();
