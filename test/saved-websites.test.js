'use strict';
// SAVED WEBSITES in the Client App: every website saved to the customer's SiteRemade account -- drafts and owned --
// reaches the Website view (lib/generator-bridge.js getWebsites -> GET /api/app/websites, lib/saved-websites.js), and
// the list shows a saved draft and a purchased website as the different things they are (saved-websites-view.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bridge = require('../lib/generator-bridge');
const { savedWebsitesFrom } = require('../lib/saved-websites');
const view = require('../saved-websites-view');

const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const DRAFT = { projectId: 'proj_DRAFTaaaaaaaaaaaaaaaaaa', name: 'Petal & Stem', businessName: 'Petal & Stem', mode: 'business', status: 'draft', revision: 3, createdAt: '2026-09-20T10:00:00.000Z', updatedAt: '2026-09-29T10:00:00.000Z', isPurchased: false, purchaseRef: null, purchasedAt: null, purchasedRevision: null, hasPurchaseSnapshot: false, canEdit: true, canPublish: false, hasUnpublishedChanges: false };
const CREATIVE_DRAFT = { ...DRAFT, projectId: 'proj_CREATIVEaaaaaaaaaaaaaaa', name: 'A page about kayaks', businessName: null, mode: 'creative', updatedAt: '2026-09-30T09:00:00.000Z' };
const OWNED = { ...DRAFT, projectId: 'proj_OWNEDaaaaaaaaaaaaaaaaa', name: 'Summit Roofing', businessName: 'Summit Roofing', status: 'purchased', isPurchased: true, purchaseRef: 'SR-123', purchasedAt: '2026-09-10T12:00:00.000Z', purchasedRevision: 2, hasPurchaseSnapshot: true, canPublish: true, updatedAt: '2026-09-15T08:00:00.000Z' };

test('the app asks the builder for EVERY saved website with the customer\'s own token', async () => {
  const seen = [];
  const builder = http.createServer((req, res) => { seen.push({ url: req.url, auth: req.headers.authorization }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, websites: [DRAFT, OWNED] })); });
  const port = await listen(builder); process.env.WEBSITE_BUILDER_URL = `http://127.0.0.1:${port}`;
  try {
    const r = await bridge.getWebsites('user-access-token');
    assert.equal(r.status, 200); assert.equal(r.data.websites.length, 2);
    assert.deepEqual(seen, [{ url: '/api/app-bridge/websites', auth: 'Bearer user-access-token' }]);
  } finally { await new Promise(r => builder.close(r)); }
});

test('the list is metadata only, newest first, never marks a draft as owned, and knows which websites are connected here', () => {
  const list = savedWebsitesFrom([OWNED, DRAFT, CREATIVE_DRAFT, { ...DRAFT, projectId: 'proj_FAKEOWNEDaaaaaaaaaaaaaa', isPurchased: true, status: 'draft' }, { directionsState: {} }], new Set([OWNED.projectId]));
  assert.deepEqual(list.map(w => w.projectId), [CREATIVE_DRAFT.projectId, DRAFT.projectId, 'proj_FAKEOWNEDaaaaaaaaaaaaaa', OWNED.projectId]);
  assert.equal(list.find(w => w.projectId === 'proj_FAKEOWNEDaaaaaaaaaaaaaa').isPurchased, false, 'a draft is never owned, whatever a flag says');
  assert.equal(list.find(w => w.projectId === OWNED.projectId).linked, true); assert.equal(list.find(w => w.projectId === DRAFT.projectId).linked, false);
  assert.equal(list[0].mode, 'creative');
  assert.ok(list.every(w => !('directionsState' in w) && !('purchaseRef' in w)), 'only what the list shows');
});

test('15. a Draft row and an Owned row render as the different things they are', () => {
  const [draft, owned] = savedWebsitesFrom([DRAFT, OWNED], new Set());
  const d = view.rowHtml(draft), o = view.rowHtml(owned);
  // Draft: name, Draft badge, Business, last updated, preview + continue in the builder -- nothing that implies ownership
  assert.match(d, /Petal &amp; Stem/); assert.match(d, /chip-neutral">Draft</); assert.match(d, /Business website/); assert.match(d, /Updated Sep 29, 2026/);
  assert.match(d, /href="\/api\/app\/websites\/proj_DRAFTaaaaaaaaaaaaaaaaaa\/preview">Preview draft/); assert.match(d, /href="\/handoff\/website-builder\?project=proj_DRAFTaaaaaaaaaaaaaaaaaa">Continue in the builder/, 'the link names this draft');
  assert.match(d, /not purchased yet/);
  assert.ok(!/Owned|Purchased|download|Download|Hosting|data-saved-connect|data-saved-open/.test(d), 'no purchased-only controls on a draft');
  // Owned: Owned badge, purchase date, files, preview, hosting & handoff, connect (not connected here yet)
  assert.match(o, /chip-success">Owned</); assert.match(o, /Purchased Sep 10, 2026/);
  assert.match(o, /href="\/api\/app\/websites\/proj_OWNEDaaaaaaaaaaaaaaaaa\/download">Download website files \(\.zip\)/);
  assert.match(o, /preview\?source=published/); assert.match(o, /Hosting &amp; handoff/);
  assert.match(o, /data-saved-connect="proj_OWNEDaaaaaaaaaaaaaaaaa">Connect to this business/);
  // once connected it opens here; the one already shown says so
  const linked = savedWebsitesFrom([OWNED], new Set([OWNED.projectId]))[0];
  assert.match(view.rowHtml(linked), /data-saved-open="proj_OWNEDaaaaaaaaaaaaaaaaa">Open here/);
  assert.match(view.rowHtml(linked, { currentProjectId: OWNED.projectId }), /Showing above/);
  // Creative
  assert.match(view.rowHtml(savedWebsitesFrom([CREATIVE_DRAFT], new Set())[0]), /Creative page/);
});

test('the whole list: a summary, every website, an honest empty state, and escaping', () => {
  const list = savedWebsitesFrom([OWNED, DRAFT, CREATIVE_DRAFT], new Set());
  const html = view.listHtml({ status: 'ready', list });
  assert.match(html, /3 saved · 1 owned · 2 drafts/);
  assert.equal((html.match(/<li class="saved-website"/g) || []).length, 3);
  assert.ok(html.indexOf(CREATIVE_DRAFT.projectId) < html.indexOf(DRAFT.projectId) && html.indexOf(DRAFT.projectId) < html.indexOf(OWNED.projectId), 'newest first');
  assert.match(view.listHtml({ status: 'ready', list: [] }), /Nothing saved yet\. Websites you generate and save in the SiteRemade builder appear here — drafts too\./);
  assert.match(view.listHtml({ status: 'unavailable', message: 'This account belongs to more than one business' }), /more than one business/);
  const evil = view.rowHtml(savedWebsitesFrom([{ ...DRAFT, businessName: '<img src=x onerror=alert(1)>' }], new Set())[0]);
  assert.ok(!/<img/.test(evil) && /&lt;img/.test(evil));
});

// SAVED DRAFTS: the handoff carries the draft's id to the builder (which opens that exact project), and nothing else
test('15b. Continue in the builder lands on the builder with that exact draft', async () => {
  let route; require('../routes/website-builder-handoff')({ get: (p, o, h) => { route = h; } });
  const go = async q => { let loc; await route({ url: '/handoff/website-builder' + q }, { writeHead: (c, h) => { loc = h.Location; }, end() {} }, { u: new URL('http://x/handoff/website-builder' + q), c: { access: 'tok' } }); return new URL(loc); };
  const a = await go('?project=proj_DRAFTaaaaaaaaaaaaaaaaaa'); assert.equal(a.pathname + a.search, '/?project=proj_DRAFTaaaaaaaaaaaaaaaaaa'); assert.match(a.hash, /^#bridge=session&access_token=tok/);
  for (const bad of ['?project=../x', '?project=' + encodeURIComponent('a"><b'), '?project=' + 'a'.repeat(81)]) { const b = await go(bad); assert.equal(b.search, '', bad); }
  assert.equal((await go('?target=creative')).search, '?studio=creative', 'the Create view is unchanged');
});
