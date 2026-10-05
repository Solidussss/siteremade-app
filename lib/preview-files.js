'use strict';
// THE WEBSITE PREVIEW'S FILES. The builder sends a preview as ONE self-contained page: every picture, clip, font, the 3D
// engine and the 3D model inlined as data: URLs. A Creative page made that page tens of megabytes of text, parsed again
// on every change -- an iPhone closed the tab ("it keeps crashing on the app"). Here the big files are lifted out of the
// page before it is sent: each is kept in this process (content-addressed, the least recently used dropped past a byte
// budget) and the page asks for it at /api/app/website/preview-file/<id>, where the browser can stream a clip, decode a
// picture when it is needed, and keep the file across the preview's reloads.
//
// The id is a salted hash of the bytes: it cannot be guessed, it is the only way to a file, and it names that one file
// (the route needs no session -- a sandboxed preview frame does not send one). Nothing is stored on disk; after a restart
// an id is gone and the next preview lifts the files again.
const crypto = require('crypto');

const PATH = '/api/app/website/preview-file/';
const SALT = crypto.randomBytes(16);
const MAX_BYTES = Math.max(16, Number(process.env.SITEREMADE_PREVIEW_FILES_MB) || 192) * 1024 * 1024;
// (a small file stays inline: a request costs more than its bytes)
const MIN_BYTES = 16 * 1024;
// the kinds of file a preview may load from here -- never a document a browser would run as a page of this origin
const KINDS = /^(image\/(png|jpeg|webp|gif|avif)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|wav|ogg)|font\/(woff2?|ttf|otf)|model\/gltf-binary|text\/javascript|application\/octet-stream)$/;
const ID = /^[a-f0-9]{40}$/;

const files = new Map(); let total = 0;

// what the builder labels application/octet-stream, by its first bytes (the 3D model, a clip, the 3D engine's script)
function sniff(type, buf) {
  if (type !== 'application/octet-stream') return type;
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'glTF') return 'model/gltf-binary';
  if (buf.length >= 8 && buf.toString('latin1', 4, 8) === 'ftyp') return 'video/mp4';
  const head = buf.subarray(0, 4096); if (!head.includes(0) && /^\s*(\/\*|\/\/|var |let |const |function|\(|!function|['"]use strict)/.test(head.toString('utf8', 0, 200))) return 'text/javascript';
  return type;
}
function put(type, buf) {
  const id = crypto.createHash('sha256').update(SALT).update(type).update('\0').update(buf).digest('hex').slice(0, 40);
  const had = files.get(id);
  if (had) { files.delete(id); files.set(id, had); return id; }
  files.set(id, { type, buf }); total += buf.length;
  while (total > MAX_BYTES && files.size > 1) { const [k, v] = files.entries().next().value; files.delete(k); total -= v.buf.length; }
  return id;
}
function get(id) {
  if (!ID.test(String(id || ''))) return null;
  const f = files.get(id); if (f) { files.delete(id); files.set(id, f); }
  return f || null;
}
// the page with its big data: files replaced by their preview-file address (everything else -- and any file this cannot
// keep -- stays exactly as the builder sent it)
function lift(html) {
  if (typeof html !== 'string' || html.length < MIN_BYTES) return html;
  // (a scan, not one regular expression: a model is megabytes of base64, more than a regex's backtracking stack takes)
  const out = []; let from = 0; let at = html.indexOf('data:', 0);
  while (at >= 0) {
    const mark = html.indexOf(';base64,', at); const type = mark > at && mark - at < 80 ? html.slice(at + 5, mark).toLowerCase() : '';
    let end = at + 5;
    if (type && /^[a-z0-9.+\/-]+$/.test(type)) {
      end = mark + 8; while (end < html.length && B64[html.charCodeAt(end)]) end++;
      const keep = end - (mark + 8) >= MIN_B64 && KINDS.test(type) ? store(type, html.slice(mark + 8, end)) : '';
      if (keep) { out.push(html.slice(from, at), keep); from = end; }
    }
    at = html.indexOf('data:', end);
  }
  if (!from) return html;
  out.push(html.slice(from)); return out.join('');
}
const B64 = new Uint8Array(128); 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/='.split('').forEach(ch => { B64[ch.charCodeAt(0)] = 1; });
const MIN_B64 = Math.ceil(MIN_BYTES / 3) * 4;
// one inlined file kept -> its address ('' to leave it inline)
function store(type, b64) {
  try {
    const buf = Buffer.from(b64, 'base64'); if (buf.length < MIN_BYTES) return '';
    const kind = sniff(type, buf); if (kind === 'application/octet-stream') return '';
    return PATH + put(kind, buf);
  } catch (e) { return ''; }
}
// one file to the browser: a range of it when asked (Safari plays a clip only from a server that answers ranges)
function send(req, res, id) {
  const f = get(id);
  if (!f) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end('Not found'); }
  const size = f.buf.length;
  const head = {
    'Content-Type': f.type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400, immutable',
    // (a preview frame has no origin of its own: its fetch() of the 3D model is a cross-origin request)
    'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'X-Content-Type-Options': 'nosniff',
    // (opened on its own, nothing in it runs as a page of this app)
    'Content-Security-Policy': "default-src 'none'; sandbox",
  };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2])); let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    end = Math.min(end, size - 1);
    if (!(start <= end) || start >= size) { res.writeHead(416, Object.assign(head, { 'Content-Range': `bytes */${size}` })); return res.end(); }
    res.writeHead(206, Object.assign(head, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 }));
    return res.end(req.method === 'HEAD' ? undefined : f.buf.subarray(start, end + 1));
  }
  res.writeHead(200, Object.assign(head, { 'Content-Length': size }));
  return res.end(req.method === 'HEAD' ? undefined : f.buf);
}
function stats() { return { files: files.size, bytes: total, max: MAX_BYTES }; }

module.exports = { PATH, lift, get, send, stats, sniff };
