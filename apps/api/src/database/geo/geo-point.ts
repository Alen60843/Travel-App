/**
 * Application-side representation of a `geography(Point,4326)` column.
 *
 * TypeORM's postgres driver round-trips spatial columns through GeoJSON: on
 * write it wraps the parameter as `ST_SetSRID(ST_GeomFromGeoJSON($n), srid)`,
 * and on read (via QueryBuilder/find*, which the Repository API uses
 * internally) it wraps the selection as `ST_AsGeoJSON(col)::json`. A GeoJSON
 * Point is therefore the representation that survives both directions with
 * zero custom (de)serialisation — anything else would need a transformer
 * written per spatial column, which is exactly the scattering this module
 * exists to prevent. See PostgresDriver.preparePersistentValue and
 * SelectQueryBuilder's spatial-column handling for the mechanism.
 *
 * Coordinate order is [longitude, latitude], per GeoJSON (RFC 7946) — NOT
 * [lat, lng]. This is the single most common PostGIS integration bug; every
 * call site that builds one of these must respect it.
 */
export interface GeoPoint {
  readonly type: 'Point';
  readonly coordinates: readonly [longitude: number, latitude: number];
}

/**
 * Builds a `GeoPoint` from human-order (latitude, longitude) inputs — the
 * order every mapping UI, form and GPS API uses — and validates range so a
 * transposed lat/lng argument fails at the call site instead of silently
 * writing a point in the wrong hemisphere.
 */
export function geoPoint(latitude: number, longitude: number): GeoPoint {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new RangeError(`latitude out of range [-90, 90]: ${latitude}`);
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new RangeError(`longitude out of range [-180, 180]: ${longitude}`);
  }
  return { type: 'Point', coordinates: [longitude, latitude] };
}
