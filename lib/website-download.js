// The purchased-website ZIP handoff, proxied from the SiteRemade builder to the customer's browser
// (GET /api/app/website/download and /api/app/website/projects/:projectId/download -- routes/website-bridge.js).
//
// Ownership, not subscription: a customer who bought a website can download its files forever, with or without a
// Workspace subscription, and without signing into the builder -- the builder checks purchase and ownership itself
// from the customer's own verified token.
//
// Bytes are passed through exactly: the builder's body is read as an ArrayBuffer (never text, never JSON-parsed),
// re-sent with its length, and the builder's filename is kept. A failure keeps the builder's specific reason
// (compile_failed, package_failed, not_purchased, ...) in the response and in the log line, with a message a customer
// can act on. No token, cookie or file content is ever logged.
'use strict';

const CUSTOMER_MESSAGES = {
  not_found: 'That website could not be found for this account.',
  not_purchased: 'This website hasn’t been purchased yet, so its files aren’t available to download.',
  snapshot_missing: 'The purchased version of your website could not be found. SiteRemade has been notified — please contact support.',
  compile_failed: 'Your website files could not be built right now. SiteRemade has been notified — please try again shortly or contact support.',
  package_failed: 'Your website files could not be packaged right now. Please try again shortly.',
  artifact_missing: 'Your website files could not be packaged right now. Please try again shortly.',
  storage_unavailable: 'Your website files could not be prepared right now. Please try again shortly.',
  stream_failed: 'The download was interrupted. Please try again.',
  bridge_timeout: 'Preparing your website files took too long. Please try again.',
  bridge_unavailable: 'The SiteRemade builder couldn’t be reached. Please try again shortly.',
  bridge_unauthenticated: 'Your sign-in couldn’t be confirmed with the builder. Sign out and back in, then try again.',
};

function safeDisposition(value) {
  const v = String(value || '');
  return /^attachment;/i.test(v) && !/[\r\n]/.test(v) ? v : 'attachment; filename="SiteRemade-website.zip"';
}

// r: the bridge's callBinary result { status, buffer, headers, error? }
function describeFailure(r) {
  if (!r || r.status === 0) return { status: r && r.error === 'timeout' ? 504 : 502, code: r && r.error === 'timeout' ? 'bridge_timeout' : 'bridge_unavailable' };
  let body = null;
  try { body = r.buffer && r.buffer.length < 64 * 1024 ? JSON.parse(r.buffer.toString('utf8')) : null; } catch (e) { body = null; }
  const err = (body && body.error) || {};
  if (r.status === 401) return { status: 502, code: 'bridge_unauthenticated' };
  const code = typeof err.code === 'string' ? err.code.slice(0, 60) : `builder_http_${r.status}`;
  const status = r.status === 404 ? 404 : r.status === 403 ? 403 : r.status === 429 ? 429 : 502;
  return { status, code, stage: typeof err.stage === 'string' ? err.stage.slice(0, 40) : undefined, deploymentId: typeof err.deploymentId === 'string' ? err.deploymentId.slice(0, 60) : undefined };
}

async function sendWebsiteDownload({ bridge, token, projectId, res, json, log = console }) {
  const started = Date.now();
  const r = await bridge.downloadWebsite(token, projectId);
  const type = r && r.headers && r.headers.get ? String(r.headers.get('content-type') || '') : '';
  if (r && r.status === 200 && r.buffer && r.buffer.length > 0 && /^application\/zip\b/i.test(type)) {
    log.log('[handoff] ' + JSON.stringify({ via: 'client-app', projectId, stage: 'proxied', bytes: r.buffer.length, deploymentId: r.headers.get('x-siteremade-deployment') || null, ms: Date.now() - started }));
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': r.buffer.length,
      'Content-Disposition': safeDisposition(r.headers.get('content-disposition')),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(r.buffer);
  }
  const f = r && r.status === 200 ? { status: 502, code: 'not_a_zip' } : describeFailure(r);
  log.error('[handoff] ' + JSON.stringify({ via: 'client-app', projectId, stage: 'failed', builderStatus: r ? r.status : 0, code: f.code, builderStage: f.stage || null, deploymentId: f.deploymentId || null, ms: Date.now() - started }));
  return json(res, f.status, { ok: false, code: f.code, stage: f.stage, message: CUSTOMER_MESSAGES[f.code] || 'Your website files could not be prepared. Please try again shortly or contact SiteRemade.' });
}

module.exports = { sendWebsiteDownload, describeFailure, CUSTOMER_MESSAGES };
