import { Logger } from '@nestjs/common';
import { Worker, type Job, type Processor } from 'bullmq';
import type { Redis } from 'ioredis';
import { OperationTimeoutError, withTimeout } from '../common/with-timeout';
import type { AppConfig } from '../config/configuration';
import { DEFAULT_WORKER_CONCURRENCY } from './queue.constants';

export interface WorkerBootstrapOptions<T, R = unknown> {
  readonly name: string;
  readonly processor: Processor<T, R>;
  readonly concurrency?: number;
}

interface WorkerActivity {
  readonly activeJobs: Set<object>;
  readonly drainedWaiters: Set<() => void>;
}

const workerActivity = new WeakMap<object, WorkerActivity>();

function markJobSettled(state: WorkerActivity, job: object | undefined): void {
  if (job) state.activeJobs.delete(job);
  if (state.activeJobs.size === 0) {
    for (const resolve of state.drainedWaiters) resolve();
    state.drainedWaiters.clear();
  }
}

function waitUntilJobsSettle(state: WorkerActivity): Promise<void> {
  if (state.activeJobs.size === 0) return Promise.resolve();
  return new Promise<void>((resolve) => state.drainedWaiters.add(resolve));
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
    // Attach lifecycle accounting before starting. This prevents a queued job
    // from becoming active in the tiny gap between construction and listeners.
    autorun: false,
  });

  const activity: WorkerActivity = {
    activeJobs: new Set<object>(),
    drainedWaiters: new Set<() => void>(),
  };
  workerActivity.set(worker, activity);

  worker.on('active', (job: Job<T, R>) => {
    activity.activeJobs.add(job);
  });

  worker.on('completed', (job: Job<T, R>) => {
    markJobSettled(activity, job);
  });

  worker.on('failed', (job: Job<T, R> | undefined, err: Error) => {
    markJobSettled(activity, job);
    logger.error(
      `job failed: id=${job?.id ?? 'unknown'} name=${job?.name ?? 'unknown'} ` +
        `attempts=${job?.attemptsMade ?? 0} error=${err.message}`,
    );
  });

  worker.on('error', (err: Error) => {
    logger.error(`worker error (connection-level, not a job failure): ${err.message}`);
  });

  void worker.run().catch((err: Error) => worker.emit('error', err));

  return worker;
}

/**
 * Closes a worker allowing its in-flight job(s) to finish, bounded by
 * `timeoutMs`.
 *
 * BullMQ's `Worker.close(force)` is idempotent by identity, not by
 * semantics: a second call while the first is still closing returns the same
 * promise and ignores a new `force` value. We therefore pause intake,
 * interrupt BullMQ's dedicated blocking fetch, and spend the grace period
 * waiting for active work BEFORE making the first (and only) close call. The
 * final close is forced only at the BullMQ transport/lifecycle layer;
 * normally it runs after all work settled.
 *
 * This is a deliberate trade-off: if the in-flight job is genuinely stuck,
 * the worker gets the configured grace period and is then disconnected. The
 * active job is cancelled through its AbortSignal and recovered by BullMQ;
 * the durable outbox/idempotent consumer contract absorbs the redelivery.
 */
export async function closeWorkerGracefully(
  worker: Worker,
  timeoutMs: number,
  logger: Logger = new Logger(`Worker:${worker.name}`),
): Promise<void> {
  const activity = workerActivity.get(worker);
  let settled = false;
  try {
    // `true` pauses only this worker without waiting. Waiting is implemented
    // below so it remains bounded and can be escalated safely.
    await worker.pause(true);

    // BullMQ has no public method that interrupts only a Worker's blocking
    // BZPOPMIN connection. pause(true) sets the intake flag but a fetch that
    // was already blocked can otherwise wake and claim one more job. This
    // narrow adapter prevents that claim; close(true) below remains the only
    // close() call, avoiding BullMQ's non-escalatable cached close promise.
    const blockingConnection = (
      worker as unknown as {
        blockingConnection?: { disconnect(force?: boolean): Promise<void> };
      }
    ).blockingConnection;
    if (blockingConnection) await blockingConnection.disconnect(true);

    // Let the interrupted fetch/main-loop continuation run before deciding
    // that there are no active jobs.
    await new Promise<void>((resolve) => setImmediate(resolve));

    await withTimeout(
      activity ? waitUntilJobsSettle(activity) : Promise.resolve(),
      timeoutMs,
      `worker ${worker.name} did not drain within ${timeoutMs}ms`,
    );
    settled = true;
  } catch (err) {
    if (!(err instanceof OperationTimeoutError)) {
      logger.error(
        `worker ${worker.name} failed while pausing for shutdown: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  if (!settled) {
    logger.warn(
      `worker ${worker.name} did not drain within ${timeoutMs}ms; cancelling active work ` +
        `and closing so the job can be recovered`,
    );
    worker.cancelAllJobs('worker shutdown grace period expired');
  }

  // This is intentionally the first close() call. Passing force=true here
  // guarantees BullMQ closes both its normal and blocking Redis connections
  // even if an application processor ignored the cancellation signal.
  await worker.close(true);
}
