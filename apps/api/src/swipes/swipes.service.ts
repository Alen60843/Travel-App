import { Injectable } from '@nestjs/common';

import type { CreateSwipeDto } from './dto/create-swipe.dto';
import { FeedGenerationService } from '../matching/feed-generation.service';
import { SelfSwipeError } from './swipes.errors';
import { SwipesRepository } from './swipes.repository';
import type { CreateSwipeResult } from './swipes.types';

@Injectable()
export class SwipesService {
  constructor(
    private readonly swipes: SwipesRepository,
    private readonly feedGeneration?: FeedGenerationService,
  ) {}

  async create(sourceUserId: string, dto: CreateSwipeDto): Promise<CreateSwipeResult> {
    if (sourceUserId === dto.targetUserId) throw new SelfSwipeError();

    const result = await this.swipes.persist(sourceUserId, dto.targetUserId, dto.direction);
    await this.feedGeneration?.bump(sourceUserId);
    return {
      swipe: {
        id: result.swipe.id,
        targetUserId: result.swipe.targetUserId,
        direction: result.swipe.direction,
        createdAt: result.swipe.createdAt.toISOString(),
      },
      match: result.match
        ? {
            id: result.match.id,
            chatRoomId: result.match.chatRoomId,
            matchedAt: result.match.matchedAt.toISOString(),
          }
        : null,
    };
  }
}
