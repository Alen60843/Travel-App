import { Injectable } from '@nestjs/common';
import {
  AttendanceStatus, canTransition, EventHostType, EventStatus, JoinRequestStatus,
  RestrictionType, UserAccountStatus,
} from '@tripwith/shared';
import { In, IsNull, LessThanOrEqual, MoreThan, type EntityManager } from 'typeorm';

import { AppError, ValidationError } from '../common/errors/app-error';
import {
  AccountRestrictionEntity, EventEntity, EventJoinRequestEntity,
  EventParticipantEntity, UserEntity,
} from '../database/entities';
import type { CreateJoinRequestDto } from './dto/create-join-request.dto';
import { EventNotFoundError } from './events.errors';
import { EventsRepository } from './events.repository';
import { joinError, translateJoinConflict } from './join-requests.errors';

export interface JoinRequestView {
  readonly id: string;
  readonly eventId: string;
  readonly userId: string;
  readonly status: JoinRequestStatus;
  readonly message: string | null;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly approvedAt: string | null;
  readonly rejectedAt: string | null;
  readonly cancelledAt: string | null;
  readonly expiredAt: string | null;
}

@Injectable()
export class JoinRequestsService {
  constructor(private readonly events: EventsRepository) {}

  async create(userId: string, eventId: string, body: CreateJoinRequestDto): Promise<JoinRequestView> {
    this.assertBody(body, ['message']);
    const message = body.message ?? null;
    if (message !== null && (typeof message !== 'string' || Array.from(message).length > 500 || message.includes('\0'))) {
      throw new ValidationError('message must be text of at most 500 characters without NUL.');
    }
    return this.command(async (manager) => {
      const event = await this.lockEvent(manager, eventId);
      const requests = manager.getRepository(EventJoinRequestEntity);
      const live = await requests.findOne({
        where: { eventId, userId, status: In([JoinRequestStatus.Pending, JoinRequestStatus.Approved]) },
        lock: { mode: 'pessimistic_write' },
      });
      if (live && !(await this.expire(manager, live))) return joinError('JOIN_REQUEST_ALREADY_EXISTS');

      // Validation failures are returned so any expiry above commits. No new
      // request/participant has been written at this point.
      try {
        await this.requireEligibleUser(manager, userId, event);
        this.assertJoinable(event);
      } catch (error) {
        if (error instanceof AppError) return error;
        throw error;
      }
      if (await manager.getRepository(EventParticipantEntity).exists({
        where: { eventId, userId, cancelledAt: IsNull() },
      })) return joinError('EVENT_ALREADY_JOINED');

      const requestedAt = new Date();
      const request = await requests.save(requests.create({
        eventId, userId, message, status: JoinRequestStatus.Pending,
        requestedAt, expiresAt: new Date(requestedAt.getTime() + 24 * 60 * 60 * 1000),
        paymentId: null, approvedAt: null, rejectedAt: null, cancelledAt: null,
        expiredAt: null, decidedByUserId: null,
      }));
      if (!event.joinApprovalRequired) {
        // Always UPDATE from PENDING: the existing payment guard is an UPDATE
        // trigger. Auto-approval records approval time, but no host decision.
        await this.approveAndParticipate(manager, event, request, null, userId);
      }
      return this.view(request);
    });
  }

  async listMine(userId: string): Promise<JoinRequestView[]> {
    return this.events.transaction(async (manager) => {
      const requests = await manager.getRepository(EventJoinRequestEntity).find({
        where: { userId }, order: { requestedAt: 'DESC', id: 'ASC' },
      });
      return requests.map((request) => this.view(request));
    });
  }

  async listForHost(userId: string, eventId: string): Promise<JoinRequestView[]> {
    return this.events.transaction(async (manager) => {
      await this.requireOwnedEvent(manager, userId, eventId);
      const requests = await manager.getRepository(EventJoinRequestEntity).find({
        where: { eventId }, order: { requestedAt: 'DESC', id: 'ASC' },
      });
      return requests.map((request) => this.view(request));
    });
  }

  async cancel(userId: string, requestId: string, body: unknown = {}): Promise<JoinRequestView> {
    this.assertBody(body, []);
    return this.command(async (manager) => {
      const requests = manager.getRepository(EventJoinRequestEntity);
      // This read only locates the event. All mutable state is re-read after
      // locking in the same event -> request order as approval and lifecycle.
      const located = await requests.findOneBy({ id: requestId, userId });
      if (!located) throw joinError('JOIN_REQUEST_NOT_FOUND');
      await this.lockEvent(manager, located.eventId);
      const request = await requests.findOne({
        where: { id: requestId, userId, eventId: located.eventId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!request) throw joinError('JOIN_REQUEST_NOT_FOUND');
      const failure = await this.pendingFailure(manager, request);
      if (failure) return failure;
      request.status = JoinRequestStatus.Cancelled;
      request.cancelledAt = new Date();
      await requests.save(request);
      return this.view(request);
    });
  }

  async approve(userId: string, eventId: string, requestId: string, body: unknown = {}): Promise<JoinRequestView> {
    return this.decide(userId, eventId, requestId, true, body);
  }

  async reject(userId: string, eventId: string, requestId: string, body: unknown = {}): Promise<JoinRequestView> {
    return this.decide(userId, eventId, requestId, false, body);
  }

  private async decide(userId: string, eventId: string, requestId: string, approve: boolean, body: unknown): Promise<JoinRequestView> {
    this.assertBody(body, []);
    return this.command(async (manager) => {
      const event = await this.requireOwnedEvent(manager, userId, eventId);
      const request = await manager.getRepository(EventJoinRequestEntity).findOne({
        where: { id: requestId, eventId }, lock: { mode: 'pessimistic_write' },
      });
      if (!request) throw joinError('JOIN_REQUEST_NOT_FOUND');
      const failure = await this.pendingFailure(manager, request);
      if (failure) return failure;
      if (approve) {
        let eligibilityFailure: AppError | null = null;
        try {
          await this.requireEligibleUser(manager, request.userId, event);
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          eligibilityFailure = error;
        }
        // Recheck expiry after the user lock too, including when current user
        // eligibility failed: waiting may have crossed the deadline.
        const overdue = await this.pendingFailure(manager, request);
        if (overdue) return overdue;
        if (eligibilityFailure) return eligibilityFailure;
        this.assertJoinable(event);
        await this.approveAndParticipate(manager, event, request, userId, userId);
      } else {
        request.status = JoinRequestStatus.Rejected;
        request.rejectedAt = new Date();
        request.decidedByUserId = userId;
        await manager.getRepository(EventJoinRequestEntity).save(request);
      }
      return this.view(request);
    });
  }

  private async approveAndParticipate(manager: EntityManager, event: EventEntity, request: EventJoinRequestEntity, decidedBy: string | null, actor: string): Promise<void> {
    request.status = JoinRequestStatus.Approved;
    request.approvedAt = new Date();
    request.decidedByUserId = decidedBy;
    await manager.getRepository(EventJoinRequestEntity).save(request);
    await manager.getRepository(EventParticipantEntity).insert({
      eventId: event.id, userId: request.userId, joinRequestId: request.id,
      paymentId: null, isHost: false, attendanceStatus: AttendanceStatus.Unknown,
    });
    // Re-read the trigger-maintained count; never calculate or write it here.
    const current = await manager.getRepository(EventEntity).findOneByOrFail({ id: event.id });
    if (current.participantCount === current.capacityMax && canTransition(current.status, EventStatus.Full)) {
      await this.events.setTransitionContext(manager, actor, 'capacity_reached');
      await manager.getRepository(EventEntity).update(event.id, { status: EventStatus.Full });
    }
  }

  private async requireEligibleUser(manager: EntityManager, userId: string, event: EventEntity): Promise<void> {
    if (event.hostUserId === userId) throw joinError('EVENT_SELF_JOIN');
    const user = await manager.getRepository(UserEntity).findOne({
      where: { id: userId }, lock: { mode: 'pessimistic_read' },
    });
    if (!user || user.deletedAt || user.accountStatus !== UserAccountStatus.Active) {
      throw joinError('JOIN_ACCOUNT_UNAVAILABLE');
    }
    const now = new Date();
    const restriction = { userId, type: RestrictionType.FullSuspension, startsAt: LessThanOrEqual(now), liftedAt: IsNull() };
    if (await manager.getRepository(AccountRestrictionEntity).exists({
      where: [{ ...restriction, endsAt: IsNull() }, { ...restriction, endsAt: MoreThan(now) }],
    })) throw joinError('JOIN_ACCOUNT_UNAVAILABLE');
    if (user.trustScore === null || user.trustScore < event.minTrustScore) throw joinError('EVENT_TRUST_REQUIRED');
  }

  private assertJoinable(event: EventEntity): void {
    if (event.status === EventStatus.Full || event.participantCount >= event.capacityMax) throw joinError('EVENT_CAPACITY_REACHED');
    if (event.status !== EventStatus.Active || event.startsAt.getTime() <= Date.now()) throw joinError('EVENT_NOT_JOINABLE');
    if (event.depositMinor > 0) throw joinError('PAID_JOIN_NOT_AVAILABLE');
  }

  private async lockEvent(manager: EntityManager, eventId: string): Promise<EventEntity> {
    const event = await manager.getRepository(EventEntity).findOne({
      where: { id: eventId, hostType: EventHostType.User, hostProviderId: IsNull() },
      lock: { mode: 'pessimistic_write' },
    });
    if (!event) throw new EventNotFoundError();
    return event;
  }

  private async requireOwnedEvent(manager: EntityManager, userId: string, eventId: string): Promise<EventEntity> {
    const event = await this.events.findOwnedEvent(manager, userId, eventId, true);
    if (!event) throw new EventNotFoundError();
    return event;
  }

  private async expire(manager: EntityManager, request: EventJoinRequestEntity): Promise<boolean> {
    const now = new Date();
    if (request.status !== JoinRequestStatus.Pending || request.expiresAt.getTime() > now.getTime()) return false;
    request.status = JoinRequestStatus.Expired;
    request.expiredAt = now;
    await manager.getRepository(EventJoinRequestEntity).save(request);
    return true;
  }

  private async pendingFailure(manager: EntityManager, request: EventJoinRequestEntity): Promise<AppError | null> {
    if (await this.expire(manager, request) || request.status === JoinRequestStatus.Expired) return joinError('JOIN_REQUEST_EXPIRED');
    return request.status === JoinRequestStatus.Pending ? null : joinError('JOIN_REQUEST_NOT_PENDING');
  }

  private async command(work: (manager: EntityManager) => Promise<JoinRequestView | AppError>): Promise<JoinRequestView> {
    try {
      const result = await this.events.transaction(work);
      // Throw only after commit when a command has durably expired a row.
      if (result instanceof AppError) throw result;
      return result;
    } catch (error) {
      throw translateJoinConflict(error);
    }
  }

  private assertBody(body: unknown, fields: readonly string[]): asserts body is Record<string, unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !fields.includes(key))) {
      throw new ValidationError('Request contains unsupported fields.');
    }
  }

  private view(request: EventJoinRequestEntity): JoinRequestView {
    return {
      id: request.id, eventId: request.eventId, userId: request.userId,
      status: request.status, message: request.message,
      requestedAt: request.requestedAt.toISOString(), expiresAt: request.expiresAt.toISOString(),
      approvedAt: request.approvedAt?.toISOString() ?? null,
      rejectedAt: request.rejectedAt?.toISOString() ?? null,
      cancelledAt: request.cancelledAt?.toISOString() ?? null,
      expiredAt: request.expiredAt?.toISOString() ?? null,
    };
  }
}
