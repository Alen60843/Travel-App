import { randomUUID } from 'node:crypto';

import type { DataSource, EntityManager } from 'typeorm';

import { AppDataSource } from '../database/data-source';
import { EventChatService } from '../events/event-chat.service';
import { EventsRepository } from '../events/events.repository';
import { ChatService } from './chat.service';

const users: string[] = [];
const events: string[] = [];
const text = (key: string) => ({ type: 'TEXT', clientMessageId: key, body: key });
const forbidden = { code: 'CHAT_ROOM_FORBIDDEN', status: 403 };

describe('EVENT direct chat authorization (real PostgreSQL)', () => {
  let chat: ChatService;

  beforeAll(async () => {
    await AppDataSource.initialize();
    chat = new ChatService(AppDataSource);
  });

  afterAll(async () => {
    if (!AppDataSource.isInitialized) return;
    try {
      await AppDataSource.transaction(async (manager) => {
        // Fixture cleanup follows the existing EVENT integration suite.
        await manager.query('ALTER TABLE event_status_history DISABLE TRIGGER event_status_history_append_only');
        await manager.query('DELETE FROM event_status_history WHERE event_id = ANY($1::uuid[])', [events]);
        await manager.query('DELETE FROM events WHERE id = ANY($1::uuid[])', [events]);
        await manager.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
        await manager.query('ALTER TABLE event_status_history ENABLE TRIGGER event_status_history_append_only');
      });
    } finally {
      await AppDataSource.destroy();
    }
  });

  async function fixture(status = 'ACTIVE') {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const uid = `event-chat-${randomUUID()}`;
      const [user] = await AppDataSource.query(
        `INSERT INTO users (firebase_uid, email, account_status, date_of_birth)
         VALUES ($1, $2, 'ACTIVE', DATE '1990-01-01') RETURNING id`, [uid, `${uid}@example.test`],
      );
      ids.push(user.id);
      users.push(user.id);
    }
    const [host, participant, outsider] = ids as [string, string, string];
    const [event] = await AppDataSource.query(
      `INSERT INTO events (host_type, host_user_id, category_id, title, capacity_max, status,
         starts_at, ends_at, meeting_point)
       VALUES ('USER', $1, (SELECT id FROM event_categories WHERE is_active ORDER BY id LIMIT 1),
         'Direct EVENT chat', 4, $2, '2090-01-01T10:00:00Z', '2090-01-01T12:00:00Z',
         ST_SetSRID(ST_MakePoint(35.235, 31.778), 4326)::geography) RETURNING id`, [host, status],
    );
    events.push(event.id);
    await AppDataSource.query('INSERT INTO event_participants (event_id, user_id) VALUES ($1, $2)', [event.id, participant]);
    if (status === 'DRAFT') {
      // Simulate a stray pre-existing room that the resolver would never create.
      const [room] = await AppDataSource.query("INSERT INTO chat_rooms (type, event_id) VALUES ('EVENT', $1) RETURNING id", [event.id]);
      await AppDataSource.query('INSERT INTO chat_members (room_id, user_id) VALUES ($1, $2), ($1, $3)', [room.id, host, participant]);
      return { host, participant, outsider, eventId: event.id as string, roomId: room.id as string };
    }
    const resolver = new EventChatService(new EventsRepository(AppDataSource));
    const { roomId } = await resolver.resolveRoom(host, event.id);
    return { host, participant, outsider, eventId: event.id as string, roomId };
  }

  async function denied(userId: string, roomId: string) {
    await expect(chat.authorizeRoom(userId, roomId)).rejects.toMatchObject(forbidden);
    await expect(chat.history(userId, roomId, { afterSeq: 0 })).rejects.toMatchObject(forbidden);
    await expect(chat.sendMessage(userId, roomId, text('before'))).rejects.toMatchObject(forbidden);
    await expect(chat.advanceReadCursor(userId, roomId, { lastReadSeq: 1 })).rejects.toMatchObject(forbidden);
    expect((await chat.listRooms(userId)).rooms.map((room) => room.id)).not.toContain(roomId);
  }

  it.each(['ACTIVE', 'FULL', 'IN_PROGRESS', 'COMPLETED'])
  ('enforces %s reads, cursors, listing, sends and retries for host and participant', async (status) => {
    const { host, participant, roomId, eventId } = await fixture();
    for (const caller of [host, participant]) await chat.sendMessage(caller, roomId, text('before'));
    if (status === 'COMPLETED') await AppDataSource.query("UPDATE events SET status = 'IN_PROGRESS' WHERE id = $1", [eventId]);
    await AppDataSource.query(
      `UPDATE events
       SET status = $2::event_status,
           completed_at = CASE WHEN $2::event_status = 'COMPLETED'::event_status THEN now() END
       WHERE id = $1`,
      [eventId, status],
    );
    for (const caller of [host, participant]) {
      await expect(chat.authorizeRoom(caller, roomId)).resolves.toMatchObject({ lastSeq: 2 });
      await expect(chat.history(caller, roomId, { afterSeq: 0 })).resolves.toMatchObject({ highWaterSeq: 2 });
      await expect(chat.advanceReadCursor(caller, roomId, { lastReadSeq: 100 }))
        .resolves.toMatchObject({ lastReadSeq: 2, unreadCount: 0 });
      expect((await chat.listRooms(caller)).rooms.map((room) => room.id)).toContain(roomId);
      if (status === 'COMPLETED') {
        await expect(chat.sendMessage(caller, roomId, text('before'))).rejects.toMatchObject(forbidden);
        await expect(chat.sendMessage(caller, roomId, text('new'))).rejects.toMatchObject(forbidden);
      } else {
        await expect(chat.sendMessage(caller, roomId, text('before'))).resolves.toMatchObject({ senderUserId: caller });
      }
    }
    await expect(chat.authorizeRoom(host, roomId)).resolves.toMatchObject({ lastSeq: 2 });
    if (status !== 'COMPLETED') await expect(chat.sendMessage(host, roomId, text('new'))).resolves.toMatchObject({ seq: 3 });
  });

  it.each(['DRAFT', 'CANCELLED'])('denies every operation on an existing %s room', async (status) => {
    const { host, participant, roomId, eventId } = await fixture(status === 'DRAFT' ? 'DRAFT' : 'ACTIVE');
    if (status === 'CANCELLED') {
      await chat.sendMessage(host, roomId, text('before'));
      await AppDataSource.query("UPDATE events SET status = 'CANCELLED', cancelled_at = now() WHERE id = $1", [eventId]);
    }
    await denied(host, roomId);
    await denied(participant, roomId);
  });

  it.each(['stray-member', 'cancelled-participant', 'former-host', 'left-member', 'suspended-account'])
  ('rejects %s despite a known room ID', async (policy) => {
    const { host, participant, outsider, roomId, eventId } = await fixture();
    await chat.sendMessage(participant, roomId, text('before'));
    let caller = participant;
    if (policy === 'stray-member') {
      await AppDataSource.query('INSERT INTO chat_members (room_id, user_id) VALUES ($1, $2)', [roomId, outsider]);
      caller = outsider;
    }
    if (policy === 'cancelled-participant') await AppDataSource.query(
      `UPDATE event_participants SET cancelled_at = now(), attendance_status = 'CANCELLED'
       WHERE event_id = $1 AND user_id = $2`, [eventId, participant],
    );
    if (policy === 'former-host') {
      await AppDataSource.query('UPDATE events SET host_user_id = $2 WHERE id = $1', [eventId, outsider]);
      caller = host;
    }
    if (policy === 'left-member') await AppDataSource.query(
      'UPDATE chat_members SET left_at = now() WHERE room_id = $1 AND user_id = $2', [roomId, participant],
    );
    if (policy === 'suspended-account') await AppDataSource.query(
      "UPDATE users SET account_status = 'SUSPENDED' WHERE id = $1", [participant],
    );
    await denied(caller, roomId);
  });

  it.each(['completion', 'participation'])('rechecks %s after an event lock wait', async (policy) => {
    const { participant, roomId, eventId } = await fixture();
    if (policy === 'completion') await AppDataSource.query("UPDATE events SET status = 'IN_PROGRESS' WHERE id = $1", [eventId]);
    const blocker = AppDataSource.createQueryRunner();
    await blocker.connect();
    await blocker.startTransaction();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query('SELECT id FROM events WHERE id = $1 FOR UPDATE', [eventId]);
      const [{ pid }] = await blocker.query('SELECT pg_backend_pid() AS pid');
      pending = chat.sendMessage(participant, roomId, text('racing')).then(
        () => ({ unexpectedSuccess: true }), (error: unknown) => error,
      );
      const deadline = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < deadline) {
        const rows = await AppDataSource.query('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid]);
        if (rows.length) { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      // Reads stay independent of the mutation lock.
      await expect(chat.history(participant, roomId)).resolves.toMatchObject({ highWaterSeq: 0 });
      if (policy === 'completion') await blocker.query(
        "UPDATE events SET status = 'COMPLETED', completed_at = now() WHERE id = $1", [eventId],
      );
      else await blocker.query(
        `UPDATE event_participants SET cancelled_at = now(), attendance_status = 'CANCELLED'
         WHERE event_id = $1 AND user_id = $2`, [eventId, participant],
      );
      await blocker.commitTransaction();
      await expect(pending).resolves.toMatchObject(forbidden);
      const [room] = await AppDataSource.query('SELECT last_seq FROM chat_rooms WHERE id = $1', [roomId]);
      expect(room.last_seq).toBe('0');
    } finally {
      if (blocker.isTransactionActive) await blocker.rollbackTransaction();
      await blocker.release();
      await pending;
    }
  });

  it('holds lifecycle stable until a send commits', async () => {
    const { host, roomId, eventId } = await fixture();
    await AppDataSource.query("UPDATE events SET status = 'IN_PROGRESS' WHERE id = $1", [eventId]);
    const guarded = new ChatService({
      transaction: (isolation: 'READ COMMITTED', action: (manager: EntityManager) => Promise<unknown>) =>
        AppDataSource.transaction(isolation, async (manager) => {
          const result = await action(manager);
          await expect(AppDataSource.transaction(async (other) => {
            await other.query("SET LOCAL lock_timeout = '100ms'");
            await other.query("UPDATE events SET status = 'COMPLETED', completed_at = now() WHERE id = $1", [eventId]);
          })).rejects.toMatchObject({ driverError: { code: '55P03' } });
          return result;
        }),
    } as unknown as DataSource);
    await expect(guarded.sendMessage(host, roomId, text('committing'))).resolves.toMatchObject({ seq: 1 });
    await AppDataSource.query("UPDATE events SET status = 'COMPLETED', completed_at = now() WHERE id = $1", [eventId]);
    await expect(chat.history(host, roomId)).resolves.toMatchObject({ highWaterSeq: 1 });
  });
});
