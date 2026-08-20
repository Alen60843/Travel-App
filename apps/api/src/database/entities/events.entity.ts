import {
  AttendanceStatus,
  EventHostType,
  EventStatus,
  EventVisibility,
  JoinRequestStatus,
} from '@tripwith/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

import type { GeoPoint } from '../geo/geo-point';
import { numericTransformer } from './transformers';

/**
 * EVENTS domain — event_categories is an editorial lookup table (like
 * interests/provider_category_types); events carry exactly one category via
 * a direct FK, unlike providers' many-to-many. event_status_history is
 * written exclusively by database triggers (tw_event_status_guard /
 * tw_event_status_seed) — this entity is read-only from the application's
 * side by construction (no code path here ever inserts into it).
 */

@Entity('event_categories')
export class EventCategoryEntity {
  @PrimaryColumn({ type: 'integer', name: 'id', generated: 'identity', generatedIdentity: 'ALWAYS' })
  readonly id!: number;

  @Column({ type: 'text', name: 'code' })
  code!: string;

  @Column({ type: 'text', name: 'label' })
  label!: string;

  @Column({ type: 'text', name: 'icon', nullable: true })
  icon!: string | null;

  @Column({ type: 'boolean', name: 'is_active' })
  isActive!: boolean;

  @Column({ type: 'smallint', name: 'sort_order' })
  sortOrder!: number;
}

@Entity('events')
export class EventEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  @Column({
    type: 'enum',
    enum: EventHostType,
    enumName: 'event_host_type',
    name: 'host_type',
  })
  hostType!: EventHostType;

  @Column({ type: 'uuid', name: 'host_user_id', nullable: true })
  hostUserId!: string | null;

  @Column({ type: 'uuid', name: 'host_provider_id', nullable: true })
  hostProviderId!: string | null;

  @Column({ type: 'integer', name: 'category_id' })
  categoryId!: number;

  @Column({ type: 'text', name: 'title' })
  title!: string;

  @Column({ type: 'text', name: 'description', nullable: true })
  description!: string | null;

  @Column({
    type: 'enum',
    enum: EventStatus,
    enumName: 'event_status',
    name: 'status',
  })
  status!: EventStatus;

  @Column({
    type: 'enum',
    enum: EventVisibility,
    enumName: 'event_visibility',
    name: 'visibility',
  })
  visibility!: EventVisibility;

  @Column({ type: 'integer', name: 'capacity_max' })
  capacityMax!: number;

  /** Trigger-maintained (tw_sync_participant_count) — never write. */
  @Column({
    type: 'integer',
    name: 'participant_count',
    insert: false,
    update: false,
  })
  readonly participantCount!: number;

  @Column({ type: 'integer', name: 'price_minor' })
  priceMinor!: number;

  @Column({ type: 'integer', name: 'deposit_minor' })
  depositMinor!: number;

  @Column({ type: 'character', length: 3, name: 'currency' })
  currency!: string;

  @Column({ type: 'timestamptz', name: 'starts_at' })
  startsAt!: Date;

  @Column({ type: 'timestamptz', name: 'ends_at' })
  endsAt!: Date;

  /**
   * GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED.
   * Same representation choice as trip_segments.date_range: the raw
   * PostgreSQL range literal text, read-only, never written by the app.
   */
  @Column({ type: 'tstzrange', name: 'time_range', nullable: true, insert: false, update: false })
  readonly timeRange!: string | null;

  /** A public meeting point the host chose — the only coordinate Explorer ever reads. */
  @Column({ type: 'geography', spatialFeatureType: 'Point', srid: 4326, name: 'meeting_point' })
  meetingPoint!: GeoPoint;

  @Column({ type: 'text', name: 'meeting_point_label', nullable: true })
  meetingPointLabel!: string | null;

  @Column({
    type: 'numeric',
    name: 'min_trust_score',
    precision: 5,
    scale: 2,
    transformer: numericTransformer,
  })
  minTrustScore!: number;

  @Column({ type: 'boolean', name: 'join_approval_required' })
  joinApprovalRequired!: boolean;

  @Column({ type: 'text', name: 'cancellation_policy', nullable: true })
  cancellationPolicy!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  readonly updatedAt!: Date;

  @Column({ type: 'timestamptz', name: 'cancelled_at', nullable: true })
  cancelledAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'completed_at', nullable: true })
  completedAt!: Date | null;

  @ManyToOne(() => EventCategoryEntity)
  @JoinColumn({ name: 'category_id' })
  category?: EventCategoryEntity;

  @OneToMany(() => EventStatusHistoryEntity, (history) => history.event)
  statusHistory?: EventStatusHistoryEntity[];
}

/** Append-only audit trail (§12), populated exclusively by database triggers. */
@Entity('event_status_history')
export class EventStatusHistoryEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  @Column({ type: 'uuid', name: 'event_id' })
  eventId!: string;

  @Column({
    type: 'enum',
    enum: EventStatus,
    enumName: 'event_status',
    name: 'from_status',
    nullable: true,
  })
  fromStatus!: EventStatus | null;

  @Column({
    type: 'enum',
    enum: EventStatus,
    enumName: 'event_status',
    name: 'to_status',
  })
  toStatus!: EventStatus;

  /** NULL means a system job made the transition, not a user. */
  @Column({ type: 'uuid', name: 'actor_user_id', nullable: true })
  actorUserId!: string | null;

  @Column({ type: 'text', name: 'reason', nullable: true })
  reason!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;

  @ManyToOne(() => EventEntity, (event) => event.statusHistory)
  @JoinColumn({ name: 'event_id' })
  event?: EventEntity;
}

@Entity('event_join_requests')
export class EventJoinRequestEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  @Column({ type: 'uuid', name: 'event_id' })
  eventId!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({
    type: 'enum',
    enum: JoinRequestStatus,
    enumName: 'join_request_status',
    name: 'status',
  })
  status!: JoinRequestStatus;

  @Column({ type: 'uuid', name: 'payment_id', nullable: true })
  paymentId!: string | null;

  @Column({ type: 'text', name: 'message', nullable: true })
  message!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'requested_at' })
  readonly requestedAt!: Date;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', name: 'approved_at', nullable: true })
  approvedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'rejected_at', nullable: true })
  rejectedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'cancelled_at', nullable: true })
  cancelledAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'expired_at', nullable: true })
  expiredAt!: Date | null;

  @Column({ type: 'uuid', name: 'decided_by_user_id', nullable: true })
  decidedByUserId!: string | null;

  /** Duplicate of requested_at in the schema (both DEFAULT now()); kept 1:1 with the DB. */
  @Column({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  readonly updatedAt!: Date;
}

@Entity('event_participants')
export class EventParticipantEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  @Column({ type: 'uuid', name: 'event_id' })
  eventId!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'uuid', name: 'join_request_id', nullable: true })
  joinRequestId!: string | null;

  @Column({ type: 'uuid', name: 'payment_id', nullable: true })
  paymentId!: string | null;

  @Column({ type: 'boolean', name: 'is_host' })
  isHost!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'joined_at' })
  readonly joinedAt!: Date;

  @Column({
    type: 'enum',
    enum: AttendanceStatus,
    enumName: 'attendance_status',
    name: 'attendance_status',
  })
  attendanceStatus!: AttendanceStatus;

  @Column({ type: 'timestamptz', name: 'checked_in_at', nullable: true })
  checkedInAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'cancelled_at', nullable: true })
  cancelledAt!: Date | null;

  /** Duplicate of joined_at in the schema (both DEFAULT now()); kept 1:1 with the DB. */
  @Column({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  readonly updatedAt!: Date;

  @ManyToOne(() => EventEntity)
  @JoinColumn({ name: 'event_id' })
  event?: EventEntity;
}
