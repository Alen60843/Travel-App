import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

interface DriftRow {
  readonly user_id: string;
  readonly actual_ids: number[];
  readonly expected_ids: number[];
}

const EXPECTED_PROJECTION_SQL = `
  SELECT p.user_id,
         p.interest_ids AS actual_ids,
         COALESCE(
           array_agg(i.id ORDER BY i.id) FILTER (WHERE i.id IS NOT NULL),
           '{}'::int[]
         ) AS expected_ids
    FROM user_profiles p
    LEFT JOIN user_interests ui ON ui.user_id = p.user_id
    LEFT JOIN interests i ON i.id = ui.interest_id AND i.is_active = TRUE
   GROUP BY p.user_id, p.interest_ids
`;

/** Operator-facing diagnostic/repair seam; normal writes still use triggers. */
@Injectable()
export class InterestProjectionService {
  constructor(private readonly dataSource: DataSource) {}

  async findDrift(limit = 100): Promise<readonly DriftRow[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError('limit must be an integer from 1 to 1000');
    }
    return this.dataSource.query(
      `SELECT user_id, actual_ids, expected_ids
         FROM (${EXPECTED_PROJECTION_SQL}) projection
        WHERE actual_ids IS DISTINCT FROM expected_ids
        ORDER BY user_id
        LIMIT $1`,
      [limit],
    ) as Promise<DriftRow[]>;
  }

  async repair(): Promise<number> {
    const rows = await this.dataSource.query(
      `WITH expected AS (${EXPECTED_PROJECTION_SQL}), repaired AS (
         UPDATE user_profiles p
            SET interest_ids = e.expected_ids
           FROM expected e
          WHERE p.user_id = e.user_id
            AND p.interest_ids IS DISTINCT FROM e.expected_ids
         RETURNING p.user_id
       )
       SELECT count(*)::int AS repaired_count FROM repaired`,
    ) as { repaired_count: number }[];
    return Number(rows[0]?.repaired_count ?? 0);
  }
}
