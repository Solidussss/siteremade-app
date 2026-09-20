// NEW routes backing the V51 migration (V51-DAILY-WORKFLOW-MIGRATION.sql):
// gives the follow-up reminders and prospect outreach stages that
// v42-daily-workflow.js used to keep ONLY in localStorage (key
// `sr-workflow:${workspaceId}`) a durable, cross-device home in Supabase.
// See that file for the frontend side of this — it still keeps its
// localStorage cache for instant, synchronous reads (no UI/behavior
// change), but now loads from and writes through to these routes too.
//
// GET /api/app/workflow/state returns both maps in the exact shape the
// frontend already used internally ({followups:{[leadId]:{...}},
// prospects:{[placeKey]:{...}}}), so the merge on the client is a plain
// object spread.
const { db, readJsonBody } = require('../lib/context');

function mapFollowup(row) { return { date: row.date, action: row.action, done: row.done }; }
function mapProspect(row) { return { stage: row.stage, updatedAt: row.updated_at }; }

module.exports = function registerDailyWorkflowRoutes(router) {
  router.get('/api/app/workflow/state', { auth: 'user' }, async (req, res, { c, json }) => {
    const [followupRows, prospectRows] = await Promise.all([
      db.from('lead_followups').select('*').eq('workspace_id', c.wid),
      db.from('prospect_stages').select('*').eq('workspace_id', c.wid)
    ]);
    if (followupRows.error) throw followupRows.error;
    if (prospectRows.error) throw prospectRows.error;
    const followups = {};
    for (const row of followupRows.data || []) followups[row.lead_id] = mapFollowup(row);
    const prospects = {};
    for (const row of prospectRows.data || []) prospects[row.place_key] = mapProspect(row);
    return json(res, 200, { ok: true, followups, prospects });
  });

  router.put('/api/app/workflow/followups/:leadId', { auth: 'user' }, async (req, res, { c, params, json }) => {
    const b = await readJsonBody(req);
    const date = String(b.date || '').trim().slice(0, 10);
    const action = String(b.action || '').trim().slice(0, 1000);
    const done = !!b.done;
    if (!date || !action) return json(res, 400, { ok: false, message: 'A follow-up needs a date and an action.' });
    const lead = (await db.from('leads').select('id').eq('id', params.leadId).eq('workspace_id', c.wid).maybeSingle()).data;
    if (!lead) return json(res, 404, { ok: false, message: 'Lead not found.' });
    const row = { workspace_id: c.wid, lead_id: params.leadId, date, action, done, updated_at: new Date().toISOString() };
    const saved = await db.from('lead_followups').upsert(row, { onConflict: 'workspace_id,lead_id' }).select('*').single();
    if (saved.error) throw saved.error;
    return json(res, 200, { ok: true, followup: mapFollowup(saved.data) });
  });

  router.delete('/api/app/workflow/followups/:leadId', { auth: 'user' }, async (req, res, { c, params, json }) => {
    await db.from('lead_followups').delete().eq('workspace_id', c.wid).eq('lead_id', params.leadId);
    return json(res, 200, { ok: true });
  });

  router.put('/api/app/workflow/prospect-stages', { auth: 'user' }, async (req, res, { c, json }) => {
    const b = await readJsonBody(req);
    const placeKey = String(b.placeKey || '').trim().toLowerCase().slice(0, 300);
    const stage = String(b.stage || '').trim().slice(0, 40);
    const validStages = ['Unreviewed', 'Worth calling', 'Contacted', 'Follow up', 'Not relevant'];
    if (!placeKey || !validStages.includes(stage)) return json(res, 400, { ok: false, message: 'A valid prospect key and stage are required.' });
    const row = { workspace_id: c.wid, place_key: placeKey, stage, updated_at: new Date().toISOString() };
    const saved = await db.from('prospect_stages').upsert(row, { onConflict: 'workspace_id,place_key' }).select('*').single();
    if (saved.error) throw saved.error;
    return json(res, 200, { ok: true, stage: mapProspect(saved.data) });
  });
};
