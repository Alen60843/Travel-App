import { normalizedOverlap, overlapDays } from '@tripwith/shared';

import type {
  ExactnessResult,
  ItineraryScore,
  ItineraryScoringOptions,
  MatchScore,
  MatchScoreInput,
  RankedScore,
  ScoringSegment,
  SegmentPairScore,
} from './scoring.types';

export const MATCH_SCORE_WEIGHTS = Object.freeze({
  itinerary: 0.4,
  trust: 0.3,
  travelStyle: 0.2,
  interests: 0.1,
});

// Mean Earth radius used by the spherical PostGIS distance mode in candidate SQL.
const EARTH_RADIUS_METERS = 6_371_008.7714;
const WEIGHT_TOLERANCE = 1e-12;

function assertFiniteInRange(name: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be in [${minimum}, ${maximum}]`);
  }
}

function validateItineraryOptions(options: ItineraryScoringOptions): void {
  if (!Number.isFinite(options.anchorRadiusMeters) || options.anchorRadiusMeters <= 0) {
    throw new RangeError('anchorRadiusMeters must be positive');
  }
  assertFiniteInRange('breadthWeight', options.breadthWeight, 0, 1);

  const { destination, temporal, geographic } = options.pairWeights;
  assertFiniteInRange('pairWeights.destination', destination, 0, 1);
  assertFiniteInRange('pairWeights.temporal', temporal, 0, 1);
  assertFiniteInRange('pairWeights.geographic', geographic, 0, 1);
  if (Math.abs(destination + temporal + geographic - 1) > WEIGHT_TOLERANCE) {
    throw new RangeError('segment pair weights must sum to 1');
  }
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Spherical geodesic distance. The haversine form is stable for nearby points. */
export function distanceMeters(a: ScoringSegment, b: ScoringSegment): number {
  assertFiniteInRange('latitude', a.latitude, -90, 90);
  assertFiniteInRange('longitude', a.longitude, -180, 180);
  assertFiniteInRange('latitude', b.latitude, -90, 90);
  assertFiniteInRange('longitude', b.longitude, -180, 180);

  const latitudeA = radians(a.latitude);
  const latitudeB = radians(b.latitude);
  const latitudeDelta = latitudeB - latitudeA;
  const longitudeDelta = radians(b.longitude - a.longitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

/** The formal p(a,b), including the mandatory date-and-distance co-presence gate. */
export function scoreSegmentPair(
  viewer: ScoringSegment,
  candidate: ScoringSegment,
  options: ItineraryScoringOptions,
): SegmentPairScore {
  validateItineraryOptions(options);
  const sharedDays = overlapDays(viewer, candidate);
  const distance = distanceMeters(viewer, candidate);
  const anchored = sharedDays > 0 && distance <= options.anchorRadiusMeters;
  if (!anchored) {
    return {
      anchored: false,
      destination: 0,
      temporal: 0,
      geographic: 0,
      distanceMeters: distance,
      score: 0,
    };
  }

  const destination = Number(
    viewer.destinationPlaceId !== null
      && candidate.destinationPlaceId !== null
      && viewer.destinationPlaceId === candidate.destinationPlaceId,
  );
  const temporal = normalizedOverlap(viewer, candidate);
  const geographic = Math.max(0, 1 - distance / options.anchorRadiusMeters);
  const score =
    options.pairWeights.destination * destination
    + options.pairWeights.temporal * temporal
    + options.pairWeights.geographic * geographic;

  return { anchored, destination, temporal, geographic, distanceMeters: distance, score };
}

/**
 * Exact multi-segment itinerary score. Breadth is viewer-oriented by design:
 * every viewer segment contributes its best candidate pairing.
 */
export function scoreItinerary(
  viewerSegments: readonly ScoringSegment[],
  candidateSegments: readonly ScoringSegment[],
  options: ItineraryScoringOptions,
): ItineraryScore {
  validateItineraryOptions(options);
  if (viewerSegments.length === 0 || candidateSegments.length === 0) {
    return { score: 0, upperBound: 0, bestPair: 0, breadth: 0 };
  }

  let bestPair = 0;
  let viewerBestSum = 0;
  for (const viewer of viewerSegments) {
    let viewerBest = 0;
    for (const candidate of candidateSegments) {
      const pair = scoreSegmentPair(viewer, candidate, options).score;
      viewerBest = Math.max(viewerBest, pair);
      bestPair = Math.max(bestPair, pair);
    }
    viewerBestSum += viewerBest;
  }

  const breadth = viewerBestSum / viewerSegments.length;
  const score =
    (1 - options.breadthWeight) * bestPair
    + options.breadthWeight * breadth;
  return { score, upperBound: bestPair, bestPair, breadth };
}

export function scoreTrust(candidateTrustScore: number): number {
  assertFiniteInRange('candidateTrustScore', candidateTrustScore, 0, 10);
  return candidateTrustScore / 10;
}

export function scoreTravelStyle(viewerStyle: number, candidateStyle: number): number {
  if (!Number.isInteger(viewerStyle) || !Number.isInteger(candidateStyle)) {
    throw new RangeError('travel styles must be integers');
  }
  assertFiniteInRange('viewerTravelStyle', viewerStyle, 1, 5);
  assertFiniteInRange('candidateTravelStyle', candidateStyle, 1, 5);
  return 1 - Math.abs(viewerStyle - candidateStyle) / 4;
}

function uniqueInterestSet(ids: readonly number[]): Set<number> {
  const result = new Set<number>();
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new RangeError('interest ids must be positive integers');
    }
    result.add(id);
  }
  return result;
}

/** Jaccard over Phase 3 active-interest projections. Empty/empty is deliberately 0. */
export function scoreInterests(viewerIds: readonly number[], candidateIds: readonly number[]): number {
  const viewer = uniqueInterestSet(viewerIds);
  const candidate = uniqueInterestSet(candidateIds);
  let intersection = 0;
  for (const id of viewer) {
    if (candidate.has(id)) intersection += 1;
  }
  const union = viewer.size + candidate.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function scoreMatch(input: MatchScoreInput): MatchScore {
  const itinerary = scoreItinerary(
    input.viewerSegments,
    input.candidateSegments,
    input.itinerary,
  );
  const trust = scoreTrust(input.candidateTrustScore);
  const travelStyle = scoreTravelStyle(input.viewerTravelStyle, input.candidateTravelStyle);
  const interests = scoreInterests(input.viewerInterestIds, input.candidateInterestIds);
  const fixed =
    MATCH_SCORE_WEIGHTS.trust * trust
    + MATCH_SCORE_WEIGHTS.travelStyle * travelStyle
    + MATCH_SCORE_WEIGHTS.interests * interests;
  const score = MATCH_SCORE_WEIGHTS.itinerary * itinerary.score + fixed;
  const upperBound = MATCH_SCORE_WEIGHTS.itinerary * itinerary.upperBound + fixed;

  return {
    score,
    upperBound,
    components: {
      itinerary: itinerary.score,
      itineraryUpperBound: itinerary.upperBound,
      trust,
      travelStyle,
      interests,
    },
  };
}

/** Returns a new deterministic exact order; input arrays are never mutated. */
export function sortByExactScore<T extends RankedScore>(candidates: readonly T[]): T[] {
  return [...candidates].sort(
    (a, b) => b.score - a.score || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
  );
}

/** Canonical U <= M(K) runtime proof check. A missing next row means exhaustion. */
export function checkTopKExactness(
  exactScores: readonly RankedScore[],
  requestedCount: number,
  nextUnscoredUpperBound: number | null,
): ExactnessResult {
  if (!Number.isInteger(requestedCount) || requestedCount <= 0) {
    throw new RangeError('requestedCount must be a positive integer');
  }
  if (
    nextUnscoredUpperBound !== null
    && (!Number.isFinite(nextUnscoredUpperBound)
      || nextUnscoredUpperBound < 0
      || nextUnscoredUpperBound > 1)
  ) {
    throw new RangeError('nextUnscoredUpperBound must be null or in [0, 1]');
  }

  const ordered = sortByExactScore(exactScores);
  const returnedIndex = Math.min(requestedCount, ordered.length) - 1;
  const returnedCutoff = returnedIndex >= 0 ? ordered[returnedIndex]!.score : null;
  const proven =
    nextUnscoredUpperBound === null
    || (returnedCutoff !== null && nextUnscoredUpperBound <= returnedCutoff);
  return { proven, returnedCutoff, nextUnscoredUpperBound };
}
