import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth';
import { ConsentModule } from '../consent';
import {
  InterestEntity,
  UserEntity,
  UserInterestEntity,
  UserProfileEntity,
  UserSettingsEntity,
} from '../database/entities';
import { FeedCacheModule } from '../matching/feed-cache.module';
import { CurrentUserController, ProvisioningController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [
    AuthModule,
    ConsentModule,
    FeedCacheModule,
    TypeOrmModule.forFeature([
      UserEntity,
      UserProfileEntity,
      UserSettingsEntity,
      InterestEntity,
      UserInterestEntity,
    ]),
  ],
  controllers: [ProvisioningController, CurrentUserController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
