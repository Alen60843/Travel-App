import { GUARDS_METADATA } from '@nestjs/common/constants';
import { UserAccountStatus } from '@tripwith/shared';
import type { EntityManager } from 'typeorm';

import { type AuthenticatedUser, TripWithAuthGuard } from '../auth';
import { createValidationPipe } from '../common/pipes/create-validation-pipe';
import { AccountRestrictionEntity, EventJoinRequestEntity, UserEntity } from '../database/entities';
import { CreateJoinRequestDto } from './dto/create-join-request.dto';
import { EventsRepository } from './events.repository';
import { EventJoinRequestsController, HostJoinRequestsController, MyJoinRequestsController } from './join-requests.controller';
import { translateJoinConflict } from './join-requests.errors';
import { JoinRequestsService } from './join-requests.service';

const user = { id: 'authenticated-user', accountStatus: UserAccountStatus.Active } as AuthenticatedUser;
const protectedFields = [
  'userId', 'status', 'paymentId', 'requestedAt', 'expiresAt', 'approvedAt',
  'rejectedAt', 'cancelledAt', 'expiredAt', 'decidedByUserId', 'participantCount',
  'isHost', 'eventId', 'unknown',
];

describe('join request input and controller boundary', () => {
  const repository = { transaction: jest.fn() };
  const service = new JoinRequestsService(repository as unknown as EventsRepository);

  it.each(protectedFields)('rejects %s in both the DTO and service before any write', async (field) => {
    const body = { message: 'hello', [field]: 'attacker-controlled' };
    await expect(createValidationPipe().transform(body, { type: 'body', metatype: CreateJoinRequestDto }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    await expect(service.create(user.id, 'event', body))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    expect(repository.transaction).not.toHaveBeenCalled();
  });

  it.each(['x'.repeat(501), 123, {}, ['hello']])('rejects invalid messages: %p', async (message) => {
    const body = { message } as CreateJoinRequestDto;
    await expect(createValidationPipe().transform(body, { type: 'body', metatype: CreateJoinRequestDto }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(service.create(user.id, 'event', body)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(repository.transaction).not.toHaveBeenCalled();
  });

  it.each([{}, { message: null }, { message: '' }, { message: '😀'.repeat(500) }])('accepts schema-bounded optional text: %p', async (body) => {
    await expect(createValidationPipe().transform(body, { type: 'body', metatype: CreateJoinRequestDto })).resolves.toEqual(body);
  });

  it.each([null, [], 'hello', { message: 'contains\0nul' }])('fails closed for malformed bodies: %p', async (body) => {
    await expect(service.create(user.id, 'event', body as CreateJoinRequestDto)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(repository.transaction).not.toHaveBeenCalled();
  });

  it('forbids all fields on explicit decision/cancel commands', async () => {
    await expect(service.approve(user.id, 'event', 'request', { paymentId: 'arbitrary' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(service.reject(user.id, 'event', 'request', { status: 'APPROVED' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(service.cancel(user.id, 'request', { userId: 'other' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(repository.transaction).not.toHaveBeenCalled();
  });

  it('guards every controller and preserves the runtime creation DTO', () => {
    for (const controller of [EventJoinRequestsController, MyJoinRequestsController, HostJoinRequestsController]) {
      expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toEqual([TripWithAuthGuard]);
    }
    expect(Reflect.getMetadata('design:paramtypes', EventJoinRequestsController.prototype, 'create')[2]).toBe(CreateJoinRequestDto);
  });

  it('passes authenticated identity and the exact event/request pair on every route', async () => {
    const commands = {
      create: jest.fn(), listMine: jest.fn(), listForHost: jest.fn(),
      approve: jest.fn(), reject: jest.fn(), cancel: jest.fn(),
    };
    const requests = commands as unknown as JoinRequestsService;
    const events = new EventJoinRequestsController(requests);
    const mine = new MyJoinRequestsController(requests);
    const host = new HostJoinRequestsController(requests);
    await events.create(user, 'event', { message: 'hi' });
    await mine.list(user);
    await mine.cancel(user, 'request', {});
    await host.list(user, 'event');
    await host.approve(user, 'event', 'request', {});
    await host.reject(user, 'event', 'request', {});
    expect(commands.create).toHaveBeenCalledWith(user.id, 'event', { message: 'hi' });
    expect(commands.listMine).toHaveBeenCalledWith(user.id);
    expect(commands.cancel).toHaveBeenCalledWith(user.id, 'request', {});
    expect(commands.listForHost).toHaveBeenCalledWith(user.id, 'event');
    expect(commands.approve).toHaveBeenCalledWith(user.id, 'event', 'request', {});
    expect(commands.reject).toHaveBeenCalledWith(user.id, 'event', 'request', {});
  });
});

describe('join request database conflicts', () => {
  it.each([
    ['23505', 'event_join_requests_active_uk', 'JOIN_REQUEST_ALREADY_EXISTS'],
    ['23505', 'event_participants_active_uk', 'EVENT_ALREADY_JOINED'],
    ['23505', 'event_participants_join_request_uk', 'EVENT_ALREADY_JOINED'],
    ['23514', 'events_capacity_not_exceeded_chk', 'EVENT_CAPACITY_REACHED'],
  ])('maps %s/%s without returning database details', (code, constraint, expected) => {
    const result = translateJoinConflict({ driverError: { code, constraint, detail: 'private SQL' } });
    expect(result).toMatchObject({ code: expected, status: 409 });
    expect(JSON.stringify(result)).not.toContain('private SQL');
  });

  it('leaves unexpected failures to the global exception filter', () => {
    const error = new Error('unexpected');
    expect(translateJoinConflict(error)).toBe(error);
  });
});

describe('join command expiry transaction boundary', () => {
  it.each(['approve', 'reject', 'cancel'] as const)('%s commits EXPIRED before returning its domain failure', async (command) => {
    const row = {
      id: 'request', eventId: 'event', userId: user.id, status: 'PENDING',
      expiresAt: new Date(Date.now() - 1), expiredAt: null,
    };
    const requestRepository = { findOne: jest.fn().mockResolvedValue(row), findOneBy: jest.fn().mockResolvedValue(row), save: jest.fn().mockResolvedValue(row) };
    const eventRepository = { findOne: jest.fn().mockResolvedValue({ id: 'event' }) };
    const manager = { getRepository: (entity: unknown) => entity === EventJoinRequestEntity ? requestRepository : eventRepository } as unknown as EntityManager;
    let committed = false;
    const repository = {
      transaction: async (work: (manager: EntityManager) => Promise<unknown>) => {
        const result = await work(manager);
        committed = true;
        return result;
      },
      findOwnedEvent: jest.fn().mockResolvedValue({ id: 'event' }),
    };
    const service = new JoinRequestsService(repository as unknown as EventsRepository);
    const result = command === 'cancel'
      ? service.cancel(user.id, row.id)
      : service[command](user.id, row.eventId, row.id);
    await expect(result).rejects.toMatchObject({ code: 'JOIN_REQUEST_EXPIRED', status: 409 });
    expect(committed).toBe(true);
    expect(requestRepository.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'EXPIRED', expiredAt: expect.any(Date) }));
  });

  it('expires after waiting for user eligibility even when that account becomes unavailable', async () => {
    const row = { id: 'request', eventId: 'event', userId: user.id, status: 'PENDING', expiresAt: new Date(Date.now() + 60_000) };
    const requestRepository = { findOne: jest.fn().mockResolvedValue(row), save: jest.fn().mockResolvedValue(row) };
    const manager = {
      getRepository: (entity: unknown) => {
        if (entity === EventJoinRequestEntity) return requestRepository;
        if (entity === UserEntity) return { findOne: async () => {
          row.expiresAt = new Date(Date.now() - 1);
          return { accountStatus: 'SUSPENDED' };
        } };
        if (entity === AccountRestrictionEntity) return { exists: jest.fn().mockResolvedValue(false) };
        throw new Error('Unexpected repository access');
      },
    } as unknown as EntityManager;
    let committed = false;
    const repository = {
      transaction: async (work: (manager: EntityManager) => Promise<unknown>) => {
        const result = await work(manager);
        committed = true;
        return result;
      },
      findOwnedEvent: jest.fn().mockResolvedValue({ id: 'event', hostUserId: 'host' }),
    };
    const service = new JoinRequestsService(repository as unknown as EventsRepository);
    await expect(service.approve('host', 'event', 'request')).rejects.toMatchObject({ code: 'JOIN_REQUEST_EXPIRED' });
    expect(committed).toBe(true);
    expect(row.status).toBe('EXPIRED');
  });
});
