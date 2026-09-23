# Phase 6 — controlled production test plan (staging first)

A human runs this once, top to bottom, against a **staging** pair (builder +
app on Railway, one Supabase project, one Umami instance) before the chain is
enabled for real customers. Every step lists what to do and what must be
true afterwards. Stop at the first step that doesn't match and note it —
don't work around it.

Setup reference: `WEBSITEPROJECT-CONTRACT.md` §11.4 (every variable, both
services). Nothing in either repo turns any of this on by default.

**You need:** staff (owner) access to the app; Supabase SQL editor access
for the staging project; Railway variables for both services; the Umami
admin UI; Stripe **test mode** on the builder; a spare email inbox for the
test customer; a second browser profile (customer vs staff); a laptop with
Node ≥ 18 to run an exported site.

Record as you go: test customer email, Supabase user id, workspace id,
builder project id(s), Umami website id, timestamps.

---

### Before A — preflight (no customer involved)

| Do | Expect |
|---|---|
| Apply `V52-WEBSITE-PROJECT-LINK-MIGRATION.sql`, then `V53-WEBSITE-LINK-CANDIDATES-MIGRATION.sql`, in the app's Supabase SQL editor. Run both a second time. | Both succeed both times (V53 may print "already exists, skipping" notices). `select count(*) from workspaces` unchanged. |
| `select policyname, cmd from pg_policies where tablename = 'website_project_links';` | Exactly one row: `website_project_links_select`, `SELECT`. |
| Builder: set `SUPABASE_URL` + publishable key to **the app's** project, `SITEREMADE_IDENTITY_BRIDGE_MODE=internal`, `SITEREMADE_IDENTITY_BRIDGE_ALLOWLIST=<test email>`. Leave `SITEREMADE_APP_BRIDGE_ENABLED` unset. Redeploy. | Builder boots. `curl -i <builder>/api/app-bridge/website` → **404** `{"ok":false}`. |
| App: set `WEBSITE_BUILDER_URL`, `PUBLIC_BASE_URL`, `UMAMI_*`. Keep one replica. Redeploy. | App boots; `/api/system/status` → `supabaseConfigured:true`. Admin → Website links says **"Builder connection: off …"**. |

### A — Test account

| Do | Expect |
|---|---|
| Create the test customer through the app's normal signup (the allow-listed email). | One Supabase user, one workspace, `profiles.role = 'client'`, `workspace_members` role `admin`. |
| Sign in as the customer. | Website view shows the honest fallback: "Not connected yet"; no version number, no Publish button. |

### B — Generator identity

| Do | Expect |
|---|---|
| From the app, open the builder via its normal handoff and sign in with the **same** account (unified login). | Builder signs the customer in; builder DB has one `identity_links` row → a builder account for that Supabase user id. |
| (Staff) `curl -H "Authorization: Bearer <customer access token>" <builder>/api/app-bridge/website` | Still **404** (bridge flag off) — nothing reachable yet. |

### C — Purchase / project

| Do | Expect |
|---|---|
| In the builder, create a site and buy it with a Stripe **test** card ($149.99 shown). | Stripe webhook delivered (Stripe dashboard 2xx). Builder project `status = 'purchased'`, a purchase snapshot exists, My Websites lists it. |

### D — App workspace

| Do | Expect |
|---|---|
| Customer reloads the app's Website view. | Still the honest fallback (bridge off). No `website_project_links` row yet. |

### E — Bridge enablement

| Do | Expect |
|---|---|
| Builder: `SITEREMADE_APP_BRIDGE_ENABLED=true`; raise `SITEREMADE_RATE_LIMIT_APP_BRIDGE_MAX` for expected traffic. Redeploy. | `curl -i <builder>/api/app-bridge/website` (no token) → **401**. Admin → "Builder connection: on." |

### F — Project link

| Do | Expect |
|---|---|
| Customer opens the Website view. | Builder block "Connected · Version N", title = the builder project's business name, chip "Up to date". |
| `select * from website_project_links where workspace_id = '<ws>';` | Exactly one row: `generator_project_id` = the builder project id, `purchase_ref` = the Stripe session, `last_seen_revision` = N, no mismatch. |
| Reload twice more. | Same single row; `linked_at` unchanged. |
| Admin → Website links. | Row **LINKED**, truncated project id, version N. |

### G — Analytics provisioning

| Do | Expect |
|---|---|
| Wait ~1 minute after F, refresh Admin. | "Analytics site ready". In Umami: exactly **one** new website, named after the business, domain `pending.siteremade.invalid` (or the builder's verified domain). |
| `select provider from website_analytics where workspace_id = '<ws>';` | `umami:<that website id>`; the link's `analytics_site_id` is the same id. |
| Download the site from the builder (My Websites), unzip, read `README.md`. | A "Visitor analytics (optional)" section with a tag ending `?project=<builder project id>`. Nothing analytics-related is already inside the pages. |
| Add that tag (with `https://<PUBLIC_BASE_URL host>`) to `index.html`, serve the folder (any static host or `npx serve`), open it, click around. | Browser devtools: `siteremade-analytics.js` 200, `analytics-config-by-project` 200, then `<umami>/script.js` loads with `data-website-id` = the id above. Within minutes Umami shows the visits; the app's Analytics view leaves its empty state. |

### H — Contact submission

| Do | Expect |
|---|---|
| Use a **server-required** export (a site with a contact form). Run it with `SUBMISSION_BACKEND=webhook SUBMISSION_WEBHOOK_URL=<PUBLIC_BASE_URL>/api/public/site-submission node server.js` and submit the form. | Visitor sees success. App Contact view lists it as "Website form"; a new-lead alert fires if enabled. |
| `curl -X POST <PUBLIC_BASE_URL>/api/public/site-submission -H 'Content-Type: application/json' -d '{"projectId":"proj_doesnotexist12345","values":{"name":"x","email":"x@example.com"}}'` | 404, nothing stored. Same with only `workspaceId`/`publicKey` in the body → 400. |
| Send 31 submissions for the same project from one machine within 10 minutes. | The 31st → 429 with `Retry-After`. (Confirms the app sees each client's real IP through Railway — if every request from different machines shares one bucket, stop: `X-Real-IP` isn't arriving as expected.) |

### I — Edit request

| Do | Expect |
|---|---|
| Customer: Website view → "Change my headline to …" → Update. | Planning → review list in plain language, "Saved as a draft (version N+1)", credits used shown. Builder revision incremented once. Chip "Unpublished changes". |
| Exhaust the daily editing allowance (or use a fresh-credit-less test account) and try again. | Clean "editing allowance" failure; no AI call; nothing changed. |

### J — Preview / draft

| Do | Expect |
|---|---|
| Open the builder as the customer. | The draft (N+1) contains the change; the purchased snapshot is unchanged. The app says honestly it has no visual preview. |

### K — Publish

| Do | Expect |
|---|---|
| Customer clicks Publish in the app. | "Published"; the note says hosting isn't automatic. Builder has a published snapshot at N+1. A fresh download from My Websites contains the change; nothing updates at any live address by itself. |

### L — Domain change

| Do | Expect |
|---|---|
| In the builder, add a domain to the project; later replace it with a different one. In the app, Settings → Website → "Your website address" → save a new address. | Website/Settings show the new domain. `website_project_links` row unchanged apart from `updated_at`/`last_seen_revision`. Umami website keeps the **same id** (only its display domain changes). |

### M — Analytics and Contact stay attached

| Do | Expect |
|---|---|
| Move the exported site to the new domain (or just a different host/port) without editing the tag, browse it; submit its form again. | Visits still arrive under the same Umami website id; the submission still lands in this workspace's Contact. Nothing needed re-linking. |
| **Second purchase (multi-purchase review):** buy a second site with the same account, then open the app's Website view as the customer. | Website view shows a gentle "linked to a different builder website" note. Admin row → **REVIEW** with **Resolve**: both purchases listed (truncated ids, purchase dates), nothing pre-selected. Choose one → Confirm → row LINKED to it; `audit_logs` has `website_link.relink`. If you kept the older one, the next customer visit shows REVIEW again (known limit, §11.5). |
| **Rollback drill:** unset `SITEREMADE_APP_BRIDGE_ENABLED` on the builder, redeploy. | Customer Website view returns to the honest fallback, no errors; Admin says "Builder connection: off"; Contact submissions and analytics for already-linked sites keep working (they use the stored link, not the bridge). |

---

**Pass criteria:** every "Expect" matched. Anything else is a blocker for
enabling the chain for real customers. Clean up afterwards: delete the test
customer's Umami website if not needed, refund/void the Stripe test
payments (test mode), leave V52/V53 in place.
