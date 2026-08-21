import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { ConsentModule } from '../consent/consent.module';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  imports: [DatabaseModule, ConsentModule],
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
