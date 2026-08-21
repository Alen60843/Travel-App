import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';

import { FIREBASE_TOKEN_VERIFIER } from './auth.constants';
import { extractBearerToken } from './bearer-token';
import type { AuthenticatedHttpRequest, FirebaseTokenVerifier } from './auth.types';

@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  constructor(
    @Inject(FIREBASE_TOKEN_VERIFIER) protected readonly verifier: FirebaseTokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<true> {
    const request = context.switchToHttp().getRequest<AuthenticatedHttpRequest>();
    const token = extractBearerToken(request.headers.authorization);
    request.firebaseIdentity = await this.verifier.verifyIdToken(token, false);
    return true;
  }
}

/**
 * Explicit opt-in for sensitive operations such as account provisioning.
 * Unlike the normal guard, Firebase Admin also checks the account's current
 * revocation state (`verifyIdToken(token, true)`), which may require a remote
 * Firebase account lookup and therefore must not be the per-request default.
 */
@Injectable()
export class RevocationCheckedFirebaseAuthGuard implements CanActivate {
  constructor(@Inject(FIREBASE_TOKEN_VERIFIER) private readonly verifier: FirebaseTokenVerifier) {}

  async canActivate(context: ExecutionContext): Promise<true> {
    const request = context.switchToHttp().getRequest<AuthenticatedHttpRequest>();
    const token = extractBearerToken(request.headers.authorization);
    request.firebaseIdentity = await this.verifier.verifyIdToken(token, true);
    return true;
  }
}

