-- SiteRemade V12 migration — run once in Supabase SQL Editor

create table if not exists public.prospect_views (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  place_id text not null,
  name text not null default '',
  website text not null default '',
  viewed_at timestamptz not null default now(),
  primary key (workspace_id, place_id)
);
create index if not exists prospect_views_workspace_viewed_idx on public.prospect_views(workspace_id, viewed_at desc);
alter table public.prospect_views enable row level security;
drop policy if exists "prospect_views_select" on public.prospect_views;
drop policy if exists "prospect_views_insert" on public.prospect_views;
drop policy if exists "prospect_views_update" on public.prospect_views;
drop policy if exists "prospect_views_delete" on public.prospect_views;
create policy "prospect_views_select" on public.prospect_views for select using (public.is_workspace_member(workspace_id) or public.is_siteremade_owner());
create policy "prospect_views_insert" on public.prospect_views for insert with check (public.is_workspace_member(workspace_id) or public.is_siteremade_owner());
create policy "prospect_views_update" on public.prospect_views for update using (public.is_workspace_member(workspace_id) or public.is_siteremade_owner());
create policy "prospect_views_delete" on public.prospect_views for delete using (public.is_workspace_member(workspace_id) or public.is_siteremade_owner());
grant select, insert, update, delete on public.prospect_views to service_role;

create table if not exists public.website_analytics (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  domain text not null default '',
  provider text not null default 'google_analytics',
  connected boolean not null default false,
  sessions bigint not null default 0,
  users bigint not null default 0,
  pageviews bigint not null default 0,
  last_sync timestamptz,
  updated_at timestamptz not null default now()
);
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
