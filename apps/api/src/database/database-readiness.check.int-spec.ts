import { AppDataSource } from './data-source';
import { DatabaseReadinessCheck } from './database-readiness.check';

describe('DatabaseReadinessCheck (real database)', () => {
  beforeAll(async () => {
    await AppDataSource.initialize();
  });

  afterAll(async () => {
    await AppDataSource.destroy();
  });

  it('exposes the ReadinessCheck contract', () => {
    const check = new DatabaseReadinessCheck(AppDataSource);
    expect(check.name).toBe('database');
    expect(typeof check.check).toBe('function');
  });

  it('reports healthy when the connection works and PostGIS is installed', async () => {
    const check = new DatabaseReadinessCheck(AppDataSource);
    await expect(check.check()).resolves.toEqual({ healthy: true });
  });

  it('confirms PostGIS is actually present via a direct query (sanity check on the test DB itself)', async () => {
    const rows: { extname: string }[] = await AppDataSource.query(
      "SELECT extname FROM pg_extension WHERE extname = 'postgis'",
    );
    expect(rows).toHaveLength(1);
  });
});
