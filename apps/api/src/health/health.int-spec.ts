import { Global, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { CorrelationMiddleware } from '../common/middleware/correlation.middleware';
import { HealthModule } from './health.module';
import { READINESS_CHECK, type ReadinessCheck } from './readiness-check.interface';

/**
 * Mirrors the wiring the Lead does in app.module.ts: a small `@Global()`
 * module binds a concrete array to `READINESS_CHECK` so HealthModule's
 * `@Optional()` injection picks it up without importing anything itself.
 * See health.module.ts for why this has to be `@Global()`.
 */
function readinessRegistryModule(checks: ReadinessCheck[]) {
  @Global()
  @Module({
    providers: [{ provide: READINESS_CHECK, useValue: checks }],
    exports: [READINESS_CHECK],
  })
  class TestReadinessRegistryModule {}
  return TestReadinessRegistryModule;
}

async function buildApp(checks: ReadinessCheck[]): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [readinessRegistryModule(checks), HealthModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  // Same correlation middleware main.ts installs app-wide — proving the real
  // pipeline behaviour (id echoed back), not a mocked stand-in.
  const correlation = new CorrelationMiddleware();
  app.use((req: never, res: never, next: (err?: unknown) => void) => correlation.use(req, res, next));
  await app.init();
  return app;
}

describe('Health endpoints (integration)', () => {
  let apps: INestApplication[] = [];

  afterEach(async () => {
    await Promise.all(apps.map((app) => app.close()));
    apps = [];
  });

  async function appWithChecks(checks: ReadinessCheck[]): Promise<INestApplication> {
    const app = await buildApp(checks);
    apps.push(app);
    return app;
  }

  it('GET /health/live returns 200 and does not depend on registered checks', async () => {
    const app = await appWithChecks([{ name: 'db', check: async () => ({ healthy: false, detail: 'down' }) }]);

    const res = await request(app.getHttpServer()).get('/health/live');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /health/live stays 200 even when a readiness check throws', async () => {
    const app = await appWithChecks([
      {
        name: 'db',
        check: async () => {
          throw new Error('connection reset');
        },
      },
    ]);

    const res = await request(app.getHttpServer()).get('/health/live');

    expect(res.status).toBe(200);
  });

  it('GET /health/ready returns 200 with a breakdown when every check is healthy', async () => {
    const app = await appWithChecks([
      { name: 'database', check: async () => ({ healthy: true }) },
      { name: 'redis', check: async () => ({ healthy: true, detail: 'PONG' }) },
    ]);

    const res = await request(app.getHttpServer()).get('/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks).toEqual(
      expect.arrayContaining([
        { name: 'database', healthy: true },
        { name: 'redis', healthy: true, detail: 'PONG' },
      ]),
    );
  });

  it('GET /health/ready returns 200 with an empty breakdown when zero checks are registered', async () => {
    const app = await appWithChecks([]);

    const res = await request(app.getHttpServer()).get('/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual([]);
  });

  it('GET /health/ready returns 503 and names the failing dependency when one check is unhealthy', async () => {
    const app = await appWithChecks([
      { name: 'database', check: async () => ({ healthy: true }) },
      { name: 'queue', check: async () => ({ healthy: false, detail: 'connection refused' }) },
    ]);

    const res = await request(app.getHttpServer()).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.checks).toEqual(
      expect.arrayContaining([{ name: 'queue', healthy: false, detail: 'connection refused' }]),
    );
  });

  it('GET /health/ready returns 503 (not a crash) when a check throws', async () => {
    const app = await appWithChecks([
      {
        name: 'outbox',
        check: async () => {
          throw new Error('secret internal wiring detail');
        },
      },
    ]);

    const res = await request(app.getHttpServer()).get('/health/ready');

    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain('secret internal wiring detail');
  });

  it('echoes a client-supplied correlation id back on the response header', async () => {
    const app = await appWithChecks([]);

    const res = await request(app.getHttpServer())
      .get('/health/live')
      .set('x-correlation-id', 'integration-test-corr-id');

    expect(res.headers['x-correlation-id']).toBe('integration-test-corr-id');
  });

  it('generates and echoes a correlation id when the client sends none', async () => {
    const app = await appWithChecks([]);

    const res = await request(app.getHttpServer()).get('/health/ready');

    expect(res.headers['x-correlation-id']).toEqual(expect.any(String));
    expect((res.headers['x-correlation-id'] as string).length).toBeGreaterThan(0);
  });
});
