import type { EventVisibility } from '@tripwith/shared';

import { InvalidEventValueError } from './events.errors';

const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const CURRENCY = /^[A-Z]{3}$/;
const TRUST_SCORE = /^\d+(?:\.\d{1,2})?$/;
const VISIBILITIES = new Set<string>(['PUBLIC', 'UNLISTED', 'PRIVATE']);
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function parseEventTimestamp(value: string, field: string): Date {
  const match = TIMESTAMP.exec(value);
  if (!match) throw invalidTimestamp(field);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[8] ?? 0);
  const offsetMinute = Number(match[9] ?? 0);
  const baseLimit = DAYS_IN_MONTH[month - 1];
  const dayLimit = month === 2 && isLeapYear(year) ? 29 : baseLimit;

  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    dayLimit === undefined ||
    day < 1 ||
    day > dayLimit ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw invalidTimestamp(field);
  }

  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw invalidTimestamp(field);
  return result;
}

export function assertOrderedEventTimes(startsAt: Date, endsAt: Date): void {
  if (
    Number.isNaN(startsAt.getTime()) ||
    Number.isNaN(endsAt.getTime()) ||
    endsAt.getTime() <= startsAt.getTime()
  ) {
    throw new InvalidEventValueError('endsAt', 'endsAt must be later than startsAt.');
  }
}

export function normaliseEventTitle(value: string): string {
  const normalized = value.trim();
  const length = [...normalized].length;
  if (normalized.includes('\0') || length < 3 || length > 140) {
    throw new InvalidEventValueError(
      'title',
      'title must contain between 3 and 140 characters after trimming.',
    );
  }
  return normalized;
}

export function normaliseOptionalEventText(
  value: string | null,
  field: string,
): string | null {
  if (value === null) return null;
  if (value.includes('\0')) {
    throw new InvalidEventValueError(field, `${field} cannot contain a NUL character.`);
  }
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

export function assertEventInteger(
  value: number,
  field: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new InvalidEventValueError(
      field,
      `${field} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
}

export function assertEventMoney(priceMinor: number, depositMinor: number): void {
  assertEventInteger(priceMinor, 'priceMinor', 0, 2_147_483_647);
  assertEventInteger(depositMinor, 'depositMinor', 0, 2_147_483_647);
  if (depositMinor > priceMinor) {
    throw new InvalidEventValueError('depositMinor', 'depositMinor cannot exceed priceMinor.');
  }
}

export function normaliseEventCurrency(value: string): string {
  const normalized = value.trim();
  if (!CURRENCY.test(normalized)) {
    throw new InvalidEventValueError('currency', 'currency must be an uppercase ISO-style code.');
  }
  return normalized;
}

export function assertEventTrustScore(value: number): void {
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    value > 10 ||
    !TRUST_SCORE.test(value.toString())
  ) {
    throw new InvalidEventValueError(
      'minTrustScore',
      'minTrustScore must be between 0 and 10 with at most two decimal places.',
    );
  }
}

export function assertEventVisibility(value: string): asserts value is EventVisibility {
  if (!VISIBILITIES.has(value)) {
    throw new InvalidEventValueError('visibility', 'visibility is not supported.');
  }
}

function invalidTimestamp(field: string): InvalidEventValueError {
  return new InvalidEventValueError(
    field,
    `${field} must be a valid RFC 3339 timestamp with an explicit UTC offset.`,
  );
}
