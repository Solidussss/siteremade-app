// Migrated from v36-twilio-stripe.js (deleted). Logic is unchanged — only
// the http.createServer wrapper + manual path/method checks were replaced
// by router.get/post/delete() + { auth: 'user' } (none of these routes
// require owner, matching the original, which only ever checked for a
// resolved context).
//
// IMPORTANT ordering note: v40-twilio-subaccounts.js (required very early,
// inside v32-google-env-aliases.js, well before server.js's own listener
// runs) still uses the old http.createServer monkeypatch chain and
// intercepts POST /api/webhooks/twilio and POST /api/app/integrations/
// twilio/send|sync BEFORE this router ever sees them. It handles the
// subaccount-hosted-number case (business numbers ported in via the
// existing-number wizard) and falls through — calling the next listener in
// the vNN chain, which eventually reaches server.js's own request handler,
// which is where router.dispatch() runs — for the plain main-Twilio-
// account case. That fallback relationship (subaccount numbers handled by
// v40-twilio-subaccounts, main-account numbers handled here) is exactly
// preserved by this migration: this router only ever gets a request after
// every vNN http.createServer interceptor still in the chain has declined
// it, so v40-twilio-subaccounts's first-look priority for its own numbers
// is untouched.
const crypto = require('crypto');
const { db, readJsonBody: readJson } = require('../lib/context');

const base = String(process.env.PUBLIC_BASE_URL || 'https://app.siteremade.com').replace(/\/$/, '');
// Memoized on the request object because v40-twilio-subaccounts.js (still
// on the old http.createServer monkeypatch chain, required well before
// server.js's own listener runs) gets first look at this same webhook path
// and may already have consumed + parsed the body before falling through
// to this route. See the matching comment in v40-twilio-subaccounts.js for
// the confirmed pre-existing hang this fixes — a Node request stream can
// only be read once, so a second independent readForm(req) on the same
// request would otherwise wait forever for an 'end' event that already
// fired.
const readForm = req => { if (req.__twilioFormBody) return req.__twilioFormBody; return req.__twilioFormBody = new Promise((resolve, reject) => { let s = ''; req.on('data', c => { s += c; if (s.length > 1e6) { reject(Error('Payload too large')); req.destroy(); } }); req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(s)))); req.on('error', reject); }); };
function twilioAuth() { return 'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID || ''}:${process.env.TWILIO_AUTH_TOKEN || ''}`).toString('base64'); }
async function twilioApi(path, opts = {}) { if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) throw Error('Twilio is not configured on the server.'); const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/${path}`, { ...opts, headers: { Authorization: twilioAuth(), ...(opts.headers || {}) } }); const j = await r.json().catch(() => ({})); if (!r.ok) throw Error(j.message || 'Twilio request failed'); return j; }
async function stripeApi(path, params) { if (!process.env.STRIPE_SECRET_KEY) throw Error('Stripe is not configured on the server.'); const r = await fetch('https://api.stripe.com/v1/' + path, { method: params ? 'POST' : 'GET', headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: params ? new URLSearchParams(params) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw Error(j.error?.message || 'Stripe request failed'); return j; }
async function connection(wid, provider) { return (await db.from('integration_connections').select('*').eq('workspace_id', wid).eq('provider', provider).maybeSingle()).data || null; }
async function saveConnection(wid, provider, patch) { const row = { workspace_id: wid, provider, updated_at: new Date().toISOString(), ...patch }; const { data, error } = await db.from('integration_connections').upsert(row, { onConflict: 'workspace_id,provider' }).select('*').single(); if (error) throw error; return data; }
function normalizePhone(v) { return String(v || '').replace(/[^+\d]/g, ''); }
function validTwilioSignature(url, params, sig) { if (!process.env.TWILIO_AUTH_TOKEN || !sig) return false; let data = url; for (const k of Object.keys(params).sort()) data += k + params[k]; const expected = crypto.createHmac('sha1', process.env.TWILIO_AUTH_TOKEN).update(data).digest('base64'); try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { return false; } }
async function conversationFor(wid, lead) { let cv = (await db.from('conversations').select('*').eq('workspace_id', wid).eq('lead_id', lead.id).maybeSingle()).data; if (!cv) cv = (await db.from('conversations').insert({ workspace_id: wid, lead_id: lead.id, name: lead.name, mode: 'human', unread: 0 }).select('*').single()).data; return cv; }
async function inboundTwilio(req, res, u, json) { const params = await readForm(req); const webhookUrl = base + u.pathname; const signature = String(req.headers['x-twilio-signature'] || ''); if (!validTwilioSignature(webhookUrl, params, signature)) return json(res, 403, { ok: false, message: 'Invalid Twilio signature.' }); const to = normalizePhone(params.To), from = normalizePhone(params.From), text = String(params.Body || '').trim(); if (!to || !from || !text) { res.writeHead(204); return res.end(); } const rows = (await db.from('integration_connections').select('*').eq('provider', 'twilio').eq('status', 'connected')).data || []; const row = rows.find(x => normalizePhone(x.config?.phoneNumber) === to); if (!row) { res.writeHead(204); return res.end(); } const wid = row.workspace_id; let lead = (await db.from('leads').select('*').eq('workspace_id', wid).eq('phone', from).maybeSingle()).data; if (!lead) { lead = (await db.from('leads').insert({ workspace_id: wid, name: from, phone: from, service: 'SMS inquiry', source: 'Twilio SMS', status: 'New', value: 0, message: text, notes: [] }).select('*').single()).data; } let cv = await conversationFor(wid, lead); await db.from('messages').insert({ workspace_id: wid, conversation_id: cv.id, sender: 'customer', text }); await db.from('conversations').update({ updated_at: new Date().toISOString(), unread: Number(cv.unread || 0) + 1, mode: 'human' }).eq('id', cv.id); await db.from('activities').insert({ workspace_id: wid, type: 'message', title: 'SMS received', detail: `${lead.name} · ${text.slice(0, 120)}` }); res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' }); res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>'); }
async function ensureTwilioConnection(wid) { let row = await connection(wid, 'twilio'); if (row && row.status === 'connected' && normalizePhone(row.config?.phoneNumber)) return row; const j = await twilioApi('IncomingPhoneNumbers.json?PageSize=20'); const numbers = j.incoming_phone_numbers || []; if (!numbers.length) throw Error('No Twilio phone number was found on this account.'); if (numbers.length > 1) throw Error('More than one Twilio number exists. Connect the one you want from Integrations first.'); const number = numbers[0]; const form = new URLSearchParams({ SmsUrl: base + '/api/webhooks/twilio', SmsMethod: 'POST' }); await twilioApi(`IncomingPhoneNumbers/${number.sid}.json`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form }); row = await saveConnection(wid, 'twilio', { external_id: number.sid, account_label: number.friendly_name || number.phone_number, config: { phoneNumber: number.phone_number }, status: 'connected' }); return row; }
async function syncTwilio(wid, row) { const business = normalizePhone(row?.config?.phoneNumber); if (!business) throw Error('Connected Twilio number is missing.'); const j = await twilioApi('Messages.json?PageSize=100'); const history = (j.messages || []).filter(m => normalizePhone(m.from) === business || normalizePhone(m.to) === business).sort((a, b) => new Date(a.date_sent || a.date_created || 0) - new Date(b.date_sent || b.date_created || 0)); let added = 0, createdLeads = 0; for (const m of history) { const outbound = normalizePhone(m.from) === business; const phone = normalizePhone(outbound ? m.to : m.from); const text = String(m.body || '').trim(); if (!phone || !text) continue; let lead = (await db.from('leads').select('*').eq('workspace_id', wid).eq('phone', phone).maybeSingle()).data; if (!lead) { lead = (await db.from('leads').insert({ workspace_id: wid, name: phone, phone, service: 'SMS inquiry', source: 'Twilio SMS', status: 'New', value: 0, message: text, notes: [] }).select('*').single()).data; createdLeads++; } const cv = await conversationFor(wid, lead); const when = new Date(m.date_sent || m.date_created || Date.now()); const sender = outbound ? 'human' : 'customer'; const nearby = (await db.from('messages').select('sender,text,created_at').eq('workspace_id', wid).eq('conversation_id', cv.id).gte('created_at', new Date(when.getTime() - 120000).toISOString()).lte('created_at', new Date(when.getTime() + 120000).toISOString())).data || []; if (nearby.some(x => x.sender === sender && String(x.text || '') === text)) continue; await db.from('messages').insert({ workspace_id: wid, conversation_id: cv.id, sender, text, created_at: when.toISOString() }); await db.from('conversations').update({ updated_at: when.toISOString(), mode: 'human', ...(outbound ? {} : { unread: Number(cv.unread || 0) + 1 }) }).eq('id', cv.id); added++; } if (added) await db.from('activities').insert({ workspace_id: wid, type: 'message', title: 'SMS history synced', detail: `${added} message${added === 1 ? '' : 's'} imported from Twilio` }); return { added, createdLeads, total: history.length }; }

module.exports = function registerTwilioStripeRoutes(router) {
  router.post('/api/webhooks/twilio', { auth: 'none' }, async (req, res, { u, json }) => {
    return inboundTwilio(req, res, u, json);
  });

  router.get('/api/app/integrations/twilio/status', { auth: 'user' }, async (req, res, { c, json }) => {
    const row = await connection(c.wid, 'twilio');
    return json(res, 200, { ok: true, configured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN), connected: !!row && row.status === 'connected', phoneNumber: row?.config?.phoneNumber || '', label: row?.account_label || '' });
  });

  router.post('/api/app/integrations/twilio/connect', { auth: 'user' }, async (req, res, { c, json }) => {
    const b = await readJson(req), phone = normalizePhone(b.phoneNumber);
    if (!phone) return json(res, 400, { ok: false, message: 'Enter a Twilio phone number.' });
    const q = new URLSearchParams({ PhoneNumber: phone, PageSize: '20' });
    const j = await twilioApi('IncomingPhoneNumbers.json?' + q.toString());
    const number = (j.incoming_phone_numbers || []).find(n => normalizePhone(n.phone_number) === phone);
    if (!number) return json(res, 404, { ok: false, message: 'That phone number was not found in this Twilio account.' });
    const form = new URLSearchParams({ SmsUrl: base + '/api/webhooks/twilio', SmsMethod: 'POST' });
    await twilioApi(`IncomingPhoneNumbers/${number.sid}.json`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    await saveConnection(c.wid, 'twilio', { external_id: number.sid, account_label: number.friendly_name || number.phone_number, config: { phoneNumber: number.phone_number }, status: 'connected' });
    return json(res, 200, { ok: true, connected: true, phoneNumber: number.phone_number });
  });

  router.post('/api/app/integrations/twilio/send', { auth: 'user' }, async (req, res, { c, json }) => {
    const b = await readJson(req);
    if (b.confirmSend !== true) return json(res, 400, { ok: false, message: 'Send confirmation is required.' });
    const row = await ensureTwilioConnection(c.wid);
    const lead = (await db.from('leads').select('*').eq('workspace_id', c.wid).eq('id', String(b.leadId || '')).maybeSingle()).data;
    if (!lead) return json(res, 404, { ok: false, message: 'Customer not found.' });
    const text = String(b.text || '').trim().slice(0, 1600), to = normalizePhone(lead.phone), from = normalizePhone(row.config?.phoneNumber);
    if (!to || !from || !text) return json(res, 400, { ok: false, message: 'Customer phone, connected number and message are required.' });
    const form = new URLSearchParams({ From: from, To: to, Body: text });
    const result = await twilioApi('Messages.json', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    let cv = await conversationFor(c.wid, lead);
    await db.from('messages').insert({ workspace_id: c.wid, conversation_id: cv.id, sender: 'human', text });
    await db.from('conversations').update({ updated_at: new Date().toISOString(), mode: 'human' }).eq('id', cv.id);
    await db.from('activities').insert({ workspace_id: c.wid, type: 'message', title: 'SMS sent', detail: `${lead.name} · ${text.slice(0, 120)}` });
    return json(res, 200, { ok: true, conversationId: cv.id, messageSid: result.sid });
  });

  router.post('/api/app/integrations/twilio/sync', { auth: 'user' }, async (req, res, { c, json }) => {
    const row = await ensureTwilioConnection(c.wid);
    const result = await syncTwilio(c.wid, row);
    return json(res, 200, { ok: true, phoneNumber: row.config?.phoneNumber || '', ...result });
  });

  router.delete('/api/app/integrations/twilio', { auth: 'user' }, async (req, res, { c, json }) => {
    await db.from('integration_connections').delete().eq('workspace_id', c.wid).eq('provider', 'twilio');
    return json(res, 200, { ok: true });
  });

  router.get('/api/app/integrations/stripe/status', { auth: 'user' }, async (req, res, { c, json }) => {
    if (!process.env.STRIPE_SECRET_KEY) return json(res, 200, { ok: true, configured: false, connected: false });
    const id = c.workspace.stripe_account_id || '';
    if (!id) return json(res, 200, { ok: true, configured: true, connected: false });
    try {
      const a = await stripeApi('accounts/' + encodeURIComponent(id));
      return json(res, 200, { ok: true, configured: true, connected: !!a.details_submitted && !!a.charges_enabled, accountId: id, detailsSubmitted: !!a.details_submitted, chargesEnabled: !!a.charges_enabled, payoutsEnabled: !!a.payouts_enabled, label: a.business_profile?.name || a.email || id });
    } catch (e) {
      return json(res, 200, { ok: true, configured: true, connected: false, accountId: id, message: e.message });
    }
  });

  router.post('/api/app/integrations/stripe/connect', { auth: 'user' }, async (req, res, { c, json }) => {
    if (!process.env.STRIPE_SECRET_KEY) return json(res, 503, { ok: false, message: 'Stripe is not configured on the server.' });
    let accountId = c.workspace.stripe_account_id || '';
    if (!accountId) {
      const account = await stripeApi('accounts', { type: 'express', country: 'CA', 'capabilities[card_payments][requested]': 'true', 'capabilities[transfers][requested]': 'true', 'business_type': 'company', 'metadata[workspaceId]': c.wid });
      accountId = account.id;
      await db.from('workspaces').update({ stripe_account_id: accountId }).eq('id', c.wid);
    }
    const link = await stripeApi('account_links', { account: accountId, refresh_url: base + '/?stripe=refresh', return_url: base + '/?stripe=connected', type: 'account_onboarding' });
    return json(res, 200, { ok: true, url: link.url, accountId });
  });
};
