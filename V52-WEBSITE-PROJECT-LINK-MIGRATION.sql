-- SiteRemade V52 — Phase 5: workspace <-> builder project reference link
-- Run once in Supabase Dashboard > SQL Editor. Safe to re-run (idempotent).
--
-- What this adds: public.website_project_links, the one join the Phase 4
-- bridge was missing (see routes/website-bridge.js's header and
-- WEBSITEPROJECT-CONTRACT.md §3.2 R-ID-3). One row per workspace, naming
-- the SiteRemade builder (generator) project that IS that workspace's
-- website, by the builder's own stable, opaque project id (`proj_…`).
--
-- What it deliberately is NOT:
--   - not a copy of the website. It holds ids and timestamps only — no
--     content, no design state, no revision data, no URLs. The builder's
--     `projects` row stays the one canonical WebsiteProject; the app still
--     asks the builder for it (with the signed-in user's own token) on every
--     request. The link is a reference for display and for server-side
--     routing (Contact submissions, analytics), never an authorization
--     shortcut — the builder re-checks ownership on every bridge call.
--   - not keyed by domain. A domain is display metadata on the builder side
--     (project_domains, unverified ownership); nothing here depends on it,
--     so adding, changing or removing a domain never touches this row.
--
-- When a row is written (routes/website-bridge.js + lib/website-links.js):
--   - created once, server-side, the first time GET /api/app/website
--     succeeds for a single-workspace, non-staff customer whose builder
--     project is PURCHASED (drafts are never linked);
--   - last_seen_revision/updated_at refreshed opportunistically on later
--     reads; analytics_site_id filled in when the workspace's Umami site is
--     provisioned (the same uuid also stays in website_analytics.provider as
--     'umami:<uuid>', unchanged, so every existing analytics read still works);
--   - never re-pointed automatically. If the builder later reports a
--     DIFFERENT project for the same person, that id is recorded in
--     mismatch_project_id (for staff to review in Admin) and the link itself
--     is left alone.
-- Only the service role (this app's server) writes it; workspace members
-- and SiteRemade staff can read it — same RLS helpers as every other table.

create table if not exists public.website_project_links (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  generator_project_id text not null,
  purchase_ref text,
  analytics_site_id text,
  last_seen_revision integer,
  mismatch_project_id text,
  mismatch_seen_at timestamptz,
  linked_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.website_project_links add column if not exists purchase_ref text;
alter table public.website_project_links add column if not exists analytics_site_id text;
alter table public.website_project_links add column if not exists last_seen_revision integer;
alter table public.website_project_links add column if not exists mismatch_project_id text;
alter table public.website_project_links add column if not exists mismatch_seen_at timestamptz;
alter table public.website_project_links add column if not exists linked_at timestamptz not null default now();
alter table public.website_project_links add column if not exists updated_at timestamptz not null default now();

-- One builder project <-> at most one workspace (contract R-ID-3). Unique,
-- not just indexed: POST /api/public/site-submission resolves the owning
-- workspace from generator_project_id alone, so an ambiguous match must be
-- impossible rather than merely unlikely.
create unique index if not exists website_project_links_project_uidx on public.website_project_links(generator_project_id);

do $$ begin
  alter table public.website_project_links add constraint website_project_links_project_id_shape
    check (generator_project_id ~ '^proj_[A-Za-z0-9_-]{8,64}$');
exception
  when check_violation then raise notice 'website_project_links_project_id_shape skipped: existing rows do not match the builder id shape — reconcile, then add by hand.';
  when duplicate_object then raise notice 'website_project_links_project_id_shape already exists, skipping.';
end $$;

-- ---------------------------------------------------------------------------
-- RLS — members of the workspace and SiteRemade staff may READ; there is
-- deliberately no insert/update/delete policy, so only the service role
-- (which bypasses RLS) can write. See PHASE3-ROUTE-MAP.md's
-- production-readiness notes: tenant isolation for the app's own requests
-- comes from every route filtering by workspace_id; this is the backstop.
-- ---------------------------------------------------------------------------
alter table public.website_project_links enable row level security;
drop policy if exists "website_project_links_select" on public.website_project_links;
create policy "website_project_links_select" on public.website_project_links for select using (public.is_workspace_member(workspace_id) or public.is_siteremade_owner());

grant select, insert, update, delete on public.website_project_links to service_role;

-- No backfill: which builder project belongs to which workspace was never
-- recorded anywhere before this migration, and guessing (by domain, by
-- business name) is exactly what this table exists to avoid. Rows appear
-- as each customer next opens their Website view.
