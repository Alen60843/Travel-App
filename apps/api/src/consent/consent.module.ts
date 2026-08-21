import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { ConsentController } from './consent.controller';
import { ConsentPolicyService } from './consent-policy.service';
import { ConsentService } from './consent.service';

@Module({
  imports: [DatabaseModule],
  controllers: [ConsentController],
  providers: [ConsentPolicyService, ConsentService],
  exports: [ConsentPolicyService, ConsentService],
})
export class ConsentModule {}
