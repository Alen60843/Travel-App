import { Module } from '@nestjs/common';

import { AuthModule } from '../auth';
import { ConsentModule } from '../consent/consent.module';
import { DatabaseModule } from '../database/database.module';
import { FeedCacheModule } from '../matching/feed-cache.module';
import { MatchingModule } from '../matching/matching.module';
import { SwipesController } from './swipes.controller';
import { SwipesRepository } from './swipes.repository';
import { SwipesService } from './swipes.service';

@Module({
  imports: [AuthModule, ConsentModule, DatabaseModule, FeedCacheModule, MatchingModule],
  controllers: [SwipesController],
  providers: [SwipesRepository, SwipesService],
  exports: [SwipesService],
})
export class SwipesModule {}
