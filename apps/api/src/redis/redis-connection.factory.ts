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
    // This connection is used by Queue producers and readiness checks, not by
    // BullMQ Worker blocking commands. Producer calls must fail in bounded
    // time during an outage so the PostgreSQL outbox can schedule a retry and
    // readiness can return 503 instead of hanging forever.
    maxRetriesPerRequest: 1,
  });
}

/**
 * Creates the dedicated connection used only by BullMQ Workers.
 *
 * Workers legitimately issue blocking Redis commands and BullMQ requires
 * `maxRetriesPerRequest: null` for that role. Keeping this separate from the
 * producer/readiness connection is what gives each side the correct failure
 * behavior: persistent reconnect for consumers, bounded failure for calls.
 * The WorkerHost owns and closes this connection.
 */
export function createWorkerRedisConnection(config: AppConfig): Redis {
  return new Redis(config.redisQueue.url, {
    ...commonOptions,
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
