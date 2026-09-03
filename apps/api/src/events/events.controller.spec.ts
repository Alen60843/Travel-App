import { EventVisibility, UserAccountStatus } from '@tripwith/shared';

import type { AuthenticatedUser } from '../auth';
import { createValidationPipe } from '../common/pipes/create-validation-pipe';
import { CreateEventDto, UpdateEventDto } from './dto';
import { EventsController } from './events.controller';
import type { EventsService } from './events.service';

const USER_ID = 'ca5e5070-d8c5-4a3f-935a-da567114cf42';
const EVENT_ID = '5b636044-37ec-4557-87e4-668819170e2d';

const user: AuthenticatedUser = {
  id: USER_ID,
  firebaseUid: 'firebase-event-owner',
  accountStatus: UserAccountStatus.Active,
  firebaseIdentity: {
    firebaseUid: 'firebase-event-owner',
    email: 'event-owner@example.com',
    emailVerified: true,
    authTime: new Date('2026-08-21T00:00:00Z'),
  },
};

const createDto: CreateEventDto = {
  categoryId: 1,
  title: 'Old City walk',
  capacityMax: 12,
  visibility: EventVisibility.Unlisted,
  startsAt: '2090-01-01T10:00:00Z',
  endsAt: '2090-01-01T12:00:00Z',
  latitude: 31.778,
  longitude: 35.235,
};

describe('EventsController', () => {
  it('passes only the authenticated internal owner id to create and commands', async () => {
    const service = {
      createEvent: jest.fn().mockResolvedValue({ id: EVENT_ID }),
      publishEvent: jest.fn().mockResolvedValue({ id: EVENT_ID }),
      cancelEvent: jest.fn().mockResolvedValue({ id: EVENT_ID }),
    };
    const controller = new EventsController(service as unknown as EventsService);

    await controller.createEvent(user, createDto);
    await controller.publishEvent(user, EVENT_ID);
    await controller.cancelEvent(user, EVENT_ID);

    expect(service.createEvent).toHaveBeenCalledWith(USER_ID, createDto);
    expect(service.publishEvent).toHaveBeenCalledWith(USER_ID, EVENT_ID);
    expect(service.cancelEvent).toHaveBeenCalledWith(USER_ID, EVENT_ID);
  });

  it.each(['hostUserId', 'hostProviderId', 'hostType', 'status', 'participantCount', 'timeRange'])(
    'rejects protected create field %s through the global whitelist contract',
    async (field) => {
      const pipe = createValidationPipe();
      await expect(
        pipe.transform(
          { ...createDto, [field]: field === 'status' ? 'ACTIVE' : 'attacker-controlled' },
          { type: 'body', metatype: CreateEventDto },
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    },
  );

  it('rejects protected patch fields and retains runtime DTO metadata', async () => {
    const pipe = createValidationPipe();
    await expect(
      pipe.transform(
        { title: 'Allowed title', status: 'ACTIVE' },
        { type: 'body', metatype: UpdateEventDto },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });

    const createTypes = Reflect.getMetadata(
      'design:paramtypes',
      EventsController.prototype,
      'createEvent',
    ) as unknown[];
    const updateTypes = Reflect.getMetadata(
      'design:paramtypes',
      EventsController.prototype,
      'updateEvent',
    ) as unknown[];
    expect(createTypes[1]).toBe(CreateEventDto);
    expect(updateTypes[2]).toBe(UpdateEventDto);
  });
});
