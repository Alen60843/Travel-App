import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
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
 * `FOR UPDATE SKIP LOCKED` is what lets multiple relay instances (or,
 * degenerately, two overlapping ticks of the same instance) run concurrently
 * with zero coordination: a row locked by one claimant is invisible to a
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
  private tickInFlight: Promise<void> | null = null;

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
    if (this.stopped && this.timer === null && this.tickInFlight === null) return;

    this.logger.log('outbox relay stopping: no new rows will be claimed');
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.tickInFlight) {
      await this.tickInFlight;
    }
    this.logger.log('outbox relay stopped');
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.tickInFlight = (async () => {
        let published = 0;
        try {
          published = await this.tick();
        } catch (err) {
          this.logger.error(`outbox relay tick failed: ${(err as Error).message}`);
        } finally {
          this.tickInFlight = null;
          // Drain a backlog at full speed, idle politely when there is none.
          //
          // A full batch almost certainly means more rows are waiting, so
          // sleeping the poll interval between batches would make a spike take
          // (backlog / batchSize) * pollInterval to clear — minutes, for work
          // the database could hand over immediately. Re-polling only when the
          // last tick actually did something keeps that fast without turning
          // an idle relay into a busy-loop against Postgres.
          this.scheduleNext(published > 0 ? 0 : this.config.outbox.pollIntervalMs);
        }
      })();
    }, delayMs);

    // Deliberately NOT unref'd. In the worker deployable the relay may be the
    // only thing holding the event loop open; an unref'd timer would let the
    // process exit immediately at boot, and the resulting "worker starts and
    // vanishes" is exactly the kind of failure that looks like a crash-loop
    // with no error. Shutdown clears the timer explicitly above.
    this.timer = timer;
  }

  /** Runs exactly one claim-and-publish pass. Public so tests and manual invocation don't need the timer loop. */
  async tick(): Promise<number> {
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
      }

      try {
        await this.queues.addJob(row.topic, row.topic, row.payload, row.dedupeKey);
        this.metrics.recordPublishSuccess();
      } catch (err) {
        this.metrics.recordPublishFailure();
        this.logger.error(
          `outbox publish failed: id=${row.id} dedupeKey=${row.dedupeKey} error=${(err as Error).message}`,
        );
      }
    }

    return rows.length;
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
