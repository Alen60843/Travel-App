import { randomUUID } from 'node:crypto';

import { GUARDS_METADATA } from '@nestjs/common/constants';

import { type AuthenticatedUser, TripWithAuthGuard } from '../auth';
import { EventChatController } from './event-chat.controller';
import { EventChatService } from './event-chat.service';
import type { EventsRepository } from './events.repository';

describe('EVENT room resolver boundary', () => {
  it.each([
    ['firebase-uid', randomUUID()], [randomUUID(), 'invalid-event'],
  ])('validates internal identities before opening a transaction', async (userId, eventId) => {
    const repository = { transaction: jest.fn() };
    const chat = new EventChatService(repository as unknown as EventsRepository);
    await expect(chat.resolveRoom(userId, eventId)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(repository.transaction).not.toHaveBeenCalled();
  });

  it('guards the resolver route and uses the authenticated identity', async () => {
    const service = { resolveRoom: jest.fn().mockResolvedValue({ roomId: randomUUID(), canSend: true }) };
    const controller = new EventChatController(service as unknown as EventChatService);
    const user = { id: randomUUID() } as AuthenticatedUser;
    const eventId = randomUUID();
    expect(Reflect.getMetadata(GUARDS_METADATA, EventChatController)).toEqual([TripWithAuthGuard]);
    await controller.resolveRoom(user, eventId);
    expect(service.resolveRoom).toHaveBeenCalledWith(user.id, eventId);
  });
});
