// BILLING PASS: POST /api/internal/billing/entitlement -- the SiteRemade builder asking, server to server, whether a
// Supabase user holds a live Workspace subscription allowance (see lib/billing-entitlement.js). Not for browsers: the
// request must carry a fresh HMAC signature made with SITEREMADE_BILLING_SECRET, and the answer contains no personal
// data beyond the subscription's status and dates.
'use strict';
const { verifySignature, createEntitlementService } = require('../lib/billing-entitlement');

const UUIDISH = /^[0-9a-f-]{16,64}$/i;
function readRaw(req, max = 4096) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > max) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

module.exports = function registerBillingInternalRoutes(router, deps = {}) {
  let service = null; // one per registration (a short Stripe cache lives inside it)
  router.post('/api/internal/billing/entitlement', { auth: 'none' }, async (req, res, { json }) => {
    const secret = process.env.SITEREMADE_BILLING_SECRET;
    const context = deps.db ? null : require('../lib/context'); // (loaded on use: tests inject their own records)
    const database = deps.db || context.db;
    if (!secret || !database) return json(res, 503, { ok: false });
    let raw;
    try { raw = await readRaw(req); } catch (e) { return json(res, 413, { ok: false }); }
    if (!verifySignature({ secret, timestamp: req.headers['x-siteremade-timestamp'], signature: req.headers['x-siteremade-signature'], body: raw })) return json(res, 401, { ok: false });
    let userId;
    try { userId = String(JSON.parse(raw).supabaseUserId || ''); } catch (e) { return json(res, 400, { ok: false }); }
    if (!UUIDISH.test(userId)) return json(res, 400, { ok: false });
    service = service || createEntitlementService({ db: database, stripeGet: deps.stripeGet });
    try { return json(res, 200, { ok: true, entitlement: await service.entitlementFor(userId) }); }
    catch (e) { console.error('[billing] entitlement check failed:', e.message); return json(res, 503, { ok: false }); }
  });
};
