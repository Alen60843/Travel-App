import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { ConsentModule } from '../consent/consent.module';
import { FeedCacheModule } from '../matching/feed-cache.module';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  imports: [DatabaseModule, ConsentModule, FeedCacheModule],
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
