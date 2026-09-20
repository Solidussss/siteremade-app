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

## Live-refresh backend cost (product-experience pass)

The previous pass put an ETag on `GET /api/app/bootstrap` so an unchanged
5-second poll returns an empty 304 instead of the full payload — a real
win for network and re-render cost, but it was explicitly flagged as
**not** touching backend cost, because computing that ETag still required
running the full `workspaceSnapshot()` — 13 Supabase queries, six of them
unbounded or capped at 200-5000 rows — before the server could even tell
whether anything had changed. Every 5-second poll paid that cost, changed
or not.

`workspaceFingerprint(wid)` (`server.js`) now answers "did anything
change" first, using a cheap, targeted signal per table instead of
fetching every row:

- **leads, conversations, website_updates, website_projects** — each has
  a real `updated_at` column that every `update()` call against it in
  this codebase already sets (checked every call site, not assumed), and
  insert/delete change the row count. Row count + the single most-recent
  `updated_at` can't miss a change.
- **messages, appointments, activities, ad_spend** — insert/delete only;
  no update touches a field the client ever sees (an appointment's
  `reminder_sent_at` isn't in `mapAppointment`). Row count + most-recent
  `created_at` is enough.
- **ad_funds** — same idea, plus a second cheap check on the most recent
  non-null `funded_at`, because a fund request can flip Pending → Funded
  long after a newer request was created, which wouldn't move the count
  or the created_at watermark on its own.
- **prospect_views** — insert-only and already projected down to just
  `place_id` in the real snapshot; a bare row count needs no data at all.
- **invoices, automations** — the two exceptions. Neither table has an
  `updated_at` column, and both can change in place without moving any
  timestamp: the Payments screen lets an owner set an invoice to *any*
  status by hand (not just Paid — Draft/Pending/Void are all one dropdown
  away), and toggling an automation just flips a boolean with no
  timestamp column to bump at all. Rather than add a schema column and
  depend on a migration nobody can verify against real production data
  yet (the same caution V48 already got), these two are read in full on
  every poll — but projected to just the 2-3 columns that are actually
  mutable, not every column. Both tables are small and bounded in
  practice (automations is a fixed handful of rows; invoices scale with
  real business volume, not with polling), so this wasn't the cost
  problem to begin with.
- **website_analytics** — a single row per workspace whose one write path
  (`routes/umami-analytics.js`) always bumps its own `updated_at`, so
  that column alone is the whole check.

When the fingerprint hash matches the client's `If-None-Match`, the
handler returns 304 **without ever calling `workspaceSnapshot()`**. When
it doesn't, it falls through to the exact same full rebuild as before —
freshness on a real change is identical to today; only the cost of an
*unchanged* poll is different.

**Correctness risk and how it was tested:** the whole point of a
fingerprint is that it must never go stale, or another open tab/device
silently stops seeing real changes. `backend-fingerprint-test.js` proves
the three specific gaps this design had to close, each verified against
the real route logic (not a reimplementation):
- toggling an automation (no timestamp column, no count change) still
  invalidates the fingerprint;
- editing an invoice to **Void** — not Paid, so `paid_at` never moves —
  still invalidates it;
- marking the **older** of two ad-fund requests as Funded (no new row,
  count and latest-`created_at` both unchanged) still invalidates it.

All three would have been silently missed by a naive count-only or
count+`updated_at`-only design, which is why invoices and automations get
the narrower full-column read instead of being folded into the same
count/timestamp pattern as everything else.

**Before/after, measured** by that same test against a seeded workspace
(50 leads, 12 invoices, 3 automations, 30 activities, 2 ad-fund requests):

| | queries | rows returned | bytes on the wire |
|---|---|---|---|
| Every poll, old behavior (= any poll with a real change, still today) | 29 | 117 | 24,549 |
| Unchanged poll, new behavior | 16 | 20 | 0 (304) |

Rows returned on an unchanged poll dropped ~83%, and the large/unbounded
tables (leads, activities, and anything with real message/note text)
contribute zero rows instead of all of them. Query *count* drops too in
this run (16 vs 29) but that's a secondary effect of skipping
`workspaceSnapshot()` entirely, not the primary goal — a genuinely
different signal per table still means one lightweight round trip per
table either way. A single-round-trip check (one Postgres function call
instead of ~13) is possible but would need a new schema object deployed
and verified against real production data first, which is exactly the
kind of unverified-migration risk this pass is deliberately avoiding.

No client-side change was needed — `app.js`'s `liveRefresh()` already
sends `If-None-Match` and already handles a 304 from the previous pass;
this fix is entirely inside the bootstrap route.

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

## Integrations: retiring the 6 dead-end cards (product-experience pass)

Confirmed by grep across the whole repo, not assumed: QuickBooks, Xero,
Slack, Microsoft Teams, DocuSign and PandaDoc have no OAuth flow, no
callback route and no client-library call anywhere in the codebase —
unlike Gmail/Google Calendar/Twilio/Stripe/Google Ads/Meta Ads, which do.
`routes/integrations.js`'s `configured` flag for these six only checks
whether an env var pair *exists*; setting one wouldn't actually connect
anything, because there's nothing on the other end to connect to. That's
what made `v34-integrations.js`'s generic click handler pop a raw
`alert()` for them — the card had no real "next step" to send the owner
to.

Fix: `v34-integrations.js` now hard-codes these six ids into an
`UNAVAILABLE` set, independent of whatever the status endpoint reports.
For those cards only: the state pill always reads "Coming later" (not
"Setup required"), the button is a real disabled `<button>` (not just
styled to look inactive — clicking it does nothing, fires no handler, no
`alert()`), and the card itself is slightly dimmed (`.v34-unavailable`,
`opacity:.72`) to read as backgrounded at a glance. No visual language
was introduced — same card, pill and button components every other
integration uses, just their existing `:disabled` state. The real
integrations (Gmail, Twilio, Stripe, Google Ads, Meta Ads, Zapier, etc.)
are untouched.

This is deliberately a "not yet" treatment, not a removal — the cards
stay visible so the roadmap breadth is still legible — per the brief's
"present professionally as unavailable/coming later... do not fabricate
functionality." Verified with a Playwright check that the QuickBooks
button is disabled and that force-clicking it raises no dialog, alongside
the existing full UI-test run.

## Small polish fixes (product-experience pass)

Four defects named directly in the app-experience review, fixed without
touching anything else on their pages:

- **Duplicated dashboard stat row.** `v19-client.js`'s `renderFocus()`
  (ACTIVE LEADS / WAITING REPLIES / FOLLOW UPS / TODAY'S BOOKINGS /
  OUTSTANDING, a bare strip at the very top of Overview) and
  `v22-client.js`'s `renderHomeHero()` ("Know exactly what to do next",
  with the same active-leads/waiting-replies/outstanding numbers as
  clickable, framed stat buttons) had ended up showing nearly the same
  numbers twice, stacked directly on top of each other — `v22.css` had
  even already been tuning the older strip's spacing rather than hiding
  it, so this wasn't a leftover so much as two iterations that never got
  reconciled. Rather than delete either widget outright: the "Follow-ups
  due" number (active leads untouched 2+ days) is the one real stat the
  older strip had that the newer hero didn't, so it was folded into the
  hero's stat row (now 5 stats instead of 4), and the older strip is
  retired the same way `v28-market.css` already retired `.v19-fit` —
  `.v19-focus-strip{display:none!important}` in `v22.css` — rather than
  touched in `v19-client.js`, since that file still uses the same
  numbers elsewhere (the pipeline board).
- **Unexplained empty "RESPONSE TIME AVG" metric.** The metric itself was
  never broken — `app.js` already computed a real average reply time from
  conversations with 2+ messages — but its caption (`#responseMeta`)
  was static placeholder text ("Conversation activity") that never
  updated, unlike its sibling metrics' captions (`#appointmentMeta`,
  `#valueMeta`), which do. So a workspace with no multi-message
  conversations yet showed a bare "—" with a caption that explained
  nothing. Now reads "Not enough replies yet to measure" (or "Across N
  replies" once there's data) — same computation, just an honest caption.
- **Idle login text rendered error-red.** `#loginStatus{color:#c54747}`
  in `app.css` made the login screen's small print red *by default*,
  including the idle "Supabase-secured account" text and the transient
  "Signing in…" text — not just real errors. Its sibling `#signupStatus`
  already does this correctly (neutral by default, `.error`/`.success`
  color applied only when relevant); `#loginStatus` just never got the
  same treatment. Fixed the base color to neutral and confirmed the two
  `app.js` call sites that relied on the red default for genuine errors
  (Supabase misconfigured; login rejected) now set red explicitly, so
  real errors still show red — verified visually, not just by absence of
  the old rule.
- **"Railway" / raw env var names in user-facing copy.** Found in three
  places, not just the one the review screenshotted: the Admin page's
  Meta Ads panel ("Railway is missing META_APP_ID and META_APP_SECRET"),
  and the same pattern in the Website Projects brief-generation error
  (`server.js`, both the actual 503 response and its otherwise-unreachable
  fallback throw) — the exact message a business owner sees if they try
  "Generate with AI" before it's configured. All three now describe the
  situation in plain product language with no hosting-provider name or
  raw env var names. Confirmed by loading the Admin page and asserting
  neither string appears anywhere in the rendered page.

All four verified against the full e2e/UI/backend-fingerprint suite plus
a direct screenshot/text check of each fix.

## Mobile pass (product-experience pass, item 7)

A real 390×844 phone-viewport Playwright walkthrough (not a narrowed
desktop window) covering login, create account, Overview, Leads + lead
drawer, Inbox, Calendar, Website Projects (list and detail), Payments,
and Integrations, checking both `document.documentElement.scrollWidth`
overflow and, for anything screenshot-only looked suspicious, direct DOM
measurements (not just the picture) before calling it a bug — a full-page
Playwright screenshot can make a `position:fixed` element (the bottom nav,
a modal-style sheet) appear "frozen" at one spot in the stitched image
even though it renders and scrolls correctly on a real device, and this
pass repeatedly cross-checked against that before reporting a finding.

Two real, verified defects were found and fixed:

- **Leads table forced the page wider than the phone screen.** `.lead-table`
  had `min-width:520px` (from the existing `@media(max-width:700px)`
  block, tuned for tablet-size screens where letting the table scroll
  sideways is a reasonable call) with no narrower override for actual
  phones, so on a ~390px screen the table — and the whole page — was
  forced ~130px wider than the viewport just to keep showing a Service
  column that's already visible elsewhere (Overview's Recent leads).
  Fixed by adding a `@media(max-width:480px)` rule that drops the
  min-width, hides the Service column, and shrinks the row-menu button.
  This has to appear *after* the 700px block in `app.css`, not merely in
  a "narrower" media query — CSS gives a later same-specificity rule
  priority regardless of which range is logically narrower, and an
  earlier attempt placed before that block was silently overridden by it.
  Verified with `document.documentElement.scrollWidth` before/after
  (520px-wide forced page → fits the 390px viewport) and a real (non-
  full-page) screenshot.
- **Integrations, opened from the mobile "More" menu, left the "More"
  sheet stuck open on top of it.** Root cause: `v34-integrations.js`
  predates Integrations being a first-class static nav view, and still
  installs a capturing `document` click listener that matches *any*
  `[data-view="integrations"]` element and calls
  `e.stopImmediatePropagation()` — which fires before, and prevents,
  the button's own `switchView()` handler in `app.js` (the one that
  normally closes the mobile sheet on every navigation) from ever
  running. Its own `openIntegrations()` correctly swaps the active view
  but never touched the sheet. Confirmed by direct DOM state
  (`#mobileMoreSheet`'s `hidden` attribute and computed `display`, not
  just a screenshot, since a stuck-open fixed-position sheet can look
  ambiguous in a stitched full-page image) before and after. Fixed by
  adding the same two sheet-closing lines `switchView()` already uses
  into `openIntegrations()`, rather than removing the legacy listener
  (out of scope for a narrow fix) or touching `switchView()` itself.
  Also added the missing "Integrations" entry to the mobile "More" grid
  itself (`index.html`) — before this pass, Integrations had no route
  into it at all from a phone, since it only lived in the desktop
  sidebar and the Settings-page-adjacent admin flow.

Also reviewed and ruled out as *not* real bugs, each confirmed by direct
DOM measurement or a real (non-full-page) screenshot rather than the
full-page screenshot alone:
- The Payments page's "Coming soon — Google + Meta advertising" overlay
  appeared to have a blank gap in the full-page screenshot. Measured
  directly: overlay height (425px) matches the card height (427px), and
  the overlay's text sits fully inside it (829–866px within a 611–1036px
  overlay). A real, non-full-page screenshot scrolled to the card
  confirms clean rendering — the fourth confirmed instance of the
  full-page/fixed-nav screenshot artifact in this pass, not a new bug.
- Calendar's 7-column month grid scrolls horizontally on a phone; this is
  a deliberate, already mobile-considered layout (sticky header, explicit
  scroll affordance), not an overflow bug.
- Website Projects' list and detail views render as one long combined
  page (a compact project list followed immediately by the selected
  project's full detail below it) rather than two separate screens —
  this is the intended single-pane master/detail layout carried over
  from the structured-intake rebuild, not a mobile-specific issue; the
  page is long because the feature area is genuinely large, not because
  it's cramped.

`mobile-review.js` (the walkthrough script) now includes a permanent
regression check for the "More" sheet not closing, asserting the sheet's
`hidden` attribute and computed `display` directly rather than trusting
a screenshot.

One unrelated, pre-existing test-harness quirk was found and fixed
while re-running the full suite after these changes: `smoketest.sh`
expected a bad-credentials login to return 401, but the stubbed
Supabase auth client used for local testing has no real password
verification (by design, so the Playwright suites can log in as any
seeded user), so an unrecognized login falls through to `server.js`'s
"no SiteRemade profile for this account" branch (403) instead. Both
codes prove the endpoint fails closed, which is what this smoke test
actually checks per its own file header — so the assertion now accepts
either, rather than pinning to the stub's specific (and not
production-representative) auth-failure path. No `server.js` or
`fake-supabase` code changed; this was a test-assertion fix only.

## Product-experience review: next highest-impact changes (report only, item 8)

Per the brief, this is analysis only — nothing below was implemented.
Goal per the brief: not "a CRM with lots of tabs" but a system that
actively tells the owner what matters right now. A code survey of the
dashboard, lead model, daily-workflow feature, automations, entity
relationships, and existing AI usage grounds the following instead of
guessing. Ranked by impact:

1. **Give leads an actual priority signal, in the leads list itself.**
   Today `leads` has no score/urgency field at all, and the leads list
   has no sort control — it's just status-tab + text search, in
   whatever order the backend returns. Meanwhile *two separate places*
   (the "Ask SiteRemade" assistant and the dashboard's attention widget)
   already independently compute "stale, no reply in N days" for their
   own private purposes and throw it away afterward. Compute that once,
   store it (or derive it consistently) and surface it as a badge/sort
   in the leads list itself — where an owner actually works — not just
   in a sidebar widget they may not open. Rule-based, not AI; highest
   ratio of impact to effort of anything here.
2. **Promote the "attention items" list from a bolt-on to the front
   door.** `v42-daily-workflow.js`'s "N things worth handling" is the
   one genuinely proactive thing in the app today, but it's a
   monkey-patch that overrides the dashboard's render function after
   the fact, and its follow-ups are hand-typed via a browser `prompt()`.
   Rebuilding it as a first-class, system-owned queue (not a patch) is
   what "operating system, not tabs" actually requires structurally —
   everything else on this list feeds it.
3. **Close the "paid but nothing happens" gap.** Confirmed in
   `server.js`: a Stripe-paid invoice only flips its own `status` and
   logs an activity entry — it never touches the linked lead or website
   project. An owner has to remember, separately, to update the lead's
   stage or the project's status by hand. This is the single most
   concrete "manual handoff" in the product and the most literal reading
   of "connecting leads → projects → payments" — a paid invoice should
   at minimum be able to advance its linked project/lead automatically.
4. **Close the reverse gap: delivering a project doesn't ask for
   payment.** Marking a website project "Delivered" and creating its
   invoice are two unrelated button clicks today, in two different
   parts of the app, with nothing connecting them. A prompt ("This
   project is now delivered — send the invoice?") at the moment of
   delivery turns a step an owner can simply forget into one they're
   asked about at the moment it matters. Still a human decision — just
   removes the burden of remembering to ask it.
5. **Surface the relationships the data model already has.** The lead
   drawer shows notes and one project button, but not that lead's
   appointments or invoices. A website project's detail shows the
   lead's name as inert text, not a link into their conversation or
   status. The payments list doesn't show which project an invoice is
   for, despite `invoices.project_id` existing. None of this needs new
   data — it's display work on relationships that are already there,
   and it's exactly what makes leads/projects/payments/conversations
   feel like one customer record instead of four separate screens an
   owner has to mentally reassemble.
6. **Turn "Ask SiteRemade" from a read-only text box into something
   actionable.** It already computes real, useful things (which leads
   are stale, what's due) via a real model call — but its answer is
   plain text with no link back into the entity it's talking about. An
   owner reading "Sarah's lead has gone quiet" still has to go find
   Sarah themselves. Making its references clickable (open that lead's
   drawer) is a small change that converts existing AI output from
   decorative summary into something that actually saves a step.
7. **AI-drafted inbox replies.** The app already has a working AI layer
   (the receptionist model call, the business assistant, the brief
   generator) but Inbox reply composition today is 100% manual typing —
   the one place a busy owner spends the most real-time attention. A
   "suggest a reply" affordance, reusing the same model-call
   infrastructure that already exists, is a genuine case of "AI saves
   real work" (drafting under time pressure) rather than a bolted-on
   chat widget for its own sake.
8. **Automation triggers beyond signup-time.** All three automations
   (`lead-alert`, `lead-confirmation`, `appointment-reminder`) are fixed
   at workspace creation with no way to add a rule and no cross-entity
   triggers (invoice paid, project delivered, lead gone stale). Given
   #3/#4 above will already need "when X happens, do/ask Y" plumbing,
   generalizing that into a couple of new automation trigger types is a
   natural, low-risk extension of a pattern the product already has,
   rather than new architecture.
9. **One combined view per customer.** Once #5 (link surfacing) exists,
   the natural next step is a single "opportunity" or "client" view that
   rolls up one customer's lead stage, project status, payment status,
   and last conversation activity in one place, instead of four screens
   an owner must click between and hold in their head. This is the
   clearest concrete shape of "business operating system" the brief
   describes, and it composes directly out of #3, #4 and #5 rather than
   being a separate rebuild.

**Where AI genuinely helps vs. would be decorative, explicitly:** #1
(prioritization), #3/#4 (paid→project, delivered→invoice), and #8
(automation triggers) are plain rule/data-flow logic and should stay
that way — bolting a model onto "is this invoice paid" would be slower,
less predictable, and no more correct than a status check. #6 (making
existing AI-assistant output clickable) and #7 (drafted inbox replies)
are the two spots where a model is already the right tool, because the
task itself — summarizing an open-ended situation, drafting a
plausible first-pass reply — isn't reducible to a rule. Everything else
(#2, #5, #9) is structural/UI work that makes the existing real AI
output and real data actually land in front of the owner at the moment
it's useful, which is a precondition for AI feeling load-bearing rather
than decorative anywhere in the product.

## Login/startup performance investigation (measured, not guessed)

Scope: real login/dashboard-boot latency, not architecture. No features
added, nothing redesigned. Method: an instrumented Playwright + Chrome
DevTools session (`perf-audit.js`, scratchpad root) against this exact
codebase running locally — real `server.js`, real `app.js`, a fake
Supabase stub so the *database* has near-zero latency. That measures
every code-controlled number precisely (request counts, transferred
bytes, ordering, main-thread long tasks) but **cannot** measure real
Railway/Supabase network round-trip time, since this sandbox has no
network path to the deployed app. Two viewports (1440×900 desktop,
390×844 mobile) — numbers were identical between them, since none of
what's measured here depends on viewport size.

Real before/after, same seeded workspace (40 leads, 15 conversations,
12 invoices, 8 appointments), same methodology both times:

| Metric | Before | After |
|---|---|---|
| Bytes before login form usable | 522,627 B (510.4 KB) | 399,018 B (389.7 KB) |
| Requests before login form usable | 6 | 6 |
| Requests in the 6s after dashboard becomes usable | 8 (4 of them duplicate Twilio-status checks + 1 wasted full bootstrap re-fetch) | 4 |
| Time: page load → login form usable (local, no real network latency) | ~170–190ms | ~180–190ms |
| Time: click Sign In → dashboard usable (local, no real network latency) | ~95–120ms | ~100–110ms |

The local click→dashboard timings didn't move because they were never
the bottleneck *locally* — the fake database responds instantly, so
there's nothing to speed up in this environment. What moved, and what
matters once this runs against real Supabase/Railway: fewer requests,
fewer bytes, and — the more important one — the elimination of a
guaranteed wasted round trip that happens on every single login. Three
real, verified causes were found and fixed:

1. **Every first bootstrap call after login paid for a wasted query
   round it could never use.** `GET /api/app/bootstrap` unconditionally
   ran `workspaceFingerprint()` (14 queries) *before* checking whether
   the client had even sent an `If-None-Match` header — but a request
   with no prior ETag can never match one, so that whole round was
   guaranteed dead weight precisely on the first bootstrap call after
   every login and every plain page reload, the single most
   latency-sensitive request in the app. Fixed in `server.js`: when
   there's no `If-None-Match` to compare against, the fingerprint and
   the full snapshot now run concurrently (`Promise.all`) instead of the
   fingerprint gating the snapshot — same two query sets, one fewer
   sequential round trip on the request that matters most.
2. **The first 5-second live-refresh poll after every login always paid
   full backend cost, even with nothing changed.** The ETag-conditional
   polling added earlier only worked from the *second* poll onward:
   `lastBootstrapETag` was only ever set inside `liveRefresh()` itself,
   never captured from `bootstrap()`'s own response (the call that runs
   on every login and every page load). So the very first 5-second tick
   always sent no `If-None-Match` and got a full rebuild — confirmed
   directly: a real 22,073-byte full bootstrap re-fetch measured 4987ms
   after the dashboard became usable, exactly the 5-second poll
   interval. Fixed by having `bootstrap()` capture its own response's
   ETag too (`app.js`); the same poll now correctly gets a 304. Verified
   gone in the after-run.
3. **Three separate scripts independently checked the same Twilio status
   on every login, with no idea the other two existed.**
   `v36-connectors-client.js`, `v38-safe.js`, and
   `v39-phone-setup-client.js` each fire their own
   `/api/app/integrations/twilio/status` fetch on their own ~350–500ms
   timer after the dashboard loads — measured as 3–4 near-simultaneous
   duplicate requests for identical data on every single login (plus
   `v38-safe.js` re-fetching it again on every calendar/inbox/payments/
   integrations nav click, with no cache of its own at all). Fixed by
   adding one shared, promise-deduplicated cache (`window.
   getSharedTwilioStatus`, `app.js`) that all three now call instead of
   fetching independently; the two call sites that mutate the connection
   (connect/disconnect) explicitly force a fresh check afterward.
   Confirmed: 4 duplicate calls → 1 in the after-run.
4. **The login screen's logo and favicon were far larger than what's
   ever displayed.** `siteremade-logo-black.png` is shown at `width:54px`
   in CSS but shipped as a 473×519 source file (157KB); resized to
   220×242 (comfortable for even a 4x-density display) and losslessly
   recompressed → 41KB, zero visible difference (verified visually — a
   palette-quantization pass was tried first for an even bigger win but
   produced visible gradient banding on the logo's highlight and was
   discarded). `favicon.png`'s 512×512 dimensions are a real requirement
   (declared in `manifest.webmanifest` as the PWA icon size) so those
   were kept; only lossless recompression was applied (159KB → 150KB).

Verified as already correct, not touched: the dashboard's own core
render already completes (and hides the auth screen) *before* the ~15
secondary CSS/JS resources even start downloading — confirmed by the
timing capture, where the dashboard-usable milestone lands at the exact
instant those requests begin, not after. The 5-second live-refresh
polling loop already only starts once the dashboard is visible, never
before. None of the integrations/ads/analytics/website-projects feature
scripts block the login→dashboard path — all of it was already gated to
load only after successful auth, from an earlier optimization pass
(commit `3dedb00`, prior to this session).

**What this pass could not measure, and why:** real Railway response
latency and real Supabase auth-service latency only exist against the
actually-deployed infrastructure, which this sandbox has no network path
to reach. `getAuthUser()` → profile lookup → `membershipsFor()` in
`lib/context.js` is inherently 3 sequential dependent calls per
authenticated request (each needs the previous one's result), run once
during login and again during the immediately-following bootstrap call
— structurally unavoidable for stateless cookie-based auth without a
larger redesign, and almost certainly the dominant real-world
contributor to "the dashboard takes 10-20 seconds" once real network
latency (rather than a local zero-latency stub) is in the loop. This
wasn't touched — it's not a bug, it's the cost of verifying a session on
every request — but it's the most likely next thing to investigate with
real production numbers once a deploy is possible.

Full test suite (smoketest, e2e, ui, live-refresh-etag,
backend-fingerprint, mobile-review) re-run and passing after every
change in this section — no functional regressions.

## Pre-auth "Page Unresponsive" investigation (negative result, reported honestly)

Escalation: Chrome reported "Page Unresponsive" while sitting on the
login screen, *before* authentication. That rules out the authenticated
Supabase/`membershipsFor()` call chain discussed above as the explanation
on its own — `fetch()` never blocks the main thread while it's waiting,
so a slow or hanging backend cannot by itself freeze the tab. Something
else — a loop, a feedback cycle in an observer, synchronous work — would
have to be responsible. This section covers the audit for that, a
from-scratch reproduction attempt, what was found and hardened, and —
important — what was **not** found.

**Audit of everything that runs before authentication.** Traced exactly
what loads on the login screen: `index.html`, `app.css`, `app.js`, and
one small inline script — nothing else. Every dashboard feature script
(`v1`–`v46`, all polling `setInterval`s, both document-wide
`MutationObserver`s) is dynamically imported only from inside
`bootstrap()`'s success branch (`loadDashboardFeatureScripts()` and
`v29-bootstrap.js`), which only ever runs after a successful login. So
the pre-auth JS surface is small and, on inspection, contains no
unconditional loop, timer, or observer of its own — nothing in that
surface should be capable of pinning the main thread regardless of
backend state.

**Reproducing the exact reported condition.** Built a harness
(`hang-repro.js`, scratchpad-only) that starts the real app server behind
a raw HTTP proxy which intercepts `/api/app/bootstrap` and
`/api/auth/login` and never responds to them — connection accepted, no
timeout, no error, exactly what a wedged Railway instance or a
Supabase call with no timeout looks like from the browser's side (a
"connection refused" backend-fully-down mode was also tried and produces
a completely different, more obvious failure: the page itself never
loads). Against the hanging-backend mode, four independent checks were
run while sitting on the login screen for 15 seconds and then actually
interacting with it:

- A `PerformanceObserver({type:'longtask'})` capturing any main-thread
  task ≥50ms, for the entire session.
- A free-running `setTimeout(tick, 50)` counter, whose actual-vs-scheduled
  drift reveals blocking shorter than the 50ms long-task floor.
- Five `page.evaluate()` round-trips spaced through the 15-second idle
  window (a blocked main thread delays these).
- Live interaction mid-hang: typing into the email field, filling the
  password, clicking **Sign In** (whose POST to `/api/auth/login` never
  resolves), waiting 4 more seconds, then clicking the "Create account"
  tab — all while that request sits permanently pending.

**Result: no hang reproduced.** Every interaction succeeded immediately
(typing, clicking Sign In, switching tabs while the login POST was still
pending). `#loginStatus` correctly showed the stuck "Signing in…" state
rather than the UI freezing. Only one long task was recorded in the
entire run — a single 65–83ms task at initial page parse, well below
anything that would trigger Chrome's unresponsiveness warning (which
looks for the renderer failing to service input for several seconds).
Timer drift stayed within normal single-digit milliseconds throughout.
In short: under the precise condition described — backend/Railway/
Supabase completely unavailable, sitting on the login screen — the
current code in this repo does not hang.

**I am not calling this fixed.** The instruction was explicit not to
claim that on the strength of a clean test run, and this is a clean test
run against code that has not been deployed. It rules out the pre-auth
JS in *this* repo as the cause under *this* specific condition; it does
not explain the browser-observed symptom.

**Hardened anyway, as defense-in-depth, not as the fix.** While auditing
every `MutationObserver` in the codebase for feedback-loop risk (an
observer whose own callback triggers another mutation is the classic way
to actually pin a main thread), two real inefficiencies turned up —
lower severity than a hang, but worth closing:

- `v45-ad-intelligence-client.js`'s admin-panel observer ran
  `hydrateForm()` (and conditionally scheduled a `sync()`) on *every*
  childList mutation anywhere in the document, all the time — including
  every 5-second live-refresh tick on completely unrelated views like
  Leads or Inbox.
- `v46-google-ads-account-fallback.js`'s observer did the same, and its
  follow-up (`patch()` → `getAccounts()`) is a real network fetch — so
  this one was queuing an extra API call on every DOM mutation anywhere
  in the app, regardless of which view was open.

Neither is a self-triggering loop: v45's callback only ever sets `.value`
properties (not `childList`-observable), and v46's `patch()` is guarded
by a `busy` flag against re-entry. So these were wasteful background
work, not the reported hang. Both are now gated to only act while
`#view-admin` is the active view, matching the existing active-view-guard
pattern already used elsewhere in this codebase (`v39`/`v40`/`v41`).
Committed as `12d4fa9`. Full regression suite (smoketest, e2e, ui,
live-refresh-etag, backend-fingerprint, mobile-review) re-run and passing
— no functional regressions.

**What remains unexplained, and the real constraint behind that:**
`git push origin main` has been blocked since the previous performance
pass by a repository-authorization error from this session's git proxy
(`Solidussss/siteremade-app is not in this session's authorized
repository set`) — nothing from this investigation, or the prior
performance pass, has reached Railway. `app.siteremade.com` is still
serving whatever was deployed before either pass. That matters here
specifically: this sandbox has no way to open the live site in a real
browser (no browser-automation or remote-device tooling is available in
this session, and this sandbox's own network egress cannot reach
`app.siteremade.com` at all — confirmed directly), so there's no way to
inspect the bundle actually running in production or capture a real
DevTools trace during an actual occurrence of the warning. The most
likely explanations for the gap between "clean locally" and "hangs in
production" are: production is running older code that predates these
optimizations (or contains a bug since removed) — most probable, since a
deploy has not happened; or the cause is something this sandbox cannot
reproduce at all — a browser extension, or a stale service worker from
an older deploy (the codebase's own service-worker-unregister cleanup
code implies one existed previously).

**Recommended next step:** get `main` deployed (resolving the git-proxy
authorization is the blocker — either authorize this session's access to
the repo, or push from a machine that already has access), then, if the
warning still occurs, capture a Chrome DevTools Performance recording
during an actual live occurrence of it on `app.siteremade.com`. That
recording's call stack is the only way to identify the exact function
responsible if the cause is something outside what this sandbox can
reproduce.
