import { Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser, TripWithAuthGuard } from '../auth';
import { EventChatService } from './event-chat.service';

@Controller({ path: 'events', version: '1' })
@UseGuards(TripWithAuthGuard)
export class EventChatController {
  constructor(private readonly chat: EventChatService) {}

  @Post(':eventId/chat-room')
  @HttpCode(200)
  resolveRoom(
    @CurrentUser() user: AuthenticatedUser,
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
  ) {
    return this.chat.resolveRoom(user.id, eventId);
  }
}
