import type { DateRange } from '@tripwith/shared';

import {
  InvalidTripDateError,
  InvalidTripDateRangeError,
  InvalidTripMetadataError,
  InvalidTripValueError,
  SegmentOutsideTripError,
} from './trips.errors';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** Validates the exact PostgreSQL-facing calendar representation, without timezone parsing. */
export function assertIsoCalendarDate(value: string, field: string): void {
  const match = ISO_DATE.exec(value);
  if (!match) throw new InvalidTripDateError(field);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) throw new InvalidTripDateError(field);
  const baseLimit = DAYS_IN_MONTH[month - 1];
  const limit = month === 2 && isLeapYear(year) ? 29 : baseLimit;
  if (limit === undefined || day < 1 || day > limit) throw new InvalidTripDateError(field);
}

export function assertOrderedRange(range: DateRange): void {
  assertIsoCalendarDate(range.start, 'startDate');
  assertIsoCalendarDate(range.end, 'endDate');
  // Exact ISO dates have chronological lexicographic ordering.
  if (range.end < range.start) throw new InvalidTripDateRangeError();
}

export function assertSegmentContained(segment: DateRange, trip: DateRange): void {
  assertOrderedRange(segment);
  assertOrderedRange(trip);
  if (segment.start < trip.start || segment.end > trip.end) {
    throw new SegmentOutsideTripError();
  }
}

export function normaliseBoundedText(
  value: string,
  field: string,
  minLength: number,
  maxLength: number,
): string {
  const normalised = value.trim();
  if (
    normalised.includes('\0') ||
    [...normalised].length < minLength ||
    [...normalised].length > maxLength
  ) {
    throw new InvalidTripValueError(
      field,
      `${field} must contain between ${minLength} and ${maxLength} characters.`,
    );
  }
  return normalised;
}

function isJsonValue(value: unknown, depth: number): boolean {
  if (depth > 20) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return !value.includes('\0');
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([key, item]) => !key.includes('\0') && isJsonValue(item, depth + 1),
  );
}

export function normaliseMetadata(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || !isJsonValue(value, 0)) {
    throw new InvalidTripMetadataError();
  }
  // Round-trip to detach request-owned mutable objects and preserve only JSON semantics.
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    throw new InvalidTripMetadataError();
  }
}
