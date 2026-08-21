import { Module } from '@nestjs/common';

import { AuthModule } from '../auth';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { CandidateRepository } from './candidates';
import { FeedCacheModule } from './feed-cache.module';
import { InterestProjectionService } from './interest-projection.service';
import { MatchingController } from './matching.controller';
import { MatchingService } from './matching.service';

@Module({
  imports: [AuthModule, DatabaseModule, RedisModule, FeedCacheModule],
  controllers: [MatchingController],
  providers: [CandidateRepository, InterestProjectionService, MatchingService],
  exports: [InterestProjectionService, MatchingService],
})
export class MatchingModule {}
