import type { BeforeApplicationShutdown, LoggerService, OnApplicationShutdown } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { LOGGER } from './tokens';

/**
 * Graceful-shutdown logging + a hard deadline.
 *
 * `app.enableShutdownHooks()` (called once in main.ts) wires SIGTERM/SIGINT
 * to `app.close()`, which itself: (1) stops the HTTP server from accepting
 * new connections while letting in-flight requests finish — that's plain
 * Node `http.Server.close()` semantics, nothing to reimplement — then (2)
 * runs every provider's `onModuleDestroy`/`beforeApplicationShutdown`/
 * `onApplicationShutdown` hooks so other agents' modules (DB pool, Redis,
 * queue workers) can release their own resources.
 *
 * `beforeApplicationShutdown` fires after `onModuleDestroy` hooks and before
 * transport disposal / `onApplicationShutdown`. Every module-destroy hook in
 * this codebase therefore has its own bounded close; this watchdog covers the
 * remaining transport/application-shutdown phases. `onApplicationShutdown`
 * logs completion and disarms it.
 *
 * Deliberately NOT a second `process.on('SIGTERM', ...)` handler: Nest's
 * `enableShutdownHooks()` already owns that signal, and installing a second,
 * independent one here would race it instead of composing with it.
 */
@Injectable()
export class ShutdownService implements BeforeApplicationShutdown, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: LoggerService,
  ) {}

  beforeApplicationShutdown(signal?: string): void {
    const label = signal ?? 'manual';
    this.logger.log(`Graceful shutdown starting (signal=${label})`, 'ShutdownService');

    const timeoutMs = this.config.app.shutdownTimeoutMs;
    this.timer = setTimeout(() => {
      this.logger.error(
        `Graceful shutdown did not complete within ${timeoutMs}ms; forcing exit`,
        undefined,
        'ShutdownService',
      );
      process.exit(1);
    }, timeoutMs);
    // Never let this watchdog itself keep the process alive.
    this.timer.unref();
  }

  onApplicationShutdown(signal?: string): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const label = signal ?? 'manual';
    this.logger.log(`Graceful shutdown complete (signal=${label})`, 'ShutdownService');
  }
}
