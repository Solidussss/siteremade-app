// Migrated from v33-gmail-oauth-fix.js (deleted) and most of
// v29-mail-server.js's http.createServer route block. Two separate,
// tangled Gmail/Outlook OAuth implementations lived side by side here:
// v33 owned Gmail specifically (its own state signing, its own callback at
// /api/app/gmail/callback) and always got first look because it was
// required earlier than v29 in the old vNN chain; v29 owned the generic
// provider-config-driven flow (used for Outlook, and for Gmail only in the
// case v33 declined). GET /api/app/mailbox/connect is the one path both
// files handled: v33 intercepted only when ?provider=gmail and fell
// through otherwise, so it's merged into a single handler below that
// replicates that exact branch instead of registering two competing
// routes (the router has no notion of "try the next route sharing this
// path" — a matched route is just handled).
//
// GET /api/app/mailbox/status was ALSO defined in old v29-mail-server.js,
// but v33 (required earlier) always won there — v29's copy was already
// confirmed-dead and removed in an earlier Phase 3 commit. Only v33's
// version is migrated here.
//
// POST /api/app/conversations/:id/messages is NOT migrated here — see the
// comment at the top of the trimmed v29-mail-server.js for why it stays
// on the old chain.
const crypto = require('crypto');
const { db, readJsonBody: read, getContext } = require('../lib/context');

const base = String(process.env.PUBLIC_BASE_URL || 'https://app.siteremade.com').replace(/\/$/, '');
const clean = (v, n = 4000) => String(v ?? '').trim().slice(0, n);

// --- v33-gmail-oauth-fix.js's own Gmail-only OAuth flow ---
const googleId = process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const googleSecret = process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
const gmailRedirect = base + '/api/app/gmail/callback';
const gmailStateSecret = process.env.MAILBOX_STATE_SECRET || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || 'siteremade-mail';
function signGmail(obj) { const p = Buffer.from(JSON.stringify(obj)).toString('base64url'); return p + '.' + crypto.createHmac('sha256', gmailStateSecret).update(p).digest('base64url'); }
function verifyGmail(v) { try { const [p, s] = String(v || '').split('.'); if (!p || !s) return null; const x = crypto.createHmac('sha256', gmailStateSecret).update(p).digest('base64url'); const a = Buffer.from(s), b = Buffer.from(x); if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null; const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return Date.now() - Number(o.t || 0) <= 600000 ? o : null; } catch { return null; } }
function googleUrl(c) { const q = new URLSearchParams({ client_id: googleId, redirect_uri: gmailRedirect, response_type: 'code', scope: 'openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send', state: signGmail({ w: c.wid, u: c.user.id, p: 'gmail', t: Date.now() }), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' }); return 'https://accounts.google.com/o/oauth2/v2/auth?' + q; }
async function finishGmail(u, res) {
  const err = u.searchParams.get('error');
  if (err) { res.writeHead(302, { Location: base + '/?mailbox=error&reason=' + encodeURIComponent(err) }); return res.end(); }
  const st = verifyGmail(u.searchParams.get('state'));
  if (!st) { res.writeHead(302, { Location: base + '/?mailbox=error&reason=' + encodeURIComponent('Connection expired. Try again.') }); return res.end(); }
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: u.searchParams.get('code') || '', client_id: googleId, client_secret: googleSecret, redirect_uri: gmailRedirect, grant_type: 'authorization_code' }) });
    const token = await r.json();
    if (!r.ok || !token.access_token) throw Error(token.error_description || token.error || 'Google token exchange failed.');
    const meR = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: 'Bearer ' + token.access_token } });
    const me = await meR.json();
    if (!meR.ok || !me.email) throw Error('Could not read Google account email.');
    const old = (await db.from('mailbox_connections').select('refresh_token').eq('workspace_id', st.w).maybeSingle()).data;
    const saved = await db.from('mailbox_connections').upsert({ workspace_id: st.w, provider: 'gmail', email: me.email, access_token: token.access_token, refresh_token: token.refresh_token || old?.refresh_token || '', expires_at: new Date(Date.now() + Number(token.expires_in || 3600) * 1000).toISOString(), scope: token.scope || '', updated_at: new Date().toISOString() }, { onConflict: 'workspace_id' });
    if (saved.error) throw saved.error;
    res.writeHead(302, { Location: base + '/?mailbox=connected' });
    res.end();
  } catch (e) {
    res.writeHead(302, { Location: base + '/?mailbox=error&reason=' + encodeURIComponent(e.message || 'Google connection failed.') });
    res.end();
  }
}

// --- v29-mail-server.js's generic (Outlook + fallback) OAuth flow ---
const genericStateSecret = process.env.MAILBOX_STATE_SECRET || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || 'siteremade-mail';
function signState(obj) { const payload = Buffer.from(JSON.stringify(obj)).toString('base64url'); const sig = crypto.createHmac('sha256', genericStateSecret).update(payload).digest('base64url'); return payload + '.' + sig; }
function verifyState(v) { try { const [p, s] = String(v || '').split('.'); const x = crypto.createHmac('sha256', genericStateSecret).update(p).digest('base64url'); if (!crypto.timingSafeEqual(Buffer.from(s || ''), Buffer.from(x))) return null; const o = JSON.parse(Buffer.from(p, 'base64url').toString()); if (Date.now() - Number(o.t || 0) > 10 * 60 * 1000) return null; return o; } catch { return null; } }
function providerConfig(provider) { if (provider === 'gmail') return { clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '', clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '', auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', scope: 'openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send', redirect: base + '/api/app/mailbox/callback/gmail' }; if (provider === 'outlook') return { clientId: process.env.MICROSOFT_OAUTH_CLIENT_ID || '', clientSecret: process.env.MICROSOFT_OAUTH_CLIENT_SECRET || '', auth: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', scope: 'openid email offline_access User.Read Mail.ReadWrite Mail.Send', redirect: base + '/api/app/mailbox/callback/outlook' }; return null; }
async function tokenRequest(provider, params) { const c = providerConfig(provider); const r = await fetch(c.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) }); const j = await r.json(); if (!r.ok) throw Error(j.error_description || j.error || 'Mailbox token request failed'); return j; }
async function completeOAuth(provider, code, state) { const st = verifyState(state); if (!st || st.p !== provider) throw Error('Mailbox connection expired. Try again.'); const c = providerConfig(provider); const j = await tokenRequest(provider, { code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: c.redirect, grant_type: 'authorization_code' }); let email = ''; if (provider === 'gmail') { const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: 'Bearer ' + j.access_token } }); email = (await r.json()).emailAddress || ''; } else { const r = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', { headers: { Authorization: 'Bearer ' + j.access_token } }); const me = await r.json(); email = me.mail || me.userPrincipalName || ''; } await db.from('mailbox_connections').upsert({ workspace_id: st.w, provider, email, access_token: j.access_token || '', refresh_token: j.refresh_token || '', expires_at: new Date(Date.now() + Number(j.expires_in || 3600) * 1000).toISOString(), scope: j.scope || c.scope, updated_at: new Date().toISOString() }, { onConflict: 'workspace_id' }); return st.w; }

// --- shared: sync (used by POST /api/app/mailbox/sync) ---
const emailOf = v => { const m = String(v || '').match(/<([^>]+)>/); return clean((m ? m[1] : v).toLowerCase(), 254); };
function decodeGmailBody(payload) { const walk = p => { if (p?.body?.data) return Buffer.from(p.body.data, 'base64url').toString('utf8'); for (const x of p?.parts || []) { const v = walk(x); if (v) return v; } return ''; }; return clean(walk(payload), 4000); }
async function freshConnection(row) { if (!row) return null; if (row.expires_at && new Date(row.expires_at).getTime() > Date.now() + 60000) return row; if (!row.refresh_token) return row; const c = providerConfig(row.provider); const j = await tokenRequest(row.provider, { client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'refresh_token', refresh_token: row.refresh_token, redirect_uri: c.redirect, scope: c.scope }); const patch = { access_token: j.access_token || row.access_token, refresh_token: j.refresh_token || row.refresh_token, expires_at: new Date(Date.now() + Number(j.expires_in || 3600) * 1000).toISOString(), updated_at: new Date().toISOString() }; const saved = (await db.from('mailbox_connections').update(patch).eq('workspace_id', row.workspace_id).select('*').single()).data; return saved || { ...row, ...patch }; }
async function connection(wid) { const r = (await db.from('mailbox_connections').select('*').eq('workspace_id', wid).maybeSingle()).data; return r ? freshConnection(r) : null; }
async function ensureConversation(wid, lead) { let cv = (await db.from('conversations').select('*').eq('workspace_id', wid).eq('lead_id', lead.id).maybeSingle()).data; if (!cv) { cv = (await db.from('conversations').insert({ workspace_id: wid, lead_id: lead.id, name: lead.name, mode: 'human', unread: 0 }).select('*').single()).data; } return cv; }
async function ingest(wid, provider, externalId, from, to, text, createdAt) { if (!externalId || !text) return false; const seen = (await db.from('mailbox_events').select('id').eq('workspace_id', wid).eq('provider', provider).eq('external_id', externalId).maybeSingle()).data; if (seen) return false; const leads = (await db.from('leads').select('*').eq('workspace_id', wid).limit(2000)).data || []; const fromEmail = emailOf(from), toEmail = emailOf(to); const lead = leads.find(l => l.email && [fromEmail, toEmail].includes(String(l.email).toLowerCase())); if (!lead) return false; const cv = await ensureConversation(wid, lead); const inbound = fromEmail === String(lead.email).toLowerCase(); await db.from('messages').insert({ workspace_id: wid, conversation_id: cv.id, sender: inbound ? 'customer' : 'business', text: clean(text, 4000), created_at: createdAt || new Date().toISOString() }); await db.from('conversations').update({ updated_at: createdAt || new Date().toISOString(), mode: 'human', unread: inbound ? Math.max(1, Number(cv.unread || 0) + 1) : cv.unread || 0 }).eq('id', cv.id); await db.from('mailbox_events').insert({ workspace_id: wid, provider, external_id: externalId, conversation_id: cv.id, lead_id: lead.id, direction: inbound ? 'inbound' : 'outbound' }); return true; }
async function syncGmail(row) { row = await freshConnection(row); const list = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=40&q=newer_than:30d', { headers: { Authorization: 'Bearer ' + row.access_token } }); const j = await list.json(); if (!list.ok) throw Error(j.error?.message || 'Gmail sync failed'); let added = 0; for (const m of j.messages || []) { const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/' + m.id + '?format=full', { headers: { Authorization: 'Bearer ' + row.access_token } }); const x = await r.json(); if (!r.ok) continue; const h = Object.fromEntries((x.payload?.headers || []).map(a => [String(a.name).toLowerCase(), a.value])); const text = decodeGmailBody(x.payload) || clean(x.snippet, 4000); if (await ingest(row.workspace_id, 'gmail', x.id, h.from, h.to, text, new Date(Number(x.internalDate) || Date.now()).toISOString())) added++; } return added; }
async function syncOutlook(row) { row = await freshConnection(row); const url = 'https://graph.microsoft.com/v1.0/me/messages?$top=40&$orderby=receivedDateTime%20desc&$select=id,subject,bodyPreview,from,toRecipients,receivedDateTime'; const r = await fetch(url, { headers: { Authorization: 'Bearer ' + row.access_token } }); const j = await r.json(); if (!r.ok) throw Error(j.error?.message || 'Outlook sync failed'); let added = 0; for (const x of j.value || []) { const from = x.from?.emailAddress?.address || '', to = (x.toRecipients || []).map(a => a.emailAddress?.address).filter(Boolean).join(','); if (await ingest(row.workspace_id, 'outlook', x.id, from, to, x.bodyPreview || x.subject || '', x.receivedDateTime)) added++; } return added; }
async function sync(row) { const added = row.provider === 'gmail' ? await syncGmail(row) : await syncOutlook(row); await db.from('mailbox_connections').update({ last_sync: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('workspace_id', row.workspace_id); return added; }

module.exports = function registerMailboxRoutes(router) {
  router.get('/api/app/mailbox/status', { auth: 'user' }, async (req, res, { c, json }) => {
    const row = (await db.from('mailbox_connections').select('*').eq('workspace_id', c.wid).maybeSingle()).data;
    return json(res, 200, { ok: true, connected: !!row, provider: row?.provider || '', email: row?.email || '', lastSync: row?.last_sync || null, available: { gmail: !!(googleId && googleSecret), outlook: !!(process.env.MICROSOFT_OAUTH_CLIENT_ID && process.env.MICROSOFT_OAUTH_CLIENT_SECRET) } });
  });

  // Merges v33's gmail-only branch (which always won for ?provider=gmail
  // in the old chain) with v29's generic branch (everything else) into one
  // handler, preserving the exact same effective behavior per provider.
  router.get('/api/app/mailbox/connect', { auth: 'user' }, async (req, res, { c, u, json }) => {
    const provider = u.searchParams.get('provider');
    if (provider === 'gmail') {
      if (!googleId || !googleSecret) return json(res, 503, { ok: false, message: 'Google OAuth credentials are missing.' });
      return json(res, 200, { ok: true, url: googleUrl(c) });
    }
    const providerClean = clean(provider, 20);
    const cfg = providerConfig(providerClean);
    if (!cfg?.clientId || !cfg?.clientSecret) return json(res, 503, { ok: false, message: 'This mailbox provider is not configured yet.' });
    const state = signState({ w: c.wid, u: c.user.id, p: providerClean, t: Date.now() });
    const q = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: cfg.redirect, response_type: 'code', scope: cfg.scope, state, access_type: 'offline', prompt: 'consent' });
    if (providerClean === 'outlook') q.delete('access_type');
    return json(res, 200, { ok: true, url: cfg.auth + '?' + q.toString() });
  });

  router.get('/api/app/gmail/callback', { auth: 'none' }, async (req, res, { u }) => {
    return finishGmail(u, res);
  });

  router.get('/api/app/mailbox/callback/:provider', { auth: 'none' }, async (req, res, { params, u }) => {
    try {
      await completeOAuth(params.provider, u.searchParams.get('code'), u.searchParams.get('state'));
      res.writeHead(302, { Location: base + '/?mailbox=connected' });
      return res.end();
    } catch (e) {
      res.writeHead(302, { Location: base + '/?mailbox=error&reason=' + encodeURIComponent(e.message) });
      return res.end();
    }
  });

  router.post('/api/app/mailbox/sync', { auth: 'user' }, async (req, res, { c, json }) => {
    const row = await connection(c.wid);
    if (!row) return json(res, 400, { ok: false, message: 'Connect Gmail or Outlook first.' });
    const added = await sync(row);
    return json(res, 200, { ok: true, added });
  });

  router.delete('/api/app/mailbox', { auth: 'user' }, async (req, res, { c, json }) => {
    await db.from('mailbox_connections').delete().eq('workspace_id', c.wid);
    return json(res, 200, { ok: true });
  });
};
