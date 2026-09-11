import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { CACHE_REDIS } from '../../redis/redis.tokens';

export const PRESENCE_LEASE_MS = 60_000;
export const PRESENCE_RETENTION_MS = 86_400_000;
export interface PresenceState {
  status: 'online' | 'offline' | 'unknown';
  lastSeen: string | null;
}

// One disposable key: eviction cannot leave an offline marker behind while
// losing live leases. Negative sentinel score stores the last server observation;
// positive scores are per-session expiry times. Reads repair missed disconnects.
const leaseScript = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local key = KEYS[1]
redis.call('ZREMRANGEBYSCORE', key, 1, now)
if ARGV[1] == 'touch' then
  redis.call('ZADD', key, now + tonumber(ARGV[3]), ARGV[2], -now, 'seen')
  redis.call('PEXPIRE', key, ARGV[4])
elseif ARGV[1] == 'remove' then
  if redis.call('ZREM', key, ARGV[2]) == 1 then
    redis.call('ZADD', key, -now, 'seen')
    redis.call('PEXPIRE', key, ARGV[4])
  end
end
local seen = redis.call('ZSCORE', key, 'seen')
if not seen then return { 'unknown', '' } end
if redis.call('ZCARD', key) > 1 then return { 'online', tostring(-tonumber(seen)) } end
return { 'offline', tostring(-tonumber(seen)) }
`;

@Injectable()
export class PresenceStore {
  constructor(@Inject(CACHE_REDIS) private readonly redis: Redis) {}

  touch(userId: string, leaseId: string): Promise<PresenceState> {
    return this.execute(userId, 'touch', leaseId);
  }

  remove(userId: string, leaseId: string): Promise<PresenceState> {
    return this.execute(userId, 'remove', leaseId);
  }

  read(userId: string): Promise<PresenceState> {
    return this.execute(userId, 'read', '');
  }

  private async execute(userId: string, operation: string, leaseId: string): Promise<PresenceState> {
    const unknown: PresenceState = { status: 'unknown', lastSeen: null };
    if (this.redis.status !== 'ready') return unknown;
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        this.redis.eval(leaseScript, 1, `presence:v1:${userId}`, operation, leaseId,
          PRESENCE_LEASE_MS, PRESENCE_RETENTION_MS),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 1000); }),
      ]);
      if (!Array.isArray(result) || result.length !== 2) return unknown;
      const [status, seen] = result;
      if (status !== 'online' && status !== 'offline') return unknown;
      const timestamp = Number(seen);
      if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return unknown;
      return { status, lastSeen: new Date(timestamp).toISOString() };
    } catch {
      return unknown;
    } finally {
      clearTimeout(timer);
    }
  }
}
