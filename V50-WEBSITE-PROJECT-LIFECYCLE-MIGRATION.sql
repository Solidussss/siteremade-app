-- SiteRemade V50 — Phase 2: unify the website-project lifecycle
-- Run once in Supabase Dashboard > SQL Editor. Safe to re-run (idempotent).
--
-- What this does:
--   1. Expands website_projects (already live, from the V48 catch-up
--      migration) with the columns the full lifecycle needs: structured
--      intake, brief history, client review state, preview/live URLs and
--      a delivered timestamp. All additive — no existing column is
--      changed or dropped, no existing row's data is touched beyond
--      getting sensible defaults for the new columns.
--   2. Links website_updates to website_projects via a nullable
--      project_id, and adds a `kind` column so the same table can now
--      represent three things: a general update request (existing
--      behaviour, unchanged), an owner-authored build revision, or a
--      client's review feedback. Every existing row keeps
--      project_id = null and kind = 'update' — nothing is inferred or
--      guessed about which project (if any) an old request belonged to.
--      This is the "compatibility layer instead of a schema break":
--      the old standalone Website Updates flow keeps working exactly as
--      it did (project_id stays null for it) while new project-scoped
--      revisions/feedback use the same table with project_id set.
--   3. Links invoices to website_projects via a nullable project_id,
--      preserving all existing lead_id-based behaviour untouched.
--
-- Nothing here infers a project_id for existing website_updates or
-- invoices rows. That mapping does not exist in the data and guessing it
-- would be worse than leaving it null.

-- ---------------------------------------------------------------------
-- 1. website_projects: structured intake, brief history, review/delivery
-- ---------------------------------------------------------------------

alter table public.website_projects add column if not exists intake jsonb not null default '{}'::jsonb;
-- Shape (documented here, enforced in application code, not by the DB):
-- {
--   businessIdentity: string, services: string, serviceArea: string,
--   currentWebsiteUrl: string, goals: string,
--   desiredPages: string[], visualDirection: {
--     style: string, colors: string[], typography: string, notes: string
--   },
--   logoAssets: string[], references: string[], notes: string
-- }
-- This is the human-entered structured intake — the source of truth for
-- what the client/owner actually specified. It replaces "paste an email
-- and let AI guess everything." `intake_text` (already a column) is kept
-- for backward compatibility: projects created before this migration keep
-- their original free-text paste there, and the UI shows it as read-only
-- context on those older rows instead of silently discarding it.

alter table public.website_projects add column if not exists brief_history jsonb not null default '[]'::jsonb;
-- Every time `brief` is (re)generated, the previous value of `brief` is
-- pushed onto this array first, so a regeneration never destroys the
-- prior version. Newest-previous-first.

alter table public.website_projects add column if not exists preview_url text not null default '';
alter table public.website_projects add column if not exists live_url text not null default '';
alter table public.website_projects add column if not exists delivered_at timestamptz;
-- delivered_at is only ever set by an explicit owner action (PATCH status
-- to 'Delivered'). It is never inferred from invoice payment status.

alter table public.website_projects add column if not exists client_review_status text not null default 'not_submitted';
alter table public.website_projects add column if not exists client_reviewed_at timestamptz;
alter table public.website_projects add column if not exists client_review_feedback text not null default '';

do $$ begin
  alter table public.website_projects add constraint website_projects_client_review_status_check
    check (client_review_status in ('not_submitted','pending','changes_requested','approved'));
exception
  when check_violation then raise notice 'website_projects_client_review_status_check skipped: existing rows have a client_review_status value outside the expected set — reconcile the data, then add this constraint by hand.';
  when duplicate_object then raise notice 'website_projects_client_review_status_check already exists, skipping.';
end $$;

-- ---------------------------------------------------------------------
-- 2. website_updates: link to a project, distinguish the kind of entry
-- ---------------------------------------------------------------------

alter table public.website_updates add column if not exists project_id uuid references public.website_projects(id) on delete set null;
alter table public.website_updates add column if not exists kind text not null default 'update';

do $$ begin
  alter table public.website_updates add constraint website_updates_kind_check
    check (kind in ('update','revision','client_feedback'));
exception
  when check_violation then raise notice 'website_updates_kind_check skipped: existing rows have a kind value outside (update, revision, client_feedback) — reconcile the data, then add this constraint by hand.';
  when duplicate_object then raise notice 'website_updates_kind_check already exists, skipping.';
end $$;

create index if not exists website_updates_project_created_idx on public.website_updates(project_id, created_at desc);

-- ---------------------------------------------------------------------
-- 3. invoices: nullable link to a project, lead_id behaviour untouched
-- ---------------------------------------------------------------------

alter table public.invoices add column if not exists project_id uuid references public.website_projects(id) on delete set null;
create index if not exists invoices_project_idx on public.invoices(project_id) where project_id is not null;

-- ---------------------------------------------------------------------
-- RLS: no new policies needed. website_projects, website_updates and
-- invoices are all already workspace_id-scoped under the existing
-- workspace_member_access policies (website_projects from V48,
-- website_updates and invoices from the base schema). The new columns
-- ride on those same row-level policies since they don't change which
-- workspace a row belongs to.
-- ---------------------------------------------------------------------
