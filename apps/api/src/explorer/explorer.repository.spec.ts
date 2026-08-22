import { EventStatus, EventVisibility } from '@tripwith/shared';
import type { DataSource } from 'typeorm';

import { GeoService } from '../database/geo';
import { ExplorerRepository, EXPLORER_CANDIDATE_LIMIT } from './explorer.repository';
import type { NormalizedExplorerQuery } from './explorer.types';

type BuilderDouble = Record<string, jest.Mock>;

function builder(rows: readonly Record<string, unknown>[]): BuilderDouble {
  const value: BuilderDouble = {};
  for (const method of [
    'innerJoin',
    'select',
    'addSelect',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'take',
  ]) {
    value[method] = jest.fn().mockReturnValue(value);
  }
  value.getRawMany = jest.fn().mockResolvedValue(rows);
  return value;
}

function rawEvent(id: string, startsAt: string, longitude: number) {
  return {
    eventId: id,
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
  };
}

function dataSourceWithBuilders(...builders: BuilderDouble[]): DataSource {
  const createQueryBuilder = jest.fn();
  for (const queryBuilder of builders) createQueryBuilder.mockReturnValueOnce(queryBuilder);
  return {
    getRepository: jest.fn().mockReturnValue({ createQueryBuilder }),
    query: jest.fn(),
  } as unknown as DataSource;
}

const WINDOW = {
  windowStart: new Date('2090-01-01T00:00:00Z'),
  windowEnd: new Date('2090-02-01T00:00:00Z'),
  categoryCodes: ['trek'],
  zoom: 12,
  limit: 100,
} as const;

describe('ExplorerRepository', () => {
  it('composes the canonical discoverable/time/category/radius predicates and projects only map fields', async () => {
    const queryBuilder = builder([rawEvent('00000000-0000-4000-8000-000000000001', '2090-01-02T00:00:00Z', 35)]);
    const repository = new ExplorerRepository(dataSourceWithBuilders(queryBuilder), new GeoService());
    const query: NormalizedExplorerQuery = {
      ...WINDOW,
      spatial: {
        kind: 'radius',
        center: { latitude: 31, longitude: 35 },
        radiusMeters: 25_000,
      },
    };

    const result = await repository.findDiscoverableEvents(query);

    expect(queryBuilder.where).toHaveBeenCalledWith('event.visibility = :publicVisibility', {
      publicVisibility: EventVisibility.Public,
    });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'event.status IN (:...discoverableStatuses)',
      { discoverableStatuses: [EventStatus.Active, EventStatus.Full] },
    );
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      "event.time_range && tstzrange(:windowStart, :windowEnd, '[)')",
      { windowStart: WINDOW.windowStart, windowEnd: WINDOW.windowEnd },
    );
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'category.code IN (:...categoryCodes)',
      { categoryCodes: ['trek'] },
    );
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('ST_DWithin(event.meeting_point'),
      {
        explorerRadiusLng: 35,
        explorerRadiusLat: 31,
        explorerRadiusMeters: 25_000,
      },
    );
    expect(queryBuilder.take).toHaveBeenCalledWith(EXPLORER_CANDIDATE_LIMIT + 1);
    expect(queryBuilder.orderBy).toHaveBeenCalledWith('event.starts_at', 'ASC');
    expect(queryBuilder.addOrderBy).toHaveBeenCalledWith('event.id', 'ASC');
    expect(result).toEqual([
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
    ]);
    expect(result[0]).not.toHaveProperty('description');
    expect(result[0]).not.toHaveProperty('hostUserId');
    expect(result[0]).not.toHaveProperty('participantCount');
  });

  it('splits an antimeridian viewport into two safe GeoService queries and merges deterministically', async () => {
    const later = rawEvent(
      '00000000-0000-4000-8000-000000000002',
      '2090-01-03T00:00:00Z',
      179.5,
    );
    const earlier = rawEvent(
      '00000000-0000-4000-8000-000000000001',
      '2090-01-02T00:00:00Z',
      -179.5,
    );
    const westBuilder = builder([later, earlier]);
    const eastBuilder = builder([earlier]);
    const geo = new GeoService();
    const bbox = jest.spyOn(geo, 'withinBoundingBox');
    const repository = new ExplorerRepository(
      dataSourceWithBuilders(westBuilder, eastBuilder),
      geo,
    );
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

    const result = await repository.findDiscoverableEvents(query);

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
    expect(result.map(({ id }) => id)).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ]);
    expect(westBuilder.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('ST_MakeEnvelope'),
      expect.objectContaining({
        explorerViewportWestMinLng: 170,
        explorerViewportWestMaxLng: 180,
      }),
    );
    expect(eastBuilder.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('ST_MakeEnvelope'),
      expect.objectContaining({
        explorerViewportEastMinLng: -180,
        explorerViewportEastMaxLng: -170,
      }),
    );
  });

  it('fails closed rather than returning a partial cluster input above the candidate cap', async () => {
    const rows = Array.from({ length: EXPLORER_CANDIDATE_LIMIT + 1 }, (_, index) =>
      rawEvent(String(index).padStart(36, '0'), '2090-01-02T00:00:00Z', 35),
    );
    const repository = new ExplorerRepository(dataSourceWithBuilders(builder(rows)), new GeoService());
    await expect(
      repository.findDiscoverableEvents({
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
