import { AppError } from '../common/errors/app-error';

export const AuthErrorCode = {
  TokenMissing: 'AUTH_TOKEN_MISSING',
  BearerMalformed: 'AUTH_BEARER_MALFORMED',
  TokenInvalid: 'AUTH_TOKEN_INVALID',
  TokenExpired: 'AUTH_TOKEN_EXPIRED',
  TokenRevoked: 'AUTH_TOKEN_REVOKED',
  TokenWrongAudience: 'AUTH_TOKEN_WRONG_AUDIENCE',
  AccountNotProvisioned: 'AUTH_ACCOUNT_NOT_PROVISIONED',
  AccountInactive: 'AUTH_ACCOUNT_INACTIVE',
  AccountDeactivated: 'AUTH_ACCOUNT_DEACTIVATED',
  AccountDeleted: 'AUTH_ACCOUNT_DELETED',
  AccountSuspended: 'AUTH_ACCOUNT_SUSPENDED',
  AccountFullySuspended: 'AUTH_ACCOUNT_FULLY_SUSPENDED',
} as const;

export type AuthErrorCode = (typeof AuthErrorCode)[keyof typeof AuthErrorCode];

export class AuthenticationError extends AppError {
  constructor(code: AuthErrorCode, message: string) {
    super(code, message, 401);
  }
}

export class AccountAccessError extends AppError {
  constructor(code: AuthErrorCode, message: string) {
    super(code, message, 403);
  }
}

export function tokenMissingError(): AuthenticationError {
  return new AuthenticationError(AuthErrorCode.TokenMissing, 'An authentication token is required.');
}

export function malformedBearerError(): AuthenticationError {
  return new AuthenticationError(
    AuthErrorCode.BearerMalformed,
    'Authorization must contain exactly one Bearer token.',
  );
}

export function invalidTokenError(): AuthenticationError {
  return new AuthenticationError(AuthErrorCode.TokenInvalid, 'The authentication token is invalid.');
}

export function expiredTokenError(): AuthenticationError {
  return new AuthenticationError(AuthErrorCode.TokenExpired, 'The authentication token has expired.');
}

export function revokedTokenError(): AuthenticationError {
  return new AuthenticationError(AuthErrorCode.TokenRevoked, 'The authentication token has been revoked.');
}

export function wrongAudienceTokenError(): AuthenticationError {
  return new AuthenticationError(
    AuthErrorCode.TokenWrongAudience,
    'The authentication token was not issued for this application.',
  );
}

