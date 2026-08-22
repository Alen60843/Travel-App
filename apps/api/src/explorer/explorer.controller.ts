import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { CurrentUser, TripWithAuthGuard, type AuthenticatedUser } from '../auth';
import { GetExplorerEventsQueryDto } from './dto/get-explorer-events-query.dto';
import { ExplorerService } from './explorer.service';
import type { ExplorerEventsView } from './explorer.types';

@Controller({ path: 'explorer', version: '1' })
@UseGuards(TripWithAuthGuard)
export class ExplorerController {
  constructor(private readonly explorer: ExplorerService) {}

  @Get('events')
  getEvents(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GetExplorerEventsQueryDto,
  ): Promise<ExplorerEventsView> {
    return this.explorer.discoverEvents(user.id, query);
  }
}
