import 'reflect-metadata';
import { randomUUID } from 'node:crypto';

import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { DataSource } from 'typeorm';

import { type AuthenticatedUser, TripWithAuthGuard } from '../auth';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { parseChat, sendChatMessageSchema } from './chat.validation';

const userId = randomUUID();
const roomId = randomUUID();
const message = { type: 'TEXT', clientMessageId: 'retry-key', body: 'Hello' };

describe('chat trust boundary', () => {
  const database = { transaction: jest.fn(), query: jest.fn(), manager: { query: jest.fn() } };
  const chat = new ChatService(database as unknown as DataSource);

  it.each([
    null, [], {}, { ...message, type: 'SYSTEM' }, { ...message, type: 'IMAGE' },
    { ...message, type: 'LOCATION' }, { ...message, clientMessageId: '' },
    { ...message, clientMessageId: ' ' }, { ...message, clientMessageId: 'x'.repeat(129) },
    { ...message, clientMessageId: 'a\0b' }, { ...message, body: '' },
    { ...message, clientMessageId: '\uD800' }, { ...message, body: '\uDC00' },
    { ...message, body: ' \n' }, { ...message, body: 'a\0b' },
    { ...message, body: 'x'.repeat(4001) },
    ...['senderUserId', 'seq', 'createdAt', 'deletedAt', 'roomId', 'mediaStorageKey', 'sharedLocation']
      .map((field) => ({ ...message, [field]: 'forged' })),
  ])('rejects invalid or server-owned message input (case %#)', async (input) => {
    await expect(chat.sendMessage(userId, roomId, input)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED', status: 422,
    });
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, null, true, '1'])
  ('rejects invalid read sequence %j before reaching PostgreSQL', async (lastReadSeq) => {
    await expect(chat.advanceReadCursor(userId, roomId, { lastReadSeq }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it.each([
    { limit: 0 }, { limit: 101 }, { limit: true }, { limit: null },
    { afterSeq: -1 }, { afterSeq: '9007199254740992' }, { afterSeq: ['1'] },
    { afterSeq: '' }, { afterSeq: '1e2' }, { afterSeq: 0, beforeSeq: 3 },
    { beforeSeq: 0 }, { senderUserId: userId },
  ])('bounds history and validates cursor input: %j', async (query) => {
    await expect(chat.history(userId, roomId, query)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects malformed identities and read-cursor ownership overrides', async () => {
    await expect(chat.authorizeRoom('firebase-uid', roomId)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(chat.sendMessage(userId, 'invalid', message)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(chat.advanceReadCursor(userId, roomId, { lastReadSeq: 1, userId: randomUUID() }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.manager.query).not.toHaveBeenCalled();
  });

  it('fails loudly on bigint overflow instead of serializing a rounded sequence', async () => {
    database.manager.query.mockResolvedValueOnce([{
      id: roomId, type: 'MATCH', last_seq: '9007199254740992', last_read_seq: '0', last_message_at: null,
    }]);
    await expect(chat.authorizeRoom(userId, roomId)).rejects.toBeInstanceOf(RangeError);
  });

  it('preserves exact valid Unicode and surrounding whitespace for retry comparison', () => {
    const input = { type: 'TEXT', clientMessageId: ' key-🌍 ', body: ' Hello 🌍\n' };
    expect(parseChat(sendChatMessageSchema, input)).toEqual(input);
  });

  it('guards every HTTP method and derives ownership from the authenticated user', async () => {
    const service = {
      listRooms: jest.fn(), history: jest.fn(), sendMessage: jest.fn(), advanceReadCursor: jest.fn(),
    };
    const controller = new ChatController(service as unknown as ChatService);
    const user = { id: userId } as AuthenticatedUser;
    controller.listRooms(user, {});
    controller.history(user, roomId, { afterSeq: '0' });
    controller.sendMessage(user, roomId, message);
    controller.advanceReadCursor(user, roomId, { lastReadSeq: 1 });
    expect(Reflect.getMetadata(GUARDS_METADATA, ChatController)).toContain(TripWithAuthGuard);
    expect(service.listRooms).toHaveBeenCalledWith(userId, {});
    expect(service.history).toHaveBeenCalledWith(userId, roomId, { afterSeq: '0' });
    expect(service.sendMessage).toHaveBeenCalledWith(userId, roomId, message);
    expect(service.advanceReadCursor).toHaveBeenCalledWith(userId, roomId, { lastReadSeq: 1 });
  });
});
