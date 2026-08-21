import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';

import type { AuthenticatedHttpRequest } from './auth.types';
import { FirebaseAuthGuard } from './firebase-auth.guard';
import { TripWithUserResolver } from './tripwith-user-resolver.service';

/** Verify Firebase identity, resolve the internal UUID, and enforce account usability. */
@Injectable()
export class TripWithAuthGuard implements CanActivate {
  constructor(
    private readonly firebaseAuthGuard: FirebaseAuthGuard,
    private readonly userResolver: TripWithUserResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<true> {
    await this.firebaseAuthGuard.canActivate(context);
    const request = context.switchToHttp().getRequest<AuthenticatedHttpRequest>();
    // FirebaseAuthGuard returning true guarantees this field. Keep a fail-closed
    // assertion in case the guard contract is accidentally changed later.
    if (!request.firebaseIdentity) {
      return Promise.reject(new Error('FirebaseAuthGuard did not attach a verified identity'));
    }
    request.user = await this.userResolver.resolve(request.firebaseIdentity);
    return true;
  }
}

