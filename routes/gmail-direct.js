// Migrated from v34-gmail-direct.js's http.createServer route block
// (GET /api/app/gmail/start — an alternate Gmail-connect entry point that
// requests Gmail + Calendar scopes together, landing on the same
// /api/app/gmail/callback already migrated to routes/mailbox.js's
// finishGmail(), which doesn't check which flow signed the state). That
// file is NOT deleted: it still owns the fs.readFileSync patch that
// injects a click-interception script into index.html, which is
// frontend-consolidation work for a later phase, not a route.
//
// This is a redirect-based auth-failure endpoint (like google-ads/start
// and gmail's own connect flow), so it's registered with { auth: 'none' }
// and does its own getContext() call to redirect (not JSON 401) on
// missing auth, exactly like the original.
const crypto = require('crypto');
const { getContext: context } = require('../lib/context');

const base = String(process.env.PUBLIC_BASE_URL || 'https://app.siteremade.com').replace(/\/$/, '');
const redirectUri = base + '/api/app/gmail/callback';
const clientId = process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const clientSecret = process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
const stateSecret = process.env.MAILBOX_STATE_SECRET || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || 'siteremade-mail';
function state(obj) { const p = Buffer.from(JSON.stringify(obj)).toString('base64url'); const s = crypto.createHmac('sha256', stateSecret).update(p).digest('base64url'); return p + '.' + s; }
function googleUrl(ctx) {
  const scopes = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/calendar.events'];
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: scopes.join(' '), state: state({ w: ctx.wid, u: ctx.user.id, p: 'gmail', t: Date.now() }), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + q.toString();
}

module.exports = function registerGmailDirectRoutes(router) {
  router.get('/api/app/gmail/start', { auth: 'none' }, async (req, res) => {
    // Preserves the original's own try/catch, which redirects with an
    // error reason on ANY failure (including unexpected ones) rather than
    // the router's generic JSON error response — the person stays in the
    // browser-redirect flow instead of seeing a raw JSON body.
    try {
      const c = await context(req, res);
      if (!c) { res.writeHead(302, { Location: base + '/?mailbox=error&reason=' + encodeURIComponent('Authentication required.') }); return res.end(); }
      if (!clientId || !clientSecret) { res.writeHead(302, { Location: base + '/?mailbox=error&reason=' + encodeURIComponent('Google OAuth credentials are missing on the server.') }); return res.end(); }
      res.writeHead(302, { Location: googleUrl(c), 'Cache-Control': 'no-store' });
      return res.end();
    } catch (e) {
      console.error('Gmail direct start:', e);
      if (!res.headersSent) { res.writeHead(302, { Location: base + '/?mailbox=error&reason=' + encodeURIComponent(e.message || 'Google connection failed.') }); return res.end(); }
      res.end();
    }
  });
};
