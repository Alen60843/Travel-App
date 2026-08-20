import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { loadConfig, type AppConfig } from '../config/configuration';
import { createQueueRedisConnection } from '../redis/redis-connection.factory';
import { QueueRegistry } from '../queue/queue-registry.service';
import { createTestDataSource } from './test-support/data-source';
import { OutboxMetrics } from './outbox-metrics';
import { OutboxRelay } from './outbox-relay.service';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface InsertOpts {
  topic: string;
  dedupeKey: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
}

describe('OutboxRelay claim/re-drive/dead-letter semantics (integration)', () => {
  const baseConfig = loadConfig(process.env);
  let dataSource: DataSource;
  let connection: ReturnType<typeof createQueueRedisConnection>;
  let registry: QueueRegistry;
  const topicPrefix = 'agentb.test.relay';
  // Every topic ever used, for the final Redis cleanup pass.
  const usedTopics = new Set<string>();
  // Topics used by the CURRENTLY RUNNING test only. relay.tick() claims
  // across the whole job_outbox table with no topic filter (that's correct
  // production behaviour — one relay drains every topic) — which means a row
  // left behind by an earlier test is fair game for a later test's tick()
  // call. Clearing each test's own rows in afterEach is what keeps these
  // tests independent despite `tick()` deliberately not being scoped.
  let currentTestTopics = new Set<string>();

  function withLease(leaseMs: number, batchSize = 100): AppConfig {
    return { ...baseConfig, outbox: { ...baseConfig.outbox, leaseMs, batchSize } };
  }

  function makeRelay(config: AppConfig, metrics = new OutboxMetrics()): OutboxRelay {
    return new OutboxRelay(dataSource, registry, metrics, config);
  }

  function uniqueTopic(label: string): string {
    const topic = `${topicPrefix}.${label}.${randomUUID()}`;
    usedTopics.add(topic);
    currentTestTopics.add(topic);
    return topic;
  }

  async function insertRow(opts: InsertOpts): Promise<void> {
    await dataSource.query(
      `INSERT INTO job_outbox (topic, payload, dedupe_key, max_attempts)
       VALUES ($1, $2::jsonb, $3, COALESCE($4, 10))`,
      [opts.topic, JSON.stringify(opts.payload ?? {}), opts.dedupeKey, opts.maxAttempts ?? null],
    );
  }

  async function getRow(dedupeKey: string) {
    const rows = (await dataSource.query(
      `SELECT attempts, publish_attempts, published_at, completed_at, failed_at, max_attempts
       FROM job_outbox WHERE dedupe_key = $1`,
      [dedupeKey],
    )) as Array<{
      attempts: number;
      publish_attempts: number;
      published_at: Date | null;
      completed_at: Date | null;
      failed_at: Date | null;
      max_attempts: number;
    }>;
    return rows[0] ?? null;
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
        // best-effort cleanup — do not fail the suite over cleanup
      }
    }
    await dataSource.query(`DELETE FROM job_outbox WHERE topic LIKE $1`, [`${topicPrefix}%`]);
    await registry.onModuleDestroy();
    await connection.quit();
    await dataSource.destroy();
  });

  it('claims an undelivered row and hands it to BullMQ using dedupe_key as the jobId', async () => {
    const topic = uniqueTopic('claim');
    const dedupeKey = `${topic}.${randomUUID()}`;
    await insertRow({ topic, dedupeKey });

    const relay = makeRelay(withLease(60_000));
    const claimed = await relay.tick();

    expect(claimed).toBe(1);
    const row = await getRow(dedupeKey);
    expect(row?.attempts).toBe(1);
    expect(row?.publish_attempts).toBe(1);
    expect(row?.published_at).not.toBeNull();
    expect(row?.completed_at).toBeNull();

    const job = await registry.getQueue(topic).getJob(dedupeKey);
    expect(job).toBeDefined();
    expect(job?.id).toBe(dedupeKey);
  });

  it('does NOT re-claim a freshly published row while its lease is still valid', async () => {
    const topic = uniqueTopic('within-lease');
    const dedupeKey = `${topic}.${randomUUID()}`;
    await insertRow({ topic, dedupeKey });

    const relay = makeRelay(withLease(60_000)); // 60s lease, nowhere near lapsing
    await relay.tick();
    const secondPassClaimed = await relay.tick();

    expect(secondPassClaimed).toBe(0);
    const row = await getRow(dedupeKey);
    expect(row?.attempts).toBe(1); // untouched by the second pass
  });

  it('re-drives a row once its lease lapses, even after the original BullMQ job is gone', async () => {
    const topic = uniqueTopic('redrive');
    const dedupeKey = `${topic}.${randomUUID()}`;
    await insertRow({ topic, dedupeKey });

    const metrics = new OutboxMetrics();
    const relay = makeRelay(withLease(100), metrics); // 100ms lease

    await relay.tick(); // first publish
    // Simulate total loss of THIS job from Redis (never a blanket FLUSHALL on
    // the shared queue instance — obliterate is scoped to this one test queue).
    await registry.getQueue(topic).obliterate({ force: true });

    await sleep(200); // let the lease lapse
    const secondPassClaimed = await relay.tick();

    expect(secondPassClaimed).toBe(1);
    expect(metrics.snapshot().redrive).toBe(1);

    const row = await getRow(dedupeKey);
    expect(row?.attempts).toBe(2);
    expect(row?.publish_attempts).toBe(2);
    expect(row?.completed_at).toBeNull();
    expect(row?.failed_at).toBeNull();

    const job = await registry.getQueue(topic).getJob(dedupeKey);
    expect(job).toBeDefined(); // a fresh job was created with the same id
  });

  it('dead-letters a row once attempts would exceed max_attempts, without publishing again', async () => {
    const topic = uniqueTopic('dead-letter');
    const dedupeKey = `${topic}.${randomUUID()}`;
    await insertRow({ topic, dedupeKey, maxAttempts: 1 });

    const metrics = new OutboxMetrics();
    const relay = makeRelay(withLease(100), metrics);

    const firstPass = await relay.tick(); // attempts 0 -> 1, 1 is not > max_attempts(1): publishes
    expect(firstPass).toBe(1);
    expect((await getRow(dedupeKey))?.failed_at).toBeNull();

    await sleep(200);
    const secondPass = await relay.tick(); // attempts 1 -> 2, 2 > max_attempts(1): dead-letters instead

    expect(secondPass).toBe(1); // still "claimed" (dead-lettering happens inside claim), just not published
    expect(metrics.snapshot().deadLettered).toBe(1);

    const row = await getRow(dedupeKey);
    expect(row?.failed_at).not.toBeNull();
    expect(row?.completed_at).toBeNull();
    expect(row?.attempts).toBe(2);
    // publish_attempts must NOT have incremented on the dead-lettering pass —
    // the row was never actually handed to BullMQ a second time.
    expect(row?.publish_attempts).toBe(1);
  });

  it('never re-drives an acknowledged row or a dead-lettered row, even after the lease lapses', async () => {
    const ackedTopic = uniqueTopic('no-redrive-acked');
    const ackedKey = `${ackedTopic}.${randomUUID()}`;
    await insertRow({ topic: ackedTopic, dedupeKey: ackedKey });

    const deadTopic = uniqueTopic('no-redrive-dead');
    const deadKey = `${deadTopic}.${randomUUID()}`;
    await insertRow({ topic: deadTopic, dedupeKey: deadKey, maxAttempts: 1 });

    const relay = makeRelay(withLease(100));

    await relay.tick(); // publishes both rows (attempts=1 each)
    await dataSource.query(`UPDATE job_outbox SET completed_at = now() WHERE dedupe_key = $1`, [ackedKey]);

    await sleep(200);
    await relay.tick(); // deadTopic row: attempts 1->2 exceeds max_attempts(1) -> dead-lettered
    expect((await getRow(deadKey))?.failed_at).not.toBeNull();

    await sleep(200);
    const thirdPassClaimed = await relay.tick(); // neither row should be touched now

    expect(thirdPassClaimed).toBe(0);
    expect((await getRow(ackedKey))?.attempts).toBe(1);
    expect((await getRow(deadKey))?.attempts).toBe(2);
  });

  it('concurrent relay ticks never claim the same row twice (FOR UPDATE SKIP LOCKED)', async () => {
    const topic = uniqueTopic('concurrency');
    const rowCount = 20;
    const dedupeKeys = Array.from({ length: rowCount }, () => `${topic}.${randomUUID()}`);
    for (const dedupeKey of dedupeKeys) {
      await insertRow({ topic, dedupeKey });
    }

    const relayA = makeRelay(withLease(60_000, 100));
    const relayB = makeRelay(withLease(60_000, 100));

    const [claimedA, claimedB] = await Promise.all([relayA.tick(), relayB.tick()]);

    expect(claimedA + claimedB).toBe(rowCount);

    const rows = (await dataSource.query(
      `SELECT dedupe_key, attempts FROM job_outbox WHERE topic = $1`,
      [topic],
    )) as Array<{ dedupe_key: string; attempts: number }>;

    expect(rows).toHaveLength(rowCount);
    // Every row claimed by EXACTLY one of the two concurrent ticks — never
    // zero (dropped) and never two (double-claimed, which SKIP LOCKED exists
    // to prevent).
    for (const row of rows) {
      expect(row.attempts).toBe(1);
    }

    const queue = registry.getQueue(topic);
    const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'delayed');
    const totalJobs = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
    expect(totalJobs).toBe(rowCount); // no duplicate BullMQ jobs either
  });
});
