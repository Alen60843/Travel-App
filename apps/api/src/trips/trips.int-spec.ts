import { randomUUID } from 'node:crypto';

import { TripVisibility, UserAccountStatus } from '@tripwith/shared';

import { AppDataSource } from '../database/data-source';
import { TripSegmentEntity, UserEntity } from '../database/entities';
import { GeoService } from '../database/geo';
import type { FeedGenerationService } from '../matching/feed-generation.service';
import {
  InvalidSegmentOrderError,
  InvalidTripValueError,
  SegmentOutsideTripError,
  TripNotFoundError,
  TripSegmentNotFoundError,
} from './trips.errors';
import { TripsRepository } from './trips.repository';
import { TripsService } from './trips.service';

const RUN_ID = randomUUID().replace(/-/g, '');
const UID_PREFIX = `trips-int-${RUN_ID}`;

async function createUser(suffix: string): Promise<UserEntity> {
  const repository = AppDataSource.getRepository(UserEntity);
  return repository.save(
    repository.create({
      firebaseUid: `${UID_PREFIX}-${suffix}`,
      email: `${RUN_ID}-${suffix}@example.com`,
      accountStatus: UserAccountStatus.Active,
      dateOfBirth: '1990-01-01',
    }),
  );
}

describe('TripsService (real PostgreSQL/PostGIS)', () => {
  let service: TripsService;
  const feedGeneration = {
    bump: jest.fn().mockResolvedValue('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  };

  beforeAll(async () => {
    await AppDataSource.initialize();
    service = new TripsService(
      new TripsRepository(AppDataSource),
      new GeoService(),
      feedGeneration as unknown as FeedGenerationService,
    );
  });

  afterAll(async () => {
    try {
      await AppDataSource.query(`DELETE FROM users WHERE firebase_uid LIKE $1`, [`${UID_PREFIX}%`]);
    } finally {
      await AppDataSource.destroy();
    }
  });

  it('creates, reads, lists, updates and deletes an owner trip with explicit visibility', async () => {
    // Cache metadata is best-effort: a failed generation write must never
    // roll back the already-authorized PostgreSQL mutation.
    feedGeneration.bump.mockResolvedValueOnce(null);
    const owner = await createUser('crud');
    const created = await service.createTrip(owner.id, {
      title: '  One Day in Jerusalem  ',
      startDate: '2027-04-01',
      endDate: '2027-04-01',
      visibility: TripVisibility.Private,
      metadata: { purpose: 'museum' },
    });

    expect(created).toMatchObject({
      title: 'One Day in Jerusalem',
      startDate: '2027-04-01',
      endDate: '2027-04-01',
      visibility: TripVisibility.Private,
      metadata: { purpose: 'museum' },
      segments: [],
    });
    expect(feedGeneration.bump).toHaveBeenCalledWith(owner.id);
    await expect(service.getTrip(owner.id, created.id)).resolves.toEqual(created);
    await expect(service.listTrips(owner.id)).resolves.toEqual([created]);

    const updated = await service.updateTrip(owner.id, created.id, {
      title: 'Jerusalem Day',
      visibility: TripVisibility.Public,
    });
    expect(updated).toMatchObject({
      title: 'Jerusalem Day',
      visibility: TripVisibility.Public,
    });

    await service.deleteTrip(owner.id, created.id);
    await expect(service.getTrip(owner.id, created.id)).rejects.toBeInstanceOf(TripNotFoundError);
  });

  it('persists PostGIS coordinates, enforces containment and maintains dense deterministic order', async () => {
    const owner = await createUser('segments');
    const trip = await service.createTrip(owner.id, {
      title: 'Japan',
      startDate: '2027-08-10',
      endDate: '2027-08-21',
    });
    const tokyo = await service.createSegment(owner.id, trip.id, {
      destinationPlaceId: 'ChIJ51cu8IcbXWARiRtXIothAS4',
      destinationName: ' Tokyo ',
      countryCode: 'JP',
      latitude: 35.6762,
      longitude: 139.6503,
      startDate: '2027-08-10',
      endDate: '2027-08-14',
      metadata: { transport: 'rail' },
    });
    const osaka = await service.createSegment(owner.id, trip.id, {
      destinationName: 'Osaka',
      countryCode: 'JP',
      latitude: 34.6937,
      longitude: 135.5023,
      startDate: '2027-08-19',
      endDate: '2027-08-21',
    });
    const kyoto = await service.createSegment(owner.id, trip.id, {
      destinationName: 'Kyoto',
      countryCode: 'JP',
      latitude: 35.0116,
      longitude: 135.7681,
      startDate: '2027-08-15',
      endDate: '2027-08-18',
      sortOrder: 1,
    });

    expect(tokyo).toMatchObject({
      destinationName: 'Tokyo',
      latitude: 35.6762,
      longitude: 139.6503,
      sortOrder: 0,
    });
    expect(osaka.sortOrder).toBe(1);
    expect(kyoto.sortOrder).toBe(1);
    let fetched = await service.getTrip(owner.id, trip.id);
    expect(fetched.segments.map(({ destinationName, sortOrder }) => [destinationName, sortOrder])).toEqual([
      ['Tokyo', 0],
      ['Kyoto', 1],
      ['Osaka', 2],
    ]);

    const moved = await service.updateSegment(owner.id, trip.id, osaka.id, {
      sortOrder: 0,
      latitude: 34.7,
      longitude: 135.5,
    });
    expect(moved).toMatchObject({ sortOrder: 0, latitude: 34.7, longitude: 135.5 });
    fetched = await service.getTrip(owner.id, trip.id);
    expect(fetched.segments.map(({ destinationName, sortOrder }) => [destinationName, sortOrder])).toEqual([
      ['Osaka', 0],
      ['Tokyo', 1],
      ['Kyoto', 2],
    ]);

    await service.deleteSegment(owner.id, trip.id, tokyo.id);
    fetched = await service.getTrip(owner.id, trip.id);
    expect(fetched.segments.map(({ destinationName, sortOrder }) => [destinationName, sortOrder])).toEqual([
      ['Osaka', 0],
      ['Kyoto', 1],
    ]);

    await expect(
      service.createSegment(owner.id, trip.id, {
        destinationName: 'Too Early',
        latitude: 35,
        longitude: 139,
        startDate: '2027-08-09',
        endDate: '2027-08-10',
      }),
    ).rejects.toBeInstanceOf(SegmentOutsideTripError);
    await expect(
      service.updateTrip(owner.id, trip.id, { endDate: '2027-08-17' }),
    ).rejects.toBeInstanceOf(SegmentOutsideTripError);
    await expect(
      service.updateSegment(owner.id, trip.id, kyoto.id, { sortOrder: 5 }),
    ).rejects.toBeInstanceOf(InvalidSegmentOrderError);
    await expect(
      service.createSegment(owner.id, trip.id, {
        destinationName: 'Invalid coordinate',
        countryCode: 'JP',
        latitude: 91,
        longitude: 139,
        startDate: '2027-08-10',
        endDate: '2027-08-10',
      }),
    ).rejects.toBeInstanceOf(InvalidTripValueError);
    await expect(
      service.createSegment(owner.id, trip.id, {
        destinationName: 'Invalid country',
        countryCode: 'jp',
        latitude: 35,
        longitude: 139,
        startDate: '2027-08-10',
        endDate: '2027-08-10',
      }),
    ).rejects.toMatchObject({
      code: 'TRIP_VALUE_INVALID',
      details: { field: 'countryCode' },
    });
    await expect(
      service.createSegment(owner.id, trip.id, {
        destinationPlaceId: '   ',
        destinationName: 'Invalid place identifier',
        latitude: 35,
        longitude: 139,
        startDate: '2027-08-10',
        endDate: '2027-08-10',
      }),
    ).rejects.toMatchObject({
      code: 'TRIP_VALUE_INVALID',
      details: { field: 'destinationPlaceId' },
    });
    await expect(
      service.updateSegment(owner.id, trip.id, kyoto.id, { latitude: 35.1 }),
    ).rejects.toMatchObject({ code: 'TRIP_VALUE_INVALID', status: 422 });

    const [stored] = await AppDataSource.query(
      `SELECT ST_Y(location::geometry) AS latitude,
              ST_X(location::geometry) AS longitude,
              lower(date_range)::text AS lower_date,
              (upper(date_range) - 1)::text AS inclusive_upper_date
         FROM trip_segments
        WHERE id = $1`,
      [osaka.id],
    );
    expect(stored).toEqual({
      latitude: 34.7,
      longitude: 135.5,
      lower_date: '2027-08-19',
      inclusive_upper_date: '2027-08-21',
    });
  });

  it('returns the same 404 boundary for missing and cross-owner aggregate access', async () => {
    const owner = await createUser('owner-boundary-a');
    const other = await createUser('owner-boundary-b');
    const trip = await service.createTrip(owner.id, {
      title: 'Private itinerary',
      startDate: '2027-09-01',
      endDate: '2027-09-03',
      visibility: TripVisibility.Private,
    });
    const segment = await service.createSegment(owner.id, trip.id, {
      destinationName: 'Secret destination',
      latitude: 10,
      longitude: 20,
      startDate: '2027-09-01',
      endDate: '2027-09-03',
    });
    const otherTrip = await service.createTrip(other.id, {
      title: 'Other trip',
      startDate: '2027-09-01',
      endDate: '2027-09-03',
    });

    await expect(service.getTrip(other.id, trip.id)).rejects.toMatchObject({
      code: 'TRIP_NOT_FOUND',
      status: 404,
    });
    await expect(service.getTrip(other.id, randomUUID())).rejects.toMatchObject({
      code: 'TRIP_NOT_FOUND',
      status: 404,
    });
    await expect(
      service.createSegment(other.id, trip.id, {
        destinationName: 'Attack',
        latitude: 0,
        longitude: 0,
        startDate: '2027-09-01',
        endDate: '2027-09-01',
      }),
    ).rejects.toBeInstanceOf(TripNotFoundError);
    await expect(
      service.updateSegment(other.id, otherTrip.id, segment.id, { destinationName: 'Attack' }),
    ).rejects.toBeInstanceOf(TripSegmentNotFoundError);
  });

  it('serializes concurrent appends through the parent lock', async () => {
    const owner = await createUser('concurrent');
    const trip = await service.createTrip(owner.id, {
      title: 'Concurrent itinerary',
      startDate: '2027-10-01',
      endDate: '2027-10-10',
    });
    const segment = (name: string, latitude: number) =>
      service.createSegment(owner.id, trip.id, {
        destinationName: name,
        latitude,
        longitude: 10,
        startDate: '2027-10-01',
        endDate: '2027-10-02',
      });

    await Promise.all([segment('A', 1), segment('B', 2), segment('C', 3)]);
    const fetched = await service.getTrip(owner.id, trip.id);
    expect(fetched.segments).toHaveLength(3);
    expect(fetched.segments.map((item) => item.sortOrder)).toEqual([0, 1, 2]);

    const stored: { sort_order: number }[] = await AppDataSource
      .getRepository(TripSegmentEntity)
      .createQueryBuilder('segment')
      .select('segment.sort_order', 'sort_order')
      .where('segment.trip_id = :tripId', { tripId: trip.id })
      .orderBy('segment.sort_order', 'ASC')
      .getRawMany();
    expect(stored.map((item) => item.sort_order)).toEqual([0, 1, 2]);
  });
});
