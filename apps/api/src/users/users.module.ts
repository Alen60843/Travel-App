import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth';
import {
  InterestEntity,
  UserEntity,
  UserInterestEntity,
  UserProfileEntity,
  UserSettingsEntity,
} from '../database/entities';
import { CurrentUserController, ProvisioningController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [
    AuthModule,
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

