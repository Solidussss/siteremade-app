'use strict';
// THE WHOLE CUSTOMER FLOW, both real servers: the SiteRemade builder's own server.js (from SITEREMADE_BUILDER_DIR, run
// by its test helper with every paid provider -- Claude, OpenAI, Higgsfield, SerpApi, Stripe, Supabase -- answered by
// mocks at the network edge) and this app's real website routes + app.js website functions (test/helpers/app-harness.js,
// test/helpers/client-loader.js; the database in memory).
//   A. an old failed Creative draft            B. a Creative Showcase created and purchased
//   C. three premium videos (mocked Higgsfield) D. saved and published
//   E. the session ends                         F. a brand-new app tab: no cookie state of the builder, empty localStorage
// Then: both websites in Saved Websites, the Showcase owned and connected, the failed draft not masking it, the Showcase
// in project selection and shown above, its preview the published revision with all three clips, its download the
// published revision with all three MP4s -- and no paid provider called for real.
// Skipped (with the reason) unless SITEREMADE_BUILDER_DIR points at a builder checkout with its dependencies installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startApp } = require('./helpers/app-harness');
const { openTab } = require('./helpers/client-loader');
const SEL = require('../website-selection');

const BUILDER_DIR = process.env.SITEREMADE_BUILDER_DIR || '';
const usable = BUILDER_DIR && fs.existsSync(path.join(BUILDER_DIR, 'test', 'helpers', 'showcase-purchase.js')) && fs.existsSync(path.join(BUILDER_DIR, 'node_modules', 'express'));
const skip = usable ? false : 'set SITEREMADE_BUILDER_DIR to a SiteRemade builder checkout (with test/helpers/showcase-purchase.js and node_modules) to run the cross-repo cold start';

test('A-F on the real builder: a purchased Creative Showcase survives the session ending, shown, previewed and downloaded with all three MP4s; $0 provider spend', { skip, timeout: 240000 }, async () => {
  const { startServer } = require(path.join(BUILDER_DIR, 'test', 'helpers', 'server-process.js'));
  const { buildColdStartScenario, scenarioEnv, paidCalls, readZip } = require(path.join(BUILDER_DIR, 'test', 'helpers', 'showcase-purchase.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-app-cold-start-'));
  const env = scenarioEnv(dir, path);
  const builder = await startServer(env);
  // every request THIS process makes (the app's calls to the builder, the tab's calls to the app): local only
  const realFetch = globalThis.fetch; const hosts = new Set();
  globalThis.fetch = (url, opts) => { hosts.add(new URL(String(url)).hostname); return realFetch(url, opts); };
  let app = null;
  try {
    // A-D in the builder (its own studio routes, as the customer used them)
    const s = await buildColdStartScenario({ port: builder.port, env });
    // E. the session ends. F. the Client App, freshly started, and a brand-new tab with nothing remembered
    app = await startApp({ seed: { website_project_links: [], workspace_members: [] }, builderUrl: `http://127.0.0.1:${builder.port}`,
      people: { owner: { userId: 'u_owner', access: 'test-access-token-owner', workspaces: [{ id: 'ws_drifter', business_name: 'The Drifter' }] } } });
    const tab = openTab({ base: app.base, as: 'owner', workspaceId: 'ws_drifter', websiteProjects: [] });
    const v = await tab.coldLoad();
    assert.deepEqual(tab.storage.dump(), {}, 'nothing was remembered to help');

    // both projects in Saved Websites; the Showcase owned and connected; the failed draft a draft
    assert.equal(v.savedWebsites.status, 'ready', JSON.stringify(v.savedWebsites));
    const row = id => v.savedWebsites.list.find(x => x.projectId === id);
    assert.ok(row(s.showcaseId) && row(s.failedDraftId), 'both websites are in Saved Websites');
    assert.equal(v.savedWebsites.list[0].projectId, s.failedDraftId, '(the failed draft is the most recently updated)');
    assert.equal(row(s.showcaseId).isPurchased, true); assert.equal(row(s.showcaseId).mode, 'creative'); assert.equal(row(s.showcaseId).linked, true);
    assert.equal(row(s.failedDraftId).isPurchased, false); assert.equal(row(s.failedDraftId).linked, false);
    assert.deepEqual(app.db.rows('website_project_links').map(l => [l.workspace_id, l.generator_project_id, l.last_seen_revision]), [['ws_drifter', s.showcaseId, s.publishedRevision]]);

    // the main Website view and project selection: the Showcase, not the draft
    assert.equal(v.canonicalWebsite.status, 'ready'); assert.equal(v.canonicalWebsite.project.projectId, s.showcaseId);
    assert.equal(v.canonicalWebsite.project.publishedRevision, s.publishedRevision); assert.equal(v.canonicalWebsite.project.hasUnpublishedChanges, false);
    assert.deepEqual(v.multiProject.list.map(p => p.projectId), [s.showcaseId]);
    assert.equal(SEL.chooseWebsiteProject(v.multiProject.list, null), s.showcaseId);

    // its preview (what the view's frame loads) is the published Showcase with its three clips
    const snap = v.websiteSnapshot(); assert.ok(snap.builderPreview); assert.equal(snap.url, snap.builderPreview);
    for (const url of [snap.builderPreview, `/api/app/websites/${s.showcaseId}/preview?source=published`]) {
      const p = await app.call('owner', 'GET', url);
      assert.equal(p.status, 200, url);
      const srcs = [...p.buf.toString('utf8').matchAll(/<video class="ly-vid"[^>]*\ssrc="([^"]+)"/g)].map(m => m[1]);
      assert.equal(new Set(srcs).size, 3, `${url}: all three clips`); assert.ok(srcs.every(x => x.startsWith('data:video/mp4;base64,')));
    }

    // its download -- from the Saved Websites row, the main view and the project route -- is the published revision
    for (const url of [`/api/app/websites/${s.showcaseId}/download`, '/api/app/website/download', `/api/app/website/projects/${s.showcaseId}/download`]) {
      const dl = await app.call('owner', 'GET', url);
      assert.equal(dl.status, 200, `${url}: ${dl.buf.toString('utf8').slice(0, 200)}`); assert.equal(dl.headers.get('content-type'), 'application/zip');
      const files = readZip(dl.buf); const manifest = JSON.parse(files.get('export-manifest.json').toString('utf8'));
      assert.equal(manifest.projectId, s.showcaseId); assert.equal(manifest.exportedRevision, s.publishedRevision, `${url}: the published revision`);
      assert.deepEqual([...files.keys()].filter(n => n.endsWith('.mp4')).sort(), s.videoRefs.map(r => `assets/${r}.mp4`).sort(), `${url}: all three MP4s`);
    }
    // the failed draft: listed, never the handoff
    assert.equal((await app.call('owner', 'GET', `/api/app/websites/${s.failedDraftId}/download`)).status, 403);

    // $0: the only paid calls were answered by the builder's mocks (three video submits); nothing left this machine
    const paid = paidCalls(env);
    assert.equal(paid.filter(c => c.provider === 'higgsfield' && /image-to-video$/.test(c.endpoint || '')).length, 3);
    assert.deepEqual([...hosts], ['127.0.0.1'], 'the app and the tab only ever talked to the local test servers');
  } finally {
    globalThis.fetch = realFetch;
    if (app) await app.stop();
    await builder.stop(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
