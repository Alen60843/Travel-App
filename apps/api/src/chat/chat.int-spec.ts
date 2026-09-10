import { randomUUID } from 'node:crypto';

import type { DataSource, EntityManager } from 'typeorm';

import { AppDataSource } from '../database/data-source';
import { ChatService } from './chat.service';

const prefix = `chat-int-${randomUUID()}`;
const rooms: string[] = [];
const users: string[] = [];
const text = (clientMessageId: string, body = clientMessageId) => ({ type: 'TEXT', clientMessageId, body });
const forbidden = { code: 'CHAT_ROOM_FORBIDDEN', status: 403 };

// Fixtures only: production MATCH provisioning remains exclusively in swipes.
async function fixture() {
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const uid = `${prefix}-${randomUUID()}`;
    const [user] = await AppDataSource.query(
      `INSERT INTO users (firebase_uid, email, account_status, date_of_birth)
       VALUES ($1, $2, 'ACTIVE', DATE '1990-01-01') RETURNING id`, [uid, `${uid}@example.com`],
    );
    ids.push(user.id);
    users.push(user.id);
  }
  const [a, b, outsider] = ids as [string, string, string];
  const room = await matchRoom(a, b);
  return { a, b, outsider, room };
}

async function matchRoom(a: string, b: string): Promise<string> {
  const [room] = await AppDataSource.query(`INSERT INTO chat_rooms (type) VALUES ('MATCH') RETURNING id`);
  rooms.push(room.id);
  await AppDataSource.query(
    `INSERT INTO matches (user_a_id, user_b_id, chat_room_id)
     VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid), $3)`, [a, b, room.id],
  );
  await AppDataSource.query(`INSERT INTO chat_members (room_id, user_id) VALUES ($1, $2), ($1, $3)`, [room.id, a, b]);
  return room.id;
}

describe('durable chat (real PostgreSQL)', () => {
  let chat: ChatService;

  beforeAll(async () => {
    await AppDataSource.initialize();
    chat = new ChatService(AppDataSource);
  });

  afterAll(async () => {
    if (!AppDataSource.isInitialized) return;
    try {
      await AppDataSource.transaction(async (manager) => {
        await manager.query(`DELETE FROM matches WHERE chat_room_id = ANY($1::uuid[])`, [rooms]);
        await manager.query(`DELETE FROM chat_rooms WHERE id = ANY($1::uuid[])`, [rooms]);
        await manager.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [users]);
      });
    } finally {
      await AppDataSource.destroy();
    }
  });

  it('serializes concurrent sends with gapless, room-local sequences and server fields', async () => {
    const { a, b, outsider, room } = await fixture();
    const otherRoom = await matchRoom(a, outsider);
    const sent = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      chat.sendMessage(i % 2 ? a : b, room, text(`send-${i}`))));
    expect(sent.map((message) => message.seq).sort((x, y) => x - y))
      .toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    for (const [i, message] of sent.entries()) {
      expect(message).toMatchObject({ roomId: room, senderUserId: i % 2 ? a : b, type: 'TEXT' });
      expect(Number.isFinite(Date.parse(message.createdAt))).toBe(true);
    }
    await expect(chat.sendMessage(a, otherRoom, text('send-0'))).resolves.toMatchObject({ seq: 1 });
    await expect(chat.authorizeRoom(a, room)).resolves.toMatchObject({ lastSeq: 20, unreadCount: 20 });
    await expect(chat.authorizeRoom(a, otherRoom)).resolves.toMatchObject({ lastSeq: 1 });
  });

  it('converges concurrent duplicates and a lost-ack retry without consuming positions', async () => {
    const { a, b, room } = await fixture();
    const retries = await Promise.all(Array.from({ length: 12 }, () => chat.sendMessage(a, room, text('same'))));
    expect(retries.every((message) => message.id === retries[0]!.id && message.seq === 1)).toBe(true);
    await expect(chat.sendMessage(a, room, text('same'))).resolves.toEqual(retries[0]);
    await expect(chat.sendMessage(b, room, text('same'))).resolves.toMatchObject({ seq: 2, senderUserId: b });
    await expect(chat.sendMessage(a, room, text('next'))).resolves.toMatchObject({ seq: 3 });
    const [row] = await AppDataSource.query(`SELECT last_seq FROM chat_rooms WHERE id = $1`, [room]);
    expect(row.last_seq).toBe('3');
  });

  it('allows sends, cursor updates and concurrent history while a history transaction remains open', async () => {
    const { a, b, room } = await fixture();
    await chat.sendMessage(a, room, text('first'));
    let release!: () => void;
    let ready!: () => void;
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const paused = new Promise<void>((resolve) => { ready = resolve; });
    const slowHistory = new ChatService({
      transaction: (isolation: 'READ COMMITTED' | 'REPEATABLE READ', action: (manager: EntityManager) => Promise<unknown>) =>
        AppDataSource.transaction(isolation, async (manager) => {
          const result = await action(manager);
          ready();
          await resume;
          return result;
        }),
    } as unknown as DataSource);
    const bounded = new ChatService({
      transaction: (isolation: 'READ COMMITTED' | 'REPEATABLE READ', action: (manager: EntityManager) => Promise<unknown>) =>
        AppDataSource.transaction(isolation, async (manager) => {
          // Fail deterministically if any operation waits for the paused reader.
          await manager.query(`SET LOCAL lock_timeout = '1s'`);
          return action(manager);
        }),
    } as unknown as DataSource);
    const pending = slowHistory.history(a, room, { afterSeq: 0, limit: 1 });
    try {
      await Promise.race([paused, pending]);
      const results = await Promise.allSettled([
        bounded.sendMessage(b, room, text('second')),
        bounded.advanceReadCursor(a, room, { lastReadSeq: 1 }),
        ...Array.from({ length: 8 }, () => bounded.history(b, room, { afterSeq: 0, limit: 1 })),
      ]);
      expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    } finally {
      release();
      await pending;
    }
    await expect(pending).resolves.toMatchObject({ highWaterSeq: 1, nextAfterSeq: 1, hasMore: false });
    const recovered = await chat.history(a, room, { afterSeq: 1 });
    expect(recovered).toMatchObject({ highWaterSeq: 2, nextAfterSeq: 2, hasMore: false });
    expect(recovered.messages.map((message) => message.seq)).toEqual([2]);
  });

  it('reads the committed high-water and page without waiting for an uncommitted send', async () => {
    const { a, room } = await fixture();
    await chat.sendMessage(a, room, text('first'));
    const writer = AppDataSource.createQueryRunner();
    await writer.connect();
    await writer.startTransaction();
    const bounded = new ChatService({
      transaction: (isolation: 'READ COMMITTED' | 'REPEATABLE READ', action: (manager: EntityManager) => Promise<unknown>) =>
        AppDataSource.transaction(isolation, async (manager) => {
          await manager.query(`SET LOCAL lock_timeout = '1s'`);
          return action(manager);
        }),
    } as unknown as DataSource);
    try {
      // Exercise the actual sequence trigger and its room lock before commit.
      await writer.query(`INSERT INTO messages (room_id, sender_user_id, type, body, client_message_id)
        VALUES ($1, $2, 'TEXT', 'second', 'second')`, [room, a]);
      const page = await bounded.history(a, room, { afterSeq: 0, limit: 1 });
      expect(page).toMatchObject({ highWaterSeq: 1, nextAfterSeq: 1, hasMore: false });
      expect(page.messages.map((message) => message.seq)).toEqual([1]);
      await writer.commitTransaction();
      const next = await bounded.history(a, room, { afterSeq: page.nextAfterSeq, limit: 1 });
      expect(next).toMatchObject({ highWaterSeq: 2, nextAfterSeq: 2, hasMore: false });
      expect(next.messages.map((message) => message.seq)).toEqual([2]);
    } finally {
      if (writer.isTransactionActive) await writer.rollbackTransaction();
      await writer.release();
    }
  });

  it('returns a stable conflict for changed-payload key reuse, including a race', async () => {
    const { a, room } = await fixture();
    const raced = await Promise.allSettled([
      chat.sendMessage(a, room, text('key', 'one')),
      chat.sendMessage(a, room, text('key', 'two')),
    ]);
    expect(raced.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failed = raced.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: 'CHAT_MESSAGE_CONFLICT', status: 409 });
    const page = await chat.history(a, room, { afterSeq: 0 });
    const original = page.messages[0]!;
    await expect(chat.sendMessage(a, room, text('key', original.body!))).resolves.toEqual(original);
    await expect(chat.sendMessage(a, room, text('key', `${original.body} `)))
      .rejects.toMatchObject({ code: 'CHAT_MESSAGE_CONFLICT', status: 409 });
    expect(page.highWaterSeq).toBe(1);
    await expect(chat.sendMessage(a, room, text('next'))).resolves.toMatchObject({ seq: 2 });
  });

  it('rolls back the inserted message, room counter and timestamp together', async () => {
    const { a, room } = await fixture();
    const aborting = new ChatService({
      transaction: (_isolation: string, action: (manager: EntityManager) => Promise<unknown>) =>
        AppDataSource.transaction('READ COMMITTED', async (manager) => {
          await action(manager);
          throw new Error('forced rollback after INSERT');
        }),
    } as unknown as DataSource);
    await expect(aborting.sendMessage(a, room, text('rollback'))).rejects.toThrow('forced rollback');
    await expect(chat.authorizeRoom(a, room)).resolves.toMatchObject({ lastSeq: 0, lastMessageAt: null });
    expect((await chat.history(a, room)).messages).toEqual([]);
    await expect(chat.sendMessage(a, room, text('rollback'))).resolves.toMatchObject({ seq: 1 });
  });

  it('bounds history and recovers every sequence including tombstones', async () => {
    const { a, room } = await fixture();
    for (let i = 1; i <= 6; i++) await chat.sendMessage(a, room, text(`m${i}`));
    await AppDataSource.query(`UPDATE messages SET deleted_at = now() WHERE room_id = $1 AND seq IN (2, 3, 6)`, [room]);
    const first = await chat.history(a, room, { afterSeq: '0', limit: '2' });
    expect(first).toMatchObject({ highWaterSeq: 6, nextAfterSeq: 2, hasMore: true });
    expect(first.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(first.messages[1]).toMatchObject({ body: null, deletedAt: expect.any(String) });
    const second = await chat.history(a, room, { afterSeq: first.nextAfterSeq, limit: 2 });
    expect(second.messages.map((m) => m.seq)).toEqual([3, 4]);
    const third = await chat.history(a, room, { afterSeq: second.nextAfterSeq, limit: 2 });
    expect(third).toMatchObject({ highWaterSeq: 6, nextAfterSeq: 6, hasMore: false });
    expect(third.messages.map((m) => m.seq)).toEqual([5, 6]);
    expect((await chat.history(a, room, { afterSeq: 6 })).messages).toEqual([]);
    const recent = await chat.history(a, room, { limit: 2 });
    expect(recent.messages.map((m) => m.seq)).toEqual([5, 6]);
    expect(recent.nextBeforeSeq).toBe(5);
    const older = await chat.history(a, room, { beforeSeq: recent.nextBeforeSeq, limit: 2 });
    expect(older.messages.map((m) => m.seq)).toEqual([3, 4]);
    const oldest = await chat.history(a, room, { beforeSeq: older.nextBeforeSeq, limit: 2 });
    expect(oldest).toMatchObject({ hasMore: false, nextBeforeSeq: null });
    expect(oldest.messages.map((m) => m.seq)).toEqual([1, 2]);
    await expect(chat.sendMessage(a, room, text('m6'))).resolves.toMatchObject({ seq: 6, body: null });
    await expect(chat.authorizeRoom(a, room)).resolves.toMatchObject({ unreadCount: 6 });
    await expect(chat.history(a, room, { afterSeq: 7 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('advances catch-up metadata across absent trailing positions without renumbering', async () => {
    const { a, room } = await fixture();
    for (let i = 1; i <= 3; i++) await chat.sendMessage(a, room, text(`m${i}`));
    // Simulate evidence retention cleanup by an external maintenance writer.
    await AppDataSource.query(`DELETE FROM messages WHERE room_id = $1 AND seq >= 2`, [room]);
    await expect(chat.history(a, room, { afterSeq: 1, limit: 1 })).resolves.toMatchObject({
      messages: [], highWaterSeq: 3, nextAfterSeq: 3, hasMore: false,
    });
    await expect(chat.sendMessage(a, room, text('next'))).resolves.toMatchObject({ seq: 4 });
  });

  it('advances only the caller cursor monotonically under concurrent reads and sends', async () => {
    const { a, b, outsider, room } = await fixture();
    const otherRoom = await matchRoom(a, outsider);
    for (let i = 1; i <= 5; i++) await chat.sendMessage(b, room, text(`m${i}`));
    const results = await Promise.all([
      chat.advanceReadCursor(a, room, { lastReadSeq: 4 }),
      chat.advanceReadCursor(a, room, { lastReadSeq: Number.MAX_SAFE_INTEGER }),
      chat.advanceReadCursor(a, room, { lastReadSeq: 1 }),
      chat.sendMessage(b, room, text('racing-send')),
    ]);
    for (const result of results.slice(0, 3)) {
      const cursor = result as Awaited<ReturnType<ChatService['advanceReadCursor']>>;
      expect(cursor.lastReadSeq).toBeLessThanOrEqual(cursor.lastSeq);
    }
    const final = await chat.authorizeRoom(a, room);
    expect(final.lastReadSeq).toBeGreaterThanOrEqual(5);
    expect(final.lastReadSeq).toBeLessThanOrEqual(6);
    expect(final.unreadCount).toBe(final.lastSeq - final.lastReadSeq);
    await expect(chat.advanceReadCursor(a, room, { lastReadSeq: 0 })).resolves.toEqual(final);
    await expect(chat.authorizeRoom(b, room)).resolves.toMatchObject({ lastReadSeq: 0, unreadCount: 6 });
    await expect(chat.authorizeRoom(a, otherRoom)).resolves.toMatchObject({ lastReadSeq: 0 });
  });

  it('denies outsiders and left memberships consistently on all operations', async () => {
    const { a, outsider, room } = await fixture();
    const assertDenied = async (user: string, target: string) => {
      await expect(chat.authorizeRoom(user, target)).rejects.toMatchObject(forbidden);
      await expect(chat.history(user, target)).rejects.toMatchObject(forbidden);
      await expect(chat.sendMessage(user, target, text('denied'))).rejects.toMatchObject(forbidden);
      await expect(chat.advanceReadCursor(user, target, { lastReadSeq: 0 })).rejects.toMatchObject(forbidden);
      expect((await chat.listRooms(user)).rooms.map((r) => r.id)).not.toContain(target);
    };
    await assertDenied(outsider, room);
    await assertDenied(a, randomUUID());
    await chat.authorizeRoom(a, room); // A previously successful join grants no cached authority.
    await AppDataSource.query(`UPDATE chat_members SET left_at = now() WHERE room_id = $1 AND user_id = $2`, [room, a]);
    await assertDenied(a, room);
  });

  it.each(['outgoing-block', 'incoming-block', 'unmatch', 'deactivate-peer', 'delete-peer', 'suspend-self', 'restrict-peer', 'restrict-self'])
  ('freshly enforces MATCH account/block policy: %s', async (policy) => {
    const { a, b, room } = await fixture();
    await chat.sendMessage(a, room, text('before'));
    switch (policy) {
      case 'outgoing-block':
      case 'incoming-block':
        await AppDataSource.query(`INSERT INTO user_blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)`,
          policy === 'outgoing-block' ? [a, b] : [b, a]);
        break;
      case 'unmatch':
        await AppDataSource.query(`UPDATE matches SET unmatched_at = now() WHERE chat_room_id = $1`, [room]);
        break;
      case 'deactivate-peer':
        await AppDataSource.query(`UPDATE users SET account_status = 'DEACTIVATED' WHERE id = $1`, [b]);
        break;
      case 'delete-peer':
        await AppDataSource.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [b]);
        break;
      case 'suspend-self':
        await AppDataSource.query(`UPDATE users SET account_status = 'SUSPENDED' WHERE id = $1`, [a]);
        break;
      default:
        await AppDataSource.query(`INSERT INTO account_restrictions (user_id, type, reason)
          VALUES ($1, $2, 'chat integration test')`,
          policy === 'restrict-self' ? [a, 'MESSAGING_SUSPENDED'] : [b, 'FULL_SUSPENSION']);
    }
    await expect(chat.authorizeRoom(a, room)).rejects.toMatchObject(forbidden);
    await expect(chat.history(a, room, { afterSeq: 0 })).rejects.toMatchObject(forbidden);
    await expect(chat.sendMessage(a, room, text('before'))).rejects.toMatchObject(forbidden);
    await expect(chat.advanceReadCursor(a, room, { lastReadSeq: 1 })).rejects.toMatchObject(forbidden);
    expect((await chat.listRooms(a)).rooms).toEqual([]);
  });

  it('does not turn matching restrictions or inactive messaging restrictions into chat bans', async () => {
    const { a, b, room } = await fixture();
    await AppDataSource.query(`INSERT INTO account_restrictions (user_id, type, reason, starts_at, ends_at, lifted_at)
      VALUES ($1, 'MATCHING_SUSPENDED', 'test', now(), NULL, NULL),
             ($1, 'MESSAGING_SUSPENDED', 'test', now() - INTERVAL '2 days', now() - INTERVAL '1 day', NULL),
             ($2, 'MESSAGING_SUSPENDED', 'test', now() + INTERVAL '1 day', NULL, NULL),
             ($2, 'FULL_SUSPENSION', 'test', now() - INTERVAL '1 day', NULL, now())`, [a, b]);
    await expect(chat.sendMessage(a, room, text('allowed'))).resolves.toMatchObject({ seq: 1 });
  });

  it('paginates only authorized rooms and rejects stray MATCH memberships', async () => {
    const { a, b, outsider, room } = await fixture();
    const otherRoom = await matchRoom(a, outsider);
    await AppDataSource.query(`INSERT INTO chat_members (room_id, user_id) VALUES ($1, $2)`, [otherRoom, b]);
    await expect(chat.authorizeRoom(b, otherRoom)).rejects.toMatchObject(forbidden);
    const first = await chat.listRooms(a, { limit: '1' });
    const second = await chat.listRooms(a, { limit: 1, afterRoomId: first.nextAfterRoomId });
    expect([...first.rooms, ...second.rooms].map((r) => r.id).sort()).toEqual([room, otherRoom].sort());
    expect(second.nextAfterRoomId).toBeNull();
    expect((await chat.listRooms(b)).rooms.map((r) => r.id)).toEqual([room]);
  });

  it('rechecks policy after waiting for a room lock', async () => {
    const { a, b, room } = await fixture();
    const blocker = AppDataSource.createQueryRunner();
    await blocker.connect();
    await blocker.startTransaction();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query(`SELECT id FROM chat_rooms WHERE id = $1 FOR UPDATE`, [room]);
      const [{ pid }] = await blocker.query(`SELECT pg_backend_pid() AS pid`);
      pending = chat.sendMessage(a, room, text('blocked')).then(
        () => ({ unexpectedSuccess: true }), (error: unknown) => error,
      );
      const deadline = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < deadline) {
        const rows = await AppDataSource.query(`SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`, [pid]);
        if (rows.length) { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await AppDataSource.query(`INSERT INTO user_blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [b, a]);
      await blocker.commitTransaction();
      await expect(pending).resolves.toMatchObject(forbidden);
      const [row] = await AppDataSource.query(`SELECT last_seq FROM chat_rooms WHERE id = $1`, [room]);
      expect(row.last_seq).toBe('0');
    } finally {
      if (blocker.isTransactionActive) await blocker.rollbackTransaction();
      await blocker.release();
      await pending;
    }
  });
});
