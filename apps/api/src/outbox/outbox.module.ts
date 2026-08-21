import { Module, type DynamicModule } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { QueueModule } from '../queue/queue.module';
import { EffectCounterRegistry } from './effect-counter.registry';
import { OutboxAcknowledger } from './outbox-acknowledger.service';
import { OutboxEnqueuer } from './outbox-enqueuer.service';
import { OutboxMetrics } from './outbox-metrics';
import { OutboxRelay } from './outbox-relay.service';

export interface OutboxModuleOptions {
  /**
   * Run the polling relay in this process.
   *
   * Defaults to false, and the default is the important part: the relay is a
   * background poller that claims rows and publishes to Redis. Running it
   * inside the HTTP deployable would put that work on the same event loop as
   * request handling, and would also mean every autoscaled web replica adds
   * another poller hammering `job_outbox`. Only the worker deployable sets
   * this true.
   *
   * `OUTBOX_ENABLED=false` remains an independent operational kill-switch for
   * the worker, checked at runtime by the relay itself.
   */
  readonly runRelay?: boolean;
}

/**
 * The transactional outbox: enqueue API, acknowledgement, metrics, and
 * optionally the relay.
 *
 * Deliberately does NOT provide `DataSource` itself — services here take it
 * via constructor injection, resolved from DatabaseModule's re-exported
 * TypeOrmModule. This module owns no entities and no migrations: outbox
 * claiming is raw SQL against `job_outbox` precisely because
 * `FOR UPDATE SKIP LOCKED` has no ORM-idiomatic equivalent worth using.
 */
@Module({})
export class OutboxModule {
  static forRoot(options: OutboxModuleOptions = {}): DynamicModule {
    const alwaysProvided = [
      OutboxEnqueuer,
      OutboxAcknowledger,
      OutboxMetrics,
      EffectCounterRegistry,
    ];

    // The relay is only *provided* when this process should run it. Gating on
    // provision rather than on a runtime flag inside the service means a
    // process that should not relay cannot accidentally start one — there is
    // no instance to start.
    const providers = options.runRelay ? [...alwaysProvided, OutboxRelay] : alwaysProvided;

    return {
      module: OutboxModule,
      imports: [DatabaseModule, QueueModule],
      providers,
      exports: providers,
    };
  }
}
