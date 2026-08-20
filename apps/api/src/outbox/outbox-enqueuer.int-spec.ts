import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { createTestDataSource } from './test-support/data-source';
import { OutboxEnqueuer } from './outbox-enqueuer.service';

describe('OutboxEnqueuer (integration)', () => {
  let dataSource: DataSource;
  const enqueuer = new OutboxEnqueuer();
  const topicPrefix = 'agentb.test.enqueuer';

  beforeAll(async () => {
    dataSource = createTestDataSource();
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.query(`DELETE FROM job_outbox WHERE topic LIKE $1`, [`${topicPrefix}%`]);
    await dataSource.destroy();
  });

  it('throws immediately when called with a manager that is not inside a transaction', async () => {
    // dataSource.manager is the plain root manager — never transactional.
    await expect(
      enqueuer.enqueue(dataSource.manager, {
        topic: `${topicPrefix}.reject`,
        payload: { x: 1 },
        dedupeKey: `${topicPrefix}.reject.${randomUUID()}`,
      }),
    ).rejects.toThrow(/active transaction/i);

    // And, just as importantly, nothing was written.
    const rows = await dataSource.query(`SELECT 1 FROM job_outbox WHERE topic = $1`, [
      `${topicPrefix}.reject`,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('writes the row atomically with the caller-supplied transaction', async () => {
    const dedupeKey = `${topicPrefix}.commit.${randomUUID()}`;

    await dataSource.transaction(async (manager) => {
      const result = await enqueuer.enqueue(manager, {
        topic: `${topicPrefix}.commit`,
        payload: { hello: 'world' },
        dedupeKey,
      });
      expect(result.inserted).toBe(true);
    });

    const rows = (await dataSource.query(
      `SELECT topic, payload, dedupe_key, completed_at, published_at FROM job_outbox WHERE dedupe_key = $1`,
      [dedupeKey],
    )) as Array<{ topic: string; payload: unknown; dedupe_key: string; completed_at: Date | null }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.topic).toBe(`${topicPrefix}.commit`);
    expect(rows[0]?.payload).toEqual({ hello: 'world' });
    expect(rows[0]?.completed_at).toBeNull();
  });

  it('rolls back the outbox row together with the rest of the transaction', async () => {
    const dedupeKey = `${topicPrefix}.rollback.${randomUUID()}`;

    await expect(
      dataSource.transaction(async (manager) => {
        await enqueuer.enqueue(manager, {
          topic: `${topicPrefix}.rollback`,
          payload: {},
          dedupeKey,
        });
        throw new Error('simulated business-logic failure after the outbox write');
      }),
    ).rejects.toThrow('simulated business-logic failure');

    const rows = await dataSource.query(`SELECT 1 FROM job_outbox WHERE dedupe_key = $1`, [dedupeKey]);
    expect(rows).toHaveLength(0);
  });

  it('a repeated enqueue with the same dedupeKey is a no-op, not an error', async () => {
    const dedupeKey = `${topicPrefix}.idempotent-enqueue.${randomUUID()}`;

    const first = await dataSource.transaction((manager) =>
      enqueuer.enqueue(manager, { topic: `${topicPrefix}.idempotent`, payload: { attempt: 1 }, dedupeKey }),
    );
    const second = await dataSource.transaction((manager) =>
      enqueuer.enqueue(manager, { topic: `${topicPrefix}.idempotent`, payload: { attempt: 2 }, dedupeKey }),
    );

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);

    const rows = (await dataSource.query(`SELECT payload FROM job_outbox WHERE dedupe_key = $1`, [
      dedupeKey,
    ])) as Array<{ payload: { attempt: number } }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload.attempt).toBe(1); // first write wins, second is discarded
  });
});
