import { Inject, Injectable } from '@nestjs/common';
import type { DecodedIdToken } from 'firebase-admin/auth';

import { APP_CONFIG, type AppConfig } from '../config/configuration';
import {
  expiredTokenError,
  invalidTokenError,
  revokedTokenError,
  wrongAudienceTokenError,
} from './auth.errors';
import type { FirebaseTokenVerifier, VerifiedFirebaseIdentity } from './auth.types';
import { FirebaseAdminService } from './firebase-admin.service';

interface FirebaseErrorLike {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly errorInfo?: { readonly code?: unknown };
}

@Injectable()
export class FirebaseTokenVerifierService implements FirebaseTokenVerifier {
  constructor(
    private readonly firebaseAdmin: FirebaseAdminService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async verifyIdToken(token: string, checkRevoked: boolean): Promise<VerifiedFirebaseIdentity> {
    let decoded: DecodedIdToken;
    try {
      decoded = await this.firebaseAdmin.verifyIdToken(token, checkRevoked);
    } catch (error) {
      throw this.toSafeAuthenticationError(error);
    }

    // Admin already checks these claims. Rechecking the expected project here
    // makes that critical trust boundary explicit and protects mocked/custom
    // verifier adapters from accidentally weakening it.
    if (decoded.aud !== this.config.firebase.projectId) {
      throw wrongAudienceTokenError();
    }

    const expectedIssuer = `https://securetoken.google.com/${this.config.firebase.projectId}`;
    if (
      decoded.iss !== expectedIssuer ||
      !decoded.uid ||
      decoded.sub !== decoded.uid ||
      !Number.isFinite(decoded.auth_time)
    ) {
      throw invalidTokenError();
    }

    if (!Number.isFinite(decoded.exp) || decoded.exp * 1_000 <= Date.now()) {
      throw expiredTokenError();
    }

    return Object.freeze({
      firebaseUid: decoded.uid,
      email: typeof decoded.email === 'string' ? decoded.email : null,
      emailVerified: decoded.email_verified === true,
      authTime: new Date(decoded.auth_time * 1_000),
    });
  }

  private toSafeAuthenticationError(error: unknown): Error {
    const candidate = error as FirebaseErrorLike | null;
    const rawCode = candidate?.errorInfo?.code ?? candidate?.code;
    const code = typeof rawCode === 'string' ? rawCode : '';
    const message = typeof candidate?.message === 'string' ? candidate.message : '';

    if (code === 'auth/id-token-expired') {
      return expiredTokenError();
    }
    if (code === 'auth/id-token-revoked') {
      return revokedTokenError();
    }

    // Firebase Admin currently reports an audience/project mismatch as the
    // broad `auth/argument-error`; the safe message classification is needed
    // to preserve a stable client code without exposing the upstream text.
    if (/\b(?:aud|audience|project[- ]?id)\b/i.test(message)) {
      return wrongAudienceTokenError();
    }

    return invalidTokenError();
  }
}
