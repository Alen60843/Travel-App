import { AppError, ConflictError, ForbiddenError } from '../common/errors/app-error';

/** The authenticated account cannot currently participate in matching. */
export class MatchingNotEligibleError extends ForbiddenError {
  constructor() {
    super('MATCHING_NOT_ELIGIBLE', 'This account is not currently eligible for matching.');
  }
}

/** Deliberately does not distinguish absent, blocked, or privacy-hidden users. */
export class SwipeTargetInvalidError extends AppError {
  constructor() {
    super('SWIPE_TARGET_INVALID', 'The swipe target is unavailable.', 422);
  }
}

export class SelfSwipeError extends AppError {
  constructor() {
    super('SWIPE_TARGET_INVALID', 'You cannot swipe on your own account.', 422);
  }
}

export class SwipeAlreadyExistsError extends ConflictError {
  constructor() {
    super(
      'SWIPE_ALREADY_EXISTS',
      'The first swipe is final for this matching lifecycle.',
    );
  }
}
