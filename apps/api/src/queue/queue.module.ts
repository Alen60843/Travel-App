import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { QueueRegistry } from './queue-registry.service';

/**
 * BullMQ foundation: queue registration + defaults. Worker bootstrap
 * (`createWorker`/`closeWorkerGracefully` in `worker.factory.ts`) is
 * deliberately exported as plain functions rather than Nest providers —
 * workers are created per job-type by whoever owns that job (a later-phase
 * domain module, or this module's own infra-only echo job), not centrally
 * registered here. This module owns only what is genuinely shared: the
 * connection-backed Queue registry and the retry/backoff defaults.
 */
@Module({
  imports: [RedisModule],
  providers: [QueueRegistry],
  exports: [QueueRegistry],
})
export class QueueModule {}
