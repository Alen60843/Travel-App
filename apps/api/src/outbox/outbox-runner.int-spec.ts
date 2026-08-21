import { randomUUID } from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { WorkerModule } from '../worker.module';

/**
 * Proves the outbox pipeline is OPERATIONAL, not merely implemented.
 *
 * Every other outbox test drives the relay by calling `tick()` directly, which
 * verifies the algorithm but says nothing about whether anything runs it in a
 * deployed process. This test boots the real worker composition root
 * (`WorkerModule`, the same module `worker.ts` boots) and then never touches
 * the relay again — the row must travel
 *
 *     job_outbox → relay poll loop → BullMQ → worker → completed_at
 *
 * entirely on its own. If the relay were not scheduled, or no worker consumed
 * the queue, this test hangs and fails rather than passing on a technicality.
 *
 * That second failure mode is the one that actually bit during Phase 2: the
 * relay published correctly and `published_at` was set, but nothing consumed
 * the queue, so `completed_at` stayed NULL forever. Asserting on
 * `completed_at` rather than `published_at` is the whole point of this file.
 */
describe('outbox relay runner (operational, no manual tick)', () => {
  let context: INestApplicationContext;
  let dataSource: DataSource;
  const dedupeKeys: string[] = [];

  beforeAll(async () => {
    // Poll fast so the test is quick; a unique prefix keeps this run's BullMQ
    // keys away from every other suite sharing the local Redis.
    process.env.OUTBOX_POLL_INTERVAL_MS = '200';
    process.env.OUTBOX_ENABLED = 'true';
    process.env.QUEUE_PREFIX = `runner-${randomUUID().slice(0, 8)}`;

    context = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    dataSource = context.get(DataSource);
  }, 60_000);

  afterAll(async () => {
    if (dataSource?.isInitialized && dedupeKeys.length > 0) {
      await dataSource.query(`DELETE FROM job_outbox WHERE dedupe_key = ANY($1)`, [dedupeKeys]);
    }
    await context?.close();
  }, 60_000);

  async function waitForCompletion(dedupeKey: string, timeoutMs = 20_000): Promise<{
    published: boolean;
    completed: boolean;
  }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = (await dataSource.query(
        `SELECT published_at, completed_at FROM job_outbox WHERE dedupe_key = $1`,
        [dedupeKey],
      )) as Array<{ published_at: Date | null; completed_at: Date | null }>;

      const row = rows[0];
      if (row?.completed_at) {
        return { published: row.published_at !== null, completed: true };
      }
      if (Date.now() > deadline) {
        return { published: (row?.published_at ?? null) !== null, completed: false };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  it('carries a committed intent all the way to acknowledgement with no manual tick', async () => {
    const dedupeKey = `infra.echo.${randomUUID()}`;
    dedupeKeys.push(dedupeKey);

    // Written the way real domain code will write it: inside a transaction,
    // so the business change and the job intent commit together.
    await dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO job_outbox (topic, payload, dedupe_key) VALUES ($1, $2::jsonb, $3)`,
        ['infra.echo', JSON.stringify({ probe: 'runner' }), dedupeKey],
      );
    });

    const result = await waitForCompletion(dedupeKey);

    expect(result.published).toBe(true);
    // The assertion that matters: something consumed the job and wrote back.
    expect(result.completed).toBe(true);
  }, 40_000);

  it('drains a backlog of intents without manual intervention', async () => {
    const keys = Array.from({ length: 5 }, () => `infra.echo.${randomUUID()}`);
    dedupeKeys.push(...keys);

    await dataSource.transaction(async (manager) => {
      for (const key of keys) {
        await manager.query(
          `INSERT INTO job_outbox (topic, payload, dedupe_key) VALUES ($1, $2::jsonb, $3)`,
          ['infra.echo', JSON.stringify({ probe: 'backlog' }), key],
        );
      }
    });

    const results = await Promise.all(keys.map((key) => waitForCompletion(key)));
    expect(results.every((r) => r.completed)).toBe(true);
  }, 60_000);

  it('acknowledges exactly once even though delivery is at-least-once', async () => {
    const dedupeKey = `infra.echo.${randomUUID()}`;
    dedupeKeys.push(dedupeKey);

    await dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO job_outbox (topic, payload, dedupe_key) VALUES ($1, $2::jsonb, $3)`,
        ['infra.echo', JSON.stringify({ probe: 'once' }), dedupeKey],
      );
    });

    // Assert completion FIRST. Without this the timestamp comparison below
    // compares null to null and passes even when nothing ever consumed the
    // job — which is precisely the failure this suite exists to catch.
    const outcome = await waitForCompletion(dedupeKey);
    expect(outcome.completed).toBe(true);

    const first = (await dataSource.query(
      `SELECT completed_at FROM job_outbox WHERE dedupe_key = $1`,
      [dedupeKey],
    )) as Array<{ completed_at: Date }>;
    expect(first[0]?.completed_at).not.toBeNull();

    // Give the relay several more poll cycles. A completed row must never be
    // re-claimed, so the acknowledgement timestamp must not move.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const second = (await dataSource.query(
      `SELECT completed_at, publish_attempts FROM job_outbox WHERE dedupe_key = $1`,
      [dedupeKey],
    )) as Array<{ completed_at: Date; publish_attempts: number }>;

    expect(second[0]?.completed_at).toEqual(first[0]?.completed_at);
    expect(Number(second[0]?.publish_attempts)).toBe(1);
  }, 60_000);
});

/**
 * Shutdown is verified in its own context because closing the application is
 * destructive — the suite above still needs its relay running.
 */
describe('outbox relay runner shutdown', () => {
  it('closes the worker context cleanly, stopping the relay and its workers', async () => {
    process.env.OUTBOX_POLL_INTERVAL_MS = '200';
    process.env.QUEUE_PREFIX = `runner-shutdown-${randomUUID().slice(0, 8)}`;

    const context = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    const dataSource = context.get(DataSource);
    expect(dataSource.isInitialized).toBe(true);

    // Let the loop run a few cycles so shutdown is exercised against a live
    // relay rather than one that never started.
    await new Promise((resolve) => setTimeout(resolve, 600));

    await expect(context.close()).resolves.toBeUndefined();

    // Closing must have torn down the pool; a relay still polling after
    // shutdown would keep this true and leak a connection per instance.
    expect(dataSource.isInitialized).toBe(false);
  }, 60_000);
});
