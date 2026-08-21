import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleInit,
} from '@nestjs/common';
import type { Worker } from 'bullmq';
import type Redis from 'ioredis';

import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { createWorkerRedisConnection } from '../redis/redis-connection.factory';
import { closeRedisGracefully } from '../redis/redis-lifecycle.service';
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
 * Shutdown is invoked by WorkerShutdownCoordinator in the worker composition
 * root. That coordinator stops the relay first, then calls `shutdown()` here,
 * before imported database/Redis modules begin their own destruction.
 */
@Injectable()
export class WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(WorkerHost.name);
  private readonly workers: Worker[] = [];
  private connection: Redis | null = null;
  private shutdownInFlight: Promise<void> | null = null;

  constructor(
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

    // Workers use a dedicated persistent-retry connection. Queue producers
    // and readiness checks use the bounded QUEUE_REDIS connection instead;
    // sharing one connection made an outage hang producer calls forever.
    this.connection = createWorkerRedisConnection(this.config);

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

  shutdown(): Promise<void> {
    if (this.shutdownInFlight) return this.shutdownInFlight;
    this.shutdownInFlight = this.performShutdown().finally(() => {
      this.shutdownInFlight = null;
    });
    return this.shutdownInFlight;
  }

  private async performShutdown(): Promise<void> {
    if (this.workers.length === 0 && !this.connection) return;

    this.logger.log(`stopping ${this.workers.length} worker(s)`);

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
    if (this.connection) {
      await closeRedisGracefully(
        this.connection,
        'BullMQ worker',
        Math.min(2_000, this.config.app.shutdownTimeoutMs),
        this.logger,
      );
      this.connection = null;
    }
    this.logger.log('all workers stopped');
  }
}
