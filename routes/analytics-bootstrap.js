// Migrated from v20-traffic-server.js (deleted). Logic is unchanged — only
// the http.createServer wrapper + manual path/method checks were replaced
// by router.get() + { auth: 'none' } (both routes are public: the
// bootstrap script is embedded on customer websites, and the config
// lookup authenticates via workspaceId+publicKey query params, not a
// session).
//
// Keeps its own `send` helper (not lib/context's sendJson) because these
// responses need a CORS header on every response and a non-JSON content
// type for the bootstrap script — sendJson always writes
// 'application/json' with no CORS header.
const { db } = require('../lib/context');

let UMAMI = String(process.env.UMAMI_BASE_URL || '').trim().replace(/\/$/, ''); if (UMAMI && !/^https?:\/\//i.test(UMAMI)) UMAMI = 'https://' + UMAMI;
const send = (res, status, obj, type = 'application/json; charset=utf-8') => { const body = typeof obj === 'string' ? obj : JSON.stringify(obj); res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }); res.end(body); };
async function config(workspaceId, publicKey) { if (!db) return null; const ws = (await db.from('workspaces').select('id').eq('id', String(workspaceId || '')).eq('public_key', String(publicKey || '')).maybeSingle()).data; if (!ws) return null; const row = (await db.from('website_analytics').select('domain,provider,connected').eq('workspace_id', ws.id).maybeSingle()).data; const provider = String(row?.provider || ''); const websiteId = provider.startsWith('umami:') ? provider.slice(6) : ''; return { domain: row?.domain || '', connected: !!row?.connected && !!websiteId, websiteId }; }
function bootstrap(u) { const w = JSON.stringify(String(u.searchParams.get('workspace') || '')), k = JSON.stringify(String(u.searchParams.get('key') || '')), base = JSON.stringify(process.env.PUBLIC_BASE_URL || ''); return `(function(){try{var W=${w},K=${k},B=${base};if(!W||!K||document.querySelector('script[data-sr-umami]'))return;fetch(B+'/api/public/analytics-config?workspaceId='+encodeURIComponent(W)+'&publicKey='+encodeURIComponent(K),{mode:'cors'}).then(function(r){return r.ok?r.json():null}).then(function(c){if(!c||!c.ok||!c.websiteId||!c.script)return;var s=document.createElement('script');s.defer=true;s.src=c.script;s.setAttribute('data-website-id',c.websiteId);s.setAttribute('data-sr-umami','1');document.head.appendChild(s)}).catch(function(){});}catch(e){}})();`; }

module.exports = function registerAnalyticsBootstrapRoutes(router) {
  router.get('/siteremade-analytics.js', { auth: 'none' }, async (req, res, { u }) => {
    return send(res, 200, bootstrap(u), 'application/javascript; charset=utf-8');
  });

  router.get('/api/public/analytics-config', { auth: 'none' }, async (req, res, { u }) => {
    const c = await config(u.searchParams.get('workspaceId'), u.searchParams.get('publicKey'));
    if (!c) return send(res, 404, { ok: false });
    if (!c.connected) return send(res, 409, { ok: false, setupRequired: true, domain: c.domain });
    return send(res, 200, { ok: true, script: UMAMI + '/script.js', websiteId: c.websiteId, domain: c.domain });
  });
};
