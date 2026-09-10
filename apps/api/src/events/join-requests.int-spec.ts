import { randomUUID } from 'node:crypto';

import { EventStatus } from '@tripwith/shared';
import type { EntityManager } from 'typeorm';

import { AppDataSource } from '../database/data-source';
import { GeoService } from '../database/geo';
import type { CreateEventDto } from './dto';
import { EventsRepository } from './events.repository';
import { EventsService } from './events.service';
import { JoinRequestsService } from './join-requests.service';

const prefix = `join-int-${randomUUID()}`;
let sequence = 0;
let categoryId: number;
let host: string;
let traveller: string;
let outsider: string;
let events: EventsService;
let requests: JoinRequestsService;

async function user(): Promise<string> {
  const uid = `${prefix}-${++sequence}`;
  const [row] = await AppDataSource.query(
    `INSERT INTO users (firebase_uid, email, date_of_birth, account_status)
     VALUES ($1, $2, DATE '1990-01-01', 'ACTIVE') RETURNING id`, [uid, `${uid}@example.test`],
  );
  return row.id;
}

async function event(overrides: Partial<CreateEventDto> = {}, owner = host, publish = true) {
  const draft = await events.createEvent(owner, {
    categoryId, title: 'Join integration event', capacityMax: 4,
    startsAt: '2090-01-01T10:00:00Z', endsAt: '2090-01-01T12:00:00Z',
    latitude: 31.778, longitude: 35.235, ...overrides,
  });
  return publish ? events.publishEvent(owner, draft.id) : draft;
}

async function stored(requestId: string) {
  const [row] = await AppDataSource.query('SELECT * FROM event_join_requests WHERE id = $1', [requestId]);
  return row;
}

async function participants(eventId: string) {
  return AppDataSource.query('SELECT * FROM event_participants WHERE event_id = $1', [eventId]);
}

async function makeOverdue(requestId: string) {
  await AppDataSource.query(
    `UPDATE event_join_requests SET requested_at = clock_timestamp() - INTERVAL '25 hours',
       expires_at = clock_timestamp() - INTERVAL '1 hour' WHERE id = $1`, [requestId],
  );
}

async function waitForLock(pid: number): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await AppDataSource.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid]);
    if (row?.wait_event_type === 'Lock') return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

describe('JoinRequestsService (real PostgreSQL/PostGIS)', () => {
  beforeAll(async () => {
    await AppDataSource.initialize();
    const repository = new EventsRepository(AppDataSource);
    events = new EventsService(repository, new GeoService());
    requests = new JoinRequestsService(repository);
    const [category] = await AppDataSource.query('SELECT id FROM event_categories WHERE is_active ORDER BY id LIMIT 1');
    categoryId = category.id;
    host = await user();
    traveller = await user();
    outsider = await user();
  });

  afterAll(async () => {
    if (!AppDataSource.isInitialized) return;
    try {
      await AppDataSource.transaction(async (manager) => {
        // Fixture-only cleanup follows Workstream A's append-only audit cleanup.
        await manager.query('ALTER TABLE event_status_history DISABLE TRIGGER event_status_history_append_only');
        await manager.query(
          `DELETE FROM event_status_history WHERE event_id IN
           (SELECT id FROM events WHERE host_user_id IN (SELECT id FROM users WHERE firebase_uid LIKE $1))`, [`${prefix}%`],
        );
        await manager.query('DELETE FROM events WHERE host_user_id IN (SELECT id FROM users WHERE firebase_uid LIKE $1)', [`${prefix}%`]);
        await manager.query('DELETE FROM users WHERE firebase_uid LIKE $1', [`${prefix}%`]);
        await manager.query('ALTER TABLE event_status_history ENABLE TRIGGER event_status_history_append_only');
      });
    } finally {
      await AppDataSource.destroy();
    }
  });

  it('creates PENDING with exactly 24h server-owned expiry, minimizes views, and maps duplicate requests', async () => {
    const target = await event();
    const before = Date.now();
    const request = await requests.create(traveller, target.id, { message: '😀'.repeat(500) });
    expect(request).toMatchObject({ eventId: target.id, userId: traveller, status: 'PENDING', approvedAt: null });
    expect(Date.parse(request.requestedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(request.expiresAt) - Date.parse(request.requestedAt)).toBe(86_400_000);
    expect(await stored(request.id)).toMatchObject({ status: 'PENDING', payment_id: null, decided_by_user_id: null });
    await expect(requests.create(traveller, target.id, {})).rejects.toMatchObject({ code: 'JOIN_REQUEST_ALREADY_EXISTS', status: 409 });
    expect(await participants(target.id)).toHaveLength(0);
    expect(Object.keys(request).sort()).toEqual([
      'id', 'eventId', 'userId', 'status', 'message', 'requestedAt', 'expiresAt',
      'approvedAt', 'rejectedAt', 'cancelledAt', 'expiredAt',
    ].sort());
    expect((await requests.listMine(traveller)).every((row) => row.userId === traveller)).toBe(true);
    expect(await requests.listMine(outsider)).not.toContainEqual(request);
    expect(await requests.listForHost(host, target.id)).toEqual([request]);
  });

  it('rejects self-join and a current trust/account failure', async () => {
    const target = await event({ minTrustScore: 10 });
    await expect(requests.create(host, target.id, {})).rejects.toMatchObject({ code: 'EVENT_SELF_JOIN' });
    await expect(requests.create(traveller, target.id, {})).rejects.toMatchObject({ code: 'EVENT_TRUST_REQUIRED' });
    const inactive = await user();
    await AppDataSource.query("UPDATE users SET account_status = 'DEACTIVATED' WHERE id = $1", [inactive]);
    await expect(requests.create(inactive, target.id, {})).rejects.toMatchObject({ code: 'JOIN_ACCOUNT_UNAVAILABLE' });
  });

  it.each(['DRAFT', 'CANCELLED', 'IN_PROGRESS', 'COMPLETED', 'FULL', 'STARTED'])(
    'rejects a %s Event', async (status) => {
      const target = await event({}, host, false);
      if (status !== 'DRAFT') await events.publishEvent(host, target.id);
      if (status === 'CANCELLED') await events.cancelEvent(host, target.id);
      if (status === 'IN_PROGRESS' || status === 'COMPLETED') {
        await AppDataSource.query("UPDATE events SET status = 'IN_PROGRESS' WHERE id = $1", [target.id]);
      }
      if (status === 'COMPLETED') {
        await AppDataSource.query("UPDATE events SET status = 'COMPLETED', completed_at = now() WHERE id = $1", [target.id]);
      }
      if (status === 'FULL') await AppDataSource.query("UPDATE events SET status = 'FULL' WHERE id = $1", [target.id]);
      if (status === 'STARTED') {
        await AppDataSource.query("UPDATE events SET starts_at = now() - INTERVAL '1 minute' WHERE id = $1", [target.id]);
      }
      await expect(requests.create(traveller, target.id, {})).rejects.toMatchObject({
        code: status === 'FULL' ? 'EVENT_CAPACITY_REACHED' : 'EVENT_NOT_JOINABLE',
      });
    },
  );

  it('does not accept protected input at the real service boundary', async () => {
    const target = await event();
    for (const key of ['userId', 'paymentId', 'status', 'expiresAt', 'isHost', 'participantCount']) {
      await expect(requests.create(traveller, target.id, { [key]: outsider })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    await expect(requests.create(traveller, target.id, { message: 'x'.repeat(501) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await requests.listForHost(host, target.id)).toEqual([]);
  });

  it('keeps host ownership, requester ownership and event/request pairing non-leaking', async () => {
    const target = await event();
    const otherEvent = await event();
    const request = await requests.create(traveller, target.id, {});
    for (const eventId of [target.id, randomUUID()]) {
      await expect(requests.listForHost(outsider, eventId)).rejects.toMatchObject({ code: 'EVENT_NOT_FOUND', status: 404 });
      await expect(requests.approve(outsider, eventId, request.id)).rejects.toMatchObject({ code: 'EVENT_NOT_FOUND', status: 404 });
      await expect(requests.reject(outsider, eventId, request.id)).rejects.toMatchObject({ code: 'EVENT_NOT_FOUND', status: 404 });
    }
    await expect(requests.approve(host, otherEvent.id, request.id)).rejects.toMatchObject({ code: 'JOIN_REQUEST_NOT_FOUND', status: 404 });
    await expect(requests.reject(host, otherEvent.id, request.id)).rejects.toMatchObject({ code: 'JOIN_REQUEST_NOT_FOUND', status: 404 });
    await expect(requests.cancel(outsider, request.id)).rejects.toMatchObject({ code: 'JOIN_REQUEST_NOT_FOUND', status: 404 });
    expect((await stored(request.id)).status).toBe('PENDING');
  });

  it.each(['reject', 'cancel', 'expire'] as const)('%s history allows a fresh request', async (command) => {
    const target = await event();
    const request = await requests.create(traveller, target.id, {});
    if (command === 'reject') {
      expect(await requests.reject(host, target.id, request.id)).toMatchObject({ status: 'REJECTED', rejectedAt: expect.any(String) });
      expect((await stored(request.id)).decided_by_user_id).toBe(host);
    } else if (command === 'cancel') {
      expect(await requests.cancel(traveller, request.id)).toMatchObject({ status: 'CANCELLED', cancelledAt: expect.any(String) });
      await expect(requests.cancel(traveller, request.id)).rejects.toMatchObject({ code: 'JOIN_REQUEST_NOT_PENDING' });
    } else {
      await makeOverdue(request.id);
      await expect(requests.approve(host, target.id, request.id)).rejects.toMatchObject({ code: 'JOIN_REQUEST_EXPIRED' });
      expect(await stored(request.id)).toMatchObject({ status: 'EXPIRED', expired_at: expect.any(Date), approved_at: null });
    }
    expect(await participants(target.id)).toHaveLength(0);
    const replacement = await requests.create(traveller, target.id, {});
    expect(replacement.id).not.toBe(request.id);
    expect(replacement.status).toBe('PENDING');
  });

  it.each(['create', 'reject', 'cancel'] as const)('durably expires overdue rows on %s', async (command) => {
    const target = await event();
    const request = await requests.create(traveller, target.id, {});
    await makeOverdue(request.id);
    if (command === 'create') {
      const replacement = await requests.create(traveller, target.id, {});
      expect(replacement.id).not.toBe(request.id);
    } else {
      await expect(command === 'cancel'
        ? requests.cancel(traveller, request.id)
        : requests.reject(host, target.id, request.id)).rejects.toMatchObject({ code: 'JOIN_REQUEST_EXPIRED' });
    }
    expect(await stored(request.id)).toMatchObject({ status: 'EXPIRED', expired_at: expect.any(Date) });
  });

  it('retains expiry even when re-requesting fails the current Event checks', async () => {
    const target = await event();
    const request = await requests.create(traveller, target.id, {});
    await makeOverdue(request.id);
    await events.cancelEvent(host, target.id);
    await expect(requests.create(traveller, target.id, {})).rejects.toMatchObject({ code: 'EVENT_NOT_JOINABLE' });
    expect((await stored(request.id)).status).toBe('EXPIRED');
  });

  it('approves once, creates exactly one participant, and records FULL through the audit trigger', async () => {
    const target = await event({ capacityMax: 1 });
    const request = await requests.create(traveller, target.id, {});
    const approved = await requests.approve(host, target.id, request.id);
    expect(approved).toMatchObject({ status: 'APPROVED', approvedAt: expect.any(String) });
    expect(await stored(request.id)).toMatchObject({ decided_by_user_id: host, approved_at: new Date(approved.approvedAt!) });
    expect(await participants(target.id)).toEqual([expect.objectContaining({ join_request_id: request.id, user_id: traveller, is_host: false })]);
    expect(await events.getEvent(host, target.id)).toMatchObject({ participantCount: 1, status: EventStatus.Full });
    await expect(requests.approve(host, target.id, request.id)).rejects.toMatchObject({ code: 'JOIN_REQUEST_NOT_PENDING' });
    await expect(requests.reject(host, target.id, request.id)).rejects.toMatchObject({ code: 'JOIN_REQUEST_NOT_PENDING' });
    await expect(requests.cancel(traveller, request.id)).rejects.toMatchObject({ code: 'JOIN_REQUEST_NOT_PENDING' });
    await expect(requests.create(outsider, target.id, {})).rejects.toMatchObject({ code: 'EVENT_CAPACITY_REACHED' });
    const history = await AppDataSource.query("SELECT actor_user_id, reason FROM event_status_history WHERE event_id = $1 AND to_status = 'FULL'", [target.id]);
    expect(history).toEqual([{ actor_user_id: host, reason: 'capacity_reached' }]);
    expect(await events.getEvent(host, target.id)).toMatchObject({ participantCount: 1 });
  });

  it('auto-approves free requests atomically without fabricating a host decision', async () => {
    const target = await event({ capacityMax: 1, joinApprovalRequired: false });
    const request = await requests.create(traveller, target.id, {});
    expect(request).toMatchObject({ status: 'APPROVED', approvedAt: expect.any(String) });
    expect(await stored(request.id)).toMatchObject({ decided_by_user_id: null, payment_id: null });
    expect(await participants(target.id)).toHaveLength(1);
    expect(await events.getEvent(host, target.id)).toMatchObject({ participantCount: 1, status: 'FULL' });
    await expect(requests.create(outsider, target.id, {})).rejects.toMatchObject({ code: 'EVENT_CAPACITY_REACHED' });
    expect(await requests.listForHost(host, target.id)).toHaveLength(1);
  });

  it('rolls back APPROVED when the participant insert conflicts in PostgreSQL', async () => {
    const target = await event();
    const request = await requests.create(traveller, target.id, {});
    await AppDataSource.query('INSERT INTO event_participants (event_id, user_id) VALUES ($1, $2)', [target.id, traveller]);
    await expect(requests.approve(host, target.id, request.id)).rejects.toMatchObject({ code: 'EVENT_ALREADY_JOINED', status: 409 });
    expect(await stored(request.id)).toMatchObject({ status: 'PENDING', approved_at: null, decided_by_user_id: null });
    expect(await participants(target.id)).toHaveLength(1);
    expect(await events.getEvent(host, target.id)).toMatchObject({ participantCount: 1 });
  });

  it('rolls back the auto-approved request, participant and FULL audit together on transaction failure', async () => {
    const target = await event({ capacityMax: 1, joinApprovalRequired: false });
    const failing = new JoinRequestsService(new (class extends EventsRepository {
      override transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
        return super.transaction(async (manager) => {
          await work(manager);
          throw new Error('Test failure before commit');
        });
      }
    })(AppDataSource));
    await expect(failing.create(traveller, target.id, {})).rejects.toThrow('Test failure before commit');
    expect(await requests.listForHost(host, target.id)).toEqual([]);
    expect(await participants(target.id)).toEqual([]);
    expect(await events.getEvent(host, target.id)).toMatchObject({ participantCount: 0, status: 'ACTIVE' });
    expect(await AppDataSource.query("SELECT id FROM event_status_history WHERE event_id = $1 AND to_status = 'FULL'", [target.id])).toEqual([]);
  });

  it('rechecks event lifecycle and current requester account on approval', async () => {
    const target = await event();
    const requester = await user();
    const request = await requests.create(requester, target.id, {});
    await AppDataSource.query("UPDATE users SET account_status = 'SUSPENDED' WHERE id = $1", [requester]);
    await expect(requests.approve(host, target.id, request.id)).rejects.toMatchObject({ code: 'JOIN_ACCOUNT_UNAVAILABLE' });
    await AppDataSource.query("UPDATE users SET account_status = 'ACTIVE' WHERE id = $1", [requester]);
    await events.cancelEvent(host, target.id);
    await expect(requests.approve(host, target.id, request.id)).rejects.toMatchObject({ code: 'EVENT_NOT_JOINABLE' });
    expect(await stored(request.id)).toMatchObject({ status: 'PENDING', approved_at: null });
    expect(await participants(target.id)).toEqual([]);
  });

  it.each([true, false])('fails closed on deposit joining (manual approval=%s) and preserves the DB gate', async (joinApprovalRequired) => {
    const target = await event({ priceMinor: 100, depositMinor: 50, joinApprovalRequired });
    await expect(requests.create(traveller, target.id, {})).rejects.toMatchObject({ code: 'PAID_JOIN_NOT_AVAILABLE' });
    const [seed] = await AppDataSource.query(
      `INSERT INTO event_join_requests (event_id, user_id, expires_at)
       VALUES ($1, $2, now() + INTERVAL '24 hours') RETURNING id`, [target.id, traveller],
    );
    await expect(requests.approve(host, target.id, seed.id)).rejects.toMatchObject({ code: 'PAID_JOIN_NOT_AVAILABLE' });
    await expect(AppDataSource.query("UPDATE event_join_requests SET status = 'APPROVED', approved_at = now() WHERE id = $1", [seed.id]))
      .rejects.toMatchObject({ driverError: { code: '23514' } });
    expect((await stored(seed.id)).status).toBe('PENDING');
    expect(await participants(target.id)).toHaveLength(0);
  });

  it('serializes repeated approvals without creating duplicate participants', async () => {
    const target = await event();
    const request = await requests.create(traveller, target.id, {});
    const outcomes = await Promise.allSettled([
      requests.approve(host, target.id, request.id), requests.approve(host, target.id, request.id),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'JOIN_REQUEST_NOT_PENDING' }) }),
    ]);
    expect(await participants(target.id)).toHaveLength(1);
    expect(await events.getEvent(host, target.id)).toMatchObject({ participantCount: 1 });
  });

  it('two real connections race for the final seat: one commits, the loser remains PENDING', async () => {
    const target = await event({ capacityMax: 2 });
    const alreadySeated = await requests.create(await user(), target.id, {});
    await requests.approve(host, target.id, alreadySeated.id);
    const first = await requests.create(traveller, target.id, {});
    const second = await requests.create(outsider, target.id, {});
    let signalFirst!: () => void;
    const firstLocked = new Promise<void>((resolve) => { signalFirst = resolve; });
    let releaseFirst!: () => void;
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let signalSecond!: (pid: number) => void;
    const secondStarted = new Promise<number>((resolve) => { signalSecond = resolve; });
    const pids: number[] = [];
    const repository = new (class extends EventsRepository {
      private reads = 0;
      override transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
        return super.transaction(async (manager) => {
          const [connection] = await manager.query('SELECT pg_backend_pid() AS pid');
          pids.push(connection.pid);
          if (pids.length === 2) signalSecond(connection.pid);
          return work(manager);
        });
      }
      override async findOwnedEvent(...args: Parameters<EventsRepository['findOwnedEvent']>) {
        const locked = await super.findOwnedEvent(...args);
        if (++this.reads === 1) { signalFirst(); await release; }
        return locked;
      }
    })(AppDataSource);
    const concurrent = new JoinRequestsService(repository);
    const approvalOne = concurrent.approve(host, target.id, first.id);
    // Attach a rejection handler immediately; failures still reach assertions.
    const settledOne = Promise.allSettled([approvalOne]);
    await firstLocked;
    const approvalTwo = concurrent.approve(host, target.id, second.id);
    const outcomes = Promise.allSettled([approvalOne, approvalTwo]);
    let waited = false;
    try {
      waited = await waitForLock(await secondStarted);
    } finally { releaseFirst(); }
    const result = await outcomes;
    await settledOne;
    expect(new Set(pids).size).toBe(2);
    expect(waited).toBe(true);
    expect(result[0]).toMatchObject({ status: 'fulfilled', value: { status: 'APPROVED' } });
    expect(result[1]).toMatchObject({ status: 'rejected', reason: { code: 'EVENT_CAPACITY_REACHED', status: 409 } });
    expect(await stored(second.id)).toMatchObject({ status: 'PENDING', approved_at: null, decided_by_user_id: null });
    const rows = await participants(target.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row: { join_request_id: string }) => [first.id, second.id].includes(row.join_request_id))).toHaveLength(1);
    expect(await events.getEvent(host, target.id)).toMatchObject({ participantCount: 2, capacityMax: 2, status: 'FULL' });
  });
});
