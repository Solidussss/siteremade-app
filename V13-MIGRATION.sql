-- SiteRemade V13 migration — run once in Supabase SQL Editor
-- Adds the Website Updates request system. Safe to run after V12.

create table if not exists public.website_updates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  page text not null default 'Other',
  priority text not null default 'Normal' check (priority in ('Normal','Important')),
  request text not null,
  notes text not null default '',
  status text not null default 'Requested' check (status in ('Requested','In Progress','Completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists website_updates_workspace_created_idx on public.website_updates(workspace_id, created_at desc);
alter table public.website_updates enable row level security;
drop policy if exists "website_updates_select" on public.website_updates;
drop policy if exists "website_updates_insert" on public.website_updates;
drop policy if exists "website_updates_update" on public.website_updates;
drop policy if exists "website_updates_delete" on public.website_updates;
create policy "website_updates_select" on public.website_updates for select using (public.is_workspace_member(workspace_id) or public.is_siteremade_owner());
create policy "website_updates_insert" on public.website_updates for insert with check (public.is_workspace_member(workspace_id) or public.is_siteremade_owner());
create policy "website_updates_update" on public.website_updates for update using (public.is_workspace_member(workspace_id) or public.is_siteremade_owner());
create policy "website_updates_delete" on public.website_updates for delete using (public.is_workspace_member(workspace_id) or public.is_siteremade_owner());
grant select, insert, update, delete on public.website_updates to service_role;
