# WebsiteProject contract (generator ↔ app) — app-side specification

**Status: DRAFT — nothing in this document is implemented yet.**

> **Later note (Phase 5):** parts of this contract now exist (the Phase 4
> `/api/app-bridge/*` bridge and the Phase 5 workspace ↔ project link).
> §11 at the end describes what is actually implemented and the exact
> environment needed to turn it on; §1–§10 are kept as the original
> requirements record.
This is the app's statement of what it needs from the SiteRemade generator
(the separate `landing/siteremade` codebase/deployment) before the customer
app can show, edit, or publish a customer's real website. It was written
from this repository only — its code, its docs, and the one existing
cross-repo touch point (`routes/website-builder-handoff.js`). The generator
repository was **not** opened, read, or modified to write it, so everything
below that describes generator behavior is phrased as a *requirement*, not
as a description of something that exists.

Anything marked **UNKNOWN** is a question the generator side has to answer
before this contract can be finalised. Anything marked **REQUIREMENT** is
something the app cannot work without.

---

## 1. Why this document exists

The customer app is being repositioned around one idea: *your website,
editable through plain language*. The Website view is now the app's home,
and it has a "What would you like to change?" editor. That editor cannot do
anything real today, because:

1. **The app never retrieves the generator's project data.** There is no
   `fetch()` (or any other server-to-server call) anywhere in this codebase
   to a generator host. Verified by searching every `routes/*.js`,
   `lib/*.js`, `server.js`, and client file.
2. **The only integration is an identity bridge.** `GET
   /handoff/website-builder` takes the signed-in user's existing Supabase
   access token and 302-redirects to the generator origin
   (`WEBSITE_BUILDER_URL`, default `https://siteremade.com`) with
   `#bridge=<session|link>&access_token=…&expires_in=3600` in the URL
   fragment. The generator's side (`handleIdentityBridgeFragment`,
   `startSharedIdentityHandoff` — named in that route's comments) consumes
   it. That is a *login* handoff. No project, revision, URL, or deployment
   information travels in either direction.
3. **The app's own `website_projects` table is not the WebsiteProject.**
   It is a *delivery record*: an agency workflow row
   (`Intake → Brief Ready → Building → Review → Delivered`) with an intake
   form, an AI-generated build brief for a human builder, client review
   status, revision notes, linked invoices, and two free-text URL fields
   (`preview_url`, `live_url`) that SiteRemade staff type in by hand. It
   has no revision history of the site itself, no sections, no assets, no
   deployment state, and nothing in it is written by the generator.

Until the contract below exists and is implemented on both sides, the app
must (and now does — see §9):

- show only real data it already has (the delivery record's hand-entered
  preview/live URLs, the analytics domain, contact submissions);
- label that data as the delivery record, never as the canonical project;
- keep the editor's "apply" path disabled — it never reports a change as
  made, and it never writes an edit into `website_projects` as a
  substitute.

## 2. Terms

| Term | Owner | Meaning |
|---|---|---|
| **Canonical WebsiteProject** | Generator | The one authoritative record of a customer's website: its content, design, assets, revisions, and deployment. The only thing that can be edited or published. |
| **Delivery record** | App (`public.website_projects`) | SiteRemade's internal build/handover workflow row. Useful history, never a source of truth for site content. |
| **Workspace** | App (`public.workspaces`) | One customer business. Every app table is scoped by `workspace_id`; access is granted through `workspace_members (user_id, workspace_id, role)`. |
| **SiteRemade user** | Supabase Auth | `auth.users.id` (the JWT `sub`). `profiles.role` is `owner` (SiteRemade staff) or `client`. |
| **Revision** | Generator | An immutable snapshot of a project's content/design. Edits produce new revisions; publishing deploys a specific revision. |
| **Edit request** | Generator | One plain-language instruction ("change my prices") and its lifecycle: planning → previewing → ready → applied / failed / discarded. |

## 3. Identity, ownership, and linking

### 3.1 What the app can already assert
- The signed-in user's Supabase user id and email (`lib/context.js`
  `getAuthUser()` → `{ user, profile, access }`).
- The active workspace id and the user's membership role in it
  (`getContext()` → `c.wid`, `c.workspace`, `c.owner`).
- A valid, short-lived Supabase access token for that user (already
  relayed to the generator by the handoff route).

### 3.2 REQUIREMENTS on the generator
- **R-ID-1** The generator must be able to resolve a SiteRemade user (the
  Supabase `sub` the app already relays) to the generator's own account for
  that person. **UNKNOWN:** whether the generator validates that token
  against the same Supabase project, or keeps a separate account store keyed
  by it.
- **R-ID-2** Each canonical project must have exactly one owning account,
  and the generator must be able to answer "which projects does this user
  own?".
- **R-ID-3** A canonical project must be linkable to exactly one app
  workspace. Proposed field on the generator side: `appWorkspaceId` (uuid).
  **UNKNOWN:** whether the link should live on the generator (preferred —
  one source of truth) or in a new app-side mapping table. If app-side,
  the proposed shape is
  `website_project_links(workspace_id uuid, canonical_project_id text,
  linked_by uuid, linked_at timestamptz, unique(workspace_id))` —
  **proposal only, not created by this pass**.
- **R-ID-4** Purchase: if a project is created through a paid purchase on
  the generator, the project must expose `purchaseId` (opaque string) and
  the purchase's status, so the app can explain billing state without
  owning it. **UNKNOWN:** whether purchases exist on the generator today,
  and how they relate to the app's own Stripe subscription
  (`workspaces.siteremade_subscription_status`).

## 4. The WebsiteProject resource

JSON as returned by `GET` on a project (see §5). Field names are the
proposal; the generator may rename them if it documents the mapping.

```jsonc
{
  "id": "wp_…",                    // REQUIREMENT: stable, opaque, never reused
  "ownerUserId": "uuid",           // Supabase sub of the owning SiteRemade user (R-ID-1)
  "appWorkspaceId": "uuid|null",   // R-ID-3; null = not linked to an app workspace yet
  "purchaseId": "string|null",     // R-ID-4
  "name": "Northline Electric",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",         // REQUIREMENT: changes on every revision/deploy/domain change

  "revision": {                    // REQUIREMENT
    "id": "rev_…",
    "number": 42,                  // monotonically increasing per project
    "parentId": "rev_…|null",
    "createdAt": "ISO-8601",
    "source": "edit|regenerate|manual|import"   // UNKNOWN: which sources exist
  },
  "liveRevisionId": "rev_…|null",  // what is currently deployed; null = never published
  "state": "draft|live|live_with_unpublished_changes",   // derived; REQUIREMENT

  "liveUrl": "https://…|null",
  "previewUrl": "https://…|null",  // REQUIREMENT: must render the CURRENT revision; must be framable by the app origin (see §8.4)
  "domain": {
    "hostname": "northlineelectric.ca|null",
    "status": "none|pending_dns|verifying|active|error",
    "managedBy": "siteremade|customer",       // UNKNOWN: whether SiteRemade registers/hosts domains
    "error": "string|null"
  },
  "deployment": {                  // latest deployment; see §5.2
    "id": "dep_…|null",
    "status": "none|queued|building|ready|failed",
    "revisionId": "rev_…|null",
    "startedAt": "ISO-8601|null",
    "finishedAt": "ISO-8601|null",
    "error": { "code": "…", "message": "…" }
  },

  "design": {                      // current design metadata — UNKNOWN shape; minimum wanted:
    "templateId": "string|null",
    "style": "string",             // e.g. "Modern & minimal"
    "palette": ["#0d0e11", "#315cff"],
    "typography": { "display": "…", "body": "…" }
  },
  "sections": [                    // editable sections/content — UNKNOWN shape; minimum wanted:
    {
      "id": "sec_hero",
      "page": "home",
      "type": "hero|services|pricing|gallery|booking|contact|faq|custom",
      "label": "Hero",
      "order": 0,
      "editable": true,
      "summary": "Short human-readable description of what is in it"
    }
  ],
  "assets": [                      // asset references
    { "id": "ast_…", "kind": "image|logo|video|document", "url": "https://…",
      "alt": "…", "width": 1600, "height": 900, "usedIn": ["sec_hero"] }
  ],
  "schemaVersion": "string",       // REQUIREMENT: version of this resource shape
  "capabilities": {                // REQUIREMENT: per-caller, so the app never guesses
    "canEdit": true,
    "canPublish": true,
    "canRegenerate": false,
    "reasonIfNot": "string|null"
  }
}
```

The app only **needs** to render: `name`, `state`, `liveUrl`,
`previewUrl`, `domain`, `deployment.status`, `updatedAt`, `revision.number`,
`capabilities`, and (for the editor's context chips) `sections[].label`.
Everything else is wanted but can arrive later without breaking the app.

The full page/content data model (what a "section" contains) is
deliberately **not** required by the app — the app sends plain-language
instructions and shows previews; it never edits structured content itself.
**UNKNOWN:** whether the generator exposes one at all.

## 5. Operations (conceptual endpoints)

Paths are illustrative and relative to a generator API base
(**UNKNOWN**: the base URL; proposed `GENERATOR_API_URL`, separate from
`WEBSITE_BUILDER_URL`, which is the browser-facing origin). All calls are
made **server-to-server from the app backend** (see §7), never directly
from the customer's browser.

### 5.1 Read
| Operation | Request | Response |
|---|---|---|
| Get canonical project | `GET /v1/projects/{id}` | `200 WebsiteProject`, `ETag: "<revision.id>"`. `304` on `If-None-Match`. |
| Find a workspace's project | `GET /v1/projects?appWorkspaceId={uuid}` | `200 { projects: [WebsiteProject summary] }` (0 or 1 expected) |
| List a user's projects (for linking) | `GET /v1/me/projects` | `200 { projects: [...] }` |

### 5.2 Deployment status
| Operation | Request | Response |
|---|---|---|
| Latest deployment | `GET /v1/projects/{id}/deployment` | `200 { deployment }` (shape in §4) |
| Specific deployment | `GET /v1/projects/{id}/deployments/{depId}` | `200 { deployment }` |

**UNKNOWN:** polling vs push. If push, see §5.6.

### 5.3 Targeted edit (the "Update My Website" operation)
```
POST /v1/projects/{id}/edits
Idempotency-Key: <uuid generated by the app per submission>
If-Match: "<baseRevisionId>"
{
  "instruction": "Change my prices: panel upgrade is now $2,400",
  "baseRevisionId": "rev_…",
  "scope": { "sectionIds": ["sec_pricing"] },      // optional hint
  "requestedBy": { "userId": "uuid", "appWorkspaceId": "uuid" },
  "locale": "en-CA"
}
→ 202 { "edit": { "id": "ed_…", "status": "planning", "baseRevisionId": "rev_…" } }

GET /v1/projects/{id}/edits/{editId}
→ 200 { "edit": {
      "id": "ed_…",
      "status": "planning|previewing|ready|applied|failed|discarded",
      "plan": { "summary": "Update 3 prices in Pricing", "changes": [
                { "sectionId": "sec_pricing", "description": "…" } ] },
      "previewUrl": "https://…|null",     // a preview of the edited DRAFT, not live
      "resultRevisionId": "rev_…|null",   // set when status = ready/applied
      "error": { "code": "…", "message": "…" } | null
  } }

POST /v1/projects/{id}/edits/{editId}/discard   → 200 { edit }
```
REQUIREMENTS:
- An edit **never** changes the live site. It produces a draft revision
  (and a preview). Going live is always a separate publish (§5.4).
- `status` values map 1:1 onto the app's editor states (§6).
- The generator must reject instructions it cannot safely apply with a
  clear `failed` + error code (`unsupported_change`, `ambiguous_instruction`)
  rather than guessing.

### 5.4 Publish
```
POST /v1/projects/{id}/publish
Idempotency-Key: <uuid>
{ "revisionId": "rev_…" }          // REQUIREMENT: publish an explicit revision, never "whatever is latest"
→ 202 { "deployment": { "id": "dep_…", "status": "queued", "revisionId": "rev_…" } }
```

### 5.5 Regenerate (explicit only)
```
POST /v1/projects/{id}/regenerate
Idempotency-Key: <uuid>
{ "baseRevisionId": "rev_…", "reason": "…", "confirm": true }
→ 202 { "edit": { … status: "planning" … } }
```
REQUIREMENT: only ever triggered by an explicit, confirmed user action;
never as an automatic fallback for a failed targeted edit. Result is a draft
revision like any edit. **UNKNOWN:** whether regeneration exists or is
wanted at all.

### 5.6 Optional: change notifications (generator → app)
If polling proves too slow, the generator POSTs to an app webhook
(proposed `POST /api/webhooks/generator`) with events
`project.updated`, `edit.updated`, `deployment.updated`, signed with an
HMAC header over the raw body using a shared secret. The app would treat
the payload only as a hint and re-`GET` the resource. **Not implemented;
not required for v1.**

## 6. Edit lifecycle ↔ app editor states

The app's Website view (`app.js`, `WEBSITE_EDITOR_STATES`) already
implements this state set; today it can only reach `idle`, `typing`, and
`unavailable` (plus `failed` in the owner-only development mode, see §9).

| App editor state | Meaning in the UI | Generator source |
|---|---|---|
| `idle` | Nothing typed | — |
| `typing` | Customer is writing an instruction | client-only |
| `planning` | Instruction sent; generator is working out what to change | `edit.status = planning` |
| `previewing` | A draft preview exists to look at | `edit.status = previewing` (+ `previewUrl`) |
| `ready` | Draft is ready; customer may publish | `edit.status = ready` (+ `resultRevisionId`) and `capabilities.canPublish` |
| `failed` | Nothing was changed; explain why, keep the text | `edit.status = failed`, or any error in §8 |
| `unavailable` | No canonical project / no contract yet | app-side: no linked project |

"Published" is not an editor state — after a publish the editor returns to
`idle` and the header shows the deployment status from §5.2.

## 7. Authentication and permissions

### 7.1 Transport (REQUIREMENT)
- App backend → generator API, over HTTPS, server-to-server.
- Credentials never appear in URLs or query strings (same rule the
  handoff route already follows by using a fragment).
- **UNKNOWN / decision needed** — one of:
  - **(a) User-delegated:** the app forwards the user's current Supabase
    access token as `Authorization: Bearer …` (the same token the handoff
    already relays). The generator validates it (R-ID-1) and authorises on
    project ownership. Simple, but the generator must trust the app's
    Supabase project.
  - **(b) Service credential + asserted user:** the app authenticates as
    itself (shared secret or mTLS) and asserts `userId` + `appWorkspaceId`
    per call. The generator must then trust the app's authorisation
    decision.

### 7.2 Authorisation rules the app will enforce before calling
| Action | Who (app side) |
|---|---|
| View project, status, preview | Any member of the linked workspace |
| Submit / discard an edit | Workspace `owner`/`admin` members, and SiteRemade staff (`profiles.role = owner`) |
| Publish | Workspace `owner`/`admin`, SiteRemade staff |
| Regenerate | SiteRemade staff only, until the product decides otherwise |
| Link / unlink a project to a workspace | SiteRemade staff only |

The generator must enforce its own ownership check regardless (defence in
depth — same principle as the app's RLS on top of its service-role
queries).

## 8. Concurrency, idempotency, errors

### 8.1 Concurrency (REQUIREMENT)
- Every edit and publish names the revision it is based on
  (`baseRevisionId` / `revisionId`, also sent as `If-Match`).
- If the project has moved on, respond `409` with code
  `revision_conflict` and the current revision; the app shows "Your site
  changed since you started — review the latest version" and keeps the
  customer's text. The app never auto-retries a conflicting edit.
- **UNKNOWN:** whether more than one edit may be in flight per project. If
  not, respond `409 edit_in_progress` with the in-flight `editId`.

### 8.2 Idempotency (REQUIREMENT)
`Idempotency-Key` on every mutating call; the same key within 24h returns
the original result instead of creating a second edit/deployment. This lets
the app retry safely after a timeout.

### 8.3 Error shape (REQUIREMENT)
```json
{ "ok": false,
  "error": { "code": "revision_conflict", "message": "Human-readable, safe to show",
             "retryable": false, "details": { "currentRevisionId": "rev_…" } } }
```
Codes the app will handle explicitly:
`unauthenticated` (401), `forbidden` (403), `not_found` (404),
`not_linked` (404 — no project for this workspace), `revision_conflict`
(409), `edit_in_progress` (409), `ambiguous_instruction` (422),
`unsupported_change` (422), `rate_limited` (429, with `Retry-After`),
`generator_unavailable` (502/503), `timeout` (app-side, 504).

App-only code already used today: `contract_unavailable` — returned by the
app's own editor service stub when no canonical project is linked.

### 8.4 Fallback rules (app side — already implemented where possible)
- On any error: nothing is shown as changed; the instruction text is kept;
  the header keeps showing the last known good state.
- The app never falls back to writing into `website_projects` (the
  delivery record) as if it were the site.
- Preview embedding: the app shows `previewUrl`/`liveUrl` in an `<iframe>`.
  REQUIREMENT: preview URLs must allow framing by the app origin
  (`Content-Security-Policy: frame-ancestors https://app.siteremade.com`)
  or the app will only be able to link out. Live sites may keep blocking
  framing; the app already tells the customer to open in a new tab.

## 9. What the app does today (this pass) — so the contract has a landing spot

- **Website view** (`#view-website`, `renderWebsite()` in `app.js`)
  derives what it shows from the delivery record's hand-entered
  `previewUrl`/`liveUrl`/`status` plus `website_analytics.domain`, and
  labels it "From your SiteRemade delivery record". The "Builder project"
  block states plainly that the canonical project is not connected.
- **Editor** (`websiteEditService` in `app.js`) is the single seam where
  §5.3–5.5 will be called. Today every method returns
  `{ ok:false, code:'contract_unavailable' }` without making any network
  call. The submit button is disabled for customers. SiteRemade staff can
  append `?editor=dev` to exercise the state machine; that path runs the
  stub and ends in `failed` ("nothing was changed").
- A separate, clearly-labelled "Send to the SiteRemade team instead" path
  posts the customer's text to the pre-existing human request queue
  (`POST /api/app/website-updates`, table `website_updates`,
  `project_id = null`). It says a person will review it and that the site
  has not changed. It is not presented as an edit.
- **Publish** has a button slot in the Website header that renders only
  when a canonical project reports `capabilities.canPublish` and
  `state = live_with_unpublished_changes` or `draft`. With no canonical
  project it never renders.

## 10. Open questions for the generator side (blocking)

1. Does a persistent, per-customer WebsiteProject store with revisions
   exist today, or is generation one-shot? (Blocks everything.)
2. Server-to-server auth model: (a) or (b) in §7.1?
3. Where does the project ↔ app-workspace link live (§3.2 R-ID-3)?
4. Is there a machine-readable sections list, even a minimal one (§4)?
5. Who hosts the site and manages domains/DNS; is deployment status
   observable (§5.2)?
6. Can preview URLs be framed by the app origin (§8.4)?
7. Are targeted edits AI-driven on the generator, and what is their
   latency (seconds vs minutes)? This decides polling cadence.
8. Purchases: do they exist, and how do they relate to the app's Stripe
   subscription (§3.2 R-ID-4)?
9. Rate limits and quotas per project/user.
10. Retention: how long are revisions, previews and edit records kept?

## 11. Phase 5 — what is implemented, and how to turn it on

### 11.1 Identity model (as built)

- **The website's identity is the builder project id** (`projects.id`,
  `proj_` + 18 random bytes, base64url — generator `lib/project-store.js`).
  It is stable, opaque, and never reused.
- **Workspace ↔ project:** `public.website_project_links`
  (`V52-WEBSITE-PROJECT-LINK-MIGRATION.sql`), one row per workspace:
  `workspace_id` (PK) → `generator_project_id` (unique), plus
  `purchase_ref`, `analytics_site_id`, `last_seen_revision`,
  `mismatch_project_id`/`mismatch_seen_at`, `linked_at`, `updated_at`.
  Ids and timestamps only — never site content.
- **Created** by `GET /api/app/website` (`routes/website-bridge.js` →
  `lib/website-links.js`) the first time the builder returns a
  **purchased** project for a non-staff user with exactly one workspace.
  Drafts are never linked. A project already linked to another workspace
  is never linked twice (`conflict`). If the builder later reports a
  different project for the same person, the link is left alone and the
  new id is recorded for staff (`mismatch`).
- **Not an authorization shortcut:** every bridge route still asks the
  builder for the signed-in user's project with that user's own token on
  every request; the builder re-checks ownership each time.
- **Domain is display metadata only.** Builder `project_domains` rows are
  shown in the Website/Settings views and may seed the Umami site's display
  domain if verified; no lookup, link, or authorization uses a domain.

### 11.2 What hangs off the link

| Concern | Resolved by | Notes |
|---|---|---|
| Analytics | `website_analytics.provider = 'umami:<uuid>'` (unchanged read path), mirrored to `website_project_links.analytics_site_id` | Site is provisioned server-side when the link is created. A workspace only ever reuses a uuid it stored itself (no domain search/adopt). |
| Contact from a generated site | `POST /api/public/site-submission` → `website_project_links.generator_project_id` → `workspace_id` | Body names only `projectId`; any workspace id in the body is ignored. Rate limited. |
| Contact from the widget | `POST /api/public/lead` / `chat` with `workspaceId` + `publicKey` | Unchanged auth model (`public_key` is a publishable key by design); now rate limited. |
| Ads | `workspace_id` (all ad tables) | Associated with the website transitively through the link; no ad table references a project or domain. |

### 11.3 Ads capability matrix (from code, Phase 5)

| Capability | Status (and where) |
|---|---|
| READ | Implemented — staff: live campaigns (last 30 days) + account list via Google Ads `searchStream` / `listAccessibleCustomers` (`routes/google-ads.js`, owner-only). Customers: connection status (`GET /api/app/google-ads/status`) and SiteRemade-reported spend (`ad_spend` rows in bootstrap), read-only. |
| RECOMMEND | Implemented, advisory only — `ad_recommendations` sync/list/review (`routes/ad-intelligence.js`, owner-only). "Approve" only changes the row's status; nothing executes. |
| Guardrail settings | Stored only — `ad_control_settings`; `execution_locked` forced `true` on every save. The "autopilot" mode value is a stored preference with no executor behind it. |
| Record spend / fund ads | Gated — `POST /api/app/ad-spend`, `POST /api/app/ad-funds` return 503 while `ADS_FEATURE_ENABLED = false` (`server.js`). |
| PAUSE / RESUME / BUDGET CHANGE / CREATE / EDIT / DELETE | **Missing** — no route, and no Google Ads `:mutate` call anywhere in the codebase. |

### 11.4 Environment needed for the whole chain (nothing here is turned on by default)

This pass changes **no shipped default**. `SITEREMADE_APP_BRIDGE_ENABLED`
stays unset (off) in the builder, and nothing in either repo's config sets
the variables below. Turning the chain on is a deliberate, later step:

**Builder (generator) deployment**
- `SITEREMADE_APP_BRIDGE_ENABLED=true` — enables `/api/app-bridge/*`
  (404 otherwise).
- `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` (or `SUPABASE_ANON_KEY`) —
  **must be the same Supabase project as the app's**. The bridge verifies
  the app user's access token against this project; a different project
  means every call fails as unauthenticated (or, worse, a shared `sub`
  collision across projects). This was the main risk flagged in the Phase 4
  audit and still is.
- `SITEREMADE_IDENTITY_BRIDGE_MODE` other than `disabled` (with
  `SITEREMADE_IDENTITY_BRIDGE_ALLOWLIST` if `internal`) — needed so customers
  can create the `identity_links` row that maps their Supabase user to a
  builder account. Without a link, `/api/app/website` answers
  `identity_not_linked` and no workspace link is ever created.

**App deployment**
- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` (as today).
- `WEBSITE_BUILDER_URL` — the builder's real origin (server-to-server calls
  go there).
- Apply `V52-WEBSITE-PROJECT-LINK-MIGRATION.sql` (without it the Website
  view still works; linking, site submissions and Admin's link list report
  "unavailable").
- `UMAMI_BASE_URL`, `UMAMI_USERNAME`, `UMAMI_PASSWORD` — for automatic
  analytics provisioning (without them linking still works; analytics
  stays unprovisioned and is retried on later visits).
- `PUBLIC_BASE_URL` — the app's public origin (used by the analytics
  bootstrap script embedded via the widget).

**Each generated (exported) site that should deliver to Contact**
- `SUBMISSION_BACKEND=webhook`
- `SUBMISSION_WEBHOOK_URL=<app origin>/api/public/site-submission`
  The export already embeds its project id in every submission; the app
  maps it to the workspace. Default exports stay `local` (nothing sent).

Verified locally only by setting these in the test harness's own process
environment (`phase5/app-phase5-extra.js` in the engagement scratchpad),
never by editing any repo default.

### 11.5 Known limits carried forward

- The builder still resolves "the account's most recent purchased
  project" — an account with two purchases only ever sees the latest one;
  the app surfaces this as a link `mismatch` instead of re-linking.
- Generated sites do not embed the analytics tracker; visits are only
  counted on pages that carry the SiteRemade widget/analytics snippet.
- Builder domain verification is reachability only, not ownership proof;
  nothing in the app relies on it.
- Rate limits are in-process (per instance, reset on restart) and key on
  the first `X-Forwarded-For` entry, same as the existing signup limiter;
  the per-workspace ceilings are the part a client can't sidestep.
