/**
 * TypeScript mirror of a `job_outbox` row (camelCased). `id` stays a string:
 * it is `BIGINT GENERATED ALWAYS AS IDENTITY` in Postgres and the `pg`
 * driver returns 8-byte integers as strings specifically because they don't
 * fit safely in a JS `number`.
 */
export interface OutboxRow {
  readonly id: string;
  readonly topic: string;
  readonly payload: unknown;
  readonly dedupeKey: string;
  readonly availableAt: Date;
  readonly publishedAt: Date | null;
  readonly publishAttempts: number;
  readonly completedAt: Date | null;
  readonly failedAt: Date | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastAttemptAt: Date | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
}

/** A row as claimed by one relay pass, plus whether this claim is a re-drive. */
export interface ClaimedOutboxRow extends OutboxRow {
  /**
   * True when `published_at` was already set BEFORE this claim — i.e. this
   * row was published at least once before and is being re-driven, either
   * because Redis lost the job or because the publish attempt itself
   * previously failed. False for a row published for the very first time.
   */
  readonly wasRedrive: boolean;
}

interface RawOutboxRow {
  id: string;
  topic: string;
  payload: unknown;
  dedupe_key: string;
  available_at: Date;
  published_at: Date | null;
  publish_attempts: number;
  completed_at: Date | null;
  failed_at: Date | null;
  attempts: number;
  max_attempts: number;
  last_attempt_at: Date | null;
  last_error: string | null;
  created_at: Date;
}

export function mapOutboxRow(raw: RawOutboxRow): OutboxRow {
  return {
    id: raw.id,
    topic: raw.topic,
    payload: raw.payload,
    dedupeKey: raw.dedupe_key,
    availableAt: raw.available_at,
    publishedAt: raw.published_at,
    publishAttempts: raw.publish_attempts,
    completedAt: raw.completed_at,
    failedAt: raw.failed_at,
    attempts: raw.attempts,
    maxAttempts: raw.max_attempts,
    lastAttemptAt: raw.last_attempt_at,
    lastError: raw.last_error,
    createdAt: raw.created_at,
  };
}

export interface RawClaimedOutboxRow extends RawOutboxRow {
  was_redrive: boolean;
}

export function mapClaimedOutboxRow(raw: RawClaimedOutboxRow): ClaimedOutboxRow {
  return { ...mapOutboxRow(raw), wasRedrive: raw.was_redrive };
}
