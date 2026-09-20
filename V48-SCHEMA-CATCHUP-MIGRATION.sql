-- SiteRemade V48 — schema catch-up migration
-- Run once in Supabase SQL Editor.
--
-- V44 (Google Ads), V45 (ad intelligence), and V46 (Website Studio / website
-- intelligence) each started reading and writing tables that were never
-- committed as migrations in this repo — some were created directly in the
-- Supabase dashboard. This file defines all five so the schema is
-- reproducible from source control:
--   - google_ads_credentials  (V44)
--   - integration_connections (V36/V39/V40/V44 — generic per-provider connection state)
--   - ad_control_settings     (V45)
--   - ad_recommendations      (V45)
--   - website_projects        (V46)
--
-- Safe to run whether or not these tables already exist: every table uses
-- `create table if not exists`, and every column is additionally declared
-- with `alter table ... add column if not exists` so a table created by hand
-- with a partial/different shape converges to this one without data loss.

-- ---------------------------------------------------------------------------
-- integration_connections — one row per (workspace, provider) connection.
-- Used by Twilio (V36/V39/V40) and Google Ads (V44); provider-specific state
-- lives in the `config` jsonb column.
-- ---------------------------------------------------------------------------
create table if not exists public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null,
  status text not null default 'connected',
  external_id text,
  account_label text,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.integration_connections add column if not exists workspace_id uuid references public.workspaces(id) on delete cascade;
alter table public.integration_connections add column if not exists provider text;
alter table public.integration_connections add column if not exists status text not null default 'connected';
alter table public.integration_connections add column if not exists external_id text;
alter table public.integration_connections add column if not exists account_label text;
alter table public.integration_connections add column if not exists config jsonb not null default '{}'::jsonb;
alter table public.integration_connections add column if not exists created_at timestamptz not null default now();
alter table public.integration_connections add column if not exists updated_at timestamptz not null default now();
-- Guarded the same way the CHECK constraints near the bottom of this file
-- are: if integration_connections already existed (hand-created, per the
-- header comment) with duplicate (workspace_id, provider) rows, a bare
-- `create unique index` here would throw and roll back this entire script
-- (one Supabase SQL Editor run is one transaction) with everything above
-- already having a NOTICE-only fallback, this was the one statement left
-- that could still abort the run — production data was never inspected to
-- confirm there are no duplicates, so this can't safely assume there
-- aren't any.
do $$ begin
  execute 'create unique index if not exists integration_connections_workspace_provider_idx on public.integration_connections(workspace_id, provider)';
exception when unique_violation then
  raise notice 'integration_connections_workspace_provider_idx skipped: existing duplicate (workspace_id, provider) rows found. Run: select workspace_id, provider, count(*) from public.integration_connections group by 1,2 having count(*) > 1; — then reconcile the data before adding this unique index by hand.';
end $$;
create index if not exists integration_connections_provider_status_idx on public.integration_connections(provider, status);
-- Visibility for the other half of the same pre-existing risk: lines 36-37
-- above add workspace_id/provider without `not null` (unlike the
-- create-table path above them), because forcing `not null` on an ALTER
-- against a table that might already have rows without a default would
-- itself risk aborting the migration. If integration_connections was
-- hand-created without these columns, existing rows now silently have a
-- NULL workspace_id — invisible to is_workspace_member() and excluded from
-- the unique index above (NULLs are distinct). This makes that condition
-- impossible to miss instead of silent:
do $$ declare n int; begin
  select count(*) into n from public.integration_connections where workspace_id is null;
  if n > 0 then
    raise notice 'integration_connections has % row(s) with a NULL workspace_id — these are invisible to workspace-scoped RLS/app queries and were not backfilled by this migration (the correct workspace can''t be inferred here). Identify and fix them by hand before relying on this table.', n;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- google_ads_credentials — one row per workspace's connected Google Ads OAuth.
-- ---------------------------------------------------------------------------
create table if not exists public.google_ads_credentials (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  google_user_email text not null default '',
  access_token text not null default '',
  refresh_token text not null default '',
  expires_at timestamptz,
  scope text not null default '',
  manager_customer_id text not null default '',
  selected_customer_id text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.google_ads_credentials add column if not exists google_user_email text not null default '';
alter table public.google_ads_credentials add column if not exists access_token text not null default '';
alter table public.google_ads_credentials add column if not exists refresh_token text not null default '';
alter table public.google_ads_credentials add column if not exists expires_at timestamptz;
alter table public.google_ads_credentials add column if not exists scope text not null default '';
alter table public.google_ads_credentials add column if not exists manager_customer_id text not null default '';
alter table public.google_ads_credentials add column if not exists selected_customer_id text not null default '';
alter table public.google_ads_credentials add column if not exists created_at timestamptz not null default now();
alter table public.google_ads_credentials add column if not exists updated_at timestamptz not null default now();

-- ---------------------------------------------------------------------------
-- ad_control_settings — one row per workspace: guardrails for the ad
-- recommendation engine. execution_locked is always forced true by the
-- application; autopilot execution is not implemented.
-- ---------------------------------------------------------------------------
create table if not exists public.ad_control_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  mode text not null default 'observe' check (mode in ('observe','recommend','autopilot')),
  objective text not null default 'Leads',
  daily_cap numeric(12,2) not null default 25,
  monthly_cap numeric(12,2) not null default 750,
  max_shift numeric(6,2) not null default 15,
  min_data integer not null default 20,
  cooldown_hours integer not null default 48,
  execution_locked boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.ad_control_settings add column if not exists mode text not null default 'observe';
alter table public.ad_control_settings add column if not exists objective text not null default 'Leads';
alter table public.ad_control_settings add column if not exists daily_cap numeric(12,2) not null default 25;
alter table public.ad_control_settings add column if not exists monthly_cap numeric(12,2) not null default 750;
alter table public.ad_control_settings add column if not exists max_shift numeric(6,2) not null default 15;
alter table public.ad_control_settings add column if not exists min_data integer not null default 20;
alter table public.ad_control_settings add column if not exists cooldown_hours integer not null default 48;
alter table public.ad_control_settings add column if not exists execution_locked boolean not null default true;
alter table public.ad_control_settings add column if not exists created_at timestamptz not null default now();
alter table public.ad_control_settings add column if not exists updated_at timestamptz not null default now();

-- ---------------------------------------------------------------------------
-- ad_recommendations — guarded, human-approved suggestions surfaced from ad
-- platform data. Always inserted with status 'pending'; the app only ever
-- flips status via explicit owner review (approved/dismissed) or sync-driven
-- expiry (expired). Nothing here executes automatically.
-- ---------------------------------------------------------------------------
create table if not exists public.ad_recommendations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null default 'google_ads',
  customer_id text not null default '',
  campaign_id text,
  campaign_name text,
  recommendation_key text not null,
  recommendation_type text not null default 'info',
  severity text not null default 'info',
  title text not null,
  reason text not null default '',
  proposed_action text not null default '',
  proposed_change jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  confidence numeric(3,2) not null default 0 check (confidence >= 0 and confidence <= 1),
  data_points integer not null default 0,
  status text not null default 'pending' check (status in ('pending','approved','dismissed','expired')),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.ad_recommendations add column if not exists provider text not null default 'google_ads';
alter table public.ad_recommendations add column if not exists customer_id text not null default '';
alter table public.ad_recommendations add column if not exists campaign_id text;
alter table public.ad_recommendations add column if not exists campaign_name text;
alter table public.ad_recommendations add column if not exists recommendation_key text;
alter table public.ad_recommendations add column if not exists recommendation_type text not null default 'info';
alter table public.ad_recommendations add column if not exists severity text not null default 'info';
alter table public.ad_recommendations add column if not exists title text;
alter table public.ad_recommendations add column if not exists reason text not null default '';
alter table public.ad_recommendations add column if not exists proposed_action text not null default '';
alter table public.ad_recommendations add column if not exists proposed_change jsonb not null default '{}'::jsonb;
alter table public.ad_recommendations add column if not exists evidence jsonb not null default '{}'::jsonb;
alter table public.ad_recommendations add column if not exists confidence numeric(3,2) not null default 0;
alter table public.ad_recommendations add column if not exists data_points integer not null default 0;
alter table public.ad_recommendations add column if not exists status text not null default 'pending';
alter table public.ad_recommendations add column if not exists reviewed_at timestamptz;
alter table public.ad_recommendations add column if not exists created_at timestamptz not null default now();
alter table public.ad_recommendations add column if not exists updated_at timestamptz not null default now();
-- Same guard as integration_connections above: don't let a duplicate-data
-- unique-index failure abort the rest of this script.
do $$ begin
  execute 'create unique index if not exists ad_recommendations_unique_key_idx on public.ad_recommendations(workspace_id, provider, customer_id, recommendation_key)';
exception when unique_violation then
  raise notice 'ad_recommendations_unique_key_idx skipped: existing duplicate (workspace_id, provider, customer_id, recommendation_key) rows found. Run: select workspace_id, provider, customer_id, recommendation_key, count(*) from public.ad_recommendations group by 1,2,3,4 having count(*) > 1; — then reconcile the data before adding this unique index by hand.';
end $$;
create index if not exists ad_recommendations_workspace_status_idx on public.ad_recommendations(workspace_id, provider, customer_id, status);
do $$ declare n int; begin
  select count(*) into n from public.ad_recommendations where workspace_id is null;
  if n > 0 then
    raise notice 'ad_recommendations has % row(s) with a NULL workspace_id — same risk as integration_connections above; identify and fix by hand.', n;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- website_projects — Website Studio (V46). Intake -> AI brief -> builder
-- prompt -> delivery status for a website build tied to a workspace/lead.
-- This is the current V46 shape only; Phase 2 of the website-lifecycle
-- rework will extend this table (revision history, delivery URL, payment
-- linkage) in a follow-up migration rather than replacing it.
-- ---------------------------------------------------------------------------
create table if not exists public.website_projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null,
  business_name text not null default '',
  source text not null default 'SiteRemade',
  intake_text text not null default '',
  design_direction jsonb not null default '{}'::jsonb,
  brief jsonb not null default '{}'::jsonb,
  builder_prompt text not null default '',
  status text not null default 'Intake' check (status in ('Intake','Brief Ready','Building','Review','Delivered')),
  ai_provider text not null default '',
  ai_model text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.website_projects add column if not exists lead_id uuid references public.leads(id) on delete set null;
alter table public.website_projects add column if not exists business_name text not null default '';
alter table public.website_projects add column if not exists source text not null default 'SiteRemade';
alter table public.website_projects add column if not exists intake_text text not null default '';
alter table public.website_projects add column if not exists design_direction jsonb not null default '{}'::jsonb;
alter table public.website_projects add column if not exists brief jsonb not null default '{}'::jsonb;
alter table public.website_projects add column if not exists builder_prompt text not null default '';
alter table public.website_projects add column if not exists status text not null default 'Intake';
alter table public.website_projects add column if not exists ai_provider text not null default '';
alter table public.website_projects add column if not exists ai_model text not null default '';
alter table public.website_projects add column if not exists created_at timestamptz not null default now();
alter table public.website_projects add column if not exists updated_at timestamptz not null default now();
create index if not exists website_projects_workspace_updated_idx on public.website_projects(workspace_id, updated_at desc);
create index if not exists website_projects_lead_idx on public.website_projects(lead_id);

-- ---------------------------------------------------------------------------
-- RLS — same workspace-member-or-siteremade-owner pattern used everywhere
-- else in this schema.
-- ---------------------------------------------------------------------------
alter table public.integration_connections enable row level security;
alter table public.google_ads_credentials enable row level security;
alter table public.ad_control_settings enable row level security;
alter table public.ad_recommendations enable row level security;
alter table public.website_projects enable row level security;

do $$ declare t text; begin
  foreach t in array array['integration_connections','google_ads_credentials','ad_control_settings','ad_recommendations','website_projects'] loop
    execute format('drop policy if exists %I on public.%I', 'workspace_member_access', t);
    execute format('create policy %I on public.%I for all using (public.is_siteremade_owner() or public.is_workspace_member(workspace_id)) with check (public.is_siteremade_owner() or public.is_workspace_member(workspace_id))', 'workspace_member_access', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Enum-style CHECK constraints. These only matter if the table already
-- existed (created by hand) before this migration ran — a fresh `create
-- table` above already has them inline. Each is added defensively: if any
-- existing row already violates it, the ALTER is skipped with a NOTICE
-- instead of failing the whole migration, since we can't inspect production
-- data from here.
-- ---------------------------------------------------------------------------
do $$ begin
  alter table public.website_projects add constraint website_projects_status_check
    check (status in ('Intake','Brief Ready','Building','Review','Delivered'));
exception when check_violation then
  raise notice 'website_projects_status_check skipped: existing rows have a status value outside (Intake, Brief Ready, Building, Review, Delivered) — reconcile the data, then add this constraint by hand.';
when duplicate_object then
  raise notice 'website_projects_status_check already exists, skipping.';
end $$;

do $$ begin
  alter table public.ad_control_settings add constraint ad_control_settings_mode_check
    check (mode in ('observe','recommend','autopilot'));
exception when check_violation then
  raise notice 'ad_control_settings_mode_check skipped: existing rows have a mode value outside (observe, recommend, autopilot) — reconcile the data, then add this constraint by hand.';
when duplicate_object then
  raise notice 'ad_control_settings_mode_check already exists, skipping.';
end $$;

do $$ begin
  alter table public.ad_recommendations add constraint ad_recommendations_status_check
    check (status in ('pending','approved','dismissed','expired'));
exception when check_violation then
  raise notice 'ad_recommendations_status_check skipped: existing rows have a status value outside (pending, approved, dismissed, expired) — reconcile the data, then add this constraint by hand.';
when duplicate_object then
  raise notice 'ad_recommendations_status_check already exists, skipping.';
end $$;

grant select, insert, update, delete on public.integration_connections to service_role;
grant select, insert, update, delete on public.google_ads_credentials to service_role;
grant select, insert, update, delete on public.ad_control_settings to service_role;
grant select, insert, update, delete on public.ad_recommendations to service_role;
grant select, insert, update, delete on public.website_projects to service_role;
