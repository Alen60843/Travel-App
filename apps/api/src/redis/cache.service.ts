import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { CACHE_REDIS } from './redis.tokens';

/**
 * Thin JSON cache over the cache Redis connection.
 *
 * The load-bearing property of this class is structural, not documentary:
 * `get` returns `null` on a genuine miss AND on any error (bad connection,
 * timeout, corrupted value) — the two are indistinguishable to the caller by
 * design. §6.2/§6.8 of the Phase 1 design are explicit that "a cache miss is
 * harmless" and that authorization must never be cached; the corollary this
 * class enforces is that NOTHING may treat a cache failure as anything other
 * than a miss. There is deliberately no code path in `get`/`set`/`del` that
 * throws — every failure is caught, logged at `warn` (this is infrastructure
 * degradation, not an application error), and swallowed. Application
 * correctness must never depend on a cache hit; making `get` incapable of
 * throwing is what makes that a guarantee instead of a convention callers
 * have to remember.
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  constructor(@Inject(CACHE_REDIS) private readonly redis: Redis) {}

  /** Returns the parsed value, or `null` on miss OR on any failure. Never throws. */
  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(key);
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    } catch (err) {
      this.logger.warn(`cache get failed, treating as miss: key=${key} error=${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Writes a JSON-encoded value with an optional TTL. Failures are logged and
   * swallowed — a write that never reaches Redis just means the next read is
   * a miss, which is always a safe outcome for cached data (§6.8: rankings
   * and lookups only, never authorization state).
   */
  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    await this.replace(key, value, ttlSeconds);
  }

  /** Best-effort write whose boolean result is useful for cache metadata. */
  async replace<T>(key: string, value: T, ttlSeconds?: number): Promise<boolean> {
    try {
      const raw = JSON.stringify(value);
      if (ttlSeconds !== undefined && ttlSeconds > 0) {
        await this.redis.set(key, raw, 'EX', ttlSeconds);
      } else {
        await this.redis.set(key, raw);
      }
      return true;
    } catch (err) {
      this.logger.warn(`cache set failed, ignoring: key=${key} error=${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Atomically claims an absent metadata key. `false` means another caller
   * already owns it; `null` means Redis was unavailable.
   */
  async setIfAbsent<T>(key: string, value: T): Promise<boolean | null> {
    try {
      return (await this.redis.set(key, JSON.stringify(value), 'NX')) === 'OK';
    } catch (err) {
      this.logger.warn(
        `cache set-if-absent failed, ignoring: key=${key} error=${(err as Error).message}`,
      );
      return null;
    }
  }

  /** Best-effort delete. Failures are logged and swallowed for the same reason as `set`. */
  async del(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (err) {
      this.logger.warn(`cache del failed, ignoring: key=${key} error=${(err as Error).message}`);
    }
  }

}
