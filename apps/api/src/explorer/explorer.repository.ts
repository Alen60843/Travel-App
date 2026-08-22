import { EventStatus } from '@tripwith/shared';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import { GeoService, type SqlFragment } from '../database/geo';
import { ExplorerQueryTooBroadError } from './explorer.errors';
import type {
  ExplorerClusterCategorySummary,
  ExplorerClusterMarker,
  ExplorerDiscoveryResult,
  ExplorerEventPin,
  ExplorerMarker,
  NormalizedExplorerQuery,
} from './explorer.types';

interface ExplorerRawMarker {
  readonly resultEventCount: string | number;
  readonly kind: 'event' | 'cluster' | null;
  readonly markerId: string | null;
  readonly title: string | null;
  readonly status: EventStatus | null;
  readonly latitude: string | number | null;
  readonly longitude: string | number | null;
  readonly categoryCode: string | null;
  readonly categoryLabel: string | null;
  readonly categoryIcon: string | null;
  readonly startsAt: Date | string | null;
  readonly endsAt: Date | string | null;
  readonly meetingPointLabel: string | null;
  readonly clusterEventCount: string | number | null;
  readonly categories: unknown;
}

/**
 * The SQL aggregation path safely handles the benchmark's 5,500-event dense
 * viewport. This higher ceiling is only a final denial-of-service guard: the
 * materialized discoverable CTE stops after one extra row and the repository
 * fails closed instead of returning partial cluster counts.
 */
export const EXPLORER_AGGREGATION_LIMIT = 100_000;
export const EXPLORER_CLUSTER_THROUGH_ZOOM = 14;
// Deliberately below every WGS84 curvature radius. This slightly enlarges the
// spherical radius envelope so it conservatively contains ST_DWithin's default
// spheroidal geography result, including near-pole and dateline cases.
const CONSERVATIVE_EARTH_RADIUS_METERS = 6_300_000;

const ADAPTIVE_CLUSTER_SQL = `
WITH discoverable AS MATERIALIZED (
  SELECT event.id AS event_id,
         event.title,
         event.status,
         ST_Y(event.meeting_point::geometry) AS latitude,
         ST_X(event.meeting_point::geometry) AS longitude,
         category.code AS category_code,
         category.label AS category_label,
         category.icon AS category_icon,
         event.starts_at,
         event.ends_at,
         event.meeting_point_label
    FROM events event
    JOIN event_categories category ON category.id = event.category_id
   WHERE event.visibility = 'PUBLIC'
     AND event.status IN ('ACTIVE', 'FULL')
     AND event.time_range && tstzrange(:windowStart, :windowEnd, '[)')
     AND :spatialPredicate
     :categoryPredicate
   LIMIT :candidateLimitPlusOne
), discovery_stats AS (
  SELECT count(*)::INT AS event_count,
         count(*) <= :markerLimit AND :zoom > :clusterThroughZoom AS return_pins,
         count(*) <= :candidateLimit AS within_candidate_limit
    FROM discoverable
), bucketed AS MATERIALIZED (
  SELECT
         LEAST(
           ceil(360.0 / :clusterCellDegrees)::INT - 1,
           GREATEST(
             0,
             floor((discoverable.longitude + 180.0) /
                   :clusterCellDegrees)::INT
           )
         ) AS bucket_x,
         LEAST(
           GREATEST(
             0,
             ceil(180.0 / :clusterCellDegrees)::INT - 1
           ),
           GREATEST(
             0,
             floor((discoverable.latitude + 90.0) /
                   :clusterCellDegrees)::INT
           )
         ) AS bucket_y,
         discoverable.*
    FROM discoverable
    CROSS JOIN discovery_stats
   WHERE NOT discovery_stats.return_pins
     AND discovery_stats.within_candidate_limit
), category_counts AS (
  SELECT bucket_x,
         bucket_y,
         category_code,
         count(*)::INT AS event_count
    FROM bucketed
   GROUP BY bucket_x, bucket_y, category_code
), category_summaries AS (
  SELECT bucket_x,
         bucket_y,
         jsonb_agg(
           jsonb_build_object('code', category_code, 'eventCount', event_count)
           ORDER BY event_count DESC, category_code ASC
         ) AS categories
    FROM category_counts
   GROUP BY bucket_x, bucket_y
), clustered AS (
  SELECT bucketed.bucket_x,
         bucketed.bucket_y,
         round(avg(bucketed.latitude)::NUMERIC, 6)::DOUBLE PRECISION AS latitude,
         round(
           degrees(
             atan2(
               avg(sin(radians(bucketed.longitude))),
               avg(cos(radians(bucketed.longitude)))
             )
           )::NUMERIC,
           6
         )::DOUBLE PRECISION AS longitude,
         count(*)::INT AS event_count,
         min(bucketed.starts_at) AS first_starts_at
    FROM bucketed
   GROUP BY bucketed.bucket_x,
            bucketed.bucket_y
), marker_rows AS (
  SELECT discoverable.starts_at AS sort_starts_at,
         discoverable.event_id::TEXT AS sort_id,
         'event'::TEXT AS kind,
         discoverable.event_id::TEXT AS marker_id,
         discoverable.title,
         discoverable.status::TEXT AS status,
         discoverable.latitude,
         discoverable.longitude,
         discoverable.category_code,
         discoverable.category_label,
         discoverable.category_icon,
         discoverable.starts_at,
         discoverable.ends_at,
         discoverable.meeting_point_label,
         NULL::INT AS cluster_event_count,
         NULL::JSONB AS categories
    FROM discoverable
    CROSS JOIN discovery_stats
   WHERE discovery_stats.return_pins

  UNION ALL

  SELECT clustered.first_starts_at AS sort_starts_at,
         'cluster:z' || :zoom || ':s' || :clusterScale ||
           ':x' || clustered.bucket_x || ':y' || clustered.bucket_y AS sort_id,
         'cluster'::TEXT AS kind,
         'cluster:z' || :zoom || ':s' || :clusterScale ||
           ':x' || clustered.bucket_x || ':y' || clustered.bucket_y AS marker_id,
         NULL::TEXT AS title,
         NULL::TEXT AS status,
         clustered.latitude,
         clustered.longitude,
         NULL::TEXT AS category_code,
         NULL::TEXT AS category_label,
         NULL::TEXT AS category_icon,
         NULL::TIMESTAMPTZ AS starts_at,
         NULL::TIMESTAMPTZ AS ends_at,
         NULL::TEXT AS meeting_point_label,
         clustered.event_count AS cluster_event_count,
         category_summaries.categories
    FROM clustered
    JOIN category_summaries USING (bucket_x, bucket_y)
)
SELECT discovery_stats.event_count AS "resultEventCount",
       marker_rows.kind AS kind,
       marker_rows.marker_id AS "markerId",
       marker_rows.title AS title,
       marker_rows.status AS status,
       marker_rows.latitude AS latitude,
       marker_rows.longitude AS longitude,
       marker_rows.category_code AS "categoryCode",
       marker_rows.category_label AS "categoryLabel",
       marker_rows.category_icon AS "categoryIcon",
       marker_rows.starts_at AS "startsAt",
       marker_rows.ends_at AS "endsAt",
       marker_rows.meeting_point_label AS "meetingPointLabel",
       marker_rows.cluster_event_count AS "clusterEventCount",
       marker_rows.categories AS categories
  FROM discovery_stats
  LEFT JOIN marker_rows ON TRUE
 ORDER BY marker_rows.sort_starts_at ASC, marker_rows.sort_id ASC
 LIMIT :markerLimit
`;

interface ExplorerDatabase {
  query<T = unknown>(query: string, parameters?: unknown[]): Promise<T>;
}

/**
 * Explorer owns the event-specific SQL. GeoService supplies the shared,
 * index-aware spatial predicates, and this repository composes them with the
 * exact partial-index visibility/status predicate and generated time_range.
 *
 * Privacy filtering is a MATERIALIZED CTE boundary before any bucket, count,
 * centroid, cluster ID, or category summary is computed. A single adaptive
 * query returns individual pins only above zoom 14 when the complete result
 * fits the requested marker limit; every other result is grouped in SQL at
 * the finest power-of-two grid scale producing at most that limit. Thus dense
 * views transfer bounded aggregates instead of thousands of full event rows.
 */
@Injectable()
export class ExplorerRepository {
  constructor(
    @InjectDataSource() private readonly dataSource: ExplorerDatabase,
    private readonly geo: GeoService,
  ) {}

  async findKnownCategoryCodes(codes: readonly string[]): Promise<readonly string[]> {
    if (codes.length === 0) return [];
    const rows = await this.dataSource.query<{ code: string }[]>(
      `SELECT code
         FROM event_categories
        WHERE code = ANY($1::text[])
        ORDER BY code ASC
        LIMIT 20`,
      [[...codes]],
    );
    return rows.map(({ code }) => code);
  }

  async findDiscoverableMarkers(query: NormalizedExplorerQuery): Promise<ExplorerDiscoveryResult> {
    const spatial = this.spatialPredicate(query);
    const clusterScale = explorerClusterScale(query);
    const categoryPredicate = query.categoryCodes.length > 0
      ? 'AND category.code = ANY(:categoryCodes::text[])'
      : '';
    const namedSql = ADAPTIVE_CLUSTER_SQL
      .replace(':spatialPredicate', spatial.sql)
      .replace(':categoryPredicate', categoryPredicate);
    const { sql, values } = bindNamedParameters(namedSql, {
      ...spatial.parameters,
      windowStart: query.windowStart,
      windowEnd: query.windowEnd,
      categoryCodes: [...query.categoryCodes],
      markerLimit: query.limit,
      zoom: query.zoom,
      clusterThroughZoom: EXPLORER_CLUSTER_THROUGH_ZOOM,
      clusterScale,
      clusterCellDegrees: 90 / 2 ** query.zoom * clusterScale,
      candidateLimit: EXPLORER_AGGREGATION_LIMIT,
      candidateLimitPlusOne: EXPLORER_AGGREGATION_LIMIT + 1,
    });
    const rows = await this.dataSource.query<ExplorerRawMarker[]>(sql, values);
    if (rows.length === 0) throw new TypeError('Explorer query returned no discovery_stats row');

    const eventCount = finiteInteger(rows[0]!.resultEventCount, 'result event count');
    if (eventCount > EXPLORER_AGGREGATION_LIMIT) throw new ExplorerQueryTooBroadError();
    const markers = rows
      .filter((row): row is ExplorerRawMarker & { kind: 'event' | 'cluster' } => row.kind !== null)
      .map(toMarker);
    if (markers.length > query.limit) {
      throw new TypeError('Explorer query returned more markers than requested');
    }
    return { eventCount, markers };
  }

  private spatialPredicate(query: NormalizedExplorerQuery): SqlFragment {
    if (query.spatial.kind === 'radius') {
      return this.geo.withinRadius(
        'event.meeting_point',
        query.spatial.center,
        query.spatial.radiusMeters,
        'explorerRadius',
      );
    }

    const { south, west, north, east, crossesAntimeridian } = query.spatial;
    if (!crossesAntimeridian) {
      return this.geo.withinBoundingBox(
        'event.meeting_point',
        { latitude: south, longitude: west },
        { latitude: north, longitude: east },
        'explorerViewport',
      );
    }

    // GeoService deliberately rejects crossing boxes. Compose its two safe
    // halves into one OR predicate, avoiding duplicate rows at the shared
    // meridian while retaining one materialized privacy boundary.
    const westHalf = this.geo.withinBoundingBox(
      'event.meeting_point',
      { latitude: south, longitude: west },
      { latitude: north, longitude: 180 },
      'explorerViewportWest',
    );
    const eastHalf = this.geo.withinBoundingBox(
      'event.meeting_point',
      { latitude: south, longitude: -180 },
      { latitude: north, longitude: east },
      'explorerViewportEast',
    );
    return {
      sql: `(${westHalf.sql} OR ${eastHalf.sql})`,
      parameters: { ...westHalf.parameters, ...eastHalf.parameters },
    };
  }
}

/**
 * Selects a deterministic power-of-two grid scale from request geometry, not
 * event density. The conservative bounding extent is guaranteed to intersect
 * at most markerLimit cells, so SQL can aggregate each candidate once and the
 * requested limit is a real output bound without sampling or partial counts.
 */
export function explorerClusterScale(query: NormalizedExplorerQuery): number {
  const baseCellDegrees = 90 / 2 ** query.zoom;
  const extent = clusterExtent(query);
  let scale = 1;
  while (extentCellCount(extent, baseCellDegrees * scale) > query.limit) scale *= 2;
  return scale;
}

interface ClusterExtent {
  readonly south: number;
  readonly north: number;
  readonly longitudeRanges: readonly (readonly [number, number])[];
}

function clusterExtent(query: NormalizedExplorerQuery): ClusterExtent {
  if (query.spatial.kind === 'viewport') {
    const { south, north, west, east, crossesAntimeridian } = query.spatial;
    return {
      south,
      north,
      longitudeRanges: crossesAntimeridian
        ? [[west, 180], [-180, east]]
        : [[west, east]],
    };
  }

  const angularRadius = query.spatial.radiusMeters / CONSERVATIVE_EARTH_RADIUS_METERS;
  const latitudeRadians = query.spatial.center.latitude * Math.PI / 180;
  const latitudeDelta = angularRadius * 180 / Math.PI;
  const south = Math.max(-90, query.spatial.center.latitude - latitudeDelta);
  const north = Math.min(90, query.spatial.center.latitude + latitudeDelta);
  if (angularRadius >= Math.PI / 2 - Math.abs(latitudeRadians)) {
    return { south, north, longitudeRanges: [[-180, 180]] };
  }

  const longitudeDelta = Math.asin(Math.sin(angularRadius) / Math.cos(latitudeRadians))
    * 180 / Math.PI;
  const west = query.spatial.center.longitude - longitudeDelta;
  const east = query.spatial.center.longitude + longitudeDelta;
  if (west < -180) {
    return { south, north, longitudeRanges: [[west + 360, 180], [-180, east]] };
  }
  if (east > 180) {
    return { south, north, longitudeRanges: [[west, 180], [-180, east - 360]] };
  }
  return { south, north, longitudeRanges: [[west, east]] };
}

function extentCellCount(extent: ClusterExtent, cellDegrees: number): number {
  const latitudeCells = intervalCellRange(extent.south, extent.north, -90, 180, cellDegrees);
  const longitudeRanges = extent.longitudeRanges
    .map(([west, east]) => intervalCellRange(west, east, -180, 360, cellDegrees))
    .sort((left, right) => left[0] - right[0]);
  let longitudeCells = 0;
  let rangeStart = longitudeRanges[0]![0];
  let rangeEnd = longitudeRanges[0]![1];
  for (const [start, end] of longitudeRanges.slice(1)) {
    if (start <= rangeEnd + 1) {
      rangeEnd = Math.max(rangeEnd, end);
    } else {
      longitudeCells += rangeEnd - rangeStart + 1;
      rangeStart = start;
      rangeEnd = end;
    }
  }
  longitudeCells += rangeEnd - rangeStart + 1;
  return (latitudeCells[1] - latitudeCells[0] + 1) * longitudeCells;
}

function intervalCellRange(
  start: number,
  end: number,
  origin: number,
  span: number,
  cellDegrees: number,
): readonly [number, number] {
  const cellCount = Math.max(1, Math.ceil(span / cellDegrees));
  const index = (coordinate: number) => Math.min(
    cellCount - 1,
    Math.max(0, Math.floor((coordinate - origin) / cellDegrees)),
  );
  return [index(start), index(end)];
}

function bindNamedParameters(
  namedSql: string,
  parameters: Readonly<Record<string, unknown>>,
): { readonly sql: string; readonly values: unknown[] } {
  const positions = new Map<string, number>();
  const values: unknown[] = [];
  const sql = namedSql.replace(
    /(?<![:A-Za-z0-9_']):([A-Za-z][A-Za-z0-9_]*)/g,
    (_match, name: string) => {
      if (!Object.prototype.hasOwnProperty.call(parameters, name)) {
        throw new TypeError(`Explorer SQL parameter ${name} is missing`);
      }
      let position = positions.get(name);
      if (position === undefined) {
        values.push(parameters[name]);
        position = values.length;
        positions.set(name, position);
      }
      return `$${position}`;
    },
  );
  return { sql, values };
}

function finiteCoordinate(value: string | number | null, name: string): number {
  const result = Number(value);
  if (value === null || !Number.isFinite(result)) {
    throw new TypeError(`Explorer query returned invalid ${name}`);
  }
  return result;
}

function finiteInteger(value: string | number | null, name: string): number {
  const result = finiteCoordinate(value, name);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TypeError(`Explorer query returned invalid ${name}`);
  }
  return result;
}

function requiredString(value: string | null, name: string): string {
  if (value === null || value.length === 0) {
    throw new TypeError(`Explorer query returned invalid ${name}`);
  }
  return value;
}

function isoInstant(value: Date | string | null, name: string): string {
  if (value === null) throw new TypeError(`Explorer query returned invalid ${name}`);
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`Explorer query returned invalid ${name}`);
  return parsed.toISOString();
}

function toMarker(row: ExplorerRawMarker & { kind: 'event' | 'cluster' }): ExplorerMarker {
  return row.kind === 'event' ? toEventPin(row) : toClusterMarker(row);
}

function toEventPin(row: ExplorerRawMarker): ExplorerEventPin {
  return {
    kind: 'event',
    id: requiredString(row.markerId, 'event ID'),
    title: requiredString(row.title, 'title'),
    status: requiredString(row.status, 'status') as EventStatus,
    coordinate: {
      latitude: finiteCoordinate(row.latitude, 'latitude'),
      longitude: finiteCoordinate(row.longitude, 'longitude'),
    },
    category: {
      code: requiredString(row.categoryCode, 'category code'),
      label: requiredString(row.categoryLabel, 'category label'),
      icon: row.categoryIcon,
    },
    startsAt: isoInstant(row.startsAt, 'startsAt'),
    endsAt: isoInstant(row.endsAt, 'endsAt'),
    meetingPointLabel: row.meetingPointLabel,
  };
}

function toClusterMarker(row: ExplorerRawMarker): ExplorerClusterMarker {
  return {
    kind: 'cluster',
    id: requiredString(row.markerId, 'cluster ID'),
    coordinate: {
      latitude: finiteCoordinate(row.latitude, 'cluster latitude'),
      longitude: finiteCoordinate(row.longitude, 'cluster longitude'),
    },
    eventCount: finiteInteger(row.clusterEventCount, 'cluster event count'),
    categories: categorySummary(row.categories),
  };
}

function categorySummary(value: unknown): readonly ExplorerClusterCategorySummary[] {
  if (!Array.isArray(value)) throw new TypeError('Explorer query returned invalid cluster categories');
  return value.map((entry) => {
    if (entry === null || typeof entry !== 'object') {
      throw new TypeError('Explorer query returned invalid cluster category');
    }
    const code = 'code' in entry ? entry.code : null;
    const eventCount = 'eventCount' in entry ? entry.eventCount : null;
    return {
      code: requiredString(typeof code === 'string' ? code : null, 'cluster category code'),
      eventCount: finiteInteger(
        typeof eventCount === 'string' || typeof eventCount === 'number' ? eventCount : null,
        'cluster category event count',
      ),
    };
  });
}
