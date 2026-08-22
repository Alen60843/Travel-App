import { Module } from '@nestjs/common';

import { AuthModule } from '../auth';
import { DatabaseModule } from '../database/database.module';
import { GeoService } from '../database/geo';
import { ExplorerController } from './explorer.controller';
import { ExplorerRepository } from './explorer.repository';
import { ExplorerService } from './explorer.service';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [ExplorerController],
  providers: [GeoService, ExplorerRepository, ExplorerService],
  exports: [ExplorerService],
})
export class ExplorerModule {}
