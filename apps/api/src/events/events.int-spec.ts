import { randomUUID } from 'node:crypto';

import { EventStatus, EventVisibility, UserAccountStatus } from '@tripwith/shared';
import type { EntityManager } from 'typeorm';

import { AppDataSource } from '../database/data-source';
import { GeoService } from '../database/geo';
import type { CreateEventDto } from './dto';
import {
  EventAlreadyStartedError,
  EventCancelNotAllowedError,
  EventCategoryNotFoundError,
  EventNotFoundError,
  EventPublishNotAllowedError,
  InactiveEventCategoryError,
} from './events.errors';
import { EventsRepository } from './events.repository';
import { EventsService } from './events.service';

const RUN_ID = randomUUID().replaceAll('-', '');
const UID_PREFIX = `events-int-${RUN_ID}`;
const INACTIVE_CATEGORY_CODE = `inactive_${RUN_ID.slice(0, 20)}`;
const NOW = new Date('2089-12-20T00:00:00Z');

interface TestUser {
  readonly id: string;
}

let service: EventsService;
let activeCategoryId: number;
let inactiveCategoryId: number;

async function createUser(suffix: string): Promise<TestUser> {
  const [user] = (await AppDataSource.query(
    `INSERT INTO users (firebase_uid, email, account_status, date_of_birth)
     VALUES ($1, $2, $3, DATE '1990-01-01')
     RETURNING id`,
    [
      `${UID_PREFIX}-${suffix}`,
      `${RUN_ID}-${suffix}@example.test`,
      UserAccountStatus.Active,
    ],
  )) as TestUser[];
  if (!user) throw new Error('Failed to create Event integration-test user.');
  return user;
}

function draftInput(overrides: Partial<CreateEventDto> = {}): CreateEventDto {
  return {
    categoryId: activeCategoryId,
    title: '  Jerusalem food walk  ',
    description: '  A host-managed event  ',
    visibility: EventVisibility.Unlisted,
    capacityMax: 16,
    priceMinor: 4_000,
    depositMinor: 1_500,
    currency: 'EUR',
    startsAt: '2090-01-10T17:00:00Z',
    endsAt: '2090-01-10T20:00:00Z',
    latitude: 31.778,
    longitude: 35.235,
    meetingPointLabel: '  Jaffa Gate  ',
    minTrustScore: 2.5,
    joinApprovalRequired: true,
    cancellationPolicy: '  Cancel before noon  ',
    ...overrides,
  };
}

async function waitForPostgresLockWait(
  backendPid: number,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    const [activity] = (await AppDataSource.query(
      `SELECT wait_event_type
         FROM pg_stat_activity
        WHERE pid = $1`,
      [backendPid],
    )) as Array<{ wait_event_type: string | null }>;
    if (activity?.wait_event_type === 'Lock') return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  return false;
}

describe('EventsService (real PostgreSQL/PostGIS)', () => {
  beforeAll(async () => {
    await AppDataSource.initialize();
    service = new EventsService(new EventsRepository(AppDataSource), new GeoService());

    const [activeCategory] = (await AppDataSource.query(
      `SELECT id FROM event_categories WHERE is_active ORDER BY id ASC LIMIT 1`,
    )) as Array<{ id: number }>;
    if (!activeCategory) throw new Error('The canonical event category seed is missing.');
    activeCategoryId = activeCategory.id;

    const [inactiveCategory] = (await AppDataSource.query(
      `INSERT INTO event_categories (code, label, is_active, sort_order)
       VALUES ($1, $2, FALSE, 32767)
       RETURNING id`,
      [INACTIVE_CATEGORY_CODE, `Inactive ${RUN_ID.slice(0, 8)}`],
    )) as Array<{ id: number }>;
    if (!inactiveCategory) throw new Error('Failed to create inactive category fixture.');
    inactiveCategoryId = inactiveCategory.id;
  });

  afterAll(async () => {
    try {
      if (AppDataSource.isInitialized) {
        await AppDataSource.transaction(async (manager) => {
          // event_status_history is append-only in production. Test fixture
          // cleanup temporarily disables only its mutation guard inside this
          // transaction; a cleanup failure rolls the trigger state back too.
          await manager.query(
            `ALTER TABLE event_status_history DISABLE TRIGGER event_status_history_append_only`,
          );
          await manager.query(
            `DELETE FROM event_status_history
              WHERE event_id IN (
                SELECT event.id
                  FROM events event
                  JOIN users owner ON owner.id = event.host_user_id
                 WHERE owner.firebase_uid LIKE $1
              )`,
            [`${UID_PREFIX}%`],
          );
          await manager.query(
            `DELETE FROM events
              WHERE host_user_id IN (SELECT id FROM users WHERE firebase_uid LIKE $1)`,
            [`${UID_PREFIX}%`],
          );
          await manager.query(`DELETE FROM event_categories WHERE code = $1`, [
            INACTIVE_CATEGORY_CODE,
          ]);
          await manager.query(`DELETE FROM users WHERE firebase_uid LIKE $1`, [
            `${UID_PREFIX}%`,
          ]);
          await manager.query(
            `ALTER TABLE event_status_history ENABLE TRIGGER event_status_history_append_only`,
          );
        });
      }
    } finally {
      if (AppDataSource.isInitialized) await AppDataSource.destroy();
    }
  });

  it('creates, lists, reads, and configures an owner-scoped USER draft', async () => {
    const owner = await createUser('crud-owner');
    const other = await createUser('crud-other');
    const created = await service.createEvent(owner.id, draftInput());

    expect(created).toMatchObject({
      hostType: 'USER',
      title: 'Jerusalem food walk',
      description: 'A host-managed event',
      status: EventStatus.Draft,
      visibility: EventVisibility.Unlisted,
      capacityMax: 16,
      participantCount: 0,
      meetingPoint: { latitude: 31.778, longitude: 35.235, label: 'Jaffa Gate' },
      cancellationPolicy: 'Cancel before noon',
    });
    expect(Object.keys(created)).not.toContain('hostUserId');
    expect(Object.keys(created)).not.toContain('timeRange');
    await expect(service.getEvent(owner.id, created.id)).resolves.toEqual(created);
    await expect(service.listEvents(owner.id)).resolves.toContainEqual(created);
    await expect(service.listEvents(other.id)).resolves.toEqual([]);
    await expect(service.getEvent(other.id, created.id)).rejects.toBeInstanceOf(
      EventNotFoundError,
    );
    await expect(
      service.updateEvent(other.id, created.id, { title: 'Cross-owner mutation' }),
    ).rejects.toBeInstanceOf(EventNotFoundError);

    const updated = await service.updateEvent(owner.id, created.id, {
      title: '  Updated event title  ',
      startsAt: '2090-01-11T10:00:00+02:00',
      endsAt: '2090-01-11T13:00:00+02:00',
      latitude: 32.0853,
      longitude: 34.7818,
      priceMinor: 5_000,
      depositMinor: 2_000,
    });
    expect(updated).toMatchObject({
      title: 'Updated event title',
      startsAt: '2090-01-11T08:00:00.000Z',
      endsAt: '2090-01-11T11:00:00.000Z',
      meetingPoint: { latitude: 32.0853, longitude: 34.7818 },
      priceMinor: 5_000,
      depositMinor: 2_000,
    });

    const [stored] = (await AppDataSource.query(
      `SELECT host_type,
              host_user_id,
              host_provider_id,
              status,
              participant_count,
              lower(time_range) AS range_start,
              upper(time_range) AS range_end,
              ST_Y(meeting_point::geometry) AS latitude,
              ST_X(meeting_point::geometry) AS longitude
         FROM events
        WHERE id = $1`,
      [created.id],
    )) as Array<Record<string, unknown>>;
    expect(stored).toMatchObject({
      host_type: 'USER',
      host_user_id: owner.id,
      host_provider_id: null,
      status: EventStatus.Draft,
      participant_count: 0,
      range_start: new Date('2090-01-11T08:00:00Z'),
      range_end: new Date('2090-01-11T11:00:00Z'),
      latitude: 32.0853,
      longitude: 34.7818,
    });
  });

  it('rejects unknown categories, inactive-category publish, and already-started publish', async () => {
    const owner = await createUser('validation-owner');
    await expect(
      service.createEvent(owner.id, draftInput({ categoryId: 2_147_483_647 })),
    ).rejects.toBeInstanceOf(EventCategoryNotFoundError);

    const inactive = await service.createEvent(
      owner.id,
      draftInput({ categoryId: inactiveCategoryId, title: 'Inactive category draft' }),
    );
    await expect(service.publishEvent(owner.id, inactive.id, NOW)).rejects.toBeInstanceOf(
      InactiveEventCategoryError,
    );
    await expect(service.getEvent(owner.id, inactive.id)).resolves.toMatchObject({
      status: EventStatus.Draft,
    });

    const started = await service.createEvent(
      owner.id,
      draftInput({
        title: 'Already started draft',
        startsAt: '2089-12-19T10:00:00Z',
        endsAt: '2089-12-19T12:00:00Z',
      }),
    );
    await expect(service.publishEvent(owner.id, started.id, NOW)).rejects.toBeInstanceOf(
      EventAlreadyStartedError,
    );
  });

  it('records authenticated publish and cancel transitions through the database trigger', async () => {
    const owner = await createUser('lifecycle-owner');
    const draft = await service.createEvent(owner.id, draftInput({ title: 'Lifecycle event' }));
    const published = await service.publishEvent(owner.id, draft.id, NOW);
    expect(published.status).toBe(EventStatus.Active);
    await expect(service.publishEvent(owner.id, draft.id, NOW)).rejects.toBeInstanceOf(
      EventPublishNotAllowedError,
    );

    const cancelledAt = new Date('2089-12-21T00:00:00Z');
    const cancelled = await service.cancelEvent(owner.id, draft.id, cancelledAt);
    expect(cancelled).toMatchObject({
      status: EventStatus.Cancelled,
      cancelledAt: cancelledAt.toISOString(),
    });
    await expect(service.cancelEvent(owner.id, draft.id, cancelledAt)).rejects.toBeInstanceOf(
      EventCancelNotAllowedError,
    );

    const history = (await AppDataSource.query(
      `SELECT from_status, to_status, actor_user_id, reason
         FROM event_status_history
        WHERE event_id = $1
        ORDER BY created_at ASC, id ASC`,
      [draft.id],
    )) as Array<Record<string, unknown>>;
    expect(history).toEqual([
      {
        from_status: null,
        to_status: EventStatus.Draft,
        actor_user_id: owner.id,
        reason: 'created',
      },
      {
        from_status: EventStatus.Draft,
        to_status: EventStatus.Active,
        actor_user_id: owner.id,
        reason: 'host_publish',
      },
      {
        from_status: EventStatus.Active,
        to_status: EventStatus.Cancelled,
        actor_user_id: owner.id,
        reason: 'host_cancel',
      },
    ]);
  });

  it('serializes overlapping publish attempts on the same draft row', async () => {
    const owner = await createUser('concurrent-publish-owner');
    const draft = await service.createEvent(
      owner.id,
      draftInput({ title: 'Concurrent publish event' }),
    );

    let markFirstLockAcquired!: () => void;
    const firstLockAcquired = new Promise<void>((resolve) => {
      markFirstLockAcquired = resolve;
    });
    let releaseFirstLock!: () => void;
    const firstLockRelease = new Promise<void>((resolve) => {
      releaseFirstLock = resolve;
    });
    let markSecondTransactionStarted!: (backendPid: number) => void;
    const secondTransactionStarted = new Promise<number>((resolve) => {
      markSecondTransactionStarted = resolve;
    });

    // Pause the first service call only after its real SELECT ... FOR UPDATE
    // has returned. The second call uses another pooled connection and must
    // remain inside PostgreSQL's lock wait until the first transaction commits.
    const lockingRepository = new (class extends EventsRepository {
      private transactionOrdinal = 0;
      private lockedEventReads = 0;

      override transaction<T>(
        work: (manager: EntityManager) => Promise<T>,
      ): Promise<T> {
        const transactionOrdinal = ++this.transactionOrdinal;
        return super.transaction(async (manager) => {
          if (transactionOrdinal === 2) {
            const [connection] = (await manager.query(
              `SELECT pg_backend_pid() AS pid`,
            )) as Array<{ pid: number }>;
            if (!connection) throw new Error('Failed to identify PostgreSQL backend.');
            markSecondTransactionStarted(connection.pid);
          }
          return work(manager);
        });
      }

      override async findOwnedEvent(
        ...args: Parameters<EventsRepository['findOwnedEvent']>
      ) {
        const event = await super.findOwnedEvent(...args);
        if (args[3] && ++this.lockedEventReads === 1) {
          markFirstLockAcquired();
          await firstLockRelease;
        }
        return event;
      }
    })(AppDataSource);
    const concurrentService = new EventsService(lockingRepository, new GeoService());

    const firstPublish = concurrentService.publishEvent(owner.id, draft.id, NOW);
    await firstLockAcquired;
    const secondPublish = concurrentService.publishEvent(owner.id, draft.id, NOW);
    const outcomes = Promise.allSettled([firstPublish, secondPublish]);
    const secondBackendPid = await secondTransactionStarted;

    let secondWaitedOnLock: boolean;
    try {
      secondWaitedOnLock = await waitForPostgresLockWait(secondBackendPid);
    } finally {
      releaseFirstLock();
    }

    const [firstOutcome, secondOutcome] = await outcomes;
    expect(secondWaitedOnLock).toBe(true);
    expect(firstOutcome).toMatchObject({
      status: 'fulfilled',
      value: { status: EventStatus.Active },
    });
    expect(secondOutcome).toMatchObject({
      status: 'rejected',
      reason: expect.any(EventPublishNotAllowedError),
    });

    const history = (await AppDataSource.query(
      `SELECT to_status, reason
         FROM event_status_history
        WHERE event_id = $1
        ORDER BY created_at ASC, id ASC`,
      [draft.id],
    )) as Array<Record<string, unknown>>;
    expect(history).toEqual([
      { to_status: EventStatus.Draft, reason: 'created' },
      { to_status: EventStatus.Active, reason: 'host_publish' },
    ]);
  });

  it('honors completed/cancelled terminal states from the canonical state machine', async () => {
    const owner = await createUser('terminal-owner');
    const event = await service.createEvent(owner.id, draftInput({ title: 'Completed event' }));
    await AppDataSource.transaction(async (manager) => {
      await manager.query(
        `SELECT set_config('tripwith.actor_user_id', $1, true),
                set_config('tripwith.transition_reason', 'test_lifecycle', true)`,
        [owner.id],
      );
      await manager.query(`UPDATE events SET status = 'ACTIVE' WHERE id = $1`, [event.id]);
      await manager.query(`UPDATE events SET status = 'IN_PROGRESS' WHERE id = $1`, [event.id]);
      await manager.query(
        `UPDATE events
            SET status = 'COMPLETED', completed_at = $2
          WHERE id = $1`,
        [event.id, new Date('2090-01-10T20:00:00Z')],
      );
    });

    await expect(service.cancelEvent(owner.id, event.id, NOW)).rejects.toBeInstanceOf(
      EventCancelNotAllowedError,
    );
    await expect(service.publishEvent(owner.id, event.id, NOW)).rejects.toBeInstanceOf(
      EventPublishNotAllowedError,
    );
  });
});
