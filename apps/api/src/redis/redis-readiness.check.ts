import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
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
  ) {}

  async check(): Promise<{ healthy: boolean; detail?: string }> {
    const [queueResult, cacheResult] = await Promise.allSettled([
      this.queueRedis.ping(),
      this.cacheRedis.ping(),
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
