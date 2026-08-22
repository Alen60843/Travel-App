import type { GetExplorerEventsQueryDto } from './dto/get-explorer-events-query.dto';
import { ExplorerQueryInvalidError } from './explorer.errors';
import type { ExplorerRadius, ExplorerViewport, NormalizedExplorerQuery } from './explorer.types';

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1_000;
const MAX_VIEWPORT_LATITUDE_SPAN = 60;
const MAX_VIEWPORT_LONGITUDE_SPAN = 120;
const DEFAULT_LIMIT = 100;
const CATEGORY_CODE = /^[a-z0-9_]{2,40}$/;

function allDefined(values: readonly unknown[]): boolean {
  return values.every((value) => value !== undefined);
}

function someDefined(values: readonly unknown[]): boolean {
  return values.some((value) => value !== undefined);
}

function assertFinite(value: number, field: string): void {
  if (!Number.isFinite(value)) {
    throw new ExplorerQueryInvalidError(`${field} must be a finite number.`, field);
  }
}

function normalizeViewport(query: GetExplorerEventsQueryDto): ExplorerViewport | null {
  const values = [query.south, query.west, query.north, query.east] as const;
  if (!someDefined(values)) return null;
  if (!allDefined(values)) {
    throw new ExplorerQueryInvalidError(
      'A viewport requires south, west, north, and east.',
      'viewport',
    );
  }
  const [south, inputWest, north, inputEast] = values as readonly [number, number, number, number];
  assertFinite(south, 'south');
  assertFinite(inputWest, 'west');
  assertFinite(north, 'north');
  assertFinite(inputEast, 'east');
  if (
    south < -90 ||
    north > 90 ||
    inputWest < -180 ||
    inputWest > 180 ||
    inputEast < -180 ||
    inputEast > 180
  ) {
    throw new ExplorerQueryInvalidError('Viewport coordinates are outside WGS84 bounds.', 'viewport');
  }
  if (south >= north) {
    throw new ExplorerQueryInvalidError('south must be strictly less than north.', 'viewport');
  }
  // Longitude +180 and -180 name the same meridian. Canonicalizing endpoints
  // avoids handing GeoService a zero-width half during antimeridian splitting.
  const west = inputWest === 180 ? -180 : inputWest;
  const east = inputEast === -180 ? 180 : inputEast;
  if (west === east) {
    throw new ExplorerQueryInvalidError('west and east must describe a non-zero viewport.', 'viewport');
  }
  const longitudeSpan = west < east ? east - west : 180 - west + (east + 180);
  if (
    north - south > MAX_VIEWPORT_LATITUDE_SPAN ||
    longitudeSpan > MAX_VIEWPORT_LONGITUDE_SPAN
  ) {
    throw new ExplorerQueryInvalidError(
      `Viewport span must not exceed ${MAX_VIEWPORT_LATITUDE_SPAN}° latitude or ` +
        `${MAX_VIEWPORT_LONGITUDE_SPAN}° longitude.`,
      'viewport',
    );
  }
  return { kind: 'viewport', south, west, north, east, crossesAntimeridian: west > east };
}

function normalizeRadius(query: GetExplorerEventsQueryDto): ExplorerRadius | null {
  const values = [query.centerLatitude, query.centerLongitude, query.radiusMeters] as const;
  if (!someDefined(values)) return null;
  if (!allDefined(values)) {
    throw new ExplorerQueryInvalidError(
      'A radius query requires centerLatitude, centerLongitude, and radiusMeters.',
      'radiusMeters',
    );
  }
  const [latitude, longitude, radiusMeters] = values as readonly [number, number, number];
  assertFinite(latitude, 'centerLatitude');
  assertFinite(longitude, 'centerLongitude');
  assertFinite(radiusMeters, 'radiusMeters');
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new ExplorerQueryInvalidError('Radius center is outside WGS84 bounds.', 'centerLatitude');
  }
  if (!Number.isInteger(radiusMeters) || radiusMeters < 100 || radiusMeters > 500_000) {
    throw new ExplorerQueryInvalidError(
      'radiusMeters must be an integer between 100 and 500000.',
      'radiusMeters',
    );
  }
  return { kind: 'radius', center: { latitude, longitude }, radiusMeters };
}

function parseInstant(value: string, field: string): Date {
  // Requiring an explicit Z/offset prevents a deployment timezone from
  // changing query meaning. The DTO applies the same transport-level rule.
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new ExplorerQueryInvalidError(`${field} must include a UTC offset.`, field);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ExplorerQueryInvalidError(`${field} must be a valid timestamp.`, field);
  }
  return parsed;
}

export function normalizeExplorerQuery(
  query: GetExplorerEventsQueryDto,
  now: Date,
): NormalizedExplorerQuery {
  if (!Number.isFinite(now.getTime())) throw new RangeError('now must be a valid Date');

  const viewport = normalizeViewport(query);
  const radius = normalizeRadius(query);
  if ((viewport === null) === (radius === null)) {
    throw new ExplorerQueryInvalidError(
      'Provide exactly one complete spatial query: viewport or radius.',
      'spatialQuery',
    );
  }

  if (!Number.isInteger(query.zoom) || query.zoom < 1 || query.zoom > 22) {
    throw new ExplorerQueryInvalidError('zoom must be an integer between 1 and 22.', 'zoom');
  }
  const limit = query.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new ExplorerQueryInvalidError('limit must be an integer between 1 and 200.', 'limit');
  }

  const hasStart = query.windowStart !== undefined;
  const hasEnd = query.windowEnd !== undefined;
  if (hasStart !== hasEnd) {
    throw new ExplorerQueryInvalidError(
      'windowStart and windowEnd must be supplied together.',
      'windowStart',
    );
  }

  let requestedStart = now;
  let windowEnd = new Date(now.getTime() + DEFAULT_WINDOW_MS);
  if (query.windowStart !== undefined && query.windowEnd !== undefined) {
    requestedStart = parseInstant(query.windowStart, 'windowStart');
    windowEnd = parseInstant(query.windowEnd, 'windowEnd');
    if (windowEnd.getTime() <= requestedStart.getTime()) {
      throw new ExplorerQueryInvalidError('windowEnd must be after windowStart.', 'windowEnd');
    }
    if (windowEnd.getTime() - requestedStart.getTime() > MAX_WINDOW_MS) {
      throw new ExplorerQueryInvalidError('The requested time window must not exceed 90 days.', 'windowEnd');
    }
    if (windowEnd.getTime() <= now.getTime()) {
      throw new ExplorerQueryInvalidError('The requested time window must include upcoming time.', 'windowEnd');
    }
  }

  // Past time never expands discovery. Clamping still includes an ACTIVE/FULL
  // event that started earlier but overlaps the current instant.
  const windowStart = new Date(Math.max(requestedStart.getTime(), now.getTime()));
  const categoryCodes = query.categoryCodes ?? [];
  if (
    categoryCodes.length > 20 ||
    new Set(categoryCodes).size !== categoryCodes.length ||
    categoryCodes.some((code) => typeof code !== 'string' || !CATEGORY_CODE.test(code))
  ) {
    throw new ExplorerQueryInvalidError(
      'categoryCodes must contain at most 20 unique event category codes.',
      'categoryCodes',
    );
  }
  const sortedCategoryCodes = [...categoryCodes].sort(compareText);

  return {
    spatial: viewport ?? radius!,
    windowStart,
    windowEnd,
    categoryCodes: sortedCategoryCodes,
    zoom: query.zoom,
    limit,
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
