import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser, TripWithAuthGuard } from '../auth';
import { CreateEventDto, UpdateEventDto } from './dto';
import { EventsService } from './events.service';
import type { EventView } from './events.types';

@Controller({ path: 'me/events', version: '1' })
@UseGuards(TripWithAuthGuard)
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Post()
  createEvent(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateEventDto,
  ): Promise<EventView> {
    return this.eventsService.createEvent(user.id, dto);
  }

  @Get()
  listEvents(@CurrentUser() user: AuthenticatedUser): Promise<readonly EventView[]> {
    return this.eventsService.listEvents(user.id);
  }

  @Get(':eventId')
  getEvent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
  ): Promise<EventView> {
    return this.eventsService.getEvent(user.id, eventId);
  }

  @Patch(':eventId')
  updateEvent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
    @Body() dto: UpdateEventDto,
  ): Promise<EventView> {
    return this.eventsService.updateEvent(user.id, eventId, dto);
  }

  @Post(':eventId/publish')
  @HttpCode(200)
  publishEvent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
  ): Promise<EventView> {
    return this.eventsService.publishEvent(user.id, eventId);
  }

  @Post(':eventId/cancel')
  @HttpCode(200)
  cancelEvent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
  ): Promise<EventView> {
    return this.eventsService.cancelEvent(user.id, eventId);
  }
}
