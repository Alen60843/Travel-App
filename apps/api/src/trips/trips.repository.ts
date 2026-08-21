import { Injectable } from '@nestjs/common';
import type { DeepPartial, EntityManager } from 'typeorm';
import { DataSource } from 'typeorm';

import { TripEntity, TripSegmentEntity } from '../database/entities';

@Injectable()
export class TripsRepository {
  constructor(private readonly dataSource: DataSource) {}

  transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(work);
  }

  async findOwnedTrips(userId: string): Promise<TripEntity[]> {
    return this.dataSource
      .getRepository(TripEntity)
      .createQueryBuilder('trip')
      .leftJoinAndSelect('trip.segments', 'segment')
      .where('trip.user_id = :userId', { userId })
      .orderBy('trip.start_date', 'DESC')
      .addOrderBy('trip.id', 'ASC')
      .addOrderBy('segment.sort_order', 'ASC')
      .addOrderBy('segment.start_date', 'ASC')
      .addOrderBy('segment.id', 'ASC')
      .getMany();
  }

  async findOwnedTrip(
    manager: EntityManager,
    userId: string,
    tripId: string,
    lock = false,
  ): Promise<TripEntity | null> {
    const query = manager
      .getRepository(TripEntity)
      .createQueryBuilder('trip')
      .where('trip.id = :tripId AND trip.user_id = :userId', { tripId, userId });
    if (lock) query.setLock('pessimistic_write');
    return query.getOne();
  }

  async findOwnedTripWithSegments(userId: string, tripId: string): Promise<TripEntity | null> {
    return this.dataSource
      .getRepository(TripEntity)
      .createQueryBuilder('trip')
      .leftJoinAndSelect('trip.segments', 'segment')
      .where('trip.id = :tripId AND trip.user_id = :userId', { tripId, userId })
      .orderBy('segment.sort_order', 'ASC')
      .addOrderBy('segment.start_date', 'ASC')
      .addOrderBy('segment.id', 'ASC')
      .getOne();
  }

  async findSegments(
    manager: EntityManager,
    userId: string,
    tripId: string,
    lock = false,
  ): Promise<TripSegmentEntity[]> {
    const query = manager
      .getRepository(TripSegmentEntity)
      .createQueryBuilder('segment')
      .where('segment.trip_id = :tripId AND segment.user_id = :userId', { tripId, userId })
      .orderBy('segment.sort_order', 'ASC')
      .addOrderBy('segment.start_date', 'ASC')
      .addOrderBy('segment.id', 'ASC');
    if (lock) query.setLock('pessimistic_write');
    return query.getMany();
  }

  createTrip(manager: EntityManager, values: DeepPartial<TripEntity>): TripEntity {
    return manager.getRepository(TripEntity).create(values);
  }

  saveTrip(manager: EntityManager, trip: TripEntity): Promise<TripEntity> {
    return manager.getRepository(TripEntity).save(trip);
  }

  deleteTrip(manager: EntityManager, trip: TripEntity): Promise<TripEntity> {
    return manager.getRepository(TripEntity).remove(trip);
  }

  createSegment(manager: EntityManager, values: DeepPartial<TripSegmentEntity>): TripSegmentEntity {
    return manager.getRepository(TripSegmentEntity).create(values);
  }

  async saveSegments(
    manager: EntityManager,
    segments: TripSegmentEntity[],
  ): Promise<TripSegmentEntity[]> {
    // TypeORM persists an entity array's UPDATE subjects with Promise.all on
    // one transaction client. pg 8 warns about that concurrent-query usage
    // and pg 9 will reject it. Ordering is part of this aggregate's invariant,
    // so deliberately issue each write in sequence on the transaction client.
    const repository = manager.getRepository(TripSegmentEntity);
    const saved: TripSegmentEntity[] = [];
    for (const segment of segments) {
      saved.push(await repository.save(segment));
    }
    return saved;
  }

  deleteSegment(manager: EntityManager, segment: TripSegmentEntity): Promise<TripSegmentEntity> {
    return manager.getRepository(TripSegmentEntity).remove(segment);
  }
}
