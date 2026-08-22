import { randomUUID } from 'node:crypto';
import type { QueryRunner } from 'typeorm';

import { AppDataSource } from '../database/data-source';
import { GeoService } from '../database/geo';
import { ExplorerRepository } from './explorer.repository';
import type { NormalizedExplorerQuery } from './explorer.types';

const RUN_ID = randomUUID().replaceAll('-', '');
const HOST_ID = randomUUID();
const WINDOW_START = new Date('2090-01-01T00:00:00Z');
const WINDOW_END = new Date('2090-02-01T00:00:00Z');

interface EventFixture {
  readonly label: string;
  readonly status?: 'DRAFT' | 'ACTIVE' | 'FULL' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  readonly visibility?: 'PUBLIC' | 'UNLISTED' | 'PRIVATE';
  readonly longitude?: number;
  readonly latitude?: number;
  readonly category?: 'trek' | 'party';
  readonly startsAt?: string;
  readonly endsAt?: string;
}

let runner: QueryRunner;

async function insertEvent(fixture: EventFixture): Promise<string> {
  const id = randomUUID();
  const status = fixture.status ?? 'ACTIVE';
  const startsAt = fixture.startsAt ?? '2090-01-10T10:00:00Z';
  const endsAt = fixture.endsAt ?? '2090-01-10T12:00:00Z';
  await runner.query(
    `INSERT INTO events
       (id, host_type, host_user_id, category_id, title, status, visibility,
        capacity_max, starts_at, ends_at, meeting_point, meeting_point_label,
        cancelled_at, completed_at)
     SELECT $1, 'USER', $2, category.id, $3, $4, $5,
            10, $6::timestamptz, $7::timestamptz,
            ST_SetSRID(ST_MakePoint($8, $9), 4326)::geography,
            $10,
            CASE WHEN $4 = 'CANCELLED' THEN $6::timestamptz ELSE NULL END,
            CASE WHEN $4 = 'COMPLETED' THEN $7::timestamptz ELSE NULL END
       FROM event_categories category
      WHERE category.code = $11`,
    [
      id,
      HOST_ID,
      `Explorer ${fixture.label}`,
      status,
      fixture.visibility ?? 'PUBLIC',
      startsAt,
      endsAt,
      fixture.longitude ?? 179.5,
      fixture.latitude ?? 0,
      `Point ${fixture.label}`,
      fixture.category ?? 'trek',
    ],
  );
  return id;
}

describe('ExplorerRepository (live PostgreSQL/PostGIS)', () => {
  let repository: ExplorerRepository;
  let westId: string;
  let eastId: string;

  beforeAll(async () => {
    await AppDataSource.initialize();
    runner = AppDataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    await runner.query(
      `INSERT INTO users (id, firebase_uid, email, account_status, date_of_birth)
       VALUES ($1, $2, $3, 'ACTIVE', '1990-01-01')`,
      [HOST_ID, `explorer-int-${RUN_ID}`, `explorer-int-${RUN_ID}@example.test`],
    );

    westId = await insertEvent({ label: 'west', longitude: 179.5, startsAt: '2090-01-10T10:00:00Z' });
    eastId = await insertEvent({
      label: 'east',
      longitude: -179.5,
      status: 'FULL',
      startsAt: '2090-01-09T10:00:00Z',
      endsAt: '2090-01-09T12:00:00Z',
    });
    await insertEvent({ label: 'private', visibility: 'PRIVATE' });
    await insertEvent({ label: 'unlisted', visibility: 'UNLISTED' });
    await insertEvent({ label: 'draft', status: 'DRAFT' });
    await insertEvent({ label: 'in-progress', status: 'IN_PROGRESS' });
    await insertEvent({ label: 'completed', status: 'COMPLETED' });
    await insertEvent({ label: 'cancelled', status: 'CANCELLED' });
    await insertEvent({
      label: 'past',
      startsAt: '2089-01-01T10:00:00Z',
      endsAt: '2089-01-01T12:00:00Z',
    });
    await insertEvent({
      label: 'future-outside-window',
      startsAt: '2090-03-01T10:00:00Z',
      endsAt: '2090-03-01T12:00:00Z',
    });
    await insertEvent({ label: 'other-category', category: 'party' });
    await insertEvent({ label: 'outside-viewport', longitude: 0 });
    repository = new ExplorerRepository(runner.manager, new GeoService());
  });

  afterAll(async () => {
    try {
      if (runner?.isTransactionActive) await runner.rollbackTransaction();
    } finally {
      if (runner) await runner.release();
      if (AppDataSource.isInitialized) await AppDataSource.destroy();
    }
  });

  it('returns only PUBLIC ACTIVE/FULL time-overlapping events across the antimeridian', async () => {
    const query: NormalizedExplorerQuery = {
      spatial: {
        kind: 'viewport',
        south: -10,
        west: 170,
        north: 10,
        east: -170,
        crossesAntimeridian: true,
      },
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      categoryCodes: ['trek'],
      zoom: 16,
      limit: 100,
    };

    const discovery = await repository.findDiscoverableMarkers(query);
    const events = discovery.markers;

    expect(discovery.eventCount).toBe(2);
    expect(events.map(({ id }) => id)).toEqual([eastId, westId]);
    expect(events.map((event) => event.kind === 'event' ? event.status : null)).toEqual(['FULL', 'ACTIVE']);
    expect(events.every((event) => event.kind === 'event' && event.category.code === 'trek')).toBe(true);
    expect(events.every((event) => event.kind === 'event' && event.startsAt >= WINDOW_START.toISOString())).toBe(true);
    expect(Object.keys(events[0]!).sort()).toEqual([
      'category',
      'coordinate',
      'endsAt',
      'id',
      'kind',
      'meetingPointLabel',
      'startsAt',
      'status',
      'title',
    ]);
  });

  it('uses ST_DWithin geography semantics and applies category metadata/filtering', async () => {
    const discovery = await repository.findDiscoverableMarkers({
      spatial: {
        kind: 'radius',
        center: { latitude: 0, longitude: 179.5 },
        radiusMeters: 150_000,
      },
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      categoryCodes: ['trek'],
      zoom: 18,
      limit: 100,
    });

    expect(new Set(discovery.markers.map(({ id }) => id))).toEqual(new Set([westId, eastId]));
    expect(discovery.markers[0]).toMatchObject({
      kind: 'event',
      category: { code: 'trek', label: 'Trek', icon: 'mountain' },
    });
    expect(await repository.findKnownCategoryCodes(['trek', 'not_real'])).toEqual(['trek']);
  });

  it('clusters the complete discoverable population across the antimeridian at low zoom', async () => {
    const discovery = await repository.findDiscoverableMarkers({
      spatial: {
        kind: 'viewport',
        south: -10,
        west: 170,
        north: 10,
        east: -170,
        crossesAntimeridian: true,
      },
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      categoryCodes: ['trek'],
      zoom: 1,
      limit: 1,
    });

    expect(discovery.eventCount).toBe(2);
    expect(discovery.markers).toEqual([
      expect.objectContaining({
        kind: 'cluster',
        eventCount: 2,
        categories: [{ code: 'trek', eventCount: 2 }],
      }),
    ]);
    expect(Math.abs(discovery.markers[0]!.coordinate.longitude)).toBe(180);
  });
});
