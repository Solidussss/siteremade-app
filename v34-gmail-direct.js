require('dotenv').config();
const http=require('http');
const fs=require('fs');
const crypto=require('crypto');
const {createClient}=require('@supabase/supabase-js');

const prevCreate=http.createServer.bind(http);
const prevRead=fs.readFileSync.bind(fs);
const base=String(process.env.PUBLIC_BASE_URL||'https://app.siteremade.com').replace(/\/$/,'');
const redirectUri=base+'/api/app/gmail/callback';
const clientId=process.env.GOOGLE_CLIENT_ID||process.env.GOOGLE_OAUTH_CLIENT_ID||'';
const clientSecret=process.env.GOOGLE_CLIENT_SECRET||process.env.GOOGLE_OAUTH_CLIENT_SECRET||'';
const serviceKey=process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey=process.env.SUPABASE_PUBLISHABLE_KEY||process.env.SUPABASE_ANON_KEY;
const db=process.env.SUPABASE_URL&&serviceKey?createClient(process.env.SUPABASE_URL,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}}):null;
const anon=process.env.SUPABASE_URL&&anonKey?createClient(process.env.SUPABASE_URL,anonKey,{auth:{persistSession:false,autoRefreshToken:false}}):null;
const stateSecret=process.env.MAILBOX_STATE_SECRET||serviceKey||'siteremade-mail';
const cookies=req=>Object.fromEntries(String(req.headers.cookie||'').split(';').map(x=>x.trim().split('=')).filter(x=>x[0]).map(([k,...v])=>[k,decodeURIComponent(v.join('='))]));
function authCookies(session){const secure=process.env.NODE_ENV==='production'?'; Secure':'';return [
  `sr_access=${encodeURIComponent(session.access_token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(60,session.expires_in||3600)}${secure}`,
  `sr_refresh=${encodeURIComponent(session.refresh_token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`
]}
async function context(req,res){
  if(!db||!anon)return null;
  const c=cookies(req);
  let user=null;
  if(c.sr_access){const got=await anon.auth.getUser(c.sr_access);user=got.data?.user||null;}
  if(!user&&c.sr_refresh){const refreshed=await anon.auth.refreshSession({refresh_token:c.sr_refresh});if(!refreshed.error&&refreshed.data?.session&&refreshed.data?.user){user=refreshed.data.user;res.setHeader('Set-Cookie',authCookies(refreshed.data.session));}}
  if(!user)return null;
  const p=(await db.from('profiles').select('role').eq('id',user.id).maybeSingle()).data;
  if(!p)return null;
  let ws=[];
  if(p.role==='owner')ws=(await db.from('workspaces').select('id').order('created_at')).data||[];
  else ws=((await db.from('workspace_members').select('workspace_id').eq('user_id',user.id)).data||[]).map(x=>({id:x.workspace_id}));
  if(!ws.length)return null;
  let wid=req.headers['x-workspace-id']||c.sr_workspace||ws[0].id;
  if(!ws.some(x=>x.id===wid))wid=ws[0].id;
  return{user,wid};
}
function state(obj){const p=Buffer.from(JSON.stringify(obj)).toString('base64url');const s=crypto.createHmac('sha256',stateSecret).update(p).digest('base64url');return p+'.'+s}
function googleUrl(ctx){
  const scopes=['openid','email','https://www.googleapis.com/auth/gmail.modify','https://www.googleapis.com/auth/gmail.send','https://www.googleapis.com/auth/calendar.events'];
  const q=new URLSearchParams({client_id:clientId,redirect_uri:redirectUri,response_type:'code',scope:scopes.join(' '),state:state({w:ctx.wid,u:ctx.user.id,p:'gmail',t:Date.now()}),access_type:'offline',prompt:'consent',include_granted_scopes:'true'});
  return 'https://accounts.google.com/o/oauth2/v2/auth?'+q.toString();
}
http.createServer=function(listener){return prevCreate(async(req,res)=>{try{const u=new URL(req.url,'http://'+(req.headers.host||'localhost'));if(req.method==='GET'&&u.pathname==='/api/app/gmail/start'){const c=await context(req,res);if(!c){res.writeHead(302,{Location:base+'/?mailbox=error&reason='+encodeURIComponent('Authentication required.')});return res.end()}if(!clientId||!clientSecret){res.writeHead(302,{Location:base+'/?mailbox=error&reason='+encodeURIComponent('Google OAuth credentials are missing on the server.')});return res.end()}res.writeHead(302,{Location:googleUrl(c),'Cache-Control':'no-store'});return res.end()}return listener(req,res)}catch(e){console.error('Gmail direct start:',e);if(!res.headersSent){res.writeHead(302,{Location:base+'/?mailbox=error&reason='+encodeURIComponent(e.message||'Google connection failed.')});return res.end()}res.end()}})};

fs.readFileSync=function(file,...args){const out=prevRead(file,...args);if(typeof out!=='string')return out;const name=String(file||'');if(!name.endsWith('index.html')&&!name.endsWith('app.html'))return out;if(out.includes('data-gmail-direct-v34'))return out;const script=`<script data-gmail-direct-v34>document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('[data-v29-provider="gmail"]');if(!b)return;e.preventDefault();e.stopImmediatePropagation();window.location.assign('/api/app/gmail/start');},true);</script>`;return out.replace('</body>',script+'\n</body>')};
