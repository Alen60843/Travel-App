import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { Worker } from 'bullmq';
import type Redis from 'ioredis';

import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { QUEUE_REDIS } from '../redis/redis.tokens';
import { closeWorkerGracefully, createWorker } from './worker.factory';
import { WORKER_DEFINITION, type WorkerDefinition } from './worker-definition';

/**
 * Owns the lifetime of every BullMQ worker in this process.
 *
 * Without something like this, jobs are published to Redis and nothing ever
 * consumes them — the failure is silent, because publishing succeeds and
 * `job_outbox.published_at` gets set. Only `completed_at` staying NULL reveals
 * it, and only if someone looks.
 *
 * Shutdown uses OnApplicationShutdown rather than OnModuleDestroy so workers
 * stop *after* the relay has stopped claiming new rows: Nest runs
 * onModuleDestroy for every provider before any onApplicationShutdown, which
 * gives exactly the ordering we want — stop taking new work, then drain what
 * is already in flight.
 */
@Injectable()
export class WorkerHost implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerHost.name);
  private readonly workers: Worker[] = [];

  constructor(
    @Inject(QUEUE_REDIS) private readonly connection: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional()
    @Inject(WORKER_DEFINITION)
    private readonly definitions: readonly WorkerDefinition[] = [],
  ) {}

  onModuleInit(): void {
    if (this.definitions.length === 0) {
      // Normal for the HTTP API, which produces but does not consume.
      this.logger.log('no worker definitions registered; this process consumes no queues');
      return;
    }

    for (const definition of this.definitions) {
      const worker = createWorker(this.connection, this.config, {
        name: definition.name,
        processor: definition.processor,
        ...(definition.concurrency === undefined
          ? {}
          : { concurrency: definition.concurrency }),
      });
      this.workers.push(worker);
      this.logger.log(
        `worker started: queue=${definition.name} concurrency=${definition.concurrency ?? 'default'}`,
      );
    }
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    if (this.workers.length === 0) return;

    this.logger.log(
      `stopping ${this.workers.length} worker(s)${signal ? ` (signal=${signal})` : ''}`,
    );

    // Closed in parallel: each close is bounded by shutdownTimeoutMs, so
    // sequential closes would multiply the worst case by the worker count and
    // blow through the orchestrator's termination grace period.
    await Promise.all(
      this.workers.map((worker) =>
        closeWorkerGracefully(worker, this.config.app.shutdownTimeoutMs).catch((err: unknown) => {
          this.logger.error(
            `worker ${worker.name} failed to close cleanly: ${(err as Error).message}`,
          );
        }),
      ),
    );

    this.workers.length = 0;
    this.logger.log('all workers stopped');
  }
}
