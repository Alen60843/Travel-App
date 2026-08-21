import { Module } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { ObservabilityModule } from './observability/observability.module';
import { EffectCounterRegistry } from './outbox/effect-counter.registry';
import { createInfraEchoProcessor } from './outbox/infra-echo.processor';
import { OutboxAcknowledger } from './outbox/outbox-acknowledger.service';
import { OutboxModule } from './outbox/outbox.module';
import { QueueModule } from './queue/queue.module';
import { WorkerHost } from './queue/worker-host.service';
import { INFRA_ECHO_TOPIC } from './queue/jobs/infra-echo.job';
import {
  WORKER_DEFINITION,
  defineWorker,
  type WorkerDefinition,
} from './queue/worker-definition';
import { RedisModule } from './redis/redis.module';

/**
 * Composition root for the **worker deployable**.
 *
 * This is a separate process from the HTTP API, sharing its code but not its
 * runtime. Two reasons, both from the Phase 1 architecture:
 *
 *   1. A burst of background work must not contend with request latency. The
 *      relay claims rows and publishes to Redis in a loop; job processors do
 *      arbitrary work. Neither belongs on the event loop serving users.
 *   2. They scale on different signals. Web replicas scale with request rate;
 *      workers scale with queue depth. Coupling them means overprovisioning
 *      one to satisfy the other, and it means every autoscaled web replica
 *      adds another poller against `job_outbox`.
 *
 * Deliberately absent: no controllers, no Socket.IO gateway, no HTTP server.
 * The worker consumes queues and drives the relay; it serves nothing.
 */
@Module({
  imports: [
    ConfigModule,
    ObservabilityModule,
    DatabaseModule,
    RedisModule,
    QueueModule,

    // The relay runs HERE and only here.
    OutboxModule.forRoot({ runRelay: true }),
  ],
  providers: [
    // WorkerHost lives here, not in QueueModule: it must be in the same module
    // as the WORKER_DEFINITION binding to see it. Nest only propagates
    // providers from an imported module's exports to its importer, never the
    // reverse.
    WorkerHost,
    {
      // The infrastructure proof-of-pipeline job. It has no business meaning:
      // it exists so the full path DB -> relay -> BullMQ -> worker -> ack is
      // exercised by a real running process rather than asserted in a test
      // that calls tick() by hand.
      provide: WORKER_DEFINITION,
      useFactory: (
        dataSource: DataSource,
        acknowledger: OutboxAcknowledger,
        effects: EffectCounterRegistry,
      ): WorkerDefinition[] => [
        defineWorker({
          name: INFRA_ECHO_TOPIC,
          processor: createInfraEchoProcessor(dataSource, acknowledger, effects),
        }),
      ],
      inject: [DataSource, OutboxAcknowledger, EffectCounterRegistry],
    },
  ],
})
export class WorkerModule {}
