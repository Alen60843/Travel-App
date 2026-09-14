import { randomUUID } from 'node:crypto';

import { AppDataSource } from '../../database/data-source';
import { ChatService } from '../chat.service';
import { PresenceService } from './presence.service';
import type { PresenceStore } from './presence.store';

const users: string[] = [];
const events: string[] = [];
const forbidden = { code: 'PRESENCE_FORBIDDEN', status: 400 };
const online = { status: 'online' as const, lastSeen: '2026-09-13T00:00:00.000Z' };

describe('EVENT presence authorization (real PostgreSQL)', () => {
  let presence: PresenceService;
  const store = { read: jest.fn().mockResolvedValue(online) };

  beforeAll(async () => {
    await AppDataSource.initialize();
    presence = new PresenceService(
      new ChatService(AppDataSource),
      AppDataSource,
      store as unknown as PresenceStore,
    );
  });

  afterEach(() => store.read.mockClear());

  afterAll(async () => {
    if (!AppDataSource.isInitialized) return;
    try {
      await AppDataSource.transaction(async (manager) => {
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

  async function fixture() {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const uid = `event-presence-${randomUUID()}`;
      const [user] = await AppDataSource.query(
        `INSERT INTO users (firebase_uid, email, account_status, date_of_birth)
         VALUES ($1, $2, 'ACTIVE', DATE '1990-01-01') RETURNING id`,
        [uid, `${uid}@example.test`],
      );
      ids.push(user.id);
      users.push(user.id);
    }
    const [host, participant, outsider] = ids as [string, string, string];
    const [event] = await AppDataSource.query(
      `INSERT INTO events (host_type, host_user_id, category_id, title, capacity_max, status,
         starts_at, ends_at, meeting_point)
       VALUES ('USER', $1, (SELECT id FROM event_categories WHERE is_active ORDER BY id LIMIT 1),
         'EVENT presence test', 4, 'ACTIVE', '2090-01-01T10:00:00Z', '2090-01-01T12:00:00Z',
         ST_SetSRID(ST_MakePoint(35.235, 31.778), 4326)::geography) RETURNING id`,
      [host],
    );
    events.push(event.id);
    await AppDataSource.query(
      'INSERT INTO event_participants (event_id, user_id) VALUES ($1, $2)',
      [event.id, participant],
    );
    const [room] = await AppDataSource.query(
      "INSERT INTO chat_rooms (type, event_id) VALUES ('EVENT', $1) RETURNING id",
      [event.id],
    );
    await AppDataSource.query(
      'INSERT INTO chat_members (room_id, user_id) VALUES ($1, $2), ($1, $3)',
      [room.id, host, participant],
    );
    return { host, participant, outsider, eventId: event.id as string, roomId: room.id as string };
  }

  it('allows host and participant presence while EVENT chat remains readable', async () => {
    const { host, participant, eventId, roomId } = await fixture();
    for (const [caller, targetUserId] of [[host, participant], [participant, host]] as const) {
      await expect(presence.query(caller, { roomId, targetUserId })).resolves.toEqual({
        roomId, targetUserId, ...online,
      });
    }
    await AppDataSource.query(
      "UPDATE events SET status = 'IN_PROGRESS' WHERE id = $1",
      [eventId],
    );
    await AppDataSource.query(
      "UPDATE events SET status = 'COMPLETED', completed_at = now() WHERE id = $1",
      [eventId],
    );
    await expect(presence.query(host, { roomId, targetUserId: participant })).resolves.toEqual({
      roomId, targetUserId: participant, ...online,
    });
  });

  it.each(['caller', 'target', 'lifecycle'])('denies presence when current EVENT %s authorization is revoked', async (policy) => {
    const { host, participant, eventId, roomId } = await fixture();
    if (policy === 'caller') {
      await AppDataSource.query(
        'UPDATE chat_members SET left_at = now() WHERE room_id = $1 AND user_id = $2',
        [roomId, host],
      );
    } else if (policy === 'lifecycle') {
      await AppDataSource.query(
        "UPDATE events SET status = 'CANCELLED', cancelled_at = now() WHERE id = $1",
        [eventId],
      );
    } else {
      await AppDataSource.query(
        `UPDATE event_participants SET cancelled_at = now(), attendance_status = 'CANCELLED'
         WHERE event_id = $1 AND user_id = $2`,
        [eventId, participant],
      );
    }
    await expect(presence.query(host, { roomId, targetUserId: participant })).rejects.toMatchObject(forbidden);
    expect(store.read).not.toHaveBeenCalled();
  });

  it.each(['caller-blocks-target', 'target-blocks-caller'])('denies EVENT presence for %s', async (policy) => {
    const { host, participant, roomId } = await fixture();
    await AppDataSource.query(
      'INSERT INTO user_blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)',
      policy === 'caller-blocks-target' ? [host, participant] : [participant, host],
    );
    await expect(presence.query(host, { roomId, targetUserId: participant })).rejects.toMatchObject(forbidden);
    expect(store.read).not.toHaveBeenCalled();
  });

  it('denies substituting an unrelated target into an authorized EVENT room', async () => {
    const { host, outsider, roomId } = await fixture();
    await expect(presence.query(host, { roomId, targetUserId: outsider })).rejects.toMatchObject(forbidden);
    expect(store.read).not.toHaveBeenCalled();
  });
});
