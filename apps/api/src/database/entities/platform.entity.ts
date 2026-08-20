import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

import { bigintTransformer } from './transformers';

/**
 * PLATFORM domain — the transactional outbox. Enqueuing a BullMQ job is a
 * network call to Redis and cannot join a PostgreSQL transaction, so the
 * intent is written here in the same transaction as the business change; a
 * relay (owned by the outbox module, not this one) publishes committed rows
 * to BullMQ and this table is what makes a committed action reconstructible
 * after total Redis loss. See the migration's full delivery-model comment.
 */
@Entity('job_outbox')
export class JobOutboxEntity {
  @PrimaryColumn({
    type: 'bigint',
    name: 'id',
    generated: 'identity',
    generatedIdentity: 'ALWAYS',
    transformer: bigintTransformer,
  })
  readonly id!: number;

  @Column({ type: 'text', name: 'topic' })
  topic!: string;

  @Column({ type: 'jsonb', name: 'payload' })
  payload!: Record<string, unknown>;

  /**
   * Deterministic, caller-derived key used verbatim as the BullMQ jobId.
   * UNIQUE at the database level, so the producing transaction cannot
   * enqueue the same logical action twice.
   */
  @Column({ type: 'text', name: 'dedupe_key' })
  dedupeKey!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'available_at' })
  readonly availableAt!: Date;

  /** Handed to BullMQ — NOT proof of execution. */
  @Column({ type: 'timestamptz', name: 'published_at', nullable: true })
  publishedAt!: Date | null;

  @Column({ type: 'integer', name: 'publish_attempts' })
  publishAttempts!: number;

  /** Consumer acknowledgement — THIS is proof of execution. */
  @Column({ type: 'timestamptz', name: 'completed_at', nullable: true })
  completedAt!: Date | null;

  /** Permanently dead after max_attempts; surfaced to operators, never silently dropped. */
  @Column({ type: 'timestamptz', name: 'failed_at', nullable: true })
  failedAt!: Date | null;

  @Column({ type: 'integer', name: 'attempts' })
  attempts!: number;

  @Column({ type: 'integer', name: 'max_attempts' })
  maxAttempts!: number;

  @Column({ type: 'timestamptz', name: 'last_attempt_at', nullable: true })
  lastAttemptAt!: Date | null;

  @Column({ type: 'text', name: 'last_error', nullable: true })
  lastError!: string | null;

  @Column({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;
}
