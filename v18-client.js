import('/v19-agency.js').catch(()=>{});
import('/v19-updates.js').catch(()=>{});
import('/v19-market.js').catch(()=>{});
const v29=document.createElement('script');v29.src='/v29-lead-fix.js?v=29';document.head.appendChild(v29);
document.documentElement.dataset.siteremadeV18='superseded-by-v19';

(function installGoogleLogin(){
  function addButton(){
    const form=document.querySelector('#loginForm');
    if(!form||document.querySelector('#googleSignInButton'))return;
    const intro=form.querySelector('p:not(.eyebrow)');
    const wrap=document.createElement('div');
    wrap.innerHTML=`<a id="googleSignInButton" href="/auth/google" style="width:100%;height:46px;border:1px solid #d9dde5;border-radius:999px;background:#fff;color:#17191d;text-decoration:none;display:flex;align-items:center;justify-content:center;gap:10px;font-size:12px;font-weight:750;margin:18px 0 12px;box-sizing:border-box"><svg viewBox="0 0 24 24" aria-hidden="true" style="width:18px;height:18px"><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.92h5.38a4.6 4.6 0 0 1-2 3.02v2.54h3.24c1.9-1.75 2.98-4.33 2.98-7.41Z"/><path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.36l-3.24-2.54c-.9.6-2.05.96-3.38.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.62A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.39 13.93A6.02 6.02 0 0 1 6.08 12c0-.67.11-1.32.31-1.93V7.45H3.04A10 10 0 0 0 2 12c0 1.61.39 3.14 1.04 4.55l3.35-2.62Z"/><path fill="#EA4335" d="M12 5.94c1.47 0 2.78.5 3.82 1.5l2.87-2.87A9.62 9.62 0 0 0 12 2a10 10 0 0 0-8.96 5.45l3.35 2.62C7.18 7.7 9.39 5.94 12 5.94Z"/></svg><span>Continue with Google</span></a><div style="display:flex;align-items:center;gap:10px;color:#9aa0aa;font-size:9px;margin:0 0 12px"><span style="height:1px;background:#e5e7eb;flex:1"></span><span style="text-transform:uppercase;letter-spacing:.12em">or</span><span style="height:1px;background:#e5e7eb;flex:1"></span></div>`;
    if(intro)intro.insertAdjacentElement('afterend',wrap);else form.prepend(wrap);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',addButton);else addButton();

  const q=new URLSearchParams(location.search);
  const authError=q.get('auth_error');
  if(authError){
    const show=()=>{const s=document.querySelector('#loginStatus');if(s){s.textContent=authError;s.style.color='#c54747'}};
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',show);else show();
    history.replaceState({},'',location.pathname);
    return;
  }
  if(q.get('google_oauth')!=='1')return;
  const h=new URLSearchParams(location.hash.replace(/^#/,''));
  const access_token=h.get('access_token'),refresh_token=h.get('refresh_token'),expires_in=Number(h.get('expires_in'))||3600;
  if(!access_token||!refresh_token)return;
  fetch('/api/auth/oauth-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({access_token,refresh_token,expires_in})})
    .then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok||d.ok===false)throw new Error(d.message||'Google sign-in failed.');history.replaceState({},'',location.pathname);location.reload();})
    .catch(err=>{const show=()=>{const s=document.querySelector('#loginStatus');if(s){s.textContent=err.message;s.style.color='#c54747'}};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',show);else show();});
})();
