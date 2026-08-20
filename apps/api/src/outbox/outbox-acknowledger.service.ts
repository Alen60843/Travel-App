import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { OutboxMetrics } from './outbox-metrics';

/**
 * Sets `completed_at` — the ONLY thing that retires a `job_outbox` row as
 * successful (§6.1). `published_at` means "handed to Redis"; it is never
 * evidence the work happened. This is the other half of that sentence.
 *
 * Accepts `DataSource | EntityManager` (unlike `OutboxEnqueuer.enqueue`,
 * which requires an active transaction). A real consumer with its own
 * business side-effect SHOULD pass its own transactional `EntityManager` so
 * the effect and the acknowledgement commit together (§6.1: "written in the
 * consumer's own transaction") — but unlike enqueue, that is not
 * structurally enforced here, because a consumer with no business row to
 * write (this module's own `infra.echo`, or a future purely-notificational
 * job) has nothing to be transactional WITH. The idempotent
 * `WHERE completed_at IS NULL` guard is what actually matters: acknowledging
 * an already-acknowledged row is a safe no-op either way.
 */
@Injectable()
export class OutboxAcknowledger {
  constructor(private readonly metrics: OutboxMetrics) {}

  async acknowledge(runner: DataSource | EntityManager, dedupeKey: string): Promise<void> {
    const rows = (await runner.query(
      `UPDATE job_outbox
       SET completed_at = now()
       WHERE dedupe_key = $1 AND completed_at IS NULL
       RETURNING id`,
      [dedupeKey],
    )) as [Array<{ id: string }>, number] | Array<{ id: string }>;

    // Postgres UPDATE ... RETURNING via TypeORM's raw query() returns
    // [rows, rowCount] rather than a bare rows array (see PostgresQueryRunner
    // — RETURNING on UPDATE/DELETE is special-cased). Normalise both shapes
    // defensively rather than assume the tuple form, since this method is a
    // public API other consumers will call directly.
    const affected = Array.isArray(rows[0]) ? (rows[0] as Array<{ id: string }>) : (rows as Array<{ id: string }>);

    if (affected.length > 0) {
      this.metrics.recordAcknowledged();
    }
  }
}
