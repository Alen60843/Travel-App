import { Injectable } from '@nestjs/common';

import { geoPoint, type GeoPoint } from './geo-point';

/**
 * A composable SQL condition plus its named parameters, meant to be dropped
 * straight into a TypeORM QueryBuilder:
 *
 *   qb.andWhere(fragment.sql, fragment.parameters)
 *
 * `paramPrefix` exists so two fragments (e.g. two different radius filters
 * in the same query) never collide on parameter names.
 */
export interface SqlFragment {
  readonly sql: string;
  readonly parameters: Record<string, unknown>;
}

export interface LatLng {
  readonly latitude: number;
  readonly longitude: number;
}

/**
 * The single home for PostGIS SQL (§ owning comment in the initial schema:
 * "GEOGRAPHY(POINT,4326) for anything measured in metres").
 *
 * This is deliberately thin and deliberately NOT a query-building DSL: every
 * method returns a raw SQL fragment with the PostGIS function calls visible
 * in the string, because hiding ST_DWithin behind an ORM abstraction is what
 * makes spatial bugs (wrong SRID, swapped lat/lng, distance vs. geography
 * semantics) hard to spot in review. Callers compose these into their own
 * QueryBuilder chains; this class holds no repository or entity knowledge
 * and issues no queries itself — Explorer/Matching-specific predicates
 * belong in later phases, not here.
 *
 * `column` must be a trusted, code-controlled SQL identifier (e.g.
 * `'e.meeting_point'`) — it is interpolated directly into the fragment, not
 * bound as a parameter (PostgreSQL cannot parameterise identifiers). Never
 * pass user input as `column`.
 */
@Injectable()
export class GeoService {
  /** Builds a GEOGRAPHY(POINT,4326) parameter value from lat/lng for inserts/updates. */
  point(latitude: number, longitude: number): GeoPoint {
    return geoPoint(latitude, longitude);
  }

  /**
   * `ST_DWithin(column, point, radiusMeters)` on a geography column: true
   * great-circle distance in metres, and index-aware — PostGIS evaluates
   * ST_DWithin on geography using the column's GIST index directly (it does
   * its own bounding-box pre-filter internally), so this is the predicate
   * the schema's composite spatial indexes
   * (trip_segments_loc_range_gix, events_discoverable_geo_time_gix,
   * providers_discoverable_gix) were measured against — see the benchmark
   * comments in the initial migration.
   */
  withinRadius(
    column: string,
    center: LatLng,
    radiusMeters: number,
    paramPrefix = 'geoRadius',
  ): SqlFragment {
    if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) {
      throw new RangeError(`radiusMeters must be a positive finite number, got ${radiusMeters}`);
    }
    const point = geoPoint(center.latitude, center.longitude);
    const lngParam = `${paramPrefix}Lng`;
    const latParam = `${paramPrefix}Lat`;
    const radiusParam = `${paramPrefix}Meters`;
    return {
      sql: `ST_DWithin(${column}, ST_SetSRID(ST_MakePoint(:${lngParam}, :${latParam}), 4326)::geography, :${radiusParam})`,
      parameters: {
        [lngParam]: point.coordinates[0],
        [latParam]: point.coordinates[1],
        [radiusParam]: radiusMeters,
      },
    };
  }

  /**
   * `ST_Intersects(column, envelope)` against a lat/lng bounding box. Cheaper
   * than ST_DWithin when a rectangular pre-filter is sufficient (e.g. "within
   * the current map viewport"), but note it is NOT a circle — corners of the
   * box are farther from the center than its edges. Does not handle a box
   * crossing the antimeridian (sw.longitude > ne.longitude is rejected
   * rather than silently wrapping); callers spanning it must issue two
   * queries.
   */
  withinBoundingBox(
    column: string,
    southWest: LatLng,
    northEast: LatLng,
    paramPrefix = 'geoBbox',
  ): SqlFragment {
    if (southWest.longitude >= northEast.longitude || southWest.latitude >= northEast.latitude) {
      throw new RangeError(
        'southWest must be strictly less than northEast on both axes ' +
          '(antimeridian-crossing boxes are not supported — issue two queries instead)',
      );
    }
    const minLng = `${paramPrefix}MinLng`;
    const minLat = `${paramPrefix}MinLat`;
    const maxLng = `${paramPrefix}MaxLng`;
    const maxLat = `${paramPrefix}MaxLat`;
    return {
      sql: `ST_Intersects(${column}, ST_MakeEnvelope(:${minLng}, :${minLat}, :${maxLng}, :${maxLat}, 4326)::geography)`,
      parameters: {
        [minLng]: southWest.longitude,
        [minLat]: southWest.latitude,
        [maxLng]: northEast.longitude,
        [maxLat]: northEast.latitude,
      },
    };
  }
}
