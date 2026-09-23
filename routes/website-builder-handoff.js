// SiteRemade unified-login pass (generator-side spec:
// SITE-PROJECT-V15-UNIFIED-LOGIN.md) -- the APP HALF of the session
// handoff. The generator (landing/siteremade, a separate codebase/
// deployment) already implements the GENERATOR half: it sends a visitor
// here (via a plain link, never a fetch) with
// ?handoff_return=<generator url>&handoff_mode=session|link when they
// click "Continue with SiteRemade" or "Connect your SiteRemade account",
// and it knows how to consume a
// #bridge=<mode>&access_token=...&expires_in=... fragment on return (see
// its own script.js, handleIdentityBridgeFragment). This route is what
// mints that return trip.
//
// Deliberately mirrors this app's own pre-existing Google OAuth
// implicit-grant pattern (routes/google-signin.js + v18-client.js) rather
// than inventing a new transport: the session token travels in a URL
// FRAGMENT, never a query string or a response body, so it never lands in
// a server access log, a Referer header, or browser history search
// entries the way a query param would.
//
// No new access token is minted here -- getAuthUser() (lib/context.js)
// already verifies (and silently refreshes, if needed) this request's own
// sr_access/sr_refresh session on every authenticated call this app
// serves; the "session" attribute on the router registration below reuses
// that exact same, single verification path. What travels to the
// generator is simply the resulting already-valid access token value,
// short-lived by Supabase's own normal token lifetime -- not a new
// long-lived credential invented for this feature.
const GENERATOR_ORIGIN = String(process.env.WEBSITE_BUILDER_URL || 'https://siteremade.com').replace(/\/$/, '');

// Never an open redirect: the return destination this route will 302 to
// must be the generator's own known origin and nothing else -- mirrors
// the generator's own symmetric invariant on its side (its script.js's
// startSharedIdentityHandoff always derives the handoff_return it sends
// FROM window.location.origin, never from anything else; see that file's
// own comment, and primtest/v15-unified-login-test.js item 37 there,
// which source-verifies it). A request carrying anything else just falls
// back to this app's one configured generator origin instead of erroring
// -- a mis-set or missing `return` should degrade to "send them to the
// generator's homepage," not break the handoff.
function safeReturnBase(requested) {
  if (requested) {
    try {
      const u = new URL(requested);
      if (u.origin === GENERATOR_ORIGIN) return requested;
    } catch (e) { /* fall through to the default below */ }
  }
  return GENERATOR_ORIGIN + '/';
}

module.exports = function registerWebsiteBuilderHandoffRoutes(router) {
  // GET, not POST: this is a plain navigation the browser follows itself
  // (clicked from the generator's own <a>/button, or from this app's own
  // "Website Builder" nav link, or driven by app.js's
  // maybeRedirectForWebsiteBuilderHandoff() right after a fresh sign-in) --
  // never a fetch() call, so it works exactly like any other link even if
  // JavaScript is slow to load, and never needs a CSRF token the way a
  // mutating POST would.
  router.get('/handoff/website-builder', { auth: 'session' }, async (req, res, ctx) => {
    const u = ctx && ctx.u ? ctx.u : new URL(req.url, 'http://internal');
    const mode = u.searchParams.get('mode') === 'link' ? 'link' : 'session';
    const target = new URL(safeReturnBase(u.searchParams.get('return')));
    // c is this route's getAuthUser() result -- { user, profile, access }.
    // See this file's own header comment on why `access` (not a freshly
    // minted token) is what travels.
    const access = ctx.c.access;
    target.hash = `bridge=${mode}&access_token=${encodeURIComponent(access)}&expires_in=3600`;
    res.writeHead(302, { Location: target.toString(), 'Cache-Control': 'no-store' });
    res.end();
  });
};
