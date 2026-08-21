\set ON_ERROR_STOP on
\if :{?tos_version}
\else
  \set tos_version 'tos-test-v1'
\endif
\if :{?privacy_version}
\else
  \set privacy_version 'privacy-test-v1'
\endif

-- Reproducible Phase 4 candidate benchmark fixture:
--   5,001 users, 10,002 trips/segments, 20 active interests, four interests/user.
--   3,001 users cluster around Paris/Rome with three date cohorts; the rest
--   are distributed across distant hubs. Deterministic hard-filter cohorts
--   exercise status, discovery, Ghost, restrictions, blocks and prior swipes.
BEGIN;
SET LOCAL synchronous_commit = off;

ALTER TABLE user_consents DISABLE TRIGGER user_consents_append_only;
DELETE FROM users WHERE firebase_uid LIKE 'phase4-bench-%';
ALTER TABLE user_consents ENABLE TRIGGER user_consents_append_only;
DELETE FROM interests WHERE code LIKE 'phase4_bench_%';

INSERT INTO interests (code, label, grouping, is_active, sort_order)
SELECT 'phase4_bench_' || n, 'Phase 4 benchmark ' || n, 'benchmark', TRUE, n
  FROM generate_series(0, 19) AS seed(n);

INSERT INTO users
  (id, firebase_uid, email, email_verified_at, account_status, date_of_birth,
   trust_score_raw)
SELECT md5('phase4-bench-user-' || n)::uuid,
       'phase4-bench-' || n,
       'phase4-bench-' || n || '@example.test',
       now(),
       CASE WHEN n > 0 AND n % 31 = 0
            THEN 'DEACTIVATED'::user_account_status
            ELSE 'ACTIVE'::user_account_status END,
       DATE '1980-01-01' + (n % 7300),
       3.000 + ((n % 71)::numeric / 10.0)
  FROM generate_series(0, 5000) AS seed(n);

INSERT INTO user_profiles
  (user_id, display_name, home_country_code, languages_spoken, travel_style)
SELECT md5('phase4-bench-user-' || n)::uuid,
       'Benchmark traveller ' || n,
       CASE n % 5 WHEN 0 THEN 'FR' WHEN 1 THEN 'IT' WHEN 2 THEN 'JP'
                    WHEN 3 THEN 'US' ELSE 'AU' END,
       CASE n % 3 WHEN 0 THEN ARRAY['en','fr']
                  WHEN 1 THEN ARRAY['en','it'] ELSE ARRAY['en'] END,
       1 + (n % 5)
  FROM generate_series(0, 5000) AS seed(n);

INSERT INTO user_settings
  (user_id, discovery_enabled, ghost_mode_enabled, min_age_preference,
   max_age_preference, min_trust_score_preference, max_distance_km)
SELECT md5('phase4-bench-user-' || n)::uuid,
       NOT (n > 0 AND n % 23 = 0),
       (n > 0 AND n % 29 = 0),
       18,
       99,
       CASE WHEN n % 7 = 0 THEN 4 ELSE 0 END,
       500
  FROM generate_series(0, 5000) AS seed(n);

INSERT INTO user_consents (user_id, consent_type, granted, policy_version)
SELECT md5('phase4-bench-user-' || n)::uuid,
       'TERMS_OF_SERVICE'::consent_type, TRUE, :'tos_version'
  FROM generate_series(0, 5000) AS seed(n)
UNION ALL
SELECT md5('phase4-bench-user-' || n)::uuid,
       'PRIVACY_POLICY'::consent_type, TRUE, :'privacy_version'
  FROM generate_series(0, 5000) AS seed(n);

INSERT INTO user_interests (user_id, interest_id)
SELECT md5('phase4-bench-user-' || n)::uuid, interests.id
  FROM generate_series(0, 5000) AS seed(n)
 CROSS JOIN LATERAL generate_series(0, 3) AS interest_offset(k)
 JOIN interests
   ON interests.code = 'phase4_bench_' || ((n + interest_offset.k * 3) % 20);

INSERT INTO trips (id, user_id, title, start_date, end_date, visibility)
SELECT md5('phase4-bench-trip-a-' || n)::uuid,
       md5('phase4-bench-user-' || n)::uuid,
       'Benchmark summer A ' || n,
       DATE '2027-06-01', DATE '2027-06-30',
       CASE n % 3 WHEN 0 THEN 'PRIVATE'::trip_visibility
                  WHEN 1 THEN 'MATCHES_ONLY'::trip_visibility
                  ELSE 'PUBLIC'::trip_visibility END
  FROM generate_series(0, 5000) AS seed(n)
UNION ALL
SELECT md5('phase4-bench-trip-b-' || n)::uuid,
       md5('phase4-bench-user-' || n)::uuid,
       'Benchmark summer B ' || n,
       DATE '2027-07-01', DATE '2027-07-31',
       'MATCHES_ONLY'::trip_visibility
  FROM generate_series(0, 5000) AS seed(n);

INSERT INTO trip_segments
  (id, trip_id, user_id, destination_place_id, destination_name, country_code,
   location, start_date, end_date, sort_order)
SELECT md5('phase4-bench-segment-a-' || n)::uuid,
       md5('phase4-bench-trip-a-' || n)::uuid,
       md5('phase4-bench-user-' || n)::uuid,
       CASE WHEN n <= 3000 THEN 'phase4-paris' ELSE 'phase4-far-a-' || (n % 4) END,
       CASE WHEN n <= 3000 THEN 'Paris' ELSE 'Distant hub A' END,
       CASE WHEN n <= 3000 THEN 'FR' ELSE 'US' END,
       ST_SetSRID(ST_MakePoint(
         CASE WHEN n <= 3000 THEN 2.3522 + (((n % 21) - 10) * 0.003)
              ELSE -149.9003 + ((n % 17) * 0.01) END,
         CASE WHEN n <= 3000 THEN 48.8566 + (((n % 19) - 9) * 0.003)
              ELSE 61.2181 + ((n % 13) * 0.01) END
       ), 4326)::geography,
       DATE '2027-06-01' + ((n % 3) * 7),
       DATE '2027-06-14' + ((n % 3) * 7),
       0
  FROM generate_series(0, 5000) AS seed(n)
UNION ALL
SELECT md5('phase4-bench-segment-b-' || n)::uuid,
       md5('phase4-bench-trip-b-' || n)::uuid,
       md5('phase4-bench-user-' || n)::uuid,
       CASE WHEN n <= 3000 THEN 'phase4-rome' ELSE 'phase4-far-b-' || (n % 4) END,
       CASE WHEN n <= 3000 THEN 'Rome' ELSE 'Distant hub B' END,
       CASE WHEN n <= 3000 THEN 'IT' ELSE 'JP' END,
       ST_SetSRID(ST_MakePoint(
         CASE WHEN n <= 3000 THEN 12.4964 + (((n % 21) - 10) * 0.003)
              ELSE 139.6917 + ((n % 17) * 0.01) END,
         CASE WHEN n <= 3000 THEN 41.9028 + (((n % 19) - 9) * 0.003)
              ELSE 35.6895 + ((n % 13) * 0.01) END
       ), 4326)::geography,
       DATE '2027-07-01' + ((n % 3) * 7),
       DATE '2027-07-14' + ((n % 3) * 7),
       1
  FROM generate_series(0, 5000) AS seed(n);

INSERT INTO account_restrictions (user_id, type, reason)
SELECT md5('phase4-bench-user-' || n)::uuid,
       'MATCHING_SUSPENDED', 'Phase 4 benchmark restriction'
  FROM generate_series(37, 5000, 37) AS seed(n);

INSERT INTO user_blocks (blocker_user_id, blocked_user_id, reason)
SELECT md5('phase4-bench-user-0')::uuid,
       md5('phase4-bench-user-' || n)::uuid,
       'Phase 4 benchmark filter'
  FROM generate_series(41, 5000, 41) AS seed(n);

-- A distributed background set makes the two directional block indexes
-- visible to the planner rather than presenting it with a tiny toy table.
INSERT INTO user_blocks (blocker_user_id, blocked_user_id, reason)
SELECT md5('phase4-bench-user-' || n)::uuid,
       md5('phase4-bench-user-' || ((n + 101) % 5001))::uuid,
       'Phase 4 benchmark distributed filter'
  FROM generate_series(1, 5000) AS seed(n)
ON CONFLICT (blocker_user_id, blocked_user_id) DO NOTHING;

INSERT INTO swipes (source_user_id, target_user_id, direction)
SELECT md5('phase4-bench-user-0')::uuid,
       md5('phase4-bench-user-' || n)::uuid,
       CASE WHEN n % 2 = 0 THEN 'LIKE'::swipe_direction ELSE 'PASS'::swipe_direction END
  FROM generate_series(43, 5000, 43) AS seed(n);

-- Likewise keep a realistic number of source/target swipe pairs so the
-- source keyset index is exercised in EXPLAIN, not optimized away.
INSERT INTO swipes (source_user_id, target_user_id, direction)
SELECT md5('phase4-bench-user-' || n)::uuid,
       md5('phase4-bench-user-' || ((n + 211) % 5001))::uuid,
       CASE WHEN n % 2 = 0
            THEN 'LIKE'::swipe_direction ELSE 'PASS'::swipe_direction END
  FROM generate_series(1, 5000) AS seed(n)
ON CONFLICT (source_user_id, target_user_id) DO NOTHING;

ANALYZE users;
ANALYZE user_profiles;
ANALYZE user_settings;
ANALYZE user_consents;
ANALYZE trip_segments;
ANALYZE swipes;
ANALYZE user_blocks;
ANALYZE account_restrictions;

COMMIT;

SELECT count(*) AS benchmark_users
  FROM users WHERE firebase_uid LIKE 'phase4-bench-%';
SELECT count(*) AS benchmark_segments
  FROM trip_segments segment
  JOIN users ON users.id = segment.user_id
 WHERE users.firebase_uid LIKE 'phase4-bench-%';
