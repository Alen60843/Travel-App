import { performance } from 'node:perf_hooks';

import { AppDataSource } from '../../database/data-source';
import { CandidateRepository } from '../candidates';
import { checkTopKExactness, scoreMatch, sortByExactScore } from '../scoring';

const CAPS = [50, 100, 200, 500] as const;
const PAIR_WEIGHTS = { destination: 0.2, temporal: 0.5, geographic: 0.3 } as const;
const BREADTH_WEIGHT = 0.25;
const MAXIMUM_RADIUS_METERS = 100_000;
const RETURN_COUNT = 20;
const AS_OF = new Date('2026-08-21T12:00:00.000Z');
const TOS = process.env.BENCHMARK_TOS_VERSION ?? 'tos-test-v1';
const PRIVACY = process.env.BENCHMARK_PRIVACY_VERSION ?? 'privacy-test-v1';

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
}

async function main(): Promise<void> {
  await AppDataSource.initialize();
  try {
    const repository = new CandidateRepository(AppDataSource);
    const viewers = await AppDataSource.query<{ id: string }[]>(
      `SELECT users.id::text
         FROM users
         JOIN user_settings settings ON settings.user_id = users.id
        WHERE users.firebase_uid LIKE 'phase4-bench-%'
          AND users.account_status = 'ACTIVE'
          AND settings.discovery_enabled
          AND NOT settings.ghost_mode_enabled
          AND NOT EXISTS (
                SELECT 1 FROM account_restrictions restriction
                 WHERE restriction.user_id = users.id
                   AND restriction.type IN ('MATCHING_SUSPENDED','FULL_SUSPENSION')
                   AND restriction.lifted_at IS NULL
              )
        ORDER BY users.firebase_uid
        LIMIT 24`,
    );
    if (viewers.length < 20) {
      throw new Error('Benchmark fixture missing; run matching:seed-benchmark first.');
    }

    const results: Record<string, unknown>[] = [];
    for (const cap of CAPS) {
      const sqlTimes: number[] = [];
      const scoringTimes: number[] = [];
      const totalTimes: number[] = [];
      const payloadSizes: number[] = [];
      let recallUnproven = 0;
      let exactScored = 0;
      let survivors = 0;

      for (const { id: viewerId } of viewers) {
        const totalStarted = performance.now();
        const viewer = await repository.loadViewerScoringContext({
          viewerId,
          asOf: AS_OF,
          currentTermsOfServiceVersion: TOS,
          currentPrivacyPolicyVersion: PRIVACY,
          maximumAnchorRadiusMeters: MAXIMUM_RADIUS_METERS,
        });
        if (!viewer) continue;
        const sqlStarted = performance.now();
        const batch = await repository.findCoarseCandidates({
          viewerId,
          asOf: AS_OF,
          currentTermsOfServiceVersion: TOS,
          currentPrivacyPolicyVersion: PRIVACY,
          maximumAnchorRadiusMeters: MAXIMUM_RADIUS_METERS,
          pairWeights: PAIR_WEIGHTS,
          exactScoreLimit: cap,
        });
        sqlTimes.push(performance.now() - sqlStarted);
        survivors += batch.anchoredCandidateCount;

        const scoringStarted = performance.now();
        const exact = batch.candidates.map((candidate) => {
          const result = scoreMatch({
            viewerSegments: viewer.segments,
            candidateSegments: candidate.scoringSegments,
            candidateTrustScore: candidate.trustScore,
            viewerTravelStyle: viewer.travelStyle,
            candidateTravelStyle: candidate.travelStyle,
            viewerInterestIds: viewer.interestIds,
            candidateInterestIds: candidate.interestIds,
            itinerary: {
              anchorRadiusMeters: viewer.anchorRadiusMeters,
              breadthWeight: BREADTH_WEIGHT,
              pairWeights: PAIR_WEIGHTS,
            },
          });
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
            commonInterestIds: candidate.interestIds.filter((interestId) =>
              viewer.interestIds.includes(interestId),
            ),
            matchScore: result.score,
            components: result.components,
          };
        });
        scoringTimes.push(performance.now() - scoringStarted);
        exactScored += exact.length;
        const ordered = sortByExactScore(exact);
        const proof = checkTopKExactness(
          ordered,
          RETURN_COUNT,
          batch.nextUnscored?.matchUpperBound ?? null,
        );
        if (!proof.proven) recallUnproven += 1;
        payloadSizes.push(Buffer.byteLength(JSON.stringify(ordered), 'utf8'));
        totalTimes.push(performance.now() - totalStarted);
      }

      results.push({
        candidateCap: cap,
        requests: sqlTimes.length,
        candidateSqlP50Ms: Number(percentile(sqlTimes, 0.5).toFixed(3)),
        candidateSqlP95Ms: Number(percentile(sqlTimes, 0.95).toFixed(3)),
        exactScoringP50Ms: Number(percentile(scoringTimes, 0.5).toFixed(3)),
        exactScoringP95Ms: Number(percentile(scoringTimes, 0.95).toFixed(3)),
        totalP50Ms: Number(percentile(totalTimes, 0.5).toFixed(3)),
        totalP95Ms: Number(percentile(totalTimes, 0.95).toFixed(3)),
        averageExactScored: Number((exactScored / sqlTimes.length).toFixed(1)),
        averageAnchoredSurvivors: Number((survivors / sqlTimes.length).toFixed(1)),
        recallUnprovenRate: Number((recallUnproven / sqlTimes.length).toFixed(4)),
        redisPayloadP95Bytes: percentile(payloadSizes, 0.95),
      });
    }

    const firstViewer = viewers[0]!.id;
    const plan = await repository.explainCoarseCandidates({
      viewerId: firstViewer,
      asOf: AS_OF,
      currentTermsOfServiceVersion: TOS,
      currentPrivacyPolicyVersion: PRIVACY,
      maximumAnchorRadiusMeters: MAXIMUM_RADIUS_METERS,
      pairWeights: PAIR_WEIGHTS,
      exactScoreLimit: 200,
    });
    const planText = JSON.stringify(plan);
    const indexesUsed = [...planText.matchAll(/"Index Name":"([^"]+)"/g)]
      .map((match) => match[1]!)
      .filter((value, index, all) => all.indexOf(value) === index)
      .sort();
    const planSummary = {
      usesCompositeTripGist: planText.includes('trip_segments_loc_range_gix'),
      usesSwipeIndex: planText.includes('swipes_source_idx'),
      usesBlockerIndex:
        planText.includes('user_blocks_blocker_idx')
        || planText.includes('user_blocks_pair_uk'),
      usesBlockedIndex: planText.includes('user_blocks_blocked_idx'),
      indexesUsed,
    };

    process.stdout.write(`${JSON.stringify({
      fixture: {
        users: 5001,
        segments: 10002,
        geographicClusters: 4,
        interests: 20,
        interestsPerUser: 4,
        sampledViewers: viewers.length,
      },
      parameters: {
        returnCount: RETURN_COUNT,
        maximumRadiusMeters: MAXIMUM_RADIUS_METERS,
        pairWeights: PAIR_WEIGHTS,
        breadthWeight: BREADTH_WEIGHT,
      },
      results,
      planSummary,
    }, null, 2)}\n`);
  } finally {
    await AppDataSource.destroy();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
