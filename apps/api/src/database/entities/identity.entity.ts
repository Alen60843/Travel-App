import { UserAccountStatus, TripVisibility, ConsentType } from '@tripwith/shared';
import { Column, CreateDateColumn, DeleteDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import { numericTransformer } from './transformers';

/**
 * IDENTITY domain — users, their profile/settings and the GDPR consent
 * ledger. Mirrors the "IDENTITY" section of the initial migration 1:1.
 */

@Entity('users')
export class UserEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  /** The ONLY link to Firebase. Populated exclusively from a verified ID token. */
  @Column({ type: 'text', name: 'firebase_uid' })
  firebaseUid!: string;

  @Column({ type: 'text', name: 'email' })
  email!: string;

  @Column({ type: 'timestamptz', name: 'email_verified_at', nullable: true })
  emailVerifiedAt!: Date | null;

  @Column({ type: 'text', name: 'phone_e164', nullable: true })
  phoneE164!: string | null;

  @Column({
    type: 'enum',
    enum: UserAccountStatus,
    enumName: 'user_account_status',
    name: 'account_status',
  })
  accountStatus!: UserAccountStatus;

  /** DATE column — TypeORM normalises 'date' to a 'YYYY-MM-DD' string both ways. */
  @Column({ type: 'date', name: 'date_of_birth' })
  dateOfBirth!: string;

  /**
   * Trigger-maintained projection (AFTER INSERT on trust_score_events).
   * Application code must NEVER write this — insert/update are disabled so a
   * stray assignment is silently dropped rather than fighting the trigger.
   * See the schema comment on users.trust_score_raw for why the raw sum is
   * kept unclamped.
   */
  @Column({
    type: 'numeric',
    name: 'trust_score_raw',
    precision: 12,
    scale: 3,
    transformer: numericTransformer,
    insert: false,
    update: false,
  })
  readonly trustScoreRaw!: number;

  /** GENERATED ALWAYS AS (LEAST(10, GREATEST(0, trust_score_raw))) STORED. */
  @Column({
    type: 'numeric',
    name: 'trust_score',
    precision: 5,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
    insert: false,
    update: false,
  })
  readonly trustScore!: number | null;

  @Column({ type: 'timestamptz', name: 'last_active_at', nullable: true })
  lastActiveAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  readonly updatedAt!: Date;

  /**
   * Soft delete. GDPR erasure anonymises this row rather than deleting it —
   * messages, reviews, payments and the trust ledger must survive account
   * closure (statutory retention on financial records overrides erasure).
   */
  @DeleteDateColumn({ type: 'timestamptz', name: 'deleted_at' })
  deletedAt!: Date | null;
}

@Entity('user_profiles')
export class UserProfileEntity {
  @PrimaryColumn({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'text', name: 'display_name' })
  displayName!: string;

  @Column({ type: 'text', name: 'bio', nullable: true })
  bio!: string | null;

  @Column({ type: 'text', name: 'avatar_url', nullable: true })
  avatarUrl!: string | null;

  @Column({ type: 'character', length: 2, name: 'home_country_code', nullable: true })
  homeCountryCode!: string | null;

  @Column({ type: 'text', name: 'native_language_code', nullable: true })
  nativeLanguageCode!: string | null;

  @Column({ type: 'text', array: true, name: 'languages_spoken' })
  languagesSpoken!: string[];

  /** 1 = backpacker … 5 = luxury (§7). */
  @Column({ type: 'smallint', name: 'travel_style' })
  travelStyle!: number;

  /**
   * Trigger-maintained projection of active user_interests
   * (tw_sync_interest_ids/tw_sync_interest_activity). Historical inactive
   * selections remain in user_interests but never appear in this matching
   * projection.
   * kept only so candidate generation can use an indexed array-overlap
   * predicate. user_interests remains the source of truth — never write
   * this column directly.
   */
  @Column({
    type: 'integer',
    array: true,
    name: 'interest_ids',
    insert: false,
    update: false,
  })
  readonly interestIds!: number[];

  @Column({ type: 'timestamptz', name: 'identity_verified_at', nullable: true })
  identityVerifiedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  readonly updatedAt!: Date;
}

@Entity('user_settings')
export class UserSettingsEntity {
  @PrimaryColumn({ type: 'uuid', name: 'user_id' })
  userId!: string;

  /** Ghost Mode (§9): suppresses NEW swipe-feed appearance only. */
  @Column({ type: 'boolean', name: 'ghost_mode_enabled' })
  ghostModeEnabled!: boolean;

  @Column({ type: 'timestamptz', name: 'ghost_mode_until', nullable: true })
  ghostModeUntil!: Date | null;

  @Column({ type: 'boolean', name: 'discovery_enabled' })
  discoveryEnabled!: boolean;

  @Column({
    type: 'enum',
    enum: TripVisibility,
    enumName: 'trip_visibility',
    name: 'trip_visibility',
  })
  tripVisibility!: TripVisibility;

  @Column({ type: 'smallint', name: 'min_age_preference' })
  minAgePreference!: number;

  @Column({ type: 'smallint', name: 'max_age_preference' })
  maxAgePreference!: number;

  @Column({
    type: 'numeric',
    name: 'min_trust_score_preference',
    precision: 5,
    scale: 2,
    transformer: numericTransformer,
  })
  minTrustScorePreference!: number;

  @Column({ type: 'integer', name: 'max_distance_km' })
  maxDistanceKm!: number;

  @Column({ type: 'boolean', name: 'push_enabled' })
  pushEnabled!: boolean;

  @Column({ type: 'boolean', name: 'email_enabled' })
  emailEnabled!: boolean;

  @Column({ type: 'text', name: 'locale' })
  locale!: string;

  @Column({ type: 'text', name: 'timezone' })
  timezone!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  readonly updatedAt!: Date;
}

/**
 * GDPR consent ledger. Append-only at the database level
 * (tw_forbid_mutation trigger on UPDATE/DELETE) — this entity has no
 * @UpdateDateColumn and no soft-delete because there is nothing to update or
 * delete; withdrawal is a new row with granted = false.
 */
@Entity('user_consents')
export class UserConsentEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({
    type: 'enum',
    enum: ConsentType,
    enumName: 'consent_type',
    name: 'consent_type',
  })
  consentType!: ConsentType;

  @Column({ type: 'boolean', name: 'granted' })
  granted!: boolean;

  @Column({ type: 'text', name: 'policy_version' })
  policyVersion!: string;

  @Column({ type: 'inet', name: 'source_ip', nullable: true })
  sourceIp!: string | null;

  @Column({ type: 'text', name: 'user_agent', nullable: true })
  userAgent!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;
}
