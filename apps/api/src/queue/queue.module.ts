import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { QueueRegistry } from './queue-registry.service';

/**
 * BullMQ foundation: the shared Queue registry, retry/backoff defaults, and
 * the worker host.
 *
 * Producing and consuming are separate concerns on purpose. `QueueRegistry`
 * gets-or-creates a Queue so any process can enqueue; `WorkerHost` starts a
 * BullMQ Worker for every `WORKER_DEFINITION` bound in this process, so only
 * the deployables that should consume actually do. The HTTP API binds none and
 * consumes nothing; the worker deployable binds them and drains the queues.
 *
 * `WorkerHost` is deliberately NOT provided here. Which queues a process
 * consumes is a decision for that deployable's composition root, and Nest
 * module visibility makes the point concrete: a WORKER_DEFINITION bound in
 * the composition root is invisible to a provider living inside this module,
 * so a WorkerHost here would always start zero workers.
 */
@Module({
  imports: [RedisModule],
  providers: [QueueRegistry],
  exports: [QueueRegistry],
})
export class QueueModule {}
