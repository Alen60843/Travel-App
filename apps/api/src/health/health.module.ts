import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';
import { ReadinessService } from './readiness.service';

/**
 * Liveness + readiness endpoints.
 *
 * Deliberately imports nothing from src/database, src/redis, src/queue or
 * src/outbox — this module has no idea what a "dependency" is, only how to
 * run and aggregate whatever `ReadinessCheck`s are registered under
 * `READINESS_CHECK` (see readiness-check.interface.ts).
 *
 * There is no `READINESS_CHECK` provider declared here on purpose. Nest's
 * module DI is directional (an imported module's local providers are not
 * visible to the module that imported it, only the reverse via `exports`),
 * so a provider added to AppModule's own `providers` array would NOT reach
 * `ReadinessService` here. `ReadinessService` injects `READINESS_CHECK` with
 * `@Optional()`, so: (a) with nothing registered anywhere, it safely
 * defaults to zero checks; (b) the composition root (app.module.ts) can make
 * a real array of checks visible to this module by binding `READINESS_CHECK`
 * in a small `@Global()` module that imports the concrete check providers
 * (DatabaseModule, QueueModule, OutboxModule, ...) and exports the token.
 * That keeps the aggregation wiring where the checks themselves are known,
 * without HealthModule ever importing them.
 */
@Module({
  controllers: [HealthController],
  providers: [ReadinessService],
  exports: [ReadinessService],
})
export class HealthModule {}
