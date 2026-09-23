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
  edit: 150000,
  publish: 20000,
};

async function call(method, path, accessToken, body, timeoutMs) {
  const origin = generatorOrigin();
  if (!origin || !accessToken || typeof accessToken !== 'string') return { status: 0, data: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
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
  // Phase 6: every PURCHASED project of the signed-in customer (metadata
  // only: {projectId, purchaseRef, purchasedAt, revision}), resolved by the
  // builder from this same verified token -- used only to capture the
  // choices staff may pick from when a link needs review.
  getCandidates: (token) => call('GET', '/api/app-bridge/website/candidates', token, undefined, TIMEOUTS_MS.read),
  getDeployment: (token, projectId) => call('GET', `/api/app-bridge/website/${enc(projectId)}/deployment`, token, undefined, TIMEOUTS_MS.read),
  postEdit: (token, projectId, { baseRevision, request }) => call('POST', `/api/app-bridge/website/${enc(projectId)}/edits`, token, { baseRevision, request }, TIMEOUTS_MS.edit),
  publish: (token, projectId, { revision }) => call('POST', `/api/app-bridge/website/${enc(projectId)}/publish`, token, { revision }, TIMEOUTS_MS.publish),
};
