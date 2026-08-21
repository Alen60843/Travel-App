import type { DateRange } from '@tripwith/shared';

/** Minimal, internal-only itinerary data required by the scoring algorithm. */
export interface ScoringSegment extends DateRange {
  readonly destinationPlaceId: string | null;
  readonly latitude: number;
  readonly longitude: number;
}

export interface SegmentPairWeights {
  readonly destination: number;
  readonly temporal: number;
  readonly geographic: number;
}

export interface ItineraryScoringOptions {
  /** Co-presence radius in metres. */
  readonly anchorRadiusMeters: number;
  /** Weight assigned to breadth in the exact itinerary aggregate. */
  readonly breadthWeight: number;
  readonly pairWeights: SegmentPairWeights;
}

export interface SegmentPairScore {
  readonly anchored: boolean;
  readonly destination: number;
  readonly temporal: number;
  readonly geographic: number;
  readonly distanceMeters: number;
  readonly score: number;
}

export interface ItineraryScore {
  readonly score: number;
  /** p*: the admissible SQL itinerary upper bound. */
  readonly upperBound: number;
  readonly bestPair: number;
  readonly breadth: number;
}

export interface MatchScoreInput {
  readonly viewerSegments: readonly ScoringSegment[];
  readonly candidateSegments: readonly ScoringSegment[];
  readonly candidateTrustScore: number;
  readonly viewerTravelStyle: number;
  readonly candidateTravelStyle: number;
  /** Phase 3's active-interest matching projections. */
  readonly viewerInterestIds: readonly number[];
  readonly candidateInterestIds: readonly number[];
  readonly itinerary: ItineraryScoringOptions;
}

export interface MatchScore {
  readonly score: number;
  readonly upperBound: number;
  readonly components: {
    readonly itinerary: number;
    readonly itineraryUpperBound: number;
    readonly trust: number;
    readonly travelStyle: number;
    readonly interests: number;
  };
}

export interface RankedScore {
  readonly userId: string;
  readonly score: number;
}

export interface ExactnessResult {
  readonly proven: boolean;
  readonly returnedCutoff: number | null;
  readonly nextUnscoredUpperBound: number | null;
}
