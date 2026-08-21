import {
  checkTopKExactness,
  distanceMeters,
  scoreInterests,
  scoreItinerary,
  scoreMatch,
  scoreSegmentPair,
  scoreTravelStyle,
  scoreTrust,
  sortByExactScore,
} from './scoring';
import type { ItineraryScoringOptions, ScoringSegment } from './scoring.types';

const OPTIONS: ItineraryScoringOptions = {
  anchorRadiusMeters: 100_000,
  breadthWeight: 0.25,
  pairWeights: { destination: 0.2, temporal: 0.5, geographic: 0.3 },
};

function segment(
  overrides: Partial<ScoringSegment> = {},
): ScoringSegment {
  return {
    destinationPlaceId: 'place-paris',
    latitude: 48.8566,
    longitude: 2.3522,
    start: '2026-09-01',
    end: '2026-09-07',
    ...overrides,
  };
}

describe('pure matching score', () => {
  it('scores trust quality and every travel-style boundary', () => {
    expect(scoreTrust(0)).toBe(0);
    expect(scoreTrust(8.2)).toBeCloseTo(0.82);
    expect(scoreTrust(10)).toBe(1);
    for (let difference = 0; difference <= 4; difference += 1) {
      expect(scoreTravelStyle(1, 1 + difference)).toBe(1 - difference / 4);
    }
    expect(() => scoreTrust(10.01)).toThrow(RangeError);
    expect(() => scoreTravelStyle(0, 5)).toThrow(RangeError);
  });

  it('computes set Jaccard, de-duplicates ids, and defines empty/empty as zero', () => {
    expect(scoreInterests([], [])).toBe(0);
    expect(scoreInterests([1, 2], [2, 3])).toBeCloseTo(1 / 3);
    expect(scoreInterests([1, 1, 2], [1, 1, 2])).toBe(1);
    expect(scoreInterests([], [1, 2])).toBe(0);
    expect(() => scoreInterests([0], [1])).toThrow(RangeError);
  });

  it('scores destination, inclusive temporal overlap, and geographic proximity independently', () => {
    const same = scoreSegmentPair(segment(), segment(), OPTIONS);
    expect(same).toMatchObject({
      anchored: true,
      destination: 1,
      temporal: 1,
      geographic: 1,
      score: 1,
    });

    const touching = scoreSegmentPair(
      segment(),
      segment({ destinationPlaceId: 'other', start: '2026-09-07', end: '2026-09-12' }),
      OPTIONS,
    );
    expect(touching.anchored).toBe(true);
    expect(touching.destination).toBe(0);
    expect(touching.temporal).toBeCloseTo(1 / 6);
    expect(touching.geographic).toBe(1);

    const aboutHalfRadius = scoreSegmentPair(
      segment(),
      segment({ destinationPlaceId: null, latitude: 49.3062 }),
      OPTIONS,
    );
    expect(aboutHalfRadius.distanceMeters).toBeGreaterThan(49_000);
    expect(aboutHalfRadius.distanceMeters).toBeLessThan(51_000);
    expect(aboutHalfRadius.geographic).toBeCloseTo(0.5, 1);
  });

  it('gates non-overlapping and out-of-radius pairs to exactly zero', () => {
    expect(
      scoreSegmentPair(segment(), segment({ start: '2026-09-08', end: '2026-09-12' }), OPTIONS),
    ).toMatchObject({ anchored: false, score: 0 });
    expect(
      scoreSegmentPair(segment(), segment({ latitude: 51.5074, longitude: -0.1278 }), OPTIONS),
    ).toMatchObject({ anchored: false, score: 0 });
  });

  it('aggregates exact breadth instead of substituting the best pair', () => {
    const viewer = [
      segment(),
      segment({ destinationPlaceId: 'rome', latitude: 41.9028, longitude: 12.4964 }),
    ];
    const candidate = [segment()];
    const result = scoreItinerary(viewer, candidate, OPTIONS);
    expect(result.bestPair).toBe(1);
    expect(result.breadth).toBe(0.5);
    expect(result.score).toBe(0.875);
    expect(result.upperBound).toBe(1);
  });

  it('applies the canonical match weights and leaves the upper bound admissible', () => {
    const result = scoreMatch({
      viewerSegments: [segment()],
      candidateSegments: [segment()],
      candidateTrustScore: 8,
      viewerTravelStyle: 2,
      candidateTravelStyle: 4,
      viewerInterestIds: [1, 2],
      candidateInterestIds: [2, 3],
      itinerary: OPTIONS,
    });
    expect(result.components).toEqual({
      itinerary: 1,
      itineraryUpperBound: 1,
      trust: 0.8,
      travelStyle: 0.5,
      interests: 1 / 3,
    });
    expect(result.score).toBeCloseTo(0.4 + 0.24 + 0.1 + 1 / 30);
    expect(result.upperBound).toBeCloseTo(result.score);
  });

  it('sorts ties by user id without mutating input and checks the canonical proof cutoff', () => {
    const input = [
      { userId: 'b', score: 0.7 },
      { userId: 'c', score: 0.9 },
      { userId: 'a', score: 0.7 },
    ] as const;
    expect(sortByExactScore(input).map(({ userId }) => userId)).toEqual(['c', 'a', 'b']);
    expect(input[0].userId).toBe('b');
    expect(checkTopKExactness(input, 2, 0.7)).toEqual({
      proven: true,
      returnedCutoff: 0.7,
      nextUnscoredUpperBound: 0.7,
    });
    expect(checkTopKExactness(input, 2, 0.71).proven).toBe(false);
    expect(checkTopKExactness([], 10, null).proven).toBe(true);
  });

  it('rejects invalid scoring configuration rather than masking product/config drift', () => {
    expect(() => scoreItinerary([], [], { ...OPTIONS, anchorRadiusMeters: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      scoreItinerary([], [], {
        ...OPTIONS,
        pairWeights: { destination: 0.4, temporal: 0.5, geographic: 0.3 },
      }),
    ).toThrow(RangeError);
  });

  it('uses a symmetric, zero-at-identity geodesic', () => {
    const paris = segment();
    const london = segment({ latitude: 51.5074, longitude: -0.1278 });
    expect(distanceMeters(paris, paris)).toBe(0);
    expect(distanceMeters(paris, london)).toBeCloseTo(distanceMeters(london, paris), 8);
  });
});

describe('upper-bound randomized admissibility', () => {
  function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 2 ** 32;
    };
  }

  function randomSegment(next: () => number): ScoringSegment {
    const startDay = 1 + Math.floor(next() * 23);
    const duration = Math.floor(next() * 8);
    const start = `2026-09-${String(startDay).padStart(2, '0')}`;
    const end = `2026-09-${String(startDay + duration).padStart(2, '0')}`;
    return segment({
      destinationPlaceId: next() < 0.35 ? 'shared' : `place-${Math.floor(next() * 8)}`,
      latitude: 48.8566 + (next() - 0.5) * 4,
      longitude: 2.3522 + (next() - 0.5) * 4,
      start,
      end,
    });
  }

  it('proves M <= M_ub across broad deterministic generated segment sets', () => {
    const next = random(0x5eed1234);
    for (let sample = 0; sample < 2_000; sample += 1) {
      const viewer = Array.from({ length: Math.floor(next() * 6) }, () => randomSegment(next));
      const candidate = Array.from({ length: Math.floor(next() * 6) }, () => randomSegment(next));
      const result = scoreMatch({
        viewerSegments: viewer,
        candidateSegments: candidate,
        candidateTrustScore: next() * 10,
        viewerTravelStyle: 1 + Math.floor(next() * 5),
        candidateTravelStyle: 1 + Math.floor(next() * 5),
        viewerInterestIds: Array.from({ length: Math.floor(next() * 8) }, () => 1 + Math.floor(next() * 20)),
        candidateInterestIds: Array.from({ length: Math.floor(next() * 8) }, () => 1 + Math.floor(next() * 20)),
        itinerary: {
          ...OPTIONS,
          anchorRadiusMeters: 1 + next() * 300_000,
          breadthWeight: next(),
        },
      });
      expect(result.score).toBeGreaterThanOrEqual(-1e-12);
      expect(result.upperBound).toBeLessThanOrEqual(1 + 1e-12);
      expect(result.score).toBeLessThanOrEqual(result.upperBound + 1e-12);
    }
  });
});
