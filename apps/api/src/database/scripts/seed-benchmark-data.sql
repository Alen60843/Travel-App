-- ============================================================================
-- Benchmark fixture: realistic volume + realistic geographic clustering.
--
-- Travellers are not uniformly distributed over the globe; they pile into a
-- few dozen hubs. A uniform-random seed would make ANY spatial index look
-- good, so points are drawn around 40 real hub centroids with jitter.
--
-- All per-row variation is derived from a hash of the row's primary key
-- rather than random(). Two reasons:
--   1. An UNCORRELATED `JOIN LATERAL (SELECT ... random() ...)` is evaluated
--      ONCE for the whole statement, not per row — it silently collapses every
--      row onto a single hub/date. Hash-of-PK is genuinely per row.
--   2. The same expression can be repeated (e.g. start_date and end_date)
--      without drawing two different values and violating a CHECK constraint.
--
--   psql -d tripwith -v ON_ERROR_STOP=1 -f seed-benchmark-data.sql
-- ============================================================================

\timing on

-- Deterministic 28-bit non-negative hash. bit(28)::int can never be negative,
-- which avoids the abs(int4min) overflow trap.
CREATE OR REPLACE FUNCTION bench_hash(p TEXT) RETURNS INT
LANGUAGE sql IMMUTABLE AS $$
  SELECT ('x' || substr(md5(p), 1, 7))::bit(28)::INT
$$;

-- Idempotent: wipe any previous bench fixture first.
--
-- event_status_history is append-only, so even a CASCADE delete from events is
-- refused by tw_forbid_mutation(). Purging audit rows therefore requires
-- explicitly disabling the guard as table owner — deliberately awkward, and
-- proof the guard is real. This is a fixture-reset concession only; no
-- application code path may ever do this.
DELETE FROM swipes       WHERE source_user_id IN (SELECT id FROM users WHERE firebase_uid LIKE 'bench_%');
DELETE FROM user_blocks  WHERE blocker_user_id IN (SELECT id FROM users WHERE firebase_uid LIKE 'bench_%');

ALTER TABLE event_status_history DISABLE TRIGGER event_status_history_append_only;
DELETE FROM event_status_history WHERE event_id IN (SELECT id FROM events WHERE title LIKE 'Bench event%');
DELETE FROM events       WHERE title LIKE 'Bench event%';
ALTER TABLE event_status_history ENABLE TRIGGER event_status_history_append_only;
DELETE FROM trips        WHERE user_id IN (SELECT id FROM users WHERE firebase_uid LIKE 'bench_%');
DELETE FROM user_settings WHERE user_id IN (SELECT id FROM users WHERE firebase_uid LIKE 'bench_%');
DELETE FROM user_profiles WHERE user_id IN (SELECT id FROM users WHERE firebase_uid LIKE 'bench_%');
DELETE FROM users        WHERE firebase_uid LIKE 'bench_%';

CREATE TEMP TABLE hub (id INT PRIMARY KEY, lon DOUBLE PRECISION, lat DOUBLE PRECISION);
INSERT INTO hub (id, lon, lat)
SELECT row_number() OVER (), v.lon, v.lat
FROM (VALUES
  (100.5018, 13.7563),  (103.8198,  1.3521),  (106.6297, 10.8231),
  (105.8542, 21.0285),  (102.6331, 17.9757),  (104.9160, 11.5564),
  (116.4074, 39.9042),  (139.6503, 35.6762),  (126.9780, 37.5665),
  (121.4737, 31.2304),  ( 77.1025, 28.7041),  ( 72.8777, 19.0760),
  ( 80.2707, 13.0827),  ( 55.2708, 25.2048),  ( 34.7818, 32.0853),
  ( 28.9784, 41.0082),  ( 23.7275, 37.9838),  ( 12.4964, 41.9028),
  (  2.3522, 48.8566),  ( -0.1276, 51.5074),  ( 13.4050, 52.5200),
  (  4.9041, 52.3676),  ( 16.3738, 48.2082),  ( 14.4378, 50.0755),
  ( 21.0122, 52.2297),  ( -3.7038, 40.4168),  (  2.1734, 41.3851),
  ( -9.1393, 38.7223),  ( 18.0686, 59.3293),  ( 24.9384, 60.1699),
  (-74.0060, 40.7128),  (-118.2437, 34.0522), (-99.1332, 19.4326),
  (-77.0428, -12.0464), (-58.3816, -34.6037), (-46.6333, -23.5505),
  (-70.6693, -33.4489), (151.2093, -33.8688), (174.7633, -36.8485),
  ( 31.2357, 30.0444)
) AS v(lon, lat);

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
INSERT INTO users (firebase_uid, email, date_of_birth, account_status)
SELECT 'bench_' || g,
       'bench' || g || '@example.com',
       DATE '1990-01-01' + (g % 4000),
       CASE WHEN g % 50 = 0 THEN 'SUSPENDED' ELSE 'ACTIVE' END::user_account_status
FROM generate_series(1, 50000) g;

INSERT INTO user_profiles (user_id, display_name, travel_style, home_country_code)
SELECT id,
       'Bench ' || substr(firebase_uid, 7),
       (1 + bench_hash(id::TEXT || 'style') % 5)::SMALLINT,
       (ARRAY['GB','DE','FR','US','AU','NL','SE','ES','IT','CA'])
         [1 + bench_hash(id::TEXT || 'ctry') % 10]
FROM users WHERE firebase_uid LIKE 'bench_%';

INSERT INTO user_settings (user_id, ghost_mode_enabled)
SELECT id, (bench_hash(id::TEXT || 'ghost') % 100 < 5)
FROM users WHERE firebase_uid LIKE 'bench_%';

-- ---------------------------------------------------------------------------
-- Trips: one per user, start date spread across the year
-- ---------------------------------------------------------------------------
INSERT INTO trips (user_id, title, start_date, end_date)
SELECT u.id,
       'Trip ' || substr(u.firebase_uid, 7),
       DATE '2026-01-01' + (bench_hash(u.id::TEXT || 'start') % 330),
       DATE '2026-01-01' + (bench_hash(u.id::TEXT || 'start') % 330) + 45
FROM users u WHERE u.firebase_uid LIKE 'bench_%';

-- ---------------------------------------------------------------------------
-- Trip segments: 3 per trip, each on an independently chosen hub
-- ---------------------------------------------------------------------------
INSERT INTO trip_segments (
  trip_id, user_id, destination_name, location, start_date, end_date, sort_order
)
SELECT t.id,
       t.user_id,
       'Segment ' || s,
       ST_MakePoint(
         h.lon + ((bench_hash(t.id::TEXT || s::TEXT || 'lon') % 1000) / 1000.0 - 0.5) * 0.6,
         h.lat + ((bench_hash(t.id::TEXT || s::TEXT || 'lat') % 1000) / 1000.0 - 0.5) * 0.6
       )::GEOGRAPHY,
       t.start_date + ((s - 1) * 14),
       t.start_date + ((s - 1) * 14) + (3 + bench_hash(t.id::TEXT || s::TEXT || 'dur') % 11),
       s
FROM trips t
CROSS JOIN generate_series(1, 3) s
JOIN hub h ON h.id = 1 + bench_hash(t.id::TEXT || s::TEXT || 'hub') % 40
WHERE t.user_id IN (SELECT id FROM users WHERE firebase_uid LIKE 'bench_%');

-- ---------------------------------------------------------------------------
-- Events: clustered on the same hubs, spread across the year
-- ---------------------------------------------------------------------------
INSERT INTO events (
  host_type, host_user_id, category_id, title, capacity_max,
  starts_at, ends_at, meeting_point, status, visibility
)
SELECT 'USER',
       u.id,
       1 + bench_hash(u.id::TEXT || s::TEXT || 'cat') % 10,
       'Bench event ' || u.firebase_uid || '-' || s,
       5 + bench_hash(u.id::TEXT || s::TEXT || 'cap') % 20,
       TIMESTAMPTZ '2026-01-01 00:00+00'
         + ((bench_hash(u.id::TEXT || s::TEXT || 'when') % 330) || ' days')::INTERVAL,
       TIMESTAMPTZ '2026-01-01 00:00+00'
         + ((bench_hash(u.id::TEXT || s::TEXT || 'when') % 330) || ' days')::INTERVAL
         + INTERVAL '5 hours',
       ST_MakePoint(
         h.lon + ((bench_hash(u.id::TEXT || s::TEXT || 'elon') % 1000) / 1000.0 - 0.5) * 0.6,
         h.lat + ((bench_hash(u.id::TEXT || s::TEXT || 'elat') % 1000) / 1000.0 - 0.5) * 0.6
       )::GEOGRAPHY,
       CASE WHEN bench_hash(u.id::TEXT || s::TEXT || 'st') % 100 < 12
            THEN 'DRAFT' ELSE 'ACTIVE' END::event_status,
       CASE WHEN bench_hash(u.id::TEXT || s::TEXT || 'vis') % 100 < 10
            THEN 'PRIVATE' ELSE 'PUBLIC' END::event_visibility
FROM users u
CROSS JOIN generate_series(1, 2) s
JOIN hub h ON h.id = 1 + bench_hash(u.id::TEXT || s::TEXT || 'ehub') % 40
WHERE u.firebase_uid LIKE 'bench_%';

-- Swipe history so the matching anti-join has something to exclude.
INSERT INTO swipes (source_user_id, target_user_id, direction)
SELECT a.id, b.id,
       CASE WHEN bench_hash(a.id::TEXT || b.id::TEXT) % 10 < 3
            THEN 'LIKE' ELSE 'PASS' END::swipe_direction
FROM (SELECT id, row_number() OVER (ORDER BY id) rn FROM users WHERE firebase_uid LIKE 'bench_%') a
JOIN (SELECT id, row_number() OVER (ORDER BY id) rn FROM users WHERE firebase_uid LIKE 'bench_%') b
  ON b.rn = ((a.rn * 7919) % 50000) + 1
WHERE a.rn <= 20000 AND a.id <> b.id
ON CONFLICT DO NOTHING;

INSERT INTO user_blocks (blocker_user_id, blocked_user_id)
SELECT a.id, b.id
FROM (SELECT id, row_number() OVER (ORDER BY id) rn FROM users WHERE firebase_uid LIKE 'bench_%') a
JOIN (SELECT id, row_number() OVER (ORDER BY id) rn FROM users WHERE firebase_uid LIKE 'bench_%') b
  ON b.rn = ((a.rn * 104729) % 50000) + 1
WHERE a.rn <= 3000 AND a.id <> b.id
ON CONFLICT DO NOTHING;

VACUUM ANALYZE;

-- ---------------------------------------------------------------------------
-- Fixture sanity: the benchmark is worthless if the data is degenerate.
-- ---------------------------------------------------------------------------
SELECT 'users'         AS table, count(*) FROM users
UNION ALL SELECT 'trips',         count(*) FROM trips
UNION ALL SELECT 'trip_segments', count(*) FROM trip_segments
UNION ALL SELECT 'events',        count(*) FROM events
UNION ALL SELECT 'swipes',        count(*) FROM swipes
UNION ALL SELECT 'user_blocks',   count(*) FROM user_blocks;

\echo 'fixture spread check (expect ~40 distinct hubs and a ~year-wide date span):'
SELECT count(DISTINCT ST_SnapToGrid(location::geometry, 1.0))  AS distinct_hub_cells,
       min(start_date) AS earliest,
       max(end_date)   AS latest
FROM trip_segments;

SELECT count(*) AS segments_near_bangkok_50km
FROM trip_segments
WHERE ST_DWithin(location, ST_MakePoint(100.5018, 13.7563)::GEOGRAPHY, 50000);
