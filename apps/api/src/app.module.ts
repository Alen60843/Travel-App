import { Global, Module } from '@nestjs/common';

import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { DatabaseReadinessCheck } from './database/database-readiness.check';
import { HealthModule } from './health/health.module';
import { READINESS_CHECK, type ReadinessCheck } from './health/readiness-check.interface';
import { ObservabilityModule } from './observability/observability.module';
import { OutboxModule } from './outbox/outbox.module';
import { QueueModule } from './queue/queue.module';
import { RedisModule } from './redis/redis.module';
import { RedisReadinessCheck } from './redis/redis-readiness.check';
import { RealtimeModule } from './realtime/realtime.module';

/**
 * Binds the concrete readiness checks to the token HealthModule consumes.
 *
 * This exists as its own @Global() module rather than a provider on AppModule
 * because Nest's module visibility only flows from an imported module's
 * exports to its importer — never the reverse. A provider declared directly on
 * AppModule is invisible to HealthModule, so readiness would silently report
 * healthy with an empty check list: the worst possible failure mode for a
 * readiness probe, since it fails *open*.
 *
 * HealthModule deliberately knows nothing about databases or Redis; it
 * aggregates whatever is bound here. Adding a dependency to the readiness
 * surface means adding it to this array and nowhere else.
 */
@Global()
@Module({
  imports: [DatabaseModule, RedisModule],
  providers: [
    {
      provide: READINESS_CHECK,
      useFactory: (database: DatabaseReadinessCheck, redis: RedisReadinessCheck): ReadinessCheck[] => [
        database,
        redis,
      ],
      inject: [DatabaseReadinessCheck, RedisReadinessCheck],
    },
  ],
  exports: [READINESS_CHECK],
})
export class ReadinessRegistryModule {}

/**
 * Root module — the composition root, owned by the Lead.
 *
 * Phase 2 wires infrastructure only. Domain modules (Auth, Users, Trips,
 * Explorer, Matching, Events, Chat, Marketplace, Payments, Trust, Safety)
 * arrive in their own phases and must not be imported here before then.
 *
 * Import order below follows the dependency direction rather than
 * alphabetical: configuration and observability first because everything
 * reads them, then storage, then the queue layer that depends on storage,
 * then the transports.
 */
@Module({
  imports: [
    ConfigModule,
    ObservabilityModule,

    DatabaseModule,
    RedisModule,

    QueueModule,

    // Enqueue-only in the HTTP deployable: domain code writes job_outbox rows
    // inside its transactions, but the polling relay runs exclusively in the
    // worker process (see worker.module.ts). Running it here would put
    // background polling on the request event loop and would add another
    // poller for every autoscaled web replica.
    OutboxModule.forRoot({ runRelay: false }),

    // Fail-closed by default: RejectingSocketAuthenticator refuses every
    // connection until Phase 3 supplies a real Firebase authenticator via
    // RealtimeModule.forRoot({ authenticatorProvider: ... }). Wiring a
    // permissive default here would be a security hole introduced by omission.
    RealtimeModule.forRoot(),

    ReadinessRegistryModule,
    HealthModule,
  ],
})
export class AppModule {}
