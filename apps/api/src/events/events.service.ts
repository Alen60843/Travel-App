import { Injectable } from '@nestjs/common';
import {
  canTransition,
  EventHostType,
  EventStatus,
  EventVisibility,
} from '@tripwith/shared';
import type { EntityManager } from 'typeorm';

import type { EventCategoryEntity, EventEntity } from '../database/entities';
import { GeoService } from '../database/geo';
import type { CreateEventDto, UpdateEventDto } from './dto';
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
import { EventsRepository } from './events.repository';
import type { EventView } from './events.types';
import {
  assertEventInteger,
  assertEventMoney,
  assertEventTrustScore,
  assertEventVisibility,
  assertOrderedEventTimes,
  normaliseEventCurrency,
  normaliseEventTitle,
  normaliseOptionalEventText,
  parseEventTimestamp,
} from './event-validation';

const CREATE_FIELDS = new Set([
  'categoryId',
  'title',
  'description',
  'visibility',
  'capacityMax',
  'priceMinor',
  'depositMinor',
  'currency',
  'startsAt',
  'endsAt',
  'latitude',
  'longitude',
  'meetingPointLabel',
  'minTrustScore',
  'joinApprovalRequired',
  'cancellationPolicy',
]);
const UPDATE_FIELDS = CREATE_FIELDS;

@Injectable()
export class EventsService {
  constructor(
    private readonly repository: EventsRepository,
    private readonly geo: GeoService,
  ) {}

  async createEvent(userId: string, dto: CreateEventDto): Promise<EventView> {
    this.assertAllowedFields(dto, CREATE_FIELDS);
    assertEventInteger(dto.categoryId, 'categoryId', 1, 2_147_483_647);
    const title = normaliseEventTitle(dto.title);
    const description =
      dto.description === undefined
        ? null
        : normaliseOptionalEventText(dto.description, 'description');
    const visibility = dto.visibility ?? EventVisibility.Public;
    assertEventVisibility(visibility);
    assertEventInteger(dto.capacityMax, 'capacityMax', 1, 10_000);
    const priceMinor = dto.priceMinor ?? 0;
    const depositMinor = dto.depositMinor ?? 0;
    assertEventMoney(priceMinor, depositMinor);
    const currency = normaliseEventCurrency(dto.currency ?? 'EUR');
    const startsAt = parseEventTimestamp(dto.startsAt, 'startsAt');
    const endsAt = parseEventTimestamp(dto.endsAt, 'endsAt');
    assertOrderedEventTimes(startsAt, endsAt);
    const meetingPoint = this.point(dto.latitude, dto.longitude);
    const meetingPointLabel =
      dto.meetingPointLabel === undefined
        ? null
        : normaliseOptionalEventText(dto.meetingPointLabel, 'meetingPointLabel');
    const minTrustScore = dto.minTrustScore ?? 0;
    assertEventTrustScore(minTrustScore);
    const joinApprovalRequired = dto.joinApprovalRequired ?? true;
    this.assertBoolean(joinApprovalRequired, 'joinApprovalRequired');
    const cancellationPolicy =
      dto.cancellationPolicy === undefined
        ? null
        : normaliseOptionalEventText(dto.cancellationPolicy, 'cancellationPolicy');

    return this.repository.transaction(async (manager) => {
      const category = await this.requireCategory(manager, dto.categoryId, true);
      const event = this.repository.createEvent(manager, {
        hostType: EventHostType.User,
        hostUserId: userId,
        hostProviderId: null,
        categoryId: category.id,
        category,
        title,
        description,
        status: EventStatus.Draft,
        visibility,
        capacityMax: dto.capacityMax,
        priceMinor,
        depositMinor,
        currency,
        startsAt,
        endsAt,
        meetingPoint,
        meetingPointLabel,
        minTrustScore,
        joinApprovalRequired,
        cancellationPolicy,
        cancelledAt: null,
        completedAt: null,
      });
      return this.toEventView(await this.repository.saveEvent(manager, event), category);
    });
  }

  async listEvents(userId: string): Promise<readonly EventView[]> {
    const events = await this.repository.findOwnedEvents(userId);
    return events.map((event) => this.toEventView(event));
  }

  async getEvent(userId: string, eventId: string): Promise<EventView> {
    const event = await this.repository.findOwnedEventView(userId, eventId);
    if (!event) throw new EventNotFoundError();
    return this.toEventView(event);
  }

  async updateEvent(
    userId: string,
    eventId: string,
    dto: UpdateEventDto,
  ): Promise<EventView> {
    this.assertAllowedFields(dto, UPDATE_FIELDS);
    const suppliedFields = Object.entries(dto).filter(([, value]) => value !== undefined);
    if (suppliedFields.length === 0) throw new EmptyEventPatchError();

    return this.repository.transaction(async (manager) => {
      const event = await this.requireOwnedEvent(manager, userId, eventId);
      if (event.status !== EventStatus.Draft) throw new EventDraftRequiredError(event.status);

      let category = this.requireLoadedCategory(event);
      if (dto.categoryId !== undefined) {
        assertEventInteger(dto.categoryId, 'categoryId', 1, 2_147_483_647);
        category = await this.requireCategory(manager, dto.categoryId, true);
      }

      const title = dto.title === undefined ? event.title : normaliseEventTitle(dto.title);
      const description =
        dto.description === undefined
          ? event.description
          : normaliseOptionalEventText(dto.description, 'description');
      const visibility = dto.visibility ?? event.visibility;
      assertEventVisibility(visibility);
      const capacityMax = dto.capacityMax ?? event.capacityMax;
      assertEventInteger(capacityMax, 'capacityMax', 1, 10_000);
      if (capacityMax < event.participantCount) {
        throw new InvalidEventValueError(
          'capacityMax',
          'capacityMax cannot be lower than participantCount.',
        );
      }
      const priceMinor = dto.priceMinor ?? event.priceMinor;
      const depositMinor = dto.depositMinor ?? event.depositMinor;
      assertEventMoney(priceMinor, depositMinor);
      const currency =
        dto.currency === undefined ? event.currency : normaliseEventCurrency(dto.currency);
      const startsAt =
        dto.startsAt === undefined
          ? event.startsAt
          : parseEventTimestamp(dto.startsAt, 'startsAt');
      const endsAt =
        dto.endsAt === undefined ? event.endsAt : parseEventTimestamp(dto.endsAt, 'endsAt');
      assertOrderedEventTimes(startsAt, endsAt);
      const meetingPoint = this.updatedPoint(event, dto);
      const meetingPointLabel =
        dto.meetingPointLabel === undefined
          ? event.meetingPointLabel
          : normaliseOptionalEventText(dto.meetingPointLabel, 'meetingPointLabel');
      const minTrustScore = dto.minTrustScore ?? event.minTrustScore;
      assertEventTrustScore(minTrustScore);
      const joinApprovalRequired = dto.joinApprovalRequired ?? event.joinApprovalRequired;
      this.assertBoolean(joinApprovalRequired, 'joinApprovalRequired');
      const cancellationPolicy =
        dto.cancellationPolicy === undefined
          ? event.cancellationPolicy
          : normaliseOptionalEventText(dto.cancellationPolicy, 'cancellationPolicy');

      Object.assign(event, {
        categoryId: category.id,
        category,
        title,
        description,
        visibility,
        capacityMax,
        priceMinor,
        depositMinor,
        currency,
        startsAt,
        endsAt,
        meetingPoint,
        meetingPointLabel,
        minTrustScore,
        joinApprovalRequired,
        cancellationPolicy,
      });
      return this.toEventView(await this.repository.saveEvent(manager, event), category);
    });
  }

  async publishEvent(
    userId: string,
    eventId: string,
    now?: Date,
  ): Promise<EventView> {
    return this.repository.transaction(async (manager) => {
      const event = await this.requireOwnedEvent(manager, userId, eventId);
      if (event.status !== EventStatus.Draft) {
        throw new EventPublishNotAllowedError(event.status);
      }

      const category = await this.requireCategory(manager, event.categoryId, true);
      if (!category.isActive) throw new InactiveEventCategoryError();
      this.assertCompleteConfiguration(event);
      // Read the clock after the row lock is acquired; a caller may otherwise
      // wait until after startsAt while retaining a stale pre-lock timestamp.
      const transitionAt = now ?? new Date();
      if (event.startsAt.getTime() <= transitionAt.getTime()) {
        throw new EventAlreadyStartedError();
      }

      await this.repository.setTransitionContext(manager, userId, 'host_publish');
      event.status = EventStatus.Active;
      event.category = category;
      return this.toEventView(await this.repository.saveEvent(manager, event), category);
    });
  }

  async cancelEvent(
    userId: string,
    eventId: string,
    now?: Date,
  ): Promise<EventView> {
    return this.repository.transaction(async (manager) => {
      const event = await this.requireOwnedEvent(manager, userId, eventId);
      if (!canTransition(event.status, EventStatus.Cancelled)) {
        throw new EventCancelNotAllowedError(event.status);
      }

      await this.repository.setTransitionContext(manager, userId, 'host_cancel');
      event.status = EventStatus.Cancelled;
      event.cancelledAt = now ?? new Date();
      return this.toEventView(await this.repository.saveEvent(manager, event));
    });
  }

  private async requireOwnedEvent(
    manager: EntityManager,
    userId: string,
    eventId: string,
  ): Promise<EventEntity> {
    const event = await this.repository.findOwnedEvent(manager, userId, eventId, true);
    if (!event) throw new EventNotFoundError();
    return event;
  }

  private async requireCategory(
    manager: EntityManager,
    categoryId: number,
    lock = false,
  ): Promise<EventCategoryEntity> {
    const category = await this.repository.findCategory(manager, categoryId, lock);
    if (!category) throw new EventCategoryNotFoundError();
    return category;
  }

  private requireLoadedCategory(event: EventEntity): EventCategoryEntity {
    if (!event.category) throw new Error('Owned Event query did not load its category.');
    return event.category;
  }

  private assertCompleteConfiguration(event: EventEntity): void {
    normaliseEventTitle(event.title);
    assertEventInteger(event.categoryId, 'categoryId', 1, 2_147_483_647);
    assertEventVisibility(event.visibility);
    assertEventInteger(event.capacityMax, 'capacityMax', 1, 10_000);
    if (event.participantCount > event.capacityMax) {
      throw new InvalidEventValueError('capacityMax', 'Event capacity has already been exceeded.');
    }
    assertEventMoney(event.priceMinor, event.depositMinor);
    normaliseEventCurrency(event.currency);
    assertOrderedEventTimes(event.startsAt, event.endsAt);
    this.point(event.meetingPoint.coordinates[1], event.meetingPoint.coordinates[0]);
    assertEventTrustScore(event.minTrustScore);
    this.assertBoolean(event.joinApprovalRequired, 'joinApprovalRequired');
  }

  private updatedPoint(event: EventEntity, dto: UpdateEventDto): EventEntity['meetingPoint'] {
    if ((dto.latitude === undefined) !== (dto.longitude === undefined)) {
      throw new InvalidEventValueError(
        'meetingPoint',
        'latitude and longitude must be supplied together.',
      );
    }
    if (dto.latitude === undefined || dto.longitude === undefined) return event.meetingPoint;
    return this.point(dto.latitude, dto.longitude);
  }

  private point(latitude: number, longitude: number): EventEntity['meetingPoint'] {
    try {
      return this.geo.point(latitude, longitude);
    } catch {
      throw new InvalidEventValueError(
        'meetingPoint',
        'latitude must be within [-90,90] and longitude within [-180,180].',
      );
    }
  }

  private assertBoolean(value: unknown, field: string): asserts value is boolean {
    if (typeof value !== 'boolean') {
      throw new InvalidEventValueError(field, `${field} must be a boolean.`);
    }
  }

  private assertAllowedFields(value: object, allowed: ReadonlySet<string>): void {
    const protectedField = Object.keys(value).find((field) => !allowed.has(field));
    if (protectedField) throw new ProtectedEventFieldError(protectedField);
  }

  private toEventView(event: EventEntity, category = event.category): EventView {
    if (!category) throw new Error('Cannot serialize an Event without its category.');
    return {
      id: event.id,
      hostType: event.hostType,
      category: {
        id: category.id,
        code: category.code,
        label: category.label,
        icon: category.icon,
        isActive: category.isActive,
      },
      title: event.title,
      description: event.description,
      status: event.status,
      visibility: event.visibility,
      capacityMax: event.capacityMax,
      participantCount: event.participantCount,
      priceMinor: event.priceMinor,
      depositMinor: event.depositMinor,
      currency: event.currency,
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
      meetingPoint: {
        latitude: event.meetingPoint.coordinates[1],
        longitude: event.meetingPoint.coordinates[0],
        label: event.meetingPointLabel,
      },
      minTrustScore: event.minTrustScore,
      joinApprovalRequired: event.joinApprovalRequired,
      cancellationPolicy: event.cancellationPolicy,
      cancelledAt: event.cancelledAt?.toISOString() ?? null,
      completedAt: event.completedAt?.toISOString() ?? null,
      createdAt: event.createdAt.toISOString(),
      updatedAt: event.updatedAt.toISOString(),
    };
  }
}
