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
'use strict';
const { db } = require('./context');

const PROJECT_ID_RE = /^proj_[A-Za-z0-9_-]{8,64}$/;
const TABLE = 'website_project_links';
const nowIso = () => new Date().toISOString();

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

  if (!existing) {
    if (summary.status !== 'purchased') return { status: 'not_linked', link: null, created: false };
    const other = await findAnyWorkspaceForProject(projectId);
    if (other && other !== wid) {
      console.warn('[website-links] builder project already linked to another workspace; not linking', { workspaceId: wid, projectId, linkedWorkspaceId: other });
      return { status: 'conflict', link: null, created: false };
    }
    const t = nowIso();
    const row = { workspace_id: wid, generator_project_id: projectId, purchase_ref: typeof summary.purchaseRef === 'string' ? summary.purchaseRef.slice(0, 200) : null, last_seen_revision: revision, linked_at: t, updated_at: t };
    const ins = await db.from(TABLE).insert(row).select('*').single();
    if (!ins.error && ins.data) return { status: 'linked', link: ins.data, created: true };
    // Lost a race with a concurrent first request, or hit the unique index.
    const again = await getLinkForWorkspace(wid);
    if (again && again.generator_project_id === projectId) return { status: 'linked', link: again, created: false };
    console.warn('[website-links] could not create link', { workspaceId: wid, projectId, error: ins.error && ins.error.message });
    return { status: again ? 'mismatch' : 'conflict', link: again || null, created: false };
  }

  if (existing.generator_project_id !== projectId) {
    // A data-integrity signal, not something to "fix" silently: the builder
    // resolves "most recent purchased project" per person (a known
    // builder-side limitation), so a second purchase can change what it
    // reports. Staff decide; the link stays as it was.
    console.warn('[website-links] builder reported a different project than the linked one; link left unchanged', { workspaceId: wid, linkedProjectId: existing.generator_project_id, reportedProjectId: projectId });
    if (existing.mismatch_project_id !== projectId) {
      const t = nowIso();
      await db.from(TABLE).update({ mismatch_project_id: projectId, mismatch_seen_at: t }).eq('workspace_id', wid).eq('generator_project_id', existing.generator_project_id);
      return { status: 'mismatch', link: { ...existing, mismatch_project_id: projectId, mismatch_seen_at: t }, created: false };
    }
    return { status: 'mismatch', link: existing, created: false };
  }

  const patch = {};
  if (revision !== null && existing.last_seen_revision !== revision) patch.last_seen_revision = revision;
  if (existing.mismatch_project_id) { patch.mismatch_project_id = null; patch.mismatch_seen_at = null; }
  if (!existing.purchase_ref && typeof summary.purchaseRef === 'string' && summary.purchaseRef) patch.purchase_ref = summary.purchaseRef.slice(0, 200);
  if (Object.keys(patch).length) {
    patch.updated_at = nowIso();
    await db.from(TABLE).update(patch).eq('workspace_id', wid).eq('generator_project_id', projectId);
  }
  return { status: 'linked', link: { ...existing, ...patch }, created: false };
}

async function findAnyWorkspaceForProject(projectId) {
  const { data, error } = await db.from(TABLE).select('workspace_id').eq('generator_project_id', projectId).limit(1);
  if (error) throw error;
  return Array.isArray(data) && data[0] ? data[0].workspace_id : null;
}

// Staff-only listing for Admin (server.js GET /api/app/admin). Tolerates
// the table not existing yet (V52 not applied) instead of breaking Admin.
async function listLinks() {
  if (!db) return { available: false, rows: [] };
  const { data, error } = await db.from(TABLE).select('workspace_id,generator_project_id,last_seen_revision,analytics_site_id,linked_at,updated_at,mismatch_project_id,mismatch_seen_at');
  if (error) { console.warn('[website-links] listLinks:', error.message); return { available: false, rows: [] }; }
  return { available: true, rows: data || [] };
}

module.exports = { PROJECT_ID_RE, getLinkForWorkspace, findWorkspaceForProject, recordBridgeSummary, listLinks };
