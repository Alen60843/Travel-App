import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { assertBullMqCompatibleJobId } from '../queue/job-id';

export interface OutboxEnqueueInput {
  /** BullMQ queue name the relay will publish into (see OutboxRelay). */
  readonly topic: string;
  readonly payload: Record<string, unknown>;
  /**
   * Deterministic, caller-derived key (e.g. `payment.capture.<paymentId>` —
   * NOT `payment.capture:<paymentId>`; see `assertBullMqCompatibleJobId` for
   * why colons are rejected even though earlier examples in the design doc
   * use them). Used verbatim as the BullMQ jobId and enforced UNIQUE by the
   * schema — this is what makes a duplicate enqueue of the same logical
   * action a no-op instead of a double-publish.
   */
  readonly dedupeKey: string;
  readonly availableAt?: Date;
  readonly maxAttempts?: number;
}

export interface OutboxEnqueueResult {
  /** False when a row with this `dedupeKey` already existed (no-op, not an error). */
  readonly inserted: boolean;
}

/**
 * Writes a `job_outbox` row inside a transaction the CALLER already owns.
 *
 * The signature is the whole enforcement mechanism. `enqueue()` takes an
 * `EntityManager` as its first argument and, at call time, verifies that the
 * manager is bound to a `QueryRunner` with `isTransactionActive === true` —
 * i.e. it was obtained via `dataSource.transaction(cb)` or
 * `queryRunner.manager` after `startTransaction()`, never `dataSource.manager`
 * used bare. If it isn't, this throws immediately, before touching the
 * database.
 *
 * This is not a style nicety. The entire transactional-outbox pattern
 * depends on the business row and the job-intent row committing or rolling
 * back TOGETHER (§6.1, §11.10) — an outbox insert that silently succeeded
 * outside the caller's transaction would reintroduce the exact "authorized
 * but no row describes it" hazard §4.1 was rewritten to eliminate. Making
 * the precondition a runtime assertion means a caller who reaches for
 * `dataSource.manager` by habit gets a loud, immediate, unambiguous error
 * instead of a job that silently commits even when the surrounding business
 * transaction rolls back.
 *
 * `ON CONFLICT (dedupe_key) DO NOTHING`: re-enqueuing the same logical
 * action (e.g. a retried request that reruns the same handler) is a no-op,
 * not a constraint-violation error the caller has to catch.
 */
@Injectable()
export class OutboxEnqueuer {
  async enqueue(manager: EntityManager, input: OutboxEnqueueInput): Promise<OutboxEnqueueResult> {
    assertActiveTransaction(manager);
    // Fail fast, before the row is even committed — see job-id.ts for why a
    // colon-containing dedupe_key must never reach the database at all.
    assertBullMqCompatibleJobId(input.dedupeKey);

    const rows = (await manager.query(
      `INSERT INTO job_outbox (topic, payload, dedupe_key, available_at, max_attempts)
       VALUES ($1, $2::jsonb, $3, COALESCE($4, now()), COALESCE($5, 10))
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [
        input.topic,
        JSON.stringify(input.payload),
        input.dedupeKey,
        input.availableAt ?? null,
        input.maxAttempts ?? null,
      ],
    )) as Array<{ id: string }>;

    return { inserted: rows.length > 0 };
  }
}

function assertActiveTransaction(manager: EntityManager): void {
  const queryRunner = manager.queryRunner;
  if (!queryRunner || !queryRunner.isTransactionActive) {
    throw new Error(
      'OutboxEnqueuer.enqueue() requires an EntityManager bound to an ACTIVE transaction ' +
        '(dataSource.transaction(async (manager) => { ...; await enqueuer.enqueue(manager, ...) }) ' +
        'or queryRunner.manager after queryRunner.startTransaction()). ' +
        'It was called with a manager that is not inside a transaction. This is deliberate: the ' +
        'outbox pattern only works if the business write and the job intent commit atomically.',
    );
  }
}
