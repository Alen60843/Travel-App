import 'reflect-metadata';

import { RequestMethod, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { CorrelationMiddleware } from './common/middleware/correlation.middleware';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { createValidationPipe } from './common/pipes/create-validation-pipe';
import { ConfigValidationError, loadConfig, type AppConfig } from './config/configuration';
import { LOGGER } from './observability/tokens';
import { RedisIoAdapter } from './realtime/redis-io.adapter';

/**
 * Last-resort safety net for errors that escape everything else (including
 * the logger itself, or a bug in bootstrap before the logger exists).
 * Deliberately does NOT go through the pino pipeline — if the process is
 * broken badly enough to hit this, the simplest, most reliable path to get
 * *something* logged before exiting matters more than consistent formatting.
 */
function logFatalAndExit(kind: string, error: unknown): never {
  const payload = {
    level: 'fatal',
    time: new Date().toISOString(),
    kind,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
  // eslint-disable-next-line no-console
  console.error(JSON.stringify(payload));
  process.exit(1);
}

process.on('unhandledRejection', (reason) => logFatalAndExit('unhandledRejection', reason));
process.on('uncaughtException', (err) => logFatalAndExit('uncaughtException', err));

async function bootstrap(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      // Print every problem at once and refuse to boot — a half-configured
      // API that starts accepting traffic is worse than one that doesn't.
      // eslint-disable-next-line no-console
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Buffer Nest's own bootstrap-time logs until app.useLogger() below
    // installs the real (pino) logger, instead of losing them or falling
    // back to the default console logger.
    bufferLogs: true,
  });

  const logger = app.get(LOGGER);
  app.useLogger(logger);

  app.use(helmet());

  // No cross-origin allow-list is configured yet — no browser-facing
  // frontend origin exists at this phase. Conservative default: disabled in
  // production (same-origin/non-browser clients are unaffected — CORS is a
  // browser-enforced mechanism, so mobile/native clients don't need it),
  // permissive in development for local frontend convenience.
  app.enableCors({
    origin: config.app.isProduction ? false : true,
    credentials: true,
  });

  const correlationMiddleware = new CorrelationMiddleware();
  app.use((req: never, res: never, next: (error?: unknown) => void) => {
    correlationMiddleware.use(req, res, next);
  });

  app.useGlobalFilters(new GlobalExceptionFilter(logger));
  app.useGlobalPipes(createValidationPipe());

  // Health endpoints must stay reachable without the API prefix or version —
  // orchestrator probes are configured with a fixed path and know nothing
  // about either. (Also exempted from versioning via VERSION_NEUTRAL on the
  // controller itself; see health.controller.ts.)
  app.setGlobalPrefix(config.app.apiPrefix, {
    exclude: [
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
    ],
  });

  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: config.app.defaultVersion,
  });

  app.useBodyParser('json', { limit: config.app.bodyLimit });
  app.useBodyParser('urlencoded', { limit: config.app.bodyLimit, extended: true });

  // Wires SIGTERM/SIGINT to app.close(), which stops the HTTP server from
  // accepting new connections while in-flight requests drain, then runs
  // every provider's shutdown hooks (see observability/shutdown.service.ts
  // for the logging + shutdownTimeoutMs watchdog).
  app.enableShutdownHooks();

  // Socket.IO rooms must live in Redis, not instance memory: the API is
  // stateless and horizontally scaled, so without this adapter a message
  // broadcast to `user:{id}` only reaches sockets that happen to be connected
  // to the same process. Nest's default IoAdapter works fine in local
  // development, which is exactly what makes the omission dangerous — it fails
  // only under scale-out, in production.
  //
  // connectToRedis() throws if Redis is unreachable, and that is deliberately
  // not caught: booting with a silently degraded realtime layer is worse than
  // refusing to boot.
  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis(config.redisCache.url);
  app.useWebSocketAdapter(redisIoAdapter);
  logger.log('Socket.IO Redis adapter connected', 'Bootstrap');

  await app.listen(config.app.port);
  logger.log(
    `Listening on port ${config.app.port} (prefix=/${config.app.apiPrefix}, env=${config.app.env})`,
    'Bootstrap',
  );
}

bootstrap().catch((err: unknown) => logFatalAndExit('bootstrapFailure', err));
