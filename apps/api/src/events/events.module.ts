import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth';
import { EventCategoryEntity, EventEntity } from '../database/entities';
import { GeoService } from '../database/geo';
import { EventsController } from './events.controller';
import { EventsRepository } from './events.repository';
import { EventsService } from './events.service';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([EventEntity, EventCategoryEntity])],
  controllers: [EventsController],
  providers: [GeoService, EventsRepository, EventsService],
  exports: [EventsService],
})
export class EventsModule {}
