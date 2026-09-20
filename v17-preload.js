// POST /api/public/twilio/inbound and GET /api/v19/admin/overview, which
// used to be defined in this file's http.createServer block, have been
// migrated to routes/legacy-twilio-inbound.js — see lib/router.js and
// PHASE3-ROUTE-MAP.md. This file keeps index.html serving (enhancedHtml(),
// which runs through every other file's fs.readFileSync patch to compose
// the final page) and the res.end() wrapper around POST/PATCH
// /api/app/website-updates (fires an email notification based on that
// route's response body) — both are frontend-injection/cross-cutting
// concerns out of scope for this route-migration pass; see the header
// comment in routes/legacy-twilio-inbound.js for why.
require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { db } = require('./lib/context');

const ROOT = __dirname;
const originalCreateServer = http.createServer.bind(http);
const json = (res, status, body) => { const text = JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' }); res.end(text); };
async function ownerEmail(){if(process.env.SITEREMADE_UPDATES_EMAIL)return process.env.SITEREMADE_UPDATES_EMAIL;if(!db)return '';const owner=(await db.from('profiles').select('id').eq('role','owner').limit(1).maybeSingle()).data;if(!owner?.id)return '';const got=await db.auth.admin.getUserById(owner.id);return got.data?.user?.email||'';}
async function sendWebsiteUpdateEmail(updateId,eventName){if(!db||!process.env.RESEND_API_KEY||!updateId)return;try{const row=(await db.from('website_updates').select('*').eq('id',updateId).maybeSingle()).data;if(!row)return;const ws=(await db.from('workspaces').select('business_name,email').eq('id',row.workspace_id).maybeSingle()).data;const to=await ownerEmail();if(!to)return;const subject=`SiteRemade website request — ${ws?.business_name||'Client'}`;const lines=[`Business: ${ws?.business_name||'Client'}`,`Page: ${row.page}`,`Priority: ${row.priority}`,`Status: ${row.status}`,`Request: ${row.request}`,row.notes?`Notes: ${row.notes}`:'',`Event: ${eventName}`].filter(Boolean);await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.RESEND_FROM||'SiteRemade <hello@siteremade.com>',to:[to],subject,text:lines.join('\n')})});}catch(e){console.error('Website update email:',e.message);}}
function enhancedHtml(filename, mobile=false) { let html = fs.readFileSync(path.join(ROOT, filename), 'utf8'); if (!html.includes('/v17.css')) html = html.replace('</head>', '  <link rel="stylesheet" href="/v17.css?v=17" />\n</head>'); if (!html.includes('/v18.css')) html = html.replace('</head>', '  <link rel="stylesheet" href="/v18.css?v=18" />\n</head>'); if (!html.includes('/v19.css')) html = html.replace('</head>', '  <link rel="stylesheet" href="/v19.css?v=19" />\n</head>'); if (!html.includes('/v17-client.js')) html = html.replace('</body>', '  <script src="/v17-client.js?v=17"></script>\n</body>'); if (!html.includes('/v18-client.js')) html = html.replace('</body>', '  <script src="/v18-client.js?v=18"></script>\n</body>'); if (!html.includes('/v19-client.js')) html = html.replace('</body>', '  <script src="/v19-client.js?v=19"></script>\n</body>');
  if(mobile){
    html=html.replace(/\s*<script[^>]+src=["']\/v\d+[^"']*["'][^>]*><\/script>\s*/g,'\n');
  }
  return html;
}
http.createServer = function patchedCreateServer(listener) { return originalCreateServer(async (req, res) => { try { const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`); if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) { const body = enhancedHtml('index.html'); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' }); return res.end(body); } const watch=(req.method==='POST'&&u.pathname==='/api/app/website-updates')||(req.method==='PATCH'&&u.pathname.startsWith('/api/app/website-updates/'));if(watch){const end=res.end.bind(res);res.end=(chunk,...args)=>{end(chunk,...args);if(res.statusCode>=200&&res.statusCode<300){try{const payload=JSON.parse(Buffer.isBuffer(chunk)?chunk.toString('utf8'):String(chunk||''));const id=payload.websiteUpdate?.id;if(id)setImmediate(()=>sendWebsiteUpdateEmail(id,req.method==='POST'?'New request':'Status changed'));}catch{}}};}return listener(req, res); } catch (error) { console.error('V19 middleware:', error); if (!res.headersSent) return json(res, 500, { ok: false, message: 'Server error' }); res.end(); } }); };
