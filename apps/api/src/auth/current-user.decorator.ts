import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type {
  AuthenticatedHttpRequest,
  AuthenticatedUser,
  VerifiedFirebaseIdentity,
} from './auth.types';

/** Reads the internal, guard-derived user identity. Never reads request input. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser | undefined =>
    context.switchToHttp().getRequest<AuthenticatedHttpRequest>().user,
);

/**
 * Reads the verified external identity on intentional Firebase-only endpoints
 * such as account provisioning. It does not imply that a TripWith user exists.
 */
export const CurrentFirebaseIdentity = createParamDecorator(
  (_data: unknown, context: ExecutionContext): VerifiedFirebaseIdentity | undefined =>
    context.switchToHttp().getRequest<AuthenticatedHttpRequest>().firebaseIdentity,
);
