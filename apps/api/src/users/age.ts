import { MINIMUM_ACCOUNT_AGE_YEARS } from '@tripwith/shared';

import { AppError } from '../common/errors/app-error';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class InvalidDateOfBirthError extends AppError {
  constructor() {
    super(
      'INVALID_DATE_OF_BIRTH',
      'Date of birth must be a valid past calendar date in YYYY-MM-DD format.',
      422,
    );
  }
}

export class MinimumAgeError extends AppError {
  constructor() {
    super(
      'MINIMUM_AGE_REQUIRED',
      `You must be at least ${MINIMUM_ACCOUNT_AGE_YEARS} years old.`,
      422,
    );
  }
}

/**
 * Parses a PostgreSQL-compatible DATE without allowing the JavaScript Date
 * constructor to normalise impossible input (for example, 2026-02-31).
 * Calendar comparison is performed entirely in UTC so API nodes in different
 * timezones make the same decision at the same instant.
 */
export function assertEligibleDateOfBirth(dateOfBirth: string, now = new Date()): void {
  if (!DATE_ONLY_PATTERN.test(dateOfBirth)) {
    throw new InvalidDateOfBirthError();
  }

  const [yearText, monthText, dayText] = dateOfBirth.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new InvalidDateOfBirthError();
  }

  // Mirrors users_dob_sane_chk exactly (strictly later than 1900-01-01),
  // keeping the API's domain response ahead of the database backstop.
  if (parsed.getTime() <= Date.UTC(1900, 0, 1)) {
    throw new InvalidDateOfBirthError();
  }

  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (parsed.getTime() > todayUtc) {
    throw new InvalidDateOfBirthError();
  }

  // Date.UTC normalises 29 February in a non-leap eighteenth year to 1 March.
  // That is the explicit product rule and matches PostgreSQL's
  // `reference_date - interval '18 years'` threshold.
  const eighteenthBirthday = Date.UTC(
    year + MINIMUM_ACCOUNT_AGE_YEARS,
    month - 1,
    day,
  );
  if (eighteenthBirthday > todayUtc) {
    throw new MinimumAgeError();
  }
}
