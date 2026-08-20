import { ExternalSource, MediaKind, ModerationState, SubscriptionStatus } from '@tripwith/shared';
import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

import type { GeoPoint } from '../geo/geo-point';
import { bigintTransformer, numericTransformer } from './transformers';

/**
 * PROVIDERS domain — the marketplace supply side. provider_external_sources
 * is a strict provenance boundary (§10): externally-sourced fields are never
 * merged into `providers` columns and are composed at read time by the
 * service layer, not by this entity.
 */

@Entity('provider_category_types')
export class ProviderCategoryTypeEntity {
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

@Entity('providers')
export class ProviderEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  /** NULL for a record created by import/enrichment nobody has claimed yet. */
  @Column({ type: 'uuid', name: 'owner_user_id', nullable: true })
  ownerUserId!: string | null;

  @Column({ type: 'text', name: 'slug' })
  slug!: string;

  @Column({ type: 'text', name: 'name' })
  name!: string;

  @Column({ type: 'text', name: 'description', nullable: true })
  description!: string | null;

  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
    name: 'location',
    nullable: true,
  })
  location!: GeoPoint | null;

  @Column({ type: 'text', name: 'address_line', nullable: true })
  addressLine!: string | null;

  @Column({ type: 'text', name: 'city', nullable: true })
  city!: string | null;

  @Column({ type: 'character', length: 2, name: 'country_code', nullable: true })
  countryCode!: string | null;

  @Column({ type: 'text', name: 'website_url', nullable: true })
  websiteUrl!: string | null;

  @Column({ type: 'text', name: 'contact_phone_e164', nullable: true })
  contactPhoneE164!: string | null;

  @Column({ type: 'text', name: 'contact_email', nullable: true })
  contactEmail!: string | null;

  @Column({ type: 'integer', name: 'price_min_minor', nullable: true })
  priceMinMinor!: number | null;

  @Column({ type: 'integer', name: 'price_max_minor', nullable: true })
  priceMaxMinor!: number | null;

  @Column({ type: 'character', length: 3, name: 'currency' })
  currency!: string;

  /** Trigger-maintained projection (tw_sync_provider_rating) — never write. */
  @Column({
    type: 'numeric',
    name: 'rating_avg',
    precision: 3,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
    insert: false,
    update: false,
  })
  readonly ratingAvg!: number | null;

  @Column({
    type: 'integer',
    name: 'rating_count',
    insert: false,
    update: false,
  })
  readonly ratingCount!: number;

  @Column({ type: 'timestamptz', name: 'verified_at', nullable: true })
  verifiedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'confirmed_by_owner_at', nullable: true })
  confirmedByOwnerAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'published_at', nullable: true })
  publishedAt!: Date | null;

  @Column({ type: 'boolean', name: 'is_active' })
  isActive!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  readonly updatedAt!: Date;

  @DeleteDateColumn({ type: 'timestamptz', name: 'deleted_at' })
  deletedAt!: Date | null;

  @OneToMany(() => ProviderMediaEntity, (media) => media.provider)
  media?: ProviderMediaEntity[];

  @OneToMany(() => ProviderExternalSourceEntity, (source) => source.provider)
  externalSources?: ProviderExternalSourceEntity[];

  @OneToMany(() => ProviderSubscriptionEntity, (subscription) => subscription.provider)
  subscriptions?: ProviderSubscriptionEntity[];
}

/**
 * Deliberately NOT a raw payload dump (§10): only an allowlisted, TTL'd set
 * of fields is cached here. Ratings, review text and photos are fetched live
 * per request and never persisted — there is no column for them.
 */
@Entity('provider_external_sources')
export class ProviderExternalSourceEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  @Column({ type: 'uuid', name: 'provider_id' })
  providerId!: string;

  @Column({
    type: 'enum',
    enum: ExternalSource,
    enumName: 'external_source',
    name: 'source',
  })
  source!: ExternalSource;

  @Column({ type: 'text', name: 'external_id' })
  externalId!: string;

  @Column({ type: 'text', name: 'external_url', nullable: true })
  externalUrl!: string | null;

  @Column({ type: 'text', name: 'attribution_text', nullable: true })
  attributionText!: string | null;

  @Column({ type: 'text', name: 'cached_display_name', nullable: true })
  cachedDisplayName!: string | null;

  @Column({ type: 'text', name: 'cached_formatted_address', nullable: true })
  cachedFormattedAddress!: string | null;

  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
    name: 'cached_location',
    nullable: true,
  })
  cachedLocation!: GeoPoint | null;

  @Column({ type: 'jsonb', name: 'cached_opening_hours', nullable: true })
  cachedOpeningHours!: Record<string, unknown> | null;

  @Column({ type: 'timestamptz', name: 'cached_at', nullable: true })
  cachedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'cache_expires_at', nullable: true })
  cacheExpiresAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'last_refresh_attempt_at', nullable: true })
  lastRefreshAttemptAt!: Date | null;

  @Column({ type: 'integer', name: 'refresh_failure_count' })
  refreshFailureCount!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  readonly updatedAt!: Date;

  @ManyToOne(() => ProviderEntity, (provider) => provider.externalSources)
  @JoinColumn({ name: 'provider_id' })
  provider?: ProviderEntity;
}

/** First-party media only — third-party photo URLs are never persisted here. */
@Entity('provider_media')
export class ProviderMediaEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  @Column({ type: 'uuid', name: 'provider_id' })
  providerId!: string;

  @Column({
    type: 'enum',
    enum: MediaKind,
    enumName: 'media_kind',
    name: 'kind',
  })
  kind!: MediaKind;

  @Column({ type: 'text', name: 'storage_key' })
  storageKey!: string;

  @Column({ type: 'integer', name: 'width_px', nullable: true })
  widthPx!: number | null;

  @Column({ type: 'integer', name: 'height_px', nullable: true })
  heightPx!: number | null;

  @Column({
    type: 'bigint',
    name: 'byte_size',
    nullable: true,
    transformer: bigintTransformer,
  })
  byteSize!: number | null;

  @Column({ type: 'smallint', name: 'sort_order' })
  sortOrder!: number;

  @Column({ type: 'uuid', name: 'uploaded_by_user_id', nullable: true })
  uploadedByUserId!: string | null;

  @Column({
    type: 'enum',
    enum: ModerationState,
    enumName: 'moderation_state',
    name: 'moderation_state',
  })
  moderationState!: ModerationState;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;

  @DeleteDateColumn({ type: 'timestamptz', name: 'deleted_at' })
  deletedAt!: Date | null;

  @ManyToOne(() => ProviderEntity, (provider) => provider.media)
  @JoinColumn({ name: 'provider_id' })
  provider?: ProviderEntity;
}

/**
 * Providers are many-to-many with categories (a hostel can run treks and
 * taxis); events by contrast carry exactly one category via a direct FK
 * (see events.entity.ts). Mapped as an explicit join entity rather than a
 * TypeORM @ManyToMany so `is_primary` and `created_at` stay first-class,
 * queryable columns instead of being hidden in a pivot table.
 */
@Entity('provider_categories')
export class ProviderCategoryEntity {
  @PrimaryColumn({ type: 'uuid', name: 'provider_id' })
  providerId!: string;

  @PrimaryColumn({ type: 'integer', name: 'category_id' })
  categoryId!: number;

  @Column({ type: 'boolean', name: 'is_primary' })
  isPrimary!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;

  @ManyToOne(() => ProviderCategoryTypeEntity)
  @JoinColumn({ name: 'category_id' })
  categoryType?: ProviderCategoryTypeEntity;
}

@Entity('provider_subscriptions')
export class ProviderSubscriptionEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  @Column({ type: 'uuid', name: 'provider_id' })
  providerId!: string;

  @Column({ type: 'text', name: 'plan_code' })
  planCode!: string;

  @Column({
    type: 'enum',
    enum: SubscriptionStatus,
    enumName: 'subscription_status',
    name: 'status',
  })
  status!: SubscriptionStatus;

  @Column({ type: 'integer', name: 'price_minor' })
  priceMinor!: number;

  @Column({ type: 'character', length: 3, name: 'currency' })
  currency!: string;

  @Column({ type: 'timestamptz', name: 'current_period_start' })
  currentPeriodStart!: Date;

  @Column({ type: 'timestamptz', name: 'current_period_end' })
  currentPeriodEnd!: Date;

  @Column({ type: 'timestamptz', name: 'cancel_at', nullable: true })
  cancelAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'cancelled_at', nullable: true })
  cancelledAt!: Date | null;

  @Column({ type: 'text', name: 'external_subscription_id', nullable: true })
  externalSubscriptionId!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  readonly updatedAt!: Date;

  @ManyToOne(() => ProviderEntity, (provider) => provider.subscriptions)
  @JoinColumn({ name: 'provider_id' })
  provider?: ProviderEntity;
}
