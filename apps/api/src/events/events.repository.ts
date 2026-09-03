import { Injectable } from '@nestjs/common';
import type { DeepPartial, EntityManager } from 'typeorm';
import { DataSource } from 'typeorm';

import { EventCategoryEntity, EventEntity } from '../database/entities';

@Injectable()
export class EventsRepository {
  constructor(private readonly dataSource: DataSource) {}

  transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(work);
  }

  findOwnedEvents(userId: string): Promise<EventEntity[]> {
    return this.dataSource
      .getRepository(EventEntity)
      .createQueryBuilder('event')
      .innerJoinAndSelect('event.category', 'category')
      .where(
        `event.host_type = 'USER'
         AND event.host_user_id = :userId
         AND event.host_provider_id IS NULL`,
        { userId },
      )
      .orderBy('event.created_at', 'DESC')
      .addOrderBy('event.id', 'ASC')
      .getMany();
  }

  findOwnedEvent(
    manager: EntityManager,
    userId: string,
    eventId: string,
    lock = false,
  ): Promise<EventEntity | null> {
    const query = manager
      .getRepository(EventEntity)
      .createQueryBuilder('event')
      .innerJoinAndSelect('event.category', 'category')
      .where(
        `event.id = :eventId
         AND event.host_type = 'USER'
         AND event.host_user_id = :userId
         AND event.host_provider_id IS NULL`,
        { eventId, userId },
      );
    if (lock) query.setLock('pessimistic_write', undefined, ['event']);
    return query.getOne();
  }

  findOwnedEventView(userId: string, eventId: string): Promise<EventEntity | null> {
    return this.findOwnedEvent(this.dataSource.manager, userId, eventId);
  }

  findCategory(
    manager: EntityManager,
    categoryId: number,
    lock = false,
  ): Promise<EventCategoryEntity | null> {
    const query = manager
      .getRepository(EventCategoryEntity)
      .createQueryBuilder('category')
      .where('category.id = :categoryId', { categoryId });
    if (lock) query.setLock('pessimistic_read');
    return query.getOne();
  }

  createEvent(manager: EntityManager, values: DeepPartial<EventEntity>): EventEntity {
    return manager.getRepository(EventEntity).create(values);
  }

  async saveEvent(manager: EntityManager, event: EventEntity): Promise<EventEntity> {
    const saved = await manager.getRepository(EventEntity).save(event);
    // Re-read instead of relying on TypeORM's partial RETURNING projection:
    // participant_count and time_range are database-owned, and category is
    // required by the management serializer.
    const reloaded = await manager
      .getRepository(EventEntity)
      .createQueryBuilder('event')
      .innerJoinAndSelect('event.category', 'category')
      .where('event.id = :eventId', { eventId: saved.id })
      .getOne();
    if (!reloaded) throw new Error('Saved Event could not be re-read.');
    return reloaded;
  }

  async setTransitionContext(
    manager: EntityManager,
    actorUserId: string,
    reason: 'host_publish' | 'host_cancel',
  ): Promise<void> {
    await manager.query(
      `SELECT set_config('tripwith.actor_user_id', $1, true),
              set_config('tripwith.transition_reason', $2, true)`,
      [actorUserId, reason],
    );
  }
}
