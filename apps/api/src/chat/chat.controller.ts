import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser, TripWithAuthGuard } from '../auth';
import { ChatService } from './chat.service';

@Controller({ path: 'chat/rooms', version: '1' })
@UseGuards(TripWithAuthGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get()
  listRooms(@CurrentUser() user: AuthenticatedUser, @Query() query: unknown) {
    return this.chat.listRooms(user.id, query);
  }

  @Get(':roomId/messages')
  history(@CurrentUser() user: AuthenticatedUser, @Param('roomId') roomId: string, @Query() query: unknown) {
    return this.chat.history(user.id, roomId, query);
  }

  @Post(':roomId/messages')
  @HttpCode(200)
  sendMessage(@CurrentUser() user: AuthenticatedUser, @Param('roomId') roomId: string, @Body() body: unknown) {
    return this.chat.sendMessage(user.id, roomId, body);
  }

  @Patch(':roomId/read-cursor')
  advanceReadCursor(@CurrentUser() user: AuthenticatedUser, @Param('roomId') roomId: string, @Body() body: unknown) {
    return this.chat.advanceReadCursor(user.id, roomId, body);
  }
}
