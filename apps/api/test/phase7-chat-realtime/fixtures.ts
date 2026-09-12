import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConsentType, SwipeDirection, type ChatMessageView } from '@tripwith/shared';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { ChatService } from '../../src/chat/chat.service';
import { PresenceGateway } from '../../src/chat/presence/presence.gateway';
import { PresenceService } from '../../src/chat/presence/presence.service';
import { PresenceStore } from '../../src/chat/presence/presence.store';
import type { ChatAck } from '../../src/chat/transport/chat.events';
import { ChatGateway } from '../../src/chat/transport/chat.gateway';
import { loadConfig } from '../../src/config/configuration';
import { ConsentPolicyService } from '../../src/consent/consent-policy.service';
import { AppDataSource } from '../../src/database/data-source';
import { GeoService } from '../../src/database/geo';
import { EventChatService } from '../../src/events/event-chat.service';
import { EventsRepository } from '../../src/events/events.repository';
import { EventsService } from '../../src/events/events.service';
import { JoinRequestsService } from '../../src/events/join-requests.service';
import { CandidateRepository } from '../../src/matching/candidates';
import { RealtimeModule } from '../../src/realtime/realtime.module';
import { RedisIoAdapter } from '../../src/realtime/redis-io.adapter';
import { SOCKET_AUTHENTICATOR } from '../../src/realtime/socket-authenticator';
import { CACHE_REDIS } from '../../src/redis/redis.tokens';
import { SwipesRepository } from '../../src/swipes/swipes.repository';
import { SwipesService } from '../../src/swipes/swipes.service';

export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for composed chat');
    await pause(10);
  }
}

// Same native Engine.IO v4 / Socket.IO v5 framing as the existing wire suite.
// This helper encodes frames only; all handlers execute through Nest.
export class WireClient {
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
    const replies = JSON.parse((await this.frame(`${prefix}[`)).slice(prefix.length)) as ChatAck<T>[];
    expect(replies).toHaveLength(1);
    return replies[0]!;
  }

  get messages(): ChatMessageView[] {
    return this.frames.filter((frame) => frame.startsWith('42['))
      .map((frame) => JSON.parse(frame.slice(2)) as [string, ChatMessageView])
      .filter(([event]) => event === 'chat:message').map(([, message]) => message);
  }
}

export class ComposedFixture {
  readonly users: string[] = [];
  readonly rooms: string[] = [];
  readonly eventIds: string[] = [];
  readonly apps: INestApplication[] = [];
  readonly clients: WireClient[] = [];
  readonly caches: Redis[] = [];
  readonly chat = new ChatService(AppDataSource);
  readonly repository = new EventsRepository(AppDataSource);
  readonly events = new EventsService(this.repository, new GeoService());
  readonly requests = new JoinRequestsService(this.repository);
  readonly resolver = new EventChatService(this.repository);
  readonly config = loadConfig();
  readonly consent = new ConsentPolicyService(this.config);
  readonly swipes = new SwipesService(new SwipesRepository(
    AppDataSource, this.consent, new CandidateRepository(AppDataSource), this.config,
  ));

  async user(): Promise<string> {
    const uid = `phase7-composed-${randomUUID()}`;
    const [row] = await AppDataSource.query(
      `INSERT INTO users (firebase_uid, email, email_verified_at, account_status, date_of_birth)
       VALUES ($1, $2, now(), 'ACTIVE', DATE '1990-01-01') RETURNING id`, [uid, `${uid}@example.test`],
    );
    const id: string = row.id;
    this.users.push(id);
    await AppDataSource.query('INSERT INTO user_profiles (user_id, display_name) VALUES ($1, $2)', [id, 'Composed traveller']);
    await AppDataSource.query('INSERT INTO user_settings (user_id) VALUES ($1)', [id]);
    for (const type of [ConsentType.TermsOfService, ConsentType.PrivacyPolicy] as const) {
      await AppDataSource.query(
        'INSERT INTO user_consents (user_id, consent_type, granted, policy_version) VALUES ($1, $2, TRUE, $3)',
        [id, type, this.consent.currentVersion(type)],
      );
    }
    const [trip] = await AppDataSource.query(
      `INSERT INTO trips (user_id, title, start_date, end_date, visibility)
       VALUES ($1, 'Composed anchor', DATE '2090-09-01', DATE '2090-09-07', 'PRIVATE') RETURNING id`, [id],
    );
    await AppDataSource.query(
      `INSERT INTO trip_segments (trip_id, user_id, destination_place_id, destination_name,
         location, start_date, end_date, sort_order)
       VALUES ($1, $2, 'phase7-anchor', 'Tokyo', ST_SetSRID(ST_MakePoint(139.6917, 35.6895), 4326)::geography,
         DATE '2090-09-01', DATE '2090-09-07', 0)`, [trip.id, id],
    );
    return id;
  }

  async match(a: string, b: string): Promise<string> {
    const first = await this.swipes.create(a, { targetUserId: b, direction: SwipeDirection.Like });
    expect(first.match).toBeNull();
    const second = await this.swipes.create(b, { targetUserId: a, direction: SwipeDirection.Like });
    expect(second.match).not.toBeNull();
    const roomId = second.match!.chatRoomId;
    this.rooms.push(roomId);
    return roomId;
  }

  async event(host: string, participant: string, manual: boolean) {
    const [category] = await AppDataSource.query('SELECT id FROM event_categories WHERE is_active ORDER BY id LIMIT 1');
    const draft = await this.events.createEvent(host, {
      categoryId: category.id, title: 'Composed chat event', capacityMax: 2,
      startsAt: '2090-01-01T10:00:00Z', endsAt: '2090-01-01T12:00:00Z',
      latitude: 31.778, longitude: 35.235, joinApprovalRequired: manual,
    });
    this.eventIds.push(draft.id);
    await this.events.publishEvent(host, draft.id);
    const request = await this.requests.create(participant, draft.id, {});
    expect(request.status).toBe(manual ? 'PENDING' : 'APPROVED');
    if (manual) await this.requests.approve(host, draft.id, request.id);
    // Observe approval's provisioning BEFORE calling the repair/resolver path.
    const rows = await AppDataSource.query("SELECT id FROM chat_rooms WHERE type = 'EVENT' AND event_id = $1", [draft.id]);
    expect(rows).toHaveLength(1);
    return { eventId: draft.id, roomId: rows[0].id as string };
  }

  async instance() {
    const redisUrl = process.env.TEST_REDIS_CACHE_URL ?? process.env.REDIS_CACHE_URL ?? 'redis://localhost:6398';
    const cache = new Redis(redisUrl, {
      lazyConnect: true, enableOfflineQueue: false, connectTimeout: 1000, retryStrategy: () => null,
    });
    this.caches.push(cache);
    cache.on('error', () => undefined);
    await cache.connect();
    const module = await Test.createTestingModule({
      imports: [RealtimeModule.forRoot({ authenticatorProvider: {
        provide: SOCKET_AUTHENTICATOR,
        useValue: { authenticate: async (token: string) => this.users.includes(token) ? { userId: token } : null },
      } })],
      providers: [ChatGateway, ChatService, PresenceGateway, PresenceService, PresenceStore,
        { provide: DataSource, useValue: AppDataSource }, { provide: CACHE_REDIS, useValue: cache }],
    }).compile();
    const app = module.createNestApplication();
    this.apps.push(app);
    const adapter = new RedisIoAdapter(app);
    app.useWebSocketAdapter(adapter);
    await adapter.connectToRedis(redisUrl, 1500);
    await app.listen(0, '127.0.0.1');
    return { port: app.getHttpServer().address().port as number, gateway: app.get(ChatGateway) };
  }

  async client(port: number, userId: string) {
    const wire = new WireClient(port);
    this.clients.push(wire);
    await wire.connect(userId);
    return wire;
  }

  async cleanup(): Promise<void> {
    for (const wire of this.clients) wire.ws.close();
    try {
      for (const app of this.apps) await app.close();
      const cache = this.caches.find((client) => client.status === 'ready');
      if (cache && this.users.length) await cache.del(...this.users.map((id) => `presence:v1:${id}`));
      if (!AppDataSource.isInitialized) return;
      await AppDataSource.transaction(async (manager) => {
        // Existing integration cleanup convention; trigger changes are transactional.
        await manager.query('ALTER TABLE event_status_history DISABLE TRIGGER event_status_history_append_only');
        await manager.query('ALTER TABLE user_consents DISABLE TRIGGER user_consents_append_only');
        await manager.query('DELETE FROM event_status_history WHERE event_id = ANY($1::uuid[])', [this.eventIds]);
        await manager.query('DELETE FROM events WHERE id = ANY($1::uuid[])', [this.eventIds]);
        await manager.query('DELETE FROM matches WHERE chat_room_id = ANY($1::uuid[])', [this.rooms]);
        await manager.query('DELETE FROM chat_rooms WHERE id = ANY($1::uuid[])', [this.rooms]);
        await manager.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [this.users]);
        await manager.query('ALTER TABLE user_consents ENABLE TRIGGER user_consents_append_only');
        await manager.query('ALTER TABLE event_status_history ENABLE TRIGGER event_status_history_append_only');
      });
    } finally {
      for (const cache of this.caches) cache.disconnect();
    }
  }
}
