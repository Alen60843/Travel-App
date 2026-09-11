import { randomUUID } from 'node:crypto';

import Redis from 'ioredis';

import { PRESENCE_LEASE_MS, PresenceStore } from './presence.store';

const redisUrl = process.env.TEST_REDIS_CACHE_URL ?? process.env.REDIS_CACHE_URL ?? 'redis://localhost:6398';

describe('presence leases (real CACHE Redis, independent API clients)', () => {
  let first: Redis;
  let second: Redis;
  let a: PresenceStore;
  let b: PresenceStore;
  const users: string[] = [];
  const user = () => { const id = randomUUID(); users.push(id); return id; };

  beforeAll(async () => {
    const options = { lazyConnect: true, enableOfflineQueue: false, connectTimeout: 1000, retryStrategy: () => null };
    first = new Redis(redisUrl, options);
    second = new Redis(redisUrl, options);
    first.on('error', () => undefined);
    second.on('error', () => undefined);
    await Promise.all([first.connect(), second.connect()]);
    a = new PresenceStore(first);
    b = new PresenceStore(second);
  });

  afterAll(async () => {
    if (second?.status === 'ready' && users.length) await second.del(...users.map((id) => `presence:v1:${id}`));
    first?.disconnect();
    second?.disconnect();
  });

  it('aggregates devices across instances with idempotent/reordered disconnects and server timestamps', async () => {
    const id = user();
    const leases = [randomUUID(), randomUUID(), randomUUID()] as const;
    expect(await a.read(id)).toEqual({ status: 'unknown', lastSeen: null });
    const [time] = await first.time();
    await Promise.all([a.touch(id, leases[0]), b.touch(id, leases[1])]);
    const state = await b.read(id);
    expect(state.status).toBe('online');
    expect(Date.parse(state.lastSeen!)).toBeGreaterThanOrEqual(Number(time) * 1000);
    await a.remove(id, leases[0]);
    expect((await b.read(id)).status).toBe('online');
    await a.touch(id, leases[2]); // Reconnect before delayed old disconnect.
    await Promise.all([a.remove(id, leases[0]), b.remove(id, leases[1]), a.remove(id, leases[0])]);
    expect((await b.read(id)).status).toBe('online');
    await a.remove(id, leases[2]);
    const offline = await b.read(id);
    expect(offline.status).toBe('offline');
    await b.remove(id, leases[1]);
    expect(await a.read(id)).toEqual(offline); // Duplicate does not forge lastSeen.
    expect(await second.pttl(`presence:v1:${id}`)).toBeGreaterThan(PRESENCE_LEASE_MS);
  });

  it('repairs process death through actual TTL deadlines without a disconnect callback', async () => {
    const id = user();
    const lease = randomUUID();
    const seen = await a.touch(id, lease);
    // This client stops writing entirely, as if its API process died.
    await new Promise((resolve) => setTimeout(resolve, PRESENCE_LEASE_MS + 50));
    expect(await b.read(id)).toEqual({ status: 'offline', lastSeen: seen.lastSeen });
    expect(await second.zcard(`presence:v1:${id}`)).toBe(1); // Only disposable lastSeen remains.
  }, PRESENCE_LEASE_MS + 10_000);

  it('heartbeats extend only the owning session and expired sibling leases cannot mark it offline', async () => {
    const id = user();
    const live = randomUUID();
    const dead = randomUUID();
    await a.touch(id, live);
    await b.touch(id, dead);
    // Put one lease on its expired boundary using Redis's own time; normal
    // production TTL passage is independently exercised by the death test.
    const [seconds, micros] = await second.time();
    await second.zadd(`presence:v1:${id}`, Number(seconds) * 1000 + Math.floor(Number(micros) / 1000), dead);
    await a.touch(id, live);
    expect((await b.remove(id, dead)).status).toBe('online');
    expect(await second.zscore(`presence:v1:${id}`, dead)).toBeNull();
  });

  it('returns unknown after key loss, restores through a live heartbeat and never treats outage as offline', async () => {
    const id = user();
    const lease = randomUUID();
    await a.touch(id, lease);
    await second.del(`presence:v1:${id}`); // Loss/eviction of this whole disposable record.
    expect(await b.read(id)).toEqual({ status: 'unknown', lastSeen: null });
    expect(await b.remove(id, lease)).toEqual({ status: 'unknown', lastSeen: null });
    expect((await a.touch(id, lease)).status).toBe('online');
    await second.set(`presence:v1:${id}`, 'corrupted-cache-value');
    expect(await b.read(id)).toEqual({ status: 'unknown', lastSeen: null });
    first.disconnect();
    expect(await a.read(id)).toEqual({ status: 'unknown', lastSeen: null });
  });
});
