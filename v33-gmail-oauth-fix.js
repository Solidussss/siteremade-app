require('dotenv').config();
const http = require('http');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const previousCreateServer = http.createServer.bind(http);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
const BASE_URL = String(process.env.PUBLIC_BASE_URL || 'https://app.siteremade.com').replace(/\/$/, '');
const GMAIL_REDIRECT_URI = BASE_URL + '/api/app/gmail/callback';
const stateSecret = process.env.MAILBOX_STATE_SECRET || SERVICE_KEY || 'siteremade-mail';
const db = SUPABASE_URL && SERVICE_KEY ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
const anon = SUPABASE_URL && ANON_KEY ? createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } }) : null;

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(x => x.trim().split('=')).filter(x => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
async function context(req) {
  if (!db || !anon) return null;
  const token = cookies(req).sr_access;
  if (!token) return null;
  const user = (await anon.auth.getUser(token)).data?.user;
  if (!user) return null;
  const profile = (await db.from('profiles').select('role').eq('id', user.id).maybeSingle()).data;
  if (!profile) return null;
  let workspaces = [];
  if (profile.role === 'owner') {
    workspaces = (await db.from('workspaces').select('*').order('created_at')).data || [];
  } else {
    workspaces = ((await db.from('workspace_members').select('workspace_id,workspaces(*)').eq('user_id', user.id)).data || []).map(x => x.workspaces).filter(Boolean);
  }
  if (!workspaces.length) return null;
  const c = cookies(req);
  let wid = req.headers['x-workspace-id'] || c.sr_workspace || workspaces[0].id;
  if (!workspaces.some(w => w.id === wid)) wid = workspaces[0].id;
  return { user, wid };
}
function signState(obj) {
  const payload = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const sig = crypto.createHmac('sha256', stateSecret).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function verifyState(value) {
  try {
    const [payload, sig] = String(value || '').split('.');
    if (!payload || !sig) return null;
    const expected = crypto.createHmac('sha256', stateSecret).update(payload).digest('base64url');
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (Date.now() - Number(data.t || 0) > 10 * 60 * 1000) return null;
    return data;
  } catch {
    return null;
  }
}
async function mailboxStatus(req, res) {
  const c = await context(req);
  if (!c) return send(res, 401, { ok: false, message: 'Authentication required.' });
  const row = db ? (await db.from('mailbox_connections').select('*').eq('workspace_id', c.wid).maybeSingle()).data : null;
  return send(res, 200, {
    ok: true,
    connected: !!row,
    provider: row?.provider || '',
    email: row?.email || '',
    lastSync: row?.last_sync || null,
    available: {
      gmail: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
      outlook: !!(process.env.MICROSOFT_OAUTH_CLIENT_ID && process.env.MICROSOFT_OAUTH_CLIENT_SECRET)
    }
  });
}
async function startGmail(req, res) {
  const c = await context(req);
  if (!c) return send(res, 401, { ok: false, message: 'Authentication required.' });
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return send(res, 503, { ok: false, message: 'Google OAuth is not configured on the server.' });
  const state = signState({ w: c.wid, u: c.user.id, p: 'gmail', t: Date.now() });
  const q = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GMAIL_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send',
    state,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true'
  });
  return send(res, 200, { ok: true, url: 'https://accounts.google.com/o/oauth2/v2/auth?' + q.toString() });
}
async function finishGmail(u, res) {
  const error = u.searchParams.get('error');
  if (error) {
    res.writeHead(302, { Location: BASE_URL + '/?mailbox=error&reason=' + encodeURIComponent(error), 'Cache-Control': 'no-store' });
    return res.end();
  }
  const state = verifyState(u.searchParams.get('state'));
  if (!state || state.p !== 'gmail') {
    res.writeHead(302, { Location: BASE_URL + '/?mailbox=error&reason=' + encodeURIComponent('Mailbox connection expired. Try again.'), 'Cache-Control': 'no-store' });
    return res.end();
  }
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: u.searchParams.get('code') || '',
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GMAIL_REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    });
    const token = await tokenRes.json();
    if (!tokenRes.ok || !token.access_token) throw new Error(token.error_description || token.error || 'Google token exchange failed.');
    const meRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: 'Bearer ' + token.access_token } });
    const me = await meRes.json().catch(() => ({}));
    if (!meRes.ok || !me.email) throw new Error('Could not read the connected Google account email.');
    const existing = (await db.from('mailbox_connections').select('*').eq('workspace_id', state.w).maybeSingle()).data;
    const row = {
      workspace_id: state.w,
      provider: 'gmail',
      email: me.email,
      access_token: token.access_token,
      refresh_token: token.refresh_token || existing?.refresh_token || '',
      expires_at: new Date(Date.now() + Number(token.expires_in || 3600) * 1000).toISOString(),
      scope: token.scope || 'openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send',
      updated_at: new Date().toISOString()
    };
    const saved = await db.from('mailbox_connections').upsert(row, { onConflict: 'workspace_id' });
    if (saved.error) throw saved.error;
    res.writeHead(302, { Location: BASE_URL + '/?mailbox=connected', 'Cache-Control': 'no-store' });
    return res.end();
  } catch (e) {
    res.writeHead(302, { Location: BASE_URL + '/?mailbox=error&reason=' + encodeURIComponent(e.message || 'Google connection failed.'), 'Cache-Control': 'no-store' });
    return res.end();
  }
}

http.createServer = function gmailOAuthFixedCreateServer(listener) {
  return previousCreateServer(async (req, res) => {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && u.pathname === '/api/app/mailbox/status') return mailboxStatus(req, res);
      if (req.method === 'GET' && u.pathname === '/api/app/mailbox/connect' && u.searchParams.get('provider') === 'gmail') return startGmail(req, res);
      if (req.method === 'GET' && u.pathname === '/api/app/gmail/callback') return finishGmail(u, res);
      return listener(req, res);
    } catch (e) {
      console.error('Gmail OAuth fix:', e);
      if (!res.headersSent) return send(res, 500, { ok: false, message: e.message || 'Google connection failed.' });
      res.end();
    }
  });
};
