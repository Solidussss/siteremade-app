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
const { db } = require('../lib/context');

function normalizeBase(raw) { let v = String(raw || '').trim().replace(/\/$/, ''); if (v && !/^https?:\/\//i.test(v)) v = 'https://' + v; return v; }
const BASE = normalizeBase(process.env.UMAMI_BASE_URL), USER = process.env.UMAMI_USERNAME || '', PASS = process.env.UMAMI_PASSWORD || '';
let token = '', tokenAt = 0;
function readBody(req) { return new Promise((resolve, reject) => { let s = ''; req.on('data', c => { s += c; if (s.length > 1e6) reject(Error('Payload too large')); }); req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(Error('Invalid JSON')); } }); req.on('error', reject); }); }
function domainOf(raw) { try { return new URL(/^https?:\/\//i.test(String(raw || '')) ? String(raw) : 'https://' + String(raw || '')).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } }
async function authToken() { if (token && Date.now() - tokenAt < 45 * 60 * 1000) return token; if (!BASE || !USER || !PASS) throw Error('Umami is not configured'); const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) }); if (!r.ok) throw Error('Umami login failed (' + r.status + ')'); const j = await r.json(); token = j.token; tokenAt = Date.now(); return token; }
async function u(path, options = {}) { let t = await authToken(); let r = await fetch(BASE + path, { ...options, headers: { accept: 'application/json', 'content-type': 'application/json', authorization: 'Bearer ' + t, ...(options.headers || {}) } }); if (r.status === 401) { token = ''; t = await authToken(); r = await fetch(BASE + path, { ...options, headers: { accept: 'application/json', 'content-type': 'application/json', authorization: 'Bearer ' + t, ...(options.headers || {}) } }); } if (!r.ok) throw Error('Umami request failed (' + r.status + ')'); return r.json(); }
async function ensureWebsite(c, domain, name) { const current = (await db.from('website_analytics').select('*').eq('workspace_id', c.wid).maybeSingle()).data; let id = String(current?.provider || '').startsWith('umami:') ? String(current.provider).slice(6) : ''; if (id) { try { const old = await u('/api/websites/' + id); if (old.domain !== domain || old.name !== (name || c.workspace.business_name)) await u('/api/websites/' + id, { method: 'POST', body: JSON.stringify({ name: name || c.workspace.business_name || domain, domain }) }); } catch { id = ''; } } if (!id) { const list = await u('/api/websites?pageSize=100&search=' + encodeURIComponent(domain)); const found = (list.data || []).find(x => String(x.domain).replace(/^www\./, '').toLowerCase() === domain); const site = found || await u('/api/websites', { method: 'POST', body: JSON.stringify({ name: name || c.workspace.business_name || domain, domain }) }); id = site.id; } await db.from('website_analytics').upsert({ workspace_id: c.wid, domain, provider: 'umami:' + id, connected: true, updated_at: new Date().toISOString() }, { onConflict: 'workspace_id' }); return id; }
async function safeMetric(id, q, type, limit = 8) { try { return await u('/api/websites/' + id + '/metrics?' + q + '&type=' + encodeURIComponent(type) + '&limit=' + limit); } catch { return []; } }
async function analytics(c, url) { const row = (await db.from('website_analytics').select('*').eq('workspace_id', c.wid).maybeSingle()).data, id = String(row?.provider || '').startsWith('umami:') ? String(row.provider).slice(6) : ''; if (!id) return { connected: false, domain: row?.domain || '' }; const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30)), endAt = Date.now(), startAt = endAt - days * 86400000, q = 'startAt=' + startAt + '&endAt=' + endAt;
  const core = await Promise.all([u('/api/websites/' + id + '/stats?' + q), u('/api/websites/' + id + '/pageviews?' + q + '&unit=day'), u('/api/websites/' + id + '/active')]);
  const types = ['path', 'referrer', 'device', 'country', 'browser', 'os', 'entry', 'exit', 'channel', 'event']; const vals = await Promise.all(types.map(t => safeMetric(id, q, t, 10))); const [pages, referrers, devices, countries, browsers, os, entryPages, exitPages, channels, events] = vals;
  return { connected: true, domain: row.domain, days, stats: core[0], series: core[1], active: core[2], pages, referrers, devices, countries, browsers, os, entryPages, exitPages, channels, events }; }

module.exports = function registerUmamiAnalyticsRoutes(router) {
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
};
