import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

import { AppError } from '../../common/errors/app-error';
import { ConnectionTracker } from '../../realtime/connection-tracker.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { bestEffortPublisher } from '../../realtime/redis-io.adapter';
import { chatRoom } from '../../realtime/rooms';
import type { ChatService } from '../chat.service';
import type { ChatServer, ChatSocket } from './chat.events';
import { ChatGateway } from './chat.gateway';

const roomId = randomUUID();
const userId = randomUUID();
const message = {
  id: randomUUID(), roomId, seq: 1, senderUserId: userId, type: 'TEXT', body: 'hello',
  clientMessageId: 'key', createdAt: new Date().toISOString(), deletedAt: null,
};
const input = { roomId, message: { type: 'TEXT', clientMessageId: 'key', body: 'hello' } };
const forbidden = new AppError('CHAT_ROOM_FORBIDDEN', 'private internal detail');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const chat = {
    authorizeRoom: jest.fn().mockResolvedValue({ id: roomId, type: 'MATCH' }),
    sendMessage: jest.fn().mockResolvedValue(message),
    history: jest.fn().mockResolvedValue({ messages: [message], highWaterSeq: 1, nextAfterSeq: 1 }),
  };
  const gateway = new ChatGateway(chat as unknown as ChatService);
  const socket = {
    id: 'socket', connected: true, data: { userId }, rooms: new Set([chatRoom(roomId)]),
    join: jest.fn(), leave: jest.fn(), emit: jest.fn(),
  };
  const server = {
    on: jest.fn(), serverSideEmit: jest.fn(),
    sockets: { adapter: { rooms: new Map([[chatRoom(roomId), new Set([socket.id])]]) }, sockets: new Map([[socket.id, socket]]) },
  };
  gateway.server = server as unknown as ChatServer;
  gateway.afterInit(gateway.server);
  const receive = server.on.mock.calls[0]![1] as (reference: unknown) => void;
  return { chat, gateway, socket, client: socket as unknown as ChatSocket, server, receive };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('chat transport boundaries', () => {
  it('waits for commit before fanout and returns the original ack on retry', async () => {
    const { chat, gateway, client, server } = fixture();
    const commit = deferred<typeof message>();
    chat.sendMessage.mockReturnValueOnce(commit.promise);
    const pending = gateway.send(client, input);
    await tick();
    expect(server.serverSideEmit).not.toHaveBeenCalled();
    commit.resolve(message);
    const ack = await pending;
    expect(ack).toEqual({ ok: true, data: message });
    expect(server.serverSideEmit).toHaveBeenCalledWith('chat:committed', { roomId, seq: 1 });
    expect(await gateway.send(client, input)).toEqual(ack);
    expect(chat.sendMessage).toHaveBeenCalledWith(userId, roomId, input.message);
  });

  it('does not broadcast a rollback or expose internal errors', async () => {
    const { chat, gateway, client, server, socket } = fixture();
    chat.sendMessage.mockRejectedValue(new Error('private SQL'));
    expect(await gateway.send(client, input)).toEqual({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Chat request failed.' } });
    expect(server.serverSideEmit).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('preserves committed success if publication throws', async () => {
    const { gateway, client, server } = fixture();
    server.serverSideEmit.mockImplementation(() => { throw new Error('Redis unavailable'); });
    expect(await gateway.send(client, input)).toEqual({ ok: true, data: message });
  });

  it('observes asynchronous Redis publication failures discarded by the adapter', async () => {
    const publish = jest.fn().mockRejectedValue(new Error('Redis unavailable'));
    const onFailure = jest.fn();
    const publisher = bestEffortPublisher({ publish } as unknown as Redis, onFailure);
    await expect(publisher.publish('channel', 'reference')).resolves.toBe(0);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...input, senderUserId: randomUUID() },
    { ...input, message: { ...input.message, senderUserId: randomUUID() } },
    { ...input, message: { ...input.message, seq: 100 } },
    { ...input, roomId: ['forged'] }, null,
  ])('rejects spoofed/invalid frames before persistence: %j', async (request) => {
    const { chat, gateway, client } = fixture();
    expect(await gateway.send(client, request)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it('denies outsider joins and unauthenticated handlers', async () => {
    const { chat, gateway, client, socket } = fixture();
    chat.authorizeRoom.mockRejectedValue(forbidden);
    expect(await gateway.join(client, { roomId })).toMatchObject({ ok: false, error: { code: 'CHAT_ROOM_FORBIDDEN' } });
    expect(socket.join).not.toHaveBeenCalled();
    client.data = {};
    expect(await gateway.send(client, input)).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
  });

  it('uses bounded sequence catch-up and rechecks policy after the history snapshot', async () => {
    const { chat, gateway, client } = fixture();
    const page = await gateway.catchUp(client, { roomId, afterSeq: 0, limit: 1 });
    expect(page).toMatchObject({ ok: true, data: { nextAfterSeq: 1 } });
    expect(chat.history).toHaveBeenCalledWith(userId, roomId, { afterSeq: 0, limit: 1 });
    chat.authorizeRoom.mockResolvedValueOnce({ type: 'MATCH' }).mockRejectedValueOnce(forbidden);
    expect(await gateway.catchUp(client, { roomId, afterSeq: 0 })).toMatchObject({ ok: false, error: { code: 'CHAT_ROOM_FORBIDDEN' } });
    expect(await gateway.catchUp(client, { roomId, timestamp: Date.now() })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
  });

  it('checks current eligibility at the socket owner even if membership is stale', async () => {
    const { chat, receive, socket } = fixture();
    chat.authorizeRoom.mockRejectedValue(forbidden);
    receive({ roomId, seq: 1 });
    await tick();
    expect(socket.emit).not.toHaveBeenCalled();
    expect(socket.leave).toHaveBeenCalledWith(chatRoom(roomId));
  });

  it('delivers only the referenced position in the subscribed room', async () => {
    const { receive, socket } = fixture();
    receive({ roomId: randomUUID(), seq: 1 });
    receive({ roomId, seq: 2 });
    receive({ roomId, seq: 1, body: 'untrusted' });
    await tick();
    expect(socket.emit).not.toHaveBeenCalled();
    receive({ roomId, seq: 1 });
    await tick();
    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith('chat:message', message);
  });

  it('allows EVENT joins, sends, catch-up and committed delivery authorized by ChatService', async () => {
    const { chat, gateway, client, receive, socket } = fixture();
    chat.authorizeRoom.mockResolvedValue({ id: roomId, type: 'EVENT' });
    expect(await gateway.join(client, { roomId })).toMatchObject({ ok: true, data: { type: 'EVENT' } });
    expect(socket.join).toHaveBeenCalledWith(chatRoom(roomId));
    expect(await gateway.send(client, input)).toEqual({ ok: true, data: message });
    expect(await gateway.catchUp(client, { roomId, afterSeq: 0 }))
      .toMatchObject({ ok: true, data: { messages: [message] } });
    await tick();
    socket.emit.mockClear();
    receive({ roomId, seq: 1 });
    await tick();
    expect(socket.emit).toHaveBeenCalledWith('chat:message', message);
  });

  it('preserves EVENT read access when durable sending is forbidden, without publishing', async () => {
    const { chat, gateway, client, server, socket } = fixture();
    chat.authorizeRoom.mockResolvedValue({ id: roomId, type: 'EVENT' });
    chat.sendMessage.mockRejectedValue(forbidden);
    expect(await gateway.join(client, { roomId })).toMatchObject({ ok: true });
    expect(await gateway.catchUp(client, { roomId, afterSeq: 0 })).toMatchObject({ ok: true });
    expect(await gateway.send(client, input)).toMatchObject({ ok: false, error: { code: 'CHAT_ROOM_FORBIDDEN' } });
    expect(server.serverSideEmit).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it.each(['catch-up', 'delivery'])('rejects EVENT revocation during %s history loading', async (operation) => {
    const { chat, gateway, client, receive, socket } = fixture();
    chat.authorizeRoom.mockResolvedValue({ id: roomId, type: 'EVENT' });
    const history = deferred<{ messages: typeof message[] }>();
    chat.history.mockReturnValueOnce(history.promise);
    const pending = operation === 'catch-up'
      ? gateway.catchUp(client, { roomId, afterSeq: 0 })
      : receive({ roomId, seq: 1 });
    await tick();
    expect(chat.history).toHaveBeenCalled();
    chat.authorizeRoom.mockRejectedValue(forbidden);
    history.resolve({ messages: [message] });
    if (operation === 'catch-up') {
      expect(await pending).toMatchObject({ ok: false, error: { code: 'CHAT_ROOM_FORBIDDEN' } });
    } else {
      await tick();
      expect(socket.leave).toHaveBeenCalledWith(chatRoom(roomId));
    }
    expect(socket.emit).not.toHaveBeenCalled();
  });
});

describe('authentication readiness middleware', () => {
  it('never admits handlers or counts a connection before asynchronous authentication', async () => {
    const auth = deferred<{ userId: string } | null>();
    const tracker = new ConnectionTracker();
    const gateway = new RealtimeGateway({ authenticate: () => auth.promise }, tracker);
    const server = { use: jest.fn() };
    gateway.afterInit(server as unknown as ChatServer);
    const socket = { data: {}, conn: { readyState: 'open' }, handshake: { auth: {}, headers: {} } };
    const next = jest.fn();
    server.use.mock.calls[0]![0](socket, next);
    await tick();
    expect(next).not.toHaveBeenCalled();
    expect(tracker.activeConnections).toBe(0);
    auth.resolve({ userId });
    await tick();
    expect(socket.data).toEqual({ userId });
    expect(next).toHaveBeenCalledWith(undefined);
  });

  it('does not resurrect a socket closed during verification', async () => {
    const auth = deferred<{ userId: string } | null>();
    const tracker = new ConnectionTracker();
    const gateway = new RealtimeGateway({ authenticate: () => auth.promise }, tracker);
    const server = { use: jest.fn() };
    gateway.afterInit(server as unknown as ChatServer);
    const socket = { data: {}, conn: { readyState: 'closed' }, handshake: { auth: {}, headers: {} } };
    const next = jest.fn();
    server.use.mock.calls[0]![0](socket, next);
    auth.resolve({ userId });
    await tick();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'UNAUTHENTICATED' }));
    expect(socket.data).toEqual({});
    expect(tracker.activeConnections).toBe(0);
  });
});
