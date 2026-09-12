import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { ChatMessageView } from '@tripwith/shared';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { AppDataSource } from '../../database/data-source';
import { CACHE_REDIS } from '../../redis/redis.tokens';
import { ConnectionTracker } from '../../realtime/connection-tracker.service';
import { RealtimeModule } from '../../realtime/realtime.module';
import { RedisIoAdapter } from '../../realtime/redis-io.adapter';
import { chatRoom } from '../../realtime/rooms';
import { SOCKET_AUTHENTICATOR, type SocketAuthenticator } from '../../realtime/socket-authenticator';
import { ChatService } from '../chat.service';
import { PresenceGateway } from '../presence/presence.gateway';
import { PresenceService } from '../presence/presence.service';
import { PresenceStore } from '../presence/presence.store';
import type { ChatAck } from './chat.events';
import { ChatGateway } from './chat.gateway';

const redisUrl = process.env.TEST_REDIS_CACHE_URL ?? process.env.REDIS_CACHE_URL ?? 'redis://localhost:6398';
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for chat transport');
    await pause(10);
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// Native WebSocket speaks Engine.IO v4 / Socket.IO v5, as in the realtime
// handshake suite. Record frames immediately so fast replies cannot be lost.
class WireClient {
  readonly ws: WebSocket;
  readonly frames: string[] = [];
  private nextAck = 1;

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
    this.ws.addEventListener('message', (event) => {
      const frame = String(event.data);
      this.frames.push(frame);
      if (frame === '2') this.ws.send('3');
    });
  }

  async frame(prefix: string): Promise<string> {
    await until(() => this.frames.some((frame) => frame.startsWith(prefix)));
    return this.frames.find((frame) => frame.startsWith(prefix))!;
  }

  async connect(token: string): Promise<void> {
    await this.frame('0');
    this.ws.send(`40${JSON.stringify({ token })}`);
    await this.frame('40');
  }

  async request<T = unknown>(event: string, input: unknown): Promise<ChatAck<T>> {
    const id = this.nextAck++;
    this.ws.send(`42${id}${JSON.stringify([event, input])}`);
    const prefix = `43${id}`;
    const frame = await this.frame(`${prefix}[`);
    const replies = JSON.parse(frame.slice(prefix.length)) as ChatAck<T>[];
    expect(replies).toHaveLength(1);
    return replies[0]!;
  }

  get messages(): ChatMessageView[] {
    return this.frames.filter((frame) => frame.startsWith('42['))
      .map((frame) => JSON.parse(frame.slice(2)) as [string, ChatMessageView])
      .filter(([event]) => event === 'chat:message').map(([, message]) => message);
  }
}

// Both instances use real N1/PostgreSQL and the production Redis adapter.
// Only token verification is substituted; no gateway handler is called directly.
describe('ChatGateway (real Nest frames, PostgreSQL and two-instance Redis)', () => {
  const apps: INestApplication[] = [];
  const clients: WireClient[] = [];
  const rooms: string[] = [];
  const users: string[] = [];
  const events: string[] = [];
  let a: string;
  let b: string;
  let outsider: string;
  let roomId: string;
  let otherRoom: string;
  let cache: Redis;

  beforeAll(async () => {
    await AppDataSource.initialize();
    cache = new Redis(redisUrl, { lazyConnect: true, connectTimeout: 1000, retryStrategy: () => null });
    cache.on('error', () => undefined);
    await cache.connect();
  });
  beforeEach(async () => {
    for (let i = 0; i < 3; i++) {
      const uid = `chat-wire-${randomUUID()}`;
      const [user] = await AppDataSource.query(
        `INSERT INTO users (firebase_uid, email, account_status, date_of_birth)
         VALUES ($1, $2, 'ACTIVE', DATE '1990-01-01') RETURNING id`, [uid, `${uid}@example.com`],
      );
      users.push(user.id);
    }
    [a, b, outsider] = users as [string, string, string];
    for (const peer of [b, outsider]) {
      // Test fixtures only; production MATCH provisioning stays in swipes.
      const [room] = await AppDataSource.query(`INSERT INTO chat_rooms (type) VALUES ('MATCH') RETURNING id`);
      rooms.push(room.id);
      await AppDataSource.query(
        `INSERT INTO matches (user_a_id, user_b_id, chat_room_id)
         VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid), $3)`, [a, peer, room.id],
      );
      await AppDataSource.query(`INSERT INTO chat_members (room_id, user_id) VALUES ($1, $2), ($1, $3)`, [room.id, a, peer]);
    }
    [roomId, otherRoom] = rooms as [string, string];
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const client of clients.splice(0)) client.ws.close();
    for (const app of apps.splice(0)) await app.close();
    if (!AppDataSource.isInitialized) return;
    await AppDataSource.transaction(async (manager) => {
      if (events.length) {
        // Existing EVENT fixture cleanup convention; trigger changes roll back on failure.
        await manager.query('ALTER TABLE event_status_history DISABLE TRIGGER event_status_history_append_only');
        await manager.query('DELETE FROM event_status_history WHERE event_id = ANY($1::uuid[])', [events]);
        await manager.query('DELETE FROM events WHERE id = ANY($1::uuid[])', [events]);
        await manager.query('ALTER TABLE event_status_history ENABLE TRIGGER event_status_history_append_only');
      }
      await manager.query(`DELETE FROM matches WHERE chat_room_id = ANY($1::uuid[])`, [rooms]);
      await manager.query(`DELETE FROM chat_rooms WHERE id = ANY($1::uuid[])`, [rooms]);
      await manager.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [users]);
    });
    if (cache?.status === 'ready' && users.length) await cache.del(...users.map((id) => `presence:v1:${id}`));
    rooms.length = users.length = events.length = 0;
  });
  afterAll(async () => {
    cache?.disconnect();
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  });

  async function instance(authenticate: SocketAuthenticator['authenticate'] = async (token) =>
    users.includes(token ?? '') ? { userId: token! } : null) {
    const chat = new ChatService(AppDataSource);
    const module = await Test.createTestingModule({
      imports: [RealtimeModule.forRoot({ authenticatorProvider: {
        provide: SOCKET_AUTHENTICATOR, useValue: { authenticate },
      } })],
      providers: [ChatGateway, PresenceGateway, PresenceService, PresenceStore,
        { provide: ChatService, useValue: chat },
        { provide: DataSource, useValue: AppDataSource },
        { provide: CACHE_REDIS, useValue: cache }],
    }).compile();
    const app = module.createNestApplication();
    apps.push(app);
    const adapter = new RedisIoAdapter(app);
    app.useWebSocketAdapter(adapter);
    await adapter.connectToRedis(redisUrl, 1500);
    await app.listen(0, '127.0.0.1');
    const port: number = app.getHttpServer().address().port;
    return { port, chat, gateway: app.get(ChatGateway), tracker: app.get(ConnectionTracker),
      presence: app.get(PresenceGateway), store: app.get(PresenceStore) };
  }

  async function client(port: number, userId: string) {
    const wire = new WireClient(port);
    clients.push(wire);
    await wire.connect(userId);
    return wire;
  }
  const sendInput = (key: string) => ({ roomId, message: { type: 'TEXT', clientMessageId: key, body: key } });
  const join = async (wire: WireClient, id = roomId) => {
    expect(await wire.request('chat:join', { roomId: id })).toMatchObject({ ok: true, data: { id } });
  };

  async function eventRoom() {
    const [event] = await AppDataSource.query(
      `INSERT INTO events (host_type, host_user_id, category_id, title, capacity_max, status,
         starts_at, ends_at, meeting_point)
       VALUES ('USER', $1, (SELECT id FROM event_categories WHERE is_active ORDER BY id LIMIT 1),
         'EVENT transport test', 4, 'ACTIVE', '2090-01-01T10:00:00Z', '2090-01-01T12:00:00Z',
         ST_SetSRID(ST_MakePoint(35.235, 31.778), 4326)::geography) RETURNING id`, [a],
    );
    events.push(event.id);
    // Fixture only: host has no participant row; the durable service owns policy.
    await AppDataSource.query('INSERT INTO event_participants (event_id, user_id) VALUES ($1, $2)', [event.id, b]);
    const [room] = await AppDataSource.query(
      "INSERT INTO chat_rooms (type, event_id) VALUES ('EVENT', $1) RETURNING id", [event.id],
    );
    rooms.push(room.id);
    roomId = room.id;
    await AppDataSource.query('INSERT INTO chat_members (room_id, user_id) VALUES ($1, $2), ($1, $3)', [roomId, a, b]);
    return event.id as string;
  }

  it('supports EVENT host/member fanout across active states and retained reads after completion', async () => {
    const eventId = await eventRoom();
    const first = await instance();
    const second = await instance();
    await until(async () => await first.gateway.server.sockets.adapter.serverCount() === 2);
    const host = await client(first.port, a);
    const participant = await client(second.port, b);
    const stranger = await client(second.port, outsider);
    await join(host);
    await join(participant);
    expect(await stranger.request('chat:join', { roomId }))
      .toMatchObject({ ok: false, error: { code: 'CHAT_ROOM_FORBIDDEN' } });
    let seq = 0;
    for (const status of ['ACTIVE', 'FULL', 'IN_PROGRESS']) {
      await AppDataSource.query('UPDATE events SET status = $2::event_status WHERE id = $1', [eventId, status]);
      for (const wire of [host, participant]) {
        expect(await wire.request('chat:send', sendInput(status))).toMatchObject({ ok: true, data: { seq: ++seq } });
      }
      await until(() => host.messages.length === seq && participant.messages.length === seq);
    }
    await AppDataSource.query("UPDATE events SET status = 'COMPLETED', completed_at = now() WHERE id = $1", [eventId]);
    for (const wire of [host, participant]) {
      await join(wire);
      expect(await wire.request('chat:catch-up', { roomId, afterSeq: 0 }))
        .toMatchObject({ ok: true, data: { highWaterSeq: seq, nextAfterSeq: seq } });
      for (const key of ['IN_PROGRESS', 'after-completion']) {
        expect(await wire.request('chat:send', sendInput(key)))
          .toMatchObject({ ok: false, error: { code: 'CHAT_ROOM_FORBIDDEN' } });
      }
    }
    expect(await first.chat.authorizeRoom(a, roomId)).toMatchObject({ lastSeq: seq });
    await pause(100);
    expect(host.messages).toHaveLength(seq);
    expect(participant.messages).toHaveLength(seq);
    expect(stranger.messages).toEqual([]);
  });

  it.each(['cancellation', 'participant', 'membership', 'account'])
  ('denies stale EVENT recipients after %s while using current durable policy', async (policy) => {
    const eventId = await eventRoom();
    const first = await instance();
    const second = await instance();
    await until(async () => await first.gateway.server.sockets.adapter.serverCount() === 2);
    const host = await client(first.port, a);
    const participant = await client(second.port, b);
    await join(participant);
    expect(await host.request('chat:send', sendInput('before'))).toMatchObject({ ok: true });
    await until(() => participant.messages.length === 1);
    const socket = [...second.gateway.server.sockets.sockets.values()][0]!;
    if (policy === 'cancellation') await AppDataSource.query(
      "UPDATE events SET status = 'CANCELLED', cancelled_at = now() WHERE id = $1", [eventId],
    );
    if (policy === 'participant') await AppDataSource.query(
      "UPDATE event_participants SET cancelled_at = now(), attendance_status = 'CANCELLED' WHERE event_id = $1 AND user_id = $2", [eventId, b],
    );
    if (policy === 'membership') await AppDataSource.query(
      'UPDATE chat_members SET left_at = now() WHERE room_id = $1 AND user_id = $2', [roomId, b],
    );
    if (policy === 'account') await AppDataSource.query("UPDATE users SET account_status = 'SUSPENDED' WHERE id = $1", [b]);
    expect(socket.rooms.has(chatRoom(roomId))).toBe(true);
    first.gateway.server.serverSideEmit('chat:committed', { roomId, seq: 1 });
    await until(() => !socket.rooms.has(chatRoom(roomId)));
    expect(await host.request('chat:send', sendInput('after'))).toMatchObject(policy === 'cancellation'
      ? { ok: false, error: { code: 'CHAT_ROOM_FORBIDDEN' } }
      : { ok: true, data: { seq: 2 } });
    for (const wire of policy === 'cancellation' ? [host, participant] : [participant]) {
      for (const [event, input] of [
        ['chat:join', { roomId }], ['chat:catch-up', { roomId, afterSeq: 0 }], ['chat:send', sendInput('denied')],
      ] as const) {
        expect(await wire.request(event, input)).toMatchObject({ ok: false, error: { code: 'CHAT_ROOM_FORBIDDEN' } });
      }
    }
    await pause(100);
    expect(participant.messages.map((message) => message.body)).toEqual(['before']);
  });

  it('binds real acks, rejects outsiders/spoofing and delivers locally and over Redis without cross-room leakage', async () => {
    const first = await instance();
    const second = await instance();
    await until(async () => await first.gateway.server.sockets.adapter.serverCount() === 2);
    const sender = await client(first.port, a);
    const remote = await client(second.port, b);
    const unrelated = await client(second.port, outsider);
    await join(sender);
    await join(remote);
    await join(unrelated, otherRoom);
    expect(await unrelated.request('chat:join', { roomId })).toMatchObject({ ok: false, error: { code: 'CHAT_ROOM_FORBIDDEN' } });
    expect(await unrelated.request('chat:send', sendInput('outsider'))).toMatchObject({ ok: false, error: { code: 'CHAT_ROOM_FORBIDDEN' } });
    expect(await unrelated.request('chat:catch-up', { roomId, afterSeq: 0 })).toMatchObject({ ok: false, error: { code: 'CHAT_ROOM_FORBIDDEN' } });
    const input = sendInput('first');
    expect(await sender.request('chat:send', { ...input, message: { ...input.message, senderUserId: b } }))
      .toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    const ack = await sender.request<ChatMessageView>('chat:send', input);
    expect(ack).toMatchObject({ ok: true, data: { roomId, seq: 1, senderUserId: a } });
    if (!ack.ok) throw new Error('Expected committed message');
    await until(() => sender.messages.length > 0 && remote.messages.length > 0);
    expect(sender.messages).toEqual([ack.data]);
    expect(remote.messages).toEqual([ack.data]);
    await pause(100);
    expect(unrelated.messages).toEqual([]);
    expect(await remote.request('chat:catch-up', { roomId, afterSeq: 0, limit: 1 }))
      .toMatchObject({ ok: true, data: { messages: [ack.data], highWaterSeq: 1, nextAfterSeq: 1, hasMore: false } });
  });

  it('recovers a deliberately discarded send ack after reconnect without allocating another position', async () => {
    const first = await instance();
    const sender = await client(first.port, a);
    const input = sendInput('lost-ack');
    // No acknowledgement ID: Nest still executes the send, but has no callback.
    sender.ws.send(`42${JSON.stringify(['chat:send', input])}`);
    await until(async () => (await first.chat.authorizeRoom(a, roomId)).lastSeq === 1);
    sender.ws.close();
    const reconnected = await client(first.port, a);
    const original = (await first.chat.history(a, roomId, { afterSeq: 0 })).messages[0]!;
    expect(await reconnected.request('chat:send', input)).toEqual({ ok: true, data: original });
    expect(await reconnected.request('chat:catch-up', { roomId, afterSeq: 0 }))
      .toMatchObject({ ok: true, data: { messages: [original], highWaterSeq: 1, nextAfterSeq: 1 } });
    expect(await first.chat.authorizeRoom(a, roomId)).toMatchObject({ lastSeq: 1 });
  });

  it('holds publication until commit and emits nothing when the actual INSERT is rolled back', async () => {
    const first = await instance();
    const sender = await client(first.port, a);
    await join(sender);
    let inserted = false;
    const release = deferred();
    const transaction = AppDataSource.transaction.bind(AppDataSource);
    // Fault injection surrounds the real N1 transaction, after its INSERT.
    jest.spyOn(AppDataSource, 'transaction').mockImplementationOnce(async (isolation, action) =>
      transaction(isolation, async (manager) => {
        await action(manager);
        inserted = true;
        await release.promise;
        throw new Error('forced rollback after INSERT');
      }));
    const published = jest.spyOn(first.gateway.server, 'serverSideEmit');
    const pending = sender.request('chat:send', sendInput('rollback'));
    try {
      await until(() => inserted);
      expect(await first.chat.authorizeRoom(a, roomId)).toMatchObject({ lastSeq: 0 });
      expect(sender.messages).toEqual([]);
      expect(sender.frames.some((frame) => frame.startsWith('432['))).toBe(false);
      expect(published).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    expect(await pending).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(published).not.toHaveBeenCalled();
    expect((await first.chat.history(a, roomId)).messages).toEqual([]);
    await pause(100);
    expect(sender.messages).toEqual([]);
    expect(await sender.request('chat:send', sendInput('rollback'))).toMatchObject({ ok: true, data: { seq: 1 } });
    await until(() => sender.messages.length === 1);
  });

  it.each([false, true])('gates delayed authentication (premature chat frame: %s)', async (premature) => {
    let authenticating = false;
    const release = deferred();
    const first = await instance(async () => {
      authenticating = true;
      await release.promise;
      return { userId: a };
    });
    const wire = new WireClient(first.port);
    clients.push(wire);
    const authorize = jest.spyOn(first.chat, 'authorizeRoom');
    await wire.frame('0');
    wire.ws.send(`40${JSON.stringify({ token: a })}`);
    try {
      await until(() => authenticating);
      if (premature) {
        wire.ws.send(`4299${JSON.stringify(['chat:join', { roomId }])}`);
        await until(() => wire.ws.readyState === WebSocket.CLOSED);
      }
      await pause(100);
      expect(wire.frames.some((frame) => frame.startsWith('40') || frame.startsWith('4399'))).toBe(false);
      expect(authorize).not.toHaveBeenCalled();
      expect(first.tracker.activeConnections).toBe(0);
      expect(await first.store.read(a)).toEqual({ status: 'unknown', lastSeen: null });
    } finally {
      release.resolve();
    }
    if (premature) {
      // Socket.IO closes a client sending EVENT before namespace CONNECT.
      await until(() => wire.ws.readyState === WebSocket.CLOSED);
      expect(wire.frames.some((frame) => frame.startsWith('40'))).toBe(false);
      await join(await client(first.port, a));
    } else {
      await wire.frame('40');
      await join(wire);
    }
    expect(first.tracker.activeConnections).toBe(1);
  });

  it.each(['membership', 'unmatch', 'account', 'block'])
  ('rechecks durable %s revocation on the remote socket owner before delivery', async (policy) => {
    const first = await instance();
    const second = await instance();
    await until(async () => await first.gateway.server.sockets.adapter.serverCount() === 2);
    const sender = await client(first.port, a);
    const remote = await client(second.port, b);
    await join(remote);
    const input = sendInput('before-revocation');
    expect(await sender.request('chat:send', input)).toMatchObject({ ok: true });
    await until(() => remote.messages.length === 1);
    remote.frames.length = 0;
    const socket = [...second.gateway.server.sockets.sockets.values()][0]!;
    if (policy === 'membership') await AppDataSource.query(`UPDATE chat_members SET left_at = now() WHERE room_id = $1 AND user_id = $2`, [roomId, b]);
    if (policy === 'unmatch') await AppDataSource.query(`UPDATE matches SET unmatched_at = now() WHERE chat_room_id = $1`, [roomId]);
    if (policy === 'account') await AppDataSource.query(`UPDATE users SET account_status = 'SUSPENDED' WHERE id = $1`, [b]);
    if (policy === 'block') await AppDataSource.query(`INSERT INTO user_blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [b, a]);
    expect(socket.rooms.has(chatRoom(roomId))).toBe(true);
    // Replay a committed reference via real Redis, simulating queued fanout.
    first.gateway.server.serverSideEmit('chat:committed', { roomId, seq: 1 });
    await until(() => !socket.rooms.has(chatRoom(roomId)));
    await pause(100);
    expect(remote.messages).toEqual([]);
    expect(await remote.request('chat:catch-up', { roomId, afterSeq: 0 }))
      .toMatchObject({ ok: false, error: { code: 'CHAT_ROOM_FORBIDDEN' } });
  });

  it('queries/subscribes across API instances, aggregates devices, rejects enumeration and forged presence frames', async () => {
    const first = await instance();
    const second = await instance();
    const watcher = await client(first.port, a);
    const phone = await client(first.port, b);
    const tablet = await client(second.port, b);
    const stranger = await client(second.port, outsider);
    const target = { roomId, targetUserId: b };
    const [before] = await AppDataSource.query(`SELECT updated_at FROM users WHERE id = $1`, [b]);
    await until(async () => (await first.store.read(b)).status === 'online');
    expect(await watcher.request('presence:subscribe', target)).toMatchObject({ ok: true, data: { ...target, status: 'online' } });
    for (const input of [{ ...target, userId: a }, { ...target, lastSeen: Date.now() }, { ...target, status: 'offline' }]) {
      expect(await stranger.request('presence:query', input)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    }
    for (const targetUserId of [b, randomUUID()]) {
      expect(await stranger.request('presence:query', { roomId, targetUserId }))
        .toMatchObject({ ok: false, error: { code: 'PRESENCE_FORBIDDEN' } });
    }
    // A legitimate room cannot be used to substitute an unrelated target.
    expect(await watcher.request('presence:query', { ...target, targetUserId: outsider }))
      .toMatchObject({ ok: false, error: { code: 'PRESENCE_FORBIDDEN' } });
    phone.ws.close();
    await until(() => first.tracker.activeConnections === 1);
    expect(await watcher.request('presence:query', target)).toMatchObject({ ok: true, data: { status: 'online' } });
    tablet.ws.close();
    await until(async () => (await first.store.read(b)).status === 'offline');
    await first.presence.refresh();
    await until(() => watcher.frames.some((frame) => frame.includes('presence:update') && frame.includes('offline')));
    await cache.del(`presence:v1:${b}`);
    expect(await watcher.request('presence:query', target)).toMatchObject({ ok: true, data: { status: 'unknown', lastSeen: null } });
    const [after] = await AppDataSource.query(`SELECT updated_at FROM users WHERE id = $1`, [b]);
    expect(after.updated_at).toEqual(before.updated_at);
  });

  it.each(['membership', 'target-membership', 'unmatch', 'account', 'target-account', 'block', 'reverse-block', 'restriction'])
  ('revokes presence subscriptions on fresh %s policy without disclosing updates', async (policy) => {
    const first = await instance();
    const second = await instance();
    const watcher = await client(first.port, a);
    await client(second.port, b);
    const target = { roomId, targetUserId: b };
    expect(await watcher.request('presence:subscribe', target)).toMatchObject({ ok: true });
    watcher.frames.length = 0;
    if (policy.endsWith('membership')) await AppDataSource.query(`UPDATE chat_members SET left_at = now() WHERE room_id = $1 AND user_id = $2`, [roomId, policy === 'membership' ? a : b]);
    if (policy === 'unmatch') await AppDataSource.query(`UPDATE matches SET unmatched_at = now() WHERE chat_room_id = $1`, [roomId]);
    if (policy.endsWith('account')) await AppDataSource.query(`UPDATE users SET account_status = 'SUSPENDED' WHERE id = $1`, [policy === 'account' ? a : b]);
    if (policy.endsWith('block')) await AppDataSource.query(`INSERT INTO user_blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, policy === 'block' ? [a, b] : [b, a]);
    if (policy === 'restriction') await AppDataSource.query(`INSERT INTO account_restrictions (user_id, type, reason) VALUES ($1, 'MESSAGING_SUSPENDED', 'presence test')`, [b]);
    await first.presence.refresh();
    await until(() => watcher.frames.some((frame) => frame.includes('presence:revoked')));
    expect(watcher.frames.some((frame) => frame.includes('presence:update'))).toBe(false);
    expect(await watcher.request('presence:query', target)).toMatchObject({ ok: false, error: { code: 'PRESENCE_FORBIDDEN' } });
  });
});
