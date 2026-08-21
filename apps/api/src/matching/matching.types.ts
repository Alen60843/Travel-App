export interface MatchComponentView {
  readonly itinerary: number;
  readonly trust: number;
  readonly travelStyle: number;
  readonly interests: number;
}

/** Discovery-safe candidate representation. No DOB, contact, or itinerary coordinates. */
export interface MatchingCandidateView {
  readonly id: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly homeCountryCode: string | null;
  readonly languagesSpoken: readonly string[];
  readonly travelStyle: number;
  readonly trustScore: number;
  readonly commonInterestIds: readonly number[];
  readonly matchScore: number;
  readonly components: MatchComponentView;
}

export interface MatchingFeedView {
  readonly items: readonly MatchingCandidateView[];
  readonly nextCursor: string | null;
  readonly rankingExact: boolean;
  readonly generation: number;
}

export interface CachedRankedCandidate extends MatchingCandidateView {
  readonly userId: string;
  readonly score: number;
}

export interface CachedMatchingRanking {
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly nextUnscoredUpperBound: number | null;
  readonly nextBatchCursor: {
    readonly matchUpperBound: number;
    readonly userId: string;
  } | null;
  readonly ranked: readonly CachedRankedCandidate[];
}
