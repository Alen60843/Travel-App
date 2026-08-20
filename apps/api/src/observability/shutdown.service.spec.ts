import type { LoggerService } from '@nestjs/common';

import type { AppConfig } from '../config/configuration';
import { ShutdownService } from './shutdown.service';

function fakeConfig(shutdownTimeoutMs: number): AppConfig {
  return { app: { shutdownTimeoutMs } } as AppConfig;
}

function fakeLogger(): LoggerService & { logs: unknown[][] } {
  const logs: unknown[][] = [];
  return {
    logs,
    log: (...a: unknown[]) => logs.push(['log', ...a]),
    error: (...a: unknown[]) => logs.push(['error', ...a]),
    warn: (...a: unknown[]) => logs.push(['warn', ...a]),
  };
}

describe('ShutdownService', () => {
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    jest.useRealTimers();
    exitSpy.mockRestore();
  });

  it('logs the start of shutdown and does not force-exit if it completes in time', () => {
    const logger = fakeLogger();
    const service = new ShutdownService(fakeConfig(10_000), logger);

    service.beforeApplicationShutdown('SIGTERM');
    expect(logger.logs.some((l) => String(l[1]).includes('starting') && String(l[1]).includes('SIGTERM'))).toBe(
      true,
    );

    jest.advanceTimersByTime(5_000);
    service.onApplicationShutdown('SIGTERM');

    jest.advanceTimersByTime(10_000);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(logger.logs.some((l) => String(l[1]).includes('complete'))).toBe(true);
  });

  it('force-exits with a non-zero code if shutdown does not complete within shutdownTimeoutMs', () => {
    const logger = fakeLogger();
    const service = new ShutdownService(fakeConfig(1_000), logger);

    service.beforeApplicationShutdown('SIGTERM');
    // onApplicationShutdown never called — simulates a hung close().
    jest.advanceTimersByTime(1_000);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logger.logs.some((l) => l[0] === 'error')).toBe(true);
  });

  it('handles a manual shutdown (no signal) without throwing', () => {
    const logger = fakeLogger();
    const service = new ShutdownService(fakeConfig(1_000), logger);

    expect(() => service.beforeApplicationShutdown(undefined)).not.toThrow();
    expect(() => service.onApplicationShutdown(undefined)).not.toThrow();
    expect(logger.logs.some((l) => String(l[1]).includes('manual'))).toBe(true);
  });

  it('clears the watchdog timer on completion so it cannot fire twice', () => {
    const logger = fakeLogger();
    const service = new ShutdownService(fakeConfig(1_000), logger);

    service.beforeApplicationShutdown('SIGTERM');
    service.onApplicationShutdown('SIGTERM');
    jest.advanceTimersByTime(5_000);

    expect(exitSpy).not.toHaveBeenCalled();
  });
});
