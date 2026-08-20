import { TripVisibility } from '@tripwith/shared';
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

/**
 * TRIPS domain — the normalised itinerary (§6). trip_segments is where the
 * schema's one non-privacy geography column lives on the demand side: a
 * destination CENTROID the traveller intends to be in, never a device fix.
 */

@Entity('trips')
export class TripEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'text', name: 'title' })
  title!: string;

  @Column({ type: 'date', name: 'start_date' })
  startDate!: string;

  @Column({ type: 'date', name: 'end_date' })
  endDate!: string;

  @Column({
    type: 'enum',
    enum: TripVisibility,
    enumName: 'trip_visibility',
    name: 'visibility',
  })
  visibility!: TripVisibility;

  /** Flexible itinerary extras only — anything searchable lives in columns (§6). */
  @Column({ type: 'jsonb', name: 'metadata' })
  metadata!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  readonly updatedAt!: Date;

  @OneToMany(() => TripSegmentEntity, (segment) => segment.trip)
  segments?: TripSegmentEntity[];
}

@Entity('trip_segments')
export class TripSegmentEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  @Column({ type: 'uuid', name: 'trip_id' })
  tripId!: string;

  /**
   * Denormalised from trips so candidate generation never has to join trips.
   * Consistency is guaranteed by the composite FK
   * (trip_id, user_id) REFERENCES trips(id, user_id) — not by the ORM.
   */
  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  /** Google Place ID — an opaque identifier, persistable long-term. */
  @Column({ type: 'text', name: 'destination_place_id', nullable: true })
  destinationPlaceId!: string | null;

  @Column({ type: 'text', name: 'destination_name' })
  destinationName!: string;

  @Column({ type: 'character', length: 2, name: 'country_code', nullable: true })
  countryCode!: string | null;

  /** Destination centroid — NOT a GPS fix, never derived from device location. */
  @Column({ type: 'geography', spatialFeatureType: 'Point', srid: 4326, name: 'location' })
  location!: GeoPoint;

  @Column({ type: 'date', name: 'start_date' })
  startDate!: string;

  @Column({ type: 'date', name: 'end_date' })
  endDate!: string;

  /**
   * GENERATED ALWAYS AS (daterange(start_date, end_date, '[]')) STORED.
   * Represented as the raw PostgreSQL range literal text (e.g.
   * "[2026-01-01,2026-01-10]") — node-postgres has no built-in range parser
   * and TypeORM does not add one, so round-tripping the driver's own string
   * is the only representation that needs no extra (de)serialisation. Never
   * written by the application; overlap queries should use the range
   * operators (`&&`) directly in raw SQL, not this string.
   */
  @Column({ type: 'daterange', name: 'date_range', nullable: true, insert: false, update: false })
  readonly dateRange!: string | null;

  @Column({ type: 'smallint', name: 'sort_order' })
  sortOrder!: number;

  @Column({ type: 'jsonb', name: 'metadata' })
  metadata!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  readonly updatedAt!: Date;

  @ManyToOne(() => TripEntity, (trip) => trip.segments)
  @JoinColumn({ name: 'trip_id' })
  trip?: TripEntity;
}
