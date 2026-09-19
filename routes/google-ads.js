// Migrated from v44-google-ads.js (deleted). Logic is unchanged — only the
// http.createServer wrapper + manual path/method checks were replaced by
// router.get/post() + explicit auth options.
//
// Two routes need special handling that the router's generic auth modes
// don't cover:
//   - GET /start must redirect (302) to the app with an error reason when
//     auth is missing, not return a JSON 401 like router auth:'user'/'owner'
//     would. So it's registered with { auth: 'none' } and calls getContext
//     itself.
//   - GET /callback is state-signed (see verify()) rather than
//     session-authenticated at all, so it's also { auth: 'none' }.
// Both still route through lib/router.js's dispatch/error handling; they
// just skip its built-in auth resolution in favor of the original
// hand-rolled checks.
const crypto = require('crypto');
const { db, getContext: context, sendJson: send } = require('../lib/context');

const base = String(process.env.PUBLIC_BASE_URL || 'https://app.siteremade.com').replace(/\/$/, '');
const redirectUri = base + '/api/app/google-ads/callback';
const googleId = process.env.GOOGLE_GMAIL_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const googleSecret = process.env.GOOGLE_GMAIL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
const managerId = String(process.env.GOOGLE_ADS_MANAGER_CUSTOMER_ID || '').replace(/\D/g, '');
const apiVersion = process.env.GOOGLE_ADS_API_VERSION || 'v25';
const adsScope = 'https://www.googleapis.com/auth/adwords';
const stateSecret = process.env.GOOGLE_ADS_STATE_SECRET || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || 'siteremade-google-ads';

function sign(obj) { const p = Buffer.from(JSON.stringify(obj)).toString('base64url'); const s = crypto.createHmac('sha256', stateSecret).update(p).digest('base64url'); return p + '.' + s; }
function verify(v) { try { const [p, s] = String(v || '').split('.'); if (!p || !s) return null; const expected = crypto.createHmac('sha256', stateSecret).update(p).digest('base64url'); const a = Buffer.from(s), b = Buffer.from(expected); if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null; const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return Date.now() - Number(o.t || 0) <= 10 * 60 * 1000 ? o : null; } catch { return null; } }
function hasAdsScope(row) { return String(row?.scope || '').split(/\s+/).includes(adsScope); }
function authUrl(c) { const q = new URLSearchParams({ client_id: googleId, redirect_uri: redirectUri, response_type: 'code', scope: `openid email ${adsScope}`, state: sign({ w: c.wid, u: c.user.id, p: 'google_ads', t: Date.now() }), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' }); return 'https://accounts.google.com/o/oauth2/v2/auth?' + q.toString(); }
async function tokenRow(wid) { if (!db) return null; const r = await db.from('google_ads_credentials').select('*').eq('workspace_id', wid).maybeSingle(); if (r.error) throw r.error; return r.data || null; }
async function refreshAccess(row) { if (!row) return null; const exp = row.expires_at ? new Date(row.expires_at).getTime() : 0; if (row.access_token && exp > Date.now() + 120000) return row; if (!row.refresh_token) throw Error('Google Ads refresh token is missing. Reconnect Google Ads.'); const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: googleId, client_secret: googleSecret, refresh_token: row.refresh_token, grant_type: 'refresh_token' }) }); const j = await r.json(); if (!r.ok || !j.access_token) throw Error(j.error_description || j.error || 'Google token refresh failed.'); const next = { ...row, access_token: j.access_token, expires_at: new Date(Date.now() + Number(j.expires_in || 3600) * 1000).toISOString(), scope: j.scope || row.scope, updated_at: new Date().toISOString() }; const saved = await db.from('google_ads_credentials').update({ access_token: next.access_token, expires_at: next.expires_at, scope: next.scope, updated_at: next.updated_at }).eq('workspace_id', row.workspace_id); if (saved.error) throw saved.error; return next; }
async function savePublicIntegration(wid, label, externalId, status = 'connected', config = {}) { const existing = (await db.from('integration_connections').select('id').eq('workspace_id', wid).eq('provider', 'google_ads').order('updated_at', { ascending: false }).limit(1).maybeSingle()).data; const payload = { workspace_id: wid, provider: 'google_ads', external_id: externalId || null, account_label: label || 'Google Ads', config, status, updated_at: new Date().toISOString() }; if (existing?.id) { const r = await db.from('integration_connections').update(payload).eq('id', existing.id); if (r.error) throw r.error; } else { const r = await db.from('integration_connections').insert(payload); if (r.error) throw r.error; } }
async function adsFetch(path, row, { method = 'GET', query, loginCustomerId = managerId } = {}) { row = await refreshAccess(row); if (!hasAdsScope(row)) { const err = Error('Google Ads permission is missing. Add the Google Ads scope to the OAuth consent screen, then reconnect permission.'); err.status = 409; throw err; } const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + row.access_token }; if (loginCustomerId) headers['login-customer-id'] = String(loginCustomerId).replace(/\D/g, ''); const r = await fetch(`https://googleads.googleapis.com/${apiVersion}${path}`, { method, headers, body: query ? JSON.stringify({ query }) : undefined }); const text = await r.text(); let j; try { j = text ? JSON.parse(text) : {}; } catch { j = { message: text }; } if (!r.ok) { const detail = j?.error?.message || j?.message || `Google Ads API request failed (${r.status})`; const err = Error(detail); err.status = r.status; throw err; } return j; }
async function listAccessible(row) { const j = await adsFetch('/customers:listAccessibleCustomers', row, { loginCustomerId: '' }); return (j.resourceNames || []).map(x => String(x).split('/').pop()).filter(Boolean); }
async function managerAccounts(row) { if (!managerId) return []; const q = 'SELECT customer_client.id, customer_client.descriptive_name, customer_client.level, customer_client.manager, customer_client.status, customer_client.currency_code FROM customer_client ORDER BY customer_client.level, customer_client.descriptive_name'; const j = await adsFetch(`/customers/${managerId}/googleAds:searchStream`, row, { method: 'POST', query: q, loginCustomerId: managerId }); const rows = []; for (const batch of Array.isArray(j) ? j : [j]) for (const r of batch.results || []) { const c = r.customerClient || {}; rows.push({ id: String(c.id || ''), name: c.descriptiveName || `Google Ads ${c.id || ''}`, level: Number(c.level) || 0, manager: !!c.manager, status: c.status || '', currency: c.currencyCode || '' }); } return rows; }
async function campaigns(row, customerId) { const cid = String(customerId || '').replace(/\D/g, ''); if (!cid) throw Error('Select a Google Ads account first.'); const q = "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_30_DAYS AND campaign.status != 'REMOVED' ORDER BY metrics.cost_micros DESC"; const j = await adsFetch(`/customers/${cid}/googleAds:searchStream`, row, { method: 'POST', query: q, loginCustomerId: managerId || cid }); const out = []; for (const batch of Array.isArray(j) ? j : [j]) for (const r of batch.results || []) { const c = r.campaign || {}, m = r.metrics || {}; out.push({ id: String(c.id || ''), name: c.name || 'Campaign', status: c.status || '', channel: c.advertisingChannelType || '', bidding: c.biddingStrategyType || '', impressions: Number(m.impressions) || 0, clicks: Number(m.clicks) || 0, conversions: Number(m.conversions) || 0, spend: (Number(m.costMicros) || 0) / 1000000 }); } return out; }
async function finish(u, res) { const err = u.searchParams.get('error'); if (err) { res.writeHead(302, { Location: base + '/?google_ads=error&reason=' + encodeURIComponent(err) }); return res.end(); } const st = verify(u.searchParams.get('state')); if (!st) { res.writeHead(302, { Location: base + '/?google_ads=error&reason=' + encodeURIComponent('Google Ads connection expired. Try again.') }); return res.end(); } try { const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: u.searchParams.get('code') || '', client_id: googleId, client_secret: googleSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }) }); const token = await r.json(); if (!r.ok || !token.access_token) throw Error(token.error_description || token.error || 'Google token exchange failed.'); const meR = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: 'Bearer ' + token.access_token } }); const me = await meR.json(); if (!meR.ok || !me.email) throw Error('Could not read Google account email.'); const old = await tokenRow(st.w); const saved = await db.from('google_ads_credentials').upsert({ workspace_id: st.w, google_user_email: me.email, access_token: token.access_token, refresh_token: token.refresh_token || old?.refresh_token || '', expires_at: new Date(Date.now() + Number(token.expires_in || 3600) * 1000).toISOString(), scope: token.scope || '', manager_customer_id: managerId, selected_customer_id: old?.selected_customer_id || '', updated_at: new Date().toISOString() }, { onConflict: 'workspace_id' }); if (saved.error) throw saved.error; const current = await tokenRow(st.w); let apiState = hasAdsScope(current) ? 'oauth_connected' : 'scope_missing', accounts = []; if (hasAdsScope(current)) { try { accounts = await managerAccounts(current); apiState = 'api_connected'; } catch (e) { console.error('Google Ads initial account sync:', e); apiState = 'api_error'; } } await savePublicIntegration(st.w, me.email, managerId, apiState, { managerCustomerId: managerId, apiReady: hasAdsScope(current), scopeReady: hasAdsScope(current), accountCount: accounts.length }); res.writeHead(302, { Location: base + '/?google_ads=connected' }); res.end(); } catch (e) { res.writeHead(302, { Location: base + '/?google_ads=error&reason=' + encodeURIComponent(e.message || 'Google Ads connection failed.') }); res.end(); } }

module.exports = function registerGoogleAdsRoutes(router) {
  router.get('/api/app/google-ads/start', { auth: 'none' }, async (req, res, { u }) => {
    const c = await context(req, res);
    if (!c) { res.writeHead(302, { Location: base + '/?google_ads=error&reason=' + encodeURIComponent('Authentication required.') }); return res.end(); }
    if (!c.owner) return send(res, 403, { ok: false, message: 'Owner only.' });
    if (!googleId || !googleSecret) return send(res, 503, { ok: false, message: 'Google OAuth credentials are not configured.' });
    res.writeHead(302, { Location: authUrl(c), 'Cache-Control': 'no-store' });
    return res.end();
  });

  router.get('/api/app/google-ads/callback', { auth: 'none' }, async (req, res, { u }) => {
    return finish(u, res);
  });

  router.get('/api/app/google-ads/status', { auth: 'user' }, async (req, res, { c, json }) => {
    const row = await tokenRow(c.wid);
    const pub = (await db.from('integration_connections').select('*').eq('workspace_id', c.wid).eq('provider', 'google_ads').order('updated_at', { ascending: false }).limit(1).maybeSingle()).data;
    const scopeReady = hasAdsScope(row);
    return json(res, 200, { ok: true, configured: !!(googleId && googleSecret && managerId), connected: !!row, scopeReady, email: row?.google_user_email || '', managerCustomerId: managerId, selectedCustomerId: row?.selected_customer_id || '', apiReady: !!row && scopeReady, status: pub?.status || (!row ? 'not_connected' : scopeReady ? 'connected' : 'scope_missing'), redirectUri });
  });

  router.get('/api/app/google-ads/accounts', { auth: 'owner' }, async (req, res, { c, json }) => {
    let row = await tokenRow(c.wid);
    if (!row) return json(res, 409, { ok: false, message: 'Connect Google Ads first.' });
    if (!hasAdsScope(row)) return json(res, 409, { ok: false, message: 'Google Ads permission is missing. Add the Google Ads scope in Google Auth Platform → Data Access, then reconnect permission.' });
    row = await refreshAccess(row);
    const [direct, hierarchy] = await Promise.all([listAccessible(row), managerAccounts(row)]);
    await savePublicIntegration(c.wid, row.google_user_email, managerId, 'api_connected', { managerCustomerId: managerId, selectedCustomerId: row.selected_customer_id || '', apiReady: true, scopeReady: true, accountCount: hierarchy.length });
    return json(res, 200, { ok: true, direct, hierarchy, managerCustomerId: managerId, selectedCustomerId: row.selected_customer_id || '' });
  });

  router.post('/api/app/google-ads/select', { auth: 'owner' }, async (req, res, { c, json }) => {
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 200000) throw Error('Payload too large'); }
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { throw Error('Invalid JSON'); }
    const cid = String(body.customerId || '').replace(/\D/g, '');
    if (!cid) return json(res, 400, { ok: false, message: 'Choose a Google Ads account.' });
    const row = await tokenRow(c.wid);
    if (!row) return json(res, 409, { ok: false, message: 'Connect Google Ads first.' });
    const updated = await db.from('google_ads_credentials').update({ selected_customer_id: cid, updated_at: new Date().toISOString() }).eq('workspace_id', c.wid);
    if (updated.error) throw updated.error;
    await savePublicIntegration(c.wid, row.google_user_email, cid, 'api_connected', { managerCustomerId: managerId, selectedCustomerId: cid, apiReady: true, scopeReady: true });
    return json(res, 200, { ok: true, selectedCustomerId: cid });
  });

  router.get('/api/app/google-ads/campaigns', { auth: 'owner' }, async (req, res, { c, u, json }) => {
    const row = await tokenRow(c.wid);
    if (!row) return json(res, 409, { ok: false, message: 'Connect Google Ads first.' });
    if (!hasAdsScope(row)) return json(res, 409, { ok: false, message: 'Google Ads permission is missing. Reconnect Google Ads after adding the Ads OAuth scope.' });
    const cid = String(u.searchParams.get('customerId') || row.selected_customer_id || '').replace(/\D/g, '');
    const data = await campaigns(row, cid);
    const summary = data.reduce((a, x) => ({ spend: a.spend + x.spend, clicks: a.clicks + x.clicks, impressions: a.impressions + x.impressions, conversions: a.conversions + x.conversions }), { spend: 0, clicks: 0, impressions: 0, conversions: 0 });
    return json(res, 200, { ok: true, customerId: cid, campaigns: data, summary });
  });
};
