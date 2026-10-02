'use strict';
// THE WEBSITE PREVIEW'S SECURITY POLICY lets a Creative page's 3D model run -- and still lets nothing reach the network.
// The builder sends the preview as one self-contained page: scripts inline, every file inlined as a data: URL. On a
// Creative page with an interactive 3D model, its loader adds the 3D engine as <script src="data:..."> and the engine
// fetch()es the model from its data: URL, then decodes the textures inside it through blob: URLs. Production bug
// (proj_SpjNHOX-b8B3yRDH67EUILO2): this app sent "script-src 'unsafe-inline'; connect-src 'none'", the browser refused the
// engine (script-src-elem data:), the page fell back to its picture, and the 3D model was "completely missing" in the
// app's preview and its "Preview" link -- while the builder's studio, its own preview and the ZIP showed it.
// Checked against a real browser by test/review/creative-3d-preview.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app-harness');
const { startFixtureBuilder } = require('./helpers/fixture-builder');
const CSP = require('./helpers/csp');

const SHOW = 'proj_SpjNHOXb8B3yRDH67EUILO2';
const PEOPLE = { alice: { userId: 'u_alice', access: 'tok-alice', workspaces: [{ id: 'ws_alice', business_name: 'Aurelia Tonic' }] } };
const project = { projectId: SHOW, name: 'Aurelia Tonic', mode: 'creative', status: 'purchased', revision: 3, purchaseRef: 'SR-3D', purchasedAt: '2026-10-02T10:00:00.000Z', purchasedRevision: 2, publishedRevision: 3, createdAt: '2026-10-02T09:00:00.000Z', updatedAt: '2026-10-02T11:00:00.000Z' };
// every route that serves a preview page (the Website view's frame, its project-scoped variant, the Saved Websites link)
const ROUTES = ['/api/app/website/preview', `/api/app/website/projects/${SHOW}/preview`, `/api/app/websites/${SHOW}/preview?source=published`, `/api/app/websites/${SHOW}/preview`];
// what the 3D page asks its browser for, exactly as the builder's preview does it (lib/creative/three-d.js LOADER +
// lib/three-d/runtime-src.js), and what must stay impossible
const NEEDS = [
  ['script-src-elem', 'inline', 'the page\'s own inline scripts (its motion, the 3D loader)'],
  ['script-src-elem', 'data:text/javascript;base64,LyogZW5naW5lICov', 'the 3D engine, inlined as a data: script'],
  ['script-src-elem', 'data:application/octet-stream;base64,LyogZW5naW5lICov', '(as the builder labels it today)'],
  ['connect-src', 'data:application/octet-stream;base64,Z2xURgIAAAA=', 'the GLB, fetched from its data: URL'],
  ['connect-src', 'blob:https://app.siteremade.com/2f6d8f0e-7c3a-4b0b-9d1e-6a1c2b3d4e5f', 'the textures inside the GLB, decoded through blob: URLs'],
  ['img-src', 'data:image/png;base64,iVBORw0KGgo=', 'the page\'s pictures and the 3D model\'s fallback picture'],
];
const NEVER = [
  ['connect-src', 'https://www.siteremade.com/api/projects', 'the builder'], ['connect-src', 'https://app.siteremade.com/api/app/website', 'this app\'s own API (same origin)'],
  ['connect-src', 'https://evil.example/collect', 'any other host'], ['script-src-elem', 'https://cdn.example/x.js', 'a script from any host'],
  ['script-src-elem', 'https://app.siteremade.com/app.js', 'a script from this app'],
];
const ORIGIN = 'https://app.siteremade.com';

async function world() {
  const builder = await startFixtureBuilder({ 'tok-alice': { projects: [project] } });
  const app = await startApp({ seed: { website_project_links: [], workspace_members: [] }, people: PEOPLE, builderUrl: builder.url });
  // (the sole business connects its purchased website itself, as on the first visit)
  assert.equal((await app.call('alice', 'GET', '/api/app/websites')).status, 200);
  return { builder, app, stop: async () => { await app.stop(); await builder.stop(); } };
}

test('every preview route sends ONE policy, and it lets a Creative page\'s 3D engine and model load -- the production policy did not', async () => {
  const w = await world();
  try {
    const policies = [];
    for (const url of ROUTES) {
      const r = await w.app.call('alice', 'GET', url); assert.equal(r.status, 200, `${url}: ${r.buf.toString().slice(0, 160)}`);
      assert.match(r.headers.get('content-type'), /^text\/html/); policies.push(r.headers.get('content-security-policy'));
    }
    assert.equal(new Set(policies).size, 1, 'one policy for every preview'); const policy = policies[0]; assert.ok(policy);
    for (const [d, url, what] of NEEDS) assert.equal(CSP.allows(policy, d, url, ORIGIN), true, `${what} must be allowed (${d})`);
    for (const [d, url, what] of NEVER) assert.equal(CSP.allows(policy, d, url, ORIGIN), false, `${what} must stay blocked (${d})`);
    // nothing else was opened up: no frames of it elsewhere, no forms, no plugins of the old kind
    const p = CSP.parse(policy);
    assert.deepEqual(p['frame-ancestors'], ["'self'"]); assert.deepEqual(p['form-action'], ["'none'"]); assert.deepEqual(p['connect-src'], ['data:', 'blob:']);
    assert.ok(!p['script-src'].includes("'unsafe-eval'") && !p['script-src'].includes('https:') && !p['script-src'].includes("'self'") && !p['script-src'].includes('*'));
  } finally { await w.stop(); }
});

test('the policy production sent is the bug: its own reading refuses the 3D engine and the model (this test is what would have caught it)', () => {
  const PRODUCTION = "default-src 'self' data: blob: https:; img-src 'self' data: blob: https:; style-src 'unsafe-inline' https:; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-ancestors 'self'";
  assert.equal(CSP.allows(PRODUCTION, 'script-src-elem', 'inline', ORIGIN), true, '(the page\'s inline scripts ran -- which is why only the 3D was missing)');
  assert.equal(CSP.allows(PRODUCTION, 'script-src-elem', NEEDS[1][1], ORIGIN), false, 'the engine was refused');
  assert.equal(CSP.allows(PRODUCTION, 'connect-src', NEEDS[3][1], ORIGIN), false, 'and so was the model');
  assert.equal(CSP.allows(PRODUCTION, 'connect-src', NEEDS[4][1], ORIGIN), false, 'and its textures');
  // (the reader itself: fallback to default-src, 'none', scheme and host sources)
  assert.equal(CSP.allows("default-src https:", 'connect-src', 'https://a.example/x', ORIGIN), true);
  assert.equal(CSP.allows("default-src https:", 'script-src-elem', 'data:x', ORIGIN), false);
  assert.equal(CSP.allows("script-src 'self'", 'script-src-elem', 'https://app.siteremade.com/a.js', ORIGIN), true);
  assert.equal(CSP.allows("connect-src *.example.com", 'connect-src', 'https://a.example.com/', ORIGIN), true);
});
