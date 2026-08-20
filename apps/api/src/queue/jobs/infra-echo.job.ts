/**
 * `infra.echo` — a harmless job that exists ONLY to prove the pipeline
 * end to end:
 *
 *   PostgreSQL job_outbox -> relay -> BullMQ -> worker -> completed_at
 *
 * It has no business meaning and must never be given one. The processor
 * lives in `src/outbox/infra-echo.processor.ts` because acknowledging the
 * outbox row on success is the point of the exercise, not the job itself —
 * this file only owns the job's name and payload contract, which is a
 * Queue-layer concern.
 */
export const INFRA_ECHO_TOPIC = 'infra.echo';

export interface InfraEchoPayload {
  /** Arbitrary human-readable text, logged and otherwise ignored. */
  readonly message: string;
  /**
   * Groups effect-counter increments for idempotency tests. Not used by
   * production code paths — this field exists so an integration test can
   * assert "the effect ran exactly once" rather than merely "no error was
   * thrown" when the same dedupe_key is redelivered.
   */
  readonly effectKey: string;
}
