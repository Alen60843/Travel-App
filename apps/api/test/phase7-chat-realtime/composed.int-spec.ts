import { SwipeDirection, type ChatMessagePage, type ChatMessageView } from '@tripwith/shared';

import { AppDataSource } from '../../src/database/data-source';
import { chatRoom } from '../../src/realtime/rooms';
import { ComposedFixture, pause, until, type WireClient } from './fixtures';

const text = (key: string) => ({ type: 'TEXT' as const, clientMessageId: key, body: key });
const send = (roomId: string, key: string) => ({ roomId, message: text(key) });
const forbidden = { code: 'CHAT_ROOM_FORBIDDEN', status: 403 };
const join = async (wire: WireClient, roomId: string) => {
  expect(await wire.request('chat:join', { roomId })).toMatchObject({ ok: true, data: { id: roomId } });
};

describe('Phase 7 composed services (real PostgreSQL, Nest frames and Redis)', () => {
  let fixture: ComposedFixture;
  beforeAll(async () => { await AppDataSource.initialize(); });
  beforeEach(() => { fixture = new ComposedFixture(); });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fixture?.cleanup();
  });
  afterAll(async () => { if (AppDataSource.isInitialized) await AppDataSource.destroy(); });

  it('uses the reciprocal Swipe room for durable/realtime sends, duplicate races and room-scoped cursors', async () => {
    const a = await fixture.user();
    const b = await fixture.user();
    const outsider = await fixture.user();
    const roomId = await fixture.match(a, b);
    const otherRoom = await fixture.match(a, outsider);
    const members = await AppDataSource.query('SELECT user_id FROM chat_members WHERE room_id = $1', [roomId]);
    expect(members.map((row: { user_id: string }) => row.user_id).sort()).toEqual([a, b].sort());
    const first = await fixture.instance();
    const second = await fixture.instance();
    await until(async () => await first.gateway.server.sockets.adapter.serverCount() === 2);
    const sender = await fixture.client(first.port, a);
    const remote = await fixture.client(second.port, b);
    const other = await fixture.client(second.port, outsider);
    await join(sender, roomId);
    await join(remote, roomId);
    await join(other, otherRoom);
    expect(await other.request('chat:join', { roomId })).toMatchObject({ ok: false, error: { code: forbidden.code } });
    const initial = await sender.request<ChatMessageView>('chat:send', send(roomId, 'first'));
    expect(initial).toMatchObject({ ok: true, data: { roomId, seq: 1, senderUserId: a } });
    if (!initial.ok) throw new Error('Expected durable send');
    await until(() => sender.messages.length === 1 && remote.messages.length === 1);
    expect(sender.messages).toEqual([initial.data]);
    expect(remote.messages).toEqual([initial.data]);
    // Same authenticated sender on two API instances races one dedupe key.
    const secondDevice = await fixture.client(second.port, a);
    const duplicates = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      (i % 2 ? sender : secondDevice).request<ChatMessageView>('chat:send', send(roomId, 'duplicate'))));
    expect(duplicates[0]).toMatchObject({ ok: true, data: { seq: 2 } });
    for (const duplicate of duplicates) expect(duplicate).toEqual(duplicates[0]);
    await expect(fixture.chat.sendMessage(b, roomId, text('next'))).resolves.toMatchObject({ seq: 3 });
    await expect(fixture.chat.sendMessage(a, otherRoom, text('first'))).resolves.toMatchObject({ seq: 1 });
    expect(await remote.request('chat:catch-up', { roomId, afterSeq: 1 })).toMatchObject({
      ok: true, data: { highWaterSeq: 3, nextAfterSeq: 3, messages: [
        expect.objectContaining({ seq: 2 }), expect.objectContaining({ seq: 3 }),
      ] },
    });
    await Promise.all([1, 3, 2, 999, 0].map((lastReadSeq) => fixture.chat.advanceReadCursor(a, roomId, { lastReadSeq })));
    await expect(fixture.chat.advanceReadCursor(a, roomId, { lastReadSeq: 0 }))
      .resolves.toMatchObject({ lastReadSeq: 3, lastSeq: 3, unreadCount: 0 });
    await expect(fixture.chat.authorizeRoom(b, roomId)).resolves.toMatchObject({ lastReadSeq: 0, unreadCount: 3 });
    await expect(fixture.chat.authorizeRoom(a, otherRoom)).resolves.toMatchObject({ lastReadSeq: 0, unreadCount: 1 });
    // A later swipe retry must reuse the original room and preserve its cursors.
    expect((await fixture.swipes.create(a, { targetUserId: b, direction: SwipeDirection.Like })).match)
      .toMatchObject({ chatRoomId: roomId });
    await expect(fixture.chat.authorizeRoom(a, roomId)).resolves.toMatchObject({ lastReadSeq: 3 });
    const [durable] = await AppDataSource.query(
      `SELECT r.last_seq, (SELECT count(*)::int FROM messages WHERE room_id = r.id) AS messages
       FROM chat_rooms r WHERE r.id = $1`, [roomId],
    );
    expect(durable).toEqual({ last_seq: '3', messages: 3 });
    await pause(100);
    expect(other.messages).toEqual([]);
  });

  it('repairs a committed message whose cross-instance publication fails using sequence catch-up', async () => {
    const a = await fixture.user();
    const b = await fixture.user();
    const roomId = await fixture.match(a, b);
    const first = await fixture.instance();
    const second = await fixture.instance();
    await until(async () => await first.gateway.server.sockets.adapter.serverCount() === 2);
    const sender = await fixture.client(first.port, a);
    const remote = await fixture.client(second.port, b);
    await join(sender, roomId);
    await join(remote, roomId);
    // Break notification only. Persistence, local delivery and catch-up are real.
    const publication = jest.spyOn(first.gateway.server, 'serverSideEmit').mockImplementation(() => {
      throw new Error('Injected publication failure after commit');
    });
    const ack = await sender.request<ChatMessageView>('chat:send', send(roomId, 'missed'));
    expect(ack).toMatchObject({ ok: true, data: { seq: 1 } });
    if (!ack.ok) throw new Error('Committed send must retain success');
    expect(publication).toHaveBeenCalledWith('chat:committed', { roomId, seq: 1 });
    await until(() => sender.messages.length === 1);
    await pause(100);
    expect(remote.messages).toEqual([]);
    expect((await fixture.chat.history(b, roomId)).messages).toEqual([ack.data]);
    remote.ws.close();
    const reconnected = await fixture.client(second.port, b);
    expect(await reconnected.request<ChatMessagePage>('chat:catch-up', { roomId, afterSeq: 0, limit: 1 }))
      .toMatchObject({ ok: true, data: { messages: [ack.data], highWaterSeq: 1, nextAfterSeq: 1, hasMore: false } });
    publication.mockRestore();
    expect(await sender.request('chat:send', send(roomId, 'missed'))).toEqual(ack);
    expect(await sender.request('chat:send', send(roomId, 'next'))).toMatchObject({ ok: true, data: { seq: 2 } });
  });

  it('denies a stale remote member later content while an eligible sender still commits', async () => {
    const a = await fixture.user();
    const b = await fixture.user();
    const roomId = await fixture.match(a, b);
    const first = await fixture.instance();
    const second = await fixture.instance();
    await until(async () => await first.gateway.server.sockets.adapter.serverCount() === 2);
    const sender = await fixture.client(first.port, a);
    const remote = await fixture.client(second.port, b);
    await join(remote, roomId);
    expect(await sender.request('chat:send', send(roomId, 'before'))).toMatchObject({ ok: true });
    await until(() => remote.messages.length === 1);
    const socket = [...second.gateway.server.sockets.sockets.values()][0]!;
    await AppDataSource.query('UPDATE chat_members SET left_at = now() WHERE room_id = $1 AND user_id = $2', [roomId, b]);
    expect(socket.rooms.has(chatRoom(roomId))).toBe(true);
    expect(await sender.request('chat:send', send(roomId, 'after'))).toMatchObject({ ok: true, data: { seq: 2 } });
    await until(() => !socket.rooms.has(chatRoom(roomId)));
    await pause(100);
    expect(remote.messages.map((message) => message.body)).toEqual(['before']);
    expect(await remote.request('chat:catch-up', { roomId, afterSeq: 1 }))
      .toMatchObject({ ok: false, error: { code: forbidden.code } });
    expect((await fixture.chat.history(a, roomId)).messages.map((message) => message.body)).toEqual(['before', 'after']);
  });

  it.each([true, false])('approval provisions durable EVENT chat and preserves lifecycle policy (manual=%s)', async (manual) => {
    const host = await fixture.user();
    const participant = await fixture.user();
    const outsider = await fixture.user();
    const { roomId, eventId } = await fixture.event(host, participant, manual);
    const members = await AppDataSource.query('SELECT user_id FROM chat_members WHERE room_id = $1', [roomId]);
    expect(members.map((row: { user_id: string }) => row.user_id).sort()).toEqual([host, participant].sort());
    expect(await AppDataSource.query('SELECT user_id FROM event_participants WHERE event_id = $1', [eventId]))
      .toEqual([{ user_id: participant }]);
    for (const userId of [host, participant]) {
      await expect(fixture.chat.sendMessage(userId, roomId, text('before'))).resolves.toMatchObject({ senderUserId: userId });
      await expect(fixture.resolver.resolveRoom(userId, eventId)).resolves.toEqual({ roomId, canSend: true });
    }
    await expect(fixture.chat.history(outsider, roomId)).rejects.toMatchObject(forbidden);
    await AppDataSource.query("UPDATE events SET status = 'IN_PROGRESS' WHERE id = $1", [eventId]);
    await AppDataSource.query("UPDATE events SET status = 'COMPLETED', completed_at = now() WHERE id = $1", [eventId]);
    for (const userId of [host, participant]) {
      await expect(fixture.resolver.resolveRoom(userId, eventId)).resolves.toEqual({ roomId, canSend: false });
      await expect(fixture.chat.history(userId, roomId)).resolves.toMatchObject({ highWaterSeq: 2 });
      await expect(fixture.chat.sendMessage(userId, roomId, text('before'))).rejects.toMatchObject(forbidden);
      await expect(fixture.chat.sendMessage(userId, roomId, text('after'))).rejects.toMatchObject(forbidden);
    }
    // Cancellation is a separate legal lifecycle; never force COMPLETED -> CANCELLED.
    const cancelled = await fixture.event(host, participant, manual);
    await fixture.chat.sendMessage(host, cancelled.roomId, text('retained'));
    await fixture.events.cancelEvent(host, cancelled.eventId);
    for (const userId of [host, participant]) {
      await expect(fixture.resolver.resolveRoom(userId, cancelled.eventId)).rejects.toMatchObject(forbidden);
      await expect(fixture.chat.authorizeRoom(userId, cancelled.roomId)).rejects.toMatchObject(forbidden);
      await expect(fixture.chat.history(userId, cancelled.roomId)).rejects.toMatchObject(forbidden);
      await expect(fixture.chat.sendMessage(userId, cancelled.roomId, text('after'))).rejects.toMatchObject(forbidden);
    }
  });

  it.each([true, false])('approved EVENT host/member can use realtime chat through completion and cancellation (manual=%s)', async (manual) => {
    const host = await fixture.user();
    const participant = await fixture.user();
    const { roomId, eventId } = await fixture.event(host, participant, manual);
    const first = await fixture.instance();
    const second = await fixture.instance();
    await until(async () => await first.gateway.server.sockets.adapter.serverCount() === 2);
    const sender = await fixture.client(first.port, host);
    const remote = await fixture.client(second.port, participant);
    // Contract assertions intentionally expose the obsolete EVENT transport gate.
    await join(sender, roomId);
    await join(remote, roomId);
    expect(await sender.request('chat:send', send(roomId, 'event'))).toMatchObject({ ok: true, data: { seq: 1 } });
    await until(() => remote.messages.length === 1);
    await AppDataSource.query("UPDATE events SET status = 'IN_PROGRESS' WHERE id = $1", [eventId]);
    await AppDataSource.query("UPDATE events SET status = 'COMPLETED', completed_at = now() WHERE id = $1", [eventId]);
    for (const wire of [sender, remote]) {
      expect(await wire.request('chat:catch-up', { roomId, afterSeq: 0 })).toMatchObject({ ok: true, data: { highWaterSeq: 1 } });
      expect(await wire.request('chat:send', send(roomId, 'after'))).toMatchObject({ ok: false, error: { code: forbidden.code } });
    }
    const cancelled = await fixture.event(host, participant, manual);
    await join(remote, cancelled.roomId);
    await fixture.events.cancelEvent(host, cancelled.eventId);
    for (const wire of [sender, remote]) {
      expect(await wire.request('chat:join', { roomId: cancelled.roomId })).toMatchObject({ ok: false, error: { code: forbidden.code } });
      expect(await wire.request('chat:catch-up', { roomId: cancelled.roomId, afterSeq: 0 })).toMatchObject({ ok: false, error: { code: forbidden.code } });
      expect(await wire.request('chat:send', send(cancelled.roomId, 'denied'))).toMatchObject({ ok: false, error: { code: forbidden.code } });
    }
  });
});
