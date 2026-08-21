import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { CurrentUser, TripWithAuthGuard, type AuthenticatedUser } from '../auth';
import { GetMatchingFeedQueryDto } from './dto/get-matching-feed-query.dto';
import { MatchingService } from './matching.service';
import type { MatchingFeedView } from './matching.types';

@Controller({ path: 'matching', version: '1' })
@UseGuards(TripWithAuthGuard)
export class MatchingController {
  constructor(private readonly matching: MatchingService) {}

  @Get('feed')
  getFeed(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GetMatchingFeedQueryDto,
  ): Promise<MatchingFeedView> {
    return this.matching.getFeed(user.id, query);
  }
}
