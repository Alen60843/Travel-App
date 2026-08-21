import { Global, Module } from '@nestjs/common';

import { AuthModule, FirebaseSocketAuthenticator } from './auth';
import { ConfigModule } from './config/config.module';
import { ConsentModule } from './consent';
import { DatabaseModule } from './database/database.module';
import { DatabaseReadinessCheck } from './database/database-readiness.check';
import { HealthModule } from './health/health.module';
import { MatchingModule } from './matching';
import { READINESS_CHECK, type ReadinessCheck } from './health/readiness-check.interface';
import { ObservabilityModule } from './observability/observability.module';
import { OutboxModule } from './outbox/outbox.module';
import { QueueModule } from './queue/queue.module';
import { RedisModule } from './redis/redis.module';
import { RedisReadinessCheck } from './redis/redis-readiness.check';
import { RealtimeModule } from './realtime/realtime.module';
import { SOCKET_AUTHENTICATOR } from './realtime/socket-authenticator';
import { SettingsModule } from './settings';
import { SwipesModule } from './swipes';
import { TripsModule } from './trips';
import { UsersModule } from './users';

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
 * Phase 2 wires infrastructure; Phase 3 adds only identity-domain modules.
 * Trips, Explorer, Matching, Events, Chat, Marketplace, Payments, Trust and
 * Safety remain intentionally absent until their approved phases.
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

    AuthModule,
    UsersModule,
    SettingsModule,
    ConsentModule,
    TripsModule,
    MatchingModule,
    SwipesModule,

    // Phase 3 explicitly replaces the infrastructure shell's fail-closed
    // authenticator with Firebase verification plus internal-user resolution.
    RealtimeModule.forRoot({
      authenticatorProvider: {
        provide: SOCKET_AUTHENTICATOR,
        useExisting: FirebaseSocketAuthenticator,
      },
    }),

    ReadinessRegistryModule,
    HealthModule,
  ],
})
export class AppModule {}
