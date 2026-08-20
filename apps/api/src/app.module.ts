import { Module } from '@nestjs/common';

import { ConfigModule } from './config/config.module';

/**
 * Root module — the integration point, owned by the Lead.
 *
 * Phase 2 wires infrastructure only. Domain modules arrive in later phases and
 * must not be imported here before their phase.
 */
@Module({
  imports: [ConfigModule],
})
export class AppModule {}
