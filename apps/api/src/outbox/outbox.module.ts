import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { QueueModule } from '../queue/queue.module';
import { EffectCounterRegistry } from './effect-counter.registry';
import { OutboxAcknowledger } from './outbox-acknowledger.service';
import { OutboxEnqueuer } from './outbox-enqueuer.service';
import { OutboxMetrics } from './outbox-metrics';
import { OutboxRelay } from './outbox-relay.service';

/**
 * The transactional outbox: enqueue API, relay, acknowledgement, metrics.
 *
 * Deliberately does NOT provide `DataSource` itself — every service here
 * takes it via plain constructor injection (`private readonly dataSource:
 * DataSource` from `typeorm`), resolved from whatever module in the overall
 * app graph registers it (Agent A's database module, via
 * `@nestjs/typeorm`'s `TypeOrmModule.forRoot()`). The Lead wires that import
 * into `AppModule` alongside this one. This module owns no entities and no
 * migrations — outbox claiming is raw SQL against `job_outbox` precisely
 * because `FOR UPDATE SKIP LOCKED` has no ORM-idiomatic equivalent worth
 * using.
 */
@Module({
  // DatabaseModule re-exports TypeOrmModule, which is what makes the DataSource
  // token resolvable inside this module's injector context.
  imports: [DatabaseModule, QueueModule],
  providers: [OutboxEnqueuer, OutboxAcknowledger, OutboxRelay, OutboxMetrics, EffectCounterRegistry],
  exports: [OutboxEnqueuer, OutboxAcknowledger, OutboxRelay, OutboxMetrics, EffectCounterRegistry],
})
export class OutboxModule {}
