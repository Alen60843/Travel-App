import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';

import { OutboxRelay } from './outbox/outbox-relay.service';
import { WorkerHost } from './queue/worker-host.service';

/**
 * Enforces the worker deployable's shutdown dependency order.
 *
 * Nest destroys the root module before its imported modules. Keeping this
 * coordinator in WorkerModule therefore guarantees:
 *
 *   stop relay claims -> drain/close workers -> imported DB/Redis teardown
 *
 * Lifecycle phases alone cannot express that order: putting WorkerHost in
 * `onApplicationShutdown` runs it only after every provider's
 * `onModuleDestroy`, including the provider that closes Redis.
 */
@Injectable()
export class WorkerShutdownCoordinator implements OnModuleDestroy {
  private readonly logger = new Logger(WorkerShutdownCoordinator.name);

  constructor(
    private readonly relay: OutboxRelay,
    private readonly workers: WorkerHost,
  ) {}

  async onModuleDestroy(): Promise<void> {
    this.logger.log('worker shutdown sequence starting');
    await this.relay.stop();
    await this.workers.shutdown();
    this.logger.log('worker shutdown sequence complete');
  }
}
