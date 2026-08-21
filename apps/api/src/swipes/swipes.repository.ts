import { Injectable } from '@nestjs/common';
import {
  ChatRoomType,
  ConsentType,
  RestrictionType,
  SwipeDirection,
  UserAccountStatus,
} from '@tripwith/shared';
import { DataSource, type EntityManager } from 'typeorm';

import { ConsentPolicyService } from '../consent/consent-policy.service';
import {
  MatchingNotEligibleError,
  SwipeAlreadyExistsError,
  SwipeTargetInvalidError,
} from './swipes.errors';
import type { PersistedMatch, PersistedSwipe, PersistSwipeResult } from './swipes.types';

interface CanonicalPairRow {
  readonly user_a_id: string;
  readonly user_b_id: string;
  readonly lock_key: string;
}

interface SwipeRow {
  readonly id: string;
  readonly target_user_id: string;
  readonly direction: SwipeDirection;
  readonly created_at: Date | string;
}

interface MatchRow {
  readonly id: string;
  readonly chat_room_id: string;
  readonly matched_at: Date | string;
}

/**
 * PostgreSQL authority for the swipe/match aggregate.
 *
 * A transaction-scoped advisory lock serialises the unordered user pair. The
 * schema's UNIQUE(source,target) and canonical UNIQUE(user_a,user_b) remain the
 * correctness backstops for callers that do not use this repository.
 */
@Injectable()
export class SwipesRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly consentPolicy: ConsentPolicyService,
  ) {}

  async persist(
    sourceUserId: string,
    targetUserId: string,
    direction: SwipeDirection,
  ): Promise<PersistSwipeResult> {
    return this.dataSource.transaction(async (manager) => {
      const pair = await this.canonicalPair(manager, sourceUserId, targetUserId);
      await manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        pair.lock_key,
      ]);

      await this.assertSourceEligible(manager, sourceUserId);
      await this.assertTargetEligible(manager, sourceUserId, targetUserId);

      const swipe = await this.insertOrResolveSwipe(
        manager,
        sourceUserId,
        targetUserId,
        direction,
      );

      let match: PersistedMatch | null = null;
      if (direction === SwipeDirection.Like) {
        const reciprocal = await manager.query(
          `SELECT 1
             FROM swipes
            WHERE source_user_id = $1
              AND target_user_id = $2
              AND direction = $3
            LIMIT 1`,
          [targetUserId, sourceUserId, SwipeDirection.Like],
        );
        if (reciprocal.length > 0) {
          match = await this.findOrCreateMatch(manager, pair);
        }
      }

      return { swipe, match };
    });
  }

  private async canonicalPair(
    manager: EntityManager,
    sourceUserId: string,
    targetUserId: string,
  ): Promise<CanonicalPairRow> {
    const [pair] = await manager.query(
      `SELECT LEAST($1::uuid, $2::uuid)::text AS user_a_id,
              GREATEST($1::uuid, $2::uuid)::text AS user_b_id,
              'tripwith.match:' || LEAST($1::uuid, $2::uuid)::text || ':' ||
                GREATEST($1::uuid, $2::uuid)::text AS lock_key`,
      [sourceUserId, targetUserId],
    );
    return pair as CanonicalPairRow;
  }

  private async assertSourceEligible(
    manager: EntityManager,
    sourceUserId: string,
  ): Promise<void> {
    const rows = await manager.query(
      `SELECT 1
         FROM users u
         JOIN user_profiles p ON p.user_id = u.id
         JOIN user_settings s ON s.user_id = u.id
        WHERE u.id = $1
          AND u.account_status = $2
          AND u.deleted_at IS NULL
          AND NOT EXISTS (
                SELECT 1
                  FROM account_restrictions ar
                 WHERE ar.user_id = u.id
                   AND ar.type IN ($3, $4)
                   AND ar.starts_at <= now()
                   AND (ar.ends_at IS NULL OR ar.ends_at > now())
                   AND ar.lifted_at IS NULL
              )
          AND $5 = (
                SELECT CASE WHEN c.granted THEN c.policy_version END
                  FROM user_consents c
                 WHERE c.user_id = u.id AND c.consent_type = $7
                 ORDER BY c.created_at DESC, c.id DESC
                 LIMIT 1
              )
          AND $6 = (
                SELECT CASE WHEN c.granted THEN c.policy_version END
                  FROM user_consents c
                 WHERE c.user_id = u.id AND c.consent_type = $8
                 ORDER BY c.created_at DESC, c.id DESC
                 LIMIT 1
              )`,
      [
        sourceUserId,
        UserAccountStatus.Active,
        RestrictionType.MatchingSuspended,
        RestrictionType.FullSuspension,
        this.consentPolicy.currentVersion(ConsentType.TermsOfService),
        this.consentPolicy.currentVersion(ConsentType.PrivacyPolicy),
        ConsentType.TermsOfService,
        ConsentType.PrivacyPolicy,
      ],
    );
    if (rows.length === 0) throw new MatchingNotEligibleError();
  }

  private async assertTargetEligible(
    manager: EntityManager,
    sourceUserId: string,
    targetUserId: string,
  ): Promise<void> {
    const rows = await manager.query(
      `SELECT 1
         FROM users source
         JOIN user_settings source_settings ON source_settings.user_id = source.id
         JOIN users target ON target.id = $2
         JOIN user_profiles target_profile ON target_profile.user_id = target.id
         JOIN user_settings target_settings ON target_settings.user_id = target.id
        WHERE source.id = $1
          AND target.account_status = $3
          AND target.deleted_at IS NULL
          AND target_settings.discovery_enabled
          AND NOT (
                target_settings.ghost_mode_enabled
                AND (
                  target_settings.ghost_mode_until IS NULL
                  OR target_settings.ghost_mode_until > now()
                )
              )
          AND EXTRACT(YEAR FROM age(CURRENT_DATE, target.date_of_birth))::int
                BETWEEN source_settings.min_age_preference
                    AND source_settings.max_age_preference
          AND EXTRACT(YEAR FROM age(CURRENT_DATE, source.date_of_birth))::int
                BETWEEN target_settings.min_age_preference
                    AND target_settings.max_age_preference
          AND target.trust_score >= source_settings.min_trust_score_preference
          AND NOT EXISTS (
                SELECT 1
                  FROM account_restrictions ar
                 WHERE ar.user_id = target.id
                   AND ar.type IN ($4, $5)
                   AND ar.starts_at <= now()
                   AND (ar.ends_at IS NULL OR ar.ends_at > now())
                   AND ar.lifted_at IS NULL
              )
          AND NOT EXISTS (
                SELECT 1
                  FROM user_blocks b
                 WHERE b.blocker_user_id = source.id
                   AND b.blocked_user_id = target.id
              )
          AND NOT EXISTS (
                SELECT 1
                  FROM user_blocks b
                 WHERE b.blocker_user_id = target.id
                   AND b.blocked_user_id = source.id
              )
          AND $6 = (
                SELECT CASE WHEN c.granted THEN c.policy_version END
                  FROM user_consents c
                 WHERE c.user_id = target.id AND c.consent_type = $8
                 ORDER BY c.created_at DESC, c.id DESC
                 LIMIT 1
              )
          AND $7 = (
                SELECT CASE WHEN c.granted THEN c.policy_version END
                  FROM user_consents c
                 WHERE c.user_id = target.id AND c.consent_type = $9
                 ORDER BY c.created_at DESC, c.id DESC
                 LIMIT 1
              )`,
      [
        sourceUserId,
        targetUserId,
        UserAccountStatus.Active,
        RestrictionType.MatchingSuspended,
        RestrictionType.FullSuspension,
        this.consentPolicy.currentVersion(ConsentType.TermsOfService),
        this.consentPolicy.currentVersion(ConsentType.PrivacyPolicy),
        ConsentType.TermsOfService,
        ConsentType.PrivacyPolicy,
      ],
    );
    if (rows.length === 0) throw new SwipeTargetInvalidError();
  }

  private async insertOrResolveSwipe(
    manager: EntityManager,
    sourceUserId: string,
    targetUserId: string,
    direction: SwipeDirection,
  ): Promise<PersistedSwipe> {
    const inserted = (await manager.query(
      `INSERT INTO swipes (source_user_id, target_user_id, direction)
       VALUES ($1, $2, $3)
       ON CONFLICT (source_user_id, target_user_id) DO NOTHING
       RETURNING id, target_user_id, direction, created_at`,
      [sourceUserId, targetUserId, direction],
    )) as SwipeRow[];

    const row =
      inserted[0] ??
      ((await manager.query(
        `SELECT id, target_user_id, direction, created_at
           FROM swipes
          WHERE source_user_id = $1 AND target_user_id = $2`,
        [sourceUserId, targetUserId],
      )) as SwipeRow[])[0];

    if (!row || row.direction !== direction) throw new SwipeAlreadyExistsError();
    return this.toSwipe(row);
  }

  private async findOrCreateMatch(
    manager: EntityManager,
    pair: CanonicalPairRow,
  ): Promise<PersistedMatch> {
    const existing = await this.findMatch(manager, pair);
    if (existing) {
      await this.ensureMembers(manager, existing.chatRoomId, pair);
      return existing;
    }

    const [room] = (await manager.query(
      `INSERT INTO chat_rooms (type) VALUES ($1) RETURNING id`,
      [ChatRoomType.Match],
    )) as { readonly id: string }[];
    if (!room) throw new Error('Failed to create match chat room');

    const inserted = (await manager.query(
      `INSERT INTO matches (user_a_id, user_b_id, chat_room_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_a_id, user_b_id) DO NOTHING
       RETURNING id, chat_room_id, matched_at`,
      [pair.user_a_id, pair.user_b_id, room.id],
    )) as MatchRow[];

    let match: PersistedMatch;
    if (inserted[0]) {
      match = this.toMatch(inserted[0]);
    } else {
      // A non-cooperating writer may have won the schema-level race. Its
      // canonical match is authoritative; remove this transaction's unused
      // room so no orphan survives.
      await manager.query(`DELETE FROM chat_rooms WHERE id = $1`, [room.id]);
      const resolved = await this.findMatch(manager, pair);
      if (!resolved) throw new Error('Canonical match disappeared during creation');
      match = resolved;
    }

    await this.ensureMembers(manager, match.chatRoomId, pair);
    return match;
  }

  private async findMatch(
    manager: EntityManager,
    pair: CanonicalPairRow,
  ): Promise<PersistedMatch | null> {
    const [row] = (await manager.query(
      `SELECT id, chat_room_id, matched_at
         FROM matches
        WHERE user_a_id = $1 AND user_b_id = $2`,
      [pair.user_a_id, pair.user_b_id],
    )) as MatchRow[];
    return row ? this.toMatch(row) : null;
  }

  private async ensureMembers(
    manager: EntityManager,
    roomId: string,
    pair: CanonicalPairRow,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO chat_members (room_id, user_id)
       VALUES ($1, $2), ($1, $3)
       ON CONFLICT (room_id, user_id) DO NOTHING`,
      [roomId, pair.user_a_id, pair.user_b_id],
    );
  }

  private toSwipe(row: SwipeRow): PersistedSwipe {
    return {
      id: row.id,
      targetUserId: row.target_user_id,
      direction: row.direction,
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    };
  }

  private toMatch(row: MatchRow): PersistedMatch {
    return {
      id: row.id,
      chatRoomId: row.chat_room_id,
      matchedAt: row.matched_at instanceof Date ? row.matched_at : new Date(row.matched_at),
    };
  }
}
