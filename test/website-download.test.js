'use strict';
// K. The purchased-website ZIP survives builder -> Client App -> browser byte for byte (lib/generator-bridge.js
// callBinary + lib/website-download.js, the code GET /api/app/website/download runs), and a builder failure reaches the
// customer as a specific, readable error instead of a generic one. Real HTTP on both hops; the builder is a stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const bridge = require('../lib/generator-bridge');
const { sendWebsiteDownload } = require('../lib/website-download');

const json = (res, status, obj) => { const b = JSON.stringify(obj); res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }); res.end(b); };
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

async function withServers(builderHandler, fn) {
  const seen = [];
  const builder = http.createServer((req, res) => { seen.push({ url: req.url, auth: req.headers.authorization }); builderHandler(req, res); });
  const bport = await listen(builder);
  process.env.WEBSITE_BUILDER_URL = `http://127.0.0.1:${bport}`;
  const logs = { log: [], error: [] };
  const log = { log: m => logs.log.push(m), error: m => logs.error.push(m) };
  // the Client App's download route, minus sign-in (a verified user token is what routes/website-bridge.js hands over)
  const app = http.createServer((req, res) => sendWebsiteDownload({ bridge, token: 'user-access-token', projectId: 'proj_ABCDEFGHIJKLMNOPQRSTUV12', res, json, log }).catch(e => json(res, 500, { ok: false, error: String(e) })));
  const aport = await listen(app);
  try { await fn({ url: `http://127.0.0.1:${aport}/api/app/website/download`, seen, logs }); }
  finally { await new Promise(r => app.close(r)); await new Promise(r => builder.close(r)); }
}

test('K. the ZIP bytes reach the browser exactly -- same length, same hash, the builder\'s filename kept', async () => {
  // a large, incompressible body with every byte value (anything that decoded it as text would corrupt it)
  const zip = Buffer.concat([Buffer.from('PK\x03\x04', 'binary'), crypto.randomBytes(3 * 1024 * 1024), Buffer.from(Array.from({ length: 256 }, (_, i) => i))]);
  await withServers((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': zip.length, 'Content-Disposition': 'attachment; filename="Greenline-Landscapes.zip"; filename*=UTF-8\'\'Greenline%20Landscapes.zip', 'X-SiteRemade-Deployment': 'dep_test123' });
    res.end(zip);
  }, async ({ url, seen, logs }) => {
    const r = await fetch(url);
    const body = Buffer.from(await r.arrayBuffer());
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/zip');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(Number(r.headers.get('content-length')), zip.length);
    assert.equal(r.headers.get('content-disposition'), 'attachment; filename="Greenline-Landscapes.zip"; filename*=UTF-8\'\'Greenline%20Landscapes.zip');
    assert.equal(body.length, zip.length);
    assert.equal(crypto.createHash('sha256').update(body).digest('hex'), crypto.createHash('sha256').update(zip).digest('hex'), 'byte-identical');
    assert.equal(seen[0].url, '/api/app-bridge/website/proj_ABCDEFGHIJKLMNOPQRSTUV12/download');
    assert.equal(seen[0].auth, 'Bearer user-access-token', 'the customer\'s own token goes to the builder');
    assert.ok(logs.log.some(l => /"stage":"proxied"/.test(l) && /"bytes":\d+/.test(l)));
    assert.ok(!logs.log.concat(logs.error).some(l => /user-access-token/.test(l)), 'the token is never logged');
  });
});

test('a builder failure keeps its specific reason (code + stage) for the app, with a customer-readable message', async () => {
  await withServers((req, res) => json(res, 500, { ok: false, error: { code: 'package_failed', message: 'x', stage: 'zip', deploymentId: 'dep_fail1' } }), async ({ url, logs }) => {
    const r = await fetch(url); const d = await r.json();
    assert.equal(r.status, 502); assert.equal(d.code, 'package_failed'); assert.equal(d.stage, 'zip');
    assert.match(d.message, /could not be packaged/);
    assert.ok(logs.error.some(l => /"code":"package_failed"/.test(l) && /"builderStatus":500/.test(l) && /dep_fail1/.test(l)), 'the real cause is logged');
  });
  await withServers((req, res) => json(res, 403, { ok: false, error: { code: 'not_purchased', message: 'x' } }), async ({ url }) => {
    const r = await fetch(url); const d = await r.json();
    assert.equal(r.status, 403); assert.equal(d.code, 'not_purchased'); assert.match(d.message, /hasn’t been purchased/);
  });
  await withServers((req, res) => json(res, 404, { ok: false, error: { code: 'not_found', message: 'x' } }), async ({ url }) => {
    const r = await fetch(url); assert.equal(r.status, 404); assert.equal((await r.json()).code, 'not_found');
  });
  // a 200 that is not a ZIP is never handed to the browser as one
  await withServers((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>oops</html>'); }, async ({ url }) => {
    const r = await fetch(url); assert.equal(r.status, 502); assert.equal((await r.json()).code, 'not_a_zip');
  });
});

test('an unreachable builder is reported as such', async () => {
  process.env.WEBSITE_BUILDER_URL = 'http://127.0.0.1:9'; // nothing listens on the discard port
  const res = { writeHead() {}, end() {} }; let out = null;
  await sendWebsiteDownload({ bridge, token: 't', projectId: 'p', res, json: (r, status, obj) => { out = { status, obj }; }, log: { log() {}, error() {} } });
  assert.equal(out.status, 502); assert.equal(out.obj.code, 'bridge_unavailable');
});
