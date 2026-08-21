import { randomUUID } from 'node:crypto';

import { loadConfig } from '../config/configuration';
import { AppDataSource } from '../database/data-source';
import { InMemoryMetricsService } from '../observability/in-memory-metrics.service';
import type { PinoLoggerService } from '../observability/pino-logger.service';
import { CacheService } from '../redis/cache.service';
import { createCacheRedisConnection } from '../redis/redis-connection.factory';
import { CandidateRepository } from './candidates';
import { FeedGenerationService } from './feed-generation.service';
import { MatchingService } from './matching.service';

describe('Matching feed cache/privacy integration (live PostgreSQL + Redis)', () => {
  const config = loadConfig(process.env);
  const runId = randomUUID().replaceAll('-', '');
  const uidPrefix = `matching-feed-${runId}`;
  const redis = createCacheRedisConnection(config);
  const cache = new CacheService(redis);
  const generations = new FeedGenerationService(cache);
  const metrics = new InMemoryMetricsService();
  const logger = { warn: jest.fn(), error: jest.fn() } as unknown as PinoLoggerService;
  const repository = new CandidateRepository(AppDataSource);
  const service = new MatchingService(
    repository,
    cache,
    generations,
    config,
    metrics,
    logger,
  );
  let viewerId: string;
  let candidateId: string;

  beforeAll(async () => {
    await AppDataSource.initialize();
    await redis.ping();
    viewerId = await createUser('viewer');
    candidateId = await createUser('candidate');
    await addSegment(viewerId, 'Viewer private itinerary');
    await addSegment(candidateId, 'Candidate private itinerary');
  });

  afterAll(async () => {
    try {
      const date = new Date().toISOString().slice(0, 10);
      const filterHash = generations.filterHash({
        version: 1,
        utcDate: date,
        radiusKm: config.matching.anchorRadiusKm,
        pairWeights: config.matching.pairWeights,
        breadthBeta: config.matching.breadthBeta,
        candidateCap: config.matching.candidateCap,
        terms: config.consentPolicy.currentTermsOfServiceVersion,
        privacy: config.consentPolicy.currentPrivacyPolicyVersion,
      });
      await redis.del(
        `feed:gen:${viewerId}`,
        generations.rankingKey(viewerId, 0, filterHash),
        generations.rankingKey(viewerId, 1, filterHash),
      );
      await AppDataSource.transaction(async (manager) => {
        await manager.query(
          `ALTER TABLE user_consents DISABLE TRIGGER user_consents_append_only`,
        );
        await manager.query(`DELETE FROM users WHERE firebase_uid LIKE $1`, [
          `${uidPrefix}%`,
        ]);
        await manager.query(
          `ALTER TABLE user_consents ENABLE TRIGGER user_consents_append_only`,
        );
      });
    } finally {
      if (AppDataSource.isInitialized) await AppDataSource.destroy();
      await redis.quit();
    }
  });

  async function createUser(label: string): Promise<string> {
    const [user] = await AppDataSource.query(
      `INSERT INTO users
         (firebase_uid, email, email_verified_at, account_status, date_of_birth)
       VALUES ($1, $2, now(), 'ACTIVE', DATE '1990-01-01')
       RETURNING id`,
      [`${uidPrefix}-${label}`, `${runId}-${label}@example.test`],
    ) as { id: string }[];
    const id = user!.id;
    await AppDataSource.query(
      `INSERT INTO user_profiles
         (user_id, display_name, home_country_code, languages_spoken, travel_style)
       VALUES ($1, $2, 'JP', ARRAY['en'], 3)`,
      [id, `Feed ${label}`],
    );
    await AppDataSource.query(
      `INSERT INTO user_settings
         (user_id, discovery_enabled, max_distance_km)
       VALUES ($1, TRUE, 500)`,
      [id],
    );
    await AppDataSource.query(
      `INSERT INTO user_consents (user_id, consent_type, granted, policy_version)
       VALUES ($1, 'TERMS_OF_SERVICE', TRUE, $2),
              ($1, 'PRIVACY_POLICY', TRUE, $3)`,
      [
        id,
        config.consentPolicy.currentTermsOfServiceVersion,
        config.consentPolicy.currentPrivacyPolicyVersion,
      ],
    );
    return id;
  }

  async function addSegment(userId: string, title: string): Promise<void> {
    const start = new Date();
    start.setUTCDate(start.getUTCDate() + 10);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 4);
    const startDate = start.toISOString().slice(0, 10);
    const endDate = end.toISOString().slice(0, 10);
    const tripId = randomUUID();
    await AppDataSource.query(
      `INSERT INTO trips (id, user_id, title, start_date, end_date, visibility)
       VALUES ($1, $2, $3, $4, $5, 'PRIVATE')`,
      [tripId, userId, title, startDate, endDate],
    );
    await AppDataSource.query(
      `INSERT INTO trip_segments
         (trip_id, user_id, destination_place_id, destination_name, location,
          start_date, end_date, sort_order)
       VALUES ($1, $2, 'private-place', $3,
               ST_SetSRID(ST_MakePoint(139.6917, 35.6895), 4326)::geography,
               $4, $5, 0)`,
      [tripId, userId, title, startDate, endDate],
    );
  }

  it('uses cached ranking while immediately enforcing block, Ghost, and suspension changes', async () => {
    const first = await service.getFeed(viewerId, { limit: 10 });
    expect(first.items.map(({ id }) => id)).toEqual([candidateId]);
    expect(first.items[0]).not.toHaveProperty('scoringSegments');
    expect(first.items[0]).not.toHaveProperty('age');
    expect(metrics.getCounter('matching.cache_miss')).toBe(1);

    await AppDataSource.query(
      `INSERT INTO user_blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)`,
      [candidateId, viewerId],
    );
    await expect(service.getFeed(viewerId, { limit: 10 })).resolves.toMatchObject({
      items: [],
    });
    await AppDataSource.query(
      `DELETE FROM user_blocks WHERE blocker_user_id = $1 AND blocked_user_id = $2`,
      [candidateId, viewerId],
    );

    await AppDataSource.query(
      `UPDATE user_settings
          SET ghost_mode_enabled = TRUE,
              ghost_mode_until = now() + INTERVAL '1 day'
        WHERE user_id = $1`,
      [candidateId],
    );
    await expect(service.getFeed(viewerId, { limit: 10 })).resolves.toMatchObject({
      items: [],
    });
    await AppDataSource.query(
      `UPDATE user_settings
          SET ghost_mode_enabled = FALSE, ghost_mode_until = NULL
        WHERE user_id = $1`,
      [candidateId],
    );

    await AppDataSource.query(
      `INSERT INTO account_restrictions (user_id, type, reason, starts_at)
       VALUES ($1, 'MATCHING_SUSPENDED', 'feed integration restriction',
               now() - INTERVAL '1 second')`,
      [candidateId],
    );
    await expect(service.getFeed(viewerId, { limit: 10 })).resolves.toMatchObject({
      items: [],
    });
    expect(metrics.getCounter('matching.cache_hit')).toBe(3);
    expect(metrics.getCounter('matching.cache_revalidated_removed')).toBe(3);

    await AppDataSource.query(`DELETE FROM account_restrictions WHERE user_id = $1`, [
      candidateId,
    ]);

    await AppDataSource.query(
      `INSERT INTO swipes (source_user_id, target_user_id, direction)
       VALUES ($1, $2, 'PASS')`,
      [viewerId, candidateId],
    );
    await expect(service.getFeed(viewerId, { limit: 10 })).resolves.toMatchObject({
      items: [],
    });
    await AppDataSource.query(
      `DELETE FROM swipes WHERE source_user_id = $1 AND target_user_id = $2`,
      [viewerId, candidateId],
    );

    await expect(generations.bump(viewerId)).resolves.toBe(1);
    const regenerated = await service.getFeed(viewerId, { limit: 10 });
    expect(regenerated.generation).toBe(1);
    expect(regenerated.items.map(({ id }) => id)).toEqual([candidateId]);
    expect(metrics.getCounter('matching.cache_miss')).toBe(2);
    expect(metrics.getCounter('matching.cache_hit')).toBe(4);
    expect(metrics.getCounter('matching.cache_revalidated_removed')).toBe(4);
  });
});
