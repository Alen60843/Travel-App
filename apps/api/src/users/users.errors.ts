import { AppError, ConflictError } from '../common/errors/app-error';

export class VerifiedEmailRequiredError extends AppError {
  constructor() {
    super(
      'VERIFIED_EMAIL_REQUIRED',
      'A verified email address is required to create an active account.',
      403,
    );
  }
}

export class InvalidProvisioningConsentError extends AppError {
  constructor() {
    super(
      'REQUIRED_CONSENT_INVALID',
      'Current Terms of Service and Privacy Policy grants are required.',
      422,
    );
  }
}

export class InvalidProfileError extends AppError {
  constructor(field: string, message: string) {
    super('INVALID_PROFILE_VALUE', message, 422, { field });
  }
}

export class InvalidInterestError extends AppError {
  constructor() {
    super('INVALID_INTEREST', 'Every selected interest must exist and be active.', 422);
  }
}

export class AccountNotProvisionedError extends AppError {
  constructor() {
    super('ACCOUNT_NOT_PROVISIONED', 'TripWith account is not provisioned.', 404);
  }
}

export class AccountIdentityConflictError extends ConflictError {
  constructor() {
    super(
      'ACCOUNT_IDENTITY_CONFLICT',
      'This verified identity cannot be linked to a new TripWith account.',
    );
  }
}
