import { AppError } from '../common/errors/app-error';

export class MatchingNotEligibleError extends AppError {
  constructor() {
    super(
      'MATCHING_NOT_ELIGIBLE',
      'Your account is not currently eligible for traveler discovery.',
      403,
    );
  }
}

export class MatchingCursorInvalidError extends AppError {
  constructor() {
    super('MATCHING_CURSOR_INVALID', 'The matching cursor is invalid.', 400);
  }
}

export class MatchingCursorStaleError extends AppError {
  constructor() {
    super(
      'MATCHING_CURSOR_STALE',
      'The matching feed changed. Restart pagination from the first page.',
      409,
    );
  }
}
