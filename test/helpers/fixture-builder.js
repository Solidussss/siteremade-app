'use strict';
// A stand-in for the SiteRemade builder's /api/app-bridge/* contract, from fixtures: each bearer token is one builder
// account with its own projects, and every answer is scoped to the token (another account's project id is a 404, a
// draft has no purchased preview or download), like the real builder (server.js app-bridge routes). The real builder
// is exercised by test/cold-start-e2e.test.js; this one makes the app's own rules cheap to test exhaustively.
const http = require('http');
const u0 = req => new URL(req.url, 'http://builder.test');

// project: { projectId, name, mode, status, revision, createdAt, updatedAt, purchaseRef, purchasedAt, purchasedRevision, publishedRevision, removed }
// account: { projects, admin (true: the website admin -- the real builder decides that from the verified email), email }
// A REMOVED project (the website admin's deletion -- the real builder's migrations/0013) is gone from every answer to its
// owner, like the real builder; the admin routes list every account's active projects and remove one (idempotent).
function startFixtureBuilder(accounts) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    seen.push({ method: req.method, url: req.url, token });
    const send = (status, body, type) => { const b = type ? body : JSON.stringify(body); res.writeHead(status, Object.assign({ 'Content-Type': type || 'application/json' }, type === 'application/zip' ? { 'Content-Disposition': 'attachment; filename="site.zip"' } : {})); res.end(b); };
    const account = accounts[token];
    if (!account) return send(401, { ok: false, error: { code: 'unauthenticated', message: 'Sign in again.' } });
    const projects = account.projects;
    const active = p => p.status !== 'archived' && !p.removed;
    if (u0(req).pathname.startsWith('/api/app-bridge/admin/')) {
      if (!account.admin) return send(403, { ok: false, error: { code: 'forbidden', message: 'Only the SiteRemade admin account can delete websites.' } });
      const everyone = Object.values(accounts).flatMap(a => (a.projects || []).map(p => ({ p, a })));
      const path0 = u0(req).pathname;
      if (req.method === 'GET' && path0 === '/api/app-bridge/admin/websites') return send(200, { ok: true, websites: everyone.filter(x => active(x.p)).map(x => ({ projectId: x.p.projectId, name: x.p.name, mode: x.p.mode || 'business', status: x.p.status, isPurchased: x.p.status === 'purchased', ownerEmail: x.a.email || '', updatedAt: x.p.updatedAt })) });
      const m = /^\/api\/app-bridge\/admin\/websites\/([^/]+)\/remove$/.exec(path0);
      if (req.method === 'POST' && m) { const hit = everyone.find(x => x.p.projectId === decodeURIComponent(m[1])); if (!hit) return send(404, { ok: false, error: { code: 'not_found', message: 'Website not found.' } }); const already = !!hit.p.removed; hit.p.removed = hit.p.removed || new Date().toISOString(); return send(200, { ok: true, projectId: hit.p.projectId, removed: true, alreadyRemoved: already, removedAt: hit.p.removed, status: hit.p.status }); }
      return send(404, {});
    }
    const owned = id => projects.find(p => p.projectId === id && active(p));
    const purchased = () => projects.filter(p => p.status === 'purchased' && !p.removed).sort((a, b) => String(b.purchasedAt).localeCompare(String(a.purchasedAt)));
    const delivered = p => (p.publishedRevision != null ? p.publishedRevision : p.purchasedRevision);
    const summary = p => ({ ok: true, hasCanonicalProject: true, projectId: p.projectId, name: p.name, status: p.status, revision: p.revision, purchaseRef: p.purchaseRef || null,
      createdAt: p.createdAt, updatedAt: p.updatedAt, deploymentStatus: 'not_deployed', businessName: p.name, domains: [], lastPublishedAt: null,
      publishedRevision: p.publishedRevision != null ? p.publishedRevision : null, purchasedRevision: p.purchasedRevision != null ? p.purchasedRevision : null,
      hasUnpublishedChanges: p.status === 'purchased' && p.revision > delivered(p), canEdit: true, canPublish: p.status === 'purchased', previewUrl: null, liveUrl: null });
    const u = new URL(req.url, 'http://builder.test'); const parts = u.pathname.split('/').filter(Boolean); // api, app-bridge, ...
    if (u.pathname === '/api/app-bridge/website') {
      const p = purchased()[0] || projects.filter(x => x.status === 'draft' || x.status === 'checkout_pending').sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
      return p ? send(200, summary(p)) : send(404, { ok: false, hasCanonicalProject: false, error: { code: 'no_project', message: 'No website.' } });
    }
    if (u.pathname === '/api/app-bridge/websites') {
      return send(200, { ok: true, websites: projects.filter(active).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(p => ({
        projectId: p.projectId, name: p.name, businessName: p.name, mode: p.mode || 'business', status: p.status, revision: p.revision, createdAt: p.createdAt, updatedAt: p.updatedAt,
        isPurchased: p.status === 'purchased', purchaseRef: p.purchaseRef || null, purchasedAt: p.purchasedAt || null, purchasedRevision: p.purchasedRevision != null ? p.purchasedRevision : null,
        hasPurchaseSnapshot: p.status === 'purchased', canEdit: true, canPublish: p.status === 'purchased', hasUnpublishedChanges: false })) });
    }
    if (u.pathname === '/api/app-bridge/website/candidates') return send(200, { ok: true, candidates: purchased().map(p => ({ projectId: p.projectId, name: p.name, businessName: p.name, status: p.status, purchaseRef: p.purchaseRef, revision: p.revision, purchasedAt: p.purchasedAt, domains: [], deploymentStatus: 'not_deployed', hasUnpublishedChanges: false })) });
    if (parts[2] === 'website' && parts[3]) {
      const p = owned(decodeURIComponent(parts[3]));
      if (!p) return send(404, { ok: false, error: { code: 'not_found', message: 'Website not found.' } });
      if (!parts[4]) return send(200, summary(p));
      if (parts[4] === 'preview') {
        if (u.searchParams.get('source') === 'draft') return send(200, `<html data-project="${p.projectId}" data-source="draft" data-revision="${p.revision}"></html>`, 'text/html');
        if (p.status !== 'purchased') return send(404, { ok: false, error: { code: 'not_found', message: 'Purchased website not found.' } });
        return send(200, `<html data-project="${p.projectId}" data-source="published" data-revision="${delivered(p)}"></html>`, 'text/html');
      }
      if (parts[4] === 'download') {
        if (p.status !== 'purchased') return send(403, { ok: false, error: { code: 'not_purchased', message: 'Not purchased.' } });
        return send(200, Buffer.from(`PK\u0003\u0004 ${p.projectId} revision ${delivered(p)}`), 'application/zip');
      }
    }
    return send(404, {});
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}`, seen, stop: () => new Promise(x => server.close(x)) })));
}

module.exports = { startFixtureBuilder };
