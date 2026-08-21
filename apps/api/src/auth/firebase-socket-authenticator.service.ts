import { Inject, Injectable } from '@nestjs/common';

import type { SocketAuthenticator, AuthenticatedPrincipal } from '../realtime';
import { FIREBASE_TOKEN_VERIFIER } from './auth.constants';
import type { FirebaseTokenVerifier } from './auth.types';
import { TripWithUserResolver } from './tripwith-user-resolver.service';

@Injectable()
export class FirebaseSocketAuthenticator implements SocketAuthenticator {
  constructor(
    @Inject(FIREBASE_TOKEN_VERIFIER) private readonly verifier: FirebaseTokenVerifier,
    private readonly userResolver: TripWithUserResolver,
  ) {}

  async authenticate(handshakeToken: string | undefined): Promise<AuthenticatedPrincipal | null> {
    if (!handshakeToken) {
      return null;
    }

    try {
      // Socket reconnects are steady-state authentication and use cached
      // signing-key verification, just like normal HTTP requests.
      const identity = await this.verifier.verifyIdToken(handshakeToken, false);
      const user = await this.userResolver.resolve(identity);
      return { userId: user.id };
    } catch {
      // The gateway treats null as a rejected handshake. Deliberately log
      // neither the token nor upstream Firebase errors here.
      return null;
    }
  }
}

