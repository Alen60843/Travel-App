-- ============================================================================
-- OPT-IN HARDENING: stop the application role writing trigger-owned columns
--
--   psql -d tripwith -v ON_ERROR_STOP=1 -v app_role=tripwith_app \
--        -f harden-app-role.sql
--
-- Phase 1 makes several columns database-owned projections: the database
-- computes them from a ledger or a child table, and application code must
-- never assign them. Phase 2 enforces that in the application model (the
-- TypeORM entities mark them `readonly` and `{ insert: false, update: false }`).
--
-- That is a guardrail, not a boundary: any raw query, migration, console
-- session or future bug can still write them. This script converts the
-- guardrail into an actual privilege boundary.
--
-- It is OPT-IN rather than part of the initial migration because it requires a
-- deployment topology that has a distinct, non-owner application role. A
-- single-role development setup does not need it and would be broken by it.
--
-- PROTECTED COLUMNS
--   users.trust_score_raw          written only by tw_apply_trust_delta
--   users.trust_score              generated; never writable by anyone
--   events.participant_count       written only by tw_sync_participant_count
--   providers.rating_avg/_count    written only by tw_sync_provider_rating
--   chat_rooms.last_seq            written only by tw_assign_message_seq
--   user_profiles.interest_ids     written only by tw_sync_interest_ids
--   trip_segments.date_range       generated
--   events.time_range              generated
--
-- ---------------------------------------------------------------------------
-- TWO NON-OBVIOUS FACTS, BOTH VERIFIED EMPIRICALLY ON PostgreSQL 17.11
-- ---------------------------------------------------------------------------
--
-- 1. A column-level REVOKE CANNOT subtract from a table-level GRANT.
--
--       GRANT UPDATE ON users TO app;            -- covers every column
--       REVOKE UPDATE (trust_score_raw) ON users FROM app;
--       -- app can STILL update trust_score_raw. The revoke is a no-op.
--
--    Table-level and column-level privileges are tracked separately, so the
--    broader grant continues to authorise the write. The only correct form is
--    to never grant table-level UPDATE, and instead grant UPDATE on exactly
--    the allowed columns — which is what this script does.
--
--    This matters because the naive version LOOKS like it works: it runs
--    without error and reports success while enforcing nothing.
--
-- 2. Locking the columns down breaks the triggers, unless they are
--    SECURITY DEFINER.
--
--    A trigger function runs as the INVOKING role by default. Once the app
--    role loses UPDATE on users.trust_score_raw, its own INSERT into
--    trust_score_events fails inside tw_apply_trust_delta with
--    "permission denied for table users". SECURITY DEFINER makes those five
--    functions run as their owner, which retains the privilege.
--
--    search_path is pinned on each, because a SECURITY DEFINER function with a
--    caller-controlled search_path is a privilege-escalation vector: the
--    caller could shadow a referenced object with their own.
-- ============================================================================

\set ON_ERROR_STOP on

-- psql variables are not visible inside a DO block's body, so the role name is
-- passed through a session GUC that step 3 reads back.
SELECT set_config('tripwith.app_role', :'app_role', false);

-- ---------------------------------------------------------------------------
-- 1. Trigger functions that maintain protected columns run as their owner.
-- ---------------------------------------------------------------------------
ALTER FUNCTION tw_apply_trust_delta()      SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION tw_sync_participant_count() SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION tw_sync_provider_rating()   SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION tw_sync_interest_ids()      SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION tw_sync_interest_activity() SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION tw_assign_message_seq()     SECURITY DEFINER SET search_path = pg_catalog, public;

-- ---------------------------------------------------------------------------
-- 2. Baseline privileges. Note the absence of a table-level UPDATE grant.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO :"app_role";
GRANT SELECT, INSERT, DELETE ON ALL TABLES IN SCHEMA public TO :"app_role";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"app_role";

-- Withdraw any table-level UPDATE that a previous run or a broad grant left
-- behind; otherwise step 3 is decorative (see fact 1 above).
REVOKE UPDATE ON ALL TABLES IN SCHEMA public FROM :"app_role";

-- ---------------------------------------------------------------------------
-- 3. Column-level UPDATE on everything EXCEPT the protected projections.
-- ---------------------------------------------------------------------------
DO $harden$
DECLARE
  protected CONSTANT TEXT[] := ARRAY[
    'users.trust_score_raw',
    'users.trust_score',
    'events.participant_count',
    'events.time_range',
    'providers.rating_avg',
    'providers.rating_count',
    'chat_rooms.last_seq',
    'user_profiles.interest_ids',
    'trip_segments.date_range',
    'messages.seq'
  ];
  app_role TEXT := current_setting('tripwith.app_role');
  t        RECORD;
  cols     TEXT;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE'
       AND table_name <> 'spatial_ref_sys'
  LOOP
    -- Generated columns are excluded: PostgreSQL rejects a GRANT on them.
    SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position)
      INTO cols
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.table_name = t.table_name
       AND c.is_generated = 'NEVER'
       AND (t.table_name || '.' || c.column_name) <> ALL (protected);

    IF cols IS NOT NULL THEN
      EXECUTE format('GRANT UPDATE (%s) ON public.%I TO %I', cols, t.table_name, app_role);
    END IF;
  END LOOP;
END $harden$;

-- ---------------------------------------------------------------------------
-- 4. Future tables inherit the same posture.
--    NOTE: default privileges cannot express column-level grants, so a table
--    created later gets SELECT/INSERT/DELETE only and must be re-run through
--    this script to receive its column-level UPDATE grants. That is deliberate
--    friction: a new table should be reviewed for protected columns.
-- ---------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, DELETE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"app_role";
