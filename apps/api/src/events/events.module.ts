import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth';
import { EventCategoryEntity, EventEntity } from '../database/entities';
import { GeoService } from '../database/geo';
import { EventChatController } from './event-chat.controller';
import { EventChatService } from './event-chat.service';
import { EventsController } from './events.controller';
import { EventsRepository } from './events.repository';
import { EventsService } from './events.service';
import { EventJoinRequestsController, HostJoinRequestsController, MyJoinRequestsController } from './join-requests.controller';
import { JoinRequestsService } from './join-requests.service';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([EventEntity, EventCategoryEntity])],
  controllers: [EventsController, EventJoinRequestsController, HostJoinRequestsController, MyJoinRequestsController, EventChatController],
  providers: [GeoService, EventsRepository, EventsService, JoinRequestsService, EventChatService],
  exports: [EventsService, EventChatService],
})
export class EventsModule {}
