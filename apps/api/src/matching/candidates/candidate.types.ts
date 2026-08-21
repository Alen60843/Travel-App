import type { ItineraryScoringOptions, ScoringSegment } from '../scoring';

export interface CandidateCursor {
  readonly matchUpperBound: number;
  readonly userId: string;
}

export interface CandidateQueryOptions {
  readonly viewerId: string;
  readonly asOf?: Date;
  readonly currentTermsOfServiceVersion: string;
  readonly currentPrivacyPolicyVersion: string;
  /** Deployment cap; the viewer's lower max-distance setting still wins. */
  readonly maximumAnchorRadiusMeters: number;
  readonly pairWeights: ItineraryScoringOptions['pairWeights'];
  /** N, excluding the one additional proof row fetched by the repository. */
  readonly exactScoreLimit: number;
  readonly cursor?: CandidateCursor;
}

export interface ViewerScoringContext {
  readonly userId: string;
  readonly travelStyle: number;
  readonly interestIds: readonly number[];
  readonly anchorRadiusMeters: number;
  readonly segments: readonly ScoringSegment[];
}

/**
 * Coarse candidate result. scoringSegments are internal matching inputs, not
 * an API representation: visibility policy decides which itinerary facts may
 * later be exposed to another traveller.
 */
export interface CandidateCoarseResult {
  readonly userId: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly homeCountryCode: string | null;
  readonly languagesSpoken: readonly string[];
  readonly age: number;
  readonly trustScore: number;
  readonly travelStyle: number;
  readonly interestIds: readonly number[];
  readonly itineraryUpperBound: number;
  readonly trustComponent: number;
  readonly travelStyleComponent: number;
  readonly interestComponent: number;
  readonly matchUpperBound: number;
  readonly scoringSegments: readonly ScoringSegment[];
}

export interface CandidateCoarseBatch {
  /** At most N rows to exact-score. */
  readonly candidates: readonly CandidateCoarseResult[];
  /** The N+1 row, retained only for the runtime exactness proof. */
  readonly nextUnscored: CandidateCoarseResult | null;
  readonly activeUniverseCount: number;
  readonly anchoredCandidateCount: number;
  /** Active non-self universe minus candidates surviving hard filters + anchor. */
  readonly hardFilteredCount: number;
}

export interface ViewerEligibilityOptions {
  readonly viewerId: string;
  readonly asOf?: Date;
  readonly currentTermsOfServiceVersion: string;
  readonly currentPrivacyPolicyVersion: string;
}

export interface ViewerScoringContextOptions extends ViewerEligibilityOptions {
  readonly maximumAnchorRadiusMeters: number;
}

export interface CandidateRevalidationOptions {
  readonly viewerId: string;
  readonly candidateIds: readonly string[];
  readonly asOf?: Date;
  readonly currentTermsOfServiceVersion: string;
  readonly currentPrivacyPolicyVersion: string;
}
