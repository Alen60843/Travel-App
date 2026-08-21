import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { loadConfig } from '../config/configuration';
import {
  createQueueRedisConnection,
  createWorkerRedisConnection,
} from '../redis/redis-connection.factory';
import { closeRedisGracefully } from '../redis/redis-lifecycle.service';
import { QueueRegistry } from './queue-registry.service';
import { closeWorkerGracefully, createWorker } from './worker.factory';

describe('queue infrastructure (integration)', () => {
  const config = loadConfig(process.env);
  let connection: ReturnType<typeof createQueueRedisConnection>;
  let registry: QueueRegistry;
  const usedQueueNames = new Set<string>();

  function testQueueName(label: string): string {
    const name = `agentb.test.queue.${label}.${randomUUID()}`;
    usedQueueNames.add(name);
    return name;
  }

  beforeAll(() => {
    connection = createQueueRedisConnection(config);
    registry = new QueueRegistry(connection, config);
  });

  afterAll(async () => {
    // Leave no residue on the shared queue Redis instance: obliterate every
    // queue THIS file created (never a blanket FLUSHALL/FLUSHDB — that
    // instance is shared with other agents).
    for (const name of usedQueueNames) {
      try {
        await registry.getQueue(name).obliterate({ force: true });
      } catch {
        // best-effort cleanup
      }
    }
    await registry.onModuleDestroy();
    await connection.quit();
  });

  it('memoizes the Queue instance per name', () => {
    const name = testQueueName('memo');
    const a = registry.getQueue(name);
    const b = registry.getQueue(name);
    expect(a).toBe(b);
  });

  it('addJob requires an explicit jobId and a duplicate call collapses onto the existing job', async () => {
    const queueName = testQueueName('dedupe');
    const jobId = `agentb.test.dedupe.${randomUUID()}`;

    const job1 = await registry.addJob(queueName, 'noop', { n: 1 }, jobId);
    const job2 = await registry.addJob(queueName, 'noop', { n: 2 }, jobId);

    expect(job1.id).toBe(jobId);
    expect(job2.id).toBe(jobId);

    // BullMQ's returned Job object for a collapsed add() is constructed
    // client-side from the CALLER's input and is not re-fetched from Redis
    // (verified against the addStandardJob Lua script: an existing jobId
    // short-circuits to handleDuplicatedJob without calling storeJob), so
    // `job2.data` alone does not prove anything. Re-fetch the actually
    // persisted job to prove the SECOND payload never overwrote the first.
    const queue = registry.getQueue(queueName);
    const stored = await queue.getJob(jobId);
    expect(stored?.data).toEqual({ n: 1 });

    const counts = await queue.getJobCounts('waiting', 'active', 'completed');
    const total = (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.completed ?? 0);
    expect(total).toBe(1); // exactly one job exists, not two
  });

  it('runs a job through a real worker end to end and closes the worker gracefully', async () => {
    const queueName = testQueueName('worker');
    const jobId = `agentb.test.worker.${randomUUID()}`;
    let processedPayload: { n: number } | null = null;

    const workerConnection = createWorkerRedisConnection(config);
    const worker = createWorker<{ n: number }>(workerConnection, config, {
      name: queueName,
      processor: async (job: Job<{ n: number }>) => {
        processedPayload = job.data;
      },
    });

    try {
      await worker.waitUntilReady();

      const completed = new Promise<void>((resolve, reject) => {
        worker.on('completed', () => resolve());
        worker.on('failed', (_job, err) => reject(err));
      });

      await registry.addJob(queueName, 'noop', { n: 7 }, jobId);
      await completed;

      expect(processedPayload).toEqual({ n: 7 });
    } finally {
      await closeWorkerGracefully(worker, 5_000);
      await closeRedisGracefully(workerConnection, 'test worker', 2_000);
    }
  }, 20_000);

  it('closeWorkerGracefully resolves promptly even under a tight timeout, without throwing', async () => {
    const queueName = testQueueName('shutdown-timeout');
    const workerConnection = createWorkerRedisConnection(config);
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const worker = createWorker<{ n: number }>(workerConnection, config, {
      name: queueName,
      processor: async () => {
        signalStarted();
        await new Promise((resolve) => setTimeout(resolve, 300));
      },
    });
    await worker.waitUntilReady();
    await registry.addJob(queueName, 'noop', { n: 1 }, `agentb.test.shutdown.${randomUUID()}`);
    await started;

    // Deliberately shorter than the job's own processing time — proves the
    // shutdown budget is respected instead of blocking indefinitely on the
    // in-flight job.
    const start = Date.now();
    await closeWorkerGracefully(worker, 50);
    expect(Date.now() - start).toBeLessThan(2_000);
    await closeRedisGracefully(workerConnection, 'timeout test worker', 2_000);
  }, 10_000);
});
