import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser, TripWithAuthGuard } from '../auth';
import { CreateJoinRequestDto } from './dto/create-join-request.dto';
import { JoinRequestsService } from './join-requests.service';

@Controller({ path: 'events', version: '1' })
@UseGuards(TripWithAuthGuard)
export class EventJoinRequestsController {
  constructor(private readonly requests: JoinRequestsService) {}

  @Post(':eventId/join-requests')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
    @Body() body: CreateJoinRequestDto,
  ) {
    return this.requests.create(user.id, eventId, body);
  }
}

@Controller({ path: 'me/join-requests', version: '1' })
@UseGuards(TripWithAuthGuard)
export class MyJoinRequestsController {
  constructor(private readonly requests: JoinRequestsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.requests.listMine(user.id);
  }

  @Post(':requestId/cancel')
  @HttpCode(200)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('requestId', new ParseUUIDPipe({ version: '4' })) requestId: string,
    @Body() body: unknown,
  ) {
    return this.requests.cancel(user.id, requestId, body);
  }
}

@Controller({ path: 'me/events', version: '1' })
@UseGuards(TripWithAuthGuard)
export class HostJoinRequestsController {
  constructor(private readonly requests: JoinRequestsService) {}

  @Get(':eventId/join-requests')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
  ) {
    return this.requests.listForHost(user.id, eventId);
  }

  @Post(':eventId/join-requests/:requestId/approve')
  @HttpCode(200)
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
    @Param('requestId', new ParseUUIDPipe({ version: '4' })) requestId: string,
    @Body() body: unknown,
  ) {
    return this.requests.approve(user.id, eventId, requestId, body);
  }

  @Post(':eventId/join-requests/:requestId/reject')
  @HttpCode(200)
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
    @Param('requestId', new ParseUUIDPipe({ version: '4' })) requestId: string,
    @Body() body: unknown,
  ) {
    return this.requests.reject(user.id, eventId, requestId, body);
  }
}
