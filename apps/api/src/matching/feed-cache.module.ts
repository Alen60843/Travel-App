import { Module } from '@nestjs/common';

import { RedisModule } from '../redis/redis.module';
import { FeedGenerationService } from './feed-generation.service';

/** Small acyclic module shared by matching-affecting mutation modules. */
@Module({
  imports: [RedisModule],
  providers: [FeedGenerationService],
  exports: [FeedGenerationService],
})
export class FeedCacheModule {}
