-- SiteRemade V53 — Phase 6: multi-purchase review data for website links
-- Run once in Supabase Dashboard > SQL Editor, AFTER V52. Safe to re-run
-- (idempotent). Additive only: no existing column changes, no data is
-- rewritten, nothing is dropped.
--
-- 1. Two nullable columns on public.website_project_links:
--
--    mismatch_candidates     jsonb        -- array, see shape below
--    mismatch_candidates_at  timestamptz  -- when that list was captured
--
--    When the builder starts reporting a DIFFERENT purchased project for a
--    customer than the one their workspace is linked to (V52's
--    mismatch_project_id / mismatch_seen_at), the app — on that customer's
--    own visit, with that customer's own access token — also asks the
--    builder for EVERY project that customer has purchased
--    (GET /api/app-bridge/website/candidates, ownership resolved by the
--    builder from the token alone) and stores the answer here. SiteRemade
--    staff later resolve the review in Admin by choosing one of exactly
--    these ids (POST /api/app/admin/website-links/:workspaceId/relink); an id
--    that is not in this stored, builder-verified list is refused.
--
--    Shape (enforced in application code, lib/website-links.js
--    sanitizeCandidates; the CHECK below only guarantees "an array of at
--    most 50 items"): metadata only — never content, never design state:
--      [{ "projectId": "proj_…", "purchaseRef": "cs_…" | null,
--         "purchasedAt": "<ISO timestamp>" | null, "revision": 7 | null }]
--
--    Both columns are cleared whenever the mismatch clears (the builder
--    reports the linked project again) or staff resolve it.
--
-- 2. Defense in depth for V52's "only the service role writes this table":
--    V52 relies on RLS having no insert/update/delete policy. This also
--    revokes the table-level write privileges Supabase's default privileges
--    hand to anon/authenticated on every new public table, so a future
--    permissive policy (or RLS being switched off by mistake) still can't
--    open writes to browser-held keys. SELECT is untouched — members and
--    staff keep reading through V52's policy exactly as before.

alter table public.website_project_links add column if not exists mismatch_candidates jsonb;
alter table public.website_project_links add column if not exists mismatch_candidates_at timestamptz;

-- CASE, not AND: Postgres does not guarantee left-to-right evaluation inside
-- a CHECK, and jsonb_array_length() raises on a non-array.
do $$ begin
  alter table public.website_project_links add constraint website_project_links_mismatch_candidates_shape
    check (mismatch_candidates is null or case when jsonb_typeof(mismatch_candidates) = 'array' then jsonb_array_length(mismatch_candidates) <= 50 else false end);
exception
  when check_violation then raise notice 'website_project_links_mismatch_candidates_shape skipped: existing rows hold a non-array or oversized mismatch_candidates value — reconcile, then add by hand.';
  when duplicate_object then raise notice 'website_project_links_mismatch_candidates_shape already exists, skipping.';
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke insert, update, delete, truncate on public.website_project_links from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke insert, update, delete, truncate on public.website_project_links from authenticated';
  end if;
end $$;

-- The service role keeps full access (V52 already granted it; repeated here
-- so this file is self-sufficient if V52's grant was ever edited by hand).
grant select, insert, update, delete on public.website_project_links to service_role;

-- No backfill: a mismatch recorded before this migration simply has no
-- candidate list yet. Admin says so, and the list is captured the next time
-- that customer opens their Website view.
