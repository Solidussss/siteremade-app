-- V48 preflight check — READ-ONLY, mutates nothing.
--
-- This sandbox has no production Supabase credentials (no connector, no
-- SUPABASE_* env vars), so none of this has been run against the real
-- database. Run this in the Supabase SQL Editor against production BEFORE
-- ever running V48-SCHEMA-CATCHUP-MIGRATION.sql there, and read every
-- result before proceeding. Every query here is a SELECT; none of them can
-- change data.

-- 1) Do these five tables already exist, and if so, what shape are they in
--    right now? (V48's own header comment says some were "created directly
--    in the Supabase dashboard" — this is the ground truth for whether
--    any of the risk below is even reachable. If a table doesn't exist yet,
--    V48's `create table` path handles it with no risk at all.)
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in ('integration_connections','google_ads_credentials',
                      'ad_control_settings','ad_recommendations','website_projects')
order by table_name, ordinal_position;

-- 2) integration_connections: rows that would collide with the unique
--    index V48 wants to add on (workspace_id, provider). Any row returned
--    here means that unique index cannot be created until the duplicates
--    are resolved (V48 now catches this and skips with a NOTICE instead of
--    aborting the whole script, but the index still won't exist until
--    this is fixed by hand).
select workspace_id, provider, count(*)
from public.integration_connections
group by workspace_id, provider
having count(*) > 1;

-- 3) integration_connections: rows with a NULL workspace_id. These are
--    invisible to workspace-scoped RLS/app queries and excluded from the
--    unique index (NULLs are distinct in Postgres). If this table already
--    existed without a workspace_id column, V48's `alter table ... add
--    column if not exists workspace_id` (no default) leaves every existing
--    row NULL here — there's no way to safely infer the right workspace
--    from this sandbox, so any row found needs a human decision.
select count(*) as null_workspace_id_rows
from public.integration_connections
where workspace_id is null;

-- 4) ad_recommendations: same duplicate check, for its unique index on
--    (workspace_id, provider, customer_id, recommendation_key).
select workspace_id, provider, customer_id, recommendation_key, count(*)
from public.ad_recommendations
group by workspace_id, provider, customer_id, recommendation_key
having count(*) > 1;

-- 5) ad_recommendations: same NULL workspace_id check.
select count(*) as null_workspace_id_rows
from public.ad_recommendations
where workspace_id is null;

-- 6) Existing values outside the CHECK constraints V48 tries to add. V48
--    already handles this gracefully (skips the constraint with a NOTICE
--    on violation rather than aborting), but knowing ahead of time means
--    it's a decision, not a surprise buried in Supabase's SQL Editor log.
select status, count(*) from public.website_projects group by status
  having status not in ('Intake','Brief Ready','Building','Review','Delivered') or status is null;
select mode, count(*) from public.ad_control_settings group by mode
  having mode not in ('observe','recommend','autopilot') or mode is null;
select status, count(*) from public.ad_recommendations group by status
  having status not in ('pending','approved','dismissed','expired') or status is null;

-- Interpreting the results:
--   - Query 1 empty for all five tables  -> none exist yet, V48 is fully
--     safe to run (equivalent to a fresh database).
--   - Queries 2-6 all return zero rows   -> V48 is safe to run as-is.
--   - Any row returned by 2-5            -> stop; that is a real
--     product/data decision (see PHASE3-ROUTE-MAP.md's V48 section), not
--     something to resolve by guessing.
--   - Rows returned by 6 only            -> V48 will still run to
--     completion; it just skips that one CHECK constraint with a NOTICE.
--     Safe to run, but note the constraint won't be enforced until the
--     data is reconciled.
