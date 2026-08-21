import { randomUUID } from 'node:crypto';

import { AppDataSource } from '../database/data-source';
import { InterestProjectionService } from './interest-projection.service';

describe('InterestProjectionService (real PostgreSQL)', () => {
  const runId = randomUUID().replace(/-/g, '');
  const firebaseUid = `projection-${runId}`;
  const interestCode = `projection_${runId.slice(0, 20)}`;
  let userId: string;
  let interestId: number;
  let service: InterestProjectionService;

  beforeAll(async () => {
    await AppDataSource.initialize();
    service = new InterestProjectionService(AppDataSource);
    const [user] = await AppDataSource.query(
      `INSERT INTO users (firebase_uid, email, email_verified_at, account_status, date_of_birth)
       VALUES ($1, $2, now(), 'ACTIVE', DATE '1990-01-01')
       RETURNING id`,
      [firebaseUid, `${runId}@example.com`],
    ) as { id: string }[];
    userId = user!.id;
    await AppDataSource.query(
      `INSERT INTO user_profiles (user_id, display_name) VALUES ($1, 'Projection Test')`,
      [userId],
    );
    const [interest] = await AppDataSource.query(
      `INSERT INTO interests (code, label, grouping) VALUES ($1, 'Projection', 'test') RETURNING id`,
      [interestCode],
    ) as { id: number }[];
    interestId = interest!.id;
    await AppDataSource.query(
      `INSERT INTO user_interests (user_id, interest_id) VALUES ($1, $2)`,
      [userId, interestId],
    );
  });

  afterAll(async () => {
    try {
      await AppDataSource.query(`DELETE FROM users WHERE id = $1`, [userId]);
      await AppDataSource.query(`DELETE FROM interests WHERE id = $1`, [interestId]);
    } finally {
      await AppDataSource.destroy();
    }
  });

  it('detects and idempotently repairs active-interest projection corruption', async () => {
    expect(await service.findDrift()).toEqual([]);

    await AppDataSource.query(
      `UPDATE user_profiles SET interest_ids = ARRAY[2147483647]::int[] WHERE user_id = $1`,
      [userId],
    );
    expect(await service.findDrift()).toEqual([
      { user_id: userId, actual_ids: [2147483647], expected_ids: [interestId] },
    ]);

    await expect(service.repair()).resolves.toBe(1);
    await expect(service.findDrift()).resolves.toEqual([]);
    await expect(service.repair()).resolves.toBe(0);
  });
});
