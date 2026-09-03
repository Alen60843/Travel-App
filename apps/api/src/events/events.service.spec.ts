import { randomUUID } from 'node:crypto';

import {
  EventHostType,
  EventStatus,
  EventVisibility,
} from '@tripwith/shared';
import type { EntityManager } from 'typeorm';

import type { EventCategoryEntity, EventEntity } from '../database/entities';
import { GeoService } from '../database/geo';
import type { CreateEventDto } from './dto';
import {
  EmptyEventPatchError,
  EventAlreadyStartedError,
  EventCancelNotAllowedError,
  EventCategoryNotFoundError,
  EventDraftRequiredError,
  EventNotFoundError,
  EventPublishNotAllowedError,
  InactiveEventCategoryError,
  InvalidEventValueError,
  ProtectedEventFieldError,
} from './events.errors';
import type { EventsRepository } from './events.repository';
import { EventsService } from './events.service';

const USER_ID = randomUUID();
const OTHER_USER_ID = randomUUID();
const EVENT_ID = randomUUID();
const NOW = new Date('2089-12-20T00:00:00Z');
const manager = { query: jest.fn() } as unknown as EntityManager;

const category = {
  id: 7,
  code: 'trek',
  label: 'Trek',
  icon: 'mountain',
  isActive: true,
  sortOrder: 1,
} as EventCategoryEntity;

const createDto = (overrides: Partial<CreateEventDto> = {}): CreateEventDto => ({
  categoryId: category.id,
  title: '  Desert sunrise walk  ',
  capacityMax: 20,
  startsAt: '2090-01-10T06:00:00Z',
  endsAt: '2090-01-10T09:00:00Z',
  latitude: 31.5,
  longitude: 35.4,
  ...overrides,
});

function eventFixture(overrides: Partial<EventEntity> = {}): EventEntity {
  return {
    id: EVENT_ID,
    hostType: EventHostType.User,
    hostUserId: USER_ID,
    hostProviderId: null,
    categoryId: category.id,
    category,
    title: 'Desert sunrise walk',
    description: null,
    status: EventStatus.Draft,
    visibility: EventVisibility.Public,
    capacityMax: 20,
    participantCount: 0,
    priceMinor: 0,
    depositMinor: 0,
    currency: 'EUR',
    startsAt: new Date('2090-01-10T06:00:00Z'),
    endsAt: new Date('2090-01-10T09:00:00Z'),
    timeRange: '[2090-01-10 06:00:00+00,2090-01-10 09:00:00+00)',
    meetingPoint: { type: 'Point', coordinates: [35.4, 31.5] },
    meetingPointLabel: null,
    minTrustScore: 0,
    joinApprovalRequired: true,
    cancellationPolicy: null,
    createdAt: new Date('2089-12-01T00:00:00Z'),
    updatedAt: new Date('2089-12-01T00:00:00Z'),
    cancelledAt: null,
    completedAt: null,
    ...overrides,
  } as EventEntity;
}

describe('EventsService', () => {
  let repository: jest.Mocked<EventsRepository>;
  let service: EventsService;

  beforeEach(() => {
    repository = {
      transaction: jest.fn(async (work: (entityManager: EntityManager) => Promise<unknown>) =>
        work(manager)),
      findOwnedEvents: jest.fn().mockResolvedValue([]),
      findOwnedEvent: jest.fn(),
      findOwnedEventView: jest.fn(),
      findCategory: jest.fn().mockResolvedValue(category),
      createEvent: jest.fn((_manager: EntityManager, values: Partial<EventEntity>) =>
        eventFixture(values)),
      saveEvent: jest.fn(async (_manager: EntityManager, event: EventEntity) => event),
      setTransitionContext: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<EventsRepository>;
    service = new EventsService(repository, new GeoService());
  });

  it('creates only a USER-hosted DRAFT from the authenticated identity and schema defaults', async () => {
    const result = await service.createEvent(USER_ID, createDto());

    expect(repository.createEvent).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        hostType: EventHostType.User,
        hostUserId: USER_ID,
        hostProviderId: null,
        status: EventStatus.Draft,
        visibility: EventVisibility.Public,
        priceMinor: 0,
        depositMinor: 0,
        currency: 'EUR',
      }),
    );
    expect(result).toMatchObject({
      hostType: EventHostType.User,
      title: 'Desert sunrise walk',
      status: EventStatus.Draft,
      participantCount: 0,
      meetingPoint: { latitude: 31.5, longitude: 35.4 },
    });
    expect(result).not.toHaveProperty('hostUserId');
    expect(result).not.toHaveProperty('timeRange');
  });

  it('rejects client-selected host/projection fields even if service is called directly', async () => {
    await expect(
      service.createEvent(USER_ID, {
        ...createDto(),
        hostUserId: OTHER_USER_ID,
      } as CreateEventDto),
    ).rejects.toBeInstanceOf(ProtectedEventFieldError);
    expect(repository.transaction).not.toHaveBeenCalled();
  });

  it('rejects unknown categories and invalid money, time, and location', async () => {
    repository.findCategory.mockResolvedValueOnce(null);
    await expect(service.createEvent(USER_ID, createDto())).rejects.toBeInstanceOf(
      EventCategoryNotFoundError,
    );
    await expect(
      service.createEvent(USER_ID, createDto({ priceMinor: 100, depositMinor: 101 })),
    ).rejects.toBeInstanceOf(InvalidEventValueError);
    await expect(
      service.createEvent(
        USER_ID,
        createDto({
          startsAt: '2090-01-10T10:00:00Z',
          endsAt: '2090-01-10T09:00:00Z',
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidEventValueError);
    await expect(
      service.createEvent(USER_ID, createDto({ latitude: 91 })),
    ).rejects.toBeInstanceOf(InvalidEventValueError);
  });

  it('returns the same not-found boundary for absent and cross-owner resources', async () => {
    repository.findOwnedEventView.mockResolvedValue(null);
    repository.findOwnedEvent.mockResolvedValue(null);
    await expect(service.getEvent(OTHER_USER_ID, EVENT_ID)).rejects.toBeInstanceOf(
      EventNotFoundError,
    );
    await expect(
      service.updateEvent(OTHER_USER_ID, EVENT_ID, { title: 'Attacker edit' }),
    ).rejects.toBeInstanceOf(EventNotFoundError);
  });

  it('updates mutable DRAFT fields while rejecting empty, protected, and published patches', async () => {
    const draft = eventFixture();
    repository.findOwnedEvent.mockResolvedValue(draft);
    const updated = await service.updateEvent(USER_ID, EVENT_ID, {
      title: '  Updated sunrise walk  ',
      priceMinor: 5_000,
      depositMinor: 1_500,
      latitude: 31.6,
      longitude: 35.5,
    });
    expect(updated).toMatchObject({
      title: 'Updated sunrise walk',
      priceMinor: 5_000,
      depositMinor: 1_500,
      meetingPoint: { latitude: 31.6, longitude: 35.5 },
    });

    await expect(service.updateEvent(USER_ID, EVENT_ID, {})).rejects.toBeInstanceOf(
      EmptyEventPatchError,
    );
    await expect(
      service.updateEvent(USER_ID, EVENT_ID, {
        status: EventStatus.Active,
      } as never),
    ).rejects.toBeInstanceOf(ProtectedEventFieldError);

    repository.findOwnedEvent.mockResolvedValue(eventFixture({ status: EventStatus.Active }));
    await expect(
      service.updateEvent(USER_ID, EVENT_ID, { title: 'Too late to edit' }),
    ).rejects.toBeInstanceOf(EventDraftRequiredError);
  });

  it('publishes exactly DRAFT to ACTIVE after locking and setting trigger context', async () => {
    const draft = eventFixture();
    repository.findOwnedEvent.mockResolvedValue(draft);

    const published = await service.publishEvent(USER_ID, EVENT_ID, NOW);

    expect(repository.findOwnedEvent).toHaveBeenCalledWith(manager, USER_ID, EVENT_ID, true);
    expect(repository.findCategory).toHaveBeenCalledWith(manager, category.id, true);
    expect(repository.setTransitionContext).toHaveBeenCalledWith(
      manager,
      USER_ID,
      'host_publish',
    );
    expect(published.status).toBe(EventStatus.Active);
    expect(repository.setTransitionContext.mock.invocationCallOrder[0]).toBeLessThan(
      repository.saveEvent.mock.invocationCallOrder[0]!,
    );
  });

  it('rejects inactive, already-started, repeated, and illegal publish attempts', async () => {
    repository.findOwnedEvent.mockResolvedValue(eventFixture());
    repository.findCategory.mockResolvedValue({ ...category, isActive: false });
    await expect(service.publishEvent(USER_ID, EVENT_ID, NOW)).rejects.toBeInstanceOf(
      InactiveEventCategoryError,
    );

    repository.findCategory.mockResolvedValue(category);
    repository.findOwnedEvent.mockResolvedValue(
      eventFixture({ startsAt: new Date('2089-12-19T00:00:00Z') }),
    );
    await expect(service.publishEvent(USER_ID, EVENT_ID, NOW)).rejects.toBeInstanceOf(
      EventAlreadyStartedError,
    );

    for (const status of [EventStatus.Active, EventStatus.Cancelled, EventStatus.Completed]) {
      repository.findOwnedEvent.mockResolvedValue(eventFixture({ status }));
      await expect(service.publishEvent(USER_ID, EVENT_ID, NOW)).rejects.toBeInstanceOf(
        EventPublishNotAllowedError,
      );
    }
  });

  it('cancels permitted states atomically and rejects terminal states', async () => {
    for (const status of [
      EventStatus.Draft,
      EventStatus.Active,
      EventStatus.Full,
      EventStatus.InProgress,
    ]) {
      repository.findOwnedEvent.mockResolvedValue(eventFixture({ status }));
      const cancelled = await service.cancelEvent(USER_ID, EVENT_ID, NOW);
      expect(cancelled).toMatchObject({
        status: EventStatus.Cancelled,
        cancelledAt: NOW.toISOString(),
      });
    }
    expect(repository.setTransitionContext).toHaveBeenLastCalledWith(
      manager,
      USER_ID,
      'host_cancel',
    );

    for (const status of [EventStatus.Cancelled, EventStatus.Completed]) {
      repository.findOwnedEvent.mockResolvedValue(eventFixture({ status }));
      await expect(service.cancelEvent(USER_ID, EVENT_ID, NOW)).rejects.toBeInstanceOf(
        EventCancelNotAllowedError,
      );
    }
  });
});
