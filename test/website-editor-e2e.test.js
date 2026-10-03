'use strict';
// THE WEBSITE EDITOR, both real servers: the builder's own server.js (SITEREMADE_BUILDER_DIR; its test helpers make a
// PURCHASED Creative website -- with its interactive 3D model, paid with a mocked Stripe -- and a Business website) and
// this app's real routes. The app is only the control surface: a Creative website is opened in the same Website view and
// edited as the Creative project it is (the builder edits creative.plan, validates, prices, runs the jobs, saves drafts);
// a Business website keeps its update flow. $0 provider spend: the AI director, Tripo and Higgsfield are the builder's
// own test mocks, every other paid provider refused.
// Skipped (with the reason) unless SITEREMADE_BUILDER_DIR points at a builder checkout with the Creative website editor.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { startApp } = require('./helpers/app-harness');

const BUILDER_DIR = process.env.SITEREMADE_BUILDER_DIR || '';
const usable = BUILDER_DIR && fs.existsSync(path.join(BUILDER_DIR, 'lib', 'creative-editor.js')) && fs.existsSync(path.join(BUILDER_DIR, 'node_modules', 'express'));
const skip = usable ? false : 'set SITEREMADE_BUILDER_DIR to a SiteRemade builder checkout with the Creative website editor (lib/creative-editor.js) and node_modules';
const sleep = ms => new Promise(r => setTimeout(r, ms));
// a picture the way the app's browser sends it: converted to PNG
function png(w, h) {
  const T = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
  const crc = b => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  const raw = crypto.randomBytes((w * 3 + 1) * h); for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

test('the Website editor, real builder: a Business website keeps its update flow; a purchased Creative website opens in the same Website view and is edited as Creative -- text, picture, 3D, cinematic motion -- as drafts, published, previewed and exported; another business can do none of it', { skip, timeout: 600000 }, async () => {
  const { startServer, providerCalls } = require(path.join(BUILDER_DIR, 'test', 'helpers', 'server-process.js'));
  const S = require(path.join(BUILDER_DIR, 'test', 'helpers', 'three-d-scenario.js'));
  const { loadClient, premiumProviderStatus, buildProject } = require(path.join(BUILDER_DIR, 'test', 'helpers', 'load-client.js'));
  const projectStore = require(path.join(BUILDER_DIR, 'lib', 'project-store.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-app-editor-e2e-'));
  const env = S.threeDEnv(dir, { SITEREMADE_TRIAL_CREDITS: '200', MOCK_TRIPO: 'alternate', MOCK_CREATIVE_REVISE: 'words', HIGGSFIELD_VIDEO_ENDPOINT: 'kling-video/v3.0/4k/image-to-video', SITEREMADE_RATE_LIMIT_APP_BRIDGE_ACCOUNT_MAX: '100000', MOCK_REFINEMENT_COPY: 'Fresh flowers, arranged daily' });
  const builder = await startServer(env); let app = null;
  const paid = () => { const c = providerCalls(env.MOCK_CALL_LOG); return { tripo: c.filter(x => x.provider === 'tripo' && x.endpoint === 'submit').length, higgsfield: c.filter(x => x.provider === 'higgsfield' && /image-to-video$/.test(x.endpoint || '')).length, refinement: c.filter(x => x.provider === 'anthropic' && x.tool === 'submit_website_refinement').length, openai: c.filter(x => x.provider === 'openai').length }; };
  try {
    const sc = await S.buildThreeDScenario({ port: builder.port, env }); const creativeId = sc.projectId;
    // a purchased Business website of the same person (the builder's own Business fixture)
    const { client } = require(path.join(BUILDER_DIR, 'test', 'helpers', 'server-process.js')); const call = client(builder.port);
    await call('POST', '/api/identity/supabase/session', { supabaseAccessToken: 'test-access-token-owner' });
    const { proj } = buildProject(loadClient(), 'Petal & Stem is a florist in Portland. Call 503-555-0147.', { providerStatus: premiumProviderStatus() });
    const biz = projectStore.validateDirectionsState({ directions: [JSON.parse(JSON.stringify(proj))], activeDirectionIndex: 0 }).normalized.directions[0];
    const businessId = (await call('POST', '/api/projects', { name: 'Petal & Stem', directionsState: { directions: [biz], activeDirectionIndex: 0 } })).body.project.id;
    // (both websites connected to the owner's business -- the app's own link table)
    const link = id => ({ id: 'l_' + id.slice(-8), workspace_id: 'ws_aurelia', generator_project_id: id, status: 'linked', linked_at: new Date().toISOString(), linked_by: 'u_owner' });
    app = await startApp({ seed: { website_project_links: [link(creativeId), link(businessId)], workspace_members: [], audit_logs: [] }, builderUrl: `http://127.0.0.1:${builder.port}`,
      people: {
        owner: { userId: 'u_owner', access: 'test-access-token-owner', email: 'bridge-test@example.com', workspaces: [{ id: 'ws_aurelia', business_name: 'Aurelia Tonic' }] },
        other: { userId: 'u_other', access: 'test-access-token-other', email: 'other-owner@example.com', workspaces: [{ id: 'ws_other', business_name: 'Someone else' }] },
      } });
    const P = id => `/api/app/website/projects/${id}`;

    // ---- 1 / 12. the Business website: kind business, its update flow unchanged (quote -> approve -> the Business planner)
    const bs = await app.call('owner', 'GET', P(businessId)); assert.equal(bs.status, 200, JSON.stringify(bs.body)); assert.equal(bs.body.kind, 'business');
    assert.equal((await app.call('owner', 'GET', P(businessId) + '/creative')).status, 409, 'a Business website is not opened in the Creative editor');
    const bq = await app.call('owner', 'POST', '/api/app/website/quote', { request: 'Change the headline to "Fresh flowers, arranged daily"', projectId: businessId });
    assert.equal(bq.status, 200, JSON.stringify(bq.body));
    const be = await app.call('owner', 'POST', P(businessId) + '/edits', { baseRevision: bs.body.revision, request: 'Change the headline to "Fresh flowers, arranged daily"', quoteId: bq.body.quote.id, requestId: 'biz-edit-0001' });
    assert.equal(be.status, 200, JSON.stringify(be.body)); assert.equal(be.body.mode, 'surgical'); assert.equal(paid().refinement, 1, 'the Business planner made the Business change');

    // ---- 2. the Creative website reports kind creative, and opens in the same Website view
    const cs = await app.call('owner', 'GET', P(creativeId)); assert.equal(cs.body.kind, 'creative');
    let o = await app.call('owner', 'GET', P(creativeId) + '/creative'); assert.equal(o.status, 200, JSON.stringify(o.body));
    assert.ok(o.body.outline.scenes.length >= 3 && o.body.outline.models.length === 1 && o.body.outline.look);
    assert.doesNotMatch(JSON.stringify(o.body), /data:image|assetRef|[a-f0-9]{64}|providerJobId/, 'only what the editor needs');
    const creditsAt = async () => (await app.call('owner', 'GET', '/api/app/website/credits')).body.credits.remaining;

    // ---- 3. a Creative text edit: the real scene, 0 credits, no provider
    const before = paid(); const c0 = await creditsAt(); const scene = o.body.outline.scenes[1];
    let r = await app.call('owner', 'POST', P(creativeId) + '/creative/edit', { baseRevision: o.body.revision, op: { type: 'text', sceneId: scene.id, field: 'heading', value: 'Small batches, big taste' } });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.creditsCharged, 0); assert.equal(await creditsAt(), c0); assert.deepEqual(paid(), before);
    const stored = async () => (await call('GET', `/api/projects/${creativeId}`)).body.project.directionsState.directions[0].creative;
    assert.equal((await stored()).plan.scenes.find(s => s.id === scene.id).text.heading, 'Small batches, big taste', 'the Creative structure itself');
    // ---- 9 / 18. reload: the draft is there; the published website is not changed until Publish
    o = await app.call('owner', 'GET', P(creativeId) + '/creative'); assert.equal(o.body.outline.scenes[1].text.heading, 'Small batches, big taste');
    assert.match((await app.call('owner', 'GET', P(creativeId) + '/preview?source=draft')).buf.toString('utf8'), /Small batches, big taste/);
    assert.doesNotMatch((await app.call('owner', 'GET', P(creativeId) + '/preview')).buf.toString('utf8'), /Small batches, big taste/, 'published unchanged');
    assert.equal((await app.call('owner', 'GET', P(creativeId))).body.hasUnpublishedChanges, true, 'the Website view shows a draft');

    // ---- 4. an image swap through an upload: converted to PNG by the browser, measured by the builder, the owner's upload
    const pic = o.body.outline.scenes.flatMap(s => s.pictures.map(p => ({ s, p }))).find(x => x.p.source.kind === 'upload');
    r = await app.call('owner', 'POST', P(creativeId) + '/creative/upload', { baseRevision: o.body.revision, png: png(1600, 1000), title: 'Bottles on the bar', sceneId: pic.s.id, layerId: pic.p.layerId });
    assert.equal(r.status, 200, JSON.stringify(r.body)); const upId = r.body.assetId;
    const up = (await stored()).assets.find(a => a.id === upId); assert.deepEqual([up.origin, up.ownerAffirmed, up.assess.width, up.assess.height], ['upload', true, 1600, 1000], 'provenance and measurement are the builder\'s');
    // ---- 5. the existing 3D model survived the unrelated edits
    assert.equal((await stored()).threeD.assets.length, 1);

    // ---- 7. a new interactive 3D model from the app: quote -> confirm -> exactly one mocked Tripo submission
    let q = await app.call('owner', 'POST', P(creativeId) + '/creative/quote', { action: 'model3d', assetId: upId });
    assert.equal(q.status, 200, JSON.stringify(q.body)); assert.ok(q.body.quote.credits > 0); const t0 = paid().tripo;
    let st = await app.call('owner', 'POST', P(creativeId) + '/creative/start', { quoteId: q.body.quote.id });
    const st2 = await app.call('owner', 'POST', P(creativeId) + '/creative/start', { quoteId: q.body.quote.id }); assert.equal(st2.body.job.jobId, st.body.job.jobId, 'a double click is the same job');
    for (let i = 0; i < 300; i++) { const j = await app.call('owner', 'GET', P(creativeId) + '/creative/jobs'); if (j.body.jobs.some(x => x.jobId === st.body.job.jobId && x.terminal)) break; await sleep(150); }
    assert.equal(paid().tripo, t0 + 1); assert.equal((await stored()).threeD.assets.length, 2, 'attached to the draft');

    // ---- 8 / 6. new cinematic motion from the app: exactly one mocked Higgsfield submission, attached to that picture
    q = await app.call('owner', 'POST', P(creativeId) + '/creative/quote', { action: 'motion', assetId: upId, sceneId: pic.s.id, layerId: pic.p.layerId });
    assert.equal(q.status, 200, JSON.stringify(q.body)); assert.equal(q.body.quote.credits, 12, 'the builder\'s price for one clip'); const h0 = paid().higgsfield;
    const starts = await Promise.all([1, 2].map(() => app.call('owner', 'POST', P(creativeId) + '/creative/start', { quoteId: q.body.quote.id })));
    assert.equal(starts[0].body.job.jobId, starts[1].body.job.jobId);
    for (let i = 0; i < 300; i++) { const j = await app.call('owner', 'GET', P(creativeId) + '/creative/jobs'); if (j.body.jobs.some(x => x.jobId === starts[0].body.job.jobId && x.terminal)) break; await sleep(150); }
    assert.equal(paid().higgsfield, h0 + 1, 'exactly one');
    const clip = (await stored()).assets.find(a => a.id === upId).video; assert.ok(clip && clip.mediaId);
    // an unrelated Creative edit keeps the clip and both 3D models
    o = await app.call('owner', 'GET', P(creativeId) + '/creative');
    r = await app.call('owner', 'POST', P(creativeId) + '/creative/edit', { baseRevision: o.body.revision, op: { type: 'colour', sceneId: o.body.outline.scenes[2].id, role: o.body.outline.palette[1].role } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after = await stored(); assert.equal(after.assets.find(a => a.id === upId).video.mediaId, clip.mediaId); assert.equal(after.threeD.assets.length, 2); assert.ok(after.plan.look, 'plan.look survives');

    // ---- 17. another business (and another builder account) can do none of it
    for (const [m, u, b] of [['GET', '/creative'], ['POST', '/creative/edit', { baseRevision: 1, op: { type: 'reapply-look' } }], ['POST', '/creative/upload', { baseRevision: 1, png: png(64, 64) }],
      ['POST', '/creative/quote', { action: 'motion', assetId: upId }], ['POST', '/creative/start', { quoteId: q.body.quote.id }], ['GET', '/creative/jobs'], ['POST', '/publish', { revision: 1 }]]) {
      const x = await app.call('other', m, P(creativeId) + u, b); assert.equal(x.status, 404, `${m} ${u}: ${x.status}`);
    }

    // ---- 10 / 11. publish: the published website, its preview and its download carry every change -- 3D and clip included
    const now = await app.call('owner', 'GET', P(creativeId));
    const pub = await app.call('owner', 'POST', P(creativeId) + '/publish', { revision: now.body.revision }); assert.equal(pub.status, 200, JSON.stringify(pub.body));
    const live = (await app.call('owner', 'GET', P(creativeId) + '/preview')).buf.toString('utf8');
    assert.match(live, /Small batches, big taste/); assert.equal(S.pageData(live).scenes.length >= 1, true, 'the 3D stage is in the published preview');
    const zip = await app.call('owner', 'GET', P(creativeId) + '/download'); assert.equal(zip.status, 200);
    const { readZip } = require(path.join(BUILDER_DIR, 'test', 'helpers', 'showcase-purchase.js')); const files = readZip(zip.buf);
    assert.ok([...files.keys()].some(k => /\.glb$/.test(k)) && [...files.keys()].some(k => /\.mp4$/.test(k)) && files.get('assets/sr3d.min.js'), 'the export ships the models, the clip and the engine');
    assert.equal(paid().openai, 0);
  } finally { if (app) await app.stop(); await builder.stop(); }
});
