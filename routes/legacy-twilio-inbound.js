// Migrated from v17-preload.js's http.createServer route block: two
// standalone routes only (POST /api/public/twilio/inbound, GET /api/v19/
// admin/overview). v17-preload.js is NOT touched beyond removing these —
// it still owns index.html serving (enhancedHtml(), which runs through
// every other file's fs.readFileSync patch to compose the final page —
// deeply tied to the frontend-injection system, out of scope here) and a
// res.end() wrapper around POST/PATCH /api/app/website-updates that fires
// an email notification based on that (not-yet-migrated) route's response
// body — a content-based cross-cutting concern like the ones deferred in
// v29-mail-server.js and v40-twilio-subaccounts.js, left alone rather than
// risked in this pass.
//
// POST /api/public/twilio/inbound is a SEPARATE, older single-tenant
// Twilio webhook from POST /api/webhooks/twilio (routes/twilio-stripe.js)
// and v40-twilio-subaccounts.js's webhook — it still matches the receiving
// number against a single global TWILIO_FROM env var rather than letting a
// business connect any number it likes, and validates its own signature
// against the account-level TWILIO_AUTH_TOKEN. That part is unchanged.
// What DID change (production-readiness pass): recordInboundSms() used to
// resolve the sender to a lead by scanning `leads` across every workspace
// with no workspace filter — a real cross-tenant leak if two tenants ever
// had a contact with the same phone number. Fixed by resolving the
// workspace deterministically from integration_connections first (see
// workspaceForReceivingNumber() below) and scoping the lead lookup to it;
// if TWILIO_FROM isn't registered there, the message is safely not
// attributed to anyone rather than falling back to the old global scan.
const crypto = require('crypto');
const { db, getAuthUser } = require('../lib/context');

const clean = (v, n = 4000) => String(v ?? '').trim().slice(0, n);
const normalizePhone = v => String(v || '').replace(/\D/g, '').slice(-10);
const xml = (res, status, body = '<Response></Response>') => { res.writeHead(status, { 'Content-Type': 'text/xml; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' }); res.end(body); };
function readRaw(req, limit = 1024 * 1024) { return new Promise((resolve, reject) => { let raw = ''; req.on('data', chunk => { raw += chunk; if (raw.length > limit) { reject(new Error('Payload too large')); req.destroy(); } }); req.on('end', () => resolve(raw)); req.on('error', reject); }); }
function publicRequestUrl(req) { const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim(); const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim(); return `${proto}://${host}${req.url}`; }
function validTwilioSignature(req, params) { const token = process.env.TWILIO_AUTH_TOKEN; const signature = String(req.headers['x-twilio-signature'] || ''); if (!token || !signature) return false; let payload = publicRequestUrl(req); for (const key of Object.keys(params).sort()) payload += key + params[key]; const expected = crypto.createHmac('sha1', token).update(payload).digest('base64'); const a = Buffer.from(signature), b = Buffer.from(expected); return a.length === b.length && crypto.timingSafeEqual(a, b); }
// SECURITY FIX: this used to scan `leads` across every workspace and
// attach the inbound SMS to whichever matching lead was updated most
// recently, globally — if two different tenants each had a contact with
// the same phone number, one business's customer conversation could land
// in a different tenant's CRM. Fixed by resolving the workspace
// deterministically from the *receiving* number first, using
// `integration_connections` — the exact same table the modern per-tenant
// Twilio routes (routes/twilio-stripe.js, v40-twilio-subaccounts.js)
// already trust for this exact mapping (provider:'twilio',
// status:'connected', config.phoneNumber) — rather than guessing. Only
// once a workspace is known does `findLeadByPhone` ever run, and it now
// runs scoped to that one workspace.
async function workspaceForReceivingNumber(to) {
  const target = normalizePhone(to);
  if (!db || !target) return null;
  const { data, error } = await db.from('integration_connections').select('workspace_id,config').eq('provider', 'twilio').eq('status', 'connected');
  if (error) throw error;
  const row = (data || []).find(r => normalizePhone(r.config?.phoneNumber) === target);
  return row ? row.workspace_id : null;
}
async function findLeadByPhone(phone, workspaceId) { if (!db) return null; const target = normalizePhone(phone); if (!target) return null; const { data, error } = await db.from('leads').select('*').eq('workspace_id', workspaceId).order('updated_at', { ascending: false }).limit(2000); if (error) throw error; return (data || []).find(l => normalizePhone(l.phone) === target) || null; }
async function recordInboundSms(params) {
  const from = clean(params.From, 80), to = clean(params.To, 80), text = clean(params.Body, 4000);
  if (!from || !text) return { matched: false };
  if (process.env.TWILIO_FROM && normalizePhone(to) !== normalizePhone(process.env.TWILIO_FROM)) return { matched: false };
  // Fail safe, not open: if no workspace has this receiving number
  // registered in integration_connections (e.g. TWILIO_FROM predates that
  // table and was never connected through the normal Twilio setup flow),
  // do NOT fall back to the old cross-workspace scan — that would put the
  // vulnerability right back for exactly the case that needs it fixed
  // most. Twilio still gets its 200 OK either way (see the route below);
  // the message is simply not logged against any lead until that number
  // is connected the normal way (POST /api/app/integrations/twilio/connect
  // from the owning workspace), which also moves it onto the fully
  // isolated modern path and makes this legacy route moot for it.
  const workspaceId = await workspaceForReceivingNumber(to);
  if (!workspaceId) return { matched: false };
  const lead = await findLeadByPhone(from, workspaceId);
  if (!lead) return { matched: false };
  let { data: conversation, error: convError } = await db.from('conversations').select('*').eq('workspace_id', lead.workspace_id).eq('lead_id', lead.id).maybeSingle(); if (convError) throw convError; if (!conversation) { const created = await db.from('conversations').insert({ workspace_id: lead.workspace_id, lead_id: lead.id, name: lead.name, mode: 'human', unread: 0 }).select('*').single(); if (created.error) throw created.error; conversation = created.data; } const inserted = await db.from('messages').insert({ workspace_id: lead.workspace_id, conversation_id: conversation.id, sender: 'customer', text }); if (inserted.error) throw inserted.error; const nextUnread = Math.max(0, Number(conversation.unread) || 0) + 1; const updated = await db.from('conversations').update({ unread: nextUnread, updated_at: new Date().toISOString(), mode: 'human', name: lead.name }).eq('id', conversation.id).eq('workspace_id', lead.workspace_id); if (updated.error) throw updated.error; await db.from('activities').insert({ workspace_id: lead.workspace_id, type: 'message', title: 'Customer text message', detail: `${lead.name} · ${text.slice(0, 80)}` }); return { matched: true, leadId: lead.id, conversationId: conversation.id }; }
async function adminOverview(req, res, json) { const a = await getAuthUser(req, res); if (!a || a.profile.role !== 'owner') return json(res, 403, { ok: false, message: 'Owner only.' }); const [workspaces, leads, conversations, updates] = await Promise.all([db.from('workspaces').select('id,business_name,email,siteremade_subscription_status'), db.from('leads').select('workspace_id,status'), db.from('conversations').select('workspace_id,unread'), db.from('website_updates').select('*').order('created_at', { ascending: false }).limit(100)]); for (const r of [workspaces, leads, conversations, updates]) if (r.error) throw r.error; const ws = (workspaces.data || []).map(w => ({ id: w.id, businessName: w.business_name, email: w.email, status: w.siteremade_subscription_status || 'inactive', activeLeads: (leads.data || []).filter(l => l.workspace_id === w.id && !['Won', 'Lost'].includes(l.status)).length, unread: (conversations.data || []).filter(c => c.workspace_id === w.id).reduce((n, c) => n + Math.max(0, Number(c.unread) || 0), 0) })); const names = new Map(ws.map(w => [w.id, w.businessName])); return json(res, 200, { ok: true, workspaces: ws, updateRequests: (updates.data || []).map(r => ({ id: r.id, workspaceId: r.workspace_id, businessName: names.get(r.workspace_id) || 'Client', page: r.page, priority: r.priority, request: r.request, status: r.status, createdAt: r.created_at })) }); }

module.exports = function registerLegacyTwilioInboundRoutes(router) {
  router.post('/api/public/twilio/inbound', { auth: 'none' }, async (req, res) => {
    if (!db) return xml(res, 503);
    const raw = await readRaw(req);
    const params = Object.fromEntries(new URLSearchParams(raw));
    if (!validTwilioSignature(req, params)) return xml(res, 403);
    await recordInboundSms(params);
    return xml(res, 200);
  });

  // auth:'none' (not 'session'/'user'/'owner') deliberately: the original
  // returns 403 "Owner only." for BOTH "not logged in" and "logged in but
  // not owner" (a single `if(!a||a.profile.role!=='owner')` check) rather
  // than a 401 for the first case — this route was never workspace-scoped
  // to begin with (it aggregates across every workspace), so it doesn't
  // use getContext() at all. The router's built-in 'session'/'user'/
  // 'owner' auth modes would 401 an unauthenticated request before this
  // handler ever ran, which would be a real response-code change, so
  // adminOverview() replicates the original's own combined check instead.
  router.get('/api/v19/admin/overview', { auth: 'none' }, async (req, res, { json }) => {
    return adminOverview(req, res, json);
  });
};
