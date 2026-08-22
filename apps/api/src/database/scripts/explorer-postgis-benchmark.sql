-- ============================================================================
-- Phase 5 Explorer: reproducible PostGIS plan and latency evidence
--
-- Run against a migrated TripWith database:
--   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
--     -f apps/api/src/database/scripts/explorer-postgis-benchmark.sql
--
-- This is deliberately one psql session and one transaction. It inserts a
-- deterministic 150,000-event synthetic workload into the canonical tables,
-- benchmarks the same bounded viewport/radius/time predicates used by
-- Explorer, and ROLLBACKs every fixture and audit row. If psql is interrupted,
-- disconnecting also rolls the open transaction back. Post-rollback assertions
-- prove that no fixture row remains.
--
-- Measurement policy (not cherry-picked): two warm-up executions followed by
-- 15 consecutive measured EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) executions.
-- The report includes p50/p95/min/max execution time, p50 planning time, result
-- rows, buffers, every chosen index, the exact executable query, synthetic and
-- during-run table sizes, and one complete representative plan per scenario.
--
-- Reference run (2026-08-22): PostgreSQL 17.11 / PostGIS 3.6.4, warm cache,
-- 128 MB shared_buffers, parallelism/JIT disabled, 150,000 total synthetic
-- events (103,500 discoverable), including 30,000 dense Paris events (25,500
-- discoverable). These are single-query latency measurements, not throughput:
--
--   scenario                             p50 ms   p95 ms   rows   p50 buffers
--   viewport_small_pins                    1.520    1.567    500          2,049
--   viewport_medium_pins                  36.626   37.120    500         26,127
--   viewport_large_clusters               45.152   45.537      6          5,222
--   radius_25km_pins                        9.668    9.844    500         24,707
--   viewport_antimeridian_split_pins        2.667    2.738    500          2,238
--   dense_viewport_clusters                10.459   10.833     37          6,161
--
-- Every representative plan used events_discoverable_geo_time_gix. The dense
-- privacy proof saw 7,000 spatial/time candidates, excluded 1,500 before any
-- aggregation, and clustered exactly the remaining 5,500 discoverable rows.
-- Exact executable queries, full dataset metadata, and representative JSON
-- plans are emitted together below on every run.
-- ============================================================================

\set ON_ERROR_STOP on
\pset pager off
\timing on

BEGIN;

-- Prevent two copies of this fixture from colliding in the same database.
SELECT pg_advisory_xact_lock(hashtextextended('tripwith.explorer-postgis-benchmark.v1', 0));

SET LOCAL timezone = 'UTC';
SET LOCAL max_parallel_workers_per_gather = 0;
SET LOCAL jit = off;
SET LOCAL application_name = 'tripwith-explorer-postgis-benchmark';

DO $assert_schema$
DECLARE
  v_definition TEXT;
  v_predicate  TEXT;
  v_valid      BOOLEAN;
BEGIN
  SELECT pg_get_indexdef(i.indexrelid),
         pg_get_expr(i.indpred, i.indrelid),
         i.indisvalid
    INTO v_definition, v_predicate, v_valid
    FROM pg_index i
   WHERE i.indexrelid = to_regclass('events_discoverable_geo_time_gix');

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'required index events_discoverable_geo_time_gix is missing';
  END IF;
  IF NOT v_valid THEN
    RAISE EXCEPTION 'required index events_discoverable_geo_time_gix is invalid';
  END IF;
  IF position('gist (meeting_point, time_range)' IN lower(v_definition)) = 0 THEN
    RAISE EXCEPTION 'unexpected Explorer index definition: %', v_definition;
  END IF;
  IF position('visibility' IN lower(v_predicate)) = 0
     OR position('public' IN lower(v_predicate)) = 0
     OR position('status' IN lower(v_predicate)) = 0
     OR position('active' IN lower(v_predicate)) = 0
     OR position('full' IN lower(v_predicate)) = 0 THEN
    RAISE EXCEPTION 'unexpected Explorer partial-index predicate: %', v_predicate;
  END IF;
END
$assert_schema$;

CREATE TEMP TABLE explorer_fixture_context (
  host_id                    UUID NOT NULL,
  category_count             INT NOT NULL,
  synthetic_total_events     BIGINT,
  synthetic_discoverable     BIGINT,
  synthetic_dense_events     BIGINT,
  synthetic_dense_discoverable BIGINT,
  table_total_during_run     BIGINT,
  fixture_min_starts_at      TIMESTAMPTZ,
  fixture_max_ends_at        TIMESTAMPTZ,
  status_visibility_counts   JSONB
) ON COMMIT DROP;

CREATE TEMP TABLE explorer_fixture_categories (
  ordinal INT PRIMARY KEY,
  id      INT NOT NULL
) ON COMMIT DROP;

INSERT INTO explorer_fixture_categories (ordinal, id)
SELECT row_number() OVER (ORDER BY sort_order, id), id
  FROM event_categories
 WHERE is_active;

DO $assert_categories$
BEGIN
  IF NOT EXISTS (SELECT FROM explorer_fixture_categories) THEN
    RAISE EXCEPTION 'Explorer benchmark requires at least one active event category';
  END IF;
END
$assert_categories$;

WITH inserted_host AS (
  INSERT INTO users (
    id, firebase_uid, email, email_verified_at, account_status, date_of_birth
  ) VALUES (
    md5('tripwith.explorer-postgis-benchmark.host.v1')::UUID,
    'explorer_bench_postgis_evidence_v1',
    'explorer-bench-postgis-evidence-v1@example.com',
    TIMESTAMPTZ '2029-01-01 00:00:00+00',
    'ACTIVE',
    DATE '1990-01-01'
  )
  RETURNING id
)
INSERT INTO explorer_fixture_context (host_id, category_count)
SELECT id, (SELECT count(*) FROM explorer_fixture_categories)
  FROM inserted_host;

CREATE TEMP TABLE explorer_hubs (
  id  INT PRIMARY KEY,
  lon DOUBLE PRECISION NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  label TEXT NOT NULL
) ON COMMIT DROP;

-- Real travel hubs, including points on both sides of the antimeridian.
INSERT INTO explorer_hubs (id, lon, lat, label) VALUES
  ( 1,    2.3522,  48.8566, 'Paris'),
  ( 2,   -0.1276,  51.5074, 'London'),
  ( 3,   13.4050,  52.5200, 'Berlin'),
  ( 4,   12.4964,  41.9028, 'Rome'),
  ( 5,   -3.7038,  40.4168, 'Madrid'),
  ( 6,   23.7275,  37.9838, 'Athens'),
  ( 7,   34.7818,  32.0853, 'Tel Aviv'),
  ( 8,   28.9784,  41.0082, 'Istanbul'),
  ( 9,  100.5018,  13.7563, 'Bangkok'),
  (10,  103.8198,   1.3521, 'Singapore'),
  (11,  139.6503,  35.6762, 'Tokyo'),
  (12,  151.2093, -33.8688, 'Sydney'),
  (13,  -74.0060,  40.7128, 'New York'),
  (14, -118.2437,  34.0522, 'Los Angeles'),
  (15,  -99.1332,  19.4326, 'Mexico City'),
  (16,  -77.0428, -12.0464, 'Lima'),
  (17,  -58.3816, -34.6037, 'Buenos Aires'),
  (18,  -46.6333, -23.5505, 'Sao Paulo'),
  (19,   18.4241, -33.9249, 'Cape Town'),
  (20,   55.2708,  25.2048, 'Dubai'),
  (21,   77.1025,  28.7041, 'Delhi'),
  (22,  179.2000, -17.7134, 'Fiji east'),
  (23, -179.5000, -17.7134, 'Fiji west'),
  (24,  -21.9426,  64.1466, 'Reykjavik');

-- 120k events spread over 24 travel hubs and 240 days. Coordinates, dates,
-- categories, visibility, and status are deterministic arithmetic sequences.
-- Jitter is intentionally clustered (not global uniform noise), because a
-- uniform world distribution would unrealistically flatter a spatial index.
WITH distributed AS (
  SELECT g,
         h.lon + ((((g::BIGINT * 7919) % 10000) / 10000.0) - 0.5) * 0.70 AS lon,
         h.lat + ((((g::BIGINT * 15485863) % 10000) / 10000.0) - 0.5) * 0.70 AS lat,
         TIMESTAMPTZ '2030-01-01 00:00:00+00'
           + (((g::BIGINT * 37) % 240) * INTERVAL '1 day')
           + (((g::BIGINT * 13) % 24) * INTERVAL '1 hour') AS starts_at,
         CASE
           WHEN g % 20 < 14 THEN 'ACTIVE'
           WHEN g % 20 < 16 THEN 'FULL'
           WHEN g % 20 = 16 THEN 'DRAFT'
           WHEN g % 20 = 17 THEN 'IN_PROGRESS'
           WHEN g % 20 = 18 THEN 'COMPLETED'
           ELSE 'CANCELLED'
         END AS status_text,
         CASE
           -- Deliberately independent of status_text: this creates PUBLIC
           -- DRAFT/IN_PROGRESS/COMPLETED/CANCELLED rows as well as PRIVATE or
           -- UNLISTED ACTIVE/FULL rows, so both halves of the partial-index
           -- predicate are exercised independently.
           WHEN (g::BIGINT * 7) % 10 < 8 THEN 'PUBLIC'
           WHEN (g::BIGINT * 7) % 10 = 8 THEN 'UNLISTED'
           ELSE 'PRIVATE'
         END AS visibility_text,
         ctx.host_id,
         ctx.category_count
    FROM generate_series(1, 120000) AS series(g)
    JOIN explorer_hubs h ON h.id = 1 + (g % 24)
    CROSS JOIN explorer_fixture_context ctx
)
INSERT INTO events (
  host_type, host_user_id, category_id, title, capacity_max,
  starts_at, ends_at, meeting_point, meeting_point_label,
  status, visibility, cancelled_at, completed_at
)
SELECT 'USER',
       d.host_id,
       c.id,
       'Explorer benchmark fixture distributed ' || d.g,
       20,
       d.starts_at,
       d.starts_at + ((2 + d.g % 6) * INTERVAL '1 hour'),
       ST_SetSRID(ST_MakePoint(d.lon, d.lat), 4326)::geography,
       'Explorer benchmark distributed',
       d.status_text::event_status,
       d.visibility_text::event_visibility,
       CASE WHEN d.status_text = 'CANCELLED' THEN d.starts_at - INTERVAL '1 day' END,
       CASE WHEN d.status_text = 'COMPLETED' THEN d.starts_at + INTERVAL '1 day' END
  FROM distributed d
  JOIN explorer_fixture_categories c
    ON c.ordinal = 1 + (d.g % d.category_count);

-- 30k additional Paris events create a genuinely dense map workload. Their
-- points occupy roughly 13 km x 13 km and their starts cover June 2030.
WITH dense AS (
  SELECT g,
         2.3522 + ((((g::BIGINT * 104729) % 10000) / 10000.0) - 0.5) * 0.12 AS lon,
         48.8566 + ((((g::BIGINT * 130363) % 10000) / 10000.0) - 0.5) * 0.12 AS lat,
         TIMESTAMPTZ '2030-06-01 00:00:00+00'
           + (((g::BIGINT * 7) % 30) * INTERVAL '1 day')
           + (((g::BIGINT * 11) % 24) * INTERVAL '1 hour') AS starts_at,
         CASE
           WHEN g % 10 < 8 THEN 'ACTIVE'
           WHEN g % 10 = 8 THEN 'FULL'
           ELSE 'DRAFT'
         END AS status_text,
         CASE WHEN g % 20 < 18 THEN 'PUBLIC' ELSE 'PRIVATE' END AS visibility_text,
         ctx.host_id,
         ctx.category_count
    FROM generate_series(1, 30000) AS series(g)
    CROSS JOIN explorer_fixture_context ctx
)
INSERT INTO events (
  host_type, host_user_id, category_id, title, capacity_max,
  starts_at, ends_at, meeting_point, meeting_point_label, status, visibility
)
SELECT 'USER',
       d.host_id,
       c.id,
       'Explorer benchmark fixture dense ' || d.g,
       50,
       d.starts_at,
       d.starts_at + ((2 + d.g % 6) * INTERVAL '1 hour'),
       ST_SetSRID(ST_MakePoint(d.lon, d.lat), 4326)::geography,
       'Explorer benchmark dense Paris',
       d.status_text::event_status,
       d.visibility_text::event_visibility
  FROM dense d
  JOIN explorer_fixture_categories c
    ON c.ordinal = 1 + (d.g % d.category_count);

UPDATE explorer_fixture_context
   SET synthetic_total_events = stats.total_events,
       synthetic_discoverable = stats.discoverable_events,
       synthetic_dense_events = stats.dense_events,
       synthetic_dense_discoverable = stats.dense_discoverable,
       table_total_during_run = (SELECT count(*) FROM events),
       fixture_min_starts_at = stats.min_starts_at,
       fixture_max_ends_at = stats.max_ends_at,
       status_visibility_counts = (
         SELECT jsonb_object_agg(key, event_count ORDER BY key)
           FROM (
             SELECT status::TEXT || '/' || visibility::TEXT AS key,
                    count(*) AS event_count
               FROM events
              WHERE title LIKE 'Explorer benchmark fixture %'
              GROUP BY status, visibility
           ) distribution
       )
  FROM (
    SELECT count(*) AS total_events,
           count(*) FILTER (
             WHERE visibility = 'PUBLIC' AND status IN ('ACTIVE', 'FULL')
           ) AS discoverable_events,
           count(*) FILTER (
             WHERE meeting_point_label = 'Explorer benchmark dense Paris'
           ) AS dense_events,
           count(*) FILTER (
             WHERE meeting_point_label = 'Explorer benchmark dense Paris'
               AND visibility = 'PUBLIC' AND status IN ('ACTIVE', 'FULL')
           ) AS dense_discoverable,
           min(starts_at) AS min_starts_at,
           max(ends_at) AS max_ends_at
      FROM events
     WHERE title LIKE 'Explorer benchmark fixture %'
  ) stats;

DO $assert_fixture$
DECLARE
  v explorer_fixture_context%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v FROM explorer_fixture_context;
  IF v.synthetic_total_events <> 150000 THEN
    RAISE EXCEPTION 'expected exactly 150000 synthetic events, got %', v.synthetic_total_events;
  END IF;
  IF v.synthetic_dense_events <> 30000 THEN
    RAISE EXCEPTION 'expected exactly 30000 dense events, got %', v.synthetic_dense_events;
  END IF;
  IF v.synthetic_discoverable <> 103500
     OR v.synthetic_dense_discoverable <> 25500 THEN
    RAISE EXCEPTION 'unexpected deterministic discoverable counts: %', row_to_json(v);
  END IF;
END
$assert_fixture$;

-- ANALYZE sees this transaction's uncommitted fixture rows. A second ANALYZE
-- after ROLLBACK restores statistics for whatever permanent data preceded it.
ANALYZE events;
ANALYZE event_status_history;
ANALYZE users;

CREATE TEMP TABLE explorer_benchmark_samples (
  scenario       TEXT NOT NULL,
  sample_number  INT NOT NULL,
  execution_ms   NUMERIC NOT NULL,
  planning_ms    NUMERIC NOT NULL,
  rows_out       BIGINT NOT NULL,
  shared_buffers BIGINT NOT NULL,
  indexes_used   TEXT NOT NULL,
  PRIMARY KEY (scenario, sample_number)
) ON COMMIT DROP;

CREATE TEMP TABLE explorer_benchmark_results (
  scenario             TEXT PRIMARY KEY,
  case_description     TEXT NOT NULL,
  samples              INT NOT NULL,
  execution_p50_ms     NUMERIC NOT NULL,
  execution_p95_ms     NUMERIC NOT NULL,
  execution_min_ms     NUMERIC NOT NULL,
  execution_max_ms     NUMERIC NOT NULL,
  planning_p50_ms      NUMERIC NOT NULL,
  rows_out             BIGINT NOT NULL,
  shared_buffers_p50   NUMERIC NOT NULL,
  indexes_used         TEXT NOT NULL,
  dataset              JSONB NOT NULL,
  exact_query          TEXT NOT NULL,
  representative_plan JSONB NOT NULL
) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.run_explorer_benchmark(
  p_scenario TEXT,
  p_case_description TEXT,
  p_sql TEXT,
  p_samples INT DEFAULT 15,
  p_require_explorer_index BOOLEAN DEFAULT TRUE
) RETURNS VOID
LANGUAGE plpgsql
AS $benchmark$
DECLARE
  v_iteration INT;
  v_plan JSONB;
  v_execution_ms NUMERIC;
  v_planning_ms NUMERIC;
  v_rows BIGINT;
  v_buffers BIGINT;
  v_indexes TEXT;
  v_dataset JSONB;
BEGIN
  IF p_samples < 1 THEN
    RAISE EXCEPTION 'sample count must be positive';
  END IF;

  DELETE FROM explorer_benchmark_samples WHERE scenario = p_scenario;

  -- Iterations 1-2 warm caches and are intentionally not measured. Every one
  -- of iterations 3..N+2 is retained; no favorable sample is selected.
  FOR v_iteration IN 1..(p_samples + 2) LOOP
    EXECUTE
      'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING ON, SUMMARY ON) ' || p_sql
      INTO v_plan;

    v_execution_ms := (v_plan -> 0 ->> 'Execution Time')::NUMERIC;
    v_planning_ms := (v_plan -> 0 ->> 'Planning Time')::NUMERIC;
    v_rows := COALESCE((v_plan -> 0 -> 'Plan' ->> 'Actual Rows')::BIGINT, 0);
    v_buffers :=
        COALESCE((v_plan -> 0 -> 'Plan' ->> 'Shared Hit Blocks')::BIGINT, 0)
      + COALESCE((v_plan -> 0 -> 'Plan' ->> 'Shared Read Blocks')::BIGINT, 0)
      + COALESCE((v_plan -> 0 -> 'Plan' ->> 'Shared Dirtied Blocks')::BIGINT, 0)
      + COALESCE((v_plan -> 0 -> 'Plan' ->> 'Shared Written Blocks')::BIGINT, 0);

    SELECT COALESCE(string_agg(index_name, ', ' ORDER BY index_name), '(none)')
      INTO v_indexes
      FROM (
        SELECT DISTINCT node.value #>> '{}' AS index_name
          FROM jsonb_array_elements(
                 jsonb_path_query_array(v_plan, '$.**."Index Name"')
               ) AS node(value)
      ) names;

    IF p_require_explorer_index
       AND position('events_discoverable_geo_time_gix' IN v_indexes) = 0 THEN
      RAISE EXCEPTION USING
        MESSAGE = format(
          'scenario %s did not use events_discoverable_geo_time_gix; indexes: %s',
          p_scenario,
          v_indexes
        ),
        DETAIL = jsonb_pretty(v_plan);
    END IF;

    IF v_iteration > 2 THEN
      INSERT INTO explorer_benchmark_samples (
        scenario, sample_number, execution_ms, planning_ms,
        rows_out, shared_buffers, indexes_used
      ) VALUES (
        p_scenario, v_iteration - 2, v_execution_ms, v_planning_ms,
        v_rows, v_buffers, v_indexes
      );
    END IF;
  END LOOP;

  SELECT jsonb_build_object(
           'synthetic_total_events', synthetic_total_events,
           'synthetic_discoverable_events', synthetic_discoverable,
           'synthetic_dense_events', synthetic_dense_events,
           'synthetic_dense_discoverable_events', synthetic_dense_discoverable,
           'events_table_rows_during_run', table_total_during_run,
           'fixture_seed', 'deterministic-arithmetic-v1',
           'fixture_min_starts_at_utc', fixture_min_starts_at,
           'fixture_max_ends_at_utc', fixture_max_ends_at,
           'status_visibility_counts', status_visibility_counts,
           'postgresql_version', current_setting('server_version'),
           'postgis_version', postgis_lib_version(),
           'measurement_policy', '2 warmups + 15 consecutive measured samples',
           'max_parallel_workers_per_gather', current_setting('max_parallel_workers_per_gather'),
           'jit', current_setting('jit'),
           'random_page_cost', current_setting('random_page_cost'),
           'effective_cache_size', current_setting('effective_cache_size'),
           'shared_buffers', current_setting('shared_buffers')
         )
    INTO STRICT v_dataset
    FROM explorer_fixture_context;

  INSERT INTO explorer_benchmark_results (
    scenario, case_description, samples,
    execution_p50_ms, execution_p95_ms, execution_min_ms, execution_max_ms,
    planning_p50_ms, rows_out, shared_buffers_p50, indexes_used,
    dataset, exact_query, representative_plan
  )
  SELECT p_scenario,
         p_case_description,
         count(*)::INT,
         round((percentile_cont(0.50) WITHIN GROUP (ORDER BY execution_ms))::NUMERIC, 3),
         round((percentile_cont(0.95) WITHIN GROUP (ORDER BY execution_ms))::NUMERIC, 3),
         round(min(execution_ms), 3),
         round(max(execution_ms), 3),
         round((percentile_cont(0.50) WITHIN GROUP (ORDER BY planning_ms))::NUMERIC, 3),
         max(rows_out),
         round((percentile_cont(0.50) WITHIN GROUP (ORDER BY shared_buffers))::NUMERIC, 0),
         string_agg(DISTINCT indexes_used, ' | ' ORDER BY indexes_used),
         v_dataset,
         p_sql,
         v_plan
    FROM explorer_benchmark_samples
   WHERE scenario = p_scenario;
END
$benchmark$;

-- ---------------------------------------------------------------------------
-- Pin queries: bounded results, deterministic ordering, public/discoverable
-- predicate before category join/projection, generated time_range overlap,
-- and either viewport ST_Intersects or radius ST_DWithin on meeting_point.
-- ---------------------------------------------------------------------------

SELECT pg_temp.run_explorer_benchmark(
  'viewport_small_pins',
  'Paris street-scale viewport (~4 x 4 km), 7-day UTC window, LIMIT 500',
  $query$
    SELECT e.id,
           e.starts_at,
           ST_X(e.meeting_point::geometry) AS longitude,
           ST_Y(e.meeting_point::geometry) AS latitude,
           c.code AS category_code,
           c.icon AS category_icon
      FROM events e
      JOIN event_categories c ON c.id = e.category_id
     WHERE e.visibility = 'PUBLIC'
       AND e.status IN ('ACTIVE', 'FULL')
       AND e.time_range && tstzrange(
             TIMESTAMPTZ '2030-06-01 00:00:00+00',
             TIMESTAMPTZ '2030-06-08 00:00:00+00',
             '[)'
           )
       AND ST_Intersects(
             e.meeting_point,
             ST_MakeEnvelope(2.3322, 48.8366, 2.3722, 48.8766, 4326)::geography
           )
     ORDER BY e.starts_at, e.id
     LIMIT 500
  $query$
);

SELECT pg_temp.run_explorer_benchmark(
  'viewport_medium_pins',
  'Paris metro viewport (~22 x 26 km), 30-day UTC window, LIMIT 500',
  $query$
    SELECT e.id,
           e.starts_at,
           ST_X(e.meeting_point::geometry) AS longitude,
           ST_Y(e.meeting_point::geometry) AS latitude,
           c.code AS category_code,
           c.icon AS category_icon
      FROM events e
      JOIN event_categories c ON c.id = e.category_id
     WHERE e.visibility = 'PUBLIC'
       AND e.status IN ('ACTIVE', 'FULL')
       AND e.time_range && tstzrange(
             TIMESTAMPTZ '2030-06-01 00:00:00+00',
             TIMESTAMPTZ '2030-07-01 00:00:00+00',
             '[)'
           )
       AND ST_Intersects(
             e.meeting_point,
             ST_MakeEnvelope(2.2522, 48.7366, 2.4522, 48.9766, 4326)::geography
           )
     ORDER BY e.starts_at, e.id
     LIMIT 500
  $query$
);

SELECT pg_temp.run_explorer_benchmark(
  'viewport_large_clusters',
  'Western/Central Europe viewport (45 x 25 degrees), 30-day UTC window, 2-degree grid clusters',
  $query$
    WITH discoverable AS MATERIALIZED (
      SELECT e.meeting_point
        FROM events e
       WHERE e.visibility = 'PUBLIC'
         AND e.status IN ('ACTIVE', 'FULL')
         AND e.time_range && tstzrange(
               TIMESTAMPTZ '2030-06-01 00:00:00+00',
               TIMESTAMPTZ '2030-07-01 00:00:00+00',
               '[)'
             )
         AND ST_Intersects(
               e.meeting_point,
               ST_MakeEnvelope(-10.0, 35.0, 35.0, 60.0, 4326)::geography
             )
    ), bucketed AS (
      SELECT floor((ST_X(meeting_point::geometry) + 10.0) / 2.0)::INT AS bucket_x,
             floor((ST_Y(meeting_point::geometry) - 35.0) / 2.0)::INT AS bucket_y,
             ST_X(meeting_point::geometry) AS longitude,
             ST_Y(meeting_point::geometry) AS latitude
        FROM discoverable
    )
    SELECT md5('grid-v1:2.0:' || bucket_x || ':' || bucket_y) AS cluster_id,
           avg(longitude) AS longitude,
           avg(latitude) AS latitude,
           count(*)::INT AS event_count
      FROM bucketed
     GROUP BY bucket_x, bucket_y
     ORDER BY bucket_y, bucket_x
  $query$
);

SELECT pg_temp.run_explorer_benchmark(
  'radius_25km_pins',
  '25 km around Paris center, 14-day UTC window, LIMIT 500',
  $query$
    SELECT e.id,
           e.starts_at,
           ST_X(e.meeting_point::geometry) AS longitude,
           ST_Y(e.meeting_point::geometry) AS latitude,
           c.code AS category_code,
           c.icon AS category_icon
      FROM events e
      JOIN event_categories c ON c.id = e.category_id
     WHERE e.visibility = 'PUBLIC'
       AND e.status IN ('ACTIVE', 'FULL')
       AND e.time_range && tstzrange(
             TIMESTAMPTZ '2030-06-01 00:00:00+00',
             TIMESTAMPTZ '2030-06-15 00:00:00+00',
             '[)'
           )
       AND ST_DWithin(
             e.meeting_point,
             ST_SetSRID(ST_MakePoint(2.3522, 48.8566), 4326)::geography,
             25000
           )
     ORDER BY e.starts_at, e.id
     LIMIT 500
  $query$
);

-- Explorer splits an antimeridian-crossing viewport into two ordinary safe
-- envelopes, then deterministically merges/deduplicates the bounded result.
SELECT pg_temp.run_explorer_benchmark(
  'viewport_antimeridian_split_pins',
  'Dateline-crossing Pacific viewport split into [170,180] and [-180,-170], 30-day UTC window',
  $query$
    SELECT split.id,
           split.starts_at,
           ST_X(split.meeting_point::geometry) AS longitude,
           ST_Y(split.meeting_point::geometry) AS latitude
      FROM (
        SELECT e.id, e.starts_at, e.meeting_point
          FROM events e
         WHERE e.visibility = 'PUBLIC'
           AND e.status IN ('ACTIVE', 'FULL')
           AND e.time_range && tstzrange(
                 TIMESTAMPTZ '2030-06-01 00:00:00+00',
                 TIMESTAMPTZ '2030-07-01 00:00:00+00',
                 '[)'
               )
           AND ST_Intersects(
                 e.meeting_point,
                 ST_MakeEnvelope(170.0, -25.0, 180.0, -5.0, 4326)::geography
               )
        UNION
        SELECT e.id, e.starts_at, e.meeting_point
          FROM events e
         WHERE e.visibility = 'PUBLIC'
           AND e.status IN ('ACTIVE', 'FULL')
           AND e.time_range && tstzrange(
                 TIMESTAMPTZ '2030-06-01 00:00:00+00',
                 TIMESTAMPTZ '2030-07-01 00:00:00+00',
                 '[)'
               )
           AND ST_Intersects(
                 e.meeting_point,
                 ST_MakeEnvelope(-180.0, -25.0, -170.0, -5.0, 4326)::geography
               )
      ) split
     ORDER BY split.starts_at, split.id
     LIMIT 500
  $query$
);

-- ---------------------------------------------------------------------------
-- Dense clustering query. MATERIALIZED makes the security boundary explicit:
-- visibility/status/time/viewport filtering completes before any bucket key,
-- count, or centroid is computed. Cluster IDs are deterministic hashes of the
-- fixed grid version/size and integer bucket coordinates.
-- ---------------------------------------------------------------------------

SELECT pg_temp.run_explorer_benchmark(
  'dense_viewport_clusters',
  'Dense Paris viewport, 7-day UTC window, deterministic 0.02-degree grid clusters',
  $query$
    WITH discoverable AS MATERIALIZED (
      SELECT e.id, e.meeting_point
        FROM events e
       WHERE e.visibility = 'PUBLIC'
         AND e.status IN ('ACTIVE', 'FULL')
         AND e.time_range && tstzrange(
               TIMESTAMPTZ '2030-06-01 00:00:00+00',
               TIMESTAMPTZ '2030-06-08 00:00:00+00',
               '[)'
             )
         AND ST_Intersects(
               e.meeting_point,
               ST_MakeEnvelope(2.2522, 48.7366, 2.4522, 48.9766, 4326)::geography
             )
    ), bucketed AS (
      SELECT floor((ST_X(meeting_point::geometry) - 2.2522) / 0.02)::INT AS bucket_x,
             floor((ST_Y(meeting_point::geometry) - 48.7366) / 0.02)::INT AS bucket_y,
             ST_X(meeting_point::geometry) AS longitude,
             ST_Y(meeting_point::geometry) AS latitude
        FROM discoverable
    )
    SELECT md5('grid-v1:0.02:' || bucket_x || ':' || bucket_y) AS cluster_id,
           avg(longitude) AS longitude,
           avg(latitude) AS latitude,
           count(*)::INT AS event_count
      FROM bucketed
     GROUP BY bucket_x, bucket_y
     ORDER BY bucket_y, bucket_x
  $query$
);

-- Independent privacy proof for the clustering query. The raw spatial/time
-- population must contain excluded events. Cluster counts and their weighted
-- centroids must exactly equal the PUBLIC + ACTIVE/FULL population, proving
-- excluded rows cannot affect count, centroid, or cluster existence.
CREATE TEMP TABLE explorer_cluster_privacy_proof ON COMMIT DROP AS
WITH spatial_time AS MATERIALIZED (
  SELECT e.meeting_point, e.visibility, e.status
    FROM events e
   WHERE e.time_range && tstzrange(
         TIMESTAMPTZ '2030-06-01 00:00:00+00',
         TIMESTAMPTZ '2030-06-08 00:00:00+00',
         '[)'
       )
     AND ST_Intersects(
           e.meeting_point,
           ST_MakeEnvelope(2.2522, 48.7366, 2.4522, 48.9766, 4326)::geography
         )
), discoverable AS MATERIALIZED (
  SELECT meeting_point
    FROM spatial_time
   WHERE visibility = 'PUBLIC' AND status IN ('ACTIVE', 'FULL')
), bucketed AS (
  SELECT floor((ST_X(meeting_point::geometry) - 2.2522) / 0.02)::INT AS bucket_x,
         floor((ST_Y(meeting_point::geometry) - 48.7366) / 0.02)::INT AS bucket_y,
         ST_X(meeting_point::geometry) AS longitude,
         ST_Y(meeting_point::geometry) AS latitude
    FROM discoverable
), clustered AS (
  SELECT bucket_x, bucket_y,
         count(*)::BIGINT AS event_count,
         avg(longitude) AS longitude,
         avg(latitude) AS latitude
    FROM bucketed
   GROUP BY bucket_x, bucket_y
), direct AS (
  SELECT count(*)::BIGINT AS event_count,
         avg(ST_X(meeting_point::geometry)) AS longitude,
         avg(ST_Y(meeting_point::geometry)) AS latitude
    FROM discoverable
), aggregate_from_clusters AS (
  SELECT COALESCE(sum(event_count), 0)::BIGINT AS event_count,
         sum(longitude * event_count) / NULLIF(sum(event_count), 0) AS longitude,
         sum(latitude * event_count) / NULLIF(sum(event_count), 0) AS latitude
    FROM clustered
)
SELECT (SELECT count(*) FROM spatial_time)::BIGINT AS spatial_time_rows,
       d.event_count AS discoverable_rows,
       a.event_count AS clustered_event_count,
       (SELECT count(*) FROM spatial_time
         WHERE visibility <> 'PUBLIC' OR status NOT IN ('ACTIVE', 'FULL'))::BIGINT
         AS excluded_before_clustering,
       d.longitude AS direct_discoverable_longitude,
       a.longitude AS clustered_weighted_longitude,
       d.latitude AS direct_discoverable_latitude,
       a.latitude AS clustered_weighted_latitude
  FROM direct d
  CROSS JOIN aggregate_from_clusters a;

DO $assert_privacy$
DECLARE
  v explorer_cluster_privacy_proof%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v FROM explorer_cluster_privacy_proof;

  IF v.excluded_before_clustering <= 0
     OR v.spatial_time_rows <= v.discoverable_rows THEN
    RAISE EXCEPTION 'privacy proof is degenerate; no excluded events were exercised: %',
      row_to_json(v);
  END IF;
  IF v.clustered_event_count <> v.discoverable_rows THEN
    RAISE EXCEPTION 'cluster counts include or omit filtered events: %', row_to_json(v);
  END IF;
  IF abs(v.direct_discoverable_longitude - v.clustered_weighted_longitude) > 1e-10
     OR abs(v.direct_discoverable_latitude - v.clustered_weighted_latitude) > 1e-10 THEN
    RAISE EXCEPTION 'cluster centroids were not derived solely from discoverable events: %',
      row_to_json(v);
  END IF;
END
$assert_privacy$;

\echo ''
\echo '================ BENCHMARK ENVIRONMENT ================'
SELECT current_setting('server_version') AS postgresql_version,
       postgis_full_version() AS postgis_full_version,
       current_setting('max_parallel_workers_per_gather') AS max_parallel_workers_per_gather,
       current_setting('jit') AS jit,
       current_setting('random_page_cost') AS random_page_cost,
       current_setting('effective_cache_size') AS effective_cache_size,
       current_setting('shared_buffers') AS shared_buffers,
       '2 warmups + 15 consecutive measured samples' AS measurement_policy;

\echo ''
\echo '================ EXPLORER SYNTHETIC DATASET ================'
SELECT synthetic_total_events,
       synthetic_discoverable,
       synthetic_dense_events,
       synthetic_dense_discoverable,
       table_total_during_run,
       'deterministic-arithmetic-v1' AS fixture_seed,
       fixture_min_starts_at,
       fixture_max_ends_at,
       status_visibility_counts
  FROM explorer_fixture_context;

\echo ''
\echo '================ EXPLORER BENCHMARK SUMMARY ================'
SELECT scenario,
       case_description,
       samples,
       execution_p50_ms,
       execution_p95_ms,
       execution_min_ms,
       execution_max_ms,
       planning_p50_ms,
       rows_out,
       shared_buffers_p50,
       indexes_used,
       dataset
  FROM explorer_benchmark_results
 ORDER BY scenario;

\echo ''
\echo '================ CLUSTER PRIVACY PROOF ================'
TABLE explorer_cluster_privacy_proof;

\echo ''
\echo '================ CANONICAL INDEX DEFINITION ================'
SELECT pg_get_indexdef(to_regclass('events_discoverable_geo_time_gix')) AS index_definition;

\echo ''
\echo '================ EXACT QUERIES + REPRESENTATIVE PLANS ================'
\pset expanded on
SELECT scenario,
       case_description,
       dataset,
       exact_query,
       jsonb_pretty(representative_plan) AS representative_explain_analyze_buffers
  FROM explorer_benchmark_results
 ORDER BY scenario;
\pset expanded off

ROLLBACK;

-- Restore planner statistics for the permanent rows that existed before the
-- transaction, then prove the synthetic events, host, and trigger-written
-- event_status_history rows all disappeared with the rollback.
ANALYZE events;
ANALYZE event_status_history;
ANALYZE users;

DO $assert_cleanup$
BEGIN
  IF EXISTS (
       SELECT FROM users
        WHERE firebase_uid = 'explorer_bench_postgis_evidence_v1'
     ) THEN
    RAISE EXCEPTION 'Explorer benchmark cleanup failed: fixture host remains';
  END IF;

  IF EXISTS (
       SELECT FROM events
        WHERE title LIKE 'Explorer benchmark fixture %'
     ) THEN
    RAISE EXCEPTION 'Explorer benchmark cleanup failed: fixture events remain';
  END IF;

  IF EXISTS (
       SELECT FROM event_status_history
        WHERE actor_user_id = md5('tripwith.explorer-postgis-benchmark.host.v1')::UUID
     ) THEN
    RAISE EXCEPTION 'Explorer benchmark cleanup failed: fixture audit rows remain';
  END IF;
END
$assert_cleanup$;

\echo ''
\echo 'Explorer benchmark cleanup verified: transaction rolled back; zero fixture rows remain.'
