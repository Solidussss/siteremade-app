'use strict';
// STATIC FILES: what this app hands out as a plain file. Only the files on PUBLIC_FILES -- the page, the scripts and
// stylesheets the browser actually loads, its icons, and the public embed script -- are ever served. Everything else in
// the repo (server.js, lib/, routes/, test/, scripts/, package.json, .env*, .git, migrations, notes, the server-side vNN
// files and the disconnected legacy client files) is never served, whether or not it exists on disk.
//
// Why each file is here (keep this list in step with what the browser loads -- a new public file is added on purpose):
//   index.html and what it links: app.js, saved-websites-view.js, website-selection.js, website-creative-editor.js/.css,
//     app.css, design-system.css, theme-navy.css, manifest.webmanifest, favicon.png, siteremade-logo-black.png
//   loaded by app.js's loadDashboardFeatureScripts(): v17.css, v19.css, v40-existing-number-client.js,
//     v45-ad-intelligence-client.js, v29-bootstrap.js, v17-client.js, v18-client.js
//   imported by v18-client.js: v19-agency.js, v19-updates.js, v19-market.js, v29-lead-fix.js
//   loaded by v29-bootstrap.js: v29-mail.css, v41-experience.css, v42-daily-workflow.css, v43-ad-control.css,
//     v29-mail-client.js, v41-experience.js, v42-daily-workflow.js, v43-ad-control.js, v44-google-ads-client.js,
//     v46-google-ads-account-fallback.js
//   widget.js: the lead-capture embed customers paste into their own sites (Settings shows its <script> tag)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const PUBLIC_FILES = new Set([
  'index.html', 'app.js', 'saved-websites-view.js', 'website-selection.js', 'website-creative-editor.js', 'website-creative-editor.css',
  'app.css', 'design-system.css', 'theme-navy.css', 'manifest.webmanifest', 'favicon.png', 'siteremade-logo-black.png',
  'v17.css', 'v19.css', 'v40-existing-number-client.js', 'v45-ad-intelligence-client.js', 'v29-bootstrap.js', 'v17-client.js', 'v18-client.js',
  'v19-agency.js', 'v19-updates.js', 'v19-market.js', 'v29-lead-fix.js',
  'v29-mail.css', 'v41-experience.css', 'v42-daily-workflow.css', 'v43-ad-control.css',
  'v29-mail-client.js', 'v41-experience.js', 'v42-daily-workflow.js', 'v43-ad-control.js', 'v44-google-ads-client.js', 'v46-google-ads-account-fallback.js',
  'widget.js',
]);

function mime(f){return ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json'}[path.extname(f)]||'application/octet-stream');}
// Performance review: text is gzipped when the client accepts it -- byte-identical once decoded.
const COMPRESSIBLE = /^(text\/|application\/javascript|application\/json|application\/manifest\+json)/;

// the public file a request path names, or null: an exact match on the allow-list, nothing resolved from the disk first
function publicFile(pathname) {
  let rel; try { rel = decodeURIComponent(String(pathname || '/')).replace(/^\/+/, ''); } catch { return null; }
  if (rel === '') rel = 'index.html';
  return PUBLIC_FILES.has(rel) ? rel : null;
}
// a path that is NOT a page of the app: any hidden segment, anything with a file extension, anything nested -- a 404,
// never the app's page (the app's own pages are '/' and single plain segments; everything nested is an API or handoff route)
function notAPage(pathname) {
  let p; try { p = decodeURIComponent(String(pathname || '/')); } catch { return true; }
  const segs = p.split(/[\\/]+/).filter(Boolean);
  return segs.length > 1 || segs.some(s => s.startsWith('.') || s.includes('.'));
}
function send(res, rel, req) {
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return false;
  const type = mime(f), cacheControl = rel === 'index.html' ? 'no-store' : 'public,max-age=300';
  if (COMPRESSIBLE.test(type) && /\bgzip\b/.test(req?.headers?.['accept-encoding'] || '')) { res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cacheControl, 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' }); fs.createReadStream(f).pipe(zlib.createGzip()).pipe(res); }
  else { res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cacheControl }); fs.createReadStream(f).pipe(res); }
  return true;
}
// what server.js does with every request no route took: a public file, else 404 for anything file-like, else the app's page
function serveStatic(req, res, pathname) {
  const rel = publicFile(pathname);
  if (rel && send(res, rel, req)) return;
  if (notAPage(pathname)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end('Not found'); }
  send(res, 'index.html', req);
}

module.exports = { PUBLIC_FILES, publicFile, serveStatic };
