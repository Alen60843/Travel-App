import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { Inject, Injectable } from '@nestjs/common';

import { AppError, ValidationError } from '../common/errors/app-error';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { CacheService } from '../redis/cache.service';
import { LOGGER, METRICS } from '../observability/tokens';
import type { MetricsService } from '../observability/metrics.interface';
import type { PinoLoggerService } from '../observability/pino-logger.service';
import { CandidateRepository, type CandidateCursor } from './candidates';
import { FeedCursorCodec, type FeedCursorPayload } from './feed-cursor';
import { FeedGenerationService } from './feed-generation.service';
import {
  MatchingCursorInvalidError,
  MatchingCursorStaleError,
  MatchingNotEligibleError,
} from './matching.errors';
import { checkTopKExactness, scoreMatch, sortByExactScore } from './scoring';
import type { GetMatchingFeedQueryDto } from './dto/get-matching-feed-query.dto';
import type {
  CachedMatchingRanking,
  CachedRankedCandidate,
  MatchingCandidateView,
  MatchingFeedView,
} from './matching.types';

const DEFAULT_PAGE_SIZE = 20;
const SCORE_EPSILON = 1e-6;
const CACHE_FORMAT_VERSION = 1;

@Injectable()
export class MatchingService {
  private readonly cursorCodec: FeedCursorCodec;

  constructor(
    private readonly candidates: CandidateRepository,
    private readonly cache: CacheService,
    private readonly generations: FeedGenerationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(METRICS) private readonly metrics: MetricsService,
    @Inject(LOGGER) private readonly logger: PinoLoggerService,
  ) {
    this.cursorCodec = new FeedCursorCodec(config.matching.cursorSecret);
  }

  async getFeed(viewerId: string, query: GetMatchingFeedQueryDto): Promise<MatchingFeedView> {
    const requestStarted = performance.now();
    try {
      const limit = query.limit ?? DEFAULT_PAGE_SIZE;
      if (!Number.isInteger(limit) || limit < 1 || limit > this.config.matching.maxPageSize) {
        throw new ValidationError(
          `limit must be an integer from 1 to ${this.config.matching.maxPageSize}`,
          { field: 'limit' },
        );
      }

      const asOf = new Date();
      const policy = this.policyOptions(viewerId, asOf);
      if (!(await this.candidates.isViewerEligible(policy))) {
        throw new MatchingNotEligibleError();
      }

      const generation = await this.generations.current(viewerId);
      const filterHash = this.generations.filterHash({
        version: CACHE_FORMAT_VERSION,
        utcDate: asOf.toISOString().slice(0, 10),
        radiusKm: this.config.matching.anchorRadiusKm,
        pairWeights: this.config.matching.pairWeights,
        breadthBeta: this.config.matching.breadthBeta,
        candidateCap: this.config.matching.candidateCap,
        terms: this.config.consentPolicy.currentTermsOfServiceVersion,
        privacy: this.config.consentPolicy.currentPrivacyPolicyVersion,
      });
      let cursor = query.cursor ? this.cursorCodec.decode(query.cursor) : null;
      if (cursor && cursor.viewerId !== viewerId) {
        throw new MatchingCursorInvalidError();
      }
      if (
        cursor &&
        (cursor.generation !== generation || cursor.filterHash !== filterHash)
      ) {
        throw new MatchingCursorStaleError();
      }

      let batchKey = cursor?.batchKey ?? 'root';
      const cacheKey = this.generations.rankingKey(
        viewerId,
        generation,
        filterHash,
        batchKey,
      );
      let ranking = await this.cache.get<CachedMatchingRanking>(cacheKey);
      if (!this.isValidCachedRanking(ranking)) {
        if (ranking !== null) await this.cache.del(cacheKey);
        ranking = null;
      }

      if (ranking === null) {
        this.metrics.increment('matching.cache_miss');
        // A cursor names one immutable cache snapshot. Rebuilding the same key
        // after TTL expiry and continuing the old cursor would mix two feeds.
        if (cursor) throw new MatchingCursorStaleError();
        ranking = await this.generateRanking(viewerId, asOf, null);
        await this.cache.set(cacheKey, ranking, this.config.matching.feedTtlSeconds);
      } else {
        this.metrics.increment('matching.cache_hit');
      }

      if (cursor && cursor.snapshotId !== ranking.snapshotId) {
        throw new MatchingCursorStaleError();
      }

      if (
        cursor &&
        this.cursorPosition(ranking, cursor) === ranking.ranked.length &&
        ranking.nextBatchCursor
      ) {
        const continuationCursor = ranking.nextBatchCursor;
        batchKey = this.batchKey(continuationCursor);
        const continuationCacheKey = this.generations.rankingKey(
          viewerId,
          generation,
          filterHash,
          batchKey,
        );
        let continuation = await this.cache.get<CachedMatchingRanking>(
          continuationCacheKey,
        );
        if (!this.isValidCachedRanking(continuation)) {
          if (continuation !== null) await this.cache.del(continuationCacheKey);
          this.metrics.increment('matching.cache_miss');
          continuation = await this.generateRanking(
            viewerId,
            new Date(ranking.generatedAt),
            continuationCursor,
          );
          await this.cache.set(
            continuationCacheKey,
            continuation,
            this.config.matching.feedTtlSeconds,
          );
        } else {
          this.metrics.increment('matching.cache_hit');
        }
        ranking = continuation;
        cursor = null;
      }

      return await this.pageRanking({
        viewerId,
        ranking,
        generation,
        filterHash,
        batchKey,
        cursor,
        limit,
        asOf,
      });
    } catch (error) {
      this.metrics.increment('matching.error', 1, {
        code: error instanceof AppError ? error.code : 'INTERNAL',
      });
      throw error;
    } finally {
      this.metrics.timing('matching.request_ms', performance.now() - requestStarted);
    }
  }

  private async generateRanking(
    viewerId: string,
    asOf: Date,
    coarseCursor: CandidateCursor | null,
  ): Promise<CachedMatchingRanking> {
    const viewer = await this.candidates.loadViewerScoringContext({
      ...this.policyOptions(viewerId, asOf),
      maximumAnchorRadiusMeters: this.config.matching.anchorRadiusKm * 1_000,
    });
    if (!viewer) throw new MatchingNotEligibleError();

    const candidateStarted = performance.now();
    const coarse = await this.candidates.findCoarseCandidates({
      ...this.policyOptions(viewerId, asOf),
      maximumAnchorRadiusMeters: this.config.matching.anchorRadiusKm * 1_000,
      pairWeights: this.config.matching.pairWeights,
      exactScoreLimit: this.config.matching.candidateCap,
      ...(coarseCursor ? { cursor: coarseCursor } : {}),
    });
    this.metrics.timing(
      'matching.candidate_generation_ms',
      performance.now() - candidateStarted,
    );
    this.metrics.increment('matching.candidates_hard_filtered', coarse.hardFilteredCount);

    const scoringOptions = {
      anchorRadiusMeters: viewer.anchorRadiusMeters,
      breadthWeight: this.config.matching.breadthBeta,
      pairWeights: this.config.matching.pairWeights,
    } as const;
    const exact = coarse.candidates.map((candidate): CachedRankedCandidate => {
      const result = scoreMatch({
        viewerSegments: viewer.segments,
        candidateSegments: candidate.scoringSegments,
        candidateTrustScore: candidate.trustScore,
        viewerTravelStyle: viewer.travelStyle,
        candidateTravelStyle: candidate.travelStyle,
        viewerInterestIds: viewer.interestIds,
        candidateInterestIds: candidate.interestIds,
        itinerary: scoringOptions,
      });
      if (Math.abs(result.upperBound - candidate.matchUpperBound) > SCORE_EPSILON) {
        this.logger.error('SQL and TypeScript matching upper bounds diverged', {
          candidateId: candidate.userId,
        });
        throw new Error('Matching upper-bound parity failure');
      }
      const viewerInterests = new Set(viewer.interestIds);
      const commonInterestIds = candidate.interestIds
        .filter((id) => viewerInterests.has(id))
        .sort((left, right) => left - right);
      return {
        userId: candidate.userId,
        score: result.score,
        id: candidate.userId,
        displayName: candidate.displayName,
        avatarUrl: candidate.avatarUrl,
        homeCountryCode: candidate.homeCountryCode,
        languagesSpoken: candidate.languagesSpoken,
        travelStyle: candidate.travelStyle,
        trustScore: candidate.trustScore,
        commonInterestIds,
        matchScore: result.score,
        components: {
          itinerary: result.components.itinerary,
          trust: result.components.trust,
          travelStyle: result.components.travelStyle,
          interests: result.components.interests,
        },
      };
    });
    this.metrics.increment('matching.candidates_exact_scored', exact.length);

    const lastCoarse = coarse.candidates[coarse.candidates.length - 1];
    return {
      snapshotId: randomUUID(),
      generatedAt: asOf.toISOString(),
      nextUnscoredUpperBound: coarse.nextUnscored?.matchUpperBound ?? null,
      nextBatchCursor:
        coarse.nextUnscored && lastCoarse
          ? {
              matchUpperBound: lastCoarse.matchUpperBound,
              userId: lastCoarse.userId,
            }
          : null,
      ranked: sortByExactScore(exact),
    };
  }

  private async pageRanking(options: {
    readonly viewerId: string;
    readonly ranking: CachedMatchingRanking;
    readonly generation: number;
    readonly filterHash: string;
    readonly batchKey: string;
    readonly cursor: FeedCursorPayload | null;
    readonly limit: number;
    readonly asOf: Date;
  }): Promise<MatchingFeedView> {
    const { ranking, cursor, limit } = options;
    let position = cursor ? this.cursorPosition(ranking, cursor) : 0;

    const selected: CachedRankedCandidate[] = [];
    let lastExamined: CachedRankedCandidate | null = null;
    while (selected.length < limit && position < ranking.ranked.length) {
      const needed = limit - selected.length;
      const batch = ranking.ranked.slice(position, position + needed);
      if (batch.length === 0) break;
      const allowedIds = await this.candidates.revalidateCandidateIds({
        ...this.policyOptions(options.viewerId, options.asOf),
        candidateIds: batch.map(({ userId }) => userId),
      });
      const allowed = new Set(allowedIds);
      for (const candidate of batch) {
        if (allowed.has(candidate.userId)) selected.push(candidate);
      }
      const removed = batch.length - allowed.size;
      if (removed > 0) {
        this.metrics.increment('matching.cache_revalidated_removed', removed);
      }
      lastExamined = batch[batch.length - 1] ?? lastExamined;
      position += batch.length;
    }

    const exactness = checkTopKExactness(
      selected,
      Math.max(1, selected.length),
      ranking.nextUnscoredUpperBound,
    );
    const rankingExact =
      selected.length === 0
        ? ranking.nextUnscoredUpperBound === null
        : exactness.proven;
    if (!rankingExact) {
      this.metrics.increment('matching.recall_unproven');
      this.logger.warn('Matching recall proof condition was not met', {
        exactScored: ranking.ranked.length,
      });
    }

    const hasMore =
      position < ranking.ranked.length || ranking.nextBatchCursor !== null;
    return {
      items: selected.map((candidate) => this.toView(candidate)),
      nextCursor:
        hasMore && lastExamined
          ? this.cursorCodec.encode({
              viewerId: options.viewerId,
              generation: options.generation,
              filterHash: options.filterHash,
              batchKey: options.batchKey,
              snapshotId: ranking.snapshotId,
              lastScore: lastExamined.score,
              lastCandidateId: lastExamined.userId,
            })
          : null,
      rankingExact,
      generation: options.generation,
    };
  }

  private policyOptions(viewerId: string, asOf: Date) {
    return {
      viewerId,
      asOf,
      currentTermsOfServiceVersion:
        this.config.consentPolicy.currentTermsOfServiceVersion,
      currentPrivacyPolicyVersion:
        this.config.consentPolicy.currentPrivacyPolicyVersion,
    } as const;
  }

  private toView(candidate: CachedRankedCandidate): MatchingCandidateView {
    return {
      id: candidate.id,
      displayName: candidate.displayName,
      avatarUrl: candidate.avatarUrl,
      homeCountryCode: candidate.homeCountryCode,
      languagesSpoken: candidate.languagesSpoken,
      travelStyle: candidate.travelStyle,
      trustScore: candidate.trustScore,
      commonInterestIds: candidate.commonInterestIds,
      matchScore: candidate.matchScore,
      components: candidate.components,
    };
  }

  private cursorPosition(
    ranking: CachedMatchingRanking,
    cursor: FeedCursorPayload,
  ): number {
    const found = ranking.ranked.findIndex(
      (candidate) =>
        candidate.userId === cursor.lastCandidateId &&
        Math.abs(candidate.score - cursor.lastScore) <= Number.EPSILON,
    );
    if (found < 0) throw new MatchingCursorStaleError();
    return found + 1;
  }

  private batchKey(cursor: CandidateCursor): string {
    return createHash('sha256')
      .update(`${cursor.matchUpperBound}:${cursor.userId}`)
      .digest('hex')
      .slice(0, 24);
  }

  private isValidCachedRanking(value: CachedMatchingRanking | null): value is CachedMatchingRanking {
    if (
      value === null ||
      typeof value !== 'object' ||
      typeof value.snapshotId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(value.snapshotId) ||
      typeof value.generatedAt !== 'string' ||
      !Number.isFinite(new Date(value.generatedAt).getTime()) ||
      !Array.isArray(value.ranked) ||
      value.ranked.length > this.config.matching.candidateCap ||
      (value.nextUnscoredUpperBound !== null &&
        (!Number.isFinite(value.nextUnscoredUpperBound) ||
          value.nextUnscoredUpperBound < 0 ||
          value.nextUnscoredUpperBound > 1))
      || (value.nextBatchCursor !== null &&
        (typeof value.nextBatchCursor !== 'object' ||
          !Number.isFinite(value.nextBatchCursor.matchUpperBound) ||
          value.nextBatchCursor.matchUpperBound < 0 ||
          value.nextBatchCursor.matchUpperBound > 1 ||
          typeof value.nextBatchCursor.userId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            value.nextBatchCursor.userId,
          )))
    ) {
      return false;
    }
    return value.ranked.every(
      (candidate) =>
        candidate &&
        typeof candidate.userId === 'string' &&
        typeof candidate.id === 'string' &&
        candidate.id === candidate.userId &&
        typeof candidate.score === 'number' &&
        Number.isFinite(candidate.score) &&
        candidate.score >= 0 &&
        candidate.score <= 1 &&
        typeof candidate.displayName === 'string' &&
        Array.isArray(candidate.languagesSpoken) &&
        Array.isArray(candidate.commonInterestIds),
    );
  }
}
