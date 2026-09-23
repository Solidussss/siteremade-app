// Shared auth/session/workspace/context module.
//
// Before this file existed, ~11 of the vNN-*.js route files each carried
// their own copy of: Supabase client construction, cookie parsing, JSON
// body reading, JSON response writing, session refresh, and
// workspace/membership resolution. That duplication is how the app ended up
// with subtly different behavior in different files (some routes silently
// never got session-refresh support; some fetched a full workspace row,
// others only `id, business_name`). This module is now the one
// implementation; every route file requires it instead of reimplementing it.
//
// This intentionally does NOT touch the http.createServer monkeypatch-chain
// dispatch pattern each vNN file uses — that's a separate, later cleanup.
// This module only removes the duplicated logic *inside* each handler.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_SERVICE_ROLE_KEY);

// Service-role client (server-side only — never expose this key to the browser)
// and anon client (used only to verify/refresh a user's own access token).
const db = configured ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
const anon = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } }) : null;

function cookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map(x => x.trim().split('='))
      .filter(x => x[0])
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
  );
}

function authCookies(session) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return [
    `sr_access=${encodeURIComponent(session.access_token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(60, session.expires_in || 3600)}${secure}`,
    `sr_refresh=${encodeURIComponent(session.refresh_token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`
  ];
}

function clearAuthCookies() {
  return [
    'sr_access=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    'sr_refresh=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    'sr_workspace=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
  ];
}

function sendJson(res, status, obj, cookieHeaders = []) {
  const body = JSON.stringify(obj);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  };
  if (cookieHeaders.length) headers['Set-Cookie'] = cookieHeaders;
  res.writeHead(status, headers);
  res.end(body);
}

function readJsonBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// Resolves the signed-in user + profile from the sr_access/sr_refresh
// cookies, refreshing the session and setting new cookies on `res` if the
// access token was expired. Returns null if there is no valid session.
// `res` is optional — if omitted, a refreshed session simply won't be able
// to set new cookies (matches the previous behavior of the handful of
// routes that never supported refresh at all).
async function getAuthUser(req, res) {
  if (!db || !anon) return null;
  const c = cookies(req);
  let access = c.sr_access;
  let user = null;
  if (access) user = (await anon.auth.getUser(access)).data?.user || null;
  let renewed = null;
  if (!user && c.sr_refresh) {
    const r = await anon.auth.refreshSession({ refresh_token: c.sr_refresh });
    if (!r.error && r.data?.session) {
      renewed = r.data.session;
      access = renewed.access_token;
      user = r.data.user;
    }
  }
  if (!user) return null;
  const profile = (await db.from('profiles').select('*').eq('id', user.id).maybeSingle()).data;
  if (!profile) return null;
  if (renewed && res && typeof res.setHeader === 'function') res.setHeader('Set-Cookie', authCookies(renewed));
  return { user, profile, access };
}

async function membershipsFor(userId, owner = false) {
  if (owner) return (await db.from('workspaces').select('*').order('created_at', { ascending: true })).data || [];
  const memberships = (await db.from('workspace_members').select('workspace_id,workspaces(*)').eq('user_id', userId)).data || [];
  return memberships.map(m => m.workspaces).filter(Boolean);
}

// Full request context: signed-in user + profile + owner flag + every
// workspace the user can access + which one is "current" + that workspace's
// full row. `u` is an optional parsed URL — when passed, ?workspaceId= is
// honored as a workspace-selection source in addition to the
// x-workspace-id header and sr_workspace cookie (server.js's bootstrap
// route is the one place that historically supported this).
async function getContext(req, res, u) {
  const auth = await getAuthUser(req, res);
  if (!auth) return null;
  const owner = auth.profile.role === 'owner';
  const workspaces = await membershipsFor(auth.user.id, owner);
  if (!workspaces.length) return null;
  const c = cookies(req);
  let wid = req.headers['x-workspace-id'] || (u && u.searchParams ? u.searchParams.get('workspaceId') : null) || c.sr_workspace || workspaces[0].id;
  if (!workspaces.some(w => w.id === wid)) wid = workspaces[0].id;
  return { ...auth, owner, workspaces, wid, workspace: workspaces.find(w => w.id === wid) };
}

function hasSiteRemadeAccess(c) {
  if (!c) return false;
  if (c.owner) return true;
  return ['active', 'trialing'].includes(String(c.workspace?.siteremade_subscription_status || 'inactive').toLowerCase());
}

function requireSiteRemadeAccess(c, json, res) {
  if (hasSiteRemadeAccess(c)) return true;
  json(res, 402, { ok: false, code: 'SUBSCRIPTION_REQUIRED', message: 'An active SiteRemade Workplace subscription is required to use this feature.' });
  return false;
}

module.exports = {
  db,
  anon,
  configured,
  cookies,
  authCookies,
  clearAuthCookies,
  sendJson,
  readJsonBody,
  getAuthUser,
  membershipsFor,
  getContext,
  hasSiteRemadeAccess,
  requireSiteRemadeAccess
};
