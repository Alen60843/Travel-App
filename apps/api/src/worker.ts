import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { ConfigValidationError, loadConfig, type AppConfig } from './config/configuration';
import { LOGGER } from './observability/tokens';
import { WorkerModule } from './worker.module';

/**
 * Entrypoint for the **worker deployable**.
 *
 * `createApplicationContext` rather than `create`: this process has no HTTP
 * server, no routes and no port. It exists to drive the outbox relay and
 * consume BullMQ queues.
 *
 * Run with `node dist/worker.js` (script: `pnpm start:worker`).
 */
async function bootstrap(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      // Same fail-fast posture as the API: print every problem at once and
      // refuse to start. A worker that boots half-configured silently stops
      // draining queues, which is harder to notice than a crash.
      // eslint-disable-next-line no-console
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });

  const logger = app.get(LOGGER);
  app.useLogger(logger);

  // Wires SIGTERM/SIGINT to app.close(). Ordering matters and Nest guarantees
  // it: every onModuleDestroy runs before any onApplicationShutdown, so the
  // relay stops claiming new rows (OutboxRelay.onModuleDestroy) before the
  // workers drain (WorkerHost.onApplicationShutdown). Draining while still
  // claiming would never converge.
  app.enableShutdownHooks();

  logger.log(
    `Worker started (env=${config.app.env}, outboxEnabled=${config.outbox.enabled})`,
    'WorkerBootstrap',
  );
}

process.on('unhandledRejection', (reason: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[worker] unhandled rejection', reason);
  process.exit(1);
});

process.on('uncaughtException', (err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[worker] uncaught exception', err);
  process.exit(1);
});

void bootstrap();
