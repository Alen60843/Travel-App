import type { AppConfig } from '../config/configuration';
import { InMemoryMetricsService } from '../observability/in-memory-metrics.service';
import type { PinoLoggerService } from '../observability/pino-logger.service';
import type { CacheService } from '../redis/cache.service';
import type { CandidateRepository } from './candidates';
import type { FeedGenerationService } from './feed-generation.service';
import { MatchingCursorStaleError, MatchingNotEligibleError } from './matching.errors';
import { MatchingService } from './matching.service';
import type { CachedMatchingRanking, CachedRankedCandidate } from './matching.types';

const VIEWER_ID = 'c9ec876a-0b69-4ab0-95e7-67180442e45d';
const FIRST_ID = '50eca8cf-846f-470f-b2ee-bbfbd34238ab';
const SECOND_ID = '6cc7a367-f55e-4a16-a8af-a75cac337a52';
const THIRD_ID = '4950b2ee-90ab-48ed-94fc-62da9493ea25';
const SNAPSHOT_ID = '933ce613-3d81-45ba-8642-f3cdf150bfe8';
const FILTER_HASH = '0123456789abcdef01234567';
const OTHER_FILTER_HASH = '89abcdef0123456701234567';
const GENERATION_A = '11111111111111111111111111111111';
const GENERATION_B = '22222222222222222222222222222222';

const segment = {
  destinationPlaceId: 'place-1',
  latitude: 35,
  longitude: 139,
  start: '2026-09-01',
  end: '2026-09-01',
} as const;

function config(): AppConfig {
  return {
    consentPolicy: {
      currentTermsOfServiceVersion: 'tos-v1',
      currentPrivacyPolicyVersion: 'privacy-v1',
    },
    matching: {
      anchorRadiusKm: 100,
      pairWeights: { destination: 0.2, temporal: 0.5, geographic: 0.3 },
      breadthBeta: 0.25,
      candidateCap: 50,
      maxPageSize: 50,
      feedTtlSeconds: 90,
      cursorSecret: 'matching-test-cursor-secret-at-least-32',
    },
  } as AppConfig;
}

function cachedCandidate(userId: string, score: number): CachedRankedCandidate {
  return {
    userId,
    score,
    id: userId,
    displayName: `Traveller ${userId.slice(0, 4)}`,
    avatarUrl: null,
    homeCountryCode: 'JP',
    languagesSpoken: ['en'],
    travelStyle: 3,
    trustScore: 8,
    commonInterestIds: [1],
    matchScore: score,
    components: { itinerary: 1, trust: 0.8, travelStyle: 1, interests: 1 },
  };
}

describe('MatchingService', () => {
  let candidates: jest.Mocked<CandidateRepository>;
  let cache: jest.Mocked<CacheService>;
  let generations: jest.Mocked<FeedGenerationService>;
  let metrics: InMemoryMetricsService;
  let logger: jest.Mocked<PinoLoggerService>;
  let service: MatchingService;

  beforeEach(() => {
    candidates = {
      isViewerEligible: jest.fn().mockResolvedValue(true),
      loadViewerScoringContext: jest.fn().mockResolvedValue({
        userId: VIEWER_ID,
        travelStyle: 3,
        interestIds: [1],
        anchorRadiusMeters: 100_000,
        segments: [segment],
      }),
      findCoarseCandidates: jest.fn().mockResolvedValue({
        candidates: [
          {
            userId: FIRST_ID,
            displayName: 'First Traveller',
            avatarUrl: null,
            homeCountryCode: 'JP',
            languagesSpoken: ['en'],
            age: 30,
            trustScore: 8,
            travelStyle: 3,
            interestIds: [1],
            itineraryUpperBound: 1,
            trustComponent: 0.8,
            travelStyleComponent: 1,
            interestComponent: 1,
            matchUpperBound: 0.94,
            scoringSegments: [segment],
          },
          {
            userId: SECOND_ID,
            displayName: 'Second Traveller',
            avatarUrl: null,
            homeCountryCode: null,
            languagesSpoken: ['fr'],
            age: 28,
            trustScore: 7,
            travelStyle: 3,
            interestIds: [1],
            itineraryUpperBound: 1,
            trustComponent: 0.7,
            travelStyleComponent: 1,
            interestComponent: 1,
            matchUpperBound: 0.91,
            scoringSegments: [segment],
          },
        ],
        nextUnscored: null,
        activeUniverseCount: 4,
        anchoredCandidateCount: 2,
        hardFilteredCount: 2,
      }),
      revalidateCandidateIds: jest.fn(async ({ candidateIds }) => [...candidateIds]),
    } as unknown as jest.Mocked<CandidateRepository>;
    cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<CacheService>;
    generations = {
      current: jest.fn().mockResolvedValue(GENERATION_A),
      filterHash: jest.fn().mockReturnValue(FILTER_HASH),
      rankingKey: jest.fn().mockReturnValue('feed:key'),
    } as unknown as jest.Mocked<FeedGenerationService>;
    metrics = new InMemoryMetricsService();
    logger = {
      error: jest.fn(),
      warn: jest.fn(),
    } as unknown as jest.Mocked<PinoLoggerService>;
    service = new MatchingService(
      candidates,
      cache,
      generations,
      config(),
      metrics,
      logger,
    );
  });

  it('exact-scores a cache miss and exposes no age or itinerary coordinates', async () => {
    candidates.revalidateCandidateIds.mockImplementation(async ({ candidateIds }) => [
      ...candidateIds,
    ]);
    const result = await service.getFeed(VIEWER_ID, { limit: 1 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: FIRST_ID });
    expect(result.items[0]?.matchScore).toBeCloseTo(0.94, 12);
    expect(result.items[0]).not.toHaveProperty('age');
    expect(result.items[0]).not.toHaveProperty('scoringSegments');
    expect(result.nextCursor).toEqual(expect.any(String));
    expect(result.rankingExact).toBe(true);
    expect(cache.set).toHaveBeenCalledWith(
      'feed:key',
      expect.objectContaining({ ranked: expect.any(Array) }),
      90,
    );
    expect(metrics.getCounter('matching.cache_miss')).toBe(1);
    expect(metrics.getCounter('matching.candidates_hard_filtered')).toBe(2);
    expect(metrics.getCounter('matching.candidates_exact_scored')).toBe(2);
    expect(candidates.findCoarseCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: {
          homeCountryCode: null,
          nativeLanguageCode: null,
          minAge: null,
          maxAge: null,
          interestIds: [],
        },
      }),
    );
  });

  it('normalizes request filters into SQL and the cache namespace', async () => {
    await service.getFeed(VIEWER_ID, {
      limit: 1,
      homeCountryCode: 'FR',
      nativeLanguageCode: 'es',
      minAge: 25,
      maxAge: 40,
      interestIds: [9, 3],
    });
    expect(candidates.findCoarseCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: {
          homeCountryCode: 'FR',
          nativeLanguageCode: 'es',
          minAge: 25,
          maxAge: 40,
          interestIds: [3, 9],
        },
      }),
    );
    expect(generations.filterHash).toHaveBeenCalledWith(
      expect.objectContaining({
        homeCountryCode: 'FR',
        nativeLanguageCode: 'es',
        minAge: 25,
        maxAge: 40,
        interestIds: [3, 9],
      }),
    );
  });

  it('rejects an inverted dynamic age range', async () => {
    await expect(service.getFeed(VIEWER_ID, { minAge: 50, maxAge: 40 }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(candidates.isViewerEligible).not.toHaveBeenCalled();
  });

  it('rejects a cursor under a different filter namespace', async () => {
    const first = await service.getFeed(VIEWER_ID, {
      limit: 1,
      homeCountryCode: 'FR',
    });
    generations.filterHash.mockReturnValue(OTHER_FILTER_HASH);
    await expect(service.getFeed(VIEWER_ID, {
      limit: 1,
      homeCountryCode: 'DE',
      cursor: first.nextCursor!,
    })).rejects.toBeInstanceOf(MatchingCursorStaleError);
  });

  it('removes newly hidden cached candidates and pulls the page forward', async () => {
    const ranking: CachedMatchingRanking = {
      snapshotId: SNAPSHOT_ID,
      generatedAt: new Date().toISOString(),
      nextUnscoredUpperBound: null,
      nextBatchCursor: null,
      ranked: [cachedCandidate(FIRST_ID, 0.9), cachedCandidate(SECOND_ID, 0.8)],
    };
    cache.get.mockResolvedValue(ranking);
    candidates.revalidateCandidateIds
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([SECOND_ID]);

    const result = await service.getFeed(VIEWER_ID, { limit: 1 });
    expect(result.items.map(({ id }) => id)).toEqual([SECOND_ID]);
    expect(metrics.getCounter('matching.cache_hit')).toBe(1);
    expect(metrics.getCounter('matching.cache_revalidated_removed')).toBe(1);
    expect(candidates.revalidateCandidateIds.mock.calls.every(
      ([input]) => input.candidateIds.length <= 1,
    )).toBe(true);
  });

  it('rejects a cursor after the viewer generation changes', async () => {
    const first = await service.getFeed(VIEWER_ID, { limit: 1 });
    generations.current.mockResolvedValue(GENERATION_B);
    await expect(
      service.getFeed(VIEWER_ID, { limit: 1, cursor: first.nextCursor! }),
    ).rejects.toBeInstanceOf(MatchingCursorStaleError);
  });

  it('rejects a valid signed cursor when replayed by another viewer', async () => {
    const first = await service.getFeed(VIEWER_ID, { limit: 1 });
    await expect(
      service.getFeed('c228a43a-fabe-4a3b-975f-ee475806d7f4', {
        limit: 1,
        cursor: first.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: 'MATCHING_CURSOR_INVALID' });
  });

  it('rejects a cursor when its immutable cache snapshot has expired', async () => {
    const first = await service.getFeed(VIEWER_ID, { limit: 1 });
    cache.get.mockResolvedValue(null);
    await expect(
      service.getFeed(VIEWER_ID, { limit: 1, cursor: first.nextCursor! }),
    ).rejects.toBeInstanceOf(MatchingCursorStaleError);
    expect(candidates.findCoarseCandidates).toHaveBeenCalledTimes(1);
  });

  it('continues with the next coarse keyset batch after exact-scored N is consumed', async () => {
    const initial = await candidates.findCoarseCandidates({} as never);
    const third = {
      ...initial.candidates[1]!,
      userId: THIRD_ID,
      displayName: 'Third Traveller',
      trustScore: 6,
      trustComponent: 0.6,
      matchUpperBound: 0.88,
    };
    candidates.findCoarseCandidates.mockReset();
    candidates.findCoarseCandidates
      .mockResolvedValueOnce({ ...initial, nextUnscored: third })
      .mockResolvedValueOnce({
        candidates: [third],
        nextUnscored: null,
        activeUniverseCount: 3,
        anchoredCandidateCount: 1,
        hardFilteredCount: 2,
      });

    const first = await service.getFeed(VIEWER_ID, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    const rootRanking = cache.set.mock.calls[0]![1] as CachedMatchingRanking;
    cache.get.mockReset();
    cache.get.mockResolvedValueOnce(rootRanking).mockResolvedValueOnce(null);

    const continued = await service.getFeed(VIEWER_ID, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(continued.items.map(({ id }) => id)).toEqual([THIRD_ID]);
    expect(candidates.findCoarseCandidates.mock.calls[1]?.[0]).toMatchObject({
      cursor: {
        userId: initial.candidates[1]!.userId,
        matchUpperBound: initial.candidates[1]!.matchUpperBound,
      },
    });
  });

  it('fails closed before reading a cache for an ineligible viewer', async () => {
    candidates.isViewerEligible.mockResolvedValue(false);
    await expect(service.getFeed(VIEWER_ID, {})).rejects.toBeInstanceOf(
      MatchingNotEligibleError,
    );
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('records when the SQL upper-bound recall proof is not established', async () => {
    // Use a valid cached ranking to isolate the runtime exactness condition.
    cache.get.mockResolvedValue({
      snapshotId: SNAPSHOT_ID,
      generatedAt: new Date().toISOString(),
      nextUnscoredUpperBound: 0.99,
      nextBatchCursor: null,
      ranked: [cachedCandidate(FIRST_ID, 0.9)],
    });
    const result = await service.getFeed(VIEWER_ID, { limit: 1 });
    expect(result.rankingExact).toBe(false);
    expect(metrics.getCounter('matching.recall_unproven')).toBe(1);
    expect(logger.warn).toHaveBeenCalled();
  });
});
