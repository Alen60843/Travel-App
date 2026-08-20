import { ReportStatus, ReportTargetType, RestrictionType, SosSessionStatus } from '@tripwith/shared';
import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import type { GeoPoint } from '../geo/geo-point';
import { bigintTransformer } from './transformers';

/**
 * SAFETY / SOS domain.
 *
 * PRIVACY INVARIANT (see the migration's top-of-file comment): no table
 * reachable from a discovery query stores a live GPS fix.
 * sos_location_updates is the ONE table in this schema holding one, and it
 * carries no spatial index by design — the only supported access pattern is
 * "latest fixes for one session", never a proximity query. Do not add a
 * @Index here even for local convenience; that would be a structural policy
 * change, not a mapping detail, and belongs in a reviewed migration.
 */

@Entity('account_restrictions')
export class AccountRestrictionEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({
    type: 'enum',
    enum: RestrictionType,
    enumName: 'restriction_type',
    name: 'type',
  })
  type!: RestrictionType;

  @Column({ type: 'text', name: 'reason' })
  reason!: string;

  /** NULL = automated (issued by a system job, not a moderator). */
  @Column({ type: 'uuid', name: 'issued_by_user_id', nullable: true })
  issuedByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'starts_at' })
  readonly startsAt!: Date;

  /** NULL = indefinite. */
  @Column({ type: 'timestamptz', name: 'ends_at', nullable: true })
  endsAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'lifted_at', nullable: true })
  liftedAt!: Date | null;

  @Column({ type: 'uuid', name: 'lifted_by_user_id', nullable: true })
  liftedByUserId!: string | null;

  /**
   * §16 forbids silent shadow-banning: a restriction with notified_at still
   * NULL past its grace window is an operational alert, not a normal state.
   */
  @Column({ type: 'timestamptz', name: 'notified_at', nullable: true })
  notifiedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;
}

@Entity('user_blocks')
export class UserBlockEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  @Column({ type: 'uuid', name: 'blocker_user_id' })
  blockerUserId!: string;

  @Column({ type: 'uuid', name: 'blocked_user_id' })
  blockedUserId!: string;

  @Column({ type: 'text', name: 'reason', nullable: true })
  reason!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;
}

@Entity('reports')
export class ReportEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  @Column({ type: 'uuid', name: 'reporter_user_id' })
  reporterUserId!: string;

  @Column({
    type: 'enum',
    enum: ReportTargetType,
    enumName: 'report_target_type',
    name: 'target_type',
  })
  targetType!: ReportTargetType;

  @Column({ type: 'uuid', name: 'target_user_id', nullable: true })
  targetUserId!: string | null;

  @Column({ type: 'uuid', name: 'target_event_id', nullable: true })
  targetEventId!: string | null;

  @Column({ type: 'uuid', name: 'target_provider_id', nullable: true })
  targetProviderId!: string | null;

  @Column({ type: 'uuid', name: 'target_review_id', nullable: true })
  targetReviewId!: string | null;

  @Column({ type: 'uuid', name: 'target_message_id', nullable: true })
  targetMessageId!: string | null;

  @Column({ type: 'text', name: 'category' })
  category!: string;

  @Column({ type: 'text', name: 'description', nullable: true })
  description!: string | null;

  @Column({
    type: 'enum',
    enum: ReportStatus,
    enumName: 'report_status',
    name: 'status',
  })
  status!: ReportStatus;

  @Column({ type: 'uuid', name: 'handled_by_user_id', nullable: true })
  handledByUserId!: string | null;

  @Column({ type: 'timestamptz', name: 'handled_at', nullable: true })
  handledAt!: Date | null;

  @Column({ type: 'text', name: 'resolution_note', nullable: true })
  resolutionNote!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  readonly updatedAt!: Date;
}

@Entity('sos_sessions')
export class SosSessionEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  /**
   * SHA-256 of the share token. Mapped as a Node Buffer (node-postgres's
   * native representation for bytea) rather than a hex string, so an
   * accidental `===` comparison against a string literal fails loudly
   * instead of always being false or, worse, coincidentally true.
   */
  @Column({ type: 'bytea', name: 'token_hash' })
  tokenHash!: Buffer;

  @Column({
    type: 'enum',
    enum: SosSessionStatus,
    enumName: 'sos_session_status',
    name: 'status',
  })
  status!: SosSessionStatus;

  @CreateDateColumn({ type: 'timestamptz', name: 'started_at' })
  readonly startedAt!: Date;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', name: 'revoked_at', nullable: true })
  revokedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'last_location_at', nullable: true })
  lastLocationAt!: Date | null;

  @Column({ type: 'text', name: 'note', nullable: true })
  note!: string | null;

  @Column({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;
}

@Entity('sos_location_updates')
export class SosLocationUpdateEntity {
  @PrimaryColumn({
    type: 'bigint',
    name: 'id',
    generated: 'identity',
    generatedIdentity: 'ALWAYS',
    transformer: bigintTransformer,
  })
  readonly id!: number;

  @Column({ type: 'uuid', name: 'session_id' })
  sessionId!: string;

  /** A live device fix — see the class-level PRIVACY INVARIANT comment above. */
  @Column({ type: 'geography', spatialFeatureType: 'Point', srid: 4326, name: 'location' })
  location!: GeoPoint;

  @Column({ type: 'real', name: 'accuracy_m', nullable: true })
  accuracyM!: number | null;

  @Column({ type: 'real', name: 'heading_deg', nullable: true })
  headingDeg!: number | null;

  @Column({ type: 'real', name: 'speed_mps', nullable: true })
  speedMps!: number | null;

  @Column({ type: 'timestamptz', name: 'recorded_at' })
  recordedAt!: Date;

  @Column({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;
}

/** §24 access logging — who looked at a live SOS session, and whether they were let in. */
@Entity('sos_access_log')
export class SosAccessLogEntity {
  @PrimaryColumn({
    type: 'bigint',
    name: 'id',
    generated: 'identity',
    generatedIdentity: 'ALWAYS',
    transformer: bigintTransformer,
  })
  readonly id!: number;

  @Column({ type: 'uuid', name: 'session_id' })
  sessionId!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'accessed_at' })
  readonly accessedAt!: Date;

  @Column({ type: 'inet', name: 'source_ip', nullable: true })
  sourceIp!: string | null;

  @Column({ type: 'text', name: 'user_agent', nullable: true })
  userAgent!: string | null;

  @Column({ type: 'boolean', name: 'was_granted' })
  wasGranted!: boolean;
}
