'use strict';
// A small Content-Security-Policy reader for tests: does this policy let a page load THIS url for THIS purpose? It
// follows the parts of CSP Level 3 a website preview depends on -- directive fallback (script-src-elem -> script-src ->
// default-src; connect-src -> default-src), scheme sources (data: blob: https:), 'self', 'none', 'unsafe-inline' and
// host sources -- and is checked against a real browser by test/review/creative-3d-preview.js.
function parse(policy) {
  const out = {};
  String(policy || '').split(';').map(s => s.trim()).filter(Boolean).forEach(d => { const [name, ...src] = d.split(/\s+/); if (!(name.toLowerCase() in out)) out[name.toLowerCase()] = src; });
  return out;
}
const FALLBACK = { 'script-src-elem': ['script-src-elem', 'script-src', 'default-src'], 'script-src': ['script-src', 'default-src'], 'connect-src': ['connect-src', 'default-src'], 'img-src': ['img-src', 'default-src'], 'style-src': ['style-src', 'default-src'] };
function sourcesFor(p, directive) { for (const d of FALLBACK[directive] || [directive]) if (p[d]) return p[d]; return null; }
// url: the address asked for ('inline' for an inline script); origin: the page's own origin
function allows(policy, directive, url, origin) {
  const p = parse(policy); const src = sourcesFor(p, directive);
  if (!src) return true; // no directive and no default: allowed
  if (src.length === 1 && src[0] === "'none'") return false;
  if (url === 'inline') return src.includes("'unsafe-inline'");
  let u; try { u = new URL(url); } catch (e) { return false; }
  return src.some(s => {
    if (s === "'self'") return !!origin && u.origin === new URL(origin).origin;
    if (/^[a-z][a-z0-9+.-]*:$/i.test(s)) return u.protocol === s.toLowerCase(); // a scheme source
    if (s.startsWith("'")) return false; // other keywords never match a URL
    if (s === '*') return !['data:', 'blob:', 'filesystem:'].includes(u.protocol);
    const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([^/:]+)(?::(\d+|\*))?(\/.*)?$/i.exec(s); if (!m) return false;
    if (m[1] && u.protocol !== m[1].toLowerCase() + ':') return false;
    if (m[4] && m[4] !== '*' && (u.port || (u.protocol === 'https:' ? '443' : '80')) !== m[4]) return false;
    // (a path: a prefix when it ends in /, else exactly that path)
    if (m[5] && !(m[5].endsWith('/') ? u.pathname.startsWith(m[5]) : u.pathname === m[5])) return false;
    return m[2] ? u.hostname.endsWith('.' + m[3]) : u.hostname === m[3].toLowerCase();
  });
}
module.exports = { parse, allows };
