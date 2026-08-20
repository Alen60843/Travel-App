import { Injectable } from '@nestjs/common';

export interface OutboxMetricsSnapshot {
  readonly publishSuccess: number;
  readonly publishFailure: number;
  readonly redrive: number;
  readonly deadLettered: number;
  readonly acknowledged: number;
}

/**
 * Minimal in-process counters for the outbox relay.
 *
 * Deliberately NOT importing `src/observability/**` — Agent C owns the real
 * metrics/tracing pipeline and this module must compile and be testable
 * without depending on their in-flight work. This is a plain counter, not a
 * metrics client: no export format, no cardinality limits, no flush loop.
 * The Lead is expected to either wrap this in the real observability
 * exporter, or replace call sites with it directly — either way the call
 * sites in OutboxRelay name exactly the events §6.7/§6.3 call out (publish
 * success/failure, re-drive, dead-letter) so the reconciliation is
 * mechanical.
 */
@Injectable()
export class OutboxMetrics {
  private publishSuccess = 0;
  private publishFailure = 0;
  private redrive = 0;
  private deadLettered = 0;
  private acknowledged = 0;

  recordPublishSuccess(): void {
    this.publishSuccess += 1;
  }

  recordPublishFailure(): void {
    this.publishFailure += 1;
  }

  /** A row whose `published_at` was already set before this claim — a re-drive. */
  recordRedrive(): void {
    this.redrive += 1;
  }

  recordDeadLettered(): void {
    this.deadLettered += 1;
  }

  recordAcknowledged(): void {
    this.acknowledged += 1;
  }

  snapshot(): OutboxMetricsSnapshot {
    return {
      publishSuccess: this.publishSuccess,
      publishFailure: this.publishFailure,
      redrive: this.redrive,
      deadLettered: this.deadLettered,
      acknowledged: this.acknowledged,
    };
  }
}
