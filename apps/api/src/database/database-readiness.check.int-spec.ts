import { AppDataSource } from './data-source';
import { loadConfig, type AppConfig } from '../config/configuration';
import { DatabaseReadinessCheck } from './database-readiness.check';
import type { DataSource } from 'typeorm';

describe('DatabaseReadinessCheck (real database)', () => {
  const config = loadConfig(process.env);
  beforeAll(async () => {
    await AppDataSource.initialize();
  });

  afterAll(async () => {
    await AppDataSource.destroy();
  });

  it('exposes the ReadinessCheck contract', () => {
    const check = new DatabaseReadinessCheck(AppDataSource, config);
    expect(check.name).toBe('database');
    expect(typeof check.check).toBe('function');
  });

  it('reports healthy when the connection works and PostGIS is installed', async () => {
    const check = new DatabaseReadinessCheck(AppDataSource, config);
    await expect(check.check()).resolves.toEqual({ healthy: true });
  });

  it('confirms PostGIS is actually present via a direct query (sanity check on the test DB itself)', async () => {
    const rows: { extname: string }[] = await AppDataSource.query(
      "SELECT extname FROM pg_extension WHERE extname = 'postgis'",
    );
    expect(rows).toHaveLength(1);
  });

  it('coalesces a hung database probe so repeated readiness calls cannot exhaust the pool', async () => {
    const query = jest.fn(() => new Promise<never>(() => undefined));
    const hangingDataSource = { query } as unknown as DataSource;
    const fastConfig: AppConfig = {
      ...config,
      app: { ...config.app, dependencyCheckTimeoutMs: 25 },
    };
    const check = new DatabaseReadinessCheck(hangingDataSource, fastConfig);

    const [first, second] = await Promise.all([check.check(), check.check()]);

    expect(first.healthy).toBe(false);
    expect(second.healthy).toBe(false);
    expect(first.detail).toContain('database readiness probe timed out');
    expect(query).toHaveBeenCalledTimes(1);
  });
});
