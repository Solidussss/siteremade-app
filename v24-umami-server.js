// SiteRemade V24 — per-workspace Umami analytics bridge.
// Secrets stay server-side. Each workspace maps to its own Umami website via website_analytics.
const http=require('http');
const originalCreate=http.createServer;
const BASE=String(process.env.UMAMI_BASE_URL||'').replace(/\/$/,'');
const USER=process.env.UMAMI_USERNAME||'';
const PASS=process.env.UMAMI_PASSWORD||'';
let token='',tokenAt=0;

async function umamiToken(){
  if(token&&Date.now()-tokenAt<45*60*1000)return token;
  if(!BASE||!USER||!PASS)throw new Error('Umami is not configured');
  const r=await fetch(`${BASE}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:USER,password:PASS})});
  if(!r.ok)throw new Error(`Umami login failed (${r.status})`);
  const j=await r.json();token=j.token;tokenAt=Date.now();return token;
}
async function uget(path){const t=await umamiToken();const r=await fetch(`${BASE}${path}`,{headers:{authorization:`Bearer ${t}`,accept:'application/json'}});if(r.status===401){token='';return uget(path)}if(!r.ok)throw new Error(`Umami request failed (${r.status})`);return r.json()}
function json(res,status,data){res.statusCode=status;res.setHeader('content-type','application/json');res.end(JSON.stringify(data))}
function safePeriod(url){const days=Math.min(365,Math.max(1,Number(url.searchParams.get('days'))||30));const endAt=Date.now();return{days,endAt,startAt:endAt-days*86400000}}

// This module intentionally uses the app's existing authenticated /api/app route layer.
// v24-client requests /api/app/umami/analytics. server.js handles auth/workspace membership;
// a small route hook below only responds when req.siteRemadeWorkspaceId has been populated by the app.
http.createServer=function(handler,...rest){
  const wrapped=async(req,res)=>{
    try{
      const url=new URL(req.url,'http://local');
      if(req.method==='GET'&&url.pathname==='/api/app/umami/analytics'){
        // Defer until the core app exposes an authenticated workspace id. Never accept workspace ids from query/body.
        if(!req.siteRemadeWorkspaceId)return handler(req,res);
        const sb=req.siteRemadeSupabase;if(!sb)return json(res,503,{error:'Analytics workspace bridge unavailable'});
        const {data:row,error}=await sb.from('website_analytics').select('domain,provider,connected').eq('workspace_id',req.siteRemadeWorkspaceId).maybeSingle();
        if(error)throw error;
        const websiteId=String(row?.provider||'').startsWith('umami:')?String(row.provider).slice(6):'';
        if(!websiteId)return json(res,200,{connected:false,domain:row?.domain||'',reason:'No Umami website is linked to this workspace'});
        const {startAt,endAt,days}=safePeriod(url);const q=`startAt=${startAt}&endAt=${endAt}`;
        const [stats,series,active,pages,referrers,devices,countries]=await Promise.all([
          uget(`/api/websites/${websiteId}/stats?${q}`),uget(`/api/websites/${websiteId}/pageviews?${q}&unit=day`),uget(`/api/websites/${websiteId}/active`),
          uget(`/api/websites/${websiteId}/metrics?${q}&type=path&limit=8`),uget(`/api/websites/${websiteId}/metrics?${q}&type=referrer&limit=8`),
          uget(`/api/websites/${websiteId}/metrics?${q}&type=device&limit=8`),uget(`/api/websites/${websiteId}/metrics?${q}&type=country&limit=8`)
        ]);
        return json(res,200,{connected:true,domain:row?.domain||'',days,stats,series,active,pages,referrers,devices,countries});
      }
    }catch(e){if(!res.headersSent)return json(res,502,{error:e.message||'Analytics unavailable'});}
    return handler(req,res);
  };
  return originalCreate.call(http,wrapped,...rest);
};
