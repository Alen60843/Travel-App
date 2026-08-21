import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { CacheService } from '../redis/cache.service';

const GENERATION_PREFIX = 'feed:gen:';

/**
 * Owns the O(1) generation invalidation used by ranked-feed cache keys.
 * Redis is deliberately best-effort: failure disables the affected cache
 * operation and never rolls back a PostgreSQL domain mutation.
 */
@Injectable()
export class FeedGenerationService {
  constructor(private readonly cache: CacheService) {}

  async current(viewerId: string): Promise<number> {
    const generation = await this.cache.get<number>(this.generationKey(viewerId));
    return Number.isSafeInteger(generation) && (generation as number) >= 0
      ? (generation as number)
      : 0;
  }

  async bump(viewerId: string): Promise<number | null> {
    return this.cache.increment(this.generationKey(viewerId));
  }

  rankingKey(
    viewerId: string,
    generation: number,
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
}
