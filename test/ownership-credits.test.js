'use strict';
// OWNERSHIP + CREDITS in the client app: no Workspace subscription is required (or sold) for anything; a website is
// owned permanently; AI updates follow "describe -> see the credit quote -> approve -> SiteRemade does it"; credits are
// bought as one-time packs through the builder (which grants them from its signed Stripe webhook). Real HTTP to a stub
// builder for the bridge calls; source checks for the screens and gates.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const bridge = require('../lib/generator-bridge');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

test('the bridge asks the builder for a quote, sends the approved quote with the update, starts a credit checkout and reads the history -- each with the customer\'s own token', async () => {
  const seen = [];
  const builder = http.createServer((req, res) => {
    let body = ''; req.on('data', d => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, key: req.headers['idempotency-key'], body: body ? JSON.parse(body) : null });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url === '/api/app-bridge/quotes' ? { ok: true, quote: { id: 'q_1', credits: 2, message: 'This update will use 2 credits.' } } : req.url === '/api/app-bridge/credits/checkout' ? { ok: true, url: 'https://checkout.stripe.com/x' } : { ok: true, events: [] }));
    });
  });
  const port = await listen(builder);
  process.env.WEBSITE_BUILDER_URL = `http://127.0.0.1:${port}`;
  try {
    const q = await bridge.postQuote('tok', { request: 'Move the reviews above the services', projectId: 'proj_1' });
    assert.equal(q.data.quote.id, 'q_1');
    await bridge.postEdit('tok', 'proj_1', { baseRevision: 3, request: 'Move the reviews above the services', requestId: 'edit_1', quoteId: 'q_1' });
    await bridge.postCreditCheckout('tok', 'credits_30');
    await bridge.getCreditHistory('tok');
    assert.deepEqual(seen.map(s => `${s.method} ${s.url}`), ['POST /api/app-bridge/quotes', 'POST /api/app-bridge/website/proj_1/edits', 'POST /api/app-bridge/credits/checkout', 'GET /api/app-bridge/credits/history']);
    assert.ok(seen.every(s => s.auth === 'Bearer tok'));
    assert.deepEqual(seen[1].body, { baseRevision: 3, request: 'Move the reviews above the services', quoteId: 'q_1' }); assert.equal(seen[1].key, 'edit_1');
    assert.deepEqual(seen[2].body, { packId: 'credits_30' });
  } finally { await new Promise(r => builder.close(r)); }
});

test('no subscription system remains: every signed-in workspace member uses the app and there are no membership checkout or portal routes', () => {
  const ctx = read('lib/context.js'); const server = read('server.js');
  assert.match(ctx, /function hasSiteRemadeAccess\(c\) \{\r?\n  return !!c;\r?\n\}/);
  assert.doesNotMatch(ctx, /siteremade_subscription_status/, 'access never reads a subscription status');
  assert.doesNotMatch(server, /billing\/subscription|billing\/portal|SUBSCRIPTION_REQUIRED|SUBSCRIPTION_RETIRED|siteremade_subscription/i);
  for (const f of ['index.html', 'app.js']) assert.doesNotMatch(read(f), /subscription|Subscribe to Workspace|Start Workspace/i, f);
  assert.match(read('lib/website-download.js'), /Ownership, not subscription/);
});

test('the core loop: My Websites, Create, Credits, Analytics, Account (+ Support); ads, inbox, leads and the other workspace tools are staff-only', () => {
  const html = read('index.html'); const app = read('app.js');
  const nav = /<nav class="side-nav primary-nav"[\s\S]*?<\/nav>/.exec(html)[0];
  assert.deepEqual([...nav.matchAll(/data-view="([^"]+)"/g)].map(m => m[1]), ['website', 'create', 'credits', 'analytics', 'settings', 'support']);
  for (const v of ['create', 'credits', 'support']) assert.match(html, new RegExp(`id="view-${v}"`));
  const staff = /const STAFF_ONLY_VIEWS=new Set\(\[([^\]]+)\]\)/.exec(app)[1];
  for (const v of ['ads', 'contact', 'leads', 'inbox', 'prospecting', 'payments']) assert.ok(staff.includes(`'${v}'`), v);
  assert.match(app, /if\(STAFF_ONLY_VIEWS\.has\(v\)&&state\.user\?\.role!=='owner'\)v='website'/);
  // Create hands off to the builder by kind (the server builds the URL -- never one the page supplies)
  assert.match(html, /href="\/handoff\/website-builder\?target=business"/); assert.match(html, /href="\/handoff\/website-builder\?target=creative"/);
  assert.match(read('routes/website-builder-handoff.js'), /kind === 'creative' \? GENERATOR_ORIGIN \+ '\/\?studio=creative'/);
});

test('an update is quoted and confirmed before it runs, and the quote travels with it', () => {
  const app = read('app.js'); const routes = read('routes/website-bridge.js');
  const fn = /async requestEdit\(\{projectId,baseRevision,instruction\}\)\{[\s\S]*?\n  \},/.exec(app)[0];
  assert.ok(fn.indexOf("'/api/app/website/quote'") > 0 && fn.indexOf('window.confirm') > fn.indexOf("'/api/app/website/quote'") && fn.indexOf('/edits') > fn.indexOf('window.confirm'), 'quote, then confirm, then edit');
  assert.match(fn, /quoteId:quote\.id/); assert.match(fn, /nothing was charged/);
  assert.match(routes, /router\.post\('\/api\/app\/website\/quote'/);
  assert.match(routes, /if \(err\.quote && typeof err\.quote === 'object'\) out\.quote = quoteFrom\(err\.quote\);/);
  assert.equal((routes.match(/quoteId: typeof body\.quoteId === 'string' \? body\.quoteId : ''/g) || []).length, 2, 'both edit routes forward the approved quote');
  // customers see credits, never provider costs or Stripe ids
  assert.doesNotMatch(/function quoteFrom[\s\S]*?\n\}/.exec(routes)[0], /usd|ceiling|stripe/i);
  assert.doesNotMatch(/function catalogFrom[\s\S]*?\n\}/.exec(routes)[0], /stripePrice|usd/i);
});

test('the Credits view buys one-time packs through the builder and shows the ledger; returning from checkout never grants anything itself', () => {
  const app = read('app.js'); const routes = read('routes/website-bridge.js');
  assert.match(app, /api\('\/api\/app\/credits\/checkout',\{method:'POST',body:JSON\.stringify\(\{packId:b\.dataset\.pack\}\)\}\)/);
  assert.match(app, /api\('\/api\/app\/credits\/history'\)/);
  assert.match(app, /the credits are granted when Stripe confirms the payment \(never by this URL\)/);
  assert.match(routes, /\/\^https:\\\/\\\/\/\.test\(r\.data\.url\)/, 'only an https checkout URL is followed');
});
