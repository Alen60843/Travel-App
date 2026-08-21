import { randomUUID } from 'node:crypto';

import { UserAccountStatus } from '@tripwith/shared';

import { AppDataSource } from '../database/data-source';
import {
  assertEligibleDateOfBirth,
  InvalidDateOfBirthError,
  MinimumAgeError,
} from './age';

interface EligibilityCase {
  readonly label: string;
  readonly dateOfBirth: string;
  readonly referenceInstant: string;
}

const CASES: readonly EligibilityCase[] = [
  {
    label: 'exactly 18',
    dateOfBirth: '2008-08-21',
    referenceInstant: '2026-08-21T12:00:00.000Z',
  },
  {
    label: 'one day below 18',
    dateOfBirth: '2008-08-22',
    referenceInstant: '2026-08-21T12:00:00.000Z',
  },
  {
    label: 'one day above 18',
    dateOfBirth: '2008-08-20',
    referenceInstant: '2026-08-21T12:00:00.000Z',
  },
  {
    label: 'before UTC New Year boundary',
    dateOfBirth: '2008-01-01',
    referenceInstant: '2025-12-31T23:59:59.999Z',
  },
  {
    label: 'at UTC New Year boundary',
    dateOfBirth: '2008-01-01',
    referenceInstant: '2026-01-01T00:00:00.000Z',
  },
  {
    label: '29 February before non-leap birthday rule',
    dateOfBirth: '2004-02-29',
    referenceInstant: '2022-02-28T23:59:59.999Z',
  },
  {
    label: '29 February on 1 March in a non-leap year',
    dateOfBirth: '2004-02-29',
    referenceInstant: '2022-03-01T00:00:00.000Z',
  },
];

function typescriptAccepts(dateOfBirth: string, referenceInstant: string): boolean {
  try {
    assertEligibleDateOfBirth(dateOfBirth, new Date(referenceInstant));
    return true;
  } catch (error) {
    if (error instanceof MinimumAgeError || error instanceof InvalidDateOfBirthError) {
      return false;
    }
    throw error;
  }
}

describe('minimum-age UTC parity (real PostgreSQL)', () => {
  beforeAll(async () => {
    await AppDataSource.initialize();
  });

  afterAll(async () => {
    await AppDataSource.destroy();
  });

  it('forces migration/application database sessions to UTC', async () => {
    const rows: { timezone: string }[] = await AppDataSource.query(
      `SELECT current_setting('timezone') AS timezone`,
    );
    expect(rows[0]?.timezone).toBe('UTC');
  });

  it.each(CASES)('$label agrees between TypeScript and PostgreSQL', async (testCase) => {
    const referenceDate = testCase.referenceInstant.slice(0, 10);
    const rows: { eligible: boolean }[] = await AppDataSource.query(
      `SELECT $1::date <= ($2::date - interval '18 years')::date AS eligible`,
      [testCase.dateOfBirth, referenceDate],
    );
    expect(typescriptAccepts(testCase.dateOfBirth, testCase.referenceInstant)).toBe(
      rows[0]?.eligible,
    );
  });

  it('enforces below/exactly/above-18 against the live trigger', async () => {
    const rows: { exact: string; below: string; above: string }[] =
      await AppDataSource.query(
        `SELECT (current_date - interval '18 years')::date::text AS exact,
                (current_date - interval '18 years' + interval '1 day')::date::text AS below,
                (current_date - interval '18 years' - interval '1 day')::date::text AS above`,
      );
    const boundary = rows[0];
    if (!boundary) throw new Error('Age boundary query returned no row');
    const prefix = `age-parity-${randomUUID()}`;

    await expect(
      AppDataSource.query(
        `INSERT INTO users (firebase_uid, email, account_status, date_of_birth)
         VALUES ($1, $2, $3, $4)`,
        [`${prefix}-exact`, `${prefix}-exact@example.com`, UserAccountStatus.Active, boundary.exact],
      ),
    ).resolves.toBeDefined();
    await expect(
      AppDataSource.query(
        `INSERT INTO users (firebase_uid, email, account_status, date_of_birth)
         VALUES ($1, $2, $3, $4)`,
        [`${prefix}-above`, `${prefix}-above@example.com`, UserAccountStatus.Active, boundary.above],
      ),
    ).resolves.toBeDefined();
    await expect(
      AppDataSource.query(
        `INSERT INTO users (firebase_uid, email, account_status, date_of_birth)
         VALUES ($1, $2, $3, $4)`,
        [`${prefix}-below`, `${prefix}-below@example.com`, UserAccountStatus.Active, boundary.below],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await AppDataSource.query(`DELETE FROM users WHERE firebase_uid LIKE $1`, [`${prefix}%`]);
  });
});
