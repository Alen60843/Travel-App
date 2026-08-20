import { randomUUID } from 'node:crypto';

import { ChatRoomType, MessageType, TripVisibility, UserAccountStatus } from '@tripwith/shared';

import { AppDataSource } from '../data-source';
import { geoPoint } from '../geo/geo-point';
import { ChatRoomEntity, MessageEntity } from './social.entity';
import { TripEntity, TripSegmentEntity } from './trips.entity';
import { InterestEntity, UserInterestEntity } from './interests.entity';
import { UserEntity, UserProfileEntity } from './identity.entity';

/**
 * Round-trips real rows through the column kinds most likely to be mapped
 * wrong: geography, jsonb, arrays (both plain and trigger-projected), enums
 * and timestamptz — then re-fetches independently of the `save()` return
 * value, so these assertions can't be fooled by TypeORM's in-memory object
 * still holding the value the test set rather than what the database
 * actually stored.
 *
 * Also proves the insert:false / update:false contract on trigger- and
 * generated-column-maintained fields: mutating them in memory and saving
 * must not change what is in the database.
 */

function uniqueEmail(): string {
  return `test-${randomUUID()}@example.com`;
}

function uniqueFirebaseUid(): string {
  return `fb-${randomUUID()}`;
}

async function createUser(): Promise<UserEntity> {
  const repo = AppDataSource.getRepository(UserEntity);
  return repo.save(
    repo.create({
      firebaseUid: uniqueFirebaseUid(),
      email: uniqueEmail(),
      accountStatus: UserAccountStatus.Active,
      dateOfBirth: '1990-01-01',
    }),
  );
}

describe('round trip: geography, jsonb, arrays, enum, timestamptz (real database)', () => {
  beforeAll(async () => {
    await AppDataSource.initialize();
  });

  afterAll(async () => {
    await AppDataSource.destroy();
  });

  it('persists and independently re-reads a trip segment: geography, jsonb, enum, timestamptz, generated daterange', async () => {
    const user = await createUser();

    const tripRepo = AppDataSource.getRepository(TripEntity);
    const trip = await tripRepo.save(
      tripRepo.create({
        userId: user.id,
        title: 'Round-trip test trip',
        startDate: '2026-01-01',
        endDate: '2026-01-10',
        visibility: TripVisibility.Public,
        metadata: { note: 'hello', count: 3, nested: { ok: true } },
      }),
    );

    const segmentRepo = AppDataSource.getRepository(TripSegmentEntity);
    const point = geoPoint(13.7563, 100.5018); // Bangkok
    const saved = await segmentRepo.save(
      segmentRepo.create({
        tripId: trip.id,
        userId: user.id,
        destinationName: 'Bangkok',
        countryCode: 'TH',
        location: point,
        startDate: '2026-01-01',
        endDate: '2026-01-05',
        sortOrder: 1,
        metadata: { tag: 'segment-meta' },
      }),
    );

    // Independent re-fetch — not the object save() handed back.
    const reloadedSegment = await segmentRepo.findOneByOrFail({ id: saved.id });
    expect(reloadedSegment.location).toEqual(point);
    expect(reloadedSegment.metadata).toEqual({ tag: 'segment-meta' });
    expect(reloadedSegment.destinationName).toBe('Bangkok');
    expect(reloadedSegment.countryCode).toBe('TH');
    expect(reloadedSegment.createdAt).toBeInstanceOf(Date);
    // Generated STORED column, populated by the database on insert.
    expect(reloadedSegment.dateRange).toEqual(expect.stringContaining('2026-01-01'));

    const reloadedTrip = await tripRepo.findOneByOrFail({ id: trip.id });
    expect(reloadedTrip.visibility).toBe(TripVisibility.Public);
    expect(reloadedTrip.metadata).toEqual({ note: 'hello', count: 3, nested: { ok: true } });
    expect(reloadedTrip.createdAt).toBeInstanceOf(Date);
  });

  it('round-trips a plain text[] column (user_profiles.languages_spoken)', async () => {
    const user = await createUser();
    const profileRepo = AppDataSource.getRepository(UserProfileEntity);
    await profileRepo.save(
      profileRepo.create({
        userId: user.id,
        displayName: 'Round Trip Tester',
        languagesSpoken: ['en', 'th', 'fr'],
      }),
    );

    const reloaded = await profileRepo.findOneByOrFail({ userId: user.id });
    expect(reloaded.languagesSpoken).toEqual(['en', 'th', 'fr']);
  });

  it('round-trips int[] through the trigger-maintained interest_ids projection', async () => {
    const user = await createUser();
    const profileRepo = AppDataSource.getRepository(UserProfileEntity);
    await profileRepo.save(profileRepo.create({ userId: user.id, displayName: 'Interest Tester' }));

    const interestRepo = AppDataSource.getRepository(InterestEntity);
    const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
    const interestA = await interestRepo.save(
      interestRepo.create({ code: `t_a_${suffix}`, label: 'Test A', isActive: true, sortOrder: 0 }),
    );
    const interestB = await interestRepo.save(
      interestRepo.create({ code: `t_b_${suffix}`, label: 'Test B', isActive: true, sortOrder: 0 }),
    );

    const userInterestRepo = AppDataSource.getRepository(UserInterestEntity);
    await userInterestRepo.save([
      userInterestRepo.create({ userId: user.id, interestId: interestA.id }),
      userInterestRepo.create({ userId: user.id, interestId: interestB.id }),
    ]);

    const reloadedProfile = await profileRepo.findOneByOrFail({ userId: user.id });
    expect([...reloadedProfile.interestIds].sort((a, b) => a - b)).toEqual(
      [interestA.id, interestB.id].sort((a, b) => a - b),
    );
  });

  it('never writes users.trust_score_raw from the application (update:false honoured)', async () => {
    const userRepo = AppDataSource.getRepository(UserEntity);
    const user = await createUser();

    const reloadedBefore = await userRepo.findOneByOrFail({ id: user.id });
    expect(reloadedBefore.trustScoreRaw).toBe(5); // DB DEFAULT 5.000

    // Simulate a caller trying to tamper with a readonly, insert/update:false
    // column. TS's `readonly` only blocks this at compile time; the runtime
    // guarantee has to come from the ORM, which is exactly what this proves.
    const tampered = reloadedBefore as unknown as { trustScoreRaw: number };
    tampered.trustScoreRaw = 9999;
    await userRepo.save(reloadedBefore);

    const reloadedAfter = await userRepo.findOneByOrFail({ id: user.id });
    expect(reloadedAfter.trustScoreRaw).toBe(5); // unchanged — the tampered value never reached Postgres
  });

  it('never accepts an application-supplied messages.seq (insert:false honoured; the trigger assigns it)', async () => {
    const roomRepo = AppDataSource.getRepository(ChatRoomEntity);
    const room = await roomRepo.save(roomRepo.create({ type: ChatRoomType.Match }));

    const messageRepo = AppDataSource.getRepository(MessageEntity);
    const draft = messageRepo.create({ roomId: room.id, type: MessageType.System });
    // Attempt to smuggle a bogus seq in — insert:false must mean this value
    // never reaches the INSERT statement, leaving tw_assign_message_seq as
    // the only writer.
    (draft as unknown as { seq: number }).seq = 999_999;

    const saved = await messageRepo.save(draft);
    const reloaded = await messageRepo.findOneByOrFail({ id: saved.id });
    expect(reloaded.seq).toBe(1); // trigger-assigned: first message in a fresh room
    expect(reloaded.seq).not.toBe(999_999);

    const reloadedRoom = await roomRepo.findOneByOrFail({ id: room.id });
    expect(reloadedRoom.lastSeq).toBe(1); // chat_rooms.last_seq advanced in lockstep
  });
});
