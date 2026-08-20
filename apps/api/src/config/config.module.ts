import { Global, Module } from '@nestjs/common';

import { APP_CONFIG, loadConfig, type AppConfig } from './configuration';

/**
 * Global config module.
 *
 * Configuration is parsed once, eagerly, in the factory below. If it is
 * invalid the factory throws and Nest aborts the bootstrap — the process never
 * reaches a state where it could serve a request with broken configuration.
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => loadConfig(),
    },
  ],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
