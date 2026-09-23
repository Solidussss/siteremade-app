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
//
// Phase 9 (V55-WEBSITE-ANALYTICS-MULTI-PROJECT-MIGRATION.sql): every core
// function below (ensureWorkspaceSite/provisionWorkspaceSite/analytics)
// gained an OPTIONAL trailing `projectId` parameter, default null. Every
// call site that predates Phase 9 never passes one, so it keeps reading/
// writing the exact same legacy row (project_id IS NULL) it always did --
// byte-identical behavior, not just "should be." A real projectId is only
// ever passed by the new project-scoped routes at the bottom of this file.
// Once a workspace can hold more than one website_analytics row (a legacy
// one plus any project-scoped ones), every lookup MUST filter on
// project_id too -- `.eq('workspace_id', wid).maybeSingle()` alone would
// throw the moment a second row exists for that workspace. See this
// file's own projectFilter() helper, used everywhere workspace_id used to
// appear alone.
const { db } = require('../lib/context');
const websiteLinks = require('../lib/website-links');

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
// Phase 6 (Umami compatibility, checked against Umami's own source): its
// website create/update API validates `domain` with
//   z.string().trim().regex(DOMAIN_REGEX).max(500)      (src/app/api/websites/request-schema.ts)
// and `name` with z.string().trim().min(1).max(100). DOMAIN_REGEX (src/lib/
// constants.ts) is copied verbatim below: lowercase hostname labels plus a
// 2-63 char TLD (or localhost[:port]). So an EMPTY domain is refused, a
// placeholder is required until a real domain exists, and
// 'pending.siteremade.invalid' passes (three lowercase labels, TLD
// "invalid"). Umami's collect endpoint (/api/send) looks the site up by
// website id only and never compares the page's hostname to the stored
// domain; the tracker only filters by hostname when a page opts in with
// data-domains (ours never does). So the stored domain is display metadata:
// changing it later keeps the same website id, and tracking continues.
const UMAMI_DOMAIN_RE = /^(localhost(:[1-9]\d{0,4})?|((?=[a-z0-9-_]{1,63}\.)(xn--)?[a-z0-9-_]+(-[a-z0-9-_]+)*\.)+(xn--)?[a-z0-9-_]{2,63})$/;
const umamiDomainOk = d => typeof d === 'string' && d.length <= 500 && UMAMI_DOMAIN_RE.test(d);
const umamiName = v => String(v || '').trim().slice(0, 100).trim();
const storedUmamiId = row => (String(row?.provider || '').startsWith('umami:') ? String(row.provider).slice(6) : '');
// Phase 9: applies the "legacy row" (project_id IS NULL) or "this specific
// project's row" (project_id = projectId) filter consistently -- the one
// thing every website_analytics query must do once a workspace can hold
// more than one row (see this file's header and V55's own comment on why
// workspace_id alone is no longer safe to filter by).
function projectFilter(query, projectId) { return projectId ? query.eq('project_id', projectId) : query.is('project_id', null); }
// Mirrors a provisioned Umami site id onto website_project_links.
// analytics_site_id. When projectId is known, scoped to exactly that link
// row (the only correct target once a workspace can have several).
// Legacy (no projectId) callers only mirror when the workspace has
// EXACTLY ONE link -- with several, "which one" is genuinely ambiguous,
// and writing the same id onto every linked project's row would silently
// claim they all share one Umami site, which is exactly the bug this
// migration exists to prevent. Never throws; a skipped mirror doesn't
// fail provisioning (website_analytics itself is the source of truth).
async function mirrorAnalyticsSiteId(wid, projectId, umamiId, t) {
  try {
    if (projectId) { await db.from('website_project_links').update({ analytics_site_id: umamiId, updated_at: t }).eq('workspace_id', wid).eq('generator_project_id', projectId); return; }
    const links = await websiteLinks.listLinksForWorkspace(wid);
    if (links.length === 1) await db.from('website_project_links').update({ analytics_site_id: umamiId, updated_at: t }).eq('workspace_id', wid).eq('generator_project_id', links[0].generator_project_id);
  } catch (e) { console.warn('[umami] could not mirror analytics_site_id onto link:', e && e.message); }
}
async function ensureWebsite(c, domain, name, projectId = null) { return ensureWorkspaceSite(c.wid, c.workspace.business_name, domain, name, projectId); }
async function ensureWorkspaceSite(wid, businessName, domain, name, projectId = null) {
  const current = (await projectFilter(db.from('website_analytics').select('*').eq('workspace_id', wid), projectId).maybeSingle()).data;
  let id = storedUmamiId(current);
  if (!umamiDomainOk(domain)) domain = ''; // never send Umami a value its schema refuses
  const label = umamiName(name) || umamiName(businessName) || umamiName(domain) || 'SiteRemade website';
  if (id) { try { const old = await u('/api/websites/' + id); if (domain && (old.domain !== domain || old.name !== label)) await u('/api/websites/' + id, { method: 'POST', body: JSON.stringify({ name: label, domain }) }); } catch (e) { if (e.status !== 404) throw e; id = ''; } }
  if (!id) { const site = await u('/api/websites', { method: 'POST', body: JSON.stringify({ name: label, domain: domain || PENDING_DOMAIN }) }); id = site.id; }
  const t = new Date().toISOString();
  if (current) await projectFilter(db.from('website_analytics').update({ domain: domain || current?.domain || '', provider: 'umami:' + id, connected: true, updated_at: t }).eq('workspace_id', wid), projectId);
  else await db.from('website_analytics').insert({ workspace_id: wid, project_id: projectId, domain: domain || '', provider: 'umami:' + id, connected: true, updated_at: t });
  // Mirror onto the workspace's builder-project link, if it has one (no-op otherwise).
  await mirrorAnalyticsSiteId(wid, projectId, id, t);
  return id;
}
// Phase 5: server-side provisioning when a workspace is first linked to its
// builder project (routes/website-bridge.js) -- no domain needed up front.
// Never touches a site the workspace already has: an existing stored uuid is
// just mirrored onto the link. Resolves {ok, id?, reason?}; never throws.
//
// Phase 9: projectId (optional, default null for legacy callers) scopes
// which website_analytics row is read/written -- see ensureWorkspaceSite.
async function provisionWorkspaceSite(wid, { name, domain } = {}, projectId = null) {
  try {
    if (!db || !wid) return { ok: false, reason: 'not_configured' };
    const current = (await projectFilter(db.from('website_analytics').select('*').eq('workspace_id', wid), projectId).maybeSingle()).data;
    const existing = storedUmamiId(current);
    if (existing) {
      await mirrorAnalyticsSiteId(wid, projectId, existing, new Date().toISOString());
      return { ok: true, id: existing, reused: true };
    }
    if (!BASE || !USER || !PASS) return { ok: false, reason: 'not_configured' };
    return { ok: true, id: await ensureWorkspaceSite(wid, name, domain || '', name, projectId), reused: false };
  } catch (e) {
    console.warn('[umami] provisioning failed:', e && e.message);
    return { ok: false, reason: 'error' };
  }
}
async function safeMetric(id, q, type, limit = 8) { try { return await u('/api/websites/' + id + '/metrics?' + q + '&type=' + encodeURIComponent(type) + '&limit=' + limit); } catch { return []; } }
// Phase 9: projectId (optional, default null) selects which
// website_analytics row this reads -- see this file's header.
async function analytics(c, url, projectId = null) {
  const row = (await projectFilter(db.from('website_analytics').select('*').eq('workspace_id', c.wid), projectId).maybeSingle()).data, id = String(row?.provider || '').startsWith('umami:') ? String(row.provider).slice(6) : ''; if (!id) return { connected: false, domain: row?.domain || '' }; const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30)), endAt = Date.now(), startAt = endAt - days * 86400000, q = 'startAt=' + startAt + '&endAt=' + endAt;
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
      if (!domain || !umamiDomainOk(domain)) return json(res, 400, { ok: false, message: 'Enter a valid website domain.' });
      // Phase 8: without UMAMI_* nothing can be set up and nothing is
      // written (ensureWorkspaceSite would throw before its upsert), so say
      // exactly that in customer terms -- this message is shown verbatim
      // under Settings -> "Your website address". It used to surface as a
      // 502 "Umami is not configured", which read like a transient outage
      // and never said the address hadn't been kept.
      if (!BASE || !USER || !PASS) return json(res, 503, { ok: false, code: 'analytics_not_configured', message: 'Visitor analytics isn’t available on SiteRemade yet, so your address wasn’t saved. Nothing on your website has changed.' });
      const id = await ensureWebsite(c, domain, b.businessName);
      return json(res, 200, { ok: true, connected: true, domain, tracker: { src: BASE + '/script.js', websiteId: id }, websiteAnalytics: { domain, provider: 'umami', connected: true } });
    } catch (e) {
      return json(res, 502, { ok: false, message: e.message || 'Analytics unavailable' });
    }
  });
}

module.exports = registerUmamiAnalyticsRoutes;
module.exports.provisionWorkspaceSite = provisionWorkspaceSite;
// Phase 9: exported so routes/website-bridge.js's project-scoped analytics
// routes can call the same project-aware core directly, after doing its own
// forWorkspaceProject ownership check -- rather than duplicating this file's
// Umami-request/DB logic there.
module.exports.analytics = analytics;
module.exports.ensureWorkspaceSite = ensureWorkspaceSite;
module.exports.umamiDomainOk = umamiDomainOk;
module.exports.domainOf = domainOf;
module.exports.umamiConfigured = () => !!(BASE && USER && PASS);
