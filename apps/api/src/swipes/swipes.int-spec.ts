import { randomUUID } from 'node:crypto';

import {
  ConsentType,
  RestrictionType,
  SwipeDirection,
  UserAccountStatus,
} from '@tripwith/shared';

import { loadConfig } from '../config/configuration';
import { ConsentPolicyService } from '../consent/consent-policy.service';
import { AppDataSource } from '../database/data-source';
import { CandidateRepository } from '../matching/candidates';
import {
  MatchingNotEligibleError,
  SelfSwipeError,
  SwipeAlreadyExistsError,
  SwipeTargetInvalidError,
} from './swipes.errors';
import { SwipesRepository } from './swipes.repository';
import { SwipesService } from './swipes.service';

const RUN_ID = randomUUID().replace(/-/g, '');
const UID_PREFIX = `swipes-int-${RUN_ID}`;

interface TestAccount {
  readonly id: string;
  readonly firebaseUid: string;
}

async function addAnchorItinerary(account: TestAccount, suffix: string): Promise<void> {
  const [trip] = await AppDataSource.query(
    `INSERT INTO trips (user_id, title, start_date, end_date, visibility)
     VALUES ($1, $2, DATE '2090-09-01', DATE '2090-09-07', 'PRIVATE')
     RETURNING id`,
    [account.id, `Swipe anchor ${suffix}`],
  );
  await AppDataSource.query(
    `INSERT INTO trip_segments
       (trip_id, user_id, destination_place_id, destination_name, location,
        start_date, end_date, sort_order)
     VALUES ($1, $2, 'swipe-anchor', 'Swipe anchor',
             ST_SetSRID(ST_MakePoint(139.6917, 35.6895), 4326)::geography,
             DATE '2090-09-01', DATE '2090-09-07', 0)`,
    [trip.id, account.id],
  );
}

async function createEligibleAccount(
  suffix: string,
  withAnchorItinerary = true,
): Promise<TestAccount> {
  const firebaseUid = `${UID_PREFIX}-${suffix}`;
  const [user] = await AppDataSource.query(
    `INSERT INTO users (firebase_uid, email, email_verified_at, account_status, date_of_birth)
     VALUES ($1, $2, now(), $3, DATE '1990-01-01')
     RETURNING id`,
    [firebaseUid, `${RUN_ID}-${suffix}@example.com`, UserAccountStatus.Active],
  );
  await AppDataSource.query(
    `INSERT INTO user_profiles (user_id, display_name)
     VALUES ($1, $2)`,
    [user.id, `Swipe ${suffix}`],
  );
  await AppDataSource.query(`INSERT INTO user_settings (user_id) VALUES ($1)`, [user.id]);
  await AppDataSource.query(
    `INSERT INTO user_consents (user_id, consent_type, granted, policy_version)
     VALUES ($1, $2, TRUE, $4), ($1, $3, TRUE, $5)`,
    [
      user.id,
      ConsentType.TermsOfService,
      ConsentType.PrivacyPolicy,
      'tos-test-v1',
      'privacy-test-v1',
    ],
  );
  const account = { id: user.id as string, firebaseUid };
  if (withAnchorItinerary) await addAnchorItinerary(account, suffix);
  return account;
}

async function aggregateCounts(left: TestAccount, right: TestAccount): Promise<{
  readonly swipes: number;
  readonly matches: number;
  readonly rooms: number;
  readonly members: number;
  readonly messages: number;
}> {
  const [row] = await AppDataSource.query(
    `WITH pair_match AS (
       SELECT m.chat_room_id
         FROM matches m
        WHERE m.user_a_id = LEAST($1::uuid, $2::uuid)
          AND m.user_b_id = GREATEST($1::uuid, $2::uuid)
     )
     SELECT
       (SELECT count(*)::int FROM swipes
         WHERE source_user_id IN ($1, $2) AND target_user_id IN ($1, $2)) AS swipes,
       (SELECT count(*)::int FROM pair_match) AS matches,
       (SELECT count(*)::int FROM chat_rooms WHERE id IN (SELECT chat_room_id FROM pair_match)) AS rooms,
       (SELECT count(*)::int FROM chat_members WHERE room_id IN (SELECT chat_room_id FROM pair_match)) AS members,
       (SELECT count(*)::int FROM messages WHERE room_id IN (SELECT chat_room_id FROM pair_match)) AS messages`,
    [left.id, right.id],
  );
  return row;
}

describe('swipes and mutual matches (real PostgreSQL)', () => {
  let repository: SwipesRepository;
  let service: SwipesService;

  beforeAll(async () => {
    await AppDataSource.initialize();
    const config = loadConfig();
    repository = new SwipesRepository(
      AppDataSource,
      new ConsentPolicyService(config),
      new CandidateRepository(AppDataSource),
      config,
    );
    service = new SwipesService(repository);
  });

  afterAll(async () => {
    try {
      await AppDataSource.transaction(async (manager) => {
        const rooms = await manager.query(
          `SELECT DISTINCT m.chat_room_id AS id
             FROM matches m
             JOIN users u ON u.id IN (m.user_a_id, m.user_b_id)
            WHERE u.firebase_uid LIKE $1`,
          [`${UID_PREFIX}%`],
        );
        await manager.query(`ALTER TABLE user_consents DISABLE TRIGGER user_consents_append_only`);
        await manager.query(`DELETE FROM users WHERE firebase_uid LIKE $1`, [`${UID_PREFIX}%`]);
        await manager.query(`ALTER TABLE user_consents ENABLE TRIGGER user_consents_append_only`);
        if (rooms.length > 0) {
          await manager.query(`DELETE FROM chat_rooms WHERE id = ANY($1::uuid[])`, [
            rooms.map((row: { id: string }) => row.id),
          ]);
        }
      });
    } finally {
      await AppDataSource.destroy();
    }
  });

  it('persists LIKE and PASS without creating a one-sided or PASS match', async () => {
    const liker = await createEligibleAccount('one-sided-liker');
    const liked = await createEligibleAccount('one-sided-liked');
    const passer = await createEligibleAccount('passer');
    const passed = await createEligibleAccount('passed');

    const like = await service.create(liker.id, {
      targetUserId: liked.id,
      direction: SwipeDirection.Like,
    });
    const pass = await service.create(passer.id, {
      targetUserId: passed.id,
      direction: SwipeDirection.Pass,
    });
    const reverseLike = await service.create(passed.id, {
      targetUserId: passer.id,
      direction: SwipeDirection.Like,
    });

    expect(like.match).toBeNull();
    expect(pass.match).toBeNull();
    expect(reverseLike.match).toBeNull();
    await expect(aggregateCounts(liker, liked)).resolves.toEqual({
      swipes: 1,
      matches: 0,
      rooms: 0,
      members: 0,
      messages: 0,
    });
    await expect(aggregateCounts(passer, passed)).resolves.toEqual({
      swipes: 2,
      matches: 0,
      rooms: 0,
      members: 0,
      messages: 0,
    });
  });

  it('enforces the itinerary anchor on direct swipes without requiring score freshness', async () => {
    const noTripSource = await createEligibleAccount('no-anchor-source', false);
    const noTripTarget = await createEligibleAccount('no-anchor-target', false);

    await expect(
      service.create(noTripSource.id, {
        targetUserId: noTripTarget.id,
        direction: SwipeDirection.Like,
      }),
    ).rejects.toBeInstanceOf(SwipeTargetInvalidError);

    const farSource = await createEligibleAccount('far-source');
    const farTarget = await createEligibleAccount('far-target');
    await AppDataSource.query(
      `UPDATE trip_segments
          SET location = ST_SetSRID(ST_MakePoint(-149.9003, 61.2181), 4326)::geography
        WHERE user_id = $1`,
      [farTarget.id],
    );
    await expect(
      service.create(farSource.id, {
        targetUserId: farTarget.id,
        direction: SwipeDirection.Like,
      }),
    ).rejects.toBeInstanceOf(SwipeTargetInvalidError);

    const dateSource = await createEligibleAccount('date-source');
    const dateTarget = await createEligibleAccount('date-target');
    await AppDataSource.query(
      `UPDATE trips SET start_date = DATE '2090-10-01', end_date = DATE '2090-10-07'
        WHERE user_id = $1`,
      [dateTarget.id],
    );
    await AppDataSource.query(
      `UPDATE trip_segments
          SET start_date = DATE '2090-10-01', end_date = DATE '2090-10-07'
        WHERE user_id = $1`,
      [dateTarget.id],
    );
    await expect(
      service.create(dateSource.id, {
        targetUserId: dateTarget.id,
        direction: SwipeDirection.Like,
      }),
    ).rejects.toBeInstanceOf(SwipeTargetInvalidError);

    const eligibleSource = await createEligibleAccount('anchor-source');
    const eligibleTarget = await createEligibleAccount('anchor-target');
    await expect(
      service.create(eligibleSource.id, {
        targetUserId: eligibleTarget.id,
        direction: SwipeDirection.Like,
      }),
    ).resolves.toMatchObject({ match: null });
  });

  it('makes identical retries idempotent and rejects changing the first swipe', async () => {
    const source = await createEligibleAccount('retry-source');
    const target = await createEligibleAccount('retry-target');

    const first = await service.create(source.id, {
      targetUserId: target.id,
      direction: SwipeDirection.Like,
    });
    const retry = await service.create(source.id, {
      targetUserId: target.id,
      direction: SwipeDirection.Like,
    });
    expect(retry).toEqual(first);

    await expect(
      service.create(source.id, {
        targetUserId: target.id,
        direction: SwipeDirection.Pass,
      }),
    ).rejects.toBeInstanceOf(SwipeAlreadyExistsError);
    await expect(aggregateCounts(source, target)).resolves.toMatchObject({ swipes: 1 });
  });

  it('creates one canonical match room with two members and no messages', async () => {
    const left = await createEligibleAccount('sequential-left');
    const right = await createEligibleAccount('sequential-right');

    await expect(
      service.create(left.id, { targetUserId: right.id, direction: SwipeDirection.Like }),
    ).resolves.toMatchObject({ match: null });
    const matched = await service.create(right.id, {
      targetUserId: left.id,
      direction: SwipeDirection.Like,
    });

    expect(matched.match).not.toBeNull();
    await expect(aggregateCounts(left, right)).resolves.toEqual({
      swipes: 2,
      matches: 1,
      rooms: 1,
      members: 2,
      messages: 0,
    });
    const [canonical] = await AppDataSource.query(
      `SELECT user_a_id::text, user_b_id::text
         FROM matches
        WHERE chat_room_id = $1`,
      [matched.match?.chatRoomId],
    );
    expect(canonical.user_a_id < canonical.user_b_id).toBe(true);
  });

  it('serializes concurrent reciprocal likes and converges repeated retries', async () => {
    const left = await createEligibleAccount('race-left');
    const right = await createEligibleAccount('race-right');

    const initial = await Promise.all([
      service.create(left.id, { targetUserId: right.id, direction: SwipeDirection.Like }),
      service.create(right.id, { targetUserId: left.id, direction: SwipeDirection.Like }),
    ]);
    expect(initial.filter((result) => result.match !== null)).toHaveLength(1);

    const retries = await Promise.all([
      service.create(left.id, { targetUserId: right.id, direction: SwipeDirection.Like }),
      service.create(right.id, { targetUserId: left.id, direction: SwipeDirection.Like }),
    ]);
    expect(retries[0].match?.id).toBe(retries[1].match?.id);
    expect(retries[0].match?.chatRoomId).toBe(retries[1].match?.chatRoomId);
    await expect(aggregateCounts(left, right)).resolves.toEqual({
      swipes: 2,
      matches: 1,
      rooms: 1,
      members: 2,
      messages: 0,
    });
  });

  it('fails closed across every direct-swipe security and eligibility boundary', async () => {
    const source = await createEligibleAccount('eligibility-source');
    const hidden = await createEligibleAccount('eligibility-hidden');
    const ghosted = await createEligibleAccount('eligibility-ghosted');
    const blocked = await createEligibleAccount('eligibility-blocked');
    const blockedOutgoing = await createEligibleAccount('eligibility-blocked-outgoing');
    const withdrawnConsent = await createEligibleAccount('eligibility-withdrawn-consent');
    const targetSuspended = await createEligibleAccount('eligibility-target-suspended');
    const targetFullySuspended = await createEligibleAccount('eligibility-target-full-suspended');
    const suspended = await createEligibleAccount('eligibility-suspended');
    const ageSource = await createEligibleAccount('eligibility-age-source');
    const ageTarget = await createEligibleAccount('eligibility-age-target');
    const trustSource = await createEligibleAccount('eligibility-trust-source');
    const lowTrustTarget = await createEligibleAccount('eligibility-low-trust-target');

    await expect(
      service.create(source.id, { targetUserId: source.id, direction: SwipeDirection.Like }),
    ).rejects.toBeInstanceOf(SelfSwipeError);
    await expect(
      service.create(source.id, {
        targetUserId: randomUUID(),
        direction: SwipeDirection.Like,
      }),
    ).rejects.toBeInstanceOf(SwipeTargetInvalidError);

    await AppDataSource.query(
      `UPDATE user_settings SET discovery_enabled = FALSE WHERE user_id = $1`,
      [hidden.id],
    );
    await expect(
      service.create(source.id, { targetUserId: hidden.id, direction: SwipeDirection.Like }),
    ).rejects.toBeInstanceOf(SwipeTargetInvalidError);

    await AppDataSource.query(
      `UPDATE user_settings SET ghost_mode_enabled = TRUE WHERE user_id = $1`,
      [ghosted.id],
    );
    await expect(
      service.create(source.id, { targetUserId: ghosted.id, direction: SwipeDirection.Like }),
    ).rejects.toBeInstanceOf(SwipeTargetInvalidError);

    await AppDataSource.query(
      `INSERT INTO user_blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)`,
      [blocked.id, source.id],
    );
    await expect(
      service.create(source.id, { targetUserId: blocked.id, direction: SwipeDirection.Like }),
    ).rejects.toBeInstanceOf(SwipeTargetInvalidError);

    await AppDataSource.query(
      `INSERT INTO user_blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)`,
      [source.id, blockedOutgoing.id],
    );
    await expect(
      service.create(source.id, {
        targetUserId: blockedOutgoing.id,
        direction: SwipeDirection.Like,
      }),
    ).rejects.toBeInstanceOf(SwipeTargetInvalidError);

    await AppDataSource.query(
      `INSERT INTO user_consents
         (user_id, consent_type, granted, policy_version, created_at)
       VALUES ($1, $2, FALSE, 'tos-test-v1', now() + INTERVAL '1 second')`,
      [withdrawnConsent.id, ConsentType.TermsOfService],
    );
    await expect(
      service.create(source.id, {
        targetUserId: withdrawnConsent.id,
        direction: SwipeDirection.Like,
      }),
    ).rejects.toBeInstanceOf(SwipeTargetInvalidError);

    await AppDataSource.query(
      `INSERT INTO account_restrictions (user_id, type, reason)
       VALUES ($1, $2, 'target matching integration test')`,
      [targetSuspended.id, RestrictionType.MatchingSuspended],
    );
    await expect(
      service.create(source.id, {
        targetUserId: targetSuspended.id,
        direction: SwipeDirection.Like,
      }),
    ).rejects.toBeInstanceOf(SwipeTargetInvalidError);

    await AppDataSource.query(
      `INSERT INTO account_restrictions (user_id, type, reason)
       VALUES ($1, $2, 'target full suspension integration test')`,
      [targetFullySuspended.id, RestrictionType.FullSuspension],
    );
    await expect(
      service.create(source.id, {
        targetUserId: targetFullySuspended.id,
        direction: SwipeDirection.Like,
      }),
    ).rejects.toBeInstanceOf(SwipeTargetInvalidError);

    await AppDataSource.query(
      `UPDATE user_settings
          SET min_age_preference = 50, max_age_preference = 70
        WHERE user_id = $1`,
      [ageTarget.id],
    );
    await expect(
      service.create(ageSource.id, {
        targetUserId: ageTarget.id,
        direction: SwipeDirection.Like,
      }),
    ).rejects.toBeInstanceOf(SwipeTargetInvalidError);

    await AppDataSource.query(
      `UPDATE user_settings SET min_trust_score_preference = 8 WHERE user_id = $1`,
      [trustSource.id],
    );
    await AppDataSource.query(
      `UPDATE users SET trust_score_raw = 2 WHERE id = $1`,
      [lowTrustTarget.id],
    );
    await expect(
      service.create(trustSource.id, {
        targetUserId: lowTrustTarget.id,
        direction: SwipeDirection.Like,
      }),
    ).rejects.toBeInstanceOf(SwipeTargetInvalidError);

    await AppDataSource.query(
      `INSERT INTO account_restrictions (user_id, type, reason)
       VALUES ($1, $2, 'matching integration test')`,
      [suspended.id, RestrictionType.MatchingSuspended],
    );
    await expect(
      service.create(suspended.id, {
        targetUserId: source.id,
        direction: SwipeDirection.Like,
      }),
    ).rejects.toBeInstanceOf(MatchingNotEligibleError);

    const [count] = await AppDataSource.query(
      `SELECT count(*)::int AS count FROM swipes WHERE source_user_id = $1`,
      [source.id],
    );
    expect(count.count).toBe(0);
  });
});
