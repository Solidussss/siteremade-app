// Phase 5: rate limits for the PUBLIC (unauthenticated) intake endpoints —
// POST /api/public/lead, /api/public/chat, /api/public/chat/history and
// /api/public/site-submission (all in server.js's api() dispatcher).
//
// Before this file there was no limit on any of them (the only limiters in
// the app were signupAllowed() in server.js and the two password-recovery
// limiters), and /api/public/chat can trigger a paid OpenAI call per
// message. This is the same in-process, per-key sliding-window shape as
// those existing limiters (a Map of recent hit timestamps, keyed by client
// IP -- see clientIp() below, which all of them now share) — mirrored, not
// reinvented — with two additions they don't need: a periodic sweep so a
// flood of distinct keys can't grow the Map forever, and a retry-after hint
// for the 429 response. Phase 6 adds GET /api/public/analytics-config-by-project
// (a read, per IP).
//
// KNOWN SCALING LIMIT (explicit, by design for now): every limiter here is
// an in-memory Map inside ONE Node process. Correct for this app's current
// deployment -- a single Railway replica (RAILWAY-DEPLOY.md) -- but with N
// replicas each one counts separately (effective limits become N x these
// numbers) and a restart/redeploy resets every window. Scaling trigger:
// move these counters to shared storage (e.g. a Supabase table with an
// atomic upsert, or Redis) BEFORE running more than one replica.
'use strict';

// Phase 6: which address a limit is keyed on. This app's production host is
// Railway (RAILWAY-DEPLOY.md), whose edge proxy terminates every public
// request. Railway's own docs list `X-Real-IP` as the header the proxy sets
// "for identifying client's remote IP" (docs.railway.com/networking/
// public-networking/specs-and-limits) -- and do NOT document
// X-Forwarded-For at all. Railway staff answers on how the edge treats a
// client-sent X-Forwarded-For have disagreed over time (strip vs append,
// leftmost vs rightmost entry), and at least one team measured that a
// forged X-Forwarded-For value reached their app intact and let them rotate
// past a limiter; X-Real-IP, by contrast, was confirmed overwritten by the
// edge ("the client can no longer set the X-Real-Ip header"). So:
//   1. X-Real-IP        -- set by Railway's edge, not client-controllable there;
//   2. else the RIGHTMOST X-Forwarded-For entry -- the address the nearest
//      proxy itself saw (never the leftmost, which is whatever the client
//      typed when a proxy appends); only reached when no X-Real-IP exists,
//      i.e. not on Railway (local runs, tests, a different single proxy);
//   3. else the socket address.
// The previous version keyed on the FIRST X-Forwarded-For entry, which any
// client could rotate per request to dodge every per-IP limit.
// Assumption this relies on: the app is only reachable through Railway's
// edge. If it is ever exposed directly (or behind a proxy that does not
// overwrite X-Real-IP), a client could set X-Real-IP itself -- revisit then.
function clientIp(req) {
  const h = (req && req.headers) || {};
  const realIp = String(h['x-real-ip'] || '').trim();
  if (realIp && realIp.length <= 100 && !realIp.includes(',')) return realIp;
  const xff = String(h['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
  if (xff.length) return xff[xff.length - 1].slice(0, 100);
  return String((req && req.socket && req.socket.remoteAddress) || 'unknown');
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
// Phase 6: the analytics bootstrap on a customer's exported site asks for its
// tracker config once per page view; generous per IP, it's a cheap read.
const analyticsConfigPerIp = makeLimiter({ windowMs: 10 * MIN, max: 300 });
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
    // Honest about the scope of these numbers (see the header comment).
    scope: 'per app process (in-memory); move to shared storage before running more than one replica',
  };
}

module.exports = {
  clientIp, makeLimiter, describe,
  publicLeadPerIp, publicChatPerIp, publicChatHistoryPerIp, siteSubmissionPerProjectIp, analyticsConfigPerIp, leadsPerWorkspace, chatAiPerWorkspace,
};
