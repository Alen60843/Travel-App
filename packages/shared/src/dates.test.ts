import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  normalizedOverlap,
  overlapDays,
  overlaps,
  stayLengthDays,
  type DateRange,
} from './dates.ts';

const r = (start: string, end: string): DateRange => ({ start, end });

describe('canonical date semantics', () => {
  it('treats start = end as a ONE-day stay', () => {
    assert.equal(stayLengthDays(r('2026-08-20', '2026-08-20')), 1);
  });

  it('counts inclusive stay length', () => {
    assert.equal(stayLengthDays(r('2026-09-01', '2026-09-07')), 7);
    assert.equal(stayLengthDays(r('2026-09-01', '2026-09-02')), 2);
  });

  it('overlaps two identical same-day stays by exactly 1 day', () => {
    const day = r('2026-08-20', '2026-08-20');
    assert.equal(overlapDays(day, day), 1);
    assert.equal(overlaps(day, day), true);
  });

  it('overlaps endpoint-touching trips by exactly 1 day', () => {
    assert.equal(
      overlapDays(r('2026-09-01', '2026-09-07'), r('2026-09-07', '2026-09-12')),
      1,
    );
  });

  it('reports no overlap for strictly adjacent trips', () => {
    assert.equal(
      overlapDays(r('2026-09-01', '2026-09-07'), r('2026-09-08', '2026-09-12')),
      0,
    );
    assert.equal(
      overlaps(r('2026-09-01', '2026-09-07'), r('2026-09-08', '2026-09-12')),
      false,
    );
  });

  it('reports no overlap for fully disjoint trips', () => {
    assert.equal(
      overlapDays(r('2026-01-01', '2026-01-31'), r('2026-06-01', '2026-06-30')),
      0,
    );
  });

  it('is symmetric', () => {
    const a = r('2026-09-01', '2026-09-10');
    const b = r('2026-09-05', '2026-09-20');
    assert.equal(overlapDays(a, b), overlapDays(b, a));
  });

  it('handles a month boundary and a leap day', () => {
    assert.equal(stayLengthDays(r('2026-01-31', '2026-02-01')), 2);
    // 2028 is a leap year: Feb has 29 days.
    assert.equal(stayLengthDays(r('2028-02-01', '2028-02-29')), 29);
  });

  it('normalises against the shorter stay, never exceeding 1', () => {
    const long = r('2026-09-01', '2026-10-31');
    const short = r('2026-09-10', '2026-09-11');
    assert.equal(normalizedOverlap(long, short), 1);
    assert.ok(normalizedOverlap(long, short) <= 1);
  });

  it('normalises a partial overlap into (0, 1)', () => {
    const value = normalizedOverlap(
      r('2026-09-01', '2026-09-10'),
      r('2026-09-09', '2026-09-20'),
    );
    assert.equal(value, 2 / 10);
    assert.ok(value > 0 && value < 1);
  });

  it('rejects malformed and inverted ranges', () => {
    assert.throws(() => stayLengthDays(r('20-08-2026', '2026-08-21')), RangeError);
    assert.throws(() => stayLengthDays(r('2026-08-21', '2026-08-20')), RangeError);
  });
});

/**
 * Cross-validation against a real PostgreSQL instance.
 *
 * Unit tests alone only prove TypeScript is self-consistent. The actual
 * requirement is that TypeScript and PostgreSQL agree, so this asks the
 * database for the same answers and compares. Skipped when no database is
 * configured, so the suite still runs in a bare environment.
 *
 *   TRIPWITH_TEST_DATABASE_URL=postgresql://... node --test
 */
const DB_URL = process.env.TRIPWITH_TEST_DATABASE_URL;

describe('PostgreSQL parity', { skip: DB_URL ? false : 'no TRIPWITH_TEST_DATABASE_URL' }, () => {
  const cases: ReadonlyArray<readonly [DateRange, DateRange, string]> = [
    [r('2026-08-20', '2026-08-20'), r('2026-08-20', '2026-08-20'), 'same single day'],
    [r('2026-09-01', '2026-09-07'), r('2026-09-07', '2026-09-12'), 'touching endpoints'],
    [r('2026-09-01', '2026-09-07'), r('2026-09-08', '2026-09-12'), 'strictly adjacent'],
    [r('2026-09-01', '2026-09-10'), r('2026-09-05', '2026-09-20'), 'partial overlap'],
    [r('2026-09-01', '2026-10-31'), r('2026-09-10', '2026-09-11'), 'fully contained'],
    [r('2026-01-01', '2026-01-31'), r('2026-06-01', '2026-06-30'), 'disjoint'],
    [r('2028-02-01', '2028-02-29'), r('2028-02-28', '2028-03-05'), 'leap day'],
  ];

  function askPostgres(sql: string): string {
    return execFileSync('psql', [DB_URL as string, '-At', '-c', sql], {
      encoding: 'utf8',
    }).trim();
  }

  for (const [a, b, label] of cases) {
    it(`agrees with PostgreSQL on ${label}`, () => {
      const rangeA = `daterange(DATE '${a.start}', DATE '${a.end}', '[]')`;
      const rangeB = `daterange(DATE '${b.start}', DATE '${b.end}', '[]')`;

      const sqlOverlap = Number(
        askPostgres(
          `SELECT CASE WHEN isempty(${rangeA} * ${rangeB}) THEN 0 ` +
            `ELSE upper(${rangeA} * ${rangeB}) - lower(${rangeA} * ${rangeB}) END`,
        ),
      );
      assert.equal(overlapDays(a, b), sqlOverlap, 'overlapDays must equal the SQL intersection');

      const sqlOverlaps = askPostgres(`SELECT ${rangeA} && ${rangeB}`) === 't';
      assert.equal(overlaps(a, b), sqlOverlaps, 'overlaps must equal the && operator');

      const sqlLenA = Number(askPostgres(`SELECT upper(${rangeA}) - lower(${rangeA})`));
      assert.equal(stayLengthDays(a), sqlLenA, 'stayLengthDays must equal upper - lower');
    });
  }
});
