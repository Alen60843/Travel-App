import { Logger } from '@nestjs/common';
import { Worker, type Job, type Processor } from 'bullmq';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../config/configuration';
import { DEFAULT_WORKER_CONCURRENCY } from './queue.constants';

export interface WorkerBootstrapOptions<T, R = unknown> {
  readonly name: string;
  readonly processor: Processor<T, R>;
  readonly concurrency?: number;
}

/**
 * Creates a BullMQ Worker with this codebase's shared defaults: the shared
 * queue connection + prefix, bounded concurrency, and structured failure
 * logging.
 *
 * On failure we log `jobId`, `name`, `attemptsMade` and the error message —
 * deliberately NOT `job.data`. Job payloads flow from `job_outbox.payload`,
 * which can carry things like payment amounts or user-identifying fields in
 * later phases; a failure log is exactly the kind of place that quietly ends
 * up shipped to a log aggregator with looser access controls than the
 * database, so the payload never goes in it.
 */
export function createWorker<T, R = unknown>(
  connection: Redis,
  config: AppConfig,
  opts: WorkerBootstrapOptions<T, R>,
): Worker<T, R> {
  const logger = new Logger(`Worker:${opts.name}`);

  const worker = new Worker<T, R>(opts.name, opts.processor, {
    connection,
    prefix: config.redisQueue.prefix,
    concurrency: opts.concurrency ?? DEFAULT_WORKER_CONCURRENCY,
  });

  worker.on('failed', (job: Job<T, R> | undefined, err: Error) => {
    logger.error(
      `job failed: id=${job?.id ?? 'unknown'} name=${job?.name ?? 'unknown'} ` +
        `attempts=${job?.attemptsMade ?? 0} error=${err.message}`,
    );
  });

  worker.on('error', (err: Error) => {
    logger.error(`worker error (connection-level, not a job failure): ${err.message}`);
  });

  return worker;
}

/**
 * Closes a worker allowing its in-flight job(s) to finish, bounded by
 * `timeoutMs`.
 *
 * BullMQ's `Worker.close(force)` is idempotent by identity, not by
 * semantics: a second call while the first is still closing just returns the
 * SAME in-flight promise and silently ignores whatever `force` value you
 * pass the second time (verified against bullmq's implementation — `force`
 * is only read on the call that starts the close). So this deliberately does
 * NOT implement "wait, then call close(true)" — that would not actually
 * force anything after the first call already started gracefully. Instead
 * it races the graceful close against the timeout and, if the timeout wins,
 * stops BLOCKING shutdown and lets the close continue in the background.
 *
 * This is a deliberate trade-off, not an oversight: if the in-flight job is
 * genuinely stuck, this process exits without waiting for it forever. That
 * is safe specifically because every consumer in this system is required to
 * be idempotent under at-least-once delivery (§6.6) — a job interrupted by
 * process exit is simply redelivered and retried, the same as any other
 * at-least-once redelivery. The alternative (truly force-killing a worker
 * mid-job) is not something BullMQ's public API can do safely from outside
 * the process anyway.
 */
export async function closeWorkerGracefully(
  worker: Worker,
  timeoutMs: number,
  logger: Logger = new Logger(`Worker:${worker.name}`),
): Promise<void> {
  const closePromise = worker.close();
  let timedOut = false;

  await Promise.race([
    closePromise.then(() => undefined),
    new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
      t.unref?.();
    }),
  ]);

  if (timedOut) {
    logger.warn(
      `worker ${worker.name} did not close within ${timeoutMs}ms; proceeding with shutdown, ` +
        `close continues in the background`,
    );
    closePromise.catch((err: Error) => {
      logger.error(`worker ${worker.name} close eventually failed: ${err.message}`);
    });
  }
}
