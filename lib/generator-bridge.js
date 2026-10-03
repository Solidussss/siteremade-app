// Phase 4 (app bridge): the ONE place this app talks to the SiteRemade
// generator server-to-server -- its /api/app-bridge/* contract (see the
// generator repo's server.js "App bridge pass (Phase 4)" section).
//
// Identity: every call forwards the CURRENT signed-in user's own Supabase
// access token (lib/context.js getAuthUser()/getContext() -> `c.access`,
// already verified -- and refreshed if needed -- by this app on this same
// request) as `Authorization: Bearer <token>`. The generator re-verifies it
// with Supabase and resolves the user's own generator account through its
// identity_links table on every call. This file never uses, reads, or
// sends a service-role key, never sends a user/account/project id for
// AUTHORIZATION (a project id only ever names which record, and the
// generator re-checks ownership), and never logs the token.
//
// Host: WEBSITE_BUILDER_URL -- the same env var (and the same
// https://siteremade.com default) routes/website-builder-handoff.js already
// uses for the generator's origin. Read per call, not at module load.
//
// Every function resolves (never throws) to {status, data}; a network
// failure/timeout is {status: 0, data: null} so callers can say "the
// builder couldn't be reached" honestly instead of guessing.
'use strict';

function generatorOrigin() {
  const raw = String(process.env.WEBSITE_BUILDER_URL || 'https://siteremade.com').trim().replace(/\/$/, '');
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch (e) { return null; }
}

const TIMEOUTS_MS = {
  read: 10000,
  // An edit is one synchronous generator request that includes a Claude
  // call (25s ceiling there) plus any replacement images -- generous on
  // purpose so a slow-but-successful edit is never reported as failed here.
  // A redesign ("Update My Website" deep refinement) plans the whole site in one larger call; a Creative page's
  // revision may add one bounded repair and a claim check -- still one request, so the ceiling is raised to match.
  edit: 210000,
  publish: 20000,
  // the purchased-website ZIP: the builder compiles and packages the whole site before the first byte
  download: 120000,
  // an owner picture for a Creative page (a PNG of up to 8 MB, measured by the builder before it answers)
  upload: 60000,
};

async function call(method, path, accessToken, body, timeoutMs, extraHeaders) {
  const origin = generatorOrigin();
  if (!origin || !accessToken || typeof accessToken !== 'string') return { status: 0, data: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (extraHeaders) Object.assign(headers, extraHeaders);
    const r = await fetch(origin + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: controller.signal, redirect: 'error' });
    let data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    return { status: r.status, data };
  } catch (e) {
    return { status: 0, data: null };
  } finally {
    clearTimeout(timer);
  }
}

async function callText(method, path, accessToken, timeoutMs) {
  const origin = generatorOrigin();
  if (!origin || !accessToken || typeof accessToken !== 'string') return { status: 0, text: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(origin + path, { method, headers: { Authorization: `Bearer ${accessToken}`, Accept: 'text/html' }, signal: controller.signal, redirect: 'error' });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    return { status: 0, text: null };
  } finally {
    clearTimeout(timer);
  }
}

// Binary responses (the website ZIP): the body is read as raw bytes -- never decoded as text or JSON -- so the
// archive reaches the browser byte for byte. An error body (JSON) is returned as bytes too; the caller decodes it.
async function callBinary(method, path, accessToken, timeoutMs) {
  const origin = generatorOrigin();
  if (!origin || !accessToken || typeof accessToken !== 'string') return { status: 0, buffer: null, headers: null, error: 'not_configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(origin + path, { method, headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/zip,application/octet-stream,application/json' }, signal: controller.signal, redirect: 'error' });
    const ab = await r.arrayBuffer();
    return { status: r.status, buffer: Buffer.from(ab), headers: r.headers };
  } catch (e) {
    return { status: 0, buffer: null, headers: null, error: e && e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

// Phase 6: staff-facing health check for Admin -- is the builder's bridge
// switched on? Deliberately sends NO token (so no identity is involved and
// nothing is resolved or logged against anyone): the builder's
// requireAppBridgeAuth answers 404 {ok:false} while
// SITEREMADE_APP_BRIDGE_ENABLED isn't 'true', and 401 once it is and a
// token is simply missing. Resolves 'on' | 'off' | 'unreachable'.
async function probeBridge() {
  const origin = generatorOrigin();
  if (!origin) return 'unreachable';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const r = await fetch(origin + '/api/app-bridge/website', { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal, redirect: 'error' });
    if (r.status === 401) return 'on';
    if (r.status === 404) return 'off';
    return 'unreachable';
  } catch (e) {
    return 'unreachable';
  } finally {
    clearTimeout(timer);
  }
}

const enc = encodeURIComponent;
module.exports = {
  generatorOrigin, probeBridge,
  getWebsite: (token) => call('GET', '/api/app-bridge/website', token, undefined, TIMEOUTS_MS.read),
  // Phase 9: the explicit-id sibling of getWebsite above -- for a specific
  // purchased project (not just "canonical," the generator's still-
  // singular "most recently purchased" resolution), used once a workspace
  // has more than one linked project (website_project_links can hold
  // several rows per workspace now -- see lib/website-links.js's own
  // Phase 9 header). Same response shape as getWebsite for the same
  // project (generator server.js's buildWebsiteSummary is shared by both
  // routes), so callers can treat the two interchangeably once they know
  // which project id they want.
  getWebsiteById: (token, projectId) => call('GET', `/api/app-bridge/website/${enc(projectId)}`, token, undefined, TIMEOUTS_MS.read),
  // Phase 6: every PURCHASED project of the signed-in customer (metadata
  // only: {projectId, purchaseRef, purchasedAt, revision}), resolved by the
  // builder from this same verified token -- used only to capture the
  // choices staff may pick from when a link needs review.
  getCandidates: (token) => call('GET', '/api/app-bridge/website/candidates', token, undefined, TIMEOUTS_MS.read),
  // EVERY website saved to the signed-in person's builder account -- drafts and purchased, Business and Creative --
  // as metadata only (the builder's GET /api/app-bridge/websites, lib/saved-websites.js there)
  getWebsites: (token) => call('GET', '/api/app-bridge/websites', token, undefined, TIMEOUTS_MS.read),
  // WEBSITE REMOVAL (the website admin only -- lib/website-admin.js; the builder checks it again on its own): every
  // account's active websites, and the removal of one (a soft delete there: its purchase, payments and ledger stay)
  adminWebsites: (token) => call('GET', '/api/app-bridge/admin/websites', token, undefined, TIMEOUTS_MS.read),
  adminRemoveWebsite: (token, projectId) => call('POST', `/api/app-bridge/admin/websites/${enc(projectId)}/remove`, token, {}, TIMEOUTS_MS.publish),
  getDeployment: (token, projectId) => call('GET', `/api/app-bridge/website/${enc(projectId)}/deployment`, token, undefined, TIMEOUTS_MS.read),
  // draft: the latest saved draft (what an update just changed), for review before publishing; otherwise the
  // published/purchased website -- the one the download contains
  getPreview: (token, projectId, opts) => callText('GET', `/api/app-bridge/website/${enc(projectId)}/preview${opts && opts.draft ? '?source=draft' : ''}`, token, TIMEOUTS_MS.read),
  downloadWebsite: (token, projectId) => callBinary('GET', `/api/app-bridge/website/${enc(projectId)}/download`, token, TIMEOUTS_MS.download),
  // BILLING PASS: an AI update is paid from the builder's credit ledger; the idempotency key makes a retried or
  // reconnected request return the same result instead of editing (and charging) twice
  // OWNERSHIP + CREDITS: an update runs only with the owner's confirmed quote (the builder prices it, then reserves it)
  postEdit: (token, projectId, { baseRevision, request, requestId, quoteId }) => call('POST', `/api/app-bridge/website/${enc(projectId)}/edits`, token, Object.assign({ baseRevision, request }, quoteId ? { quoteId: String(quoteId).slice(0, 60) } : {}), TIMEOUTS_MS.edit, requestId ? { 'Idempotency-Key': String(requestId).slice(0, 120) } : undefined),
  postQuote: (token, { operation, request, projectId }) => call('POST', '/api/app-bridge/quotes', token, { operation: operation || 'website_update', request, projectId }, TIMEOUTS_MS.read),
  postCreditCheckout: (token, packId) => call('POST', '/api/app-bridge/credits/checkout', token, { packId }, TIMEOUTS_MS.read),
  getCreditHistory: (token) => call('GET', '/api/app-bridge/credits/history', token, undefined, TIMEOUTS_MS.read),
  // BILLING PASS: the one balance, plan, renewal date and prices, exactly as the builder shows them
  getCredits: (token, refresh) => call('GET', '/api/app-bridge/credits' + (refresh ? '?refresh=1' : ''), token, undefined, TIMEOUTS_MS.read),
  publish: (token, projectId, { revision }) => call('POST', `/api/app-bridge/website/${enc(projectId)}/publish`, token, { revision }, TIMEOUTS_MS.publish),
  // THE CREATIVE WEBSITE EDITOR (a Creative website edited as the Creative project it is -- the builder's
  // /api/app-bridge/website/:id/creative/*): the outline, a free change, an owner picture (a PNG made in the browser; the
  // builder measures it), the builder's quote for a paid action, its start once confirmed, the page's jobs, and the
  // page that draws a 3D model's cinematic still. The builder authorizes every one of them again from this token.
  getCreative: (token, projectId) => call('GET', `/api/app-bridge/website/${enc(projectId)}/creative`, token, undefined, TIMEOUTS_MS.read),
  postCreativeEdit: (token, projectId, body) => call('POST', `/api/app-bridge/website/${enc(projectId)}/creative/edit`, token, body, TIMEOUTS_MS.publish),
  postCreativeUpload: (token, projectId, body) => call('POST', `/api/app-bridge/website/${enc(projectId)}/creative/upload`, token, body, TIMEOUTS_MS.upload),
  postCreativeQuote: (token, projectId, body) => call('POST', `/api/app-bridge/website/${enc(projectId)}/creative/quote`, token, body, TIMEOUTS_MS.read),
  postCreativeStart: (token, projectId, body) => call('POST', `/api/app-bridge/website/${enc(projectId)}/creative/start`, token, body, TIMEOUTS_MS.edit),
  getCreativeJobs: (token, projectId) => call('GET', `/api/app-bridge/website/${enc(projectId)}/creative/jobs`, token, undefined, TIMEOUTS_MS.read),
  // a Creative page's open-source font file, by name (public on the builder: /creative-fonts/<file> -- no token, no identity)
  getCreativeFont: async file => {
    const origin = generatorOrigin(); if (!origin) return { status: 0, buffer: null };
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), TIMEOUTS_MS.read);
    try { const r = await fetch(origin + '/creative-fonts/' + encodeURIComponent(file), { signal: controller.signal, redirect: 'error' }); return { status: r.status, buffer: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || '' }; }
    catch (e) { return { status: 0, buffer: null }; } finally { clearTimeout(timer); }
  },
  getCreativeStill: (token, projectId) => callText('GET', `/api/app-bridge/website/${enc(projectId)}/creative/still`, token, TIMEOUTS_MS.download),
};
