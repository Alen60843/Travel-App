import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { withTimeout } from '../common/with-timeout';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { CACHE_REDIS, QUEUE_REDIS } from './redis.tokens';
import type { ReadinessCheck } from './readiness-check.interface';

/**
 * Pings both Redis connections and reports which one, if any, failed.
 *
 * Both pings run concurrently via `Promise.allSettled` (not `Promise.all`) so
 * one connection being down doesn't short-circuit the check before we learn
 * about the other — the whole point of naming which instance failed is lost
 * if we only ever see the first rejection.
 */
@Injectable()
export class RedisReadinessCheck implements ReadinessCheck {
  readonly name = 'redis';

  constructor(
    @Inject(QUEUE_REDIS) private readonly queueRedis: Redis,
    @Inject(CACHE_REDIS) private readonly cacheRedis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async check(): Promise<{ healthy: boolean; detail?: string }> {
    const timeoutMs = this.config.app.dependencyCheckTimeoutMs;
    const [queueResult, cacheResult] = await Promise.allSettled([
      withTimeout(this.queueRedis.ping(), timeoutMs, `queue Redis ping timed out after ${timeoutMs}ms`),
      withTimeout(this.cacheRedis.ping(), timeoutMs, `cache Redis ping timed out after ${timeoutMs}ms`),
    ]);

    const failures: string[] = [];
    if (queueResult.status === 'rejected') {
      failures.push(`queue: ${describeReason(queueResult.reason)}`);
    }
    if (cacheResult.status === 'rejected') {
      failures.push(`cache: ${describeReason(cacheResult.reason)}`);
    }

    if (failures.length === 0) {
      return { healthy: true };
    }
    return { healthy: false, detail: failures.join('; ') };
  }
}

function describeReason(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
