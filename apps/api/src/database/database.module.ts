import { Module } from '@nestjs/common';
import { TypeOrmModule, type TypeOrmModuleOptions } from '@nestjs/typeorm';

import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { DatabaseReadinessCheck } from './database-readiness.check';
import { entities } from './entities';

/**
 * Wires the application's PostgreSQL connection through Nest's DI.
 *
 * Configuration is read from APP_CONFIG (ConfigModule is @Global(), so no
 * import of it is needed here) rather than process.env directly, keeping a
 * single validated source of truth for every value — see
 * ../config/configuration.ts.
 *
 * `synchronize: false` / `migrationsRun: false` for the same reason as
 * data-source.ts: the schema is owned by the reviewed SQL migration, never
 * by entity introspection or an implicit run on boot.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): TypeOrmModuleOptions => ({
        type: 'postgres',
        host: config.database.host,
        port: config.database.port,
        username: config.database.username,
        password: config.database.password,
        database: config.database.database,
        ssl: config.database.ssl,
        extra: { options: config.database.connectionOptions },

        synchronize: false,
        migrationsRun: false,
        logging: config.database.logging,

        // Pool size, not query timeout — maps to node-postgres Pool's `max`.
        poolSize: config.database.poolMax,

        entities: [...entities],
      }),
    }),
  ],
  providers: [DatabaseReadinessCheck],
  exports: [TypeOrmModule, DatabaseReadinessCheck],
})
export class DatabaseModule {}
