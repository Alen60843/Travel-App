import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { CacheService } from '../redis/cache.service';

const GENERATION_PREFIX = 'feed:gen:';
const GENERATION_TOKEN = /^[a-f0-9]{32}$/;

/**
 * Owns the O(1) generation invalidation used by ranked-feed cache keys.
 * Redis is deliberately best-effort: failure disables the affected cache
 * operation and never rolls back a PostgreSQL domain mutation.
 */
@Injectable()
export class FeedGenerationService {
  constructor(private readonly cache: CacheService) {}

  async current(viewerId: string): Promise<string> {
    const key = this.generationKey(viewerId);
    const existing = await this.cache.get<unknown>(key);
    if (this.isToken(existing)) return existing;

    const candidate = this.newToken();
    if (existing !== null) {
      // Replace legacy/corrupt metadata with a namespace that cannot alias it.
      await this.cache.replace(key, candidate);
      return candidate;
    }

    const claimed = await this.cache.setIfAbsent(key, candidate);
    if (claimed === true || claimed === null) return candidate;

    const winner = await this.cache.get<unknown>(key);
    if (this.isToken(winner)) return winner;

    // Metadata was lost/corrupted between the atomic claim and read. A fresh
    // random fallback may create duplicate work, but cannot revive an old key.
    const replacement = this.newToken();
    await this.cache.replace(key, replacement);
    return replacement;
  }

  async bump(viewerId: string): Promise<string | null> {
    const generation = this.newToken();
    return (await this.cache.replace(this.generationKey(viewerId), generation))
      ? generation
      : null;
  }

  rankingKey(
    viewerId: string,
    generation: string,
    filterHash: string,
    batchKey = 'root',
  ): string {
    const root = `feed:v${generation}:${viewerId}:${filterHash}`;
    return batchKey === 'root' ? root : `${root}:${batchKey}`;
  }

  filterHash(filters: Readonly<Record<string, unknown>>): string {
    const canonical = Object.entries(filters)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, value]);
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 24);
  }

  private generationKey(viewerId: string): string {
    return `${GENERATION_PREFIX}${viewerId}`;
  }

  private isToken(value: unknown): value is string {
    return typeof value === 'string' && GENERATION_TOKEN.test(value);
  }

  private newToken(): string {
    return randomBytes(16).toString('hex');
  }
}
