/**
 * Canonical trip-date semantics.
 *
 * THE RULE: trip dates are INCLUSIVE of both endpoints.
 *   start_date = end_date = 2026-08-20  is a ONE-DAY stay.
 *
 * PostgreSQL stores `daterange(start, end, '[]')`, which normalises to the
 * half-open `[start, end+1)`. Every function here is the exact TypeScript
 * mirror of the corresponding PostgreSQL expression:
 *
 *   stayLengthDays(r)   ==  upper(r) - lower(r)
 *   overlapDays(a, b)   ==  upper(a * b) - lower(a * b)   (0 when empty)
 *   overlaps(a, b)      ==  a && b
 *
 * NOTE — deviation from the formula in the product spec (§7), deliberate:
 * the spec gives `overlap = max(0, min(Aend,Bend) - max(Astart,Bstart))`,
 * which is half-open arithmetic. Applied to inclusive dates it is off by one
 * and reports a same-day stay as zero overlap. The `+ 1` below is required for
 * the two representations to agree. Cross-validated against a live PostgreSQL
 * instance in dates.test.ts.
 */

/** An inclusive calendar-date range. Both bounds are `YYYY-MM-DD`. */
export interface DateRange {
  readonly start: string;
  readonly end: string;
}

const MS_PER_DAY = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days since epoch, timezone-independent. */
function toDayNumber(isoDate: string): number {
  if (!ISO_DATE.test(isoDate)) {
    throw new RangeError(`expected a YYYY-MM-DD date, received "${isoDate}"`);
  }
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const ms = Date.UTC(y, m - 1, d);
  if (Number.isNaN(ms)) {
    throw new RangeError(`invalid calendar date "${isoDate}"`);
  }
  return ms / MS_PER_DAY;
}

function assertOrdered(r: DateRange): void {
  if (toDayNumber(r.end) < toDayNumber(r.start)) {
    throw new RangeError(`range end ${r.end} precedes start ${r.start}`);
  }
}

/**
 * Inclusive stay length in days. A same-day stay is 1, never 0.
 * Mirrors `upper(date_range) - lower(date_range)`.
 */
export function stayLengthDays(range: DateRange): number {
  assertOrdered(range);
  return toDayNumber(range.end) - toDayNumber(range.start) + 1;
}

/**
 * Overlap in whole days, 0 when disjoint.
 * Mirrors `upper(a * b) - lower(a * b)`, with the empty intersection as 0.
 *
 * Endpoint-touching ranges overlap by exactly 1 day, because the shared day
 * is a day both travellers are present.
 */
export function overlapDays(a: DateRange, b: DateRange): number {
  assertOrdered(a);
  assertOrdered(b);
  const start = Math.max(toDayNumber(a.start), toDayNumber(b.start));
  const end = Math.min(toDayNumber(a.end), toDayNumber(b.end));
  return Math.max(0, end - start + 1);
}

/** Mirrors the PostgreSQL `&&` range-overlap operator. */
export function overlaps(a: DateRange, b: DateRange): boolean {
  return overlapDays(a, b) > 0;
}

/**
 * Overlap normalised against the SHORTER of the two stays, in [0, 1].
 *
 * The shorter stay is the denominator so that a traveller passing through for
 * two days during someone's two-month trip scores a full 1.0 for those two
 * days, rather than being penalised for the other person's longer itinerary.
 * This is the `tau` term of the itinerary score.
 */
export function normalizedOverlap(a: DateRange, b: DateRange): number {
  const shared = overlapDays(a, b);
  if (shared === 0) return 0;
  return shared / Math.min(stayLengthDays(a), stayLengthDays(b));
}
