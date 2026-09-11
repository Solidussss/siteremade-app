-- SiteRemade V5 — Supabase schema
-- Run this once in Supabase Dashboard > SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  role text not null default 'client' check (role in ('owner','client')),
  created_at timestamptz not null default now()
);

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  business_name text not null,
  email text not null default '',
  phone text not null default '',
  timezone text not null default 'America/Edmonton',
  currency text not null default 'CAD',
  plan text not null default 'Growth',
  public_key text not null default encode(gen_random_bytes(24),'hex'),
  ai_enabled boolean not null default true,
  ai_services text not null default '',
  ai_service_area text not null default '',
  ai_tone text not null default 'Helpful, concise, professional',
  stripe_account_id text,
  created_at timestamptz not null default now()
);
create unique index if not exists workspaces_public_key_idx on public.workspaces(public_key);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id,user_id)
);

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null, email text not null default '', phone text not null default '', service text not null default 'General inquiry',
  source text not null default 'Website', status text not null default 'New' check (status in ('New','Contacted','Quoted','Won','Lost')),
  value numeric(12,2) not null default 0, message text not null default '', notes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists leads_workspace_created_idx on public.leads(workspace_id,created_at desc);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade, name text not null default '', mode text not null default 'human' check (mode in ('ai','human')),
  unread integer not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(workspace_id,lead_id)
);
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade, sender text not null check (sender in ('customer','ai','business')),
  text text not null, created_at timestamptz not null default now()
);
create index if not exists messages_conversation_created_idx on public.messages(conversation_id,created_at);

create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null, title text not null default 'Appointment', customer text not null default '',
  start_at timestamptz not null, duration integer not null default 60, status text not null default 'Booked', notes text not null default '', created_at timestamptz not null default now()
);
create index if not exists appointments_workspace_start_idx on public.appointments(workspace_id,start_at);

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null, customer text not null default '', description text not null default 'Invoice',
  amount numeric(12,2) not null default 0, status text not null default 'Pending' check (status in ('Draft','Pending','Paid','Void')),
  payment_url text, stripe_session_id text, paid_at timestamptz, created_at timestamptz not null default now()
);
create index if not exists invoices_workspace_created_idx on public.invoices(workspace_id,created_at desc);

create table if not exists public.automations (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
  automation_key text not null, name text not null, description text not null default '', enabled boolean not null default true, created_at timestamptz not null default now(),
  unique(workspace_id,automation_key)
);
create table if not exists public.activities (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
  type text not null default 'activity', title text not null, detail text not null default '', created_at timestamptz not null default now()
);
create index if not exists activities_workspace_created_idx on public.activities(workspace_id,created_at desc);
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id) on delete set null,
  workspace_id uuid references public.workspaces(id) on delete set null, action text not null, detail text not null default '', created_at timestamptz not null default now()
);

create or replace function public.is_workspace_member(wid uuid) returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.workspace_members m where m.workspace_id=wid and m.user_id=auth.uid());
$$;
create or replace function public.is_siteremade_owner() returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='owner');
$$;

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.leads enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.appointments enable row level security;
alter table public.invoices enable row level security;
alter table public.automations enable row level security;
alter table public.activities enable row level security;
alter table public.audit_logs enable row level security;

do $$ declare t text; begin
  foreach t in array array['leads','conversations','messages','appointments','invoices','automations','activities'] loop
    execute format('drop policy if exists %I on public.%I', 'workspace_member_access', t);
    execute format('create policy %I on public.%I for all using (public.is_siteremade_owner() or public.is_workspace_member(workspace_id)) with check (public.is_siteremade_owner() or public.is_workspace_member(workspace_id))', 'workspace_member_access', t);
  end loop;
end $$;


drop policy if exists workspace_member_access on public.workspaces;
create policy workspace_member_access on public.workspaces for select using (public.is_siteremade_owner() or public.is_workspace_member(id));

drop policy if exists profile_self_or_owner on public.profiles;
create policy profile_self_or_owner on public.profiles for select using (id=auth.uid() or public.is_siteremade_owner());
drop policy if exists member_self_or_owner on public.workspace_members;
create policy member_self_or_owner on public.workspace_members for select using (user_id=auth.uid() or public.is_siteremade_owner());
drop policy if exists audit_owner_only on public.audit_logs;
create policy audit_owner_only on public.audit_logs for select using (public.is_siteremade_owner());


-- V6 additions: ad performance + real appointment reminder state
create table if not exists public.ad_spend (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  platform text not null default 'Other',
  campaign text not null default 'Campaign',
  spend numeric(12,2) not null default 0,
  leads integer not null default 0,
  source text not null default 'manual',
  created_at timestamptz not null default now()
);
create index if not exists ad_spend_workspace_created_idx on public.ad_spend(workspace_id,created_at desc);

alter table public.appointments add column if not exists reminder_sent_at timestamptz;

alter table public.ad_spend enable row level security;
drop policy if exists "ad_spend_select" on public.ad_spend;
drop policy if exists "ad_spend_insert" on public.ad_spend;
drop policy if exists "ad_spend_update" on public.ad_spend;
drop policy if exists "ad_spend_delete" on public.ad_spend;
create policy "ad_spend_select" on public.ad_spend for select using (public.is_workspace_member(workspace_id) or public.is_siteremade_owner());
create policy "ad_spend_insert" on public.ad_spend for insert with check (public.is_workspace_member(workspace_id) or public.is_siteremade_owner());
create policy "ad_spend_update" on public.ad_spend for update using (public.is_workspace_member(workspace_id) or public.is_siteremade_owner());
create policy "ad_spend_delete" on public.ad_spend for delete using (public.is_workspace_member(workspace_id) or public.is_siteremade_owner());

grant select, insert, update, delete on public.ad_spend to service_role;


-- V8 additions: SiteRemade recurring billing + client-funded ad balance
alter table public.workspaces add column if not exists siteremade_customer_id text;
alter table public.workspaces add column if not exists siteremade_subscription_id text;
alter table public.workspaces add column if not exists siteremade_subscription_status text not null default 'inactive';

create table if not exists public.ad_funds (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  platform text not null default 'Both',
  status text not null default 'Pending' check (status in ('Pending','Funded','Refunded','Failed')),
  stripe_session_id text,
  created_at timestamptz not null default now(),
  funded_at timestamptz
);
create index if not exists ad_funds_workspace_created_idx on public.ad_funds(workspace_id,created_at desc);
alter table public.ad_funds enable row level security;
drop policy if exists "ad_funds_select" on public.ad_funds;
drop policy if exists "ad_funds_insert" on public.ad_funds;
drop policy if exists "ad_funds_update" on public.ad_funds;
drop policy if exists "ad_funds_delete" on public.ad_funds;
create policy "ad_funds_select" on public.ad_funds for select using (public.is_workspace_member(workspace_id) or public.is_siteremade_owner());
create policy "ad_funds_insert" on public.ad_funds for insert with check (public.is_workspace_member(workspace_id) or public.is_siteremade_owner());
create policy "ad_funds_update" on public.ad_funds for update using (public.is_workspace_member(workspace_id) or public.is_siteremade_owner());
create policy "ad_funds_delete" on public.ad_funds for delete using (public.is_workspace_member(workspace_id) or public.is_siteremade_owner());
grant select, insert, update, delete on public.ad_funds to service_role;


-- V12 additions: persistent prospect viewed state + website analytics framework
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


-- V13 additions: website update requests
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
