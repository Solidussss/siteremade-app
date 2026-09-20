// Only remaining live route: POST /api/app/conversations/:id/messages,
// which tries mailbox delivery (Gmail/Outlook) first and falls through —
// via `return listener(req,res)` — to server.js's own, entirely different
// generic implementation of the same path (email via Resend + SMS via
// Twilio) whenever no mailbox is connected, or the conversation's lead has
// no email address on file. Every other route this file used to serve
// (mailbox/status, mailbox/connect, mailbox/callback/:provider,
// mailbox/sync, DELETE mailbox) has been migrated to routes/mailbox.js —
// see lib/router.js and PHASE3-ROUTE-MAP.md.
//
// This one route stays on the old http.createServer monkeypatch chain
// deliberately: the router always treats a matched route as "handled" and
// has no notion of "try the next route registered for this same path" —
// its fallback here isn't just an auth failure, it's a *different,
// unrelated implementation* living in server.js's legacy api() dispatcher.
// Safely expressing that would mean merging this handler's logic directly
// into that dispatcher (restructuring code outside this file, for a path
// with real customer-messaging consequences if the merge got the fallback
// conditions wrong), which is deliberately left for a later, more careful
// pass rather than risked in this one.
require('dotenv').config();
const http=require('http');
const previous=http.createServer.bind(http);
const { db, sendJson: send, getContext: context, readJsonBody: read } = require('./lib/context');
const base=String(process.env.PUBLIC_BASE_URL||'https://app.siteremade.com').replace(/\/$/,'');
const clean=(v,n=4000)=>String(v??'').trim().slice(0,n);
function providerConfig(provider){if(provider==='gmail')return{clientId:process.env.GOOGLE_OAUTH_CLIENT_ID||'',clientSecret:process.env.GOOGLE_OAUTH_CLIENT_SECRET||'',auth:'https://accounts.google.com/o/oauth2/v2/auth',token:'https://oauth2.googleapis.com/token',scope:'openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send',redirect:base+'/api/app/mailbox/callback/gmail'};if(provider==='outlook')return{clientId:process.env.MICROSOFT_OAUTH_CLIENT_ID||'',clientSecret:process.env.MICROSOFT_OAUTH_CLIENT_SECRET||'',auth:'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',token:'https://login.microsoftonline.com/common/oauth2/v2.0/token',scope:'openid email offline_access User.Read Mail.ReadWrite Mail.Send',redirect:base+'/api/app/mailbox/callback/outlook'};return null}
async function tokenRequest(provider,params){const c=providerConfig(provider);const r=await fetch(c.token,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(params)});const j=await r.json();if(!r.ok)throw Error(j.error_description||j.error||'Mailbox token request failed');return j}
async function freshConnection(row){if(!row)return null;if(row.expires_at&&new Date(row.expires_at).getTime()>Date.now()+60000)return row;if(!row.refresh_token)return row;const c=providerConfig(row.provider);const j=await tokenRequest(row.provider,{client_id:c.clientId,client_secret:c.clientSecret,grant_type:'refresh_token',refresh_token:row.refresh_token,redirect_uri:c.redirect,scope:c.scope});const patch={access_token:j.access_token||row.access_token,refresh_token:j.refresh_token||row.refresh_token,expires_at:new Date(Date.now()+Number(j.expires_in||3600)*1000).toISOString(),updated_at:new Date().toISOString()};const saved=(await db.from('mailbox_connections').update(patch).eq('workspace_id',row.workspace_id).select('*').single()).data;return saved||{...row,...patch}}
async function connection(wid){const r=(await db.from('mailbox_connections').select('*').eq('workspace_id',wid).maybeSingle()).data;return r?freshConnection(r):null}
function mime(to,fromName,subject,text){const lines=[`To: ${to}`,`Subject: ${subject}`,`Content-Type: text/plain; charset="UTF-8"`,'MIME-Version: 1.0','',text];return Buffer.from(lines.join('\r\n')).toString('base64url')}
async function sendProvider(row,to,subject,text,fromName){row=await freshConnection(row);if(row.provider==='gmail'){const r=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST',headers:{Authorization:'Bearer '+row.access_token,'Content-Type':'application/json'},body:JSON.stringify({raw:mime(to,fromName,subject,text)})});const j=await r.json();if(!r.ok)throw Error(j.error?.message||'Gmail send failed');return j.id||''}const r=await fetch('https://graph.microsoft.com/v1.0/me/sendMail',{method:'POST',headers:{Authorization:'Bearer '+row.access_token,'Content-Type':'application/json'},body:JSON.stringify({message:{subject,body:{contentType:'Text',content:text},toRecipients:[{emailAddress:{address:to}}]}})});if(!r.ok){const j=await r.json().catch(()=>({}));throw Error(j.error?.message||'Outlook send failed')}return 'outlook:'+Date.now()}
http.createServer=function(listener){return previous(async(req,res)=>{try{const u=new URL(req.url,`http://${req.headers.host||'localhost'}`),p=u.pathname;
const mm=p.match(/^\/api\/app\/conversations\/([^/]+)\/messages$/);
if(!mm||req.method!=='POST')return listener(req,res);
const c=await context(req,res);if(!c)return send(res,401,{ok:false,message:'Authentication required.'});
const row=await connection(c.wid);if(!row)return listener(req,res);const b=await read(req),cv=(await db.from('conversations').select('*').eq('id',mm[1]).eq('workspace_id',c.wid).maybeSingle()).data;if(!cv)return send(res,404,{ok:false,message:'Conversation not found.'});const lead=(await db.from('leads').select('*').eq('id',cv.lead_id).eq('workspace_id',c.wid).maybeSingle()).data;if(!lead?.email)return listener(req,res);const text=clean(b.text,4000);if(!text)return send(res,400,{ok:false,message:'Message empty.'});const subject=`${c.workspace.business_name||'Message'} — ${lead.name}`;const ext=await sendProvider(row,lead.email,subject,text,c.workspace.business_name||'SiteRemade');await db.from('messages').insert({workspace_id:c.wid,conversation_id:cv.id,sender:'business',text});await db.from('conversations').update({updated_at:new Date().toISOString(),mode:'human',unread:0}).eq('id',cv.id);await db.from('mailbox_events').insert({workspace_id:c.wid,provider:row.provider,external_id:ext||('sent:'+Date.now()),conversation_id:cv.id,lead_id:lead.id,direction:'outbound'});if(lead.status==='New')await db.from('leads').update({status:'Contacted',updated_at:new Date().toISOString()}).eq('id',lead.id);return send(res,201,{ok:true,delivery:{website:true,email:true,mailbox:true,provider:row.provider},leadStatus:lead.status==='New'?'Contacted':lead.status})
}catch(e){console.error('Mailbox:',e);if(!res.headersSent)return send(res,500,{ok:false,message:e.message||'Mailbox error'});res.end()}})};
