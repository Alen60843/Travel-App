import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';

import { AppError } from '../../common/errors/app-error';
import type { ChatService } from '../chat.service';
import type { PresenceSocket } from './presence.events';
import { PresenceGateway } from './presence.gateway';
import { PresenceService } from './presence.service';
import { PresenceStore } from './presence.store';

const userId = randomUUID();
const target = { roomId: randomUUID(), targetUserId: randomUUID() };
const online = { status: 'online' as const, lastSeen: '2026-09-11T00:00:00.000Z' };
const unknown = { status: 'unknown', lastSeen: null };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { resolve, promise };
}

describe('presence visibility boundary', () => {
  function fixture() {
    const chat = { authorizeRoom: jest.fn().mockResolvedValue({ type: 'MATCH' }) };
    const database = { query: jest.fn().mockResolvedValue([]) };
    const store = { read: jest.fn().mockResolvedValue(online) };
    const service = new PresenceService(chat as unknown as ChatService, database as unknown as DataSource,
      store as unknown as PresenceStore);
    return { chat, database, store, service };
  }

  it('authorizes both participants before Redis and again immediately before disclosure', async () => {
    const { service, chat, database } = fixture();
    expect(await service.query(userId, target)).toEqual({ ...target, ...online });
    expect(chat.authorizeRoom.mock.calls).toEqual([
      [userId, target.roomId], [target.targetUserId, target.roomId],
      [userId, target.roomId], [target.targetUserId, target.roomId],
    ]);
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining('user_blocks'), [userId, target.targetUserId]);
  });

  it.each(['caller', 'target', 'block', 'event', 'self'])('denies %s without probing Redis', async (policy) => {
    const { service, chat, database, store } = fixture();
    if (policy === 'caller') chat.authorizeRoom.mockRejectedValueOnce(new Error('denied'));
    if (policy === 'target') chat.authorizeRoom.mockResolvedValueOnce({ type: 'MATCH' }).mockRejectedValueOnce(new Error('denied'));
    if (policy === 'block') database.query.mockResolvedValue([{}]);
    if (policy === 'event') chat.authorizeRoom.mockResolvedValue({ type: 'EVENT' });
    await expect(service.query(policy === 'self' ? target.targetUserId : userId, target))
      .rejects.toMatchObject({ code: 'PRESENCE_FORBIDDEN' });
    expect(store.read).not.toHaveBeenCalled();
  });

  it.each([null, {}, { ...target, userId }, { ...target, leaseId: 'forged' },
    { ...target, status: 'online' }, { ...target, lastSeen: Date.now() },
    { ...target, targetUserId: ['forged'] }, { ...target, roomId: 'forged' }])
  ('rejects forged/server-owned fields: %j', async (input) => {
    const { service, chat, store } = fixture();
    await expect(service.query(userId, input)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(chat.authorizeRoom).not.toHaveBeenCalled();
    expect(store.read).not.toHaveBeenCalled();
  });

  it('rejects revocation during a Redis read rather than disclosing the loaded status', async () => {
    const { service, chat, store } = fixture();
    const pending = deferred<typeof online>();
    store.read.mockReturnValue(pending.promise);
    const result = service.query(userId, target);
    await tick();
    chat.authorizeRoom.mockRejectedValue(new Error('revoked'));
    pending.resolve(online);
    await expect(result).rejects.toMatchObject({ code: 'PRESENCE_FORBIDDEN' });
  });
});

describe('presence Redis degradation', () => {
  it.each([['unknown', ''], null, ['offline', 'bad'], ['online', '0']].map((result) => ({ result })))
  ('treats missing/malformed state as unknown: %j', async ({ result }) => {
    const store = new PresenceStore({ status: 'ready', eval: jest.fn().mockResolvedValue(result) } as unknown as Redis);
    expect(await store.read(userId)).toEqual(unknown);
  });

  it('returns unknown for failure/disconnection without leaking errors', async () => {
    const redis = { status: 'ready', eval: jest.fn().mockRejectedValue(new Error('private Redis failure')) };
    const store = new PresenceStore(redis as unknown as Redis);
    expect(await store.read(userId)).toEqual(unknown);
    redis.status = 'reconnecting';
    expect(await store.touch(userId, randomUUID())).toEqual(unknown);
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it('bounds a blackholed Redis request', async () => {
    jest.useFakeTimers();
    try {
      const store = new PresenceStore({ status: 'ready', eval: () => new Promise(() => {}) } as unknown as Redis);
      const pending = store.read(userId);
      await jest.advanceTimersByTimeAsync(1000);
      expect(await pending).toEqual(unknown);
    } finally { jest.useRealTimers(); }
  });
});

describe('presence socket lifecycle', () => {
  function fixture() {
    const presence = { query: jest.fn().mockResolvedValue({ ...target, ...online }) };
    const store = { touch: jest.fn().mockResolvedValue(online), remove: jest.fn().mockResolvedValue(unknown) };
    const gateway = new PresenceGateway(presence as unknown as PresenceService, store as unknown as PresenceStore);
    const socket = { connected: true, data: { userId }, conn: new EventEmitter(), emit: jest.fn() };
    const client = socket as unknown as PresenceSocket;
    gateway.handleConnection(client);
    return { presence, store, gateway, socket, client };
  }

  it('uses authenticated identity and unique leases across devices, including duplicate/reordered disconnects', async () => {
    const { gateway, store, socket, client } = fixture();
    const other = { ...socket, conn: new EventEmitter() } as unknown as PresenceSocket;
    gateway.handleConnection(other);
    gateway.handleConnection(client);
    await tick();
    expect(store.touch).toHaveBeenCalledTimes(2);
    const firstLease = store.touch.mock.calls[0]![1];
    const secondLease = store.touch.mock.calls[1]![1];
    expect(firstLease).not.toBe(secondLease);
    gateway.handleDisconnect(client);
    gateway.handleDisconnect(client);
    await tick();
    expect(store.remove.mock.calls).toEqual([[userId, firstLease]]);
    other.conn.emit('heartbeat');
    await tick();
    expect(store.touch).toHaveBeenLastCalledWith(userId, secondLease);
    gateway.onModuleDestroy();
  });

  it('removes after an in-flight heartbeat and never renews a closed socket', async () => {
    const { gateway, store, socket, client } = fixture();
    await tick();
    const heartbeat = deferred<typeof online>();
    store.touch.mockReturnValueOnce(heartbeat.promise);
    socket.conn.emit('heartbeat');
    gateway.handleDisconnect(client);
    socket.conn.emit('heartbeat');
    expect(store.remove).not.toHaveBeenCalled();
    heartbeat.resolve(online);
    await tick();
    expect(store.touch).toHaveBeenCalledTimes(2);
    expect(store.remove).toHaveBeenCalledTimes(1);
  });

  it('subscribes with the authenticated caller and revokes before emitting changed status', async () => {
    const { gateway, presence, client, socket } = fixture();
    expect(await gateway.subscribe(client, target)).toEqual({ ok: true, data: { ...target, ...online } });
    expect(presence.query).toHaveBeenCalledWith(userId, target);
    presence.query.mockRejectedValue(new AppError('PRESENCE_FORBIDDEN', 'private'));
    await gateway.refresh();
    expect(socket.emit.mock.calls).toEqual([['presence:revoked', target]]);
    presence.query.mockResolvedValue({ ...target, ...online });
    await gateway.refresh();
    expect(socket.emit).toHaveBeenCalledTimes(1);
    gateway.onModuleDestroy();
  });

  it('does not emit a refresh finishing after unsubscribe or disconnect', async () => {
    const { gateway, presence, client, socket } = fixture();
    await gateway.subscribe(client, target);
    const pending = deferred<unknown>();
    presence.query.mockReturnValueOnce(pending.promise);
    const refresh = gateway.refresh();
    await gateway.unsubscribe(client, target);
    pending.resolve({ ...target, ...unknown });
    await refresh;
    expect(socket.emit).not.toHaveBeenCalled();
    gateway.handleDisconnect(client);
    expect(await gateway.query(client, target)).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
  });

  it('caps subscriptions even while authorization requests are still pending', async () => {
    const { gateway, presence, client } = fixture();
    const pending = deferred<unknown>();
    presence.query.mockReturnValue(pending.promise);
    const subscriptions = Array.from({ length: 100 }, () => gateway.subscribe(client, { ...target, targetUserId: randomUUID() }));
    expect(await gateway.subscribe(client, target)).toMatchObject({ ok: false, error: { code: 'PRESENCE_LIMIT' } });
    pending.resolve({ ...target, ...online });
    await Promise.all(subscriptions);
    gateway.onModuleDestroy();
  });
});
