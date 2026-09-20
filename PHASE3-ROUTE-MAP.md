# Phase 3 route map

Referenced by header comments throughout `routes/*.js` and the trimmed
`vNN-*.js` files. This is the inventory those comments point to: what moved
onto `lib/router.js`, what's still on the old `http.createServer` monkeypatch
chain and why, and which `vNN-*.js` files remain in `v17-server.js`'s
require chain.

## Routes on the router (routes/*.js, registered via routes/index.js)

52 routes across 15 modules, dispatched by `lib/router.js`'s `Router` before
`server.js`'s legacy `api()` dispatcher or static file serving ever run
(see `server.js`'s top-level request handler).

| Module | Method + path | Auth |
|---|---|---|
| integrations.js | GET /api/app/integrations/status | user |
| twilio-provisioning.js | POST /api/app/integrations/twilio/number/search | user |
| twilio-provisioning.js | POST /api/app/integrations/twilio/number/purchase | user |
| google-ads.js | GET /api/app/google-ads/start | user |
| google-ads.js | GET /api/app/google-ads/callback | user |
| google-ads.js | GET /api/app/google-ads/status | user |
| google-ads.js | GET /api/app/google-ads/accounts | user |
| google-ads.js | POST /api/app/google-ads/select | user |
| google-ads.js | GET /api/app/google-ads/campaigns | owner |
| ad-intelligence.js | GET /api/app/ad-control/settings | owner |
| ad-intelligence.js | POST /api/app/ad-control/settings | owner |
| ad-intelligence.js | POST /api/app/ad-recommendations/sync | owner |
| ad-intelligence.js | GET /api/app/ad-recommendations | owner |
| ad-intelligence.js | POST /api/app/ad-recommendations/review | owner |
| twilio-existing-number.js | POST /api/app/integrations/twilio/existing/check | user |
| twilio-existing-number.js | POST /api/app/integrations/twilio/existing/start | user |
| twilio-existing-number.js | POST /api/app/integrations/twilio/existing/verify | user |
| twilio-existing-number.js | POST /api/app/integrations/twilio/existing/status | user |
| twilio-existing-number.js | POST /api/app/integrations/twilio/existing/authorize | user |
| twilio-stripe.js | POST /api/webhooks/twilio | none |
| twilio-stripe.js | GET /api/app/integrations/twilio/status | user |
| twilio-stripe.js | POST /api/app/integrations/twilio/connect | user |
| twilio-stripe.js | POST /api/app/integrations/twilio/send | user |
| twilio-stripe.js | POST /api/app/integrations/twilio/sync | user |
| twilio-stripe.js | DELETE /api/app/integrations/twilio | user |
| twilio-stripe.js | GET /api/app/integrations/stripe/status | user |
| twilio-stripe.js | POST /api/app/integrations/stripe/connect | user |
| market-finder.js | POST /api/v19/prospects/search | user |
| mailbox.js | GET /api/app/mailbox/status | user |
| mailbox.js | GET /api/app/mailbox/connect | user |
| mailbox.js | GET /api/app/gmail/callback | user |
| mailbox.js | GET /api/app/mailbox/callback/:provider | user |
| mailbox.js | POST /api/app/mailbox/sync | user |
| mailbox.js | DELETE /api/app/mailbox | user |
| google-signin.js | GET /auth/google | none |
| google-signin.js | POST /api/auth/oauth-session | none |
| gmail-direct.js | GET /api/app/gmail/start | none (redirects on error, own try/catch) |
| analytics-bootstrap.js | GET /siteremade-analytics.js | none |
| analytics-bootstrap.js | GET /api/public/analytics-config | none |
| umami-analytics.js | GET /api/app/umami/analytics | user |
| umami-analytics.js | POST /api/app/umami/analytics | user |
| umami-analytics.js | GET /api/app/analytics/website | user |
| umami-analytics.js | POST /api/app/analytics/website | user |
| google-calendar.js | GET /api/app/integrations/google-calendar/status | user |
| google-calendar.js | GET /api/app/integrations/google-calendar/start | user |
| google-calendar.js | POST /api/app/integrations/google-calendar/sync | user |
| legacy-twilio-inbound.js | POST /api/public/twilio/inbound | none (own Twilio signature check) |
| legacy-twilio-inbound.js | GET /api/v19/admin/overview | none (own combined 403 check — see file header) |
| daily-workflow.js | GET /api/app/workflow/state | user |
| daily-workflow.js | PUT /api/app/workflow/followups/:leadId | user |
| daily-workflow.js | DELETE /api/app/workflow/followups/:leadId | user |
| daily-workflow.js | PUT /api/app/workflow/prospect-stages | user |

## What's still on the old monkeypatch chain, and why

`v17-server.js`'s require chain (in order — earliest-required file's
`http.createServer` wrapper gets first look at every request):

```
v32-google-env-aliases.js
  └─ v40-twilio-subaccounts.js
v29-mail-server.js
v30-google-auth.js
v17-preload.js
server.js  (builds routes/index.js's router, then falls back to the legacy
            api() dispatcher and static file serving)
```

Four files still patch `http.createServer` directly:

- **v40-twilio-subaccounts.js** — subaccount-hosted Twilio numbers. Its
  webhook/send/sync handlers read the request, and when a number is *not*
  subaccount-hosted they fall through (`return listener(req, res)`) to the
  main-account implementations now in `routes/twilio-stripe.js`. This is a
  content-based fallthrough, not an auth check — the router has no notion
  of "try the next handler for this path" — so it can't move onto the
  router without either duplicating the subaccount-lookup logic into the
  router layer or restructuring how the router resolves a single path to
  multiple handlers. Left as-is, documented, and covered by a regression
  test in `smoketest.sh` (the previously-hanging-webhook fix, see below).
- **v29-mail-server.js** — `POST /api/app/conversations/:id/messages` falls
  through to server.js's generic Resend+Twilio implementation when no
  mailbox is connected or the lead has no email on file. Same
  content-based-fallthrough shape as above; same reason for staying put.
- **v30-google-auth.js** — wraps `res.end` for `GET /` and `/index.html` to
  inject the "Continue with Google" button. This injection never actually
  fires (see **Known pre-existing bugs** below) but the routes it used to
  define (`GET /auth/google`, `POST /api/auth/oauth-session`) have moved to
  `routes/google-signin.js`. The wrapper itself is left in place rather
  than removed, since removing dead-in-practice code that's tied to an
  unresolved product question (should the button work, or was it meant to
  be gone?) is a product decision, not a structural cleanup.
- **v17-preload.js** — serves `index.html` for `GET /` / `/index.html` via
  `enhancedHtml()` (now a plain file read — see the frontend-consolidation
  note in `index.html`'s own header comment) and wraps `res.end` around
  `POST`/`PATCH /api/app/website-updates` to fire an email notification
  based on that (not-yet-migrated) route's response body — a
  content-based, cross-cutting concern, not a route in its own right.

## Known pre-existing bugs found during migration (neither introduced by it)

1. **Fixed** — `POST /api/webhooks/twilio` would hang forever for inbound
   SMS to a main-account (non-subaccount) number: `v40-twilio-subaccounts.js`
   reads the whole request body first; when it falls through, the
   downstream handler used to read the same already-drained stream again,
   which never resolves. Fixed by memoizing the parsed body on the request
   object (`req.__twilioFormBody`) in both `v40-twilio-subaccounts.js` and
   `routes/twilio-stripe.js`. Verified pre-existing against an isolated
   checkout of the commit before this migration started. Regression-tested
   in `smoketest.sh`.
2. **Left as-is, documented** — the "Continue with Google" button
   (`v30-google-auth.js`) can never appear. Root cause: Node's
   `res.getHeader()` does not reflect headers set via `res.writeHead()`
   (only ones set via `res.setHeader()` before it) — and every response in
   this codebase sets its content type through `res.writeHead()`. The
   injection wrapper gates on `res.getHeader('Content-Type')`, which is
   therefore always empty for every response it ever sees, so the
   `type.includes('text/html')` check never passes and `injectGoogleAuth()`
   is never called. Confirmed empirically (traced with instrumented copies
   of the file, restored afterward) and confirmed pre-existing against an
   isolated checkout of the commit before this migration started. Left
   unfixed because fixing it changes user-facing behavior (a login button
   would newly appear) — that's a product decision, not a structural one.

## Frontend consolidation

`v20-assets.js`, `v20-loader.js`, `v22-assets.js`, `v34-gmail-direct.js`,
`v37-static-integrations.js`, `v40-existing-number.js`, and
`v45-ad-intelligence.js` used to monkeypatch `fs.readFileSync` to inject a
`<link>`/`<script>` tag or HTML fragment into `index.html` on every single
request. Every one of those patches was unconditional (guarded only by
`if (!html.includes(...))`, i.e. "add this if it's not already there"), so
the composed output never varied — this was pure repeated work with no
behavioral purpose. The composed output was captured from a live server and
pasted into `index.html` directly (see the comment at its top); the seven
files were deleted along with their `require()`s. `v17-preload.js`'s
`enhancedHtml()` is now a plain `fs.readFileSync` (it used to do the same
kind of injection for `v17`/`v18`/`v19`'s own tags).

The ~25 remaining `vNN-*-client.js` files (feature-specific browser scripts
loaded via the `<script>` tags now sitting statically in `index.html`) were
**not** touched — they're legitimate, already-separated per-feature modules,
not injection patches, and merging them into `app.js` is a much larger,
higher-risk undertaking (global function patching, execution-order
dependencies, `setTimeout`-based install polling) that belongs in the
folder/module reorganization phase, not this one.
