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
//
// Phase 6: a second way to identify the site — by its SiteRemade builder
// project id — for sites exported from the builder and hosted by the
// customer themselves (the builder's export README documents the tag):
//
//   <script defer src="<app>/siteremade-analytics.js?project=proj_…"></script>
//     -> GET /api/public/analytics-config-by-project?projectId=proj_…
//
// The owning workspace is resolved HERE, server-side, from
// website_project_links (lib/website-links.js findWorkspaceForProject — the
// same safe lookup POST /api/public/site-submission uses). No workspace id,
// public key or domain is involved, so a domain change never affects it.
// Both lookups share one function (umamiConfigForWorkspace) and one
// bootstrap script builder, so the two paths can't drift apart.
const { db } = require('../lib/context');
const websiteLinks = require('../lib/website-links');
const publicLimits = require('../lib/public-rate-limit');

let UMAMI = String(process.env.UMAMI_BASE_URL || '').trim().replace(/\/$/, ''); if (UMAMI && !/^https?:\/\//i.test(UMAMI)) UMAMI = 'https://' + UMAMI;
const send = (res, status, obj, type = 'application/json; charset=utf-8') => { const body = typeof obj === 'string' ? obj : JSON.stringify(obj); res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }); res.end(body); };

// The one place a workspace's tracker config is read (the site id Phase 5's
// provisioning stored as website_analytics.provider = 'umami:<uuid>').
async function umamiConfigForWorkspace(wid) { const row = (await db.from('website_analytics').select('domain,provider,connected').eq('workspace_id', wid).maybeSingle()).data; const provider = String(row?.provider || ''); const websiteId = provider.startsWith('umami:') ? provider.slice(6) : ''; return { domain: row?.domain || '', connected: !!row?.connected && !!websiteId, websiteId }; }
async function config(workspaceId, publicKey) { if (!db) return null; const ws = (await db.from('workspaces').select('id').eq('id', String(workspaceId || '')).eq('public_key', String(publicKey || '')).maybeSingle()).data; if (!ws) return null; return umamiConfigForWorkspace(ws.id); }
async function configByProject(projectId) { if (!db) return null; const wid = await websiteLinks.findWorkspaceForProject(String(projectId || '')); if (!wid) return null; return umamiConfigForWorkspace(wid); }
// Same response for both lookups: 404 unknown, 409 not set up yet, 200 with
// the Umami script + site id (the tracker identifies the site by
// data-website-id alone; the stored domain is display metadata).
function sendConfig(res, c) {
  if (!c) return send(res, 404, { ok: false });
  if (!c.connected) return send(res, 409, { ok: false, setupRequired: true, domain: c.domain });
  return send(res, 200, { ok: true, script: UMAMI + '/script.js', websiteId: c.websiteId, domain: c.domain });
}

// One bootstrap script for both identities. `window.__srUmamiBoot` makes a
// page that carries BOTH the widget embed and the project tag load the
// tracker once, not twice (the old data-sr-umami check alone raced: both
// copies could be mid-fetch before either inserted its script).
function bootstrap(u) {
  const project = String(u.searchParams.get('project') || '');
  const lookup = websiteLinks.PROJECT_ID_RE.test(project)
    ? { ok: `!0`, url: `'/api/public/analytics-config-by-project?projectId='+encodeURIComponent(${JSON.stringify(project)})` }
    : { ok: `W&&K`, url: `'/api/public/analytics-config?workspaceId='+encodeURIComponent(W)+'&publicKey='+encodeURIComponent(K)` };
  const w = JSON.stringify(String(u.searchParams.get('workspace') || '')), k = JSON.stringify(String(u.searchParams.get('key') || '')), base = JSON.stringify(process.env.PUBLIC_BASE_URL || '');
  return `(function(){try{var W=${w},K=${k},B=${base};if(!(${lookup.ok})||window.__srUmamiBoot||document.querySelector('script[data-sr-umami]'))return;window.__srUmamiBoot=1;fetch(B+${lookup.url},{mode:'cors'}).then(function(r){return r.ok?r.json():null}).then(function(c){if(!c||!c.ok||!c.websiteId||!c.script||document.querySelector('script[data-sr-umami]'))return;var s=document.createElement('script');s.defer=true;s.src=c.script;s.setAttribute('data-website-id',c.websiteId);s.setAttribute('data-sr-umami','1');document.head.appendChild(s)}).catch(function(){});}catch(e){}})();`;
}

module.exports = function registerAnalyticsBootstrapRoutes(router) {
  router.get('/siteremade-analytics.js', { auth: 'none' }, async (req, res, { u }) => {
    return send(res, 200, bootstrap(u), 'application/javascript; charset=utf-8');
  });

  router.get('/api/public/analytics-config', { auth: 'none' }, async (req, res, { u }) => {
    return sendConfig(res, await config(u.searchParams.get('workspaceId'), u.searchParams.get('publicKey')));
  });

  router.get('/api/public/analytics-config-by-project', { auth: 'none' }, async (req, res, { u }) => {
    const projectId = String(u.searchParams.get('projectId') || '').trim();
    if (!websiteLinks.PROJECT_ID_RE.test(projectId)) return send(res, 400, { ok: false, message: 'A valid site identifier is required.' });
    const r = publicLimits.analyticsConfigPerIp.take(publicLimits.clientIp(req));
    if (!r.ok) { res.setHeader('Retry-After', String(r.retryAfterSeconds || 60)); return send(res, 429, { ok: false, code: 'rate_limited', retryAfterSeconds: r.retryAfterSeconds || 60 }); }
    let c;
    try { c = await configByProject(projectId); } catch (e) { console.warn('[analytics] config-by-project lookup failed:', e && e.message); return send(res, 503, { ok: false }); }
    return sendConfig(res, c);
  });
};
