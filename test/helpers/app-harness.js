'use strict';
// The Client App's REAL website routes (routes/website-bridge.js on lib/router.js, with lib/website-links.js,
// lib/saved-websites.js, lib/generator-bridge.js and lib/website-download.js exactly as they ship) on a local HTTP
// server. Only two things are stand-ins: the database (test/helpers/fake-supabase.js) and sign-in -- lib/context.js is
// replaced before anything loads it, so a request's signed-in person and workspace come from the test (header
// x-test-as names one of `people`), with that person's own builder token forwarded to the builder exactly as in
// production. The builder is whatever WEBSITE_BUILDER_URL points at: a fixture server or the real builder.
const http = require('http');
const path = require('path');
const { createFakeSupabase } = require('./fake-supabase');

const ROOT = path.join(__dirname, '..', '..');
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}
function readJsonBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > maxBytes) { reject(new Error('Payload too large')); req.destroy(); } });
    req.on('end', () => { if (!raw) return resolve({}); try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

// people: { name: { userId, owner, access, workspaces: [{id, business_name}], wid, email?, emailConfirmed? (default true) } }
async function startApp({ seed, people, builderUrl }) {
  const db = createFakeSupabase(seed);
  process.env.WEBSITE_BUILDER_URL = builderUrl;
  const contextFor = req => {
    const p = people[req.headers['x-test-as']];
    if (!p) return null;
    const wid = p.wid || p.workspaces[0].id;
    return { user: { id: p.userId, email: p.email || `${p.userId}@example.com`, email_confirmed_at: p.emailConfirmed === false ? null : '2026-01-01T00:00:00.000Z' }, profile: { role: p.owner ? 'owner' : 'client' }, access: p.access, owner: !!p.owner, workspaces: p.workspaces, wid, workspace: p.workspaces.find(w => w.id === wid) };
  };
  // lib/context.js, as every route module sees it in this process
  const contextPath = require.resolve(path.join(ROOT, 'lib', 'context.js'));
  for (const k of Object.keys(require.cache)) if (k.startsWith(ROOT) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  require.cache[contextPath] = { id: contextPath, filename: contextPath, loaded: true, exports: {
    db, anon: null, configured: true, sendJson, readJsonBody, cookies: () => ({}),
    getAuthUser: async req => contextFor(req), getContext: async req => contextFor(req),
    hasSiteRemadeAccess: () => false, // (keeps Umami analytics provisioning out of these tests; no route here depends on it)
    requireSiteRemadeAccess: () => true,
  } };
  const { Router } = require(path.join(ROOT, 'lib', 'router.js'));
  const router = new Router();
  require(path.join(ROOT, 'routes', 'website-bridge.js'))(router);
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://app.test');
    if (!(await router.dispatch(req, res, u, sendJson))) sendJson(res, 404, { ok: false });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // as: one of `people`. Returns {status, headers, body (parsed JSON or null), buf}
  const call = async (as, method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'x-test-as': as, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const buf = Buffer.from(await r.arrayBuffer());
    let parsed = null; try { parsed = JSON.parse(buf.toString('utf8')); } catch (e) { parsed = null; }
    return { status: r.status, headers: r.headers, body: parsed, buf };
  };
  return { db, call, base, stop: () => new Promise(r => server.close(r)) };
}

module.exports = { startApp };
