const http=require('http');
const {createClient}=require('@supabase/supabase-js');
const previous=http.createServer.bind(http);
const secret=process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY;
const db=process.env.SUPABASE_URL&&secret?createClient(process.env.SUPABASE_URL,secret,{auth:{persistSession:false,autoRefreshToken:false}}):null;
function normalizeBase(raw){let v=String(raw||'').trim().replace(/\/$/,'');if(v&&!/^https?:\/\//i.test(v))v='https://'+v;return v;}
function cleanDomain(raw){try{return new URL(/^https?:\/\//i.test(String(raw||''))?String(raw):'https://'+String(raw||'')).hostname.replace(/^www\./,'').toLowerCase()}catch{return''}}
function send(res,status,obj){const body=JSON.stringify(obj);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'});res.end(body)}
http.createServer=function(listener){return previous(async(req,res)=>{try{const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);if(req.method==='GET'&&u.pathname==='/api/public/analytics-config'){
const d=cleanDomain(u.searchParams.get('domain')||'');if(!db||!d)return send(res,404,{ok:false});
const row=(await db.from('website_analytics').select('provider').eq('domain',d).maybeSingle()).data;
const id=String(row?.provider||'').startsWith('umami:')?String(row.provider).slice(6):'';
const base=normalizeBase(process.env.UMAMI_BASE_URL);if(!id||!base)return send(res,404,{ok:false});
return send(res,200,{ok:true,src:base+'/script.js',websiteId:id});
}return listener(req,res)}catch(e){if(!res.headersSent)return send(res,500,{ok:false});res.end()}})};
