-- ============================================================================
-- Index shape benchmark
--
-- The design proposed a multicolumn GIST (location, date_range). That was an
-- assumption, not a measurement. This script settles it against real plans on
-- realistic data, comparing composite vs separate GIST indexes for the actual
-- Phase 1 predicates.
--
-- Requires seed-benchmark-data.sql to have been run.
--   psql -d tripwith -v ON_ERROR_STOP=1 -f benchmark-indexes.sql
-- ============================================================================

\pset pager off
SET max_parallel_workers_per_gather = 0;  -- deterministic, comparable plans

-- Runs a query p_iters times under EXPLAIN (ANALYZE, BUFFERS) and reports the
-- median execution time, buffer traffic, and which indexes the planner chose.
CREATE OR REPLACE FUNCTION tw_bench(p_sql TEXT, p_iters INT DEFAULT 9)
RETURNS TABLE (
  median_ms   NUMERIC,
  min_ms      NUMERIC,
  rows_out    BIGINT,
  shared_blks BIGINT,
  indexes_used TEXT
) LANGUAGE plpgsql AS $fn$
DECLARE
  j        JSONB;
  times    NUMERIC[] := '{}';
  i        INT;
  blks     BIGINT;
  nrows    BIGINT;
  idxs     TEXT;
BEGIN
  -- Warm up: exclude first-touch I/O from the comparison.
  EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' || p_sql INTO j;

  FOR i IN 1..p_iters LOOP
    EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' || p_sql INTO j;
    times := times || ((j -> 0 ->> 'Execution Time')::NUMERIC);
  END LOOP;

  blks  := COALESCE((j -> 0 -> 'Plan' ->> 'Shared Hit Blocks')::BIGINT, 0)
         + COALESCE((j -> 0 -> 'Plan' ->> 'Shared Read Blocks')::BIGINT, 0);
  nrows := COALESCE((j -> 0 -> 'Plan' ->> 'Actual Rows')::BIGINT, 0);

  SELECT string_agg(DISTINCT value #>> '{}', ', ')
    INTO idxs
    FROM jsonb_array_elements(jsonb_path_query_array(j, '$.**."Index Name"'));

  RETURN QUERY
  SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY t))::NUMERIC, 3),
         round(min(t)::NUMERIC, 3),
         nrows,
         blks,
         COALESCE(idxs, '(none — sequential scan)')
    FROM unnest(times) t;
END $fn$;


CREATE TEMP TABLE bench_results (
  scenario   TEXT,
  config     TEXT,
  median_ms  NUMERIC,
  min_ms     NUMERIC,
  rows_out   BIGINT,
  shared_blks BIGINT,
  indexes_used TEXT
);

-- ---------------------------------------------------------------------------
-- Scenario 1 — matching candidate generation on trip_segments.
-- "Who else will be within 50km of this hub, overlapping these dates?"
-- ---------------------------------------------------------------------------
DO $s1$
DECLARE q TEXT := 'SELECT s.user_id FROM trip_segments s '
                  'WHERE ST_DWithin(s.location, ST_MakePoint(100.5018, 13.7563)::geography, 50000) '
                  '  AND s.date_range && daterange(DATE ''2026-06-01'', DATE ''2026-06-21'', ''[]'')';
BEGIN
  -- Config A: composite only
  DROP INDEX IF EXISTS trip_segments_location_gix;
  DROP INDEX IF EXISTS trip_segments_daterange_gix;
  CREATE INDEX IF NOT EXISTS trip_segments_loc_range_gix
    ON trip_segments USING GIST (location, date_range);
  ANALYZE trip_segments;
  INSERT INTO bench_results
  SELECT 'segments: geo + date', 'A. composite GIST(location, date_range)', * FROM tw_bench(q);

  -- Config B: separate indexes
  DROP INDEX IF EXISTS trip_segments_loc_range_gix;
  CREATE INDEX trip_segments_location_gix  ON trip_segments USING GIST (location);
  CREATE INDEX trip_segments_daterange_gix ON trip_segments USING GIST (date_range);
  ANALYZE trip_segments;
  INSERT INTO bench_results
  SELECT 'segments: geo + date', 'B. separate GIST(location) + GIST(date_range)', * FROM tw_bench(q);

  -- Config C: spatial only, dates filtered after
  DROP INDEX IF EXISTS trip_segments_daterange_gix;
  ANALYZE trip_segments;
  INSERT INTO bench_results
  SELECT 'segments: geo + date', 'C. GIST(location) only', * FROM tw_bench(q);
END $s1$;

-- ---------------------------------------------------------------------------
-- Scenario 2 — spatial predicate alone (Explorer pan with no date filter).
-- ---------------------------------------------------------------------------
DO $s2$
DECLARE q TEXT := 'SELECT s.user_id FROM trip_segments s '
                  'WHERE ST_DWithin(s.location, ST_MakePoint(100.5018, 13.7563)::geography, 50000)';
BEGIN
  DROP INDEX IF EXISTS trip_segments_location_gix;
  CREATE INDEX trip_segments_loc_range_gix ON trip_segments USING GIST (location, date_range);
  ANALYZE trip_segments;
  INSERT INTO bench_results
  SELECT 'segments: geo only', 'A. composite GIST(location, date_range)', * FROM tw_bench(q);

  DROP INDEX IF EXISTS trip_segments_loc_range_gix;
  CREATE INDEX trip_segments_location_gix ON trip_segments USING GIST (location);
  ANALYZE trip_segments;
  INSERT INTO bench_results
  SELECT 'segments: geo only', 'B. GIST(location)', * FROM tw_bench(q);
END $s2$;

-- ---------------------------------------------------------------------------
-- Scenario 3 — Explorer on events: partial composite vs partial spatial.
-- ---------------------------------------------------------------------------
DO $s3$
DECLARE q TEXT := 'SELECT e.id FROM events e '
                  'WHERE e.visibility = ''PUBLIC'' AND e.status IN (''ACTIVE'', ''FULL'') '
                  '  AND ST_DWithin(e.meeting_point, ST_MakePoint(100.5018, 13.7563)::geography, 20000) '
                  '  AND e.time_range && tstzrange(TIMESTAMPTZ ''2026-06-01'', TIMESTAMPTZ ''2026-06-08'')';
BEGIN
  DROP INDEX IF EXISTS events_discoverable_gix;
  ANALYZE events;
  INSERT INTO bench_results
  SELECT 'events: explorer', 'A. partial composite GIST(meeting_point, time_range)', * FROM tw_bench(q);

  DROP INDEX IF EXISTS events_discoverable_geo_time_gix;
  CREATE INDEX events_discoverable_gix ON events USING GIST (meeting_point)
    WHERE visibility = 'PUBLIC' AND status IN ('ACTIVE', 'FULL');
  ANALYZE events;
  INSERT INTO bench_results
  SELECT 'events: explorer', 'B. partial GIST(meeting_point)', * FROM tw_bench(q);

  -- Restore both so the comparison does not leave the schema degraded.
  CREATE INDEX IF NOT EXISTS events_discoverable_geo_time_gix
    ON events USING GIST (meeting_point, time_range)
    WHERE visibility = 'PUBLIC' AND status IN ('ACTIVE', 'FULL');
  ANALYZE events;
END $s3$;

-- ---------------------------------------------------------------------------
-- Index sizes
-- ---------------------------------------------------------------------------
-- Restore the CANONICAL index set defined by the migration, so a benchmark run
-- never leaves the database in an experimental shape.
DROP INDEX IF EXISTS trip_segments_location_gix;
DROP INDEX IF EXISTS trip_segments_daterange_gix;
DROP INDEX IF EXISTS events_discoverable_gix;
CREATE INDEX IF NOT EXISTS trip_segments_loc_range_gix
  ON trip_segments USING GIST (location, date_range);
CREATE INDEX IF NOT EXISTS events_discoverable_geo_time_gix
  ON events USING GIST (meeting_point, time_range)
  WHERE visibility = 'PUBLIC' AND status IN ('ACTIVE', 'FULL');
ANALYZE trip_segments;
ANALYZE events;

\echo ''
\echo '=================== BENCHMARK RESULTS ==================='
SELECT scenario, config, median_ms, min_ms, rows_out, shared_blks, indexes_used
FROM bench_results
ORDER BY scenario, config;

\echo ''
\echo '=================== INDEX SIZES ==================='
SELECT indexrelname AS index,
       pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE indexrelname IN (
  'trip_segments_location_gix', 'trip_segments_daterange_gix',
  'trip_segments_loc_range_gix', 'events_discoverable_gix',
  'events_discoverable_geo_time_gix'
)
ORDER BY pg_relation_size(indexrelid) DESC;
