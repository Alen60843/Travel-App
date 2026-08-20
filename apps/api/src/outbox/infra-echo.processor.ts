import { Logger } from '@nestjs/common';
import type { Job, Processor } from 'bullmq';
import { DataSource } from 'typeorm';
import type { InfraEchoPayload } from '../queue/jobs/infra-echo.job';
import { OutboxAcknowledger } from './outbox-acknowledger.service';
import { EffectCounterRegistry } from './effect-counter.registry';

/**
 * The `infra.echo` consumer — the "idempotent consumer" half of §6.1's
 * pipeline, applied to a job with no business meaning so the pipeline itself
 * can be proven end to end without touching any domain table.
 *
 * Idempotency is enforced the same way a real consumer would (§6.6: "Every
 * consumer is idempotent, so at-least-once delivery is safe"): before
 * applying its "effect" (incrementing a counter), it checks whether
 * `job_outbox.completed_at` is ALREADY set for this `dedupe_key`. If it is,
 * this is a redelivery of an already-applied job — BullMQ's own jobId
 * collapsing (§6.3) prevents most of these, but is not the only line of
 * defence: after a job is removed from Redis (retention policy, or a total
 * Redis loss) a re-publish with the same `dedupe_key`/`jobId` creates a
 * genuinely new BullMQ job that WILL be processed again. The completed_at
 * check is what makes that safe — the effect runs at most once no matter how
 * many times the job itself runs.
 */
export function createInfraEchoProcessor(
  dataSource: DataSource,
  acknowledger: OutboxAcknowledger,
  effects: EffectCounterRegistry,
): Processor<InfraEchoPayload, void> {
  const logger = new Logger('InfraEchoProcessor');

  return async (job: Job<InfraEchoPayload, void>): Promise<void> => {
    const dedupeKey = job.id;
    if (!dedupeKey) {
      // Cannot happen via OutboxRelay (it always sets jobId = dedupe_key),
      // but a directly-added job without one has nothing to acknowledge.
      throw new Error('infra.echo job has no id; every enqueue must pass a deterministic jobId');
    }

    const rows = (await dataSource.query(
      `SELECT completed_at FROM job_outbox WHERE dedupe_key = $1`,
      [dedupeKey],
    )) as Array<{ completed_at: Date | null }>;
    const alreadyCompleted = (rows[0]?.completed_at ?? null) !== null;

    if (alreadyCompleted) {
      logger.log(`redelivery of already-acknowledged ${dedupeKey}; skipping effect (idempotent)`);
    } else {
      effects.increment(job.data.effectKey);
      logger.log(`applied effect for ${dedupeKey}: ${job.data.message}`);
    }

    await acknowledger.acknowledge(dataSource, dedupeKey);
  };
}
