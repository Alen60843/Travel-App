import { ModerationState, ReviewTargetType, TrustEventType } from '@tripwith/shared';
import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

import { numericTransformer } from './transformers';

/**
 * TRUST, REVIEWS domain. trust_score_events is the append-only ledger
 * (tw_forbid_mutation forbids UPDATE/DELETE at the database level) and the
 * sole writer of users.trust_score_raw via tw_apply_trust_delta — this
 * entity only ever supports INSERT from the application; there is no
 * update-shaped operation that would make sense to call on it.
 */

@Entity('reviews')
export class ReviewEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  @Column({ type: 'uuid', name: 'reviewer_user_id' })
  reviewerUserId!: string;

  @Column({
    type: 'enum',
    enum: ReviewTargetType,
    enumName: 'review_target_type',
    name: 'target_type',
  })
  targetType!: ReviewTargetType;

  @Column({ type: 'uuid', name: 'target_user_id', nullable: true })
  targetUserId!: string | null;

  @Column({ type: 'uuid', name: 'target_provider_id', nullable: true })
  targetProviderId!: string | null;

  @Column({ type: 'uuid', name: 'event_id', nullable: true })
  eventId!: string | null;

  @Column({ type: 'smallint', name: 'rating' })
  rating!: number;

  @Column({ type: 'text', name: 'body', nullable: true })
  body!: string | null;

  /**
   * TRUE only when the reviewer was a confirmed participant of event_id.
   * Unverified reviews never produce a trust delta (§15 anti-abuse) — that
   * rule lives in the service layer, this column only records the fact.
   */
  @Column({ type: 'boolean', name: 'is_verified' })
  isVerified!: boolean;

  @Column({
    type: 'enum',
    enum: ModerationState,
    enumName: 'moderation_state',
    name: 'moderation_state',
  })
  moderationState!: ModerationState;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  readonly updatedAt!: Date;

  @DeleteDateColumn({ type: 'timestamptz', name: 'deleted_at' })
  deletedAt!: Date | null;
}

/** The trust ledger. Append-only; see the class-level comment above. */
@Entity('trust_score_events')
export class TrustScoreEventEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  /** Subject whose score this event affects. */
  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  /** Counterparty, if any (e.g. the reviewer who triggered this event). */
  @Column({ type: 'uuid', name: 'source_user_id', nullable: true })
  sourceUserId!: string | null;

  @Column({ type: 'uuid', name: 'event_id', nullable: true })
  eventId!: string | null;

  @Column({ type: 'uuid', name: 'review_id', nullable: true })
  reviewId!: string | null;

  @Column({
    type: 'enum',
    enum: TrustEventType,
    enumName: 'trust_event_type',
    name: 'type',
  })
  type!: TrustEventType;

  @Column({
    type: 'numeric',
    name: 'delta',
    precision: 6,
    scale: 3,
    transformer: numericTransformer,
  })
  delta!: number;

  @Column({ type: 'text', name: 'reason', nullable: true })
  reason!: string | null;

  /** Moderation reverses by inserting a compensating row pointing here — nothing is ever edited. */
  @Column({ type: 'uuid', name: 'reverses_event_id', nullable: true })
  reversesEventId!: string | null;

  /** §4.4: replaying the same domain occurrence cannot double-count. */
  @Column({ type: 'text', name: 'idempotency_key' })
  idempotencyKey!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;
}
