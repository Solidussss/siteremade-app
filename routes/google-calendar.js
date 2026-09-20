// Migrated from v35-google-calendar.js (deleted, loaded via v35-loader.js
// which is also deleted). Logic is unchanged — only the http.createServer
// wrapper + manual path/method checks were replaced by router.get/post()
// + { auth: 'user' }. Note google-calendar/start redirects to
// /api/app/gmail/start?calendar=1 (routes/gmail-direct.js), which ignores
// that query param and always requests calendar scope anyway — that was
// already true before this migration, so it's preserved as-is.
//
// Known minor behavior difference: the original had a catch-all for any
// OTHER method/path under /api/app/integrations/google-calendar/* — after
// requiring auth, it returned 404 {message:'Calendar route not found.'}
// for anything not matching one of the three routes below. The router has
// no path-prefix wildcard, so an unlisted subpath now falls through to
// the app's generic 404 instead of that specific message (and without
// first requiring auth). No real client ever calls an unlisted subpath
// under this prefix, so this doesn't affect the three live routes.
const { db } = require('../lib/context');

const googleId = process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_GMAIL_CLIENT_ID || '';
const googleSecret = process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_GMAIL_CLIENT_SECRET || '';
async function connection(wid) { return (await db.from('mailbox_connections').select('*').eq('workspace_id', wid).eq('provider', 'gmail').maybeSingle()).data || null; }
function hasCalendarScope(row) { const s = String(row?.scope || ''); return s.includes('calendar.events') || s.includes('/auth/calendar'); }
async function fresh(row) { if (!row) return null; if (row.expires_at && new Date(row.expires_at).getTime() > Date.now() + 60000) return row; if (!row.refresh_token) return row; const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: googleId, client_secret: googleSecret, grant_type: 'refresh_token', refresh_token: row.refresh_token }) }); const j = await r.json(); if (!r.ok || !j.access_token) throw Error(j.error_description || j.error || 'Google token refresh failed'); const patch = { access_token: j.access_token, refresh_token: j.refresh_token || row.refresh_token, expires_at: new Date(Date.now() + Number(j.expires_in || 3600) * 1000).toISOString(), scope: j.scope || row.scope || '', updated_at: new Date().toISOString() }; await db.from('mailbox_connections').update(patch).eq('workspace_id', row.workspace_id); return { ...row, ...patch }; }
async function cal(row, path, opts = {}) { row = await fresh(row); const r = await fetch('https://www.googleapis.com/calendar/v3' + path, { ...opts, headers: { Authorization: 'Bearer ' + row.access_token, 'Content-Type': 'application/json', ...(opts.headers || {}) } }); const j = await r.json().catch(() => ({})); if (!r.ok) throw Error(j.error?.message || 'Google Calendar request failed'); return j; }
async function syncCalendar(c) { let row = await connection(c.wid); if (!row) throw Error('Connect Google first.'); row = await fresh(row); if (!hasCalendarScope(row)) throw Error('Reconnect Google Calendar to grant calendar access.'); const now = Date.now(), from = new Date(now - 30 * 86400000).toISOString(), to = new Date(now + 365 * 86400000).toISOString(); const appts = (await db.from('appointments').select('*').eq('workspace_id', c.wid).gte('start_at', from).lte('start_at', to).order('start_at')).data || []; let created = 0, updated = 0; for (const a of appts) { const start = new Date(a.start_at); if (!Number.isFinite(start.getTime())) continue; const duration = Math.max(15, Number(a.duration) || 60); const end = new Date(start.getTime() + duration * 60000); const marker = 'siteremadeAppointmentId=' + a.id; const q = new URLSearchParams({ privateExtendedProperty: marker, singleEvents: 'true', maxResults: '2' }); const found = (await cal(row, '/calendars/primary/events?' + q.toString())).items?.[0]; const event = { summary: a.title || a.customer || 'SiteRemade appointment', description: [a.customer ? `Customer: ${a.customer}` : '', a.notes || '', 'Managed by SiteRemade'].filter(Boolean).join('\n'), start: { dateTime: start.toISOString(), timeZone: c.workspace?.timezone || 'America/Edmonton' }, end: { dateTime: end.toISOString(), timeZone: c.workspace?.timezone || 'America/Edmonton' }, extendedProperties: { private: { siteremadeAppointmentId: a.id } } }; if (found) { await cal(row, '/calendars/primary/events/' + encodeURIComponent(found.id), { method: 'PATCH', body: JSON.stringify(event) }); updated++; } else { await cal(row, '/calendars/primary/events', { method: 'POST', body: JSON.stringify(event) }); created++; } } return { created, updated, total: appts.length }; }

module.exports = function registerGoogleCalendarRoutes(router) {
  router.get('/api/app/integrations/google-calendar/status', { auth: 'user' }, async (req, res, { c, json }) => {
    const row = await connection(c.wid);
    return json(res, 200, { ok: true, configured: !!(googleId && googleSecret), connected: !!row && hasCalendarScope(row), email: row?.email || '' });
  });

  router.get('/api/app/integrations/google-calendar/start', { auth: 'user' }, async (req, res) => {
    res.writeHead(302, { Location: '/api/app/gmail/start?calendar=1', 'Cache-Control': 'no-store' });
    return res.end();
  });

  router.post('/api/app/integrations/google-calendar/sync', { auth: 'user' }, async (req, res, { c, json }) => {
    const result = await syncCalendar(c);
    return json(res, 200, { ok: true, ...result });
  });
};
