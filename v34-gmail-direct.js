require('dotenv').config();
const http=require('http');
const fs=require('fs');
const crypto=require('crypto');

const prevCreate=http.createServer.bind(http);
const prevRead=fs.readFileSync.bind(fs);
const { getContext: context } = require('./lib/context');
const base=String(process.env.PUBLIC_BASE_URL||'https://app.siteremade.com').replace(/\/$/,'');
const redirectUri=base+'/api/app/gmail/callback';
const clientId=process.env.GOOGLE_CLIENT_ID||process.env.GOOGLE_OAUTH_CLIENT_ID||'';
const clientSecret=process.env.GOOGLE_CLIENT_SECRET||process.env.GOOGLE_OAUTH_CLIENT_SECRET||'';
const stateSecret=process.env.MAILBOX_STATE_SECRET||process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY||'siteremade-mail';
function state(obj){const p=Buffer.from(JSON.stringify(obj)).toString('base64url');const s=crypto.createHmac('sha256',stateSecret).update(p).digest('base64url');return p+'.'+s}
function googleUrl(ctx){
  const scopes=['openid','email','https://www.googleapis.com/auth/gmail.modify','https://www.googleapis.com/auth/gmail.send','https://www.googleapis.com/auth/calendar.events'];
  const q=new URLSearchParams({client_id:clientId,redirect_uri:redirectUri,response_type:'code',scope:scopes.join(' '),state:state({w:ctx.wid,u:ctx.user.id,p:'gmail',t:Date.now()}),access_type:'offline',prompt:'consent',include_granted_scopes:'true'});
  return 'https://accounts.google.com/o/oauth2/v2/auth?'+q.toString();
}
http.createServer=function(listener){return prevCreate(async(req,res)=>{try{const u=new URL(req.url,'http://'+(req.headers.host||'localhost'));if(req.method==='GET'&&u.pathname==='/api/app/gmail/start'){const c=await context(req,res);if(!c){res.writeHead(302,{Location:base+'/?mailbox=error&reason='+encodeURIComponent('Authentication required.')});return res.end()}if(!clientId||!clientSecret){res.writeHead(302,{Location:base+'/?mailbox=error&reason='+encodeURIComponent('Google OAuth credentials are missing on the server.')});return res.end()}res.writeHead(302,{Location:googleUrl(c),'Cache-Control':'no-store'});return res.end()}return listener(req,res)}catch(e){console.error('Gmail direct start:',e);if(!res.headersSent){res.writeHead(302,{Location:base+'/?mailbox=error&reason='+encodeURIComponent(e.message||'Google connection failed.')});return res.end()}res.end()}})};

fs.readFileSync=function(file,...args){const out=prevRead(file,...args);if(typeof out!=='string')return out;const name=String(file||'');if(!name.endsWith('index.html'))return out;if(out.includes('data-gmail-direct-v34'))return out;const script=`<script data-gmail-direct-v34>document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('[data-v29-provider="gmail"]');if(!b)return;e.preventDefault();e.stopImmediatePropagation();window.location.assign('/api/app/gmail/start');},true);</script>`;return out.replace('</body>',script+'\n</body>')};
