import { Global, Module } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { InMemoryMetricsService } from './in-memory-metrics.service';
import { PinoLoggerService } from './pino-logger.service';
import { ShutdownService } from './shutdown.service';
import { LOGGER, METRICS } from './tokens';

/**
 * Global observability module: logger, metrics, graceful-shutdown logging.
 *
 * `@Global()` so `LOGGER`/`METRICS` are injectable anywhere in the app
 * (including in modules owned by other agents) without every module having
 * to import this one — the same pattern `ConfigModule` already uses for
 * `APP_CONFIG`. Import this once, from the root module.
 */
@Global()
@Module({
  providers: [
    {
      provide: LOGGER,
      useFactory: (config: AppConfig) => PinoLoggerService.create(config),
      inject: [APP_CONFIG],
    },
    { provide: METRICS, useClass: InMemoryMetricsService },
    ShutdownService,
  ],
  exports: [LOGGER, METRICS],
})
export class ObservabilityModule {}
