// Phase 5: rate limits for the PUBLIC (unauthenticated) intake endpoints —
// POST /api/public/lead, /api/public/chat, /api/public/chat/history and
// /api/public/site-submission (all in server.js's api() dispatcher).
//
// Before this file there was no limit on any of them (the only limiters in
// the app were signupAllowed() in server.js and the two password-recovery
// limiters), and /api/public/chat can trigger a paid OpenAI call per
// message. This is the same in-process, per-key sliding-window shape as
// those existing limiters (a Map of recent hit timestamps, keyed by client
// IP from the first X-Forwarded-For entry, falling back to the socket
// address) — mirrored, not reinvented — with two additions they don't need:
// a periodic sweep so a flood of distinct keys can't grow the Map forever,
// and a retry-after hint for the 429 response.
//
// Limits are per process (a restart or a second instance resets/splits
// them) — the same property the existing signup/password limiters have.
'use strict';

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'unknown').split(',')[0].trim() || 'unknown';
}

function makeLimiter({ windowMs, max }) {
  const hits = new Map();
  let lastSweep = Date.now();
  function sweep(t) {
    if (t - lastSweep < windowMs) return;
    lastSweep = t;
    for (const [k, arr] of hits) {
      const recent = arr.filter(x => t - x < windowMs);
      if (recent.length) hits.set(k, recent); else hits.delete(k);
    }
  }
  return {
    windowMs, max,
    // Records a hit for `key` and says whether it was allowed. A refused
    // hit is not recorded, so a blocked client's window still drains.
    take(key) {
      const t = Date.now();
      sweep(t);
      const recent = (hits.get(key) || []).filter(x => t - x < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + windowMs - t) / 1000)) };
      }
      recent.push(t);
      hits.set(key, recent);
      return { ok: true };
    },
  };
}

const MIN = 60 * 1000;
// Per client IP. Sized from real use: one visitor sends a handful of form
// posts at most; the chat widget sends one request per typed message and
// polls /chat/history every 5s while open (~120 per 10 minutes).
const publicLeadPerIp = makeLimiter({ windowMs: 10 * MIN, max: 10 });
const publicChatPerIp = makeLimiter({ windowMs: 10 * MIN, max: 40 });
const publicChatHistoryPerIp = makeLimiter({ windowMs: 10 * MIN, max: 240 });
// Site submissions usually arrive server-to-server from a generated site's
// own server (its SUBMISSION_BACKEND=webhook provider), so one IP carries
// every visitor of that site: keyed by project id + IP, looser than a
// single browser's allowance.
const siteSubmissionPerProjectIp = makeLimiter({ windowMs: 10 * MIN, max: 30 });
// Per workspace, not spoofable by rotating X-Forwarded-For: a ceiling on
// website leads (form + site submissions) a single business can receive in
// an hour, which also bounds the lead-alert emails/SMS each one triggers.
const leadsPerWorkspace = makeLimiter({ windowMs: 60 * MIN, max: 120 });
// Per workspace: how many chat replies per hour may use the paid AI
// provider. Past it, chat keeps working with the built-in canned replies
// (localAI in server.js) instead of refusing the visitor.
const chatAiPerWorkspace = makeLimiter({ windowMs: 60 * MIN, max: 300 });

// Plain description for staff (Admin) — derived from the real limiter
// settings above, so it can't drift from what is enforced.
function describe() {
  const per = l => `${l.max} per ${Math.round(l.windowMs / MIN)} min`;
  return {
    rateLimited: true,
    rules: [
      { endpoint: 'POST /api/public/lead', limit: `${per(publicLeadPerIp)} per IP; ${per(leadsPerWorkspace)} per workspace (shared with site submissions)` },
      { endpoint: 'POST /api/public/site-submission', limit: `${per(siteSubmissionPerProjectIp)} per project + IP; ${per(leadsPerWorkspace)} per workspace` },
      { endpoint: 'POST /api/public/chat', limit: `${per(publicChatPerIp)} per IP; AI replies ${per(chatAiPerWorkspace)} per workspace, then canned replies` },
      { endpoint: 'POST /api/public/chat/history', limit: `${per(publicChatHistoryPerIp)} per IP` },
    ],
  };
}

module.exports = {
  clientIp, makeLimiter, describe,
  publicLeadPerIp, publicChatPerIp, publicChatHistoryPerIp, siteSubmissionPerProjectIp, leadsPerWorkspace, chatAiPerWorkspace,
};
