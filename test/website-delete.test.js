'use strict';
// WEBSITE DELETION -- the website admin ONLY (lib/website-admin.js: one named account, jaydenflynn9@gmail.com, by its
// verified and confirmed email; no role grants it). The app's real website routes (test/helpers/app-harness.js) against a
// fixture builder (test/helpers/fixture-builder.js -- the real builder, which checks the same rule again and keeps the
// purchase and payment records, is exercised by test/website-delete-e2e.test.js), and the browser's own website functions
// (test/helpers/client-loader.js) for what a tab shows after a deletion.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app-harness');
const { startFixtureBuilder } = require('./helpers/fixture-builder');
const { openTab, memoryStorage } = require('./helpers/client-loader');
const WA = require('../lib/website-admin');
const View = require('../saved-websites-view');
const SEL = require('../website-selection');

const ADMIN_EMAIL = 'jaydenflynn9@gmail.com';
const SHOW = 'proj_AliceShowcaseAAAAAAAAAA', SECOND = 'proj_AliceSecondBBBBBBBBBBB', DRAFT = 'proj_AliceDraftCCCCCCCCCCCC', CAROL = 'proj_CarolSiteDDDDDDDDDDDD';
const project = (id, extra) => Object.assign({ projectId: id, name: id, mode: 'creative', status: 'draft', revision: 1, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }, extra);
const bought = (id, at) => project(id, { status: 'purchased', revision: 3, purchaseRef: 'SR-' + id.slice(5, 9), purchasedAt: at, purchasedRevision: 3, updatedAt: at });
// who is who: the website admin; the same address unconfirmed; a look-alike address; a business's own customer (its
// creator); a member of that business; SiteRemade staff (profiles.role 'owner': every workspace); another business
const PEOPLE = {
  admin: { userId: 'u_admin', access: 'tok-admin', email: ADMIN_EMAIL, workspaces: [{ id: 'ws_admin', business_name: 'SiteRemade' }] },
  adminCaps: { userId: 'u_admin2', access: 'tok-admin2', email: 'JaydenFlynn9@Gmail.com', workspaces: [{ id: 'ws_admin2', business_name: 'SiteRemade 2' }] },
  unconfirmed: { userId: 'u_unconf', access: 'tok-unconf', email: ADMIN_EMAIL, emailConfirmed: false, workspaces: [{ id: 'ws_unconf', business_name: 'Unconfirmed' }] },
  lookalike: { userId: 'u_look', access: 'tok-look', email: 'jaydenflynn9@gmail.com.example.com', workspaces: [{ id: 'ws_look', business_name: 'Look' }] },
  alice: { userId: 'u_alice', access: 'tok-alice', email: 'alice@example.com', workspaces: [{ id: 'ws_alice', business_name: 'Aurelia' }] },
  member: { userId: 'u_member', access: 'tok-member', email: 'member@example.com', workspaces: [{ id: 'ws_alice', business_name: 'Aurelia' }] },
  staff: { userId: 'u_staff', owner: true, access: 'tok-staff', email: 'admin@siteremade.com', workspaces: [{ id: 'ws_alice' }, { id: 'ws_carol' }, { id: 'ws_staff' }], wid: 'ws_alice' },
  carol: { userId: 'u_carol', access: 'tok-carol', email: 'carol@example.com', workspaces: [{ id: 'ws_carol', business_name: 'Carol Co' }] },
};
const NOT_ADMIN = ['unconfirmed', 'lookalike', 'alice', 'member', 'staff', 'carol'];
function accounts() {
  return {
    'tok-admin': { admin: true, email: ADMIN_EMAIL, projects: [] }, 'tok-admin2': { admin: true, email: ADMIN_EMAIL, projects: [] },
    'tok-alice': { email: 'alice@example.com', projects: [bought(SHOW, '2026-10-01T10:00:00.000Z'), bought(SECOND, '2026-09-20T10:00:00.000Z'), project(DRAFT, { updatedAt: '2026-10-02T09:00:00.000Z' })] },
    'tok-carol': { email: 'carol@example.com', projects: [bought(CAROL, '2026-09-15T10:00:00.000Z')] },
    'tok-member': { email: 'member@example.com', projects: [] }, 'tok-staff': { email: 'admin@siteremade.com', projects: [] },
    'tok-unconf': { email: ADMIN_EMAIL, projects: [] }, 'tok-look': { email: 'jaydenflynn9@gmail.com.example.com', projects: [] },
  };
}
async function world() {
  const builder = await startFixtureBuilder(accounts());
  const app = await startApp({ seed: { website_project_links: [], workspace_members: [{ user_id: 'u_staff', workspace_id: 'ws_staff' }], audit_logs: [] }, people: PEOPLE, builderUrl: builder.url });
  // the businesses connect their purchased websites (one-business accounts: automatically, as on their first visit)
  for (const who of ['alice', 'carol']) assert.equal((await app.call(who, 'GET', '/api/app/websites')).status, 200);
  return { builder, app, links: () => app.db.rows('website_project_links'), stop: async () => { await app.stop(); await builder.stop(); } };
}
const adminCalls = w => w.builder.seen.filter(s => s.url.startsWith('/api/app-bridge/admin/'));

test('DEL-1. the rule: exactly the admin email, verified and confirmed -- never a role, staff, a look-alike or an unconfirmed address', () => {
  assert.deepEqual([...WA.WEBSITE_ADMIN_EMAILS], [ADMIN_EMAIL]);
  const ctx = (email, confirmed, extra) => Object.assign({ user: { id: 'u', email, email_confirmed_at: confirmed ? '2026-01-01T00:00:00Z' : null } }, extra || {});
  assert.equal(WA.isWebsiteAdmin(ctx(ADMIN_EMAIL, true)), true); assert.equal(WA.isWebsiteAdmin(ctx('JaydenFlynn9@Gmail.com', true)), true);
  for (const c of [ctx(ADMIN_EMAIL, false), ctx('jaydenflynn9@gmail.com.example.com', true), ctx('admin@siteremade.com', true, { owner: true, profile: { role: 'owner' } }), ctx('alice@example.com', true, { owner: true }), null, {}, { user: null }])
    assert.equal(WA.isWebsiteAdmin(c), false, JSON.stringify(c));
});

test('DEL-2. nobody but the admin can delete -- a business\'s own customer, a member, staff, another business, an unconfirmed or look-alike address: 403, nothing reaches the builder, nothing is deleted or unlinked', async () => {
  const w = await world();
  try {
    const linksBefore = JSON.stringify(w.links()); assert.ok(w.links().length >= 2);
    for (const who of NOT_ADMIN) {
      assert.equal((await w.app.call(who, 'GET', '/api/app/websites')).body.canDeleteWebsites === true, false, `${who}: no Delete action`);
      const list = await w.app.call(who, 'GET', '/api/app/admin/websites'); assert.deepEqual([list.status, list.body.code], [403, 'FORBIDDEN'], `${who}: list`);
      for (const id of [SHOW, SECOND, DRAFT, CAROL]) {
        const r = await w.app.call(who, 'DELETE', `/api/app/admin/websites/${id}`); assert.deepEqual([r.status, r.body.code], [403, 'FORBIDDEN'], `${who}: delete ${id}`);
      }
    }
    // (made by hand, the way a script would: the same answers -- the route never trusts the page)
    assert.equal((await fetch(`${w.app.base}/api/app/admin/websites/${SHOW}`, { method: 'DELETE', headers: { 'x-test-as': 'member' } })).status, 403);
    assert.equal((await fetch(`${w.app.base}/api/app/admin/websites/${SHOW}`, { method: 'DELETE' })).status, 401, 'signed out');
    assert.deepEqual(adminCalls(w), [], 'not one of those requests reached the builder');
    assert.equal(JSON.stringify(w.links()), linksBefore, 'no business lost a website');
    assert.equal(w.app.db.writes.filter(x => x.op === 'delete').length, 0);
    assert.deepEqual((await w.app.call('alice', 'GET', '/api/app/websites')).body.websites.map(x => x.projectId).sort(), [DRAFT, SECOND, SHOW].sort());
  } finally { await w.stop(); }
});

test('DEL-3. the admin deletes ONE website of another account: it is gone from its owner\'s Saved Websites and from every business, the other websites stay, the action is audited -- and deleting it again is safe', async () => {
  const w = await world();
  try {
    const mine = await w.app.call('admin', 'GET', '/api/app/websites'); assert.equal(mine.body.canDeleteWebsites, true, 'the admin sees Delete');
    assert.equal((await w.app.call('adminCaps', 'GET', '/api/app/websites')).body.canDeleteWebsites, true, '(the address in any letter case)');
    const all = await w.app.call('admin', 'GET', '/api/app/admin/websites'); assert.equal(all.status, 200);
    assert.deepEqual(all.body.websites.map(x => x.projectId).sort(), [CAROL, DRAFT, SECOND, SHOW].sort(), 'every account\'s websites');
    assert.equal(all.body.websites.find(x => x.projectId === CAROL).ownerEmail, 'carol@example.com');
    assert.ok(w.links().some(l => l.generator_project_id === SHOW && l.workspace_id === 'ws_alice'));
    const del = await w.app.call('admin', 'DELETE', `/api/app/admin/websites/${SHOW}`);
    assert.equal(del.status, 200); assert.deepEqual([del.body.ok, del.body.alreadyRemoved, del.body.wasPurchased, del.body.unlinkedWorkspaces], [true, false, true, 1]);
    // gone from its owner (Saved Websites, the Website view's projects) and from every business; the rest untouched
    assert.deepEqual((await w.app.call('alice', 'GET', '/api/app/websites')).body.websites.map(x => x.projectId).sort(), [DRAFT, SECOND].sort());
    assert.ok(!w.links().some(l => l.generator_project_id === SHOW)); assert.ok(w.links().some(l => l.generator_project_id === SECOND)); assert.ok(w.links().some(l => l.generator_project_id === CAROL));
    const projects = (await w.app.call('alice', 'GET', '/api/app/website/projects')).body.projects.map(p => p.projectId); assert.ok(!projects.includes(SHOW)); assert.ok(projects.includes(SECOND));
    assert.equal((await w.app.call('alice', 'GET', `/api/app/websites/${SHOW}/preview?source=published`)).status, 404, 'no broken preview: it is not found');
    assert.deepEqual((await w.app.call('carol', 'GET', '/api/app/websites')).body.websites.map(x => x.projectId), [CAROL], 'another business is untouched');
    // audited
    const audit = w.app.db.rows('audit_logs'); assert.equal(audit.length, 1); assert.deepEqual([audit[0].user_id, audit[0].action], ['u_admin', 'website.delete']); assert.match(audit[0].detail, new RegExp(SHOW));
    // again (a double click, a retry): safe -- nothing more changes
    const again = await w.app.call('admin', 'DELETE', `/api/app/admin/websites/${SHOW}`);
    assert.deepEqual([again.status, again.body.ok, again.body.alreadyRemoved, again.body.unlinkedWorkspaces], [200, true, true, 0]);
    assert.deepEqual((await w.app.call('alice', 'GET', '/api/app/websites')).body.websites.map(x => x.projectId).sort(), [DRAFT, SECOND].sort());
    // a draft and another account's purchased website can be deleted too; an unknown id is not found
    assert.equal((await w.app.call('admin', 'DELETE', `/api/app/admin/websites/${DRAFT}`)).status, 200);
    assert.equal((await w.app.call('admin', 'DELETE', `/api/app/admin/websites/${CAROL}`)).status, 200);
    assert.equal((await w.app.call('admin', 'DELETE', '/api/app/admin/websites/proj_NoSuchWebsiteEEEEEEEE')).status, 404);
    assert.equal((await w.app.call('admin', 'DELETE', '/api/app/admin/websites/not-a-project-id')).status, 404);
    assert.deepEqual((await w.app.call('alice', 'GET', '/api/app/websites')).body.websites.map(x => x.projectId), [SECOND], 'only the website not deleted remains');
  } finally { await w.stop(); }
});

test('DEL-4. after a deletion, a reloaded tab shows neither the website nor a broken selection: the business\'s Website view falls back to its other website -- or to its empty state when there is none', async () => {
  const w = await world();
  try {
    // Alice had the Showcase open (remembered in her browser)
    // (her choice was made after both websites were connected -- website-selection.js prefers a website connected later)
    const storage = memoryStorage({ [SEL.keyFor('ws_alice')]: JSON.stringify({ id: SHOW, at: new Date(Date.now() + 60000).toISOString() }) });
    const before = await openTab({ base: w.app.base, as: 'alice', workspaceId: 'ws_alice', storage }).coldLoad();
    assert.equal(before.canonicalWebsite.project.projectId, SHOW);
    assert.equal((await w.app.call('admin', 'DELETE', `/api/app/admin/websites/${SHOW}`)).status, 200);
    // her next page load: the Showcase is not in Saved Websites, the view opens her other website, the memory is fixed
    const after = await openTab({ base: w.app.base, as: 'alice', workspaceId: 'ws_alice', storage }).coldLoad();
    assert.ok(!after.savedWebsites.list.some(x => x.projectId === SHOW), 'gone from Saved Websites after reload');
    assert.equal(after.canonicalWebsite.status, 'ready'); assert.equal(after.canonicalWebsite.project.projectId, SECOND, 'falls back to the other website');
    assert.notEqual(SEL.remembered(storage, 'ws_alice') && SEL.remembered(storage, 'ws_alice').id, SHOW, 'the deleted website is no longer remembered');
    // ...and when that one goes too: the empty state, no selection
    assert.equal((await w.app.call('admin', 'DELETE', `/api/app/admin/websites/${SECOND}`)).status, 200);
    const empty = await openTab({ base: w.app.base, as: 'alice', workspaceId: 'ws_alice', storage }).coldLoad();
    assert.notEqual(empty.canonicalWebsite.status, 'ready', 'no website to show'); assert.equal(empty.canonicalWebsite.project, null, 'no deleted website selected');
    assert.equal(empty.multiProject.list.length, 0); assert.ok(!empty.savedWebsites.list.some(x => x.status === 'purchased'));
  } finally { await w.stop(); }
});

test('DEL-5. in the admin\'s own tab: deleting the website it is showing clears that choice and moves to the next one; a second click while it is on its way does nothing', async () => {
  const builder = await startFixtureBuilder(Object.assign(accounts(), { 'tok-admin': { admin: true, email: ADMIN_EMAIL, projects: [bought('proj_AdminOneFFFFFFFFFFFFF', '2026-10-01T10:00:00.000Z'), bought('proj_AdminTwoGGGGGGGGGGGGG', '2026-09-01T10:00:00.000Z')] } }));
  const app = await startApp({ seed: { website_project_links: [], workspace_members: [], audit_logs: [] }, people: PEOPLE, builderUrl: builder.url });
  try {
    const storage = memoryStorage();
    const tab = openTab({ base: app.base, as: 'admin', workspaceId: 'ws_admin', storage }); const a = await tab.coldLoad();
    assert.equal(a.savedWebsites.canDelete, true); assert.equal(a.canonicalWebsite.project.projectId, 'proj_AdminOneFFFFFFFFFFFFF');
    a.switchToWebsiteProject('proj_AdminOneFFFFFFFFFFFFF');
    const first = a.deleteWebsite('proj_AdminOneFFFFFFFFFFFFF'); const second = await a.deleteWebsite('proj_AdminOneFFFFFFFFFFFFF');
    assert.equal(JSON.stringify(second), JSON.stringify({ ok: false, busy: true }), 'the double click does nothing');
    const r = await first; assert.equal(JSON.stringify(r), JSON.stringify({ ok: true, alreadyRemoved: false }));
    for (let i = 0; i < 20 && (a.canonicalWebsite.inflight || a.multiProject.inflight || a.savedWebsites.inflight); i++) await Promise.all([a.canonicalWebsite.inflight, a.multiProject.inflight, a.savedWebsites.inflight].filter(Boolean));
    assert.equal(builder.seen.filter(s => s.method === 'POST' && /\/remove$/.test(s.url)).length, 1, 'one deletion was asked for');
    assert.ok(!a.savedWebsites.list.some(x => x.projectId === 'proj_AdminOneFFFFFFFFFFFFF'));
    assert.equal(a.canonicalWebsite.project.projectId, 'proj_AdminTwoGGGGGGGGGGGGG', 'the view moved to the other website');
    assert.notEqual((SEL.remembered(storage, 'ws_admin') || {}).id, 'proj_AdminOneFFFFFFFFFFFFF');
    assert.equal(a.websiteDelete.pending, null);
  } finally { await app.stop(); await builder.stop(); }
});

test('DEL-6. the page: Delete lives in a "•••" menu, only when the server says so, as a destructive action; the confirmation says it cannot be undone, purchased websites need DELETE typed, and nothing else in a row changes', () => {
  const owned = { projectId: SHOW, name: 'Aurelia', status: 'purchased', isPurchased: true, mode: 'creative', updatedAt: '2026-10-01T00:00:00Z', linked: true };
  const without = View.rowHtml(owned, {}); const withDel = View.rowHtml(owned, { canDelete: true });
  assert.doesNotMatch(without, /data-saved-delete|Delete website/, 'everyone else: no Delete at all');
  assert.match(withDel, /<details class="saved-website-more"><summary aria-label="More actions for Aurelia">•••<\/summary><div class="saved-website-menu"><button type="button" class="danger-button" data-saved-delete="proj_AliceShowcaseAAAAAAAAAA" data-saved-name="Aurelia" data-saved-owned="1">Delete website<\/button>/);
  assert.equal(withDel.replace(/<details class="saved-website-more">[\s\S]*?<\/details>/, ''), without, 'the row is otherwise exactly as before');
  assert.match(View.rowHtml(owned, { canDelete: true, deletingProjectId: SHOW }), /disabled>Deleting…</);
  assert.match(View.adminListHtml({ status: 'ready', list: [Object.assign({ ownerEmail: 'alice@example.com' }, owned)] }, {}), /alice@example\.com[\s\S]*data-saved-delete/);
  const js = require('fs').readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(js, /Delete this website\? This cannot be undone\./); assert.match(js, /Type <strong>DELETE<\/strong> to confirm/);
  assert.match(js, /b\.disabled=e\.target\.value\.trim\(\)!=='DELETE'/, 'the final button only works once DELETE is typed');
  assert.match(js, /if\(websiteDelete\.pending\)return \{ok:false,busy:true\};/);
  assert.match(js, /if\(!savedWebsites\.canDelete\)\{host\.hidden=true;/, 'the all-websites panel exists only for the admin');
});
