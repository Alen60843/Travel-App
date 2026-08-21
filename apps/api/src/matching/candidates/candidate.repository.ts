import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { scoreItinerary } from '../scoring';
import type { ScoringSegment } from '../scoring';
import type {
  CandidateCoarseBatch,
  CandidateCoarseResult,
  CandidateFilters,
  CandidateQueryOptions,
  CandidateRevalidationOptions,
  PairEligibilityOptions,
  ViewerEligibilityOptions,
  ViewerScoringContext,
  ViewerScoringContextOptions,
} from './candidate.types';

interface QueryExecutor {
  query<T = unknown>(query: string, parameters?: unknown[]): Promise<T>;
}

interface CandidateRawRow {
  readonly candidateId: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly homeCountryCode: string | null;
  readonly languagesSpoken: string[];
  readonly age: number;
  readonly trustScore: number;
  readonly travelStyle: number;
  readonly interestIds: number[];
  readonly itineraryUpperBound: number;
  readonly trustComponent: number;
  readonly travelStyleComponent: number;
  readonly interestComponent: number;
  readonly matchUpperBound: number;
  readonly scoringSegments: ScoringSegment[];
}

interface ViewerRawRow {
  readonly userId: string;
  readonly travelStyle: number;
  readonly interestIds: number[];
  readonly maxDistanceKm: number;
  readonly segments: ScoringSegment[];
}

interface CandidateBatchRawRow {
  readonly activeUniverseCount: string;
  readonly anchoredCandidateCount: string;
  readonly hardFilteredCount: string;
  readonly candidateRows: CandidateRawRow[];
}

/**
 * Parameter order is deliberately fixed and documented here. Keeping one
 * static SQL statement prevents dynamic filter fragments from becoming an
 * injection surface or silently changing the admissibility proof.
 */
export const CANDIDATE_GENERATION_SQL = `
WITH viewer AS MATERIALIZED (
  SELECT u.id,
         u.date_of_birth,
         p.travel_style,
         p.interest_ids,
         s.min_age_preference,
         s.max_age_preference,
         s.min_trust_score_preference,
         LEAST(s.max_distance_km * 1000.0, $5::double precision) AS anchor_radius_m
    FROM users u
    JOIN user_profiles p ON p.user_id = u.id
    JOIN user_settings s ON s.user_id = u.id
   WHERE u.id = $1::uuid
     AND u.account_status = 'ACTIVE'
     AND u.deleted_at IS NULL
     AND s.discovery_enabled
     AND NOT (
       s.ghost_mode_enabled
       AND (s.ghost_mode_until IS NULL OR s.ghost_mode_until > statement_timestamp())
     )
     AND COALESCE((
       SELECT consent.granted AND consent.policy_version = $3
         FROM user_consents consent
        WHERE consent.user_id = u.id
          AND consent.consent_type = 'TERMS_OF_SERVICE'
        ORDER BY consent.created_at DESC, consent.id DESC
        LIMIT 1
     ), FALSE)
     AND COALESCE((
       SELECT consent.granted AND consent.policy_version = $4
         FROM user_consents consent
        WHERE consent.user_id = u.id
          AND consent.consent_type = 'PRIVACY_POLICY'
        ORDER BY consent.created_at DESC, consent.id DESC
        LIMIT 1
     ), FALSE)
     AND NOT EXISTS (
       SELECT 1
         FROM account_restrictions restriction
        WHERE restriction.user_id = u.id
          AND restriction.type IN ('MATCHING_SUSPENDED', 'FULL_SUSPENSION')
          AND restriction.starts_at <= statement_timestamp()
          AND restriction.lifted_at IS NULL
          AND (restriction.ends_at IS NULL OR restriction.ends_at > statement_timestamp())
     )
),
viewer_segments AS MATERIALIZED (
  SELECT s.destination_place_id,
         s.location,
         s.start_date,
         s.end_date,
         s.date_range,
         v.anchor_radius_m
    FROM trip_segments s
    JOIN viewer v ON v.id = s.user_id
   WHERE s.end_date >= (($2::timestamptz AT TIME ZONE 'UTC')::date)
),
anchored_pairs AS MATERIALIZED (
  SELECT candidate_segment.user_id AS candidate_id,
         viewer_segment.destination_place_id AS viewer_destination_place_id,
         candidate_segment.destination_place_id AS candidate_destination_place_id,
         viewer_segment.start_date AS viewer_start_date,
         viewer_segment.end_date AS viewer_end_date,
         candidate_segment.start_date AS candidate_start_date,
         candidate_segment.end_date AS candidate_end_date,
         ST_Distance(
           viewer_segment.location,
           candidate_segment.location,
           FALSE
         ) AS distance_m,
         viewer_segment.anchor_radius_m
    FROM viewer_segments viewer_segment
    JOIN trip_segments candidate_segment
      ON candidate_segment.end_date >= (($2::timestamptz AT TIME ZONE 'UTC')::date)
     AND candidate_segment.date_range && viewer_segment.date_range
     AND ST_DWithin(
       candidate_segment.location,
       viewer_segment.location,
       viewer_segment.anchor_radius_m,
       FALSE
     )
),
anchored_scores AS MATERIALIZED (
  SELECT anchored.candidate_id,
         max(
           $6::double precision
           * CASE
               WHEN anchored.viewer_destination_place_id IS NOT NULL
                AND anchored.candidate_destination_place_id IS NOT NULL
                AND anchored.viewer_destination_place_id = anchored.candidate_destination_place_id
               THEN 1.0 ELSE 0.0
             END
         + $7::double precision
           * (
               (LEAST(anchored.viewer_end_date, anchored.candidate_end_date)
                 - GREATEST(anchored.viewer_start_date, anchored.candidate_start_date) + 1)::double precision
               / LEAST(
                   anchored.viewer_end_date - anchored.viewer_start_date + 1,
                   anchored.candidate_end_date - anchored.candidate_start_date + 1
                 )::double precision
             )
         + $8::double precision
           * GREATEST(
               0.0,
               1.0 - anchored.distance_m / anchored.anchor_radius_m
             )
         )::double precision AS itinerary_upper_bound
    FROM anchored_pairs anchored
   GROUP BY anchored.candidate_id
),
eligible AS MATERIALIZED (
  SELECT candidate.id AS candidate_id,
         profile.display_name,
         profile.avatar_url,
         profile.home_country_code,
         profile.languages_spoken,
         profile.travel_style,
         profile.interest_ids,
         candidate.trust_score::double precision AS trust_score,
         EXTRACT(YEAR FROM age(
           (($2::timestamptz AT TIME ZONE 'UTC')::date),
           candidate.date_of_birth
         ))::int AS candidate_age,
         candidate.trust_score::double precision / 10.0 AS trust_component,
         1.0 - abs(profile.travel_style - viewer.travel_style)::double precision / 4.0
           AS style_component,
         CASE
           WHEN icount(viewer.interest_ids | profile.interest_ids) = 0 THEN 0.0
           ELSE icount(viewer.interest_ids & profile.interest_ids)::double precision
                / icount(viewer.interest_ids | profile.interest_ids)::double precision
         END AS interest_component,
         viewer.anchor_radius_m,
         anchored.itinerary_upper_bound
    FROM anchored_scores anchored
    JOIN users candidate
      ON candidate.id = anchored.candidate_id
     AND candidate.account_status = 'ACTIVE'
     AND candidate.deleted_at IS NULL
    JOIN user_profiles profile ON profile.user_id = candidate.id
    JOIN user_settings settings ON settings.user_id = candidate.id
    CROSS JOIN viewer
   WHERE candidate.id <> viewer.id
     AND settings.discovery_enabled
     AND NOT (
       settings.ghost_mode_enabled
       AND (settings.ghost_mode_until IS NULL OR settings.ghost_mode_until > statement_timestamp())
     )
     AND candidate.trust_score >= viewer.min_trust_score_preference
     AND EXTRACT(YEAR FROM age(
           (($2::timestamptz AT TIME ZONE 'UTC')::date),
           candidate.date_of_birth
         ))::int BETWEEN viewer.min_age_preference AND viewer.max_age_preference
     AND EXTRACT(YEAR FROM age(
           (($2::timestamptz AT TIME ZONE 'UTC')::date),
           viewer.date_of_birth
         ))::int BETWEEN settings.min_age_preference AND settings.max_age_preference
     AND COALESCE((
       SELECT consent.granted AND consent.policy_version = $3
         FROM user_consents consent
        WHERE consent.user_id = candidate.id
          AND consent.consent_type = 'TERMS_OF_SERVICE'
        ORDER BY consent.created_at DESC, consent.id DESC
        LIMIT 1
     ), FALSE)
     AND COALESCE((
       SELECT consent.granted AND consent.policy_version = $4
         FROM user_consents consent
        WHERE consent.user_id = candidate.id
          AND consent.consent_type = 'PRIVACY_POLICY'
        ORDER BY consent.created_at DESC, consent.id DESC
        LIMIT 1
     ), FALSE)
     AND NOT EXISTS (
       SELECT 1
         FROM account_restrictions restriction
        WHERE restriction.user_id = candidate.id
          AND restriction.type IN ('MATCHING_SUSPENDED', 'FULL_SUSPENSION')
          AND restriction.starts_at <= statement_timestamp()
          AND restriction.lifted_at IS NULL
          AND (restriction.ends_at IS NULL OR restriction.ends_at > statement_timestamp())
     )
     AND NOT EXISTS (
       SELECT 1
         FROM user_blocks block
        WHERE block.blocker_user_id = viewer.id
          AND block.blocked_user_id = candidate.id
     )
     AND NOT EXISTS (
       SELECT 1
         FROM user_blocks block
        WHERE block.blocker_user_id = candidate.id
          AND block.blocked_user_id = viewer.id
     )
     AND NOT EXISTS (
       SELECT 1
         FROM swipes swipe
        WHERE swipe.source_user_id = viewer.id
          AND swipe.target_user_id = candidate.id
     )
     AND ($12::text IS NULL OR profile.home_country_code = $12::text)
     AND ($13::text IS NULL OR profile.native_language_code = $13::text)
     AND ($14::int IS NULL OR EXTRACT(YEAR FROM age(
           (($2::timestamptz AT TIME ZONE 'UTC')::date),
           candidate.date_of_birth
         ))::int >= $14::int)
     AND ($15::int IS NULL OR EXTRACT(YEAR FROM age(
           (($2::timestamptz AT TIME ZONE 'UTC')::date),
           candidate.date_of_birth
         ))::int <= $15::int)
     AND (
       $16::int[] IS NULL
       OR EXISTS (
         SELECT 1
           FROM user_interests selected_interest
           JOIN interests interest
             ON interest.id = selected_interest.interest_id
            AND interest.is_active
          WHERE selected_interest.user_id = candidate.id
            AND selected_interest.interest_id = ANY($16::int[])
       )
     )
),
ranked AS (
  SELECT eligible.*,
         (
           0.40 * eligible.itinerary_upper_bound
           + 0.30 * eligible.trust_component
           + 0.20 * eligible.style_component
           + 0.10 * eligible.interest_component
         )::double precision AS match_upper_bound
    FROM eligible
),
paged AS (
  SELECT ranked.*
    FROM ranked
   WHERE $9::double precision IS NULL
      OR ranked.match_upper_bound < $9::double precision
      OR (
        ranked.match_upper_bound = $9::double precision
        AND ranked.candidate_id > $10::uuid
      )
   ORDER BY ranked.match_upper_bound DESC, ranked.candidate_id ASC
   LIMIT $11::int
),
selected AS (
SELECT paged.candidate_id AS "candidateId",
       paged.display_name AS "displayName",
       paged.avatar_url AS "avatarUrl",
       paged.home_country_code AS "homeCountryCode",
       paged.languages_spoken AS "languagesSpoken",
       paged.candidate_age AS "age",
       paged.trust_score AS "trustScore",
       paged.travel_style AS "travelStyle",
       paged.interest_ids AS "interestIds",
       paged.itinerary_upper_bound AS "itineraryUpperBound",
       paged.trust_component AS "trustComponent",
       paged.style_component AS "travelStyleComponent",
       paged.interest_component AS "interestComponent",
       paged.match_upper_bound AS "matchUpperBound",
       segments.scoring_segments AS "scoringSegments"
  FROM paged
  CROSS JOIN LATERAL (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'destinationPlaceId', segment.destination_place_id,
          'latitude', ST_Y(segment.location::geometry),
          'longitude', ST_X(segment.location::geometry),
          'start', to_char(segment.start_date, 'YYYY-MM-DD'),
          'end', to_char(segment.end_date, 'YYYY-MM-DD')
        ) ORDER BY segment.start_date, segment.sort_order, segment.id
      ),
      '[]'::jsonb
    ) AS scoring_segments
      FROM trip_segments segment
     WHERE segment.user_id = paged.candidate_id
       AND segment.end_date >= (($2::timestamptz AT TIME ZONE 'UTC')::date)
  ) segments
),
diagnostics AS (
  SELECT (
           SELECT count(*)
             FROM users active_candidate
             JOIN viewer ON active_candidate.id <> viewer.id
            WHERE active_candidate.account_status = 'ACTIVE'
              AND active_candidate.deleted_at IS NULL
         ) AS active_universe_count,
         (SELECT count(*) FROM ranked) AS anchored_candidate_count
)
SELECT diagnostics.active_universe_count AS "activeUniverseCount",
       diagnostics.anchored_candidate_count AS "anchoredCandidateCount",
       GREATEST(
         0,
         diagnostics.active_universe_count - diagnostics.anchored_candidate_count
       ) AS "hardFilteredCount",
       COALESCE(
         jsonb_agg(
           to_jsonb(selected)
           ORDER BY selected."matchUpperBound" DESC, selected."candidateId" ASC
         ) FILTER (WHERE selected."candidateId" IS NOT NULL),
         '[]'::jsonb
       ) AS "candidateRows"
  FROM diagnostics
  LEFT JOIN selected ON TRUE
 GROUP BY diagnostics.active_universe_count, diagnostics.anchored_candidate_count`;

const VIEWER_SCORING_CONTEXT_SQL = `
SELECT users.id AS "userId",
       profile.travel_style AS "travelStyle",
       profile.interest_ids AS "interestIds",
       settings.max_distance_km AS "maxDistanceKm",
       COALESCE(
         jsonb_agg(
           jsonb_build_object(
             'destinationPlaceId', segment.destination_place_id,
             'latitude', ST_Y(segment.location::geometry),
             'longitude', ST_X(segment.location::geometry),
             'start', to_char(segment.start_date, 'YYYY-MM-DD'),
             'end', to_char(segment.end_date, 'YYYY-MM-DD')
           ) ORDER BY segment.start_date, segment.sort_order, segment.id
         ) FILTER (WHERE segment.id IS NOT NULL),
         '[]'::jsonb
       ) AS segments
  FROM users
  JOIN user_profiles profile ON profile.user_id = users.id
  JOIN user_settings settings ON settings.user_id = users.id
  LEFT JOIN trip_segments segment
    ON segment.user_id = users.id
   AND segment.end_date >= (($2::timestamptz AT TIME ZONE 'UTC')::date)
 WHERE users.id = $1::uuid
   AND users.account_status = 'ACTIVE'
   AND users.deleted_at IS NULL
   AND settings.discovery_enabled
   AND NOT (
     settings.ghost_mode_enabled
     AND (settings.ghost_mode_until IS NULL OR settings.ghost_mode_until > statement_timestamp())
   )
   AND COALESCE((
     SELECT consent.granted AND consent.policy_version = $3
       FROM user_consents consent
      WHERE consent.user_id = users.id
        AND consent.consent_type = 'TERMS_OF_SERVICE'
      ORDER BY consent.created_at DESC, consent.id DESC
      LIMIT 1
   ), FALSE)
   AND COALESCE((
     SELECT consent.granted AND consent.policy_version = $4
       FROM user_consents consent
      WHERE consent.user_id = users.id
        AND consent.consent_type = 'PRIVACY_POLICY'
      ORDER BY consent.created_at DESC, consent.id DESC
      LIMIT 1
   ), FALSE)
   AND NOT EXISTS (
     SELECT 1
       FROM account_restrictions restriction
      WHERE restriction.user_id = users.id
        AND restriction.type IN ('MATCHING_SUSPENDED', 'FULL_SUSPENSION')
        AND restriction.starts_at <= statement_timestamp()
        AND restriction.lifted_at IS NULL
        AND (restriction.ends_at IS NULL OR restriction.ends_at > statement_timestamp())
   )
 GROUP BY users.id, profile.travel_style, profile.interest_ids, settings.max_distance_km`;

const VIEWER_ELIGIBILITY_SQL = `
SELECT EXISTS (
  SELECT 1
    FROM users
    JOIN user_settings settings ON settings.user_id = users.id
   WHERE users.id = $1::uuid
     AND users.account_status = 'ACTIVE'
     AND users.deleted_at IS NULL
     AND settings.discovery_enabled
     AND NOT (
       settings.ghost_mode_enabled
       AND (settings.ghost_mode_until IS NULL OR settings.ghost_mode_until > statement_timestamp())
     )
     AND COALESCE((
       SELECT consent.granted AND consent.policy_version = $2
         FROM user_consents consent
        WHERE consent.user_id = users.id
          AND consent.consent_type = 'TERMS_OF_SERVICE'
        ORDER BY consent.created_at DESC, consent.id DESC
        LIMIT 1
     ), FALSE)
     AND COALESCE((
       SELECT consent.granted AND consent.policy_version = $3
         FROM user_consents consent
        WHERE consent.user_id = users.id
          AND consent.consent_type = 'PRIVACY_POLICY'
        ORDER BY consent.created_at DESC, consent.id DESC
        LIMIT 1
     ), FALSE)
     AND NOT EXISTS (
       SELECT 1
         FROM account_restrictions restriction
        WHERE restriction.user_id = users.id
          AND restriction.type IN ('MATCHING_SUSPENDED', 'FULL_SUSPENSION')
          AND restriction.starts_at <= statement_timestamp()
          AND restriction.lifted_at IS NULL
          AND (restriction.ends_at IS NULL OR restriction.ends_at > statement_timestamp())
     )
) AS eligible`;

/**
 * Authoritative hard-eligibility check for a single viewer/target pair.
 * Ranking and prior position are deliberately absent: this boundary answers
 * only whether a direct swipe is inside the current matching universe.
 */
export const PAIR_ELIGIBILITY_SQL = `
WITH viewer AS MATERIALIZED (
  SELECT users.id,
         users.date_of_birth,
         settings.min_age_preference,
         settings.max_age_preference,
         settings.min_trust_score_preference,
         LEAST(settings.max_distance_km * 1000.0, $6::double precision) AS anchor_radius_m
    FROM users
    JOIN user_profiles profile ON profile.user_id = users.id
    JOIN user_settings settings ON settings.user_id = users.id
   WHERE users.id = $1::uuid
     AND users.account_status = 'ACTIVE'
     AND users.deleted_at IS NULL
     AND settings.discovery_enabled
     AND NOT (
       settings.ghost_mode_enabled
       AND (settings.ghost_mode_until IS NULL OR settings.ghost_mode_until > statement_timestamp())
     )
     AND COALESCE((
       SELECT consent.granted AND consent.policy_version = $4
         FROM user_consents consent
        WHERE consent.user_id = users.id
          AND consent.consent_type = 'TERMS_OF_SERVICE'
        ORDER BY consent.created_at DESC, consent.id DESC
        LIMIT 1
     ), FALSE)
     AND COALESCE((
       SELECT consent.granted AND consent.policy_version = $5
         FROM user_consents consent
        WHERE consent.user_id = users.id
          AND consent.consent_type = 'PRIVACY_POLICY'
        ORDER BY consent.created_at DESC, consent.id DESC
        LIMIT 1
     ), FALSE)
     AND NOT EXISTS (
       SELECT 1 FROM account_restrictions restriction
        WHERE restriction.user_id = users.id
          AND restriction.type IN ('MATCHING_SUSPENDED', 'FULL_SUSPENSION')
          AND restriction.starts_at <= statement_timestamp()
          AND restriction.lifted_at IS NULL
          AND (restriction.ends_at IS NULL OR restriction.ends_at > statement_timestamp())
     )
)
SELECT EXISTS (
  SELECT 1
    FROM viewer
    JOIN users target ON target.id = $2::uuid
    JOIN user_profiles target_profile ON target_profile.user_id = target.id
    JOIN user_settings target_settings ON target_settings.user_id = target.id
   WHERE target.id <> viewer.id
     AND target.account_status = 'ACTIVE'
     AND target.deleted_at IS NULL
     AND target_settings.discovery_enabled
     AND NOT (
       target_settings.ghost_mode_enabled
       AND (target_settings.ghost_mode_until IS NULL OR target_settings.ghost_mode_until > statement_timestamp())
     )
     AND target.trust_score >= viewer.min_trust_score_preference
     AND EXTRACT(YEAR FROM age(
           (($3::timestamptz AT TIME ZONE 'UTC')::date), target.date_of_birth
         ))::int BETWEEN viewer.min_age_preference AND viewer.max_age_preference
     AND EXTRACT(YEAR FROM age(
           (($3::timestamptz AT TIME ZONE 'UTC')::date), viewer.date_of_birth
         ))::int BETWEEN target_settings.min_age_preference AND target_settings.max_age_preference
     AND COALESCE((
       SELECT consent.granted AND consent.policy_version = $4
         FROM user_consents consent
        WHERE consent.user_id = target.id
          AND consent.consent_type = 'TERMS_OF_SERVICE'
        ORDER BY consent.created_at DESC, consent.id DESC
        LIMIT 1
     ), FALSE)
     AND COALESCE((
       SELECT consent.granted AND consent.policy_version = $5
         FROM user_consents consent
        WHERE consent.user_id = target.id
          AND consent.consent_type = 'PRIVACY_POLICY'
        ORDER BY consent.created_at DESC, consent.id DESC
        LIMIT 1
     ), FALSE)
     AND NOT EXISTS (
       SELECT 1 FROM account_restrictions restriction
        WHERE restriction.user_id = target.id
          AND restriction.type IN ('MATCHING_SUSPENDED', 'FULL_SUSPENSION')
          AND restriction.starts_at <= statement_timestamp()
          AND restriction.lifted_at IS NULL
          AND (restriction.ends_at IS NULL OR restriction.ends_at > statement_timestamp())
     )
     AND NOT EXISTS (
       SELECT 1 FROM user_blocks block
        WHERE block.blocker_user_id = viewer.id
          AND block.blocked_user_id = target.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM user_blocks block
        WHERE block.blocker_user_id = target.id
          AND block.blocked_user_id = viewer.id
     )
     AND EXISTS (
       SELECT 1
         FROM trip_segments viewer_segment
         JOIN trip_segments target_segment
           ON target_segment.user_id = target.id
          AND target_segment.end_date >= (($3::timestamptz AT TIME ZONE 'UTC')::date)
          AND target_segment.date_range && viewer_segment.date_range
          AND ST_DWithin(
                target_segment.location,
                viewer_segment.location,
                viewer.anchor_radius_m,
                FALSE
              )
        WHERE viewer_segment.user_id = viewer.id
          AND viewer_segment.end_date >= (($3::timestamptz AT TIME ZONE 'UTC')::date)
     )
) AS eligible`;

export const CANDIDATE_REVALIDATION_SQL = `
WITH viewer AS (
  SELECT users.id
    FROM users
    JOIN user_settings settings ON settings.user_id = users.id
   WHERE users.id = $1::uuid
     AND users.account_status = 'ACTIVE'
     AND users.deleted_at IS NULL
     AND settings.discovery_enabled
     AND NOT (
       settings.ghost_mode_enabled
       AND (settings.ghost_mode_until IS NULL OR settings.ghost_mode_until > statement_timestamp())
     )
     AND COALESCE((
       SELECT consent.granted AND consent.policy_version = $3
         FROM user_consents consent
        WHERE consent.user_id = users.id
          AND consent.consent_type = 'TERMS_OF_SERVICE'
        ORDER BY consent.created_at DESC, consent.id DESC
        LIMIT 1
     ), FALSE)
     AND COALESCE((
       SELECT consent.granted AND consent.policy_version = $4
         FROM user_consents consent
        WHERE consent.user_id = users.id
          AND consent.consent_type = 'PRIVACY_POLICY'
        ORDER BY consent.created_at DESC, consent.id DESC
        LIMIT 1
     ), FALSE)
     AND NOT EXISTS (
       SELECT 1
         FROM account_restrictions restriction
        WHERE restriction.user_id = users.id
          AND restriction.type IN ('MATCHING_SUSPENDED', 'FULL_SUSPENSION')
          AND restriction.starts_at <= statement_timestamp()
          AND restriction.lifted_at IS NULL
          AND (restriction.ends_at IS NULL OR restriction.ends_at > statement_timestamp())
     )
)
SELECT requested.candidate_id AS "candidateId"
  FROM unnest($2::uuid[]) WITH ORDINALITY AS requested(candidate_id, ordinal)
  JOIN viewer ON TRUE
  JOIN users candidate
    ON candidate.id = requested.candidate_id
   AND candidate.account_status = 'ACTIVE'
   AND candidate.deleted_at IS NULL
  JOIN user_settings settings ON settings.user_id = candidate.id
 WHERE candidate.id <> $1::uuid
   AND settings.discovery_enabled
   AND NOT (
     settings.ghost_mode_enabled
     AND (settings.ghost_mode_until IS NULL OR settings.ghost_mode_until > statement_timestamp())
   )
   AND COALESCE((
     SELECT consent.granted AND consent.policy_version = $3
       FROM user_consents consent
      WHERE consent.user_id = candidate.id
        AND consent.consent_type = 'TERMS_OF_SERVICE'
      ORDER BY consent.created_at DESC, consent.id DESC
      LIMIT 1
   ), FALSE)
   AND COALESCE((
     SELECT consent.granted AND consent.policy_version = $4
       FROM user_consents consent
      WHERE consent.user_id = candidate.id
        AND consent.consent_type = 'PRIVACY_POLICY'
      ORDER BY consent.created_at DESC, consent.id DESC
      LIMIT 1
   ), FALSE)
   AND NOT EXISTS (
     SELECT 1
       FROM account_restrictions restriction
      WHERE restriction.user_id = candidate.id
        AND restriction.type IN ('MATCHING_SUSPENDED', 'FULL_SUSPENSION')
        AND restriction.starts_at <= statement_timestamp()
        AND restriction.lifted_at IS NULL
        AND (restriction.ends_at IS NULL OR restriction.ends_at > statement_timestamp())
   )
   AND NOT EXISTS (
     SELECT 1
       FROM user_blocks block
      WHERE block.blocker_user_id = viewer.id
        AND block.blocked_user_id = candidate.id
   )
   AND NOT EXISTS (
     SELECT 1
       FROM user_blocks block
      WHERE block.blocker_user_id = candidate.id
        AND block.blocked_user_id = viewer.id
   )
   AND NOT EXISTS (
     SELECT 1
       FROM swipes swipe
      WHERE swipe.source_user_id = viewer.id
        AND swipe.target_user_id = candidate.id
   )
 ORDER BY requested.ordinal`;

function assertOptions(options: CandidateQueryOptions): Date {
  const asOf = options.asOf ?? new Date();
  if (Number.isNaN(asOf.getTime())) throw new RangeError('asOf must be a valid Date');
  if (!options.currentTermsOfServiceVersion.trim()) {
    throw new RangeError('currentTermsOfServiceVersion must not be blank');
  }
  if (!options.currentPrivacyPolicyVersion.trim()) {
    throw new RangeError('currentPrivacyPolicyVersion must not be blank');
  }
  if (
    !Number.isFinite(options.maximumAnchorRadiusMeters)
    || options.maximumAnchorRadiusMeters <= 0
  ) {
    throw new RangeError('maximumAnchorRadiusMeters must be positive');
  }
  if (!Number.isInteger(options.exactScoreLimit) || options.exactScoreLimit < 1 || options.exactScoreLimit > 1_000) {
    throw new RangeError('exactScoreLimit must be an integer in [1, 1000]');
  }
  assertFilters(options.filters);
  // Reuse the pure scorer's authoritative option validation.
  scoreItinerary([], [], {
    anchorRadiusMeters: options.maximumAnchorRadiusMeters,
    breadthWeight: 0,
    pairWeights: options.pairWeights,
  });
  if (
    options.cursor
    && (!Number.isFinite(options.cursor.matchUpperBound)
      || options.cursor.matchUpperBound < 0
      || options.cursor.matchUpperBound > 1)
  ) {
    throw new RangeError('cursor.matchUpperBound must be in [0, 1]');
  }
  return asOf;
}

function assertFilters(filters: CandidateFilters | undefined): void {
  if (!filters) return;
  if (filters.homeCountryCode !== null && !/^[A-Z]{2}$/.test(filters.homeCountryCode)) {
    throw new RangeError('filters.homeCountryCode must be an ISO alpha-2 code');
  }
  if (filters.nativeLanguageCode !== null && !/^[a-z]{2,3}$/.test(filters.nativeLanguageCode)) {
    throw new RangeError('filters.nativeLanguageCode must be a lowercase language code');
  }
  for (const [field, value] of [['minAge', filters.minAge], ['maxAge', filters.maxAge]] as const) {
    if (value !== null && (!Number.isInteger(value) || value < 18 || value > 120)) {
      throw new RangeError(`filters.${field} must be an integer in [18, 120]`);
    }
  }
  if (filters.minAge !== null && filters.maxAge !== null && filters.minAge > filters.maxAge) {
    throw new RangeError('filters.minAge must not exceed filters.maxAge');
  }
  if (
    filters.interestIds.length > 20
    || new Set(filters.interestIds).size !== filters.interestIds.length
    || filters.interestIds.some((id) => !Number.isInteger(id) || id < 1)
  ) {
    throw new RangeError('filters.interestIds must contain at most 20 unique positive integers');
  }
}

function parameters(options: CandidateQueryOptions, asOf: Date): readonly unknown[] {
  return [
    options.viewerId,
    asOf,
    options.currentTermsOfServiceVersion,
    options.currentPrivacyPolicyVersion,
    options.maximumAnchorRadiusMeters,
    options.pairWeights.destination,
    options.pairWeights.temporal,
    options.pairWeights.geographic,
    options.cursor?.matchUpperBound ?? null,
    options.cursor?.userId ?? null,
    options.exactScoreLimit + 1,
    options.filters?.homeCountryCode ?? null,
    options.filters?.nativeLanguageCode ?? null,
    options.filters?.minAge ?? null,
    options.filters?.maxAge ?? null,
    options.filters && options.filters.interestIds.length > 0
      ? [...options.filters.interestIds]
      : null,
  ];
}

function mapCandidate(row: CandidateRawRow): CandidateCoarseResult {
  return {
    userId: row.candidateId,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    homeCountryCode: row.homeCountryCode,
    languagesSpoken: row.languagesSpoken,
    age: Number(row.age),
    trustScore: Number(row.trustScore),
    travelStyle: Number(row.travelStyle),
    interestIds: row.interestIds,
    itineraryUpperBound: Number(row.itineraryUpperBound),
    trustComponent: Number(row.trustComponent),
    travelStyleComponent: Number(row.travelStyleComponent),
    interestComponent: Number(row.interestComponent),
    matchUpperBound: Number(row.matchUpperBound),
    scoringSegments: row.scoringSegments,
  };
}

@Injectable()
export class CandidateRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async findCoarseCandidates(options: CandidateQueryOptions): Promise<CandidateCoarseBatch> {
    const asOf = assertOptions(options);
    const rows = await this.dataSource.query<CandidateBatchRawRow[]>(
      CANDIDATE_GENERATION_SQL,
      [...parameters(options, asOf)],
    );
    const batch = rows[0] ?? {
      activeUniverseCount: '0',
      anchoredCandidateCount: '0',
      hardFilteredCount: '0',
      candidateRows: [],
    };
    const mapped = batch.candidateRows.map(mapCandidate);
    return {
      candidates: mapped.slice(0, options.exactScoreLimit),
      nextUnscored: mapped[options.exactScoreLimit] ?? null,
      activeUniverseCount: Number(batch.activeUniverseCount),
      anchoredCandidateCount: Number(batch.anchoredCandidateCount),
      hardFilteredCount: Number(batch.hardFilteredCount),
    };
  }

  async isPairEligible(
    options: PairEligibilityOptions,
    executor: QueryExecutor = this.dataSource,
  ): Promise<boolean> {
    if (!options.currentTermsOfServiceVersion.trim()) {
      throw new RangeError('currentTermsOfServiceVersion must not be blank');
    }
    if (!options.currentPrivacyPolicyVersion.trim()) {
      throw new RangeError('currentPrivacyPolicyVersion must not be blank');
    }
    if (
      !Number.isFinite(options.maximumAnchorRadiusMeters)
      || options.maximumAnchorRadiusMeters <= 0
    ) {
      throw new RangeError('maximumAnchorRadiusMeters must be positive');
    }
    const asOf = options.asOf ?? new Date();
    if (Number.isNaN(asOf.getTime())) throw new RangeError('asOf must be a valid Date');
    const rows = await executor.query<{ eligible: boolean }[]>(PAIR_ELIGIBILITY_SQL, [
      options.viewerId,
      options.targetUserId,
      asOf,
      options.currentTermsOfServiceVersion,
      options.currentPrivacyPolicyVersion,
      options.maximumAnchorRadiusMeters,
    ]);
    return rows[0]?.eligible === true;
  }

  /** Cheap cache-hit boundary that does not aggregate itinerary segments. */
  async isViewerEligible(options: ViewerEligibilityOptions): Promise<boolean> {
    if (!options.currentTermsOfServiceVersion.trim()) {
      throw new RangeError('currentTermsOfServiceVersion must not be blank');
    }
    if (!options.currentPrivacyPolicyVersion.trim()) {
      throw new RangeError('currentPrivacyPolicyVersion must not be blank');
    }
    const asOf = options.asOf ?? new Date();
    if (Number.isNaN(asOf.getTime())) throw new RangeError('asOf must be a valid Date');
    const rows = await this.dataSource.query<{ eligible: boolean }[]>(VIEWER_ELIGIBILITY_SQL, [
      options.viewerId,
      options.currentTermsOfServiceVersion,
      options.currentPrivacyPolicyVersion,
    ]);
    return rows[0]?.eligible === true;
  }

  async loadViewerScoringContext(
    options: ViewerScoringContextOptions,
  ): Promise<ViewerScoringContext | null> {
    if (
      !Number.isFinite(options.maximumAnchorRadiusMeters)
      || options.maximumAnchorRadiusMeters <= 0
    ) {
      throw new RangeError('maximumAnchorRadiusMeters must be positive');
    }
    if (!options.currentTermsOfServiceVersion.trim()) {
      throw new RangeError('currentTermsOfServiceVersion must not be blank');
    }
    if (!options.currentPrivacyPolicyVersion.trim()) {
      throw new RangeError('currentPrivacyPolicyVersion must not be blank');
    }
    const asOf = options.asOf ?? new Date();
    if (Number.isNaN(asOf.getTime())) throw new RangeError('asOf must be a valid Date');
    const rows = await this.dataSource.query<ViewerRawRow[]>(
      VIEWER_SCORING_CONTEXT_SQL,
      [
        options.viewerId,
        asOf,
        options.currentTermsOfServiceVersion,
        options.currentPrivacyPolicyVersion,
      ],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      userId: row.userId,
      travelStyle: Number(row.travelStyle),
      interestIds: row.interestIds,
      anchorRadiusMeters: Math.min(
        Number(row.maxDistanceKm) * 1_000,
        options.maximumAnchorRadiusMeters,
      ),
      segments: row.segments,
    };
  }

  /**
   * Zero-staleness privacy gate for a cached page. Ranking may be stale for
   * its short TTL; these authoritative predicates may not be.
   */
  async revalidateCandidateIds(options: CandidateRevalidationOptions): Promise<string[]> {
    if (options.candidateIds.length === 0) return [];
    if (options.candidateIds.length > 1_000) {
      throw new RangeError('candidate revalidation is limited to 1000 ids');
    }
    if (!options.currentTermsOfServiceVersion.trim()) {
      throw new RangeError('currentTermsOfServiceVersion must not be blank');
    }
    if (!options.currentPrivacyPolicyVersion.trim()) {
      throw new RangeError('currentPrivacyPolicyVersion must not be blank');
    }
    const asOf = options.asOf ?? new Date();
    if (Number.isNaN(asOf.getTime())) throw new RangeError('asOf must be a valid Date');
    const rows = await this.dataSource.query<{ candidateId: string }[]>(
      CANDIDATE_REVALIDATION_SQL,
      [
        options.viewerId,
        [...new Set(options.candidateIds)],
        options.currentTermsOfServiceVersion,
        options.currentPrivacyPolicyVersion,
      ],
    );
    return rows.map(({ candidateId }) => candidateId);
  }

  /** Read-only hook for benchmark/review code; never used on the request path. */
  async explainCoarseCandidates(options: CandidateQueryOptions): Promise<unknown> {
    const asOf = assertOptions(options);
    return this.dataSource.query(
      `EXPLAIN (ANALYZE TRUE, BUFFERS TRUE, FORMAT JSON, COSTS TRUE) ${CANDIDATE_GENERATION_SQL}`,
      [...parameters(options, asOf)],
    );
  }
}
