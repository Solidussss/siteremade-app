'use strict';
// STATIC FILES (lib/static-files.js): the app hands out only the files on its explicit public allow-list -- the page and
// what the browser loads -- and nothing else in the repo: not server.js, lib/, routes/, test/, package.json, hidden
// files, notes or migrations, whatever path tricks the request uses. Requests are sent raw (node:http), byte for byte,
// so no client normalises '..' or an encoded slash away before the server sees it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { PUBLIC_FILES, serveStatic } = require('../lib/static-files');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
async function withServer(fn) {
  const server = http.createServer((req, res) => serveStatic(req, res, new URL(req.url, 'http://app.test').pathname));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try { return await fn(server.address().port); } finally { await new Promise(r => server.close(r)); }
}
const get = (port, rawPath, headers) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET', headers: headers || {} }, res => {
    const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', reject); req.end();
});
// a response that leaks a source file: any of server.js's / a module's own text
const SOURCE = [read('server.js').slice(0, 60), read('lib/static-files.js').slice(0, 60), read('package.json').slice(0, 30)];
const leaks = r => SOURCE.some(s => r.body.toString('utf8').includes(s));

test('every file the browser loads is on the allow-list, exists, and is served with its type -- the page, its scripts and styles, the scripts those load, the icons and the embed', async () => {
  // what the browser loads, read from the code that loads it -- so a new file the app starts loading cannot be forgotten
  const html = read('index.html');
  const loaded = new Set([...html.matchAll(/(?:src|href)="([a-z0-9._-]+)(?:\?[^"]*)?"/gi)].map(m => m[1]));
  const app = read('app.js'), boot = read('v29-bootstrap.js'), v18 = read('v18-client.js');
  for (const src of [app.match(/function loadDashboardFeatureScripts\(\)\{[\s\S]*?\n\}/)[0], boot, v18])
    for (const m of src.matchAll(/'\/([a-z0-9._-]+\.(?:js|css))(?:\?[^']*)?'/gi)) loaded.add(m[1]);
  for (const m of read('manifest.webmanifest').matchAll(/"src"\s*:\s*"\/?([a-z0-9._-]+)/gi)) loaded.add(m[1]);
  loaded.add('widget.js'); // the embed customers paste into their own sites
  assert.ok(loaded.size > 30, `found ${loaded.size}`);
  for (const f of loaded) assert.ok(PUBLIC_FILES.has(f), `${f} is loaded by the browser but not public`);
  for (const f of PUBLIC_FILES) assert.ok(fs.statSync(path.join(ROOT, f)).isFile(), `${f} exists`);
  await withServer(async port => {
    for (const f of PUBLIC_FILES) {
      const r = await get(port, '/' + f + '?v=1');
      assert.equal(r.status, 200, f); assert.deepEqual(r.body, fs.readFileSync(path.join(ROOT, f)), `${f} served as it is`);
      const want = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }[path.extname(f)];
      assert.ok(r.headers['content-type'].startsWith(want), `${f}: ${r.headers['content-type']}`);
    }
    // the page itself at '/', never cached; text gzipped when asked, identical once decoded
    const page = await get(port, '/'); assert.equal(page.status, 200); assert.equal(page.headers['cache-control'], 'no-store'); assert.deepEqual(page.body, fs.readFileSync(path.join(ROOT, 'index.html')));
    const gz = await get(port, '/app.js', { 'accept-encoding': 'gzip' }); assert.equal(gz.headers['content-encoding'], 'gzip'); assert.deepEqual(zlib.gunzipSync(gz.body), fs.readFileSync(path.join(ROOT, 'app.js')));
    // a plain page path (no extension, one segment) is still the app's page, as before
    const spa = await get(port, '/websites'); assert.equal(spa.status, 200); assert.match(spa.body.toString('utf8'), /<!doctype html>/i);
  });
});

test('server.js, lib/, routes/, test/, scripts/, package files, notes, migrations and every non-public file in the repo root: 404, never their text', async () => {
  await withServer(async port => {
    const internal = ['/server.js', '/v17-server.js', '/v17-preload.js', '/v29-mail-server.js', '/v30-google-auth.js', '/v32-google-env-aliases.js', '/v40-twilio-subaccounts.js',
      '/package.json', '/package-lock.json', '/README.md', '/RAILWAY-DEPLOY.md', '/supabase-schema.sql', '/V12-MIGRATION.sql',
      '/lib/static-files.js', '/lib/context.js', '/lib/generator-bridge.js', '/lib/', '/lib',
      '/routes/website-bridge.js', '/routes/', '/test/static-files.test.js', '/test/helpers/fake-supabase.js', '/test/', '/scripts/bootstrap-owner.js',
      '/node_modules/dotenv/package.json',
      // legacy client files the app no longer loads
      '/v19-client.js', '/v22-client.js', '/v24-umami-client.js', '/v34-integrations.js', '/v18.css'];
    // and EVERY file in the repo root that is not public -- not just the ones named above
    for (const f of fs.readdirSync(ROOT)) if (!PUBLIC_FILES.has(f) && fs.statSync(path.join(ROOT, f)).isFile()) internal.push('/' + f);
    for (const p of internal) {
      const r = await get(port, p);
      assert.ok(!leaks(r), `${p} leaked source`);
      // a file path is a 404; a bare folder name ('/lib', '/test/') is just a page path -- the app's page, never a listing
      if (/\.[a-z]+$/i.test(p) || p.split('/').filter(Boolean).length > 1) assert.equal(r.status, 404, `${p}: ${r.status}`);
      else assert.ok(r.status === 404 || (r.status === 200 && r.body.equals(fs.readFileSync(path.join(ROOT, 'index.html')))), `${p}: ${r.status}`);
    }
  });
});

test('hidden files and path tricks: .env, .git, dot segments, encoded slashes and dots, backslashes, NUL bytes -- all 404, never a file', async () => {
  await withServer(async port => {
    for (const p of ['/.env', '/.env.example', '/.gitignore', '/.git/config', '/.git/HEAD', '/.vscode/settings.json', '/%2eenv', '/%2Eenv',
      '/../server.js', '/./server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/..%5cserver.js', '/%2fserver.js', '/lib%2fcontext.js', '/lib%5ccontext.js',
      '/app.js/', '/app.js%00', '/app.js%00.png', '/APP.JS', '/index.html/../server.js', '/%E0%A4%A', '/static/../../server.js']) {
      const r = await get(port, p);
      assert.equal(r.status, 404, `${p}: ${r.status}`); assert.ok(!leaks(r), `${p} leaked source`);
    }
  });
});

test('server.js serves files only through the allow-list, after every route (so the preview, 3D preview and their CSP are untouched)', () => {
  const s = read('server.js');
  assert.match(s, /const \{ serveStatic \} = require\('\.\/lib\/static-files'\)/);
  assert.doesNotMatch(s, /function serve\(|path\.join\(ROOT,rel\)|createReadStream/, 'no file is read from the repo by request path any more');
  const handler = s.slice(s.indexOf('http.createServer(async(req,res)=>'));
  const order = ['router.dispatch(req,res,u,json)', "u.pathname.startsWith('/api/')", 'serveStatic(req,res,u.pathname)'].map(x => handler.indexOf(x));
  assert.ok(order.every(i => i > 0) && order[0] < order[1] && order[1] < order[2], `routes, then the API, then static files: ${order}`);
});
