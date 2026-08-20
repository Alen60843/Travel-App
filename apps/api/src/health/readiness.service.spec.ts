import type { LoggerService } from '@nestjs/common';

import type { ReadinessCheck } from './readiness-check.interface';
import { ReadinessService } from './readiness.service';

function healthyCheck(name: string, detail?: string): ReadinessCheck {
  return { name, check: async () => (detail !== undefined ? { healthy: true, detail } : { healthy: true }) };
}

function unhealthyCheck(name: string, detail: string): ReadinessCheck {
  return { name, check: async () => ({ healthy: false, detail }) };
}

function throwingCheck(name: string, message: string): ReadinessCheck {
  return {
    name,
    check: async () => {
      throw new Error(message);
    },
  };
}

describe('ReadinessService', () => {
  it('reports healthy with zero registered checks', async () => {
    const service = new ReadinessService([]);

    const result = await service.evaluate();

    expect(result.healthy).toBe(true);
    expect(result.checks).toEqual([]);
  });

  it('defaults to zero checks when constructed with no arguments (unbound @Optional token)', async () => {
    const service = new ReadinessService();

    const result = await service.evaluate();

    expect(result.healthy).toBe(true);
    expect(result.checks).toEqual([]);
  });

  it('reports healthy when every check is healthy', async () => {
    const service = new ReadinessService([healthyCheck('database'), healthyCheck('redis')]);

    const result = await service.evaluate();

    expect(result.healthy).toBe(true);
    expect(result.checks).toHaveLength(2);
    expect(result.checks.every((c) => c.healthy)).toBe(true);
  });

  it('reports unhealthy and names the failing dependency when one check fails', async () => {
    const service = new ReadinessService([healthyCheck('database'), unhealthyCheck('queue', 'connection refused')]);

    const result = await service.evaluate();

    expect(result.healthy).toBe(false);
    const queueResult = result.checks.find((c) => c.name === 'queue');
    expect(queueResult).toEqual({ name: 'queue', healthy: false, detail: 'connection refused' });
    const dbResult = result.checks.find((c) => c.name === 'database');
    expect(dbResult?.healthy).toBe(true);
  });

  it('treats a check that throws as unhealthy instead of crashing evaluate()', async () => {
    const service = new ReadinessService([throwingCheck('outbox', 'secret internal detail')]);

    const result = await service.evaluate();

    expect(result.healthy).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ name: 'outbox', healthy: false });
  });

  it('does not leak the thrown error message into the check result', async () => {
    const service = new ReadinessService([throwingCheck('outbox', 'ECONNREFUSED 10.0.0.5:5432 secret')]);

    const result = await service.evaluate();

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('ECONNREFUSED');
    expect(serialized).not.toContain('10.0.0.5');
  });

  it('logs the real error server-side (with the logger) when a check throws', async () => {
    const errorSpy = jest.fn();
    const logger: LoggerService = { log: jest.fn(), warn: jest.fn(), error: errorSpy };
    const service = new ReadinessService([throwingCheck('outbox', 'wire failure')], logger);

    await service.evaluate();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message] = errorSpy.mock.calls[0] as unknown[];
    expect(String(message)).toContain('outbox');
  });

  it('runs all checks even when one throws (throwing check does not short-circuit others)', async () => {
    const service = new ReadinessService([throwingCheck('a', 'boom'), healthyCheck('b')]);

    const result = await service.evaluate();

    expect(result.checks).toHaveLength(2);
    expect(result.checks.find((c) => c.name === 'b')?.healthy).toBe(true);
  });
});
