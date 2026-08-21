import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { DataSource } from 'typeorm';
import { loadConfig, type AppConfig } from '../config/configuration';
import {
  createQueueRedisConnection,
  createWorkerRedisConnection,
} from '../redis/redis-connection.factory';
import { closeRedisGracefully } from '../redis/redis-lifecycle.service';
import { QueueRegistry } from '../queue/queue-registry.service';
import { closeWorkerGracefully, createWorker } from '../queue/worker.factory';
import { INFRA_ECHO_TOPIC, type InfraEchoPayload } from '../queue/jobs/infra-echo.job';
import { createTestDataSource } from './test-support/data-source';
import { EffectCounterRegistry } from './effect-counter.registry';
import { OutboxAcknowledger } from './outbox-acknowledger.service';
import { OutboxEnqueuer } from './outbox-enqueuer.service';
import { OutboxMetrics } from './outbox-metrics';
import { OutboxRelay } from './outbox-relay.service';
import { createInfraEchoProcessor } from './infra-echo.processor';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Proves the whole pipeline from §6.1 end to end, using the harmless
 * `infra.echo` job (item 5 of the brief) as the vehicle:
 *
 *   PostgreSQL job_outbox -> at-least-once relay -> BullMQ -> idempotent
 *   consumer -> consumer acknowledgement (completed_at)
 *
 * Every scenario here uses REAL PostgreSQL (tripwith_b) and REAL Redis
 * (queue instance on :6399, `agentb`-prefixed). Nothing is mocked.
 */
describe('outbox pipeline end to end (integration)', () => {
  const baseConfig = loadConfig(process.env);
  let dataSource: DataSource;
  let connection: ReturnType<typeof createQueueRedisConnection>;
  let registry: QueueRegistry;
  const enqueuer = new OutboxEnqueuer();
  const metrics = new OutboxMetrics();
  const acknowledger = new OutboxAcknowledger(metrics);
  const effects = new EffectCounterRegistry();
  const usedTopics = new Set<string>();
  // Same reasoning as outbox-relay.int-spec.ts: relay.tick() claims across
  // the WHOLE job_outbox table with no topic filter (correct production
  // behaviour), so a row left behind by an earlier test in this file is fair
  // game for a later test's tick(). Track and purge each test's own rows so
  // "first claim of this test" reliably means exactly that.
  let currentTestTopics = new Set<string>();

  function withLease(leaseMs: number): AppConfig {
    return { ...baseConfig, outbox: { ...baseConfig.outbox, leaseMs } };
  }

  function testTopic(label: string): string {
    const topic = `${INFRA_ECHO_TOPIC}.test.${label}.${randomUUID()}`;
    usedTopics.add(topic);
    currentTestTopics.add(topic);
    return topic;
  }

  async function waitForCompletedAt(dedupeKey: string, timeoutMs = 10_000): Promise<Date> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = (await dataSource.query(`SELECT completed_at FROM job_outbox WHERE dedupe_key = $1`, [
        dedupeKey,
      ])) as Array<{ completed_at: Date | null }>;
      const completedAt = rows[0]?.completed_at ?? null;
      if (completedAt) return completedAt;
      if (Date.now() > deadline) throw new Error(`timed out waiting for completed_at on ${dedupeKey}`);
      await sleep(25);
    }
  }

  beforeAll(async () => {
    dataSource = createTestDataSource();
    await dataSource.initialize();
    connection = createQueueRedisConnection(baseConfig);
    registry = new QueueRegistry(connection, baseConfig);
  });

  afterEach(async () => {
    if (currentTestTopics.size > 0) {
      await dataSource.query(`DELETE FROM job_outbox WHERE topic = ANY($1::text[])`, [
        Array.from(currentTestTopics),
      ]);
    }
    currentTestTopics = new Set<string>();
  });

  afterAll(async () => {
    for (const topic of usedTopics) {
      try {
        await registry.getQueue(topic).obliterate({ force: true });
      } catch {
        // best-effort cleanup
      }
    }
    await dataSource.query(`DELETE FROM job_outbox WHERE topic LIKE $1`, [`${INFRA_ECHO_TOPIC}.test.%`]);
    await registry.onModuleDestroy();
    await connection.quit();
    await dataSource.destroy();
  });

  it('full path: transactional enqueue -> relay publish -> worker processes -> completed_at persisted', async () => {
    const topic = testTopic('full-path');
    const dedupeKey = `${topic}.${randomUUID()}`;
    const effectKey = `effect.${randomUUID()}`;

    const workerConnection = createWorkerRedisConnection(baseConfig);
    const worker = createWorker<InfraEchoPayload, void>(workerConnection, baseConfig, {
      name: topic,
      processor: createInfraEchoProcessor(dataSource, acknowledger, effects),
    });

    try {
      await worker.waitUntilReady();

      // The business change and the job intent commit atomically — this IS
      // the transaction, not a stand-in for one.
      await dataSource.transaction(async (manager) => {
        const result = await enqueuer.enqueue(manager, {
          topic,
          dedupeKey,
          payload: { message: 'full path', effectKey } satisfies InfraEchoPayload,
        });
        expect(result.inserted).toBe(true);
      });

      const relay = new OutboxRelay(dataSource, registry, metrics, withLease(60_000));
      const claimed = await relay.tick();
      expect(claimed).toBe(1);

      await waitForCompletedAt(dedupeKey);
      expect(effects.get(effectKey)).toBe(1);
    } finally {
      await closeWorkerGracefully(worker, 5_000);
      await closeRedisGracefully(workerConnection, 'full-path test worker', 2_000);
    }
  }, 20_000);

  it('redelivery is idempotent: the consumer applies the effect exactly once even when it runs twice for the same dedupe_key', async () => {
    const topic = testTopic('redelivery');
    const dedupeKey = `${topic}.${randomUUID()}`;
    const effectKey = `effect.${randomUUID()}`;

    await dataSource.transaction(async (manager) => {
      await enqueuer.enqueue(manager, {
        topic,
        dedupeKey,
        payload: { message: 'redelivery', effectKey } satisfies InfraEchoPayload,
      });
    });

    // Publish for real first — job_outbox_ack_requires_publish_chk forbids
    // completed_at on a row that was never published, and that constraint is
    // correct: acknowledging work that was never dispatched makes no sense.
    const relay = new OutboxRelay(dataSource, registry, metrics, withLease(60_000));
    await relay.tick();

    const processor = createInfraEchoProcessor(dataSource, acknowledger, effects);
    const fakeJob = { id: dedupeKey, data: { message: 'redelivery', effectKey } } as Job<InfraEchoPayload, void>;

    // First run: genuinely applies the effect and acknowledges.
    await processor(fakeJob);
    expect(effects.get(effectKey)).toBe(1);
    const row1 = await waitForCompletedAt(dedupeKey);
    expect(row1).toBeInstanceOf(Date);

    // Second run: same dedupe_key, processor invoked again directly — this
    // is deliberately NOT going through BullMQ's own jobId collapsing
    // (queue.add() with an existing id would usually no-op before the
    // processor ever runs again). Invoking the processor function itself
    // proves the CONSUMER's own idempotency guard — the completed_at check
    // in infra-echo.processor.ts — independently of whatever protection
    // BullMQ's queue layer happens to provide. This is the scenario that
    // matters when Redis genuinely redelivers a job whose outbox row was
    // already acknowledged (e.g. a stalled-job recovery).
    await processor(fakeJob);

    // The assertion that actually matters: the EFFECT counter, not merely
    // "no error was thrown".
    expect(effects.get(effectKey)).toBe(1);
  });

  it('re-drive after simulated total Redis loss: relay re-publishes an unacknowledged row and it completes', async () => {
    const topic = testTopic('redis-loss');
    const dedupeKey = `${topic}.${randomUUID()}`;
    const effectKey = `effect.${randomUUID()}`;

    await dataSource.transaction(async (manager) => {
      await enqueuer.enqueue(manager, {
        topic,
        dedupeKey,
        payload: { message: 'redis loss', effectKey } satisfies InfraEchoPayload,
      });
    });

    const shortLeaseMetrics = new OutboxMetrics();
    const relay = new OutboxRelay(dataSource, registry, shortLeaseMetrics, withLease(150));

    // Publish, with no worker attached yet, so the job sits unacknowledged.
    const firstClaim = await relay.tick();
    expect(firstClaim).toBe(1);
    expect((await dataSource.query(`SELECT completed_at FROM job_outbox WHERE dedupe_key = $1`, [dedupeKey])) as unknown[]).toHaveLength(1);

    // Simulate TOTAL loss of this job from Redis — scoped to this test's own
    // queue, never a blanket FLUSHALL/FLUSHDB on the shared instance.
    await registry.getQueue(topic).obliterate({ force: true });
    expect(await registry.getQueue(topic).getJob(dedupeKey)).toBeUndefined();

    // Let the lease lapse, then start the worker that will actually process
    // the re-drive.
    await sleep(300);
    const workerConnection = createWorkerRedisConnection(baseConfig);
    const worker = createWorker<InfraEchoPayload, void>(workerConnection, baseConfig, {
      name: topic,
      processor: createInfraEchoProcessor(dataSource, acknowledger, effects),
    });

    try {
      await worker.waitUntilReady();

      const secondClaim = await relay.tick();
      expect(secondClaim).toBe(1);
      expect(shortLeaseMetrics.snapshot().redrive).toBe(1);

      await waitForCompletedAt(dedupeKey);
      expect(effects.get(effectKey)).toBe(1); // ran exactly once despite the redrive
    } finally {
      await closeWorkerGracefully(worker, 5_000);
      await closeRedisGracefully(workerConnection, 'redrive test worker', 2_000);
    }
  }, 20_000);

  it('graceful shutdown: relay loop, worker, queue and redis connections all close cleanly with no leaked handles', async () => {
    const topic = testTopic('shutdown');
    const localConnection = createQueueRedisConnection(baseConfig);
    const localWorkerConnection = createWorkerRedisConnection(baseConfig);
    const localRegistry = new QueueRegistry(localConnection, baseConfig);
    const localMetrics = new OutboxMetrics();
    const relay = new OutboxRelay(dataSource, localRegistry, localMetrics, withLease(60_000));
    const worker = createWorker<InfraEchoPayload, void>(localWorkerConnection, baseConfig, {
      name: topic,
      processor: createInfraEchoProcessor(dataSource, acknowledger, effects),
    });

    try {
      await worker.waitUntilReady();
      relay.start();

      const dedupeKey = `${topic}.${randomUUID()}`;
      await dataSource.transaction(async (manager) => {
        await enqueuer.enqueue(manager, {
          topic,
          dedupeKey,
          payload: { message: 'shutdown', effectKey: `effect.${randomUUID()}` } satisfies InfraEchoPayload,
        });
      });
      await waitForCompletedAt(dedupeKey);

      // Shutdown sequence, mirroring Nest's own destroy order: relay loop
      // first (stop claiming new work), then the worker (let in-flight jobs
      // finish, bounded), then queue connections, then the raw redis
      // connection itself (RedisLifecycleService.closeGracefully's own
      // logic, exercised directly on one connection here — its two-connection
      // case is covered in redis.int-spec.ts).
      await relay.onModuleDestroy();
      await closeWorkerGracefully(worker, 5_000);
      await closeRedisGracefully(localWorkerConnection, 'shutdown test worker', 2_000);
      await localRegistry.onModuleDestroy();

      // ioredis's `quit()` promise resolves once the QUIT reply is read, but
      // `.status` flips to 'end' off the socket's own 'end' event a tick
      // later — attach the listener BEFORE calling quit() to avoid racing it.
      const closed = new Promise<void>((resolve) => localConnection.once('end', () => resolve()));
      await localConnection.quit();
      await closed;

      expect(localConnection.status).toBe('end');
    } finally {
      if (localConnection.status !== 'end') {
        localConnection.disconnect();
      }
      if (localWorkerConnection.status !== 'end') {
        localWorkerConnection.disconnect();
      }
    }
  }, 20_000);
});
