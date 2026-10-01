'use strict';
// RELOAD / COLD START: a website a customer bought must still be there -- listed, connected, shown above, previewed and
// downloadable -- on a brand-new page load with nothing remembered in the browser, and an older failed draft must never
// hide or replace it. The production incident (proj_QxoEiHuWtQS2GEVDX63Ej0qb): a Creative Showcase was purchased and its
// three premium videos saved and published, but after the browser was closed the Client App showed the old state --
// the purchase had never been connected to the business (Phase 8 removed automatic connection), so the Website view
// fell back to the old delivery record and the switcher listed nothing.
//
// The REAL app routes (routes/website-bridge.js and lib/*) and the REAL app.js website functions run here; the
// database is in memory (test/helpers/fake-supabase.js) and the builder is a fixture (test/helpers/fixture-builder.js;
// the real builder is test/cold-start-e2e.test.js). No paid provider exists anywhere in this test.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app-harness');
const { startFixtureBuilder } = require('./helpers/fixture-builder');
const { openTab, memoryStorage } = require('./helpers/client-loader');
const SEL = require('../website-selection');

const SHOW = 'proj_QxoEiHuWtQS2GEVDX63Ej0qb'; // the production project
const FAILED = 'proj_FailedDraftAAAAAAAAAAAA';
const OLDBIZ = 'proj_OlderBusinessBBBBBBBBB';
const project = (id, extra) => Object.assign({ projectId: id, name: id, mode: 'creative', status: 'draft', revision: 1, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }, extra);
// A. an older Creative draft whose generation failed -- touched last, so it is the most recently updated
const failedDraft = () => project(FAILED, { name: 'The Drifter (failed)', updatedAt: '2026-10-01T12:00:00.000Z', revision: 2 });
// B-D. the Creative Showcase: purchased at revision 4, videos attached, saved and published at revision 7
const showcase = () => project(SHOW, { name: 'The Drifter — Showcase', status: 'purchased', revision: 7, purchaseRef: 'SR-SHOW', purchasedAt: '2026-10-01T10:00:00.000Z', purchasedRevision: 4, publishedRevision: 7, createdAt: '2026-10-01T09:00:00.000Z', updatedAt: '2026-10-01T11:00:00.000Z' });
const olderBusiness = () => project(OLDBIZ, { name: 'Summit Roofing', mode: 'business', status: 'purchased', revision: 3, purchaseRef: 'SR-OLD', purchasedAt: '2026-09-01T10:00:00.000Z', purchasedRevision: 3, updatedAt: '2026-09-02T00:00:00.000Z' });

const PEOPLE = {
  alice: { userId: 'u_alice', access: 'tok-alice', workspaces: [{ id: 'ws_alice', business_name: 'Alice Co' }] },
  multi: { userId: 'u_multi', access: 'tok-multi', workspaces: [{ id: 'ws_m1', business_name: 'One' }, { id: 'ws_m2', business_name: 'Two' }], wid: 'ws_m1' },
  bob: { userId: 'u_bob', access: 'tok-bob', workspaces: [{ id: 'ws_bob', business_name: 'Bob Co' }] },
  // staff (role owner: getContext lists every workspace) viewing a customer's workspace they are not a member of
  staffVisiting: { userId: 'u_staff', owner: true, access: 'tok-staff', workspaces: [{ id: 'ws_alice' }, { id: 'ws_staff' }], wid: 'ws_alice' },
  // staff in their own (only) business
  staffHome: { userId: 'u_staff', owner: true, access: 'tok-staff', workspaces: [{ id: 'ws_alice' }, { id: 'ws_staff' }], wid: 'ws_staff' },
};
const MEMBERS = [{ user_id: 'u_staff', workspace_id: 'ws_staff' }];

async function world({ accounts, links }) {
  const builder = await startFixtureBuilder(accounts);
  const app = await startApp({ seed: { website_project_links: links || [], workspace_members: MEMBERS }, people: PEOPLE, builderUrl: builder.url });
  // (the old delivery record -- staff-entered preview address -- is what the view fell back to in the incident)
  const tab = (as, wid, storage) => openTab({ base: app.base, as, workspaceId: wid, storage, websiteProjects: [{ id: 'wp_old', status: 'live', previewUrl: 'https://old-delivery.example.com', liveUrl: '', updatedAt: '2026-08-01T00:00:00.000Z' }] });
  return { builder, app, tab, links: () => app.db.rows('website_project_links'), inserts: () => app.db.writes.filter(w => w.op === 'insert'), stop: async () => { await app.stop(); await builder.stop(); } };
}

// ---------------------------------------------------------------------------------------------------------------------
test('A-F. cold start after the session ends: both websites listed, the Showcase owned, connected, shown above, previewed and downloaded from the published revision; the newer failed draft masks nothing', async () => {
  const w = await world({ accounts: { 'tok-alice': { projects: [failedDraft(), showcase()] } } });
  try {
    // F. a brand-new tab: nothing in localStorage, nothing in memory
    const t = w.tab('alice', 'ws_alice'); const app = await t.coldLoad();
    // Saved Websites: both, the Showcase owned and connected, the failed draft a draft (and not connected)
    assert.equal(app.savedWebsites.status, 'ready');
    const byId = id => app.savedWebsites.list.find(x => x.projectId === id);
    assert.ok(byId(SHOW) && byId(FAILED), 'both websites are in Saved Websites');
    assert.equal(byId(SHOW).isPurchased, true); assert.equal(byId(SHOW).status, 'purchased'); assert.equal(byId(SHOW).linked, true, 'connected without anyone pressing Connect');
    assert.equal(byId(FAILED).isPurchased, false); assert.equal(byId(FAILED).linked, false, 'a draft is never connected');
    assert.equal(app.savedWebsites.list[0].projectId, FAILED, '(the failed draft really is the newest -- the masking case)');
    // the main Website view shows the purchased Showcase -- not the failed draft, not the old delivery record
    assert.equal(app.canonicalWebsite.status, 'ready'); assert.equal(app.canonicalWebsite.project.projectId, SHOW);
    const snap = app.websiteSnapshot();
    assert.ok(snap.builderPreview, 'the builder preview is used'); assert.equal(snap.url, snap.builderPreview); assert.notEqual(snap.url, 'https://old-delivery.example.com/');
    // project selection: it is there to pick (and the only connected website)
    assert.deepEqual(app.multiProject.list.map(p => p.projectId), [SHOW]);
    assert.equal(SEL.chooseWebsiteProject(app.multiProject.list, null), SHOW);
    // the preview the view loads is the Showcase's PUBLISHED revision
    const preview = await w.app.call('alice', 'GET', snap.builderPreview);
    assert.equal(preview.status, 200); assert.match(preview.buf.toString(), new RegExp(`data-project="${SHOW}" data-source="published" data-revision="7"`));
    // the download (from the Saved Websites row and from the main view) is the published revision's handoff
    for (const url of [`/api/app/websites/${SHOW}/download`, '/api/app/website/download', `/api/app/website/projects/${SHOW}/download`]) {
      const dl = await w.app.call('alice', 'GET', url);
      assert.equal(dl.status, 200, url); assert.equal(dl.headers.get('content-type'), 'application/zip'); assert.match(dl.buf.toString(), new RegExp(`${SHOW} revision 7`), url);
    }
    assert.ok(!w.builder.seen.some(s => s.url.includes(`${FAILED}/download`)), 'the failed draft is never offered as the download');
    // the failed draft is still previewable as a draft from its row -- and has no purchased handoff
    assert.equal((await w.app.call('alice', 'GET', `/api/app/websites/${FAILED}/preview`)).status, 200);
    assert.equal((await w.app.call('alice', 'GET', `/api/app/websites/${FAILED}/download`)).status, 403);
    // exactly one link, for the Showcase, in Alice's business; every builder call carried Alice's own token
    assert.deepEqual(w.links().map(l => [l.workspace_id, l.generator_project_id, l.purchase_ref, l.last_seen_revision]), [['ws_alice', SHOW, 'SR-SHOW', 7]]);
    assert.ok(w.builder.seen.every(s => s.token === 'tok-alice'));
  } finally { await w.stop(); }
});

test('repeated startup never creates a duplicate link and never rewrites the existing one', async () => {
  const w = await world({ accounts: { 'tok-alice': { projects: [failedDraft(), showcase(), olderBusiness()] } } });
  try {
    await w.tab('alice', 'ws_alice').coldLoad();
    const first = w.links(); const firstInserts = w.inserts().length;
    assert.deepEqual(first.map(l => l.generator_project_id).sort(), [OLDBIZ, SHOW].sort(), 'every purchased website, never the draft');
    for (let i = 0; i < 3; i++) { const app = await w.tab('alice', 'ws_alice').coldLoad(); assert.equal(app.canonicalWebsite.project.projectId, SHOW); }
    // and the server routes on their own, many times, concurrently
    await Promise.all(Array.from({ length: 4 }, () => [w.app.call('alice', 'GET', '/api/app/website'), w.app.call('alice', 'GET', '/api/app/websites')]).flat());
    assert.equal(w.inserts().length, firstInserts, 'no further inserts');
    assert.deepEqual(w.links(), first, 'the rows are exactly as they were (linked_at untouched)');
  } finally { await w.stop(); }
});

test('several purchased websites coexist: an existing link is kept as it was, the new purchase is added, nothing re-pointed or removed', async () => {
  const existing = { id: 900, workspace_id: 'ws_alice', generator_project_id: OLDBIZ, purchase_ref: 'SR-OLD', last_seen_revision: 3, analytics_site_id: 'umami-1', linked_at: '2026-09-01T11:00:00.000Z', updated_at: '2026-09-01T11:00:00.000Z' };
  const w = await world({ accounts: { 'tok-alice': { projects: [olderBusiness(), failedDraft(), showcase()] } }, links: [existing] });
  try {
    // before the fix this workspace showed only the old website: the newest purchase wasn't connected
    const app = await w.tab('alice', 'ws_alice').coldLoad();
    assert.equal(app.canonicalWebsite.project.projectId, SHOW, 'the new purchase is shown above');
    const links = w.links();
    assert.deepEqual(links.find(l => l.generator_project_id === OLDBIZ), existing, 'the older link is untouched (same row, same analytics site, same dates)');
    assert.ok(links.find(l => l.generator_project_id === SHOW && l.workspace_id === 'ws_alice'));
    assert.equal(links.length, 2);
    assert.deepEqual(app.multiProject.list.map(p => p.projectId).sort(), [OLDBIZ, SHOW].sort(), 'both can be picked in the switcher');
    assert.equal(w.app.db.writes.filter(x => x.op === 'update' && x.table === 'website_project_links' && x.patch.generator_project_id).length, 0, 'no link was ever re-pointed');
  } finally { await w.stop(); }
});

test('a remembered choice: kept across reloads, but never hides a website bought after it, and a stale one falls back to the newest purchase -- never the failed draft', async () => {
  const w = await world({ accounts: { 'tok-alice': { projects: [olderBusiness(), failedDraft(), showcase()] } }, links: [{ workspace_id: 'ws_alice', generator_project_id: OLDBIZ, purchase_ref: 'SR-OLD', last_seen_revision: 3, linked_at: '2026-09-01T11:00:00.000Z', updated_at: '2026-09-01T11:00:00.000Z' }] });
  try {
    // the person had opened the older website in August -- before the Showcase was bought (and connected)
    const storage = memoryStorage({ [SEL.keyFor('ws_alice')]: JSON.stringify({ id: OLDBIZ, at: '2026-09-05T00:00:00.000Z' }) });
    let app = await w.tab('alice', 'ws_alice', storage).coldLoad();
    assert.equal(app.canonicalWebsite.project.projectId, SHOW, 'the newer purchase wins over the older remembered choice');
    // now they deliberately switch to the older website; the next fresh tab opens it again
    app.switchToWebsiteProject(OLDBIZ); await app.canonicalWebsite.inflight;
    app = await w.tab('alice', 'ws_alice', storage).coldLoad();
    assert.equal(app.canonicalWebsite.project.projectId, OLDBIZ); assert.equal(app.canonicalWebsite.scopedProjectId, OLDBIZ);
    // a stale choice -- the failed draft's id, or a website that isn't this business's -- is forgotten
    for (const stale of [FAILED, 'proj_NotThisBusinessZZZZZZZ']) {
      const s = memoryStorage({ [SEL.keyFor('ws_alice')]: JSON.stringify({ id: stale, at: '2026-10-01T13:00:00.000Z' }) });
      app = await w.tab('alice', 'ws_alice', s).coldLoad();
      assert.notEqual(app.canonicalWebsite.project.projectId, FAILED);
      assert.equal(SEL.usable(app.canonicalWebsite.project), true, 'a purchased website is shown');
      assert.notEqual((SEL.remembered(s, 'ws_alice') || {}).id, stale, 'the stale choice is not kept');
    }
  } finally { await w.stop(); }
});

test('an account in several businesses: nothing is connected by guessing; Saved Websites still lists the purchase; an explicit connect opens it after a reload', async () => {
  const w = await world({ accounts: { 'tok-multi': { projects: [failedDraft(), showcase()] } } });
  try {
    let app = await w.tab('multi', 'ws_m1').coldLoad();
    assert.equal(w.links().length, 0, 'no automatic link'); assert.equal(w.inserts().length, 0);
    assert.equal(app.savedWebsites.status, 'ready', 'the saved list still loads');
    assert.ok(app.savedWebsites.list.find(x => x.projectId === SHOW && x.isPurchased && !x.linked));
    assert.equal(app.savedWebsites.ambiguous, true);
    assert.equal(app.canonicalWebsite.status, 'unavailable'); assert.equal(app.canonicalWebsite.code, 'workspace_mismatch', 'the builder\'s default is not guessed for a business');
    // the explicit choice, in the business the person is in (re-verified against the builder's purchases)
    const connect = await w.app.call('multi', 'POST', '/api/app/website/connect', { projectId: SHOW });
    assert.equal(connect.status, 200); assert.equal(connect.body.created, true);
    assert.deepEqual(w.links().map(l => [l.workspace_id, l.generator_project_id]), [['ws_m1', SHOW]]);
    // a drafts can't be connected
    assert.equal((await w.app.call('multi', 'POST', '/api/app/website/connect', { projectId: FAILED })).status, 422);
    // a fresh tab: the connected purchase opens (through the business's link), with its preview
    app = await w.tab('multi', 'ws_m1').coldLoad();
    assert.equal(app.canonicalWebsite.status, 'ready'); assert.equal(app.canonicalWebsite.project.projectId, SHOW); assert.equal(app.canonicalWebsite.scopedProjectId, SHOW);
    const preview = await w.app.call('multi', 'GET', app.websiteSnapshot().builderPreview);
    assert.equal(preview.status, 200); assert.match(preview.buf.toString(), new RegExp(`data-project="${SHOW}" data-source="published"`));
    // the other business is untouched
    assert.ok(!w.links().some(l => l.workspace_id === 'ws_m2'));
  } finally { await w.stop(); }
});

test('never takes a website connected to another business, and a project id alone authorizes nothing', async () => {
  const elsewhere = { workspace_id: 'ws_bob', generator_project_id: SHOW, purchase_ref: 'SR-SHOW', last_seen_revision: 7, linked_at: '2026-10-01T10:30:00.000Z', updated_at: '2026-10-01T10:30:00.000Z' };
  const w = await world({ accounts: { 'tok-alice': { projects: [showcase()] }, 'tok-bob': { projects: [] } }, links: [elsewhere] });
  try {
    await w.tab('alice', 'ws_alice').coldLoad();
    assert.deepEqual(w.links(), [elsewhere], 'the existing link to the other business is left exactly as it was');
    // Bob knows the id, but it isn't his website: the builder refuses his token, the app refuses without a link
    assert.equal((await w.app.call('bob', 'GET', `/api/app/websites/${SHOW}/preview?source=published`)).status, 404);
    assert.notEqual((await w.app.call('bob', 'GET', `/api/app/websites/${SHOW}/download`)).status, 200);
    assert.equal((await w.app.call('bob', 'POST', '/api/app/website/connect', { projectId: SHOW })).status, 422, 'not one of his purchases');
    const bobsApp = await w.tab('bob', 'ws_bob').coldLoad();
    assert.ok(!bobsApp.savedWebsites.list.some(x => x.projectId === SHOW));
    // Alice can't open it through the project route here: her business has no link to it
    assert.equal((await w.app.call('alice', 'GET', `/api/app/website/projects/${SHOW}`)).status, 404);
  } finally { await w.stop(); }
});

test('staff: never their own builder websites inside a customer\'s business; in their own only business, the same automatic connection', async () => {
  const w = await world({ accounts: { 'tok-staff': { projects: [showcase()] } } });
  try {
    for (const url of ['/api/app/website', '/api/app/websites', `/api/app/websites/${SHOW}/preview`, '/api/app/website/projects']) {
      assert.equal((await w.app.call('staffVisiting', 'GET', url)).status, 403, url);
    }
    assert.equal(w.links().length, 0);
    const app = await w.tab('staffHome', 'ws_staff').coldLoad();
    assert.equal(app.canonicalWebsite.project.projectId, SHOW);
    assert.deepEqual(w.links().map(l => [l.workspace_id, l.generator_project_id]), [['ws_staff', SHOW]]);
  } finally { await w.stop(); }
});

test('drafts and checkouts in progress are never connected automatically', async () => {
  const w = await world({ accounts: { 'tok-alice': { projects: [failedDraft(), project('proj_CheckoutPendingCCCCCCCC', { status: 'checkout_pending', updatedAt: '2026-10-01T13:00:00.000Z' })] } } });
  try {
    const app = await w.tab('alice', 'ws_alice').coldLoad();
    assert.equal(w.links().length, 0);
    assert.equal(app.canonicalWebsite.status, 'unavailable'); assert.equal(app.canonicalWebsite.code, 'no_project');
    assert.equal(app.savedWebsites.list.length, 2, 'both still listed');
  } finally { await w.stop(); }
});

test('website-selection.js: only purchased, available, connected websites are ever picked', () => {
  const p = (id, extra) => Object.assign({ projectId: id, status: 'purchased', updatedAt: '2026-09-01T00:00:00Z', linkedAt: '2026-09-01T00:00:00Z' }, extra);
  const A = 'proj_AAAAAAAAAAAAAAAA', B = 'proj_BBBBBBBBBBBBBBBB', C = 'proj_CCCCCCCCCCCCCCCC';
  assert.equal(SEL.chooseWebsiteProject([], null), null);
  assert.equal(SEL.chooseWebsiteProject([p(A, { status: 'draft', updatedAt: '2026-12-01T00:00:00Z' }), p(B)], null), B, 'a newer draft never wins');
  assert.equal(SEL.chooseWebsiteProject([p(A, { unavailable: true, updatedAt: '2026-12-01T00:00:00Z' }), p(B)], null), B, 'an unavailable one is skipped');
  assert.equal(SEL.chooseWebsiteProject([p(A), p(B, { updatedAt: '2026-09-05T00:00:00Z' })], null), B, 'most recently updated');
  assert.equal(SEL.chooseWebsiteProject([p(A), p(B)], { id: A, at: '2026-09-02T00:00:00Z' }), A, 'the remembered one');
  assert.equal(SEL.chooseWebsiteProject([p(A), p(C, { linkedAt: '2026-09-03T00:00:00Z' })], { id: A, at: '2026-09-02T00:00:00Z' }), C, 'connected after the choice: the new purchase');
  assert.equal(SEL.chooseWebsiteProject([p(A)], { id: 'proj_GONEGONEGONEGONE', at: null }), A);
  const s = memoryStorage(); SEL.remember(s, 'ws', A, '2026-09-02T00:00:00Z'); assert.deepEqual(SEL.remembered(s, 'ws'), { id: A, at: '2026-09-02T00:00:00Z' });
  SEL.remember(s, 'ws', null); assert.equal(SEL.remembered(s, 'ws'), null);
  s.setItem(SEL.keyFor('ws'), 'not json'); assert.equal(SEL.remembered(s, 'ws'), null);
  assert.equal(SEL.remembered({ getItem() { throw new Error('blocked'); } }, 'ws'), null, 'blocked storage never breaks the view');
});
