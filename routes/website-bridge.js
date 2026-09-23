// Phase 4 (app bridge): the app-side half of the generator <-> app
// WebsiteProject contract. Four routes for this app's OWN frontend, each
// gated by the app's EXISTING session auth ({ auth: 'user' } -> getContext:
// signed-in user + profile + workspace membership, 401 otherwise) and each
// forwarding that same user's own Supabase access token to the generator
// through lib/generator-bridge.js. No service-role key, no generator
// database access, nothing cached across requests.
//
//   GET  /api/app/website             -> canonical website summary
//   GET  /api/app/website/deployment  -> its deployment/domain state
//   POST /api/app/website/edits       -> {baseRevision, request[, expectedProjectId]}
//   POST /api/app/website/publish     -> {revision[, expectedProjectId]}
//
// Which project: never chosen by the browser. Each call re-asks the
// generator for the signed-in user's canonical project (GET
// /api/app-bridge/website -- the generator resolves it from the verified
// identity alone) and acts on that id. `expectedProjectId`, if the browser
// sends it, is only COMPARED against that fresh answer (a mismatch is
// reported as a conflict so an edit reviewed against one project can never
// land on another); it is never used to pick or authorize anything.
//
// Workspace rule (the canonical project belongs to a PERSON -- the
// Supabase user -- not to a workspace): generator data is only shown when
// the request is unambiguous -- a non-staff user with exactly one workspace.
// SiteRemade staff (profile.role 'owner', who can open every customer's
// workspace) and multi-workspace users get `workspace_mismatch`, and the
// UI keeps the honest delivery-record fallback, rather than ever showing
// the signed-in person's own generator project as some other workspace's
// website.
//
// Phase 5: that same unambiguous GET /api/app/website is also the ONE place
// the workspace <-> project reference link (public.website_project_links,
// lib/website-links.js) is written -- once, for a PURCHASED project -- and
// kept current (last seen revision). The link never replaces the fresh
// builder call above: every route still resolves the project from the
// builder, with the user's own token, on every request.
//
// Responses are passed through faithfully: a generator 409 stays a 409, a
// 402 stays a 402, etc. Every non-success carries a stable `code`.
// `appliedOperations` (internal, structured) is stripped before anything
// reaches the browser -- customers only ever see `changeSummary`.
const { readJsonBody } = require('../lib/context');
const bridge = require('../lib/generator-bridge');
const websiteLinks = require('../lib/website-links');

const MAX_REQUEST_CHARS = 600; // the generator's own ceiling for an edit request

function workspaceGate(c) {
  if (c.owner) return { ok: false, status: 403, code: 'workspace_mismatch', message: 'Staff accounts see each customer’s delivery record here, not a builder project.' };
  if (!Array.isArray(c.workspaces) || c.workspaces.length !== 1) return { ok: false, status: 409, code: 'workspace_mismatch', message: 'This account belongs to more than one business, so the builder project can’t be matched to this one yet.' };
  return { ok: true };
}

// Maps a generator reply that is NOT a success into this app's response.
function passThroughError(json, res, r) {
  if (!r || r.status === 0) return json(res, 502, { ok: false, code: 'bridge_unavailable', message: 'The SiteRemade builder couldn’t be reached.' });
  const err = r.data && r.data.error;
  if (r.status === 404 && !err) return json(res, 503, { ok: false, code: 'bridge_unavailable', message: 'The SiteRemade builder connection isn’t turned on yet.' });
  if (r.status === 401) return json(res, 502, { ok: false, code: 'bridge_unauthenticated', message: 'The SiteRemade builder couldn’t confirm your sign-in.' });
  if (r.status === 429) return json(res, 429, { ok: false, code: 'rate_limited', message: 'Too many requests in a short time. Please try again shortly.', retryAfterSeconds: r.data && r.data.retryAfterSeconds });
  if (err && typeof err.code === 'string') {
    const out = { ok: false, code: err.code, message: String(err.message || '') };
    if (Number.isInteger(err.currentRevision)) out.currentRevision = err.currentRevision;
    if (Number.isFinite(err.creditsRemaining)) out.creditsRemaining = err.creditsRemaining;
    if (typeof err.reason === 'string') out.reason = err.reason;
    if (r.data && r.data.hasCanonicalProject === false) out.hasCanonicalProject = false;
    return json(res, r.status >= 400 && r.status < 600 ? r.status : 502, out);
  }
  return json(res, 502, { ok: false, code: 'bridge_unavailable', message: 'The SiteRemade builder returned something unexpected.' });
}

// The summary fields the UI actually uses -- an explicit allowlist, so
// nothing the generator might add later leaks through by accident.
function summaryFrom(d) {
  return {
    ok: true, source: 'generator', hasCanonicalProject: true,
    projectId: d.projectId, name: d.name, status: d.status, revision: d.revision, purchaseRef: d.purchaseRef || null,
    createdAt: d.createdAt, updatedAt: d.updatedAt, deploymentStatus: d.deploymentStatus, businessName: d.businessName || null,
    domains: Array.isArray(d.domains) ? d.domains.map(x => ({ domain: x.domain, state: x.state, verifiedAt: x.verifiedAt || null })) : [],
    lastPublishedAt: d.lastPublishedAt || null, publishedRevision: Number.isInteger(d.publishedRevision) ? d.publishedRevision : null,
    purchasedRevision: Number.isInteger(d.purchasedRevision) ? d.purchasedRevision : null,
    hasUnpublishedChanges: !!d.hasUnpublishedChanges, canEdit: !!d.canEdit, canPublish: !!d.canPublish,
    previewUrl: null, liveUrl: null,
  };
}

// Link bookkeeping must never break the Website view: any failure (e.g. the
// V52 migration not applied yet) is logged and reported as status 'unknown'.
async function recordLink(c, summary) {
  try {
    return await websiteLinks.recordBridgeSummary(c.wid, summary);
  } catch (e) {
    console.warn('[website-links] could not record link:', e && e.message);
    return { status: 'unknown', link: null, created: false };
  }
}

async function canonical(c) {
  const r = await bridge.getWebsite(c.access);
  if (r.status === 200 && r.data && r.data.ok && r.data.projectId) return { ok: true, summary: r.data };
  return { ok: false, r };
}

module.exports = function registerWebsiteBridgeRoutes(router) {
  router.get('/api/app/website', { auth: 'user' }, async (req, res, { c, json }) => {
    const gate = workspaceGate(c);
    if (!gate.ok) return json(res, gate.status, { ok: false, code: gate.code, message: gate.message });
    const got = await canonical(c);
    if (!got.ok) return passThroughError(json, res, got.r);
    const linked = await recordLink(c, got.summary);
    // Only the link STATUS reaches the browser (linked / not_linked /
    // mismatch / conflict / unknown) -- no ids beyond the projectId the
    // summary already carries.
    return json(res, 200, { ...summaryFrom(got.summary), link: { status: linked.status } });
  });

  router.get('/api/app/website/deployment', { auth: 'user' }, async (req, res, { c, json }) => {
    const gate = workspaceGate(c);
    if (!gate.ok) return json(res, gate.status, { ok: false, code: gate.code, message: gate.message });
    const got = await canonical(c);
    if (!got.ok) return passThroughError(json, res, got.r);
    const r = await bridge.getDeployment(c.access, got.summary.projectId);
    if (r.status !== 200 || !r.data || !r.data.ok) return passThroughError(json, res, r);
    return json(res, 200, {
      ok: true, projectId: r.data.projectId, deploymentStatus: r.data.deploymentStatus, automaticHosting: false,
      deployments: (r.data.deployments || []).map(d => ({ state: d.state, target: d.target, projectRevision: d.projectRevision, deployedUrl: d.deployedUrl || null, failureReason: d.failureReason || null, createdAt: d.createdAt })),
      domains: (r.data.domains || []).map(x => ({ domain: x.domain, state: x.state, verifiedAt: x.verifiedAt || null })),
    });
  });

  router.post('/api/app/website/edits', { auth: 'user' }, async (req, res, { c, json }) => {
    const gate = workspaceGate(c);
    if (!gate.ok) return json(res, gate.status, { ok: false, code: gate.code, message: gate.message });
    let body;
    try { body = await readJsonBody(req, 20000); } catch (e) { return json(res, 400, { ok: false, code: 'invalid_request', message: 'That request couldn’t be read.' }); }
    const request = typeof body.request === 'string' ? body.request.trim() : '';
    if (!request) return json(res, 400, { ok: false, code: 'invalid_request', message: 'Describe the change you want to make.' });
    if (request.length > MAX_REQUEST_CHARS) return json(res, 400, { ok: false, code: 'request_too_long', message: `Please keep automatic updates under ${MAX_REQUEST_CHARS} characters — or send longer requests to the SiteRemade team.` });
    if (!Number.isInteger(body.baseRevision)) return json(res, 400, { ok: false, code: 'invalid_request', message: 'Refresh your website before applying this update.' });
    const got = await canonical(c);
    if (!got.ok) return passThroughError(json, res, got.r);
    if (body.expectedProjectId && body.expectedProjectId !== got.summary.projectId) {
      return json(res, 409, { ok: false, code: 'revision_conflict', message: 'This website changed since you opened it. Refresh before applying this update.', currentRevision: got.summary.revision });
    }
    const r = await bridge.postEdit(c.access, got.summary.projectId, { baseRevision: body.baseRevision, request });
    if (r.status === 200 && r.data && r.data.ok) {
      return json(res, 200, {
        ok: true, projectId: got.summary.projectId, revision: r.data.revision,
        changeSummary: Array.isArray(r.data.changeSummary) ? r.data.changeSummary.filter(s => typeof s === 'string').slice(0, 20) : [],
        creditsCharged: Number.isFinite(r.data.creditsCharged) ? r.data.creditsCharged : null,
        creditsRemaining: Number.isFinite(r.data.creditsRemaining) ? r.data.creditsRemaining : null,
      });
    }
    return passThroughError(json, res, r);
  });

  router.post('/api/app/website/publish', { auth: 'user' }, async (req, res, { c, json }) => {
    const gate = workspaceGate(c);
    if (!gate.ok) return json(res, gate.status, { ok: false, code: gate.code, message: gate.message });
    let body;
    try { body = await readJsonBody(req, 20000); } catch (e) { return json(res, 400, { ok: false, code: 'invalid_request', message: 'That request couldn’t be read.' }); }
    if (!Number.isInteger(body.revision)) return json(res, 400, { ok: false, code: 'invalid_request', message: 'Refresh your website before publishing.' });
    const got = await canonical(c);
    if (!got.ok) return passThroughError(json, res, got.r);
    if (body.expectedProjectId && body.expectedProjectId !== got.summary.projectId) {
      return json(res, 409, { ok: false, code: 'revision_conflict', message: 'This website changed since you reviewed it. Refresh before publishing.', currentRevision: got.summary.revision });
    }
    const r = await bridge.publish(c.access, got.summary.projectId, { revision: body.revision });
    if (r.status === 200 && r.data && r.data.ok) {
      return json(res, 200, { ok: true, published: true, alreadyPublished: !!r.data.alreadyPublished, revision: r.data.revision, publishedAt: r.data.publishedAt, automaticHosting: false });
    }
    return passThroughError(json, res, r);
  });
};
