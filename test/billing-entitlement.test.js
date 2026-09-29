'use strict';
// BILLING PASS: the Workspace subscription as the SiteRemade builder sees it (lib/billing-entitlement.js and
// POST /api/internal/billing/entitlement), with the Supabase records and Stripe replaced by in-memory fakes. No network,
// no real Stripe, no real charges.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { signBody, verifySignature, createEntitlementService, syncWorkspaceSubscription, invoiceSubscriptionId, periodOf } = require('../lib/billing-entitlement');
const registerBillingInternalRoutes = require('../routes/billing-internal');

// ---- a tiny stand-in for the Supabase query builder: from(t).select(...).eq(...).maybeSingle() / update(...).eq(...)
function fakeDb(tables) {
  const calls = [];
  function from(table) {
    const filters = []; let update = null; let select = null;
    const rows = () => (tables[table] || []).filter(r => filters.every(([k, v]) => r[k] === v));
    const shape = r => {
      if (table === 'workspace_members' && select && select.includes('workspaces(')) return Object.assign({}, r, { workspaces: (tables.workspaces || []).find(w => w.id === r.workspace_id) || null });
      return Object.assign({}, r);
    };
    const q = {
      select(s) { select = s; return q; },
      update(u) { update = u; return q; },
      eq(k, v) { filters.push([k, v]); return q; },
      maybeSingle() { const r = rows()[0]; return Promise.resolve({ data: r ? shape(r) : null }); },
      then(resolve, reject) {
        if (update) { const hit = rows(); hit.forEach(r => Object.assign(r, update)); calls.push({ table, update, filters: filters.slice(), count: hit.length }); return Promise.resolve({ data: null, error: null }).then(resolve, reject); }
        return Promise.resolve({ data: rows().map(shape) }).then(resolve, reject);
      },
    };
    return q;
  }
  return { from, calls, tables };
}
const T = s => Math.floor(Date.parse(s) / 1000);
function sub(id, workspaceId, status, extra) {
  return Object.assign({ id, customer: 'cus_1', status, metadata: { workspaceId }, current_period_start: T('2026-09-01T00:00:00Z'), current_period_end: T('2026-10-01T00:00:00Z'), cancel_at_period_end: false }, extra);
}
function fakeStripe(subs) {
  const seen = [];
  const get = async endpoint => { seen.push(endpoint); const id = decodeURIComponent(endpoint.replace(/^subscriptions\//, '')); if (subs.down) throw new Error('Stripe is unreachable'); if (!subs[id]) { const e = new Error('No such subscription'); e.status = 404; throw e; } return subs[id]; };
  get.seen = seen; return get;
}
const U1 = '11111111-1111-4111-8111-111111111111', U2 = '22222222-2222-4222-8222-222222222222', U3 = '33333333-3333-4333-8333-333333333333';

test('signatures: a fresh, correctly signed body is accepted; stale, tampered or wrongly signed ones are refused', () => {
  const now = Date.parse('2026-09-29T12:00:00Z'); const ts = String(Math.floor(now / 1000)); const body = JSON.stringify({ supabaseUserId: U1 });
  const sig = signBody('s3cret', ts, body);
  assert.equal(verifySignature({ secret: 's3cret', timestamp: ts, signature: sig, body, now }), true);
  assert.equal(verifySignature({ secret: 's3cret', timestamp: ts, signature: sig, body: body.replace('1111', '2222'), now }), false, 'tampered body');
  assert.equal(verifySignature({ secret: 'other', timestamp: ts, signature: sig, body, now }), false, 'wrong secret');
  assert.equal(verifySignature({ secret: 's3cret', timestamp: ts, signature: sig, body, now: now + 10 * 60 * 1000 }), false, 'too old');
  assert.equal(verifySignature({ secret: '', timestamp: ts, signature: sig, body, now }), false, 'no secret configured');
  assert.equal(verifySignature({ secret: 's3cret', timestamp: ts, signature: 'x', body, now }), false);
});

test('the billing owner of a live, matching subscription gets the entitlement -- from Stripe, not the stored status', async () => {
  const db = fakeDb({
    workspaces: [{ id: 'ws_1', siteremade_subscription_id: 'sub_1', siteremade_subscription_status: 'inactive' }],
    workspace_members: [{ workspace_id: 'ws_1', user_id: U1, role: 'admin', created_at: '2026-01-01' }, { workspace_id: 'ws_1', user_id: U2, role: 'admin', created_at: '2026-02-01' }, { workspace_id: 'ws_1', user_id: U3, role: 'member', created_at: '2025-01-01' }],
  });
  const stripeGet = fakeStripe({ sub_1: sub('sub_1', 'ws_1', 'active') });
  const svc = createEntitlementService({ db, stripeGet });
  const e = await svc.entitlementFor(U1);
  assert.deepEqual(e, { status: 'active', subscriptionId: 'sub_1', workspaceId: 'ws_1', cancelAtPeriodEnd: false, periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-10-01T00:00:00.000Z' });
  assert.equal(db.tables.workspaces[0].siteremade_subscription_status, 'active', 'the stored status is healed from Stripe');
  assert.equal(await svc.entitlementFor(U2), null, 'a second admin does not get a second allowance');
  assert.equal(await svc.entitlementFor(U3), null, 'a plain member never holds the allowance');
  assert.equal(await svc.entitlementFor('44444444-4444-4444-8444-444444444444'), null, 'a stranger gets nothing');
});

test('the member who started the subscription holds it while they are an owner or admin of the workspace', async () => {
  const db = fakeDb({
    workspaces: [{ id: 'ws_1', siteremade_subscription_id: 'sub_1', siteremade_subscription_status: 'active' }],
    workspace_members: [{ workspace_id: 'ws_1', user_id: U1, role: 'admin', created_at: '2026-01-01' }, { workspace_id: 'ws_1', user_id: U2, role: 'admin', created_at: '2026-02-01' }],
  });
  const svc = createEntitlementService({ db, stripeGet: fakeStripe({ sub_1: sub('sub_1', 'ws_1', 'active', { metadata: { workspaceId: 'ws_1', billingUserId: U2 } }) }) });
  assert.equal(await svc.entitlementFor(U1), null);
  assert.equal((await svc.entitlementFor(U2)).subscriptionId, 'sub_1');
});

test('a subscription that belongs to another workspace, or that Stripe cannot confirm, never grants anything', async () => {
  const db = fakeDb({
    workspaces: [{ id: 'ws_1', siteremade_subscription_id: 'sub_other', siteremade_subscription_status: 'active' }],
    workspace_members: [{ workspace_id: 'ws_1', user_id: U1, role: 'owner', created_at: '2026-01-01' }],
  });
  assert.equal(await createEntitlementService({ db, stripeGet: fakeStripe({ sub_other: sub('sub_other', 'ws_2', 'active') }) }).entitlementFor(U1), null, 'stored "active" is not enough');
  await assert.rejects(createEntitlementService({ db, stripeGet: fakeStripe({ down: true }) }).entitlementFor(U1), /unreachable/, 'no answer is invented when Stripe is down');
});

test('status, scheduled cancellation and the newer Stripe period shape are passed through as they are', async () => {
  const db = fakeDb({ workspaces: [{ id: 'ws_1', siteremade_subscription_id: 'sub_1', siteremade_subscription_status: 'active' }], workspace_members: [{ workspace_id: 'ws_1', user_id: U1, role: 'owner', created_at: '2026-01-01' }] });
  const newer = sub('sub_1', 'ws_1', 'past_due', { current_period_start: undefined, current_period_end: undefined, cancel_at_period_end: true, items: { data: [{ current_period_start: T('2026-09-05T00:00:00Z'), current_period_end: T('2026-10-05T00:00:00Z') }] } });
  const e = await createEntitlementService({ db, stripeGet: fakeStripe({ sub_1: newer }) }).entitlementFor(U1);
  assert.equal(e.status, 'past_due'); assert.equal(e.cancelAtPeriodEnd, true); assert.equal(e.periodStart, '2026-09-05T00:00:00.000Z');
  assert.deepEqual(periodOf({}), { periodStart: null, periodEnd: null });
});

test('webhook sync: duplicate and out-of-order events write only Stripe\'s current state; an old subscription never overrides a new one', async () => {
  const db = fakeDb({ workspaces: [{ id: 'ws_1', siteremade_subscription_id: 'sub_1', siteremade_subscription_status: 'active' }] });
  const subs = { sub_1: sub('sub_1', 'ws_1', 'canceled') };
  const stripeGet = fakeStripe(subs);
  // a late "updated: active" event arrives after the cancellation: the live state wins
  const r1 = await syncWorkspaceSubscription({ db, stripeGet, subscriptionId: 'sub_1', workspaceId: 'ws_1' });
  assert.equal(r1.status, 'canceled'); assert.equal(db.tables.workspaces[0].siteremade_subscription_status, 'canceled');
  const r2 = await syncWorkspaceSubscription({ db, stripeGet, subscriptionId: 'sub_1', workspaceId: 'ws_1' });
  assert.equal(r2.changed, false, 'a duplicate changes nothing');
  // the customer subscribes again (a new subscription); a late event for the old, ended one is ignored
  subs.sub_2 = sub('sub_2', 'ws_1', 'active');
  await syncWorkspaceSubscription({ db, stripeGet, subscriptionId: 'sub_2', workspaceId: 'ws_1' });
  assert.equal(db.tables.workspaces[0].siteremade_subscription_id, 'sub_2');
  const old = await syncWorkspaceSubscription({ db, stripeGet, subscriptionId: 'sub_1', workspaceId: 'ws_1' });
  assert.equal(old.ignored, true); assert.equal(db.tables.workspaces[0].siteremade_subscription_status, 'active');
  // an event naming a different workspace than the subscription's own is ignored
  assert.equal(await syncWorkspaceSubscription({ db, stripeGet, subscriptionId: 'sub_2', workspaceId: 'ws_other' }), null);
  // invoices name their subscription in both API shapes
  assert.equal(invoiceSubscriptionId({ subscription: 'sub_x' }), 'sub_x');
  assert.equal(invoiceSubscriptionId({ parent: { subscription_details: { subscription: 'sub_y' } } }), 'sub_y');
});

// ---- the route, called the way the builder calls it
function routeHandler(deps) { let handler = null; registerBillingInternalRoutes({ post: (p, o, h) => { handler = h; } }, deps); return handler; }
async function callRoute(handler, { body, headers }) {
  const req = Readable.from([Buffer.from(body)]); req.headers = headers; req.method = 'POST';
  let out = null; const json = (res, status, obj) => { out = { status, body: obj }; };
  await handler(req, {}, { json });
  return out;
}
test('route: only a correctly signed request from the builder gets an answer, and the answer is the live entitlement', async () => {
  process.env.SITEREMADE_BILLING_SECRET = 'route-secret';
  const db = fakeDb({ workspaces: [{ id: 'ws_1', siteremade_subscription_id: 'sub_1', siteremade_subscription_status: 'active' }], workspace_members: [{ workspace_id: 'ws_1', user_id: U1, role: 'owner', created_at: '2026-01-01' }] });
  const handler = routeHandler({ db, stripeGet: fakeStripe({ sub_1: sub('sub_1', 'ws_1', 'trialing') }) });
  const body = JSON.stringify({ supabaseUserId: U1 }); const ts = String(Math.floor(Date.now() / 1000));
  const ok = await callRoute(handler, { body, headers: { 'x-siteremade-timestamp': ts, 'x-siteremade-signature': signBody('route-secret', ts, body) } });
  assert.equal(ok.status, 200); assert.equal(ok.body.entitlement.status, 'trialing');
  const unsigned = await callRoute(handler, { body, headers: {} });
  assert.equal(unsigned.status, 401); assert.equal(unsigned.body.entitlement, undefined);
  const forged = await callRoute(handler, { body, headers: { 'x-siteremade-timestamp': ts, 'x-siteremade-signature': signBody('guess', ts, body) } });
  assert.equal(forged.status, 401);
  const junk = JSON.stringify({ supabaseUserId: 'not-a-user-id!' });
  assert.equal((await callRoute(handler, { body: junk, headers: { 'x-siteremade-timestamp': ts, 'x-siteremade-signature': signBody('route-secret', ts, junk) } })).status, 400);
  delete process.env.SITEREMADE_BILLING_SECRET;
  assert.equal((await callRoute(handler, { body, headers: { 'x-siteremade-timestamp': ts, 'x-siteremade-signature': signBody('route-secret', ts, body) } })).status, 503, 'without the secret the endpoint is closed');
});

test('route: when Stripe cannot be reached the builder is told so (503), never handed a guess', async () => {
  process.env.SITEREMADE_BILLING_SECRET = 'route-secret';
  const db = fakeDb({ workspaces: [{ id: 'ws_1', siteremade_subscription_id: 'sub_1', siteremade_subscription_status: 'active' }], workspace_members: [{ workspace_id: 'ws_1', user_id: U1, role: 'owner', created_at: '2026-01-01' }] });
  const handler = routeHandler({ db, stripeGet: fakeStripe({ down: true }) });
  const body = JSON.stringify({ supabaseUserId: U1 }); const ts = String(Math.floor(Date.now() / 1000));
  const r = await callRoute(handler, { body, headers: { 'x-siteremade-timestamp': ts, 'x-siteremade-signature': signBody('route-secret', ts, body) } });
  assert.equal(r.status, 503);
  delete process.env.SITEREMADE_BILLING_SECRET;
});

// ---- the builder's signing (generator lib/billing.js) and this app's check agree byte for byte
test('the builder\'s request format is what this endpoint verifies', () => {
  const body = JSON.stringify({ supabaseUserId: U1 }); const ts = '1790000000';
  const builderSignature = require('crypto').createHmac('sha256', 'shared').update(`${ts}.${body}`).digest('hex');
  assert.equal(verifySignature({ secret: 'shared', timestamp: ts, signature: builderSignature, body, now: 1790000000 * 1000 }), true);
});
