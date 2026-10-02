'use strict';
// A CREATIVE PAGE WITH AN INTERACTIVE 3D MODEL, through the app, both real servers: the builder's own server.js (from
// SITEREMADE_BUILDER_DIR; its test helper test/helpers/three-d-scenario.js makes the page as the owner does -- a 3D model
// made by its durable job, Tripo answered by a fake, saved BY REFERENCE, purchased with a mocked Stripe, published) and
// this app's real website routes. Every preview route must hand the browser that page with its 3D scene, its 3D engine
// and the very model the job stored -- under a policy that lets them load (test/helpers/csp.js; the browser itself:
// test/review/creative-3d-preview.js). $0 provider spend.
// Skipped (with the reason) unless SITEREMADE_BUILDER_DIR points at a builder checkout with its dependencies installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startApp } = require('./helpers/app-harness');
const CSP = require('./helpers/csp');

const BUILDER_DIR = process.env.SITEREMADE_BUILDER_DIR || '';
const usable = BUILDER_DIR && fs.existsSync(path.join(BUILDER_DIR, 'test', 'helpers', 'three-d-scenario.js')) && fs.existsSync(path.join(BUILDER_DIR, 'node_modules', 'express'));
const skip = usable ? false : 'set SITEREMADE_BUILDER_DIR to a SiteRemade builder checkout (with test/helpers/three-d-scenario.js and node_modules) to run the cross-repo 3D preview';

test('the real builder\'s 3D page, previewed through every app route: its scene, its engine and its stored model arrive, and the policy lets them run; nothing is generated again', { skip, timeout: 240000 }, async () => {
  const { startServer } = require(path.join(BUILDER_DIR, 'test', 'helpers', 'server-process.js'));
  const S = require(path.join(BUILDER_DIR, 'test', 'helpers', 'three-d-scenario.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-app-3d-preview-'));
  const env = S.threeDEnv(dir); const builder = await startServer(env);
  const realFetch = globalThis.fetch; const hosts = new Set();
  globalThis.fetch = (url, opts) => { hosts.add(new URL(String(url)).hostname); return realFetch(url, opts); };
  let app = null;
  try {
    const s = await S.buildThreeDScenario({ port: builder.port, env });
    app = await startApp({ seed: { website_project_links: [], workspace_members: [] }, builderUrl: `http://127.0.0.1:${builder.port}`,
      people: { owner: { userId: 'u_owner', access: 'test-access-token-owner', workspaces: [{ id: 'ws_aurelia', business_name: 'Aurelia Tonic' }] } } });
    assert.equal((await app.call('owner', 'GET', '/api/app/websites')).status, 200); // (connects the sole business's website)
    const routes = ['/api/app/website/preview', `/api/app/website/projects/${s.projectId}/preview`, `/api/app/websites/${s.projectId}/preview?source=published`, `/api/app/websites/${s.projectId}/preview`];
    for (const url of routes) {
      const r = await app.call('owner', 'GET', url); assert.equal(r.status, 200, `${url}: ${r.buf.toString().slice(0, 200)}`);
      const html = r.buf.toString('utf8'); const data = S.pageData(html); const policy = r.headers.get('content-security-policy');
      assert.ok(data, `${url}: the page carries its 3D scene data`); assert.equal(data.scenes.length, 1, url);
      assert.match(html, new RegExp(`<div class="td-stage" data-td="${data.scenes[0].id}" data-td-comp="scroll-rotate"`), `${url}: and its 3D stage`);
      assert.match(html, /__sr3d/, `${url}: and the 3D loader`);
      // the engine and the model, inlined -- the model is byte for byte the one the job stored (its reference)
      assert.match(data.runtime, /^data:[\w/.+-]+;base64,/); assert.match(Buffer.from(data.runtime.split(',')[1], 'base64').toString('utf8', 0, 40), /^\/\*! SiteRemade 3D engine/, `${url}: the engine`);
      const model = Buffer.from(data.scenes[0].model.split(',')[1], 'base64'); assert.equal(crypto.createHash('sha256').update(model).digest('hex'), s.assetRef, `${url}: the stored model`);
      // and the policy this page runs under lets the browser load both (and still nothing from the network)
      assert.equal(CSP.allows(policy, 'script-src-elem', data.runtime.slice(0, 80), app.base), true, `${url}: the engine may run`);
      assert.equal(CSP.allows(policy, 'connect-src', data.scenes[0].model.slice(0, 80), app.base), true, `${url}: the model may be read`);
      assert.equal(CSP.allows(policy, 'connect-src', `blob:${app.base}/x`, app.base), true, `${url}: its textures may be decoded`);
      assert.equal(CSP.allows(policy, 'connect-src', `${app.base}/api/app/website`, app.base), false, `${url}: no network`);
    }
    // previewing made nothing: one Tripo submission (when the model was made), no other paid provider
    const calls = fs.readFileSync(env.MOCK_CALL_LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(calls.filter(c => c.provider === 'tripo' && c.endpoint === 'submit').length, 1);
    assert.deepEqual(calls.filter(c => ['anthropic', 'openai', 'higgsfield', 'serpapi'].includes(c.provider)), []);
    assert.deepEqual([...hosts], ['127.0.0.1'], 'the app only ever talked to the local test servers');
  } finally {
    globalThis.fetch = realFetch;
    if (app) await app.stop();
    await builder.stop(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
