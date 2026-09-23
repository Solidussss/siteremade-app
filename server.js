require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { URL } = require('url');
const {
  db, anon, configured,
  cookies, authCookies, clearAuthCookies,
  sendJson: json, readJsonBody: body,
  getAuthUser: getAuth, membershipsFor, getContext: ctx
} = require('./lib/context');
const { buildRouter } = require('./routes');
const router = buildRouter();
const publicLimits = require('./lib/public-rate-limit');
const websiteLinks = require('./lib/website-links');
const generatorBridge = require('./lib/generator-bridge');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8080);
const SITEREMADE_MONTHLY_PRICE_CENTS = Math.max(100, Number(process.env.SITEREMADE_MONTHLY_PRICE_CENTS || 3900));
const ADS_FEATURE_ENABLED = false; // V13: preserve ad data/code, but block new ad actions until integrations are ready.
const hasSiteRemadeAccess=c=>c.owner||['active','trialing'].includes(String(c.workspace?.siteremade_subscription_status||'inactive').toLowerCase());
const STATUSES = ['New','Contacted','Quoted','Won','Lost'];
const PAY = ['Draft','Pending','Paid','Void'];
const now = () => new Date().toISOString();
const clean = (v,n=2000) => String(v ?? '').trim().slice(0,n);
// Phase 8: PATCH /api/app/settings validation helpers.
const SETTINGS_EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validTimeZone(tz){try{new Intl.DateTimeFormat('en-US',{timeZone:tz});return true;}catch{return false;}}
const signupAttempts=new Map();
// Phase 6: client IP comes from lib/public-rate-limit.js's clientIp() (Railway's
// edge-set X-Real-IP first) instead of trusting the first X-Forwarded-For entry.
function signupAllowed(req){const ip=publicLimits.clientIp(req);const t=Date.now(),windowMs=3600000,max=5;const recent=(signupAttempts.get(ip)||[]).filter(x=>t-x<windowMs);if(recent.length>=max)return false;recent.push(t);signupAttempts.set(ip,recent);return true;}


function queryError(label,error){
  const message=error?.message||error?.code||'Database query failed';
  const wrapped=new Error(label?`${label}: ${message}`:message);
  wrapped.code=error?.code||'';
  wrapped.details=error?.details||'';
  wrapped.hint=error?.hint||'';
  return wrapped;
}
async function q(promise,label=''){const {data,error}=await promise;if(error)throw queryError(label,error);return data;}
async function qc(promise,label=''){const {data,error,count}=await promise;if(error)throw queryError(label,error);return {data,count};}
function mapWorkspace(w){return {id:w.id,businessName:w.business_name,email:w.email,phone:w.phone,timezone:w.timezone,currency:w.currency,plan:w.plan,publicKey:w.public_key,stripeAccountId:w.stripe_account_id||'',siteRemadeCustomerId:w.siteremade_customer_id||'',siteRemadeSubscriptionId:w.siteremade_subscription_id||'',siteRemadeSubscriptionStatus:w.siteremade_subscription_status||'inactive',ai:{enabled:w.ai_enabled,services:w.ai_services,serviceArea:w.ai_service_area,tone:w.ai_tone}};}
function mapLead(l){return {id:l.id,name:l.name,email:l.email,phone:l.phone,service:l.service,source:l.source,status:l.status,value:Number(l.value)||0,message:l.message,notes:Array.isArray(l.notes)?l.notes:[],createdAt:l.created_at,updatedAt:l.updated_at};}
function mapConversation(c,messages=[]){return {id:c.id,leadId:c.lead_id,name:c.name,mode:c.mode,unread:c.unread,createdAt:c.created_at,updatedAt:c.updated_at,messages:messages.filter(m=>m.conversation_id===c.id).map(m=>({id:m.id,from:m.sender,text:m.text,createdAt:m.created_at}))};}
// Phase 5: POST /api/public/chat/history has always called mapMessage(),
// which was never defined anywhere -- a ReferenceError (500) for every
// widget history poll once a conversation existed. Same shape as the
// messages inside mapConversation() above, which is what widget.js reads.
function mapMessage(m){return {id:m.id,from:m.sender,text:m.text,createdAt:m.created_at};}
function mapAppointment(a){return {id:a.id,leadId:a.lead_id||'',title:a.title,customer:a.customer,start:a.start_at,duration:a.duration,status:a.status,notes:a.notes};}
function mapInvoice(i){return {id:i.id,leadId:i.lead_id||'',projectId:i.project_id||'',customer:i.customer,description:i.description,amount:Number(i.amount)||0,status:i.status,paymentUrl:i.payment_url||null,stripeSessionId:i.stripe_session_id||null,createdAt:i.created_at,paidAt:i.paid_at||null};}
function mapAutomation(a){return {id:a.automation_key,name:a.name,description:a.description,enabled:a.enabled};}
function mapActivity(a){return {id:a.id,type:a.type,title:a.title,detail:a.detail,createdAt:a.created_at};}
function mapAdSpend(a){return {id:a.id,platform:a.platform,campaign:a.campaign,spend:Number(a.spend)||0,leads:Number(a.leads)||0,source:a.source||'manual',createdAt:a.created_at};}
function mapAdFund(a){return {id:a.id,amount:Number(a.amount)||0,platform:a.platform||'Both',status:a.status,createdAt:a.created_at,fundedAt:a.funded_at||null};}
function mapWebsiteAnalytics(a){return a?{domain:a.domain||'',provider:a.provider||'google_analytics',connected:!!a.connected,sessions:Number(a.sessions)||0,users:Number(a.users)||0,pageviews:Number(a.pageviews)||0,lastSync:a.last_sync||null}:{domain:'',provider:'google_analytics',connected:false,sessions:0,users:0,pageviews:0,lastSync:null};}
function mapWebsiteUpdate(r){return {id:r.id,projectId:r.project_id||'',kind:r.kind||'update',page:r.page,priority:r.priority,request:r.request,notes:r.notes||'',status:r.status,createdAt:r.created_at,updatedAt:r.updated_at};}
function computeProjectPayment(projectId,invoicesForWs){const linked=(invoicesForWs||[]).filter(i=>i.project_id===projectId);if(!linked.length)return {paymentStatus:'none',invoiceCount:0,invoiceTotal:0,invoicePaid:0};const invoiceTotal=linked.reduce((s,i)=>s+Number(i.amount||0),0),invoicePaid=linked.filter(i=>i.status==='Paid').reduce((s,i)=>s+Number(i.amount||0),0),allPaid=linked.every(i=>i.status==='Paid'),anyPaid=linked.some(i=>i.status==='Paid');return {paymentStatus:allPaid?'paid':anyPaid?'partial':'unpaid',invoiceCount:linked.length,invoiceTotal,invoicePaid};}
// Mutating website-project routes (PATCH, /brief, /review) update a single row
// but still need to return the project with correctly computed revisions/
// payment (mapProject derives those from the workspace's invoices and
// website_updates, not from the row itself) — otherwise the response looks
// like it has zero revisions/no payment right after an action that clearly
// shouldn't reset either. This mirrors what the GET routes already fetch.
async function projectFullMap(wid,row){
  const [invoicesForWs,updatesForProject]=await Promise.all([
    q(db.from('invoices').select('id,project_id,status,amount').eq('workspace_id',wid)),
    q(db.from('website_updates').select('*').eq('project_id',row.id).order('created_at',{ascending:false}))
  ]);
  return mapProject(row,invoicesForWs,updatesForProject);
}
function mapProject(row,invoicesForWs=[],updatesForWs=[]){const revisions=(updatesForWs||[]).filter(u=>u.project_id===row.id).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));return {id:row.id,workspaceId:row.workspace_id,leadId:row.lead_id||'',businessName:row.business_name||'',source:row.source||'SiteRemade',intakeText:row.intake_text||'',intake:row.intake&&typeof row.intake==='object'?row.intake:{},designDirection:row.design_direction&&typeof row.design_direction==='object'?row.design_direction:{},brief:row.brief&&typeof row.brief==='object'?row.brief:{},briefHistory:Array.isArray(row.brief_history)?row.brief_history:[],builderPrompt:row.builder_prompt||'',status:row.status||'Intake',previewUrl:row.preview_url||'',liveUrl:row.live_url||'',deliveredAt:row.delivered_at||null,clientReviewStatus:row.client_review_status||'not_submitted',clientReviewedAt:row.client_reviewed_at||null,clientReviewFeedback:row.client_review_feedback||'',aiProvider:row.ai_provider||'',aiModel:row.ai_model||'',revisionCount:revisions.length,revisions:revisions.map(mapWebsiteUpdate),payment:computeProjectPayment(row.id,invoicesForWs),createdAt:row.created_at,updatedAt:row.updated_at};}
function extractBriefJson(text){const raw=clean(text,50000);const fenced=raw.match(/```(?:json)?\s*([\s\S]*?)```/i);const candidate=fenced?fenced[1]:raw;const start=candidate.indexOf('{'),end=candidate.lastIndexOf('}');if(start<0||end<=start)throw Error('AI did not return a structured website brief.');return JSON.parse(candidate.slice(start,end+1));}
function normalizeWebsiteBrief(input={}){const style=input.styleDirection||input.style_direction||{};const content=input.content||{};const builderPrompt=clean(input.builderPrompt||input.builder_prompt,30000);return {summary:clean(input.summary,2000),businessPositioning:clean(input.businessPositioning||input.business_positioning,3000),styleDirection:{style:clean(style.style,300),visualTone:clean(style.visualTone||style.visual_tone,500),colors:Array.isArray(style.colors)?style.colors.slice(0,8).map(x=>clean(x,120)):[],typography:clean(style.typography,800),layout:clean(style.layout,1500),motion:clean(style.motion,1200)},content:{hero:content.hero&&typeof content.hero==='object'?content.hero:{},services:Array.isArray(content.services)?content.services.slice(0,12):[],trust:Array.isArray(content.trust)?content.trust.slice(0,12):[],about:clean(content.about,3000),faq:Array.isArray(content.faq)?content.faq.slice(0,12):[],quoteForm:content.quoteForm||content.quote_form||{}},buildRules:Array.isArray(input.buildRules||input.build_rules)?(input.buildRules||input.build_rules).slice(0,30).map(x=>clean(x,1000)):[],avoid:Array.isArray(input.avoid)?input.avoid.slice(0,30).map(x=>clean(x,1000)):[],builderPrompt};}
function websiteBriefPrompt({workspace,lead,project,revision}){const intake=project.intake&&Object.keys(project.intake).length?project.intake:null;const source={workspace:{businessName:workspace?.business_name||'',services:workspace?.ai_services||'',serviceArea:workspace?.ai_service_area||'',tone:workspace?.ai_tone||''},lead:lead?{name:lead.name||'',email:lead.email||'',phone:lead.phone||'',service:lead.service||'',message:lead.message||'',source:lead.source||''}:null,structuredIntake:intake,legacyIntakeText:intake?'':clean(project.intake_text,18000),existingBrief:project.brief&&Object.keys(project.brief).length?project.brief:null,revision:clean(revision,8000)};return `You are SiteRemade's senior website strategist, conversion copywriter and design director.

Your job is to turn the supplied client/project information into a production-ready website brief that another coding agent can build without guessing.

Important rules:
- structuredIntake, when present, is the authoritative source of the client's choices (business identity, services, service area, desired pages, visual direction, colours, logo/assets, references). Treat every field in it as a constraint, not a suggestion, and do not override or reinterpret it.
- Only fall back to interpreting legacyIntakeText as free-form prose if structuredIntake is empty — that field exists solely for projects created before structured intake existed.
- Preserve the client's actual business identity. Do not invent awards, years in business, certifications, reviews, prices, team members, project counts, warranties, service areas or claims that were not supplied.
- Make the site feel custom to this specific business rather than like a generic contractor/SaaS template.
- Write useful real copy where the source supports it. If information is missing, use clearly marked neutral placeholders or instruct the builder to omit the claim.
- The finished site should feel expensive, editorial and intentional: strong hierarchy, excellent spacing, restrained motion, sharp mobile behaviour, and no random gradients/glass cards unless structuredIntake's visual direction explicitly calls for them.
- The builder prompt must be self-contained. A coding agent should be able to build the site from that prompt without needing this conversation.
- If a revision is supplied, update the existing brief rather than starting over.
- Return JSON only. No markdown.

Return exactly this shape:
{
  "summary": "short project summary",
  "businessPositioning": "how this business should be positioned",
  "styleDirection": {
    "style": "selected/derived style",
    "visualTone": "specific visual feel",
    "colors": ["specific supplied/derived colours"],
    "typography": "font personality and hierarchy guidance",
    "layout": "specific layout/composition guidance",
    "motion": "restrained interaction and motion guidance"
  },
  "content": {
    "hero": {"kicker":"","headline":"","subhead":"","primaryCta":"","secondaryCta":""},
    "services": [{"name":"","description":""}],
    "trust": ["only supported trust points"],
    "about": "",
    "faq": [{"question":"","answer":""}],
    "quoteForm": {"fields":[],"intro":""}
  },
  "buildRules": ["specific implementation rules"],
  "avoid": ["specific things that would make this site feel cheap or generic"],
  "builderPrompt": "complete production prompt for the website coding agent"
}

SOURCE DATA:
${JSON.stringify(source)}`;}
async function generateWebsiteBriefViaAnthropic(prompt){const key=process.env.ANTHROPIC_API_KEY,model=process.env.ANTHROPIC_MODEL;if(!key||!model)return null;const response=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':key,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model,max_tokens:7000,temperature:0.2,messages:[{role:'user',content:prompt}]})});const data=await response.json().catch(()=>({}));if(!response.ok)throw Error(data?.error?.message||'Claude could not generate the website brief.');const text=(data.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');return {provider:'anthropic',model,brief:normalizeWebsiteBrief(extractBriefJson(text))};}
async function generateWebsiteBriefViaOpenAI(prompt){const key=process.env.OPENAI_API_KEY;if(!key)return null;const model=process.env.OPENAI_MODEL||'gpt-4o-mini';const response=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,temperature:0.2,response_format:{type:'json_object'},messages:[{role:'system',content:'Return only valid JSON matching the requested schema.'},{role:'user',content:prompt}]})});const data=await response.json().catch(()=>({}));if(!response.ok)throw Error(data?.error?.message||'Fallback AI could not generate the website brief.');const text=data.choices?.[0]?.message?.content||'';return {provider:'openai',model,brief:normalizeWebsiteBrief(extractBriefJson(text))};}
async function generateWebsiteBrief(args){const prompt=websiteBriefPrompt(args);const anthropic=await generateWebsiteBriefViaAnthropic(prompt);if(anthropic)return anthropic;const fallback=await generateWebsiteBriefViaOpenAI(prompt);if(fallback)return fallback;throw Error('AI brief generation isn’t turned on for this workspace yet — write the brief manually.');}
async function activity(wid,type,title,detail){await db.from('activities').insert({workspace_id:wid,type,title,detail:clean(detail,1000)});}
async function audit(userId,wid,action,detail){await db.from('audit_logs').insert({user_id:userId,workspace_id:wid||null,action,detail:clean(detail,1000)});}
async function workspaceSnapshot(c){
  const [leads,convs,msgs,apps,invoices,autos,activities,adSpend,adFunds,prospectViews,websiteAnalytics,websiteUpdates,websiteProjects] = await Promise.all([
    q(db.from('leads').select('*').eq('workspace_id',c.wid).order('created_at',{ascending:false}),'bootstrap snapshot leads'),
    q(db.from('conversations').select('*').eq('workspace_id',c.wid).order('updated_at',{ascending:false}),'bootstrap snapshot conversations'),
    q(db.from('messages').select('*').eq('workspace_id',c.wid).order('created_at',{ascending:true}),'bootstrap snapshot messages'),
    q(db.from('appointments').select('*').eq('workspace_id',c.wid).order('start_at',{ascending:true}),'bootstrap snapshot appointments'),
    q(db.from('invoices').select('*').eq('workspace_id',c.wid).order('created_at',{ascending:false}),'bootstrap snapshot invoices'),
    q(db.from('automations').select('*').eq('workspace_id',c.wid).order('created_at',{ascending:true}),'bootstrap snapshot automations'),
    q(db.from('activities').select('*').eq('workspace_id',c.wid).order('created_at',{ascending:false}).limit(200),'bootstrap snapshot activities'),
    q(db.from('ad_spend').select('*').eq('workspace_id',c.wid).order('created_at',{ascending:false}).limit(200),'bootstrap snapshot ad_spend'),
    q(db.from('ad_funds').select('*').eq('workspace_id',c.wid).order('created_at',{ascending:false}).limit(200),'bootstrap snapshot ad_funds'),
    q(db.from('prospect_views').select('place_id').eq('workspace_id',c.wid).limit(5000),'bootstrap snapshot prospect_views'),
    q(db.from('website_analytics').select('*').eq('workspace_id',c.wid).maybeSingle(),'bootstrap snapshot website_analytics'),
    q(db.from('website_updates').select('*').eq('workspace_id',c.wid).order('created_at',{ascending:false}).limit(200),'bootstrap snapshot website_updates'),
    q(db.from('website_projects').select('*').eq('workspace_id',c.wid).order('updated_at',{ascending:false}).limit(200),'bootstrap snapshot website_projects')
  ]);
  return {workspace:mapWorkspace(c.workspace),workspaces:c.workspaces.map(mapWorkspace),user:{id:c.user.id,name:c.profile.name||c.user.email,email:c.user.email,role:c.profile.role},leads:leads.map(mapLead),conversations:convs.map(x=>mapConversation(x,msgs)),appointments:apps.map(mapAppointment),invoices:invoices.map(mapInvoice),automations:autos.map(mapAutomation),activities:activities.map(mapActivity),adSpend:adSpend.map(mapAdSpend),adFunds:adFunds.map(mapAdFund),prospectViews:prospectViews.map(x=>x.place_id),websiteAnalytics:mapWebsiteAnalytics(websiteAnalytics),websiteUpdates:websiteUpdates.map(mapWebsiteUpdate),websiteProjects:websiteProjects.map(p=>mapProject(p,invoices,websiteUpdates)),billing:{monthlyCents:SITEREMADE_MONTHLY_PRICE_CENTS,status:c.workspace.siteremade_subscription_status||'inactive',customerId:c.workspace.siteremade_customer_id||'',subscriptionId:c.workspace.siteremade_subscription_id||''},integrations:{supabase:true,openai:!!process.env.OPENAI_API_KEY,anthropic:!!(process.env.ANTHROPIC_API_KEY&&process.env.ANTHROPIC_MODEL),resend:!!process.env.RESEND_API_KEY,twilio:!!process.env.TWILIO_ACCOUNT_SID,stripe:!!process.env.STRIPE_SECRET_KEY,googlePlaces:!!process.env.GOOGLE_PLACES_API_KEY,googleAds:!!process.env.GOOGLE_ADS_DEVELOPER_TOKEN,metaAds:!!process.env.META_ACCESS_TOKEN}};
}

// Live-refresh backend cost: the ETag added for the bootstrap poll (below)
// still had to run the full workspaceSnapshot() above — 13 queries, six of
// them unbounded or capped at 200-5000 rows — before it could even compute
// the "did anything change" hash, on every single 5-second tick. This
// function answers that question directly, without ever fetching the full
// rows, so an unchanged poll can skip workspaceSnapshot() entirely.
//
// The signal per table is chosen to match how that table is actually
// mutated in this file (verified against every insert/update/delete call
// site, not assumed):
//   - leads, conversations, website_updates, website_projects: each has
//     a real `updated_at` column that every update() call in this file
//     already sets, and inserts/deletes change the row count — so
//     count + latest(updated_at) can't miss a change.
//   - messages, appointments, activities, ad_spend: insert/delete only
//     (no update() call touches a field the client ever sees — appointment
//     reminder_sent_at isn't in mapAppointment) — count + latest(created_at)
//     is enough.
//   - ad_funds: insert-only for count, plus a separate latest(funded_at)
//     check, because a fund request can flip Pending -> Funded long after
//     a newer request was created, which wouldn't otherwise move the
//     count or the created_at watermark.
//   - prospect_views: insert-only and already projected to just place_id
//     in workspaceSnapshot; count alone is sufficient and needs no row data.
//   - invoices, automations: NEITHER table has an updated_at column, and
//     both can change in place without any timestamp moving (an invoice's
//     status can be hand-edited to any value via the Payments dropdown,
//     not just to Paid; an automation toggle only flips a boolean) — so
//     for just these two, this reads every row but only the handful of
//     columns that are actually mutable, instead of every column.
//   - website_analytics: a single row per workspace, and its one write
//     path (routes/umami-analytics.js) always bumps its own `updated_at` —
//     so that column alone is the fingerprint, no extra columns needed.
async function workspaceFingerprint(wid){
  const countLatest=(table,ts)=>qc(db.from(table).select(`id,${ts}`,{count:'exact'}).eq('workspace_id',wid).order(ts,{ascending:false}).limit(1),`bootstrap fingerprint ${table}.${ts}`);
  const countOnly=(table)=>qc(db.from(table).select('*',{count:'exact',head:true}).eq('workspace_id',wid),`bootstrap fingerprint ${table}.count`);
  const latestFundedAt=qc(db.from('ad_funds').select('id,funded_at',{count:'exact'}).eq('workspace_id',wid).not('funded_at','is',null).order('funded_at',{ascending:false}).limit(1),'bootstrap fingerprint ad_funds.funded_at');
  const [leads,convs,msgs,apps,activities,adSpend,adFunds,fundedAt,prospectViews,websiteUpdates,websiteProjects,invoices,autos,websiteAnalytics]=await Promise.all([
    countLatest('leads','updated_at'),
    countLatest('conversations','updated_at'),
    countLatest('messages','created_at'),
    countLatest('appointments','created_at'),
    countLatest('activities','created_at'),
    countLatest('ad_spend','created_at'),
    countLatest('ad_funds','created_at'),
    latestFundedAt,
    countOnly('prospect_views'),
    countLatest('website_updates','updated_at'),
    countLatest('website_projects','updated_at'),
    q(db.from('invoices').select('id,status,paid_at').eq('workspace_id',wid),'bootstrap fingerprint invoices'),
    q(db.from('automations').select('automation_key,enabled').eq('workspace_id',wid),'bootstrap fingerprint automations'),
    q(db.from('website_analytics').select('updated_at').eq('workspace_id',wid).maybeSingle(),'bootstrap fingerprint website_analytics')
  ]);
  const sortedInvoices=[...invoices].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  const sortedAutos=[...autos].sort((a,b)=>a.automation_key<b.automation_key?-1:a.automation_key>b.automation_key?1:0);
  return {
    leads:{n:leads.count,t:leads.data[0]?.updated_at||''},
    conversations:{n:convs.count,t:convs.data[0]?.updated_at||''},
    messages:{n:msgs.count,t:msgs.data[0]?.created_at||''},
    appointments:{n:apps.count,t:apps.data[0]?.created_at||''},
    activities:{n:activities.count,t:activities.data[0]?.created_at||''},
    adSpend:{n:adSpend.count,t:adSpend.data[0]?.created_at||''},
    adFunds:{n:adFunds.count,t:adFunds.data[0]?.created_at||'',f:fundedAt.data[0]?.funded_at||''},
    prospectViews:prospectViews.count,
    websiteUpdates:{n:websiteUpdates.count,t:websiteUpdates.data[0]?.updated_at||''},
    websiteProjects:{n:websiteProjects.count,t:websiteProjects.data[0]?.updated_at||''},
    invoices:sortedInvoices.map(i=>[i.id,i.status,i.paid_at||'']),
    automations:sortedAutos.map(a=>[a.automation_key,a.enabled]),
    websiteAnalytics:websiteAnalytics?.updated_at||''
  };
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

// Phase 5: 429 for the public intake endpoints (see lib/public-rate-limit.js).
function tooMany(res,r){res.setHeader('Retry-After',String(r.retryAfterSeconds||60));return json(res,429,{ok:false,code:'rate_limited',message:'Too many requests in a short time. Please try again shortly.',retryAfterSeconds:r.retryAfterSeconds||60});}
// Phase 5: the one "a website visitor got in touch" write path, shared by
// POST /api/public/lead (widget/form with workspaceId+publicKey) and POST
// /api/public/site-submission (generated site, workspace resolved from its
// builder project id). Fields arrive already cleaned by the caller. Same
// rows, activity, automations and notifications /api/public/lead always
// produced -- moved here unchanged, not reimplemented.
async function createWebsiteLead(w,{name,email,phone,service,source,value,message}){
  const lead=await q(db.from('leads').insert({workspace_id:w.id,name,email,phone,service,source,status:'New',value,message,notes:[]}).select('*').single());
  const cv=await q(db.from('conversations').insert({workspace_id:w.id,lead_id:lead.id,name:lead.name,mode:'human',unread:1}).select('*').single());
  const customerText=message||`New ${service} inquiry submitted from the website.`;
  await db.from('messages').insert({workspace_id:w.id,conversation_id:cv.id,sender:'customer',text:customerText});
  await activity(w.id,'lead','New website inquiry',`${lead.name} · ${lead.service}`);
  const autos=await q(db.from('automations').select('*').eq('workspace_id',w.id));
  if(autos.some(a=>a.automation_key==='lead-alert'&&a.enabled)){notify(`New lead — ${lead.name}`,`${lead.name} requested ${lead.service}. ${lead.phone||lead.email||''}`,w.email);sms(w.phone,`SiteRemade: New lead — ${lead.name} · ${lead.service}`);}
  if(autos.some(a=>a.automation_key==='lead-confirmation'&&a.enabled)){
    const text=`Thanks for reaching out to ${w.business_name}. We received your request and will follow up shortly.`;
    await db.from('messages').insert({workspace_id:w.id,conversation_id:cv.id,sender:'ai',text});notify('We received your request',text,lead.email);
  }
  return {lead,conversation:cv};
}
// Phase 5: maps a site submission onto createWebsiteLead's fields. Accepts
// both the flat shape {projectId,name,email,phone,message,formSource} and
// the record a generated site's own server.js already POSTs when its
// operator sets SUBMISSION_BACKEND=webhook (lib/export-compiler.js in the
// builder repo): {projectId,sectionId,type,values:{name,email,...},revision,…}.
// Field keys are the builder's fixed module vocabulary (contact / quote /
// booking / newsletter); anything else is ignored, never stored raw.
const SITE_FORM_LABELS={contact:'Contact form',quote:'Quote request',booking:'Booking request',newsletter:'Newsletter signup'};
const SITE_FORM_EXTRAS=[['date','Requested date'],['time','Requested time'],['partySize','Party size / service'],['preferredContact','Preferred contact']];
function siteSubmissionFields(b){
  const v=b.values&&typeof b.values==='object'&&!Array.isArray(b.values)?b.values:b;
  const email=clean(v.email,254),phone=clean(v.phone,80),type=clean(b.type,40).toLowerCase();
  const primary=clean(v.message,4000)||clean(v.description,4000)||clean(v.notes,4000);
  const extras=SITE_FORM_EXTRAS.map(([k,label])=>clean(v[k],200)?`${label}: ${clean(v[k],200)}`:'').filter(Boolean);
  return {name:clean(v.name,120)||'Website visitor',email,phone,service:clean(v.service,160)||SITE_FORM_LABELS[type]||clean(b.formSource,160)||'Website form',source:'Website',value:0,message:[primary,...extras].filter(Boolean).join('\n').slice(0,4000)};
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
    {const r=publicLimits.publicLeadPerIp.take(publicLimits.clientIp(req));if(!r.ok)return tooMany(res,r);}
    const b=await body(req),w=await validPublicWorkspace(b);if(!w)return json(res,404,{ok:false,message:'Workspace not found or public key invalid.'});
    const name=clean(b.name,120);if(!name)return json(res,400,{ok:false,message:'Name required.'});
    {const r=publicLimits.leadsPerWorkspace.take(w.id);if(!r.ok)return tooMany(res,r);}
    const {lead,conversation:cv}=await createWebsiteLead(w,{name,email:clean(b.email,254),phone:clean(b.phone,80),service:clean(b.service||'General inquiry',160),source:clean(b.source||'Website',80),value:Math.max(0,Number(b.value)||0),message:clean(b.message,4000)});
    return json(res,201,{ok:true,leadId:lead.id,conversationId:cv.id});
  }
  // Phase 5: contact submissions from a SiteRemade-built (generated) site.
  // The caller names only the builder project (`projectId`); the owning
  // workspace is resolved HERE, server-side, from website_project_links
  // (lib/website-links.js). Any workspaceId/publicKey in the body is never
  // read -- there is nothing to spoof: an unlinked or made-up project id
  // matches no workspace and is refused. A project id is an identifier,
  // not a secret (same trust level as a workspace's public widget key), so
  // abuse protection here is validation + rate limits, as for /lead.
  if(m==='POST'&&p==='/api/public/site-submission'){
    let b;try{b=await body(req,64*1024);}catch(e){return json(res,400,{ok:false,message:'That submission couldn’t be read.'});}
    const projectId=clean(b.projectId,80);
    if(!websiteLinks.PROJECT_ID_RE.test(projectId))return json(res,400,{ok:false,message:'A valid site identifier is required.'});
    {const r=publicLimits.siteSubmissionPerProjectIp.take(projectId+'|'+publicLimits.clientIp(req));if(!r.ok)return tooMany(res,r);}
    let wid;try{wid=await websiteLinks.findWorkspaceForProject(projectId);}catch(e){console.error('site-submission lookup:',e.message);return json(res,503,{ok:false,message:'Submissions can’t be received right now. Please try again shortly.'});}
    const w=wid?(await db.from('workspaces').select('*').eq('id',wid).maybeSingle()).data:null;
    if(!w)return json(res,404,{ok:false,message:'This site isn’t connected to a SiteRemade workspace.'});
    const f=siteSubmissionFields(b);
    if(!f.email&&!f.phone&&f.name==='Website visitor')return json(res,400,{ok:false,message:'A name, email or phone number is required.'});
    {const r=publicLimits.leadsPerWorkspace.take(w.id);if(!r.ok)return tooMany(res,r);}
    await createWebsiteLead(w,f);
    return json(res,201,{ok:true});
  }
  if(m==='POST'&&p==='/api/public/chat'){
    {const r=publicLimits.publicChatPerIp.take(publicLimits.clientIp(req));if(!r.ok)return tooMany(res,r);}
    const b=await body(req),w=await validPublicWorkspace(b);if(!w)return json(res,404,{ok:false,message:'Workspace not found or public key invalid.'});const text=clean(b.text,4000);if(!text)return json(res,400,{ok:false,message:'Message required.'});
    let lead=null;if(b.leadId){lead=(await db.from('leads').select('*').eq('id',clean(b.leadId,80)).eq('workspace_id',w.id).maybeSingle()).data;}
    const visitorName=clean(b.name,120),visitorEmail=clean(b.email,254),visitorPhone=clean(b.phone,80);
    if(!lead)lead=await q(db.from('leads').insert({workspace_id:w.id,name:visitorName||'Website visitor',email:visitorEmail,phone:visitorPhone,service:clean(b.service||'Website chat',160),source:'AI Chat',status:'New',value:0,message:'',notes:[]}).select('*').single());
    else if(visitorName||visitorEmail||visitorPhone){const patch={updated_at:now()};if(visitorName&&lead.name==='Website visitor')patch.name=visitorName;if(visitorEmail&&!lead.email)patch.email=visitorEmail;if(visitorPhone&&!lead.phone)patch.phone=visitorPhone;const updated=await q(db.from('leads').update(patch).eq('id',lead.id).eq('workspace_id',w.id).select('*').single());lead=updated;}
    let cv=(await db.from('conversations').select('*').eq('workspace_id',w.id).eq('lead_id',lead.id).maybeSingle()).data;
    if(!cv)cv=await q(db.from('conversations').insert({workspace_id:w.id,lead_id:lead.id,name:lead.name,mode:'ai',unread:0}).select('*').single());
    await db.from('messages').insert({workspace_id:w.id,conversation_id:cv.id,sender:'customer',text});
    const history=await q(db.from('messages').select('*').eq('conversation_id',cv.id).order('created_at',{ascending:true}));
    let reply=null;
    if(cv.mode==='ai'){
      // Phase 5: a per-workspace hourly budget for paid AI replies; past it
      // the visitor still gets the built-in reply below, never an error.
      reply=w.ai_enabled&&process.env.OPENAI_API_KEY&&publicLimits.chatAiPerWorkspace.take(w.id).ok?await externalAI(w,history).catch(()=>null):null;
      if(!reply)reply=w.ai_enabled?localAI(w,text):`Thanks for reaching out to ${w.business_name}. Your message has been received and the team will follow up.`;
      await db.from('messages').insert({workspace_id:w.id,conversation_id:cv.id,sender:'ai',text:reply});
    }
    const nextUnread=Math.max(0,Number(cv.unread)||0)+1;
    await db.from('conversations').update({unread:nextUnread,updated_at:now(),name:lead.name}).eq('id',cv.id).eq('workspace_id',w.id);
    await activity(w.id,'message','Customer message',`${lead.name} · ${text.slice(0,60)}`);
    return json(res,200,{ok:true,leadId:lead.id,conversationId:cv.id,reply,mode:cv.mode});
  }

  if(m==='POST'&&p==='/api/public/chat/history'){
    {const r=publicLimits.publicChatHistoryPerIp.take(publicLimits.clientIp(req));if(!r.ok)return tooMany(res,r);}
    const b=await body(req),w=await validPublicWorkspace(b);if(!w)return json(res,404,{ok:false,message:'Workspace not found or public key invalid.'});
    const leadId=clean(b.leadId,80);if(!leadId)return json(res,400,{ok:false,message:'Lead required.'});
    const lead=(await db.from('leads').select('id').eq('id',leadId).eq('workspace_id',w.id).maybeSingle()).data;if(!lead)return json(res,404,{ok:false,message:'Conversation not found.'});
    const cv=(await db.from('conversations').select('*').eq('workspace_id',w.id).eq('lead_id',lead.id).maybeSingle()).data;if(!cv)return json(res,200,{ok:true,messages:[],mode:'human'});
    const msgs=await q(db.from('messages').select('*').eq('conversation_id',cv.id).eq('workspace_id',w.id).order('created_at',{ascending:true}).limit(200));
    return json(res,200,{ok:true,conversationId:cv.id,mode:cv.mode,messages:msgs.map(mapMessage)});
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
    if(!hasSiteRemadeAccess(c))return json(res,200,{ok:true,locked:true,workspace:mapWorkspace(c.workspace),workspaces:c.workspaces.map(mapWorkspace),user:{id:c.user.id,name:c.user.name,role:c.user.role},billing:{monthlyCents:SITEREMADE_MONTHLY_PRICE_CENTS,status:c.workspace.siteremade_subscription_status||'inactive',customerId:c.workspace.siteremade_customer_id||'',subscriptionId:c.workspace.siteremade_subscription_id||''},integrations:{stripe:!!process.env.STRIPE_SECRET_KEY},leads:[],conversations:[],appointments:[],invoices:[],automations:[],activities:[],adSpend:[],adFunds:[],websiteUpdates:[],websiteProjects:[]});
    // Performance: app.js's liveRefresh() polls this exact endpoint every
    // 5 seconds for as long as the dashboard is open. The first pass at
    // this (ETag over the full response) still had to run workspaceSnapshot
    // — 13 queries, several unbounded — before it could even tell whether
    // anything had changed, so an unchanged poll paid the full backend
    // cost every single time even though the network/render cost dropped.
    // workspaceFingerprint() answers "did anything change" using cheap,
    // targeted signals (see its own comment for exactly why each one is
    // safe) instead, so an unchanged poll can skip workspaceSnapshot()
    // entirely. When something *did* change, this still falls through to
    // the exact same full rebuild as before — freshness is identical,
    // only the unchanged-poll cost is different.
    //
    // Login/startup performance pass: a request with no If-None-Match
    // header can never get a 304 (there is nothing to compare against), so
    // running the fingerprint query *before* the snapshot query — two
    // sequential round trips — was pure added latency on exactly the
    // requests this pass is about: the first bootstrap call after login,
    // and after every plain page reload. When there's nothing to compare
    // against, run both concurrently instead of gating one on the other;
    // the fingerprint is still needed (it becomes the ETag this response
    // hands back for the *next* poll to compare against), it just no
    // longer adds a second sequential round trip to this one.
    const inm=req.headers['if-none-match'];
    let etag,snapshot;
    if(inm){
      const fingerprint=await workspaceFingerprint(c.wid);
      etag='"'+crypto.createHash('sha1').update(JSON.stringify(fingerprint)).digest('hex')+'"';
      if(inm===etag){res.writeHead(304,{'ETag':etag,'Cache-Control':'no-store'});return res.end();}
      snapshot={ok:true,locked:false,...await workspaceSnapshot(c)};
    }else{
      const [fingerprint,snap]=await Promise.all([workspaceFingerprint(c.wid),workspaceSnapshot(c)]);
      etag='"'+crypto.createHash('sha1').update(JSON.stringify(fingerprint)).digest('hex')+'"';
      snapshot={ok:true,locked:false,...snap};
    }
    const text=JSON.stringify(snapshot);
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(text),'Cache-Control':'no-store','ETag':etag});
    return res.end(text);
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
  // Phase 8: Settings -> "Try the chat". It used to post to the public
  // widget endpoint (/api/public/chat) with the workspace's own public key,
  // so every test created a real "AI Chat" lead + conversation: a fake entry
  // in Contact ("Who contacted you") that can't be deleted there, counted as
  // a website form submission in Analytics. This answers with exactly the
  // reply the live widget would give (same externalAI()/localAI() and the
  // same per-workspace AI budget as /api/public/chat) and writes nothing.
  // mode: 'ai' (OpenAI wrote it), 'basic' (built-in replies: no OpenAI key,
  // AI error, or budget spent), 'off' (the assistant is disabled).
  if(m==='POST'&&p==='/api/app/chat-preview'){
    const b=await body(req),text=clean(b.text,4000);if(!text)return json(res,400,{ok:false,message:'Type a message first.'});
    const w=c.workspace,history=(Array.isArray(b.history)?b.history:[]).slice(-9).map(x=>({sender:x&&x.from==='customer'?'customer':'ai',text:clean(x&&x.text,4000)})).filter(x=>x.text);
    let reply=null,mode='off';
    if(w.ai_enabled){
      if(process.env.OPENAI_API_KEY&&publicLimits.chatAiPerWorkspace.take(w.id).ok){reply=await externalAI(w,[...history,{sender:'customer',text}]).catch(()=>null);if(reply)mode='ai';}
      if(!reply){reply=localAI(w,text);mode='basic';}
    }else reply=`Thanks for reaching out to ${w.business_name}. Your message has been received and the team will follow up.`;
    return json(res,200,{ok:true,reply,mode,saved:false});
  }
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

  // Website Projects — the website-delivery lifecycle: Start Website Project (from a
  // lead) → Structured Intake → Build Brief → Building → Client Review → Revisions →
  // Payment/Handoff → Delivered → Ongoing Updates. Revisions, client feedback and the
  // pre-existing general "Website Updates" ticket flow all share the website_updates
  // table (see V50 migration) instead of being separate systems.
  if(m==='GET'&&p==='/api/app/website-projects'){
    const [rows,invoicesForWs,updatesForWs]=await Promise.all([
      q(db.from('website_projects').select('*').eq('workspace_id',c.wid).order('updated_at',{ascending:false})),
      q(db.from('invoices').select('id,project_id,status,amount').eq('workspace_id',c.wid)),
      q(db.from('website_updates').select('*').eq('workspace_id',c.wid).order('created_at',{ascending:false}))
    ]);
    return json(res,200,{ok:true,projects:rows.map(r=>mapProject(r,invoicesForWs,updatesForWs))});
  }
  if(m==='POST'&&p==='/api/app/website-projects'){
    const b=await body(req),leadId=clean(b.leadId,80);if(!leadId)return json(res,400,{ok:false,message:'Choose a lead to start a website project from.'});
    const lead=(await db.from('leads').select('*').eq('id',leadId).eq('workspace_id',c.wid).maybeSingle()).data;if(!lead)return json(res,404,{ok:false,message:'Lead not found.'});
    const existing=(await db.from('website_projects').select('*').eq('workspace_id',c.wid).eq('lead_id',leadId).maybeSingle()).data;
    if(existing)return json(res,200,{ok:true,project:await projectFullMap(c.wid,existing),created:false});
    const row=await q(db.from('website_projects').insert({workspace_id:c.wid,lead_id:leadId,business_name:lead.name,source:lead.source||'SiteRemade',status:'Intake'}).select('*').single());
    await activity(c.wid,'website','Website project started',row.business_name);
    return json(res,201,{ok:true,project:mapProject(row,[],[]),created:true});
  }
  x=p.match(/^\/api\/app\/website-projects\/([^/]+)$/);if(x&&m==='GET'){
    const row=(await db.from('website_projects').select('*').eq('id',x[1]).eq('workspace_id',c.wid).maybeSingle()).data;if(!row)return json(res,404,{ok:false,message:'Website project not found.'});
    const [invoicesForWs,updatesForProject]=await Promise.all([
      q(db.from('invoices').select('id,project_id,status,amount').eq('workspace_id',c.wid)),
      q(db.from('website_updates').select('*').eq('project_id',x[1]).order('created_at',{ascending:false}))
    ]);
    return json(res,200,{ok:true,project:mapProject(row,invoicesForWs,updatesForProject)});
  }
  x=p.match(/^\/api\/app\/website-projects\/([^/]+)$/);if(x&&m==='PATCH'){
    const old=(await db.from('website_projects').select('*').eq('id',x[1]).eq('workspace_id',c.wid).maybeSingle()).data;if(!old)return json(res,404,{ok:false,message:'Website project not found.'});
    const b=await body(req),patch={updated_at:now()};
    if(b.businessName!==undefined)patch.business_name=clean(b.businessName,200)||old.business_name;
    if(b.intake!==undefined&&b.intake&&typeof b.intake==='object')patch.intake=b.intake;
    if(b.previewUrl!==undefined)patch.preview_url=clean(b.previewUrl,600);
    if(b.liveUrl!==undefined)patch.live_url=clean(b.liveUrl,600);
    if(b.builderPrompt!==undefined)patch.builder_prompt=clean(b.builderPrompt,30000);
    if(b.status!==undefined){const status=clean(b.status,40);if(!['Intake','Brief Ready','Building','Review','Delivered'].includes(status))return json(res,400,{ok:false,message:'Invalid website project status.'});patch.status=status;}
    if(b.deliveredAt!==undefined){if(b.deliveredAt===null||b.deliveredAt===''){patch.delivered_at=null;}else{const d=new Date(b.deliveredAt);if(Number.isNaN(d.getTime()))return json(res,400,{ok:false,message:'Invalid delivered date.'});patch.delivered_at=d.toISOString();}}
    if(b.brief!==undefined&&b.brief&&typeof b.brief==='object'){const prior=old.brief&&Object.keys(old.brief).length?old.brief:null;patch.brief=b.brief;if(prior)patch.brief_history=[{...prior,_replacedAt:now()},...(Array.isArray(old.brief_history)?old.brief_history:[])].slice(0,20);}
    const row=await q(db.from('website_projects').update(patch).eq('id',x[1]).eq('workspace_id',c.wid).select('*').single());
    if(row.status!==old.status)await activity(c.wid,'website',`Website project moved to ${row.status}`,row.business_name);
    return json(res,200,{ok:true,project:await projectFullMap(c.wid,row)});
  }
  x=p.match(/^\/api\/app\/website-projects\/([^/]+)\/brief$/);if(x&&m==='POST'){
    if(!c.owner)return json(res,403,{ok:false,message:'SiteRemade owner access required.'});
    const old=(await db.from('website_projects').select('*').eq('id',x[1]).eq('workspace_id',c.wid).maybeSingle()).data;if(!old)return json(res,404,{ok:false,message:'Website project not found.'});
    const aiConfigured=!!(process.env.ANTHROPIC_API_KEY&&process.env.ANTHROPIC_MODEL)||!!process.env.OPENAI_API_KEY;
    if(!aiConfigured)return json(res,503,{ok:false,message:'AI brief generation isn’t turned on for this workspace yet — write the brief and builder prompt manually below.'});
    const b=await body(req),revision=clean(b.revision,8000);
    const hasIntake=(old.intake&&Object.keys(old.intake).length)||clean(old.intake_text,1).length;
    if(!hasIntake)return json(res,400,{ok:false,message:'Fill in the structured intake before generating a brief.'});
    let lead=null;if(old.lead_id)lead=(await db.from('leads').select('*').eq('id',old.lead_id).eq('workspace_id',c.wid).maybeSingle()).data;
    const ai=await generateWebsiteBrief({workspace:c.workspace,lead,project:old,revision});
    const prior=old.brief&&Object.keys(old.brief).length?old.brief:null;
    const patch={brief:ai.brief,brief_history:prior?[{...prior,_replacedAt:now()},...(Array.isArray(old.brief_history)?old.brief_history:[])].slice(0,20):(Array.isArray(old.brief_history)?old.brief_history:[]),builder_prompt:ai.brief.builderPrompt||old.builder_prompt,ai_provider:ai.provider,ai_model:ai.model,updated_at:now()};
    if(old.status==='Intake')patch.status='Brief Ready';
    const row=await q(db.from('website_projects').update(patch).eq('id',x[1]).eq('workspace_id',c.wid).select('*').single());
    await activity(c.wid,'website',revision?'Website brief revised':'Website brief generated',`${row.business_name} · ${ai.provider}`);
    return json(res,200,{ok:true,project:await projectFullMap(c.wid,row),provider:ai.provider,model:ai.model});
  }
  x=p.match(/^\/api\/app\/website-projects\/([^/]+)\/revisions$/);if(x&&m==='POST'){
    const proj=(await db.from('website_projects').select('id,workspace_id,business_name').eq('id',x[1]).eq('workspace_id',c.wid).maybeSingle()).data;if(!proj)return json(res,404,{ok:false,message:'Website project not found.'});
    const b=await body(req),request=clean(b.request,4000);if(!request)return json(res,400,{ok:false,message:'Describe the change first.'});
    const page=clean(b.page,80)||'Other',priority=['Normal','Important'].includes(clean(b.priority,30))?clean(b.priority,30):'Normal',notes=clean(b.notes,4000),kind=c.owner?'revision':'client_feedback';
    const row=await q(db.from('website_updates').insert({workspace_id:c.wid,project_id:proj.id,page,priority,request,notes,status:'Requested',kind}).select('*').single());
    await db.from('website_projects').update({updated_at:now()}).eq('id',proj.id);
    await activity(c.wid,'website',kind==='client_feedback'?'Client feedback added':'Website revision requested',`${proj.business_name} · ${request.slice(0,120)}`);
    return json(res,201,{ok:true,websiteUpdate:mapWebsiteUpdate(row)});
  }
  x=p.match(/^\/api\/app\/website-projects\/([^/]+)\/review$/);if(x&&m==='POST'){
    const proj=(await db.from('website_projects').select('*').eq('id',x[1]).eq('workspace_id',c.wid).maybeSingle()).data;if(!proj)return json(res,404,{ok:false,message:'Website project not found.'});
    const b=await body(req),decision=clean(b.decision,30);if(!['approved','changes_requested'].includes(decision))return json(res,400,{ok:false,message:'Invalid review decision.'});
    const feedback=clean(b.feedback,4000);
    const patch={client_review_status:decision,client_reviewed_at:now(),client_review_feedback:feedback,updated_at:now()};
    const row=await q(db.from('website_projects').update(patch).eq('id',x[1]).eq('workspace_id',c.wid).select('*').single());
    const request=feedback||(decision==='approved'?'Client approved the preview.':'Client requested changes.');
    await db.from('website_updates').insert({workspace_id:c.wid,project_id:proj.id,page:'Review',priority:decision==='changes_requested'?'Important':'Normal',request,notes:'',status:'Requested',kind:'client_feedback'});
    await activity(c.wid,'website',decision==='approved'?'Client approved website preview':'Client requested website changes',proj.business_name);
    return json(res,200,{ok:true,project:await projectFullMap(c.wid,row)});
  }
  x=p.match(/^\/api\/app\/website-projects\/([^/]+)$/);if(x&&m==='DELETE'){
    if(!c.owner)return json(res,403,{ok:false,message:'Owner only.'});
    await db.from('website_projects').delete().eq('id',x[1]).eq('workspace_id',c.wid);
    await activity(c.wid,'delete','Website project deleted',x[1]);
    return json(res,200,{ok:true});
  }

  if(m==='POST'&&p==='/api/app/prospects/search'){const b=await body(req);if(!clean(b.businessType,120)||!clean(b.location,160))return json(res,400,{ok:false,message:'Business type and location are required.'});const viewed=await q(db.from('prospect_views').select('place_id').eq('workspace_id',c.wid).limit(5000));const result=await searchPlaces(b,new Set(viewed.map(x=>x.place_id)));return json(res,200,{ok:true,...result});}
  if(m==='POST'&&p==='/api/app/prospects/viewed'){const b=await body(req),placeId=clean(b.placeId,220);if(!placeId)return json(res,400,{ok:false,message:'Google Place ID required.'});await q(db.from('prospect_views').upsert({workspace_id:c.wid,place_id:placeId,name:clean(b.name,200),website:clean(b.website,1000),viewed_at:now()},{onConflict:'workspace_id,place_id'}).select('*').single());return json(res,200,{ok:true});}
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
  if(x&&m==='POST'){const b=await body(req),cv=(await db.from('conversations').select('*').eq('id',x[1]).eq('workspace_id',c.wid).maybeSingle()).data;if(!cv)return json(res,404,{ok:false,message:'Conversation not found.'});const text=clean(b.text,4000);if(!text)return json(res,400,{ok:false,message:'Message empty.'});await db.from('messages').insert({workspace_id:c.wid,conversation_id:cv.id,sender:'business',text});await db.from('conversations').update({updated_at:now(),mode:'human',unread:0}).eq('id',cv.id);await activity(c.wid,'message','Message sent',`${cv.name} · ${text.slice(0,60)}`);const lead=(await db.from('leads').select('*').eq('id',cv.lead_id).eq('workspace_id',c.wid).maybeSingle()).data;if(lead?.status==='New')await db.from('leads').update({status:'Contacted',updated_at:now()}).eq('id',lead.id).eq('workspace_id',c.wid);if(lead?.email)notify(`Message from ${c.workspace.business_name}`,text,lead.email);if(lead?.phone)sms(lead.phone,`${c.workspace.business_name}: ${text}`);return json(res,201,{ok:true,delivery:{website:true,email:!!lead?.email&&!!process.env.RESEND_API_KEY,sms:!!lead?.phone&&!!process.env.TWILIO_ACCOUNT_SID},leadStatus:lead?.status==='New'?'Contacted':lead?.status||''});}

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

  if(m==='POST'&&p==='/api/app/invoices'){const b=await body(req),lead=(await db.from('leads').select('*').eq('id',clean(b.leadId,80)).eq('workspace_id',c.wid).maybeSingle()).data,amount=Math.max(0,Number(b.amount)||0);if(!lead||!amount)return json(res,400,{ok:false,message:'Customer and amount required.'});let projectId=null;if(clean(b.projectId,80)){const proj=(await db.from('website_projects').select('id').eq('id',clean(b.projectId,80)).eq('workspace_id',c.wid).maybeSingle()).data;if(!proj)return json(res,404,{ok:false,message:'Website project not found.'});projectId=proj.id;}let inv=await q(db.from('invoices').insert({workspace_id:c.wid,lead_id:lead.id,project_id:projectId,customer:lead.name,description:clean(b.description,240)||'Invoice',amount,status:'Pending'}).select('*').single());if(process.env.STRIPE_SECRET_KEY){try{const j=await stripeRequest('checkout/sessions',{'line_items[0][price_data][currency]':(c.workspace.currency||'cad').toLowerCase(),'line_items[0][price_data][product_data][name]':inv.description,'line_items[0][price_data][unit_amount]':String(Math.round(amount*100)),'line_items[0][quantity]':'1','mode':'payment','success_url':`${process.env.PUBLIC_BASE_URL||'http://localhost:'+PORT}/?paid=1`,'cancel_url':`${process.env.PUBLIC_BASE_URL||'http://localhost:'+PORT}/?canceled=1`,'metadata[invoiceId]':inv.id,'metadata[workspaceId]':c.wid},c.workspace.stripe_account_id||'');inv=await q(db.from('invoices').update({payment_url:j.url||null,stripe_session_id:j.id||null}).eq('id',inv.id).select('*').single());}catch(e){console.error('Stripe invoice:',e.message)}}await activity(c.wid,'payment','Invoice created',`${inv.customer} · $${amount.toFixed(2)}`);return json(res,201,{ok:true,invoice:mapInvoice(inv)});}
  // Production-readiness review: marking an invoice "Paid" here used to be
  // reachable by any signed-in workspace member with no proof of payment —
  // the real, verified payment path is the Stripe webhook above (line 334,
  // checks the HMAC signature), which already sets status:'Paid' the same
  // way once a checkout session actually completes. This manual PATCH stays
  // available for the cases that legitimately need a human override (a
  // client paid by e-transfer/cheque, a correction), but — matching every
  // other sensitive mutation in this file (website-updates status,
  // website-project brief/delete) — only SiteRemade staff (c.owner) can set
  // or unset "Paid" by hand; a workspace's own member still can't self-
  // report their invoice as paid. Draft/Pending/Void are unaffected.
  x=p.match(/^\/api\/app\/invoices\/([^/]+)$/);if(x&&m==='PATCH'){const b=await body(req);if(b.status&&!PAY.includes(b.status))return json(res,400,{ok:false,message:'Invalid status.'});if(b.status==='Paid'&&!c.owner)return json(res,403,{ok:false,message:'Only SiteRemade staff can mark an invoice paid by hand.'});const patch={};if(b.status){patch.status=b.status;if(b.status==='Paid')patch.paid_at=now();}const inv=await q(db.from('invoices').update(patch).eq('id',x[1]).eq('workspace_id',c.wid).select('*').single());return json(res,200,{ok:true,invoice:mapInvoice(inv)});}
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
  // Phase 8: the three Account fields that other code depends on are
  // validated before anything is written (a 400 writes nothing). A time
  // zone Intl doesn't know is sent verbatim as `timeZone` to Google
  // Calendar by routes/google-calendar.js (which rejects it, breaking sync);
  // a malformed alert email makes every new-contact alert silently go
  // nowhere; a blank business name blanks the workspace everywhere.
  if(m==='PATCH'&&p==='/api/app/settings'){const b=await body(req),patch={};for(const [js,sql,n] of [['businessName','business_name',160],['email','email',254],['phone','phone',80],['timezone','timezone',100],['currency','currency',10],['services','ai_services',2000],['serviceArea','ai_service_area',1000],['tone','ai_tone',500]])if(b[js]!==undefined)patch[sql]=clean(b[js],n);
    if(patch.business_name!==undefined&&!patch.business_name)return json(res,400,{ok:false,field:'businessName',message:'Business name can’t be empty.'});
    if(patch.email&&!SETTINGS_EMAIL_RE.test(patch.email))return json(res,400,{ok:false,field:'email',message:'Enter a valid email address for new-contact alerts.'});
    if(patch.timezone&&!validTimeZone(patch.timezone))return json(res,400,{ok:false,field:'timezone',message:'That time zone isn’t recognised. Use a name like America/Edmonton or America/Toronto.'});
    const w=await q(db.from('workspaces').update(patch).eq('id',c.wid).select('*').single());return json(res,200,{ok:true,workspace:mapWorkspace(w)});}
  // Phase 5: staff-only Website status per workspace (builder project link,
  // last seen revision, analytics provisioning) + the server-wide contact
  // intake protection. Reference data only; tolerant of V52 not applied.
  // Phase 6: + the candidate projects captured for a link that needs review
  // (ids/dates/versions only -- purchase refs stay server-side), whether V53
  // is applied, and whether the builder's bridge is switched on at all.
  if(m==='GET'&&p==='/api/app/admin'){if(!c.owner)return json(res,403,{ok:false,message:'Owner only.'});const [profiles,members,auditRows,allLeads,allSpend,allFunds,linkList,builderBridge]=await Promise.all([q(db.from('profiles').select('*').order('created_at',{ascending:true})),q(db.from('workspace_members').select('*')),q(db.from('audit_logs').select('*').order('created_at',{ascending:false}).limit(50)),q(db.from('leads').select('workspace_id')),q(db.from('ad_spend').select('workspace_id,spend')),q(db.from('ad_funds').select('workspace_id,amount,status')),websiteLinks.listLinks(),generatorBridge.probeBridge()]);
    // Phase 9: a workspace can hold more than one linked project now, so
    // this maps EVERY row for a workspace, not just the first one .find()
    // would have returned (a real, previously-latent bug: before Phase 9's
    // migration no workspace could have a second row, so it never showed --
    // it would have started silently hiding a customer's 2nd+ purchased
    // project from Admin the moment multi-project linking went live).
    const linkToView=l=>{const needsReview=!!l.mismatch_project_id,cands=needsReview?websiteLinks.sanitizeCandidates(l.mismatch_candidates):null;return {linked:true,projectId:l.generator_project_id,lastSeenRevision:Number.isInteger(l.last_seen_revision)?l.last_seen_revision:null,linkedAt:l.linked_at||null,updatedAt:l.updated_at||null,analyticsReady:!!l.analytics_site_id,needsReview,reportedProjectId:l.mismatch_project_id||null,reportedAt:l.mismatch_seen_at||null,candidatesCapturedAt:cands?(l.mismatch_candidates_at||null):null,candidates:cands?cands.map(x=>({projectId:x.projectId,purchasedAt:x.purchasedAt,revision:x.revision,current:x.projectId===l.generator_project_id,reported:x.projectId===l.mismatch_project_id})):null};};
    const websitesFor=wid=>linkList.rows.filter(x=>x.workspace_id===wid).sort((a,b)=>String(b.linked_at||'').localeCompare(String(a.linked_at||''))).map(linkToView);
    const workspaces=c.workspaces.map(w=>{const websites=websitesFor(w.id);return {...mapWorkspace(w),leads:allLeads.filter(x=>x.workspace_id===w.id).length,adSpent:allSpend.filter(x=>x.workspace_id===w.id).reduce((s,x)=>s+Number(x.spend||0),0),adFunded:allFunds.filter(x=>x.workspace_id===w.id&&x.status==='Funded').reduce((s,x)=>s+Number(x.amount||0),0),websites,websiteCount:websites.length,
      // `website` kept for back-compat with anything still reading the
      // singular field: the most recently linked project, or {linked:false}
      // when there are none. New Admin UI (renderAdminWebsite) reads
      // `websites` and lists every one.
      website:websites[0]||{linked:false}};});
    return json(res,200,{ok:true,workspaces,websiteLinksAvailable:linkList.available,websiteLinkCandidatesAvailable:linkList.candidatesAvailable,builderBridge,contactIntake:publicLimits.describe(),users:profiles.map(p=>({id:p.id,name:p.name,role:p.role,workspaceIds:members.filter(m=>m.user_id===p.id).map(m=>m.workspace_id)})),audit:auditRows});}
  return json(res,404,{ok:false,message:'Not found.'});
}

function mime(f){return ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.sql':'text/plain; charset=utf-8'}[path.extname(f)]||'application/octet-stream');}
// Performance review: this codebase's ~300KB of JS/CSS was being served
// completely uncompressed (no Content-Encoding at all). Text compresses
// ~70-80% with gzip, so this alone materially cuts transfer time on every
// page load, especially on mobile — a pure transport-layer optimization
// that changes zero bytes of the actual response body once decompressed,
// and every HTTP client (browsers, fetch/undici, Playwright) decompresses
// gzip transparently, so nothing downstream needed to change.
const COMPRESSIBLE = /^(text\/|application\/javascript|application\/json|application\/manifest\+json)/;
function serve(res,p,req){let rel=p==='/'?'index.html':decodeURIComponent(p.slice(1));const f=path.normalize(path.join(ROOT,rel));if(!f.startsWith(ROOT)||!fs.existsSync(f)||!fs.statSync(f).isFile())return false;const type=mime(f),cacheControl=rel==='index.html'?'no-store':'public,max-age=300';const acceptsGzip=COMPRESSIBLE.test(type)&&/\bgzip\b/.test(req?.headers?.['accept-encoding']||'');if(acceptsGzip){res.writeHead(200,{'Content-Type':type,'Cache-Control':cacheControl,'Content-Encoding':'gzip','Vary':'Accept-Encoding'});fs.createReadStream(f).pipe(zlib.createGzip()).pipe(res);}else{res.writeHead(200,{'Content-Type':type,'Cache-Control':cacheControl});fs.createReadStream(f).pipe(res);}return true;}

setInterval(processAppointmentReminders,15*60*1000).unref();
setTimeout(processAppointmentReminders,5000).unref();

http.createServer(async(req,res)=>{try{const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);if(req.method==='OPTIONS'&&u.pathname.startsWith('/api/public/')){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'POST,OPTIONS'});return res.end();}if(u.pathname.startsWith('/api/public/'))res.setHeader('Access-Control-Allow-Origin','*');if(await router.dispatch(req,res,u,json))return;if(u.pathname.startsWith('/api/'))return await api(req,res,u);if(serve(res,u.pathname,req))return;serve(res,'/',req);}catch(e){console.error('Unhandled request error',{message:e?.message||'',code:e?.code||'',details:e?.details||'',hint:e?.hint||'',stack:e?.stack||''});if(!res.headersSent)json(res,500,{ok:false,message:e?.message||'Server error'});}}).listen(PORT,'0.0.0.0',()=>console.log(`SiteRemade V16 running on http://localhost:${PORT}${configured?' · Supabase connected':' · SUPABASE NOT CONFIGURED'}`));
