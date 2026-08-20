import Redis, { type RedisOptions } from 'ioredis';
import type { AppConfig } from '../config/configuration';

/**
 * Builds the two independent Redis connections.
 *
 * Each factory takes its URL from a DISTINCT config key
 * (`config.redisQueue.url` / `config.redisCache.url`) and never derives one
 * from the other — in production these are different servers with different
 * `maxmemory-policy` values (§6.2 of the Phase 1 design), and a shared
 * derivation would make it easy to accidentally collapse them back onto one
 * instance.
 *
 * `lazyConnect: false` (the ioredis default) so a connection failure surfaces
 * at startup / first use rather than silently on the first real command.
 */

const commonOptions: RedisOptions = {
  enableReadyCheck: true,
  // Exponential backoff capped at 2s; ioredis calls this after every
  // disconnect. Returning a number reconnects, `null`/`undefined` would give
  // up permanently — we never want to give up, Redis coming back is exactly
  // the recoverable case this whole design is built around.
  retryStrategy: (attempt: number) => Math.min(attempt * 200, 2_000),
};

export function createQueueRedisConnection(config: AppConfig): Redis {
  return new Redis(config.redisQueue.url, {
    ...commonOptions,
    // BullMQ REQUIRES this. It issues blocking commands internally (e.g. the
    // Lua-scripted equivalents of BZPOPMIN) that legitimately block for a
    // long time waiting for work; ioredis's per-command retry counter would
    // otherwise abort those waits with a spurious "reached the max retries
    // per request" error. This is not a tuning choice — BullMQ's own docs
    // mandate it and refuse connections that don't set it.
    maxRetriesPerRequest: null,
  });
}

export function createCacheRedisConnection(config: AppConfig): Redis {
  return new Redis(config.redisCache.url, {
    ...commonOptions,
    // The cache connection has no BullMQ blocking-command requirement, and
    // correctness never depends on it (see CacheService). A bounded retry
    // count means a struggling cache server fails a `get`/`set` quickly
    // instead of holding up the caller — consistent with "a cache miss is
    // harmless" from §6.2.
    maxRetriesPerRequest: 3,
  });
}
