import { EventStatus } from '@tripwith/shared';

import { GeoService } from '../database/geo';
import {
  EXPLORER_AGGREGATION_LIMIT,
  ExplorerRepository,
  explorerClusterScale,
} from './explorer.repository';
import type { NormalizedExplorerQuery } from './explorer.types';

interface DatabaseDouble {
  readonly query: jest.Mock;
}

function databaseWithRows(rows: readonly Record<string, unknown>[]): DatabaseDouble {
  return { query: jest.fn().mockResolvedValue(rows) };
}

function rawEvent(id: string, startsAt: string, longitude: number) {
  return {
    resultEventCount: 1,
    kind: 'event',
    markerId: id,
    title: `Event ${id}`,
    status: EventStatus.Active,
    latitude: '0',
    longitude: String(longitude),
    categoryCode: 'trek',
    categoryLabel: 'Trek',
    categoryIcon: 'mountain',
    startsAt,
    endsAt: '2090-01-02T01:00:00Z',
    meetingPointLabel: null,
    clusterEventCount: null,
    categories: null,
  };
}

function rawCluster(eventCount = 5_500) {
  return {
    resultEventCount: eventCount,
    kind: 'cluster',
    markerId: 'cluster:z8:s1:x518:y394',
    title: null,
    status: null,
    latitude: '48.8566',
    longitude: '2.3522',
    categoryCode: null,
    categoryLabel: null,
    categoryIcon: null,
    startsAt: null,
    endsAt: null,
    meetingPointLabel: null,
    clusterEventCount: eventCount,
    categories: [
      { code: 'trek', eventCount: 4_000 },
      { code: 'party', eventCount: 1_500 },
    ],
  };
}

const WINDOW = {
  windowStart: new Date('2090-01-01T00:00:00Z'),
  windowEnd: new Date('2090-02-01T00:00:00Z'),
  categoryCodes: ['trek'],
  zoom: 18,
  limit: 100,
} as const;

function querySql(database: DatabaseDouble): string {
  return database.query.mock.calls[0]![0] as string;
}

function queryParameters(database: DatabaseDouble): readonly unknown[] {
  return database.query.mock.calls[0]![1] as readonly unknown[];
}

function limitValue(database: DatabaseDouble): unknown {
  const match = /LIMIT \$(\d+)\s*$/.exec(querySql(database));
  if (!match) throw new Error('expected a parameterized outer LIMIT');
  return queryParameters(database)[Number(match[1]) - 1];
}

describe('ExplorerRepository', () => {
  it('composes canonical privacy/time/category/radius predicates before adaptive SQL aggregation', async () => {
    const raw = rawEvent(
      '00000000-0000-4000-8000-000000000001',
      '2090-01-02T00:00:00Z',
      35,
    );
    const database = databaseWithRows([raw]);
    const repository = new ExplorerRepository(database, new GeoService());
    const query: NormalizedExplorerQuery = {
      ...WINDOW,
      spatial: {
        kind: 'radius',
        center: { latitude: 31, longitude: 35 },
        radiusMeters: 25_000,
      },
    };

    const result = await repository.findDiscoverableMarkers(query);

    const sql = querySql(database);
    const privacyBoundary = sql.indexOf("event.visibility = 'PUBLIC'");
    expect(privacyBoundary).toBeGreaterThan(-1);
    expect(sql).toContain("event.status IN ('ACTIVE', 'FULL')");
    expect(sql).toContain("event.time_range && tstzrange(");
    expect(sql).toContain('ST_DWithin(event.meeting_point');
    expect(sql).toContain('category.code = ANY(');
    expect(sql).toContain('WITH discoverable AS MATERIALIZED');
    expect(sql.indexOf('bucketed AS MATERIALIZED')).toBeGreaterThan(privacyBoundary);
    expect(sql).not.toContain('generate_series');
    expect(sql).not.toContain('scale_counts');
    expect(sql).toContain('LEFT JOIN marker_rows ON TRUE');
    expect(queryParameters(database)).toEqual(
      expect.arrayContaining([
        WINDOW.windowStart,
        WINDOW.windowEnd,
        35,
        31,
        25_000,
        ['trek'],
        EXPLORER_AGGREGATION_LIMIT + 1,
        EXPLORER_AGGREGATION_LIMIT,
        100,
        18,
      ]),
    );
    expect(limitValue(database)).toBe(100);
    expect(result).toEqual({
      eventCount: 1,
      markers: [
        {
          kind: 'event',
          id: '00000000-0000-4000-8000-000000000001',
          title: 'Event 00000000-0000-4000-8000-000000000001',
          status: EventStatus.Active,
          coordinate: { latitude: 0, longitude: 35 },
          category: { code: 'trek', label: 'Trek', icon: 'mountain' },
          startsAt: '2090-01-02T00:00:00.000Z',
          endsAt: '2090-01-02T01:00:00.000Z',
          meetingPointLabel: null,
        },
      ],
    });
    expect(result.markers[0]).not.toHaveProperty('description');
    expect(result.markers[0]).not.toHaveProperty('hostUserId');
    expect(result.markers[0]).not.toHaveProperty('participantCount');
  });

  it('composes an antimeridian viewport from two safe GeoService predicates in one query', async () => {
    const database = databaseWithRows([
      { ...rawEvent('00000000-0000-4000-8000-000000000001', '2090-01-02T00:00:00Z', -179.5), resultEventCount: 2 },
      { ...rawEvent('00000000-0000-4000-8000-000000000002', '2090-01-03T00:00:00Z', 179.5), resultEventCount: 2 },
    ]);
    const geo = new GeoService();
    const bbox = jest.spyOn(geo, 'withinBoundingBox');
    const repository = new ExplorerRepository(database, geo);
    const query: NormalizedExplorerQuery = {
      ...WINDOW,
      categoryCodes: [],
      spatial: {
        kind: 'viewport',
        south: -10,
        west: 170,
        north: 10,
        east: -170,
        crossesAntimeridian: true,
      },
    };

    const result = await repository.findDiscoverableMarkers(query);

    expect(bbox).toHaveBeenNthCalledWith(
      1,
      'event.meeting_point',
      { latitude: -10, longitude: 170 },
      { latitude: 10, longitude: 180 },
      'explorerViewportWest',
    );
    expect(bbox).toHaveBeenNthCalledWith(
      2,
      'event.meeting_point',
      { latitude: -10, longitude: -180 },
      { latitude: 10, longitude: -170 },
      'explorerViewportEast',
    );
    expect(database.query).toHaveBeenCalledTimes(1);
    // Each half is (indexed coarse geography check AND exact planar
    // rectangle check), joined by OR -- the coarse geography predicate keeps
    // events_discoverable_geo_time_gix in the plan; the exact geometry check
    // is the authoritative, correctness-final condition (see viewportPredicate's
    // doc comment for why geography alone is not used as the sole predicate).
    const sql = querySql(database);
    expect(sql).toMatch(
      /\(ST_Intersects\(event\.meeting_point, ST_MakeEnvelope\([^)]+\)::geography\) AND ST_Intersects\(\(event\.meeting_point\)::geometry, ST_MakeEnvelope\([^)]+\)\)\)/,
    );
    expect(sql.match(/ST_MakeEnvelope/g)).toHaveLength(4);
    expect(sql).toMatch(/\)\) OR \(ST_Intersects/);
    expect(queryParameters(database)).toEqual(
      expect.arrayContaining([170, 180, -180, -170]),
    );
    expect(result.markers.map(({ id }) => id)).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ]);
  });

  it('returns exact, map-safe clusters for the benchmark-validated 5,500-event dense viewport', async () => {
    const database = databaseWithRows([rawCluster()]);
    const repository = new ExplorerRepository(database, new GeoService());

    const result = await repository.findDiscoverableMarkers({
      ...WINDOW,
      zoom: 8,
      categoryCodes: [],
      spatial: {
        kind: 'viewport',
        south: 48.7366,
        west: 2.2522,
        north: 48.9766,
        east: 2.4522,
        crossesAntimeridian: false,
      },
    });

    expect(result).toEqual({
      eventCount: 5_500,
      markers: [
        {
          kind: 'cluster',
          id: 'cluster:z8:s1:x518:y394',
          coordinate: { latitude: 48.8566, longitude: 2.3522 },
          eventCount: 5_500,
          categories: [
            { code: 'trek', eventCount: 4_000 },
            { code: 'party', eventCount: 1_500 },
          ],
        },
      ],
    });
    expect(result.markers[0]).not.toHaveProperty('title');
    expect(result.markers[0]).not.toHaveProperty('meetingPointLabel');
  });

  it('passes the requested marker limit into adaptive scale selection and the outer SQL LIMIT', async () => {
    const oneDatabase = databaseWithRows([{ ...rawCluster(20), resultEventCount: 20 }]);
    const twoHundredDatabase = databaseWithRows([{ ...rawCluster(20), resultEventCount: 20 }]);
    const spatial = {
      kind: 'radius' as const,
      center: { latitude: 31, longitude: 35 },
      radiusMeters: 25_000,
    };

    await new ExplorerRepository(oneDatabase, new GeoService()).findDiscoverableMarkers({
      ...WINDOW,
      spatial,
      zoom: 8,
      limit: 1,
      categoryCodes: [],
    });
    await new ExplorerRepository(twoHundredDatabase, new GeoService()).findDiscoverableMarkers({
      ...WINDOW,
      spatial,
      zoom: 8,
      limit: 200,
      categoryCodes: [],
    });

    expect(limitValue(oneDatabase)).toBe(1);
    expect(limitValue(twoHundredDatabase)).toBe(200);
    expect(queryParameters(oneDatabase)).toContain(1);
    expect(queryParameters(twoHundredDatabase)).toContain(200);
    expect(explorerClusterScale({
      ...WINDOW,
      spatial,
      zoom: 8,
      limit: 1,
      categoryCodes: [],
    })).toBeGreaterThan(explorerClusterScale({
      ...WINDOW,
      spatial,
      zoom: 8,
      limit: 200,
      categoryCodes: [],
    }));
  });

  it('coarsens an antimeridian grid deterministically enough to guarantee the marker limit', () => {
    expect(explorerClusterScale({
      ...WINDOW,
      categoryCodes: [],
      zoom: 1,
      limit: 1,
      spatial: {
        kind: 'viewport',
        south: -10,
        west: 170,
        north: 10,
        east: -170,
        crossesAntimeridian: true,
      },
    })).toBe(8);
  });

  it('matches the production scales recorded by the dense and permitted-extreme benchmarks', () => {
    expect(explorerClusterScale({
      ...WINDOW,
      zoom: 8,
      limit: 100,
      categoryCodes: [],
      spatial: {
        kind: 'viewport',
        south: 48.7366,
        west: 2.2522,
        north: 48.9766,
        east: 2.4522,
        crossesAntimeridian: false,
      },
    })).toBe(1);
    expect(explorerClusterScale({
      ...WINDOW,
      zoom: 8,
      limit: 200,
      categoryCodes: [],
      spatial: {
        kind: 'radius',
        center: { latitude: 48.8566, longitude: 2.3522 },
        radiusMeters: 500_000,
      },
    })).toBe(4);
    expect(explorerClusterScale({
      ...WINDOW,
      zoom: 2,
      limit: 200,
      categoryCodes: [],
      spatial: {
        kind: 'viewport',
        south: 0,
        west: -20,
        north: 60,
        east: 100,
        crossesAntimeridian: false,
      },
    })).toBe(1);
  });

  it('fails closed above the aggregation safety ceiling without returning partial clusters', async () => {
    const database = databaseWithRows([
      {
        ...rawCluster(),
        resultEventCount: EXPLORER_AGGREGATION_LIMIT + 1,
        kind: null,
        markerId: null,
      },
    ]);
    const repository = new ExplorerRepository(database, new GeoService());

    await expect(
      repository.findDiscoverableMarkers({
        ...WINDOW,
        categoryCodes: [],
        spatial: {
          kind: 'radius',
          center: { latitude: 31, longitude: 35 },
          radiusMeters: 25_000,
        },
      }),
    ).rejects.toMatchObject({ code: 'EXPLORER_QUERY_TOO_BROAD', status: 422 });
  });
});
