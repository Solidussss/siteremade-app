// BILLING PASS: the Workspace subscription as the SiteRemade builder is allowed to see it.
//
// The builder (the generator service) keeps the ONE credit ledger for both products -- the 100 AI credits a month a
// Workspace subscription includes are spent there, from the builder and from this app alike. It never decides for
// itself whether someone subscribes: it asks this app, server to server, with a request signed by a secret only the two
// services hold (SITEREMADE_BILLING_SECRET), and this app answers from its own records AND the subscription's live
// state at Stripe. Never from a browser field, user-editable metadata, an email address or a checkout redirect.
//
// Who holds the allowance (the "billing owner"): for a workspace whose subscription is live at Stripe and belongs to
// it (the subscription's metadata.workspaceId), the member who started the subscription (metadata.billingUserId, set
// from now on) if they are still an owner/admin of it -- else the earliest owner, else the earliest admin. One
// subscription therefore gives exactly one account its allowance, whichever workspace is selected, however many
// people are members, and however often anyone links or signs in.
//
// Out-of-order and duplicate Stripe events: the webhook no longer writes the status an event carries; it re-reads the
// subscription from Stripe (syncWorkspaceSubscription) so a late or repeated event can only ever write the current
// state. This endpoint does the same on every answer, which also heals a missed webhook.
'use strict';
const crypto = require('crypto');

const PAID = new Set(['active', 'trialing']);
const MANAGERS = new Set(['owner', 'admin']);

function signBody(secret, timestamp, body) { return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex'); }
function verifySignature({ secret, timestamp, signature, body, now = Date.now(), toleranceSec = 300 }) {
  if (!secret || !timestamp || !signature || typeof signature !== 'string') return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > toleranceSec) return false;
  const want = signBody(secret, String(timestamp), body);
  if (signature.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(want));
}

// Stripe moved the billing period from the subscription to its items (API 2025-03-31); read either
function periodOf(sub) {
  const item = (sub && sub.items && Array.isArray(sub.items.data) && sub.items.data[0]) || {};
  const s = sub.current_period_start || item.current_period_start; const e = sub.current_period_end || item.current_period_end;
  const iso = t => (Number.isFinite(Number(t)) && Number(t) > 0 ? new Date(Number(t) * 1000).toISOString() : null);
  return { periodStart: iso(s), periodEnd: iso(e) };
}

async function defaultStripeGet(endpoint) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('Stripe is not configured.');
  const r = await fetch('https://api.stripe.com/v1/' + endpoint, { headers: { Authorization: `Bearer ${key}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((j.error && j.error.message) || 'Stripe request failed'); e.status = r.status; throw e; }
  return j;
}

function createEntitlementService({ db, stripeGet = defaultStripeGet, cacheMs = 60 * 1000, now = () => Date.now() }) {
  const cache = new Map(); // subscription id -> { at, sub }: a short cache so a burst of checks is one Stripe call
  async function liveSubscription(subId) {
    const hit = cache.get(subId);
    if (hit && now() - hit.at < cacheMs) return hit.sub;
    const sub = await stripeGet('subscriptions/' + encodeURIComponent(subId));
    cache.set(subId, { at: now(), sub });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return sub;
  }
  async function billingOwnerOf(workspaceId, sub) {
    const members = ((await db.from('workspace_members').select('user_id,role,created_at').eq('workspace_id', workspaceId)).data || []).filter(m => MANAGERS.has(m.role));
    const named = sub && sub.metadata && sub.metadata.billingUserId;
    if (named && members.some(m => m.user_id === named)) return named;
    members.sort((a, b) => (a.role === 'owner' ? 0 : 1) - (b.role === 'owner' ? 0 : 1) || String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.user_id).localeCompare(String(b.user_id)));
    return members[0] ? members[0].user_id : null;
  }
  // -> the entitlement for this Supabase user (or null). Throws if Stripe cannot be reached (the builder then keeps its
  // last verified answer for a limited time, never invents a new one).
  async function entitlementFor(userId) {
    if (!userId) return null;
    const rows = (await db.from('workspace_members').select('workspace_id,role,workspaces(id,siteremade_subscription_id,siteremade_subscription_status)').eq('user_id', userId)).data || [];
    const found = [];
    for (const r of rows) {
      const w = r.workspaces;
      if (!MANAGERS.has(r.role) || !w || !w.siteremade_subscription_id) continue;
      const sub = await liveSubscription(w.siteremade_subscription_id);
      if (!sub || !sub.id || !sub.metadata || sub.metadata.workspaceId !== w.id) continue; // it must be this workspace's own subscription
      if ((await billingOwnerOf(w.id, sub)) !== userId) continue;
      if (w.siteremade_subscription_status !== sub.status) await db.from('workspaces').update({ siteremade_subscription_status: sub.status }).eq('id', w.id).eq('siteremade_subscription_id', sub.id);
      found.push(Object.assign({ status: String(sub.status || ''), subscriptionId: sub.id, workspaceId: w.id, cancelAtPeriodEnd: !!(sub.cancel_at_period_end || sub.cancel_at) }, periodOf(sub)));
    }
    // several subscribed workspaces: the paid one with the latest period counts
    found.sort((a, b) => (PAID.has(b.status) ? 1 : 0) - (PAID.has(a.status) ? 1 : 0) || String(b.periodEnd || '').localeCompare(String(a.periodEnd || '')));
    return found[0] || null;
  }
  return { entitlementFor, billingOwnerOf, liveSubscription };
}

// Write a workspace's subscription from Stripe's CURRENT state (never from the event that prompted it). An old
// subscription ending never overwrites a different, current one on the same workspace. -> { status, changed } | null
async function syncWorkspaceSubscription({ db, stripeGet = defaultStripeGet, subscriptionId, workspaceId = null }) {
  if (!subscriptionId) return null;
  const sub = await stripeGet('subscriptions/' + encodeURIComponent(subscriptionId));
  const wid = sub && sub.metadata && sub.metadata.workspaceId;
  if (!wid || (workspaceId && wid !== workspaceId)) return null;
  const row = (await db.from('workspaces').select('id,siteremade_subscription_id,siteremade_subscription_status').eq('id', wid).maybeSingle()).data;
  if (!row) return null;
  if (row.siteremade_subscription_id && row.siteremade_subscription_id !== sub.id && !PAID.has(sub.status)) return { status: row.siteremade_subscription_status, changed: false, ignored: true };
  const changed = row.siteremade_subscription_id !== sub.id || row.siteremade_subscription_status !== sub.status;
  if (changed) await db.from('workspaces').update({ siteremade_subscription_id: sub.id, siteremade_customer_id: sub.customer || null, siteremade_subscription_status: sub.status }).eq('id', wid);
  return { status: sub.status, changed, workspaceId: wid };
}
// the subscription an invoice belongs to (older and newer Stripe API shapes)
function invoiceSubscriptionId(invoice) {
  if (!invoice) return null;
  if (typeof invoice.subscription === 'string') return invoice.subscription;
  if (invoice.subscription && invoice.subscription.id) return invoice.subscription.id;
  const d = invoice.parent && invoice.parent.subscription_details;
  return (d && (typeof d.subscription === 'string' ? d.subscription : d.subscription && d.subscription.id)) || null;
}

module.exports = { PAID, signBody, verifySignature, periodOf, createEntitlementService, syncWorkspaceSubscription, invoiceSubscriptionId, defaultStripeGet };
