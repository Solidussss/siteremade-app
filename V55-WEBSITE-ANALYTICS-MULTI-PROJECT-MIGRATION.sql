-- SiteRemade V55 -- Phase 9: analytics becomes project-aware, not just
-- workspace-aware. Run once in Supabase Dashboard > SQL Editor, AFTER V54.
-- Safe to re-run (idempotent). Additive/structural only: no existing row's
-- workspace_id/domain/provider/connected/sessions/users/pageviews value is
-- changed, nothing is dropped.
--
-- Why: public.website_analytics (V12) has always had workspace_id as its
-- PRIMARY KEY -- exactly the same one-row-per-workspace limitation V54
-- removed from website_project_links, and for the identical reason it
-- needs removing here: this ticket's own §10 --
--   "If a customer owns multiple websites, analytics cannot just mean:
--    workspace analytics. It needs to understand which generator
--    project/site is being viewed."
-- A workspace that has connected two SiteRemade projects (V54) could not
-- previously get two separate Umami sites/analytics rows -- both projects
-- would have been forced to share the one existing workspace-level row,
-- meaning the second project's "Analytics" page would show the FIRST
-- project's traffic. That was never exercised before V54 (a workspace
-- could never have a second connected project to expose the bug), but it
-- is a real, live bug the moment multi-project linking is enabled without
-- this migration.
--
-- What changes structurally (identical shape to V54 -- see that file's own
-- header for the full reasoning on why a surrogate PK + a plain index is
-- the right fix, not repeated here):
--   - a new surrogate `id uuid primary key default gen_random_uuid()`
--     replaces workspace_id as the primary key. Every existing row keeps
--     its exact workspace_id/domain/provider/connected/etc values.
--   - workspace_id keeps its NOT NULL + FK, gains a plain (non-unique)
--     index instead of being the key itself.
--   - a new nullable `project_id text` column: NULL on every row that
--     predates this migration (and on any future row that is genuinely
--     workspace-level, not tied to one project -- see below), the
--     generator's `proj_...` id on a project-scoped row going forward.
--   - a PARTIAL unique index on (workspace_id, project_id) WHERE
--     project_id IS NOT NULL: at most one analytics row per connected
--     project. Deliberately NOT a plain unique index on the pair, because
--     Postgres treats every NULL as distinct for uniqueness purposes
--     anyway -- the WHERE clause just makes that explicit and self-
--     documenting rather than relying on incidental NULL behavior.
--
-- Existing rows (project_id NULL) are untouched and remain exactly as
-- readable as before by anything that queries workspace_id alone -- routes/
-- umami-analytics.js's existing functions gain an OPTIONAL projectId
-- parameter (default null) so every pre-Phase-9 call site is unaffected
-- byte-for-byte; only new, explicitly project-scoped calls pass a real one.
--
-- IMPORTANT (same discipline V54's own header calls out): once a second
-- row for the same workspace can exist, any code that reads this table
-- with .maybeSingle() filtered ONLY by workspace_id would THROW as soon as
-- a project-scoped row is added alongside the legacy one. Every read in
-- routes/umami-analytics.js is updated in the same pass as this migration
-- to also filter on project_id (.is('project_id', null) for the legacy/
-- workspace-level lookup, .eq('project_id', projectId) for a project-
-- scoped one) -- never workspace_id alone once this migration is live.

alter table public.website_analytics add column if not exists id uuid default gen_random_uuid();
update public.website_analytics set id = gen_random_uuid() where id is null;
alter table public.website_analytics alter column id set not null;

do $$
declare
  old_pk text;
begin
  select tc.constraint_name into old_pk
    from information_schema.table_constraints tc
    where tc.table_schema = 'public' and tc.table_name = 'website_analytics' and tc.constraint_type = 'PRIMARY KEY';
  if old_pk is not null and old_pk <> 'website_analytics_pkey' then
    execute format('alter table public.website_analytics drop constraint %I', old_pk);
  elsif old_pk = 'website_analytics_pkey' then
    if not exists (
      select 1 from information_schema.key_column_usage k
      where k.constraint_schema = 'public' and k.constraint_name = old_pk and k.column_name = 'id'
    ) then
      execute format('alter table public.website_analytics drop constraint %I', old_pk);
    end if;
  end if;
end $$;

do $$ begin
  alter table public.website_analytics add constraint website_analytics_pkey primary key (id);
exception
  when invalid_table_definition then raise notice 'website_analytics_pkey already present on the right column, skipping.';
  when duplicate_object then raise notice 'website_analytics_pkey already exists, skipping.';
end $$;

alter table public.website_analytics alter column workspace_id set not null;
-- workspace_id's FK to workspaces(id) is a column-level constraint from its
-- original CREATE TABLE and is untouched by dropping/re-adding the PK.

create index if not exists website_analytics_workspace_idx on public.website_analytics(workspace_id);

alter table public.website_analytics add column if not exists project_id text;
do $$ begin
  alter table public.website_analytics add constraint website_analytics_project_id_shape
    check (project_id is null or project_id ~ '^proj_[A-Za-z0-9_-]{8,64}$');
exception
  when check_violation then raise notice 'website_analytics_project_id_shape skipped: an existing row has a project_id that does not match the builder id shape -- reconcile, then add by hand.';
  when duplicate_object then raise notice 'website_analytics_project_id_shape already exists, skipping.';
end $$;

create unique index if not exists website_analytics_workspace_project_uidx
  on public.website_analytics(workspace_id, project_id) where project_id is not null;

-- ---------------------------------------------------------------------------
-- RLS / grants: unchanged from V12/supabase-schema.sql. Re-stated (not
-- re-created if already correct) so this file is self-sufficient if either
-- was ever edited by hand -- same convention V53/V54 already use.
-- ---------------------------------------------------------------------------
alter table public.website_analytics enable row level security;
drop policy if exists "website_analytics_select" on public.website_analytics;
drop policy if exists "website_analytics_insert" on public.website_analytics;
drop policy if exists "website_analytics_update" on public.website_analytics;
drop policy if exists "website_analytics_delete" on public.website_analytics;
create policy "website_analytics_select" on public.website_analytics for select using (public.is_workspace_member(workspace_id) or public.is_siteremade_owner());
create policy "website_analytics_insert" on public.website_analytics for insert with check (public.is_workspace_member(workspace_id) or public.is_siteremade_owner());
create policy "website_analytics_update" on public.website_analytics for update using (public.is_workspace_member(workspace_id) or public.is_siteremade_owner());
create policy "website_analytics_delete" on public.website_analytics for delete using (public.is_workspace_member(workspace_id) or public.is_siteremade_owner());
grant select, insert, update, delete on public.website_analytics to service_role;

-- No backfill: every existing row predates project-aware analytics and
-- stays a legacy, workspace-level row (project_id NULL) -- there is no
-- reliable way to infer which ONE of a workspace's (possibly several,
-- post-V54) connected projects it was ever really tracking, and guessing
-- is exactly what this migration exists to stop doing going forward.
