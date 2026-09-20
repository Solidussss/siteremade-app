// Migrated from v30-google-auth.js's http.createServer route block
// (GET /auth/google, POST /api/auth/oauth-session). That file is NOT
// deleted: it still owns the res.end() wrapper that injects the "Continue
// with Google" button + supporting script into index.html, which is
// frontend-consolidation work for a later phase, not a route.
const { URL } = require('url');
const { db, anon, sendJson: json, readJsonBody: readJson } = require('../lib/context');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

function publicOrigin(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}
function sessionCookies(session) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return [
    `sr_access=${encodeURIComponent(session.access_token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(60, Number(session.expires_in) || 3600)}${secure}`,
    `sr_refresh=${encodeURIComponent(session.refresh_token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`
  ];
}
async function ensureProfileAndWorkspace(user) {
  if (!db) throw new Error('Supabase is not configured.');
  const existing = await db.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) return;
  const email = String(user.email || '').trim().toLowerCase();
  const meta = user.user_metadata || {};
  const name = String(meta.full_name || meta.name || email.split('@')[0] || 'SiteRemade User').trim().slice(0, 120);
  const p = await db.from('profiles').upsert({ id: user.id, name, role: 'client' });
  if (p.error) throw p.error;
  const workspace = await db.from('workspaces').insert({ business_name: `${name}'s Business`.slice(0, 160), email, timezone: 'America/Edmonton', currency: 'CAD', plan: 'Growth', ai_enabled: true, ai_services: '', ai_service_area: '', ai_tone: 'Helpful, concise, professional' }).select('*').single();
  if (workspace.error) throw workspace.error;
  const member = await db.from('workspace_members').insert({ workspace_id: workspace.data.id, user_id: user.id, role: 'admin' });
  if (member.error) throw member.error;
}

module.exports = function registerGoogleSigninRoutes(router) {
  router.get('/auth/google', { auth: 'none' }, async (req, res) => {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      res.writeHead(302, { Location: '/?auth_error=' + encodeURIComponent('Supabase auth is not configured.'), 'Cache-Control': 'no-store' });
      return res.end();
    }
    const redirectTo = `${publicOrigin(req)}/?google_oauth=1`;
    const url = new URL(`${SUPABASE_URL.replace(/\/$/, '')}/auth/v1/authorize`);
    url.searchParams.set('provider', 'google');
    url.searchParams.set('redirect_to', redirectTo);
    res.writeHead(302, { Location: url.toString(), 'Cache-Control': 'no-store' });
    res.end();
  });

  router.post('/api/auth/oauth-session', { auth: 'none' }, async (req, res) => {
    if (!anon || !db) return json(res, 503, { ok: false, message: 'Supabase auth is not configured.' });
    const body = await readJson(req);
    const accessToken = String(body.access_token || '').trim();
    const refreshToken = String(body.refresh_token || '').trim();
    if (!accessToken || !refreshToken) return json(res, 400, { ok: false, message: 'Google did not return a complete session.' });
    const verified = await anon.auth.getUser(accessToken);
    const user = verified.data?.user;
    if (verified.error || !user) return json(res, 401, { ok: false, message: 'Google session could not be verified.' });
    await ensureProfileAndWorkspace(user);
    return json(res, 200, { ok: true }, sessionCookies({ access_token: accessToken, refresh_token: refreshToken, expires_in: Number(body.expires_in) || 3600 }));
  });
};
