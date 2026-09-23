// Supabase password recovery ("Forgot password?" -> reset). Sibling to
// routes/google-signin.js -- same file shape, same publicOrigin() helper,
// same "the server proxies every Supabase Auth operation, the browser
// never talks to Supabase directly" convention this whole app already
// follows (login, signup, and the existing Google OAuth handoff all work
// this way; see lib/context.js's own header comment on why).
//
// No service-role client is used for any auth mutation in this file (db is
// only used below to check profile/workspace existence and write an audit
// row -- read-only-ish bookkeeping, never a credential change). Both real
// auth steps run against an anon-key client, which is exactly how
// Supabase's own documented password-recovery flow is meant to work: a
// person proves they control their inbox by receiving Supabase's own
// recovery email, which hands back a short-lived recovery session (an
// access_token + refresh_token pair); calling auth.setSession() with that
// pair and then auth.updateUser({ password }) is Supabase's own
// supported, non-privileged way to let that session -- and only that
// session -- change its own password. There's no documented reason to
// reach for db (service-role) here: it would only be needed to change a
// DIFFERENT user's password without them proving inbox control at all,
// which is exactly the opposite of what "forgot password" should ever do.
//
// setSession()/updateUser()/signOut() are deliberately NOT called on the
// shared `anon` singleton from lib/context.js. Real supabase-js tracks one
// ambient "current session" per client INSTANCE, and setSession/
// updateUser/signOut all act on that ambient session rather than an
// explicit token -- unlike getUser(token)/signInWithPassword()/
// refreshSession({refresh_token}), which this app's other routes always
// call with an explicit token, so they're unaffected by this. `anon` is
// constructed once at process startup and shared by every concurrent
// request; if this route called setSession()+updateUser() on that shared
// instance, two password resets (or a reset racing literally any other
// request that happens to touch `anon`'s session state) landing in the
// same tick of the event loop could interleave between awaits and let one
// request's updateUser() apply to the OTHER request's ambient session --
// i.e. one visitor's password submission silently changing a different
// account's password. freshAuthClient() below sidesteps this the way
// Supabase's own guidance for server-side code does: build a short-lived,
// request-scoped client for exactly these two calls, used once and
// discarded, so this route's ambient-session state can never leak between
// requests. (forgot-password's resetPasswordForEmail() call further down
// doesn't establish or depend on a session, so it stays on the shared
// `anon` client like every other read-style call in this app.)
const { createClient } = require('@supabase/supabase-js');
const { anon, db, authCookies, membershipsFor, sendJson: json, readJsonBody: readJson } = require('../lib/context');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
function freshAuthClient() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
function publicOrigin(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

// Same per-IP sliding-window shape as server.js's own signupAttempts/
// signupAllowed (the one existing rate-limit pattern in this app) --
// mirrored rather than reinvented, but kept local to this file since
// server.js's version isn't exported and each route file is already
// self-contained by convention (see routes/website-builder-handoff.js).
// Two separate windows: requesting a reset email is the more abuse-prone
// action (spamming someone's inbox, or probing many emails), so it gets
// the tighter cap; submitting a password against an already-issued
// recovery session is mostly just a real person occasionally mistyping,
// so it gets a more generous one.
function makeLimiter(windowMs, max) {
  const hits = new Map();
  return function allowed(req) {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    const t = Date.now();
    const recent = (hits.get(ip) || []).filter(x => t - x < windowMs);
    if (recent.length >= max) return false;
    recent.push(t);
    hits.set(ip, recent);
    return true;
  };
}
const forgotPasswordAllowed = makeLimiter(3600000, 5); // 5/hour/IP, matches signupAllowed exactly
const resetPasswordAllowed = makeLimiter(3600000, 10); // 10/hour/IP -- room for a mistyped password or two

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GENERIC_SENT_MESSAGE = 'If an account exists for that email, we sent a password reset link.';
const GENERIC_INVALID_MESSAGE = 'This reset link is invalid or has expired. Request a new one.';

module.exports = function registerPasswordRecoveryRoutes(router) {
  router.post('/api/auth/forgot-password', { auth: 'none' }, async (req, res) => {
    if (!anon) return json(res, 503, { ok: false, message: 'Supabase auth is not configured.' });
    if (!forgotPasswordAllowed(req)) return json(res, 429, { ok: false, message: 'Too many requests. Try again later.' });
    const bodyIn = await readJson(req);
    const email = String(bodyIn.email || '').trim().toLowerCase();
    // Malformed input is a real validation error, safe to say so (spec
    // item C) -- this is not an account-existence leak, since it's true
    // for literally any input shaped like this, account or not.
    if (!email || !EMAIL_RE.test(email) || email.length > 254) {
      return json(res, 400, { ok: false, message: 'Enter a valid email address.' });
    }
    // Deliberately ignore the result. Supabase's own resetPasswordForEmail
    // does not distinguish "no such user" in its response, and this route
    // never inspects the outcome differently by branch, network failure
    // included -- the response to the browser is identical either way, so
    // there is no timing or content signal here that reveals whether the
    // address has an account.
    try {
      await anon.auth.resetPasswordForEmail(email, { redirectTo: `${publicOrigin(req)}/?password_reset=1` });
    } catch (e) {
      console.error('[password-recovery] resetPasswordForEmail:', e && e.message);
    }
    return json(res, 200, { ok: true, message: GENERIC_SENT_MESSAGE });
  });

  router.post('/api/auth/reset-password', { auth: 'none' }, async (req, res) => {
    if (!anon || !db) return json(res, 503, { ok: false, message: 'Supabase auth is not configured.' });
    if (!resetPasswordAllowed(req)) return json(res, 429, { ok: false, message: 'Too many attempts. Try again later.' });
    const bodyIn = await readJson(req);
    const accessToken = String(bodyIn.accessToken || '').trim();
    const refreshToken = String(bodyIn.refreshToken || '').trim();
    const password = String(bodyIn.password || '');
    if (!accessToken || !refreshToken) return json(res, 400, { ok: false, message: GENERIC_INVALID_MESSAGE });
    if (password.length < 8) return json(res, 400, { ok: false, message: 'Password must be at least 8 characters.' });

    // A fresh, request-scoped client -- see this file's header comment for
    // why setSession()/updateUser() must never run on the shared `anon`
    // singleton. Establishing the recovery session IS the proof this is a
    // legitimate request -- an invalid, forged, or already-expired token
    // pair fails here, before anything is written. Never logged: not the
    // tokens themselves, not the password, only e.message on the way to a
    // sanitized reply below.
    const scoped = freshAuthClient();
    const established = await scoped.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    if (established.error || !established.data || !established.data.session) {
      return json(res, 401, { ok: false, message: GENERIC_INVALID_MESSAGE });
    }
    const updated = await scoped.auth.updateUser({ password });
    if (updated.error || !updated.data || !updated.data.user) {
      return json(res, 401, { ok: false, message: GENERIC_INVALID_MESSAGE });
    }
    // updateUser() only ever mutates the auth.users row's password hash --
    // it cannot touch id (the UUID this pass must not change -- verified
    // by primtest/v15-password-recovery-test.js), profiles.role,
    // workspace_members, or any RLS policy. See this file's own header for
    // why no service-role call is anywhere in this route.
    const userId = updated.data.user.id;
    const email = updated.data.user.email;

    // Mirrors /api/auth/login's own exact post-session checks (server.js)
    // so a reset for an account with no profile/workspace fails the same
    // clean way login already does, rather than leaving a signed-in-but-
    // broken client state.
    const profile = (await db.from('profiles').select('*').eq('id', userId).maybeSingle()).data;
    if (!profile) {
      await scoped.auth.signOut().catch(() => {});
      return json(res, 403, { ok: false, message: 'This account has no SiteRemade profile.' });
    }
    const workspaces = await membershipsFor(userId, profile.role === 'owner');
    if (!workspaces.length) {
      await scoped.auth.signOut().catch(() => {});
      return json(res, 403, { ok: false, message: 'This account has no workspace access.' });
    }
    const cookies = authCookies(established.data.session);
    cookies.push(`sr_workspace=${encodeURIComponent(workspaces[0].id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    // Best-effort audit trail entry -- same table/shape signup already
    // writes to (server.js's audit()), email only, never a password or
    // any token.
    try { await db.from('audit_logs').insert({ user_id: userId, workspace_id: workspaces[0].id, action: 'account.password_reset', detail: email }); } catch (e) { /* non-fatal */ }
    return json(res, 200, { ok: true, user: { name: profile.name, email, role: profile.role } }, cookies);
  });
};
