// Migrated from v24-umami-server.js (deleted). Logic is unchanged — only
// the http.createServer wrapper + manual path/method checks were replaced
// by router.get/post() + { auth: 'user' }.
//
// The original handled GET and POST identically for both
// /api/app/umami/analytics and /api/app/analytics/website EXCEPT for one
// special case: POST /api/app/analytics/website runs the "connect this
// domain" flow (ensureWebsite), while every other method/path combination
// (including POST /api/app/umami/analytics) just returns the analytics
// snapshot, ignoring any request body. That's preserved exactly below —
// three of the four registered routes call the same analytics() handler.
//
// Phase 5: ensureWebsite() no longer adopts an existing Umami site by
// domain (cross-workspace bug -- see its comment), and
// provisionWorkspaceSite() is exported for routes/website-bridge.js to set
// up a workspace's site when it is first linked to its builder project.
const { db } = require('../lib/context');

function normalizeBase(raw) { let v = String(raw || '').trim().replace(/\/$/, ''); if (v && !/^https?:\/\//i.test(v)) v = 'https://' + v; return v; }
const BASE = normalizeBase(process.env.UMAMI_BASE_URL), USER = process.env.UMAMI_USERNAME || '', PASS = process.env.UMAMI_PASSWORD || '';
let token = '', tokenAt = 0;
function readBody(req) { return new Promise((resolve, reject) => { let s = ''; req.on('data', c => { s += c; if (s.length > 1e6) reject(Error('Payload too large')); }); req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(Error('Invalid JSON')); } }); req.on('error', reject); }); }
function domainOf(raw) { try { return new URL(/^https?:\/\//i.test(String(raw || '')) ? String(raw) : 'https://' + String(raw || '')).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } }
async function authToken() { if (token && Date.now() - tokenAt < 45 * 60 * 1000) return token; if (!BASE || !USER || !PASS) throw Error('Umami is not configured'); const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) }); if (!r.ok) throw Error('Umami login failed (' + r.status + ')'); const j = await r.json(); token = j.token; tokenAt = Date.now(); return token; }
async function u(path, options = {}) { let t = await authToken(); let r = await fetch(BASE + path, { ...options, headers: { accept: 'application/json', 'content-type': 'application/json', authorization: 'Bearer ' + t, ...(options.headers || {}) } }); if (r.status === 401) { token = ''; t = await authToken(); r = await fetch(BASE + path, { ...options, headers: { accept: 'application/json', 'content-type': 'application/json', authorization: 'Bearer ' + t, ...(options.headers || {}) } }); } if (!r.ok) throw Object.assign(Error('Umami request failed (' + r.status + ')'), { status: r.status }); return r.json(); }
// Phase 5 (analytics identity fix): a workspace only ever reuses the Umami
// site whose uuid IT has stored (website_analytics.provider = 'umami:<uuid>').
// The previous version, when nothing was stored yet, searched Umami for ANY
// site whose domain matched the typed domain and adopted it -- so two
// workspaces typing the same domain string ended up sharing one Umami site
// (each seeing the other's traffic), and re-entering a domain renamed a site
// another workspace was using. That search-and-adopt branch is gone: with no
// stored uuid, a brand-new site is always created. A stored uuid is only
// abandoned when Umami itself answers 404 for it; any other Umami error is
// passed up (nothing is overwritten on a transient failure).
const PENDING_DOMAIN = 'pending.siteremade.invalid'; // RFC 2606 reserved name: an honest "no domain yet", never a real host
const storedUmamiId = row => (String(row?.provider || '').startsWith('umami:') ? String(row.provider).slice(6) : '');
async function ensureWebsite(c, domain, name) { return ensureWorkspaceSite(c.wid, c.workspace.business_name, domain, name); }
async function ensureWorkspaceSite(wid, businessName, domain, name) {
  const current = (await db.from('website_analytics').select('*').eq('workspace_id', wid).maybeSingle()).data;
  let id = storedUmamiId(current);
  const label = name || businessName || domain || 'SiteRemade website';
  if (id) { try { const old = await u('/api/websites/' + id); if (domain && (old.domain !== domain || old.name !== label)) await u('/api/websites/' + id, { method: 'POST', body: JSON.stringify({ name: label, domain }) }); } catch (e) { if (e.status !== 404) throw e; id = ''; } }
  if (!id) { const site = await u('/api/websites', { method: 'POST', body: JSON.stringify({ name: label, domain: domain || PENDING_DOMAIN }) }); id = site.id; }
  const t = new Date().toISOString();
  await db.from('website_analytics').upsert({ workspace_id: wid, domain: domain || current?.domain || '', provider: 'umami:' + id, connected: true, updated_at: t }, { onConflict: 'workspace_id' });
  // Mirror onto the workspace's builder-project link, if it has one (no-op otherwise).
  await db.from('website_project_links').update({ analytics_site_id: id, updated_at: t }).eq('workspace_id', wid);
  return id;
}
// Phase 5: server-side provisioning when a workspace is first linked to its
// builder project (routes/website-bridge.js) -- no domain needed up front.
// Never touches a site the workspace already has: an existing stored uuid is
// just mirrored onto the link. Resolves {ok, id?, reason?}; never throws.
async function provisionWorkspaceSite(wid, { name, domain } = {}) {
  try {
    if (!db || !wid) return { ok: false, reason: 'not_configured' };
    const current = (await db.from('website_analytics').select('*').eq('workspace_id', wid).maybeSingle()).data;
    const existing = storedUmamiId(current);
    if (existing) {
      await db.from('website_project_links').update({ analytics_site_id: existing, updated_at: new Date().toISOString() }).eq('workspace_id', wid);
      return { ok: true, id: existing, reused: true };
    }
    if (!BASE || !USER || !PASS) return { ok: false, reason: 'not_configured' };
    return { ok: true, id: await ensureWorkspaceSite(wid, name, domain || '', name), reused: false };
  } catch (e) {
    console.warn('[umami] provisioning failed:', e && e.message);
    return { ok: false, reason: 'error' };
  }
}
async function safeMetric(id, q, type, limit = 8) { try { return await u('/api/websites/' + id + '/metrics?' + q + '&type=' + encodeURIComponent(type) + '&limit=' + limit); } catch { return []; } }
async function analytics(c, url) { const row = (await db.from('website_analytics').select('*').eq('workspace_id', c.wid).maybeSingle()).data, id = String(row?.provider || '').startsWith('umami:') ? String(row.provider).slice(6) : ''; if (!id) return { connected: false, domain: row?.domain || '' }; const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30)), endAt = Date.now(), startAt = endAt - days * 86400000, q = 'startAt=' + startAt + '&endAt=' + endAt;
  const core = await Promise.all([u('/api/websites/' + id + '/stats?' + q), u('/api/websites/' + id + '/pageviews?' + q + '&unit=day'), u('/api/websites/' + id + '/active')]);
  const types = ['path', 'referrer', 'device', 'country', 'browser', 'os', 'entry', 'exit', 'channel', 'event']; const vals = await Promise.all(types.map(t => safeMetric(id, q, t, 10))); const [pages, referrers, devices, countries, browsers, os, entryPages, exitPages, channels, events] = vals;
  return { connected: true, domain: row.domain, days, stats: core[0], series: core[1], active: core[2], pages, referrers, devices, countries, browsers, os, entryPages, exitPages, channels, events }; }

function registerUmamiAnalyticsRoutes(router) {
  const analyticsHandler = async (req, res, { c, u: url, json }) => {
    try {
      return json(res, 200, { ok: true, ...await analytics(c, url) });
    } catch (e) {
      return json(res, 502, { ok: false, message: e.message || 'Analytics unavailable' });
    }
  };

  router.get('/api/app/umami/analytics', { auth: 'user' }, analyticsHandler);
  router.post('/api/app/umami/analytics', { auth: 'user' }, analyticsHandler);
  router.get('/api/app/analytics/website', { auth: 'user' }, analyticsHandler);

  router.post('/api/app/analytics/website', { auth: 'user' }, async (req, res, { c, json }) => {
    try {
      const b = await readBody(req), domain = domainOf(b.domain);
      if (!domain) return json(res, 400, { ok: false, message: 'Enter a valid website domain.' });
      const id = await ensureWebsite(c, domain, b.businessName);
      return json(res, 200, { ok: true, connected: true, domain, tracker: { src: BASE + '/script.js', websiteId: id }, websiteAnalytics: { domain, provider: 'umami', connected: true } });
    } catch (e) {
      return json(res, 502, { ok: false, message: e.message || 'Analytics unavailable' });
    }
  });
}

module.exports = registerUmamiAnalyticsRoutes;
module.exports.provisionWorkspaceSite = provisionWorkspaceSite;
