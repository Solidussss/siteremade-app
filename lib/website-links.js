// Phase 5: the workspace <-> builder project reference link
// (public.website_project_links, V52-WEBSITE-PROJECT-LINK-MIGRATION.sql).
//
// The builder (generator) project id — `proj_…`, stable and opaque — is
// the website's identity. This file only ever stores that id plus
// bookkeeping (purchase ref, last seen revision, the workspace's analytics
// site id, timestamps). It never stores website content, and it is never
// used to AUTHORIZE a builder call: routes/website-bridge.js still asks the
// builder for the signed-in user's canonical project on every request, and
// the builder re-verifies ownership each time. What the link is for:
//   - server-side routing where there is no signed-in user at all
//     (POST /api/public/site-submission resolves the owning workspace from
//     a project id through findWorkspaceForProject — never from anything
//     the caller says about a workspace);
//   - a stable anchor for analytics provisioning and for staff (Admin).
// Domain is not involved anywhere here.
//
// Phase 6 (multi-purchase review, V53-WEBSITE-LINK-CANDIDATES-MIGRATION.sql):
// when the builder reports a different purchased project than the linked
// one, routes/website-bridge.js captures -- with the CUSTOMER'S OWN token, on
// the customer's own visit -- every project that customer has purchased
// (recordMismatchCandidates). Staff then resolve the review in Admin by
// picking one of exactly those stored ids (relinkWorkspace); nothing a staff
// member types is ever treated as verified on its own.
'use strict';
const { db } = require('./context');

const PROJECT_ID_RE = /^proj_[A-Za-z0-9_-]{8,64}$/;
const TABLE = 'website_project_links';
const nowIso = () => new Date().toISOString();
const MAX_CANDIDATES = 20; // V53's CHECK allows 50; one person with >20 purchases is an Admin conversation, not a picker
const ISO_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})?$/;

// Candidate lists are metadata only: {projectId, purchaseRef, purchasedAt,
// revision}. Anything else the builder might add later is dropped here, and
// malformed entries are skipped rather than stored.
function sanitizeCandidates(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  const seen = new Set();
  for (const x of list) {
    if (!x || typeof x !== 'object' || !PROJECT_ID_RE.test(String(x.projectId || '')) || seen.has(x.projectId)) continue;
    seen.add(x.projectId);
    out.push({
      projectId: x.projectId,
      purchaseRef: typeof x.purchaseRef === 'string' && x.purchaseRef ? x.purchaseRef.slice(0, 200) : null,
      purchasedAt: typeof x.purchasedAt === 'string' && ISO_RE.test(x.purchasedAt) ? x.purchasedAt.slice(0, 40) : null,
      revision: Number.isInteger(x.revision) && x.revision >= 0 ? x.revision : null,
    });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

// V53 not applied yet -> the candidate columns don't exist. Remembered for a
// while so a customer's every Website visit doesn't retry (and re-ask the
// builder for a list there is nowhere to store).
const CANDIDATE_COLUMNS_RETRY_MS = 10 * 60 * 1000;
let candidateColumnsMissingAt = 0;
const looksLikeMissingColumn = (e) => /mismatch_candidates|column .* does not exist|schema cache/i.test(String((e && e.message) || ''));
function candidateCaptureSupported() { return !candidateColumnsMissingAt || Date.now() - candidateColumnsMissingAt > CANDIDATE_COLUMNS_RETRY_MS; }
// A recorded mismatch whose candidate list hasn't been captured yet (new
// mismatch, or one recorded before V53 existed).
function needsCandidateCapture(link) {
  return !!(link && link.mismatch_project_id && !Array.isArray(link.mismatch_candidates) && candidateCaptureSupported());
}
// Only ever mention the V53 columns in a write when the row we read has them
// (real Postgres returns every column from select('*'), null or not), so a
// database without V53 keeps working exactly as it did under V52.
const hasCandidateColumns = (row) => !!row && Object.prototype.hasOwnProperty.call(row, 'mismatch_candidates');

async function getLinkForWorkspace(wid) {
  if (!db || !wid) return null;
  const { data, error } = await db.from(TABLE).select('*').eq('workspace_id', wid).maybeSingle();
  if (error) throw error;
  return data || null;
}

// Exactly one workspace, or null. Fetches up to two rows so an ambiguous
// match (impossible with V52's unique index, but never assumed) is refused
// rather than resolved to whichever row came back first.
async function findWorkspaceForProject(projectId) {
  if (!db || !PROJECT_ID_RE.test(String(projectId || ''))) return null;
  const { data, error } = await db.from(TABLE).select('workspace_id,generator_project_id').eq('generator_project_id', projectId).limit(2);
  if (error) throw error;
  if (!Array.isArray(data) || data.length !== 1) return null;
  return data[0].workspace_id;
}

// Called with a successful GET /api/app-bridge/website summary for workspace
// `wid` (routes/website-bridge.js has already applied its workspace gate:
// a non-staff user with exactly one workspace). Returns
//   { status: 'linked'|'not_linked'|'mismatch'|'conflict', link, created }
//   - not_linked: no link yet and the project isn't purchased (drafts are
//     never linked);
//   - linked:     link exists (or was just created) for this same project;
//   - mismatch:   this workspace is linked to project A but the builder now
//                 reports project B for the same person. The link is NOT
//                 re-pointed; B is recorded in mismatch_project_id for staff;
//   - conflict:   the reported project is already linked to a different
//                 workspace. Nothing is written.
async function recordBridgeSummary(wid, summary) {
  const projectId = summary && summary.projectId;
  if (!db || !wid || !PROJECT_ID_RE.test(String(projectId || ''))) return { status: 'not_linked', link: null, created: false };
  const revision = Number.isInteger(summary.revision) ? summary.revision : null;
  const existing = await getLinkForWorkspace(wid);

  // Phase 8: a workspace with no link yet is no longer auto-linked here.
  // Silently linking to whatever the builder resolves as "canonical" (its
  // own most-recently-purchased-project guess) is exactly the invisible
  // connection the Website page's "Connect a website" flow replaces: the
  // customer now sees their own verified purchases (GET
  // /api/app/website/candidates, backed by the same builder call) and
  // explicitly chooses one (POST /api/app/website/connect ->
  // connectWorkspaceToProject below), even when there's only one choice.
  // This function keeps doing everything else it always did -- refreshing
  // an EXISTING link's last-seen revision, detecting and recording a
  // mismatch, clearing a resolved one -- untouched.
  if (!existing) return { status: 'not_linked', link: null, created: false };

  if (existing.generator_project_id !== projectId) {
    // A data-integrity signal, not something to "fix" silently: the builder
    // resolves "most recent purchased project" per person (a known
    // builder-side limitation), so a second purchase can change what it
    // reports. Staff decide; the link stays as it was.
    console.warn('[website-links] builder reported a different project than the linked one; link left unchanged', { workspaceId: wid, linkedProjectId: existing.generator_project_id, reportedProjectId: projectId });
    if (existing.mismatch_project_id !== projectId) {
      const t = nowIso();
      // A new mismatch invalidates any candidate list captured for an older one.
      const patch = { mismatch_project_id: projectId, mismatch_seen_at: t, updated_at: t };
      if (hasCandidateColumns(existing)) { patch.mismatch_candidates = null; patch.mismatch_candidates_at = null; }
      await db.from(TABLE).update(patch).eq('workspace_id', wid).eq('generator_project_id', existing.generator_project_id);
      return { status: 'mismatch', link: { ...existing, ...patch }, created: false };
    }
    return { status: 'mismatch', link: existing, created: false };
  }

  const patch = {};
  if (revision !== null && existing.last_seen_revision !== revision) patch.last_seen_revision = revision;
  if (existing.mismatch_project_id) { patch.mismatch_project_id = null; patch.mismatch_seen_at = null; }
  if (hasCandidateColumns(existing) && existing.mismatch_candidates != null) { patch.mismatch_candidates = null; patch.mismatch_candidates_at = null; }
  if (!existing.purchase_ref && typeof summary.purchaseRef === 'string' && summary.purchaseRef) patch.purchase_ref = summary.purchaseRef.slice(0, 200);
  if (Object.keys(patch).length) {
    patch.updated_at = nowIso();
    await db.from(TABLE).update(patch).eq('workspace_id', wid).eq('generator_project_id', projectId);
  }
  return { status: 'linked', link: { ...existing, ...patch }, created: false };
}

// Phase 8: the explicit "connect a website" action for a workspace with NO
// link yet (routes/website-bridge.js's POST /api/app/website/connect). The
// candidate passed in must come from a call the route just made to the
// builder with THIS SAME request's own access token (GET
// /api/app-bridge/website/candidates) -- never anything the browser
// remembered from an earlier response, so ownership is re-verified at the
// moment of connecting, not just at the moment of listing.
// Deliberately refuses when a link already exists: switching an existing
// link stays a staff decision via relinkWorkspace (Phase 6's mismatch
// review), so this app never lets a customer silently re-point a link that
// was already established -- only create the first one.
async function connectWorkspaceToProject(wid, candidate) {
  const fail = (status, code, message) => ({ ok: false, status, code, message });
  if (!db) return fail(503, 'unavailable', 'The database isn’t configured.');
  if (!wid || !candidate || !PROJECT_ID_RE.test(String(candidate.projectId || ''))) return fail(400, 'invalid_request', 'Choose one of your SiteRemade websites.');
  const existing = await getLinkForWorkspace(wid);
  if (existing) return fail(409, 'already_linked', 'This workspace is already connected to a SiteRemade website.');
  const other = await findAnyWorkspaceForProject(candidate.projectId);
  if (other && other !== wid) return fail(409, 'linked_elsewhere', 'That website is already connected to a different business on SiteRemade.');
  const t = nowIso();
  const row = {
    workspace_id: wid, generator_project_id: candidate.projectId,
    purchase_ref: typeof candidate.purchaseRef === 'string' && candidate.purchaseRef ? candidate.purchaseRef.slice(0, 200) : null,
    last_seen_revision: Number.isInteger(candidate.revision) ? candidate.revision : null,
    linked_at: t, updated_at: t,
  };
  const ins = await db.from(TABLE).insert(row).select('*').single();
  if (!ins.error && ins.data) return { ok: true, link: ins.data, created: true };
  if (/duplicate key|unique/i.test(String(ins.error && ins.error.message || ''))) {
    // Lost a race: either this same workspace got linked a moment ago (two
    // tabs connecting at once) or the project itself did (another workspace
    // won it first, or -- extremely unlikely, the unique index still
    // catches it -- a second connect for this same workspace/project).
    const again = await getLinkForWorkspace(wid);
    if (again && again.generator_project_id === candidate.projectId) return { ok: true, link: again, created: false };
    return fail(409, 'linked_elsewhere', 'That website is already connected to a different business on SiteRemade.');
  }
  console.warn('[website-links] connect failed', { workspaceId: wid, projectId: candidate.projectId, error: ins.error && ins.error.message });
  return fail(503, 'unavailable', 'Couldn’t connect your website right now. Nothing was changed.');
}

async function findAnyWorkspaceForProject(projectId) {
  const { data, error } = await db.from(TABLE).select('workspace_id').eq('generator_project_id', projectId).limit(1);
  if (error) throw error;
  return Array.isArray(data) && data[0] ? data[0].workspace_id : null;
}

// Phase 6: stores the candidate list captured with the customer's own token
// at the moment their visit hit a recorded mismatch. Conditional on the row
// still being in exactly that state (same linked project, same reported
// project), so a list can never be attached to a different review than the
// one it was captured for. Resolves {ok, reason?}; never throws.
async function recordMismatchCandidates(wid, link, candidates) {
  try {
    const clean = sanitizeCandidates(candidates);
    if (!db || !wid || !link || !link.mismatch_project_id || !clean) return { ok: false, reason: 'invalid' };
    const t = nowIso();
    const { error } = await db.from(TABLE).update({ mismatch_candidates: clean, mismatch_candidates_at: t, updated_at: t })
      .eq('workspace_id', wid).eq('generator_project_id', link.generator_project_id).eq('mismatch_project_id', link.mismatch_project_id);
    if (error) {
      if (looksLikeMissingColumn(error)) { candidateColumnsMissingAt = Date.now(); return { ok: false, reason: 'migration_missing' }; }
      throw error;
    }
    candidateColumnsMissingAt = 0;
    return { ok: true, count: clean.length };
  } catch (e) {
    console.warn('[website-links] could not store mismatch candidates:', e && e.message);
    return { ok: false, reason: 'error' };
  }
}

// Phase 6: staff resolve a "needs review" link by choosing one of the
// candidate projects that were captured (and ownership-verified by the
// builder, with the customer's own token) for THIS workspace's current
// mismatch. `requestedProjectId` is only ever matched against that stored
// list -- an id that isn't in it is refused, however it was obtained.
// Returns {ok:true, link, from, to} or {ok:false, status, code, message}.
async function relinkWorkspace(wid, requestedProjectId, { actorUserId } = {}) {
  const fail = (status, code, message) => ({ ok: false, status, code, message });
  if (!db) return fail(503, 'unavailable', 'The database isn’t configured.');
  if (!PROJECT_ID_RE.test(String(requestedProjectId || ''))) return fail(400, 'invalid_request', 'Choose one of the listed builder projects.');
  const existing = await getLinkForWorkspace(wid);
  if (!existing) return fail(404, 'not_linked', 'This workspace isn’t linked to a builder project.');
  if (!existing.mismatch_project_id) return fail(409, 'no_review_pending', 'This link doesn’t need review any more. Refresh Admin.');
  if (!hasCandidateColumns(existing)) return fail(503, 'migration_missing', 'Candidate data needs the V53 migration. Apply it, then ask the customer to open their Website view again.');
  const candidates = sanitizeCandidates(existing.mismatch_candidates);
  if (!candidates || !candidates.length) return fail(409, 'no_candidates', 'No candidate data is available for this workspace yet. Ask the customer to open their Website view again to refresh it.');
  const chosen = candidates.find(x => x.projectId === requestedProjectId);
  if (!chosen) return fail(422, 'not_a_candidate', 'That builder project isn’t one of this customer’s verified purchases. Nothing was changed.');
  if (chosen.projectId !== existing.generator_project_id) {
    const other = await findAnyWorkspaceForProject(chosen.projectId);
    if (other && other !== wid) return fail(409, 'linked_elsewhere', 'That builder project is already linked to a different workspace. Nothing was changed.');
  }
  const t = nowIso();
  const patch = {
    generator_project_id: chosen.projectId,
    mismatch_project_id: null, mismatch_seen_at: null, mismatch_candidates: null, mismatch_candidates_at: null,
    updated_at: t,
  };
  if (chosen.projectId !== existing.generator_project_id) {
    Object.assign(patch, { purchase_ref: chosen.purchaseRef, last_seen_revision: chosen.revision, linked_at: t });
  }
  // Optimistic: only if the row is still exactly the review staff looked at.
  const { data, error } = await db.from(TABLE).update(patch)
    .eq('workspace_id', wid).eq('generator_project_id', existing.generator_project_id).eq('mismatch_project_id', existing.mismatch_project_id)
    .select('*');
  if (error) {
    if (/duplicate key|unique/i.test(String(error.message || ''))) return fail(409, 'linked_elsewhere', 'That builder project is already linked to a different workspace. Nothing was changed.');
    throw error;
  }
  if (!Array.isArray(data) || data.length !== 1) return fail(409, 'changed', 'This link changed while you were reviewing it. Refresh Admin and try again.');
  // Existing audit_logs table (supabase-schema.sql), same row shape server.js's
  // audit() writes: {user_id, workspace_id, action, detail}.
  const detail = `builder project ${existing.generator_project_id} -> ${chosen.projectId} (builder had reported ${existing.mismatch_project_id}; chosen from ${candidates.length} verified candidate${candidates.length === 1 ? '' : 's'} captured ${existing.mismatch_candidates_at || 'earlier'})`;
  const logged = await db.from('audit_logs').insert({ user_id: actorUserId || null, workspace_id: wid, action: 'website_link.relink', detail: detail.slice(0, 1000) });
  if (logged && logged.error) console.warn('[website-links] relink audit log failed:', logged.error.message);
  return { ok: true, link: data[0], from: existing.generator_project_id, to: chosen.projectId, changed: chosen.projectId !== existing.generator_project_id };
}

// Staff-only listing for Admin (server.js GET /api/app/admin). Tolerates
// the table not existing yet (V52 not applied) instead of breaking Admin,
// and V53's candidate columns not existing yet (candidatesAvailable:false).
const LIST_COLS = 'workspace_id,generator_project_id,last_seen_revision,analytics_site_id,linked_at,updated_at,mismatch_project_id,mismatch_seen_at';
async function listLinks() {
  if (!db) return { available: false, candidatesAvailable: false, rows: [] };
  const withCandidates = await db.from(TABLE).select(LIST_COLS + ',mismatch_candidates,mismatch_candidates_at');
  if (!withCandidates.error) return { available: true, candidatesAvailable: true, rows: withCandidates.data || [] };
  const { data, error } = await db.from(TABLE).select(LIST_COLS);
  if (error) { console.warn('[website-links] listLinks:', error.message); return { available: false, candidatesAvailable: false, rows: [] }; }
  return { available: true, candidatesAvailable: false, rows: data || [] };
}

module.exports = {
  PROJECT_ID_RE, getLinkForWorkspace, findWorkspaceForProject, recordBridgeSummary, listLinks,
  sanitizeCandidates, needsCandidateCapture, recordMismatchCandidates, relinkWorkspace,
  connectWorkspaceToProject,
};
