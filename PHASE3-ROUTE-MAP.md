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

Not part of this migration but worth tracking here since it's just as
security-relevant: `POST /api/webhooks/stripe`, still in `server.js`'s
legacy `api()` dispatcher. It validates the `Stripe-Signature` header
(HMAC-SHA256 against `STRIPE_WEBHOOK_SECRET`, timing-safe compare) before
trusting the payload and is the one place `invoices.status` should
normally become `'Paid'` — see the production-readiness review below.

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
  fired before this pass (see **Known pre-existing bugs** below, now
  fixed) but the routes it used to define (`GET /auth/google`, `POST
  /api/auth/oauth-session`) have moved to `routes/google-signin.js`.
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
2. **Fixed** (production-readiness pass) — the "Continue with Google"
   button (`v30-google-auth.js`) could never appear. Two independent bugs:
   (a) Node's `res.getHeader()` does not reflect headers set via
   `res.writeHead()` (only ones set via `res.setHeader()` before it), and
   every response in this codebase sets its content type through
   `res.writeHead()` — so the injection wrapper's `res.getHeader('Content-
   Type')` check was always empty and `injectGoogleAuth()` was never
   called; (b) even with that fixed, its `res.removeHeader('Content-
   Length')` call (made from `res.end`, after `writeHead` already ran)
   throws `Cannot remove headers after they are sent` — Node precomputes
   the header block as soon as `writeHead` runs — which the surrounding
   try/catch was silently swallowing, so the button still wouldn't have
   appeared. Confirmed empirically (traced with instrumented copies of the
   file, restored afterward) and confirmed pre-existing against an
   isolated checkout of the commit before this migration started. Fixed by
   capturing headers at `writeHead` time and stripping `Content-Length`
   before it's sent for text/html responses (Node falls back to chunked
   encoding), with gzip handled by decompress → inject → recompress.
   Verified against a running server (button present in both plain and
   gzip responses) and covered by a new assertion in `ui-test.js`.

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

## Production-readiness review (before merging phase3/architecture-cleanup)

Context that shapes every finding below: `lib/context.js`'s `db` client is
built with the Supabase **service-role key**, which bypasses RLS entirely.
So the RLS policies in V48/V50/V51 are not what protect tenant isolation for
any request the app itself makes — they're a defense-in-depth backstop only
relevant if a key leaks or something ever queries via the `anon` role
directly (confirmed: `anon` is only ever used for `auth.getUser`/
`auth.refreshSession`, never a data query, and no Supabase client is ever
constructed in the browser). In their absence, tenant isolation depends
entirely on every route filtering by `workspace_id` itself.

**Fixed** (all covered by new/updated regression tests, see e2e-test.js):

- `server.js`'s `PATCH /api/app/invoices/:id` let any signed-in workspace
  member set `status:'Paid'` with no proof of payment — no `c.owner` check,
  unlike every other sensitive mutation in the same file. The verified
  payment path (`POST /api/webhooks/stripe`, HMAC-checked) already sets the
  same field the same way; the manual PATCH is now owner-gated (SiteRemade
  staff only) specifically for the `'Paid'` transition, so a workspace
  member can no longer self-report their own invoice as paid. Draft/
  Pending/Void are unaffected.
- `V51-DAILY-WORKFLOW-MIGRATION.sql` was missing the
  `grant ... to service_role` statements every other table in this schema
  has (see V48) — without them, `routes/daily-workflow.js`'s queries would
  fail with "permission denied" against a real Supabase project even though
  RLS and everything else in the file was correct. Added, matching V48's
  exact grant pattern.
- `lib/router.js`'s `add()` now throws on a duplicate method+pattern
  registration instead of silently letting the earlier-registered route win
  forever (no current route collides; this only guards against a future
  one reintroducing the exact "which file wins" ambiguity this router
  replaced).

**Fixed (production-readiness pass):**

1. **Cross-tenant lead lookup in the legacy single-tenant Twilio webhook —
   fixed.** `routes/legacy-twilio-inbound.js`'s `findLeadByPhone()` used to
   scan `leads` across **every workspace** (no `workspace_id` filter) and
   attach the inbound SMS to whichever matching lead was updated most
   recently, globally — a real cross-tenant risk if two tenants ever had a
   contact with the same phone number. Fixed by resolving the workspace
   deterministically first: `workspaceForReceivingNumber()` looks up
   `integration_connections` (`provider:'twilio'`, `status:'connected'`,
   `config.phoneNumber`) — the exact same table the modern per-tenant
   Twilio routes (`routes/twilio-stripe.js`, `v40-twilio-subaccounts.js`)
   already trust for this same mapping — for a row whose registered number
   matches the receiving `To` number, and only then runs `findLeadByPhone`
   scoped to that one workspace. No guessing was needed: this data already
   existed and was already the source of truth for the modern routes: the
   legacy route just wasn't using it yet.

   If `TWILIO_FROM` isn't registered in `integration_connections` at all
   (plausible — it predates that table, and this comment previously asked
   "is this endpoint still live for a real tenant, and if so which one?"
   without an answer available from this sandbox), the fix fails safe: the
   message is not attributed to any workspace, Twilio still gets its 200
   OK, and it is simply not logged to a lead — rather than falling back to
   the old cross-workspace scan, which would leave the exact vulnerability
   this fixes wide open for that one case. **Remaining product/ops
   question, not a blocker:** if `TWILIO_FROM` is still a live number for
   some real business today, that business's inbound SMS will stop being
   logged to a lead until someone connects that number to their workspace
   the normal way (`POST /api/app/integrations/twilio/connect`), which
   also moves them onto the fully-isolated modern path. Verified with a
   new `e2e-test.js` case: two workspaces sharing a phone number, asserting
   the message lands in the correct one and never the other, and that an
   unregistered number produces no cross-workspace guess.

**Found, needs a product/ops decision before merge — not changed:**

1. **`auth:'user'` (not `'owner'`) on workspace-wide Stripe/Twilio identity
   changes.** `POST /api/app/integrations/stripe/connect`, `.../twilio/
   connect`, and `.../twilio/existing/authorize` (a real Twilio LOA/porting
   submission) are reachable by any workspace member, not just an owner.
   On reflection this is consistent with the platform's actual ownership
   model — `role:'owner'` means SiteRemade *staff* (it's the role that sees
   every workspace, per `membershipsFor`), and a business's own Stripe/
   Twilio accounts are properly the business's own workspace members'
   responsibility to connect, not SiteRemade staff's. Recorded here in case
   that reading is wrong, but no fix applied.
2. **V48 migration risk against real production data — partially resolved,
   still needs someone with production access.** This sandbox has no
   Supabase credentials and no database connector, so none of this could be
   run against the real database; nothing below claims otherwise.
   What changed in `V48-SCHEMA-CATCHUP-MIGRATION.sql`: the two
   `create unique index` statements (on `integration_connections` and
   `ad_recommendations`) are now wrapped the same way the CHECK constraints
   below them already were — a duplicate-data failure is caught and skipped
   with a `RAISE NOTICE` instead of rolling back the entire migration
   script. That part of the risk (one bad table aborting the whole run) is
   fixed regardless of what production data actually looks like.
   What's still unresolved and *can't* be resolved without production
   access: if `integration_connections` (or `ad_recommendations`) was
   hand-created without a `workspace_id` column, `add column if not exists
   workspace_id ...` (no default, can't safely be made `not null` on an
   ALTER against a possibly non-empty table) leaves existing rows with a
   silent `NULL workspace_id` — invisible to `is_workspace_member()` and to
   the unique index. The migration now includes a `RAISE NOTICE` that
   reports the exact count of such rows the moment it's run, so this can no
   longer pass unnoticed — but it still can't be fixed here, because the
   correct workspace for an orphaned row isn't something that can be
   inferred.
   **`V48-PREFLIGHT-CHECK.sql`** (new, read-only, in the repo root) is the
   concrete next step: five SELECT-only queries that tell you, before ever
   running V48, whether these tables already exist, whether either unique
   index would collide with real duplicate data, and whether either table
   already has NULL-workspace_id rows. Have someone with production
   Supabase access run it and read the results before running V48 for
   real. If every query comes back empty (including "table doesn't exist
   yet"), V48 is safe to run as-is.

**Confirmed secure, no action needed:** all three Twilio webhook entry
points (main-account, subaccount, and the legacy single-tenant one)
validate `X-Twilio-Signature` before touching the database, with the
subaccount path correctly fetching and checking against the *subaccount's
own* auth token rather than the main account's. OAuth callbacks
(mailbox/Gmail/Outlook, Google Ads, Google Calendar) all HMAC-sign a
`{workspace, user, timestamp}` state server-side with a timing-safe compare
and a 10-minute TTL, so a callback can't be replayed against a different
workspace. No route was found echoing an OAuth token, API secret, or the
service-role key back to the browser.

## Performance review: login → usable dashboard

Profiled the exact path `app.siteremade.com → login → dashboard usable`
locally (payload sizes, request counts, and initialization architecture —
this environment has no live Railway/Supabase instance, so real network/
Supabase-latency numbers aren't included; see the note at the end).

**Root cause, in order of impact:** almost the entire cost was architecture
— what loaded before login and how often data got refetched after — not
raw payload size in isolation.

1. **~300KB of dashboard-only JS/CSS loaded before the login screen was
   even interactive.** 9 `<script>` tags plus 6 `<link rel="stylesheet">`
   tags in `index.html` were dashboard feature layers (mail, market finder,
   ad intelligence, calendar, daily workflow, the existing-number wizard,
   etc.) — none of them act on anything outside `#authScreen`'s hidden
   sibling elements, so none of them do anything until `app.js`'s
   `bootstrap()` succeeds and reveals the dashboard. Several of those 9
   further `import()` or `createElement('script')` another ~17 files.
   Measured via a full crawl of every static tag + dynamic `import()`/
   `createElement` load from `GET /`: **41 requests, ~396KB** before login
   was possible.
   **Fixed**: moved all 15 tags out of `index.html` into a
   `loadDashboardFeatureScripts()` call in `app.js`, fired exactly once,
   right where `bootstrap()` already reveals the dashboard
   (`qs('#authScreen').hidden=true`). Same files, same order (`script.async
   = false` preserves document order for dynamically-inserted scripts),
   same behavior — just triggered by successful login instead of by page
   load. **Before/after, pre-login:** 41 requests / ~396KB → **3 requests /
   ~177KB** (index.html + app.css + app.js — the only three things the
   login screen actually needs).
2. **A genuine duplicate load, found while measuring the above.**
   `v45-ad-intelligence-client.js` was both a static `<script>` tag AND
   `import()`-ed a second time from `v29-bootstrap.js` under a different
   URL (`?v=2` vs. no query), so the browser fetched and executed the
   whole file twice on every dashboard load — two submit listeners
   double-firing every ad-settings save, and two permanent
   `MutationObserver`s each watching the *entire document* for every DOM
   change for the rest of the page's life. **Fixed**: removed the
   redundant `import()` (see `v29-bootstrap.js`); verified via a targeted
   Playwright check that the file is now requested under exactly one URL.
3. **No response compression at all.** `server.js`'s static file server
   (`serve()`) and `v17-preload.js`'s separate `index.html` handler both
   sent full uncompressed bytes regardless of the client's
   `Accept-Encoding` header — pure transport waste for text that
   typically compresses 70-80%. **Fixed**: both now gzip when the client
   accepts it (verified byte-identical after decompression). Measured:
   `app.js` 79.4KB → 20.7KB (74% smaller), `index.html` 43.9KB → 10.4KB
   (76% smaller). Combined with fix #1, the three requests a fresh visitor
   needs before the login form is usable drop from **~396KB to roughly
   45-55KB on the wire** (index.html + app.css + app.js, all gzipped).
4. **Partially fixed (second production-readiness pass) — client/network
   cost addressed; backend query cost is not.** `app.js`'s `liveRefresh()`
   (driven by `startLiveSync()`'s `setInterval(..., 5000)`) re-runs the
   *entire* `GET /api/app/bootstrap` query — the same ~13-table
   `Promise.all` used for the initial page load (leads, conversations,
   appointments, invoices, automations, activities, ad spend, ad funds,
   prospect views, website analytics, website updates, website projects)
   — every 5 seconds, for every open tab, then unconditionally re-renders
   9 different views regardless of whether anything changed.

   **Fixed:** the server now computes an ETag over the literal JSON
   response and honors `If-None-Match`; `liveRefresh()` sends back the
   ETag it last saw. When nothing changed, the response is an empty `304`
   instead of the full payload, and the client skips the state
   `Object.assign` and all 9 render calls entirely. When something *did*
   change, behavior is byte-identical to before: a fresh `200` with the
   current data and a new ETag. This is provably equivalent (not a
   heuristic "did anything change" guess that could miss a real update) —
   the ETag is a hash of the exact response body that would have been
   sent, so it can only match when the data genuinely didn't change.
   Measured against a 40-lead workspace: an unchanged poll's payload goes
   from ~10.8KB to 0 bytes, plus the client skips ~9 render-function calls
   and a full `Object.assign` on every tick that finds nothing new.
   Verified with a new `live-refresh-etag-test.js` (Playwright, against the
   real server + client code): two unchanged polls in a row produce a
   `200` then a `304`; a real data change immediately after still produces
   a fresh, correct `200` and the client picks up the new data — freshness
   is unaffected.

   **Not fixed, still the likely dominant *backend* cost:** this only
   reduces what goes over the wire and what the client does with it. The
   full 13-table `Promise.all` against Supabase still runs on **every**
   poll, every 5 seconds, per open tab — the ETag is computed *after* that
   query already ran, so it doesn't reduce Supabase query load or
   connection-pool pressure under concurrent usage. Actually skipping that
   query would need the server to know something changed without querying
   for it (e.g. a change counter bumped by every mutating route, or a
   longer poll interval), which changes either the freshness guarantee or
   touches every mutation path in the app — out of scope for a low-risk
   pass. If the app still feels slow under real concurrent load after this
   ships, this is where to look next.

**Not measurable from this environment:** real Railway cold-start/request
latency, real Supabase query latency under production data volumes and
concurrent load, and CDN/edge behavior. Everything above was measured
against a local boot of the same server code with an in-memory Supabase
stub, which is representative of payload sizes, request counts, and
initialization order/timing (those don't depend on network conditions) but
not of absolute network latency. If the app is still slow after this batch
ships, that's the next thing to instrument — ideally with real Railway/
Supabase timing (e.g., logging query duration server-side around the
bootstrap `Promise.all`) rather than guessed at.

**Verified:** `node --check` on every touched file; `smoketest.sh`;
`e2e-test.js` and both Playwright UI suites against `fake-supabase`; a new
targeted Playwright check (`perf-deferred-scripts-test.js`) confirming none
of the 15 deferred files load before login, all load exactly once right
after, and `v45-ad-intelligence-client.js` specifically is requested under
exactly one URL. One pre-existing, unrelated bug was surfaced by this
change's timing shift (not caused by it) and **fixed in the
production-readiness pass**: `v19-client.js` had always called an
undefined local `wait()` helper (a copy-paste gap — its siblings
`v22-client.js`/`v44-google-ads-client.js` correctly define their own) and
had always thrown on `install()`, so the customer-journey drawer panel,
prospect fit scoring, and automation-health widget it was meant to add
had never actually rendered. Before that timing-shift fix the error fired
silently while the login screen was still showing (bucketed as expected
pre-login noise); after it, the same error fired right after login
instead, doing the same nothing — which is what surfaced it for fixing.

Fixed by adding the same `wait()` guard `v22-client.js` already uses.
Verified each of the three previously-dead features individually with a
seeded Playwright session before treating this as done, since "it no
longer throws" isn't the same as "it makes sense once it's live":
- **Automation-health widget** and the **Leads pipeline board / next-
  action column** (also gated by the same `wait()`) render cleanly with
  their own dedicated styling — no conflicts, screenshotted and confirmed.
- **Prospect fit scoring** (`.v19-fit` badge) does get created in the DOM
  now, but stays invisible: `v28-market.css` already has `.v19-fit{display:
  none!important}` — a later prospecting rebuild (the "why it's worth a
  look" / hot-good-fair-weak scoring visible in Market Finder today)
  deliberately superseded and hid this exact badge already. So turning
  `wait()` on doesn't change what a user sees here at all; nothing left to
  do.
- **Customer-journey drawer panel** renders inside the lead drawer, below
  the newer "Customer workflow" quick-actions section, as a detailed
  history/timeline. `v17.css` already has a dedicated `.lead-drawer
  .v19-customer-panel` style rule sized for the current drawer layout —
  this was evidently anticipated to coexist there, it just never turned on
  before now. It sits low enough in the drawer to need scrolling to see;
  noted as a minor UX observation in the app-experience review, not a bug.

`ui-test.js`'s error allowlist for this specific "wait is not defined"
message has been removed now that the fix means it can't occur.

## App experience review (real-user walkthrough, no redesign)

Walked the app as a first-time owner would, using a realistically seeded
workspace ("Maple Ridge Landscaping": 5 leads across every status, 2
conversations with messages, 2 appointments, 3 invoices, 3 automations,
2 activity entries, 1 delivered website project). Screenshotted every
screen listed in the review request plus a few adjacent ones (analytics,
admin, automations) at desktop width; a mobile-viewport pass was
attempted but the capture script re-hit the already-open Automations view
for both mobile screenshots instead of Dashboard/Leads, so mobile
layouts are **not verified** in this pass — flagging that gap rather than
guessing.

This is an inventory of what feels outdated, generic, confusing,
disconnected, or manual. Nothing here was changed; per the brief, this
pass stops at reporting.

**Bottom line on "tool collection vs. coherent system":** the core loop —
Overview → Leads → Inbox → Calendar → Automations — already feels like a
system, not a pile of screens. The dashboard leads with "3 things worth
handling" and an "Ask SiteRemade" panel, the lead drawer surfaces
pipeline stage and a suggested next action, and automations plainly show
which of 3 workflows are live. That matches the direction in item 7
(proactive, tells-you-what-to-do-next) more than it looks like a
generic CRM shell. Two areas break that impression:

- **Website Projects** is a plain, unstyled long-form page built around a
  raw JSON textarea for the brief (literally `{"summary": ""}` as the
  starting content) — a developer-facing data-entry screen dropped into
  an otherwise polished product. Someone who isn't comfortable hand-
  editing JSON has no clear way to fill this in. This is the single
  starkest "collection of tools" moment in the app, and it's also exactly
  the workflow item 7 wants to eventually replace with a structured,
  AI-assisted brief — so it's worth keeping this page narrow rather than
  investing in its current form.
- **Integrations** has 15 provider cards; 6 of them (QuickBooks, Xero,
  Slack, Microsoft Teams, DocuSign, PandaDoc) have no backend at all
  (confirmed in `routes/integrations.js` — no env-driven config, no
  handler) and their "Set up" button is a raw browser `alert()`
  ("This integration still needs its provider credentials before it can
  connect.", from `v34-integrations.js`). A styled, on-brand app showing
  six dead-end browser alerts reads as unfinished/generic rather than as
  a deliberate "coming soon."

Other findings, roughly in order of how visible they are:

- **Dashboard home**: the top stat row (leads, revenue, etc.) is repeated
  a second time inside the "Know exactly what to do next" box just below
  it — literal duplication of the same numbers in two places on one
  screen. One "RESPONSE TIME AVG" metric renders with no value and no
  explanation of why it's empty (looks broken rather than "not enough
  data yet").
- **Login screen**: `#loginStatus`'s "Supabase-secured account" message
  renders in red/error styling while just sitting idle (not communicating
  an actual error) — small, but it primes a new user to think something's
  already wrong before they've done anything.
- **Payments** and **Analytics**: both use the same blurred "coming soon"
  overlay for the Google + Meta advertising panel. Consistent, so it
  reads as intentional rather than broken — but it's the same ad-setup
  gap that shows up again on the Admin page (below), so a first-time
  owner sees "ads aren't connected yet" three separate times in three
  different visual treatments instead of once, clearly, in one place.
- **Admin ("Growth Admin")**: functionally the most ambitious screen in
  the app — ad guardrails, a Google/Meta connection status pair, an "AI
  decision queue," client provisioning, and a workspace list all on one
  long page — and it holds together conceptually (it's all "run the
  agency" work for one persona). One rough edge: a status line reads
  *"Railway is missing META_APP_ID and META_APP_SECRET"* — an internal
  hosting-provider name and raw environment-variable names leaking
  straight into user-facing copy. That's the kind of detail that makes a
  page feel like an internal ops tool rather than a product a paying
  customer is meant to read.
- **Leads, lead drawer, Inbox, Calendar, Automations**: no notable issues.
  These feel like the most finished, coherent part of the app and are the
  best current evidence for what item 7's "operating system" direction
  should generalize from, not away from.

None of the above were fixed in this pass — per the brief, this is a
report of what a real user would notice, not a redesign.
