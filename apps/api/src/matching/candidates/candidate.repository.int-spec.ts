import { randomUUID } from 'node:crypto';

import type { DataSource, QueryRunner } from 'typeorm';

import { AppDataSource } from '../../database/data-source';
import { scoreMatch } from '../scoring';
import { CandidateRepository } from './candidate.repository';
import type { CandidateQueryOptions } from './candidate.types';

const AS_OF = new Date('2026-08-21T12:00:00Z');
const TOS = 'tos-test-v1';
const PRIVACY = 'privacy-test-v1';
const PAIR_WEIGHTS = { destination: 0.2, temporal: 0.5, geographic: 0.3 } as const;

interface FixtureUserOptions {
  readonly status?: 'ACTIVE' | 'DEACTIVATED';
  readonly dateOfBirth?: string;
  readonly trust?: number;
  readonly travelStyle?: number;
  readonly minAge?: number;
  readonly maxAge?: number;
  readonly minimumTrust?: number;
  readonly ghostUntil?: string;
  readonly consent?: 'current' | 'stale' | 'missing';
}

describe('CandidateRepository (live PostgreSQL/PostGIS)', () => {
  let runner: QueryRunner;
  let repository: CandidateRepository;

  beforeAll(async () => {
    await AppDataSource.initialize();
    runner = AppDataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    repository = new CandidateRepository({
      query: (sql: string, parameters?: unknown[]) => runner.query(sql, parameters),
    } as unknown as DataSource);
  });

  afterAll(async () => {
    if (runner?.isTransactionActive) await runner.rollbackTransaction();
    if (runner) await runner.release();
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  });

  async function createUser(label: string, options: FixtureUserOptions = {}): Promise<string> {
    const id = randomUUID();
    await runner.query(
      `INSERT INTO users
         (id, firebase_uid, email, email_verified_at, account_status, date_of_birth, trust_score_raw)
       VALUES ($1, $2, $3, now(), $4, $5, $6)`,
      [
        id,
        `matching-int-${label}-${id}`,
        `matching-int-${id}@example.test`,
        options.status ?? 'ACTIVE',
        options.dateOfBirth ?? '1992-06-15',
        options.trust ?? 5,
      ],
    );
    await runner.query(
      `INSERT INTO user_profiles
         (user_id, display_name, home_country_code, languages_spoken, travel_style)
       VALUES ($1, $2, 'FR', ARRAY['en','fr'], $3)`,
      [id, `Match ${label}`, options.travelStyle ?? 3],
    );
    await runner.query(
      `INSERT INTO user_settings
         (user_id, discovery_enabled, min_age_preference, max_age_preference,
          min_trust_score_preference, max_distance_km, ghost_mode_enabled, ghost_mode_until)
       VALUES ($1, TRUE, $2, $3, $4, 500, $5::boolean, $6::timestamptz)`,
      [
        id,
        options.minAge ?? 18,
        options.maxAge ?? 99,
        options.minimumTrust ?? 0,
        options.ghostUntil !== undefined,
        options.ghostUntil ?? null,
      ],
    );
    if ((options.consent ?? 'current') !== 'missing') {
      const current = options.consent !== 'stale';
      await runner.query(
        `INSERT INTO user_consents (user_id, consent_type, granted, policy_version)
         VALUES ($1, 'TERMS_OF_SERVICE', TRUE, $2),
                ($1, 'PRIVACY_POLICY', TRUE, $3)`,
        [id, current ? TOS : 'stale-tos', current ? PRIVACY : 'stale-privacy'],
      );
    }
    return id;
  }

  async function addSegment(
    userId: string,
    label: string,
    longitude = 170,
    latitude = 84,
    placeId = 'remote-shared-place',
    startDate = '2090-09-01',
    endDate = '2090-09-07',
  ): Promise<void> {
    const tripId = randomUUID();
    await runner.query(
      `INSERT INTO trips (id, user_id, title, start_date, end_date, visibility)
       VALUES ($1, $2, $3, $4, $5, 'PRIVATE')`,
      [tripId, userId, `Trip ${label}`, startDate, endDate],
    );
    await runner.query(
      `INSERT INTO trip_segments
         (trip_id, user_id, destination_place_id, destination_name, location,
          start_date, end_date, sort_order)
       VALUES ($1, $2, $3, $4,
               ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography,
               $7, $8, 0)`,
      [tripId, userId, placeId, label, longitude, latitude, startDate, endDate],
    );
  }

  it('hard-filters in SQL, ranks N+1, matches TS upper bounds, and revalidates privacy', async () => {
    const viewer = await createUser('viewer', {
      dateOfBirth: '1990-01-10',
      travelStyle: 2,
      minAge: 25,
      maxAge: 45,
      minimumTrust: 4,
    });
    await addSegment(viewer, 'viewer-paris');
    await addSegment(viewer, 'viewer-rome', 12.4964, 41.9028, 'remote-rome');

    const stronger = await createUser('stronger', { trust: 5, travelStyle: 2 });
    const weaker = await createUser('weaker', { trust: 8, travelStyle: 4 });
    await addSegment(stronger, 'stronger');
    // A non-zero geodesic proves SQL spherical distance and the TS haversine
    // stay in parity, rather than only exercising the identity point.
    await addSegment(weaker, 'weaker', 170.1, 84);

    const ghosted = await createUser('ghosted', { ghostUntil: '2026-09-01T00:00:00Z' });
    const blocked = await createUser('blocked');
    const blockedOutgoing = await createUser('blocked-outgoing');
    const swiped = await createUser('swiped');
    const restricted = await createUser('restricted');
    const staleConsent = await createUser('stale', { consent: 'stale' });
    const missingConsent = await createUser('missing-consent', { consent: 'missing' });
    const mutualAgeFailure = await createUser('age', { minAge: 50, maxAge: 70 });
    const viewerAgeFailure = await createUser('viewer-age', { dateOfBirth: '2004-06-15' });
    const lowTrust = await createUser('trust', { trust: 2 });
    const discoveryDisabled = await createUser('discovery-disabled');
    const noAnchor = await createUser('no-anchor');
    const inactive = await createUser('inactive', { status: 'DEACTIVATED' });
    const deleted = await createUser('deleted');
    for (const [id, label] of [
      [ghosted, 'ghosted'],
      [blocked, 'blocked'],
      [blockedOutgoing, 'blocked-outgoing'],
      [swiped, 'swiped'],
      [restricted, 'restricted'],
      [staleConsent, 'stale'],
      [missingConsent, 'missing-consent'],
      [mutualAgeFailure, 'age'],
      [viewerAgeFailure, 'viewer-age'],
      [lowTrust, 'trust'],
      [discoveryDisabled, 'discovery-disabled'],
      [inactive, 'inactive'],
      [deleted, 'deleted'],
    ] as const) {
      await addSegment(id, label);
    }
    await addSegment(noAnchor, 'no-anchor', -149.9, 61.2, 'anchorage');

    await runner.query(
      `INSERT INTO user_blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)`,
      [blocked, viewer],
    );
    await runner.query(
      `INSERT INTO user_blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)`,
      [viewer, blockedOutgoing],
    );
    await runner.query(
      `INSERT INTO swipes (source_user_id, target_user_id, direction) VALUES ($1, $2, 'PASS')`,
      [viewer, swiped],
    );
    await runner.query(
      `INSERT INTO account_restrictions (user_id, type, reason, starts_at)
       VALUES ($1, 'MATCHING_SUSPENDED', 'integration restriction', '2026-08-20T00:00:00Z')`,
      [restricted],
    );
    await runner.query(
      `UPDATE user_settings SET discovery_enabled = FALSE WHERE user_id = $1`,
      [discoveryDisabled],
    );
    await runner.query(`UPDATE users SET deleted_at = $2 WHERE id = $1`, [deleted, AS_OF]);

    const interests: number[] = [];
    for (const suffix of ['a', 'b', 'c']) {
      const [row] = await runner.query(
        `INSERT INTO interests (code, label) VALUES ($1, $2) RETURNING id`,
        [`matching_${suffix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`, `Interest ${suffix}`],
      );
      interests.push(Number((row as { id: number }).id));
    }
    const [interestA, interestB, interestC] = interests as [number, number, number];
    await runner.query(
      `INSERT INTO user_interests (user_id, interest_id)
       VALUES ($1, $4), ($1, $5), ($2, $4), ($2, $5), ($3, $5), ($3, $6)`,
      [viewer, stronger, weaker, interestA, interestB, interestC],
    );

    const options: CandidateQueryOptions = {
      viewerId: viewer,
      asOf: AS_OF,
      currentTermsOfServiceVersion: TOS,
      currentPrivacyPolicyVersion: PRIVACY,
      maximumAnchorRadiusMeters: 100_000,
      pairWeights: PAIR_WEIGHTS,
      exactScoreLimit: 1,
    };

    await expect(repository.isViewerEligible(options)).resolves.toBe(true);
    const viewerContext = await repository.loadViewerScoringContext(options);
    expect(viewerContext).not.toBeNull();
    expect(viewerContext?.segments).toHaveLength(2);
    expect(viewerContext?.anchorRadiusMeters).toBe(100_000);

    const batch = await repository.findCoarseCandidates(options);
    expect(batch.candidates).toHaveLength(1);
    expect(batch.nextUnscored).not.toBeNull();
    const returnedIds = [batch.candidates[0]!.userId, batch.nextUnscored!.userId];
    expect(new Set(returnedIds)).toEqual(new Set([stronger, weaker]));
    expect(batch.anchoredCandidateCount).toBe(2);
    expect(batch.activeUniverseCount).toBeGreaterThanOrEqual(14);
    expect(batch.hardFilteredCount).toBe(batch.activeUniverseCount - 2);
    expect(batch.candidates[0]!.matchUpperBound).toBeGreaterThanOrEqual(
      batch.nextUnscored!.matchUpperBound,
    );

    const secondCoarsePage = await repository.findCoarseCandidates({
      ...options,
      cursor: {
        matchUpperBound: batch.candidates[0]!.matchUpperBound,
        userId: batch.candidates[0]!.userId,
      },
    });
    expect(secondCoarsePage.candidates.map(({ userId }) => userId)).toEqual([
      batch.nextUnscored!.userId,
    ]);
    expect(secondCoarsePage.nextUnscored).toBeNull();

    for (const candidate of [batch.candidates[0]!, batch.nextUnscored!]) {
      const ts = scoreMatch({
        viewerSegments: viewerContext!.segments,
        candidateSegments: candidate.scoringSegments,
        candidateTrustScore: candidate.trustScore,
        viewerTravelStyle: viewerContext!.travelStyle,
        candidateTravelStyle: candidate.travelStyle,
        viewerInterestIds: viewerContext!.interestIds,
        candidateInterestIds: candidate.interestIds,
        itinerary: {
          anchorRadiusMeters: viewerContext!.anchorRadiusMeters,
          breadthWeight: 0.25,
          pairWeights: PAIR_WEIGHTS,
        },
      });
      expect(candidate.itineraryUpperBound).toBeCloseTo(ts.components.itineraryUpperBound, 8);
      expect(candidate.matchUpperBound).toBeCloseTo(ts.upperBound, 8);
      expect(ts.score).toBeLessThanOrEqual(candidate.matchUpperBound + 1e-10);
    }

    await expect(
      repository.revalidateCandidateIds({
        viewerId: viewer,
        candidateIds: [
          stronger,
          ghosted,
          blocked,
          blockedOutgoing,
          swiped,
          restricted,
          staleConsent,
          missingConsent,
          discoveryDisabled,
          deleted,
        ],
        asOf: AS_OF,
        currentTermsOfServiceVersion: TOS,
        currentPrivacyPolicyVersion: PRIVACY,
      }),
    ).resolves.toEqual([stronger]);

    await runner.query('SET LOCAL enable_seqscan = off');
    const plan = await repository.explainCoarseCandidates(options);
    expect(JSON.stringify(plan)).toContain('trip_segments_loc_range_gix');

    await runner.query(
      `INSERT INTO account_restrictions (user_id, type, reason, starts_at)
       VALUES ($1, 'MATCHING_SUSPENDED', 'viewer restricted', '2026-08-20T00:00:00Z')`,
      [viewer],
    );
    await expect(repository.isViewerEligible(options)).resolves.toBe(false);
    await expect(repository.loadViewerScoringContext(options)).resolves.toBeNull();
    await expect(repository.findCoarseCandidates(options)).resolves.toMatchObject({
      candidates: [],
      nextUnscored: null,
      activeUniverseCount: 0,
      anchoredCandidateCount: 0,
      hardFilteredCount: 0,
    });
    await expect(
      repository.revalidateCandidateIds({
        viewerId: viewer,
        candidateIds: [stronger],
        asOf: AS_OF,
        currentTermsOfServiceVersion: TOS,
        currentPrivacyPolicyVersion: PRIVACY,
      }),
    ).resolves.toEqual([]);
  });
});
