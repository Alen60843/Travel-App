import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OperationTimeoutError, withTimeout } from '../common/with-timeout';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { QueueRegistry } from '../queue/queue-registry.service';
import { OutboxMetrics } from './outbox-metrics';
import { mapClaimedOutboxRow, type ClaimedOutboxRow, type RawClaimedOutboxRow } from './outbox.types';

/**
 * The transactional outbox relay — the central piece of §6.
 *
 * `PostgreSQL job_outbox -> at-least-once relay -> BullMQ -> idempotent consumer`
 *
 * ## Claiming
 *
 * One SQL statement does claim + mark atomically:
 *
 *   WITH candidates AS (SELECT ... FOR UPDATE SKIP LOCKED)
 *   UPDATE job_outbox ... FROM candidates ... RETURNING ...
 *
 * `FOR UPDATE SKIP LOCKED` is what lets multiple relay instances run
 * concurrently with zero coordination: a row locked by one claimant is invisible to a
 * concurrent claimant rather than something it blocks waiting for. The WHERE
 * clause matches `job_outbox_undelivered_idx` exactly:
 *
 *   WHERE completed_at IS NULL AND failed_at IS NULL
 *     AND available_at <= now()
 *     AND (published_at IS NULL OR published_at < now() - lease)
 *
 * Doing the UPDATE in the SAME statement as the SELECT is deliberate and not
 * just an efficiency trick: it is what stakes the claim. If we only SELECTed
 * FOR UPDATE and committed, the row would be unlocked again the instant the
 * transaction ended, with nothing on the row itself recording that it had
 * just been claimed — a concurrent or immediately-following tick could
 * select and publish it again. Setting `published_at = now()` inside the
 * same atomic statement is what makes the row fail the re-drive predicate
 * for the next `lease` interval, which is the actual mutual-exclusion
 * mechanism (SKIP LOCKED only protects the instant of the claim, not
 * whatever happens after the transaction commits).
 *
 * A row whose `attempts + 1` would exceed `max_attempts` is dead-lettered
 * (`failed_at = now()`) in this SAME statement instead of being handed to
 * BullMQ again — so a permanently-broken row consumes no further publish
 * attempts and immediately becomes visible on `job_outbox_dead_idx`.
 *
 * ## Publishing
 *
 * The claiming transaction commits BEFORE any Redis call — no transaction is
 * ever held open across a network call (§4.1's rule, and the same reason the
 * payment flow calls `authorize()` after committing). `dedupe_key` is used
 * verbatim as the BullMQ `jobId`, so if this same row gets re-claimed later
 * (lease lapsed because the first publish's job was never acknowledged) the
 * re-publish collapses onto the existing BullMQ job when it still exists, or
 * creates a fresh one with the same identity when Redis lost it entirely —
 * either way, never a duplicate visible to the consumer under a different
 * id.
 *
 * If `queue.add()` itself throws (Redis unreachable), we do NOT go back and
 * revert `published_at` on that row. This is intentional: the row already
 * carries an attempt (via the claim statement), and leaving `published_at`
 * set means the SAME re-drive predicate that recovers a lost Redis job also
 * recovers a failed publish attempt once the lease lapses — one mechanism
 * instead of two. `publish_attempts` is never decremented and the row is
 * never deleted, so "the row is never dropped" holds regardless of which of
 * the two failure modes actually occurred.
 */
@Injectable()
export class OutboxRelay implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private tickInFlight: Promise<number> | null = null;
  private shutdownWaitExhausted = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly queues: QueueRegistry,
    private readonly metrics: OutboxMetrics,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.outbox.enabled) {
      this.logger.log('outbox relay disabled (OUTBOX_ENABLED=false)');
      return;
    }
    this.start();
  }

  /** Begins the poll loop. Safe to call manually (e.g. in tests) instead of relying on onModuleInit. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.shutdownWaitExhausted = false;
    this.logger.log(
      `outbox relay started: pollInterval=${this.config.outbox.pollIntervalMs}ms ` +
        `batchSize=${this.config.outbox.batchSize} lease=${this.config.outbox.leaseMs}ms`,
    );
    this.scheduleNext(0);
  }

  /**
   * Stops the loop promptly: clears any pending timer immediately and awaits
   * whatever tick is currently mid-flight (a tick already past the point of
   * no return — rows already claimed in Postgres — must be allowed to finish
   * publishing those specific rows; it will not schedule another tick after
   * because `stopped` is already true by the time it checks).
   */
  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /** Stops claiming and gives the current pass the configured shutdown grace period. */
  async stop(): Promise<void> {
    if (
      this.stopped &&
      this.timer === null &&
      (this.tickInFlight === null || this.shutdownWaitExhausted)
    ) {
      return;
    }

    this.logger.log('outbox relay stopping: no new rows will be claimed');
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.tickInFlight) {
      try {
        await withTimeout(
          this.tickInFlight,
          this.config.app.shutdownTimeoutMs,
          `outbox relay tick did not settle within ${this.config.app.shutdownTimeoutMs}ms`,
        );
      } catch (err) {
        if (err instanceof OperationTimeoutError) {
          // The row was claimed durably before publishing. Imported resource
          // modules will now close their clients; any uncertain delivery is
          // recovered from the same row after its lease/backoff expires.
          this.logger.warn(`${err.message}; continuing shutdown for at-least-once redelivery`);
          this.shutdownWaitExhausted = true;
        } else {
          this.logger.error(`outbox relay tick failed during shutdown: ${(err as Error).message}`);
        }
      }
    }
    this.logger.log('outbox relay stopped');
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.timer = null;
      void this.tick()
        .then((published) => {
          // Drain a backlog at full speed, idle politely when there is none.
          // A productive pass gets one immediate follow-up; an empty pass
          // sleeps for the configured interval, so idle workers never spin.
          this.scheduleNext(published > 0 ? 0 : this.config.outbox.pollIntervalMs);
        })
        .catch((err: unknown) => {
          this.logger.error(`outbox relay tick failed: ${(err as Error).message}`);
          this.scheduleNext(this.config.outbox.pollIntervalMs);
        });
    }, delayMs);

    // Deliberately NOT unref'd. In the worker deployable the relay may be the
    // only thing holding the event loop open; an unref'd timer would let the
    // process exit immediately at boot, and the resulting "worker starts and
    // vanishes" is exactly the kind of failure that looks like a crash-loop
    // with no error. Shutdown clears the timer explicitly above.
    this.timer = timer;
  }

  /**
   * Runs one claim-and-publish pass. Concurrent calls in the same process join
   * the current promise instead of starting an overlapping pass.
   */
  tick(): Promise<number> {
    if (this.tickInFlight) return this.tickInFlight;

    let pass: Promise<number>;
    pass = this.runTick().finally(() => {
      if (this.tickInFlight === pass) this.tickInFlight = null;
    });
    this.tickInFlight = pass;
    return pass;
  }

  private async runTick(): Promise<number> {
    const rows = await this.claimBatch();

    for (const row of rows) {
      if (row.failedAt) {
        this.metrics.recordDeadLettered();
        this.logger.warn(
          `outbox row dead-lettered: id=${row.id} dedupeKey=${row.dedupeKey} attempts=${row.attempts} maxAttempts=${row.maxAttempts}`,
        );
        continue;
      }

      if (row.wasRedrive) {
        this.metrics.recordRedrive();
        this.logger.warn(
          `outbox redrive: id=${row.id} dedupeKey=${row.dedupeKey} attempt=${row.attempts} publishAttempts=${row.publishAttempts}`,
        );
      }

      try {
        await this.queues.addJob(row.topic, row.topic, row.payload, row.dedupeKey);
        this.metrics.recordPublishSuccess();
        if (row.lastError !== null) {
          await this.clearPublishError(row.id);
        }
      } catch (err) {
        this.metrics.recordPublishFailure();
        const errorMessage = describeError(err);
        const retryDelayMs = this.retryDelayMs(row.publishAttempts);
        this.logger.error(
          `outbox publish failed: id=${row.id} dedupeKey=${row.dedupeKey} ` +
            `attempt=${row.publishAttempts} retryIn=${retryDelayMs}ms error=${errorMessage}`,
        );
        await this.recordPublishFailure(row.id, errorMessage, retryDelayMs);
      }
    }

    return rows.length;
  }

  private retryDelayMs(publishAttempts: number): number {
    const exponent = Math.min(Math.max(publishAttempts - 1, 0), 5);
    return Math.min(this.config.outbox.leaseMs * 2 ** exponent, 2_147_483_647);
  }

  private async recordPublishFailure(id: string, error: string, retryDelayMs: number): Promise<void> {
    try {
      await this.dataSource.query(
        `UPDATE job_outbox
         SET last_error = $2,
             available_at = GREATEST(
               available_at,
               now() + ($3::bigint * interval '1 millisecond')
             )
         WHERE id = $1 AND completed_at IS NULL AND failed_at IS NULL`,
        [id, error.slice(0, 1_000), retryDelayMs],
      );
    } catch (persistError) {
      // The original row remains durable and published_at still gives it a
      // lease-based retry. Losing diagnostic/backoff metadata must not turn a
      // recoverable Redis outage into a dropped action.
      this.logger.error(
        `failed to persist outbox retry metadata: id=${id} error=${describeError(persistError)}`,
      );
    }
  }

  private async clearPublishError(id: string): Promise<void> {
    try {
      await this.dataSource.query(
        `UPDATE job_outbox SET last_error = NULL WHERE id = $1 AND completed_at IS NULL`,
        [id],
      );
    } catch (err) {
      this.logger.warn(`failed to clear outbox publish error: id=${id} error=${describeError(err)}`);
    }
  }

  private async claimBatch(): Promise<ClaimedOutboxRow[]> {
    const leaseMs = this.config.outbox.leaseMs;
    const batchSize = this.config.outbox.batchSize;

    const result = (await this.dataSource.query(
      `WITH candidates AS (
         SELECT id, attempts, max_attempts, published_at AS previous_published_at
         FROM job_outbox
         WHERE completed_at IS NULL AND failed_at IS NULL
           AND available_at <= now()
           AND (published_at IS NULL OR published_at < now() - ($1 || ' milliseconds')::interval)
         ORDER BY available_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE job_outbox jo
       SET
         attempts = jo.attempts + 1,
         last_attempt_at = now(),
         publish_attempts = CASE
           WHEN jo.attempts + 1 > jo.max_attempts THEN jo.publish_attempts
           ELSE jo.publish_attempts + 1
         END,
         published_at = CASE
           WHEN jo.attempts + 1 > jo.max_attempts THEN jo.published_at
           ELSE now()
         END,
         failed_at = CASE
           WHEN jo.attempts + 1 > jo.max_attempts THEN now()
           ELSE NULL
         END,
         last_error = CASE
           WHEN jo.attempts + 1 > jo.max_attempts THEN 'exceeded max_attempts at claim time'
           ELSE jo.last_error
         END
       FROM candidates c
       WHERE jo.id = c.id
       RETURNING
         jo.id, jo.topic, jo.payload, jo.dedupe_key, jo.available_at, jo.published_at,
         jo.publish_attempts, jo.completed_at, jo.failed_at, jo.attempts, jo.max_attempts,
         jo.last_attempt_at, jo.last_error, jo.created_at,
         (c.previous_published_at IS NOT NULL) AS was_redrive`,
      [String(leaseMs), batchSize],
    )) as [RawClaimedOutboxRow[], number];

    const [rawRows] = result;
    return rawRows.map(mapClaimedOutboxRow);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
