-- ============================================================================
-- Verifies harden-app-role.sql actually enforces what it claims.
--
--   psql -d <db> -v ON_ERROR_STOP=1 -v app_role=tripwith_app \
--        -f verify-app-role-hardening.sql
--
-- Run as a superuser/owner AFTER harden-app-role.sql. Uses PostgreSQL's own
-- privilege introspection rather than attempting writes, so it is read-only
-- and safe against a production database.
--
-- The naive column-level REVOKE approach passes a casual eyeball check while
-- enforcing nothing, so these assertions check the actual ACL.
-- ============================================================================

\set ON_ERROR_STOP on
SELECT set_config('tripwith.app_role', :'app_role', false);

-- No ON COMMIT DROP: psql runs in autocommit, so the CREATE would commit and
-- immediately drop the table before the DO block below could use it. A temp
-- table is discarded when the session ends anyway.
DROP TABLE IF EXISTS harden_results;
CREATE TEMP TABLE harden_results (label TEXT, passed BOOLEAN, detail TEXT);

DO $verify$
DECLARE
  app_role TEXT := current_setting('tripwith.app_role');
  protected CONSTANT TEXT[][] := ARRAY[
    ['users','trust_score_raw'], ['events','participant_count'],
    ['providers','rating_avg'],  ['providers','rating_count'],
    ['chat_rooms','last_seq'],   ['user_profiles','interest_ids']
  ];
  i INT;
  tbl TEXT; col TEXT;
  can_write BOOLEAN;
  fn TEXT;
  definers CONSTANT TEXT[] := ARRAY[
    'tw_apply_trust_delta', 'tw_sync_participant_count', 'tw_sync_provider_rating',
    'tw_sync_interest_ids', 'tw_assign_message_seq'
  ];
BEGIN
  -- 1. No table-level UPDATE anywhere: this is the grant that would silently
  --    re-authorise every protected column.
  INSERT INTO harden_results
  SELECT 'no table-level UPDATE grant remains',
         NOT EXISTS (
           SELECT 1 FROM information_schema.table_privileges
            WHERE grantee = app_role AND privilege_type = 'UPDATE'
              AND table_schema = 'public'),
         COALESCE((SELECT string_agg(table_name, ', ')
                     FROM information_schema.table_privileges
                    WHERE grantee = app_role AND privilege_type = 'UPDATE'
                      AND table_schema = 'public'), 'none');

  -- 2. Each protected column is unwritable.
  FOR i IN 1 .. array_length(protected, 1) LOOP
    tbl := protected[i][1];
    col := protected[i][2];
    can_write := has_column_privilege(app_role, format('public.%I', tbl), col, 'UPDATE');
    INSERT INTO harden_results
    VALUES (format('protected: %s.%s is NOT updatable by app role', tbl, col),
            NOT can_write,
            CASE WHEN can_write THEN 'STILL WRITABLE' ELSE 'denied' END);
  END LOOP;

  -- 3. Ordinary columns remain writable, or the application is simply broken.
  INSERT INTO harden_results
  VALUES ('ordinary column users.last_active_at remains updatable',
          has_column_privilege(app_role, 'public.users', 'last_active_at', 'UPDATE'), '');
  INSERT INTO harden_results
  VALUES ('ordinary column events.title remains updatable',
          has_column_privilege(app_role, 'public.events', 'title', 'UPDATE'), '');

  -- 4. Projection triggers must be SECURITY DEFINER, otherwise step 2 turns
  --    every legitimate ledger insert into a permission error.
  FOREACH fn IN ARRAY definers LOOP
    INSERT INTO harden_results
    SELECT format('trigger fn %s is SECURITY DEFINER with pinned search_path', fn),
           p.prosecdef AND EXISTS (
             SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) c
              WHERE c LIKE 'search_path=%'),
           format('secdef=%s config=%s', p.prosecdef, COALESCE(p.proconfig::TEXT, 'none'))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = fn;
  END LOOP;
END $verify$;

\echo ''
\echo '============ APP ROLE HARDENING ============'
SELECT CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END AS result, label, detail
FROM harden_results ORDER BY passed, label;

SELECT format('%s passed, %s failed, %s total',
              count(*) FILTER (WHERE passed),
              count(*) FILTER (WHERE NOT passed), count(*)) AS summary
FROM harden_results;

DO $final$
DECLARE failures INT;
BEGIN
  SELECT count(*) INTO failures FROM harden_results WHERE NOT passed;
  IF failures > 0 THEN
    RAISE EXCEPTION 'APP ROLE HARDENING FAILED: % assertion(s) did not hold', failures;
  END IF;
END $final$;
