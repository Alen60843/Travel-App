import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { ConsentController } from './consent.controller';
import { ConsentService } from './consent.service';

@Module({
  imports: [DatabaseModule],
  controllers: [ConsentController],
  providers: [ConsentService],
  exports: [ConsentService],
})
export class ConsentModule {}
