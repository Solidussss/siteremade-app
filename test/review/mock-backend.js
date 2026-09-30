'use strict';
// A stand-in for this app's server, for the mobile audit only (test/review/mobile-audit.js) -- NOT part of `npm test`.
// Serves the REAL frontend files (index.html, app.js, the stylesheets) and answers the API with realistic, awkward
// customer data: a very long business name and email, several connected websites, saved drafts and owned websites
// (long names, Business and Creative), contact submissions with long messages, analytics, ad spend. Nothing here
// reaches Supabase, the builder, Stripe or Google.
//   GET /__scenario?auth=1&saved=many|one|none&locked=0&unpublished=1   -- switches what the API answers
//   /__site/*   the compiled website the preview shows (MOBILE_SITE_DIR: an export folder), else a small page
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const LONG = 'Harbourside Physiotherapy & Sports Rehabilitation Clinic of North Vancouver';
const DOMAIN = 'harbourside-physiotherapy-sports-rehab-north-vancouver.example.com';
const day = n => new Date(Date.now() - n * 86400000).toISOString();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };

const scenario = { auth: true, saved: 'many', locked: false, unpublished: true };
const P1 = 'proj_OWNEDaaaaaaaaaaaaaaaaa', P2 = 'proj_OWNEDbbbbbbbbbbbbbbbbb';
function summary(id) {
  const first = id === P1;
  return {
    ok: true, source: 'generator', hasCanonicalProject: true, projectId: id, name: first ? LONG : 'Greenline Landscapes',
    status: 'purchased', revision: first ? 9 : 4, purchaseRef: first ? 'SR-9F3A2C71' : 'SR-17BB02', createdAt: day(40), updatedAt: day(1),
    deploymentStatus: 'not_deployed', businessName: first ? LONG : 'Greenline Landscapes',
    domains: first ? [{ domain: DOMAIN, state: 'dns_pending', verifiedAt: null }] : [],
    lastPublishedAt: day(6), publishedRevision: first ? 7 : 4, purchasedRevision: 3, hasUnpublishedChanges: first && scenario.unpublished,
    canEdit: true, canPublish: true, previewUrl: null, liveUrl: null,
  };
}
function savedWebsites() {
  const base = { revision: 3, createdAt: day(30), hasPurchaseSnapshot: false, hasUnpublishedChanges: false, purchasedAt: null, isPurchased: false, status: 'draft', linked: false };
  const all = [
    { ...base, projectId: P1, name: LONG, businessName: LONG, mode: 'business', status: 'purchased', isPurchased: true, hasPurchaseSnapshot: true, purchasedAt: day(38), updatedAt: day(1), linked: true, hasUnpublishedChanges: true },
    { ...base, projectId: 'proj_DRAFTcccccccccccccccccc', name: 'Supercalifragilisticexpialidocious-Artisanal-Sourdough-Bakehouse', businessName: 'Supercalifragilisticexpialidocious-Artisanal-Sourdough-Bakehouse', mode: 'business', updatedAt: day(2) },
    { ...base, projectId: 'proj_CREATIVEdddddddddddddd', name: 'A grand, slightly absurd page about the humble toilet paper roll', businessName: null, mode: 'creative', updatedAt: day(3) },
    { ...base, projectId: P2, name: 'Greenline Landscapes', businessName: 'Greenline Landscapes', mode: 'business', status: 'purchased', isPurchased: true, hasPurchaseSnapshot: true, purchasedAt: day(20), updatedAt: day(5), linked: true },
    { ...base, projectId: 'proj_CREATIVEeeeeeeeeeeeeee', name: 'Goldie the goldfish', businessName: null, mode: 'creative', status: 'purchased', isPurchased: true, hasPurchaseSnapshot: true, purchasedAt: day(12), updatedAt: day(8), linked: false },
    { ...base, projectId: 'proj_DRAFTffffffffffffffffff', name: 'Summit Roofing', businessName: 'Summit Roofing', mode: 'business', status: 'checkout_pending', updatedAt: day(9) },
    { ...base, projectId: 'proj_DRAFTgggggggggggggggggg', name: 'Petal & Stem', businessName: 'Petal & Stem', mode: 'business', updatedAt: day(15) },
  ];
  return scenario.saved === 'one' ? all.slice(0, 1) : scenario.saved === 'none' ? [] : all;
}
function leads() {
  const people = [['Alexandra Montgomery-Fitzwilliam', 'alexandra.montgomery-fitzwilliam@really-long-company-domain-name.example.com'], ['Sam Lee', 'sam@example.com'], ['Priya Natarajan', 'priya.n@example.com'], ['Tomás Ó Súilleabháin', ''], ['Jordan Kim', 'jordan.kim@example.org']];
  return people.map(([name, email], i) => ({ id: 'lead' + i, name, email, phone: i % 2 ? '+1 (604) 555-01' + (10 + i) : '', source: 'Website form', status: i === 0 ? 'New' : 'Contacted', service: i === 0 ? 'Post-surgical knee rehabilitation and return-to-sport assessment' : 'General inquiry',
    message: i === 0 ? 'Hi there — I tore my ACL skiing at Whistler in February and had reconstruction surgery six weeks ago. My surgeon recommended a physiotherapist who specialises in return-to-sport programmes. Do you have availability on weekday evenings or Saturday mornings? https://www.example.com/a/very/long/url/that/should/wrap/safely/on/a/phone/screen?ref=website-contact-form' : 'Could you tell me more about pricing?',
    createdAt: day(i), updatedAt: day(i) }));
}
function analytics(days) {
  const series = Array.from({ length: days }, (_, i) => ({ x: day(days - 1 - i).slice(0, 10) + ' 00:00:00', y: 20 + ((i * 37) % 60) }));
  return { ok: true, connected: true, domain: DOMAIN, days, active: { visitors: 3 }, stats: { visitors: 1284, pageviews: 4211, visits: 1530 }, series: { sessions: series },
    pages: [{ x: '/services/sports-injury-rehabilitation-and-return-to-play-programmes-for-athletes', y: 420 }, { x: '/', y: 1300 }, { x: '/about', y: 210 }, { x: '/contact', y: 190 }],
    referrers: [{ x: 'google.com', y: 700 }, { x: 'instagram.com', y: 120 }, { x: 'a-very-long-referring-domain-name-for-a-local-directory.example.com', y: 40 }],
    devices: [{ x: 'mobile', y: 810 }, { x: 'desktop', y: 420 }, { x: 'tablet', y: 54 }], countries: [{ x: 'CA', y: 1100 }, { x: 'US', y: 150 }, { x: 'GB', y: 34 }],
    events: [{ x: 'Call button', y: 44 }, { x: 'Book appointment button', y: 31 }] };
}
function api(p, q, method) {
  if (p === '/api/app/bootstrap') {
    if (!scenario.auth) return [401, { ok: false, message: 'Sign in required' }];
    return [200, { ok: true, user: { id: 'u1', name: 'Jordan Avery-Whitfield', email: 'jordan.avery-whitfield@harbourside-physiotherapy-rehab.example.com', role: 'client' },
      workspace: { id: 'w1', name: LONG, business_name: LONG, website: 'https://' + DOMAIN }, workspaces: [{ id: 'w1', name: LONG, business_name: LONG, role: 'owner' }],
      locked: scenario.locked, integrations: {}, leads: leads(), conversations: [{ id: 'c0', leadId: 'lead0', unread: 2, messages: [{ from: 'customer', text: 'Following up on my message about evening appointments.', at: day(0) }] }],
      appointments: [], invoices: [], automations: [], activities: [{ id: 'a1', title: 'New contact form submission from Alexandra Montgomery-Fitzwilliam', createdAt: day(0) }],
      adSpend: [{ id: 'ad1', platform: 'Google Ads', campaign: 'Sports injury rehabilitation — North Vancouver & West Vancouver search', spend: 412.5, leads: 9, createdAt: day(3) }, { id: 'ad2', platform: 'Google Ads', campaign: 'Brand', spend: 88, leads: 4, createdAt: day(10) }],
      adFunds: [], billing: { status: scenario.locked ? 'inactive' : 'active', monthlyCents: 3999 }, prospectViews: [], websiteAnalytics: { domain: DOMAIN, provider: 'umami', connected: true },
      websiteUpdates: [{ id: 'wu1', page: 'Home', priority: 'Normal', request: 'Please change the opening hours on the contact page to Mon–Fri 7am–8pm and Saturday 8am–2pm, and add our new Lonsdale Avenue location.', status: 'In progress', createdAt: day(4) }],
      websiteProjects: [] }];
  }
  if (p === '/api/app/website') return [200, { ...summary(P1), link: { status: 'linked' } }];
  if (p === '/api/app/website/projects') return [200, { ok: true, projects: [summary(P1), summary(P2)] }];
  let m = /^\/api\/app\/website\/projects\/([^/]+)$/.exec(p); if (m) return [200, summary(m[1])];
  if (p === '/api/app/websites') return [200, { ok: true, websites: savedWebsites() }];
  if (p === '/api/app/website/candidates') return [200, { ok: true, candidates: [summary(P1), summary(P2)].map(s => ({ ...s, alreadyLinked: true })), alreadyConnected: true }];
  if (p === '/api/app/website/credits') return [200, { ok: true, credits: { plan: 'workspace', planLabel: 'Workspace', remaining: 87, subscription: { status: 'active', credits: 100, remaining: 87, renewsAt: day(-20) }, costs: { businessGeneration: 2, creativePage: 4, aiUpdate: 1, imageSupport: 1, imagePremium: 2, manualEdit: 0 } }, websitePrice: { cents: 14999, currency: 'cad', display: '$149.99 CAD' } }];
  if (/\/deployment$/.test(p)) return [200, { ok: true, deploymentStatus: 'not_deployed', automaticHosting: false, deployments: [{ state: 'ready', target: 'local', projectRevision: 7, createdAt: day(6) }], domains: [{ domain: DOMAIN, state: 'dns_pending', verifiedAt: null }] }];
  if (/\/analytics$/.test(p) || p === '/api/app/umami/analytics') return [200, analytics(Number(q.get('days')) || 30)];
  if (p === '/api/app/google-ads/status') return [200, { ok: true, configured: true, connected: true, scopeReady: true, selectedCustomerId: '1234567890' }];
  if (p === '/api/app/google-ads/campaigns') return [200, { ok: true, campaigns: [] }];
  if (p === '/api/app/ad-recommendations') return [200, { ok: true, recommendations: [{ id: 'r1', title: 'Add call extensions to your sports injury rehabilitation campaign', reason: 'Most of your visitors are on phones and 44 people tapped “Call” last month.', proposed_action: 'Add a call extension with your clinic number', status: 'proposed' }] }];
  if (p === '/api/app/website-updates' && method === 'GET') return [200, { ok: true, websiteUpdates: [] }];
  return [200, { ok: true }];
}
function sitePage() {
  return '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><base href="/__site/"></head><body style="margin:0;font-family:sans-serif"><div style="padding:40px 20px;background:#15202b;color:#fff"><h1>' + LONG + '</h1><p>Preview</p></div></body></html>';
}

function start(port) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const send = (status, body, type) => { res.writeHead(status, { 'Content-Type': type || 'application/json', 'Cache-Control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
    if (u.pathname === '/__scenario') { for (const [k, v] of u.searchParams) scenario[k] = v === '1' ? true : v === '0' ? false : v; return send(200, scenario); }
    if (/\/preview$/.test(u.pathname)) {
      const dir = process.env.MOBILE_SITE_DIR;
      if (dir && fs.existsSync(path.join(dir, 'index.html'))) return send(200, fs.readFileSync(path.join(dir, 'index.html'), 'utf8').replace(/<head>/i, '<head><base href="/__site/">'), MIME['.html']);
      return send(200, sitePage(), MIME['.html']);
    }
    if (u.pathname.startsWith('/__site/') && process.env.MOBILE_SITE_DIR) {
      const f = path.normalize(path.join(process.env.MOBILE_SITE_DIR, decodeURIComponent(u.pathname.slice(8))));
      if (f.startsWith(path.normalize(process.env.MOBILE_SITE_DIR)) && fs.existsSync(f) && fs.statSync(f).isFile()) return send(200, fs.readFileSync(f), MIME[path.extname(f)] || 'application/octet-stream');
    }
    if (u.pathname.startsWith('/api/')) { const [status, body] = api(u.pathname, u.searchParams, req.method); return send(status, body); }
    const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname.slice(1));
    const f = path.normalize(path.join(ROOT, rel));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(404, 'not found', 'text/plain');
    return send(200, fs.readFileSync(f), MIME[path.extname(f)] || 'application/octet-stream');
  });
  return new Promise(r => server.listen(port || 0, '127.0.0.1', () => r(server)));
}

module.exports = { start, scenario, LONG };
if (require.main === module) start(Number(process.argv[2]) || 5599).then(s => console.log('mock app on', s.address().port));
