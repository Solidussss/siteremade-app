'use strict';
// WEBSITE DELETION, both real servers: the builder's own server.js (SITEREMADE_BUILDER_DIR; its test helpers make a
// PURCHASED Creative website -- with its 3D model, paid with a mocked Stripe -- and a draft) and this app's real routes.
// Only the website admin (lib/website-admin.js; the builder checks the same rule again) deletes; the website leaves its
// owner's account and every business, while the builder keeps its purchase, payment and ledger records. $0 provider spend.
// Skipped (with the reason) unless SITEREMADE_BUILDER_DIR points at a builder checkout with its dependencies installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startApp } = require('./helpers/app-harness');

const BUILDER_DIR = process.env.SITEREMADE_BUILDER_DIR || '';
const usable = BUILDER_DIR && fs.existsSync(path.join(BUILDER_DIR, 'test', 'helpers', 'three-d-scenario.js')) && fs.existsSync(path.join(BUILDER_DIR, 'migrations', '0013_project_removal.sql')) && fs.existsSync(path.join(BUILDER_DIR, 'node_modules', 'express'));
const skip = usable ? false : 'set SITEREMADE_BUILDER_DIR to a SiteRemade builder checkout (with website removal and node_modules) to run the cross-repo website deletion';

test('the real builder: only the admin deletes; a purchased website leaves its owner\'s account and every business, its purchase, payment and ledger records stay, files already downloaded are untouched, and a second delete is safe', { skip, timeout: 240000 }, async () => {
  const { startServer, client } = require(path.join(BUILDER_DIR, 'test', 'helpers', 'server-process.js'));
  const S = require(path.join(BUILDER_DIR, 'test', 'helpers', 'three-d-scenario.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-app-delete-e2e-'));
  const env = S.threeDEnv(dir); const builder = await startServer(env); let app = null; let ownerAccount; let ledgerBefore; let projectId; let draftId;
  try {
    const s = await S.buildThreeDScenario({ port: builder.port, env }); projectId = s.projectId; // (purchased, published, with its 3D model)
    const owner = client(builder.port); await owner('POST', '/api/identity/supabase/session', { supabaseAccessToken: 'test-access-token-owner' });
    draftId = (await owner('POST', '/api/projects', { name: 'A draft', directionsState: { directions: [{ mode: 'creative', meta: { id: 'd' }, pages: [{ id: 'creative', label: 'Creative page', sections: [] }], creative: { brief: 'a draft', assets: [], plan: null } }], activeDirectionIndex: 0 } })).body.project.id;
    ownerAccount = (await owner('GET', '/api/auth/me')).body.account.id;
    for (const t of ['test-access-token-admin', 'test-access-token-other']) assert.equal((await client(builder.port)('POST', '/api/identity/supabase/session', { supabaseAccessToken: t })).status, 200);
    { const db = require(path.join(BUILDER_DIR, 'lib', 'adapters', 'sqlite-database-adapter.js')).resetSqliteAdapter(env.SITEREMADE_DB_PATH); ledgerBefore = { grants: db.ledger.grantsForAccount(ownerAccount).length, ops: db.ledger.opsForAccount(ownerAccount).length }; }
    app = await startApp({ seed: { website_project_links: [], workspace_members: [], audit_logs: [] }, builderUrl: `http://127.0.0.1:${builder.port}`,
      people: {
        owner: { userId: 'u_owner', access: 'test-access-token-owner', email: 'bridge-test@example.com', workspaces: [{ id: 'ws_aurelia', business_name: 'Aurelia Tonic' }] },
        staff: { userId: 'u_staff', owner: true, access: 'test-access-token-other', email: 'other-owner@example.com', workspaces: [{ id: 'ws_aurelia' }, { id: 'ws_staff' }], wid: 'ws_aurelia' },
        admin: { userId: 'u_admin', access: 'test-access-token-admin', email: 'jaydenflynn9@gmail.com', workspaces: [{ id: 'ws_admin', business_name: 'SiteRemade' }] },
      } });
    const listed = await app.call('owner', 'GET', '/api/app/websites'); assert.deepEqual(listed.body.websites.map(w => w.projectId).sort(), [projectId, draftId].sort());
    assert.ok(app.db.rows('website_project_links').some(l => l.generator_project_id === projectId), 'connected to the business');
    // the customer downloads their files first: theirs to keep
    const zip = await app.call('owner', 'GET', `/api/app/websites/${projectId}/download`); assert.equal(zip.status, 200); const saved = path.join(dir, 'my-website.zip'); fs.writeFileSync(saved, zip.buf);
    // ---- the website's own owner and staff cannot -- and the builder refuses them on its own too
    for (const who of ['owner', 'staff']) { const r = await app.call(who, 'DELETE', `/api/app/admin/websites/${projectId}`); assert.equal(r.status, 403, who); }
    const direct = await fetch(`http://127.0.0.1:${builder.port}/api/app-bridge/admin/websites/${projectId}/remove`, { method: 'POST', headers: { authorization: 'Bearer test-access-token-owner' } });
    assert.equal(direct.status, 403, 'the builder checks the rule itself: the owner calling it directly is refused');
    assert.equal((await app.call('owner', 'GET', '/api/app/websites')).body.websites.length, 2, 'nothing was deleted');
    // ---- the admin
    const all = await app.call('admin', 'GET', '/api/app/admin/websites'); assert.equal(all.status, 200); assert.ok(all.body.websites.some(w => w.projectId === projectId && w.ownerEmail === 'bridge-test@example.com' && w.isPurchased));
    const del = await app.call('admin', 'DELETE', `/api/app/admin/websites/${projectId}`);
    assert.deepEqual([del.status, del.body.ok, del.body.alreadyRemoved, del.body.wasPurchased, del.body.unlinkedWorkspaces], [200, true, false, true, 1]);
    // gone from the owner's account, the business, the preview and the files -- the draft stays
    assert.deepEqual((await app.call('owner', 'GET', '/api/app/websites')).body.websites.map(w => w.projectId), [draftId]);
    assert.ok(!app.db.rows('website_project_links').some(l => l.generator_project_id === projectId));
    assert.equal((await app.call('owner', 'GET', `/api/app/websites/${projectId}/preview?source=published`)).status, 404);
    assert.notEqual((await app.call('owner', 'GET', `/api/app/websites/${projectId}/download`)).status, 200);
    assert.ok(fs.readFileSync(saved).equals(zip.buf), 'the files the customer already downloaded are untouched');
    // again: safe
    const again = await app.call('admin', 'DELETE', `/api/app/admin/websites/${projectId}`); assert.deepEqual([again.status, again.body.alreadyRemoved], [200, true]);
  } finally { if (app) await app.stop(); await builder.stop(); }
  // ---- the builder's records: the purchase, its snapshot and the credit ledger are all still there
  const db = require(path.join(BUILDER_DIR, 'lib', 'adapters', 'sqlite-database-adapter.js')).resetSqliteAdapter(env.SITEREMADE_DB_PATH);
  const row = db.projects.findById(projectId);
  assert.deepEqual([row.status, !!row.purchase_ref, !!row.removed_at], ['purchased', true, true], 'still a purchased project in the records, marked removed');
  assert.ok(db.purchaseSnapshots.findByProject(projectId), 'its purchase snapshot is kept');
  assert.deepEqual({ grants: db.ledger.grantsForAccount(ownerAccount).length, ops: db.ledger.opsForAccount(ownerAccount).length }, ledgerBefore, 'the credit ledger is untouched');
  assert.equal(db.projects.findById(draftId).removed_at, null);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* (Windows keeps the open database file: the temp folder is left) */ }
});
