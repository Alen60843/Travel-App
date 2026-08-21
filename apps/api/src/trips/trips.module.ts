import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth';
import { TripEntity, TripSegmentEntity } from '../database/entities';
import { GeoService } from '../database/geo';
import { FeedCacheModule } from '../matching/feed-cache.module';
import { TripsController } from './trips.controller';
import { TripsRepository } from './trips.repository';
import { TripsService } from './trips.service';

@Module({
  imports: [
    AuthModule,
    FeedCacheModule,
    TypeOrmModule.forFeature([TripEntity, TripSegmentEntity]),
  ],
  controllers: [TripsController],
  providers: [GeoService, TripsRepository, TripsService],
  exports: [TripsService],
})
export class TripsModule {}
