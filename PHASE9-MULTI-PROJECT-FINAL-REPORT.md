# Phase 9 — Multi-Project SiteRemade (Journey A + Journey B unification) — Final Report

Companion file: `gen-real/SITE-PROJECT-V16-PHASE9-MULTI-PROJECT.md` (generator-side
detail). This file is the cross-repo report the ticket asked for.

## 1. What this phase was

The ticket's non-negotiable constraint: **do not rebuild either product from
scratch**, keep the existing separation of responsibilities (Generator owns
website creation/canonical project state/revisions/preview/purchase/domains/
export; Workplace owns the post-purchase account/business-management
experience), and make two entry paths converge on the same thing:

- **Journey A**: business idea → generate → preview/refine → purchase
  ($149.99) → appears in Workplace.
- **Journey B**: existing website URL → SiteRemade analyzes it as reference
  material → runs through the **same** strategy/archetype/generation system
  (never a blind clone) → a new canonical `proj_...` project → preview/refine
  → purchase → appears in Workplace.

The closing principle: *"SiteRemade should not care whether the customer
started with nothing or arrived with an old WordPress/Wix/GoDaddy site. Both
paths should end in the same SiteRemade project, and that project should be
manageable from Workplace."* Both paths now do.

## 2. What changed, by area

### Journey B: redesign/import (generator)
- `projects.source_type/source_url/source_imported_at/source_metadata_json`
  (additive migration `0007_project_source.sql`, already present) — every
  project still defaults `source_type='new'`; nothing about a from-scratch
  project changed.
- `lib/site-import.js` — SSRF-safe fetch (DNS-resolve → reject private/
  reserved/metadata/CGNAT/multicast ranges → connect with the resolved
  address pinned, never re-resolving the hostname — closes the DNS-rebinding
  hole a naive check-then-connect has) + dependency-free HTML extraction:
  business name, services, page structure, headings/copy, contact info,
  service area, branding cues (colors, typography, logo, images), CTAs,
  testimonials, key facts.
- `POST /api/redesign/extract` — runs the import, returns extracted facts.
  `POST /api/projects` accepts an optional `source` so an imported project
  is created with real provenance, then **goes through the exact same
  generation/strategy/archetype pipeline** as a from-scratch project — never
  a static clone of the old site's HTML.

### One canonical project lifecycle, both entry paths
No parallel "redesign project" backend exists. A redesign is a `projects` row
with `source_type='redesign'`; every route, every revision, every purchase,
every bridge call treats it identically to a from-scratch project. The
`proj_...` id is the only identity that ever travels to Workplace — never a
domain name.

### Multi-project linking (the structural core of this phase)
Before this phase, one Workplace workspace could link to **at most one**
generator project (a database primary key enforced it), and the generator's
own bridge only ever answered "the canonical project" — no way to ask about
a *specific* one. Ticket §5 required "multiple purchased projects per
customer" to work cleanly with **additive/idempotent migrations** and
**preserved existing links**. That required changes on both sides:

**App (Workplace) — `website_project_links`** (`V54-WEBSITE-LINKS-MULTI-PROJECT-MIGRATION.sql`):
surrogate `id` primary key replaces `workspace_id` as PK; `workspace_id`
keeps its FK + gains a plain index; `generator_project_id`'s existing unique
index is untouched (a project still belongs to at most one workspace — this
is what keeps public form-submission routing unambiguous with zero code
changes). Verified against a real local Postgres 16 instance: idempotent
re-run, legacy single-link rows preserved byte-for-byte, a second link for
the same workspace insertable, no dropped relationships.

**App (Workplace) — `website_analytics`** (`V55-WEBSITE-ANALYTICS-MULTI-PROJECT-MIGRATION.sql`):
same structural pattern — a workspace's second connected project could
previously only share the first project's Umami site/analytics row (a real
bug: the second project's Analytics page would show the first project's
traffic). Now: surrogate PK, nullable `project_id` column (shape-checked),
partial unique index on `(workspace_id, project_id) WHERE project_id IS NOT
NULL`. No backfill — every pre-existing row stays a legacy, workspace-level
row (`project_id IS NULL`); there's no reliable way to guess which of a
workspace's (possibly several, post-migration) projects it used to track,
and guessing is exactly what this migration exists to stop doing.

**Generator — explicit-project bridge route**: `GET
/api/app-bridge/website/:projectId` (added *after* `/candidates` in route
registration — Express/this app's own router both match routes in
registration order, so a bare `:projectId` segment registered first would
have swallowed the literal `/candidates` path; caught and fixed before ever
running a test). Shares `buildWebsiteSummary()` with the canonical route so
both return byte-identical shapes for the same project.

**App — project-scoped Workplace routes** (`routes/website-bridge.js`): `GET
/api/app/website/projects`, `GET .../projects/:id`, `GET
.../projects/:id/deployment`, `POST .../projects/:id/edits`, `POST
.../projects/:id/publish`, `GET`/`POST .../projects/:id/analytics`. Every
one does a two-layer ownership check (`forWorkspaceProject`): this app's own
link table confirms the workspace actually connected that project, **then**
the generator re-verifies real ownership from the signed-in person's own
token on every call — a URL parameter is never trusted as authorization by
itself. The pre-existing singular routes (`GET /api/app/website`, etc.) are
completely unchanged and keep resolving "the canonical (most-recently-
purchased) project," exactly as before this phase — nothing that predates
Phase 9 behaves differently.

### Workplace UI — project switcher (task #414)
A small, signature-guarded `<select>` in the Website and Analytics view
headers, shown **only** once a workspace has 2+ connected projects — hidden
entirely for the common single-project case, so nothing changes for most
customers today. Selecting a project re-points the existing
`canonicalWebsite`/`loadWebsiteAnalytics` machinery at the project-scoped
routes instead of the singular ones (including edit/publish, which route to
the project-scoped endpoints so editing a non-default selection never just
409s against the canonical resolver). Customer-facing labels only — a
business name, never a generator project id, "canonical," "linked," or
"bridge" (ticket §7: no internal architecture language in the UI).

### Purchase → Workplace handoff (task #416)
The generator's purchase-complete screen now shows **"Continue editing"**
(dismisses the row; the editor is already right there) and **"Open in
Workplace"** once a purchase is confirmed fulfilled. "Open in Workplace"
reuses this codebase's existing identity-bridge building blocks (the V14/V15
shared-identity passes) rather than inventing a new cross-app sign-in
mechanism: already linked (or the bridge disabled — today's real default) →
a direct trip to the app, same as every other "Open SiteRemade App" link
already in this file; not yet linked → the same dual-proof "Connect your
SiteRemade account" flow as the pre-existing Connect button, with one new
piece — a one-shot flag that continues straight into the app right after a
successful link, instead of stranding the person on the purchase screen
needing a second click.

"Automatic appearance in Workplace" itself needed no new backend work: it
was already covered by the Phase 8 candidates/connect flow (a purchased-
but-unconnected project already surfaces as a one-click "Connect this
website" prompt the moment a signed-in Workplace session asks for it) —
explicit, never a silent auto-link, matching Phase 8's own deliberate design
decision.

### Owner/admin tooling (task #417, reviewed, extended in earlier commits)
Admin already lists **every** linked project per workspace (one row each,
not just the most recent), from the V54 work. The staff/customer route
separation the ticket asks for (§12: "never make owner-can-access-everything
through normal customer routes the shortcut") was already airtight before
this phase and is unchanged: every customer-facing website-bridge route
(singular and the new project-scoped ones alike) refuses staff/owner
sessions outright (`workspaceGate`) — staff never see live generator data
through a customer route, by an unconditional gate, not a convention. The
mismatch-review/relink flow is scoped to the one legacy mismatch a workspace
can have (a real invariant, not an assumption) and is unaffected by how many
*other* projects that workspace has since connected.

### Cost/entitlement boundary (task #418, reviewed)
A dedicated review (see full findings below) of what this phase's multi-
project capability could expose:
- Connecting N projects requires N genuine, independently-owned $149.99
  purchases — `connectWorkspaceToProject` has no arbitrary cap, but every
  candidate is re-verified against the generator's own purchase records on
  every connect call, so "connect for free" isn't possible.
- Umami site provisioning is idempotent per (workspace, project) and gated
  behind an explicit customer action or a 10-minute in-memory backoff — no
  runaway site creation.
- AI-edit credits are enforced server-side on the generator, per account,
  through the exact same ledger/rate-limit code whether the request arrives
  via the singular or the new project-scoped edit route — no bypass.
- Public form-submission volume that actually gates the costly sends
  (email/SMS) is capped per-workspace, not per-project, so connecting more
  projects doesn't multiply it.
- Twilio/Resend/Google Ads/OpenAI usage remains workspace-scoped throughout;
  none of those integrations were touched by this phase's diff, and none
  read the multi-project link list for anything but read-only display.

No pricing was redesigned; nothing here changes what a customer pays for —
this was a capability review, not a policy change, matching the ticket's own
instruction.

## 3. Known gaps / deliberately deferred

- **Contact/Updates are not yet project-scoped in the UI.** A workspace's
  Contact list shows leads from every connected project together (correctly
  workspace-scoped, and public form submissions already route
  deterministically to the right project per ticket §10 — verified in
  `multi-project-form-routing-test.js`), but there's no "which website did
  this come from" filter yet. Flagged, not attempted, in the interest of
  keeping this phase's UI change additive and low-risk rather than
  rebuilding the Contact view.
- **A live cross-origin identity-bridge round trip cannot be run from this
  sandbox** — the SiteRemade app's real origin is hardcoded client-side and
  unreachable here (the same limitation this codebase's own pre-existing
  `primtest/v15-unified-login-test.js` already documents). Both halves of
  that round trip are tested against the real code, separately, the same
  way that existing suite already does; a true end-to-end click-through
  needs a real staging/production pass.
- **This entire phase was verified against real local servers, a real local
  Postgres 16 instance, and real headless-browser sessions — never against
  actual Railway/Supabase production.** No credentials for either exist in
  this sandbox. Every migration was hand-verified for idempotency and data
  preservation against real Postgres SQL semantics, and every route/flow
  was exercised against the real application code (not mocks of it), but
  the ticket's own instruction — "do not mark the phase complete until the
  real user journeys work against production" — cannot be fully honored
  from inside this sandbox. **Recommended next step**: apply
  `V54`/`V55` in Supabase's SQL editor (both are additive and idempotent,
  safe to run against the live database at any time), deploy both repos,
  and run one real Journey A and one real Journey B purchase end-to-end.

## 4. Testing performed (all real, none mocked away)

- `gen-bridge-test.js` — 90 + 7 + 7 assertions across three modes (images
  on/off, bridge off) — full generator regression, re-run after every
  change, zero regressions throughout.
- `website-connect-test.js` — 48/48 (multi-project connect, candidates,
  IDOR-safety, staff/owner boundary, project-scoped route correctness).
- `workplace-api-test.js` — 64/64 (unrelated Workplace surface, re-run for
  regressions after every touch to shared files).
- `analytics-connect-e2e-test.js` — 9/9 (single-project analytics
  provisioning, unaffected by the multi-project changes).
- `workplace-ui-test.js` (Playwright) — 29/29.
- `smoke-project-provenance.js`, `site-import-test.js` (27 assertions
  including a real SSRF-refusal proof against a genuinely reachable
  forbidden target, not just "the code looks like it would refuse"),
  `redesign-route-test.js` — 12/12.
- `multi-project-bridge-test.js` — 10/10 (explicit-id generator route,
  IDOR-safe, byte-identical to canonical for the same project).
- `multi-project-analytics-test.js` — 14/14 (two connected projects get two
  independent Umami sites; the legacy workspace-level row is untouched by
  setting up a second project; IDOR-safe).
- `workplace-ui-multiproject-test.js` (Playwright, real dual generator+app
  servers) — 12/12 (a single-project workspace shows **no** switcher at
  all — byte-identical to before this phase; a two-project workspace shows
  a real switcher and a real network round trip when switching, on both
  Website and Analytics).
- `purchase-complete-handoff-test.js` (Playwright, real generator server,
  real purchase fulfillment) — 13/13 (the row appears only on a genuine
  fulfilled purchase, never a cancelled one; "Continue editing" navigates
  nowhere; "Open in Workplace" takes the correct one of three real paths
  depending on account state, verified by intercepting the real
  `https://app.siteremade.com/**` requests and inspecting their exact
  URLs).
- `multi-project-form-routing-test.js` — 8/8 (ticket §14's explicit edge
  case: two connected projects, a form submitted from each, both correctly
  attributed to the one real owning workspace and never to an
  attacker-supplied workspace id, both visible together in that workspace's
  Contact list).

Total across this phase's own new/extended suites: **200+ real, passing
assertions**, plus the full pre-existing regression suite re-run clean after
every commit.

## 5. Commits (both repos, chronological)

**Generator (`gen-real`)**
1. `dae603b` — project source provenance columns.
2. `182f584` — redesign/import extraction endpoint (SSRF-safe fetch + HTML
   extraction).
3. `bf57457` — explicit-id generator bridge endpoint.
4. `4ce6cd6` — purchase-complete "Open in Workplace"/"Continue editing".

**Workplace app (`app-real`)**
1. `2efbc52` — multi-project `website_project_links` (V54).
2. `1071be5` — project-scoped Workplace routes.
3. `8dce741` — project-aware `website_analytics` (V55).
4. `f6f5668` — project switcher in Website + Analytics UI.

## 6. Bottom line

Both journeys now produce the same thing: a canonical `proj_...` project,
generated (or redesigned) through the one real generation system, purchasable
once for $149.99, and manageable from Workplace — including when a customer
owns more than one. The architecture split the ticket required (Generator
owns creation/canonical state; Workplace owns the post-purchase business
experience) was preserved throughout; nothing was rebuilt. What's left before
calling this fully done in the field is a real deploy + one real production
run of each journey, which this sandbox has no path to perform.
