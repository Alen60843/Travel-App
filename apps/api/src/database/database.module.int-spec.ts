import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { ConfigModule } from '../config/config.module';
import { DatabaseModule } from './database.module';
import { DatabaseReadinessCheck } from './database-readiness.check';
import { UserEntity } from './entities';

/**
 * Every other int-spec in this module exercises AppDataSource (the
 * migration-CLI DataSource) directly, which never touches
 * database.module.ts's `TypeOrmModule.forRootAsync` factory — the actual
 * wiring the running application uses. This test boots that factory for
 * real, through Nest's DI container, so a mistake in the
 * AppConfig -> TypeOrmModuleOptions mapping (wrong config key, pool size
 * never applied, etc.) fails here instead of at application boot.
 */
describe('DatabaseModule (real database, real Nest DI)', () => {
  it('wires a working, DI-injectable DataSource and DatabaseReadinessCheck from APP_CONFIG', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, DatabaseModule],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    try {
      const dataSource = moduleRef.get<DataSource>(getDataSourceToken());
      expect(dataSource.isInitialized).toBe(true);
      expect(dataSource.options.synchronize).toBe(false);
      expect(dataSource.options.migrationsRun).toBe(false);

      // The registered entity set actually round-trips a query.
      await dataSource.getRepository(UserEntity).count();

      const readiness = moduleRef.get(DatabaseReadinessCheck);
      await expect(readiness.check()).resolves.toEqual({ healthy: true });
    } finally {
      await app.close();
    }
  });
});
