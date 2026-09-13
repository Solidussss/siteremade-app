-- SiteRemade V29 migration — connected Gmail / Outlook inbox
-- Run once in Supabase SQL Editor.

create table if not exists public.mailbox_connections (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  provider text not null check (provider in ('gmail','outlook')),
  email text not null default '',
  access_token text not null default '',
  refresh_token text not null default '',
  expires_at timestamptz,
  scope text not null default '',
  last_sync timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.mailbox_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null,
  external_id text not null,
  conversation_id uuid references public.conversations(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null,
  direction text not null default 'inbound' check (direction in ('inbound','outbound')),
  created_at timestamptz not null default now(),
  unique(workspace_id, provider, external_id)
);

create index if not exists mailbox_events_workspace_created_idx on public.mailbox_events(workspace_id, created_at desc);

alter table public.mailbox_connections enable row level security;
alter table public.mailbox_events enable row level security;

drop policy if exists "mailbox_connections_select" on public.mailbox_connections;
drop policy if exists "mailbox_connections_insert" on public.mailbox_connections;
drop policy if exists "mailbox_connections_update" on public.mailbox_connections;
drop policy if exists "mailbox_connections_delete" on public.mailbox_connections;
create policy "mailbox_connections_select" on public.mailbox_connections for select using (public.is_workspace_member(workspace_id) or public.is_siteremade_owner());
create policy "mailbox_connections_insert" on public.mailbox_connections for insert with check (public.is_workspace_member(workspace_id) or public.is_siteremade_owner());
create policy "mailbox_connections_update" on public.mailbox_connections for update using (public.is_workspace_member(workspace_id) or public.is_siteremade_owner());
create policy "mailbox_connections_delete" on public.mailbox_connections for delete using (public.is_workspace_member(workspace_id) or public.is_siteremade_owner());

drop policy if exists "mailbox_events_select" on public.mailbox_events;
drop policy if exists "mailbox_events_insert" on public.mailbox_events;
create policy "mailbox_events_select" on public.mailbox_events for select using (public.is_workspace_member(workspace_id) or public.is_siteremade_owner());
create policy "mailbox_events_insert" on public.mailbox_events for insert with check (public.is_workspace_member(workspace_id) or public.is_siteremade_owner());

grant select, insert, update, delete on public.mailbox_connections to service_role;
grant select, insert, update, delete on public.mailbox_events to service_role;
