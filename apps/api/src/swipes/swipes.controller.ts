import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';

import { CurrentUser, TripWithAuthGuard, type AuthenticatedUser } from '../auth';
import { CreateSwipeDto } from './dto/create-swipe.dto';
import { SwipesService } from './swipes.service';
import type { CreateSwipeResult } from './swipes.types';

@Controller({ path: 'matching/swipes', version: '1' })
@UseGuards(TripWithAuthGuard)
export class SwipesController {
  constructor(private readonly swipes: SwipesService) {}

  @Post()
  @HttpCode(200)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateSwipeDto,
  ): Promise<CreateSwipeResult> {
    return this.swipes.create(user.id, dto);
  }
}
