import type { DataSource } from 'typeorm';

import {
  CANDIDATE_GENERATION_SQL,
  CANDIDATE_REVALIDATION_SQL,
  PAIR_ELIGIBILITY_SQL,
  CandidateRepository,
} from './candidate.repository';
import type { CandidateQueryOptions } from './candidate.types';

const OPTIONS: CandidateQueryOptions = {
  viewerId: '00000000-0000-4000-8000-000000000001',
  asOf: new Date('2026-08-21T12:00:00Z'),
  currentTermsOfServiceVersion: 'tos-current',
  currentPrivacyPolicyVersion: 'privacy-current',
  maximumAnchorRadiusMeters: 100_000,
  pairWeights: { destination: 0.2, temporal: 0.5, geographic: 0.3 },
  exactScoreLimit: 1,
  filters: {
    homeCountryCode: 'FR',
    nativeLanguageCode: 'fr',
    minAge: 25,
    maxAge: 45,
    interestIds: [1, 2],
  },
};

function rawCandidate(id: string, upperBound: number) {
  return {
    candidateId: id,
    displayName: `User ${id}`,
    avatarUrl: null,
    homeCountryCode: 'FR',
    languagesSpoken: ['fr'],
    age: 30,
    trustScore: 5,
    travelStyle: 3,
    interestIds: [1],
    itineraryUpperBound: 1,
    trustComponent: 0.5,
    travelStyleComponent: 1,
    interestComponent: 1,
    matchUpperBound: upperBound,
    scoringSegments: [],
  };
}

describe('CandidateRepository SQL contract', () => {
  it('contains every hard-elimination and indexed anchor predicate', () => {
    expect(CANDIDATE_GENERATION_SQL).toContain("candidate.account_status = 'ACTIVE'");
    expect(CANDIDATE_GENERATION_SQL).toContain('candidate.deleted_at IS NULL');
    expect(CANDIDATE_GENERATION_SQL).toContain('settings.discovery_enabled');
    expect(CANDIDATE_GENERATION_SQL).toContain(
      'settings.ghost_mode_until > statement_timestamp()',
    );
    expect(CANDIDATE_GENERATION_SQL).toContain("restriction.type IN ('MATCHING_SUSPENDED', 'FULL_SUSPENSION')");
    expect(CANDIDATE_GENERATION_SQL).toContain('block.blocker_user_id = viewer.id');
    expect(CANDIDATE_GENERATION_SQL).toContain('block.blocked_user_id = viewer.id');
    expect(CANDIDATE_GENERATION_SQL).toContain('swipe.source_user_id = viewer.id');
    expect(CANDIDATE_GENERATION_SQL).toContain('BETWEEN viewer.min_age_preference');
    expect(CANDIDATE_GENERATION_SQL).toContain('BETWEEN settings.min_age_preference');
    expect(CANDIDATE_GENERATION_SQL).toContain('candidate.trust_score >= viewer.min_trust_score_preference');
    expect(CANDIDATE_GENERATION_SQL).toContain('profile.home_country_code = $12');
    expect(CANDIDATE_GENERATION_SQL).toContain('profile.native_language_code = $13');
    expect(CANDIDATE_GENERATION_SQL).toContain('candidate.date_of_birth');
    expect(CANDIDATE_GENERATION_SQL).toContain('selected_interest.interest_id = ANY($16');
    expect(CANDIDATE_GENERATION_SQL).toContain('interest.is_active');
    expect(CANDIDATE_GENERATION_SQL).toContain('candidate_segment.date_range && viewer_segment.date_range');
    expect(CANDIDATE_GENERATION_SQL).toContain('ST_DWithin(');
    expect(CANDIDATE_GENERATION_SQL).toContain('ORDER BY ranked.match_upper_bound DESC, ranked.candidate_id ASC');
    expect(CANDIDATE_GENERATION_SQL).not.toContain('OFFSET');
  });

  it('passes policy/config/cursor values only as parameters and splits N+1', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        activeUniverseCount: '9',
        anchoredCandidateCount: '2',
        hardFilteredCount: '7',
        candidateRows: [
          rawCandidate('00000000-0000-4000-8000-000000000002', 0.9),
          rawCandidate('00000000-0000-4000-8000-000000000003', 0.8),
        ],
      },
    ]);
    const repository = new CandidateRepository({ query } as unknown as DataSource);
    const result = await repository.findCoarseCandidates(OPTIONS);

    expect(result.candidates.map(({ userId }) => userId)).toEqual([
      '00000000-0000-4000-8000-000000000002',
    ]);
    expect(result.nextUnscored?.userId).toBe('00000000-0000-4000-8000-000000000003');
    expect(result).toMatchObject({
      activeUniverseCount: 9,
      anchoredCandidateCount: 2,
      hardFilteredCount: 7,
    });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toBe(CANDIDATE_GENERATION_SQL);
    expect(params).toEqual([
      OPTIONS.viewerId,
      OPTIONS.asOf,
      'tos-current',
      'privacy-current',
      100_000,
      0.2,
      0.5,
      0.3,
      null,
      null,
      2,
      'FR',
      'fr',
      25,
      45,
      [1, 2],
    ]);
  });

  it('validates tunables before issuing SQL', async () => {
    const query = jest.fn();
    const repository = new CandidateRepository({ query } as unknown as DataSource);
    await expect(
      repository.findCoarseCandidates({ ...OPTIONS, exactScoreLimit: 0 }),
    ).rejects.toThrow('exactScoreLimit');
    await expect(
      repository.findCoarseCandidates({
        ...OPTIONS,
        pairWeights: { destination: 0.8, temporal: 0.5, geographic: 0.3 },
      }),
    ).rejects.toThrow('sum to 1');
    await expect(
      repository.findCoarseCandidates({
        ...OPTIONS,
        filters: { ...OPTIONS.filters!, minAge: 50, maxAge: 40 },
      }),
    ).rejects.toThrow('minAge');
    expect(query).not.toHaveBeenCalled();
  });

  it('revalidates a de-duplicated bounded id list with the current policies', async () => {
    const candidateId = '00000000-0000-4000-8000-000000000002';
    const query = jest.fn().mockResolvedValue([{ candidateId }]);
    const repository = new CandidateRepository({ query } as unknown as DataSource);
    await expect(
      repository.revalidateCandidateIds({
        viewerId: OPTIONS.viewerId,
        candidateIds: [candidateId, candidateId],
        asOf: new Date('2026-08-21T12:00:00Z'),
        currentTermsOfServiceVersion: 'tos-current',
        currentPrivacyPolicyVersion: 'privacy-current',
      }),
    ).resolves.toEqual([candidateId]);
    expect(query).toHaveBeenCalledWith(CANDIDATE_REVALIDATION_SQL, [
      OPTIONS.viewerId,
      [candidateId],
      'tos-current',
      'privacy-current',
    ]);
  });

  it('uses a cheap fail-closed viewer eligibility query on cache hits', async () => {
    const query = jest.fn().mockResolvedValue([{ eligible: false }]);
    const repository = new CandidateRepository({ query } as unknown as DataSource);
    await expect(
      repository.isViewerEligible({
        viewerId: OPTIONS.viewerId,
        asOf: new Date('2026-08-21T12:00:00Z'),
        currentTermsOfServiceVersion: 'tos-current',
        currentPrivacyPolicyVersion: 'privacy-current',
      }),
    ).resolves.toBe(false);
    expect(String(query.mock.calls[0]?.[0])).toContain('SELECT EXISTS');
    expect(query.mock.calls[0]?.[1]).toEqual([
      OPTIONS.viewerId,
      'tos-current',
      'privacy-current',
    ]);
  });

  it('checks one direct-swipe pair through the authoritative current-state seam', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000002';
    const query = jest.fn().mockResolvedValue([{ eligible: true }]);
    const repository = new CandidateRepository({ query } as unknown as DataSource);
    await expect(repository.isPairEligible({
      viewerId: OPTIONS.viewerId,
      targetUserId,
      asOf: OPTIONS.asOf!,
      currentTermsOfServiceVersion: 'tos-current',
      currentPrivacyPolicyVersion: 'privacy-current',
      maximumAnchorRadiusMeters: 100_000,
    })).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(PAIR_ELIGIBILITY_SQL, [
      OPTIONS.viewerId,
      targetUserId,
      OPTIONS.asOf!,
      'tos-current',
      'privacy-current',
      100_000,
    ]);
    expect(PAIR_ELIGIBILITY_SQL).toContain('statement_timestamp()');
    expect(PAIR_ELIGIBILITY_SQL).toContain('target_segment.date_range && viewer_segment.date_range');
    expect(PAIR_ELIGIBILITY_SQL).toContain('ST_DWithin(');
  });
});
