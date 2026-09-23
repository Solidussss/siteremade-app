-- SiteRemade V54 — Phase 9: allow a workspace to own MORE THAN ONE
-- website_project_links row. Run once in Supabase Dashboard > SQL Editor,
-- AFTER V52 and V53. Safe to re-run (idempotent). Additive/structural only:
-- no row is deleted, no existing column is dropped, no generator_project_id
-- or workspace_id value on any existing row is changed.
--
-- Why: V52 made `workspace_id` the table's PRIMARY KEY, so a workspace could
-- only ever have exactly one linked builder project -- the exact limitation
-- Phase 6's mismatch/candidate-review workaround (V53) existed to paper
-- over ("the customer bought a second website, but their workspace can't
-- get a second link, so record it for staff to manually resolve"). Phase 9
-- makes a second (third, fourth, ...) purchased SiteRemade project a normal,
-- customer-driven "Connect a website" action (see lib/website-links.js
-- connectWorkspaceToProject, unchanged endpoint, its own workspace-already-
-- linked refusal lifted in this same phase) instead of an admin ticket.
--
-- What changes structurally:
--   - a new surrogate `id uuid primary key default gen_random_uuid()`
--     column replaces workspace_id as the primary key. Every existing row
--     gets a generated id for free (DEFAULT applies to the backfill), and
--     every existing (workspace_id, generator_project_id, purchase_ref, ...)
--     value is untouched.
--   - workspace_id keeps its NOT NULL + FK to workspaces(id) on delete
--     cascade, and gains a plain (non-unique) index for the "all of this
--     workspace's linked projects" lookup (lib/website-links.js
--     listLinksForWorkspace) -- it just stops being required to be unique.
--   - generator_project_id's UNIQUE index (website_project_links_project_uidx,
--     added in V52) is INTENTIONALLY left exactly as it is: a given builder
--     project still belongs to at most one workspace. That invariant is
--     what keeps POST /api/public/site-submission's project -> workspace
--     routing (lib/website-links.js findWorkspaceForProject) unambiguous
--     and unchanged by this migration.
--
-- What does NOT change: RLS (still select-only for members/staff, still
-- only the service role writes), grants, the mismatch/candidate columns and
-- their CHECK constraints (V53), the project-id shape CHECK (V52). Legacy
-- rows already sitting in a "needs review" mismatch state (V52/V53) are
-- untouched and remain reviewable exactly as before through the existing
-- Admin relink flow -- this migration does not resolve, clear, or interpret
-- them.

-- 1. Surrogate primary key -----------------------------------------------
alter table public.website_project_links add column if not exists id uuid default gen_random_uuid();
-- Backfill defensively for any row that predates the DEFAULT being visible
-- to it (belt-and-suspenders; the ADD COLUMN ... DEFAULT above already
-- populates every existing row in one pass on modern Postgres).
update public.website_project_links set id = gen_random_uuid() where id is null;
alter table public.website_project_links alter column id set not null;

do $$
declare
  old_pk text;
begin
  select tc.constraint_name into old_pk
    from information_schema.table_constraints tc
    where tc.table_schema = 'public' and tc.table_name = 'website_project_links' and tc.constraint_type = 'PRIMARY KEY';
  if old_pk is not null and old_pk <> 'website_project_links_pkey' then
    execute format('alter table public.website_project_links drop constraint %I', old_pk);
  elsif old_pk = 'website_project_links_pkey' then
    -- Ambiguous by name alone (could already be the new id-based PK from a
    -- prior run of this migration, or still be the original workspace_id
    -- one) -- check which column it actually covers before dropping.
    if not exists (
      select 1 from information_schema.key_column_usage k
      where k.constraint_schema = 'public' and k.constraint_name = old_pk and k.column_name = 'id'
    ) then
      execute format('alter table public.website_project_links drop constraint %I', old_pk);
    end if;
  end if;
end $$;

do $$ begin
  alter table public.website_project_links add constraint website_project_links_pkey primary key (id);
exception
  when invalid_table_definition then raise notice 'website_project_links_pkey already present on the right column, skipping.';
  when duplicate_object then raise notice 'website_project_links_pkey already exists, skipping.';
end $$;

-- workspace_id keeps its NOT NULL even after losing PK status (Postgres
-- ties NOT NULL to the column, not the constraint that first implied it),
-- but this is a harmless no-op if it's ever somehow missing, and makes the
-- intent explicit rather than relying on that behavior silently.
alter table public.website_project_links alter column workspace_id set not null;

-- workspace_id keeps its FK to workspaces(id) from V52's column
-- definition (`references public.workspaces(id) on delete cascade`) --
-- that FK is a column-level constraint from CREATE TABLE, untouched by
-- dropping/re-adding the PRIMARY KEY above, so it is not re-declared here.

-- 2. Lookup index for "every project linked to this workspace" -----------
create index if not exists website_project_links_workspace_idx on public.website_project_links(workspace_id);

-- generator_project_id's UNIQUE index from V52 (website_project_links_project_uidx)
-- is deliberately left exactly as it was -- see header.

-- ---------------------------------------------------------------------------
-- RLS / grants: unchanged from V52/V53. Re-stated (not re-created if
-- already correct) only so this file is self-sufficient if either was ever
-- edited by hand -- same convention V53 already uses for its own grant.
-- ---------------------------------------------------------------------------
alter table public.website_project_links enable row level security;
drop policy if exists "website_project_links_select" on public.website_project_links;
create policy "website_project_links_select" on public.website_project_links for select using (public.is_workspace_member(workspace_id) or public.is_siteremade_owner());
grant select, insert, update, delete on public.website_project_links to service_role;

-- No backfill of relationships: every existing (workspace_id,
-- generator_project_id) pair a customer already had linked stays linked,
-- unchanged, and simply becomes one row among however many that workspace
-- accumulates going forward. Nothing here infers or creates a NEW link for
-- any project.
