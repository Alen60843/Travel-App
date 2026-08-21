\set ON_ERROR_STOP on

-- Phase 4 operational reconciliation for the trigger-maintained matching
-- projection. The normalized user_interests relation remains authoritative;
-- only currently active editorial interests belong in interest_ids.
-- Safe to re-run: already-correct profiles are untouched.
BEGIN;

WITH expected AS (
  SELECT p.user_id,
         COALESCE(
           array_agg(i.id ORDER BY i.id) FILTER (WHERE i.id IS NOT NULL),
           '{}'::int[]
         ) AS expected_ids
    FROM user_profiles p
    LEFT JOIN user_interests ui ON ui.user_id = p.user_id
    LEFT JOIN interests i ON i.id = ui.interest_id AND i.is_active = TRUE
   GROUP BY p.user_id
)
SELECT count(*) AS drifted_profiles_before
  FROM user_profiles p
  JOIN expected e USING (user_id)
 WHERE p.interest_ids IS DISTINCT FROM e.expected_ids;

WITH expected AS (
  SELECT p.user_id,
         COALESCE(
           array_agg(i.id ORDER BY i.id) FILTER (WHERE i.id IS NOT NULL),
           '{}'::int[]
         ) AS expected_ids
    FROM user_profiles p
    LEFT JOIN user_interests ui ON ui.user_id = p.user_id
    LEFT JOIN interests i ON i.id = ui.interest_id AND i.is_active = TRUE
   GROUP BY p.user_id
), repaired AS (
  UPDATE user_profiles p
     SET interest_ids = e.expected_ids
    FROM expected e
   WHERE p.user_id = e.user_id
     AND p.interest_ids IS DISTINCT FROM e.expected_ids
  RETURNING p.user_id
)
SELECT count(*) AS repaired_profiles FROM repaired;

WITH expected AS (
  SELECT p.user_id,
         COALESCE(
           array_agg(i.id ORDER BY i.id) FILTER (WHERE i.id IS NOT NULL),
           '{}'::int[]
         ) AS expected_ids
    FROM user_profiles p
    LEFT JOIN user_interests ui ON ui.user_id = p.user_id
    LEFT JOIN interests i ON i.id = ui.interest_id AND i.is_active = TRUE
   GROUP BY p.user_id
)
SELECT count(*) AS drifted_profiles_after
  FROM user_profiles p
  JOIN expected e USING (user_id)
 WHERE p.interest_ids IS DISTINCT FROM e.expected_ids;

COMMIT;
