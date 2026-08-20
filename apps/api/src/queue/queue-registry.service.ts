import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue, type Job, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { QUEUE_REDIS } from '../redis/redis.tokens';
import { assertBullMqCompatibleJobId } from './job-id';
import { DEFAULT_JOB_OPTIONS } from './queue.constants';

/**
 * Lazily creates and memoizes one BullMQ `Queue` per name, and is the only
 * sanctioned way to enqueue a job in this codebase.
 *
 * Two structural guarantees live here:
 *
 * 1. Every Queue this process creates shares the SAME ioredis connection
 *    (`QUEUE_REDIS`) and the SAME `prefix` (`QUEUE_PREFIX`). BullMQ
 *    duplicates the connection internally wherever it needs a dedicated
 *    blocking socket, so sharing one instance here is the documented,
 *    supported pattern — not a shortcut. Sharing the prefix is what keeps
 *    every queue this process touches under one namespace on a Redis
 *    instance shared with other agents/services.
 *
 * 2. `addJob` requires `jobId` as a normal (non-optional) parameter. There
 *    is deliberately no method that calls BullMQ's `queue.add()` without
 *    one. Deterministic job IDs are what make a re-publish collapse onto an
 *    existing job instead of creating a duplicate (§6.3) — making the
 *    parameter impossible to omit turns "please remember to pass a jobId"
 *    into a compiler error instead of a code-review hope.
 */
@Injectable()
export class QueueRegistry implements OnModuleDestroy {
  private readonly logger = new Logger(QueueRegistry.name);
  private readonly queues = new Map<string, Queue>();

  constructor(
    @Inject(QUEUE_REDIS) private readonly connection: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Returns the memoized Queue for `name`, creating it on first use.
   *
   * Returned untyped (bare `Queue`, BullMQ's `any`-defaulted generics)
   * rather than parameterised per call site. BullMQ derives its job-name
   * type (`NameType`) from the data-type generic via a conditional type
   * (`ExtractNameType`) that only resolves against a CONCRETE data type, not
   * a still-generic `T` bound at the call site of a wrapper method like this
   * one — parameterising here just relocates the same unresolved-conditional
   * error into this file. `addJob<T>` below is the actual caller-facing
   * generic boundary; this method's job is only to memoize connections.
   */
  getQueue(name: string): Queue {
    const existing = this.queues.get(name);
    if (existing) return existing;

    const queue = new Queue(name, {
      connection: this.connection,
      prefix: this.config.redisQueue.prefix,
    });
    this.queues.set(name, queue);
    return queue;
  }

  /**
   * The only sanctioned enqueue path. `jobId` is mandatory — see class
   * doc — and is what a caller derives deterministically (e.g. the outbox's
   * `dedupe_key`) so that at-least-once publication is safe to retry.
   */
  async addJob<T = unknown>(
    queueName: string,
    jobName: string,
    data: T,
    jobId: string,
    opts?: Omit<JobsOptions, 'jobId'>,
  ): Promise<Job<T>> {
    assertBullMqCompatibleJobId(jobId);
    const queue = this.getQueue(queueName);
    const job = await queue.add(jobName, data, { ...DEFAULT_JOB_OPTIONS, ...opts, jobId });
    return job as Job<T>;
  }

  async onModuleDestroy(): Promise<void> {
    const closes = [...this.queues.values()].map(async (queue) => {
      try {
        await queue.close();
      } catch (err) {
        this.logger.warn(`failed to close queue ${queue.name}: ${(err as Error).message}`);
      }
    });
    await Promise.all(closes);
    this.queues.clear();
  }
}
