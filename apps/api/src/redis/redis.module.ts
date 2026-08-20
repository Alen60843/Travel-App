import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { CacheService } from './cache.service';
import { createCacheRedisConnection, createQueueRedisConnection } from './redis-connection.factory';
import { RedisLifecycleService } from './redis-lifecycle.service';
import { RedisReadinessCheck } from './redis-readiness.check';
import { CACHE_REDIS, QUEUE_REDIS } from './redis.tokens';

/**
 * Provides the two independent Redis connections plus everything built
 * directly on top of them (cache, readiness, lifecycle). Downstream modules
 * (Queue, Outbox) import this module rather than constructing their own
 * connections — there must be exactly one ioredis instance per logical
 * connection in the process.
 */
@Module({
  providers: [
    {
      provide: QUEUE_REDIS,
      useFactory: (config: AppConfig) => createQueueRedisConnection(config),
      inject: [APP_CONFIG],
    },
    {
      provide: CACHE_REDIS,
      useFactory: (config: AppConfig) => createCacheRedisConnection(config),
      inject: [APP_CONFIG],
    },
    CacheService,
    RedisReadinessCheck,
    RedisLifecycleService,
  ],
  exports: [QUEUE_REDIS, CACHE_REDIS, CacheService, RedisReadinessCheck],
})
export class RedisModule {}
