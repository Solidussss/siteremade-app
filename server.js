require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { createClient } = require('@supabase/supabase-js');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8080);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_SERVICE_ROLE_KEY);
const SITEREMADE_MONTHLY_PRICE_CENTS = Math.max(100, Number(process.env.SITEREMADE_MONTHLY_PRICE_CENTS || 25000));
const ADS_FEATURE_ENABLED = false; // V13: preserve ad data/code, but block new ad actions until integrations are ready.
const hasSiteRemadeAccess=c=>c.owner||['active','trialing'].includes(String(c.workspace?.siteremade_subscription_status||'inactive').toLowerCase());
const anon = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
const db = configured ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
const STATUSES = ['New','Contacted','Quoted','Won','Lost'];
const PAY = ['Draft','Pending','Paid','Void'];
const now = () => new Date().toISOString();
const clean = (v,n=2000) => String(v ?? '').trim().slice(0,n);
const signupAttempts=new Map();
function signupAllowed(req){const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim();const t=Date.now(),windowMs=3600000,max=5;const recent=(signupAttempts.get(ip)||[]).filter(x=>t-x<windowMs);if(recent.length>=max)return false;recent.push(t);signupAttempts.set(ip,recent);return true;}


function json(res,status,obj,cookies=[]){
  const body=JSON.stringify(obj);
  const h={'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store'};
  if(cookies.length) h['Set-Cookie']=cookies;
  res.writeHead(status,h); res.end(body);
}
function cookies(req){return Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim().split('=')).filter(x=>x[0]).map(([k,...v])=>[k,decodeURIComponent(v.join('='))]));}
function body(req){return new Promise((resolve,reject)=>{let s='';req.on('data',c=>{s+=c;if(s.length>1e6){reject(Error('Payload too large'));req.destroy();}});req.on('end',()=>{if(!s)return resolve({});try{resolve(JSON.parse(s))}catch{reject(Error('Invalid JSON'))}});req.on('error',reject);});}
function authCookies(session){const secure=process.env.NODE_ENV==='production'?'; Secure':'';return [
  `sr_access=${encodeURIComponent(session.access_token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(60,session.expires_in||3600)}${secure}`,
  `sr_refresh=${encodeURIComponent(session.refresh_token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`
];}
function clearAuthCookies(){return ['sr_access=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0','sr_refresh=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0','sr_workspace=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'];}
async function q(promise){const {data,error}=await promise;if(error)throw error;return data;}
async function getAuth(req,res){
  if(!configured) return null;
  const c=cookies(req); let access=c.sr_access; let user=null; let renewed=null;
  if(access){const r=await anon.auth.getUser(access); user=r.data?.user||null;}
  if(!user && c.sr_refresh){const r=await anon.auth.refreshSession({refresh_token:c.sr_refresh});if(!r.error&&r.data?.session){renewed=r.data.session;access=renewed.access_token;user=r.data.user;}}
  if(!user) return null;
  const profile=(await db.from('profiles').select('*').eq('id',user.id).maybeSingle()).data;
  if(!profile) return null;
  if(renewed) res.setHeader('Set-Cookie',authCookies(renewed));
  return {user,profile,access};
}
async function membershipsFor(userId,owner=false){
  if(owner) return await q(db.from('workspaces').select('*').order('created_at',{ascending:true}));
  const memberships=await q(db.from('workspace_members').select('workspace_id,workspaces(*)').eq('user_id',userId));
  return memberships.map(m=>m.workspaces).filter(Boolean);
}
function mapWorkspace(w){return {id:w.id,businessName:w.business_name,email:w.email,phone:w.phone,timezone:w.timezone,currency:w.currency,plan:w.plan,publicKey:w.public_key,stripeAccountId:w.stripe_account_id||'',siteRemadeCustomerId:w.siteremade_customer_id||'',siteRemadeSubscriptionId:w.siteremade_subscription_id||'',siteRemadeSubscriptionStatus:w.siteremade_subscription_status||'inactive',ai:{enabled:w.ai_enabled,services:w.ai_services,serviceArea:w.ai_service_area,tone:w.ai_tone}};}
function mapLead(l){return {id:l.id,name:l.name,email:l.email,phone:l.phone,service:l.service,source:l.source,status:l.status,value:Number(l.value)||0,message:l.message,notes:Array.isArray(l.notes)?l.notes:[],createdAt:l.created_at,updatedAt:l.updated_at};}
function mapConversation(c,messages=[]){return {id:c.id,leadId:c.lead_id,name:c.name,mode:c.mode,unread:c.unread,createdAt:c.created_at,updatedAt:c.updated_at,messages:messages.filter(m=>m.conversation_id===c.id).map(m=>({id:m.id,from:m.sender,text:m.text,createdAt:m.created_at}))};}
function mapAppointment(a){return {id:a.id,leadId:a.lead_id||'',title:a.title,customer:a.customer,start:a.start_at,duration:a.duration,status:a.status,notes:a.notes};}
function mapInvoice(i){return {id:i.id,leadId:i.lead_id||'',customer:i.customer,description:i.description,amount:Number(i.amount)||0,status:i.status,paymentUrl:i.payment_url||null,stripeSessionId:i.stripe_session_id||null,createdAt:i.created_at,paidAt:i.paid_at||null};}
function mapAutomation(a){return {id:a.automation_key,name:a.name,description:a.description,enabled:a.enabled};}
function mapActivity(a){return {id:a.id,type:a.type,title:a.title,detail:a.detail,createdAt:a.created_at};}
function mapAdSpend(a){return {id:a.id,platform:a.platform,campaign:a.campaign,spend:Number(a.spend)||0,leads:Number(a.leads)||0,source:a.source||'manual',createdAt:a.created_at};}
function mapAdFund(a){return {id:a.id,amount:Number(a.amount)||0,platform:a.platform||'Both',status:a.status,createdAt:a.created_at,fundedAt:a.funded_at||null};}
function mapWebsiteAnalytics(a){return a?{domain:a.domain||'',provider:a.provider||'google_analytics',connected:!!a.connected,sessions:Number(a.sessions)||0,users:Number(a.users)||0,pageviews:Number(a.pageviews)||0,lastSync:a.last_sync||null}:{domain:'',provider:'google_analytics',connected:false,sessions:0,users:0,pageviews:0,lastSync:null};}
function mapWebsiteUpdate(r){return {id:r.id,page:r.page,priority:r.priority,request:r.request,notes:r.notes||'',status:r.status,createdAt:r.created_at,updatedAt:r.updated_at};}
async function ctx(req,res,u){
  const a=await getAuth(req,res); if(!a)return null;
  const owner=a.profile.role==='owner'; const workspaces=await membershipsFor(a.user.id,owner); if(!workspaces.length)return null;
  const c=cookies(req); let wid=req.headers['x-workspace-id']||u.searchParams.get('workspaceId')||c.sr_workspace||workspaces[0].id;
  if(!workspaces.some(w=>w.id===wid))wid=workspaces[0].id;
  const workspace=workspaces.find(w=>w.id===wid);
  return {...a,owner,workspaces,wid,workspace};
}
async function activity(wid,type,title,detail){await db.from('activities').insert({workspace_id:wid,type,title,detail:clean(detail,1000)});}
async function audit(userId,wid,action,detail){await db.from('audit_logs').insert({user_id:userId,workspace_id:wid||null,action,detail:clean(detail,1000)});}
async function workspaceSnapshot(c){
  const [leads,convs,msgs,apps,invoices,autos,activities,adSpend,adFunds,prospectViews,websiteAnalytics,websiteUpdates] = await Promise.all([
    q(db.from('leads').select('*').eq('workspace_id',c.wid).order('created_at',{ascending:false})),
    q(db.from('conversations').select('*').eq('workspace_id',c.wid).order('updated_at',{ascending:false})),
    q(db.from('messages').select('*').eq('workspace_id',c.wid).order('created_at',{ascending:true})),
    q(db.from('appointments').select('*').eq('workspace_id',c.wid).order('start_at',{ascending:true})),
    q(db.from('invoices').select('*').eq('workspace_id',c.wid).order('created_at',{ascending:false})),
    q(db.from('automations').select('*').eq('workspace_id',c.wid).order('created_at',{ascending:true})),
    q(db.from('activities').select('*').eq('workspace_id',c.wid).order('created_at',{ascending:false}).limit(200)),
    q(db.from('ad_spend').select('*').eq('workspace_id',c.wid).order('created_at',{ascending:false}).limit(200)),
    q(db.from('ad_funds').select('*').eq('workspace_id',c.wid).order('created_at',{ascending:false}).limit(200)),
    q(db.from('prospect_views').select('place_id').eq('workspace_id',c.wid).limit(5000)),
    q(db.from('website_analytics').select('*').eq('workspace_id',c.wid).maybeSingle()),
    q(db.from('website_updates').select('*').eq('workspace_id',c.wid).order('created_at',{ascending:false}).limit(200))
  ]);
  return {workspace:mapWorkspace(c.workspace),workspaces:c.workspaces.map(mapWorkspace),user:{id:c.user.id,name:c.profile.name||c.user.email,email:c.user.email,role:c.profile.role},leads:leads.map(mapLead),conversations:convs.map(x=>mapConversation(x,msgs)),appointments:apps.map(mapAppointment),invoices:invoices.map(mapInvoice),automations:autos.map(mapAutomation),activities:activities.map(mapActivity),adSpend:adSpend.map(mapAdSpend),adFunds:adFunds.map(mapAdFund),prospectViews:prospectViews.map(x=>x.place_id),websiteAnalytics:mapWebsiteAnalytics(websiteAnalytics),websiteUpdates:websiteUpdates.map(mapWebsiteUpdate),billing:{monthlyCents:SITEREMADE_MONTHLY_PRICE_CENTS,status:c.workspace.siteremade_subscription_status||'inactive',customerId:c.workspace.siteremade_customer_id||'',subscriptionId:c.workspace.siteremade_subscription_id||''},integrations:{supabase:true,openai:!!process.env.OPENAI_API_KEY,resend:!!process.env.RESEND_API_KEY,twilio:!!process.env.TWILIO_ACCOUNT_SID,stripe:!!process.env.STRIPE_SECRET_KEY,googlePlaces:!!process.env.GOOGLE_PLACES_API_KEY,googleAds:!!process.env.GOOGLE_ADS_DEVELOPER_TOKEN,metaAds:!!process.env.META_ACCESS_TOKEN}};
}

async function businessAssistant(c,message){
  const [leads,apps,invoices,adSpend,convs]=await Promise.all([
    q(db.from('leads').select('*').eq('workspace_id',c.wid).order('created_at',{ascending:false}).limit(100)),
    q(db.from('appointments').select('*').eq('workspace_id',c.wid).order('start_at',{ascending:true}).limit(100)),
    q(db.from('invoices').select('*').eq('workspace_id',c.wid).order('created_at',{ascending:false}).limit(100)),
    q(db.from('ad_spend').select('*').eq('workspace_id',c.wid).order('created_at',{ascending:false}).limit(100)),
    q(db.from('conversations').select('*').eq('workspace_id',c.wid).order('updated_at',{ascending:false}).limit(50))
  ]);
  const collected=invoices.filter(i=>i.status==='Paid').reduce((s,i)=>s+Number(i.amount||0),0);
  const outstanding=invoices.filter(i=>i.status==='Pending').reduce((s,i)=>s+Number(i.amount||0),0);
  const spend=adSpend.reduce((s,a)=>s+Number(a.spend||0),0);
  const adLeads=adSpend.reduce((s,a)=>s+Number(a.leads||0),0);
  const upcoming=apps.filter(a=>new Date(a.start_at)>=new Date()).slice(0,10);
  const active=leads.filter(l=>!['Won','Lost'].includes(l.status));
  const stale=active.filter(l=>Date.now()-new Date(l.updated_at||l.created_at).getTime()>2*86400000).slice(0,12);
  const summary={business:c.workspace.business_name,leadCounts:Object.fromEntries(STATUSES.map(s=>[s,leads.filter(l=>l.status===s).length])),activeLeads:active.slice(0,25).map(l=>({name:l.name,service:l.service,status:l.status,value:l.value,source:l.source,updatedAt:l.updated_at})),staleLeads:stale.map(l=>({name:l.name,service:l.service,status:l.status,updatedAt:l.updated_at})),upcomingAppointments:upcoming.map(a=>({customer:a.customer,title:a.title,start:a.start_at})),collected,outstanding,adSpend:spend,adLeads,roas:spend?Number((collected/spend).toFixed(2)):null,conversations:convs.length};
  if(!process.env.OPENAI_API_KEY){
    const focus=stale.length?`Follow up with ${stale.slice(0,3).map(x=>x.name).join(', ')}.`:active.length?'Keep moving active leads toward a quote or booking.':'You have no active leads right now.';
    return {reply:`${leads.length} total leads · ${active.length} active · ${upcoming.length} upcoming bookings · $${collected.toFixed(0)} collected · $${outstanding.toFixed(0)} outstanding${spend?` · $${spend.toFixed(0)} ad spend`:''}.\n\n${focus}`,ai:false};
  }
  const system=`You are SiteRemade's business assistant for a small service business. Use ONLY the supplied workspace data. Be concise, practical and plain-language. Do not invent customers, revenue, bookings, ad results, or actions. You may recommend follow-ups and draft messages. If asked to perform an action, explain what the owner should click because this endpoint is advisory only. Workspace data: ${JSON.stringify(summary)}`;
  const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-4o-mini',messages:[{role:'system',content:system},{role:'user',content:clean(message,3000)}],temperature:.25})});
  if(!r.ok)throw Error('AI assistant could not connect.');
  const j=await r.json();
  return {reply:j.choices?.[0]?.message?.content?.trim()||'No answer returned.',ai:true};
}
async function searchPlaces(b,viewedIds=new Set()){
  if(!process.env.GOOGLE_PLACES_API_KEY)return {prospects:[],live:false};
  const purpose=['prospects','commercial','partners','competitors'].includes(clean(b.purpose,30))?clean(b.purpose,30):'prospects';
  const query=`${clean(b.businessType,120)} in ${clean(b.location,160)}`;
  const limit=Math.min(20,Math.max(1,Number(b.limit)||20));
  const r=await fetch('https://places.googleapis.com/v1/places:searchText',{method:'POST',headers:{'Content-Type':'application/json','X-Goog-Api-Key':process.env.GOOGLE_PLACES_API_KEY,'X-Goog-FieldMask':'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.googleMapsUri'},body:JSON.stringify({textQuery:query,pageSize:20})});
  if(!r.ok){const t=await r.text();console.error('Places:',t);throw Error('Market Finder could not connect to Google Places.');}
  const j=await r.json();
  const minRating=b.minRating===''||b.minRating==null?null:Number(b.minRating),maxRating=b.maxRating===''||b.maxRating==null?null:Number(b.maxRating);
  const minReviews=b.minReviews===''||b.minReviews==null?null:Math.max(0,Number(b.minReviews)),maxReviews=b.maxReviews===''||b.maxReviews==null?null:Math.max(0,Number(b.maxReviews));
  const website=clean(b.website,10)||'any',phone=clean(b.phone,10)||'any',newOnly=String(b.newOnly||'').toLowerCase()==='true';
  let prospects=(j.places||[]).map(x=>({placeId:x.id||'',name:x.displayName?.text||'Business',address:x.formattedAddress||'',phone:x.nationalPhoneNumber||'',website:x.websiteUri||'',rating:x.rating??null,reviews:Number(x.userRatingCount||0),mapsUrl:x.googleMapsUri||'',viewed:viewedIds.has(x.id||''),purpose}));
  prospects=prospects.filter(x=>{
    if(minRating!=null&&(x.rating==null||Number(x.rating)<minRating))return false;
    if(maxRating!=null&&(x.rating==null||Number(x.rating)>maxRating))return false;
    if(minReviews!=null&&x.reviews<minReviews)return false;
    if(maxReviews!=null&&x.reviews>maxReviews)return false;
    if(website==='yes'&&!x.website)return false;if(website==='no'&&x.website)return false;
    if(phone==='yes'&&!x.phone)return false;if(newOnly&&x.viewed)return false;
    return true;
  });
  const sort=clean(b.sort,30)||'relevance';
  if(sort==='reviews_desc')prospects.sort((a,z)=>z.reviews-a.reviews);
  if(sort==='reviews_asc')prospects.sort((a,z)=>a.reviews-z.reviews);
  if(sort==='rating_desc')prospects.sort((a,z)=>(z.rating??-1)-(a.rating??-1));
  if(sort==='rating_asc')prospects.sort((a,z)=>(a.rating??99)-(z.rating??99));
  return {prospects:prospects.slice(0,limit),live:true,purpose};
}
async function automationEnabled(wid,key){
  const {data,error}=await db.from('automations').select('enabled').eq('workspace_id',wid).eq('automation_key',key).maybeSingle();
  if(error)throw error;return data?.enabled===true;
}
async function processAppointmentReminders(){
  if(!configured)return;
  try{
    const autos=await q(db.from('automations').select('workspace_id').eq('automation_key','appointment-reminder').eq('enabled',true));
    if(!autos.length)return;
    const wids=autos.map(a=>a.workspace_id);
    const start=new Date(Date.now()+23*3600000).toISOString(),end=new Date(Date.now()+24*3600000+15*60000).toISOString();
    const apps=await q(db.from('appointments').select('*').in('workspace_id',wids).is('reminder_sent_at',null).gte('start_at',start).lte('start_at',end));
    for(const a of apps){
      const w=(await db.from('workspaces').select('*').eq('id',a.workspace_id).maybeSingle()).data;
      const lead=a.lead_id?(await db.from('leads').select('*').eq('id',a.lead_id).maybeSingle()).data:null;
      const when=new Date(a.start_at).toLocaleString('en-CA',{dateStyle:'medium',timeStyle:'short'});
      const text=`Reminder: ${a.title} is scheduled for ${when}.`;
      await activity(a.workspace_id,'appointment','Appointment reminder',`${a.customer} · ${when}`);
      if(lead?.email)notify(`Appointment reminder — ${w?.business_name||'Your appointment'}`,text,lead.email);
      if(lead?.phone)sms(lead.phone,`${w?.business_name||'Appointment'}: ${text}`);
      await db.from('appointments').update({reminder_sent_at:now()}).eq('id',a.id);
    }
  }catch(e){console.error('Appointment reminder worker:',e.message)}
}

async function externalAI(workspace,messages){
  if(!process.env.OPENAI_API_KEY)return null;
  const prompt=`You are the AI receptionist for ${workspace.business_name}. Services: ${workspace.ai_services||'not specified'}. Service area: ${workspace.ai_service_area||'not specified'}. Tone/instructions: ${workspace.ai_tone||'Helpful, concise, professional'}. Your job is to qualify real customer inquiries. Ask one useful question at a time and naturally collect: the service/job needed, location, urgency, preferred timing, and enough contact information for the business to follow up. Never invent prices, availability, discounts, policies, guarantees, or facts that were not supplied. If asked for a price, say the business can provide a quote after getting the job details. If asked to book, collect the preferred day/time and explain that the business will confirm it unless a confirmed booking is already present in the conversation. Keep replies short and human.`;
  const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-4o-mini',messages:[{role:'system',content:prompt},...messages.slice(-10).map(m=>({role:m.sender==='customer'?'user':'assistant',content:m.text}))],temperature:.3})});
  if(!r.ok)return null;const j=await r.json();return j.choices?.[0]?.message?.content?.trim()||null;
}
function localAI(w,text){const t=text.toLowerCase();if(/price|cost|how much/.test(t))return 'I can help get you a quote. What service do you need and what area is the job in?';if(/book|appointment|available|when/.test(t))return 'Absolutely. What day and time generally works best for you?';return `Thanks for reaching out to ${w.business_name}. Can you tell me a little more about the job and what area you're in?`;}
async function notify(subject,text,to){if(!process.env.RESEND_API_KEY||!to)return;try{await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.RESEND_FROM||'SiteRemade <hello@siteremade.com>',to:[to],subject,html:`<p>${clean(text,4000).replace(/[&<>]/g,'')}</p>`})});}catch(e){console.error('Resend:',e.message)}}
async function sms(to,text){if(!process.env.TWILIO_ACCOUNT_SID||!process.env.TWILIO_AUTH_TOKEN||!process.env.TWILIO_FROM||!to)return;try{const form=new URLSearchParams({To:to,From:process.env.TWILIO_FROM,Body:text});await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,{method:'POST',headers:{Authorization:'Basic '+Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:form});}catch(e){console.error('Twilio:',e.message)}}
async function stripeRequest(endpoint,params={},accountId=''){if(!process.env.STRIPE_SECRET_KEY)throw Error('Stripe is not configured.');const r=await fetch('https://api.stripe.com/v1/'+endpoint,{method:'POST',headers:{Authorization:`Bearer ${process.env.STRIPE_SECRET_KEY}`,'Content-Type':'application/x-www-form-urlencoded',...(accountId?{'Stripe-Account':accountId}:{})},body:new URLSearchParams(params)});const j=await r.json();if(!r.ok)throw Error(j.error?.message||'Stripe request failed');return j;}
async function stripeGet(endpoint,accountId=''){if(!process.env.STRIPE_SECRET_KEY)throw Error('Stripe is not configured.');const r=await fetch('https://api.stripe.com/v1/'+endpoint,{headers:{Authorization:`Bearer ${process.env.STRIPE_SECRET_KEY}`,...(accountId?{'Stripe-Account':accountId}:{})}});const j=await r.json();if(!r.ok)throw Error(j.error?.message||'Stripe request failed');return j;}
async function ensureSiteRemadeCustomer(c){
  if(c.workspace.siteremade_customer_id)return c.workspace.siteremade_customer_id;
  const customer=await stripeRequest('customers',{email:c.workspace.email||c.user.email||'',name:c.workspace.business_name,'metadata[workspaceId]':c.wid});
  await q(db.from('workspaces').update({siteremade_customer_id:customer.id}).eq('id',c.wid).select('id').single());
  c.workspace.siteremade_customer_id=customer.id;
  return customer.id;
}

async function validPublicWorkspace(b){const wid=clean(b.workspaceId,80),key=clean(b.publicKey,120);if(!wid||!key)return null;const {data}=await db.from('workspaces').select('*').eq('id',wid).eq('public_key',key).maybeSingle();return data||null;}

async function api(req,res,u){
  const p=u.pathname,m=req.method;
  if(p==='/api/system/status'&&m==='GET') return json(res,200,{ok:true,supabaseConfigured:configured});
  if(!configured) return json(res,503,{ok:false,message:'Supabase is not configured yet. Copy .env.example to .env and add your Supabase keys.'});

  if(m==='POST'&&p==='/api/auth/signup'){
    if(!signupAllowed(req))return json(res,429,{ok:false,message:'Too many account creation attempts. Try again later.'});
    const b=await body(req),name=clean(b.name,120),businessName=clean(b.businessName,160),email=clean(b.email,254).toLowerCase(),phone=clean(b.phone,80),password=clean(b.password,500),services=clean(b.services,1500),serviceArea=clean(b.serviceArea,800);
    if(!name||!businessName||!email||!password)return json(res,400,{ok:false,message:'Name, business name, email and password are required.'});
    if(password.length<8)return json(res,400,{ok:false,message:'Password must be at least 8 characters.'});
    let userId=null,wid=null;
    try{
      const made=await db.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{name}});
      if(made.error)throw made.error;userId=made.data.user.id;
      await q(db.from('profiles').upsert({id:userId,name,role:'client'}));
      const w=await q(db.from('workspaces').insert({business_name:businessName,email,phone,timezone:'America/Edmonton',currency:'CAD',plan:'Growth',ai_enabled:true,ai_services:services,ai_service_area:serviceArea,ai_tone:'Helpful, concise, professional'}).select('*').single());wid=w.id;
      await q(db.from('workspace_members').insert({workspace_id:wid,user_id:userId,role:'admin'}));
      await q(db.from('automations').insert([
        {workspace_id:wid,automation_key:'lead-confirmation',name:'Instant lead confirmation',description:'When a new lead arrives → create/send a confirmation.',enabled:true},
        {workspace_id:wid,automation_key:'lead-alert',name:'New lead alert',description:'When a lead arrives → notify the business immediately.',enabled:true},
        {workspace_id:wid,automation_key:'appointment-reminder',name:'Appointment reminder',description:'24 hours before appointment → create a reminder.',enabled:true}
      ]));
      const signed=await anon.auth.signInWithPassword({email,password});if(signed.error||!signed.data.session)throw signed.error||Error('Account created but sign-in failed.');
      const cs=authCookies(signed.data.session);cs.push(`sr_workspace=${encodeURIComponent(wid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
      await audit(userId,wid,'account.signup',email);
      return json(res,201,{ok:true,user:{name,email,role:'client'},workspace:mapWorkspace(w)},cs);
    }catch(e){
      if(wid)await db.from('workspaces').delete().eq('id',wid);
      if(userId)await db.auth.admin.deleteUser(userId).catch(()=>{});
      const msg=String(e?.message||'Could not create account.');
      return json(res,400,{ok:false,message:/already|registered|exists/i.test(msg)?'An account with that email already exists.':msg});
    }
  }

  if(m==='POST'&&p==='/api/auth/login'){
    const b=await body(req);const {data,error}=await anon.auth.signInWithPassword({email:clean(b.email,254),password:clean(b.password,500)});
    if(error||!data.session)return json(res,401,{ok:false,message:'Invalid email or password.'});
    const profile=(await db.from('profiles').select('*').eq('id',data.user.id).maybeSingle()).data;
    if(!profile){await anon.auth.signOut();return json(res,403,{ok:false,message:'This account has no SiteRemade profile.'});}
    const ws=await membershipsFor(data.user.id,profile.role==='owner');
    if(!ws.length)return json(res,403,{ok:false,message:'This account has no workspace access.'});
    const cs=authCookies(data.session);cs.push(`sr_workspace=${encodeURIComponent(ws[0].id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    return json(res,200,{ok:true,user:{name:profile.name,email:data.user.email,role:profile.role}},cs);
  }
  if(m==='POST'&&p==='/api/auth/logout'){return json(res,200,{ok:true},clearAuthCookies());}
  if(m==='GET'&&p==='/api/auth/me'){const a=await getAuth(req,res);return a?json(res,200,{ok:true,user:{name:a.profile.name,email:a.user.email,role:a.profile.role}}):json(res,401,{ok:false,message:'Not signed in.'});}

  if(m==='POST'&&p==='/api/public/lead'){
    const b=await body(req),w=await validPublicWorkspace(b);if(!w)return json(res,404,{ok:false,message:'Workspace not found or public key invalid.'});
    const name=clean(b.name,120);if(!name)return json(res,400,{ok:false,message:'Name required.'});
    const lead=await q(db.from('leads').insert({workspace_id:w.id,name,email:clean(b.email,254),phone:clean(b.phone,80),service:clean(b.service||'General inquiry',160),source:clean(b.source||'Website',80),status:'New',value:Math.max(0,Number(b.value)||0),message:clean(b.message,4000),notes:[]}).select('*').single());
    const autos=await q(db.from('automations').select('*').eq('workspace_id',w.id));
    if(autos.some(a=>a.automation_key==='lead-alert'&&a.enabled)){await activity(w.id,'lead','New website inquiry',`${lead.name} · ${lead.service}`);notify(`New lead — ${lead.name}`,`${lead.name} requested ${lead.service}. ${lead.phone||lead.email||''}`,w.email);sms(w.phone,`SiteRemade: New lead — ${lead.name} · ${lead.service}`);}
    if(autos.some(a=>a.automation_key==='lead-confirmation'&&a.enabled)){
      const cv=await q(db.from('conversations').insert({workspace_id:w.id,lead_id:lead.id,name:lead.name,mode:'ai',unread:0}).select('*').single());
      const text=`Thanks for reaching out to ${w.business_name}. We received your request and will follow up shortly.`;
      await db.from('messages').insert({workspace_id:w.id,conversation_id:cv.id,sender:'ai',text});notify('We received your request',text,lead.email);
    }
    return json(res,201,{ok:true,leadId:lead.id});
  }
  if(m==='POST'&&p==='/api/public/chat'){
    const b=await body(req),w=await validPublicWorkspace(b);if(!w)return json(res,404,{ok:false,message:'Workspace not found or public key invalid.'});const text=clean(b.text,4000);if(!text)return json(res,400,{ok:false,message:'Message required.'});
    let lead=null;if(b.leadId){lead=(await db.from('leads').select('*').eq('id',clean(b.leadId,80)).eq('workspace_id',w.id).maybeSingle()).data;}
    const visitorName=clean(b.name,120),visitorEmail=clean(b.email,254),visitorPhone=clean(b.phone,80);
    if(!lead)lead=await q(db.from('leads').insert({workspace_id:w.id,name:visitorName||'Website visitor',email:visitorEmail,phone:visitorPhone,service:clean(b.service||'Website chat',160),source:'AI Chat',status:'New',value:0,message:'',notes:[]}).select('*').single());
    else if(visitorName||visitorEmail||visitorPhone){const patch={updated_at:now()};if(visitorName&&lead.name==='Website visitor')patch.name=visitorName;if(visitorEmail&&!lead.email)patch.email=visitorEmail;if(visitorPhone&&!lead.phone)patch.phone=visitorPhone;const updated=await q(db.from('leads').update(patch).eq('id',lead.id).eq('workspace_id',w.id).select('*').single());lead=updated;}
    let cv=(await db.from('conversations').select('*').eq('workspace_id',w.id).eq('lead_id',lead.id).maybeSingle()).data;
    if(!cv)cv=await q(db.from('conversations').insert({workspace_id:w.id,lead_id:lead.id,name:lead.name,mode:'ai',unread:1}).select('*').single());
    await db.from('messages').insert({workspace_id:w.id,conversation_id:cv.id,sender:'customer',text});
    const history=await q(db.from('messages').select('*').eq('conversation_id',cv.id).order('created_at',{ascending:true}));
    let reply=w.ai_enabled?await externalAI(w,history).catch(()=>null):null;if(!reply)reply=w.ai_enabled?localAI(w,text):`Thanks for reaching out to ${w.business_name}. Your message has been received and the team will follow up.`;
    await db.from('messages').insert({workspace_id:w.id,conversation_id:cv.id,sender:'ai',text:reply});
    await db.from('conversations').update({unread:1,updated_at:now()}).eq('id',cv.id).eq('workspace_id',w.id);
    await activity(w.id,'message','AI chat activity',`${lead.name} · ${text.slice(0,60)}`);
    return json(res,200,{ok:true,leadId:lead.id,conversationId:cv.id,reply});
  }

  if(m==='POST'&&p==='/api/webhooks/stripe'){
    if(!process.env.STRIPE_WEBHOOK_SECRET)return json(res,503,{ok:false,message:'Stripe webhook is not configured.'});
    const raw=await new Promise((resolve,reject)=>{let z='';req.on('data',c=>z+=c);req.on('end',()=>resolve(z));req.on('error',reject)});
    {const sig=req.headers['stripe-signature']||'',parts=Object.fromEntries(sig.split(',').map(v=>v.split('='))),expected=crypto.createHmac('sha256',process.env.STRIPE_WEBHOOK_SECRET).update(`${parts.t}.${raw}`).digest('hex');if(!parts.v1||!parts.t||expected.length!==parts.v1.length||!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(parts.v1)))return json(res,400,{ok:false,message:'Invalid signature.'});}
    let ev;try{ev=JSON.parse(raw)}catch{return json(res,400,{ok:false,message:'Invalid webhook.'})}
    const obj=ev.data?.object||{};
    if(ev.type==='checkout.session.completed'){
      const meta=obj.metadata||{};
      if(meta.kind==='ad_fund'&&meta.workspaceId&&meta.fundingId){
        await db.from('ad_funds').update({status:'Funded',funded_at:now(),stripe_session_id:obj.id}).eq('id',meta.fundingId).eq('workspace_id',meta.workspaceId);
        await activity(meta.workspaceId,'ads','Ad funds added',`$${(Number(obj.amount_total||0)/100).toFixed(2)} available for advertising`);
      }else if(meta.kind==='subscription'&&meta.workspaceId){
        await db.from('workspaces').update({siteremade_customer_id:obj.customer||null,siteremade_subscription_id:obj.subscription||null,siteremade_subscription_status:'active'}).eq('id',meta.workspaceId);
        await activity(meta.workspaceId,'payment','SiteRemade subscription active','Monthly SiteRemade billing started');
      }else if(meta.workspaceId&&meta.invoiceId){
        const inv=(await db.from('invoices').select('*').eq('id',meta.invoiceId).eq('workspace_id',meta.workspaceId).maybeSingle()).data;if(inv){await db.from('invoices').update({status:'Paid',paid_at:now()}).eq('id',inv.id);await activity(meta.workspaceId,'payment','Payment received',`${inv.customer} · $${Number(inv.amount).toFixed(2)}`);}
      }
    }
    if(ev.type==='customer.subscription.updated'||ev.type==='customer.subscription.deleted'){
      const wid=obj.metadata?.workspaceId;if(wid)await db.from('workspaces').update({siteremade_subscription_id:obj.id||null,siteremade_customer_id:obj.customer||null,siteremade_subscription_status:obj.status||'inactive'}).eq('id',wid);
    }
    if(ev.type==='invoice.payment_failed'){
      const subId=obj.subscription;if(subId)await db.from('workspaces').update({siteremade_subscription_status:'past_due'}).eq('siteremade_subscription_id',subId);
    }
    if(ev.type==='invoice.paid'){
      const subId=obj.subscription;if(subId)await db.from('workspaces').update({siteremade_subscription_status:'active'}).eq('siteremade_subscription_id',subId);
    }
    return json(res,200,{ok:true});
  }

  const c=await ctx(req,res,u);if(!c)return json(res,401,{ok:false,message:'Authentication required.'});
  if(m==='GET'&&p==='/api/app/bootstrap'){
    if(!hasSiteRemadeAccess(c))return json(res,200,{ok:true,locked:true,workspace:mapWorkspace(c.workspace),workspaces:c.workspaces.map(mapWorkspace),user:{id:c.user.id,name:c.user.name,role:c.user.role},billing:{monthlyCents:SITEREMADE_MONTHLY_PRICE_CENTS,status:c.workspace.siteremade_subscription_status||'inactive',customerId:c.workspace.siteremade_customer_id||'',subscriptionId:c.workspace.siteremade_subscription_id||''},integrations:{stripe:!!process.env.STRIPE_SECRET_KEY},leads:[],conversations:[],appointments:[],invoices:[],automations:[],activities:[],adSpend:[],adFunds:[],websiteUpdates:[]});
    return json(res,200,{ok:true,locked:false,...await workspaceSnapshot(c)});
  }
  if(m==='POST'&&p==='/api/app/workspaces/switch'){const b=await body(req),wid=clean(b.workspaceId,80);if(!c.workspaces.some(w=>w.id===wid))return json(res,403,{ok:false,message:'No access.'});return json(res,200,{ok:true},[`sr_workspace=${encodeURIComponent(wid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`]);}
  // V11: unpaid clients are blocked before ANY business feature route.
  // Only billing recovery / activation endpoints remain available.
  if(!hasSiteRemadeAccess(c)){
    if(m==='GET'&&p==='/api/app/checkout/confirm'){
      try{
        const sid=clean(u.searchParams.get('sessionId'),200);if(!sid)return json(res,400,{ok:false,message:'Missing checkout session.'});
        const session=await stripeGet('checkout/sessions/'+encodeURIComponent(sid));
        if(session.payment_status!=='paid'&&session.status!=='complete')return json(res,400,{ok:false,message:'Checkout is not complete yet.'});
        const meta=session.metadata||{};if(meta.workspaceId!==c.wid)return json(res,403,{ok:false,message:'Checkout does not belong to this workspace.'});
        if(meta.kind==='subscription'){await db.from('workspaces').update({siteremade_customer_id:session.customer||null,siteremade_subscription_id:session.subscription||null,siteremade_subscription_status:'active'}).eq('id',c.wid);}
        return json(res,200,{ok:true,kind:meta.kind||''});
      }catch(e){return json(res,400,{ok:false,message:e.message});}
    }
    if(m==='POST'&&p==='/api/app/billing/subscription/start'){
      try{
        const customer=await ensureSiteRemadeCustomer(c),base=process.env.PUBLIC_BASE_URL||'http://localhost:'+PORT;
        const session=await stripeRequest('checkout/sessions',{customer,'line_items[0][price_data][currency]':(c.workspace.currency||'cad').toLowerCase(),'line_items[0][price_data][product_data][name]':'SiteRemade Growth','line_items[0][price_data][unit_amount]':String(SITEREMADE_MONTHLY_PRICE_CENTS),'line_items[0][price_data][recurring][interval]':'month','line_items[0][quantity]':'1',mode:'subscription',success_url:base+'/?billing=success&session_id={CHECKOUT_SESSION_ID}',cancel_url:base+'/?billing=canceled','metadata[kind]':'subscription','metadata[workspaceId]':c.wid,'subscription_data[metadata][workspaceId]':c.wid});
        return json(res,200,{ok:true,url:session.url});
      }catch(e){return json(res,400,{ok:false,message:e.message});}
    }
    if(m==='POST'&&p==='/api/app/billing/portal'){
      try{const customer=await ensureSiteRemadeCustomer(c),base=process.env.PUBLIC_BASE_URL||'http://localhost:'+PORT;const portal=await stripeRequest('billing_portal/sessions',{customer,return_url:base+'/?billing=return'});return json(res,200,{ok:true,url:portal.url});}catch(e){return json(res,400,{ok:false,message:e.message});}
    }
    return json(res,402,{ok:false,code:'SUBSCRIPTION_REQUIRED',message:'An active SiteRemade subscription is required to use this feature.'});
  }
  if(m==='POST'&&p==='/api/app/workspaces'){
    if(!c.owner)return json(res,403,{ok:false,message:'Owner only.'});const b=await body(req);const w=await q(db.from('workspaces').insert({business_name:clean(b.businessName,160)||'New Business',email:clean(b.email,254),phone:'',timezone:'America/Edmonton',currency:'CAD',plan:'Growth',ai_enabled:true,ai_services:'',ai_service_area:'',ai_tone:'Helpful, concise, professional'}).select('*').single());
    await db.from('workspace_members').insert({workspace_id:w.id,user_id:c.user.id,role:'owner'});
    await db.from('automations').insert([
      {workspace_id:w.id,automation_key:'lead-confirmation',name:'Instant lead confirmation',description:'When a new lead arrives → create/send a confirmation.',enabled:true},
      {workspace_id:w.id,automation_key:'lead-alert',name:'New lead alert',description:'When a lead arrives → notify the business immediately.',enabled:true},
      {workspace_id:w.id,automation_key:'appointment-reminder',name:'Appointment reminder',description:'24 hours before appointment → create a reminder.',enabled:true}
    ]);await audit(c.user.id,w.id,'workspace.create',w.business_name);return json(res,201,{ok:true,workspace:mapWorkspace(w)});
  }
  if(m==='POST'&&p==='/api/app/users'){
    if(!c.owner)return json(res,403,{ok:false,message:'Owner only.'});const b=await body(req),email=clean(b.email,254).toLowerCase(),password=clean(b.password,500),wid=clean(b.workspaceId,80)||c.wid;if(!email||!password)return json(res,400,{ok:false,message:'Email and temporary password are required.'});if(!c.workspaces.some(w=>w.id===wid))return json(res,403,{ok:false,message:'No access to workspace.'});
    const made=await db.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{name:clean(b.name,120)||email}});if(made.error)return json(res,400,{ok:false,message:made.error.message});const u2=made.data.user;await db.from('profiles').upsert({id:u2.id,name:clean(b.name,120)||email,role:b.role==='owner'?'owner':'client'});await db.from('workspace_members').upsert({workspace_id:wid,user_id:u2.id,role:b.role==='owner'?'owner':'admin'});await audit(c.user.id,wid,'user.create',email);return json(res,201,{ok:true,user:{id:u2.id,name:clean(b.name,120)||email,email,role:b.role==='owner'?'owner':'client'}});
  }

  if(m==='POST'&&p==='/api/app/assistant'){const b=await body(req),message=clean(b.message,3000);if(!message)return json(res,400,{ok:false,message:'Ask a question first.'});const result=await businessAssistant(c,message);return json(res,200,{ok:true,...result});}
  let x;
  if(m==='POST'&&p==='/api/app/website-updates'){
    const b=await body(req),page=clean(b.page,80)||'Other',priority=['Normal','Important'].includes(clean(b.priority,30))?clean(b.priority,30):'Normal',request=clean(b.request,4000),notes=clean(b.notes,4000);
    if(!request)return json(res,400,{ok:false,message:'Describe the website change you want.'});
    const row=await q(db.from('website_updates').insert({workspace_id:c.wid,page,priority,request,notes,status:'Requested'}).select('*').single());
    await activity(c.wid,'website','Website update requested',`${page} · ${request.slice(0,120)}`);
    return json(res,201,{ok:true,websiteUpdate:mapWebsiteUpdate(row)});
  }
  x=p.match(/^\/api\/app\/website-updates\/([^/]+)$/);if(x&&m==='PATCH'){
    if(!c.owner)return json(res,403,{ok:false,message:'Only SiteRemade can change update-request status.'});
    const b=await body(req),status=clean(b.status,40);if(!['Requested','In Progress','Completed'].includes(status))return json(res,400,{ok:false,message:'Invalid update status.'});
    const row=await q(db.from('website_updates').update({status,updated_at:now()}).eq('id',x[1]).eq('workspace_id',c.wid).select('*').single());
    await activity(c.wid,'website','Website update status changed',`${row.page} · ${status}`);
    return json(res,200,{ok:true,websiteUpdate:mapWebsiteUpdate(row)});
  }
  if(m==='POST'&&p==='/api/app/prospects/search'){const b=await body(req);if(!clean(b.businessType,120)||!clean(b.location,160))return json(res,400,{ok:false,message:'Business type and location are required.'});const viewed=await q(db.from('prospect_views').select('place_id').eq('workspace_id',c.wid).limit(5000));const result=await searchPlaces(b,new Set(viewed.map(x=>x.place_id)));return json(res,200,{ok:true,...result});}
  if(m==='POST'&&p==='/api/app/prospects/viewed'){const b=await body(req),placeId=clean(b.placeId,220);if(!placeId)return json(res,400,{ok:false,message:'Google Place ID required.'});await q(db.from('prospect_views').upsert({workspace_id:c.wid,place_id:placeId,name:clean(b.name,200),website:clean(b.website,1000),viewed_at:now()},{onConflict:'workspace_id,place_id'}).select('*').single());return json(res,200,{ok:true});}
  if(m==='POST'&&p==='/api/app/analytics/website'){const b=await body(req),raw=clean(b.domain,1000);let domain='';try{if(raw){const candidate=/^https?:\/\//i.test(raw)?raw:'https://'+raw;domain=new URL(candidate).hostname.replace(/^www\./,'').toLowerCase();}}catch{}if(!domain)return json(res,400,{ok:false,message:'Enter a valid website domain.'});const row=await q(db.from('website_analytics').upsert({workspace_id:c.wid,domain,provider:'google_analytics',updated_at:now()},{onConflict:'workspace_id'}).select('*').single());return json(res,200,{ok:true,websiteAnalytics:mapWebsiteAnalytics(row)});}
  if(m==='POST'&&p==='/api/app/ad-spend'){if(!ADS_FEATURE_ENABLED)return json(res,503,{ok:false,message:'Google + Meta advertising is coming soon.'});if(!c.owner)return json(res,403,{ok:false,message:'Advertising performance is managed by SiteRemade.'});const b=await body(req),spend=Math.max(0,Number(b.spend)||0),leads=Math.max(0,Math.floor(Number(b.leads)||0));if(!spend)return json(res,400,{ok:false,message:'Spend must be greater than zero.'});const row=await q(db.from('ad_spend').insert({workspace_id:c.wid,platform:clean(b.platform,40)||'Other',campaign:clean(b.campaign,160)||'Campaign',spend,leads,source:'manual'}).select('*').single());await activity(c.wid,'ads','Ad spend recorded',`${row.platform} · ${row.campaign} · $${Number(row.spend).toFixed(2)}`);return json(res,201,{ok:true,adSpend:mapAdSpend(row)});}

  if(m==='GET'&&p==='/api/app/leads'){const rows=await q(db.from('leads').select('*').eq('workspace_id',c.wid).order('created_at',{ascending:false}));return json(res,200,{ok:true,leads:rows.map(mapLead)});}
  if(m==='POST'&&p==='/api/app/leads'){
const b=await body(req),name=clean(b.name,120);
if(!name)return json(res,400,{ok:false,message:'Customer name required.'});
const l=await q(db.from('leads').insert({workspace_id:c.wid,name,email:clean(b.email,254),phone:clean(b.phone,80),service:clean(b.service||'General inquiry',160),source:clean(b.source||'Manual',80),status:'New',value:Math.max(0,Number(b.value)||0),message:clean(b.message,4000),notes:[]}).select('*').single());
const autos=await q(db.from('automations').select('automation_key,enabled').eq('workspace_id',c.wid));
const leadAlertEnabled=autos.some(a=>a.automation_key==='lead-alert'&&a.enabled);
if(leadAlertEnabled)await activity(c.wid,'lead','New lead created',`${l.name} · ${l.service}`);
return json(res,201,{ok:true,lead:mapLead(l)});
}
  x=p.match(/^\/api\/app\/leads\/([^/]+)$/);
  if(x&&m==='PATCH'){const b=await body(req),old=(await db.from('leads').select('*').eq('id',x[1]).eq('workspace_id',c.wid).maybeSingle()).data;if(!old)return json(res,404,{ok:false,message:'Lead not found.'});if(b.status!==undefined&&!STATUSES.includes(b.status))return json(res,400,{ok:false,message:'Invalid status.'});const patch={updated_at:now()};for(const [js,sql,n] of [['name','name',120],['email','email',254],['phone','phone',80],['service','service',160],['source','source',80],['status','status',40],['message','message',4000]])if(b[js]!==undefined)patch[sql]=clean(b[js],n);if(b.value!==undefined)patch.value=Math.max(0,Number(b.value)||0);if(clean(b.note,1000))patch.notes=[clean(b.note,1000),...(Array.isArray(old.notes)?old.notes:[])];const updated=await q(db.from('leads').update(patch).eq('id',x[1]).eq('workspace_id',c.wid).select('*').single());if(updated.status!==old.status)await activity(c.wid,'status',`Lead moved to ${updated.status}`,`${updated.name} · ${updated.service}`);return json(res,200,{ok:true,lead:mapLead(updated)});}
  if(x&&m==='DELETE'){await db.from('leads').delete().eq('id',x[1]).eq('workspace_id',c.wid);await activity(c.wid,'delete','Lead deleted',x[1]);return json(res,200,{ok:true});}

  if(m==='POST'&&p==='/api/app/conversations'){const b=await body(req),l=(await db.from('leads').select('*').eq('id',clean(b.leadId,80)).eq('workspace_id',c.wid).maybeSingle()).data;if(!l)return json(res,404,{ok:false,message:'Lead not found.'});let cv=(await db.from('conversations').select('*').eq('workspace_id',c.wid).eq('lead_id',l.id).maybeSingle()).data;if(!cv)cv=await q(db.from('conversations').insert({workspace_id:c.wid,lead_id:l.id,name:l.name,mode:'human',unread:0}).select('*').single());const msgs=await q(db.from('messages').select('*').eq('conversation_id',cv.id).order('created_at',{ascending:true}));return json(res,201,{ok:true,conversation:mapConversation(cv,msgs)});}
  x=p.match(/^\/api\/app\/conversations\/([^/]+)$/);
  if(x&&m==='PATCH'){const b=await body(req),patch={};if(b.mode)patch.mode=b.mode==='ai'?'ai':'human';if(b.read)patch.unread=0;patch.updated_at=now();const cv=await q(db.from('conversations').update(patch).eq('id',x[1]).eq('workspace_id',c.wid).select('*').single());const msgs=await q(db.from('messages').select('*').eq('conversation_id',cv.id).order('created_at',{ascending:true}));return json(res,200,{ok:true,conversation:mapConversation(cv,msgs)});}
  x=p.match(/^\/api\/app\/conversations\/([^/]+)\/messages$/);
  if(x&&m==='POST'){const b=await body(req),cv=(await db.from('conversations').select('*').eq('id',x[1]).eq('workspace_id',c.wid).maybeSingle()).data;if(!cv)return json(res,404,{ok:false,message:'Conversation not found.'});const text=clean(b.text,4000);if(!text)return json(res,400,{ok:false,message:'Message empty.'});await db.from('messages').insert({workspace_id:c.wid,conversation_id:cv.id,sender:'business',text});await db.from('conversations').update({updated_at:now()}).eq('id',cv.id);await activity(c.wid,'message','Message sent',`${cv.name} · ${text.slice(0,60)}`);const lead=(await db.from('leads').select('*').eq('id',cv.lead_id).maybeSingle()).data;if(lead?.email)notify(`Message from ${c.workspace.business_name}`,text,lead.email);return json(res,201,{ok:true});}

  if(m==='POST'&&p==='/api/app/appointments'){const b=await body(req),st=new Date(b.start);if(Number.isNaN(st.getTime()))return json(res,400,{ok:false,message:'Valid date required.'});const lead=b.leadId?(await db.from('leads').select('*').eq('id',clean(b.leadId,80)).eq('workspace_id',c.wid).maybeSingle()).data:null;const a=await q(db.from('appointments').insert({workspace_id:c.wid,lead_id:lead?.id||null,title:clean(b.title,160)||'Appointment',customer:lead?.name||clean(b.customer,160),start_at:st.toISOString(),duration:Math.max(15,Number(b.duration)||60),status:'Booked',notes:clean(b.notes,1000)}).select('*').single());await activity(c.wid,'appointment','Appointment booked',`${a.customer} · ${a.title}`);return json(res,201,{ok:true,appointment:mapAppointment(a)});}
  x=p.match(/^\/api\/app\/appointments\/([^/]+)$/);if(x&&m==='DELETE'){await db.from('appointments').delete().eq('id',x[1]).eq('workspace_id',c.wid);return json(res,200,{ok:true});}

  if(m==='GET'&&p==='/api/app/checkout/confirm'){
    try{
      const sid=clean(u.searchParams.get('sessionId'),200);if(!sid)return json(res,400,{ok:false,message:'Missing checkout session.'});
      const session=await stripeGet('checkout/sessions/'+encodeURIComponent(sid));
      if(session.payment_status!=='paid'&&session.status!=='complete')return json(res,400,{ok:false,message:'Checkout is not complete yet.'});
      const meta=session.metadata||{};if(meta.workspaceId!==c.wid)return json(res,403,{ok:false,message:'Checkout does not belong to this workspace.'});
      if(meta.kind==='ad_fund'&&meta.fundingId){await db.from('ad_funds').update({status:'Funded',funded_at:now(),stripe_session_id:session.id}).eq('id',meta.fundingId).eq('workspace_id',c.wid);}
      if(meta.kind==='subscription'){await db.from('workspaces').update({siteremade_customer_id:session.customer||null,siteremade_subscription_id:session.subscription||null,siteremade_subscription_status:'active'}).eq('id',c.wid);}
      return json(res,200,{ok:true,kind:meta.kind||''});
    }catch(e){return json(res,400,{ok:false,message:e.message});}
  }
  if(m==='POST'&&p==='/api/app/billing/subscription/start'){
    try{
      const customer=await ensureSiteRemadeCustomer(c),base=process.env.PUBLIC_BASE_URL||'http://localhost:'+PORT;
      const session=await stripeRequest('checkout/sessions',{customer,'line_items[0][price_data][currency]':(c.workspace.currency||'cad').toLowerCase(),'line_items[0][price_data][product_data][name]':'SiteRemade Growth','line_items[0][price_data][unit_amount]':String(SITEREMADE_MONTHLY_PRICE_CENTS),'line_items[0][price_data][recurring][interval]':'month','line_items[0][quantity]':'1',mode:'subscription',success_url:base+'/?billing=success&session_id={CHECKOUT_SESSION_ID}',cancel_url:base+'/?billing=canceled','metadata[kind]':'subscription','metadata[workspaceId]':c.wid,'subscription_data[metadata][workspaceId]':c.wid});
      return json(res,200,{ok:true,url:session.url});
    }catch(e){return json(res,400,{ok:false,message:e.message});}
  }
  if(m==='POST'&&p==='/api/app/billing/portal'){
    try{const customer=await ensureSiteRemadeCustomer(c),base=process.env.PUBLIC_BASE_URL||'http://localhost:'+PORT;const portal=await stripeRequest('billing_portal/sessions',{customer,return_url:base+'/?billing=return'});return json(res,200,{ok:true,url:portal.url});}catch(e){return json(res,400,{ok:false,message:e.message});}
  }
  if(m==='POST'&&p==='/api/app/ad-funds'){
    if(!ADS_FEATURE_ENABLED)return json(res,503,{ok:false,message:'Google + Meta advertising is coming soon.'});
    const b=await body(req),amount=Math.max(0,Number(b.amount)||0),platform=['Google','Meta','Both'].includes(b.platform)?b.platform:'Both';
    if(amount<50)return json(res,400,{ok:false,message:'Minimum ad funding is $50.'});
    try{
      const fund=await q(db.from('ad_funds').insert({workspace_id:c.wid,amount,platform,status:'Pending'}).select('*').single()),base=process.env.PUBLIC_BASE_URL||'http://localhost:'+PORT,customer=await ensureSiteRemadeCustomer(c);
      const session=await stripeRequest('checkout/sessions',{customer,'line_items[0][price_data][currency]':(c.workspace.currency||'cad').toLowerCase(),'line_items[0][price_data][product_data][name]':`SiteRemade ${platform} advertising funds`,'line_items[0][price_data][unit_amount]':String(Math.round(amount*100)),'line_items[0][quantity]':'1',mode:'payment',success_url:base+'/?adfund=success&session_id={CHECKOUT_SESSION_ID}',cancel_url:base+'/?adfund=canceled','metadata[kind]':'ad_fund','metadata[workspaceId]':c.wid,'metadata[fundingId]':fund.id});
      await db.from('ad_funds').update({stripe_session_id:session.id}).eq('id',fund.id);
      return json(res,200,{ok:true,url:session.url,fund:mapAdFund(fund)});
    }catch(e){return json(res,400,{ok:false,message:e.message});}
  }

  if(m==='POST'&&p==='/api/app/invoices'){const b=await body(req),lead=(await db.from('leads').select('*').eq('id',clean(b.leadId,80)).eq('workspace_id',c.wid).maybeSingle()).data,amount=Math.max(0,Number(b.amount)||0);if(!lead||!amount)return json(res,400,{ok:false,message:'Customer and amount required.'});let inv=await q(db.from('invoices').insert({workspace_id:c.wid,lead_id:lead.id,customer:lead.name,description:clean(b.description,240)||'Invoice',amount,status:'Pending'}).select('*').single());if(process.env.STRIPE_SECRET_KEY){try{const j=await stripeRequest('checkout/sessions',{'line_items[0][price_data][currency]':(c.workspace.currency||'cad').toLowerCase(),'line_items[0][price_data][product_data][name]':inv.description,'line_items[0][price_data][unit_amount]':String(Math.round(amount*100)),'line_items[0][quantity]':'1','mode':'payment','success_url':`${process.env.PUBLIC_BASE_URL||'http://localhost:'+PORT}/?paid=1`,'cancel_url':`${process.env.PUBLIC_BASE_URL||'http://localhost:'+PORT}/?canceled=1`,'metadata[invoiceId]':inv.id,'metadata[workspaceId]':c.wid},c.workspace.stripe_account_id||'');inv=await q(db.from('invoices').update({payment_url:j.url||null,stripe_session_id:j.id||null}).eq('id',inv.id).select('*').single());}catch(e){console.error('Stripe invoice:',e.message)}}await activity(c.wid,'payment','Invoice created',`${inv.customer} · $${amount.toFixed(2)}`);return json(res,201,{ok:true,invoice:mapInvoice(inv)});}
  x=p.match(/^\/api\/app\/invoices\/([^/]+)$/);if(x&&m==='PATCH'){const b=await body(req);if(b.status&&!PAY.includes(b.status))return json(res,400,{ok:false,message:'Invalid status.'});const patch={};if(b.status){patch.status=b.status;if(b.status==='Paid')patch.paid_at=now();}const inv=await q(db.from('invoices').update(patch).eq('id',x[1]).eq('workspace_id',c.wid).select('*').single());return json(res,200,{ok:true,invoice:mapInvoice(inv)});}
  x=p.match(/^\/api\/app\/invoices\/([^/]+)$/);if(x&&m==='DELETE'){
    const invoiceId=x[1];
    const {data:inv,error:findError}=await db.from('invoices').select('*').eq('id',invoiceId).eq('workspace_id',c.wid).maybeSingle();
    if(findError)return json(res,500,{ok:false,message:findError.message||'Could not load invoice.'});
    if(!inv)return json(res,404,{ok:false,message:'Invoice not found.'});
    const {error:deleteError}=await db.from('invoices').delete().eq('id',invoiceId).eq('workspace_id',c.wid);
    if(deleteError)return json(res,500,{ok:false,message:deleteError.message||'Could not delete invoice.'});
    const stillThere=(await db.from('invoices').select('id').eq('id',invoiceId).eq('workspace_id',c.wid).maybeSingle()).data;
    if(stillThere)return json(res,500,{ok:false,message:'Invoice was not deleted. Please try again.'});
    activity(c.wid,'delete','Invoice deleted',`${inv.customer} · ${inv.description} · $${Number(inv.amount||0).toFixed(2)}`).catch(e=>console.error('Invoice delete activity:',e.message));
    return json(res,200,{ok:true,deletedId:invoiceId});
  }
  x=p.match(/^\/api\/app\/automations\/([^/]+)$/);if(x&&m==='PATCH'){const b=await body(req),a=await q(db.from('automations').update({enabled:!!b.enabled}).eq('workspace_id',c.wid).eq('automation_key',x[1]).select('*').single());return json(res,200,{ok:true,automation:mapAutomation(a)});}
  if(m==='PATCH'&&p==='/api/app/settings'){const b=await body(req),patch={};for(const [js,sql,n] of [['businessName','business_name',160],['email','email',254],['phone','phone',80],['timezone','timezone',100],['currency','currency',10],['services','ai_services',2000],['serviceArea','ai_service_area',1000],['tone','ai_tone',500]])if(b[js]!==undefined)patch[sql]=clean(b[js],n);const w=await q(db.from('workspaces').update(patch).eq('id',c.wid).select('*').single());return json(res,200,{ok:true,workspace:mapWorkspace(w)});}
  if(m==='POST'&&p==='/api/app/integrations/stripe/connect'){try{let account=c.workspace.stripe_account_id;if(!account){const acct=await stripeRequest('accounts',{type:'express',country:'CA','business_type':'company','metadata[workspaceId]':c.wid});account=acct.id;await db.from('workspaces').update({stripe_account_id:account}).eq('id',c.wid);}const base=process.env.PUBLIC_BASE_URL||'http://localhost:'+PORT;const link=await stripeRequest('account_links',{account,refresh_url:base+'/?stripe=refresh',return_url:base+'/?stripe=return',type:'account_onboarding'});return json(res,200,{ok:true,url:link.url,accountId:account});}catch(e){return json(res,400,{ok:false,message:e.message});}}
  if(m==='GET'&&p==='/api/app/admin'){if(!c.owner)return json(res,403,{ok:false,message:'Owner only.'});const [profiles,members,auditRows,allLeads,allSpend,allFunds]=await Promise.all([q(db.from('profiles').select('*').order('created_at',{ascending:true})),q(db.from('workspace_members').select('*')),q(db.from('audit_logs').select('*').order('created_at',{ascending:false}).limit(50)),q(db.from('leads').select('workspace_id')),q(db.from('ad_spend').select('workspace_id,spend')),q(db.from('ad_funds').select('workspace_id,amount,status'))]);const workspaces=c.workspaces.map(w=>({...mapWorkspace(w),leads:allLeads.filter(x=>x.workspace_id===w.id).length,adSpent:allSpend.filter(x=>x.workspace_id===w.id).reduce((s,x)=>s+Number(x.spend||0),0),adFunded:allFunds.filter(x=>x.workspace_id===w.id&&x.status==='Funded').reduce((s,x)=>s+Number(x.amount||0),0)}));return json(res,200,{ok:true,workspaces,users:profiles.map(p=>({id:p.id,name:p.name,role:p.role,workspaceIds:members.filter(m=>m.user_id===p.id).map(m=>m.workspace_id)})),audit:auditRows});}
  return json(res,404,{ok:false,message:'Not found.'});
}

function mime(f){return ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.sql':'text/plain; charset=utf-8'}[path.extname(f)]||'application/octet-stream');}
function serve(res,p){let rel=p==='/'?'index.html':decodeURIComponent(p.slice(1));const f=path.normalize(path.join(ROOT,rel));if(!f.startsWith(ROOT)||!fs.existsSync(f)||!fs.statSync(f).isFile())return false;res.writeHead(200,{'Content-Type':mime(f),'Cache-Control':rel==='index.html'?'no-store':'public,max-age=300'});fs.createReadStream(f).pipe(res);return true;}

setInterval(processAppointmentReminders,15*60*1000).unref();
setTimeout(processAppointmentReminders,5000).unref();

http.createServer(async(req,res)=>{try{const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);if(req.method==='OPTIONS'&&u.pathname.startsWith('/api/public/')){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'POST,OPTIONS'});return res.end();}if(u.pathname.startsWith('/api/public/'))res.setHeader('Access-Control-Allow-Origin','*');if(u.pathname.startsWith('/api/'))return await api(req,res,u);if(serve(res,u.pathname))return;serve(res,'/');}catch(e){console.error(e);if(!res.headersSent)json(res,500,{ok:false,message:e.message||'Server error'});}}).listen(PORT,'0.0.0.0',()=>console.log(`SiteRemade V5 running on http://localhost:${PORT}${configured?' · Supabase connected':' · SUPABASE NOT CONFIGURED'}`));
