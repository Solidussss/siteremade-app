'use strict';
// THE WEBSITE EDITOR in the Client App: the Website view knows a website's KIND from the builder (never a guess), opens a
// Creative website in its Creative editor and a Business website in its update flow -- and the app stays only the
// control surface: it checks the person and the business's link to the website, forwards the request with the person's
// own token, and passes back an explicit allowlist. The builder here is test/helpers/fixture-builder.js (its Creative
// stand-in deliberately carries private fields the app must drop); the real builder: test/website-editor-e2e.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startApp } = require('./helpers/app-harness');
const { startFixtureBuilder } = require('./helpers/fixture-builder');

const CREATIVE = 'proj_CREATIVEaaaaaaaaaaaaaaa', BUSINESS = 'proj_BUSINESSbbbbbbbbbbbbbb', UNLINKED = 'proj_UNLINKEDccccccccccccccc';
const site = (projectId, mode) => ({ projectId, name: mode === 'creative' ? 'Kolaro' : 'Petal & Stem', mode, status: 'purchased', revision: 4, createdAt: '2026-09-20T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z', purchaseRef: 'SR-1', purchasedAt: '2026-09-21T10:00:00.000Z', purchasedRevision: 3, publishedRevision: 3 });
const PEOPLE = {
  owner: { userId: 'u_owner', access: 'tok-owner', workspaces: [{ id: 'ws_one', business_name: 'Kolaro' }] },
  other: { userId: 'u_other', access: 'tok-other', workspaces: [{ id: 'ws_two', business_name: 'Elsewhere' }] },
};
const link = (wid, id) => ({ id: 'l_' + id.slice(-6), workspace_id: wid, generator_project_id: id, status: 'linked', linked_at: '2026-10-01T10:00:00.000Z', linked_by: 'u_owner' });
async function world() {
  const builder = await startFixtureBuilder({ 'tok-owner': { projects: [site(CREATIVE, 'creative'), site(BUSINESS, 'business'), site(UNLINKED, 'creative')] }, 'tok-other': { projects: [] } });
  const app = await startApp({ seed: { website_project_links: [link('ws_one', CREATIVE), link('ws_one', BUSINESS)], workspace_members: [], audit_logs: [] }, people: PEOPLE, builderUrl: builder.url });
  return { builder, app, stop: async () => { await app.stop(); await builder.stop(); } };
}
const P = id => `/api/app/website/projects/${id}`;

test('the website kind comes from the builder: creative for a Creative website, business for a Business one -- and only a Creative website opens in the Creative editor', async () => {
  const w = await world();
  try {
    assert.equal((await w.app.call('owner', 'GET', P(CREATIVE))).body.kind, 'creative');
    assert.equal((await w.app.call('owner', 'GET', P(BUSINESS))).body.kind, 'business');
    const biz = await w.app.call('owner', 'GET', P(BUSINESS) + '/creative'); assert.equal(biz.status, 409); assert.equal(biz.body.code, 'not_creative');
  } finally { await w.stop(); }
});

test('the editable outline passes through an allowlist: scenes, words, pictures and where they came from, actions -- never a private field, picture bytes, a stored reference or a provider id', async () => {
  const w = await world();
  try {
    const r = await w.app.call('owner', 'GET', P(CREATIVE) + '/creative'); assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.kind, 'creative'); assert.equal(r.body.outline.scenes[0].text.heading, 'Kolaro');
    assert.deepEqual(r.body.outline.scenes[0].pictures[0].source, { kind: 'upload', rootId: 'u1', title: 'Can', cutout: false, author: '', license: '', pageUrl: '' });
    assert.deepEqual(r.body.outline.scenes[0].pictures[0].actions, ['replace', 'motion']);
    assert.doesNotMatch(r.buf.toString('utf8'), /sk_live|secretNote|internal|data:image|assetRef|ffffffffff|providerJobId|tripo-task/);
    assert.equal(w.builder.seen.filter(x => /\/creative$/.test(x.url))[0].token, 'tok-owner', 'the person\'s own token');
  } finally { await w.stop(); }
});

test('a website this business has not connected, or another business, gets nothing -- and the builder is never asked for its Creative page', async () => {
  const w = await world();
  try {
    const before = w.builder.seen.length;
    for (const [as, id] of [['owner', UNLINKED], ['other', CREATIVE]]) {
      for (const [m, u, b] of [['GET', '/creative'], ['POST', '/creative/edit', { baseRevision: 4, op: { type: 'reapply-look' } }], ['POST', '/creative/quote', { action: 'motion' }], ['POST', '/creative/start', { quoteId: 'q_x' }], ['GET', '/creative/jobs'], ['GET', '/creative/still']]) {
        const r = await w.app.call(as, m, P(id) + u, b); assert.equal(r.status, 404, `${as} ${m} ${u}: ${r.status}`);
      }
    }
    assert.equal(w.builder.seen.slice(before).filter(x => /\/creative/.test(x.url)).length, 0, 'no Creative call reached the builder');
  } finally { await w.stop(); }
});

test('a change carries only the editor\'s own fields -- no CSS, no plan, no state slips through to the builder -- and a quote never shows its internal source or ceiling', async () => {
  const w = await world();
  try {
    const r = await w.app.call('owner', 'POST', P(CREATIVE) + '/creative/edit', { baseRevision: 4, op: { type: 'colour', sceneId: 'opening', role: 'primary', css: 'body{background:red}', plan: { scenes: [] }, distance: 1.4, value: 'x'.repeat(2000) }, directionsState: { evil: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual([r.body.revision, r.body.creditsCharged], [5, 0]); assert.equal(r.body.internal, undefined);
    const sent = w.builder.seen.find(x => /\/creative\/edit$/.test(x.url)).body;
    assert.deepEqual(Object.keys(sent).sort(), ['baseRevision', 'op']); assert.deepEqual(Object.keys(sent.op).sort(), ['distance', 'role', 'sceneId', 'type', 'value']);
    assert.equal(sent.op.value.length, 600, 'bounded');
    const q = await w.app.call('owner', 'POST', P(CREATIVE) + '/creative/quote', { action: 'motion', assetId: 'u1', sceneId: 'opening', layerId: 'l1' });
    assert.equal(q.body.quote.credits, 12, 'the builder\'s price, as quoted'); assert.doesNotMatch(q.buf.toString('utf8'), /ceilingUsd|ffffffff|"source"/);
    // the edit needs a revision; an upload must be a PNG made by the browser
    assert.equal((await w.app.call('owner', 'POST', P(CREATIVE) + '/creative/edit', { op: { type: 'reapply-look' } })).status, 400);
    assert.equal((await w.app.call('owner', 'POST', P(CREATIVE) + '/creative/upload', { baseRevision: 4, png: 'data:image/jpeg;base64,/9j/' })).status, 400);
  } finally { await w.stop(); }
});

test('the Website view: one Creative editor section next to the Business update box, its script loaded after app.js, its controls touch-sized and never wider than the screen', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /<section class="site-editor creative-editor" id="creativeEditor" hidden/); assert.match(html, /id="siteEditor"/, 'the Business update box stays');
  assert.ok(html.indexOf('<script src="website-creative-editor.js') > html.indexOf('<script src="app.js?'), 'loaded after app.js');
  const css = fs.readFileSync(path.join(__dirname, '..', 'website-creative-editor.css'), 'utf8');
  for (const sel of ['.ce-scene', '.ce-item', '.ce-btn', '.ce-swatch']) assert.match(css, new RegExp(sel.replace('.', '\\.') + '\\{[^}]*(min-height:44px|height:44px)'), `${sel} is finger-sized`);
  assert.match(css, /\.ce-scenes\{[^}]*overflow-x:auto[^}]*max-width:100%/, 'the scene list scrolls inside itself, never the page');
  assert.match(css, /\.ce-row\{[^}]*flex-wrap:wrap/); assert.doesNotMatch(css, /width:\s*\d{4,}px/);
  const js = fs.readFileSync(path.join(__dirname, '..', 'website-creative-editor.js'), 'utf8');
  assert.doesNotMatch(js, /credits?\s*[:=]\s*(12|3)\b|\b12 credits|\b3 credits/, 'no price of the app\'s own: every cost shown is the builder\'s quote');
  assert.match(js, /toDataURL\('image\/png'\)/, 'an upload is converted to PNG in the browser');
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(app, /window\.CreativeEditor\.render\(c\)/, 'the Website view hands the website to the Creative editor');
});

test('Fix text layout: a free change of the selected scene -- the op reaches the builder with only the editor fields (no CSS), what was re-set comes back bounded, "already fit" saves nothing, and the button sits with the Words', async () => {
  const w = await world();
  try {
    const r = await w.app.call('owner', 'POST', P(CREATIVE) + '/creative/edit', { baseRevision: 4, op: { type: 'text-layout', sceneId: 'scene-2', css: 'h1{font-size:9px}', value: 'new words' } });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual([r.body.revision, r.body.creditsCharged, r.body.unchanged], [5, 0, false]);
    assert.deepEqual(Object.keys(w.builder.seen.filter(x => /\/creative\/edit$/.test(x.url)).pop().body.op).sort(), ['sceneId', 'type', 'value'], 'no CSS slips through');
    assert.equal(r.body.fitted.length, 2); assert.equal(r.body.fitted[1].length, 200, 'bounded'); assert.equal(r.body.internal, undefined);
    const same = await w.app.call('owner', 'POST', P(CREATIVE) + '/creative/edit', { baseRevision: 4, op: { type: 'text-layout', sceneId: 'opening' } });
    assert.deepEqual([same.body.unchanged, same.body.revision, same.body.creditsCharged], [true, 4, 0]);
    // another business: nothing reaches the builder
    const before = w.builder.seen.length;
    assert.equal((await w.app.call('other', 'POST', P(CREATIVE) + '/creative/edit', { baseRevision: 4, op: { type: 'text-layout', sceneId: 'opening' } })).status, 404);
    assert.equal(w.builder.seen.length, before);
  } finally { await w.stop(); }
  const js = fs.readFileSync(path.join(__dirname, '..', 'website-creative-editor.js'), 'utf8');
  assert.match(js, /data-op="text-layout">Fix text layout — free<\/button>/, 'the button, with its cost (free) beside it');
  assert.match(js, /indexOf\('text-layout'\) >= 0/, 'only where the builder offers it (a scene with words)');
  assert.match(js, /op === 'text-layout'\) return edit\(\{ type: 'text-layout', sceneId: s\.id \}\)/, 'a free edit of the selected scene -- no quote');
  assert.match(js, /r\.body\.unchanged\)[^\n]*Nothing was saved/, '"already fit" says nothing was saved');
});
