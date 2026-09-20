# SiteRemade visual redesign — audit, design system, and IA (V2)

This document is the "before coding" deliverable for the visual redesign:
what's actually there today (audited, not assumed), the new visual system,
the new information architecture, and which screens should feel
intentionally different from each other. Implementation follows this
document incrementally — see the "Implementation status" section at the
bottom, which is the live tracker as work lands.

## 1. Audit: why the app currently reads as generic CRM

The app was built in 30 versioned passes (v17 → v46), and the visual
layer was never consolidated — it was extended. Concretely, as it stands
today:

- **Three parallel design-token systems are live at once** in `app.css`:
  the original `:root` block, a later "V2" block that redeclares half the
  same tokens with different values (`--radius:22px` → `14px`,
  `--sidebar:248px` → `224px`), and `v22.css`'s own separately-named
  `--v22-*` tokens. No component consistently draws from one of them.
- **Four unrelated class families express the same "status chip" concept**
  (`.status-pill`, `.status-{Name}`, `.v34-state`, `.channel-chip`,
  `.invoice-status`), each with its own near-but-not-quite-matching colors
  — five different reds alone exist for "danger/negative."
- **Three unrelated button systems**: the pill system (`.primary-action` /
  `.secondary-button` / `.light-button`, radius 999px, black primary), a
  locally reinvented pill in `v17.css`, and hardcoded inline-styled
  buttons in `v40-existing-number-client.js` and elsewhere with a totally
  different radius (12px) invisible to any shared CSS rule.
- **Card radius drifts six ways** depending on which pass wrote the rule
  (22px root → 14px override → 20px in v22 → 18px in v34 → 12–18px in
  v42/43 → 24–28px on modals/auth cards), with no visual logic to the
  differences.
- **`v43-ad-control.css` (Google Ads admin panel) uses a warm beige
  palette** found nowhere else in an otherwise strictly cool-gray product
  — an unintentional, jarring outlier, not a deliberate accent.
- **No loading-state component exists anywhere** — "loading" is handled
  by swapping in plain text ("Checking…", "Loading…") with no
  skeleton/spinner, so every async wait currently reads as a stalled UI
  rather than a working one.
- **Two rendering styles coexist**: `app.js`'s own view renderers (Leads,
  Inbox, Calendar, Payments) are disciplined and class-based — a CSS
  rewrite reaches them cleanly. But `v40-existing-number-client.js` (phone
  verification), `v44-google-ads-client.js` (campaign rows, AI
  recommendation cards), and parts of `v45`/`v46` build their markup with
  hardcoded inline `style="..."` strings that bypass the stylesheet
  entirely. **These need direct JS edits, not just new CSS**, or they'll
  stay visually stuck in the old skin no matter how good the new
  stylesheet is.
- **Sidebar nav has two groups separated by a bare divider, no labels** —
  the grouping is structural only; nothing visually reinforces "these five
  are the daily-operations tools, these six are secondary."
- One genuinely good existing pattern worth keeping outright: the
  `.feature-blocked` / `.feature-block-overlay` blur-lock treatment used on
  unfinished ad-funding panels. It's a clean, deliberate "locked" state —
  the rest of the system should adopt this same *quality* of intent.

None of this is a backend or functional problem — every screen audited
works. It's a visual-layer accumulation problem, which is exactly what a
redesign pass should fix.

## 2. New visual system

### Typography

Three families, each doing one job, so hierarchy comes from font choice
as much as size:

- **Display / editorial — `Fraunces`** (variable serif, loaded from
  Google Fonts with `font-display: swap` and a system-serif fallback).
  Used only for page titles and command-center hero numbers — the one
  place the product should feel considered rather than utilitarian. Never
  used in dense UI (tables, forms, nav).
- **UI / body — `Inter`** (already in use; keep it — it's a good, neutral
  workhorse and changing it would touch every line of text in the app for
  no real gain). Used for everything else: nav, forms, buttons, body copy.
- **Data / numerals — `Inter` with `font-variant-numeric: tabular-nums`**
  for every metric, currency amount, and count, so numbers in a column
  align vertically instead of jittering — a small detail that reads as
  "financial-grade" rather than "dashboard template."

Scale (replacing the current ad hoc sizes, all as tokens):
`--text-display: 34px/1.15` (serif) · `--text-h1: 23px/1.25` ·
`--text-h2: 17px/1.3` · `--text-eyebrow: 11px/1, 700, uppercase,
0.08em` (section/status micro-labels) · `--text-body: 13.5px/1.5` ·
`--text-small: 12px/1.4` · `--text-micro: 10.5px/1.3` (table headers).

### Color

One token set, no overrides layered on top of it elsewhere:

```
--ink-900:#15161b   --ink-700:#3c3f47   --ink-500:#6c707a   --ink-300:#9a9ea7
--line:#e6e8ec      --line-strong:#d8dbe1
--surface:#ffffff   --canvas:#f6f6f9   --surface-sunken:#f1f2f5
--accent:#315cff    --accent-tint:#eef2ff   --accent-ink:#1c3ebf   (kept — already the established brand blue; the redesign consolidates every orphaned variant like #4c6ef5 onto this one value instead of replacing it)
--success:#147d58   --success-tint:#e8f6ee
--danger:#b3261e    --danger-tint:#fdecea
--warning:#9a6a13   --warning-tint:#fdf3df
```

Every chip, badge, trend arrow, and status color in the product maps onto
exactly one of the four semantic pairs above — nothing hardcodes a color
outside this palette.

### Elevation, radius, spacing

- Shadows (3 tiers, used deliberately, not on every card):
  `--shadow-sm` (hairline lift, hover only) · `--shadow-md` (raised
  panels, popovers) · `--shadow-lg` (modals, the command-center hero).
- Radius (4 tiers, one job each): `--radius-sm:10px` (inputs, small
  chips) · `--radius-md:16px` (default panel) · `--radius-lg:22px`
  (flagship/hero cards, modals) · pill (`999px`) reserved for buttons and
  status chips only, never for panels.
- Spacing: a single 4px-based scale (4/8/12/16/20/24/32/40/56/72) —
  replaces the mix of 9/11/13/14/17/18px paddings currently scattered
  across the vNN files.

### Components (one system, one place each)

- **Buttons** — one base `.btn` + `.btn-primary` (ink-900 fill) /
  `.btn-secondary` (surface-sunken) / `.btn-ghost` (border only) /
  `.btn-danger`. Pill-shaped, consistent height (36/40/44px — small/
  default/large), consistent 12px/650-weight label. Every inline-styled
  button in v40/v44 gets converted to these classes.
- **Inputs** — one field system: 44px height, `--radius-sm`, label style
  is the `--text-eyebrow` treatment, focus state is a 2px accent ring at
  20% opacity plus a 1px accent border (there is currently no consistent
  focus treatment at all).
- **Cards** — `.panel` (default) and `.panel-flagship` (hero/dense
  variant with `--radius-lg` and a subtle top hairline instead of a full
  border, for the command-center and Website Projects screens) — two
  intentional variants instead of six accidental ones.
- **Status chips** — one `.chip` base + `.chip-success/-warning/-danger/
  -neutral/-info` modifiers. `.status-pill`, `.v34-state`, `.channel-chip`,
  `.invoice-status` all become thin aliases that apply the same base
  classes, so no call site has to change its JS, only what CSS backs it.
- **Tables** — keep the current `.lead-table` structure (it was already
  consistent) but refine the header to the eyebrow treatment and add a
  restrained row-hover state.
- **Modals** — standardized `--radius-lg`, `--shadow-lg`, backdrop blur
  (extending the existing `.feature-block-overlay` blur pattern, which
  already proves the product can do this well).
- **Loading state (new)** — a `.skeleton` shimmer block (CSS-only,
  respects `prefers-reduced-motion`) replaces bare "Loading…" text
  wherever a panel is waiting on data.
- **Empty state** — one `.empty-state` component (the product already
  mostly does this right) with an optional icon + short action link,
  replacing the orphaned `.v29-empty` duplicate.

### Motion

Restrained and functional only: 150ms ease for hover/focus, 200ms
ease-out for panel/modal enter, 120ms for chip/status changes. Nothing
decorative, nothing on page load, everything gated behind
`prefers-reduced-motion: no-preference`.

## 3. Information architecture

Sidebar nav becomes five labeled groups instead of two unlabeled ones,
matching the product structure directly:

```
Overview                          ← ungrouped, pinned at top (command center)
── OPERATIONS ──
Leads · Inbox · Calendar · Payments      ← one connected customer journey
── DELIVERY ──
Website Projects                          ← flagship, its own visual identity
── GROWTH ──
Market Finder · Analytics
── CONFIGURATION ──
Automations · Integrations · Settings     ← visually quieter, secondary
── ADMIN ── (owner-only, unchanged gating)
Admin
```

Mobile bottom nav keeps its current 5 high-frequency slots (Overview,
Leads, Inbox, Calendar, Payments) since usage frequency — not
architecture — should drive what's one tap away; the "More" sheet is
reorganized into the same five labeled groups instead of one flat grid.

## 4. Which screens should feel intentionally different

- **Overview** — the command center. Editorial hero treatment (serif
  headline, one dominant "what needs attention" surface), low card count,
  high information density done through typography rather than more
  boxes.
- **Website Projects** — the flagship delivery workspace. Should feel like
  project-management software for an agency, not a CRM tab: a real
  workspace layout (project list + detail, not just cards), its own
  denser data treatment, `.panel-flagship` throughout.
- **Leads / Inbox / Calendar / Payments** — share one visual language and
  explicit connective tissue (a lead's record should visibly link forward
  to its conversation, appointment, and invoice) so they read as stages of
  one journey, not four unrelated tools.
- **Growth (Market Finder, Analytics)** — distinct accent treatment from
  Operations (data-forward, chart-first, less form-heavy) so it doesn't
  feel like "more CRM."
- **Automations / Integrations / Settings** — deliberately quieter:
  smaller type, more list-like density, fewer hero elements — this is
  configuration, not a workspace, and should look like it.
- **Admin** — an owner/operator control layer: darker chrome accents,
  clearer "this changes something" affordances (the existing
  `.feature-blocked` lock pattern extends naturally here).

## 5. Implementation plan (incremental, in this order)

1. Foundation: consolidate `app.css` tokens/typography/buttons/inputs/
   cards/chips/table/modal/sidebar/topbar/nav-grouping into the one system
   above. Everything downstream depends on this landing first.
2. Overview → command center.
3. Website Projects → flagship delivery workspace.
4. Leads/Inbox/Calendar/Payments → shared journey treatment + connective
   cues.
5. Growth, Configuration, Admin → distinct identities.
6. JS-level conversion of inline-styled renderers (`v40`, `v44`, parts of
   `v45`/`v46`) onto the new component classes — required for those
   screens to actually pick up the redesign.
7. Full regression pass (existing suite) + mobile pass after every step.

No backend contract, auth, billing, integration, or database behavior
changes at any step — this is the presentation layer only.

## Implementation status

- [x] Step 1 — foundation. Landed as `design-system.css` (loaded after
      app.css, using a `body `-prefixed specificity bump so it keeps
      winning against per-version CSS injected later at runtime — see the
      file's own header comment for why). Covers: consolidated tokens
      (redeclares the same custom-property names app.css already used, so
      existing `var(--x)` references retheme automatically), typography
      (system-serif page titles/hero numbers post-login only — no webfont
      dependency added, deliberately, given this app's own prior
      pre-auth-performance work), one button/input/card/chip/table/modal
      system, a new `.skeleton` loading component, and the v43-ad-control
      warm-beige outlier fixed to the cool-neutral palette. Also landed as
      part of this step: the 5-group labeled sidebar IA (§3) in
      `index.html` (desktop sidebar + mobile "More" sheet), with owner-only
      Admin-section gating extended to the new divider/label wrapper in
      `app.js`'s `renderWorkspace()`. A real regression was caught and
      fixed here: the taller 5-group nav could push lower items past
      100vh with nothing scrollable to reach them (confirmed via a broken
      Playwright click target, not just eyeballing) — fixed with
      `overflow-y:auto` on `.sidebar`. Verified against the full existing
      test suite (smoketest/e2e/ui/mobile/live-refresh/fingerprint, all
      passing) plus visual screenshot review at desktop and 390px mobile.
- [x] Step 2 — Overview command center. Traced the real render path (not
      just index.html): Overview is actually 3 separately-injected
      surfaces on top of the static page — v22-client.js's "TODAY'S
      BUSINESS" hero, the static 4-card metric-grid, and v42-daily-
      workflow.js's "NEEDS ATTENTION" list — which were fighting for the
      same job as 3 equal-weight boxes with real numeric overlap (Active
      leads/Outstanding appeared in two places). Fixed the hierarchy
      itself, not just the skin: the hero is now the dominant opening
      band with its 5 stats as plain dividers instead of 5 more little
      boxes; the 4 metric cards collapse into one dense divided strip
      (same 4 elements/ids, zero JS changes) instead of 4 separate
      bordered boxes; the attention list gets the flagship top-hairline
      treatment as the clear "what to do next" surface; Activity is now
      a deliberately quieter companion rail instead of competing equally
      with Recent Leads. All CSS-only — no DOM structure, IDs, or
      behavior touched.
- [x] Step 3 — Website Projects flagship workspace. Two real additive
      changes, not just restyling: (1) a new 5-stage visual lifecycle
      stepper (Intake → Brief Ready → Building → Review → Delivered),
      shown on both the owner and client-facing project detail views —
      genuinely new UI, built as a small pure function
      (`projectStepper()` in app.js) that sits above the existing status
      control without touching it or its onchange handler at all; (2)
      the project list's selected-row highlight moved off an inline
      conditional `style="border:..."` (which used a fallback accent
      color that didn't match the app's real accent anywhere else — a
      leftover from the audit) onto a proper `.selected` class with a
      real tinted-background + left-accent-bar treatment. Both panels
      get the flagship top-hairline treatment from Step 1, extended.
- [x] Step 4 — Leads/Inbox/Calendar/Payments connected customer journey.
      The backend already links these four screens through real fields
      (`conversation.leadId`, `appointment.leadId`, `invoice.leadId`) that
      nothing in the UI surfaced — this step makes those existing
      relationships visible rather than inventing new ones. Four changes:
      (1) **consistent customer identity** — Leads' table and Payments'
      transaction rows now use the same avatar-initial + name treatment
      Inbox already had, so the same person looks like the same person
      wherever they appear; (2) **the one real missing link** — Payments
      had no way back to the customer record despite `invoice.leadId`
      existing on every customer invoice; a customer-id is now a button
      (`data-open-invoice-lead`) that switches to Leads and opens that
      lead's drawer, wired only where a leadId is actually present (the
      ad-fund-history rows, which have no lead relationship, were left
      exactly as they were — no invented link); (3) **status-color
      realignment** — the calendar's lead-status event colors
      (`v17-client.js`'s existing `applyCalendarLeadStatus()`) used a
      different Contacted/Quoted color mapping than the status-pill
      system everywhere else; both now draw from the same semantic
      tokens, so a lead's status reads as the same color on the Leads
      table, the lead drawer, and the calendar; (4) **a real timeline
      instead of a generic list** — the lead drawer's customer-history
      feed (`v41-experience.js`'s `activityForLead`/`paintLeadWorkflow`)
      now tags each event with a `kind` (lead/message/appointment/
      invoice/note), renders a distinct icon+color per kind, and draws a
      connecting line down the timeline, so "conversation → booking →
      invoice" reads as one continuous thread instead of a flat list. The
      lead-drawer workflow panel and the calendar's agenda panel also
      picked up the same flagship top-hairline treatment as Overview's
      attention list and Website Projects' panels, for visual continuity
      across the whole journey. One real regression was caught and fixed
      during verification, not just eyeballed: removing Payments' old
      generic `.payment-icon` glyph in favor of the customer avatar
      silently shifted every other cell in `.transaction-list`'s
      implicit 6-column grid over by one, overlapping the customer name
      on top of the description text (app.css's grid — and its <900px
      named-grid-area variant — assumed a fixed 6-child row shape with a
      bare `<strong>` as the row's 2nd direct child). Fixed with a
      `#transactionList`-scoped override in design-system.css for both
      the desktop grid and the <900px card layout; `#adFundHistory`
      (unchanged template, still has its own icon) was left untouched.
      Verified against the full existing test suite (smoketest/e2e/ui/
      mobile/live-refresh/fingerprint, all passing) plus visual
      screenshot review — including the Payments→Lead click-through
      itself — at desktop and 390px mobile, both before and after the
      transaction-list fix.
- [ ] Step 5 — deeper Growth / Configuration / Admin identity work beyond
      the accent-tint/quieter-type pass already applied
- [ ] Step 6 — inline-styled JS renderer conversion (`v40-existing-number-
      client.js`, `v44-google-ads-client.js` campaign rows/AI cards) — a
      CSS-only pass cannot reach these; still on the old visual skin
- [ ] Step 7 — final full regression + mobile pass (a full pass already
      ran clean after Step 1; repeats after each further step)

(This checklist is updated in place as each step lands, and each step is
committed separately so the work stays reviewable and revertible.)
