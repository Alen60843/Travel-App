import Redis from 'ioredis';
import { loadConfig } from '../config/configuration';
import { CacheService } from './cache.service';
import { createCacheRedisConnection, createQueueRedisConnection } from './redis-connection.factory';
import { RedisLifecycleService } from './redis-lifecycle.service';
import { RedisReadinessCheck } from './redis-readiness.check';

/** A connection that fails fast instead of retrying forever, for negative-path tests. */
function createUnreachableRedis(): Redis {
  return new Redis({
    host: '127.0.0.1',
    port: 1, // nothing listens on port 1
    lazyConnect: true,
    enableOfflineQueue: false,
    retryStrategy: () => null, // give up after the first failed attempt
    connectTimeout: 300,
    maxRetriesPerRequest: 1,
  });
}

describe('redis infrastructure (integration)', () => {
  const config = loadConfig(process.env);
  let queueRedis: Redis;
  let cacheRedis: Redis;

  beforeAll(() => {
    queueRedis = createQueueRedisConnection(config);
    cacheRedis = createCacheRedisConnection(config);
  });

  afterAll(async () => {
    await queueRedis.quit();
    await cacheRedis.quit();
  });

  it('connects to the queue redis instance', async () => {
    expect(await queueRedis.ping()).toBe('PONG');
  });

  it('connects to the cache redis instance, independently of the queue connection', async () => {
    expect(await cacheRedis.ping()).toBe('PONG');
    // Two genuinely separate ioredis instances, not one shared connection.
    expect(cacheRedis).not.toBe(queueRedis);
  });

  it('sets maxRetriesPerRequest=null on the queue connection (hard BullMQ requirement)', () => {
    expect(queueRedis.options.maxRetriesPerRequest).toBeNull();
  });

  it('bounds retries on the cache connection (best-effort, must not hang forever)', () => {
    expect(cacheRedis.options.maxRetriesPerRequest).toBe(3);
  });

  describe('RedisReadinessCheck', () => {
    it('reports healthy when both connections are reachable', async () => {
      const check = new RedisReadinessCheck(queueRedis, cacheRedis);
      await expect(check.check()).resolves.toEqual({ healthy: true });
    });

    it('reports which side failed when one connection is down', async () => {
      const deadCache = createUnreachableRedis();
      const check = new RedisReadinessCheck(queueRedis, deadCache);

      const result = await check.check();

      expect(result.healthy).toBe(false);
      expect(result.detail).toBeDefined();
      expect(result.detail).toContain('cache');
      expect(result.detail).not.toContain('queue:');
      deadCache.disconnect();
    });

    it('reports both sides when both connections are down', async () => {
      const deadQueue = createUnreachableRedis();
      const deadCache = createUnreachableRedis();
      const check = new RedisReadinessCheck(deadQueue, deadCache);

      const result = await check.check();

      expect(result.healthy).toBe(false);
      expect(result.detail).toContain('queue');
      expect(result.detail).toContain('cache');
      deadQueue.disconnect();
      deadCache.disconnect();
    });
  });

  describe('CacheService', () => {
    const cache = () => new CacheService(cacheRedis);
    const testKey = `agentb:test:cache:${Date.now()}:${Math.random()}`;

    afterAll(async () => {
      await cacheRedis.del(testKey);
    });

    it('returns null on a genuine miss', async () => {
      await expect(cache().get(`${testKey}:never-set`)).resolves.toBeNull();
    });

    it('round-trips a JSON value and respects TTL as a positive-path write', async () => {
      const svc = cache();
      await svc.set(testKey, { hello: 'world', n: 42 }, 30);
      await expect(svc.get(testKey)).resolves.toEqual({ hello: 'world', n: 42 });
      expect(await cacheRedis.ttl(testKey)).toBeGreaterThan(0);
    });

    it('del() removes the value', async () => {
      const svc = cache();
      await svc.set(testKey, { x: 1 });
      await svc.del(testKey);
      await expect(svc.get(testKey)).resolves.toBeNull();
    });

    it('get() NEVER throws and returns null when the connection is broken — the structural guarantee', async () => {
      const brokenRedis = createUnreachableRedis();
      const brokenCache = new CacheService(brokenRedis);
      await expect(brokenCache.get('anything')).resolves.toBeNull();
      brokenRedis.disconnect();
    });

    it('set() NEVER throws when the connection is broken — correctness cannot depend on a cache write', async () => {
      const brokenRedis = createUnreachableRedis();
      const brokenCache = new CacheService(brokenRedis);
      await expect(brokenCache.set('anything', { a: 1 })).resolves.toBeUndefined();
      brokenRedis.disconnect();
    });
  });

  describe('RedisLifecycleService graceful shutdown', () => {
    it('quits both connections cleanly, leaving them in the "end" state', async () => {
      const q = createQueueRedisConnection(config);
      const c = createCacheRedisConnection(config);
      expect(await q.ping()).toBe('PONG');
      expect(await c.ping()).toBe('PONG');

      const lifecycle = new RedisLifecycleService(q, c);
      await lifecycle.onModuleDestroy();

      expect(q.status).toBe('end');
      expect(c.status).toBe('end');
    });

    it('is idempotent — calling onModuleDestroy twice does not throw', async () => {
      const q = createQueueRedisConnection(config);
      const c = createCacheRedisConnection(config);
      const lifecycle = new RedisLifecycleService(q, c);

      await lifecycle.onModuleDestroy();
      await expect(lifecycle.onModuleDestroy()).resolves.toBeUndefined();
    });
  });
});
