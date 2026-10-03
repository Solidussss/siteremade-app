// Phase 4 (app bridge): the app-side half of the generator <-> app
// WebsiteProject contract. Four routes for this app's OWN frontend, each
// gated by the app's EXISTING session auth ({ auth: 'user' } -> getContext:
// signed-in user + profile + workspace membership, 401 otherwise) and each
// forwarding that same user's own Supabase access token to the generator
// through lib/generator-bridge.js. No service-role key, no generator
// database access, nothing cached across requests.
//
//   GET  /api/app/website             -> canonical website summary
//   GET  /api/app/website/candidates  -> Phase 8: every purchased project this signed-in person owns
//   POST /api/app/website/connect     -> Phase 8: {projectId} -> creates the FIRST link for this workspace
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
// Phase 6: when that same GET finds a recorded MISMATCH (the builder now
// reports a different project than the linked one -- e.g. a second
// purchase), it also asks the builder, with this same customer's token, for
// every project the customer has purchased and stores that metadata-only
// list on the link (lib/website-links.js recordMismatchCandidates). The
// link itself is still never re-pointed here. Staff resolve it later with
// POST /api/app/admin/website-links/:workspaceId/relink (auth 'owner'),
// which only accepts an id from that stored, builder-verified list.
//
// Responses are passed through faithfully: a generator 409 stays a 409, a
// 402 stays a 402, etc. Every non-success carries a stable `code`.
// `appliedOperations` (internal, structured) is stripped before anything
// reaches the browser -- customers only ever see `changeSummary`.
const { readJsonBody, db, hasSiteRemadeAccess, requireSiteRemadeAccess } = require('../lib/context');
const { sendWebsiteDownload } = require('../lib/website-download');
const bridge = require('../lib/generator-bridge');
const websiteLinks = require('../lib/website-links');
const { savedWebsitesFrom } = require('../lib/saved-websites');
const websiteAdmin = require('../lib/website-admin');
const { provisionWorkspaceSite, analytics, ensureWorkspaceSite, umamiDomainOk, domainOf, umamiConfigured } = require('./umami-analytics');

// Phase 5: a linked workspace gets its analytics site set up server-side,
// without the customer typing a domain first. Runs in the background (never
// delays or fails the Website view -- Umami being slow or down must not
// matter here), at most one attempt in flight per workspace, and retried on
// a later visit (throttled) while the link still has no analytics_site_id.
const PROVISION_RETRY_MS = 10 * 60 * 1000;
const provisioning = new Map(); // workspace id -> last attempt (ms) / in-flight marker
function provisionAnalyticsInBackground(c, summary, link) {
  if (!link || link.analytics_site_id) return;
  // Phase 9: this is the SINGULAR/legacy path (triggered only from the
  // canonical GET /api/app/website, which -- like the generator's own
  // canonical resolution -- deals with exactly one project at a time) and
  // it deliberately keeps provisioning the legacy, workspace-level row
  // (project_id IS NULL, projectId omitted below) -- the exact same row
  // GET/POST /api/app/analytics/website and GET/POST /api/app/umami/
  // analytics have always read. Passing link.generator_project_id through
  // here was tried and reverted: it made this call write a project-scoped
  // row while those legacy read endpoints kept reading the NULL row,
  // breaking analytics for every existing single-project workspace (caught
  // by analytics-connect-e2e-test.js E7). A NEW project's own analytics
  // identity is provisioned through the project-scoped routes below
  // instead (GET/POST /api/app/website/projects/:projectId/analytics),
  // which read/write project_id-scoped rows from the start.
  //
  // Keyed by (workspace, project) rather than just workspace: harmless and
  // forward-looking now that a workspace can have several links, each with
  // its own analytics_site_id/backoff state, even though every provision
  // call below still targets the one shared legacy row.
  const key = c.wid + ':' + link.generator_project_id;
  const last = provisioning.get(key);
  if (last === 'inflight' || (typeof last === 'number' && Date.now() - last < PROVISION_RETRY_MS)) return;
  provisioning.set(key, 'inflight');
  // The Umami site is named after the business; a domain is only passed if
  // the builder reports one as verified -- display metadata, never identity.
  const verified = (Array.isArray(summary.domains) ? summary.domains : []).find(d => d && d.verifiedAt && typeof d.domain === 'string');
  provisionWorkspaceSite(c.wid, { name: summary.businessName || (c.workspace && c.workspace.business_name) || summary.name || '', domain: verified ? verified.domain : '' })
    .then(r => { if (r.ok) provisioning.delete(key); else provisioning.set(key, Date.now()); })
    .catch(() => provisioning.set(key, Date.now()));
}

const MAX_REQUEST_CHARS = 600; // the generator's own ceiling for an edit request

// Owners can inspect every workspace, but may only use their personal
// builder identity inside a workspace they are directly a member of.
// This keeps customer workspaces isolated while allowing an owner to
// manage their own business exactly like a normal customer.
async function ownerMembership(c) {
  const membership = await db.from('workspace_members').select('workspace_id').eq('user_id', c.user.id).eq('workspace_id', c.wid).maybeSingle();
  if (membership.error) return { ok: false, status: 503, code: 'workspace_gate_unavailable', message: 'Website access could not be verified right now.' };
  if (!membership.data) return { ok: false, status: 403, code: 'workspace_mismatch', message: 'Staff accounts see each customer’s delivery record here, not their own builder project.' };
  return { ok: true };
}
// For "the canonical project" (no project id: the builder resolves the person's newest purchase), which has to assume
// the person's website belongs to THIS workspace -- only safe when they have exactly one.
async function workspaceGate(c) {
  if (c.owner) return ownerMembership(c);
  if (!Array.isArray(c.workspaces) || c.workspaces.length !== 1) return { ok: false, status: 409, code: 'workspace_mismatch', message: 'This account belongs to more than one business, so the builder project can’t be matched to this one yet.' };
  return { ok: true };
}
// RELOAD FIX: for everything addressed by a project id -- the person's own saved websites (the builder re-verifies
// ownership from their token on every call) and the websites THIS workspace has connected (forWorkspaceProject checks
// the link too). Nothing is guessed there, so a person in several businesses still sees their own saved websites,
// connects one to the business they are in explicitly, and opens a connected one. Staff still need direct membership.
async function memberGate(c) {
  if (c.owner) return ownerMembership(c);
  if (!Array.isArray(c.workspaces) || !c.workspaces.some(w => w && w.id === c.wid)) return { ok: false, status: 403, code: 'workspace_mismatch', message: 'Website access could not be verified for this business.' };
  return { ok: true };
}
// Is THIS workspace the person's only business? Only then is a website they bought connected to it automatically
// (lib/website-links.js autoLinkVerifiedPurchases). A customer: getContext already lists their memberships. Staff:
// getContext lists every workspace, so their own direct memberships are counted instead. Any doubt -> false.
async function soleWorkspace(c) {
  try {
    if (!c || !c.wid) return false;
    if (!c.owner) return Array.isArray(c.workspaces) && c.workspaces.length === 1 && c.workspaces[0].id === c.wid;
    const r = await db.from('workspace_members').select('workspace_id').eq('user_id', c.user.id);
    return !r.error && Array.isArray(r.data) && r.data.length === 1 && r.data[0].workspace_id === c.wid;
  } catch (e) { return false; }
}
// Never breaks the caller: an auto-link problem just leaves the website unconnected for the next load to retry.
async function autoLink(c, websites) {
  try { return await websiteLinks.autoLinkVerifiedPurchases(c.wid, websites); }
  catch (e) { console.warn('[website-links] auto-link skipped:', e && e.message); return { created: [], existing: [], skipped: [] }; }
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
    // an update that needs the owner's confirmation carries its quote (credits only -- never provider costs)
    if (err.quote && typeof err.quote === 'object') out.quote = quoteFrom(err.quote);
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
    // the website's kind, from the builder's own project (never inferred here): the Website view shows the Creative editor
    // for 'creative' and the Business update flow for 'business'
    kind: d.kind === 'creative' ? 'creative' : 'business',
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

// Phase 6: capture the candidate list for a recorded mismatch, once per
// mismatch, with the customer's own token. Never fails the Website view:
// any problem just leaves the list uncaptured (Admin says so) for the next
// visit to retry.
async function captureMismatchCandidates(c, linked) {
  if (linked.status !== 'mismatch' || !websiteLinks.needsCandidateCapture(linked.link)) return;
  try {
    const r = await bridge.getCandidates(c.access);
    if (r.status !== 200 || !r.data || !r.data.ok || !Array.isArray(r.data.candidates)) {
      console.warn('[website-links] candidate capture skipped: builder answered', r.status);
      return;
    }
    await websiteLinks.recordMismatchCandidates(c.wid, linked.link, r.data.candidates);
  } catch (e) {
    console.warn('[website-links] candidate capture failed:', e && e.message);
  }
}

async function canonical(c) {
  const r = await bridge.getWebsite(c.access);
  if (r.status === 200 && r.data && r.data.ok && r.data.projectId) return { ok: true, summary: r.data };
  return { ok: false, r };
}

// Phase 9: resolves a SPECIFIC project's live summary (not "canonical" --
// the generator's resolveCanonicalProjectId is still singular, "most
// recently purchased"), for the new project-scoped routes below. Two
// checks, not one, before anything is returned: the app's OWN link table
// confirms this workspace has actually connected that project (never trust
// the id alone -- a URL param is not authorization), and the generator's
// getWebsiteById re-confirms real OWNERSHIP from the signed-in person's
// own token on every call, exactly like every other bridge route in this
// file. A project id that's real but not linked to THIS workspace gets the
// same not_found shape as one that doesn't exist at all.
async function forWorkspaceProject(c, projectId) {
  if (!websiteLinks.PROJECT_ID_RE.test(String(projectId || ''))) return { ok: false, status: 404, code: 'not_found', message: 'Website not found.' };
  let link;
  try { link = await websiteLinks.getLinkForWorkspaceAndProject(c.wid, projectId); }
  catch (e) { console.warn('[website-links] project lookup failed:', e && e.message); return { ok: false, status: 503, code: 'unavailable', message: 'Couldn’t look up that website right now.' }; }
  if (!link) return { ok: false, status: 404, code: 'not_found', message: 'That website isn’t connected to this workspace.' };
  const r = await bridge.getWebsiteById(c.access, projectId);
  if (r.status === 200 && r.data && r.data.ok && r.data.projectId) return { ok: true, summary: r.data, link };
  return { ok: false, r };
}

// ?source=draft: preview the latest saved draft (after an update, before publishing) instead of the published website
// THE POLICY A WEBSITE PREVIEW RUNS UNDER (all three preview routes). The builder sends one self-contained page: its
// scripts inline, and every file it needs inlined as a data: URL -- including, on a Creative page with 3D, the 3D engine
// (which the page's loader adds as <script src="data:...">) and the GLB (which the engine fetch()es from its data: URL,
// then decodes the textures inside it through blob: URLs). So scripts may come from the page and from data: URLs, and
// fetch() may read data: and blob: URLs -- never the network: connect-src names no host, not even this one.
const PREVIEW_CSP = "default-src 'self' data: blob: https:; img-src 'self' data: blob: https:; style-src 'unsafe-inline' https:; script-src 'unsafe-inline' data:; connect-src data: blob:; form-action 'none'; frame-ancestors 'self'";
function previewWantsDraft(u) { return !!(u && u.searchParams && u.searchParams.get('source') === 'draft'); }
// BILLING PASS: the browser sends one id per update attempt; a retry of the same attempt reuses it
function requestIdFrom(body) { const v = typeof body.requestId === 'string' ? body.requestId.trim() : ''; return /^[A-Za-z0-9_.:-]{8,120}$/.test(v) ? v : null; }
function editResult(projectId, d) {
  return {
    ok: true, projectId, revision: d.revision,
    // "Update My Website" update intelligence: a specific change, or a redesign of the site (the builder decides)
    mode: d.mode === 'deep' ? 'deep' : 'surgical',
    changeSummary: Array.isArray(d.changeSummary) ? d.changeSummary.filter(s => typeof s === 'string').slice(0, 20) : [],
    creditsCharged: Number.isFinite(d.creditsCharged) ? d.creditsCharged : null,
    creditsRemaining: Number.isFinite(d.creditsRemaining) ? d.creditsRemaining : null,
    replayed: !!d.replayed,
  };
}
// an explicit allowlist of the builder's credit summary
// what customers see of the price list (one-time website prices, credit packs, the first-website bonus)
function catalogFrom(c) {
  if (!c || typeof c !== 'object') return null;
  const n = v => (Number.isFinite(v) ? v : null); const s = (v, k) => (typeof v === 'string' ? v.slice(0, k || 60) : '');
  const w = c.websites || {}; const site = x => (x ? { cents: n(x.cents), currency: s(x.currency, 3), display: s(x.display, 30), label: s(x.label, 40) } : null);
  return { websites: { business: site(w.business), creative: site(w.creative) }, packs: (Array.isArray(c.packs) ? c.packs : []).slice(0, 8).map(p => ({ id: s(p.id, 40), credits: n(p.credits), cents: n(p.cents), display: s(p.display, 30) })), firstWebsiteBonus: n(c.firstWebsiteBonus) };
}
function quoteFrom(q) {
  const n = v => (Number.isFinite(v) ? v : null); const s = (v, k) => (typeof v === 'string' ? v.slice(0, k || 200) : '');
  return { id: s(q.id, 60), message: s(q.message, 200), credits: n(q.credits), minCredits: n(q.minCredits), expiresAt: s(q.expiresAt, 40), items: (Array.isArray(q.items) ? q.items : []).slice(0, 6).map(i => ({ label: s(i.label, 80), credits: n(i.credits), optional: !!i.optional })) };
}
function creditsFrom(x) {
  const n = v => (Number.isFinite(v) ? v : null); const s = v => (typeof v === 'string' ? v.slice(0, 80) : null);
  const costs = x.costs || {};
  return {
    plan: s(x.plan), planLabel: s(x.planLabel), remaining: n(x.remaining),
    trial: x.trial ? { credits: n(x.trial.credits), remaining: n(x.trial.remaining) } : null,
    purchased: n(x.purchased), bonus: n(x.bonus),
    // LEGACY: a Workspace month bought before subscriptions were retired (no new ones are sold)
    subscription: x.subscription ? { status: s(x.subscription.status), credits: n(x.subscription.credits), remaining: n(x.subscription.remaining), renewsAt: s(x.subscription.renewsAt), endsAt: s(x.subscription.endsAt), paymentProblem: !!x.subscription.paymentProblem } : null,
    tester: x.tester ? { credits: n(x.tester.credits), remaining: n(x.tester.remaining), resetsAt: s(x.tester.resetsAt) } : null,
    costs: { businessGeneration: n(costs.businessGeneration), creativePage: n(costs.creativePage), creativeSpatialSurcharge: n(costs.creativeSpatialSurcharge), aiUpdate: n(costs.aiUpdate), imageSupport: n(costs.imageSupport), imagePremium: n(costs.imagePremium), manualEdit: n(costs.manualEdit) },
  };
}

// ---- THE CREATIVE WEBSITE EDITOR: what the app passes on (explicit allowlists, like summaryFrom) ----------------------
// an owner picture as a PNG data URL: up to 8 MB of picture (the builder refuses anything bigger), base64 and JSON around it
const CREATIVE_UPLOAD_MAX_CHARS = 12 * 1024 * 1024;
const CREATIVE_OP_KEYS = ['type', 'sceneId', 'field', 'index', 'value', 'layerId', 'assetId', 'composition', 'role', 'modelSceneId', 'modelId', 'sectionId', 'distance', 'azimuth', 'mediaId'];
function creativeOpFrom(op) {
  const out = {}; CREATIVE_OP_KEYS.forEach(k => { const v = op[k]; if (typeof v === 'string') out[k] = v.slice(0, k === 'value' ? 600 : 60); else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v; });
  return out;
}
function creativeChangeFrom(projectId, d) {
  return { ok: true, projectId, revision: Number.isInteger(d.revision) ? d.revision : null, changeSummary: Array.isArray(d.changeSummary) ? d.changeSummary.filter(x => typeof x === 'string').slice(0, 10) : [],
    creditsCharged: Number.isFinite(d.creditsCharged) ? d.creditsCharged : 0, creditsRemaining: Number.isFinite(d.creditsRemaining) ? d.creditsRemaining : null, replayed: !!d.replayed };
}
function creativeJobFrom(j) {
  const s = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  return { jobId: s(j.jobId, 60), kind: j.kind === 'model3d' ? 'model3d' : 'motion', status: s(j.status, 20), terminal: !!j.terminal, completed: Number(j.completed) || 0, message: s(j.message, 200), createdAt: s(j.createdAt, 40), completedAt: s(j.completedAt, 40) || null };
}
function creativeQuoteFrom(d) {
  const n = v => (Number.isFinite(v) ? v : null); const s = (v, k) => (typeof v === 'string' ? v.slice(0, k || 200) : '');
  if (d.ok === false) return { ok: false, code: s(d.reason, 40) || 'unavailable', message: s(d.message, 300), job: d.job ? creativeJobFrom(d.job) : undefined };
  if (d.reuse) return { ok: true, reuse: true, credits: 0, message: s(d.message, 300), modelId: s(d.modelId, 60) || undefined, mediaId: s(d.mediaId, 60) || undefined };
  return { ok: true, quote: d.quote ? quoteFrom(d.quote) : null, creditsRemaining: n(d.creditsRemaining), enough: d.enough !== false, needsRender: !!d.needsRender };
}
function creativeStartFrom(projectId, d) {
  const s = (v, k) => (typeof v === 'string' ? v.slice(0, k || 300) : '');
  if (d.ok === false) return { ok: false, code: s(d.reason, 40) || 'failed', message: s(d.message), creditsRemaining: Number.isFinite(d.creditsRemaining) ? d.creditsRemaining : null };
  if (d.job) return { ok: true, projectId, job: creativeJobFrom(d.job), reused: !!d.reused, creditsRemaining: Number.isFinite(d.creditsRemaining) ? d.creditsRemaining : null };
  return creativeChangeFrom(projectId, d);
}
function creativeOutlineFrom(d) {
  const s = (v, k) => (typeof v === 'string' ? v.slice(0, k || 200) : ''); const n = v => (Number.isFinite(v) ? v : null);
  const acts = a => (Array.isArray(a) ? a.filter(x => typeof x === 'string').slice(0, 12).map(x => x.slice(0, 30)) : []);
  const src = x => (x && typeof x === 'object' ? { kind: s(x.kind, 20), rootId: s(x.rootId, 60), title: s(x.title, 120), cutout: !!x.cutout, author: s(x.author, 120), license: s(x.license, 60), pageUrl: /^https:\/\//.test(x.pageUrl || '') ? s(x.pageUrl, 400) : '' } : null);
  const o = d.outline || {};
  return {
    ok: true, kind: 'creative', projectId: s(d.projectId, 60), revision: Number.isInteger(d.revision) ? d.revision : null, creditsRemaining: n(d.creditsRemaining),
    jobs: (d.jobs || []).slice(0, 10).map(creativeJobFrom),
    outline: {
      name: s(o.name, 120), look: o.look ? { family: s(o.look.family, 30), devices: acts(o.look.devices) } : null,
      palette: (o.palette || []).slice(0, 6).map(p => ({ role: s(p.role, 20), label: s(p.label, 40), hex: /^#[0-9a-f]{6}$/i.test(p.hex || '') ? p.hex : '' })),
      scenes: (o.scenes || []).slice(0, 12).map(sc => ({
        id: s(sc.id, 60), index: n(sc.index), name: s(sc.name, 80), composition: s(sc.composition, 40), background: /^#[0-9a-f]{6}$/i.test(sc.background || '') ? sc.background : '',
        text: { kicker: s(sc.text && sc.text.kicker, 70), heading: s(sc.text && sc.text.heading, 110), body: s(sc.text && sc.text.body, 520), items: (sc.text && Array.isArray(sc.text.items) ? sc.text.items : []).slice(0, 6).map(t => s(t, 260)) },
        pictures: (sc.pictures || []).slice(0, 6).map(p => ({ layerId: s(p.layerId, 60), assetId: s(p.assetId, 60), role: s(p.role, 20), callback: !!p.callback, source: src(p.source), clip: p.clip ? { mediaId: s(p.clip.mediaId, 60) } : null, model: p.model ? { id: s(p.model.id, 60) } : null, actions: acts(p.actions) })),
        models: (sc.models || []).slice(0, 2).map(m => ({ id: s(m.id, 60), modelId: s(m.modelId, 60), composition: s(m.composition, 40), distance: n(m.distance), azimuth: n(m.azimuth), actions: acts(m.actions) })),
        compositions: (sc.compositions || []).slice(0, 16).map(k => ({ id: s(k.id, 40), label: s(k.label, 120) })), actions: acts(sc.actions),
      })),
      pictures: (o.pictures || []).slice(0, 40).map(p => ({ assetId: s(p.assetId, 60), source: src(p.source), onPage: !!p.onPage, width: n(p.width), height: n(p.height) })),
      models: (o.models || []).slice(0, 4).map(m => ({ id: s(m.id, 60), sourceAssetId: s(m.sourceAssetId, 60), placedIn: acts(m.placedIn) })),
      media: (o.media || []).slice(0, 12).map(m => ({ assetId: s(m.assetId, 60), mediaId: s(m.mediaId, 60) })),
      threeDCompositions: acts(o.threeDCompositions), actions: acts(o.actions),
    },
  };
}

module.exports = function registerWebsiteBridgeRoutes(router) {
  router.get('/api/app/website', { auth: 'user' }, async (req, res, { c, json }) => {
    const gate = await workspaceGate(c);
    if (!gate.ok) return json(res, gate.status, { ok: false, code: gate.code, message: gate.message });
    const got = await canonical(c);
    if (!got.ok) return passThroughError(json, res, got.r);
    let linked = await recordLink(c, got.summary);
    // RELOAD FIX: the person's newest purchase, just re-verified by the builder from their own token, is connected to
    // their only business here -- so it shows after a reload instead of the old delivery record. Drafts never are.
    if (linked.status === 'not_linked' && got.summary.status === 'purchased' && await soleWorkspace(c)) {
      const made = await autoLink(c, [{ projectId: got.summary.projectId, isPurchased: true, status: 'purchased', purchaseRef: got.summary.purchaseRef, revision: got.summary.revision }]);
      if (made.created.length || made.existing.length) linked = await recordLink(c, got.summary);
    }
    if (linked.status === 'linked' && hasSiteRemadeAccess(c)) provisionAnalyticsInBackground(c, got.summary, linked.link);
    await captureMismatchCandidates(c, linked);
    // Only the link STATUS reaches the browser (linked / not_linked /
    // mismatch / conflict / unknown) -- no ids beyond the projectId the
    // summary already carries.
    return json(res, 200, { ...summaryFrom(got.summary), link: { status: linked.status } });
  });

  // Phase 8: "which of my SiteRemade websites is this?" -- the customer-
  // facing list GET /api/app/website itself no longer auto-links from (see
  // lib/website-links.js recordBridgeSummary). Always a FRESH call to the
  // builder with this same request's own token: server-side ownership and
  // purchase verification on every load, never anything the browser cached
  // from an earlier visit. Same workspace gate as the rest of this file --
  // staff and multi-workspace accounts get workspace_mismatch here too,
  // exactly like every other route below, because "whose purchases are
  // these" is exactly as ambiguous for them as "whose website is this".
  router.get('/api/app/website/candidates', { auth: 'user' }, async (req, res, { c, json }) => {
    const gate = await workspaceGate(c);
    if (!gate.ok) return json(res, gate.status, { ok: false, code: gate.code, message: gate.message });
    const r = await bridge.getCandidates(c.access);
    if (r.status !== 200 || !r.data || !r.data.ok || !Array.isArray(r.data.candidates)) return passThroughError(json, res, r);
    // Phase 9: a workspace can have SEVERAL linked projects now -- checking
    // against just one (getLinkForWorkspace's "most recent") silently
    // reported every other already-connected project as unlinked, which
    // would make the "Connect a website" picker offer to reconnect
    // something the customer already connected. Use the full set instead.
    let linkedProjectIds = new Set();
    try { const links = await websiteLinks.listLinksForWorkspace(c.wid); linkedProjectIds = new Set(links.map(l => l.generator_project_id)); } catch (e) { console.warn('[website-links] candidates: could not read existing links:', e && e.message); }
    const candidates = r.data.candidates.map(x => ({
      projectId: x.projectId, name: x.name || null, businessName: x.businessName || null, status: x.status || 'purchased',
      revision: Number.isInteger(x.revision) ? x.revision : null, purchasedAt: x.purchasedAt || null,
      domains: Array.isArray(x.domains) ? x.domains.map(d => ({ domain: d.domain, state: d.state, verifiedAt: d.verifiedAt || null })) : [],
      deploymentStatus: x.deploymentStatus || 'not_deployed', hasUnpublishedChanges: !!x.hasUnpublishedChanges,
      alreadyLinked: linkedProjectIds.has(x.projectId),
    }));
    return json(res, 200, { ok: true, candidates, alreadyConnected: linkedProjectIds.size > 0 });
  });

  // SAVED WEBSITES: every website saved to this person's SiteRemade account -- drafts included, not only purchases
  // (the candidates route above lists purchases only, for connecting). A fresh builder call with this request's own
  // token on every load: the list is the signed-in person's own projects.
  // RELOAD FIX: listed for any member of this workspace (memberGate) -- it is the person's own account, so a person in
  // several businesses sees their websites too (and connects one here explicitly). For a person whose ONLY business
  // this is, every website the builder reports as purchased is connected here automatically first (additive and
  // idempotent -- see lib/website-links.js autoLinkVerifiedPurchases), so a new purchase can be opened right away.
  router.get('/api/app/websites', { auth: 'user' }, async (req, res, { c, json }) => {
    const gate = await memberGate(c);
    if (!gate.ok) return json(res, gate.status, { ok: false, code: gate.code, message: gate.message });
    const r = await bridge.getWebsites(c.access);
    if (r.status !== 200 || !r.data || !r.data.ok || !Array.isArray(r.data.websites)) return passThroughError(json, res, r);
    const sole = await soleWorkspace(c);
    const made = sole ? await autoLink(c, r.data.websites) : { created: [] };
    let linkedIds = new Set();
    try { linkedIds = new Set((await websiteLinks.listLinksForWorkspace(c.wid)).map(l => l.generator_project_id)); } catch (e) { console.warn('[website-links] saved websites: could not read links:', e && e.message); }
    const websites = savedWebsitesFrom(r.data.websites, linkedIds); // lib/saved-websites.js: metadata allowlist, newest first
    // (canDeleteWebsites: the one website-admin account -- lib/website-admin.js -- sees Delete; the server checks it again)
    return json(res, 200, { ok: true, websites, autoLinked: made.created.length, workspaceAmbiguous: !sole, canDeleteWebsites: websiteAdmin.isWebsiteAdmin(c) });
  });

  // ---- WEBSITE DELETION: the website admin ONLY (lib/website-admin.js -- one named account, by its verified, confirmed
  // email; no role grants it: not a business owner or admin, not a member, not SiteRemade staff). Checked here first,
  // before anything is asked of the builder, and by the builder again on its own. A deletion removes the website from
  // SiteRemade -- from every account and every business (its links here go too) -- while its purchase, payments, credit
  // ledger and stored files are kept (a soft delete in the builder: migrations/0013_project_removal.sql). Files a
  // customer already downloaded are theirs and untouched. Asking again for a deleted website is safe: alreadyRemoved.
  const notAdmin = (json, res) => json(res, 403, { ok: false, code: 'FORBIDDEN', message: 'Only the SiteRemade admin account can delete websites.' });
  router.get('/api/app/admin/websites', { auth: 'user' }, async (req, res, { c, json }) => {
    if (!websiteAdmin.isWebsiteAdmin(c)) return notAdmin(json, res);
    const r = await bridge.adminWebsites(c.access);
    if (r.status !== 200 || !r.data || !r.data.ok || !Array.isArray(r.data.websites)) return r.status === 403 ? notAdmin(json, res) : passThroughError(json, res, r);
    const websites = r.data.websites.filter(w => w && websiteLinks.PROJECT_ID_RE.test(String(w.projectId || ''))).map(w => ({ projectId: w.projectId, name: String(w.name || '').slice(0, 200), mode: w.mode === 'creative' ? 'creative' : 'business', status: String(w.status || ''), isPurchased: w.isPurchased === true, ownerEmail: String(w.ownerEmail || '').slice(0, 254), updatedAt: w.updatedAt || null }));
    return json(res, 200, { ok: true, websites });
  });
  router.delete('/api/app/admin/websites/:projectId', { auth: 'user' }, async (req, res, { c, json, params }) => {
    if (!websiteAdmin.isWebsiteAdmin(c)) {
      console.warn('[website-admin] ' + JSON.stringify({ step: 'refused', userId: c && c.user && c.user.id, workspaceId: c && c.wid }));
      return notAdmin(json, res);
    }
    const projectId = String(params.projectId || '');
    if (!websiteLinks.PROJECT_ID_RE.test(projectId)) return json(res, 404, { ok: false, code: 'not_found', message: 'Website not found.' });
    const r = await bridge.adminRemoveWebsite(c.access, projectId);
    if (r.status === 403) return notAdmin(json, res);
    if (r.status === 404) return json(res, 404, { ok: false, code: 'not_found', message: 'Website not found.' });
    if (r.status !== 200 || !r.data || !r.data.ok) return passThroughError(json, res, r);
    // (the builder removed it -- or had already: the links here go either way, so a retried request finishes the job)
    let unlinked = []; try { unlinked = await websiteLinks.unlinkProjectEverywhere(projectId); } catch (e) { console.warn('[website-admin] links not removed:', e && e.message); }
    try { await db.from('audit_logs').insert({ user_id: c.user.id, workspace_id: c.wid || null, action: 'website.delete', detail: JSON.stringify({ projectId, alreadyRemoved: !!r.data.alreadyRemoved, status: r.data.status || '', unlinkedWorkspaces: unlinked.length }).slice(0, 1000) }); } catch (e) { /* the audit trail never blocks the answer */ }
    console.log('[website-admin] ' + JSON.stringify({ step: 'deleted', projectId, by: c.user.id, alreadyRemoved: !!r.data.alreadyRemoved, unlinkedWorkspaces: unlinked.length }));
    return json(res, 200, { ok: true, projectId, alreadyRemoved: !!r.data.alreadyRemoved, wasPurchased: r.data.status === 'purchased', unlinkedWorkspaces: unlinked.length });
  });

  // A saved website's preview (the latest saved version by default; ?source=published for a purchased website's
  // published/purchased version) and a purchased website's files. The id only says WHICH of this person's websites:
  // the builder authorizes every request from the signed-in person's own token -- a website that isn't theirs is a
  // 404, and a draft's files are refused (403 not_purchased: only a purchase hands over the files). Like the Saved
  // Websites list: memberGate, no link needed (the person's own website, never a guess about a workspace).
  router.get('/api/app/websites/:projectId/preview', { auth: 'user' }, async (req, res, { c, json, params, u }) => {
    const gate = await memberGate(c);
    if (!gate.ok) return json(res, gate.status, { ok: false, code: gate.code, message: gate.message });
    if (!websiteLinks.PROJECT_ID_RE.test(String(params.projectId || ''))) return json(res, 404, { ok: false, code: 'not_found', message: 'Website not found.' });
    const published = !!(u && u.searchParams && u.searchParams.get('source') === 'published');
    const r = await bridge.getPreview(c.access, params.projectId, { draft: !published });
    if (r.status !== 200 || typeof r.text !== 'string') return json(res, r.status === 404 ? 404 : (r.status || 502), { ok: false, code: r.status === 404 ? 'not_found' : 'preview_unavailable', message: 'The website preview could not be loaded.' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': PREVIEW_CSP });
    return res.end(r.text);
  });
  router.get('/api/app/websites/:projectId/download', { auth: 'user' }, async (req, res, { c, json, params }) => {
    const gate = await memberGate(c);
    if (!gate.ok) return json(res, gate.status, { ok: false, code: gate.code, message: gate.message });
    if (!websiteLinks.PROJECT_ID_RE.test(String(params.projectId || ''))) return json(res, 404, { ok: false, code: 'not_found', message: 'Website not found.' });
    return sendWebsiteDownload({ bridge, token: c.access, projectId: params.projectId, res, json });
  });

  // Phase 8: the explicit connect action. Only creates a NEW link (a
  // workspace that already has one gets `already_linked` -- switching an
  // established link stays the staff relink/review flow above, unchanged).
  // `projectId` is never trusted on its own: it's matched against a FRESH
  // GET /api/app-bridge/website/candidates made right here with this same
  // request's token, so what actually gets linked is always something the
  // builder just re-confirmed this signed-in person purchased.
  router.post('/api/app/website/connect', { auth: 'user' }, async (req, res, { c, json }) => {
    const gate = await memberGate(c);
    if (!gate.ok) return json(res, gate.status, { ok: false, code: gate.code, message: gate.message });
    let body;
    try { body = await readJsonBody(req, 2000); } catch (e) { return json(res, 400, { ok: false, code: 'invalid_request', message: 'That request couldn’t be read.' }); }
    const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
    if (!websiteLinks.PROJECT_ID_RE.test(projectId)) return json(res, 400, { ok: false, code: 'invalid_request', message: 'Choose one of your SiteRemade websites.' });
    const r = await bridge.getCandidates(c.access);
    if (r.status !== 200 || !r.data || !r.data.ok || !Array.isArray(r.data.candidates)) return passThroughError(json, res, r);
    const chosen = r.data.candidates.find(x => x.projectId === projectId);
    if (!chosen) return json(res, 422, { ok: false, code: 'not_a_candidate', message: 'That website isn’t one of your verified SiteRemade purchases. Refresh and try again.' });
    let out;
    try {
      out = await websiteLinks.connectWorkspaceToProject(c.wid, chosen);
    } catch (e) {
      console.warn('[website-links] connect failed:', e && e.message);
      return json(res, 503, { ok: false, code: 'unavailable', message: 'Couldn’t connect your website right now. Nothing was changed.' });
    }
    if (!out.ok) return json(res, out.status, { ok: false, code: out.code, message: out.message });
    return json(res, 200, { ok: true, projectId: chosen.projectId, created: out.created });
  });

  // ---------------------------------------------------------------------
  // Phase 9 (multi-project): additive, project-scoped siblings of the
  // singular routes above. Those keep resolving "the canonical project"
  // exactly as before (unchanged, still used by anything built against
  // them); these let the Workplace address ANY of a workspace's linked
  // projects explicitly, which the singular routes structurally can't do
  // (the generator's own canonical resolution is still "most recently
  // purchased" -- see lib/generator-bridge.js's getWebsiteById comment).
  // ---------------------------------------------------------------------

  // Every project this workspace has connected, each with its own live
  // summary -- the data source for a project switcher/list. A project
  // whose live bridge call fails (rare: e.g. a transient builder outage)
  // is still listed, flagged unavailable, rather than silently dropped --
  // losing a row here would look like "this project disappeared."
  router.get('/api/app/website/projects', { auth: 'user' }, async (req, res, { c, json }) => {
    const gate = await memberGate(c);
    if (!gate.ok) return json(res, gate.status, { ok: false, code: gate.code, message: gate.message });
    let links;
    try { links = await websiteLinks.listLinksForWorkspace(c.wid); }
    catch (e) { console.warn('[website-links] projects list failed:', e && e.message); return json(res, 503, { ok: false, code: 'unavailable', message: 'Couldn’t load your websites right now.' }); }
    const projects = await Promise.all(links.map(async (link) => {
      const r = await bridge.getWebsiteById(c.access, link.generator_project_id);
      if (r.status === 200 && r.data && r.data.ok && r.data.projectId) return { ...summaryFrom(r.data), linkedAt: link.linked_at };
      return { ok: true, source: 'generator', hasCanonicalProject: false, projectId: link.generator_project_id, linkedAt: link.linked_at, unavailable: true };
    }));
    return json(res, 200, { ok: true, projects });
  });

  router.get('/api/app/website/projects/:projectId', { auth: 'user' }, async (req, res, { c, json, params }) => {
    const gate = await memberGate(c);
    if (!gate.ok) return json(res, gate.status, { ok: false, code: gate.code, message: gate.message });
    const got = await forWorkspaceProject(c, params.projectId);
    if (!got.ok) return got.r ? passThroughError(json, res, got.r) : json(res, got.status, { ok: false, code: got.code, message: got.message });
    return json(res, 200, summaryFrom(got.summary));
  });

  router.get('/api/app/website/projects/:projectId/download', { auth: 'user' }, async (req, res, { c, json, params }) => {
    const gate = await memberGate(c);
    if (!gate.ok) return json(res, gate.status, { ok: false, code: gate.code, message: gate.message });
    const got = await forWorkspaceProject(c, params.projectId);
    if (!got.ok) return got.r ? passThroughError(json, res, got.r) : json(res, got.status, { ok: false, code: got.code, message: got.message });
    return sendWebsiteDownload({ bridge, token: c.access, projectId: got.summary.projectId, res, json });
  });

  router.get('/api/app/website/projects/:projectId/preview', { auth: 'user' }, async (req, res, { c, json, params, u }) => {
    const gate = await memberGate(c);
    if (!gate.ok) return json(res, gate.status, { ok: false, code: gate.code, message: gate.message });
    const got = await forWorkspaceProject(c, params.projectId);
    if (!got.ok) return got.r ? passThroughError(json, res, got.r) : json(res, got.status, { ok: false, code: got.code, message: got.message });
    const r = await bridge.getPreview(c.access, got.summary.projectId, { draft: previewWantsDraft(u) });
    if (r.status !== 200 || typeof r.text !== 'string') return json(res, r.status || 502, { ok: false, code: 'preview_unavailable', message: 'The website preview could not be loaded.' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': PREVIEW_CSP });
    return res.end(r.text);
  });

  router.get('/api/app/website/projects/:projectId/deployment', { auth: 'user' }, async (req, res, { c, json, params }) => {
    const gate = await memberGate(c);
    if (!gate.ok) return json(res, gate.status, { ok: false, code: gate.code, message: gate.message });
    const got = await forWorkspaceProject(c, params.projectId);
    if (!got.ok) return got.r ? passThroughError(json, res, got.r) : json(res, got.status, { ok: false, code: got.code, message: got.message });
    const r = await bridge.getDeployment(c.access, got.summary.projectId);
    if (r.status !== 200 || !r.data || !r.data.ok) return passThroughError(json, res, r);
    return json(res, 200, {
      ok: true, projectId: r.data.projectId, deploymentStatus: r.data.deploymentStatus, automaticHosting: false,
      deployments: (r.data.deployments || []).map(d => ({ state: d.state, target: d.target, projectRevision: d.projectRevision, deployedUrl: d.deployedUrl || null, failureReason: d.failureReason || null, createdAt: d.createdAt })),
      domains: (r.data.domains || []).map(x => ({ domain: x.domain, state: x.state, verifiedAt: x.verifiedAt || null })),
    });
  });

  // Phase 9: this project's own analytics -- the project-scoped sibling of
  // GET/POST /api/app/analytics/website (routes/umami-analytics.js), which
  // stays pinned to the legacy, workspace-level row (project_id IS NULL) so
  // it is completely unaffected by any of this. forWorkspaceProject gives
  // the same two-layer ownership check as every other project route above
  // before either handler touches website_analytics.
  router.get('/api/app/website/projects/:projectId/analytics', { auth: 'user' }, async (req, res, { c, u: url, json, params }) => {
    if (!requireSiteRemadeAccess(c, json, res)) return;
    const gate = await memberGate(c);
    if (!gate.ok) return json(res, gate.status, { ok: false, code: gate.code, message: gate.message });
    const got = await forWorkspaceProject(c, params.projectId);
    if (!got.ok) return got.r ? passThroughError(json, res, got.r) : json(res, got.status, { ok: false, code: got.code, message: got.message });
    try {
      return json(res, 200, { ok: true, projectId: got.summary.projectId, ...await analytics(c, url, got.summary.projectId) });
    } catch (e) {
      return json(res, 502, { ok: false, message: e.message || 'Analytics unavailable' });
    }
  });

  router.post('/api/app/website/projects/:projectId/analytics', { auth: 'user' }, async (req, res, { c, json, params }) => {
    if (!requireSiteRemadeAccess(c, json, res)) return;
    const gate = await memberGate(c);
    if (!gate.ok) return json(res, gate.status, { ok: false, code: gate.code, message: gate.message });
    const got = await forWorkspaceProject(c, params.projectId);
    if (!got.ok) return got.r ? passThroughError(json, res, got.r) : json(res, got.status, { ok: false, code: got.code, message: got.message });
    let body;
    try { body = await readJsonBody(req, 2000); } catch (e) { return json(res, 400, { ok: false, code: 'invalid_request', message: 'That request couldn’t be read.' }); }
    const domain = domainOf(body.domain);
    if (!domain || !umamiDomainOk(domain)) return json(res, 400, { ok: false, code: 'invalid_request', message: 'Enter a valid website domain.' });
    if (!umamiConfigured()) return json(res, 503, { ok: false, code: 'analytics_not_configured', message: 'Visitor analytics isn’t available on SiteRemade yet, so your address wasn’t saved. Nothing on your website has changed.' });
    try {
      const id = await ensureWorkspaceSite(c.wid, c.workspace && c.workspace.business_name, domain, body.businessName, got.summary.projectId);
      return json(res, 200, { ok: true, projectId: got.summary.projectId, connected: true, domain, websiteAnalytics: { domain, provider: 'umami', connected: true, websiteId: id } });
    } catch (e) {
      return json(res, 502, { ok: false, message: e.message || 'Analytics unavailable' });
    }
  });

  router.post('/api/app/website/projects/:projectId/edits', { auth: 'user' }, async (req, res, { c, json, params }) => {
    if (!requireSiteRemadeAccess(c, json, res)) return;
    const gate = await memberGate(c);
    if (!gate.ok) return json(res, gate.status, { ok: false, code: gate.code, message: gate.message });
    let body;
    try { body = await readJsonBody(req, 20000); } catch (e) { return json(res, 400, { ok: false, code: 'invalid_request', message: 'That request couldn’t be read.' }); }
    const request = typeof body.request === 'string' ? body.request.trim() : '';
    if (!request) return json(res, 400, { ok: false, code: 'invalid_request', message: 'Describe the change you want to make.' });
    if (request.length > MAX_REQUEST_CHARS) return json(res, 400, { ok: false, code: 'request_too_long', message: `Please keep automatic updates under ${MAX_REQUEST_CHARS} characters — or send longer requests to the SiteRemade team.` });
    if (!Number.isInteger(body.baseRevision)) return json(res, 400, { ok: false, code: 'invalid_request', message: 'Refresh your website before applying this update.' });
    const got = await forWorkspaceProject(c, params.projectId);
    if (!got.ok) return got.r ? passThroughError(json, res, got.r) : json(res, got.status, { ok: false, code: got.code, message: got.message });
    const r = await bridge.postEdit(c.access, got.summary.projectId, { baseRevision: body.baseRevision, request, requestId: requestIdFrom(body), quoteId: typeof body.quoteId === 'string' ? body.quoteId : '' });
    if (r.status === 200 && r.data && r.data.ok) return json(res, 200, editResult(got.summary.projectId, r.data));
    return passThroughError(json, res, r);
  });

  // ---------------------------------------------------------------------
  // THE CREATIVE WEBSITE EDITOR: a Creative website is edited as the Creative project it is -- through the builder, which
  // stays authoritative for the page, its validation, revisions, prices, provider jobs and publishing. The app is only the
  // control surface: these routes check the person and the workspace's link to the website (memberGate +
  // forWorkspaceProject, exactly as every project route above), forward the request with the person's own token, and
  // pass back an allowlisted answer. Every change is a DRAFT; publishing is POST .../publish above.
  //   GET  .../creative           the editable outline and the page's 3D / clip jobs
  //   POST .../creative/edit      a free change (text, picture, composition, colour, layout rules, 3D placement, clip)
  //   POST .../creative/upload    an owner picture -- a PNG the browser made; the builder measures it
  //   POST .../creative/quote     the builder's price for a paid action (never a price of this app's own)
  //   POST .../creative/start     the confirmed quote: the builder reserves and runs it, exactly once
  //   GET  .../creative/jobs      the page's 3D and clip jobs (finished ones are attached by the builder)
  //   GET  .../creative/still     the page that draws the 3D model's still for "cinematic video from 3D"
  // ---------------------------------------------------------------------
  const creativeGate = async (c, json, res, params, write) => {
    if (write && !requireSiteRemadeAccess(c, json, res)) return null;
    const gate = await memberGate(c);
    if (!gate.ok) { json(res, gate.status, { ok: false, code: gate.code, message: gate.message }); return null; }
    const got = await forWorkspaceProject(c, params.projectId);
    if (!got.ok) { if (got.r) passThroughError(json, res, got.r); else json(res, got.status, { ok: false, code: got.code, message: got.message }); return null; }
    return got;
  };
  const creativeBody = async (req, json, res, limit) => {
    try { return await readJsonBody(req, limit || 20000); } catch (e) { json(res, 400, { ok: false, code: 'invalid_request', message: 'That request couldn’t be read.' }); return null; }
  };
  router.get('/api/app/website/projects/:projectId/creative', { auth: 'user' }, async (req, res, { c, json, params }) => {
    const got = await creativeGate(c, json, res, params, false); if (!got) return;
    const r = await bridge.getCreative(c.access, got.summary.projectId);
    if (r.status === 200 && r.data && r.data.ok) return json(res, 200, creativeOutlineFrom(r.data));
    return passThroughError(json, res, r);
  });
  router.post('/api/app/website/projects/:projectId/creative/edit', { auth: 'user' }, async (req, res, { c, json, params }) => {
    const got = await creativeGate(c, json, res, params, true); if (!got) return;
    const body = await creativeBody(req, json, res); if (!body) return;
    if (!Number.isInteger(body.baseRevision) || !body.op || typeof body.op !== 'object') return json(res, 400, { ok: false, code: 'invalid_request', message: 'Refresh your website before changing it.' });
    const r = await bridge.postCreativeEdit(c.access, got.summary.projectId, { baseRevision: body.baseRevision, op: creativeOpFrom(body.op) });
    if (r.status === 200 && r.data && r.data.ok) return json(res, 200, creativeChangeFrom(got.summary.projectId, r.data));
    return passThroughError(json, res, r);
  });
  router.post('/api/app/website/projects/:projectId/creative/upload', { auth: 'user' }, async (req, res, { c, json, params }) => {
    const got = await creativeGate(c, json, res, params, true); if (!got) return;
    const body = await creativeBody(req, json, res, CREATIVE_UPLOAD_MAX_CHARS); if (!body) return;
    if (!Number.isInteger(body.baseRevision)) return json(res, 400, { ok: false, code: 'invalid_request', message: 'Refresh your website before changing it.' });
    if (typeof body.png !== 'string' || !body.png.startsWith('data:image/png;base64,')) return json(res, 400, { ok: false, code: 'invalid_file', message: 'Choose a picture to upload.' });
    const s = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
    const r = await bridge.postCreativeUpload(c.access, got.summary.projectId, { baseRevision: body.baseRevision, png: body.png, title: s(body.title, 120), alt: s(body.alt, 200), sceneId: s(body.sceneId, 60), layerId: s(body.layerId, 60) });
    if (r.status === 200 && r.data && r.data.ok) return json(res, 200, Object.assign(creativeChangeFrom(got.summary.projectId, r.data), { assetId: s(r.data.assetId, 60) || null }));
    return passThroughError(json, res, r);
  });
  router.post('/api/app/website/projects/:projectId/creative/quote', { auth: 'user' }, async (req, res, { c, json, params }) => {
    const got = await creativeGate(c, json, res, params, true); if (!got) return;
    const body = await creativeBody(req, json, res); if (!body) return;
    const s = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
    const r = await bridge.postCreativeQuote(c.access, got.summary.projectId, { action: s(body.action, 30), sceneId: s(body.sceneId, 60), sceneIds: Array.isArray(body.sceneIds) ? body.sceneIds.slice(0, 4).map(x => s(x, 60)) : undefined, layerId: s(body.layerId, 60), assetId: s(body.assetId, 60), field: s(body.field, 20), request: s(body.request, MAX_REQUEST_CHARS), fresh: body.fresh === true });
    if (r.status === 200 && r.data) return json(res, 200, creativeQuoteFrom(r.data));
    return passThroughError(json, res, r);
  });
  router.post('/api/app/website/projects/:projectId/creative/start', { auth: 'user' }, async (req, res, { c, json, params }) => {
    const got = await creativeGate(c, json, res, params, true); if (!got) return;
    const body = await creativeBody(req, json, res, CREATIVE_UPLOAD_MAX_CHARS); if (!body) return;
    if (typeof body.quoteId !== 'string' || !body.quoteId) return json(res, 400, { ok: false, code: 'invalid_request', message: 'Ask for the cost first.' });
    const r = await bridge.postCreativeStart(c.access, got.summary.projectId, Object.assign({ quoteId: body.quoteId.slice(0, 60) }, Number.isInteger(body.baseRevision) ? { baseRevision: body.baseRevision } : {}, typeof body.render === 'string' && body.render.startsWith('data:image/png;base64,') ? { render: body.render } : {}));
    if (r.status === 200 && r.data) return json(res, 200, creativeStartFrom(got.summary.projectId, r.data));
    return passThroughError(json, res, r);
  });
  router.get('/api/app/website/projects/:projectId/creative/jobs', { auth: 'user' }, async (req, res, { c, json, params }) => {
    const got = await creativeGate(c, json, res, params, false); if (!got) return;
    const r = await bridge.getCreativeJobs(c.access, got.summary.projectId);
    if (r.status === 200 && r.data && r.data.ok) return json(res, 200, { ok: true, revision: Number.isInteger(r.data.revision) ? r.data.revision : null, jobs: (r.data.jobs || []).slice(0, 10).map(creativeJobFrom), creditsRemaining: Number.isFinite(r.data.creditsRemaining) ? r.data.creditsRemaining : null });
    return passThroughError(json, res, r);
  });
  router.get('/api/app/website/projects/:projectId/creative/still', { auth: 'user' }, async (req, res, { c, json, params }) => {
    const got = await creativeGate(c, json, res, params, true); if (!got) return;
    const r = await bridge.getCreativeStill(c.access, got.summary.projectId);
    if (r.status !== 200 || typeof r.text !== 'string') return json(res, r.status === 404 ? 404 : 502, { ok: false, code: 'still_unavailable', message: 'The 3D model’s still could not be prepared.' });
    // (the still page runs the inlined 3D engine on the inlined model and posts the PNG to the page that opened it: the
    // same policy as a preview -- its own scripts and data: URLs, no network at all)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': PREVIEW_CSP });
    return res.end(r.text);
  });

  router.post('/api/app/website/projects/:projectId/publish', { auth: 'user' }, async (req, res, { c, json, params }) => {
    if (!requireSiteRemadeAccess(c, json, res)) return;
    const gate = await memberGate(c);
    if (!gate.ok) return json(res, gate.status, { ok: false, code: gate.code, message: gate.message });
    let body;
    try { body = await readJsonBody(req, 20000); } catch (e) { return json(res, 400, { ok: false, code: 'invalid_request', message: 'That request couldn’t be read.' }); }
    if (!Number.isInteger(body.revision)) return json(res, 400, { ok: false, code: 'invalid_request', message: 'Refresh your website before publishing.' });
    const got = await forWorkspaceProject(c, params.projectId);
    if (!got.ok) return got.r ? passThroughError(json, res, got.r) : json(res, got.status, { ok: false, code: got.code, message: got.message });
    const r = await bridge.publish(c.access, got.summary.projectId, { revision: body.revision });
    if (r.status === 200 && r.data && r.data.ok) {
      return json(res, 200, { ok: true, published: true, alreadyPublished: !!r.data.alreadyPublished, revision: r.data.revision, publishedAt: r.data.publishedAt, automaticHosting: false });
    }
    return passThroughError(json, res, r);
  });

  router.get('/api/app/website/download', { auth: 'user' }, async (req, res, { c, json }) => {
    const gate = await workspaceGate(c);
    if (!gate.ok) return json(res, gate.status, { ok: false, code: gate.code, message: gate.message });
    const got = await canonical(c);
    if (!got.ok) return passThroughError(json, res, got.r);
    return sendWebsiteDownload({ bridge, token: c.access, projectId: got.summary.projectId, res, json });
  });

  router.get('/api/app/website/preview', { auth: 'user' }, async (req, res, { c, json, u }) => {
    const gate = await workspaceGate(c);
    if (!gate.ok) return json(res, gate.status, { ok: false, code: gate.code, message: gate.message });
    const got = await canonical(c);
    if (!got.ok) return passThroughError(json, res, got.r);
    const r = await bridge.getPreview(c.access, got.summary.projectId, { draft: previewWantsDraft(u) });
    if (r.status !== 200 || typeof r.text !== 'string') return json(res, r.status || 502, { ok: false, code: 'preview_unavailable', message: 'The website preview could not be loaded.' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': PREVIEW_CSP });
    return res.end(r.text);
  });

  router.get('/api/app/website/deployment', { auth: 'user' }, async (req, res, { c, json }) => {
    if (!requireSiteRemadeAccess(c, json, res)) return;
    const gate = await workspaceGate(c);
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
    if (!requireSiteRemadeAccess(c, json, res)) return;
    const gate = await workspaceGate(c);
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
    const r = await bridge.postEdit(c.access, got.summary.projectId, { baseRevision: body.baseRevision, request, requestId: requestIdFrom(body), quoteId: typeof body.quoteId === 'string' ? body.quoteId : '' });
    if (r.status === 200 && r.data && r.data.ok) return json(res, 200, editResult(got.summary.projectId, r.data));
    return passThroughError(json, res, r);
  });

  // OWNERSHIP + CREDITS: what an update will use, before it runs (the builder prices it from the request itself)
  router.post('/api/app/website/quote', { auth: 'user' }, async (req, res, { c, json }) => {
    let body;
    try { body = await readJsonBody(req, 20000); } catch (e) { return json(res, 400, { ok: false, code: 'invalid_request', message: 'That request couldn’t be read.' }); }
    const request = typeof body.request === 'string' ? body.request.trim() : '';
    if (!request) return json(res, 400, { ok: false, code: 'invalid_request', message: 'Describe the change you want to make.' });
    if (request.length > MAX_REQUEST_CHARS) return json(res, 400, { ok: false, code: 'request_too_long', message: `Please keep automatic updates under ${MAX_REQUEST_CHARS} characters.` });
    const gate = body.projectId ? await memberGate(c) : await workspaceGate(c);
    if (!gate.ok) return json(res, gate.status, { ok: false, code: gate.code, message: gate.message });
    const got = body.projectId ? await forWorkspaceProject(c, String(body.projectId)) : await canonical(c);
    if (!got.ok) return got.r ? passThroughError(json, res, got.r) : json(res, got.status, { ok: false, code: got.code, message: got.message });
    const r = await bridge.postQuote(c.access, { operation: 'website_update', request, projectId: got.summary.projectId });
    if (r.status === 200 && r.data && r.data.ok && r.data.quote) return json(res, 200, { ok: true, quote: quoteFrom(r.data.quote), creditsRemaining: Number.isFinite(r.data.creditsRemaining) ? r.data.creditsRemaining : null });
    return passThroughError(json, res, r);
  });
  // credit packs: one-time Stripe checkout started by the builder (the credits arrive by the builder's signed webhook)
  router.post('/api/app/credits/checkout', { auth: 'user' }, async (req, res, { c, json }) => {
    let body;
    try { body = await readJsonBody(req, 2000); } catch (e) { return json(res, 400, { ok: false, code: 'invalid_request', message: 'That request couldn’t be read.' }); }
    const r = await bridge.postCreditCheckout(c.access, typeof body.packId === 'string' ? body.packId.slice(0, 40) : '');
    if (r.status === 200 && r.data && r.data.ok && typeof r.data.url === 'string' && /^https:\/\//.test(r.data.url)) return json(res, 200, { ok: true, url: r.data.url });
    if (r.status === 200 && r.data && r.data.configured === false) return json(res, 503, { ok: false, code: 'checkout_unavailable', message: r.data.message || 'Checkout is not available right now.' });
    if (r.status === 400) return json(res, 400, { ok: false, code: 'invalid_request', message: 'Unknown credit pack.' });
    return passThroughError(json, res, r);
  });
  router.get('/api/app/credits/history', { auth: 'user' }, async (req, res, { c, json }) => {
    const r = await bridge.getCreditHistory(c.access);
    if (r.status === 200 && r.data && r.data.ok) return json(res, 200, { ok: true, events: (r.data.events || []).slice(0, 100).map(e => ({ type: String(e.type || '').slice(0, 30), amount: Number(e.amount) || 0, reason: String(e.reason || '').slice(0, 120), at: String(e.at || '').slice(0, 40) })) });
    if (r.status === 401 || r.status === 404) return json(res, 200, { ok: true, events: [], linked: false });
    return passThroughError(json, res, r);
  });

  // BILLING PASS: the plan, credit balance, renewal date and prices from the builder's one ledger (the same numbers
  // the builder shows), plus the one-time website price. Readable without a subscription: it is what tells a
  // customer what they have and what subscribing adds. `?refresh=1` re-checks the subscription right away.
  router.get('/api/app/website/credits', { auth: 'user' }, async (req, res, { c, u, json }) => {
    const r = await bridge.getCredits(c.access, u && u.searchParams && u.searchParams.get('refresh') === '1');
    if (r.status === 200 && r.data && r.data.ok && r.data.credits) return json(res, 200, { ok: true, credits: creditsFrom(r.data.credits), websitePrice: r.data.websitePrice || null, catalog: catalogFrom(r.data.catalog), subscriptionRequired: false });
    if (r.status === 401 || r.status === 404) return json(res, 200, { ok: true, credits: null, linked: false });
    return passThroughError(json, res, r);
  });

  // Phase 6: staff-only resolution of a link that needs review. The
  // workspace comes from the URL (staff can act on any workspace -- that's
  // what auth 'owner' means in this app), the chosen project must be one of
  // the candidates captured for that workspace's CURRENT mismatch.
  router.post('/api/app/admin/website-links/:workspaceId/relink', { auth: 'owner' }, async (req, res, { params, c, json }) => {
    let body;
    try { body = await readJsonBody(req, 4000); } catch (e) { return json(res, 400, { ok: false, code: 'invalid_request', message: 'That request couldn’t be read.' }); }
    const wid = String(params.workspaceId || '').slice(0, 80);
    if (!Array.isArray(c.workspaces) || !c.workspaces.some(w => w.id === wid)) return json(res, 404, { ok: false, code: 'not_found', message: 'Workspace not found.' });
    let out;
    try {
      out = await websiteLinks.relinkWorkspace(wid, typeof body.generatorProjectId === 'string' ? body.generatorProjectId.trim() : '', { actorUserId: c.user && c.user.id });
    } catch (e) {
      console.warn('[website-links] relink failed:', e && e.message);
      return json(res, 503, { ok: false, code: 'unavailable', message: 'The link couldn’t be updated right now. Nothing was changed.' });
    }
    if (!out.ok) return json(res, out.status, { ok: false, code: out.code, message: out.message });
    return json(res, 200, { ok: true, workspaceId: wid, projectId: out.to, previousProjectId: out.from, changed: out.changed });
  });

  router.post('/api/app/website/publish', { auth: 'user' }, async (req, res, { c, json }) => {
    if (!requireSiteRemadeAccess(c, json, res)) return;
    const gate = await workspaceGate(c);
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
