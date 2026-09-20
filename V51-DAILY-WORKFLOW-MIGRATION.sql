-- SiteRemade V51 — Phase 3: move daily-workflow state out of localStorage
-- Run once in Supabase Dashboard > SQL Editor. Safe to re-run (idempotent).
--
-- Context: v42-daily-workflow.js (a frontend patch file) kept two pieces
-- of real business state ONLY in the browser's localStorage, under the key
-- `sr-workflow:${workspaceId}`:
--   - followups: { [leadId]: { date, action, done } } — the "next action"
--     reminder an owner sets on a lead (shown in the Needs Attention list
--     and on the lead's own record).
--   - prospects: { [placeKey]: { stage, updatedAt } } — the outreach stage
--     (Unreviewed / Worth calling / Contacted / Follow up / Not relevant)
--     an owner assigns to a Market Finder prospect.
-- Because this lived only in localStorage, it never synced across devices
-- or browsers, and clearing site data silently lost it — a real business-
-- continuity gap for anything an owner actually relies on day to day. This
-- migration gives both a proper home in Supabase.
--
-- Every column is additive and every table uses `create table if not
-- exists`, so this is safe against a partially-applied prior run. No
-- existing table is touched.

-- ---------------------------------------------------------------------------
-- lead_followups — one row per (workspace, lead): the current "next
-- action" reminder, if any. Replaces sr-workflow's `followups` map.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_followups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  date date not null,
  action text not null default '',
  done boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, lead_id)
);
alter table public.lead_followups add column if not exists date date not null default current_date;
alter table public.lead_followups add column if not exists action text not null default '';
alter table public.lead_followups add column if not exists done boolean not null default false;
alter table public.lead_followups add column if not exists created_at timestamptz not null default now();
alter table public.lead_followups add column if not exists updated_at timestamptz not null default now();
create index if not exists lead_followups_workspace_due_idx on public.lead_followups(workspace_id, done, date);

-- ---------------------------------------------------------------------------
-- prospect_stages — one row per (workspace, place key): the outreach stage
-- an owner has assigned to a Market Finder prospect. Replaces
-- sr-workflow's `prospects` map. `place_key` mirrors the frontend's own
-- prospectKey() (lowercased placeId, or id, or name as a fallback) rather
-- than a foreign key, since prospects are not stored in their own table —
-- they're a live Google Places search result, identified only by that key.
-- ---------------------------------------------------------------------------
create table if not exists public.prospect_stages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  place_key text not null,
  stage text not null default 'Unreviewed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, place_key)
);
alter table public.prospect_stages add column if not exists stage text not null default 'Unreviewed';
alter table public.prospect_stages add column if not exists created_at timestamptz not null default now();
alter table public.prospect_stages add column if not exists updated_at timestamptz not null default now();
create index if not exists prospect_stages_workspace_idx on public.prospect_stages(workspace_id);

do $$ begin
  alter table public.prospect_stages add constraint prospect_stages_stage_check
    check (stage in ('Unreviewed','Worth calling','Contacted','Follow up','Not relevant'));
exception
  when check_violation then raise notice 'prospect_stages_stage_check skipped: existing rows have a stage value outside the expected set — reconcile the data, then add this constraint by hand.';
  when duplicate_object then raise notice 'prospect_stages_stage_check already exists, skipping.';
end $$;

-- ---------------------------------------------------------------------------
-- RLS — same workspace-member-or-siteremade-owner pattern used everywhere
-- else in this schema (see V48).
-- ---------------------------------------------------------------------------
alter table public.lead_followups enable row level security;
alter table public.prospect_stages enable row level security;

do $$ declare t text; begin
  foreach t in array array['lead_followups','prospect_stages'] loop
    execute format('drop policy if exists %I on public.%I', 'workspace_member_access', t);
    execute format('create policy %I on public.%I for all using (public.is_siteremade_owner() or public.is_workspace_member(workspace_id)) with check (public.is_siteremade_owner() or public.is_workspace_member(workspace_id))', 'workspace_member_access', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- No backfill: this state never existed anywhere but each browser's
-- localStorage, which the server cannot read. Existing follow-ups and
-- prospect stages set before this migration are NOT carried over
-- automatically — there is nothing server-side to backfill them from, and
-- guessing would be worse than leaving these tables empty until re-set.
-- If preserving pre-migration data matters, export each affected browser's
-- localStorage.getItem('sr-workflow:<workspaceId>') before rollout and
-- import it by hand.
-- ---------------------------------------------------------------------------
